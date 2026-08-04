# Task B2 report — 停机信号槽（改动 B，不写终态）

- 分支：`feat/l3-debt3-heartbeat-stop`（worktree `.claude/worktrees/l3-debt3-heartbeat-stop`）
- 起点：`b427c8b`（B1 收口）
- 落地提交：**`6935578`** `feat(runLoop): add a stop-request slot at the loop top that returns a resumable state without spending an attempt`
- 未 push（按人的指令，组 B 本地开）。分支上只有这**一个**提交，`git status --porcelain` 在 worktree 内为空。
- 本报告写在主仓 `.superpowers/sdd/…` 下，该路径被 `.superpowers/sdd/.gitignore:1:*` 忽略（`git check-ignore -v` 实测命中），**因此没有提交、也没有弄脏主仓工作区**——与 `task-B1-report.md` 的处置方式相同（B1 的 `docs(b1)` 提交只动了计划正文的勘误，没有提交报告本身）。
  （附带观察，不是我造成的：主仓 `git status --porcelain` 现有一条 ` M .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`，在我开工前就在那儿，本任务全程未写过该文件。）
- 环境：所有验证命令走 `rtk proxy "<单条命令>"`；测试跑前 `export ECC_GATEGUARD=off DISABLE_OMC=1`。**本报告内所有测试输出未过滤**（无 `| grep` / `| tail` / `| head` / `2>/dev/null`）。
- **标注约定（读之前请看）**：每个 vitest 输出块末尾的 `EXIT=N` 是**我加的标注**，记录该进程的退出码，**不是 vitest 自己打印的内容**；vitest 的 stdout 到 `Duration …` 那行为止，上面一律逐字原样。`npm test` / `npm run typecheck` / `npm run build` 那几块里的 `test_exit=` / `typecheck_exit=` / `build_exit=` 则相反——它们是命令里 `echo` 出来的，属于真实输出。

---

## 0. 交付面（与计划 Files 名单逐字一致，无扩大）

```
$ rtk proxy "git status --porcelain"        # 变异全部还原之后、提交之前那一刻
 M src/controller/resumeLoop.ts
 M src/controller/runLoop.ts
 M tests/controller/leaseLifecycle.integration.test.ts
 M tests/controller/runLoop.integration.test.ts
```

四个文件，与计划 `**Files:**` 名单逐字相同。**`src/controller/leaseHeartbeat.ts` 不在其中**——这就是「`stop()` 一个字节未改」的机器证据（Step 7 变异二临时改过它，已还原，见 §5.2）。

```
$ rtk proxy "git diff --stat"               # 同一时刻
 src/controller/resumeLoop.ts                       |   7 ++
 src/controller/runLoop.ts                          |  40 +++++++
 .../controller/leaseLifecycle.integration.test.ts  | 128 ++++++++++++++++++++-
 tests/controller/runLoop.integration.test.ts       |  87 +++++++++++++-
 4 files changed, 259 insertions(+), 3 deletions(-)
```

`src/registry/` 零改动（上表即穷尽）。

---

## 1. 控制器补充第 2 节要求的**具名确认**：新返回路径是否进入 `persistBoundaryAnalysis`

**结论：不进入。GATE-A open 项 4 的「第二条不立刻走终态的路由」这一触发条件，B2 不构成。**
（这是我自己沿代码做的确认，未继承 B1 的任何结论。）

**沿代码的论证，三步，全部可由下面的命令重推：**

第一步 —— `persistBoundaryAnalysis` 在全仓的调用点恰好两个，都在 `runLoop.ts` 内：

```
$ rtk proxy "grep -rnF 'persistBoundaryAnalysis' src/"
src/runtime/types.ts:118:// Task A4 / §4.3: what `persistBoundaryAnalysis` can assemble BEFORE the epoch rule runs.
src/controller/runLoop.ts:724:async function persistBoundaryAnalysis(
src/controller/runLoop.ts:1217:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
src/controller/runLoop.ts:1266:        // What is NOT a route, because a previous fix wave claimed it was: persistBoundaryAnalysis's
src/controller/runLoop.ts:1271:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
```

（724 是定义、1266 是注释、`types.ts:118` 是注释；真正的调用点是 **1217 与 1271** 两处，与计划 A8 一节说的「两个调用点」一致。）

第二步 —— 我装的槽在 `while (true)` 顶端、在 `const attempt = state.attemptsUsed + 1;` **之前**，两个调用点在它**之后**：

```
$ rtk proxy "grep -nF -e 'stopRequested' -e 'const attempt = state.attemptsUsed + 1;' -e 'persistBoundaryAnalysis' -e 'while (true)' src/controller/runLoop.ts"
724:async function persistBoundaryAnalysis(
1029:  stopRequested?: StopRequestSignal;
1053:  while (true) {
1084:    if (options?.stopRequested?.requested === true) {
1093:    const attempt = state.attemptsUsed + 1;
1217:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
1266:        // What is NOT a route, because a previous fix wave claimed it was: persistBoundaryAnalysis's
1271:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
```

第三步 —— 命中分支体是 `appendEvent(...)` + `return state;`。**`return`，不是 `continue`**：所以它既不会在本次迭代往下走到 1217/1271，也不会有下一次迭代。函数在 1090 行就退出了。

**旁证（不是主论据，但方向一致）：** 测试 8 断言 `expect(planCalls).toBe(0)`（`plan` 是每个 attempt 的第一个 adapter 调用）与 `expect(await readdir(join(runDir, "attempts"))).toEqual([])`，两者在 §4.1 实测为绿——两个调用点都在 attempt 体内、都在 `plan` 之后，所以「一个 attempt 都没进」蕴含「两个调用点都没到」。

**因此我没有停下上报**：人裁「保留即放宽、谓词一个字节不许改」不因 B2 重开。**这个结论只覆盖 B2，同样不许被组 C 继承**——C1/C2 若把槽挪位置或加第二个检查点，得自己重做这一节。

---

## 2. 落地内容

### 2.1 `src/controller/runLoop.ts`

三处，全部是新增：

1. `createLeaseLossSignal` 正下方新增 `export type StopRequestSignal = { requested: boolean };` 与 `export function createStopRequestSignal(): StopRequestSignal`，形状照抄 `LeaseLossSignal` / `createLeaseLossSignal`。
2. `RunLoopFromStateOptions` 加键 `stopRequested?: StopRequestSignal;`（**加键，不加位置参数**，也没有新建第三个类型）。
3. `while (true)` 顶端、`leaseLoss.lost !== null` 检查点**之后**、`const attempt = state.attemptsUsed + 1;` **之前**，新增：

```ts
    if (options?.stopRequested?.requested === true) {
      await appendEvent(runDir, {
        type: "stop_requested",
        at: new Date().toISOString(),
        detail: `stop requested at a phase boundary before attempt ${state.attemptsUsed + 1}`,
      });
      return state;
    }
```

**只装一处。** 第二处 `leaseLoss.lost !== null`（attempt 内部，`grep` 显示在 1454 行附近）**未装**，理由照计划两条写进了代码注释。

**顺序裁定（我做的选择，请复核）：** 槽排在 `leaseLoss.lost !== null` **之后**。理由是「只增加拒绝，绝不新增许可」的最小改动读法——两个信号同时置位时，路由与今天逐字节相同（仍走 `persistTerminalState(..., "cancelled", "lease_lost")`）。反向排序也说得通（停机路径不写终态、不碰新 owner 的记录，比 cancelled 更保守），但那会**改变既有行为**，不在本任务范围内。见 §7 concerns 第 1 条。

**未触碰**（逐条对照控制器补充第 1 节）：B1 的 `RunHeartbeatStoppedError` 分支、两条分支的先后顺序、`isLeaseStopError` 的谓词与签名、`stop()`、`options?.onReconciliationWriteAbandoned` 的两处转发（一处已被独立验证今天不可达，按组 A 裁定原样保留）。

新增终态写入点：**零**。

```
$ rtk proxy "bash -c \"grep -cF 'persistTerminalState(' src/controller/runLoop.ts\""
16
$ rtk proxy "bash -c \"git show b427c8b:src/controller/runLoop.ts | grep -cF 'persistTerminalState('\""
16
```

（16 = 16。`grep -c` 数的是行，本文件每行至多一处 `persistTerminalState(`，两次用同一口径比较，比较本身有效。）

`evaluateResumeEligibility` 的八条判据计数守卫：

```
$ rtk proxy "bash -c \"grep -cF 'return { ok: false' src/controller/resumeLoop.ts\""
8
```

（计划阶段实测 8，本轮实测 8，一致。）

### 2.2 `src/controller/resumeLoop.ts`

- `import type { StopRequestSignal } from "./runLoop.js";`
- `ResumeLoopOptions` 加同名键 `stopRequested?: StopRequestSignal;`
- 向 `runLoopFromState` 的 options 对象里透传 `stopRequested: options?.stopRequested,`

`resumeLoop` 自身**不读**这个键（它的三道拒绝——lease gate / eligibility gate / claim CAS——都发生在循环存在之前，停机请求不是拒绝 resume 的理由）。

### 2.3 完整生产 diff（`-U0`）

```
$ rtk proxy "git diff -U0 src/controller/resumeLoop.ts src/controller/runLoop.ts"   # 提交前
diff --git a/src/controller/resumeLoop.ts b/src/controller/resumeLoop.ts
index 9943988..894317f 100644
--- a/src/controller/resumeLoop.ts
+++ b/src/controller/resumeLoop.ts
@@ -19,0 +20 @@ import { cleanupAttemptWorkspaceBestEffort, createLeaseLossSignal, runLoopFromSt
+import type { StopRequestSignal } from "./runLoop.js";
@@ -91,0 +93,5 @@ export type ResumeLoopOptions = {
+  // Task B2: forwarded to runLoopFromState below, never read here. resumeLoop's own refusals
+  // (the lease gate, the eligibility gate, the claim CAS) all run before the loop exists, and a
+  // stop request is not a reason to refuse a resume — it is a reason for the loop this resume
+  // starts to return at its first phase boundary.
+  stopRequested?: StopRequestSignal;
@@ -194,0 +201 @@ export async function resumeLoop(
+      stopRequested: options?.stopRequested,
diff --git a/src/controller/runLoop.ts b/src/controller/runLoop.ts
index 0a06749..cb8d4cc 100644
--- a/src/controller/runLoop.ts
+++ b/src/controller/runLoop.ts
@@ -1012,0 +1013,11 @@ export function createLeaseLossSignal(): LeaseLossSignal {
+// Task B2 / L3 §5.4: the caller-owned slot a stop request lands in, shaped exactly like
+// LeaseLossSignal above and read at the same phase boundary, for the same reason — the loop
+// checks a place it chose to look rather than being called back into wherever a signal handler
+// happens to fire. This layer provides the SLOT only: the signal handler that sets it lives in
+// cli.ts, not here and not in sweepRuns.ts.
+export type StopRequestSignal = { requested: boolean };
+
+export function createStopRequestSignal(): StopRequestSignal {
+  return { requested: false };
+}
+
@@ -1017,0 +1029 @@ export type RunLoopFromStateOptions = {
+  stopRequested?: StopRequestSignal;
@@ -1052,0 +1065,28 @@ export async function runLoopFromState(
+    // Task B2 / L3 §5.4: the same phase boundary, one checkpoint later. Ordered AFTER the lease
+    // check on purpose — a lost lease keeps routing exactly where it always did, so this adds a
+    // refusal and changes none.
+    //
+    // Fitted to this checkpoint ONLY, not to the second `leaseLoss.lost !== null` further down.
+    // Two reasons, and the first is why the two would contradict each other: this one sits above
+    // `const attempt = state.attemptsUsed + 1` just below, so stopping here spends no attempt,
+    // while the other sits inside an attempt that has already been counted — and the writeRunState
+    // a few lines above has just persisted `state`, so loop-state.json and the returned value are
+    // byte-identical, which is what makes a stop cost the run nothing. The second reason is that
+    // the finer granularity buys nothing anyway: reaching the other checkpoint means execute has
+    // already run and already been paid for.
+    //
+    // Deliberately NOT persistTerminalState: a stop means "this process is done acting", not
+    // "this run is over", and nothing in this codebase leads back out of a terminal status. The
+    // event is the only record that a human asked for this, and nothing reads it — registry
+    // observes three files and evaluateResumeEligibility does not read the event stream — so the
+    // next sweep cannot tell this apart from an OOM kill. That is accepted here, not overlooked:
+    // both want the same handling, and distinguishing them needs a new observed disk field.
+    if (options?.stopRequested?.requested === true) {
+      await appendEvent(runDir, {
+        type: "stop_requested",
+        at: new Date().toISOString(),
+        detail: `stop requested at a phase boundary before attempt ${state.attemptsUsed + 1}`,
+      });
+      return state;
+    }
+
```

---

## 3. Step 1 — 类型与两个键落地后的 typecheck

```
$ rtk proxy "bash -c 'npm run typecheck; echo typecheck_exit=\$?'"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

---

## 4. 测试

### 4.1 测试 8

**完整测试名（`describe > it` 全串）：**
`runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt`

落地位置：`tests/controller/runLoop.integration.test.ts`，`describe("runLoop")` 内，紧接 B1 那条之后。

**fixture 的两处刻意选择（都是承重的，不是方便）：**

- **`attemptsUsed: 0`**（`{ ...makeRunState("planning"), currentAttempt: 0, attemptsUsed: 0 }`）。原因是让**变异一**真正可达：`evaluateStopDecision`（`src/stop/stopController.ts`）只在 `attemptNumber === 1` 时返回 `retryable`，`attemptNumber > 1` 一律 `blocked_waiting_human`，而 attempt 内部那个检查点**只长在 retryable 那条路上**。种子若用 `makeRunState("planning")` 的 `attemptsUsed: 1`，变异一下这条测试仍会红，但红在「跑出了终态」而不是「花掉了一个 attempt」——**弱得多的击杀**。这一点我实测过：见 §4.1.1 的第一次 pre-implementation 跑（`planCalls` 为 **1**，run 走的是 `blocked_waiting_human`），与改成 0 之后那次（`planCalls` 为 **2**，真的走了 retry）。
- **frame 1 拒绝验证**（`approved: false, safeToRetry: true`）。同上：给「另一处放法」一条通向它自己检查点的路，否则变异一只会让 run 跑完成功。

**断言与它们钉的东西：**

| 断言 | 钉什么 |
| --- | --- |
| `expect(planCalls).toBe(0)` | 一个 attempt 都没进（`plan` 是每 attempt 第一个 adapter 调用，生产里是付费调用） |
| `expect(await readdir(join(runDir, "attempts"))).toEqual([])` | 同上的磁盘侧观测 |
| `expect(finalState.attemptsUsed).toBe(state.attemptsUsed)` | 计划点名要的那条 |
| `expect(await readFile(loop-state.json)).toBe(persistedStateBeforeStop)` | **逐字节相同**。合法性：`initializeRunFiles` 与 `writeRunState` 都走同一个 `writeJsonFileAtomically`（`src/persistence/fileStore.ts:77` / `:82`），所以这是字节比较，不是两个序列化器的比较 |
| `expect(await readEventTypes(runDir)).toEqual(["stop_requested"])` | 精确列表：既钉新事件在，又钉 `loop_<terminal>`（`persistTerminalState` 唯一写者）与 `attempt_started` 都不在 |
| `expect(["planning","executing","verifying"]).toContain(finalState.status)` | run 仍可续（`RESUMABLE_STATUSES` 在 `resumeLoop.ts` 内私有，成员就地内联，不为此导出） |
| `expect(finalState.stopReason).toBeNull()` | 没有被写成停机终态 |

#### 4.1.1 Step 3：注入实现之前，该条单跑必须红（两次原始输出）

第一次（种子 `attemptsUsed: 1` 的版本，随后按上面的理由改为 0——这次输出保留，因为它是「为什么种子必须是 0」的实测依据）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state at the loop top when the stop signal is set, without spending an attempt'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 155ms
   × runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt 155ms
     → expected 1 to be +0 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/controller/runLoop.integration.test.ts:1301:23
    1299| 
    1300|     // No attempt was entered at all — the return happens above `const…
    1301|     expect(planCalls).toBe(0);
       |                       ^
    1302|     expect(await readdir(join(runDir, "attempts"))).toEqual([]);
    1303| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 54 skipped (55)
   Start at  19:44:02
   Duration  693ms (transform 229ms, setup 0ms, collect 259ms, tests 155ms, environment 0ms, prepare 50ms)
EXIT=1
```

第二次（落地的 `attemptsUsed: 0` 版本）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state at the loop top when the stop signal is set, without spending an attempt'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 225ms
   × runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt 225ms
     → expected 2 to be +0 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt
AssertionError: expected 2 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 2

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
   Start at  19:44:37
   Duration  736ms (transform 235ms, setup 0ms, collect 269ms, tests 175ms, environment 0ms, prepare 46ms)
EXIT=1
```

`Tests 1 failed | 54 skipped (55)` —— 具名那条计数非零，不是「过滤器零匹配的全 skipped」。

#### 4.1.2 Step 4：装槽之后单跑必须绿

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state at the loop top when the stop signal is set, without spending an attempt'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 103ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  19:44:58
   Duration  600ms (transform 228ms, setup 0ms, collect 264ms, tests 103ms, environment 0ms, prepare 40ms)
EXIT=0
```

`Tests 1 passed | 54 skipped` —— 具名那条计数非零，算数的绿。

### 4.2 测试 8b — 两条子用例（都写了，(ii) 用真实 CAS 失配）

落地位置：`tests/controller/leaseLifecycle.integration.test.ts`，`describe("lease heartbeat lifecycle")` 内，紧接 `releases the lease after a resume completes` 之后。

#### 8b(i) 完整测试名
`lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease`

- **走 `resumeLoop`**，不走 `runLoopFromState`：这条子用例的性质两端都在 `resumeLoop` 手里——它转发 `stopRequested`，它的 `finally` 调 `heartbeat.stop()`。**因此它同时是 `resumeLoop` 那条转发的唯一覆盖**（删掉转发，这条红）。

  > **Amended 2026-08-04（GATE-B 修复波，原句一字未删）**：括号里「删掉转发，这条红」当时是**推理，不是实测**——本报告把它写成了事实陈述，而 Step 7 只做了两条变异，没有它。**它本该是 Step 7 的第三条。** GATE-B lane 2 先测了它、成立；本波按「不照抄他人数字」重跑了一次完整的三步判据，原始输出在下面新增的 **§5.4**。结论未变（转发删掉后 8b(i) 确实红，且红的机制正是这里声称的那个），被更正的是**这句话当时的证据地位**。
- 前置断言（防止后面整段空转）：`readEventTypes` 恰为 `["resume_requested","resume_adopted","stop_requested"]`、`status === "planning"`、`attemptsUsed === 1`（种子值，没被消耗）。
- 释放断言：`owner.leaseAffirmedAt` 为 `null`；且 `Date.now() - Date.parse(owner.lastAffirmedAt) < LEASE_TTL_MS`——**在 TTL 之内**断言，所以「它老化过期了」不能被当成解释。
- 「下一次 sweep 真的能进」：`checkRunLease(runDir, "pid:next-sweep:1")` 返回 `kind === "no_lease"`（sweep 第一件事），并且**整道闸**——第二次 `resumeLoop(runDir, new ScriptedAdapter([successFrame()]))` 跑完返回 `succeeded`。
- 「这条不是空转」的证据由变异二给（§5.2）：`stop()` 里删掉 `releaseOwnerLease` 之后它红，且红在 `expected '2026-08-04T11:48:04.631Z' to be null`——**说明停机那一刻盘上确实有一份活租约**。

#### 8b(ii) 完整测试名
`lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS`

- **构造方式按计划定死的那条**：测试侧直接改写 `owner-record.json`，让 `releaseOwnerLease` → `updateOwnerRecordWithPrecondition` 的 `sameOwnerRecord` 比对**真实失配**。**没有**退化成「mock 已导出的 `releaseOwnerLease` 让它抛」那条更弱的替代（那条我一条都没写）。
- 复核了计划给的不可表达性前提：

```
$ rtk proxy "grep -rnF 'updateOwnerRecordWithPrecondition' src/"
src/persistence/fileStore.ts:1134:async function updateOwnerRecordWithPrecondition(
src/persistence/fileStore.ts:1169:  return updateOwnerRecordWithPrecondition(
src/persistence/fileStore.ts:1184:  await updateOwnerRecordWithPrecondition(
```

  3 行，全在 `fileStore.ts` 内，定义处 `async function`（无 `export`）——与计划一致，「mock 它」确实不可表达。

  > **自查记录（留着不删）**：这一块我第一次写报告时凭记忆填了三行输出（`:1090` / `:1172` / `:1184`，中间那条还写成了 `await`），**没跑就写**。发现后重跑了上面这条命令，按真实输出改正：正确的是 `:1134` / `:1169`（`return`，不是 `await`）/ `:1184`。**实质结论不变**（仍是 3 行、仍全在 `fileStore.ts` 内、定义处仍无 `export`），被改正的是三个行号和一个关键字。这正是全局约束点名的那类「附了命令却抄了输出值」，就地记录以免同一处再犯。
- **为什么这条不走 `resumeLoop`**：改写必须落在「循环返回之后、`stop()` 之前」这个缝里，而 `resumeLoop` 的 `finally` 紧挨着 `return`，测试伸不进去。所以这条按 `resumeLoop` 自己的接线手工搭：`startLeaseHeartbeat({ runDir, ownerRecord, onLeaseLost })` + `createLeaseLossSignal()` + `runLoopFromState(..., heartbeat, leaseLoss, { stopRequested })`，最后在 `finally` 里 `await heartbeat.stop()`——**调的是同一个生产 `stop()`**。
- 改写只动 `currentOwnerEpoch`（+1，模拟被 supersede），`leaseAffirmedAt` **保留心跳自己写的那个值**——所以后面拒绝的是这次 run 真正持有过的那份租约，不是测试捏造的时间戳。
- 前置断言：循环返回时 `affirmed.leaseAffirmedAt` **非 null**（顶端那次 `affirmNow` 确实拿到了活租约，否则「释放失败」无物可失败）；`readEventTypes` 恰为 `["stop_requested"]`。

  > **Amended 2026-08-04（GATE-B 修复波，原句一字未删；这是本波唯一一处代码改动）**：这条前置断言当时写成
  > `expect(affirmed.leaseAffirmedAt).not.toBeNull()`，而它**在 `undefined` 上会通过**——`affirmNow` 没跑时
  > 该字段是 `undefined`，`JSON.stringify` 把这个键整个丢掉，`.not.toBeNull()` 对 `undefined` 返回真。
  > 于是这条自称「没有它，下面的『释放失败』就无物可失败」的守卫**会空过**，测试一路跑到 `:340` 才以一条
  > 完全不指向真因的消息红（`promise resolved "{ kind: 'no_lease', …(1) }" instead of rejecting`）。
  > **这正是本仓库反复点名的「前置守卫自己不能失败」。** GATE-B lane 2 在实测 B2 M-1 那个存活变异体时撞到了它（其 §4、§5-F3）。
  > **改成**（只改这一条断言，测试的其余部分一字未动）：
  >
  > ```ts
  > expect(affirmed.leaseAffirmedAt).toEqual(expect.any(String));
  > ```
  >
  > `expect.any(String)` 同时拒 `null`、`undefined` 与缺键，这是「非 null」这个说法本来就想要的意思。
  > 三步判据与「它现在真的能红」的证明见下面新增的 **§4.2.1**。
- 吞掉的观测：`after.currentOwnerEpoch === affirmed.currentOwnerEpoch + 1` 且 `after.leaseAffirmedAt === affirmed.leaseAffirmedAt`——CAS 输了，租约原封不动留在盘上。
- 两端断言：`checkRunLease(runDir, "pid:next-sweep:1", affirmedAtMs + LEASE_TTL_MS - 1000)` **rejects with `RunLeaseHeldError`**；`checkRunLease(..., affirmedAtMs + LEASE_TTL_MS + 1000)` 返回 `kind === "expired"`。即：**TTL 之内被拒、TTL 之后 eligible，永不永久拒绝。**

#### 4.2.1 新前置断言「现在真的能失败」的证明（新增于 2026-08-04 的 GATE-B 修复波）

**新增于 GATE-B 修复波，标注为补做，不回填时间。** 一条改过的前置守卫如果没有被证明能红，
它和它替换掉的那条一样不算数。所以这里走满三步，外加一次**对照**，把「旧形状会空过」也钉成实测。

**具名测试**（完整 `describe > it` 串）：
`lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS`

**单跑命令**（`-t` 用裸 `it` 名）：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays refused until the TTL expires when the lease release loses its CAS'"; echo "EXIT=$?"
```

**探针**：本波不许改生产代码，所以「该键缺席」这个情形从**测试侧**构造——在断言前一行把该键删掉，
制造与「`affirmNow` 没跑」逐字相同的观测面（键不存在 → 读到 `undefined`）。标记 `GATEB-FIX-PROBE`：

```ts
delete (affirmed as { leaseAffirmedAt?: string | null }).leaseAffirmedAt; // GATEB-FIX-PROBE
expect(affirmed.leaseAffirmedAt).toEqual(expect.any(String));
```

**(a) 新断言、无探针 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 130ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  20:23:31
   Duration  575ms (transform 154ms, setup 0ms, collect 186ms, tests 130ms, environment 0ms, prepare 41ms)

EXIT=0
```

**(b) 新断言 + 探针 — 红，而且红在它自己身上**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 1 failed | 26 skipped) 115ms
   × lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS 115ms
     → expected undefined to deeply equal Any<String>

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS
AssertionError: expected undefined to deeply equal Any<String>

- Expected: 
Any<String>

+ Received: 
undefined

 ❯ tests/controller/leaseLifecycle.integration.test.ts:318:40
    316|       // unrelated message. GATE-B lane 2 measured that vacuous pass.
    317|       delete (affirmed as { leaseAffirmedAt?: string | null }).leaseAf…
    318|       expect(affirmed.leaseAffirmedAt).toEqual(expect.any(String));
       |                                        ^
    319| 
    320|       // The supersession. Only the epoch moves; leaseAffirmedAt keeps…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  20:23:44
   Duration  504ms (transform 141ms, setup 0ms, collect 173ms, tests 115ms, environment 0ms, prepare 40ms)

EXIT=1
```

**红在 `:318`，也就是这条前置断言本身**，消息是 `expected undefined to deeply equal Any<String>`——
读者一眼就知道「这个键根本不在」。这正是旧形状永远给不出的那句话。

**(b2) 对照：把断言换回旧形状、探针保持在位 —— 守卫空过，测试改在 `:340` 以误导性消息红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 1 failed | 26 skipped) 119ms
   × lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS 118ms
     → promise resolved "{ kind: 'no_lease', …(1) }" instead of rejecting

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
+     "lastAffirmedAt": "2026-08-04T12:24:00.546Z",
+     "logicalSessionId": "task-1:t0",
+     "ownerStatus": "current",
+     "runId": "task-1",
+     "supersededByEpoch": null,
+   },
+ }

 ❯ tests/controller/leaseLifecycle.integration.test.ts:340:96
    338|     // Inside the TTL the next sweep is refused — this is the cost the…
    339|     // asserted rather than glossed over.
    340|     await expect(checkRunLease(runDir, "pid:next-sweep:1", affirmedAtM…
       |                                                                                                ^
    341|       .rejects.toThrow(RunLeaseHeldError);
    342| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  20:24:00
   Duration  517ms (transform 159ms, setup 0ms, collect 193ms, tests 119ms, environment 0ms, prepare 48ms)

EXIT=1
```

**同一个探针、同一条测试，只换断言形状**：旧形状放行到 `:340`，失败消息里没有一个字提到
`leaseAffirmedAt` 缺席。**「这条守卫会空过」由此从推理变成实测**，与 lane 2 §4 观察到的
`no_lease` 形状同构（那次是被生产变异触发的，本次是被测试侧探针触发的；`ownerRecord` 里同样看不到
`leaseAffirmedAt` 这个键，因为 `JSON.stringify` 丢掉了它）。

**(c) 撤掉探针、断言保持新形状 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 121ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  20:24:20
   Duration  510ms (transform 143ms, setup 0ms, collect 175ms, tests 121ms, environment 0ms, prepare 42ms)

EXIT=0
```

四份输出的具名计数分别是 `1 passed | 26 skipped (27)` / `1 failed | 26 skipped (27)` /
`1 failed | 26 skipped (27)` / `1 passed | 26 skipped (27)` —— 没有一块是「全 skipped」。
探针的还原证明与本波的注入总账见 §5.5（扫描用的标记词就是探针里写的 `GATEB-FIX-PROBE` 本身）。

#### Step 6：两条单跑输出

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays eligible immediately after a stop_requested run releases its lease'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 180ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  19:46:39
   Duration  601ms (transform 147ms, setup 0ms, collect 181ms, tests 180ms, environment 0ms, prepare 37ms)
EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays refused until the TTL expires when the lease release loses its CAS'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 110ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  19:46:43
   Duration  509ms (transform 141ms, setup 0ms, collect 176ms, tests 110ms, environment 0ms, prepare 38ms)
EXIT=0
```

两条都是**落地后就正确的行为**，按计划 Step 6 的说法「绿不算完成」——护栏在 §5。

---

## 5. Step 7 — 变异实验（两次，各走三步判据）

基线：变异跑在**本 worktree**（是 git 仓库，`npm ci` 已跑过），基线全绿由 §6 的全套件跑证明（`Test Files 29 passed / Tests 490 passed`，exit 0）。

### 5.1 变异一：把槽改装到 attempt 内部那处检查点

**注入内容**：把 `if (options?.stopRequested?.requested === true) { … }` 整块从 `while (true)` 顶端删除，原样移到 attempt 内部那处 `leaseLoss.lost !== null` 之后、`continue;` 之前（即 verification-rejected → retryable 那条路上）。**生产代码上的注入**，不是 fixture。

**必红的具名测试**：`runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt`

**第 1 步 — 注入前该条单跑绿：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state at the loop top when the stop signal is set, without spending an attempt'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 104ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  19:46:58
   Duration  572ms (transform 200ms, setup 0ms, collect 238ms, tests 104ms, environment 0ms, prepare 38ms)
EXIT=0
```

**第 2 步 — 注入后该条单跑红：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state at the loop top when the stop signal is set, without spending an attempt'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 175ms
   × runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt 174ms
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
   Start at  19:47:20
   Duration  645ms (transform 201ms, setup 0ms, collect 241ms, tests 175ms, environment 0ms, prepare 39ms)
EXIT=1
```

**读数**：`planCalls` 是 **1** 而不是 2——变异版本真的跑到了 attempt 内部那个检查点（跑完 attempt 1、验证被拒、走 retryable、清完 worktree，然后在那里停下），也就是**恰好花掉了一个 attempt**。这正是计划要这条变异钉的东西，击杀是精确的、不是碰巧。

**第 3 步 — 还原后该条单跑绿，且树干净：**

```
$ rtk proxy "diff /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/746b61e7-a2cb-4a5b-a7e3-9df0f5120cae/scratchpad/runLoop.ts.pristine src/controller/runLoop.ts"; echo "diff_exit=$?"
diff_exit=0
```
（副本是注入前 `cp` 到 scratchpad 的 `runLoop.ts.pristine`；`diff` 无输出 + exit 0 = 逐字节还原。）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state at the loop top when the stop signal is set, without spending an attempt'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 110ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  19:47:46
   Duration  602ms (transform 201ms, setup 0ms, collect 242ms, tests 110ms, environment 0ms, prepare 49ms)
EXIT=0
```

### 5.2 变异二：把 `stop()` 的 `releaseOwnerLease` 整条去掉（只 `clearInterval`）

**注入内容**：`src/controller/leaseHeartbeat.ts` 的 `stop()` 里，删掉

```ts
    try {
      await releaseOwnerLease(options.runDir, expected);
    } catch {
      // Swallowed by contract: the lease simply ages out.
    }
```

**这条只做实验、立刻还原；`stop()` 在正式实现里一个字节未改**（证据：§0 的 `git status --porcelain` 不含 `leaseHeartbeat.ts`）。

**必红的具名测试**：`lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease`

**第 1 步 — 注入前绿：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays eligible immediately after a stop_requested run releases its lease'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 174ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  19:47:54
   Duration  568ms (transform 141ms, setup 0ms, collect 174ms, tests 174ms, environment 0ms, prepare 38ms)
EXIT=0
```

**第 2 步 — 注入后红：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays eligible immediately after a stop_requested run releases its lease'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 1 failed | 26 skipped) 115ms
   × lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 114ms
     → expected '2026-08-04T11:48:04.631Z' to be null

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease
AssertionError: expected '2026-08-04T11:48:04.631Z' to be null

- Expected: 
null

+ Received: 
"2026-08-04T11:48:04.631Z"

 ❯ tests/controller/leaseLifecycle.integration.test.ts:252:35
    250| 
    251|     const owner = JSON.parse(await readFile(join(runDir, "owner-record…
    252|     expect(owner.leaseAffirmedAt).toBeNull();
       |                                   ^
    253|     // Released, not aged out: the affirm the loop performed one line …
    254|     // still well inside the TTL.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  19:48:04
   Duration  511ms (transform 147ms, setup 0ms, collect 181ms, tests 115ms, environment 0ms, prepare 40ms)
EXIT=1
```

**读数**：`Received "2026-08-04T11:48:04.631Z"`——一个**当次跑的时间戳**。它同时证明两件事：(a) 只 `clearInterval` 的实现过不了这条，(b) **8b(i) 不是空转**——停机那一刻盘上确实有一份刚被 affirm 的活租约，正常实现里那个 `null` 是被 `releaseOwnerLease` 清掉的，不是从来没写过。

**第 3 步 — 还原后绿，且树干净：**

```
$ rtk proxy "diff /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/746b61e7-a2cb-4a5b-a7e3-9df0f5120cae/scratchpad/leaseHeartbeat.ts.pristine src/controller/leaseHeartbeat.ts"; echo "diff_exit=$?"
diff_exit=0

$ rtk proxy "git status --porcelain"
 M src/controller/resumeLoop.ts
 M src/controller/runLoop.ts
 M tests/controller/leaseLifecycle.integration.test.ts
 M tests/controller/runLoop.integration.test.ts
```

（`leaseHeartbeat.ts` 不在 dirty 列表里 = 两处证据互相独立地说明它被还原到了 `b427c8b` 的状态。）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays eligible immediately after a stop_requested run releases its lease'"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 179ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  19:48:25
   Duration  627ms (transform 165ms, setup 0ms, collect 192ms, tests 179ms, environment 0ms, prepare 44ms)
EXIT=0
```

### 5.3 关于「计划里的判据也可能是错的」

两条变异都按计划预言的方向红了，**没有遇到需要停下上报的判据冲突**。唯一一次「照做得不到预期形状」是我自己的 fixture 选择（种子 `attemptsUsed`），不是计划的判据错，已在 §4.1 就地记录，且**没有改测试去凑红**——改的是种子，改完之后 pre-implementation 那次仍然是红（§4.1.1 第二段输出）。

### 5.4 变异三：删掉 `resumeLoop` 向 `runLoopFromState` 的 `stopRequested` 转发

**新增于 2026-08-04 的 GATE-B 修复波，标注为补做，不回填时间。** 它**不是**原轮次的产物：
原轮次的 Step 7 只做了 §5.1 / §5.2 两条，而 §4.2 的 8b(i) 那一条却把「删掉转发，这条红」
当成了事实陈述（见该处 `Amended 2026-08-04` 注解）。GATE-B lane 2 于 2026-08-04 先实测过一次；
**下面这三份输出是本波自己重跑的，不是照抄 lane 2 的数字。**

**具名测试**（完整 `describe > it` 串）：
`lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease`

**单跑命令**（`-t` 用裸 `it` 名）：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseLifecycle.integration.test.ts -t 'stays eligible immediately after a stop_requested run releases its lease'"; echo "EXIT=$?"
```

**注入**（`src/controller/resumeLoop.ts`，`runLoopFromState` 那次调用的 options 对象内）：
删掉 `stopRequested: options?.stopRequested,` 这一行，其余一字不动。注入标记 `GATEB-FIX-PROBE`：

```ts
    return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat, leaseLoss, {
      onReconciliationWriteAbandoned: options?.onReconciliationWriteAbandoned,
      // GATEB-FIX-PROBE: forwarding removed
    });
```

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 174ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  20:24:29
   Duration  557ms (transform 138ms, setup 0ms, collect 169ms, tests 174ms, environment 0ms, prepare 41ms)

EXIT=0
```

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 1 failed | 26 skipped) 181ms
   × lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 180ms
     → expected [ 'resume_requested', …(5) ] to deeply equal [ 'resume_requested', …(2) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease
AssertionError: expected [ 'resume_requested', …(5) ] to deeply equal [ 'resume_requested', …(2) ]

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
    245|     // Premise, without which every assertion below would hold for a r…
    246|     // the loop returned at the boundary, non-terminal, having launche…
    247|     expect(await readEventTypes(runDir)).toEqual(["resume_requested", …
       |                                          ^
    248|     expect(stopped.status).toBe("planning");
    249|     expect(stopped.attemptsUsed).toBe(1);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 26 skipped (27)
   Start at  20:24:47
   Duration  584ms (transform 144ms, setup 0ms, collect 179ms, tests 181ms, environment 0ms, prepare 36ms)

EXIT=1
```

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests | 26 skipped) 195ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  20:25:00
   Duration  605ms (transform 144ms, setup 0ms, collect 180ms, tests 195ms, environment 0ms, prepare 37ms)

EXIT=0
```

三份输出的具名计数分别是 `1 passed | 26 skipped (27)` / `1 failed | 26 skipped (27)` /
`1 passed | 26 skipped (27)` —— 没有一块是「全 skipped」。

**红的机制 = 声称的机制**：转发一断，`runLoopFromState` 收到的 options 里没有 `stopRequested`，
槽永远命中不了，这个 run 就一路跑完（`attempt_started` / `execute_started` /
`execution_finished` / `loop_succeeded` 取代了 `stop_requested`），前置断言在第一处即红。
这正是 §4.2 那句话所说的「删掉转发，这条红」。

**还原证明（用的是能真正命中本次标记的扫描，见 §5.5 的教训）**：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "bash -c 'git diff --stat src/; echo SRC_DIFF_EXIT=\$?'"
SRC_DIFF_EXIT=0
```

`git diff --stat src/` 零行输出 = 整个 `src/` 与 HEAD 逐字节一致，本波不留任何生产侧改动。
本波所有注入统一带 `GATEB-FIX-PROBE` 标记，收尾的定值扫描见本报告 §5.5。

### 5.5 本波（GATE-B 修复波）的注入总账与还原证明

**新增于 2026-08-04。** 本波在 B2 侧只做了 §5.4 这一条注入（生产侧一处，已还原）。
统一标记词是 `GATEB-FIX-PROBE`，**扫描用的就是这个词本身**——这是 lane 2 的 E-2 所指出的教训
（B1 报告 §4.3 用 `grep -F 'MUTATION'` 去证明一处标记为 `EVIDENCE-ONLY` 的测试侧改动已还原，
那条扫描不可能命中它；见 B1 报告该处的 `Amended 2026-08-04` 注解）：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "bash -c 'grep -rnF GATEB-FIX-PROBE src/ tests/; echo PROBE_GREP_EXIT=\$?; git status --porcelain'"
PROBE_GREP_EXIT=1
 M tests/controller/leaseLifecycle.integration.test.ts
```

`-F` 定值扫描零行输出、exit 1 = 全仓 `src/` 与 `tests/` 无残留标记；
`git status --porcelain` 唯一一行是本波**有意保留**的那处断言修复
（8b(ii) 的前置断言，见 §4.2 的 `Amended 2026-08-04`）。

---

## 6. Step 8 — 全套件 / typecheck / build（未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "bash -c 'npm test -- --run; echo test_exit=\$?'"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 432ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 143ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 5ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 26ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 26ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 1863ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1450ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 5ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-zg6q0g/does-not-exist'

 ✓ tests/contract/loadContract.test.ts (7 tests) 14ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-X30g61/run-1  observed 2026-08-04T11:48:33.091Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 494ms
   ✓ parseArgs > returns 0 for the scripted example run 372ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2504ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 301ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 250ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3030ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 338ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 306ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 323ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 383ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 378ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 418ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 328ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 445ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2456ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 659ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 574ms
   ✓ render-contract CLI > rejects a non-git repository path 572ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 643ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 496ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 494ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 6954ms
   ✓ lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 307ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 592ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 617ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 579ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 415ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 358ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 396ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 383ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 356ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 11123ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 327ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 884ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 12254ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 3138ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 422ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 371ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 362ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 346ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 352ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 379ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 357ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 361ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 362ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 371ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 381ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 401ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 376ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 538ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 465ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 525ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 535ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 400ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 539ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 388ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15768ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1418ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1142ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2559ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1553ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1551ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1563ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 609ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 597ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 589ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 962ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 564ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2478ms

 Test Files  29 passed (29)
      Tests  490 passed (490)
   Start at  19:48:29
   Duration  16.39s (transform 2.31s, setup 0ms, collect 3.59s, tests 57.88s, environment 4ms, prepare 1.64s)

test_exit=0
```

**数字与它们的重推命令：**

- **29 个测试文件 / 490 条用例 / exit 0** ——重推命令即上面那条 `npm test -- --run`，输出末尾三行逐字为 `Test Files  29 passed (29)` / `Tests  490 passed (490)` / `test_exit=0`。
- **本任务新增 3 条**（测试 8、8b(i)、8b(ii)）。490 − 3 = 487，即 `b427c8b` 的基线条数。**不要引用计划里的 446**，那是 A 组之前的数。
- **两条允许的 flake 本轮都是 `✓`**，逐字出现在上面的清单里：
  - `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid` — `✓ … 2559ms`
  - (F) `runLoop > continues normally when execute returns a complete result during the recovery window` — 该文件整体 `✓ tests/controller/runLoop.integration.test.ts (55 tests) 11123ms`，无 `×` 行、无 `failed` 计数，即它也是绿。**这条是推断（vitest 只逐条列出慢用例），所以补一条命令证明这个测试名今天确实存在于该文件、不是我记错了名字：**

```
$ rtk proxy "grep -nF 'continues normally when execute returns a complete result during the recovery window' tests/controller/runLoop.integration.test.ts"
2805:  it("continues normally when execute returns a complete result during the recovery window", async () => {
```
- **名单外失败：零。** 没有任何重跑掩盖：全套件只跑了这一次。

```
$ rtk proxy "bash -c 'npm run typecheck; echo typecheck_exit=\$?'"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

```
$ rtk proxy "bash -c 'npm run build; echo build_exit=\$?'"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

---

## 7. 全仓行号引用扫描（收尾要求）

扫了，**一处都没改**，理由与结论如下。

扫描命令（需要正则：只看输出行，退出码不作为论据）：

```
$ rtk proxy "bash -c \"grep -rnE 'runLoop\\.ts:[0-9]+|resumeLoop\\.ts:[0-9]+|leaseLifecycle\\.integration\\.test\\.ts:[0-9]+|runLoop\\.integration\\.test\\.ts:[0-9]+' --include='*.md' --include='*.ts' .\""
# 输出 45KB，命中数以百计（`docs/handoff/handoff.md:404` 已就这批引用立过案：
# `.superpowers/sdd/` 内的 23 条 `runLoop.ts:NNN` 按「不可改写的历史过程记录」处理，刻意一条未动）
```

我把范围收窄到「**本次编辑之后才可能失效**」的那部分（即 NNN ≥ 我在该文件的第一处改动行），逐条列了出来（脚本与完整输出留在 scratchpad，命中清单见下）：`runLoop.ts` 9 条、`resumeLoop.ts` 20 条、`leaseLifecycle.integration.test.ts` 9 条、`runLoop.integration.test.ts` 42 条。

**我这次造成的位移，精确值（由 §2.3 的 `-U0` diff 直接读出）：**

- `resumeLoop.ts`：旧 ≥20 行 **+1**；旧 ≥92 行 **+6**；旧 ≥195 行 **+7**。
- `runLoop.ts`：旧 ≥1013 行 **+11**；旧 ≥1018 行 **+12**；旧 ≥1053 行 **+40**。
- 两个测试文件同理（新增块分别在 `describe` 内部）。

**逐条核过之后，确认有 1 组引用在 `b427c8b` 上还是有效的、被我顶掉了**（用 `git show b427c8b:<file> | sed -n "Np"` 与当前树对照）：

- `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:52` 与 `docs/superpowers/plans/2026-07-27-owner-transfer-contention.md:50,65` 引的 `resumeLoop.ts:136` / `:137`。`b427c8b` 上这两行逐字是
  `await appendEvent(runDir, { type: "resume_denied", …, detail: eligibility.reason });` 与 `throw new ResumeNotEligibleError(eligibility.reason);`（正是它们要指的 eligibility 拒绝），**现在同样内容在 142 / 143 行**。

**我没有去改它**，两条理由：(1) 计划的 Files 名单是硬约束，这三个文件不在名单内；(2) 这几份是 2026-07-27 那一层的历史计划/设计稿，仓库既定立场（`docs/handoff/handoff.md:404`）是「按不可改写的历史过程记录处理，就地勘误，不改原件」。**交人裁**，见 §8 concerns 第 3 条。

---

## 8. Concerns（含我自己不确定、以及该由人裁的）

1. **停机检查与 `leaseLoss.lost !== null` 的先后是我做的裁定，计划没写。** 我把停机排在**后**面，理由是最小改动（两者同时置位时路由与今天逐字节相同）。反向排序有独立的论据：停机路径不写终态、不碰可能已易主的记录，比 `persistTerminalState(..., "cancelled")` 更保守（那正是债 2 的形状）。**今天没有任何测试区分这两种顺序**——两条新测试都只置停机信号、不置租约丢失。若人认为该反过来，改动是一行位置调换 + 一条新测试。

2. **8b(i) 与 8b(ii) 走的入口不同**（(i) `resumeLoop`，(ii) `runLoopFromState` + 测试自建心跳），不是纯 A/B。原因写在测试注释里：(ii) 的注入点必须落在「循环返回之后、`stop()` 之前」，而 `resumeLoop` 的 `finally` 不留这个缝。(ii) 调的仍是同一个生产 `startLeaseHeartbeat(...).stop()`，但**它没有覆盖 `resumeLoop` 的转发**；那条转发的唯一覆盖在 (i)。若评审员认为 (ii) 也必须走 `resumeLoop`，我想不出不改 `resumeLoop` 就能做到的构造——请人裁。

3. **§7 那条被我顶掉的行号引用**（`resumeLoop.ts:136-137` → 现 142-143，被 3 个 docs 文件引用）。我按 Files 名单与仓库既定立场没动。**若人要修，是 3 处编辑，且需扩大 Files 名单。**

4. **`stop_requested` 事件没有任何消费者**，这是计划明写并接受的（registry 只观测三个文件，`evaluateResumeEligibility` 不读事件流），我把它写进了代码注释以免被沉默继承。**含义**：下一次 sweep 分不清「人主动停的」和「被 OOM 杀的」。**没有测试守着这件事**——因为它是「不存在的功能」，无从断言。

5. **停机粒度是「一个完整 attempt」且是 adapter 协作式**（execute 相位 `abort()` 之后 `await operationPromise` 无第二重上界、git 子进程无超时）。本层没修，逃生口按计划留给 C2 的 `exit(130)`。**本任务的测试都在 attempt 之外触发停机，所以「粒度」这条代价一条测试都没覆盖**——它是设计声明，不是被验证的性质。

6. **`options?.stopRequested?.requested === true` 用的是严格比较**，所以 `requested` 被设成任何非 `true` 的真值（例如 `1`）都不会停机。这是我选的写法（与 `eligibleForContinuation as boolean !== true` 的既有风格一致），类型上 `requested: boolean` 也不允许别的值；但如果 C1/C2 打算从 JSON 反序列化出这个槽，这条严格比较会静默不触发。**没有测试守着它**。

7. **我没有碰 B1 留下的那块「没有测试守着」的区域**（外层 catch 的两条分支、`isLeaseStopError` 的谓词），也没有 export 任何原本不导出的东西。`stop()` 一个字节未改（§0 / §5.2 两处独立证据）。

8. **Rule 6 token 预算**：本任务的实际消耗超出 CLAUDE.md 写的每任务 12,000 token 预算（brief + 四个大文件的阅读就已经超了）。按 Rule 6 就地上报，不静默溢出。

---

# 修复轮 —— GATE-B 修复波（2026-08-04）

**这一整节新增于 2026-08-04 的 GATE-B 修复波，标注为补做，不回填时间。**
触发它的是 GATE-B lane 2（整分支「变异与测试证据全量重扫」）的 finding F-3 与 F-4，
报告在同目录 `gate-b-lane2-report.md`。B1 侧的三条（F-1／F-2／F-5）记在 `task-B1-report.md`
的「修复轮 2」一节。

| lane 2 finding | 处置 | 落点 |
|---|---|---|
| **F-3** 8b(ii) 的前置断言 `.not.toBeNull()` 在 `undefined` 上空过 | **改这一条断言**（本波唯一一处代码改动），并证明它现在能红 | §4.2 的 `Amended 2026-08-04` ＋ §4.2.1 |
| **F-4** 「8b(i) 是 `resumeLoop` 转发的唯一覆盖」是推理不是实测 | **补做这条变异**（本该是 Step 7 的第三条），本波自己重跑 | §4.2 的 `Amended 2026-08-04` ＋ §5.4 |

**生产代码零改动**（§5.4 的注入已还原，证明在 §5.5）。

## 9. 本波的收尾跑（全套件 / typecheck / build，未过滤）

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"; echo "TEST_EXIT=$?"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 5ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 430ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 150ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 29ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 1738ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1341ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 45ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 23ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-H8iakT/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-FWOp0q/run-1  observed 2026-08-04T12:27:00.777Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 525ms
   ✓ parseArgs > returns 0 for the scripted example run 405ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2537ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 305ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 2955ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 329ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 303ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 321ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 387ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 369ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 366ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 317ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 430ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 258ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 3ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2496ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 678ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 574ms
   ✓ render-contract CLI > rejects a non-git repository path 575ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 656ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 537ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 535ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 6765ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 568ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 540ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 598ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 445ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 355ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 372ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 368ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 348ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 10950ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 364ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 860ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 14044ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 3139ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 919ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 746ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 741ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 1185ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 356ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 408ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 473ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 343ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 495ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 352ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when execute is interrupted 342ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when verify is interrupted 325ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 490ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 469ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 832ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 523ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 425ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15706ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1376ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1144ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2544ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1542ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1554ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1541ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 583ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 585ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 594ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 981ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 594ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2486ms

 Test Files  29 passed (29)
      Tests  490 passed (490)
   Start at  20:26:57
   Duration  16.31s (transform 2.13s, setup 0ms, collect 3.37s, tests 59.24s, environment 3ms, prepare 1.60s)

TEST_EXIT=0
```

**29 passed (29) 文件 / 490 passed (490) 用例 / exit 0。**
**允许名单上的两条 flake 一条都没出现**：`tests/validation/evidence.test.ts` 的
`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
在上面的清单里是 `✓`（2544ms）；`tests/controller/runLoop.integration.test.ts` 整文件 55 条全绿，
其中包含 `continues normally when execute returns a complete result during the recovery window`。
**名单外零失败。** 用例数与 B2 落地时的 §6 一致（490），本波没有新增或删除任何测试。

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "npm run typecheck"; echo "typecheck_exit=$?"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "npm run build"; echo "build_exit=$?"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

## 10. 本波的 concerns

**无新增 concerns。** 落地时的 concerns 1–8 状态不变，本波一条都没触及。
本波没有遇到任何需要停下上报的情形：F-3 的新断言按预期红在它自己身上，
F-4 的变异按 §4.2 声称的方向与机制红。
