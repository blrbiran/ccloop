import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca agent selection (2026-09-26), spec §4.8: the CLI-layer fake claude. Orca's ccloopWorld reads
// `.calls` and `.tasks` with the readers it already uses for fake codex, so both formats are pinned here
// to fake codex's exactly; `.argv` is how the E2E sees a selection reach the CLI.
const fake = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const CONTINUATION = "Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
// The fixture tells phases apart by the --json-schema the phase runner passes (scripts/claude-phase-runner.mjs).
const schemas = {
  plan: { type: "object", properties: { summary: {}, primaryTargetPaths: {} } },
  execute: { oneOf: [{}, {}] },
  verify: { type: "object", properties: { approved: {} } },
} as const;
const prompts = {
  plan: (task: string) => `Return JSON only.\nPlan one isolated L2 attempt for task ${task}.\nGoal: x`,
  execute: (task: string) => `Return JSON only.\nExecute one isolated attempt for task ${task}.\nGoal: x`,
  verify: (task: string) => `Return JSON only.\nVerify task ${task}.\nGoal: x`,
} as const;
type Phase = keyof typeof schemas;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function workdir(): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "fake-claude-cli-")));
  roots.push(cwd);
  return cwd;
}

function launch(cwd: string, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fake, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt }));
  });
}

const claudeArgs = (phase: Phase, prompt: string, model?: string) =>
  ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schemas[phase]), ...(model === undefined ? [] : ["--model", model]), prompt];

async function scripted(cwd: string, phase: Phase, prompt: string, script: Record<string, unknown>) {
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify(script));
  return launch(cwd, ["script", join(cwd, "marker.json"), scriptPath, ...claudeArgs(phase, prompt, "claude-opus-5-5")]);
}

describe("fake claude CLI (Orca agent selection, spec §4.8)", () => {
  it("answers --version and writes nothing", async () => {
    const cwd = await workdir();
    const result = await launch(cwd, ["script", join(cwd, "marker.json"), join(cwd, "script.json"), "--version"]);
    expect(result).toMatchObject({ code: 0, stdout: "9.9.9-fake\n" });
    for (const suffix of ["", ".argv", ".calls", ".tasks"]) expect(existsSync(join(cwd, `marker.json${suffix}`))).toBe(false);
  });

  it("prints the claude json envelope with structured_output and usage for each phase", async () => {
    const cwd = await workdir();
    for (const phase of ["plan", "execute", "verify"] as const) {
      const result = await launch(cwd, ["ok", join(cwd, "marker.json"), ...claudeArgs(phase, prompts[phase]("a"))]);
      expect(result.code).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
      expect(Object.keys(envelope.structured_output)).toContain({ plan: "summary", execute: "changedFiles", verify: "approved" }[phase]);
    }
    expect(await readFile(join(cwd, "marker.json.calls"), "utf8")).toBe("plan\nexecute\nverify\n");
  });

  it("appends one JSON argv line per call and keeps fake codex's .calls and .tasks formats", async () => {
    const cwd = await workdir();
    const script = { a: { files: { "a.txt": "A\n" } } };
    for (const phase of ["plan", "execute", "verify"] as const) expect((await scripted(cwd, phase, prompts[phase]("a"), script)).code).toBe(0);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(cwd, "marker.json.calls"), "utf8")).toBe("plan\nexecute\nverify\n");
    expect(await readFile(join(cwd, "marker.json.tasks"), "utf8")).toBe("plan a\nexecute a\nverify a\n");
    const argv = (await readFile(join(cwd, "marker.json.argv"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(argv).toEqual([claudeArgs("plan", prompts.plan("a"), "claude-opus-5-5"), claudeArgs("execute", prompts.execute("a"), "claude-opus-5-5"), claudeArgs("verify", prompts.verify("a"), "claude-opus-5-5")]);
  });

  it("uses the <task>#continuation entry when the prompt carries ccloop's continuation constraint", async () => {
    const cwd = await workdir();
    const script = { a: { files: { "a.txt": "first\n" } }, "a#continuation": { files: { "a.txt": "continued\n" } } };
    expect((await scripted(cwd, "execute", `${prompts.execute("a")}\n${CONTINUATION}`, script)).code).toBe(0);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("continued\n");
    expect(await readFile(join(cwd, "marker.json.tasks"), "utf8")).toBe("execute a#continuation\n");
  });

  it("sleeps delayMs for the named phase before answering", async () => {
    const cwd = await workdir();
    const result = await scripted(cwd, "plan", prompts.plan("a"), { a: { files: {}, delayMs: { plan: 600 } } });
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(600);
    expect(JSON.parse(result.stdout).structured_output.summary).toBe("fixture");
  });

  it("refuses by name, writes no file and prints no answer when the script has no execute entry for the task", async () => {
    const cwd = await workdir();
    const result = await scripted(cwd, "execute", prompts.execute("c"), { a: { files: { "a.txt": "A\n" } } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("fake-claude-cli script has no entry for task c");
    expect(result.stdout).toBe("");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(await readFile(join(cwd, "marker.json.tasks"), "utf8")).toBe("execute -\n");
  });

  it("rejects an argument the phase runner never passes, so runner drift is loud", async () => {
    const cwd = await workdir();
    const result = await launch(cwd, ["ok", join(cwd, "marker.json"), "-p", "--output-format", "json", "--json-schema", "{}", "--verbose", "x"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("fake-claude-cli: unknown argument --verbose");
  });
});
