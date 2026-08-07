# SDD ledger — 包 2：今天可达的数据丢失，三条一起做（债 2 → 第 4 笔 → 第 1 笔）

授权来源：`.superpowers/sdd/2026-08-05-l5-input-scan/progress.md` 人裁 4（`:900`）＋ 工作包定义（`:942`）。
本会话开工令：人逐字答复「A. 包 2 开工」（2026-08-07）。

--------------------------------------------------------------------------------
0. 开工自查（控制器亲跑，未过滤）
--------------------------------------------------------------------------------

  `git log --merges` 末笔 = `e42e062 GATE-PKG3 PASSED`   <- **锚点成立，包 1 未开门**
  本地 HEAD = `ebd19cb`（handoff 那笔）
  `git ls-remote origin refs/heads/main` = `ebd19cb…`     <- **与本地一致**
  `git status --porcelain` = 干净

⚠️ *** **一处腐坏，就地记明、不改原件**：包 1 台账 `2026-08-07-pkg1-l5-spec/progress.md:854` 逐字写
「本轮未 push，远端仍在 `30cbdd5`（落后若干笔）」—— **现测远端已是 `ebd19cb`，与本地齐平**
（第七次会话外推送）。 *** 与整分支评审的 **Important F-I4（「远端一致/落后」判词已假）同族**，
**建议并入修复环 2 一并注解，不单开、本会话不改包 1 台账的结论层**。

--------------------------------------------------------------------------------
1. STEP 0 基线 —— ⚠️ 不绿，就地停住
--------------------------------------------------------------------------------

*** **结论：`TEST_EXIT=1`。这是本仓库第七处 STEP 0，也是第一处不绿的。** ***

命令（控制器亲跑、未过滤、全文落盘于 scratchpad `step0-pkg2.log`）：
  `export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy npm test -- --run` ／
  `./node_modules/.bin/tsc --noEmit` ／ `rtk proxy npm run build`

  `RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop`   <- 首行 RUN 路径已核，是仓库根
  ` Test Files  1 failed | 29 passed (30)`
  `      Tests  1 failed | 513 passed (514)`
  `TEST_EXIT=1` ／ `TYPECHECK_EXIT=0` ／ `BUILD_EXIT=0`

**与前六处的差**：前六处均为 30 files / 514 tests / `TEST_EXIT=0`。**文件数与用例总数一致，只是其中一条红。**

失败项（**完整测试名与失败块已捕获，未 `tail`、未凭印象归因**）：
  `tests/controller/runLoop.integration.test.ts > runLoop >`
  `  persists phase usage evidence from the subprocess adapter without recomputing controller totals`
  `Error: ENOENT: no such file or directory, open '…/ccloop-run-N9SMJh/attempts/1/plan.json'`
  抛点 `tests/controller/runLoop.integration.test.ts:3191`（`JSON.parse(await readFile(join(attemptDir,"plan.json")))`）

*** **该测试不在 flake 名单内。** *** 名单六条逐条对照**测试名**（不对行号，handoff `:1030` 的要求）：
  (A) 四条（`writes stale reconciliation…` / `persists owner transfer artifacts…` /
      `records retained cleanupStatus…` / `treats execute timeout…`）—— 无一匹配
  (A′) `caps phase timeout by the remaining runtime budget` —— 不匹配
  (B) `evidence.test.ts > run-scenario CLI > records env names only…` —— 不匹配（连文件都不同）
  (C) `leaseHeartbeat.test.ts > appends one lease_lost event…` —— 不匹配
  (D) 三条（`persists execution-recovery.json…` / `keeps changed-path…` / `writes an OWNER_LOST…`）—— 无一匹配
  (F) `continues normally when execute returns a complete result during the recovery window` —— 不匹配

⇒ 按 handoff `:1029` 铁律「**任何不在名单内的失败一律按新缺陷处理**」，**不挥手放过，转 §2 定性**。

--------------------------------------------------------------------------------
2. 名单外失败的定性调查（systematic-debugging）
--------------------------------------------------------------------------------

*** **已定的两条**：①**不是回归**；②**隔离不复现、只在全套件负载下出现**（1/4）。 ***
*** **未定的一条：根因。机制只有假说，未证。不许把它写成已证实。** ***

**证据 1 — 不是回归（控制器亲跑）**：
  `git diff --stat e42e062..HEAD -- src tests` ⇒ **零输出**（`e42e062` = GATE-PKG3 门）
  ⇒ 自包 3 合入以来 `src/` 与 `tests/` **一字未动**，其间六处 STEP 0 全绿。**代码没变，红是新出现的。**

**证据 2 — 隔离 0/8**（`vitest run <file> -t "<完整测试名>"`，8 次，逐次 `exit=0`）：
  每次均 ` Tests  1 passed | 54 skipped (55)` —— **`1 passed` 本身即证选择器命中，不是空跑 0 matched。**

**证据 3 — 全套件 3/3 复绿**（`./node_modules/.bin/vitest run`，未过滤跑、结果落盘）：
  三轮均 ` Test Files  30 passed (30)`、`exit=0`、`^ FAIL ` 零命中。
  ⚠️ **如实记一处控制器自己的探针缺陷**：该脚本里 `Tests` 行的行首空格数写错（模式要 7 空格、实际 6），
  **这三轮的「用例总数」没被捕获**，只捕到 `Test Files`。结论不受影响（`FAIL` 零命中 ＋ exit 0），
  但**证据面比预定的窄，记下不掩饰**。

⇒ **合计：全套件 1/4 红、隔离 0/8 红。**

**测试体已读（不按签名词归族 —— handoff `:1024` 记过 (F) 差点因「都有 exhausted」被误归 (A)）**：
  该测试用 `createContract(repoPath)` 的**默认**旋钮，**一个超时旋钮都没覆写**（相邻的兄弟测试才覆写
  `perAttemptTimeoutMs`/`totalRuntimeBudgetMs`）；并且它驱动**真实子进程**
  （`new SubprocessClaudeAdapter({ command: ["node", phaseRunnerPath] })` ＋ 经 `PATH` 注入的 fake claude）。
  ⇒ **旋钮形状与 (F) 同类**（(F) 也是默认 5000ms 预算、只在全套件负载下红），**但它不是 (F)，是另一条测试。**

*** **机制假说（未证，禁止当结论用）**：全套件并行争 CPU 时子进程启动/相位真实墙钟顶过默认总预算，
控制器**合法地**判定耗尽 ⇒ 该 attempt 从未写出 `plan.json` ⇒ 读它得 ENOENT。 ***
  **要证它需要**：在失败时把 `budgetSnapshot.timeRemainingMs` 与各相位用量落盘，再跑一轮重复全套件跑
  （handoff 对 (F) 同类调查的估计是约 30 分钟机器时间）。**在那之前，「为什么」是空的**
  —— 这与 handoff `:1026` 对 (F) 的措辞是同一条纪律。

**控制器没有做、也不打算擅自做的事**：把它写进 flake 名单。
  **入名单 = 修改判据**，人裁 4 的边界逐字写着「**不含为了让测试变绿而改判据**」。**这一条留给人裁（见 §4）。**

--------------------------------------------------------------------------------
3. 控制器记下的歧义（不替人裁决）
--------------------------------------------------------------------------------

人在给出「A. 包 2 开工」的**同一条**消息里另说一句：「**第二条待办授权可以在你觉得需要的时候开工**」。
「第二条待办」有两种读法，**后果不同，故不合并**：
  (a) 控制器上一条消息列的 **B**（把 §0 那处远端腐坏就地注解）；
  (b) 控制器在 A 里点名请人定夺的那处耦合 —— **人裁 5 第 1 条的 `SweepOptions.stderr` 契约测试**
      （其规范半边归包 1 spec，而包 1 spec 正被修复环 2 冻着）。
**控制器的处置**：按 (a) 执行（低风险、只注解不改结论，已落 §0）；
**(b) 在真正要动它之前问人** —— 它不阻塞 STEP 0、冲突扫描、worktree 决策，故不阻塞开工。
（本仓库立场：转述不许压缩、歧义不许私自消解。）

--------------------------------------------------------------------------------
4. 待人裁的事项 / 下一步
--------------------------------------------------------------------------------

**待人裁 1（本节唯一新增）—— 那条名单外失败怎么处置。** 三个选项，控制器不替人选：
  (i) **记录、暂不深挖**：按 §2 的三条证据把它当「已具名、已测量、根因未证」挂账，**不入 flake 名单**
      （入名单是改判据），后续跑套件再遇到即按同一签名比对。**控制器倾向这条**，与人裁 5/8/9 同形。
  (ii) **单开一轮根因调查**：落盘 `budgetSnapshot` ＋ 重复全套件跑，约 30 分钟机器时间起。
  (iii) **人裁把它并入 flake 名单**（需人明令，因为它落在人裁 4「不含为了让测试变绿而改判据」的边界上）。

**待人裁 2**：§3 的 (b) —— `SweepOptions.stderr` 契约的测试半边，包 2 现在做还是等包 1 修复环 2 之后做。

*** **人裁 10。2026-08-07。人选「记录挂账，继续开工」。** ***
  那条名单外失败：**按已具名、已测量、根因未证挂在本台账 §2，不入 flake 名单，不单开根因轮。**
  **控制器据此在「复跑 3/3 全绿」这个基线上继续包 2。** 后续跑套件再见到它，**按 §2 的完整测试名比对**，
  **仍不得挥手放过**（人裁的是「暂不深挖」，不是「它无害」——**根因至今是空的**）。

*** **人裁 11。2026-08-07。人选「等包 1 修复环 2 之后再做」。** ***
  §3 那处歧义的读法 (b) 就此有解：**`SweepOptions.stderr` 契约的测试半边不在本轮包 2 范围内**，
  理由是其规范半边归包 1 spec、而包 1 spec 正被人裁 9 冻着。
  ⇒ **本轮包 2 只做三条：债 2 → 第 4 笔 → 第 1 笔。**

**下一步（未执行）**：worktree 决策重判（包 2 要动 `src/`+`tests/`，**不许继承包 1/包 3 的「不开」**）
→ 开工前冲突扫描（两名只读、错开分工；输入含 10 条 deferred minor ＋ G2-null ＋ 三条路径）
→ 逐任务走 SDD（实施者 → 独立评审员 → 修复环 → 换人 scoped 再评审）。
**开门、合并、删分支、push 四件各需人单独授权。**

**Rule 6 记账**：本任务（开工自查 ＋ STEP 0 ＋ 名单外失败定性）已接近单任务 100k 预算，**就地收口交接**，
未派任何 subagent。
