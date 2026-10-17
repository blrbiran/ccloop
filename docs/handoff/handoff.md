# ccloop Handoff — 「每个 agent 都能跑需求链」一轮（目录文件缓存、`agents models`、codex 软单次调用、claude 200000）已在 main（人已合推，Orca 已 repin）；attempt 提交关钩子与 OMP single-call 也在 main；Orca 关联见文末单节

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
- 真 Codex：`gpt-6-luna` 在本机 codex-cli 0.160.0 下可用（Orca 会话 `6b7843ec` 2026-10-13 探针），**付费，每次先问人**；别的 Codex 模型额度已用尽。OMP 用的 LiteLLM 端点人已于 2026-10-14 重新起来（OMP 真跑同样付费、先问人）。Orca 会话 `b39a5527` **零真实 provider 调用**。

---

## 当前状态（Orca 会话 `a852f96a`，2026-10-15～16）

- ✅ **已合推**（Orca 会话 `4de777f4`，2026-10-17 `ls-remote` 现核）：分支 `codex/every-agent-chain` 已由人 `--ff-only` 合进 main 并推；Orca 已 repin 到它（主题行 `chore(deps): repin ccloop to 02cbacc…`，repin 门过）。其后 main 上多一笔名单：`test(roster): add the outer-watchdog load flake to the known reds (ERRATUM)`（人裁只加 `codexAdapter`「outer watchdog kills…」，`verifySavedResult`「r1 command interruption…」不加：下次红先按 `systematic-debugging` 在 clone 里查）。依据：Orca spec `docs/superpowers/specs/2026-10-15-every-agent-requirement-chain-design.md`（**末尾 §11 优先于正文**）＋计划 `docs/superpowers/plans/2026-10-15-every-agent-requirement-chain.md` Task 1–9；台账在 Orca 仓 `.superpowers/sdd/2026-10-15-every-agent-requirement-chain/progress.md`（已在 Orca main）。
- **分支内容**（按主题行）：
  - 夹具：`test(fixtures): fake codex and omp answer and count catalog probes`。
  - **目录与 `--version` 的文件缓存**：`feat(agents): cache file for agent catalogs, keyed by binary and config stamps`、`fix(agents): stamp the config files omp actually reads for a named profile`、`feat(agents): read every catalog and version through the file cache`。`$CCLOOP_CACHE_DIR`（缺省 `~/.cache/ccloop`），0700／0600 显式给，键含二进制与配置 stamp，30 分钟；版本号也缓存（人裁 Orca 计划第 8 条）；检测、`agents validate`、`updates.ts` 的版本探测与 Apply 复核**按设计保持实时**。
  - 探测进调用方时限与 abort、失败报阶段：`feat(agents): catalog probes honour the caller's deadline and abort and name their stage`、`fix(omp): the spawn-time re-check and the single call share one deadline` ⇒ 上一版「spawn 时目录探测（10 s）不在调用时限与 abort 内」**已在本分支修**。
  - `control models`／`agents models [--refresh]`：`feat(control): list an installation's models (control models, agents models)`；`test(agents): every test file gets an empty CODEX_HOME; agents models --refresh re-probes`（**夹具改动**：`tests/setup/relocateCatalogCache.ts` 给每个测试文件一个空 `CODEX_HOME`，否则判据读到人的真 `~/.codex/config.toml`）。
  - codex：`feat(agents): codex resolves a soft single call and its catalog window`（`singleCallExecution: "v1-soft"`，窗口取 `codex debug models`）；`feat(runtime): codex single call, tools off in a private home, bound checked after the fact`；修：`fix(runtime): codex single-call home refuses symlinked dirs, never deletes a regular credential`（正规文件挪成 `<名>.displaced-<epoch ms>`）、`fix(runtime): codex single call allows codex's error items and turns off the linked MCP servers`、`fix(agents): list codex MCP servers under the single call's own isolation; a failed list keeps the catalog`、`docs(agents): register both writers of the codex private homes (catalog-miss probe and single call)`、`fix(agents): codex single call also turns off the other on-by-default tool flags and notify`（按已装 `features list` 过滤，另加 `notify=[]`）。
  - claude：`feat(agents): report claude's 200000 default window (ERRATUM on the unknown-window note)`。
  - 门红修正：`test(agents): count catalog entries apart from codex-home in the relocated-HOME criterion`（本分支新判据，不算改写）。
- **新的仓库外写入**（本仓 Rule 17 的对应物）：`<catalogCacheDir>/codex-home/<sha256(安装键)>/{home,codex-home}`——每个安装键复用一个私有 `CODEX_HOME`（人问「每次都要重建吗」后的裁定），内含指向 `~/.codex/{auth.json,config.toml}` 的软链与 codex 自己写的状态；两个写入方：codex 目录 miss 探测与单次调用；无 cache root 时退回 run 目录。登记在 Orca spec §11.1（原文不改、追加具名节）与 `src/agents/codexIsolation.ts` 的注释。
- **改写的既有判据**（每条都有人点名）：Orca 计划 E1–E5（人批准全部六条，E6 在 Orca）；人点名 `tests/runtime/omp/ompSingleCall.test.ts`「stops the call at the request's time limit…」（先热缓存、仍断言 `omp-timeout`）＋新判据「冷缓存＋复核超过截止 ⇒ spawn 前拒」；人一揽子授权下改了三处，都在本分支新建文件里、仍精确 `toEqual`、旁边有 `Ruling: rewritten under the human's blanket naming…`：`tests/agents/agentCatalog.test.ts:42`、`tests/agents/catalogProbe.test.ts:150`、`:153`。
- **真 codex 付费跑改了代码的发现**（gpt-6-luna、codex-cli 0.160.0，只抄工具报数）：P1 失败 `codex-single-call-not-single:tool`——codex 对人 `config.toml` 里的东西发 `error` item，且链进来的 MCP 服务被启动 ⇒ `error` item 当诊断（其余未知 item 仍 fail closed），MCP 按名 `-c mcp_servers.<名>.enabled=false`（`mcp_servers={}` 不起作用；未定义或带引号的名字会让配置加载失败）；P1b 失败（codex RC 1）——名单是在真 `~/.codex`（含 plugins）下列的，比隔离配置多 ⇒ 名单在同一隔离下列；P1c、P1d（I4 之后，29 个 `-c` 键）**通过**，input 10811／10109 token。全程 `~/.codex` 凭据前后 0 字节差。一行提示的框架开销 10109–11590 input token（spec 原估约 1.5k），归人定 profile 值。
- **门**（clone 里跑，原始日志在 Orca 会话 scratchpad、会话结束失效）：run 3（`test(agents): count catalog entries…` 上）全量 1824/1826、`check-known-reds` RC 1（unexpected 2）、`verify:control` 866/866、tmpleak 0；run 4（代码 tip）全量 1810/1826、`check-known-reds` RC 1（unexpected 14）、`verify:control` 865/866（`extractFinalObject` 3 s 阈值）、tmpleak 0；所有红文件单跑 3/3 ⇒ 全判负载 flake，控制器以 run 3＋run 4 接受。run 2 抓到的唯一真红已修（见上「门红修正」）。明细与新候选在 Orca `docs/handoff/known-load-flakes.md` 的 ccloop 段（`a852f96a` 条）。
- **提议进 `scripts/check-known-reds.mjs` 名单**（名单归人定，本轮没改）：`verifySavedResult`「r1 command interruption modified=true…」、`codexAdapter`「outer watchdog kills a previously observed TERM-ignoring detached Codex」——run 2、run 3 都红，每次单跑 3/3。
- **残余**（Orca spec §11.5 为准）：refresh token 经 `auth.json` 软链的轮换未验（新 token 若以 rename 写进私有目录，下次调用挪成 displaced 并重链回旧文件 ⇒ 人 `codex login`）；keyring 存凭据 ⇒ 无 `auth.json` 可链、fail closed；control worker 的 `ccloop-agent-catalog:` 日志行没有生产 sink（worker 以 stdio `ignore` 起）；**codex 阶段调用仍带着操作者的 skills／AGENTS.md**；omp 旧 `config.yaml`／`PI_CONFIG_DIR` 不进键；旧 build 的缓存条目 30 分钟内带较短的 flag 列表；`notify=[]` 是否真挡住人的 notify 程序未量；点号 MCP 名拒；lstat 与建链之间的同用户 TOCTOU（最坏挪开真 `auth.json`、字节保留）；两条 7500 ms 界的冷复核判据余量约 0.7–1 s。历史 spec／plan 里「claude 窗口 null」的文字是 ERRATUM 候选（`docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md:134,165-166`、`docs/superpowers/plans/2026-09-24-g1-capability-vocabulary.md:76,123,173,288,293`），未改。
- **已在 main（人已合推，本会话 `merge-base --is-ancestor` 现核）**：
  - `codex/attempt-commit-no-hooks`：`fix(workspace): run the attempt commit without the target repository's hooks`（`ATTEMPT_IDENTITY` 加 `-c core.hooksPath=/dev/null`，新判据修前见红，既有判据零改写）＋`test(agents): retitle the context-window criterion now that omp reports its catalog window`（只改标题，注释逐字保留＋追加人裁行）。本地分支与工作树仍在，删归人。
  - OMP single-call（目录行给窗口／`singleCallExecution`／`singleCallOutputCap`，spawn 前复核 `0 < maxTokens ≤ request.maxOutputTokens`，argv 关工具／规则／LSP，`--config` 叠加关重试、模型回退、loop guard、advisor、压缩，解码 fail-closed）与 #58 诊断（保留码前缀＋原因＋截断 stderr 尾；进程内记忆化已撤）。⚠️ 每个 kind 的 resolution 都带 `singleCallOutputCap`，旧 Orca 的 `.strict()` 会拒——Orca main 已含接收端。遗留：provider 层首 token 前重试关不掉；`omitMaxOutputTokens` 模型与 OpenRouter 不发上限。真 provider：2026-10-15 estimate／clarify／split 各一次，传输全过；estimate 的答案质量不稳——同一别名 4 次真估算里 3 次把任务列两遍（`estimate-output-invalid`），Orca 会话 `a852f96a` 的 P2 冷缓存那次第一次 `ready`；P2 实测缓存：每个冷缓存 1 次 `omp models`、热缓存 0 次。
- **Qoder 钩子已从主仓移除**（人授权，2026-10-15）：`.git/hooks/post-commit`、`post-checkout` 全是 `# BEGIN Qoder AI tracker` 块（Qoder CN 应用 2026-09-21 写入，三仓字节相同），备份后删除。⚠️ Qoder 应用再启动可能重新写入；本仓 `core.hooksPath` 未设。`refs/ccloop/*` 的 164 个 `ccloop-cli-scripted-*` 测试残留已清（人授权；对象在 gc 前仍在库里）。

- **仍有效的前几轮结论**（2026-10-15 压缩时从上一版「当前状态」保留）：
  - 上限与窗口**信 `omp models --json` 的所选行**，人知情：本机自定义模型的 128000/16384 是 omp 编的默认值，不是人配的。Task 0 实测（Orca spec `2026-10-14-omp-single-call-design.md` §7）：`config get` 不认 `--config`、运行时认（断流时有叠加 1 次 POST、无叠加 4 次）；框架开销约 2047 token。single-call 那批既有判据零改写，`tests/fixtures/fake-omp.mjs` 有改动（已点名），`src/agents/registry.ts` 的 `singleCallExecution` 注释追加了 ERRATUM；变异 28/28 在 clone 里红。#58 前一笔主题行「read it once per process」已被后一笔撤销（记忆化会让 `ompUpdates`「model vanishes after preview」红），主题行过时、不 amend。
  - C（Codex 429 退避，spec `docs/superpowers/specs/2026-10-13-codex-rate-limit-backoff-design.md`）：只认 `last status: 429`；零 item 的 `before-work` 阶段内退避 30/60/120 s，用尽 ⇒ `codex-rate-limited: <dir>`、用量记 0；`after-work` 不重试。`ompUpdates`「preserves the unavailable reason…」超时 20 s（人点名）。
  - 外部反馈落在本仓的：#62 不采纳「加长退避」（退避被 `min(timeoutMs, timeRemainingMs)` 截断且占租约）；#50 不采纳「去 `--ephemeral`＋`resume --last`」。
  - 零成本探针：omp 18.10.1 对 `127.0.0.1` 也走 `HTTP_PROXY`，启动时会探测本地 ollama／llama.cpp（fake 上游要能吃掉意外请求）。
  - n＝1 断言形状候选（未豁免，下次红了先对照）：`phaseTimeoutUsage` codex「plan, execute and verify time out…」得 `codex-io-error`；`skillsController`「preserves plan skill cleanup failure across handoff-abort」`fixture marker missing`；`runCodexPhase`「kills a TERM-ignoring process…」`expected 'io-error' to be 'aborted'`；本轮新增 `verifySavedResult`「r1 command interruption…」、`runLoop.integration`「persists phase usage evidence…」。

## 上一轮：OMP 支线已由人合并进 main 并推送、分支与工作树已删（2026-10-13 晚）；下面保留为它们的内容记录

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
- `ompUpdates` 的「preserves the unavailable reason…」单独跑 3.1–3.3 s、负载下超时：人 2026-10-14 已点名，超时改 20 s 在分支 `codex/omp-updates-timeout`（见「当前状态」）。
- **分支 3 顶上的全量**（2026-10-13，本机同时有别的会话，负载 6–25）：typecheck／build 过；全量 1655/1659，4 红 —— `cli` parseArgs 超时、
  `savedResultRecovery.native`（dist 重建撕裂读）、`codexAdapter` watchdog 单独各 3/3 绿；`ompUpdates`「preserves…」单独负载 10–12 下 2/3 红（6.4 s；2026-10-14 人点名后已在分支上放宽）。
  `verify:control`（只含 fake codex `integration` 的表，`ORCA_CCLOOP_BIN`＝本构建）805/806，唯一红 `extractFinalObject` 3 s 性能阈值（3.16 s，负载 13），单独 3/3 绿。
  没跑 `check-known-reds.mjs`（名单未含 OMP 新测试，跑之前先核名单）。
- 不要称「全绿」：上面的红是按文件隔离归因的，没有逐条过 `check-known-reds.mjs`。

### 待人做的

- 无。上一版列的删除（`codex/attempt-commit-no-hooks`、`codex/every-agent-chain` 及其工作树）人已做完（Orca 会话 `4de777f4` 现核 `branch -vv`、`worktree list`）。

---

## 仍然挂着的

| 挂账 | 现场 |
|---|---|
| **OMP 单次调用（estimate／clarify／split）** | 已在 main；2026-10-15 真 provider 各跑一次（见「当前状态」）：传输链路通过，estimate 的答案质量（同一任务列两遍）未验收。遗留：provider 层首 token 前重试关不掉；`omitMaxOutputTokens` 模型与 OpenRouter 不发上限（后者按名拒）。「spawn 时目录探测不在时限与 abort 内」已修（`feat(agents): catalog probes honour the caller's deadline…`，已在 main） |
| **OMP 其余延期项** | OMP 子代理、交互式审批桥、omp 的 saved-result 恢复（目前仅 codex）；OMP skills 的**真实 provider 验收**未做（OMP 本体已在 2026-10-12～13、10-15、10-16 真跑过，见 Orca handoff §3.2）。Git 忽略文件与主机副作用不在 execute 检查范围 |
| **`ClaudePhaseAborted` 历史交错（B4）** | runner 重复发布竞态与无效答案中止分支已修；精确的历史交错**仍未证成** ⇒ 不能据此宣称真实 provider 稳定性。详见 Orca handoff |
| **Codex 429（外部测试反馈 45–50、62）** | 已合进 main。剩：5xx 与其他措辞无样本未识别；Orca 侧 `codex-rate-limited` 文案已在 Orca main；可用 `gpt-6-luna` 做一次真 Codex 回归（付费，先问人） |
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

# 📌 Orca 那条线（单节滚动 —— 每轮【就地替换】本节，不新增 Orca 章节；2026-10-17，Orca 会话 `4de777f4`）

- 详情只看 Orca handoff（`/Users/biran/code/skills/orca/Orca/docs/handoff/handoff.md`）的 §3.2a 与 §4；在 Orca 分支 `codex/round-20261017` 上，人合进 main 之后才在 main 上可见。
- Orca 这一轮是「花了钱就一定要拿到能用的估算」：确定性修复、指令 v2、一次自动重试。**只改了 Orca，本仓代码零改动**，pin 仍是 `02cbacc`，付费验收用的也是这一笔的 build。Orca 依赖本仓的有两点：`single-call-output-invalid` 这个码名（Orca 拿它触发重试），以及 `ompSingleCall`、`codexSingleCall` 读 JSON 对象的语义。**改这两处之前先同步 Orca。**
- ⚠️ Orca 主仓和服务用的是 `node_modules` 里装的 ccloop：合进新 pin 后要先 `npm ci`，只跑 `npm run build` 不会更新它。
- 本仓仍登记着、未修：codex 没有单次调用的输出上限；codex phase 调用会带上操作者的 skills（Orca spec `2026-10-15` §2、§11）。
