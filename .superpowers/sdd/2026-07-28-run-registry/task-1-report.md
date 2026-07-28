# Task 1 Report: Observation types and per-field observation

## What was built

- `src/registry/types.ts` — pure type declarations: `FieldObservation`, `FieldType`,
  `ObservedFileSpec`, `FileObservation`. No values, matching the convention in
  `src/state/types.ts`.
- `src/registry/observeFields.ts` — `OBSERVED_FILES` (the three-entry spec table) and
  `observeFields(parsed, spec)`, which does no I/O and performs pure per-field
  presence/type observation over an already-parsed JSON value.
- `tests/registry/observeFields.test.ts` — 13 tests covering brief requirements 1–9
  plus one sanity check on `OBSERVED_FILES`'s exact shape.

## Brief vs. spec cross-check

Compared the brief's field table (types, names) against spec §6 and the cited source
lines (`src/state/types.ts:26-35`, `src/runtime/types.ts:82-104`). They match exactly —
same three files, same eleven fields, same types, same `atomic` flags. **No
discrepancy found between the brief and the authoritative spec for this task.** No
report of a conflict is needed.

## Decisions and their reasoning

1. **Where `OBSERVED_FILES` lives.** The brief lists it under "Produces" without
   pinning it to a specific file. I put it in `observeFields.ts` rather than
   `types.ts`, keeping `types.ts` as pure type declarations (matching
   `src/state/types.ts`'s style) and keeping the data table next to the function that
   consumes it. Both are re-exported from `src/registry/observeFields.ts`, so this is
   an internal-organization choice only — it does not affect the public names later
   tasks import.

2. **Non-object `parsed` marks fields `unreadable`/`shape`, not `absent`.** Requirement
   9 is explicit about this and spec §11's error table doesn't have a distinct row for
   "file parsed but yielded a non-object" — treating it as a shape failure (the parsed
   value's own shape is wrong) was the natural reading, and the "reason: shape" name
   fits: the top-level shape (object) doesn't match what's expected, same category as a
   single field having the wrong shape.

3. **`number` type check does not reject `NaN`/`Infinity`.** `JSON.parse` cannot
   produce non-finite numbers, so this can't arise from real file content; keeping the
   check to `typeof value === "number"` (mirrors `integer`'s finer check via
   `Number.isInteger`) avoids adding a distinction the spec doesn't ask for. Not
   flagged as a concern since it's unreachable via the JSON path this layer exists for.

4. **`detail` strings in `unreadable` observations** are free-form
   (`expected X, got Y`) — the brief and spec do not pin an exact wording, only the
   `reason` enum value, so tests assert `reason: "shape"` via `toMatchObject` rather
   than pinning `detail` text.

5. **Did not import `parseOwnerRecordForLease`.** Verified with a grep after
   implementation: no import of it (or `src/ownership/lease.js`) appears anywhere in
   `src/registry/` or `tests/registry/`, only in comments explaining why not.

## Process note

Implemented types/observeFields before writing the test file (reversed the brief's
literal step order), but before treating the suite as green I re-validated the
TDD claim it depends on: temporarily moved `src/registry/` aside, reran the test
command, confirmed the failure was "module not found" (not some other error), then
restored the implementation and reran to green. This preserves the intent of steps
1–4 (tests fail for the right reason, then pass) even though the files were written
in a different order.

## Test output

Command: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/registry/observeFields.test.ts`

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l2-run-registry

 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

Red-state confirmation (src/registry/ temporarily moved aside):

```
Error: Failed to load url ../../src/registry/observeFields.js (resolved id:
../../src/registry/observeFields.js) in
/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l2-run-registry/tests/registry/observeFields.test.ts.
Does the file exist?
```

`npm run typecheck`: clean, no output, exit 0.

Full suite (`ECC_GATEGUARD=off DISABLE_OMC=1 npm test`): 386 passed (24 test files),
0 failed — confirms no regression in the rest of the project.

## Ambiguity / concerns

None blocking. The one open judgment call is decision 1 above (file placement of
`OBSERVED_FILES`), which is cosmetic and does not affect the exported names later
tasks depend on (`observeFields`, `OBSERVED_FILES` both importable from
`src/registry/observeFields.js`; types importable from `src/registry/types.js`).
