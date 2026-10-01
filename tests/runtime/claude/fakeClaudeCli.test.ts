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
// Orca claude stream usage (2026-09-27, spec §5.1): alias so the stream-json tests below read as the brief specifies.
const fakeCli = fake;
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
    // Rewritten for Orca claude stream usage (2026-09-27, spec §5.3 correction, controller ruling under the human's
    // "有问题先按你的建议执行"): the runner now passes --verbose, so the never-passed example is --continue.
    const result = await launch(cwd, ["ok", join(cwd, "marker.json"), "-p", "--output-format", "json", "--json-schema", "{}", "--continue", "x"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("fake-claude-cli: unknown argument --continue");
  });

  // Orca claude stream usage (2026-09-27, spec §5.1): the runner now asks for stream-json; the fake answers in
  // claude 2.1.283's measured event order (spec §2.2) with fixed usage the runner and adapter criteria assert.
  const streamArgs = (phase: Phase, prompt: string) =>
    ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(schemas[phase]), prompt];
  const lines = (stdout: string) => stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

  it("answers stream-json in claude's event order, closing each message with its final usage", async () => {
    const cwd = await workdir();
    const result = await launch(cwd, ["ok", join(cwd, "marker.json"), ...streamArgs("plan", prompts.plan("a"))]);
    expect(result.code).toBe(0);
    const events = lines(result.stdout);
    expect(events.map((e) => e.type === "stream_event" ? `stream:${e.event.type}` : e.type)).toEqual(
      ["system", "stream:message_start", "assistant", "stream:message_delta", "stream:message_stop", "result"]);
    expect(events[1].event.message.usage).toEqual({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 });
    expect(events[3].event.usage).toEqual({ input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 });
    expect(events[5]).toMatchObject({ type: "result", usage: { input_tokens: 12, output_tokens: 3 } });
    expect(Object.keys(events[5].structured_output)).toContain("summary");
  });

  it("stops after one closed message in usage-then-hang and after message_start in start-then-hang", async () => {
    for (const [mode, last] of [["usage-then-hang", "stream:message_stop"], ["start-then-hang", "stream:message_start"]] as const) {
      const cwd = await workdir();
      const child = spawn(process.execPath, [fakeCli, mode, join(cwd, "marker.json"), ...streamArgs("plan", prompts.plan("a"))], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      await expect.poll(() => stdout.includes(last === "stream:message_stop" ? '"message_stop"' : '"message_start"'), { timeout: 5000 }).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.kill("SIGKILL");
      const kinds = lines(stdout).map((e) => e.type === "stream_event" ? `stream:${e.event.type}` : e.type);
      expect(kinds.at(-1)).toBe(last);
      expect(kinds).not.toContain("result");
    }
  });

  it("floods more than 10 MiB of deltas before its result in flood mode", async () => {
    const cwd = await workdir();
    const result = await launch(cwd, ["flood", join(cwd, "marker.json"), ...streamArgs("plan", prompts.plan("a"))]);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(10 * 1024 * 1024);
    expect(lines(result.stdout).at(-1)).toMatchObject({ type: "result", usage: { input_tokens: 12, output_tokens: 3 } });
    // Fix round 1 of Task 1 (Orca claude stream usage, 2026-09-27, spec §5.1 / §2.2's order): flood must open
    // exactly one message (message_start once), with the delta burst inside it, not a second message_start.
    const events = lines(result.stdout);
    const messageStarts = events.filter((e) => e.type === "stream_event" && e.event.type === "message_start");
    expect(messageStarts).toHaveLength(1);
  });

  it("reports one closed message before a scripted delay when usageBeforeDelay is set", async () => {
    const cwd = await workdir();
    const scriptPath = join(cwd, "script.json");
    await writeFile(scriptPath, JSON.stringify({ a: { files: { "a.txt": "A\n" }, delayMs: { execute: 30_000 }, usageBeforeDelay: true } }));
    const child = spawn(process.execPath, [fakeCli, "script", join(cwd, "marker.json"), scriptPath, ...streamArgs("execute", prompts.execute("a"))], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    await expect.poll(() => stdout.includes('"message_delta"'), { timeout: 5000 }).toBe(true);
    child.kill("SIGKILL");
    expect(stdout).not.toContain('"result"');
  });

  it("records whether the observed-usage path reached it", async () => {
    const cwd = await workdir();
    await launch(cwd, ["ok", join(cwd, "marker.json"), ...streamArgs("plan", prompts.plan("a"))]);
    expect(JSON.parse(await readFile(join(cwd, "marker.json"), "utf8")).observedUsagePathEnv).toBeNull();
  });

  // Orca single-call estimate (2026-09-27), spec §5.4: the runner calls claude once with the caller's schema, every tool
  // off (`--tools ""`) and CLAUDE_CODE_MAX_OUTPUT_TOKENS set. The fake tells such a call apart by `--tools ""` alone,
  // answers it from its script's "single-call" entry, and records the output cap it was handed.
  const answerSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const singleCallArgs = (withTools = true) =>
    ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(answerSchema), ...(withTools ? ["--tools", ""] : []), "Estimate this."];
  const withoutCap = () => { const env = { ...process.env }; delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS; return env; };
  function launchEnv(cwd: string, argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fake, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });
  }
  async function singleCallScript(cwd: string, entry: unknown): Promise<string> {
    const scriptPath = join(cwd, "script.json");
    await writeFile(scriptPath, JSON.stringify({ "single-call": entry }));
    return scriptPath;
  }

  it("F1: answers a single call from the script's single-call entry and records the output cap it was given", async () => {
    const cwd = await workdir();
    const scriptPath = await singleCallScript(cwd, { output: { answer: "forty-two" } });
    const result = await launchEnv(cwd, ["script", join(cwd, "marker.json"), scriptPath, ...singleCallArgs()], { ...withoutCap(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: "321" });
    expect(result.code).toBe(0);
    expect(lines(result.stdout).at(-1)).toEqual({ type: "result", subtype: "success", is_error: false, structured_output: { answer: "forty-two" }, usage: { input_tokens: 12, output_tokens: 3 } });
    expect(await readFile(join(cwd, "marker.json.calls"), "utf8")).toBe("single-call\n");
    expect(await readFile(join(cwd, "marker.json.tasks"), "utf8")).toBe("single-call single-call\n");
    const marker = JSON.parse(await readFile(join(cwd, "marker.json"), "utf8"));
    expect(marker.maxOutputTokensEnv).toBe("321");
    expect(marker.args).toEqual(singleCallArgs());
  });

  it("F2: leaves structured_output out of the result when the entry's output is null", async () => {
    const cwd = await workdir();
    const scriptPath = await singleCallScript(cwd, { output: null });
    const result = await launchEnv(cwd, ["script", join(cwd, "marker.json"), scriptPath, ...singleCallArgs()], withoutCap());
    expect(result.code).toBe(0);
    const last = lines(result.stdout).at(-1);
    expect(last).toMatchObject({ type: "result", usage: { input_tokens: 12, output_tokens: 3 } });
    expect(Object.keys(last)).not.toContain("structured_output");
  });

  it("F3: streams one closed message before a delayed single-call answer when usageBeforeDelay is set", async () => {
    const cwd = await workdir();
    const scriptPath = await singleCallScript(cwd, { output: { answer: "late" }, delayMs: { "single-call": 30_000 }, usageBeforeDelay: true });
    const child = spawn(process.execPath, [fake, "script", join(cwd, "marker.json"), scriptPath, ...singleCallArgs()], { cwd, env: withoutCap(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    await expect.poll(() => stdout.includes('"message_delta"'), { timeout: 5000 }).toBe(true);
    child.kill("SIGKILL");
    expect(stdout).not.toContain('"result"');
  });

  it("F4: without --tools \"\" the same schema is not a single call, and no cap is recorded when none is set", async () => {
    const cwd = await workdir();
    await launchEnv(cwd, ["ok", join(cwd, "marker.json"), ...singleCallArgs(false)], withoutCap());
    expect(await readFile(join(cwd, "marker.json.calls"), "utf8")).toBe("plan\n");
    expect(JSON.parse(await readFile(join(cwd, "marker.json"), "utf8")).maxOutputTokensEnv).toBeNull();
  });

  // Orca N1 (2026-10-02, requirement to split, plan Task C1): a sequence of single calls, each answered by the first
  // unused queue entry whose `match` the prompt contains; F1-F4's single "single-call" entry is unchanged.
  it("F5: answers single calls from single-call-queue in order, honouring match, and refuses when it is used up", async () => {
    const cwd = await workdir();
    const scriptPath = join(cwd, "script.json");
    await writeFile(scriptPath, JSON.stringify({ "single-call-queue": [{ match: "ALPHA", output: { answer: "a" } }, { output: { answer: "b" } }] }));
    const callWith = (prompt: string) => launchEnv(cwd, ["script", join(cwd, "marker.json"), scriptPath,
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(answerSchema), "--tools", "", prompt], withoutCap());
    const first = await callWith("beta prompt");
    expect(first.code).toBe(0);
    expect(lines(first.stdout).at(-1)).toMatchObject({ structured_output: { answer: "b" } });
    const second = await callWith("an ALPHA prompt");
    expect(lines(second.stdout).at(-1)).toMatchObject({ structured_output: { answer: "a" } });
    expect((await callWith("ALPHA again")).code).toBe(3);
    expect(await readFile(join(cwd, "marker.json.tasks"), "utf8")).toBe("single-call single-call-queue#1\nsingle-call single-call-queue#0\nsingle-call -\n");
  });

  // Orca N1 (2026-10-02, plan Task C1, fix round 1): a script that still has a "single-call" entry (F1-F4's shape) is not
  // hijacked by a queue beside it.
  it("F5b: a script with both a single-call entry and a single-call-queue answers from the single-call entry and leaves the queue unused", async () => {
    const cwd = await workdir();
    const scriptPath = join(cwd, "script.json");
    await writeFile(scriptPath, JSON.stringify({ "single-call": { output: { answer: "entry" } }, "single-call-queue": [{ output: { answer: "queued" } }] }));
    const result = await launchEnv(cwd, ["script", join(cwd, "marker.json"), scriptPath, ...singleCallArgs()], withoutCap());
    expect(result.code).toBe(0);
    expect(lines(result.stdout).at(-1)).toMatchObject({ structured_output: { answer: "entry" } });
    expect(existsSync(join(cwd, "marker.json.single-call-queue"))).toBe(false);
  });
});
