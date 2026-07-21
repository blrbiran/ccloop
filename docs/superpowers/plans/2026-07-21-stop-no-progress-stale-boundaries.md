# Stop, No-Progress, and Stale-Run Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the run-level stop, no-progress, and stale-run boundary layer needed before future unattended scheduling can be considered safe, including explicit reconciliation records and deny-by-default auto-takeover gating.

**Architecture:** Extend the current run-state and controller persistence surfaces with a narrow boundary-layer model instead of mixing these concepts into business outcome state. Add a controller-owned analysis record for stale suspicion and reconciliation conclusions, then teach the stop logic and validation layer to distinguish `no-progress`, `stale-candidate`, and `stale-confirmed` without implementing full scheduler, ownership, or resume semantics.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Vitest, existing controller/persistence/state/validation modules

## Global Constraints

- Do not implement scheduler or daemon behavior.
- Do not implement full ownership, fencing, lease, or heartbeat mechanisms.
- Do not implement full resume or adopt semantics.
- Do not modify current V1 product code beyond the narrow boundary layer required by this spec.
- Do not authorize any real or paid Claude run.
- Do not rewrite accepted historical evidence.
- Do not define cleanup, orphan GC, or workspace-retention policy as part of stale detection.
- Accepted historical evidence remains immutable. In particular, `D-01` stays `INCONCLUSIVE / CONTRACT_GAP` unless a separate `review-reclassified.json` is explicitly requested later.
- The stop/stale boundary layer may classify run liveness and continuity, but it may not rewrite accepted historical outcome records.
- Auto-takeover is deny-by-default.
- Stale detection and reconciliation must not silently delete evidence or workspaces.
- User-facing task result, stale/reconciliation result, and takeover permission must remain separate.
- Cleanup, orphan detection, retained-workspace GC, and similar operational maintenance are out of scope for this implementation.
- Reconciliation must emit an explicit controller-owned record with stale suspicion basis, stale confirmation verdict, last trusted run boundary, conflicting evidence summary if any, takeover-allowed verdict, and why takeover is allowed or denied.
- Future implementation must prove: time-window overrun alone does not directly become `no-progress`; weak progress does not provide infinite life support; `no-progress` cannot auto-continue; `stale-confirmed` without stronger conditions still cannot auto-continue; accepted historical evidence is not rewritten by this layer.

---

## File Structure

- Modify: `src/state/types.ts` — add boundary-layer analysis types, reconciliation result types, and explicit takeover-permission result types without changing business run outcome semantics.
- Modify: `src/stop/stopController.ts` — split current stop evaluation from the new boundary-layer evaluation and make `no-progress` vs stale routing explicit.
- Modify: `src/controller/runLoop.ts` — persist boundary observations, invoke boundary evaluation at the correct run-level checkpoints, and write reconciliation records without implementing full scheduler or resume.
- Modify: `src/persistence/fileStore.ts` — persist controller-owned boundary-analysis and reconciliation records under the run directory.
- Modify: `src/runtime/types.ts` — add narrow types for reconciliation audit records if the controller owns them there instead of state types.
- Modify: `validation/v1/lib/evidence.ts` — read and validate the new boundary/reconciliation artifacts as evidence surfaces without changing accepted historical review meaning.
- Modify: `validation/v1/README.md` — document the new boundary-layer artifacts and the fact that stale analysis does not authorize cleanup or history rewrites.
- Modify: `docs/handover/ccloop-handover.md` — note the new stop/stale boundary layer as future unattended-execution groundwork once implemented.
- Test: `tests/controller/runLoop.integration.test.ts` — run-level progress/no-progress/stale routing and reconciliation-record persistence.
- Test: `tests/persistence/fileStore.test.ts` — persistence of boundary-analysis and reconciliation artifacts.
- Test: `tests/validation/evidence.test.ts` — validation and audit behavior for the new controller-owned records.
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`, `.wolf/cerebrum.md`, `.wolf/buglog.json` — required OpenWolf updates while implementing.

### Task 1: Add boundary-layer state and reconciliation record types

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/runtime/types.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes:
  - existing `RunState` from `src/state/types.ts`
  - existing `ExecutionRecovery` from `src/runtime/types.ts`
- Produces:
  - `type RunBoundaryStatus = "healthy" | "weakly_progressing" | "suspect" | "no_progress" | "stale_candidate" | "stale_confirmed"`
  - `type TakeoverPermission = { allowed: boolean; reason: string }`
  - `type ReconciliationRecord = { staleSuspicionBasis: string[]; staleConfirmed: boolean; lastTrustedBoundary: "planning" | "execute" | "verify" | "terminal" | "unknown"; conflictingEvidence: string[]; takeoverPermission: TakeoverPermission; }`
  - `type RunBoundaryAnalysis = { status: RunBoundaryStatus; strongProgressAt: string | null; weakProgressAt: string | null; suspectReason: string | null; staleCandidateReason: string | null; }`

- [ ] **Step 1: Write the failing persistence/type test**

```ts
it("writes boundary-analysis and reconciliation records when present", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

  await writeBoundaryArtifacts(runDir, {
    boundaryAnalysis: {
      status: "stale_confirmed",
      strongProgressAt: "2026-07-21T10:00:00.000Z",
      weakProgressAt: "2026-07-21T10:05:00.000Z",
      suspectReason: "healthy window exceeded",
      staleCandidateReason: "continuity evidence missing",
    },
    reconciliationRecord: {
      staleSuspicionBasis: ["healthy window exceeded", "state freshness mismatch"],
      staleConfirmed: true,
      lastTrustedBoundary: "execute",
      conflictingEvidence: [],
      takeoverPermission: {
        allowed: false,
        reason: "ownership not yet mechanically proven",
      },
    },
  });

  const analysis = JSON.parse(
    await readFile(join(runDir, "boundary-analysis.json"), "utf8"),
  ) as { status: string };
  const reconciliation = JSON.parse(
    await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
  ) as { staleConfirmed: boolean; takeoverPermission: { allowed: boolean } };

  expect(analysis.status).toBe("stale_confirmed");
  expect(reconciliation.staleConfirmed).toBe(true);
  expect(reconciliation.takeoverPermission.allowed).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/persistence/fileStore.test.ts`
Expected: FAIL because `writeBoundaryArtifacts` and the new types do not exist yet.

- [ ] **Step 3: Add the minimal types and persistence interface**

```ts
export type RunBoundaryStatus =
  | "healthy"
  | "weakly_progressing"
  | "suspect"
  | "no_progress"
  | "stale_candidate"
  | "stale_confirmed";

export type TakeoverPermission = {
  allowed: boolean;
  reason: string;
};

export type ReconciliationRecord = {
  staleSuspicionBasis: string[];
  staleConfirmed: boolean;
  lastTrustedBoundary: "planning" | "execute" | "verify" | "terminal" | "unknown";
  conflictingEvidence: string[];
  takeoverPermission: TakeoverPermission;
};

export type RunBoundaryAnalysis = {
  status: RunBoundaryStatus;
  strongProgressAt: string | null;
  weakProgressAt: string | null;
  suspectReason: string | null;
  staleCandidateReason: string | null;
};
```

```ts
export async function writeBoundaryArtifacts(
  runDir: string,
  artifacts: {
    boundaryAnalysis: RunBoundaryAnalysis;
    reconciliationRecord?: ReconciliationRecord;
  },
): Promise<void> {
  await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify(artifacts.boundaryAnalysis, null, 2));

  if (artifacts.reconciliationRecord !== undefined) {
    await writeFile(
      join(runDir, "reconciliation-record.json"),
      JSON.stringify(artifacts.reconciliationRecord, null, 2),
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/persistence/fileStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/runtime/types.ts src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: add run boundary analysis records"
```

### Task 2: Add explicit boundary evaluation for run-level progress and stale suspicion

**Files:**
- Modify: `src/stop/stopController.ts`
- Modify: `src/state/types.ts`
- Test: `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes:
  - `RunBoundaryAnalysis`
  - `ExecutionRecovery`
  - existing `RunState`, `StopDecisionInput`
- Produces:
  - `type BoundaryEvaluationInput = { now: string; previous: RunBoundaryAnalysis | null; runState: RunState; observedStrongProgress: boolean; observedWeakProgress: boolean; continuitySuspicion: string[]; }`
  - `function evaluateRunBoundary(input: BoundaryEvaluationInput): RunBoundaryAnalysis`
  - explicit status transitions that distinguish `no_progress` from `stale_candidate`

- [ ] **Step 1: Write the failing boundary-evaluation tests**

```ts
it("routes to no_progress when strong progress stops and weak progress is exhausted without stale evidence", () => {
  const result = evaluateRunBoundary({
    now: "2026-07-21T10:10:00.000Z",
    previous: {
      status: "weakly_progressing",
      strongProgressAt: "2026-07-21T10:00:00.000Z",
      weakProgressAt: "2026-07-21T10:05:00.000Z",
      suspectReason: null,
      staleCandidateReason: null,
    },
    runState: makeRunState("executing"),
    observedStrongProgress: false,
    observedWeakProgress: false,
    continuitySuspicion: [],
  });

  expect(result.status).toBe("no_progress");
  expect(result.suspectReason).toBe("weak progress exhausted without strong progress");
});

it("routes to stale_candidate when continuity suspicion outranks generic no-progress", () => {
  const result = evaluateRunBoundary({
    now: "2026-07-21T10:10:00.000Z",
    previous: {
      status: "suspect",
      strongProgressAt: "2026-07-21T10:00:00.000Z",
      weakProgressAt: null,
      suspectReason: "healthy window exceeded",
      staleCandidateReason: null,
    },
    runState: makeRunState("executing"),
    observedStrongProgress: false,
    observedWeakProgress: false,
    continuitySuspicion: ["state freshness mismatch"],
  });

  expect(result.status).toBe("stale_candidate");
  expect(result.staleCandidateReason).toContain("state freshness mismatch");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`
Expected: FAIL because `evaluateRunBoundary` and the new boundary fields do not exist.

- [ ] **Step 3: Add the minimal boundary evaluation logic**

```ts
export type BoundaryEvaluationInput = {
  now: string;
  previous: RunBoundaryAnalysis | null;
  runState: RunState;
  observedStrongProgress: boolean;
  observedWeakProgress: boolean;
  continuitySuspicion: string[];
};

export function evaluateRunBoundary(input: BoundaryEvaluationInput): RunBoundaryAnalysis {
  if (input.observedStrongProgress) {
    return {
      status: "healthy",
      strongProgressAt: input.now,
      weakProgressAt: input.previous?.weakProgressAt ?? null,
      suspectReason: null,
      staleCandidateReason: null,
    };
  }

  if (input.continuitySuspicion.length > 0) {
    return {
      status: "stale_candidate",
      strongProgressAt: input.previous?.strongProgressAt ?? null,
      weakProgressAt: input.previous?.weakProgressAt ?? null,
      suspectReason: "healthy window exceeded",
      staleCandidateReason: input.continuitySuspicion.join("; "),
    };
  }

  if (input.observedWeakProgress) {
    return {
      status: "weakly_progressing",
      strongProgressAt: input.previous?.strongProgressAt ?? null,
      weakProgressAt: input.now,
      suspectReason: null,
      staleCandidateReason: null,
    };
  }

  return {
    status: "no_progress",
    strongProgressAt: input.previous?.strongProgressAt ?? null,
    weakProgressAt: input.previous?.weakProgressAt ?? null,
    suspectReason: "weak progress exhausted without strong progress",
    staleCandidateReason: null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`
Expected: PASS for the new boundary-evaluation tests.

- [ ] **Step 5: Commit**

```bash
git add src/stop/stopController.ts src/state/types.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat: classify run no-progress versus stale suspicion"
```

### Task 3: Persist reconciliation records and deny-by-default takeover gating in the controller

**Files:**
- Modify: `src/controller/runLoop.ts`
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes:
  - `evaluateRunBoundary(input): RunBoundaryAnalysis`
  - `writeBoundaryArtifacts(runDir, artifacts)`
  - `ReconciliationRecord`
- Produces:
  - persistence of `boundary-analysis.json` for runs that leave `healthy`
  - persistence of `reconciliation-record.json` for stale-candidate reconciliation outcomes
  - deny-by-default `takeoverPermission.allowed === false` until stronger conditions are explicitly proven

- [ ] **Step 1: Write the failing controller integration test for stale reconciliation output**

```ts
it("writes a deny-by-default reconciliation record when stale suspicion is confirmed", async () => {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const contract = createContract(repoPath);

  const adapter: RuntimeAdapter = {
    async plan() {
      return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
    },
    async execute() {
      return null;
    },
    async verify() {
      throw new Error("verify should not run");
    },
  };

  await runLoop(contract, runDir, adapter);

  const reconciliation = JSON.parse(
    await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
  ) as { staleConfirmed: boolean; takeoverPermission: { allowed: boolean; reason: string } };

  expect(reconciliation.staleConfirmed).toBe(true);
  expect(reconciliation.takeoverPermission.allowed).toBe(false);
  expect(reconciliation.takeoverPermission.reason).toContain("deny-by-default");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`
Expected: FAIL because the controller does not yet write reconciliation records.

- [ ] **Step 3: Add the minimal controller-owned reconciliation record write**

```ts
const boundaryAnalysis = evaluateRunBoundary({
  now: new Date().toISOString(),
  previous: null,
  runState: state,
  observedStrongProgress: false,
  observedWeakProgress: false,
  continuitySuspicion: ["execution continuity not trustworthy"],
});

await writeBoundaryArtifacts(runDir, {
  boundaryAnalysis,
  reconciliationRecord:
    boundaryAnalysis.status === "stale_candidate"
      ? {
          staleSuspicionBasis: [boundaryAnalysis.staleCandidateReason ?? "unknown stale suspicion"],
          staleConfirmed: true,
          lastTrustedBoundary: "execute",
          conflictingEvidence: [],
          takeoverPermission: {
            allowed: false,
            reason: "deny-by-default until stronger mechanical takeover conditions exist",
          },
        }
      : undefined,
});
```

- [ ] **Step 4: Run focused controller tests to verify they pass**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`
Expected: PASS for the new reconciliation-record scenario and existing controller coverage.

- [ ] **Step 5: Commit**

```bash
git add src/controller/runLoop.ts src/persistence/fileStore.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat: persist stale reconciliation decisions"
```

### Task 4: Teach the validation layer to read the new controller-owned boundary artifacts

**Files:**
- Modify: `validation/v1/lib/evidence.ts`
- Test: `tests/validation/evidence.test.ts`

**Interfaces:**
- Consumes:
  - `boundary-analysis.json`
  - `reconciliation-record.json`
  - existing `EvidenceRecord`
- Produces:
  - `EvidenceRecord["observations"]` entries for boundary analysis and reconciliation records
  - validation that malformed reconciliation records are surfaced as `INVALID`, not trusted truth

- [ ] **Step 1: Write the failing evidence-layer test**

```ts
it("marks malformed reconciliation-record.json as INVALID instead of trusting it", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "ccloop-evidence-"));
  await mkdir(join(runDir, "attempts", "1"), { recursive: true });
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({ status: "failed" }));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify({ status: "stale_candidate" }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({ staleConfirmed: "yes" }));

  const record = await collectEvidence(makeEvidenceInput(runDir, evidenceDir));

  expect(record.observations.reconciliationRecord.status).toBe("INVALID");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/validation/evidence.test.ts`
Expected: FAIL because the evidence layer does not yet read reconciliation records.

- [ ] **Step 3: Add the minimal validation support**

```ts
const reconciliationRecordSchema = z
  .object({
    staleSuspicionBasis: z.array(z.string()).min(1),
    staleConfirmed: z.boolean(),
    lastTrustedBoundary: z.enum(["planning", "execute", "verify", "terminal", "unknown"]),
    conflictingEvidence: z.array(z.string()),
    takeoverPermission: z.object({
      allowed: z.boolean(),
      reason: z.string().trim().min(1),
    }),
  })
  .strict();
```

```ts
reconciliationRecord: {
  status: "PRESENT" | "MISSING" | "INVALID";
  path: string;
  value?: ReconciliationRecord;
  error?: string;
}
```

- [ ] **Step 4: Run focused validation tests to verify they pass**

Run: `npm test -- tests/validation/evidence.test.ts`
Expected: PASS for the new malformed-record coverage and existing evidence coverage.

- [ ] **Step 5: Commit**

```bash
git add validation/v1/lib/evidence.ts tests/validation/evidence.test.ts
git commit -m "feat: validate boundary reconciliation artifacts"
```

### Task 5: Align operator docs and handover with the new boundary layer

**Files:**
- Modify: `validation/v1/README.md`
- Modify: `docs/handover/ccloop-handover.md`
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`
- Modify only if a genuinely new durable rule emerged: `.wolf/cerebrum.md`
- Modify: `.wolf/buglog.json`

**Interfaces:**
- Consumes:
  - implemented `boundary-analysis.json` and `reconciliation-record.json` artifact names
  - deny-by-default auto-takeover rule
  - cleanup-out-of-scope rule
- Produces:
  - operator-facing docs that explain the new boundary artifacts and limits without implying scheduler or resume already exist

- [ ] **Step 1: Write the docs-only failing check by asserting the new artifact names are absent**

```bash
rg -n "boundary-analysis.json|reconciliation-record.json|deny-by-default|cleanup is a separate concern" validation/v1/README.md docs/handover/ccloop-handover.md
```

Expected: the command either finds nothing or does not yet describe the new boundary layer truthfully enough.

- [ ] **Step 2: Update `validation/v1/README.md` and `docs/handover/ccloop-handover.md`**

Add concise operator-facing language that says:

```md
- `boundary-analysis.json` is a controller-owned run-level progress/stale analysis artifact.
- `reconciliation-record.json` is a controller-owned stale-reconciliation audit artifact.
- `stale-confirmed` does not itself authorize continuation; auto-takeover remains deny-by-default unless a later ownership/resume design explicitly proves the stronger conditions.
- stale detection and reconciliation do not authorize cleanup or historical evidence rewrites.
```

Keep this wording descriptive and narrow. Do not imply scheduler, resume, or unattended execution already exist.

- [ ] **Step 3: Run the docs verification and update OpenWolf bookkeeping**

Run:

```bash
rg -n "boundary-analysis.json|reconciliation-record.json|deny-by-default|cleanup" validation/v1/README.md docs/handover/ccloop-handover.md
git diff --check -- validation/v1/README.md docs/handover/ccloop-handover.md .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md .wolf/buglog.json
```

Then update OpenWolf files with this exact row shape in `.wolf/memory.md`:

```md
| HH:MM | Added stop/no-progress/stale boundary artifacts and doc alignment | validation/v1/README.md, docs/handover/ccloop-handover.md, .wolf/anatomy.md, .wolf/memory.md, .wolf/cerebrum.md, .wolf/buglog.json | done | ~2200 |
```

- [ ] **Step 4: Run the full verification pass**

Run:

```bash
ECC_GATEGUARD=off DISABLE_OMC=1 npm test
npm run typecheck
npm run build
```

Expected:
- full test suite passes;
- typecheck passes;
- build passes.

- [ ] **Step 5: Commit**

```bash
git add validation/v1/README.md docs/handover/ccloop-handover.md .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md .wolf/buglog.json
git commit -m "docs: align stop and stale boundary guidance"
```
