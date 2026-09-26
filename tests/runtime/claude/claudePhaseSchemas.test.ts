import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca paid claude round (2026-09-27, the first run of the real claude CLI through ccloop): every execute call was
// refused by the API as "400 tools.N.custom.input_schema.type: Field required", because the --json-schema the runner
// hands claude becomes a tool's input_schema and the execute schema's top level was a bare oneOf. The fake claude
// never looks at the schema, so these criteria read what the runner actually passes.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/**
 * A stand-in claude that records the --json-schema it was given and whether its stdin reached end of file within
 * 1.5 s, then answers `structured` as a `-p --output-format json` envelope.
 */
async function world(structured: unknown) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-phase-schemas-")));
  dirs.push(dir);
  const seen = join(dir, "seen.json");
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, [
    'import { writeFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);',
    "let stdinEnded = false;",
    'process.stdin.on("data", () => {}); process.stdin.on("end", () => { stdinEnded = true; });',
    "setTimeout(() => {",
    `  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ schema, stdinEnded }));`,
    `  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: ${JSON.stringify(structured)}, usage: { input_tokens: 1, output_tokens: 1 } }));`,
    "  process.exit(0);",
    "}, 1500);",
  ].join("\n"));
  return { dir, seen, probe };
}

function runPhase(w: { dir: string; probe: string }, phase: "plan" | "execute" | "verify"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, w.probe]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" };
    const child = spawn(process.execPath, [runner], { cwd: w.dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ phase, prompt: `Run the ${phase} phase for task t.`, attempt: 1, runDir: w.dir, worktreePath: w.dir, partialOutcomeRecoveryWindowMs: 100 }));
  });
}

const complete = { changedFiles: ["a.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "" };
const answers = {
  plan: { summary: "s", primaryTargetPaths: ["a.txt"] },
  execute: complete,
  verify: { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: true, evidence: [], pauseSignals: [], stopSignals: [] },
} as const;

describe("what the claude phase runner hands the claude CLI (Orca paid claude round)", { timeout: 30_000 }, () => {
  it("gives every phase a --json-schema whose top level is an object, with no top-level oneOf, anyOf or allOf", async () => {
    for (const phase of ["plan", "execute", "verify"] as const) {
      const w = await world(answers[phase]);
      const result = await runPhase(w, phase);
      expect(result.code, `${phase}: ${result.stderr}`).toBe(0);
      const { schema } = JSON.parse(await readFile(w.seen, "utf8")) as { schema: Record<string, unknown> };
      expect({ phase, type: schema.type, oneOf: schema.oneOf, anyOf: schema.anyOf, allOf: schema.allOf }).toEqual({ phase, type: "object", oneOf: undefined, anyOf: undefined, allOf: undefined });
    }
  });

  it("still lets claude answer execute with a well-formed partial outcome", async () => {
    const partial = { ...complete, completionStatus: "partial", failureType: "timeout", failureMessage: "ran out of time" };
    const w = await world(partial);
    const result = await runPhase(w, "execute");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(partial);
  });

  it("refuses a partial execute answer that lacks its failure type or message, which the flat schema can no longer refuse", async () => {
    for (const broken of [
      { ...complete, completionStatus: "partial", failureMessage: "m" },
      { ...complete, completionStatus: "partial", failureType: "error" },
      { ...complete, failureType: "error", failureMessage: "m" },
    ]) {
      const w = await world(broken);
      const result = await runPhase(w, "execute");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("claude-execute-partial-incomplete");
    }
  });

  it("closes claude's stdin at once, since the prompt is an argument", async () => {
    const w = await world(answers.plan);
    const result = await runPhase(w, "plan");
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(w.seen, "utf8"))).toMatchObject({ stdinEnded: true });
  });
});
