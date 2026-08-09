# Probe: does busy-lock-abandon (D2) make a run non-resumable?

## Question

D2 (`86e7aa4`, `src/persistence/fileStore.ts`) makes a run that abandons its ownership
transfer on a persistently busy `.owner-transfer.lock` never write
`reconciliation-record.json`. `resumeLoop` reads that file through the unguarded
`readReconciliationRecord` inside a `Promise.all`, turning any read failure into
`resume_denied` + `ResumeNotEligibleError`. Does this chain actually make such a run
non-resumable?

## Method

Reused the setup from `leaseLifecycle.integration.test.ts`'s
`"appends owner_transfer_contended and abandons the transfer when the owner-transfer lock
stays busy"` test in a temporary probe (`tests/controller/tmp-resume-probe.test.ts`,
deleted after measurement): ran `runLoop` to the busy-lock-abandon state, then called the
real `resumeLoop` on the same run dir and recorded the outcome. Ran once at HEAD (D2
applied) and once with `git checkout 2af4137 -- src` (pre-D2 sources, control).

## Result

**Same outcome in both cases** — `resumeLoop` throws `ResumeNotEligibleError`, exactly one
`resume_denied` event is appended, in both HEAD and the pre-D2 control.

| | HEAD (D2) | Control (pre-D2, `2af4137`) |
|---|---|---|
| `reconciliation-record.json` written by the abandon? | No | Yes |
| `owner-transfer.json` written by the abandon? | No | No |
| `resumeLoop` outcome | throws `ResumeNotEligibleError` | throws `ResumeNotEligibleError` |
| Error message | `cannot read run artifacts: Error: ENOENT: ... open '.../owner-transfer.json'` | `cannot read run artifacts: Error: ENOENT: ... open '.../owner-transfer.json'` |
| `resume_denied` events appended | 1 | 1 |

D2's effect on `reconciliation-record.json` is real and reproduced directly: the existing
test itself fails at HEAD with `ENOENT ... reconciliation-record.json` when its own
assertions try to read that file (it passes cleanly against the pre-D2 control).

But the **resume outcome does not change**, because `owner-transfer.json` is *also* never
staged when the owner-transfer lock stays busy — a fact the existing test already asserts
(`await expect(access(join(runDir, "owner-transfer.json"))).rejects.toThrow(); // never
staged`) and one that has nothing to do with D2 (it holds identically pre- and post-D2,
confirmed above). `resumeLoop`'s `Promise.all` reads `owner-transfer.json` through the
same unguarded pattern (`readOwnerTransferRecord`), and that read's `ENOENT` is what
surfaces in both runs — `reconciliation-record.json`'s presence or absence never gets a
chance to matter, because the `Promise.all` has already failed on the sibling read either
way.

## Verdict: REFUTED

D2 is not the cause of non-resumability in this state. A run left in the busy-lock-abandon
state was already non-resumable before D2 (via the missing `owner-transfer.json`, through
the identical unguarded-read pattern in `resumeLoop`). D2 changes what's on disk
(`reconciliation-record.json` now also missing) but does not change whether the run can be
resumed — it was already refused, for an independent, pre-existing reason.

## Caveats

- This measures one specific scenario (lock busy for the entire attempt, `runLoop`'s single
  abandon path from a cold run dir). It does not rule out some other scenario where
  `reconciliation-record.json` is missing while `owner-transfer.json` is present — that
  combination was not constructed or tested here.
- `Promise.all` rejects on whichever of its five reads fails first; which ENOENT message
  surfaces is a race, not deterministic ordering. Both runs happened to surface the
  `owner-transfer.json` error, but this doesn't establish that `reconciliation-record.json`
  could never win that race in some other timing.
