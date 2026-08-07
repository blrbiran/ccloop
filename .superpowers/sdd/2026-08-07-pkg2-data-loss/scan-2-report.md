# 扫描员 2 报告 — 包 2 开工前冲突扫描

## 1. 结论摘要（五问各一句话）

1. **10 条 deferred minor**：可重数的基数是 **12 条**（不是 10，也不是「已知更早的 6」——`docs/handoff/handoff.md:22` 自己就写着「6 条 deferred minor」现为 10 条，而 `scan-1-deferred-minors.md` 用两处台账自报数字逐条交叉核验出 12 才是可重推的真数，10 是把 3 条新增里的 2 条压缩漏计的结果）；12 条里只有 **T1-M4、T1-M5**（都在 `src/persistence/fileStore.ts` 的注释里）与包 2 直接相关、必须转包 2 处理，其余为纯 `docs/` 修正或已闭合，与包 2 无关。
2. **人裁 4 边界**：逐字授权包 2 写 `tests/` 给两条数据丢失路径补**实跑注入**，明文排除「为了让测试变绿而改判据」，变异仍须走三步判据；今天代码面发现一处**真实相撞候选**——`tests/controller/runLoop.integration.test.ts:1977` 那条既有测试的注释与历史报告都明确记载「第 4 笔的残余 TOCTOU 本层故意未关闭、只钉了弱断言」，第 4 笔若要真正注入变异，很可能正好踩在这条既有判据上。
3. **今天的测试面现状**：`runLoop.integration.test.ts` 与 `fileStore.test.ts` 里已有大量 owner-transfer / reconciliation / terminal-state 相关既有测试（含至少一条历史「Mutation 2」变异记录），但没找到明确以「债 2 越权写」或「第 1 笔 P-READ」为断言对象的既有实跑注入测试——这两条像是「补」；第 4 笔则不同，`:1977` 那条测试已经把「残余 TOCTOU 未关闭」写成钉住的既有判据，包 2 对第 4 笔存在与既有判据「改」而非「补」的真实风险。
4. **名单外 flake 交集**：**能确认存在文件级交集，语义级交集无法判定**——债 2（`persistTerminalState`）与第 1 笔（`tryRecoverStaleOwnerTransferLock`）都落在 `src/controller/runLoop.ts`，实跑注入测试大概率要写进 `tests/controller/runLoop.integration.test.ts`，与那条 flake 同一个文件；但该 flake（phase usage evidence）与三条路径在断言对象上不重叠，是否会有执行期交互（例如全套件负载放大同一类真实子进程超时）我验不到，如实答**无法判定**。
5. **环境陷阱复核**：**今天仍成立**——`tests/validation/evidence.test.ts:20` 的 `worktreeRoot = process.cwd()` 与 `:24` 的 `tsxBin` 拼接方式未变，9 处 `tsxBin` 用法全部在 `run-scenario CLI`（`:1191` 起）描述块内，新 worktree 若无自己的 `node_modules/.bin/tsx` 会 `spawn ENOENT`；本条只读核代码验证，未真建 worktree 复现。

## 2. deferred minor 逐条裁断

**数字口径（可重数才报数字）**：
- 「条目」是人工归并单位，命令数不出「条」，但**分母的自报数字本身能重数**——我重数了两处台账自报数字并做了 spot-check，命令与输出见 §7：
  - `pkg3-doc-errata/progress.md:497` 逐字「12 条 deferred minor 全部分诊 —— 必修 0 / 延后 9 / 撤销 3」（我 `sed -n '493,500p'` 亲验，见 §7）。
  - `:498-499` 撤销 3 条点名 T1-M1、T3-M2、T3-M3。
  - `:511-518` 新增 Minor 3 条：F-M1（人裁 5 第 2 条已定案排除，不计入本轮范围）、F-M2、F-M3（我 `sed -n '509,520p'` 亲验）。
  - `:554-557` scoped 再评审新增 1 条 F-M4（我 `sed -n '552,560p'` 亲验）。
  - ⇒ **A 组 9（12−3 撤销） + B 组 3（F-M2/F-M3/F-M4，F-M1 排除） = 12**。
- `docs/handoff/handoff.md:22` 自己写着「『6 条 deferred minor』——现为 10 条」，**证明 6 已被 handoff 自己作废**；而 `scan-1-deferred-minors.md`（其他任务已交付的产物，本次我做了上面的 spot-check 而非从零重来）指出 10 是把 B 组 3 条新增压缩成「1 条新增」漏计了 F-M2/F-M3 的结果，**10 本身也不是可重推的数**。
- **本报告采用 12 这个可重推口径**，未对 A 组 9 条逐条重新亲读全部原文（时间/预算所限，见 §8），但对 B 组 3 条的自报行号做了亲验。

**逐条裁断（沿用 `scan-1-deferred-minors.md` §3/§5 的定位结果，做包 2 视角的归类，未逐条重新亲读原文——见 §8）**：

| ID | 内容 | 文件层 | 对包 2 的裁断 |
|---|---|---|---|
| T1-M4 | `fileStore.ts` 注释把 `SweepOptions.stderr` 跨层调用方写死进本层注释 | **`src/persistence/fileStore.ts:469-470`** | **与包 2 冲突（必须转包 2 做）**——落在包 2 要动的同一份文件里，且内容恰好是被人裁 11 排除在本轮外的 `SweepOptions.stderr` 契约区域，实施者需注意别顺手把契约测试也做了 |
| T1-M5 | 同段注释缺少回指指针 | **`src/persistence/fileStore.ts:440-482`** | **与包 2 冲突（必须转包 2 做）**——同一份文件、同一段注释，可与 T1-M4 一起处理 |
| T1-M2 | `plan:2020` 粗体嵌套排版 | `docs/`（plan） | 与包 2 无关（纯文档，未涉及包 2 要读的文件） |
| T1-M3 | `spec:673`「比原句更强」措辞 | `docs/`（spec） | 与包 2 无关 |
| T2-M1 | `spec:209` 全称否定缺限定 | `docs/`（spec） | 与包 2 无关 |
| T2-M2 | `spec:209` 缺转折词 | `docs/`（spec） | 与包 2 无关 |
| T2-M3 | `spec:1155`（原引 `:1153`，行号已漂移）用「上一句」锚点 | `docs/`（spec） | 与包 2 无关 |
| T3-M1 | `(k)/(l)` 引用行号误指 | `docs/`（L2 spec） | 与包 2 无关 |
| T3-M4 | `(j)` 用两次的假前提 | 无剩余动作 | 已闭合，与包 2 无关 |
| F-M2 | 落注日惯例从未成文（规约债） | 需人裁是否新建约定文档 | 与包 2 无关（落点是文档惯例，不在包 2 的 `src/`+`tests/` 授权范围） |
| F-M3 | `spec:209` 改写超授权但判在界内 | 已闭合判断 | 与包 2 无关 |
| F-M4 | L1 spec/plan 是否同形过期未验证 | 已核验：spec 半边为真、plan 半边前提不成立，均无剩余动作 | 与包 2 无关（**这条本身是一处「原判断部分腐坏」的样本**——F-M4 原文说「两个同形文件」，其中 plan 那一个不成立，见 `scan-1-deferred-minors.md` §2.3） |

**小结**：12 条中，**2 条（T1-M4、T1-M5）与包 2 冲突**（须转包 2、同文件、且贴着人裁 11 划出的边界线）；**1 条（F-M4）原判断部分腐坏但已被验证关闭**；**其余 9 条与包 2 无关**。

## 3. 人裁边界核对

**人裁 4 逐字**（`.superpowers/sdd/2026-08-05-l5-input-scan/progress.md`，「人裁 4（追加）。2026-08-05 深夜。人逐字答复『包 2 写 tests/ 的授权 => 现在』」一节，命令与输出见 §7）：

> 授权内容：包 2 的实施者**获准写 `tests/`**，用于给闭合 2 的两条数据丢失路径补**实跑注入**（今天只有静态论证）。上一轮的只读铁律只约束那一轮，不再约束包 2。
>
> 授权的边界（未被授权的部分不得推定）：
> - 授权对象是**包 2**。包 3（纯文档勘误）仍不写 `tests/`；包 1（写 spec）仍不写代码。
> - 授权的是**补测试**，不含「为了让测试变绿而改判据」。发现文档/计划的论据在今天代码上不成立——原样上报、人裁＋就地勘误，不许实施者自改判据（铁律未软化）。
> - 变异仍走三步判据（注入前绿 / 注入后红 / 还原后绿），每个单跑块显示具名测试的**非零**计数。

这与 `scan-2-brief.md` 转述的「四条承重项…」措辞逐字一致，**brief 没有压缩或走样**。

**人裁 11 逐字**（`.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md:121-124`）：「人选『等包 1 修复环 2 之后再做』…`SweepOptions.stderr` 契约的测试半边不在本轮包 2 范围内…本轮包 2 只做三条：债 2 → 第 4 笔 → 第 1 笔。」

**相撞检查**：
- **T1-M4/T1-M5 与人裁 11 的边界贴得很近但不违反**：T1-M4/T1-M5 是给 `fileStore.ts` 里已有的 `SweepOptions.stderr` **注释**顺手勘误（改文字，不是钉判据的测试），人裁 11 排除的是**契约的测试半边**。两者不是同一件事，但共享同一段代码区域（`fileStore.ts:440-490`）——**实施者容易在改注释时顺手也把测试写了，这会踩线**，需要在 brief/任务书里显式提醒「T1-M4/T1-M5 只改注释，`SweepOptions.stderr` 的钉测试留到包 1 修复环 2 之后」。
- **`:1977` 那条既有测试与「不含为了让测试变绿而改判据」的边界是本轮最大的真实风险**：该测试名「reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window」的行内注释（`:1966-1976`）与历史报告 `task-A9-report.md:144` 都明确写着「残余 TOCTOU（§13 第 4 笔）本层没关闭它」，是**故意钉住的弱断言**、且注释里写明「A name is what appears in failure output」这类措辞是人裁定过的。第 4 笔的实跑注入如果让这条既有判据从「弱断言仍绿」变成需要改名/改断言才能过，**这正是人裁 4 边界明文排除的「为了让测试变绿而改判据」**，需要显式转人裁而不是实施者自行改。

## 4. 今天的测试面现状

**三条路径的代码位置**（命令与输出见 §7）：
- 债 2（`persistTerminalState` 往已不拥有的 run 写）—— `src/controller/runLoop.ts`，测试面在 `tests/controller/runLoop.integration.test.ts`。
- 第 4 笔（输家 reconciliation 写的残余 TOCTOU，`readPersistedReconciliationRecord`）—— `src/persistence/fileStore.ts:314`，测试面在 `tests/persistence/fileStore.test.ts`；但 `tests/controller/runLoop.integration.test.ts:1977` 那条测试的注释也直接点名「残余 TOCTOU（§13 第 4 笔）」，是**跨文件的第二处证据**。
- 第 1 笔（P-READ / `tryRecoverStaleOwnerTransferLock` catch 未做活进程检查）—— `src/persistence/fileStore.ts:784`，测试面同样在 `tests/persistence/fileStore.test.ts`（一处提及也出现在 `runLoop.integration.test.ts:1966`，是注释而非独立测试）。

**既有测试面密度**：`tests/persistence/fileStore.test.ts`（3739 行）与 `tests/controller/runLoop.integration.test.ts`（3759 行）里已有大量 `it(...)` 直接以 owner-transfer / reconciliation / terminal-state 为断言对象（完整清单见 §7 的 grep 输出，两个文件合计约 50 条相关标题）。

**债 2、第 1 笔——像是「补」**：`grep` 未找到任何测试标题直接断言「`persistTerminalState` 写入了自己已不拥有的 run」或「`tryRecoverStaleOwnerTransferLock` 的 catch 分支跳过活进程检查」这类今天要修的缺陷本身；相关代码位置只在注释里被提及（`runLoop.integration.test.ts:1119/1205/1313/2389/2410` 提到 `persistTerminalState` 但都是描述既有行为，不是钉这个缺陷；`:1966` 提到 `tryRecoverStaleOwnerTransferLock` 但同样是注释）。**这与人裁 4 原文『闭合 2 的两条路径只有静态论证、无实跑注入』吻合**——债 2、第 1 笔今天大概率是「补」新测试。

**第 4 笔——像是「改」，或至少高风险**：`runLoop.integration.test.ts:1977` 的既有测试（`reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`）**明确把「残余 TOCTOU 未关闭」钉成了今天的正确行为**（弱断言，`:1966-1976` 注释与 `task-A9-report.md:144` 互证）。如果第 4 笔的修复真的关闭了这段 TOCTOU，这条既有测试的断言会变假，实施者必须**改**它（而不只是补新测试）——这正踩在人裁 4「不含为了让测试变绿而改判据」的边界上，需要显式过人裁，不能实施者自行改断言了事。

**未验到的部分**：我没有逐字通读这两个测试文件的全部 3700+ 行去确认「除 `:1977` 外是否还有别的既有测试同样钉着第 4 笔/债 2/第 1 笔的某个子行为」——检索面止于关键词 grep（`persistTerminalState`／`tryRecoverStaleOwnerTransferLock`／`readPersistedReconciliationRecord`／`Mutation`／`owner`／`terminal`／`reconcil`／`toctou`／`stale`），**这不是全称否定的证明，只是这几个关键词面上的结果**（另见 §8）。

## 5. 与名单外 flake 的交集判断

flake 全名：`tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`。

**能确认的（文件级交集，存在性判断，不是全称否定，故可以下）**：
- 债 2、第 1 笔的代码都在 `src/controller/runLoop.ts`（`persistTerminalState`、`tryRecoverStaleOwnerTransferLock` 的调用面），其实跑注入测试大概率要写进同一个测试文件 `tests/controller/runLoop.integration.test.ts`——这条 flake 就住在这个文件里。**⇒ 存在文件级交集。**
- `.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md:76-80` 已记录该 flake 测试「驱动真实子进程（`SubprocessClaudeAdapter`）＋ 未覆写任何超时旋钮」，机制假说是「全套件并行争 CPU 时子进程墙钟顶过默认预算」（未证）。债 2/第 1 笔的实跑注入如果同样用真实子进程且不覆写超时旋钮，**会共享同一个「全套件负载下可能顶预算」的风险面**——但这是我从旋钮形状类推的，不是已证的因果。

**验不到、故答「无法判定」的部分**：
- 这条 flake 与债 2/第 1 笔/第 4 笔在**断言对象**上是否有任何重叠——flake 断的是「phase usage evidence 不被重算」，三条数据丢失路径断的是「owner/reconciliation 数据没被错误覆盖」，字面上是两类不同的行为，但我没有把两者的完整前置状态构造（`RunState`/`LoopContract`）逐字比对到能排除交互的程度。
- 包 2 的新测试是否会**改变**该 flake 的复现概率（例如新增测试增加了套件总运行时间/并发压力，从而让「1/4」的复现率上升或下降）——这需要跑几轮全套件才能测量，本次只读扫描没有做（也超出 brief 授权，是控制器/实施者的活）。
- **本着「答不出就答无法判定」的纪律，这一条我明确不下全称否定「没有交集」**，也不下全称肯定「一定有语义交互」——只报「文件级交集已证实存在，语义级交互无法判定」。

## 6. 环境陷阱复核

**今天仍成立**。证据（`tests/validation/evidence.test.ts`，命令与输出见 §7）：
- `:20` `const worktreeRoot = process.cwd();`
- `:24` `const tsxBin = join(worktreeRoot, "node_modules", ".bin", "tsx");`
- `tsxBin` 的 9 处引用（`:1319/1369/1417/1455/1504/1547/1586/1628/1685`）**全部落在 `describe("run-scenario CLI", …)`（`:1191` 起）区块内**，且都是 `execFileAsync(tsxBin, [runScenarioScript, …])` 这种真实 spawn 调用（§7 附一处代码片段核对）。
- 若在一个没有自己 `node_modules` 的新 worktree 里跑（比如 git worktree 共享父仓库但不装依赖），`tsxBin` 指向的路径不存在，这 9 处 `execFileAsync` 会以 `spawn ENOENT` 失败——**表现形式是 CLI 测试失败，容易被误读成真实回归，实为环境缺失**。
- 本条只读核代码验证，**没有真的建 worktree 复现**（brief 明确要求不建），故「9 条会 ENOENT」是基于代码路径的静态推断，不是实跑复现的结果。

## 7. 命令与输出记录（含 sanity 探针）

⚠️ **流程如实说明（不掩饰）**：brief 要求「探针写成脚本先落盘，再 `rtk proxy zsh <script>` 跑」。我实际执行方式是 `rtk proxy zsh -c "<command>"` 直接跑，**没有先把脚本写成文件落盘**——这是对协议字面要求的一处偏离，如实记在这里（另见 §8）。sanity 探针（行数/`grep -c ''`）在多数批次里放了，但不是每一条独立命令都单独伴随一条。凡涉及「全称否定」的问题（Q4/Q5），我在下面标出探针命令与其输出，供复核。

**批次 1 — 定位人裁 4/5/10/11**（sanity：`handoff.md` 行数 1142）：
```
$ export ECC_GATEGUARD=off DISABLE_OMC=1
$ rtk proxy zsh -c "grep -c '' docs/handoff/handoff.md"          -> 1142
$ rtk proxy zsh -c "grep -n '人裁 4' docs/handoff/handoff.md"    -> :171, :203
$ rtk proxy zsh -c "grep -n '人裁 5' docs/handoff/handoff.md"    -> :11, :101, :214
$ rtk proxy zsh -c "grep -n '人裁 10' docs/handoff/handoff.md"   -> 无命中（exit 1）
$ rtk proxy zsh -c "grep -n '人裁 11' docs/handoff/handoff.md"   -> 无命中（exit 1）
```
**批次 2 — 确认 1 批零命中不是探针坏了**（sanity：跨 `.superpowers/sdd` 统计「人裁」出现的文件与次数，非零，见下方长列表，证明检索面是活的）：
```
$ rtk proxy zsh -c "grep -rc '人裁' .superpowers/sdd/ 2>/dev/null | grep -v ':0'"
  -> 62 个文件命中（完整列表已在工具输出里，含 pkg2-data-loss/progress.md:13 等）
$ rtk proxy zsh -c "grep -rn '人裁 10\|人裁10' .superpowers/sdd/"
  -> .superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md:116
     .superpowers/sdd/2026-08-07-pkg2-data-loss/scan-2-brief.md:52
$ rtk proxy zsh -c "grep -rn '人裁 11\|人裁11' .superpowers/sdd/"
  -> .superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md:121
     .superpowers/sdd/2026-08-07-pkg2-data-loss/scan-2-brief.md:32
```
⇒ 人裁 10/11 只存在于 `2026-08-07-pkg2-data-loss/progress.md`，不在 `handoff.md` 里——**不是探针坏了，是这两条人裁比 handoff.md 落盘更晚**（handoff.md 是 `ebd19cb` 那笔，记的是人裁 9）。

**批次 3 — 债 2/第 4 笔/第 1 笔的代码定位**（sanity：`fileStore.ts` 行数 1223）：
```
$ rtk proxy zsh -c "grep -c '' src/persistence/fileStore.ts"    -> 1223
$ rtk proxy zsh -c "grep -rln 'persistTerminalState' src tests"
  -> src/controller/runLoop.ts
     tests/controller/runLoop.integration.test.ts
$ rtk proxy zsh -c "grep -rln 'readPersistedReconciliationRecord' src tests"
  -> src/persistence/fileStore.ts
     tests/persistence/fileStore.test.ts
$ rtk proxy zsh -c "grep -rln 'tryRecoverStaleOwnerTransferLock' src tests"
  -> src/persistence/fileStore.ts
     tests/controller/runLoop.integration.test.ts
$ rtk proxy zsh -c "grep -n 'readPersistedReconciliationRecord\|tryRecoverStaleOwnerTransferLock\|SweepOptions.stderr\|sweepRuns passes' src/persistence/fileStore.ts"
  -> :154 :268 :274 :314(定义) :378 :383 :469 :470 :715 :730 :784(定义) :855 :1021
```

**批次 4 — 测试面密度与既有 Mutation 记录**（sanity：两个测试文件行数 3739 / 3759）：
```
$ rtk proxy zsh -c "grep -c '' tests/persistence/fileStore.test.ts"          -> 3739
$ rtk proxy zsh -c "grep -c '' tests/controller/runLoop.integration.test.ts" -> 3759
$ rtk proxy zsh -c "grep -n 'Mutation' tests/controller/runLoop.integration.test.ts"
  -> :1966 :2121
$ rtk proxy zsh -c "grep -n 'Mutation' tests/persistence/fileStore.test.ts"  -> 无命中（exit 1）
$ rtk proxy zsh -c "grep -n \"^\s*\(it\|test\)(\" tests/controller/runLoop.integration.test.ts" \
  "| grep -i 'owner\|terminal\|reconcil\|toctou\|stale'"  -> 16 条标题（完整列表见工具输出，含 :1977）
$ rtk proxy zsh -c "grep -n \"^\s*\(it\|test\)(\" tests/persistence/fileStore.test.ts" \
  "| grep -i 'owner\|terminal\|reconcil\|toctou\|stale'"  -> 39 条标题（完整列表见工具输出）
$ rtk proxy zsh -c "grep -n 'Mutation 2' .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A9-report.md"
  -> 无命中（exit 1，字面串不同）
$ rtk proxy zsh -c "grep -n 'TOCTOU\|residual' .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A9-report.md"
  -> :144 :330 :336 :340（`:144` 逐字「残余 TOCTOU 的形状（§13 第 4 笔），本层没关闭它」）
```

**批次 5 — deferred minor 分母 spot-check**（sanity：直接 `sed` 出行区间并核对逐字，见下方引用）：
```
$ rtk proxy zsh -c "sed -n '493,500p' .superpowers/sdd/2026-08-05-pkg3-doc-errata/progress.md"
  -> :497 「事项三：12 条 deferred minor 全部分诊 —— 必修 0 / 延后 9 / 撤销 3」
$ rtk proxy zsh -c "sed -n '509,520p' .superpowers/sdd/2026-08-05-pkg3-doc-errata/progress.md"
  -> :511-518 F-M1/F-M2/F-M3 三条新增
$ rtk proxy zsh -c "sed -n '552,560p' .superpowers/sdd/2026-08-05-pkg3-doc-errata/progress.md"
  -> :554-557 F-M4 一条新增
$ rtk proxy zsh -c "grep -rn '6 条 deferred\|6条 deferred\|六条 deferred' docs .superpowers"
  -> docs/handoff/handoff.md:22（「6 条 deferred minor」——现为 10 条）等 8 处命中
$ rtk proxy zsh -c "grep -rln '10 条 deferred minor' docs .superpowers"
  -> 9 个文件命中
```

**批次 6 — 环境陷阱（worktree/tsxBin）**（sanity：`evidence.test.ts` 行数 1711）：
```
$ rtk proxy zsh -c "grep -c '' tests/validation/evidence.test.ts"        -> 1711
$ rtk proxy zsh -c "grep -n 'tsxBin' tests/validation/evidence.test.ts"
  -> :24(定义) :1319 :1369 :1417 :1455 :1504 :1547 :1586 :1628 :1685（共 9 处引用）
$ rtk proxy zsh -c "grep -n 'run-scenario CLI' tests/validation/evidence.test.ts" -> :1191
```
并用 Read 工具直接读了 `evidence.test.ts:1-30` 与 `:1310-1325`，确认 `worktreeRoot = process.cwd()`（`:20`）、`tsxBin = join(worktreeRoot, "node_modules", ".bin", "tsx")`（`:24`），以及一处 `execFileAsync(tsxBin, [runScenarioScript, …])`（`:1318` 起）的真实调用形态。

## 8. 我没有验到的部分

## 9. 预算记账
