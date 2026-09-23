# SDD ledger — plan: docs/superpowers/plans/2026-09-23-ls-lock-visibility.md

Spec: `docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md`（已读，binding authority）。

⚠️ **本文件是 SDD ledger，与同目录的 `progress.md`（本仓库的轮次台账，铁律 4 下只追加不改）分开。**

## 开工前的裁决

- **Ruling: 在 `main` 上实施，不开隔离 worktree** —— skill 要求隔离 worktree，但 ccloop 铁律 1 把
  「删 worktree」列为需人单独授权、Tier 0 闸门会机械拦下，且历轮（含刚完成的 I-2，其控制器裁决 1）
  都直接在 `main` 上落本地提交。CLAUDE.md 优先（Rule 11：conformance > taste）。
  **若错的代价**：人要手工整理 main 上的一串提交（可逆，`git reset` 到 spec 那一笔即可）。
- **Ruling: SDD ledger 另起文件** —— `progress.md` 这个路径已被本仓库的轮次台账占用，
  而铁律 4 规定那里的历史一个字不改。**若错的代价**：下一个 SDD 控制器要多看一个文件名。
- **Ruling: 实施席与评审席都用 sonnet，最终全分支评审用 opus** —— skill 说「计划正文含完整代码 ⇒
  用最便宜档」，但本仓库要求变异电池、字节纪律、未过滤整份读回，cheapest 档在多步纪律上翻车成本更高。
  **若错的代价**：比最优解多花一些钱。

## 预检冲突扫描（**逐行写出检查了什么**）

### A. 共享文件／接口的任务对

| 任务对 | 一方产出 vs 另一方消费 | 发现 |
|---|---|---|
| T1 → T2 | T1 产 `classifyProcessLiveness`／`LivenessVerdict`；T2 在红线函数消费 | 一致 |
| T2 → T3 | T2 产 `OwnerTransferLockLivenessUndeterminedError`；T3 在三处闸门消费 | 一致 |
| T2 → T4/T5/T6/T7 | 同一个错误类被四处消费 | 一致 |
| T3 ↔ T4 | 都改 `runLoop.ts`（`:761` vs `:927`／`:1745`） | **T3 的编辑会移动 T4 的行号** ⇒ 见裁决 C |
| T3 ↔ T5 | 都改 `resumeLoop.ts`（`:75` vs `:225`／`:256`） | 同上 |
| T2/T3 ↔ T7 | 都改 `fileStore.ts`（`:1040`／`:1128`／`:1396`／`:483` vs `:1568`） | 同上 |
| T8 → T9 | T8 产 `ReportedScanRow`／`ReportedRunRow`；T9 在渲染层消费 | 一致 |
| T8 → T10 | T10 消费 `attachLockInspections`／`defaultLockRowDeps` | 一致 |
| T9 → T10 | T10 调 `toScanResult(await attachLockInspections(...))`，需要 T9 已放宽类型 | **顺序必须 T9 先于 T10** —— 计划顺序已满足 |
| T11 ← 全部 | ERRATUM 要引用最终落地的行为 | 计划已把它排在 T10 之后 |
| T12 ← 全部 | 变异总账汇总 | 排最后 |

- **Ruling C：行号一律现测，brief 里的行号只是锚点。** 依据：Global Constraints 已写
  「引用前必须重测」，且本轮 spec 自审实测 7 个锚点错了 3 个。
  **若错的代价**：实施席改到没坏的代码 —— 由每 Task 的评审席与变异电池兜。

### B. 每个任务自身是否自洽

| 任务 | 它写的判据 vs 它写的代码 / 它建的文件 vs 它后面碰的文件 | 发现 |
|---|---|---|
| T1 | 判据 import `classifyProcessLiveness`，Step 3 定义它；结构判据读 `fileStore.ts` 源码 | 自洽 |
| T2 | 判据 import 新错误类，Step 3 定义它 | **未核：`fileStore.test.ts` 是否已 import `makeRunDir`／`stat`／`join`／`writeFile`** ⇒ 见裁决 D |
| T3 | 计划**自己指出**那条判据的形状有风险（`pid:0` 不发 syscall ⇒ 数不到重试），并给了探针与降级路线 | 自洽（已预告） |
| T4 | 判据文件在自审中**已从 `runLoop.integration.test.ts` 改正为 `leaseLifecycle.integration.test.ts`** | 已修 |
| T5 | 夹具 `createRepo`／`createContract`／`seedEligibleRun`／`ScriptedAdapter`／`successFrame` | 现测存在（`:319-332`） |
| T6 | 夹具 `seed`／`record`／`startLeaseHeartbeat`／`readEventTypes`／`LEASE_HEARTBEAT_INTERVAL_MS` | 现测存在（`:327-345`） |
| T7 | seeding 指向该文件里钉 unattributable 逃逸那条的现有夹具 | 自洽（指代明确） |
| T8 | 新建文件 ＋ 新建判据，零既有依赖 | 自洽 |
| T9 | 七条判据里**正文只写全 2 条**，其余 5 条的字面量在 spec §3.5 | ⇒ 见裁决 E |
| T10 | 判据 3 明确要求被测对象是 `main(["ls", ...])` 而非 `scanRuns` | 自洽 |
| T11 | 扫描器自带必抓/必不抓自测 | 自洽 |
| T12 | 脚本自带必抓/必不抓自测 | 自洽 |

- **Ruling D：`fileStore.test.ts` 缺的 import 由实施席自行补。** 给一个测试文件加 import
  **不是「改既有判据」**，不触发人裁 88。**若错的代价**：无（typecheck 会立刻报）。
- **Ruling E：T9 的另外 5 条判据照 spec §3.5 的字面量写，dispatch 里把 spec 路径一并给实施席。**
  依据：那 5 条与已写全的 2 条**形状相同、只有字面量不同**，而字面量在 spec 里是逐态写死的。
  **若错的代价**：某一态的渲染字面量写偏 ⇒ 由该态自己的删除式变异兜住。

### C. 计划是否强制了评审规则视为缺陷的东西

- 逐条看过：没有「断言什么都不断言的测试」，没有「逐字复制一整块逻辑」。
  T9 的七条判据是**同形不同值**，不是复制逻辑块。**无冲突。**

---

## 执行记录

## Task 1

- BASE `91bd1ed` → HEAD `c186195`。实施席 sonnet，状态 DONE。
- 实测 `58 files / 784 tests`（+2 文件 / +5 判据），2 failed，失败集 = {stopProof leader-exit, SubprocessClaudeAdapter close-pending} ⊆ 允许的 7 条（按名字核）。typecheck RC 0。
- 四条变异 M1-1..M1-4 全部在 `git clone --local` 副本里跑过，sha256 前后不等，红被看见；主树 sha 前后相等。
- **Ruling F：实施席用自己模型的 Co-Authored-By 是对的**，后续 brief 不再写死归属行。
  依据：那笔提交的作者确实是 Sonnet 席，写成 Opus 是假话。**若错的代价**：本轮归属行不统一（不许 amend，最终报告里列给人）。
- **Ruling G：M1-3 的红预言写错在控制器（计划）一侧，不是实施缺陷。**
  预言「dead ＋ alive 两条红」，实测是「dead ＋ 越界 pid 两条」——`alive` 那条结构上进不了被变异的 `catch`。
  实施席手工追踪代码路径捞回，未改任何判据。**若错的代价**：无（已现测纠正）。
  ⇒ **这是「防假预言」那条教训的第 N 次兑现：预言要在脑内把变异跑到底，问「X 之前有没有别的断言先炸／这一支走不走得到」。**
- 评审席（sonnet）判 **Needs fixes**：0 Critical / **1 Important（plan-mandated）** / 1 Minor。
  Important：结构判据只在 `import ` 与模块路径**同一行**时才捕获；多行 `import {` 是本仓库既有写法，
  一个换行就能让值导入**静默绕过守卫**，而 M1-4 只测了单行那种 ⇒ **变异电池给的是假信心**。
- **Ruling H：该 Important 成立且承重，必须修。**
  依据：spec §4.1 存在的全部理由就是「那个环不许重开」；一个被普通换行绕过的守卫，正是本仓库反复栽的
  「扫描器没在做它声称的事」（本轮 spec 自审刚栽过一次：`grep` 配 `$'\x00'` 在 NUL 处截断）。
  **缺陷在【计划】一侧，不是实施席** —— 那段判据代码是计划逐字给的。
  **若错的代价**：几乎没有，收紧解析是纯加法。
- ⚠️ 评审席提的 ⚠️ 项已现测核实：`c186195` 的归属行是 `Co-Authored-By: Claude Sonnet 5`，与 Ruling F 一致。
- Minor（记录，不进修复轮）：`sdd-ledger.md` 随 `c186195` 一起进了提交 —— 是控制器先 `git add -f` 的，实施席只是没 unstage。无害。
- Task 1: fix round 1/5 —— 实施席（resume，sonnet）改用 `importStatements()`（`/^import\b[\s\S]*?;/gm`）
  把整条 import 语句拼起来再判，`import type` 豁免作用在拼接后的语句上；加了**反向对照**
  （对 `fileStore.ts` 真实存在的多行 `../runtime/types.js` 类型导入必不误报）＋ 一条 anti-vacuity
  （证明拼接确实跨了换行）。新变异 **M1-5**（多行值导入）**被看见红**，M1-4 在同一副本里重跑仍捕获。
  覆盖判据 6/6 绿，RC 0。提交 `6a3fbab`。
- ⚠️ **评审席报的「206 处多行 import」不准** —— 控制器现测 `^import {$` 在 `src/` 下是 **15 处**
  （命令 `/usr/bin/grep -rn "^import {$" "--include=*.ts" src | wc -l`）。**结论不变**：那 15 处正好落在
  Task 3–6 要改的 `runLoop.ts`／`resumeLoop.ts`／`leaseHeartbeat.ts` 里，缺陷是现实的。
  ⇒ 又一次兑现「评审员的数字要自己核」。
- ⚠️ 顺带踩到一次 `zsh` 吃掉无引号 `--include=*.ts`（整条命令 exit 1、输出为空，看起来像「零命中」）。
  **加引号后才量到真值。** handoff §7.3 那条，实测再次成立。
- Task 1: fix round 2/5 —— 复审席确认 round 1 的 Important 已 ADDRESSED，但在修复 diff 里发现**新的 Important**：
  拼接正则 `/^import\b[\s\S]*?;/gm` 在**第一个 `;`** 处截断，续行 `//` 注释里的分号即可绕过。
  **Ruling I：控制器独立复现成立**（带注释分号命中 0，去掉注释命中 1）⇒ 进 round 2。
  修法用本仓库既定手法：**先剥注释再拼语句**（Orca handoff §六.4：「扫描器也不许对自己的警告文字报警（先剥注释再判）」）。
  提交 `b5fe3f5`，新增 `stripComments()`（尊重字符串／模板字面量，保留换行给 `^import` 锚点）＋ 变异 M1-6，
  覆盖判据 8/8 绿。
- ⚠️ **控制器自己另跑了一组对抗样本**（脚本在 scratchpad，不碰仓库）：
  6 条必抓（多行＋注释分号／命名空间／默认／副作用／混合 `type`+value／块注释内分号）
  ＋ 4 条必不抓（type-only 多行／整块被块注释／注释提到路径／被行注释掉的 import）—— **10/10 全过**。
  ⇒ 这一条不再是「评审说它对」，是**量出来对**。
- Task 1: fix round 3/5 —— round 2 的复审席确认注释分号缺陷**真的修好了**（stripComments ＋ M1-6 红证 ＋
  M1-4／M1-5 重验 ＋ 真文件上的必不抓通过），但抓到**一条空判据**：
  新加的「注释只是提到 `../unlock/` ⇒ 必不抓」那条，**把 `stripComments` 整个换成恒等函数它照样绿**
  （`^import` 锚点本来就够不着以 `//` 开头的行）。
- **Ruling J：成立，进 round 3。控制器机械验过**（脚本在 scratchpad）：
  现有输入 `0 → 0`（判据看不见该变异）；强化版输入（把该提及放进**真 import 的续行注释**里）`0 → 1`（会打红）。
  ⇒ 已把验证过的确切输入直接给实施席，省一轮试错。新增变异 **M1-7**（`stripComments` 换恒等函数）。
- 复审席另提两条 `stripComments` 的潜在假阴性（转义斜杠后接 `*` 的正则字面量；模板字面量嵌套不感知）——
  **控制器裁定不追**：两条都经手工追踪确认**对 `fileStore.ts` 今天的内容不产生假阴性**，
  而这个 helper 只读这一个文件。⇒ 要求在代码注释里各记一句已知限制，不改实现。
  **若错的代价**：将来有人把这个 helper 挪去读别的文件时要先看那两句注释。
