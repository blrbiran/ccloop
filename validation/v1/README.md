# V1 Evidence-First Validation Operator Procedure

Run every command from the repository root on branch `evidence-first-v1`. This procedure uses only the current Task 1-3 TypeScript CLIs plus safe Claude CLI envelope checks. Do not overwrite existing paths, do not delete retained worktrees or historical evidence, and do not launch `claude -p` or the validation harness during preflight.

## Guardrails

- Use a fresh literal for every generated path. The examples below use `fixture-01`, `A-01`, `B-01`, `C-01`, `D-01`, and `E-01`.
- If any example path already exists, stop and choose a new literal such as `fixture-02` or `A-02`; then reuse that exact literal consistently in the matching contract, run, evidence, and review commands.
- Never overwrite or clean up `.validation-runs/`, retained worktrees, or earlier evidence.
- Before every real Claude-backed `run-scenario.ts` invocation, obtain explicit approval for that paid call.
- If Claude authentication needs interactive setup, stop and ask the user to run the exact login command themselves. Do not paste credentials into files, prompts, or shell history.
- Immediate stop conditions: `git.json.mainCheckoutChanged === true`, any uncontrolled descendant remains in `processes.json.survivorPids`, any artifact path escapes the run directory, or evidence is corrupt enough that terminal state, events, and required checks cannot be reconciled.
- Defect gate: if any scenario is confirmed `FAIL / PRODUCT_DEFECT`, preserve all evidence, stop the sequence immediately, and write a defect-specific follow-up plan before changing product code.

## Preflight

Install dependencies, run deterministic local checks, and confirm the Claude CLI envelope without making a model call:

```bash
npm ci
npm test
npm run typecheck
npm run build
claude --version
claude --help >/dev/null
npx --no-install tsx validation/v1/scripts/create-fixture.ts --output .validation-runs/fixture-01
```

If `.validation-runs/fixture-01` already exists, use a fresh literal instead of overwriting it. Example:

```bash
npx --no-install tsx validation/v1/scripts/create-fixture.ts --output .validation-runs/fixture-02
```

Verify fixture safety immediately after creation:

```bash
git -C .validation-runs/fixture-01 status --short
git -C .validation-runs/fixture-01 rev-list --count HEAD
find .validation-runs/fixture-01 -type l -print
```

Expected preflight result: tests, typecheck, and build succeed; `claude --version` prints a version; `claude --help` succeeds; fixture creation prints JSON; fixture status is empty; commit count is `1`; and `find` prints no symlinks.

If `npm ci` prints audit or vulnerability output, treat it as observational only. It does not authorize `npm audit fix`, `npm audit fix --force`, editing `package.json`, editing `package-lock.json`, or any other dependency change. Stop and report the finding instead.

## A-04 mechanical prepare (no paid call)

```bash
npx --no-install tsx validation/v1/scripts/prepare-a04.ts \
  --fixture .validation-runs/fixture-01 \
  --contract .validation-runs/contracts/A-04.json \
  --run-dir .validation-runs/runs/A-04 \
  --evidence-dir .validation-runs/evidence/A-04 \
  --adapter-config examples/v1/claude-adapter-config.json \
  --token-budget 550000 \
  --per-attempt-timeout-ms 600000 \
  --total-runtime-budget-ms 1200000 \
  --partial-recovery-window-ms 5000
```

Expected result:
- deterministic local checks pass;
- `.validation-runs/contracts/A-04.json` is created once;
- `.validation-runs/runs/A-04/` and `.validation-runs/evidence/A-04/` still do not exist;
- stdout prints an approval package containing contract identity, expected file scope, expected diff scope, exact `run-scenario.ts` command, and cost semantics.

`prepare-a04.ts` must not invoke Claude or create `review.json`.

## Evidence Files and Status Definitions

The deterministic harness writes these review inputs under each evidence directory:

- `invocation.json`
- `artifacts.json`
- `git.json`
- `processes.json`
- `observations.json`
- `review.json` after `finalize-review.ts`

Use the evidence collector's exact status vocabulary when reading `artifacts.json` and `observations.json`:

- `PRESENT`: the required artifact exists, stays inside the run directory, and parses or hashes successfully.
- `NOT_PRODUCED`: the phase completed without producing that artifact; this is an expected outcome for some scenarios.
- `NOT_RUN`: controller policy prevented that phase or required check from starting.
- `MISSING`: the artifact was required for the observed outcome but is absent.
- `INVALID`: the artifact exists but is malformed, unreadable, or escapes the run directory.

`artifacts.json` also contains `requiredChecks.status`, which uses the same vocabulary.

## Verdict and Diagnosis Definitions

`finalize-review.ts` accepts the following review values:

- `PASS`: controller state, artifacts, required checks, Git state, and cleanup behavior agree with the scenario expectation.
- `FAIL`: the evidence independently proves product behavior contradicted the contract or safety expectations.
- `INCONCLUSIVE`: the run produced insufficient or irreconcilable evidence for a trustworthy pass/fail conclusion.

Diagnosis values:

- `PRODUCT_DEFECT`: confirmed product bug or safety defect.
- `RUNTIME_VARIANCE`: Claude behavior varied, but the controller still behaved safely.
- `ENVIRONMENT_FAILURE`: machine, dependency, auth, or timing conditions prevented a trustworthy conclusion.
- `CONTRACT_GAP`: the current persisted evidence cannot answer the question the scenario asks.
- `null`: no extra diagnosis is needed.

## Scenario Order

Run scenarios strictly in this order: `A → B → C → D → E`.

- Run `A` first to validate the success path.
- Run `B` second to validate the pre-verification human gate and retained-worktree handoff.
- Calibrate `C` only after observing real `A` and `B` event timestamps.
- Run `D` only after using the same evidence-based timeout method used for `C`.
- Run `E` last to confirm deterministic required-check failure handling.

Every invocation below assumes the fixture literal is `fixture-01`. If you had to choose a fresh fixture literal, replace it consistently in every command.

## Scenario A - Successful End-to-End Run

Render the contract:

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario A \
  --repo .validation-runs/fixture-01 \
  --output .validation-runs/contracts/A-01.json
```

Approval checkpoint before the paid call: show the user `scenario A`, `1 attempt`, `300000ms per-attempt timeout`, `600000ms total runtime budget`, and `50000 token budget`. Do not continue without explicit approval.

Run the scenario once with fresh paths:

```bash
npx --no-install tsx validation/v1/scripts/run-scenario.ts \
  --scenario A \
  --contract .validation-runs/contracts/A-01.json \
  --fixture .validation-runs/fixture-01 \
  --run-dir .validation-runs/runs/A-01 \
  --evidence-dir .validation-runs/evidence/A-01 \
  --adapter-config examples/v1/claude-adapter-config.json
```

Finalize exactly once after reviewing the evidence:

```bash
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir .validation-runs/evidence/A-01 \
  --verdict PASS \
  --diagnosis null \
  --summary "Controller state, required checks, verifier evidence, Git diff, and cleanup agree"
```

Expected candidate: exit `0`, terminal state `succeeded`, required checks pass, verification is present, fixture checkout stays clean, and the attempt worktree is removed.

## Scenario B - Pre-Verification Human Gate

Render the contract:

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario B \
  --repo .validation-runs/fixture-01 \
  --output .validation-runs/contracts/B-01.json
```

Approval checkpoint before the paid call: show `scenario B`, `1 attempt`, `300000ms per-attempt timeout`, `600000ms total runtime budget`, and `50000 token budget`. Do not continue without explicit approval.

Run the scenario once with fresh paths:

```bash
npx --no-install tsx validation/v1/scripts/run-scenario.ts \
  --scenario B \
  --contract .validation-runs/contracts/B-01.json \
  --fixture .validation-runs/fixture-01 \
  --run-dir .validation-runs/runs/B-01 \
  --evidence-dir .validation-runs/evidence/B-01 \
  --adapter-config examples/v1/claude-adapter-config.json
```

Use only the retained run directory plus Git commands to judge handoff sufficiency. Do not modify or remove the retained worktree.

Finalize exactly once after inspection:

```bash
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir .validation-runs/evidence/B-01 \
  --verdict PASS \
  --diagnosis null \
  --summary "Denylist gate blocked verification, retained worktree is inspectable, and handoff facts are sufficient"
```

Expected candidate: exit `2`, terminal state `blocked_waiting_human`, stop reason identifies `restricted.txt`, worktree remains, execution, diff, and log are present, verification and required checks are `NOT_RUN`, and the main fixture checkout remains clean.

## Scenarios C and D - Timeout Calibration and Boundary Checks

Do not guess timeouts and do not edit product code to force an outcome. Calibrate from real `A` and `B` event timestamps.

Print the timestamped events for `A-01` and `B-01`:

```bash
python3 - <<'PY'
import json
from pathlib import Path
for run_id in ("A-01", "B-01"):
    print(f"## {run_id}")
    for line in Path(f".validation-runs/runs/{run_id}/events.jsonl").read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            print(f"{row.get('at', 'NO_AT')}\t{row.get('type', 'UNKNOWN')}")
PY
```

Choose a timeout that is greater than observed planning time but shorter than the expected full `C` execution, then record the calculation in a fresh note under `.validation-runs/evidence/calibration/`. Example:

```bash
mkdir -p .validation-runs/evidence/calibration
tee .validation-runs/evidence/calibration/C-01-timeout.txt >/dev/null <<'EOF'
Observed A/B planning timestamps:
- A-01: <fill in timestamps>
- B-01: <fill in timestamps>
Chosen C timeout: <positive integer>ms
Reason: greater than observed planning time, shorter than expected full execute time.
EOF
```

Render `C` with the chosen timeout:

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario C \
  --repo .validation-runs/fixture-01 \
  --timeout-ms <C_TIMEOUT_MS> \
  --output .validation-runs/contracts/C-01.json
```

Approval checkpoint before the paid call: show `scenario C`, `1 attempt`, `per-attempt timeout <C_TIMEOUT_MS>`, `600000ms total runtime budget`, `3000ms partial outcome recovery window`, and `50000 token budget`. Do not continue without explicit approval.

Run `C` once with fresh paths:

```bash
npx --no-install tsx validation/v1/scripts/run-scenario.ts \
  --scenario C \
  --contract .validation-runs/contracts/C-01.json \
  --fixture .validation-runs/fixture-01 \
  --run-dir .validation-runs/runs/C-01 \
  --evidence-dir .validation-runs/evidence/C-01 \
  --adapter-config examples/v1/claude-adapter-config.json
```

Finalize exactly once after review, using the evidence-backed conclusion:

```bash
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir .validation-runs/evidence/C-01 \
  --verdict <PASS|FAIL|INCONCLUSIVE> \
  --diagnosis <PRODUCT_DEFECT|RUNTIME_VARIANCE|ENVIRONMENT_FAILURE|CONTRACT_GAP|null> \
  --summary "<one-line evidence-backed C conclusion>"
```

If `C` misses the intended timeout window, classify `INCONCLUSIVE / ENVIRONMENT_FAILURE`. Do not silently rerun; choose a new literal such as `C-02`, re-render, and obtain a new approval.

Choose and record a `D` timeout with the same evidence-based method, then render `D`:

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario D \
  --repo .validation-runs/fixture-01 \
  --timeout-ms <D_TIMEOUT_MS> \
  --output .validation-runs/contracts/D-01.json
```

Approval checkpoint before the paid call: show `scenario D`, `1 attempt`, `per-attempt timeout <D_TIMEOUT_MS>`, `600000ms total runtime budget`, `3000ms partial outcome recovery window`, and `50000 token budget`. Do not continue without explicit approval.

Run `D` once with fresh paths:

```bash
npx --no-install tsx validation/v1/scripts/run-scenario.ts \
  --scenario D \
  --contract .validation-runs/contracts/D-01.json \
  --fixture .validation-runs/fixture-01 \
  --run-dir .validation-runs/runs/D-01 \
  --evidence-dir .validation-runs/evidence/D-01 \
  --adapter-config examples/v1/claude-adapter-config.json
```

Finalize exactly once after review. Default to `INCONCLUSIVE / CONTRACT_GAP` unless independent evidence proves a recoverable result existed and should have been persisted:

```bash
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir .validation-runs/evidence/D-01 \
  --verdict INCONCLUSIVE \
  --diagnosis CONTRACT_GAP \
  --summary "Current persisted evidence cannot distinguish no work from lost recoverable work"
```

Expected `D` candidate: plan present, execution, diff, and log are `NOT_PRODUCED`, verification and required checks are `NOT_RUN`, the terminal outcome is non-success, and the main fixture checkout stays clean. Do not infer that the removed worktree contained no changes.

## Scenario E - Deterministic Required-Check Failure

Render the contract:

```bash
npx --no-install tsx validation/v1/scripts/render-contract.ts \
  --scenario E \
  --repo .validation-runs/fixture-01 \
  --output .validation-runs/contracts/E-01.json
```

Approval checkpoint before the paid call: show `scenario E`, `1 attempt`, `300000ms per-attempt timeout`, `600000ms total runtime budget`, and `50000 token budget`. Do not continue without explicit approval.

Run the scenario once with fresh paths:

```bash
npx --no-install tsx validation/v1/scripts/run-scenario.ts \
  --scenario E \
  --contract .validation-runs/contracts/E-01.json \
  --fixture .validation-runs/fixture-01 \
  --run-dir .validation-runs/runs/E-01 \
  --evidence-dir .validation-runs/evidence/E-01 \
  --adapter-config examples/v1/claude-adapter-config.json
```

Finalize exactly once after review, using the evidence-backed conclusion:

```bash
npx --no-install tsx validation/v1/scripts/finalize-review.ts \
  --evidence-dir .validation-runs/evidence/E-01 \
  --verdict <PASS|FAIL|INCONCLUSIVE> \
  --diagnosis <PRODUCT_DEFECT|RUNTIME_VARIANCE|ENVIRONMENT_FAILURE|CONTRACT_GAP|null> \
  --summary "<one-line evidence-backed E conclusion>"
```

Expected candidate: deterministic required-check failure controls the result even if the executor claims completion; attempts remain distinguishable.

## No-Cleanup Rule

After any scenario finishes:

- do not delete retained worktrees;
- do not delete historical run or evidence directories;
- do not reuse a previous contract, run, or evidence path;
- do not clean up before a review is written;
- do not remove evidence after `FAIL`, `INCONCLUSIVE`, or `blocked_waiting_human` outcomes.

## Immediate Stop Checklist

Stop the sequence immediately and preserve the evidence if any of the following appears in the derived evidence files or direct Git checks:

- `git.json.mainCheckoutChanged` is `true`;
- `processes.json.survivorPids` is non-empty;
- any artifact or observation is `INVALID` because a path escaped the run directory;
- event, state, required-check, and artifact records are too corrupt to reconcile into one trustworthy conclusion;
- any scenario is confirmed `FAIL / PRODUCT_DEFECT`.
