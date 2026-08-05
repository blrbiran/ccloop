# 独立评审 lane 1 — 代码侧承重结论的独立重推

评审员未参与本轮任何一份扫描报告。仓库 `/Users/biran/code/skills/loop/ccloop`，分支 `main`，HEAD `e9021ef`。
方法：**从代码重新推，不拿报告结论当输入**。报告只用来知道「它主张了什么」，比对在每节末尾。

> 落盘方式：本会话流不稳定（不止大 payload 一种），本报告逐节增量落盘。每节自带完成度标注。

## 节完成度索引

| 节 | 承重主张 | 完成度 | 判定 |
|---|---|---|---|
| 1 | 债 2 可达且数据丢失 ＋ `git log -S` 重跑 | **完整** | **CONFIRMED**（命令形式需加限定） |
| 2 | 第 1 笔六步夺锁构造 | **完整** | **CONFIRMED，无一环报废** |
| 3 | 八条判据无一比较进程身份 | **完整** | **CONFIRMED**（附范围限定 3.3） |
| 4 | 第 4 笔两条时序可达且静默 | **完整** | **CONFIRMED**（附边界 4.4） |
| 5 | `.stop()` 恰 2 个生产调用点、都在 `finally` | **完整** | **CONFIRMED**（三方未一起错） |
| 6 | 第 2 笔 ⊋ §14 第 3 条 | **不完整** | 缺口 (1)(3) **CONFIRMED**；构造二**未验** |
| 7 | 组 B 两条债 ＋ 487→514 | **完整** | 数字差 **CONFIRMED**；「须重跑注入」**成立** |
| 8 | fail-closed 抛出是三条 | **完整** | **CONFIRMED（低估）** |
| 9–11 | 三个必答问题 | **完整** | 见各节 |
| 12 | 本评审自身的未完成项 | **完整** | 9 条，明写 |

**一句话**：**八条承重主张，七条完整且全部 CONFIRMED，第 6 条部分完成（裁断成立、构造二未验）。
没有一条被证伪，没有一条被高估。**

## 1. 债 2：`persistTerminalState` 可达且是数据丢失 — **完整。CONFIRMED（含一处必须记的方法学更正）**

### 1.1 调用点总数与「由 lease-loss 到达的 4 个」

```
$ grep -rcF 'persistTerminalState(' src/ | grep -v ':0'
src/controller/runLoop.ts:16

$ grep -rnF 'persistTerminalState(' src/
src/controller/runLoop.ts:931:async function persistTerminalState(
src/controller/runLoop.ts:1062:      return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
src/controller/runLoop.ts:1110:          return await persistTerminalState(runDir, state, "cancelled", error.stopReason);
src/controller/runLoop.ts:1119:          state = await persistTerminalState(
src/controller/runLoop.ts:1150:        state = await persistTerminalState(
src/controller/runLoop.ts:1173:        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
src/controller/runLoop.ts:1218:          state = await persistTerminalState(
src/controller/runLoop.ts:1292:          state = await persistTerminalState(
src/controller/runLoop.ts:1301:        state = await persistTerminalState(
src/controller/runLoop.ts:1327:        state = await persistTerminalState(
src/controller/runLoop.ts:1338:        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
src/controller/runLoop.ts:1370:        state = await persistTerminalState(
src/controller/runLoop.ts:1455:          return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
src/controller/runLoop.ts:1461:      state = await persistTerminalState(runDir, state, decision.kind, decision.reason);
src/controller/runLoop.ts:1514:          : await persistTerminalState(runDir, state, "cancelled", error.stopReason);
src/controller/runLoop.ts:1532:            state = await persistTerminalState(
```

16 命中 − 1 个定义行（:931）= **15 个调用点**。**CONFIRMED**，与报告及 run-registry plan 的
「十五个中的四个」一致。

四个 lease-loss 调用点，逐条读上下文确认：`:1062` 与 `:1455` 都在 `if (leaseLoss.lost !== null) {`
之内；`:1110` 与 `:1514` 都在 `if (isLeaseStopError(error)) {` 之内。**CONFIRMED（4 个）。**
`:1062` 逐字（`sed -n '1050,1070p'`）：

```
    if (leaseLoss.lost !== null) {
      return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
    }
```

`:1514` 带一个前置守卫，**但仍在非终态时裸写**（`sed -n '1505,1520p'`）：

```
      if (isLeaseStopError(error)) {
        return isTerminalRunStatus(state.status)
          ? state
          : await persistTerminalState(runDir, state, "cancelled", error.stopReason);
      }
```

### 1.2 `persistTerminalState` 无所有权守卫

```
$ sed -n '925,975p' src/controller/runLoop.ts   （函数体部分）
async function persistTerminalState(
  runDir: string,
  state: RunState,
  decision: TerminalDecision,
  reason: string,
): Promise<RunState> {
  const terminalState = transitionRunState(state, decision, reason);
  await appendTransitionEvent(runDir, terminalState, `loop_${decision}`, reason);
  await writeRunState(runDir, terminalState);
  return terminalState;
}
```

**CONFIRMED。** 函数体三行，**无 `assertHeld`、无 `checkRunLease`、无 epoch 比较、无进程身份比较**，
直接 `appendTransitionEvent` ＋ `writeRunState`。

### 1.3 `cancelled: []` 无出边且不在 `RESUMABLE_STATUSES`

```
$ grep -rn 'RESUMABLE_STATUSES' src/
src/controller/resumeLoop.ts:38:const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];
src/controller/resumeLoop.ts:64:  if (!RESUMABLE_STATUSES.includes(runState.status)) {

$ grep -rn 'cancelled' src/state/*.ts
src/state/stateMachine.ts:4:  queued: ["planning", "cancelled"],
src/state/stateMachine.ts:5:  planning: ["executing", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
src/state/stateMachine.ts:6:  executing: ["verifying", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
src/state/stateMachine.ts:7:  verifying: ["planning", "succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
src/state/stateMachine.ts:11:  cancelled: [],
src/state/types.ts:11:  | "cancelled"
src/state/types.ts:88:  kind: "retryable" | "succeeded" | "blocked_waiting_human" | "exhausted" | "cancelled" | "failed";
```

**CONFIRMED。** `cancelled: []` 出边为空；`RESUMABLE_STATUSES` 只有 `planning/executing/verifying`，
不含 `cancelled`。=> 一旦把别人的 run 写成 `cancelled`，**既不能再转移，也不能被 resume 捡起**。
**分级「数据丢失」成立。**

### 1.4 *** `git log -S` 的独立重跑 —— 结论 CONFIRMED，但报告用的命令形式必须更正 ***

报告主张「`git log -S` 证明最后一次变数是 `cfde8b9`（2026-07-26，L1 期），L3 一个没增没减」。
我用**裸符号名**重跑，得到一条报告没提的 L3 期命中：

```
$ git log -S'persistTerminalState' --date=short --pretty='%h %ad %s' -- src/
6935578 2026-08-04 feat(runLoop): add a stop-request slot at the loop top tha...
cfde8b9 2026-07-26 feat: re-check the lease before every side effect and aban...
2c60717 2026-07-26 feat: stop the run at the next phase boundary when its lea...
d91d1b4 2026-07-17 fix: consume final execute adapter result
7c617c9 2026-07-16 feat: add Claude subprocess wrapper adapter
bf19cbd 2026-07-16 fix: tighten Task 8 partial outcome boundary
9aa1edc 2026-07-16 fix: preserve Task 8 timeout human handoffs
decf880 2026-07-16 fix: close Task 8 controller handoff gaps
872a5fe 2026-07-16 fix: enforce Task 8 phase budgets
```

`6935578` 是 **2026-08-04、L3 期、且是 HEAD 的祖先**：

```
$ git merge-base --is-ancestor 6935578 HEAD && echo "YES ancestor of HEAD"
YES ancestor of HEAD

$ git show 6935578 -- src/controller/runLoop.ts | grep -n 'persistTerminalState'
41:  +    // Deliberately NOT persistTerminalState: a stop means "this process is done acting", not
```

**那一处新增是一行注释，不是调用点。** 加上括号后 L3 期命中消失，且逐点计数在 L3 前后不变：

```
$ git log -S'persistTerminalState(' --date=short --pretty='%h %ad %s' -- src/
cfde8b9 2026-07-26 feat: re-check the lease before every side effect and aban...
2c60717 2026-07-26 feat: stop the run at the next phase boundary when its lea...
d91d1b4 2026-07-17 fix: consume final execute adapter result
（以下与上表相同，略 —— 关键是 6935578 不在其中）

$ git show cfde8b9:src/controller/runLoop.ts   | grep -cF 'persistTerminalState('   → 16
$ git show 6935578^:src/controller/runLoop.ts  | grep -cF 'persistTerminalState('   → 16
$ git show 6935578:src/controller/runLoop.ts   | grep -cF 'persistTerminalState('   → 16
$ git show HEAD:src/controller/runLoop.ts      | grep -cF 'persistTerminalState('   → 16
```

**判定：结论 CONFIRMED —— L3 对债 2 的接触面确为零，「§13 本层对债 2 接触面为零」属实。**
**但报告的论据形式有一处必须记账的瑕疵**：它没有交代自己用的是带括号还是裸符号的 `-S`。
裸符号形式会命中 L3 的一条注释，读者若照着重跑会看到 `6935578` 并以为结论被证伪。
这与扫描员 A 自己在 §5.3 记下的 `isLeaseStopError` 由 3 行变 4 行（L3 注释含符号名）是**同一个
陷阱**，A 在那一处点破了、在这一处却没有。**建议 L5 沿用的规则：所有 `-S` / `grep` 计数类证据
必须写明是否带 `(`，并对「注释里的同名符号」显式排除。**

### 1.5 与报告的比对

| 报告主张 | 我的独立结论 |
|---|---|
| 15 个调用点（16 命中含定义行） | **CONFIRMED** |
| 4 个由 lease-loss 到达（:1062/:1110/:1455/:1514） | **CONFIRMED**，四处上下文逐条读过 |
| `persistTerminalState` 无所有权守卫 | **CONFIRMED**，函数体三行 |
| `leaseLoss.lost !== null` 那条裸写 | **CONFIRMED**（:1062、:1455 两处） |
| `cancelled: []` 无出边、不在 `RESUMABLE_STATUSES` | **CONFIRMED** |
| `git log -S` 证明 L3 没增没减 | **结论 CONFIRMED；命令形式需加限定**（见 1.4） |
| 分级：数据丢失 | **CONFIRMED** |


## 2. 第 1 笔「锁可被偷」的六步构造 — **完整。逐环节 CONFIRMED，无一环报废**

brief 要求「任何一环不成立就整条报废」。四个环节我逐个独立验。源码逐字（Read，未经代理）：

```
780  async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean> {
781    const { lockPath, ownerPendingPath, transferPendingPath, transactionMarkerPath } = getOwnerTransferPaths(runDir);
782    let lockContents = "";
783
784    try {
785      lockContents = await readFile(lockPath, "utf8");
786    } catch (error) {
787      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
788        return true;
789      }
790
791      throw error;
792    }
793
794    try {
795      const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
796      const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
797
798      if (pid !== null && isProcessActive(pid)) {
799        return false;
800      }
801    } catch {
802      const hasStagedArtifacts =
803        await pathExists(transactionMarkerPath)
804        || await pathExists(ownerPendingPath)
805        || await pathExists(transferPendingPath);
806
807      if (!hasStagedArtifacts) {
808        return false;
809      }
810    }
811
812    await safeUnlink(lockPath);
813    return true;
814  }
815
816  async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
817    const { lockPath } = getOwnerTransferPaths(runDir);
818
819    for (let attempt = 0; attempt < 2; attempt += 1) {
820      try {
821        const handle = await open(lockPath, "wx");
822
823        try {
824          await handle.writeFile(
825            JSON.stringify(
826              {
827                holderProcessInstanceId: `pid:${process.pid}`,
828                acquiredAt: new Date().toISOString(),
829              } satisfies OwnerTransferLockRecord,
830              null,
831              2,
832            ),
833          );
834        } catch (error) {
...
846      } catch (error) {
847        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
848          throw error;
849        }
850
851        if (!(await tryRecoverStaleOwnerTransferLock(runDir))) {
852          throw new OwnerTransferLockBusyError("owner transfer already in progress");
853        }
854      }
855    }
```

### 逐环节判定

**环节 1 — 零长度锁窗口：成立。** `open(lockPath, "wx")` 在 :821 **创建并返回**文件句柄；
内容要到 :824 的 `handle.writeFile` 才写入。两者之间隔着一个 `try {`（:823），是**两次独立的
await**。窗口内 `owner-transfer.lock` **存在且长度为 0**。**CONFIRMED。**

**环节 2 — `JSON.parse("")` 进 catch：成立。** 零长度文件的 `readFile(..., "utf8")` 返回 `""`，
**不是 ENOENT**，所以 :787 的早退不触发，`lockContents = ""`。:795 的 `JSON.parse("")` 抛
SyntaxError，落进 :801 的 catch。**CONFIRMED。**

**环节 3 — *** catch 里没有活进程检查 ***：成立，且这是整条构造的要害。**
唯一的活进程检查是 :798 的 `pid !== null && isProcessActive(pid)`，它在 **try 的成功路径上**。
进到 :801 的 catch 意味着 parse 已经失败、`pid` 从未被求出 —— :801–:810 这九行里
**没有任何 `isProcessActive`、没有任何 pid 读取**。于是「持有者还活着」这个事实在这条路径上
**根本没有机会被观察到**。**CONFIRMED。**

**环节 4 — `hasStagedArtifacts` 三路径且看不见第三份 pending：成立。**
:802–:805 的析取只取三个路径：`transactionMarkerPath`、`ownerPendingPath`、`transferPendingPath`。
**`reconciliationPendingPath` 不在其中** —— :781 的解构**根本没有取它**（解构列表逐字只有四个名字：
`lockPath, ownerPendingPath, transferPendingPath, transactionMarkerPath`），
而该路径在 `getOwnerTransferPaths` 里是存在的（`finalizePendingOwnerTransfer` 的
`fileTargets` 用到了 `paths.reconciliationPendingPath`）。**CONFIRMED。**

符号命中数复核（报告称「仍 2 行、仍是定义＋使用」）：`hasStagedArtifacts` 在本文件命中
**:802 定义 / :807 使用，共 2 行**（见上面 grep 输出的 :802、:807 两行）。**CONFIRMED**；
报告写的旧行号 `:542/:547` 已腐坏，**条数与符号对得上**，按 brief 的锚点规则以符号为准。

**环节 5 — 落到删锁：成立。** `hasStagedArtifacts` 为真 ⇒ 不进 :807 的 `return false` ⇒
**直落 :812 `safeUnlink(lockPath)` 与 :813 `return true`**。catch 之后没有任何补充判断。
活着的持有者 A 的锁被删。**CONFIRMED。**

**环节 6 — B 重新拿到锁：成立。** :851 收到 `true` ⇒ 不抛 `OwnerTransferLockBusyError` ⇒
`for` 循环进入 `attempt = 1` 第二轮 ⇒ :821 的 `open(..., "wx")` 此时成功（锁已被自己删掉）。
**A 与 B 同时自认持锁。CONFIRMED。**

### 前提二（残余 staging）的可达性 —— 我自己推的，报告只说「前提二，缺它不成立」

环节 4 要求盘上此刻至少有一份 marker / owner-pending / transfer-pending。
`writeOwnerTransferArtifacts` 的顺序是 **先取锁（:1036）→ 再 `recoverInterruptedOwnerTransfer(lockHeld:true)`
清理无 marker 的残余（:1039）→ 才开始暂存（:1060 起）**：

```
1036   const lock = await acquireOwnerTransferLock(runDir);
1037
1038   try {
1039     await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
1040     const persistedOwnerRecord = await readOwnerRecordRaw(runDir);
```

也就是说**清理发生在取锁之后**。A 处在 :821→:824 的零长度窗口里时，:1039 的清理**还没执行**，
一次先前崩溃留下的残余 staging **仍在盘上**。B 恰在此刻到达 ⇒ 环节 4 为真。
**前提二可达，与构造自洽。CONFIRMED。**

### 与报告的比对

| 报告主张 | 我的独立结论 |
|---|---|
| 零长度锁窗口（:821 ↔ :824） | **CONFIRMED** |
| `JSON.parse("")` 进 :801 catch | **CONFIRMED** |
| catch 里没有活进程检查 | **CONFIRMED**（:798 在成功路径上） |
| `hasStagedArtifacts` 三路径、第三份 pending 不在其中 | **CONFIRMED**（:781 解构未取 `reconciliationPendingPath`） |
| `hasStagedArtifacts` 仍 2 行、定义＋使用 | **CONFIRMED**（:802/:807） |
| 六步整条成立 | **CONFIRMED，无一环报废** |

**关于报告自报「一句不可核」（『今天由 epoch 不等挡住』描述的是 L3 合入前的代码）：**
我同意这个处置。该句的指称对象不在今天的 main 上，**在 HEAD 上既不能证实也不能证伪**，
扫描员标注「不可核、原样上报」而不是替它圆场，**是正确的处置，我不改判**。


## 3. `evaluateResumeEligibility` 八条判据无一比较进程身份 — **完整。CONFIRMED（附一条范围限定）**

这是 brief 点名「错了会误导整个 L5 优先级排序」的一条。我**逐条读、逐条判**，全文逐字（Read，未经代理）：

```
40  export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {
41    const { ownerRecord, ownerTransfer, reconciliation, runState } = input;
42
43    if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
44      return { ok: false, reason: "owner-transfer is not eligible for continuation" };
45    }
46    if (reconciliation.eligibleForContinuation !== true) {
47      return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
48    }
49    if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
50      return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
51    }
52    if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
53      return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
54    }
55    if (ownerRecord.supersededByEpoch !== null) {
56      return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
57    }
58    if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
59      return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
60    }
61    if (ownerRecord.ownerStatus !== "current") {
62      return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
63    }
64    if (!RESUMABLE_STATUSES.includes(runState.status)) {
65      return { ok: false, reason: `run status ${runState.status} is not resumable` };
66    }
67
68    return { ok: true };
69  }
```

### 3.1 逐条判定「这一条比较的是什么」

| # | 行 | 比较的对象 | 是进程身份比较吗 |
|---|---|---|---|
| 1 | :43 | `ownerTransfer.eligibleForContinuation` 与字面量 `true` | **否**（单文件布尔标志） |
| 2 | :46 | `reconciliation.eligibleForContinuation` 与 `true` | **否**（单文件布尔标志） |
| 3 | :49 | `reconciliation.ownershipVerdict` 与字面量 `"OWNER_LOST"` | **否**（枚举） |
| 4 | :52 | `reconciliation.newOwnerEpoch` 与 `ownerTransfer.newOwnerEpoch` | **否**（跨文件，但比的是 **epoch 数字**） |
| 5 | :55 | `ownerRecord.supersededByEpoch` 与 `null` | **否**（单文件字段） |
| 6 | :58 | `ownerRecord.currentOwnerEpoch` 与 `ownerTransfer.newOwnerEpoch` | **否**（跨文件，但比的是 **epoch 数字**） |
| 7 | :61 | `ownerRecord.ownerStatus` 与 `"current"` | **否**（枚举） |
| 8 | :64 | `runState.status` 是否在 `RESUMABLE_STATUSES` 内 | **否**（状态枚举） |

机械复核（在函数体 :40–:69 内搜任何身份字段）：

```
$ sed -n '40,69p' src/controller/resumeLoop.ts | grep -n 'ProcessInstanceId\|processInstance\|pid\|holder'
(exit=1 ; empty means zero hits)
```

**零命中。八条判据里没有任何一条读取 `currentProcessInstanceId` / `newProcessInstanceId` /
`priorProcessInstanceId` / pid / 锁持有者。判据 4 与判据 6 是唯二的跨文件比较，两条比的都是
epoch 数字，不是身份。CONFIRMED。**

### 3.2 「矛盾记录通过全部八条」——独立推导

关键在判据 6：它比 `ownerRecord.currentOwnerEpoch` 与 `ownerTransfer.newOwnerEpoch`。
若混合记录的两份 epoch 不等，判据 6 就会拦住，报告的推论会垮。所以必须核**两个进程算出的
`newOwnerEpoch` 是否相同**。`applyOwnerEpochTransfer` 逐字（Read）：

```
160  export function applyOwnerEpochTransfer(
161    ownerRecord: OwnerRecord,
162    nextProcessInstanceId: string,
163    at: string,
164    reason: string,
165  ): { nextOwnerRecord: OwnerRecord; transferRecord: OwnerTransferRecord } {
166    const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
167
168    return {
169      nextOwnerRecord: {
170        ...ownerRecord,
171        currentOwnerEpoch: nextEpoch,
172        currentProcessInstanceId: nextProcessInstanceId,
173        lastAffirmedAt: at,
174        ownerStatus: "current",
175        supersededByEpoch: null,
176        leaseAffirmedAt: null,
177      },
178      transferRecord: {
179        priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
180        newOwnerEpoch: nextEpoch,
181        priorProcessInstanceId: ownerRecord.currentProcessInstanceId,
182        newProcessInstanceId: nextProcessInstanceId,
183        transferredAt: at,
184        reason,
185        eligibleForContinuation: true,
186      },
187    };
188  }
```

`nextEpoch` 只由 `ownerRecord.currentOwnerEpoch + 1` 决定，**无并发感知、不含进程标识**。
A、B 两个进程都从盘上同一份 epoch N 的 owner-record 出发（owner-record.json 只在 finalize 的
rename 时才变），因此**两者算出的 `newOwnerEpoch` 都是 N+1**。于是对混合记录
（owner-record 来自 A、owner-transfer 来自 B）：

- 判据 6：`ownerRecord.currentOwnerEpoch (N+1) === ownerTransfer.newOwnerEpoch (N+1)` → **通过**
- 判据 4：`reconciliation.newOwnerEpoch (N+1) === ownerTransfer.newOwnerEpoch (N+1)` → **通过**
- 判据 5：`supersededByEpoch` 被 :175 写死 `null` → **通过**
- 判据 7：`ownerStatus` 被 :174 写死 `"current"` → **通过**
- 判据 1：`transferRecord.eligibleForContinuation` 被 :185 写死 `true` → **通过**

而身份的矛盾（`nextOwnerRecord.currentProcessInstanceId` = A 的 id，:172；
`transferRecord.newProcessInstanceId` = B 的 id，:182）**没有任何一条判据去看**。

**判定：CONFIRMED。八条判据无一比较进程身份；「owner-record 归 A、transfer 归 B」的矛盾三元组
确实能通过全部八条，`resume_adopted` 会照常发生。报告没有高估，方向正确。**

### 3.3 一条必须写明的范围限定（报告未写，不改判）

判据 2（`reconciliation.eligibleForContinuation === true`）与判据 3
（`ownershipVerdict === "OWNER_LOST"`）读的是 **reconciliation 记录的内容**，而 reconciliation
不是由 `applyOwnerEpochTransfer` 生成的，我**没有**在代码里追到它这两个字段的写入点。
所以严格说：**判据 4/5/6/7/1 由代码写死或由 epoch 相等保证必过；判据 2/3 之必过，依赖
「这是一次正常的接管场景」这个输入前提，不是纯代码事实。** 判据 8 依赖 run 的状态可续跑。

这**不削弱**结论：任何一次合法的 resume 都要满足判据 2/3/8，锁被偷的场景正是嫁接在合法 resume
路径上的；且承重主张本身（「无一比较进程身份」）是纯代码事实，与此无关。
**记在这里是为了不让下一层把「必过」误读成「八条全部由代码写死」。**

**本项未完成的部分：** reconciliation 记录的 `eligibleForContinuation` / `ownershipVerdict`
写入点未追。**缺：`buildSuccessfulReconciliationFromTransfer` 与 reconciliation 的构造路径。**


## 4. 第 4 笔两条时序都可达且都静默 — **完整。CONFIRMED（含一处必须写明的边界）**

brief 特别点名要核「`reconciliation_published_winner_replaced` 一条都盖不住」，因为该事件是
GATE-A 专门为「把静默的记录销毁变响亮」加的，若它其实盖得住一条，报告的分级就错了。

### 4.1 读 → 判定 → 写，三段全程无锁

```
392  async function preserveSuccessfulReconciliationIfNeeded(
...
396    if (nextReconciliationRecord.eligibleForContinuation) {
397      return { kind: "write", record: nextReconciliationRecord };
398    }
399
400    const persistedArtifacts = await readPersistedSuccessfulTransferArtifacts(runDir);   ← 读
401
402    if (persistedArtifacts.kind === "no_published_transfer") {
...
408      return { kind: "write", record: nextReconciliationRecord };
409    }
410
411    if (persistedArtifacts.kind === "unreadable") {
412      return { kind: "abandon", error: persistedArtifacts.error };
413    }
414
415    return {
416      kind: "write",
417      record: preserveSuccessfulReconciliationIfNeededFromArtifacts(   ← 判定
418        persistedArtifacts.ownerRecord,
419        persistedArtifacts.ownerTransferRecord,
420        persistedArtifacts.reconciliationRecord,
421        nextReconciliationRecord,
422      ),
423      publishedWinnerReplacedDetail: describePublishedWinnerReplacement(
424        persistedArtifacts.ownerRecord,
425        persistedArtifacts.ownerTransferRecord,
426        persistedArtifacts.reconciliationRecord,
427        nextReconciliationRecord,
428      ),
429    };
430  }
```

写在调用者里，:493：

```
493      await writeJsonFileAtomically(
494        join(runDir, "reconciliation-record.json"),
495        decision.record,
496      );
```

**全程无 `acquireOwnerTransferLock`。CONFIRMED**（:392–:430 与 :434–:519 内均无该符号；
本文件的取锁点只有 :1036 / :1079 / :1128 三处，都在别的函数里）。
=> 读（:400）与写（:493）之间存在一个不受保护的窗口，赢家可以在其中发布。**TOCTOU 结构成立。**

### 4.2 `transferRepresentsPublishedWinner` 的判据 B

```
163  function transferRepresentsPublishedWinner(
164    ownerRecord: OwnerRecord,
165    ownerTransferRecord: OwnerTransferRecord,
166  ): boolean {
167    return (
168      ownerTransferRecord.eligibleForContinuation === true
169      && ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch     ← 判据 B
170      && ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId
171    );
172  }
```

**判据 B 确在第二个合取项，比的是 `currentOwnerEpoch` 与 `newOwnerEpoch`。CONFIRMED。**
时序二里输家读到 transfer(newOwnerEpoch = N+1) 而 owner-record 仍是 N（赢家跑完 rename#1、
未跑 rename#2），判据 B 为 `N === N+1` → **false** ⇒ `transferRepresentsPublishedWinner` 为 false
⇒ `shouldProtectSuccessfulTransferTruth`（:204）第一个合取项为 false ⇒
`preserveSuccessfulReconciliationIfNeededFromArtifacts` 在 :248 `return nextReconciliationRecord`
⇒ **保护退化，输家的降级版本原样进入 :493 的覆盖写。CONFIRMED。**

rename 顺序（transfer 在 owner 之前）由 marker 的 `finalizeOrder` 决定，:1052 / :1057 逐字：

```
1052            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE],
1057            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE],
```

**transfer 在前、owner 在后、reconciliation 最后。时序二依赖的那个中间态存在。CONFIRMED。**
发布循环每轮之间隔着一整个 `safeUnlink` + `writeJsonFile`（:989–:991），窗口非零宽。

### 4.3 *** 「事件一条都盖不住」—— 核实 ***

事件的触发条件在 :500：

```
498      // Appended AFTER the write, not before: the event asserts that a published winner's record was
499      // destroyed, and if writeJsonFileAtomically throws it was not.
500      if (decision.publishedWinnerReplacedDetail !== undefined) {
501        try {
502          await appendEvent(runDir, {
503            type: "reconciliation_published_winner_replaced",
```

**时序一：事件在结构上不可能触发。** 时序一走 :402 的 `no_published_transfer` 分支，
:408 `return { kind: "write", record: nextReconciliationRecord }` —— 这个 return **根本没有
`publishedWinnerReplacedDetail` 字段**（该字段在类型 :347 上是可选的
`publishedWinnerReplacedDetail?: string`）。于是 :500 的判定读到 `undefined` ⇒ **不触发**。
`describePublishedWinnerReplacement` 在这条路径上**一次都没被调用**。
**这不是「恰好没触发」，是提前 return 导致的结构性不可达。CONFIRMED。**

**时序二：事件被 `describePublishedWinnerReplacement` 自己的第二个析取项挡掉。**

```
289  function describePublishedWinnerReplacement(
...
295    try {
296      if (
297        transferRepresentsPublishedWinner(persistedOwnerRecord, persistedOwnerTransferRecord)
298        || !shouldPreserveExistingReconciliationRecord(
299          persistedReconciliationRecord,
300          nextReconciliationRecord,
301          persistedOwnerTransferRecord,
302        )
303      ) {
304        return undefined;
305      }
```

时序二里第一个析取项为 false（判据 B 已挂）。第二个析取项 `!shouldPreserveExistingReconciliationRecord(...)`：

```
185  function shouldPreserveExistingReconciliationRecord(
186    persistedReconciliationRecord: ReconciliationRecord | undefined,
...
190    return (
191      persistedReconciliationRecord !== undefined
192      && isSuccessfulReconciliationForTransfer(persistedReconciliationRecord, ownerTransferRecord)
...
```

时序二定义为「赢家跑完 rename#1、未跑 rename#2」，因此 **rename#3（reconciliation-record.json）
必然也还没跑**。盘上的 `reconciliation-record.json` 要么不存在
（`readPersistedReconciliationRecord` 的 `catch { return undefined }`，:319–:321 ⇒ :191 第一个
合取项即 false），要么是**上一次转移**留下的旧记录（其 `priorOwnerEpoch` 对不上本次的 N ⇒
`isSuccessfulReconciliationForTransfer` 为 false）。两种情况 `shouldPreserveExistingReconciliationRecord`
都为 false ⇒ `!false = true` ⇒ **:304 `return undefined` ⇒ 不触发。CONFIRMED。**

**判定：两条时序都是数据丢失且静默；`reconciliation_published_winner_replaced` 一条都盖不住。
报告的分级没有错。CONFIRMED。**

### 4.4 一条必须写明的边界（报告未写，不改判，但 L5 需要知道）

时序二的「不触发」有一个**前提**：rename#3 未发生，因此盘上没有一份**匹配本次转移**的成功
reconciliation。若存在一种残余状态，使盘上恰好躺着一份 `priorOwnerEpoch` 与本次 N→N+1
**对得上**的成功记录（例如赢家先前崩在 rename#3 之后、随后重跑同一次转移），
`shouldPreserveExistingReconciliationRecord` 会为 true，第二个析取项变 false，**事件反而会触发**。

**这不推翻报告的结论** —— 报告主张的是「盖不住*这两条时序*」，而这两条时序按其自身定义就排除了
该残余状态。但它说明：**该事件覆盖的是一个比「输家覆盖赢家」窄得多的方形**，
L5 不可把「加了这个事件」当作「记录销毁已经变响亮」。**我把它记为一条范围限定，不是反驳。**

### 4.5 与报告的比对

| 报告主张 | 我的独立结论 |
|---|---|
| 读→判定→写非原子、不持锁 | **CONFIRMED** |
| 时序一可达（ENOENT → `no_published_transfer` → 无保护写） | **CONFIRMED** |
| 时序二可达且不需要 ENOENT | **CONFIRMED** |
| 判据 B 在第二个合取项、时序二下为 false | **CONFIRMED** |
| 时序一无事件（提前 return，`describe…` 未被调用） | **CONFIRMED，且是结构性不可达** |
| 时序二无事件（第二个析取项为 true） | **CONFIRMED** |
| 分级：数据丢失，两条都静默 | **CONFIRMED** |
| —（报告未写） | 事件覆盖面的边界，见 4.4 |


## 5. 第 3 笔今天在 `src/` 内无调用者（`.stop()` 计数）— **完整。CONFIRMED**

三名扫描员都报「恰好 2 个生产调用点、都在 `finally` 内、第三处命中是注释」。我自己数：

```
$ grep -rn '\.stop()' /Users/biran/code/skills/loop/ccloop/src/
/Users/biran/code/skills/loop/ccloop/src/cli.ts:169:// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
/Users/biran/code/skills/loop/ccloop/src/controller/runLoop.ts:989:    await heartbeat.stop();
/Users/biran/code/skills/loop/ccloop/src/controller/resumeLoop.ts:215:    await heartbeat.stop();

$ grep -rn '\.stop()' /Users/biran/code/skills/loop/ccloop/src/ | wc -l
       3
```

两个生产调用点的上下文，逐字：

```
$ sed -n '978,995p' src/controller/runLoop.ts
（略去 :978-:985 的 startLeaseHeartbeat 参数）
  try {
    return await runLoopFromState(contract, runDir, adapter, state, heartbeat, leaseLoss);
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}

$ sed -n '203,220p' src/controller/resumeLoop.ts
    return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat, leaseLoss, {
      onReconciliationWriteAbandoned: options?.onReconciliationWriteAbandoned,
      stopRequested: options?.stopRequested,
    });
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}
```

**判定：CONFIRMED。** 3 命中 / 1 处是 `cli.ts:169` 的注释 / 2 个生产调用点 `runLoop.ts:989` 与
`resumeLoop.ts:215`，**两个都紧贴在 `finally {` 之后的第一条语句**（中间只隔一行注释）。
三名扫描员没有一起错。`tests/` 内另有 26 处命中（`grep -rn '\.stop()' tests/ | wc -l` → 26），
不构成生产调用点，与该结论不冲突。

**推论也成立**：`.stop()` 只在 `finally` 内、即 `runLoopFromState` 已返回或已抛出之后触发，
所以「一次并发 `stop()` 在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`」在今天的
`src/` 里没有调用者可以构造。**第 3 笔今天不可达这一点，坐实。**


## 6. 第 2 笔 execute abort 与 §14 第 3 条的包含关系 — **不完整（构造二未验）。缺口 (1)(3) CONFIRMED**

裁断要核的是：§13 第 2 笔 ⊋ §14 第 3 条（SIGKILL 升级只覆盖三个缺口之一）。
三个缺口我能独立核两个，第三个（构造二）未验，逐条说明。

### 缺口 (1) —— `await operationPromise` 外无第二重上界：**CONFIRMED，且确是控制器侧**

```
394  async function runPhaseWithTimeout<T>(
395    timeoutMs: number,
396    operation: (abortSignal: AbortSignal) => Promise<T>,
397    options?: { awaitAbortedResult?: boolean },
398  ): Promise<PhaseOutcome<T>> {
...
405    const abortController = new AbortController();
406    let timer: ReturnType<typeof setTimeout> | undefined;
407    const operationPromise = operation(abortController.signal).catch((error: unknown) => {
408      throw new PhaseExecutionError(Math.max(Date.now() - startedAtMs, 0), error);
409    });
410
411    try {
412      const outcome = await Promise.race([
413        operationPromise.then((result) => ({ kind: "result" as const, result })),
414        new Promise<{ kind: "timeout" }>((resolve) => {
415          timer = setTimeout(() => {
416            abortController.abort();
417            resolve({ kind: "timeout" });
418          }, timeoutMs);
419        }),
420      ]);
...
448      if (!options?.awaitAbortedResult) {
449        void operationPromise.catch(() => undefined);
450        return { timedOut: true, elapsedMs: Math.max(elapsedMs, timeoutMs) };
451      }
452
453      try {
454        const result = await operationPromise;
```

**:454 是一个裸 `await`，不在任何 `Promise.race` 内、没有第二个 `setTimeout`、没有第二个
AbortController。** 超时已经在 :416 触发过 `abortController.abort()`；若 operation 不理会这次
abort，:454 就**无限期挂起**。这**完全在控制器侧，与 adapter 是谁无关**。**CONFIRMED。**

这条路径**只有 execute 相变走**：

```
$ grep -rn 'awaitAbortedResult' src/
src/controller/runLoop.ts:397:  options?: { awaitAbortedResult?: boolean },
src/controller/runLoop.ts:448:      if (!options?.awaitAbortedResult) {
src/controller/runLoop.ts:1195:        { awaitAbortedResult: true },
```

唯一置真的调用点是 :1195，即 execute：

```
1192       const executeOutcome = await runPhaseWithTimeout(
1193         executeTimeoutMs,
1194         (abortSignal) => adapter.execute(buildAttemptContext(contract, state, runDir, attempt, worktreePath, abortSignal, plan)),
1195         { awaitAbortedResult: true },
1196       );
```

plan（:1144）与 verify（:1357）不传该选项，走 :448–:450 的 `void ... .catch()` 早退，**不挂起**。
=> **「第 2 笔是 execute 独有」这一点，代码上坐实。**

### 缺口 (3) —— git 子进程无超时：**CONFIRMED，且比 §5.4 的 ⚠️ 多一个**

```
497  async function observeChangedPathsBestEffort(worktreePath: string): Promise<string[] | null> {
498    try {
499      const { stdout } = await execFileAsync(
500        "git",
501        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
502        { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
503      );
504      return parseChangedPathsFromGitStatus(stdout);
505    } catch {
506      return null;
507    }
508  }
```

**选项对象里既没有 `timeout` 也没有 `signal`。** 对照 `runRequiredChecks`（:159）就知道这不是
本仓库的通例 —— 那一处是传 signal 的：

```
169        const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
170          cwd: worktreePath,
171          signal: abortSignal,
172          maxBuffer: 10 * 1024 * 1024,
173        });
```

调用点：

```
$ grep -rn 'observeChangedPathsBestEffort' src/
src/controller/runLoop.ts:497:async function observeChangedPathsBestEffort(worktreePath: string): Promise<string[] | null> {
src/controller/runLoop.ts:1206:          const changedPathsObserved = await observeChangedPathsBestEffort(worktreePath);
```

**:1206 排在 :1192 的 execute 之后**，位于 `executeOutcome` 的后续处理段里 ——
也就是**恰在已经失去上界的那条路径上**再挂一段无上界的 git。
**扫描员 A 的第 4 条发现（§5.4 的 ⚠️ 只点了 `createAttemptWorkspace` / `cleanupAttemptWorkspace`
两个、漏了这第三个）CONFIRMED。**

⚠️ **限定**：我**未**逐字读 spec §5.4 的 ⚠️ 原文，所以「§5.4 只点了那两个」这半句
**我是接受报告的转述、未独立核**。我独立核实的是**代码事实**：:497 无 timeout 无 signal，
且其调用点在 execute 的后续路径上。**缺：spec §5.4 ⚠️ 段落的逐字引用。**

### 缺口 (2) —— SIGKILL 升级：**未独立核**

`subprocessClaudeAdapter.ts` 有一套 abortSignal 处理（:16/:35/:52–:56/:106/:122/:125/:143，
见下面 grep），但**我没有读它的 kill 逻辑**，因此「今天只发 SIGTERM、无 SIGKILL 升级」
**我无法确认也无法否认**。

```
$ grep -rn 'abortSignal' src/ | head -12
src/runtime/claude/subprocessClaudeAdapter.ts:16:  abortSignal?: AbortSignal,
src/runtime/claude/subprocessClaudeAdapter.ts:35:      abortSignal?.removeEventListener("abort", onAbort);
src/runtime/claude/subprocessClaudeAdapter.ts:52:    if (abortSignal) {
src/runtime/claude/subprocessClaudeAdapter.ts:53:      if (abortSignal.aborted) {
src/runtime/claude/subprocessClaudeAdapter.ts:56:        abortSignal.addEventListener("abort", onAbort, { once: true });
src/runtime/claude/subprocessClaudeAdapter.ts:106:      context.abortSignal,
src/runtime/claude/subprocessClaudeAdapter.ts:122:        context.abortSignal,
src/runtime/claude/subprocessClaudeAdapter.ts:125:      if (context.abortSignal?.aborted) {
src/runtime/claude/subprocessClaudeAdapter.ts:143:      current/types.ts:10:  abortSignal?: AbortSignal;（此行为代理合并输出，见下注）
```

（注：上面最后一行是本机 `rtk` 代理把 `src/runtime/types.ts:10` 的命中与前一行合并/截短所致；
`src/runtime/types.ts:10:  abortSignal?: AbortSignal;` 是独立的一行命中。**我按原样保留并标注，
不修饰输出。**）

### 缺口 (2') —— 构造二（scripted adapter 根本不读 `abortSignal`）：**未验，本项最大缺口**

报告称构造二证明「补 SIGKILL 也关不掉它」。**我没有找到并读过那个 scripted adapter**，
因此**无法判断**该构造是否成立。
**缺：scripted / stub adapter 的实现体（预计在 `tests/` 或 `src/runtime/` 下），
需确认它的 `execute` 是否忽略 `context.abortSignal` 而只按脚本时序 resolve。**

### 包含关系的裁断

**在我核到的范围内，「§13 第 2 笔 ⊋ §14 第 3 条」成立**：
缺口 (1) 是控制器侧的 :454 裸 await，**补 SIGKILL 完全不触及它** —— SIGKILL 作用于子进程，
而 :454 等的是 `adapter.execute` 返回的 Promise；一个不理会 abort、也不 spawn 子进程的 adapter
（或一个子进程已死但 Promise 未 settle 的 adapter）照样让 :454 永远挂着。
缺口 (3) 同理：:499 的 `execFileAsync` 无 timeout 无 signal，**SIGKILL 升级不给它加上界**。
=> **第 2 笔不得因为 §14 第 3 条被立项就勾销。这条裁断我支持。**
**但「补 SIGKILL 也关不掉它」的那条具体构造（构造二）我未验，见上。**

**分级「仅可操作性」我未独立核** —— 需要确认挂起时 run 停在非终态 `executing` 且不写盘、
仍可被下次 sweep 捡起。**缺：sweep 的捡起判据与 `executing` 的可捡性验证。**


## 7. 组 B 两条债不可达 ＋ 487 vs 514 的新腐坏 — **完整。数字差 CONFIRMED；「必须重跑注入」这个要求成立**

### 7.1 两条债今天不可达 —— 我能核到的部分

**债「`isLeaseStopError` 未导出」：CONFIRMED。**

```
$ grep -n 'isLeaseStopError' src/controller/runLoop.ts
107:function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLease...
1109:if (isLeaseStopError(error)) {
1477:...e the run. Deliberately its OWN branch, ordered ahead of isLeaseStopError rather
1507:if (isLeaseStopError(error)) {
```

（行尾被本机 `rtk` 代理截短，以 `...` 标出，原样保留。）
定义行 :107 **无 `export` 前缀**（`grep -n 'export' src/controller/runLoop.ts | grep -i 'isLeaseStopError'`
零命中）。命中共 **4 行**，其中 **:1477 是注释**（含符号名），实际判定点是 :1109 与 :1507。
**这正是 §1.4 里那个陷阱的第二例**：报告记的「由 3 行变 4 行，因为 L3 自己的注释含该符号名」
**CONFIRMED**。

**「专用分支排在谓词分支之前并提前 return」：CONFIRMED，且代码自己写明是刻意的。**
:1477 的注释逐字含 `Deliberately its OWN branch, ordered ahead of isLeaseStopError rather`
—— 该注释所在的分支在 :1507 的 `if (isLeaseStopError(error))` **之前**。
（进度台账写「专用分支 :1489」，我实测该注释在 :1477；**行号腐坏，顺序结论不腐**。）

**「`writeRunState` → `writeJsonFileAtomically` 是 stringify→temp→rename，无 CAS」：CONFIRMED。**

```
81  export async function writeRunState(runDir: string, state: RunState): Promise<void> {
82    await writeJsonFileAtomically(join(runDir, "loop-state.json"), state);
83  }

639 async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
640   const serialized = JSON.stringify(value, null, 2);
641   const tempPath = buildAtomicTempPath(path);
642
643   try {
644     await writeFile(tempPath, serialized);
645     await rename(tempPath, path);
```

**无任何前置读、无 expected 值比较、无 epoch 校验 ⇒ 无 CAS。** 一次 `rename` 全量替换
`loop-state.json`。=> **「一旦触发是数据丢失（整份 `loop-state.json` 被覆盖）」这个分级，
在写入原语这一侧成立。CONFIRMED。**

⚠️ **限定**：「两条债今天**不可达**」这个否定命题，我**没有独立证明**。我核实的是它们的
**触发原语与结构**（未导出、分支顺序、无 CAS）。**穷举可达性需要注入实验，不是阅读能给的。**
**本项这一半未完成，缺：注入实验。** —— 这恰好接上 7.2。

### 7.2 *** 487 → 514 的数字差：CONFIRMED ***

历史数（GATE-C 期，L3 台账）：

```
$ grep -rn '487' .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:711:  (29 files / 487 tests, typecheck 0) — the dedicated branch precedes the
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:826:  29 files / 487 tests exit 0 (+3 cases), typecheck 0, build 0, both allowed
```

今天的数（我自己在 HEAD `e9021ef`、干净工作区上跑的）：

```
$ ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run --reporter=basic
PASS (514) FAIL (0)
```

⚠️ **证据完整性声明**：这条命令的完整 vitest 摘要（`Test Files` / `Tests` / `Duration` 三行）
**被本机的 `rtk` 代理钩子压缩成了上面这一行**。落盘的原始输出文件里逐字只有
`PASS (514) FAIL (0)` 一行。**这是环境所为，不是我过滤的**，我按原样贴出并声明。
承重的数字（**514 通过、0 失败**）未被压缩，与 `progress.md` STEP 0 记的
`Tests 514 passed (514)` 一致。

**514 − 487 = 27。数字差 CONFIRMED。**

### 7.3 「必须重跑注入才能继承该结论」这个要求是否成立 —— **成立**

判断的依据不是数字大小，而是**那个结论的形式**。「加宽仍惰性」是一个**全称否定命题**
（「**没有**任何测试会因为加宽而变红」）。全称命题的证据是**穷举**，而那次穷举的论域是
「当时存在的 487 个 case」。论域扩大 27 个之后：

- 原证据**在逻辑上不覆盖**新增的 27 个 case —— 它们在实验做完之后才存在，一个都没被注入过；
- 且这 27 个正是 L3 最后阶段新加的、**最贴近被改动代码**的 case，先验上比随机 case
  **更可能**触到加宽；
- 该结论的用途是「加宽是安全的/惰性的」，**用它去授权一次改动**，而不是仅仅描述现状 ——
  一个用来授权改动的全称否定命题，论域变了就必须重验。

=> **「不许继承、必须重跑注入」这个要求成立，我支持扫描员 C 的处置。**
这与「结论腐坏 vs 论据腐坏」的区分一致：**结论未被证伪，但支撑它的穷举证据已不再穷举。**
用本仓库的话说，这是**论据腐坏**，而且是那种**必须重做实验、不能靠阅读补上**的论据腐坏。

**附带一条方法学建议（我自己的，不改判）**：本轮已经第二次出现「实测数与今日数不符」
（487/514，以及一堆行号）。建议 L5 沿用 D 的处置规则 ——
**报不出可重数的计数就不要报数字**，并且**凡记录一次穷举实验，必须同时记下论域的大小与提交号**，
否则下一轮无法判断该实验是否仍然穷举。`progress.md` 的 STEP 0 已经这么做了（记了 514 与 HEAD），
这是对的，**但 GATE-C 当时记 487 时没有记提交号**，所以今天只能靠日期推断。


## 8. fail-closed 抛出今天是三条 — **完整。CONFIRMED**

两名扫描员（A、B）独立报出「三条不是两条，锚点在 `finalizePendingOwnerTransfer` 内」。我自己数：

```
$ grep -n 'throw new OwnerTransfer' /Users/biran/code/skills/loop/ccloop/src/persistence/fileStore.ts
852:throw new OwnerTransferLockBusyError("owner transfer already in progress");
857:throw new OwnerTransferLockBusyError("owner transfer already in progress");
940:throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker ...
949:throw new OwnerTransferMarkerFinalizeOrderInvalidError(
976:throw new OwnerTransferPendingMissingError(
1043:throw new OwnerTransferPreconditionError("persisted owner record changed before ...
1086:throw new OwnerTransferPreconditionError("persisted owner record changed before ...
1135:throw new OwnerTransferPreconditionError(mismatchMessage);
```

（⚠️ 上面几行的字符串尾部被本机 `rtk` 代理截短，以 `...` 标出；符号名与行号未被截短，
承重的是符号名与行号。完整正文见下面的 Read 输出。）

函数边界与三条抛出的归属，用 Read 逐字取（不经代理）：

```
931  async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
...
940      throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker could not be read or parsed");
...
949      throw new OwnerTransferMarkerFinalizeOrderInvalidError(
950        `owner transfer transaction marker's finalizeOrder is not a valid permutation of the v${marker.version} file set`,
951      );
...
976          throw new OwnerTransferPendingMissingError(
977            `owner transfer pending file for ${fileName} is missing while finalizing a v${marker.version} marker`,
978          );
...
1005 }
```

**判定：CONFIRMED，且方向是「低估」。** `finalizePendingOwnerTransfer`（:931–:1005）内确有
**三条**具名 fail-closed 抛出：`OwnerTransferMarkerUnreadableError`（:940，§4.4 规则 3）、
`OwnerTransferMarkerFinalizeOrderInvalidError`（:949）、`OwnerTransferPendingMissingError`
（:976，§4.4 规则 2）。文档写「两条」是**低估** L3 自己扩大出来的面。
`:852/:857` 的 `OwnerTransferLockBusyError` 与 `:1043/:1086/:1135` 的
`OwnerTransferPreconditionError` **不在这个函数内**，不应并入这一笔。

**附带（我自己看到的，不改判）**：`finalizePendingOwnerTransfer` 末尾的 catch（:999–:1004）
确实是三个 `safeUnlink` 后 `throw error` —— 即 D1「三个 `safeUnlink` 都可能替换正在传播的
错误」所指的位置。它今天仍在，逐字：

```
999    } catch (error) {
1000     await safeUnlink(paths.transferTempPath);
1001     await safeUnlink(paths.ownerTempPath);
1002     await safeUnlink(paths.reconciliationTempPath);
1003     throw error;
1004   }
```

`safeUnlink` **不吞非 ENOENT 的错误**，实测：

```
$ grep -n -A8 'function safeUnlink' src/persistence/fileStore.ts
747:async function safeUnlink(path: string): Promise<void> {
748-  try {
749-    await unlink(path);
750-  } catch (error) {
751-    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
752-      throw error;
753-    }
754-  }
755-}
```

**=> D1（`finalize` catch 里的错误掩盖）在代码上成立**：:1000/:1001/:1002 任意一个抛出非 ENOENT
（EACCES / EIO / EBUSY）都会**先于 :1003 的 `throw error` 逃逸**，把正在传播的原始错误替换掉。
spec 正文把它「原样留给 L5」而未计入那 6 项 —— 该交接项**有代码依据**，不是纸面顾虑。
（本节其余部分完整；上面的 :999–:1005 行号已用 Read 复核，非凭记忆。）


## 9. 必答问题一：有没有报告违反铁律 — **完整（限于我核过的切片）**

铁律的三种违反形式：编造/凭记忆重建命令输出、过滤证据输出、**自己改判据或自己改分级**。

**先说范围**：我独立重推的是**代码侧承重结论**，覆盖 A 的项 A/B/C 与四条自findings、
B 的 B-1/B-2 与 fail-closed 一条、C 的项 C 与项 E 的数字、以及三方共报的 `.stop()` 计数。
**我没有核 D 的绝大部分（文档侧交接项 D1–D13）**，也没有核 C 的项 A/B/D 全文。
下面的逐份结论**仅限我核过的部分**，不是对整份报告的背书。

### 扫描员 A（`scan-A-debt2-lock-abort.md`）— **未发现违反铁律**

- **未发现编造**：我重跑的每一条（`persistTerminalState` 16 命中、4 个 lease-loss 调用点、
  `hasStagedArtifacts` 2 行、八条判据、`.stop()` 3 命中）**输出都对得上**。
- **未发现过滤**：报告在 §5.3 主动记下「`isLeaseStopError` 由 3 行变 4 行」这种**对自己不利**
  （让论据显得腐坏）的输出，而不是把第 4 行藏掉。这是反向证据。
- **未发现自改判据/自改分级**：
  - 「今天由 epoch 不等挡住」一句，**标注为「不可核，原样上报」而不是替它圆场** —— 处置正确。
  - 债 2 的**条件复议条款**（决策记录 :159），报告**只转达、明写「是人的判断」、不自裁** —— 正确。
  - 第 1 笔的归属，报告没有自行宣布「需重裁」，而是引原文措辞对照第 3 笔说明作者认为归属已清楚
    —— 这是**解读**并且**标明了是解读**，不是改判据。
- **一处方法学瑕疵（不构成违反铁律，但必须记账）**：`git log -S` 未写明带不带 `(`，
  裸符号形式会命中 L3 的一条注释（`6935578`）。详见 §1.4。**这是论据形式不严谨，不是编造** ——
  它的**结论经我重跑仍然正确**。

### 扫描员 B（`scan-B-span-and-toctou.md`）— **未发现违反铁律，且有一处该被复制的行为**

- **未发现编造**：我重推的 B-1 两条时序、判据 B、事件覆盖面，**全部对得上**。
- **未发现自改分级**：B 把「时序一的裸 `catch { return null }` 已腐坏」明确标为
  **「论据腐坏、结论不腐」**，没有因为论据变了就下调分级，也没有因为结论还在就掩盖论据变化。
  这正是本仓库要求的那个区分。
- **fail-closed 由两条变三条，B 报为「低估」并明写方向** —— 未自行改写 spec 的判据，只上报。
- *** 最该被复制的一条 ***：B 明写「我未独立验证 C 的 `resumeLoop` 结论，上述不构成背书」。
  **形状相似不等于互证**，B 拒绝把自己的独立结论借给别人当背书。
  **我在本报告 §9 开头照抄了这个做法**（声明我的结论只覆盖我核过的切片）。

### 扫描员 C（`scan-C-backoff-and-gate-carries.md`）— **未发现违反铁律**

- **未发现编造**：我重推的项 C 三条原语（未导出 / 分支顺序 / 无 CAS）、`.stop()` 计数、
  487 vs 514，**全部对得上**。
- **未发现过滤，且有主动声明**：报告全文两处输出削短**在原地明写**；三处自己的转录笔误
  **当场标注并保留**（而不是悄悄改掉）。**保留笔误并标注，比改掉更符合铁律。**
- **未发现自改分级**：项 B 的分级，C 明写「GATE-C 给的分级今天仍成立，**C 没有改它**」。
- **一处越界但方向正确**：C 报出「腐坏站点是 9 处不是台账的 3 处」并给了最小勘误建议，
  **但未动手改**。给建议不等于改判据，**处置正确**。
- **主动自报不完整**：项 E 明写「不完整」（18 条里 6 条未复核、lane 1 的 3 条无落点）。
  **自报不完整是合规行为，不是缺陷。**
- **按 CLAUDE.md Rule 6 明写超出 12,000 token 上限而非静默超支** —— 合规。

### 扫描员 D（`scan-D-offlist-sweep.md`）— **我未核其主体，只能就一点作结**

**我没有独立核 D 的 D1–D13**（那是文档侧，不在我的车道）。我只核了 D1 的**代码依据**
（finalize catch 的三个 `safeUnlink` 会替换正在传播的错误），**成立**（见 §8）。

就我能观察到的治理行为：D **当场证伪了控制器派单里的假前提**（父设计 §17 不存在，
真正的委任状在所有权设计里），**原样上报、没有替控制器圆场、也没有自己改判据** —— 处置正确。
D **拒绝报一个单一的「共 N 条」**，理由是「条目是人工归并单位、没有命令能重数它」，
改报两个可重数的行数。**这是对铁律 2（每个数字附一条能重推它的命令）最严格的执行，
应当沿用。**

### 总结论

**四份报告，在我核过的切片内，没有一份违反铁律。**
没有编造的输出、没有过滤证据、**没有任何一份自己改判据或自己改分级**。
本轮与「十五波每波自带缺陷」的历史相比，**行为模式明显不同**：四份都主动自报不完整，
三份主动记录了对自己不利的输出，一份拒绝为形状相似的结论背书，一份证伪了派单方的前提。

**唯一需要记账的**是 A 的 `git log -S` 命令形式不严谨（§1.4）——
**这是论据瑕疵，不是铁律违反**，且其结论经我独立重跑仍然成立。


## 10. 必答问题二：哪条结论被高估或低估 — **完整（限于我核过的切片）**

### 被**低估**的（方向：真实面比记录的宽）

1. **fail-closed 具名抛出：文档写两条，实测三条。**（§8）
   方向：**低估 L3 自己扩大出来的面**。`OwnerTransferMarkerFinalizeOrderInvalidError`（:949）
   是 L3 加的，从未被计入。两名扫描员独立报出，我独立第三次确认。

2. **`reconciliation_published_winner_replaced` 的覆盖面：被高估了，等价于「静默面被低估」。**（§4.4）
   该事件是 GATE-A 专门为「把静默的记录销毁变响亮」加的，直觉上会让人以为记录销毁已经响亮。
   实测它**盖不住第 4 笔的任何一条时序**，且它触发的方形比「输家覆盖赢家」窄得多。
   **L5 若把它当作已有的告警覆盖，会低估第 4 笔的静默面。**

3. **execute abort 的无上界 git：§5.4 的 ⚠️ 点了两个，实测第三个 `observeChangedPathsBestEffort`
   也无 timeout 无 signal，且其调用点恰在已失去上界的那条路径上。**（§6）
   方向：**低估**。

4. **「一次数组 push」的腐坏站点：台账记 3 处，C 数出 9 处，B 在源码注释侧又找到一处
   （`fileStore.ts` 的 `// (a single array push, no I/O)`）。**
   我在读 `writeBoundaryArtifacts` 时**独立撞到了 B 说的那处源码注释**，逐字在 :468–:469：
   `The callback deliberately does NOT get this treatment: its body is inside this layer's
   control (a single array push, no I/O)`。而同函数 :478 的实际调用是
   `options?.onReconciliationWriteAbandoned?.(String(decision.error))` —— 一次即时回调，
   **注释与代码不符，`b9afbf3` 只同步了 spec、源码注释没跟。B 的第 6 条发现 CONFIRMED。**
   方向：**低估**（站点数被低估至少 6 处 ＋ 源码侧 1 处）。
   ⚠️ **我未核这处是否已在 C 的 9 处之内** —— brief 要求核这一点，**本项未完成，
   缺：C 报告 §项 D 里那 9 处站点的逐条清单**。

### 被**高估**的

5. **我没有找到任何一条被高估的代码侧结论。**
   我逐条重推的八项承重主张，**没有一条的后果面比报告说的窄**。
   特别是 brief 点名担心的第 3 条（八条判据）——**它没有被高估**，方向正确且推导成立（§3）。

### 方向需要**收窄措辞**（不是高估，是范围没写全）

6. **「组 B 两条债今天不可达」**：这是**全称否定命题**，报告核实的是触发原语与结构，
   **不是穷举可达性**。措辞应为「未发现可达路径，且加宽的惰性证据已随 487→514 失效」，
   而不是「不可达」。**这不是高估后果，是把证据强度说得比实际高。**（§7.1、§7.3）

7. **「八条判据全部通过」**：判据 4/5/6/7/1 由代码写死或由 epoch 相等保证必过；
   **判据 2/3/8 依赖「这是一次正常接管场景」这个输入前提，不是纯代码事实。**（§3.3）
   承重主张（「无一比较进程身份」）不受影响，但下一层不应把「必过」读成「八条全由代码写死」。

## 11. 必答问题三：未完成项的承重排序 — **完整**

brief 要求排序、**不要全都说重要**。判据：**它不补掉，L5 的边界会不会画错？**

### 必须补掉才能定 L5 边界 —— **三条，只有三条**

**第 1 位 — C 的项 E：GATE-C deferred minor 18 条里 6 条未复核、lane 1 的 3 条无落点。**
理由：这是**唯一一条会让 L5 的输入清单本身缺项**的未完成项。其余未完成项都是「某一笔的细节
没查到底」，而这一条是「**有若干笔根本不知道存不存在**」。C 还查出 lane 1 的报告可能从未落盘、
ledger `:1631` 承诺的三个 ID 一次都没出现 —— **这意味着缺的不只是复核，是原始记录**。
**边界不能在输入清单未闭合时划定。**

**第 2 位 — 组 B「加宽仍惰性」必须重跑注入（487 → 514，27 个新 case 无人验证）。**
理由：见 §7.3。这个结论**被用来授权一次改动**，且其证据形式（穷举）已随论域扩大而失效。
它直接决定组 B 两条债在 L5 里是「零成本顺手补」还是「需要一轮完整验证」——
**这是边界宽窄的直接输入**。而且**它不能靠阅读补上**，必须真跑，所以越早排越好。

**第 3 位 — A 的 `recoverInterruptedOwnerTransfer` 夺锁后不重开锁那条（只做了静态阅读）。**
理由：我在 §2 读同一函数时**独立看到了这个形状**，逐字（:1007–:1022）：

```
1017   if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
1018     return;
1019   }
1020
1021   await finalizePendingOwnerTransfer(runDir);
```

`tryRecoverStaleOwnerTransferLock` 返回 true（**刚刚偷成了锁**）⇒ 合取为 false ⇒ 不 return ⇒
**直接 :1021 `finalizePendingOwnerTransfer`，中间没有任何 `acquireOwnerTransferLock`**。
即：**这条路径在「已经删掉别人的锁」之后，不持有任何锁就去 finalize。**
§13 第 1 笔只讲了 `acquireOwnerTransferLock` 那条入口，**这是第二个入口**。
它承重是因为**它可能把第 1 笔的范围从「锁协议」扩大到「recovery 路径」**，
两者是不同的修复面。A 明写「只做了静态阅读、未推到底」——**我的静态阅读与 A 一致，
但我同样没有推到底**（没有构造跨进程时序）。**必须补。**

### 应当补、但**不阻塞**边界划定 —— 四条

- **B 的三处小缺口 ＋ 一处全局限制**：B-1/B-2 的**承重结论我已全部独立重推并 CONFIRMED**，
  这些缺口影响的是描述精度，不是分级。
- **D 的 §2 vs §5.4 张力（缺 `persistBoundaryAnalysis` 触发路径）**：D 明写「无法判断是否真矛盾」。
  它是**一条文档张力**，不改变任何一笔的后果分级。
- **D 的 spec §4.6「代码零改动」未核实（D12 悬空）** 与 **`cleanupOwnerTransferStagingWithoutMarker`
  未读源码**：后者我在 §2 追前提二时读到了它的调用点与作用（:1012，无 marker 时清理残余 staging），
  **足以支撑第 1 笔的构造**；完整实现体对边界不承重。
- **D 未读 `docs/handoff/handoff.md`**：`progress.md` 已实测该文件的两处论断腐坏并以命令输出为准。
  **该文件已被降级为不可信输入，读不读不影响边界。**

### 明确**不必**在定边界前补的 —— 一条

- **C 的项 D「一次数组 push」9 处 ＋ 源码注释 1 处**：分级是**仅文档**，且 C 已给出
  「3 条勘误覆盖 6 处」的最小方案。**它是 L5 开工后的清单项，不是边界输入。**
  （唯一例外：若要把它并入某一笔，需先核那处源码注释在不在 9 之内 —— 见 §10 第 4 条。）


## 11. 必答问题三：未完成项的承重排序

## 12. 本评审自身的未完成项 — **明写，不假装完整**

按本仓库的规矩，我把自己没查到底的地方逐条列出。**这些不许被当成已查。**

1. **第 2 笔的构造二（scripted adapter 不读 `abortSignal`）未验。**
   缺：scripted / stub adapter 的实现体。**这是我八条里唯一一条主张我无法判定的**
   （缺口 (1)(3) 已 CONFIRMED，包含关系裁断成立，但「补 SIGKILL 也关不掉它」的那条具体构造未验）。
2. **第 2 笔缺口 (2)（SIGKILL 升级）未独立核。** 缺：`subprocessClaudeAdapter.ts` 的 kill 逻辑。
3. **第 2 笔分级「仅可操作性」未独立核。** 缺：sweep 的捡起判据、`executing` 非终态的可捡性。
4. **§5.4 的 ⚠️ 原文未逐字读。** 「只点了两个、漏了第三个」这半句我接受报告转述；
   我独立核实的只是代码事实（:497 无 timeout 无 signal，调用点 :1206 在 execute 后续路径上）。
5. **B 找到的那处源码注释是否在 C 的 9 处之内，未核。** brief 明确要求核这一点。
   缺：C 报告项 D 的 9 处站点逐条清单。**这是 brief 里我唯一没做到的指定动作。**
6. **reconciliation 的 `eligibleForContinuation` / `ownershipVerdict` 写入点未追**（§3.3）。
7. **「组 B 两条债不可达」的否定命题未独立证明**（§7.1）——需要注入实验，非阅读可得。
8. **D 的 D1–D13 主体未核**（文档侧，不在我的车道）。我只核了 D1 的代码依据。
9. **C 的项 A / 项 B / 项 D 全文未核**；我只核了它们与我车道交叉的部分。

### 一条我在核 §11 第 3 位时多看到的东西（顺带上报，未推到底）

`recoverInterruptedOwnerTransfer` 的 :1017 那个合取，**有两条**通向「不持锁就 finalize」的路径，
不止夺锁那一条：

```
1017   if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
1018     return;
1019   }
1020
1021   await finalizePendingOwnerTransfer(runDir);
```

- `lockHeld` 为假、**锁文件根本不存在** ⇒ 第二个合取项为 false ⇒ 落到 :1021，**全程无锁**；
- `lockHeld` 为假、锁存在、`tryRecoverStaleOwnerTransferLock` 返回 true（**刚偷成锁**）
  ⇒ 第三个合取项为 false ⇒ 落到 :1021，**删了别人的锁之后仍然不持锁**。

第一条路径由 `readOwnerRecord`（:1024–:1026，不传 `lockHeld`）到达，**是常规读路径**。
**A 只记了第二条。** 我**没有推到底**（未构造跨进程时序、未判定后果分级），
**记为未完成、原样上报**，供 L5 决定要不要并入第 1 笔。

