# Task 5 Debug Investigation — A-01 Harness ENOENT

## Status
- Classification: HARNESS_DEFECT
- Scope: Phase 1/2 investigation plus Phase 4 minimal harness fix record. No real Claude launch was performed.
- Real Claude launch: not performed.

## Exact Failure Readback
Source: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.superpowers/sdd/task-5-report.md`

Observed Task 5 invocation:
```text
npx --no-install tsx validation/v1/scripts/run-scenario.ts   --scenario A   --contract .../.validation-runs/contracts/A-01.json   --fixture .../.validation-runs/fixture-01   --run-dir .../.validation-runs/runs/A-01   --evidence-dir .../.validation-runs/evidence/A-01   --adapter-config .../examples/v1/claude-adapter-config.json
```

Recorded terminal error:
```text
ENOENT: no such file or directory, mkdir '/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/.validation-runs/evidence/A-01'
```

Recorded effect:
- wrapper aborted before controller launch
- run directory was never created
- harness evidence files (`invocation.json`, `artifacts.json`, `git.json`, `processes.json`, `observations.json`, `stdout.log`, `stderr.log`) were not produced

## Code Inspection
### `run-scenario.ts`
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/scripts/run-scenario.ts`

Relevant preflight flow now:
1. Parse args.
2. `assertFreshPath(parsed.evidenceDir, "evidenceDir")`
3. `assertFreshPath(parsed.runDir, "runDir")`
4. `mkdir(parsed.evidenceDir, { recursive: false })`
5. Create `stdout.log` / `stderr.log` in that leaf evidence directory.

Key observation:
- Step 4 creates only the leaf `.../evidence/A-01` directory.
- It does **not** create the missing parent `.../evidence` directory.
- Therefore a fresh path shape like `.validation-runs/evidence/A-01` fails with Node `ENOENT` whenever `.validation-runs/evidence/` itself does not already exist.

### Existing synthetic tests
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/validation/evidence.test.ts`

Existing Task 3 coverage already checks:
- existing `evidenceDir` is rejected without overwrite
- existing `runDir` is rejected without packaging stale data
- scenario/taskId mismatch fails before child launch
- early missing-contract failure still writes evidence once a fresh evidence directory is safely created

Missing coverage:
- no test currently asserts that a **fresh leaf evidence dir whose parent does not yet exist** should be creatable for the normal Task 5 path shape.

## Deterministic Reproduction
I reproduced the failure without launching real Claude by using the harness scripts only, with a fresh temp root and the normal Task 5 path pattern:
- create fixture into `<tmp>/fixture`
- render contract into existing parent `<tmp>/contracts/A-01.json`
- invoke `run-scenario.ts` with fresh leaf paths:
  - `--run-dir <tmp>/runs/A-01`
  - `--evidence-dir <tmp>/evidence/A-01`
- adapter config pointed at the normal Claude adapter config, but the failure happened before child launch

Reproduction result:
```json
{
  "exitCode": 1,
  "stdout": "",
  "stderr": "ENOENT: no such file or directory, mkdir '/var/.../evidence/A-01'
",
  "runDirExists": false,
  "evidenceDirExists": false,
  "evidenceParentExists": false,
  "contractParentExists": true
}
```

What this proves:
- the failure is independent of Claude availability or model calls
- the failure occurs before controller launch and before any run data exists
- the trigger is specifically the missing parent of the requested evidence leaf path

## Comparison With Working Parent-Creation Behavior
### `create-fixture.ts`
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/scripts/create-fixture.ts`

Working pattern:
```ts
await mkdir(dirname(repoPath), { recursive: true });
```
This explicitly creates the parent before copying into the leaf output path.

### `render-contract.ts`
File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/scripts/render-contract.ts`

Working pattern:
```ts
await mkdir(dirname(outputPath), { recursive: true });
```
This also guarantees the output parent exists before writing the contract file.

Contrast with `run-scenario.ts`:
```ts
await mkdir(parsed.evidenceDir, { recursive: false });
```
This assumes the parent already exists, unlike the other validation scripts.

## Precise Root-Cause Hypothesis
`run-scenario.ts` is inconsistent with the rest of the validation harness output scripts: it creates the **leaf evidence directory** directly with `mkdir(evidenceDir, { recursive: false })` after freshness checks, but never ensures the **parent evidence directory** exists. The documented Task 5 operator flow creates `.validation-runs/contracts/A-01.json` and then requests a fresh `.validation-runs/evidence/A-01` path, but it does not guarantee that `.validation-runs/evidence/` has already been created. On a fresh run ID, Node throws `ENOENT` on the leaf mkdir, so the harness aborts before child launch. This is a harness defect, not an environment issue.

## Minimal Failing Regression Test Needed
Add one focused `run-scenario CLI` regression in:
- `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/validation/evidence.test.ts`

Minimal test shape:
1. Create a temp root.
2. Create a disposable fixture with `createFixture()`.
3. Render scenario A contract into `<tmp>/contracts/A-01.json` where the contract parent exists.
4. Do **not** create `<tmp>/evidence/`.
5. Invoke `run-scenario.ts` with:
   - `--run-dir <tmp>/runs/A-01`
   - `--evidence-dir <tmp>/evidence/A-01`
   - a deterministic fake local adapter script so no real Claude is needed.
6. Expected behavior for the fixed harness: no preflight `ENOENT`; the evidence leaf path is created successfully and the wrapper proceeds far enough to write harness evidence/log files.

Why this is the minimal missing regression:
- it isolates only the parent-missing condition
- it uses the real wrapper path shape from Task 5
- it avoids real Claude/model calls
- it fails before any product behavior is relevant, so it directly targets the harness mkdir contract

## Conclusion
- Classification: `HARNESS_DEFECT`
- Confidence: high
- Reason: reproduced deterministically with no Claude launch, matched exact Task 5 ENOENT, and found clear inconsistency against the working parent-creation pattern already used by `create-fixture.ts` and `render-contract.ts`.

## Red/Green Execution Record
### Minimal failing regression added
- Added focused regression in `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/tests/validation/evidence.test.ts` for a fresh nested evidence path whose parent directory does not exist.
- Fake local adapter script keeps the run deterministic and avoids any Claude/model call.

### Red
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Result: FAIL
- Exact failing evidence:
  ```text
  ENOENT: no such file or directory, mkdir '/var/.../evidence/A-01'
  ```
- Interpretation: the new regression reproduced the same parent-missing failure on a fresh nested evidence path before controller launch.

### Minimal fix applied
- File: `/Users/biran/code/skills/loop/ccloop/.worktrees/evidence-first-v1/validation/v1/scripts/run-scenario.ts`
- Change: after freshness checks for `evidenceDir` and `runDir`, create only `dirname(parsed.evidenceDir)` with `mkdir(..., { recursive: true })`, then create the leaf `parsed.evidenceDir` with `mkdir(..., { recursive: false })`.
- Preserved guarantees:
  - existing leaf `evidenceDir` still fails via freshness check
  - existing `runDir` still fails via freshness check
  - `runDir` is still not precreated

### Green
- Command: `npm test -- --run tests/validation/evidence.test.ts`
- Result: PASS — `1` test file passed; `19` tests passed; `0` failed.
- Command: `npm test`
- Result: PASS — `13` test files passed; `98` tests passed; `0` failed.
- Command: `npm run typecheck`
- Result: PASS — `tsc --noEmit -p tsconfig.json` completed without errors.
- Command: `npm run build`
- Result: PASS — TypeScript compiled and regenerated `dist/cli.js` without errors.
- Command: `git diff -- src`
- Result: PASS — no product `src/` changes.

## Final Verification
- Focused suite: `npm test -- --run tests/validation/evidence.test.ts` — PASS (`19/19`)
- Full suite: `npm test` — PASS (`98/98`)
- Typecheck: `npm run typecheck` — PASS
- Build: `npm run build` — PASS
- Product scope: `git diff -- src` — empty
