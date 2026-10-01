import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca retire-legacy-orca-run (2026-10-01), spec §3.4: fake-codex `frames` mode. Stateless: the frame is chosen by
// the `attempt-<n>` working directory ccloop's worktreeManager gives each attempt, so a fresh run starts at frame 1.
// The fake is spawned directly in a plain directory named `attempt-<n>` (the mode reads only the cwd's name).
const fake = fileURLToPath(new URL("../../fixtures/fake-codex.mjs", import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

type Phase = "plan" | "execute" | "verify";
const prompts: Record<Phase, string> = { plan: "Plan one isolated L2 attempt for task codex-test.\n", execute: "Execute one isolated attempt for task codex-test.\n", verify: "Verify task codex-test.\n" };
const schemas: Record<Phase, unknown> = { plan: { properties: {} }, execute: { anyOf: [{}] }, verify: { properties: { approved: {} } } };

async function play(phase: Phase, attempt: number, frames: unknown): Promise<{ code: number | null; stderr: string; answer: any; dir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fake-codex-frames-")));
  roots.push(root);
  const cwd = join(root, "worktrees", `attempt-${attempt}`);
  await mkdir(cwd, { recursive: true });
  const framesPath = join(root, "frames.json"), schemaPath = join(root, "schema.json"), out = join(root, "final.json");
  await writeFile(framesPath, JSON.stringify(frames));
  await writeFile(schemaPath, JSON.stringify(schemas[phase]));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fake, "frames", join(root, "marker.json"), framesPath, "exec", "-o", out, "--output-schema", schemaPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", async (code) => resolve({ code, stderr, answer: await readFile(out, "utf8").then(JSON.parse, () => undefined), dir: root }));
    child.stdin.end(prompts[phase]);
  });
}

describe("fake codex frames mode (spec §3.4)", () => {
  const frames = { "codex-test": [{ changedFiles: ["a.txt"], approved: true }, { changedFiles: ["b.txt"], approved: false, safeToRetry: true, stopSignals: ["s"] }] };

  it("plays frame n on attempt n", async () => {
    const execute = await play("execute", 2, frames);
    expect(execute.code).toBe(0);
    expect(execute.answer).toEqual({ changedFiles: ["b.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" });
    const verify = await play("verify", 2, frames);
    expect(verify.answer).toMatchObject({ approved: false, safeToRetry: true, stopSignals: ["s"] });
    const first = await play("execute", 1, frames);
    expect(first.answer.changedFiles).toEqual(["a.txt"]);
  });

  it("falls back to the * list and defaults the missing fields", async () => {
    const execute = await play("execute", 1, { "*": [{}] });
    expect(execute.answer.changedFiles).toEqual([]);
    const verify = await play("verify", 1, { "*": [{}] });
    expect(verify.answer).toMatchObject({ approved: true, safeToRetry: false, stopSignals: [] });
    expect((await play("plan", 1, { "*": [{}] })).answer).toEqual({ summary: "frames", primaryTargetPaths: [] });
  });

  it("refuses an attempt with no frame, by name, without a final answer", async () => {
    const result = await play("execute", 2, { "codex-test": [{}] });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("no frame for codex-test attempt 2");
    expect(result.answer).toBeUndefined();
  });
});
