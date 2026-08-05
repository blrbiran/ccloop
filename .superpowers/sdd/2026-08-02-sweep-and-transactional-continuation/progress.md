# SDD ledger — plan: docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md

Scope this session: group A only (A1–A9 + GATE-A). Human ruled: stop at GATE-A, do not enter group B.
Worktree: .claude/worktrees/l3-debt1-group-a on feat/l3-debt1-transactional-continuation, based on ba8f8a0 (NOT origin/main).
Baseline measured in this worktree, unfiltered: 29 files / 446 tests exit 0; typecheck exit 0; build exit 0. Flakes (B) and (F) both passed.

Pre-flight scan: one item, already adjudicated by the plan itself.
  - Plan 裁定三 overturns spec 4.6's "preserveSuccessfulReconciliationIfNeeded 代码零改动". The plan deliberately does NOT edit the spec ("spec 的勘误由人决定何时做"). Carry this pointer into task A7's dispatch and its reviewer: the plan governs, the spec sentence is known-stale.

Task A1: complete (commits ba8f8a0..0f940ea, review clean)
Task A1: reviewer warning resolved by controller — recoverInterruptedOwnerTransfer's no-marker branch does gate cleanupOwnerTransferStagingWithoutMarker on options?.lockHeld (fileStore.ts, symbol anchor). Not a gap.
Task A1: minor (deferred): three new tests in fileStore.test.ts repeat a 9-field owner-record literal and near-identical mock scaffolding (~55 lines each). Reviewer itself judged Rule 3 favours leaving it. Hand to the GATE-A whole-branch review for triage.
ENVIRONMENT (carry into every later dispatch): the global rtk shell hook auto-filters/summarises vitest output, which silently violates "never filter verification output". A1 worked around it with `rtk proxy "<command>"`. Any later implementer must state which mechanism it used and confirm the pasted output is untruncated.
Task A2: implemented (commit dad8a14, 453 tests). Deferred (owner = task C4, group C, not this session): stale fileStore.ts line-number citations in tests/registry/readObservedFile.test.ts and tests/registry/zeroWrite.test.ts comments — already stale before A1, further drifted by A2. A2 correctly stayed out of that directory.
Task A2: complete (commits 0f940ea..dad8a14, review clean — spec compliant, zero Critical, zero Important, 8 Minor)
Task A2: reviewer warning resolved by controller — the optional fifth parameter has no production caller until A4 lands; A4's test 1 (plan line 527) drives it via runLoopFromState and A4's mutation 1 ("persistOwnerTransfer 不传第五参数") requires test 1 red. Cross-task dependency, correctly deferred. Pointer carried into A4's dispatch.
Task A2: controller independently re-ran the full suite unfiltered — 29 files / 453 tests, exit 0, fileStore.test.ts 60 tests, Duration 16.35s. Confirms the count and greenness. The report's "Duration 15.91s" being byte-identical to the plan-era baseline is unexplained but the substance holds.
Task A2: minor (deferred) x8, for GATE-A triage:
  1. finalizePendingOwnerTransfer's marker content is now load-bearing across four non-atomic reads; an unlocked reader can take a v1 branch against a freshly staged v2 transaction and orphan the reconciliation pending. Outcome is the safe direction (loud throw, next lock-held entry reclaims, resumeLoop refuses) so reviewer judged S-3 not breached. Record as a known edge of the unlocked-recovery design.
  2. the v2 branch keys off marker.version, not finalizeOrder; the plan-mandated type admits a v2 marker whose finalizeOrder omits reconciliation-record.json. Unreachable today. finalizeOrder is written-and-never-read data whose type is looser than the code's assumption. RELEVANT TO A3 (rules 1-4).
  3. test 3's owner-transfer.json assertions are vacuous (fixture pre-writes the asserted values) and it dropped the sibling test's rawOwnerBeforeRecovery precondition assertions.
  4. test 6a guards only reconciliationPendingIndex < markerIndex, one of three ordering clauses. Two more toBeLessThan lines would close it.
  5. the twelve single -t output blocks are trailing-truncated (cut after the Tests line, no Start at/Duration, no echoed exit code) — a form violation of "never filter verification output". *** AMENDED (GATE-A fix wave, 2026-08-02): the number is THIRTEEN, not twelve — re-derived independently, not taken from the reviewer. `rtk proxy "grep -c -e \"npx vitest run .* -t '\" .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A2-report.md"` -> 13, and `rtk proxy "grep -c 'Start at' .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-A2-report.md"` -> 1 (that single hit is the full-suite block, not a -t block), so all 13 single -t blocks lack Start at. Cross-checked by a per-fence script that flags any fenced block containing a `-t '` invocation and a `Tests` summary line but missing any of Start at / Duration / an echoed exit code: it printed 13 blocks (report lines 103, 139, 152, 182, 195, 230, 243, 280, 315, 371, 383, 419, 431) and COUNT=13. The finding itself stands; only the count was wrong. ***
  6. mutation 1 has no in-place pre-injection green block, only a pointer to an earlier one.
  7. report's full-suite Duration byte-identical to the plan-era baseline (see controller re-run above).
  8. buildAtomicTempPath's collision guard in fileStore.test.ts still lists only 8 transaction paths, not extended with A1's or A2's temps.
Task A3: implemented (commit fb62714, 457 tests) then review returned Needs fixes — 3 Important, 2 of them labelled plan-mandated.
Task A3: HUMAN RULING (plan-mandated conflict, per skill this was the human's call): add runtime validation of finalizeOrder. The plan text ("按其 finalizeOrder 声明的文件集合与顺序办事", Step 6 / rule 1) plus A2's type ({ version: 2; finalizeOrder: readonly TransactionFileName[] }, no completeness constraint) together let a v2 marker listing only 2 of 3 files be honoured literally — the unlisted pending is silently orphaned, the marker is still deleted, readOwnerRecord returns successfully. That is strictly less safe than pre-A3 code, which always processed all three for v2. Human ruled the validation wins over the plan's literal wording. This ruling extends the plan; record it as such.
Task A3: minor (deferred) for GATE-A triage: (a) rule 2's error message interpolates marker.version for display, so "rules 1-4 never read version" is true for branching only; (b) tests 4 and 4c's "marker and staging survive" assertions are guaranteed by control-flow sequencing and are not proven killable by either mutation; (c) test 4c's comment lacks the TOCTOU-reachability explanation that test 4's comment has.
Task A3: fix round 1/5 (3 addressed, 0 open — output truncation re-pasted whole; finalizeOrder completeness validated by new sibling error OwnerTransferMarkerFinalizeOrderInvalidError; unknown-filename raw TypeError closed by the same check; commits fb62714..b7bf227)
Task A3: complete (commits dad8a14..b7bf227, review clean after one fix round)
Task A3: minor (deferred) for GATE-A triage, from the re-review's out-of-scope list: isValidFinalizeOrder/legalFinalizeOrderFileNames trust marker.finalizeOrder to be an array and marker.version to be exactly 1 or 2 at runtime (post JSON.parse + type assertion, no runtime shape validation). A corrupted version (e.g. 3) falls into the v1 two-file legal set via the ternary; a non-array finalizeOrder throws a bare TypeError on .length. Predates the fix diff (the original A3 dispatch loop had the same unguarded access) but the new validation now depends on version being 1|2.
Task A4: implemented (commit 7065a3d, 460 tests), reported DONE_WITH_CONCERNS with two scope concerns.
Task A4: HUMAN RULING (Rule 7 conflict between two spec documents, surfaced by the implementation, not by any review round). L1b docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113 "Amended 2026-07-28 (e)" states that a completed owner-transfer.json no longer implies a reconciliation-record.json, calls that requirement 7's INTENDED behaviour, and ends: "The same ruling deliberately gave up the losing process's synthesis of the winner's reconciliation view; if that view is still wanted, assigning it to a process that still holds the run is L5's problem." L3 debt 1 transactionalises reconciliation so the SAME CAS publishes it. Human ruled: L3's transactionalisation SUPERSEDES L1b (e). A4's assertion flip stands.
Task A4: two follow-ups the ruling carries, to be folded into A4's fix round (or dispatched separately if the review comes back clean):
  (a) the amended comment in tests/controller/leaseLifecycle.integration.test.ts must quote L1b (e)'s FULL final sentence including "is L5's problem", and state explicitly that L3 supersedes it. The repo's own lesson: 引用在先的裁定时必须引全句 — the L3 spec draft was once caught quoting only the first half of a runExclusive comment whose second half forbade the change it wanted.
  (b) L5's inherited-input list is unaffected in NUMBER: the L3 spec's 13 five-item list does not contain the L1b-side "winner reconciliation view" assignment, so 5 笔 / 6 项 stay. Record that this L1b-side assignment is now closed by L3 rather than inherited by L5.
Task A4: review returned Needs fixes — 2 Important, 6 Minor. Reviewer independently adjudicated both implementer concerns and both the human ruling's premises; all confirmed.
Task A4: minor (deferred) for GATE-A triage:
  1. test 6d's inode assertions are shadowed by its own shape guard — mutation 2's red lands on the key-shape expect, so the clause the test is named for has never executed. Move the inode assertions above the shape guards.
  2. loser branch's newOwnerEpoch: nextOwnerEpoch is statically null inside the else (TypeScript narrows it). Kept per the brief's "原地不动".
  3. docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:113 now states something production code contradicts. Repo convention is an in-place *Amended (f)* note, and the debt-4 precedent explicitly says a later layer that falsifies something should annotate in place. NOT done here: the human's approved option covered a code comment + ledger only, and the plan's stance is that spec errata are the human's timing call. Flag for the human.
  4. the 460 = 458 + 2 arithmetic is asserted without a re-derivation command, against the plan's own rule.
  5. both mutations' revert-confirmations claim "identical output to the GREEN block above" without pasting it.
  6. tests/controller/runLoop.integration.test.ts grew +264 onto ~1550 lines; persistBoundaryAnalysis now carries two near-identical 18-line reconciliation literals (plan-mandated, merging forbidden).
Task A4: fix round 1/5 (3 addressed, 0 open — test 1's decisive assertion is now boundary-analysis.json's absence and mutation 1's red lands there, not on the terminal status string; clause (b) reworded as an explicit scope note; the L1b amendment (e) quotation is now verbatim-complete including "is L5's problem" with the human ruling recorded; commits 7065a3d..bf541ac)
Task A4: complete (commits b7bf227..bf541ac, review clean after one fix round)

=== SESSION STOPPED HERE BY THE HUMAN, AT THE A4/A5 BOUNDARY, FOR HANDOFF ===
Group A is 4 of 9 tasks done. A5-A9 briefs are pre-extracted and ready in this directory. GATE-A not started.

=== SESSION 2 RESUMED HERE (controller re-verified state before touching anything) ===
Baseline re-measured by the controller in this worktree at HEAD 412f8157, unfiltered via `rtk proxy`, with ECC_GATEGUARD=off DISABLE_OMC=1:
  `Test Files 29 passed (29)` / `Tests 460 passed (460)`, TEST_EXIT=0; TYPECHECK_EXIT=0; BUILD_EXIT=0. Neither allowed flake (B) nor (F) appeared.
Confirmed: A5-A9 briefs survive in this worktree and task-A5-brief.md is verbatim-identical to the plan's current Global Constraints + `### Task A5` section (plan file unchanged since ba8f8a0). No brief rebuild needed.
Task A5: BASE = 412f8157. Implementer dispatched (opus).
Task A5: implemented (commit 84c7825, 463 tests), reported DONE_WITH_CONCERNS with five concerns.
Task A5: controller-verified independently before review — only tests/persistence/fileStore.test.ts changed (+406/-1), `git diff --name-only 412f8157..HEAD -- src/` empty, guard `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` back to 8, full suite re-run 29 files / 463 tests / TEST_EXIT=0.
Task A5: implementer's counts from the landed code: N = 4 pre-try parses, M = 13 try steps, 17 injection points; mock surface readFile/writeFile/unlink/rename with EIO (claims ENOENT would be swallowed by safeUnlink).
Task A5: three concerns handed to the reviewer for independent adjudication, NOT accepted on the implementer's word:
  1. claims gaps 14-17 do not refuse resume (all three files published past step 13) so the mandated test name's "every crash gap" covers 1-13, tail four assert commit + residue. Brief requires 「每个中间态都让 resumeLoop 拒绝」.
  2. claims criterion B's whole-clause deletion is NOT killed by the first-transfer fixture, contradicting the brief's 「任何单转移场景都能杀」. Two candidate causes put to the reviewer: brief premise wrong, vs test 2's first-transfer assertions too weak to detect it. If it is the premise, A6's fixture split needs rethinking.
  3. claims tests/controller/runLoop.integration.test.ts untouched, though the brief's Files section names it and its Produces clause makes the two fixtures A6's input.
  (also: criterion B's kill depends on the Promise.all recovery/raw-read interleaving; gaps 5/6/7, 8/9/10, 11/12/13 observationally identical after the catch deletes all three .publish.tmp)
Task A5: independent reviewer dispatched (opus) on review-412f815..84c7825.diff.
Task A5: review returned Needs fixes — 3 Important, 8 Minor. Reviewer independently verified the gap recount, the unlink/EIO mock rationale (against safeUnlink), both fixtures' production-path provenance, the unshadowed exact-array matrix, and the mutation revert (it re-ran the count guard live and got 8).
Task A5: controller adjudicated the reviewer's spec-Missing finding and DISMISSED it with evidence — the reviewer lacked A6's brief, which says verbatim 「本任务在 gate 测试里各自重建一份最小形态即可，不跨文件 import 测试辅助」 and confines A6 to tests/controller/resumeLoop.gate.test.ts. A5's constructors being module-private to fileStore.test.ts satisfies Produces; tests/controller/runLoop.integration.test.ts is correctly untouched. Not a gap.
Task A5: HUMAN RULING 1 (plan-premise-wrong). The plan's 判据 B claim 「「整条删掉」这个变异任何单转移场景都能杀」 is FALSE about the code. Reviewer ruled out the competing explanation (test 2's 17-line exact toEqual has no tautological entry). Structural reason: resumeLoop reads the owner record THROUGH recovery while reading transfer and reconciliation raw, so single-transfer never satisfies ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch; the one shape that could have bitten (gaps 8-10) is shadowed by reconciliation-record.json still being absent, which throws before the gate. Criterion B is evaluated ZERO times across all 17 first-transfer gaps; both epoch criteria are carried solely by the double-transfer fixture at the disk level. Human ruled: annotate the PLAN FILE in place per the *Amended (x)* convention (both the 判据 B bullet and Step 5 item 3), original wording kept.
Task A5: HUMAN RULING 2 (plan-mandated). Gaps 14-17 accept and that is correct — all three files published and consistent, all eight criteria pass; asserting refusal there would pin a bug as spec. The brief's mandated test name therefore overstates and violates 「测试名里每一个分句都必须有一条能失败的断言」. Human ruled: RENAME to `refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives`. Reviewer separately confirmed the tail-four assertions are load-bearing (idempotent republish + marker/pending cleanup at gap 14; zero-write no-marker readOwnerRecord at 15-17), so the middle clause has real assertions behind it.
  ⚠️ CARRY FORWARD: A9's mutation single-run commands must quote the NEW test name.
Task A5: minor (deferred) for GATE-A triage:
  1. observeCrashMatrix stages each gap twice and never snapshots the recovery copy before recovery, so "after equals the crash snapshot" compares two independently staged run dirs — detects a recovery that writes, cannot detect staging nondeterminism.
  2. gaps 2/3/4 are near-duplicates (identical recovery and resume strings; only the P bits differ, and damageForPreTryGap wrote those). The brief's own warning agrees only gap 1 is load-bearing.
  3. criterion B's kill surface (double fixture, gaps 5-7) depends on the Promise.all interleaving — the raw readOwnerTransferRecord must resolve before recovery's transfer rename. Practically deterministic (1 fs round trip vs >=7) and documented, but it is a race-shaped dependency in a suite whose flake allowlist has exactly two entries.
  4. stageFirstOwnerTransferCrashedAt never has a pre-published reconciliation-record.json though writeBoundaryArtifacts publishes one outside the transaction in production; reviewer traced it and no mutation verdict changes. Realism note.
  5. OwnerTransferMarkerFinalizeOrderInvalidError gets no gap — it is neither one of the 4 pre-try reads nor one of the 13 in-try steps, so its coverage lives elsewhere or nowhere.
  (three further report-form minors were folded into fix round 1 rather than deferred: report §2's 17-step sequence pasted no raw output, report §4 overstated the smoke assertions, and the four mutation experiments were collapsed into two vitest runs)
Task A5: fix round 1/5 dispatched (resumed the original implementer) — publishedEpoch torn-file masking, the rename, the in-place plan erratum, and all four mutations re-run separately under the new name.
Task A5: fix round 1/5 (5 addressed, 0 open — publishedEpoch now nests read vs parse with a reachable `torn` on parse failure and no matrix expectation moved; test renamed verbatim to the human-ruled name with all three clauses shown failable; the plan erratum landed as `Amended 2026-08-02 (a)` at three sites inside `### Task A5` only, original wording kept; four mutation experiments re-run as eight separate `-t` runs whose reds land on the renamed test, guard back to 8; both report-form corrections made; commits 84c7825..88dea3c).
Task A5: CONTROLLER-ORIGINATED ERROR, corrected in fix round 2. The erratum's headline 「判据 B 一次都没有被求值」 is false: evaluateResumeEligibility returns { ok: true } only after all eight criteria run and B is the sixth, so at first-transfer gaps 14-17 (resume=accepted) B IS evaluated — it merely never holds. The accurate formulation was already elsewhere in the same note, so the note contradicted itself. The wrong phrasing came from the first review's "evaluated zero times", passed through the controller's question to the human and into the fix dispatch verbatim without being calibrated. The re-reviewer caught it and declined to charge it to the implementer for exactly that reason.
Task A5: minor (deferred) for GATE-A triage, from the fix round's re-review:
  6. the plan's Task A5 Step 3 still mandates the pre-rename test name, so the plan now carries an amendment describing post-rename reality beside a step naming a test that no longer exists. The human's ruling explicitly confined the edit to the two premise sites, so this was flagged, not fixed. task-A5-brief.md carries the same stale name correctly, being a verbatim extract.
  7. experiments 1/2 share one injection and 3/4 share the other (the fixture split is per-`expect.soft` array inside one test); the report states this openly, and the `[1/1]` single-error marker in each red block proves the other fixture's array was evaluated and equal — so it is four experiments in eight runs, not a concealed single run. Recorded so GATE-A does not re-derive it.
Task A5: fix round 2/5 dispatched (resumed the original implementer) — erratum headline accuracy, report §1/§5 supersession markers for the pre-rename name, and the test comment's "byte-exact" overstatement.
Task A5: fix round 2/5 (3 addressed, 0 open — erratum headline now reads 「从来不成立、因而从来不决定结果」 with the two-part breakdown (gaps 1-13 the gate is never entered, gaps 14-17 it is entered and B is evaluated and passes) plus an explicit guard sentence forbidding the 「单转移下不可达」 misreading; the conclusion that B is carried solely by the double-transfer fixture survives unchanged; report §1 and §5 carry in-place supersession markers with all four historical evidence blocks byte-for-byte intact; the test comment now states what the snapshot actually renders and says outright it does not compare contents byte for byte; commits 88dea3c..86d0d34).
Task A5: minor (deferred) for GATE-A triage:
  8. the plan's ORIGINAL text for 判据 A (「判据 A 根本没被求值，变异存活」, in the 判据 A bullet of Task A5's 测试要求) carries the same over-strong phrasing that fix round 2 corrected for 判据 B: at first-transfer gaps 14-17 the gate IS entered and criterion A (4th of 8) is evaluated and passes. Weaker than the B case — the sentence scopes itself to 「reconciliation 已发布而 transfer 未发布的那些间隙」, and within that subset it is true — so it is incomplete rather than false. Surfaced by the implementer, confirmed by the round-2 re-reviewer, left untouched because the human's ruling authorised only the two 判据 B premise sites. Controller surfaced it to the human and recorded it here rather than widening the ruling unilaterally. The same 「不可达 ⇒ 可删」 misreading risk applies.
Task A5: complete (commits 412f8157..86d0d34, review clean after two fix rounds)

Task A6: BASE = 448e575. Implementer dispatched (opus).
Task A6: controller-verified facts carried into the dispatch — tests/controller/resumeLoop.gate.test.ts already exists (8 tests) and drives evaluateResumeEligibility as a PURE FUNCTION over a directly constructed ResumeGateInput via a baseInput() helper, no disk. Therefore A5's criterion-B erratum does NOT constrain A6: the shadowing is a property of resumeLoop's read path (an earlier raw read of a still-absent reconciliation-record.json throws before the gate), not of the criterion, so criterion 6 is directly reachable in a gate test. Implementer told to confirm this itself rather than take it on trust.
Task A6: hazard flagged into the dispatch — the file's existing tests assert refusal as `expect(...ok).toBe(false)`, falsity only, never which criterion refused. For a campaign mutating eight criteria one at a time that shape mis-attributes kills. Implementer required to state its attribution mechanism rather than inherit the local convention silently.
Task A6: implemented (commit 64171bf, 473 tests, +10), reported DONE_WITH_CONCERNS. Review returned Approved — spec compliant, 0 Critical, 0 Important, 5 Minor. No fix round.
Task A6: reviewer independently verified rather than trusting the report — all ten per-experiment revert proofs shasum to 64c2db1873ccada54d721bf9bec985495fd3a3f2 and it re-ran shasum on the live file to match; every red block's diff is `- ok: false / - reason: <verbatim> / + ok: true`, so no kill is credited to a neighbouring criterion; no block anywhere shows the all-skipped fake-green signature; all ten injections are distinct hunks on src/controller/resumeLoop.ts.
Task A6: the brief's 「八 + 二 = 十」 mapping resolved — criterion 6 takes BOTH a whole-clause deletion and the `<` mutation. Reviewer confirmed this is the only reading under which all ten named tests have a killing mutation and all eight table mutations run: `<` alone cannot kill the Step 2 criterion-6 test, because currentOwnerEpoch 1 < newOwnerEpoch 2 is true and the mutant still refuses.
Task A6: minor (deferred) for GATE-A triage:
  1. report §9's self-audit names a `SCRIPT_EXIT` marker that appears nowhere in the report but that one claim line; every block does carry a real exit marker, so nothing is unsupported, but a self-audit naming an absent marker is the class of claim this series has learned not to accept.
  2. the report presents Step 5 before Step 6 while it ran after (Step 5 stamped 15:32:29-37, the campaign 15:29:51-15:31:12); disclosed as distinct executions but not as an ordering.
  3. no full-suite green is pasted BEFORE the campaign, only after — 「变异实验必须跑在一个基线全绿的工作副本上」 is satisfied in substance but the literal artefact is absent.
  4. seven pre-existing weak-assertion tests in tests/controller/resumeLoop.gate.test.ts are now strictly dominated by the ten new strong ones (one pair feeds a byte-identical input, differing only in assertion strength). Disclosed by the implementer, left untouched under Rule 3; the file is this task's declared file so a convergence pass is in scope for GATE-A to schedule.
  5. suite output carries pre-existing stderr/stdout from tests/cli/cli.test.ts error-path tests, untouched by this diff.
Task A6: complete (commits 448e575..64171bf, review clean, no fix round)

PLAN ERRATA (commit f7ffe6a, 26 insertions / 0 deletions, one file) — two HUMAN RULINGS, dispatched to an implementer and independently reviewed, Approved.
  (b1) Global Constraints §10's mutation criterion: clause 1 (「完整测试名（`describe > it` 全串）」) composed with clause 2 (`-t '<完整测试名>'`) literally yields `-t 'describe > it'`, which on vitest 2.1.9 matches ZERO tests and renders as `Tests 27 skipped (27)` with EXIT 0 — indistinguishable from a pass. Space-joined and bare `it` forms both match. Annotated in place as `Amended 2026-08-02 (b)`, inserted between steps 2 and 3 so it sits in the reading path of the 三步 list. The load-bearing addition is a NEW HARD CLAUSE: every single-run block must show a nonzero count for the named test (`1 passed | N skipped` before injection, `1 failed | N skipped` after); an all-skipped block is NOT a green. That guard also catches a mistyped test name, which fixing the form alone does not.
  VERIFIED NOT CONTAMINATED: A1-A5's reports all passed bare `it` names to `-t`, so every landed mutation filter did match. A6 used the space-joined form and disclosed it. Checked by the controller, then independently re-checked by the errata reviewer by grepping all six reports.
  (b2) Task A5's 判据 A bullet carried the same over-strong phrasing already corrected for 判据 B. Annotated: the sentence is true within its own stated scope (「reconciliation 已发布而 transfer 未发布的那些间隙」) so it is incomplete rather than false, but it must not be read as 「判据 A 在单转移下不可达」 — criterion A is the 4th of eight and at first-transfer gaps 14-17 it is reached, evaluated, and passes.
  Errata reviewer independently re-ran the arrow-form measurement, re-derived the eight-criteria ordering from src/controller/resumeLoop.ts, and confirmed readOwnerRecord recovers while readOwnerTransferRecord/readReconciliationRecord are raw reads. Verdict Approved, 0 Critical, 0 Important, 1 Minor.
  minor (deferred) for GATE-A triage: the note's closing audit sentence 「已核对：A1-A5 的报告里 -t 全部用的是裸 it 名」 is a bare assertion inside the plan itself; the substantiating grep lives only in task-errata-report.md, with no cross-reference from the plan.
  CONSEQUENCE HANDLED: task-A7/A8/A9-brief.md were rebuilt from the corrected plan (Global Constraints section verbatim + the task's own section verbatim). Each rebuilt brief was diffed against its predecessor and differs by exactly the Amended (b) insertion. The pre-errata briefs would have carried the defective command form into every remaining group-A task.

Task A7: BASE = 928b9c4. Implementer dispatched (opus). First production-code change of this session; dispatch carried the four pointers the brief cannot know — plan 裁定三 overturns spec §4.6's 「preserveSuccessfulReconciliationIfNeeded 代码零改动」 (spec sentence known-stale, plan governs, do not edit the spec); the prior human ruling that reconciliation_write_abandoned must ultimately route to sweep's stderr (delivered by A8 + group C, so A7 must not foreclose it and must not build A8's callback); the S-3 safety valve; and the three counting guards.
HUMAN RULING (cost): A8's reviewer runs on sonnet; A9 keeps the most capable model, because test 6e is the only guardrail for this layer's ordering reversal.
Task A7: implemented (commit 47eb148, 476 tests, +3), reported DONE_WITH_CONCERNS with five concerns.
Task A7: controller-verified before review — diff touches only src/persistence/fileStore.ts and tests/persistence/fileStore.test.ts (+315/-22); guard `return { ok: false` = 8; `currentOwnerEpoch + 1` still a single hit (src/ownership/ownerController.ts); src/registry/ diff empty; no docs/ file changed, so the spec was correctly left alone per 裁定三.
Task A7: five concerns handed to the reviewer for independent adjudication, none accepted on the implementer's word:
  1. a live production branch with no killing test — `owner-transfer.json` present but corrupt (non-ENOENT inside the transfer read's own catch). Implementer says the brief's three sub-cases structurally miss it and declined to add a fourth `it` under "exactly the Steps, nothing more".
  2. HIGHEST RISK, S-3 territory: on the ENOENT early return, readOwnerRecord — and therefore recoverInterruptedOwnerTransfer — is NO LONGER CALLED. Implementer argues benign because pre-change the Promise.all's eager evaluation issued the transfer readFile before recovery's first rename and left the recovery promise un-awaited on rejection, so the read saw pre-recovery state both before and after. Reviewer asked to verify against the code, not the narrative, and told that "I could not determine this from the diff" is a legitimate verdict.
  3. CROSS-TASK, CARRY INTO A8's DISPATCH: the swallow's justification rests entirely on A8 inserting its callback BEFORE this appendEvent. If A8 changes that order the swallow degrades into genuine silence. Reviewer asked whether that dependency is documented at the call site rather than only in a report.
  4. Step 8 used a real EISDIR (events.jsonl created as a directory) instead of mocking appendEvent, because vi.mock cannot intercept a same-module call.
  5. Step 1's blast-radius line numbers all drifted from the brief (22 -> 29 hits; the three fixtures at different lines). Implementer judged this the drift the brief predicts from A2's signature change, verified the conclusion held, and continued rather than stopping.
Task A7: independent reviewer dispatched (opus).
Task A7: review returned Needs fixes — 2 Important, 6 Minor, ZERO Critical.
Task A7: S-3 ADJUDICATED BY THE REVIEWER AGAINST THE CODE, NOT THE NARRATIVE — the safety valve was correctly NOT pulled. Pre-change readOwnerRecord sat inside the Promise.all and did run recoverInterruptedOwnerTransfer on this path; post-change the ENOENT early return genuinely skips it. Benign because: readOwnerRecord suspends at recoverInterruptedOwnerTransfer's first await pathExists, so readOwnerTransferRecordRaw's readFile is issued in the same tick, many awaits before finalizePendingOwnerTransfer's first rename — the ENOENT was a pre-recovery observation before and after; the recovery's completion was never observed here because Promise.all rejected on the transfer read first; the marker and pendings are reclaimed by any later readOwnerRecord or by writeOwnerTransferArtifacts under lock; and the removal DELETES a race in which the dangling recovery could rename the winner's pending reconciliation-record.json concurrently with this function's write-through of the loser's record. finalizePendingOwnerTransfer's catch semantics untouched. Both S-3 triggers unmet.
Task A7: SCOPING AMENDMENT to the sentence immediately above (GATE-A fix wave, 2026-08-02) — "the removal DELETES a race …" is true ONLY of the ENOENT arm, and must not be inherited as a general claim about readPersistedSuccessfulTransferArtifacts. Controller/fix-wave-verified in `src/persistence/fileStore.ts`, symbols `readPersistedSuccessfulTransferArtifacts` / `readOwnerTransferRecordRaw` / `readOwnerRecord`. Two arms, two different outcomes: (1) ENOENT arm — `readOwnerTransferRecordRaw` throws ENOENT, the function returns `{ kind: "no_published_transfer" }` and never reaches the `Promise.all`, so `readOwnerRecord` (and with it `recoverInterruptedOwnerTransfer`) is genuinely never called and the race IS deleted; this is the arm the sentence describes. (2) file-EXISTS arm — the transfer read resolves, control falls through to the `Promise.all` that still contains `readOwnerRecord`, so the recovery still runs and the race is NOT deleted; what A7 changed there is that `readOwnerTransferRecordRaw` is now awaited ALONE, strictly BEFORE that `Promise.all`, instead of sharing it — which makes the interleaving DETERMINISTIC (the transfer record is guaranteed observed stale relative to the owner record) rather than absent. Recorded because this repo's own case history is an unqualified claim surviving because only one of several linked sites was corrected.
Task A7: reviewer independently confirmed both produced types are verbatim (field-for-field, discriminant-for-discriminant), readPersistedReconciliationRecord was not narrowed, and no new permission was added (matrix comparison: the new code refuses strictly more; the `unreadable` arm now also catches throws from recoverInterruptedOwnerTransfer/finalizePendingOwnerTransfer that previously collapsed to write-through). All six mutation blocks carry nonzero named counts and echoed exit codes.
Task A7: CONTROLLER RULING on the plan tension the implementer raised (Rule 7 — two clauses of the same plan conflict; the more general one governs, and the choice is recorded rather than averaged). The brief enumerates three sub-cases for the read narrowing; the Global Constraints separately require 「加一个成分和加它的覆盖是一件事」. Adding a fourth `it` for the first catch's non-ENOENT arm SATISFIES the plan rather than contradicting it, so this did not need a human ruling and none was sought. The controller's own "exactly the Steps, nothing more" dispatch wording was never meant to override a Global Constraint; that wording caused the implementer's hesitation and is the controller's error, not the implementer's.
Task A7: CORRECTION to this ledger's own earlier entry — the implementer's concern 3 was OVERSTATED and the corrected version is what A8's dispatch must carry. Because appendEvent is swallowed it cannot throw past itself, so a callback placed AFTER it would still fire; ordering is NOT what the swallow's justification rests on. What degrades it is A8 not landing the callback at all. The call-site comment in writeBoundaryArtifacts already states the accurate version; only the report was wrong.
Task A7: minor (deferred) for GATE-A triage:
  1. neither produced type is `export`ed (the brief's snippet has no `export` either, so A7 conformed) — if A8's callback signature needs ReconciliationWriteDecision, A8 must export it. Flagged for A8, not a defect in A7.
  2. the Step 8 observation test (tests/persistence/tmp-swallow-observation.test.ts) was deleted and is not in the diff, so its fixture is unverifiable directly; the pasted stack corroborates it because appendEvent is called from exactly one place in writeBoundaryArtifacts.
  3. the pre-existing "all 53 tests in this file" comment in tests/persistence/fileStore.test.ts was already stale before A7 (the file now has 71) and was correctly left alone.
Task A7: fix round 1/5 dispatched (resumed the original implementer) — the fourth `it` for the uncovered non-ENOENT arm with its localized mutation, `detail` assertions in all abandon tests, an in-code note on the recovery-skip, the comment A7 made false, and a correction to the report's overstated concern 3.
Task A7: fix round 1/5 (5 addressed, 0 open — fourth `it` covers the first catch's non-ENOENT arm and the LOCALIZED mutation (first try's catch only) kills it, with the red landing on `expect(reconciliation).toEqual(persistedReconciliation)`, the headline assertion, not a cheaper guard that fires first; `detail` asserted in all three abandon tests and killed by `detail: ""`; the recovery-skip rationale now lives at the ENOENT early return in code; the comment A7 made false corrected; report §十二.3 amended; commits 47eb148..c7c005b).
Task A7: re-reviewer established WHY one kill proof suffices for F2 rather than accepting it — `detail: String(decision.error)` has exactly one production call site and all three abandon paths route through the single `kind === "abandon"` branch, so one named-test mutation covers all three. Also confirmed the fourth test's fixture (`"{ not json"`) really throws SyntaxError from readOwnerTransferRecordRaw and lands on the intended non-ENOENT arm rather than silently routing to ENOENT and testing nothing new.
Task A7: fix round's src/ change independently confirmed by the controller with `rtk proxy "git --no-pager diff ..."` to be a 7-line comment-only addition, zero code change — production semantics byte-identical to 47eb148, so A8's and test 12d's dependency surface is untouched.
Task A7: complete (commits 928b9c4..c7c005b, review clean after one fix round)

Task A8: BASE = f264cd1. Implementer dispatched (opus); reviewer will be sonnet per the human's cost ruling.
Task A8: dispatch carried the pointers the brief cannot know — why the callback must LAND (A7's appendEvent swallow is justified by this callback's existence, and ordering is irrelevant because a swallowed appendEvent cannot throw past itself); the still-open human ruling that the signal must eventually route to sweep's stderr (group C's outlet, A8 builds only the channel and must not foreclose it); ReconciliationWriteDecision is not exported and exporting it is the right move if needed; RunLoopFromStateOptions is a growth point that B2 and C1 add keys to, so no second options type and no collapsing it to a positional; A8 modifies src/controller/resumeLoop.ts, which also holds evaluateResumeEligibility whose eight criteria A6 just pinned, so the count guard must still read 8; and the parked A4 minor about runLoop.integration.test.ts's two plan-mandated near-identical reconciliation literals, which must be neither merged nor worsened.
Task A8: dispatch also told the implementer that an optional callback is unusually easy to fake coverage for — a spy test proves wiring only if the spy could have gone uncalled — and required a per-layer mutation that drops the parameter on the floor at that layer alone.
Task A8: implemented (commit 57da4b3, 481 tests, +4), DONE_WITH_CONCERNS. Review returned Needs fixes — 1 Important, 1 Minor, 0 Critical.
Task A8: reviewer independently confirmed the task's CENTRAL risk is discharged, not faked — it read both runLoop.ts call sites and writeBoundaryArtifacts's call-site object literal and verified each of the four layers has a mutation killing a test attributable to THAT layer alone, rather than one end-to-end test standing in for four. Also grepped all 16 pre-existing `resumeLoop(` call sites, found none passes a third argument, and so confirmed the implementer's extra test was genuinely necessary rather than gold-plating.
Task A8: Important (in fix round 1) — src/controller/runLoop.ts:runLoopFromState's `if (execution === null)` branch reached when executeOutcome.timedOut is FALSE forwards the callback on a line no test covers. A future edit dropping options?.onReconciliationWriteAbandoned from that line alone, leaving the sibling call site correct, passes all 481 tests undetected. Disclosed by the implementer, confirmed reachable by the reviewer.
Task A8: CONTROLLER RULING (third application of the same Rule 7 call, kept consistent across A7 and A8). The brief's Step 7 asked for 「either segment」 mutated once and §9 only required both call sites be CHANGED, which they were — so the gap is not a spec violation. But the Global Constraints require 「加一个成分和加它的覆盖是一件事」, and the two clauses conflict; the general coverage rule governs, so adding the covering test SATISFIES the plan rather than contradicting it. No human ruling sought, by the same reasoning recorded for A7.
Task A8: fix round 1/5 dispatched (resumed the original implementer) — cover the non-timeout `execution === null` call site with its own line-local mutation, plus the layer-4 test's missing fixture-precondition assertions.
Task A8: fix round 1/5 — the Important DISSOLVED rather than being fixed, and the implementer was right to escalate instead of substituting. It reported NEEDS_CONTEXT claiming the requested coverage is impossible, not awkward. The controller did NOT pass that unverified premise to the human (the lesson from the A5 erratum, where an uncalibrated claim propagated into a ruling); it dispatched an independent verification first.
Task A8: UNREACHABILITY PROVEN by independent source reading, five links each with the symbol read:
  1. src/controller/runLoop.ts:runLoopFromState's `if (execution === null)` non-timeout site passes executionRecovery as a literal `undefined`; no parameterisation or injection point can substitute another value without editing the source.
  2. src/controller/runLoop.ts:buildBoundaryEvidence — persistBoundaryAnalysis calls it as buildBoundaryEvidence(executionRecovery ?? null), and the null branch unconditionally returns a fixed literal referencing no other variable.
  3. src/stop/stopController.ts:evaluateRunBoundary — its verdict depends only on observedStrongProgress (hardcoded false at this call), continuitySuspicion.length (0) and observedWeakProgress (false), so it deterministically falls through to `no_progress`.
  4. src/controller/runLoop.ts:persistBoundaryAnalysis — the transfer branch is gated on status === "stale_candidate", so nextOwnerEpoch stays null and reconciliationRecord evaluates to undefined.
  5. src/persistence/fileStore.ts:writeBoundaryArtifacts — the entire abandon block INCLUDING the callback sits inside `if (artifacts.reconciliationRecord !== undefined)`.
  The forwarded argument at that call site is dead code today. Reactivation requires editing that call site to pass a real ExecutionRecovery, or editing persistBoundaryAnalysis's own hardcoded internals.
Task A8: the verifier also found something neither the implementer nor the controller knew — a PRE-EXISTING, unchanged test already pins this branch: tests/controller/runLoop.integration.test.ts 「writes no_progress without a reconciliation record for a non-stale null execute result」 asserts no_progress and an absent reconciliation-record.json. That collapses the implementer's proposed 「add a pinning test」 option: an equivalent already exists. Corroborates the chain independently of the deleted probe.
Task A8: CONTROLLER ADJUDICATION, no human ruling sought and none needed. The landed state (argument kept per brief §9 + an accurate in-place comment) conforms to the plan, so no plan conflict exists to escalate. The original Important was 「a live path with no covering test」; the path is verified NOT live for the callback, so the finding dissolves rather than being waived.
Task A8: minor (deferred) for GATE-A triage:
  1. whether to keep a provably-dead forwarded argument at runLoopFromState's non-timeout `execution === null` call site is a merge-time design question. Keeping it conforms to brief §9; removing it would contradict §9 and needs a ruling. GATE-A has the whole-branch view and this ledger entry as input.
  2. the landed comment's re-activation condition names only the direct trigger (giving this branch real execution recovery) and not the second one (changing persistBoundaryAnalysis's hardcoded observedStrongProgress/previous internals, which would reactivate without touching that line). Judged a completeness gap, not a mechanism misstatement.
  3. layer-4 test's fold-in landed as 「asserts unreplaced rather than absent」 because seedEligibleRun legitimately writes a reconciliation record — an appropriate adaptation of the sibling 12d(iv) test's rigor, recorded so GATE-A does not read it as a weaker assertion.
Task A8: complete (commits f264cd1..56eb6e3, review clean after one fix round)

Task A9: BASE = ced77e5. Implementer dispatched (opus, the most capable model, per the human's ruling that A9 keeps it because test 6e is the only guardrail for this layer's ordering reversal and does not exist on main today).
Task A9: the dispatch's central instruction — mutation 1 was NOT verifiable at plan time (finalizeOrder had two entries; the three-entry version is what A2 built; the fifth-wave reviewer wrote "I cannot tell whether it would go red"), and A9 was sequenced after A2/A3 precisely so the injection becomes expressible and is DISCHARGED HERE. The implementer was told to actually inject, actually run, actually paste; that a non-red result is a real finding about the assertion's shape, not something to reason away; and that it must not soften the assertion until it passes.
Task A9: dispatch also carried the three documented ways this test gets built wrong — no terminal-state assertions (P1's third rename restoring the record is harness-imposed ordering, not a system property, and asserting it would write a damaged trajectory into the suite, verbatim the reason an earlier draft was condemned); mutation 2 is "the live-process check was removed", NOT "the lock's held range was narrowed" (that injection point is a structurally equivalent mutation, identical in all four cells and unkillable by any fixture); and mutation 1's assertion is weaker than "the winner was not overwritten" and must say so in the test's own comment, because the residual TOCTOU is not closed at this layer.
Task A9: cross-task facts carried — A3's isValidFinalizeOrder accepts any complete permutation, so the permuted constant stays expressible (implementer told to confirm, and to stop if the validator rejects it, since the mutation would then be testing the validator); A7 reshaped preserveSuccessfulReconciliationIfNeeded into a discriminated union and the read side now attributes ENOENT by which read caught it, which is exactly what mutation 1's spy assertion turns on, so the shape to pin is A7's and not the pre-A7 shape the plan was written against; A8 added the optional callback parameter to writeBoundaryArtifacts; A5's crash-gap test was renamed.
Task A9: told to report BLOCKED rather than substitute a fixture-driven interleaving if the deterministic-interleaving skeleton does not come together — a fixture-decided interleaving point would put the fixture inside the mutation surface and make the whole test worthless.
Task A9: implemented (commit d27f317, 482 tests, +1, test-only). Review returned APPROVED — 0 Critical, 1 Important (plan-mandated), 6 Minor.
Task A9: *** THE PLAN'S ONE OPEN RISK IS DISCHARGED. *** Mutation 1 (finalizeOrder permuted to [reconciliation, transfer, owner]) GOES RED — `expected [ 'failed:ENOENT' ] to include 'ok'` — and the reviewer verified the red is MECHANISM-CORRECT rather than incidental: it grepped every call site and confirmed readOwnerTransferRecordRaw via readPersistedSuccessfulTransferArtifacts is the ONLY reader of owner-transfer.json on the loser's path (the other readers, resumeLoop.ts and src/registry/readObservedFile.ts, are on different entry points), so the failed:ENOENT singleton is the protective read and nothing else. The plan explicitly refused to promise this outcome ("第五轮评审员明说「它是否会红我分辨不出」"); A9 was sequenced after A2/A3 to discharge it, and it is now discharged on the predicted assertion and the predicted mechanism.
Task A9: the structural insight that makes mutation 1 expressible, verified by the reviewer against fileStore.ts:finalizePendingOwnerTransfer — the window trigger keys on MEMBERSHIP IN THE THREE FIXED PUBLISH-TEMP NAMES, a set invariant under any finalizeOrder permutation. Permuting the constant moves what is on disk in the window without moving where the window is, which is precisely what keeps the fixture outside the mutation surface. Staging cannot open the window early (its four temp names are disjoint from the publish set), and buildAtomicTempPath's output cannot collide with the publish temps structurally (it emits `.{basename-with-.json}.{stamp}.{seq}.tmp`; publish temps are `.{name}.publish.tmp` with no .json segment and no numeric field).
Task A9: mutation 2 verified as injected at the RIGHT point — tryRecoverStaleOwnerTransferLock's `if (pid !== null && isProcessActive(pid)) { return false; }`, not the structurally-equivalent pathExists conjunct. All four cells checked against source; only the live-pid cell flips, and that is the fixture's cell. Reviewer also traced that both reds are AssertionErrors rather than fixtures that stopped building: finalizePendingOwnerTransfer reads every pending into `staged` before its rename loop, so even under mutation 2 P1's remaining renames write from memory and succeed.
Task A9: implementer's three concerns all adjudicated by the reviewer — (1) the wide observation window does not admit a false green today, the only reader of owner-transfer.json reachable on that path being the protective one; (2) `if (false && …)` is faithful to "the live-process check was removed" because `pid` is computed above the `if` and only the isProcessActive call is elided; (3) the missing intermediate green is DISCHARGED BY STRONGER EVIDENCE — mutation 2's failure block shows (a) passing, which is only possible if finalizeOrder had already been reverted.
Task A9: HUMAN RULING (plan-mandated). The brief's Step 2 mandated the test name `keeps the loser from writing through the winner's reconciliation inside the publish window`, whose first clause has NO assertion behind it and states something the test's own comment correctly documents as FALSE today — in the window the owner record is still epoch 1, transferRepresentsPublishedWinner returns false, and the loser does write its downgrade, because the residual TOCTOU is not closed at this layer. A name asserting the opposite of a documented fact is worse than one that merely overstates scope, and the name rather than the comment is what appears in failure output. Human ruled: RENAME to what the test actually pins — `reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window` — clause 1 mapping to assertion (a) and clause 2 to assertion (b), with an in-place plan erratum in `### Task A9` recording why.
Task A9: fix round 1/5 dispatched (resumed the original implementer) — the rename, both mutations re-run under the new name, report supersession markers, the plan erratum, and a fold-in correcting the comment's claim that (a) pins whether the check was EVALUATED (strictly it pins the precondition; a throwing readOwnerRecord in the following Promise.all would yield unreadable -> abandon, leaving (a) green with the check unevaluated).
Task A9: minor (deferred) for GATE-A triage:
  1. assertion (a) is one link short of "the check was evaluated" (see the fold-in above); the residual path is loud rather than silent. Inherited from the brief, which specifies this exact observable.
  2. full-suite outputs in the A9 report are excerpted to their summary and failure blocks, disclosed as such, with every run fully redirected to a file and no filtering pipe; the two blocks carrying the verdict (the single-runs) are pasted whole.
  3. the six-unrelated-tests noise list and count live in the report rather than the test comment; the comment carries the brief's mandated "this list is noise not guardrail" sentence and points at the report. Defensible since the brief itself says the count will rot.
Task A9: fix round 1/5 COMMITTED (6226fb6) — renamed to `reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window`, clause mapping verified before commit (clause 1 -> assertion (a) killed by mutation 1, clause 2 -> assertion (b) killed by mutation 2, no assertion adjusted to fit the name); both mutations re-run under the new name with a green single-run BETWEEN the two experiments this time; the comment now states (a) pins the successful protective read (the precondition) and names the one path that satisfies (a) without the check running; plan annotated as `Amended 2026-08-02 (d)` in `### Task A9` Step 2 only. src/ byte-identical. Implementer self-caught one elision it had introduced in the build output and replaced it.
Task A9: *** SCOPED RE-REVIEW OF FIX ROUND 1 IS STILL OWED. *** It is the immediate next action, BEFORE GATE-A. Verify: the four re-run mutation blocks are whole, red on the NEW name, with nonzero named counts; the comment's reworded (a) claim is accurate; and the plan erratum touched `### Task A9` only with the original wording kept.
Task A9: the plan's Amended letters are now (a) Task A5 判据 B premise, three linked spots / (b) Global Constraints §10's -t form + anti-fake-green guard / (c) Task A5 判据 A phrasing / (d) Task A9 Step 2's mandated test name. Verify with `grep -nF 'Amended 2026-08-02' docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`.

=== SESSION 3 RESUMED HERE (group A already merged into main AND already pushed; the gate is still shut) ===
State re-verified by the controller before touching anything, with commands rather than by trusting the handoff:
  `git ls-remote origin refs/heads/main` -> 94d7c0a (the second group-A merge IS on the remote). Local main b126137 (the handoff commit) is the only unpushed thing. CONSEQUENCE: any GATE-A "must fix" is a post-publication correction on top of main, NOT a history rewrite. Human confirmed the fix location: additional commits directly on main.
  Branch feat/l3-debt1-transactional-continuation (20457e6) and worktree .claude/worktrees/l3-debt1-group-a both still present; both work trees clean.
  Both group-A merges (787789e, 94d7c0a) carry `*** THIS IS NOT GATE-A. ***` and no review verdict, so plan §15 acceptance 7 still cannot locate a gate.
Baseline re-measured on main by the controller, unfiltered via `rtk proxy`, ECC_GATEGUARD=off DISABLE_OMC=1:
  `Test Files 29 passed (29)` / `Tests 482 passed (482)`, TEST_EXIT=0, Duration 17.62s; TYPECHECK_EXIT=0; BUILD_EXIT=0. Neither allowed flake (B) nor (F) appeared.
  Three guards on main: `return { ok: false` = 8; `currentOwnerEpoch + 1` single hit (src/ownership/ownerController.ts:166); `git diff --name-only ba8f8a0..feat/l3-debt1-transactional-continuation -- src/registry/` empty.
  Plan errata (a)(b)(c)(d) all four present.
CORRECTION to the handoff: `scripts/review-package` does NOT exist in this repo (scripts/ holds only claude-phase-runner.mjs). It lives in the skill: ~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0/skills/subagent-driven-development/scripts/review-package. Use the absolute path; do not invent a substitute packaging step.

Task A9: SCOPED RE-REVIEW OF FIX ROUND 1 IS DONE — the debt recorded above is discharged. Range d27f317..6226fb6 (1 commit, 2 files, +31/-9), package review-d27f317..6226fb6.diff. Reviewer was a fresh session-3 subagent (opus, per the human's cost ruling that A9 keeps the most capable model). Verdict: all five items ADDRESSED, 0 Critical, 0 Important, 1 Minor.
Task A9: what the re-reviewer established rather than accepted —
  1. all four re-run mutation blocks are whole (each carries Start at / Duration / echoed EXIT) and each shows a NONZERO named count (`1 passed | 52 skipped (53)` / `1 failed | 52 skipped (53)`), so the vitest-2.1.9 all-skipped fake-green shape is absent from every block; both reds print the NEW name in both the `×` line and the FAIL header.
  2. the `-t` argument was compared BYTE-FOR-BYTE against the landed `it()` name via a node script (a shell one-liner cannot carry the apostrophe in "winner's"): both 137 bytes, BYTE_EQUAL true, and equal to the name the plan erratum mandates. This is the check that catches a mistyped name, which is the risk a rename introduces and which the -t form fix alone does not close.
  3. NO assertion was adjusted to fit the new name: `git diff --numstat d27f317..6226fb6` is 6/0 on the plan and 25/9 on the test file, and the only two non-comment changed lines are the old and new `it(` headers. Both assertions appear as unchanged context.
  4. clause 1 -> (a) killed by mutation 1 (`expected [ 'failed:ENOENT' ] to include 'ok'`), clause 2 -> (b) killed by mutation 2 (received the three publish temps). Independence shown in both directions: block 2 fails at (a) with (b) unreached; block 4 shows (a) passing and stops at (b).
  5. the plan erratum is INSERT-ONLY (0 deletions), single hunk at 1117-1122, between `### Task A9` (1040) and `### GATE-A` (1139); original wording kept; letter (d) unique.
  6. `src/` byte-identical — the fix diff's whole file list is the plan file and the test file.
Task A9: minor (deferred) for GATE-A triage:
  4. the reworded `⚠️ What assertion (a) pins` comment says "One path satisfies (a) without the check ever running" but there are TWO. CONTROLLER-VERIFIED against source rather than taken from the reviewer: src/persistence/fileStore.ts:564 `readOwnerTransferRecordRaw` is a single statement `JSON.parse(await readFile(...))`, and the test's spy (tests/controller/runLoop.integration.test.ts, the doMock'd readFile) pushes "ok" the instant `actual.readFile` resolves — BEFORE the parse. So a present-but-torn owner-transfer.json records "ok" for (a), then the parse throws SyntaxError, which is non-ENOENT, so the first catch returns `{ kind: "unreadable" }` -> abandon and transferRepresentsPublishedWinner is never evaluated. The comment's substantive claim (that (a) pins the precondition, not the check) is CORRECT and this second path reinforces it; the defect is that the sentence reads as an enumeration when it is an example. Comment accuracy only — neither assertion's kill power is affected.
  5. same comment block: "routed to the operator callback and events.jsonl" is conditional — onReconciliationWriteAbandoned is optional at all four layers, and writeBoundaryArtifacts's own in-source note says that absent the callback the abandonment is recorded in events.jsonl only.
Task A9: COMPLETE (commits ced77e5..6226fb6, review clean after one fix round + scoped re-review).

*** GROUP A's NINE TASKS ARE ALL COMPLETE AND EACH INDIVIDUALLY REVIEWED CLEAN. THE ONLY REMAINING WORK IN THIS GROUP IS GATE-A ITSELF. ***

=== GATE-A BLOCKER: the post-resume published-winner replacement (Option 2 implemented) ===

THE DEFECT, AS ESTABLISHED BY EXECUTION (not by reading the code — that is the point):
  `transferRepresentsPublishedWinner` in src/persistence/fileStore.ts is a three-clause conjunction. Its
  third clause is `ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId`.
  src/controller/resumeLoop.ts builds `nextOwnerRecord` by spreading `ownerRecord` — so
  `currentOwnerEpoch` is UNCHANGED — with a fresh `buildProcessInstanceId()`, then CAS-writes it via
  `claimOwnerRecordWithPrecondition`. Therefore after ANY successful resume the third clause is false AT
  THE SAME EPOCH, with no race and no crash.
  A probe drove the real resumeLoop -> runLoopFromState -> persistBoundaryAnalysis -> writeBoundaryArtifacts
  chain and observed: `heartbeat.assertHeld()` PASSES (the resumed process legitimately owns the run);
  control reaches the `nextOwnerEpoch === null` arm carrying a downgraded record;
  `preserveSuccessfulReconciliationIfNeeded` returns `{ kind: "write" }`; and the previously-published
  `eligibleForContinuation: true` reconciliation record is OVERWRITTEN by the downgrade with ZERO events
  and ZERO callbacks — because both `onReconciliationWriteAbandoned` and the
  `reconciliation_write_abandoned` event live in the `abandon` arm, and this takes the `write` arm.

THE HUMAN RULING (recorded, not reopened):
  S-3's "never permit more" DOES forbid preserving an already-published eligible record in the window
  after a legitimate resume CAS. The obvious fix — deleting the third clause — is permit-MORE: with it
  deleted, `evaluateResumeEligibility` flips from `{ok:false}` to `{ok:true}` for a surviving winner
  record, for an ABSENT record, and — worst — for a CORRUPT one, where
  `readPersistedReconciliationRecord`'s `catch { return undefined }` routes the corruption into the
  synthesis arm, which fabricates `eligibleForContinuation: true` over a file that today makes resume
  refuse outright.
  Four reasons on the record:
    1. the permit-more is MEASURED while the benefit is ARGUED;
    2. the corrupt-file case cannot be separated from the one-line deletion without a second, uncovered
       change;
    3. a live 2026-07-27 ruling deleted a reconciliation-synthesis path on exactly this ground and
       accepted losing the synthesis;
    4. the deletion's safety would rest on a crash window that group B/C may remove.

WHY OPTION 2 RATHER THAN THE PREDICATE CHANGE:
  The predicate's behaviour is forbidden to change, so the only thing left to fix is the SILENCE. Option 2
  writes the downgrade exactly as today and additionally records the loss. It is inert by construction:
  the reconciliation write, the decision, and every existing arm are untouched; the only new runtime
  effect is one appendEvent that is swallowed on failure. `transferRepresentsPublishedWinner`'s body is
  byte-identical (sha256 of the function body, `awk '/^function transferRepresentsPublishedWinner\(/,/^}$/'`
  piped to `shasum -a 256`: b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f, before AND
  after). Only a comment was added above it — the symbol was NOT renamed, because six call-site-and-doc
  linkages elsewhere reference it by name.

WHAT WAS BUILT:
  1. `describePublishedWinnerReplacement` in src/persistence/fileStore.ts — the detection point. It is
     `shouldProtectSuccessfulTransferTruth`'s own conjunction with the first conjunct negated, expressed by
     CALLING the same two predicates rather than restating either:
     `transferRepresentsPublishedWinner(...) === false && shouldPreserveExistingReconciliationRecord(...) === true`.
     The synthesis disjunct is deliberately NOT asked: synthesis requires
     `persistedReconciliationRecord === undefined`, so nothing on disk is destroyed there and there is no
     loss to record.
  2. `ReconciliationWriteDecision`'s `write` arm gained an OPTIONAL `publishedWinnerReplacedDetail?: string`.
     No third arm: the union is not exported and group C's planned test 12d reaches this channel through
     resumeLoop / writeBoundaryArtifacts / runLoopFromState without destructuring it, so a third arm would
     make group C absorb a shape change for nothing.
  3. `writeBoundaryArtifacts` appends a `reconciliation_published_winner_replaced` event carrying both
     epochs and both process instance ids — AFTER the reconciliation write (the event asserts a record was
     destroyed; if `writeJsonFileAtomically` throws, it was not), inside a swallowing `try { … } catch { }`
     matching the abandon arm's existing swallow in form and reasoning. THE SWALLOW IS LOAD-BEARING:
     `appendEvent` is a bare `appendFile` that can reject, and left unswallowed an unwritable events.jsonl
     would propagate into `runLoopFromState`'s outer catch (where `isLeaseStopError` does not match an I/O
     error) and convert a SUCCESSFUL write into a FAILED attempt — the exact behaviour change Option 2 was
     chosen for not making. `RunEvent.type` is a bare `string` (verified at src/persistence/fileStore.ts,
     `export type RunEvent`), so no type change was needed for the new event name.
  4. One new test in tests/persistence/fileStore.test.ts pinning BOTH halves on the post-resume fixture.

FINDING — CONTRADICTS THE DISPATCH, reported rather than worked around:
  The dispatch named `shouldPreserveExistingSuccessfulReconciliation` among the helpers to consider as a
  detection point. That helper is DEAD CODE: `grep -rn 'shouldPreserveExistingSuccessfulReconciliation'
  src tests` returns exactly one hit — its own definition at src/persistence/fileStore.ts. The live
  protection calls `shouldPreserveExistingReconciliationRecord` instead. The two are LOGICALLY IDENTICAL:
  `shouldPreserveExistingReconciliationRecord`'s `(isLoserDowngradeAttempt(n,t) ||
  shouldSynthesizeSuccessfulReconciliation(undefined, n, t))` reduces to `(A || A)` because
  `shouldSynthesizeSuccessfulReconciliation(undefined, …)`'s first conjunct is `undefined === undefined`.
  The live one was used so the detection point is literally the negated conjunct of the live predicate.
  The dead duplicate was NOT deleted — Rule 3, and it is not this change's blast radius. Flagged for
  GATE-A triage.

WHAT REMAINS OPEN:
  1. The winner's published reconciliation record is STILL DESTROYED on this path. Option 2 records the
     loss; it does not prevent it. That is the ruling's accepted cost, not an oversight.
  2. The crash-window reachability was NEVER SIMULATED. Reason 4 above rests on it, and it is asserted, not
     measured.
  3. *** FOR GROUP C's BRIEF: *** if group B/C introduces a SECOND non-terminal route to
     `persistBoundaryAnalysis`, that removes the bound which makes the predicate change unsafe today —
     i.e. it reopens the ruling. Group C's brief must carry this line.

VERIFICATION (unfiltered, via `rtk proxy`, ECC_GATEGUARD=off DISABLE_OMC=1):
  `npm test -- --run`: `Test Files 29 passed (29)` / `Tests 483 passed (483)`, Duration 16.50s, EXIT=0.
  Baseline was 482; +1 is exactly the one new test. `npm run typecheck` EXIT=0. `npm run build` EXIT=0.
  Three guards re-checked after the change: `grep -cF 'return { ok: false' src/controller/resumeLoop.ts`
  = 8; `grep -rnF 'currentOwnerEpoch + 1' src/` = single hit (src/ownership/ownerController.ts:166);
  `git status --porcelain src/registry` empty.
  Mutation evidence (each a separate single-run, both with NONZERO named counts, whole blocks in
  gate-a-option2-report.md): delete the append -> half (ii) RED (`ENOENT … events.jsonl`,
  `1 failed | 74 skipped (75)`); delete the predicate's third clause -> half (i) RED
  (`expected 'OWNER_LOST' to be 'OWNER_UNDECIDABLE'`, `1 failed | 74 skipped (75)`). Reverted after each,
  revert proven by a green single-run (`1 passed | 74 skipped (75)`) AND by the function-body sha256
  matching the pre-change value.

FIX ROUND 1 ON OPTION 2 (commits bf5d12d fix, 5495c9b test, 03ba382 comments, + this docs commit)
  Independent review of b70b40f / 0d557e9 / 9fe1f02 returned "Needs fixes": 1 Important, 3 Minor. Follow-up
  commits only — main was already pushed; nothing amended, rewritten, or forced. Full evidence, every block
  whole, in gate-a-option2-report.md's "FIX ROUND 1" section.

  F1 (Important) — FIXED. describePublishedWinnerReplacement was NOT TOTAL. It evaluates
  shouldPreserveExistingReconciliationRecord on the !transferRepresentsPublishedWinner square; the
  pre-change code reached that helper only through shouldProtectSuccessfulTransferTruth's `&&`, i.e. only
  when the predicate was TRUE, so the complement square was newly evaluated. readPersistedReconciliationRecord
  casts an unvalidated JSON.parse result, so a reconciliation-record.json parsing to `null` is `!== undefined`
  and isSuccessfulReconciliationForTransfer dereferences it. MEASURED on one fixture, both trees: pre-change
  writeBoundaryArtifacts returns and the downgrade lands; as landed a TypeError propagates out through
  persistBoundaryAnalysis into runLoopFromState's outer catch (isLeaseStopError does not match) and ENDS THE
  ATTEMPT AS FAILED, boundary-analysis.json already written and the corrupt file still in place. Only `null`
  throws — `[]`, `"x"`, `1`, `true` box harmlessly — and no writer in this repo can produce it, hence
  Important not Critical, and permit-LESS not permit-more. It was still A DECISION THAT MOVED, in a change
  whose entire warrant is that none does.
    Form: try/catch around the whole detail computation, INSIDE describePublishedWinnerReplacement. Rejected
    validating in readPersistedReconciliationRecord — that also changes the predicate-TRUE square, where a
    corrupt record would then route into the SYNTHESIS arm, i.e. permit MORE, which is exactly reason #2 of
    the ruling. Rejected a `null` guard — needs a cast against `ReconciliationRecord | undefined` and hardens
    against one value rather than any shape. The containment is scoped so the predicate-TRUE square still
    throws exactly as it did before this signal existed; preserveSuccessfulReconciliationIfNeeded's object
    literal evaluates `record:` before `publishedWinnerReplacedDetail:`, which keeps that ordering true.
    Pinned by a new test on the `null` fixture asserting the downgrade STILL LANDS. Killing mutation: delete
    the try/catch -> `1 failed | 75 skipped (76)`, EXIT=1, "Cannot read properties of null"; restored ->
    `1 passed | 75 skipped (76)`, EXIT=0. Both counts nonzero for the named test.

  F2 (Minor) — FIXED, comments only. describePublishedWinnerReplacement's header and
  transferRepresentsPublishedWinner's closing sentence described the fire condition as "(a) holds, (b) does
  not" / "would have protected but for the process-instance-id clause". The code tests
  `!transferRepresentsPublishedWinner`, a strict SUPERSET — `eligibleForContinuation === false` or
  `currentOwnerEpoch !== newOwnerEpoch` land there too. Not reachable from applyOwnerEpochTransfer (always
  writes eligibleForContinuation: true), so behaviour was never wrong; but an inaccurate comment on this
  exact symbol is what made F1 require execution to find. Both now name the predicate.

  F3 (Minor) — FIXED as a reword, and THE GAP IS NAMED, NOT CLOSED. The synthesis-disjunct justification said
  synthesis requires persistedReconciliationRecord === undefined "so nothing on disk is destroyed there".
  True of preserved TRUTH, false of disk contents: readPersistedReconciliationRecord's
  `catch { return undefined }` maps a CORRUPT file to undefined too.
    *** KNOWN GAP — CORRUPT-FILE SQUARE ***: when reconciliation-record.json exists but is CORRUPT and the
    write reaches the synthesis square, the corrupt file is overwritten with NO reconciliation_published_
    winner_replaced event and no other output — the same silence Option 2 exists to remove, one square over.
    Deliberately not covered: widening the signal to distinguish absent from corrupt is a different change
    with a different justification, and it is the SAME absent-vs-corrupt conflation that is reason #2 of the
    2026-08-02 human ruling. Carried to GATE-A triage alongside the dead-helper item. The new F1 test
    deliberately makes NO assertion about events.jsonl so that closing this gap does not turn it red.

  F4 (Minor) — SUPERSEDED, not edited. *** SUPERSESSION NOTE: commit 0d557e9's message says deleting the
  predicate's third clause "kills (i) only". THAT IS WRONG. *** Measured with a probe on the landed fixture:
  with the clause deleted the protection ENGAGES, so describePublishedWinnerReplacement's first disjunct is
  true, no detail is produced, and events.jsonl DOES NOT EXIST — mutation 2 kills half (ii) as well. Half (i)
  merely fails first because its assertions come first in the test body. 0d557e9's message is published
  history and stands as written; this entry and gate-a-option2-report.md §FIX ROUND 1.4 supersede it, per this
  repo's convention for a published statement that turned out wrong.

  OUT OF SCOPE, CONFIRMED LEFT ALONE: the reviewer's third item — deleting
  shouldPreserveExistingSuccessfulReconciliation, the dead helper whose agreement with the live predicate
  rests on an unreduced (A || A) — is deferred to GATE-A triage. This ledger already carried it (see the
  FINDING block above, "Flagged for GATE-A triage"); verified by reading, nothing added.

  VERIFICATION (unfiltered, via `rtk proxy`, ECC_GATEGUARD=off DISABLE_OMC=1):
  `npm test -- --run`: `Test Files 29 passed (29)` / `Tests 484 passed (484)`, Duration 16.70s, EXIT=0.
  Baseline for this round was 483; +1 is exactly the one new test, and both throwaway probe files were
  deleted before this run. `npm run typecheck` EXIT=0. `npm run build` EXIT=0.
  Guards re-checked after the change: `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` = 8;
  `grep -rnF 'currentOwnerEpoch + 1' src/` = single hit (src/ownership/ownerController.ts:166);
  `git status --porcelain src/registry/` empty. transferRepresentsPublishedWinner's function-body sha256,
  via `awk '/^function transferRepresentsPublishedWinner\(/,/^}/' src/persistence/fileStore.ts | shasum -a 256`,
  is b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f — unchanged. Only the comment ABOVE the
  predicate moved.

  STILL OPEN, UNCHANGED BY THIS ROUND: the winner's published reconciliation record is still DESTROYED on
  this path (Option 2 records the loss, it does not prevent it); the crash-window reachability is still
  asserted rather than simulated; and the line for group C's brief still stands — a SECOND non-terminal route
  to persistBoundaryAnalysis reopens the ruling.

================================================================================
*** GATE-A: PASSED. 2026-08-03. ***
================================================================================

This entry is the gate's review verdict. The merge commit that carries it in its
subject line is what plan §15 acceptance 7 criterion (1) locates.

REVIEWERS. Two, dispatched in parallel with deliberately disjoint lanes, both on
the most capable model, NEITHER having worked on any of A1-A9 (session 3 is a
fresh session; independence is structural, not asserted).
  Lane 1 — production code, whole-branch design coherence, risk grading.
  Lane 2 — triage of the deferred Minor backlog, and a re-scan of every mutation
           evidence artefact across all nine tasks.
Range: the fixed anchors ba8f8a0..feat/l3-debt1-transactional-continuation.
`git merge-base main HEAD` does NOT compute this range — the branch was already
merged before the gate ran. Do not substitute it.

THE PLAN'S OWN GATE-A STEP 1 CHECKLIST — ALL SIX PASS.
  C1 cleanupOwnerTransferStagingWithoutMarker = exactly 10 individually-named
     safeUnlink; all six linked sites agree, checked one at a time against code.
     ONE LIMITATION STATED RATHER THAN PAPERED OVER: the fifth site ("test 14
     mechanism 2 = 11") cannot be checked against code today — sweepRuns does not
     exist yet, it is group C's. The spec text is self-consistent; that cell is
     verifiable only after group C lands.
  C2 finalizePendingOwnerTransfer's catch gained exactly one symmetric safeUnlink;
     semantics otherwise byte-identical. The try-head pair moved into the publish
     loop, which is the plan's mandated per-entry form, not a semantic change.
  C3 evaluateResumeEligibility byte-unchanged — proven by shasum of the function
     body on both sides (cae8933d15640f116c9cad6c36daa469b5fcc49a), not by reading.
     A6's eight-criteria mutation campaign therefore still stands.
  C4 the four-layer callback channel is optional at every layer and changed no
     return type; both call sites forward at each of the two forwarding layers.
  C5 both places the plan itself called "never verified" carry raw output, and
     A9's mutation 1 is red on the predicted assertion via the predicted mechanism.
     *** THE PLAN'S ONE OPEN RISK IS DISCHARGED. ***
  C6 37 mutation experiments swept across all nine tasks plus the errata: 37 of 37
     are paired (pre-injection green + post-injection red), every block shows a
     NONZERO named count, and no kill is credited to a neighbouring test. ZERO
     fake greens: the only two all-skipped blocks in the whole corpus are labelled
     demonstrations of that very defect. Named exceptions, form only: trailing
     truncation is confined to A1 (12/12 blocks) and A2 (13/13) and to no other
     task; 9 of 37 experiments cite a pre-injection green located elsewhere in the
     same report rather than beside the red; revert proof is uneven (A6 is the
     gold standard, A1 and A4 establish revert only in aggregate).

DEFERRED-MINOR TRIAGE. 44 discrete items, re-derived by COUNTING the itemised list
in this ledger — not copied from the handoff's "about thirty", which undercounts.
Both the controller and lane-2 reviewer counted 44 independently. Disposition:
6 FIX BEFORE GATE (all landed, see below) / 11 CARRY TO GROUP C / 2 CARRY TO L5 /
21 RECORD ONLY / 4 NO LONGER APPLICABLE.

FIXES LANDED BEFORE THIS GATE. Two waves, each followed by a mandatory re-review,
because this repo's record is twelve consecutive fix waves each carrying a defect
and not one found by the implementer who wrote it. That record held again: wave 1
carried a false mechanism claim, caught by its re-review.
  Wave 1 (8 items): test 6d's inode clause moved above the shape guards so the
    clause the test is NAMED for can fail (verified: A4's mutation 2 now reds on
    the inode assertion, not on capturedArtifactKeys); the plan's Task A5 Step 3
    stopped naming a test that no longer exists (a live fake-green trap inside the
    plan); the plan's own `-t` audit sentence corrected — it was FALSE, A4 twice
    passed a PREFIX of an it name; two comment-accuracy corrections on test 6e;
    the A7 S-3 adjudication scoped to the ENOENT arm; A2's block count 12 -> 13.
  Wave 2 (4 items): wave 1's "second re-activation route" was factually wrong in
    both directions and its back-pointer sat on two literals that do not control
    the outcome — re-anchored on the real gate (buildBoundaryEvidence(null)'s
    empty continuitySuspicion); an unconditional events.jsonl claim made
    conditional; the -t census corrected to 46 by a quoting-agnostic method (two
    method defects, not one); three report-artefact corrections.

THE ONE IMPORTANT FINDING, AND HOW IT WAS CLOSED.
  Lane 1 found that the loser's protective read compares a POST-recovery owner
  record against a PRE-recovery transfer record, and disposed of it itself as
  "defer to L5". The human declined that disposition on a reviewer's word and
  ordered an independent verification. That verification REPRODUCED all five links
  against source and, at the writeBoundaryArtifacts layer, with a running probe —
  and overturned the reviewer's own framing: the trigger is NOT a crash-timing
  race. transferRepresentsPublishedWinner also compares currentProcessInstanceId,
  and resumeLoop rewrites it on EVERY successful resume, so the protection fails
  with no marker, no crash and no interleaving.
  A second probe then drove the composed path through the real entry points
  (resumeLoop -> runLoopFromState -> persistBoundaryAnalysis ->
  writeBoundaryArtifacts) and observed the winner's published record replaced by a
  downgrade with zero events and zero callbacks. THAT SAME PROBE ALSO BOUNDED THE
  HARM, and the bound is recorded because it is inconvenient: on the only route
  that reaches the write, persistTerminalState runs in the very next statement, so
  the run is terminal anyway and the counterfactual with the winner's record
  restored is refused too. The observed harm is durable SILENT DESTRUCTION of a
  published record plus a wrong refusal reason — NOT a stranded resumable run. The
  scenario where a resumable run is stranded needs a crash between those two
  statements and WAS NOT SIMULATED and IS NOT CLAIMED.

  HUMAN RULING (S-3 scope). A design pass established that the instance-id clause
  is UNMANDATED — no ruling, no spec requirement backs it; the spec in fact
  miscounted the predicate twice. But deleting it was MEASURED to be permit-more:
  evaluateResumeEligibility flips {ok:false} -> {ok:true} for a surviving winner
  record, an ABSENT one, and a CORRUPT one — the corrupt case because the read's
  `catch { return undefined }` routes it into the synthesis arm, which FABRICATES
  eligibility over a file that today refuses resume outright. Human ruled:
  *** PRESERVING IS PERMITTING. The predicate must not change. ***
  Four recorded reasons: the permit-more is measured while the benefit is argued;
  the corrupt-file case cannot be separated from the one-line deletion without a
  second uncovered change; the 2026-07-27 ruling deleted a reconciliation-
  synthesis path on exactly this ground and accepted losing the synthesis; and the
  deletion's safety would rest on a crash window that group B/C may remove.

  WHAT LANDED (Option 2): the predicate is byte-identical — re-proven at the gate,
  function-body sha256 b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f
  — and the destructive replacement now appends
  reconciliation_published_winner_replaced instead of vanishing. Its review found
  the change was NOT decision-inert (a reconciliation-record.json parsing to
  literal `null` threw out of writeBoundaryArtifacts, ending an attempt that
  previously succeeded — measured on two trees), one fix round contained it, and
  the scoped re-review re-established inertness by comparing HEAD against the
  pre-signal tree across a 26-cell behavioural matrix: every outcome identical
  except the two new event lines. It also independently proved the rejected
  alternative really would have been permit-more.

WHAT IS STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED.
  1. The winner's published record is still DESTROYED — now recorded, not
     prevented. Reopening the predicate requires reopening the ruling above.
  2. The corrupt-file square is a KNOWN GAP: a corrupt reconciliation-record.json
     maps to `undefined`, so it is overwritten with NO event — the same silence
     this signal removes, one square over. Deliberately not widened; that is scope
     this change did not have.
  3. The crash-window reachability behind ruling-reason 4 was never simulated.
  4. IF GROUP B OR C ADDS A SECOND, NON-TERMINAL ROUTE TO persistBoundaryAnalysis,
     the bound that makes the predicate change unsafe today disappears and THE
     RULING REOPENS. Group C's brief must carry this line.
  5. shouldPreserveExistingSuccessfulReconciliation is DEAD CODE. It agrees with
     the live shouldPreserveExistingReconciliationRecord only through an unreduced
     (A || A); anyone who simplifies that disjunction desynchronises a live
     predicate from a same-named dead twin. Triaged to group C as a deletion.
  6. Two Minor artefact-integrity items in the Option-2 fix report: its three
     single-run fences record no -t command (the re-reviewer reproduced all three
     runs itself and confirmed them, so the substance is established by an
     independent party, but the artefact does not record it), and its guard-script
     fence does not match its output fence. All four guard values re-derive.
     [ANNOTATED IN PLACE 2026-08-03, original text above unchanged: THIS ITEM IS
     NOW CLOSED — see the POST-GATE ARTEFACT CLEAN-UP entry at the end of this
     file. Items 1-5 and 7 remain open.]
  7. ACCEPTANCE 7's LOCATOR, and why this gate is a merge. Criterion (1) runs
     `git log --merges` and prints %s — it enumerates MERGE commits and reads
     SUBJECT lines only. Group A was already merged twice, with identical subjects
     and both bodies explicitly disclaiming the gate, so a plain commit carrying a
     verdict would be INVISIBLE to it and $A4 was ambiguous between those two
     hashes. Human ruled the gate be written as a real --no-ff merge whose SUBJECT
     carries the verdict. That merge is the third and only verdict-bearing merge
     of this branch's work; $A4 is that hash.

FINAL VERIFICATION AT THE GATE, unfiltered, ECC_GATEGUARD=off DISABLE_OMC=1:
  Test Files 29 passed (29) / Tests 484 passed (484), TEST_EXIT=0, Duration 16.49s
  TYPECHECK_EXIT=0; BUILD_EXIT=0
  Guard 1 `return { ok: false` = 8
  Guard 2 `currentOwnerEpoch + 1` single hit, src/ownership/ownerController.ts:166
  Guard 3 `git diff --name-only ba8f8a0..HEAD -- src/registry/` empty
  Neither allowed flake (B) nor (F) appeared.

VERDICT: GATE-A PASSES. Zero Critical across the whole branch. The one Important
was verified by execution, ruled on by the human, closed by a reviewed change with
its own fix round and re-review. Group B's precondition is met. Group C's C1 can
fill in the gate hash: it is the merge commit that carries this verdict.

================================================================================
POST-GATE ARTEFACT CLEAN-UP. 2026-08-03. Closes GATE-A open item 6 ONLY.
================================================================================

Human ordered this before group B opens. Documentation only: no source file, no
test file and no plan file was touched, so no code conclusion of GATE-A is
affected and the gate hash e5bf650 is unchanged.

BOTH HALVES OF OPEN ITEM 6 ARE NOW CLOSED, each by measurement rather than by
assertion, and each labelled in place as a 2026-08-03 reconstruction rather than
back-dated into the original round.

  6a. The Option-2 fix report's three single-run fences recorded no -t command.
      The command was reconstructed and RE-RUN against today's unmutated tree. It
      is ONE LINE and is deliberately NOT wrapped to this file's 80 columns, because
      wrapping it broke it twice over: a continuation line beginning with `;` is a
      bash syntax error (exit 2), and a wrap inside the double-quoted string put
      vitest into watch mode with `run` demoted to a filter (`DEV v2.1.9` /
      `No test files found`). Copy the next line whole:

export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still lands the downgrade when reconciliation-record.json holds a value the record type cannot describe'"; echo "EXIT=$?"

      (The trailing `; echo "EXIT=$?"` is part of the command, not decoration: the
      first draft of THIS ledger bullet dropped it while still reporting EXIT=0 —
      the very defect class 6b names, recurring inside the entry announcing 6b's
      closure. Both that omission and the wrap that replaced it were caught by the
      clean-up round's re-reviewer, each time by running the bullet's block
      VERBATIM rather than reading it. The command matches the form recorded in the
      report, whose §5 fence already uses the identical `'"; echo "EXIT=$?"` form.)
      Observed: Test Files 1 passed (1) / Tests 1 passed | 75 skipped (76) /
      EXIT=0 — the same counts and exit code as the pre-injection fence it
      annotates. NONZERO named count, so this is not an all-skipped fake green.
      The two mutation fences differ from it only by the injected source, and no
      mutation was re-injected in this round: their substance was already
      established by THE OPTION-2 FIX ROUND's independent re-reviewer (not the
      clean-up round's), who reproduced all three runs. What was missing was the
      record, and only the record was added.

  6b. The report's guard-script fence omitted FIVE lines — the four `echo` headers
      and the trailing `echo "EXIT=$?"` — so the script as printed could emit
      neither the `== guard N: … ==` headers nor the `EXIT=0` that its own output
      fence shows. The corrected script was RE-RUN through rtk proxy and compared
      to that fence MECHANICALLY: `diff` exits 0, i.e. byte-identical. Guard 1 = 8;
      guard 2 = the single hit at src/ownership/ownerController.ts:166; guard 3
      empty; predicate sha256
      b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f; EXIT=0.
      Only the five echo lines were added; no guard, anchor or value changed.

  THE ANCHOR b126137 WAS CHECKED AND IS LIVE. `git rev-parse b126137^{commit}` →
  b126137ccfd174a9bdcff5fd158bf1b0833e3f2e, in both the main repo and the group-A
  worktree. No amendment to the anchor was made. Recorded because a transient
  "fatal: Needed a single revision" during this round briefly read as a dead
  anchor: that failure came from passing a COMPOUND command to `rtk proxy`
  (`rtk proxy "git rev-parse --short X && git log …"` — the shell operator and
  everything after it reach git as further revisions, exit 128). The plain form
  `rtk proxy "git rev-parse --short b126137"` exits 0 and prints b126137. It is
  stated as the COMPOUND form's failure rather than `--short`'s, because the first
  draft of this ledger entry blamed `--short` and that was FALSE — caught by the
  clean-up round's independent reviewer, who ran the command four ways, and
  re-verified by the controller before commit.
  CARRY FORWARD, NOT YET DONE: this trap belongs in the environment-trap list in
  docs/handoff/handoff.md, which today reads "三个会静默出错的环境陷阱" and
  enumerates three. This round did NOT touch that file — its scope is the two
  artefacts named above — so the trap currently lives ONLY here. Whoever next
  rewrites the handoff must add it as a fourth entry, or group B meets it cold.

STILL OPEN AFTER THIS ROUND: open items 1, 2, 3, 4, 5 and 7 of the GATE-A entry
above are UNTOUCHED. In particular item 4 — a second, non-terminal route to
persistBoundaryAnalysis reopens the "preserving is permitting" ruling — still
stands and must be carried into group C's brief. This round closed item 6 and
nothing else.

================================================================================
GROUP B OPENS. 2026-08-04. Task B1 Step 0: named reachability analysis.
================================================================================

Worktree .claude/worktrees/l3-debt3-heartbeat-stop, branch
feat/l3-debt3-heartbeat-stop, based explicitly on a7c26c9 (git worktree add ...
HEAD, NOT EnterWorktree's default of origin/<default branch>). Not pushed;
human authorised local-only for group B.

REMOTE STATE CORRECTION, recorded because the handoff says otherwise. At group
B's open, `git ls-remote origin refs/heads/main` = a7c26c9c9e7ec2a8ff8bc5e10f5
16ee80e8ebada = local HEAD. Everything through the handoff commits IS pushed.
No push was performed by this session. The handoff's "仍然没有 push" is now
FALSE; whoever next rewrites it must void that line.

THE QUESTION. Open item 4 above reopens the "preserving is permitting" ruling
IF group B or C adds a SECOND, NON-TERMINAL ROUTE to persistBoundaryAnalysis.
B1 adds exactly such a route in the literal sense: runExclusive's only
production call site is INSIDE persistBoundaryAnalysis (src/controller/
runLoop.ts:786), and B1 makes it throw, with the outer catch returning a
non-terminal state instead of calling persistTerminalState. So the question was
put to an independent verifier BEFORE any code was written, on the most capable
model, with both verdicts framed as live and neither pre-judged.

VERDICT: (B) THE BOUND'S SUBJECT DISAPPEARS; THE RULING DOES NOT REOPEN.
Report: task-B1-reachability-report.md (five links, each with a rerunnable
command and unfiltered output). The load-bearing structure, RE-VERIFIED BY THE
CONTROLLER against source rather than accepted on the verifier's word:
  - the refusal point is runExclusive at runLoop.ts:786;
  - the destructive writes are writeBoundaryArtifacts at runLoop.ts:903 and
    :905, i.e. AFTER the runExclusive call closes at :873, deliberately outside
    the exclusive span (the comment at :784 states that placement is on
    purpose);
  - between them sits only the unconditional `await heartbeat.assertHeld()` at
    :891, which B1's hard constraint 2 forbids this error from being thrown by;
  - therefore a RunHeartbeatStoppedError raised at :786 escapes BEFORE any
    boundary or reconciliation write occurs. The harm the bound describes — a
    published winner record silently destroyed — DOES NOT HAPPEN on this route.
    That is not the bound being broken; it is the bound's subject not existing.

THE VERIFIER'S OWN STATED FRAGILE PREMISE, AND WHAT WAS DONE ABOUT IT. The
verdict holds only if the `stopped` check precedes the INVOCATION of `fn`.
runExclusive today is `queue.then(fn, fn)` (leaseHeartbeat.ts:196-203): the two
natural refusal forms — reject at call time, or check at the head of the queued
continuation — both precede fn. But an implementation that settled fn first and
only then consulted `stopped` would let fn's line 819 persistOwnerTransfer
publish reconciliation-record.json transactionally BEFORE the throw escaped,
and the verdict would flip to (A). The plan's Task B1 does not pin this, and
neither test 7 nor its Step 10 review checklist distinguishes the two forms.

  CONTROLLER RULING (Rule 7, the same one applied three times in group A: "a
  component and its coverage are one thing", so adding the coverage SATISFIES
  the plan rather than departing from it). B1 carries one added hard
  requirement and one added assertion, both recorded here rather than left to
  the implementer's discretion:
    (1) the refusal MUST be evaluated before `fn` is invoked;
    (2) test 7 MUST assert, with a spy, that `fn` was NEVER CALLED — not merely
        that the call rejected. Mutation 1 (revert the refusal) reds it too.
  This is an addition to the plan's test 7, not a replacement: the "throws
  RunHeartbeatStoppedError" assertion stays.

NOT REOPENED, AND WHY IT IS STILL WRITTEN DOWN: open item 4's line must still
be carried verbatim into GROUP C's brief. This entry closes the question for
B1 only. B2's stop-request slot returns from the loop top and does not enter
persistBoundaryAnalysis at all, but that is B2's own analysis to make, not an
inheritance from this one.

--------------------------------------------------------------------------------
Task B1: implemented (commit dab1040, a7c26c9..dab1040), DONE_WITH_CONCERNS.
Task B1: review 1 — spec ✅, quality: 2 Important / 3 Minor, 0 Critical.
--------------------------------------------------------------------------------

One independent reviewer, most capable model, did not implement. It re-derived
every load-bearing claim against source rather than accepting the report:
RunHeartbeatStoppedError has exactly one throw (inside runExclusive) and one
instanceof (the new outer-catch branch); assertHeld never reads `stopped`;
isLeaseStopError unchanged and unexported; stop() unchanged; the new branch
precedes the isLeaseStopError branch; writeBoundaryArtifacts still sits after
the runExclusive call closes; guard `return { ok: false` = 8; the three test
doubles and INERT_LEASE_HEARTBEAT untouched; every single-run fence carries a
NONZERO named count.

BOTH IMPORTANTS WENT TO THE HUMAN — BUT ONLY AFTER THEIR PREMISES WERE
INDEPENDENTLY VERIFIED. This repo's own lesson from group A: a controller once
passed a reviewer's wording to the human uncalibrated and the wording had the
mechanism wrong. So a third agent re-ran both premises before the question was
asked. Verification report: task-B1-important-verification.md.

  I-1 PREMISE: TRUE, AND STRONGER THAN THE REVIEWER PUT IT.
  Injecting ONLY `|| error instanceof RunHeartbeatStoppedError` into
  isLeaseStopError, changing nothing else, leaves the whole suite GREEN
  (29 files / 487 tests, typecheck 0) — the dedicated branch precedes the
  predicate branch and returns, so the error never reaches the predicate.
  Therefore the PLAN'S OWN Step 7 mutation-2 criterion ("7b's (i) and (iii)
  must red") IS FALSE UNDER OPTION (a)'S ORDERING. Same defect class as group
  A's criterion B: a mutation criterion whose premise never holds.
  The verifier also answered the harder question: with the predicate NOT
  exported (hard constraint) and the branch order unchanged, the only shape
  that kills a pure predicate-widening requires assertHeld to throw this error
  — which hard constraint 2 explicitly forbids, and whose two outcomes are both
  outside RESUMABLE_STATUSES, i.e. it would pin the third door as expected
  behaviour. Measured both ways: unwidened -> blocked_waiting_human /
  "workspace unavailable"; widened -> cancelled / heartbeat_stopped.
  *** HUMAN RULING: this is a FALSE PREMISE IN THE PLAN, not an implementation
  defect. Errata in place on ### Task B1 (*Amended 2026-08-04*), gap recorded,
  NO code change, no test added, branch order and predicate untouched. ***
  THE GAP, NAMED SO IT CANNOT BE INHERITED AS CLOSED: hard constraint 1 has a
  failing assertion for its SUBCLASSING half only (7b's instanceof pair). Its
  PREDICATE-WIDENING half is guarded by a comment. A single edit widening the
  predicate is behaviourally inert TODAY and green; it detonates on any later
  edit that reorders the two branches, deletes the dedicated branch, or lets
  this error escape the INNER catch — which routes to persistTerminalState with
  "cancelled". GATE-B and group C inherit this, not a closed item.

  I-2 PREMISE: FALSE AS FRAMED. THE REVIEWER'S ANALOGY DOES NOT HOLD.
  The reviewer called the new branch's unconditional writeRunState asymmetric
  with its sibling and "isomorphic to debt 2". Verified against source: the
  sibling's guard is isTerminalRunStatus — it guards TERMINAL STATUS, not
  ownership (a lost lease is not in its condition), and in the genuinely
  comparable case the sibling writes MORE (persistTerminalState = an event plus
  a terminal writeRunState). The sibling is debt 2's body; the new branch never
  calls persistTerminalState, so this layer's debt-2 contact surface is ZERO,
  as the plan requires. Similarity of shape is not contact.
  REACHABILITY, STATED PLAINLY: NOT REACHABLE TODAY. `stopped` is set only by
  stop(), whose two production call sites (runLoop.ts:989, resumeLoop.ts:198)
  are both in a `finally` AFTER `await runLoopFromState(...)`, while
  runExclusive's only production call site is INSIDE runLoopFromState. No
  reachable path was found.
  THE HARM SURFACE IS REAL AND IS RECORDED RATHER THAN FIXED: writeRunState ->
  writeJsonFileAtomically is stringify -> temp -> rename with NO CAS, no
  read-modify-write and no owner/epoch precondition. If the resident `watch`
  shape ever makes this branch reachable, it overwrites a new owner's
  loop-state.json wholesale with a non-terminal state.
  *** HUMAN RULING: RECORD IT, DO NOT CHANGE THE CODE. *** The plan text is on
  that side — three separate places make this write unconditional and mandatory
  (it is the fourth round's own addition), and the plan already records "not
  reachable in L3 / this is defence in depth". An ownership guard would
  CONTRADICT the plan (its stated reason — return value must match disk or
  "isomorphic to §5.4" is false — holds just as well with the lease lost, and
  7b's expect(persisted).toEqual(finalState) would red). A terminal-status
  guard would not contradict the plan but would be dead code forever (both
  persistBoundaryAnalysis call sites are preceded by no terminal write).
  *** CARRY TO GATE-B AND TO L5: the no-CAS overwrite above. ***

Task B1: minor (deferred): M-2 — the new describe("lease") block lives in
  tests/controller/leaseHeartbeat.test.ts because the plan's Files list allows
  only two test files, while the sibling error-class assertions live in
  tests/ownership/lease.test.ts. Choosing the Files list over the test name was
  correct; the cost is that one error family's type assertions now sit in two
  files. Zero assertion impact. GATE-B may rule on relocation.
Task B1: minor (folded into fix round 1 by human ruling, NOT deferred): M-1 —
  no mutation existed for deleting the new branch's writeRunState; the reviewer
  reasoned it would red but did not measure it, and Step 10 names that very
  requirement as a review focus. Human: measure it.
Task B1: minor (folded into fix round 1): M-3 — report-file hygiene (two stray
  tool-marker lines at EOF; section 8 titled "Concerns" contains a non-concern).

ENVIRONMENT TRAP #5, FOUND BY THE IMPLEMENTER, CONFIRMED BY THE REVIEWER, NOT
YET IN THE HANDOFF: a fresh worktree has no node_modules of its own. Node
resolves upward so `npm test` runs, but tests/validation/evidence.test.ts
builds tsxBin from process.cwd(), so 9 `run-scenario CLI` cases fail with
spawn ENOENT — a shape that is NOT on the two-item allowed-flake list and
reads as a real regression. `npm ci` in the worktree fixes it with zero code
change. Whoever next rewrites docs/handoff/handoff.md must add this as the
FIFTH trap; the list there currently enumerates four.

Task B1: fix round 1/5 (3 addressed, 0 open — F-1 the writeRunState mutation now
  MEASURED not reasoned; F-2 the plan erratum for the false mutation-2 premise;
  F-3 report hygiene; commits dab1040..b427c8b).

  The fix commit b427c8b touches ONE file — the plan — 6 insertions, 0
  deletions, entirely inside ### Task B1. Zero production code, zero test code.
  F-1's evidence lives in the report, not the diff, because a mutation is
  injected and reverted.

  F-1 MEASURED RESULT: deleting the new branch's writeRunState reds 7b at
  `expect(persisted).toEqual(finalState)` — the assertion written for that write
  — and the whole delta is budgetSnapshot.timeRemainingMs, disk 19 vs returned
  0, because execute's applyPhaseUsage moved it in memory only. Three fences,
  named nonzero counts throughout (1 passed|53 skipped / 1 failed|53 skipped /
  1 passed|53 skipped). THE SCOPED RE-REVIEWER RE-RAN THIS MUTATION ITSELF
  rather than reading the fences, and reproduced all three states plus a clean
  tree — the kill is established by a second party.

  SCOPED RE-REVIEW VERDICT: all three ADDRESSED, no new breakage in the fix
  diff, no Critical, no Important.

  ONE RE-REVIEWER MINOR WAS CHECKED AND IS REFUTED — recorded rather than
  silently dropped, because the rule cuts both ways. The re-reviewer called the
  report's cited hunk header `@@ -1288,2 +1288,8 @@` "wrong/unsupported",
  having compared it against git's DEFAULT three-line context. Controller
  re-derived it at four context widths: `git --no-pager diff -U1 dab1040
  b427c8b -- <plan>` prints exactly `@@ -1288,2 +1288,8 @@`; -U0 prints
  `@@ -1288,0 +1289,6 @@`. The report's number re-derives; the finding assumed
  a context width the report never claimed. NOT a defect. The re-reviewer's
  underlying check — no bleed into neighbouring plan sections — was independently
  true and is what mattered.

Task B1: complete (commits a7c26c9..b427c8b, review clean after 1 fix round).
  Landed: RunHeartbeatStoppedError as a deliberate NON-subclass naming the
  predicate it protects; runExclusive refuses after stop, evaluated BEFORE fn is
  invoked (queued-continuation form, strictly stronger than refusing at call
  time); runLoopFromState's outer catch gained a branch ahead of the
  isLeaseStopError branch that appends heartbeat_stopped, writes run state, and
  returns a RESUMABLE state without persistTerminalState. isLeaseStopError,
  stop(), the test doubles and INERT_LEASE_HEARTBEAT are byte-unchanged.
  29 files / 487 tests exit 0 (+3 cases), typecheck 0, build 0, both allowed
  flakes absent, all three group-A guards still hold.

--------------------------------------------------------------------------------
Task B2: implemented (commit 6935578, b427c8b..6935578), DONE_WITH_CONCERNS.
Task B2: review 1 — spec ✅, quality APPROVED, 0 Critical, 0 Important, 4 Minor.
--------------------------------------------------------------------------------

No fix round: nothing entered the loop. One independent reviewer, most capable
model, did not implement. What it re-derived itself rather than reading:
  - the slot sits between the loop-top leaseLoss check and `const attempt =
    state.attemptsUsed + 1`; the attempt-internal checkpoint is NOT fitted;
  - `persistTerminalState(` count identical on b427c8b and 6935578 (16 in
    runLoop.ts + 1 in the integration test) — the plan's "new call sites must be
    zero" holds, counted, not asserted;
  - `git diff b427c8b..6935578 -- src/controller/leaseHeartbeat.ts` is EMPTY, so
    stop() is byte-unchanged; --name-only is exactly the four files the Files
    list names; src/registry/ untouched;
  - B1's outer-catch branch still precedes the isLeaseStopError branch, the
    predicate is unchanged/unexported, both onReconciliationWriteAbandoned
    forwards are in place — zero hunks in all of those regions;
  - the key was added to the two EXISTING options types and forwarded in
    resumeLoop; no third type, no positional collapse;
  - guard `return { ok: false` = 8;
  - 8b(i)'s within-TTL assertion is load-bearing because releaseOwnerLease nulls
    leaseAffirmedAt but PRESERVES lastAffirmedAt, so the assertion really does
    separate "released" from "aged out";
  - 8b(ii) is a genuine CAS mismatch: sameOwnerRecord is JSON.stringify
    equality, and the test rewrites only currentOwnerEpoch while preserving key
    order, so the mismatch can only come from the epoch. The weaker
    mock-releaseOwnerLease variant the plan calls insufficient was not used;
  - both mutations red for the PREDICTED mechanism, not merely red: mutation 1
    reds on planCalls receiving 1 (an attempt actually spent), mutation 2 on
    leaseAffirmedAt receiving the current timestamp. Named nonzero counts in
    every fence.

DEFERRED MINORS FROM B2 — GATE-B TRIAGE INPUT, DO NOT REDISCOVER:
Task B2: minor (deferred): M-1 *** THE MOST INTERESTING ONE. *** Test 8's
  "byte-identical" assertion does NOT catch the slot being moved ABOVE the
  loop-top `writeRunState`: on the first iteration initializeRunFiles has
  already written the same state, so the test stays green. Every stop test
  today fires on the FIRST iteration; none sets the signal after an attempt has
  run — and that is the real shape of an operator pressing Ctrl-C. The
  divergence it would miss is exactly the one B1's catch-branch comment names
  (applyPhaseUsage has moved state in memory only).
Task B2: minor (deferred): M-2 — 8b(ii) has no counterpart under the same
  wiring, so "the CAS loses BECAUSE of a supersede" is inferred, not pinned. If
  affirmOwnerLease ever stops returning the record it just wrote, the CAS would
  mismatch for a DIFFERENT reason and 8b(ii) would stay green with its named
  semantics silently gone.
Task B2: minor (deferred): M-3 — the stop check is ordered AFTER the leaseLoss
  check. The plan does not specify the order; the implementer chose it and said
  so. Reviewer's finding: no test distinguishes the two orders. Accepted as
  minimal-change (B2's effect on existing routing is zero), but when both
  signals are set the run still takes the lease-loss route and writes a terminal
  state to a possibly-transferred run — pre-existing behaviour B2 neither
  created nor widened. Reordering costs one line plus one test.
Task B2: minor (deferred): M-4 — this task's edit pushed resumeLoop.ts:136-137
  to 142-143, and three historical documents cite those line numbers
  (2026-07-27 owner-transfer-contention spec and plan). Verified stale by
  reading b427c8b's version. NOT fixed: those files are outside the Files list
  and this repo does not rewrite historical documents. For human ruling.

CONCERN 6 IS RECORDED BECAUSE IT IS THE GOOD KIND OF FAILURE: the implementer's
first draft report filled in a grep's three output lines FROM MEMORY, getting
line numbers and a keyword wrong; it caught itself, re-ran, corrected, and left
the self-report in place instead of quietly fixing it. The reviewer re-ran that
grep independently and the CURRENT values are byte-correct (fileStore.ts:1134
async function with no export / :1169 / :1184). The plan's premise that
updateOwnerRecordWithPrecondition cannot be mocked therefore stands.

Task B2: complete (commits b427c8b..6935578, review clean, 0 fix rounds).
  Landed: StopRequestSignal / createStopRequestSignal shaped after
  LeaseLossSignal; a stop_requested checkpoint at the loop top that appends the
  event and returns the current RESUMABLE state without spending an attempt and
  without persistTerminalState; the key on both existing options types with
  resumeLoop forwarding. 29 files / 490 tests exit 0 (+3 cases), typecheck 0,
  build 0.

NAMED CONFIRMATION FOR OPEN ITEM 4, MADE BY B2 ITSELF AND NOT INHERITED FROM
B1's: B2's new return path does NOT enter persistBoundaryAnalysis — the slot
returns (not continues) from the loop top, before `const attempt = …`, while
both persistBoundaryAnalysis call sites lie further in. The "preserving is
permitting" ruling does NOT reopen for B2 either. THIS COVERS B2 ONLY. Group
C must make its own, and its brief must still carry open item 4 verbatim.

================================================================================
*** GATE-B: PASSED (pending the human's merge instruction). 2026-08-04. ***
================================================================================

This entry is the gate's review verdict. Per plan §15 acceptance 7 criterion (1)
— which runs `git log --merges` and prints %s, i.e. enumerates MERGE commits and
reads SUBJECT lines only — the gate must be a real --no-ff merge whose SUBJECT
carries this verdict. Group A learned that the hard way; group B does not
relearn it. THE MERGE HAS NOT BEEN MADE: the human's standing instruction is
that merging happens only on an explicit instruction.

RANGE: a7c26c9..62cead9, four commits.
  dab1040  B1 implementation
  b427c8b  B1 fix round 1 (plan erratum + the fifth mutation, docs only)
  6935578  B2 implementation
  62cead9  GATE-B fix wave (one test assertion; production code untouched)

REVIEWERS. Two, dispatched in parallel with deliberately disjoint lanes, both on
the most capable model, NEITHER having worked on B1 or B2 (fresh agents;
independence is structural, not asserted).
  Lane 1 — production code, whole-branch design coherence, risk grading.
  Lane 2 — full rescan of every mutation and test-evidence artefact, plus triage
           of the deferred-minor list.
Both returned PASS WITH CONDITIONS, ZERO Critical, and NO item marked "must fix
before merge". The conditions are handover text for group C, not code.

WHAT LANE 1 ESTABLISHED AGAINST SOURCE (not read from reports):
  - Option (a) is fully implemented. isLeaseStopError is still two instanceof
    arms, still unexported, predicate and signature unchanged.
    RunHeartbeatStoppedError extends Error directly; the three lease errors share
    no base class; its comment names isLeaseStopError. Exactly one throw in the
    whole repo (leaseHeartbeat's refuseIfStopped) and one instanceof (the outer
    catch). assertHeld never reads `stopped` — the second half of hard constraint
    1 holds, so the blocked_waiting_human "third door" stays shut.
  - Debt-2 contact surface is zero, with a correction to B2's review: the outer
    catch's isLeaseStopError arm is one of FOUR same-shaped debt-2 bodies, not
    the only one. Contact is still zero — no persistTerminalState call site was
    added or changed. B1 added a SIBLING of debt 2 (an unguarded write), not
    contact with it.
  - Change surface confined: leaseHeartbeat.ts is +27/-4 in two hunks (import,
    and runExclusive plus the comment above it); stop() falls in no hunk;
    src/registry/ diff empty; INERT_LEASE_HEARTBEAT and all three test doubles
    untouched.
  - The two new paths compose: `while (true)` opens with writeRunState, so B2's
    returned state really is byte-identical to disk — INCLUDING the path where
    resumeLoop normalises `executing` to `planning` without a separate write,
    which lane 1 expected to falsify and did not.

WHAT LANE 2 ESTABLISHED BY RE-RUNNING (not by reading fences):
  SEVEN mutations across the branch (B1: 1, 1b, 2, 3, 5; B2: 1, 2) — the count
  was re-derived, not copied. 7/7 have all three steps, 7/7 show named NONZERO
  counts, 7/7 red on the claimed assertion, 7/7 red by the claimed MECHANISM.
  It re-ran two of them by hand (B1 mutation 2, B2 mutation 1) and reproduced
  both verbatim, then proved its own tree clean.
  ASSERTION STRENGTH, which is what this lane exists for:
    7b (i)   killable — two independent kills.
    7b (ii)  *** VACUOUS TODAY *** — the cleanupStatus backfill runs AFTER
             persistBoundaryAnalysis and the stub makes that throw, so no outer-
             catch mutation can reach it. It is documentation, not a guard. The
             report's "all four are killable" was WRONG and is now corrected in
             place.
    7b (iii) killable.
    7b (iv)  killable but never demonstrated — lane 2 measured it red.
    8 killable; 8b(i) killable; 8b(ii) shape correct (real CAS mismatch).

THE MOST VALUABLE FINDING OF THE WHOLE GATE, AND IT WAS A GUARD THAT COULD NOT
FAIL: 8b(ii)'s precondition `expect(affirmed.leaseAffirmedAt).not.toBeNull()`
PASSED ON `undefined` — when affirmNow has not run, JSON.stringify drops the key
entirely. So the assertion that called itself "without this, nothing below can
fail" was itself unable to fail, and the test ran on to red much later with a
misleading message. This is the exact defect class this repo keeps naming.

GATE-B FIX WAVE (62cead9) — one wave, one implementer, five findings, then ONE
scoped re-review, per the plan's GATE-B Step 2.
  F-3 the vacuous guard is now `toEqual(expect.any(String))`. PRODUCTION CODE
      UNTOUCHED (`git diff --stat 6935578..62cead9 -- src/` is empty).
  F-1 the "all four killable" claim corrected in place; (ii) named vacuous.
  F-2 7b (iv)'s kill measured and recorded, labelled a 2026-08-04 reconstruction
      rather than back-dated.
  F-4 "8b(i) is the only coverage of resumeLoop's forwarding" was REASONING;
      it is now a measured third mutation for B2.
  F-5 B1's revert proof for mutation 2 scanned for `MUTATION` while the marker
      was `EVIDENCE-ONLY` — the scan could not have hit it, so the test-side
      revert was never actually proven at the time. Corrected in place; the
      revert is established after the fact by lane 2's source read at 6935578.
  THE SCOPED RE-REVIEW re-derived F-3 BY HAND: with a key-deleting probe the new
  assertion reds on its own line (`expected undefined to deeply equal
  Any<String>`) while the OLD form passes vacuously and reds 22 lines later on
  an unrelated message. All five ADDRESSED, no new breakage, tree clean.

CONDITIONS ON THIS PASS — ALL ARE GROUP C's BRIEF, NONE BLOCK THE MERGE:
  1. REACHABILITY AND HARM ARE ONE WIRING, NOT TWO (lane 1, F-1). The recorded
     "writeRunState has no CAS" and "B1's branch is unreachable today" have been
     tracked as separate items. They are the same item: the single change that
     brings the branch to life — handing the heartbeat to a SIGINT handler or a
     resident watch, the same wiring that sets stopRequested — brings the
     unguarded overwrite to life in the same commit. REQUIREMENT: group C's
     wiring commit and the ownership-guard ruling must happen in ONE commit, not
     two. No test will red if they are split.
  2. NON-TERMINAL IS NOT THE SAME AS RESUMABLE (lane 1, F-2). evaluateResume-
     Eligibility's first four criteria require owner-transfer.json AND
     reconciliation-record.json with OWNER_LOST / matching epoch, while
     initializeRunFiles writes only loop-contract.json, loop-state.json and
     events.jsonl. So a BRAND-NEW run stopped at the loop top returns a
     non-terminal state that resumeLoop then REFUSES. 8b(i) is green because
     seedEligibleRun pre-seeds both files — it proves "a run that has ALREADY
     been taken over can be picked up again", which is a weaker claim than the
     one §5.4 leans on. Group C's sweep must not inherit the stronger reading.
  3. The predicate-widening half still has no test (human-ruled, plan erratum in
     place). Carry verbatim to group C AND to L5, with the trigger: ANYONE WHO
     REORDERS THE TWO OUTER-CATCH BRANCHES MUST RE-RUN THE WIDENING EXPERIMENT.
  4. The no-CAS write: carry to L5. Add the obligation lane 2 found MISSING from
     the list — if anyone introduces a stop() call site INSIDE the loop, the
     unreachability argument behind this ledger's B1 and B2 confirmations must be
     re-run, not inherited.
  5. appendEvent("heartbeat_stopped") and appendEvent("stop_requested") are also
     unguarded writes to a possibly-transferred run (lane 1, F-4). Append, not
     overwrite, so one notch less harmful — but they travel with condition 4 so
     L5 does not think there is only one site.

DEFERRED-MINOR TRIAGE (lane 2): B1 M-2 record only; B2 M-1 UPGRADED from record-
only to CARRY TO GROUP C (lane 2 measured it: test 8 stays green if the slot
moves above the loop-top writeRunState, because on the first iteration
initializeRunFiles already wrote the same state — and every stop test today
fires on the FIRST iteration, which is not the shape of a real Ctrl-C); B2 M-2
carry to group C merged with the 8b(ii) finding; B2 M-3 (stop/leaseLoss ordering
has zero coverage) carry to group C; B2 M-4 (three historical documents cite
resumeLoop.ts:136-137, now 142-143) record only — this repo does not rewrite
historical documents.

THE MOST FRAGILE PREMISE OF THIS WHOLE GATE, STATED BY LANE 1 AND ENDORSED HERE:
"`stopped` is false for the entire duration of runLoopFromState." The branch's
low-risk grading, the open-item-4 confirmations and the unreachability of the
no-CAS write ALL rest on it, and NOTHING TESTS IT — it holds only because both
stop() call sites happen to sit in a `finally`. Anyone who hands the heartbeat
outside the loop overturns all three at once, and the suite stays green.

FINAL VERIFICATION AT THE GATE, run by the controller, unfiltered,
ECC_GATEGUARD=off DISABLE_OMC=1, in the worktree at 62cead9:
  Test Files 29 passed (29) / Tests 490 passed (490), TEST_EXIT=0, Duration 16.52s
  TYPECHECK_EXIT=0; BUILD_EXIT=0
  Guard 1 `return { ok: false` = 8
  Guard 2 `currentOwnerEpoch + 1` single hit, src/ownership/ownerController.ts:166
  Guard 3 `git diff --name-only a7c26c9..62cead9 -- src/registry/` empty
  Guard 4 (this gate's own) `persistTerminalState(` in runLoop.ts = 16 at the
    branch base a7c26c9 AND 16 at 62cead9 — zero new terminal-state call sites
    across the whole branch, counted on both ends rather than asserted.
  Neither allowed flake appeared; no failure outside the list; no rerun.

VERDICT: GATE-B PASSES. Zero Critical across the whole branch. Both Importants
are handover conditions for group C, not defects in group B. Group C's hard
precondition (GATE-B complete) will be met the moment the human orders the merge.

--------------------------------------------------------------------------------
GATE-B MERGED. 2026-08-04. *** THE GATE IS bafa6a6. GROUP C's $B IS THIS HASH. ***
--------------------------------------------------------------------------------

The human ordered the artefacts landed first (467c6b3) and then the merge. Both
are done. The verdict above was written BEFORE the merge and said "pending the
human's merge instruction"; that clause is now discharged, and the entry is
otherwise unchanged rather than rewritten.

  467c6b3  docs(sdd): land group B's ledger entries, task reports and GATE-B
           evidence — six files via `git add -f`, following group A's shape
           (ledger and reports tracked; briefs and review packages not)
  bafa6a6  GATE-B PASSED: L3 debt 3 group B (B1-B2), two independent reviewers,
           0 Critical  <-- THE GATE, a real --no-ff merge, verdict in the SUBJECT

ACCEPTANCE 7's LOCATOR RE-RUN AFTER THE MERGE, not assumed:
`git log --merges --format='%h %cd %s' --date=iso --reverse` now lists fifteen
merges; the last is bafa6a6 with the verdict in its subject, and e5bf650 (GATE-A)
is the one before it. Both gates are visible to the criterion that enumerates
merges and reads subject lines only. The two group-A merges that explicitly
disclaim gate status still read as disclaimers, so $A4 and $B are unambiguous.

VERIFICATION AFTER THE MERGE, on main, run by the controller, unfiltered,
ECC_GATEGUARD=off DISABLE_OMC=1 — because the merged tree had never been run as
such (the gate verification ran on the branch tip 62cead9):
  Test Files 29 passed (29) / Tests 490 passed (490), TEST_EXIT=0, 17.97s
  TYPECHECK_EXIT=0; BUILD_EXIT=0
  Neither allowed flake appeared; no failure outside the list; no rerun.

STILL NOT DONE, EACH NEEDING ITS OWN HUMAN INSTRUCTION:
  1. NO PUSH. origin/main was a7c26c9 when group B opened; this session has never
     run `git push`. Whoever continues must check with
     `git ls-remote origin refs/heads/main` rather than trusting any prose —
     the remote has been advanced from outside this session three times already.
  2. The branch feat/l3-debt3-heartbeat-stop (62cead9) and the worktree
     .claude/worktrees/l3-debt3-heartbeat-stop are BOTH STILL PRESENT. Deleting
     them needs separate authorisation, and before deletion the untracked
     artefacts under the worktree must be enumerated and copied out — group A's
     clean-up round found 25 of them.
  3. Group C has NOT started. Its brief must carry, verbatim: GATE-A open item 4;
     the four GATE-B conditions above; and the obligation to make its OWN
     confirmation rather than inherit B1's or B2's.

--------------------------------------------------------------------------------
POST-GATE-B CLEAN-UP. 2026-08-04. Branch and worktree deleted, on human order.
--------------------------------------------------------------------------------

Discharges item 2 of the "STILL NOT DONE" list above. Item 1 (push) and item 3
(group C) are UNTOUCHED and still stand.

BEFORE DELETING, TWO CHECKS — the same two group A's clean-up round used:
  1. `git merge-base --is-ancestor feat/l3-debt3-heartbeat-stop main` EXIT 0, so
     the branch was fully contained in main and no commit could be lost.
  2. The worktree's untracked and ignored files were ENUMERATED first
     (`git -C <worktree> status --short --ignored=matching`), not assumed. Six
     entries: .ccmem/, .omc/, .superpowers/sdd/.gitignore, dist/, node_modules/,
     and ONE artefact that existed nowhere else — the B2 review package
     review-b427c8b..6935578.diff. Everything but that one is regenerable.
     The exception was copied out with `cp -n` into the main repo's workspace
     BEFORE the removal, and both copies measured 25402 bytes.
     (Group A's round found 25 such artefacts; this round found one, because
     every brief and report for group B was written straight into the MAIN
     repo's workspace. Only review-package's output followed the shell's cwd.)

DELETED: worktree .claude/worktrees/l3-debt3-heartbeat-stop (git worktree remove,
exit 0, no --force needed) and branch feat/l3-debt3-heartbeat-stop (git branch -d
— the SAFE form, which itself refuses an unmerged branch; it reported "was
62cead9").

AFTER: `git worktree list` shows the main repo alone; `git branch` shows main and
the unrelated backup/evidence-first-v1-… branch. `git log --oneline
a7c26c9..bafa6a6` still lists all six commits — the four of group B's work plus
the two docs commits — so nothing was orphaned by the deletion.

NOTE FOR WHOEVER OPENS GROUP C: the fifth environment trap recorded earlier in
this file (a fresh worktree has no node_modules of its own, and
tests/validation/evidence.test.ts builds tsxBin from process.cwd(), so 9
run-scenario CLI cases fail with spawn ENOENT — a shape NOT on the allowed-flake
list) applies to the next worktree too. Run `npm ci` inside it first. That
node_modules died with this worktree.

================================================================================
GROUP C OPENS. 2026-08-04. §6/§7/§8, the sweep trigger layer. C1-C4 + GATE-C.
================================================================================

Worktree .claude/worktrees/l3-group-c-sweep, branch feat/l3-group-c-sweep, based
explicitly on 2713c20 (git worktree add … HEAD, NOT EnterWorktree's default).
`npm ci` was run inside it immediately — pre-empting environment trap 5, which
group B discovered the hard way. Not pushed; local-only, per the human.

HARD PRECONDITION SATISFIED, RE-DERIVED RATHER THAN COPIED: $A4 = e5bf650,
$B = bafa6a6. Both were re-derived independently by the C1 implementer with
acceptance 7's own command and matched the controller's derivation. The two
group-A merges that disclaim gate status were confirmed to carry no verdict.

*** A PRE-FLIGHT CONFLICT SCAN WAS RUN BEFORE THE FIRST IMPLEMENTER WAS
DISPATCHED, AND IT PAID FOR ITSELF. *** Groups A and B each shipped a round of
rework because a plan criterion's premise turned out to be false MID-
implementation. This time the plan was scanned first: 7 conflicts needing a
ruling, 13 checked and cleared. Report: group-c-preflight-scan.md.

HUMAN RULINGS (4):
  1. GATE-A open item 5 (the dead twin shouldPreserveExistingSuccessfulRecon-
     ciliation) had been triaged "to group C" but NO task's Files list named
     fileStore.ts — it had no home. RULED: add it to C1's Files with a deletion
     step. Landed in 2b7d3b1.
  2. GATE-B condition 1 ("the wiring and the ownership-guard ruling must be ONE
     commit") has NO SUBJECT under C2's shape: registerStopHandlers takes only
     the signal, never the heartbeat, so both stop() calls stay in `finally` and
     B1's branch stays unreachable. RULED: C2 adds a step that RECORDS the
     still-unreachable finding (no code, no Files expansion); condition 1 defers
     to L5 with its trigger written down.
  3. C3's route table mandates printing "该 run 仍可续跑". GATE-B condition 2
     already established that non-terminal ≠ resumable, and the scan confirmed
     the sweep filter covers only criterion 1 of eight. RULED: errata in place —
     C3 asserts only what is known ("not terminated; the next sweep re-evaluates
     it"), original wording kept.
  4. TWO PLAN OBSERVATIONS HAVE ROTTED. (a) C3 says `cannot read run artifacts`
     was "measured 3 lines at plan time"; TODAY IT IS 22 — src/ is still 2 (so
     "the prefix is unique" survives) but 19 new lines live in group A's
     fileStore.test.ts crash matrix, so C3's mutation 1 would red a whole block
     of group A's matrix, and the plan's "those two sites must change together"
     misses a third. (b) C2 says three times "must return before the two `? 0 : 2`
     mappings", but loadAdapter sits EARLIER and UNCONDITIONALLY, so a placement
     that satisfies the plan's letter can construct the adapter before the banner
     prints — violating C1 and C3. RULED: errata in place for both, each landed
     by the task that owns the section (C2's by C2, C3's by C3).

CONTROLLER RULINGS (2), both under the Rule 7 lineage group A used three times
("a component and its coverage are one thing"):
  5. Open item 4 requires group C to make its OWN confirmation and forbids
     inheriting B1's or B2's — but no step in the whole of group C asks for it.
     Added to C1 as a named pre-code confirmation, and it will be a GATE-C review
     focus.
  6. C4's test 14b needs a contract/adapter fixture the named test file has never
     had, which collides with "Test only / copy the file's existing shapes".
     RULED: "Test only" is the hard constraint and is satisfied by building the
     fixture INSIDE that file; "copy the existing shapes" is a shape hint, not a
     limit. If it cannot be done without touching a second file, C4 stops and
     reports rather than expanding its own Files list.

--------------------------------------------------------------------------------
Task C1: implemented (commits 2713c20..2b7d3b1, two commits), DONE_WITH_CONCERNS.
Task C1: review 1 — spec ✅, quality APPROVED, 0 Critical, 0 Important, 3 Minor.
--------------------------------------------------------------------------------

One independent reviewer, most capable model, did not implement. Re-derived
itself: guard 1 = 8; guard 2 single hit; `git diff -- src/registry/` 0 lines;
`git diff -- src/controller/runLoop.ts` 0 LINES (so stop(), isLeaseStopError,
B1's branch and its ordering, B2's slot and both onReconciliationWriteAbandoned
forwards are structurally untouchable by this diff); the fileStore deletion is
exactly 12 lines and touches only the dead twin, with transferRepresentsPublished-
Winner and both its call sites byte-identical; the dead name has zero hits across
src/, tests/ and docs/; all three mutations red BY THE PREDICTED MECHANISM.

CONCERN 1 WAS THE ONE WORTH ESCALATING, AND THE REVIEWER CLOSED IT WITH NEW
EVIDENCE RATHER THAN AN OPINION. The implementer honestly reported that C1 does
not add a route to persistBoundaryAnalysis but DOES make one existing route be
travelled N times per process, and refused to decide whether open item 4's
"bound" covers arrival COUNT. The reviewer traced it: the failure mode is
transferRepresentsPublishedWinner's third conjunct comparing
currentProcessInstanceId, which resumeLoop overwrites on every successful resume.
Every such comparison in the repo is WITHIN one runDir; there is NO cross-run
comparison anywhere. buildProcessInstanceId is a process constant, so one sweep
writes the SAME id into N runs — but no predicate ever compares run A's id
against run B's record, and sweep is strictly sequential with heartbeat.stop() in
resumeLoop's finally. *** Per-run exposure is unchanged: one adoption = one
overwrite, byte-identical to running `ccloop resume` N times by hand. What sweep
changes is the RATE at which one human approval covers distinct runs. THE RULING
DOES NOT REOPEN. *** Recorded for GATE-C as "exposure ×N per invocation,
mechanism unchanged" — not as a trigger.

Task C1: minor (deferred): C1-M1 *** the one C3 must not inherit blindly. ***
  In sweepRuns' catch, `refused += 1` is not mutually exclusive with `adopted`,
  so a run that was adopted and then threw is counted BOTH as adopted and as not
  started ("1 adopted, 1 not started, of 3 eligible"). The FORMAT belongs to C3
  but the COUNTING SEMANTICS are set here. C3's brief must carry this.
Task C1: minor (deferred): C1-M2 — the banner-ordering test pins the banner's
  FULL literal text while the brief says the banner's format belongs to C3, and
  12b(a) in the same file uses toContain. A one-word change in C3 reds a test
  whose subject is ordering, not wording.
Task C1: minor (deferred): C1-M3 — the `rootFailure → stderr + return 1` path is
  this layer's ONLY non-zero exit and has NO test. The plan's four required tests
  do not ask for one, so this is not a violation; if a later edit turns it into
  `return 0`, §7's whole error contract fails silently and nothing reds.

TWO "CANNOT VERIFY FROM DIFF" ITEMS WERE RESOLVED BY THE CONTROLLER, AND ONE IS A
REAL GAP -> FIX ROUND 1: the report's first full-suite fence was ABRIDGED by the
implementer (self-declared: cli.test.ts debug blocks and slow-test lines dropped).
This repo's iron rule is that a verification run is never filtered — grep and
tail are equally guilty — and group A had a round formally cited for dropping a
60-line file list. The reviewer therefore could not verify that fence at all.
Fix round 1 requires an unabridged re-run, labelled as a 2026-08-04 re-run rather
than back-dated, with the abridged fence kept and annotated in place. The second
item (mutation fences 2 and 3 record output but not their `$` command lines — the
same family as GATE-A open item 6) travels with it, to be closed BEFORE this gate
rather than after it. NO .ts FILE MAY BE TOUCHED IN THAT ROUND.

Task C1: fix round 1/5 (2 addressed, 0 open — F-1 the abridged full-suite fence,
  F-2 five fences missing their command lines; NO COMMIT, report file only, no
  .ts file touched).

  *** ENVIRONMENT TRAP 6, FOUND IN THIS ROUND AND WORTH MORE THAN THE ROUND ***
  A SUBAGENT'S BASH CWD IS RESET BETWEEN CALLS. The implementer's first re-run of
  the full suite silently executed IN THE MAIN REPO, not the worktree: `RUN v2.1.9
  /Users/biran/code/skills/loop/ccloop`, 29 files / 490 tests — green, plausible,
  and WITHOUT ANY OF THIS TASK'S TESTS. The cross-check that catches it is the
  arithmetic: main is 29/490, this branch is 30/497, and the difference is exactly
  this task's 1 file / 7 cases. THE ACCEPTANCE CRITERION FOR ANY VERIFICATION RUN
  IS NOW THE `RUN` PATH ON VITEST'S FIRST LINE. Pin the directory inside the
  command itself (`rtk proxy "bash -c 'cd <worktree> && …'"`). C2/C3/C4 briefs
  must carry this as trap 6; the scoped re-reviewer was warned and used the pinned
  form, and its own re-run printed the worktree path.

  THE IMPLEMENTER DISCLOSED THREE THINGS ITSELF, INCLUDING REPEATING THE VERY
  DEFECT THE ROUND EXISTED TO FIX: while adding the missing fences it omitted two
  lines from one of them, caught it, completed it, and wrote it into its own
  concerns. That is the behaviour this process is trying to produce.

  SCOPED RE-REVIEW: both ADDRESSED. It re-ran the full suite itself with a pinned
  cwd (RUN path = the worktree, 30 files / 497 tests, EXIT=0) and re-ran the one
  fence it trusted least, byte-identical including marker_grep_exit=1 and the
  shasum. *** IT WAS ASKED EXPLICITLY WHETHER ANY EVIDENCE WAS FABRICATED OR
  BACK-DATED AND ANSWERED: NONE. *** All 2026-08-04 re-runs carry new timestamps,
  pinned cwd and a self-證 RUN path.

Task C1: minor (deferred): C1-M4 — the report says the wrong-repo run was
  "disclosed in full"; it is a PARAPHRASE, not a pasted terminal block. Not
  fabrication (it never poses as real output) but the wording overstates it. Same
  family as group A's false sentence about `git rev-parse --short`.
Task C1: minor (deferred): C1-M5 — §5's three PRE-implementation red fences were
  abridged (source-context frames and the [1/1] separator are missing) and CANNOT
  be re-run: the intermediate state they pinned no longer exists now that quota
  and the stop check are implemented. The implementer did NOT fabricate a
  replacement, and the judging information (× line, `1 failed | N skipped`, the
  AssertionError's expected/actual) is verbatim intact. FOR GATE-C's EVIDENCE LANE
  TO TRIAGE: is that sufficient, or must the intermediate state be reconstructed
  and re-run? The controller does not rule it either way — the three mutation
  experiments cover neighbouring ground with complete fences, but whether they
  cover the SAME assertions is exactly what the gate should check rather than
  assume.

Task C1: complete (commits 2713c20..2b7d3b1, review clean after 1 fix round).
  Landed: src/sweep/sweepRuns.ts (scan → root-failure → filter → lexicographic
  sort → quota truncation → sequential resume, quota counted at onAdopted, exit
  code as the return value); onAdopted?: () => void added to the EXISTING
  ResumeLoopOptions; the dead twin shouldPreserveExistingSuccessfulReconciliation
  deleted (12 lines, nothing else in fileStore.ts touched). 30 files / 497 tests
  exit 0, typecheck 0, build 0, src/registry/ and src/controller/runLoop.ts both
  zero-diff.

--------------------------------------------------------------------------------
Task C2: implemented (commits 2b7d3b1..c14f792, two commits), DONE_WITH_CONCERNS.
Task C2: review 1 — spec ✅, quality APPROVED, 0 Critical, 0 Important, 3 Minor.
--------------------------------------------------------------------------------

No fix round: nothing entered the loop. One independent reviewer, most capable
model, which did its verification with a PINNED cwd and validated every run by
vitest's RUN path — trap 6 was carried into the dispatch and it held.

WHAT THE REVIEWER CONSTRUCTED RATHER THAN READ (the two load-bearing concerns):
  - THE SPLIT OF loadAdapter IS LOad-BEARING, NOT DECORATION. The implementer
    extracted a zero-I/O buildAdapter and NARROWED the parameter type from
    Exclude<…,{command:"ls"}> to Extract<…,{command:"run"|"resume"}>, so that
    moving the sweep branch below loadAdapter becomes a COMPILE ERROR. The
    reviewer built that counterfactual in a scratchpad copy: with the narrowed
    signature tsc fails TS2345 (EXIT 2); with only the signature reverted and the
    move kept, EXIT 0. So the human-ruled boundary is now enforced by the type
    checker rather than by a comment. Zero side effects: loadAdapter is unexported
    with one call site; buildAdapter has two.
  - THE TEST THE IMPLEMENTER FLAGGED AS UNMUTATED CAN FAIL. `parses --root …` was
    added outside the plan's list and never had its own kill. The reviewer mutated
    `maxRuns: Number(maxRunsRaw)` into a cast: 1 passed → 1 failed, red on
    `- "maxRuns": 3 / + "maxRuns": "3"`, the predicted mechanism.
  - The listener-leak assertion can also fail (emptying the unregister function
    reds it on listenerCount 1 vs 0), and two preconditions block the "nothing was
    ever registered" fake green.

B1's BRANCH IS STILL UNREACHABLE — CONFIRMED BY C2 ITSELF AND RE-DERIVED BY THE
REVIEWER, not inherited: `.stop()` has three hits in src/, one of them a comment,
so the two production call sites are unchanged and both sit in the `finally`
after runLoopFromState; `stopped = true` appears only inside stop();
registerStopHandlers receives the slot and an injected exit, and its closure
cannot reach a heartbeat. GATE-B condition 1 is NOT triggered; it stays deferred
to L5 with its trigger recorded.

THE PLAN ERRATUM C2 OWED (human ruling 4b) LANDED: 12 insertions, 0 deletions,
inside ### Task C2 only, same marker shape as the nine existing errata, no
future-fix advice. The reviewer counted the four places the wrong boundary was
repeated and confirmed the erratum names them all.

Task C2: minor (deferred): C2-M1 — the report claims coverage of "--max-runs as
  the last token with no value" but only the fully-absent case is tested. A benign
  refactor of the pairing loop (`?? "1"`) would silently start a sweep with
  maxRuns=1 and all eight new tests stay green.
Task C2: minor (deferred): C2-M2 — C2 only JSON.parses the adapter config without
  validating its shape, and createAdapter() is invoked after the banner and
  outside the per-run try. `--adapter-config` pointing at `{}` prints the banner,
  then throws a TypeError out of the scripted adapter → exit 1, a square the exit
  table's wording does not cover. Same shape as the pre-existing run/resume paths.
Task C2: minor (deferred): C2-M3 — the exit table's "bad argument" square has no
  `it` under `main sweep` (e.g. `--adapter bogus` → exit 1 is untested).
Task C2: minor (deferred, FOR THE GATE TO RULE): C2-M4 — this change invalidates
  three line-number citations in docs/superpowers/specs/2026-08-01-…-design.md
  (:131/:135/:130 are now 244/248/241). The implementer did NOT touch them: they
  are outside the Files list and this repo's stance is not to rewrite historical
  documents. But unlike B2-M4's 2026-07-27 documents, this is the CURRENT L3
  spec, so the precedent is not obviously the same. GATE-C should rule.

--------------------------------------------------------------------------------
Task C3: implemented (commit 96f5c09, c14f792..96f5c09), DONE_WITH_CONCERNS.
Task C3: review 1 — spec ✅, quality APPROVED WITH IMPORTANT (1 Important,
         3 Minor, 0 Critical). -> fix round 1.
--------------------------------------------------------------------------------

*** THE FIFTH FALSE PREMISE IN THE PLAN, AND THE FIRST ONE THE IMPLEMENTER
CAUGHT BEFORE THE REVIEWER DID. *** C3's Step 7 mutation 1 (change the
`cannot read run artifacts` prefix in resumeLoop.ts) CANNOT kill test 12c. The
implementer measured the survival, refused to swap in a mutation of its own
choosing, and escalated — exactly the behaviour the previous four cases were
supposed to teach.

  VERIFIED INDEPENDENTLY BY THE REVIEWER, who was given the mutation-injection
  exemption for this purpose: pre-injection 12c `1 passed | 11 skipped`;
  post-injection STILL `1 passed | 11 skipped` (survives); the collateral kills
  are exactly `cli.test.ts` 1 case and group A's `fileStore.test.ts` 1 case.
  The structural reason holds up: 12c injects a STUB `resume` and its message is
  a literal in the test file, so production resumeLoop is never entered — there
  is NO DATA PATH from the mutated literal to 12c's judgement.

  THE REVIEWER THEN ANSWERED THE HARDER QUESTION THE DISPATCH ASKED, AND FOUND
  WHAT THE IMPLEMENTER HAD NOT: a legal alternative EXISTS for the layer that
  matters. Mutating the literal in sweepRuns.ts's own classifyThrow reds 12c
  (`1 failed | 11 skipped`) on `stderrLines.slice(1)`, because run-1 falls back
  from stderr/`error` to stdout/`refused` — the predicted mechanism, inside C3's
  own Files list, naming 12c. It also established what NO mutation can pin
  today: the CROSS-MODULE equality of the two literals, since resumeLoop.ts's
  literal is outside 12c's reachable data flow. That equality is in fact carried
  by cli.test.ts and fileStore.test.ts — the reviewer's injection reddening both
  IS the evidence.

  *** HUMAN RULING: replace Step 7's mutation 1 with the reviewer's alternative,
  and errata the plan in place explaining why the original cannot kill 12c,
  which two cases it actually kills, and which LAYER the replacement pins. ***
  Dispatched as fix round 1. The implementer must re-run all three steps itself
  rather than copy the reviewer's numbers.

THE IMPORTANT, WHICH NO TEST COULD HAVE CAUGHT: C3 buffered the `note` lines
into an array and flushed them after the sweep loop, where C1 had written them
to stderr as they occurred. Failure scenario: a multi-hour `--max-runs 50` sweep
whose 3rd run abandons a reconciliation write and whose process is SIGKILLed at
run 40 — the buffer dies with the process and STDERR IS EMPTY, so a cron rule of
"alert if stderr is non-empty" never fires, while C1's immediate write had
already alerted. The plan only requires that notes keep their traversal order,
which sequential immediate printing satisfies, SO THE BUFFERING BOUGHT NOTHING.
All four existing tests are blind to the difference (12d(i) asserts the final
array, 12d(ii) uses toContain). In the fix round the implementer must also state
plainly whether ANY existing assertion can now distinguish immediate from
buffered — and if not, say so rather than claim the gap is closed.

WHAT THE IMPLEMENTER CAUGHT IN ITSELF, RECORDED BECAUSE THIS IS THE BEHAVIOUR
THE PROCESS EXISTS TO PRODUCE: (a) it added `|| error instanceof
RunLeaseHeldError` and then noticed the conjunct carried NO assertion — deleting
it would SURVIVE — so it re-pointed an existing test's run-7 at that error and
measured the kill (the reviewer re-ran it: `1 failed | 11 skipped`, run-7 falls
from stdout/`refused` to stderr/`errored`); (b) it ran the suite once through
`| tail -60`, declared that run void, and re-ran unfiltered.

C1-M1 WAS SOLVED, NOT INHERITED: every summary cell is now derived from the
report lines' `outcome`, and `tally[report.outcome] += 1` executes exactly once
per attempted run on both the try and catch paths, so double counting is
structurally impossible. C1's quota semantics (adopted/onAdopted/break) are
byte-unchanged; only C1's report-only `refused` counter was replaced. The old
contradictory line was reproduced verbatim in a red run first:
`sweep: 7 adopted, 2 not started, of 8 eligible` (7+2=9>8).

Task C3: minor (deferred): C3-M1 — the summary line's `attempted` and its three
  outcome cells are not addable: failed/exhausted/blocked_waiting_human/
  cancelled/interrupted fall into no cell at all. This is the plan's own mandated
  format, not a task defect, but it is quieter than the C1 line it replaced.
Task C3: minor (deferred): C3-M2 — `tally` carries five write-only cells (Rule 2
  would call them surplus). The reviewer judged them acceptable: the
  Record<Outcome, number> shape is what makes "exactly one cell per attempted
  run" a TYPE-LEVEL property, and collapsing to three variables would lose the
  exhaustiveness check over the Outcome domain. Recorded, not to be "cleaned up".
Task C3: minor (folded into fix round 1): C3-M3 — report §3.3's arithmetic
  contradicts §3.2 and the measurement (17+4=21 vs 13+4=17). The plan erratum's
  19/17/2 split is correct; only the report prose is wrong.

Task C3: fix round 1/5 (3 addressed — the human-ruled mutation swap, the note
  immediacy Important, the report's arithmetic; commit 96f5c09..cad6236).
  The replacement mutation was re-run BY THE IMPLEMENTER rather than copied:
  12c goes 1 passed -> 1 failed | 11 skipped, red at sweepRuns.test.ts's
  `expect(h.stderrLines.slice(1)).toEqual([...])` because run-1 falls back from
  stderr/error to stdout/refused. Revert proven with the injected string itself,
  not a generic marker.

  *** A CONTROLLER ERROR, RECORDED BECAUSE IT IS EXACTLY WHAT THE PROCESS
  FORBIDS. *** The plan's own text fixes the callback's implementation as "a
  single array push, no I/O, no formatting". The note-immediacy fix contradicts
  that, and the rule is that a fix contradicting plan text goes to the human
  BEFORE it is dispatched. The controller dispatched it without noticing. The
  implementer implemented the ruling but did NOT quietly errata the two
  sentences — its erratum authorisation covered only Step 7 — and reported the
  inconsistency instead. That is the correct behaviour on its side; the process
  failure was upstream.

  HUMAN RULINGS ON THE TWO ITEMS THE ROUND SURFACED:
    (a) KEEP the immediate write and errata those two sentences in place. The
        buffering bought none of the properties the plan asks for and introduced
        an invisible alert loss.
    (b) CLOSE THE COVERAGE GAP. The implementer established, by checking each
        assertion, that NOTHING today distinguishes immediate from buffered —
        reverting to buffering leaves the whole suite green, so the Important's
        own fix was unguarded. Ruled: change 12d(ii)'s two toContain into one
        toEqual([banner, note, errorLine]) — order WITHIN one stderr stream, not
        the withdrawn cross-stream promise — and prove it can red with a mutation
        that restores buffering.
  Dispatched as fix round 2.

  DISCLOSED BY THE IMPLEMENTER, AND KEPT IN THE REPORT ON PURPOSE: its first
  draft of the round's section carried a FABRICATED commit hash (3a72e0d),
  written before the commit existed and corrected from `git log` immediately
  after committing. Same family as the earlier fabricated grep output. The
  self-report stays in the artefact.

Task C3: fix round 2/5 (2 addressed, 0 open — the plan erratum for the callback
  shape, and the coverage gap; commit cad6236..1564cba, tests + plan only, ZERO
  production code).
Task C3: complete (commits c14f792..1564cba, review clean after 2 fix rounds).

  THE SCOPED RE-REVIEW RE-RAN BOTH LOAD-BEARING MUTATIONS ITSELF rather than
  reading the fences. The replacement mutation: 12c 1 passed -> 1 failed, red at
  `stderrLines.slice(1)` with `expected [] to deeply equal [ Array(1) ]`, i.e.
  run-1's line leaves stderr entirely — and it re-derived WHY (readFailure stays
  a ResumeNotEligibleError, so it takes the second arm to refused/stdout). The
  buffering mutation: 12d(ii) red at the new toEqual with three elements on both
  sides and the diff a PURE TRANSPOSITION of the note and error lines, so the
  assertion really does fail for ORDER and not for content — and 12d(i) survives
  the same injection, as the implementer said.
  It also verified the honest self-report: under the buffering injection exactly
  ONE assertion in the whole file reds. Every other 12d assertion is blind to the
  difference. The implementer said so plainly and did not claim to have closed
  it; the re-reviewer confirmed nothing was missed.
  Plan errata: three insertions inside ### Task C3, ZERO deletions, same marker
  shape as the ten existing errata, no future-fix advice, and the re-reviewer
  re-derived the mechanism by injecting the OLD mutation itself (12c survives;
  cli.test.ts and fileStore.test.ts each red) rather than trusting the wording.

Task C3: minor (deferred): C3-M4 — §3.1's prediction table still carries the
  "17 + 4" arithmetic that §3.3 corrected to 13 + 4 = 17. Same typo family, one
  place further up, documentation only.
Task C3: minor (deferred): C3-M5 — the immediate-vs-buffered distinction hangs
  on ONE assertion, and that assertion only works while 12d(ii)'s stub still
  throws after the note (two stderr lines are needed before order means
  anything). Remove that throw later and the distinction vanishes silently with
  the suite still green.

--------------------------------------------------------------------------------
Task C4: implemented (commit 4a24a94, 1564cba..4a24a94), DONE_WITH_CONCERNS.
Task C4: review 1 — spec ✅, quality APPROVED, 0 Critical, 0 Important, 2 Minor.
Task C4: complete (commits 1564cba..4a24a94, review clean, 0 fix rounds).
--------------------------------------------------------------------------------

Test-only, +519/-1 in tests/registry/zeroWrite.test.ts, `git diff --name-only
-- src/` EMPTY. Guards re-counted by the reviewer: 8 / single hit / src/registry
untouched.

*** C4's TESTS FOUND A PRODUCTION PROPERTY NOBODY HAD RECORDED. *** resumeLoop
reads five artifacts CONCURRENTLY in one Promise.all, and only readOwnerRecord
runs recoverInterruptedOwnerTransfer first; readOwnerTransferRecord,
readReconciliationRecord and readRunState are bare reads racing finalize's
rename. The implementer hit it while writing 14b, restructured the test to avoid
the nondeterminism, DID NOT TOUCH PRODUCTION CODE, and escalated.

  THE REVIEWER CONSTRUCTED IT RATHER THAN REASONED ABOUT IT, and corrected the
  implementer's wording in the process:
    - Real: with a marker plus three pendings staged and reconciliation-record
      .json never published, a real sweep produces `cannot read run artifacts:
      … ENOENT`.
    - CORRECTION: sweep classifies it as `error`, NOT `refused` — classifyThrow's
      prefix arm wins — so the line goes to stderr while the exit code stays 0.
    - *** IT IS A RETRYABLE REFUSAL, NOT A LOST RUN, AND THIS WAS MEASURED. ***
      Promise.all's rejection does not cancel the readOwnerRecord chain: 300ms
      after sweep #1 returned, the marker was gone, epoch had rotated to 2 and the
      reconciliation record was published; sweep #2 then reached `succeeded`.
      cli.ts only calls process.exit on a DOUBLE SIGINT, so the pending fs work
      drains normally. Cost = one wasted sweep slot plus a misleading `error`
      line that reports a healthy run as a failure. NOT data loss.
    - It does NOT conflict with group A's transaction invariants: recovery still
      goes marker-first through finalizePendingOwnerTransfer with
      isValidFinalizeOrder validating the full permutation before any read, write
      or unlink. This is resumeLoop's READ-SIDE ordering, a sibling of L2 §7.1's
      registry-side protection which resume never got.
  CARRIED TO GATE-C AS AN INDEPENDENT DEFECT ITEM FOR HUMAN RULING. It did not
  block C4, which is Test-only and correctly refused to fix it.

THE REVIEWER CLOSED THE IMPLEMENTER'S OWN WORRY ABOUT THE 7 UNVERIFIED TEMP PATH
LITERALS: it compared all 11 against fileStore.ts's constants and
getOwnerTransferPaths field by field — byte-identical, and items 2-11 are exactly
the ten fields cleanupOwnerTransferStagingWithoutMarker destructures and unlinks.
It also hit each of the three preconditions with its own probe: all four reds
landed on the predicted assertion by the predicted mechanism, including the
expired-lease one reddening inside checkRunLease with `expected 'expired' to be
'no_lease'`. The negative assertion's vacuous-pass risk is genuinely blocked by
a positive control.

Task C4: minor (deferred): C4-M1 — 14b asserts the marker and three pendings are
  reclaimed but not that finalize's own six temp paths leave no residue; a
  success path that forgot to unlink .owner-record.publish.tmp keeps 14b green.
  The plan's clause (ii) only asked for the marker and the pendings.
Task C4: minor (deferred): C4-M2 — four historical SDD documents cite
  zeroWrite.test.ts:92 and :187, now shifted by the added imports. Same family as
  B2-M4 and C2-M4; GATE-C should rule on all of them together rather than
  one at a time.

================================================================================
GATE-C REVIEW. 2026-08-05. Two independent reviewers, disjoint lanes.
================================================================================

Range 2713c20..4a24a94 at review time, eight commits (C1 x2, C2 x2, C3 x3, C4 x1).
Both reviewers fresh, most capable model, NEITHER having worked on C1-C4.
  Lane 1 — production code, whole-branch coherence, risk grading: PASS WITH
           CONDITIONS, 0 Critical, 2 Important, 3 Minor.
  Lane 2 — full mutation/evidence rescan and deferred-minor triage: PASS WITH
           CONDITIONS, 0 Critical, 1 Important.

WHAT LANE 1 ESTABLISHED AGAINST SOURCE (not from reports):
  - Acceptance 7 criterion (3): `git log --diff-filter=A -- src/sweep/sweepRuns.ts`
    is exactly one line, 525cdcc, dated AFTER both $A4 and $B. Order respected.
  - ZERO WRITE SURFACE, proven by structure rather than comment: sweepRuns.ts
    imports no fs module at all — no node:fs, writeFile, appendFile, mkdir,
    rename or unlink. Its only path to disk is resumeLoop.
  - Pipeline order is source order; truncation is a `break` ON THE SORTED ARRAY,
    so it cannot precede the sort; onAdopted fires after resume_adopted and
    before the heartbeat starts, with all four refusal paths throwing earlier.
  - Guards counted: 8 / single hit / src/registry zero / src/controller/runLoop.ts
    ZERO LINES across the whole branch — so B1's branch and its ordering, B2's
    slot and both onReconciliationWriteAbandoned forwards were structurally
    untouchable by group C.
  - C2's type narrowing re-verified by BUILDING BOTH COUNTERFACTUALS: moving the
    sweep branch below loadAdapter fails TS2345 (exit 2); reverting only the
    signature and keeping the move compiles (exit 0).

WHAT LANE 2 ESTABLISHED BY RE-RUNNING: 16 injections across 14 mutation designs;
14 kills with all three steps, named nonzero counts, red on the claimed assertion
BY THE CLAIMED MECHANISM; the other 2 are deliberate, honestly-recorded
SURVIVALS (C2's first attempt at mutation 3, C3's original mutation 1). It re-ran
three by hand including both of C3's fix-round mutations, and reproduced the
buffering kill as a PURE TRANSPOSITION — three identical strings on both sides,
only note and error swapped, so the assertion really does fail for ORDER.
It also re-derived that group B's two carried debts remain unreachable after
group C lands (.stop() still exactly two production call sites, both in a
finally; runLoop.ts zero-diff).

*** LANE 2's IMPORTANT WAS THE CONTROLLER'S OWN FAILURE, AND IT IS RECORDED AS
SUCH. *** C2's implementer explicitly asked for a ruling (the `--max-runs`
illegal values are enumerated in ONE `it` while the plan says one `it` per
square, no synthesis). The task reviewer expressed a view in its reply, but THE
CONTROLLER NEITHER RECORDED IT IN THIS LEDGER NOR PUT IT TO THE HUMAN — so a
question that was properly escalated went unanswered across the whole branch.
Lane 2 named this "a false close occurring on SPEC COMPLIANCE". Human ruling:
COMPLIANT — "not a positive integer" is ONE square of the exit-code table, the
six values are an enumeration within it, and each iteration clears the spy and
asserts the specific message. Recorded here, which is the half that was missing.
Lane 2 also found five more escalated-but-unrecorded concerns; they are logged
below as C2-M5, C2-M6, C3-M6 and two doc items.

HUMAN RULINGS AT THE GATE (4):
  1. I-1: FOLD the report line's detail to one line AND correct the false
     rationale in the comment. The unfolded detail let an 11-line ZodError from
     loadContract turn one run into ten ownerless cron records, breaking §8's
     "one line per attempted run" — the contract the plan calls total — while the
     note line five lines above had folded all along. The comment claimed the
     flaw "predates this wave"; the three-column line IS this wave's own output.
  2. I-2: give the banner an OBSERVED-ONLY qualifier. The filter covers only
     criterion 1 of evaluateResumeEligibility's eight, and `ccloop ls` already
     disclaims exactly this field, so a bare "17 eligible run(s)" would hollow
     out the informed half of §12's informed approval. Plan errata + test sync.
  3. C2's six-values-in-one-`it`: COMPLIANT, and recorded (see above).
  4. THE MOST FRAGILE PREMISE GETS A GATE INSTEAD OF A RULE. Lane 1 found that
     `cannot read run artifacts:` is a CROSS-MODULE contract carrying all of
     §4.4's "fail loudly", yet nothing pinned the two literals' equality — and
     worse, both indirect guards use startsWith WITHOUT the colon, so changing
     anything after the colon breaks sweep's routing while both guards SURVIVE.
     Ruled: add an end-to-end case that does not stub resume, with a new test
     name authorised.

GATE-C FIX WAVE (c3bd049 + 5a7f5c7), one implementer, six items, then ONE scoped
re-review. The re-review reproduced both load-bearing kills on its own
injections: the fold mutation reds the new test at sweepRuns.test.ts:522; the
colon-only mutation reds the new end-to-end case at zeroWrite.test.ts:640 —
*** AND BOTH INDIRECT GUARDS SURVIVE THAT SAME INJECTION (cli.test.ts 1 passed,
fileStore.test.ts 1 passed), which is precisely why the new case was needed. ***
It also verified the banner literal was pinned in FIVE places, not one, and that
all five were synced.

*** THE FIX WAVE CARRIED ITS OWN DEFECT. THAT IS FIFTEEN WAVES IN A ROW, AND
AGAIN NOT FOUND BY WHOEVER WROTE IT. *** Removing "eligible run(s)" from the
banner made three `not.toContain("eligible run(s)")` assertions in cli.test.ts
STRUCTURALLY UNFAILABLE — they were live guards proving no banner is printed on
the three refusal paths, and a regression that printed one would now sail
through. Human ruled: FIX BEFORE MERGE, with one more scoped re-review. The same
round syncs the current L3 design spec, which still pins the old banner literal.

RESIDUAL ROUND (2a3cf64) AND THE FINAL SPEC SYNC (b9afbf3), each followed by its
own scoped re-review, both ADDRESSED.
  The three emptied guards are demonstrably failable again. The implementer ran
  TWO injections rather than one, and the second is what proves the point: with
  the banner moved to the top of parseArgs's sweep branch, ALL THREE red, each
  carrying its own refusal message in `received` — so they are red for the guard's
  own reason, not because the refusal stopped happening. Under the realistic
  regression shape only the third reds, and the reason was verified along the
  code rather than accepted: parseArgs throws at :84 and :96 inside its own sweep
  branch, while main only reaches its sweep branch at :218, so the other two
  unwind before the injection point exists. The re-reviewer reproduced both.
  The new needle `observed eligibleForContinuation=true` was checked to occur
  EXACTLY ONCE in src/ and to be immune to collision with `ccloop ls`'s notice.
  The spec sync's annotation survived being checked against the live callback:
  one stderr call per invocation, no dedup, no aggregation, cannot throw,
  deliberately un-try/caught — only the sink changed. Its anchor was resolved
  BLIND by the re-reviewer following the annotation's own description, landing on
  the single occurrence of that table row in the whole document.

*** TWO STANDING RULES THIS GROUP ADDS, BOTH PAID FOR IN DEFECTS ***
  1. WHEN YOU CHANGE AN OUTPUT LITERAL, THE POSITIVE ASSERTIONS RED BY THEMSELVES
     BUT EVERY `not.toContain` / `not.toEqual` SITE SILENTLY GOES VACUOUS. Re-scan
     the negative family in the same commit. This is the exact root cause of the
     fifteenth self-defecting fix wave, and it was the implementer who named it.
  2. A VERIFICATION RUN IS ONLY VALID IF VITEST'S FIRST LINE SHOWS THE EXPECTED
     `RUN` PATH. A subagent's bash cwd resets between calls; a full suite silently
     executed in the MAIN REPO looks entirely normal (29 files/490 tests, all
     green) while running none of the branch's own tests. The arithmetic
     cross-check (branch total minus main total = this task's cases) is what
     caught it.

STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED:
  - The `resumeLoop` concurrent bare reads (C4's discovery): five artifacts read
    in one Promise.all with only readOwnerRecord preceded by recovery. Measured
    consequence: ONE retryable refusal plus a healthy run reported as `error` on
    stderr — a false alarm, i.e. an operability defect, not data loss. CARRIED TO
    L5 with the grading evidence attached.
  - The same-family spec sentences at spec:692 and spec:751 (and their copy at
    plan:1004) still cite "a single array push" as a PREMISE. Their CONCLUSIONS
    still hold — spec:751's argument survives an injected stderr sink — so only
    the supporting wording is stale. Named for L5; the controller did not widen
    the round to take them.
  - Group B's two carried debts (the predicate-widening half has no test; B1's
    branch writeRunState has no CAS) were re-derived as STILL UNREACHABLE after
    group C lands, and travel to L5 unchanged.

FINAL VERIFICATION AT THE GATE, run by the controller, unfiltered, pinned cwd,
ECC_GATEGUARD=off DISABLE_OMC=1, at b9afbf3:
  RUN path = the worktree (verified on vitest's first line, per standing rule 2)
  Test Files 30 passed (30) / Tests 514 passed (514), TEST_EXIT=0, 18.35s
  TYPECHECK_EXIT=0; BUILD_EXIT=0
  Guard 1 `return { ok: false` = 8
  Guard 2 `currentOwnerEpoch + 1` single hit, src/ownership/ownerController.ts:166
  Guard 3 `git diff --name-only 2713c20..b9afbf3 -- src/registry/` EMPTY
  Guard 4 `… -- src/controller/runLoop.ts` EMPTY across the whole branch — so
    group A's and B's invariants in that file were structurally untouchable
  Neither allowed flake appeared; no failure outside the list; no rerun.

VERDICT: GATE-C PASSES. Zero Critical across the whole branch. Both Importants
from lane 1 were fixed before the gate; lane 2's Important was a CONTROLLER
bookkeeping failure and is now ruled and recorded. L3's three groups are complete.

--------------------------------------------------------------------------------
GATE-C MERGED. 2026-08-05. *** THE GATE IS 81f3819. L3 IS COMPLETE. ***
--------------------------------------------------------------------------------

Artefacts landed first (cf03278), then the merge, on the human's instruction —
the same order group B used.

  cf03278  docs(sdd): land group C's ledger entries, task reports and GATE-C
           evidence — eight files via `git add -f`
  81f3819  GATE-C PASSED: L3 group C (C1-C4), two independent reviewers,
           0 Critical  <-- THE GATE, a real --no-ff merge, verdict in the SUBJECT

ACCEPTANCE 7's LOCATOR RE-RUN AFTER THE MERGE, not assumed: `git log --merges
--format='%h %cd %s' --date=iso --reverse` now lists SIXTEEN merges, and the last
three are the three L3 gates in order — e5bf650 (A), bafa6a6 (B), 81f3819 (C) —
each with its verdict in the subject. The two group-A merges that disclaim gate
status still read as disclaimers. $A4, $B and the group-C gate are unambiguous.

VERIFICATION AFTER THE MERGE, on main, run by the controller, unfiltered, because
the merged tree had never been run as such (the gate verification ran on the
branch tip b9afbf3):
  Test Files 30 passed (30) / Tests 514 passed (514), TEST_EXIT=0, 17.49s
  TYPECHECK_EXIT=0; BUILD_EXIT=0
  Neither allowed flake appeared; no failure outside the list; no rerun.

L3's ARC, FOR WHOEVER PICKS THIS UP: three groups, fifteen tasks, three gates,
six independent gate reviewers plus one per task, and FIVE places where the plan
itself was measured to be false. Every one of those five was closed by a human
ruling plus an in-place erratum — never by an implementer quietly changing the
criterion. The fifth was caught by an IMPLEMENTER rather than a reviewer, which
is the first time that has happened here.

STILL NOT DONE, EACH NEEDING ITS OWN HUMAN INSTRUCTION:
  1. NO PUSH. This session has never run `git push`. Check with
     `git ls-remote origin refs/heads/main` rather than trusting any prose — the
     remote has been advanced from outside this session three times already.
  2. The branch feat/l3-group-c-sweep (b9afbf3) and the worktree
     .claude/worktrees/l3-group-c-sweep are BOTH STILL PRESENT. Deleting them
     needs separate authorisation, and the worktree's untracked artefacts must be
     enumerated and copied out first — group B's clean-up found one that existed
     nowhere else.
  3. L5, which now inherits: the resumeLoop concurrent bare reads; the two spec
     sentences still citing "a single array push" as a premise; group B's two
     debts; and the deferred-minor list triaged at this gate.
