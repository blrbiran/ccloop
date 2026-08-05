# L5 输入盘点 — 切片 A：债 2 ／ 锁可被偷 ／ execute abort 无第二重上界

只读盘点。仓库 `/Users/biran/code/skills/loop/ccloop`，分支 `main`，HEAD `e9021ef87770acf8052bc4c509e56a1aa226523f`，工作区干净（盘点开始时实测）。

本文件只写三项，其余项由并行的其它扫描员负责。所有行号写作「符号 in 文件（今天在 :NNN）」，行号必然腐坏，以符号为准。

**完整度声明**：项 A 完整 ／ 项 B 完整 ／ 项 C 完整。三节都已填。文末另有「我发现的、原文没写的东西」与「交叉校验」两节。

---

### 项 A：债 2 —— `persistTerminalState` 往已不拥有的 run 写

**原文出处（三处，逐字引用）**

1. `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §13 表格（今天在 :2313）：

   > | 2 `persistTerminalState` 往已不拥有的 run 写 | **不碰**，留 L5 |

   同节「关于债 2」整段（今天在 :2362–:2364）：

   > **关于债 2**：§5.4 改判为不写终态，**且 §5.3 选了方案 (a)**（`RunHeartbeatStoppedError` 不进 `isLeaseStopError`，另设不写终态的分支），所以本层既不新增 `persistTerminalState` 调用点，也不让任何**既有**调用点被一类新错误触达。**本层对债 2 的接触面为零。**
   >
   > **⚠️ 这个结论依赖 §5.3 选 (a)。** 第一轮修订在选 (a) 之前就写了「接触面为零」——那时它不成立：§5.3 会让两个既有调用点被 `RunHeartbeatStoppedError` 触达，而债 2 恰是「`persistTerminalState` 往已不拥有的 run 写」。**若将来有人把方案改回 (c)，本段必须一起改。**

2. `docs/superpowers/plans/2026-07-28-run-registry.md`，"Debts This Plan Does Not Take" 第 2 条（逐字）：

   > 2. `persistTerminalState` writes into a run it no longer owns (`runLoop.ts`, the `persistTerminalState` calls reached from the lease-loss branches `if (leaseLoss.lost !== null)` and `if (isLeaseStopError(error))` — four of the symbol's fifteen call sites, **not** all of them; see spec §13.2) — L5.

3. `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`（:19）：

   > | 2 | `persistTerminalState` 往已不拥有的 run 写 | **L5** | 修它就制造孤儿，而孤儿是 L5 的定义域 |

**今天的落点（符号锚点）**

- `persistTerminalState` 定义 in `src/controller/runLoop.ts`（今天在 :931），`src/` 内唯一定义、无 export。
- 四个由 lease-loss 到达的调用点：`leaseLoss.lost !== null` 循环顶端分支（:1062）、`leaseLoss.lost !== null` 重试后分支（:1455）、`isLeaseStopError(error)` 内层 worktree catch（:1110）、`isLeaseStopError(error)` 外层 attempt catch（:1514）。
- `isLeaseStopError` in `src/controller/runLoop.ts`（今天在 :107）。
- `RunHeartbeatStoppedError` in `src/ownership/lease.ts`（今天在 :46），唯一抛出点 in `src/controller/leaseHeartbeat.ts` 的 `runExclusive`（今天在 :212），接住它的不写终态分支 in `src/controller/runLoop.ts`（今天在 :1489–:1497）。

**重推命令与当时输出**

```
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
EXIT=0

$ grep -cF 'persistTerminalState(' src/controller/runLoop.ts
16
```

16 处命中 − 1 处定义（:931）= **15 个调用点**。四个由 lease-loss 到达的是 :1062 / :1110 / :1455 / :1514（前两者在 `leaseLoss.lost !== null` 分支内，后两者在 `isLeaseStopError(error)` 分支内）。**「十五个中的四个」今天原样成立，一个数字都没变。**

数字未变不是巧合，用 git 钉住：

```
$ git log --oneline -S 'persistTerminalState(' -- src/controller/runLoop.ts
cfde8b9 feat: re-check the lease before every side effect and abandon the attempt in place
2c60717 feat: stop the run at the next phase boundary when its lease is lost
d91d1b4 fix: consume final execute adapter result
7c617c9 feat: add Claude subprocess wrapper adapter
bf19cbd fix: tighten Task 8 partial outcome boundary
9aa1edc fix: preserve Task 8 timeout human handoffs
decf880 fix: close Task 8 controller handoff gaps
872a5fe fix: enforce Task 8 phase budgets

$ git show cfde8b9 --format='%h %ad %s' --no-patch
cfde8b9 Sun Jul 26 21:20:06 2026 +0800 feat: re-check the lease before every side effect and abandon the attempt in place

$ git show "cfde8b9:src/controller/runLoop.ts" | grep -cF 'persistTerminalState('
16

$ git show "HEAD:src/controller/runLoop.ts" | grep -cF 'persistTerminalState('
16
```

最后一次改变该符号出现次数的提交是 **cfde8b9（2026-07-26，L1 期）**，早于 run-registry 计划（2026-07-28）与整个 L3。**L3 一个调用点都没增没减 —— §13「本层既不新增 `persistTerminalState` 调用点」经 git 核实为真。**

§13 结论所依赖的「§5.3 选了 (a)」，逐环节在今天代码上验证：

```
$ grep -nF 'isLeaseStopError' src/controller/runLoop.ts
107:function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
1109:        if (isLeaseStopError(error)) {
1477:      // terminate the run. Deliberately its OWN branch, ordered ahead of isLeaseStopError rather
1507:      if (isLeaseStopError(error)) {
EXIT=0

$ grep -cF 'isLeaseStopError' src/controller/runLoop.ts
4

$ grep -rn 'RunHeartbeatStoppedError' src/
src/controller/leaseHeartbeat.ts:7:  RunHeartbeatStoppedError,
src/controller/leaseHeartbeat.ts:212:        throw new RunHeartbeatStoppedError(
src/controller/runLoop.ts:23:import { RunHeartbeatStoppedError, RunLeaseLostError, RunLeaseUnverifiableError } from "../ownership/lease.js";
src/controller/runLoop.ts:1489:      if (error instanceof RunHeartbeatStoppedError) {
src/ownership/lease.ts:46:export class RunHeartbeatStoppedError extends Error {
src/ownership/lease.ts:51:    this.name = "RunHeartbeatStoppedError";

$ grep -rnF 'runExclusive(' src/
src/controller/runLoop.ts:786:  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
EXIT=0

$ grep -nF 'cancelled:' src/state/stateMachine.ts
11:  cancelled: [],
EXIT=0

$ grep -nF 'RESUMABLE_STATUSES' src/controller/resumeLoop.ts
38:const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];
64:  if (!RESUMABLE_STATUSES.includes(runState.status)) {
EXIT=0
```

判定体（`isLeaseStopError` in `src/controller/runLoop.ts`，今天在 :107–:109）逐字：

```ts
function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
  return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError;
}
```

`RunHeartbeatStoppedError` in `src/ownership/lease.ts`（今天在 :46）直接 `extends Error`，不是那两个的子类，且上方注释（:38–:45）自己写明这一点并点名它保护 `isLeaseStopError`。

那条**不写终态**的分支今天的形状（`runLoopFromState` 外层 catch in `src/controller/runLoop.ts`，今天在 :1489–:1497），逐字：

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

它排在 `isLeaseStopError` 分支（:1507）**之前**，`return` 掉，所以新错误永远到不了那两个既有调用点。§5.3 承诺的「另设分支 + 补一次 `writeRunState`」两半都在。

**今天是否可达**

- **「§5.3 选 (a)」是否属实**：属实，不是「文档说选了」而是代码实测。三条锚点齐备：谓词判定体不含新错误（:108）／新错误非子类（lease.ts :46 直接 `extends Error`）／唯一抛出点在 `runExclusive`（leaseHeartbeat.ts :212），不在 `assertHeld`。§5.3 的「两半缺一不可」硬约束今天两半都成立。
- **债 2 本身是否可达**：可达，且构造是既有的。四个调用点中最简单的一条：run 在 `runLoopFromState` 的 `while (true)` 内飞行，心跳的 `onLeaseLost` 回调置 `leaseLoss.lost`（另一个进程完成了 epoch 转移即可触发），下一次到达循环顶端命中 :1061 的 `if (leaseLoss.lost !== null)` → :1062 `persistTerminalState(runDir, state, "cancelled", "lease_lost")` → `writeRunState` 无条件裸写进一个**已被新 owner 接管**的 run 目录。`persistTerminalState`（:931–:941）内部只有 `transitionRunState` + `appendTransitionEvent` + `writeRunState`，**没有任何所有权守卫**。

**论据是否腐坏**（逐句核）

| 原文论据句 | 今天 | 判定 |
|---|---|---|
| 「四个 ... `if (leaseLoss.lost !== null)` 与 `if (isLeaseStopError(error))`」 | :1062 / :1455 / :1110 / :1514，恰四个 | **成立** |
| 「该符号十五个调用点中的四个」 | 16 − 1 定义 = 15 | **成立** |
| §13「本层既不新增 `persistTerminalState` 调用点」 | git：最后一次变数是 cfde8b9（L1 期） | **成立** |
| §13「也不让任何既有调用点被一类新错误触达」 | :1489 分支排在 :1507 之前并 return | **成立** |
| §5.3「`grep -nF 'isLeaseStopError' src/controller/runLoop.ts` 实测 3 行：:105 定义、:1001、:1353」 | 今天 **4 行**：:107 定义、:1109、:1477（注释）、:1507 | **论据腐坏**（行号腐坏 ＋ 命中条数从 3 变 4，因为 L3 自己新增的注释里出现了这个符号名）。**结论不腐坏**：定义仍 1 个、真实使用点仍 2 个。原样上报，不改判据。 |
| §5.3「`grep -cF 'state, "cancelled"' ...` 实测 4」 | 实测仍为 4 | **成立** |
| §5.3「`grep -rnF 'runExclusive(' src/` 命中 1 行：runLoop.ts:763」 | 命中仍 1 行，今天在 :786 | **结论成立，行号腐坏** |
| §5.3 引用的 `:1001` / `:1353` 两个 `isLeaseStopError` 使用点行号 | 今天 :1109 / :1507 | **行号腐坏，符号不变** |

**后果分级**

- **对「§13 接触面为零」这个待核结论本身：仅文档**（结论今天成立，只有支撑它的几条 grep 行号/条数过期）。
- **对债 2 本身：数据丢失。** 依据：`persistTerminalState` 写入的 `"cancelled"` 在 `src/state/stateMachine.ts` 的转移表里是 `cancelled: []`（今天在 :11，无合法出边），且 `RESUMABLE_STATUSES` 是 `["planning","executing","verifying"]`（`src/controller/resumeLoop.ts`，今天在 :38），不含 `cancelled`。丢租约的老进程把终态写进新 owner 的 run 目录后，该 run **对新 owner 也永久不可续跑**，且代码里没有任何路径退出终态。写的是别人的 run，且不可逆 —— 这不是「可重试拒绝」。

**归属是否需要重裁**

原文**没有**要求重裁：`2026-07-29-technical-debt-attribution.md` 已把债 2 明确裁给 L5（:19、:34），§13 第 3 笔那种「需要一次归属裁决」的措辞在债 2 这里一次都没出现。

**但裁决记录自带一条条件触发的复议条款，必须转达**（`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` :159 起）：

> 若 L3 的工期显著超出预期，**应重新审视是否把债 2 提前到 L3 之后、L5 之前单独处理**——那要求先回答「不写终态的 run 由谁负责收尾」……

L3 实际跑了六波以上评审（spec 内可见「第六波」字样）。**这个条件是否已经触发，是人的判断，不是我的**；我只负责把条款连同它的触发条件原样交出来。

**我不确定的地方**

- 我核实的是「四个调用点」这个**集合**今天仍是那四个、总数仍是 15。我**没有**核实 spec §13.2 —— 全文里没有 §13.2 这个编号（§13 是平铺的，没有子节），plan 的「见 spec §13.2」是一个**悬空引用**。它指的可能是旧版 spec（`2026-07-28` 之前那一份）的编号。这一条我没有追下去。
- `:1514` 那个调用点今天被 `isTerminalRunStatus(state.status) ? state : ...` 包着（三元的 false 分支才写）。`git log -S 'isTerminalRunStatus(state.status)'` 只有 cfde8b9 一个提交，说明**这个守卫先于 L3**，不是 L3 加的。它收窄了四个点里的一个，但**没有**把它变成非调用点 —— 我按「仍是四个」记账。若 L5 要重新计数「真实可达的裸写」，这一条需要单独判。

---

### 项 B：§13 具名清单第 1 笔 —— 锁可被偷

**原文出处（逐字引用交接它的整段）**

`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §13「本层查实、明确不处理、留给 L5 具名继承的五笔」第 1 笔（今天在 :2392–:2413）：

> 1. **锁可被偷。** `tryRecoverStaleOwnerTransferLock` 在 `JSON.parse(lockContents)` 抛**且** `hasStagedArtifacts` 为真时，才删锁返回 true。
>
>    **场景需要两个前提，第一轮只写了一个（第二轮评审补齐）：**
>
>    - **前提一**：`open(lockPath, "wx")` 之后、`handle.writeFile` 之前的锁文件恰好是**零长度、不可解析**——夺锁者的 `JSON.parse` 因此进 catch。
>    - **前提二（第一轮省略）**：catch 分支还要求 `hasStagedArtifacts` 为真（marker 或任一 pending 存在）。**而零长度锁窗口内新持有者尚未 staging 任何东西**，所以场景**还需要一次前一次崩溃留下的残余 staging**。
>
>    **前提二的 `hasStagedArtifacts` 只看三个路径，看不见第三份 pending（第三轮具名）：**
>
>    ```bash
>    grep -rnF 'hasStagedArtifacts' src/
>    # 实测 exit 0，命中 2 行：src/persistence/fileStore.ts:542 定义、:547 使用
>    ```
>
>    它的判定是 `pathExists(transactionMarkerPath) || pathExists(ownerPendingPath) || pathExists(transferPendingPath)` —— **`.reconciliation-record.pending.json` 不在其中**。本层加了第三份 pending 却**不**把它加进这个判定：加进去会让「只剩 reconciliation pending」这种残留也变成可夺锁的依据，那是**放宽**夺锁条件，与本层「只增加拒绝」的边界相反。**因此这里是一处刻意的不对称，具名记下**：`hasStagedArtifacts` 看不见第三份 pending，属 L5 的锁协议整改范围。
>
>    两个前提同时成立时，一个**活着的**持有者可能被夺锁，两个进程并发写入同一组固定 pending 文件名。今天由 epoch 不等挡住；本层之后，若 A、B 都从 epoch N 起算，两者的 `newOwnerEpoch` 都是 N+1，**epoch 三元组会通过**，得到一份「reconciliation 来自 A、transfer 来自 B」的记录——证据记录会对转移原因撒谎。**这是先于本层的缺陷，但 §4 扩大了它的影响面，故在此具名。** 不在本层修，因为修它要动锁协议本身。

另一处（`docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`，今天在 :323，逐字）：

> - **不要顺手把 `hasStagedArtifacts` 也扩容。** 它今天只看 marker / ownerPending / transferPending 三个路径；把新 pending 加进去会**放宽**夺锁条件，与本层「只增加拒绝」的边界相反。这是一处**刻意的不对称**，属 L5 的锁协议整改范围（§13 第 1 笔）。

**今天的落点（符号锚点，全部 in `src/persistence/fileStore.ts`）**

- `tryRecoverStaleOwnerTransferLock`（今天在 :780），`hasStagedArtifacts` 局部常量（今天在 :802 定义、:807 使用）。
- `acquireOwnerTransferLock`（:816），零长度窗口在 `open(lockPath, "wx")`（:821）与 `handle.writeFile(...)`（:824）之间；EEXIST → 调 `tryRecoverStaleOwnerTransferLock`（:851）。
- 第二个夺锁入口：`recoverInterruptedOwnerTransfer`（:1007）的 `!options?.lockHeld && pathExists(lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))`（:1017）。
- `isProcessActive`（:766）／`parsePid`（:761）。
- 固定 pending 文件名 in `getOwnerTransferPaths`（:568）：`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.reconciliation-record.pending.json` / `.owner-transfer.transaction.json`（常量在 :527–:531）。
- 暂存与发布：`writeOwnerTransferArtifacts`（:1029）→ `writeJsonFileViaFixedTemp`（:1113）×4 → `finalizePendingOwnerTransfer`（:931）。
- epoch 三元组：`evaluateResumeEligibility` in `src/controller/resumeLoop.ts`（:40），三条判据今天在 :52 / :55 / :58。
- epoch 递增：`applyOwnerEpochTransfer` in `src/ownership/ownerController.ts`（:160），`const nextEpoch = ownerRecord.currentOwnerEpoch + 1;`（:166）。

**重推命令与当时输出**

```
$ grep -rnF 'hasStagedArtifacts' src/
src/persistence/fileStore.ts:802:    const hasStagedArtifacts =
src/persistence/fileStore.ts:807:    if (!hasStagedArtifacts) {
EXIT=0

$ grep -rnF 'hasStagedArtifacts' src/ | wc -l
       2

$ grep -nF -A18 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts
780:async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean> {
781-  const { lockPath, ownerPendingPath, transferPendingPath, transactionMarkerPath } = getOwnerTransferPaths(runDir);
782-  let lockContents = "";
783-
784-  try {
785-    lockContents = await readFile(lockPath, "utf8");
786-  } catch (error) {
787-    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
788-      return true;
789-    }
790-
791-    throw error;
792-  }
793-
794-  try {
795-    const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
796-    const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
797-
798-    if (pid !== null && isProcessActive(pid)) {
EXIT=0

$ grep -nF -A14 'const handle = await open(lockPath, "wx");' src/persistence/fileStore.ts
821:      const handle = await open(lockPath, "wx");
822-
823-      try {
824-        await handle.writeFile(
825-          JSON.stringify(
826-            {
827-              holderProcessInstanceId: `pid:${process.pid}`,
828-              acquiredAt: new Date().toISOString(),
829-            } satisfies OwnerTransferLockRecord,
830-            null,
831-            2,
832-          ),
833-        );
834-      } catch (error) {
835-        await handle.close();
EXIT=0
```

`-A18` 在原文写作时够长，今天不够 —— catch 分支的尾巴（:801–:813）落在 18 行之外，补贴该函数剩余部分（`Read` 出的 :794–:814，逐字）：

```ts
  try {
    const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
    const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;

    if (pid !== null && isProcessActive(pid)) {
      return false;
    }
  } catch {
    const hasStagedArtifacts =
      await pathExists(transactionMarkerPath)
      || await pathExists(ownerPendingPath)
      || await pathExists(transferPendingPath);

    if (!hasStagedArtifacts) {
      return false;
    }
  }

  await safeUnlink(lockPath);
  return true;
}
```

epoch 三元组所在的八条判据，今天的实测行位置：

```
$ grep -nF 'return { ok: false' src/controller/resumeLoop.ts
44:    return { ok: false, reason: "owner-transfer is not eligible for continuation" };
47:    return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
50:    return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
53:    return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
56:    return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
59:    return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
62:    return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
65:    return { ok: false, reason: `run status ${runState.status} is not resumable` };

$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
```

**今天是否可达 —— 可达，给构造**

夺锁本身（前提一 ＋ 前提二）：

1. run 目录里有一次前次崩溃留下的残余 staging（例如 `.owner-transfer.pending.json`）。**这是前提二，缺它整个场景不成立。**
2. 进程 A 调 `acquireOwnerTransferLock`，`open(lockPath, "wx")`（:821）成功返回，尚未执行 :824 的 `handle.writeFile` —— 锁文件此刻**存在且零长度**。
3. 进程 B 调 `acquireOwnerTransferLock`，`open` 抛 EEXIST（:847 判定），进 :851 的 `tryRecoverStaleOwnerTransferLock`。
4. B 的 `readFile` 读到 `""`（不是 ENOENT，所以不走 :788），`JSON.parse("")` 抛 → 进 :801 的 catch。**注意：catch 分支里没有任何活进程检查** —— `isProcessActive`（:798）只在成功解析那条路径上。
5. `hasStagedArtifacts` 因第 1 步为真（:802–:805）→ 不 return false → 落到 :812 `safeUnlink(lockPath)`、:813 `return true`。**A 这个活着的持有者的锁被删了。**
6. B 回到 :819 的 `for` 第二轮，`open(lockPath, "wx")` 成功 → **A 与 B 同时「持锁」。**

原文推论「A、B 都从 epoch N 起算 ⇒ 三元组通过 ⇒ 一份 reconciliation 来自 A、transfer 来自 B 的记录」，逐环节验证：

| 环节 | 今天代码上的落点 | 结论 |
|---|---|---|
| A、B 都读到 epoch N 的 owner-record | `writeOwnerTransferArtifacts`（:1040）`readOwnerRecordRaw`；owner-record.json 只在 finalize 的 rename 时才变 | **成立** |
| 两者的 `newOwnerEpoch` 都是 N+1 | `applyOwnerEpochTransfer`（ownerController.ts :166）`const nextEpoch = ownerRecord.currentOwnerEpoch + 1;`，无并发感知 | **成立** |
| 两者的 CAS 都通过 | `sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)`（:1042）比的是 epoch-N 的记录，两者都还没 rename | **成立** |
| 两者写同一组固定文件名 | `writeJsonFileViaFixedTemp` 四连（:1060 transfer、:1061 owner、:1064 recon、:1067 marker），路径来自 `getOwnerTransferPaths`，**全是固定名，无进程标识** | **成立**；`writeJsonFileViaFixedTemp` 的注释（:1109–:1112）自己写明固定名是**故意的**（崩溃恢复要按名找） |
| 混合记录可构造 | 交错：A 写 transfer(A)→owner(A)→recon(A)；B 写 transfer(B) 覆盖；A 写 marker(A) 并 `finalizePendingOwnerTransfer`（:1068）。finalize 按 `marker.finalizeOrder` 读三份 pending（:966–:987），读到的是 **transfer(B) ＋ owner(A) ＋ recon(A)** | **成立** |
| epoch 三元组通过 | 判据 4（resumeLoop.ts :52）`recon.newOwnerEpoch(N+1) === transfer.newOwnerEpoch(N+1)` ✔；判据 5（:55）`supersededByEpoch !== null`？`applyOwnerEpochTransfer` 写死 `supersededByEpoch: null`（ownerController.ts :175）✔；判据 6（:58）`ownerRecord.currentOwnerEpoch(N+1) === transfer.newOwnerEpoch(N+1)` ✔ | **成立** |
| 「证据记录会对转移原因撒谎」 | 三份记录被同一次 finalize 一起 rename 发布，但 owner-record 说新 owner 是 **A**（`currentProcessInstanceId`），owner-transfer 说新 owner 是 **B**（`newProcessInstanceId`），reconciliation 的 `staleSuspicionBasis` / `takeoverPermission` / `lastTrustedBoundary` 全部来自 **A** 的判断而 transfer 的 `reason` / `transferredAt` 来自 **B** | **成立，且比原文更强** |

**比原文更强的一点（原文没写）**：八条判据里**没有任何一条**比较 `ownerRecord.currentProcessInstanceId` 与 `ownerTransfer.newProcessInstanceId`（上面 `grep -cF 'return { ok: false'` 输出 8 行，逐条读过，无此判据）。所以「owner-record 说是 A、transfer 说是 B」这个自相矛盾的三元组**不但通过 epoch 三元组，而且通过全部八条**，`resumeLoop` 会照常 `resume_adopted`。

**论据是否腐坏**（逐句核）

| 原文论据句 | 今天 | 判定 |
|---|---|---|
| 「`tryRecoverStaleOwnerTransferLock` 在 `JSON.parse(lockContents)` 抛**且** `hasStagedArtifacts` 为真时，才删锁返回 true」 | 与 :794–:813 逐字一致 | **成立** |
| 前提一：`open(...,"wx")` 与 `handle.writeFile` 之间零长度 | :821 与 :824 之间，中间只隔一个 `try {` | **成立** |
| 前提二：catch 还要求 `hasStagedArtifacts` | :802–:809 | **成立** |
| 「实测 exit 0，命中 2 行：`src/persistence/fileStore.ts:542` 定义、`:547` 使用」 | **命中条数仍是 2，符号仍是「定义 ＋ 使用」**；行号今天是 :802 / :807 | **结论成立；行号腐坏**（+260 行）。按指示以条数与符号为准 —— 两者都对上。 |
| 判定是 `transactionMarkerPath \|\| ownerPendingPath \|\| transferPendingPath` | :803–:805 逐字一致 | **成立** |
| 「`.reconciliation-record.pending.json` 不在其中」 | `reconciliationPendingPath` 在 `getOwnerTransferPaths` 里存在（:579），但 :781 的解构**根本不取它** | **成立**，且今天的代码形状使这一点更明显 |
| 「今天由 epoch 不等挡住」 | **不可核**。这句描述的是 **L3 合入前**的代码状态（reconciliation 当时不在事务内），而 L3 已在 main 上。我在今天的 main 上无法证实也无法证伪它。 | **不可核，原样上报** |
| 「本层之后 ... epoch 三元组会通过 ... reconciliation 来自 A、transfer 来自 B」 | 上表逐环节全部成立 | **成立** |
| 「不在本层修，因为修它要动锁协议本身」 | 代码上确实如此：catch 分支缺的是活进程检查，补它就是改锁协议 | **成立** |
| plan :323「它今天只看 marker / ownerPending / transferPending 三个路径」 | 与 :803–:805 一致 | **成立** |

**后果分级：数据丢失。**

据以分级的证据：被发布的那份三元组**内部互相矛盾却通过全部八条判据**（`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` → 8，逐条无进程身份比较），于是 `resumeLoop` 会带着一份「owner-record 归 A、transfer 归 B」的证据记录 `resume_adopted`。同时 A、B 两个进程都认为自己拿到了锁、都跑完了自己的 `finalizePendingOwnerTransfer`，后跑完的那个的三次 rename 会**覆盖**先跑完的那个已发布的记录 —— 输掉的那一份转移证据在盘上不留任何痕迹。这不是可重试的拒绝，也不是告警噪音：它是一次**静默的、已发布的、被下游当真的错误证据**。

**次生后果（同一根因，级别较低，一并记）**：B 夺锁成功后进 `writeOwnerTransferArtifacts` → `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })`（:1039）→ 若此刻 marker 还不存在（:1010），走 `cleanupOwnerTransferStagingWithoutMarker`（:1012），**把 A 正在暂存的 pending 全删掉**（:873–:882 共 10 个 `safeUnlink`）。A 随后的 finalize 命中 §4.4 规则 2 的 `OwnerTransferPendingMissingError`（实测在 :976）。级别：**假告警 ＋ 可重试拒绝**。

**归属是否需要重裁**

原文**没有**明写需要重裁。第 1 笔的措辞是「**这是先于本层的缺陷，但 §4 扩大了它的影响面，故在此具名**」—— 与第 3 笔那句「*本轮新发现，需要一次归属裁决*」形成明确对照：作者在同一节里对两笔用了**不同**的措辞，说明第 1 笔的归属被认为已经清楚（先于本层的缺陷，交 L5 的锁协议整改）。

**我不确定的地方**

- **「今天由 epoch 不等挡住」我核不了**（见上表）。要核它必须 checkout L3 合入前的提交并重读当时的 reconciliation 写入路径。我没有做，因为铁律 1 说只读、且这超出「到今天 main 上验证」的范围。**若 L5 需要知道「§4 到底扩大了多少影响面」，这一句必须由人补一次历史比对。**
- **`recoverInterruptedOwnerTransfer` :1017 那条夺锁路径我只做了静态阅读，没有构造。** 它与 :851 那条不同：`!lockHeld` ＋ marker 存在 ＋ 锁存在，`tryRecoverStaleOwnerTransferLock` 返回 true 之后**不重新 open 锁**，直接 `finalizePendingOwnerTransfer`（:1021）—— 即**完全不持锁地 finalize**。这看起来是第三条更短的路，但我没有把它推到底，**记为未完成**。
- 我**没有**核 §13 第 1 笔提到的两条 `grep` 命令之外的部分（例如 `cleanupOwnerTransferStagingWithoutMarker` 今天是不是 10 个 `safeUnlink`）。那属于别的扫描员的切片，我只在次生后果里引用了行区间 :873–:882，**没有数**。

---

### 项 C：§13 具名清单第 2 笔 —— execute 相位 abort 后无第二重超时上界

**原文出处**

§13 清单那一笔本身只有一句（今天在 :2414，逐字）：

> 2. **execute 相位 abort 后无第二重超时上界**（§5.4 的 ⚠️）。

按任务要求去 §5.4 找到它指向的 ⚠️ 并逐字引用（今天在 :1364–:1370）：

> ⚠️ **停机粒度的界是「adapter 协作式」，不是无条件有界**（评审更正）。检查点是 **per-attempt** 边界。而 execute 相位用 `{ awaitAbortedResult: true }`，超时后 `abort()` 再 `await operationPromise` **没有第二重上界**；adapter 的 `onAbort` 只发 `SIGTERM`，无 SIGKILL 升级。一个不响应 SIGTERM 的子进程会让 attempt 无限期挂住。`createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程也完全无超时。**诚实的界是**：`planTimeoutMs + verifyTimeoutMs + (execute：adapter 协作则有界，否则无界) + 无超时的 git`。
>
> ⚠️ **因此必须留逃生口**（否则装了处理器反而让 sweep 杀不掉，因为默认处置被移除了）：**第二次收到停机信号立即 `process.exit(130)`**。
>
> …
>
> 本层不修 execute 的超时升级——那是行为变更，属独立任务，本层只记录。

§14 第 3 条（今天在 :2447，逐字）：

> 3. **execute abort 的 SIGKILL 升级**：独立任务，独立评审。

**今天的落点（符号锚点）**

- `runPhaseWithTimeout` in `src/controller/runLoop.ts`（今天在 :394）；`awaitAbortedResult` 分支在 :448（不等待）与 :453–:460（等待）。
- execute 相位唯一使用 `{ awaitAbortedResult: true }` 的调用点 in `runLoopFromState`（今天在 :1192–:1196）。
- `onAbort` in `src/runtime/claude/subprocessClaudeAdapter.ts`（今天在 :48），`child.kill("SIGTERM")` 在 :49。
- `createAttemptWorkspace` / `cleanupAttemptWorkspace` in `src/workspace/worktreeManager.ts`（今天在 :17 / :29），两处 `execFileAsync("git", …)` 在 :25 / :30。
- 逃生口 `registerStopHandlers` in `src/cli.ts`（今天在 :170），`exit(130)` 在 :179。

**重推命令与当时输出**

```
$ grep -rnF 'awaitAbortedResult' src/
src/controller/runLoop.ts:397:  options?: { awaitAbortedResult?: boolean },
src/controller/runLoop.ts:448:      if (!options?.awaitAbortedResult) {
src/controller/runLoop.ts:1195:        { awaitAbortedResult: true },
EXIT=0

$ grep -rn 'SIGKILL' src/
src/sweep/sweepRuns.ts:193:        // SIGKILLed at run 40, a buffer dies with the process and cron's "any stderr is an alert"
EXIT=0

$ grep -rn 'kill(' src/
src/runtime/claude/subprocessClaudeAdapter.ts:49:      child.kill("SIGTERM");
src/persistence/fileStore.ts:768:    process.kill(pid, 0);
EXIT=0

$ grep -rn 'execFileAsync(' src/
src/workspace/worktreeManager.ts:25:  await execFileAsync("git", ["worktree", "add", "--detach", worktreePath], { cwd: repoPath });
src/workspace/worktreeManager.ts:30:  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
src/controller/runLoop.ts:169:      const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
src/controller/runLoop.ts:499:    const { stdout } = await execFileAsync(
EXIT=0

$ grep -rn 'timeout' src/workspace/worktreeManager.ts src/runtime/claude/subprocessClaudeAdapter.ts
EXIT=1

$ grep -rn 'abortSignal' src/runtime/
src/runtime/claude/subprocessClaudeAdapter.ts:16:  abortSignal?: AbortSignal,
src/runtime/claude/subprocessClaudeAdapter.ts:35:      abortSignal?.removeEventListener("abort", onAbort);
src/runtime/claude/subprocessClaudeAdapter.ts:52:    if (abortSignal) {
src/runtime/claude/subprocessClaudeAdapter.ts:53:      if (abortSignal.aborted) {
src/runtime/claude/subprocessClaudeAdapter.ts:56:        abortSignal.addEventListener("abort", onAbort, { once: true });
src/runtime/claude/subprocessClaudeAdapter.ts:106:      context.abortSignal,
src/runtime/claude/subprocessClaudeAdapter.ts:122:        context.abortSignal,
src/runtime/claude/subprocessClaudeAdapter.ts:125:      if (context.abortSignal?.aborted) {
src/runtime/types.ts:10:  abortSignal?: AbortSignal;
```

`src/runtime/scriptedAdapter.ts` 在最后一条输出里**一次都没出现** —— 即两个出厂 adapter（`--adapter <scripted|claude>`）中的 scripted 那个**完全不读 `abortSignal`**。

**「第二重上界」缺的到底是什么**（`runPhaseWithTimeout` 超时分支，今天在 :448–:460，逐字）：

```ts
      if (!options?.awaitAbortedResult) {
        void operationPromise.catch(() => undefined);
        return { timedOut: true, elapsedMs: Math.max(elapsedMs, timeoutMs) };
      }

      try {
        const result = await operationPromise;
        const timedOutElapsedMs = Math.max(Date.now() - startedAtMs, timeoutMs);
        return { timedOut: true, elapsedMs: timedOutElapsedMs, result };
      } catch (error) {
        const timedOutElapsedMs = Math.max(Date.now() - startedAtMs, timeoutMs);
        return { timedOut: true, elapsedMs: timedOutElapsedMs, abortedError: error };
      }
```

第一重上界是 :412–:420 的 `Promise.race`（timer 在 :415）。plan / verify 走 :448 那条 —— 超时即弃、把 operation promise 孤儿化，**有界**。execute 走 :453 那条 —— `await operationPromise` **外面没有第二个 `setTimeout`、没有第二个 race、没有第二个 AbortController**。缺的就是这个：**一个套在 :454 那次 `await` 外面的、独立于 adapter 是否协作的硬上界。**

**今天是否可达 —— 可达，给构造**

构造一（用出厂的 claude adapter）：`--adapter claude`，把 `command` 指向一个忽略 SIGTERM 的可执行文件（`trap '' TERM; sleep infinity`）。execute 超时 → :416 `abortController.abort()` → `onAbort`（adapter :48）→ `child.kill("SIGTERM")`（:49）被子进程忽略 → `child.on("close")`（:72）永不触发 → 该 `new Promise` 永不 settle → :454 的 `await` **永久挂起**。

构造二（用出厂的 scripted adapter）：`--adapter scripted`，其 `execute` 返回一个永不 settle 的 promise 即可 —— 它根本不读 `abortSignal`（见上面 `grep -rn 'abortSignal' src/runtime/` 的输出里没有 `scriptedAdapter.ts`），所以 `abort()` 对它是**空操作**，连 SIGTERM 都发不出去。**构造二说明：即使把 SIGKILL 升级补上，这条路径依然可达。**

挂住之后的状态：心跳的 `setInterval`（`src/controller/leaseHeartbeat.ts` :228，周期 `LEASE_HEARTBEAT_INTERVAL_MS`）继续 affirm → 租约永远新鲜 → 其它进程的 `checkRunLease` 永远拒绝 → 该 run 对整个系统冻结。唯一出口是 `src/cli.ts` 的 `registerStopHandlers`（:170）里第二次信号触发的 `exit(130)`（:179） —— 那是**杀掉整个 sweep 进程**，不是让这一个 attempt 收敛。

**它与 §14 第 3 条是不是同一件事 —— 不是，§14 第 3 条是严格子集。**

§5.4 的 ⚠️ 一句话里点了**三个**互相独立的缺口：

1. `await operationPromise`（:454）外无第二重上界 —— 与 adapter 无关，是控制器侧的结构缺失。
2. adapter 的 `onAbort` 只发 SIGTERM、无 SIGKILL 升级（adapter :49；`grep -rn 'SIGKILL' src/` 全仓库只有 `sweepRuns.ts:193` 一条**注释**，无实现）。
3. `createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程**完全无超时**（`worktreeManager.ts` :25 / :30 的 `execFileAsync` 无 `timeout` 选项；`grep -rn 'timeout' src/workspace/worktreeManager.ts` 退出码 1 = 零命中），且它们**根本不在任何 `runPhaseWithTimeout` 里**。

§14 第 3 条「execute abort 的 SIGKILL 升级」只覆盖第 2 个。**写明给 L5**：把 §14 第 3 条做完，第 1、3 两个缺口原样留着，而构造二证明**只补第 2 个不足以关闭第 2 笔**。两者**不是同一件事**，第 2 笔不得因 §14 第 3 条被立项而勾销。

**论据是否腐坏**（逐句核）

| 原文论据句 | 今天 | 判定 |
|---|---|---|
| 「execute 相位用 `{ awaitAbortedResult: true }`」 | :1195，且是 `src/` 内唯一的 `true` | **成立** |
| 「超时后 `abort()` 再 `await operationPromise` 没有第二重上界」 | :453–:460 逐字核，无任何第二计时器 | **成立** |
| 「adapter 的 `onAbort` 只发 SIGTERM，无 SIGKILL 升级」 | adapter :48–:50；全仓库 SIGKILL 零实现 | **成立** |
| 「一个不响应 SIGTERM 的子进程会让 attempt 无限期挂住」 | 构造一 | **成立** |
| 「`createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程也完全无超时」 | `worktreeManager.ts` :25/:30，无 `timeout` 选项 | **成立** |
| 「诚实的界是 `planTimeoutMs + verifyTimeoutMs + (execute：…) + 无超时的 git`」 | 与上四条一致 | **成立** |
| §5.3 的「今天不可达；在 §5.3 要防御的并发 `stop()` 场景下才变活」 | 那句话说的是 `RunHeartbeatStoppedError` 抢占，**不是**本笔的挂起 | **不适用本笔，勿混** |

**本笔的论据一条都没腐坏** —— 三个缺口今天原样成立，连行号腐坏都只是位移，没有一条论据在今天的代码上落空。

**后果分级：仅可操作性。**

据以分级的证据：挂起不写任何文件（:454 之后的 `persistTerminalState` / `writeAttemptArtifacts` 全都还没跑到），盘上状态停在 execute 之前那次 `writeRunState`（:1139）写下的**非终态**，`RESUMABLE_STATUSES` 含 `executing`（`resumeLoop.ts` :38），所以进程一旦被杀、租约 TTL 一过，run 仍然可被下一次 sweep 捡起。**没有数据丢失、没有错误证据、没有终态。** 代价是这个 sweep 进程连同它的配额被一个 attempt 无限期占住，且租约新鲜使别人也接不走 —— 纯粹的活性/可操作性问题。

**归属是否需要重裁**

原文**没有**明写需要重裁。§13 第 2 笔只指向 §5.4 的 ⚠️；§5.4 自己写「本层不修 execute 的超时升级——那是行为变更，属独立任务，本层只记录」；§14 第 3 条把其中一个缺口立为「独立任务，独立评审」。**「独立评审」不等于「重裁归属」**，我不替它升级措辞。

**我不确定的地方**

- 我**没有**跑任何测试或真实构造 —— 铁律 1 是只读，两条构造是从代码读出来的路径，不是实测的挂起。**若 L5 要把它当承重前提，需要一次真实构造。**
- 我**没有**核 `src/controller/runLoop.ts` :169（required checks 的 `execFileAsync("sh", ...)`）是否构成第四个缺口。它带 `signal: abortSignal`（:171），且 verify 相位走的是 :448 那条**不等待**分支，所以直觉上不挂住调用方 —— 但**这只是直觉，我没有推到底，记为未完成**。§5.4 的 ⚠️ 也没提它。

---

### 我发现的、原文没写的东西

1. **八条判据里没有任何一条比较进程身份。** 项 B 的混合记录里 owner-record 说新 owner 是 A、owner-transfer 说是 B，这份自相矛盾的三元组**通过全部八条**，不只是通过 epoch 三元组。原文只说「epoch 三元组会通过」，没说全八条都拦不住。证据：`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` → 8，八条逐条读过（输出在项 B 内），无 `currentProcessInstanceId` / `newProcessInstanceId` 比较。

2. **夺锁的次生后果原文没写：B 会删掉 A 正在暂存的 pending。** `writeOwnerTransferArtifacts`（fileStore.ts :1039）一进来就跑 `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })`，marker 尚不存在时走 `cleanupOwnerTransferStagingWithoutMarker`（:1012），把固定名的 pending 全删。A 的 finalize 随后命中规则 2 的 `OwnerTransferPendingMissingError`（实测在 :976）。§15 验收 2 那条「规则 2 可达」给的是**另一条**路径（`pathExists(lockPath)` 短路），**这是第三条**。

3. **`recoverInterruptedOwnerTransfer` 的 :1017 分支会不持锁地 finalize。** 条件满足（`!lockHeld` ＋ marker 存在 ＋ 锁存在 ＋ `tryRecoverStaleOwnerTransferLock` 返回 true）后，它**不重新 `open` 锁**就直接 `finalizePendingOwnerTransfer(runDir)`（:1021）。§13 第 1 笔只讲了 `acquireOwnerTransferLock` 那条入口。**我只做了静态阅读，没推到底，见项 B 的「我不确定的地方」。**

4. **项 C 的构造二说明「补 SIGKILL 升级」不足以关闭第 2 笔。** `src/runtime/scriptedAdapter.ts` 完全不读 `abortSignal`（`grep -rn 'abortSignal' src/runtime/` 的输出里它一次都没出现），所以 `abort()` 对它是空操作 —— 连信号都发不出去，SIGKILL 升级无从生效。§14 第 3 条与 §13 第 2 笔的子集关系因此不是措辞问题，是可构造的。

5. **`observeChangedPathsBestEffort` 落在 abort 之后、无超时、无 abort 信号。** 它 in `src/controller/runLoop.ts`（:497），`execFileAsync("git", ["status", ...], { cwd, maxBuffer })`（:499）—— 无 `timeout`、无 `signal`。它的调用点（:1206）恰好在 execute 超时且无结果那条路径上，即**项 C 那个已经失去上界的路径上再挂一段无上界的 git**。§5.4 的 ⚠️ 只点了 `createAttemptWorkspace` / `cleanupAttemptWorkspace` 两个 git 子进程，**没点这个第三个**。

6. **spec §15 验收 5 里那份「八条判据依次在 `:42 :45 :48 :51 :54 :57 :60 :63`」的行号清单今天整体偏 1**（实测 `:44 :47 :50 :53 :56 :59 :62 :65` 是 `return` 行，`if` 行是 `:43 :46 :49 :52 :55 :58 :61 :64`）。条数 8 与八条的**内容顺序**逐条对得上。这属于别的扫描员的切片，我只是因为项 B 要引用其中三条而撞到，**原样记录，不改判据**。

---

### 对其它扫描员交叉校验输入的核对

**输入 1：`.stop()` 生产调用点恰好 2 个（3 处命中里 1 处是注释），都在 `finally` 内。** 我独立重跑并核实 —— **一致，无冲突**：

```
$ grep -rnF 'heartbeat.stop()' src/
src/cli.ts:169:// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
src/controller/resumeLoop.ts:215:    await heartbeat.stop();
src/controller/runLoop.ts:989:    await heartbeat.stop();
EXIT=0

$ grep -rcF 'heartbeat.stop()' src/controller/runLoop.ts src/controller/resumeLoop.ts
src/controller/runLoop.ts:1
src/controller/resumeLoop.ts:1
```

两处均在 `finally` 内，逐字确认：`runLoop` 的在 `try { return await runLoopFromState(...) } finally { await heartbeat.stop(); }`（:985–:990）；`resumeLoop` 的在 `} finally {`（:213）之后的 :215。

**与我项 A 的计数不混**：`heartbeat.stop()` 是 2 个生产调用点；`persistTerminalState` 是 15 个调用点、其中 4 个由 lease-loss 到达。两个数字属于两个不同符号，本报告未在任何一处交叉引用它们。

**输入 2：spec 行号锚点整体腐坏（`:720/:729/:769` → `:1122/:1131/:1171`）。** 与我的观察一致 —— 我在 `src/persistence/fileStore.ts` 上实测到 `updateOwnerRecordWithPrecondition` 今天在 :1122、`releaseOwnerLease` 今天在 :1171，与该扫描员给的一致。**我按指示把「结论腐坏」与「论据腐坏」分开写**：项 A 的「十五个中的四个」**结论未腐坏**（15 与 4 都实测吻合，并由 `git log -S` 钉住最后一次变数在 L1 期），腐坏的只有 §5.3 若干条 grep 的行号与一处命中条数（3 → 4）。

**输入 3：L3 的具名 fail-closed 抛出今天是三条不是文档写的两条。** **与我的观察一致，且我这边能补一条独立证据**：`finalizePendingOwnerTransfer` in `src/persistence/fileStore.ts`（:931）今天有三条 fail-closed 抛出 —— `OwnerTransferMarkerUnreadableError`（规则 3）、`OwnerTransferMarkerFinalizeOrderInvalidError`（`isValidFinalizeOrder` 不通过）、`OwnerTransferPendingMissingError`（规则 2）。实测：

```
$ grep -n 'throw new OwnerTransfer' src/persistence/fileStore.ts
852:        throw new OwnerTransferLockBusyError("owner transfer already in progress");
857:  throw new OwnerTransferLockBusyError("owner transfer already in progress");
940:    throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker could not be read or parsed");
949:    throw new OwnerTransferMarkerFinalizeOrderInvalidError(
976:        throw new OwnerTransferPendingMissingError(
1043:      throw new OwnerTransferPreconditionError("persisted owner record changed before owner transfer could be applied");
1086:      throw new OwnerTransferPreconditionError("persisted owner record changed before resume could claim it");
1135:      throw new OwnerTransferPreconditionError(mismatchMessage);
```

三条今天在 :940 / :949 / :976，全部落在 `finalizePendingOwnerTransfer`（:931）内。而 §13 第 3 笔的文字只写「规则 2 / 3 两条新的具名抛出」。**无冲突，我这条是佐证不是反证。** 该笔本身不属我的切片，我不对它作判定。
