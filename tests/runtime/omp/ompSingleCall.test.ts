import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { OMP_SINGLE_CALL_OVERLAY, runOmpSingleCall } from "../../../src/runtime/omp/ompSingleCall.js";
import { observedTokensOf, type SingleCallRequest } from "../../../src/runtime/types.js";

// OMP single call (Orca spec 2026-10-14-omp-single-call-design.md §3.3). Orca books the catalog cap as the call's output
// bound; omp cannot take a per-call cap, so a cap that rose above the request's must refuse the call before anything is
// sent (criterion 3), and the call must run with every tool, rule and LSP off, under the overlay that switches omp's own
// retries and model switches off (criterion 4) -- otherwise one booked request could become several, or a tool run.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function ompWorld(options: { catalog?: unknown; single?: unknown; installationTimeoutMs?: number } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-omp-single-")));
  dirs.push(dir);
  const marker = join(dir, "omp-marker");
  if (options.catalog !== undefined) await writeFile(`${marker}.catalog.json`, JSON.stringify(options.catalog));
  if (options.single !== undefined) await writeFile(`${marker}.single.json`, JSON.stringify(options.single));
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  const runDir = join(dir, "run");
  const cwd = join(runDir, "cwd");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: options.installationTimeoutMs ?? 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
  };
  const request = (over: Partial<SingleCallRequest> = {}): SingleCallRequest => ({
    prompt: "Estimate the plan below.", responseSchema: SCHEMA, maxOutputTokens: 8_192, cwd, runDir, timeoutMs: 60_000, ...over,
  });
  return { dir, marker, binary, config, request };
}
const modelA = (numbers: Record<string, unknown>) => ({ provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, ...numbers });
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

describe("spawn-time check (§3.3.1, criterion 3)", () => {
  it("C3: refuses before spawning when the catalog cap exceeds the request's maxOutputTokens, booking 0", async () => {
    const w = await ompWorld({ catalog: [modelA({ maxTokens: 8192 })] });
    const failure = await failureOf(runOmpSingleCall(w.config, w.request({ maxOutputTokens: 4_096 })));
    expect(failure).toMatchObject({ code: "omp-single-call-cap-exceeded", neverStarted: true });
    expect(observedTokensOf(failure)).toBe(0);
    expect(existsSync(`${w.marker}.calls`)).toBe(false);
  });

  it("C3: runs when the catalog cap equals the request's maxOutputTokens", async () => {
    const w = await ompWorld({ catalog: [modelA({ maxTokens: 8192 })] });
    const outcome = await runOmpSingleCall(w.config, w.request({ maxOutputTokens: 8_192 }));
    expect(outcome).toMatchObject({ reason: "completed", neverStarted: false });
    expect(await readFile(`${w.marker}.calls`, "utf8")).toBe("single-call\n");
  });

  it("refuses as unavailable, never started, when the row lost its cap, the model left the catalog, or the catalog cannot be read", async () => {
    for (const catalog of [[modelA({})], [{ ...modelA({ maxTokens: 8192 }), id: "other", selector: "gateway/other" }], "not rows"]) {
      const w = await ompWorld({ catalog });
      const failure = await failureOf(runOmpSingleCall(w.config, w.request()));
      expect([catalog, failure]).toEqual([catalog, expect.objectContaining({ code: "omp-single-call-unavailable", neverStarted: true })]);
      expect(observedTokensOf(failure)).toBe(0);
      expect(existsSync(`${w.marker}.calls`)).toBe(false);
    }
  }, 20_000);

  // Controller ruling (Task 4, Review Focus 2): a catalog probe that exits non-zero or prints no JSON at spawn time is
  // the same refusal, and no model process is spawned -- proved by the fake's own call log, not only by the error code.
  it("refuses as unavailable, never started, when the catalog probe exits non-zero or prints bad JSON", async () => {
    for (const probe of ["exit 3", "printf 'not json\\n'; exit 0"]) {
      const w = await ompWorld();
      await writeFile(w.binary, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = models ]; then ${probe}; fi; done\nexec '${process.execPath}' '${FAKE_OMP}' '${w.marker}' "$@"\n`, { mode: 0o700 });
      const failure = await failureOf(runOmpSingleCall(w.config, w.request()));
      expect([probe, failure]).toEqual([probe, expect.objectContaining({ code: "omp-single-call-unavailable", neverStarted: true })]);
      expect(observedTokensOf(failure)).toBe(0);
      expect(existsSync(`${w.marker}.calls`)).toBe(false);
      expect(existsSync(`${w.marker}.argv`)).toBe(false);
    }
  }, 20_000);
});

describe("argv (§3.3.2-§3.3.4, criterion 4)", () => {
  it("C4: passes exactly the single-call argv: tools, rules and LSP off, no --tools list, the overlay, the request's cwd", async () => {
    const w = await ompWorld();
    const request = w.request();
    await runOmpSingleCall(w.config, request);
    const [argv] = (await readFile(`${w.marker}.argv`, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(argv).toEqual([
      "--profile", "default", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools",
      "--no-session", "--no-title", "--no-prewalk", "--model", "gateway/model-a", "--mode", "json", "-p",
      "--system-prompt", expect.stringMatching(/\/run\/omp\/1\/single-call\/call-[^/]+\/system-prompt\.md$/),
      "--cwd", request.cwd,
      "--config", expect.stringMatching(/\/run\/omp\/1\/single-call\/call-[^/]+\/config-overlay\.yml$/),
    ]);
    expect(argv).not.toContain("--tools");
    expect(JSON.parse(await readFile(argv![argv!.indexOf("--config") + 1]!, "utf8"))).toEqual(OMP_SINGLE_CALL_OVERLAY);
    const system = await readFile(argv![argv!.indexOf("--system-prompt") + 1]!, "utf8");
    expect(system).toContain("one ccloop single call");
    expect(system).toContain(JSON.stringify(SCHEMA));
  });
});
