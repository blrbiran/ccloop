# 包 2 整分支评审 —— 修复环实施 brief

> 你是**实施者**。包 2 的整分支评审（两条互不通气的 lane）已交付，结论 **1 Critical / 6 Important / 4 Minor**。
> 人已逐项裁决要修哪些（**人裁 48**）。**你只做下面点名的四类，一件不多、一件不少。**

## 0. 工作区与落盘协议（**先做这一步，做完再开始改代码**）

- **工作区**：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix`（分支 `feat/pkg2-wb-fixes`，依赖已 `npm ci`）。
  ⛔ **绝不要碰主仓库** `/Users/biran/code/skills/loop/ccloop`，也不要碰 `.worktrees/bdesign`（另一名只读设计员在用）。
- ⛔ **不得 `push` / 建删分支 / 合并 / 开门**。**可以** `git commit` 到本分支（这是本仓库的既有做法）。
- **报告**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/wbfix-impl-report.md`。
  **立刻** `Write` 出只有小节标题的骨架并落盘，之后每次 `Edit` 只填一节，**结论一节最先填**。
  （历史教训：曾有一会话 12 名 agent 死 6 名，全部发生在准备一次性落盘时。）
- 该目录 `.gitignore` 是 `*` ⇒ 入库要 `git add -f`。

## 1. 先跑基线（**不继承任何先前的绿**）

```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run    # 整份落盘、整份读回，不许 grep/tail/sed
rtk proxy npm run typecheck
rtk proxy npm run build
```
- **允许出现的 flake 只有两条**：
  (B) `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
  (F) `continues normally when execute returns a complete result during the recovery window`
- **已挂账、按完整测试名比对、不要重新调查**：
  `persists phase usage evidence from the subprocess adapter without recomputing controller totals`（人裁 10）；
  以及台账 §21.5 新挂账的两条：
  `subprocessClaudeAdapter … waits for close before interrupting a close-pending successful execute`、
  `evidence.test.ts > finalize-review CLI > rejects unknown verdicts and diagnoses`（均负载敏感、单跑绿、**不在包 2 改动面内**）。
- ⚠️ **其余任何失败一律按新缺陷处理，不许挥手放过。**

## 2. 你要做的四类（**人裁 48 逐项批准**）

### 2.1 零风险文档类（不动任何断言与行为）

**(a) 给人裁 13 补源码锚点。**
`tests/controller/runLoop.integration.test.ts` 里被更名的那条测试
（今名 `abandons the loser's reconciliation write against the winner's held transfer lock and finalizes none of the winner's transaction inside the publish window`）
加一行注释，注明**它的测试名曾在包 2 / 人裁 13 的具名扩权下被更改**。
理由：全仓检索 `ruling 13` 零命中（同次检索 14/17/37 均命中 ⇒ 检索面已证为活），
今天读那条测试的人无法从代码里得知它被具名扩权改过。

**(b) 补 `src/controller/ownedRunStateWriter.ts` 的 "HONEST LIMIT" 注释。**
现有自陈边界**与实际不符**：结构判据 `tests/controller/ownedRunStateWriter.structure.test.ts`
**只解析 `runLoop.ts` 一个文件**（`runLoopSourcePath` 写死）。补上第 4 条，逐字写明：
① 动态 `await import()` 不可见；② 新建第三模块再被调用不可见（**连往 `src/` 新增模块这件事本身也无人出声**）；
③ *** **`resumeLoop.ts` 完全不在判据视野内** *** —— 它今天没 import `writeRunState`，但没有任何东西阻止它明天 import。
⚠️ 这是**把自陈边界改成与实际一致**，**不是**新增保证。**不要**顺手扩大解析范围（那是扩权，未获授权）。

**(c) 两处承重措辞加勘误。** *** **本仓库的规矩是加勘误，不是覆盖 —— 原句一律保留，不许悄悄改软。** ***
- `src/persistence/fileStore.ts` 的 `publishReconciliationUnderTransferLock` 上方注释里那句
  「**Two lock spans cannot interleave**」：*** **该前提已被实测证伪** ***。
  勘误要逐字写明：`acquireOwnerTransferLock` 的 `open(lockPath,"wx") → handle.writeFile(...)` 之间锁文件是 **0 字节**，
  闯入者的 `tryRecoverStaleOwnerTransferLock` 在 `catch` 分支**从不调用 `isProcessActive`**，
  只要有 staged artifacts 就 `safeUnlink` 放行 ⇒ **活持有者的锁会被夺走，两个锁跨度能交错**。
  控制器已用**真双进程**复现（台账 §21.1，含必命中与必不命中两条对照）。
  **注明这是已知未修的 Critical（C-1），修法待人裁，本轮刻意不修。**
- `tests/persistence/fileStore.test.ts` 里 `recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker`
  那段夹具注释中的「**(unrelated, already-known)** zero-length lock window」：
  *** **`unrelated` 在 D2 之后不成立** *** —— 这条测试存在的目的就是证明「同一时刻只有一个 finalizer」，
  而零长度窗口正是让该结论为假的那条路径。同样**加勘误、保留原句**。
  ⚠️ **不许改这条测试的任何断言与夹具行为**（改夹具会改变它测的东西）。

### 2.2 纯新增测试：D2 自己那条 reconciliation 重试（Lane 2 的 I-2）

**事实**：`RECONCILIATION_LOCK_RETRY_ATTEMPTS` / `RECONCILIATION_LOCK_RETRY_DELAY_MS`
（`src/persistence/fileStore.ts`，`acquireOwnerTransferLockForReconciliation`）在整个 `tests/` 下**零引用**；
把 attempts 打到 1（＝把重试整条拆掉）**全套件仍全绿**（Lane 2 实测）。
resume 侧与转移侧各有一对「清空 / 耗尽」判据，**第三处一条都没有**。

**你要做**：新增测试（**纯新增，不动任何既有判据**），形状照抄既有的
`retries a busy owner-transfer lock and completes once it clears (spec requirement 1)`：
让 `.owner-transfer.lock` 第一次 acquire 时忙、随后空出来 ⇒ 断言 boundary write **完成**
且 `reconciliation_write_abandoned` **未出现**；再补一条耗尽侧的。
*** **验收硬条件**：把 `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 改成 1，**你的新测试必须变红**；改回 3 必须变绿。
两次都要有实测输出。**没有这条实测，这一项不算做完。** ***

### 2.3 需要**第五个具名例外**的两条（**人裁 48 已授权**，仅限下面点名的改动）

*** **人裁 48 = 第五个具名例外。它只覆盖 2.3 这两项点名的改动，不得外推到任何其它既有判据。** ***

**(a) 三种终态的所有权拒写判据（Lane 1 的 I-1）。**
**控制器已亲验**：把守卫对 `exhausted` / `blocked_waiting_human` / `succeeded` 放行，
**全套件 524/524 全绿**（日志整份读回）；同手法放行 `failed` / `cancelled` **会红**（必红对照，证明变异面是活的）。
⇒ 这三种终态的所有权拒写**零判据**，而它们都**不在 `RESUMABLE_STATUSES` 内**，
即与 `cancelled`/`failed` 一样会让别人的 run 不可恢复 —— **正是 Critical F-1 的损害形状**。
**你要做**：新增覆盖这三种终态的拒写判据，形状照抄既有的
`refuses to write a terminal failed status into a run a different owner holds`。
*** **验收硬条件**：把守卫对这三种终态放行（同控制器那次变异），**你的新判据必须变红**；还原后必须变绿。
两次都要有实测输出。 ***

**(b) 重试次数与退避常数的绝对值断言（Lane 1 的 I-3 ＝ Lane 2 的 I-1）。**
**两条耗尽断言写成了 `expect(...).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` —— 左右同源、恒真**
（`resumeLoop.integration.test.ts` 的 `claimCalls` 与 `leaseLifecycle.integration.test.ts` 的 `writeCalls`）。
**控制器已亲验**：`3 → 2` 全套件全绿；`3 → 1` 红 2 条 ⇒ **钉住的只有下限 2，「3」这个数字零执行机制**。
**你要做**：**新增**字面量断言把人裁 38 批准的「3 次 / 约 100ms（= 2 × 50ms）」钉死。
⚠️ *** **不要删除、也不要改写那两条既有的自指断言** *** —— 它们钉的是「调用次数等于配置值」这件事，
本身没错，错的是**没有任何东西钉住配置值本身**。**只加不减。**
⚠️ **产品代码里的 3 与 50 不许动**（人裁 38 批准的就是这两个数）。
*** **验收硬条件**：把常数改成 2（以及退避改成别的值），**你新增的断言必须变红**。 ***

### 2.4 行为改动：resume 的误拒（Lane 1 的 I-4）

**缺陷**：`readOwnerRecord` 会先跑崩溃恢复（取锁、读 marker、三次 rename），
而**无守卫**的 `readReconciliationRecord` 与它在同一个 `Promise.all` 里**同时发起、并不等它**。
事务 `finalizeOrder = [owner-transfer.json, owner-record.json, reconciliation-record.json]` 有真实缺口：
前两个已落地、第三个尚未 ⇒ `reconciliation-record.json` 缺席 ⇒ ENOENT ⇒ 外层 catch 转成
`ResumeNotEligibleError("cannot read run artifacts: …")`。
*** **它不是崩溃、不是数据丢失**（既有说法「会炸」已被两条 lane 独立证伪）**，
而是「事务提交窗口内崩溃的 run，首次 resume 必被误拒且归因错误」**（第二次自愈）。 ***

**修法（Lane 1 建议，人裁 48 批准）**：把 `readOwnerRecord(runDir)` 从 `resumeLoop` 的 `Promise.all` 里
**提出来先 `await`**（它本来就是那几个读里唯一带副作用/做恢复的一个），再并行读其余项。
不新增保证、不改任何现有断言，且与 `readOwnerRecordWithoutRecovery` 在 leaseGate 的既有「谁做恢复」分工一致。

*** **硬要求：必须同时补一条回归判据，且它必须靠断言变红、不是靠异常/超时变红。** ***
理由：本仓库已稳定复现两个根因形状 —— 「一个没有执行机制的完整性断言」与
「测试靠异常/超时变红而不是靠断言变红」。**一个没有判据的行为修复就是在第五次复现前者。**
*** **验收硬条件**：先写判据、在**未修**的代码上证明它红（红在断言上，附输出）；再修，证明它绿。
两次输出都要进报告。 ***

## 3. ⛔ 你**不做**的（越界即是缺陷）

- ⛔ **不修 C-1**（那把跨进程锁）。它的修法落在**待裁点 B** 的地界，**人正在单独裁**，另有一名只读设计员在做材料。
  你只做 2.1(c) 的**勘误**。**一行产品代码都不许碰 `acquireOwnerTransferLock` / `tryRecoverStaleOwnerTransferLock`。**
- ⛔ **不碰待裁点 A / B / C**。
- ⛔ **不扩大结构判据的解析范围**（那是扩权）。
- ⛔ **不动任何其它既有判据** —— 第五个具名例外只覆盖 2.3 点名的两项。
  需要动别的，**停下来写进报告问人**，不要自己决定。
- ⛔ **不碰包 1 的任何东西**（`.superpowers/sdd/2026-08-07-pkg1-l5-spec/` 及其 spec）——另一条线。

## 4. 铁律

1. **验证跑绝不过滤** —— `grep` / `tail` / `sed` 同罪，**过滤显示与过滤落盘同罪**。整份落盘、整份读回。
2. **坏探针不能证明「不存在」** —— 下全称否定前放一条必命中的 sanity 探针证明检索面是活的。
3. *** **读代码的机械论证不等于实测** *** —— 凡结论涉及「会不会发生 / 红不红」，就跑。
4. **验证命令一律 `rtk proxy`**；环境 `ECC_GATEGUARD=off DISABLE_OMC=1`。
5. **不接受自证** —— 你之后会有一名**换人**的独立评审员来验你。报告里**每一条承重结论都要附可复现的实测输出**。
6. **举证责任没有被免除**（人裁 13 的原话）：任何终态断言必须覆盖**两种交错**，
   只钉单一顺序 = 2026-08-02 那次 Human ruling 杀掉的同一条 damaged trajectory 换个名字。
7. **commit message 一律英文**。**报告与台账用中文**（本仓库惯例）。
8. **Rule 12 —— fail loud**：跳过了什么就明说。**「完成」里含任何静默跳过都是错的。**

## 5. 报告骨架（先落盘这几个标题）

```
# 包 2 整分支评审修复环 —— 实施报告
## 0. 结论（最先填：每一项 DONE / BLOCKED / 未做，一目了然）
## 1. 我自己的基线（未过滤）
## 2. 2.1 文档类三项：改了什么、原句是否保留
## 3. 2.2 D2 重试判据：新测试 ＋ 变异红/绿双向实测
## 4. 2.3(a) 三终态判据：新判据 ＋ 变异红/绿双向实测
## 5. 2.3(b) 常数绝对值断言：新增断言 ＋ 变异红实测（并证明既有自指断言未被删改）
## 6. 2.4 resume 读顺序：先红后绿的判据实测 ＋ 修法 diff
## 7. 最终验证（全套件 ＋ typecheck ＋ build，未过滤，RUN 路径已核）
## 8. 我没做的 / 我被挡住的 / 需要问人的
## 9. 预算：harness 可数事实（不要自报估计）
```

## 6. 预算

**人裁 45：预先放行、记账不停。** ⚠️ **不要自报预算估计** —— 一律以 harness 实测为准。
§9 只写可数事实（跑了几次全套件、做了几次变异、改了哪几个文件）。**拿不到精确数字就说拿不到。**
