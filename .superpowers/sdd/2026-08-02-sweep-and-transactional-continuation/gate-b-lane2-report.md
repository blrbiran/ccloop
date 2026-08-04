# GATE-B lane 2 — 变异与测试证据全量重扫 / deferred minor 分诊

**结论：PASS WITH CONDITIONS。**

范围 `a7c26c9..6935578`（`dab1040` / `b427c8b` / `6935578`），worktree
`.claude/worktrees/l3-debt3-heartbeat-stop`。本车道不评估方案 (a) 的对错（lane 1 的活），
只评估「这条分支声称被验证过的东西是否真的被验证过」。

环境：`ECC_GATEGUARD=off DISABLE_OMC=1`，命令走 `rtk proxy`，单跑用裸 `it` 名，输出未过滤。

---

## 1. 变异实验全量重扫

**实际条数 = 7，与交办口径一致**（B1 五条 + B2 两条）。B1 的编号在报告里从「变异三」跳到
「变异五」（没有「变异四」），因为控制器补充的那条被命名为「变异 1b」；这是命名不连续，
不是漏做。**没有发现「声称做了但没做」的条目。**

| # | 任务 | 注入内容（生产代码） | 具名测试 | 三步齐 | 具名非零计数 | 红在报告声称的断言？ | 红的机制 = 声称的机制？ |
|---|---|---|---|---|---|---|---|
| 1 | B1 | `leaseHeartbeat.ts`：`queue.then(refuseIfStopped, refuseIfStopped)` → `queue.then(fn, fn)` | 测试 7 `refuses runExclusive after stop, throwing RunHeartbeatStoppedError` | ✅ a/b/c | ✅ `1 passed\|21 skipped` / `1 failed\|21 skipped` / `1 passed\|21 skipped` | ✅ `:370` `rejects.toBeInstanceOf` | ✅ promise 解决为 `"must not run"`，即拒绝确实消失 |
| 1b | B1 | `refuseIfStopped` 内判定挪到 `await fn()` **之后** | 同上 | ⚠️ b/c 新跑，**(a) 直接复用 1(c) 的那份输出**（以「代码逐字节相同」为理由） | ✅ 同上三段 | ✅ `:371` `expect(fn).not.toHaveBeenCalled()` | ✅ spy 被调 1 次；且 `:370` 仍绿 —— 正是「可达性核验点名的脆弱前提被违反」的形状 |
| 2 | B1 | **两处协同**：专属分支失效（`&& Boolean(process.env.MUTATION_2_OFF)`）＋ `isLeaseStopError` 加宽 | 7b `returns a resumable state without terminating the run when the heartbeat stops mid-attempt` | ✅ a/b/c，另加 (b2)：变异在位下把 (i)(ii) 断言临时注释掉以让 (iii) 独立红 | ✅ `1 passed\|53 skipped` / `1 failed\|53 skipped` / `1 passed\|53 skipped` | ✅ (b) `:1209` 事件列表；(b2) `:1230` `RESUMABLE_STATUSES` | ✅ `loop_cancelled` 取代 `heartbeat_stopped` = 计划警告的那次永久终结。**我亲手复跑复现（见 §2A）** |
| 3 | B1 | `lease.ts`：`extends Error` → `extends RunLeaseLostError` | `RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either` | ✅ a/b/c，另加 (b2) 证明同一变异下 7b 仍绿 | ✅ `1 passed\|21 skipped` 系列 | ✅ `:752` `instanceof RunLeaseLostError` | ✅ 且 (b2) 的「7b 察觉不到」正面证明了这条断言不冗余 |
| 5 | B1（修复轮） | 删掉新分支自己的 `await writeRunState(runDir, state)` | 7b | ✅ a/b/c | ✅ `1 passed\|53 skipped` / `1 failed\|53 skipped` / `1 passed\|53 skipped` | ✅ `:1216` `expect(persisted).toEqual(finalState)` | ✅ 唯一差异 `budgetSnapshot.timeRemainingMs` 磁盘 19 / 返回 0，与 `applyPhaseUsage` 只动内存的推演逐字吻合。已由 scoped re-reviewer 二次复跑 |
| B2-1 | B2 | 槽从 `while(true)` 顶端移到 attempt 内部 `leaseLoss.lost !== null` 之后（retryable 路） | 测试 8 `returns a resumable state at the loop top when the stop signal is set, without spending an attempt` | ✅ a/b/c（还原以 scratchpad pristine `diff` exit 0 佐证） | ✅ `1 passed\|54 skipped` / `1 failed\|54 skipped` / `1 passed\|54 skipped` | ✅ `:1304` `expect(planCalls).toBe(0)` | ✅ `planCalls` 收到 **1**（不是 2）＝ 恰好花掉一个 attempt，是精确击杀。**我亲手复跑复现（见 §2B）** |
| B2-2 | B2 | `leaseHeartbeat.ts` 的 `stop()` 里整块删掉 `releaseOwnerLease` 的 try/catch | 8b(i) `stays eligible immediately after a stop_requested run releases its lease` | ✅ a/b/c（`diff` pristine exit 0 ＋ `git status --porcelain` 不含该文件，两条独立证据） | ✅ `1 passed\|26 skipped` / `1 failed\|26 skipped` / `1 passed\|26 skipped` | ✅ `:252` `expect(owner.leaseAffirmedAt).toBeNull()` | ✅ Received 是**当次跑的时间戳**，同时证明 8b(i) 不是空转 |

**判定：7 条全部三步齐全、全部具名非零计数、全部红在声称的断言上、全部红的机制 = 声称的机制。
没有一条是「因错误理由而红」。**

### 1.1 三条证据卫生问题（不推翻任何一条击杀，但必须点名）

- **E-1（变异 1b）**：步骤 (a) 没有独立跑，直接引用变异一的 (c)。理由（「代码状态逐字节相同」）
  成立，但这使得 1b 的三步判据严格来说是「2.5 步」。**不阻塞**——1b 的 (b) 的红本身就蕴含
  注入前该断言是绿的（`:370` 在 (b) 里通过、`:371` 才红）。
- **E-2（变异二的 (b2)）**：那次注释掉 (i)(ii) 的**测试侧**改动，报告给出的还原证明是
  `grep -rnF 'MUTATION' src/ tests/` → exit 1。这条扫描**不可能命中**注释里写的 `EVIDENCE-ONLY`
  标记，也就是说**测试侧的还原当时没有被证明**。我今天读了 `6935578` 上的
  `tests/controller/runLoop.integration.test.ts`：7b 的 (i)(ii)(iii)(iv) 四块断言全部在位、
  未被注释。**事实上还原了，但当时给的证据是错的扫描**。
- **E-3（变异二）**：这条把「专属分支失效」和「谓词加宽」两处一起注入，因此**没有隔离谓词那一半的贡献**。
  这不是实施者的过错——人裁已判「计划的 mutation-2 判据前提为假」，纯谓词加宽今天行为惰性。
  记在这里只是为了让 GATE-B 的读者不要把变异二读成「谓词那一半也被守住了」。

---

## 2. 抽查复跑（我亲手注入并还原）

挑了两条我最不信的：**B1 变异二**（最复杂、两处协同、且 (b2) 的还原证据是错的扫描）和
**B2 变异一**（机制主张最细——「planCalls 是 1 不是 2」）。另做了两次**清单上没有的**探针（§3、§4）。

### 2A. B1 变异二 —— 复现，机制一致

三步全走。注入 = 专属分支加 `&& Boolean(process.env.LANE2MUT2_OFF)` ＋ `isLeaseStopError` 加宽。

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 203ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:10:27
   Duration  730ms (transform 228ms, setup 0ms, collect 261ms, tests 203ms, environment 0ms, prepare 42ms)

EXIT=0
```

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 182ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 182ms
     → expected [ 'attempt_started', …(2) ] to deeply equal [ 'attempt_started', …(2) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt
AssertionError: expected [ 'attempt_started', …(2) ] to deeply equal [ 'attempt_started', …(2) ]

- Expected
+ Received

  Array [
    "attempt_started",
    "execute_started",
-   "heartbeat_stopped",
+   "loop_cancelled",
  ]

 ❯ tests/controller/runLoop.integration.test.ts:1209:42
    1207|     // value. The event list is exact rather than a `not.toContain`, s…
    1208|     // `heartbeat_stopped` event is pinned in the same assertion.
    1209|     expect(await readEventTypes(runDir)).toEqual(["attempt_started", "…
       |                                          ^
    1210|     expect(persisted.status).toBe("executing");
    1211|     expect(persisted.stopReason).toBeNull();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 54 skipped (55)
   Start at  20:10:53
   Duration  683ms (transform 227ms, setup 0ms, collect 267ms, tests 182ms, environment 0ms, prepare 43ms)

EXIT=1
```

与报告 §4.3 (b) 逐字一致（同一断言、同一行号 `:1209`、同一 `loop_cancelled` 机制）。
计数 `54 skipped (55)` 而非报告的 `53 skipped (54)`，是因为 B2 在同文件加了测试 8，属预期。

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 173ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:12:22
   Duration  626ms (transform 192ms, setup 0ms, collect 233ms, tests 173ms, environment 0ms, prepare 43ms)

EXIT=0
```

### 2B. B2 变异一 —— 复现，机制一致

注入 = 把 `if (options?.stopRequested?.requested === true) { … }` 整块从 `while(true)` 顶端删除、
原样移到 attempt 内部 `leaseLoss.lost !== null` 之后、`continue;` 之前。

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 111ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:12:39
   Duration  582ms (transform 202ms, setup 0ms, collect 239ms, tests 111ms, environment 0ms, prepare 39ms)

EXIT=0
```

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 170ms
   × runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt 169ms
     → expected 1 to be +0 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/controller/runLoop.integration.test.ts:1304:23
    1302| 
    1303|     // No attempt was entered at all — the return happens above `const…
    1304|     expect(planCalls).toBe(0);
       |                       ^
    1305|     expect(await readdir(join(runDir, "attempts"))).toEqual([]);
    1306| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 54 skipped (55)
   Start at  20:13:00
   Duration  645ms (transform 230ms, setup 0ms, collect 259ms, tests 170ms, environment 0ms, prepare 49ms)

EXIT=1
```

`planCalls` 收到 **1**，与报告 §5.1 逐字一致。**「种子 `attemptsUsed: 0` 让击杀从『跑出终态』
升级为『恰好花掉一个 attempt』」这个论证成立**——收到 1 而不是 2，说明它确实跑完 attempt 1、
验证被拒、走了 retryable 路、停在 attempt 内部的检查点。

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 110ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:14:52
   Duration  578ms (transform 197ms, setup 0ms, collect 237ms, tests 110ms, environment 0ms, prepare 40ms)

EXIT=0
```

### 2C. 还原完整性（收尾，覆盖 §2、§3、§4 的全部注入）

```
$ rtk proxy "bash -c 'echo PORCELAIN_LINES=$(git status --porcelain | wc -l); git rev-parse HEAD; grep -rn -e LANE2 -e EVIDENCE-ONLY -e MUTATION src/ tests/; echo GREP_EXIT=$?'"
PORCELAIN_LINES= 0
6935578191e761c4200d060cbcdfb3744ab4b2a0
GREP_EXIT=1
```

工作树零条 porcelain、HEAD 仍是 `6935578`（未变）、三个标记词全仓零命中（`GREP_EXIT=1`）。
**树干净，无残留。**

---

## 3. 测试证据本身的强度

### 3.1 B1 测试 7b 的四条断言

7b 的 fixture 用的是**手搓的 stub heartbeat**（`runExclusive` 无条件抛
`RunHeartbeatStoppedError`），所以 `leaseHeartbeat.ts` 上的任何变异对 7b 都是无效的；
7b 唯一能被生产变异触及的面是 `runLoop.ts` 的外层 catch。这一点决定了下面四条的强弱。

| 断言 | 判定 | 依据 |
|---|---|---|
| **(i)** 不调 `persistTerminalState`（事件列表 `toEqual` ＋ `persisted.status`／`stopReason` ＋ `expect(persisted).toEqual(finalState)`） | **可失败** | 变异二红在 `:1209`（我复现了）；变异五红在 `:1216`。两处独立击杀 |
| **(ii)** `execution-recovery.json` 的 `cleanupStatus` 未回填（`executeEntered === true`、`cleanupStatus === "retained"`） | **实质恒真** | 见下 |
| **(iii)** 返回 state 仍在 `RESUMABLE_STATUSES` 内 | **可失败** | 变异二 (b2) 红在 `:1230`（`expected [Array(3)] to include 'cancelled'`） |
| **(iv)** `cleanupAttemptWorkspaceBestEffort` 未被调用（`pathExists(observedWorktreePath) === true`） | **可失败，但从未被演示，且被 (i) 永久遮住** | 我亲手测了，见下 |

**(ii) 为什么是恒真。** 唯一的 `cleanupStatus` 回填在 `runLoop.ts` 的
`cleanupAttemptWorkspaceWithStatus` → 条件重写 `writeAttemptArtifacts` 那一段，它位于
`persistBoundaryAnalysis` **之后**。7b 的 stub 让 `persistBoundaryAnalysis` 必抛，所以那段代码
在这条测试里**在任何外层 catch 的变异下都到不了**。要让 (ii) 红，只能删掉
`persistBoundaryAnalysis` 里的 `runExclusive` 调用——而那会先让 fixture 前置断言
`expect(runExclusiveCalls).toBe(1)` 红。**结论：(ii) 是文档，不是护栏。** 这不是缺陷，
但报告与 progress.md 把它并列为「四条断言」时不该让读者以为四条等强。

**(iv) 的实测。** 我做了一次清单上没有的探针：**只**让专属分支失效（不加宽谓词），
错误因此落到外层 catch 的通用失败处理（`transitionRunState("failed")` →
`cleanupAttemptWorkspaceBestEffort`），并**临时**把 (i)(iii) 注释掉以让执行流到达 (ii)(iv)：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 199ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 198ms
     → expected false to be true // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ tests/controller/runLoop.integration.test.ts:1233:52
    1231|     // surviving is the observable of the call never happening. Accept…
    1232|     // grounds as L1 §12 requirement 9: the residual worktree is the n…
    1233|     expect(await pathExists(observedWorktreePath)).toBe(true);
       |                                                    ^
    1234| 
    1235|     // The write persistBoundaryAnalysis performs AFTER runExclusive r…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 54 skipped (55)
   Start at  20:11:30
   Duration  748ms (transform 209ms, setup 0ms, collect 245ms, tests 199ms, environment 0ms, prepare 42ms)

EXIT=1
```

两件事一次拿到：**(iv) 真的能失败**（worktree 被通用失败路径删掉了）；**(ii) 在同一次跑里通过了**
（执行流越过 `:1223`／`:1224` 才走到 `:1233`），证实上面「(ii) 恒真」的推断。

**因此的 finding**：报告用 (b2)「临时注释断言」这一招**救活了 (iii)，却没有对 (iv) 用同一招**，
而且没有说明 (ii)(iv) 的红从未被看见。控制器补充第 2 条的精神（「两条断言各自的红都要在原始
输出里看得见」）在测试 7 上被严格执行了，在 7b 上只执行了一半。

### 3.2 B2 测试 8

- `expect(finalState.attemptsUsed).toBe(state.attemptsUsed)` ＋ **逐字节相同**的
  `loop-state.json` 比较：**可失败**，但**弱于它看起来的样子**——见 §4 对 M-1 的实测。
- `expect(planCalls).toBe(0)`／`readdir(attempts) === []`／`readEventTypes === ["stop_requested"]`：
  **可失败**（变异 B2-1 红在 `planCalls`，我复现了）。
- 「逐字节相同」的合法性前提（`initializeRunFiles` 与 `writeRunState` 同走
  `writeJsonFileAtomically`）我核了源码，成立。

### 3.3 B2 测试 8b

| 子用例 | 判定 |
|---|---|
| **8b(i)** 「必须在 TTL 之内断言 eligible」 | **可失败**。变异 B2-2 红在 `owner.leaseAffirmedAt` 收到当次时间戳，直接排除「只 `clearInterval` 的实现也能过」。至于 `Date.now() - Date.parse(lastAffirmedAt) < LEASE_TTL_MS` 那一行，它**本身**近乎恒真（只有测试跑满一个 TTL 才会红），但它的角色是**前置条件**而不是护栏，其「不是老化过期」的语义由 B2-2 独立兑现。**合格** |
| **8b(ii)** 「必须用测试侧改写 `owner-record.json` 造真实 CAS 失配」 | **形状合格，但有一条前置断言存疑**。构造方式确认为真实 CAS 失配（只改 `currentOwnerEpoch`、保留 `leaseAffirmedAt` 与键序，`sameOwnerRecord` 是 `JSON.stringify` 相等），**没有**退化成 mock `releaseOwnerLease`；我复核了 `updateOwnerRecordWithPrecondition` 的三处引用全在 `fileStore.ts` 内且定义处无 `export`（`:1134` / `:1169` / `:1184`），「不可 mock」成立。存疑处见 §5-F3 |

---

## 4. 我实测了 deferred minor B2 M-1（它是清单里最重要的一条，此前只是推理）

**M-1 的主张**：测试 8 的「逐字节相同」断言抓不住「把槽挪到 loop-top `writeRunState` **之上**」。
注意 `while(true)` 的顺序是 `writeRunState` → `affirmNow()` → `leaseLoss` 检查 → 槽，
所以「挪到 `writeRunState` 之上」必然也在 `affirmNow()` 之上——这就是 M-1 的确切变异体。

**注入**：把槽整块提到 `while (true) {` 的第一行。

**测试 8 —— 绿（M-1 主张成立，这是一个存活的变异体）**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 107ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:13:41
   Duration  589ms (transform 203ms, setup 0ms, collect 241ms, tests 107ms, environment 0ms, prepare 47ms)

EXIT=0
```

**同一变异体下整个 `leaseLifecycle.integration.test.ts`（27 条）—— 8b(i) 也绿，只有 8b(ii) 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 1 failed) 5848ms
   × lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS 99ms
     → promise resolved "{ kind: 'no_lease', …(1) }" instead of rejecting
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 505ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 434ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 502ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 383ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 359ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 387ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 372ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 353ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS
AssertionError: promise resolved "{ kind: 'no_lease', …(1) }" instead of rejecting

- Expected
+ Received

- [Error: rejected promise]
+ Object {
+   "kind": "no_lease",
+   "ownerRecord": Object {
+     "currentOwnerEpoch": 3,
+     "currentProcessInstanceId": "pid:100",
+     "lastAffirmedAt": "2026-07-25T00:00:00.000Z",
+     "logicalSessionId": "task-1:t0",
+     "ownerStatus": "current",
+     "runId": "task-1",
+     "supersededByEpoch": null,
+   },
+ }

 ❯ tests/controller/leaseLifecycle.integration.test.ts:335:96
    333|     // Inside the TTL the next sweep is refused — this is the cost the…
    334|     // asserted rather than glossed over.
    335|     await expect(checkRunLease(runDir, "pid:next-sweep:1", affirmedAtM…
       |                                                                                                ^
    336|       .rejects.toThrow(RunLeaseHeldError);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 passed (27)
   Start at  20:13:57
   Duration  6.28s (transform 165ms, setup 0ms, collect 196ms, tests 5.85s, environment 0ms, prepare 39ms)

EXIT=1
```

**读数（三件事，都不在任何现有清单上）：**

1. **M-1 的主张被实测证实**：测试 8 对这个变异体完全无感。
2. **8b(i) 也抓不住它**：`stop()` 依旧释放 `adopt` 写下的租约，`leaseAffirmedAt` 依旧为 `null`。
3. **8b(ii) 抓住了，但是「因另一个理由而红」**：红的真实原因是**顶端 `affirmNow()` 被跳过**，
   所以 `leaseAffirmedAt` 从未被写；失败消息 (`no_lease` 而不是 `RunLeaseHeldError`) 完全没有
   指向「槽被挪了」。更要紧的是——**它本该在三条断言之前就被前置断言拦下**，见 §5-F3。

**所以这个变异体不是「无人守卫」，而是「唯一守卫它的断言既不具名也不在它该报警的地方报警」。**

---

## 5. 我发现的、清单上没有的东西

- **F1 —— 7b 的 (ii) 是文档不是护栏（实测）。** 见 §3.1。progress.md 与 B1 报告把 (i)(ii)(iii)(iv)
  并列陈述，读者会以为四条等强；实际上 (ii) 在这条测试的 fixture 下没有任何可失败路径。
  **处置：不改代码，改说法**——GATE-B 的记账里应写明四条中只有两条有实测击杀。
- **F2 —— 7b 的 (iv) 可失败但从未被演示（实测：`expected false to be true` @ `:1233`）。**
  报告用「临时注释断言」的取证手法救活了 (iii)，同一手法对 (iv) 没做，也没说明为什么不做。
  **处置：把我上面那份原始输出收进 GATE-B 的证据册即可，不需要改代码或加测试。**
- **F3 —— 8b(ii) 的前置断言 `expect(affirmed.leaseAffirmedAt).not.toBeNull()` 在
  `undefined` 上通过（实测）。** §4 那次跑里 `affirmNow()` 没跑，`leaseAffirmedAt` 是
  `undefined`（所以 `JSON.stringify` 把它整个键丢掉了，见输出里 `ownerRecord` 没有该键），
  `not.toBeNull()` 对 `undefined` **返回真**，于是这条自称「没有它，下面的『释放失败』就无物可失败」
  的前置断言**空过**，测试一直跑到 `:335` 才以一条误导性的消息红。这正是本仓库反复点名的
  「前置守卫本身不能失败」那类缺陷。**处置：一行改动（`.toEqual(expect.any(String))` 或补
  `.toBeDefined()`），建议带到组 C，不阻塞合并。**
- **F4 —— 「8b(i) 是 `resumeLoop` 转发的唯一覆盖」在报告里是推理，不是实测。我把它测了，成立。**
  删掉 `resumeLoop.ts` 里的 `stopRequested: options?.stopRequested,` 后 8b(i) 红在 `:247`，
  且红的机制正是声称的那个（run 一路跑完，事件变成
  `resume_requested/resume_adopted/attempt_started/execute_started/execution_finished/loop_succeeded`）：

  ```
   ❯ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 1 failed | 26 skipped) 178ms
     × lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 177ms
       → expected [ 'resume_requested', …(5) ] to deeply equal [ 'resume_requested', …(2) ]
  ...
  - Expected
  + Received

    Array [
      "resume_requested",
      "resume_adopted",
  -   "stop_requested",
  +   "attempt_started",
  +   "execute_started",
  +   "execution_finished",
  +   "loop_succeeded",
    ]

   ❯ tests/controller/leaseLifecycle.integration.test.ts:247:42
  ...
   Test Files  1 failed (1)
        Tests  1 failed | 26 skipped (27)
     Start at  20:16:03
  EXIT=1
  ```

  （注入前绿：`1 passed | 26 skipped (27)`，`Start at 20:15:45`，EXIT=0；还原后见 §2C。）
  **这是一条本该在 B2 的 Step 7 里就存在的第三次变异**——报告自己把它当成事实陈述了。
  现在它被实测了，**不需要补做**，但形状值得记账。
- **F5 —— E-2（§1.1）**：变异二 (b2) 的测试侧还原用了错的扫描词。**已由我今日读源确认事实上还原了。**

---

## 6. deferred minor 分诊

### 6.1 五条 deferred minor

| 编号 | 内容 | 处置 | 理由 |
|---|---|---|---|
| **B1 M-2** | `describe("lease")` 块落在 `tests/controller/leaseHeartbeat.test.ts` 而非 `tests/ownership/lease.test.ts`，一个错误族的类型断言分居两文件 | **只记录** | 断言影响为零（变异三在该文件里正常击杀，我核过原始输出）；当初选 Files 名单而非测试名是正确的。等下一个允许改这两个测试文件的任务顺手迁移即可，不值得为它单开一轮 |
| **B2 M-1** | 测试 8 的「逐字节相同」抓不住槽被提到 loop-top `writeRunState` 之上；今天没有任何测试在「一个 attempt 跑完之后」才置停机信号（＝操作员按 Ctrl-C 的真实形状） | **带到组 C**（从「只记录」上调） | 我把它从推理变成了实测（§4）：测试 8 绿、8b(i) 绿、只有 8b(ii) 因**另一个**理由红。它现在是这条分支上**唯一一个有实测存活证据的变异体**。组 C 的具体要求应写成：**加一条在 attempt 1 跑完之后才置 `stopRequested` 的测试**——那一条同时兑现 M-1 和 B1 catch 分支注释所声称的「`applyPhaseUsage` 只动了内存」 |
| **B2 M-2** | 8b(ii) 没有同接线下的对照，「CAS 输是因为 supersede」是推断不是钉死 | **带到组 C**，与 M-1、F3 合并成一条 | §4 给了它实证：8b(ii) 确实会因完全无关的理由红（`affirmNow` 没跑），且消息不指向真因。F3 的一行修复正是这条的最小落点 |
| **B2 M-3** | 停机检查排在 `leaseLoss` 检查之后；计划未规定顺序，无测试区分两种顺序 | **带到组 C** | 成本是「一行 + 一条测试」，且这是本分支唯一一条**零覆盖**的顺序主张。B2 对既有路由的影响确为零（我核了源码：`leaseLoss` 分支原样保留在槽之前），所以**不阻塞合并**，但不该继续只记录 |
| **B2 M-4** | 本任务把 `resumeLoop.ts:136-137` 推到 `142-143`，两份 2026-07-27 历史文档的行号引用因此过期 | **只记录** | 本仓库的既定政策就是不改写历史过程记录，`docs/handoff/handoff.md:404` 已就这一整类立过案。不需要人裁二次决定 |

### 6.2 两条已由人裁定「不改代码」的记账项

**不重开人裁**，只判「带着它们开门是否可接受，以及由谁承接」。

| 记账项 | 带着它开门可接受吗 | 承接人 |
|---|---|---|
| **硬约束 1 的「谓词加宽」那一半没有可失败断言（靠注释承载）** | **可接受。** 依据是可复核的：谓词未导出、专属分支排在谓词分支之前并 `return`，所以纯加宽今天行为惰性（已由 task-B1-important-verification 整套件实测为绿）。风险是**延迟型**的：任何改动分支顺序 / 删除专属分支 / 让该错误逃到内层 catch 的编辑都会引爆它，而没有任何测试名会提示原因 | **组 C 的 brief 必须逐字携带**（与 open item 4 同级），**并加到 L5**。另建议 GATE-B 把一条**明确的触发条件**写进记账：「凡是改到 `runLoop.ts` 外层 catch 分支顺序的任务，必须先重跑 task-B1-important-verification 的加宽实验」 |
| **新分支的 `writeRunState` 无 CAS（`writeJsonFileAtomically` = stringify→temp→rename），今天不可达** | **可接受。** 不可达性是有具名依据的：`stopped` 只由 `stop()` 置位，其两个生产调用点（`runLoop.ts:989`、`resumeLoop.ts:198`）都在 `await runLoopFromState(...)` **之后**的 `finally` 里，而 `runExclusive` 的唯一生产调用点在 `runLoopFromState` **内部** | **L5**（人裁原话）。**但组 C 要多背一条我在这里加的义务**：若组 C 引入任何在循环**内部**调用 `stop()` 的路径（例如常驻 `watch` 形状），**必须重跑这条可达性论证**，因为它一旦可达，这次写盘就会整体覆盖新 owner 的 `loop-state.json`。现行清单只让组 C 携带 open item 4，**没有携带这条重查义务**——这是清单的缺口 |

---

## 7. 结论与条件

**PASS WITH CONDITIONS。**

七条变异全部经得起重扫：三步齐全、计数具名非零、红在声称的断言上、机制与声称一致；
我亲手复跑的两条（B1 变异二、B2 变异一）逐字复现，注入全部还原，工作树零 porcelain、
HEAD 未变、无残留标记。B2 实施者「凭记忆编 grep 输出」那次自查纠正**没有蔓延**——
我抽查的每一处数字都能用命令重推。

**开门条件（都不需要改生产代码）：**

1. 把 §5 的 F1/F2 写进 GATE-B 记账：7b 的四条断言里 **(ii) 无任何可失败路径、(iv) 从未被演示**
   （原始输出已在本报告 §3.1）。
2. 把 **B2 M-1 / M-2 / F3 / M-3** 一并写进组 C 的 brief，其中 M-1 带着 §4 的实测存活证据。
3. 组 C 的 brief 除 open item 4 外，**追加**「若引入循环内 `stop()` 调用点，须重跑 §6.2 第二行的
   可达性论证」这条义务。
4. §1.1 的 E-2（错扫描）记为证据卫生教训：**测试侧的临时改动必须用与其标记词匹配的扫描
   或 `git status --porcelain` 来证明还原，不能沿用生产侧的 `MUTATION` 定值扫描。**
