# 第 4 笔 —— 只读设计员 brief（**不写任何代码**）

**工作区**：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`，分支 `feat/pkg2-4th`，BASE `3753495`。
**你是只读的**：不改 `src/`、不改 `tests/`、不改 spec、不改 plan、不 commit 代码。
**唯一产物**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/task-4th-design.md`。
**允许**为验证做临时变异**并且必须证明还原**（`rtk proxy git diff` 原始输出为空 ＋ 变异标记零命中 ＋ sanity 探针命中）。

---

## 0. 先落盘，再检索（硬性）

第一件事：`Write` 一份只有小节标题的骨架 `task-4th-design.md` 并**立刻落盘**，在此之前不做任何检索。
之后每次 `Edit` 只填一节，**结论一节最先写**。
（历史：曾有一会话 12 名 agent 死 6 名，全部发生在准备落盘那一刻。）

---

## 1. 你要设计什么

**第 4 笔 = 关闭「输家拿着已过期的观测写下降级 reconciliation 记录」这个残余 TOCTOU。**

已知的两种形状（**你要自己核实，并判断是不是同一条**）：

**形状 A —— T0/T1/T2 的 ENOENT 过期观测**
`docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:906` 逐字：
> **它不关闭 §4.3 的 T0/T1/T2 残余 TOCTOU。** T0 那次 ENOENT 是「确定没有赢家」的**真实**观测，只是这个观测在 T2 已经过期。**把 ENOENT 也一并 fail-closed 会关闭它，但代价不可接受** —— 那等于让绝大多数 run **再也不写 `reconciliation-record.json`**。那不是「增加拒绝」，那是删掉一条正常路径上的产物。**残余具名传 L5（§13 第 4 笔），本层不修。**

**形状 B —— epoch 过期**
`tests/controller/runLoop.integration.test.ts` 那条具名测试上方注释块逐字：
> It does NOT pin "the winner was not overwritten". It cannot: the check returns false here (owner-record.json is still the old epoch — P1's rename #2 has not happened), so the loser **does** go on to write its downgraded record, which is exactly the shape of the residual TOCTOU this layer leaves open (§13, 4th entry).

*** **形状 A 的最显然修法已被上面那段逐字否掉，且给了理由。你不许无视那个理由。** ***
你可以论证「今天的代码让那个代价不再成立」，**但必须拿今天的代码证**，不许拿「时代变了」搪塞。

---

## 2. 举证责任（**人裁 13 扩权，但明确没有免除这两条**）

那条具名判据受 **2026-08-02 的一次 Human ruling** 约束，注释块自陈：
`Human ruling; the plan carries the matching in-place amendment note (Amended 2026-08-02 (d), §Task A9)`。
其中最承重的一句逐字：
> ⚠️ **No terminal-state assertion, deliberately.** "P1's third rename puts the winner's record back" is an ordering this harness imposes, not a property of the system — in production the loser's write may perfectly well land after rename #3. Asserting it as correct behaviour would **write a damaged trajectory into the suite**.

**你的方案必须正面回答这两个问题，不许绕过、不许含糊**：

1. *** **第 4 笔关闭之后，那条轨迹为什么就不再是 damaged？** *** 拿今天的代码证。
   注意这句话的要害不是「顺序对不对」，而是「**这个顺序是夹具强加的，不是系统性质**」。
   ⇒ 一个真正的关闭，应当让终态**不依赖谁先谁后**。如果你的方案关闭后终态**仍然**取决于调度顺序，
   **那就还是 damaged，你必须自己说出来。**
2. *** **这次改动推翻了 2026-08-02 那次 Human ruling 的哪一部分？** *** **逐字引原文**，指明推翻的是哪一句、
   保留的是哪一句。**不许静默覆盖。** 本仓库对「静默覆盖既有论证」零容忍（Critical F-1 就是这么来的）。

*** **「人已授权」不是论据。授权解除的是流程约束，不是举证责任。** ***

---

## 3. 你要交付的内容

**方案不是一个，是一组带代价的选项**（本仓库要控制器把选择权交给人，不许你替人选）：

1. **形状 A 与形状 B 是不是同一条 TOCTOU** —— 给出判定与理由。若是两条，**分别设计**。
2. **每个候选修法**都要给：
   - 机制（改哪个符号、改成什么，**用符号名不用行号**）
   - *** **爆炸半径：会弄红哪些既有判据，逐条具名列出。** *** 本仓库要求「先声明搜索面再断言」——
     **给出你用的命令与原始输出，并声明那是搜索面、不是完备性证明。**
   - **它有没有 2026-08-02 那层点名的那个代价**（让绝大多数 run 不再写 `reconciliation-record.json`），
     以及你怎么证明有或没有。
   - 关闭后**终态是否不再依赖调度顺序**（见 §2 第 1 条）。
   - 需要新的人裁扩权吗？若需要，**具名到那一条判据**。
3. **推荐哪一个、为什么** —— 可以有倾向，但**必须把落选项的代价也写全**，人要看得见取舍。
4. **预算与规模估计**：这次工作要动多少面、大致几个任务。
5. *** **你判定「做不了 / 代价不可接受」也是合格交付。** *** 上一位设计员就有一条如实写「无法判定」，记正面样本。
   **硬编一个能过关的方案，比诚实说做不了坏得多。**

---

## 4. 硬边界

1. **不写代码。** 临时变异只为验证，必须还原并证明。
2. **不碰三个待裁点 A / B / C**（L1/L2「读不许写」／`tryRecoverStaleOwnerTransferLock` 失败关闭／逃生口）
   —— **人明令先不裁，也不要重开方向讨论。**
3. **不碰包 1 的任何东西**（包 1 修复环 2 是另一条线，被冻着）。
4. **不改任何既有判据**，也不在设计里假定可以随便改：人裁 13 的扩权**只对那一条具名测试**，
   **其余一律要新的人裁**。
5. **不 push、不合并、不删分支、不开门。**
6. **台账 `progress.md` 由控制器写，你不要动。**

---

## 5. 验证纪律（铁律，逐条硬性）

1. **验证跑绝不过滤 —— `grep` 与 `tail` 同罪。** 全文 tee 落盘，再从盘上日志检索。
2. **验证性命令一律走 `rtk proxy`**。⚠️ 裸 `git diff` 经 hook 会吞掉原始输出（空 diff 也打一个字节），
   **还原证明必须用 `rtk proxy git diff`**。
3. 跑测试带 `ECC_GATEGUARD=off DISABLE_OMC=1`；核 vitest 首行 `RUN` 路径确实是本 worktree。
4. **检索脚本先落盘再 `rtk proxy zsh <script>` 跑**，不要在命令行嵌三层引号。
5. *** **每次检索必带必命中 ＋ 必不命中两条探针。坏探针永远不能证明「不存在」。** ***
   这条已咬过本仓库五个 agent，**每次都发生在下全称否定那一步**。
6. ⚠️ `git show "$commit:path"` 在 zsh 下被当成 `:s` 修饰符，静默出 0 且退出码 0 —— 用 `bash -c` 包一层。
7. **报不出可重数的计数，就不要报数字。** 本仓库的聚合数已多次不可重推。

**允许出现的 flake 只有两条**：
  (B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（`Test timed out in 5000ms`）
  (F) `continues normally when execute returns a complete result during the recovery window`
**另有一条已挂账、不入名单、不要重新调查**：
  `tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`（ENOENT `plan.json`）。
按**完整测试名**比对；**仍不得挥手放过**（人裁的是「暂不深挖」，不是「它无害」）。

---

## 6. 已知的、不要重新发现的事

- 那条具名测试的注释块自己说：**Mutation 2** 会连带弄红别处一批既有测试，名单在 `task-A9-report.md`
  —— *** **那批是噪声，不是本测试的护栏**；唯一算数的证据是该具名测试单跑变红。 ***
- 同一注释块还逐字说明 assertion (a) 钉的是**保护性读的前置条件**，**不是判定本身**，
  并列了两条「(a) 绿但判定从未被求值」的路径。**不要把 (a) 读大。**
- `preserveSuccessfulReconciliationIfNeededFromArtifacts`、`readPersistedReconciliationRecord` 的
  `catch { return undefined }` 在 2026-08-02 那层都有**明写的「不要顺手动」**理由，逐条在
  `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 的陷阱清单里。
  **你要动它们中的任何一个，必须逐字引用那个理由并说明为什么今天不再成立。**

---

## 7. 交付契约

写满 `task-4th-design.md`。**回给控制器只要**：状态（DONE / BLOCKED）、你给了几个候选方案、
你的推荐与一句理由、你判定必须由人裁的点有哪些、你做了几次临时变异且是否全部证明还原、
以及 **harness 实测预算实数（读得到就给，读不到就明说读不到，不给估计）**。
**不要把报告正文贴回来。**

⚠️ **你的方案不是终局** —— 控制器会把它交给人裁，**人批了才实施**。任务 3 就是这么走的（人裁 18）。
所以：**拿不准的地方如实标「未验 / 无法判定」，比写成已证实划算得多。**
