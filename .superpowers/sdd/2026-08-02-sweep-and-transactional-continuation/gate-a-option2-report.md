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
