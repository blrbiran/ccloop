# CLAUDE.md

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
**Per-task: 330,000 tokens. Per-session: 450,000 tokens.**

⚠️ *** **单位是【上下文窗口占用】，不是【累计消耗 token】。** *** 这两个量差好几个数量级。
`docs/handoff/handoff.md` 的预算表按"累计消耗"读过这条，因而宣布某会话「远超 Rule 6」——
**那是读法错了，不是数字错了**。按"上下文窗口"读，330k/task 与实测的舒适区间 300K–450K 几乎重合。

**累计花费是另一个数** —— 只抄工具报出来的，拿不到就说拿不到（Rule 14）。

If approaching budget, summarize and start fresh. **Surface the breach. Do not silently overrun.**

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

---

# 铁律（**违反即事故**）

> ⚠️ **这几条此前只住在 `docs/handoff/handoff.md` 里** —— 而那是一份**允许整篇重写、且多 agent 共享**的活文档。
> 最承重的规则住在最不稳定的文档里，任何一次重写都可能把它们写没了，且没有机制会发现。
> *** **从本次起，本文件是这几条的权威副本。** *** handoff 里的原文暂时保留（那一轮还在飞，不动它），
> **两处若有出入，以本文件为准。**

## Rule 13 — 四件事需人单独授权
**开门**、**合并**、**删分支或 worktree**、**push**。
*** **控制器不许 push。** *** 非门合并一律 `--ff-only`。
**每一次都要单独点头**，不因上一次批准过而自动延续。

## Rule 14 — 证据纪律
- *** **绝不过滤验证性跑。** *** `grep`/`tail`/`head`/`sed` 都算过滤，**管道还会吞掉退出码**。
  一律**重定向到文件再整份读回**，并核 vitest 第一行 `RUN` 指向的路径。
- *** **成本、耗时只报工具给出的数。拿不到就说拿不到，【不许自估】。** ***
- **行号、字节数、测试条数引用前必须现测**，且**报字节数必须连口径一起报**。

## Rule 15 — 不许实施者自改判据
**改既有判据**必须由人**指名到具体测试**，三条件缺一不可：
(a) 指名 (b) 整条改写、不许放宽 (c) 改后写明编码的是哪条人裁。
⇒ **需要新覆盖时先想「能不能只加不改」。**

## Rule 16 — 历史与已发布文本只能追加
- **`.superpowers/sdd/**` 里的历史记录一个字不改**；写错了 ⇒ **在新一节里记更正**。
- **已发布的注释／ERRATUM**（`git ls-remote` ＋ `git merge-base --is-ancestor` 说了算）
  ⇒ **原文逐字保留 ＋ 追加具名 ERRATUM**，不许就地改。
  就地改**只**适用于：本会话自己刚写、从未为真、且未发布的笔误。
- ERRATUM 里**不许写会被后续裁决推翻的计数**，**不许引用会移动的 git 引用**（"HEAD"、"remote tip"）。
- **改判据或注释前要做全树扫描**，扫描清单**从被更正的句子机械导出**。

## Rule 17 — 变异只在副本里
变异／故障注入**只在 `git clone --local` 副本里**做，主仓库工作树全程零触碰。
还原证明看 `git diff` 与 `git diff --cached` 的**字节数**。
⚠️ 副本是 clone【已提交】状态 —— 要测**未提交**的改动，必须先 `cat 工作树文件 > 副本对应文件`。
⚠️ **代码改了以后，之前跑过的变异要重跑。**

## Rule 18 — 不许替人宣布
人裁由人亲自拍。控制器**不得代为宣布**任何一条裁决。
⚠️ 该规则在多 agent 规模下的局限，已在 Orca 的 spec §0.1／§1 中分析并提出替代；
*** **但那套替代【不适用于本仓库】** *** —— 见 Orca spec §7。**本仓库照旧执行本条。**
