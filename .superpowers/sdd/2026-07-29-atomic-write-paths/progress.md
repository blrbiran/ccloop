# SDD ledger — plan: docs/superpowers/plans/2026-07-29-atomic-write-paths.md

Branch: worktree-debt4-atomic-write-paths
Worktree: .claude/worktrees/debt4-atomic-write-paths
Baseline: 29 files / 427 tests at 871c2d7 (docs-only checkout, zero source changes)

BASELINE WAS DIRTY, classified before any work started: 2 failures, both flakes, both
named in full (no `| tail`), both passing twice on isolated re-run (85 passed / 0 failed).
Neither attributable to this branch — the worktree had zero source changes at the time.
- `runLoop.integration.test.ts > treats execute timeout with no adapter result as exhausted
  even if files changed in the worktree` — known BUDGET_EXHAUSTED_REASON family.
- `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks
  descendants rooted at the spawned pid` — **NOT previously on record. Sixth known flake.**
  Recorded in docs/handoff/handoff.md 遗留事项 2 at commit 5e0b75a before any task started,
  per the human's ruling (option 2: book it, then start).

Task 1: complete (commit 4bcde7b). 29 files / 431 tests green (427 + 4 new), typecheck and
build clean. Neither flake fired on that run. Zero call sites replaced, zero behaviour change.
Task 1: TDD order held — red output captured with all four test names visible
(`TypeError: buildAtomicTempPath is not a function`), then green.

FOUR PLAN DEFECTS REPORTED BY THE IMPLEMENTER. Controller verified all of them against the
code rather than accepting the report:

- **D1 (blocking, plan was wrong)**: Task 1's Step 5 (R2 — residue + error propagation) is
  UNREACHABLE as written. `writeJsonFileAtomically` is not exported (`fileStore.ts:394`,
  confirmed) and Task 1 replaces no call sites, so no test can reach it; `vi.mock` is banned
  and ESM exposes no unexported bindings. RULING: R2 moved into Task 2 as Step 4b, where
  `writeRunState` becomes a real entry point. Plan amended.
  The implementer REFUSED to ship a weak substitute (R2 against the still-bare `writeRunState`
  would pass from the start and stay green forever — bare `writeFile` also leaves no temp and
  also throws on a directory target). Correct call under Rule 9. It instead verified
  out-of-band with a mutation ON THE PRODUCTION FUNCTION (deleted the `unlink` from the catch
  → failure-path assertion went red, observed
  `[".loop-state.json.<pid>.<n>.tmp", "loop-state.json"]` vs expected `["loop-state.json"]`)
  and reverted the scaffolding. Nothing of it is committed.
  Task 2's implementer must RE-RUN that mutation and paste its own output — it may not cite
  this entry as evidence.
- **D2 (plan was wrong)**: Task 1 Step 4 cited `finalizePendingOwnerTransfer`'s catch as the
  pattern for "cleanup failure must not mask the original error", but that catch uses
  `safeUnlink`, which RETHROWS anything that is not ENOENT (confirmed at the function's
  definition) — i.e. copying the cited pattern would violate the rule the step states.
  Implementer used a bare best-effort `try/catch {}` with an in-place comment. Correct.
- **D3 (plan was wrong)**: test requirement 4 referenced `getOwnerTransferPaths`, which is not
  exported (`fileStore.ts:354`, confirmed) and cannot be called from a test. Implementer
  hardcoded the 8 fixed names, matching existing convention (`fileStore.test.ts:225-228`,
  `leaseLifecycle.integration.test.ts:726-728` already do the same) and commented the
  duplication. Accepted.
- **D4 (cosmetic)**: stale line number in the plan. CORRECTED TWICE — the plan said :539-543,
  this ledger first said :542-546, and the review established the catch is at **:586-590** in
  the head file (:541-545 at base). Both earlier numbers were wrong. Plan amended.

Task 1: judgement calls beyond the plan, all disclosed by the implementer and accepted —
serialize before entering the try (a stringify failure cannot leave a temp file); temp format
`.<basename>.<pid>.<n>.tmp`; both helpers placed next to `writeJsonFile` so §4.2's
"keep two, do not merge" comment sits where a reader would confuse them.
Task 1: ~~implementer explicitly did NOT claim anything about intermediate visible state in any
test name or comment~~ — **THIS LEDGER ENTRY WAS WRONG.** The review found `fileStore.ts:390-391`
does make exactly such a claim ("a concurrent reader sees either the previous complete file or
the new complete file, never a partial one"). It is defensible for POSIX same-filesystem rename
and it sits on the production function rather than on a test claiming proof, so it is not a
spec §7.1 violation — but the controller's blanket assertion above was inaccurate and is struck.
Durability is the real gap: there is no `fsync`/`fdatasync` anywhere in `src/` (0 hits), so the
comment must not be read as surviving power loss. Spec §3.1 now has a sixth property declaring
crash durability out of scope.

=== TASK 1 CODE REVIEW (independent reviewer, mutation-driven, read-only) ===
Verdict: **Ready to proceed to Task 2 — with fixes. 0 Critical.**
Reviewer worked in a throwaway copy for all mutations; worktree HEAD unmoved, tree clean.
Controller independently re-verified the three most consequential claims before accepting them.

CONFIRMED BY EXECUTION, not by reading the implementer's report:
- Transfer path byte-identical: per-symbol SHA-256 across base vs head for all four protected
  symbols plus 5 related helpers and all 8 `OWNER_*` constants — identical. `git diff
  --unified=0` shows only the `node:path` import line and one insertion block in the source file.
- All four `buildAtomicTempPath` tests DIE under mutations applied to the production function
  (drop counter → test 1; drop pid → test 2; stage in /tmp → test 3; hand out the transaction's
  fixed temp name → tests 1, 2, 4). No test survived its named target.
- The D2 fix is correct AND the plan's cited pattern is wrong: reviewer constructed a real case
  (directory at the exact next temp path) where `writeFile` throws EISDIR and `unlink` throws
  EPERM. Shipped bare `try/catch {}` propagates EISDIR; substituting `safeUnlink` (the pattern
  the plan cited) propagates EPERM — the original error is replaced. Verified by running it.
- Temp names cannot collide with anything the system keys on, by construction: every
  `RUN_MARKER_FILES` entry is non-dotted, and all 8 transfer fixed names have a non-numeric
  third segment (publish/pending/transaction/lock) while generated names have a numeric pid there.
- Full suite in the real worktree, unpiped: 29 files / 431 tests pass. Neither known flake fired.
  typecheck and build exit 0.

OPEN — MUST BE FIXED BEFORE TASK 2 IS DISPATCHED:
- **Imp-1 (spec + plan defect, controller's own)**: the "zero `vi.mock` (已核实)" premise is
  FALSE. `vi.mock(` is genuinely 0, but `vi.doMock` appears **24 times across 5 test files,
  including `tests/persistence/fileStore.test.ts` itself**, where it mocks `node:fs/promises` to
  make `writeFile` throw for a specific path. Same facility, runtime-scoped. Root cause: the
  controller grepped the literal `vi.mock` and never `doMock`. The error's direction matters —
  it was used to invoke Rule 11 against mocking, while the actual established convention in the
  very file under edit is the opposite. D1's conclusion still stands independently (an
  unexported function is unreachable regardless of mocking), but one of its stated premises was
  false. FIXED: spec §7 and the plan's Global Constraints now state a preference, not a ban, and
  no longer cite Rule 11. Task 2's Step 4b inherits the corrected version.
- **Imp-2 (implementation, OPEN — dispatched as a fix round)**: `fileStore.test.ts:1493`'s name
  claims "两个进程不会碰撞" but the test only shows the pid appears in the name; and the
  assertion is position-blind (`toContain(String(process.pid))`). The mutation that removed the
  pid went red only because the pid happened to be 62630 — **under pid 1 in a container,
  `.loop-state.json.1.tmp` contains "1" and that mutation SURVIVES.** This is exactly the
  "test claims to kill A but cannot" defect class this project keeps paying for.
- **Minor-3 upgraded to should-fix by controller ruling**: `buildAtomicTempPath` uses bare
  `process.pid` while `src/runtime/processIdentity.ts:7` already rules on this exact concern
  (`pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`, with a comment that PIDs are
  recycled) and exports `buildProcessInstanceId()`. Reviewer honestly reported it could NOT
  construct a single-machine failure, so this is not a correctness bug — but it is a silent fork
  from a same-repo primitive for the same problem, which Rule 7 says to surface rather than
  duplicate. Ruling: adopt `performance.timeOrigin` — one expression, closes the gap outright,
  and it also fixes Imp-2's position-blind assertion in the same edit.

DEFERRED (recorded, not fixed):
- Minor: test 4 (`:1512-1527`) has no independent kill power — any name keeping the
  `.<numeric pid>.<n>.` shape can never equal one of the 8 fixed literals, so breaking test 4
  requires first breaking the format, which trips tests 1 and 2. Not vacuous, but treat it as
  documentation of an invariant, NOT as independent coverage.
- Minor: the 12-line doc block at `:371-386` is separated from the function it documents by
  `let atomicTempPathSequence = 0`, so it visually reads as documenting the counter.
- Out of scope by spec §2.2, correctly untouched, worth booking for a future layer:
  `finalizePendingOwnerTransfer`'s own catch (`:586-590`) has the SAME latent masking bug D2
  describes — two `safeUnlink` calls that can replace an in-flight error.

=== TASK 1 FIX ROUND 1/5 — complete (commit deb8036) ===
Dispatched to the ORIGINAL implementer (resumed from its transcript, so it kept its context).
All three items addressed, zero rework of reviewed code, zero production call sites replaced.

- **Imp-2 FIXED.** Test renamed to "puts this process's id and start time at fixed positions in
  the temp file name" — narrowed to what it proves, with a comment stating explicitly that it
  does NOT prove two processes cannot collide. Assertion replaced with a both-ends-anchored
  regex `^\.loop-state\.json\.${process.pid}\.\d+\.\d+\.tmp$`.
  TWO-SIDED EVIDENCE, produced by the implementer and independently re-derived by the
  controller: under mutation B (pid dropped from the production template) the OLD
  `toContain(String(process.pid))` SURVIVES at a forced pid of 1, while the NEW anchored regex
  fails at both the real pid and a forced pid of 1. The kill no longer depends on the pid's
  digits. The regex additionally kills a mutation that drops `timeOrigin` instead (two trailing
  numeric groups where three are required), so Minor-3's fix is guarded too.
- **Minor-3 FIXED.** Name shape is now `.<basename>.<pid>.<timeOrigin>.<seq>.tmp`.
  `buildProcessInstanceId()` deliberately NOT called — its `pid:<pid>:<origin>` form embeds
  colons, which do not belong in a filename; the two components are derived the same way and a
  comment at `:383-387` records that this is the same decision as `processIdentity.ts:3-7` and
  why the function was not reused. `import { performance } from "node:perf_hooks"` matches
  `processIdentity.ts:1` exactly.
- **Minor-6 FIXED.** `let atomicTempPathSequence = 0` moved above the doc comment.
- Optional durability note added at `:404-406` per spec §3.1 item 6.

CONTROLLER'S INDEPENDENT VERIFICATION (did not accept the fix report):
- New assertion read from the file: anchored at both ends with the pid interpolated at a fixed
  position. Dropping the pid from the template leaves only two numeric groups where the regex
  demands pid plus two — so the kill holds BY CONSTRUCTION, independent of the pid's value.
- Mutation scaffolding fully reverted: grep for mutation markers in both files returns nothing.
- `git diff --name-only 4bcde7b..HEAD` contains NO `src/registry/` path.
- All four protected transfer symbols re-hashed base vs head: IDENTICAL.
- Full suite in the worktree, unpiped: 29 files / 431 tests pass. typecheck exit 0, build exit 0.

IMPLEMENTER'S OWN DISCLOSURES, both accepted as honest and correct:
1. It stated that its D1 write-up overreached — it asserted "no third path" on the strength of
   the spec's 「已核实」 instead of spending one grep, and only the load-bearing half (an
   unexported binding is unreachable regardless of mocking) was actually verified. Recording
   this because the same failure mode produced the controller's Imp-1: trusting a written
   「已核实」 rather than re-deriving it.
2. NEW MINOR, deliberately not acted on, FOR THE WHOLE-BRANCH REVIEW: `buildAtomicTempPath` and
   `buildProcessInstanceId` now independently derive the same two components from the same
   reasoning, joined only by a comment. If `processIdentity.ts`'s recipe changes (e.g. gains a
   random suffix), nothing here fails. The implementer declined to extract a shared
   filename-safe helper because that grows API surface Task 1 was told not to grow. Correct
   scope discipline; the coupling is real and unguarded.

=== FIX ROUND 1/5 RE-REVIEW (independent, fresh eyes, mutation-driven) ===
Human chose to spend on it. It paid for itself: **the fix reintroduced its own target defect in
narrower form**, which is the failure mode this repo already has on record for fix waves.

CONFIRMED: all three fixes plus the durability note landed. All four legs of the two-sided
mutation evidence reproduce exactly as claimed. All six scope constraints verified by execution
— `src/registry/` zero files changed across the whole range, four protected symbols `cmp`
byte-identical, `writeJsonFileAtomically` still has ZERO callers anywhere (so Task 1 remains a
pure addition), serialization exactly `JSON.stringify(value, null, 2)`, no injection seam, and
the mutation scaffolding is genuinely gone (no `setupFiles` in vitest.config.ts, no pid stub
anywhere). Suite 29 files / 431 tests, both known flakes passed, typecheck and build exit 0.
Also verified `performance.timeOrigin` is filename-safe: fractional in reality (so `Math.trunc`
is load-bearing and dropping it IS killed), always positive, never exponential, stable within a
process, distinct per worker under vitest's `forks` pool.

**NEW Important, introduced by fix round 1 — OPEN, dispatched as fix round 2/5:**
The new test name claims the pid AND START TIME sit at fixed positions, but the assertion for
the start-time slot is only `\.\d+\.` — it cannot tell the start time from any digit string.
Verified by execution: `Math.trunc(performance.timeOrigin)` replaced by `0`, by `12345`, or by
`process.pid` again ALL SURVIVE with the whole suite green. **So the anti-PID-recycling
component added for Minor-3 shipped with zero test coverage under a name claiming to cover it.**
Same defect class as Imp-2, narrower scope, created by the commit meant to remove it.
RULING: assert that segment against the numeric tail of `buildProcessInstanceId()`
(`src/runtime/processIdentity.ts`, already exported and already consumed by resumeLoop.ts and
runLoop.ts, so zero new API surface). This closes the Important, gives Minor-3 real coverage,
AND becomes the mechanical cross-file guard the previous round flagged as missing.
The reviewer's framing is sharper than the implementer's: the missing guard is not cross-file,
it is local — nothing fails if `buildAtomicTempPath`'s OWN recipe changes.

**NEW Minor — a false argument propagated through four hands into committed code:**
The first review claimed that at a container pid of 1 the pre-fix name would be
`.loop-state.json.1.tmp` and so "contains 1". **That arithmetic is wrong**: by the time that
test runs `atomicTempPathSequence` is already 3 (test 1 consumes two calls), so the name is
`.loop-state.json.3.tmp`, which does NOT contain "1" — the old assertion would have KILLED that
mutation. The re-review still reproduced a genuine survival, but by a DIFFERENT mechanism: under
the post-fix template the name is `.loop-state.json.1785422763967.3.tmp` and the timeOrigin
digits happen to contain "1".
CONCLUSION UNCHANGED (containment is position-blind and its kill power depends on digit
coincidence). ARGUMENT WAS WRONG. Chain of custody: first reviewer → controller's report to the
human → controller's dispatch message → implementer's committed comment. **The controller
repeated it without verifying it, in a round whose entire subject was comments and test names
not over-claiming.** Being corrected in fix round 2/5.

**NEW Minor**: `fileStore.ts:396` recomputes `Math.trunc(performance.timeOrigin)` per call while
`processIdentity.ts:7` caches it in a module const — no behavioural difference, but the two
"same decision" sites now differ in shape, which is exactly the drift the fix's own comment says
must not happen. Being hoisted to a module const in fix round 2/5.

NOTED, not a defect: there is a THIRD spelling of process identity in this file —
`fileStore.ts:543` writes `pid:${process.pid}` with no timeOrigin. Pre-existing, inside
byte-identical protected code, and legitimate: its only consumer is `parsePid()` (`:512`), which
extracts the pid for a liveness check. The fix's comment saying "the two components" undercounts
the sites; wording being corrected, the code is not.

REVIEWER'S JUDGEMENT ON THE FLAGGED COUPLING, accepted: NOT extracting a shared helper is the
right call — the two sites need genuinely different output formats (`pid:<pid>:<origin>` vs
`<pid>.<origin>`), so a shared helper would need to return components or take a separator, which
is new API surface for two callers against Task 1's scope. And drift is not a correctness
coupling: a changed recipe upstream would still leave names unique per process instance.

PROCESS LESSON FOR THIS BRANCH AND THE NEXT: two separate defects this round came from the same
habit — **trusting a written 「已核实」 instead of re-deriving it.** The controller's Imp-1 (the
false zero-`vi.mock` premise) and the implementer's over-scoped D1 write-up both did it, and so
did the controller repeating the pid-1 arithmetic. A claim marked as verified by someone else is
still an unverified claim until you run it.

=== TASK 1 FIX ROUND 2/5 — complete (commit 131167b) ===
Same implementer, resumed. All three items from the re-review addressed.

- **Important CLOSED.** The assertion now takes both segments from
  `buildProcessInstanceId().split(":")` and interpolates the real start time into the regex:
  `^\.loop-state\.json\.${pid}\.${startTime}\.\d+\.tmp$`. Implementer reports all three
  previously-surviving mutants (`.0`, `.12345`, `.${process.pid}`) are now killed, each applied
  to the production constant and reverted from a pristine backup between runs.
  Beyond the ruling it added `expect(startTime).toMatch(/^\d+$/)` so a format change in
  `processIdentity.ts` fails legibly instead of interpolating `undefined` into the regex —
  accepted; it hardens the new cross-module pin rather than widening scope.
- **Minor (false arithmetic) CLOSED, and closed the right way.** The implementer did NOT
  substitute another unrun mechanism for the wrong one. It REPRODUCED the survival: same
  pid-dropped mutant, same template, old `toContain` assertion — real pid → killed, pid forced
  to 1 → survived (`.loop-state.json.1785424204699.1.tmp`, the timeOrigin digits carrying the
  "1"). The comment now claims only that containment's kill power is digit coincidence, and
  asserts neither outcome, because neither is general.
- **Minor (per-call recompute) CLOSED.** Hoisted to `ATOMIC_TEMP_PROCESS_STAMP`
  (`fileStore.ts:385`), matching `processIdentity.ts:7`'s shape. Comment reworded to "recipe",
  and it now names `pid:<pid>` at `:543` as a legitimate third form with `parsePid`'s
  liveness-probe rationale and an explicit do-not-unify note.

CONTROLLER'S INDEPENDENT VERIFICATION: the regex interpolates the actual start time obtained from
a DIFFERENT module, so a constant in that slot cannot match — the kill holds BY CONSTRUCTION, not
by the implementer's say-so. Scaffolding grep clean in both files. Suite 29 files / 431 tests
green, typecheck exit 0.

IMPLEMENTER'S OWN DISCLOSURE, recorded because it names the mechanism better than the finding did:
"I hardened the pid assertion for exactly this failure mode, then in the same edit introduced
`\d+` for the new segment and wrote a test name asserting coverage of it. I was treating 'the
test name is honest about SCOPE' as the lesson, when the lesson is 'every clause in the name must
have an assertion that can fail.' **Adding a component and its coverage are one change, not
two.**" It also adopted a standing rule for the rest of the task: any mechanism it puts in a
comment gets executed first.

On the tautology question the controller raised: the implementer argued, and the controller
accepts, that pinning `buildAtomicTempPath`'s stamp to `buildProcessInstanceId()`'s tail is NOT
tautological — the two modules compute `Math.trunc(performance.timeOrigin)` from independent
expressions, so the assertion pins one to the other ACROSS a module boundary, which is exactly
the invariant the comment previously asserted only in prose. It would become tautological only if
`buildAtomicTempPath` were implemented in terms of `buildProcessInstanceId()`, and in that case
the test passing is the correct outcome.

=== NARROW RE-REVIEW OF FIX ROUND 2 (`deb8036..131167b`) — verdict: YES, clean ===
Same reviewer, resumed with its context. Sandbox outside the worktree; worktree left clean.

- All three previously-surviving mutants KILLED (`timeOrigin` → `0`, → `12345`, → `process.pid`).
- **The reviewer added the leg nobody asked for and it is the one that settles the tautology
  question**: it mutated `processIdentity.ts`'s recipe ALONE, leaving `fileStore.ts` untouched
  → also KILLED. A tautological assertion would fail only when both sides move together; this
  one fails from either side independently. The cross-module pin is real.
- Correctly narrowed what the pin guarantees: "the two modules agree", NOT "this value really is
  the start time". The latter cannot be asserted independently inside one process; the former is
  the strongest reachable guarantee.

The four controller concerns, all settled BY MEASUREMENT:
- (a) Load-time constant vs run-time call CANNOT diverge — `process.pid` and
  `performance.timeOrigin` are process-level constants, so recomputation at any moment in the
  same process yields the same value. Probed with the repo's real `vi.resetModules()` +
  `vi.doMock` pattern in both directions (reload fileStore only; reload processIdentity only).
  Non-issue. **Side observation, pre-existing since `4bcde7b` and NOT introduced by these fixes**:
  after a module reload the fresh `fileStore` instance restarts `atomicTempPathSequence` at 0, so
  two module instances in one process can emit the same temp path. Unreachable in production
  (one ESM registry).
- (b) `split(":")` does NOT degrade silently. Measured per hypothetical format change: dropping
  the origin, a component containing colons, and reordering all FAIL LOUDLY via the
  `/^\d+$/` guard or the regex. Only a renamed prefix or an appended trailing segment survive,
  and neither can move index [1]/[2]. The guard is sufficient.
- (c) Not a tautology — see the two-directional evidence above.
- (d) A non-incrementing sequence still dies, both as a frozen counter and as a literal in the
  template — killed by test 1 in both forms.

Existing tests NOT weakened: tests 1, 3 and 4 each still uniquely kill a targeted mutation; none
became vacuous from the extra name segment.

Reviewer also checked, unprompted: no TDZ or evaluation-order problem from hoisting the constant;
no import cycle from the test's new `processIdentity` import; and every factual claim in the new
comments — the `processIdentity.ts:7` line reference, "timeOrigin is fixed within a process", and
"the third form `pid:<pid>`'s only consumer is `parsePid` and it never compares identity"
(confirmed by grep: zero equality comparisons on `holderProcessInstanceId` repo-wide).

ONE MINOR FOUND, FIXED IMMEDIATELY BY THE CONTROLLER (comment wording only, no behaviour):
the new comment claimed asserting across the modules makes "either one drifting" a failure. Not
true for every drift — a renamed prefix or an appended trailing segment leaves both components in
place and the test stays green, which the reviewer measured. Narrowed to "either side changing
the pid or start-time components", with the surviving drift classes named explicitly and marked
as measured. Reported precisely because this branch's recurring defect is comments claiming more
than was verified — including, twice already, the controller's own.

=== TASK 1 CLOSED ===
Commits: 4bcde7b (implementation) → deb8036 (fix round 1) → 131167b (fix round 2) → comment
narrowing. Two reviews and two fix rounds. Zero production call sites replaced, zero behaviour
change, zero Critical at any point.
Final state: 29 files / 431 tests green, typecheck and build clean, `src/registry/` untouched,
four protected transfer symbols byte-identical to `5e0b75a`, `writeJsonFileAtomically` still has
no callers.
NEXT: Task 2 (`loop-state.json`'s two writers, `:76` and `:81`), which also carries R2 as Step 4b
per defect D1, and must RE-RUN the residue mutation itself rather than cite this ledger.

SEVENTH FLAKE, found on Task 1's closing verification run and handled by the branch's own rule
rather than waved through: `tests/controller/runLoop.integration.test.ts > runLoop > records
retained cleanupStatus in execution recovery when cleanup fails` failed once at 430/431.
It is in NEITHER known family — not `BUDGET_EXHAUSTED_REASON` (it asserts cleanupStatus retention
on a cleanup failure, nothing to do with budgets) and not the spawned-pid one.
Classified, not assumed: full name and failure block captured without `| tail`; passes in
isolation; full suite then passed TWICE more at 431/431; and the commit under test was
comment-only — `git diff` shows exactly 4 changed comment lines in `fileStore.test.ts`, so it
cannot have caused a failure in `runLoop.integration.test.ts`.
Recorded in `docs/handoff/handoff.md` 遗留事項 2 as flake 7. Not root-caused, not fixed.
The count of known flakes has gone 5 → 6 → 7 during this branch, all found by running the suite
honestly rather than by piping it through `tail`. None was introduced here.

~~NOT YET DONE ON TASK 1: **no code review has been run.**~~ **STRUCK 2026-07-30 by the Task 2
controller — this entry was stale, and it contradicts three review blocks in this same file.**
It was written before the reviews and never retracted. The reviews that did run are recorded at
`=== TASK 1 CODE REVIEW ===`, `=== FIX ROUND 1/5 RE-REVIEW ===` and `=== NARROW RE-REVIEW OF FIX
ROUND 2 ===`, and Task 1 is closed at `=== TASK 1 CLOSED ===`. Task 1 is NOT re-reviewed on the
strength of this line. Recorded rather than deleted because this branch's own rule is that a
retraction leaves a trace.

REMAINING: Tasks 2-5, each needing its own review, then a whole-branch review, then
verification-before-completion, then finishing-a-development-branch.

=== TASK 2 DISPATCHED (2026-07-30) — BASE ee001ba ===
Brief: `.superpowers/sdd/2026-07-29-atomic-write-paths/task-2-brief.md`
Report: `.superpowers/sdd/2026-07-29-atomic-write-paths/task-2-report.md`
Implementer model: opus (NOT mechanical — the plan deliberately leaves the `initializeRunFiles`
fixture problem unsolved, and this task carries R2/R4/R5 mutation work).

PRE-FLIGHT DEFECT FOUND BY THE CONTROLLER AND RESOLVED IN THE DISPATCH, not left for the
implementer to trip over — **the spec's and plan's `:76` / `:81` are now STALE BY ONE LINE.**
Verified by reading both revisions rather than trusting either document:
- at base `5e0b75a`: `:75` loop-contract.json, `:76` loop-state.json, `:81` loop-state.json.
- at head `ee001ba`: Task 1's `node:perf_hooks` import shifted everything down one, so
  **`:76` is now `loop-contract.json`** — the one file spec §2.1 line 41 explicitly EXCLUDES —
  and the two real writers are at `:77` (`initializeRunFiles`) and `:82` (`writeRunState`).
Taken literally, the plan would have had the implementer edit the excluded file and miss a
required one. Dispatch anchors on the string `loop-state.json`, never on a line number.
Same defect class as D4 (stale line number), but this instance was not cosmetic.

Also done in this step: struck the stale "no code review has been run" entry above (it
contradicted three review blocks in this same file), and ticked Task 1's checkboxes in the plan
file to match this ledger, which is the source of truth for progress.

=== TASK 2 IMPLEMENTED (commit 5cc5202) — status DONE_WITH_CONCERNS ===
Report: `.superpowers/sdd/2026-07-29-atomic-write-paths/task-2-report.md`
Claimed: 29 files / 436 tests (431 + 5 new), typecheck 0, build 0, no known flake fired.

CONTROLLER'S OWN VERIFICATION OF THE PRODUCTION DIFF (run, not read from the report):
- `git diff ee001ba..5cc5202 -- src/` is EXACTLY 2 lines: both `loop-state.json` writers now
  call `writeJsonFileAtomically`. Nothing else in `src/` moved.
- `git diff ee001ba..5cc5202 -- src/registry/` is EMPTY.
- `loop-contract.json` (`:76`) and both `events.jsonl` sites (`:78`, `:86`) are untouched —
  i.e. the stale-line-number trap identified pre-flight did NOT fire.
Byte-equivalence, transfer-path hashes and all test-quality claims are NOT taken from the
report; they are the reviewer's job and are being re-derived independently.

THREE CONCERNS RAISED BY THE IMPLEMENTER, recorded now, adjudicated after the review:

- **D-1 (forward-looking, likely real)**: the stale-by-one-line drift is NOT confined to Task 2.
  Spec §2.1's table and §9 still carry base-relative numbers, and the implementer reports the
  other three replacement points (`:379-381`, `:308`, `:316`) are shifted by the same import.
  Tasks 3 and 4 walk into the identical trap. PROPOSED: re-anchor the spec on filename +
  function name. **Not yet verified by the controller — will be checked before Task 3 is
  dispatched, not accepted on the report's say-so.**

- **D-2/D-3 (a genuine spec gap, if it holds)**: the inode criterion is not merely awkward for
  `initializeRunFiles`, it is INAPPLICABLE — with no pre-existing target, `rename` and
  `writeFile` leave identical end states, so no fixture can rescue that shape. The implementer
  substituted a dangling-symlink criterion (`access()` follows the link and reports ENOENT so
  the freshness check passes; `writeFile` writes THROUGH the link, `rename` REPLACES it).
  If it holds it also settles Task 3, whose `writeOwnerRecord` is likewise a first-create.
  **This is the single highest-risk judgement call in the task and the review was pointed at it
  explicitly, with instructions to attack the stated mechanism rather than confirm it.**

- **R5 outcome as reported**: dropping either call site leaves exactly one R1 test red — which,
  if it reproduces, is the concrete evidence for spec §9's "changing only one is a failure".

MINOR, correctly observed by the implementer: the worktree was not clean at handoff. Those are
the controller's Step 0 edits (this ledger + the plan's Task 1 checkboxes), not the
implementer's, and it correctly left them alone.

TASK 2 REVIEW DISPATCHED — independent reviewer, opus, mutation-driven, read-only, sandboxed
outside the worktree. Package: `review-ee001ba..5cc5202.diff`. No findings were pre-judged for
it and it was given no instruction to spare anything.

=== TASK 2 CODE REVIEW (independent, opus, mutation-driven, sandboxed outside the worktree) ===
Verdict: **Spec ✅ / quality approved. 0 Critical, 0 Important.** Worktree left untouched
(HEAD still 5cc5202, same two controller-owned dirty files).

Nine mutations, all applied to PRODUCTION code in a throwaway copy, all re-derived by the
reviewer rather than taken from the implementer's report:
- M1 revert ONLY `initializeRunFiles` → 1 test red; M2 revert ONLY `writeRunState` → a
  DIFFERENT test red. **This pair is the concrete evidence for spec §9's "changing only one is
  a failure": each writer has its own independent killer, neither test is a tautology.**
- M3 helper body → bare `writeFile` (R5) → exactly those two red, one per writer.
- M4 delete the `unlink` from the catch (R2) → residue test red; reviewer pasted its OWN
  verbatim output (`.loop-state.json.4386.1785428129987.1.tmp` alongside `loop-state.json`).
- M5 catch rethrows a NEW error → red; M6 catch swallows → red. Together these answer the
  controller's question directly: the tests do NOT survive a cleanup that masks or eats the
  original error.
- M7 `rename` → `copyFile` → 3 red. M8 drop the `, null, 2` → R4 byte test red.
- M9 `access()` → `lstat()` in `ensureFreshRunDir` → symlink test red LOUDLY with
  `runDir already contains prior run data`, exactly as its comment predicts.

Byte-equivalence proved STRONGER than the implementer did: reviewer ran the same inputs against
the `ee001ba` and `5cc5202` copies of `fileStore.ts` and compared on-disk bytes —
sha256 identical (`869a52b2…`), `cmp` clean. Serialization moving inside the helper changed
nothing on disk.
Transfer path: whole-file diff is those 2 lines and nothing else, both revisions 804 lines, so
all four protected symbols are byte-identical by construction.
Suite 29 files / 436 tests (431 + exactly 5 new), typecheck 0, build 0. No known flake fired.

**THE DANGLING-SYMLINK FIXTURE — ATTACKED, AND IT HOLDS.** The reviewer did not confirm the
mechanism, it probed it: `access()` on the dangling link → ENOENT (freshness check passes);
`writeFile` → link survives + destination created; `rename` → link gone + destination never
created. Both halves observed directly on APFS. 40 consecutive runs, 0 failures. No inode is
freed, so the inode-reuse hazard that motivates the open-handle step **does not exist here at
all**. It also searched for a simpler criterion and reported there is none: any entry `access()`
can resolve (file, dir, FIFO) trips `ensureFreshRunDir`, so a dangling symlink is essentially
the unique entry that survives the freshness check while still being replaceable by `rename`.

REVIEWER'S OWN DISCIPLINE, worth recording: its first suite run showed `tests/cli/cli.test.ts >
parseArgs > returns 0 for the scripted example run` failing. **That name is not on the 7-flake
list, so it refused to wave it through** and root-caused it: `examples/v1/minimal-contract.json`
has `repoPath: "."` with `worktreeRequired: true`, and its scratch copy had no `.git`. After
`git init` the suite is 436/436. Artifact of its own harness, not a branch defect. This is the
branch rule working as intended.

DEFERRED MINORS (recorded for the whole-branch review, not fixed):
- `fileStore.test.ts:1654` success-path residue test asserts the directory listing but not file
  content, so a writer that wrote nothing would pass it. Content is pinned by the neighbouring
  R4 test (`:1638`) and the inode test's guard (`:1612`), so the block as a whole is not blind.
- New tests `mkdtemp` into `os.tmpdir()` and never clean up — matches 36 pre-existing sites in
  the same file (no `afterEach`, no `rm`). Pre-existing, branch-wide, Rule 11 conformance.

FOUR ⚠️-CANNOT-VERIFY ITEMS, ALL RESOLVED BY THE CONTROLLER BY EXECUTION, not by reading:
1. The other three replacement points — Task 3/4's problem, correctly out of scope here.
2. **D-1 CONFIRMED, and it is WORSE than "off by one" for Task 3.** Controller grepped head:
   `boundary-analysis.json` is at `:309` (spec says `:308`), the reconciliation write at
   `:317-318` (spec says `:316`) — one line, as expected. But `writeOwnerRecord` is at **`:447`,
   not `:379-381`**: Task 1 inserted ~67 lines of helper BEFORE it, so the spec's `:379-381`
   now points INTO Task 1's new helper block. Task 3's own trap text told the implementer to
   "confirm you are editing `:379-381`" — following that instruction literally would have
   edited the atomic helper. FIXED: spec §2.1 re-anchored on function names with the measured
   drift spelled out; spec §9 de-referenced; plan Tasks 3 and 4 re-anchored the same way.
3. **Transient `.tmp` entries in run dirs — swept by the controller, no other consumer is
   affected.** `scanRuns.ts` recognises run dirs via `fileExists` on the exact
   `RUN_MARKER_FILES` names and only descends into DIRECTORIES, so a dot-prefixed `.tmp` file is
   never opened or counted. `directoryHasEntries` (`fileStore.ts:39`) is only ever called on
   `runDir/attempts` and `runDir/worktrees`, never on `runDir` itself, so a temp file at the run
   root cannot make `ensureFreshRunDir` throw. `resumeLoop.ts:73` reads only `runDir/worktrees`.
   Those are all four `readdir` sites in `src/`.
4. Flakes 6 and 7 did not fire — one green run is not evidence they are gone. Still on the list.

**D-2/D-3 ADOPTED INTO THE SPEC as new §7.1a** (creating writes: inode criterion INAPPLICABLE,
not merely awkward — with no pre-existing target `rename` and `writeFile` leave identical end
states, so no fixture can rescue it). §7.1a documents the dangling-symlink criterion, why it has
no flake window, and its one cost (it depends on `ensureFreshRunDir` probing with `access`, and
fails loudly rather than silently if that becomes `lstat` — measured, M9). This closes Task 3
before it opens: `writeOwnerRecord`'s first write is the same shape.

Task 2: complete (commits ee001ba..5cc5202, review clean, 0 Critical, 0 Important, no fix round)

=== TASK 3 IMPLEMENTED (commit d60faee) — status DONE ===
Report: `.superpowers/sdd/2026-07-29-atomic-write-paths/task-3-report.md`
Claimed: 29 files / 438 tests (436 + 2 new), typecheck 0, build 0, new test 20/20 stable.

CONTROLLER'S OWN VERIFICATION OF THE PRODUCTION DIFF (run, not read from the report):
- `git diff 5fdcab1..d60faee -- src/` is EXACTLY 1 line, at `:448`, inside
  `export async function writeOwnerRecord` — the correct symbol. `writeOwnerTransferRecord`
  (`:451`) appears in the hunk only as trailing context, unmodified.
- `git diff 5fdcab1..d60faee -- src/registry/` is EMPTY.
- The re-anchoring worked: the implementer edited `:448`, not the stale `:379-381` that now
  points into Task 1's helper block. The trap identified after Task 2 did not fire.

CONFIRMED BY THE CONTROLLER, not taken from the report — implementer's concern 2 is REAL:
`ensureFreshRunDir`'s `blockingPaths` (`fileStore.ts:52-56`) contains exactly three entries —
`loop-contract.json`, `loop-state.json`, `events.jsonl`. **`owner-record.json` is NOT among
them**, so a runDir holding only an owner record passes initialization, and `runLoop.ts:865`'s
comment ("ensureFreshRunDir has already thrown on any pre-existing run file") is stronger than
the code. Found by the implementer, correctly NOT fixed (it is "whether/when", not "how").
Booked here; the reviewer was asked to rule on whether it touches this task's correctness.

THREE ITEMS SENT TO THE REVIEWER FOR ADJUDICATION, none pre-judged by the controller:
- The implementer DELIBERATELY OMITTED an inode test, arguing the criterion is constructible
  here but would exercise the identical shared helper path, add no coverage, and reopen the
  inode-reuse flake window. Reviewer asked to decide whether that is sound or a coverage gap
  wearing a flake-avoidance costume, and specifically whether an inode test would kill any
  mutation the symlink test does not.
- The implementer claims its fixture has STRICTLY FEWER premises than Task 2's — that
  `writeOwnerRecord` has no guard in front of it, so unlike Task 2 it does not depend on
  `ensureFreshRunDir` probing with `access()`. Reviewer told to verify by execution, not agree.
- Reported spec imprecision: §7.1a grounds the creating-write case in `ensureFreshRunDir`, which
  holds for `initializeRunFiles` but not for `writeOwnerRecord`, where the real reason is that
  the sole production caller runs after initialization. **Spec amendment deliberately DEFERRED
  until after the review** — amending the spec while a reviewer is reading it would pull the
  source of truth out from under the review.

TASK 3 REVIEW DISPATCHED — independent, opus, mutation-driven, sandboxed. Package:
`review-5fdcab1..d60faee.diff`. It was told about the `.git`-less-sandbox artifact that cost the
previous reviewer time, explicitly so it does not skip verification, only that one rediscovery.

=== TASK 3 CODE REVIEW (independent, opus, mutation-driven, sandboxed) ===
Verdict: **Spec ✅ / quality approved, with ONE Important — and the defect is in a COMMENT, not
in the code.** 0 Critical. Five mutations, all on production code, all re-derived by the reviewer.

- M1 revert the one line → new R1 test dies. M2 helper body → bare `writeFile` → **exactly 3**
  die suite-wide (Task 2's inode test, Task 2's symlink test, Task 3's symlink test), 435 pass.
- M3 `, null, 2` → `, null, 4` → BOTH R4 byte tests die, so R4 is not a no-op.
- Name-clause coverage checked by deleting each half of the R1 assertion pair in turn under M1 —
  each half fails independently. Not vacuous.
- 40 consecutive runs of the new block, 0 failures. `tests/` diff has **0 deleted lines**, so
  Task 1's and Task 2's tests are provably not weakened; M2 confirms Task 2's two are still live.
- Byte equivalence produced INDEPENDENTLY and landed on the same sha256 as the implementer
  (`a3b91aaa…b28d1`, 266 bytes).
- Suite 29 files / 438 tests, typecheck 0, build 0, no known flake in ~4 full runs.

**IMPORTANT (dispatched as fix round 1/5): `fileStore.test.ts:1705-1709` asserts something the
implementer had ALREADY PERSONALLY FALSIFIED.** The comment justifies the fixture with "the sole
production caller runs after initializeRunFiles, SO IT IS A FIRST CREATE … no fixture recovers
that; the criterion itself does not apply." The reviewer built the scenario and ran it: a runDir
holding ONLY `owner-record.json` with `leaseAffirmedAt: null` passes `initializeRunFiles` without
throwing, `checkRunLease` returns `no_lease` WITHOUT refusing, and `writeOwnerRecord` then
overwrites with a changed inode (190894890 → 190894895). **The overwrite corner is reachable in
production.** TWO independent gaps allow it, one more than the implementer reported: the blocking
list omits `owner-record.json`, AND `checkRunLease` returns `no_lease`/`expired` rather than
throwing.
The mechanism is the branch's signature defect at its shortest: the implementer FOUND the
blocking-list gap and booked it in its own report §8, then wrote the contradicting overstatement
into its own comment as that comment's load-bearing premise. Not inherited from someone else —
self-contradicted within one task.

THREE ADJUDICATIONS, all settled by execution:
1. **Omitting the inode test: SOUND — but the given argument was not.** "Adds no coverage" is
   FALSE: the reviewer built a wrapper-local mutation (`writeOwnerRecord` uses `writeJsonFile`
   when the target pre-exists, atomic otherwise) that **survives 48/48**; an inode test here
   would kill it. And "reintroduces the flake window" is unsupported — §7.1's open-handle pin is
   implemented at `fileStore.test.ts:1588-1594` and Task 2's inode test never went spuriously red.
   RULING: do not require the test; DO require the justification to change to the only true one —
   the overwrite path delegates to a helper whose overwrite behaviour is already pinned by R1 at
   the `writeRunState` call site.
2. **"Strictly fewer premises than Task 2's fixture": TRUE, and proved the hard way.** Mutating
   `pathExists` from `access()` to `lstat()` — the exact regression §7.1a names as Task 2's known
   cost — kills Task 2's `initializeRunFiles` symlink test while **Task 3's passes unaffected**.
   A genuine strengthening, with no unnamed dependency substituted for the one it sheds.
3. **The `ensureFreshRunDir` gap: out of scope for the CODE, in scope for the COMMENT.** It does
   not touch this task's correctness (`rename` is right for both shapes) and the fixture never
   reaches `ensureFreshRunDir` (proved by M4). It is decisive only as the fact that falsifies the
   comment. The implementer was right to leave `runLoop.ts:865` and `ensureFreshRunDir` alone.

DEFERRED MINORS: the report's "adds no coverage" and "flake risk" wordings (report-only, being
corrected in the fix round); Task 3's guard assertion uses `readOwnerRecord`, which runs
`recoverInterruptedOwnerTransfer` first — a no-op in this fixture, one more moving part than
Task 2's `readRunState` guard, harmless.

BOOKED FOR A LATER LAYER, NOT FIXED HERE (out of this branch's "only how it is written" scope):
`runLoop.ts:864-866`'s comment claims the gate "can only ever observe 'no owner record'" — the
reviewer measured `no_lease` on that path, so the invariant as written is false. `leaseGate.ts:38-42`
says the gate takes no position on that state BY DESIGN (§5.0), so the CODE may well be intended;
it is the comment that overstates. **This is L3/L5 territory (ownership), not debt 4.** Surface to
the human at branch close.

TASK 3 FIX ROUND 1/5 DISPATCHED to the original implementer (resumed, context intact): rewrite
`:1705-1709` on the true justification, correct the report's two wordings, add NO inode test,
re-run the covering file and paste its own output.

=== TASK 3 FIX ROUND 1/5 — complete (commit a445486) ===
Same implementer, resumed. Comment-only: controller verified `git diff d60faee..a445486 -- src/`
is EMPTY; the change is 20 insertions / 5 deletions in `tests/persistence/fileStore.test.ts`.
`tests/persistence/fileStore.test.ts` 48/48, typecheck 0.

- **Important ADDRESSED, and addressed the right way.** The implementer did NOT take the
  reviewer's numbers. It rebuilt the scenario from scratch in `runLoop.ts:862-868` order and got
  DIFFERENT inode values (190911398 → 190911403 vs the reviewer's 190894890 → 190894895) with the
  same conclusion — which is what an independent reproduction is supposed to look like. Both gaps
  re-confirmed by its own run: the blocking list omits `owner-record.json`, and `checkRunLease`
  returns `no_lease` for `leaseAffirmedAt: null` without refusing.
  Comment rewritten to "usually does not pre-exist", overwrite corner named as reachable and
  marked as measured, and exactly ONE reason kept for omitting the inode test (delegation to a
  helper already pinned by R1 at `writeRunState`). "Only ever a create" (false) and "flake risk"
  (unsupported) both removed as reasons. No inode test added, per the ruling.
- **Minor ADDRESSED**: report's "adds no coverage" corrected, and §4 now records that its own
  mutation matrix only ever injected at the call site and in the helper — the wrapper-level
  branch mutation is named as a hole it did not cover. Booking your own blind spot is the
  correct disclosure.

IMPLEMENTER WENT ONE STEP BEYOND THE INSTRUCTION, DELIBERATELY AND DISCLOSED: the new comment
also states the RESIDUAL — its symlink test pins the wrapper's helper choice for the CREATE case
only, so a wrapper branching on target existence (the reviewer's surviving M5) is not pinned by
it. Its argument: saying "no inode test here" without saying what that leaves unpinned would
reproduce the same defect class more quietly. Sent to the re-review to rule on, NOT accepted by
the controller — a comment asserting a coverage boundary is itself a claim that must be true and
checkable, which is the exact shape of the finding being fixed.

SCOPED RE-REVIEW DISPATCHED (`d60faee..a445486`), same reviewer resumed. Told to check every
factual claim the NEW comment makes the same way it checked the old one — a rewrite is precisely
where an unexecuted assertion recurs in quieter form — and to verify by reading whether the new
text's claim about what the `writeRunState` R1 test pins is true or is another inherited premise.

=== TASK 3 FIX ROUND 1/5 RE-REVIEW (`d60faee..a445486`) — verdict: BOTH ADDRESSED, loop closes ===
Same reviewer, resumed. Sandbox refreshed to a445486 and byte-verified against it. It checked
every factual claim in the NEW comment the same way it broke the old one — eight claims, each
with its own check, all true, line references confirmed exact by printing the ranges.

The one that mattered: the new comment says the overwrite case is "already pinned by the R1 inode
test at the writeRunState call site, open-handle pin and all". The reviewer did NOT take that on
trust — it read `fileStore.test.ts:1573-1598`, confirmed the `open()` pin at `:1587` held across
the second write and closed in `finally`, then EXECUTED the helper→bare-`writeFile` mutation at
a445486 and watched that test die. Not an inherited premise.

It also built the inode test §7.1 prescribes as a throwaway: passes 49/49 on clean a445486 (so it
IS constructible, as the implementer said), and under the wrapper-branch mutation exactly ONE test
fails and it is that prototype. So "the only thing an inode test here would add" is now backed by
the strongest evidence available, not by assertion.

**RULING ON THE RESIDUAL DISCLOSURE: right, and checkable, and checked.** The reviewer's
distinction is worth keeping: a comment asserting a coverage boundary is dangerous only when the
boundary is unfalsifiable or untested. This one names a specific, constructible mutation class,
the reviewer ran it (survives 48/48), and the prescribed inode test is the single thing that kills
it. It also fails LOUDLY if it stops being true — add an inode test and the "stated rather than
covered" sentence goes visibly stale beside it, whereas the old comment could sit wrong forever
because nothing in the file contradicted it.

New breakage in the fix diff: NONE. Suite at a445486: 29 files / 438 tests, 0 failed. typecheck 0.
M1 and M2 still kill the same tests at the fix commit.

NOTED, not a finding: the new comment is NARROWER than reality — it names only
`leaseAffirmedAt: null`, but an EXPIRED lease (`leaseGate.ts:44-64`) also returns without
refusing, so a second class of run directory reaches the same corner. Understating is safe.

DEFERRED MINORS (for the whole-branch review):
- `task-3-report.md` §10.1 cites the open-handle pin as `:1588-1594`; it is `:1587-1594`. Report
  only, not in shipped code.
- The inode criterion is not a complete "landed via rename" discriminator in the limit: `unlink`
  then `writeFile` also yields a new inode. §7.1 already scopes it to rename-vs-truncate, so
  nothing is wrong — but it caps what an inode test could ever buy here.
- `runLoop.ts:864-866` still asserts two things measured false. Out of scope for debt 4, still
  needs an owner (L3/L5).

SPEC §7.1a AMENDED BY THE CONTROLLER after the verdict (deliberately not during the review):
split the two creating writers, because the initial §7.1a grouped two call sites whose premises
differ — `initializeRunFiles`'s target CANNOT pre-exist (`loop-state.json` IS in `blockingPaths`)
and its fixture therefore depends on `access()`; `writeOwnerRecord`'s target only USUALLY does not
(`owner-record.json` is NOT in the list, and `checkRunLease` returns rather than refuses for both
a null AND an expired lease — the second entrance the reviewer found), and its fixture depends on
no freshness probe at all. §7.1a now also records the residual (a wrapper branching on existence
survives the symlink test; only an inode test kills it) AND the cap on that remedy (`unlink` +
`writeFile` changes the inode too, so neither test pins that).

Task 3: complete (commits 5fdcab1..a445486, 1 fix round, review clean, 0 Critical)

=== TASK 4 IMPLEMENTED (commit aebe942) — status DONE ===
Report: `.superpowers/sdd/2026-07-29-atomic-write-paths/task-4-report.md`
Claimed: 29 files / 441 tests (438 + 3 new), typecheck 0, build 0, no flake fired.

CONTROLLER'S OWN VERIFICATION OF THE PRODUCTION DIFF (run, not read from the report):
- `git diff f0566fa..aebe942 -- src/` is 3 changed lines across two hunks: `boundary-analysis.json`
  at `:309` and `reconciliation-record.json` at `:317`, both now `writeJsonFileAtomically`.
- **The forbidden neighbours are visibly untouched in the hunks**: `if (artifacts.reconciliationRecord
  !== undefined)` and the `preserveSuccessfulReconciliationIfNeeded(` call both appear as context
  lines, unmodified. That is the "when/whether vs how" boundary holding.
- `git diff f0566fa..aebe942 -- src/registry/` is EMPTY.

TWO ITEMS SENT TO THE REVIEWER FOR ADJUDICATION, neither pre-judged:
- **The implementer ruled the INODE criterion applies to BOTH sites** and deliberately did not use
  §7.1a's symlink criterion — arguing `writeBoundaryArtifacts` has no freshness guard in front of
  either write, and that for `reconciliation-record.json` a pre-existing target is the MAINLINE case
  the function is built around (`preserveSuccessfulReconciliationIfNeeded` reads that exact path
  back; an existing test already calls the function twice against one runDir). Reviewer told to
  verify by execution per site, and specifically to ask whether the FIRST write into a fresh run
  directory (a create) is covered at all, or is an uncovered shape hiding behind a correct-looking
  choice.
- **The implementer reports a spec wording tension and deliberately did not fix it**: §7.1 still
  reads as an unconditional "one inode test per site" while §7.1a carves out exceptions, and it
  argues the deciding factor is not "create vs overwrite" but **whether a guard refuses a
  pre-existing target** — three tiers now in evidence (`initializeRunFiles` impossible /
  `writeOwnerRecord` merely unusual / these two unguarded and designed for it). It followed the
  newer measured §7.1a per Rule 7 and recorded the tier in the test comments rather than editing
  the spec. Reviewer asked to rule on the tiering and say concretely what §7.1/§7.1a should say;
  **the controller will amend only after the verdict**, as with Task 3.

Implementer also notes §2.1's `:308`/`:316` are still stale (actual `:309`/`:317`) — already covered
by the §2.1 warning banner, not a new defect, but the drift keeps widening for Task 5.

TASK 4 REVIEW DISPATCHED — deliberately a FRESH reviewer, not the one who reviewed Tasks 2-3,
because this task's implementer challenges the §7.1a tiering that reviewer helped establish. It was
told it is not expected to agree with earlier conclusions. Package: `review-f0566fa..aebe942.diff`.

=== TASK 4 CODE REVIEW (independent, FRESH reviewer, opus, mutation-driven, sandboxed) ===
Verdict: **Spec ✅ / approved. 0 Critical, 0 Important.** Worktree untouched.
Eight mutations, all built and run by the reviewer in its own copy, none accepted from the report.

- A: revert ONLY the boundary site → exactly 1 failure, the boundary test; reconciliation survives.
  B: revert ONLY the reconciliation site → exactly 1 failure, the other one. **Bidirectional
  independence re-derived, so neither test is a tautology.**
- C: helper → bare `writeFile` (full suite) → 5 dead / 436 alive = exactly the 5 R1 tests that now
  exist. Tasks 1-3's tests provably not weakened.
- **D and E are the pair that settles the criterion question.** D (helper branches: existing target
  → bare, absent → atomic) kills the 3 inode tests and BOTH symlink tests survive. E (the reverse
  branch) kills ONLY Tasks 2/3's symlink tests. **The two criteria are complementary, not
  redundant — each survives one mutation and dies under the other.**
- G: boundary write → no-op → 3 failures. H: second write publishes the PERSISTED record instead of
  the passed one (inode still changes) → only the guard clause catches it, so the guard is not
  vacuous.

**THE PIN WAS NOT TAKEN ON FAITH.** The reviewer `fstat`ed the held descriptor after the second
write: `before=191007398 pinnedFdIno=191007398 pathInoAfter=191007399 pinnedNlink=0`. **`nlink=0`
is the proof** — the old inode is unlinked and kept alive solely by the open handle, so the pin
genuinely blocks inode-number reuse. 60 consecutive runs of the new block, 0 failures.

Byte equivalence re-derived across BOTH revisions, and the reviewer added a shape the implementer
never ran: the **preserve-branch** shape. Six hashes, all identical.
Suite 29 files / 441 tests, typecheck 0, build 0.
§4.3 cross-file disclaimer checked against the spec for ACCURACY, not merely for presence —
including that it names the right direction of the observable window (boundary is written first).

RULINGS:
1. **Inode for both sites: UPHELD, and by execution.** `writeBoundaryArtifacts` has no guard and
   neither filename is in `blockingPaths`, so a pre-existing target needs NO bypass — contrast
   Task 2, which needed a dangling symlink to get past `ensureFreshRunDir`. §7.1a's premise does
   not hold here. `reconciliation-record.json` is genuinely mainline (the preserve logic reads that
   exact path back; a create-only writer would not need it). `boundary-analysis.json` is weaker but
   sound, and the reviewer independently confirmed the production reachability: ONE production call
   site (`runLoop.ts:821`) reached at `:1066` (then `return`) and `:1098` (then `throw`), so at most
   once per process — the overwrite comes from a SECOND process taking over the run directory,
   which is exactly the winner/loser scenario the preserve logic exists for. Choosing inode here is
   **strictly stronger**, not merely defensible.
2. **The three-tier classification is CORRECT and "create vs overwrite" is the wrong axis.**

SPEC AMENDED BY THE CONTROLLER AFTER THE VERDICT (again, never during a review): §7.1's
unconditional "one inode test per replacement site" replaced by a per-call-site rule keyed on
whether a guard refuses a pre-existing target, with the complementarity of the two criteria stated
as measured; §7.1a now leads with the three-tier table and each site assigned, so no later task has
to re-derive the classification.

DEFERRED MINOR — **HANDED TO TASK 5 RATHER THAN TO THE FINAL REVIEW**, because Task 5 is a
comment-only task and this is a one-sentence comment fix in the same file:
`fileStore.test.ts:1884-1886` (and the related rationale at `:1808`) attributes the guard's outcome
to a mechanism that is NOT what produces it. The comment says the guard doubles as a check that the
record written is the one passed in "because `preserveSuccessfulReconciliationIfNeeded` returns
early for `eligibleForContinuation: true`". **Mutation F: deleting that early return entirely
leaves all 51 tests passing** — the fixture writes no `owner-record.json` or `owner-transfer.json`,
so `readPersistedSuccessfulTransferArtifacts` returns `null` and the branch falls through to the
same value either way. The guard itself is fine (mutation H kills it); the stated mechanism is not
load-bearing. Same defect class as Task 3's Important, one severity down.

MINOR, informational, NOT a defect: this task's tests do not assert rename-landing for the CREATE
shape at either site (mutation E survives all three). Acceptable — the call sites are unconditional
single-line delegations and creates-via-rename is pinned at the helper level by Tasks 2/3's symlink
tests, where mutation E dies loudly. D and E together cover both branch directions. **No uncovered
shape is hiding behind the choice** — the reviewer answered the question the controller asked.

REVIEWER SURFACED A RULE 6 BREACH RATHER THAN HIDING IT: this review substantially exceeded the
4,000-token per-task budget, and it stated that the prescribed method (re-derive every load-bearing
claim by execution; eight mutations plus a 60-run stress) is not achievable within it. **Recorded
as a standing conflict between CLAUDE.md Rule 6 and this branch's review standard — for the human,
not for me to resolve.**

Task 4: complete (commits f0566fa..aebe942, review clean, 0 Critical, 0 Important, no fix round)

=== TASK 5 IMPLEMENTED (commits c610812 + 8db732b) — status DONE_WITH_CONCERNS ===
Report: `.superpowers/sdd/2026-07-29-atomic-write-paths/task-5-report.md`
Claimed: 29 files / 441 tests — exactly the baseline, as a comment-only task must be. typecheck 0,
build 0, `zeroWrite` 2/2 as a REAL run (spec §7.2 R6 satisfied by execution, not by argument).

CONTROLLER'S OWN VERIFICATION (run, not read from the report):
- `git diff 6377bf3..8db732b -- src/registry/` is **100% comment lines** — 15 insertions in
  `observeFields.ts`, 4 in `readObservedFile.ts`, zero deletions of code.
- Both `atomic: false` are still false (`observeFields.ts:19`, `:34`); `:45`'s `atomic: true` for
  `owner-transfer.json` is untouched. The one flag that must not flip did not flip.

FIVE CONCERNS, all adjudicated by the controller:

1. **The BRIEF contradicts the task, and the fault is the controller's.** `task-5-brief.md:6` says
   「無測試文件改動」 and its `git add` lists 3 files — both stale, because the controller folded
   Task 4's deferred minor (the false test comment) into this task AFTER the brief was generated.
   The implementer correctly followed the task message over the brief. **Recorded, brief not
   edited**: the ledger is the record, and rewriting a brief after dispatch hides the drift.
2. **It reproduced BOTH mutations itself.** Deleting the `eligibleForContinuation` early return →
   51/51 still pass, so the old comment's mechanism is confirmed vacuous by its own run rather than
   by citing the reviewer. It then ran the CONVERSE (publish the persisted record instead of the
   passed one) → exactly one failure, at the guard line `:1887`, with the inode assertion above it
   still passing. That second leg is what makes the new comment's claim — guard and inode check are
   non-redundant — evidenced rather than merely better-sounding.
3. **IT FELL INTO THE STALE-LINE-NUMBER TRAP INSIDE THE COMMIT THAT WAS FIXING FALSE COMMENTS.**
   Its own 11 inserted lines moved `atomic: true` from `:30` to `:45` and `readObservedFile.ts`
   `:101/:114` to `:103/:116`, and its first draft had copied the pre-edit numbers out of the spec.
   Caught by mechanically printing every cited line; fixed in `8db732b`.
   **RULE EXTENSION ADOPTED, proposed by the implementer**: this branch's "verify before citing"
   rule covered READING and not WRITING. **Re-verify every line citation AFTER all edits land —
   your own edits move the lines you cite.**
4. Two commits rather than one. **Ruling: leave them.** The global rule prefers new commits over
   amending, and the split records what actually happened.
5. **A THIRD stale comment of the same class, deliberately left and flagged rather than silently
   fixed**: `readObservedFile.ts:101-102` ("an atomic file (written by rename) is read once") still
   implies the `atomic: false` files are not rename-written — the same falsehood as the `:3`
   sentence, weaker form. Spec §5, the brief and the dispatch all enumerate exactly two sites, so
   it invoked Rule 3 and asked.
   **CONTROLLER'S RULING: FIX IT, and the flag-don't-widen instinct was still correct.** Rule 3
   protects against improving UNRELATED adjacent code; this is the same false proposition, in the
   same file, about the same flag, falsified by the same commits. Leaving a known-false comment
   standing in the file this branch exists to change is worse than a one-line widening — and it is
   the exact defect class that produced this branch's most expensive findings. Dispatched back to
   the same implementer, with instructions to key the sentence on the FLAG rather than on the fact
   of rename-writing, to touch no logic, and to re-read the two neighbouring comments it just wrote
   so three comments about one flag do not start drifting apart.

§9 checked line by line by the implementer, including the four transfer symbols hashed per-function
across `main` vs `HEAD` **with an extraction-failure guard so an empty match cannot silently
"pass"** — that guard is the kind of thing this branch has learned to require.
Independent review still pending; none of the above is accepted as final until it runs.

=== TASK 5, RULING FOLLOW-UP (commit 7a3490d) — status DONE_WITH_CONCERNS ===
441 tests (baseline exact), zeroWrite 2/2, typecheck 0.
Controller re-verified: `git diff 6377bf3..7a3490d -- src/registry/` has **zero non-comment changed
lines** (checked mechanically by filtering the diff for added/removed lines that are not `//` and
not blank — the filter returned nothing). Both `atomic: false` unchanged.

**THE IMPLEMENTER CAUGHT AN ERROR IN THE CONTROLLER'S OWN RULING. It is right and I was wrong.**
My instruction said to write that "every file it names is now rename-written". **That is false for
`OBSERVED_FILES` as a whole**: the third entry, `owner-transfer.json`, is flagged `atomic: true`
and still has a non-atomic writer — `writeOwnerTransferRecord`, the very M-1 function this same
task was documenting. Written literally, my ruling would have produced a SECOND false comment in
the commit fixing false comments. It scoped the claim to the two `atomic: false` files instead,
matching the scoping the `:3` header already used, and verified the enumeration from code.
Recording this at full strength: the controller has now been the source of a false claim twice on
this branch (the `vi.mock` premise in Task 1, this one), and both times a subagent caught it.
**The instruction to verify rather than accept applies to instructions from me too, and it worked.**

TWO MORE SELF-INFLICTED DRIFTS, both found by the rule adopted one round earlier:
- Its own earlier comment said `owner-record.json` is "published by rename on **both** of its
  paths" and named two. **There are three** (`writeOwnerRecord:448`, `finalizePendingOwnerTransfer:619`,
  `writeOwnerRecordAtomically:717`). Fixed by not hardcoding a count.
  **NEW LESSON, and it generalises past this branch: hardcoded QUANTITIES ("both", "the two") are
  the same rot class as hardcoded line numbers, but stealthier — a wrong line number shows up the
  moment you `sed` it; a wrong count only surfaces if someone re-enumerates.**
- The line-citation rule fired again immediately: inserting 4 lines at `:101` and 1 in
  `observeFields.ts` pushed lines cited by its OTHER comments (`observeFields.ts:45`→`:46`,
  `readObservedFile.ts:103`→`:105`, `:116`→`:118`). All fixed, 7/7 citations re-resolved.
  **Running total: 6 stale citations across two rounds, every one self-inflicted.**

IMPLEMENTER'S PROPOSED ESCALATION, recorded for L3 and NOT acted on here: given that recurrence
rate, cross-file line citations in this repo cost more than they return — nothing compiles, tests
or lints them, and the only guard is a human re-running a `sed` loop. Its new `:101` comment uses
ZERO line numbers (it references the flag name and "the file header") and it argues no precision
was lost. It deliberately did NOT bulk-convert the existing citations — outside the ruling's scope
and a Rule 3 violation. **Correct scope discipline; the proposal is for the next layer to decide.**

TASK 5 REVIEW DISPATCHED (`6377bf3..7a3490d`, 3 commits) — fresh reviewer, opus. Framing: this task
changed no logic, so a comment's only failure mode is being false, misleading or stale, and
fact-checking every assertion against the code IS the review. It was given the specific claims with
teeth (the 100ms bound and its 2×50ms-vs-3×50ms question, zero production callers, the writer
enumerations, every line citation at HEAD, the rewritten test comment's mechanism, and whether the
`:101` rescope stayed accurate without going vague), and told the stale brief is known and not a
finding.

=== TASK 5 CODE REVIEW (independent, fresh, opus) — Spec ✅ / approved, 0 Critical, 0 Important ===
Framing that paid off: a comment's only failure mode is being false, so fact-checking every
assertion IS the review. Eleven claims checked, every one re-derived, none accepted from the report.

VERIFIED BY EXECUTION: suite 29 files / 441 tests — EXACTLY the baseline, as a comment-only task
must land; typecheck 0; build 0; `zeroWrite` 2/2 as a real run (§7.2 R6 satisfied by running, not
arguing). `src/registry/` diff across the WHOLE BRANCH (`ee001ba..7a3490d`), filtered for
non-comment lines, is EMPTY. `git diff -- tests/ | grep -c writeOwnerTransferRecord` = 0, so §6's
"call sites unchanged" holds.

**The four transaction symbols: the reviewer did it its own way and its guard earned its keep.**
Its first extractor anchored on the first `{` after the signature and silently produced a 1-LINE
body for `acquireOwnerTransferLock`, because that function's return type is
`Promise<{ release: () => Promise<void> }>`. **The short-body guard caught it instead of hashing an
empty match and reporting IDENTICAL.** After fixing the anchor: all four identical (21/6/43/16
lines), all 8 `OWNER_*_FILE` constants identical. This is the second time on this branch that a
fail-loud guard turned a silent false pass into a caught error.

FACT-CHECKS THAT PASSED, each re-derived:
- The 100ms bound: `LEASE_VERIFY_READ_ATTEMPTS = 3` / `LEASE_VERIFY_RETRY_DELAY_MS = 50`
  (`lease.ts:7-8`, citation exact), and the sleep at `readObservedFile.ts:124` is guarded by
  `if (attempt < maxAttempts)`, so 3 attempts yield **2** sleeps. **Worst case really is 2 × 50ms,
  not 3 × 50ms — the comment is right**, and it agrees with the L2 spec §8.1's own "+100 ms".
- Retry trigger clauses all three correct: ENOENT → `absent` (`:114`), non-SyntaxError →
  `unreadable(io)` (`:118`), only `SyntaxError` falls through.
- Zero production callers for `writeOwnerTransferRecord` — grepped independently; only the three
  test files the comment names, zero `src/` importers.
- `loop-state.json` exactly two writers (`:77`, `:82`); `owner-record.json` three rename publish
  sites (`:448`, `:716-717`, `:618-619`) and zero direct writers. The implementer's self-correction
  from "both" to three was right.
- **Every line citation re-resolved at HEAD: ZERO residual stale citations.** And the reviewer
  noticed something worth keeping: the implementer did NOT propagate the stale numbers its own
  inputs handed it — the brief and spec §6 both say `observeFields.ts:30`, and it shipped `:46`.
- Both mutations reconstructed independently. A (delete the early return) → 51/51 green, so the old
  mechanism was indeed vacuous and the count of 51 is exact. B (publish the persisted record) → 1
  failed at `:1893` with the inode assertion at `:1883` still passing, so the content guard is the
  ONLY thing that catches it. The rewritten comment names a genuinely load-bearing mechanism.
- The `:101` rescope the implementer made against the controller's wrong instruction is correctly
  scoped AND did not go vague — `:104` still states the operative rule.

TWO MINORS — recorded here, NOT entered into a fix loop, and the final whole-branch review is
pointed at them to triage before merge:
- **Minor 1 (introduced by this task, and it is an internal contradiction):**
  `readObservedFile.ts:104` says "retry a parse failure up to LEASE_VERIFY_READ_ATTEMPTS times", but
  that constant counts ATTEMPTS — 3 attempts is 2 retries. Read literally it says three retries, and
  a maintainer budgeting scan latency from it computes 150ms. `observeFields.ts:17-18`, describing
  the SAME code, says 2 × 50ms ≈ 100ms, and the code agrees with `observeFields`. So it is also the
  one place the three `atomic`-flag comments disagree. The line it replaced gave no count at all.
  One word fixes it.
- **Minor 2 (pointer to a section this branch falsified):** the new header ends by citing L2 design
  spec §8.1, which is titled "Torn reads are real, for two of the three files" and contains a table
  asserting `writeRunState` and `writeOwnerRecord` are bare `writeFile`, "Atomic? no". **This branch
  made both rename-published, so the cited section now contradicts the comment citing it.**
  Mitigated by the two sentences before the pointer, and updating that spec was outside this task's
  scope — but it is a live stale assertion one hop from a corrected comment.

WEAK, RECORDED FOR COMPLETENESS RATHER THAN PRESSED (reviewer's own framing): the header's "every
writer of those files now publishes by rename" is unqualified, while four TEST files write
`loop-state.json` with bare `writeFile` to build fixtures. The natural reading of a `src/` header is
"every writer in the product", and `observeFields.ts:9` is precise.

PRE-EXISTING STALE CITATIONS, DATED AND EXONERATED — this is the right way to book one:
`readObservedFile.test.ts:97` cites `fileStore.ts:535-536` and `zeroWrite.test.ts:6,92` cite
`:549-563`; at HEAD those live at `:617/:619` and `:630-645`. The reviewer checked `ee001ba` and
found they were ALREADY wrong at the merge-base (`:595`/`:617`) — L2-era drift, ~70 lines, this
branch's +13 only widened it. **Not this branch's doing, and it proved that rather than assuming it.**

⚠️ CANNOT VERIFY, carried forward: crash durability (unclaimed, zero `fsync`); real concurrent torn
reads (the redundancy of the retry rests on static enumeration, not an observed race); and one
full-suite run under mutation A showed the known `BUDGET_EXHAUSTED_REASON` flake — full name
captured first and matched to 遗留事项 2 line 75, did not reproduce, but one run cannot prove it is
not mutation-sensitive. The comment's actual claim ("all 51 tests in this file") was verified
directly and is unaffected.

Task 5: complete (commits 6377bf3..7a3490d, review clean, 0 Critical, 0 Important, 2 minors deferred)

ALL FIVE TASKS COMPLETE. Whole-branch review next.

=== WHOLE-BRANCH REVIEW (opus, mutation-driven, sandboxed with its own git init + initial commit) ===
Verdict: **ready with fixes.** 2 Important, 3 Minor. Eleven mutations, each a full-suite run.

**IT FOUND THE THING TASK REVIEWS STRUCTURALLY COULD NOT — and it is this branch's OWN declared
core risk, shipped unguarded.**

**Important 1 — the wiring to the unique temp-name generator is not pinned by any test.**
Spec §4.1 calls process-unique temp names 「本设计的核心风险」: `writeRunState` has NO lock, so a
SHARED FIXED temp name would MANUFACTURE a new torn-write source (A stages → B overwrites the
stage → A renames and publishes B's bytes → B renames and gets ENOENT). All three uniqueness tests
(`:1516`, `:1528`, `:1539`) call the exported `buildAtomicTempPath` DIRECTLY. **Nothing observes the
temp path the production write path actually uses.** Mutation M8 — replace `fileStore.ts:420` with a
fixed per-target name — **passes the entire suite, 441/441, twice.** Every inode test still passes
(rename is still used), both symlink tests pass, both residue tests pass, all byte tests pass, and
the three generator unit tests pass because the generator itself is untouched.
This is the handoff's own lesson — **「加一个成分和加它的覆盖是一件事，不是两件事」** — reappearing
one level up: Task 1 added the generator WITH its coverage, and this branch made the property live
at five sites WITHOUT pinning the wiring.
Scope note the reviewer made rather than ducking: the helper landed in `4bcde7b` (already on main),
but at `ee001ba` it had ZERO callers — dead code. **This branch is what made the property live, so
it is this branch's to pin.**
The third M8 run showed one failure — `runLoop.integration.test.ts > ... OWNER_LOST takeover-allowed
verdict without resuming execution`, starting at `:1258`, one of the four named
`BUDGET_EXHAUSTED_REASON` flakes, with that family's exact 20ms race signature. **Captured in full
and matched to the list before being classified. Not a kill.**

**Important 2 — this branch falsified L2's design spec and then pointed a NEW comment at it.**
`readObservedFile.ts:5` says "every writer of those files now publishes by rename" and cites
`2026-07-28-run-registry-design.md` §8.1 — a section whose writer-by-writer table (`:267-280`) still
asserts `writeOwnerRecord` and `writeRunState` are bare `writeFile`, **"Atomic? no"**, repeated at
`:476`. Both false as of this branch. The pointer sends the reader straight into the contradiction,
and L3 is the next consumer. That document already has an amendment convention in use.
(The code comment itself is CORRECT — the reviewer verified the `owner-record.json` writer
enumeration is complete.)

**Minor 1 — "cleanup must not replace the in-flight error" has no regression guard.** M9
(substitute `safeUnlink`, the exact thing spec §3.1 item 3 forbids) → **441/441 green.** The R2
failure test injects `EISDIR` on `rename`, and in that scenario `unlink` SUCCEEDS, so `safeUnlink`
never rethrows. Proven once by hand in Task 1's review; nothing encodes it.
**Minor 2** — crash residue (`SIGKILL` between write and rename) is never reclaimed. Reviewer found
NO functional breakage — unbounded litter, not a fault. Missing from spec §10.
**Minor 3** — unstated behaviour change: these five paths are no longer written THROUGH a symlink.

TRIAGE OF THE 7 CARRIED ITEMS: #1 must-fix (off-by-one, branch-introduced, contradicts a sibling
comment 30 lines away); #2 must-fix (= Important 2); #3 ship (content pinned by the sibling byte
test; folding it in would blur which property failed); #4 ship (Rule 11 — 48 `mkdtemp` and 0 `rm`
in that file; cleaning only the new 12 forks the convention silently); #5 **no residual — all 8
citations in the branch's new text re-resolved at HEAD, plus the hardcoded "51 tests" verified
against an actual count of 51**; #6 agree it ships unfixed BUT **promote the correction from this
ledger into `docs/handoff/handoff.md`**, or the next layer reads the false comment and never the
refutation; #7 ship (inside the byte-identical protected region — touching it would break the
branch's hardest constraint for a latent bug needing two concurrent failures).

**THE CROSS-TASK QUESTION, ANSWERED: exactly one surviving mutation, M8.** Everything else died
CLEANLY — one distinct test per call site (M1-M5), no test doing double duty, no overlap masking a
gap. M6 (helper writes target directly) killed 5. M7 (helper branches on existence) killed the 3
inode tests. M11 (`atomic: false` → `true`) killed 4 across 2 files. M10 (`unlink` + `writeFile`,
no rename) died only incidentally — consistent with §7.1a's own admission that neither criterion
kills that shape.

CLEAN, verified by execution and stated plainly: transfer region byte-identical (fail-loud extractor
requiring one match, a closing `^}`, and a minimum body length — `acquireOwnerTransferLock` came out
at 43 lines, so the 1-line-body trap did not fire), plus two more helpers and all 8 constants;
`src/registry/` comments-only; serialization identical at all five paths; **no consumer trips over
the temp files** (not in `RUN_MARKER_FILES`; `scanDir` never lists a recognized run's entries;
`ensureFreshRunDir` does not enumerate top-level entries; no `fs.watch`, no `createReadStream`, no
persistent `FileHandle`, no `.ino` dependence anywhere in `src/`); no over-claims anywhere.

ONE FIX WAVE DISPATCHED (all five findings in a single dispatch — per-finding fixers each rebuild
context and re-run suites, which cost the previous branch more than all its tasks combined).
It was told: prove each new test kills its target and paste its own output, never cite the dispatch
as evidence; and for Minor 1, **if the scenario cannot be built deterministically with real
filesystem means, say so and stop rather than ship a weaker assertion that passes for the wrong
reason** — a previous implementer made exactly that call on this branch and was right.

=== WHOLE-BRANCH FIX WAVE (commits 8bd689b, 02e1ccd, 1c96c8d, 99c4507) + SCOPED RE-REVIEW ===
Re-review verdict: **all five findings ADDRESSED. Ready to merge.** Same reviewer, resumed —
deliberately, because it is the one who found M8 survives, so its own mutation had to be the one
that now kills it. Baseline at `99c4507`: 443/443, typecheck 0, build 0.

- **Important 1 ADDRESSED.** Reviewer re-applied ITS OWN M8 (fixed per-target temp name at
  `fileStore.ts:420`) at `99c4507`: **2 failed | 441 passed (443)**, both failures the new tests.
  The mutation that passed the entire suite twice last round now dies.
  **The fix is TEST-ONLY and that is the correct shape** — the finding was a guard gap, not a
  defect; production code already consumed the generator, so a `src/` change would have been the
  wrong response. Controller flagged the test-only shape to the reviewer rather than assuming it
  was fine, and the reviewer ruled on it explicitly.
  Not vacuous: the prediction rule is EXECUTED
  (`expect(predictNextTempPath(buildAtomicTempPath(scratch))).toBe(buildAtomicTempPath(scratch))`),
  so a change to the name shape goes red at that line instead of silently mis-planting. Names
  claim only what is proved; the block comment frames the fixed name as motivation, not as a claim
  that multi-process safety is proven.
  **LATENT DEPENDENCY, recorded for the next layer**: the fixture relies on within-file sequential
  execution (no `it.concurrent`, no `sequence.concurrent` in `vitest.config.ts`) so the module
  counter cannot be raced. **Switching vitest to concurrent-within-file would silently break it —
  a config change away, not a present risk.**
- **Important 2 ADDRESSED.** The L2 amendment reaches BOTH targets (the reviewer re-derived the
  displaced line: its original `:476` is now `:499`, moved by the +23 lines above it), follows that
  document's existing `(a)`–`(i)` + `*Amended (x)*` convention exactly, and **`--numstat` is
  `31 0` — thirty-one insertions, ZERO deletions**, so the original "Atomic? no" rows stand as the
  recorded reason the ruling exists. History annotated, not rewritten.
  The reviewer re-derived the `fsync` claim itself rather than accepting it: zero calls repo-wide,
  four comment mentions.
- **Finding 3 ADDRESSED.** Arithmetic re-checked against the code: loop is `attempt <= maxAttempts`
  with the sleep guarded by `attempt < maxAttempts` → **3 reads, 2 sleeps, 2 retries.** The new
  clause agrees with `observeFields.ts:17-18`. The contradiction between the two sibling comments
  is gone.
- **Minor 1 ADDRESSED.** Reviewer re-applied its own M9 (`safeUnlink` in the catch): **2 failed**,
  with `EPERM` visibly replacing `EISDIR` — the exact masking spec §3.1 item 3 forbids. This
  mutation passed 441/441 before the fix wave.
- **Minor 2 / 3 ADDRESSED and CORRECTLY SCOPED** — the reviewer checked they were not inflated
  into defects. §10 item 4 says 「无界垃圾，不是故障」 with an explicit 「不要把它上报成缺陷」, which
  is the reviewer's own finding rather than an escalation of it; item 5 states the symlink change
  「不上调为风险」. It re-verified item 5's 「已核实」 by grep rather than trusting it — this
  project's own first lesson, applied to the document recording that lesson.

RULINGS ON THE FIX-WAVE IMPLEMENTER'S THREE DISCLOSURES:
1. **Coupled fixtures: ACCEPTABLE, and the coupling is narrower than the implementer feared.** The
   reviewer ran the mutations independently — under M9 the wiring is intact and the cleanup
   mutation is still caught; under M8 the cleanup code is intact and the wiring mutation is still
   caught. **Each property IS independently pinned.** Only the test NAME that goes red is coupled,
   and the failure messages are disjoint and unambiguous. Narrow regression in review ergonomics,
   not in coverage.
   **A verified decoupling exists and is recorded because it is expensive to rediscover**: plant a
   `0o444` regular file instead of a directory — `writeFile` → `EACCES` but `unlink` **succeeds**
   (unlink depends on the DIRECTORY's write bit, not the file's), so cleanup succeeds and that test
   dies under M8 alone. The reviewer measured this and explicitly did NOT ask for it.
2. **No executable guard on the L2 amendment: accepted.** A doc-lint for one amendment would be the
   speculative abstraction Rule 2 forbids. What is durable is the convention: **L2's `(a)`–`(j)`
   index is now that document's de facto drift ledger, and `(j)` is the first entry whose cause is
   a LATER BRANCH CHANGING THE CODE rather than a defect in the document.** If L3 falsifies anything
   else there, the form is `(k)`, annotated in place.
3. **Deviation from "one word": accepted, revert declined.** "One word" was the controller's
   estimate of the minimal fix, not a scope constraint. `i.e. 2 retries` names the number that must
   match `observeFields.ts:17-18`; reverting would restore the ambiguity that produced the defect.

ONE NEW MINOR FOUND IN THE FIX DIFF — self-inflicted, and exactly the class this branch polices:
`fileStore.test.ts:1882` still says "all **51** tests in this file green". True at `7a3490d`
(reviewer measured 51 last round); **the fix wave added 2 tests to that same file, so it is 53.**
A hardcoded quantity falsified by the branch's own edit — deferred item 5's class, one round later,
in the branch whose subject is comments that stopped being true. Substance holds; only the number
is stale. Dispatched to the fix-wave implementer with instructions to COUNT IT ITSELF rather than
take 53 from the dispatch.

DECIDED, not deferred: `final-fix-report.md` is NOT force-added. Consistent with this branch's
convention — only `progress.md` is force-added; task reports and review diffs are rebuildable and
deliberately skipped. The implementer correctly treated force-adding into a gitignored tree as the
controller's call.

=== RESIDUAL MINOR CLOSED (commit 818909a) + CLAIM RE-EARNED ===
The stale `51` → `53` fix landed alone. The implementer counted it TWO independent ways before
editing and took neither from the dispatch: runner (`Tests 53 passed (53)`) and a static count of
`it(` declarations (53).

**It then flagged that the number was fixed but the CLAIM was not re-measured** — the comment
asserts "deleting the early return leaves all 53 tests green" on the strength of a measurement
taken at 51 plus a read-only argument. Controller took that: **re-earn, do not inherit.** It
re-ran the mutation (deleted the `eligibleForContinuation` early return, `fileStore.ts:283-285`)
at 53 tests: **53/53 green, exit 0.** Revert confirmed by grep AND by
`git diff -- src/persistence/fileStore.ts` being empty. No edit was needed and none was made.
This is the branch's own lesson applied one last time, by the implementer to itself, unprompted.

Scope honestly stated by it: the mutation was run at FILE level (which is exactly what the comment
claims); whether some other file's test catches that early return is unmeasured, and the comment
does not claim otherwise.

DEFERRED, recorded, deliberately NOT fixed: several other comments and the spec carry measured
quantities (`441/443`, `48/48`, the 40-run note). **All currently true, nothing enforces them.**
Fixing them now would be speculative churn. What matters is the pattern: **this branch produced
TWO independent instances of a hardcoded quantity falsified by its own later edit, which makes it
a recurring failure mode rather than an accident.** Promoted to handoff 遗留事项 7 for L3.

=== BRANCH COMPLETE — 10 tasks-worth of work, 6 reviews, 3 fix rounds, 0 Critical throughout ===
Final: 29 files / 443 tests, typecheck 0, build 0. Five call sites atomic. Transfer path
byte-identical. `src/registry/` comments-only. Whole-branch review: **ready to merge.**

NOT DONE, DELIBERATELY, AND REQUIRING THE HUMAN:
- **push and merge** — both are the human's call and neither has been done.
- **workspace NOT deleted.** The skill says to delete the plan workspace once the final review is
  clean, but `CLAUDE.md`'s data-safety rule outranks it: the task reports and review diffs in this
  directory have not been seen by the human yet, and `progress.md` is the only force-added file.
  Deleting now would destroy the reports before anyone read them. **Ask first.**
- **worktree NOT removed.** Use `ExitWorktree`, not `git worktree remove`, and only after merge.
