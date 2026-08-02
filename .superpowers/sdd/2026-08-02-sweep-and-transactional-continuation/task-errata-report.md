# Task errata report — two in-place annotations to the plan

Worktree: `/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a`
Branch: `feat/l3-debt1-transactional-continuation`
Starting HEAD: `4608e4d`. Local commit only, no push, no merge.
File edited: `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` (the only file changed — confirmed by `git diff --stat`).

## Erratum 1 — `-t` command form measurements (vitest 2.1.9)

Environment for all three runs: `export ECC_GATEGUARD=off DISABLE_OMC=1`, each vitest invocation wrapped as `rtk proxy "<command>"` per the global shell-hook note. Target: `tests/controller/resumeLoop.gate.test.ts`, describe `evaluateResumeEligibility`, it `refuses when owner-transfer is not eligible`.

### Form 1 — arrow (`describe > it`, literal composition of clause 1 + clause 2)

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'evaluateResumeEligibility > refuses when owner-transfer is not eligible'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ↓ tests/controller/resumeLoop.gate.test.ts (27 tests | 27 skipped)

 Test Files  1 skipped (1)
      Tests  27 skipped (27)
   Start at  20:50:32
   Duration  357ms (transform 90ms, setup 0ms, collect 119ms, tests 0ms, environment 0ms, prepare 53ms)

EXIT=0
```

### Form 2 — space-joined (`describe` + space + `it`, no arrow)

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'evaluateResumeEligibility refuses when owner-transfer is not eligible'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 1ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  20:50:39
   Duration  400ms (transform 98ms, setup 0ms, collect 135ms, tests 1ms, environment 0ms, prepare 38ms)

EXIT=0
```

### Form 3 — bare `it` name

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.gate.test.ts -t 'refuses when owner-transfer is not eligible'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests | 26 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 26 skipped (27)
   Start at  20:50:44
   Duration  485ms (transform 160ms, setup 0ms, collect 240ms, tests 2ms, environment 0ms, prepare 44ms)

EXIT=0
```

**My run reproduces the controller's measurement exactly**: arrow form → `Test Files 1 skipped (1)` / `Tests 27 skipped (27)` / exit 0; the other two forms → `Tests 1 passed | 26 skipped (27)` / exit 0. No disagreement to report.

### A1–A6 forms check (the reassuring half)

Grepped every landed report's `-t '...'` invocations:

- `task-A1-report.md`, `task-A2-report.md`, `task-A3-report.md`, `task-A4-report.md`, `task-A5-report.md`: all `-t` values are bare `it` names (no `describe`, no arrow, no space-join) — e.g. `-t 'publishes the transaction marker by rename, leaving only .owner-transfer.transaction.tmp when the rename fails'`. These match and are unaffected.
- `task-A6-report.md`: explicitly discloses the deviation at its own "⚠️ 关于 `-t` 参数形状的一处硬性偏离" section (report lines ~222–247), demonstrates the same arrow-form zero-match/exit-0 behavior on `evaluateResumeEligibility > refuses when supersededByEpoch is set` (17 skipped, exit 0) versus the space-joined form (1 passed | 16 skipped, exit 0), and states it used the space-joined form throughout. Consistent with the ruling's summary.

## Text added at each site

### Site 1 — Global Constraints §10, after clause 2 (`单跑`)

Inserted `Amended 2026-08-02 (b)` paragraph: keeps clause 1 (full `describe > it` string still required when naming a test) and clause 3 unchanged; states the arrow form does not match on vitest 2.1.9; pastes the three measured blocks above; adds the new hard clause — a `Tests N skipped (N)` block is not a green, the only green is `Tests 1 passed | N skipped` and the only red is `1 failed | N skipped`, applying even when exit code is 0; notes this also catches a mistyped test name; records the vitest version (2.1.9) as version-dependent; and records the A1–A6 form-check result above.

### Site 2 — Task A5, 判据 A bullet

Inserted `Amended 2026-08-02 (c)` paragraph immediately after the 判据 A bullet's original sentence (ending "…判据 A 根本没被求值，变异存活"), before the 判据 B bullet. States the sentence is true only within its own stated subset (gaps where reconciliation is published but transfer is not); is incomplete rather than false; and that gaps 14–17 of the first-transfer fixture (matrix's `resume=accepted` rows) fall outside that subset — there, `evaluateResumeEligibility` runs all eight criteria before returning `{ ok: true }`, criterion A is the 4th, and it is reached, evaluated, and passes. Cross-references the existing 判据 B amendment as the same structural correction for the same reason (unrecovered raw reads in `Promise.all` only let all eight criteria evaluate once both `owner-transfer.json` and `reconciliation-record.json` are published). States explicitly that deleting criterion A would change behavior at gaps 14–17, which is the misreading ("判据 A 在单转移下不可达") the note prevents.

Both original sentences are untouched — verified by `git diff` showing pure insertions (`26 insertions(+), 0 deletions(-)`), no lines removed or reworded.

## Suite / typecheck / build (unfiltered)

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 5ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 424ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 170ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 5ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 50ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 5ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 40ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/persistence/fileStore.test.ts (68 tests) 2346ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1925ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-l7wdzh/does-not-exist'

 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2603ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 308ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 354ms
   ✓ resumeLoop > lets an eligible resume through an expired lease and records the observation 401ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-vfJuU6/run-1  observed 2026-08-02T12:52:41.440Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 481ms
   ✓ parseArgs > returns 0 for the scripted example run 361ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 6ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 27ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 3ms
 ✓ tests/stop/stopController.test.ts (4 tests) 4ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2628ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 691ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 633ms
   ✓ render-contract CLI > rejects a non-git repository path 645ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 646ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3314ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 358ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 357ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 453ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 441ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 473ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 528ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 325ms
   ✓ worktreeManager > creates and removes a detached worktree 325ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 573ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 571ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6855ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop returns, so the next resume proceeds immediately 302ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 645ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 641ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 637ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 519ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 402ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 388ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 393ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 354ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 7177ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 449ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 369ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 371ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 372ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 387ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 406ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 364ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10478ms
   ✓ runLoop > skips adapter.verify when agent verification requiredChecks fail 304ms
   ✓ runLoop > blocks for human input when approval also hits a pauseOn gate 347ms
   ✓ runLoop > blocks for human input before verify when path-policy gating hits 317ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 390ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 327ms
   ✓ runLoop > stops immediately when a stopOn signal matches 303ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 580ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15729ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1490ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1310ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2545ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1542ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1501ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1527ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 615ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 557ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 549ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 921ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 559ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2416ms

 Test Files  29 passed (29)
      Tests  473 passed (473)
   Start at  20:52:38
   Duration  16.34s (transform 2.05s, setup 0ms, collect 3.37s, tests 53.27s, environment 4ms, prepare 1.63s)

TEST_EXIT=0
```

Both listed flakes ((B) evidence.test.ts descendant-tracking test — `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`, (F) runLoop.integration continues-normally test) — the (F) test is not among the failures either; both are `✓` in this run, consistent with "no failure to explain."

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm run typecheck"
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
TYPECHECK_EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm run build"
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

BUILD_EXIT=0
```

Guard count unaffected by this doc-only change (sanity check, not part of the closing rule but relevant to A6's boundary):

```
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
```

## Scope discipline

`git diff --stat` after `git add` and before commit showed exactly:

```
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md | 26 ++++++++++++++++++++++
1 file changed, 26 insertions(+)
```

No other task's text, no other section, no code, no test, no `.superpowers/` content (besides this report, which is gitignored) was touched.

## Commit

```
git add docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md
git commit -m "docs(plan): correct the -t command form's silent zero-match and criterion A's over-strong phrasing"
```

Resulting commit: `f7ffe6a docs(plan): correct the -t command form's silent zero-match and criterion A's over-strong phrasing` (1 file changed, 26 insertions(+)).

## Anything the rulings didn't cover

- The ruling's example test (`resumeLoop.gate.test.ts`) happens to be one of the tests that already changed shape across A1–A6 (the file went from 17 to 27 `it`s over the course of A6). The specific `it` name used in this errata task (`refuses when owner-transfer is not eligible`) is a pre-existing test untouched by A1–A6, so the 26/27-skipped counts above are stable and not an artifact of which task's state the worktree happens to be in.
- I did not add a fourth numbered step to the "三步缺一不可" list in §10, since the human ruling asked to *annotate* the section rather than renumber the checklist; the new hard clause is worded as an addition inside the Amended(b) note itself, keeping the original "三步" text unchanged per the "never delete or reword" rule. Flagging this interpretation choice in case a reviewer would prefer the guard promoted to its own numbered list item — the content is present either way, just not surfaced as a fourth bullet.
- No other numeric or command claim in §10 or Task A5 was touched; only the two spans named in the ruling.
