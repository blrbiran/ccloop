import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without types
import { buildUsageEvidence } from "../../../scripts/claude-stream.mjs";

// Orca claude stream usage (2026-09-27), spec §3.1 and §5.2 N1, N6, N7, N9, N10: the runner against the CLI-level fake.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const dirs: string[] = [];
const children: number[] = [];
afterEach(async () => {
  for (const pid of children.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function world() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-runner-stream-"))); dirs.push(dir);
  const worktree = join(dir, "worktree"), evidence = join(dir, "evidence");
  await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(worktree), fs.mkdir(evidence)]));
  return { dir, worktree, evidence, marker: join(dir, "marker.json"), observed: join(evidence, "observed-usage.json") };
}

function start(w: Awaited<ReturnType<typeof world>>, mode: string, withPath = true) {
  const env: NodeJS.ProcessEnv = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, fakeCli, mode, w.marker]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
  if (withPath) env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH = w.observed; else delete env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH;
  const child = spawn(process.execPath, [runner], { cwd: w.worktree, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child.pid!);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null }>((resolve) => child.on("close", (code) => resolve({ code })));
  child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: w.dir, worktreePath: w.worktree }));
  return { child, done, out: () => stdout, err: () => stderr };
}

// Controller ruling (2026-09-27, on Task 2's subprocessClaudeAdapter.test.ts blocker): a stand-in `claude` named
// directly by CCLOOP_CLAUDE_COMMAND, standing in for the older SubprocessClaudeAdapter criteria's fixtures that
// print a bare {structured_output, usage} line with no stream-json framing at all.
// *** ERRATUM (consolidation step 1, 2026-10-01, Orca session be653b22, ruling R5) -- SubprocessClaudeAdapter and
// tests/runtime/claude/subprocessClaudeAdapter.test.ts were deleted in consolidation step 1
// (ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md); the fixtures this comment means moved unchanged to
// tests/runtime/claude/claudePhaseRunner.test.ts. ***
function startCommand(w: Awaited<ReturnType<typeof world>>, command: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify(command), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
  delete env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH;
  const child = spawn(process.execPath, [runner], { cwd: w.worktree, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null }>((resolve) => child.on("close", (code) => resolve({ code })));
  child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: w.dir, worktreePath: w.worktree }));
  return { done, out: () => stdout, err: () => stderr };
}

describe("claude phase runner over stream-json (Orca claude stream usage)", () => {
  it("N1: books a completed phase exactly as the json envelope's usage would have been booked", async () => {
    const w = await world();
    const run = start(w, "ok");
    expect((await run.done).code).toBe(0);
    const answer = JSON.parse(run.out());
    const expected = buildUsageEvidence({ usage: { input_tokens: 12, output_tokens: 3 } });
    expect(answer.usageEvidence).toEqual(expected);
    expect(answer.tokenUsage).toBe(15);
  }, 20_000);

  it("N7: hands the claude CLI stream-json, --verbose and --include-partial-messages", async () => {
    const w = await world();
    await start(w, "ok").done;
    const [argv] = (await readFile(`${w.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv!.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema"]);
  }, 20_000);

  it("N6: puts the observation on disk while claude is still running, and it survives a SIGKILL of the group", async () => {
    const w = await world();
    const run = start(w, "usage-then-hang");
    // Orca claude stream usage (2026-09-27), final-review ruling in the round's ledger: wait until the fake's message is closed (openMessage false), not merely until the file exists -- message_start and the tail are separate writes, so an existence wait can abort at the 1103 snapshot. Seventh named rewrite (N6 was already published).
    await expect.poll(async () => {
      if (!existsSync(w.observed)) return false;
      try { return JSON.parse(await readFile(w.observed, "utf8")).openMessage === false; } catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
    expect(run.child.exitCode).toBeNull();
    process.kill(-run.child.pid!, "SIGKILL");
    await run.done;
    expect(JSON.parse(await readFile(w.observed, "utf8"))).toMatchObject({ total: 1109, openMessage: false, lowerBound: true, source: "stream-before-abort" });
  }, 20_000);

  it("N9a: keeps the observed-usage path from claude, and writes nothing into the worktree without one", async () => {
    const w = await world();
    await start(w, "ok").done;
    expect(JSON.parse(await readFile(w.marker, "utf8")).observedUsagePathEnv).toBeNull();
    const bare = await world();
    const run = start(bare, "usage-then-hang", false);
    await expect.poll(async () => (await readFile(`${bare.marker}.argv`, "utf8").catch(() => "")) !== "", { timeout: 10_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.kill(-run.child.pid!, "SIGKILL");
    await run.done;
    expect(await readdir(bare.worktree)).toEqual([]);
    expect(await readdir(bare.evidence)).toEqual([]);
  }, 20_000);

  it("N10: does not fail a phase whose stream runs past 10 MiB", async () => {
    const w = await world();
    const run = start(w, "flood");
    expect((await run.done).code).toBe(0);
    expect(JSON.parse(run.out()).tokenUsage).toBe(15);
  }, 60_000);

  // node's own CLI parsing would otherwise intercept flags after the script (e.g. `-p`, its --print alias), so the
  // stand-in is a script file, as tests/runtime/claude/subprocessClaudeAdapter.test.ts's fixtures already are.
  // *** ERRATUM (consolidation step 1, 2026-10-01, Orca session be653b22, ruling R5) -- that file was deleted in consolidation step 1
  // (ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md); the fixtures it names now live, unchanged, in
  // tests/runtime/claude/claudePhaseRunner.test.ts. ***
  async function standIn(dir: string, ...lines: string[]) {
    const script = join(dir, "stand-in-claude.mjs");
    await writeFile(script, lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`).join("\n"));
    return script;
  }

  it("accepts a bare {structured_output, usage} line from the older SubprocessClaudeAdapter stand-ins, but a type:\"result\" line still wins", async () => {
    const bareOnly = await world();
    const bareScript = await standIn(
      bareOnly.dir,
      JSON.stringify({ structured_output: { summary: "x", primaryTargetPaths: ["a"] }, usage: { input_tokens: 12, output_tokens: 3 } }),
    );
    const bareRun = startCommand(bareOnly, [process.execPath, bareScript]);
    expect((await bareRun.done).code).toBe(0);
    expect(JSON.parse(bareRun.out()).tokenUsage).toBe(15);

    const withResult = await world();
    const resultScript = await standIn(
      withResult.dir,
      JSON.stringify({ structured_output: { summary: "x", primaryTargetPaths: ["a"] }, usage: { input_tokens: 1, output_tokens: 1 } }),
      JSON.stringify({ type: "result", structured_output: { summary: "y", primaryTargetPaths: ["b"] }, usage: { input_tokens: 12, output_tokens: 3 } }),
    );
    const resultRun = startCommand(withResult, [process.execPath, resultScript]);
    expect((await resultRun.done).code).toBe(0);
    expect(JSON.parse(resultRun.out()).tokenUsage).toBe(15);
  }, 20_000);
});
