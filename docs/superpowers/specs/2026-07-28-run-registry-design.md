# L2 — Run Registry (Discovery Only)

Status: approved 2026-07-28. No amendments yet.

Layer position: L2 in the ownership-and-coordination stack. Parent design:
`2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17 item 2.
Predecessors, all implemented and merged: resume/adopt (`2026-07-25`), run lease +
heartbeat (`2026-07-26`, "L1"), owner-transfer contention (`2026-07-27`, "L1b").

## 1. Purpose

Answer one question: **which runs exist, and what state is each observed to be in?**

Today there is no answer. A run's identity *is* the operator-supplied `--run-dir`
path (`src/cli.ts:30`, `:86`). There is no runs root, no index, no enumeration, no
listing. Both the parent design and the resume design define how eligibility is
*verified* at a known `runDir`; neither defines how a candidate `runDir` is
*discovered*. That gap is what this layer closes, and nothing more.

## 2. Non-Goals

This layer does **not**:

1. judge eligibility, resumability, or lease freshness;
2. rank, select, or queue runs;
3. trigger `resumeLoop` or any execution;
4. introduce any new persisted state, index, or on-disk artifact;
5. change how runs are created, or change `--run-dir` semantics;
6. discharge any of the three debts bequeathed to L5 (§13);
7. modify L1 or L1b code, including the lease gate.

Item 3 is the boundary against §17 item 2's literal wording ("scheduler /
unattended execution"). That wording spans two separable capabilities —
*discovery* and *triggering*. This spec takes discovery only. Triggering is
deferred to a later layer, which will need its own spec and its own answer to §13.

## 3. Authorization Position

**L2 introduces no new authorization, structurally rather than argumentatively.**

The layer is read-only: it does not write, and it does not execute. Its output is
not a permit to continue, resume, or take over. It does not even compute
eligibility, so there is nothing in its output that could be mistaken for a
verdict. Any consumer — a human, or a future queue layer — must still pass
`resumeLoop`'s full gate, unchanged.

This preserves, without weakening, the standing rules it inherits:

- `stale-candidate` ≠ owner lost ≠ continuation (parent §15).
- Takeover authority remains solely with reconciliation, deny-by-default
  (resume spec §2).
- An expired lease authorizes nothing and refuses nothing (L1 §12 #11, #12).

## 4. Run Directory Recognition

A directory is a run directory **iff it directly contains at least one of**:

```
loop-contract.json
loop-state.json
owner-record.json
events.jsonl
```

Recognition is deliberately permissive. Requiring `loop-contract.json` alone would
be wrong: a run whose `initializeRunFiles` (`src/persistence/fileStore.ts:72`)
failed partway leaves a directory with some markers and not others, and that
wreckage is precisely what an operator most needs to see. Omitting it from the
listing would make the tool least informative exactly when it matters most.

**Recognize permissively; report explicitly.** A recognized run whose
`loop-contract.json` is missing is reported as a row with that file marked
`absent` — not skipped, and not treated as "not a run".

## 5. Traversal Rules

1. Recursive descent from the caller-supplied root.
2. **Stop descending once a directory is recognized as a run directory.** Without
   this, `runDir/worktrees/attempt-N/` — a git worktree that may itself contain an
   unrelated project, possibly including a `loop-contract.json` — would be reported
   as a nested run.
3. Symbolic links are not followed.
4. Descent stops at a depth of 10 directories below the root; exceeding it reports
   a row noting the truncation rather than silently stopping. Real trees are
   already bounded by rules 2 and 3; the limit is a guard against pathological
   nesting, not an expected condition.
5. A directory that cannot be read (permissions, I/O error) produces a row
   recording the failure. It never aborts the scan.

Rules 4 and 5 share one principle with §4: the scan reports what it could not do,
rather than returning a shorter list that looks complete.

## 6. Observation Record Shape

Each row carries `path` and `observedAt`, plus per-file observations:

| Source | Fields observed |
|---|---|
| `loop-state.json` | `status`, `currentAttempt`, `attemptsUsed`, `lastTransitionAt`, `stopReason` |
| `owner-record.json` | `runId`, `currentOwnerEpoch`, `ownerStatus`, `currentProcessInstanceId`, `leaseAffirmedAt` |
| `owner-transfer.json` | presence, and the literal value of `eligibleForContinuation` |

Every field is one of three states: `present` (with value), `absent`, or
`unreadable` (with a reason). **A row is never omitted.**

There is no "can this be resumed" column, and no derived field of any kind.

### 6.1 `leaseAffirmedAt` is reported raw

The row carries the persisted `leaseAffirmedAt` value. It does **not** carry a
`fresh` / `expired` / `stale` marker.

Freshness is a derivation: it compares the value against `now` and `LEASE_TTL_MS`.
L1 §12 #11 and #12 establish that an expired lease authorizes nothing and refuses
nothing — the eligibility reason still governs either way. A registry column
reading `expired` would be read by humans as "this one is free to take over",
which is exactly the inference those two constraints exist to forbid. Reporting
the raw timestamp gives a reader everything needed to derive freshness themselves,
while refusing to put the derivation's conclusion in the output.

### 6.2 Schema version

The JSON output carries a `schemaVersion` field, matching the versioning
convention already used by on-disk artifacts (e.g. the owner-transfer transaction
marker, `fileStore.ts:329`).

## 7. Read Path and the Zero-Write Guarantee

### 7.1 Forbidden reader

`readOwnerRecord` (`fileStore.ts:566`) **must not be called.** It runs
crash-recovery on read, which writes. A read-only listing command that mutates
another process's run directory is the worst failure this layer could produce.

Use `readOwnerRecordWithoutRecovery` (`fileStore.ts:628`).

### 7.2 Verified-pure readers

The following are verified to be pure reads (`readFile` + `JSON.parse`, no write):

- `readRunState` (`fileStore.ts:697`)
- `readOwnerTransferRecord` (`fileStore.ts:701`)
- `readOwnerRecordWithoutRecovery` (`fileStore.ts:628`) → `readOwnerRecordRaw`
  (`:371-373`)

`readReconciliationRecord` (`fileStore.ts:705`) is also pure but is **not used** —
§6 does not observe `reconciliation-record.json`.

These are reused rather than reimplemented, so that no second parsing
implementation exists to drift from the first. Each reused reader gets a test
pinning it as side-effect-free (§12.1).

### 7.3 Validation must be layered on top

The readers in §7.2 are **blind casts** (`JSON.parse(...) as RunState`) and they
**throw** on ENOENT and on malformed JSON. Two consequences:

1. The scanner must catch, and must distinguish *absent* (ENOENT) from
   *unreadable* (parse failure) — the readers themselves collapse both into a
   throw.
2. A structurally valid JSON object missing required fields passes the cast
   silently. L1 §12 #7 names `readOwnerRecordRaw` specifically as the reader that
   "accepts silently" an object missing `currentProcessInstanceId` or carrying a
   non-string `leaseAffirmedAt`. The scanner must therefore run the observed owner
   record through `parseOwnerRecordForLease` (`src/ownership/lease.ts:64`), the
   existing validating parser, and report the failure as `unreadable`.

Without §7.3.2, the nastiest corruption class — valid JSON, wrong shape — would be
reported as a healthy row. That would invert §12 #7's rule inside this layer.

### 7.4 The lease gate is not reusable

`checkRunLease` (`src/controller/leaseGate.ts:16`) appends a
`lease_expired_observed` event (`:59`) when it observes an expired lease. It
writes. It cannot be called from a zero-write scanner, and it must not be
refactored to accommodate one — L1 §12 has constraints pinned to its current
behavior.

## 8. Consistency Model

**The scan makes no cross-file consistency guarantee, and says so.**

Each file is written by atomic rename, so any single file read yields some
complete version. But a row assembles several files, and the combination is not a
snapshot: a scan may read a pre-transfer `owner-record.json` alongside a
post-transfer `owner-transfer.json`.

Retrying does not fix this. It is not a torn read; it is a timing mismatch between
independent files. A true snapshot would require a lock, and taking a lock means
writing — which contradicts §3 — and would let a read-only listing command block
real work.

Therefore: single read per file, no retry, `observedAt` stamped on every row, and
both the documentation and the human-readable output state plainly that fields
within a row are independent observations and do not constitute a consistent
snapshot.

## 9. CLI Surface and Exit Codes

New subcommand: `ccloop ls <root>`, alongside the existing `run` and `resume`
(`src/cli.ts:30`).

- `--json` emits the machine contract. This is the interface a future queue layer
  consumes.
- Default output is a human-readable table. It is a convenience view over the same
  data, never a different set of facts.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | The scan completed — **including when rows are `unreadable`** |
| `1` | The scan itself failed (root missing, or unreadable) |

The `0`-on-unreadable choice is deliberate and was ruled explicitly. An
`unreadable` row is a *reported fact*, not a command failure; the command did its
job. Returning non-zero would make `ls` alarm continuously during routine
inspection of a repository that contains any old damaged run, which trains
operators to ignore the signal. The damage is surfaced in the output, which is
where a reader will act on it.

## 10. Module Boundaries

New directory `src/registry/`:

- `scanRuns.ts` — the scan itself, written against an injected filesystem-read
  interface so it is testable without a real tree, returning `RunObservation[]`.
- CLI wiring does argument parsing and rendering only. No observation logic in
  `cli.ts`.

Tests live in `tests/registry/`, mirroring `src/` as the existing suite does.

## 11. Error Handling Summary

| Condition | Result |
|---|---|
| File missing | field `absent` |
| Malformed JSON | field `unreadable(parse)` |
| Valid JSON, invalid shape | field `unreadable(shape)` — see §7.3.2 |
| Directory unreadable | row recording the failure; scan continues |
| Depth limit hit | row recording truncation |
| Root missing / unreadable | exit `1` |

Nothing in this table results in a silently dropped row.

## 12. Test Requirements

These are the requirements the implementation plan must expand. Each is written to
fail against a specific plausible wrong implementation.

1. **Zero-write proof.** Snapshot the whole tree as `(path, size, mtime,
   content-hash)` before and after a scan; assert byte-identical. This must
   include a case where `owner-record.json` is in the state that triggers
   `readOwnerRecord`'s crash recovery — written to fail against an implementation
   that reached for the convenient reader (§7.1).

2. **Corrupt is not absent.** Three separate cases — malformed JSON, missing file,
   and structurally valid JSON missing a required field — must each appear in the
   output, the first and third marked `unreadable` and the second `absent`. None
   may be silently skipped. The third case is the one §7.3.2 exists for; written
   to fail against an implementation that only catches throws.

3. **No descent into a recognized run.** Place a complete, valid run directory at
   `runDir/worktrees/attempt-1/` and assert it does not appear in the results
   (§5.2).

4. **A live run does not break the scan.** Scan a run whose heartbeat is actively
   writing; assert the scan completes without throwing.

5. **Zero derivation is a failing test, not a documentation promise.** Assert the
   output schema contains no field matching `eligible` / `resumable` / `fresh` /
   `stale` / `expired`. Written to fail against a future well-meaning addition of
   a "helpful" column (§3, §6.1).

6. **Permissive recognition.** A directory containing only `events.jsonl`, and one
   containing only `owner-record.json`, are each recognized and reported with the
   remaining files marked `absent` (§4).

7. **Exit code.** A scan producing `unreadable` rows exits `0`; a scan whose root
   does not exist exits `1` (§9).

## 13. Inherited Debts — Explicitly Not Taken

The three debts bequeathed to L5 are unchanged by this layer, and this layer does
not make any of them more reachable. That is a direct consequence of choosing
discovery over triggering: a read-only scanner adds no caller to any of the
affected paths.

1. **Reconciliation synthesis is unowned.** Consequence of the L1b ruling that
   `writeBoundaryArtifacts` is guarded unconditionally (`src/controller/runLoop.ts:817-819`).
   A completed `owner-transfer.json` may now exist with neither
   `boundary-analysis.json` nor `reconciliation-record.json`.
   *Effect here:* none. §6 does not observe either file, so the registry neither
   synthesizes them nor reports on their absence. A row may therefore show
   `eligibleForContinuation: true` for a run that has no reconciliation record on
   disk; that is the debt showing through, not a registry defect.

2. **`persistTerminalState` writes into a run it no longer owns**
   (`src/controller/runLoop.ts:958-959`, also `:939`, `:1282`).
   *Effect here:* none. The registry adds no caller.

3. **`heartbeat.stop()` release window** — a `runExclusive` begun after the queue
   snapshot (`src/controller/leaseHeartbeat.ts:223`) is not awaited by `stop()`
   (`:231`). Reviewed as unreachable today because the only production
   `runExclusive` caller is `persistBoundaryAnalysis` (`runLoop.ts:739`), invoked
   at `:1066` and `:1098`, both inside `runLoopFromState`, while both `stop()`
   sites sit in a `finally` after `await runLoopFromState` (`runLoop.ts:883-887`,
   `resumeLoop.ts:182-186`). Re-verified as still holding on 2026-07-28.
   *Effect here:* none — the registry never starts a heartbeat. **This debt must be
   re-evaluated by whichever layer adds a triggering caller**, which is the
   deferred queue layer, not this one.

## 14. Follow-On

1. **Queue / triggering layer.** The remaining half of parent §17 item 2: when and
   by whom a discovered, eligible run is re-queued or continued. It consumes this
   layer's `--json` contract, must pass `resumeLoop`'s gate unchanged, and must
   re-evaluate debt §13.3 before adding any caller.
2. **L5 cleanup / orphan GC.** Parent §17 item 3, still unwritten, and now
   holding the three debts in §13. This layer makes L5 easier to write — collecting
   orphans requires enumerating runs, which did not previously exist.

## 15. Success Criteria

1. `ccloop ls <root>` lists every run directory beneath `<root>`, including
   damaged ones, with no row silently omitted.
2. A scan is provably byte-for-byte non-mutating, including against a run
   directory staged to trigger crash recovery.
3. The output contains no derived judgment about eligibility, resumability, or
   lease freshness — enforced by a test, not by convention.
4. No L1 or L1b code is modified, and none of §12's nineteen constraints is
   weakened.
5. Full suite, typecheck, and build clean, with no real (paid) Claude calls.
