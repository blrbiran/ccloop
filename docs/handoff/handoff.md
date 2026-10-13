# ccloop Handoff — OMP 支线已合并推送；下一件是 Codex 429 临时失败（见「仍然挂着的」）；Orca 关联见文末单节

> ⚠️ **一律自查，别信本文。** 只有两个门锚点 `e42e062`（GATE-PKG3）与 `86d3bd6`（GATE-PKG2）是固定历史值。
> *** **本文不写任何当前哈希** —— 指代某一笔引**提交主题行**（`git log --grep`），指代材料引**路径**。 ***
> 本文是活文档（2026-10-13 整篇压缩重写，会话 `808feb6a`）。压缩前全文：`c=$(/usr/bin/git log --format=%H -n1 --grep='docs(handoff): condense ccloop handoff' -- docs/handoff/handoff.md); /usr/bin/git show "$c^:docs/handoff/handoff.md"`。
> **铁律的权威副本是 `CLAUDE.md` Rule 13–18**；本文只补 CLAUDE.md 没写的东西。

---

## 先跑这些，以输出为准

```bash
cd /Users/biran/code/skills/orca/ccloop          # 2026-10-13 起的新路径；/Users/biran/code/skills/loop/ccloop 已不存在
git merge-base --is-ancestor e42e062 main && git merge-base --is-ancestor 86d3bd6 main; echo $?   # 期望 0
git ls-remote origin refs/heads/main              # 开工一次、收尾【必须】再一次 —— 人会自己推远端
git status --short; git worktree list; git branch -vv
export ECC_GATEGUARD=off DISABLE_OMC=1
which node; node --version                        # 期望 nvm 的 v22.13.1 在前（见「环境」）
rtk proxy npm run typecheck; rtk proxy npm run build
./node_modules/.bin/vitest run --reporter=json --outputFile=<scratchpad>/vitest.json > <scratchpad>/vitest.log 2>&1; echo $?
node scripts/check-known-reds.mjs <scratchpad>/vitest.json; echo $?   # RC 0 才算基线绿
```

- *** **测试条数、红名单长度都【现测，不信任何文档里的数】。** *** 名单住在 `scripts/check-known-reds.mjs`
  （按全名、在祖先边界做子集判定；文件头的 ERRATUM 链记录了名单怎么增删的）。
- ⚠️ **判断远端只能 `git ls-remote`**；`git status` 的 `ahead N` 是缓存 ref。结果只在跑出来那一秒为真。
- ⚠️ *** **rtk 过滤层会骗你**：`git status --porcelain` 空时打印 `ok`，`git diff | wc -c` 把 0 报成 1，长 grep 截成「[+N more]」，
  含括号的正则报错。还原证明／字节比较一律 `rtk proxy … > 文件` 再 `cat`／`wc -c`。 ***
- ⚠️ **`git clone --local` 副本必须先 `npm run build`**（`dist/` 被 gitignore，否则 `endToEnd.test.ts` 以 `ENOENT … dist/cli.js` 假红）；
  副本建在**会话 scratchpad** 下（人裁 137）；变异与全量一律 `cd` 进副本再跑（按 cwd 找夹具的判据在别处会假红）。

## 环境（2026-10-13 现测）

- `/opt/homebrew/bin/node` **坏的**（缺 libsimdjson）；nvm Node 22.13.1 在 PATH 最前；`/usr/local/bin/node` 是 24.13.0。
  OMP 相关判据曾因 PATH 上的 node 不同而行为不同 —— 已由下面的授权改写去依赖。
- 本机 `rm`、`cp` 是 `-i` alias：`rm -rf` 会**静默挂在确认提示上**，`cp` 会**静默拒绝覆盖** ⇒ 用 `/bin/rm -rf`、`cat src > dst`。
- *** **Orca 的 Tier 0 闸门已生效**：本机 agent 会话里的 合并进 main／push／删分支或 worktree **被机械拦下**（clone 里的 `git pull` 也会被拦，
  要新版本就重新 `clone --local`）。这几件**由人在自己终端里做**，agent 只列命令。 ***
- **Codex CLI 额度已用尽**（人，2026-10-13）：现在跑不了真 Codex。OMP 用的 LiteLLM 端点已停。本会话**零真实 provider 调用**。

---

## 当前状态：OMP 支线已由人合并进 main 并推送、分支与工作树已删（2026-10-13 晚）；下面保留为它们的内容记录

1. **`codex/codex-strict-output-wire`** —— `fix(codex): send strict execute result schema`（＋`docs(handoff): roll Orca OMP line in place`）。
   起因：真实 Codex 在 execute 因 provider strict schema 要求 `taskResult` 在 `required` 而失败；修为 complete／partial × 有／无报告的严格候选，
   业务解码仍允许报告缺席。当时全量 1602/1602 零跳过、真 Codex API 探针接受新 schema —— **那是这条分支自己的数，不覆盖后两条**。
2. **`codex/omp-agent-integration`**（已 rebase 到 1 之上）—— OMP 安装（只收绝对二进制）／每机模型发现与精确解析（不写死本机模型名）／
   更新保护／独立 plan・execute・verify adapter（禁扩展、审计事件与 input/output/cache 用量；execute 拒绝 OMP 自行提交，
   `--no-renames` 计重命名两端）。设计／计划在 Orca：`docs/superpowers/specs/2026-10-12-oh-my-pi-agent-integration-design.md`、
   `docs/superpowers/plans/2026-10-12-oh-my-pi-agent-integration.md`。
   *** **人按 Rule 15 于 2026-10-13 指名授权的两笔判据改写**： ***
   - `test(agents): rewrite the claude/codex-only kind criteria to include omp`
   - `test(omp): make two criteria independent of PATH's node and omp probe time` —— ompPhase 超长流的假进程包进 async IIFE
     （Node 22 把它当 CommonJS 解析）；`updates.test.ts` 的「observes without writing…」超时放到 20 s（探测 omp 本身约 5 s）。
3. **`codex/omp-skills`**（叠在 2 之上；工作树 `/private/tmp/ccloop-omp-agent-20261012`）——
   `feat(omp): list Orca's frozen skill snapshot to every OMP phase` ＋ `test(omp): refuse a missing ompSkillsDir at accept`。
   - 新 work 字段 **`ompSkillsDir`**（协议 3 与 4），与 `skillPluginDir`／`codexSkillsDir` 互斥；非 omp kind 在 accept 被拒为 `skills-unsupported-agent`。
   - OMP 仍带 `--no-skills`／`--no-extensions`；ccloop 在各阶段私有 system prompt 末尾追加 `<skills>` 块（名字、≤1024 字符的一行描述、SKILL.md 绝对路径）。
     快照无效 ⇒ spawn 前失败 `omp-skills-source-invalid:<detail>`。
   - 新的可复用夹具 **`tests/fixtures/fake-omp.mjs`**。12 条变异在副本里全红（基线定向 20/20，还原 0/0 字节）。
   - 设计：Orca `docs/superpowers/specs/2026-10-13-omp-skill-injection-design.md`。

### 全量证据（分支 2，omp-skills 之前；原生跑，重定向到文件读回）

- 两笔授权改写之后三次全量：1632/1639（7 红）、1635/1639（Node 24 在前）、1635/1639（Node 22，第二笔改写后）。
- 每个红文件单独重跑 3/3 绿：verifySavedResult、codexAdapter、codex adapter、cli parseArgs、savedResultRecovery.native（后者是 dist 重建竞态）；当时负载 10–33。
- 🔴 *** **`ompUpdates` 的「preserves the unavailable reason…」单独跑 3.1–3.3 s，负载下超时过一次 —— 【不在人的授权里，没改】**，待人决定是否指名。 ***
- **分支 3 顶上的全量**（2026-10-13，本机同时有别的会话，负载 6–25）：typecheck／build 过；全量 1655/1659，4 红 —— `cli` parseArgs 超时、
  `savedResultRecovery.native`（dist 重建撕裂读）、`codexAdapter` watchdog 单独各 3/3 绿；`ompUpdates`「preserves…」单独负载 10–12 下 2/3 红（6.4 s，放宽超时 5/5 绿，**未改**）。
  `verify:control`（只含 fake codex `integration` 的表，`ORCA_CCLOOP_BIN`＝本构建）805/806，唯一红 `extractFinalObject` 3 s 性能阈值（3.16 s，负载 13），单独 3/3 绿。
  没跑 `check-known-reds.mjs`（名单未含 OMP 新测试，跑之前先核名单）。
- 不要称「全绿」：上面的红是按文件隔离归因的，没有逐条过 `check-known-reds.mjs`。

### 待人做的

- 上一轮的 ff／push／Orca repin／删分支与工作树：人已于 2026-10-13 晚做完。**还剩**一条失效工作树记录 `/private/tmp/orca-results-ccloop-20261010`（`git worktree list` 现测仍在；`.git` 指旧仓路径，提交已在 main）⇒ `git worktree prune`，不行就 `git worktree remove --force`。

---

## 仍然挂着的

| 挂账 | 现场 |
|---|---|
| **OMP 单次调用（estimate／clarify／split）不提供** | `singleCallExecution` 对 omp 恒 `null`：OMP 18.10.1 没有每次调用的输出 token 上限（catalog `maxTokens` 只在 pi-ai `resolveOpenAIOutputTokenParam` 条件满足时才发），且 OMP 会自动重试瞬态错误 ⇒ 不满足本仓 §4.4 契约。证据在上面 omp-skill-injection spec §4。**待人复核这个决定** |
| **OMP 其余延期项** | OMP 子代理、交互式审批桥、omp 的 saved-result 恢复（目前仅 codex）；OMP skills 与 OMP 本体的**真实 provider 验收**（端点已停、额度耗尽）。Git 忽略文件与主机副作用不在 execute 检查范围 |
| **`ClaudePhaseAborted` 历史交错（B4）** | runner 重复发布竞态与无效答案中止分支已修；精确的历史交错**仍未证成** ⇒ 不能据此宣称真实 provider 稳定性。详见 Orca handoff |
| **Codex 429 临时失败（外部测试反馈 45–50）** | 现状：codex 非零退出一律 `codex-exit-error`，`src/controller/runLoop.ts` 的 `PhaseExecutionError` 分支直接 `failed`，无分类无退避；「尝试 1/3」不会开第 2 次；`--ephemeral` 仍在。真实样本 `/Users/biran/code/skills/orca/orca_archived_files/recommendations-{1,2}-events.jsonl`：4 行，`turn.started` 后**零 `item.*`**，`error`／`turn.failed` 的 message 为 `exceeded retry limit, last status: 429 Too Many Requests`。**人裁（2026-10-13）**：做「识别 429＋阶段内有限退避」，不去 `--ephemeral`、不做会话续跑／多 provider；**零 item 即 429 失败的那次调用用量记 0**（条件之外仍 null）。控制器建议（未裁）：只在零 item 时重试，有 item 的只改报 `codex-rate-limited`；5xx 无样本不承诺。先写 spec 再 TDD；改既有判据要人逐条点名。完成后可用 `gpt-6-luna` 做一次真 Codex 回归（本机 codex-cli 0.160.0 下 2026-10-13 探针可用；付费，先问人） |
| **`capabilities` 计算化** | 人裁「分两步」的第二步。今天三个 kind 的 `requestBoundProof` 都恒 `null`（`src/agents/{claude,codex,omp}.ts`）|
| **Linux** | ccloop 整套在 Linux 上历史上红 5 条；之后只在临时 Ubuntu VM 上跑过 `/usr/bin/flock` 两进程串行（过），**整套未再在 Linux 跑过**。VM 已停，要人开 |

---

## 本仓规则的补充（CLAUDE.md 没写、但仍有效）

- **改既有判据前先想「能不能只加不改」**（人裁 119 就是这么绕开改判据的）；**跨 Task 的红证要在两个 Task 都落地后真的重跑一次**。
- ERRATUM **优先放在整个注释块末尾**；**点名，不要计数**（曾写「三格中的两格」，实测三格全部）。
- 删副本前做「副本判据文件 vs 工作树判据文件」字节比对。
- 改代码／注释按**整行锚点 ＋ 断言命中数 == 1 否则退出**；子串 replace 会在句中切开段落。
- 人裁 125 引用时引它本身（人主动开例，不是人裁 100 的适用）；人裁 100 的收口条件是「连续两轮 0 Critical 且 Important 全是文字准确性」，人主动指名要审时不适用。
- skill 与 CLAUDE.md 冲突时 CLAUDE.md 优先；`executing-plans` 要隔离 worktree，但删 worktree 需人授权。

## 方法论（历轮攒下的，压缩保留）

1. *** **一条判据在被【看到】打红之前，它不是判据。** *** 每新增一个分支，点名删掉【它自己】的那条变异并确认看见红；
   「没跑过的那条变异」不是证据，评审员也发现不了它。**代码改了以后，之前跑过的变异要重跑。**
2. **「红在哪条断言」不可靠** —— 前面的断言（甚至 strict schema）会先短路；要量 `toEqual` 本身就单独打它的变异。
3. **断言的【位置】和文字一样承重**：排在被测调用之前、读回测试自己刚写的值的断言永远不会红。钉「什么都没发生」的判据必须配一条正向观测。
4. **一个变量同时被判断又被展示** ⇒ 任一端规范化会静默解除另一端守卫。拆成两个变量；判别法是删掉新守卫看行为变不变。
5. **护栏自己有盲区，盲区看起来和「通过」一样** ⇒ 补护栏先写一条打它盲区的变异。扫描器要有必抓／必不抓两组样本并跑到收敛。
6. **探针没验证前，输出不是证据**（macOS 无 `timeout`；`awk length()` 数的是字符；`clone --local` 只克隆已提交状态）。扫控制字节用 python 读字节，不用 `grep $'\x00…'`（NUL 截断 ⇒ 命中每一行）。
7. **一条先例不要外推**；两类事件碰撞本身就是「不可互换」的证据（人裁 119）。
8. **注释轮先做全树扫描，扫描清单从被更正的句子机械导出**，且覆盖语料的语言（英文词对中文活文档零命中）。半改比不改坏。同一笔里的两处注释会互相打脸，写完做对照。
9. **在「关闭某类缺陷」的那一波里顺手多修一处，正是新引入该类缺陷的地方** ⇒ 看见了就报，不顺手修。
10. 拿 rejection 用 `.then(onFulfilled, onRejected)`（onFulfilled 里 throw），不用 `.catch(e => e)`；`vi.resetModules()` ＋ 动态 import ⇒ `toBeInstanceOf` 用动态模块实例上的类。
11. 评审员的自陈要核，控制器自己的数更要核；spec／plan 的自查真能抓硬错，别跳过。
12. 负载 flake 的判别：是否超时、总耗时是否异常、单独重跑那个文件 —— 再说是不是回归。修 flake 前先在负载下复现。

## 材料索引（引路径，不重新推导）

- 各轮唯一进度源：`.superpowers/sdd/<日期-主题>/progress.md`（**历史一字不改**，CLAUDE.md Rule 16；该目录 `.gitignore` 是 `*`，新产物要 `git add -f`）。
  最近一轮落在本仓的是 `2026-10-08-codex-phase-output-hardening/`；人裁 10–126 在 `2026-08-07-pkg2-data-loss/progress.md`，人裁 139 在 `2026-10-02-crash-resume-and-orphan-reaping/progress.md`。
- 设计／计划：`docs/superpowers/specs/`、`docs/superpowers/plans/`；OMP 两份在 Orca 仓（见上）。
- `README.md` 从源码写、quickstart 实跑过；改它前先现测。
- 成本、预算：只报工具给出的数，单位口径见 CLAUDE.md Rule 6。大动作（派评审、跑真 provider、动 Linux）前先跟人报。

---

# 📌 Orca 那条线（单节滚动 —— 每轮【就地替换】本节，不新增 Orca 章节；2026-10-13 晚，Orca 会话 `6b7843ec`）

- 详情只看 Orca：`/Users/biran/code/skills/orca/Orca/docs/handoff/handoff.md` §3.3 与 §4.2 第 0／0b 条。
- 本仓 OMP 三条分支已合进 main 并推送、分支已删；Orca 已 repin 到本仓那次合并后的 main（Orca `package.json` 现核）并从新路径重装面板服务。
- 下一件落在**本仓**的活是 429（见上表「Codex 429 临时失败」一行）；Orca 侧对应的未知用量死路由 Orca 自己的 D 处理，本仓不动。
