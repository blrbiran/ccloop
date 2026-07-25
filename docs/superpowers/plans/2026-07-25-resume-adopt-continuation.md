# Resume / Adopt Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `resumeLoop(runDir, adapter)` entry point (and `resume` CLI subcommand) that reconstructs an interrupted run from persisted artifacts and continues it from the next attempt — only when the ownership layer has published a coherent, current, un-superseded transfer eligibility; refusing loudly otherwise.

**Architecture:** Extract the existing `runLoop` while-loop body into a shared `runLoopFromState(contract, runDir, adapter, state)`. `resumeLoop` reads the persisted owner/transfer/reconciliation/state artifacts, runs a pure eligibility gate, claims the run for the current process via a compare-and-swap owner-record write, best-effort cleans the abandoned attempt's worktree, then delegates to `runLoopFromState`. Resume never performs ownership judgment; it strictly consumes an already-published reconciliation transfer.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node `fs/promises`, git worktrees.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-resume-adopt-continuation-design.md`. Every task implicitly serves it.
- Resume never performs takeover/ownership judgment; it only consumes an already-published transfer. Deny-by-default.
- Eligibility is **re-claimable** while the epoch is current and un-superseded (not one-shot).
- Resumable `loop-state.status` whitelist is exactly `planning`, `executing`, `verifying`. Never `queued`, `succeeded`, `failed`, `cancelled`, `exhausted`, `blocked_waiting_human`.
- Missing or unparseable owner-record / owner-transfer / reconciliation-record / loop-state ⇒ refuse. Never treat missing as "proceed"; never auto-heal corrupt state.
- No paid Claude call anywhere. Tests use the `ScriptedAdapter`.
- The `runLoopFromState` extraction MUST be behavior-preserving; the full existing suite (243 tests) must stay green.
- Run tests with `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`.
- ESM: all intra-repo imports use `.js` specifiers. Match existing file style (no default exports; `export function`/`export async function`).
- Process instance id format is `pid:${process.pid}` (see `buildInitialOwnerRecord` in `src/controller/runLoop.ts:569`).

---

### Task 1: Extract `runLoopFromState` from `runLoop` (behavior-preserving refactor)

**Files:**
- Modify: `src/controller/runLoop.ts` (the `runLoop` function starting at `:730`)
- Test: existing suite (no new test — this is a pure extraction guarded by all 243 tests)

**Interfaces:**
- Produces: `export async function runLoopFromState(contract: LoopContract, runDir: string, adapter: RuntimeAdapter, state: RunState): Promise<RunState>` — runs the attempt loop from an already-initialized run directory and an already-constructed `RunState`. Assumes `loop-contract.json`, `loop-state.json`, `events.jsonl`, and `owner-record.json` already exist on disk.
- Produces: `export { cleanupAttemptWorkspaceBestEffort }` (promote the existing module-private helper at `:317` to an export) with signature `(repoPath: string, worktreePath: string, runDir: string, detail: string) => Promise<void>`.

- [ ] **Step 1: Baseline the suite is green**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS (15 files / 243 tests). This is the safety net for the refactor.

- [ ] **Step 2: Extract the loop body**

In `src/controller/runLoop.ts`, change `runLoop` (`:730`) so its prologue stays and the `while (true) { ... }` block moves into a new exported function. Concretely:

```ts
export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  const state = transitionRunState(initialState(contract), "planning");
  const ownerRecord = buildInitialOwnerRecord(contract, state);
  await initializeRunFiles(runDir, contract, state);
  await writeOwnerRecord(runDir, ownerRecord);
  await appendTransitionEvent(runDir, state, "loop_planning", "run initialized and ready to plan");
  return runLoopFromState(contract, runDir, adapter, state);
}

export async function runLoopFromState(
  contract: LoopContract,
  runDir: string,
  adapter: RuntimeAdapter,
  initialLoopState: RunState,
): Promise<RunState> {
  let state = initialLoopState;
  while (true) {
    // ... the entire existing loop body, verbatim ...
  }
}
```

Move the whole existing `while (true) { ... }` body into `runLoopFromState` unchanged. The only change is that `state` is now seeded from the `initialLoopState` parameter instead of the outer `let`. Do not alter any control flow, event strings, or terminal-state handling inside the loop.

- [ ] **Step 3: Promote the cleanup helper to an export**

Change `async function cleanupAttemptWorkspaceBestEffort(` (`:317`) to `export async function cleanupAttemptWorkspaceBestEffort(`. No body change.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Run the full suite (behavior preservation)**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS — identical 243 tests green. If anything fails, the extraction changed behavior; revert and redo verbatim.

- [ ] **Step 6: Commit**

```bash
git add src/controller/runLoop.ts
git commit -m "refactor: extract runLoopFromState from runLoop (behavior-preserving)"
```

---

### Task 2: Strict persisted-artifact readers in fileStore

**Files:**
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: types `RunState` (`../state/types.js`), `OwnerTransferRecord`, `ReconciliationRecord` (`../runtime/types.js`) — already imported in fileStore.
- Produces:
  - `export async function readRunState(runDir: string): Promise<RunState>`
  - `export async function readOwnerTransferRecord(runDir: string): Promise<OwnerTransferRecord>`
  - `export async function readReconciliationRecord(runDir: string): Promise<ReconciliationRecord>`
  - Each reads its JSON file and returns the parsed object. Each **throws** if the file is absent (readFile ENOENT) or unparseable (JSON.parse throws). No `try/catch` that swallows — deny-by-default is the caller's job to surface. (Note: a private `readPersistedReconciliationRecord` already exists and returns `undefined` on error; leave it untouched — these new readers are strict and public.)

- [ ] **Step 1: Write the failing tests**

Add to `tests/persistence/fileStore.test.ts` (reuse its existing `mkdtemp`-based runDir helper; if none, create a temp dir with `mkdtemp(join(tmpdir(), "ccloop-fs-"))`):

```ts
import { readRunState, readOwnerTransferRecord, readReconciliationRecord } from "../../src/persistence/fileStore.js";

describe("strict persisted-artifact readers", () => {
  it("reads a persisted run state", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const state = {
      status: "executing", currentAttempt: 2, attemptsUsed: 2,
      lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false,
      stopReason: null,
      budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1000, tokenBudgetRemaining: 500 },
      recentFailures: [],
    };
    await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state));
    expect(await readRunState(runDir)).toEqual(state);
  });

  it("throws when loop-state.json is missing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    await expect(readRunState(runDir)).rejects.toThrow();
  });

  it("throws when owner-transfer.json is unparseable", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    await writeFile(join(runDir, "owner-transfer.json"), "{ not json");
    await expect(readOwnerTransferRecord(runDir)).rejects.toThrow();
  });

  it("reads a persisted reconciliation record", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const rec = {
      staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute", conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
    };
    await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify(rec));
    expect(await readReconciliationRecord(runDir)).toEqual(rec);
  });
});
```

Ensure `writeFile`, `mkdtemp`, `join`, `tmpdir` are imported in the test file (match the imports already used in `tests/controller/runLoop.integration.test.ts:2-3`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/fileStore.test.ts`
Expected: FAIL — `readRunState` / `readOwnerTransferRecord` / `readReconciliationRecord` are not exported.

- [ ] **Step 3: Implement the readers**

Add to `src/persistence/fileStore.ts` (near the other readers, ~`:554`):

```ts
export async function readRunState(runDir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
}

export async function readOwnerTransferRecord(runDir: string): Promise<OwnerTransferRecord> {
  return JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_FILE), "utf8")) as OwnerTransferRecord;
}

export async function readReconciliationRecord(runDir: string): Promise<ReconciliationRecord> {
  return JSON.parse(await readFile(join(runDir, "reconciliation-record.json"), "utf8")) as ReconciliationRecord;
}
```

(`readFile`, `join`, `OWNER_TRANSFER_FILE`, `RunState`, `OwnerTransferRecord`, `ReconciliationRecord` are all already imported/defined in the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/fileStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: add strict persisted-artifact readers (readRunState, readOwnerTransferRecord, readReconciliationRecord)"
```

---

### Task 3: Compare-and-swap owner-record claim writer

**Files:**
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: existing module internals `acquireOwnerTransferLock`, `recoverInterruptedOwnerTransfer`, `readOwnerRecordRaw`, `sameOwnerRecord`, `getOwnerTransferPaths`, `writeJsonFile`, `OwnerTransferPreconditionError`, `safeUnlink` (all already in fileStore).
- Produces: `export async function claimOwnerRecordWithPrecondition(runDir: string, expectedOwnerRecord: OwnerRecord, nextOwnerRecord: OwnerRecord): Promise<void>` — under the owner-transfer lock, finalize any interrupted transfer, then compare the persisted owner-record to `expectedOwnerRecord`; if they differ, throw `OwnerTransferPreconditionError`; otherwise atomically write `nextOwnerRecord` to `owner-record.json` (temp-file + rename). This is the resume claim's last-moment CAS (spec §6).

- [ ] **Step 1: Write the failing tests**

Add to `tests/persistence/fileStore.test.ts`:

```ts
import { claimOwnerRecordWithPrecondition, writeOwnerRecord, readOwnerRecord } from "../../src/persistence/fileStore.js";
import { OwnerTransferPreconditionError } from "../../src/persistence/fileStore.js";

function ownerRecord(overrides = {}) {
  return {
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:111", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null, ...overrides,
  };
}

describe("claimOwnerRecordWithPrecondition", () => {
  it("writes the next record when the precondition matches", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const current = ownerRecord();
    await writeOwnerRecord(runDir, current);
    const next = ownerRecord({ currentProcessInstanceId: "pid:222", lastAffirmedAt: "2026-07-25T01:00:00.000Z" });
    await claimOwnerRecordWithPrecondition(runDir, current, next);
    expect(await readOwnerRecord(runDir)).toEqual(next);
  });

  it("throws and leaves the record untouched when the precondition fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-fs-"));
    const persisted = ownerRecord({ currentOwnerEpoch: 3 });
    await writeOwnerRecord(runDir, persisted);
    const stale = ownerRecord({ currentOwnerEpoch: 2 });
    const next = ownerRecord({ currentOwnerEpoch: 2, currentProcessInstanceId: "pid:222" });
    await expect(claimOwnerRecordWithPrecondition(runDir, stale, next)).rejects.toBeInstanceOf(OwnerTransferPreconditionError);
    expect(await readOwnerRecord(runDir)).toEqual(persisted);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/fileStore.test.ts`
Expected: FAIL — `claimOwnerRecordWithPrecondition` not exported.

- [ ] **Step 3: Implement the CAS writer**

Add to `src/persistence/fileStore.ts` (after `writeOwnerTransferArtifacts`, ~`:589`):

```ts
export async function claimOwnerRecordWithPrecondition(
  runDir: string,
  expectedOwnerRecord: OwnerRecord,
  nextOwnerRecord: OwnerRecord,
): Promise<void> {
  const lock = await acquireOwnerTransferLock(runDir);

  try {
    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);

    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
      throw new OwnerTransferPreconditionError("persisted owner record changed before resume could claim it");
    }

    const { ownerPath, ownerTempPath } = getOwnerTransferPaths(runDir);
    await safeUnlink(ownerTempPath);
    await writeJsonFile(ownerTempPath, nextOwnerRecord);
    await rename(ownerTempPath, ownerPath);
  } finally {
    await lock.release();
  }
}
```

(`rename` is already imported at `src/persistence/fileStore.ts:1`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/persistence/fileStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: add claimOwnerRecordWithPrecondition CAS writer for resume claim"
```

---

### Task 4: Pure eligibility gate + `ResumeNotEligibleError`

**Files:**
- Create: `src/controller/resumeLoop.ts`
- Test: `tests/controller/resumeLoop.gate.test.ts`

**Interfaces:**
- Consumes: `OwnerRecord`, `OwnerTransferRecord`, `ReconciliationRecord` (`../runtime/types.js`); `RunState`, `RunStatus` (`../state/types.js`).
- Produces:
  - `export class ResumeNotEligibleError extends Error` (sets `this.name = "ResumeNotEligibleError"`).
  - `export type ResumeGateInput = { ownerRecord: OwnerRecord; ownerTransfer: OwnerTransferRecord; reconciliation: ReconciliationRecord; runState: RunState }`.
  - `export type ResumeEligibility = { ok: true } | { ok: false; reason: string }`.
  - `export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility` — pure; encodes spec §5 conditions 1–5 (incl. the §5.3 supersede fence) and the §8 status whitelist.

- [ ] **Step 1: Write the failing tests**

Create `tests/controller/resumeLoop.gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateResumeEligibility, type ResumeGateInput } from "../../src/controller/resumeLoop.js";

function baseInput(): ResumeGateInput {
  return {
    ownerRecord: {
      runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
      currentProcessInstanceId: "pid:111", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
      ownerStatus: "current", supersededByEpoch: null,
    },
    ownerTransfer: {
      priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
      newProcessInstanceId: "pid:111", transferredAt: "2026-07-25T00:00:00.000Z",
      reason: "owner lost", eligibleForContinuation: true,
    },
    reconciliation: {
      staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
      lastTrustedBoundary: "execute", conflictingEvidence: [],
      takeoverPermission: { allowed: true, reason: "ok" },
      priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
    },
    runState: {
      status: "executing", currentAttempt: 2, attemptsUsed: 2,
      lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
      budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 1000, tokenBudgetRemaining: 500 },
      recentFailures: [],
    },
  };
}

describe("evaluateResumeEligibility", () => {
  it("passes for a coherent, current, non-superseded, resumable input", () => {
    expect(evaluateResumeEligibility(baseInput())).toEqual({ ok: true });
  });

  it("refuses when owner-transfer is not eligible", () => {
    const input = baseInput();
    (input.ownerTransfer as { eligibleForContinuation: boolean }).eligibleForContinuation = false;
    const result = evaluateResumeEligibility(input);
    expect(result.ok).toBe(false);
  });

  it("refuses when reconciliation verdict is not OWNER_LOST", () => {
    const input = baseInput();
    input.reconciliation.ownershipVerdict = "OWNER_VALID";
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses when reconciliation newOwnerEpoch does not match the transfer", () => {
    const input = baseInput();
    input.reconciliation.newOwnerEpoch = 3;
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses a superseded eligibility (owner epoch newer than the transfer) — takeover authority belongs to reconciliation, not resume", () => {
    const input = baseInput();
    input.ownerRecord.currentOwnerEpoch = 3; // a newer transfer already rotated the epoch
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses when supersededByEpoch is set", () => {
    const input = baseInput();
    input.ownerRecord.supersededByEpoch = 3;
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it("refuses when owner status is not current", () => {
    const input = baseInput();
    input.ownerRecord.ownerStatus = "lost";
    expect(evaluateResumeEligibility(input).ok).toBe(false);
  });

  it.each(["succeeded", "failed", "cancelled", "exhausted", "blocked_waiting_human", "queued"] as const)(
    "refuses non-resumable status %s",
    (status) => {
      const input = baseInput();
      input.runState.status = status;
      expect(evaluateResumeEligibility(input).ok).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.gate.test.ts`
Expected: FAIL — module `src/controller/resumeLoop.ts` does not exist.

- [ ] **Step 3: Implement the gate**

Create `src/controller/resumeLoop.ts`:

```ts
import type { OwnerRecord, OwnerTransferRecord, ReconciliationRecord } from "../runtime/types.js";
import type { RunState, RunStatus } from "../state/types.js";

export class ResumeNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeNotEligibleError";
  }
}

export type ResumeGateInput = {
  ownerRecord: OwnerRecord;
  ownerTransfer: OwnerTransferRecord;
  reconciliation: ReconciliationRecord;
  runState: RunState;
};

export type ResumeEligibility = { ok: true } | { ok: false; reason: string };

const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];

export function evaluateResumeEligibility(input: ResumeGateInput): ResumeEligibility {
  const { ownerRecord, ownerTransfer, reconciliation, runState } = input;

  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {
    return { ok: false, reason: "owner-transfer is not eligible for continuation" };
  }
  if (reconciliation.eligibleForContinuation !== true) {
    return { ok: false, reason: "reconciliation-record is not eligible for continuation" };
  }
  if (reconciliation.ownershipVerdict !== "OWNER_LOST") {
    return { ok: false, reason: `reconciliation verdict is ${reconciliation.ownershipVerdict}, expected OWNER_LOST` };
  }
  if (reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
    return { ok: false, reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch" };
  }
  if (ownerRecord.supersededByEpoch !== null) {
    return { ok: false, reason: `owner epoch is superseded by ${ownerRecord.supersededByEpoch}` };
  }
  if (ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch) {
    return { ok: false, reason: "published eligibility has been superseded by a newer owner epoch" };
  }
  if (ownerRecord.ownerStatus !== "current") {
    return { ok: false, reason: `owner status is ${ownerRecord.ownerStatus}, expected current` };
  }
  if (!RESUMABLE_STATUSES.includes(runState.status)) {
    return { ok: false, reason: `run status ${runState.status} is not resumable` };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller/resumeLoop.ts tests/controller/resumeLoop.gate.test.ts
git commit -m "feat: add pure resume eligibility gate and ResumeNotEligibleError"
```

---

### Task 5: `resumeLoop` orchestration (read → gate → claim → cleanup → continue)

**Files:**
- Modify: `src/controller/resumeLoop.ts`
- Test: `tests/controller/resumeLoop.integration.test.ts`

**Interfaces:**
- Consumes: `evaluateResumeEligibility`, `ResumeNotEligibleError` (this file, Task 4); `runLoopFromState`, `cleanupAttemptWorkspaceBestEffort` (`./runLoop.js`, Task 1); `readOwnerRecord`, `readOwnerTransferRecord`, `readReconciliationRecord`, `readRunState`, `claimOwnerRecordWithPrecondition`, `appendEvent` (`../persistence/fileStore.js`, Tasks 2–3); `loadContract` (`../contract/loadContract.js`); `RuntimeAdapter` (`../runtime/types.js`).
- Produces: `export async function resumeLoop(runDir: string, adapter: RuntimeAdapter): Promise<RunState>` — throws `ResumeNotEligibleError` on any refusal, having mutated no run state; otherwise claims the run and returns the final `RunState` from `runLoopFromState`.

- [ ] **Step 1: Write the failing tests**

Create `tests/controller/resumeLoop.integration.test.ts`. Reuse the repo/contract helpers pattern from `tests/controller/runLoop.integration.test.ts:26-60` (copy `createRepo` and `createContract` in, or import if they are exported — if not exported, inline copies are fine). Add a helper that seeds an interrupted-but-eligible run directory:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resumeLoop, ResumeNotEligibleError } from "../../src/controller/resumeLoop.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import type { LoopContract } from "../../src/contract/schema.js";

const execFileAsync = promisify(execFile);

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function createContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    guardrailsAndSafety: { allowlistPaths: ["src"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    escalationAndExit: { stopOn: [], pauseOn: [], escalateTo: "human" },
  } as unknown as LoopContract;
}

// Seed an eligible, interrupted run dir at attemptsUsed=N, status "executing".
async function seedEligibleRun(runDir: string, contract: LoopContract, attemptsUsed = 1) {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
    status: "executing", currentAttempt: attemptsUsed, attemptsUsed,
    lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 2, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
    recentFailures: [],
  }));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null,
  }));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({
    priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
    newProcessInstanceId: "pid:100", transferredAt: "2026-07-25T00:00:00.000Z",
    reason: "owner lost", eligibleForContinuation: true,
  }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
    staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute", conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "ok" },
    priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
  }));
}

function successFrame() {
  return {
    plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
    execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
    verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["ok"], pauseSignals: [], stopSignals: [] },
  };
}

async function readEventTypes(runDir: string): Promise<string[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l).type as string);
}

describe("resumeLoop", () => {
  it("resumes an eligible run from the next attempt and claims ownership", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    const adapter = new ScriptedAdapter([successFrame()]);
    const finalState = await resumeLoop(runDir, adapter);

    expect(finalState.status).toBe("succeeded");
    expect(finalState.attemptsUsed).toBe(2); // continued from attempt 2 (attemptsUsed was 1)

    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    expect(owner.currentProcessInstanceId).toBe(`pid:${process.pid}`); // claimed
    expect(owner.currentOwnerEpoch).toBe(2); // epoch unchanged
    expect(await readEventTypes(runDir)).toContain("resume_adopted");
  });

  it("refuses (and mutates nothing) when eligibility is not published", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    // make it ineligible
    const transfer = JSON.parse(await readFile(join(runDir, "owner-transfer.json"), "utf8"));
    transfer.eligibleForContinuation = false;
    await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify(transfer));

    const ownerBefore = await readFile(join(runDir, "owner-record.json"), "utf8");
    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(ResumeNotEligibleError);

    expect(await readFile(join(runDir, "owner-record.json"), "utf8")).toBe(ownerBefore); // untouched
    expect(await readEventTypes(runDir)).toContain("resume_denied");
  });

  it("aborts when a concurrent owner-record change breaks the claim CAS", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);
    // Simulate a concurrent supersede landing after the gate would have read:
    // bump the persisted epoch so the CAS precondition (against epoch 2) fails.
    // We rely on evaluateResumeEligibility reading epoch 2 via the seeded transfer,
    // then the claim CAS comparing against the record resume read. To exercise CAS,
    // point owner-record and transfer at epoch 2 but mutate owner-record between reads:
    // simplest deterministic proxy — seed owner-record already superseded so the gate
    // refuses; for the CAS-specific path, see the fileStore CAS unit test (Task 3).
    // Here assert the gate-level supersede refusal end-to-end:
    const owner = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8"));
    owner.currentOwnerEpoch = 3;
    await writeFile(join(runDir, "owner-record.json"), JSON.stringify(owner));
    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(ResumeNotEligibleError);
  });
});
```

Note: the CAS-abort race is unit-tested deterministically in Task 3 (`claimOwnerRecordWithPrecondition`); the integration test above covers the gate-level supersede refusal end-to-end. Keep both.

- [ ] **Step 2: Run tests to verify they fail**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.integration.test.ts`
Expected: FAIL — `resumeLoop` not implemented (only the gate exists).

- [ ] **Step 3: Implement `resumeLoop`**

Append to `src/controller/resumeLoop.ts`:

```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadContract } from "../contract/loadContract.js";
import {
  appendEvent,
  claimOwnerRecordWithPrecondition,
  readOwnerRecord,
  readOwnerTransferRecord,
  readReconciliationRecord,
  readRunState,
} from "../persistence/fileStore.js";
import type { RuntimeAdapter } from "../runtime/types.js";
import { cleanupAttemptWorkspaceBestEffort, runLoopFromState } from "./runLoop.js";

async function cleanupResidualWorktrees(repoPath: string, runDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(runDir, "worktrees"));
  } catch {
    return; // no residual worktrees dir — nothing to clean
  }
  for (const name of names) {
    await cleanupAttemptWorkspaceBestEffort(
      repoPath,
      join(runDir, "worktrees", name),
      runDir,
      "best-effort cleanup of residual worktree before resume",
    );
  }
}

export async function resumeLoop(runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  await appendEvent(runDir, { type: "resume_requested", at: new Date().toISOString(), detail: runDir });

  let ownerRecord;
  let ownerTransfer;
  let reconciliation;
  let runState;
  let contract;
  try {
    [ownerRecord, ownerTransfer, reconciliation, runState, contract] = await Promise.all([
      readOwnerRecord(runDir),
      readOwnerTransferRecord(runDir),
      readReconciliationRecord(runDir),
      readRunState(runDir),
      loadContract(join(runDir, "loop-contract.json")),
    ]);
  } catch (error) {
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: `cannot read run artifacts: ${String(error)}` });
    throw new ResumeNotEligibleError(`cannot read run artifacts: ${String(error)}`);
  }

  const eligibility = evaluateResumeEligibility({ ownerRecord, ownerTransfer, reconciliation, runState });
  if (!eligibility.ok) {
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: eligibility.reason });
    throw new ResumeNotEligibleError(eligibility.reason);
  }

  const nextOwnerRecord = {
    ...ownerRecord,
    currentProcessInstanceId: `pid:${process.pid}`,
    lastAffirmedAt: new Date().toISOString(),
  };
  try {
    await claimOwnerRecordWithPrecondition(runDir, ownerRecord, nextOwnerRecord);
  } catch (error) {
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: `claim CAS failed: ${String(error)}` });
    throw new ResumeNotEligibleError(`claim CAS failed: ${String(error)}`);
  }

  await appendEvent(runDir, {
    type: "resume_adopted",
    at: new Date().toISOString(),
    detail: `epoch ${ownerRecord.currentOwnerEpoch}: ${ownerTransfer.priorProcessInstanceId} -> pid:${process.pid}`,
  });

  await cleanupResidualWorktrees(contract.context.repoPath, runDir);

  return runLoopFromState(contract, runDir, adapter, runState);
}
```

Move the `import type { RunState, RunStatus }` line already at the top of the file to also cover `RunState` used here (it is already imported in Task 4). Consolidate imports so there is a single import block per module (the `readdir`/`join`/etc. imports go at the top of the file, not mid-file — the mid-file placement above is illustrative; put all imports at the top).

- [ ] **Step 4: Run the new integration tests**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/controller/resumeLoop.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: PASS — all prior tests plus the new ones.

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/controller/resumeLoop.ts tests/controller/resumeLoop.integration.test.ts
git commit -m "feat: add resumeLoop orchestration (read, gate, CAS claim, continue)"
```

---

### Task 6: CLI `resume` subcommand + index export

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Test: `tests/cli.test.ts` (create if absent; otherwise add to the existing CLI test file)

**Interfaces:**
- Consumes: `resumeLoop`, `ResumeNotEligibleError` (`./controller/resumeLoop.js`); existing `loadAdapter` in `cli.ts`.
- Produces: `parseArgs` accepts a `resume` command shape `{ command: "resume"; runDir: string; adapter: "scripted" | "claude"; adapterConfigPath: string }`; `main` dispatches `resume` to `resumeLoop`, returning `0` on `succeeded`, `2` otherwise, and `1` on `ResumeNotEligibleError`/other errors. `index.ts` re-exports `resumeLoop`.

- [ ] **Step 1: Write the failing tests**

Create/extend `tests/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("parseArgs resume", () => {
  it("parses a resume command", () => {
    const parsed = parseArgs(["resume", "--run-dir", "/tmp/run", "--adapter", "scripted", "--adapter-config", "/tmp/cfg.json"]);
    expect(parsed).toEqual({ command: "resume", runDir: "/tmp/run", adapter: "scripted", adapterConfigPath: "/tmp/cfg.json" });
  });

  it("still parses a run command", () => {
    const parsed = parseArgs(["run", "--contract", "/c.json", "--run-dir", "/r", "--adapter", "scripted", "--adapter-config", "/a.json"]);
    expect(parsed.command).toBe("run");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/cli.test.ts`
Expected: FAIL — `parseArgs` throws `expected \`run\` command` for `resume`.

- [ ] **Step 3: Implement CLI support**

In `src/cli.ts`, widen `ParsedArgs` and `parseArgs`, and dispatch in `main`:

```ts
export type ParsedArgs =
  | { command: "run"; contractPath: string; runDir: string; adapter: "scripted" | "claude"; adapterConfigPath: string }
  | { command: "resume"; runDir: string; adapter: "scripted" | "claude"; adapterConfigPath: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (command !== "run" && command !== "resume") {
    throw new Error("expected `run` or `resume` command");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    values.set(argv[index]!, argv[index + 1]!);
  }

  const runDir = values.get("--run-dir");
  const adapter = values.get("--adapter");
  const adapterConfigPath = values.get("--adapter-config");
  if (!runDir || !adapter || !adapterConfigPath) {
    throw new Error("missing required flags");
  }
  if (adapter !== "scripted" && adapter !== "claude") {
    throw new Error("invalid adapter");
  }

  if (command === "resume") {
    return { command, runDir, adapter, adapterConfigPath };
  }

  const contractPath = values.get("--contract");
  if (!contractPath) {
    throw new Error("missing required flags");
  }
  return { command, contractPath, runDir, adapter, adapterConfigPath };
}
```

`loadAdapter` currently takes `parsed: ParsedArgs` and reads `parsed.adapter`/`parsed.adapterConfigPath` — both present on the union, so it still typechecks. Update `main`:

```ts
export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const adapter = await loadAdapter(parsed);
    if (parsed.command === "resume") {
      const finalState = await resumeLoop(parsed.runDir, adapter);
      return finalState.status === "succeeded" ? 0 : 2;
    }
    const contract = await loadContract(parsed.contractPath);
    const finalState = await runLoop(contract, parsed.runDir, adapter);
    return finalState.status === "succeeded" ? 0 : 2;
  } catch {
    return 1;
  }
}
```

Add the import at the top of `cli.ts`: `import { resumeLoop } from "./controller/resumeLoop.js";`. (`ResumeNotEligibleError` is caught by the existing blanket `catch` → returns `1`, satisfying spec §9's non-zero exit; no separate import needed.)

In `src/index.ts`, add: `export { resumeLoop } from "./controller/resumeLoop.js";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck + build**

Run: `ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run && npm run typecheck && npm run build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/index.ts tests/cli.test.ts
git commit -m "feat: add resume CLI subcommand and export resumeLoop"
```

---

## Self-Review

**1. Spec coverage:**

- §4 entry model / `runLoopFromState` extraction → Task 1. `resumeLoop` + `resume` CLI → Tasks 5, 6.
- §5 eligibility gate (conditions 1–5, R1 supersede fence) → Task 4 (pure) + Task 5 (wiring). Readers → Task 2.
- §6 CAS claim (R2) → Task 3 (`claimOwnerRecordWithPrecondition`) + Task 5 (claim call).
- §7 continuation from next attempt, trust persisted state, best-effort residual worktree cleanup → Task 5 (`cleanupResidualWorktrees`, delegate to `runLoopFromState`).
- §8 status whitelist (queued excluded) → Task 4 `RESUMABLE_STATUSES` + gate test `it.each` incl. `queued`.
- §9 deny-by-default on missing/unparseable + typed error + non-zero exit → Task 2 (throwing readers), Task 5 (try/catch → `ResumeNotEligibleError` + `resume_denied`), Task 6 (`main` returns 1).
- §10 audit events `resume_requested` / `resume_denied` / `resume_adopted` → Task 5.
- §11 borrowed patterns are design provenance (no code obligation beyond R1/R2/R3, all covered above).
- §12 testing matrix → Task 4 refusal matrix (all §12 gate cases), Task 3 CAS unit test, Task 5 happy path + deny + supersede, Task 1 behavior preservation.

No gaps.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". All test and implementation bodies are concrete. The one prose caveat in Task 5 Step 3 ("put all imports at the top") is an instruction, not a placeholder.

**3. Type consistency:** `evaluateResumeEligibility(ResumeGateInput) → ResumeEligibility`, `claimOwnerRecordWithPrecondition(runDir, expected, next)`, `runLoopFromState(contract, runDir, adapter, state)`, `readRunState/readOwnerTransferRecord/readReconciliationRecord(runDir)`, `resumeLoop(runDir, adapter)`, `ResumeNotEligibleError` — names and signatures are used identically across the tasks that define and consume them. `RESUMABLE_STATUSES` matches §8. Owner/transfer/reconciliation field names match `src/runtime/types.ts`.

**Known implementation note (not a gap):** Task 5's `resumeLoop` delegates the persisted `RunState` to `runLoopFromState` as-is (no forced status transition); the loop body opens a fresh next attempt regardless of entry status, and the happy-path test asserts continuation from attempt N+1 to a terminal state, validating this.
