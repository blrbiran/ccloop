# 任务 3 设计提案 —— 第 1 笔（锁可被偷 / P-READ）修法方案（只读，供人裁）

状态：骨架已落盘，各节待填。

## 1. 结论（最先写）

**基线 = HEAD `574e275`。** 工作树在我工作期间**被并发修改了至少两次**（见 §8 探针 3／5），
所以本方案的一切代码论断都以 HEAD 为准，我**没有跑测试套件**（跑了也只是在量别人的变异）。

### 推荐方案一句话

> **让 `recoverInterruptedOwnerTransfer` 的 `!lockHeld` 分支去「真正拿锁」再 finalize
> ——复用现成的 `acquireOwnerTransferLock`，拿不到就什么都不做、照常裸读——
> 而不是像今天这样「探一下锁、可能把它删掉、然后不持锁 finalize」。**

这是**阶段 1**，小、独立、今天就能落地，**完全不碰 L1/L2「读不许写」契约**。

### 它 covers 什么

- **P-READ 的数据丢失后果**：G0/G1/G2/G3 四格今天**全都**不持锁就调
  `finalizePendingOwnerTransfer`（我在今天的代码上重核过，§2）。阶段 1 把这四格
  收敛成「唯一一条持锁的 finalize 路径」，两个 finalizer 并发抢同一组固定 temp 名
  （`ownerTempPath` / `transferTempPath` / `reconciliationTempPath`）的终态**消失**。
- **G0 这一格**——今天连锁都没碰过（`&&` 在 `pathExists(lockPath)` 上短路）——
  也一并被 covers，而这正是「只修锁协议治不了」的那一格。
- 阶段 1 **不需要**任何新原语、不新增判据、不动 spec。

### 它**不** covers 什么（明写）

1. **锁本身仍然可以被偷。** 阶段 1 只保证「finalize 时手里有一把锁」，不保证
   「这把锁没被人从别人手里抢来」。§13 第 1 笔原文那条（`acquireOwnerTransferLock`
   EEXIST → `tryRecoverStaleOwnerTransferLock` 判活失败就删锁）**原封不动地活着**。
   两个进程仍可各自「持有」一把锁并发 finalize，只是构造更窄（需要撞上
   零长度锁窗口 G3，或 `parsePid` 判不出 pid 的 G2-null）。**残余口子的大小见 §3.4。**
   关掉它是**阶段 2**，而阶段 2 要动两条既有具名判据，**必须单独交人裁**。
2. **`readOwnerRecord` 依然是一个写者。** 阶段 1 让它「写得安全」，没让它「不写」。
   于是「谁把 `readOwnerRecord` 绑进只读层就出事」这一整类错误**没有被根除**，
   仍然靠 `readOwnerRecordWithoutRecovery` ＋ `defaultObserveDeps` ＋ zero-write 测试
   人工守着。根除它 = **动 L1/L2 契约 = 路 B**，见 §4。
3. **`finalizePendingOwnerTransfer` 函数体内依然零守卫**（不比 CAS、不比所有权、
   不判活）。它对「我是不是唯一 finalizer」仍然**没有任何自检能力**，安全性 100%
   来自调用者持锁。阶段 1 只是让「调用者持锁」这句话第一次变成真的。
4. **fsync 一概没有**（`writeJsonFileAtomically` 自己的注释就写明了）。掉电仍可丢。
   本方案不改这一条。

### 需要人裁的点（各一行，共 3 个）

- **人裁点 A**：L1/L2「读不许写」——走**路 A（不动契约，仅阶段 1）**，还是走
  **路 B（动契约，`readOwnerRecord` 变纯读）**，还是「A 现在 + B 以后」？两条代价见 §4。
- **人裁点 B**：阶段 2 要把 `tryRecoverStaleOwnerTransferLock` 从**失败开放**改成
  **失败关闭**，这会直接推翻两条逐字断言现行行为的既有判据
  （`tests/persistence/fileStore.test.ts` 的两个同名 `it("treats malformed lock contents
  with staged artifacts as stale and recoverable")`）。**人裁 13／14 明写不得外推到这里**，
  故需单独授权。
- **人裁点 C**：人裁点 B 一旦通过，一把「死进程留下的、内容损坏的锁」将**永久卡死**转移路径；
  要不要同时给一个运维逃生口（显式的 break-lock 命令／带阈值的 mtime 判据）？不给就是接受卡死。

### 我偏好之外必须并列的那条

⚠️ 我的推荐是路 A 起步，但**路 B 才是形状正确的终局**（读不能写 ⇒ P-READ 按构造不存在，
G0–G3 整个格子塌掉）。我把 A 排在前面**不是因为 B 错**，而是因为 B 的代价是「退役一节 spec
＋ ≥8 条具名判据」，那不该由实施者顺手做掉。§4 把两条并排摆了，代价都写实。

## 2. 第 1 笔今天的可达面（含判别式与命令输出）

⚠️ **这是我搜到的面，按下面写明的搜索面得出，不是完备性证明。** 我没有排除动态／反射调用，
也没有排除今天不存在、明天会加的调用点。凡我给出的否定，都只在**声明的搜索面之内**成立。

### 2.1 判别式

一个入口在第 1 笔的面上，当且仅当它能**在不持有 `.owner-transfer.lock` 的情况下**到达下列二者之一：

- (D1) `finalizePendingOwnerTransfer` —— 唯一把 staging 发布成三份权威产物的函数；
- (D2) `safeUnlink(lockPath)` —— 把别人的互斥删掉。

### 2.2 搜索面（先声明，再断言）

对**整个 `src/`**（不加 `--include`、不缩路径）grep 下列符号与字面量：
`acquireOwnerTransferLock(` / `isProcessActive` / `rename(` / `finalizePendingOwnerTransfer` /
`recoverInterruptedOwnerTransfer` / `parsePid` / `buildProcessInstanceId`。
逐字输出见 §8 探针 4，含**双向 sanity**（一条必命中、一条必空）。

`rename(` 那一条是用来兜底「有没有第三条同形路径」的：**发布成终态的唯一原语是 `rename`**，
所以枚举 `src/` 里全部 4 个 `rename(` 调用点即可给「同形路径」定界。

### 2.3 持锁的写者（不在面上，按构造安全）

`acquireOwnerTransferLock(` 在**整个 `src/`** 只有 4 处命中：1 处定义 + 3 处调用。

| 调用点（符号名） | 锁范围 |
|---|---|
| `writeOwnerTransferArtifacts` | `acquireOwnerTransferLock` … `finally { lock.release() }` |
| `claimOwnerRecordWithPrecondition` | 同上 |
| `updateOwnerRecordWithPrecondition`（`affirmOwnerLease` / `releaseOwnerLease` 的共同实现） | 同上 |

这三者内部的 `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })` 都在锁内。

### 2.4 不持锁的入口 —— 面就在这里

`recoverInterruptedOwnerTransfer` 在 `src/` 有 4 处调用（探针 4 CLAIM 5）：
`fileStore.ts:1029`（`readOwnerRecord`，**不传 options**）、`:1043` / `:1086` / `:1135`（三处 `lockHeld: true`）。

⇒ **`readOwnerRecord` 是 `recoverInterruptedOwnerTransfer` 唯一的无锁入口。**

`readOwnerRecord` 在 `src/` 的调用点（探针 1）：

| # | 调用点 | 对外的入口名 |
|---|---|---|
| 1 | `src/controller/runLoop.ts:794` | `runLoop` / `runLoopFromState` 主路径 |
| 2 | `src/controller/runLoop.ts:872` | 同上，边界处的第二次读 |
| 3 | `src/controller/resumeLoop.ts:137`（在 `Promise.all` 里） | `resumeLoop`（sweep / resume 的必经之路） |
| 4 | `src/persistence/fileStore.ts:382`（`readPersistedSuccessfulTransferArtifacts` 内） | **`writeBoundaryArtifacts` 的「保护性读」** |

**第 4 条值得单独点名**：那是一次自称保护性的读（同一函数的注释逐字写着
「a protective read is not one of them and **must not write**」），它却经由 `readOwnerRecord`
掉进无锁 finalize。注释那句话只对它自己的 `no_published_transfer` 早退臂成立，
对 `readOwnerRecord` 这一臂**不成立**。这是一处**注释与行为不符**，我只上报，不改。

**四个调用点都不需要任何特权，也都不要求调用方拥有这个 run。**

### 2.5 四格 G0–G3（我在今天的代码上重核，不引报告结论）

`recoverInterruptedOwnerTransfer` 的 `!lockHeld` 分支，判据逐字为：

```
if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
  return;
}
await finalizePendingOwnerTransfer(runDir);
```

在 marker 存在（`:1014` 已保证）且 `!lockHeld` 时，落到 finalize 有且仅有四格：

| 格 | 条件 | 有没有碰锁 | 结果 |
|---|---|---|---|
| **G0** | `pathExists(lockPath)` 为 false | **完全没碰** | 第二合取项短路 → **不持锁 finalize** |
| **G1** | `pathExists` 为真，但 `tryRecover…` 里的 `readFile(lockPath)` 抛 ENOENT | 只读，未删 | `return true` → **不持锁 finalize** |
| **G2** | 锁可解析，`pid === null` 或 `!isProcessActive(pid)` | `safeUnlink` 删锁 | `return true` → **不持锁 finalize** |
| **G3** | 锁存在但 `JSON.parse` **抛**，且 `hasStagedArtifacts` 真 | `safeUnlink` 删锁 | `return true` → **不持锁 finalize** |

**四格全部不持锁。** 关键在于 `tryRecoverStaleOwnerTransferLock` 的返回值语义是
**「锁已不构成阻碍」**，而**不是「我拿到锁了」**——它从头到尾没有 `open(lockPath,"wx")`。
`acquireOwnerTransferLock(` 的 3 个调用点**没有一个在 `recoverInterruptedOwnerTransfer` 内**
（探针 4 CLAIM 1 逐字输出）。

**G3 是「偷锁」那条**：`acquireOwnerTransferLock` 先 `open(lockPath,"wx")` 再
`handle.writeFile(...)`，两步之间锁文件**长度为 0**；此时读者 `JSON.parse("")` 抛，
进 catch，而 `hasStagedArtifacts` 的第一个析取项就是 `pathExists(transactionMarkerPath)`
—— 在 recovery 路径上它由**入口条件本身**满足，**恒为真**。所以 catch 分支的那道
「有没有残余 staging」的闸门，在这条路径上**筛不掉任何东西**。我在今天的代码上核对了这一点：
`recoverInterruptedOwnerTransfer` 的 `:1014` 早退保证了「到达判据 ⇒ marker 存在」，
而 `hasStagedArtifacts` 又去问同一个 marker。

**G2-null**：`parsePid` 是 `/^pid:(\d+)$/`；锁的写者写的是 `` `pid:${process.pid}` ``，两者**今天匹配**。
但只要 `holderProcessInstanceId` 变成 `buildProcessInstanceId()` 的 `pid:<pid>:<origin>` 形式
（`src/runtime/processIdentity.ts`），`parsePid` 就返回 `null` → `pid !== null` 为假 →
**跳过判活直接删锁**。⇒ **今天不可达（写者形式写死），但没有任何测试钉住这个不匹配**
（progress.md §5 的收紧措辞：没被钉住的是 *`parsePid` 与该形式的不匹配*，
**不是**「该形式无人断言」——后者为假，`tests/runtime/processIdentity.test.ts` 与
`tests/persistence/fileStore.test.ts` 两处逐字断言了该形式，见 §8 探针 8）。
`fileStore.ts` 自己的注释还明写「do not "unify" it with this one」——那条注释是对的，
但它保护的是**弱形式**，而危险恰恰是**有人把强形式塞进锁记录**。

### 2.6 有没有第三条同形路径

`src/` 全部 4 个 `rename(`（探针 4 CLAIM 3），逐条归属：

| rename | 所属函数 | 持锁？ |
|---|---|---|
| `fileStore.ts:649` | `writeJsonFileAtomically` | 不在转移事务内，**也不发布转移产物** |
| `fileStore.ts:995` | `finalizePendingOwnerTransfer` | **两者兼有**：`:1025`（四格全不持锁）＋ `:1072`（持锁） |
| `fileStore.ts:1111` | `writeOwnerRecordAtomically` | 两个调用点都在锁内 |
| `fileStore.ts:1123` | `writeJsonFileViaFixedTemp` | 全部在 `writeOwnerTransferArtifacts` 锁内 |

⇒ 在这个搜索面内，**第三条同形路径没有**；唯一的无锁发布点就是 `:1025`。
`isProcessActive` 全 `src/` 只有 1 处定义 + 1 处调用，且在**解析成功**的路径上
⇒ **G0 这一格连 `tryRecoverStaleOwnerTransferLock` 都没进去过，判活无从谈起**
—— 这就是「补上活进程检查也治不了 P-READ」的机械原因。

## 3. P-READ：为什么锁协议治不了它 / 我的方案对它做了什么

### 3.1 为什么「只修锁」治不了（三条机械理由，都在 §2 的引文里）

1. **G0 根本不进锁协议。** 判据是 `!lockHeld && pathExists(lockPath) && !tryRecover(...)`。
   锁文件不存在 ⇒ 第二合取项为假 ⇒ **`tryRecoverStaleOwnerTransferLock` 一次都不被调用** ⇒
   无论你把它的判活检查改成什么样，这一格**一个字节都不受影响**，照样不持锁 finalize。
2. **`tryRecoverStaleOwnerTransferLock` 返回 true 的语义不是「我持锁了」，而是「锁不挡路了」。**
   它没有 `open(...,"wx")`。就算把它改到判活百分之百正确，它返回 true 之后到
   `finalizePendingOwnerTransfer` 之间**仍然没有任何互斥**：这中间任何进程都可以
   `open(lockPath,"wx")` 成功并进入它自己的持锁 finalize。
3. **`finalizePendingOwnerTransfer` 自身零守卫。** 它不 CAS、不比所有权、不判活、
   连 `lockPath` 这个名字都不出现在函数体里。它对「我是不是唯一 finalizer」没有自检能力。

### 3.2 G0 今天怎么达到（不需要 SIGKILL，不需要零长度窗口）

「marker 在、锁文件不在」不是罕见状态，有一条**完全不需要崩溃**的到达方式：

`writeOwnerTransferArtifacts` 的结构是 `acquireOwnerTransferLock` → try { … ;
`finalizePendingOwnerTransfer` } → **`finally { lock.release() }`**。
只要 `finalizePendingOwnerTransfer` **抛**（它有四种具名抛法：`OwnerTransferMarkerUnreadableError`、
`OwnerTransferPendingMissingError`、`OwnerTransferMarkerFinalizeOrderInvalidError`，
外加 rename/写入的 I/O 错误），`finally` 就把锁**正常释放**掉，而 marker 与 pendings
**按 fail-closed 的设计原地保留**。此刻磁盘状态精确地是：**marker 在、pendings 在、锁不在** = **G0**。

从这一刻起，**任何进程的任何一次 `readOwnerRecord`** 都会不持锁地去 finalize 同一组 pendings；
两个这样的读者（或一个读者 + 一个刚 `open(wx)` 成功的正常写者）就并发跑在
`ownerTempPath` / `transferTempPath` / `reconciliationTempPath` 这**三个固定名**上：
一方的 `writeJsonFile(tempPath)` 会覆盖另一方已写好的 temp 内容，另一方随后的
`rename(tempPath, targetPath)` 就把**对方的字节**发布成权威产物；或者一方的 rename
先把 temp 搬走，另一方的 rename 拿到 ENOENT 抛出，留下**只发布了一部分**的三文件组。
两种终态都是**数据丢失**级别（发布了从未被任何一方 stage 的组合，或三文件组不再一致）。

⚠️ 我**没有**写复现脚本实测这一并发终态（原因见 §9）。上面是对今天代码的静态推演，
论据是 §2 引的判据与 `finalizePendingOwnerTransfer` 的函数体。**这是推演，不是实测。**

旁证（只当旁证，不承重）：`tests/registry/zeroWrite.test.ts` 自己有一句
「A live lock makes recoverInterruptedOwnerTransfer a no-op, which would make every assertion
below pass or fail for the wrong reason」，并**逐字断言 fixture 里锁文件不存在**
（`expect(await pathExists(join(runDir, ".owner-transfer.lock"))).toBe(false)`）——
即本仓库的测试**自己依赖 G0 这一格的行为**来让 fixture 生效。

### 3.3 我的方案对 P-READ 做了什么（阶段 1 的形状）

把 `recoverInterruptedOwnerTransfer` 的 `!lockHeld` 分支从
「探锁 → 可能删锁 → 不持锁 finalize」改成「**取锁 → 持锁 finalize → 释放**」：

```
（形状，非补丁）
if (!options?.lockHeld) {
  let lock;
  try {
    lock = await acquireOwnerTransferLock(runDir);   // 复用现成原语，含它自己的 EEXIST→stale→重试
  } catch {
    return;            // 拿不到锁 = 现在不该由我恢复。与今天「busy 就 return」同语义
  }
  try {
    await finalizePendingOwnerTransfer(runDir);
  } finally {
    await lock.release();
  }
  return;
}
await finalizePendingOwnerTransfer(runDir);           // lockHeld: true 的三个调用点，原样
```

四格塌成一条：G0/G1 变成「锁不存在 ⇒ `open(wx)` 直接成功 ⇒ 持锁 finalize」；
G2/G3 变成「`acquireOwnerTransferLock` 内部的 EEXIST → `tryRecover…` → 重试 `open(wx)`」
—— **偷锁的判定还在，但偷完之后是真的把锁攥在手里了**，不再是「删掉就走」。

**两个必须明写的设计细节**：

- **取锁失败一律 `return`，绝不外抛。** 今天的读路径在锁上只调 `pathExists`（吞掉一切错误），
  所以**读永远不会因为锁而失败**。`acquireOwnerTransferLock` 会抛 `OwnerTransferLockBusyError`，
  也会抛非 EEXIST 的 errno（如 `EACCES`／`ENOSPC`）。若不兜住，`readOwnerRecord`
  就获得了一类**今天没有的新失败模式**，并会一路传到 `runLoopFromState` 的外层 catch
  （那里 `isLeaseStopError` 不匹配 I/O 错误）把一次本可成功的 attempt 判成失败。
  ⇒ **只在「取锁」这一步宽catch，`finalizePendingOwnerTransfer` 的抛照旧原样外传**
  （那四种 fail-closed 抛是既有判据钉住的，见 §7）。
- **`finalize` 的抛必须走 `finally` 释放锁**，否则就把 G0 从「偶发」变成「必然」——
  一次 finalize 失败会永久留下一把无主锁。这正是 `writeOwnerTransferArtifacts`
  今天已经在做的形状，属于**沿用本仓库既有约定**，不是新发明。

### 3.4 阶段 1 之后**剩下的口子有多大**（不 covers 的部分，量化）

阶段 1 之后，两个进程仍能同时「持锁」，当且仅当 `acquireOwnerTransferLock` 的
EEXIST 分支把一个**活着的**持有者判成死的。今天有两条判成死的路：

| 残余格 | 触发条件 | 今天可达？ |
|---|---|---|
| **G3'**（零长度锁窗口） | 读者恰好落在持有者 `open(wx)` 返回、`writeFile` 未落盘之间；`JSON.parse("")` 抛 → catch → `hasStagedArtifacts`（marker 在时**恒真**）→ 删锁 | **可达**，但要求命中一个很窄的调度窗口 |
| **G2-null** | 锁记录里的 `holderProcessInstanceId` 不是 `pid:<digits>` 形式 → `parsePid` 返回 `null` → **跳过判活**直接删锁 | **今天不可达**（写者形式写死），**且无测试钉住** |

⇒ **剩下的口子 = 从「一个不需要撞窗口、marker 一在就长期敞开的洞（G0）」
缩到「一个需要撞纳秒级调度窗口的洞（G3'）」＋「一个今天不可达的定时炸弹（G2-null）」。**
这不是关严，是**从常态降到窄窗**。要关严必须走阶段 2（人裁点 B / C）。

## 4. L1/L2「读不许写」契约：动 与 不动 两条路，各自的代价

### 4.0 先把契约本身说准（今天它到底是什么）

它**不是**「`readOwnerRecord` 不许写」。今天的契约恰恰相反，是：

> **`readOwnerRecord` 是一个写者，这是既定事实；因此只读层不许绑它，必须绑
> `readOwnerRecordWithoutRecovery`。**

四处承载物（都在今天的代码里）：

1. `src/registry/readObservedFile.ts` 的 `defaultObserveDeps`，逐字：
   「**Never bind `readOwnerRecord` here — it runs crash recovery and would turn this
   read-only layer into a writer (spec §7.1)**」。
2. `src/persistence/fileStore.ts` 的 `readOwnerRecordWithoutRecovery`，逐字：
   「§7.1: the gate's read. … **A refusal must not trigger crash recovery as a side effect,
   so the gate reads raw.**」
3. `docs/superpowers/specs/2026-07-28-run-registry-design.md` §7.1／§7.4／§12.1
   （§7.4 逐字：`checkRunLease` 「writes. It cannot be called from a zero-write scanner,
   and it **must not be refactored to accommodate one** — L1 §12 has constraints pinned to
   its current behavior.」）。
4. `tests/registry/zeroWrite.test.ts` —— 对**真实文件系统**做 sha256+mtime 全树快照比对的
   zero-write 证明，**其第一条测试是承重的**：
   `it("is load-bearing: readOwnerRecord itself mutates the recovery fixture (brief step 1)")`，
   断言 `expect(after).not.toEqual(before)`，并附注
   「**If this fails, the fixture does not genuinely trigger recovery and the zero-write test
   below would prove nothing**」。

⇒ **「`readOwnerRecord` 会写」这件事，今天是 zero-write 证明的地基，不是它的敌人。**
这一点是下面两条路代价不对称的全部原因。

---

### 4.1 路 A —— **不动契约**（= 推荐的阶段 1）

**做法**：`readOwnerRecord` 照旧写，只是改成持锁写。

**牵动谁**：`src/persistence/fileStore.ts` 里 `recoverInterruptedOwnerTransfer` 的一个分支。
**就这一处。**

- `src/registry/**` —— 不碰。只读层绑的还是 `readOwnerRecordWithoutRecovery`，那个函数一个字不动。
- `src/controller/leaseGate.ts`、`leaseHeartbeat.ts` —— 不碰（它们也走 `WithoutRecovery`）。
- spec §7.1／§7.4／§12.1 —— **全部继续成立**，一个字不用改。
- `zeroWrite.test.ts:190` 承重测试 —— **继续绿**：fixture 里没有锁文件，
  `acquireOwnerTransferLock` 的 `open(wx)` 直接成功，finalize 照常发生，
  `after !== before` 照样成立，三个 staging 照样消失，`currentOwnerEpoch` 照样变 2。

**代价 / 残留**：

1. **契约的脆弱性原样保留。** 「只读层不许绑 `readOwnerRecord`」仍然是一条**人工纪律**，
   靠一条注释 + 一条测试守。第 16 个调用点仍然可能绑错。路 A 不减少这个风险。
2. **读仍然会写**，于是读仍然可能：因为要取锁而被别的进程阻住（阶段 1 下变成「直接放弃恢复」，
   不阻塞，但**恢复被推迟**）；在只读语境里产生 I/O。
3. ⚠️ **一个我必须点名的新副作用**：阶段 1 让读路径**创建并删除一个锁文件**。
   在 G0（今天完全不碰锁）这一格上，这是**新增的两次文件系统写**。
   对 `zeroWrite.test.ts` 的第二条测试无影响（它走 `WithoutRecovery`，到不了这里），
   但**任何对 run 目录做「精确文件集合」断言、且其 fixture 会触发 recovery-on-read 的测试
   都可能因此变红**。我**没有**逐条枚举这类测试（见 §9），这是路 A 的主要未知代价。
4. **口子没关严**（§3.4）。

**是否触碰 Human ruling 产物**：**否**。见 §7.3。

---

### 4.2 路 B —— **动契约**：`readOwnerRecord` 变成纯读

**做法**：`readOwnerRecord` 不再调 `recoverInterruptedOwnerTransfer`；恢复只发生在
已经持锁的三个写路径（`writeOwnerTransferArtifacts` / `claimOwnerRecordWithPrecondition` /
`updateOwnerRecordWithPrecondition`）。契约从「只读层不许绑那个写者」升级成
「**没有写者可绑，读按构造不写**」。

**它买到什么（这是真正的终局，必须说清）**：

- **P-READ 按构造不存在**。G0/G1/G2/G3 整个格子塌掉，`:1025` 那个无锁 finalize 调用点消失。
- `finalizePendingOwnerTransfer` 的**两个**调用点都在锁内，「安全性来自调用者持锁」
  这句话第一次成为**结构性事实**而非纪律。
- `readOwnerRecordWithoutRecovery` / `readOwnerRecord` 的**二分本身可以退役**，
  「绑错 reader」这一类错误从此不可能。

**牵动谁（代价，逐条）**：

1. ⚠️ **`tests/registry/zeroWrite.test.ts:190` 那条承重测试按构造变红**，
   而且是**最坏的一种红**：它断言的是「`readOwnerRecord` 确实会改动 fixture」。
   路 B 之后这句话为假。**不能靠改断言糊过去**——那条测试的存在意义是证明
   「zero-write 的第二条测试有牙」；一旦没有任何 reader 会触发 recovery，
   **第二条测试就失去了它要防的那个东西**，整套 §7.1 装置（`defaultObserveDeps` 的
   Never-bind 注释、`readOwnerRecordWithoutRecovery` 的存在理由、spec §7.4）
   同时变成死重。**这不是改一条测试，这是退役一节 spec。**
2. **语义变化，有产品后果**：今天任何进程的一次普通 `readOwnerRecord` 都会**顺手治好**
   一次被中断的转移。路 B 之后，一个转移被中断的 run 会**一直保持中断**，
   直到有进程去做 claim／transfer／heartbeat。而 `runLoop.ts:794`/`:872` 与
   `resumeLoop.ts:137` 今天拿到的是**恢复后**的 owner record；路 B 之后它们会看到
   **finalize 前**的内容（旧 epoch + 磁盘上挂着 marker）。`resumeLoop` 的
   eligibility 判定就建立在这条记录上 ⇒ **一个本该可续的 run 可能被按陈旧所有权判定**。
   ⚠️ 我**没有**追完 `evaluateResumeEligibility` 的八条判据来定这个后果的严重程度，
   记为**无法判定**（§9）。
3. **估计变红的既有判据（估计，未跑）**，`tests/persistence/fileStore.test.ts` 内
   标题里就写着 on read / before reading 的至少 7 条：
   `:230` recovers an interrupted owner transfer publish **on the next owner-record read**、
   `:282` finalizes a v2 marker … **on read**、`:357` finalizes in the order the v2 marker declares
   （经 `readOwnerRecord`）、`:418`／`:489`／`:538`（三条 fail-closed 抛，都由
   `await expect(readOwnerRecord(runDir)).rejects…` 断言）、
   `:998` reconciles a stale transfer lock with pending artifacts **before reading owner-record.json**；
   加 `zeroWrite.test.ts:190`。**≥8 条**，全部是**具名判据**。
4. **人裁 13／14 一条都不 cover 这些**（progress.md 明写人裁 13 只针对第 4 笔那一条判据，
   且「**明写不得援引到本任务**」）。⇒ 路 B 需要为这 ≥8 条**逐条**申请人裁。
5. 改动面：`fileStore.ts` + `registry/` + `docs/superpowers/specs/2026-07-28-run-registry-design.md`
   + 上述测试。**比路 A 大一个量级**，这与台账「规模比原文描述大一个量级」的记载一致。

**是否触碰 Human ruling 产物**：**间接触碰**——它退役的是 spec §7.1／§7.4 的装置，
而 §7.4 逐字写着 “must not be refactored to accommodate one”。这句话管的是 `checkRunLease`，
不是 `readOwnerRecord`，**所以严格说路 B 不违反它的字面**；但路 B 会让它变得无的放矢。
⚠️ 这一条我判**无法确定它算不算「触碰既有人裁产物」**，交人裁自己认。

---

### 4.3 两条路的关系（我的立场，以及反对我的理由）

- 路 A **不是**路 B 的替代品，是**路 B 的前置**：路 A 落地后，P-READ 的**后果**（并发 finalize
  的数据丢失）已经被消掉，剩下的只是「读仍然会写」这一**结构性丑陋**。
  路 B 之后再看，路 A 那几行会被整段删掉——**是白工，但很短的白工**。
- **反对路 A 起步的理由（我如实摆出来）**：路 A 让 `readOwnerRecord` 变成
  「持锁的写者」，比今天**更像一个正当的写者**，因而**降低了未来推动路 B 的紧迫感**。
  如果人裁认为路 B 迟早要做，那么先做路 A 等于给一条注定要删的路径追加投资，
  还多引入 §4.1 代价 3 那个「读路径新增锁文件读写」的副作用。
- **反对路 B 立刻做的理由**：≥8 条具名判据 + 一节 spec + 一个我判不了的 resume 语义后果，
  在本包已经背着 1 Critical / 6 Important 的情况下，**不该塞进同一个修复环**。

## 5. 与任务 2 守卫（`foreignOwnerOf`）的关系

⚠️ **本节以 HEAD `574e275` 的 `foreignOwnerOf` / `persistTerminalState` 为准。**
我在工作过程中两次看到工作树里这两个函数被改成不同形状（一次整段删掉守卫并留下
`REVIEW_MUTATION_MARKER`，一次改成「守卫上移到顶部 + 非 ENOENT 外抛」）。
**这是并发评审员的临时变异，未归因，不是我的发现，也不是本方案的依据。**

### 5.1 重叠？—— **不重叠，零交集**

| | 任务 2 守卫 | 本任务（第 1 笔 / P-READ） |
|---|---|---|
| 保护的写者 | `persistTerminalState` 里的 **`writeRunState`** | **`finalizePendingOwnerTransfer`** 的三次 rename |
| 保护的文件 | `loop-state.json` | `owner-record.json` / `owner-transfer.json` / `reconciliation-record.json` |
| 防的坏事 | 非所有者把别人的 run 写成 `cancelled`（死胡同） | 两个 finalizer 并发抢固定 temp 名 → 发布出无人 stage 过的组合 |
| 判据 | 「磁盘上的 owner 是不是别人」 | 「此刻我是不是唯一的 finalizer」 |

两者**保护的文件不相交、判据不相同**。任务 2 的守卫**不会**、也**不应该**顺手挡住 P-READ。

### 5.2 冲突？—— **没有冲突，而且是刻意设计成不冲突的**

`foreignOwnerOf` 用的是 **`readOwnerRecordWithoutRecovery`**，其注释逐字说明了原因：
「Reads RAW, for leaseGate's §7.1 reason: `readOwnerRecord` runs `recoverInterruptedOwnerTransfer`
first, and **a refusal to write must not trigger crash recovery as its side effect**」。

⇒ 任务 2 的守卫**按设计就在 P-READ 路径之外**。

- **路 A（阶段 1）与它零交互**：阶段 1 只改 `recoverInterruptedOwnerTransfer` 的无锁分支，
  `readOwnerRecordWithoutRecovery` 一个字不动 ⇒ 守卫的行为**逐位不变**。
- **路 B 与它也不冲突**，反而**加强**它：路 B 之后 `readOwnerRecord` 不再写，
  上面那句注释里的顾虑消失，`WithoutRecovery` 这个分身可以退役，
  `foreignOwnerOf` 直接读即可（但这是路 B 的连带收益，不是它的理由）。

### 5.3 能不能复用「只在正面识别出异己 id 时才拒绝」这个立场？

*** **不能直接搬，而且搬过去就是本任务要修的那个 bug。这是本节最要紧的一条。** ***

`foreignOwnerOf` 的立场是**失败开放**：读不出、解析不出 ⇒ `return null` ⇒ **不拒绝**。
它在**那个位置**是对的，理由在它自己的注释里（我核过 HEAD 版本）：

- 那个守卫**只会给一次本来就要发生的写「追加」一条拒绝**，从不减少安全性；
- 「读不出」这个情形**已经有主**了（`leaseHeartbeat` 用 `lease_unverifiable` 答它），
  守卫不该抢答；
- 在一个正在停止的 run 上因为读不出而拒绝，会把一次 stop **升级成 crash**。

而 `tryRecoverStaleOwnerTransferLock` 今天恰恰是**同一个立场**：
「`parsePid` 判不出 pid（`pid === null`）」⇒ **不认为持有者活着** ⇒ **删锁**。
但在**那个**位置，失败开放**摧毁的是别人的互斥**——它不是「追加一条拒绝」，
而是「撤销一条保护」。**同一个立场，一个位置上是安全的，另一个位置上就是 G2-null。**

⇒ 结论：**复用词汇，反转默认值。**
- 可复用的：把 `holderProcessInstanceId` 当**不透明串**、只做字符串相等比较、
  绝不从中反推语义 —— 这条纪律（`foreignOwnerOf` 注释 §5.1）在阶段 2 若真把
  process-instance id 放进锁记录时应当照抄。
- 必须反转的：**「识别不出 ⇒ 假定它活着 ⇒ 不动它的锁」**（失败关闭），
  而不是今天的「识别不出 ⇒ 当它死了 ⇒ 删掉」。

⚠️ **给未来评审员的一句话**：这两处看起来对称，**不许「统一」它们**。
`fileStore.ts` 里已经有一条同类警告（`ATOMIC_TEMP_PROCESS_STAMP` 上方那段
「do not "unify" it with this one」），本条是它的姊妹条，方向相反：
那条护的是「弱形式别被换成强形式」，本条护的是「弱形式的失败默认别被抄成开放」。

## 6. 分阶段方案

**有一个小而独立、今天就能安全落地的子集，就是阶段 1。** 大裁决（路 B、失败关闭）留给以后。

### 阶段 1 —— 让无锁 finalize 变成持锁 finalize　【推荐今天做】

- **改动面**：`src/persistence/fileStore.ts` 一个函数的一个分支
  （`recoverInterruptedOwnerTransfer` 的 `!lockHeld` 臂）。形状见 §3.3。
- **独立性**：不依赖阶段 2，不依赖路 B，不依赖任务 2。**可以单独 revert。**
- **不动**：`readOwnerRecordWithoutRecovery`、`registry/`、`leaseGate`、`leaseHeartbeat`、
  任何 spec、任何 Human ruling 产物、`tryRecoverStaleOwnerTransferLock` 的判活逻辑。
- **需要人裁吗**：⚠️ 我判**不需要新的人裁**，因为它不推翻任何既有判据的**断言内容**
  （见 §7.1 逐条过）。但**这是我的判断，且我没有跑测试验证**（§9）。
  若实施者跑完发现有判据变红，**那条就必须单独交人裁，不得自行改断言**。
- **新判据（该加的）**：至少一条——「两个并发的 `readOwnerRecord` 在同一个 marker 上，
  只有一个会 finalize，另一个不写」。⚠️ 这条测试**怎么写才不是自证**需要设计
  （Node 单线程，得靠对 `finalizePendingOwnerTransfer` 或 `open` 打点交错），
  我**没有**把它设计出来（§9）。

### 阶段 2 —— 把锁真正变成不可偷　【需人裁点 B / C】

两个**互相独立**的子项，可分别裁：

- **2a：`parsePid` 判不出 pid 时失败关闭。**
  `pid === null` ⇒ 视为「持有者可能活着」⇒ `return false`（busy），而不是落到 `safeUnlink`。
  **关掉 G2-null。** 改动极小（一个分支）。
  ⚠️ **代价**：见 §7.2，会推翻两条同名既有判据。
- **2b：消灭零长度锁窗口。**
  今天 `open(lockPath,"wx")` 与 `handle.writeFile(...)` 之间锁文件长度为 0，
  这是 G3'（也是 §13 第 1 笔原文六步构造）的物理成因。
  两种做法：(i) 写临时文件 + `link(temp, lockPath)`（`link` 在目标存在时原子地失败于 EEXIST，
  是 POSIX 里「排他创建且带内容」的标准写法）；(ii) 保留 `open(wx)`，但把
  「JSON 解析失败」一律当作**忙**（因为解析失败要么是活持有者写到一半，要么是真损坏，
  两者都不该由一个旁观者裁定）。
  ⚠️ (ii) 更小但会把「真损坏的锁」变成永久卡死 ⇒ **人裁点 C**。
  (i) 更正确但换掉了取锁原语，回归面更大。**我不替人裁在 (i)/(ii) 之间选。**

### 阶段 3 —— 路 B（`readOwnerRecord` 变纯读）　【需人裁点 A，且不该与阶段 1/2 同环】

代价见 §4.2。**建议单独成包**。

### 依赖关系

```
阶段 1  ── 独立，可单独落地、单独 revert
阶段 2a ── 独立于阶段 1（但阶段 1 之后它的收益才明显：那时锁是真的在被"持有"）
阶段 2b ── 独立于 2a
阶段 3  ── 落地后阶段 1 的那几行会被整段删除（短白工，见 §4.3）
```

## 7. 每个方案的代价与风险（含 Human ruling 产物）

⚠️ *** 本节所有「会不会变红」**全部是估计，我一条测试都没跑**（原因见 §9：
工作树正在被并发变异，跑出来的红绿不可归因）。 ***

### 7.1 阶段 1 的代价

**改动面**：1 个文件、1 个函数、1 个分支。

**逐条过我能想到的高风险既有判据**（估计）：

| 判据（符号／标题定位） | 今天的行为 | 阶段 1 后 | 估计 |
|---|---|---|---|
| `fileStore.test.ts` `it("keeps a live lock in place when recovery cannot yet proceed")` | 活锁 → `tryRecover` false → return，锁留着 | 取锁 → EEXIST → `tryRecover` false → `LockBusy` → catch → return，锁留着 | **绿**（终态相同） |
| `fileStore.test.ts` `it("reconciles a stale transfer lock with pending artifacts before reading owner-record.json")` | 陈旧锁 → 删 → 无锁 finalize | 取锁 → EEXIST → `tryRecover` 删锁 → 重试 `open(wx)` 成功 → 持锁 finalize → 释放（再删） | **绿**（终态：锁不在、三文件已发布） |
| `fileStore.test.ts` `it("treats malformed lock contents with staged artifacts as stale and recoverable")`（**两处同名**） | 同上 | 同上 | **绿**（阶段 1 不改判活；2a 才改，见 7.2） |
| `fileStore.test.ts` `it("recovers an interrupted owner transfer publish on the next owner-record read")` / `it("finalizes a v2 marker … on read")` / `:357` | 无锁 → finalize | `open(wx)` 成功 → 持锁 finalize | **绿** |
| `fileStore.test.ts` `:418` / `:489` / `:538`（三条 `await expect(readOwnerRecord(...)).rejects.toBeInstanceOf(…)`） | finalize 抛，直接外传 | finalize 抛，经 `finally` 释放锁后**同类外传** | **绿**（前提：§3.3 那条「只在取锁一步宽 catch」被遵守） |
| `runLoop.integration.test.ts` 「loser's `readOwnerRecord` must find that live lock and decline to finalize P1's transaction」 | 活锁 → 不 finalize | `LockBusy` → 不 finalize | **绿** |
| `leaseLifecycle.integration.test.ts` `it("refuses persistBoundaryAnalysis before readOwnerRecord can finalize a staged transfer, once superseded")` | 上游就挡住了，到不了 recovery | 同 | **绿** |
| `leaseStore.test.ts` `it("does not finalize a staged transfer the way readOwnerRecord would")` | 测 `WithoutRecovery` | 不动 | **绿** |
| `zeroWrite.test.ts:190` 承重测试 | `readOwnerRecord` 改动 fixture | 仍改动（fixture 无锁 → 取锁成功 → finalize） | **绿** |

⚠️ **我判不了的一类**：任何**对 run 目录做精确文件集合／全树快照断言、且其 fixture 会触发
recovery-on-read** 的测试。阶段 1 在读路径上**新增了一次锁文件的创建与删除**。
若某个断言在 finalize **进行中**取快照，会多看到 `.owner-transfer.lock`。
**我没有枚举这类测试** ⇒ 记为 **无法判定**（§9）。这是阶段 1 唯一的主要未知代价。

**Human ruling 产物**：**未触碰**。见 §7.3。

**新增风险**：
1. 若实施者忘了「取锁失败一律 return，不外抛」，`readOwnerRecord` 会获得一类新的失败模式
   （EACCES/ENOSPC 从读里冒出来），并被 `runLoopFromState` 外层 catch 判成 attempt 失败。
   **这是阶段 1 最容易做错的一步。**
2. 若忘了 `finally { lock.release() }`，一次 finalize 失败就永久留下无主锁，
   **把 G0 从偶发变成必然**——比不改还糟。

### 7.2 阶段 2a 的代价（人裁点 B 的正文）

⚠️ *** 阶段 2a **必然**推翻两条既有具名判据，且**人裁 13／14 都不 cover 它们**。 ***

`tests/persistence/fileStore.test.ts` 有**两处同名**测试：
`it("treats malformed lock contents with staged artifacts as stale and recoverable")`
（一处在 owner-transfer 一族，一处在 claim/update 一族）。
它们**逐字断言现行的失败开放行为**：锁内容畸形 + 有 staging ⇒ **可回收**。

阶段 2a 的整个内容就是「不再那么认为」。⇒ 这两条**按定义变红，且不能靠改断言糊过去**
——改断言就是改判据。**必须逐条交人裁。**

配套还有一处需一起裁：
`it("keeps a malformed lock without staged artifacts non-recoverable")`（同样两处）——
2a 之后「有没有 staging」**不再是判别式**（§2.5：在 recovery 路径上它恒真，本来就筛不掉东西），
这两条测试的**前提**随之失效，即使断言碰巧还成立，它们也不再在测它们标题说的那件事。
⚠️ 这一条我判**无法确定它算不算「变红」**，但它算「判据语义被抽空」，一并交人裁更稳。

**人裁点 C**：2a（以及 2b(ii)）之后，一把「死进程留下的、内容损坏的锁」将**永久卡死**
该 run 的一切转移／心跳／claim。今天这种锁会被自动清掉（代价就是可偷）。
**要不要逃生口**，是人裁必须一并回答的，否则 2a 是用一个死锁换一个数据丢失。

### 7.3 Human ruling 产物核对（逐条，按铁律不外推）

本仓库我确认到的 Human ruling 产物有两处与本任务相邻：

1. **2026-08-02 的那次 ruling**，产物是 `fileStore.ts` 里
   `transferRepresentsPublishedWinner` 上方那整段注释所描述的行为
   （clause (b) 保留、`shouldProtectSuccessfulTransferTruth` 的形状、
   `describePublishedWinnerReplacement` 这个信号）。
   ⇒ **阶段 1 / 2a / 2b 全部不触碰它**：它们只改锁与 recovery 的互斥，
   不改 `preserveSuccessfulReconciliationIfNeeded` 一族的任何判定。
   ⚠️ **但路 B 会间接影响它**：`readPersistedSuccessfulTransferArtifacts` 里的
   `readOwnerRecord(runDir)`（`fileStore.ts:382`）在路 B 之后读到的是**未 finalize** 的
   owner record，`transferRepresentsPublishedWinner` 的 `currentOwnerEpoch === newOwnerEpoch`
   比较可能因此翻转。⇒ **路 B 需要把这条列进人裁材料**。我没有推完它会怎么翻，
   记为**无法判定**（§9）。
2. **人裁 13**（2026-08-07，第 4 笔／残余 TOCTOU 那条判据的扩权）。
   progress.md 逐字写着它「**只针对第 4 笔那一条，明写不得援引到本任务**」。
   ⇒ **本方案一处也不援引它。** 人裁 14 同理。

⇒ **阶段 1：不碰任何 Human ruling 产物。阶段 2a：不碰 ruling 产物，但要 3–4 条新的人裁。
路 B：碰 spec §7.1 装置，且可能间接牵动 2026-08-02 那次 ruling 的输入。**

## 8. 我用过的每条命令与它当时的输出（含 sanity 探针）

脚本全部先落盘到
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/85257637-5313-4289-ba1a-117ef66c7285/scratchpad/`，
再用 `rtk proxy zsh <script>` 跑。**输出一律未过滤**（未 `head`／未 `wc` 掉正文）。

### 探针 0（失败的一次，如实记）

```
$ grep -rn "acquireOwnerTransferLock" src/ tests/ --include=*.ts | wc -l
(eval):1: no matches found: --include=*.ts
       0
```
⚠️ **zsh 把 `--include=*.ts` 当 glob 展开了，探针本身坏掉，输出的 `0` 无意义。**
按纪律「零输出时先验命令本身」——已验出是命令坏，**未据此下任何结论**。
后续所有探针改为脚本落盘 + `rtk proxy zsh`，且不再用 `--include`。

### 探针 1（`probe1.sh`）—— 调用面

sanity：`grep -rn "tryRecoverStaleOwnerTransferLock" src` → 5 行命中（必命中，通过）。
输出见本轮转录，要点：
- `readOwnerRecord` 的 `src/` 调用点 = `runLoop.ts:794`、`runLoop.ts:872`、
  `resumeLoop.ts:137`、`fileStore.ts:382`（+ 定义处 `:1028`）。
- `readOwnerRecordWithoutRecovery` 绑定于 `leaseGate.ts:24`、`runLoop.ts:960`、
  `leaseHeartbeat.ts:166/:285`、`readObservedFile.ts:32/:44`。

### 探针 2（`probe2.sh`）—— `foreignOwnerOf` 与输入文档目录

sanity：`grep -rn "foreignOwnerOf" src tests` → 必命中，通过（`runLoop.ts:955`、`:1007`）。
⚠️ `:1007` 当时是 `void foreignOwnerOf;` —— **这一条把并发变异暴露了出来**，见探针 3。

### 探针 3（`probe3.sh`）—— 隔离并发变异　【关键】

sanity：`git rev-parse --short HEAD` → `574e275`（必命中，通过）。

```
$ git diff --stat HEAD -- src tests
 src/controller/runLoop.ts | 12 ++----------
 1 file changed, 2 insertions(+), 10 deletions(-)
```
diff 显示 `persistTerminalState` 里任务 2 的守卫被整段删除，替换为
`// REVIEW_MUTATION_MARKER guard removed entirely` + `void foreignOwnerOf;`。

⇒ *** **这是并发评审员的临时代码变异，未归因，不计为我的发现。**
基线切到 HEAD `574e275`。 ***

### 探针 4（`probe4.sh`）—— 承重断言的独立重核

**双向 sanity**：
```
### SANITY A: this grep MUST return >=1 line ###
src/persistence/fileStore.ts:935:async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
### SANITY B: this grep MUST return 0 lines (nonsense token) ###
(correctly empty)
```
两条都如预期 ⇒ grep 面本身可信，下面的「只有 N 处」才有意义。

```
### CLAIM 1: every acquireOwnerTransferLock call site in ALL of src ###
src/persistence/fileStore.ts:820:async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
src/persistence/fileStore.ts:1040:  const lock = await acquireOwnerTransferLock(runDir);
src/persistence/fileStore.ts:1083:  const lock = await acquireOwnerTransferLock(runDir);
src/persistence/fileStore.ts:1132:  const lock = await acquireOwnerTransferLock(runDir);

### CLAIM 2: every isProcessActive call site in ALL of src ###
src/persistence/fileStore.ts:770:function isProcessActive(pid: number): boolean {
src/persistence/fileStore.ts:802:    if (pid !== null && isProcessActive(pid)) {

### CLAIM 3: every rename( call site in ALL of src ###
src/persistence/fileStore.ts:649:    await rename(tempPath, path);
src/persistence/fileStore.ts:995:      await rename(entry.tempPath, entry.targetPath);
src/persistence/fileStore.ts:1111:  await rename(ownerTempPath, ownerPath);
src/persistence/fileStore.ts:1123:  await rename(tempPath, targetPath);

### CLAIM 4: every finalizePendingOwnerTransfer call site in ALL of src ###
… src/persistence/fileStore.ts:935（定义）/ :1025 / :1072

### CLAIM 5: every recoverInterruptedOwnerTransfer call site in ALL of src ###
… src/persistence/fileStore.ts:1011（定义）/ :1029（无 options）/ :1043 / :1086 / :1135（三处 lockHeld: true）

### CLAIM 6: every parsePid site ###
src/persistence/fileStore.ts:765:function parsePid(processInstanceId: string): number | null {
src/persistence/fileStore.ts:800:    const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
```

⇒ §2.3／§2.4／§2.5／§2.6 的四条承重断言**在今天的代码上独立成立**，
**不是照抄 `close-2-recovery-path.md`**（该报告的行号已漂移约 4 行，符号名一致）。

### 探针 5（`probe5.sh`）—— 二次核对并发变异　【关键】

sanity：`date -u` → `Sun Aug  9 02:09:49 UTC 2026`；`git rev-parse --short HEAD` → `574e275`。

⚠️ *** 工作树**在探针 3 与探针 5 之间又变了一次**：`REVIEW_MUTATION_MARKER` 已消失，
`foreignOwnerOf` / `persistTerminalState` 变成了另一个形状
（守卫上移到 `transitionRunState` 之前、非 ENOENT 改为外抛、拒绝时 `return state`）。 ***
⇒ **同一 worktree 里的 `src/` 正在被持续改动。所有测试结果均不可归因，故一条未跑。**
本方案全部锚定 HEAD `574e275`。

### 探针 6（`probe6.sh`）—— L1/L2 契约的承载物

sanity：`wc -l tests/registry/zeroWrite.test.ts` → 829（必命中，通过）。
取得 §4.0 引用的四处逐字文本（`defaultObserveDeps` 的 Never-bind 注释、
zeroWrite 的承重测试头注、run-registry-design.md §7.4）。

### 探针 7（`probe7.sh`）—— 受影响判据清单

sanity：`grep -n "is load-bearing: readOwnerRecord itself mutates"` → `:190`（必命中，通过）。
取得 §7.1 表格与 §4.2 第 3 条所列的测试标题清单（`fileStore.test.ts` 的
`it("...")` 全量按关键词筛出 29 条，未过滤原始输出）。

### 探针 8（`probe8.sh`）—— G2-null 措辞与人裁边界

sanity：`wc -l progress.md` → 358（必命中，通过）。
- 取得 progress.md §5 对 G2-null 的**收紧措辞**（没被钉住的是「`parsePid` 与该形式的不匹配」，
  **不是**「该形式无人断言」）。
- 取得 progress.md 关于**人裁 13 只针对第 4 笔、不得援引到本任务**的逐字记载。
- 取得 `pid:<pid>:<origin>` 形式在 `tests/` 里的逐字断言（`processIdentity.test.ts:9/:19/:20`），
  与 `pid:<pid>` 弱形式在 6 个测试文件里的 fixture 用法。

### 我**没有**跑的命令（以及为什么）

- `./node_modules/.bin/vitest` —— **一次都没跑**。理由：探针 3 与 5 证明 `src/` 正在被
  并发变异，任何红都不可归因；brief 也明令不要跑会被干扰的验证。
- `./node_modules/.bin/tsc` —— 同上，且本任务不产出代码，无可编译物。

## 9. 我没有验到的部分

*** 逐条如实列。凡我判不了的，写「无法判定」，不硬下。 ***

1. **一条测试都没跑**（vitest、tsc 均未执行）。理由见 §8 末。
   ⇒ **§7 全部的「绿/红」都是静态推演，不是实测。**
2. **P-READ 的并发终态没有实测复现。** §3.2 里「两个 finalizer 抢固定 temp 名 →
   发布出无人 stage 过的组合 / 三文件组不一致」是**对今天代码的静态推演**。
   我没有写复现脚本（写了也会被并发变异污染）。**未实测。**
3. **阶段 1 新增的「读路径创建并删除锁文件」会不会弄红既有测试 —— 无法判定。**
   我没有枚举「对 run 目录做精确文件集合／全树快照断言、且 fixture 会触发 recovery-on-read」
   的测试集合。这是阶段 1 唯一的主要未知代价，**实施者必须先枚举再动手**。
4. **路 B 对 `resumeLoop` 语义的后果 —— 无法判定。** 我没有读完
   `evaluateResumeEligibility` 的八条判据，因此说不出「resume 拿到未 finalize 的
   owner record」到底会不会改变可续判定。§4.2 只说了它**可能**改变。
5. **路 B 对 2026-08-02 那次 Human ruling 的间接影响 —— 无法判定。**
   `fileStore.ts:382` 的 `readOwnerRecord` 在路 B 之后读到未 finalize 的记录，
   `transferRepresentsPublishedWinner` 的 epoch 比较可能翻转。**我没有推完它会怎么翻。**
6. **阶段 2b 的 (i)/(ii) 我没有选，也没有验证 `link()` 在本仓库目标平台
   （darwin / 各种挂载）上的行为。** 只给出了两条路和各自的方向性代价。
7. **阶段 1 的新判据我没有设计出来。** 「两个并发 `readOwnerRecord` 只有一个 finalize」
   这条测试在 Node 单线程下怎么写才**不是自证**（需要对 `open` 或
   `finalizePendingOwnerTransfer` 打点制造交错），我没做。
8. **`close-2-recovery-path.md` 的 §2.5／§4.2／§5.x／§6／§7 我没有逐节重核。**
   我重核的是**承重的那几条**（§1.1 四格、§2.1 调用链无重取锁、§3.2/3.3 P-READ 进入条件、
   §4.1 rename 面），方法是 §8 探针 4 的独立 grep。**其余章节我按线索用，未验证。**
9. **`scan-A-debt2-lock-abort.md` 的六步构造原文我没有逐字读。**
   我独立从 `acquireOwnerTransferLock` 的 `open(wx)` + `handle.writeFile` 两步结构
   重推出了零长度窗口这个物理成因（§3.4 G3'），但**没有与原文六步逐条对齐**。
10. **我没有核对 `docs/` 里除 run-registry-design.md §7.1/§7.4 之外的 spec**
    是否还有别的地方钉住了 recovery-on-read 行为。路 B 的 spec 影响面**可能比 §4.2 列的更大**。
11. **并发变异的完整清单我没有掌握。** 我只在两个时刻（探针 3、探针 5）各拍了一次
    `git diff HEAD`，两次内容不同。**在这两次之间和之后还发生过什么，我不知道。**
    ⇒ 若 §7 的任何判断与实际测试结果冲突，**以实测为准，并先排除并发变异**。

## 10. 预算记账

**上限：100,000 tokens（Rule 6，每任务）。**

| 项 | 估计 tokens |
|---|---|
| brief + 目录列举 | ~4,000 |
| `src/persistence/fileStore.ts` 全文读（1223 行，本任务的核心） | ~17,000 |
| 探针 1（调用面，未过滤输出，量大） | ~9,000 |
| 探针 2 / 3 / 4 / 5（含两次并发变异 diff） | ~11,000 |
| `src/controller/runLoop.ts` 片段 + `readObservedFile.ts` 全文 | ~4,000 |
| `close-2-recovery-path.md` 选读三节（§1.1–1.2、§2.1–2.3、§3.2–4.1） | ~7,000 |
| 探针 6 / 7 / 8 | ~7,000 |
| 报告撰写（骨架 + 10 节 Edit） | ~22,000 |
| 思考与协调开销 | ~14,000 |
| **合计（估计）** | **~95,000** |

⇒ **在 100,000 上限之内，但余量很小（约 5%）。未破。**

**省下预算的两个做法**（如实记，供后续任务复用）：
1. **没有通读 `close-2-recovery-path.md`（875 行）**，只按 brief 指示选读了承重三节。
   上一轮实施者正是因为通读必读材料破了预算。
2. **一条测试都没跑** —— 本来就被 brief 禁止（并发变异），顺带省下了大笔输出预算。

**如果人裁选路 B**，请注意：路 B 的材料准备（≥8 条判据逐条论证 + spec §7.1 装置退役方案 +
`evaluateResumeEligibility` 八条判据的重推）**明显超出单个 100,000 任务预算**，
建议单独成包并单独记账。
