import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca handoff delivery (2026-09-25), ccloop change C5 and spec §13.2 I-7: fake codex script entries may
// delay a named phase before it writes anything, and a `<task>#continuation` entry is chosen when the
// prompt carries ccloop's continuation constraint. Additive only (ccloop Rule 15): the existing script
// criteria in fakeCodexScript.test.ts and every other mode's criteria are untouched.
const fake = fileURLToPath(new URL("../../fixtures/fake-codex.mjs", import.meta.url));
const materializeSource = fileURLToPath(new URL("../../../src/control/materialize.ts", import.meta.url));
const CONTINUATION = "Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

// The fixture tells phases apart by the output schema, exactly as ccloop's phase schemas differ.
const schemas = {
  plan: { type: "object", properties: { summary: {}, primaryTargetPaths: {} } },
  execute: { anyOf: [{}] },
  verify: { type: "object", properties: { approved: {} } },
} as const;
const prompts = {
  plan: (task: string) => `Return JSON only.\nPlan one isolated L2 attempt for task ${task}.\nGoal: x\n`,
  execute: (task: string) => `Return JSON only.\nExecute one isolated attempt for task ${task}.\nGoal: x\n`,
  verify: (task: string) => `Return JSON only.\nVerify task ${task}.\nGoal: x\n`,
} as const;
type Phase = keyof typeof schemas;

interface Launched { child: ChildProcess; cwd: string; startedAt: number; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number }> }

async function launch(phase: Phase, prompt: string, script: Record<string, unknown>): Promise<Launched> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "fake-codex-delay-")));
  roots.push(cwd);
  const scriptPath = join(cwd, "script.json"), schemaPath = join(cwd, "schema.json");
  await writeFile(scriptPath, JSON.stringify(script));
  await writeFile(schemaPath, JSON.stringify(schemas[phase]));
  const startedAt = Date.now();
  const child = spawn(process.execPath, [fake, "script", join(cwd, "marker.json"), scriptPath, "exec", "-o", join(cwd, "final.json"), "--output-schema", schemaPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt }));
  });
  child.stdin!.end(prompt);
  return { child, cwd, startedAt, done };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe("fake codex script delay and continuation entries (Orca handoff delivery C5, I-7)", () => {
  it("keeps its continuation marker text identical to the constraint ccloop adds to a continuation contract", async () => {
    // If ccloop's constant drifts, the #continuation lookup would silently never match again.
    expect(await readFile(materializeSource, "utf8")).toContain(`const CONTINUATION_CONSTRAINT="${CONTINUATION}";`);
  });

  it("sleeps delayMs for the named phase of every phase kind before answering, and only for that phase", { timeout: 20_000 }, async () => {
    for (const phase of ["plan", "execute", "verify"] as const) {
      const launched = await launch(phase, prompts[phase]("a"), { a: { files: { "a.txt": "A\n" }, delayMs: { [phase]: 600 } } });
      const result = await launched.done;
      expect(result.code).toBe(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(600);
      expect(await exists(join(launched.cwd, "final.json"))).toBe(true);
      expect(result.stdout).toContain('"turn.completed"');
    }
    // A delay named for another phase does not slow this one down.
    const other = await launch("execute", prompts.execute("a"), { a: { files: { "a.txt": "A\n" }, delayMs: { plan: 20_000, verify: 20_000 } } });
    const quick = await other.done;
    expect(quick.code).toBe(0);
    expect(quick.elapsedMs).toBeLessThan(15_000);
    expect(await readFile(join(other.cwd, "a.txt"), "utf8")).toBe("A\n");
  });

  it("writes no script file, no final answer and no events when killed during the delay", { timeout: 15_000 }, async () => {
    const launched = await launch("execute", prompts.execute("a"), { a: { files: { "a.txt": "A\n" }, delayMs: { execute: 10_000 } } });
    // The call is recorded before the delay starts: that is the moment the phase is "entered".
    await expect.poll(async () => exists(join(launched.cwd, "marker.json.calls")), { timeout: 5_000 }).toBe(true);
    launched.child.kill("SIGTERM");
    const result = await launched.done;
    expect(result.signal).toBe("SIGTERM");
    expect(result.elapsedMs).toBeLessThan(10_000);
    expect(await exists(join(launched.cwd, "a.txt"))).toBe(false);
    expect(await exists(join(launched.cwd, "final.json"))).toBe(false);
    expect(result.stdout).toBe("");
    expect(await readFile(join(launched.cwd, "marker.json.calls"), "utf8")).toBe("execute\n");
  });

  it("chooses the #continuation entry only when the prompt carries the continuation constraint", { timeout: 15_000 }, async () => {
    const script = { a: { files: { "a.txt": "first\n" } }, "a#continuation": { files: { "a.txt": "continued\n" } } };
    const continued = await launch("execute", `${prompts.execute("a")}Constraints:\n- ${CONTINUATION}\n`, script);
    expect((await continued.done).code).toBe(0);
    expect(await readFile(join(continued.cwd, "a.txt"), "utf8")).toBe("continued\n");
    const first = await launch("execute", prompts.execute("a"), script);
    expect((await first.done).code).toBe(0);
    expect(await readFile(join(first.cwd, "a.txt"), "utf8")).toBe("first\n");
    // Which entry answered is recorded per call in `<marker>.tasks`; `.calls` keeps its phase-only format.
    expect(await readFile(join(continued.cwd, "marker.json.tasks"), "utf8")).toBe("execute a#continuation\n");
    expect(await readFile(join(first.cwd, "marker.json.tasks"), "utf8")).toBe("execute a\n");
    expect(await readFile(join(continued.cwd, "marker.json.calls"), "utf8")).toBe("execute\n");
    // The continuation entry's delay applies only to the continuation call.
    const delayed = { a: { files: { "a.txt": "first\n" } }, "a#continuation": { files: { "a.txt": "continued\n" }, delayMs: { plan: 3_000 } } };
    const plain = await launch("plan", prompts.plan("a"), delayed);
    expect((await plain.done).elapsedMs).toBeLessThan(3_000);
    const resumed = await launch("plan", `${prompts.plan("a")}Constraints:\n- ${CONTINUATION}\n`, delayed);
    expect((await resumed.done).elapsedMs).toBeGreaterThanOrEqual(3_000);
  });

  it("falls back to the plain entry without a #continuation entry, and still refuses an execute with neither", async () => {
    const fallback = await launch("execute", `${prompts.execute("a")}Constraints:\n- ${CONTINUATION}\n`, { a: { files: { "a.txt": "plain\n" } } });
    expect((await fallback.done).code).toBe(0);
    expect(await readFile(join(fallback.cwd, "a.txt"), "utf8")).toBe("plain\n");
    const refused = await launch("execute", `${prompts.execute("c")}Constraints:\n- ${CONTINUATION}\n`, { a: { files: { "a.txt": "plain\n" } } });
    const result = await refused.done;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("fake-codex script has no entry for task c");
    expect(await readFile(join(refused.cwd, "marker.json.tasks"), "utf8")).toBe("execute -\n");
    expect(await exists(join(refused.cwd, "final.json"))).toBe(false);
    // Plan and verify without an entry answer as before (only execute needs one).
    const plan = await launch("plan", prompts.plan("c"), { a: { files: { "a.txt": "plain\n" } } });
    expect((await plan.done).code).toBe(0);
    expect(await exists(join(plan.cwd, "final.json"))).toBe(true);
  });
});
