# Ownership and Reconciliation Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add controller-owned ownership truth, explicit owner records, strict owner-loss evaluation, read-first reconciliation verdicts, and atomic owner-epoch transfer that grants continuation eligibility only.

**Architecture:** Introduce ownership as its own controller-owned layer rather than inferring it from liveness alone. First add explicit owner-record and verdict types plus persistence, then add a pure ownership evaluator and atomic transfer helper, then wire the controller to initialize owner records and emit strict reconciliation verdicts, then add a separate controller-owned owner-transfer contract that runs only after `OWNER_LOST + takeoverAllowed`, and finally teach validation/docs to read and explain the new artifacts.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Vitest, existing controller/persistence/validation modules

## Global Constraints

- Do not implement scheduler or daemon behavior.
- Do not implement actual continuation or resume execution.
- Do not implement cleanup or orphan GC behavior.
- Do not redefine the previously approved `stop / no-progress / stale-run` state model.
- Do not authorize any paid Claude run.
- Do not rewrite accepted historical evidence.
- The stop/stale boundary layer may not rewrite accepted historical outcome records.
- Controller-owned persisted state is the ownership source of truth.
- Process/liveness/workspace observations are supporting evidence only.
- Reconciliation is read-first and deny-by-default.
- Timeout and watchdog signals are suspicion triggers, not ownership truth.
- Ownership must use an explicit controller-owned owner record; it may not remain an implicit interpretation.
- Exactly one current owner epoch may exist per run session.
- When a new owner epoch is established, the previous owner epoch is superseded and loses execution authority.
- The following are not sufficient on their own to prove owner loss: process disappearance, watchdog or timeout overrun, worktree presence or absence, artifact or log stagnation, stale-candidate status alone.
- Reconciliation may not repair arbitrary controller-owned state, rewrite historical evidence, silently delete workspaces or artifacts, continue task execution, or broaden into resume or scheduler policy.
- `takeoverAllowed = true` requires: ownership verdict is exactly `OWNER_LOST`; the last trusted run boundary is known; persisted truth and supporting evidence are not contradictory in a way that requires human interpretation; the new owner epoch can be established atomically; the transfer does not itself imply continuation.
- A successful owner transfer gives execution eligibility only. It does not resume the run.
- If reconciliation would need to guess, it must not take over.

---

## File Structure

- Modify: `src/state/types.ts` — add ownership truth and owner-transfer audit types shared across controller, persistence, and validation.
- Modify: `src/runtime/types.ts` — expand `ReconciliationRecord` to carry ownership verdicts and continuation-eligibility fields.
- Create: `src/ownership/ownerController.ts` — pure ownership evaluator and atomic owner-transfer helper.
- Modify: `src/persistence/fileStore.ts` — persist `owner-record.json`, `owner-transfer.json`, and expanded reconciliation artifacts.
- Modify: `src/controller/runLoop.ts` — initialize owner records, write strict read-first reconciliation verdicts, and expose a constrained owner-transfer contract that grants eligibility only.
- Modify: `validation/v1/lib/evidence.ts` — read and schema-validate `owner-record.json`, `owner-transfer.json`, and expanded reconciliation records.
- Modify: `validation/v1/README.md` — document the new controller-owned ownership artifacts and continuation-eligibility boundary.
- Modify: `docs/handover/ccloop-handover.md` — record ownership/reconciliation artifacts and the fact that transfer grants eligibility only.
- Test: `tests/persistence/fileStore.test.ts` — owner-record, owner-transfer, and expanded reconciliation persistence.
- Create: `tests/ownership/ownerController.test.ts` — strict owner-loss, undecidable, superseded, and atomic transfer unit coverage.
- Modify: `tests/controller/runLoop.integration.test.ts` — owner-record initialization, strict reconciliation-verdict persistence, and controller-owned atomic transfer/eligibility persistence.
- Modify: `tests/validation/evidence.test.ts` — owner-record/owner-transfer/reconciliation validation coverage.
- Modify: `.wolf/anatomy.md`, `.wolf/memory.md`, `.wolf/cerebrum.md`, `.wolf/buglog.json` — required OpenWolf bookkeeping.

### Task 1: Add explicit owner-record, owner-transfer, and ownership-verdict types

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: existing `RunState`, `RunBoundaryAnalysis`, and `TakeoverPermission`
- Produces:
  - `type OwnerStatus = "current" | "lost" | "unknown"`
  - `type OwnershipVerdict = "OWNER_VALID" | "OWNER_LOST" | "OWNER_SUPERSEDED" | "OWNER_UNDECIDABLE"`
  - `type OwnerRecord = { runId: string; logicalSessionId: string; currentOwnerEpoch: number; currentProcessInstanceId: string; lastAffirmedAt: string; ownerStatus: OwnerStatus; supersededByEpoch: number | null; }`
  - `type OwnerTransferRecord = { priorOwnerEpoch: number; newOwnerEpoch: number; priorProcessInstanceId: string; newProcessInstanceId: string; transferredAt: string; reason: string; eligibleForContinuation: true; }`
  - `writeOwnerRecord(runDir: string, ownerRecord: OwnerRecord): Promise<void>`
  - `writeOwnerTransferRecord(runDir: string, transferRecord: OwnerTransferRecord): Promise<void>`
  - expanded `ReconciliationRecord` fields: `ownershipVerdict`, `priorOwnerEpoch`, `newOwnerEpoch`, `eligibleForContinuation`

- [ ] **Step 1: Write the failing persistence tests**

```ts
it("writes owner-record.json with current epoch and process instance", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

  await writeOwnerRecord(runDir, {
    runId: "task-1",
    logicalSessionId: "task-1/session-1",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:12345",
    lastAffirmedAt: "2026-07-22T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
  });

  const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
    currentOwnerEpoch: number;
    currentProcessInstanceId: string;
    ownerStatus: string;
  };

  expect(owner.currentOwnerEpoch).toBe(1);
  expect(owner.currentProcessInstanceId).toBe("pid:12345");
  expect(owner.ownerStatus).toBe("current");
});

it("writes owner-transfer.json with prior and new epochs", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

  await writeOwnerTransferRecord(runDir, {
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    priorProcessInstanceId: "pid:12345",
    newProcessInstanceId: "pid:67890",
    transferredAt: "2026-07-22T10:05:00.000Z",
    reason: "owner lost after reconciliation",
    eligibleForContinuation: true,
  });

  const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as {
    priorOwnerEpoch: number;
    newOwnerEpoch: number;
    eligibleForContinuation: boolean;
  };

  expect(transfer.priorOwnerEpoch).toBe(1);
  expect(transfer.newOwnerEpoch).toBe(2);
  expect(transfer.eligibleForContinuation).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/persistence/fileStore.test.ts`
Expected: FAIL because `writeOwnerRecord`, `writeOwnerTransferRecord`, and the new types do not exist yet.

- [ ] **Step 3: Add the minimal types and persistence helpers**

```ts
export type OwnerStatus = "current" | "lost" | "unknown";

export type OwnershipVerdict =
  | "OWNER_VALID"
  | "OWNER_LOST"
  | "OWNER_SUPERSEDED"
  | "OWNER_UNDECIDABLE";

export type OwnerRecord = {
  runId: string;
  logicalSessionId: string;
  currentOwnerEpoch: number;
  currentProcessInstanceId: string;
  lastAffirmedAt: string;
  ownerStatus: OwnerStatus;
  supersededByEpoch: number | null;
};

export type OwnerTransferRecord = {
  priorOwnerEpoch: number;
  newOwnerEpoch: number;
  priorProcessInstanceId: string;
  newProcessInstanceId: string;
  transferredAt: string;
  reason: string;
  eligibleForContinuation: true;
};
```

```ts
export type ReconciliationRecord = {
  staleSuspicionBasis: string[];
  staleConfirmed: boolean;
  ownershipVerdict: OwnershipVerdict;
  lastTrustedBoundary: "planning" | "execute" | "verify" | "terminal" | "unknown";
  conflictingEvidence: string[];
  takeoverPermission: TakeoverPermission;
  priorOwnerEpoch: number | null;
  newOwnerEpoch: number | null;
  eligibleForContinuation: boolean;
};
```

```ts
export async function writeOwnerRecord(runDir: string, ownerRecord: OwnerRecord): Promise<void> {
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify(ownerRecord, null, 2));
}

export async function writeOwnerTransferRecord(runDir: string, transferRecord: OwnerTransferRecord): Promise<void> {
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify(transferRecord, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/persistence/fileStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/runtime/types.ts src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: add explicit owner records"
```

### Task 2: Add strict ownership evaluation and atomic transfer helpers

**Files:**
- Create: `src/ownership/ownerController.ts`
- Create: `tests/ownership/ownerController.test.ts`
- Modify: `src/state/types.ts`

**Interfaces:**
- Consumes:
  - `OwnerRecord`
  - `RunBoundaryAnalysis`
  - `OwnershipVerdict`
- Produces:
  - `type OwnershipEvaluationInput = { ownerRecord: OwnerRecord; persistedOwnerStillSupported: boolean; boundaryAnalysis: RunBoundaryAnalysis; currentProcessStillTrusted: boolean; supportingContinuityEvidence: string[]; knownSupersedingEpoch: number | null; lastTrustedBoundary: "planning" | "execute" | "verify" | "terminal" | "unknown"; }`
  - `type OwnershipEvaluation = { verdict: OwnershipVerdict; reasons: string[]; takeoverAllowed: boolean; lastTrustedBoundary: "planning" | "execute" | "verify" | "terminal" | "unknown"; }`
  - `function evaluateOwnership(input: OwnershipEvaluationInput): OwnershipEvaluation`
  - `function applyOwnerEpochTransfer(ownerRecord: OwnerRecord, nextProcessInstanceId: string, at: string, reason: string): { nextOwnerRecord: OwnerRecord; transferRecord: OwnerTransferRecord }`

- [ ] **Step 1: Write the failing ownership unit tests**

```ts
it("returns OWNER_LOST only when persisted truth is no longer supported and no trusted continuity evidence remains", () => {
  const result = evaluateOwnership({
    ownerRecord: {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
    },
    persistedOwnerStillSupported: false,
    boundaryAnalysis: {
      status: "stale_candidate",
      strongProgressAt: "2026-07-22T10:00:00.000Z",
      weakProgressAt: null,
      suspectReason: "healthy window exceeded",
      staleCandidateReason: "continuity evidence missing",
    },
    currentProcessStillTrusted: false,
    supportingContinuityEvidence: [],
    knownSupersedingEpoch: null,
    lastTrustedBoundary: "execute",
  });

  expect(result.verdict).toBe("OWNER_LOST");
  expect(result.takeoverAllowed).toBe(true);
});

it("returns OWNER_UNDECIDABLE when stale suspicion exists but persisted owner support is still unresolved", () => {
  const result = evaluateOwnership({
    ownerRecord: {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
    },
    persistedOwnerStillSupported: true,
    boundaryAnalysis: {
      status: "stale_candidate",
      strongProgressAt: "2026-07-22T10:00:00.000Z",
      weakProgressAt: null,
      suspectReason: "healthy window exceeded",
      staleCandidateReason: "continuity evidence missing",
    },
    currentProcessStillTrusted: false,
    supportingContinuityEvidence: [],
    knownSupersedingEpoch: null,
    lastTrustedBoundary: "execute",
  });

  expect(result.verdict).toBe("OWNER_UNDECIDABLE");
  expect(result.takeoverAllowed).toBe(false);
});

it("returns OWNER_SUPERSEDED when a newer owner epoch already exists", () => {
  const result = evaluateOwnership({
    ownerRecord: {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: 2,
    },
    persistedOwnerStillSupported: false,
    boundaryAnalysis: {
      status: "stale_candidate",
      strongProgressAt: "2026-07-22T10:00:00.000Z",
      weakProgressAt: null,
      suspectReason: "healthy window exceeded",
      staleCandidateReason: "new owner epoch already recorded",
    },
    currentProcessStillTrusted: false,
    supportingContinuityEvidence: [],
    knownSupersedingEpoch: 2,
    lastTrustedBoundary: "execute",
  });

  expect(result.verdict).toBe("OWNER_SUPERSEDED");
  expect(result.takeoverAllowed).toBe(false);
});

it("rotates owner epoch atomically and emits a continuation-eligibility transfer record", () => {
  const result = applyOwnerEpochTransfer(
    {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
    },
    "pid:67890",
    "2026-07-22T10:05:00.000Z",
    "owner lost after reconciliation",
  );

  expect(result.nextOwnerRecord.currentOwnerEpoch).toBe(2);
  expect(result.nextOwnerRecord.currentProcessInstanceId).toBe("pid:67890");
  expect(result.transferRecord.priorOwnerEpoch).toBe(1);
  expect(result.transferRecord.newOwnerEpoch).toBe(2);
  expect(result.transferRecord.eligibleForContinuation).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ownership/ownerController.test.ts`
Expected: FAIL because `src/ownership/ownerController.ts` does not exist yet.

- [ ] **Step 3: Add the minimal pure ownership logic**

```ts
export function evaluateOwnership(input: OwnershipEvaluationInput): OwnershipEvaluation {
  if (input.knownSupersedingEpoch !== null) {
    return {
      verdict: "OWNER_SUPERSEDED",
      reasons: [`owner epoch ${input.ownerRecord.currentOwnerEpoch} superseded by ${input.knownSupersedingEpoch}`],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.currentProcessStillTrusted || input.supportingContinuityEvidence.length > 0) {
    return {
      verdict: "OWNER_VALID",
      reasons: ["current owner still has trusted continuity evidence"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.boundaryAnalysis.status !== "stale_candidate") {
    return {
      verdict: "OWNER_UNDECIDABLE",
      reasons: ["owner loss cannot be proven without stale-candidate evidence"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.persistedOwnerStillSupported) {
    return {
      verdict: "OWNER_UNDECIDABLE",
      reasons: ["persisted owner truth still supports the current owner"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  if (input.lastTrustedBoundary === "unknown") {
    return {
      verdict: "OWNER_UNDECIDABLE",
      reasons: ["last trusted boundary is unknown"],
      takeoverAllowed: false,
      lastTrustedBoundary: input.lastTrustedBoundary,
    };
  }

  return {
    verdict: "OWNER_LOST",
    reasons: [input.boundaryAnalysis.staleCandidateReason ?? "stale continuity evidence"],
    takeoverAllowed: true,
    lastTrustedBoundary: input.lastTrustedBoundary,
  };
}

export function applyOwnerEpochTransfer(
  ownerRecord: OwnerRecord,
  nextProcessInstanceId: string,
  at: string,
  reason: string,
): { nextOwnerRecord: OwnerRecord; transferRecord: OwnerTransferRecord } {
  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
  return {
    nextOwnerRecord: {
      ...ownerRecord,
      currentOwnerEpoch: nextEpoch,
      currentProcessInstanceId: nextProcessInstanceId,
      lastAffirmedAt: at,
      ownerStatus: "current",
      supersededByEpoch: null,
    },
    transferRecord: {
      priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
      newOwnerEpoch: nextEpoch,
      priorProcessInstanceId: ownerRecord.currentProcessInstanceId,
      newProcessInstanceId: nextProcessInstanceId,
      transferredAt: at,
      reason,
      eligibleForContinuation: true,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/ownership/ownerController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ownership/ownerController.ts tests/ownership/ownerController.test.ts src/state/types.ts
git commit -m "feat: evaluate ownership verdicts"
```

### Task 3: Wire owner-record initialization and strict reconciliation verdicts into the controller

**Files:**
- Modify: `src/controller/runLoop.ts`
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes:
  - `writeOwnerRecord(runDir, ownerRecord)`
  - `evaluateOwnership(input)`
- Produces:
  - run-root `owner-record.json`
  - reconciliation records with strict `ownershipVerdict`, `priorOwnerEpoch`, `newOwnerEpoch`, and `eligibleForContinuation`
  - no actual resume execution and no owner transfer yet

- [ ] **Step 1: Write the failing controller integration tests**

```ts
it("writes owner-record.json when a run is initialized", async () => {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const contract = createContract(repoPath);

  const adapter = new ScriptedAdapter([
    {
      plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
      execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
      verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["pass"], pauseSignals: [], stopSignals: [] },
    },
  ]);

  await runLoop(contract, runDir, adapter);

  const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as {
    currentOwnerEpoch: number;
    ownerStatus: string;
  };

  expect(owner.currentOwnerEpoch).toBe(1);
  expect(owner.ownerStatus).toBe("current");
});

it("writes an OWNER_UNDECIDABLE reconciliation record on a stale path without granting continuation", async () => {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const contract = createContract(repoPath);

  const adapter: RuntimeAdapter = {
    async plan() {
      return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
    },
    async execute(context) {
      await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 2;\n");
      await waitForAbort(context.abortSignal);
      return null;
    },
    async verify() {
      throw new Error("verify should not run");
    },
  };

  await runLoop(contract, runDir, adapter);

  const reconciliation = JSON.parse(
    await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
  ) as { ownershipVerdict: string; eligibleForContinuation: boolean; takeoverPermission: { allowed: boolean } };

  expect(reconciliation.ownershipVerdict).toBe("OWNER_UNDECIDABLE");
  expect(reconciliation.eligibleForContinuation).toBe(false);
  expect(reconciliation.takeoverPermission.allowed).toBe(false);
});

it("writes an OWNER_LOST reconciliation record only when persisted owner support is absent and continuity evidence does not rescue it", async () => {
  const repoPath = await createRepo();
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const contract = createContract(repoPath);

  const adapter: RuntimeAdapter = {
    async plan() {
      return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
    },
    async execute(context) {
      await writeFile(join(context.worktreePath, "src", "index.ts"), "export const value = 3;\n");
      await waitForAbort(context.abortSignal);
      return null;
    },
    async verify() {
      throw new Error("verify should not run");
    },
  };

  await runLoop(contract, runDir, adapter);

  const reconciliation = JSON.parse(
    await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
  ) as { ownershipVerdict: string; eligibleForContinuation: boolean; takeoverPermission: { allowed: boolean } };

  expect(reconciliation.ownershipVerdict).toBe("OWNER_LOST");
  expect(reconciliation.eligibleForContinuation).toBe(false);
  expect(reconciliation.takeoverPermission.allowed).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`
Expected: FAIL because `owner-record.json` is not initialized yet and the reconciliation record lacks ownership verdict fields.

- [ ] **Step 3: Add the minimal controller wiring**

```ts
function buildInitialOwnerRecord(contract: LoopContract, state: RunState): OwnerRecord {
  return {
    runId: contract.objective.taskId,
    logicalSessionId: `${contract.objective.taskId}:${state.lastTransitionAt}`,
    currentOwnerEpoch: 1,
    currentProcessInstanceId: `pid:${process.pid}`,
    lastAffirmedAt: state.lastTransitionAt,
    ownerStatus: "current",
    supersededByEpoch: null,
  };
}
```

```ts
const initialOwnerRecord = buildInitialOwnerRecord(contract, state);
await initializeRunFiles(runDir, contract, state);
await writeOwnerRecord(runDir, initialOwnerRecord);
```

```ts
const ownership = evaluateOwnership({
  ownerRecord,
  persistedOwnerStillSupported: persistedOwnerStillSupported,
  boundaryAnalysis,
  currentProcessStillTrusted: boundaryEvidence.currentProcessStillTrusted,
  supportingContinuityEvidence: boundaryEvidence.supportingContinuityEvidence,
  knownSupersedingEpoch: null,
  lastTrustedBoundary: boundaryEvidence.lastTrustedBoundary,
});

await writeBoundaryArtifacts(runDir, {
  boundaryAnalysis,
  reconciliationRecord: {
    staleSuspicionBasis: boundaryEvidence.continuitySuspicion.length > 0
      ? boundaryEvidence.continuitySuspicion
      : [boundaryAnalysis.staleCandidateReason ?? "unknown stale suspicion"],
    staleConfirmed: boundaryAnalysis.status === "stale_candidate",
    ownershipVerdict: ownership.verdict,
    lastTrustedBoundary: ownership.lastTrustedBoundary,
    conflictingEvidence: boundaryEvidence.conflictingEvidence,
    takeoverPermission: {
      allowed: ownership.takeoverAllowed,
      reason: ownership.takeoverAllowed
        ? "strict owner-loss conditions satisfied; continuation still requires a later transfer step"
        : "deny-by-default until strict owner-loss and transfer conditions are fully met",
    },
    priorOwnerEpoch: ownerRecord.currentOwnerEpoch,
    newOwnerEpoch: null,
    eligibleForContinuation: false,
  },
});
```

Use the smallest deterministic inputs needed so one controller path lands in `OWNER_UNDECIDABLE` and one lands in `OWNER_LOST`, without transferring ownership yet.

- [ ] **Step 4: Run focused controller tests to verify they pass**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/runLoop.ts src/persistence/fileStore.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat: persist ownership reconciliation verdicts"
```

### Task 4: Add atomic owner transfer persistence and controller-owned eligibility contract

**Files:**
- Modify: `src/controller/runLoop.ts`
- Modify: `src/persistence/fileStore.ts`
- Modify: `src/ownership/ownerController.ts`
- Test: `tests/controller/runLoop.integration.test.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes:
  - `applyOwnerEpochTransfer(ownerRecord, nextProcessInstanceId, at, reason)`
  - `writeOwnerRecord(runDir, ownerRecord)`
  - `writeOwnerTransferRecord(runDir, transferRecord)`
  - a controller-owned `OWNER_LOST + takeoverAllowed` verdict from Task 3
- Produces:
  - atomic owner-record update plus `owner-transfer.json`
  - `eligibleForContinuation: true` only on successful controller-owned owner transfer
  - no actual resume execution

- [ ] **Step 1: Write the failing transfer tests**

```ts
it("writes owner-transfer.json and updates owner-record.json atomically only after an OWNER_LOST takeover-allowed verdict", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

  await writeOwnerRecord(runDir, {
    runId: "task-1",
    logicalSessionId: "task-1/session-1",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "pid:12345",
    lastAffirmedAt: "2026-07-22T10:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
  });

  const transfer = applyOwnerEpochTransfer(
    {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current",
      supersededByEpoch: null,
    },
    "pid:67890",
    "2026-07-22T10:05:00.000Z",
    "owner lost after reconciliation",
  );

  await writeOwnerRecord(runDir, transfer.nextOwnerRecord);
  await writeOwnerTransferRecord(runDir, transfer.transferRecord);

  const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as { currentOwnerEpoch: number; currentProcessInstanceId: string };
  const audit = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8")) as { priorOwnerEpoch: number; newOwnerEpoch: number; eligibleForContinuation: boolean };

  expect(owner.currentOwnerEpoch).toBe(2);
  expect(owner.currentProcessInstanceId).toBe("pid:67890");
  expect(audit.priorOwnerEpoch).toBe(1);
  expect(audit.newOwnerEpoch).toBe(2);
  expect(audit.eligibleForContinuation).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/persistence/fileStore.test.ts`
Expected: FAIL because `writeOwnerTransferRecord` and the transfer audit path are not fully wired yet.

- [ ] **Step 3: Add the minimal controller-owned transfer contract**

```ts
async function persistOwnerTransfer(
  runDir: string,
  ownerRecord: OwnerRecord,
  nextProcessInstanceId: string,
  at: string,
  reason: string,
): Promise<{ ownerRecord: OwnerRecord; eligibleForContinuation: true }> {
  const transfer = applyOwnerEpochTransfer(ownerRecord, nextProcessInstanceId, at, reason);
  await writeOwnerRecord(runDir, transfer.nextOwnerRecord);
  await writeOwnerTransferRecord(runDir, transfer.transferRecord);
  await appendEvent(runDir, {
    type: "owner_epoch_transferred",
    at,
    detail: `owner epoch ${transfer.transferRecord.priorOwnerEpoch} superseded by ${transfer.transferRecord.newOwnerEpoch}`,
  });
  return {
    ownerRecord: transfer.nextOwnerRecord,
    eligibleForContinuation: true,
  };
}
```

Add one focused controller integration test that exercises a controller-owned `OWNER_LOST + takeoverAllowed` result and asserts:
- `owner-record.json` now contains the new epoch
- `owner-transfer.json` exists
- `eligibleForContinuation === true`
- the run does not resume execution in the same step

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npm test -- tests/controller/runLoop.integration.test.ts tests/persistence/fileStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/runLoop.ts src/persistence/fileStore.ts src/ownership/ownerController.ts tests/controller/runLoop.integration.test.ts tests/persistence/fileStore.test.ts
git commit -m "feat: persist owner transfer eligibility"
```

### Task 5: Teach the validation layer to read owner records, owner transfers, and expanded reconciliation records

**Files:**
- Modify: `validation/v1/lib/evidence.ts`
- Modify: `tests/validation/evidence.test.ts`

**Interfaces:**
- Consumes:
  - `owner-record.json`
  - `owner-transfer.json`
  - expanded `reconciliation-record.json`
- Produces:
  - `EvidenceRecord["observations"].ownerRecord`
  - `EvidenceRecord["observations"].ownerTransfer`
  - parsed/validated ownership verdict fields on reconciliation observations

- [ ] **Step 1: Write the failing evidence-layer test**

```ts
it("surfaces valid owner-record.json, owner-transfer.json, and reconciliation-record.json as PRESENT with parsed values", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "ccloop-evidence-"));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
    runId: "task-1",
    logicalSessionId: "task-1/session-1",
    currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:67890",
    lastAffirmedAt: "2026-07-22T11:00:00.000Z",
    ownerStatus: "current",
    supersededByEpoch: null,
  }));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    priorProcessInstanceId: "pid:12345",
    newProcessInstanceId: "pid:67890",
    transferredAt: "2026-07-22T11:00:00.000Z",
    reason: "owner lost after reconciliation",
    eligibleForContinuation: true,
  }));
  await writeFile(join(runDir, "boundary-analysis.json"), JSON.stringify({
    status: "stale_candidate",
    strongProgressAt: null,
    weakProgressAt: null,
    suspectReason: "healthy window exceeded",
    staleCandidateReason: "continuity evidence missing",
  }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
    staleSuspicionBasis: ["continuity evidence missing"],
    staleConfirmed: true,
    ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute",
    conflictingEvidence: ["changed paths observed"],
    takeoverPermission: { allowed: true, reason: "atomic transfer possible" },
    priorOwnerEpoch: 1,
    newOwnerEpoch: 2,
    eligibleForContinuation: true,
  }));

  const record = await collectEvidence(makeEvidenceInput(runDir, evidenceDir));

  expect(record.observations.ownerRecord.status).toBe("PRESENT");
  expect(record.observations.ownerRecord.value?.currentOwnerEpoch).toBe(2);
  expect(record.observations.ownerTransfer.status).toBe("PRESENT");
  expect(record.observations.ownerTransfer.value?.newOwnerEpoch).toBe(2);
  expect(record.observations.reconciliationRecord.status).toBe("PRESENT");
  expect(record.observations.reconciliationRecord.value?.ownershipVerdict).toBe("OWNER_LOST");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/validation/evidence.test.ts`
Expected: FAIL because the evidence layer does not yet read `owner-record.json`, `owner-transfer.json`, or the expanded reconciliation fields.

- [ ] **Step 3: Add the minimal validation support**

```ts
ownerTransfer: {
  status: "PRESENT" | "MISSING" | "INVALID";
  path: string;
  value?: OwnerTransferRecord;
  error?: string;
}
```

```ts
const ownerRecordSchema = z.object({
  runId: z.string().trim().min(1),
  logicalSessionId: z.string().trim().min(1),
  currentOwnerEpoch: z.number().int().nonnegative(),
  currentProcessInstanceId: z.string().trim().min(1),
  lastAffirmedAt: z.string().trim().min(1),
  ownerStatus: z.enum(["current", "lost", "unknown"]),
  supersededByEpoch: z.number().int().nonnegative().nullable(),
}).strict();

const ownerTransferSchema = z.object({
  priorOwnerEpoch: z.number().int().nonnegative(),
  newOwnerEpoch: z.number().int().nonnegative(),
  priorProcessInstanceId: z.string().trim().min(1),
  newProcessInstanceId: z.string().trim().min(1),
  transferredAt: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  eligibleForContinuation: z.literal(true),
}).strict();
```

```ts
const reconciliationRecordSchema = z.object({
  staleSuspicionBasis: z.array(z.string()).min(1),
  staleConfirmed: z.boolean(),
  ownershipVerdict: z.enum(["OWNER_VALID", "OWNER_LOST", "OWNER_SUPERSEDED", "OWNER_UNDECIDABLE"]),
  lastTrustedBoundary: z.enum(["planning", "execute", "verify", "terminal", "unknown"]),
  conflictingEvidence: z.array(z.string()),
  takeoverPermission: z.object({ allowed: z.boolean(), reason: z.string().trim().min(1) }).strict(),
  priorOwnerEpoch: z.number().int().nonnegative().nullable(),
  newOwnerEpoch: z.number().int().nonnegative().nullable(),
  eligibleForContinuation: z.boolean(),
}).strict();
```

- [ ] **Step 4: Run focused validation tests to verify they pass**

Run: `npm test -- tests/validation/evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add validation/v1/lib/evidence.ts tests/validation/evidence.test.ts
git commit -m "feat: validate ownership reconciliation artifacts"
```

### Task 6: Align operator docs and handover with ownership/reconciliation artifacts and limits

**Files:**
- Modify: `validation/v1/README.md`
- Modify: `docs/handover/ccloop-handover.md`
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`
- Modify only if a genuinely new durable rule emerged: `.wolf/cerebrum.md`
- Modify: `.wolf/buglog.json`

**Interfaces:**
- Consumes:
  - implemented `owner-record.json`, `owner-transfer.json`, and expanded `reconciliation-record.json` field names
  - deny-by-default takeover semantics
  - continuation-eligibility-only rule
- Produces:
  - operator docs that explain the new ownership artifacts without implying scheduler or actual resume already exist

- [ ] **Step 1: Write the docs-only failing check by asserting the new ownership artifact names are absent**

```bash
rg -n "owner-record.json|owner-transfer.json|ownershipVerdict|eligibleForContinuation|continuation eligibility only" validation/v1/README.md docs/handover/ccloop-handover.md
```

Expected: the command either finds nothing or does not yet describe the ownership/reconciliation contract truthfully enough.

- [ ] **Step 2: Update `validation/v1/README.md` and `docs/handover/ccloop-handover.md`**

Add concise language that says:

```md
- `owner-record.json` is the controller-owned ownership truth artifact for the current run.
- `owner-transfer.json` records an atomic owner-epoch transfer and continuation eligibility.
- `reconciliation-record.json` includes `ownershipVerdict`, takeover permission, and continuation eligibility.
- A successful owner transfer grants continuation eligibility only; it does not itself resume execution.
- Ownership reconciliation does not authorize cleanup or historical evidence rewrites.
```

Keep the wording descriptive and narrow. Do not imply scheduler, resume, or unattended continuation already exist.

- [ ] **Step 3: Run the docs verification and update OpenWolf bookkeeping**

Run:

```bash
rg -n "owner-record.json|owner-transfer.json|ownershipVerdict|eligibleForContinuation|continuation eligibility only" validation/v1/README.md docs/handover/ccloop-handover.md
git diff --check -- validation/v1/README.md docs/handover/ccloop-handover.md .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md .wolf/buglog.json
```

Then append this exact `.wolf/memory.md` row shape with the actual time:

```md
| HH:MM | Added ownership and reconciliation artifacts plus operator-doc alignment | validation/v1/README.md, docs/handover/ccloop-handover.md, .wolf/anatomy.md, .wolf/memory.md, .wolf/cerebrum.md, .wolf/buglog.json | done | ~2600 |
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
git add validation/v1/README.md docs/handover/ccloop-handover.md
git add -f .wolf/anatomy.md .wolf/memory.md .wolf/cerebrum.md .wolf/buglog.json
git commit -m "docs: align ownership reconciliation guidance"
```
