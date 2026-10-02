// Crash resume (2026-10-02), spec §5.1 and §5.2 (R-B). runLoop sends claude's own `error` partial with changed files to
// verify, so it must tell claude's own partial from one the runner built: the runner marks its own with
// `partialOrigin: "runner"`, and strips the field from claude's answer (only the runner may say a partial is its own).
// T12: the executor prompt names the required checks and who runs them.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildExecutorPrompt } from "../../../src/runtime/claude/prompts.js";

const execFileAsync = promisify(execFile);
const phaseRunnerPath = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));

async function createFakeClaude(source: string): Promise<string> {
  const binDir = await mkdtemp(join(tmpdir(), "ccloop-claude-bin-"));
  await writeFile(join(binDir, "claude"), `#!/usr/bin/env node\n${source}`);
  await chmod(join(binDir, "claude"), 0o755);
  return binDir;
}

async function createRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-partial-origin-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await writeFile(join(repoDir, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function runExecute(worktreePath: string, binDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [phaseRunnerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(JSON.stringify({ phase: "execute", prompt: "run execute", attempt: 1, runDir: worktreePath, worktreePath, partialOutcomeRecoveryWindowMs: 1000 }));
  return new Promise((resolve) => { child.on("close", (code) => resolve({ code, stdout, stderr })); });
}

describe("partialOrigin (spec 2026-10-02 §5.1)", () => {
  it("marks the failure partial the runner builds after claude wrote a file and exited 1", async () => {
    const worktreePath = await createRepo();
    const binDir = await createFakeClaude('require("node:fs").writeFileSync("written.txt", "x\\n"); process.stderr.write("claude exploded"); process.exit(1);');
    const outcome = await runExecute(worktreePath, binDir);
    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      completionStatus: "partial", failureType: "error", changedFiles: ["written.txt"], partialOrigin: "runner",
    });
  }, 20_000);

  it("strips partialOrigin from claude's own structured partial", async () => {
    const worktreePath = await createRepo();
    const structured = {
      changedFiles: ["tracked.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "could not run npm test",
      completionStatus: "partial", failureType: "error", failureMessage: "tests could not be run", partialOrigin: "runner",
    };
    const binDir = await createFakeClaude(`process.stdout.write(JSON.stringify({ type: "result", structured_output: ${JSON.stringify(structured)}, usage: { input_tokens: 1, output_tokens: 1 } }));`);
    const outcome = await runExecute(worktreePath, binDir);
    expect(outcome.code).toBe(0);
    const answer = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({ completionStatus: "partial", failureType: "error", failureMessage: "tests could not be run", changedFiles: ["tracked.txt"] });
    expect(Object.prototype.hasOwnProperty.call(answer, "partialOrigin")).toBe(false);
  }, 20_000);
});

describe("the execute prompt names who runs the checks (spec 2026-10-02 §5.2, T12)", () => {
  it("T12: lists the contract's required checks and tells claude not to report partial for a command it cannot run", () => {
    const prompt = buildExecutorPrompt({
      attempt: 1, runDir: ".runs/demo", worktreePath: "/tmp/worktree", state: { status: "executing" },
      plan: { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] },
      contract: {
        objective: { taskId: "task-1", goal: "Fix test", successCondition: "tests pass", nonGoals: [] },
        context: { repoPath: "/repo", targetPaths: ["src"], relevantDocs: [], buildTestCommands: [], constraints: [] },
        executionPolicy: { partialOutcomeRecoveryWindowMs: 1000 },
        verification: { verifierType: "command", requiredChecks: ["npm test", "npm run typecheck"], rejectOn: [], evidenceRequired: [] },
      },
    } as never);
    const lines = prompt.split("\n");
    const header = lines.indexOf("Required checks (run by the verifier in this worktree after you finish):");
    expect(header).toBeGreaterThan(lines.indexOf("Success condition: tests pass"));
    expect(lines.slice(header + 1, header + 4)).toEqual([
      "- npm test",
      "- npm run typecheck",
      "If you cannot run a command (for example it needs approval), do not report partial or error for that reason; deliver your changes and say in stdoutStderrLog which commands you could not run.",
    ]);
  });
});
