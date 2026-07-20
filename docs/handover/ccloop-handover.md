# ccloop Handover

> Updated: 2026-07-20
> Scope: post-validation handover for the accepted evidence-first V1 A/B/C/D/E outcomes on `main`, plus the current repo/plugin state needed for a clean takeover.
> Snapshot rule: verify every status claim against Git and the filesystem before acting. Current code, committed branch state, and immutable evidence override this document if they differ.

## Executive Summary for Next Agent

1. `main` is at `b5d717f` (`update handover doc`) and the working tree is currently clean.
2. The accepted real-run review set on `main` is now: `A-04-08 PASS`, `B-02 PASS`, `C-05 PASS`, `D-01 INCONCLUSIVE / CONTRACT_GAP`, `E-01 PASS`.
3. The critical `run-scenario.ts` macOS `/var` vs `/private/var` zero-exit / no-artifact bug is fixed on `main` (`34eff33`).
4. `B-01` is preserved but superseded because ECC fact-forcing interfered with the intended human-gate path.
5. `C-01` and `C-02` are preserved but superseded because `.omc/**` writes from oh-my-claudecode caused allowlist misses.
6. `C-03` and `C-04` are preserved but superseded because their timeouts were too short to prove the full partial-progress recovery boundary.
7. `C-05` is the accepted Scenario C reference run: timeout occurred after both `src/partial-note.txt` and `src/counter.js` changes were durably captured.
8. `D-01` remains intentionally `INCONCLUSIVE / CONTRACT_GAP`; do not silently reinterpret it as PASS or FAIL.
9. The fixture checkout remains `.validation-runs/fixture-01` at HEAD `becebbabc29ece8bb47f1c93e92479cf20e485b1`, still clean after all accepted runs.
10. Future validation-sensitive runs should assume `ECC_GATEGUARD=off`; OMC sometimes needs stronger bypass than `DISABLE_OMC=1` (temporary plugin disable/enable or `claude --bare`).

## 10-line Handover Executive Summary

1. `main` HEAD: `b5d717f`, clean working tree.
2. Accepted results: `A-04-08 PASS`, `B-02 PASS`, `C-05 PASS`, `D-01 INCONCLUSIVE / CONTRACT_GAP`, `E-01 PASS`.
3. `run-scenario.ts` canonical-path alias bug is fixed on `main`.
4. `B-01`, `C-01`, `C-02`, `C-03`, and `C-04` remain preserved but are superseded by later accepted runs.
5. Fixture checkout: `.validation-runs/fixture-01`, HEAD `becebbabc29ece8bb47f1c93e92479cf20e485b1`, still clean.
6. Backup branch `backup/evidence-first-v1-before-memory-history-cleanup` still exists and must not be pushed or deleted.
7. Stashes remain as soft historical signals only.
8. Default validation-run posture now includes `ECC_GATEGUARD=off`; OMC may need temporary plugin disable or `claude --bare`.
9. `oh-my-claudecode@omc` is currently enabled again after validation.
10. Next agent should focus on truthful docs/backlog updates; any new paid run is opt-in only.

## 1. Current Repository State

### Main checkout

- Path: `/Users/biran/code/skills/loop/ccloop`
- Branch: `main`
- HEAD: `b5d717f` (`update handover doc`)
- `origin/main` currently matches `b5d717f`.
- Post-validation fix/preference commits on `main` include:
  - `34eff33` `fix: run run-scenario through canonical path aliases`
  - `e2896cc` `chore: record run-scenario alias guard learning`
  - `9b4f17d` `chore: record ECC GateGuard preference`
  - `30e171f` `chore: record OMC disable preference`
  - `337ae40` `update openwolf file`
  - `b5d717f` `update handover doc`
- `oh-my-claudecode@omc` was manually re-enabled after the Scenario C experiments and is currently enabled.

### Backup branch and sensitive history

- Local backup branch: `backup/evidence-first-v1-before-memory-history-cleanup`
- It preserves the pre-rewrite branch state, including commits `73fa00e` and `e0d3fb1`, which temporarily contained `.wolf/memory.md`.
- `main` and `evidence-first-v1` do not contain `.wolf/memory.md` in their reachable history.
- Never push or publish the backup branch. Do not delete it without explicit approval.

### Stashes

Current retained stashes:

```text
stash@{0}: On main: pre-local-merge-evidence-first-v1-2026-07-18
stash@{1}: On main: pre-merge local changes 2026-07-16
```

- Treat them as soft historical signals only.
- No stash deletion is authorized.

### Preserved verification checkouts

Current linked preserved verification checkouts seen during this session:

```text
/private/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-a04-main-gKmjWQ  34eff33 (detached HEAD)
/private/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-a04-main-n5PqL6  b03cbcc (detached HEAD)
/private/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-a04-main-UlypVh  b03cbcc (detached HEAD)
/private/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-a04-main-vIFE97  34eff33 (detached HEAD)
/private/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-a04-main-yqN4eP  ffd8447 (detached HEAD)
```

- These are preserved historical verification checkouts from successful non-paid A-04 preparation steps.
- Keep them unless a human explicitly asks to clean them up.

### Validation artifacts on main

Current operator-checkout validation directories:

```text
.validation-runs/contracts/
  A-04.json
  A-04-02.json
  A-04-03.json
  A-04-04.json
  A-04-05.json
  A-04-06.json
  A-04-07.json
  A-04-08.json
  B-01.json
  B-02.json
  C-01.json
  C-02.json
  C-03.json
  C-04.json
  C-05.json
  D-01.json
  E-01.json

.validation-runs/runs/
  A-04-08/
  B-01/
  B-02/
  C-01/
  C-02/
  C-03/
  C-04/
  C-05/
  D-01/
  E-01/

.validation-runs/evidence/
  A-04-08/
  B-01/
  B-02/
  C-01/
  C-02/
  C-03/
  C-04/
  C-05/
  D-01/
  E-01/
  calibration/
```

- Preserve all historical run and evidence directories.
- Accepted final review files exist for:
  - `.validation-runs/evidence/A-04-08/review.json`
  - `.validation-runs/evidence/B-02/review.json`
  - `.validation-runs/evidence/C-05/review.json`
  - `.validation-runs/evidence/D-01/review.json`
  - `.validation-runs/evidence/E-01/review.json`
- Calibration notes currently exist for Scenario C under `.validation-runs/evidence/calibration/`.
- A diagnostic fixture `.validation-runs/fixture-diag` also exists from debugging; it is not part of the accepted evidence set.

### Fixture checkout

- Accepted fixture literal: `.validation-runs/fixture-01`
- Current fixture HEAD: `becebbabc29ece8bb47f1c93e92479cf20e485b1`
- The fixture remained clean across the accepted A/B/C/D/E runs.

## 2. Accepted Evidence Set

### Scenario A

- Accepted run: `A-04-08`
- Review: `.validation-runs/evidence/A-04-08/review.json`
- Final verdict: `PASS`
- Summary: controller state, required checks, verifier evidence, Git state, usage evidence, and cleanup agree with the Scenario A success expectation.

### Scenario B

- Accepted run: `B-02`
- Review: `.validation-runs/evidence/B-02/review.json`
- Final verdict: `PASS`
- Summary: denylist gate blocked verification, retained worktree is inspectable, and handoff facts are sufficient.

### Scenario C

- Accepted run: `C-05`
- Review: `.validation-runs/evidence/C-05/review.json`
- Final verdict: `PASS`
- Summary: timeout interrupted execute after both `src/partial-note.txt` and `src/counter.js` changes were persisted in execution and diff artifacts, so partial progress is recoverable while the fixture remained clean.

### Scenario D

- Accepted run: `D-01`
- Review: `.validation-runs/evidence/D-01/review.json`
- Final verdict: `INCONCLUSIVE / CONTRACT_GAP`
- Summary: current persisted evidence records a non-success timeout boundary but cannot distinguish no work from lost recoverable execute progress after the interrupted D attempt.

### Scenario E

- Accepted run: `E-01`
- Review: `.validation-runs/evidence/E-01/review.json`
- Final verdict: `PASS`
- Summary: only `src/counter.js` changed, deterministic `npm test` failure was captured in execution evidence, and required-check evidence controls the Scenario E conclusion while fixture and main remained clean.

## 3. Preserved but Superseded Runs

These runs remain important historical evidence, but they are not the accepted final answer for their scenario family:

- `B-01` — failed because ECC fact-forcing interfered with the intended human-gate flow.
- `C-01` — `INCONCLUSIVE / ENVIRONMENT_FAILURE`; `.omc/**` allowlist interference.
- `C-02` — `INCONCLUSIVE / ENVIRONMENT_FAILURE`; `.omc/**` allowlist interference persisted even with `DISABLE_OMC=1`.
- `C-03` — `INCONCLUSIVE / ENVIRONMENT_FAILURE`; `60000ms` timeout exhausted before any execution artifact.
- `C-04` — `INCONCLUSIVE / ENVIRONMENT_FAILURE`; `70000ms` timeout captured only the first partial-progress step (`src/partial-note.txt`).

## 4. Important Fixes and Learnings Landed on Main

### `run-scenario.ts` canonical-path fix

- `validation/v1/scripts/run-scenario.ts` now canonicalizes `process.argv[1]` through `realpath` before comparing it against the module path.
- This fixes the prior macOS `/var` vs `/private/var` zero-exit / no-artifact bug that affected early real Scenario A attempts.
- Regression coverage was added to `tests/validation/evidence.test.ts`.

### Validation-run defaults learned during this cycle

- Default validation-sensitive commands to `ECC_GATEGUARD=off`.
- `DISABLE_OMC=1` alone was not sufficient to stop `.omc/**` writes during Scenario C.
- The reliable OMC workaround for validation-sensitive real runs was temporary plugin disable / re-enable, or `claude --bare` when plugin/skill/hook behavior is unnecessary.
- OMC was re-enabled after the experiments completed.

### Collaboration defaults

- Use Chinese when discussing ccloop unless explicitly asked otherwise.
- Proactive local commits are allowed when they unblock validation progress.

## 5. Current V1 Position

ccloop V1 is a contract-first TypeScript CLI for one code-task loop in one repository. It uses L2 assisted autonomy and prioritizes controllability, independent verification, and explicit stopping over maximum autonomy.

V1 currently has accepted evidence for:

- Scenario A success path (`PASS`)
- Scenario B pre-verification human gate (`PASS`)
- Scenario C partial-progress recoverability (`PASS`)
- Scenario D interrupted-execute ambiguity (`INCONCLUSIVE / CONTRACT_GAP`)
- Scenario E deterministic required-check failure control (`PASS`)

## 6. Governing Boundaries That Still Matter

- exercise real Claude behavior before adding automation;
- change product code only for a confirmed `FAIL / PRODUCT_DEFECT`;
- require explicit approval before every real Claude invocation;
- use fresh contract, run, and evidence paths for every invocation;
- never retry a real scenario automatically;
- the executor cannot declare final success;
- controller policy, required checks, and independent verifier evidence determine success;
- `blocked_waiting_human` is terminal in V1; there is no resume;
- never reuse, delete, or overwrite historical `.validation-runs/` evidence.

## 7. Known Limitations

- `D-01` remains intentionally `INCONCLUSIVE / CONTRACT_GAP`.
- Historical A-01 through A-03 usage cannot be reconstructed with the new evidence type.
- `claudeChildExited` remains `NOT_OBSERVABLE` unless a tracked descendant PID proves it.
- No resume, reconciliation, scheduler, daemon, queue, lease, heartbeat, watchdog, or multi-task coordination exists.
- OMC interference can still affect validation-sensitive runs unless the stronger bypass strategy is used.

## 8. Recommended Next-Step Focus for Another Agent

A takeover agent should now assume the core A/B/C/D/E evidence-first V1 validation goal is substantially complete.

Best next-step directions are:

1. **Truthful docs / backlog update pass**
   - Update README, handover references, and backlog/plan surfaces so they reflect the accepted A/B/C/D/E outcomes.
2. **Optional deeper D analysis only if explicitly requested**
   - Keep `D-01` as `INCONCLUSIVE / CONTRACT_GAP` unless the human explicitly wants more experimentation.
3. **No further paid runs without fresh approval**
   - Any additional real Claude invocation remains opt-in only.

## 9. Exact Takeover Procedure

Start in the repository root and inspect without cleaning:

```bash
git status --branch --short
git log -8 --oneline --decorate
git worktree list
git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'
git stash list
find .validation-runs -maxdepth 2 -type d | sort
```

Read in order:

1. `docs/handover/ccloop-handover.md`
2. `validation/v1/README.md`
3. Accepted review files for `A-04-08`, `B-02`, `C-05`, `D-01`, and `E-01`
4. Calibration notes under `.validation-runs/evidence/calibration/`
5. `validation/v1/scripts/run-scenario.ts`
6. `tests/validation/evidence.test.ts`
7. `validation/v1/lib/a04.ts`

## 10. Useful Commands

```bash
# Current repo state
git -C /Users/biran/code/skills/loop/ccloop status --short
git worktree list
git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'
git stash list

# Final accepted review map
python3 - <<'PY'
import json
from pathlib import Path
for run_id in ('A-04-08','B-02','C-05','D-01','E-01'):
    data = json.loads(Path(f'.validation-runs/evidence/{run_id}/review.json').read_text())
    print(run_id, data['scenarioVerdict'], data['diagnosis'])
PY

# Focused verification around the runtime/evidence surface
npm test -- --run tests/validation/evidence.test.ts
npm test -- --run tests/validation/prepareA04.test.ts
npm run typecheck
npm run build
```

## 11. Do Not Do These on Takeover

- Do not run `git clean`, `git reset --hard`, broad `git restore`, or broad `git checkout`.
- Do not delete `.validation-runs/`, preserved run/evidence directories, preserved verification checkouts, backup branches, or stashes without explicit approval.
- Do not push the backup branch.
- Do not rewrite accepted historical `review.json` files.
- Do not silently reinterpret `D-01` as PASS or FAIL.
- Do not treat superseded intermediate runs (`B-01`, `C-01`, `C-02`, `C-03`, `C-04`) as the accepted result when later accepted review files exist.
- Do not begin V2 design until the human explicitly changes priority from truthful V1 evidence handling.
