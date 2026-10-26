# ccloop Handoff — multi-repo 已在 main（P1–P7 与 M9 已由人确认）；实时转录亦在 main（见「当前状态」）；Orca 关联见文末单节

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
- **本仓 CLAUDE.md Rule 13（2026-10-18 已与 Orca 闸门对齐，人裁，Orca 会话 `1710772d`）**：`merge --ff-only` 合进 main、`branch -d`、不带 force 的 `worktree remove` agent 可以直接做；**push 仍由人做（不要提醒）**；开门与强制形式仍每次单独授权。
- codex-cli **0.163.0**（2026-10-18 `codex --version`）；`hooks` 在 `codex features list` 里是 stable。真 Codex 只用 `gpt-6-luna`（在 0.160.0 下验过），**付费，每次先问人**；额度 2026-10-22 恢复。OMP 用的 LiteLLM 端点由人起停（真跑同样先问人）。

---

## 当前状态

### 本轮（2026-10-24，Orca 会话 `ffec7b28`）—— 先读这一节

- **已在 main 并已推**（主题行起 `docs(plan): live transcript` 系列，至 `test(control): the startedAt-order case creates its call directories in name order`）：**实时转录的 ccloop 部分**（Orca spec `docs/superpowers/specs/2026-10-23-live-transcript-design.md` §10.2、§11、§12；计划 `docs/superpowers/plans/2026-10-24-live-transcript-ccloop.md` 含 As-built 与两轮审阅）：每次调用一份 `transcript.jsonl`（0600，claude 由 runner 经 `CCLOOP_CLAUDE_TRANSCRIPT_PATH` 写，不记 `content_block_delta`；>10 MiB 行留 `ccloop.line-dropped`）；transcript 128 MiB 截到整行＋`ccloop.transcript-truncated` 标记（先写标记再 ftruncate）、`events.jsonl` 16 MiB 只停记录；codex/omp stdout 1 GiB ⇒ `output-limit`；全部解码改为按行 fold（0x0A 切行，跨块多字节安全）；collect 顶层 `transcripts`、features `transcripts:"v1"`；`work.operatorNote`（只进 plan/execute，`verify-saved-result` 时拒）。改了判据（人裁 O5「…作为一个hard limit ，比如1G」与本会话「这次批准改写所有必要的判据」，逐条在提交里）：`runCodexPhase.test.ts:57-60`、`ompPhase.test.ts:225-226`、`claudeAgentAdapter.test.ts:133`、`singleCall.test.ts:87-107`、`protocol4.test.ts:13`、`savedResultEvidence.test.ts:107,110`、`toolRulesCollect.test.ts:107`。门：tip 上 2338 条 2 红（known `runLoop.integration`＋`taskResults` 30 s 超时单跑 6/6 绿）。⚠️ push 被 Orca Tier 0 闸门拦下，由人手推。
- **真 codex strict schema 验收已做**（gpt-6-luna，带 `debug.located`＋`flow`）：provider 接受，三阶段 completed；codex 报回两键；也读得到工作区外绝对路径。证据 `/private/tmp/orca-ffec7b28/evidence/codex-accept/RESULT.md`。
- **`feat/multi-repo` 已合入 main 并已推**（主题行起 `docs(plan): multi-repo ccloop — several repositories in one run`，至 `test(omp): C13 expects dirs[].attemptSha, the published attempt commit in the extra repository (review M7 follow-up)`；Orca spec `2026-10-24-multi-dir-projects-design.md` §11、C1–C13；计划 `docs/superpowers/plans/2026-10-24-multi-repo-ccloop.md` 含 As-built 1–10 与 Review round 1）：契约 `context.repoKey`/`additionalRepos`、envelope `work.additionalRepos`、collect `dirs[]{key,resultRepo,changedPaths,attemptSha}`，缺省时逐字节不变；**没改任何既有测试**（C12：22 个测试/fake 全 `A`）。人已确认 P1–P7、M9（`extra-repo-head-moved` 保持人闸 `blocked_waiting_human`）与 As-built 1–10；真跑验收只开放 codex（claude 无额度）。门：最终 tip 全量 RC 0（known reds 7、failed 1 为名单内 Codex TERM 忽略用例、unexpected 0）；rebase 后 typecheck/build 绿、19 个多仓测试文件 55/55。分支已删、worktree 已移除。
- **未合分支 `feat/omp-empty-stop-perf`**（worktree `/private/tmp/orca-ffec7b28/ccloop-c-wt`；计划 `docs/superpowers/plans/2026-10-26-omp-empty-stop-and-perf-l7.md`，含 As built 与两轮审阅）：两件登记未修项已修，**没改任何既有判据**。
  - omp 空停续跑：omp 18.10.1 把只有无签名 thinking 的 `stop` 当空停、丢掉后重试并再发一次 `agent_start`（真跑证据 `/private/tmp/orca-ffec7b28/evidence/omp-empty-stop/events.jsonl` 576 行：333 空停 → 334 `turn_end` → 335 `agent_start` → 574 答案 → 576 单一 `agent_end`）。`OmpPhaseFold` 现在只在「`stop` 且有可行动内容」置 `ended`（镜像 `isEmptyAssistantStop`/`isActionableContent`，签名 thinking 也算），答案后的第二答案／工具／第二终态仍照旧拒；该真流现在解出 verify JSON，`tokenUsage` 13529。
  - perf:stream（L7）：Node 24 下 `--max-old-space-size=64` 单独时 `heap_size_limit` 仍 256 MB（young 自动放大），claude 的 62–98 MiB「增长」是浮垃圾（大 GC 后活堆 4.6 MB）；两个被测 spawn 加 `--max-semi-space-size=1`（limit 67 MB），阈值 32 MiB 不动。两轮全绿：codex 17.1／15.6、omp 14.8／16.8、claude 19.9／20.7 MiB。
  - 门（分支 tip）：typecheck／build RC 0；全量 2399/2399、`check-known-reds` RC 0（首轮唯一红为 `updates.test.ts` 20 s 超时，单跑 3/3 绿，次轮全绿）；变异 M1–M3 在 `git clone --local` 副本中见红并 0 字节还原（`/private/tmp/orca-ffec7b28/c-mutations.log`）。**未合、未推**。

#### 上一轮（2026-10-22，Orca 会话 `b37f7ce9`）—— 已合、已推

- ~~下一件：codex 额度恢复后验收 strict wire schema~~ **已在会话 `ffec7b28` 做完并通过**（见上）。原文：真 codex（`gpt-6-luna`）验收新 strict wire schema（`debug.located`＋`flow` 两个新成员）：一次带 `debug.located` 与 `flow` 的 execute（付费，先问人）。provider 拒收 ⇒ 每个 codex execute 都会坏 ⇒ 修 schema 或让 Orca pin 回 `d02b9d2`。claude 已真跑验证 `located`（haiku，tool 报 tokens plan 45658／execute 49847／verify 48136，未报 USD）。omp 真跑在 plan 阶段撞既有 `omp-phase-continuation`（第二个 `agent_start` 跟在已停消息后，`ompProtocol.ts:44`），与本轮无关，登记未修。
- **每契约工具规则**（spec `docs/superpowers/specs/2026-10-22-per-contract-tool-rules-design.md`、plan `docs/superpowers/plans/2026-10-22-per-contract-tool-rules.md`；主题行 `feat(contract): optional executionPolicy.toolRules` 起至 `fix(toolRules): a carriage return separates commands too`）：契约可选 `executionPolicy.toolRules`；缺省时 argv／prompt／collect 与 `2a2ae53` 逐字节相同（goldens 在 `tests/fixtures/toolRules/golden-2a2ae53/`）；每条规则回报 `enforced|detected|recorded-only|refused`，写 `run/tool-rules.json`（0600），collect 顶层 `toolRules`。claude 前缀 `Bash(<v> *)`；codex `network:false` ⇒ execute `-c sandbox_workspace_write.network_access=false`＋每阶段 `-c web_search="disabled"`、`-c features.apps=false`；omp 执行后检查（含 `write`/`edit` 到 `xd:` 路径）⇒ `tool-rule-violated`（终止、不重试）。§7 的三份实测在 Orca scratch（会话 `b37f7ce9`，已登记进 plan 的「Measurements」节）。付费 claude 探针一次 $0.00246504。
  - 人的 claude 安装是 `bypassPermissions` ⇒ 本机 claude 的 `commands-closed` 恒为 `recorded-only`（人裁「不要改」）。
  - 登记未修：M2 报告在 worker 开始时读一次 `config.toml`、执行时每阶段再读；M7 omp 输出超限后违规以 output-limit 收尾（仍 failed，不放宽）。
- **`debug.located`**（spec `2026-10-22-debug-located-design.md`，主题行 `feat(runtime): every kind can report debug.located; codex's wire schema gains it`）：codex wire `debug` 加可空 `located`；`debug`/`flow` 内嵌对象的 null 成员剥掉。改了判据 `tests/runtime/codex/strictWireSchema.test.ts:64`（人一揽子授权「这次批准改写所有必要的判据」）。
- **不透明 `flow` 答案键**（spec `2026-10-22-flow-answer-key-design.md`，主题行 `feat(runtime): every kind's execute answer may carry flow, opaquely; codex's wire schema gains it`）：照 `debug` 携带；codex wire 形状封闭、**不含 `candidates`**（Orca 的候选是模板自定键的记录，strict 表达不了）⇒ codex 跑时 Orca 回退到模型候选。claude execute argv 必然多 `"flow":{}`；改了判据 `claudeSkillPluginDir.test.ts:33`、`claudeToolRules.test.ts:51`（同上授权）。
- **门**：工具规则那轮全量在负载 98 下 17 红、`check-known-reds` RC 1，逐个单跑或在未改动 main 上同形 ⇒ 判负载；`flow` 键那轮全量 2251/2251、known-reds RC 0。新 n＝1 形状：`abortedUsage`「expected null to be a CodexPhaseAborted」（单跑 3/3 绿）。

#### 上一轮（2026-10-21，Orca 会话 `9ec98639`）—— 已合、已推、已被 Orca 采用

- **本轮合进 main 的**（都 `--ff-only`，以 `git ls-remote` 现测推没推；按主题行 `git log --grep` 取）：
  - **verifier 看到检查结果＋上次失败带给重试＋首次必需检查失败重试一次**（spec `docs/superpowers/specs/2026-10-20-verifier-sees-checks-and-last-failure-design.md`，§13 as-built 优先；人选 (b)：只在 lineage 第 1 次 attempt 且非恢复路径 `safeToRetry: true`）。改了判据：`runLoop.integration.test.ts:468-475`、`:526-533`（`failed` → `exhausted`「repeated failure pattern detected」）、`partialToVerify.test.ts` T11b、`taskResultOutcome.test.ts:33`（独立 oracle：fixture 检查不输出 ⇒ 空 stdout／stderr）。codex 阶段隔离 spec 的 Correction 与 `codexIsolation.ts` ERRATUM 同轮落地。
  - **`verifySavedResult`「r1 command interruption」是真缺陷，已修**（主题行 `fix(recovery): a saved-result check's group answering kill() with EPERM is gone, not a failed check`）：macOS 对「成员已退出、尚未回收」的进程组 `kill()` 回 EPERM 不是 ESRCH。修前 clone 14/30 红，修后 0/16。
  - **三份 spec＋实施**（每份末尾 Review round 1／2 与 As-built 优先；两轮独立审阅）：
    - `2026-10-21-declared-context-window-design.md`（#70 窄版）：codex／omp 安装可声明 `declaredContextWindow`，只在目录读到了却没给窗口时生效，resolution 带 `contextWindowSource: "installation-declared"`；不进 `agentConfigHash`。
    - `2026-10-21-failure-causes-and-transient-retries-design.md`：12 个 `failureCause`（collect 顶层可选 `{cause, phase, retries, detail}`，protocol-4 terminal 里剥掉）；`rate-limited`／`provider-5xx`／`network`／`stalled` 在阶段内最多重试 3 次（30／60／120 s，时限＝`min(installation.timeoutMs, perAttemptTimeoutMs, timeRemainingMs)`），claude 只在 `workObserved===false` 时重试；重试花的 token 求和记账（成功阶段另记 `retry-usage.json`）；codex 429 的重试判定仍只认 before-work。
    - `2026-10-21-activity-watchdog-design.md`：每安装 `idleTimeoutMs`（缺省 600000，`null` 关，不进 `agentConfigHash`）；有工具在跑时暂停空闲计时，最多 3×；空闲停 ⇒ `stalled`，claude 改过文件后的 partial ⇒ `failed`＋`stalled`；新检测到的安装墙钟 2 h（**已有安装不改，仍 30 min**）。
    - `2026-10-21-prior-failures-start-input-design.md`：启动 envelope 的 loop work 可选 `priorFailures`（1–3 条，最旧在前；`{runId, rejectCategory ≤200 B, failingCommand ≤4096 B|null, evidence 1–16×≤4096 B|null, failureCause? ≤64 B}`，UTF-8 字节 refine），只在本次 run 还没有自己的失败时进 plan／execute，verify 永不；与 `verify-saved-result` 互斥；不传时 envelope 逐字节不变。
    - 改了判据：`rateLimit.test`「gives a retried call only the time the phase has left」（fixture `perAttemptTimeoutMs` 60 s）、`claudeAgentAdapter.test.ts:131`（+`claude-signals.json`）、`savedResultEvidence.test.ts:105`（+`failureCause` 键）、`detect.test.ts:54,70`（草稿 `timeoutMs` 1_800_000 → 7_200_000）。
- ⚠️ **`~/.orca/agents.json` 加 `idleTimeoutMs`／`declaredContextWindow` 要等 Orca repin 到认识它们的那笔之后**：本仓表解析是 strict，旧 pin 见到未知字段会拒整张表。
- **残余**：claude 额度／溢出措辞与 codex 非 429 行只来自二进制字符串、无真样本；codex 上下文溢出、omp provider 报错无样本（归 `unknown`；采样要付费）；阶段被重试过的 attempt 不能走 saved-result 恢复（接受的损失）；codex `xhigh` 推理的静默时长未量；未测：runner 的「errorText 只取带类型错误的那条消息」、omp 空闲停、plan 卡一次后重试成功；`priorFailures` 的「崩溃原地恢复」测试不做（`resumeLoop` 拒 Orca 控制 run，走后继 run）。
- 登记未修（仍成立）：`CodexAdapter.execute` 在 abort 时只重抛 `codex-skills-*`；`runCodexPhase.ts:86` 把 ESRCH 以外的 kill 错误映射成 `io-error`（**疑似**下面两条 `io-error` 断言形状候选的成因，同 EPERM 机制）；主仓 prunable 工作树 `…/ccloop-cli-scripted-*/worktrees/attempt-1`（`worktree prune` 归人）。
- ⚠️ **本机负载 10–80 时全套当门不可靠**：`savedResultRecovery.native`（`ENOTEMPTY`）、`runCodexPhase`「timeout vs output-limit」、`ompPhase`、`phasesCompleted` 在未改动的 main 上同样会红——红了先和未改动 main 交错对比。


### 已在 main 的能力（各轮都已由人合推；细节按主题行 `git log --grep` 取）

- **agent catalog 文件缓存**：`$CCLOOP_CACHE_DIR`（缺省 `~/.cache/ccloop`），0700／0600，键含二进制与配置 stamp，30 分钟，版本号也缓存；检测、`agents validate`、`updates.ts` 版本探测与 Apply 复核**按设计保持实时**。探测进调用方时限与 abort、失败报阶段。`control models`／`agents models [--refresh]`。
- **codex single call**（`singleCallExecution: "v1-soft"`、窗口取 `codex debug models`）：每个安装键复用一对私有 `HOME`／`CODEX_HOME`（`<cache>/codex-home/<sha256>/`，软链 `~/.codex/{auth.json,config.toml}`；私有目录是软链即拒；**从不删正规凭据**，挪成 `<名>.displaced-<ms>`）；`error` item 当诊断（其余未知 item fail closed）；MCP 按名 `-c mcp_servers.<名>.enabled=false`（`mcp_servers={}` 无效；未定义或带引号的名字让配置加载失败）、**名单在同一隔离下列**；其余默认开的工具 flag 按已装 `features list` 关、另加 `notify=[]`。登记：Orca spec `2026-10-15-every-agent-requirement-chain-design.md` §11.1（§12 预登记阶段隔离为第三个写入方）与 `src/agents/codexIsolation.ts` 注释。
- **claude 的 execute／verify 只放行契约点名的必需检查**（主题行 `fix(claude): execute and verify allow exactly the contract's required checks`，Orca 会话 `3d229487`）：`--permission-mode acceptEdits` 在 `-p` 下拒任何非只读 Bash（实测 `node check-median.js` 被拒，verify 以 `required_check_not_run` 否决，而 ccloop 自己跑的检查是过的）⇒ 每条必需检查一条精确 `Bash(<cmd>)`，放在 `--model` 之前（列表选项会吞掉后面的 prompt）；空、含 `*`／括号／反斜杠／控制字符、首尾空白的不放行并记 `outcome.json` `requiredChecksNotAllowed`；复合命令（`&&`、`|`）claude 会拆开逐段匹配 ⇒ 精确规则永远匹配不上，仍跑不了；plan 不放行。依据：code.claude.com permissions／headless 文档＋claude 2.1.304 二进制。真 claude 付费一次 $0.0412702 证实；Orca 验收 `--scenario decision` 用这笔的 build 全绿（$0.3652988）。判据改写：`tests/runtime/claude/claudeSkillPluginDir.test.ts` 的 `goldenArgv` 加 `allowArgs`（人授权）。（verifier 原来不知道 ccloop 自己的检查已过——已由「verifier 看到检查结果」那一轮解决。）
- **execute 答案可带 `decisions`／`debug`**（spec `docs/superpowers/specs/2026-10-20-reported-decisions-and-debug-design.md`，**§10 as-built 更正优先**；首笔主题行 `feat(runtime): every kind's execute answer may carry decisions and debug, opaquely`，Orca 会话 `3831d12f`，2026-10-20，**未 push**）：执行提示要 agent 报少而重要、分级（major／minor）的决定，`undo.how` 不靠 `git revert`，`debug` 只在任务要求时报；三种 kind **不透明携带**（坏内容不让 run 失败；扫描器把 `taskResult`／`decisions`／`debug` 当不透明子树）；codex wire schema 两字段必填可空（`anyOf`，仍 2×2）；共用一步删掉 null／空 `debug`（没报时字节不变、saved-result 哈希不变）；单值 64 KiB 上限；verifier 看不见它们；`control collect` 在有候选时带回候选那次 attempt 保留副本里的值（按内容哈希找）。fake：codex／claude 新 `reported` 模式，omp 读 `<marker>.reported.json`，默认模式与参数约定不变。改过的既有判据只有 `tests/runtime/claude/claudeSkillPluginDir.test.ts:31` 的 argv 金样（加两个可选属性，人授权，Orca 会话 `3831d12f`）。登记：collect 每次轮询多读一遍 execution.json、非 ENOENT 读错让 collect 失败、普通 handoff 续跑的前任决定落不了地。
- **`control` 读 stdin 整块解码**（主题行 `fix(control): decode control stdin once over all bytes`，Orca 会话 `f3a75a90`，2026-10-19，人已推）：原来逐块 `String(chunk)`，>64 KiB 的中文 prompt 在管道块边界切开多字节字符 ⇒ U+FFFD ⇒ `promptSha256` 与 Orca 必然不一致（Orca 外部反馈 #80，重试无效）。判据在 `tests/control/command.test.ts`（真 CLI、第 65536 字节落在 3 字节字符中间）。同形的逐块解码还在 `versionProbe.ts`、`updateReceipt.ts`、`verifySavedResult.ts` 的 wrapper、`materialize.ts`——输出短或不承载长文本，登记未改。
- **claude** 默认档窗口报 200000。**attempt 提交**不跑目标仓钩子（`ATTEMPT_IDENTITY` 加 `-c core.hooksPath=/dev/null`）。
- **OMP**：安装（只收绝对二进制）、每机模型发现与精确解析、更新保护、plan／execute／verify adapter（禁扩展；execute 拒 OMP 自行提交）；skill 注入走 `ompSkillsDir`（与 `skillPluginDir`／`codexSkillsDir` 互斥；**OMP 永远 `--no-skills`／`--no-extensions`**，ccloop 在私有 system prompt 末尾加 `<skills>` 清单）；single-call（上限与窗口**信 `omp models --json` 所选行**，含 omp 编的 128000/16384 默认值，人知情；spawn 前复核；`--config` 叠加关重试／回退／loop guard／advisor／压缩；解码 fail-closed；框架开销约 2047 token）；#58 诊断。设计在 Orca 仓（`2026-10-12-oh-my-pi-agent-integration-design.md`、`2026-10-13-omp-skill-injection-design.md`、`2026-10-14-omp-single-call-design.md`）。
- **Codex 429 退避**（spec `2026-10-13-codex-rate-limit-backoff-design.md`）：只认 `last status: 429`；零 item 的 `before-work` 阶段内退避 30/60/120 s，用尽 ⇒ `codex-rate-limited: <dir>`、用量记 0；`after-work` 不重试。**strict execute schema**（complete／partial × 有／无报告的严格候选）。

### 仍成立的结论与残余

- **真 codex 付费的发现**（gpt-6-luna、0.160.0，Orca 会话 `a852f96a`）：P1 失败因人的 `config.toml` 触发 `error` item 且 MCP 被启动；P1b 失败因名单在真 `~/.codex` 下列；P1c／P1d 通过（input 10811／10109）。**一行提示的框架开销 10109–11590 input token**（profile 值归人）。全程 `~/.codex` 凭据 0 字节差。
- **残余**：refresh token 经软链轮换未验（新 token 若 rename 进私有目录，下次被挪成 displaced 并重链旧文件 ⇒ 人 `codex login`）；keyring 存凭据 ⇒ fail closed；control worker 的 `ccloop-agent-catalog:` 日志无生产 sink；omp 旧 `config.yaml`／`PI_CONFIG_DIR` 不进键；`notify=[]` 是否真挡住 notify 程序未量；点号 MCP 名拒；lstat 与建链之间同用户 TOCTOU；两条 7500 ms 冷复核判据余量约 0.7–1 s；provider 层首 token 前重试关不掉；`omitMaxOutputTokens` 模型与 OpenRouter 不发上限。历史 spec／plan 里「claude 窗口 null」是 ERRATUM 候选（`docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md:134,165-166`、`docs/superpowers/plans/2026-09-24-g1-capability-vocabulary.md:76,123,173,288,293`），未改。
- **known-reds 名单**：只加了 `codexAdapter`「outer watchdog kills…」；`verifySavedResult`「r1 command interruption…」已查清并修掉（EPERM，见「当前状态」）。**n＝1 断言形状候选**（未豁免，下次红先对照）：`phaseTimeoutUsage` codex「plan, execute and verify time out…」得 `codex-io-error`；`skillsController`「preserves plan skill cleanup failure across handoff-abort」`fixture marker missing`；`runCodexPhase`「kills a TERM-ignoring process…」`expected 'io-error' to be 'aborted'`；`runLoop.integration`「persists phase usage evidence…」。负载 flake 明细在 Orca `docs/handoff/known-load-flakes.md` 的 ccloop 段。
- **夹具**：`tests/setup/relocateCatalogCache.ts` 给每个测试文件一个空 `CODEX_HOME`（否则判据读到人的真 `~/.codex/config.toml`）；`tests/fixtures/fake-omp.mjs` 是可复用的 OMP 夹具。
- 外部反馈落在本仓的：#62 不采纳「加长退避」（被 `min(timeoutMs, timeRemainingMs)` 截断且占租约）；#50 不采纳「去 `--ephemeral`＋`resume --last`」。零成本探针：omp 18.10.1 对 `127.0.0.1` 也走 `HTTP_PROXY`，启动时探测本地 ollama（fake 上游要吃掉意外请求）。
- **人点名过的既有判据改写**（每条都在提交主题行或旁注 `Ruling:` 里，引用前去那一行看）：2026-10-13 两笔（`test(agents): rewrite the claude/codex-only kind criteria to include omp`、`test(omp): make two criteria independent of PATH's node and omp probe time`）；`ompUpdates`「preserves the unavailable reason…」超时 20 s；`ompSingleCall`「stops the call at the request's time limit…」；Orca 计划 E1–E5 与一揽子授权下的 `agentCatalog.test.ts:42`、`catalogProbe.test.ts:150,153`。**「按你的建议办」不是改判据的授权。**
- Qoder 钩子已从主仓移除（2026-10-15，人授权；Qoder 应用再启动可能重写）；本仓 `core.hooksPath` 未设。

---

## 仍然挂着的

| 挂账 | 现场 |
|---|---|
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

# 📌 Orca 那条线（单节滚动 —— 每轮【就地整段替换】本节，只放指针，不新增 Orca 章节；2026-10-24，Orca 会话 `ffec7b28`）

- 详情只看 Orca handoff（`/Users/biran/code/skills/orca/Orca/docs/handoff/handoff.md`）§3 最新一节与 §4。Orca 已 **repin 到本仓 `f4de340`**（Orca 先接受 `transcripts`／`operatorNote` 再钉；Orca 侧读取器/UI 在 Orca 分支在飞）。
- **H7 多仓**：本仓 `feat/multi-repo` 已合入并已推（人已确认 P1–P7、M9、As-built 1–10）→ 下一步 Orca 接受 `additionalRepos`/`dirs` 并做 H7。Orca pin 仍是 `f4de340`，**等 Orca 真正消费多仓字段时再 repin**。真跑验收：codex 可跑（claude 无额度），付费真跑每次先问人。
- ⚠️ 沙箱里跑本仓必须 export `CCLOOP_CACHE_DIR`；真 codex 每跑一次往人的 `~/.codex/config.toml` 追加一条 trust 条目（软链进私有 CODEX_HOME 的结果，登记未修）。
- **Orca 依赖本仓、改之前先同步 Orca 的**：同前（`single-call-output-invalid`；collect 顶层 `decisions`、`debug`（含 `located`）、`flow`、`failureCause`、`toolRules`、`transcripts`；features `transcripts:"v1"`；envelope `work.priorFailures`、`work.operatorNote`；`executionPolicy.toolRules`；codex wire `flow` 的封闭形状；`contextWindowSource`；`agent-version-drift` 措辞；`control agent-installation-observe`；`refs/ccloop/*`；fake 参数约定；`blockRun` 原因串；`isRepeatedFailure`）。Orca 的 collect/features 解析是 strict——加键先让 Orca 接受。
- ⚠️ Orca 主仓和服务用 `node_modules` 里装的本仓：repin 后主仓先 `npm ci`。Orca 测试的 `ORCA_CCLOOP_BIN` 用 pin 那笔的 clone build；别指本仓工作树的 `dist`。Orca 的测试规则不外溢到本仓（Orca Rule 16）。
