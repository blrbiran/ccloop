# 任务 2 brief — 债 2：加所有权守卫（修法）

## 一句话

`persistTerminalState` 会往**本进程已不再拥有**的 run 写终态。任务 1 已用实跑注入钉住了这个缺陷。
**你的任务是修它。**

## 前置事实（任务 1 已建立，三方独立撞过，可以当既成事实用）

- `persistTerminalState`（`src/controller/runLoop.ts`）**函数体内零次 `readOwnerRecord`** —— 今天没有守卫。
- 全仓 **15 个调用点**，其中 **4 个**由 lease-loss 到达。
- ⚠️ *** **四个 lease-loss 检查点不等价**：其中 `:1514` 那个**比另外三个多一层
  `isTerminalRunStatus` 门槛**。 *** **设计守卫时不许假设四处行为相同** —— 这是任务 1 评审
  留下的 deferred minor，专门转给你。**自己去核这四处，不要照抄这句话。**
- 任务 1 的测试：`runLoop > writes an unresumable cancelled status into a run a different,
  current owner already holds when this process's own lease is lost`
  控制器已独立复现其三步判据：抑制 `writeRunState` 即红在
  `expect(persisted.status).toBe("cancelled")`（`persisted` 来自 `readRunState(runDir)`，**磁盘**）。

## 你要做的

1. **给这条路径加所有权守卫**，让本进程在**已不拥有该 run** 时不再写终态。
2. *** **翻转任务 1 那条测试** ***：它现在钉的是**缺陷行为**，修完必然红。
   把它改成钉**修复后的正确行为**（守卫拒绝写、别人的 run 未被污染），**测试名也要跟着改**。
   ⚠️ **这一条是本任务明确授权的**：那是本轮自建的测试，不是历史判据。
   *** **但这份授权到此为止** —— 任何**其它**既有测试判据一律不许改（人裁 4）；
   第 4 笔那条 2026-08-02 Human ruling 的判据有单独的人裁 13，**与本任务无关，不得援引**。 ***
3. **守卫位置是设计裁决，你要在报告里给出理由**：加在 `persistTerminalState` 内部（一处覆盖 15 个
   调用点）还是加在调用点上？两种选择对那 15 个调用点分别意味着什么？
   *** **`:1514` 那处的额外门槛在你的方案下会怎样？必须专门回答。** ***
4. **守卫触发时的行为**也要有理由：静默返回？返回原状态？记事件？
   ⚠️ 本仓库有一条相关立场：**「无界垃圾不是故障」不等于「静默失败可接受」** ——
   `writeBoundaryArtifacts` 那条「a genuine silent failure」的先例就在 `runLoop.ts` 的注释里，
   **去读它，别自己发明一套**。

## 最危险的地方（本任务的主要风险，请当成主线而不是附注）

加守卫**很可能弄红一批既有测试**。本仓库有直接先例（`task-A9-report.md` 记过一次同形）。

*** **逐条判定每一条变红的既有测试，二选一，并在报告里逐条写明理由：** ***
- **(a) 真回归** —— 你的修法破坏了正确行为 ⇒ **改你的修法，不是改测试**。
- **(b) 该测试本身依赖了缺陷行为**（它假设「能写进别人的 run」）⇒ 这属于**发现文档/测试的论据在
  今天代码上不成立**，按铁律：*** **原样上报给控制器，不许自己改判据**。 ***

⚠️ *** **绝对不许**：因为某条既有测试红了就顺手把它改绿。**那正是人裁 4 禁止的那件事。** ***
**拿不准 (a) 还是 (b) 就停下来问控制器**，不要自己裁。

## 铁律（不许打折）

- **三步判据**：你的修法落地后，翻转后的测试要证明有鉴别力 —— **撤掉守卫必须让它红**，
  恢复守卫必须复绿。每个单跑块显示具名测试的**非零**计数；做完**还原**，`git status` 干净。
- **落盘协议**：先 `Write` 只有小节标题的报告骨架并**立刻落盘**（在此之前不做任何检索），
  之后每次 `Edit` 只填一节，**结论一节最先写**。
- **探针纪律**：探针写成脚本**先落盘**，再 `rtk proxy zsh <script>` 跑，
  **同跑内放一条必命中的 sanity 探针**；**验证跑绝不过滤输出**（`grep` 与 `tail` 同罪）；
  **下全称否定前先确认 grep 面覆盖你断言的范围**；**零输出时先验命令本身**；
  **锚点用符号名不用行号**。
- **完工前必须跑全套件 ＋ `tsc --noEmit` ＋ `npm run build`，未过滤，并核 vitest 首行 `RUN` 路径。**

## 环境与 flake

- 工作目录 `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`，分支 `feat/pkg2-data-loss`，已 `npm ci`。
- `export ECC_GATEGUARD=off DISABLE_OMC=1`；用 `./node_modules/.bin/vitest`、`./node_modules/.bin/tsc`。
- **本任务基线**：`Tests 1 failed | 513 passed (514)` ＋ 任务 1 新增 1 条 = **515**；
  **唯一允许的红**是 flake (B)：`tests/validation/evidence.test.ts > run-scenario CLI >
  records env names only and tracks descendants rooted at the spawned pid`（`Test timed out in 5000ms`）。
- 另有一条**名单外**的、人裁 10 已挂账、**见到按名比对不要重新调查**：
  `runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess
   adapter without recomputing controller totals`（全套件约 1/6 红，隔离 0/8，根因未证）。
- **名单外的其它失败一律按新缺陷处理**，必须先捕获完整测试名与失败块再比对。

## 交付

- **代码**：提交到 `feat/pkg2-data-loss`，可多笔。
- **报告**：`.superpowers/sdd/2026-08-07-pkg2-data-loss/task-2-report.md`，**必须 `git add -f`**。
- **报告骨架（先落这个）**：
  1. 结论（**最先写**）：守卫加在哪、为什么、债 2 是否已修掉
  2. 四个 lease-loss 检查点逐个核实的结果（**含 `:1514` 那层额外门槛在我方案下的行为**）
  3. 守卫触发时的行为选择与理由
  4. 翻转后的测试：新名字、新断言、为什么这个形状能失败
  5. **三步判据的完整证据**（命令 ＋ 未过滤输出 ＋ 具名测试非零计数）
  6. **变红的既有测试逐条裁定**（(a) 真回归 / (b) 依赖缺陷行为 —— 后者只上报不自改）
  7. 全套件 ＋ typecheck ＋ build 的未过滤输出
  8. 我用过的每条命令与它当时的输出（含 sanity 探针）
  9. 我**没有**验到的部分（如实列）
  10. 我自己发现并修掉的问题
  11. 预算记账（上限 100,000，破了明写）

## 返回给控制器的（只要这些）

状态、提交 hash、报告路径、守卫位置一句话、三步判据一行小结、**变红的既有测试有几条及其裁定**、
自报没验到的部分、预算记账。**不要贴报告正文。**
