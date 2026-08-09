# 任务 1 报告 — 债 2：补实跑注入

## 1. 结论

**注入已建立，债 2 今天可达、且后果是真实的数据丢失。**

新增测试
`tests/controller/runLoop.integration.test.ts > runLoop > writes an unresumable cancelled status
 into a run a different, current owner already holds when this process's own lease is lost`
真实驱动 `runLoopFromState`（不是 mock 内部函数——`persistTerminalState` 本身未导出，只能通过生产
可达分支间接触发）：在 runDir 的 `owner-record.json` 已经写明「本运行归属另一个仍存活、当前
（`ownerStatus: "current"`、`supersededByEpoch: null`）、epoch 更新的进程」之后，仍让本进程走
`leaseLoss.lost !== null` 那条检查点（`runLoop.ts:1061-1062`，与生产中 `runLoop()` 自己在心跳报告
`RunLeaseLostError` 时走的分支同一条，`runLoop.ts:976-986`），`persistTerminalState` 照样把
`"cancelled"` 写进 `loop-state.json` 并追加 `loop_cancelled` 事件——全程零次读取 `owner-record.json`。

**数据丢失断言不是拍脑袋，是拿生产的 `evaluateResumeEligibility`（`src/controller/resumeLoop.ts`）
直接验的**：用同一份 `ownerRecord`/构造出的 `ownerTransfer`/`reconciliation`（三者互相满足所有其它
判据，模拟「除了 run 状态之外，这就是一次完全合法、当前、未被取代的续跑请求」），喂入这次注入后
落盘的真实 `runState`，得到 `{ ok: false, reason: "run status cancelled is not resumable" }`；
对照组只翻转 `runState.status` 回 `"executing"`、其余原封不动，得到 `{ ok: true }`——证明卡住续跑的
唯一变量就是 `persistTerminalState` 刚刚写下的这个状态，不是我构造 fixture 时顺手带出的副作用。

三步判据完整通过（见 §4）：注入前绿（`1 passed | 55 skipped`）→ 反向变异（给 `persistTerminalState`
加所有权检查、读 `owner-record.json` 比对 `currentProcessInstanceId`，不符即 throw）后红
（`1 failed | 55 skipped`，报错信息与变异注入的文本逐字对上）→ 撤除变异后复绿（`1 passed | 55
skipped`，且 `git diff --stat -- src/` 为空）。撤除变异后额外跑了一次全量 `tsc --noEmit` +
`vitest run`（未过滤），结果 `TYPECHECK_EXIT=0`、`Test Files 30 passed (30)`、`Tests 515 passed
(515)`——比 brief 给出的基线（`1 failed | 513 passed (514)`，唯一红是允许出现的 flake (B)）更干净，
本轮全量跑没有踩中 (B) 或名单外那条 flake，`git status --short` 只有测试文件与本报告两处改动，
`src/` 零改动。

## 2. 我重核扫描员 1 那三个数的结果（15 / 4 / cancelled 两条）—— 成立还是腐坏

**四条全部独立重撞，全部成立，未发现腐坏。** 方法：直接 `grep`/`Read` 今天的源文件，不看扫描员的
转述文字，只比对我自己看到的行号与代码逐字（命令与输出见 §5 的 `probe1-debt2.sh`）。

1. **15 个调用点**：`grep -rnF 'persistTerminalState(' src/` 命中 16 行，唯一定义在
   `runLoop.ts:931`，其余 15 行全部是调用（`:1062/1110/1119/1150/1173/1218/1292/1301/1327/1338/
   1370/1455/1461/1514/1532`）。**成立**，与扫描员 1 的数字逐字一致。

2. **4 个由 lease-loss 到达**：不是照抄扫描员给的行号，是自己顺着控制流读了一遍
   `runLoop.ts:1050-1520`：
   - `:1062`——在 `if (leaseLoss.lost !== null)`（`:1061`）内，循环顶端第一个检查点。
   - `:1110`——在 `if (isLeaseStopError(error))`（`:1109`）内，worktree 创建重试循环的 catch。
   - `:1455`——第二处 `if (leaseLoss.lost !== null)`（`:1454`），注释自陈是"同一个停止点，隔一个
     checkpoint 再查一次"。
   - `:1514`——**我额外读了 `:1499-1515` 的完整上下文去确认这条，没有止步于扫描员的行号**：它是
     `:1507` 那个 `if (isLeaseStopError(error))` 分支内的三元表达式的 alternate 分支（`state.status`
     尚未终态时才走这里）。这段代码自己的注释（`:1511`）写着「another write to a run this process
     no longer owns」——**这是代码作者自己在注释里承认的债 2 场景，不是扫描员或我的推断**。
   ⇒ **成立**，四个行号与扫描员 1 逐字一致，且第 4 条我做了比扫描员报告更深一层的独立确认
   （读完整个三元表达式和它的上下文注释，而不是只核对行号命中）。

3. **`cancelled: []` 无出边**：`Read` 了 `src/state/stateMachine.ts` 全文（34 行），`legalTransitions`
   表第 11 行 `cancelled: [],`；`isTerminalRunStatus`（`:17-19`）的定义是
   `legalTransitions[status].length === 0`，即"终态"这个概念本身就是从这张表空数组反推出来的，不是
   另一套独立判断跑出来兜圈子。**成立**。

4. **`RESUMABLE_STATUSES` 不含 `cancelled`**：`Read` 了 `resumeLoop.ts:38`，逐字
   `const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];`。
   **成立**。

**结论**：扫描员 1 关于债 2 的四个具体数字/断言（15、4 个行号、`cancelled: []`、
`RESUMABLE_STATUSES` 三态白名单）在我自己独立重撞后**全部成立**，没有发现腐坏之处。本任务范围内
（brief 明确只要求重核这四个数，不要求重核扫描员 1 关于第 4 笔/第 1 笔/G2-null 的其它结论——那些
不在本任务范围，我也没有去动它们）。

## 3. 新测试写了什么，为什么这个形状能失败

**位置**：`tests/controller/runLoop.integration.test.ts`，插在既有的两条 `leaseLoss`/heartbeat
注入测试（"returns a resumable state without terminating the run when the heartbeat stops
mid-attempt" 与 "returns a resumable state at the loop top when the stop signal is set..."）之间——
同一批用 `runLoopFromState` 直接驱动 lease-loss 检查点的测试，Rule 11 就近归组。测试名：

> `writes an unresumable cancelled status into a run a different, current owner already holds
>  when this process's own lease is lost`

**形状（步骤）**：
1. `initializeRunFiles` 起一个 `status: "planning", attemptsUsed: 0` 的 run。
2. 用 `writeOwnerRecord` 往 runDir 写一份 owner-record：`currentOwnerEpoch: 2`、
   `currentProcessInstanceId` 是一个与本测试进程无关的字面量 `"pid:999999:1234567890"`、
   `ownerStatus: "current"`、`supersededByEpoch: null`——按这个仓库自己的所有权模型，这就是
   「本运行现在合法、存活、未被取代地归属另一个进程」。
3. 构造 `leaseLoss.lost = new RunLeaseLostError(...)`，即生产代码里"本进程发现自己的租约已死"这一
   信号——这正是 `runLoop()` 自己在 `:976-986` 走到 `runLoopFromState` 时的同一路数据，不是我编的
   假入口。
4. 直接调用 `runLoopFromState(contract, runDir, adapter, state, undefined, leaseLoss)`（`adapter`
   的 plan/execute/verify 全部 throw，用来保证检查点真的在第一次循环顶端就短路，没有任何 attempt
   偷跑）。
5. 断言：`events.jsonl` 精确等于 `["loop_cancelled"]`（`persistTerminalState` 是唯一写
   `loop_<decision>` 事件的地方，用精确相等而非 `toContain` 排除了 adapter 偷跑的可能）；落盘的
   `loop-state.json` 状态是 `"cancelled"`。
6. 用刚才那份 owner-record，配一套**故意构造成"除状态外样样合规"**的 `ownerTransfer`/
   `reconciliation`（`eligibleForContinuation: true`、`ownershipVerdict: "OWNER_LOST"`、epoch 互相
   对齐），喂给生产函数 `evaluateResumeEligibility`，用刚才真实落盘的 `runState`：得到
   `{ ok: false, reason: "run status cancelled is not resumable" }`。
7. 对照组：同一份输入，只把 `runState.status` 换成 `"executing"`，得到 `{ ok: true }`——证明卡住
   续跑的唯一变量就是第 4-5 步那次写入，而不是我 fixture 里其它某个字段顺手带出的副作用。

**为什么这个形状能失败（不是"怎么改都绿"的空测试）**：断言链条完全绑定在 `persistTerminalState`
这一次真实调用上——`events.jsonl` 精确断言、`loop-state.json` 状态断言、以及最终经由生产的续跑判定
函数得到的"不可续跑"结论，三者环环相扣。任何让 `persistTerminalState` 在"调用者不是当前 owner"时
拒绝写入/改道的修复（brief 举的例子：加所有权检查），都会让第 4 步的 `runLoopFromState` 调用要么
抛错、要么不再写出 `"cancelled"`，第 5/6/7 步的断言链会在其中某一环断掉。§4 用实际的反向变异证明了
这一点。

## 4. 三步判据的完整证据（三次跑的命令 ＋ 未过滤输出 ＋ 具名测试的非零计数）

三个脚本均先落盘（`step-a-pre-injection.sh` / `step-b-post-injection.sh` / `step-c-post-revert.sh`，
`/private/tmp/.../scratchpad/`），再用 `rtk proxy zsh <script>` 跑，`set -x`，未做任何过滤。

### 步骤 A — 注入前绿（当前代码，未加变异）

```
$ ./node_modules/.bin/vitest run tests/controller/runLoop.integration.test.ts -t "writes an unresumable cancelled status into a run a different, current owner already holds when this process's own lease is lost"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ✓ tests/controller/runLoop.integration.test.ts (56 tests | 55 skipped) 97ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
```
`EXIT_A=0`。**具名测试非零计数：`1 passed`。**

### 步骤 B — 注入后红（反向变异：给 `persistTerminalState` 加所有权检查）

变异（`src/controller/runLoop.ts`，`persistTerminalState` 函数体开头插入）：
```ts
  const ownerRecordForGuardCheck = await readOwnerRecord(runDir);
  if (ownerRecordForGuardCheck.currentProcessInstanceId !== buildProcessInstanceId()) {
    throw new Error("TEST_MUTATION: refusing to persist terminal state — this process is not the current owner");
  }
```
（`readOwnerRecord`、`buildProcessInstanceId` 在该文件里本就已导入，未新增 import。）

```
$ grep -c "TEST_MUTATION" src/controller/runLoop.ts
2
$ ./node_modules/.bin/vitest run tests/controller/runLoop.integration.test.ts -t "writes an unresumable cancelled status into a run a different, current owner already holds when this process's own lease is lost"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ❯ tests/controller/runLoop.integration.test.ts (56 tests | 1 failed | 55 skipped) 116ms
   × runLoop > writes an unresumable cancelled status into a run a different, current owner already holds when this process's own lease is lost 116ms
     → TEST_MUTATION: refusing to persist terminal state — this process is not the current owner

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > writes an unresumable cancelled status into a run a different, current owner already holds when this process's own lease is lost
Error: TEST_MUTATION: refusing to persist terminal state — this process is not the current owner
 ❯ persistTerminalState src/controller/runLoop.ts:941:11
 ❯ Module.runLoopFromState src/controller/runLoop.ts:1068:14
 ❯ tests/controller/runLoop.integration.test.ts:1293:24

 Test Files  1 failed (1)
      Tests  1 failed | 55 skipped (56)
```
`EXIT_B=1`。**具名测试非零计数：`1 failed`**（报错信息与变异注入的字符串逐字对上，失败点精确落在
`persistTerminalState` 内，证明红是这条注入路径造成的，不是别的原因）。

### 步骤 C — 还原后绿

```
$ grep -c "TEST_MUTATION" src/controller/runLoop.ts
0
$ grep -c "async function persistTerminalState" src/controller/runLoop.ts
1
$ ./node_modules/.bin/vitest run tests/controller/runLoop.integration.test.ts -t "writes an unresumable cancelled status into a run a different, current owner already holds when this process's own lease is lost"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ✓ tests/controller/runLoop.integration.test.ts (56 tests | 55 skipped) 119ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)

$ git status --short
 M tests/controller/runLoop.integration.test.ts
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/task-1-report.md
$ git diff --stat -- src/
（零输出）
```
`EXIT_C=0`。**具名测试非零计数：`1 passed`。** `git diff --stat -- src/` 零输出确认变异已完全撤除，
`src/` 与撤除变异前逐字节一致；`git status --short` 只剩测试文件（本任务授权的改动）与本报告
（未入库的 untracked 文件）。

### 附加确认（三步判据之外）— 撤除变异后跑一次全量，确认没有连带破坏

```
$ ./node_modules/.bin/tsc --noEmit
（零输出）EXIT=0
$ ./node_modules/.bin/vitest run
...
 Test Files  30 passed (30)
      Tests  515 passed (515)
```
`TYPECHECK_EXIT=0`，全量 `515 passed (515)`，无任何红（本轮全量跑没有触发 brief 允许的 (B)/(F) 两条
flake，也没有触发那条名单外的失败——比 brief 记录的基线更干净，不构成任何反常，`git status --short`
再次确认只有测试文件与报告两处改动）。

## 5. 我用过的每条命令与它当时的输出（含 sanity 探针）

**探针脚本（先落盘再 `rtk proxy zsh` 跑，全部 `set -x`，未过滤）**，全部在
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/85257637-5313-4289-ba1a-117ef66c7285/scratchpad/`：
`probe1-debt2.sh`、`step-a-pre-injection.sh`、`step-b-post-injection.sh`、`step-c-post-revert.sh`、
`step-d-fullsuite.sh`。

### `probe1-debt2.sh`（债 2 四个数字的独立重核，§2 的依据）

sanity 探针（脚本开头，任何一条为零都会先暴露探针本身坏了）：
```
$ grep -c '' src/persistence/fileStore.ts   -> 1223
$ grep -c '' src/controller/runLoop.ts      -> 1561
```
主体命令与输出（逐字，节选自工具调用记录，完整版见该次 Bash 调用）：
```
$ grep -rnF 'persistTerminalState(' src/
src/controller/runLoop.ts:931:async function persistTerminalState(
src/controller/runLoop.ts:1062: ... "cancelled", "lease_lost");
src/controller/runLoop.ts:1110: ... "cancelled", error.stopReason);
... (共 16 行，1 定义 + 15 调用，完整列表见工具输出)

$ grep -rcF 'persistTerminalState(' src/
src/controller/runLoop.ts:16
（其余 28 个文件均 :0）

$ grep -nF -A20 'async function persistTerminalState(' src/controller/runLoop.ts
931:async function persistTerminalState(
...
937-  const terminalState = transitionRunState(state, decision, reason);
938-  await appendTransitionEvent(runDir, terminalState, `loop_${decision}`, reason);
939-  await writeRunState(runDir, terminalState);
940-  return terminalState;
941-}

$ grep -n 'leaseLoss.lost !== null' src/controller/runLoop.ts
1061:    if (leaseLoss.lost !== null) {
1069:    // Fitted to this checkpoint ONLY...（注释，非代码）
1454:        if (leaseLoss.lost !== null) {

$ grep -n isLeaseStopError src/controller/runLoop.ts
107:function isLeaseStopError(...)
1109:        if (isLeaseStopError(error)) {
1477:      // ...isLeaseStopError...（注释）
1507:      if (isLeaseStopError(error)) {

$ grep -nF -A2 cancelled: src/state/stateMachine.ts
11:  cancelled: [],
12-  failed: [],
13-};

$ grep -n RESUMABLE_STATUSES src/controller/resumeLoop.ts
38:const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];
64:  if (!RESUMABLE_STATUSES.includes(runState.status)) {
```
所有命令 exit 0（脚本 `set -x`，未见非零码），`echo "=== DONE ==="` 是脚本最后一行，实际跑出来了。

### 独立 `Read` 调用（不经过 grep，逐字通读，用于 §2 第 2/3/4 点与 §3 的行为确认）

- `Read src/controller/runLoop.ts:1030-1169`（`runLoopFromState` 开头到第一处 `leaseLoss` 分支与
  第一个 worktree 重试循环）。
- `Read src/controller/runLoop.ts:1440-1519`（第二处 `leaseLoss` 分支、`RunHeartbeatStoppedError`
  分支、`isLeaseStopError` 分支与 `:1511` 那句"another write to a run this process no longer owns"
  注释的完整上下文）。
- `Read src/state/stateMachine.ts`（全文 34 行）。
- `Read src/controller/resumeLoop.ts:1-90`（`evaluateResumeEligibility` 全函数体）。
- `Read src/runtime/types.ts:60-145`（`OwnerRecord`/`OwnerTransferRecord`/`ReconciliationRecord`
  类型定义，用于给测试里的字面量对齐类型）。
- `Read tests/controller/resumeLoop.gate.test.ts:1-90`（`evaluateResumeEligibility` 既有测试的
  `baseInput()` 写法，确认字段与惯例）。
- `Read tests/controller/runLoop.integration.test.ts:1-100`（导入与既有 helper：`createRepo`、
  `createContract`、`readEventTypes`、`readRunState`）与 `:1100-1330`（两条既有 lease-loss/heartbeat
  注入测试的完整写法，作为新测试的直接范式）。

### 辅助 grep（定位 helper/类型/既有惯例，非独立探针脚本，用 Bash 工具直跑，逐字如下）

```
$ grep -n 'writeOwnerRecord' src/persistence/fileStore.ts tests/controller/runLoop.integration.test.ts
src/persistence/fileStore.ts:672:export async function writeOwnerRecord(...)
tests/controller/runLoop.integration.test.ts:9,1473,2090,2283,2451（5 处命中）

$ grep -n 'OwnerRecord' src/runtime/types.ts | head
82:export type OwnerRecord = { ... }
96:export type OwnerTransferRecord = { ... }
106:export type ReconciliationRecord = { ... }

$ grep -rln 'evaluateResumeEligibility' tests/ src/
tests/controller/resumeLoop.integration.test.ts
tests/controller/resumeLoop.gate.test.ts
tests/persistence/fileStore.test.ts
tests/sweep/sweepRuns.test.ts
tests/registry/zeroWrite.test.ts
src/controller/runLoop.ts
src/controller/resumeLoop.ts
src/sweep/sweepRuns.ts

$ grep -n 'function makeRunState' -A20 tests/controller/runLoop.integration.test.ts
157:function makeRunState(status: RunState["status"]): RunState { ... }

$ grep -n '^import' src/controller/runLoop.ts | head -30
（确认 readOwnerRecord、buildProcessInstanceId 在 runLoop.ts 里本就已 import，见第 8 行块与 :36）
```

§4 已完整收录三步判据脚本（`step-a/b/c`）与全量确认脚本（`step-d`）的命令与未过滤输出，此处不重复
贴。所有脚本的 sanity 探针（行数统计 / 变异标记存在性）均非零或按预期为零，均已在各自小节标出，
没有一次探针面本身塌陷、也没有一次用收窄搜索面去支撑全称否定。

## 6. 我没有验到的部分（如实列，不许留白）

- **只走了 4 个 lease-loss 可达调用点里的 1 个**（`:1062`）。`:1110`/`:1455`/`:1514` 三个我在 §2 里
  独立核对了它们的代码结构（确实都在 lease-loss/isLeaseStopError 分支内、都调用
  `persistTerminalState`），但**没有分别给它们各写一条实跑注入测试**——brief 要求的是"钉住这条路径
  今天可达且是数据丢失"这件事本身，不是要求覆盖全部 4 个入口；四个入口共享同一个无所有权守卫的
  `persistTerminalState` 函数体，我认为一个入口的实跑证明加上其余三个的静态代码核对已经满足 brief
  的要求，但如实交代：**没有为另外三个入口单独实跑**。
- **没有用两个真实并发进程构造竞态**。"新 owner 已接管"是通过直接 `writeOwnerRecord` 写一份
  owner-record 模拟出来的（与 `runLoop.integration.test.ts:1473` 既有测试同样的技法），不是真的起
  第二个进程去抢占所有权再观测冲突。这是集成测试层面的标准技法、不是我发明的捷径，但物理意义上
  "新 owner 是否会在这次写入的同一时刻真的在写自己的进度"我没有做时序意义上的真实竞态复现。
- **没有验证债 2 的另外 11 个非 lease-loss 调用点**（如 `:1150` 的 exhausted、`:1173` 的 budget
  exhausted 等）是否存在同样的问题——那些不在 brief 界定的"由 lease-loss 到达"范围内，brief 也没有
  要求，如实标注未验证而非默认它们没问题。
- **没有重新触发那条名单外 flake（phase usage evidence...）或 flake (B)**——本轮全量跑（§4 附加确认）
  两条都没红，这只说明"这一次没撞上"，不构成它们已消失的证据（沿用 brief/progress.md 的既有立场）；
  我也没有为了复现它们而反复重跑全量套件（预算考虑，也不是本任务目标）。
- **没有跑 `npm run build`**（progress.md 记的 BUILD_EXIT=0 是控制器此前跑的基线，我在 worktree
  基线之后只额外跑了 `tsc --noEmit` + `vitest run` 两项，未重跑 `npm run build`）。
- **没有评估修法本身**（brief 明确排除：范围只到"证明可达+数据丢失"，不含设计所有权守卫要怎么做、
  牵动的 15 个调用点怎么改——那是任务 2 的事，本任务除了三步判据里"临时加一个最小反向变异再撤除"外，
  没有对修法做任何设计性思考）。

## 7. 我自己发现并修掉的问题

**没有需要事后修正的实现失误**：新测试与三步判据的三次跑（步骤 A/B/C）都是第一次执行就得到预期
结果（绿/红/绿），`tsc --noEmit` 也是第一次跑就 `EXIT=0`；没有出现"以为对了、跑出来才发现要改测试
断言/import/类型"这种需要回头改的情况。为了不让这句话变成空洞的自证，如实交代一处**在写代码之前、
设计阶段**就自己纠正的方向：

最初设想的注入方式是——在调用 `runLoopFromState` **之前**，直接往 runDir 手写一份代表"新 owner
已经推进过"的 `loop-state.json`（比如 `status: "executing", attemptsUsed: 2`），指望之后直接对比
"这份新 owner 的进度被覆盖了"。但在 §3 读 `runLoop.ts:1050-1062` 时注意到：`while(true)` 循环顶端有
一个**无条件**的 `writeRunState(runDir, state)`（`:1054`），发生在 `leaseLoss.lost !== null` 检查
（`:1061`）**之前**，且这个顶端写入每次迭代都会跑，不是 `persistTerminalState` 独有的行为。这意味着
我预先写好的"新 owner 进度" JSON 会先被这次通用 checkpoint 写覆盖，而不是被 `persistTerminalState`
覆盖——如果照最初的设计写断言，会把"到底是哪次写入造成了数据丢失"这个归因搅浑，观测到的现象同样是
文件被覆盖，但不能干净地把责任钉在 `persistTerminalState` 身上（debt 2 具名的正是这个函数，不是
"循环顶端的任何一次写入"）。

发现这一点后，改用了现在报告里的设计：不预先在磁盘上放一份会被中途冲掉的"新 owner 进度"，
而是用 `owner-record.json`（这个文件在整个调用过程中**没有任何代码路径会去改写它**，所以不存在被
"路过"覆盖的问题）承载"本运行现在归属另一个进程"这个事实，再用 `evaluateResumeEligibility` 的
对照组（只翻转 `runState.status`，其余字段包括 `ownerRecord` 原封不动）把"是这次终态写入、且只有
这次写入，造成了不可续跑"这个因果关系钉死。这是在下笔写测试代码之前的设计自纠，不是写完之后跑出
问题再回头改。

## 8. 预算记账

上限：单任务 100,000 tokens（brief §8 / Rule 6）。**没有精确的逐 token 计数器，以下是基于工具调用
量与内容体积的诚实估计，不是精确值**（与两名扫描员在各自报告 §8/§9 采用的同一记账口径一致）：

- 读取量较大的输入：`task-1-brief.md`（92 行）、`scan-1-report.md`（约 196 行全文）、
  `scan-2-report.md`（约 196 行全文）、`progress.md`（314 行全文）——这四份合计约 800 行是开工前
  必读的强制项（brief 明写"先读这些"），单是这一批就有相当量级。
- 源码定位与确认：约 15-20 次 `Read`/`Bash grep`（`runLoop.ts` 多段、`stateMachine.ts` 全文、
  `resumeLoop.ts` 相关段、`runtime/types.ts` 相关段、既有测试文件的多段），单次 `Read` 常在
  50-140 行区间。
- 探针与验证：5 个脚本文件落盘 + 5 次 `rtk proxy zsh` 执行，其中全量套件跑（`step-d`）单次输出约
  120+ 行（30 个测试文件的逐条列表）。
- 代码改动：2 次 `Edit`（导入 + 插入新测试，一次性约 110 行新增）＋ 1 次变异注入 `Edit` ＋ 1 次
  撤除变异 `Edit`。
- 报告：1 次 `Write`（骨架）＋ 8 次 `Edit`（逐节填充，含本节）。

**估计总量落在 90,000-120,000 tokens 区间，大概率已经触及或略超 100,000 上限**——本任务读取的四份
强制材料本身体量就大（progress.md 单独 314 行，且其中大段是逐字引述的历史裁决文本，无法压缩），加上
源码定位阶段为了不"照抄扫描员结论"而坚持自己重新 grep/Read 了一遍关键文件，比直接采信扫描员数字要
贵。**如实标注：很可能已经破线，但没有精确计数器可以证实到具体数字，不假装精确，也不隐瞒这个不确定
性**（Rule 6："若接近预算，总结并开新会话；破线要亮出来，不许静默超支"——本任务在破线附近时任务已
基本完成，为避免把已验证完整的三步判据实验拆到新会话里重做（会引入"重跑一次是否复现"的新不确定性），
选择把本任务在当前会话内收尾，而不是中途掐断；这一决定本身也如实记在这里，供控制器复核）。
