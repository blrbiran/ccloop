import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { runLoop } from "../../../src/controller/runLoop.js";
import { normalizeExecutionFinal } from "../../../src/runtime/executionNormalizer.js";
import { codexFixture } from "./fixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const fields = { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: ["ran"], stdoutStderrLog: ["first", "second"] };

async function execute(final: string) {
  const fixture = await codexFixture("final-text");
  dirs.push(fixture.dir);
  const finals = join(fixture.dir, "finals.json");
  await writeFile(finals, JSON.stringify({ execute: final }));
  const adapter = new CodexAdapter({ ...fixture.config, command: [...fixture.config.command, finals] });
  const call = async () => {
    const [name] = await readdir(join(fixture.runDir, "codex", "1", "execute"));
    return join(fixture.runDir, "codex", "1", "execute", name!);
  };
  return { adapter, fixture, call };
}

// #316: a completed, metered Codex execute must not discard otherwise valid work because its log was an array.
// Mutation: remove the Codex-only projection and these direct/wrapped/partial cases reject the valid answer.
describe("Codex execute log-array compatibility (#316)", () => {
  for (const wrapped of [false, true]) for (const partial of [false, true]) {
    it(`keeps a ${partial ? "partial" : "complete"} ${wrapped ? "wrapped" : "direct"} answer and its raw final`, async () => {
      const body = { ...fields, ...(partial ? { completionStatus: "partial", failureType: "error", failureMessage: "stopped" } : {}) };
      const final = JSON.stringify(wrapped ? { result: body } : body);
      const { adapter, fixture, call } = await execute(final);
      const result = await adapter.execute(fixture.context);
      if (result === null) throw new Error("Codex execute returned no result");
      expect(result.stdoutStderrLog).toBe("first\nsecond");
      expect(result.tokenUsage).toBeGreaterThan(0);
      expect(await readFile(join(await call(), "final.json"), "utf8")).toBe(final);
      expect(normalizeExecutionFinal(final).status).toBe("unavailable"); // Claude and OMP stay strict.
    }, 30_000);
  }

  it("accepts an empty log array as an empty string, without inventing a log line", async () => {
    const { adapter, fixture } = await execute(JSON.stringify({ result: { ...fields, stdoutStderrLog: [] } }));
    const result = await adapter.execute(fixture.context);
    if (result === null) throw new Error("Codex execute returned no result");
    expect(result.stdoutStderrLog).toBe("");
  }, 30_000);

  it("accepts a decorated answer only when the array-log candidate is unique", async () => {
    const { adapter, fixture } = await execute(`Done: ${JSON.stringify({ result: fields })}`);
    const result = await adapter.execute(fixture.context);
    if (result === null) throw new Error("Codex execute returned no result");
    expect(result.stdoutStderrLog).toBe("first\nsecond");
  }, 30_000);

  for (const [name, body] of [
    ["non-string log element", { ...fields, stdoutStderrLog: ["first", 3] }],
    ["malformed core field", { ...fields, commandOutputs: "ran" }],
  ] as const) it(`refuses ${name} instead of coercing the answer`, async () => {
    const { adapter, fixture } = await execute(JSON.stringify({ result: body }));
    await expect(adapter.execute(fixture.context)).rejects.toThrow("codex-result-invalid");
  }, 30_000);

  it("writes the joined log for a completed run while keeping the provider's original final", async () => {
    const fixture = await codexFixture("reported");
    dirs.push(fixture.dir);
    await writeFile(`${fixture.marker}.reported.json`, JSON.stringify({ stdoutStderrLog: ["first", "second"] }));
    const state = await runLoop(fixture.contract, fixture.runDir, new CodexAdapter(fixture.config));
    expect(state.status).toBe("succeeded");
    expect(await readFile(join(fixture.runDir, "attempts", "1", "stdout-stderr.log"), "utf8")).toBe("first\nsecond");
    const [name] = await readdir(join(fixture.runDir, "codex", "1", "execute"));
    const original = JSON.parse(await readFile(join(fixture.runDir, "codex", "1", "execute", name!, "final.json"), "utf8"));
    expect(original.result.stdoutStderrLog).toEqual(["first", "second"]);
  }, 60_000);

  it("refuses two different valid candidates in decorated output", async () => {
    const { adapter, fixture, call } = await execute(`One ${JSON.stringify({ result: fields })} two ${JSON.stringify({ result: { ...fields, stdoutStderrLog: ["other"] } })}`);
    await expect(adapter.execute(fixture.context)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(await call(), "execution-normalization.json"), "utf8"))).toMatchObject({
      status: "unavailable", reason: "execution-format-ambiguous-or-hidden", diagnostic: { valid: 2 },
    });
  }, 30_000);
});
