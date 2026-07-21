# ccloop Handover

> Updated: 2026-07-21
> Scope: post-validation handover for the accepted evidence-first V1 A/B/C/D/E outcomes on `main`, plus the current repo and artifact state needed for safe takeover.
> Snapshot rule: verify every status claim against Git, the filesystem, and accepted immutable evidence before acting.

## Executive Summary for Next Agent

1. Verify the current `main` HEAD with Git before acting; this handover reflects the post-docs/backlog truth-alignment baseline rather than a permanent branch snapshot.
2. Accepted results remain `A-04-08 PASS`, `B-02 PASS`, `C-05 PASS`, `D-01 INCONCLUSIVE / CONTRACT_GAP`, `E-01 PASS`.
3. `D-01 review.json` remains immutable; any reinterpretation belongs in a separate `review-reclassified.json`.
4. The D-boundary implementation is already merged on `main`; no new paid run is implied by this docs pass.
5. Backup branch, stashes, preserved fixture checkout, and historical `.validation-runs/` evidence remain off-limits unless a human explicitly approves otherwise.

## Current Repository State

- Path: `/Users/biran/code/skills/loop/ccloop`
- Branch: `main`
- HEAD: verify with `git rev-parse --short HEAD` before acting.
- State: verify the current `main` checkout status with Git before acting; this handover does not treat a prior clean snapshot as permanent truth.
- Preserved backup branch: `backup/evidence-first-v1-before-memory-history-cleanup`
- Preserved stashes:
  - `stash@{0}: pre-local-merge-evidence-first-v1-2026-07-18`
  - `stash@{1}: pre-merge local changes 2026-07-16`
- Preserved fixture checkout: `.validation-runs/fixture-01` at `becebbabc29ece8bb47f1c93e92479cf20e485b1`
- Accepted review artifacts live under `.validation-runs/evidence/` in the repository checkout and remain the immutable accepted evidence set for takeover.

## Accepted Evidence Set

- `A-04-08` → `PASS`
- `B-02` → `PASS`
- `C-05` → `PASS`
- `D-01` → `INCONCLUSIVE / CONTRACT_GAP`
- `E-01` → `PASS`

## Important Fixes and Current Learnings

- The D-boundary implementation is already on `main`: `execute_started`, controller-owned `execution-recovery.json`, Layer A contradiction handling, terminal-attempt evidence-path resolution, and separate `review-reclassified.json` output all landed before this docs pass.
- `validation/v1/scripts/run-scenario.ts` now canonicalizes the invoked script path, which closes the macOS `/var` vs `/private/var` zero-exit / no-artifact bug.
- Validation-sensitive commands should default to `ECC_GATEGUARD=off` and `DISABLE_OMC=1`; if OMC still interferes, temporarily disable the plugin or use `claude --bare`.

## Governing Boundaries That Still Matter

- require explicit approval before every real Claude invocation;
- never overwrite accepted `review.json`;
- never treat superseded runs as accepted truth;
- never reinterpret `D-01` as `PASS` or `FAIL` in place.

## Known Limitations

- `D-01` accepted history is still `INCONCLUSIVE / CONTRACT_GAP`.
- No resume, reconciliation, scheduler, daemon, queue, lease, heartbeat, or multi-task coordination exists in V1.
- `claudeChildExited` remains `NOT_OBSERVABLE` unless a tracked descendant PID proves it.

## Recommended Next-Step Focus

1. Keep truthful docs / backlog surfaces aligned with the accepted V1 evidence set.
2. Only emit `review-reclassified.json` for `D-01` if a human explicitly asks.
3. Do not schedule or run a new paid scenario without fresh approval.

## Exact Takeover Procedure

1. Start at `/Users/biran/code/skills/loop/ccloop` and inspect state without cleaning: `git status --branch --short`, `git log -8 --oneline --decorate`, `git worktree list`, `git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'`, and `git stash list`.
2. Confirm the preserved artifact surface still exists under `.validation-runs/`, especially the accepted review directories and `.validation-runs/fixture-01`.
3. Read in order: this handover, `validation/v1/README.md`, and the accepted `review.json` files for `A-04-08`, `B-02`, `C-05`, `D-01`, and `E-01`.
4. If a human asks to reinterpret `D-01`, use the separate `review-reclassified.json` flow; otherwise leave the accepted `review.json` untouched.
5. Before any real Claude-backed command, restate the scenario, budgets, and paid-call implication, then wait for explicit approval.

## Useful Commands

```bash
# Current repo state
git -C /Users/biran/code/skills/loop/ccloop status --short
git worktree list
git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup'
git stash list

# Accepted review summary
python3 - <<'PY'
import json
from pathlib import Path
base = Path('/Users/biran/code/skills/loop/ccloop/.validation-runs/evidence')
for run_id in ('A-04-08','B-02','C-05','D-01','E-01'):
    data = json.loads((base / run_id / 'review.json').read_text())
    print(run_id, data['scenarioVerdict'], data.get('diagnosis'))
PY

# Focused validation surface verification
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/validation/evidence.test.ts
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/validation/prepareA04.test.ts
npm run typecheck
npm run build
```

## Do Not Do These on Takeover

- Do not run `git clean`, `git reset --hard`, broad `git restore`, or broad `git checkout`.
- Do not delete `.validation-runs/`, preserved run/evidence directories, `.validation-runs/fixture-01`, preserved verification checkouts, backup branches, or stashes without explicit approval.
- Do not push the backup branch.
- Do not rewrite accepted historical review artifacts, including `D-01 review.json`.
- Do not treat superseded runs (`B-01`, `C-01`, `C-02`, `C-03`, `C-04`) as accepted final truth.
- Do not schedule or run a new paid scenario just to reinterpret or recheck the existing accepted evidence.
