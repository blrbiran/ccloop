# GATE-A blocker — Option 2: signal the post-resume published-winner replacement

Implemented on `main` in the main working tree, as follow-up commits on published history. No amend, no
rewrite, no force.

---

## 0. Finding first — something that contradicts the dispatch

The dispatch listed `shouldPreserveExistingSuccessfulReconciliation` among "the existing helpers around
the protection" to consider as the detection point. **That helper is dead code**, and the dispatch does
not say so.

```
$ rtk proxy "grep -rn 'shouldPreserveExistingSuccessfulReconciliation' /Users/biran/code/skills/loop/ccloop/src /Users/biran/code/skills/loop/ccloop/tests"
/Users/biran/code/skills/loop/ccloop/src/persistence/fileStore.ts:161:function shouldPreserveExistingSuccessfulReconciliation(
=== exit 0
```

One hit: its own definition. The live protection (`shouldProtectSuccessfulTransferTruth`) calls
`shouldPreserveExistingReconciliationRecord` instead.

The two are **logically identical**. `shouldPreserveExistingReconciliationRecord` is

```
persisted !== undefined
  && isSuccessfulReconciliationForTransfer(persisted, transfer)
  && (isLoserDowngradeAttempt(next, transfer)
      || shouldSynthesizeSuccessfulReconciliation(undefined, next, transfer))
```

and `shouldSynthesizeSuccessfulReconciliation(undefined, next, transfer)` is
`undefined === undefined && isLoserDowngradeAttempt(next, transfer)`, i.e. exactly
`isLoserDowngradeAttempt(next, transfer)`. So the disjunction is `(A || A)` and the whole predicate
collapses to `shouldPreserveExistingSuccessfulReconciliation`'s body verbatim.

**Consequence for this change:** I used the **live** one, `shouldPreserveExistingReconciliationRecord`, so
that the detection point is literally the negated first conjunct of the predicate that actually runs,
rather than a duplicate that happens to agree today. **I did not delete the dead duplicate** — Rule 3, and
it is outside this change's blast radius. Flagged for GATE-A triage.

Nothing else in the dispatch was contradicted. The defect as stated was re-confirmed against source
(see §1) and the detection point does cleanly express "would have protected, but for the publish-winner
clause" — no approximation was needed.

---

## 1. The defect, re-confirmed against source (not re-derived)

`src/controller/resumeLoop.ts`:

```ts
  const nextOwnerRecord = {
    ...ownerRecord,
    currentProcessInstanceId: buildProcessInstanceId(),
    lastAffirmedAt: new Date().toISOString(),
    leaseAffirmedAt: null,
  };
  try {
    await claimOwnerRecordWithPrecondition(runDir, ownerRecord, nextOwnerRecord);
```

The spread carries `currentOwnerEpoch` through unchanged; only `currentProcessInstanceId` is replaced,
with a fresh `buildProcessInstanceId()`. The CAS then puts that on disk. So
`transferRepresentsPublishedWinner`'s third clause —
`ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId` — is false **at the
same epoch** after any successful resume, with no race and no crash. Exactly as EXECUTION established.

`RunEvent.type` is a bare `string`, verified directly (`src/persistence/fileStore.ts`):

```ts
export type RunEvent = {
  type: string;
  at: string;
  detail: string;
};
```

No type change was needed for the new event name.

---

## 2. What was built

**(1) The detection point — `describePublishedWinnerReplacement`**, new in
`src/persistence/fileStore.ts`, placed immediately after
`preserveSuccessfulReconciliationIfNeededFromArtifacts`.

It is `shouldProtectSuccessfulTransferTruth`'s own conjunction with the first conjunct negated, expressed
by **calling** the same two predicates rather than restating either:

```ts
  if (
    transferRepresentsPublishedWinner(persistedOwnerRecord, persistedOwnerTransferRecord)
    || !shouldPreserveExistingReconciliationRecord(
      persistedReconciliationRecord,
      nextReconciliationRecord,
      persistedOwnerTransferRecord,
    )
  ) {
    return undefined;
  }
```

The synthesis disjunct is deliberately **not** asked: `shouldSynthesizeSuccessfulReconciliation` requires
`persistedReconciliationRecord === undefined`, so nothing on disk is destroyed on that square and there is
no loss to record. The dispatch scopes the signal to "the existing on-disk record is a successful
transfer-backed record that this write is about to replace", which is precisely the preserve disjunct.

**(2) Carried on the existing `write` arm**, not a third arm:

```ts
type ReconciliationWriteDecision =
  | { kind: "write"; record: ReconciliationRecord; publishedWinnerReplacedDetail?: string }
  | { kind: "abandon"; error: unknown };
```

The union is not exported and group C's planned test 12d reaches this channel through `resumeLoop`,
`writeBoundaryArtifacts` and `runLoopFromState` without destructuring it, so a third arm would make group C
absorb a shape change for a signal that changes nothing about what is written.

**(3) The append, in `writeBoundaryArtifacts`**, after the reconciliation write and inside a swallow:

```ts
    // Appended AFTER the write, not before: the event asserts that a published winner's record was
    // destroyed, and if writeJsonFileAtomically throws it was not.
    if (decision.publishedWinnerReplacedDetail !== undefined) {
      try {
        await appendEvent(runDir, {
          type: "reconciliation_published_winner_replaced",
          at: new Date().toISOString(),
          detail: decision.publishedWinnerReplacedDetail,
        });
      } catch {
        // Swallowed by contract, same shape and same reason as the abandon arm's appendEvent
        // above. Left unswallowed, an unwritable events.jsonl (ENOSPC / EACCES / directory already
        // removed) would propagate out of writeBoundaryArtifacts, through persistBoundaryAnalysis,
        // into runLoopFromState's outer catch — where isLeaseStopError does not match an I/O
        // error — and end the attempt as failed. Here the reconciliation write has ALREADY
        // succeeded, so that would convert a successful write into a failed attempt: recording a
        // loss must never be able to manufacture one. This signal is purely observational and
        // changes nothing about what was written, which is exactly why it may be dropped.
      }
    }
```

This is the implementation hazard the dispatch named, and it is closed. The comment's reasoning is the
abandon arm's own, applied to this arm's fact pattern (the write has already succeeded here); no new
justification was invented.

**(2 of the dispatch) The comment on the predicate.** Comment only — **the symbol was not renamed.** It
states both propositions, maps each to its clause, and records that the divergence is intended under the
ruling with the replacement now signalled.

---

## 3. Proof that `transferRepresentsPublishedWinner`'s logic is unchanged

sha256 of the function body only (the `awk` range starts at the `function` line, so the newly added
comment above it is excluded — which is the point: the comment is not part of the body).

**Before the change**, taken from `git show HEAD:src/persistence/fileStore.ts`:

```
$ rtk proxy "git show HEAD:src/persistence/fileStore.ts" > .../fileStore.pre.ts
$ awk '/^function transferRepresentsPublishedWinner\(/,/^}$/' .../fileStore.pre.ts | shasum -a 256
b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f  -
```

**After the change** (this is also the mutation-2 revert proof):

```
=== revert proof: predicate body sha (pre-change was b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f)
b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f  -
```

Byte-identical. Not one clause was touched.

---

## 4. The new test

`tests/persistence/fileStore.test.ts`, name:

`records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record`

Fixture: `owner-record.json` at epoch 2 with `currentProcessInstanceId: "pid:resumer"`;
`owner-transfer.json` at `newOwnerEpoch: 2` with `newProcessInstanceId: "pid:winner"`; the winner's
`eligibleForContinuation: true` record written directly to `reconciliation-record.json`; a downgraded draft
(`newOwnerEpoch: null`, `eligibleForContinuation: false`) passed into `writeBoundaryArtifacts`. An
`events.jsonl` ENOENT precondition is asserted first so the "exactly one line" assertion means something.

Both halves are asserted:

- **(i)** `reconciliation-record.json` **is still replaced** by the downgrade — four assertions on
  `ownershipVerdict` / `priorOwnerEpoch` / `newOwnerEpoch` / `eligibleForContinuation`. This is the
  assertion that goes red the day someone silently upgrades this into the predicate change the human
  forbade.
- **(ii)** exactly one event line was appended, of type `reconciliation_published_winner_replaced`, with
  its payload asserted **by exact string** (not `toContain`), carrying both epochs and both process
  instance ids.

---

## 5. Mutation evidence (Global Constraints §10)

Each experiment is a **separate single run**. Every block below shows a **NONZERO named count** — the
vitest-2.1.9 all-skipped fake-green shape (`Tests N skipped (N)` with EXIT 0) is absent from all of them.
The `-t` argument is the bare `it` name; the arrow form `describe > it` was not used. Blocks are pasted
**whole**: RUN header, per-file listing, `Test Files`, `Tests`, `Start at`, `Duration`, echoed exit code.

Command form for every block below:

```
export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record'"; echo "EXIT=$?"
```

### 5.1 Pre-injection GREEN

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/persistence/fileStore.test.ts (75 tests | 74 skipped) 6ms

 Test Files  1 passed (1)
      Tests  1 passed | 74 skipped (75)
   Start at  08:16:23
   Duration  547ms (transform 216ms, setup 0ms, collect 244ms, tests 6ms, environment 0ms, prepare 43ms)

EXIT=0
```

### 5.2 Mutation 1 — delete the append. Half (ii) must go red.

Injection: the `await appendEvent(runDir, { type: "reconciliation_published_winner_replaced", … })`
statement removed from `writeBoundaryArtifacts`, leaving the surrounding `if` and `try`/`catch`.

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ❯ tests/persistence/fileStore.test.ts (75 tests | 1 failed | 74 skipped) 10ms
   × fileStore > records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record 10ms
     → ENOENT: no such file or directory, open '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-0avtrm/events.jsonl'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record
Error: ENOENT: no such file or directory, open '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-0avtrm/events.jsonl'
 ❯ tests/persistence/fileStore.test.ts:2047:21
    2045| 
    2046|     // (ii) ...and the destroyed winner is named in events.jsonl.
    2047|     const events = (await readFile(join(runDir, "events.jsonl"), "utf8…
       |                     ^
    2048|       .split("\n")
    2049|       .filter((line) => line !== "")

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 74 skipped (75)
   Start at  08:16:38
   Duration  441ms (transform 192ms, setup 0ms, collect 228ms, tests 10ms, environment 0ms, prepare 41ms)

EXIT=1
```

Killed at line 2047 — half **(ii)**, the events read. Note it fails **past** half (i): assertions (i) at
2041–2044 all passed first, so the two halves are independent in this direction.

Reverted.

### 5.3 Mutation 2 — widen the predicate (delete its third clause). Half (i) must go red.

Injection: `&& ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId` deleted
from `transferRepresentsPublishedWinner`.

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ❯ tests/persistence/fileStore.test.ts (75 tests | 1 failed | 74 skipped) 11ms
   × fileStore > records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record 10ms
     → expected 'OWNER_LOST' to be 'OWNER_UNDECIDABLE' // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > records reconciliation_published_winner_replaced when a resumed owner downgrade replaces the published winner record
AssertionError: expected 'OWNER_LOST' to be 'OWNER_UNDECIDABLE' // Object.is equality

Expected: "OWNER_UNDECIDABLE"
Received: "OWNER_LOST"

 ❯ tests/persistence/fileStore.test.ts:2041:45
    2039|       await readFile(join(runDir, "reconciliation-record.json"), "utf8…
    2040|     ) as ReconciliationRecord;
    2041|     expect(reconciliation.ownershipVerdict).toBe("OWNER_UNDECIDABLE");
       |                                             ^
    2042|     expect(reconciliation.priorOwnerEpoch).toBe(2);
    2043|     expect(reconciliation.newOwnerEpoch).toBe(null);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 74 skipped (75)
   Start at  08:17:12
   Duration  438ms (transform 182ms, setup 0ms, collect 228ms, tests 11ms, environment 0ms, prepare 34ms)

EXIT=1
```

Killed at line 2041 — half **(i)**. With the clause gone the protection engages, the winner's `OWNER_LOST`
record survives, and the downgrade never lands. This is the assertion that catches the forbidden
"fix".

Reverted.

### 5.4 Post-revert GREEN, with the body sha as independent revert proof

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/persistence/fileStore.test.ts (75 tests | 74 skipped) 6ms

 Test Files  1 passed (1)
      Tests  1 passed | 74 skipped (75)
   Start at  08:17:29
   Duration  441ms (transform 186ms, setup 0ms, collect 218ms, tests 6ms, environment 0ms, prepare 37ms)

EXIT=0
=== revert proof: predicate body sha (pre-change was b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f)
b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f  -
```

Green **and** byte-identical to the pre-change body. Both mutations reverted.

---

## 6. Full verification

`export ECC_GATEGUARD=off DISABLE_OMC=1` then `rtk proxy "npm test -- --run"`, unfiltered:

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 5ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 443ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 150ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 27ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 4ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 36ms
 ✓ tests/persistence/fileStore.test.ts (75 tests) 2050ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1647ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/ownership/lease.test.ts (16 tests) 5ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 6ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-ZPF4xa/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-K7dEwP/run-1  observed 2026-08-03T00:17:41.236Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 507ms
   ✓ parseArgs > returns 0 for the scripted example run 384ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 17ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2882ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 404ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2668ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 739ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 648ms
   ✓ render-contract CLI > rejects a non-git repository path 593ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 679ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3334ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 367ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 320ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 435ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 574ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 402ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 543ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 341ms
   ✓ worktreeManager > creates and removes a detached worktree 341ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 606ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 604ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6662ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 622ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 576ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 619ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 502ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 411ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 371ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 364ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 390ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9667ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 493ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 384ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 400ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 420ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 375ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 394ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 415ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 389ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 359ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 345ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 343ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 348ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 418ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 358ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 530ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 383ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 501ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 487ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 371ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 687ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 375ms
 ✓ tests/controller/runLoop.integration.test.ts (53 tests) 10989ms
   ✓ runLoop > skips adapter.verify when agent verification requiredChecks fail 313ms
   ✓ runLoop > does not succeed when approved verification is missing required evidence 405ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 365ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 726ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15874ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1538ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1197ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2582ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1520ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1520ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1557ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 589ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 578ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 565ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 942ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 588ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2494ms

 Test Files  29 passed (29)
      Tests  483 passed (483)
   Start at  08:17:38
   Duration  16.50s (transform 2.26s, setup 0ms, collect 3.57s, tests 56.30s, environment 3ms, prepare 1.51s)

EXIT=0
```

`Tests 483 passed (483)` against the stated baseline of 482 — exactly +1, the one new test. No other count
moved.

`rtk proxy "npm run typecheck"`:

```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

EXIT=0
```

`rtk proxy "npm run build"`:

```
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

EXIT=0
```

---

## 7. The three guards

Measured **before** the change:

```
=== guard 1: return { ok: false count
8
=== guard 2: currentOwnerEpoch + 1
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
=== guard 3: src/registry status
(empty = untouched)
```

Re-measured **after** the change — see §8 for the post-commit run. All three hold: `return { ok: false` = 8,
`currentOwnerEpoch + 1` a single hit, `src/registry/` untouched.

---

## 8. Scope

Files changed: `src/persistence/fileStore.ts`, `tests/persistence/fileStore.test.ts`, and the two ledger /
report files under `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/` (added with
`git add -f`, since that directory's `.gitignore` is `*`).

No new artifact file, no new callback channel, no new exported type. Rule 2 held.

---

# FIX ROUND 1 — independent review returned "Needs fixes" (1 Important, 3 Minor)

Commits: `bf5d12d` (fix), `5495c9b` (test), `03ba382` (comments), plus this docs commit. `main` was already
pushed, so these are follow-up commits only — nothing amended, nothing rewritten, nothing forced.

## 0. Did anything contradict the dispatch?

No. The Important finding reproduced exactly as described, on the first try, with the described error text
and the described difference between trees. The three Minor findings all check out against the landed text.
The out-of-scope item (deleting `shouldPreserveExistingSuccessfulReconciliation`) was left alone, and the
ledger already carried it — progress.md's `FINDING — CONTRADICTS THE DISPATCH` block ends "The dead
duplicate was NOT deleted — Rule 3, and it is not this change's blast radius. Flagged for GATE-A triage."
Nothing added; nothing needed.

## 1. F1 (Important) — ADDRESSED. The probe first, because the dispatch says measure it.

A throwaway probe test wrote the post-resume fixture (owner-record.json at epoch 2 naming `pid:resumer`,
owner-transfer.json at newOwnerEpoch 2 naming `pid:winner`) with `reconciliation-record.json` containing the
five bytes `null`, called `writeBoundaryArtifacts`, and logged what came back. Run against the tree as
landed:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

stdout | tests/persistence/zzprobe.test.ts > probe > probe null reconciliation content
PROBE thrown: TypeError: Cannot read properties of null (reading 'eligibleForContinuation')
PROBE reconciliation-record.json: null
PROBE boundary-analysis.json exists: true

 ✓ tests/persistence/zzprobe.test.ts (1 test) 3ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  08:35:03
   Duration  270ms (transform 44ms, setup 0ms, collect 41ms, tests 3ms, environment 0ms, prepare 43ms)

EXIT=0
```

The same probe, unchanged, against the PRE-CHANGE `src/persistence/fileStore.ts`
(`git checkout b70b40f^ -- src/persistence/fileStore.ts`, restored immediately after):

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

stdout | tests/persistence/zzprobe.test.ts > probe > probe null reconciliation content
PROBE thrown: undefined
PROBE reconciliation-record.json: {
  "staleSuspicionBasis": [
    "continuity evidence missing"
  ],
  "staleConfirmed": true,
  "ownershipVerdict": "OWNER_UNDECIDABLE",
  "lastTrustedBoundary": "execute",
  "conflictingEvidence": [],
  "takeoverPermission": {
    "allowed": false,
    "reason": "deny-by-default until strict owner-loss and transfer conditions are fully met"
  },
  "priorOwnerEpoch": 2,
  "newOwnerEpoch": null,
  "eligibleForContinuation": false
}
PROBE boundary-analysis.json exists: true

 ✓ tests/persistence/zzprobe.test.ts (1 test) 5ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  08:35:11
   Duration  258ms (transform 40ms, setup 0ms, collect 40ms, tests 5ms, environment 0ms, prepare 34ms)

EXIT=0
```

Confirmed, with nothing left to argue about: pre-change the downgrade lands and the call returns; as landed
the call throws. The mechanism is the one the reviewer named — `readPersistedReconciliationRecord` casts an
unvalidated `JSON.parse` result, `null !== undefined`, and `describePublishedWinnerReplacement` asks
`shouldPreserveExistingReconciliationRecord` on the `!transferRepresentsPublishedWinner` square, which the
pre-change code reached only through `shouldProtectSuccessfulTransferTruth`'s `&&`, i.e. only when the
predicate was TRUE. The complement square is newly evaluated, and on it the record is dereferenced.

**Form chosen: a `try { … } catch { return undefined }` around the whole detail computation, inside
`describePublishedWinnerReplacement`.** Three candidates were considered:

  (a) Validate in `readPersistedReconciliationRecord` — REJECTED, and this one is a trap. It would also
      change the `transferRepresentsPublishedWinner === true` square, where a `null` file throws today
      through `shouldProtectSuccessfulTransferTruth`. Turning that throw into `undefined` routes a corrupt
      record into the SYNTHESIS arm, which is permit-MORE — precisely what reason #2 of the human ruling
      forbids. A fix for a permit-less defect must not introduce a permit-more one.
  (b) A `null` guard inside the helper — REJECTED. `persistedReconciliationRecord === null` does not
      type-check against `ReconciliationRecord | undefined` without a cast, and it hardens against exactly
      one of the values disk can hold. `{}` does not throw today only because
      `isSuccessfulReconciliationForTransfer` reads no nested field; the day it reads one, the guard is
      already stale.
  (c) Contain the computation — CHOSEN. Total by construction against ANY shape, no cast, and its worst
      outcome is "no detail", which is the dispatch's own criterion. It is also this repository's existing
      shape for this exact concern: both `appendEvent` calls in `writeBoundaryArtifacts` are swallowed with
      the same one-line reason, "recording a loss must never be able to manufacture one".

Scope of the containment is the helper only. On the `transferRepresentsPublishedWinner === true` square the
first disjunct short-circuits and the helper never reaches the throwing predicate, so that square's
behaviour is bit-for-bit what it was before this signal existed — and it stays that way because
`preserveSuccessfulReconciliationIfNeeded`'s object literal evaluates `record:` (which calls
`preserveSuccessfulReconciliationIfNeededFromArtifacts`) BEFORE `publishedWinnerReplacedDetail:`.

The same probe, re-run after the fix, is byte-for-byte the pre-change result:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

stdout | tests/persistence/zzprobe.test.ts > probe > probe null reconciliation content
PROBE thrown: undefined
PROBE reconciliation-record.json: {
  "staleSuspicionBasis": [
    "continuity evidence missing"
  ],
  "staleConfirmed": true,
  "ownershipVerdict": "OWNER_UNDECIDABLE",
  "lastTrustedBoundary": "execute",
  "conflictingEvidence": [],
  "takeoverPermission": {
    "allowed": false,
    "reason": "deny-by-default until strict owner-loss and transfer conditions are fully met"
  },
  "priorOwnerEpoch": 2,
  "newOwnerEpoch": null,
  "eligibleForContinuation": false
}

 ✓ tests/persistence/zzprobe.test.ts (1 test) 4ms
stdout | tests/persistence/zzprobe.test.ts > probe > probe null reconciliation content
PROBE boundary-analysis.json exists: true


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  08:37:44
   Duration  280ms (transform 42ms, setup 0ms, collect 41ms, tests 4ms, environment 0ms, prepare 41ms)

EXIT=0
```

Both probe files were deleted before the full suite ran; the count below (484 = 483 + 1) is the proof that
neither survived into the tree.

### The pin, and its killing mutation

New test in `tests/persistence/fileStore.test.ts`, immediately after the Option 2 test it shares a fixture
with:

`it("still lands the downgrade when reconciliation-record.json holds a value the record type cannot describe")`

It asserts the pre-change outcome and nothing else: `writeBoundaryArtifacts` is awaited without a `.rejects`
wrapper (so a regression surfaces as the TypeError itself, which is the diagnosis), then the four fields of
`reconciliation-record.json` are asserted to be the downgrade. It deliberately does NOT assert on
events.jsonl — the corrupt-file square is a named open gap (§F3 below), and pinning silence there would go
red the day that gap is legitimately closed.

*Amended 2026-08-03 — artefact integrity, ledger GATE-A open item 6, first half.* The three single-run
fences below recorded their OUTPUT but not the COMMAND that produced it. All three ran the same command;
only the source underneath differs. The command is:

```
export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still lands the downgrade when reconciliation-record.json holds a value the record type cannot describe'"; echo "EXIT=$?"
```

This is a reconstruction, and it is labelled as one rather than back-dated: the controller of the 2026-08-03
clean-up round re-ran it against today's unmutated tree and got `Test Files 1 passed (1)` /
`Tests 1 passed | 75 skipped (76)` / `EXIT=0` — the same counts and exit code as the pre-injection fence
below (timestamps and durations differ, as they must). The substance of all three runs was already
established independently: the re-reviewer of THE OPTION-2 FIX ROUND — the round this report documents, not
the 2026-08-03 clean-up round — reproduced all three itself. Naming it that way matters, because the
clean-up round re-ran only the UNMUTATED green; it re-injected no mutation and makes no claim to have. What
was missing was only the record, and this is it.

Green single-run before injection:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/persistence/fileStore.test.ts (76 tests | 75 skipped) 4ms

 Test Files  1 passed (1)
      Tests  1 passed | 75 skipped (76)
   Start at  19:33:41
   Duration  532ms (transform 230ms, setup 0ms, collect 267ms, tests 4ms, environment 0ms, prepare 41ms)

EXIT=0
```

Mutation — delete `describePublishedWinnerReplacement`'s `try`/`catch`, leaving the body exactly as it was
before this fix round:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ❯ tests/persistence/fileStore.test.ts (76 tests | 1 failed | 75 skipped) 10ms
   × fileStore > still lands the downgrade when reconciliation-record.json holds a value the record type cannot describe 9ms
     → Cannot read properties of null (reading 'eligibleForContinuation')

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > still lands the downgrade when reconciliation-record.json holds a value the record type cannot describe
TypeError: Cannot read properties of null (reading 'eligibleForContinuation')
 ❯ isSuccessfulReconciliationForTransfer src/persistence/fileStore.ts:120:26
    118| ): boolean {
    119|   return (
    120|     reconciliationRecord.eligibleForContinuation
       |                          ^
    121|     && reconciliationRecord.ownershipVerdict === "OWNER_LOST"
    122|     && reconciliationRecord.priorOwnerEpoch === ownerTransferRecord.pr…
 ❯ shouldPreserveExistingReconciliationRecord src/persistence/fileStore.ts:204:8
 ❯ describePublishedWinnerReplacement src/persistence/fileStore.ts:309:9
 ❯ preserveSuccessfulReconciliationIfNeeded src/persistence/fileStore.ts:430:36
 ❯ Module.writeBoundaryArtifacts src/persistence/fileStore.ts:456:22
 ❯ tests/persistence/fileStore.test.ts:2101:5

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 75 skipped (76)
   Start at  19:37:42
   Duration  508ms (transform 214ms, setup 0ms, collect 248ms, tests 10ms, environment 0ms, prepare 36ms)

EXIT=1
```

Reverted, and the revert proven by a green single-run rather than by assertion:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/persistence/fileStore.test.ts (76 tests | 75 skipped) 4ms

 Test Files  1 passed (1)
      Tests  1 passed | 75 skipped (76)
   Start at  19:37:59
   Duration  593ms (transform 208ms, setup 0ms, collect 241ms, tests 4ms, environment 0ms, prepare 39ms)

EXIT=0
```

`1 passed | 75 skipped` before injection and `1 failed | 75 skipped` after: both counts NONZERO for the
named test, so neither run is an all-skipped fake green.

## 2. F2 (Minor) — ADDRESSED. Both comments now name the predicate, not one clause.

`describePublishedWinnerReplacement`'s header said "the one square where
`shouldProtectSuccessfulTransferTruth` would have protected but for `transferRepresentsPublishedWinner`'s
process-instance-id clause"; `transferRepresentsPublishedWinner`'s closing sentence said "(a) holds, (b)
does not". The code tests `!transferRepresentsPublishedWinner`, a strict SUPERSET of that: a false
`eligibleForContinuation === true` or a `currentOwnerEpoch !== newOwnerEpoch` land on the same square. The
reviewer is right that this is reachability, not behaviour — `applyOwnerEpochTransfer` always writes
`eligibleForContinuation: true`, so nothing in this repo takes the other routes — but an inaccurate comment
on this exact symbol is what made the F1 defect require execution to find. Both now state the negated
predicate and record that the post-resume route is merely the only reachable one.

## 3. F3 (Minor) — ADDRESSED, as a reword plus a named gap; the signal was NOT widened.

The synthesis-disjunct justification claimed synthesis requires `persistedReconciliationRecord === undefined`
"so nothing on disk is destroyed there". That is true of preserved TRUTH and false of disk contents:
`readPersistedReconciliationRecord`'s `catch { return undefined }` maps a CORRUPT file to `undefined` as
well, so on that square a corrupt `reconciliation-record.json` is overwritten with no event — the same
silence this change exists to remove, one square over. Reworded to "nothing THE PROTECTION WOULD HAVE
PRESERVED is lost", with the corrupt-file square named in the comment and carried in progress.md. It was
NOT covered: widening the signal to distinguish absent from corrupt is a different change with a different
justification, and it is the same conflation that is reason #2 of the human ruling.

## 4. F4 (Minor) — ADDRESSED by supersession; `0d557e9`'s message is published and stays as written.

That commit says "deleting the predicate's third clause kills (i) only". Measured with a second throwaway
probe on the landed fixture (the winner's VALID record on disk), which logs both halves instead of stopping
at the first failed assertion. Unmutated baseline first:

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/persistence/zzprobe2.test.ts (1 test) 4ms
stdout | tests/persistence/zzprobe2.test.ts > probe2 > probe landed fixture halves
PROBE2 (i) verdict: OWNER_UNDECIDABLE eligible: false
PROBE2 (ii) events.jsonl: "{\"type\":\"reconciliation_published_winner_replaced\",\"at\":\"2026-08-03T00:36:33.915Z\",\"detail\":\"published winner reconciliation replaced by downgrade: transfer epoch 1 -> 2 won by pid:winner; owner-record epoch 2 now held by pid:resumer\"}\n"


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  08:36:33
   Duration  310ms (transform 45ms, setup 0ms, collect 42ms, tests 4ms, environment 0ms, prepare 36ms)

EXIT=0
```

Then with `transferRepresentsPublishedWinner`'s third clause deleted (mutation 2 of `0d557e9`):

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

stdout | tests/persistence/zzprobe2.test.ts > probe2 > probe landed fixture halves
PROBE2 (i) verdict: OWNER_LOST eligible: true
PROBE2 (ii) events.jsonl: "<ENOENT>"

 ✓ tests/persistence/zzprobe2.test.ts (1 test) 4ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  08:36:44
   Duration  258ms (transform 43ms, setup 0ms, collect 43ms, tests 4ms, environment 0ms, prepare 35ms)

EXIT=0
```

(The probe asserts nothing — it only logs — so its own EXIT=0 says nothing about the mutation; the two
`PROBE2` lines are the measurement. `<ENOENT>` is the probe's own placeholder for "events.jsonl does not
exist", not vitest output.)

Half (i) is red under that mutation — the winner's `OWNER_LOST` / `eligible: true` record was PRESERVED
instead of replaced — and `events.jsonl` does not exist at all. With the clause deleted the protection ENGAGES,
so `describePublishedWinnerReplacement`'s first disjunct is true, no detail is produced, and no event is
written — mutation 2 kills half (ii) as well as half (i). Half (i) merely fails first because its
assertions come first in the test body. **`0d557e9`'s "kills (i) only" is therefore WRONG and is superseded
by this report and by the progress.md entry below.** The commit message itself is published history and is
not edited.

## 5. Out of scope, confirmed left alone

`shouldPreserveExistingSuccessfulReconciliation` — the dead helper whose agreement with the live predicate
rests on an unreduced `(A || A)` — was not touched. progress.md already carries it as flagged for GATE-A
triage; verified by reading, not assumed.

## 6. Full verification, unfiltered

`export ECC_GATEGUARD=off DISABLE_OMC=1` then `rtk proxy "npm test -- --run"`:

```
> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 419ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 157ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 51ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 32ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/persistence/fileStore.test.ts (76 tests) 2049ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1640ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-tg33DC/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-HUiXl2/run-1  observed 2026-08-03T11:38:10.370Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 434ms
   ✓ parseArgs > returns 0 for the scripted example run 305ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 20ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2729ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 311ms
   ✓ resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState 303ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 302ms
   ✓ resumeLoop > does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field) 301ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 372ms
   ✓ worktreeManager > creates and removes a detached worktree 371ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3327ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 401ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 304ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 341ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 398ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 366ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 411ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 334ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 533ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2807ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 683ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 584ms
   ✓ render-contract CLI > rejects a non-git repository path 612ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 920ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 3ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 3ms
 ✓ tests/validation/fixture.test.ts (2 tests) 747ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 744ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6953ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 590ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 554ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 594ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 557ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 517ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 387ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 382ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 368ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 10092ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 511ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 402ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 392ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 451ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 481ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 369ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 458ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 422ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 361ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 362ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 360ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 360ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 374ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 368ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 495ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 361ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 640ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 515ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 378ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 754ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 389ms
 ✓ tests/controller/runLoop.integration.test.ts (53 tests) 11328ms
   ✓ runLoop > succeeds when verification approves 319ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 355ms
   ✓ runLoop > stops immediately when a stopOn signal matches 409ms
   ✓ runLoop > exhausts the run when planning exceeds per-attempt timeout 398ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 773ms
 ✓ tests/validation/evidence.test.ts (39 tests) 16095ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1354ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1222ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2949ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1569ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1568ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1504ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 580ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 579ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 574ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 943ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 568ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2505ms

 Test Files  29 passed (29)
      Tests  484 passed (484)
   Start at  19:38:07
   Duration  16.70s (transform 2.05s, setup 0ms, collect 3.37s, tests 57.66s, environment 3ms, prepare 1.69s)

EXIT=0
```

`Tests 484 passed (484)` against this round's stated baseline of 483 — exactly +1, the one new test, and no
other count moved. 29 files, unchanged.

`rtk proxy "npm run typecheck"`:

```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

EXIT=0
```

`rtk proxy "npm run build"`:

```
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

EXIT=0
```

## 7. Guards and the predicate sha256, re-measured after the change

Script (symbol-anchored, no line numbers), run through `rtk proxy` because the shell hook filters:

```
echo "== guard 1: return { ok: false count =="
grep -cF 'return { ok: false' src/controller/resumeLoop.ts
echo "== guard 2: currentOwnerEpoch + 1 =="
grep -rnF 'currentOwnerEpoch + 1' src/
echo "== guard 3: src/registry status (empty = untouched) =="
git status --porcelain src/registry/ ; git diff --stat b126137 -- src/registry/
echo "== predicate sha256 =="
awk '/^function transferRepresentsPublishedWinner\(/,/^}/' src/persistence/fileStore.ts | shasum -a 256
echo "EXIT=$?"
```

*Amended 2026-08-03 — artefact integrity, ledger GATE-A open item 6, second half.* FIVE lines above were
missing from this fence — the four `echo` headers and the trailing `echo "EXIT=$?"` — so the script as
printed could produce neither the `== guard N: … ==` headers nor the `EXIT=0` that the output fence below
shows: the command block and the output block did not match. The 2026-08-03 clean-up round re-ran the
corrected script through `rtk proxy` against today's tree and compared the two MECHANICALLY rather than by
eye: `diff` of the run's output against the output fence below exits **0**, so the reproduction is
byte-identical — `8`, the single `ownerController.ts:166` hit, an empty guard 3, the same predicate sha256,
and `EXIT=0`. Only the five missing `echo` lines were added; no guard, no anchor and no value changed.
`b126137` still resolves (`git rev-parse b126137^{commit}` → `b126137ccfd174a9bdcff5fd158bf1b0833e3f2e`).
*(The first draft of this amendment omitted the `EXIT=$?` line and still claimed a line-for-line match. An
independent reviewer of the clean-up round caught it by running `diff`; corrected before commit.)*

```
== guard 1: return { ok: false count ==
8
== guard 2: currentOwnerEpoch + 1 ==
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
== guard 3: src/registry status (empty = untouched) ==
== predicate sha256 ==
b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f  -
EXIT=0
```

All three hold, and the predicate's function body still hashes to
`b1d03f926fb865def86fb6814daeac84cbe0ad2ee8a8dcfd7bf44b21d604356f` — the dispatch's required value.
`transferRepresentsPublishedWinner`'s logic is byte-identical; only the comment ABOVE it moved (F2).

## 8. Scope of this round

`src/persistence/fileStore.ts` (one `try`/`catch` and three comment blocks),
`tests/persistence/fileStore.test.ts` (one added test), and these two ledger / report files. No new artifact
file, no new callback channel, no new exported type, no signature change. Rule 2 held.
