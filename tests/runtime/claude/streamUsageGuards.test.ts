import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
import { codexFixture } from "../codex/fixture.js";

// Orca backlog #6 (2026-09-29; ccloop handoff "挂着的", Orca spec 2026-09-27-claude-stream-usage-design.md §8 item 4):
// four spots of the stream-usage round that no criterion turned red when deleted. One criterion each; the ledger names
// the deletion each one must be seen red under.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function world() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-guards-"))); dirs.push(dir);
  const worktree = join(dir, "worktree"), evidence = join(dir, "evidence");
  await mkdir(worktree); await mkdir(evidence);
  return { dir, worktree, evidence, observed: join(evidence, "observed-usage.json") };
}

const line = (event: unknown): Buffer => Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
const result = (summary: string): Buffer => line({ type: "result", structured_output: { summary, primaryTargetPaths: ["a"] }, usage: { input_tokens: 12, output_tokens: 3 } });
const messageStart = (id: string, usage: Record<string, number>): Buffer =>
  line({ type: "stream_event", event: { type: "message_start", message: { id, usage } }, parent_tool_use_id: null });

/** A stand-in `claude` (a script file, so node does not read claude's flags as its own) writing each piece to stdout 200 ms apart. */
async function standIn(dir: string, pieces: Buffer[]): Promise<string> {
  const script = join(dir, "stand-in-claude.mjs");
  await writeFile(script, [
    `const pieces = ${JSON.stringify(pieces.map((piece) => piece.toString("base64")))};`,
    "for (const piece of pieces) {",
    "  await new Promise((resolve) => process.stdout.write(Buffer.from(piece, 'base64'), resolve));",
    "  await new Promise((resolve) => setTimeout(resolve, 200));",
    "}",
  ].join("\n"));
  return script;
}

async function runRunner(w: Awaited<ReturnType<typeof world>>, script: string, observedPath: string | null) {
  const env: NodeJS.ProcessEnv = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, script]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
  if (observedPath === null) delete env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH; else env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH = observedPath;
  const child = spawn(process.execPath, [runner], { cwd: w.worktree, env, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = [];
  child.stdout.on("data", (bytes: Buffer) => out.push(bytes));
  child.stderr.on("data", (bytes: Buffer) => err.push(bytes));
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: w.dir, worktreePath: w.worktree }));
  });
  return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

describe("stream-usage guards that nothing pinned (Orca backlog #6)", () => {
  // Deletion M3-1: `child.stdout.setEncoding("utf8")` in the runner. Without it every chunk is a Buffer and the line
  // splitter concatenates each one into a string on its own, so the cut character becomes U+FFFD in the answer.
  it("decodes claude's stdout as a stream: a character cut across two chunks reaches the answer whole", async () => {
    const w = await world();
    const summary = "寿司を一皿";
    const bytes = result(summary);
    const cut = bytes.indexOf(Buffer.from("寿", "utf8")) + 1;
    const out = await runRunner(w, await standIn(w.dir, [bytes.subarray(0, cut), bytes.subarray(cut)]), null);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).summary).toBe(summary);
  }, 20_000);

  // Deletion M3-2: the catch around writeObservation. Controller ruling (backlog #6): the observation is best-effort
  // evidence of a lower bound, so a path it cannot be written to must not cost a phase claude completed; the failure is
  // said on stderr. Without the catch, the throw inside the stdout handler is uncaught and would end the runner
  // (predicted; mutation M3-2 in the round's ledger is what measures it).
  it("keeps a phase claude completed when its observation cannot be written, and says so on stderr", async () => {
    const w = await world();
    const script = await standIn(w.dir, [Buffer.concat([messageStart("m1", { input_tokens: 2, output_tokens: 1 }), result("fine")])]);
    const out = await runRunner(w, script, join(w.dir, "no-such-directory", "observed-usage.json"));
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ summary: "fine", tokenUsage: 15 });
    expect(out.stderr).toContain("claude-runner: observation not written");
  }, 20_000);

  // Deletion M3-3: the `snapshot.total !== null` guard. Spec §4: a total that is not a positive safe integer is not an
  // observation and is not written. The second run is this criterion's non-vacuity: the same stream shape with a
  // counted usage does write the file, so the first run's empty directory is the guard's doing, not a stream the
  // observer never recognised.
  it("writes no observation until something has been counted", async () => {
    const zero = await world();
    const zeroRun = await runRunner(zero, await standIn(zero.dir, [Buffer.concat([messageStart("m0", { input_tokens: 0, output_tokens: 0 }), result("zero")])]), zero.observed);
    expect(zeroRun.code).toBe(0);
    expect(JSON.parse(zeroRun.stdout).summary).toBe("zero");
    expect(existsSync(zero.observed)).toBe(false);
    expect(await readdir(zero.evidence)).toEqual([]);

    const counted = await world();
    const countedRun = await runRunner(counted, await standIn(counted.dir, [Buffer.concat([messageStart("m1", { input_tokens: 2, output_tokens: 1 }), result("counted")])]), counted.observed);
    expect(countedRun.code).toBe(0);
    expect(JSON.parse(await readFile(counted.observed, "utf8"))).toMatchObject({ schema: "ccloop-claude-observed-usage-v1", total: 3 });
  }, 20_000);

  // Deletion M3-4: `observedUsagePath` in the adapter's outcome.json. Spec §3.2(1): the call's evidence says where its
  // observation is, so a reader of the evidence directory can find the number the adapter booked.
  it("names in outcome.json the observation file the runner wrote for the same call", async () => {
    const f = await codexFixture("unused");
    dirs.push(f.dir);
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1",
      kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeCli, "ok", join(f.dir, "claude-marker.json")], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
    };
    await new ClaudeAgentAdapter(config).plan(f.context);
    const root = join(f.context.runDir, "claude", "1", "plan");
    const [call] = await readdir(root);
    const dir = join(root, call!);
    const outcome = JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) as { observedUsagePath?: unknown };
    expect(outcome.observedUsagePath).toBe(join(dir, "observed-usage.json"));
    // The fake's closed message: 2 + 100 + 1000 + 7 (tests/fixtures/fake-claude-cli.mjs DELTA_USAGE).
    expect(JSON.parse(await readFile(outcome.observedUsagePath as string, "utf8"))).toMatchObject({ schema: "ccloop-claude-observed-usage-v1", total: 1109 });
  }, 20_000);
});
