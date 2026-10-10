import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const core = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "log" };
const report = { schema: "task-result-v1", goal: "Set answer", completedWork: [], conclusions: [], limitations: [], outputs: [] };
async function run(raw: string, script = runner) {
  const dir = await mkdtemp(join(tmpdir(), "task-result-runner-")); dirs.push(dir);
  const fake = join(dir, "fake.mjs"), schemaPath = join(dir, "schema.json"), calls = join(dir, "calls");
  await writeFile(join(dir,"envelope.json"), '{"structured_output":' + raw + ',"usage":{"input_tokens":12,"output_tokens":3}}');
  await writeFile(fake, `import { readFileSync, writeFileSync, appendFileSync } from "node:fs"; const a=process.argv.slice(2); writeFileSync(${JSON.stringify(schemaPath)},a[a.indexOf('--json-schema')+1]); appendFileSync(${JSON.stringify(calls)},${JSON.stringify("execute\n")}); process.stdout.write(readFileSync(${JSON.stringify(join(dir,'envelope.json'))},'utf8'));`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, fake]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {});
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); child.stdin.end(JSON.stringify({ phase: "execute", prompt: "Execute this attempt", attempt: 1, runDir: dir, worktreePath: dir })); });
  expect(code, stderr).toBe(0);
  return { answer: JSON.parse(stdout), schema: JSON.parse(await readFile(schemaPath,"utf8")), calls: await readFile(calls,"utf8") };
}
// Break: missing schema support or runner bounding prevents metadata from remaining an optional one-call channel.
describe("Claude optional report channel", () => {
  it("asks for arbitrary optional metadata while preserving required core fields and one CLI call", async () => {
    const got = await run(JSON.stringify({ ...core, taskResult: report }));
    expect(got.schema.properties.taskResult).toEqual({});
    expect(got.schema.required).toEqual(["changedFiles", "diffPatch", "commandOutputs", "stdoutStderrLog"]);
    expect(got.schema.additionalProperties).toBe(false);
    expect(got.answer).toMatchObject({ ...core, taskResult: report, tokenUsage: 15 });
    expect(got.calls).toBe("execute\n");
  });
  it.each(["oversized", "deep"])("bounds %s metadata before stdout serialization, preserving core and usage", async kind => {
    const raw = kind === "deep" ? '{"a":'.repeat(20000) + '{}' + '}'.repeat(20000) : JSON.stringify('x'.repeat(65535));
    const got = await run(JSON.stringify(core).slice(0,-1) + ',"taskResult":' + raw + '}');
    expect(got.answer).toMatchObject({ ...core, tokenUsage: 15 });
    expect(typeof got.answer.taskResult).toBe("object");
    expect(got.answer.taskResult.schema).toBe("ccloop-task-result-invalid-v1");
    expect(Buffer.byteLength(JSON.stringify(got.answer),"utf8")).toBeLessThan(70000);
    expect(got.calls).toBe("execute\n");
  });
  it("keeps the partial failure fields and usage despite malformed metadata", async () => {
    const partial = { ...core, completionStatus: "partial", failureType: "timeout", failureMessage: "stopped", taskResult: 0 };
    const got = await run(JSON.stringify(partial));
    expect(got.answer).toMatchObject({ ...partial, tokenUsage: 15 });
    expect(got.calls).toBe("execute\n");
  });
});
