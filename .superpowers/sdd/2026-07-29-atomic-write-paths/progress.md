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

NOT YET DONE ON TASK 1: **no code review has been run.** The session that produced Task 1 hit
its context and budget ceiling immediately after. Per the project's standing rule, a task-level
review is mandatory and the whole-branch review at the end is non-skippable — the most valuable
defect of the previous round came from the latter. **Task 1 must be reviewed before Task 2 is
dispatched**, by a reviewer that reads the code rather than this ledger.

REMAINING: Tasks 2-5, each needing its own review, then a whole-branch review, then
verification-before-completion, then finishing-a-development-branch.
