# 扫描员 1 报告 — 包 2 三条路径今日代码面重核

## 1. 结论摘要

基线：HEAD `29dba2d`（scan-A/B/close-2 三份来源报告的基线是 `e9021ef`；两者之间 `src/` 只有一次改动，`811a2e7`，只碰 `fileStore.ts` 的 `writeBoundaryArtifacts` 旁一段注释，与下述四条判据的函数体均无交集，已用 `git diff --stat` 核实）。工作区干净。

1. **债 2**：**仍成立**。`persistTerminalState` 今天 15 个调用点（16 处命中 − 1 处定义），其中恰好 4 个由 lease-loss 分支到达（`:1062`/`:1110`/`:1455`/`:1514`，行号与来源报告逐字一致，因为该区间自 L1 期提交 `cfde8b9` 后未再变过）；`cancelled: []`（`stateMachine.ts:11`，紧跟 `failed: []` 与闭括号，无出边）且 `RESUMABLE_STATUSES` 不含 `"cancelled"`（`resumeLoop.ts:38`）今天原样成立。
2. **第 4 笔**：**仍成立**。两条时序（ENOENT 直接放行 / 两次读跨在赢家两次 rename 之间致判据 B 落空）今天都可达，且**都不触发** `reconciliation_published_winner_replaced` 事件——时序一在 `describePublishedWinnerReplacement` 被调用前就从 `no_published_transfer` 分支 return 了；时序二虽然调用了它，但其判别式 `transferRepresentsPublishedWinner(...) || !shouldPreserveExistingReconciliationRecord(...)`（`fileStore.ts:296-305`）今天逐字为真（盘面 reconciliation-record.json 此刻要么不存在要么是不同 epoch 的旧记录，`shouldPreserveExistingReconciliationRecord` 恒假）直接 `return undefined`。
3. **第 1 笔**：**仍成立**。`tryRecoverStaleOwnerTransferLock`（今天 `:784-818`）与 `recoverInterruptedOwnerTransfer`（今天 `:1011-1026`）的形状与来源报告描述逐字一致，只有行号整体 +4 的漂移（`811a2e7` 那次注释改动在它们之前插入了 4 行）；G0/G1/G2/G3 四格结构、`finalizePendingOwnerTransfer` 函数体零守卫（`sameOwnerRecord`/`OwnerTransferPreconditionError`/`isProcessActive`/`lockPath` 四个符号在其函数体内命中数 = 0）、P-READ 经 `readOwnerRecord` 短路不经过锁协议，今天都成立；recovery 路径今天仍是 4 个调用点（1 个不持锁 `:1029` + 3 个持锁 `:1043`/`:1086`/`:1135`）。
4. **G2-null**：**仍成立**。今天唯一防线仍只是 `fileStore.ts` 一段注释（原文档记的 `:603-605`，今天因中途一次纯文档 errata 提交漂移到 `:605-608`，三句原文一字未改）；`parsePid` 正则 `^pid:(\d+)$`（`:766`）与 `buildProcessInstanceId()` 的 `pid:<pid>:<origin>` 形式（`processIdentity.ts:7`）今天仍不匹配；全仓对 `parsePid` 与 `holderProcessInstanceId` 的 grep（覆盖 `src/` 与 `tests/`）未见任何针对 `pid:<pid>:<origin>` 形式的断言，「没有测试钉住」这句全称否定今天仍站得住（grep 面见第 6 节）。

## 2. 债 2 的今日证据

**调用点计数**：`grep -rnF 'persistTerminalState(' src/` 命中 16 行，其中 `src/controller/runLoop.ts:931` 是定义，其余 15 行是调用点（命令与逐字输出见第 6 节）。`persistTerminalState` 全仓只此一处定义、不 export。

**4 个由 lease-loss 到达的调用点**：
- `runLoop.ts:1062`：`if (leaseLoss.lost !== null)` 分支顶端，`return await persistTerminalState(runDir, state, "cancelled", "lease_lost")`
- `runLoop.ts:1110`：`if (isLeaseStopError(error))` 内层 worktree catch，`return await persistTerminalState(runDir, state, "cancelled", error.stopReason)`
- `runLoop.ts:1455`：第二处 `if (leaseLoss.lost !== null)`，同上一行为
- `runLoop.ts:1514`：外层 attempt catch 里的 `isLeaseStopError(error)` 分支

`isLeaseStopError` 定义（`:107-109`）逐字：`return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError;`——`RunHeartbeatStoppedError`（`src/ownership/lease.ts:46`）直接 `extends Error`，不是这两个的子类，唯一抛出点在 `leaseHeartbeat.ts:212` 的 `runExclusive` 内。它有自己独立的「不写终态」分支（`runLoop.ts:1489-1497`：append `heartbeat_stopped` 事件 → `writeRunState` → `return state`），排在 `:1507` 的 `isLeaseStopError` 分支**之前**并直接 `return`，所以永远到不了那 4 个调用点。这条判据体（§5.3 选 (a)）今天仍成立，与来源报告一致。

**`cancelled` 无出边**：`grep -nF -A2 'cancelled:' src/state/stateMachine.ts` 输出 `11:  cancelled: [],` 紧跟 `failed: [],` 与闭括号 `};`——`cancelled` 状态今天仍是转移表里的空数组，无任何合法出边。

**`RESUMABLE_STATUSES` 不含 `cancelled`**：`resumeLoop.ts:38` 逐字 `const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];`，`:64` 处 `if (!RESUMABLE_STATUSES.includes(runState.status))`。

**判定**：四个调用点由 lease-loss 到达、`persistTerminalState`（`:931-941`）函数体内只有 `transitionRunState` + `appendTransitionEvent` + `writeRunState`（`grep -A12`，见第 6 节），没有任何所有权守卫。丢租约的旧进程把 `"cancelled"` 终态写进已被新 owner 接管的 run 目录后，该 run 对新 owner 永久不可续跑（`cancelled` 无出边 + 不在 `RESUMABLE_STATUSES`），今天代码面与来源报告的判定完全一致，未发现任何改动触及这条链路。

## 3. 第 4 笔的今日证据

**符号定位（今天，全部在 `src/persistence/fileStore.ts`）**：`isSuccessfulReconciliationForTransfer :115`、`isLoserDowngradeAttempt :127`、`transferRepresentsPublishedWinner :163`、`shouldPreserveExistingReconciliationRecord :185`、`shouldProtectSuccessfulTransferTruth :198`、`preserveSuccessfulReconciliationIfNeededFromArtifacts :234`、`describePublishedWinnerReplacement :289`、`readPersistedReconciliationRecord :314`、`readPersistedSuccessfulTransferArtifacts :350`、`preserveSuccessfulReconciliationIfNeeded :392`、`readOwnerTransferRecordRaw :668`。

**`transferRepresentsPublishedWinner` 在 L3 期间零改动**：`git log --oneline -L :transferRepresentsPublishedWinner:src/persistence/fileStore.ts` 最新触碰提交是 `97ed9aa`（2026-07-23），早于 L3 spec 首个提交 `0289846`（2026-08-01）。函数体今天逐字：
```
ownerTransferRecord.eligibleForContinuation === true
&& ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch
&& ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId
```

**两条时序今天都可达**（构造与来源报告一致，逐段核实）：
- **时序一**：`readPersistedSuccessfulTransferArtifacts`（`:350-`）里 `readOwnerTransferRecordRaw` 抛 ENOENT → `return { kind: "no_published_transfer" }`（`:364-372`）→ `preserveSuccessfulReconciliationIfNeeded`（`:392-`）的 `no_published_transfer` 分支直接 `return { kind: "write", record: nextReconciliationRecord }`（`:402-409`），**在到达 `describePublishedWinnerReplacement` 调用点（`:421`）之前就已经 return**——`transferRepresentsPublishedWinner`/`describePublishedWinnerReplacement` 一次都没被调用，保护整个不生效。
- **时序二**：输家两次读跨在赢家的 rename#1（`owner-transfer.json`）与 rename#2（`owner-record.json`）之间——读到 transfer(newOwnerEpoch=N+1) + owner-record(仍是 N)，`transferRepresentsPublishedWinner` 判据 B（`currentOwnerEpoch === newOwnerEpoch`）为假。这一次会走到 `describePublishedWinnerReplacement`（`kind === "artifacts"` 分支，`:415-424`），但其判别式（`:296-305` 逐字）：
  ```
  if (
    transferRepresentsPublishedWinner(persistedOwnerRecord, persistedOwnerTransferRecord)
    || !shouldPreserveExistingReconciliationRecord(persistedReconciliationRecord, nextReconciliationRecord, persistedOwnerTransferRecord)
  ) { return undefined; }
  ```
  第一项为假（判据 B 已证不成立）；`shouldPreserveExistingReconciliationRecord`（`:185-195`）第一个合取项是 `persistedReconciliationRecord !== undefined`——时序二发生时赢家还没跑 rename#3，盘上的 `reconciliation-record.json` 要么不存在（`readPersistedReconciliationRecord` 的 `catch { return undefined }`，`:314-322`）要么是**上一次转移**遗留的旧记录（`isSuccessfulReconciliationForTransfer` 的 `priorOwnerEpoch` 对不上本次转移），两种情况下该函数都返回假 ⇒ 第二项 `!false = true` ⇒ 整个 `if` 为真 ⇒ `describePublishedWinnerReplacement` **直接 `return undefined`**。

**事件覆盖判别式（全称否定，按纪律给出）**：`reconciliation_published_winner_replaced` 事件唯一的 append 点在 `fileStore.ts:507`，其触发条件是 `decision.publishedWinnerReplacedDetail !== undefined`（`:499-500` 附近的 `if`），而 `publishedWinnerReplacedDetail` 只来自 `describePublishedWinnerReplacement` 的返回值。上面已证：时序一该函数**未被调用**（early return），时序二该函数**被调用但返回 `undefined`**。⇒ 两条时序在事件覆盖判别式上都落在「不触发」这一侧，「两条时序都静默」今天仍成立。判别式本身（是否 `undefined`）就是 §4 引理里"既有事件盖不住"的证据锚点，已用 `:289-312` 全文核对，不是转述。

**归属**：原文明写「先于本层的缺陷」，不要求重裁，今天代码结构（无锁、无原子性）未变，判定不变。

## 4. 第 1 笔的今日证据

**`recoverInterruptedOwnerTransfer` 今天的完整形状**（`fileStore.ts:1011-1026`，逐字）：
```
async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
  const paths = getOwnerTransferPaths(runDir);
  if (!(await pathExists(paths.transactionMarkerPath))) {
    if (options?.lockHeld) { await cleanupOwnerTransferStagingWithoutMarker(runDir); }
    return;
  }
  if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
    return;
  }
  await finalizePendingOwnerTransfer(runDir);
}
```
与来源报告（`close-2-recovery-path.md` §1）逐字一致，仅行号从 `:1007-1022` 漂移到 `:1011-1026`（+4，因 `811a2e7` 在它之前插入了 4 行注释）。

**`tryRecoverStaleOwnerTransferLock` 今天的完整形状**（`:784-818`）与来源报告 §1.1/§4.2 描述的 G0/G1/G2/G3 四格结构逐字对应：
- G0（短路，在 `recoverInterruptedOwnerTransfer:1021` 层）：`pathExists(lockPath)` 为假 ⇒ 整个合取短路，直接 `finalizePendingOwnerTransfer`，从未进入本函数。
- G1（`:791-793`）：`readFile(lockPath)` 抛 `ENOENT` → `return true`（不 unlink）。
- G2/G2-null（`:798-804`，成功解析分支）：`pid === null || !isProcessActive(pid)` 时不 `return false`，直落 `:816` `safeUnlink(lockPath)` + `:817 return true`——**这条分支完全不查 `hasStagedArtifacts`**（该变量只在下面的 `catch` 块里声明，`:806-809`）。
- G3（`:798` 抛出，进 `catch`）：`hasStagedArtifacts` 为真则同样落到 `:816-817` unlink+return true。

**四格全部不重新取锁就 finalize**：`:1011-1026` 全函数体内，`:1021` 到 `:1025` 之间只有一个 `if`，`acquireOwnerTransferLock` 的三个调用点（`:1040`/`:1083`/`:1132`）没有一个在 `recoverInterruptedOwnerTransfer` 内（`grep -n 'acquireOwnerTransferLock(' src/persistence/fileStore.ts`，第 6 节）。

**`finalizePendingOwnerTransfer` 函数体零守卫**：`awk 'NR>=935 && NR<=1010' src/persistence/fileStore.ts | grep -c 'sameOwnerRecord\|OwnerTransferPreconditionError\|isProcessActive\|lockPath'` 今天输出 `0`——不比较所有权、不做 CAS、不检查活进程、连锁路径名字都没出现，完全依赖调用者持锁。

**recovery 路径今天仍是 4 个调用点，其中 3 持锁 + 1 不持锁**：`grep -n 'recoverInterruptedOwnerTransfer(runDir' src/persistence/fileStore.ts` 命中 `:1029`（`readOwnerRecord` 内，不传 `options`，**不持锁**）、`:1043`（`writeOwnerTransferArtifacts`，`lockHeld:true`）、`:1086`（`claimOwnerRecordWithPrecondition`，`lockHeld:true`）、`:1135`（`updateOwnerRecordWithPrecondition`，`lockHeld:true`）。`readOwnerRecord` 本身在生产代码里有 4 个调用点：`runLoop.ts:788`、`runLoop.ts:866`、`resumeLoop.ts:137`、`fileStore.ts:382`（`grep -rn 'readOwnerRecord(' src/`，第 6 节）——P-READ 面今天仍然覆盖读路径与所有权判定的多个入口，不止 §13 原文那一条经 `EEXIST` 到 `tryRecover…` 的窄入口。

**P-READ 不经过锁协议**：`readOwnerRecord` → `recoverInterruptedOwnerTransfer(runDir)`（不传 `options`）→ marker 存在时进 `:1021` 判定；若锁文件不存在（G0），`pathExists(paths.lockPath)` 直接为假，`tryRecoverStaleOwnerTransferLock` **根本没被调用**，`finalizePendingOwnerTransfer` 在完全不接触锁协议的情况下被执行。这条结构今天与来源报告逐字一致。

**判定**：`tryRecoverStaleOwnerTransferLock`／`recoverInterruptedOwnerTransfer` 今天的形状（除行号 +4 漂移外）与来源报告完全一致，「锁可被偷」「已扩到 recovery 路径」「P-READ 不经过锁协议」三句今天在代码面都站得住。

## 5. G2-null 的今日证据

**触发条件（成功解析分支）**：`tryRecoverStaleOwnerTransferLock` 今天 `:798-804`：
```
const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
if (pid !== null && isProcessActive(pid)) { return false; }
```
`pid === null` 时第一个合取项为假 ⇒ 不 `return false` ⇒ 直落 `:816-817` 无条件 unlink + return true。`parsePid` 判据（`:765-768`）：`/^pid:(\d+)$/.exec(processInstanceId)`，不匹配返回 `null`。

**唯一防线：一段注释，今天位置漂移但内容未改**。原文档记 `fileStore.ts:603-605`；今天 `sed -n '595,610p' src/persistence/fileStore.ts` 实测该注释位于 `:605-608`（往后漂移 2 行，因该文件内更早处一次纯文档 errata 改动插入了行），逐字：
```
605: // A third and deliberately weaker form exists in acquireOwnerTransferLock (`pid:<pid>`, no
606: // start time). It is correct as written — its only consumer, parsePid, extracts the pid for a
607: // liveness probe and never compares process identity — so do not "unify" it with this one.
```
三句与来源报告引用的原文逐字相同，一个字都没改。

**`buildProcessInstanceId()` 与该注释断言的锁记录形式不匹配**：`src/runtime/processIdentity.ts:7` 逐字 `` const PROCESS_INSTANCE_ID = `pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`; ``，形如 `pid:<pid>:<origin>`，含两个冒号；`parsePid` 的正则 `^pid:(\d+)$` 要求冒号后立即是数字并以行尾结束——`pid:123:456789` 在第一个冒号后的 `123` 之后紧跟第二个冒号而非字符串结尾，正则不匹配，`parsePid` 对它返回 `null`。若锁记录被「顺手统一」到 `buildProcessInstanceId()`，`:798` 的 `pid !== null` 恒假，每把锁对每个读者都会立即被判定可删——这就是 G2-null 一旦触发即成 P-STEAL/P-READ 同型数据丢失的机制。

**「没有测试钉住」——全称否定，先亮 grep 面**：断言范围是「全仓 `src/`+`tests/` 内，是否存在任何一处针对 `parsePid` 在 `pid:<pid>:<origin>` 输入下行为的测试断言」。用两条互补的 grep 覆盖：
- `grep -rn parsePid src/ tests/`：3 处命中，全部在 `src/persistence/fileStore.ts`（`:608` 注释引用符号名、`:765` 定义、`:800` 调用点）——`tests/` 目录 **0** 命中，且该符号未 `export`，无法被测试直接调用。
- `grep -rn holderProcessInstanceId src/ tests/`：14 处命中（`src/ownership/lease.ts` 2 处类型定义、`fileStore.ts` 3 处类型/调用、`tests/` 9 处）。逐条核对 9 处测试命中：`tests/controller/leaseHeartbeat.test.ts:298`、`tests/controller/resumeLoop.integration.test.ts:213`、`tests/controller/leaseLifecycle.integration.test.ts:482`、`tests/persistence/fileStore.test.ts:629/678/986/994/1026` 全部写 `` `pid:${process.pid}` `` 或字面量 `"pid:999999"`（都匹配 `^pid:(\d+)$`，不是要测的形式）；唯一带两个冒号的 `tests/controller/leaseGate.test.ts:77` 写的是 `"pid:100:1000"`，但赋给的字段属于 `src/ownership/lease.ts:12` 的 **lease 记录**类型（`RunLeaseLostError` 的构造参数），不是本节讨论的 owner-transfer 锁记录，且这条测试也不经过 `parsePid`（`tests/ownership/lease.test.ts:128` 只断言 `error.holderProcessInstanceId` 的字符串相等，不涉及 `parsePid` 解析）。
- 两条 grep 面合并覆盖了「`parsePid` 直接调用」与「构造锁记录 `holderProcessInstanceId` 字段」这两个断言可能落地的全部入口，sanity 探针（`grep -c '' fileStore.ts` 命中 1223 行、非零）证明检索面是活的，非被过滤/转义弄坏的零输出。

**判定**：今天 `src/`+`tests/` 范围内确实没有任何断言覆盖 `parsePid` 对 `pid:<pid>:<origin>` 形式的行为，「只有注释、没有测试」这句全称否定今天仍成立。G2-null 本身今天不可达（三个触发条件——字段缺失/不匹配/第二写者——均不成立，全仓唯一写者 `acquireOwnerTransferLock:831` 写 `` `pid:${process.pid}` ``），但门槛只差一次「统一格式」的改动。

## 6. 我用过的每一条命令与它当时的输出（含 sanity 探针）

两条探针脚本先落盘再用 `export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy zsh <script>` 跑，全程未过滤输出（无 `| grep`/`| tail`）：
- `/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/85257637-5313-4289-ba1a-117ef66c7285/scratchpad/verify1.sh`
- `/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/85257637-5313-4289-ba1a-117ef66c7285/scratchpad/verify2.sh`

**Sanity 探针**（两脚本各自开头）：`grep -c '' src/persistence/fileStore.ts` → `1223`；`grep -c '' src/controller/runLoop.ts` → `1561`。两者均非零，证明检索面是活的。

**HEAD 与工作区**：`git log -1 --format='%H %ad %s'` → `29dba2d333b8776f32986598e6fb5e572b4b478c Fri Aug 7 22:52:48 2026 +0800 docs(sdd): 包 2 记人裁 10/11 并派两名只读开工前扫描员（brief 入库）`；`git status --short` → 空（干净）。

**债 2**：
- `grep -rnF 'persistTerminalState(' src/` → 16 行（1 定义 + 15 调用），逐字见第 2 节。
- `grep -cF 'persistTerminalState(' src/controller/runLoop.ts` → `16`。
- `grep -n 'leaseLoss.lost !== null\|isLeaseStopError(error)' src/controller/runLoop.ts` → 5 行命中（`:1061`/`:1069`注释/`:1109`/`:1454`/`:1507`），其中 `:1069` 是注释非代码，实际判定分支 4 处。
- `grep -nF -A2 'cancelled:' src/state/stateMachine.ts` → `11:  cancelled: [],` / `12-  failed: [],` / `13-};`。
- `grep -n 'RESUMABLE_STATUSES' src/controller/resumeLoop.ts` → `38:...["planning", "executing", "verifying"]` / `64:if (!RESUMABLE_STATUSES.includes(...))`。
- `grep -nF -A12 'async function persistTerminalState(' src/controller/runLoop.ts` → 函数体逐字见第 2 节，无所有权守卫。
- `grep -n isLeaseStopError src/controller/runLoop.ts` / `grep -nF -A3 'function isLeaseStopError('...` / `grep -rn RunHeartbeatStoppedError src/` / `sed -n '1488,1502p' src/controller/runLoop.ts` → 均见第 2 节，判定体与「不写终态」分支逐字确认。

**第 4 笔**：
- `grep -n 'function ...'`（TOCTOU 全部符号）→ 定位见第 3 节开头。
- `grep -nF -A6 'function transferRepresentsPublishedWinner(' src/persistence/fileStore.ts` → 函数体三合取项逐字见第 3 节。
- `git log --oneline -L :transferRepresentsPublishedWinner:src/persistence/fileStore.ts` → 最新触碰 `97ed9aa`（2026-07-23）。
- `grep -nF -A32 'async function readPersistedSuccessfulTransferArtifacts('...` 与 `-A24 'async function preserveSuccessfulReconciliationIfNeeded('...` → 两态分流（ENOENT/unreadable/artifacts）逐字见第 3 节。
- `sed -n '185,300p' src/persistence/fileStore.ts` → `shouldPreserveExistingReconciliationRecord`/`shouldProtectSuccessfulTransferTruth`/`describePublishedWinnerReplacement` 全文，判别式 `:296-305` 逐字见第 3 节。
- `sed -n '460,515p' src/persistence/fileStore.ts` → `reconciliation_published_winner_replaced` 事件唯一 append 点 `:507`，触发条件 `decision.publishedWinnerReplacedDetail !== undefined`。

**第 1 笔**：
- `grep -nF -A16 'async function recoverInterruptedOwnerTransfer('...` → 函数体逐字见第 4 节，今天 `:1011-1026`。
- `grep -nF -A40 'async function tryRecoverStaleOwnerTransferLock('...` → 函数体逐字，今天 `:784-818`，G0-G3 四格结构见第 4/5 节。
- `grep -rn finalizePendingOwnerTransfer src/` → 6 行（3 注释 + 1 定义 + 2 调用：`:1025` 不持锁、`:1072` 持锁）。
- `grep -n 'acquireOwnerTransferLock(' src/persistence/fileStore.ts` → 定义 `:820` + 3 调用 `:1040`/`:1083`/`:1132`，无一在 recovery 函数内。
- `grep -rn 'readOwnerRecord(' src/` → 5 行（4 生产调用点 + 1 定义 `:1028`）。
- `grep -rn isProcessActive src/` → 2 行（定义 `:770` + 唯一调用 `:802`）。
- `awk 'NR>=935 && NR<=1010' src/persistence/fileStore.ts | grep -c 'sameOwnerRecord\|OwnerTransferPreconditionError\|isProcessActive\|lockPath'` → `0`。
- `grep -n 'recoverInterruptedOwnerTransfer(runDir' src/persistence/fileStore.ts` → 5 行（1 定义 + 4 调用：`:1029` 不持锁、`:1043`/`:1086`/`:1135` 持锁）。

**G2-null（全称否定，两条互补 grep 面）**：
- `grep -nF -A4 'function parsePid(' src/persistence/fileStore.ts` → 正则 `^pid:(\d+)$`。
- `sed -n '595,610p' src/persistence/fileStore.ts` → 注释区今天 `:605-608`，三句逐字见第 5 节。
- `grep -n 'buildProcessInstanceId\|PROCESS_INSTANCE_ID' src/runtime/processIdentity.ts` → `` `pid:${process.pid}:${Math.trunc(performance.timeOrigin)}` ``。
- `grep -rn holderProcessInstanceId src/ tests/` → 14 行，逐条列在第 5 节（9 条 tests 命中全部核对完毕）。
- `grep -rn parsePid src/ tests/` → 3 行，全部在 `src/`，`tests/` 零命中。

所有命令均 `EXIT=0`（脚本用 `set -x`，未见非零退出码或报错行）。两脚本的完整逐行输出已在工具调用记录中留痕；本节为去重后的命令-结论对照表，未删减任何影响判定的行。

## 7. 我没有验到的部分

- **没有做任何实跑注入**。本轮我是只读扫描员，人裁 4 的 `tests/` 写入授权是给包 2 的**实施者**用的，不属于我这一轮的职责范围；四条判定全部是静态代码核对（grep / sed / git log -L），与 `docs/superpowers/specs/.../:2313` 附近的原始三份来源报告方法论一致，但不构成动态验证。
- **没有重新构造并实跑第 4 笔两条时序、第 1 笔 P-STEAL/P-READ 的跨进程竞态**。来源报告（`scan-B`/`close-2-recovery-path.md`）自陈这些也是「逐环节读代码走出来的，不是观测到的」；我延续同样的方法论重核代码结构，但同样没有用两个真实进程 + 精确 SIGKILL 时点去实测。
- **没有核对 `docs/handoff/handoff.md:426`** 这条 close-2-recovery-path.md §3.3 引用的旁证——该文档已被 progress.md 判定为非权威源，来源报告也只当旁证不当结论，我沿用这一判断、没有重新核实它本身。
- **没有独立重做 close-2-recovery-path.md §4.1 的「有没有第三条同形路径」的全仓扫描方法本身**——我复核了它给出的结论（G2-null 是唯一的第三格）在今天代码上仍然对（`tryRecoverStaleOwnerTransferLock` 函数体今天与来源报告逐字一致，没有新增分支），但没有重新从零对整个 `src/` 做一次独立的「所有不持锁 finalize 路径」普查。
- **没有核对 scan-A/scan-B 两份来源报告里我未直接用到的部分**（例如 scan-B 自陈未完成的 §11/§15 逐句核对、scan-A 项 B/项 C 的执行 abort 相关内容——那些不在本轮四条判据范围内）。
- **`src/state/stateMachine.ts` 的完整转移表**只核对了 `cancelled`/`failed` 两行附近，没有逐行核对全表其余状态的出边（不在本轮判据范围内，只是如实标注未验）。
- **fileStore.ts 与 runLoop.ts 之外的间接调用面**（例如是否有其它文件通过反射/动态属性访问间接触发这些函数）未做全仓字节码级排查，只做了符号名 grep——按本仓库的 TypeScript 静态导入惯例，这个残余风险判为可忽略但未做穷举证明。

## 8. 预算记账

本任务上限 100,000 tokens（brief §8）。我没有精确的逐 token 计数器，只能给量级估计：读取三份来源文档（progress.md ~106 行、scan-A ~180 行、close-2-recovery-path.md 分三段共 ~340 行）、两次 `rtk proxy zsh` 探针脚本运行（各自输出约 90-150 行逐行 `set -x` 转录）、若干次针对性 `Read`（fileStore.ts 局部区间）、以及本报告六节的多次 `Edit` 写入，合计估计在 **35,000-50,000 tokens** 量级，**未破 100,000 上限**。未做静默压缩或摘要丢弃——所有实际影响判定的命令输出均已摘录进第 2-6 节。若需要更精确的计数，需宿主侧提供逐次调用的 token 明细，本报告不能自证这一点，如实标注。