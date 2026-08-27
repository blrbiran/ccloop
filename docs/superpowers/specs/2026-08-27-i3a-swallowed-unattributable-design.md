# I-3(a) ＋ 心跳两处吞 —— 让永不清的转移锁走完它该走的路

**授权**：人裁 109（同一轮开 I-3(a) 与 `leaseHeartbeat` 两处吞）、人裁 111（`readOwnerRecord` 收窄 `catch`、让不可归属抛出）、
人裁 112（心跳 `runAffirm` 只记一次事件、tick 行为不改）、人裁 113（`stop()` 同样记一次、行为不改）、
人裁 114（`runLoop` 走方案 B：外层 catch 一处路由）、人裁 115（指名改写四条既有判据）。

**范围**：三处把 `OwnerTransferLockUnattributableError` 吞掉的地方，以及它抛出后沿途需要重决的消费点。

**明确不做**：E1 的 I-2 那一格（授权面外）、人裁 85（`ls` 也报锁）、Linux 覆盖、`OwnerTransferLockBusyError` 的文本、
人裁 83 的删锁条件、`not-determined-dead` 出口的行为、`push`。

---

## 1. 病灶

上一轮（I-3(b)，人裁 106）造出了 `OwnerTransferLockUnattributableError`：一把**没有任何进程可归属、因而永远不会被释放**的转移锁，
只有人跑 `ccloop unlock` 才能解开。那一轮把五个消费点逐个重决了，**但只重决了它们能看见这个类的那些**。

有三处看不见它 —— 它们在这个类诞生之前就写好了，用「吞掉一切非某某类」的形状把它一并吞了：

| # | 位置 | 现在的形状 | 后果 |
|---|---|---|---|
| A | `src/persistence/fileStore.ts` `recoverInterruptedOwnerTransfer` 的未持锁分支 | `catch { return; }`（裸 catch，注释自陈只想吞 Busy 与非 EEXIST errno） | `readOwnerRecord` **无限期返回转移前的旧记录**，且没有任何人会知道 |
| B | `src/controller/leaseHeartbeat.ts` `runAffirm` | `if (!(error instanceof OwnerTransferPreconditionError)) { return; }` | 心跳**每 tick 重试一把永远不会清的锁**，而该处注释的前提写着 `transient` |
| C | `src/controller/leaseHeartbeat.ts` `stop()` | `catch {}`（**有意吞，有注释声明**） | 停止路径上撞到这把锁时，操作员什么都看不到 |

A 是第一轮评审员称为 *"the project's signature defect"* 的那一条。它的直接后果是：**上一轮新造的错误类在 `readOwnerRecord` 这条路上完全无效。**

### 1.1 一条实测，排除了一个会把方案定错的误判

`tests/persistence/fileStore.test.ts` 里有一条判据用**活着的、强 instance-id 形式**的持有者建锁，而它命中的是 `unattributable` 出口
（因为 `parsePid` 只认 `/^pid:(\d+)$/`，强形式 `pid:<n>:<start>` 匹配不上，落到 `no-pid-holder`）。
若生产里的锁也写强形式，本设计的收窄就会**把日常的锁争用变成硬停**。

**实测排除**：真正写锁的那一行（`src/persistence/fileStore.ts`，`holderProcessInstanceId: ` 后面跟的模板串）写的是
**弱形式 `pid:${process.pid}`**，`parsePid` 认得，所以生产里活着的持有者落在 `not-determined-dead` 而不是 `unattributable`。
强形式只出现在那条手写 fixture 里。**收窄不会波及日常争用。**

---

## 2. 三处的处置

### 2.1 A —— 收窄，让它抛（人裁 111）

```
} catch {                          =>   } catch (error) {
                                          if (error instanceof OwnerTransferLockUnattributableError) {
                                            throw error;
                                          }
  return;                                 return;
}                                       }
```

Busy 与非 EEXIST errno 的行为**逐格不变**。

该 catch 上方的注释里「this read must not surface a new failure mode: readOwnerRecord's caller expects the read to succeed
even when recovery can't run right now」这句，对不可归属这一格自本轮起为假。它是**上一会话写的**，按铁律 5：
**原文逐字保留，在整个注释块末尾追加具名 `*** ERRATUM (…, HUMAN RULING 111) … ***`**，写明哪一格不再适用、以及新的出口去了哪里。
ERRATUM 内不写会被后续裁决推翻的计数，不引用会移动的 git 引用。

### 2.2 `readOwnerRecord` 的三个消费点

普查结果（本会话自己数的，不引任何文档）：`readOwnerRecord` 在 `src/` 下**只有 3 个调用点** ——
`src/controller/runLoop.ts` 两处、`src/controller/resumeLoop.ts` 一处。

**爆炸半径还能钉得更死**：`readOwnerRecord` 是 `recoverInterruptedOwnerTransfer` **唯一的未持锁调用点**，
其余四个调用点全部传 `{ lockHeld: true }`，走的是**根本不碰 `acquireOwnerTransferLock`** 的那条分支。
⇒ §2.1 的收窄在 `src/` 内**只可能沿这一条路径**冒出来。

**resumeLoop 的那处**已经被 try 包住、已经 fail closed，只是 detail 说不出病名（`cannot read run artifacts: …`）。
处置：在该 catch 里加不可归属分支，detail 改说 `owner-transfer lock unattributable: …`，
形状抄同文件 claim 站点已有的那组三分支（Busy／不可归属／CAS 各说各的）。**refusal 的性质不变，仍是 `ResumeNotEligibleError`。**

**runLoop 的两处一行不改**（人裁 114，方案 B）。理由：
1. 其中一处**就在刚刚 containment 完不可归属的那个 catch 块内部**，在站点上再接一次会把上一轮刚做的 containment 拆开；
2. 两个站点只有一条汇合路径（`runLoopFromState` 的外层 catch），**接一次好过接两次**；
3. 站点级接住之后只能拿未恢复的旧记录继续，那正是本轮要治的病本身。

### 2.3 `runLoop` 的一处路由（人裁 114）

在 `runLoopFromState` 外层 catch 内新增一支，**必须排在通用失败处理之前**，与该 catch 内既有的
`RunHeartbeatStoppedError` 分支同形。

与 `isLeaseStopError` 的相对次序**无关紧要，因此不作约束**：两者匹配的类不相交，不可能同时命中。
唯一承重的次序是「在通用失败处理之前」——落在其后就等于不存在。

- 记 `owner_transfer_contended` 事件，detail 带原因与 `ccloop unlock` 指引。
  **故意不新造事件类型** —— 抄上一轮在 runLoop 转移失败处已做过的同一决定：这条流已经命名了「转移被一把锁挡掉」这件事，
  新造第二个类型会把它的每一个消费者劈成两半。
- 持久化当前 `state`，然后返回它。**不判 `failed`，不判 `cancelled`。**

⚠️ **两条本节尚未量到的承重前提**，实施阶段必须先量，量不出来就回到设计：

1. **「不接住就会被判 `failed`」** —— 仓库里有四处注释这么说，上一轮也有一次实测记录，但**本轮的探针没能量到它**：
   收窄之后 `runLoop`／`resumeLoop`／`leaseLifecycle` 三个集成测试文件**全绿**，说明**没有任何现存判据走这条路**。
   ⇒ 由本轮新判据 ＋「删掉这一支」的变异当场量。
2. **「要不要跟着写 `state`」** —— 本设计按同形先定为**写**，理由是既有那一支的注释所讲的「mid-attempt 时 `state`
   可能已被 `applyPhaseUsage` 推进过、不写则返回值与盘上不一致」同样适用于本支。**这是推理，不是实测**，实施阶段以实测为准。

### 2.4 心跳两处（人裁 112／113）

`runAffirm`：在既有的 `instanceof OwnerTransferPreconditionError` 判断**之前**加不可归属分支 —— 记一次事件，然后 `return`。
**tick 的行为一字不改**：不停止 affirm、不改节流、不升级给 `onLeaseLost`（租约并没有丢），也**绝不抛进控制循环**
（该处注释已写明：timer 路径是 `void affirmNow()`，抛出去就是 unhandled rejection）。

`stop()`：`catch {}` 改成 `catch (error)`，同样记一次，然后照旧吞。**释放照旧失败，租约照旧自然过期** —— 这一支的注释
早就声明了它是有意吞的，本轮只让它在第一次撞见这把锁时不再静默。

**「只记一次」**：一个心跳实例一个布尔标志，`runAffirm` 与 `stop()` **共用**。理由：心跳每 tick 都会撞上同一把锁，
不去重会把事件流淹掉；而两处共用一个标志，意味着**一个运行最多留下一条**这样的事件。
记事件走既有的 `appendLeaseEvent`（它内部已吞 I/O 失败），所以记事件本身不会成为新的失败面。

---

## 3. 判据

### 3.1 只加不改（四条新判据）

| | 钉住什么 |
|---|---|
| N1 | 不可归属的锁 ＋ `runLoop` 进入归属评估 ⇒ 事件里出现 `owner_transfer_contended` 且 detail 指向 `ccloop unlock`；**运行没有被判 `failed`**，也没有被判 `cancelled` |
| N2 | `resumeLoop` 的入口读撞上不可归属 ⇒ `resume_denied` 的 detail 说 `owner-transfer lock unattributable`，**不再说 `cannot read run artifacts`**；仍然拒绝 |
| N3 | 心跳 `runAffirm` 撞上不可归属 ⇒ 事件出现一条；**心跳没有停**（后续 tick 仍在跑），且没有 `lease_lost` |
| N4 | 同一个心跳实例反复撞 ＋ 随后 `stop()` ⇒ 该事件**总数恰为 1** |

N4 是 N3 的去重面，单独立一条，因为「记了」和「只记了一次」是两件事，合在一条里任何一半失效都可能被另一半掩盖。

### 3.2 人裁 115 指名改写（四条既有判据，全在 `tests/persistence/fileStore.test.ts`）

- `keeps a malformed lock non-recoverable even when staged artifacts are present`
- `keeps a lock non-recoverable when its live holder is in the strong instance-id form`
- `observes that the redline function actually ran on the strong-holder fixture`
- `leaves the lock on disk when malformed staged state names no dead holder`

四条都用 `readOwnerRecord` 作**载具**去驱动代码路径，再断言人裁 83 的 fail-closed。收窄后该载具会 reject，故：

```
- const owner = await readOwnerRecord(runDir);
- expect(owner.currentOwnerEpoch).toBe(1);
+ await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferLockUnattributableError);
```

第四条 `leaves the lock on disk when malformed staged state names no dead holder` **形状不同**：它没有 `const owner`，
返回值本来就没人用，只是裸 `await readOwnerRecord(runDir);`。它改成：

```
- await readOwnerRecord(runDir);
+ await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferLockUnattributableError);
```

**逐字保留**：锁仍在盘上的断言、staged pending 未被 finalize 的断言、以及第三条里 `lockReads > 0` 那个正向观测
（它是「代码真的被进入过」的唯一证据，去掉它整条判据就变空）。

**诚实交代**：被替换掉的 `currentOwnerEpoch === 1` 编码的正是人裁 111 推翻的 fail-open —— 它是**被替换、不是被保留**。
每条改后必须写明「本条编码的是人裁 111」。**不许放宽**：`rejects.toBeInstanceOf` 认的是具体的类，不是任意错误。

---

## 4. 变异证明（每条必须被**看到**打红才算数）

| | 变异 | 期望 |
|---|---|---|
| M1 | 删掉 `runLoop` 新增的那一支 | N1 红，且红的方式是运行被判 `failed` —— **这同时是 §2.3 第 1 条前提的度量** |
| M2 | 把该支移到通用失败处理**之后** | N1 红 —— 钉住「顺序本身承重」。**前提已核实**：通用失败处理以 `return state` 结尾，故排在其后的分支不可达 |
| M3 | 删掉 `resumeLoop` 的不可归属分支 | N2 红，detail 退回 `cannot read run artifacts` |
| M4 | 删掉心跳 `runAffirm` 的分支 | N3 红（事件不出现） |
| M5 | 去掉「只记一次」的标志 | N4 红（事件多于一条） |
| M6 | 把 §2.1 的收窄改回裸 `catch` | 四条改写判据**变红** —— 撤掉收窄，`readOwnerRecord` 恢复 resolve，而改写后的它们断言的是 `rejects`。钉住它们承的正是收窄这件事 |
| M7 | 把该支的条件放宽成匹配任意 `Error` | 现存那些「运行应判 `failed`」的判据**变红**（**靶子已核实存在**：`tests/controller/runLoop.integration.test.ts` 里有 14 条 `status).toBe("failed")` 断言） —— 钉住新分支**没有放宽**，没有把别的错误一并当成不可归属。本仓库正是被「吞掉一切非某某类」这个形状咬过三次的 |

⚠️ 变异一律在 `git clone --local` 副本里做，主仓库工作树全程零触碰。
⚠️ **副本只克隆已提交状态** —— 未提交的改动必须先 `cat 工作树文件 > 副本对应文件`，并用 `diff` 证明两边逐字节相同；
删副本前做「副本文件 vs 工作树文件」的最终字节比对（上一轮这一档弱了，本轮补上）。

---

## 5. 风险

| 风险 | 处置 |
|---|---|
| 收窄让 `readOwnerRecord` 多出一个失败面，可能有未被判据覆盖的消费者 | 已普查：`src/` 下只有 3 个调用点，三处都在本设计内重决；探针实测收窄后只有 4 条既有判据变红，且全部可解释 |
| `runLoop` 新分支排错位置会被通用失败处理抢先 | M2 专钉这一点 |
| `runLoop` 新分支过宽，把别的错误也当成不可归属（本仓库三处旧吞点正是这个形状） | M7 专钉这一点 |
| 心跳记事件引入新的失败面 | 走既有 `appendLeaseEvent`，其内部已吞 I/O 失败 |
| 「不接住就判 failed」这条前提没量到 | 已在 §2.3 显式标注为未量，由 M1 当场量；量不出来则回到设计，不硬推 |
| 事件流被淹 | N4 ＋ M5 钉住一个运行最多一条 |

---

## 6. 本设计不改变的东西（逐条）

- 人裁 83 的删锁条件：**逐格不变**，红线函数一个出口都不动。
- `OwnerTransferLockBusyError` 的文本与它覆盖的那些格：不动。
- `not-determined-dead` 出口的行为：不动。
- 心跳的 tick 节奏、节流、`onLeaseLost` 语义、supersession 判定：不动。
- `stop()` 释放失败后租约自然过期这一契约：不动。
- E1、`ls`、Linux：不碰。
- **控制器不 push。**
