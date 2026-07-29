# 裁决记录：四笔遗留技术债的归属

日期：2026-07-29
起点：`main` @ `ad0c4f5`，29 files / 427 tests 全绿，typecheck / build 干净（本轮独立复跑坐实）
范围：**只裁决归属。不写 spec，不改代码。**
前置阅读：`docs/handoff/handoff.md`、`.superpowers/sdd/2026-07-2{6,7,8}-*/progress.md`

本记录的每一条结论都对着 `src/` 的实际代码核实过，未接受 handoff 或 ledger 的转述。**其中两条推翻了 handoff 的描述**，见债 1 与债 4。

---

## 结论速查

| 债 | handoff 原描述 | 裁决去向 | 一句话理由 |
|---|---|---|---|
| 1 | reconciliation 合成责任无人认领 | **L3 的前置** | 描述有误。生产者一直存在；真实缺陷是跨文件事务性。不修它，L3 的触发能力跑不通 |
| 2 | `persistTerminalState` 往已不拥有的 run 写 | **L5** | 修它就制造孤儿，而孤儿是 L5 的定义域 |
| 3 | `heartbeat.stop()` 释放窗口 | **L3** | L3 是加触发调用者、从而让它可达的那一层 |
| 4 | `writeRunState` / 首次 `writeOwnerRecord` 非原子 | **现在就修**（独立小分支） | 机械、低风险、有现成原子写辅助可复用 |

**附带结论：下一层是 L3，不是 L5。** 四笔债里两笔（1、3）是 L3 的前置；L5 的唯一输入（债 2）要等 L3 存在之后才有意义——没有触发层，孤儿产生速率接近零，先建 GC 是给不存在的问题建方案。

### 「前置」的准确含义（消歧）

- **债 1 与债 3 归 L3，指的是「在 L3 自己的 spec 内解决」，不是「在 L3 之前另开一层」。** 债 1 是 L3 spec 的独立一节、独立任务组、独立评审；债 3 是 L3 spec 必须显式表态的一项。二者都不构成 L3 之外的新层。
- **债 4「现在就修」指的是一个先于 L3 开始、且完成后再开 L3 的独立小分支。** 它不与 L3 并行——见下面的顺序约束。

### 执行顺序（不可打乱）

1. **债 4 分支**（原子写）→ 评审 → 合并。
2. **L3**（brainstorming → spec → plan → 实现），其中债 1 作为独立一节先于触发逻辑落地，债 3 在 spec 中显式表态。
3. **L5**（cleanup / orphan GC），届时处理债 2。

顺序不可打乱的原因：**债 4 与债 1 在 `reconciliation-record.json` 上重叠**。债 4 给它加 temp+rename（改「怎么写」），债 1 可能把它整个移进 owner-transfer 的事务（改「何时写」）。若并行推进，债 4 的改动会被债 1 直接覆盖掉；若 L3 先做，债 4 就得在一个正在变动的写路径上施工。**先做债 4、再做 L3 是唯一不返工的顺序**，代价是债 4 对该文件所做的工作有一部分会在 L3 中被取代——这是已知且接受的。

---

## 债 1 — 跨文件事务性（原「reconciliation 合成责任无人认领」）

### handoff 的描述是错的

「合成责任无人认领」不成立。核实：

- `persistOwnerTransfer` 在生产代码里**只有一个调用点**：`src/controller/runLoop.ts:749`，被 `:747` 的 `boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed` 三重条件包住。
- `writeBoundaryArtifacts` 也**只有一个调用点**：`src/controller/runLoop.ts:821`，在同一函数、几行之后。
- reconciliation 记录的构造条件是 `boundaryAnalysis.status === "stale_candidate"`（`:823-824`）——**是转移条件的超集**。

所以转移的赢家本人就是生产者，二者相隔几行。责任从未真空。

### 真实缺陷

`owner-transfer.json` 在 `src/persistence/fileStore.ts:536-538` 被**原子 rename 发布**；reconciliation 记录要到 `runLoop.ts:821` 才写。中间隔着：

1. `:764` 的 `heartbeat.adopt()`
2. 退出 `heartbeat.runExclusive` 的 span（`:739-802`）
3. `:820` 的 `await heartbeat.assertHeld()` —— **会抛，且含一次真实文件读**

第三个进程在这个窗口里 supersede 赢家，`:820` 就拒绝 `:821` 的写，**而 transfer 已经不可撤销地发布出去了**。

磁盘上留下：`owner-transfer.json` 存在且 `eligibleForContinuation: true`，`reconciliation-record.json` 不存在。

### 症状链（已坐实，非推测）

L2 registry 如实报告 `eligibleForContinuation: true`
→ `src/controller/resumeLoop.ts:114` 调 `readReconciliationRecord`
→ `src/persistence/fileStore.ts:705-707` 直接 `readFile` + `JSON.parse`，文件缺失即 ENOENT 抛出
→ resume 失败。

这正是 handoff 记的「registry 显示 eligible 而磁盘上并无该文件」，机制现已查清。

**这是 liveness 洞，不是安全洞。** `evaluateResumeEligibility`（`resumeLoop.ts:39-64`）把 reconciliation 当作必需输入，缺失即 fail-closed。代价是「合法转移过的 run 无法 resume」，不是「不该 resume 的被 resume 了」。deny-by-default 未被削弱。

### 为什么归 L3 而不是 L5

L3 的「触发」定义就是让 eligible run 继续执行，而继续必须走 `resumeLoop`——今天它会 ENOENT。**债 1 不是可延后的债，是 L3 的功能前提。** 它与 cleanup / orphan GC 不沾边，推给 L5 会把刚查清的分类重新弄糊。

### 修法方向可行性（本轮已验证，只读）

**否决的方向**：「先写 reconciliation，再发布 owner-transfer」做不到——reconciliation 的 `newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道（`runLoop.ts:766`）。

**可行的方向**：把 reconciliation 加入转移**已有的**事务。`fileStore.ts:327-330` 已定义 `.owner-record.pending.json` / `.owner-transfer.pending.json` / `.owner-transfer.transaction.json` 事务标记，配合 `:536-538` 的双 rename 与 `recoverInterruptedOwnerTransfer` 的崩溃修复。reconciliation 可作为第三个文件加入同一事务，**不需要新发明一套原子性**。

**与 `preserveSuccessfulReconciliationIfNeeded` 无冲突**（本轮专门验证的一点）：它在 `fileStore.ts:282` 一进门就 `if (nextReconciliationRecord.eligibleForContinuation) return`——**只在 loser 路径运行**，而 loser 的转移根本没进入事务。两者不相交。

**留给 L3 spec 回答、本轮不预设答案的两个问题：**

1. `recoverInterruptedOwnerTransfer` 是否也要负责 finalize reconciliation。会扩大「读会写」的范围——而 L2 整层的设计正是围绕规避这一点建立的（禁用 `readOwnerRecord`）。
2. reconciliation 的内容依赖 exclusive span **之外**算出的 `boundaryEvidence` / `ownership`（`runLoop.ts:698-731`、`:820-843`）。塞进事务要改 `persistOwnerTransfer` 的签名——**那是 L1b 刚刚变异验证稳定下来的函数**。

### 执行约束（人下的指令）

债 1 在 L3 spec 里**必须是独立的一节、独立的任务组、独立的评审**，不得与触发逻辑混在同一批任务里。理由：它改的是 L1b 刚稳定的转移写序，风险等级与触发逻辑不同。

---

## 债 2 — `persistTerminalState` 往已不拥有的 run 写

### 核实

`src/controller/runLoop.ts:847-857`：

```
appendTransitionEvent(runDir, terminalState, ...)   // :854 写
writeRunState(runDir, terminalState)                // :855 写
```

两个裸写，**无任何 guard**。进入路径是 `isLeaseStopError` 分支——`:958-959` 与 `:1310-1317`——**恰好是本进程已经知道自己丢了租约的那条路**。

L1b 最终评审的原话仍然成立：层的论点在下一帧被执行、在上一帧被违反。而 L1b 的守卫使这条路径变得**更频繁**。

### 为什么归 L5

修债 2 意味着丢租约的进程不再写终态，于是 run 永远停在 `executing` / `verifying`——**制造孤儿**。孤儿正是 L5（cleanup / orphan GC）的定义域。

反过来说：**在 L5 存在之前修债 2 是净损失**。今天它至少留下一个终态和一条事件；修掉之后留下的是一个没人清理的活状态。所以这笔债的正确顺序是「先有 GC，再收紧写」，不是反过来。

### 不接受的替代裁决

「现在就修」被否决，理由如上。「明确接受」也被否决——它是层的核心论点的实际违反，不能声明为可接受。

---

## 债 3 — `heartbeat.stop()` 释放窗口

### 核实（比 ledger 记的更硬）

`src/controller/leaseHeartbeat.ts:216-235`：

- `:221` 置 `stopped = true`
- `:223` `await queue.catch(() => {})` —— **对当前 `queue` 取快照**
- `:231` `await releaseOwnerLease(...)`

关键在 `runExclusive`（`:196-203`）的注释白纸黑字写着：

> Takes no position on `stopped` or `superseded` — it only serializes.

**所以 `stopped` 标志根本挡不住新的 `runExclusive`。** 它重新赋值模块级 `queue`，而 `stop` 早已 await 完旧的那个，于是 `stop` 在一个 exclusive span 仍在飞行时返回，并继续去释放租约。

### 为什么归 L3

L1b 最终评审判定它**今天不可达**：`runLoop` 与 `resumeLoop` 都在 `finally` 里 await 完 `runLoopFromState` 之后才调 `stop()`，两个 `persistBoundaryAnalysis` 调用点也都被 await。

L2 刻意没有使其可达（只读、零新增调用者）——这是选 registry 而非 queue 的直接收益。

**L3 是加触发调用者的那一层，也就是让它可达的那一层。**

### 执行约束

L3 spec **必须显式对债 3 表态**，不得沉默继承。可接受的表态包括「收紧 `stop` 语义」「收紧 `runExclusive` 语义」「论证 L3 的调用形态不使其可达并加守护测试」——但不接受不提。

---

## 债 4 — 非原子写

### 核实（范围比 handoff 记的大一个文件）

非原子（裸 `writeFile`）：

- `src/persistence/fileStore.ts:81` —— `writeRunState`，即 `loop-state.json`，**每次状态转移都重写**
- `src/persistence/fileStore.ts:368` —— `writeOwnerRecord`（`:379`）走的辅助，即**首次创建**的 `owner-record.json`
- `src/persistence/fileStore.ts:316` —— **`reconciliation-record.json`**（本轮新查出，handoff 未记）

原子（temp + rename）：

- `:325-326`、`:536-538` —— owner-transfer 发布的双 rename
- `:632-636` —— `writeOwnerRecordAtomically`，owner-record 的**轮转**路径

**同一个 `owner-record.json`，首次创建非原子、后续轮转原子。** 这个不一致本身就是缺陷源。

L2 用 100ms 有界重读绕过而非修复，因为只读层不该改别人的写路径——那个判断是对的，但它把代价传给了每一个需要连贯读的后续消费者。

### 为什么现在就修

机械、低风险、边界清楚，而且 `writeOwnerRecordAtomically`（`:632-636`）已经是现成可复用的辅助。它不依赖任何未来层的设计决策，也不属于任何一层的定义域——把它挂在 L3 或 L5 下面只会推迟一个本可以立即消除的代价。

### 执行约束

- 独立小分支，独立评审，**先于 L3 完成并合并**（见上面的执行顺序）。
- **不得顺手改 `reconciliation-record.json` 的写入时机**——那是债 1 的范围，属于 L3。本次只改「怎么写」，不改「什么时候写」「写不写」。已知该文件上的部分工作会在 L3 中被取代，这是接受的代价。
- 注意 `:81` 的 `writeRunState` 是热路径（每次状态转移），temp+rename 会翻倍 syscall；若基准显示不可接受，如实上报而不是悄悄降级。

---

## 本轮明确没有做的事

- 没有写任何 spec。
- 没有改任何代码。
- 没有预设债 1 的具体修法（只验证了方向可行与不冲突）。
- 没有裁决 L2 挂账的 5 条 Minor（`handoff.md` 遗留事项 3）——它们不在本轮范围。
- 没有裁决 5 个已知 flake（遗留事项 2）——修法已记在 handoff，仍待独立验证轮。

## 对 handoff 的更正

1. **遗留事项 10 撤销**：`origin/main` 自动前进不是环境异常，是人自己 push 的。已向人确认。
2. **L5 继承清单第 1 条描述有误**：「reconciliation 合成责任无人认领」不成立，见债 1。该条应改写为跨文件事务性缺陷，并从 L5 清单移到 L3 前置。
3. **L5 继承清单第 4 条范围偏小**：漏了 `reconciliation-record.json`（`fileStore.ts:316`）。
4. **L5 继承清单现在只剩 1 笔**（债 2），不是 4 笔。
