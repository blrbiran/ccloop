# ccloop Handoff — 下一件：按计划实施「Codex 阶段隔离」（spec 在 main，计划在分支 `codex/codex-phase-isolation-plan`）；之前各轮都已在 main；Orca 关联见文末单节

> ⚠️ **一律自查，别信本文。** 只有两个门锚点 `e42e062`（GATE-PKG3）与 `86d3bd6`（GATE-PKG2）是固定历史值。
> *** **本文不写任何当前哈希** —— 指代某一笔引**提交主题行**（`git log --grep`），指代材料引**路径**。 ***
> 本文是活文档。2026-10-13（会话 `808feb6a`）整篇压缩；2026-10-18（Orca 会话 `a3b2a7a7`）把已合推各轮的分支流水压成「已在 main 的能力＋仍成立的结论」。压缩前全文：`/usr/bin/git log --oneline -- docs/handoff/handoff.md` 挑一笔再 `git show <那一笔>^:docs/handoff/handoff.md`。
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


## 环境（2026-10-18 现测）

- `/opt/homebrew/bin/node` **坏的**（缺 libsimdjson）；nvm Node 22.13.1 在 PATH 最前；`/usr/local/bin/node` 是 24.13.0。
- 本机 `rm`、`cp` 是 `-i` alias：`rm -rf` 会**静默挂在确认提示上**，`cp` 会**静默拒绝覆盖** ⇒ 用 `/bin/rm -rf`、`cat src > dst`；删软链用 `unlink`。
- **本仓 CLAUDE.md Rule 13：开门、合并、删分支或 worktree、push 每次都要人单独点头，控制器不许 push。** Orca 的 Tier 0 闸门（从 Orca 目录起的会话里对所有目录生效）2026-10-18 起放行 `merge --ff-only`、`branch -d`、不带 force 的 `worktree remove`——**那只是闸门不再机械拦，不改变本仓 Rule 13**；要不要对齐由人裁（Orca handoff §八）。
- codex-cli **0.163.0**（2026-10-18 `codex --version`）；`hooks` 在 `codex features list` 里是 stable。真 Codex 只用 `gpt-6-luna`（在 0.160.0 下验过），**付费，每次先问人**；额度 2026-10-22 恢复。OMP 用的 LiteLLM 端点由人起停（真跑同样先问人）。

---

## 当前状态

### 下一件：Codex 阶段隔离（Orca item 3，会话 `a3b2a7a7` 设计＋计划，代码零改动）

- spec（main）：`docs/superpowers/specs/2026-10-18-codex-phase-isolation-design.md`——人裁「个人 skills 都不带」：阶段在每个安装一对的私有 `HOME`／`CODEX_HOME` 里跑（复用 single call 那对），关掉个人 skills／`~/.codex/AGENTS.md`／hooks（`features.hooks=false`）／MCP（逐个 `enabled=false`）／`notify`／plugins／apps／collaboration 指令；**保留**目标仓 `AGENTS.md`、Orca 交来的 `codexSkillsDir`、凭据链接、codex 自带的环境与权限说明；阶段里跑的命令用**真 HOME**（`shell_environment_policy.set.HOME`，要先实测）；隔离搭不起来 ⇒ spawn 前拒、终局不重试、用量记 0（`neverStarted`）；读不到 MCP 名单就拒。
- 计划（分支 `codex/codex-phase-isolation-plan`，工作树 `ccloop-wt-iso-plan`，待人合）：`docs/superpowers/plans/2026-10-18-codex-phase-isolation.md`，7 个任务。⚠️ **Task 1 是免费实测＋停止点**（`set.HOME` 与 `features.hooks=false` 被不被 0.163.0 接受、个人 skills 回不回来）；⚠️ **Task 4 Step 6 是停止点**：预言 `tests/control/codexSkillsFailureWorker.test.ts` 两条变红（夹具 `tests/runtime/codex/skillsControllerFixture.ts` 不答 `debug models`／`features list`／`mcp list`），`tests/runtime/codex/extraEnv.test.ts`「sets CODEX_HOME from the installation's configDir…」语义已变——**改要人逐条点名**（Rule 15）；Task 7 付费一次要人点头。
- 免费实测（Orca 会话 `a3b2a7a7`，`codex debug prompt-input hi`，不发请求）：真 HOME 68018 字节含个人 skills；私有 homes 13269 字节、个人 skills 消失、仓库 skill 与 `AGENTS.md` 仍在；`features.skip_host_skill_discovery` 不需要。

### 已在 main 的能力（各轮都已由人合推；细节按主题行 `git log --grep` 取）

- **agent catalog 文件缓存**：`$CCLOOP_CACHE_DIR`（缺省 `~/.cache/ccloop`），0700／0600，键含二进制与配置 stamp，30 分钟，版本号也缓存；检测、`agents validate`、`updates.ts` 版本探测与 Apply 复核**按设计保持实时**。探测进调用方时限与 abort、失败报阶段。`control models`／`agents models [--refresh]`。
- **codex single call**（`singleCallExecution: "v1-soft"`、窗口取 `codex debug models`）：每个安装键复用一对私有 `HOME`／`CODEX_HOME`（`<cache>/codex-home/<sha256>/`，软链 `~/.codex/{auth.json,config.toml}`；私有目录是软链即拒；**从不删正规凭据**，挪成 `<名>.displaced-<ms>`）；`error` item 当诊断（其余未知 item fail closed）；MCP 按名 `-c mcp_servers.<名>.enabled=false`（`mcp_servers={}` 无效；未定义或带引号的名字让配置加载失败）、**名单在同一隔离下列**；其余默认开的工具 flag 按已装 `features list` 关、另加 `notify=[]`。登记：Orca spec `2026-10-15-every-agent-requirement-chain-design.md` §11.1（§12 预登记阶段隔离为第三个写入方）与 `src/agents/codexIsolation.ts` 注释。
- **claude** 默认档窗口报 200000。**attempt 提交**不跑目标仓钩子（`ATTEMPT_IDENTITY` 加 `-c core.hooksPath=/dev/null`）。
- **OMP**：安装（只收绝对二进制）、每机模型发现与精确解析、更新保护、plan／execute／verify adapter（禁扩展；execute 拒 OMP 自行提交）；skill 注入走 `ompSkillsDir`（与 `skillPluginDir`／`codexSkillsDir` 互斥；**OMP 永远 `--no-skills`／`--no-extensions`**，ccloop 在私有 system prompt 末尾加 `<skills>` 清单）；single-call（上限与窗口**信 `omp models --json` 所选行**，含 omp 编的 128000/16384 默认值，人知情；spawn 前复核；`--config` 叠加关重试／回退／loop guard／advisor／压缩；解码 fail-closed；框架开销约 2047 token）；#58 诊断。设计在 Orca 仓（`2026-10-12-oh-my-pi-agent-integration-design.md`、`2026-10-13-omp-skill-injection-design.md`、`2026-10-14-omp-single-call-design.md`）。
- **Codex 429 退避**（spec `2026-10-13-codex-rate-limit-backoff-design.md`）：只认 `last status: 429`；零 item 的 `before-work` 阶段内退避 30/60/120 s，用尽 ⇒ `codex-rate-limited: <dir>`、用量记 0；`after-work` 不重试。**strict execute schema**（complete／partial × 有／无报告的严格候选）。

### 仍成立的结论与残余

- **真 codex 付费的发现**（gpt-6-luna、0.160.0，Orca 会话 `a852f96a`）：P1 失败因人的 `config.toml` 触发 `error` item 且 MCP 被启动；P1b 失败因名单在真 `~/.codex` 下列；P1c／P1d 通过（input 10811／10109）。**一行提示的框架开销 10109–11590 input token**（profile 值归人）。全程 `~/.codex` 凭据 0 字节差。
- **残余**：refresh token 经软链轮换未验（新 token 若 rename 进私有目录，下次被挪成 displaced 并重链旧文件 ⇒ 人 `codex login`）；keyring 存凭据 ⇒ fail closed；control worker 的 `ccloop-agent-catalog:` 日志无生产 sink；omp 旧 `config.yaml`／`PI_CONFIG_DIR` 不进键；`notify=[]` 是否真挡住 notify 程序未量；点号 MCP 名拒；lstat 与建链之间同用户 TOCTOU；两条 7500 ms 冷复核判据余量约 0.7–1 s；provider 层首 token 前重试关不掉；`omitMaxOutputTokens` 模型与 OpenRouter 不发上限。历史 spec／plan 里「claude 窗口 null」是 ERRATUM 候选（`docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md:134,165-166`、`docs/superpowers/plans/2026-09-24-g1-capability-vocabulary.md:76,123,173,288,293`），未改。
- **known-reds 名单**：只加了 `codexAdapter`「outer watchdog kills…」；`verifySavedResult`「r1 command interruption…」**不加**（下次红先按 `systematic-debugging` 在 clone 里查）。**n＝1 断言形状候选**（未豁免，下次红先对照）：`phaseTimeoutUsage` codex「plan, execute and verify time out…」得 `codex-io-error`；`skillsController`「preserves plan skill cleanup failure across handoff-abort」`fixture marker missing`；`runCodexPhase`「kills a TERM-ignoring process…」`expected 'io-error' to be 'aborted'`；`runLoop.integration`「persists phase usage evidence…」。负载 flake 明细在 Orca `docs/handoff/known-load-flakes.md` 的 ccloop 段。
- **夹具**：`tests/setup/relocateCatalogCache.ts` 给每个测试文件一个空 `CODEX_HOME`（否则判据读到人的真 `~/.codex/config.toml`）；`tests/fixtures/fake-omp.mjs` 是可复用的 OMP 夹具。
- 外部反馈落在本仓的：#62 不采纳「加长退避」（被 `min(timeoutMs, timeRemainingMs)` 截断且占租约）；#50 不采纳「去 `--ephemeral`＋`resume --last`」。零成本探针：omp 18.10.1 对 `127.0.0.1` 也走 `HTTP_PROXY`，启动时探测本地 ollama（fake 上游要吃掉意外请求）。
- **人点名过的既有判据改写**（每条都在提交主题行或旁注 `Ruling:` 里，引用前去那一行看）：2026-10-13 两笔（`test(agents): rewrite the claude/codex-only kind criteria to include omp`、`test(omp): make two criteria independent of PATH's node and omp probe time`）；`ompUpdates`「preserves the unavailable reason…」超时 20 s；`ompSingleCall`「stops the call at the request's time limit…」；Orca 计划 E1–E5 与一揽子授权下的 `agentCatalog.test.ts:42`、`catalogProbe.test.ts:150,153`。**「按你的建议办」不是改判据的授权。**
- Qoder 钩子已从主仓移除（2026-10-15，人授权；Qoder 应用再启动可能重写）；本仓 `core.hooksPath` 未设。

---

## 仍然挂着的

| 挂账 | 现场 |
|---|---|
| **agent 在结果里报 `decisions[]` 与 `debug`** | Orca 的「控制 run 写决定」「纠正 ⇒ debug task」两份计划要 ccloop 把 agent 最终输出里的 `decisions`（`question/chose/alternatives/because/undo/scope/kind`）与 `debug`（`choseInstead/reproTests/reproCommand/reproduction`）带进结果；execute 阶段指令要讲清「什么算决定」与 `undo.how` 的可执行写法（`git revert --no-edit <sha>`）。**要在本仓走 brainstorming**；Orca 计划 Task 12 等它 |
| **OMP 单次调用的答案质量** | 传输链路通过；estimate 同一别名多次「任务列两遍」；Orca 侧已加修复与一次重试（Orca §3.2） |
| **OMP 其余延期项** | 子代理、交互式审批桥、omp 的 saved-result 恢复；OMP skills 的**真 provider 验收**未做 |
| **`ClaudePhaseAborted` 历史交错（B4）** | 竞态与无效答案分支已修；精确历史交错**仍未证成** |
| **Codex 429** | 5xx 与其他措辞无样本未识别；可用 `gpt-6-luna` 真回归一次（付费，先问人） |
| **`capabilities` 计算化** | 人裁「分两步」的第二步，未设计。今天三个 kind 的 `requestBoundProof` 都恒 `null`（`src/agents/{claude,codex,omp}.ts`） |
| **codex 单次调用没有输出上限** | `"v1-soft"`：事后核对、不封顶 |
| **Linux** | 整套历史上红 5 条；之后只在临时 VM 跑过 `/usr/bin/flock` 两进程串行；**整套未在 Linux 再跑** |

---

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

# 📌 Orca 那条线（单节滚动 —— 每轮【就地整段替换】本节，只放指针，不新增 Orca 章节；2026-10-18，Orca 会话 `a3b2a7a7`）

- 详情只看 Orca handoff（`/Users/biran/code/skills/orca/Orca/docs/handoff/handoff.md`）§3.0 与 §4。Orca 这一轮只做设计与计划；pin 仍是 `02cbacc`。
- **本仓要接的两件**：① Codex 阶段隔离（上面「下一件」）；② agent 结果里的 `decisions[]` 与 `debug`（上面挂账第一行），Orca 计划 `docs/superpowers/plans/2026-10-18-control-run-decisions.md` Task 12 对它做契约测试。
- **Orca 依赖本仓、改之前先同步 Orca 的**：`single-call-output-invalid` 码名（Orca 拿它触发估算重试）；`ompSingleCall`、`codexSingleCall` 读 JSON 对象的语义；`ExecutionReport`／结果的字段形状（Orca 将读 `decisions`、`debug`）。
- ⚠️ Orca 主仓和服务用 `node_modules` 里装的 ccloop：合进新 pin 后先 `npm ci`。codex 估算补跑要用 `/private/tmp/ccb6-qswQ/ccloop/dist/cli.js` 这份 pin 的 build（补跑后人删）。
