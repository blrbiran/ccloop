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
- **D4 (cosmetic)**: stale line number in the plan — `finalizePendingOwnerTransfer`'s catch is
  at :542-546, not :539-543. Not worth amending the plan for; recorded here.

Task 1: judgement calls beyond the plan, all disclosed by the implementer and accepted —
serialize before entering the try (a stringify failure cannot leave a temp file); temp format
`.<basename>.<pid>.<n>.tmp`; both helpers placed next to `writeJsonFile` so §4.2's
"keep two, do not merge" comment sits where a reader would confuse them.
Task 1: implementer explicitly did NOT claim anything about intermediate visible state in any
test name or comment — the one over-claim this branch is most at risk of.

NOT YET DONE ON TASK 1: **no code review has been run.** The session that produced Task 1 hit
its context and budget ceiling immediately after. Per the project's standing rule, a task-level
review is mandatory and the whole-branch review at the end is non-skippable — the most valuable
defect of the previous round came from the latter. **Task 1 must be reviewed before Task 2 is
dispatched**, by a reviewer that reads the code rather than this ledger.

REMAINING: Tasks 2-5, each needing its own review, then a whole-branch review, then
verification-before-completion, then finishing-a-development-branch.
