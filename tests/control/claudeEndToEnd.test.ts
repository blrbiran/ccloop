import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopContract } from "../../src/contract/schema.js";
import { canonicalHash, type StartEnvelopeV2 } from "../../src/control/protocol.js";
import { FAKE_CLAUDE_CLI, claudeInstallation, writeAgentsTable } from "./agentsFixture.js";

// Agent selection (2026-09-26), spec §4.6, §4.7, §4.7b: the claimed selection travels envelope -> accept -> sealed
// config -> worker -> the claude descriptor's adapter -> the claude CLI's argv, and a claude run still earns a stop
// proof (its process groups were registered). Additive.
const binary = resolve("dist/cli.js");
const roots: string[] = [];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function commandRaw(executable: string, args: string[], input?: string, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("error", reject);
    child.on("exit", (code) => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("control through the built CLI with a claude installation (agent selection)", { timeout: 120_000 }, () => {
  it("carries the claimed selection to the claude CLI's argv and still proves the run stopped", async () => {
    await chmod(binary, 0o755);
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-claude-e2e-")));
    roots.push(root);
    const repo = join(root, "target"), sourceDir = join(root, "source"), marker = join(root, "claude-marker"), script = join(root, "script.json");
    await mkdir(repo, { mode: 0o700 });
    await mkdir(sourceDir, { mode: 0o700 });
    await mkdir(join(sourceDir, "input"), { mode: 0o700 });
    for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) await commandRaw("git", args, undefined, repo);
    await writeFile(join(repo, "answer.txt"), "0\n");
    await writeFile(join(repo, "check.cjs"), 'if(require("fs").readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);\n');
    await commandRaw("git", ["add", "."], undefined, repo);
    await commandRaw("git", ["commit", "-qm", "base"], undefined, repo);
    await writeFile(script, JSON.stringify({ "task-1": { files: { "answer.txt": "42\n" } } }), { mode: 0o600 });
    const { path } = await writeAgentsTable({
      claude: await claudeInstallation([process.execPath, FAKE_CLAUDE_CLI, "script", marker, script], { timeoutMs: 10_000, killGraceMs: 50 }),
    }, root);
    const call = (method: string, payload: unknown) => commandRaw(binary, ["control", method, "--agents", path], JSON.stringify(payload));

    const probed = await call("capabilities", { agent: { agent: "claude", contextWindow: 1_000_000 } });
    expect(probed.code, probed.stderr).toBe(0);
    const resolution = JSON.parse(probed.stdout);
    expect(resolution.selection).toEqual({ agent: "claude", model: "claude-opus-5-5", contextWindow: 1_000_000 });
    expect(resolution.capabilities.contextWindowTokens).toBe(1_000_000);

    const check = `${process.execPath} check.cjs`;
    const contract: LoopContract = {
      objective: { taskId: "task-1", goal: "Set answer.txt to 42", successCondition: "answer is 42", nonGoals: [] },
      context: { repoPath: repo, targetPaths: ["answer.txt"], relevantDocs: [], buildTestCommands: [check], constraints: [] },
      executionPolicy: { autonomyLevel: "L2", maxAttempts: 1, perAttemptTimeoutMs: 10_000, totalRuntimeBudgetMs: 30_000, tokenBudget: 1_000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 100 },
      safetyPolicy: { allowlistPaths: ["answer.txt"], denylistPaths: [], maxFilesTouched: 2, humanGateConditions: [] },
      verification: { verifierType: "agent", requiredChecks: [check], rejectOn: ["failure"], evidenceRequired: [] },
      escalationAndExit: { escalationTargets: [], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
    };
    const grant = { tokens: 2_000, activeMs: 120_000, attempts: 6, sessions: 3 };
    const envelope: StartEnvelopeV2 = {
      protocol: 2,
      claim: {
        groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 2, targetVersion: 1,
        commandId: "command-1", configHash: resolution.configHash, agent: resolution.selection,
        grant: { work: grant, handoff: { tokens: 200, activeMs: 30_000, attempts: 1, sessions: 1 } }, ownerToken: "owner-1",
      },
      contractHash: canonicalHash(contract),
      inputCheckpoint: null,
      work: { contract, targetRepo: repo, base: "HEAD", sourceDir },
    };
    const accepted = await call("accept", envelope);
    expect(accepted.code, accepted.stderr).toBe(0);

    let done: any = null;
    for (let i = 0; i < 200 && done === null; i++) {
      const result = await call("collect", { input: envelope, afterSeq: 0 });
      expect(result.code, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      if (value.candidate?.stopProof && value.terminal) done = value;
      else await sleep(50);
    }
    expect(done, "collection timeout").not.toBeNull();
    expect(done.terminal.status).toBe("succeeded");
    expect(done.candidate.stopProof.isolated).toBe(true);
    expect(await readFile(join(sourceDir, "repo", "answer.txt"), "utf8")).toBe("42\n");
    expect((await readFile(`${marker}.calls`, "utf8")).trim().split("\n")).toEqual(["plan", "execute", "verify"]);
    // Plan rulings P23 m3: the fake answers `--version` (accept's drift probe) without logging it, so `.argv` holds
    // exactly the three phase calls; nothing is filtered out before counting.
    const phaseArgv = (await readFile(`${marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(phaseArgv).toHaveLength(3);
    for (const argv of phaseArgv) expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5-5[1m]");
  });
});
