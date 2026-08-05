# L2 — Run Registry (Discovery Only)

Status: approved 2026-07-28. Amended 2026-07-28 in eight places (a)–(h) after an
adversarial review against the code; every amendment is a document defect, not an
implementation defect. Index:

- **(a)** §4 — the recognition rationale was factually wrong; `owner-record.json`
  is not written by `initializeRunFiles`. Marker set also gained a fifth entry.
- **(b)** §6.2 / §6 — overstated versioning precedent; `eligibleForContinuation`
  is a literal type and carries less signal than implied.
- **(c)** §7.3 — `parseOwnerRecordForLease` validates 3 of the 5 owner fields §6
  observes, not all of them. Replaced with per-field observation.
- **(d)** §8 — **the atomic-write premise was false.** Two of three observed files
  are written non-atomically. Consistency model re-ruled.
- **(e)** §11 — the shape-failure row followed from the false (c), now corrected.
- **(f)** §12.1 — the crash-recovery fixture was described wrongly and would not
  have killed the implementation it targets.
- **(g)** §12.4 / §12.5 — one test killed nothing and courted flake; another
  killed the *correct* implementation.
- **(h)** §7.3, §15.4 — unqualified "§12" cross-references colliding with this
  document's own §12.
- **(i)** §11 — the table had no row for a file that is present but unreadable
  for a reason other than parse failure (`EACCES`). Found while writing the
  implementation plan; the omission would have forced the implementer to
  misreport such a file as `absent` or as a parse failure.
- **(j)** §8.1, §13 item 4 — **the two "Atomic? no" rows are no longer true, and
  unlike (a)–(i) this is not a document defect.** They were accurate against the
  code on 2026-07-28; the `2026-07-29-atomic-write-paths` branch (debt 4) then
  changed the code underneath them. Amended 2026-07-30 by that branch. The
  original rows are annotated in place, not rewritten: they record why §8.1's
  ruling exists, and that ruling still stands.

Layer position: L2 in the ownership-and-coordination stack. Parent design:
`2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17 item 2.
Predecessors, all implemented and merged: resume/adopt (`2026-07-25`), run lease +
heartbeat (`2026-07-26`, "L1"), owner-transfer contention (`2026-07-27`, "L1b").

## 1. Purpose

Answer one question: **which runs exist, and what state is each observed to be in?**

Today there is no answer. A run's identity *is* the operator-supplied `--run-dir`
path (`src/cli.ts:41`). There is no runs root, no index, no enumeration, no
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
7. modify L1 or L1b code, including the lease gate and the write paths.

*Amended (k) — item 6's "three debts" is stale. The 2026-07-29 debt-attribution
ruling (`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md:246`,
`:248`) reattributed debt 1 to L3 (it was misdescribed as unowned reconciliation
synthesis; the real defect is cross-file transactional) and debt 3 to L3, and
states explicitly: "L5 继承清单现在只剩 1 笔（债 2），不是 4 笔." §13 below still
lists three items under L5; that ruling was never executed there.*

Item 3 is the boundary against §17 item 2's literal wording ("scheduler /
unattended execution"). That wording spans two separable capabilities —
*discovery* and *triggering*. This spec takes discovery only. Triggering is
deferred to a later layer, which will need its own spec and its own answer to §13.

Item 7 is what forbids the otherwise-tempting fix in §8: making `writeRunState`
atomic would eliminate torn reads at the source, but a read-only discovery layer
must not rewrite another layer's write path. That option is recorded as a debt in
§13.4 instead.

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

*Amended (a).*

A directory is a run directory **iff it directly contains at least one of**:

```
loop-contract.json
loop-state.json
events.jsonl
owner-record.json
owner-transfer.json
```

Recognition is deliberately permissive, because these files are created at
different times by different code and a run can die between any two of them:

- `initializeRunFiles` (`src/persistence/fileStore.ts:72-78`) writes
  `loop-contract.json`, then `loop-state.json`, then `events.jsonl`, plus an
  `attempts/` directory. A crash between those three lines leaves a partial set.
- `owner-record.json` is **not** written by init. It first appears at
  `runLoop.ts`, the `writeOwnerRecord` call just below the lease gate — so a
  directory can hold a complete init set and no owner record at all.
- `owner-transfer.json` is renamed into place (`fileStore.ts:536`) *before* the
  owner record (`:538`) during transfer recovery, so the two can be observed out
  of step.

Requiring `loop-contract.json` alone would therefore drop real, damaged runs from
the listing — which is the wreckage an operator most needs to see. Omitting it
would make the tool least informative exactly when it matters most.

**Recognize permissively; report explicitly.** A recognized run whose
`loop-contract.json` is missing is reported as a row with that file marked
`absent` — not skipped, and not treated as "not a run".

## 5. Traversal Rules

1. Recursive descent from the caller-supplied root.
2. **Stop descending once a directory is recognized as a run directory.** Without
   this, `runDir/worktrees/attempt-N/` (`src/workspace/worktreeManager.ts:18`) — a
   git worktree that may itself contain an unrelated project, possibly including a
   `loop-contract.json` — would be reported as a nested run.
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
| `owner-transfer.json` | presence, and the value of `eligibleForContinuation` |

All eleven field names are verified against `src/state/types.ts:25-34` and
`src/runtime/types.ts:82-104`.

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

### 6.2 What `eligibleForContinuation` actually tells a reader

*Amended (b).*

`OwnerTransferRecord.eligibleForContinuation` is typed as the **literal `true`**
(`src/runtime/types.ts:103`). A well-formed record can only carry `true`.
Observing this field is therefore close to equivalent to observing that
`owner-transfer.json` exists and parses; it is reported because a reader looking
at the row should not have to know that, and because a value other than `true`
means the file is corrupt — which is worth seeing.

It is **not** a signal that the run may be continued. Per §3, that determination
belongs to `resumeLoop`'s gate, which checks it alongside four other conditions.

### 6.3 Schema version

The JSON output carries a `schemaVersion` field. There is one loosely comparable
precedent on disk — a `version: 1` field on the internal owner-transfer
transaction marker (`fileStore.ts:333`) — but that is a hidden staging file, not a
consumed contract. The field is included because this output is an interface a
later queue layer will consume, not because an established convention requires it.

## 7. Read Path and the Zero-Write Guarantee

### 7.1 Forbidden reader

`readOwnerRecord` (`fileStore.ts:566`) **must not be called.** It calls
`recoverInterruptedOwnerTransfer` (`:549`), which under the conditions in §12.1
finalizes a pending transfer — renaming and unlinking files. A read-only listing
command that mutates another process's run directory is the worst failure this
layer could produce.

Use `readOwnerRecordWithoutRecovery` (`fileStore.ts:628`).

### 7.2 Verified-pure readers

The following are verified to be pure reads (`readFile` + `JSON.parse`, no write):

- `readRunState` (`fileStore.ts:697`)
- `readOwnerTransferRecord` (`fileStore.ts:701`)
- `readOwnerRecordWithoutRecovery` (`fileStore.ts:628`) → `readOwnerRecordRaw`
  (`:371-373`)

`readReconciliationRecord` (`fileStore.ts:705`) is also pure but is **not used** —
§6 does not observe `reconciliation-record.json`.

These are reused for I/O and parsing rather than reimplemented, so that no second
JSON-reading implementation exists to drift from the first. Each reused reader
gets a test pinning it as side-effect-free (§12.1).

### 7.3 Validation is per-field, and belongs to this layer

*Amended (c), (h).*

The readers in §7.2 are **blind casts** (`JSON.parse(...) as RunState`) and they
**throw** on ENOENT and on malformed JSON. So the scanner must catch, and must
distinguish *absent* (ENOENT) from *unreadable* (parse failure) — the readers
collapse both into a throw.

Crucially, **no existing validator covers the field set §6 observes.** The
obvious candidate, `parseOwnerRecordForLease` (`src/ownership/lease.ts:64-94`),
validates exactly three things: `currentProcessInstanceId` is a non-empty string,
`currentOwnerEpoch` is an integer, and `leaseAffirmedAt` is a string or null if
present. It validates neither `runId` nor `ownerStatus` — two of the five owner
fields in §6. An owner record missing `runId` passes it unchanged and would be
reported as a healthy row, which is precisely the failure this section exists to
prevent.

Therefore the registry performs its own **per-field** observation: for each field
named in §6, check presence and type independently, and mark that field
`present` / `absent` / `unreadable(shape)` on its own.

Two consequences worth stating, because both were ambiguous before this
amendment:

1. Field-level granularity is real. A record with a valid `runId` and a
   non-string `currentOwnerEpoch` yields one `present` field and one
   `unreadable(shape)` field in the same row — not an all-or-nothing verdict.
2. This is **not** a second eligibility implementation, and does not violate §2.1.
   It checks field presence and JSON type only. It assigns no meaning to any
   value, compares nothing against a clock, and reaches no conclusion.

L1 §12 #7 ("corrupt record is refused, not mistaken for absent") names
`readOwnerRecordRaw` as the reader that accepts a structurally valid object
silently. Per-field observation is how this layer honors that constraint.

### 7.4 The lease gate is not reusable

`checkRunLease` (`src/controller/leaseGate.ts:16`) appends a
`lease_expired_observed` event (`:58`) when it observes an expired lease. It
writes. It cannot be called from a zero-write scanner, and it must not be
refactored to accommodate one — L1 §12 has constraints pinned to its current
behavior.

## 8. Consistency Model

*Amended (d) — this section previously rested on a false premise and its
conclusion has been re-ruled.*

Two different problems live here. The previous draft conflated them, having
wrongly assumed every observed file is written by atomic rename.

### 8.1 Torn reads are real, for two of the three files

Verified writer by writer:

| File | Writer | Atomic? |
|---|---|---|
| `owner-transfer.json` | `finalizePendingOwnerTransfer` (`fileStore.ts:535-536`), rename | **yes** |
| `owner-record.json` | affirm / release / claim via `writeOwnerRecordAtomically` (`:632-637`), rename | yes on those paths |
| `owner-record.json` | **initial creation** via `writeOwnerRecord` (`:379-381`) → `writeJsonFile` (`:367-369`), bare `writeFile` | **no** |
| `loop-state.json` | `writeRunState` (`fileStore.ts:80-82`), bare `writeFile` | **no** |

`loop-state.json` is the file §6 leans on hardest and it is rewritten on every
state transition, with no temp file and no rename. A scan that reads it
mid-write can observe truncated JSON.

*Amended (j) — the table above and the paragraph above it describe the code as
it stood on 2026-07-28 and no longer describe the code. The
`2026-07-29-atomic-write-paths` branch (debt 4) routed both **no** writers —
`writeOwnerRecord` and `writeRunState` — through a temp-file-plus-rename helper
(`writeJsonFileAtomically` in `src/persistence/fileStore.ts`, staging under a
process-unique temp name), so all four rows now publish by rename and
`loop-state.json` is no longer rewritten in place. They are left standing rather
than corrected because they are the recorded reason the ruling below exists.*

*What that branch did **not** change, deliberately: this layer. Both files stay
`atomic: false` in `OBSERVED_FILES`, and the bounded re-read below stays, as
defence in depth should a non-atomic write point ever be added back — that
branch's design (`2026-07-29-atomic-write-paths-design.md` §5) rules flipping
them out of its scope. Nor does it reach §8.2: rename buys a concurrent reader
visibility atomicity for one file, not cross-file consistency, and not crash
durability — this repository has no `fsync` anywhere.*

**Ruling: bounded re-read for the non-atomic files only.** On *parse failure* of
`loop-state.json` or `owner-record.json`, re-read using the existing constants
`LEASE_VERIFY_READ_ATTEMPTS = 3` and `LEASE_VERIFY_RETRY_DELAY_MS = 50`
(`src/ownership/lease.ts:7-8`) — worst case +100 ms per affected file. If it
still fails, report `unreadable(parse)`, which is now a meaningful claim rather
than a possibly-transient artifact.

Retry applies to parse failure only. ENOENT resolves immediately to `absent`
with no retry: a missing file is not a race, and retrying would make a scan of a
large tree of half-initialized runs needlessly slow. `owner-transfer.json` is
atomic and is read once.

### 8.2 Cross-file inconsistency remains, and is not fixable here

A row assembles several files, and the combination is not a snapshot: a scan may
read a pre-transfer `owner-record.json` alongside a post-transfer
`owner-transfer.json`.

**The §8.1 retry does not address this and must not be described as if it does.**
That is not a torn read; it is a timing mismatch between independent files, and
re-reading either one cannot align them. A true snapshot would require a lock,
and taking a lock means writing — which contradicts §3 — and would let a
read-only listing command block real work.

Therefore: `observedAt` is stamped on every row, and both the documentation and
the human-readable output state plainly that fields within a row are independent
observations and do not constitute a consistent snapshot.

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

`ls` deliberately does not use exit code `2`. In the existing CLI, `2` means "the
loop ran and did not succeed" (`src/cli.ts:92`) — a statement about a run's
outcome. `ls` never runs a loop and so has no outcome to report; reusing `2`
would blur a distinction the existing codes draw cleanly.

## 10. Module Boundaries

New directory `src/registry/`:

- `scanRuns.ts` — the scan itself, written against an injected filesystem-read
  interface so it is testable without a real tree, returning `RunObservation[]`.
  The injected interface is also what makes §12.4 deterministic.
- CLI wiring does argument parsing and rendering only. No observation logic in
  `cli.ts`.

Tests live in `tests/registry/`, mirroring `src/` as the existing suite does.

## 11. Error Handling Summary

*Amended (e).*

| Condition | Result |
|---|---|
| File missing (ENOENT) | every field from that file `absent`; no retry |
| Malformed JSON, non-atomic file | retry per §8.1; if still failing, every field from that file `unreadable(parse)` |
| Malformed JSON, atomic file | every field from that file `unreadable(parse)`; no retry |
| Field missing from a parsed object | that field `absent` |
| Field present with wrong JSON type | that field `unreadable(shape)` |
| File unreadable for another reason (e.g. `EACCES`) | every field from that file `unreadable(io)`; no retry |
| Directory unreadable | row recording the failure; scan continues |
| Depth limit hit | row recording truncation |
| Root missing / unreadable | exit `1` |

Rows 4 and 5 are per-field and independent, per §7.3. Nothing in this table
results in a silently dropped row.

## 12. Test Requirements

*Amended (f), (g).*

These are the requirements the implementation plan must expand. Each is written to
fail against a specific plausible wrong implementation.

1. **Zero-write proof.** Snapshot the whole tree as `(path, size, mtime,
   content-hash)` before and after a scan; assert byte-identical.

   This must include a fixture that genuinely triggers `readOwnerRecord`'s
   recovery, which requires **all** of: `.owner-transfer.transaction.json`
   present (`fileStore.ts:552` — the trigger), both `.owner-record.pending.json`
   and `.owner-transfer.pending.json` present (`finalizePendingOwnerTransfer`
   reads them and throws ENOENT otherwise), and `.owner-transfer.lock` **absent**
   (with a live lock, `readOwnerRecord` returns without writing, `:559-561`).

   The earlier description of this fixture — "`owner-record.json` in the state
   that triggers crash recovery" — was wrong, and a fixture built to it would
   pass even against an implementation calling `readOwnerRecord`. That is the
   exact wrong implementation §7.1 exists to kill, so the fixture's precondition
   set is load-bearing and must be asserted, not assumed.

2. **Corrupt is not absent.** Three separate cases — malformed JSON, missing file,
   and a parsed object with a required field of the wrong type — must each appear
   in the output: `unreadable(parse)`, `absent`, and `unreadable(shape)`
   respectively. None may be silently skipped. The third case must use a field
   `parseOwnerRecordForLease` does **not** validate (`runId` or `ownerStatus`),
   so that it fails against an implementation that reached for that parser
   instead of doing per-field observation (§7.3).

3. **No descent into a recognized run.** Place a complete, valid run directory at
   `runDir/worktrees/attempt-1/` and assert it does not appear in the results
   (§5.2).

4. **Torn reads are retried; missing files are not.** Using the injected read
   interface (§10), simulate `loop-state.json` returning truncated JSON on the
   first read and valid JSON on the second; assert the row reports the parsed
   values, and assert the read was attempted more than once. Separately assert an
   ENOENT is **not** retried.

   This replaces an earlier requirement to "scan a run whose heartbeat is actively
   writing". That test could not fail deterministically — the heartbeat's only
   write is `affirmOwnerLease` → `writeOwnerRecordAtomically`, a rename, so it
   cannot produce a torn read — and it would have added timing flake to a branch
   that already carries flake debt, in exchange for no coverage. The real
   concurrency exposure is `writeRunState` (§8.1), and injection tests it
   deterministically.

5. **Zero derivation is a failing test, not a documentation promise.** Assert the
   output schema contains no field matching `resumable` / `fresh` / `stale` /
   `expired`, and no field whose name contains `eligible` **other than the
   observed literal `eligibleForContinuation`** (§6.2).

   The exemption is required: the earlier form of this test forbade all
   `eligible`-matching names while §6 mandates observing
   `eligibleForContinuation`, so it would have killed the correct implementation.
   The test's real target is a future well-meaning derived column, and it must be
   written so that adding one fails while §6's mandated field passes.

6. **Permissive recognition.** A directory containing only `events.jsonl`, one
   containing only `owner-record.json`, and one containing only
   `owner-transfer.json` are each recognized and reported, with the remaining
   files marked `absent` (§4).

7. **Traversal limits.** A tree nested deeper than 10 below the root produces a
   truncation row rather than silence or a thrown error; a directory whose
   permissions deny reading produces a failure row and the scan still returns the
   other rows (§5.4, §5.5).

8. **Exit code.** A scan producing `unreadable` rows exits `0`; a scan whose root
   does not exist exits `1`; neither exits `2` (§9).

## 13. Inherited Debts — Explicitly Not Taken

Debts 1–3 are bequeathed to L5 and are unchanged by this layer. This layer does
not make any of them more reachable — a direct consequence of choosing discovery
over triggering: a read-only scanner adds no caller to any of the affected paths.
Debt 4 is new, and is recorded by this layer rather than taken by it.

*Amended (l) — "Debts 1–3 are bequeathed to L5" is stale. The 2026-07-29
debt-attribution ruling (`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md:246`,
`:248`) moved debt 1 to L3 (reattributed from "unowned reconciliation synthesis"
to a cross-file transactional defect) and debt 3 to L3. Neither item 1 nor item
3 below carries an `Amended` note reflecting that move — item 3 has an inline
sentence pointing at "the deferred queue layer," but it does not correct this
paragraph's "bequeathed to L5" framing. "L5 继承清单现在只剩 1 笔（债 2），
不是 4 笔" per that ruling — the three-item list below was never renumbered.*

1. **Reconciliation synthesis is unowned.** Consequence of the L1b ruling that
   the `writeBoundaryArtifacts` call is guarded unconditionally
   (`src/controller/runLoop.ts`, the `heartbeat.assertHeld()` / `writeBoundaryArtifacts` pair). A completed `owner-transfer.json` may
   now exist with neither `boundary-analysis.json` nor
   `reconciliation-record.json`.
   *Effect here:* none. §6 does not observe either file, so the registry neither
   synthesizes them nor reports on their absence. A row may show
   `eligibleForContinuation: true` for a run that has no reconciliation record on
   disk; that is the debt showing through, not a registry defect.

2. **`persistTerminalState` writes into a run it no longer owns**
   (`src/controller/runLoop.ts`, the `persistTerminalState` calls reached from
   the lease-loss branches — `if (leaseLoss.lost !== null)` and
   `if (isLeaseStopError(error))`, two of each). "The three call sites" was
   wrong in both halves: the symbol has fifteen call sites in that file, and the
   subset this debt is about is four, not three. Re-derive both numbers with
   `grep -c 'await persistTerminalState(' src/controller/runLoop.ts` and
   `grep -nE 'leaseLoss\.lost !== null|isLeaseStopError\(error\)' src/controller/runLoop.ts`
   rather than trusting either.
   *Effect here:* none. The registry adds no caller.

3. **`heartbeat.stop()` release window** — a `runExclusive` begun after the queue
   snapshot (`src/controller/leaseHeartbeat.ts:223`) is not awaited by `stop()`,
   which proceeds to `releaseOwnerLease` (`:231`). Reviewed as unreachable today
   because the only production `runExclusive` caller is `persistBoundaryAnalysis`
   (see `persistBoundaryAnalysis` in `runLoop.ts` and its `runExclusive` call), invoked from
   its two call sites inside `runLoopFromState`, while both `stop()` sites
   sit in a `finally` after `await runLoopFromState` (`runLoop.ts`, the `await heartbeat.stop()` in the `finally`,
   `resumeLoop.ts:185`). Re-verified as still holding on 2026-07-28.
   *Effect here:* none — the registry never starts a heartbeat. **This debt must be
   re-evaluated by whichever layer adds a triggering caller**, which is the
   deferred queue layer, not this one.

4. **`writeRunState` and initial `writeOwnerRecord` are non-atomic** (§8.1).
   Every other owner-record write path uses temp-file-plus-rename; these two do
   not, and `loop-state.json` is rewritten on every transition. This layer works
   around it with a bounded re-read (§8.1) rather than fixing it, because §2.7
   forbids a discovery layer from rewriting another layer's write path.
   *Owner:* unassigned. The workaround is sound for a reader, but any future
   consumer that needs a coherent `loop-state.json` read — including the queue
   layer — inherits the same problem and the same 100 ms cost.

   *Amended (j) — this debt is discharged at the write side. The
   `2026-07-29-atomic-write-paths` branch (debt 4) made both writers publish by
   rename (§8.1 amendment), so the item's opening claim no longer holds and no
   future consumer inherits a live torn-write source from these two files. The
   workaround itself is kept on purpose, so the 100 ms bound is still what a
   parse failure costs — it is now defence in depth rather than a live
   dependency.*

## 14. Follow-On

1. **Queue / triggering layer.** The remaining half of parent §17 item 2: when and
   by whom a discovered, eligible run is re-queued or continued. It consumes this
   layer's `--json` contract, must pass `resumeLoop`'s gate unchanged, and must
   re-evaluate debt §13.3 before adding any caller.
2. **L5 cleanup / orphan GC.** Parent §17 item 3, still unwritten, and now
   holding the debts in §13. This layer makes L5 easier to write — collecting
   orphans requires enumerating runs, which did not previously exist.

## 15. Success Criteria

1. `ccloop ls <root>` lists every run directory beneath `<root>`, including
   damaged ones, with no row silently omitted.
2. A scan is provably byte-for-byte non-mutating, including against a run
   directory staged to genuinely trigger crash recovery per §12.1.
3. The output contains no derived judgment about eligibility, resumability, or
   lease freshness — enforced by a test, not by convention.
4. No L1 or L1b code is modified, and none of **L1 §12**'s nineteen constraints is
   weakened.
5. Full suite, typecheck, and build clean, with no real (paid) Claude calls.
