# 任务 3 报告 — 四条跨文档勘误：D7 / D4 / spec:2306 / D12

## 状态

**DONE_WITH_CONCERNS**——四条全部落盘，测试无回归，唯一需要评审员留意的是「不确定/存疑之处」
第 1 条（一处 numstat 显示 `1 1` 但实为纯插入，已用逐字符 diff 自证）与第 5 条（brief 对
lane 2 "已补完勘误正文"的表述略有夸大，我据证据自撰正文，非照抄）。详见对应各节。

## 条目 1 — D7

**文件**：`docs/superpowers/specs/2026-07-28-run-registry-design.md`

**原句复验（编辑前，命令与输出）**：

```
$ grep -n "three debts\|Debts 1–3\|Debts 1-3" docs/superpowers/specs/2026-07-28-run-registry-design.md
57:6. discharge any of the three debts bequeathed to L5 (§13);
468:Debts 1–3 are bequeathed to L5 and are unchanged by this layer. This layer does
```
与 brief/lane 2 逐字一致。

**裁决记录复验**：

```
$ sed -n '18,23p;246,248p' docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
| 1 | reconciliation 合成责任无人认领       | **L3**（spec 内独立一节，先于触发逻辑） | ...
| 2 | `persistTerminalState` 往已不拥有的 run 写 | **L5** | ...
| 3 | `heartbeat.stop()` 释放窗口            | **L3** | ...
...
2. **L5 继承清单第 1 条描述有误**：「reconciliation 合成责任无人认领」不成立，见债 1。该条应改写为跨文件事务性缺陷，并从 L5 清单移到 L3。
3. **L5 继承清单第 4 条范围偏小**：漏了 `reconciliation-record.json`（`fileStore.ts:316`）。
4. **L5 继承清单现在只剩 1 笔**（债 2），不是 4 笔。
```
与 brief/lane 2 逐字一致，确认三件事：(1) 裁决表把债 1、3 判给 L3、只留债 2 给 L5；
(2) 「对 handoff 的更正」一节确有明写的执行项 `:246`/`:248`；(3) 与 §5.3 提到的
「勘误分布不均」一并核对（见下）。

**勘误分布复验**：

```
$ grep -n "Amended" docs/superpowers/specs/2026-07-28-run-registry-design.md
3, 28-29, 89, 173, 223, 267, 288, 376, 395, 515(现为 522，因本次新增两处偏移)
```
`:515`（编辑前）挂在 §13 第 4 条（`Amended (j)`），第 1/2/3 条下均无 `Amended`。
**我进一步核实了 lane 2 §5.3 未展开的一处**：第 3 条正文里确有一句指向 L3 方向的话
（"This debt must be re-evaluated by whichever layer adds a triggering caller...
deferred queue layer"），但**它不是 `Amended` 格式，也没有推翻上方 `:468` 的
"Debts 1–3 are bequeathed to L5"**——两句同节并存，与 lane 2 判定一致。

**落的勘误（原文一字未删，仅追加 `Amended (k)` / `Amended (l)` 两段——两处是不同文字，
用不同字母避免与既有 `Amended (j)` 重用同一字母造成的歧义再添一例）**：

- `:57` 后新增：说明「三笔债」已过期，债 1/3 已改判 L3，指向裁决记录 `:246`/`:248`，
  并点名「§13 below still lists three items under L5」。
- `:468` 后新增：**我起草时曾写「item 1 below 已有匹配的 Amended 注，item 3 没有」——
  重读原文后发现这是假的，item 1 和 item 3 都没有 `Amended` 标记（item 3 只有一句
  方向正确但格式不同的话）。已在落盘前自行改正，未把这句假话留在勘误里。**
  最终文本：明写「Neither item 1 nor item 3 below carries an `Amended` note」，
  并指出 item 3 的那句话不纠正本段的「bequeathed to L5」措辞。

**理由**：裁决记录是 2026-07-29 对本 L2 spec（2026-07-28）的下达指令，且指令逐字写明
执行结果（清单只剩 1 笔），今天两处正文原句未变，构成两处待勘误的过期断言。

**verbatim diff**（`git diff --numstat`）：`16  0`，删除列为 0，符合就地注解房规。

## 条目 2 — D4

**文件**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`

**原句复验（编辑前）**：
```
$ sed -n '113p' docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
...The same ruling deliberately gave up the losing process's synthesis of the
winner's reconciliation view; if that view is still wanted, assigning it to a
process that still holds the run is L5's problem.
```
逐字与 brief 一致。

**四要素逐条复验（自己重新读原文，不照抄 lane 2）**：

1. **人裁**——`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:34`
   （我这次读到的行号是 `:34`，非 brief 给的 `:36`——**行号确已移位，佐证 brief 关于行号会漂移的提醒**，
   逐字核对内容一致）：「L3 debt 1 transactionalises reconciliation so the SAME CAS publishes it.
   Human ruled: L3's transactionalisation SUPERSEDES L1b (e).」
   `:37`（brief 给 `:38`，同样漂移）：「L5's inherited-input list is unaffected in NUMBER...
   Record that this L1b-side assignment is now closed by L3 rather than inherited by L5.」
2. **评审员点名**——`:42`（brief 给 `:44`）：「Repo convention is an in-place *Amended (f)* note...
   NOT done here... Flag for the human.」
   ```
   $ grep -n "NOT done here\|Flag for the human" .superpowers/sdd/**/*.md 2>/dev/null
   .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:42:...
   ```
   （见完备性自查一节的补充命中范围）
3. **勘误至今不存在**——
   ```
   $ grep -n "Amended" docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
   ```
   编辑前只到 `(e)`（`:4,17,27,29,95,113,123,139`），无 `(f)`，与 brief 一致。
4. 因此编辑前 L5 读者读到的仍是「is L5's problem」——已用第 1 条命令核实。

**落的勘误**：在 `:113` 段落末尾（`is L5's problem` 句之后）追加 `**Amended 2026-08-02 (f)**`
段落，沿用文件既有的 `Amended <date> (letter): <粗体结论>. This corrects a defect in *this
document*...` 格式（与 (a)-(e) 同构），日期取自该 L3 台账文件的落盘提交日期
（`git log --diff-filter=A --format=%ad` → `2026-08-02`）。正文原句一字未删。

**关于「已被 L3 关闭」的措辞核实（brief 特别要求）**：我没有自己选一个更顺口的说法，
而是直接引用台账 `:37` 的原话「now closed by L3 rather than inherited by L5」作为勘误的
核心断言，理由与出处都是台账自己的原文，不是我的转述。

**verbatim diff**：`git diff --numstat` → `2  0`，删除列为 0。

## 条目 3 — spec:2306

**文件**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（§12）

**注**：编辑前该文件行号已从 brief 的 `:2301`/`:2306` 漂移到 `:2319`/`:2324`（§12 边界
`:2310`–`:2326`），符合 brief 关于行号漂移的提醒，逐字定位无误。

**原句复验（编辑前，命令与输出）**：
```
$ grep -n "界的是" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
1451: ⚠️ 但「--max-runs 界的是付费调用次数」这句话过头了（第四轮评审，Minor，就地更正）...
1460: 所以付费调用的上界是 N × maxAttempts，不是 N。准确表述：--max-runs 界的是...
2319: ⚠️ N 不等于付费调用次数（第四轮更正）：--max-runs N 界的是进入 runLoopFromState 的 run 数；
      ...付费上界是 N × maxAttempts。...把「横幅里的 N 就是付费次数」这个读法明确标为错误。
2324: 本节不界的东西，明写出来：--max-runs 界的是付费调用，不界事件追加。...这一笔具名传给 L5（§13）。
2903: | M2 | Minor | §6 那句「--max-runs 界的是付费调用次数」过头...
```
`:2319` 与 `:2324` 同在 §12（`:2310`–`:2326`），相距仅 5 行，且 `:2319` 把「N 就是付费次数」
明确标为错误读法，`:2324` 仍按这个被标错的读法写「界的是付费调用」——矛盾复验成立，与 lane 2 §7.2 一致。

**M2 处置方式复验**（为何没被同步）：`:2903` 第三列「§6 第 1 条与 §12 各补一段」——
逐字确认是「补一段」，不是「就地改」，与 lane 2 §7.3 一致，解释了 `:2324` 为何原句存活。

**落的勘误**：在 `:2324` 原句中间（「不界事件追加。」之后、「一次 sweep 扫到…」之前）插入一句
`⚠️ 就地更正`，指出「界的是付费调用」与本节上方 `:2319` 的 `N × maxAttempts` 更正矛盾，
并明写「不界事件追加」这半句不受影响、仍然成立、是交给 L5 的实质内容（未改动这半句本身的
任何字）。

**verbatim diff 的一处需要解释**：`git diff --numstat` 显示 `1  1`（不是 `1  0`），
**原因是该段落在源文件里是单个未换行的长行**，git 按行 diff 会把「整行替换」记成
一增一减，即使实际只是行内插入、没有删任何原有字符。我逐字核对过：新行 = 旧行的
「不界事件追加。」处切开、原样插入新句、旧行剩余部分原样接续，**没有一个原有字符被删除**
（用 `diff <(fold -w1 old) <(fold -w1 new) | grep '^<'` 核对，输出为空，无删除字符）。
这是本任务四处编辑里唯一一处 numstat 非 `0` 的删除列，特此点名解释而非默认它"过了自查"。

**理由**：`:2324` 是把「第 5 笔」交给 L5 的原句，L5 读者会连带读到一句已被同一文档自己
在 5 行之上标为错误的读法，必须就地消歧，且不能动"不界事件追加"这半句（那是第 5 笔交接的
实质内容，今天仍然成立）。

## 条目 4 — D12

**文件**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（§4.6，
编辑前 `:1020`，brief 给的 `:1012` 已漂移）

**原句复验（编辑前）**：
```
$ grep -n "代码零改动" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
1020:`preserveSuccessfulReconciliationIfNeeded` **代码零改动**。
```
下方紧邻一条「⚠️ 但第一轮修订给的理由已过时」的注，我读了它的完整正文，结尾逐字是：
「**两侧都不需要改它的代码**，所以结论「代码零改动」仍然成立，只是靠的是另一条依据。」
——**证实 brief 的判断**：这条注只否定了「早退」这个理由，末句反而重申「代码零改动」这个
结论本身仍成立，没有否定它。

**计划裁定复验**：
```
$ sed -n '223,231p' docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md
### 裁定三 —— §4.6「preserveSuccessfulReconciliationIfNeeded 代码零改动」这句话为假，予以推翻
...
裁定：改 §4.6 那句话，不去为了保住「零改动」而把整块判定上移。
理由：...今天返回 Promise<ReconciliationRecord>（...），返回类型里没有「不要写」这一格。
      三种被 spec 允许的实现里没有一种能让它一个字节不动——「零改动」在处置一落地后是一句
      必然为假的话...
```
逐字与 brief/lane 2 一致。

**代码侧复验（我自己去源码核实，未信任 brief 或 lane 2 的转述）**：
```
$ grep -n -A 8 "async function preserveSuccessfulReconciliationIfNeeded" src/persistence/fileStore.ts
392:async function preserveSuccessfulReconciliationIfNeeded(
393-  runDir: string,
394-  nextReconciliationRecord: ReconciliationRecord,
395-): Promise<ReconciliationWriteDecision> {
396-  if (nextReconciliationRecord.eligibleForContinuation) {
397-    return { kind: "write", record: nextReconciliationRecord };
398-  }
```
今天的返回类型确是判别式联合 `Promise<ReconciliationWriteDecision>`，与 `plan:231` 记录的
计划阶段形态 `Promise<ReconciliationRecord>` 不同——**函数确实改了，与 lane 2 §10.5 结论一致，
我未发现出入**（详见下一节）。

**落的勘误**：在既有「理由已过时」注之后追加一段 `Amended`，明写该注只否定理由、没否定断言
本身；引裁定三原句「这句话为假，予以推翻」；给出 `plan:231` 记录的改动前类型与今天代码的
改动后类型对照。原句「代码零改动」及既有注一字未删。

**verbatim diff**：本文件本次共两处编辑（含条目 3），合计 `git diff --numstat` → `3  1`；
本条目自身只新增了 2 行（1 段新文字 + 1 空行），未删任何原有行；文件的那 1 处删除列
属于条目 3 单行段落替换的产物，已在条目 3 一节解释。

## D12 措辞一致性说明

我的勘误措辞与 lane 2 §10.5 在**事实层面完全一致**：都认定「代码零改动」这个断言本身
（不只是理由）已被计划裁定三推翻，都引用同一条 `plan:225`–`:231` 与同一处 `fileStore.ts`
函数签名。**唯一差异是形式，不是事实**：lane 2 §10.5 是一段调查记叙（"我补齐了这两步，
缺口关闭"），不是可直接粘贴进 spec 的成品勘误句；brief 称其"已把勘误正文补完，可直接落"
略有夸大——我据 lane 2 摆出的证据自己撰写了符合本文件既有 `Amended` 格式的正文，
未逐字照抄 lane 2 的调查性叙述。

**关于 lane 2 提到的行号**：lane 2 §10.5 引用 `plan:225`–`:229`，我复验时读到裁定三标题
在 `:223`、裁定正文延伸到 `:231`（含理由段），比 lane 2 引用的范围多包含理由段一行——
这不是矛盾，只是 lane 2 引用了裁定的结论部分，我在勘误里额外引了理由段的类型对照句
（`plan:231`）以便读者不必跳文件核对。

**代码侧我核实到的返回类型**与 lane 2 §10.5 贴的 grep 输出逐字相同
（`Promise<ReconciliationWriteDecision>`），**没有出入**。

## 验证输出

**命令**：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npm test -- --run"
```

**完整未过滤输出**：

```

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/sweep/sweepRuns.test.ts (13 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 418ms
 ✓ tests/registry/zeroWrite.test.ts (5 tests) 455ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 5ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-lkZd0x/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-UoC8ab/run-1  observed 2026-08-05T17:12:36.749Z
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

 ✓ tests/registry/scanRuns.test.ts (9 tests) 12ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 1718ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1336ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/cli/cli.test.ts (23 tests) 1288ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 27ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 6ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 29ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 5ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2525ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 319ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 13ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 2998ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 368ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 323ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 357ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 389ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 390ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 469ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 312ms
   ✓ worktreeManager > creates and removes a detached worktree 311ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 574ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 573ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2440ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 620ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 574ms
   ✓ render-contract CLI > rejects a non-git repository path 617ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 621ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 6971ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 586ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 553ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 595ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 532ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 400ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 376ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 373ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 354ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 10925ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 323ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 734ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 12061ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 3160ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 592ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 370ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 358ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 367ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 368ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 364ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 375ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 385ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 374ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 353ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 505ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 555ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 522ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 499ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 402ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 548ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 381ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15798ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1429ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1155ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2627ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1544ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1525ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1524ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 589ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 594ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 579ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 955ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 590ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2505ms

 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  01:12:35
   Duration  16.46s (transform 2.27s, setup 0ms, collect 3.80s, tests 58.61s, environment 4ms, prepare 1.69s)
```

**`RUN` 路径行**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop` —— 与验收要求一致。

**独立 exit code 复核**：另跑一次 `rtk proxy "npm test -- --run" > /dev/null 2>&1; echo "EXIT:$?"`
→ `EXIT:0`。

**结论**：30 files / 514 tests / exit 0，与基线一致，**没有回归**。

## 收尾自查

四条命令，编辑后（修复环第 1 轮之后）跑，输出未过滤：

```
$ grep -n "three debts\|Debts 1–3" docs/superpowers/specs/2026-07-28-run-registry-design.md
57:6. discharge any of the three debts bequeathed to L5 (§13);
60:*Amended (k) — item 6's "three debts" is stale. The 2026-07-29 debt-attribution
475:Debts 1–3 are bequeathed to L5 and are unchanged by this layer. This layer does
480:*Amended (l) — "Debts 1–3 are bequeathed to L5" is stale. The 2026-07-29

$ grep -n "Amended" docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
4: ...marked inline as **Amended 2026-07-28 (a)–(e)**...
17: ...recorded as **Amended 2026-07-26 (c)**...
27: ...(**Amended (b)**) is untouched...
29: **Amended 2026-07-28 (a): ...
95: **Amended 2026-07-28 (b): ...
113: **Amended 2026-07-28 (e): ...is L5's problem.
115: **Amended 2026-08-02 (f): the preceding sentence's "is L5's problem" is superseded...
125: **Amended 2026-07-28 (c): ...
141: **Amended 2026-07-28 (d): ...

$ grep -n "界的是" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
1453, 1462, 2321, 2322, 2326（含新插入的 ⚠️ 就地更正句）, 2905  ——完整输出见「条目 3」与
「完备性自查」两节，此处不重复贴同一段长文本。

$ grep -n "代码零改动" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
567: ...⚠️ 与 §4.6 的一条冲突，本波只标不改...（既有指针，未改）
1020: `preserveSuccessfulReconciliationIfNeeded` **代码零改动**。（原句，未删）
1029: ...结论「代码零改动」仍然成立...（既有注，未改）
1031: **Amended（计划阶段裁定三，落在此处）**：...断言本身也已被推翻。（我新加的注）
```

四条命令均命中我新加的勘误段落，原句均一字未删。

## 完备性自查（本任务新增，超出 brief 收尾自查）

brief 的四条收尾自查命令都只在**单个目标文件**内搜索单一固定短语，本身就是"收窄的搜索面"，
不足以支撑"改完之后全仓不再有同族问题"这类全称断言。教训二明写了这一点，所以我在此另设计了
8 条更宽的命令，覆盖：(a) 目标短语在**整个仓库**（`.` + `--include="*.md"`）而不只是目标文件内
的分布；(b) 同一主张的**变体措辞**（中英文、加引号/不加引号、字序调整）。逐条命令与命中数：

1. `grep -rn "three debts" --include="*.md" .` → **2 处，均在**
   `docs/superpowers/specs/2026-07-28-run-registry-design.md`（原句 `:57` ＋ 我新加的 `Amended (k)` 注
   `:60`）。全仓无第三处。
2. `grep -rn "bequeathed" --include="*.md" .` → **4 处，全部同一文件**（原句 `:57`/`:475`，
   我新加的两条注各引用一次 `:60`/`:480`/`:486`）。全仓无第三处独立断言。
3. `grep -rn "三笔债\|三笔.*L5" --include="*.md" .` → **0 处命中**（中文变体不存在，说明 D7
   的断言在仓库里只有英文形态，我没有漏查中文同族表述）。
4. `grep -rn "L5's problem\|L5's problem" --include="*.md" .` → **2 处，均在**
   `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`（原句 `:113`，我新加的
   `(f)` 注引用它一次 `:115`）。全仓无第三处。
5. `grep -rn "是 L5 的问题" --include="*.md" .` → **0 处**（中文变体不存在）。
6. `grep -n "max-runs" ...design.md | grep -i "付费\|paid"` → **6 处，全部同一 §12 段落簇**
   （`:1453`/`:1462`/`:1476`/`:2321`/`:2326`/`:2905`，`:1453`/`:1462` 属于 §6 早已就地更正过的
   一批，`:2321`/`:2326`/`:2905` 是本条目所在的 §12 三处，`:2326` 是我改的那一句）。
   **未发现第四处未同步的旧措辞。**
7. `grep -rln "max-runs.*付费\|付费.*max-runs" --include="*.md" .` → **2 个文件**：本 spec 与
   同名 plan 文件——plan 文件命中的是 M2 处置记录（`:2905` 对应的源头），**不是**另一处独立的
   「界的是付费调用」断言，我读过内容确认不需要改。
8. `grep -rn "代码零改动\|零改动" --include="*.md" .` → **20 处**，我逐条读过：其中
   `docs/handoff/handoff.md` 的 3 处（`:661`/`:780`/`:884`）是**完全不同的主题**（分别是"本轮 spec
   轮代码零改动""相位计时修复代码零改动""注释改写代码零改动"，都不涉及
   `preserveSuccessfulReconciliationIfNeeded`），不是同族误述；spec 与 plan 里其余命中要么是
   `src/registry/` 或 `resumeLoop` 参数透传等**其它函数**的"零改动"（今天仍然为真，不属于 D12
   范围），要么是 `:567`（spec §4.3 第六波）**已经把「代码零改动」标为假**并把裁定推给计划阶段
   的既有指针（不是需要新增勘误的断言）。**在 `preserveSuccessfulReconciliationIfNeeded` 这个
   具体函数上，除 `:1020` 原句与我新加的 `:1031` 注之外，未发现第三处独立的「代码零改动」断言。**

**我没有覆盖的面（明写，不做无限定的全称否定）**：
- 未跑 `git log -S` 查这四条断言在**历史提交**里是否还有其它未合并分支/旧提交携带同族措辞——
  本任务只处理 HEAD 上的当前文档状态，历史提交不在 brief 的"就地勘误"范围内。
- `git status --porcelain -uall` 确认工作树内**无未跟踪文件**（输出为空），所以本任务的
  repo-wide grep 没有遗漏未跟踪文件这一类盲区——但这只覆盖本机当前工作树，不覆盖其他 worktree
  或已 stash 但未提交的内容（本会话未检查是否存在其它 worktree/stash）。
- 中文变体检查（模式 3、5）命中为 0，我只能确认"我试过的中文变体不存在"，不能排除**我没想到
  的第三种措辞**（比如同义改写、缩写）；这是我主观设计搜索词带来的天花板，不是机械穷举。

## 不确定/存疑之处

1. **item 3（`spec:2306`/今 `:2324`）的 `git diff --numstat` 显示 `1  1`，不是 `1  0`。**
   这不是我删了原句——已在「条目 3」一节用逐字符 diff 证明新行完整包含旧行的所有字符，
   纯属该段落是文件里未换行的单一长行、git 按行 diff 把"行内插入"记成"整行替换"的机械副作用。
   **仍然点名它**，因为它是本任务四处编辑里唯一一处 numstat 非 `(N, 0)` 的删除列非零情况，
   评审员如果只看数字会误判为违反房规。
2. **D7 我起草时曾写过一句不实的话**（"item 1 below 已有匹配的 Amended 注，item 3 没有"），
   在落盘前自己重读原文时发现是假的并改正了，没有让它进入最终提交。记在这里是为了不隐藏
   这个过程——它正好命中 brief 引用的教训一的形状（勘误正文本身携带新的不实断言），
   我在自己身上抓到了一次，改正后才落盘。
3. **`Amended` 字母沿用**：本文件（run-registry-design.md）已有的既有惯例把字母 `(j)` 用了
   两次指两处不同内容（`:288` 附近与我编辑前的 `:515`），这是文件自身已存在的不一致，
   不在本任务范围内（Rule 3，只改自己动的地方）。我给自己新增的两处分别用了 `(k)` 与 `(l)`
   两个不同字母，没有延续这个重用问题，但也没有回头去修文件里已有的 `(j)` 重复——那是既有
   缺陷，不是我引入的。
4. **D4 的 `(f)` 日期**：我标注为 `Amended 2026-08-02 (f)`，取自 L3 台账文件
   （`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`）的
   落盘提交日期（`git log --diff-filter=A --format=%ad` → `2026-08-02`），而不是评审员
   点名要求这条注的具体那一天（该台账文件本身跨越多天持续更新，我没有单独去查 Task A4
   人裁具体发生在哪一天）。若这个日期需要更精确，请指出。
5. **brief 称 lane 2 "已把 D12 的勘误正文补完，可直接落"**——我核实后认为这话略有夸大：
   lane 2 §10.5 是调查记叙，不是可直接粘贴的成品勘误句，我据其证据自己撰写了正文
   （详见「D12 措辞一致性说明」一节）。这不影响事实结论，但如果下一个读 brief 的人
   照字面预期"直接复制粘贴"，会扑空。
6. **完备性自查的中文变体检索命中为 0**——这只能证明"我试过的几种中文措辞不存在"，
   不能排除我没想到的第三种同族中文表述。已在「完备性自查」一节明写这个天花板，
   不作无限定的全称否定。
7. **未跑 `git log -S`** 核查这四条断言在历史提交（非 HEAD）里是否还有其它未清理的
   同族措辞。brief 的范围是"就地勘误"（针对 HEAD 上的当前文档），我认为历史提交不在
   范围内，但明写出来，不替 brief 做这个判断。

## 提交

- 分支：`docs/pkg3-errata`（未碰 main，未 push，未 rebase/amend 前两个任务的提交）
- 提交：`d5b3e79` — `docs(errata): 就地勘误跨文档四条 —— D7 三笔债、D4 L1b「is L5's problem」、spec:2306、D12 代码零改动`
- `git status --porcelain` 提交后为空，工作树干净。
- 改动文件（`git diff --numstat` 相对提交前的 HEAD `ce934c4`）：
  ```
  2  0  docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
  16 0  docs/superpowers/specs/2026-07-28-run-registry-design.md
  3  1  docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
  ```
  （第三个文件的 `1` 删除已在「条目 3」与「不确定/存疑之处」两节解释：单行长段落被
  git 按行 diff 记成整行替换，逐字符核对无实际删除。）

---

# 修复环第 1 轮（评审员：0 Critical / 4 Important / 4 Minor；本轮只处置 I1–I4 ＋ C1）

## 修复环状态

第 1 轮，评审员 0 Critical / 4 Important / 4 Minor。**本轮处置 I1–I4 ＋ 控制器发现的 C1，
4 条 Minor 一律未动（已交台账，留给最后整分支评审分诊）。** I1 我独立判断后选择「不改」，
并给出与评审员/控制器都不完全相同的理由；I2/I3/I4/C1 全部按要求修好。完备性自查过程中
**我自己又发现了一处同族问题**（D7 的 `(k)`/`(l)` 注同样缺日期——与 C1 同形，但评审员/控制器
都没点出来），已一并修复。详见下方各节。

## I1 — `:2322` 同族命中未裁

**结论：不改。** 我独立复核后认为 `:2322` 与 `:2326`（我已修的那处）在结构上不同族，理由如下
（不是照抄评审员或控制器任何一方，是我自己重读全句后的判断，与控制器的保守读法结论一致但
论证角度不同）：

**逐字重读 `:2322`**：
```
- 配额在「四道门全过、resume_adopted 已追加」那一刻计入（§6 的「计入时点改判」）。
  被门拒绝的 run 一次付费调用都没发生，让它吃掉配额既不符合「界的是付费调用」这个目的，
  又会造成确定性饿死。……
```

**与 `:2326`（改前）逐字对照**：
```
--max-runs 界的是付费调用，不界事件追加。
```

**区别（我的判断依据）**：
1. **句法形状不同**。`:2326` 是「`--max-runs` 界的是 X」——直接给 `--max-runs` 这个旗标下定义，
   与 `:2321` 第四轮更正「把『横幅里的 N 就是付费次数』这个读法明确标为错误」正面矛盾。`:2322`
   没有这个「A 界的是 B」句式，「界的是付费调用」在这里是一个被引用的**设计目的**短语，挂在
   「为什么拒绝的 run 不该吃配额」这条论证下面，主语是「配额计入时点该不该对齐付费风险」，
   不是「`--max-runs` 这个数字等于什么」。
2. **底层论证在更正后依然成立**。`:2322` 的实质主张是「被门拒绝的 run 零付费调用，让它吃配额
   是浪费一个名额在零花费的事情上，还会造成确定性饿死」——这条推理不依赖 N 是否恰好等于总付费
   次数，即使在「N 只界运行数、真实付费上界是 N×maxAttempts」的更正模型下依然成立：**已计入的
   run 至少发生过一次付费调用**（因为门是在 `resume_adopted` 之后才过），这仍然是"让计入的名额
   对应真实花费"这一目的的准确描述，不是"N 恰好等于付费次数"这个已被否定的读法。
3. **读者受害面不同**。`:2326` 是把第 5 笔债转交给 L5 的原句本身，L5 读者会把这句错误定义
   直接当作交接内容继承走；`:2322` 是 §12 内部一条解释"为什么这样设计计入时点"的论证支撑句，
   不出现在任何交接清单里，误读的下游影响小得多。

**我核实过控制器给出的"更保守读法"提示（"目的今天可能仍然成立"）与我自己独立分析的结论一致，
但我是先自己逐字对照两句的句法结构、再检查论证在更正后是否仍站得住之后才得出结论的，不是
直接采信控制器的提示。**

**没有做的事**：没有改动 `:2322` 任何一个字（保留房规：不反射性地把一句今天为真的话改掉）。

## I2 — L2 Index 漏记 (k)/(l)

**复验**：读了文首 Index（`docs/superpowers/specs/2026-07-28-run-registry-design.md:1`–`:38`），
确认 `(i)`/`(j)` 各自带来源说明（"Found while writing the implementation plan"、"Amended
2026-07-30 by that branch"），是一张持续维护的表，不是 07-28 那一轮的历史快照——评审员的判断
成立，我复核同意。

**已修**：在 `(j)` 条目之后追加两条，格式仿照 `(j)`/`(i)` 的"不是文档缺陷，而是后续事实变化"
句式：
```
- **(k)** §2 item 6 — "discharge any of the three debts bequeathed to L5" is
  stale, and unlike (a)–(i) this is not a document defect. It was accurate on
  2026-07-28; the 2026-07-29 debt-attribution ruling then reattributed debts 1
  and 3 to L3, leaving only debt 2 for L5. Amended 2026-08-06.
- **(l)** §13 — the same "Debts 1–3 are bequeathed to L5" claim, restated where
  the inherited-debts section opens. Amended 2026-08-06, same ruling as (k).
```

**顺带修的同族问题（自己审出来的，不在评审员/控制器点名范围内）**：正文里 `:66`/`:486`
（原 `:60`/`:480`）的 `*Amended (k)*`/`*Amended (l)*` 注**本身也缺日期**——与 C1 是同一种
缺陷（`Amended <日期>：` 房规），只是这次的评审员没抽检到。已补成
`*Amended 2026-08-06 (k)*`/`*Amended 2026-08-06 (l)*`，详见「修复环第 2 次完备性自查」一节。

## I3 — L1b 文首 Amendments 计数/全称在 (f) 落地后为假

**复验**：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:4` 逐字
「Amendments: five, all found by the final whole-branch review of the implementation and
marked inline as **Amended 2026-07-28 (a)–(e)** in §2, §5.1, §5.3, §5.4 and §6.」——两处坏了：
基数「five」、全称「all found by the final whole-branch review」。`(f)` 是 L3 task A4 人裁发现的，
不是那轮整分支评审找出来的，评审员判断成立。

**已修**：原句一字未删，紧随其后新插一行说明：
```
> **Amended 2026-08-06 — note on the count above**: the paragraph above describes only the
> original whole-branch-review batch and is left as-is. A sixth amendment, **Amended
> 2026-08-06 (f)**, now also exists in §5.3 (alongside (e)); it is not part of the
> "five... found by the final whole-branch review" — it corrects a later, separately-discovered
> defect (an L3 human ruling on task A4 superseding this document, not a finding from that
> review round). §5.3 is already in the location list above and needs no addition; only the
> count and the "all found by" qualifier are stale.
```

**§5.3 小节列表是否需要加节**（控制器"特别核一件事"里点名要查的第二问）：**不需要**。`(f)`
落在 §5.3（与 `(e)` 同一节——`:113` 上方的小节标题是 "### 5.3 Evidence for an abandoned
transfer"，我读过确认），而 §5.3 已经在原句"in §2, §5.1, §5.3, §5.4 and §6"里列出，不产生
第二处缺失小节名的问题。已在新插入的注里明写这一点，不是留白让下一个人自己查。

## I4 — (f) 的日期取错

**复验**：
```
$ git log --format='%H %cd' --date=iso -1 d5b3e79
d5b3e79db65c1d2427d0fa39d7d8583d092bc819 2026-08-06 01:17:57 +0800
```
与控制器测的一致，我原来标的 `2026-08-02` 是"被勘误事件发生日"（L3 task A4 人裁的日子），
不是"落注日"（我实际写这条注、提交它的日子）。同文件既有 `(a)`–`(e)` 全标 `2026-07-28`（做出
勘误那天），文首也写 "implemented and amended on 2026-07-28"——房规是落注日，我原来那条注确实
标错了。

**已修**：`Amended 2026-08-02 (f)` → `Amended 2026-08-06 (f)`，只改这一个日期字符串，前后文一字
未动。注末尾「landed now」与新日期不再矛盾（`2026-08-06` 正是本轮实际落盘的日期，见上面的
`git log` 复验）。

**关于"2026-08-05 还是 2026-08-06"的取舍**：本分支同一 session 里 811a2e7/26b0709/ce934c4 三笔
提交，即使实际提交时间已经跨过午夜进了 08-06，标注仍写 `2026-08-05`（沿用那次工作开始时的
"今天"）。我这次改用 `2026-08-06`，依据是：(1) 控制器点名时直接引用的是真实提交时间戳
`2026-08-06 01:17:57` 作为判据；(2) 本轮修复本身就是在 `2026-08-06` 这一天的会话上下文里做的，
用它标注今天新写的注，比借用一个已经过去的会话日期更准确。**这与三笔早前提交的既有标法不完全
一致，我没有回头去改那三笔——那是已提交的历史记录，不在本轮修复范围，且 Rule 3 不允许我顺手
"改正"别人的既有提交。** 明写在这里，供整分支评审判断是否需要作为 Minor 记一笔。

## C1 — D12 注缺日期

**复验**：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`
（编辑前 `:1031`）逐字开头 `**Amended（计划阶段裁定三，落在此处）：**`——房规是 `Amended <日期>：`，
本分支同文件其它 10 处全部带日期（`Amended 2026-08-05：` × 9、以及本轮我给出的 `Amended
2026-08-06：`），只有这一处漏了，控制器判断成立。

**已修**：
```
Amended（计划阶段裁定三，落在此处）：…
```
→
```
Amended 2026-08-06：…（计划阶段裁定三，落在此处）。
```
把日期补进标准位置，原来的"（计划阶段裁定三，落在此处）"说明移到句尾作为附注，内容一字未删，
只是位置挪动以腾出日期该在的位置。

## concern 3 认领：`(j)` 两次使用的说法为假

**认领**：我在初版报告「不确定/存疑之处」第 3 条写过「本文件已有的既有惯例把字母 `(j)` 用了
两次指两处不同内容……这是文件自身已存在的不一致」——评审员查证后指出这句话为假。我现在重读
Index 原句核实：
```
- **(j)** §8.1, §13 item 4 — the two "Atomic? no" rows are no longer true...
```
`(j)` 明写它覆盖**两个位置**（§8.1 与 §13 item 4），是**一条勘误、两个落点**，不是"同一个字母
被用来标记两条不同的勘误"。我当初的判断错了：我看到正文里 `(j)` 出现两次（`:301` 与 `:537`
一带）就直接推断"字母被重复使用标记不同内容"，**没有先去读 Index 里 `(j)` 词条自己怎么定义
它覆盖的范围**——这正是本任务反复强调的"自己去核实，不要凭表面模式下判断"，我这次没做到。

**这个错误判断造成的后果**：它是我"不去修文首标题"这个决定的（部分）依据之一——虽然那个决定
本身（不去改 `Amended 2026-07-28 in eight places (a)–(h)` 这句已经因 `(i)`/`(j)` 存在而过期的
标题）现在看仍然站得住（Rule 3，不在本轮范围内），但支撑它的理由不能包含这句假话。**已在此
认领，不再在报告任何地方援引"`(j)` 重复使用是既有不一致"这个错误说法。**

## 修复环第 2 次完备性自查

覆盖：上一轮四个断言族（重新全仓扫一遍，确认改动没产生新的未同步同族命中）＋ 本轮新引入的
`Amended` 日期与字母序列（这是上一轮没做过的新维度）。全部命令未过滤输出：

1. `grep -rn "three debts\|Debts 1–3\|bequeathed" --include="*.md" .` → **7 处，全部同一文件**
   （`docs/superpowers/specs/2026-07-28-run-registry-design.md`）：Index 里 `(k)`/`(l)` 两条
   （`:32`/`:36`）＋ 正文原句两处（`:63`/`:481`）＋ 正文 `Amended (k)`/`Amended (l)` 两条注
   （`:66`/`:486`）＋ 注文里回指 "bequeathed to L5" 措辞一处（`:492`）。全仓无第三处。
2. `grep -rn "L5's problem" --include="*.md" .` → **2 处，同一文件**（`:114` 原句、`:116` 我的
   `(f)` 注）。全仓无第三处。
3. `grep -n "代码零改动" ...design.md` → 同上一轮结果不变（`:567`/`:1020`/`:1029`/`:1031`/
   `:3005`，`:1031` 是我这轮补了日期的注），未发现新命中。
4. `grep -rn "界的是" docs/ src/ tests/` → **7 处**，与本轮开头复核一致：`spec:1453`/`:1462`/
   `:2321`/`:2905`、`plan:1473` 五处已带更正未动，`spec:2322` 本轮判定不改（见 I1 节），
   `spec:2326` 上一轮已改。**处置状态无变化，命中数无变化。**
5. `grep -n "Amended 2026-08-0[0-9]" docs/superpowers/specs/2026-07-28-run-registry-design.md
   docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
   docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` →
   **本轮新引入/修改的日期共 7 处，全部读作 `2026-08-06`**：L2 文件 4 处（Index 两条 `:35`/`:37`，
   正文两条 `:66`/`:486`）、L1b 文件 2 处（Index 注 `:5`、`(f)` 注 `:116`）、sweep spec 1 处
   （D12 注 `:1031`）。**无一处日期不一致**（都不是 `2026-08-05` 或其它日期）。
6. `grep -oE "^\- \*\*\(([a-z])\)\*\*" docs/superpowers/specs/2026-07-28-run-registry-design.md`
   → Index 字母集合 `{a..l}`（12 个，连续无跳号）。与正文实测的内联标记字母集合
   `{a,b,c,d,e,f,g,h,j,k,l}`（11 个，`i` 因为是纯新增行、历来无内联标记，不算缺口——已用
   `## 11.` 一节的 EACCES 行核实过）**逐一对应，无孤儿字母、无 Index 漏记、无正文漏记**。
7. **交叉检查（控制器"特别核一件事"的第一问——L2 的 Index 是否还漏记了别的字母）**：
   命令 6 的结果本身就是这个交叉检查的答案——Index 12 个字母与正文 11 个应有标记字母完全
   对应，**没有第二处遗漏**。

**本轮完备性自查发现的新问题（未被评审员/控制器点名，我自己查出并已修）**：
命令 5 之前，L2 正文的 `(k)`/`(l)` 注还没有日期（只有 `Amended (k)`/`Amended (l)`），
是与 C1 同族的缺陷。已在填这份报告前修复，命令 5 的结果是修复后的状态。

**未覆盖的面（明写，不作无限定全称否定）**：
- 仍未跑 `git log -S` 查历史提交里的同族措辞（原因同上一轮：范围是 HEAD 上的当前文档）。
- 仍未检查其它 worktree / stash。`git status --porcelain -uall` 本轮复核为空，工作树内无
  未跟踪文件。
- 中文变体检索（"三笔债"、"是 L5 的问题"）本轮沿用上一轮已跑过的 0 命中结果，未重新设计新的
  中文变体去试——如果这轮改动引入了新的中文措辞变体（它没有：本轮全部是英文正文 + 日期/字母），
  这个检索面不会捕捉到，但本轮性质上不产生新中文断言，风险低。

## 修复环第 2 次完备性自查 — 原始未过滤输出（吸取上一轮 M3 教训，不摘要，全部逐字贴出）

```
$ grep -rn "three debts\|Debts 1–3\|bequeathed" --include="*.md" .
docs/superpowers/specs/2026-07-28-run-registry-design.md:32:- **(k)** §2 item 6 — **"discharge any of the three debts bequeathed to L5" is
docs/superpowers/specs/2026-07-28-run-registry-design.md:36:- **(l)** §13 — the same "Debts 1–3 are bequeathed to L5" claim, restated where
docs/superpowers/specs/2026-07-28-run-registry-design.md:63:6. discharge any of the three debts bequeathed to L5 (§13);
docs/superpowers/specs/2026-07-28-run-registry-design.md:66:*Amended 2026-08-06 (k) — item 6's "three debts" is stale. The 2026-07-29 debt-attribution
docs/superpowers/specs/2026-07-28-run-registry-design.md:481:Debts 1–3 are bequeathed to L5 and are unchanged by this layer. This layer does
docs/superpowers/specs/2026-07-28-run-registry-design.md:486:*Amended 2026-08-06 (l) — "Debts 1–3 are bequeathed to L5" is stale. The 2026-07-29
docs/superpowers/specs/2026-07-28-run-registry-design.md:492:paragraph's "bequeathed to L5" framing. "L5 继承清单现在只剩 1 笔（债 2），
```

```
$ grep -rn "L5's problem" --include="*.md" .
docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:114: ...is L5's problem.
docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:116: **Amended 2026-08-06 (f): the preceding sentence's "is L5's problem" is superseded...
```
（`:114`/`:116` 全文已在上面「I2/条目 2」等节完整贴过，此处不重复贴两条动辄 100+ 词的长段，
但两条本身都已在本报告别处逐字出现过，不是被摘要掉、从未展示的内容——这与 M3 指出的问题
不同：M3 是"从未在报告任何地方展示过 `:2322` 的实际文字"，这里是"避免第三次重复贴同一段
已经贴过的长文本"。）

```
$ grep -rn "界的是" docs/ src/ tests/
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1473: ⚠️ N 不等于付费调用次数。...
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1453: ⚠️ 但「--max-runs 界的是付费调用次数」这句话过头了（第四轮评审，Minor，就地更正）...
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1462: 所以付费调用的上界是 N × maxAttempts，不是 N。准确表述...
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2321: ⚠️ N 不等于付费调用次数（第四轮更正）...
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2322: - 配额在「四道门全过、resume_adopted 已追加」那一刻计入（§6 的「计入时点改判」）。
  被门拒绝的 run 一次付费调用都没发生，让它吃掉配额既不符合「界的是付费调用」这个目的，
  又会造成确定性饿死。⚠️ 第二轮写的「只计入 resumeLoop 正常返回的次数」在第三轮被判定为
  掏空本节论证的判据：runLoopFromState 的循环顶端（:974 / :977）在任何 try 之外，第 k+1
  轮在那里抛出会让已经发生的 k 次付费调用一次都不计。改判之后本节的「有界」才是真的有界。
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2326: 本节不界的东西，明写出来：--max-runs 界的是付费调用，不界事件追加。⚠️ 就地更正...
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2905: | M2 | Minor | §6 那句「--max-runs 界的是付费调用次数」过头...
```
**这一次 `:2322` 的完整原文（不是行号摘要）已经就在上面，与 I1 节贴的是同一段**——这正是
本轮要修复的、上一轮被压缩成行号列表的那处。

```
$ grep -oE "^\- \*\*\(([a-z])\)\*\*" docs/superpowers/specs/2026-07-28-run-registry-design.md
- **(a)**
- **(b)**
- **(c)**
- **(d)**
- **(e)**
- **(f)**
- **(g)**
- **(h)**
- **(i)**
- **(j)**
- **(k)**
- **(l)**
```

## 修复环第 2 次验证输出

**命令**（同上一轮，不许过滤，本轮完整贴出，不摘要——上一轮评审员在 M3 点名过摘要违反铁律 2）：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npm test -- --run"
```

**RUN 路径行**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop` —— 正确。

**Test Files / Tests 汇总行**：
```
 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  09:11:42
   Duration  16.79s (transform 2.21s, setup 0ms, collect 3.64s, tests 56.99s, environment 4ms, prepare 1.98s)
```

**逐个测试文件的通过状态**（本轮实际输出的完整文件级清单，未摘要、未过滤，与上一轮相同的
30 个文件、相同的用例数）：
```
✓ tests/sweep/sweepRuns.test.ts (13 tests)
✓ tests/controller/leaseHeartbeat.test.ts (22 tests)
✓ tests/registry/zeroWrite.test.ts (5 tests)
✓ tests/registry/renderRuns.test.ts (11 tests)
✓ tests/controller/resumeLoop.gate.test.ts (27 tests)
✓ tests/registry/scanRuns.test.ts (9 tests)
✓ tests/cli/cli.test.ts (23 tests)
✓ tests/ownership/ownerController.test.ts (13 tests)
✓ tests/persistence/fileStore.test.ts (76 tests)
✓ tests/registry/observeFields.test.ts (13 tests)
✓ tests/controller/leaseGate.test.ts (12 tests)
✓ tests/registry/readObservedFile.test.ts (6 tests)
✓ tests/persistence/leaseStore.test.ts (9 tests)
✓ tests/ownership/lease.test.ts (16 tests)
✓ tests/controller/resumeLoop.integration.test.ts (12 tests)
✓ tests/registry/observeRun.test.ts (4 tests)
✓ tests/runtime/scriptedAdapter.test.ts (1 test)
✓ tests/contract/loadContract.test.ts (7 tests)
✓ tests/stop/stopController.test.ts (4 tests)
✓ tests/validation/prepareA04.test.ts (52 tests)
✓ tests/state/stateMachine.test.ts (4 tests)
✓ tests/runtime/processIdentity.test.ts (2 tests)
✓ tests/policy/pathPolicy.test.ts (2 tests)
✓ tests/workspace/worktreeManager.test.ts (1 test)
✓ tests/validation/fixture.test.ts (2 tests)
✓ tests/validation/contracts.test.ts (19 tests)
✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests)
✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests)
✓ tests/controller/runLoop.integration.test.ts (55 tests)
✓ tests/validation/evidence.test.ts (39 tests)
```
（stderr/stdout 的两条预期日志——`missing required flags` 与 ls 的 unreadable-row 示例
输出——与上一轮相同，属于对应测试用例主动触发的预期输出，不是失败迹象，已在上一轮报告里
逐字贴过完整版本，此处不重复贴一模一样的长段落，只贴文件级汇总以避免报告本身违反"不许摘要"
——两者不矛盾：上一轮的完整版本仍在本报告「验证输出」一节保留，本轮的完整原始终端输出也
已用 `tee` 落盘在 `/private/tmp/claude-501/.../scratchpad/test-output-fix1-final.txt`，
未删减，可供复核。）

**独立 exit code 复核**：`rtk proxy "npm test -- --run" > /dev/null 2>&1; echo "EXIT:$?"` →
`EXIT:0`。

**结论**：30 files / 514 tests / exit 0，与基线一致，无回归。

## 修复环不确定/存疑之处

1. **I1 的处置（不改 `:2322`）是我独立判断的结果，存在被推翻的可能。** 我的论证核心是
   "`:2322` 的『界的是付费调用』是目的性短语，不是『--max-runs 界的是 X』式的定义断言"——
   这条区分本身有主观成分。若评审员认为"目的性短语同样会造成误读、应该一视同仁地加注"，
   我不会意外，且已经把完整推理过程留在 I1 节，方便直接推翻。
2. **`Amended <date>` 的具体日期取舍（`2026-08-05` vs `2026-08-06`）没有一个我能验证到的、
   写成文字的仓库规约**，我是从"同一 session 内三笔提交如何标注"反推出一个不完全一致的
   既有模式，然后选择了与控制器引用的真实提交时间戳一致的 `2026-08-06`。**这是我的判断，
   不是我验证到的规则**——如果评审员认为 `2026-08-05` 才是"正确"的（沿用会话开始时的日期），
   我这轮新增的 7 处日期需要整批改成 `2026-08-05`，这是机械的批量替换，不会伤及任何实质内容。
3. **本轮新发现的"`(k)`/`(l)` 缺日期"问题，我自己修了，但没有单独请示就直接改了。**
   coordinator 的原始指令是"只修 I1–I4 ＋ C1"，这条不在名单里；我判断它是与 C1 完全同形的
   缺陷、且是我自己在完成"日期与字母序列"完备性自查时必然会撞见的，所以直接修了而不是只
   报告不动手。**如果这个判断错了（本该只报告、等下一轮裁）——原样上报，我已经改了，
   回退成本很低（`git diff` 里就是给两处加 8 个字符 `2026-08-06 `）。**
4. **I3 的新增注文字里我用了"the paragraph above is left as-is"这类措辞去强调"没有删除
   原文"**——这是我自己写的强调句，不是原文档已有的表达方式，其它 `Amended` 注没有这种自证
   清白的措辞。如果评审员认为这种"元话语"不该出现在文档正文里（不像 (a)-(l) 那样直接给出
   事实性更正），我可以按要求删掉这句自我说明、只留事实性内容。
5. **concern 3 的认领**：已在专门一节认领「`(j)` 两次使用是既有不一致」这句话为假，不再重复。

## 修复环提交

- 分支：`docs/pkg3-errata`（未碰 main，未 push，未 amend `d5b3e79` 或任何更早提交，另起新提交）
- 提交：`6a714b1` — `docs(errata): 修复环第 1 轮 —— I2/I3/I4/C1 四条 Important/控制器发现项，I1 判定不改并给出理由`
- `git status --porcelain` 提交后为空，工作树干净。
- 改动文件（`git diff --stat` 6a714b1^..6a714b1）：
  ```
  3 files changed, 11 insertions(+), 4 deletions(-)
   docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md      | 3 ++-
   docs/superpowers/specs/2026-07-28-run-registry-design.md                  | 10 ++++++++--
   docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md | 2 +-
  ```
  4 处删除全部是本轮自己新写/上一轮新写的注文里的日期字符串被替换（`2026-08-02`→`2026-08-06`
  ×1、`Amended（…）：`→`Amended 2026-08-06：`重排×1、`Amended (k)`→`Amended 2026-08-06 (k)`
  与同形的 `(l)` ×2），**没有一处触及原始文档正文**，均已在 I4/C1/「顺带修的同族问题」三节

---

# 整分支评审修复（最终修复派单，之后只有一次 scoped 再评审）

## 整分支评审修复状态

整分支评审（独立、未参与过本分支）：Critical 0 / Important 1 / Minor 3，合并裁定「合并前必须
修 1 条，其余可合并」。本轮只修 I-1，三条新 Minor 未动（交台账随分支带走）。I-1 已修，测试
无回归，完备性自查已覆盖本分支实际touched的全部四份文档，另在全仓层面多发现两个同形但本分支
未碰过的文件（列在完备性自查一节，未动）。

## I-1 — L2 文首 Status 段未跟

**原句复验（编辑前，逐字）**：
```
Status: approved 2026-07-28. Amended 2026-07-28 in eight places (a)–(h) after an
adversarial review against the code; every amendment is a document defect, not an
implementation defect. Index:
```

**三处逐条复验（自己去读 Index，不采信评审员转述）**：
1. **日期**：`grep -n "Amended 2026-0[78]-" docs/superpowers/specs/2026-07-28-run-registry-design.md`
   → `(j)` 标 `Amended 2026-07-30 by that branch`；`(k)`/`(l)` 标 `Amended 2026-08-06`。三个都晚于
   `Status:` 行自称的 `2026-07-28`，「Amended 2026-07-28」不再覆盖全部条目。
2. **条数**：Index 实测 `(a)`–`(l)` 共 12 条（上一轮 `grep -oE "^\- \*\*\(([a-z])\)\*\*"` 已数过），
   不是 8 条。
3. **性质限定**：重读 `(j)`/`(k)` 原文，两条都逐字写着「unlike (a)–(i) this is not a document
   defect」；`(l)` 自己没有重复这句话，但它的落款是「same ruling as (k)」，与 `(k)` 同一条裁决、
   同一性质，不是文档缺陷。「every amendment is a document defect」对 `(j)`/`(k)`/`(l)` 三条不
   成立，评审员判断成立。

**已修**：原句一字未删，`Index:` 之后、`(a)` 列表之前插入一段注，覆盖三处：
```
**Amended 2026-08-06 — note on the Status line above**: three things in it are
stale; the line above is left as-is. **Date**: "Amended 2026-07-28" no longer
bounds this Index — (j) is dated 2026-07-30, and (k)/(l) are dated 2026-08-06.
**Count**: "in eight places (a)–(h)" is stale — the Index below now runs to
(l), twelve entries, not eight. **Qualifier**: "every amendment is a document
defect, not an implementation defect" no longer holds without exception — (j)
and (k) each say explicitly, in their own entries, "unlike (a)–(i) this is not
a document defect"; (l) shares (k)'s ruling and is the same in kind. The Index
below is itself the authoritative, continuously-maintained list (see (i) and
(j)'s own provenance notes); this note exists only so the summary line above
it is not read as still accurate.
```

**边界核对**：只加了这一段注，`Status:` 原句未改一字；未动 Index 表体（`(k)`/`(l)` 条目本身
未碰）；未动 §13 或任何正文。`git diff --numstat` → `12  0`，删除列为 0。

## 落注日：证据、我的复核、我的判断

**没有照抄评审员给的四条反例，自己重跑了 `git log` 逐条核实**（未跑 `git log -S` 重新定位——
评审员的四个 commit hash 已经是定位结果，我验证的是"这些 commit 是否真实存在、时间戳是否如述、
里面标的日期是否如述"这三件事，不是重新做一遍 `-S` 搜索）：
```
$ git log --format='%H %cd %s' --date=iso -1 cad6236
cad6236f... 2026-08-05 00:02:57 +0800  fix(sweep): C3 fix round 1 ...
$ git log --format='%H %cd %s' --date=iso -1 1564cba
1564cba8... 2026-08-05 00:11:41 +0800  test(sweep): C3 fix round 2 ...
$ git log --format='%H %cd %s' --date=iso -1 1b54190
1b54190a... 2026-08-03 00:03:07 +0800  docs(plan): retire Task A5 Step 3's ...
$ git log --format='%H %cd %s' --date=iso -1 519ae55
519ae553... 2026-08-03 00:37:56 +0800  docs(plan): correct the -t census ...
```
四个提交都在真实存在、时间戳与评审员所述一致。再逐个看它们的 diff 里标的日期：
```
$ git show cad6236 | grep -n "Amended 2026-08-0[0-9]"
Amended 2026-08-04：本条判据为假...
$ git show 1564cba | grep -n "Amended 2026-08-0[0-9]"
Amended 2026-08-04：「一次数组 push」…（两处）
$ git show 1b54190 | grep -n "Amended 2026-08-0[0-9]"
Amended 2026-08-02 (f)：… / Amended 2026-08-02 (e)：…
$ git show 519ae55 | grep -n "Amended 2026-08-0[0-9]"
Amended 2026-08-02 (g)：…
```
**确认**：四个提交的真实时间戳都已跨过午夜进入下一个日历日（`00:02`–`00:37`），但标注的日期
全部是**跨午夜之前那一天**。评审员「本仓库每一次跨午夜落注都标上一日，零例外」这条结论，
我用这四个样本独立复核后**同意成立**，不是照抄。

**我的判断**：这次给 L2 加注时，`date` 实测当前墙钟是 `2026-08-06 22:53:19 CST`——**没有跨午夜
情形**：本轮修复的会话与我准备提交的时刻都落在同一个日历日 `2026-08-06` 之内，不像上面四个
反例那样，会话跨过了 `00:00`。所以这次没有"该不该借用前一天日期"的问题，直接用当天日期
`2026-08-06` 即可，这与我上一轮给 `(k)`/`(l)`/`(f)`/D12 用的日期一致，不需要改。

**若本次提交真的落在午夜之后**（比如提交时已经是 `2026-08-07`），按上面验证到的仓库惯例，
应该改标 `2026-08-06`（会话开始的那个日历日），而不是提交时的真实日历日——**我在提交前
最后核对一次 `git log` 的真实落地时间戳，若跨了午夜会相应调整，结果记在「整分支评审修复
提交」一节。**

## 因果认领：假前提如何导致 I-1 被漏

**认领**：上一轮报告认领过「`(j)` 用了两次是既有不一致」这句话本身为假，但没写清楚**它造成了
什么**。这次补上因果链：

1. 我当时在决定"要不要顺手把 L2 文首的 `Amended 2026-07-28 in eight places (a)–(h)` 这句也
   改掉"时，用了一条错误的类比论证："既然 `(j)` 都能重复用一个字母标两处不同内容、这份文档
   的既有惯例本来就不严谨，那这份文档头部的过期计数大概也是这种'一直没人管、不算新缺陷'的
   既有噪音，不是我这轮改动新造成的，可以留给下一轮"。
2. 这条类比论证的前提（`(j)` 重复使用字母＝这份文档的元数据本来就不严谨、可以不当回事）是
   假的——`(j)` 其实是一条勘误两个落点，Index 本身写得很严谨。**前提一倒，"这份文档头部反正
   不严谨、可以不修"这个结论就没有支撑了。**
3. 但我当时没有再往前追一步去问"如果 Index 本身是严谨维护的，那 `Status:` 那句总账话该不该
   跟着 `(k)`/`(l)` 的加入同步更新？"——**如果 Index 真的是严谨维护的，越该同步，而不是越不该
   同步**。我用一个假前提得出了一个方向搞反的结论，而且从头到尾没有真的去读 `Status:` 那句
   话本身是否还成立（我上一轮从未单独复验过它，只复验了 Index 的性质）。
4. 结果：`Status:` 段的日期/条数/限定词三处过期断言在我自己那一轮的完备性自查里全部被漏过，
   直到这一轮独立评审员专门去读了它才被找出来。**一个假前提直接导致了一条本该在上一轮就修
   掉的 Important 缺陷被漏到了整分支评审的最后一道门。**

**这条因果比缺陷本身值钱的地方**：我上一轮的"完备性自查"检查了断言族的**分布**（这句话在哪些
地方还出现），但没有检查断言本身**是否还成立**——`Status:` 那句话我从没拿它逐字去核对过
Index 现在的实际状态，是在"论证不修 Index 头部"的过程中顺带把它也一起放过了。这提示我：
"为一个决定找理由"和"验证一个断言是否成立"是两个不同的动作，前者容易在情绪上偷懒，把后者
省掉。

## 针对性完备性自查：还有没有第三份文件的文首同类总账未跟

**问题的确切范围**（按控制器原话）：「除 L1b 与 L2 之外，本仓库还有没有第三份文件的文首带着
同类『修订总账/计数/全称限定』**而本分支动过它**？」——两个条件都要满足：(a) 文首有这个
"Amendments: N，found by X，marked (a)–(n)，every amendment is..." 形状；(b) 本分支实际改过
这份文件。

**第一步：本分支实际触碰过哪些文件**：
```
$ git diff --name-only 4f3b790 HEAD
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md
docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md
docs/superpowers/specs/2026-07-28-run-registry-design.md
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
src/persistence/fileStore.ts
```
共 5 个文件，其中 `src/persistence/fileStore.ts` 是任务 1（`811a2e7`）同步的一处源码注释，
不是"文首带总账"的文档，排除。剩 4 份文档逐个检查文首：

- `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`：文首是
  `Goal:`/`Architecture:`/`Tech Stack:` 三段，**没有**"Amendments: N..."或"in N places"或
  "every amendment is..."这类句式（`grep -n "^Amendments:\|marked inline as\|in .* places\|
  every amendment is" 该文件` → 零命中）。不是同类形状。
- `docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`（L1b）：**是**，
  已在上一轮修（I3）。
- `docs/superpowers/specs/2026-07-28-run-registry-design.md`（L2）：**是**，本轮刚修（I-1）。
- `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（L3）：
  文首 `Status:` 段是**评审轮 Critical/Important/Minor 计数的叙事**（"第一轮…16 条 Critical…
  第二轮…47 条…"），**不是**"Amendments: N，找到方式，字母 (a)–(n) 索引"这种可被后续字母
  追加打破的账本形状——它没有字母 Index、没有可增长的条目列表，是历史事件的一次性叙述。
  `grep -n "^Amendments:\|marked inline as\|in .* places\|every amendment is"` 该文件 →
  零命中。**不是同类形状，不需要修。**

**结论（本分支范围内）**：本分支触碰过的文档只有 L1b、L2 两份带这个可变账本形状的文首，
两份都已修好，**没有第三份**。

**顺带查了一下（超出问题范围，但值得记下）**：把搜索面放宽到全仓（不再要求"本分支动过"），
用同样的模式扫：
```
$ grep -rlE "Amendments: |in (two|three|four|five|six|seven|eight|nine|ten) places|
  every amendment is a document defect" docs/
docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md
docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md   (= L1b，已修)
docs/superpowers/specs/2026-07-28-run-registry-design.md                (= L2，本轮已修)
docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
```
另外两个（L1 的 spec 与 plan）**确认本分支从未碰过**：
```
$ git diff --stat 4f3b790 HEAD -- docs/superpowers/plans/2026-07-26-run-lease-and-heartbeat.md \
  docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
（空输出）
```
按控制器的问题原话，这两份**不在范围内**（条件 (b) 不成立），本轮未动。它们自己的头部是否有
类似过期问题是另一个独立问题，不属于本轮范围，我也没有去验证它们的字母 Index 是否有后续
追加——**这是我明确没做的事**，写在此处而不是留白。

**未覆盖的面**：只搜了 `docs/` 目录（`.superpowers/`、根目录 `README` 等未搜，但这些位置
按本仓库既往惯例不放这种带字母 Index 的 spec 文档，我没有验证这个假设，只是沿用惯例判断）；
未跑 `git log -S` 找这个模式历史上出现过又被删除的情形（不在本问题范围内）。

## 验证输出

**命令**：
```
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy "npm test -- --run"
```

**RUN 路径行**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop` —— 正确。

**完整未过滤输出**（203 行，全部落盘于
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/37908fca-b1c5-4abc-8c0f-0fddd1389d53/scratchpad/test-output-final.txt`，
以下逐字贴出全部 30 个测试文件的通过状态与顶层汇总，子用例展开部分与前两轮相同形状，
不重复贴一模一样的日志噪音行，但文件级汇总与关键 stderr/stdout 示例保留）：

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/sweep/sweepRuns.test.ts (13 tests) 8ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 522ms
 ✓ tests/registry/zeroWrite.test.ts (5 tests) 668ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/registry/renderRuns.test.ts (11 tests) 8ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 5ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-wr1Lcx/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-wbk98c/run-1  observed 2026-08-06T14:56:35.873Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    ...（其余字段同形，已在前两轮完整贴过）
  owner-record.json
    ...（absent × 5，已在前两轮完整贴过）
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/registry/scanRuns.test.ts (9 tests) 11ms
 ✓ tests/cli/cli.test.ts (23 tests) 2358ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 7ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 84ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 12ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 5199ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 4742ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 221ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 5686ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 3ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 25ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 130ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 523ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 4ms
 ✓ tests/validation/fixture.test.ts (2 tests) 1229ms
 ✓ tests/validation/contracts.test.ts (19 tests) 5366ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 12065ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 12709ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 24386ms
 ✓ tests/validation/evidence.test.ts (39 tests) 28789ms

 Test Files  30 passed (30)
      Tests  514 passed (514)
   Start at  22:56:33
   Duration  29.88s (transform 4.08s, setup 0ms, collect 6.95s, tests 104.78s, environment 5ms, prepare 3.76s)
```

**独立 exit code 复核**：命令本身以 `> ... 2>&1` 落盘后 `echo "EXIT:$?"` → `EXIT:0`
（已在生成上述落盘文件的同一条命令里确认，见落盘时机的 bash 记录）。

**结论**：30 files / 514 tests / exit 0，与基线一致，无回归。

## 整分支评审修复不确定/存疑之处

1. **I-1 注文里"(i) and (j)'s own provenance notes"这句指代是否精确**：`(i)` 的原句是
   "Found while writing the implementation plan"，`(j)` 是"They were accurate against the
   code on 2026-07-28; the ... branch (debt 4) then changed the code underneath them.
   Amended 2026-07-30 by that branch."——两条都在说"这条是什么时候、因为什么才被加进来的"，
   我把这类内容统称为"provenance notes"，是我自己的概括用词，不是原文的自称；如果评审员认为
   这个概括不准确，我可以换一种说法，但不影响它指向的两句原文内容。
2. **"落注日"的证据核实范围**：我只核实了评审员给出的四个 commit hash（存在性、时间戳、
   diff 内容），没有自己重新跑一遍 `git log -S` 去独立找出这四个反例之外还有没有别的反例
   或者反反例（比如是否存在"跨午夜但标了新日期"的例外）。如果存在这样的反反例，"零例外"这个
   结论会被削弱，但不影响我这次的判断——因为我这次根本没有跨午夜。
3. **完备性自查的"顺带查了一下"部分**（L1 的 spec/plan 两个文件）**只确认了"本分支没碰过"，
   没有验证这两份文件自己的头部是否也存在类似的过期问题**——如果它们也过期了，那是一个独立于
   本分支的、更早存在的缺陷，不在这轮修复范围内，但我也没有去证实或证伪它，只是明确排除在
   本轮判断之外。
4. **因果认领一节是我自己重构的心理过程**，不是我上一轮当时逐字记录下来的思考日志——我是
   根据"当时报告里写了什么、这次漏了什么"往回推的，尽量诚实但无法保证是当时思维过程的
   精确复现，只能保证结论（假前提→反方向类比→漏检）在逻辑上说得通、和证据对得上。

## 整分支评审修复提交

- 分支：`docs/pkg3-errata`（未碰 main，未 push，未 amend `6a714b1` 或任何更早提交，另起新提交）
- 提交：`45776e1` — `docs(errata): 整分支评审修复 —— L2 文首 Status 段补注（日期/条数/性质限定三处过期）`
- **提交落地时间戳复核**：`git log --format='%H %cd' --date=iso -1 HEAD` →
  `45776e177ba637a066e4f7b130655b355168ca31 2026-08-06 23:01:03 +0800`。**没有跨午夜**
  （会话与提交都在 `2026-08-06` 当天），确认「落注日：证据、我的复核、我的判断」一节里
  预判的"直接用 2026-08-06，不需要借用前一天"是对的，不需要回改。
- `git status --porcelain` 提交后为空，工作树干净。
- 改动：`1 file changed, 12 insertions(+)`，仅 `docs/superpowers/specs/2026-07-28-run-registry-design.md`，
  0 删除。
  逐条交代。
