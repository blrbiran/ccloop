# 任务 1 brief — 债 2：补实跑注入，钉住「今天可达且是数据丢失」

## 一句话

`persistTerminalState` **没有所有权守卫**，会往**本进程已不再拥有**的 run 写终态。
今天这条路径**只有静态论证、没有实跑注入**。**你的任务是补上注入，不是修它。**

## 范围（硬边界，越界即失败）

✅ **你要做的**：写测试，**实跑**证明这条路径今天可达、且后果是数据丢失。
❌ **你不要做的**：**不要修它**。不要给 `persistTerminalState` 加守卫，不要改它的调用点。
   修法是任务 2 的事，且是一次设计裁决（牵动 15 个调用点），**必须建立在你这轮的注入实验之上**。
❌ **不许改任何既有测试的判据**（人裁 4 逐字：授权的是补测试，**不含为了让测试变绿而改判据**）。
   ⚠️ 本包确有一条**具名例外**（人裁 13），但它**只针对第 4 笔的那一条测试**，
   **与债 2 无关，不得援引到本任务**。
❌ **发现文档/报告的论据在今天代码上不成立** —— **原样上报，不许自己改判据**。

## 你的新测试应该是什么形状

它必须**能失败**：一个「无论代码怎么变都绿」的测试等于没写（本仓库 Rule 9：
测试要编码 WHY，不只是 WHAT）。具体要求：

1. **实跑注入**，不是静态断言。要真的走到 `persistTerminalState` 写出终态那一步。
2. **断言的是数据丢失这件事本身**（本进程已不拥有该 run，却把终态写了进去 / 覆盖了他人的状态），
   不是某个中间变量长什么样。
3. ⚠️ **它今天应该是绿的**（因为缺陷今天就存在，你是在钉住现状）。
   **所以你必须用三步判据证明它有鉴别力**：
   - **注入前绿**（当前代码，你的新测试通过）
   - **注入后红**：往 `src/` 里注入一个**反向变异**（例如给 `persistTerminalState` 加上
     所有权检查、让它拒绝写），你的测试必须**变红** —— 这证明它真的在测这条路径
   - **还原后绿**：撤掉变异，恢复通过
   **每个单跑块必须显示具名测试的非零计数**（`1 passed` 之类，不能是 `0 matched`）。
   **变异做完必须还原，`git status` 必须干净。**
4. 测试文件位置与命名**照既有约定**（Rule 11：Conformance > taste）。

## 先读这些（都是线索，不是结论）

- `.superpowers/sdd/2026-08-07-pkg2-data-loss/scan-1-report.md` —— 扫描员 1 的今日代码面重核。
  他的债 2 结论：`persistTerminalState` **15 个调用点、其中 4 个由 lease-loss 到达**；
  `cancelled: []` 无出边且 `RESUMABLE_STATUSES` 不含 `cancelled`。
  ⚠️ *** **这是单方证词，控制器没有复核过。你必须自己再撞一次，不许照抄。** ***
- `.superpowers/sdd/2026-08-07-pkg2-data-loss/scan-2-report.md` —— 他判债 2 是「**补**」不是「改」
  （未找到既有实跑注入测试）。**同样是单方证词，自己验。**
- `.superpowers/sdd/2026-08-05-l5-input-scan/progress.md` 的「扫描员 A」节与
  同目录 `scan-A-debt2-lock-abort.md` —— 债 2 的原始论证。
- `.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` —— 本包台账，人裁 4/10/11/12/13 全在里面。

## 铁律（不许打折）

⚠️ *** **落盘协议**：先 `Write` 一个只有小节标题的报告骨架并**立刻落盘**，在此之前不做任何检索；
之后每次 `Edit` 只填一节，**结论一节最先写**。 *** （本仓库一会话 12 名 agent 死 6 名，全在准备落盘时。）

⚠️ *** **探针纪律**：探针写成脚本**先落盘**，再 `rtk proxy zsh <script>` 跑，
**同跑内放一条必命中的 sanity 探针**证明检索面是活的。 ***
- **验证跑绝不过滤输出**（`grep` 与 `tail` 同罪）。**不许 `| tail -N` 后凭印象归因。**
- **下全称否定前先确认 grep 面覆盖你断言的范围**；**零输出时先验命令本身** ——
  *** 一条被转义弄坏或被过滤的探针，永远不能证明「不存在」。 *** （三方三次同形，全在这一步栽。）
- **锚点用符号名，不用行号**（本项目已有六处失效行号引用案底）。

## 跑测试的环境

- `export ECC_GATEGUARD=off DISABLE_OMC=1`
- 用 `./node_modules/.bin/vitest` 与 `./node_modules/.bin/tsc`（`npx tsc` 会解析到别的缓存工具链）
- **只有 flake (B) 与 (F) 允许出现**，名单外一律按新缺陷处理，**必须捕获完整测试名再比对**。
  已知一条**名单外**的（人裁 10 已挂账，见到它按此比对、**不要重新调查**）：
  `tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the
   subprocess adapter without recomputing controller totals` —— 全套件约 1/6 红、隔离 0/8，根因未证。
  (B) = `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks
   descendants rooted at the spawned pid`（`Test timed out in 5000ms`）—— **本轮基线里它就是红的。**
- **本任务的基线**（控制器亲跑，你不必重跑全套件来确认）：
  `Tests 1 failed | 513 passed (514)`，唯一红是上面那条 (B)；`TYPECHECK_EXIT=0`、`BUILD_EXIT=0`。

## 交付

- **代码**：新测试，提交到当前分支 `feat/pkg2-data-loss`。**一个任务可以多笔提交。**
- **报告**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/task-1-report.md`
  ⚠️ `.superpowers/sdd/.gitignore` 是 `*` —— 报告**必须 `git add -f`** 才能入库。
- **报告骨架（先落这个）**：
  1. 结论（**最先写**）：注入是否建立？债 2 今天是否可达且丢数据？
  2. 我重核扫描员 1 那三个数的结果（15 / 4 / `cancelled` 两条）—— 成立还是腐坏
  3. 新测试写了什么，为什么这个形状能失败
  4. **三步判据的完整证据**（三次跑的命令 ＋ 未过滤输出 ＋ 具名测试的非零计数）
  5. 我用过的每条命令与它当时的输出（含 sanity 探针）
  6. 我**没有**验到的部分（如实列，不许留白）
  7. 我自己发现并修掉的问题（本仓库十六波修复十六次自带缺陷，仅一次由作者自查发现 —— 请打破它）
  8. 预算记账（上限 100,000 tokens，破了明写，不许静默）

## 返回给控制器的（只要这些，不要贴报告正文）

状态（DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED）、提交 hash、报告路径、
三步判据的一行小结、你自报没验到的部分、预算记账。
