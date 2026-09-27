import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca paid claude round (2026-09-27), human ruling on its findings ("B1–B3 按你推荐"): ccloop counted only
// input_tokens + output_tokens, 1,329 tokens for a task in which claude processed about 145,000 once its cache was
// counted, so the token budget barely bound real claude. Codex's input_tokens already includes its cached input; claude's
// leaves it out. These criteria read the total the runner reports for a claude envelope.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function planWith(usage: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-phase-usage-")));
  dirs.push(dir);
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, `process.stdout.write(${JSON.stringify(JSON.stringify({
    type: "result", subtype: "success", is_error: false, structured_output: { summary: "s", primaryTargetPaths: ["a.txt"] }, usage,
  }))});`);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, probe]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
    const child = spawn(process.execPath, [runner], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Run the plan phase for task t.", attempt: 1, runDir: dir, worktreePath: dir, partialOutcomeRecoveryWindowMs: 100 }));
  });
}

describe("the tokens the claude phase runner counts (Orca paid claude round)", { timeout: 30_000 }, () => {
  it("counts the prompt claude wrote to and read from its cache, as the paid round's plan call reported it", async () => {
    // The paid round's plan call (evidence/live-claude-2-raw-001.json in Orca): 2 in, 211 out, 3,699 written to the
    // cache, 16,055 read from it.
    const result = await planWith({ input_tokens: 2, output_tokens: 211, cache_creation_input_tokens: 3_699, cache_read_input_tokens: 16_055, service_tier: "DO_NOT_PERSIST" });
    expect(result.code, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.tokenUsage).toBe(19_967);
    expect(answer.usageEvidence.normalizedTotal).toBe(19_967);
    expect(answer.usageEvidence.cacheFields).toEqual({
      cache_creation_input_tokens: { status: "finite", value: 3_699 },
      cache_read_input_tokens: { status: "finite", value: 16_055 },
    });
    expect(result.stdout).not.toContain("DO_NOT_PERSIST");
  });

  it("records the cache counts as absent and counts input and output alone when the envelope has none", async () => {
    const answer = JSON.parse((await planWith({ input_tokens: 100, output_tokens: 25 })).stdout);
    expect(answer.tokenUsage).toBe(125);
    expect(answer.usageEvidence.cacheFields).toEqual({ cache_creation_input_tokens: { status: "absent" }, cache_read_input_tokens: { status: "absent" } });
  });

  it("does not count a cache field that is not a finite number", async () => {
    const answer = JSON.parse((await planWith({ input_tokens: 100, output_tokens: 25, cache_creation_input_tokens: "77", cache_read_input_tokens: 50 })).stdout);
    expect(answer.tokenUsage).toBe(175);
    expect(answer.usageEvidence.cacheFields.cache_creation_input_tokens).toEqual({ status: "invalid_type" });
  });
});
