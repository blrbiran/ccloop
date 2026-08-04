# Task B1 — 两条 Important 的前提独立核验

核验员：独立核验员（不修复、不改进，只取证）
工作树：`/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop`
分支：`feat/l3-debt3-heartbeat-stop`，HEAD = `dab1040e307efc130f2759d9c225d4daa68f4bf8`
环境：`ECC_GATEGUARD=off DISABLE_OMC=1`，所有命令走 `rtk proxy "<单条命令>"`

**结论速览**

| | 评审员的前提 | 核验结果 |
|---|---|---|
| I-1 | 「谓词那一半今天没有任何可失败的测试守着」 | **成立**（单点注入全绿，实测） |
| I-1 附加 | 「是否存在能杀掉纯谓词加宽的行为测试」 | **机械上存在，但其前提被硬约束二禁止；在生产的抛出点下不存在** |
| I-2 (1) | 「姊妹分支带守卫，新分支无守卫」的类比 | **不成立**（措辞误导：姊妹分支的守卫守的是*终态*，不是所有权；非终态时姊妹分支写得**更多**） |
| I-2 (2) | 「新分支的 writeRunState 今天可达吗」 | **今天不可达**（两个 `stop()` 都在 `await runLoopFromState(...)` 之后的 `finally` 里） |
| I-2 (4) | 「加守卫是否与计划文本冲突」 | **看守卫的形状**：所有权守卫**冲突**；照抄姊妹分支的终态守卫**不冲突但今天恒为死代码** |

---

## 基线

未注入任何变异时（HEAD = dab1040，`git status --porcelain` 空）：

```
 Test Files  29 passed (29)
      Tests  487 passed (487)
   Duration  16.95s
```

（本报告三次全套件运行——基线、注入后、还原后——均为 29 files / 487 tests 全绿，
无 skipped，无名单内 flake 触发。）

---

## 前提 1（I-1）：谓词那一半今天无测试守着 —— **成立**

### 1.1 单点注入

唯一改动，`src/controller/runLoop.ts`，**不动新分支、不动测试、不动任何其它文件**：

```diff
 function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
-  return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError;
+  // MUTATION: single-point widening of the predicate, nothing else changed.
+  return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError
+    || error instanceof RunHeartbeatStoppedError;
 }
```

`npm run typecheck`：

```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

（无输出 = 通过。谓词的返回类型 `error is RunLeaseLostError | RunLeaseUnverifiableError`
一字未改，故 1467 行分支里的 `error.stopReason` 仍然编译；TS 不校验谓词体是否比
所声明的类型更宽。）

`npm test`（注入状态）：

```
 Test Files  29 passed (29)
      Tests  487 passed (487)
   Duration  17.15s
```

**全绿。评审员的前提 1 成立**：把新错误直接加进 `isLeaseStopError` 的判定体、其它一律不动，
是**行为惰性**的——因为专属分支（runLoop.ts:1449）排在 `isLeaseStopError` 分支（runLoop.ts:1467）
之前并 `return`，错误在到达谓词之前就被接走了。

### 1.2 评审员关于「变异二」的进一步主张 —— 同样成立

计划 Step 7 的变异二（brief 第 236 行）写的是「把 `RunHeartbeatStoppedError` 加进
`isLeaseStopError` → 7b 的 (i) 与 (iii) 必红」。实施者若按字面执行**同时**删掉专属分支
（否则不可能红），那次红**完全由「专属分支失效」这一半解释**。上面的单点注入把两半分开，
证明谓词这一半单独变异时**零测试可失败**。

### 1.3 附加问题：是否存在能杀掉「纯谓词加宽」的行为测试？

`isLeaseStopError` 只有两个调用点：

- `runLoop.ts:1467` —— `runLoopFromState` **外层** catch。专属分支在其前并 return，
  故 `RunHeartbeatStoppedError` **永远到不了**这里。按构造不可观测。
- `runLoop.ts:1069` —— 工作区创建重试循环的**内层** catch。它包住
  `await heartbeat.assertHeld()` 与 `createAttemptWorkspace(...)`，且**不在** 1097 行那个大 try 里
  （`while(true) { … while(!worktreePath){try/catch} … try{…}catch{…} }`），所以外层 catch 不覆盖它。

于是问题变成：`RunHeartbeatStoppedError` 能否从内层 catch 逃出？

**实测（临时探针，已删除）**：给 `runLoopFromState` 传一个 `assertHeld` 抛
`RunHeartbeatStoppedError` 的心跳替身（`runExclusive: (fn) => fn()`，其余 no-op）：

```
# 谓词未加宽（基线）
PROBE-RESULT status=blocked_waiting_human stopReason=workspace unavailable: RunHeartbeatStoppedError: run heartbeat has stopped: PROBE injection at assertHeld events=["workspace_retry","workspace_create_failed","loop_blocked_waiting_human"]

# 谓词加宽（单点变异）
PROBE-RESULT status=cancelled stopReason=heartbeat_stopped events=["loop_cancelled"]
```

**答案（分两层，请勿混读）：**

**(a) 机械上：存在。** 一条不导出谓词、不改分支排序的行为测试确实能杀掉纯加宽——
入口 `runLoopFromState`，注入点是心跳替身的 `assertHeld`，断言
`finalState.status === "blocked_waiting_human"` 且 `stopReason` 以 `workspace unavailable:` 开头
（或断言事件序列 `["workspace_retry","workspace_create_failed","loop_blocked_waiting_human"]`）。
加宽后这三项全部改变，测试必红。

**(b) 但它不是一条合法的守卫，因为它的前提正是硬约束二明令禁止的那件事。**
brief 第 181–183 行把「它只从 `runExclusive` 抛出，绝不从 `assertHeld` 抛出」定为硬约束的第二半，
并且**逐字预言了上面基线那一行输出**（「落进内层 catch → `isLeaseStopError` 不匹配 → 跳过 return →
落到 `infraRetryUsed` 分支 → 第二次直接 `persistTerminalState(runDir, state, "blocked_waiting_human", …)`」）。
`blocked_waiting_human` 与 `cancelled` **两者都不在 `RESUMABLE_STATUSES`（`["planning","executing","verifying"]`）内**，
即两个结局都是本任务要防的永久终结。所以这条测试断言的是「第三扇门」的输出，
它把一个病态结局钉成期望值，而不是守住「谓词不许匹配」。

**(c) 在生产的实际抛出点下：不存在。** `RunHeartbeatStoppedError` 今天只从
`leaseHeartbeat.ts:212`（`runExclusive` 内）抛出；`runExclusive` 唯一生产调用点在
`persistBoundaryAnalysis`（runLoop.ts:786），而 `persistBoundaryAnalysis` 的两个调用点
（runLoop.ts:1177、1231）都在 1097 行那个大 try 内 → 只能落进外层 catch → 专属分支先接走。
`assertHeld` **从不读 `stopped`**（读的是持久 owner record，只抛 `RunLeaseLostError` /
`RunLeaseUnverifiableError`），故内层 catch 在生产里永远见不到这个错误。

**因此这是「计划的判据前提为假」，不是实施缺陷。** 计划 Step 7 变异二的判据
（「加进 `isLeaseStopError` → 7b 的 (i)(iii) 必红」）在方案 (a) 的分支排序下**本身就不成立**——
排在前面的专属分支使谓词在这条路径上不可达。实施者已在两处注释里如实记录了这一点，
措辞与本核验的结论一致：

- `tests/controller/leaseHeartbeat.test.ts:741-747`：「asserted directly on the classes rather than
  through `isLeaseStopError` because that predicate is module-private to runLoop.ts and
  **no test can observe it**」
- `tests/controller/runLoop.integration.test.ts:1176-1180`：替身注释已点名
  「from inside the workspace retry loop it would miss `isLeaseStopError`, fall through to the
  infra-retry escalation and terminate the run as `blocked_waiting_human`」

现有的替代守卫是 `leaseHeartbeat.test.ts:749` 的 sibling/非子类断言——它守的是硬约束**第一半**
（子类化路线），**不**守直接加宽路线。这个缺口是真实的，但它是方案 (a) 的结构后果，
不是实施者漏做了什么。

---

## 前提 2（I-2）：新分支的 `writeRunState` 无条件执行

### 2.1 姊妹分支到底长什么样 —— **评审员的类比不成立**

`runLoopFromState` 外层 catch 里 `isLeaseStopError` 那条分支的**完整逐字原文**
（`src/controller/runLoop.ts:1459-1475`）：

```ts
      // §8.1: the side effect was skipped and the attempt is abandoned IN PLACE. No further
      // side effect of this attempt is attempted, including its worktree cleanup — cleanup
      // is itself a side effect on a worktree the new owner may already be reading, and
      // this process has just lost the authority to touch it. The residual worktree is left
      // for the new owner, whose resume path already cleans up residual worktrees. This
      // returns before the generic failure handling below on purpose: a refused lease is not
      // an attempt failure, so it must not be fingerprinted, boundary-analysed or
      // transitioned to "failed".
      if (isLeaseStopError(error)) {
        // A guard that fired after this attempt had already persisted a terminal decision
        // blocked only the cleanup that follows it: the run has already stopped, and
        // re-deciding it as "cancelled" would be an illegal transition out of a terminal
        // status as well as another write to a run this process no longer owns.
        return isTerminalRunStatus(state.status)
          ? state
          : await persistTerminalState(runDir, state, "cancelled", error.stopReason);
      }
```

**这个守卫守的是终态，不是所有权。** 条件是 `isTerminalRunStatus(state.status)`——
即「这个 attempt 早先已经写过一次终态」。它跳过写盘的**唯一**情形是「已经终结过」，
其目的是（注释自陈）避免一次**非法的终态间转移**。注释末句确实附带提到
「as well as another write to a run this process no longer owns」，但那是这次跳过的**附带好处**，
不是触发条件——租约已丢这件事**不**在条件里。

关键推论，评审员的措辞掩盖了它：**在非终态情形下（即真正与新分支可比的情形），
姊妹分支照写不误，而且写得更多**——`persistTerminalState` 会
`appendTransitionEvent(runDir, terminalState, "loop_cancelled", reason)` **加**
`writeRunState(runDir, terminalState)`（runLoop.ts:931-941），也就是往一个
「租约已丢、可能已被新 owner 认领」的 run 上写了一次**终态**外加一条事件。
新分支写的是一次**非终态** `writeRunState` 外加一条 `heartbeat_stopped` 事件。

所以「姊妹分支谨慎、新分支莽撞」的对照是**反的**：就 debt-2 式的「往已不拥有的 run 写」而言，
姊妹分支是**更重**的那一侧，且它正是 brief 第 137 行点名的债 2 本体
（「**不修债 2**（`persistTerminalState` 往已不拥有的 run 写）」）。

### 2.2 债 2 接触面：**为零**

brief 对债 2 的定义是**具名而窄**的：`persistTerminalState` 往已不拥有的 run 写。
新分支**不调用** `persistTerminalState`（这正是方案 (a) 的全部要点，brief 第 168 行、第 175 行），
`persistTerminalState` 的调用点集合一个字节未变。

新分支的 `writeRunState` 与债 2 **形态相似**（都是一次无前置校验的写，写向一个
所有权可能已经转移的 run），但它不是债 2 的具名接触面，也没有扩大它。
评审员用「同形」一词把「相似」升格为「触碰」，这一步不成立。

### 2.3 今天是否可达 —— **今天不可达**

调用链，逐段：

1. `RunHeartbeatStoppedError` 唯一抛出点：`src/controller/leaseHeartbeat.ts:212`，在
   `runExclusive` 的 `refuseIfStopped` 里，条件 `if (stopped)`。
2. `stopped` 只在 `stop()` 里置真（leaseHeartbeat.ts:244），且**只置不清**。
3. `runExclusive` 的生产调用点：`grep -rnF 'runExclusive(' src/` 命中三行，其中
   `leaseHeartbeat.ts:24`（类型）、`leaseHeartbeat.ts:209`（定义）、`runLoop.ts:1000`
   （`INERT_LEASE_HEARTBEAT` 桩）；**唯一真实调用**是 `runLoop.ts:786`，在
   `persistBoundaryAnalysis` 内。
4. 两个 `heartbeat.stop()` 生产调用点：
   - `src/controller/runLoop.ts:989`，在 `try { return await runLoopFromState(...) } finally { await heartbeat.stop(); }`
   - `src/controller/resumeLoop.ts:198`，同形：`finally { await heartbeat.stop(); }`，
     紧跟在 `return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat, leaseLoss, {...})` 之后。

`stop()` 只在 `runLoopFromState` **已经返回或抛出之后**才跑，而 `persistBoundaryAnalysis`
在 `runLoopFromState` **内部**。因此在生产代码里，`runExclusive` 永远不可能观察到 `stopped === true`。

**明确表态：新分支的 `writeRunState` 今天不可达。未发现任何可达路径。**
这与 brief 第 194 行的自陈一致（「`stopped` 之后的 `runExclusive` 在 **L3 内不可达**……
**本改动是纵深防御**，也是常驻形态（`watch`）的前置加固」）。测试 7b 之所以能跑到它，
是因为它直接驱动 `runLoopFromState` 并传入一个 `runExclusive` 必抛的替身
（`runLoop.integration.test.ts:1181-1192`），这是测试注入，不是生产路径。

### 2.4 危害面（若将来 `watch` 让它可达）—— 源码回答

- **写什么**：`writeRunState(runDir, state)`，`state` 是**本进程内存里**的 `RunState`，
  在该分支触发时**恒为非终态**——两个 `persistBoundaryAnalysis` 调用点
  （runLoop.ts:1177、1231）之前的路径上都没有 `persistTerminalState`；1177 那次的
  `persistTerminalState("exhausted")` 排在它**之后**（1178-1183），错误在它之前逃出。
  内容典型为 `status: "executing"`，`budgetSnapshot` 已被若干次 `applyPhaseUsage` 推进。
- **会不会覆盖新 owner 的状态**：会。`writeRunState` 的全部实现：
  ```ts
  export async function writeRunState(runDir: string, state: RunState): Promise<void> {
    await writeJsonFileAtomically(join(runDir, "loop-state.json"), state);
  }
  ```
  （`src/persistence/fileStore.ts:81-83`）
  `writeJsonFileAtomically`（同文件 651-657）是 `JSON.stringify` → 写临时文件 → `rename`：
  ```ts
  const serialized = JSON.stringify(value, null, 2);
  const tempPath = buildAtomicTempPath(path);
  await writeFile(tempPath, serialized);
  await rename(tempPath, path);
  ```
  **原子替换，无 CAS、无 read-modify-write、无 epoch/owner 前置校验、不读现有内容。**
  新 owner 若已把 `loop-state.json` 推进到别的状态，这次写会整份盖掉它，
  且没有任何机制会察觉。
- **规模**：一次写，非终态，不带事件以外的副作用（新分支还追加一条 `heartbeat_stopped` 事件，
  `appendEvent` 是 append-only，不覆盖）。

即：危害是真实的，但**今天为零**，因为整条路径不可达。这属于「为常驻形态预埋的加固里
带了一处未来的隐患」，不是当前的正确性缺陷。

### 2.5 计划怎么说 —— 逐字引用与冲突判定

brief 第 202 行**完整原文**：

> **⚠️ 必须补一次 `writeRunState(runDir, state)`，这是第四轮新增的要求：** §5.4 的停机点在 `while (true)` 顶端，那里刚跑过一次 `writeRunState`，所以「返回的 `state`」与磁盘**逐字节相同**；而本分支落在 attempt 中段，`state` 可能已被若干次 `applyPhaseUsage` 改过而**尚未**落盘。**若只 return 不落盘，返回值与磁盘不一致，「与 §5.4 同构」为假。**

同一份 brief 的另外两处把它写成无条件的动作序列：

- 第 168 行：「`runLoopFromState` 外层 catch 新增分支：`error instanceof RunHeartbeatStoppedError` → **追加 `heartbeat_stopped` 事件 → `writeRunState(runDir, state)` → 返回该非终态 `state`**，**不调 `persistTerminalState`**」
- Step 6（第 233 行）：「加 `runLoopFromState` 外层 catch 的新分支（排在 `isLeaseStopError` 分支**之前**）：追加 `heartbeat_stopped` 事件 → `writeRunState(runDir, state)` → return 非终态 `state`。」

**判定（分守卫形状回答，这是递给人裁的关键）：**

- **加一个「所有权/租约」守卫 → 与计划文本冲突。** 计划给出的理由
  （「返回值与磁盘不一致，『与 §5.4 同构』为假」）在租约已丢时**依然成立**——
  它要的是返回值与磁盘一致，与所有权无关。一个按所有权跳过写盘的守卫会
  直接制造计划明令要避免的那个状态。同时测试 7b 的
  `expect(persisted).toEqual(finalState)`（runLoop.integration.test.ts:1216）会红。
- **照抄姊妹分支的终态守卫（`isTerminalRunStatus(state.status) ? state : writeRunState(...)`）
  → 不与计划文本冲突，但今天是恒真的死代码。** 如 2.4 所述，该分支触发时
  `state.status` 恒为非终态（两个 `persistBoundaryAnalysis` 调用点之前都没有终态写），
  所以这个守卫永远走 else 分支，测试 7b 不会红，行为一字不变。
  换言之：它买不到任何东西，只是把姊妹分支的形状抄过来看着对称。
- **计划文本站在「就地记账」一边。** 它把这次写盘写成**无条件必须**，并给出了
  一条与所有权无关的理由；它同时（第 194 行）已经如实记录了「今天不可达」。
  要加一个真正有意义的守卫（所有权/CAS），就要**同时改动 brief 第 202 行的要求**
  以及 `writeRunState` 的语义（今天它没有任何前置校验），这已超出 B1 的改动面
  （§9 模块表把 `leaseHeartbeat.ts` 限死在「`runExclusive` 拒绝 + 其上方注释」，
  brief 第 137 行又要求债 2 接触面为零）。

---

## 变异还原证明

两次注入（谓词单点加宽、临时探针测试文件）均已还原：

```
--- git status --porcelain ---
--- HEAD ---
dab1040e307efc130f2759d9c225d4daa68f4bf8
--- grep MUTATION ---
grep-exit=1
--- grep PROBE ---
grep-exit=1
--- probeTmp present? ---
leaseGate.test.ts
leaseHeartbeat.test.ts
leaseLifecycle.integration.test.ts
resumeLoop.gate.test.ts
resumeLoop.integration.test.ts
runLoop.integration.test.ts
```

（`git status --porcelain` 零输出；`grep -rnF MUTATION src/ tests/ scripts/` 与
`grep -rnF PROBE src/ tests/ scripts/` 均 exit 1 = 无命中；`tests/controller/` 下无 `probeTmp.test.ts`。）

还原后全套件：

```
 Test Files  29 passed (29)
      Tests  487 passed (487)
   Duration  16.86s
```

**树已还原干净，与基线逐项一致。**

---

## 可重跑的命令清单

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt3-heartbeat-stop

# 基线
rtk proxy "npm test"

# 前提 1 的单点注入：在 src/controller/runLoop.ts:108 的 return 尾部追加
#   || error instanceof RunHeartbeatStoppedError
rtk proxy "npm run typecheck"
rtk proxy "npm test"
rtk proxy "git checkout -- src/controller/runLoop.ts"

# 附加问题的探针：见本报告 1.3，心跳替身的 assertHeld 抛 RunHeartbeatStoppedError，
# 驱动 runLoopFromState，观察 finalState.status / stopReason / events
rtk proxy "npx vitest run tests/controller/probeTmp.test.ts"

# 还原证明
rtk proxy "bash -c 'git status --porcelain; git rev-parse HEAD; grep -rnF MUTATION src/ tests/ scripts/; grep -rnF PROBE src/ tests/ scripts/'"
```
