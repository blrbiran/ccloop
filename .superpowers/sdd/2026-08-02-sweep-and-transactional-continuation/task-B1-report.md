# Task B1 report — `RunHeartbeatStoppedError` ＋ `runExclusive` 拒绝 ＋ 不写终态的新分支

**树**：`/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop`
**分支**：`feat/l3-debt3-heartbeat-stop`，基点 `a7c26c9`
**提交**：`dab1040`（本地，未 push）
**状态**：DONE_WITH_CONCERNS（concerns 见最后一节，全部为「我认为该由人裁而没有自作主张」的事项）

本报告里每一个数字旁边都附了能重推它的命令，写下的是**我这次执行**的真实输出。所有验证跑
未加任何 `grep` / `tail` / `head` / `2>/dev/null` 过滤，输出整段贴出。

---

## 0. 环境与前置

四个已知环境陷阱都照做了：所有验证命令走 `rtk proxy "<单条命令>"`；从不给 `rtk proxy` 传
`a && b`；`-t` 一律用**裸 `it` 名**（下面每一块单跑输出都能看到具名那条的**非零计数**，
没有一块是「全 skipped」）；环境变量用 `export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "…"`
的形式，不把变量赋值塞进引号串。

**本轮新发现的第五个环境陷阱（重要，下一个人会撞）：**
这个 worktree 在开工时**没有自己的 `node_modules`**。Node 会向上走到主仓库
`/Users/biran/code/skills/loop/ccloop/node_modules` 解析模块，所以 `npx vitest` / `npm test`
照常跑得动，看起来一切正常；但 `tests/validation/evidence.test.ts` 里的

```
tests/validation/evidence.test.ts:24:const tsxBin = join(worktreeRoot, "node_modules", ".bin", "tsx");
```

是**用 `process.cwd()` 拼出来的绝对路径**，它不走 Node 的向上解析，于是 9 条 `run-scenario CLI`
测试以 `spawn …/node_modules/.bin/tsx ENOENT` 失败。**这 9 条不在允许的 flake 名单里**，我按新缺陷
处理（先完整捕获，再定位），完整失败输出保存在 §5.1。定位与处置见 §5.1 —— 结论是环境缺陷不是代码
缺陷，`npm ci` 之后 9 条全绿，全套件 29/29 文件、487/487 用例、exit 0。

复现该判定的命令与我这次的输出：

```bash
cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop && rtk proxy "ls node_modules/.bin/"
ls: node_modules/.bin/: No such file or directory
EXIT=1

rtk proxy "ls node_modules/.bin/"          # 主仓库（cwd 默认在主仓库）
esbuild
nanoid
rollup
tsc
tsserver
tsx
vite
vite-node
vitest
why-is-node-running
MAIN_EXIT=0
```

---

## 1. 落地的改动（三处生产代码，两个测试文件）

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "git --no-pager diff --stat"
 src/controller/leaseHeartbeat.ts             |  31 ++++++-
 src/controller/runLoop.ts                    |  26 +++++-
 src/ownership/lease.ts                       |  17 ++++
 tests/controller/leaseHeartbeat.test.ts      |  53 ++++++++++-
 tests/controller/runLoop.integration.test.ts | 128 +++++++++++++++++++++++++++
 5 files changed, 249 insertions(+), 6 deletions(-)
EXIT=0
```

（该 `--stat` 是提交前跑的；提交输出同样是 `5 files changed, 249 insertions(+), 6 deletions(-)`。）

### 1.1 `src/ownership/lease.ts` — 新错误类

锚点：`export class RunLeaseUnverifiableError` 之后、`export function isLeaseFresh` 之前。
形状照抄现有两个（`readonly stopReason` ＋ `constructor(message)` ＋ `this.name`），并按判例
（`grep -rnF 'NOT a subclass' src/`，判例在 `src/persistence/fileStore.ts`）带一条同形注释，
**点名它保护的是 `isLeaseStopError`**：

```ts
// Sibling of RunLeaseLostError and RunLeaseUnverifiableError, deliberately NOT a subclass of
// either — and they must not be given a common base class either: this error says "this process's
// own heartbeat has stopped", which is neither "someone else owns this run" nor "this run's
// ownership could not be read". The entire safety of L3 §5.3's option (a) rests on
// isLeaseStopError (src/controller/runLoop.ts) NOT matching it: that predicate's branch persists
// the terminal "cancelled" status, and no path in this codebase leads out of a terminal status,
// so one stop signal would end the run permanently. A subclass would make that predicate start
// matching without a single character of it changing, and no test name would hint at the cause.
export class RunHeartbeatStoppedError extends Error {
  readonly stopReason = "heartbeat_stopped";

  constructor(message: string) {
    super(message);
    this.name = "RunHeartbeatStoppedError";
  }
}
```

判例对齐的证据（改后实测）：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'NOT a subclass' src/"
src/ownership/lease.ts:38:// Sibling of RunLeaseLostError and RunLeaseUnverifiableError, deliberately NOT a subclass of
src/persistence/fileStore.ts:708:// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass: the two errors mean
src/persistence/fileStore.ts:720:// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass: a corrupt marker is a
src/persistence/fileStore.ts:734:// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass, for the same reason as
src/persistence/fileStore.ts:746:// Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass, same reasoning as its
```

**5 行**（原 4 行 + 本次新增 1 行）。

### 1.2 `src/controller/leaseHeartbeat.ts` — `runExclusive` 拒绝 ＋ 其上方注释

改动面严格限死在「`runExclusive` 拒绝 + 其上方注释」（§9 模块表），外加一行 import。
`stop()`、`assertHeld`、`runAffirm`、`adopt`、`affirmNow`、`concludeLeaseLost` **一个字节未改**
（见 §1.4 的完整生产 diff：diff 里除 import 外只出现 `runExclusive` 上方注释块与函数体开头）。

采用的形状是**排队后的续体开头判定**（控制器补充第 1 条明列的两种合规形状之一）：

```ts
  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const refuseIfStopped = async (): Promise<T> => {
      if (stopped) {
        throw new RunHeartbeatStoppedError(
          `run heartbeat has stopped: refusing an exclusive owner-record operation for ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}`,
        );
      }

      return await fn();
    };

    const result = queue.then(refuseIfStopped, refuseIfStopped);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
```

**为什么选续体形状而不是「调用时同步拒绝」**：`stopped` 只被置位、从不被清零
（下面的 grep 实证：唯二的赋值在 39 行的 `false` 初始化与 244 行的 `true`），所以
「续体开头判定」在集合意义上**包含**「调用时判定」——调用时若已 `stopped`，续体跑到时仍然
`stopped`；反过来不成立（一个在 `stop()` 之前入队、在 `stop()` 之后才轮到的调用，只有续体形状
会拒绝它）。两者都满足控制器补充第 1 条，我选了严格更强的那个。

`queue.then(refuseIfStopped, refuseIfStopped)` 保留了原来的双 handler 形状与
`result` / `queue` 两个不同 promise 的既有设计，未动一个字。

`stopped` 的全部出现（改后实测，用来同时验证「拒绝在 `runExclusive` 内」与
「`assertHeld` 仍然从不读 `stopped`」两件事）：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -nF 'stopped' src/controller/leaseHeartbeat.ts"
39:  let stopped = false;
79:  // `stopped || superseded` entry check is still awaiting its CAS write. That runAffirm then
139:    if (stopped || superseded) {
194:  // Task B1 / L3 §5.3 supersedes the note that stood here ("takes no position on `stopped` or
196:  // `superseded`: that remains assertHeld's one decision. It DOES refuse on `stopped`, and that
198:  // `stopped` at all — it answers "is this run still ours" from the persisted owner record,
199:  // while `stopped` answers "does this process still intend to act", which is pure in-process
207:  // in runLoopFromState's outer catch. `stopped` is only ever set, never cleared, so checking
211:      if (stopped) {
213:          `run heartbeat has stopped: refusing an exclusive owner-record operation for ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}`,
240:    if (stopped) {
244:    stopped = true;
301:        // stopped for a lease reason with nothing on disk naming who took it over.
319:    // leaves no trace is indistinguishable from a run that simply stopped, and on the
```

**语句级用法四处**：139（`runAffirm`）、211（本次新增，`runExclusive` 内）、240/244（`stop`）。
`assertHeld` 的函数体起于 275（`const assertHeld = async (): Promise<void> => {`），落在其中的
只有 301 与 319 两行，**都在注释块里**。所以硬约束第二半「它只从 `runExclusive` 抛出，绝不从
`assertHeld` 抛出」在落地代码上成立。

被同笔改掉的注释（计划要求的那一条，不是三条）：原文
「Takes no position on `stopped` or `superseded` — it only serializes. Refusal is Task 5's job;
duplicating it here would just be a second, weaker copy of a decision that already has one home.」
已就地更新为记录本次局部推翻的新裁定（全文见 §1.4 diff）。
**`isLeaseStopError` 上方那句「the two ways …」按计划未改**；**谓词与签名未改**。

### 1.3 `src/controller/runLoop.ts` — 外层 catch 新分支

排在 `isLeaseStopError` 分支**之前**，也排在通用失败处理之前：

```ts
      if (error instanceof RunHeartbeatStoppedError) {
        await appendEvent(runDir, {
          type: "heartbeat_stopped",
          at: new Date().toISOString(),
          detail: String(error),
        });
        await writeRunState(runDir, state);
        return state;
      }
```

`appendEvent` 的三字段形状与同文件既有的 `workspace_create_failed` / `workspace_retry`
（`String(error)` 作 detail）一致。**`writeRunState(runDir, state)` 已补**（第四轮新增要求），
理由写进了就地注释，并由测试 7b 的 `expect(persisted).toEqual(finalState)` 钉住。

改后关键锚点的行号（供评审对照；锚点本身仍以「文件名 + 符号名」为准）：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -nF -e 'function isLeaseStopError' -e 'await heartbeat.runExclusive(' -e 'if (error instanceof RunHeartbeatStoppedError)' -e 'if (isLeaseStopError(error))' src/controller/runLoop.ts"
107:function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
786:  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
1069:        if (isLeaseStopError(error)) {
1449:      if (error instanceof RunHeartbeatStoppedError) {
1467:      if (isLeaseStopError(error)) {
```

即：新分支 **1449** 在外层 `isLeaseStopError` 分支 **1467** 之前；谓词定义 107 与内层 catch 1069
位移为 0；生产调用点 786 位移为 0。

生产调用点仍然唯一：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'runExclusive(' src/"
src/controller/runLoop.ts:786:  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
```

**1 行**，与计划阶段实测一致。（`INERT_LEASE_HEARTBEAT` 的桩写作 `runExclusive: (fn) => fn(),`，
不含 `runExclusive(` 子串，故不在此命中——它与测试替身的三处桩**都没被碰**，见 §1.4 diff 只涉及
五个文件且测试 diff 中不含桩行。）

### 1.4 完整生产 diff（未过滤）

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "git --no-pager diff src/controller/leaseHeartbeat.ts src/controller/runLoop.ts src/ownership/lease.ts"
diff --git a/src/controller/leaseHeartbeat.ts b/src/controller/leaseHeartbeat.ts
index d17653c..8b8aae0 100644
--- a/src/controller/leaseHeartbeat.ts
+++ b/src/controller/leaseHeartbeat.ts
@@ -4,6 +4,7 @@ import {
   LEASE_VERIFY_READ_ATTEMPTS,
   LEASE_VERIFY_RETRY_DELAY_MS,
   parseOwnerRecordForLease,
+  RunHeartbeatStoppedError,
   RunLeaseLostError,
   RunLeaseUnverifiableError,
 } from "../ownership/lease.js";
@@ -190,11 +191,33 @@ export function startLeaseHeartbeat(options: {
   // does, while the stored one is derived from `result` but maps both outcomes to a plain
   // resolution, so the shared queue itself never becomes a rejected promise.
   //
-  // Takes no position on `stopped` or `superseded` — it only serializes. Refusal is Task 5's
-  // job; duplicating it here would just be a second, weaker copy of a decision that already
-  // has one home.
+  // Task B1 / L3 §5.3 supersedes the note that stood here ("takes no position on `stopped` or
+  // `superseded` — it only serializes; refusal is Task 5's job"). It still takes no position on
+  // `superseded`: that remains assertHeld's one decision. It DOES refuse on `stopped`, and that
+  // is not a second, weaker copy of assertHeld's refusal, because assertHeld never reads
+  // `stopped` at all — it answers "is this run still ours" from the persisted owner record,
+  // while `stopped` answers "does this process still intend to act", which is pure in-process
+  // state with no other home.
+  //
+  // The check runs at the head of the queued continuation, so it is evaluated BEFORE `fn` and
+  // never after `fn` settles. That ordering is load-bearing, not a style choice: `fn` at the one
+  // production call site (persistBoundaryAnalysis, runLoop.ts) is the read -> evaluate -> CAS
+  // transfer span that publishes reconciliation-record.json transactionally, and a refusal
+  // raised after it would abandon a COMPLETED publish onto the non-terminal return path B1 adds
+  // in runLoopFromState's outer catch. `stopped` is only ever set, never cleared, so checking
+  // here also covers a call that was made before stop() and only reaches the head afterwards.
   const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
-    const result = queue.then(fn, fn);
+    const refuseIfStopped = async (): Promise<T> => {
+      if (stopped) {
+        throw new RunHeartbeatStoppedError(
+          `run heartbeat has stopped: refusing an exclusive owner-record operation for ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}`,
+        );
+      }
+
+      return await fn();
+    };
+
+    const result = queue.then(refuseIfStopped, refuseIfStopped);
     queue = result.then(
       () => undefined,
       () => undefined,
diff --git a/src/controller/runLoop.ts b/src/controller/runLoop.ts
index cc10620..0a06749 100644
--- a/src/controller/runLoop.ts
+++ b/src/controller/runLoop.ts
@@ -20,7 +20,7 @@ import { applyOwnerEpochTransfer, evaluateOwnership } from "../ownership/ownerCo
 import { checkRunLease } from "./leaseGate.js";
 import { startLeaseHeartbeat } from "./leaseHeartbeat.js";
 import type { LeaseHeartbeat } from "./leaseHeartbeat.js";
-import { RunLeaseLostError, RunLeaseUnverifiableError } from "../ownership/lease.js";
+import { RunHeartbeatStoppedError, RunLeaseLostError, RunLeaseUnverifiableError } from "../ownership/lease.js";
 import type {
   AttemptContext,
   AttemptPlan,
@@ -1432,6 +1432,30 @@ export async function runLoopFromState(
 
       return state;
     } catch (error) {
+      // Task B1 / L3 §5.3, option (a): a stopped heartbeat abandons the attempt in place exactly
+      // as a refused lease does — no cleanup, no boundary write, no phase usage — but it must NOT
+      // terminate the run. Deliberately its OWN branch, ordered ahead of isLeaseStopError rather
+      // than folded into it: that branch persists "cancelled", and nothing in this codebase leads
+      // back out of a terminal status (resume, sweep and runLoop all refuse one), so routing a
+      // stop signal there would end the run permanently on a signal that means only "this process
+      // is done acting". It is also ahead of the generic failure handling below, which would
+      // otherwise transition to "failed" — a stop is not an attempt failure.
+      //
+      // The writeRunState is not redundant with the one at the top of the loop. §5.4's stop point
+      // sits there, where the returned state is byte-identical to disk; this branch fires
+      // mid-attempt, where `state` may have been advanced by applyPhaseUsage since that write.
+      // Without it the returned state and the persisted one disagree and the claim that this is
+      // structurally the same stop as §5.4's is false.
+      if (error instanceof RunHeartbeatStoppedError) {
+        await appendEvent(runDir, {
+          type: "heartbeat_stopped",
+          at: new Date().toISOString(),
+          detail: String(error),
+        });
+        await writeRunState(runDir, state);
+        return state;
+      }
+
       // §8.1: the side effect was skipped and the attempt is abandoned IN PLACE. No further
       // side effect of this attempt is attempted, including its worktree cleanup — cleanup
       // is itself a side effect on a worktree the new owner may already be reading, and
diff --git a/src/ownership/lease.ts b/src/ownership/lease.ts
index fca07cb..6602721 100644
--- a/src/ownership/lease.ts
+++ b/src/ownership/lease.ts
@@ -35,6 +35,23 @@ export class RunLeaseUnverifiableError extends Error {
   }
 }
 
+// Sibling of RunLeaseLostError and RunLeaseUnverifiableError, deliberately NOT a subclass of
+// either — and they must not be given a common base class either: this error says "this process's
+// own heartbeat has stopped", which is neither "someone else owns this run" nor "this run's
+// ownership could not be read". The entire safety of L3 §5.3's option (a) rests on
+// isLeaseStopError (src/controller/runLoop.ts) NOT matching it: that predicate's branch persists
+// the terminal "cancelled" status, and no path in this codebase leads out of a terminal status,
+// so one stop signal would end the run permanently. A subclass would make that predicate start
+// matching without a single character of it changing, and no test name would hint at the cause.
+export class RunHeartbeatStoppedError extends Error {
+  readonly stopReason = "heartbeat_stopped";
+
+  constructor(message: string) {
+    super(message);
+    this.name = "RunHeartbeatStoppedError";
+  }
+}
+
 // §5: a total function on a validated record. `null`, an absent field and an unparseable
 // timestamp all answer "not fresh" — but only as a defensive default. The rule that
 // governs a malformed record is parseOwnerRecordForLease's refusal, not this `false`.
EXIT=0
```

**这份 diff 同时就是「没顺手清理」的证明**：`persistBoundaryAnalysis` 的两个调用点、
`options?.onReconciliationWriteAbandoned` 两个参数、`transferRepresentsPublishedWinner`、
`stop()`、`isLeaseStopError` 的谓词与签名、`INERT_LEASE_HEARTBEAT` 与三处测试替身桩、
`src/registry/` —— 全部不在 diff 里。

---

## 2. 测试

### 2.1 测试 7（完整测试名 `startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError`）

落在 `tests/controller/leaseHeartbeat.test.ts` 的 `describe("startLeaseHeartbeat")` 末尾。两条断言：

1. `await expect(heartbeat.runExclusive(fn)).rejects.toBeInstanceOf(RunHeartbeatStoppedError)`
   —— 计划原文那条，一个字未改。
2. `expect(fn).not.toHaveBeenCalled()` —— **控制器补充第 2 条**要求的 spy 断言。

### 2.2 测试 7b（完整测试名 `runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt`）

落在 `tests/controller/runLoop.integration.test.ts` 的 `describe("runLoop")` 内。
夹具走 **execute 超时且无结果**那条路（`runLoop.ts` 的 `execution === null` 分支 → 调用点
`persistBoundaryAnalysis`），直接驱动 `runLoopFromState` 并传入一个只在 `runExclusive` 上抛
`RunHeartbeatStoppedError` 的替身心跳（`assertHeld` **不抛**，对应硬约束第二半）。

夹具前置条件（按「凡是断言恰好 N 行事件的测试必须同条断言 fixture 前置条件」写死在同一条里）：

- `expect(runExclusiveCalls).toBe(1)` —— 注入确实在唯一生产调用点触发过，且恰好一次。
  没有这条，下面四条会对一个根本没走到 `persistBoundaryAnalysis` 的 run **空洞地成立**。
- `expect(observedWorktreePath).not.toBe("")` —— execute 确实进过，worktree 路径已观测到。
- execute 内向 worktree 写了一个文件，这是让 `continuitySuspicion` 非空、boundary 落在
  `stale_candidate`、从而**不**走 `persistBoundaryAnalysis` 的 `healthy` 早退（早退在 `runExclusive`
  之上）的那个杠杆。

四条要求的断言：

- **(i) 不调 `persistTerminalState`**：`persistTerminalState` 是 `loop_<terminal>` 事件与终态状态的
  唯一写者，两者都不出现 ——
  `expect(await readEventTypes(runDir)).toEqual(["attempt_started", "execute_started", "heartbeat_stopped"])`
  （精确列表，顺带把新分支自己的 `heartbeat_stopped` 事件钉在同一条断言里）
  ＋ `expect(persisted.status).toBe("executing")` ＋ `expect(persisted.stopReason).toBeNull()`。
- **(ii) `execution-recovery.json` 的 `cleanupStatus` 未被回填**：
  `expect(recovery.executeEntered).toBe(true)` ＋ `expect(recovery.cleanupStatus).toBe("retained")`。

  > **Amended 2026-08-04（GATE-B 修复波，原句一字未删）**：这四条断言被并列陈述，读者会以为四条等强；
  > **它们不等强，(ii) 在这条测试的夹具下今天是恒真的**。唯一的 `cleanupStatus` 回填在 `runLoop.ts` 的
  > `cleanupAttemptWorkspaceWithStatus` → 条件重写 `writeAttemptArtifacts` 那一段，它位于
  > `persistBoundaryAnalysis` **之后**；而 7b 的替身心跳让 `runExclusive` 无条件抛，
  > `persistBoundaryAnalysis` 必抛，所以那段回填代码在这条测试里**在任何外层 catch 的变异下都到不了**。
  > 要让 (ii) 红，只能删掉 `persistBoundaryAnalysis` 里的 `runExclusive` 调用——而那会先让夹具前置断言
  > `expect(runExclusiveCalls).toBe(1)` 红，红的也不是 (ii)。**因此 (ii) 是文档，不是护栏。**
  > 判定由 GATE-B lane 2 于 2026-08-04 实测确立（其 §3.1：在只让专属分支失效的那次探针里，
  > 执行流越过 (ii) 才走到 (iv)，即 (ii) 在错误已经落进通用失败处理的情况下**仍然通过**）；
  > 本波补做 (iv) 的击杀时同一次跑再次复现了它（见下文「修复轮 2」§R2.1 的 (b)：红在 `:1234` 的 (iv)，
  > 而 (ii) 在同一次跑里通过）。
  >
  > **这不是缺陷，也不去修**：按 GATE-B 的处置，**不改测试、不改生产代码去让它「能失败」**——
  > 那只会为了一条指标去动一条正确的生产路径。被更正的只是**说法**：本报告下文 §7 的对照表与
  > progress.md 把四条并列时，应读作「(i) 与 (iii) 有实测击杀，(iv) 可失败（击杀见 §R2.1），
  > (ii) 无任何可失败路径」。
- **(iii) 返回的 `state.status` 仍在 `RESUMABLE_STATUSES` 内**：
  `expect(["planning", "executing", "verifying"]).toContain(finalState.status)`。
  三个成员是就地内联的，并在注释里注明来源 `src/controller/resumeLoop.ts`——
  **没有为测试把它导出**（计划禁令）。
- **(iv) `cleanupAttemptWorkspaceBestEffort` 未被调用**：`expect(await pathExists(observedWorktreePath)).toBe(true)`。
  它经 `cleanupAttemptWorkspaceWithStatus` → `cleanupAttemptWorkspace`（`src/workspace/worktreeManager.ts`）
  执行 `git worktree remove --force`，**目录还在**就是「那次调用没发生」的观测量。

外加两条自有断言：

- `expect(persisted).toEqual(finalState)` —— 这是**补的那次 `writeRunState` 的护栏**：
  `state` 在 `applyPhaseUsage` 之后被推进过而尚未落盘，只 return 不落盘时返回值与磁盘的
  `budgetSnapshot` 会不一致，这条会红。
- `expect(await pathExists(join(runDir, "boundary-analysis.json"))).toBe(false)` ——
  `runExclusive` 之后的那次破坏性写根本没发生。

### 2.3 instanceof 那条（完整测试名 `lease > RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either`）

```ts
    expect(stopped instanceof RunLeaseLostError).toBe(false);
    expect(stopped instanceof RunLeaseUnverifiableError).toBe(false);
    expect(stopped).toBeInstanceOf(Error);
    expect(stopped.stopReason).toBe("heartbeat_stopped");
```

**放置位置的偏离，明写在这里**：计划 Step 4 给的完整测试名是 `lease > …`，但计划的 Files 一节
只允许改 `tests/controller/leaseHeartbeat.test.ts` 与 `tests/controller/runLoop.integration.test.ts`
两个测试文件，而全仓**不存在** `describe("lease")`（实测：
`rtk proxy "grep -rnF 'describe(\"lease' tests/"` 只有
`tests/controller/leaseLifecycle.integration.test.ts:138:describe("lease heartbeat lifecycle", …)` 与
`tests/ownership/lease.test.ts:19:describe("leaseAffirmedAt is written only by the heartbeat", …)`）。
我**照抄了测试名**（含 `lease` 这个 describe），并把新的 `describe("lease")` 块放进
`tests/controller/leaseHeartbeat.test.ts`（该文件已经 import `../../src/ownership/lease.js`，
且在计划的 Files 名单内），**没有去改名单外的 `tests/ownership/lease.test.ts`**。
如果人裁认为它应当落在 `tests/ownership/lease.test.ts`，这是一次搬家，不影响任何断言。

---

## 3. Steps 1–6 的原始输出（TDD 过程，未过滤）

### Step 2 — 测试 7 落地前单跑：红

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseHeartbeat.test.ts -t 'refuses runExclusive after stop, throwing RunHeartbeatStoppedError'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseHeartbeat.test.ts (21 tests | 1 failed | 20 skipped) 10ms
   × startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError 10ms
     → promise resolved "'must not run'" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseHeartbeat.test.ts > startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError
AssertionError: promise resolved "'must not run'" instead of rejecting

- Expected: 
[Error: rejected promise]

+ Received: 
"must not run"

 ❯ tests/controller/leaseHeartbeat.test.ts:370:44
    368|     const fn = vi.fn(async () => "must not run");
    369| 
    370|     await expect(heartbeat.runExclusive(fn)).rejects.toBeInstanceOf(Ru…
       |                                            ^
    371|     expect(fn).not.toHaveBeenCalled();
    372|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 20 skipped (21)
   Start at  01:19:56
   Duration  406ms (transform 113ms, setup 0ms, collect 130ms, tests 10ms, environment 0ms, prepare 46ms)

EXIT=1
```

计数 `1 failed | 20 skipped (21)` —— 具名那条非零，不是「全 skipped 假绿/假红」。
（值得记一笔：此时 `RunHeartbeatStoppedError` 尚不存在，但 esbuild 把 TS 的具名 import 转成
运行期 `undefined` 而非加载期错误，所以拿到的是一条**干净的具名红**，不是文件级加载失败。）

### Step 3 — 实现落地后同一条单跑：绿

```bash
（同一条命令）
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (21 tests | 20 skipped) 8ms

 Test Files  1 passed (1)
      Tests  1 passed | 20 skipped (21)
   Start at  01:20:45
   Duration  367ms (transform 100ms, setup 0ms, collect 119ms, tests 8ms, environment 0ms, prepare 44ms)

EXIT=0
```

### Step 5 — 7b 落地、新分支尚未落地时单跑：红

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state without terminating the run when the heartbeat stops mid-attempt'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (54 tests | 1 failed | 53 skipped) 207ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 207ms
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
+   "attempt_failed",
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
      Tests  1 failed | 53 skipped (54)
   Start at  01:22:57
   Duration  693ms (transform 225ms, setup 0ms, collect 257ms, tests 207ms, environment 0ms, prepare 42ms)

EXIT=1
```

`attempt_failed` 正是「没有新分支时它落进通用失败处理、被转成 `failed`」的那条今天的行为。

### Step 5 — instanceof 那条同一时刻单跑：**绿**（与计划预期不符，据实记录）

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseHeartbeat.test.ts -t 'RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:23:06
   Duration  350ms (transform 102ms, setup 0ms, collect 119ms, tests 2ms, environment 0ms, prepare 36ms)

EXIT=0
```

**这是计划 Step 5 一处不可能满足的要求，如实报告而不是含糊过去**：计划 Step 3 要求先把
`RunHeartbeatStoppedError` 加上，Step 4 才写这条 instanceof 测试，Step 5 又要求它「确认失败」。
但类一旦按 Step 3 的形状（`extends Error`）落地，这条测试就**只能是绿的**——它唯一的失败方式就是
类变成子类，而那正是 Step 7 的变异三。所以它的红在 §4.3 给出，不在 Step 5。

### Step 6 — 新分支落地后两条单跑：都绿

```bash
（7b，同上命令）
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (54 tests | 53 skipped) 176ms

 Test Files  1 passed (1)
      Tests  1 passed | 53 skipped (54)
   Start at  01:23:32
   Duration  682ms (transform 200ms, setup 0ms, collect 252ms, tests 176ms, environment 0ms, prepare 43ms)

EXIT=0
```

```bash
（instanceof，同上命令）
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:23:40
   Duration  401ms (transform 107ms, setup 0ms, collect 128ms, tests 1ms, environment 0ms, prepare 43ms)

EXIT=0
```

---

## 4. Step 7 — 变异实验

**基线绿的前提已满足**：变异跑在这个 git worktree 本体上（不是 scratchpad 副本），
每一次变异之前都先跑了一次具名单跑并拿到绿。所有变异都注入在**生产代码**上，
没有一次是改 fixture。每一处都走三步：**注入前绿 / 注入后红 / 还原后绿**。

计划要求三次变异；我做了**四次**（多出来的是变异 1b），因为控制器补充第 2 条明写
「两条断言各自的红都要在原始输出里看得见」，而变异一只会让第一条断言红——断言在第一次失败处
中止，spy 那条永远跑不到。变异 1b 正是那条断言唯一的杀手。

### 4.1 变异一 — `runExclusive` 退回不拒绝

**具名测试**（完整 `describe > it` 串）：`startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError`
**单跑命令**（`-t` 用裸 `it` 名）：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseHeartbeat.test.ts -t 'refuses runExclusive after stop, throwing RunHeartbeatStoppedError'"; echo "EXIT=$?"
```

**注入**（`src/controller/leaseHeartbeat.ts`）：`const result = queue.then(refuseIfStopped, refuseIfStopped);`
→ `const result = queue.then(fn, fn); // MUTATION 1`

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 6ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:24:02
   Duration  382ms (transform 108ms, setup 0ms, collect 121ms, tests 6ms, environment 0ms, prepare 42ms)

EXIT=0
```

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseHeartbeat.test.ts (22 tests | 1 failed | 21 skipped) 10ms
   × startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError 10ms
     → promise resolved "'must not run'" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseHeartbeat.test.ts > startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError
AssertionError: promise resolved "'must not run'" instead of rejecting

- Expected: 
[Error: rejected promise]

+ Received: 
"must not run"

 ❯ tests/controller/leaseHeartbeat.test.ts:370:44
    368|     const fn = vi.fn(async () => "must not run");
    369| 
    370|     await expect(heartbeat.runExclusive(fn)).rejects.toBeInstanceOf(Ru…
       |                                            ^
    371|     expect(fn).not.toHaveBeenCalled();
    372|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Start at  01:24:15
   Duration  348ms (transform 104ms, setup 0ms, collect 121ms, tests 10ms, environment 0ms, prepare 42ms)

EXIT=1
```

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 18ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:24:28
   Duration  429ms (transform 125ms, setup 0ms, collect 143ms, tests 18ms, environment 0ms, prepare 47ms)

EXIT=0
```

### 4.2 变异 1b — 把 `stopped` 判定挪到 `fn` 结算之后（控制器补充第 1 条的护栏）

**具名测试**：`startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError`（同上，同一条命令）

**注入**（`src/controller/leaseHeartbeat.ts`，`refuseIfStopped` 内）：

```ts
      const value = await fn(); // MUTATION 1b: the check now runs AFTER fn has settled

      if (stopped) { throw new RunHeartbeatStoppedError(…); }

      return value;
```

这正是可达性核验报告点名的「最脆弱前提」被违反的那个形状：它**仍然抛 `RunHeartbeatStoppedError`**，
所以计划原文那条断言照样绿；只有 spy 那条能杀它。

**(a) 注入前 — 绿**：即 4.1(c) 那份输出（`01:24:28`，`1 passed | 21 skipped (22)`，EXIT=0），
代码状态与此处注入前逐字节相同。

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseHeartbeat.test.ts (22 tests | 1 failed | 21 skipped) 11ms
   × startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError 10ms
     → expected "spy" to not be called at all, but actually been called 1 times

Received: 

  1st spy call:

    Array []


Number of calls: 1


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseHeartbeat.test.ts > startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError
AssertionError: expected "spy" to not be called at all, but actually been called 1 times

Received: 

  1st spy call:

    Array []


Number of calls: 1

 ❯ tests/controller/leaseHeartbeat.test.ts:371:20
    369| 
    370|     await expect(heartbeat.runExclusive(fn)).rejects.toBeInstanceOf(Ru…
    371|     expect(fn).not.toHaveBeenCalled();
       |                    ^
    372|   });
    373| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Start at  01:24:49
   Duration  345ms (transform 100ms, setup 0ms, collect 119ms, tests 11ms, environment 0ms, prepare 35ms)

EXIT=1
```

失败点在 **371 行**（spy 那条），而 370 行（`rejects.toBeInstanceOf`）**通过了**——
两条断言各自的红因此都在原始输出里看得见：370 的红见 4.1(b)，371 的红见此处。

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 7ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:25:04
   Duration  412ms (transform 103ms, setup 0ms, collect 122ms, tests 7ms, environment 0ms, prepare 80ms)

EXIT=0
```

### 4.3 变异二 — 把 `RunHeartbeatStoppedError` 放回 `isLeaseStopError`

**具名测试**：`runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt`
**单跑命令**：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state without terminating the run when the heartbeat stops mid-attempt'"; echo "EXIT=$?"
```

**注入（两处协同，缺一不可，理由写在这里）**：「把新错误放回 `isLeaseStopError`」只有在
**专属分支不再遮住它**时才会改变行为——新分支排在谓词分支之前，只改谓词的话它根本轮不到。
所以变异二 = (1) 让专属分支不生效 + (2) 谓词开始匹配它，也就是方案 (a) 未被采用、
错误被路由进 `isLeaseStopError` 的那个反事实：

```ts
// part 1（src/controller/runLoop.ts 外层 catch）
if (error instanceof RunHeartbeatStoppedError && Boolean(process.env.MUTATION_2_OFF)) {

// part 2（src/controller/runLoop.ts，isLeaseStopError 体内）
return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError || error instanceof RunHeartbeatStoppedError;
```

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (54 tests | 53 skipped) 188ms

 Test Files  1 passed (1)
      Tests  1 passed | 53 skipped (54)
   Start at  01:25:23
   Duration  687ms (transform 194ms, setup 0ms, collect 237ms, tests 188ms, environment 0ms, prepare 45ms)

EXIT=0
```

**(b) 注入后 — 红，(i) 命中**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (54 tests | 1 failed | 53 skipped) 198ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 197ms
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
      Tests  1 failed | 53 skipped (54)
   Start at  01:26:06
   Duration  728ms (transform 227ms, setup 0ms, collect 262ms, tests 198ms, environment 0ms, prepare 42ms)

EXIT=1
```

`loop_cancelled` 就是计划所警告的那次永久终结。

**(b2) 让 (iii) 自己的红也可见**：断言在第一处失败即中止，(iii) 在同一次跑里够不到。为此我在
**变异二仍然在位**的前提下，临时把 (i) 与 (ii) 的断言注释掉（**只改测试、只为取证、随后立即还原**，
注释里写明 `EVIDENCE-ONLY`），重跑同一条：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (54 tests | 1 failed | 53 skipped) 176ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 175ms
     → expected [ Array(3) ] to include 'cancelled'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt
AssertionError: expected [ Array(3) ] to include 'cancelled'
 ❯ tests/controller/runLoop.integration.test.ts:1230:52
    1228|     // (iii) the run stays resumable. RESUMABLE_STATUSES is module-pri…
    1229|     // src/controller/resumeLoop.ts, so its three members are inlined …
    1230|     expect(["planning", "executing", "verifying"]).toContain(finalStat…
       |                                                    ^
    1231| 
    1232|     // (iv) cleanupAttemptWorkspaceBestEffort did not run. It removes …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 53 skipped (54)
   Start at  01:26:36
   Duration  658ms (transform 196ms, setup 0ms, collect 246ms, tests 176ms, environment 0ms, prepare 39ms)

EXIT=1
```

`finalState.status` 变成了 `cancelled` —— **(iii) 独立地红**。

**(c) 还原后（生产代码与测试文件都已还原）— 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (54 tests | 53 skipped) 266ms

 Test Files  1 passed (1)
      Tests  1 passed | 53 skipped (54)
   Start at  01:27:10
   Duration  785ms (transform 221ms, setup 0ms, collect 272ms, tests 266ms, environment 0ms, prepare 46ms)

EXIT=0
```

还原完整性的机器证明（全仓无变异残留）：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'MUTATION' src/ tests/"; echo "EXIT=$?"
EXIT=1
```

（`-F` 定值扫描，零行输出、exit 1 = 无命中。）

> **Amended 2026-08-04（GATE-B 修复波，原句一字未删）**：**上面这条扫描证明不了 (b2) 的测试侧还原。**
> 生产侧的两处注入标记确实写作 `MUTATION`，所以这条 `-F 'MUTATION'` 对**生产侧**是有效的；
> 但 (b2) 那次把 (i)(ii) 注释掉的**测试侧**改动，标记按上文自己写的是 `EVIDENCE-ONLY`——
> **这条扫描不可能命中它**。也就是说，「测试文件也已还原」这句话当时**没有被任何证据支持**，
> 而这一段恰恰是拿来当还原证明用的。
>
> **事实上确实还原了**，但这个事实是**事后**由 GATE-B lane 2 于 2026-08-04 在 `6935578` 上**读源码**
> 确立的（其 §1.1 的 E-2：7b 的 (i)(ii)(iii)(iv) 四块断言在树上全部在位、未被注释）；
> 当时那次跑给出的 `EXIT=1` 与它无关。**被更正的是证明手段，不是结论。**
>
> **教训（已写进 GATE-B 的记账）**：临时改动必须用**与其自身标记词匹配**的扫描来证明还原，
> 或者直接用 `git status --porcelain` / `git diff` 这种与标记词无关的手段；不能沿用另一处的定值扫描。
> 本波的注入总账遵守了这一条——统一标记 `GATEB-FIX-PROBE`，扫描用的就是这个词本身（见 §R2.3）。

### 4.4 变异三 — 把 `RunHeartbeatStoppedError` 改成 `RunLeaseLostError` 的子类

**具名测试**：`lease > RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either`
**单跑命令**：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/leaseHeartbeat.test.ts -t 'RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either'"; echo "EXIT=$?"
```

**注入**（`src/ownership/lease.ts`）：
`export class RunHeartbeatStoppedError extends Error {` → `export class RunHeartbeatStoppedError extends RunLeaseLostError { // MUTATION 3`

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:27:20
   Duration  337ms (transform 100ms, setup 0ms, collect 116ms, tests 1ms, environment 0ms, prepare 36ms)

EXIT=0
```

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/leaseHeartbeat.test.ts (22 tests | 1 failed | 21 skipped) 6ms
   × lease > RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either 5ms
     → expected true to be false // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/leaseHeartbeat.test.ts > lease > RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/controller/leaseHeartbeat.test.ts:752:50
    750|     const stopped = new RunHeartbeatStoppedError("run heartbeat has st…
    751| 
    752|     expect(stopped instanceof RunLeaseLostError).toBe(false);
       |                                                  ^
    753|     expect(stopped instanceof RunLeaseUnverifiableError).toBe(false);
    754|     // The sibling half: still a plain Error, so runLoopFromState's ou…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 21 skipped (22)
   Start at  01:27:32
   Duration  355ms (transform 111ms, setup 0ms, collect 124ms, tests 6ms, environment 0ms, prepare 45ms)

EXIT=1
```

**(b2) 同一变异下 7b 仍然绿——这正是这条断言存在的理由**（额外取证，不是计划要求）：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (54 tests | 53 skipped) 248ms

 Test Files  1 passed (1)
      Tests  1 passed | 53 skipped (54)
   Start at  01:27:42
   Duration  792ms (transform 217ms, setup 0ms, collect 254ms, tests 248ms, environment 0ms, prepare 61ms)

EXIT=0
```

即：**只把类改成子类**（不动谓词）时，专属分支仍排在前面、仍能匹配，7b 察觉不到任何异常；
唯一会红的是这条 instanceof 断言。这与计划「它比『改谓词』更容易被无意做出，而且没有任何
测试名会提示原因」的判断吻合，也说明这条断言不是冗余。

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests | 21 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 21 skipped (22)
   Start at  01:27:55
   Duration  335ms (transform 104ms, setup 0ms, collect 121ms, tests 1ms, environment 0ms, prepare 39ms)

EXIT=0
```

---

## 5. Step 8 — 全套件 / typecheck / build（未过滤）

### 5.1 第一次全套件跑：9 条名单外失败（环境缺陷，完整记录）

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"; echo "EXIT=$?"
```

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 5ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 9ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 402ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 145ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 19ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 37ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 1968ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1576ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/ownership/lease.test.ts (16 tests) 5ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-T1pz8j/does-not-exist'

 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-AOMYGl/run-1  observed 2026-08-03T17:28:31.959Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 457ms
   ✓ parseArgs > returns 0 for the scripted example run 334ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 11ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2728ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 314ms
   ✓ resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState 307ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 340ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 4ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 256ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3237ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 382ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 338ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 411ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 441ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 393ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 332ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 530ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2641ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 739ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 611ms
   ✓ render-contract CLI > rejects a non-git repository path 622ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 660ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 591ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 589ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6913ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop returns, so the next resume proceeds immediately 305ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 584ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 531ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 613ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 534ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 412ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 397ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 390ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 358ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9667ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 488ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 451ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 381ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 371ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 398ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 385ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 382ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 380ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 447ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 368ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 358ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 352ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 370ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 369ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 509ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 384ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 522ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 507ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 405ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 558ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 391ms
 ❯ tests/validation/evidence.test.ts (39 tests | 9 failed) 11333ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1506ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1252ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 4630ms
   × run-scenario CLI > works when invoked outside the repo root 374ms
     → spawn /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop/node_modules/.bin/tsx ENOENT
   × run-scenario CLI > runs when invoked through a canonical-path alias 380ms
     → spawn /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop/node_modules/.bin/tsx ENOENT
   × run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 383ms
     → spawn /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop/node_modules/.bin/tsx ENOENT
   × run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 389ms
     → expected false to be true // Object.is equality
   × run-scenario CLI > fails on an existing evidence directory without overwriting it 374ms
     → expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)
   × run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 383ms
     → expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)
   × run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 749ms
     → expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)
   × run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 371ms
     → expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)
   × run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 376ms
     → spawn /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop/node_modules/.bin/tsx ENOENT
 ✓ tests/controller/runLoop.integration.test.ts (54 tests) 11501ms
   ✓ runLoop > succeeds when verification approves 301ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 398ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 302ms
   ✓ runLoop > stops immediately when a stopOn signal matches 345ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 893ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 9 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > works when invoked outside the repo root
 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > runs when invoked through a canonical-path alias
 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist
 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked
Error: spawn /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop/node_modules/.bin/tsx ENOENT
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/9]⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ tests/validation/evidence.test.ts:1475:68
    1473|     ).rejects.toMatchObject({});
    1474| 
    1475|     expect(await pathExists(join(evidenceDir, "invocation.json"))).toB…
       |                                                                    ^
    1476|     expect(await pathExists(join(evidenceDir, "artifacts.json"))).toBe…
    1477|     expect(await pathExists(join(evidenceDir, "git.json"))).toBe(true);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/9]⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > fails on an existing evidence directory without overwriting it
AssertionError: expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)

- Expected
+ Received

- Object {
-   "stderr": StringMatching /evidenceDir already exists/,
+ Error {
+   "stderr": "",
  }

 ❯ tests/validation/evidence.test.ts:1502:5
    1500|     await writeFile(contractPath, `${JSON.stringify(renderScenario("A"…
    1501| 
    1502|     await expect(
       |     ^
    1503|       execFileAsync(
    1504|         tsxBin,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/9]⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data
AssertionError: expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)

- Expected
+ Received

- Object {
-   "stderr": StringMatching /runDir already exists/,
+ Error {
+   "stderr": "",
  }

 ❯ tests/validation/evidence.test.ts:1545:5
    1543|     await writeFile(contractPath, `${JSON.stringify(renderScenario("A"…
    1544| 
    1545|     await expect(
       |     ^
    1546|       execFileAsync(
    1547|         tsxBin,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/9]⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath
AssertionError: expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)

- Expected
+ Received

- Object {
-   "stderr": StringMatching /contract.*repoPath.*fixture/i,
+ Error {
+   "stderr": "",
  }

 ❯ tests/validation/evidence.test.ts:1584:5
    1582| `);
    1583| 
    1584|     await expect(
       |     ^
    1585|       execFileAsync(
    1586|         tsxBin,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/9]⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch
AssertionError: expected Error: spawn /Users/biran/code/skills/loo… { …(8) } to match object { stderr: StringMatching{…} }
(7 matching properties omitted from actual)

- Expected
+ Received

- Object {
-   "stderr": StringMatching /objective\.taskId|scenario/i,
+ Error {
+   "stderr": "",
  }

 ❯ tests/validation/evidence.test.ts:1626:5
    1624|     await writeFile(adapterConfigPath, `${JSON.stringify({ command: [p…
    1625| 
    1626|     await expect(
       |     ^
    1627|       execFileAsync(
    1628|         tsxBin,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/9]⎯

 Test Files  1 failed | 28 passed (29)
      Tests  9 failed | 478 passed (487)
   Start at  01:28:28
   Duration  12.14s (transform 2.52s, setup 0ms, collect 3.70s, tests 51.96s, environment 3ms, prepare 1.55s)

EXIT=1
```

**处置（按「名单外任何失败一律按新缺陷处理，不许重跑掩盖」执行）**：先完整捕获（上面这份），
再定位。9 条全部落在 `tests/validation/evidence.test.ts` 的 `run-scenario CLI` 组，根因是
`tsxBin` 用 `process.cwd()` 拼绝对路径（`tests/validation/evidence.test.ts:24`），而这个 worktree
当时没有自己的 `node_modules`（§0 的两条 `ls` 实测）。**与本次改动无关**的三条独立佐证：
(1) 失败信息是 `spawn … ENOENT`，是进程启动失败，不是任何断言语义；
(2) 这 9 条全部不触碰 `runLoop` / `leaseHeartbeat` / `lease`；
(3) 装上依赖后 9 条全绿，代码一个字节没动（§5.2）。
处置动作是 `rtk proxy "npm ci"`（`node_modules/` 已在 `.gitignore` 里，且 `npm ci` 不改
`package-lock.json`；实测输出 `added 51 packages, and audited 52 packages in 4s`，EXIT=0），
**不是**改测试、不是重跑掩盖。允许名单里的两条（(B) `records env names only …`、
(F) `continues normally when execute returns a complete result during the recovery window`）
在两次全套件跑里**都是 `✓`**。

### 5.2 装依赖后的全套件跑：29/29 文件、487/487 用例、exit 0

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"; echo "EXIT=$?"
```

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 450ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 146ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 132ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 5ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 40ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-yqN2Fn/does-not-exist'

 ✓ tests/persistence/fileStore.test.ts (76 tests) 2570ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 2199ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-Q8UA92/run-1  observed 2026-08-03T17:29:59.363Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 375ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 3008ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 304ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 374ms
   ✓ resumeLoop > refuses a resume against a live lease and mutates nothing but events 303ms
   ✓ resumeLoop > does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field) 372ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 315ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 16ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3395ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 350ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 320ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 332ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 446ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 579ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 427ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 316ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 501ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 265ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2993ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 937ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 649ms
   ✓ render-contract CLI > rejects a non-git repository path 625ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 773ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 4ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 626ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 624ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 7234ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 619ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 639ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 598ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 522ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 497ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 400ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 534ms
   ✓ lease heartbeat lifecycle > check 2: stops at the retry boundary itself, without ever reaching a second top-of-loop pass 336ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 371ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 7443ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 504ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 430ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 328ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 376ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 356ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 367ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 416ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 407ms
 ✓ tests/controller/runLoop.integration.test.ts (54 tests) 11893ms
   ✓ runLoop > does not succeed when verifierType is command and a required check fails 326ms
   ✓ runLoop > does not succeed when approved verification is missing required evidence 346ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 369ms
   ✓ runLoop > stops immediately when a stopOn signal matches 336ms
   ✓ runLoop > exhausts the run when planning exceeds per-attempt timeout 301ms
   ✓ runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 356ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 606ms
 ✓ tests/validation/evidence.test.ts (39 tests) 16487ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1680ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1251ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2677ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1607ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1570ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1571ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 628ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 599ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 591ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 985ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 597ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2523ms

 Test Files  29 passed (29)
      Tests  487 passed (487)
   Start at  01:29:56
   Duration  17.09s (transform 2.14s, setup 0ms, collect 3.34s, tests 57.12s, environment 3ms, prepare 1.66s)

EXIT=0
```

**我这次执行的数字：29 个测试文件、487 条用例、exit 0。** 计划里的 446 是计划阶段（组 A 之前）的
基线，按 Global Constraints 的要求**不引用它**；487 是我这一跑的实测值。本任务新增 **3 条**用例
（测试 7、测试 7b、instanceof 那条），即本分支基点 `a7c26c9` 上应为 484 条。

**新增条数的逐条核对**：

- `tests/controller/leaseHeartbeat.test.ts`：Step 2 那次跑显示 **21 tests**（只加了测试 7 之前是 20 条 + 测试 7 = 21）；
  加了 instanceof 那条之后显示 **22 tests**。→ 本文件 +2。
- `tests/controller/runLoop.integration.test.ts`：Step 5 那次跑显示 **54 tests**（含新加的 7b）。→ 本文件 +1。
- 合计新增 **3 条**用例。

### 5.3 typecheck

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "npm run typecheck"; echo "typecheck_exit=$?"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

### 5.4 build

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "npm run build"; echo "build_exit=$?"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

### 5.5 边界与禁令的计数守卫

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -cF 'return { ok: false' src/controller/resumeLoop.ts"; echo "EXIT=$?"
8
EXIT=0
```

**仍为 8**，与计划阶段实测一致 —— `evaluateResumeEligibility` 的八条判据一个字节未改。

---

## 6. 行号引用扫描（收尾要求）

本次插入使三个文件的部分行号位移：`lease.ts` 第 38 行起 +17；`leaseHeartbeat.ts`
`runExclusive` 上方注释之后 +28（`runExclusive` 定义 196→209、`stop` 216→239、`assertHeld` 252→275）；
`runLoop.ts` 外层 catch 之后 +24（老的 `isLeaseStopError` 分支 1443→1467）。位于插入点之前的
行号（`runLoop.ts` 的 107 / 786 / 903 / 905 / 1062 / 1069 / 1177 / 1231，`lease.ts` 的 1–36）**位移为 0**。

`src/` 与 `tests/` 范围内指向这三个文件的行号引用，实测只有一处：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnE -e '(runLoop|leaseHeartbeat|lease)\.ts:[0-9]+' src/ tests/"
src/registry/observeFields.ts:18:    // (lease.ts:7-8). Sleeps run between attempts only, so the worst case is 2 × 50ms ≈ 100ms.
EXIT=0
```

（**需要正则：只看输出行，退出码不作为论据。**）
`lease.ts:7-8` 落在插入点之前，仍然逐字指向
`LEASE_VERIFY_READ_ATTEMPTS = 3` / `LEASE_VERIFY_RETRY_DELAY_MS = 50`，**未失效，无需改动**。

`docs/` 与 `.superpowers/sdd/` 里另有大量 `runLoop.ts:NNN` 形式的历史引用。按本仓库既定立场
（`docs/handoff/handoff.md:404` 明写：「它们按不可改写的历史过程记录处理，刻意一条未动」），
我**一条未动**。其中与本任务直接相关的是同目录的 `task-B1-reachability-report.md`：它自陈锚定在
`a7c26c9`，其引用的 `leaseHeartbeat.ts:196 / 217 / 221 / 252-306` 与 `runLoop.ts:1434 / 1443`
在 `dab1040` 上已位移（新值见上一段），**但它引用的 `runLoop.ts:786 / 903 / 905 / 1062 / 1177 / 1231`
位移为 0，其裁定所依赖的那几个位置全部仍然有效**。

---

## 7. 与计划/控制器补充的逐条对照

| 要求 | 落地情况 | 证据 |
|---|---|---|
| 新类与现有两个**并列**，非子类，无共同基类 | 是 | §1.1 diff；§4.4 变异三 |
| 新类带 `deliberately NOT a subclass` 同形注释并**点名 `isLeaseStopError`** | 是 | §1.1；`grep -rnF 'NOT a subclass' src/` 5 行 |
| 只从 `runExclusive` 抛，**绝不从 `assertHeld` 抛** | 是 | §1.2 的 `stopped` grep：assertHeld 体（275 起）内无语句级 `stopped` |
| `stopped` 判定在 `fn` **之前**（控制器补充 1） | 是（续体开头判定） | §1.2；§4.2 变异 1b |
| 测试 7 用 spy 断言 `fn` 从未被调用（控制器补充 2） | 是 | §2.1；§4.2 变异 1b 单独杀这条 |
| `runExclusive` 上方那条注释就地更新 | 是 | §1.4 diff |
| `isLeaseStopError` 谓词与签名不改 | 是 | §1.4 diff 中不含该函数 |
| 「the two ways …」那句不改 | 是 | 同上 |
| 新分支排在 `isLeaseStopError` 分支之前 | 是 | 1449 < 1467 |
| 新分支：追加 `heartbeat_stopped` → `writeRunState` → 返回非终态 `state`，**不调 `persistTerminalState`** | 是 | §1.3；测试 7b (i) |
| 副作用 2（抢掉 `cleanupAttemptWorkspaceBestEffort`）在 7b 里被断言 | 是 | 测试 7b (iv) |
| 不碰 `stop()` | 是 | §1.4 diff |
| 不碰 `INERT_LEASE_HEARTBEAT` 与三处测试替身桩 | 是 | §1.4 diff + 测试 diff 未触及桩行 |
| 不导出 `persistBoundaryAnalysis` / `RESUMABLE_STATUSES` | 是 | 7b 内联三个成员；§1.4 |
| `src/registry/` 零改动 | 是 | `git status --porcelain` 只有 5 个文件 |
| 无 `git clean` / `reset --hard` / 广域 `restore`；未删任何受保护对象 | 是 | 全程只用 `git add` / `git commit` |
| 不 push、不 merge | 是 | 只有本地 commit `dab1040` |

---

## 8. Concerns 与范围声明（第 1–7 项是交给人裁的 concerns，第 8 项是「未做的事」的范围声明；我没有自作主张）

1. **`describe("lease")` 的落点。** 计划 Step 4 给的完整测试名是 `lease > …`，但计划的 Files
   只允许改两个测试文件，而全仓不存在 `describe("lease")`。我照抄测试名，把新 describe 块放进
   `tests/controller/leaseHeartbeat.test.ts`（在名单内、已 import `lease.js`），**没有**去改名单外的
   `tests/ownership/lease.test.ts`。若本意是后者，请裁定搬家。详见 §2.3。

2. **计划 Step 5 有一条不可能满足的要求，我没有伪造它。** Step 3 先落地类、Step 4 才写 instanceof
   测试，于是 Step 5 要求的「这条也确认失败」在那个时点**只能是绿**（它唯一的失败方式是类变成子类）。
   我如实贴了那次绿（§3 Step 5 第二块），并把它的红放在 §4.4 变异三。请确认这个处理方式可接受。

3. **变异二是两处协同注入，不是一处。** 「把新错误放回 `isLeaseStopError`」单独做不改变任何行为
   ——新分支排在前面会先接走它。我因此把变异二实现为「专属分支不生效 + 谓词开始匹配」，即方案 (a)
   未被采用的那个反事实。若评审员认为这偏离了计划字面，我接受重做，但请先看 §4.3 的理由。

4. **(iii) 的红是在一次「临时注释掉 (i)/(ii) 断言」的取证跑里拿到的。** 断言在第一处失败即中止，
   同一次跑看不到两条。那次临时改动只动测试、带 `EVIDENCE-ONLY` 标注、随后立即还原，还原后的绿与
   `grep -rnF 'MUTATION' src/ tests/` 零命中都贴在 §4.3。如果评审规矩要求 (iii) 必须在**未被改动的**
   测试文件上独立变红，那需要把 (iii) 提到 (i) 之前——我没有擅自调整断言顺序。

5. **`npm ci` 是我对这个 worktree 做的一次环境改动**（新建了被 gitignore 的 `node_modules/`）。
   它不改任何被 track 的文件、不改 `package-lock.json`，但它确实改变了「这个 worktree 里跑全套件
   会得到什么」。如果组 B 的其它任务在别的 worktree 里跑，**它们会撞到同样的 9 条假失败**，
   建议把这条写进 handoff 的环境陷阱清单（我没有自行去改 handoff）。

6. **可达性核验报告里的行号已被本次提交位移**（`leaseHeartbeat.ts:196/217/221/252-306`、
   `runLoop.ts:1434/1443`）。按本仓库「历史记录不改写」的既定立场我一条未动，只在 §6 里就地
   勘误并给出新值。若人裁希望在那份报告里加一条 supersession 标注，请指示。

7. **我自己最不确定的一处（主动写出来，不赌评审员看不见）**：`runExclusive` 的拒绝我选了
   「续体开头判定」而非「调用时同步拒绝」。它严格更强（覆盖「入队在 `stop()` 之前、轮到在 `stop()`
   之后」这一种时序），但它也意味着**一个在 `stop()` 之前就已发起的 `runExclusive` 现在可能被拒绝**，
   而在 `a7c26c9` 上它会正常执行。今天这不构成行为差异（`stop()` 之后 `runExclusive` 在 L3 内不可达，
   而 `stop()` 自身会 `await queue`，队列里已在跑的那一项不受影响 —— 只有**尚未轮到**的那一项会被拒），
   但这是一条我做的、计划没有逐字指定的选择。若人裁更希望「只在调用时同步判定」，改动是三行。

8. **未做、也不打算擅自做的事**：`persistTerminalState` 往已不拥有的 run 写（债 2）一个字节没碰；
   `transferRepresentsPublishedWinner` 没碰；`persistBoundaryAnalysis` 两个调用点上的
   `options?.onReconciliationWriteAbandoned` 参数没碰（其中一个被独立验证为今天不可达，保留是组 A 的
   既定裁定）。

---

# 修复轮 1

**提交**：`b427c8b`（本轮单独一笔；上一笔是 `dab1040`）
**范围**：人裁下达的三件事，范围之外一律未动。**生产代码零改动**（本轮 diff 只含
`docs/superpowers/plans/…` 与本报告，见 §R1.4）。

人裁结论我照单执行、没有自行扩大：I-1 判为「计划的判据前提为假，不是实施缺陷」——**没有**补测试、
**没有**动分支排序、**没有**动谓词；I-2 判为「就地记账，代码一个字不改」——ledger 由控制器写，我没碰；
concern 5（续体形状）人未推翻——**保持现状**。

## R1.1 第 (1) 件事：补跑第五条变异（M-1）

**具名测试**（完整 `describe > it` 串）：
`runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt`

**单跑命令**（`-t` 用裸 `it` 名）：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state without terminating the run when the heartbeat stops mid-attempt'"; echo "EXIT=$?"
```

**注入**（`src/controller/runLoop.ts`，外层 catch 的新分支内）：删掉该分支自己的
`await writeRunState(runDir, state);`，其余一字不动：

```ts
          detail: String(error),
        });
        // MUTATION 5: the branch's own writeRunState is removed
        return state;
      }
```

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (54 tests | 53 skipped) 175ms

 Test Files  1 passed (1)
      Tests  1 passed | 53 skipped (54)
   Start at  19:20:40
   Duration  711ms (transform 233ms, setup 0ms, collect 273ms, tests 175ms, environment 0ms, prepare 40ms)

EXIT=0
```

**(b) 注入后 — 红**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (54 tests | 1 failed | 53 skipped) 201ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 200ms
     → expected { status: 'executing', …(7) } to deeply equal { status: 'executing', …(7) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt
AssertionError: expected { status: 'executing', …(7) } to deeply equal { status: 'executing', …(7) }

- Expected
+ Received

  Object {
    "attemptsUsed": 1,
    "budgetSnapshot": Object {
      "attemptsRemaining": 2,
-     "timeRemainingMs": 0,
+     "timeRemainingMs": 19,
      "tokenBudgetRemaining": 1000,
    },
    "currentAttempt": 1,
    "lastTransitionAt": "2026-08-04T11:20:54.143Z",
    "recentFailures": Array [],
    "status": "executing",
    "stopReason": null,
    "waitingOnHuman": false,
  }

 ❯ tests/controller/runLoop.integration.test.ts:1216:23
    1214|     // phase consumed measurable runtime), so a branch that only retur…
    1215|     // state whose budgetSnapshot disagrees with the one on disk.
    1216|     expect(persisted).toEqual(finalState);
       |                       ^
    1218|     // (ii) execution-recovery.json's cleanupStatus was never backfill…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 53 skipped (54)
   Start at  19:20:53
   Duration  665ms (transform 192ms, setup 0ms, collect 236ms, tests 201ms, environment 0ms, prepare 44ms)

EXIT=1
```

**(c) 还原后 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (54 tests | 53 skipped) 165ms

 Test Files  1 passed (1)
      Tests  1 passed | 53 skipped (54)
   Start at  19:21:14
   Duration  662ms (transform 215ms, setup 0ms, collect 255ms, tests 165ms, environment 0ms, prepare 44ms)

EXIT=0
```

三份输出的具名计数分别是 `1 passed | 53 skipped (54)` / `1 failed | 53 skipped (54)` /
`1 passed | 53 skipped (54)` —— 没有一块是「全 skipped」。

**结果判读（从推演变成实测）**：**红了**，红在 **`tests/controller/runLoop.integration.test.ts:1216`
的 `expect(persisted).toEqual(finalState)`**，也就是 §2.2 里为这次 `writeRunState` 专门写的那条自有断言。
差异只有一个字段：`budgetSnapshot.timeRemainingMs`，**磁盘 19 / 返回值 0**。
注意方向——`expect(received).toEqual(expected)` 里 received 是 `persisted`（磁盘）、expected 是
`finalState`（返回值），所以输出里 `- Expected 0` 是返回值、`+ Received 19` 是磁盘。这与评审员的推演
逐字吻合：execute 相位的 `applyPhaseUsage` 把 `timeRemainingMs` 从 19 打到 0 并只体现在内存里的
`state` 上，删掉分支自己的落盘后，磁盘停在 `attempt_started` 那次 `writeRunState` 写下的 19。
**没有出现「不红」这个需要立刻停下上报的情形。**

**还原完整性（本轮）**：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "git status --porcelain"; echo "status_exit=$?"
status_exit=0
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'MUTATION' src/ tests/"; echo "grep_exit=$?"
grep_exit=1
```

（变异还原后、本轮任何编辑落地之前跑的：工作树零输出即完全干净；`-F` 定值扫描零命中、exit 1。）

**至此 B1 的变异实验共五条**：变异一（`runExclusive` 退回不拒绝 → 测试 7 的 `rejects` 断言红）、
变异 1b（判定挪到 `fn` 之后 → 测试 7 的 spy 断言红）、变异二（协同注入 → 7b 的 (i)、(iii) 各自红）、
变异三（子类化 → instanceof 那条红）、变异五（删掉分支的 `writeRunState` → 7b 的
`persisted toEqual finalState` 红）。

## R1.2 第 (2) 件事：给计划就地勘误

文件 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`，
**只动 `### Task B1` 一节**，且只在 Step 7 变异二那一条下面**新增**一段注解，
**原句一个字未删未改**（照组 A 四处 `Amended 2026-08-02` 的判例形状与口气；标记写 `Amended 2026-08-04`）。

改动面的机器证明：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "git --no-pager diff --stat docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md"
 .../plans/2026-08-02-sweep-and-transactional-continuation.md        | 6 ++++++
 1 file changed, 6 insertions(+)
```

**6 insertions、0 deletions**，且 diff 的 hunk 头是 `@@ -1288,2 +1288,8 @@`，上下文行分别是
Step 7 的第 2 条与第 3 条 —— 落点确实在 Task B1 的 Step 7 变异二之下，没有溢出到别的节。

勘误写明的三件事（与人裁交代逐条对应）：(i) 该判据的实际可执行形状是**协同注入**（专属分支失效 +
谓词加宽），也就是我实际做的那样；(ii) **纯谓词加宽今天没有任何合法的行为测试可以杀掉它**——唯一形状
要靠 `assertHeld` 抛出该错误，而硬约束二禁止这件事、且那条路的两个结局都不在 `RESUMABLE_STATUSES` 内；
(iii) 这是方案 (a) 的**结构后果**，硬约束第一半目前只有「子类化」那半边有可失败断言（instanceof 那条），
「谓词加宽」那半边靠注释承载。**按人裁要求，勘误里没有写任何「将来应该怎么修」的建议。**

## R1.3 第 (3) 件事：报告卫生（M-3）

- 删掉文件末尾残留的两行工具标记 `</content>` / `</invoke>`（原第 1573–1574 行）。定位命令与改前实测：

  ```bash
  rtk proxy "grep -nF -e '</content>' -e '</invoke>' -e '## 8.' .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-B1-report.md"
  1533:## 8. Concerns（交给人裁，我没有自作主张）
  1573:</content>
  1574:</invoke>
  rtk proxy "wc -l .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-B1-report.md"
      1574 .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-B1-report.md
  ```

- 第 8 节标题改为名副其实：原标题只写 `Concerns` 却含 8 项、而第 8 项是「未做的事」的范围声明，
  现改为 `## 8. Concerns 与范围声明（第 1–7 项是交给人裁的 concerns，第 8 项是「未做的事」的范围声明；我没有自作主张）`。
  **八项内容一字未改**，只改标题。

## R1.4 本轮的全套件 / typecheck / build（未过滤）

本轮不改生产代码，但按仓库铁律仍然跑满三样。

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"; echo "EXIT=$?"
```

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 8ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 433ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 171ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 26ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 4ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 39ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 2023ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1606ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-gOZrHP/does-not-exist'

 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-d7PhXB/run-1  observed 2026-08-04T11:22:50.889Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 438ms
   ✓ parseArgs > returns 0 for the scripted example run 320ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 23ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2700ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 318ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2516ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 685ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 559ms
   ✓ render-contract CLI > rejects a non-git repository path 613ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 651ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 262ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3190ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 323ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 310ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 351ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 409ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 404ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 419ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 329ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 511ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 577ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 574ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 7017ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 609ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 571ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 645ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 517ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 404ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 386ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 382ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 398ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9595ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 471ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 359ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 363ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 418ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 376ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 381ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 388ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 395ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 379ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 354ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 348ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 434ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 347ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 355ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 541ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 440ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 519ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 488ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 380ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 568ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 393ms
 ✓ tests/controller/runLoop.integration.test.ts (54 tests) 11412ms
   ✓ runLoop > prioritizes the post-execute path-policy human gate over budget exhaustion 330ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 341ms
   ✓ runLoop > stops immediately when a stopOn signal matches 312ms
   ✓ runLoop > persists owner transfer artifacts and continuation eligibility after a controller-owned OWNER_LOST takeover-allowed verdict without resuming execution 313ms
   ✓ runLoop > writes no synthesized winner reconciliation view when another controller already completed the transfer before success reconciliation was written 331ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 704ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15913ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1408ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1205ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2616ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1631ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1526ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1562ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 588ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 600ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 626ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 936ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 572ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2463ms

 Test Files  29 passed (29)
      Tests  487 passed (487)
   Start at  19:22:47
   Duration  16.60s (transform 2.45s, setup 0ms, collect 3.90s, tests 56.39s, environment 3ms, prepare 1.90s)

EXIT=0
```

**本轮实测：29 个测试文件、487 条用例、exit 0**，与修复轮前逐字相同（本轮不加不减用例）。
允许名单上的两条（(B) `records env names only …`、(F) `continues normally when execute returns a
complete result during the recovery window`）都是 ✓，名单外零失败。

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

## R1.5 本轮 concerns

**无新增 concerns。** 第一轮的 concerns 1–7 仍然挂在第 8 节，其中 5（续体形状）已被人裁维持现状、
不再需要裁定；1–4、6–7 未被本轮触及，状态不变。本轮没有发现任何需要立刻停下上报的情形
——M-1 变异如预期变红，且红在为它专门写的那条断言上。

---

# 修复轮 2 —— GATE-B 修复波（2026-08-04）

**这一整节新增于 2026-08-04 的 GATE-B 修复波，全节标注为补做，不回填时间。**
它**不是**原轮次或修复轮 1 的产物。触发它的是 GATE-B lane 2（整分支「变异与测试证据全量重扫」）
的 finding F-1／F-2／F-5，报告在同目录 `gate-b-lane2-report.md`。
**本节对 B1 的生产代码零改动**（本波唯一一处代码改动是 B2 的一条测试断言，记在 `task-B2-report.md` §4.2）。

三条 finding 在 B1 报告里的落点：

| lane 2 finding | 处置 | 落点 |
|---|---|---|
| **F-1** 7b 的 (ii) 是文档不是护栏 | 就地更正说法，**不改测试也不改生产代码** | §2.2 的 (ii) 那条下的 `Amended 2026-08-04` |
| **F-2** 7b 的 (iv) 可失败但从未被演示 | **补记这次击杀**（本波自己重跑，见 §R2.1） | 本节 §R2.1 |
| **F-5 / E-2** 变异二 (b2) 的还原证明用错了扫描词 | 就地更正证明手段的表述 | §4.3 末尾的 `Amended 2026-08-04` |

## R2.1 补记：7b 的 (iv) 的击杀（本波自己重跑，不是照抄 lane 2）

**具名测试**（完整 `describe > it` 串）：
`runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt`

**单跑命令**（`-t` 用裸 `it` 名）：

```bash
cd .../l3-debt3-heartbeat-stop && export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'returns a resumable state without terminating the run when the heartbeat stops mid-attempt'"; echo "EXIT=$?"
```

**为什么这条击杀需要「注释掉前面的断言」这一招**：(iv) 被 (i) 永久遮住——任何能让 (iv) 红的变异
都会先让 (i) 红，而 vitest 在第一处断言失败即中止。§4.3 的 (b2) 已经对 (iii) 用过这一招救活它的红，
**对 (iv) 没做，也没说明为什么不做**（这正是 lane 2 的 F-2 所指）。这里补做。

**注入（两部分，都带 `GATEB-FIX-PROBE` 标记）**：

1. **生产侧**（`src/controller/runLoop.ts` 外层 catch）：**只**让专属分支失效，**不加宽谓词**——
   错误因此落到外层 catch 的通用失败处理（`transitionRunState("failed")` →
   `cleanupAttemptWorkspaceBestEffort`），也就是「新分支不存在时会发生什么」的那个反事实：

   ```ts
   if (error instanceof RunHeartbeatStoppedError && Boolean(process.env.GATEB_FIX_PROBE_OFF)) { // GATEB-FIX-PROBE
   ```

2. **测试侧**（`tests/controller/runLoop.integration.test.ts`，7b 内）：把 (i) 的三条与它下面的
   `expect(persisted).toEqual(finalState)`、以及 (iii) 那条**临时注释掉**，让执行流够得到 (iv)。
   （(ii) 不注释——本波要顺带看它在同一次跑里是不是通过，那是 F-1 的实测面。）

**(a) 注入前 — 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 172ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:25:19
   Duration  638ms (transform 202ms, setup 0ms, collect 245ms, tests 172ms, environment 0ms, prepare 41ms)

EXIT=0
```

**(b) 注入后 — 红，(iv) 命中**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ❯ tests/controller/runLoop.integration.test.ts (55 tests | 1 failed | 54 skipped) 204ms
   × runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt 203ms
     → expected false to be true // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ tests/controller/runLoop.integration.test.ts:1234:52
    1232|     // surviving is the observable of the call never happening. Accept…
    1233|     // grounds as L1 §12 requirement 9: the residual worktree is the n…
    1234|     expect(await pathExists(observedWorktreePath)).toBe(true);
       |                                                    ^
    1235| 
    1236|     // The write persistBoundaryAnalysis performs AFTER runExclusive r…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 54 skipped (55)
   Start at  20:25:53
   Duration  681ms (transform 203ms, setup 0ms, collect 243ms, tests 204ms, environment 0ms, prepare 44ms)

EXIT=1
```

**(c) 还原后（生产侧与测试侧都已还原）— 绿**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

 ✓ tests/controller/runLoop.integration.test.ts (55 tests | 54 skipped) 174ms

 Test Files  1 passed (1)
      Tests  1 passed | 54 skipped (55)
   Start at  20:26:44
   Duration  706ms (transform 239ms, setup 0ms, collect 273ms, tests 174ms, environment 0ms, prepare 45ms)

EXIT=0
```

三份输出的具名计数分别是 `1 passed | 54 skipped (55)` / `1 failed | 54 skipped (55)` /
`1 passed | 54 skipped (55)` —— 没有一块是「全 skipped」。
（计数是 55 而非 §4.3 那时的 54，因为 B2 在同一文件里加了测试 8，属预期。）

**红的机制 = 声称的机制**：`expected false to be true` 说的是 `pathExists(observedWorktreePath)`
变成了 `false`——专属分支一失效，错误落进通用失败处理，`cleanupAttemptWorkspaceBestEffort`
就把那个 worktree 用 `git worktree remove --force` 删掉了。**这正是副作用 2 的观测量。**
**因此 (iv) 确实可失败**，它此前只是被 (i) 遮住而从未被看见。

**同一次跑顺带确立的 F-1 实测面**：执行流走到了 `:1234`，也就是**越过了** (ii) 的
`:1220` / `:1221` 两条——即在错误已经落进通用失败处理的情况下，(ii) **仍然通过**。
这就是 §2.2 那条 `Amended 2026-08-04` 所说的「(ii) 恒真」的直接观测。

## R2.2 本波在 B1 侧没有做的事（明写，免得被读成漏做）

- **没有改任何生产代码。** F-1 明确判为「不改代码，改说法」；F-2 只要求把击杀记进证据册；
  F-5 只是证明手段的表述更正。
- **没有为了让 (ii)「能失败」而动测试或生产代码。** 见 §2.2 的注解。
- **没有删改任何原句。** 三处都是就地新增注解（本仓库对勘误的既定立场，组 A 有四处判例、
  修复轮 1 有一处 `Amended 2026-08-04`）。
- **`stop()`、`isLeaseStopError`、外层 catch 的分支及其与 `isLeaseStopError` 分支的先后顺序
  一个字节未改**（注入已全部还原，证明见 §R2.3）。

## R2.3 本波的注入总账与还原证明

本波共两处注入（**都在本节与 `task-B2-report.md` 里逐条写明，没有第三处**）：
B1 侧 §R2.1 的两部分（生产 + 测试）、B2 侧 `task-B2-report.md` §5.4 的一处（生产）
与 §4.2.1 的一处（测试探针）。**全部带同一个标记词 `GATEB-FIX-PROBE`，扫描用的就是这个词本身**
——这正是 F-5 的教训（见 §4.3 末尾的注解）。

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "bash -c 'grep -rnF GATEB-FIX-PROBE src/ tests/; echo PROBE_GREP_EXIT=\$?; git status --porcelain'"
PROBE_GREP_EXIT=1
 M tests/controller/leaseLifecycle.integration.test.ts
```

`-F` 定值扫描零行输出、exit 1 = `src/` 与 `tests/` 无任何残留标记；
`git status --porcelain` 唯一一行是本波**有意保留**的那处断言修复（B2 的 8b(ii) 前置断言）。
`src/` 侧另有一条与标记词无关的独立证据：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "bash -c 'git diff --stat src/; echo SRC_DIFF_EXIT=\$?'"
SRC_DIFF_EXIT=0
```

零行 stat = 整个 `src/` 与 HEAD 逐字节一致。

## R2.4 本波的全套件 / typecheck / build（未过滤）

见 `task-B2-report.md` §9（本波的收尾跑对两份报告是同一次，不重复粘贴）：
**29 passed (29) 文件 / 490 passed (490) 用例 / exit 0**，typecheck 0，build 0，
**允许名单上的两条 flake 一条都没出现**（`tests/validation/evidence.test.ts` 的
`records env names only and tracks descendants rooted at the spawned pid` 与
`tests/controller/runLoop.integration.test.ts` 的
`continues normally when execute returns a complete result during the recovery window` 均为 `✓`）。
