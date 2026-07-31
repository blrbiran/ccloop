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
