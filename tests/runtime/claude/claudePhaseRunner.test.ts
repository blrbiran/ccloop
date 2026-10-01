// Consolidation step 1 (2026-10-01, ccloop spec docs/superpowers/specs/2026-10-01-claude-adapter-consolidation-step1-design.md §7.1, ruling R5): moved unchanged from tests/runtime/claude/subprocessClaudeAdapter.test.ts when SubprocessClaudeAdapter was deleted; these criteria drive scripts/claude-phase-runner.mjs directly or test the prompt builders.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildExecutorPrompt, buildVerifierPrompt } from "../../../src/runtime/claude/prompts.js";

const execFileAsync = promisify(execFile);
const phaseRunnerPath = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));

const contract = {
  objective: { taskId: "task-1", goal: "Fix test", successCondition: "tests pass", nonGoals: [] },
  context: {
    repoPath: "/repo",
    targetPaths: ["src"],
    relevantDocs: [],
    buildTestCommands: ["npm test"],
    constraints: [],
  },
  executionPolicy: {
    autonomyLevel: "L2",
    maxAttempts: 3,
    perAttemptTimeoutMs: 60_000,
    totalRuntimeBudgetMs: 300_000,
    tokenBudget: 10_000,
    worktreeRequired: true,
    partialOutcomeRecoveryWindowMs: 1000,
  },
  safetyPolicy: {
    allowlistPaths: ["src/**"],
    denylistPaths: [],
    maxFilesTouched: 5,
    humanGateConditions: [],
  },
  verification: {
    verifierType: "command",
    requiredChecks: ["npm test"],
    rejectOn: ["tests fail"],
    evidenceRequired: [],
  },
  escalationAndExit: {
    escalationTargets: ["human"],
    pauseOn: [],
    stopOn: [],
    terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"],
  },
} as const;

async function createFakeClaudeBinary(source: string): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ccloop-claude-bin-"));
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, `#!/usr/bin/env node
${source}`);
  await chmod(claudePath, 0o755);
  return binDir;
}

function spawnPhaseRunner(
  request: Record<string, unknown>,
  extraEnv: NodeJS.ProcessEnv = {},
): {
  child: ReturnType<typeof spawn>;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
} {
  const child = spawn("node", [phaseRunnerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.stdin.end(JSON.stringify(request));

  return {
    child,
    result: new Promise((resolve) => {
      child.on("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    }),
  };
}

async function createCommittedRepo(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-wrapper-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(repoDir, name), contents);
  }

  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

// The marker file is written by a real subprocess we spawn, so how long it takes to appear
// is a property of machine load, not of the behavior under test. A fixed 2s budget made
// these tests fail under full-suite parallelism while passing when the file ran alone —
// a flake that reads exactly like a regression. Budget is a deadline, not an attempt count,
// so a slow poll cannot silently shorten it, and the message reports what was actually
// observed so a real hang is still distinguishable from a slow start.
const MARKER_WAIT_BUDGET_MS = 10_000;
// Vitest's 5s default is below the wait budget above, so without this the marker wait would
// never get to report its diagnostic — the test would die on a bare per-test timeout first.
// Applied only to the four tests that wait on a marker.
const MARKER_WAIT_TEST_TIMEOUT_MS = 30_000;

async function waitForFileToContain(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + MARKER_WAIT_BUDGET_MS;
  let lastObserved = "<file did not exist>";

  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, "utf8");
      if (contents.includes(expected)) {
        return;
      }
      lastObserved = JSON.stringify(contents);
    } catch {
      // wait for the fixture to write the marker file
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `timed out after ${MARKER_WAIT_BUDGET_MS}ms waiting for ${path} to contain ${expected}; last observed ${lastObserved}`,
  );
}


async function runUsageEnvelopeThroughPhaseRunner(usageLiteral: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown>;
}> {
  const worktreePath = await mkdtemp(join(tmpdir(), "ccloop-token-usage-worktree-"));
  const binDir = await createFakeClaudeBinary(`
const envelope = JSON.stringify({
  structured_output: {
    changedFiles: ["src/index.ts"],
    diffPatch: "diff --git a/src/index.ts b/src/index.ts",
    commandOutputs: ["ok"],
    stdoutStderrLog: "ok"
  },
  usage: ${usageLiteral}
});
process.stdout.write(envelope);
`);

  const { result } = spawnPhaseRunner(
    {
      phase: "execute",
      prompt: "run execute",
      attempt: 1,
      runDir: worktreePath,
      worktreePath,
      partialOutcomeRecoveryWindowMs: 1000,
    },
    {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  );

  const outcome = await result;
  return {
    ...outcome,
    payload: JSON.parse(outcome.stdout) as Record<string, unknown>,
  };
}


async function runRawEnvelopeThroughPhaseRunner(rawEnvelope: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown>;
}> {
  const worktreePath = await mkdtemp(join(tmpdir(), "ccloop-token-raw-usage-worktree-"));
  const binDir = await createFakeClaudeBinary(`
process.stdout.write(${JSON.stringify(rawEnvelope)});
`);

  const { result } = spawnPhaseRunner(
    {
      phase: "execute",
      prompt: "run execute",
      attempt: 1,
      runDir: worktreePath,
      worktreePath,
      partialOutcomeRecoveryWindowMs: 1000,
    },
    {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  );

  const outcome = await result;
  return {
    ...outcome,
    payload: JSON.parse(outcome.stdout) as Record<string, unknown>,
  };
}

function expectSuccessfulUsageOutcome(
  outcome: Awaited<ReturnType<typeof runUsageEnvelopeThroughPhaseRunner>>,
  expectedUsageEvidence: Record<string, unknown>,
  expectedTokenUsage?: number,
): void {
  expect(outcome.code).toBe(0);
  expect(outcome.signal).toBeNull();
  expect(outcome.stderr).toBe("");
  expect(outcome.payload).toMatchObject({
    changedFiles: ["src/index.ts"],
    diffPatch: "diff --git a/src/index.ts b/src/index.ts",
    commandOutputs: ["ok"],
    stdoutStderrLog: "ok",
  });
  expect(outcome.payload.usageEvidence).toEqual(expectedUsageEvidence);

  if (expectedTokenUsage === undefined) {
    expect(outcome.payload.tokenUsage).toBeUndefined();
    expect("tokenUsage" in outcome.payload).toBe(false);
  } else {
    expect(outcome.payload.tokenUsage).toBe(expectedTokenUsage);
  }

  const serializedPayload = JSON.stringify(outcome.payload);
  // Rewritten for Orca's paid claude round findings (human ruling 2026-09-27, "B3 和 B1 授权改写"): this was
  // "cache_creation_input_tokens", then the sample unknown field; the cache counts are whitelisted now, so an
  // unknown field of the duplicate-alias envelope stands in for it.
  expect(serializedPayload).not.toContain("unknown_usage_field");
  expect(serializedPayload).not.toContain("DO_NOT_PERSIST");
}

describe("claude phase runner", () => {
  it("includes the current attempt plan in the executor prompt", () => {
    const prompt = buildExecutorPrompt({
      attempt: 1,
      runDir: ".runs/demo",
      worktreePath: "/tmp/worktree",
      contract,
      state: { status: "executing" },
      plan: {
        summary: "change src/index.ts",
        primaryTargetPaths: ["src/index.ts"],
      },
    } as any);

    expect(prompt).toContain("Current attempt plan (source of truth for this execution):");
    expect(prompt).toContain('"summary": "change src/index.ts"');
    expect(prompt).toContain('"primaryTargetPaths": [');
  });

  it("includes plan, execution, rejectOn, and evidenceRequired in the verifier prompt", () => {
    const prompt = buildVerifierPrompt({
      attempt: 1,
      runDir: ".runs/demo",
      worktreePath: "/tmp/worktree",
      contract: {
        ...contract,
        verification: {
          ...contract.verification,
          evidenceRequired: ["command output"],
        },
      },
      state: { status: "verifying" },
      plan: {
        summary: "change src/index.ts",
        primaryTargetPaths: ["src/index.ts"],
      },
      execution: {
        changedFiles: ["src/index.ts"],
        diffPatch: "diff --git a/src/index.ts b/src/index.ts",
        commandOutputs: ["edited"],
        stdoutStderrLog: "ok",
      },
    } as any);

    // Rewritten under the human's 2026-10-01 ruling (rejectOn spec, option D; "点名改写必要的test"): the verifier is
    // told to reject when a condition holds, not that ccloop searches evidence for it.
    expect(prompt).toContain("Reject-on conditions (if any of these holds for this attempt, approved must be false):");
    expect(prompt).not.toContain("when present in evidence");
    expect(prompt).toContain("tests fail");
    expect(prompt).toContain("Required evidence labels (approved must be false if any are missing from evidence):");
    expect(prompt).toContain("command output");
    expect(prompt).toContain("Current attempt plan:");
    expect(prompt).toContain("Current execution outcome:");
    expect(prompt).toContain('"changedFiles": [');
    expect(prompt).toContain('"src/index.ts"');
  });


  const absentUsageFields = {
    input_tokens: { status: "absent" },
    inputTokens: { status: "absent" },
    output_tokens: { status: "absent" },
    outputTokens: { status: "absent" },
  } as const;

  // Rewritten for Orca's paid claude round findings (human ruling 2026-09-27, "B3 和 B1 授权改写"): the runner now
  // whitelists claude's two cache counts and adds each finite one to the total, so every expected evidence below records
  // them; the duplicate-alias case, whose envelope has 77 cache-creation tokens, now totals 202 instead of 125.
  const absentCacheFields = {
    cache_creation_input_tokens: { status: "absent" },
    cache_read_input_tokens: { status: "absent" },
  } as const;

  for (const testCase of [
    {
      label: "snake-only usage envelope",
      usageLiteral: '{ input_tokens: 100, output_tokens: 25 }',
      expectedTokenUsage: 125,
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: 100 },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: 25 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 125,
      },
    },
    {
      label: "camel-only usage envelope",
      usageLiteral: '{ inputTokens: 100, outputTokens: 25 }',
      expectedTokenUsage: 125,
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "absent" },
          inputTokens: { status: "finite", value: 100 },
          output_tokens: { status: "absent" },
          outputTokens: { status: "finite", value: 25 },
        },
        selectedInputField: "inputTokens",
        selectedOutputField: "outputTokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 125,
      },
    },
    {
      label: "duplicate camel and snake aliases without double counting",
      usageLiteral: `{
        input_tokens: 100,
        output_tokens: 25,
        inputTokens: 999,
        outputTokens: 888,
        cache_creation_input_tokens: 77,
        secretSentinel: "DO_NOT_PERSIST",
        unknown_usage_field: 5
      }`,
      expectedTokenUsage: 202,
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: 100 },
          inputTokens: { status: "finite", value: 999 },
          output_tokens: { status: "finite", value: 25 },
          outputTokens: { status: "finite", value: 888 },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "output_tokens",
        cacheFields: { cache_creation_input_tokens: { status: "finite", value: 77 }, cache_read_input_tokens: { status: "absent" } },
        normalizedTotal: 202,
      },
    },
    {
      label: "mixed aliases when only snake input and camel output are present",
      usageLiteral: '{ input_tokens: 100, outputTokens: 25 }',
      expectedTokenUsage: 125,
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: 100 },
          inputTokens: { status: "absent" },
          output_tokens: { status: "absent" },
          outputTokens: { status: "finite", value: 25 },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "outputTokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 125,
      },
    },
  ] as const) {
    it(`reports token usage for ${testCase.label}`, async () => {
      const outcome = await runUsageEnvelopeThroughPhaseRunner(testCase.usageLiteral);

      expectSuccessfulUsageOutcome(outcome, testCase.expectedUsageEvidence, testCase.expectedTokenUsage);
    });
  }

  for (const testCase of [
    {
      label: "missing usage keeps evidence absent",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"}}',
      expectedUsageEvidence: {
        usageStatus: "absent",
        fields: absentUsageFields,
        selectedInputField: null,
        selectedOutputField: null,
        cacheFields: absentCacheFields,
        normalizedTotal: null,
      },
    },
    {
      label: "null usage is recorded as invalid",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":null}',
      expectedUsageEvidence: {
        usageStatus: "invalid",
        fields: absentUsageFields,
        selectedInputField: null,
        selectedOutputField: null,
        cacheFields: absentCacheFields,
        normalizedTotal: null,
      },
    },
    {
      label: "all usage aliases have invalid types",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":"100","inputTokens":{"value":100},"output_tokens":null,"outputTokens":true}}',
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "invalid_type" },
          inputTokens: { status: "invalid_type" },
          output_tokens: { status: "invalid_type" },
          outputTokens: { status: "invalid_type" },
        },
        selectedInputField: null,
        selectedOutputField: null,
        cacheFields: absentCacheFields,
        normalizedTotal: null,
      },
    },
    {
      label: "invalid snake input type keeps finite output token usage",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":"100","output_tokens":25}}',
      expectedTokenUsage: 25,
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "invalid_type" },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: 25 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: null,
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 25,
      },
    },
    {
      label: "negative and fractional values preserve current semantics",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":-2.5,"output_tokens":10}}',
      expectedTokenUsage: 7.5,
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: -2.5 },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: 10 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 7.5,
      },
    },
    {
      label: "zero total is not reported",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":-10,"output_tokens":10}}',
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: -10 },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: 10 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: null,
      },
    },
    {
      label: "negative total is not reported",
      rawEnvelope:
        '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":-20,"output_tokens":10}}',
      expectedUsageEvidence: {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: -20 },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: 10 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: null,
      },
    },
  ] as const) {
    it(`reports usage evidence when ${testCase.label}`, async () => {
      const outcome = await runRawEnvelopeThroughPhaseRunner(testCase.rawEnvelope);

      expectSuccessfulUsageOutcome(outcome, testCase.expectedUsageEvidence, testCase.expectedTokenUsage);
    });
  }

  it("falls back from a non-finite snake alias to a finite camel alias", async () => {
    const outcome = await runRawEnvelopeThroughPhaseRunner(
      '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":1e400,"inputTokens":100,"output_tokens":25}}',
    );

    expectSuccessfulUsageOutcome(
      outcome,
      {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "non_finite" },
          inputTokens: { status: "finite", value: 100 },
          output_tokens: { status: "finite", value: 25 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: "inputTokens",
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 125,
      },
      125,
    );
  });

  it("ignores a non-finite alias when no finite fallback exists", async () => {
    const outcome = await runRawEnvelopeThroughPhaseRunner(
      '{"structured_output":{"changedFiles":["src/index.ts"],"diffPatch":"diff --git a/src/index.ts b/src/index.ts","commandOutputs":["ok"],"stdoutStderrLog":"ok"},"usage":{"input_tokens":1e400,"output_tokens":25}}',
    );

    expectSuccessfulUsageOutcome(
      outcome,
      {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "non_finite" },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: 25 },
          outputTokens: { status: "absent" },
        },
        selectedInputField: null,
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: 25,
      },
      25,
    );
  });

  it("omits token usage when finite selected fields overflow in sum", async () => {
    const outcome = await runUsageEnvelopeThroughPhaseRunner(
      '{ input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE }',
    );

    expectSuccessfulUsageOutcome(
      outcome,
      {
        usageStatus: "present",
        fields: {
          input_tokens: { status: "finite", value: Number.MAX_VALUE },
          inputTokens: { status: "absent" },
          output_tokens: { status: "finite", value: Number.MAX_VALUE },
          outputTokens: { status: "absent" },
        },
        selectedInputField: "input_tokens",
        selectedOutputField: "output_tokens",
        cacheFields: absentCacheFields,
        normalizedTotal: null,
      },
    );
  });

  for (const phase of ["plan", "execute", "verify"] as const) {
    it(`terminates the inner Claude process when ${phase} is interrupted`, async () => {
      const markerPath = join(await mkdtemp(join(tmpdir(), `ccloop-wrapper-${phase}-`)), "marker.log");
      const worktreePath = await mkdtemp(join(tmpdir(), `ccloop-wrapper-worktree-${phase}-`));
      const binDir = await createFakeClaudeBinary(`
import { appendFileSync } from "node:fs";
const markerPath = process.env.CLAUDE_MARKER_PATH;
appendFileSync(markerPath, "started\\n");
process.on("SIGTERM", () => {
  appendFileSync(markerPath, "SIGTERM\\n");
  process.exit(0);
});
process.on("SIGINT", () => {
  appendFileSync(markerPath, "SIGINT\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`);

      const { child, result } = spawnPhaseRunner(
        {
          phase,
          prompt: `run ${phase}`,
          attempt: 1,
          runDir: worktreePath,
          worktreePath,
          partialOutcomeRecoveryWindowMs: 1000,
        },
        {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CLAUDE_MARKER_PATH: markerPath,
        },
      );

      await waitForFileToContain(markerPath, "started");
      child.kill("SIGTERM");

      const outcome = await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`wrapper did not exit after ${phase} interruption`)), 3_000);
        }),
      ]);

      const markerContents = await readFile(markerPath, "utf8");
      expect(markerContents).toContain("SIGTERM");
      expect(outcome.code).not.toBe(0);
      expect(outcome.signal).toBeNull();
    }, MARKER_WAIT_TEST_TIMEOUT_MS);
  }

  it("includes brand-new untracked files in partial execute diff recovery", async () => {
    const worktreePath = await createCommittedRepo({
      "tracked.txt": "before\n",
    });
    const binDir = await createFakeClaudeBinary('process.stderr.write("claude exploded"); process.exit(1);');

    await writeFile(join(worktreePath, "brand-new.txt"), "brand new contents\n");

    const { result } = spawnPhaseRunner(
      {
        phase: "execute",
        prompt: "run execute",
        attempt: 1,
        runDir: worktreePath,
        worktreePath,
        partialOutcomeRecoveryWindowMs: 1000,
      },
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    const outcome = await result;
    expect(outcome.code).toBe(0);

    const partial = JSON.parse(outcome.stdout);
    expect(partial).toMatchObject({
      completionStatus: "partial",
      failureType: "error",
      changedFiles: ["brand-new.txt"],
    });
    expect(partial).not.toHaveProperty("usageEvidence");
    expect(partial).not.toHaveProperty("tokenUsage");
    expect(partial.diffPatch).toContain("diff --git a/brand-new.txt b/brand-new.txt");
    expect(partial.diffPatch).toContain("new file mode 100644");
    expect(partial.diffPatch).toContain("--- /dev/null");
    expect(partial.diffPatch).toContain("+++ b/brand-new.txt");
    expect(partial.diffPatch).toContain("+brand new contents");
  });

  // Live claude, 2026-10-01 (Orca session b5e8d368): an execute cut by its timeout had written seven ~400-word files; the
  // runner's partial reached the adapter cut at 8192 bytes, so the adapter could not parse it and dropped it. On macOS a
  // pipe write is asynchronous, and exiting right after a write that returned true loses what is still queued. A partial
  // this size, delivered after SIGTERM, must arrive whole.
  it("delivers a partial larger than one pipe chunk whole after SIGTERM", async () => {
    const worktreePath = await createCommittedRepo({ "tracked.txt": "before\n" });
    const markerPath = join(await mkdtemp(join(tmpdir(), "ccloop-large-partial-")), "marker.log");
    const binDir = await createFakeClaudeBinary(`
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CLAUDE_MARKER_PATH, "started\\n");
process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);
`);
    const line = "x".repeat(99);
    await writeFile(join(worktreePath, "large.txt"), `${line}\n`.repeat(200));

    const { child, result } = spawnPhaseRunner(
      {
        phase: "execute",
        prompt: "run execute",
        attempt: 1,
        runDir: worktreePath,
        worktreePath,
        partialOutcomeRecoveryWindowMs: 1000,
      },
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CLAUDE_MARKER_PATH: markerPath,
      },
    );
    await waitForFileToContain(markerPath, "started");
    child.kill("SIGTERM");

    const outcome = await result;
    expect(outcome.code).toBe(0);
    expect(Buffer.byteLength(outcome.stdout)).toBeGreaterThan(16_384);
    const partial = JSON.parse(outcome.stdout);
    expect(partial).toMatchObject({ completionStatus: "partial", failureType: "timeout", changedFiles: ["large.txt"] });
    expect(partial.diffPatch.split(`+${line}\n`)).toHaveLength(201);
  }, MARKER_WAIT_TEST_TIMEOUT_MS);

  it("includes both staged and unstaged edits in partial execute diff recovery", async () => {
    const worktreePath = await createCommittedRepo({
      "staged.txt": "before staged\n",
      "unstaged.txt": "before unstaged\n",
    });
    const binDir = await createFakeClaudeBinary('process.stderr.write("claude exploded"); process.exit(1);');

    await writeFile(join(worktreePath, "staged.txt"), "after staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: worktreePath });
    await writeFile(join(worktreePath, "unstaged.txt"), "after unstaged\n");

    const { result } = spawnPhaseRunner(
      {
        phase: "execute",
        prompt: "run execute",
        attempt: 1,
        runDir: worktreePath,
        worktreePath,
        partialOutcomeRecoveryWindowMs: 1000,
      },
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    const outcome = await result;
    expect(outcome.code).toBe(0);

    const partial = JSON.parse(outcome.stdout);
    expect(partial).toMatchObject({
      completionStatus: "partial",
      failureType: "error",
      changedFiles: ["staged.txt", "unstaged.txt"],
    });
    expect(partial.diffPatch).toContain("diff --git a/staged.txt b/staged.txt");
    expect(partial.diffPatch).toContain("diff --git a/unstaged.txt b/unstaged.txt");
  });

  it("waits for close before interrupting a close-pending successful execute", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "ccloop-wrapper-close-pending-success-")), "marker.log");
    const worktreePath = await createCommittedRepo({
      "dirty.txt": "before\n",
    });
    const binDir = await createFakeClaudeBinary(`
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const markerPath = process.env.CLAUDE_MARKER_PATH;
const envelope = JSON.stringify({
  structured_output: {
    changedFiles: ["inner-success.txt"],
    diffPatch: "diff --git a/inner-success.txt b/inner-success.txt",
    commandOutputs: ["inner-success"],
    stdoutStderrLog: "ok"
  }
});
appendFileSync(markerPath, "started\\n");
const splitAt = envelope.length - 8;
process.stdout.write(envelope.slice(0, splitAt));
const tail = ${JSON.stringify('const { appendFileSync } = require("node:fs"); setTimeout(() => { process.stdout.write(process.argv[1]); appendFileSync(process.env.CLAUDE_MARKER_PATH, "tail\\n"); }, 25); setTimeout(() => process.exit(0), 35);')};
spawn(process.execPath, ["-e", tail, envelope.slice(splitAt)], {
  stdio: ["ignore", "inherit", "ignore"],
  env: process.env,
});
process.exit(0);
`);

    await writeFile(join(worktreePath, "dirty.txt"), "after\n");

    const { child, result } = spawnPhaseRunner(
      {
        phase: "execute",
        prompt: "run execute",
        attempt: 1,
        runDir: worktreePath,
        worktreePath,
        partialOutcomeRecoveryWindowMs: 1000,
      },
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CLAUDE_MARKER_PATH: markerPath,
      },
    );

    await waitForFileToContain(markerPath, "started");
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.kill("SIGTERM");

    const outcome = await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("wrapper did not finish after close-pending success interruption")), 3_000);
      }),
    ]);

    expect(outcome.code).toBe(0);
    expect(outcome.signal).toBeNull();

    const payload = JSON.parse(outcome.stdout);
    expect(payload).toMatchObject({
      changedFiles: ["inner-success.txt"],
      diffPatch: "diff --git a/inner-success.txt b/inner-success.txt",
      commandOutputs: ["inner-success"],
      stdoutStderrLog: "ok",
    });
    expect(payload).not.toHaveProperty("completionStatus");
    expect(payload.changedFiles).not.toContain("dirty.txt");
    expect(await readFile(markerPath, "utf8")).toContain("tail");
  }, MARKER_WAIT_TEST_TIMEOUT_MS);

  it("returns repo-relative target paths for renamed and quoted files", async () => {
    const worktreePath = await createCommittedRepo({
      "old name.txt": "before rename\n",
    });
    const binDir = await createFakeClaudeBinary('process.stderr.write("claude exploded"); process.exit(1);');

    await execFileAsync("git", ["mv", "old name.txt", "new name.txt"], { cwd: worktreePath });
    await writeFile(join(worktreePath, 'quote "name".txt'), "new file\n");

    const { result } = spawnPhaseRunner(
      {
        phase: "execute",
        prompt: "run execute",
        attempt: 1,
        runDir: worktreePath,
        worktreePath,
        partialOutcomeRecoveryWindowMs: 1000,
      },
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    const outcome = await result;
    expect(outcome.code).toBe(0);

    const partial = JSON.parse(outcome.stdout);
    expect(partial.completionStatus).toBe("partial");
    expect(partial.failureType).toBe("error");
    expect(partial.changedFiles).toEqual(["new name.txt", 'quote "name".txt']);
    expect(partial.changedFiles).not.toContain("old name.txt");
  });

});
