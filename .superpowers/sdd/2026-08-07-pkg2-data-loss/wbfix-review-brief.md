# 包 2 整分支评审修复环 —— 独立评审 brief（**换人**）

> 你是**独立评审员**，**不是实施者**，**没有参与过这一轮的实施**。
> *** **不接受实施者自证** —— 实施报告里的每一条承重结论都是**待检验的断言**。 ***
> 本仓库已有实证：独立评审员实跑证伪了实施者钉住的承重前提，换来了一条 Critical。

## 0. 工作区与落盘协议（**先做这一步，做完再开始检索**）

- **工作区**：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix`（分支 `feat/pkg2-wb-fixes`，依赖已 `npm ci`）。
  ⛔ **绝不要碰主仓库**；⛔ 不得 `git commit` / `push` / 建删分支 / 合并；⛔ **不得留下任何未还原的改动**。
- **允许为验证做临时变异**（这是你的主要武器），**但必须证明还原**：变异前确认 `git status --porcelain` 干净，
  还原后**同时**验 `git diff` 与 `git diff --cached` 均为 **0 字节**（`git checkout <commit> -- path` **会进暂存区**）。
- **报告**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/wbfix-review.md`。
  **立刻** `Write` 出只有小节标题的骨架并落盘，之后每次 `Edit` 只填一节，**结论一节最先填**。

## 1. 评审范围

**分支上的全部改动：`git diff dbac288..HEAD`**（6 个文件 ＋ 报告）。
实施者的自陈在 `wbfix-impl-report.md`；本轮的任务书在 `wbfix-impl-brief.md`。**两份都只是线索。**

⛔ **不在范围**：C-1 的修法本身（待裁点 B，另有只读设计员的 `pointB-design.md`，人正在裁）；
待裁点 A / B / C；包 1（`.superpowers/sdd/2026-08-07-pkg1-l5-spec/`，另一条线）。

## 2. 你必须自己实测的六件事（**逐条给出你自己的输出，不许引用实施者的**）

1. **2.2 D2 的 reconciliation 重试判据**：把 `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 改成 1，
   新判据是否变红？*** **红在断言上，还是红在异常/超时上？** *** 还原后是否变绿？
2. **2.3(a) 三种终态的所有权拒写判据**：把守卫对 `exhausted`/`blocked_waiting_human`/`succeeded` 放行，
   三条新判据是否**各自**变红、**红在断言上**？既有的 `failed`/`cancelled` 两条是否保持绿？
3. **2.3(b) 常数的绝对值断言**：把 `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` 改成 2、把退避常数改成别的值，
   新增断言是否变红？*** **并核实那两条既有的自指断言 `toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` 一条都没被删改。** ***
4. **2.1(c) 两处勘误**：原句是否**逐字保留**（不许被改软）？勘误里的每一句**事实陈述**是否成立？
   ⚠️ 勘误里如果有任何一句**说过头**（overclaim），那本身就是本仓库反复咬人的那个形状，要报出来。
5. *** **有没有动到第五个具名例外（人裁 48）点名之外的既有东西？** ***
   ⚠️ 实施者自己披露了一件：为 2.2 它在 `fileStore.test.ts` **既有的 `vi.mock("node:fs/promises")` 工厂**里
   加了一个**透传的 `open` spy**（自称只观测、全部转发）。
   **你要自己验**：它是否真的全部转发、有无行为改变；并按本仓库那两种「既有」口径**分别裁断**
   （口径 A ＝ 任务之前 ／ 口径 B ＝ 本修复环之前）。**不要替人消解口径。**
6. **分支尖端是否真绿**：全套件 ＋ typecheck ＋ build，**`rtk proxy`、未过滤、整份落盘整份读回、核 vitest 首行 `RUN` 路径**。
   实施者自报 `31 files / 529 tests / 三个退出码 0`（基线 524 ＋ 5 条新）——**自己跑一遍，不继承**。

## 3. 那一项 BLOCKED（**这是要交给人的材料，必须准**）

**2.4 resume 的读顺序**：实施者说把 `readOwnerRecord` 从 `resumeLoop` 的 `Promise.all` 里提出来先 `await`，
会让 `fileStore.test.ts` 的 `refuses resume at every pre-commit crash gap of the three-file transaction…`
矩阵里 *** **gaps 05–13 两个夹具共 18 行从 `resume=refused` 翻成 `resume=accepted`** ***（01–04 不变），
因此它**推翻了任务书里「不改任何现有断言」那句话**，遂就地停住、把修法保留成 `f584bb6` 并由 `5026bea` 回退。

*** **你要独立验这三件事**： ***
(a) `f584bb6` 的产品改动**确实**造成那 18 行翻转吗？**行数与 gap 编号对不对？**（cherry-pick 到临时状态实测，然后还原）
(b) 它配的那条回归判据，在**未修**的代码上是否**红在断言**（而不是红在异常/超时）？
(c) 实施者给的两条「不该由它决定」的理由是否成立 ——
    ① 那个矩阵的注释是否**真的**自陈「当前交错正是让两条 `evaluateResumeEligibility` epoch 判据承重的原因」（**逐字引**）；
    ② 「permit more resumes」是否**真的**撞上仓库既有的 S-3「绝不放宽」立场（**找到那条立场的原文，逐字引；找不到就说找不到**）。

## 4. 铁律

1. **验证跑绝不过滤** —— `grep` / `tail` / `sed` 同罪，**过滤显示与过滤落盘同罪**。
2. **坏探针不能证明「不存在」** —— 下全称否定前放一条必命中的 sanity 探针证明检索面是活的。
3. *** **读代码的机械论证不等于实测。** *** 凡结论涉及「红不红 / 会不会发生」，就跑。
4. **验证命令一律 `rtk proxy`**；环境 `ECC_GATEGUARD=off DISABLE_OMC=1`。
5. *** **finding 与它的「处置建议」分开写** ***，并明说这一项**是否应该在本轮修**。
   （控制器上一轮只读了 finding 就派工，做了评审员明说不该做的修改。）
6. **锚点用符号名 / 完整测试名，不要用行号。**
7. ⛔ **你不修任何东西**，只报。**Rule 12 fail loud**：没验到的明说。

## 5. 允许出现的红（其余一律按新缺陷处理）

- flake (B) `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
- flake (F) `continues normally when execute returns a complete result during the recovery window`
- 已挂账不重查：`persists phase usage evidence from the subprocess adapter without recomputing controller totals`（人裁 10）；
  `subprocessClaudeAdapter … waits for close before interrupting a close-pending successful execute`、
  `evidence.test.ts > finalize-review CLI > rejects unknown verdicts and diagnoses`（台账 §21.5，负载敏感）

## 6. 报告骨架（先落盘这几个标题）

```
# 包 2 修复环 —— 独立评审报告
## 0. 结论（最先填：每项 ADDRESSED / NOT ADDRESSED / 越界，以及有无新破坏）
## 1. 我自己的基线与分支尖端验证（未过滤，RUN 路径已核）
## 2. 五项已完成项的逐项独立实测（变异红 / 还原绿，并判断"红在断言还是红在异常"）
## 3. 越界核查：第五个具名例外之外有没有被动到（含 vi.mock 工厂那一处，两种口径分别裁）
## 4. 勘误措辞核查：原句是否保留、有无 overclaim
## 5. BLOCKED 那一项：18 行翻转、判据红法、两条理由的逐字核验
## 6. Findings（分级，finding 与处置建议分开写）
## 7. 我的临时变异与还原证明
## 8. 我没能验到的、以及为什么
## 9. 预算：harness 可数事实（不要自报估计）
```

**预算**：人裁 45 预先放行、记账不停。⚠️ **不要自报估计**，只交可数事实。
