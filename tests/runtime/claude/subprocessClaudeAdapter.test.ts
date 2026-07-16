import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SubprocessClaudeAdapter } from "../../../src/runtime/claude/subprocessClaudeAdapter.js";

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

const adapter = new SubprocessClaudeAdapter({
  command: ["node", "tests/fixtures/fake-claude.mjs"],
});

async function createFakeClaudeBinary(source: string): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ccloop-claude-bin-"));
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, `#!/usr/bin/env node
${source}`);
  await chmod(claudePath, 0o755);
  return binDir;
}

async function createNodeScript(prefix: string, source: string): Promise<string> {
  const scriptDir = await mkdtemp(join(tmpdir(), prefix));
  const scriptPath = join(scriptDir, "script.mjs");
  await writeFile(scriptPath, source);
  return scriptPath;
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

async function waitForFileToContain(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const contents = await readFile(path, "utf8");
      if (contents.includes(expected)) {
        return;
      }
    } catch {
      // wait for the fixture to write the marker file
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`timed out waiting for ${path} to contain ${expected}`);
}

describe("SubprocessClaudeAdapter", () => {
  it("passes phase context through the wrapper and parses structured JSON", async () => {
    const context = {
      attempt: 1,
      runDir: ".runs/demo",
      worktreePath: "/tmp/worktree",
      contract,
      state: { status: "planning" },
    } as any;

    expect((await adapter.plan(context)).summary).toBe("change src/index.ts");

    const execution = await adapter.execute(context);
    expect(execution.changedFiles).toEqual(["src/index.ts"]);
    expect(execution.commandOutputs).toEqual(["/tmp/worktree"]);

    expect((await adapter.verify(context)).approved).toBe(true);
  });

  it("preserves partial execute outcomes returned by the wrapper", async () => {
    const context = {
      attempt: 2,
      runDir: ".runs/partial",
      worktreePath: "/tmp/worktree",
      contract,
      state: { status: "executing" },
    } as any;

    await expect(adapter.execute(context)).resolves.toMatchObject({
      completionStatus: "partial",
      failureType: "timeout",
      failureMessage: "subprocess timed out",
      changedFiles: ["secret.txt"],
    });
  });

  it("waits for close before parsing wrapper stdout", async () => {
    const delayedWrapperPath = await createNodeScript(
      "ccloop-wrapper-close-",
      `let body = "";
for await (const chunk of process.stdin) {
  body += chunk.toString();
}
const request = JSON.parse(body);
const payload = JSON.stringify({
  changedFiles: ["src/index.ts"],
  diffPatch: "diff --git a/src/index.ts b/src/index.ts",
  commandOutputs: [request.worktreePath],
  stdoutStderrLog: "ok"
});
const splitAt = payload.length - 5;
process.stdout.write(payload.slice(0, splitAt));
const tail = ${JSON.stringify('setTimeout(() => { process.stdout.write(process.argv[1]); }, 25); setTimeout(() => process.exit(0), 35);')};
const { spawn } = await import("node:child_process");
spawn(process.execPath, ["-e", tail, payload.slice(splitAt)], { stdio: ["ignore", "inherit", "ignore"] });
process.exit(0);
`,
    );
    const delayedAdapter = new SubprocessClaudeAdapter({ command: ["node", delayedWrapperPath] });
    const context = {
      attempt: 3,
      runDir: ".runs/close",
      worktreePath: "/tmp/worktree",
      contract,
      state: { status: "executing" },
    } as any;

    await expect(delayedAdapter.execute(context)).resolves.toMatchObject({
      changedFiles: ["src/index.ts"],
      commandOutputs: ["/tmp/worktree"],
      stdoutStderrLog: "ok",
    });
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
    });
  }

  it("parses a large partial execute payload after wrapper interruption", async () => {
    const markerPath = join(await mkdtemp(join(tmpdir(), "ccloop-wrapper-large-partial-")), "marker.log");
    const worktreePath = await createCommittedRepo({
      "big.txt": "before\n",
    });
    const binDir = await createFakeClaudeBinary(`
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const markerPath = process.env.CLAUDE_MARKER_PATH;
writeFileSync(join(process.cwd(), "big.txt"), "x".repeat(400_000) + "\\n");
appendFileSync(markerPath, "started\\n");
process.on("SIGTERM", () => {
  appendFileSync(markerPath, "SIGTERM\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
    const originalPath = process.env.PATH;
    const originalMarkerPath = process.env.CLAUDE_MARKER_PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.CLAUDE_MARKER_PATH = markerPath;

    const interruptedAdapter = new SubprocessClaudeAdapter({ command: ["node", phaseRunnerPath] });
    const abortController = new AbortController();
    const context = {
      attempt: 4,
      runDir: ".runs/interrupt-large-partial",
      worktreePath,
      contract,
      state: { status: "executing" },
      abortSignal: abortController.signal,
    } as any;

    try {
      const executionPromise = interruptedAdapter.execute(context);
      await waitForFileToContain(markerPath, "started");
      abortController.abort();

      const execution = await executionPromise;
      const markerContents = await readFile(markerPath, "utf8");

      expect(markerContents).toContain("SIGTERM");
      expect(execution).toMatchObject({
        completionStatus: "partial",
        failureType: "timeout",
        changedFiles: ["big.txt"],
      });
      expect(execution.diffPatch).toContain("diff --git a/big.txt b/big.txt");
      expect(execution.diffPatch.length).toBeGreaterThan(350_000);
    } finally {
      process.env.PATH = originalPath;
      if (originalMarkerPath === undefined) {
        delete process.env.CLAUDE_MARKER_PATH;
      } else {
        process.env.CLAUDE_MARKER_PATH = originalMarkerPath;
      }
    }
  });

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
  });

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
