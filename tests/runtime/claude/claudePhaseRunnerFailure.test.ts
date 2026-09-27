import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca paid claude round (2026-09-27): the first execute call was refused by the API with a 400, which claude reports
// in its `-p --output-format json` envelope on stdout. The runner built its failure from stderr alone, so ccloop's
// evidence kept only a stdin warning and the cause was found in a tee outside ccloop. These criteria read what the
// runner reports when claude exits non-zero.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A stand-in claude that writes `stdout` and `stderr` and exits 1, the shape of an API error under `-p`. */
async function failingClaude(stdout: string, stderr: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-phase-failure-")));
  dirs.push(dir);
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, [
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.stdout.write(${JSON.stringify(stdout)}, () => process.exit(1));`,
  ].join("\n"));
  return { dir, probe };
}

function runPlan(w: { dir: string; probe: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, w.probe]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
    const child = spawn(process.execPath, [runner], { cwd: w.dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Run the plan phase for task t.", attempt: 1, runDir: w.dir, worktreePath: w.dir, partialOutcomeRecoveryWindowMs: 100 }));
  });
}

describe("what the claude phase runner reports when claude exits non-zero (Orca paid claude round)", { timeout: 30_000 }, () => {
  it("keeps claude's stdout, where -p puts the API error, beside its stderr and exit code", async () => {
    const envelope = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 400 tools.7.custom.input_schema.type: Field required" });
    const w = await failingClaude(envelope, "Warning: no stdin data received in 3s, proceeding without it.");
    const result = await runPlan(w);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("claude exited with code 1");
    expect(result.stderr).toContain("Warning: no stdin data received in 3s");
    expect(result.stderr).toContain("API Error: 400 tools.7.custom.input_schema.type: Field required");
  });

  it("keeps only the end of a long stdout, and says how much it dropped", async () => {
    const head = "HEAD-OF-A-LONG-ANSWER";
    const end = "END-OF-A-LONG-ANSWER";
    const w = await failingClaude(`${head}${"x".repeat(20_000)}${end}`, "");
    const result = await runPlan(w);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(end);
    expect(result.stderr).not.toContain(head);
    expect(result.stderr).toContain(`[${head.length + 20_000 + end.length - 8192} earlier characters dropped]`);
    expect(result.stderr.length).toBeLessThan(8192 + 200);
  });
});
