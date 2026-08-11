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
