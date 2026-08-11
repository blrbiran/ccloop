# 包 2 整分支评审修复环 —— 实施报告

## 0. 结论（最先填：每一项 DONE / BLOCKED / 未做，一目了然）

| 项 | 状态 | 变异红实测 | 还原/修后绿实测 |
|---|---|---|---|
| 2.1(a) 人裁 13 源码锚点 | **DONE** | 不适用（纯注释） | 全套件绿 |
| 2.1(b) HONEST LIMIT 第 4 条 | **DONE** | 不适用（纯注释） | 全套件绿 |
| 2.1(c) 两处勘误（原句保留） | **DONE** | 不适用（纯注释） | 全套件绿；两句原文各仍存在 1 处 |
| 2.2 D2 reconciliation 重试判据（新增 2 条） | **DONE** | ✅ `RECONCILIATION_LOCK_RETRY_ATTEMPTS 3→1` ⇒ 2 条全红，且**红在断言上** | ✅ 改回 3 ⇒ fileStore 79/79 绿 |
| 2.3(a) 三终态所有权拒写判据（新增 3 条） | **DONE** | ✅ 守卫对三终态放行 ⇒ 3 条全红（`expected 'succeeded' to be 'planning'` 等） | ✅ 还原 ⇒ 5/5 绿（含 2 条既有对照） |
| 2.3(b) 重试常数绝对值断言（新增 3 行 × 2 处） | **DONE** | ✅ `3→2` 红（`expected 2 to be 3`）；✅ 单独 `50→40` 也红（`expected 40 to be 50`） | ✅ 还原 ⇒ 2/2 绿 |
| 2.4 resume 读顺序（行为改动） | **BLOCKED（判据与修法都已做出并实测，但已从分支尖端 revert，等人裁）** | ✅ 未修代码上判据红，**红在断言上**（outcome 值比较） | ✅ 修后 resumeLoop 15/15 绿 —— **但同时打红既有 crash-gap 矩阵 18 行** |

**2.4 为什么 BLOCKED（这是本轮唯一需要人裁的事）**：
按 brief 修法（把 `readOwnerRecord` 从 `Promise.all` 提出来先 `await`）之后，
`tests/persistence/fileStore.test.ts` 的既有判据
`refuses resume at every pre-commit crash gap of the three-file transaction…`
**两个 fixture 各有 9 行（gap 05–13，共 18 行）从 `resume=refused` 变成 `resume=accepted`**（实测输出见 §6）。
brief 说本修法「不改任何现有断言」—— **该说法与实测不符**。要落地就必须改写那 18 行既有期望，而那属于
「第五个具名例外点名之外的既有判据」，我无权动。且有两条实质理由必须由人来裁：
1. 那条矩阵测试**自己的注释**把「owner record 走恢复、另两个走生读、同在一个 `Promise.all`」这件事，
   写成了「正是这个交错让 `evaluateResumeEligibility` 的两条 epoch 判据成为承重判据」。修法**消掉了这个交错**，
   双 transfer fixture 的 gap 05–13 因此不再触发那两条判据。
2. 修法在「事务可恢复」的格子上**放行了更多 resume**（gap 01–04 仍拒，因为恢复本身 fail-closed）。
   本仓库另有一条 2026-08-02 人裁立场 **S-3「never permit more」**，`fileStore.ts` 里就引用着它。
   本次是不是该立场的例外，不是我能决定的。

处置（保证分支尖端是绿的，同时一点工作都不丢）：
- `f584bb693081917051cdb3f87dc5685bbee4e249` = 修法 ＋ 回归判据（完整，可 cherry-pick）
- `5026bea`（分支尖端）= 对上一条的 revert，commit message 里写明了原因与实测
人裁通过后，`git cherry-pick f584bb6` ＋ 改写那 18 行即可。

**最终验证（分支尖端 `5026bea`，未过滤，整份落盘）**：
`npm test -- --run` → **exit 0，31 文件全过，529/529 全绿**（基线 524，新增 5 条）；
`npm run typecheck` → exit 0；`npm run build` → exit 0。

**Rule 12 明说**：
- 2.4 的产品改动**没有留在分支上**（见上）。
- 2.2 为了能数「取锁尝试次数」，我在 `tests/persistence/fileStore.test.ts` 已有的
  `vi.mock("node:fs/promises")` 工厂里**加了一个 `open` 的透传 spy**（照抄同文件既有的 `renameSpy`）。
  它只观察、全部转发，不改任何行为；但这确实动了该文件的**共享夹具**，不是「只加新 `it`」。据实报告。
- 除此之外没有改任何既有断言；两条自指断言原样保留（实测见 §5）。

## 1. 我自己的基线（未过滤）

环境：`export ECC_GATEGUARD=off DISABLE_OMC=1`，全部走 `rtk proxy`。
整份日志落盘在
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/c74add88-b8d0-4cb8-8759-2160067337a8/scratchpad/logs/`
（`baseline-test.log` 152 行、`baseline-typecheck.log`、`baseline-build.log`），**未做任何 grep/tail/sed 过滤**，整份读回。

- `rtk proxy npm test -- --run`：
  `Test Files 1 failed | 30 passed (31)` / `Tests 1 failed | 523 passed (524)`，Duration 20.72s。
  唯一失败：
  `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
  → `Error: Test timed out in 5000ms.`
  **＝ brief 允许的 flake (B)，按完整测试名比对一致。** 其余 0 失败。
  （brief 挂账的另外三条本次基线全绿：`persists phase usage evidence…`、
  `subprocessClaudeAdapter … waits for close before interrupting a close-pending successful execute`、
  `evidence.test.ts > finalize-review CLI > rejects unknown verdicts and diagnoses`。）
- `rtk proxy npm run typecheck` → `TYPECHECK_EXIT=0`
- `rtk proxy npm run build` → `BUILD_EXIT=0`

我没有继承任何先前的绿：以上三条都是本会话在本工作区亲跑的。

## 2. 2.1 文档类三项：改了什么、原句是否保留

三项都是**纯注释**。分支尖端 `src/` 的 diff 里**非注释行为 0 行**，实测：

```
git diff 9392ce6..HEAD -- src/ | grep -E "^[+-][^+-]" | grep -vE "^[+-]\s*//"
（无输出）
```

**(a) 人裁 13 的源码锚点** —— `tests/controller/runLoop.integration.test.ts`，
在 `abandons the loser's reconciliation write against the winner's held transfer lock and finalizes
none of the winner's transaction inside the publish window` 这条测试的注释块末尾新增一段
`*** SOURCE ANCHOR … ***`：写明这是**包 2 台账的 HUMAN RULING 13**，是对「既有测试名不得更改」这条规矩的
**具名例外**，并写明为什么补（全仓检索 `ruling 13` 零命中而 14/17/37 命中 ⇒ 检索面已证为活）。
**测试本身一个字没动。**

**(b) `src/controller/ownedRunStateWriter.ts` 的 HONEST LIMIT 第 4 条** ——
在既有三条「STILL OPEN」之后新增 `FOURTH PATH`，逐字写明结构判据
`tests/controller/ownedRunStateWriter.structure.test.ts` 的 `runLoopSourcePath` **写死只解析一个文件**，因此：
(1) 动态 `await import()` 不可见；
(2) 新建第三模块再被调用不可见，**并且往 `src/` 新增模块这件事本身也无人出声**（没有任何测试观察 `src/` 的文件集合）；
(3) `*** src/controller/resumeLoop.ts is COMPLETELY OUTSIDE the check's field of view. ***`
—— 今天没 import `writeRunState`，明天 import 了结构判据照样绿，因为它根本不读那个文件。
末尾明说这是**把自陈边界改成与实际一致，不新增保证**，且**没有**扩大解析范围。

**(c) 两处勘误，原句一律保留（实测）**：
```
grep -c "Two lock spans cannot interleave" src/persistence/fileStore.ts   → 1
grep -c "unrelated, already-known" tests/persistence/fileStore.test.ts    → 1
```
- `src/persistence/fileStore.ts`，`publishReconciliationUnderTransferLock` 上方：原句「Two lock spans cannot
  interleave」**逐字保留**，其后加 `*** ERRATUM … Critical C-1 ***`，逐字写明
  `open(lockPath,"wx") → handle.writeFile(...)` 之间锁文件是 **0 字节**；闯入者的
  `tryRecoverStaleOwnerTransferLock` 在 `catch` 分支**从不调用 `isProcessActive`**，只要有 staged artifacts 就
  `safeUnlink` 放行 ⇒ **活持有者的锁会被夺走，两个锁跨度能交错**；并注明控制器已用真双进程复现（台账 §21.1），
  这是**已知未修的 Critical（C-1）**，修法待人裁，本轮**刻意不修**，
  `acquireOwnerTransferLock` / `tryRecoverStaleOwnerTransferLock` **一行产品代码都没碰**。
- `tests/persistence/fileStore.test.ts` 的 `recoverInterruptedOwnerTransfer: two concurrent unlocked readers
  racing the same marker` 夹具注释：原句里的 `(unrelated, already-known)` **逐字保留**，其后加勘误写明
  **`unrelated` 在 D2 之后不成立** —— 这条测试要立的结论是「同一时刻只有一个 finalizer」，而零长度窗口正是让该结论
  为假的那条路径；并写明**夹具与断言刻意不动**（改夹具会改变它测的东西）。

## 3. 2.2 D2 重试判据：新测试 ＋ 变异红/绿双向实测

**新增两条（纯新增，未动任何既有判据），在 `tests/persistence/fileStore.test.ts` 的 `describe("fileStore")` 内**：
1. `retries a busy owner-transfer lock for the reconciliation publish and writes the record once it clears`
2. `abandons the reconciliation publish once the reconciliation retry bound is exhausted, after exactly three lock attempts`

形状照抄 leaseLifecycle 的 `retries a busy owner-transfer lock and completes once it clears (spec requirement 1)`
／`abandons the transfer once the retry bound is exhausted…` 这一对。

**忙锁走的是生产路径**：真的写一个 `.owner-transfer.lock`，`holderProcessInstanceId: pid:<本进程 pid>`（活进程）
⇒ `acquireOwnerTransferLock` 拿到 EEXIST，`tryRecoverStaleOwnerTransferLock` 看到活 pid 拒绝夺锁 ⇒
真的抛 `OwnerTransferLockBusyError`。第一条测试在 **70ms** 处 unlink 释放锁：第 1 次尝试（t≈0）必然撞上活锁，
第 3 次尝试不可能早于 100ms（前面挡着两次真 sleep），所以窗口是**单边**的 —— 机器慢只会把成功从第 2 次挪到第 3 次，
不会把它变成失败。

**「取锁尝试次数」怎么数**：`RECONCILIATION_LOCK_RETRY_*` 是 module-private，**我刻意没有把它导出来给测试用**
（那正是本条 finding 反对的自指断言）。改为在该文件**已有的** `vi.mock("node:fs/promises")` 工厂里，
照抄同文件既有 `renameSpy` 的形状，加一个 `open` 的**透传 spy**（`openSpy`，全部转发给真实现），
`fileStore.ts` 里 `open` 只在 `acquireOwnerTransferLock` 一处用 ⇒ 一次 lock 路径的 `open` ＝ 一次取锁尝试。
⚠️ 据实报告：这**动了该测试文件的共享夹具**（虽然纯观察、零行为改动）。

### 变异红（实测）
`src/persistence/fileStore.ts`：`const RECONCILIATION_LOCK_RETRY_ATTEMPTS = 3;` → `= 1;`
```
 ❯ tests/persistence/fileStore.test.ts (79 tests | 2 failed | 62 skipped) 55ms
   × fileStore > retries a busy owner-transfer lock for the reconciliation publish and writes the record once it clears 10ms
     → expected [ 'reconciliation_write_abandoned' ] to not include 'reconciliation_write_abandoned'
   × fileStore > abandons the reconciliation publish once the reconciliation retry bound is exhausted, after exactly three lock attempts 3ms
     → expected 1 to be 3 // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 15 passed | 62 skipped (79)
EXIT=1
```
**两条都红在断言上**（一条 `not.toContain`，一条 `toBe(3)`），不是靠异常/超时红。
第一条测试里那句 `expect(...).not.toContain("reconciliation_write_abandoned")` 刻意放在**读文件之前**，
就是为了让「记录没写成」表现为断言失败而不是 ENOENT 抛出。

### 还原绿（实测）
改回 `= 3;` 后跑整个 fileStore 文件（不加 `-t` 过滤）：
```
 ✓ tests/persistence/fileStore.test.ts (79 tests) 893ms
 Test Files  1 passed (1)
      Tests  79 passed (79)
EXIT=0
```
（79 = 原 77 ＋ 新 2；既有 77 条含 crash-gap 矩阵全部仍绿 ⇒ `openSpy` 没有副作用。）

日志：`22-green.log` / `22-mutant-red.log` / `22-restored-green.log`。

## 4. 2.3(a) 三终态判据：新判据 ＋ 变异红/绿双向实测

**新增三条**（`tests/controller/runLoop.integration.test.ts`，紧挨既有 F-1 判据之后）：
- `refuses to write a terminal succeeded status into a run a different owner holds`
- `refuses to write a terminal exhausted status into a run a different owner holds`
- `refuses to write a terminal blocked_waiting_human status into a run a different owner holds`

形状照抄既有 `refuses to write a terminal failed status into a run a different owner holds when the attempt
fails for a non-lease reason`：同一夹具（`initializeRunFiles` ＋ 一份 `writeOwnerRecord` 指向
`pid:999999:1234567890` 的**活的、current 的、未被 supersede 的**别人），走 `runLoopFromState`，
每条断言四件事 ＋ 用生产闸门 `evaluateResumeEligibility` 加一条对照：
1. `finalState.status` ＝ 该终态（**报告半边不变**）；
2. 盘上 `loop-state.json` 仍是 `planning`，且**字节级等同**运行前；
3. 事件里有 `terminal_write_abandoned`；
4. 生产闸门对盘上状态答 `{ok:true}`；**对照**：把状态换成该终态喂同一个闸门 ⇒
   `{ok:false, reason:"run status <X> is not resumable"}` —— 这就是 F-1 的损害形状。

三条到达终态的路线各不相同（分别是 successFrame、`perAttemptTimeoutMs: 20` ＋ plan 超时、`pauseOn` 人工门），
都抄自本文件既有测试。

### 变异红（实测）
`src/controller/ownedRunStateWriter.ts`，把守卫对这三种终态放行（同控制器那次变异）：
```
-    if (ownership.kind === "foreign") {
+    if (ownership.kind === "foreign" && !["exhausted", "blocked_waiting_human", "succeeded"].includes(state.status)) {
```
```
 ❯ tests/controller/runLoop.integration.test.ts (64 tests | 3 failed | 59 skipped) 863ms
   × runLoop > refuses to write a terminal succeeded status into a run a different owner holds 171ms
     → expected 'succeeded' to be 'planning' // Object.is equality
   × runLoop > refuses to write a terminal exhausted status into a run a different owner holds 184ms
     → expected 'exhausted' to be 'planning' // Object.is equality
   × runLoop > refuses to write a terminal blocked_waiting_human status into a run a different owner holds 162ms
     → expected 'blocked_waiting_human' to be 'planning' // Object.is equality
 Test Files  1 failed (1)
      Tests  3 failed | 2 passed | 59 skipped (64)
EXIT=1
```
**三条全红在断言上**（`expect(observation.persisted.status).toBe("planning")`），
且同一次跑里既有的两条 `failed` 判据**仍绿**（`2 passed`）—— 变异面确实只打开了这三种终态。

### 还原绿（实测）
把守卫改回 `if (ownership.kind === "foreign") {`：
```
 ✓ tests/controller/runLoop.integration.test.ts (64 tests | 59 skipped) 763ms
      Tests  5 passed | 59 skipped (64)
EXIT=0
```
日志：`23a-green.log` / `23a-mutant-red.log` / `23a-restored-green.log`。

## 5. 2.3(b) 常数绝对值断言：新增断言 ＋ 变异红实测（并证明既有自指断言未被删改）

**只加不减**。在两条既有耗尽判据里各加三行（外加把 `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS` 一起解构进来）：
```ts
expect(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS).toBe(3);
expect(OWNER_TRANSFER_LOCK_RETRY_DELAY_MS).toBe(50);
expect((OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS - 1) * OWNER_TRANSFER_LOCK_RETRY_DELAY_MS).toBe(100);
```
位置：
- `tests/controller/resumeLoop.integration.test.ts` >
  `abandons the resume once the claim's retry bound is exhausted, with the refusal recorded exactly once`
- `tests/controller/leaseLifecycle.integration.test.ts` >
  `abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)`

第三行就是把人裁 38 的「约 100ms ＝ 2 × 50ms」写成判据（而不是写在注释里）。
**产品代码里的 3 与 50 没有动**（分支尖端 `src/` 只有注释改动，见 §2 的实测）。

**既有两条自指断言原样保留（实测）**：
```
grep -nF "toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)" tests/controller/resumeLoop.integration.test.ts tests/controller/leaseLifecycle.integration.test.ts
tests/controller/resumeLoop.integration.test.ts:349:      expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS);
tests/controller/leaseLifecycle.integration.test.ts:729:      expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS);
```

### 变异红（实测，两次，分别打 attempts 和 delay）
(1) `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS 3→2`（同时 delay 50→40）：
```
   × lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted … → expected 2 to be 3
   × resumeLoop > abandons the resume once the claim's retry bound is exhausted … → expected 2 to be 3
      Tests  2 failed | 39 skipped (41)   EXIT=1
```
注意：控制器此前实测「3→2 全套件全绿」，现在 3→2 **必红**，就是本项要补的执行机制。

(2) 只打退避：attempts 还原成 3，只留 `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS 50→40`：
```
   × resumeLoop > abandons the resume once the claim's retry bound is exhausted … → expected 40 to be 50
   × lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted … → expected 40 to be 50
      Tests  2 failed | 39 skipped (41)   EXIT=1
```
⇒ 两个常数**各自**都有执行机制，不是只有其中一个。

### 还原绿（实测）
两个常数都改回 3 / 50：
```
 ✓ tests/controller/resumeLoop.integration.test.ts (14 tests | 13 skipped) 225ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 508ms
      Tests  2 passed | 39 skipped (41)   EXIT=0
```
日志：`23b-green.log` / `23b-mutant-red.log` / `23b-mutant-delay-red.log` / `23b-restored-green.log`。

## 6. 2.4 resume 读顺序：先红后绿的判据实测 ＋ 修法 diff

**状态：BLOCKED（判据 ＋ 修法都已做出并双向实测；已从分支尖端 revert，等人裁）。**
承载 commit：`f584bb693081917051cdb3f87dc5685bbee4e249`（修法 ＋ 判据），
`5026bea`（revert，分支尖端）。

### 判据（先写，红在断言上）
`tests/controller/resumeLoop.integration.test.ts` >
`resumes a run interrupted between the transaction's owner-record and reconciliation renames, instead of
refusing it as unreadable`。

夹具＝brief 说的那个真实缺口：从 `seedEligibleRun` 出发，删掉 `reconciliation-record.json`，
补上三个 pending ＋ v2 marker（`finalizeOrder = [owner-transfer.json, owner-record.json,
reconciliation-record.json]`）⇒ 前两个已落地、第三个尚未，marker 与三个 pending 都在，恢复能幂等地把它做完。
另有一条夹具前提断言（`reconciliation-record.json` 确实不存在），防止空跑。

断言形状**刻意把结果收成一个值再比**，所以红在断言、不在抛异常：
```ts
const outcome = await resumeLoop(runDir, new ScriptedAdapter([successFrame()])).then(
  (state) => ({ kind: "resumed", detail: state.status }),
  (error) => ({ kind: "refused", detail: error instanceof Error ? error.message : String(error) }),
);
expect(outcome).toEqual({ kind: "resumed", detail: "succeeded" });
```

**未修代码上的红（实测）**：
```
 ❯ tests/controller/resumeLoop.integration.test.ts (15 tests | 1 failed | 14 skipped) 124ms
   × resumeLoop > resumes a run interrupted between the transaction's owner-record and reconciliation renames, instead of refusing it as unreadable 123ms
     → expected { kind: 'refused', …(1) } to deeply equal { Object (kind, detail) }
AssertionError: expected { kind: 'refused', …(1) } to deeply equal { Object (kind, detail) }
  Object {
-   "detail": "succeeded",
-   "kind": "resumed",
+   "detail": "cannot read run artifacts: Error: ENOENT: no such file or directory, open '/var/folders/…/ccloop-run-E66Joi/reconciliation-record.json'",
+   "kind": "refused",
  }
 ❯ tests/controller/resumeLoop.integration.test.ts:178:21
EXIT=1
```
⇒ 缺陷形状与 brief 一致：**不是崩溃、不是数据丢失，是首次 resume 被误拒且归因错误。**

### 修法 diff（`src/controller/resumeLoop.ts`，commit f584bb6）
```diff
-    [ownerRecord, ownerTransfer, reconciliation, runState, contract] = await Promise.all([
-      readOwnerRecord(runDir),
+    ownerRecord = await readOwnerRecord(runDir);
+    [ownerTransfer, reconciliation, runState, contract] = await Promise.all([
       readOwnerTransferRecord(runDir),
       readReconciliationRecord(runDir),
       readRunState(runDir),
       loadContract(join(runDir, "loop-contract.json")),
     ]);
```
（附一段注释说明为什么先 await 它、以及与 leaseGate 既有「谁做恢复」分工一致。）

**修后的绿（实测，整个文件不加过滤）**：
```
 ✓ tests/controller/resumeLoop.integration.test.ts (15 tests) 2384ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
EXIT=0
```
`npm run typecheck` 同时为 0。

### ⛔ 但是：修法打红了既有判据 18 行（这就是 BLOCKED 的原因）
同一份修法下跑 `tests/persistence/fileStore.test.ts`：
```
 ❯ tests/persistence/fileStore.test.ts (79 tests | 1 failed) 1141ms
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 760ms
     → expected [ …(17) ] to deeply equal [ …(17) ]   （first-transfer fixture）
     → expected [ …(17) ] to deeply equal [ …(17) ]   （double-transfer fixture）
      Tests  1 failed | 78 passed (79)   EXIT=1
```
逐行差异（整份读回，两个 fixture 各 9 行，共 18 行）：

first-transfer fixture，gap 05–13，全部 `resume=refused: cannot read run artifacts` → `resume=accepted`，例：
```
-   "gap 11 | T=e2 O=e2 R=absent M=v2 P=TOR | resume=refused: cannot read run artifacts | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
+   "gap 11 | T=e2 O=e2 R=absent M=v2 P=TOR | resume=accepted | recovery=ok | after T=e2 O=e2 R=e2 M=absent P=---",
```
double-transfer fixture，gap 05–13，从**两条 eligibility 判据的拒绝**变成 accepted，例：
```
-   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | …",
+   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | …",
```
gap 01–04（marker 不可解析／pending 缺失）**仍然 refused** —— 恢复本身 fail-closed，修法没有动它。

**为什么我停下来问人，而不是自己改那 18 行**：
1. brief 说这条修法「不改任何现有断言」，**实测证明这句不成立**；改那 18 行＝动「第五个具名例外点名之外的既有判据」，
   brief §3 明令不许，要停下来问。
2. 那条矩阵测试**自己的注释**（fileStore.test.ts 内，紧邻 `it(` 上方）写着：
   「resumeLoop reads the owner record THROUGH recovery and the other two RAW, all inside one `Promise.all`.
   So a mid-transaction gap is seen as "post-recovery owner record + pre-recovery transfer/reconciliation".
   That interleaving is exactly what the two epoch-equality criteria in `evaluateResumeEligibility` exist to
   refuse, and it is why the double-transfer fixture … is what makes them load-bearing.」
   —— 也就是说，**这个交错在既有设计里是被当成有意的**，而且是让那两条 epoch 判据成为承重判据的唯一来源。
   修法把交错消掉，等于同时改了那两条判据的承重性。这不是我能单方面决定的。
3. 修法在「事务可恢复」的格子上**放行了更多 resume**。`src/persistence/fileStore.ts` 里引用的 2026-08-02 人裁立场
   **S-3「never permit more」**曾据此否掉过另一处改动。本次算不算它的例外，必须由人裁。

**给裁决者的落地方式（一步）**：`git cherry-pick f584bb6`，然后把 fileStore.test.ts 矩阵里那 18 行的
`resume=refused…` 改成 `resume=accepted`（差异逐行如上，无需再跑一遍就能写对；但仍建议改完重跑）。

日志：`24-unfixed-red.log` / `24-fixed-green.log` / `24-fixed-filestore.log`（106 行，整份落盘）。

## 7. 最终验证（全套件 ＋ typecheck ＋ build，未过滤，RUN 路径已核）

分支尖端 `5026bea`（＝ 2.1/2.2/2.3 全部落地，2.4 已 revert）。环境 `ECC_GATEGUARD=off DISABLE_OMC=1`，全部 `rtk proxy`。
整份落盘 ＋ 整份读回：`final-test.log`（134 行）、`final-typecheck.log`、`final-build.log`。

RUN 路径已核（日志第 6 行）：
`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix` —— 是本工作区，不是主仓库。

```
 Test Files  31 passed (31)
      Tests  529 passed (529)
   Start at  20:21:14
   Duration  17.00s (transform 2.32s, setup 0ms, collect 4.29s, tests 61.62s, environment 4ms, prepare 1.79s)
TEST_EXIT=0
```
- **529 = 基线 524 ＋ 新增 5**（2.3(a) 三条 ＋ 2.2 两条）。2.4 的那条回归判据随 revert 一起不在树上，所以不计。
- **零失败**：基线里允许的 flake (B)（`records env names only and tracks descendants rooted at the spawned pid`）
  本次是绿的（2825ms 通过）。挂账的另三条也全绿。**没有任何跳过、没有任何 `.skip`、没有任何被我放过的失败。**
- `npm run typecheck` → `TYPECHECK_EXIT=0`
- `npm run build` → `BUILD_EXIT=0`

## 8. 我没做的 / 我被挡住的 / 需要问人的

**需要人裁的（1 件，唯一一件）**
- **2.4 的落地**。修法与判据都已做好、双向实测过，但它把既有 crash-gap 矩阵打红 18 行（§6 有逐行实测）。
  要不要接受那 18 行从 refused 变 accepted、以及它与 S-3「never permit more」的关系，**请人裁**。
  裁完 `git cherry-pick f584bb6` 即可，改法在 §6 末尾。

**据实报告的越界风险（1 件）**
- 2.2 为了数取锁尝试次数，我在 `tests/persistence/fileStore.test.ts` **既有的** `vi.mock("node:fs/promises")`
  工厂里加了一个 `open` 透传 spy。纯观察、全转发、默认行为零改变（同文件 79 条全绿可证），
  但它确实不是「只加一个新 `it`」。若评审认为这也算动共享夹具、需要另一种数法，请指出。

**brief 点名不做的，确实一件没做**
- C-1（跨进程锁）**只加勘误，没修**。`acquireOwnerTransferLock` / `tryRecoverStaleOwnerTransferLock`
  一行产品代码没碰（分支尖端 `src/` 的非注释 diff 为空，§2 有实测命令与输出）。
- 待裁点 A / B / C：没碰。
- 结构判据解析范围：**没有**扩大（只把自陈边界写实）。
- 第五个具名例外点名之外的既有判据：**没有**动（两条自指断言原样保留，§5 有 grep 实测）。
- 包 1（`.superpowers/sdd/2026-08-07-pkg1-l5-spec/`）：没碰。
- 没有 push、没有建/删分支、没有合并、没有开门。主仓库与 `.worktrees/bdesign` 全程没碰。

**我没有做的（brief 也没要求，但说明一下免得被当成隐瞒）**
- 没有为 2.1 的三处注释新增任何判据（它们是注释，本来就没有变异面）。
- 没有跑覆盖率、没有跑 lint（本仓库的验证三件套就是 test/typecheck/build）。

## 9. 预算：harness 可数事实（不要自报估计）

**拿不到精确 token 数**：harness 只向我回报过美元口径的会话累计提示（形如
`COST CRITICAL: session total ~$64.10 (over $50)`，且该数字在我这一段工作里没有再刷新过），
它既不是本任务的增量，也不是 token 计数。**我不自报估计。**

可数事实：
- 全套件跑（`npm test -- --run`，31 个文件）：**2 次**（基线 1、最终 1）。
- 单文件/单名过滤跑（`npx vitest run <file>` 或加 `-t`）：**11 次**（2.3a 三次、2.3b 四次、2.2 三次、2.4 …见下）。
- `npm run typecheck`：**5 次**（基线 ＋ 每个改动点各 1）。`npm run build`：**2 次**（基线、最终）。
- 变异次数：**5 次**（守卫放行三终态 1；`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3→2 1；
  `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS` 50→40 1；`RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3→1 1；
  2.4 的修法本身作为「反向变异」1）。每一次都配了还原后的绿。
- 落盘日志：`scratchpad/logs/` 下 **23 个 `.log`**（含 4 个 typecheck 中间日志），全部未过滤。
  完整路径：`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/c74add88-b8d0-4cb8-8759-2160067337a8/scratchpad/logs/`
- 改动文件（分支尖端 `5026bea`，`git diff --stat 9392ce6..HEAD`，411 insertions / 5 deletions）：
  - `src/controller/ownedRunStateWriter.ts`（+20/-1，**纯注释**）
  - `src/persistence/fileStore.ts`（+16，**纯注释**）
  - `tests/controller/runLoop.integration.test.ts`（+188）
  - `tests/persistence/fileStore.test.ts`（+158）
  - `tests/controller/leaseLifecycle.integration.test.ts`（+19/-3）
  - `tests/controller/resumeLoop.integration.test.ts`（+15/-1）
  - （另：`f584bb6` 里改过 `src/controller/resumeLoop.ts` 与 `tests/controller/resumeLoop.integration.test.ts`，
    已被 `5026bea` revert，不在分支尖端。）
- commit：**3 个**（`38d4a33` 2.1–2.3；`f584bb6` 2.4 修法＋判据；`5026bea` revert 2.4）。

---

# 第二轮（人裁 50–55）

## R2-0. 结论（最先填）

| 任务 | 状态 | 关键实测 |
|---|---|---|
| **1. C-1 走 O1(a) 原子发布（`link`）** | **DONE** | 双进程争用：**基线 140 → 修后 0**；**必命中对照（修后构建）10 > 0**；**必不命中对照 0**；退回两步发布的判据**红在断言**，还原绿 |
| **2. resume 读顺序 ＋ 18 行判据** | **DONE** | `f584bb6` 已 cherry-pick（`17b40d6`）；18 行逐行改完；**逐 gap 实测**了「accepted 之后磁盘是什么」；9+9 拆分与 S-3 逐句指认写进了代码注释 |
| **3. `vi.mock` 共享工厂原样退回（人裁 55）** | **DONE** | 工厂与包 2 之前**逐字节相同**（`diff` 实测 `FACTORY_IDENTICAL_TO_BASE`）；2.2 两条判据重测：`3→1` **红在断言**，还原绿；新夹具**与不打桩路径行为一致**（测内对照断言） |
| **4. Low-1 / Low-2 / Low-3 / Low-4** | **DONE**（全部只改措辞／留档） | 见 R2-4 |

**最终验证（分支尖端 `330b252`，未过滤、整份读回，`RUN` 路径已核为本工作区）**
`npm test -- --run` → **TEST_EXIT=0，31/31 文件，531/531 测试全绿**（上一轮 529 ＋ 本轮 2 条新判据）；
`npm run typecheck` → **0**；`npm run build` → **0**。**零跳过、零失败、无 flake 命中**。

**⚠️ Rule 12 —— 一件必须说清楚的越界风险（请裁）**
人裁 50 的产品改动**打红了一条 brief 未点名的既有测试**：
`recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker`。
原因是**机制性的**：它的夹具钩在 `open(lockPath)` 上（用来把 reader A 暂停在"锁已写好"的瞬间），
而 O1(a) 之后**生产代码再也不会 `open` 锁路径**（改由 `link` 发布）⇒ 钩子永不触发 ⇒ 它以自己的具名超时红掉，
**而它守的不变量其实完好无损**。
我做的处置：**只把钩子从 `open` 移到 `link`（同一瞬间：锁已完整落盘、A 尚未离开临界区），
断言一条没动、夹具语义没动**，并在测试里把原钩子与原理由**逐字引用保留**。
这不在人裁 51 点名的 18 行内，属于人裁 50 的**未预见连带**。**若认为需要单独授权，请裁；我不替人消解。**

## R2-1. 任务 1 —— C-1 的原子发布（人裁 50/52）

**改法**（`src/persistence/fileStore.ts`，`acquireOwnerTransferLock`）：
内容先写进**每进程／每次尝试唯一**的 staging 路径（`buildAtomicTempPath(lockPath)`，用 `"w"` 而非 `"wx"`
—— 该路径专属本次尝试，放一个无意义的 EEXIST 出去会被下面的 catch 误读成锁争用），
再用 `await link(stagingPath, lockPath)` 做**原子 test-and-set**，随后 `safeUnlink(stagingPath)`。
- ⛔ `tryRecoverStaleOwnerTransferLock`：**一行未动**（实测：分支 diff 内该函数无改动）。
- ⛔ `release()`：**一行未动**（仍是 `handle.close()` ＋ `safeUnlink(lockPath)`；handle 现在开在 staging inode 上，
  `link` 之后与 `lockPath` 同 inode，语义不变）。
- EEXIST 之后的既有流程（`tryRecover…`／`attempt<2`／`OwnerTransferLockBusyError`）**保持不变**；
  非 EEXIST 的 errno 仍原样外传。
- **临时文件不泄漏**：成功路径 `safeUnlink(stagingPath)`；任何失败路径由内层 `catch` 关句柄 ＋ `safeUnlink(stagingPath)`
  后再抛；`open` 本身失败则根本没有临时文件。

**平台口径（人裁 52）写进了仓库两处**：
1. 源码注释逐字写明依赖 POSIX `link(2)`「if the link named by the new argument exists, link() shall fail」
   的原子语义，目标平台 = **darwin + linux**，Windows 不是目标；
2. `package.json` 加了 `"os": ["darwin", "linux"]`。
   **理由（brief 要求做了或没做都要说）**：这是同一句话的机器可读形式，能让 win32 上的 `npm install` 直接
   `EBADPLATFORM` 失败，而不是装完之后在运行期踩一把不原子的锁。**代价我也说明**：win32 上安装会因此失败
   —— 这正是意图，但它是一个我**无法在本机实测**的后果（本机是 darwin），据实标注。

### 三条验收硬条件（全部实测，日志整份落盘）

**探针**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/`（已入库，`run.mts` / `child.mts` / `stager.mts` / `truncator.mts`）。
两个**真 Node 进程**（`tsx`，各自独立进程）通过**生产入口** `affirmOwnerLease` 反复取放锁。
**没有人工加宽窗口，没有手植 0 字节锁** —— 所有锁文件都是 `fileStore.ts` 自己创建的。

*** **⚠️ 第一版探针被我自己废掉了，这一点必须留档** ***：它统计的是「两个进程调用区间重叠」，
而**必不命中对照（无 staged 残留，偷锁分支不可达）也报了 4364 次**
⇒ 那个指标量的是调用交错、不是互斥破坏。**坏探针不能证明任何事**，所以换成下面这个不需要时钟的指标。

**指标 = 丢失更新（lost update）**：`affirmOwnerLease` 在锁内做 CAS（读 → 比对 `expected` → 写后继），
调用方提供后继的戳，所以每个进程给自己的写打全局唯一 id。
**互斥成立 ⇒ 成功的写构成一条链，任何 base 值只能被消费一次**；
两个进程同时进到锁内，就会读到同一个 base 并双双写成功 ⇒ **同一个 base 被消费两次**。
该指标**只会少算不会多算**（偷到锁但两段临界区没交错到"读在写前"时不计），所以「修后 = 0」是安全方向，
而"少算"的风险由必命中对照兜住。

| 跑法 | 构建 | staged 残留 | 外部截断 | **互斥破坏次数** | 判定 |
|---|---|---|---|---|---|
| **BASELINE** | 未修（两步发布） | 有 | 无 | *** **140** *** | 缺陷成立 |
| **必不命中对照** | 未修 | **无** | 无 | **0** | 指标不会乱开火 ⇒ 指标可信 |
| **修后** | O1(a) | 有 | 无 | *** **0** *** | 修法成立 |
| *** **必命中对照** *** | **O1(a) 修后** | 有 | **有**（第三进程持续把锁截成 0 字节） | *** **10** *** | **修后构建上探针仍能开火 ⇒ 上面的 0 不是假阴性** |

（各跑 5s；日志：`probe2-baseline-staged.log` / `probe2-baseline-nostaged.log` / `probe2-fixed-staged.log` /
`probe2-fixed-truncated.log`，另存有被废弃的第一版 `probe-baseline-*.log` 两份。）

⚠️ **必命中对照的 10 次同时说明一件事，必须明说**：C-1 的**另一半仍然开着** ——
`tryRecoverStaleOwnerTransferLock` 的 `catch` 分支照样会夺走活持有者的锁，只要锁**由外部原因**变得不可解析。
本轮按人裁 50 **只做 (a)**，那一半是待裁点 B。

### 第三条：把实现退回两步发布必须红在断言

新判据（`tests/persistence/fileStore.test.ts`）：
`the owner-transfer lock is published atomically, never as an empty file that fills in later >
has parseable content at the first instant the lock path exists`。
用**局部** `vi.doMock` 包住 `open` 与 `link`，在两者中**任意一个让锁路径出现的瞬间**用 `readFileSync` 同步读回内容
（同步是关键：一旦 `await`，生产代码的下一步就把零字节瞬间抹掉了）。
另有反空转断言 `expect(sightings).toHaveLength(1)`（坏探针不能证明"没看到"）。

- **变异（退回两步发布：`open(lockPath,"wx")` ＋ 去掉 `link`）**：
```
 × has parseable content at the first instant the lock path exists
   → expected { empty: true, parseable: false } to deeply equal { empty: false, parseable: true }
 Tests  1 failed | 79 skipped (80)     EXIT=1
```
**红在断言**（`toEqual`），不是异常/超时。
- **还原**：`80 passed (80)`，`EXIT=0`。

## R2-2. 任务 2 —— resume 读顺序与那 18 行（人裁 51/54）

`f584bb6` 已 cherry-pick 为 `17b40d6`（产品改动 ＋ 上一轮那条**在未修代码上红在断言**的回归判据，原样保留）。

### (a) 逐 gap 举证：为什么 `accepted` 是正确终态（**实测，不是论证**）

把矩阵**临时**加了一列 `afterResume`（resume 尝试之后再快照一次磁盘），跑完即还原
（还原实测：`grep -c afterResume` = 0，且随后整份 fileStore 80/80 绿）。测得：

| gap | 夹具 1（first-transfer）resume 后磁盘 | 夹具 2（double-transfer）resume 后磁盘 |
|---|---|---|
| 05 / 06 / 07 | `T=e2 O=e2 R=e2 M=absent P=---` | `T=e3 O=e3 R=e3 M=absent P=---` |
| 08 / 09 / 10 | `T=e2 O=e2 R=e2 M=absent P=---` | `T=e3 O=e3 R=e3 M=absent P=---` |
| 11 / 12 / 13 | `T=e2 O=e2 R=e2 M=absent P=---` | `T=e3 O=e3 R=e3 M=absent P=---` |
| **01–04（对照）** | `afterResume` **＝ staged 原样**（磁盘未被碰） | 同左 |
| **14（对照，本来就 accepted）** | `T=e2 O=e2 R=e2 M=absent P=---` | `T=e3 O=e3 R=e3 M=absent P=---` |

⇒ **每一个 gap 的 accepted 都落在"事务被完整提交、三个文件 epoch 一致、marker 与 pendings 都被回收"的终态上**，
且**与 gap 14 的终态逐字相同** —— 而 gap 14 在我动手之前就是 `accepted`，矩阵注释自己称在那格上「refusing would be
the bug, not the guard」。所以这不是"放宽后勉强能跑"，而是**resume 现在是在一笔已提交的事务上做判定，而不是在半笔上**。
**gaps 01–04 仍然 refused 且磁盘零改动**，说明放行只发生在"事务可完成"的格子上。
⛔ 以上没有一句用到"人已授权"。

### (b) 9 + 9 拆分（原样分开，不合并）

- **first-transfer 夹具的 9 行**（gap 05–13）：原判决是 `refused: cannot read run artifacts`。
  *** **这是缺陷自产的假拒绝** *** —— ENOENT 打在一个"正在飞行中的恢复马上就会发布"的文件上。
  改它**只是删掉一个 bug 造出来的错误拒绝，不新增任何许可**。
- **double-transfer 夹具的 9 行**（gap 05–13）：原判决是**两条 `evaluateResumeEligibility` epoch 判据**的拒绝
  （`published eligibility has been superseded…` ×3、`reconciliation newOwnerEpoch does not match…` ×6）。
  *** **这才是真正的「新增许可」** ***，也是需要人裁 54 的那一半。

### (c) S-3 逐字指认（`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md:120`）

- **被本次改动推翻的那一句**：「**只增加拒绝，绝不新增许可**」——
  在 double-transfer 的那 9 行上，本次改动**确实新增了许可**。人裁 54 已知情拍板，**不是静默覆盖**：
  该判定连同 9+9 拆分已写进 `fileStore.test.ts` 那条测试的注释里。
- **没有被推翻、且仍然成立的那一句**（同一段）：「放松 `resumeLoop` 对 reconciliation 的必需性
  （例如「若存在则校验，不存在则跳过」）…**缺失即拒绝的 fail-closed 行为必须保留**」——
  *** **本次改动没有跳过任何缺失的 reconciliation** ***：它仍是必需的、仍然被读；变的只是**读的时刻**
  （挪到发布它的恢复之后）。gaps 01–04 就是这条仍然成立的实证。

### (d) 更正上一轮 §6 的假陈述（评审员 Imp-2）

上一轮报告 §6 第 2 点写「**而且是**让那两条 epoch 判据成为承重判据的**唯一来源**」——
*** **这句是假的，现予更正** ***：`tests/controller/resumeLoop.gate.test.ts` **直接断言这两条判据**，
打上本次改动后仍 **27/27 全绿**（本轮实测，见 `t2-affected-green.log`）。
准确表述是：**realistic-crash 交错下的承重覆盖没了，单元层的直接覆盖仍在**；
而且 18 行里**有 9 行本就是假拒绝**。矩阵注释里也已写明这一点（它自己只作过更窄的主张）。

## R2-3. 任务 3 —— `vi.mock` 共享工厂退回（人裁 55）

- 共享工厂**已原样退回**。实测（不是眼看）：
```
diff <(sed -n '/^const renameSpy/,/^});/p' <dbac288 版>) <(同段 <当前>) && echo FACTORY_IDENTICAL_TO_BASE
→ FACTORY_IDENTICAL_TO_BASE
```
- 新观测手段：`withLockAttemptCounter(runDir, body)` —— **局部** `vi.resetModules()` + `vi.doMock("node:fs/promises")`
  + 动态 import（本文件的 crash-gap 矩阵与两读者竞态测试早就用这个 seam），只包 `link`，**计数在调用之前自增**
  （输掉 EEXIST 的那次尝试也算一次），全部转发。
- **Imp-1 的理由已改对**：现在的等价关系是 *** **一次「link 到锁路径」＝ 一次取锁尝试** ***
  —— `acquireOwnerTransferLock` 每次循环迭代恰好发布一次 `link`，**包括内层 `attempt<2` 的那次迭代**。
  上一轮那句「一次 open ＝ 一次尝试」被评审员实测证伪（可偷的锁上一次重试迭代 = 2 次 open），已删除。
  `toBe(3)` 旁边另注明它依赖**"锁被活进程持有"**这个夹具前提。
- **重测（硬条件）**：`RECONCILIATION_LOCK_RETRY_ATTEMPTS 3→1`：
```
 × retries a busy owner-transfer lock … once it clears
   → expected [ 'reconciliation_write_abandoned' ] to not include 'reconciliation_write_abandoned'
 × abandons the reconciliation publish … after exactly three lock attempts
   → expected 1 to be 3 // Object.is equality
 Tests  2 failed | 78 skipped (80)   EXIT=1
```
**两条都红在断言**；还原 `3` 后 `2 passed`，整份文件 `80 passed (80)`。
- **新夹具没有改变被测行为（硬条件）**：耗尽那条测试里加了**测内对照** ——
  同一场景再跑一遍，走**未打桩、静态 import 的** `writeBoundaryArtifacts`，
  然后把三项可观测（abandon 事件条数 / reconciliation 是否发布 / boundary-analysis 状态）**与打桩那次逐项相等断言**。
  它今天绿，即"打桩与不打桩行为一致"。

## R2-4. 任务 4 —— 四条 Low

- **Low-1（勘误二的时间限定）**：`IS FALSE AFTER D2` → 改为**「写下那个词的当时就已经为假」**，
  并说明 D2 没有引入该窗口（它是两步发布形状的固有属性）。同处补了第二条勘误：该窗口**现已关闭**（人裁 50），
  仍然开着的是 `catch` 分支那一半（待裁点 B）。
- **Low-2（人裁 13 被说窄）**：改为「ruling 13 是一次**具名扩权**，授权包 2 **改这条判据本身**，改名只是其后果之一」。
- **Low-3（第三条常数断言算术上是死的）**：**明说它是文档性断言** —— 前两条钉死 3 与 50 之后，
  `(3-1)*50` 恒为 100，**它永远不可能第一个失败、变异检出力为 0**；保留是因为它写出了人裁 38 真正批准的那个量
  （约 100ms 总退避），**但它不是执行机制，前两行才是**。
- **Low-4（`vi.mock` 越界的事实与处置留档）**：事实（工厂引入于 `fb62714`，早于包 2 基点 `e42e062`，
  两种口径都判越界；但它没有改任何既有 `expect`）＋ 处置（人裁 55 判退回，本轮已退回并换成局部 seam）
  **同时写在了报告这里和 `withLockAttemptCounter` 的注释里**。

## R2-5. 我没做的 / 我被挡住的 / 需要问人的

1. *** **两读者竞态测试的夹具钩子（`open` → `link`）** *** —— 见 R2-0 结尾。**这是本轮唯一的越界风险，请裁。**
2. **C-1 的另一半没修**（`tryRecoverStaleOwnerTransferLock` 的 `catch` 分支不查死活）——
   人裁 50 明令只做 (a)，我一行没碰；必命中对照的那 10 次就是它仍然开着的实测证据。
3. `package.json` 的 `"os"` 字段在 **win32 上的后果我无法在本机实测**（本机 darwin），只做了口径声明。
4. 人裁 53 的三件新账（第二出口 / `release()` / 重复测试块）**归控制器写台账，我没写**。
5. 待裁点 A / B / C 没碰；包 1 没碰；没有 push / 建删分支 / 合并 / 开门。

## R2-6. 预算：harness 可数事实（不自报估计）

**拿不到精确 token 数**：harness 只回报会话累计美元口径提示，不是本任务增量、也不是 token 计数。
可数事实：
- 全套件跑：**1 次**（最终）；单文件/单名过滤跑：**11 次**。
- `npm run typecheck`：**4 次**；`npm run build`：**1 次**。
- 双进程探针跑：**6 次**（废弃指标 2 次 ＋ 现行指标 4 次）。
- 变异：**3 次**（退回两步发布 1；`RECONCILIATION_LOCK_RETRY_ATTEMPTS 3→1` 1；矩阵临时加列 1），各自都有还原。
- 本轮改动文件：`src/persistence/fileStore.ts`、`src/controller/resumeLoop.ts`（cherry-pick）、`package.json`、
  `tests/persistence/fileStore.test.ts`、`tests/controller/resumeLoop.integration.test.ts`（cherry-pick）、
  `tests/controller/leaseLifecycle.integration.test.ts`、`tests/controller/runLoop.integration.test.ts`、
  新增 `.superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/*.mts` 四个。
- 本轮 commit：**3 个**（`501194b`、`17b40d6`、`330b252`）。

---

# 第三轮（人裁 56/57）

## R3-0. 结论（最先写）

| 任务 | 状态 | 先红后绿双向实测 |
|---|---|---|
| **1. Imp-1 —— 修掉本轮自己引入的泄漏路径** | **DONE** | 未修副本上 **2 条判据全红、且都红在断言**；修后 fileStore **82/82 绿** |
| **2. Imp-2 —— 把举证落进套件（`afterResume` 列）** | **DONE** | 读顺序退回 `Promise.all` ⇒ 矩阵**红在 `expect.soft(...).toEqual`**；还原绿 |
| **3. Low-1~Low-4（只改措辞／补文档）** | **DONE** | 见 R3-3 |

**人裁 56 记明**：两读者竞态测试的夹具 hook 从 `open` 移到 `link`，**已被追认为第七个具名例外**
（沿用人裁 17「改夹具 ≠ 改判据」）。**本轮未再改动该 hook**，只按 Low-1 改了它那句诊断措辞。

**最终验证（分支尖端 `179d776`，未过滤、整份落盘、整份读回，`RUN` 路径已核为本工作区）**
`npm test -- --run` → **TEST_EXIT=0，31/31 文件，533/533 全绿**；
`npm run typecheck` → **0**；`npm run build` → **0**。

**逐文件计数比对（第二轮 531 → 第三轮 533）**：**31 个文件全部对齐，无一下降**，
唯一变化 `tests/persistence/fileStore.test.ts` **80 → 82**（＋2 ＝ Imp-1 的两条新判据）。
（脚本对两份完整日志逐文件比对，`files that DROPPED: none`。）

⚠️ **Rule 12 自曝**：最终全套件跑完后，我第一次是用 `sed -n '/Test Files/,$p'` **看**日志尾部的 ——
**这违反「过滤显示与过滤落盘同罪」**。当场改正：整份 157 行读回（`r3-final-test.log`），
本节所有结论都出自那次完整读回。

## R3-1. 任务 1（Imp-1）—— `link()` 之后的 staging 清理

### 先读先例（brief 明令，Rule 11）
`writeJsonFileAtomically` 对同类 staging 清理写着：
「Best effort, and **intentionally not safeUnlink**: cleanup here runs while an error is already in
flight, and a cleanup failure must not replace the error the caller needs to see. safeUnlink rethrows
anything that is not ENOENT, which would do exactly that.」
⇒ **与既有约定同形**：两处 staging 清理都改成 `try { await unlink(...) } catch { /* best effort */ }`
（抽成 `discardLockStaging`，因为两处一模一样）。

**成功路径需要第二条理由，且更重**，已逐字写进注释：先例那条理由讲的是「别顶替在飞的错误」，
而 `link()` 成功之后那一句的问题是 —— **锁已经发布**，抛出去就等于把一把**活锁**丢在盘上、
调用方拿不到 `release`、`handle` 永不 close，而且因为锁记录里的 pid 还活着，
`tryRecoverStaleOwnerTransferLock` **拒绝回收** ⇒ 该 runDir 的一切 owner-transfer 操作
在持有进程退出前持续 `OwnerTransferLockBusyError`。**丢一个 staging 名字是污渍，丢一把锁是停机**，所以吞掉污渍。
- ⛔ `tryRecoverStaleOwnerTransferLock`：仍未碰。⛔ `release()`：仍未碰。
- 可达性按评审员的判断照录：**仅环境类 errno**（EACCES/EPERM/EROFS/ESTALE/EIO），并发不可达。

### 判据 ＋ 双向实测
新增 `describe("a failure to clear the lock's publish staging file never costs the caller its lock")`，
用**局部** `vi.doMock` 只让 **staging 路径**的 `unlink` 抛 `EACCES`（锁路径自己的 unlink 不动，
所以 `release()` 是真的在做事）；staging 路径按**形状**匹配（`..owner-transfer.lock.` 前缀 ＋ `.tmp` 后缀），
名字由生产代码自己挑，测试不写死。

**未修（`git archive HEAD` 出的副本 ＋ 新测试；工作树全程不脏）**：
```
 × completes the claim and leaves no lock behind when clearing the staging file fails after the publish
   → expected { kind: 'threw', …(1) } to deeply equal { kind: 'completed' }
     - "kind": "completed"   + "detail": "Error: EACCES: permission denied, unlink"  + "kind": "threw"
 × still reports a busy lock, not the cleanup's errno, when the staging cleanup fails on a contended acquire
   → expected 'Error' to be 'OwnerTransferLockBusyError'
 Tests  2 failed | 80 skipped (82)   EXIT=1
```
**两条都红在断言**（`toEqual` / `toBe`），不是异常/超时 —— 第一条把 rejection 收成值再比就是为了这个。
第二条同时**实测证实了评审员那句「内层 `safeUnlink` 会用别的 errno 顶替 EEXIST」**：未修时调用方收到的是裸 `Error`。

**修后**：`tests/persistence/fileStore.test.ts` **82 passed (82)，EXIT=0**。

## R3-2. 任务 2（Imp-2）—— 把举证落进套件

`observeCrashMatrix` 现在对 **`forResume`**（真正跑过 resume 的那份副本）再拍一次 `crashSnapshot`，
并入行字符串成为 `afterResume` 列，**34 行全部带上**。
**墙钟问题**：`crashSnapshot` 只渲染**存在性与 epoch**（哪几个文件在、各自什么 epoch、marker 是否可解析、
还剩哪些 pending），**没有任何时间字段进入它** ⇒ 不会写成恒假断言。
18 格的值实测确定无抖动：first `T=e2 O=e2 R=e2 M=absent P=---`，double `T=e3 O=e3 R=e3 M=absent P=---`；
refused 的 4 格则等于 staged 原样（resume 什么都没动）。**我预填的 34 行一次通过，无需回填。**

**变异（读顺序退回 `Promise.all` 并列，在 `git archive` 副本里做）**：
```
- "gap 05 … | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | …"
+ "gap 05 … | resume=refused: cannot read run artifacts | afterResume T=e2 O=e2 R=e2 M=absent P=--- | …"
 （gaps 05–13 两个夹具共 18 行）   EXIT=1，红在 expect.soft(...).toEqual
```
还原后绿（最终全套件 533/533 已含这条）。

*** **一句必须说准的话（Rule 12）** ***：上面这次变异里，**变红的是 `resume=` 那一列，不是新加的 `afterResume` 列**
—— 因为 `readOwnerRecord` 里的恢复照跑，所以即便 resume 被误拒，磁盘仍走到已提交终态。
所以我又做了一次**针对新列**的变异（删掉 `finalizePendingOwnerTransfer` 里回收 marker 的那句 `safeUnlink`）：
```
+ "gap 11 … | afterResume T=e2 O=e2 R=e2 M=v2 P=--- | …"      （M=absent → M=v2）
```
⇒ 新列**确实跟踪 resume 之后的磁盘状态并随之变化**。
但**老实说**：这两次变异里新列都不是**唯一**变红的列，我**没有**构造出「只有 `afterResume` 红」的变异
—— 它防的是「将来某次回归让 accepted 的 resume 落在撕裂状态上」这一类，而那要人为造一个缺陷才能单独演示。
**新列的价值是守卫，不是我已经抓到过什么。**

## R3-3. 任务 3 —— 四条 Low

- **Low-1（命名超时会误诊）**：消息改成**同时点名两种回归** —— (a) unlocked-finalize 回归；
  (b) **原子发布被退回两步**（此时 hook 等的 `link` 永不发生，锁其实取到了）。
- **Low-2（悬空引用 `openSpy`）**：`busyLockRecord` 上方那句改成指向 `withLockAttemptCounter`（全仓最后一处）。
- **Low-3（`BYTE-FOR-BYTE` overclaim）**：改成「**同一个已提交终态；三个文件逐字段相同，唯一差异是墙钟
  `lastAffirmedAt`**」，并注明这与本文件自陈的「crashSnapshot does NOT compare file contents byte for byte」现已自洽。
- **Low-4（必命中对照灵敏度未记录）**：
  - `probe-c1/run.mts` 新增 **SENSITIVITY** 段：必命中对照速率约 **0.3/s**，**5s 常读到 0**，
    **须 ≥10s 并重复**，期望值是**个位数**；并说明「0」恰好也是「探针坏了」的形状，别据此误判。
  - 参数 `truncated` 且 `durationMs < 10000` 时**打印 stderr 警告**（不用读注释也能看见）。
  - **自报绝对值已改成可复现表述**：源码与测试注释里的「140 / 0」改为
    「修前每 5s **数百**量级（本机 140；独立评审员另测 137/213/252），修后**数千个 CAS base、零违规**」，
    并写明**结论靠的是两臂之差，不是任何单一数字**。
  - 本轮复测（10s）：`mutualExclusionViolations: **6**`，3195 个 base —— 与评审员的 1–4 同量级。
  ⚠️ 第二轮报告里的「10」**不撤销、就地勘误**（本仓库惯例）：那个数在 5s 下**不可复现**，以本节表述为准。

## R3-4. 我没做的 / 被挡住的

1. **没有构造出只让 `afterResume` 单独变红的变异**（见 R3-2 末尾），据实说明。
2. **Imp-1 的真实触发我没造出来**（评审员也没有）：EACCES/EROFS/ESTALE 是环境事实，
   我是**用注入的 errno** 测的路径，不是真造出只读挂载。判据本身是实测，触发条件是注入。
3. **C-1 另一半仍未修**（`tryRecoverStaleOwnerTransferLock` 的 `catch` 分支不查死活）—— 待裁点 B，未碰。
4. 人裁 53 的三件新账仍归控制器写台账；待裁点 A/B/C、包 1 未碰；没有 push / 建删分支 / 合并。
5. 全程**变异只在 `git archive` 出的副本里做**（`scratchpad/unfixed`、`scratchpad/mut2`），工作树未脏；
   每次跑完 `git status --short` 只显示我自己的正式改动。

## R3-5. 预算：可数事实（不自报估计）

**拿不到精确 token 数**（harness 只回报会话累计美元口径提示，不是本任务增量）。
- 全套件跑：**1 次**；单文件/单名过滤跑：**5 次**；`typecheck` **2 次**；`build` **1 次**；探针跑 **1 次**（10s truncated）。
- 变异：**3 次**（Imp-1 未修副本 1；读顺序退回 1；marker 回收删除 1），**全部在 archive 副本里**，无需还原工作树。
- 改动文件：`src/persistence/fileStore.ts`、`tests/persistence/fileStore.test.ts`、
  `.superpowers/sdd/2026-08-07-pkg2-data-loss/probe-c1/run.mts`（＋本报告）。
- 本轮 commit：**1 个**（`179d776`）＋ 报告 commit。
