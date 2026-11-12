// Task handoffs and live notes through the real control worker (Orca spec 2026-11-12 tester follow-up G §10.2, Part 5),
// with the script-mode fake codex standing in for the agent: the agent's handoff lands in Orca's output directory -- never in
// the result Orca lands -- and listing it in changedFiles does not block the run; a note Orca queued before the run started
// reaches the plan prompt and is acknowledged. Orca's own real-ccloop worlds rely on the fake's `handoff` entry and its
// `<marker>.prompts` log.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import { LIVE_NOTES_FILE } from "../../src/control/liveNotes.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { parseCodexConfig } from "../../src/runtime/codex/protocol.js";
import { codexFixture, exec } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(withNote: boolean) {
  const runtime = await codexFixture("script");
  dirs.push(runtime.dir);
  const handoffRoot = await realpath(await mkdtemp(join(tmpdir(), "handoff-worker-")));
  dirs.push(handoffRoot);
  const inputDir = join(handoffRoot, "in"), outputDir = join(handoffRoot, "out");
  await mkdir(inputDir); await mkdir(outputDir);
  await writeFile(join(inputDir, "README.md"), "no earlier tasks\n");
  const scriptPath = join(runtime.dir, "script.json");
  await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" }, handoff: { "handoff.md": "H", "summary.md": "S" },
    reportedChangedFiles: ["answer.txt", join(outputDir, "handoff.md"), join(outputDir, "summary.md")] } }));
  runtime.config.command.push(scriptPath);
  const sealed = await sealCodex(parseCodexConfig(runtime.config));
  const amount = { tokens: 100_000, activeMs: 60_000, attempts: 1, sessions: 1 };
  runtime.contract.executionPolicy.tokenBudget = 100_000;
  const envelope: LoopStartEnvelope = { protocol: 3, claim: { groupId: "group-1", workItemId: "work-1", taskId: "task-1", runId: "run-1", generation: 1, graphVersion: 1, targetVersion: 1,
    commandId: "command-1", configHash: sealed.configHash, agent: sealed.selection, grant: { work: amount, handoff: amount }, ownerToken: "owner-1" },
    contractHash: "c".repeat(64), inputCheckpoint: null,
    work: { kind: "loop", contract: runtime.contract, targetRepo: runtime.repo, base: "main", sourceDir: runtime.dir, handoff: { inputDir, outputDir } } };
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, { protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null });
  if (withNote) await writeFile(join(runtime.dir, LIVE_NOTES_FILE), JSON.stringify({ schema: "orca-live-notes-v1", notes: [{ id: "n1", text: "prefer tabs", at: "2026-11-12T09:00:00.000Z" }] }), { mode: 0o600 });
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  const result = await runControlCommand(["collect", "--agents", join(runtime.dir, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
  expect(result.code, result.stderr).toBe(0);
  const prompts = (await readFile(`${runtime.marker}.prompts`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { phase: string; prompt: string });
  return { runtime, outputDir, inputDir, collected: JSON.parse(result.stdout), prompts };
}

describe("handoffs and live notes through the worker", () => {
  it("the agent's handoff lands in outputDir, outside the result commit, and the run is not path-blocked", { timeout: 60_000 }, async () => {
    const { runtime, outputDir, inputDir, collected, prompts } = await run(false);
    expect(collected.terminal.status).toBe("succeeded");
    expect(await readFile(join(outputDir, "handoff.md"), "utf8")).toBe("H");
    expect(await readFile(join(outputDir, "summary.md"), "utf8")).toBe("S");
    expect(collected.handoffFiles).toEqual({ handoff: { present: true, bytes: 1 }, summary: { present: true, bytes: 1 } });
    // Every commit of the result repository Orca lands from: the answer is there, the handoff never is.
    const touched = (await exec("git", ["log", "--all", "--name-only", "--format="], { cwd: join(runtime.dir, "repo") })).stdout.split("\n").filter(Boolean);
    expect(touched).toContain("answer.txt");
    expect(touched.some((path) => path.endsWith("handoff.md") || path.endsWith("summary.md"))).toBe(false);
    expect(prompts.map((p) => p.phase)).toEqual(["plan", "execute", "verify"]);
    expect(prompts[0]!.prompt.split("\n")[2]).toContain(`${inputDir}/README.md`);
    expect(Object.keys(collected)).not.toContain("liveNotes");
  });

  it("a note file present at accept is delivered at plan and logged in the plan prompt", { timeout: 60_000 }, async () => {
    const { collected, prompts } = await run(true);
    expect(collected.terminal.status).toBe("succeeded");
    expect(prompts[0]!.prompt).toContain(JSON.stringify("prefer tabs"));
    expect(prompts[1]!.prompt).not.toContain("prefer tabs");
    expect(collected.liveNotes.delivered).toMatchObject([{ id: "n1", phase: "plan", attempt: 1 }]);
  });
});
