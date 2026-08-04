# Task B1 — 具名可达性核验报告（独立核验员，只读）

**核验对象**：GATE-A ledger open 项 4 —— B1 的新分支是否构成「a SECOND, NON-TERMINAL
ROUTE TO `persistBoundaryAnalysis`」，从而使人裁
「*** PRESERVING IS PERMITTING. The predicate must not change. ***」重新打开。

**树**：`/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop`

```bash
cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop && rtk proxy "git rev-parse HEAD"
a7c26c9c9e7ec2a8ff8bc5e10f516ee80e8ebada
```

**只读证明**（核验结束时，worktree 与主仓库都干净，两条命令均无输出、exit 0）：

```bash
cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop && rtk proxy "git status --porcelain" ; echo "---exit:$?"
---exit:0
cd /Users/biran/code/skills/loop/ccloop && rtk proxy "git status --porcelain"; echo "---main-exit:$?"
---main-exit:0
```

本轮唯一写入的仓库内文件是本报告本身。探针脚本落在
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/746b61e7-a2cb-4a5b-a7e3-9df0f5120cae/scratchpad/`
下（`probe-b1.mts` / `probe-b1-sites.mts`），**未向 `src/` 或 `tests/` 加过任何文件**。

---

## 环节 1 — `runExclusive` 的生产调用点

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'runExclusive(' src/"
src/controller/runLoop.ts:786:  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
```

只有 1 行。为了排除「用别的写法调用」的可能，再扫一次不带括号的：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'runExclusive' src/"
src/controller/runLoop.ts:786:  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
src/controller/runLoop.ts:993:// Task 3: exported so tests can pin `runExclusive` directly. A no-op here would silently
src/controller/runLoop.ts:1000:  runExclusive: (fn) => fn(),
src/controller/leaseHeartbeat.ts:23:  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
src/controller/leaseHeartbeat.ts:196:  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
src/controller/leaseHeartbeat.ts:308:  return { adopt, affirmNow, assertHeld, runExclusive, stop };
```

分类（**生产调用点 = 1 个**）：

| 行 | 分类 | 依据 |
|---|---|---|
| `runLoop.ts:786` | **生产调用点（唯一）** | `await heartbeat.runExclusive(async () => {...})`，在 `persistBoundaryAnalysis` 函数体内（函数起于 724，止于 929） |
| `runLoop.ts:1000` | **桩** | `INERT_LEASE_HEARTBEAT`（声明在 996 行 `export const INERT_LEASE_HEARTBEAT: LeaseHeartbeat = {`），`runExclusive: (fn) => fn()` |
| `leaseHeartbeat.ts:23` | 类型声明 | `LeaseHeartbeat` 接口成员 |
| `leaseHeartbeat.ts:196 / 308` | 定义与导出 | 实现本体与返回对象 |
| `runLoop.ts:993` | 注释 | — |

测试侧（不构成生产调用点，且计划的陷阱清单点名不许改）：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'runExclusive' tests/"
（32 行，全部在 tests/controller/leaseHeartbeat.test.ts 与
 tests/controller/leaseLifecycle.integration.test.ts 内；其中三处替身桩：
 tests/controller/leaseLifecycle.integration.test.ts:1189:      runExclusive: (fn) => fn(),
 tests/controller/leaseLifecycle.integration.test.ts:1331:      runExclusive: (fn) => fn(),
 tests/controller/leaseLifecycle.integration.test.ts:1407:      runExclusive: (fn) => fn(),）
```

**判读**：计划「`runExclusive` 只有一个生产调用点，在 `persistBoundaryAnalysis` 内」的说法在
`a7c26c9` 上原样成立。B1 的新抛出只能从 `runLoop.ts:786` 这一个位置进入生产路径。

---

## 环节 2 — `runExclusive` 与破坏性写在 `persistBoundaryAnalysis` 内的先后

`persistBoundaryAnalysis` 定义于 `src/controller/runLoop.ts:724`，结束于 `929`。函数体内的关键序列，逐字引用：

- **744**：`  await heartbeat.assertHeld();`  ← 入口守卫（第 1 个 `assertHeld`）
- **755–757**：
  ```ts
  if (boundaryAnalysis.status === "healthy") {
    return;
  }
  ```
  ← **唯一的提前返回**，在 `runExclusive` **之前**
- **786–787**：
  ```ts
  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
    async () => {
  ```
- **865**：`          await heartbeat.assertHeld();` ← 第 2 个 `assertHeld`，在 `runExclusive` 的 **fn 内部**、CAS 失败/锁忙的 catch 里
- **873**：`  );` ← `runExclusive` 调用结束
- **891**：`  await heartbeat.assertHeld();` ← 第 3 个 `assertHeld`，在写之前
- **899–928**：破坏性写，两条分支各一次：
  ```ts
  if (nextOwnerEpoch !== null) {
    await writeBoundaryArtifacts(runDir, { boundaryAnalysis }, { onReconciliationWriteAbandoned });
  } else {
    await writeBoundaryArtifacts(runDir, {
      boundaryAnalysis,
      reconciliationRecord: ... ,
    }, { onReconciliationWriteAbandoned });
  }
  ```

**同一 try/catch？** 否 —— 函数体内**没有任何 try/catch 包住 `runExclusive` 调用**。
函数体范围（724–929）内的 try/catch 只有一处，在 795（`try {`）/ 839（`} catch (error) {`），
它整个位于 `runExclusive` 的 **fn 内部**（786–872），且它的 catch 会把非
`OwnerTransferLockBusyError`、非 `OwnerTransferPreconditionError` 的错误 **原样 `throw error;`**（851 行）。

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -nE 'try \{|\} catch' src/controller/runLoop.ts"
（724–929 区间内仅命中 795 与 839 两行）
```

**中间提前返回？** `runExclusive`（786）与写（903/905）之间只有一条语句：891 的 `assertHeld()`。
没有 `return`、没有 `if` 早退。

**顺序结论**：`heartbeat.runExclusive(...)` **严格早于** `writeBoundaryArtifacts(...)`，
且二者之间没有 catch 能拦住从 `runExclusive` 抛出的错误。因此
**从 `runExclusive` 抛出的任何错误都在破坏性写之前逃出 `persistBoundaryAnalysis`**。
（此结论在环节 4 用运行探针实测复现，不只靠读代码。）

### 硬约束第 2 条的子情形：如果有人让 `assertHeld` 也抛这个新错误

`assertHeld` 今天**不读 `stopped`**，实测：

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -nF 'stopped' src/controller/leaseHeartbeat.ts"
38:  let stopped = false;
78:  // `stopped || superseded` entry check is still awaiting its CAS write. That runAffirm then
138:    if (stopped || superseded) {
193:  // Takes no position on `stopped` or `superseded` — it only serializes. Refusal is Task 5's
217:    if (stopped) {
221:    stopped = true;
278:        // stopped for a lease reason with nothing on disk naming who took it over.
296:    // leaves no trace is indistinguishable from a run that simply stopped, and on the
```

`assertHeld` 的函数体是 252–306 行。命中的行里落在这个区间的只有 278 与 296，**两行都在注释块内**
（278 在 `concludeSupersededOnce` 上方的说明段，296 在 `lease_unverifiable` 前的说明段）。
`stopped` 的两处**语句**用法在 138（`runAffirm`）与 217/221（`stop`）。所以计划那句
「`assertHeld` 从不读 `stopped`」为真。

若违反硬约束第 2 条，让 `assertHeld` 也抛 `RunHeartbeatStoppedError`，链条会变成三条，
**而且其中两条落在破坏性写之前，一条落在完全不同的 catch 里**：

1. **`persistBoundaryAnalysis:744`（入口守卫）抛** → 逃出函数 → 落进 `runLoopFromState` 的
   **外层 catch（1434）** → B1 之后被新分支接走 → 返回非终态。**破坏性写没发生**（在它之前）。
2. **`persistBoundaryAnalysis:891` 抛** → 同上，同样**在写之前**。
3. **`runLoopFromState:1062` 的 `assertHeld`**（`createAttemptWorkspace` 重试循环内，行 1058–1091）抛
   → 落进**内层 catch（1064）** → `isLeaseStopError(error)` 不匹配（新类不是那两个的子类）→
   跳过 1069–1071 的 return → 走到 1073 `if (infraRetryUsed)`：第一次置位重试，**第二次直接**
   ```ts
   state = await persistTerminalState(runDir, state, "blocked_waiting_human", `workspace unavailable: ${String(error)}`);
   ```
   `blocked_waiting_human` 不在 `RESUMABLE_STATUSES` 内
   （`src/controller/resumeLoop.ts:37`：`const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];`），
   run 被永久终结。

**这三条的补充判读（与计划的表述有一处需要澄清，特此点名）**：计划说违反第 2 条会「从第三扇门原样回来」，
这对**第 3 条链条**成立；但对第 1、2 条链条（`persistBoundaryAnalysis` 内的两个 `assertHeld`）**不成立**——
它们落在外层 catch，B1 之后会被新分支接走，反而不终结。也就是说，**硬约束第 2 条守的是
`runLoopFromState:1062` 那一个 `assertHeld` 调用点，不是全部 `assertHeld` 调用点**。
这不改变本轮裁定（三条链条**没有一条**落在破坏性写之后），但它是计划文字里一个会误导下一个人的简化。

---

## 环节 3 — `persistBoundaryAnalysis` 的两个调用点，逐个验

```bash
cd .../l3-debt3-heartbeat-stop && rtk proxy "grep -rnF 'persistBoundaryAnalysis' src/"
src/runtime/types.ts:118:// Task A4 / §4.3: what `persistBoundaryAnalysis` can assemble BEFORE the epoch rule runs.
src/controller/runLoop.ts:724:async function persistBoundaryAnalysis(
src/controller/runLoop.ts:1177:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
src/controller/runLoop.ts:1231:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
src/persistence/fileStore.ts:290:// through persistBoundaryAnalysis, and reaches runLoopFromState's outer catch — where
src/persistence/fileStore.ts:471://      writeBoundaryArtifacts, through persistBoundaryAnalysis, into runLoopFromState's outer
src/persistence/fileStore.ts:472://      catch — where
src/persistence/fileStore.ts:522:// removed) would propagate out of writeBoundaryArtifacts, through persistBoundaryAnalysis,
```

生产调用点两个：**1177** 与 **1231**。两个都位于 `runLoopFromState` 的 attempt 主体 `try {`（**1097**）内，
其 catch 在 **1434**（即计划所称的「外层 catch」）；中间嵌套的 1395/1397 那对 try/catch 与它们无关。

### 调用点 A —— `runLoop.ts:1177`（execute 超时且无结果）

紧接其后的语句，逐字（1178–1183）：

```ts
          state = await persistTerminalState(
            runDir,
            state,
            "exhausted",
            hasBudgetExceeded(state) ? BUDGET_EXHAUSTED_REASON : getPhaseTimeoutReason("execute", executeTimeoutMs),
          );
```

**下一条语句就是 `persistTerminalState`** —— 这正是 ledger 里那个「界」的原文所指
（"on the only route that reaches the write, persistTerminalState runs in the very next statement"）。

- 异常从 `persistBoundaryAnalysis` 逃出 → 落进 **1434** 的外层 catch。
- **B1 之前**：`isLeaseStopError(error)`（1443）对新错误不匹配 → 落到通用失败处理（1453–1494）：
  `transitionRunState(state, "failed", ...)` + `writeRunState` + worktree 清理 + `return state`。
  **不走 `persistTerminalState`**。（实测见环节 4 ARM 2：`status = failed`。）
- **B1 之后**：新分支排在 `isLeaseStopError` 分支之前，`error instanceof RunHeartbeatStoppedError` 命中 →
  追加 `heartbeat_stopped` 事件 → `writeRunState(runDir, state)` → 返回**非终态** `state`
  （此处 `state.status` 是 1144 行 `transitionRunState(state, "executing")` 之后的 `"executing"`，
  在 `RESUMABLE_STATUSES` 内）。

### 调用点 B —— `runLoop.ts:1231`（execute 返回 null 但未超时）

紧接其后的语句，逐字（1232）：

```ts
        throw new Error("execute phase completed without a result");
```

**不是终态写。** 也就是说：**「进入过 `persistBoundaryAnalysis` 而其后不立刻走终态写」这条路由，
在 `a7c26c9` 上今天就已经存在**，B1 不是第一条。这条今天的路由的落点：

- 异常（无论是 1232 自己抛的，还是从 `persistBoundaryAnalysis` 逃出的）落进同一个 **1434** 外层 catch。
- **B1 之前**：`isLeaseStopError` 不匹配 → 通用失败处理 → `failed`。（实测见环节 4 ARM 3。）
- **B1 之后**：若逃出的是 `RunHeartbeatStoppedError` → 新分支接走 → 返回非终态 `state`。
  （实测见环节 4 ARM 4：写点未被触及。）

**两个调用点的关键差别（这一条决定了 ledger 的「界」的主语）**：调用点 B 传的
`executionRecovery` 是 `undefined`，`buildBoundaryEvidence(null)` 返回空 `continuitySuspicion`，
`evaluateRunBoundary` 因此给出 `no_progress` 而非 `stale_candidate`，
`reconciliationRecord` 传下去是 `undefined` —— **这条路由到不了 reconciliation 的覆盖写**。
`runLoop.ts:1209–1225` 的注释这样声称，本轮**独立实测复现**（环节 4 ARM 3：
`boundary status: "no_progress"`，winner 记录逐字节不变）。所以 ledger 那句
「**the only route that reaches the write**」指的是调用点 A，且这个说法在今天仍然正确。

---

## 环节 4 — 危害面比对（运行探针，四臂）

探针**不改仓库任何文件**：`runLoopFromState` 的 `heartbeat` 是**形参**，所以「B1 落地后的行为」可以
通过传入一个 `runExclusive` 拒绝的 heartbeat 来忠实模拟，无需 mock、无需改源码。
探针脚本：`.../scratchpad/probe-b1-sites.mts`（由 `probe-b1.mts` 派生，增加 site-1231 两臂）。

复现命令与**未过滤**输出：

```bash
ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy "npx tsx /private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/746b61e7-a2cb-4a5b-a7e3-9df0f5120cae/scratchpad/probe-b1-sites.mts"
=== ARM 1 today (INERT heartbeat, no B1) ===
  threw out of runLoopFromState: no
  returned state.status:         exhausted
  loop-state.json status:        exhausted
  boundary-analysis.json exists: true   <- writeBoundaryArtifacts ran iff true
  boundary status:               "stale_candidate"
  reconciliation-record.json === winner sentinel: false
  reconciliation staleSuspicionBasis now: ["interrupted execute exhausted without changed paths or continuity evidence"]
  runDir: /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-probe-run-6e1iP7
=== ARM 2 B1 simulated (runExclusive refuses) @site1177 ===
  threw out of runLoopFromState: no
  returned state.status:         failed
  loop-state.json status:        failed
  boundary-analysis.json exists: false   <- writeBoundaryArtifacts ran iff true
  reconciliation-record.json === winner sentinel: true
  reconciliation staleSuspicionBasis now: ["WINNER-SENTINEL"]
  runDir: /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-probe-run-kUXGvW
=== ARM 3 today @site1231 (execute returns null, no timeout) ===
  threw out of runLoopFromState: no
  returned state.status:         failed
  loop-state.json status:        failed
  boundary-analysis.json exists: true   <- writeBoundaryArtifacts ran iff true
  boundary status:               "no_progress"
  reconciliation-record.json === winner sentinel: true
  reconciliation staleSuspicionBasis now: ["WINNER-SENTINEL"]
  runDir: /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-probe-run-9JdcZA
=== ARM 4 B1 simulated @site1231 ===
  threw out of runLoopFromState: no
  returned state.status:         failed
  loop-state.json status:        failed
  boundary-analysis.json exists: false   <- writeBoundaryArtifacts ran iff true
  reconciliation-record.json === winner sentinel: true
  reconciliation staleSuspicionBasis now: ["WINNER-SENTINEL"]
  runDir: /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-probe-run-vOsBwk
```

探针的构造要点（供复算）：run 目录预置一份「赢家已发布」的 `reconciliation-record.json`
（`staleSuspicionBasis: ["WINNER-SENTINEL"]`），owner record 的 `ownerStatus` 为 `"lost"`；
ARM 1/2 让 adapter 在 abort 前挂起并返回 `null`（走 execute 超时无结果 → 调用点 A），
ARM 3/4 让 adapter 立刻返回 `null`（走调用点 B）。
`boundary-analysis.json` 只由 `writeBoundaryArtifacts` 写，因此「它是否存在」是
「破坏性写点是否被到达过」的判定观测量。

**ARM 1 独立复现了 ledger 的那个「界」**：winner 的已发布记录被**销毁**
（sentinel 被 `["interrupted execute exhausted without changed paths or continuity evidence"]` 覆盖），
同一次调用里下一条语句就把 run 写成 `exhausted`（终态）。

### 危害面对照表

| 时序 / 读法 | 盘上 reconciliation record | run 停在的 status | 下次 sweep 是否续跑 |
|---|---|---|---|
| **今天（无 B1），调用点 A** | **被销毁**（ARM 1 实测，sentinel 丢失） | `exhausted`（终态） | 否 |
| **今天（无 B1），调用点 B** | 未被触及（ARM 3 实测） | `failed` | 否（`failed` ∉ `RESUMABLE_STATUSES`） |
| **B1 之后，(A) 读法所需的情形**：写已发生、之后才逃出 | 需要「写之后还有一次 `runExclusive`」——**代码里不存在**（环节 1、2） | — | — |
| **B1 之后，实际情形，调用点 A** | **完好**（ARM 2 实测，sentinel 逐字节不变；`boundary-analysis.json` 根本不存在 → 写点未被到达） | B1 落地后 = `executing`（∈ `RESUMABLE_STATUSES`）；模拟臂在 B1 分支未落地时落到 `failed` | **是**（B1 落地后） |
| **B1 之后，调用点 B** | 完好（ARM 4 实测） | 同上 | 同上 |

### 容易被忽略的中间时序：心跳在 `runExclusive` 返回之后、`writeBoundaryArtifacts` 之前才停

这条时序下 **B1 之后与今天完全相同**，理由链：

1. `runExclusive` 已经返回，B1 的拒绝在这次调用里已经错过（B1 只在 `runExclusive` 上加拒绝）。
2. 二者之间唯一的语句是 891 的 `assertHeld()`，而 `assertHeld` **不读 `stopped`**（环节 2 的 grep 实证），
   B1 的硬约束第 2 条又明令它不得抛新错误。
3. 因此 `writeBoundaryArtifacts` 照常执行 → 若命中破坏性覆盖，winner 记录被销毁；
   随后 1178 的 `persistTerminalState` 照常执行 → run 终结为 `exhausted`。

**即：这条时序上的危害与今天逐字相同，B1 既没有扩大也没有缩小它。**
它落在 ledger 那个「界」的内部（写之后紧跟终态写），**不构成界被突破**。

（`heartbeat.stop()` 本身会尝试 `releaseOwnerLease`，那可能让**之后**的 `assertHeld` 抛
`RunLeaseLostError` / `RunLeaseUnverifiableError` —— 但那是今天就有的行为，走的是
`isLeaseStopError` 老分支写 `cancelled`，B1 一个字节都没碰它。）

---

## 环节 5 — 反证尝试

**找了五条，四条被排除，一条留下并升格为「最脆弱前提」。**

1. **「有没有别的方式让 `RunHeartbeatStoppedError` 在破坏性写之后逃出
   `persistBoundaryAnalysis`？」** —— 需要在 `writeBoundaryArtifacts`（903/905）之后还有一次
   `runExclusive` 或一次会抛新错误的调用。函数体 899–929 之后直接结束（929 是函数右括号），
   `runExclusive` 全仓只有 786 一处（环节 1）。**排除。**

2. **`writeBoundaryArtifacts` 内部会不会自己调 `runExclusive`？** 不会——
   `grep -rnF 'runExclusive' src/` 的 6 行里没有一行在 `src/persistence/fileStore.ts`。**排除。**

3. **B2 会不会引入第二条通往 `persistBoundaryAnalysis` 的路由？** 计划第 1303–1384 行：
   B2 只在 `while (true)` 顶端**已有的** `leaseLoss.lost !== null` 检查点旁边加一个槽，命中则
   `appendEvent("stop_requested")` + 返回当前非终态 `state`，**不进入 attempt 主体**，
   因此根本到不了 1177/1231。计划还明写「有没有新增 `persistTerminalState` 调用点（必须为零）」。
   **排除**（前提：B2 按计划写在 1049 那处而非 attempt 内部那处；计划 Step 10 已把这条列为评审项）。

4. **「B1 让 run 保持可续跑，是不是等于让它将来再走一次调用点 A、把 winner 记录销毁掉？」**
   —— 会。B1 之后这个 run 下次 sweep 会被重新续跑，可能再次走到 1177 并销毁记录。
   但**那一次仍然是被界住的那一次**（写之后下一条语句就是 `persistTerminalState`，ARM 1 实测）。
   B1 改变的是「这条危害发生的次数分布」，不是「危害的形状」。open 项 4 说的是界**消失**，
   不是界被触发的频次变化。**不足以构成重开**，但值得记录：**它确实提高了 ARM 1 那条危害被撞上的概率**，
   而 ARM 1 那条危害正是 open 项 1 仍然挂着的那条。

5. **【未被排除，升格为最脆弱前提】B1 的 `stopped` 检查若被放在 `fn` 结算之后。**
   `runExclusive` 今天的形状是 `const result = queue.then(fn, fn);`（196–203 行）。
   计划只说「`stopped` 为真时抛出」，**没有逐字指定检查点的位置**。若实施者把检查写成
   「`fn` 跑完之后再看 `stopped`」，那么在 `runExclusive` 的 `fn` **内部**、795–838 那段里，
   `persistOwnerTransfer`（819）**已经把 reconciliation-record.json 事务性发布了**
   （`runLoop.ts:893–898` 的注释逐字说明这一点），之后错误才逃出 →
   B1 的新分支接走 → **不终结**。这才是 open 项 4 描述的那个形状：
   一次已经落盘的 reconciliation 写 + 一条不终结的返回路径。
   **本裁定成立，依赖于「检查在 `fn` 之前」这个尚未写下的实现细节。**
   计划的 Step 10 评审项里**没有**这一条，测试 7 也不区分这两种实现
   （`stop()` 之后再调 `runExclusive`，两种实现都会红/绿一致）。**建议把它加成一条显式评审项。**

---

## 裁定建议

**(B) 不构成重开。**

**核心理由（一句）**：B1 的拒绝发生在 `runLoop.ts:786`，而破坏性写在 `903/905`，二者之间没有 catch、
没有提前返回、也没有第二次 `runExclusive`，所以这条新路由上「winner 的已发布 reconciliation record
被销毁 + 错误的拒绝理由」这件事**根本没有发生**（ARM 2/ARM 4 实测：`boundary-analysis.json` 不存在、
winner sentinel 逐字节不变）——界所约束的那个事件没发生，不是界被突破。

**这个裁定依赖的最脆弱的那个前提（必须写）**：
**B1 的 `stopped` 检查被放在 `runExclusive` 的 `fn` 执行之前。**
计划只写了「`stopped` 为真时抛出 `RunHeartbeatStoppedError`」，没有逐字钉住检查点的位置；
若它被写成 `fn` 结算之后再判，那么 `fn` 内 819 行的 `persistOwnerTransfer` 已经事务性发布过
reconciliation-record.json，错误才逃出并被新分支接走成非终态 —— 那就是 open 项 4 所说的形状，
裁定应翻为 (A)。现有的测试 7 与 Step 10 评审项**都不区分这两种实现**。

**次弱的两个前提（一并记录，不算最弱）**：
(i) B2 的槽按计划装在 `while (true)` 顶端而非 attempt 内部；
(ii) 硬约束第 2 条被遵守 —— 但注意环节 2 的澄清：它实际守的是 `runLoopFromState:1062`
那一个 `assertHeld` 调用点，`persistBoundaryAnalysis` 内的两个 `assertHeld` 即使抛新错误
也仍然落在破坏性写之前，计划的表述在这一点上过度概括了。

**我可能错在哪（自陈）**：
- 我把 open 项 4 的「NON-TERMINAL ROUTE TO `persistBoundaryAnalysis`」读成「到达那次**破坏性写**、
  且其后不终结的路由」，而非字面的「到达那个**函数**、且其后不终结的路由」。
  取字面读法则 B1 立刻构成重开。我选前者的依据是两条：ledger 的界原文自己写的是
  "on the only route that reaches **the write**"；以及**字面读法下的这类路由今天就已存在**
  （调用点 B，1231→1232 `throw`，ARM 3 实测），若字面读法成立，那条人裁在 `a7c26c9` 上就已经该重开了。
  **这是一次解释，不是一次实测——如果人裁的作者本意是字面读法，我的裁定就是错的。**
- 我的探针用「传入一个拒绝的 heartbeat」模拟 B1，而不是真的落地 B1 再跑。它忠实复现了
  「错误从 `runExclusive` 逃出」这一环，但**不能**检验 B1 的新 catch 分支本身写得对不对
  （那要等 B1 落地后由测试 7b 钉）。ARM 2/4 里 `status = failed` 正是「新分支尚未存在」的表现。
- 探针没有覆盖 `nextOwnerEpoch !== null` 那条转移成功的分支（ARM 1 走的是 `else` 分支）。
  对本裁定无影响（两条分支都在 786 之后），但若有人要用本报告论证别的事，这是一个空白格。
