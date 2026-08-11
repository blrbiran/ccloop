# 包 2 整分支评审 —— Lane 1 报告（生产代码面）

## 0. 结论（最先填）

**1 条 Critical、4 条 Important、1 条 Minor。任务级评审全绿确实没能替代整分支评审 ——
我找到的六条里，有四条在结构上任何单任务评审都看不见。**

**最重要的一条（C-1）不是「缺判据」，是一个承重前提为假。** 第 4 笔（D2）把输家的
「读 → 判定 → 写」整段放进跨进程 `.owner-transfer.lock`，其顺序无关性建立在
「转移锁不可被偷」之上；源码注释把它写成 "Two lock spans cannot interleave"。
我实测证伪了它：`acquireOwnerTransferLock` 分两步发布锁，锁文件对**别的进程**存在一个
**0 字节窗口**（跨进程实测到 `lockSizes: [0,88]`，带必命中锚点），
而 `tryRecoverStaleOwnerTransferLock` 在解析失败的分支里**从不检查持有者死活**，
只要有 staged artifacts 就删锁放行（实测 `PROBE A: STOLEN`，原锁文件消失；
必落空对照 B/C 均正确拒绝）。⇒ 两个 lock span **能**交错，第 4 笔要排除的第三种交错回来了。
**这同时使第 4 笔「降级不是关闭」的既有结论本身失效**，因此按 brief 分级口径两头都够 Critical。

**其余四条 Important 有一个共同形状 —— 也正是 brief §4 点名的第一个根因：
「一个没有执行机制的完整性断言」。它在四笔叠加后又复现了四次：**
- **I-1**：所有权守卫对 `exhausted` / `blocked_waiting_human` / `succeeded` 三种终态**一条判据都没有**
  （实测：改成直写 `writeFile`，524 条全绿）。这三种全都不可 resume，正是债 2 的损害形状。
- **I-2**：D-1 结构判据只解析 `runLoop.ts` **一个文件**；#9 动态 import、#10 第三模块全绿通过，
  连**往 `src/` 新增一个模块**都无人出声；**并且既有枚举漏了第四条形状 —— `resumeLoop.ts` 根本不在判据视野内**。
- **I-3**：两个重试上限的「第 3 次」无判据（转移侧 3→2 全绿、reconciliation 侧 3→1 全绿），
  且两条耗尽判据写的是 `expect(x).toBe(THE_CONSTANT_ITSELF)` —— **业务量改变时永不变红**，Rule 9 明禁。
- **I-4**：`resumeLoop` 的五路 `Promise.all` 与它自己触发的崩溃恢复赛跑，
  事务提交窗口内崩溃的 run **首次 resume 必被误拒且归因错误**（实测，第二次自愈）。

**我推翻了 brief 里三条既有说法，推翻同样是交付：**
1. 「#7 直写仍敞开」——**说法过强**。结构判据确实失明，但行为判据在它们覆盖的写点上**能**红（M1 红 7 条）。
   真正的缺口在覆盖边缘的三种终态（I-1），这是我实测出来的、既有说法没提的。
2. 「今天能把重试次数从 3 改成 1 而全套件仍全绿」——**为假**。3→1 会红 2 条绝对值断言。
   真实缺口是「钉住了下限 2，钉不住 3」（M4/M5）。
3. 「`readReconciliationRecord` 无守卫且直通 `Promise.all`，会在真实轨迹上**炸**」——**不炸**。
   外层有 try/catch，是失败关闭。真实缺陷是归因错误 + 与恢复赛跑的误拒（I-4）。

**给控制器的三句话**：
- **本轮建议只修两条**：M-1（加一行注释，零风险）与 I-4（把 `readOwnerRecord` 提出 `Promise.all` 先 await，
  但**属行为改动，先问人**）。
- **C-1、I-1、I-2、I-3 都不建议本轮修**：C-1 动的是全仓最危险的原语、需要独立设计与人裁；
  I-1/I-2/I-3 的修法都要**新增或修改判据**，而本轮无改判据授权（人裁 13/14/17/37 各自具名，均不覆盖它们）。
  ⇒ **第五个例外必须问人，我不替人裁。**
- **必须现在就做的是记账**：把第 4 笔「顺序无关性以锁不可被偷为前提」的表述，
  更正为「该前提已被实测证伪」，并相应标注 §19.2 与人裁 37 一线的结论。

**基线诚实声明**：我自己的基线是 **523/524 + 1 条允许的 flake (B)**，不是 524/524；
人裁 10 那条在我 6 次全套件跑里一次都没红，我按挂账处理，**不当作它已消失**。

## 1. 我自己的基线（重跑结果，未过滤）

工作区：`/Users/biran/code/skills/loop/ccloop/.worktrees/wb-lane1`，detached HEAD = `fc07c20`。

**先核了「我的基点与控制器基点在代码面同一」**，而不是继承 brief 的绿：

```
git diff --stat fc07c20 bfb366a -- src tests   →  空输出（0 文件）
```

即 `fc07c20` 与控制器基线 `bfb366a` 在 `src/`、`tests/` 上逐字节相同，两者差异全在 `.superpowers/`、`docs/`。
`git diff --numstat e42e062 fc07c20` 亲跑确认了 brief §1 那 9 个代码文件与行数（`ownedRunStateWriter.ts` 170/0、
`resumeLoop.ts` 55/2、`runLoop.ts` 55/18、`fileStore.ts` 134/16，测试四个文件 + 新增结构测试 125/0）。

变异前的干净证明：`git status --porcelain` 只有一行 `?? .superpowers/sdd/.../wholebranch-lane1-report.md`
（就是本报告文件本身），`src/`、`tests/` 无任何未提交改动。

**我自己的全套件基线跑**（`ECC_GATEGUARD=off DISABLE_OMC=1`，`rtk proxy npm test -- --run`，
输出整份落盘 `runs/baseline.txt`，未过滤、整份读回）：

```
 Test Files  1 failed | 30 passed (31)
      Tests  1 failed | 523 passed (524)
   Duration  22.86s
TEST_EXIT=1
```

唯一一条红：

```
FAIL tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid
Error: Test timed out in 5000ms.
```

按完整测试名比对，这**恰是 brief §5 允许的 flake (B)**，不是新缺陷。人裁 10 那条
（`persists phase usage evidence from the subprocess adapter without recomputing controller totals`）本轮为绿（见 runs/baseline.txt 该行 ✓）。

⚠️ 因此**我的基线是 523/524 + 1 条已知 flake，不是 524/524**。后续每一次变异跑都以「除 flake (B) 外全绿」为对照，
且我在每次变异跑里都逐条比对失败测试全名，不靠计数。

## 2. 五个跨笔面的逐条判断

### 2.1 D-1 结构性保证是否仍敞开三条路

**我的判断：三条路都实测敞开，但「敞开」的含义要比既有说法更精确 —— 而且我在这一面找到了既有说法没说的那半句。**

先说我推翻的那半句。我第一次的变异（M1）是**整体**绕过：把 `runLoopFromState` 里的
`createOwnedRunStateWriter()` 换成一个直写 `writeFile(join(dir,"loop-state.json"), …)` 的闭包，
即 D-1 枚举的 #7 形状，覆盖 `runLoop.ts` 全部 11 处守卫写。结果**不是全绿**：

```
TSC_EXIT=0
Test Files  2 failed | 29 passed (31)
     Tests  7 failed | 517 passed (524)
```

7 条红全部来自行为判据（`refuses to write a terminal status into a run a different, current owner
already holds …`、`refuses to write a terminal failed status …`、`refuses to write the terminal
failed status of a retry-cleanup failure …`、`records ownership_unverified and still writes …`、
两条 `…another controller already completed the transfer`、以及 `releases the lease when the loop throws`）。
`ownedRunStateWriter.structure.test.ts` 本身**保持绿**（它对 #7 结构性失明，符合它自己写下的边界）。

⇒ **所以「#7 敞开」不等于「#7 无人看守」。** 结构判据确实看不见 #7，但行为判据在**它们覆盖到的那些
写点上**看得见。既有说法只说了前半句，会让人以为整条 #7 无人把守 —— 那是过强的。

**真正的缺口在覆盖的边缘，而这是我实测出来的。** 第二次变异（M2）只把
`persistTerminalState` 里 **`exhausted` / `blocked_waiting_human` / `succeeded`** 三种终态的写
换成直写 `writeFile`，其余仍走守卫：

```
TSC_EXIT=0
Test Files  1 failed | 30 passed (31)
     Tests  1 failed | 523 passed (524)     ← 唯一那条红是允许的 flake (B)
```

**全绿。** 这三种终态**全都不在 `RESUMABLE_STATUSES = ["planning","executing","verifying"]` 里**
（`resumeLoop.ts` 的 `evaluateResumeEligibility`），即它们和 `cancelled` / `failed` 一样会让别人的 run
**不可恢复** —— 正是债 2 与 Critical F-1 存在的那个损害形状。既有的所有权判据只覆盖了
`cancelled`（lease_lost）与 `failed` 两支，**另外三支一条判据都没有**。

第三次变异（M3）同时测 #9 与 #10，且**分别挂在不同终态上以便归因**：
`exhausted` 走 `await import("../persistence/fileStore.js")` 后 `.writeRunState(…)`（#9），
`blocked_waiting_human` 走新建的第三模块 `src/controller/mutationThirdModule.ts`（#10）。

```
TSC_EXIT=0
Test Files  31 passed (31)
     Tests  524 passed (524)     ← 连 flake 都没红
```

⇒ **#9 与 #10 完全不可见**：`tsc` 0、结构判据绿、524 条全绿；而且我**往 `src/` 里新增了一个模块文件**，
全仓没有任何机制对此出声。这一条是 brief §4 第 1 个根因形状（「一个没有执行机制的完整性断言」）在
四笔叠加后的**第四次复现**。

**有没有第四条没被枚举到的形状？有，而且它比 #7/#9/#10 都便宜：**
`ownedRunStateWriter.structure.test.ts` 只解析 **`runLoop.ts` 这一个文件**（`runLoopSourcePath` 写死）。
`resumeLoop.ts` 同在控制器层、同样持有 `runDir`、也确实在写 run 状态语义（它 `claim` 后直接把
`resumedState` 交给 `runLoopFromState`），却**完全不在结构判据的视野里**；它今天没有 import
`writeRunState`，但**没有任何东西阻止它明天 import**。把这条记为 §3 的 I-2。

### 2.2 第 4 笔是「降级」不是「关闭」——转移锁不可被偷是否零判据

**我的判断：比「零判据」更糟 —— 这个前提今天是可证伪的，我把它证伪了。既有说法在方向上对，但低估了。**

既有说法是「顺序无关性以『转移锁不可被偷』为前提，而那一条今天零判据钉住」。
我没有停在「没有判据」上，因为 brief §2.2 说读代码的机械论证不算实测。我写了独立探针
（`scratchpad/lockProbe.ts`、`scratchpad/windowProbe.ts`，**只 import 已发布的模块，不改 `src/`**）。

**(1) 锁文件对别的进程是「先出现、后有内容」的两步。** `acquireOwnerTransferLock` 先
`await open(lockPath, "wx")`（此刻文件已存在且 **0 字节**），再 `await handle.writeFile(...)`。
我用**独立子进程**做旁观者实测这个窗口真实存在：

```
PROBE F acquire/release cycles performed: 8804
PROBE F watcher report: {"anchorBytes":7,"lockSizes":[0,88]}
PROBE F watcher read surface alive (anchorBytes must be 7): 7
PROBE F zero-byte lock window observed cross-process: true
```

`anchorBytes: 7` 是**必命中探针**（父进程预先写死一个 7 字节兄弟文件），证明旁观者的读面是活的 ——
这一条是必需的，因为我这个探针的**第一版是坏的**：`node -e` 下首个用户参数落在 `argv[1]` 而非 `argv[2]`，
于是每次读都抛、集合为空，输出 `[]`，看起来像「窗口不存在」。**坏探针差点让我下一个假的全称否定**，
见 §5。

**(2) 处在那个 0 字节窗口里的锁，会被抢走，且抢锁一方从不检查持有者死活。**
`tryRecoverStaleOwnerTransferLock` 读到 `""` → `JSON.parse` 抛 → 进 `catch`，
而 `catch` 分支**只看有没有 staged artifacts，永远不调用 `isProcessActive`**；有就 `safeUnlink(lockPath)` 并返回 true。实测：

```
PROBE D (no lock file at all):            CLAIM_SUCCEEDED   ← 必命中，证明探针能说“成功”
PROBE C (live-pid lock + staged pending): REFUSED OwnerTransferLockBusyError   ← 活 pid 判据有效
PROBE B (empty lock, no staged artifacts):REFUSED OwnerTransferLockBusyError   ← staged 判据有效
PROBE A (empty lock + staged pending):    CLAIM_SUCCEEDED (lock was taken -> STOLEN)
PROBE A  original lock file after the call: absent
```

B 与 C 是**必落空探针**：它们证明我的探针不是「怎么都能抢到」。只有 A 这一格抢到了，
并且原持有者的锁文件**已被删除**。

**(3) 释放端不认自己的锁。** `acquireOwnerTransferLock` 返回的 `release` 是
`handle.close()` + `safeUnlink(lockPath)` —— **不校验将删的锁文件是不是自己那一把**。
于是 A 被抢之后，原持有者的 `release` 会把**小偷的锁**一并删掉。

**锁被偷之后四笔叠加的行为是什么（可构造场景）：**
一个 run 因上一次转移被中断而残留 `.owner-transfer.transaction.json`（或任一 `.＊.pending.json`）。
进程 P1 进入 `publishReconciliationUnderTransferLock` 取锁，正处在 open→writeFile 的 0 字节窗口；
进程 P2 同时进入 `writeOwnerTransferArtifacts` 取锁 → EEXIST → 读到 `""` → 抢锁成功。
此刻 **P1 与 P2 同时身处「读 → 判定 → 写」临界区**，第 4 笔（D2）用来排除的**正是这第三种交错**：
P1 基于转移前的观测做判定、在 P2 的 rename #3 之后落盘，把赢家已发布的
`eligibleForContinuation: true` 记录**覆盖成输家的降级**。这就是包 2 那条数据丢失本身。

⇒ 对 brief 的问题正面回答：**这个前提不是「无判据」，是「假」**。
它在源码里被当作承重命题写在 `publishReconciliationUnderTransferLock` 的注释里
（「Two lock spans cannot interleave」），而两个 lock span **能**交错。
注释自己留了半句「a lock this process can have stolen from it
(tryRecoverStaleOwnerTransferLock) puts the third order back」—— 它知道有这条路，
但把它当成一种遥远的可能，而不是一个**今天可达、我已实测**的状态。

**我没能验到的那一步（诚实留白，见 §6）**：我分别实测了 (a) 0 字节窗口真实存在、
(b) 处于该状态的锁会被抢走，但**没有在同一次运行里让「窗口」与「争用者」真正撞上**。
两段之间的合成是机械的，不是我测出来的。

### 2.3 四个具名例外（人裁 13 / 14 / 17 / 37）是否只在具名范围内被使用

**我的判断：14 / 17 / 37 都在使用点就地申报且范围可核，17 的范围声明我实测为真；13 是唯一没有源码锚点的那个。**

同一次检索里带必命中探针（14/17/37 命中，证明检索面是活的）：

```
tests/controller/runLoop.integration.test.ts:3181  // …human ruling 14. persistTerminalState's ownership guard reads
tests/controller/runLoop.integration.test.ts:3325  // …human ruling 14 — same mechanism as the sibling test above:
tests/controller/leaseLifecycle.integration.test.ts:50   // …human ruling 17. The owner ids below are THIS process's…
tests/controller/leaseLifecycle.integration.test.ts:520  // ⚠️ Amended by package 2 / §13 4th entry (D2), under human ruling 37, and amended ONLY here:
```

**人裁 17 的范围声明我做了独立核对，不接受它自证。** 它声称「`resumeLoop.integration.test.ts` 与
`cli.test.ts` 里的同名 helper 刻意不改」。实测：

```
tests/controller/resumeLoop.integration.test.ts:56  currentProcessInstanceId: "pid:100", …
tests/controller/resumeLoop.integration.test.ts:61  newProcessInstanceId: "pid:100", …
tests/cli/cli.test.ts:235                           currentProcessInstanceId: "pid:100", …
tests/cli/cli.test.ts:240                           newProcessInstanceId: "pid:100", …
```

两处仍是外来 id ⇒ **17 的范围声明为真，未被外推。**

**人裁 37**（`leaseLifecycle.integration.test.ts:520` 起）是一处**削弱既有判据**的修改：删掉了
`expect(reconciliation.newOwnerEpoch).toBeNull()` 与
`expect(reconciliation.eligibleForContinuation).toBe(false)`。但它**申报了**：写明是 amendment 而非 deletion，
写明测试名所指的两条（事件被追加、转移被放弃）未动，并用「文件缺席 + 拒绝上了事件」两条观测顶上。
⇒ 我判定**这不是未申报的削弱**。

**人裁 13 是缺口。** 在 `src/` 与 `tests/` 全面检索 `ruling 13` **零命中**（同一次检索 14/17/37 命中，
检索面已证为活）。而台账 `progress.md:1133-1134` 记载 13 的例外**确实被用掉了**
（实施者按授权改了 `runLoop.integration.test.ts` 里那条测试的名字）。
⇒ **四个例外里只有 13 在使用点没有留下任何源码锚点**，与其余三个的做法不一致。
今天读那条测试的人无法从代码里得知它曾在一次具名扩权下被改过。记为 §3 的 M-1。

**「既有」的两种读法**：brief 提示本仓库对「既有」有两种口径且未消解，我**两种分别报**：
- 口径 A（= 包 2 开工前 `e42e062` 已存在的判据）：被改动的既有判据共 2 处
  （`leaseLifecycle` 的 reconciliation 两条断言，人裁 37 申报；`runLoop.integration` 那条测试的更名，人裁 13 授权），
  **两处都在授权范围内，无未申报者**。
- 口径 B（= 含包 2 自己本轮先写后改的判据）：另有第 4 笔实施过程中对自己前几轮判据的改写，
  那超出我这条车道的证据面，**我不下结论**（见 §6）。

### 2.4 `reconciliation-record.json` 缺席的处理，三处口径

**我的判断：三处口径今天仍如既有说法所述，我逐处核过；但「哪一处会炸」的既有说法需要更正 —— 它不炸，它是失败关闭 + 归因错误，而真正的缺陷是一个我实测出来的竞态。**

三处逐一核实（读源码）：

1. `readPersistedReconciliationRecord`（`fileStore.ts`）：`catch { return undefined }` —— **安全**，确认。
2. registry：`OBSERVED_FILES`（`observeFields.ts`）只有三项
   —— `loop-state.json` / `owner-record.json` / `owner-transfer.json`，**`reconciliation-record.json` 不在其中**；
   `pickReader`（`readObservedFile.ts`）对任何不在这三者中的文件 `throw new Error("no reader bound for …")`。
   ⇒ 结构上读不到它，**确认**；`sweepRuns.ts:100` 那句逐字说法也确认。
3. `readReconciliationRecord`（`fileStore.ts`）：`JSON.parse(await readFile(...))`，**完全无守卫**，
   且被 `resumeLoop.ts` 的五路 `Promise.all` 直调，**确认**。

**更正既有说法：它不会「炸」。** `resumeLoop` 的那个 `Promise.all` 外面**有** try/catch，
把任何抛出转成 `ResumeNotEligibleError("cannot read run artifacts: …")`。所以是失败关闭，不是崩溃。

**但真正的缺陷在于：同一个 `Promise.all` 里，无守卫的读与它自己触发的崩溃恢复在赛跑。**
`readOwnerRecord` 会先跑 `recoverInterruptedOwnerTransfer`（取锁、读 marker、三次 rename）；
`readReconciliationRecord` 与它**同时发起**且不等它。而事务的 `finalizeOrder` 是
`[owner-transfer.json, owner-record.json, reconciliation-record.json]` ——
**存在一个真实的崩溃缺口：owner-transfer.json 与 owner-record.json 已 rename 落地，
`reconciliation-record.json` 尚未。** 此时该 run 完全可恢复，但第一次 resume 必被拒。

可构造场景 + 实测（`scratchpad/resumeRaceProbe.ts`，只 import 已发布模块）：

```
CONTROL (fully committed run): READ_OK (resume would proceed to the eligibility gate)   ← 必命中
PROBE G first resume attempt : READ_THREW -> ResumeNotEligibleError("cannot read run artifacts: Error: ENOENT: … /reconciliation-record.json")
    readOwnerRecord (the recovering read) settled as: fulfilled
PROBE G runDir after attempt 1: loop-state.json owner-record.json owner-transfer.json reconciliation-record.json
PROBE G second resume attempt: READ_OK (resume would proceed to the eligibility gate)
```

⇒ **第一次 resume 被拒，理由归因错误**（说成「读不了 run artifacts」，实际是自己的恢复还没跑完），
恢复完成后**第二次即通过**，目录已完整提交。不是数据丢失，会自愈。定为 Important，不是 Critical。

⚠️ **这一格我自我更正过一次，写在这里而不是抹掉**：探针第一版在 `Promise.all` 拒绝后**立刻**
读目录，而 `readOwnerRecord` 那条链还在飞，于是我看到「`.owner-transfer.lock` 残留 + 第二次仍被拒」，
差点报成「泄漏锁文件 + 永久不可恢复」的 Critical。改成等 `allSettled` 后再观测，两个现象都消失 ——
**那是探针假象，不是缺陷。** 这正是 brief §2.2 说的那种「每一环都读对了、结论仍然错」。

**同族确认**：这一条与 D-1、与 Critical F-1 确属同族 —— 都是「一个在多数地方成立的假设被当成普遍成立」。
这里的假设是「跑到 `Promise.all` 时，磁盘上的四个文件互相一致」。

### 2.5 重试覆盖的同形缺口（3 → 1/2 是否全套件仍绿）

**我的判断：既有说法一半对一半错，我两个值都测了。3 → 1 会红；3 → 2 全绿。缺口是真的，但它的形状是「只钉住了下限 2，钉不住 3」。**

M4：`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3→**1** 且 `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3→**1**：

```
TSC_EXIT=0
Test Files  2 failed | 29 passed (31)
     Tests  2 failed | 522 passed (524)
```

两条红都指名转移侧、且都是**绝对值**断言：
`leaseLifecycle … retries a busy owner-transfer lock and completes once it clears (spec requirement 1)`
→ `expected 1 to be 2`（源码 `expect(writeCalls).toBe(2)`）；
`resumeLoop … retries a busy owner-transfer lock during the resume claim and completes once it clears`
→ `expected ResumeNotEligibleError … to be null`。
⇒ **「至少重试 1 次」被钉住了。既有说法「今天能把 3 改成 1 而全绿」为假，我推翻它。**

M5：`RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3→**1**，`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3→**2**：

```
TSC_EXIT=0
Test Files  31 passed (31)
     Tests  524 passed (524)
```

**全绿。** 两件事同时被证明（全绿对两个变异都可归因）：
1. **转移侧的 3 与 2 分不开** —— 判据只钉住下限 2，「第 3 次」这一次重试没有任何判据。
2. **`fileStore.ts` 的 `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 从 3 降到 1 完全无人过问** ——
   它是模块私有常量，没有任何测试引用它，也没有任何测试观测它的次数。

**机制在源码里可以看清，而且它是 brief §4 第 2 个根因形状的一个变种**：耗尽分支那两条测试写的是
`expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)`
（`resumeLoop.integration.test.ts:336`）与 `expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)`
（`leaseLifecycle.integration.test.ts:716`）—— **断言的两边都随常量一起动**，
所以这两条**在重试次数这个业务量改变时永远不会红**。这正是本仓库 Rule 9 禁止的那种测试。

⚠️ 按 brief 要求：**CAS 从不重试是既有约定，我没有把它当缺陷**；
`retries zero times on a CAS mismatch (spec requirement 3)` 在我全部五次变异里始终为绿。

## 3. Findings（Critical / Important / Minor，与处置建议分开写）

> **格式约定（brief §2.8）**：每条先写 **finding 本身**，再单独写 **处置建议**，并明说**是否应在本轮修**。
> 控制器请**不要只读 finding 就派工**。

---

### C-1（Critical）跨进程转移锁可被从**活着的**持有者手上偷走 —— 第 4 笔的承重前提为假

**锚点（符号名）**：`acquireOwnerTransferLock`、`tryRecoverStaleOwnerTransferLock`、
`publishReconciliationUnderTransferLock`（均在 `src/persistence/fileStore.ts`）。

**缺陷**：`acquireOwnerTransferLock` 分两步发布锁 —— `await open(lockPath,"wx")` 之后文件已存在但为
**0 字节**，内容要到 `await handle.writeFile(...)` 才落地。`tryRecoverStaleOwnerTransferLock` 读到这个
0 字节内容时 `JSON.parse` 抛，进入 `catch` 分支，而该分支**永不调用 `isProcessActive`** ——
它只问「有没有 staged artifacts」，有就 `safeUnlink(lockPath)` 并放行。
配套地，`release()` 是无条件 `safeUnlink(lockPath)`，**不校验将删的锁是不是自己那一把**。

**可构造场景（具体状态 → 错误终态）**：
run 目录残留一次被中断转移的 `.owner-transfer.transaction.json`（或任一 `.*.pending.json`）。
P1 进入 `publishReconciliationUnderTransferLock` 取锁，处在 0 字节窗口内；
P2 进入 `writeOwnerTransferArtifacts` 取锁 → EEXIST → 读到 `""` → 抢锁成功。
两者同时位于「读 → 判定 → 写」临界区 ⇒ 第 4 笔（D2）声称已排除的**第三种交错**复活：
P1 用转移前的观测做判定、在 P2 的 rename #3 之后落盘，
把赢家已发布的 `eligibleForContinuation: true` 记录**覆盖成输家的降级** ⇒ 该 run 不再可续。
随后 P1 的 `release()` 还会删掉 P2 的锁。

**实测证据（不是推理）**：
- 0 字节窗口，**独立子进程**旁观实测：`{"anchorBytes":7,"lockSizes":[0,88]}`，8804 次取放锁；
  `anchorBytes:7` 是必命中探针，证明旁观者读面为活。
- 该状态下锁被偷：`PROBE A … CLAIM_SUCCEEDED (lock was taken -> STOLEN)`，
  且 `original lock file after the call: absent`。
- 必落空对照：`PROBE C`（活 pid 锁 + staged）与 `PROBE B`（0 字节锁但无 staged）**均 REFUSED**，
  证明探针不是「怎么都能抢到」。必命中对照：`PROBE D`（无锁）成功。
- 探针文件：`scratchpad/lockProbe.ts`、`scratchpad/windowProbe.ts`；**均只 import 已发布模块，未改 `src/`**。

**为什么定 Critical**：它是**今天可达的正确性破坏**，且破坏的正是包 2 这条线要防的数据丢失；
同时它使第 4 笔「顺序无关」的承重论证**失效**（brief 的 Critical 第二种定义：
「一条会让评审结论本身失效的错误前提」）。源码注释把 "Two lock spans cannot interleave" 当作前提写死，
而两个 lock span **能**交错。

**处置建议（与上面分开读）**：
- **不建议在本轮修。** 这动的是全仓最危险的原语，且正确的修法（把锁内容与锁的出现变成一次原子发布，
  例如 `open(tmp,"wx")` → 写 → `link(tmp, lockPath)`；或在 `catch` 分支加入 liveness/年龄判据）
  会改变崩溃恢复的语义，属于需要自己的设计与人裁的独立任务。
- **本轮应做的是记账与更正措辞**：把第 4 笔「顺序无关性」的表述从「以锁不可被偷为前提」
  下调为「以锁不可被偷为前提，而该前提已被实测证伪」，并把 §19.2／人裁 37 一线的结论相应标注。
- ⚠️ 我**没有**据此提出方向性重构建议，也**没有**触碰待裁点 A/B/C。

---

### I-1（Important）所有权守卫对 `exhausted` / `blocked_waiting_human` / `succeeded` 三种终态**零判据**

**锚点**：`persistTerminalState`（`src/controller/runLoop.ts`）、`createOwnedRunStateWriter`
（`src/controller/ownedRunStateWriter.ts`）、`RESUMABLE_STATUSES` / `evaluateResumeEligibility`
（`src/controller/resumeLoop.ts`）。

**缺陷**：把 `persistTerminalState` 中这三种终态的写换成不经守卫的
`writeFile(join(runDir,"loop-state.json"), …)`，**全套件不红**。而这三种状态都**不在**
`RESUMABLE_STATUSES` 内，即它们与 `cancelled`/`failed` 一样会让别人的 run 不可恢复 ——
正是 Critical F-1 的损害形状。既有所有权判据只覆盖 `cancelled`（lease_lost）与 `failed` 两支。

**可构造场景**：进程 A 的 lease 已失、run 已被 B 接管（`owner-record.json` 记 B）；
A 走到预算耗尽 / 人工闸门 / 校验通过任一路径 ⇒ 若该处的写不经守卫，
A 会把 `exhausted` / `blocked_waiting_human` / `succeeded` 写进 B 的 run ⇒ B 的 run 不可再 resume。
今天生产代码**确实**走守卫，所以不是今日可达的丢失（故非 Critical）；缺的是**判据**。

**实测证据**：变异 M2，`TSC_EXIT=0`，`Tests 1 failed | 523 passed (524)`，
唯一那条红是允许的 flake (B)；`ownedRunStateWriter.structure.test.ts` 保持绿。
对照：变异 M1（同样手法但覆盖全部 11 处写点）**红 7 条**，证明我的变异面是活的、
且证明这三种终态的绿**不是因为这些路径没被执行**（M2 里
`exhausts the run when planning exceeds per-attempt timeout`、
`blocks for human input …`、`succeeds when verification approves` 均为绿=已执行）。

**处置建议**：**建议本轮修，且修的是判据不是产品代码。**
新增覆盖这三种终态的所有权拒写判据（形状照抄已有的
`refuses to write a terminal failed status into a run a different owner holds`）。
⚠️ 这需要新增 `it`，而 brief §1 说本轮无改判据授权、人裁 35（可新增 it）是另一条具名例外
—— **所以这一项要先问人**，我不建议实施者自行开工。

---

### I-2（Important）D-1 结构判据只解析 `runLoop.ts` 一个文件，#9 / #10 / 以及第四条形状全部不可见

**锚点**：`tests/controller/ownedRunStateWriter.structure.test.ts` 的
`runLoopSourcePath` / `importedNames` / `namespaceImportedModules`。

**缺陷**：三件事：
1. 动态 `await import("../persistence/fileStore.js")` 后调 `.writeRunState(...)`（#9）不可见；
2. 新建第三模块 `import { writeRunState }` 再被 `runLoop.ts` 调用（#10）不可见 ——
   连**往 `src/` 新增一个模块文件**这件事本身也无人出声；
3. **第四条、既有枚举没提到的形状**：结构判据的 `runLoopSourcePath` 写死了 `runLoop.ts`，
   而 `resumeLoop.ts` 同在控制器层、同样持有 `runDir` 与 run 状态语义，
   **完全不在判据视野内**。它今天没 import `writeRunState`，但没有任何东西阻止它明天 import。

**实测证据**：变异 M3（#9 挂 `exhausted`、#10 挂 `blocked_waiting_human`，分开归因），
`TSC_EXIT=0`，`Test Files 31 passed (31)` / `Tests 524 passed (524)`（连 flake 都没红）。

**处置建议**：**不建议本轮改判据**（同样撞上「无改判据授权」）。
建议本轮只做一件便宜且不改判据语义的事：把 `ownedRunStateWriter.ts` 里那段
"HONEST LIMIT" 注释补上第 4 条（判据只覆盖 `runLoop.ts` 一个文件），
使那段自陈边界与实际一致 —— 这是**注释与实际不符**的更正，不是新增保证。
是否要把 `resumeLoop.ts` 一并纳入解析范围，属于扩权，**要问人**。

---

### I-3（Important）两个重试上限的「第 3 次」无判据；耗尽分支的断言是自指的，业务量改变时永不变红

**锚点**：`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS`（`src/controller/runLoop.ts`）、
`RECONCILIATION_LOCK_RETRY_ATTEMPTS`（`src/persistence/fileStore.ts`）、
`claimOwnerRecordWithBoundedLockRetry`（`src/controller/resumeLoop.ts`）、
`acquireOwnerTransferLockForReconciliation`（`src/persistence/fileStore.ts`）。

**缺陷**：
(a) 转移侧上限 3→2 全套件全绿 ⇒ 判据只钉住「至少 2」，第 3 次重试无任何判据；
(b) `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3→1 全绿 ⇒ 该上限**完全无判据**（模块私有，无任何测试引用或观测）；
(c) 机制上，两条耗尽判据写的是
`expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)`（`resumeLoop.integration.test.ts:336`）
与 `expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)`（`leaseLifecycle.integration.test.ts:716`）
—— **断言两边同源**，所以它们在「重试次数」这个业务量改变时**永远不会红**（本仓库 Rule 9 明禁）。

**可构造场景**：把上限静默降到 2（或把 reconciliation 侧降到 1），
在赢家持锁做三次 rename 的窗口里，输家更早放弃 ⇒ 边界记录被放弃、
`reconciliation_write_abandoned` 增多、resume 被拒率上升。全绿，无人知晓。

**实测证据**：M4（两侧均 3→1）红 2 条、均为绝对值断言 ⇒ 下限 2 被钉住，**推翻了 brief「改成 1 仍全绿」的既有说法**；
M5（转移侧 3→2 + reconciliation 侧 3→1）`TSC_EXIT=0`、`Tests 524 passed (524)` 全绿。

**处置建议**：**不建议本轮修产品代码**（上限值本身没错，人裁 38 已批准 3 次）。
建议记账：把 (c) 那两条自指断言标注为「不能证伪重试次数」，
并在将来任何一次改重试策略的任务里**同时**要求一条绝对值判据。
本轮**不要**去改那两条既有测试 —— 那需要改判据授权。

---

### I-4（Important）`resumeLoop` 的五路 `Promise.all` 与它自己触发的崩溃恢复赛跑，事务提交窗口内崩溃的 run 首次 resume 必被误拒

**锚点**：`resumeLoop`（`src/controller/resumeLoop.ts`）的 `Promise.all`；
`readReconciliationRecord`、`readOwnerRecord` / `recoverInterruptedOwnerTransfer`、
`finalizePendingOwnerTransfer`（`src/persistence/fileStore.ts`）。

**缺陷**：`readOwnerRecord` 会先跑崩溃恢复（取锁、读 marker、三次 rename），
而**无守卫**的 `readReconciliationRecord` 与它在同一个 `Promise.all` 里**同时发起、并不等它**。
事务 `finalizeOrder = [owner-transfer.json, owner-record.json, reconciliation-record.json]`
存在真实缺口：前两个已 rename 落地、第三个尚未 ⇒ 此刻 `reconciliation-record.json` 缺席，
`readReconciliationRecord` 抛 ENOENT ⇒ 外层 catch 把它转成
`ResumeNotEligibleError("cannot read run artifacts: …")`。

**它不是崩溃、也不是数据丢失**（我据此更正了既有说法的「会炸」），
但它是**误拒 + 归因错误**：run 完全可恢复，拒绝理由却说成「读不了 run artifacts」。
sweepRuns 会为此花掉一次拒绝。

**实测证据**：`scratchpad/resumeRaceProbe.ts`（只 import 已发布模块）：
必命中对照 `CONTROL … READ_OK`；
`PROBE G first resume attempt : READ_THREW -> ResumeNotEligibleError(… ENOENT … /reconciliation-record.json)`；
恢复 settle 后目录为 `loop-state.json owner-record.json owner-transfer.json reconciliation-record.json`；
`PROBE G second resume attempt: READ_OK`（自愈）。

**处置建议**：**可以本轮修，修法极小且不动判据语义**：把 `readOwnerRecord(runDir)`
从 `Promise.all` 里提出来先 `await`（它本来就是那四个读里唯一带副作用/恢复的一个），
再并行读其余四项。这不新增保证、不改任何现有断言，且与 `readOwnerRecordWithoutRecovery`
在 leaseGate 的既有「谁做恢复」分工一致。
⚠️ 但它**改变了 resume 的读顺序**，属于行为改动 —— 我**建议先问人**再动，不要当成 trivial 修。

---

### M-1（Minor）四个具名例外里，只有人裁 13 在使用点没有留下源码锚点

**锚点**：`tests/controller/runLoop.integration.test.ts` 中被更名的那条测试；
对照 `tests/controller/runLoop.integration.test.ts:3181/3325`（ruling 14）、
`tests/controller/leaseLifecycle.integration.test.ts:50`（ruling 17）、`:520`（ruling 37）。

**缺陷**：`src/` 与 `tests/` 全面检索 `ruling 13` **零命中**（同一次检索 14/17/37 命中，检索面已证为活），
而台账 `progress.md:1133-1134` 记载该例外确已用掉。今天读那条测试的人无法从代码里得知它曾被具名扩权改过。

**处置建议**：**建议本轮修**，且是最便宜的一种：在那条测试上加一行注释注明
「Package 2 / human ruling 13：本测试名在具名扩权下被更改」。不改任何断言，不改行为。

---

### 计数

**Critical 1（C-1） / Important 4（I-1、I-2、I-3、I-4） / Minor 1（M-1）。**

## 4. 我做过的临时变异与还原证明

**变异前的基线干净证明**（brief §2.5 第一条）：`git status --porcelain` 全程只有
`?? .superpowers/sdd/2026-08-07-pkg2-data-loss/wholebranch-lane1-report.md`（本报告自身），
`src/`、`tests/` 无任何未提交改动 ⇒ `git checkout --` 的还原目标正确。

**还原口径**：每次都同时验 `git diff`、`git diff --cached`、`git diff HEAD` 三者。
⚠️ 一处必须写下来的坑：**默认被改写的 `git diff | wc -c` 回 `1` 而不是 `0`**（多一个换行），
第一次险些被我读成「有残留」。后续一律走 `rtk proxy git diff`，实测三者均为 **0 字节**。

| # | 变异内容 | 观察结果 | 还原证明 |
|---|---|---|---|
| M1 | `runLoop.ts`：`createOwnedRunStateWriter()` 整体换成直写 `writeFile(join(dir,"loop-state.json"),…)`（D-1 #7，覆盖全部 11 处守卫写）；新增两个 `MUTATION_` 前缀 import | `TSC_EXIT=0`；`Tests 7 failed \| 517 passed (524)`；结构判据仍绿 | `git checkout -- src/controller/runLoop.ts` ⇒ diff / --cached / HEAD 均 **0 字节** |
| M2 | `persistTerminalState`：仅 `exhausted` / `blocked_waiting_human` / `succeeded` 三种终态改直写 | `TSC_EXIT=0`；`Tests 1 failed \| 523 passed (524)`，唯一红=允许 flake (B) ⇒ **全绿** | 同上 ⇒ 三者均 **0 字节** |
| M3 | `exhausted` 走动态 `await import(...)`（#9）；`blocked_waiting_human` 走**新建**模块 `src/controller/mutationThirdModule.ts`（#10） | `TSC_EXIT=0`；`Test Files 31 passed (31)` / `Tests 524 passed (524)`（连 flake 都没红） | `git checkout -- src/controller/runLoop.ts` **＋ `rm -f src/controller/mutationThirdModule.ts`** ⇒ 三者均 **0 字节**，`status --porcelain` 无残留未跟踪文件 |
| M4 | `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3→1 **且** `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3→1 | `TSC_EXIT=0`；`Tests 2 failed \| 522 passed (524)`，两条红均为绝对值断言、均指名转移侧 | 见 M5 后统一还原 |
| M5 | 在 M4 基础上把 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 改为 2（reconciliation 侧维持 1） | `TSC_EXIT=0`；`Test Files 31 passed (31)` / `Tests 524 passed (524)` ⇒ **全绿** | `git checkout -- src/controller/runLoop.ts src/persistence/fileStore.ts` ⇒ 三者均 **0 字节** |

**共 5 次变异，全部证明还原。** 最终态见 §7 的收尾自检。

**另有 3 个探针，它们不是变异**：`scratchpad/lockProbe.ts`、`scratchpad/windowProbe.ts`、
`scratchpad/resumeRaceProbe.ts` —— 都写在 scratchpad、只 `import` 已发布的 `src/persistence/fileStore.ts`、
只在系统临时目录建 run 目录，**对被评审代码零改动**。

## 5. 我下过的全称否定，以及证明检索面为活的 sanity 探针

**否定 1：`src/` 与 `tests/` 里没有任何 `ruling 13` 的源码锚点。**
同一次检索里的必命中探针：`ruling 14`（2 处命中）、`ruling 17`（1 处）、`ruling 37`（1 处）全部命中
⇒ 检索面为活。

**否定 2：`RECONCILIATION_LOCK_RETRY_ATTEMPTS` 没有任何测试引用。**
同一次 `grep -rn "OWNER_TRANSFER_LOCK_RETRY" src/ tests/` 里，转移侧那个常量在
`tests/controller/resumeLoop.integration.test.ts:325` 与
`tests/controller/leaseLifecycle.integration.test.ts:680` 命中 ⇒ 检索面能看见 `tests/`。
**并且这条否定另有实测背书**：M5 把它 3→1，全套件全绿。

**否定 3：`reconciliation-record.json` 不在 L2 的 `OBSERVED_FILES` 里。**
`observeFields.ts` 的 `OBSERVED_FILES` 我整段读了，只有三项；
`readObservedFile.ts` 的 `pickReader` 对其余一律 throw ⇒ 结构性读不到，非检索结论。

**我踩到、并当场记下的探针坑（三个，全部是本仓库点名过的形状）：**
1. **zsh 未加引号的 `--include=*.ts`** —— 第一次 grep 直接 `no matches found: --include=*.ts`，
   零结果**不是**「不存在」。加引号后重跑，并在同一次里放必命中/必落空探针。
2. **`$?` 取到管道里最后一条命令** —— 我写过 `... | cat; echo "exit=$?"`，取到的是 `cat` 的退出码。
   **该处结论我没有采用**，改以「输出行数」为观测。
3. **`node -e` 下参数落在 `argv[1]` 而非 `argv[2]`** —— 使我的第一版跨进程窗口探针每次读都抛、
   输出 `[]`，**看起来正好像「0 字节窗口不存在」**。加入 `anchorBytes` 必命中锚点后重跑，
   才拿到真实的 `[0,88]`。**没有那条锚点，我会下一个假的全称否定。**

**另有一次报告未落地前的自我更正（不是探针坑，是观测时机错）**：
`resumeRaceProbe` 第一版在 `Promise.all` 拒绝后立刻读目录，而恢复链还在飞，
观测到「`.owner-transfer.lock` 残留 + 第二次仍被拒」；改为等 `allSettled` 后再观测，两个现象都消失。
**若照第一版落笔，我会报一条不存在的 Critical。** 详见 §2.4。

## 6. 我没能验到的、以及为什么（诚实留白）

1. **C-1 的最后一步合成没有实测。** 我分别测到 (a) 0 字节锁窗口真实存在（跨进程）、
   (b) 处于该状态且有 staged artifacts 的锁会被抢走。但**没有在同一次运行里让窗口与争用者真正撞上**，
   也没有实测「两个进程同处临界区 ⇒ 赢家记录被覆盖」这一后果本身。
   两段之间的连接是机械推理。**C-1 的分级建立在 (a)+(b) 两个实测事实上，后果那一步是推的。**
2. **没有实测 `release()` 删掉小偷的锁。** 那是读源码得到的（`safeUnlink(lockPath)` 无归属校验），未构造。
3. **I-1 只覆盖了 `persistTerminalState` 里的三种终态。** 我没有把 `runLoop.ts` 其余
   非终态写点逐个做单点变异（那需要约 8 次额外全套件跑），
   所以**我不能说「其余写点都有判据」，也不能说都没有** —— 这一格我留白。
4. **口径 B 下的「既有判据」我不下结论**（见 §2.3）：包 2 自己本轮先写后改的判据，
   需要逐 commit 追踪包 2 内部历史，超出我这条车道的证据面。
5. **测试面本身不是我的主责**，Lane 2 主责。我只报了在生产代码侧撞见的同形
   （I-3 的自指断言）。`tests/` 里其余「靠异常/超时变红」的形状我没有系统扫。
6. **本轮零红不构成 flake 消失的证据**：人裁 10 那条（`persists phase usage evidence …`）
   在我 6 次全套件跑里**一次都没红**，我按 brief 挂账处理，**不当作它已消失**。
   允许的 flake (B) 在 6 次里红了 2 次（baseline、M2）。
7. **我没有读包 1 的任何文档**（`.superpowers/sdd/2026-08-07-pkg1-l5-spec/`），按 brief §1 禁令。
8. **我没有对待裁点 A / B / C 提出任何方向性建议**，也没有把「应当裁 B」当成 finding。

## 7. 预算：harness 可数事实

⚠️ 按 brief §7：**不自报预算估计**。以下只写可数事实。

- **全套件跑：6 次**（baseline、M1、M2、M3、M4、M5），每次输出**整份落盘、未过滤、整份读回**：
  `scratchpad/runs/{baseline,m1,m2,m3,m4,m5}.txt`。其中 5 次同时跑了 `npm run typecheck`（`TSC_EXIT` 均为 0）。
- **临时变异：5 次**（M1–M5），**全部证明还原**（`git diff` / `--cached` / `HEAD` 三者均 0 字节）。
- **独立探针跑：5 次** —— `lockProbe`×1、`windowProbe`×2（第一版坏、第二版带必命中锚点）、
  `resumeRaceProbe`×2（第一版观测时机错、第二版等 settle）。
- **完整读过的生产文件：4 个** —— `src/controller/ownedRunStateWriter.ts`（全 170 行）、
  `src/persistence/fileStore.ts`（全 1342 行）、`src/controller/resumeLoop.ts`（全 270 行）、
  `src/controller/runLoop.ts`（部分：1–100、655–724、950–963、1058–1085，加 `e42e062..fc07c20` 全量 diff）。
- **完整读过的测试文件：1 个** —— `tests/controller/ownedRunStateWriter.structure.test.ts`（全 125 行）。
- **另读**：`src/registry/observeFields.ts`（1–60）、`src/registry/readObservedFile.ts`（30–59）、
  `src/runtime/types.ts`（70–120）；`tests/` 全量 diff（81 035 字节，落盘 `runs/testdiff.txt`）。
- **台账**：我**没有通读** `progress.md`（1488 行），只按符号名检索了人裁 13/14/17/37 的锚点。
  这是刻意的 —— brief §2.1 说台账只是线索不是证据，我的结论全部由实测支撑。
- **一次纪律违反，自曝**：M2 结果我先用了一次 `tail -n 40` 看输出（brief §2.3 明令 `tail` 同罪）。
  **该次过滤读没有被用作任何结论的依据** —— 我随后整份读回 `m2.txt`（216 行）并以整份读为准。
  另有两处对**源码 diff**（非验证跑输出）用了 `grep`/`head`，那不在 §2.3 的禁令范围内。
- **拿不到精确数字的项**：token 用量、wall-clock 总时长 —— harness 未向我暴露，**不估**。

## 8. 收尾自检（工作区最终状态）

见 §4 的还原证明；最终 `git status --porcelain` 只应有本报告一个未跟踪文件，
`git diff` / `git diff --cached` / `git diff HEAD` 三者均为 0 字节。
⛔ 我全程**未 commit / 未 push / 未建删分支 / 未合并**，**未触碰主仓库**
`/Users/biran/code/skills/loop/ccloop`。
