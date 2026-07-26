# Task 1 Report: The `leaseAffirmedAt` field, written `null` by everyone

## Summary

Implemented exactly as specified in the brief. Added `leaseAffirmedAt: string | null` to
`OwnerRecord` in `src/runtime/types.ts`, and made all three non-heartbeat writers
(`applyOwnerEpochTransfer` in `src/ownership/ownerController.ts`, `buildInitialOwnerRecord`
in `src/controller/runLoop.ts`, and the resume claim record in `src/controller/resumeLoop.ts`)
write `null` explicitly. No lease-reading logic was added — this task is data-shape only.

## Files changed

- `src/runtime/types.ts` — added `leaseAffirmedAt: string | null` to `OwnerRecord`, with the
  §5.0 doc comment from the brief.
- `src/ownership/ownerController.ts` — `applyOwnerEpochTransfer`'s `nextOwnerRecord` now sets
  `leaseAffirmedAt: null` (an owner transfer clears any prior lease rather than carrying it
  forward — see test comment).
- `src/controller/runLoop.ts` — `buildInitialOwnerRecord` now sets `leaseAffirmedAt: null`.
- `src/controller/resumeLoop.ts` — the claim record (`nextOwnerRecord` built in `resumeLoop`)
  now sets `leaseAffirmedAt: null`.
- `tests/ownership/lease.test.ts` (new) — the brief's test verbatim: an owner transfer clears
  the lease rather than carrying it forward.
- `tests/controller/resumeLoop.integration.test.ts` — added the brief's Step 6 assertion
  (`expect(owner.leaseAffirmedAt).toBeNull()`) to the first test. `seedEligibleRun`, which
  writes the owner record as raw JSON, was left untouched as instructed — verified by reading
  it: it constructs a plain object literal passed to `JSON.stringify`, not typed as
  `OwnerRecord`, so it is not a compile-error site and correctly stays field-less for Task 6.
- `tests/controller/resumeLoop.gate.test.ts`,`tests/ownership/ownerController.test.ts`,
  `tests/persistence/fileStore.test.ts` — **not listed in the brief's Step 7 git-add command**,
  but required by Step 5: `npm run typecheck` rejected every typed `OwnerRecord` (or
  `OwnershipEvaluationInput`/gate-input) construction site in these three files that didn't
  set the new required field. Each site got exactly `leaseAffirmedAt: null,` added — no other
  line touched. I included these three files in the commit since leaving them out would have
  left `npm run typecheck` and `npm run build` red, violating the global constraint that the
  suite/typecheck/build must stay green.

## TDD evidence

**RED** — `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts`
after writing only the test file (before touching any source):

```
 ❯ tests/ownership/lease.test.ts (1 test | 1 failed) 15ms
   × leaseAffirmedAt is written only by the heartbeat > an owner transfer clears the lease rather than carrying it forward 9ms
     → expected '2026-07-26T10:00:00.000Z' to be null
```

Note: the brief's Step 2 predicted a compile-time failure ("`leaseAffirmedAt` does not exist
on type `OwnerRecord`"). This repo's `npm test` runs vitest, which transpiles with esbuild and
does not type-check, so the same underlying defect (the writer doesn't yet null the field)
surfaced as a runtime assertion failure instead of a `tsc` error. The failure is for the
correct reason either way: `applyOwnerEpochTransfer` was still spreading the prior
`leaseAffirmedAt` forward instead of nulling it.

**GREEN** — after implementing Steps 3–4 (field + three writers) and Step 6 (pinned resume
assertion):

```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/ownership/lease.test.ts tests/controller/resumeLoop.integration.test.ts
...
 ✓ tests/ownership/lease.test.ts (1 test) 2ms
 ✓ tests/controller/resumeLoop.integration.test.ts (4 tests) 602ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
```

Full suite:

```
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
...
 Test Files  18 passed (18)
      Tests  275 passed (275)
```

Baseline was 17 files / 274 tests; expected end state was 18 files / 275 tests (one new file,
one new test). Matches.

`npm run typecheck` — after fixing the field/writers, the first run surfaced 70 compile
errors across `tests/controller/resumeLoop.gate.test.ts`, `tests/ownership/ownerController.test.ts`,
and `tests/persistence/fileStore.test.ts` (every typed `OwnerRecord`/`OwnershipEvaluationInput`
construction site missing the now-required field). Fixed each site with `leaseAffirmedAt: null,`
only — final run is clean (`tsc --noEmit -p tsconfig.json`, no output, exit 0).

`npm run build` — clean (`tsc -p tsconfig.json` + dist emit, no errors).

## Self-review

- **Completeness**: all 7 brief steps done. Type field added with the exact doc comment.
  All three writers null the field. New test file matches the brief verbatim. Pinned
  assertion added exactly as specified, with its stated caveat about Task 11 preserved as a
  comment note in this report (not needed in the test file itself since the brief's given
  comment already explains it).
- **Quality**: every diff hunk is a single-line addition (`leaseAffirmedAt: null,`) at an
  existing field-list tail, matching the surrounding style (two-space indent, trailing comma,
  no reformatting of neighboring lines).
- **Discipline (YAGNI)**: no lease-reading logic, no heartbeat logic, no changes to
  `acquireOwnerTransferLock`/`parsePid`/the lock-record format (constraint 7) — untouched.
  Did not "fix" or reformat any of the 20 near-identical `initialOwnerRecord` blocks in
  `fileStore.test.ts` beyond adding the one required line; resisted the urge to consolidate
  them into a shared helper since that's out of scope for this task (Rule 3: surgical
  changes only).
- **Testing**: TDD order followed (failing test written and confirmed failing before any
  source change). The pinned resume-integration assertion is a real behavioral check, not a
  tautology — it fails today if `resumeLoop.ts`'s claim record ever stops setting
  `leaseAffirmedAt: null` explicitly. `seedEligibleRun`'s raw-JSON write was verified by
  reading the function body, not assumed.
- **Discrepancy flagged (fail loud per Rule 12)**: the brief's Step 7 `git add` file list
  under-specifies what's needed to keep the build/typecheck green — it omits
  `tests/controller/resumeLoop.gate.test.ts`, `tests/ownership/ownerController.test.ts`, and
  `tests/persistence/fileStore.test.ts`, all of which required a one-line fix each per Step 5's
  own instruction ("fix each"). I included them in the commit rather than leaving the tree
  red; flagging here since the brief's own file list didn't anticipate this ripple, so a
  reviewer isn't surprised by the extra files in the commit.

## Concerns

None blocking. The one thing worth a reviewer's eye: the brief's git-add list vs. what
actually needed to change (documented above) — I resolved it by following Step 5's explicit
instruction over Step 7's file list, since Step 5 is the actual requirement ("must be green")
and Step 7 is a convenience command written before the full fallout was known.
