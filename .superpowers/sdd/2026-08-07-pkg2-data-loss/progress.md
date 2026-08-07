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
  ⇒ **人裁 11 已答：等包 1 修复环 2 之后。本轮不做。**

*** **待人裁 3（新，承重，控制器已亲验，见 §6）—— 第 4 笔与人裁 4 的授权边界正面相撞。** ***
  **事实**：`runLoop.integration.test.ts` 的 `reads owner-transfer.json for the published-winner
  check and finalizes none of the winner's transaction inside the publish window` **故意**把
  「第 4 笔的残余 TOCTOU 未关闭」钉成既有判据，其注释块自陈是一次 **Human ruling** 的产物。
  **人裁 4 的边界逐字**：「授权的是补测试，**不含为了让测试变绿而改判据**」。
  **⇒ 要真修第 4 笔，就必须动这条判据；不动它，第 4 笔只能补测试、不能修。二选一，必须人裁。**
  三个选项（控制器不替人选，也不预判哪个对）：
    (i) **本轮第 4 笔只补测试、不改判据**：把残余 TOCTOU 的现状用新测试钉得更死，**修留到以后**。
        —— 与人裁 4 的字面边界完全相容，代价是第 4 笔这一条**本轮不算修掉**。
    (ii) **人裁扩权**：明令允许包 2 改这一条判据（**等于重开 2026-08-02 那次 Human ruling**），
        第 4 笔真修。**必须人明令**，控制器不得推定。
    (iii) **本轮把第 4 笔整条移出包 2**，只做债 2 与第 1 笔。
  ⚠️ **无论选哪个，都不许由实施者自行决定** —— 这正是「不许实施者自改判据」那条铁律的适用场景。

*** **人裁 13。2026-08-07。人选 (ii)「扩权：允许包 2 改这条判据」。** ***
  **⇒ 第 4 笔本轮真修。包 2 获准修改**
  `runLoop.integration.test.ts > reads owner-transfer.json for the published-winner check and
   finalizes none of the winner's transaction inside the publish window` **这一条既有判据**
  —— 这是**对人裁 4「不含为了让测试变绿而改判据」的一次具名例外**，
  **仅限这一条测试，不得外推到任何其它判据。**

  ⚠️ *** **扩权不等于免除论证。实施者必须在报告里正面处理下面两句，不许绕过：** ***
  1. 该注释块逐字写着「⚠️ **No terminal-state assertion, deliberately.** … Asserting it as correct
     behaviour would **write a damaged trajectory into the suite**。」
     ⇒ **要加终态断言，先证明「第 4 笔已关闭之后，那条轨迹不再是 damaged」** —— 拿今天的代码证，
     不许拿「人已授权」当论据。**授权解除的是流程约束，不是举证责任。**
  2. 该注释块自陈其命名与形状出自 **2026-08-02 的一次 Human ruling**（`Amended 2026-08-02 (d),
     §Task A9`）。**实施者必须在报告里指明这次改动推翻了那次裁决的哪一部分**，逐字引，
     **不许静默覆盖**。
  **评审员的任务里必须写明：专门核这两点，且不接受实施者自证。**

*** **人裁 10。2026-08-07。人选「记录挂账，继续开工」。** ***
  那条名单外失败：**按已具名、已测量、根因未证挂在本台账 §2，不入 flake 名单，不单开根因轮。**
  **控制器据此在「复跑 3/3 全绿」这个基线上继续包 2。** 后续跑套件再见到它，**按 §2 的完整测试名比对**，
  **仍不得挥手放过**（人裁的是「暂不深挖」，不是「它无害」——**根因至今是空的**）。

*** **人裁 11。2026-08-07。人选「等包 1 修复环 2 之后再做」。** ***
  §3 那处歧义的读法 (b) 就此有解：**`SweepOptions.stderr` 契约的测试半边不在本轮包 2 范围内**，
  理由是其规范半边归包 1 spec、而包 1 spec 正被人裁 9 冻着。
  ⇒ **本轮包 2 只做三条：债 2 → 第 4 笔 → 第 1 笔。**

--------------------------------------------------------------------------------
5. 控制器对扫描员 1 的独立复核（不接受扫描员自证）
--------------------------------------------------------------------------------

扫描员 1 交付 `scan-1-report.md`（DONE，四条全判「仍成立」）。
**控制器只挑了他四条里唯一那条全称否定复核**（G2-null 那条）—— 其余三条**未复核，如实记明**。

**复核方法**：脚本落盘后 `rtk proxy zsh` 跑，两条 sanity 探针（`tests/` 下 30 个 `.ts`；
`buildProcessInstanceId` 在 `src/runtime/processIdentity.ts` 的定义处必命中），
**四个互不依赖的口径**：符号名 `parsePid` ／ 符号名 `buildProcessInstanceId` ／
字面量 `pid:`（与符号名无关的独立面）／ `processIdentity.test.ts` 全文。

*** **结论：他的结论不腐坏，但措辞比证据宽，且宽的方向危险。** ***

  **成立的那半**：`parsePid` 在 `tests/` **零命中**（它是 `fileStore.ts` 的模块私有函数，
  三处命中全在 `src/`：注释一处、定义一处、调用一处）⇒ **G2-null 那条防线确实没有测试钉住。**

  ⚠️ **不成立的那半 —— 他写的是「全仓未见任何针对**该形式**的测试断言」，这句为假。**
  控制器亲验两处逐字断言了 `pid:<pid>:<start time>` 形式：
    `tests/runtime/processIdentity.test.ts`  `expect(id).toMatch(/^pid:\d+:\d+$/)`
    `tests/persistence/fileStore.test.ts` 的 `puts this process's id and start time at fixed
      positions in the temp file name` —— `buildProcessInstanceId().split(":")` 取两段，
      `expect(startTime).toMatch(/^\d+$/)`，再拿两段拼进临时文件名的正则
  且该测试**自带一段注释解释它为什么故意跨模块断言**（「Asserting across the two modules is what
  makes either side changing the pid or start-time components a test failure rather than a silent
  divergence」）。

*** **为什么这个宽度危险**：读者按他的措辞会以为「该形式无人断言、可以随便改」，
而实际改动 `processIdentity.ts` 的输出格式**会让上述两条测试变红**。**误读方向是「以为安全」。** ***

**收紧后的准确说法（包 2 实施 brief 必须用这一版）**：
  「**没有测试钉住 `parsePid` 与该形式的不匹配**（即 G2-null 防线本身）」——
  **不是**「没有测试断言该形式」。

**控制器没做的**：没有复核他的债 2（15 调用点 / 4 个由 lease-loss 到达）、第 4 笔、第 1 笔三条。
**它们目前是单方证词**，需在包 2 实施前由实施者或评审员再撞一次。

--------------------------------------------------------------------------------
6. 扫描员 2 交付 ＋ 控制器对其承重项的独立复核
--------------------------------------------------------------------------------

`scan-2-report.md`（DONE）。五条摘要：
  1. deferred minor 的**可重推基数他重推为 12**（称 handoff 的「6」已被其自身作废、「10」是压缩漏计）；
     其中仅 **T1-M4／T1-M5**（`src/persistence/fileStore.ts` 的注释）与包 2 冲突、须转入包 2。
     ⚠️ **控制器未复核这个数**。本仓库对聚合数已栽过多次（控制器自己的口径 10/12/28 无一可重推）。
     **在有人拿出可重数的判别式之前，不许把「12」当定论传下去。**
  2. 人裁 4 边界逐字确认；**并查出一处真实相撞候选**（见下，控制器已亲验）。
  3. 债 2、第 1 笔今天像是「**补**」（未找到既有实跑注入测试）；**第 4 笔像是「改」**。
  4. 与那条名单外 flake：**文件级交集已证实**（同在 `runLoop.integration.test.ts`）；
     **语义级交互他答「无法判定」，没有硬下全称否定** —— **记正面样本。**
  5. `evidence.test.ts` 的 `tsxBin`/`process.cwd()` 环境陷阱今天仍成立，9 处引用全在 `run-scenario CLI` 块内。

**他自报的偏离（如实上报，记正面样本）**：落盘协议**字面执行有偏离**（用 `rtk proxy zsh -c` 直跑，
未先落盘脚本文件）；A 组 9 条 deferred minor 未逐条亲读；两个 3700+ 行测试文件未逐字通读，
结论止于关键词检索面。

*** **控制器亲验其承重项，成立，且比他说的更硬。** ***
  `tests/controller/runLoop.integration.test.ts` 的
  `reads owner-transfer.json for the published-winner check and finalizes none of the winner's
   transaction inside the publish window` —— 其上方注释块**逐字**：
    「It does NOT pin "the winner was not overwritten". It cannot: … so the loser **does** go on to
      write its downgraded record, **which is exactly the shape of the residual TOCTOU this layer
      leaves open (§13, 4th entry)**. … **Do not read assertion (a) as more than it is.**」
    「⚠️ **No terminal-state assertion, deliberately.** … Asserting it as correct behaviour would
      **write a damaged trajectory into the suite**.」
    「**Human ruling**; the plan carries the matching in-place amendment note
      (Amended 2026-08-02 (d), §Task A9).」

*** **⇒ 这条测试的当前形状本身就是一次先前人裁的产物，且它故意把第 4 笔的残余 TOCTOU 钉成「未关闭」。** ***
**含义**：包 2 一旦真去关闭第 4 笔的残余 TOCTOU，「loser 照样写下降级记录」就不再成立，
**这条测试的注释与断言都得改** —— 而人裁 4 的边界逐字是「授权的是**补测试**，
**不含为了让测试变绿而改判据**」。**两者直接相撞，且改它等于推翻先前那次人裁。**
⇒ **进 §4 待人裁 3。控制器不替人选。**

**顺带留给实施者（不要重新发现）**：同一注释块记着「Mutation 2（移除
`tryRecoverStaleOwnerTransferLock` 里的活进程早返回）会连带弄红别处一批既有测试，名单在
`task-A9-report.md`；**那批是噪声，不是本测试的护栏** —— 唯一算数的证据是该具名测试单跑变红」。

--------------------------------------------------------------------------------
7. worktree 决策（人裁 12）＋ 新工作区基线
--------------------------------------------------------------------------------

*** **人裁 12：开 worktree ＋ 新分支。该决策已重判，未继承包 1／包 3 的「不开」**
（那两轮是纯文档；包 2 动 `src/`+`tests/`）。 ***

  `.worktrees/pkg2-data-loss`，分支 `feat/pkg2-data-loss`，**基点显式写 HEAD**（`ddb604a`）。
  ⚠️ *** **为什么必须显式写基点**：harness 的 `EnterWorktree` 默认基点是 `origin/<default-branch>`
  （当时 = `ebd19cb`），照默认走会**丢掉本轮四笔台账提交**。 *** 这正是 handoff 那句
  「先 `git worktree add <path> -b <branch> HEAD` 显式指定基点，再用 `EnterWorktree` 的 `path` 接管」
  的由来 —— **本轮实测证实了它，别改成默认。**
  `.worktrees/` 已核为 gitignored（`.gitignore:19`）。**建完立刻 `npm ci`**（陷阱 5）。

**新工作区基线（控制器亲跑、未过滤、`RUN` 路径已核为 worktree 内）**：
  `RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss`
  ` Test Files  1 failed | 29 passed (30)` ／ `      Tests  1 failed | 513 passed (514)`
  `TEST_EXIT=1` ／ `TYPECHECK_EXIT=0` ／ `BUILD_EXIT=0`

*** **唯一的红是允许出现的 flake (B)，不构成新缺陷。** *** 逐字比对（不比行号）：
  `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks
   descendants rooted at the spawned pid` —— `Error: Test timed out in 5000ms`
  与 handoff 对 (B) 的记载（全套件并行负载下 5000ms 超时、隔离连过两次）**逐字对上**。
  **且它不是陷阱 5 那种 `spawn ENOENT` 假失败**（那会是九条一起红）⇒ **`npm ci` 的对策已生效。**

**§2 那条名单外失败本轮通过**（`✓ … persists phase usage evidence … 1035ms`）⇒ **累计 1/5 红。**
  **仍不得据此说它消失** —— 「本次没跑出来」不构成任何 flake 已消失的证据（本仓库既有立场）。

**下一步（未执行，交接给下一会话）—— 前置全部就绪，可直接派实施者**：

  ✅ 已就绪：worktree ＋ 分支 ＋ `npm ci` ＋ 新工作区基线（§7）；两份开工前扫描（§5/§6）；
     人裁 10/11/12/13 全部落账。
  ⬜ **任务 1 = 债 2**（`persistTerminalState` 往已不拥有的 run 写）。**扫描员判「补」不是「改」**
     （未找到既有实跑注入测试）—— **但那是单方证词，实施者要自己再撞一次。**
  ⬜ **任务 2 = 第 4 笔**。**人裁 13 已扩权**，可改那一条具名判据；
     **实施者必须在报告里正面处理 §4 待人裁 3 下面列的两句，不许绕过。**
  ⬜ **任务 3 = 第 1 笔**。规模最大（P-READ 不经锁协议，牵动 L1/L2「读不许写」契约）。

  **每任务**：实施者 → **换人**独立评审员 → 有 Critical/Important 进修复环 → **换人** scoped 再评审
  → 本台账记 `Task <N>: complete`。**不接受实施者自证。**
  **每份 brief 必写**：落盘协议 ／ 脚本先落盘再 `rtk proxy zsh` 跑 ＋ 必命中 sanity 探针 ／
  验证跑绝不过滤 ／ 锚点用符号名不用行号 ／ 不许用收窄搜索面支撑全称否定 ／
  变异走三步判据（注入前绿 / 注入后红 / 还原后绿）且单跑块显示具名测试的**非零**计数。
  **每份 brief 还要带**：§2 那条名单外 flake 的完整测试名（见到它按 §2 比对，不要重新调查）＋
  允许出现的 flake 只有 (B) 与 (F) ＋ §5 收紧后的 G2-null 措辞 ＋ §6 末尾那条「task-A9 名单是噪声」。

**开门、合并、删分支、push 四件各需人单独授权。**

**Rule 6 记账**：本会话已用去可观预算（开工自查 ＋ STEP 0 ＋ 名单外失败定性 ＋ 两名扫描员 ＋
控制器两次独立复核 ＋ worktree 与基线）。**就地收口交接，实施阶段留给下一会话开**，
以免实施者的报告与修复环挤在预算尾巴上。
