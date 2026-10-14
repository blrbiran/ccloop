import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import { readOmpCatalog } from "../../src/agents/ompModels.js";
import type { InstallationV1, MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runOmpSingleCall } from "../../src/runtime/omp/ompSingleCall.js";

// Feedback #58: a failed catalog probe used to say only `omp-model-catalog-unavailable`, so an operator could not tell a
// timeout from a broken config; and every resolution in one process spawned `omp models` again. The code stays the
// message's prefix (callers match it) with the reason and a bounded, sanitised stderr tail after it; one process reads an
// installation's catalog once -- except the single call's spawn-time re-read (Orca spec 2026-10-14 §3.3.1), which must see
// the catalog as it is right before the spawn, not as it was at resolution.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function world(models: Record<string, unknown>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-diag-")));
  dirs.push(dir);
  const marker = join(dir, "omp-marker");
  await writeFile(`${marker}.models.json`, JSON.stringify(models));
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  const installation: InstallationV1 = { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null };
  const calls = async (): Promise<string> => readFile(`${marker}.calls`, "utf8");
  return { dir, installation, calls };
}
const messageOf = async (promise: Promise<unknown>): Promise<string> => promise.then(
  () => { throw new Error("expected a rejection"); },
  (error: unknown) => (error instanceof Error ? error.message : String(error)),
);

describe("catalog probe diagnostics (feedback #58)", () => {
  it("C58a: a non-zero exit names its code and the stderr tail after the unchanged code", async () => {
    const w = await world({ exitCode: 3, stderr: "boom: no config\n" });
    const message = await messageOf(readOmpCatalog(w.installation));
    expect(message.startsWith("omp-model-catalog-unavailable: exit 3")).toBe(true);
    expect(message).toContain("stderr: boom: no config");
  });

  it("C58b: a probe that never answers is reported as a timeout, not as the exit the kill caused", async () => {
    const w = await world({ hang: true });
    const message = await messageOf(readOmpCatalog(w.installation, { timeoutMs: 300 }));
    expect(message.startsWith("omp-model-catalog-unavailable: timeout 300ms")).toBe(true);
  }, 20_000);

  it("C58c: the stderr tail is at most 400 bytes of valid UTF-8 without control bytes, and is the END of stderr", async () => {
    const stderr = `${"x".repeat(10_240)}\u0007\u001b[31m${"é😀\u0001\r\n".repeat(120)}\u0000end!`;
    const w = await world({ exitCode: 1, stderr });
    const message = await messageOf(readOmpCatalog(w.installation));
    const tail = message.slice(message.indexOf(" · stderr: ") + " · stderr: ".length);
    expect(message).toContain(" · stderr: ");
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(tail, "utf8")).toBeGreaterThan(300);
    expect(/\p{Cc}/u.test(tail)).toBe(false);
    expect(tail.includes("�")).toBe(false);
    expect(Buffer.from(tail, "utf8").toString("utf8")).toBe(tail);
    expect(tail.endsWith("é😀 end!")).toBe(true);
    expect(tail.includes("x")).toBe(false);
  });
});

describe("catalog memo (feedback #58)", () => {
  it("C58d: two resolutions of one installation in one process spawn `omp models` once", async () => {
    const w = await world({});
    const table = { schema: "ccloop-agents-table-v1" as const, installations: { work: w.installation } };
    const deps = { probeVersion: async () => "18.10.1" };
    const first = await resolveAgent(table, { agent: "work" }, deps);
    const second = await resolveAgent(table, { agent: "work" }, deps);
    expect(second.resolution).toEqual(first.resolution);
    expect(first.resolution.singleCallOutputCap).toBe(8_192);
    expect(await w.calls()).toBe("models\n");
  });

  it("C58e: the single call's spawn-time re-read spawns `omp models` again after a memoised resolution", async () => {
    const w = await world({});
    const table = { schema: "ccloop-agents-table-v1" as const, installations: { work: w.installation } };
    const deps = { probeVersion: async () => "18.10.1" };
    const { config } = await resolveAgent(table, { agent: "work" }, deps);
    await resolveAgent(table, { agent: "work" }, deps);
    const runDir = join(w.dir, "run");
    const cwd = join(runDir, "cwd");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const materialized: MaterializedAgentConfigV1 = config;
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const outcome = await runOmpSingleCall(materialized, { prompt: "Estimate.", responseSchema: schema, maxOutputTokens: 8_192, cwd, runDir, timeoutMs: 60_000 });
    expect(outcome).toMatchObject({ reason: "completed" });
    expect(await w.calls()).toBe("models\nmodels\nsingle-call\n");
  }, 20_000);
});
