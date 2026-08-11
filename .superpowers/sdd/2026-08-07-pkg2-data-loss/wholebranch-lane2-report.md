# 包 2 整分支评审 —— Lane 2 报告（判据面 / 声明-代码一致性）

## 0. 结论（最先填）

**1 Critical ／ 2 Important ／ 3 Minor。四个具名例外全部在界内。**

- **C-1（Critical，实测，非推理）**：`.owner-transfer.lock` **可以被从一个活着的持有者手里偷走**。
  `acquireOwnerTransferLock` 先 `open(lockPath,"wx")` 再 `handle.writeFile(...)`，两步之间锁文件是 **0 字节**；
  另一进程此时来抢，`tryRecoverStaleOwnerTransferLock` 的 `JSON.parse("")` 抛出 → 走 `catch` →
  只要磁盘上有 staged artifacts（marker／pendings）就判定为 stale → **`safeUnlink` 掉一个活持有者的锁**。
  我用**生产代码路径** `readOwnerRecord` 实测复现（含一条必命中与一条必不命中的 sanity 探针）：
  锁被删除、闯入者完成了 finalize（epoch 1 → 2）。
  这**逐字证伪**了 `publishReconciliationUnderTransferLock` 注释里那句承重断言
  「**Two lock spans cannot interleave**」，而第 4 笔的顺序无关性正是建立在它之上；
  它同时把任务 3 阶段 1 与新测试
  `lets exactly one of two concurrent readOwnerRecord calls finalize the transaction…` 声称关掉的
  torn/duplicate finalize 竞态重新打开。
  ⚠️ 它的自然修法落在**待裁点 B 的地界**（`tryRecoverStaleOwnerTransferLock` 失败开放 → 失败关闭）。
  **我不主张裁 B**，只按人明令「可以指出关系」把关系指出来。**本轮不修**，报上来由人处置。

- **I-1（Important）**：**重试的「次数」这一条今天零执行机制。**
  `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS 3 → 2`：**全套件 524/524 全绿，TEST_EXIT=0**。
  `RECONCILIATION_LOCK_RETRY_ATTEMPTS 3 → 1`（等于把 D2 的重试整条拆掉）：**全套件 524/524 全绿，TEST_EXIT=0**。
  两条「上界」测试都写成 `expect(...).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` —— **相对常数恒真**。
  人裁 38 批的是「约 100ms、3 次」，**这两个数字今天都没有判据**。这是本仓库第 4 次出现的
  「一个没有执行机制的完整性断言」形状。

- **I-2（Important）**：**D2 自己那条重试分支完全没有判据。**
  `RECONCILIATION_LOCK_RETRY_ATTEMPTS` / `_DELAY_MS` 在整个 `tests/` 下**零引用**，
  把 attempts 打到 1 全套件仍绿。resume 侧与转移侧各有一对 mock 驱动的「清空/耗尽」测试，
  **reconciliation 侧一条都没有** —— brief §3.2 那个「同形缺口」在第三处比预估更宽。

- **M-1**：基线里出现了**名单外的失败**（详见 §1）；**M-2**：第五处既有测试改动（纯增强，两种口径分别报）；
  **M-3**：face 5 的第三处口径今天**不是可达红线**（实测 fail-closed 且留痕），但**无判据**。

**四个具名例外逐条裁断（详见 §3）**：13 **在界内**／14 **在界内（确是且仅是那两条）**／
17 **在界内（另两个同名夹具字节未动）**／37 **在界内（`owner_transfer_contended` 断言原样保留）**。
**没有第五处既有判据被删除或被软化** —— 九个文件里被删除的 `expect(` 一共 **3 行**，全部落在人裁 13 与 37 之内。

**台账措辞（人裁 39）**：全目录检索，**没有任何一处把第 4 笔写成「已关闭」**；
现行状态行写的是「第 4 笔: complete（降级）」，实施报告自己也逐字写着「不主张它已关闭」。**人裁 39 被遵守。**

## 1. 我自己的基线（重跑结果，未过滤）

工作区 `.worktrees/wb-lane2`，`HEAD = fc07c20`（brief §5 的 `bfb366a` 是主仓库 HEAD，
其后的提交是 docs-only；`e42e062..HEAD -- src tests` 实测就是那 9 个文件、+1716/−67）。
命令：`ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run`，整份落盘 `scratchpad/baseline.txt`，整份读回。

**我的基线不是绿的：`Test Files 2 failed | 29 passed (31)` ／ `Tests 2 failed | 522 passed (524)` ／ `TEST_EXIT=1`。**

两条失败：
1. `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（超时 5003ms）
   —— **在名单内**（允许的 flake (B)）。
2. `tests/runtime/claude/subprocessClaudeAdapter.test.ts > SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`
   —— ***不在名单内***。按 brief §5 末句，**不挥手放过**：见 §5 的 M-1。

**我没有继承 brief §5 那个绿。** 后续我又跑了 5 次全套件（都是变异跑），其中
`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS 3→2` 与 `RECONCILIATION_LOCK_RETRY_ATTEMPTS 3→1`
两次是 `31 passed (31) / 524 passed (524) / TEST_EXIT=0` 的干净全绿 —— 所以 524 这个总数、
以及「本轮零红是可达的」这一点，我自己独立确认了；**但它不是每次都可达**。

## 2. 五个跨笔面的逐条判断

### 2.1 四个具名例外是否越界 —— **全部在界内**

逐条见 §3。这里只记总判断与支撑它的**全量**证据：
`git diff e42e062 HEAD -- tests/` 里被删除的 `expect(` 行**一共 3 行**，
两行在 `leaseLifecycle` 的 busy-lock 测试（人裁 37 授权），一行是 `runLoop` 的旧断言 (a)（人裁 13 授权）。
**没有第 4 行、没有第 5 处、没有「加个 `if` 让它更容易通过」这类软化。**

### 2.2 重试覆盖的同形缺口 —— **比既有说法更宽（I-1 + I-2）**

brief 的假设是「分不清 1 次与 3 次」。实测下来更精确也更严重：

| 变异 | 结果 |
|---|---|
| `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3 → **1** | 红 2 条：`leaseLifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1)`（`expected 1 to be 2`）与 `resumeLoop > retries a busy owner-transfer lock during the resume claim and completes once it clears` |
| `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3 → **2** | **全绿 524/524，TEST_EXIT=0** |
| `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3 → **1** | **全绿 524/524，TEST_EXIT=0** |

⇒ 被钉住的只有「**存在至少一次重试**」。**「3」这个数字本身零判据**，
`OWNER_TRANSFER_LOCK_RETRY_DELAY_MS = 50`（人裁 38 的「约 100ms」＝ 2 × 50）同样零判据。
两条本该钉住上界的断言写成了 `expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` /
`expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` —— **相对被测常数恒真**，
这正是 Rule 9 说的「业务逻辑改变时不会变红的测试」。

⇒ 第三处（**reconciliation 侧，D2 自己新加的那条**）连「存在重试」都没钉住：把它拆成不重试，全套件仍绿。
`RECONCILIATION_LOCK_RETRY_ATTEMPTS` / `RECONCILIATION_LOCK_RETRY_DELAY_MS` 在 `tests/` 下零引用
（sanity：同一次检索命中了 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 在 tests 下的两处，检索面是活的）。

⚠️ 我遵守了「CAS 从不重试是既有约定」，没有把它当缺陷；`retries zero times on a CAS mismatch (spec requirement 3)` 在所有变异下都绿。

### 2.3 D-1 的结构判据钉得有多死 —— **本身很死；但它只是三层网里的一层**

`ownedRunStateWriter.structure.test.ts` 对三种合法改写**全部变红**（每次单跑，整份落盘）：

| 改写 | 结果 |
|---|---|
| `import{writeRunState as W}from"…"`（无空格 + 别名） | **红**：`expected [...] to not include 'writeRunState'` |
| `import*as fsNs from"…/fileStore.js"`（无空格命名空间） | **红**：`expected [ '../persistence/fileStore.js' ] to deeply equal []` |
| `import { type RunState as _RS, writeRunState as W2 } from "…"`（inline type 混写） | **红** |

⇒ `ts.createSourceFile` 这个机制是**真的**格式无关，不是又一个 regex。**这一点我推翻不了。**

三条自陈仍敞开的路里，我实测了 **#9（动态 `await import()`）**：

| 变异（都用 #9 绕过 guard） | 结构判据 | 全套件 |
|---|---|---|
| 把 `attempt_started` 那个写点换成 `await import(...)` + `writeRunState` | **绿**（如自陈） | **红**：`refuses to write the terminal failed status of a retry-cleanup failure…`（`expected 'executing' to be 'planning'`） |
| 把 top-of-loop 那个写点换成同样的绕过 | **绿**（如自陈） | **红**：`refuses to write a terminal status into a run a different, current owner already holds…`（事件清单少了 `run_state_write_abandoned`） |

⇒ 自陈的「honest limit」是**真的**（结构判据两次都没红），但**行为判据这一层把我试的两个写点都接住了**。
我没有把 9 个写点全部逐个变异（见 §8），所以我**不下**「存在一个无人覆盖的写点」这个断言。

### 2.4 第 4 笔是「降级」不是「关闭」 —— **前提被我实测证伪，措辞被我确认合规**

- 「转移锁不可被偷」这一条，**既有说法「零判据」不完全准确**，我给出更精确的裁断：
  - **有**判据覆盖「锁内容格式良好 + 持有者 pid 活着」这一片
    （`fileStore.test.ts` 的 live-pid 半边、`leaseLifecycle > appends owner_transfer_contended…`）。
    我的 sanity 探针 1 也独立复现了这一片：格式良好的活锁 → 锁存活、不 finalize。
  - **没有**判据覆盖 `acquireOwnerTransferLock` 自己那个 `open("wx") → writeFile` 的 **0 字节窗口**，
    而这一片**是可偷的**（C-1，实测）。更值得记的是：本轮新加的那条
    `lets exactly one of two concurrent readOwnerRecord calls finalize the transaction…` 测试，
    **在夹具里明文绕开了这个窗口**，注释逐字称它是「unrelated, already-known」。
    一条为了证明「锁互斥」而写的测试，把使这个前提为假的那个窗口标注成「无关」—— 这正是
    「一个没有执行机制的完整性断言」的新一例，且这次是在**用来建立该前提的测试内部**。
- 措辞：全 `.superpowers/sdd/2026-08-07-pkg2-data-loss/` 检索（带必命中「第 4 笔」＋必不命中双探针），
  **没有任何一处把第 4 笔写成「已关闭」**。所有 `关闭` 命中要么是在**提问**（人裁 39 之前）、
  要么是在**引用举证要求**、要么是**明确否认**（`task-4th-impl-report.md:168`「不主张它已关闭」）。
  现行状态行：`第 4 笔: complete（降级）`。**人裁 39 被遵守。**

### 2.5 `reconciliation-record.json` 缺席的三处口径 —— **不是可达红线，但第三处零判据**

实测（`resumeLoop` 走生产代码，只让 `reconciliation-record.json` 缺席）：

```
reconciliation-record.json present=false
  outcome: ResumeNotEligibleError: cannot read run artifacts: Error: ENOENT: no such file or directory, open '…/lane2-run-…'
  events: ["resume_requested","resume_denied"]
```

⇒ 第三处 `readReconciliationRecord` **确实没有本地守卫**，但 `resumeLoop` 自己的 `try/catch`
把 `Promise.all` 的任何 reject 统一转成 **fail-closed 且留痕**的 `ResumeNotEligibleError` + `resume_denied`。
**这不是今天可达的红线**：它既不崩、也不静默、也不失败开放。
「三处口径不一致」作为**代码形状**的观察是成立的，作为**风险**则被上一层抹平。

⇒ 真正缺的是**判据**：整个套件里没有任何一条测试驱动 `resumeLoop` 去撞
`reconciliation-record.json` 缺席（`readReconciliationRecord` 在 tests 下的 4 处引用全是 `fileStore.test.ts`
的直接调用与一条注释，没有一处是 resume 路径）。记为 M-3。

## 3. 具名例外逐条核查（13 / 14 / 17 / 37）＋ 有无第五处未申报改动

### 人裁 13 —— **在界内**，但它的「替代论证」比自陈的弱

事实（`git diff e42e062 HEAD` 逐字核）：
- 那条测试**被改名**：`reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`
  → `abandons the loser's reconciliation write against the winner's held transfer lock and finalizes none of the winner's transaction inside the publish window`。
  改名符合该测试注释里自陈的命名规约（「clause 1 = 断言 (a)，clause 2 = 断言 (b)」），新名字仍然一一对应。
- 断言 (a) 被替换：`expect(ownerTransferReadOutcomesInWindow).toContain("ok")`
  → `expect(reconciliationAbandonmentsInWindow).toHaveLength(1)` + `…[0]).toContain("OwnerTransferLockBusyError")`
  + `expect(ownerTransferReadOutcomesInWindow).toEqual([])`（**旧数组没被删掉，改成断言为空**，
  这样将来有人让 loser 又能读到，这条会红而不是静默通过 —— 这一手是对的）。

**brief 逼问的那一点，答案是：实施者没有拿「人已授权」当论据，而且根本没有触发那个禁令。**
- 「⚠️ No terminal-state assertion, deliberately … 断言它 = 把一条 damaged trajectory 写进套件」
  这段**被逐字保留**，并加了一句 `and D2 does NOT lift that`。**这条测试里至今没有终态断言。**
- 终态命题被搬到**两条新测试**，**一条一个锁序**
  （`keeps the loser's downgrade when its protected span runs first…` /
   `keeps the winner's reconciliation record as the terminal state when the loser's write is forced to land after the winner's last rename`），
  并在注释里写明「单序断言就是那条 damaged trajectory 换个名字」。
  **这是对 2026-08-02 那次 ruling 的正面回应，不是绕过。**
- 「推翻了哪一部分、逐字引」：`task-4th-design.md` §5.2 有专节回答（我核了标题与位置，没有替它背书内容之外的东西）。

⇒ **裁断：在界内。** 但要记一句：那两条新测试建立的「顺序无关」，
**其有效性建立在「两个锁跨度不可交错」之上，而这一条被 C-1 实测证伪**。
所以例外没越界，**替代论证的强度低于它自陈的强度**。这不改变裁断，但应当随 C-1 一起记入台账。

### 人裁 14 —— **在界内，确是且仅是那两条**

`terminal_write_abandoned` 在 `tests/` 下共 5 处断言性出现。
被加进**既有**穷举清单的**恰好 2 处**，都在 `runLoop.integration.test.ts`
（diff hunk `@@ -2409,6 +3178,13 @@` 与 `@@ -2546,6 +3322,11 @@`，即那两条 lease-loss 护栏测试）。
另外 3 处（`:1319`、`:1436`、`:1563`）全部落在**本轮新写的测试体内** —— 新测试自带断言不是「改既有期望清单」。
⇒ **没有第 3 条既有清单被动过。**

### 人裁 17 —— **在界内，另两个同名夹具字节未动**

`seedEligibleRun` 在 `tests/` 下确有且仅有 3 个同名实现：
`leaseLifecycle.integration.test.ts` / `resumeLoop.integration.test.ts` / `cli/cli.test.ts`。
- `leaseLifecycle` 的那个：`currentProcessInstanceId` 与 `newProcessInstanceId` 由 `"pid:100"` 改成
  `buildProcessInstanceId()`，`priorProcessInstanceId` 仍留 `"pid:100"`。**这是被授权的那一个。**
- `resumeLoop` 的那个：diff 里对该文件的改动只有 ①`import` 加 `vi` ②追加两条新测试。
  **`seedEligibleRun` 没有出现在任何 hunk 里。**
- `cli/cli.test.ts`：**根本不在 `e42e062..HEAD` 的 9 个文件里**（`git diff --stat` 全量列举，无此文件）。
⇒ **没有被顺手改。**

### 人裁 37 —— **在界内，`owner_transfer_contended` 断言原样保留**

`appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy` 中：
- **保留**：`expect(await readEvents(runDir)).toContainEqual(expect.objectContaining({ type: "owner_transfer_contended" }))`
  （`leaseLifecycle.integration.test.ts:548-550`，逐字未动），
  以及 `expect(finalState.status).toBe("exhausted")`、
  `await expect(access(join(runDir,"owner-transfer.json"))).rejects.toThrow()`、
  `expect(await readEventTypes(runDir)).not.toContain("owner_epoch_transferred")`。
- **替换**：仅「读 `reconciliation-record.json` 的那一半」——
  删 `reconciliation.newOwnerEpoch toBeNull` / `eligibleForContinuation toBe(false)`，
  改为 `access(...).rejects.toThrow()`（文件不存在）+ `reconciliation_write_abandoned` 事件存在。
  **两半都断言了**（不存在 + 有留痕），所以「删了事件但保留拒绝」的将来改动会红。
⇒ **完全落在授权的那一半里。**

### 有没有第五处未申报的既有判据被改动或被削弱？

**被删除或被软化的：没有。** 九个文件里被删除的 `expect(` 行**共 3 行**，全部落在 13 与 37 之内（全量列举见 §2.1）。
我把两个 test diff 里**每一行 `-` 开头的内容**都过了一遍，没有出现「加个 `if`」「放宽 matcher」「把 `toEqual` 换 `toContain`」这类软化。

**被增强的：有一处，按本仓库两种「既有」口径分别报（M-2）** ——
`tests/persistence/fileStore.test.ts` 里**三条既有的 fail-closed 测试**各新增一行
`await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();`。
- **口径 A（「既有」= 任务之前）**：这是**第五处**动了既有测试体的地方，且**不在 13/14/17/37 任何一条的授权里**。
  它在台账里有记（任务 3 fix loop 1 / Important-2「三条既有 fail-closed 测试各新增一行纯断言」），
  但那是控制器的记录，**不是一次具名人裁**。
- **口径 B（「既有」= 本修复环之前）**：这是本修复环内新增的断言，不算「改既有判据」。
- **两种口径下它都是纯增强**（只加不减，无软化），所以我不主张它越界；**但按 brief 的要求两种口径都报出来，不替人消解。**

## 4. 台账与报告里被我证伪或已腐坏的承重声明（逐条附证据）

### 4.1 **被证伪** —— `publishReconciliationUnderTransferLock` 注释：「Two lock spans cannot interleave」

逐字（`src/persistence/fileStore.ts`，`publishReconciliationUnderTransferLock` 上方）：

> …one critical section under the SAME cross-process lock that a winner holds for its entire publish
> transaction… **Two lock spans cannot interleave**, so the loser's write is either wholly before the
> winner takes the lock… or wholly after the winner released it… The third order… is the one the lock removes.

同一段自陈的唯一逃逸口是「a lock this process **can have stolen from it** (`tryRecoverStaleOwnerTransferLock`)」，
读起来像是只在**持有者已死**时发生。**实测不是。** 见 §6 变异 9（探针）：
一个**活着的**持有者，在 `acquireOwnerTransferLock` 自己的 `open("wx") → writeFile` 窗口里，锁被夺走。
⇒ 「两个锁跨度不可交错」**是假的**；第三种（破坏性的）顺序仍然可达。

### 4.2 **被证伪** —— 新测试注释：「the (unrelated, already-known) zero-length lock window」

逐字（`tests/persistence/fileStore.test.ts`，新 describe `recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker`）：

> Runs the real write first so the lock file has full, valid JSON content on disk before reader B ever
> gets a chance to look at it -- otherwise B could observe the **(unrelated, already-known)** zero-length
> lock window instead of the busy-lock path this test targets.

**`unrelated` 这个词在 D2 之后不再成立。** 这条测试存在的目的就是证明「同一时刻只有一个 finalizer」，
而 zero-length 窗口正是让这个结论为假的那条路径。夹具把它设计掉，等于把该测试的结论
从「系统性质」降成「在锁内容已写好的前提下的性质」，而**这个前提没有任何东西在保证**。
（对比：任务 S4 自己刚刚因为「completeness claim 声称已执行而实际未执行」被判为 F-1 同形缺陷。）

### 4.3 **腐坏（措辞层，非事实层）** —— 「零判据」这个说法过强

brief §3.4 与台账 `:1458` 说「顺序无关性以『锁不可被偷』为前提，**零判据钉住**」。
更准确的是：**格式良好 + 活 pid** 这一片**有**判据（我用 sanity 探针 1 独立复现），
**零字节窗口**这一片**既无判据、又被新测试主动绕开**。
我把这条写出来不是为了替谁开脱 —— 相反，精确化之后问题更重，因为「被绕开」比「没写」更难被将来的人发现。

### 4.4 **未被证伪（我试过，推翻不了）**

- 「结构判据是 `ts.createSourceFile` 解析、格式无关」：三种改写全红（§2.3）。**成立。**
- 「三条路仍敞开（#7/#9/#10）」中的 **#9**：结构判据在两次动态 import 绕过下**都保持绿**。**成立。**
- 「人裁 39：一律记降级」：全目录检索无「已关闭」。**被遵守。**
- 人裁 13 的两条举证要求：终态断言没加进那条测试、禁令原句保留、终态命题移到两条互补锁序的新测试。**已正面处理。**

## 5. Findings（Critical / Important / Minor，与处置建议分开写）

> 每条：① 可构造场景 ② 符号名锚点 ③ 实测证据。**「处置建议」与 finding 分开写。**

---

### C-1（Critical）活持有者的 `.owner-transfer.lock` 可在自己的 acquire 窗口里被夺走

**锚点**：`tryRecoverStaleOwnerTransferLock` ／ `acquireOwnerTransferLock` ／
`recoverInterruptedOwnerTransfer` ／ `publishReconciliationUnderTransferLock`
（均在 `src/persistence/fileStore.ts`）；受影响判据
`tests/persistence/fileStore.test.ts > recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker > lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing`。

**机制**：`acquireOwnerTransferLock` 是
`open(lockPath,"wx")` → `handle.writeFile({holderProcessInstanceId, acquiredAt})` 两步。
两步之间锁文件**存在但是 0 字节**。此时另一进程 `open(...,"wx")` 拿到 `EEXIST`，
转入 `tryRecoverStaleOwnerTransferLock`：`readFile` 得到 `""` → `JSON.parse("")` 抛 →
落入 `catch` 分支 → 该分支**不看持有者是否活着**，只看
`transactionMarkerPath || ownerPendingPath || transferPendingPath` 是否存在 →
存在就 `safeUnlink(lockPath)` 并 `return true` → 闯入者的 `for` 循环第二轮 `open("wx")` 成功。
**两个进程同时认为自己持有这把跨进程锁。**

**可构造场景（具体输入 → 错误终态）**：
1. run 目录里存在一次被中断的转移：`.owner-transfer.transaction.json` + `.owner-record.pending.json` + `.owner-transfer.pending.json`
   （这正是三文件事务 crash-gap 的常态，整套恢复机制就是为它写的）。
2. 进程 A 调用任何取这把锁的入口 —— `writeOwnerTransferArtifacts` /
   `claimOwnerRecordWithPrecondition` / **D2 新增的 `publishReconciliationUnderTransferLock`** /
   **任务 3 新增的 `recoverInterruptedOwnerTransfer` 无锁分支（每次 `readOwnerRecord` 遇到 marker 都会走）**。
   A 处在 `open` 与 `writeFile` 之间。
3. 进程 B 并发调用同类入口 → B 删掉 A 的锁并取得锁。
4. 终态：A 与 B **同时**跑 `finalizePendingOwnerTransfer`，各自写同一组固定 temp 名
   （`.owner-transfer.publish.tmp` 等）→ torn / hybrid publish，或其中一个在读对方已删掉的 pendings 时 ENOENT。
   在 D2 的语境下另一个终态是：输家的 reconciliation「读→判定→写」与赢家的三次 rename **重新可以交错**，
   即第 4 笔本来要消除的那第三种顺序。

**实测证据**（`scratchpad/probe_lock_steal.mts`，走**生产代码** `readOwnerRecord`，未过滤落盘）：

```
SANITY(well-formed live lock): lockSurvived=true  finalized=false  epochRead=1
PROBE(zero-length live lock, marker present): lockContentLenBefore=0 lockSurvived=false finalizedByB=true epochRead=2
SANITY(zero-length live lock, NO marker): lockSurvived=true
```
- 探针 1（**必命中**）：格式良好的活锁 → 被尊重。证明检索面/路径是活的，不是我构造了个假环境。
- 探针 3（**必不命中**）：0 字节活锁但**没有** staged artifacts → 锁存活。
  证明触发条件确实是 `catch { hasStagedArtifacts }` 那条分支，不是别的什么原因。
- 中间那行就是缺陷：0 字节 + marker → **锁被删、闯入者完成 finalize（epoch 1 → 2）**。

**为什么是 Critical**：按 brief 的分级口径，它同时命中两条 ——
(a)「一条会让评审结论本身失效的错误前提」：`publishReconciliationUnderTransferLock`
把「两个锁跨度不可交错」写进源码当作承重论证，而它是假的；第 4 笔的顺序无关性、
以及任务 3 阶段 1 声称关掉的双 finalizer 竞态，都挂在这条前提上。
(b)「今天可达的正确性破坏」：上面的四步链条不需要任何 mock，全部是生产入口。

**处置建议（与 finding 分开）**：
- **本轮不修。** 它的自然修法是让 `tryRecoverStaleOwnerTransferLock` 在**内容不可解析**时
  不再默认「可回收」—— 而这正是**待裁点 B（失败开放 → 失败关闭）**的地界，人已明令先不裁。
  **我不主张裁 B**，只按明令「可以指出关系」指出关系。
- 本轮**应当做的**是把这一条**逐字记入台账**，并把 §4.1/§4.2 那两句源码里的承重措辞标为**待修正**
  —— 因为「一个在源码里被声明为已保证、实际未保证的完整性断言」正是本仓库已复现三次、
  现在第四次的那个形状，留着不记就是重犯。
- ⚠️ **不要**把 `publishReconciliationUnderTransferLock` 的注释悄悄改软。本仓库的规矩是加勘误，不是覆盖。

---

### I-1（Important）重试的「次数」与「退避常数」今天零执行机制

**锚点**：`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` / `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS`（`src/controller/runLoop.ts`）；
判据 `tests/controller/leaseLifecycle.integration.test.ts > lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)`
与 `tests/controller/resumeLoop.integration.test.ts > resumeLoop > abandons the resume once the claim's retry bound is exhausted, with the refusal recorded exactly once`。

**缺陷**：两条本该钉住上界的断言分别写成
`expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` 与
`expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` ——
**左右两边同源**，常数变成多少它们都成立。

**可构造场景**：有人把 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 从 3 调成 2（缩短容忍窗口，
人裁 38 批的「约 100ms」变成约 50ms），或调成 8（把 heartbeat 的 exclusive span
撑到 ~400ms，源码注释自己写着「it runs inside the exclusive span… so it must stay small」）。
**两种都不会有任何测试变红。**

**实测证据**：`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS 3 → 2`，全套件
`Test Files 31 passed (31) / Tests 524 passed (524) / TEST_EXIT=0`（`scratchpad/mut_attempts2.txt`，整份落盘整份读）。
对照：`3 → 1` 会红 2 条，说明「至少一次重试」是被钉住的，**被钉住的只到这里为止**。

**处置建议**：建议**本轮修**，代价极小 —— 给两条测试各**新增**一行
`expect(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS).toBe(3)` 之类的字面量断言（外加退避常数一行）。
⚠️ 这是**新增断言**不是**修改判据**，落在人裁 4「授权的是补测试」的字面内；
但因为它动的是既有测试的文件与测试体，**按本仓库的谨慎口径仍应由人点头**，我不自行动手。

---

### I-2（Important）D2 自己新加的那条重试分支完全没有判据

**锚点**：`RECONCILIATION_LOCK_RETRY_ATTEMPTS` / `RECONCILIATION_LOCK_RETRY_DELAY_MS` /
`acquireOwnerTransferLockForReconciliation`（`src/persistence/fileStore.ts`）。

**缺陷**：这两个常数在整个 `tests/` 下**零引用**；把 attempts 打到 1
（= 「争用清空」这条路径整条拆掉，第一次 EEXIST 就放弃）**全套件仍然全绿**。
resume 侧与转移侧各有一对「清空 / 耗尽」测试（虽然是 mock 驱动的），**第三处一条都没有**。

**可构造场景**：赢家的 transfer transaction 持锁做几次 rename（微秒级）；
输家的 boundary write 撞上第一次 EEXIST 就 `reconciliation_write_abandoned`。
源码注释自己写着这正是要避免的（「giving up on the first EEXIST would refuse the write for a
contention that clears in microseconds」），但**没有任何东西在保证它没被拆掉**。

**实测证据**：`RECONCILIATION_LOCK_RETRY_ATTEMPTS 3 → 1`，全套件
`Test Files 31 passed (31) / Tests 524 passed (524) / TEST_EXIT=0`（`scratchpad/mut_recon1.txt`）。

**处置建议**：建议**本轮补一条新测试**（纯新增，不动任何既有判据，完全落在人裁 4 之内）：
让 `.owner-transfer.lock` 在第一次 acquire 时忙、第二次空出来，断言 boundary write **完成**且
`reconciliation_write_abandoned` **未出现** —— 与既有的 `retries a busy owner-transfer lock and completes once it clears` 同形。

---

### M-1（Minor）名单外的失败：`subprocessClaudeAdapter` 的负载敏感 flake

**锚点**：`tests/runtime/claude/subprocessClaudeAdapter.test.ts > SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`；
另加 `tests/validation/evidence.test.ts > finalize-review CLI > rejects unknown verdicts and diagnoses`。

**事实**：前者在我的基线全套件跑里**红**（968ms，`changedFiles: ["dirty.txt"]` /
`stdoutStderrLog: "claude phase runner interrupted by SIGTERM"` —— 即 close 没等到就被打断），
**不在 brief §5 的允许名单里**。单文件复跑 **3/3 全绿**（424/432/425ms），
后续 4 次全套件跑里也都绿。后者在一次变异跑里超时 5003ms，同样不在名单里。

**判断**：两条都是**负载敏感的超时/时序 flake**，不是包 2 的 9 个文件引入的
（`subprocessClaudeAdapter.test.ts` 与 `evidence.test.ts` 都不在 `e42e062..HEAD` 的改动面里）。
但按 brief 明令「不许挥手放过」，**记在这里**。它的真实后果是：
**brief §5 的「本轮零红」基线不可无条件继承** —— 我自己的基线 `TEST_EXIT=1`。

**处置建议**：**本轮不修**。建议控制器把这两条按「已具名、已测量、根因未证」的既有口径挂账
（与人裁 10 那条同形），不要因为「后来又绿了」就当没发生。

---

### M-2（Minor）第五处既有测试体改动：三条 fail-closed 测试各加一行锁释放断言

**锚点**：`tests/persistence/fileStore.test.ts` 中三条既有测试各新增
`await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();`。

**两种口径分别报**（本仓库对「既有」的两种读法没有消解，我不替它消解）：
- 口径 A（既有 = 任务之前）：这是**第五处**动了既有测试体的地方，**不在 13/14/17/37 任何一条授权内**；
  台账有记（任务 3 fix loop 1 / Important-2），但那是控制器记录而非具名人裁。
- 口径 B（既有 = 本修复环之前）：属修复环内新增，不构成「改既有判据」。

**两种口径下都是纯增强**（只加不减、无软化、无 matcher 放宽）。

**处置建议**：**不需要修**。建议在台账里把它**显式登记为第五处**（哪怕只是增强），
理由是：将来任何人复核「四个具名例外」时，diff 里会出现第五个动过的既有测试文件，
不登记就会重复触发一次「这是不是未申报改动」的调查。

---

### M-3（Minor）`readReconciliationRecord` 在 resume 路径上的行为无判据

**锚点**：`readReconciliationRecord`（`src/persistence/fileStore.ts`）→ `resumeLoop` 的 `Promise.all`（`src/controller/resumeLoop.ts`）。

**事实**：它确实**没有本地守卫**（对比 `readPersistedReconciliationRecord` 的 `catch → undefined`，
以及 registry 侧结构上读不到它）；但 `resumeLoop` 自身的 `try/catch` 把任何 reject 统一转成
`ResumeNotEligibleError("cannot read run artifacts: …")` + `resume_denied` 事件。
**实测（生产代码路径）**：文件缺席 → 上述 fail-closed 且留痕的结果，不崩、不静默、不失败开放。
⇒ **不是今天可达的红线。**

**缺的是判据**：整个套件没有任何一条测试驱动 `resumeLoop` 撞这条读的失败
（`readReconciliationRecord` 在 `tests/` 的 4 处引用全是 `fileStore.test.ts` 的直接调用 + 一条注释）。

**处置建议**：**本轮不修**。若将来要补，一条纯新增的 resume 测试即可，不需要动任何既有判据。

## 6. 我做过的临时变异与还原证明

**变异前工作区确认干净**：`git status --porcelain` 只有 `?? .superpowers/…/wholebranch-lane2-report.md`（本报告，未跟踪），
`git diff | wc -c = 0`、`git diff --cached | wc -c = 0`。

每次变异都由 `scratchpad/mut.sh` 驱动，脚本在**每一次**跑的前后都记录
`git diff | wc -c` 与 `git diff --cached | wc -c`，还原用 `git checkout -- <file>` 后再 `git reset -q HEAD -- <file>`
（因为 `git checkout <commit> -- path` 会进暂存区，这一条我按 brief §2.5 照做了）。
**8 次变异，8 次还原后 `git diff` 与 `git diff --cached` 同时为 0 字节。**

| # | 文件 | 变异内容 | 观察结果 | 还原证明 |
|---|---|---|---|---|
| 1 | `src/controller/runLoop.ts` | 加 `import{writeRunState as W}from"…"`（无空格 + 别名） | 结构判据**红**：`to not include 'writeRunState'` | diff 0 / cached 0 |
| 2 | `src/controller/runLoop.ts` | 加 `import*as fsNs from"…/fileStore.js"` | 结构判据**红**：`[ '../persistence/fileStore.js' ] to deeply equal []` | diff 0 / cached 0 |
| 3 | `src/controller/runLoop.ts` | 加 `import { type RunState as _RS, writeRunState as W2 } from "…"` | 结构判据**红** | diff 0 / cached 0 |
| 4 | `src/controller/runLoop.ts` | `attempt_started` 写点改走 `await import()` + `writeRunState`（绕过 guard） | 结构判据**绿**；全套件**红 1 条**：`refuses to write the terminal failed status of a retry-cleanup failure…`（`expected 'executing' to be 'planning'`） | diff 0 / cached 0 |
| 5 | `src/controller/runLoop.ts` | top-of-loop 写点同样绕过 | 结构判据**绿**；全套件**红 1 条**：`refuses to write a terminal status into a run a different, current owner already holds…`（事件清单缺 `run_state_write_abandoned`） | diff 0 / cached 0 |
| 6 | `src/controller/runLoop.ts` | `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3 → 2 | **全套件 524/524 全绿，TEST_EXIT=0** | diff 0 / cached 0 |
| 7 | `src/controller/runLoop.ts` | `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 3 → 1 | 红 2 条（`retries a busy owner-transfer lock and completes once it clears (spec requirement 1)` / resume 侧同形） | diff 0 / cached 0 |
| 8 | `src/persistence/fileStore.ts` | `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3 → 1 | **全套件 524/524 全绿，TEST_EXIT=0** | diff 0 / cached 0 |

**变异 9（探针，不改仓库任何文件）**：`scratchpad/probe_lock_steal.mts`
—— 只 import 生产模块的 `readOwnerRecord`，在 `os.tmpdir()` 下自建 run 目录。
**没有修改仓库内任何字节**，因此不需要还原；跑完后 `git status --porcelain` 仍只有本报告一行。
输出见 §5 的 C-1。

**变异 10（探针，同上不改仓库）**：`scratchpad/probe_resume_missing_recon.mts`，见 §2.5。

⛔ **我没有动第五个具名例外**：本次评审**没有修改任何既有测试判据**。
上表里对 `runLoop.ts` / `fileStore.ts` 的改动全部是生产代码，且全部还原。

**最终状态**（本报告写完前最后一次核）：`git status --porcelain` = `?? .superpowers/sdd/2026-08-07-pkg2-data-loss/wholebranch-lane2-report.md`；
`git diff` 0 字节；`git diff --cached` 0 字节。

## 7. 我下过的全称否定，以及证明检索面为活的 sanity 探针

| 全称否定 | sanity 探针（同一次跑里） | 结果 |
|---|---|---|
| 「`tests/` 下只有 3 个 `seedEligibleRun`」 | `grep -rln seedEligibleRun tests/` 与 `grep -rn` 两种形式互校 | 3 个文件，一致 |
| 「`terminal_write_abandoned` 只被加进 2 条既有清单」 | 同一次 grep 也命中了 `src/controller/ownedRunStateWriter.ts:143`（定义处，必命中） | 检索面活 |
| 「`RECONCILIATION_LOCK_RETRY_*` 在 `tests/` 下零引用」 | **同一条命令**同时检索 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS`，在 `tests/` 下命中 2 处（必命中） | 检索面活 |
| 「九个文件里被删除的 `expect(` 只有 3 行」 | 同一批命令统计新增 `expect(` 行数（11 + 57，必命中非零） | 检索面活 |
| 「全 sdd 目录没有一处写『第 4 笔已关闭』」 | 必命中：`第 4 笔` 逐文件计数（18 个文件命中）；必不命中：`zzz-not-present-zzz`（0 命中） | 双探针都符合预期 |
| 「活持有者的锁在有 staged artifacts 时会被偷」（这是**存在性**断言，仍配了双探针） | 必命中：格式良好活锁 → `lockSurvived=true, finalized=false`；必不命中：0 字节活锁但**无** marker → `lockSurvived=true` | 触发条件被精确定位到 `catch { hasStagedArtifacts }` |

**踩到并当场纠正的坏探针**：
- zsh 下 `grep -rn "seedEligibleRun" tests/ --include=*.ts` 报
  `(eval):1: no matches found: --include=*.ts` —— 正是 brief §2.4 点名的形状之一。
  当场改用不带 `--include` 的形式重跑。
- 第一次跑 `probe_lock_steal` 用了 `... | tee ...`，末尾 `echo "EXIT=$?"` 取到的是 `tee` 的退出码（显示 0，但脚本其实转译失败了）。
  —— 同样是 brief 点名的 `$?` 形状。改成先重定向落盘、再单独 `echo` 退出码。
- 变异驱动脚本第一版把 python 代码当字符串传进 `python3 -c "$PY"`，zsh 引号会吃掉内容；改成传脚本文件路径。

**我刻意没有下的全称否定**：
- ✗ 「9 个 `writeOwnedRunState` 写点里存在一个没有任何测试覆盖的」 —— 我只变异了其中 2 个，见 §8。
- ✗ 「除了 C-1 之外锁协议没有别的偷法」 —— 我只测了 0 字节窗口这一种。
- ✗ 「brief 名单外只有 M-1 那两条 flake」 —— 我一共只跑了 6 次全套件。

## 8. 我没能验到的、以及为什么（诚实留白）

1. **9 个 `writeOwnedRunState` 写点我只逐个变异了 2 个**（top-of-loop、`attempt_started`），两个都被行为判据接住。
   剩下 7 个（`consumeAttemptBudget` 后、`execution_finished` 后、`verification_rejected` 后、
   `attempt_failed` 两处、`RunHeartbeatStoppedError` catch、外层 catch 的 failed 分支）**没有逐点变异**。
   ⇒ 我**不能**声称「每个写点都有行为判据」，也**不能**声称「存在一个没有的」。这是本报告最大的留白。
   代价估计：7 次全套件跑，每次约 20–30 秒机器时间；**不是预算问题，是我把预算优先给了 C-1 的复现**。

2. **面 5 的对照组被我自己的夹具污染。** `probe_resume_missing_recon.mts` 的「有 reconciliation-record」
   那一支因为我写的 `loop-contract.json` 不满足 schema（`invalid_type ... expected string`）也失败了，
   所以我**没有**建立「同一夹具下有该文件就能 resume 成功」。
   ⇒ 我据以下结论的只有第二支：错误消息**逐字包含 `ENOENT`** 且事件是 `resume_denied`，
   这足以确定 ENOENT → `ResumeNotEligibleError` 的映射，但**不足以**说「唯一变量是那个文件」。

3. **C-1 是单进程内复现的。** 我用同一个 Node 进程扮演 A（持 `open` 句柄）与 B（调 `readOwnerRecord`），
   走的是真实 fs 与真实生产代码，但**没有**做真正的双进程复现。
   跨进程时这个窗口是真实墙钟时间（两次 async fs 调用之间），**我判断更宽而不是更窄**，
   但这是判断，不是实测。

4. **锁协议的其它偷法我没找。** 例如 `parsePid` 只认 `/^pid:(\d+)$/`，
   而本仓库其它地方的 process instance id 形如 `pid:39747:1786411109173`（我的探针输出里就是这个形状）——
   一个三段式 id 写进锁文件时 `parsePid` 返回 `null`，`pid !== null && isProcessActive(pid)` 就为假，
   于是**不 return false**、直接落到 `safeUnlink`。**我看到了这个形状但没有实测它**，
   因为 `acquireOwnerTransferLock` 写进锁文件的是 `pid:${process.pid}`（两段式），
   要判定它是否可达需要把 `getOwnerTransferPaths` 的所有写入方都走一遍 —— **留给 Lane 1 / 下一轮**。
   ⚠️ 这一条**不要当成 finding**，它是一条**未验的线索**。

5. **`tsc` / `build` 我没跑。** 我的变异都在 `vitest` 层面判红绿；brief §5 给的 `TSC_EXIT=0 / BUILD_EXIT=0`
   我**没有独立重跑**。（结构判据那三条变异如果引入类型错误，`vitest` 用 esbuild 转译不会报，
   所以「变异 1–3 在 `tsc` 下是否也合法」我没验 —— 但这不影响结论方向：它们**红了**。）

6. **人裁 13 要求的「逐字引 2026-08-02 ruling 被推翻的部分」**：我核到了
   `task-4th-design.md` §5.2 有专节标题回答这个问题，**但我没有逐字校验那一节引用的原文
   与 `2026-08-07-pkg1-l5-spec` 之外的 2026-08-02 计划文档是否一致** ——
   那份原始计划在 `docs/superpowers/plans/2026-08-02-…`，不在我的 9 文件范围内，我没有打开它。

7. **待裁点 A / B / C 我一律没裁。** C-1 的自然修法落在 B 的地界，我只**指出关系**，
   明确**不主张**应当裁 B。

8. **另一条车道（Lane 1）我完全没接触**，按明令保持独立。

## 9. 预算：harness 可数事实

**不自报预算估计**（本仓库明令以 harness 实测为准）。以下只写可数事实：

- **全套件跑：6 次**（1 次自己的基线 + 5 次变异跑）。
- **单文件跑：6 次**（`subprocessClaudeAdapter` 复跑 3 次 + 结构判据变异 3 次）。
- **仓库内生产代码变异：8 次**，全部证明还原（`git diff` 与 `git diff --cached` 同时 0 字节）。
- **不改仓库的独立探针脚本：2 个**（`probe_lock_steal.mts`、`probe_resume_missing_recon.mts`），
  其中 `probe_lock_steal.mts` 自带 1 条必命中 + 1 条必不命中 sanity 探针。
- **仓库内既有测试判据修改：0 次**（第五个具名例外未动用）。
- **git commit / push / 建删分支 / 合并：0 次。**
- **完整读过的源文件**：`src/controller/ownedRunStateWriter.ts`、
  `tests/controller/ownedRunStateWriter.structure.test.ts`。
- **完整读过的 diff**：`e42e062..HEAD` 的 9 个文件全部（src 两份、tests 两份，共 4 个 diff 落盘文件，逐份整读）。
- **部分读过的源文件**：`src/persistence/fileStore.ts`（约 4 段）、`src/controller/resumeLoop.ts`（1 段）、
  `tests/controller/leaseLifecycle.integration.test.ts`（1 段）。
- **读过的台账/文档**：`wholebranch-lane2-brief.md`（全）、`progress.md`（约 5 段，非全文）。
  **未读**：`2026-08-07-pkg1-l5-spec/` 下任何文件（明令不读，我没有打开过其中任何一个）。
- **完整落盘并完整读回的验证输出**：`baseline.txt`、`subproc_3x.txt`、`mut_alias.txt`、`mut_ns.txt`、
  `mut_typeonly.txt`、`mut_dyn_attemptstarted.txt`、`mut_dyn_toploop.txt`、`mut_attempts2.txt`、
  `mut_attempts1.txt`、`mut_recon1.txt`、`probe_lock_steal_out.txt`、`probe_resume_out.txt`。
  **没有一次是过滤后落盘或过滤后显示的**。
  其中 `mut_dyn_toploop.txt`、`mut_attempts1.txt`、`mut_recon1.txt` 三份我是**先读后段、再回头读前段**，
  分两次把整份读完 —— 是分段读完整份，**不是截取**。
- **精确 token 数我拿不到**（harness 未向我暴露），**因此不估**。
