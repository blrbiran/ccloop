# Loop Engineer Framework V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable TypeScript CLI that executes one code-task loop end-to-end with contract validation, durable state, isolated worktrees, stop control, and a Claude-backed runtime adapter under L2 assisted autonomy.

**Architecture:** A small kernel owns contract validation, run state, stop policy, persistence, and attempt orchestration. Runtime adapters provide planner/executor/verifier behavior; V1 ships with a deterministic scripted adapter for tests and a subprocess-based Claude adapter for real runs.

**Tech Stack:** Node.js 20, TypeScript 5, Zod, Vitest, native `fs/promises`, native `child_process`, `git` CLI

## Global Constraints

- The framework is contract-first.
- The framework uses a mixed-mode architecture.
- The first supported operating model is L2 assisted autonomy.
- Code-modifying attempts run in isolated worktrees.
- Executors cannot declare success.
- Conversation history is not treated as durable system state.
- If a path matches both an allowlist and a denylist rule, the denylist always wins.
- `retryable` is a controller decision, not a persisted state. It increments the attempt counter, records the retry reason, and transitions the run back to `planning`.
- `pause_on` defines conditions that suspend progress and wait for human input without ending the run. `stop_on` defines conditions that immediately end the run. `terminal_states` is the allowed set of persisted end states.
- For V1, a repeated failure pattern means two consecutive failed attempts with the same verifier rejection category and the same primary target paths or failing command.
- For V1, `budget_snapshot` includes at least `attempts_remaining`, `time_remaining_ms`, and `token_budget_remaining`.

---

## Planned File Structure

- Create: `package.json` — Node package manifest, scripts, dependencies, CLI bin entry.
- Create: `tsconfig.json` — TypeScript compiler settings for `src/` output to `dist/`.
- Create: `vitest.config.ts` — Vitest config for Node test runs.
- Create: `src/cli.ts` — CLI argument parsing and run entrypoint.
- Create: `src/index.ts` — public exports for programmatic use.
- Create: `src/contract/schema.ts` — Zod contract schema and inferred types.
- Create: `src/contract/loadContract.ts` — JSON contract loader and validator.
- Create: `src/state/types.ts` — run-state, decision, artifact, and event types.
- Create: `src/state/stateMachine.ts` — legal transitions and state update helpers.
- Create: `src/stop/stopController.ts` — stop-policy evaluation.
- Create: `src/persistence/fileStore.ts` — contract/state/event/artifact persistence.
- Create: `src/workspace/worktreeManager.ts` — per-attempt git worktree creation and cleanup.
- Create: `src/runtime/types.ts` — runtime adapter interfaces.
- Create: `src/runtime/scriptedAdapter.ts` — deterministic test adapter.
- Create: `src/runtime/claude/subprocessClaudeAdapter.ts` — subprocess-driven Claude adapter.
- Create: `src/runtime/claude/prompts.ts` — planner/executor/verifier prompt builders.
- Create: `src/controller/runLoop.ts` — end-to-end orchestration for one loop run.
- Create: `examples/v1/minimal-contract.json` — sample V1 contract.
- Create: `examples/v1/scripted-adapter-config.json` — sample scripted adapter config.
- Create: `examples/v1/claude-adapter-config.json` — sample Claude adapter config.
- Create: `tests/cli/cli.test.ts` — CLI parsing and top-level dispatch tests.
- Create: `tests/contract/loadContract.test.ts` — contract validation tests.
- Create: `tests/state/stateMachine.test.ts` — state transition tests.
- Create: `tests/stop/stopController.test.ts` — stop-policy tests.
- Create: `tests/persistence/fileStore.test.ts` — durable state and event-ledger tests.
- Create: `tests/workspace/worktreeManager.test.ts` — git worktree tests.
- Create: `tests/runtime/scriptedAdapter.test.ts` — deterministic adapter tests.
- Create: `tests/runtime/claude/subprocessClaudeAdapter.test.ts` — subprocess adapter tests with fake executable.
- Create: `tests/controller/runLoop.integration.test.ts` — end-to-end V1 orchestration tests.
- Create: `tests/fixtures/fake-claude.mjs` — deterministic subprocess target for adapter tests.

### Task 1: Bootstrap the TypeScript CLI workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli.ts`
- Create: `src/index.ts`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Produces: `parseArgs(argv: string[]): { command: "run"; contractPath: string; runDir: string; adapter: "scripted" | "claude"; adapterConfigPath: string }`
- Produces: `main(argv: string[]): Promise<number>`

- [ ] **Step 1: Write the failing CLI test**

```ts
// tests/cli/cli.test.ts
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../../src/cli";

describe("parseArgs", () => {
  it("parses the run command", () => {
    expect(
      parseArgs([
        "run",
        "--contract",
        "examples/v1/minimal-contract.json",
        "--run-dir",
        ".runs/demo",
        "--adapter",
        "scripted",
        "--adapter-config",
        "examples/v1/scripted-adapter-config.json",
      ]),
    ).toEqual({
      command: "run",
      contractPath: "examples/v1/minimal-contract.json",
      runDir: ".runs/demo",
      adapter: "scripted",
      adapterConfigPath: "examples/v1/scripted-adapter-config.json",
    });
  });

  it("returns exit code 1 when required flags are missing", async () => {
    await expect(main(["run"])).resolves.toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/cli/cli.test.ts`

Expected: FAIL with module resolution errors because `src/cli.ts`, `src/index.ts`, and package tooling do not exist yet.

- [ ] **Step 3: Write the minimal CLI/tooling implementation**

```json
// package.json
{
  "name": "ccloop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "ccloop": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.1",
    "tsx": "^4.19.2",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

```ts
// src/cli.ts
export type ParsedArgs = {
  command: "run";
  contractPath: string;
  runDir: string;
  adapter: "scripted" | "claude";
  adapterConfigPath: string;
};

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== "run") {
    throw new Error("expected `run` command");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    values.set(argv[index]!, argv[index + 1]!);
  }

  const contractPath = values.get("--contract");
  const runDir = values.get("--run-dir");
  const adapter = values.get("--adapter") as "scripted" | "claude" | undefined;
  const adapterConfigPath = values.get("--adapter-config");

  if (!contractPath || !runDir || !adapter || !adapterConfigPath) {
    throw new Error("missing required flags");
  }

  return {
    command: "run",
    contractPath,
    runDir,
    adapter,
    adapterConfigPath,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    parseArgs(argv);
    return 0;
  } catch {
    return 1;
  }
}
```

```ts
// src/index.ts
export { main, parseArgs } from "./cli";
```

- [ ] **Step 4: Run tests and typecheck**

Run:
- `npm install`
- `npm test -- tests/cli/cli.test.ts`
- `npm run typecheck`

Expected:
- `npm install` succeeds
- CLI test passes
- typecheck passes

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/cli.ts src/index.ts tests/cli/cli.test.ts
git commit -m "feat: bootstrap TypeScript CLI loop runner"
```

### Task 2: Define and validate the loop contract

**Files:**
- Create: `src/contract/schema.ts`
- Create: `src/contract/loadContract.ts`
- Test: `tests/contract/loadContract.test.ts`

**Interfaces:**
- Consumes: `ParsedArgs` from `src/cli.ts`
- Produces: `type LoopContract`
- Produces: `loadContract(filePath: string): Promise<LoopContract>`

- [ ] **Step 1: Write the failing contract validation tests**

```ts
// tests/contract/loadContract.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadContract } from "../../src/contract/loadContract";

describe("loadContract", () => {
  it("loads a valid L2 contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "contract.json");

    await writeFile(
      filePath,
      JSON.stringify({
        objective: {
          taskId: "task-1",
          goal: "Fix the failing test",
          successCondition: "All required checks pass",
          nonGoals: ["Do not refactor unrelated files"],
        },
        context: {
          repoPath: "/tmp/repo",
          targetPaths: ["src"],
          relevantDocs: ["docs/ref/LoopEngineering.md"],
          buildTestCommands: ["npm test"],
          constraints: ["smallest possible diff"],
        },
        executionPolicy: {
          autonomyLevel: "L2",
          maxAttempts: 3,
          perAttemptTimeoutMs: 300000,
          totalRuntimeBudgetMs: 900000,
          tokenBudget: 200000,
          worktreeRequired: true,
        },
        safetyPolicy: {
          allowlistPaths: ["src/**"],
          denylistPaths: [".env", "auth/**"],
          maxFilesTouched: 10,
          humanGateConditions: ["touches gated path"],
        },
        verification: {
          verifierType: "command",
          requiredChecks: ["npm test"],
          rejectOn: ["tests fail"],
          evidenceRequired: ["command output"],
        },
        escalationAndExit: {
          escalationTargets: ["human"],
          pauseOn: ["missing information"],
          stopOn: ["budget exhausted"],
          terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
        },
      }),
    );

    const contract = await loadContract(filePath);
    expect(contract.executionPolicy.autonomyLevel).toBe("L2");
    expect(contract.executionPolicy.worktreeRequired).toBe(true);
  });

  it("rejects a contract without a success condition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccloop-contract-"));
    const filePath = join(dir, "broken.json");
    await writeFile(filePath, JSON.stringify({ objective: { taskId: "task-1", goal: "x" } }));

    await expect(loadContract(filePath)).rejects.toThrow(/successCondition/i);
  });
});
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npm test -- tests/contract/loadContract.test.ts`

Expected: FAIL because the contract loader and schema do not exist.

- [ ] **Step 3: Write the schema and loader**

```ts
// src/contract/schema.ts
import { z } from "zod";

export const terminalStateSchema = z.enum([
  "succeeded",
  "blocked_waiting_human",
  "exhausted",
  "cancelled",
  "failed",
]);

export const loopContractSchema = z.object({
  objective: z.object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    successCondition: z.string().min(1),
    nonGoals: z.array(z.string()).default([]),
  }),
  context: z.object({
    repoPath: z.string().min(1),
    targetPaths: z.array(z.string()).min(1),
    relevantDocs: z.array(z.string()).default([]),
    buildTestCommands: z.array(z.string()).min(1),
    constraints: z.array(z.string()).default([]),
  }),
  executionPolicy: z.object({
    autonomyLevel: z.literal("L2"),
    maxAttempts: z.number().int().positive(),
    perAttemptTimeoutMs: z.number().int().positive(),
    totalRuntimeBudgetMs: z.number().int().positive(),
    tokenBudget: z.number().int().positive(),
    worktreeRequired: z.literal(true),
  }),
  safetyPolicy: z.object({
    allowlistPaths: z.array(z.string()).default([]),
    denylistPaths: z.array(z.string()).default([]),
    maxFilesTouched: z.number().int().positive(),
    humanGateConditions: z.array(z.string()).default([]),
  }),
  verification: z.object({
    verifierType: z.enum(["command", "agent"]),
    requiredChecks: z.array(z.string()).min(1),
    rejectOn: z.array(z.string()).min(1),
    evidenceRequired: z.array(z.string()).default([]),
  }),
  escalationAndExit: z.object({
    escalationTargets: z.array(z.string()).default([]),
    pauseOn: z.array(z.string()).default([]),
    stopOn: z.array(z.string()).default([]),
    terminalStates: z.array(terminalStateSchema).default([
      "succeeded",
      "blocked_waiting_human",
      "exhausted",
      "cancelled",
      "failed",
    ]),
  }),
});

export type LoopContract = z.infer<typeof loopContractSchema>;
```

```ts
// src/contract/loadContract.ts
import { readFile } from "node:fs/promises";
import { loopContractSchema, type LoopContract } from "./schema";

export async function loadContract(filePath: string): Promise<LoopContract> {
  const rawText = await readFile(filePath, "utf8");
  const rawJson = JSON.parse(rawText) as unknown;
  return loopContractSchema.parse(rawJson);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run:
- `npm test -- tests/contract/loadContract.test.ts`
- `npm run typecheck`

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/contract/schema.ts src/contract/loadContract.ts tests/contract/loadContract.test.ts
git commit -m "feat: add V1 loop contract validation"
```

### Task 3: Implement run-state types, legal transitions, and stop control

**Files:**
- Create: `src/state/types.ts`
- Create: `src/state/stateMachine.ts`
- Create: `src/stop/stopController.ts`
- Test: `tests/state/stateMachine.test.ts`
- Test: `tests/stop/stopController.test.ts`

**Interfaces:**
- Consumes: `LoopContract`
- Produces: `type RunStatus`
- Produces: `type StopDecision`
- Produces: `transitionRunState(state: RunState, next: RunStatus, reason?: string): RunState`
- Produces: `evaluateStopDecision(input: StopDecisionInput): StopDecision`

- [ ] **Step 1: Write the failing state/stop tests**

```ts
// tests/state/stateMachine.test.ts
import { describe, expect, it } from "vitest";
import { transitionRunState } from "../../src/state/stateMachine";
import type { RunState } from "../../src/state/types";

const baseState: RunState = {
  status: "queued",
  currentAttempt: 0,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-14T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: {
    attemptsRemaining: 3,
    timeRemainingMs: 900000,
    tokenBudgetRemaining: 200000,
  },
  recentFailures: [],
};

describe("transitionRunState", () => {
  it("allows queued -> planning", () => {
    expect(transitionRunState(baseState, "planning").status).toBe("planning");
  });

  it("rejects succeeded -> planning", () => {
    expect(() => transitionRunState({ ...baseState, status: "succeeded" }, "planning")).toThrow(/illegal/i);
  });
});
```

```ts
// tests/stop/stopController.test.ts
import { describe, expect, it } from "vitest";
import { evaluateStopDecision } from "../../src/stop/stopController";

describe("evaluateStopDecision", () => {
  it("returns retryable after the first failed attempt", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 1,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/core.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("retryable");
  });

  it("blocks retries after the first failed attempt", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 2,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/core.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("blocked_waiting_human");
  });

  it("exhausts after repeated failure pattern", () => {
    expect(
      evaluateStopDecision({
        humanCancelled: false,
        successSatisfied: false,
        humanGateHit: false,
        attemptNumber: 2,
        maxAttempts: 3,
        budgetExceeded: false,
        recentFailures: [
          {
            rejectCategory: "tests-failed",
            primaryTargetPaths: ["src/core.ts"],
            failingCommand: "npm test",
          },
        ],
        verifier: {
          approved: false,
          rejectCategory: "tests-failed",
          primaryTargetPaths: ["src/core.ts"],
          failingCommand: "npm test",
          safeToRetry: true,
        },
      }).kind,
    ).toBe("exhausted");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
- `npm test -- tests/state/stateMachine.test.ts`
- `npm test -- tests/stop/stopController.test.ts`

Expected: FAIL because the state and stop modules do not exist.

- [ ] **Step 3: Write the minimal state and stop logic**

```ts
// src/state/types.ts
export type RunStatus =
  | "queued"
  | "planning"
  | "executing"
  | "verifying"
  | "succeeded"
  | "blocked_waiting_human"
  | "exhausted"
  | "cancelled"
  | "failed";

export type FailureFingerprint = {
  rejectCategory: string;
  primaryTargetPaths: string[];
  failingCommand: string | null;
};

export type BudgetSnapshot = {
  attemptsRemaining: number;
  timeRemainingMs: number;
  tokenBudgetRemaining: number;
};

export type RunState = {
  status: RunStatus;
  currentAttempt: number;
  attemptsUsed: number;
  lastTransitionAt: string;
  waitingOnHuman: boolean;
  stopReason: string | null;
  budgetSnapshot: BudgetSnapshot;
  recentFailures: FailureFingerprint[];
};

export type StopDecision = {
  kind: "retryable" | "succeeded" | "blocked_waiting_human" | "exhausted" | "cancelled" | "failed";
  reason: string;
};

export type StopDecisionInput = {
  humanCancelled: boolean;
  successSatisfied: boolean;
  humanGateHit: boolean;
  attemptNumber: number;
  maxAttempts: number;
  budgetExceeded: boolean;
  recentFailures: FailureFingerprint[];
  verifier: {
    approved: boolean;
    rejectCategory: string;
    primaryTargetPaths: string[];
    failingCommand: string | null;
    safeToRetry: boolean;
  };
};
```

```ts
// src/state/stateMachine.ts
import type { RunState, RunStatus } from "./types";

const legalTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ["planning", "cancelled"],
  planning: ["executing", "blocked_waiting_human", "cancelled", "failed"],
  executing: ["verifying", "blocked_waiting_human", "cancelled", "failed"],
  verifying: ["planning", "succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
  succeeded: [],
  blocked_waiting_human: [],
  exhausted: [],
  cancelled: [],
  failed: [],
};

export function transitionRunState(state: RunState, next: RunStatus, reason?: string): RunState {
  if (!legalTransitions[state.status].includes(next)) {
    throw new Error(`illegal transition: ${state.status} -> ${next}`);
  }

  return {
    ...state,
    status: next,
    waitingOnHuman: next === "blocked_waiting_human",
    stopReason: reason ?? state.stopReason,
    lastTransitionAt: new Date().toISOString(),
  };
}
```

```ts
// src/stop/stopController.ts
import type { FailureFingerprint, StopDecision, StopDecisionInput } from "../state/types";

function isRepeatedFailure(previous: FailureFingerprint | undefined, current: StopDecisionInput["verifier"]): boolean {
  if (!previous) return false;

  return (
    previous.rejectCategory === current.rejectCategory &&
    JSON.stringify(previous.primaryTargetPaths) === JSON.stringify(current.primaryTargetPaths) &&
    previous.failingCommand === current.failingCommand
  );
}

export function evaluateStopDecision(input: StopDecisionInput): StopDecision {
  if (input.humanCancelled) return { kind: "cancelled", reason: "human cancel or kill switch" };
  if (input.successSatisfied || input.verifier.approved) return { kind: "succeeded", reason: "success condition satisfied" };
  if (input.humanGateHit) return { kind: "blocked_waiting_human", reason: "human gate or denylist hit" };
  if (input.attemptNumber >= input.maxAttempts) return { kind: "exhausted", reason: "attempt limit reached" };
  if (input.budgetExceeded) return { kind: "exhausted", reason: "runtime or token budget exhausted" };
  if (isRepeatedFailure(input.recentFailures.at(-1), input.verifier)) {
    return { kind: "exhausted", reason: "repeated failure pattern detected" };
  }
  if (!input.verifier.safeToRetry) return { kind: "failed", reason: "verifier rejection with no safe retry path" };
  if (input.attemptNumber > 1) {
    return { kind: "blocked_waiting_human", reason: "retry after first failed attempt requires human approval" };
  }
  return { kind: "retryable", reason: "first failed attempt is safe to retry" };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run:
- `npm test -- tests/state/stateMachine.test.ts`
- `npm test -- tests/stop/stopController.test.ts`
- `npm run typecheck`

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/stateMachine.ts src/stop/stopController.ts tests/state/stateMachine.test.ts tests/stop/stopController.test.ts
git commit -m "feat: add V1 state machine and stop controller"
```

### Task 4: Persist contract, run state, events, and attempt artifacts

**Files:**
- Create: `src/persistence/fileStore.ts`
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: `LoopContract`, `RunState`
- Produces: `initializeRunFiles(runDir: string, contract: LoopContract, initialState: RunState): Promise<void>`
- Produces: `writeRunState(runDir: string, state: RunState): Promise<void>`
- Produces: `appendEvent(runDir: string, event: RunEvent): Promise<void>`
- Produces: `writeAttemptArtifacts(runDir: string, attempt: number, artifacts: AttemptArtifacts): Promise<void>`

- [ ] **Step 1: Write the failing persistence test**

```ts
// tests/persistence/fileStore.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { initializeRunFiles, appendEvent, writeAttemptArtifacts, writeRunState } from "../../src/persistence/fileStore";
import type { LoopContract } from "../../src/contract/schema";
import type { RunState } from "../../src/state/types";

const contract: LoopContract = {
  objective: { taskId: "task-1", goal: "Fix test", successCondition: "tests pass", nonGoals: [] },
  context: { repoPath: "/tmp/repo", targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true },
  safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
  verification: { verifierType: "command", requiredChecks: ["npm test"], rejectOn: ["tests fail"], evidenceRequired: [] },
  escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
};

const state: RunState = {
  status: "queued",
  currentAttempt: 0,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-14T00:00:00.000Z",
  waitingOnHuman: false,
  stopReason: null,
  budgetSnapshot: { attemptsRemaining: 3, timeRemainingMs: 5000, tokenBudgetRemaining: 1000 },
  recentFailures: [],
};

describe("fileStore", () => {
  it("writes contract, state, events, and attempt artifacts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await initializeRunFiles(runDir, contract, state);
    await appendEvent(runDir, { type: "attempt_started", at: "2026-07-14T00:00:01.000Z", detail: "attempt 1" });
    await writeAttemptArtifacts(runDir, 1, {
      plan: { summary: "change src/index.ts" },
      execution: { changedFiles: ["src/index.ts"], commandOutputs: ["ok"] },
      verify: { approved: false, rejectCategory: "tests-failed" },
      diffPatch: "diff --git a/src/index.ts b/src/index.ts",
      stdoutStderrLog: "npm test\nFAIL",
    });
    await writeRunState(runDir, { ...state, status: "verifying", currentAttempt: 1, attemptsUsed: 1 });

    const savedState = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
    const savedEvents = await readFile(join(runDir, "events.jsonl"), "utf8");
    const savedPlan = JSON.parse(await readFile(join(runDir, "attempts", "1", "plan.json"), "utf8"));

    expect(savedState.status).toBe("verifying");
    expect(savedEvents).toContain("attempt_started");
    expect(savedPlan.summary).toBe("change src/index.ts");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/persistence/fileStore.test.ts`

Expected: FAIL because the persistence module does not exist.

- [ ] **Step 3: Write the file-store implementation**

```ts
// src/persistence/fileStore.ts
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopContract } from "../contract/schema";
import type { RunState } from "../state/types";

export type RunEvent = {
  type: string;
  at: string;
  detail: string;
};

export type AttemptArtifacts = {
  plan: unknown;
  execution: unknown;
  verify: unknown;
  diffPatch: string;
  stdoutStderrLog: string;
};

export async function initializeRunFiles(runDir: string, contract: LoopContract, initialState: RunState): Promise<void> {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(initialState, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify(state, null, 2));
}

export async function appendEvent(runDir: string, event: RunEvent): Promise<void> {
  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

export async function writeAttemptArtifacts(runDir: string, attempt: number, artifacts: AttemptArtifacts): Promise<void> {
  const attemptDir = join(runDir, "attempts", String(attempt));
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, "plan.json"), JSON.stringify(artifacts.plan, null, 2));
  await writeFile(join(attemptDir, "execution.json"), JSON.stringify(artifacts.execution, null, 2));
  await writeFile(join(attemptDir, "verify.json"), JSON.stringify(artifacts.verify, null, 2));
  await writeFile(join(attemptDir, "diff.patch"), artifacts.diffPatch);
  await writeFile(join(attemptDir, "stdout-stderr.log"), artifacts.stdoutStderrLog);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run:
- `npm test -- tests/persistence/fileStore.test.ts`
- `npm run typecheck`

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: persist V1 run state and artifacts"
```

### Task 5: Add isolated git worktree management

**Files:**
- Create: `src/workspace/worktreeManager.ts`
- Test: `tests/workspace/worktreeManager.test.ts`

**Interfaces:**
- Consumes: `LoopContract`
- Produces: `createAttemptWorkspace(repoPath: string, runDir: string, attempt: number): Promise<{ worktreePath: string }>`
- Produces: `cleanupAttemptWorkspace(repoPath: string, worktreePath: string): Promise<void>`

- [ ] **Step 1: Write the failing worktree test**

```ts
// tests/workspace/worktreeManager.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupAttemptWorkspace, createAttemptWorkspace } from "../../src/workspace/worktreeManager";

const execFileAsync = promisify(execFile);

describe("worktreeManager", () => {
  it("creates and removes a detached worktree", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "ccloop-repo-"));
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));

    await execFileAsync("git", ["init"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });

    const { worktreePath } = await createAttemptWorkspace(repoDir, runDir, 1);
    expect(worktreePath).toContain(runDir);

    await cleanupAttemptWorkspace(repoDir, worktreePath);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoDir });
    expect(stdout).not.toContain(worktreePath);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workspace/worktreeManager.test.ts`

Expected: FAIL because the worktree manager does not exist.

- [ ] **Step 3: Write the worktree manager**

```ts
// src/workspace/worktreeManager.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createAttemptWorkspace(repoPath: string, runDir: string, attempt: number): Promise<{ worktreePath: string }> {
  const worktreePath = join(runDir, "worktrees", `attempt-${attempt}`);
  await mkdir(join(runDir, "worktrees"), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "--detach", worktreePath], { cwd: repoPath });
  return { worktreePath };
}

export async function cleanupAttemptWorkspace(repoPath: string, worktreePath: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run:
- `npm test -- tests/workspace/worktreeManager.test.ts`
- `npm run typecheck`

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace/worktreeManager.ts tests/workspace/worktreeManager.test.ts
git commit -m "feat: add isolated worktree management"
```

### Task 6: Define runtime adapter interfaces and a deterministic scripted adapter

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/scriptedAdapter.ts`
- Test: `tests/runtime/scriptedAdapter.test.ts`

**Interfaces:**
- Consumes: `LoopContract`, `RunState`
- Produces: `type AttemptPlan`
- Produces: `type ExecutionResult`
- Produces: `type VerificationResult`
- Produces: `interface RuntimeAdapter`
- Produces: `class ScriptedAdapter implements RuntimeAdapter`

- [ ] **Step 1: Write the failing adapter test**

```ts
// tests/runtime/scriptedAdapter.test.ts
import { describe, expect, it } from "vitest";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter";

describe("ScriptedAdapter", () => {
  it("returns the next scripted plan, execution result, and verification result", async () => {
    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["npm test passed"] },
      },
    ]);

    const plan = await adapter.plan();
    const execution = await adapter.execute();
    const verification = await adapter.verify();

    expect(plan.summary).toBe("change src/index.ts");
    expect(execution.changedFiles).toEqual(["src/index.ts"]);
    expect(verification.approved).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/runtime/scriptedAdapter.test.ts`

Expected: FAIL because the runtime adapter modules do not exist.

- [ ] **Step 3: Write the adapter interface and scripted adapter**

```ts
// src/runtime/types.ts
export type AttemptPlan = {
  summary: string;
  primaryTargetPaths: string[];
};

export type ExecutionResult = {
  changedFiles: string[];
  diffPatch: string;
  commandOutputs: string[];
  stdoutStderrLog: string;
};

export type VerificationResult = {
  approved: boolean;
  rejectCategory: string;
  primaryTargetPaths: string[];
  failingCommand: string | null;
  safeToRetry: boolean;
  evidence: string[];
};

export interface RuntimeAdapter {
  plan(): Promise<AttemptPlan>;
  execute(): Promise<ExecutionResult>;
  verify(): Promise<VerificationResult>;
}
```

```ts
// src/runtime/scriptedAdapter.ts
import type { AttemptPlan, ExecutionResult, RuntimeAdapter, VerificationResult } from "./types";

export type ScriptedFrame = {
  plan: AttemptPlan;
  execution: ExecutionResult;
  verification: VerificationResult;
};

export class ScriptedAdapter implements RuntimeAdapter {
  private readonly frames: ScriptedFrame[];
  private currentFrame: ScriptedFrame | null = null;

  constructor(frames: ScriptedFrame[]) {
    this.frames = [...frames];
  }

  async plan(): Promise<AttemptPlan> {
    const frame = this.frames.shift();
    if (!frame) throw new Error("no scripted frame remaining");
    this.currentFrame = frame;
    return frame.plan;
  }

  async execute(): Promise<ExecutionResult> {
    if (!this.currentFrame) throw new Error("plan must run before execute");
    return this.currentFrame.execution;
  }

  async verify(): Promise<VerificationResult> {
    if (!this.currentFrame) throw new Error("plan must run before verify");
    return this.currentFrame.verification;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run:
- `npm test -- tests/runtime/scriptedAdapter.test.ts`
- `npm run typecheck`

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/types.ts src/runtime/scriptedAdapter.ts tests/runtime/scriptedAdapter.test.ts
git commit -m "feat: add runtime adapter interface and scripted adapter"
```

### Task 7: Orchestrate one full V1 run through the controller

**Files:**
- Create: `src/controller/runLoop.ts`
- Test: `tests/controller/runLoop.integration.test.ts`

**Interfaces:**
- Consumes: `LoopContract`, `RunState`, `RuntimeAdapter`, `evaluateStopDecision`, `transitionRunState`, file-store helpers, worktree helpers
- Produces: `runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState>`

- [ ] **Step 1: Write the failing integration tests**

```ts
// tests/controller/runLoop.integration.test.ts
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/controller/runLoop";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter";
import type { LoopContract } from "../../src/contract/schema";

const contract: LoopContract = {
  objective: { taskId: "task-1", goal: "Fix test", successCondition: "required checks pass", nonGoals: [] },
  context: { repoPath: process.cwd(), targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
  executionPolicy: { autonomyLevel: "L2", maxAttempts: 3, perAttemptTimeoutMs: 1000, totalRuntimeBudgetMs: 5000, tokenBudget: 1000, worktreeRequired: true },
  safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
  verification: { verifierType: "agent", requiredChecks: ["npm test"], rejectOn: ["tests fail"], evidenceRequired: [] },
  escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
};

describe("runLoop", () => {
  it("succeeds when verification approves", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
        execution: { changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" },
        verification: { approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["npm test passed"] },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);
    expect(finalState.status).toBe("succeeded");
  });

  it("blocks after the second failed attempt because L2 requires human approval", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const adapter = new ScriptedAdapter([
      {
        plan: { summary: "change src/a.ts", primaryTargetPaths: ["src/a.ts"] },
        execution: { changedFiles: ["src/a.ts"], diffPatch: "diff --git a/src/a.ts b/src/a.ts", commandOutputs: ["edited"], stdoutStderrLog: "fail" },
        verification: { approved: false, rejectCategory: "tests-failed", primaryTargetPaths: ["src/a.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"] },
      },
      {
        plan: { summary: "change src/a.ts again", primaryTargetPaths: ["src/a.ts"] },
        execution: { changedFiles: ["src/a.ts"], diffPatch: "diff --git a/src/a.ts b/src/a.ts", commandOutputs: ["edited again"], stdoutStderrLog: "fail" },
        verification: { approved: false, rejectCategory: "different-reason", primaryTargetPaths: ["src/a.ts"], failingCommand: "npm test", safeToRetry: true, evidence: ["FAIL"] },
      },
    ]);

    const finalState = await runLoop(contract, runDir, adapter);
    expect(finalState.status).toBe("blocked_waiting_human");
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm test -- tests/controller/runLoop.integration.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Write the controller orchestration**

```ts
// src/controller/runLoop.ts
import { initializeRunFiles, appendEvent, writeAttemptArtifacts, writeRunState } from "../persistence/fileStore";
import { evaluateStopDecision } from "../stop/stopController";
import { transitionRunState } from "../state/stateMachine";
import type { LoopContract } from "../contract/schema";
import type { FailureFingerprint, RunState } from "../state/types";
import type { RuntimeAdapter } from "../runtime/types";

function initialState(contract: LoopContract): RunState {
  return {
    status: "queued",
    currentAttempt: 0,
    attemptsUsed: 0,
    lastTransitionAt: new Date().toISOString(),
    waitingOnHuman: false,
    stopReason: null,
    budgetSnapshot: {
      attemptsRemaining: contract.executionPolicy.maxAttempts,
      timeRemainingMs: contract.executionPolicy.totalRuntimeBudgetMs,
      tokenBudgetRemaining: contract.executionPolicy.tokenBudget,
    },
    recentFailures: [],
  };
}

export async function runLoop(contract: LoopContract, runDir: string, adapter: RuntimeAdapter): Promise<RunState> {
  let state = initialState(contract);
  await initializeRunFiles(runDir, contract, state);

  while (true) {
    state = transitionRunState(state, "planning");
    await writeRunState(runDir, state);

    const attempt = state.attemptsUsed + 1;
    const plan = await adapter.plan();
    state = transitionRunState({ ...state, currentAttempt: attempt, attemptsUsed: attempt }, "executing");
    await appendEvent(runDir, { type: "attempt_started", at: new Date().toISOString(), detail: `attempt ${attempt}` });
    await writeRunState(runDir, state);

    const execution = await adapter.execute();
    state = transitionRunState(state, "verifying");
    await writeRunState(runDir, state);

    const verification = await adapter.verify();
    await writeAttemptArtifacts(runDir, attempt, {
      plan,
      execution,
      verify: verification,
      diffPatch: execution.diffPatch,
      stdoutStderrLog: execution.stdoutStderrLog,
    });

    const decision = evaluateStopDecision({
      humanCancelled: false,
      successSatisfied: verification.approved,
      humanGateHit: false,
      attemptNumber: attempt,
      maxAttempts: contract.executionPolicy.maxAttempts,
      budgetExceeded: false,
      recentFailures: state.recentFailures,
      verifier: verification,
    });

    if (decision.kind === "retryable") {
      const failure: FailureFingerprint = {
        rejectCategory: verification.rejectCategory,
        primaryTargetPaths: verification.primaryTargetPaths,
        failingCommand: verification.failingCommand,
      };
      state = transitionRunState(
        {
          ...state,
          recentFailures: [...state.recentFailures, failure],
          budgetSnapshot: {
            ...state.budgetSnapshot,
            attemptsRemaining: contract.executionPolicy.maxAttempts - attempt,
          },
        },
        "planning",
        decision.reason,
      );
      await writeRunState(runDir, state);
      continue;
    }

    state = transitionRunState(state, decision.kind, decision.reason);
    await appendEvent(runDir, { type: `loop_${decision.kind}`, at: new Date().toISOString(), detail: decision.reason });
    await writeRunState(runDir, state);
    return state;
  }
}
```

- [ ] **Step 4: Run integration tests and the full test suite**

Run:
- `npm test -- tests/controller/runLoop.integration.test.ts`
- `npm test`
- `npm run typecheck`

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/controller/runLoop.ts tests/controller/runLoop.integration.test.ts
git commit -m "feat: orchestrate the V1 loop controller"
```

### Task 8: Add the subprocess-based Claude adapter and wire the CLI to real runs

**Files:**
- Create: `src/runtime/claude/prompts.ts`
- Create: `src/runtime/claude/subprocessClaudeAdapter.ts`
- Create: `tests/fixtures/fake-claude.mjs`
- Test: `tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `LoopContract`, `RunState`, `AttemptPlan`, `ExecutionResult`, `VerificationResult`, `runLoop()`
- Produces: `type SubprocessAdapterConfig = { plannerCommand: string[]; executorCommand: string[]; verifierCommand: string[] }`
- Produces: `class SubprocessClaudeAdapter implements RuntimeAdapter`

- [ ] **Step 1: Write the failing Claude adapter test**

```ts
// tests/runtime/claude/subprocessClaudeAdapter.test.ts
import { describe, expect, it } from "vitest";
import { SubprocessClaudeAdapter } from "../../../src/runtime/claude/subprocessClaudeAdapter";

const adapter = new SubprocessClaudeAdapter({
  plannerCommand: ["node", "tests/fixtures/fake-claude.mjs", "plan"],
  executorCommand: ["node", "tests/fixtures/fake-claude.mjs", "execute"],
  verifierCommand: ["node", "tests/fixtures/fake-claude.mjs", "verify"],
});

describe("SubprocessClaudeAdapter", () => {
  it("parses planner, executor, and verifier JSON output", async () => {
    expect((await adapter.plan()).summary).toBe("change src/index.ts");
    expect((await adapter.execute()).changedFiles).toEqual(["src/index.ts"]);
    expect((await adapter.verify()).approved).toBe(true);
  });
});
```

```js
// tests/fixtures/fake-claude.mjs
const mode = process.argv[2];
if (mode === "plan") {
  console.log(JSON.stringify({ summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] }));
} else if (mode === "execute") {
  console.log(JSON.stringify({ changedFiles: ["src/index.ts"], diffPatch: "diff --git a/src/index.ts b/src/index.ts", commandOutputs: ["edited"], stdoutStderrLog: "ok" }));
} else {
  console.log(JSON.stringify({ approved: true, rejectCategory: "", primaryTargetPaths: ["src/index.ts"], failingCommand: null, safeToRetry: false, evidence: ["npm test passed"] }));
}
```

- [ ] **Step 2: Run the adapter test to verify it fails**

Run: `npm test -- tests/runtime/claude/subprocessClaudeAdapter.test.ts`

Expected: FAIL because the subprocess Claude adapter does not exist.

- [ ] **Step 3: Write the Claude adapter and CLI wiring**

```ts
// src/runtime/claude/prompts.ts
import type { LoopContract } from "../../contract/schema";

export function buildPlannerPrompt(contract: LoopContract): string {
  return `Return JSON only. Plan one L2 attempt for task ${contract.objective.taskId}. Goal: ${contract.objective.goal}. Success condition: ${contract.objective.successCondition}.`;
}

export function buildExecutorPrompt(contract: LoopContract): string {
  return `Return JSON only. Execute one isolated attempt for task ${contract.objective.taskId}. Never declare final success.`;
}

export function buildVerifierPrompt(contract: LoopContract): string {
  return `Return JSON only. Verify whether the success condition is met for task ${contract.objective.taskId}. Prefer rejection-by-evidence.`;
}
```

```ts
// src/runtime/claude/subprocessClaudeAdapter.ts
import { spawn } from "node:child_process";
import type { RuntimeAdapter, AttemptPlan, ExecutionResult, VerificationResult } from "../types";

type SubprocessAdapterConfig = {
  plannerCommand: string[];
  executorCommand: string[];
  verifierCommand: string[];
};

async function runJsonCommand(command: string[]): Promise<unknown> {
  const [file, ...args] = command;
  return await new Promise((resolve, reject) => {
    const child = spawn(file!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `command failed with exit code ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

export class SubprocessClaudeAdapter implements RuntimeAdapter {
  constructor(private readonly config: SubprocessAdapterConfig) {}

  async plan(): Promise<AttemptPlan> {
    return (await runJsonCommand(this.config.plannerCommand)) as AttemptPlan;
  }

  async execute(): Promise<ExecutionResult> {
    return (await runJsonCommand(this.config.executorCommand)) as ExecutionResult;
  }

  async verify(): Promise<VerificationResult> {
    return (await runJsonCommand(this.config.verifierCommand)) as VerificationResult;
  }
}
```

```ts
// src/cli.ts
import { readFile } from "node:fs/promises";
import { loadContract } from "./contract/loadContract";
import { runLoop } from "./controller/runLoop";
import { ScriptedAdapter } from "./runtime/scriptedAdapter";
import { SubprocessClaudeAdapter } from "./runtime/claude/subprocessClaudeAdapter";

// keep ParsedArgs and parseArgs from Task 1

async function loadAdapter(parsed: ParsedArgs) {
  const config = JSON.parse(await readFile(parsed.adapterConfigPath, "utf8")) as any;

  if (parsed.adapter === "scripted") {
    return new ScriptedAdapter(config.frames);
  }

  return new SubprocessClaudeAdapter(config);
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const contract = await loadContract(parsed.contractPath);
    const adapter = await loadAdapter(parsed);
    const finalState = await runLoop(contract, parsed.runDir, adapter);
    return finalState.status === "succeeded" ? 0 : 2;
  } catch {
    return 1;
  }
}
```

```ts
// src/index.ts
export { main, parseArgs } from "./cli";
export { loadContract } from "./contract/loadContract";
export { runLoop } from "./controller/runLoop";
```

- [ ] **Step 4: Run adapter tests and the full suite**

Run:
- `npm test -- tests/runtime/claude/subprocessClaudeAdapter.test.ts`
- `npm test`
- `npm run typecheck`

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/claude/prompts.ts src/runtime/claude/subprocessClaudeAdapter.ts src/cli.ts src/index.ts tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/fixtures/fake-claude.mjs
git commit -m "feat: add Claude subprocess adapter and CLI run wiring"
```

### Task 9: Add runnable V1 examples and final smoke coverage

**Files:**
- Create: `examples/v1/minimal-contract.json`
- Create: `examples/v1/scripted-adapter-config.json`
- Create: `examples/v1/claude-adapter-config.json`
- Modify: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `main(argv: string[]): Promise<number>`
- Produces: runnable local examples for scripted and Claude-backed runs

- [ ] **Step 1: Write the failing smoke test for the example contract**

```ts
// add to tests/cli/cli.test.ts
it("returns 0 for the scripted example run", async () => {
  await expect(
    main([
      "run",
      "--contract",
      "examples/v1/minimal-contract.json",
      "--run-dir",
      ".runs/example-scripted",
      "--adapter",
      "scripted",
      "--adapter-config",
      "examples/v1/scripted-adapter-config.json",
    ]),
  ).resolves.toBe(0);
});
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `npm test -- tests/cli/cli.test.ts`

Expected: FAIL because the example contract and adapter config files do not exist yet.

- [ ] **Step 3: Write the runnable examples**

```json
// examples/v1/minimal-contract.json
{
  "objective": {
    "taskId": "example-1",
    "goal": "Demonstrate a successful scripted loop run",
    "successCondition": "The verifier approves the first attempt",
    "nonGoals": ["Do not modify remote state"]
  },
  "context": {
    "repoPath": ".",
    "targetPaths": ["src"],
    "relevantDocs": ["docs/superpowers/specs/2026-07-14-loop-engineer-framework-design.md"],
    "buildTestCommands": ["npm test"],
    "constraints": ["smallest possible diff"]
  },
  "executionPolicy": {
    "autonomyLevel": "L2",
    "maxAttempts": 3,
    "perAttemptTimeoutMs": 300000,
    "totalRuntimeBudgetMs": 900000,
    "tokenBudget": 200000,
    "worktreeRequired": true
  },
  "safetyPolicy": {
    "allowlistPaths": ["src/**"],
    "denylistPaths": [".env", "auth/**"],
    "maxFilesTouched": 10,
    "humanGateConditions": ["touches gated path"]
  },
  "verification": {
    "verifierType": "agent",
    "requiredChecks": ["npm test"],
    "rejectOn": ["tests fail"],
    "evidenceRequired": ["command output"]
  },
  "escalationAndExit": {
    "escalationTargets": ["human"],
    "pauseOn": ["missing information"],
    "stopOn": ["budget exhausted"],
    "terminalStates": ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"]
  }
}
```

```json
// examples/v1/scripted-adapter-config.json
{
  "frames": [
    {
      "plan": {
        "summary": "change src/index.ts",
        "primaryTargetPaths": ["src/index.ts"]
      },
      "execution": {
        "changedFiles": ["src/index.ts"],
        "diffPatch": "diff --git a/src/index.ts b/src/index.ts",
        "commandOutputs": ["edited"],
        "stdoutStderrLog": "ok"
      },
      "verification": {
        "approved": true,
        "rejectCategory": "",
        "primaryTargetPaths": ["src/index.ts"],
        "failingCommand": null,
        "safeToRetry": false,
        "evidence": ["npm test passed"]
      }
    }
  ]
}
```

```json
// examples/v1/claude-adapter-config.json
{
  "plannerCommand": ["claude", "-p", "planner prompt is provided by wrapper"],
  "executorCommand": ["claude", "-p", "executor prompt is provided by wrapper"],
  "verifierCommand": ["claude", "-p", "verifier prompt is provided by wrapper"]
}
```

- [ ] **Step 4: Run the example smoke test and a local demo command**

Run:
- `npm test -- tests/cli/cli.test.ts`
- `npm test`
- `npm run build`
- `node dist/cli.js run --contract examples/v1/minimal-contract.json --run-dir .runs/example-scripted --adapter scripted --adapter-config examples/v1/scripted-adapter-config.json`

Expected:
- all tests pass
- build passes
- the demo command exits with code `0`
- `.runs/example-scripted/loop-state.json` ends in `"status": "succeeded"`

- [ ] **Step 5: Commit**

```bash
git add examples/v1/minimal-contract.json examples/v1/scripted-adapter-config.json examples/v1/claude-adapter-config.json tests/cli/cli.test.ts
git commit -m "feat: add runnable V1 loop examples"
```

## Self-Review

- **Spec coverage:**
  - contract fields and validation: Task 2
  - state machine, retry semantics, stop ordering, repeated-failure rule: Task 3
  - durable state, event ledger, and attempt artifacts: Task 4
  - isolated worktrees: Task 5
  - runtime adapters and Claude adapter: Tasks 6 and 8
  - end-to-end L2 orchestration: Task 7
  - runnable examples and smoke path: Task 9
- **Placeholder scan:** no `TODO`, `TBD`, or unnamed interfaces remain.
- **Type consistency:** `LoopContract`, `RunState`, `StopDecision`, `RuntimeAdapter`, and `runLoop()` names are consistent across tasks.
