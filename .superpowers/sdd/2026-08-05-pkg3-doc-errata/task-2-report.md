# 任务 2 报告 — §5.2 债 3 归类矛盾 ＋ §16「第 11 行」锚点歧义

## 状态

DONE。两个站点均已勘误，修复环第 1 轮已处理评审员的 1 条 Important（§17 F1 行同族「第 11 行」引用漏改），测试无回归（30 files / 514 tests / exit 0）。已提交到 `docs/pkg3-errata`：`26b0709`（初次交付）＋ `ce934c4`（修复环第 1 轮）。3 条 Minor 按控制器指示未动，留给整分支评审分诊。

## 站点 A — 原句、勘误正文、理由

**文件**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`
**当前行号**（HEAD 在任务 1 之后已移位；用逐字引用定位，未按 brief 里的旧行号 `:1143` 跳转）：原句在 `:1151`。

**三段事实核验（自己重新读过，逐条确认）**：

1. §5.2 结尾 `:1151` 今天逐字仍是（改动前）：
   > **因此一次并发 `stop()` 完全可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 改动 A 不覆盖这一段，本层也不覆盖它（覆盖它要么把 artifact 写搬进 span——L1b 刚刚明确否决过——要么另设一层守卫）。**§13 据此把债 3 记为「exclusive span 部分关闭」，span 外那段具名传给 L5。**
2. §19 G10 处置正文（今位于 `:2374`、`:2376`）逐字确认与 brief 引用一致，仍写着「债 3 记为本层关闭；span 外那段作为本轮新发现具名传 L5」。
3. G10 表行（今位于 `:2828`）「修订处」列逐字为：`§13 表、§13「债 3 的归类更正」（引裁决记录 :189 全句）、§13 第 3 笔（措辞改为「本轮新发现，需重新裁归属」）、§14 第 1 条` —— 四处，**没有 §5.2**。
4. 额外核验：§13 表（`:2330`）、§13「债 3 的归类更正」小节（`:2351`）、§13 第 3 笔（`:2345` 与 `:2431`）、§14 第 1 条（`:2459`）**四处今天均已按 G10 改到位**（brief 说「若认为四处有哪处没改到位，写报告不要动手」——核验结果：四处都已改到位，无需上报）。

**判定确认**：§5.2 `:1151` 确实是全文唯一一处仍用主动语态宣告「债 3 部分关闭」旧归类的地方，且被 G10 的修订清单漏掉 —— 与 brief 的判定一致，矛盾属实。

**勘误正文（就地追加，原句一字未动）**：在 `:1151` 原句后另起一段插入：

```
**Amended 2026-08-05：上一句对债 3 的归类已被 §19 的 G10 更正。** 债 3 记为**本层关闭**（裁决记录对债 3 要的是显式表态，不是全域关闭，本层已按可接受方式表了态，按裁定它是关闭的）；span 外那段（`writeBoundaryArtifacts` 与其前置 `assertHeld`）是**本轮新发现、从未被任何裁决记录处理过的独立事实，归属应当重新裁**，不是「债 3 的未关闭部分」。完整论证见 §13「债 3 的归类更正」与 §19 的 G10。
```

**理由**：
- 满足 brief A.3 三个要点：(1) 明写已被 G10 更正、债 3 记为本层关闭；(2) 明写 span 外那段是本轮新发现、从未被裁决处理过、归属待裁；(3) 指向 §13 与 §19 G10 两个可跟过去的位置。
- **边界遵守**：只加勘误段，原句技术论证（并发 `stop()` 可在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`；改动 A/本层均不覆盖这一段）一字未动，因为这些结论今天仍然成立。
- **没有触碰 §13/§14/§19**：那四处已被 G10 改过，本次未重复编辑，避免制造第二处矛盾。
- **格式**：采用 `Amended` 段而非直接改写，理由与站点 B 不同 —— 这里改的是**归类结论**（技术性判断的变化），不是单纯的锚点指向错误，遵循仓库「就地注解、不改原件」的默认立场，与本文档其它 9 处 `Amended` 用法一致。

**diff 校验**：`git diff --numstat` 对本节改动只产生 `+2 / -0`（新增一段 + 一个空行），无删除，符合房规。

## 站点 B — 原句、勘误正文、理由、格式选择理由

**文件**：同上。**两处当前行号**：`:209`（§4.0.4 正文，未移位——任务 1 的插入点都在其后）、`:2721`（§16 表头上方，brief 旧行号 `:2703`，已因任务 1 的插入下移 18 行）。

**事实核验**：
- §16 表（今 `:2735`–`:2736`）确认同时存在两行：`11`（S-3 退路完全遗漏 → §4.0.1–4.0.3，有效未被推翻）与 `11b`（「更宽不是更窄」伪造论证结构 → §4.0.4 就地更正，行内自带「不要把这一行当成『已修好』继承下去」的显式警告）。
- `:209` 原句：「…(a) 是本 spec 自己造出来再打倒的——裁决记录从未把它列为「更窄」的依据。**§16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。**」—— 上下文谈的是那条**伪结构**，指的正是 `11b` 行，但写成「第 11 行」。
- `:2721` 原句：「初稿的 Critical 级缺陷，逐条对应本文修订处。**本表的第 11 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行仍然有效。**」—— 同样在说 `11b`，写成「第 11 行」。
- 两处字面都会让读者把**有效未推翻**的 `11` 行误读为「错的/已更正」。判定与 brief 一致：坏的是锚点，不是内容本身。

**勘误正文（直接改写原句，理由见下）**：

1. `:209` 改为：
   > §16 第 11b 行还把这个伪结构固化进了修订索引——该行已在第二轮就地更正，并自带「不要把这一行当成『已修好』继承下去」的警告，今天不存在会被 L5 无察觉继承的风险。

   处理了两个问题：(a) 锚点从「第 11 行」改为「第 11b 行」；(b) 原句「会被 L5 继承」是写于 `11b` 被更正之前的未来时危害预告，`11b` 今天已自带显式警告，这句预告已不成立，改写为陈述今天的状态。

2. `:2721` 改为：
   > 初稿的 Critical 级缺陷，逐条对应本文修订处。**本表的第 11b 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行（含第 11 行）仍然有效。**

   在「第 11 行」后加「（含第 11 行）」，明写有效的 `11` 行不在被否定之列，消除「其余各行」是否捎带把 `11` 行也算进「错误结论」里的歧义。

3. 表内 `11`、`11b` 两行（`:2735`–`:2736`）**一个字未改**——`git diff` 已核实这两行不在 diff 范围内。

**格式选择理由（直接改写 vs Amended 段）**：选择**直接改写原句**，不挂 `Amended` 段。理由：
- brief B.3 的「格式选择」一节明确把这两处定性为**锚点更正**（不是技术论证的变化），并明写「可以直接改写原句而不必挂 `Amended` 段」——这是本仓库「就地注解、不改原件」立场下**被 brief 显式授权的例外**。
- 与站点 A 的区别：站点 A 改的是一句会被 L5 当结论继承的**技术归类判断**，保留原句 + 追加注解能让读者看见「结论如何演变」；站点 B 改的只是**指代哪一行表格**的字面指向错误（`11` vs `11b`），原句所在段落已经是「修订索引」这种高频被引用、追求索引式精确指向的文本类型，若挂一段 `Amended` 反而会在已经很密集的交叉引用网络里再加一层间接引用，让读者要多跳一次才能拿到正确锚点，与「索引」这一文本体裁的效用相悖。
- `:209` 处的「会被 L5 继承」半句同样按直接改写处理，因为它与锚点错误同句、同因（都源于「以为 11 行错了」的同一次误写），拆成两种格式反而割裂同一处勘误的可读性。

**diff 校验**：`git diff --numstat` 本节改动为 `+2 / -2`（两行整句替换）。逐条解释删除：
- 删除 `:209` 旧句「…§16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。」→ 替换为新句（锚点 + 已腐坏的未来时危害预告，两处都改）。这是 brief 授权的锚点更正例外，非「新增删除原句」的房规违反。
- 删除 `:2721` 旧句「…本表的第 11 行在第二轮被判定为错误结论…」→ 替换为新句（锚点 + 补一句消歧）。同上，锚点更正例外。
- 两处删除均为**同句改写**，不是删掉信息；改写前后表达的判断（哪条结论错、哪条仍有效）未变，只是把指代目标从模糊改为精确。

## 验证输出（未过滤）

命令：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npm test -- --run"
```

**RUN 路径行**：` RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop` —— 与验收要求一致。

**完整输出**（未过滤，`grep`/`tail` 均未使用）：

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/sweep/sweepRuns.test.ts (13 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 407ms
 ✓ tests/registry/zeroWrite.test.ts (5 tests) 457ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/renderRuns.test.ts (11 tests) 8ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 5ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-YjSPIy/does-not-exist'

 ✓ tests/registry/scanRuns.test.ts (9 tests) 5ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-CuwNra/run-1  observed 2026-08-05T16:37:01.594Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/persistence/fileStore.test.ts (76 tests) 1726ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1336ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 7ms
 ✓ tests/cli/cli.test.ts (23 tests) 1336ms
   ✓ parseArgs > returns 0 for the scripted example run 357ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 33ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 27ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 5ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2500ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 322ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 18ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3034ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 349ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 303ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 307ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 386ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 372ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 379ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 323ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 486ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 270ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 5ms
 ✓ tests/validation/fixture.test.ts (2 tests) 554ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 552ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2468ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 650ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 573ms
   ✓ render-contract CLI > rejects a non-git repository path 644ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 592ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 6871ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 584ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 534ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 599ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 502ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 370ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 373ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 368ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 354ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 11142ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 336ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 864ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 11937ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 3155ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 588ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 366ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 362ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 399ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 400ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 482ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 367ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 546ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 474ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when execute is interrupted 436ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 524ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 532ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 388ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 551ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 385ms
 ✓ tests/validation/evidence.test.ts (39 tests) 16025ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1418ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1160ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2639ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1561ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1608ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1585ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 599ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 606ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 594ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 960ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 594ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2523ms

 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  00:36:59
   Duration  16.72s (transform 2.59s, setup 0ms, collect 3.94s, tests 58.87s, environment 4ms, prepare 1.69s)
```

**结论**：30 files / 514 tests / exit 0（隐含于 vitest 全绿输出，进程无非零退出）——与基线一致，**无回归**。stderr/stdout 里出现的几行是被测代码在测试用例内**故意触发**的日志（缺失必填 flag、scandir ENOENT、损坏行的诊断输出），均属预期内测试夹具行为，不是失败迹象。

## 收尾自查命令输出与逐条解释

```
grep -n "第 11 行" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
```
输出：
```
2721:...itical 级缺陷，逐条对应本文修订处。**本表的第 11b 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行（含第 11 行）仍然有效。**
```
解释：唯一命中是我改写后的 `:2721` 句子本身，其中「第 11 行」出现在「（含第 11 行）」这个消歧短语里，紧跟在「第 11b 行」之后，指代明确（有效未推翻的那一行），**不再是歧义命中**。原先另一处歧义命中 `:209` 已被改成「第 11b 行」，不再匹配这个 grep 模式。**预期达成**：不再有任何一处歧义的「第 11 行」。

```
grep -n "部分关闭" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
```
输出：
```
1151:...——L1b 刚刚明确否决过——要么另设一层守卫）。**§13 据此把债 3 记为「exclusive span 部分关闭」，span 外那段具名传给 L5。**
2376:- **归类错误的实际危害**：写成「债 3 部分关闭」会让 L5 以为自己继承的是一笔**已被裁决过归属**的债，从而不再重新裁决；而它其实是一条**从未被任...
2830:...| Important | §13 把债 3 归为「部分关闭」错了：裁决记录对债 3 要的是**显式表态**，本层已按可接受方式表了态，**按裁定它是关闭的**...
```
逐条解释：
- `:1151`：这是**保留的原句**（房规要求只加不删），紧接着 `:1153` 就是我插入的 `Amended` 段落，把它更正为「本层关闭」。原句留在这里是**故意的**——它是被更正的对象，不是仍然为真的断言。
- `:2376`：这是 §19 G10 处置正文（早于本次改动、任务 1 之前就已存在）里，**用引号引述**旧的错误措辞「债 3 部分关闭」来解释「归类错误的实际危害」——句子结构是「写成『债 3 部分关闭』会让 L5……」，是在描述一个反面教材，不是在断言它为真。合法命中。
- `:2830`：G10 表行（同样早于本次改动），描述的是「§13 把债 3 归为『部分关闭』**错了**」——同样是引述被更正的旧结论来说明为什么错，不是断言。合法命中。

**结论**：三处命中都可解释，均为「引述被更正的旧结论」这一合法类别，没有遗留未被勘误覆盖的、仍以主动语态断言「部分关闭」的地方。

## 提交

分支：`docs/pkg3-errata`（未切分支、未碰 main、未 push、未 rebase/amend 任务 1 的提交）。
提交 hash：`26b0709`。
主题行：`docs(errata): 就地更正 §5.2 债 3 归类矛盾，消歧 §16「第 11 行」双锚点`。
改动文件：仅 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（`+4 / -2`）。
`.superpowers/sdd/2026-08-05-pkg3-doc-errata/task-2-report.md` 本身被 `.superpowers/sdd/.gitignore` 忽略（与任务 1 的报告文件一致），未纳入提交。

**机械判据自查（评审员给的两条）**：
1. `git diff --numstat`：删除列为 2（均在站点 B，见上方站点 B 节逐条解释），不是 0——但 brief B.2/B.3/「格式选择」三处都明写站点 B 的锚点更正**是唯一允许产生删除的地方**，且要求「逐条解释每一处删的是什么、为什么必须删」，已在站点 B 节完成。站点 A 的 diff 是纯增（`+2 / -0`），符合默认房规。
2. 每条 `部分关闭` / `第 11 行` 相关命中「要么紧邻 `Amended`、要么在免动清单里」：`:1151` 紧邻其后 `:1153` 的 `Amended` 段；`:2376`、`:2830` 落在 §19 G10 免动范围内；`:2721` 是站点 B 直接改写后的文本本身（brief 授权的锚点更正例外，不适用 `Amended` 判据）。全部满足。

## 不确定 / 认为 brief 判错的地方

- brief A.3 边界要求核验 §13/§14/§19 那四处 G10 已改到位（若没改到位要上报、不要动手）。已逐一核对四处（§13 表 `:2330`、§13「债 3 的归类更正」`:2351`、§13 第 3 笔 `:2345`/`:2431`、§14 第 1 条 `:2459`），**均已改到位**，无需上报，未动手。
- 站点 B 的 `git diff --numstat` 删除列为 2、非 0，与评审员给的机械判据字面「删除列应为 0」不完全一致；但 brief 原文明确把站点 B 的锚点更正列为唯一允许产生删除的例外，且我已逐条解释。这是 brief 内部自洽的设计（判据本身写了例外条款），不是我对判据的偏离，仅在此提请复核确认。
- 站点 B 的格式选择（直接改写 vs Amended）brief 明写「你选哪种都行」，我选了直接改写；这是一个主观判断，已在报告里给出理由，但承认另一位实施者选 Amended 段也同样合规，非唯一正确答案。
- 除此之外没有发现 brief 判据与今天文档内容不一致之处。

## 修复环第 1 轮

### 态度：同意

评审员的判定成立，独立复核（`grep -n "第 11" ...`）确认命中 3 行，第三处 `spec:2751`（§17 F1 行「修订处」列 `§4.0.4、§16 第 11/11b 行`）此前确实漏改。我上一轮报告里的「不再有任何一处歧义的『第 11 行』」是用 `grep -n "第 11 行"` 这个收窄模式支撑的全称否定——该模式结构上匹配不到「第 11/11b 行」（中间是斜杠不是空格＋「行」），命中面本身就不覆盖断言的范围。这是我的责任：全称否定的验证面由我核实，不能因为命令是 brief 给的就免责。接受这条 Important，不改判据。

### 改了什么

只改 `spec:2751`（§17 F1 行「修订处」列）一处：

```
- | F1 | Critical | §4.0 伪造裁决记录的论证结构：把「更窄」说成有两条依据、其中 (a) 被驳倒；实际「更窄」只有一条依据且成立，(a) 是另一条独立否决 | §4.0.4、§16 第 11/11b 行 |
+ | F1 | Critical | §4.0 伪造裁决记录的论证结构：把「更窄」说成有两条依据、其中 (a) 被驳倒；实际「更窄」只有一条依据且成立，(a) 是另一条独立否决 | §4.0.4、§16 第 11b 行 |
```

`git diff --numstat` 本次改动：`1  1  docs/.../2026-08-01-sweep-and-transactional-continuation-design.md`——一行改、一行加，同行替换（表格单元格内文本，diff 工具按行计），F1 的缺陷摘要、级别列，以及 §17 表其它任何一行一字未动。三条 Minor（本轮台账记录、不属于本次修复范围）未碰。

### 新的完备性自查（覆盖面自证）

放弃 `第 11 行`（结构上漏掉「第 11/11b 行」这种斜杠拼接写法），改用不含「行」字的更宽模式 `第 11`，理由：该模式覆盖「第 11 行」「第 11b 行」「第 11/11b 行」等一切以「第 11」开头的写法，命中面严格包含旧模式。

```
grep -n "第 11" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
```
输出（3 行，逐条解释）：
```
209:...—裁决记录从未把它列为「更窄」的依据。** §16 第 11b 行还把这个伪结构固化进了修订索引——该行已在第二轮就地更正，并自带「不要把这一行当成『已修好』继...
2721:...itical 级缺陷，逐条对应本文修订处。**本表的第 11b 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行（含第 11 行）仍然有效。**
2751:...论证结构：把「更窄」说成有两条依据、其中 (a) 被驳倒；实际「更窄」只有一条依据且成立，(a) 是另一条独立否决 | §4.0.4、§16 第 11b 行 |
```
- `:209`：「第 11b 行」，明确指代唯一。
- `:2721`：「第 11b 行」+「（含第 11 行）」的消歧短语，「第 11 行」出现在消歧短语内、指代明确（有效未推翻的 `11` 行）。
- `:2751`：本轮刚改的 F1 行，现读作「第 11b 行」，明确指代唯一。

**命中数从 1（上一轮用窄模式得到的假阴性）变为 3（新模式，且逐条可解释）——3 处全部无歧义。**

**我验过、也没验的面，明写**：
- 验过：本文件内所有「第 11」开头的写法（上面 3 行）；`11b` 全文出现的 4 处（`:209`、`:2721`、`:2751`、表内 `:2736` 本行自己）均一致指向同一行，无第四种写法（无全角数字、无 `11 b` 带空格写法）。
- 验过：本 spec 文件之外的仓库范围——`grep -rn "第 11 行\|11/11b\|11b/11" --include="*.md" .`（排除 node_modules）只命中 `.superpowers/sdd/` 下的 SDD 过程文档（brief、review、progress 等，均已被 `.superpowers/sdd/.gitignore` 忽略，不是交付物，是本轮修复过程中产生/existing 的评审记录，不在勘误范围内）；`docs/` 目录下没有其它文件引用这个「第 11 行」锚点。
- 补验：非 `.md` 后缀文件（`.ts`/`.json`/`.js`，排除 node_modules）——`grep -rn "第 11 行\|第 11b 行\|第 11/11b" --include="*.ts" --include="*.json" --include="*.js" .`，**0 命中**。代码/JSON 里没有引用这个 markdown 章节锚点。

### 验证

只改了一行 markdown 单元格文本，未触及任何 `.ts` 文件，`tsc` 未重跑——理由：改动不在类型检查范围内（纯 markdown），且上一轮已跑过 `npm test -- --run` 全绿，本轮改动与代码路径无交集。

`npm test -- --run`（`ECC_GATEGUARD=off DISABLE_OMC=1`）：
- RUN 路径：` RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop` —— 正确。
- 结果：`Test Files  30 passed (30)` / `Tests  514 passed (514)`，进程退出 0（vitest 全绿，无非零退出）。与基线一致，**无回归**。
- 完整输出未过滤（stderr/stdout 里出现的几行是测试夹具内故意触发的日志，同上一轮报告已解释的同一类）。

### 提交

新提交（未 amend `26b0709`）：`ce934c4`。分支仍是 `docs/pkg3-errata`，未碰 main，未 push。`git log --oneline -2` 确认：`ce934c4`（本轮）在 `26b0709`（上一轮）之上，working tree 干净。
