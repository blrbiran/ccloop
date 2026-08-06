# Sweep 与转移事务跨文件原子性 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `reconciliation-record.json` 成为 owner-transfer 事务的第三个参与文件（债 1），收紧 `heartbeat.stop()` 的释放窗口（债 3），并新增 `ccloop sweep` 触发层，使已具备续跑资格的 run 在无人值守下被真正续跑。

**Architecture:** 三个任务组，**强制串行**。组 A（§4 债 1）把 reconciliation 搬进既有的 marker 驱动事务，并把 marker 与三份 pending 全部改成 temp + rename 原子写；组 B（§5 债 3）新增 `RunHeartbeatStoppedError` 与停机信号槽；组 C（§6/§7/§8）新增 `src/sweep/sweepRuns.ts` 与 `ccloop sweep` CLI。三个组之间由**评审门**隔开（见「任务分组与硬约束」）。

**Tech Stack:** TypeScript (ES2022 target)、Node 22 (`@types/node ^22.x`)、vitest 2.1.9、`node:fs/promises`。无新增依赖。

**唯一真理来源：** `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（下称 **spec**，本文所有 `§n` 均指它）。**本计划与 spec 冲突时以 spec 为准，但本计划就地裁定的两处「二选一」与一处 spec 内部冲突（见「计划阶段的三次裁定」）优先于 spec 的对应措辞。**

---

## Global Constraints

以下每一条都隐含地属于**每一个**任务的要求。

### 运行与验证

- 全套件：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
- 类型：`npm run typecheck`；构建：`npm run build`
- **验证跑绝不过滤输出。** `| tail`、`| grep`、`| head`、`2>/dev/null` 与任何截断管道**同罪**。要看结果就把整段输出贴出来。
- **当前基线（计划阶段实测，2026-08-02，未过滤）**：

  ```bash
  ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
  # 实测输出末尾：` Test Files  29 passed (29)` / `      Tests  446 passed (446)` / Duration 15.91s，exit 0
  npm run typecheck; echo "typecheck_exit=$?"
  # 实测：typecheck_exit=0
  npm run build; echo "build_exit=$?"
  # 实测：build_exit=0
  ```

  **446 会随任何新增测试腐坏。以你自己那次执行的输出为准，不要引用这里的 446。**
- 跑全套件时**只有这两条 flake 允许出现**，名单外任何失败一律按新缺陷处理（先捕获完整测试名与失败块，不得重跑掩盖）：
  - (B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
  - (F) `tests/controller/runLoop.integration.test.ts > runLoop > continues normally when execute returns a complete result during the recovery window`
  - **计划阶段那次基线跑里这两条都是 `✓`**，所以「它们本来就红」不是任何失败的解释。
- **真实 Claude 调用须事先获批（付费）。** 本计划全部测试走 `ScriptedAdapter` 或替身，任何任务都不得自行发起 `--adapter claude`。

### 「变异必须红」的达标判据（§10 通用条，第六波定死，全文适用）

**每一处写着「必须红」的地方，达标判据是「*具名的那一条*单跑必须红」，不是「套件必须红」。** 三步缺一不可：

1. **先具名**：写下要变红的那条测试的**完整测试名**（`describe > it` 全串），不许只写编号。
2. **单跑**：`ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run <测试文件路径> -t '<完整测试名>'`。**只有这一条红才算达标。**

   **Amended 2026-08-02 (b)：字面把第 1 步的 `describe > it` 全串原样代入这里的 `-t`，在 vitest 2.1.9 下匹配不到任何测试。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。第 1 步不改——具名时仍然写完整的 `describe > it` 串，不许只写编号或裸标题；但**代入 `-t` 的必须换成一个真的能匹配的形式**。实测（vitest 2.1.9，`tests/controller/resumeLoop.gate.test.ts`，describe `evaluateResumeEligibility`，it `refuses when owner-transfer is not eligible`）：

   ```
   $ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'evaluateResumeEligibility > refuses when owner-transfer is not eligible'"
    Test Files  1 skipped (1)
         Tests  27 skipped (27)
   EXIT=0

   $ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'evaluateResumeEligibility refuses when owner-transfer is not eligible'"
    Test Files  1 passed (1)
         Tests  1 passed | 26 skipped (27)
   EXIT=0

   $ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'refuses when owner-transfer is not eligible'"
    Test Files  1 passed (1)
         Tests  1 passed | 26 skipped (27)
   EXIT=0
   ```

   带 `>` 的箭头形式零匹配，退出码却是 0；空格拼接的全名与裸 `it` 名两种都能匹配。**新增一条硬性判据，这才是真正堵住这个洞的部分：** 单跑达标与否不能只看退出码或「绿/红」两个字——`Tests N skipped (N)` **不是绿**，它只说明这条 `-t` 过滤器谁都没选中；唯一算数的绿是**具名那条本身**出现 `Tests 1 passed | N skipped`，唯一算数的红是 `1 failed | N skipped`。凡是贴出的单跑输出整行读作「全部 skipped」，一律按过滤器零匹配处理，不算达标，即便退出码是 0。这条同时堵住了测试名手误——名字拼错时同样会零匹配、同样全 skipped，只换 `-t` 的形式堵不住这一种。（本条测量于 **vitest 2.1.9**；行为随版本变化，换 vitest 大版本时需重测。）

   已核对：A1–A5 的报告里 `-t` 全部用的是裸 `it` 名，过滤器确实命中，落地的变异证据不受影响；A6 用的是空格拼接全名，并在报告里自己披露了这处偏离。

   **Amended 2026-08-02 (f)：上面这句「A1–A5 全部用的是裸 `it` 名」是假的，而且它恰好长在「专门用来堵住未经核实的绿色断言」的这条注记里面。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。实测重跑：

   ```
   $ rtk proxy "grep -rnoE -e \"-t '[^']*'\" .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A{1,2,3,4,5}-report.md"
   ...（共 45 处命中：A1 3 / A2 13 / A3 16 / A4 11 / A5 2。逐条看过，只有下面两处不是裸 `it` 名）
   .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A4-report.md:424:-t 'writes no boundary artifact'
   .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A4-report.md:830:-t 'writes no boundary artifact'
   ```

   `task-A4-report.md` 的第 424、830 行用的是**前缀**，不是裸 `it` 名。落地的全名在 `tests/controller/leaseLifecycle.integration.test.ts`（符号 `it(`）逐字为 `writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4)`。另外两处看着像例外、核过后不是：`task-A5-report.md:1482` 写作 `-t '$TNAME'`，上一行的 `export TNAME=...` 展开后正是裸 `it` 名；`task-A5-report.md:263` 用的是改名前的旧名字，但它整段被该报告自己的 supersession 标注圈住（「该名字在人裁定改名后**已不存在于代码树**……不要拿它们当现行证据」），是逐字保留的历史输出，不是现行断言。

   **实质结论仍然成立，不要因为这条更正就去动 A4 的证据**：vitest 的 `-t` 是子串匹配，前缀照样命中，而且 A4 这两块的输出都写着 `Tests  1 passed | 24 skipped (25)`——具名那条计数非零，因此不是「全 skipped 假绿」，落地的变异证据不受污染。被更正的是「全部用的是裸 `it` 名」这个**说法过强**：前缀在名字被改短、或另一条测试名恰好包含同一前缀时会静默改变匹配集，这正是本注记要求写全名的原因。

   **补上本文档一直缺的交叉引用：** 支撑这句话的那份逐条核对写在 `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-errata-report.md` 的「Erratum 1」§2 里，本文档此前没有任何指针指过去。那份核对的第 66 行带着同一处过强说法（原文：「all `-t` values are bare `it` names」），按同一理由读，不要再从那里继承这个断言。

   **Amended 2026-08-02 (g)：(f) 的「共 45 处命中」本身就是一次未经核实的完备性断言，长在「专门用来堵住未经核实的完备性断言」的注记里。** (f) 贴的那条命令只匹配**单引号**的 `-t` 值，因此漏掉 `task-A5-report.md` 的 `-t "$TNAME"` 形式；(f) 用的又是 `grep -c` 语义之外的直觉计数，而 `grep -c` 数的是**行**、不是**出现次数**。改用对引号形式不敏感（单引号／双引号／裸变量三种都收）的扫描，并显式按出现次数计：

   ```
   $ for f in 1 2 3 4 5; do
       P=".superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A${f}-report.md"
       SQ=$(grep -oE -e "-t '[^']*'" "$P" | wc -l | tr -d ' ')
       ANY=$(grep -oE -e "-t +(\"[^\"]*\"|'[^']*'|[^ \"']+)" "$P" | wc -l | tr -d ' ')
       echo "A${f}: single-quoted-only=${SQ}  quoting-agnostic=${ANY}"
     done
   A1: single-quoted-only=3  quoting-agnostic=3
   A2: single-quoted-only=13  quoting-agnostic=13
   A3: single-quoted-only=16  quoting-agnostic=16
   A4: single-quoted-only=11  quoting-agnostic=11
   A5: single-quoted-only=2  quoting-agnostic=3
   ```

   **正确的数字是 46，不是 45：A1 3 / A2 13 / A3 16 / A4 11 / A5 3。** 多出来的唯一一处是 `task-A5-report.md:824`，形式为 `-t "$TNAME"`——这是一条**命令模板**（上一行写着「`$TNAME` = 上面那个新全名」），不是贴出的实跑输出；它与 (f) 已核过的 `task-A5-report.md:1482` 用的是同一个变量，而本文档里 `TNAME` 的唯一具体绑定在第 1481 行的 `export TNAME='refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives'`，与 `tests/persistence/fileStore.test.ts:2628` 的 `it(` 名逐字相同（本轮已重新对过，未从 (f) 继承）：

   ```
   $ rtk proxy "grep -n 'refuses resume at every pre-commit crash gap' tests/persistence/fileStore.test.ts"
   2628:    "refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives",
   ```

   **因此 (f) 的实质结论不变**：唯二不是裸 `it` 名的仍然只有 A4 的第 424、830 行（前缀），第 46 处展开后是裸全名。被更正的只有两样：**数字 45→46**，以及**方法**——只匹配单引号的扫描不足以支撑「共 N 处、逐条看过」这种完备性说法，重数时必须对引号形式不敏感，且按出现次数而非行数计。

3. **贴两次原始输出**：注入前该条单跑必须**绿**、注入后必须**红**。只贴注入后那一次不算。

**额外要求：变异实验必须跑在一个基线全绿的工作副本上。** 第六波实测过一次教训：评审员在 scratchpad 副本里跑变异，副本不是 git 仓库，`parseArgs > returns 0 for the scripted example run` 因此失败，被误记成击杀。**基线绿之前不许下任何击杀结论。** 若在副本里做，先 `git init` + 一次首提交。

**为什么这条判据是硬的**：第六波实测 6e 的变异二**今天就杀掉 6 条与它无关的既有测试**（名单见 §10 测试 6e 变异二那一节），其中一条恰好就是 6e 要钉的那句话。于是「写一条断言写空的测试 → 注入 → 套件红 → 贴输出 → 宣布达标」这条路走得通。**套件红不是证据。**

### 锚点与数字

- **锚点一律用「文件名 + 符号名」，不用行号。** 本仓库有六处自造失效行号的案底。
- **改锚点必须验证该符号存在且*唯一*指向原意。** 有过一个「the three ... call sites」实际指向 15 个调用点的案底。
- **`grep` 用法（§11，不可违反）：**
  1. 锚点一律 `-F`。理由是**裸符号名不唯一**（`preserveSuccessfulReconciliationIfNeeded` 会同时命中 `preserveSuccessfulReconciliationIfNeededFromArtifacts`），与退出码、方言、`grep` 解析到谁全部无关。
  2. **任何不带 `-F` 的 `grep`，其「实测 exit N」一律不作数**——本仓库在同一个壳里对同一条命令测到过两个不同的退出码，该观测不可复现。
  3. 确实需要正则的改用 `-E`，并就地标注「**需要正则：只看输出行，退出码不作为论据**」。
  4. `-F` 下不要留正则转义（`'heartbeat\.stop()'` 在 `-F` 下会去找字面反斜杠）。
  5. 不用 `-e` 替代 `-F`；既有的 `-nF -e X -e Y` 写法保持不变。
  6. **`--include=*.ts` 不加引号会被 zsh 在调 `grep` 之前展开失败**，得到「零行 stdout ＋ exit 1」，与「跑了但没命中」**不可区分**。`command` / 绝对路径**一律无效**（失败在展开阶段）。要么写 `--include='*.ts'`，要么不写 `--include`。
- **每一个算出来的数字旁边必须就地附一条能重推它的命令，并写下*你那次执行*的输出值。** 本仓库有四个「附了命令却抄了输出值」的案底。改动一条带「实测」字样的行时**必须重跑那条命令**；不重跑就不许保留「实测」二字。

### 测试纪律

- **变异注入点必须在生产代码 / 生产类型上。** 往测试数组里注入只证明匹配器有效；**改 fixture 不是变异**。
- **反方向变异**：只改 A 侧失败、只改 B 侧也失败——用来证明跨模块断言不是同义反复。
- **加一个成分和加它的覆盖是一件事**：测试名里每一个分句都必须有一条能失败的断言。
- **凡是断言「恰好 N 行事件」的测试，必须在同一条里写明并断言 fixture 的前置条件**（`leaseAffirmedAt`、staging 残留），否则那个 N 是环境依赖的。
- 测试 1 / 5 / 6e / 12d(iv) 需经 `runLoop` / `runLoopFromState` 驱动（`persistBoundaryAnalysis` **未导出**）；**不要为此导出它**。测试 5 / 6e / 6f / 12d(iii) 里手工构造磁盘状态的部分可直接调 `fileStore` 的导出面。
- 临时名接线测试依赖 vitest **文件内顺序执行**（`vitest.config.ts` 无 `sequence.concurrent`）；若将来开文件内并发会**静默**打破。不要新增依赖跨文件顺序的测试。

### 边界与禁令

- **只增加拒绝，绝不新增许可。** L1/L1b/L2 三层共同的边界，本层原样继承。
- **`evaluateResumeEligibility` 的八条判据一个字节不改。** 计数守卫：`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` **必须仍为 8**（计划阶段实测输出 **8**）。
- **不合成 reconciliation，也不放松 `resumeLoop` 对它的必需性。** 裁决记录明令禁止（§4.0.1 的「明确禁止的退路」）。
- **不修债 2**（`persistTerminalState` 往已不拥有的 run 写）。本层对债 2 的接触面必须为零——这依赖 §5.3 选方案 (a)（见任务 B1）。
- **L1 spec §12 十九条一条不得弱化或删除**（`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`）。**第 2 / 5 / 7 / 15 / 17 / 19 条已变异验证过、人下过指令，绝对不得弱化。** 第 17 条与 §15 验收 4 的取舍已由 §11 裁定：**挑第 4/17 条**，TTL 兜底只适用于「release 的 CAS 因所有权已易主而失配」这一种情形。
- **S-3 安全阀（§4.0.2）**：若实现中发现事务化需要在恢复路径上新增一类**静默**失败模式、或需要改动 `finalizePendingOwnerTransfer` 的 catch **语义**（而不只是对称地多一个 `safeUnlink`），**停下，回到裁决记录 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`，不要发明变体，不要就地降级。** 它在第二轮被真实命中过一次。
- **`src/registry/` 零改动。**
- **不做 `git clean` / `reset --hard` / 广域 `restore`。不删 `.validation-runs/`、备份分支 `backup/evidence-first-v1-before-memory-history-cleanup`、`stash@{0}` / `stash@{1}`。**
- **push 与 merge 都只在人明确下指令时执行。** 本计划里的「提交」一律指本地 commit。

### 每个任务的收尾

- **每个任务一次独立评审**（评审员对着代码撞，不接受实施者自证）；**每个任务组整分支再一次**；**修复波之后还要再评审一次**。修复波会自带缺陷——本仓库十轮 100% 命中。
- 每个任务结束前跑一次全套件 + typecheck + build，**输出未过滤地贴出**。
- 所有编辑落地之后，全仓扫一遍指向被改文件的行号引用。

---

## 任务分组与 §11 硬约束如何在结构上被强制

**§11 第 1 条（裁决记录两处拼合的结果）**：

> §4（债 1）是独立的一节、独立的任务组、独立的评审，**且必须先于 §6 的触发逻辑完成并通过评审。**

**结构上的强制手段（三条，缺一不可）：**

1. **任务组之间由「门任务」隔开，门任务是计划里的一个显式条目。** 组 A 的最后一个条目是 **GATE-A**，组 C 的第一个条目 **C1** 在 Interfaces 的 Consumes 里写着「GATE-A 的合并 hash」。**一个只看得见自己那一个任务的实施者，在 C1 上第一步就会发现自己拿不到那个 hash。**
2. **组 C 的第一笔代码是新建 `src/sweep/sweepRuns.ts`，而 §15 验收 7 的判据 (3) 正是对这个文件取 `--diff-filter=A`。** 顺序被违反时该笔提交的祖先链会早于 GATE-A 的合并，验收 7 当场红。
3. **组 A 与组 C 必须是两笔各自独立评审过的合并，且 §4 那笔在祖先链上严格早于 §6 那笔。** 判据（三条都要贴原始输出）：

   ```bash
   # (1) 定位两个任务组各自的合并提交（评审通过的证据 = 合并提交信息里带评审结论）
   git log --merges --format='%h %cd %s' --date=iso --reverse
   # (2) 前置断言：两者不得是同一笔（--is-ancestor X X 退出 0，会让「合进同一笔 merge」蒙混过关）
   [ "$A4" != "$A6" ] || { echo "§4 与 §6 是同一笔合并 —— 违反 §11 第 1 条"; exit 1; }
   git merge-base --is-ancestor "$A4" "$A6"; echo "exit=$?"   # 必须 0
   # (3) §6 任务组*引入* src/sweep/sweepRuns.ts 的那一笔
   git log --diff-filter=A --format='%h %cd %s' --date=iso -- src/sweep/sweepRuns.ts
   # 计划阶段实测：`find src -iname '*sweep*'` 零结果 —— 该文件尚不存在，符合「§6 还没开始」的现状。
   # 落地后这里必须恰好一行，且 git merge-base --is-ancestor "$A4" "<该笔 hash>" 退出 0。
   ```

   **日期比较一律用 `%cd`（提交日期）不用 `%ad`（作者日期）**——rebase 保留作者日期而刷新提交日期，用 `%ad` 会让一个合规的分支误红。**更强的做法是再来一次 `--is-ancestor` 取代日期比较**，本计划推荐后者。

**组 B（§5 债 3）排在 GATE-A 与组 C 之间。** §11 没有要求这一点，本计划这样排的理由：任务 A8 新建 `runLoopFromState` / `resumeLoop` 的可选参数对象，B2 往同一个对象上加 `stopRequested`，C1 再加 `onAdopted`——**线性顺序让这个对象只有一个作者、三次追加，不会出现两个分支各自定义同名类型再合并**。§11 的约束在这个排法下**更强地**成立（A 早于 B 早于 C）。

**执行顺序（不可跳序）：**

```
组 A：A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → GATE-A（整分支评审 + 合并）
组 B：B1 → B2 → GATE-B（整分支评审 + 合并）
组 C：C1 → C2 → C3 → C4 → GATE-C（整分支评审 + 合并）
收尾：D1（验收扫描）
```

---

## 计划阶段的三次裁定

spec 把三件事显式留给了计划阶段。本计划各挑一个并给理由。**这三条优先于 spec 的对应措辞。**

### 裁定一 —— ENOENT 归因方式（§4.3「ENOENT 归因」二选一）

**挑：把 `readOwnerTransferRecordRaw` 那一次读移出 `Promise.all`，单独 `try`。**（spec 自己推荐的那一条。）

**理由**：判据是「**哪一次读抛的**」这个结构事实，不依赖任何错误字段。按 `error.path` 归因的方案依赖 Node `fs` 错误才带的 `path` 字段——**任何人在读侧包一层自定义错误就会静默丢掉它，而且丢掉之后测试全绿**（归因退化成「一律放行 ENOENT」，正是 §4.3 与验收 1b 要防的那个实现）。代价是那次读不再与另两次并行；**这不承重**——§4.0a 已就地写明「它本来就不是快照」，承重的是两条 epoch 相等判定。

### 裁定二 —— abandon 如何从 `preserveSuccessfulReconciliationIfNeeded` 上传（§4.3 第六波补写约束）

**挑：把返回类型换成一个判别式联合 `ReconciliationWriteDecision`，由 `writeBoundaryArtifacts` 分支。**

```ts
type ReconciliationWriteDecision =
  | { kind: "write"; record: ReconciliationRecord }
  | { kind: "abandon"; error: unknown };
```

**理由，逐条对着 §10 测试 12d(iii) 的两条硬约束走：**

1. **不得靠抛出上传**——判别式联合是纯返回值，`writeBoundaryArtifacts` 在 abandon 分支 `return`，函数正常 resolve。12d(iii) 的「正常 resolve（不抛）」成立。
2. **必须把原始 error 一路带到回调**——`{ kind: "abandon"; error: unknown }` 带着 error 本体，回调参数取 `String(decision.error)`。**返回 `ReconciliationRecord | null` 的写法不达标**（`null` 把 error 丢了，detail 没得填），已排除。
3. **不选「把整块判定上移进 `writeBoundaryArtifacts`」**：`preserveSuccessfulReconciliationIfNeeded` 的函数体只有「早退 → 读 → 委派给 `preserveSuccessfulReconciliationIfNeededFromArtifacts`」三段，把读上移会让这个函数**只剩早退与委派**、失去存在理由，等于把它删掉再把三行贴进 `writeBoundaryArtifacts`——**改动面更大，而且留下一个语义被掏空的旧名字**。判别式联合改的是**一个返回类型 ＋ 它唯一的调用块**。

### 裁定三 —— §4.6「`preserveSuccessfulReconciliationIfNeeded` 代码零改动」这句话为假，予以推翻

**spec §4.6 写着这个函数代码零改动；§4.3 第六波已就地标出「处置一落地之后那句话为假」，并把裁定留给计划阶段。**

**裁定：改 §4.6 那句话，不去为了保住「零改动」而把整块判定上移。**

**理由**：`preserveSuccessfulReconciliationIfNeeded` 今天返回 `Promise<ReconciliationRecord>`（`fileStore.ts` 的 `async function preserveSuccessfulReconciliationIfNeeded(` 锚点处，返回类型行是 `): Promise<ReconciliationRecord> {`），**返回类型里没有「不要写」这一格**。三种被 spec 允许的实现里没有一种能让它一个字节不动——「零改动」在处置一落地后是一句**必然为假**的话，保住它只能靠把改动挪到别处（裁定二理由 3 已论证那更差）。**本计划的处置是承认它变了，并在任务 A7 里把改动面写死为「一个返回类型 + 一个调用块」，使「变了多少」可判定。**

> **⚠️ 本计划不改 spec 文件。** 上面这条裁定写在这里，供评审员对照；spec 的勘误由人决定何时做。

---

## File Structure

| 文件 | 归属任务 | 职责 |
|---|---|---|
| `src/persistence/fileStore.ts` | A1 A2 A3 A7 A8 | 三文件事务、marker 与三份 pending 的原子写、marker 驱动 finalize、staging 回收、读侧收窄与 abandon 决策、`writeBoundaryArtifacts` 的第三个可选参数 |
| `src/runtime/types.ts` | A4 | 新增 `ReconciliationDraft`（`ReconciliationRecord` 去掉 `newOwnerEpoch`）。**`ReconciliationRecord` 本身九个字段一个不动。** |
| `src/controller/runLoop.ts` | A4 A8 B1 B2 | 草稿组装点、`persistOwnerTransfer` 补齐 `newOwnerEpoch`、赢家路径改传 `undefined`、`onReconciliationWriteAbandoned` 两层透传、`RunHeartbeatStoppedError` 分支、停机信号槽 |
| `src/controller/resumeLoop.ts` | A8 B2 C1 | **只加一个可选参数对象**。`ResumeNotEligibleError` 的签名与 `Promise.all` 的 catch **一个字节不改**（§4.4 已否决 `cause` 方案），八条判据一个字节不改 |
| `src/controller/leaseHeartbeat.ts` | B1 | `runExclusive` 拒绝 ＋ 其上方那条注释的更新。**`stop()` 一个字节不改**（L1 §12 第 4/17 条） |
| `src/ownership/lease.ts` | B1 | `RunHeartbeatStoppedError`，**并列、不继承既有两个** |
| `src/sweep/sweepRuns.ts` | **C1（新建）** | 扫描 → 判据 → 过滤 → 排序 → 配额截断 → 顺序续跑 → 路由 → 汇报。**纯函数，自身无 writer、不装信号处理器、不读 run 目录下任何文件** |
| `src/cli.ts` | C2 | `sweep` 分支、`--max-runs` 解析、`registerStopHandlers`、退出码映射 |
| `src/registry/**` | — | **零改动** |

**测试文件（全部为既有文件的追加，不新建测试文件）：**

| 测试文件 | 承载的条目 |
|---|---|
| `tests/persistence/fileStore.test.ts` | 3、4、4b、4c、4d、4e、5、6a、6c、6d、6f、12d(iii) |
| `tests/controller/runLoop.integration.test.ts` | 1、2、6、6b、6e、7b、8、12d(iv) |
| `tests/controller/resumeLoop.gate.test.ts` | 15（八条判据变异campaign）、6b 的判据断言面 |
| `tests/controller/leaseHeartbeat.test.ts` | 7 |
| `tests/controller/leaseLifecycle.integration.test.ts` | 8b |
| `tests/cli/cli.test.ts` | 12、13b |
| `tests/registry/zeroWrite.test.ts` | 14、14b（形状照搬该文件既有的承重写法） |
| **`tests/sweep/sweepRuns.test.ts`（C1 新建）** | 10、11、12b、12c、12d(i)(ii)、13 |

---

# 组 A —— §4 债 1：reconciliation 加入转移事务

> **本组必须完整落地并通过 GATE-A 的整分支评审之后，组 C 才可开始。** 这是裁决记录两处拼合的结果（§4 节首），不是任何一处的原文。理由（本层自己给的，不冒充裁决记录）：sweep 先落地就等于把触发层挂到一条已知损坏的续跑路径上。

### Task A1: marker 与两份既有 pending 改原子写

**Files:**
- Modify: `src/persistence/fileStore.ts`
  - 常量段（锚点：`const OWNER_TRANSFER_MARKER_FILE`）
  - `type OwnerTransferPaths`
  - `function getOwnerTransferPaths(`
  - `async function cleanupOwnerTransferStagingWithoutMarker(`
  - `export async function writeOwnerTransferArtifacts(` 内的暂存段（三条 `await writeJsonFile(paths.…Path, …)`）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes（既有，不改）：
  - `async function writeJsonFile(path: string, value: unknown): Promise<void>`
  - `async function safeUnlink(path: string): Promise<void>`
  - `async function writeOwnerRecordAtomically(runDir: string, ownerRecord: OwnerRecord): Promise<void>` —— **本任务要照抄的形状**：`safeUnlink(temp) → writeJsonFile(temp) → rename(temp, target)`
  - `function getOwnerTransferPaths(runDir: string): OwnerTransferPaths`
- Produces（A2/A3/A5/A9 依赖）：
  - 三个新常量，**名字逐字如下**（命名规则：被暂存产物的文件名去掉 `.json` ＋ 后缀，与既有五个常量对齐）：
    - `const OWNER_TRANSFER_MARKER_TEMP_FILE = ".owner-transfer.transaction.tmp";`
    - `const OWNER_RECORD_PENDING_TEMP_FILE = ".owner-record.pending.tmp";`
    - `const OWNER_TRANSFER_PENDING_TEMP_FILE = ".owner-transfer.pending.tmp";`
  - `OwnerTransferPaths` 增加三个键：`transactionMarkerTempPath`、`ownerPendingTempPath`、`transferPendingTempPath`（`getOwnerTransferPaths` 同步返回）
  - `async function writeJsonFileViaFixedTemp(tempPath: string, targetPath: string, value: unknown): Promise<void>` —— 模块私有；语义与 `writeOwnerRecordAtomically` 逐字同形，但 temp 路径由调用方给（因为三个 temp 各有固定名字，要能被 `cleanupOwnerTransferStagingWithoutMarker` 按名回收）。**不要复用 `writeJsonFileAtomically`**：它用 `buildAtomicTempPath` 生成带进程戳与序号的一次性 temp，回收不到。
  - `cleanupOwnerTransferStagingWithoutMarker` 的 `safeUnlink` 数：**4 → 7**

**背景数字（本任务开工前重推，把你那次的输出写进提交信息）：**

```bash
grep -nE 'pending.json|publish.tmp|transaction.json' src/persistence/fileStore.ts
# 需要正则：只看输出行，退出码不作为论据
# 计划阶段实测 5 行：:326 .owner-record.publish.tmp、:327 .owner-transfer.publish.tmp、
#   :328 .owner-record.pending.json、:329 .owner-transfer.pending.json、:330 .owner-transfer.transaction.json
grep -nF -e 'await writeJsonFile(paths.transferPendingPath' -e 'await writeJsonFile(paths.ownerPendingPath' -e 'await writeJsonFile(paths.transactionMarkerPath' src/persistence/fileStore.ts
# 计划阶段实测 3 行（:675 transferPending、:676 ownerPending、:677 marker）—— 全是裸 writeJsonFile
grep -nF -A6 'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
# 计划阶段实测：签名 + 4 个 safeUnlink（ownerPending / transferPending / ownerTemp / transferTemp），0 个 rename
```

**测试要求（§10 测试 4d、4e 的两条既有 pending 子用例）：**

- **4d — marker 原子写**：mock `node:fs/promises` 的 `rename`，让 marker 的那次 rename 抛出；断言磁盘上**没有** `.owner-transfer.transaction.json`、**只有** `.owner-transfer.transaction.tmp`；随后走一次持锁入口（`claimOwnerRecordWithPrecondition`）把 tmp 回收干净，断言两者都不存在。
- **4e(i) / 4e(ii) — 两份既有 pending 的原子写**，各一条子用例，与 4d 逐字同形：mock `rename` 在**该 pending** 的那次 rename 上抛出，断言只剩对应的 `.…pending.tmp`、没有 `.…pending.json`，随后持锁入口回收干净。
- **这两条子用例缺一不可**：`.owner-record.pending.json` 与 `.owner-transfer.pending.json` 是**先于本层就存在**的两份，本任务把它们从裸写改成原子写；不测它们就等于对本任务实际动过的东西零覆盖。
- **手法**：`vi.resetModules()` + `vi.doMock("node:fs/promises", …)`，与 `tests/persistence/fileStore.test.ts` 既有崩溃注入同法。**mock 面必须含 `unlink`**（`safeUnlink` 走 `node:fs/promises` 的 `unlink`），否则后半段「回收干净」不可观测。
- **变异（生产代码上）**：把该文件的写法退回裸 `writeJsonFile` 直写 → **对应那一条子用例必须红**。三条各自单独变异一次，三次。
- **⚠️ 4c（marker 不可解析）不在本任务**，它属 A3。4d/4e 钉的是「原子写这件事本身还在」，4c 钉的是纵深防御分支——**两者不可互相替代**。

**陷阱清单：**

- **`cleanupOwnerTransferStagingWithoutMarker` 的数字是六处联动的一部分**（§4.3 表 / §9 模块表 / §10 测试 6c / §13 / §10 测试 14 机制二 / §15 验收 8）。本任务把它从 4 改到 **7**，**A2 会再改到 10**。**7 是中间态，不是终态**——不要在任何注释或测试名里把 7 写成最终值。
- **marker 的 temp 不进 `finalizePendingOwnerTransfer` 的 try 首 / catch 尾对称清理**：finalize 一个都不写它们，写它们的是 `writeOwnerTransferArtifacts` 的暂存段；它们由 `cleanupOwnerTransferStagingWithoutMarker` 回收。加进 finalize 就不对称了。
- **`cleanupOwnerTransferStagingWithoutMarker` 只在 `options.lockHeld` 为真时被调用**（`recoverInterruptedOwnerTransfer` 的 `!(await pathExists(paths.transactionMarkerPath))` 分支内）。**`readOwnerRecord` 不传 `options`**，所以「读一次就把孤儿清掉」是假的——测试的回收段必须经 `claimOwnerRecordWithPrecondition`（或另两个持锁入口）驱动，**不能只 `readOwnerRecord`**。
- **不要顺手把 `hasStagedArtifacts` 也扩容。** 它今天只看 marker / ownerPending / transferPending 三个路径；把新 pending 加进去会**放宽**夺锁条件，与本层「只增加拒绝」的边界相反。这是一处**刻意的不对称**，属 L5 的锁协议整改范围（§13 第 1 笔）。
- **S-3 触发检查**：本任务是 §4.0.3 / §4.0.3a 两次人裁的落地。若你发现原子化需要改 `finalizePendingOwnerTransfer` 的 catch **语义**，停下，回裁决记录。

**Steps:**

- [ ] **Step 1: 重推背景数字并记账。** 跑上面「背景数字」三条命令，把三次的**原始输出**贴进本任务的工作笔记（提交信息里也带一份）。若与计划里写的实测值不一致，**停下并上报**——说明代码在计划之后动过。
- [ ] **Step 2: 写失败的测试 4d。** 在 `tests/persistence/fileStore.test.ts` 里新增，完整测试名定为：
  `fileStore > publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails`
  断言对象见「测试要求」的 4d。**不要写实现。**
- [ ] **Step 3: 跑它确认失败。** `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t 'publishes the transaction marker by rename'`。预期红（今天 marker 走裸写，`.tmp` 根本不存在）。**贴原始输出。**
- [ ] **Step 4: 写失败的测试 4e(i) 与 4e(ii)。** 完整测试名：
  `fileStore > publishes .owner-record.pending.json by rename, leaving only .owner-record.pending.tmp when the rename fails`
  `fileStore > publishes .owner-transfer.pending.json by rename, leaving only .owner-transfer.pending.tmp when the rename fails`
- [ ] **Step 5: 跑这两条确认失败。** 各自 `-t` 单跑，**两次原始输出都贴**。
- [ ] **Step 6: 实现。** 加三个常量、扩 `OwnerTransferPaths` 与 `getOwnerTransferPaths`、加 `writeJsonFileViaFixedTemp`、把暂存段三条裸写换掉、`cleanupOwnerTransferStagingWithoutMarker` 从 4 个 `safeUnlink` 扩到 7 个。**不动 finalize 的任何一行。**
- [ ] **Step 7: 跑三条确认通过 ＋ 跑全套件。** 三条各自 `-t` 单跑贴输出；然后 `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run` **不过滤**贴输出。允许出现的失败只有 flake (B)(F)。
- [ ] **Step 8: 三次变异实验，逐条走三步判据。** 对 marker / ownerPending / transferPending 各做一次「退回裸 `writeJsonFile` 直写」，每次：注入前该条单跑绿（贴输出）→ 注入后该条单跑红（贴输出）→ 还原。**三次共六份原始输出，一份都不能省。**
- [ ] **Step 9: typecheck + build。** 两条各自贴输出与退出码。
- [ ] **Step 10: 提交。**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat(fileStore): publish the transaction marker and both pendings by temp+rename"
```

- [ ] **Step 11: 独立评审。** 评审员对着代码撞，重点：三个 temp 是否都进了 `cleanupOwnerTransferStagingWithoutMarker`（7 个）、`hasStagedArtifacts` 是否被误扩、finalize 是否被误改、三条变异的六份原始输出是否齐备且注入点都在生产代码上。

---

### Task A2: reconciliation 加入事务（三文件、marker v2、staging 顺序不变式）

**Files:**
- Modify: `src/persistence/fileStore.ts`
  - 常量段、`type OwnerTransferPaths`、`function getOwnerTransferPaths(`
  - `type OwnerTransferTransactionMarker`
  - `async function cleanupOwnerTransferStagingWithoutMarker(`
  - `async function finalizePendingOwnerTransfer(`（try 首与 catch 尾各 +1 对称 `safeUnlink`；发布段加第三个文件）
  - `export async function writeOwnerTransferArtifacts(`（签名 + 暂存段）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes（A1 产出）：三个 pending/marker temp 常量、`OwnerTransferPaths` 的三个新键、`writeJsonFileViaFixedTemp(tempPath, targetPath, value)`、`cleanupOwnerTransferStagingWithoutMarker` 现有 7 个 `safeUnlink`
- Produces（A3/A4/A5/A9 依赖）：
  - `const RECONCILIATION_RECORD_FILE = "reconciliation-record.json";`
  - `const RECONCILIATION_RECORD_TEMP_FILE = ".reconciliation-record.publish.tmp";`
  - `const RECONCILIATION_RECORD_PENDING_FILE = ".reconciliation-record.pending.json";`
  - `const RECONCILIATION_RECORD_PENDING_TEMP_FILE = ".reconciliation-record.pending.tmp";`
  - `OwnerTransferPaths` 再加四个键：`reconciliationPath`、`reconciliationTempPath`、`reconciliationPendingPath`、`reconciliationPendingTempPath`
  - marker 类型变成判别式联合：

    ```ts
    type TransactionFileName =
      | typeof OWNER_TRANSFER_FILE
      | typeof OWNER_RECORD_FILE
      | typeof RECONCILIATION_RECORD_FILE;

    type OwnerTransferTransactionMarker =
      | { version: 1; stagedAt: string; finalizeOrder: readonly [typeof OWNER_TRANSFER_FILE, typeof OWNER_RECORD_FILE] }
      | { version: 2; stagedAt: string; finalizeOrder: readonly TransactionFileName[] };
    ```

  - **生产写的 marker 是 v2，`finalizeOrder` 为 `[OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE]`**（§4.3 排序改判）
  - `writeOwnerTransferArtifacts` 新签名（**第五个参数可选**）：

    ```ts
    export async function writeOwnerTransferArtifacts(
      runDir: string,
      expectedOwnerRecord: OwnerRecord,
      ownerRecord: OwnerRecord,
      transferRecord: OwnerTransferRecord,
      reconciliationRecord?: ReconciliationRecord,
    ): Promise<void>
    ```

    传了 → 写 v2 marker、暂存三份 pending；不传 → 写 v1 marker、暂存两份（今天的行为）。
  - `cleanupOwnerTransferStagingWithoutMarker` 的 `safeUnlink` 数：**7 → 10**（终值）
  - `finalizePendingOwnerTransfer` try 首 / catch 尾的 `safeUnlink`：**各 2 → 各 3**（加 `reconciliationTempPath`）

**为什么第五参数可选（本计划的裁定，回应 §9 的爆炸半径 ⚠️）：**

```bash
grep -cF 'writeOwnerTransferArtifacts(' tests/persistence/fileStore.test.ts   # 计划阶段实测 17
grep -rcF 'writeOwnerTransferArtifacts' tests/
# 计划阶段实测：leaseLifecycle.integration.test.ts:16、fileStore.test.ts:18，其余全为 0；16 + 18 = 34
```

设为必需会打断 17 个直接调用与 `leaseLifecycle` 里若干 `Parameters<typeof …>` 包装。设为可选：**既有 34 处一个字都不用改，而且它们继续实跑 v1 路径**——这正好给 §10 测试 4b（v1 marker + 两个 pending → 只发布两个、不抛）提供了持续的活体覆盖。
**代价与它的护栏**：生产唯一调用者若忘记传第五参，会静默退回 v1（reconciliation 不进事务）。**这条由 A4 的测试 1 接住**（驱动生产转移 + 注入 `assertHeld` 抛出 → 断言 `reconciliation-record.json` 在盘上）。**A2 的评审员必须确认 A4 的测试 1 在计划里存在且落在这条路上。**

**测试要求：**

- **4e(iii) — 第三份 pending 的原子写**：与 A1 的 4e(i)(ii) 逐字同形，针对 `.reconciliation-record.pending.json` / `.reconciliation-record.pending.tmp`。**变异：退回裸 `writeJsonFile` 直写 → 本条必红。**
- **测试 3 — 恢复**：staged 一个 v2 marker ＋ 三份 pending（无锁文件）→ `readOwnerRecord(runDir)` 触发恢复 → 断言三个文件全部就位、marker 与三份 pending 已被回收。
- **测试 6a — 暂存顺序不变式**：mock `node:fs/promises`，记录 `writeOwnerTransferArtifacts` 期间**按路径的 rename 序**，驱动一次真实转移，断言 `.reconciliation-record.pending.json` 的 **rename** 严格早于 marker 的 rename。
  **⚠️ 断言对象必须是 `rename` 不是 `writeFile`**：pending 也原子化之后，「pending 出现」的时刻是它那次 rename；盯 `writeFile` 会在「三份 pending 的 temp 先写、marker 先 rename、pending 后 rename」这种实现下**错误地变绿**。
  **变异：把 marker 的暂存提到三份 pending 之前 → 本条必红。**
- **测试 6c — 孤儿回收，10 个路径**：中断在 finalize 成功尾部（marker 已删、pending 未删），随后走一次 **`claimOwnerRecordWithPrecondition`**，断言**这 10 个路径逐个不存在**：
  - 三份 pending：`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.reconciliation-record.pending.json`
  - 三个发布 temp：`.owner-record.publish.tmp` / `.owner-transfer.publish.tmp` / `.reconciliation-record.publish.tmp`
  - 一个 marker temp：`.owner-transfer.transaction.tmp`
  - 三个 pending temp：`.owner-record.pending.tmp` / `.owner-transfer.pending.tmp` / `.reconciliation-record.pending.tmp`

  **fixture 必须把这 10 个全部放上去**，断言逐个不存在。**这条测试的杀伤力等于它列全的路径数**——第一轮写「三个 pending 与两个 temp」、第二轮写 7，两次都会在没列全的那些 temp 泄漏时**变绿**，等于把泄漏断言为正确。
  **⚠️ 驱动入口不能换成 `readOwnerRecord`**（不传 `lockHeld`，回收不会发生）。

**陷阱清单：**

- **10 这个数字六处联动**：§4.3 表 / §9 模块表 / §10 测试 6c / §13 / §10 测试 14 机制二（那里是 **11** = 10 ＋ marker 自己）/ §15 验收 8。改一处必须改六处。**marker 自己不在那 10 个里**——「无 marker」正是那个函数被调用的前提。
- **暂存顺序是不变式，不是实现细节**：三份 pending 全部 **rename 完成**之后才写 marker；**reconciliation pending 的 rename 严格先于 marker 的 rename**。marker 的存在即宣告「三份 pending 齐备**且全部完整**」。两侧都原子之后这条在读者侧才真正成立。
- **finalize 的 catch 只加一个对称 `safeUnlink`，不动它的形状与错误传播语义**（§13 的窄例外）。catch 里「三个 `safeUnlink` 都可能替换正在传播的错误」这个错误掩盖问题**原样留给 L5**，不要顺手修。
- **marker temp 与三个 pending temp 都不进 finalize 的对称清理。**
- **`readPersistedReconciliationRecord` 的 `catch { return undefined }` 不要收窄。** 本层对它建立了承重依赖（A7 的处置一把「它从不抛」当前提），依据三条见 §4.3；收窄它会打断那条依赖。
- **不要为了「让 v1 消失」去改那 34 处测试调用。** v1 分支必须活着——测试 4b 钉它。

**Steps:**

- [ ] **Step 1: 写失败的测试 4e(iii)。** 完整测试名：
  `fileStore > publishes .reconciliation-record.pending.json by rename, leaving only .reconciliation-record.pending.tmp when the rename fails`
- [ ] **Step 2: 跑它确认失败并贴原始输出。**
- [ ] **Step 3: 写失败的测试 3。** 完整测试名：
  `fileStore > finalizes a v2 marker with three pendings on read, publishing all three files and reclaiming the staging`
- [ ] **Step 4: 跑它确认失败并贴原始输出。**
- [ ] **Step 5: 实现常量、路径、marker 联合类型、`writeOwnerTransferArtifacts` 第五参数与三份 pending 暂存、finalize 的第三个文件与两处对称 `safeUnlink`、cleanup 7→10。**
- [ ] **Step 6: 跑 Step 1/3 两条确认通过，各自 `-t` 单跑贴输出。**
- [ ] **Step 7: 写失败的测试 6a。** 完整测试名：
  `fileStore > renames the reconciliation pending strictly before it renames the transaction marker`
  跑它——**此刻它可能已经绿**（实现顺序恰好正确）。**若绿，不算完成**：立刻做它的变异（把 marker 的暂存提到三份 pending 之前）证明它会红，两次原始输出都贴，再还原。
- [ ] **Step 8: 写失败的测试 6c。** 完整测试名：
  `fileStore > reclaims all ten staging paths on the next lock-held entry when the marker is already gone`
  先写 fixture（10 个路径全放上）→ 跑 → 贴输出 → 若需要再补 cleanup 实现 → 再跑贴输出。
- [ ] **Step 9: 变异实验（三次，各走三步判据）。**
  1. `.reconciliation-record.pending.json` 退回裸 `writeJsonFile` → 4e(iii) 必红
  2. marker 暂存提前到三份 pending 之前 → 6a 必红
  3. `cleanupOwnerTransferStagingWithoutMarker` 里删掉任意**一个** `safeUnlink`（生产代码）→ 6c 必红
  每次：注入前该条单跑绿（贴）→ 注入后单跑红（贴）→ 还原。
- [ ] **Step 10: 全套件 + typecheck + build，输出未过滤地贴出。**
- [ ] **Step 11: 提交。**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat(fileStore): make reconciliation-record.json the third file of the owner-transfer transaction"
```

- [ ] **Step 12: 独立评审。** 重点：cleanup 是不是 10 且逐个具名、finalize 的 catch 形状是否被改、marker 是否写的 v2 且顺序是 `[transfer, owner, reconciliation]`、第五参数是否为可选且 34 处既有调用未被触碰、6c 的 fixture 是不是真放了 10 个。

---

### Task A3: finalize 改为 marker 驱动（规则 1–4 与两个具名错误）

**Files:**
- Modify: `src/persistence/fileStore.ts`
  - `async function finalizePendingOwnerTransfer(`（整体改写为「先解析 marker，再按 `finalizeOrder` 办事」）
  - 错误类段落（锚点：`OwnerTransferPreconditionError` 声明处那条 `NOT a subclass` 注释所在的区域）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes（A2 产出）：`OwnerTransferTransactionMarker` 判别式联合、`TransactionFileName`、四个 reconciliation 常量、`OwnerTransferPaths` 的全部键
- Produces（A5/A9 与组 C 的测试 12c 依赖）：
  - `export class OwnerTransferMarkerUnreadableError extends Error` —— 规则 3
  - `export class OwnerTransferPendingMissingError extends Error` —— 规则 2
  - `finalizePendingOwnerTransfer` 的新行为：解析 marker → 按 `marker.finalizeOrder` 逐项发布 → 尾部回收 marker 与全部 pending

**采用的机制（§4.4，逐条）：**

1. marker 成为**被读取**的字段：finalize `readFile` + `JSON.parse` marker，按其 `finalizeOrder` 声明的**文件集合与顺序**办事。`version` 是联合类型（1 | 2），v1 声明两个文件、v2 声明三个。
2. **v2 marker 但某个 pending 缺失 → 拒绝 finalize，保留 marker 与全部 staging，抛 `OwnerTransferPendingMissingError`。** fail-closed。
3. **marker 不可解析 → 同样拒绝 finalize、保留一切，抛 `OwnerTransferMarkerUnreadableError`。**
4. v1 marker 按两文件路径走完，不抛。

**测试要求：**

- **测试 5 — `finalizeOrder` 承重（Critical，§4.4 整个方案的支点）**：**手工 stage 一个 `finalizeOrder` 与生产默认*不同*的 v2 marker**，例如 `["owner-record.json", "owner-transfer.json", "reconciliation-record.json"]`，加上与之匹配的三份 pending，然后断言 **`rename` 的实际调用序列逐项等于 marker 里写的顺序**。
  **⚠️ 「断言实际发布顺序等于 marker 声明的顺序」若不置换 marker 就是同义反复**——生产代码用同一组常量既生成 marker 又决定顺序，两者恒等；把 finalize 退回硬编码，只要硬编码顺序与常量一致，测试依然绿。**必须置换。**
  **注意 marker 只在全部 rename 之后才被 unlink**，所以 `rename` 的 mock 可在首次调用时读到它。
  **变异：把 finalize 改回「忽略 `marker.finalizeOrder`、按 version 硬编码」→ 本条必红。**
- **测试 4 — v2 marker 但 pending 缺失**：手工构造，断言拒绝 finalize、marker 与全部 staging **仍在**、抛 `OwnerTransferPendingMissingError`。**测试注释必须写明它钉的是纵深防御分支**，并写明**这条分支在生产中可达但「保留 marker 与全部 staging」这句承诺在最常见的可达路径上落空**（并发恢复：P2 删掉 stale 锁 → P3 短路进 finalize → P2 先删掉 marker 与 pending → P3 读 pending 得 ENOENT，此刻已无东西可保留）。**不要把「保留 marker 与全部 staging」当成不变式引用。**
- **测试 4b — v1 marker + 两个 pending → 只发布两个，不抛。** 直接调 `writeOwnerTransferArtifacts` 的四参形态即可（A2 已把第五参数设为可选）。
- **测试 4c — marker 不可解析 → 拒绝 finalize、保留一切、抛 `OwnerTransferMarkerUnreadableError`。** 手工构造（marker 原子写之后不可达），测试注释写明这是纵深防御。

**陷阱清单：**

- **两个新错误类必须与既有的 `OwnerTransferPreconditionError` / `OwnerTransferLockBusyError` *并列*，不得继承任何一个、也不得让它们继承共同基类。** 本仓库对这件事已有判例，照抄它的写法与口气：

  ```bash
  grep -rnF 'NOT a subclass' src/
  # 计划阶段未重推；A3 开工时重跑并贴输出。判例在 src/persistence/fileStore.ts，
  # 原文形如「Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass: ...」
  ```

  **每个新类都要带一条同形注释，写明「deliberately NOT a subclass」并点名它保护的是谁**（这里保护的是 `tryRecoverStaleOwnerTransferLock` / `acquireOwnerTransferLock` 里那些按 `instanceof` 分流的判定）。
- **finalize 的 `readFile` + `JSON.parse` 全部在 try *之前***（今天是 2 次，本任务之后是 **4** 次：marker 1 + pending 3）。规则 2/3 的拒绝逻辑正是落在那个位置。**这 4 个间隙不在 try 内那 13 步里**——A5 的测试 2 要覆盖它们，**这里必须把结构留成「try 之前 4 次解析」**，不要为了「统一错误处理」把它们塞进 try。
- **本任务扩大了一条 L1 §12 第 17 条的失败面，必须记账不要修**：`stop()` → `releaseOwnerLease` → `updateOwnerRecordWithPrecondition` 内部会跑一次**持锁**恢复，**且那次恢复不在任何 catch 内**。本任务给它加了 marker 的 `readFile` + `JSON.parse` 与规则 2/3 两条新抛出；任一抛出 → release 失败 → `stop()` 吞掉 → 第 17 条的 "immediately" 退化成 "TTL 之后"。**规则 2 可达，所以这不是纯理论。本层记账不修**（§13 第 3 笔）。**评审员：看到这条时不要要求实施者去修它。**
- **不要给 `resumeLoop.ts` 加 `Error.cause`。** §4.4 已否决：`ResumeNotEligibleError` 是单参构造，改它是导出类的公开签名变更；替代方案（组 C 按 `cannot read run artifacts:` 前缀在报告层路由）严格更简且覆盖更宽。**`resumeLoop.ts` 在本组一个字节不改。**

**Steps:**

- [ ] **Step 1: 写失败的测试 5。** 完整测试名：
  `fileStore > finalizes in the order the v2 marker declares, not in the order the production constants declare`
- [ ] **Step 2: 跑它确认失败并贴原始输出。**（今天 finalize 从不读 marker。）
- [ ] **Step 3: 写失败的测试 4 与 4c。** 完整测试名：
  `fileStore > refuses to finalize a v2 marker whose reconciliation pending is missing, keeping the marker and staging in place`
  `fileStore > refuses to finalize an unparseable marker, keeping every staged file in place`
- [ ] **Step 4: 跑这两条确认失败，两份原始输出都贴。**
- [ ] **Step 5: 加两个具名错误类（含 `deliberately NOT a subclass` 注释）。**
- [ ] **Step 6: 把 `finalizePendingOwnerTransfer` 改成 marker 驱动。** try 之前解析 marker（1 次）与 `finalizeOrder` 声明的每一份 pending（v2 时 3 次）；try 内按声明顺序逐项 `safeUnlink(temp) → writeJsonFile(temp) → rename(temp, target)`；尾部按今天的形状回收 marker 与全部 pending。
- [ ] **Step 7: 跑 Step 1/3 三条确认通过，逐条 `-t` 单跑贴输出。**
- [ ] **Step 8: 写测试 4b 并跑通。** 完整测试名：
  `fileStore > finalizes a v1 marker over its two files without throwing`
- [ ] **Step 9: 变异实验（两次）。**
  1. finalize 改回「忽略 `marker.finalizeOrder`、按 version 硬编码」→ **测试 5 必红**
  2. 规则 2 的拒绝改成「pending 缺失就跳过该文件继续」→ **测试 4 必红**
  各走三步判据，四份原始输出。
- [ ] **Step 10: 重数 try 内步数并附命令。** 用 `grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts` 数出你落地后的实际步数，**把你那次的原始输出写进提交信息**。spec 按设计推的是 13 步（3 个 temp 清理 + 3×(write, rename) + 4 个尾部 `safeUnlink`），**但那是 v2 专属的推导值，不是从代码数出来的——不要照抄 13**。
- [ ] **Step 11: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 12: 提交。**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat(fileStore): drive finalize from the transaction marker, fail-closed on unreadable marker or missing pending"
```

- [ ] **Step 13: 独立评审。** 重点：测试 5 是否真的置换了 marker（否则同义反复）、两个错误类是否并列非子类且带注释、try 之前的解析是不是 4 次、v1 分支是否仍然走得通。

---

### Task A4: 组装点 —— `ReconciliationDraft`、`newOwnerEpoch` 由事务内部填、赢家不再二次写

**Files:**
- Modify: `src/runtime/types.ts`（锚点：`export type ReconciliationRecord`）
- Modify: `src/controller/runLoop.ts`
  - `async function persistOwnerTransfer(`（签名 + `const transfer = applyOwnerEpochTransfer(` 之后、调 `writeOwnerTransferArtifacts` 之前）
  - `async function persistBoundaryAnalysis(` 内的 transfer 分支（锚点：`if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed) {`）
  - `await writeBoundaryArtifacts(runDir, {` 那个调用块
- Test: `tests/controller/runLoop.integration.test.ts`、`tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes（A2 产出）：`writeOwnerTransferArtifacts(runDir, expectedOwnerRecord, ownerRecord, transferRecord, reconciliationRecord?)`
- Consumes（既有，不改）：`export function applyOwnerEpochTransfer(...)`（`src/ownership/ownerController.ts`）——**epoch 递增规则的唯一权威实现**
- Produces（A7/A8/A9 与 §10 测试 1 依赖）：
  - `src/runtime/types.ts`：`export type ReconciliationDraft = Omit<ReconciliationRecord, "newOwnerEpoch">;`
  - `persistOwnerTransfer` 新签名（**第六个参数必需**，它只有一个生产调用者）：

    ```ts
    async function persistOwnerTransfer(
      runDir: string,
      expectedOwnerRecord: OwnerRecord,
      nextProcessInstanceId: string,
      at: string,
      reason: string,
      reconciliationDraft: ReconciliationDraft,
    ): Promise<{ ownerRecord: OwnerRecord; eligibleForContinuation: true }>
    ```

  - 赢家路径：`writeBoundaryArtifacts(runDir, { boundaryAnalysis })` —— **不再传 `reconciliationRecord`**

**采用的形状（§4.3「组装点改判」，一份公式）：**

1. `persistBoundaryAnalysis` 在 transfer 分支内组装一份 `ReconciliationDraft`：九个字段里的**八个**填好，`newOwnerEpoch` **不由它决定**。八个字段的来源逐条见 §4.2 的表；**`takeoverPermission` 是一个对象不是布尔**（`{ allowed: ownership.takeoverAllowed, reason: buildTakeoverReason(ownership.takeoverAllowed) }`，`buildTakeoverReason` 必须一起调）。
2. `persistOwnerTransfer` 收下草稿，在它已有的 `const transfer = applyOwnerEpochTransfer(...)` **之后**、`writeOwnerTransferArtifacts(...)` **之前**，用 `transfer.transferRecord.newOwnerEpoch` 填入 `newOwnerEpoch`，得到完整的 `ReconciliationRecord` 再透传给 `writeOwnerTransferArtifacts` 的第五参数。
3. **`+ 1` 在本层新代码里出现零次**，可检验：

   ```bash
   grep -rnF 'currentOwnerEpoch + 1' src/
   # 落地后必须仍然只有 src/ownership/ownerController.ts 那一行
   ```

**测试要求：**

- **测试 1 — 修复后行为（本组最承重的一条）**：驱动**生产**转移路径（经 `runLoopFromState`）并注入 `assertHeld` 抛出，断言 `reconciliation-record.json` **已在盘上**且 `resumeLoop` 放行。
  **⚠️ 不要写成「证明修复前拒绝、修复后不再」**——一条提交的测试只跑一棵树，那不可表达。它变红的方式由**测试 6 的反方向变异**提供。
- **测试 6 — 反方向变异**：把 reconciliation 退回事务外（即 `persistOwnerTransfer` 不传第五参数、赢家路径改回传 `reconciliationRecord`）→ **测试 1 必须红**。
- **测试 6d — 赢家不二次写**：断言赢家路径上 `writeBoundaryArtifacts` 之后 `reconciliation-record.json` 的 **inode 未变**。
  **⚠️ 基线 `stat` 必须紧贴 `writeBoundaryArtifacts` 调用*前*取、断言的 `stat` 紧贴调用*后*取。** 若把快照取在 `persistBoundaryAnalysis` **之前**，那期间还夹着事务本身对 `reconciliation-record.json` 的那次发布 rename，**本测试会无条件红，而红的原因与它要钉的东西无关**。**这一句必须进测试注释。**
  它成立的依据：赢家不传 `reconciliationRecord` → `writeBoundaryArtifacts` 里 `if (artifacts.reconciliationRecord !== undefined)` 整块跳过 → 那次 `writeJsonFileAtomically` 根本不执行 → inode 必然不变。变异回「赢家继续补写」则走 `writeJsonFileAtomically` 的 `rename` → **inode 必变 → 可红**。

**陷阱清单：**

- **组装点是个陷阱（第一轮评审发现，仍然成立）**：输家路径上 `ownerRecord` 与 `ownership` 在 CAS 失败后**被重新赋值**（`assertHeld()` → 重读 → 重新 evaluate），现有 reconciliation 刻意用的是**失败后重读**的值。**把组装点上提为唯一一份，会静默把输家记录退回 CAS 前的值。** 事务专用的那份是**第二份拷贝**；`writeBoundaryArtifacts` 那份**原地不动**。输家根本不进 `persistOwnerTransfer`，所以组装点改判不影响这条警告——**但也不许顺手把两份合并**。
- **不得把 epoch 递增规则复制成第二份。** 若你坚持在 `persistBoundaryAnalysis` 内自行算 `newOwnerEpoch`，**必须另外新增一条变异测试**：改掉 `applyOwnerEpochTransfer` 的增量规则（`+ 1` → `+ 2`），**一条写下完整测试名的测试必须红**（按通用条走三步判据）。**没有这条测试就不许走那条路。** 本计划建议直接走上面的形状，不走这条。
- **`writeBoundaryArtifacts` 的赢家调用改传 `undefined` 之后，§4.6 那条「靠早退所以零改动」的理由失效**——赢家根本走不到早退。正确的理由是「赢家不再调用它」。**这条只是文档性质，但 A7 会真的改这个函数，两者不要混。**
- **`boundary-analysis.json` 的读者不在 `src/` 里，但存在**：`validation/v1/lib/evidence.ts` 会读它并做 Zod 校验，四个测试文件读或断言它。赢家路径仍然写它，**不要顺手一起去掉**。
- **`writeBoundaryArtifacts` 之前那个无条件 `assertHeld()` 原样保留**——L1b 的「只增加拒绝」立场一个字不改。

**Steps:**

- [ ] **Step 1: 加 `ReconciliationDraft` 类型。** `src/runtime/types.ts`，`ReconciliationRecord` 旁边。跑 `npm run typecheck` 确认还是绿。
- [ ] **Step 2: 写失败的测试 1。** 完整测试名：
  `runLoop > publishes reconciliation-record.json inside the transfer transaction even when assertHeld throws afterwards`
  经 `runLoopFromState` 驱动一次真实转移，注入 `assertHeld` 抛出，断言 (a) `reconciliation-record.json` 在盘上、(b) 随后 `resumeLoop` 放行。
- [ ] **Step 3: 跑它确认失败并贴原始输出。**
- [ ] **Step 4: 实现组装点。** `persistBoundaryAnalysis` 组草稿（八字段）→ `persistOwnerTransfer` 收草稿并在 `applyOwnerEpochTransfer` 之后填 `newOwnerEpoch` → 透传第五参数。
- [ ] **Step 5: 跑测试 1 确认通过，`-t` 单跑贴输出。**
- [ ] **Step 6: 写失败的测试 6d。** 完整测试名：
  `fileStore > leaves the reconciliation-record.json inode untouched when the winner writes boundary artifacts`
  跑 → 贴输出。
- [ ] **Step 7: 把赢家路径的 `writeBoundaryArtifacts` 调用改为不传 `reconciliationRecord`。** 跑 6d 确认通过并贴输出。
- [ ] **Step 8: 跑 `grep -rnF 'currentOwnerEpoch + 1' src/` 并贴原始输出**，确认仍只有 `ownerController.ts` 一行。
- [ ] **Step 9: 变异实验（两次）。**
  1. `persistOwnerTransfer` 不传第五参数（reconciliation 退回事务外）→ **测试 1 必红**
  2. 赢家路径改回传 `reconciliationRecord` → **测试 6d 必红**
  各走三步判据，四份原始输出。
- [ ] **Step 10: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 11: 提交。**

```bash
git add src/runtime/types.ts src/controller/runLoop.ts tests/controller/runLoop.integration.test.ts tests/persistence/fileStore.test.ts
git commit -m "feat(runLoop): assemble the reconciliation draft outside the epoch rule and stop the winner from re-writing it"
```

- [ ] **Step 12: 独立评审。** 重点：`+ 1` 是否仍只有一处、输家那份 reconciliation 是否被误合并、6d 的基线快照点是否紧贴调用前、测试 1 是否真的经 `runLoopFromState` 驱动而不是直接调 `fileStore`。

---

### Task A5: 崩溃中间态矩阵与两条 epoch 判定的承重（测试 2、6b）

**Files:**
- Test only: `tests/controller/runLoop.integration.test.ts`（fixture 构造与驱动）、`tests/persistence/fileStore.test.ts`（中断注入）

**Interfaces:**
- Consumes（A1–A4 产出）：全部 10 个 staging 路径常量的**文件名**、marker v2 与 `finalizeOrder`、`OwnerTransferPendingMissingError` / `OwnerTransferMarkerUnreadableError`、`writeOwnerTransferArtifacts` 的第五参数
- Consumes（既有）：`export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility`（`src/controller/resumeLoop.ts`）
- Produces（A6 依赖）：**两组具名 fixture 构造器**（放在测试文件内，不导出到 `src/`）：
  - **首发转移 fixture**：`owner-transfer.json` 事前不存在；N → N+1
  - **双转移 fixture**：N → N+1 已成功落盘；N+1 → N+2 崩在中途

**测试要求：**

- **测试 2 — 崩溃注入，覆盖每一个间隙**。区间 = 「`finalizePendingOwnerTransfer` 的 try **之前**那 **4** 次 `readFile` + `JSON.parse`（marker 1 + pending 3）」**＋**「try 内每一步」的每一个间隙。
  - **步数必须从落地后的代码重数**（`grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts`），**把你那次的原始输出贴进提交信息。不要照抄任何数字。** spec 按设计推的是 13 步，但**改动前的代码里没有 13 这个数**。
  - **mock 面必须含 `unlink`**（`safeUnlink` 走 `node:fs/promises` 的 `unlink`）。只 mock `rename` / `writeFile` **做不出尾部两个间隙**，测试会悄悄退化。
  - 断言：**每个中间态都让 `resumeLoop` 拒绝**；**marker 仍在的中间态都能由 `recoverInterruptedOwnerTransfer` 推完**。
  - **⚠️ try 之前那 4 个间隙里，marker 解析那一格是唯一承重的那个**——规则 3 与测试 4c 的落点就在那里。少数一格 = 那条纵深防御分支零覆盖。
- **测试 6b — 两条 epoch 相等判定承重**：变异掉 `evaluateResumeEligibility` 的任一条 epoch 相等判定 → **测试 2 必须红**。
  - **判据 A**（`reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch`）：**只有双转移 fixture 杀得掉**。单转移时，reconciliation 已发布而 transfer 未发布的那些间隙里 `owner-transfer.json` 尚不存在，读它直接抛、`resumeLoop` 在进门前就拒绝，**判据 A 根本没被求值，变异存活**。双转移下盘上是「reconciliation.newOwnerEpoch = N+1、ownerTransfer.newOwnerEpoch = N+2、ownerRecord.currentOwnerEpoch = N+2」，判据 B 通过、**只有判据 A 拒绝**——这才是唯一杀得掉它的形状。

    **Amended 2026-08-02 (c)：本句只在它自己限定的子集里为真，不能读成「判据 A 在单转移下不可达」——那比事实更强，会给「把它删掉」提供借口。** 这纠正的是*本文档*的缺陷，不是实现的缺陷，实现一直是对的。本句限定的范围是「reconciliation 已发布而 transfer 未发布的那些间隙」，在这个子集里「判据 A 根本没被求值」确实成立。但首发转移 fixture 的间隙 14–17（本节四格矩阵记的正是 `resume=accepted`）不属于这个子集：`src/controller/resumeLoop.ts` 的 `evaluateResumeEligibility` 是八条判据全部跑完才返回 `{ ok: true }`，判据 A 是其中第 4 条，在这些间隙里它**被跑到、被求值、且通过**——这与下方判据 B 那条 Amended 注记是同一处结构性修订，理由同源：`Promise.all` 里对 `owner-transfer.json` / `reconciliation-record.json` 的读是未经恢复的裸读，只有在两者都已发布的间隙里，八条判据才会全部被求值。删掉判据 A 会在间隙 14–17 里造成真实的行为改变（判据 A 不再阻止本该被阻止的 resume），这正是本条注记要挡住的删除理由。
  - **判据 B**（`ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch`）：**「整条删掉」这个变异**任何单转移场景都能杀。**⚠️ 但 `!==` → `<` 这个变异两组 fixture 都杀不掉**（首发是 `N < N+1`，变异体照样拒绝；双转移是 `N+2 === N+2`，该判据本来就不拒绝）——那一条属 A6 的第三组 fixture。

    **Amended 2026-08-02 (a)：「任何单转移场景都能杀」这个前提是假的，A5 实测证伪。** 这纠正的是*本文档*的缺陷，不是实现的缺陷——实现是对的，一直是对的。实测：判据 B 在首发转移 fixture 的 17 个崩溃间隙里**从来不成立、因而从来不决定结果**，「整条删掉」这个变异在首发 fixture 下**存活**（原始输出见 `task-A5-report.md` 的第 3 次变异实验）。**这里的措辞要精确，不能读成「判据 B 在单转移下不可达」——那比事实更强，会给「把它删掉」提供借口。** 分两段：间隙 1–13 处闸门**没进**（`Promise.all` 里某条裸读先抛，`resumeLoop` 在 `evaluateResumeEligibility` 之前就拒绝），判据 B 未被求值；间隙 14–17 处闸门**进了**，`evaluateResumeEligibility` 只有八条判据全部跑完才返回 `{ ok: true }`、判据 B 是其中第六条，所以它**确实被求值了，只是通过**（这四格矩阵记的正是 `resume=accepted`）。两段合起来才是「删掉它对首发 fixture 的 17 行矩阵零影响」的完整理由。结构原因与本节给判据 A 的论证是同一条：`src/controller/resumeLoop.ts` 的 `Promise.all` 里 `readOwnerRecord` 是**经恢复**的读，`readOwnerTransferRecord` / `readReconciliationRecord` 是**未经恢复**的裸读。首发转移下 `owner-transfer.json` 要么尚不存在（读它直接抛，`resumeLoop` 在进闸门前就拒绝），要么已经等于恢复后的 owner epoch，所以 `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` 永远不成立。唯一本可能咬到的形状——间隙 8–10，`owner-transfer.json` 已发布而 `owner-record.json` 尚未发布——被 `reconciliation-record.json` 仍然缺失遮住了：`readReconciliationRecord` 先抛，闸门根本没进。**结论：在磁盘层面，判据 B 与判据 A 一样，只由双转移 fixture 承重**（双转移的间隙 5–7：判据 A 通过、只有判据 B 拒绝）。首发 fixture 承重的是另一件事——证明首发转移下闸门到不了，这正是判据 A 变异存活的原因。本条后半句关于 `!==` → `<` 的判断不受影响，仍然成立。
  - **两组 fixture 各跑一次变异**，四份原始输出。

**陷阱清单：**

- **变异注入点在 `src/controller/resumeLoop.ts` 的生产判据上，不是在 fixture 上。** 「同步改中断点」＝改 fixture，**不是变异**。
- **测试 2 是测试 6b 的杀伤面，所以测试 2 的断言必须有内容。** 一条断言写空的测试 2 会让 6b 的两条变异都「达标」。**评审员必须逐个间隙确认断言不是恒真。**
- **`resumeLoop` 的 `Promise.all` 会触发恢复**（`readOwnerRecord` 第一条语句就是 `recoverInterruptedOwnerTransfer`）。构造「中间态让 resumeLoop 拒绝」的断言时，**要意识到读这个动作本身可能改变磁盘**——marker 不在时它只是零写（`lockHeld` 未传，不会走 cleanup），marker 在且锁不由活进程持有时它会 finalize。**两种情形要分开断言，不要合成一条。**
- **不要把「不可达的纵深防御分支」写成可达路径论证。** 规则 3 与「pending 被写坏」在原子写之后**不可达**；规则 2 **可达**（并发恢复路径）。测试注释要写对。

**Steps:**

- [ ] **Step 1: 重数 finalize 的步数与 try 前解析次数。** 跑 `grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts`，贴原始输出，写下你数出来的两个数（try 前 N 次解析、try 内 M 步）。
- [ ] **Step 2: 写两组 fixture 构造器。** 首发转移 / 双转移。**先各写一条最小的冒烟断言证明 fixture 真的构造出了预期磁盘状态**（否则 fixture 本身没有护栏）。
- [ ] **Step 3: 写失败的测试 2。** 完整测试名：
  `fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives`

  **Amended 2026-08-02 (e)：上面这个测试名已经作废，落地的测试不叫这个名字——照抄它代入 `-t` 会零匹配、全 skipped、退出码 0，正是 `Amended 2026-08-02 (b)` 要堵的那种假绿，而且它就长在本文档里。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。测试在 A5 的修复轮 1 里按人的裁定改了名：裁定见 `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md` 的 `Task A5: HUMAN RULING 2 (plan-mandated)` 一条（间隙 14–17 接受是对的，旧名字的中间分句因此没有能失败的断言，违反「测试名里每一个分句都必须有一条能失败的断言」）；同一台账的 `Task A5: minor (deferred) for GATE-A triage` 第 6 条早已记下本处 Step 3 仍留着改名前的旧名字，当时人的裁定只授权改两处前提句，所以只挂账未修——本注记就是补上它。原始单跑输出见 `task-A5-report.md` 的「覆盖测试单跑（现行全名）」一节。现行 `it` 名逐字为：

  `refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives`

  重新求证：`grep -cF 'refuses resume at every pre-commit crash gap' docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 在本注记落地前为 **0**（本文档一次都没提过现行名字）；`grep -n 'refuses resume at every pre-commit crash gap' tests/persistence/fileStore.test.ts` 命中落地的 `it(`。代入 `-t` 时用上面这个裸 `it` 名。

  按 Step 1 数出的 N + M 个间隙逐个注入。
- [ ] **Step 4: 跑它。** 若绿（实现已正确），**不算完成**——直接进 Step 5 的变异证明。若红，先修测试本身（不是修生产代码）。
- [ ] **Step 5: 变异实验（四次）。**
  1. 判据 A 整条删掉 × 首发转移 fixture → 预期**不红**（记录这个事实，它就是「判据 A 只有双转移杀得掉」的证据）
  2. 判据 A 整条删掉 × 双转移 fixture → **测试 2 必红**
  3. 判据 B 整条删掉 × 首发转移 fixture → **测试 2 必红**

     **Amended 2026-08-02 (a)：实测不红——变异存活，这是预期结果而不是缺陷。** 与上方判据 B 那条同一处修订，理由见那里（首发转移下判据 B 从不成立、因而从不决定结果；间隙 1–13 闸门没进故未求值，间隙 14–17 求值了但通过）。这一条因此与第 1 条同类：把原始输出照样贴出来，作为「fixture 分工」与本修订的证据，而不是击杀。**杀掉判据 B 的是第 4 条（双转移间隙 5–7）。**
  4. 判据 B 整条删掉 × 双转移 fixture → 记录结果
  **第 2、3 两条走完整三步判据（注入前单跑绿 + 注入后单跑红 + 两份原始输出）；第 1、4 两条把原始输出照样贴出来，作为「fixture 分工」的证据。**

  **Amended 2026-08-02 (a) 对本行的连带更正：** 走完整三步击杀判据的是**第 2、4** 两条；第 **1、3** 两条是非击杀，按「贴原始输出」处理。
- [ ] **Step 6: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 7: 提交。**

```bash
git add tests/controller/runLoop.integration.test.ts tests/persistence/fileStore.test.ts
git commit -m "test(transaction): pin every crash gap of the three-file transaction and both epoch equality criteria"
```

- [ ] **Step 8: 独立评审。** 重点：间隙数是不是从代码数出来的（附命令与输出）、mock 面是否含 `unlink`、两组 fixture 是否真的不同、四次变异的原始输出是否齐备、测试 2 的断言是否可失败。

---

### Task A6: `evaluateResumeEligibility` 八条判据的变异 campaign（测试 15、验收 5）

**Files:**
- Test only: `tests/controller/resumeLoop.gate.test.ts`

**Interfaces:**
- Consumes（A5 产出）：首发转移 / 双转移两组 fixture 的**构造方式**（本任务在 gate 测试里各自重建一份最小形态即可，不跨文件 import 测试辅助）
- Consumes（既有，不改）：`evaluateResumeEligibility` 的八条判据

**八条判据与本任务采用的变异（§15 验收 5 的表，第四/六波更正后）：**

| # | 判据（逐字，含 cast） | 采用的变异 |
|---|---|---|
| 1 | `(ownerTransfer.eligibleForContinuation as boolean) !== true` | **整条删掉**（`!== true` → `=== false` 是等价变异，已排除） |
| 2 | `reconciliation.eligibleForContinuation !== true` | **整条删掉**（同上；该字段静态类型就是 `boolean`） |
| 3 | `reconciliation.ownershipVerdict !== "OWNER_LOST"` | 整条删掉 |
| 4 | `reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch` | 改为 `>`（判据 A，**只有双转移 fixture 杀得掉**） |
| 5 | `ownerRecord.supersededByEpoch !== null` | 整条删掉 |
| 6 | `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` | 改为 `<`（判据 B，**需要第三组 fixture**） |
| 7 | `ownerRecord.ownerStatus !== "current"` | 整条删掉 |
| 8 | `!RESUMABLE_STATUSES.includes(runState.status)` | 改为恒 false |

**开工前重推一次判据原文：**

```bash
sed -n '39,68p' src/controller/resumeLoop.ts
# 把你那次的原始输出贴出来。**若与上表逐字不符，停下并上报**（八条判据本层一个字节不改，
# 不符只可能是别人改了它）。
grep -cF 'return { ok: false' src/controller/resumeLoop.ts   # 必须是 8（计划阶段实测 8）
```

**第 1 条的额外断言（把 `as boolean` 的动机从注释变成测试）：**

fixture 提供一份 `eligibleForContinuation` 字段**缺失**（`undefined`）的 `owner-transfer.json`，断言 `evaluateResumeEligibility` **仍然拒绝**。**变异：把 `!== true` 改成 `=== false` → 该断言必须红。** cast 的存在说明该字段的静态类型**不是** `boolean`，第 1 条防的正是非布尔的运行时取值（`undefined` / `null` / `"true"` / `0`）。

**第 6 条的第三组 fixture（七条约束，一条都不能少）：**

`currentOwnerEpoch > ownerTransfer.newOwnerEpoch`（例如 `currentOwnerEpoch = N+2`、`newOwnerEpoch = N+1`）。基线 `N+2 !== N+1` → 拒绝；变异体 `N+2 < N+1` 为 false → **放行** → 红。
**⚠️ 这组 fixture 必须同时让其余七条判据全部通过：**

| 判据 | fixture 必须 | 相对第 6 条的位置 | 不满足则 |
|---|---|---|---|
| 1 | `ownerTransfer.eligibleForContinuation === true` | 之前 | 两侧都被第 1 条抢先拒绝 → **变异存活** |
| 2 | `reconciliation.eligibleForContinuation === true` | 之前 | 同上 → **变异存活** |
| 3 | `reconciliation.ownershipVerdict === "OWNER_LOST"` | 之前 | 同上 |
| 4 | `reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`（也是 N+1） | 之前 | 同上 |
| 5 | `ownerRecord.supersededByEpoch === null` | 之前 | 同上 |
| 7 | `ownerRecord.ownerStatus === "current"` | **之后** | 变异体在第 6 条放行后又被第 7 条拒 → 两侧行为相同 → **变异存活** |
| 8 | `runState.status` 在 `RESUMABLE_STATUSES` 内 | **之后** | 同上 |

**⚠️ 判据 2 尤其危险**：这组 fixture 的场景描述是「owner record 的 epoch 跑到了 transfer 前面」，与 **reconciliation 的 eligible 位**毫无直觉关联，实施者极易不去设它 → 第 2 条抢先拒绝 → **变异存活**。
**这是一份手工 fixture，生产中不可达**（它对应「更晚的一次转移已经完成、但 `owner-transfer.json` 还是旧的」）——**这没关系，测试 15 钉的是判据的语义不是可达性**，但**测试注释必须写明这一点**。

**陷阱清单：**

- **每一条都必须点名一条测试的完整测试名，八条八个名字。** 「至少一条已有测试红」按字面是最脆的写法——一次注入顺手杀掉一批无关既有测试是常态。**八条各自走三步判据，共 16 份原始输出。**
- **不许「靠别的判据顺带挡住」而存活。** 每一条的 fixture 都要让被变异的那一条是**唯一**做出裁决的那条。
- **不要把函数体哈希守卫加回来。** §15 验收 5 已按 Rule 7 裁定：**挑「计数守卫 ＋ 八条变异测试」，撤销哈希守卫**，并撤销它配套的三条防护栏。若将来有人想加回来，**必须先说明本条覆盖不到什么**，不许两个并存。
- **计数守卫自己也有误红形状**：`grep -cF 'return { ok: false'` 依赖那八行各自把它写在同一行，一次 `prettier` 换行计数就掉到 7。**保留它的理由是误红形状可判定且易修**，不是因为它干净。
- **任何一条变异被实测证明存活时，必须就地写下补法或明写「暂无补法」，不许沉默。**

**Steps:**

- [ ] **Step 1: 重推判据原文与计数。** 跑上面两条命令，贴原始输出。不符则停下上报。
- [ ] **Step 2: 写八条测试（各一条，八个完整测试名）。** 命名形如：
  `evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is not literally true`
  `evaluateResumeEligibility > refuses when the reconciliation record is not eligible`
  `evaluateResumeEligibility > refuses when the reconciliation verdict is not OWNER_LOST`
  `evaluateResumeEligibility > refuses when the reconciliation epoch does not equal the transfer epoch`
  `evaluateResumeEligibility > refuses when the owner record has been superseded`
  `evaluateResumeEligibility > refuses when the owner epoch does not equal the transfer epoch`
  `evaluateResumeEligibility > refuses when the owner status is not current`
  `evaluateResumeEligibility > refuses when the run status is not resumable`
  **每条各自带自己的 fixture**，其余七条判据全部满足。
- [ ] **Step 3: 写第 1 条的额外断言（`undefined` fixture）。** 完整测试名：
  `evaluateResumeEligibility > refuses when owner-transfer eligibleForContinuation is missing entirely`
- [ ] **Step 4: 写第 6 条的第三组 fixture 测试。** 完整测试名：
  `evaluateResumeEligibility > refuses when the owner epoch has run ahead of the transfer epoch`
  **按上表七条约束逐条设值，并在测试注释里逐条写明为什么每一条都要设。**
- [ ] **Step 5: 跑这十条确认全绿（它们钉的是今天就正确的行为），十份原始输出全贴。**
- [ ] **Step 6: 八 + 二 = 十次变异实验。** 每次：注入前该条单跑绿（贴）→ 注入后该条单跑红（贴）→ 还原。
  - 第 4 条按 A5 的**双转移** fixture 跑
  - 第 6 条的 `<` 变异按 Step 4 的**第三组** fixture 跑
  - 第 1 条的 `=== false` 变异按 Step 3 的 `undefined` fixture 跑
  **共 20 份原始输出。任何一条存活，就地写下补法或明写「暂无补法」，然后上报——不许沉默通过。**
- [ ] **Step 7: 跑一次计数守卫并贴输出。** `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` 必须是 8。
- [ ] **Step 8: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 9: 提交。**

```bash
git add tests/controller/resumeLoop.gate.test.ts
git commit -m "test(resumeLoop): give each of the eight eligibility criteria its own killing mutation"
```

- [ ] **Step 10: 独立评审。** 重点：八条 fixture 是否各自让被变异那条成为唯一裁决者、第 6 条的七条约束是否逐条设了（尤其判据 2）、20 份原始输出是否齐备、`src/controller/resumeLoop.ts` 是否**一个字节未改**（`git diff` 对它必须为空）。

---

### Task A7: 读侧收窄（处置一）—— ENOENT 归因、abandon 决策、事件与 swallow

**Files:**
- Modify: `src/persistence/fileStore.ts`
  - `async function readPersistedSuccessfulTransferArtifacts(`（重构：把 `readOwnerTransferRecordRaw` 移出 `Promise.all`）
  - `async function preserveSuccessfulReconciliationIfNeeded(`（返回类型改为判别式联合）
  - `export async function writeBoundaryArtifacts(`（新增 abandon 分支）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes（既有，不改）：
  - `function preserveSuccessfulReconciliationIfNeededFromArtifacts(persistedOwnerRecord, persistedOwnerTransferRecord, persistedReconciliationRecord, nextReconciliationRecord): ReconciliationRecord`
  - `async function readPersistedReconciliationRecord(runDir: string): Promise<ReconciliationRecord | undefined>` —— **自带 `catch { return undefined }`，从不抛。本任务对它建立承重依赖，不得收窄它。**
  - `export async function appendEvent(runDir: string, event: RunEvent): Promise<void>` —— 裸 `appendFile`，**零守卫，可以 reject**
  - `export type RunEvent = { type: string; at: string; detail: string }` —— **`type` 是裸 `string`，不是联合类型**，所以新增一个事件类型名**不改任何类型定义**
- Produces（A8、组 C 的测试 12d 依赖）：

  ```ts
  type PersistedTransferArtifactsRead =
    | { kind: "artifacts"; ownerRecord: OwnerRecord; ownerTransferRecord: OwnerTransferRecord;
        reconciliationRecord: ReconciliationRecord | undefined }
    | { kind: "no_published_transfer" }          // ENOENT of owner-transfer.json —— 放行
    | { kind: "unreadable"; error: unknown };    // 其余任何读失败 —— fail-closed

  type ReconciliationWriteDecision =
    | { kind: "write"; record: ReconciliationRecord }
    | { kind: "abandon"; error: unknown };

  async function preserveSuccessfulReconciliationIfNeeded(
    runDir: string,
    nextReconciliationRecord: ReconciliationRecord,
  ): Promise<ReconciliationWriteDecision>
  ```

  - 新事件类型名：**`reconciliation_write_abandoned`**（命名与既有事件同形：`resume_denied` / `lease_expired_observed` / `workspace_retry` 都是「名词_过去分词」）。`detail` 携带 `String(error)`。

**采用的实现（本计划裁定一 + 裁定二，见文首）：**

1. **`readPersistedSuccessfulTransferArtifacts`**：`readOwnerTransferRecordRaw` **单独 `try`**——ENOENT → `{ kind: "no_published_transfer" }`；非 ENOENT → `{ kind: "unreadable", error }`。其余两读留在 `Promise.all` 里，外层 catch 一律 `{ kind: "unreadable", error }`。
2. **`preserveSuccessfulReconciliationIfNeeded`**：`eligibleForContinuation` 为真 → 早退 `{ kind: "write", record: next }`（形状不变）；`no_published_transfer` → `{ kind: "write", record: next }`（**放行，这一格必须保留**）；`unreadable` → `{ kind: "abandon", error }`；`artifacts` → 委派给 `…FromArtifacts` 并包成 `{ kind: "write", record }`。
3. **`writeBoundaryArtifacts`** 的 abandon 分支，**顺序写死**：
   - **先调回调**（A8 加，本任务先留出调用点或在 A8 一并接上——见「本任务与 A8 的分工」）
   - **再 `appendEvent`，且那次 `appendEvent` 必须用与 `appendLeaseEvent` 同形的 `try { … } catch { }` 包起来 ＋ 同口气的就地注释**
   - **然后 `return`（不写 `reconciliation-record.json`），不抛**
   - `boundary-analysis.json` 那次写**照常发生**（它在保护之前）

**本任务与 A8 的分工（写死，避免两边都以为对方做了）：**

- **A7 做**：读侧收窄、`ReconciliationWriteDecision`、abandon 分支里的 `appendEvent` ＋ swallow ＋ `return`。**`writeBoundaryArtifacts` 的第三个可选参数在 A7 不加。**
- **A8 做**：第三个可选参数 `options`、回调调用（**插在 `appendEvent` 之前**）、以及往上三层的透传。

**为什么 `appendEvent` 必须 swallow（§4.3 第六波，Critical）：**

逐环走这条抛出路径：`appendEvent` 在 abandon 块里 reject（`events.jsonl` 不可写：ENOSPC / EACCES / 目录已被删）→ `writeBoundaryArtifacts` 抛 → `persistBoundaryAnalysis` 抛（它的两个调用点都在 `runLoopFromState` 的外层 try 内）→ 落到外层 catch → `isLeaseStopError` **匹配不上 I/O 错误** → 走到 `transitionRunState(state, "failed", failureReason)`。
**即：一次保护性放弃，因为 `events.jsonl` 写不进去，被升级成 attempt failed —— 正是人裁明令禁止的那件事。**

**修法抄本仓库自己的判例，不发明新形状：**

```bash
grep -nF -A5 'const appendLeaseEvent = async' src/controller/leaseHeartbeat.ts
# 计划阶段实测：:58 定义、:59 `try {`、:60 `await appendEvent(options.runDir, {...})`、
#   :61 `} catch {`、:62 `// Swallowed by contract: the stop signal and the refusal must still fire without it.`
```

**这个修法同时满足三条约束，逐条写出来（不许只写「照抄判例」）：**

1. **人裁「不抛出」**——抛出路径消失，`writeBoundaryArtifacts` 在 `events.jsonl` 不可写时仍然正常 resolve。
2. **Rule 12「不许静默」**——吞掉的只有**审计日志**那一半；**当场可见性由 A8 排在前面的回调独家兑现**。**这正是第五波那次路由改动买到的东西，所以「吞」在这里第一次变得正当**：在「落盘但不路由」的形态下 `events.jsonl` 是唯一出口，吞它就是真静默。
3. **Rule 11「符合既有约定」**——判例在**同一个仓库、同一个函数（`appendEvent`）、同一条理由**。

**为什么 `appendEvent` 吞而回调不吞（两者危险同构、处置相反，理由必须写进注释）**：差别在**谁能修好它**。回调的实现**在本层控制范围内**（§9 定死为一次数组 push，不做 I/O），所以它抛出只可能是**编程错误**，必须显眼地炸出来；`appendFile` 的 I/O **不在**任何人的控制范围内，它抛出是**环境事实**，把它炸成 attempt failed 只是用一个更大的错误盖住一个更小的。

**Amended 2026-08-05：上段括号里「§9 定死为一次数组 push，不做 I/O」在今天为假 —— §9 那一行已被人裁改成「当场 `options.stderr(...)`（含单行折叠），不得抛出」**（见 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §9 模块表 `src/sweep/sweepRuns.ts` 那一行下方的 `Amended 2026-08-05`）。这纠正的是*本计划*的缺陷，不是实现的缺陷，**且上段的结论一个字不改**：`appendEvent` 吞、回调不吞，这个不对称的处置仍然成立。**读作**：回调之所以仍在**本层控制范围内**，今天的理由不再是「它不做 I/O」（它今天当场写 stderr），而是**它的落点 `options.stderr` 是调用方注入的槽**（`SweepOptions.stderr`），回调体本身只有一次同步调用 —— 不碰文件系统、不 await。**因此它抛出仍然只可能是编程错误，必须显眼地炸出来**；而 `appendFile` 的 I/O 不在任何人的控制范围内，它抛出是**环境事实**。**上段论点的支点是「谁能修好它」，不是「回调做不做 I/O」** —— 支点没动，只有描述它的那半句要按今天的措辞重述。**本段末句「理由必须写进注释」仍然有效**：落地的那段注释在 `src/persistence/fileStore.ts` 的 `writeBoundaryArtifacts` 内，已按本条同步。

**测试要求（§10 测试 6f，三条子用例，缺一不可，各自独立的 `it`）：**

- **(i) 放行方向**：fixture 目录**只有** `owner-record.json`（可读、完整），**没有** `owner-transfer.json`；以 `eligibleForContinuation: false` 的 reconciliation 直接调导出的 `writeBoundaryArtifacts`。断言 `reconciliation-record.json` **被写下**、内容是传入的那份。
  **它钉的是「收窄没有被实施成全部 fail-closed」**——任何从未转移过的 `stale_candidate` run 都走这条路（`reconciliationRecord` 的传入条件是 `boundaryAnalysis.status === "stale_candidate"`，**与「是否发生过转移」无关**）。
  **变异：把 ENOENT 豁免整条删掉 → 本条必红。**
- **(ii) ENOENT 但不是 `owner-transfer.json`**：fixture 有 `owner-transfer.json`（可读）、**没有** `owner-record.json`。断言 `reconciliation-record.json` **未被写下**，且 `events.jsonl` 多了一条 `reconciliation_write_abandoned`。
  **变异：把归因去掉、改成一律放行 ENOENT → 本条必红。这一条是三条里唯一能杀掉「一律放行 ENOENT」那个实现的。**
- **(iii) 非 ENOENT 方向**：fixture 三个文件齐备，但 `owner-record.json` 内容不是合法 JSON（读它抛 `SyntaxError`）。断言同 (ii)。
  **变异：退回今天的裸 `catch { return null }` → 本条必红。**
- **⚠️ (i) 与 (ii)/(iii) 必须是各自独立的 `it`，不许合成一条**：合成之后一个「一律放行」的实现会让合并断言的一半通过、另一半被同一条 `expect` 掩盖。
- **⚠️ 本条只钉「放弃」这个判定，不钉它的可见性。** (ii)/(iii) 里那句「`events.jsonl` 多了一条」是**产物断言，不是路由断言**——一个「事件写了、回调没调」的实现会让本条全绿。**可见性那一半由 A8 的 12d(iii) 与组 C 的 12d(i)(ii) 承重。**

**陷阱清单：**

- **爆炸半径已在计划阶段重跑过一遍，落地时必须再跑一遍**（§4.3 明确要求，因为 A2 的签名扩容本来就要动 `fileStore.test.ts`）：

  ```bash
  grep -nF 'eligibleForContinuation' tests/persistence/fileStore.test.ts
  # 计划阶段实测 22 行；其中作为 reconciliationRecord 传入且为 false 的是三处：:1219 :1283 :1349
  grep -rnF 'writeBoundaryArtifacts' tests/
  # 计划阶段实测：fileStore.test.ts 的 :1116 :1175 :1199 :1263 :1352 :1363 :1907 :1918 :1942 :1948 :1973
  #   ＋ runLoop.integration.test.ts:1430（其余命中为 import 与注释）
  ```

  三处 `false` fixture **都先写了 `owner-record.json` 与 `owner-transfer.json`**，三读不抛，**收窄后不变红**。
  **⚠️ 这个结论有一个明确的失效条件**：`fileStore.test.ts` 里那个「fixture 目录**刻意不含** owner-record.json 与 owner-transfer.json」的 `describe`（它今天传的是 `eligibleForContinuation: true`，走早退所以不进保护），**一旦被改成传 `false`，它会立刻成为第一条被收窄打红的测试——而它红得是对的**。不要为了让它绿而放宽收窄。
- **明确写下它不修什么**：**它不关闭 §4.3 的 T0/T1/T2 残余 TOCTOU。** T0 那次 ENOENT 是「确定没有赢家」的**真实**观测，只是这个观测在 T2 已经过期。**把 ENOENT 也一并 fail-closed 会关闭它，但代价不可接受**——那等于让绝大多数 run **再也不写 `reconciliation-record.json`**。那不是「增加拒绝」，那是删掉一条正常路径上的产物。**残余具名传 L5（§13 第 4 笔），本层不修。**
- **不要顺手收窄 `readPersistedReconciliationRecord` 的 `catch { return undefined }`。** 本任务把「它从不抛」当成「健康路径上唯一的 null 来源是 owner-transfer ENOENT」的前提。依据三条：(a) L1 §12 第 7 条的原文范围是 owner record ＋ 租约门，不含该文件；(b) 该文件由 temp + rename 发布，**截断态不可达**；(c) 即便可达，`undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation` → 合成赢家视图，**赢家不会丢**。
- **`preserveSuccessfulReconciliationIfNeededFromArtifacts` 一个字节不改。** 本任务动的只有它上游那一层。
- **§4.6 的「代码零改动」在本任务落地后为假**——这是本计划裁定三已经处理过的，**不要因为 spec 里那句话而回避改它**，也不要顺手去改 spec。

**Steps:**

- [ ] **Step 1: 重跑爆炸半径两条命令并贴原始输出。** 与计划里的实测值比对；不一致则停下上报。
- [ ] **Step 2: 写失败的测试 6f(i)。** 完整测试名：
  `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`
  跑它——**今天应该绿**（裸 catch 放行一切）。**绿不算完成**，它的护栏由 Step 7 的变异提供。
- [ ] **Step 3: 写失败的测试 6f(ii) 与 6f(iii)。** 完整测试名：
  `fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned`
  `fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned`
- [ ] **Step 4: 跑这两条确认失败，两份原始输出都贴。**
- [ ] **Step 5: 实现读侧重构与 `ReconciliationWriteDecision`。**
- [ ] **Step 6: 实现 `writeBoundaryArtifacts` 的 abandon 分支**：`appendEvent`（**用 `try{}catch{}` 包起来 ＋ 三条约束的就地注释**）→ `return`。跑 Step 2/3 三条确认通过，三份原始输出都贴。
- [ ] **Step 7: 变异实验（三次）。**
  1. 删掉 ENOENT 豁免（一律 fail-closed）→ **6f(i) 必红**
  2. 归因去掉、改成 `if (code === "ENOENT") return { kind: "no_published_transfer" }`（不区分文件）→ **6f(ii) 必红**
  3. 退回裸 `catch { return null }` 语义（一律放行）→ **6f(iii) 必红**
  各走三步判据，六份原始输出。
- [ ] **Step 8: 单独验证 swallow。** 临时把 `appendEvent` 的 `try{}catch{}` 拿掉（生产代码变异），mock `appendEvent` 抛出，**断言 `writeBoundaryArtifacts` 抛了**——这一步只是让你**亲眼看到**没有 swallow 时的行为，看完立刻还原。**这次观察的原始输出也贴出来。** 它的正式护栏是 A8 的 12d(iii) 子断言。
- [ ] **Step 9: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 10: 提交。**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat(fileStore): fail closed on unreadable transfer artifacts, abandoning the reconciliation write instead of writing through"
```

- [ ] **Step 11: 独立评审。** 重点：ENOENT 归因是不是「哪次读抛的」而不是 `error.code`、三条子用例是不是三个独立 `it`、`appendEvent` 的 swallow 有没有带三条约束的注释、`readPersistedReconciliationRecord` 是否被误动、`preserveSuccessfulReconciliationIfNeededFromArtifacts` 是否一个字节未改。

---

### Task A8: 四层可选回调通道（`onReconciliationWriteAbandoned`）

**Files:**
- Modify: `src/persistence/fileStore.ts`（`export async function writeBoundaryArtifacts(`）
- Modify: `src/controller/runLoop.ts`（`async function persistBoundaryAnalysis(` 与它的**两个**调用点；`export async function runLoopFromState(`）
- Modify: `src/controller/resumeLoop.ts`（`export async function resumeLoop(`）
- Test: `tests/persistence/fileStore.test.ts`、`tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes（A7 产出）：`ReconciliationWriteDecision`、abandon 分支、`reconciliation_write_abandoned` 事件名
- Produces（B2、C1、C3 依赖）：

  ```ts
  // fileStore.ts —— 第三个可选参数，返回类型不变
  export async function writeBoundaryArtifacts(
    runDir: string,
    artifacts: { boundaryAnalysis: RunBoundaryAnalysis; reconciliationRecord?: ReconciliationRecord },
    options?: { onReconciliationWriteAbandoned?: (detail: string) => void },
  ): Promise<void>

  // runLoop.ts —— 第五个可选参数
  async function persistBoundaryAnalysis(
    runDir: string,
    state: RunState,
    heartbeat: LeaseHeartbeat,
    executionRecovery?: ExecutionRecovery,
    onReconciliationWriteAbandoned?: (detail: string) => void,
  ): Promise<void>

  // runLoop.ts —— 第七个位置参数，是一个可选参数**对象**（B2 与 C1 会往里加键）
  export type RunLoopFromStateOptions = {
    onReconciliationWriteAbandoned?: (detail: string) => void;
  };
  export async function runLoopFromState(
    contract: LoopContract,
    runDir: string,
    adapter: RuntimeAdapter,
    initialLoopState: RunState,
    heartbeat?: LeaseHeartbeat,
    leaseLoss?: LeaseLossSignal,
    options?: RunLoopFromStateOptions,
  ): Promise<RunState>

  // resumeLoop.ts —— 第三个位置参数，同样是一个可选参数**对象**
  export type ResumeLoopOptions = {
    onReconciliationWriteAbandoned?: (detail: string) => void;
  };
  export async function resumeLoop(
    runDir: string,
    adapter: RuntimeAdapter,
    options?: ResumeLoopOptions,
  ): Promise<RunState>
  ```

**⚠️ spec 内部的一处措辞冲突，本计划就地裁定：** §5.4 写「信号作为**第七个位置参数**传下去」，§4.3 四层表与 §9 写「**不新增位置参数**，搭同一个可选参数对象」。**本计划采用的形状同时满足两种读法**：`runLoopFromState` 确实多了第七个位置参数，但它是**一个对象**，B2 与 C1 往里加**键**而不是加位置参数。**参数个数从此不再增长。**

**四层的失败语义（逐层写死）：**

| 层 | 该层的失败语义 |
|---|---|
| `writeBoundaryArtifacts` | 回调缺省 → 只落 `events.jsonl`，不路由（与人裁第四轮定的形态一致）。**回调排在 `appendEvent` 之前是刻意的**：`appendEvent` 是裸 `appendFile`、可以 reject，排在后面会让一次 I/O 失败连带吞掉 stderr 那条 |
| `persistBoundaryAnalysis` | 纯透传，**不新增任何 catch** |
| `runLoopFromState` | 纯透传 |
| `resumeLoop` | 纯透传。**既有 14 处调用点全部传 2 个实参，零改动** |

**回调不得抛出，且本层刻意不给它包 try/catch。** 它若抛出会从 `writeBoundaryArtifacts` 一路逃到 `runLoopFromState`，把一次保护性放弃升级成 attempt 失败——正是人裁明令禁止的那件事。**包一层 `try{}catch{}` 会静默吞掉它，违反 Rule 12。** 本层的处置是把「不得抛出」定成**回调的契约**，并把 sweep 侧的实现定死为**一次数组 push**（不做 I/O、不格式化），使违约成为一个**显眼的编程错误**而不是一条被吞的异常。

**Amended 2026-08-05：上段「把 sweep 侧的实现定死为一次数组 push（不做 I/O、不格式化）」已被人裁推翻 —— 定死的是「当场 `options.stderr(...)`，含 `\r?\n` 单行折叠」。** 这纠正的是*本计划*的缺陷，不是实现的缺陷。**上段其余部分逐字不变、且仍然成立**：「不得抛出」仍是回调的契约，回调抛出仍会一路逃到 `runLoopFromState` 把一次保护性放弃升级成 attempt 失败，本层仍然**刻意不包 try/catch**（包了就是静默吞掉一个编程错误，违反 Rule 12）。**读作**：「……并把 sweep 侧的实现定死为**当场 `options.stderr(...)`（含单行折叠），不做文件 I/O、不 await**」。**「不格式化」这一句今天不能照留**：折行本身就是格式化，且人裁明令它在回调里当场做。完整理由见本计划 `### Task C3`「落点」一节的 `Amended 2026-08-04`；spec 侧同一处见 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §4.3「回调不得抛出」那段下方的 `Amended 2026-08-05`。

**两个调用点都要改（§9 点名）：** `persistBoundaryAnalysis` 的两个调用点里，**其中一个今天只传 3 个实参**，要写成 `(runDir, state, heartbeat, undefined, cb)`。锚点：

```bash
grep -nF 'persistBoundaryAnalysis' src/controller/runLoop.ts
# 计划阶段实测 3 行：定义 1 行（无 export）＋ 两个调用点。
# 其中一个调用点传 4 个实参（含 executionRecovery），另一个只传 3 个。
```

**测试要求：**

- **12d(iii) — 产生侧确实调了回调**（`fileStore` 层，直接调导出的 `writeBoundaryArtifacts`）：**复用 A7 的 6f(ii) fixture**（目录有 `owner-transfer.json`、**没有** `owner-record.json`，以 `eligibleForContinuation: false` 的 reconciliation 调用），第三参传一个记录用的回调。断言：**回调恰好被调用 1 次**、参数含那次读失败的 `String(error)`、**且 `writeBoundaryArtifacts` 正常 resolve（不抛）**。
  **变异：只 `appendEvent`、不调回调 → 本条必红。**
  **子断言（钉 `events.jsonl` 写不进去时的行为）**：mock `appendEvent` 抛出时，**(a) `writeBoundaryArtifacts` 仍然正常 resolve、(b) 回调仍然已被调用过。**
  **该子断言的承重变异：删掉 `appendEvent` 外面那层 `try{}catch{}`（退回裸调用）→ (a) 必红。**
  **⚠️ 不要用「把回调与 `appendEvent` 的顺序对调」当变异**——swallow 落地之后它是**等价变异**（`appendEvent` 被吞之后，无论排在回调之前还是之后，回调都照样被调用，(b) 两侧都绿）。**「回调排在 `appendEvent` 之前」这条排序保留在实现里，但如实写明：它现在是纵深防御，没有配套的杀伤变异**（它防的是「将来有人把 swallow 去掉、又没把顺序改回来」）。**不许为了给它凑一条变异而把 swallow 拿掉。**
- **12d(iv) — 中间三层的透传**（经 `runLoopFromState` 驱动）：参数对象里传一个记录用的 `onReconciliationWriteAbandoned`，断言它被调用。
  **变异：把 `runLoopFromState → persistBoundaryAnalysis` 或 `persistBoundaryAnalysis → writeBoundaryArtifacts` 任一段的透传删掉 → 本条必红。两段各变异一次。**
  **⚠️ 这一条不许省。** 12d 的其余三条子用例分别用替身 `resumeLoop`（组 C）或直接调 `fileStore`，**三条都绕开了中间三层**；少了 (iv)，一次「参数加了但忘记往下传」的实现会让前三条**全绿**。这正是本仓库「两侧各自绿、中间断掉」那类案底的形状。

**⚠️⚠️ 12d(iv) 的 fixture —— 本任务最大的未结清风险，必须当场构造并证明它能到达 abandon 分支**

**spec 第五波给的 fixture（复用 6e / 6f 的盘面）按字面不可构造，第六波换掉了，但换的那一组从未被真的构造过并跑通。** 两端约束：

- **不能用 6e 的盘面**（transfer + owner 已发布、锁由活 pid 持有）：三读**全部成功** → 走保护判定那一支，**根本不进放弃分支** → 回调不被调 → **(iv) 在一个完全正确的实现上也红**。一条无论实现对错都红的测试不是护栏。
- **不能用 6f(ii)/(iii) 的盘面**（删掉或写坏 `owner-record.json`）：`persistBoundaryAnalysis` 在 `runExclusive` 内**先**读一次 owner record，**而那一句不在任何 try 内**（锚点：`heartbeat.runExclusive(` 之后紧跟的 `let ownerRecord = await readOwnerRecord(runDir);`）。owner-record 一旦不可读，`persistBoundaryAnalysis` 在到达 `writeBoundaryArtifacts` **之前**就抛了，(iv) 永远走不到被测的那一段。

**第六波推导出的唯一一组同时满足两端的形状 —— 四条约束，缺一不可：**

1. **`owner-record.json` 合法可读**（且目录内**无 marker**，使 `recoverInterruptedOwnerTransfer` 早退，不会顺手把 transfer 覆盖掉）。
2. **`owner-transfer.json` 存在但*不是合法 JSON`***（`readOwnerTransferRecordRaw` 是裸 `JSON.parse`，坏 JSON 直接抛 `SyntaxError` → 非 ENOENT → fail-closed → abandon）。
3. **`ownership.verdict !== "OWNER_LOST"` 或 `ownership.takeoverAllowed` 为假。** 否则 `persistBoundaryAnalysis` 会先走 `persistOwnerTransfer` 那一支，**把那份坏的 `owner-transfer.json` 用一份合法的覆盖掉**，第 2 条的 `SyntaxError` 随之消失。锚点：`if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed) {`
4. **`boundaryAnalysis.status === "stale_candidate"`**（否则传下去的 `reconciliationRecord` 是 `undefined`，`writeBoundaryArtifacts` 里那个 `!== undefined` 条件直接跳过整块），**且传下去的 reconciliation 的 `eligibleForContinuation` 为 `false`**（否则 `preserveSuccessfulReconciliationIfNeeded` 早退）。

**这四条是从读代码推导的，从未被构造过并跑过。本任务必须把「构造它并证明它到达 abandon 分支」当成一个显式步骤（Step 5），不许假设它成立。** 若构造不出来，**停下并上报**，不要就地换成一条更弱的断言。

**陷阱清单：**

- **四层加的全是可选参数，返回类型一个字节不改。** 既有调用点一个都不能断：

  ```bash
  grep -cF 'writeBoundaryArtifacts(runDir, {' tests/persistence/fileStore.test.ts
  # 计划阶段实测 11 —— 全是两参调用，加第三个可选参数一条都不需要改
  grep -rnF 'writeBoundaryArtifacts(' src/
  # 计划阶段实测 2 行：runLoop.ts 唯一生产调用点、fileStore.ts 定义
  ```

- **不要走「上行方案」**（让 `writeBoundaryArtifacts` 把信息随返回值带上去）。它被否决的**决定性**理由：`runLoopFromState` 的 `while (true)` 顶端两个 `await`（`writeRunState`、`affirmNow`）**不在任何 try 内**，可以在若干次 attempt 之后直接抛出、逃出 `resumeLoop`；**一旦抛出返回值不存在，上行携带的信息随之蒸发**——而那正是「这个 run 出了事」最需要 stderr 的时刻。
- **`ResumeNotEligibleError` 的签名与 `Promise.all` 的 catch 一个字节不改。**
- **`resumeLoop` 的 14 个既有调用点全部传 2 个实参，一个都不许改。**

**Steps:**

- [ ] **Step 1: 加 `writeBoundaryArtifacts` 的第三参与回调调用点。** 回调**排在 `appendEvent` 之前**，并在旁边写明「排在前面是刻意的」以及「它是纵深防御、没有配套杀伤变异」。
- [ ] **Step 2: 写测试 12d(iii)（含子断言）。** 完整测试名：
  `fileStore > calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves`
  `fileStore > still resolves and still calls the callback when appendEvent rejects`
  跑 → 两份原始输出都贴。
- [ ] **Step 3: 变异实验（两次）。**
  1. 只 `appendEvent`、不调回调 → **第一条必红**
  2. 删掉 `appendEvent` 外面那层 `try{}catch{}` → **第二条必红**
  各走三步判据，四份原始输出。
- [ ] **Step 4: 加中间三层的透传。** `persistBoundaryAnalysis` 第五参 + **两个调用点都改**（其中一个要补 `undefined` 占位）；`runLoopFromState` 第七参数对象；`resumeLoop` 第三参数对象。跑 `npm run typecheck` 贴输出。
- [ ] **Step 5（本任务的高风险步骤）: 构造 12d(iv) 的 fixture 并证明它到达 abandon 分支。**
  按上面四条约束构造磁盘状态，经 `runLoopFromState` 驱动，**先只断言「回调被调用过」**。
  **若它不被调用**：不要改断言、不要换更弱的形状——**打印出实际走到哪一步**（在 abandon 分支临时加一条本地日志或用 spy 观察 `readOwnerTransferRecordRaw` 是否抛了 `SyntaxError`），把观察结果与四条约束逐条比对，**然后停下并上报**。四条约束是从读代码推导的、从未被构造过，**它们有可能是错的**。
  **把这一步的原始输出（成功或失败）全部贴出来。**
- [ ] **Step 6: 把 Step 5 的探针改成正式测试 12d(iv)。** 完整测试名：
  `runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts`
- [ ] **Step 7: 变异实验（两次）。** 分别删掉两段透传中的一段 → **本条必红**。各走三步判据，四份原始输出。
- [ ] **Step 8: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 9: 提交。**

```bash
git add src/persistence/fileStore.ts src/controller/runLoop.ts src/controller/resumeLoop.ts tests/persistence/fileStore.test.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat(controller): thread an optional onReconciliationWriteAbandoned callback from resumeLoop down to writeBoundaryArtifacts"
```

- [ ] **Step 10: 独立评审。** 重点：四层是不是全可选、返回类型是否一个字节未改、两个 `persistBoundaryAnalysis` 调用点是否都改了、回调是否排在 `appendEvent` 之前、**Step 5 的构造证据是否真的贴出来了**（这是本任务唯一一处「从未被构造过」的地方）、有没有为了凑变异而拿掉 swallow。

---

### Task A9: 输家不得覆盖赢家（测试 6e，钉 §4.3 的排序改判）

**Files:**
- Test only: `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes（A2/A3 产出）：生产 `finalizeOrder` 常量 `[OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE]`、三个发布 temp 的**固定名字**
- Consumes（既有，不改）：`function transferRepresentsPublishedWinner(`、`async function tryRecoverStaleOwnerTransferLock(`、`export function buildAtomicTempPath(`

**骨架（「确定性交错」，两侧都跑生产代码，fixture 一个字节不参与变异）：**

用既有手法（`vi.resetModules()` + `vi.doMock("node:fs/promises", …)`）包住 `rename`，**在 P1 的第一次 `rename` 内部同步地把输家那次 `writeBoundaryArtifacts` 跑完**，再放行 P1 剩下的 rename。交错点由 mock 决定，**不由 fixture 决定**。
**fixture 必须让 `.owner-transfer.lock` 在窗口内存在且由一个活着的 pid 持有**（§4.3 排序改判第 2 步：P2 的 `readOwnerRecord` 靠这一点才不会替 P1 finalize）。

**变异一（改生产常量 `finalizeOrder` 为 `[reconciliation, transfer, owner]`，fixture 与交错点都不动）：**

- **断言对象不是 reconciliation 的内容。** 未变异时输家**确实**会在此刻写下一份降级版本（那正是残余 TOCTOU 的形状），所以内容断言在两侧不可区分。
- **断言对象是「在输家的 `preserveSuccessfulReconciliationIfNeeded` 返回时，`transferRepresentsPublishedWinner` 是否被求值过」。** 未变异：`owner-transfer.json` 已存在 → 读成功 → 判定被求值（结果为 false，因为 owner-record 还是旧 epoch）。变异后：`owner-transfer.json` 尚不存在 → 读以 ENOENT 结束 → **判定压根没被求值。**
- **可观测的钉子**：spy `node:fs/promises` 的 `readFile` / `open`，断言输家那次调用期间**发生过一次针对 `owner-transfer.json` 的成功读**。变异后那次读以 ENOENT 结束 → **断言红。**
- **⚠️ 这条断言比「赢家有没有被覆盖」弱**：它钉的是「保护判定有没有被求值」。**后者本层钉不住，因为残余 TOCTOU 未关闭**（§13 第 4 笔）。**明写这一点，不要让下一位读者以为变异一覆盖了「赢家不被覆盖」。**
- **⚠️ 收尾断言不许用终态。** 「P1 的第三次 rename 会把真品盖回去」**不是系统性质，是 harness 强加的顺序**——生产里输家的写完全可以晚于 rename#3。把它断言为正确行为，就是把一条**损坏轨迹**写进套件，与 §4.4 判初稿死刑的理由**逐字同形**。

**⚠️ 风险（本计划四条未结清风险之一）：变异一在今天的代码上不可表达。**
`finalizeOrder` 今天只有两项（`[OWNER_TRANSFER_FILE, OWNER_RECORD_FILE]`），**三项版本正是 A2 建出来的东西**。第五轮评审员明说「它是否会红我分辨不出」。
**处置：这条变异只有在 A2/A3 落地之后才能注入，且必须在本任务内完成注入并贴原始输出。** 本任务排在 A2/A3 之后正是为此。**不许把「它会红」当成结论继承——本 spec 只给注入点与断言形状，不给「已验证会红」的结论。**

**变异二（删掉 `tryRecoverStaleOwnerTransferLock` 里的活进程早退）：**

注入点是生产代码里那句 `if (pid !== null && isProcessActive(pid)) { return false; }`（锚点：`async function tryRecoverStaleOwnerTransferLock(` 之后的 pid 存活判定）。逐格走：

| 锁状态 | 基线 | 变异后 |
|---|---|---|
| 存在、pid **活**（＝ 6e 的 fixture） | 早退 return `false` → 恢复 return，**输家不 finalize** | 早退没了 → 落到 `safeUnlink(lockPath)` → return `true` → **恢复进 finalize，输家替赢家 finalize** |
| 其余三格 | — | 与基线相同 |

**只有 fixture 那一格翻转，且翻转方向正是排序改判第 2 步依赖的那件事。**
**⚠️ 不要把这条变异的名字写成「锁的持有范围被收窄」**——那个名字对应的注入点（删 `pathExists(paths.lockPath)` 合取项）是**结构性等价变异**，四格逐格相同，换任何 fixture 都杀不掉。**它模拟的是「活进程检查被移除」。**

**窗口内断言的具体形状：**

**断言「输家那次 `writeBoundaryArtifacts` 期间，*没有任何 rename 以事务的发布 temp 为源*」。** 三个事务发布 temp 是固定名字（`.owner-transfer.publish.tmp` / `.owner-record.publish.tmp` / `.reconciliation-record.publish.tmp`），而输家自己的原子写用 `buildAtomicTempPath` 生成的**带进程戳与序号的一次性 temp**，两者不可能撞名。

- 未变异：0 次以事务发布 temp 为源的 rename（输家自己的 rename 源都是一次性 temp）→ 绿
- 变异后：finalize 跑起来 → 以事务发布 temp 为源的 rename 出现 → **断言红**

**⚠️ 不要用 rename 的*计数*当断言**（第三轮那条「未变异 0 次、变异后 3 次」两侧数字都错——`writeBoundaryArtifacts` 自己就会 rename 两次）。**等价的替代**：spy `finalizePendingOwnerTransfer` 进入与否——**但它未导出**，只能经 rename 源间接观测。**两条选一即可，在测试注释里写清选了哪条。**

**⚠️⚠️ 达标判据：具名单跑，不是套件红。**

第六波实测：**变异二今天就杀掉 6 条与 6e 无关的既有测试**（基线 `29 files / 446 tests` → 注入后 `4 failed | 25 passed (29)` / `6 failed | 440 passed (446)`）：

| # | 测试全名 | 文件 |
|---|---|---|
| 1 | `fileStore > rejects owner transfer while a live transfer lock is held` | `tests/persistence/fileStore.test.ts` |
| 2 | `fileStore > throws OwnerTransferLockBusyError for a busy lock and OwnerTransferPreconditionError for a CAS mismatch, and neither is an instance of the other` | `tests/persistence/fileStore.test.ts` |
| 3 | `fileStore > keeps a live lock in place when recovery cannot yet proceed` | `tests/persistence/fileStore.test.ts` |
| 4 | `startLeaseHeartbeat > treats a busy owner-transfer lock as transient: no lease_lost, no supersession concluded, retried next tick` | `tests/controller/leaseHeartbeat.test.ts` |
| 5 | `resumeLoop > stays fail-closed when the claim hits a busy owner-transfer lock, without claiming a CAS failure` | `tests/controller/resumeLoop.integration.test.ts` |
| 6 | `lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy` | `tests/controller/leaseLifecycle.integration.test.ts` |

**第 3 条就是排序改判第 2 步要钉的那句话，而它今天就在套件里、与 6e 无关。**
**这份名单是 6e 的*噪声*，不是它的护栏。** 写在这里只为一件事：让你知道套件红是被这 6 条制造出来的，**不要把它误读为 6e 的证据**。
**（这 6 条会随组 A 的改动而变化——A9 开工时以你自己那次注入的原始输出为准，不要引用这份名单的条数。）**

**陷阱清单：**

- **「同步改中断点」＝改 fixture，不是变异。** 两条变异都必须只动生产代码。
- **变异实验必须跑在基线全绿的副本上。** 若在 scratchpad 副本里做，先 `git init` + 首提交——第六波实测过一次「副本不是 git 仓库导致 `parseArgs > returns 0 for the scripted example run` 失败并被误记成击杀」的教训。
- **前三轮每一轮都在这里宣布过「护栏问题已解决」，每一轮都被下一轮推翻。** 本任务**不宣布**，只贴原始输出。

**Steps:**

- [ ] **Step 1: 确认基线全绿。** 在你要做变异的那个工作副本上跑一次全套件，**未过滤**贴输出。不绿不许继续。
- [ ] **Step 2: 写测试 6e 的骨架与断言。** 完整测试名：
  `runLoop > keeps the loser from writing through the winner's reconciliation inside the publish window`
  两条断言：(a) 输家那次调用期间发生过一次针对 `owner-transfer.json` 的**成功**读；(b) 输家那次调用期间**没有任何 rename 以事务发布 temp 为源**。

  **Amended 2026-08-02 (d)：上面这个测试名的第一个分句「keeps the loser from writing through the winner's reconciliation」背后没有断言，而且在本层今天是*假的*，已按人的裁定改名。** 这纠正的是*本文档*的缺陷，不是实现的缺陷——两条断言本身与本 Step 写的一字不差，没有为了迁就名字调整过任何断言。理由：窗口内 `owner-record.json` 仍是旧 epoch（赢家的 rename #2 尚未发生），所以 `transferRepresentsPublishedWinner` 求值为 **false**，输家**确实**在窗口内写下了它那份降级 reconciliation——这正是残余 TOCTOU（§13 第 4 笔）未关闭的形状，A9 的测试注释也是这么写的。一个断言了「与已记录事实相反的东西」的名字，比一个仅仅夸大范围的名字更坏，而且**名字才是失败输出里出现的东西**。本测试实际钉住的是：(a) 输家窗口内对 `owner-transfer.json` 的**成功保护性读**（即那次判定的*前置条件*，不是判定本身），(b) 窗口内**零**次以三个事务发布 temp 为源的 rename。新名字逐字为：

  `runLoop > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`

  第一个分句对应断言 (a)，第二个分句对应断言 (b)，两个分句各自都有一条实测可失败的断言（变异一杀 (a)、变异二杀 (b)，原始输出见 `task-A9-report.md` 的「修复轮 1」一节）。
- [ ] **Step 3: 跑它确认绿（它钉的是落地后就正确的行为），贴原始输出。**
- [ ] **Step 4: 注入变异一并单跑。** 把生产常量 `finalizeOrder` 改成 `[RECONCILIATION_RECORD_FILE, OWNER_TRANSFER_FILE, OWNER_RECORD_FILE]`，`-t` 单跑 6e。**必须红。贴注入前后两次原始输出。** 还原。
  **若它不红**：不要调整断言让它红——**先弄清为什么**（打印输家那次调用期间的读序列），然后**停下并上报**。这是本层最承重的一处改判，连续三轮零有效护栏。
- [ ] **Step 5: 注入变异二并单跑。** 删掉 `tryRecoverStaleOwnerTransferLock` 里的活进程早退，`-t` 单跑 6e。**必须红。贴注入前后两次原始输出。** 还原。
- [ ] **Step 6: 顺带记录噪声。** 变异二注入状态下再跑一次**全套件**（未过滤），把被杀掉的既有测试完整名单与计数抄下来，**在测试注释里写明「这份名单是噪声不是护栏」**。
- [ ] **Step 7: 全套件 + typecheck + build（已还原状态），未过滤贴出。**
- [ ] **Step 8: 提交。**

```bash
git add tests/controller/runLoop.integration.test.ts
git commit -m "test(runLoop): pin the finalize order re-ruling with two production-only mutations"
```

- [ ] **Step 9: 独立评审。** 重点：两条变异的注入点是否都在生产代码上、断言是否落在输家那次调用的**窗口内**而不是终态、变异一的原始输出是否真的贴了（这是「不可表达 → 可表达」的转折点）、有没有出现「护栏问题已解决」这类结论。

---

### GATE-A: 组 A 整分支评审与合并

**这不是一个实现任务。它是组 C 的前置条件，且组 C 的 C1 会来要它的合并 hash。**

- [ ] **Step 1: 整分支评审。** 一名**没有参与过 A1–A9 任何一条**的评审员，对着代码撞整个组 A 的 diff。评审清单至少覆盖：
  - `cleanupOwnerTransferStagingWithoutMarker` 是否恰好 10 个 `safeUnlink` 且逐个具名；六处联动是否一致（§4.3 表 / §9 模块表 / 测试 6c / §13 / 测试 14 机制二的 11 / §15 验收 8）
  - `finalizePendingOwnerTransfer` 的 catch 是否只多了一个对称 `safeUnlink`、**语义未改**
  - `evaluateResumeEligibility` 是否**一个字节未改**（`git diff` 对 `src/controller/resumeLoop.ts` 里那个函数必须只有可选参数对象那一处改动）
  - 四层通道是否全可选、返回类型是否全未改
  - A9 变异一、A8 Step 5 两处「从未被验证过」的地方是否都贴了原始输出
  - 全部变异实验的原始输出是否成对（注入前绿 + 注入后红）
- [ ] **Step 2: 修复波。** 评审结论若有 Critical / Important，就地修。**修完之后必须再评审一次**——本仓库十轮 100% 命中「修复波自带缺陷」。
- [ ] **Step 3: 最终验证。** 全套件 + typecheck + build，**三份输出未过滤贴出**。
- [ ] **Step 4: 合并（只在人明确下指令时执行）。** 合并提交的提交信息里**必须带评审结论**（§15 验收 7 的判据 (1) 靠它定位）。记下合并 hash，记为 `$A4`。

---

# 组 B —— §5 债 3：`heartbeat.stop()` 释放窗口

> **前置：GATE-A 已完成并合并。** 组 B 往 A8 建的可选参数对象上加键，不新建同名类型。

### Task B1: `RunHeartbeatStoppedError` ＋ `runExclusive` 拒绝 ＋ 不写终态的新分支

**Files:**
- Modify: `src/ownership/lease.ts`（锚点：`export class RunLeaseUnverifiableError` 之后）
- Modify: `src/controller/leaseHeartbeat.ts`（锚点：`const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {` 及其上方那条注释）
- Modify: `src/controller/runLoop.ts`（`runLoopFromState` 的**外层** catch，新分支排在 `isLeaseStopError` 分支**之前**）
- Test: `tests/controller/leaseHeartbeat.test.ts`、`tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes（既有，不改）：`export class RunLeaseHeldError` / `RunLeaseLostError` / `RunLeaseUnverifiableError`（`src/ownership/lease.ts`）；`function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError`（`src/controller/runLoop.ts`，**无 export，保持模块私有**）
- Produces（B2 与 §10 测试 7/7b 依赖）：
  - `export class RunHeartbeatStoppedError extends Error { readonly stopReason = "heartbeat_stopped"; }`（形状照抄现有两个）
  - `runExclusive` 在 `stopped` 为真时抛 `RunHeartbeatStoppedError`
  - `runLoopFromState` 外层 catch 新增分支：`error instanceof RunHeartbeatStoppedError` → **追加 `heartbeat_stopped` 事件 → `writeRunState(runDir, state)` → 返回该非终态 `state`**，**不调 `persistTerminalState`**

**采用的方案是 (a)，理由与被否决的两条（§5.3 的 Rule 7 裁决，不许重开）：**

- **(a) 新错误不进 `isLeaseStopError`，另设分支。** `isLeaseStopError` 的**签名与判定体保持今天的两种错误不变**。
- **否决 (b)**（在写终态前判 `stopReason === "heartbeat_stopped"` 就跳过）：那是在一条 fail-closed 分支里加一个字符串条件，读者要跨两个文件才看得懂它为什么在那儿；(a) 让两条停机路径长得一样。
- **否决 (c)**（明确接受终结、撤回 §5.4 的论证）：§5.4 的论证是对的——写 `cancelled` 后 `resume` / `sweep` / `runLoop` 三条路全部拒绝，代码里没有任何路径退出终态。**接受它就等于接受本层存在的理由被一次信号摧毁。**
- **这个选择是「本层对债 2 的接触面为零」的前提。** 若将来有人改回 (c)，§13 关于债 2 的那段必须一起改。

**硬约束（两半缺一不可，§5.3）：**

1. **`RunHeartbeatStoppedError` 与现有两个*并列*，*不得*继承其中任何一个，也不得让它们继承一个共同基类。** 方案 (a) 的**全部**安全性建立在 `isLeaseStopError` 的 `instanceof` **不**匹配它上——一旦它成了子类，谓词一个字不改就会开始匹配它，「两个既有调用点写 `cancelled`、把永久终结从另一扇门放回来」原样复活，**而且没有任何测试名会提示原因**。
   **照抄本仓库判例的写法与口气**（`grep -rnF 'NOT a subclass' src/`，判例在 `src/persistence/fileStore.ts`），新类必须带一条同形注释，写明「deliberately NOT a subclass」**并点名它保护的是 `isLeaseStopError`**。
2. **它只从 `runExclusive` 抛出，绝不从 `assertHeld` 抛出。** 第一半守外层 catch，第二半守内层 catch。
   **为什么第二半也是硬的**：若有人让 `assertHeld` 也抛这个错（「心跳已停也算所有权不可断言」看起来很合理），它会落进内层 catch → `isLeaseStopError` 不匹配 → 跳过 return → 落到 `infraRetryUsed` 分支 → 第一次置位重试、**第二次直接 `persistTerminalState(runDir, state, "blocked_waiting_human", …)`**。`blocked_waiting_human` **不在 `RESUMABLE_STATUSES`（`["planning","executing","verifying"]`）内**，所以要防的永久终结从第三扇门原样回来，只是终态名换了。**后果同构，测试名同样不会提示原因。**
   **第二半靠 §9 模块表把 `leaseHeartbeat.ts` 的改动面限死在「`runExclusive` 拒绝 + 其上方注释」来守**——**它是一条约束，不是一条巧合。**

**必须同笔改掉的注释（一条，不是三条）：**

- `runExclusive` **上方那条注释**（原文：「Takes no position on `stopped` or `superseded` — it only serializes. **Refusal is Task 5's job; duplicating it here would just be a second, weaker copy of a decision that already has one home.**」）——它记录的裁定被本改动局部推翻，必须就地更新。
- **`isLeaseStopError` 上方那句「the two ways `heartbeat.assertHeld()` can refuse a side effect」不必改**——选了 (a) 之后「two」仍然为真。
- **`isLeaseStopError` 的谓词与签名不改。**

**本层采用的理由（不依赖任何关于可达性的主张）：**

**这里的拒绝不是 `assertHeld` 那条决策的第二份弱拷贝，因为「本进程心跳已停」这个命题今天根本没有 home。** `assertHeld` **从不读 `stopped`**（`grep -nF 'stopped' src/controller/leaseHeartbeat.ts` 命中的行里没有一行在 `assertHeld` 内）。`assertHeld` 判的是「所有权还在不在」（读持久 owner record），`stopped` 判的是「本进程还打不打算继续」（纯进程内状态）。**两个命题不同。**
**关于可达性，本层的诚实表态**：`stopped` 之后的 `runExclusive` 在 **L3 内不可达**（两个 `heartbeat.stop()` 调用点都在 `await runLoopFromState(...)` 之后的 `finally` 里）。**本改动是纵深防御**，也是常驻形态（`watch`）的前置加固。**本层不主张「在先裁定的前提不再成立」。**

**新分支的三处副作用（逐条声明，不许留成静默）：**

1. **抢掉兜底的「转 `failed` 并落盘」。这是意图**——一次停机不是 attempt 失败。
2. **抢掉 `cleanupAttemptWorkspaceBestEffort`。本层接受**，理由与 L1 §12 第 9 条（「被挡住的副作用就地放弃而非回滚，残留 worktree 留给下一个 owner」）同形：残留 worktree 由下一次续跑的 `cleanupResidualWorktrees` 收拾。**这一条必须在测试 7b 里被断言**，否则它是一条静默的行为变更。
3. **抢掉 `applyPhaseUsage`。** 后果是相位耗时不计入 `state`——**与「不消耗配额」方向一致，本层接受。**

**⚠️ 必须补一次 `writeRunState(runDir, state)`，这是第四轮新增的要求：** §5.4 的停机点在 `while (true)` 顶端，那里刚跑过一次 `writeRunState`，所以「返回的 `state`」与磁盘**逐字节相同**；而本分支落在 attempt 中段，`state` 可能已被若干次 `applyPhaseUsage` 改过而**尚未**落盘。**若只 return 不落盘，返回值与磁盘不一致，「与 §5.4 同构」为假。**

**测试要求：**

- **测试 7 — `runExclusive` 在 `stopped` 后拒绝**：`stop()` 之后再调 `runExclusive`，断言抛 `RunHeartbeatStoppedError`。**变异：退回不拒绝 → 必红。**
- **测试 7b — 被明写「接受」的退化的形状钉定**（§10 测试 9 已并进本条）：在 execute 超时无结果那条路径上注入 `RunHeartbeatStoppedError`，断言
  (i) **不调 `persistTerminalState`**（run 未被终结）、
  (ii) `execution-recovery.json` 的 `cleanupStatus` **未被回填**、
  (iii) 返回的 `state.status` 仍在 `RESUMABLE_STATUSES` 内、
  (iv) **`cleanupAttemptWorkspaceBestEffort` 未被调用**（上面副作用 2 的断言面）。
  **变异：把新错误放回 `isLeaseStopError` → (i) 与 (iii) 必须红。** 这条变异同时也是方案 (a) 的护栏。
  **7b 另加一条不依赖谓词可见性的自有断言**：`new RunHeartbeatStoppedError(...) instanceof RunLeaseLostError === false` **且** `instanceof RunLeaseUnverifiableError === false`。
  **变异：把 `RunHeartbeatStoppedError` 改成任一个的子类 → 本条必须红。** 这正是硬约束第一半要防的那次改动，而且它比「改谓词」更容易被无意做出。

**陷阱清单：**

- **`INERT_LEASE_HEARTBEAT` 与测试替身的 `runExclusive: (fn) => fn()` 是*桩*，不是调用点，不要给它们加拒绝逻辑**——那会打断 `tests/controller/leaseLifecycle.integration.test.ts` 里若干提供同样桩的测试心跳。
- **`runExclusive` 只有一个生产调用点**（`grep -rnF 'runExclusive(' src/` 计划阶段实测 **1 行**，在 `persistBoundaryAnalysis` 内），**不在 `runLoopFromState` 内**。落地路径经由 `persistBoundaryAnalysis` **传递地**成立。
- **新抛出会替换掉更有信息的错误**（记录而非修复）：在 execute 超时无结果那条路径上，它会抢在本该发生的处理之前逃出，跳过本来要写的 `exhausted` + 相位超时原因、跳过 `cleanupAttemptWorkspaceWithStatus` 与 `execution-recovery.json` 的 `cleanupStatus` 回填。**接受**，理由：那条路径上「本进程心跳已停」本来就意味着这些后续写入不该发生。**选了 (a) 之后，被接受的只是「这些写入不发生」，不再包含「run 被永久终结」。**
- **`stop()` 一个字节不改。** L1 §12 第 4/17 条规定 `stop()` 那次 release 是「permitted — **and required**」。§9 模块表把 `leaseHeartbeat.ts` 的改动面限死在「`runExclusive` 拒绝 + 其上方注释」。

**Steps:**

- [ ] **Step 1: 写失败的测试 7。** 完整测试名：
  `startLeaseHeartbeat > refuses runExclusive after stop, throwing RunHeartbeatStoppedError`
- [ ] **Step 2: 跑它确认失败并贴原始输出。**
- [ ] **Step 3: 加 `RunHeartbeatStoppedError`（含 `deliberately NOT a subclass` 注释）＋ `runExclusive` 拒绝 ＋ 更新其上方注释。** 跑测试 7 确认通过并贴输出。
- [ ] **Step 4: 写失败的测试 7b（四条断言 + 两条 instanceof 断言）。** 完整测试名：
  `runLoop > returns a resumable state without terminating the run when the heartbeat stops mid-attempt`
  `lease > RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either`
- [ ] **Step 5: 跑这两条确认失败，两份原始输出都贴。**
- [ ] **Step 6: 加 `runLoopFromState` 外层 catch 的新分支**（排在 `isLeaseStopError` 分支**之前**）：追加 `heartbeat_stopped` 事件 → `writeRunState(runDir, state)` → return 非终态 `state`。跑两条确认通过并贴输出。
- [ ] **Step 7: 变异实验（三次）。**
  1. `runExclusive` 退回不拒绝 → **测试 7 必红**
  2. 把 `RunHeartbeatStoppedError` 加进 `isLeaseStopError` → **7b 的 (i) 与 (iii) 必红**

     **Amended 2026-08-04：本条判据的前提在方案 (a) 的排序下为假——只把 `RunHeartbeatStoppedError` 加进 `isLeaseStopError`、别的都不动，是行为惰性的，全套件全绿。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。原因是本任务自己定的排序：专属分支 `error instanceof RunHeartbeatStoppedError` 排在 `isLeaseStopError` 分支**之前**并 `return`，所以这个错误根本到不了谓词，谓词匹配不匹配它都不改变任何一条可观测行为。B1 独立核验实测：只给谓词加 `|| error instanceof RunHeartbeatStoppedError`、不动分支排序、不动别处，全套件 **29 files / 487 tests 全绿**。三点更正：

     - **(i) 这条判据的实际可执行形状是「协同注入」，不是单点注入**：必须**同时**让专属分支失效**并**给谓词加宽，才构成「方案 (a) 未被采用、错误被路由进 `isLeaseStopError`」那个反事实，(i) 与 (iii) 也才会红。B1 就是这样执行的，原始输出见 `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-B1-report.md` 的变异二。
     - **(ii) 「纯谓词加宽」这一半今天没有任何合法的行为测试能杀掉它。** 在不导出谓词（本文档禁止为测试导出模块私有符号）、不改分支排序的前提下，唯一能让谓词被求值到该错误的形状是让 `assertHeld` 抛出它——而那正是**硬约束第二半明令禁止**的事；何况那条路的两个结局（`cancelled` 与 `blocked_waiting_human`）都不在 `RESUMABLE_STATUSES` 内，构造它等于构造一个本任务定义为非法的实现。
     - **(iii) 这是方案 (a) 的结构后果，不是实施疏漏。** 排序本身就是 (a) 的安全性来源，而它同时使谓词那一半失去可观测性。因此**硬约束第一半目前只有「子类化」那半边有可失败的断言**（即 Step 4 的 `lease > RunHeartbeatStoppedError is a sibling …` 那条，变异三实测可红），**「谓词加宽」那半边靠 `isLeaseStopError` 与新类上方的两条注释承载，没有测试守着。**
  3. 把 `RunHeartbeatStoppedError` 改成 `RunLeaseLostError` 的子类 → **instanceof 那条必红**
  各走三步判据，六份原始输出。
- [ ] **Step 8: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 9: 提交。**

```bash
git add src/ownership/lease.ts src/controller/leaseHeartbeat.ts src/controller/runLoop.ts tests/controller/leaseHeartbeat.test.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat(heartbeat): refuse runExclusive after stop and return a resumable state instead of terminating the run"
```

- [ ] **Step 10: 独立评审。** 重点：新类是否并列非子类且带点名注释、`isLeaseStopError` 的谓词与签名是否**未改**、新分支是否补了 `writeRunState`、`stop()` 是否一个字节未改、桩是否被误改、7b 的四条断言是否各自可失败。

---

### Task B2: 停机信号槽（改动 B，**不写终态**）

**Files:**
- Modify: `src/controller/runLoop.ts`（`export type LeaseLossSignal` / `createLeaseLossSignal` 旁边加同形的停机信号；`runLoopFromState` 的 `while (true)` 顶端那个 `leaseLoss.lost !== null` 检查点**旁边**；`RunLoopFromStateOptions` 加键）
- Modify: `src/controller/resumeLoop.ts`（`ResumeLoopOptions` 加键并向 `runLoopFromState` 透传）
- Test: `tests/controller/runLoop.integration.test.ts`、`tests/controller/leaseLifecycle.integration.test.ts`

**Interfaces:**
- Consumes（A8 产出）：`RunLoopFromStateOptions`、`ResumeLoopOptions`
- Consumes（既有，不改）：`export type LeaseLossSignal` 与 `export function createLeaseLossSignal`（形状照抄它们）
- Produces（C1/C2 依赖）：
  - `export type StopRequestSignal = { requested: boolean };`
  - `export function createStopRequestSignal(): StopRequestSignal;`
  - `RunLoopFromStateOptions` 与 `ResumeLoopOptions` 各加一个键 `stopRequested?: StopRequestSignal`

**采用的语义：**

- `runLoopFromState` 在**已有的**相位边界检查点旁边多查一个；命中则 **`appendEvent(runDir, { type: "stop_requested", ... })` 并返回当前的非终态 `state`**，不启动下一个 attempt，**不调 `persistTerminalState`**。
- **⚠️ 「那个检查点」在代码里是两处，本层只装在循环顶端那一处。**

  ```bash
  grep -nF 'leaseLoss.lost !== null' src/controller/runLoop.ts
  # 计划阶段实测 2 行：一处在 while(true) 顶端、attemptsUsed 递增之前；
  #   另一处在 attempt 内部、execute 之后。
  ```

  **理由两条：**
  1. **「不消耗配额」那条论证只对循环顶端那一处成立。** attempt 内部那一处在 `const attempt = state.attemptsUsed + 1;` 之后，从那里返回会让这次 attempt 已经算进配额。**装两处会让同一节的两条结论互相打架。**
  2. **attempt 内部那一处的粒度买不到东西。** 走到那里意味着 execute 已经跑完（**付费调用已经发生**），此时停机与走完这个 attempt 再在顶端停，对操作者是同一件事，却多一条要论证的返回路径。
- **代价（明写）**：停机的响应粒度是**一个完整 attempt**，不是「下一个相位边界」。
- **停机不消耗任何配额**：那个位置在 `attemptsUsed` 递增之前，且它上面刚跑过一次 `writeRunState(runDir, state)`，所以一次 `stop_requested` 之后 `loop-state.json` 的 `status` 与 `attemptsUsed` 与停机前**逐字节相同**。**本层正面接受这一点**——把停机计入 attempt 配额，等于让「操作者按 Ctrl-C」消耗掉本该留给真实失败重试的预算，一次误按就永久减少了这个 run 的成功机会。**代价（无限次重捡）由 `--max-runs` 在每一次 sweep 上界住**，不由 run 侧的配额界住。

**⚠️ 停机粒度的界是「adapter 协作式」，不是无条件有界。** 检查点是 **per-attempt** 边界；execute 相位用 `{ awaitAbortedResult: true }`，超时后 `abort()` 再 `await operationPromise` **没有第二重上界**；adapter 的 `onAbort` 只发 `SIGTERM`，无 SIGKILL 升级；`createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程也完全无超时。**诚实的界是**：`planTimeoutMs + verifyTimeoutMs + (execute：adapter 协作则有界，否则无界) + 无超时的 git`。**本层不修 execute 的超时升级**（属独立任务，§14 第 3 条），**逃生口由 C2 的 `exit(130)` 提供。**

**⚠️ 「人按过 Ctrl-C」这个信息只进 `events.jsonl`，没有任何消费者读它。** registry 只观测 3 个文件（`loop-state.json` / `owner-record.json` / `owner-transfer.json`），`evaluateResumeEligibility` 也不读事件流。**所以下一次 sweep 分不清「人主动停的」和「被 OOM 杀的」。本层刻意放弃这个区分**——两者的正确处置恰好相同（run 停在非终态、所有权未变、租约已释放或将过期，正确动作都是「下一次 sweep 重新续跑」）。**引入这个区分需要新增一个被 registry 观测的字段，那是新的磁盘契约，属 L2/L5。** 写在这里是为了不让它被沉默继承。

**测试要求：**

- **测试 8 — 信号槽置位 → 在相位边界返回非终态 state、追加 `stop_requested` 事件、不启动新 attempt。**
  **并且断言 `attemptsUsed` 与停机前逐字节相同**——这钉的是「槽装在循环顶端而不是 attempt 内部」。
  **变异：把槽改装到 attempt 内部那处检查点 → 本条必须红。**
- **测试 8b — `stop_requested` 之后同一个 run 目录在下一次 sweep 中仍然 eligible**（§5.4 改判的承重断言）。**必须两条子用例：**
  - **(i) `releaseOwnerLease` 成功 → 立即 eligible**（**在 TTL 之内断言**，否则一个只 `clearInterval` 的实现也能过）
  - **(ii) `releaseOwnerLease` 失败并被吞 → TTL 之内被 `checkRunLease` 拒绝、TTL 之后 eligible**
  **只测 (i) 不承重。**
  **⚠️ (ii) 的构造方式已定死**：`updateOwnerRecordWithPrecondition` **从未导出**（`grep -rnF 'updateOwnerRecordWithPrecondition' src/` 命中 3 行，全在 `fileStore.ts` 内，定义处无 `export`），按「mock 它」的字面写法**不可表达**。
  **采用的替代（更贴生产语义，且不需要导出任何东西）：从测试侧直接改写 `owner-record.json`，让 CAS 真实失配。** `releaseOwnerLease` 走 `updateOwnerRecordWithPrecondition` 的 `sameOwnerRecord` 比对，测试在 `stop()` **之前**把盘上的 owner record 换成另一份（模拟被 supersede），CAS 就会真实地抛 `OwnerTransferPreconditionError` 并被 `stop()` 的 `try{}catch{}` 吞掉。
  **另一条可选替代**：mock **已导出**的 `releaseOwnerLease` 让它抛。**但它更弱**——不检验 CAS 的真实判据，只检验「抛出被吞」。**两条都写也可以，只写后者不达标。**

**陷阱清单：**

- **信号处理器装在 `cli.ts`，不装在这里，也不装在 `sweepRuns.ts`。** 本任务只提供信号**槽**与检查点。
- **`resumeLoop` 的 `finally` 里已有的 `heartbeat.stop()` 是「尝试」清掉 `leaseAffirmedAt`，不是保证。** `stop()` 里那句 `releaseOwnerLease` 被 `try { … } catch {}` 包着，走 `updateOwnerRecordWithPrecondition`，**CAS 不匹配就抛、随即被吞**。**诚实的表述**：租约释放成功后立即 eligible；释放失败（CAS 失配、锁忙、I/O）则最迟 `LEASE_TTL_MS` 之后 eligible。**两种情形下 run 都不会被永久拒绝，这才是要保住的性质。**
- **不得以 §15 验收 4 为依据把 release 做成可选的。** L1 §12 第 4/17 条原样成立（§11 已按 Rule 7 裁定挑它们），**TTL 兜底只适用于「release 的 CAS 因所有权已易主而失配」这一种情形**。
- **A3 扩大了这条路径的失败面（记账不修）**：`stop()` → `releaseOwnerLease` → `updateOwnerRecordWithPrecondition` 内部那次**持锁**恢复不在任何 catch 内，A3 给它加了 marker 解析与两条新抛出，规则 2 **可达**。**不要在本任务里去修它**（属 §13 第 3 笔）。

**Steps:**

- [ ] **Step 1: 加 `StopRequestSignal` 与 `createStopRequestSignal`（形状照抄 `LeaseLossSignal`），并往两个可选参数对象各加一个键。** 跑 typecheck 贴输出。
- [ ] **Step 2: 写失败的测试 8。** 完整测试名：
  `runLoop > returns a resumable state at the loop top when the stop signal is set, without spending an attempt`
- [ ] **Step 3: 跑它确认失败并贴原始输出。**
- [ ] **Step 4: 在循环顶端那个检查点旁装槽。** 命中则追加 `stop_requested` 事件并返回当前 `state`。跑测试 8 确认通过并贴输出。
- [ ] **Step 5: 写失败的测试 8b 两条子用例。** 完整测试名：
  `lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease`
  `lease heartbeat lifecycle > stays refused until the TTL expires when the lease release loses its CAS`
  (ii) 用「测试侧改写 `owner-record.json` 让 CAS 真实失配」构造。
- [ ] **Step 6: 跑这两条并贴输出**（它们钉的是落地后就正确的行为，可能直接绿；绿不算完成，护栏由 Step 7 提供）。
- [ ] **Step 7: 变异实验（两次）。**
  1. 把槽改装到 attempt 内部那处检查点 → **测试 8 必红**
  2. 把 `stop()` 的 `releaseOwnerLease` 整条去掉（只 `clearInterval`）→ **8b(i) 必红**（这条变异**只做实验、立刻还原**，`stop()` 在正式实现里一个字节不改）
  各走三步判据，四份原始输出。
- [ ] **Step 8: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 9: 提交。**

```bash
git add src/controller/runLoop.ts src/controller/resumeLoop.ts tests/controller/runLoop.integration.test.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -m "feat(runLoop): add a stop-request slot at the loop top that returns a resumable state without spending an attempt"
```

- [ ] **Step 10: 独立评审。** 重点：槽是否只装了一处且在 `attemptsUsed` 递增之前、`attemptsUsed` 逐字节相同这条断言是否存在、8b 是否两条子用例且 (ii) 用的是真实 CAS 失配、`stop()` 是否一个字节未改、有没有新增 `persistTerminalState` 调用点（必须为零）。

---

### GATE-B: 组 B 整分支评审与合并

- [ ] **Step 1: 整分支评审**（未参与 B1/B2 的评审员）。重点：方案 (a) 是否被完整实现（谓词未改 + 新分支 + 只从 `runExclusive` 抛）、债 2 接触面是否为零、`stop()` 与 `leaseHeartbeat.ts` 的改动面是否限死在「`runExclusive` 拒绝 + 其上方注释」。
- [ ] **Step 2: 修复波 → 再评审一次。**
- [ ] **Step 3: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 4: 合并（只在人明确下指令时执行），提交信息带评审结论。**

---

# 组 C —— §6 / §7 / §8：Sweep 触发层

> **⛔ 前置硬门：GATE-A 必须已完成、通过整分支评审并合并。** 这是 §11 第 1 条（裁决记录两处拼合的结果）。**C1 的 Consumes 里写着 GATE-A 的合并 hash `$A4`；拿不到它就不许开工。** 理由（本层自己给的，不冒充裁决记录）：sweep 先落地就等于把触发层挂到一条已知损坏的续跑路径上。

### Task C1: `src/sweep/sweepRuns.ts` —— 扫描、过滤、排序、配额、顺序续跑

**Files:**
- **Create: `src/sweep/sweepRuns.ts`**（**本组的第一笔代码，也是 §15 验收 7 判据 (3) 的观测对象**）
- Modify: `src/controller/resumeLoop.ts`（`ResumeLoopOptions` 加 `onAdopted?`；在 `resume_adopted` 追加**之后**、`runLoopFromState` 调用**之前**触发）
- **Create: `tests/sweep/sweepRuns.test.ts`**

**Interfaces:**
- **Consumes（GATE-A）：`$A4` —— 组 A 的合并 hash。** 开工第一步就要能填出这个值；填不出说明顺序被违反，**停下并上报**。
- Consumes（既有，不改，`src/registry/` 零改动）：
  - `export type ScanRow = RunObservation | ScanIssue;`、`export type ScanDeps = ObserveDeps & { dir: DirReader };`、`export const defaultScanDeps: ScanDeps`、`export async function scanRuns(root: string, deps: ScanDeps): Promise<ScanRow[]>`（`src/registry/scanRuns.ts`）
  - `export function scanRootFailureDetail(rows: ScanRow[], root: string): string | undefined`（`src/registry/renderRuns.ts`）
  - `export type RunObservation`（`src/registry/observeRun.ts`）—— 逐 run 观测；**`eligibleForContinuation` 是 `owner-transfer.json` 上的一个被观测字段，观测为 `{ kind: "present", value: true }` 才算 eligible**
- Consumes（A8/B2 产出）：`ResumeLoopOptions`、`StopRequestSignal`
- Produces（C2/C3/C4 依赖）：

  ```ts
  export type SweepDeps = {
    scan?: (root: string, deps: ScanDeps) => Promise<ScanRow[]>;
    scanDeps?: ScanDeps;
    resume?: (runDir: string, adapter: RuntimeAdapter, options?: ResumeLoopOptions) => Promise<RunState>;
  };

  export type SweepOptions = {
    root: string;
    adapterName: "scripted" | "claude";
    createAdapter: () => RuntimeAdapter;   // 配置已由调用方读好并解析好（§8 第一行）
    maxRuns: number;
    stopRequested: StopRequestSignal;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };

  export async function sweepRuns(options: SweepOptions, deps?: SweepDeps): Promise<number>;
  // 返回值就是退出码：扫描本身失败 → 1；其余一切 → 0（§7）
  ```

  - `resumeLoop` 的 `ResumeLoopOptions` 增加 `onAdopted?: () => void`

**流水线（§6，顺序不可换）：**

```
scanRuns(root, scanDeps)
  → scanRootFailureDetail(rows, root) !== undefined → stderr + return 1
  → 过滤 kind === "run" 且 owner-transfer.json 的 eligibleForContinuation 观测为 { kind: "present", value: true }
  → 按 path 字典序排序（确定性，测试依赖它）
  → 打印启动横幅到 stderr → **此后才** createAdapter()
  → 顺序 for-await：resume(runDir, adapter, { stopRequested, onAdopted, onReconciliationWriteAbandoned })
        onAdopted 触发（= 四道门全过、resume_adopted 已追加）即 consumed += 1
        consumed === maxRuns 时停止遍历
        stopRequested.requested 为真时不再开下一个 run
  → 打印报告 → return 0
```

**⚠️ `createAdapter` 是一个闭包不是一个已构造的 adapter，理由写死：** §8 第一行要求「adapter-config **读取**失败 → exit 1，**不扫描**」，而 §8/§12 又要求「横幅打印在**扫描之后、adapter 构造之前**」。两条同时成立的唯一形状是：**调用方（C2）先把配置文件读好并解析好**（读失败 → exit 1，不进 `sweepRuns`），**把一个不会做 I/O 的构造闭包传进来**，由 `sweepRuns` 在横幅之后调用它。**不要把已构造的 adapter 传进来**——那样横幅的位置约束不可测。

**`--max-runs` 只对*实际进入 `runLoopFromState`* 的 run 计数（§6 的计入时点改判）：**

- **配额在「四道门全过、`resume_adopted` 已追加」那一刻计入**，不是在 `resumeLoop` 返回时计入。
- **为什么不能按「正常返回」计数**：`runLoopFromState` 的 `while (true)` 以两条**在任何 try 之外**的 `await` 开头（`writeRunState`、`affirmNow`）。于是这条时序可达：前 k 轮 attempt 全部跑完（**k 次付费调用已经发生**）→ 第 k+1 轮顶端撞上 ENOSPC / CAS 失配 → 异常直接逃出 `runLoopFromState` 与 `resumeLoop` → **按「正常返回才计数」这个 run 一次都不计** → **一次 sweep 可以在 `--max-runs 1` 下打出任意多次付费调用**。§12 的整个「有界批准」论证会被这一条掏空。
- **为什么不用「数 `resume_adopted` 行数」代替回调**：那要读 `events.jsonl`，而 §3 第 1 条承诺 **sweep 自身不读写 run 目录下的任何文件**。回调把这件事留在进程内。
- **不变的部分**：四条拒绝路径在 `resume_adopted` 之前抛出，回调不触发，配额不计——「拒绝不消耗配额、因此不会确定性饿死」原样成立。

**⚠️ N 不等于付费调用次数。** `--max-runs N` 界的是**进入 `runLoopFromState` 的 run 数**；每个 run 内部还有一个 `while (true)`，可跑到它自己的 `maxAttempts`。**付费上界是 `N × maxAttempts`。** 「有界批准」仍然成立（两条界都有限），**但横幅里的 N 不是付费调用次数**。**本层不改横幅格式**（加乘积会把 per-contract 的 `maxAttempts` 提到 sweep 层，而 sweep 打横幅时还没读任何 contract）。

**排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了「拒绝不消耗配额」之后，饿死的机制已经消失。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5（§13 第 5 笔）。**

**测试要求（`tests/sweep/sweepRuns.test.ts`，全部用注入式替身 `resume`）：**

- **测试 10 — 只对观测为 eligible 的行调 `resumeLoop`。** fixture 含 eligible 与非 eligible 两类行，断言替身只被非空的那一组调用过、且参数是那些 path。
- **测试 11 — 一个 run 被拒绝不中断后续 run**（依赖排序确定性）：替身对第一个 path 抛 `ResumeNotEligibleError`，断言后续 path 仍被调用。
- **测试 12b — `--max-runs` 承重，三条子用例：**
  - **(a)** fixture 含 5 个 eligible 目录、`maxRuns: 2`，断言替身**恰好被调用 2 次**、且是**排序后的前 2 个**；**横幅同时含 `5` 与 `2`**。
  - **(b)** 前 2 个目录都被门拒绝（替身抛出、`onAdopted` 不触发）、第 3 个可跑，断言**第 3 个也被调用**——即拒绝不消耗配额。**变异：把配额改成「每次调用都计数」→ 本子用例必红。**
  - **(c)**（钉计入时点改判）替身**先触发 `onAdopted`、再抛出**，`maxRuns: 1`，fixture 含 3 个这样的目录，断言替身**恰好被调用 1 次**。**变异：把计数点退回「`resumeLoop` 正常返回时 +1」→ 本条必红**（退回之后三个目录会被全部调用，因为三次都抛出、三次都不计数）。
- **测试 13 — 信号槽置位后不再开下一个 run**（纯函数层，可自动化）：替身在第一个 run 里把 `stopRequested.requested` 置真，断言第二个 path 未被调用。

**陷阱清单：**

- **截断步放在排序之后，不是过滤之后**——否则「跑哪 N 个」不确定，测试 11 / 13 的确定性依赖就断了。
- **排序是必须的**：`scanRuns` 全文无任何 sort，行序取决于 `readdir` 的文件系统顺序。
- **`sweepRuns` 是纯函数：自身无 writer、不装信号处理器、不读 run 目录下任何文件。** 它只调 `scanRuns` 与 `resume`。
- **但 sweep 会*导致*写入，这是预期行为，必须承认**（§3 第 2 条）：`resumeLoop` 在任何门之前就 `appendEvent(resume_requested)`，四条拒绝路径各再追加一条 `resume_denied`，租约门在特定条件下还会先追加 `lease_expired_observed`；CAS 拒绝路径还有文件系统副作用（建后删锁 + 一次持锁恢复）；`readOwnerRecord` 本身也会跑恢复。**「不往任何 run 目录写一个字节」按字面为假，不要在任何注释或测试名里这么写。**
- **在进程内调用 `scanRuns`，不 fork `ccloop ls --json`。** **代价要记下来**：sweep 因此耦合到 `ScanRow` 类型，而非 L2 §6.3 定义的版本化 JSON 形状；L2 §14.1 的字面要求是后者。
- **并发 sweep 无需额外处理**：后到者被 `resumeLoop` 的租约门拒绝，记入报告，**不是错误**。
- **观测 `resume` 调用次数的缝**：`sweepRuns` 把 `resume` 作为**依赖注入的参数**接收（默认值是真实的 `resumeLoop`），测试传记录调用的替身。**这与 `scanRuns` 已有的 `defaultScanDeps` 形状一致**，不新发明模式。

**Steps:**

- [ ] **Step 1: 填 `$A4`。** 跑 `git log --merges --format='%h %cd %s' --date=iso --reverse`，找到组 A 的合并提交（提交信息里带评审结论），把 hash 写进本任务的工作笔记。**找不到 → 停下并上报，不要开工。**
- [ ] **Step 2: 给 `resumeLoop` 的 `ResumeLoopOptions` 加 `onAdopted?`，在 `resume_adopted` 追加之后、`runLoopFromState` 调用之前触发。** 跑 typecheck 贴输出。
- [ ] **Step 3: 写失败的测试 10 与 11。** 完整测试名：
  `sweepRuns > resumes only the rows observed as eligible for continuation`
  `sweepRuns > continues to the next run after one is refused`
- [ ] **Step 4: 跑这两条确认失败**（`src/sweep/sweepRuns.ts` 尚不存在 → import 失败）。**两份原始输出都贴。**
- [ ] **Step 5: 新建 `src/sweep/sweepRuns.ts` 并实现流水线到「顺序续跑」为止。** 报告与横幅的**格式**留给 C3，本任务先让 `stdout` / `stderr` 两个 sink 存在且被调用。跑测试 10/11 确认通过并贴输出。
- [ ] **Step 6: 写失败的测试 12b 三条子用例。** 完整测试名：
  `sweepRuns > attempts only the first max-runs directories in lexicographic order`
  `sweepRuns > does not spend quota on a refused run`
  `sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it`
- [ ] **Step 7: 跑这三条并贴输出，然后实现配额逻辑（由 `onAdopted` 驱动），再跑确认通过并贴输出。**
- [ ] **Step 8: 写失败的测试 13 并实现停机检查。** 完整测试名：
  `sweepRuns > starts no further run once the stop signal is set`
- [ ] **Step 9: 变异实验（三次）。**
  1. 配额改成「每次调用都计数」→ **12b(b) 必红**
  2. 计数点退回「`resume` 正常返回时 +1」→ **12b(c) 必红**
  3. 去掉排序（保留过滤与截断）→ **12b(a) 必红**
  各走三步判据，六份原始输出。
- [ ] **Step 10: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 11: 提交。**

```bash
git add src/sweep/sweepRuns.ts src/controller/resumeLoop.ts tests/sweep/sweepRuns.test.ts
git commit -m "feat(sweep): add sweepRuns with lexicographic ordering and adoption-time quota accounting"
```

- [ ] **Step 12: 独立评审。** 重点：配额是不是在 `onAdopted` 计入、截断是否在排序之后、`sweepRuns` 是否真的不碰 run 目录下的文件、`src/registry/` 是否零改动、`$A4` 是否被记下。

---

### Task C2: CLI 表面 —— `sweep` 分支、`--max-runs`、退出码、`registerStopHandlers`

**Files:**
- Modify: `src/cli.ts`（`export type ParsedArgs`、`export function parseArgs(`、`async function loadAdapter(`、`export async function main(`）
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes（C1 产出）：`sweepRuns(options, deps?)`、`SweepOptions`
- Consumes（B2 产出）：`StopRequestSignal`、`createStopRequestSignal()`
- Produces（C3/C4 与测试 13b 依赖）：
  - `ParsedArgs` 新增一支：

    ```ts
    | { command: "sweep"; root: string; adapter: "scripted" | "claude"; adapterConfigPath: string; maxRuns: number }
    ```

  - `export function registerStopHandlers(signal: StopRequestSignal, options?: { exit?: (code: number) => void }): () => void;`
    —— **必须从 `src/cli.ts` 导出**，否则测试 13b 无法注入假 `exit`。返回一个反注册函数，使测试不泄漏监听器。

**解析形状（§6 定死）：**

- **参数语法用 `--root` 而不是位置参数。** `parseArgs` 对非 `ls` 命令走的是 `for (let index = 1; index < argv.length; index += 2)` 的纯 flag/value 配对；`sweep <root> --adapter x` 会被配成 `root → "--adapter"`，**在一条完全合法的命令行上报 `missing required flags`**。用 `--root` 让 sweep 直接复用既有配对循环，不必单开分支。
- **`--max-runs <N>` 是必需参数**（§12 的治理表态）。缺失、非正整数、无法解析 → **exit 1**。
- 实现位置：把 `sweep` 加进 `command !== "run" && command !== "resume"` 那道判定，在 `values` 配对循环**之后**为 sweep 单独取 `--root` / `--adapter` / `--adapter-config` / `--max-runs`（**不要**让它去过 `--run-dir` 的必需检查）。

**退出码（§7，一个字节不改）：**

| 退出码 | 条件 |
|---|---|
| `1` | sweep **未能开始或未能完成扫描**：参数解析失败（**含 `--max-runs` 缺失、非正整数、无法解析**）、`--adapter-config` 读取/解析失败、`scanRootFailureDetail(rows, root)` 返回非 `undefined`（root 不存在或不可读） |
| `0` | 其余一切，**包括**某个 run 跑成 `exhausted` / `failed` / 被门拒绝、以及扫描 issue 行 |
| `130` | 收到**第二次**停机信号（SIGINT 与 SIGTERM **合并计数**）的强制退出 |
| `2` | **不使用。** sweep 分支必须在 `finalState.status === "succeeded" ? 0 : 2` 那**两处**映射之前返回 |

```bash
grep -rnF 'succeeded" ? 0 : 2' src/
# 计划阶段实测 2 行，都在 src/cli.ts（resume 分支与 run 分支各一处）。sweep 分支必须在这两处之前返回。
```

**Amended 2026-08-04：本节反复写的边界「必须在两处 `? 0 : 2` 映射之前返回」指错了位置——真正的边界是 `src/cli.ts` 的 `main` 里 `const adapter = await loadAdapter(parsed);` 那一行，它更早、且无条件。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。同一句话在本节出现四处（上表 `2` 那一行、上面这个 `grep` 块的注释、下方陷阱清单第二条、Step 4；Step 10 的评审重点同源）。`sweep` 变体带 `adapter` / `adapterConfigPath`，会被 `loadAdapter` 原本的参数类型 `Exclude<ParsedArgs, { command: "ls" }>` 收进去且类型检查通过，于是「在两处映射之前、却在 `loadAdapter` 之后返回」是一个**满足本文档字面、却在扫描与横幅之前就构造了 adapter** 的合法落点——直接违反本节陷阱清单第四条（配置先读、adapter 由 sweep 在领养时才构造）与 §8/C3 的横幅顺序。**读作：sweep 分支必须在 `loadAdapter` 那一行之前返回；「在两处 `? 0 : 2` 之前」是它的推论，不是判据。** C2 落地后实测（未过滤）：

```
$ rtk proxy "grep -rnF 'const adapter = await loadAdapter(parsed);' src/"
src/cli.ts:241:    const adapter = await loadAdapter(parsed);
$ rtk proxy "grep -rnF 'succeeded\" ? 0 : 2' src/"
src/cli.ts:244:      return finalState.status === "succeeded" ? 0 : 2;
src/cli.ts:248:    return finalState.status === "succeeded" ? 0 : 2;
```

映射仍是 2 处、都在 `src/cli.ts`，且两处（244、248）都晚于 `loadAdapter` 的调用（241）——本条更正的是**判据指向哪一行**，不是那个「2」。

**`scanRootFailureDetail` 是判据本身，不要重新发明**：§7 的「root 不存在或不可读 → exit 1」与 §8 的「扫描 issue 行 → 记录、不中断」在**根目录自身不可读**时重叠；`cli.ts` 的 `ls` 分支已经用这个符号区分了两者，sweep 分支照抄同一判据（实际调用在 `sweepRuns` 内，C1 已实现；C2 只需把它的返回值映射成退出码）。

**逃生口（§5.4，否则装了处理器反而让 sweep 杀不掉）：第二次收到停机信号立即 `exit(130)`。**
**「第二次」的定义已定死：跨信号种类合并计数。** 计数器是**一个**，SIGINT 与 SIGTERM 都对它 `+1`；第一次置槽，第二次（无论来自哪一个）立即 `exit(130)`。
**理由**：操作者第二次按下去表达的是「现在就停」，不是「换一种信号试试」；**按信号种类分别计数会让「先 Ctrl-C 再 `kill`」这个最常见的升级序列永远走不到逃生口。**

**测试要求：**

- **测试 12 — 退出码**：参数错误 / `--max-runs` 缺失 / `--max-runs` 非正整数 / adapter-config 读取失败 / 扫描失败 → **exit 1**；其余一律 **exit 0**（含 run 跑成 `exhausted`）。**每一格各一条 `it`，不许合成。**
- **测试 13b — 第二次信号 → 130**：`registerStopHandlers(signal, { exit })` 注入假 `exit`，**先 emit `SIGINT` 再 emit `SIGTERM`**，断言第一次只置槽（`signal.requested === true`、`exit` 未被调用）、第二次调用了 `exit(130)`。
  **变异：改成按信号种类分别计数 → 「先 Ctrl-C 再 kill」这条断言必红。**
  **⚠️ 第一轮把 13 与 13b 写成一条测试，而后半句按字面不可表达**（`process.exit(130)` 装在处理器里、没有注入缝），**本仓库有案底：一个测试名讲两件事、只有一件有断言。** 本层的处置是把逃生口做成可注入形状并**拆成两条**。测试结束务必调用返回的反注册函数。

**陷阱清单：**

- **信号处理器装在 `cli.ts`，不装在 `sweepRuns.ts`。** 这既让「sweep 自身不新增 writer」成立，也让测试 13 可测。
- **`sweep` 分支必须在两处 `? 0 : 2` 映射之前返回。** exit 2 在 sweep 上**不使用**。
- **不加 `--json`。** sweep 的报告今天没有消费者。
- **adapter-config 的读取与解析在进 `sweepRuns` 之前完成**（§8 第一行「exit 1，不扫描」），传进去的是一个不做 I/O 的构造闭包（C1 的 `createAdapter`）。
- **`--max-runs` 的完整落地面是五处**：§6 调用式与流水线（C1）、§7 退出码表（本任务）、§8 横幅与报告汇总行（C3）、§9 模块表、§10 测试 12b（C1）。**第一轮只写在 §12，导致这条治理要求实际上不可实施。**

**Steps:**

- [ ] **Step 1: 写失败的测试 12 各格。** 完整测试名（各一条）：
  `main sweep > exits 1 when --max-runs is missing`
  `main sweep > exits 1 when --max-runs is not a positive integer`
  `main sweep > exits 1 when the adapter config cannot be read`
  `main sweep > exits 1 when the root does not exist`
  `main sweep > exits 0 when a run reaches exhausted`
- [ ] **Step 2: 跑它们确认失败，五份原始输出都贴。**
- [ ] **Step 3: 加 `ParsedArgs` 的 sweep 分支与 `parseArgs` 的解析。** 跑上面前两条确认通过并贴输出。
- [ ] **Step 4: 加 `main` 的 sweep 分支**：读并解析 adapter-config（失败 → return 1）→ 造 `createAdapter` 闭包 → `createStopRequestSignal()` → `registerStopHandlers` → `sweepRuns(...)` → 直接返回它的返回值。**必须排在两处 `? 0 : 2` 之前。** 跑后三条确认通过并贴输出。
- [ ] **Step 5: 写失败的测试 13b。** 完整测试名：
  `registerStopHandlers > sets the slot on the first signal and exits 130 on the second, counting SIGINT and SIGTERM together`
- [ ] **Step 6: 跑它确认失败 → 实现 `registerStopHandlers`（合并计数 + 返回反注册函数）→ 再跑确认通过。两份原始输出都贴。**
- [ ] **Step 7: 变异实验（两次）。**
  1. 按信号种类分别计数 → **13b 必红**
  2. `--max-runs` 缺失时不报错（取默认值）→ **`exits 1 when --max-runs is missing` 必红**
  各走三步判据，四份原始输出。
- [ ] **Step 8: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 9: 提交。**

```bash
git add src/cli.ts tests/cli/cli.test.ts
git commit -m "feat(cli): add the sweep command with a required --max-runs and an injectable stop-signal escape hatch"
```

- [ ] **Step 10: 独立评审。** 重点：sweep 分支是否在两处 `? 0 : 2` 之前返回、`--max-runs` 的四种非法形态是否都走 exit 1、`registerStopHandlers` 是否导出且合并计数、测试是否泄漏了 process 监听器。

---

### Task C3: 报告、横幅与错误路由（含 `reconciliation_write_abandoned` 的 stderr 备注行）

**Files:**
- Modify: `src/sweep/sweepRuns.ts`（横幅、报告行、汇总行、路由判据、`note` 行）
- Test: `tests/sweep/sweepRuns.test.ts`

**Interfaces:**
- Consumes（C1 产出）：`SweepOptions` 的 `stdout` / `stderr` 两个 sink、`SweepDeps.resume`
- Consumes（A8 产出）：`ResumeLoopOptions.onReconciliationWriteAbandoned?: (detail: string) => void`
- Consumes（既有，不改）：`export class ResumeNotEligibleError`（`src/controller/resumeLoop.ts`，**单参构造，签名一个字节不改**）、`RunLeaseHeldError`
- Produces（C4 与 §15 验收 9 依赖）：三种输出行的**确切格式**（见下）

**输出格式（定死，因为没有 `--json`，人类可读形式就是全部契约）：**

- **启动横幅**（stderr，**扫描之后、`createAdapter()` 之前**）：
  `sweep: <eligible> eligible run(s) under <root>, will attempt at most <N>, adapter=<name>`
  **横幅必须同时显示 eligible 总数与配额 N**——§12 的整个论证是「操作者选 `--adapter claude` 即构成对该次 sweep 的**知情且有界**批准」，**少了 N，「知情」就不成立**。

  **Amended 2026-08-05：上面这个横幅字面量里裸用的 "eligible" 会把「知情」的另一半掏空，已按人的裁定改成带限定的措辞。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。理由与本节 `interrupted` 那条 `Amended 2026-08-04` 同源，只是落在横幅上：sweep 的过滤器只观测 `owner-transfer.json` 的 `eligibleForContinuation`（`src/sweep/sweepRuns.ts` 的 `isObservedEligible`），**它只覆盖 `evaluateResumeEligibility` 八条判据里的第 1 条**（守卫实测：`rtk proxy "bash -c 'cd <worktree> && grep -cF \"return { ok: false\" src/controller/resumeLoop.ts'"` → **8**）。于是一次「17 eligible」的横幅可以对应 17 个全部被门拒的 run，操作者据此批准 `--adapter claude`，§12 要求的「知情」在批准的那一刻就是假的——**这与少写一个 N 是同一种失效，只是发生在另一个数字上**。同仓库同为只读的 `ccloop ls` 在**同一个字段**上一直带着这句限定（`src/registry/renderRuns.ts` 的 `CONSISTENCY_NOTICE`：「eligibleForContinuation is an observed field, not a decision that the run may be resumed」），本横幅照它的口气写，使两个只读表面对同一字段说同一句话。**读作**：横幅仍**必须**同时显示候选集大小与配额 N（这一条一个字不改），但那个计数**必须被命名为它所计的东西**，且不得出现「保证 / 一定 / 能续跑」一类措辞（与 `Amended 2026-08-04` 那条同一条线）。GATE-C 修复波落地的字面量逐字为：

  `sweep: <eligible> run(s) under <root> observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most <N>, adapter=<name>`
- **每个尝试过的 run 一行**（stdout），制表对齐三列 `path | outcome | detail`。
- **`outcome` 取值域（八个）**：`succeeded` / `failed` / `exhausted` / `blocked_waiting_human` / **`cancelled`** / `interrupted` / `refused` / `error`。
  - **`cancelled` 不归入 `failed`**：两者对操作者意味着不同的下一步（`failed` 是 run 自身失败，`cancelled` 是所有权/信号原因中止）。`detail` 必须携带 `stopReason`。
  - `cancelled` 今天有 5 个生产来源（4 个直接写终态的调用点 ＋ 1 个经 `decision.kind` 的路径）。
- **末尾汇总行**（stdout）：
  `<attempted> attempted, <succeeded> succeeded, <refused> refused, <errored> errored (quota <consumed>/<N>)`
  **格式不改、不加计数格。**

**错误路由（§8 表，逐行）：**

| 情形 | 反应 | 去向 |
|---|---|---|
| 扫描 issue 行（`directory_unreadable` / `depth_truncated`） | 记录，不续跑，不中断，**不影响退出码** | stderr |
| `ResumeNotEligibleError` | **正常结果**，不是错误 | stdout（outcome `refused`） |
| **`ResumeNotEligibleError` 且 message 以 `cannot read run artifacts:` 开头** | **不是正常结果**：outcome **`error`**，detail 带完整 message | **stderr** |
| `RunLeaseHeldError` | 正常结果（别人正在跑） | stdout（outcome `refused`） |
| run 跑到任一终态 | 记录终态 + `stopReason` | stdout |
| run 因 `stop_requested` 或 `RunHeartbeatStoppedError` 返回非终态 | 记录为 **`interrupted`**，**明确标注该 run 仍可续跑** | stdout |
| 意料之外的抛错 | 记录**完整 message**，继续下一个 | **stderr**（outcome `error`） |
| **`reconciliation_write_abandoned`** | **一条独立的备注行**：`note  <path>  reconciliation_write_abandoned  <detail>`。**该 run 自己的 `outcome` 一个字节不变**，**退出码不变**，**汇总行不变** | **stderr** |

**Amended 2026-08-04：上表 `interrupted` 那一行要求「明确标注该 run 仍可续跑」——这句话今天不能被担保，已按人的裁定改成只断言已知的。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。GATE-B 已经钉死「**非终态 ≠ 可被 resume 捡起**」：`evaluateResumeEligibility` 有**八条**判据（守卫实测：`rtk proxy "grep -cF 'return { ok: false' src/controller/resumeLoop.ts"` → **8**），而 sweep 的过滤器只建在 **L2 观测**上（`owner-transfer.json` 的 `eligibleForContinuation` 观测为 literal true）——**它只覆盖八条里的第 1 条**，判据 5–8 在本层从未被求值，本计划也没有任何步骤去建立它们。**读作**：该行仍记为 `interrupted`，`detail` 说明它未达终态，并**明确不对「它能否被续跑」作任何断言**。C3 落地的措辞逐字为 `status=<status>, stopReason=<stopReason>, non-terminal — this sweep makes no claim that it can be resumed`。**「保证 / 一定 / 仍可续跑」这一类措辞不得出现在代码、注释、报告或 stdout/stderr 的任何一处**——C1 已在 `src/sweep/sweepRuns.ts` 的 `isObservedEligible` 与 `tests/sweep/sweepRuns.test.ts` 的文件头守住了同一条线。

**`cannot read run artifacts:` 前缀路由（§4.4 的路由改判）：**

判据是 `error instanceof ResumeNotEligibleError && error.message.startsWith("cannot read run artifacts:")` → outcome `error` → stderr。

```bash
grep -rnF 'cannot read run artifacts' src/ tests/
# 计划阶段实测 3 行：src/controller/resumeLoop.ts 两行（resume_denied 的 detail 与 throw），
#   tests/cli/cli.test.ts 一行（既有断言，说明这个前缀已经是被依赖的契约）。
#   src/ 内只有 resumeLoop.ts 一处产生它 —— 前缀唯一。
```

**Amended 2026-08-04：上面这个 `grep` 块的「计划阶段实测 3 行」今天已经腐坏——组 C 开工时实测是 22 行。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。**但「`src/` 内只有 `resumeLoop.ts` 一处产生它 —— 前缀唯一」这半句仍然成立**，腐坏的只有总数与 `tests/` 侧的分布。C3 落地时两次实测（未过滤）：

```
# 组 C 开工时（分支 HEAD c14f792，本任务的编辑尚未落地）
$ rtk proxy "grep -rnF 'cannot read run artifacts' src/ tests/"
# 22 行：src/controller/resumeLoop.ts 2（第 144 行 resume_denied 的 detail、第 145 行 throw，同一个 catch）
#        tests/cli/cli.test.ts 1
#        tests/persistence/fileStore.test.ts 19

# C3 落地之后（本任务自己新增 4 行：sweep 的判据 1 行 ＋ 测试 12c 的 fixture 与前置断言 3 行）
$ rtk proxy "bash -c 'grep -rnF \"cannot read run artifacts\" src/ tests/ | wc -l'"   # → 26
$ rtk proxy "bash -c 'grep -rnF \"cannot read run artifacts\" src/ | wc -l'"          # → 3
$ rtk proxy "bash -c 'grep -rnF \"cannot read run artifacts\" tests/ | wc -l'"        # → 23
$ rtk proxy "grep -cF 'cannot read run artifacts' tests/persistence/fileStore.test.ts" # → 19
```

新增的那 19 行全部在**组 A** 的 `tests/persistence/fileStore.test.ts` 里——组 A 是在本计划写完之后才落地的：17 行是崩溃矩阵的期望字面（第 2816–2828、2842–2845 行，同属 `fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives` 这**一条**测试的两个 `expect.soft`），另 2 行是 `observeResume`（第 3702–3703 行）把 message 映射成矩阵标签的 `startsWith`。

**因此下方「`resumeLoop.ts` 那两处与 sweep 的判据必须同笔改动」漏了第三处**：`tests/persistence/fileStore.test.ts` 的 `observeResume` 里的 `error.message.startsWith("cannot read run artifacts")`——它**不带冒号**，与 sweep 判据的 `startsWith("cannot read run artifacts:")` 形式不同，因此只改冒号之后的部分时它会**静默存活**——以及被它喂养的那 17 行矩阵期望字面。同笔改动的集合在组 A 落地之后是**三处**，不是两处。

**代价，明写**：这条路由把「读侧任何失败」整体归为 `error`，不区分具体原因——**比按类型路由粗**。**本层接受**：§8 那一行要的性质是「有 stderr 即告警」，而 detail 里带完整 message（含原错误的 `String(error)`），诊断信息一点没少。
**⚠️ 这使前缀字面量成为一条被依赖的契约**，`resumeLoop.ts` 那两处与 sweep 的判据**必须同笔改动**；测试 12c 钉这一点。
**⚠️ 不要改用 `Error.cause`。** §4.4 已否决：`ResumeNotEligibleError` 是单参构造（改它是导出类的公开签名变更，测试侧也 `new` 它），而前缀路由**恰好接住了规则 2 那条可达路径**（它捕获 `Promise.all` 里**任何**读侧抛出），且 `resumeLoop.ts` **一个字节不改**。

**`reconciliation_write_abandoned` 的落点（§4.3 第五波人裁 + 第六波两条降级）：**

- **不是 `error`，也不新增 outcome 取值。** `outcome` 是该 run 的**终局**分类，一行一个值；这条事件与终局**正交**——**一个最终 `succeeded` 的 run 照样能产生它**。写进 `error` 会用一条局部事件谎报整个 run 的结果。
- **落点是一条另起的备注行**，一次调用产生一行，**不去重、不聚合**。
- **⚠️ 行序承诺只在 stderr *这一条流内部*成立（第六波降级）。** 报告行走 stdout、备注行走 stderr，**两条流被重定向到同一个管道或文件时它们之间的相对顺序在 Node 里不受保证**。**所以「紧跟该 run 的报告行之后打印」这条跨流承诺不再作出**，也不许被断言或被操作者依赖。**改成**：**同一次 sweep 内，各条 `note` 行之间保持 run 的遍历顺序**（sweep 是顺序 for-await，单流内行序确定）。
- **⚠️ `detail` 打印前必须折成单行。** `detail` 取 `String(error)`，而 `SyntaxError` 之类的 message **可以含换行**（`JSON.parse` 的报错常带位置片段），一条备注会被拆成看起来像多条的输出。**处置：打印前把 `\r?\n` 折成单个空格。**
  （**§8 既有的 `errored` 那一行有同样的问题、先于本波存在，本层刻意不动它**——那是另一条契约的范围，改它要连带 §7 与测试 12c，收益不抵成本。**具名留给下一轮。**）
- **不复用 `cannot read run artifacts:` 那一行，且不要假装它能接住**：那个前缀只在 `resumeLoop` 的**读侧** `Promise.all` catch 里产生，而本事件产生在 `fileStore` 的**写侧**，根本不经过那个 catch。
- **退出码不受影响。** 退出码钉的是「sweep 有没有干成它的活」，这条事件既不阻止扫描完成、也不改变任何 run 的合法终局。**可见性由 stderr 独家兑现——而 cron 的「有 stderr 即告警」现在会为它响，这正是人裁要的东西。**
- **`ccloop run` / `ccloop resume` 两条 CLI 路径不传回调**，行为与第四轮一致（只进 `events.jsonl`）。**这不是遗漏**：那两条是前台命令，操作者本来就在看着；stderr 路由要解决的是无人值守的 sweep。
- **回调的实现定死为一次数组 push**（把 `{ path, detail }` 推进本次 sweep 的备注数组），**不做 I/O、不格式化、不得抛出**。它若抛出会一路逃到 `runLoopFromState`，把一次保护性放弃升级成 attempt 失败。**本层刻意不给它包 try/catch**——包了会静默吞掉一个编程错误，违反 Rule 12。

  **Amended 2026-08-04：「一次数组 push」＋「不做 I/O、不格式化」这两句已被人裁推翻——回调改为*当场* `options.stderr(...)`，折行也在回调里当场做。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。**理由不是口味，是缓冲会丢告警**：把 note 收进数组、等整个 for-await 循环结束才统一冲出，等于把这条事件的可见性押在「进程一定活到循环结束」上。一次 `--max-runs 50` 的 sweep 可以跑数小时；若第 3 个 run 触发 `reconciliation_write_abandoned`、进程在第 40 个 run 时被 SIGKILL / OOM / 机器重启，**缓冲数组随进程消失，stderr 上一个字都没有**，cron 的「有 stderr 即告警」**永不触发**——而这条事件的**全部**价值就是那次告警（见本节「退出码不受影响」一条：「可见性由 stderr 独家兑现」）。**且缓冲没有换来任何本节要求的性质**：本节唯一要求的行序是「同一次 sweep 内，各条 `note` 行之间保持 run 的遍历顺序」，而 sweep 是顺序 `for await`，**当场打印同样满足它**。所以那两句要求的是一个零收益、带一条不可见失效模式的形状。

  **本条其余部分不变，并且仍然成立**：一次调用产生一行、不去重、不聚合；**回调仍然不得抛出**，且**仍然刻意不包 try/catch**——`options.stderr` 抛出是调用方的编程错误，吞掉它同样违反 Rule 12。**变的只有「落点是数组」这一件事，改为「落点是 stderr」。**

**测试要求：**

- **测试 12c — `cannot read run artifacts:` 前缀是被依赖的契约**：替身 `resume` 抛一个 message 以该前缀开头的 `ResumeNotEligibleError`，断言该行 outcome 为 **`error`**、写到 **stderr**、detail **含完整 message**。
  **变异：把 `resumeLoop.ts` 那两处的前缀字面量改掉而不同步改 sweep 的判据 → 本测试必须红。** 这条把「前缀是契约」从注释变成断言。
- **测试 12d(i) — 路由发生，且不污染 `outcome`**：替身**先触发它收到的 `onReconciliationWriteAbandoned('<detail>')`、再正常返回一个 `succeeded` 的 `RunState`**。断言（**全部对 `sweepRuns` 返回之后的最终输出取，不对过程取**）：
  1. stderr 里有一行 `note  <path>  reconciliation_write_abandoned  <detail>`
  2. 该 run 自己的报告行 outcome 仍是 **`succeeded`**、且在 **stdout**
  3. 汇总行的 `errored` 计数为 **0**
  4. 返回值（退出码）为 **0**
  **变异一：把它路由进 `error` 那一格（复用前缀那条支路）→ (2) 与 (3) 必须红。**
  **变异二：退回「不路由」（回调传了但 sweep 不打印）→ (1) 必须红。**
- **测试 12d(ii) — 一次后续抛出不得吞掉这条备注**（这是**否决上行方案的那条理由的护栏**）：替身**先触发 `onAdopted`、再触发 `onReconciliationWriteAbandoned`、再抛出**。断言 stderr **同时**有那条 `note` 行**和**该 run 的 `error` 行。
  **变异：把备注的落盘时机从「回调当场记入 sweep 的数组」改成「`resume` 正常返回后才记」→ 本条必须红**（抛出路径上永远走不到那一步）。**这个变异正是上行方案的失效形状，用一行生产改动表达出来。**

  **Amended 2026-08-05：本条变异的基线「回调当场记入 sweep 的数组」今天不存在 —— 回调当场做的是一次 `options.stderr(...)`，落点是 stderr 不是数组。** 这纠正的是*本计划*的缺陷，不是实现的缺陷。**⚠️ 本条不是描述，是一条会被照着执行的指令**：谁按字面复现它，会先去构造一个今天根本不存在的基线，**变异于是钉不住任何东西，而执行者会以为自己走完了三步判据**。**这条变异要钉的性质没有变**（记录必须在**回调当场**离开 sweep，而不是等 `resume` 返回之后才记），**变的只是它的落点**。今天该怎么做这条变异，逐字写出来：

  - **变异动作**（只动生产代码 `src/sweep/sweepRuns.ts`，一处）：把 `onReconciliationWriteAbandoned` 回调体里那次当场的 `options.stderr(...)` 改成把该行 push 进一个声明在 `await resume(...)` **之外**的局部数组，并在 **`await resume(...)` 正常返回之后**才把数组里的行逐条 `options.stderr(...)` 出去。
  - **期望**：上面 Step 5 的第二条测试（裸 `it` 名 `keeps the abandonment note on stderr even when the run throws afterwards`，即 12d(ii)）**必须红** —— 该用例的替身 `resume` 在触发回调之后 reject，冲出那一步永远走不到，`note` 行整条消失。
  - **实测（写本条勘误时当场跑过，未过滤）**：变异后 `npx vitest run tests/sweep/sweepRuns.test.ts` → `Tests  1 failed | 12 passed (13)`，唯一失败的就是 12d(ii)，失败形态是 `expect(h.stderrLines).toEqual([...])` 只收到 2 行，缺的正是 `note  <path>  reconciliation_write_abandoned  <detail>` 那一行。**12d(i) 保持绿是正确的、不是漏杀**：正常返回路径上那次冲出照样发生，本条变异钉的本来就只有抛出路径。

  **「这个变异正是上行方案的失效形状」这句不变、且仍然成立。** 落点改写的完整理由见本节上面「落点」一条的 `Amended 2026-08-04`。
- **⚠️ 12d(i) 与 (ii) 钉的是终态**（`sweepRuns` 返回之后 stderr / stdout 的最终文本与 `outcome` 列的最终取值），**不是「回调在第几个 `await` 之后被调用」**。把替身的执行顺序换掉（例如让它先抛出再触发回调），这两条的断言仍然各自成立或各自失败。
  **（12d 的另两条子用例 (iii)(iv) 是*过程*断言且刻意如此，它们在 A7/A8，不在本任务。不要把它们弱化成终态断言——那恰好放掉排序这唯一的护栏。）**

**陷阱清单：**

- **`note` 行不进那三列。** 它是另起的一行，不是 `path | outcome | detail` 里的一格。
- **汇总行格式不改、不加计数格。** 人裁只要求「看得见」，加计数是超出的第二件事（Rule 2）；且该格式已被 §18 附 G24 与 §19 引用，改它会作废那两处而没有对应收益。
- **横幅必须在扫描之后、`createAdapter()` 之前。** 这条位置约束是可测的（C1 已把 `createAdapter` 做成闭包）——**测试要断言横幅先于 `createAdapter` 被调用**。
- **`detail` 折行只对 `note` 行做，不要顺手去改 `errored` 那一行。**
- **sweep 从不静默吞任何一种结果**（Rule 12）。意外错误按 §7 不改退出码，但**必须**写到 stderr 以便被 cron 的「有 stderr 即告警」捞住。

**Steps:**

- [ ] **Step 1: 写失败的横幅与报告格式测试。** 完整测试名：
  `sweepRuns > prints the banner with the eligible count and the quota before constructing the adapter`
  `sweepRuns > prints one tab-aligned report line per attempted run and a summary line`
- [ ] **Step 2: 跑确认失败并贴输出 → 实现横幅、报告行、汇总行 → 再跑确认通过并贴输出。**
- [ ] **Step 3: 写失败的测试 12c。** 完整测试名：
  `sweepRuns > routes a cannot-read-run-artifacts refusal to stderr as an error, not to stdout as a refusal`
- [ ] **Step 4: 跑确认失败并贴输出 → 实现前缀路由 → 再跑确认通过并贴输出。**
- [ ] **Step 5: 写失败的测试 12d(i) 与 12d(ii)。** 完整测试名：
  `sweepRuns > prints a reconciliation_write_abandoned note on stderr without changing the run outcome`
  `sweepRuns > keeps the abandonment note on stderr even when the run throws afterwards`
- [ ] **Step 6: 跑确认失败并贴输出 → 实现 `note` 行（含单行折叠、遍历顺序、回调=一次数组 push）→ 再跑确认通过并贴输出。**

  **Amended 2026-08-04：本步括号里的「回调=一次数组 push」与上面「落点」一节那一句是同一处，已同样被人裁推翻——读作「回调=当场 `options.stderr(...)`（含单行折叠）」。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。完整理由见上面那条 `*Amended 2026-08-04*`（缓冲不换来任何本节要求的性质，却引入一条 SIGKILL 下静默丢失告警的失效模式）。「单行折叠」与「遍历顺序」两项不变。
- [ ] **Step 7: 变异实验（四次）。**
  1. 前缀字面量改掉而不同步改判据 → **12c 必红**

     **Amended 2026-08-04：本条判据为假——把 `resumeLoop.ts` 那两处前缀字面量改掉，12c 实测*存活*。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。**原因是结构性的、与 12c 写得强不强无关**：12c 按本节测试要求的明文规定，注入的是**替身 `resume`**，它抛出的 `ResumeNotEligibleError` 的 message 是 `tests/sweep/sweepRuns.test.ts` 里的**字面量**；生产的 `resumeLoop` 在这条测试里**根本没有被进入**。因此 `resumeLoop.ts` 的字面量与 12c 之间**没有任何数据通路**，改前者不可能让后者变红。C3 落地时实测（未过滤，裸 `it` 名，注入 `cannot read run artifacts: ` → `cannot load run artifacts: `）：

     ```
     # 注入前
      Test Files  1 passed (1)
           Tests  1 passed | 11 skipped (12)
     # 注入后（仍然绿 —— 变异存活）
      Test Files  1 passed (1)
           Tests  1 passed | 11 skipped (12)
     ```

     **该变异实际杀掉的是另外两条**（同一次注入下实测）：`tests/cli/cli.test.ts > parseArgs resume > prints the refusal reason to stderr when resume is refused (spec §9)` 1 条，以及 `tests/persistence/fileStore.test.ts > fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives` 1 条（该条内部两个 `expect.soft` 分别有 13 行与 4 行矩阵期望分歧，共 17 行）。

     **人裁：本条改为变异 `src/sweep/sweepRuns.ts` 的 `classifyThrow` 里那个 `startsWith("cannot read run artifacts:")` 字面量**（**不是** `resumeLoop.ts` 的），它落在本任务自己的 Files 名单内。C3 落地时实测三步（未过滤，裸 `it` 名）：

     ```
     # 注入前
      Test Files  1 passed (1)
           Tests  1 passed | 11 skipped (12)
     # 注入后（startsWith("cannot read run artifacts:") → startsWith("cannot load run artifacts:")）
      × sweepRuns > routes a cannot-read-run-artifacts refusal to stderr as an error, not to stdout as a refusal
        AssertionError: expected [] to deeply equal [ Array(1) ]
        - "/fake/root/run-1	error	cannot read run artifacts: Error: EACCES: permission denied, open 'owner-transfer.json'"
        + （空）
      Test Files  1 failed (1)
           Tests  1 failed | 11 skipped (12)
     # 还原后
      Test Files  1 passed (1)
           Tests  1 passed | 11 skipped (12)
     ```

     红在 `expect(h.stderrLines.slice(1))` 那一句上：run-1 从 stderr／`error` 掉回 stdout／`refused`。

     **这条替代变异钉住的是哪一层，写明以免被读得过强**：它钉的是「**C3 确实消费了那个前缀字面量**」——sweep 的路由真的由该前缀决定，不是恒真也不是恒假。它**不**钉「`resumeLoop.ts` 与 sweep 两侧的字面量相等」这一**跨模块**层；那一层今天由 `tests/cli/cli.test.ts` 与 `tests/persistence/fileStore.test.ts` 承重——上面那次对 `resumeLoop.ts` 的注入把它们**双双打红**，即是该层有护栏的证据。
  2. `note` 路由进 `error` 那一格 → **12d(i) 的 (2)(3) 必红**
  3. 退回「不路由」→ **12d(i) 的 (1) 必红**
  4. 记录时机改成「`resume` 正常返回后才记」→ **12d(ii) 必红**
  各走三步判据，八份原始输出。
- [ ] **Step 8: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 9: 提交。**

```bash
git add src/sweep/sweepRuns.ts tests/sweep/sweepRuns.test.ts
git commit -m "feat(sweep): report outcomes on stdout and route read-side failures and abandonment notes to stderr"
```

- [ ] **Step 10: 独立评审。** 重点：`note` 行是否不进 outcome 列、退出码与汇总行是否真的不变、横幅是否含 eligible 与 N 且在 `createAdapter` 之前、`detail` 是否折成单行、有没有跨流行序的承诺被写进断言。

---

### Task C4: 写面钉定（测试 14 与 14b）

**Files:**
- Test only: `tests/registry/zeroWrite.test.ts`（形状照搬该文件既有的承重写法）

**Interfaces:**
- Consumes（C1/C2/C3 产出）：`sweepRuns(options, deps?)` 与它的默认 `resume`（本任务用**真实的** `resumeLoop`，不用替身——本条钉的正是真实调用带来的写面）
- Consumes（A1/A2 产出）：全部 11 个 staging 路径的**文件名**

**测试 14 — 写面钉定（取代空洞的「零写入」）：**

对一个**观测 eligible 但门拒绝**的 run 目录，断言它**恰好**新增 `resume_requested` + `resume_denied` 两行事件、**其余字节不变**。

**⚠️ 「恰好两行」只在被显式规定的 fixture 下成立，三条前提必须在测试里被*断言*，不得默认：**

- **机制一：`leaseAffirmedAt` 必须为 `null`。** 否则若它非 `null` 且已过 TTL，`checkRunLease` 会**先追加 `lease_expired_observed` 再放行**（那是 `leaseGate.ts` 里的写者，只扫 `resumeLoop.ts` 的 grep 结构上看不见它）。fixture 必须走 `no_lease` 分支。
- **机制二：目录内无任何 staging 残留 —— 逐个具名，共 11 个路径。** 否则 `resumeLoop` 的 `Promise.all` 调 `readOwnerRecord`，它第一条语句就是 `recoverInterruptedOwnerTransfer`，可能 finalize 一个待决事务（本层之后是 3 次 rename + 若干 unlink，还会多写 `reconciliation-record.json`）。**L2 早把这个坑标出来了**：L2 §7.1 专门**禁用** `readOwnerRecord`、改用 `readOwnerRecordWithoutRecovery`，而 sweep 走的 `resumeLoop` **没有**那层保护。
  - marker **1** 个：`.owner-transfer.transaction.json`
  - pending **3** 份：`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.reconciliation-record.pending.json`
  - 发布 temp **3** 个：`.owner-record.publish.tmp` / `.owner-transfer.publish.tmp` / `.reconciliation-record.publish.tmp`
  - marker temp **1** 个：`.owner-transfer.transaction.tmp`
  - pending temp **3** 个：`.owner-record.pending.tmp` / `.owner-transfer.pending.tmp` / `.reconciliation-record.pending.tmp`

  **11 = 1 marker ＋ 10**，其中那 10 个正是 `cleanupOwnerTransferStagingWithoutMarker` 回收的那一组（**六处联动**）。**marker 自己不在那 10 个里**——「无 marker」正是那个函数被调用的前提。
- **机制三：拒绝必须由 `evaluateResumeEligibility` 给出，不能是 CAS 门给的。** 走 CAS 门那条路（`claimOwnerRecordWithPrecondition`）会**建后删 `.owner-transfer.lock`**，并在持锁期间跑一次 `lockHeld: true` 的恢复——于是「其余字节不变」在**全树快照**下必假。
  **最省事的构造**：让 `reconciliation-record.json` 的 `eligibleForContinuation` 为 `false`，命中八条判据的第二条，**从而根本走不到 CAS 门**。

**伴生断言**：fixture **必须再包含第二个*非* eligible 的 run 目录**；主断言是**那个非 eligible 目录**字节不变。
**变异：若 sweep 改为对非 eligible 行也调 `resumeLoop`，那个非 eligible 目录就会变 → 断言必须红。**
（第一轮写「该目录就会变」，按句法指向前半句那个 eligible 目录，而变异实际改变的是**非 eligible** 那个。）

**测试 14b — 恢复确实发生且被记录（与 14 配对）：**

对一个**刻意 staged 触发恢复的 eligible 目录**（构造照搬 L2 §12.1 的 fixture 前提集：marker present、`.owner-record.pending.json` 与 `.owner-transfer.pending.json` present、`.owner-transfer.lock` **absent**，**本层再加 `.reconciliation-record.pending.json`**），断言 sweep 之后
(i) **三个文件全部就位**、(ii) **marker 与全部 pending 已被回收**、(iii) `resumeLoop` **放行**。
**这条把「sweep 会导致恢复」从一个被隐藏的事实变成一个被断言的事实。**

```bash
grep -nF -A14 'Zero-write proof.' docs/superpowers/specs/2026-07-28-run-registry-design.md
# L2 §12.1 的 fixture 前提集，逐条照搬（开工时重跑并贴输出）
```

**陷阱清单：**

- **旧测试 14 只测了*不* eligible 的目录——那种目录 sweep 根本不碰，所以它证明的是「过滤器有效」，不是「零写入」。** 不要退回那个形状。
- **「不往任何 run 目录写一个字节」按字面为假。** 本条钉的是**写面的确切形状**，不是零写入。
- **三条前提必须被断言**，不是被注释。断言 `leaseAffirmedAt === null`、断言 11 个路径逐个不存在、断言拒绝来自资格门（例如断言 `resume_denied` 的 detail 形态）。
- **14 与 14b 是配对的**：14 说「不该发生的没发生」，14b 说「该发生的发生了」。**只写 14 会鼓励一个「什么都不做」的实现。**

**Steps:**

- [ ] **Step 1: 重跑 L2 fixture 前提集那条命令并贴输出。**
- [ ] **Step 2: 写失败的测试 14。** 完整测试名：
  `sweep write surface > appends exactly resume_requested and resume_denied to a gate-refused run and leaves the non-eligible run byte-identical`
  **三条前提各写一条独立断言。**
- [ ] **Step 3: 跑它并贴输出。** 若绿（实现已正确），护栏由 Step 5 的变异提供。
- [ ] **Step 4: 写失败的测试 14b。** 完整测试名：
  `sweep write surface > finalizes a staged three-file transaction during sweep and admits the run afterwards`
  跑 → 贴输出。
- [ ] **Step 5: 变异实验（两次）。**
  1. sweep 改为对非 eligible 行也调 `resume` → **测试 14 必红**
  2. `recoverInterruptedOwnerTransfer` 在无锁时也早退（即恢复不发生）→ **测试 14b 必红**
  各走三步判据，四份原始输出。
- [ ] **Step 6: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 7: 提交。**

```bash
git add tests/registry/zeroWrite.test.ts
git commit -m "test(sweep): pin the exact write surface of a gate-refused run and the recovery of a staged transaction"
```

- [ ] **Step 8: 独立评审。** 重点：11 个路径是否逐个具名且断言、三条前提是否**断言**而非注释、伴生断言的主语是不是**非 eligible** 那个目录、14b 的 fixture 是否加了第三份 pending。

---

### GATE-C: 组 C 整分支评审与合并

- [ ] **Step 1: 整分支评审**（未参与 C1–C4 的评审员）。重点：`src/registry/` 零改动、`sweepRuns` 是否真的不读写 run 目录下任何文件、退出码表是否逐格落地、`--max-runs` 五处落地面是否齐、`note` 行是否不污染 outcome 与汇总与退出码。
- [ ] **Step 2: 修复波 → 再评审一次。**
- [ ] **Step 3: 全套件 + typecheck + build，未过滤贴出。**
- [ ] **Step 4: 合并（只在人明确下指令时执行），提交信息带评审结论。记下合并 hash，记为 `$A6`。**

---

### Task D1: 验收扫描（§15 的十条 + 顺序验收）

**Files:** 无（只跑命令、只读、产出一份验收记录贴在 PR / 交付报告里）

**Interfaces:**
- Consumes：`$A4`（GATE-A 的合并 hash）、`$A6`（GATE-C 的合并 hash）

**Steps:**

- [ ] **Step 1: 验收 5 的计数守卫。** `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` **必须仍为 8**。贴输出。
- [ ] **Step 2: epoch 公式唯一性。** `grep -rnF 'currentOwnerEpoch + 1' src/` 必须仍只有 `ownerController.ts` 一行。贴输出。
- [ ] **Step 3: 六处联动核对。** `cleanupOwnerTransferStagingWithoutMarker` 的 `safeUnlink` 必须是 **10** 个且逐个具名；测试 6c 的 fixture 是 **10** 个；测试 14 机制二是 **11** 个（10 ＋ marker）。三处数字与 §4.3 表、§9 模块表、§13、§15 验收 8 一致。**逐处贴命令与输出。**
- [ ] **Step 4: §11 顺序验收（§15 验收 7）。** 跑「任务分组」一节那三条命令，**三份原始输出都贴**：`git log --merges`、`[ "$A4" != "$A6" ]` + `git merge-base --is-ancestor "$A4" "$A6"`（必须 exit 0）、`git log --diff-filter=A -- src/sweep/sweepRuns.ts`（必须恰好一行，且 `git merge-base --is-ancestor "$A4" "<该笔 hash>"` exit 0）。
  **⚠️ 判据必须能失败才算验收面。** 若发现其中任何一条又变成恒真，**按这条教训重写判据，不要保留一条恒真的命令充数**。
- [ ] **Step 5: L1 §12 十九条核查。** 逐条对照 `docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md` §12；**第 2 / 4 / 5 / 6 / 7 / 15 / 17 / 19 条重点核**（选取依据见 §11 的表），**其余十一条仍然全部适用，不是被豁免**。第 4 / 6 / 17 条必须**引全句**核对，不得截断。
- [ ] **Step 6: 行号引用全仓扫描。** 所有编辑落地之后，扫一遍指向被改文件的行号引用（spec、handoff、注释、测试注释），把失效的就地改成符号锚点。
- [ ] **Step 7: 最终三跑。** 全套件、typecheck、build 三者退出 0，**输出未经任何过滤地贴出**（§15 验收 10）。
- [ ] **Step 8: 写交付报告**（不新建文档文件，写在 PR 描述 / 交接消息里），必须含：
  - 每一条变异实验的注入前/注入后两份原始输出的位置索引
  - **四条未结清风险各自的结清证据**（见下一节）
  - **本层留给 L5 的输入合计 6 项 = 债 2 ＋ §13 具名的 5 笔**（锁可被偷、execute abort 无第二重上界、`writeBoundaryArtifacts` 落在 exclusive span 外「本轮新发现，需重新裁归属」、输家 reconciliation 写的残余 TOCTOU、被拒 run 的无退避重捡）。**这个数字与 §13 的清单联动，改一处必须改两处。**
  - 本层**明写接受**的行为退化清单：`RunHeartbeatStoppedError` 逃出时跳过 `exhausted` / 相位超时原因 / `cleanupAttemptWorkspaceWithStatus` / `cleanupStatus` 回填；停机不消耗配额导致的无限次重捡；「transfer 已发布、reconciliation 缺失」从「连瞬时都不出现」变成一个**真实的瞬时窗口**（该窗口内 marker 必在盘上，恢复覆盖它；次生的 liveness 抖动瞬时且自愈）。

---

## 四条未结清风险 —— 各自在哪个任务的哪个步骤被结清

| # | 风险 | 结清点 | 结清方式 |
|---|---|---|---|
| 1 | **§10 测试 6e 的变异一在今天的代码上不可表达**（`finalizeOrder` 今天只有两项，三项版本正是本层要建的东西；第五轮评审员明说「它是否会红我分辨不出」） | **A9 Step 4** | 该变异**只有在 A2/A3 落地之后才能注入**，所以 A9 排在它们之后。**必须在 A9 内完成注入并贴注入前后两次原始输出**；不红则不许调整断言，**先弄清原因再上报** |
| 2 | **`src/sweep/` 目录不存在**（计划阶段 `find src -iname '*sweep*'` 零结果），§10 测试 12d 的 (i)(ii) 依赖它 | **C1 Step 5 创建目录；12d(i)(ii) 在 C3 Step 5–6** | 计划已把 12d(i)(ii) 放在 C3，**在 C1 建出 `src/sweep/sweepRuns.ts` 之后**。**C1 之前这两条子用例不可能跑**——这一点写进 C1 的 Steps（Step 4 的「确认失败」原因正是 import 失败） |
| 3 | **§10 测试 12d(iv) 的四条 fixture 约束是从读代码推导的，没有构造过并跑过**（第六波自报） | **A8 Step 5** | Step 5 是一个**显式的高风险步骤**：「构造它并证明它到达 abandon 分支」。**不许假设它成立**；构造不出来时要打印实际走到哪一步、与四条约束逐条比对，**然后停下并上报**，不许换成更弱的断言 |
| 4 | **§4.6「`preserveSuccessfulReconciliationIfNeeded` 代码零改动」在 §4.3 处置一落地之后为假**（该函数今天返回 `Promise<ReconciliationRecord>`，没有「不要写」的通道） | **计划阶段裁定三 ＋ A7 全程** | **本计划就地裁定：改 §4.6 那句话，不去为了保住「零改动」把整块判定上移。** 采用判别式联合 `ReconciliationWriteDecision`（裁定二），把改动面写死为「**一个返回类型 + 一个调用块**」，使「变了多少」可判定。**A7 的评审清单里明确要求确认 `preserveSuccessfulReconciliationIfNeededFromArtifacts` 一个字节未改** |

---

## 自查

### 1. spec 覆盖

| spec 节 | 落点 | 缺口 |
|---|---|---|
| §1 目的 / §2 范围与非目标 | Global Constraints「边界与禁令」 | 无 |
| §3 授权立场（三条） | C1 陷阱清单（sweep 自身不新增 writer、但会*导致*写入的完整清单）、C4 测试 14 | 无 |
| §4.0 S-3 退路与禁止的退路 | Global Constraints「S-3 安全阀」、A1/A3 陷阱 | 无 |
| §4.0a 问题 1（恢复要不要负责 reconciliation） | A2（恢复推完三文件）、A3（marker 驱动） | 无 |
| §4.1 / §4.2 九字段 | A4（八字段由 `persistBoundaryAnalysis` 填，`newOwnerEpoch` 由事务内部填；`takeoverPermission` 是对象） | 无 |
| §4.3 新形状（常量 / marker / 三份 pending / 签名 / 暂存顺序 / 组装点 / 赢家 / cleanup / finalize 对称清理） | A1 A2 A3 A4 | 无 |
| §4.3 处置一（读侧收窄 + ENOENT 归因 + abandon 事件 + swallow） | A7（＋裁定一、裁定二） | 无 |
| §4.3 第五波四层通道 | A8 | 无 |
| §4.3 处置二（残余 TOCTOU） | 不修，D1 Step 8 的交接清单第 4 笔 | 无（本层刻意不修） |
| §4.4 finalize 机制（规则 1–4 + 规则 2 可达） | A3 | 无 |
| §4.5 本节修好了什么 | A4（赢家只写 `boundary-analysis.json`）＋ 陷阱（它有非 `src/` 读者） | 无 |
| §4.6 / §4.6a | 裁定三（推翻「零改动」）；§4.6a 的 `grep` 规矩 → Global Constraints | 无 |
| §5.1 / §5.2 / §5.3 | B1（含方案 (a) 与两半硬约束、三处副作用、补 `writeRunState`） | 无 |
| §5.4 | B2（含单一检查点、不消耗配额、adapter 协作式界、「分不清 Ctrl-C 与 OOM」的刻意放弃） | 无 |
| §6 Sweep 触发层 | C1 | 无 |
| §7 CLI 与退出码 | C2 | 无 |
| §8 错误处理汇总 | C3 | 无 |
| §9 模块边界 | File Structure ＋ 各任务的 Files/Interfaces | 无 |
| §10 测试要求（16 处） | 1→A4；2→A5；3→A2；4/4b/4c→A3；4d/4e→A1+A2；5→A3；6→A4；6a→A2；6b→A5；6c→A2；6d→A4；6e→A9；6f→A7；7/7b(含 9)→B1；8/8b→B2；10/11/12b/13→C1；12/13b→C2；12c/12d(i)(ii)→C3；12d(iii)→A8；12d(iv)→A8；14/14b→C4；15→A6 | 无 |
| §11 执行约束 | Global Constraints ＋「任务分组」一节 ＋ D1 Step 4/5/6 | 无 |
| §12 治理与付费调用 | C1（配额语义、N×maxAttempts）、C2（`--max-runs` 必需）、C3（横幅含 N） | 无 |
| §13 继承债与不做的事 | 各任务陷阱清单里的「记账不修」条 ＋ D1 Step 8 的 6 项交接 | 无 |
| §14 后续 | 不落任务（属 L5 / 独立任务） | 刻意 |
| §15 验收标准（1、1a、1b、2–10） | 1→A4 测试 1；1a→A9；1b→A7 测试 6f ＋ A8/C3 的可见性；2→A5；3→B1；4→B2 测试 8b；5→A6；6/6b→C4；7→D1 Step 4；8→A1/A2 测试 4d/4e/6c；9→C1/C2/C3 的 12b/12c/12d/13b；10→D1 Step 7 | 无 |
| §16–§21 修订索引 | 不落任务（历史记录） | 刻意 |

**缺口：无。** 唯一刻意不落任务的是 §14（后续层）与 §16–§21（修订索引），两者都不是本层的实施要求。

### 2. 占位符扫描

逐条搜过，**没有** `TBD` / `TODO` / 「适当地处理错误」/「类似 Task N」/「实现相应逻辑」这类写法。三处曾经接近占位符的地方已就地写死：

- 「abandon 怎么上传」→ **裁定二**给出具体类型与分支形状（不再是「本层不指定实现」）。
- 「ENOENT 归因二选一」→ **裁定一**挑了一条并给了否决另一条的具体失效模式。
- 「测试 12d(iv) 的 fixture」→ **A8 Step 5** 写成一个带失败处置的显式步骤，四条约束逐条列出。

**刻意保留的两处「不给结论」，不是占位符：**

- A9 的两条变异**不给「已验证会红」的结论**——spec 只给注入点与断言形状，前三轮每一轮都在这里宣布过「已解决」并被下一轮推翻。**计划给的是必须执行的验证步骤，不是结论。**
- 各处「N 步 / N 个间隙」的数字**要求实施者从落地后的代码重数并附命令**，不许照抄。这是本仓库四个「附了命令却抄了输出值」案底的处置。

**本计划按规约不附完整可抄的实现代码**——只给类型签名、断言对象、变异注入点与完整测试名。这是本仓库四轮一致验证过的规约（给完整代码效率高，但计划的疏漏会原样落地；给要求，实施者会主动发现并上报计划缺陷）。

### 3. 类型一致性

逐条对过更晚任务用到、更早任务定义的名字：

| 名字 | 定义处 | 使用处 | 一致 |
|---|---|---|---|
| `OWNER_TRANSFER_MARKER_TEMP_FILE` / `OWNER_RECORD_PENDING_TEMP_FILE` / `OWNER_TRANSFER_PENDING_TEMP_FILE` | A1 | A2（cleanup 7→10 的基数）、C4（11 路径清单） | ✅ |
| `writeJsonFileViaFixedTemp(tempPath, targetPath, value)` | A1 | A2（第三份 pending） | ✅ |
| `RECONCILIATION_RECORD_FILE` / `…_TEMP_FILE` / `…_PENDING_FILE` / `…_PENDING_TEMP_FILE` | A2 | A3（finalize 按 `finalizeOrder` 映射）、A9（发布 temp 固定名）、C4 | ✅ |
| `TransactionFileName` / `OwnerTransferTransactionMarker`（v1｜v2 联合） | A2 | A3（解析与分派）、A5（崩溃矩阵） | ✅ |
| `writeOwnerTransferArtifacts(…, reconciliationRecord?)` | A2 | A4（`persistOwnerTransfer` 透传） | ✅ |
| `OwnerTransferMarkerUnreadableError` / `OwnerTransferPendingMissingError` | A3 | A5（崩溃矩阵断言）、C3（前缀路由把它们的逃出归为 `error`） | ✅ |
| `ReconciliationDraft` | A4（`src/runtime/types.ts`） | A4 内部（`persistBoundaryAnalysis` → `persistOwnerTransfer`） | ✅ |
| `PersistedTransferArtifactsRead` / `ReconciliationWriteDecision` | A7 | A8（abandon 分支取 `decision.error`） | ✅ |
| `reconciliation_write_abandoned`（事件类型名字符串） | A7 | A7 测试 6f(ii)(iii)、C3 的 `note` 行 | ✅ 三处逐字相同 |
| `writeBoundaryArtifacts(runDir, artifacts, options?)` 第三参 `{ onReconciliationWriteAbandoned?: (detail: string) => void }` | A8 | A8 的 12d(iii)、C3（回调=数组 push） | ✅ 回调签名三处都是 `(detail: string) => void` |
| `RunLoopFromStateOptions` | A8 建（`onReconciliationWriteAbandoned?`） | B2 加 `stopRequested?` | ✅ 同一个类型加键，不是新类型 |
| `ResumeLoopOptions` | A8 建 | B2 加 `stopRequested?`；C1 加 `onAdopted?` | ✅ 最终形状 `{ onReconciliationWriteAbandoned?, stopRequested?, onAdopted? }`，与 §9 模块表一致 |
| `RunHeartbeatStoppedError`（`readonly stopReason = "heartbeat_stopped"`） | B1 | C3（outcome `interrupted` 的两个来源之一） | ✅ |
| `StopRequestSignal` / `createStopRequestSignal()` | B2 | C1（`SweepOptions.stopRequested`）、C2（`registerStopHandlers`） | ✅ |
| `SweepOptions` / `SweepDeps` / `sweepRuns(options, deps?)` | C1 | C2（`main` 调用）、C3（格式）、C4（真实 `resume`） | ✅ |
| `createAdapter: () => RuntimeAdapter` | C1 | C2（闭包由 `main` 构造） | ✅ |
| `registerStopHandlers(signal, options?): () => void` | C2 | C2 测试 13b | ✅ |

**Amended 2026-08-05：上表 `writeBoundaryArtifacts(runDir, artifacts, options?)` 第三参那一行「使用处」格里的「C3（回调=数组 push）」已被人裁推翻 —— C3 侧的回调是**当场 `options.stderr(...)`**，不是数组 push。读作「C3（回调=当场写 stderr）」。** 这纠正的是*本计划*的缺陷，不是实现的缺陷。**该行的 `✅` 与它的判据不变、且仍然成立**：这一行核对的是**回调签名**在三处是否逐字相同（`(detail: string) => void`），而签名与回调体把记录落到哪里**一个字都不相干** —— 被推翻的是括号里那句对**回调体**的描述，不是这一行的一致性结论。**特意点明**：不要因为这句括号被推翻就去改那个 `✅`，那会把一条成立的一致性结论误标成不一致。完整理由见本计划 `### Task C3`「落点」一节的 `Amended 2026-08-04`。

**发现并就地修掉的一处不一致**：spec §5.4 写「信号作为**第七个位置参数**」、§4.3/§9 写「**不新增位置参数**，搭同一个可选参数对象」。本计划采用的形状（第七个位置参数**是一个对象**，B2/C1 往里加**键**）**同时满足两种读法**，已在 A8 的 Interfaces 里就地写明。

---

## 我不确定的地方（明说）

1. **A8 Step 5 的四条 fixture 约束可能是错的。** 它们是第六波从读代码推导出来的，**从未被构造过并跑通**。我在计划阶段没有构造它（那需要写测试代码，超出计划阶段的范围）。**若它们不成立，12d(iv) 就没有可行的驱动路径，而 12d 的另三条子用例全部绕开中间三层。** 这是本计划最可能崩的一处，已写成带失败处置的显式步骤。
2. **A9 变异一是否真的会红，我不知道。** 前三轮为它写的四条变异实测都不红。本计划照第四/六波的形状写了注入点与断言对象，但**没有验证过**——三项 `finalizeOrder` 今天不存在。
3. **A5 测试 2 的间隙数**（try 前 4 次解析 ＋ try 内若干步）里，「try 内 13 步」是 spec 按设计推出来的 v2 专属数字，**代码里今天没有 13 这个数**。我要求实施者重数，但我无法预先确认重数结果就是 13。
4. **组 B 排在 A 与 C 之间是我的判断，不是 spec 的要求。** 理由（可选参数对象只有一个作者）我认为成立，但如果有人要并行 A 与 B，§11 并不禁止——只是要自己解决同一个类型被两个分支各自定义的合并问题。
5. **`createAdapter` 做成闭包是我为了同时满足「adapter-config 读取失败不扫描」与「横幅在 adapter 构造之前」而选的形状。** spec 两处要求都在，但没有说怎么同时满足。**若实施中发现更简单的形状（例如把横幅的位置约束放宽），要按 Rule 7 挑一个并说明，不要两边都留。**
6. **A6 的八条 fixture 我没有逐条验证过「其余七条判据全部通过」是否真的可构造**——特别是第 6 条那组「owner epoch 跑到 transfer 前面」的手工 fixture，它在生产中不可达。spec 说这没关系（测试 15 钉的是语义不是可达性），我采信了这个判断，但没有实际构造过。
7. **Token 预算：本任务显著超出 CLAUDE.md Rule 6 的每任务 12,000 token 上限**（读完 3015 行 spec ＋ 核对代码 ＋ 写出这份计划）。**按 Rule 6 与 Rule 12 主动上报，不静默超支。** 若要压回预算，唯一的办法是把「读完整份 spec」这一步拆成多次会话，而那会牺牲 §10/§15 的交叉引用一致性。
