import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAgentCatalog } from "../../src/agents/agentCatalog.js";
import { catalogKey, entryFileName } from "../../src/agents/catalogCache.js";
import { runControlCommand } from "../../src/control/command.js";
import { acceptStart } from "../../src/control/accept.js";
import { resolveAgent } from "../../src/agents/materialize.js";
import { applyAgentInstallations, previewAgentInstallations } from "../../src/agents/updates.js";
import type { InstallationV1 } from "../../src/agents/types.js";
import { codexInstallation, singleCallEnvelope, writeAgentsTable } from "../control/agentsFixture.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §4.1, R4; criterion 1): with a warm cache, capabilities and accept
// for an omp or codex selection spawn no catalog and no version process -- read from the fakes' own counts.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs"), FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
const count = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0);
async function table() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agent-catalog-")));
  const ompMarker = join(dir, "omp-marker"), codexMarker = join(dir, "codex-marker");
  const omp = join(dir, "omp");
  await writeFile(omp, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${ompMarker}' "$@"\n`, { mode: 0o700 });
  const codex = await codexInstallation({ command: [process.execPath, FAKE_CODEX, "integration", codexMarker], sandbox: "read-only", budgetMode: "soft", timeoutMs: 60_000, killGraceMs: 100 });
  const written = await writeAgentsTable({
    omp: { kind: "omp", command: [omp], version: "18.10.1", configDir: null, timeoutMs: 60_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    codex,
  }, dir);
  return { dir, ...written, ompMarker, codexMarker };
}
const spawns = (marker: string) => count(`${marker}.catalog-calls`) + count(`${marker}.version-calls`);

describe("criterion 1: a warm cache spawns nothing (spec §4.1)", { timeout: 30_000 }, () => {
  it("capabilities for omp and codex probe once, then never again", async () => {
    const t = await table();
    for (const agent of ["omp", "codex"]) {
      expect((await runControlCommand(["capabilities", "--agents", t.path], JSON.stringify({ agent: { agent } }))).code).toBe(0);
    }
    const warm = [spawns(t.ompMarker), spawns(t.codexMarker)];
    // omp 2 = 1 version + 1 models; codex 4 = 1 version by codexInstallation (agentsFixture.ts:28-41) + 1 version + debug-models + features-list.
    expect(warm).toEqual([2, 4]);
    for (const agent of ["omp", "codex", "omp", "codex"]) {
      expect((await runControlCommand(["capabilities", "--agents", t.path], JSON.stringify({ agent: { agent } }))).code).toBe(0);
    }
    expect([spawns(t.ompMarker), spawns(t.codexMarker)]).toEqual(warm);
  });

  // codex joins this loop in Task 6 (only-add), once codex answers v1-soft and accept admits its single-call work.
  it("accept for omp probes nothing on a warm key", async () => {
    const t = await table();
    for (const agent of ["omp"] as const) {
      const { resolution } = await resolveAgent(t.table, { agent });
      const before = spawns(agent === "omp" ? t.ompMarker : t.codexMarker);
      const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agent-catalog-accept-")));
      const status = await acceptStart(singleCallEnvelope({ sourceDir, agent: resolution.selection, configHash: resolution.configHash }), {
        agentsTablePath: t.path, workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")], receiptTimeoutMs: 2_000,
      });
      expect(status.kind).toBe("accepted");
      expect(spawns(agent === "omp" ? t.ompMarker : t.codexMarker)).toBe(before);
    }
  });

  // Task 6 (Orca spec 2026-10-15 §6.1, only-add): codex answers v1-soft, so accept admits its single-call work; on a warm
  // key the re-resolution inside accept reads the cache and spawns nothing.
  it("accept for codex probes nothing on a warm key", async () => {
    const t = await table();
    for (const agent of ["codex"] as const) {
      const { resolution } = await resolveAgent(t.table, { agent });
      const before = spawns(t.codexMarker);
      const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agent-catalog-accept-")));
      const status = await acceptStart(singleCallEnvelope({ sourceDir, agent: resolution.selection, configHash: resolution.configHash }), {
        agentsTablePath: t.path, workerCommand: [resolve("node_modules/.bin/tsx"), resolve("tests/fixtures/control-worker.mjs")], receiptTimeoutMs: 2_000,
      });
      expect(status.kind).toBe("accepted");
      expect(spawns(t.codexMarker)).toBe(before);
    }
  });

  it("refresh skips the read, probes, and rewrites", async () => {
    const t = await table();
    const installation = t.table.installations.omp!;
    expect((await readAgentCatalog(installation)).source).toBe("probe");
    expect((await readAgentCatalog(installation)).source).toBe("cache");
    expect((await readAgentCatalog(installation, { refresh: true })).source).toBe("probe");
    expect(count(`${t.ompMarker}.catalog-calls`)).toBe(2);
  });

  it("does not write an entry when a probe failed, and reports the omp failure as catalogError", async () => {
    const t = await table();
    await writeFile(`${t.ompMarker}.models.json`, JSON.stringify({ exitCode: 3, stderr: "boom\n" }));
    const answer = await readAgentCatalog(t.table.installations.omp!, { env: { ...process.env, CCLOOP_CACHE_DIR: join(t.dir, "cache") } });
    expect(answer.catalogError).toMatch(/^omp-model-catalog-unavailable: exit 3 · stage exit · elapsedMs \d+ · stderr: boom$/);
    expect(existsSync(join(t.dir, "cache"))).toBe(false);
  });

  it("writes under a relocated HOME's default path only when CCLOOP_CACHE_DIR and XDG_CACHE_HOME are unset (§4.2)", async () => {
    const t = await table();
    const home = join(t.dir, "home");
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR };
    const run = spawnSync(process.execPath, [resolve("dist/cli.js"), "control", "capabilities", "--agents", t.path], { input: JSON.stringify({ agent: { agent: "omp" } }), env, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect((await readdir(join(home, ".cache", "ccloop", "agent-catalog"))).length).toBe(1);
    const redirected = join(t.dir, "redirected");
    const again = spawnSync(process.execPath, [resolve("dist/cli.js"), "control", "capabilities", "--agents", t.path], { input: JSON.stringify({ agent: { agent: "codex" } }), env: { ...env, CCLOOP_CACHE_DIR: redirected }, encoding: "utf8" });
    expect(again.status, again.stderr).toBe(0);
    expect((await readdir(join(home, ".cache", "ccloop", "agent-catalog"))).length).toBe(1);
    expect((await readdir(redirected)).length).toBe(1);
  });

  it("reads the omp spawn-time re-check through the cache (R8)", async () => {
    const t = await table();
    await readAgentCatalog(t.table.installations.omp!);
    const before = count(`${t.ompMarker}.catalog-calls`);
    const { runOmpSingleCall } = await import("../../src/runtime/omp/ompSingleCall.js");
    const runDir = join(t.dir, "run"), cwd = join(runDir, "cwd");
    await (await import("node:fs/promises")).mkdir(cwd, { recursive: true, mode: 0o700 });
    const config = { schema: "ccloop-agent-config-v1" as const, kind: "omp", installation: t.table.installations.omp!, selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" as const } };
    await runOmpSingleCall(config, { prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 8192, cwd, runDir, timeoutMs: 30_000 });
    expect(count(`${t.ompMarker}.catalog-calls`)).toBe(before);
  });
});

// Task 4 rulings (Orca session a852f96a, SDD progress.md): what a person meets when the cache is damaged, absent or slow,
// and which process may say so on stderr. Each test is the one its named mutation turns red.
describe("readAgentCatalog under damage, no cache, a shared deadline, and logging (Task 4 rulings)", { timeout: 30_000 }, () => {
  const cacheEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, CCLOOP_CACHE_DIR: join(dir, "cache") });
  const entryPath = async (installation: InstallationV1, env: NodeJS.ProcessEnv) => join(env.CCLOOP_CACHE_DIR!, entryFileName(await catalogKey(installation, env)));
  const capabilities = (t: { path: string }, agent: string, env: NodeJS.ProcessEnv, cwd?: string) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), "control", "capabilities", "--agents", t.path], { input: JSON.stringify({ agent: { agent } }), env, cwd, encoding: "utf8" });

  // Task 2 deferred item: readCatalogEntry checks only that rows/codexFeatures are arrays; a hit with a malformed element
  // would hand resolution a row it cannot read, so the consumer treats it as a miss and the probe overwrites it.
  it.each([
    ["omp", "rows", [1]],
    ["omp", "rows", [{ selector: 1, provider: "gateway", contextWindow: 200000, maxTokens: 8192 }]],
    ["codex", "rows", [{ selector: "gpt-6-sol", provider: "codex", contextWindow: "272000", maxTokens: null, listed: true }]],
    ["codex", "codexFeatures", [1]],
  ] as const)("a %s entry whose %s elements have the wrong shape is a miss, overwritten by the probe", async (agent, field, bad) => {
    const t = await table();
    const installation = t.table.installations[agent]!, env = cacheEnv(t.dir);
    expect((await readAgentCatalog(installation, { env })).source).toBe("probe");
    const path = await entryPath(installation, env);
    const good = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...good, [field]: bad }));
    expect((await readAgentCatalog(installation, { env })).source).toBe("probe");
    expect((JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)[field]).toEqual(good[field]);
    expect((await readAgentCatalog(installation, { env })).source).toBe("cache");
  });

  // RF4 (plan Review Focus 4), consumer half: a clock moved back, or a file whose stored key is not its name's key.
  it.each([
    ["dated in the future", (entry: Record<string, unknown>) => ({ ...entry, observedAt: new Date(Date.now() + 3_600_000).toISOString() })],
    ["whose stored key differs from its file name's key", (entry: Record<string, unknown>) => ({ ...entry, key: { ...(entry.key as object), command: ["/elsewhere/omp"] } })],
  ] as const)("RF4: an entry %s is a miss and the next probe overwrites it", async (_label, tamper) => {
    const t = await table();
    const installation = t.table.installations.omp!, env = cacheEnv(t.dir);
    await readAgentCatalog(installation, { env });
    const path = await entryPath(installation, env);
    const good = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(tamper(good)));
    expect((await readAgentCatalog(installation, { env })).source).toBe("probe");
    const rewritten = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(rewritten.key).toEqual(good.key);
    expect(Date.parse(rewritten.observedAt as string)).toBeLessThanOrEqual(Date.now());
    expect(count(`${t.ompMarker}.catalog-calls`)).toBe(2);
  });

  // RF3 (plan Review Focus 3): launchd/systemd-like environments -- no HOME, no XDG_CACHE_HOME, a relative CCLOOP_CACHE_DIR.
  it("RF3: with no usable cache dir it probes every time and writes nothing into the working directory", async () => {
    const t = await table();
    const cwd = join(t.dir, "cwd");
    await mkdir(cwd);
    const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CCLOOP_CACHE_DIR: "relative-cache" };
    for (const _ of [1, 2]) {
      const run = capabilities(t, "omp", env, cwd);
      expect(run.status, run.stderr).toBe(0);
    }
    expect(count(`${t.ompMarker}.catalog-calls`)).toBe(2);
    expect(await readdir(cwd)).toEqual([]);
  });

  // Plan issue 4: Orca's port gives ccloop 60 s; a cold resolution without a caller deadline must end inside one 30 s
  // window, so the version probe and the catalog probes share it instead of each starting its own. `now` moves "30 s from
  // now" to one second from the real clock; the wrapper's `--version` takes 3 s.
  it("one deadline -- the caller's, else 30 s from now -- bounds the version probe and the catalog probe together (plan issue 4)", async () => {
    const t = await table();
    const slow = join(t.dir, "omp-slow");
    await writeFile(slow, `#!/bin/sh\ncase " $* " in *" --version "*) sleep 3;; esac\nexec '${process.execPath}' '${FAKE_OMP}' '${t.ompMarker}' "$@"\n`, { mode: 0o700 });
    const installation: InstallationV1 = { ...t.table.installations.omp!, command: [slow] };
    const started = Date.now();
    const answer = await readAgentCatalog(installation, { env: cacheEnv(t.dir), now: () => Date.now() - 29_000 });
    expect(answer.version).toBeNull();
    expect(answer.catalogError).toMatch(/^omp-model-catalog-unavailable: timeout \d+ms · stage timeout · elapsedMs \d+$/);
    expect(Date.now() - started).toBeLessThan(2_900);
    const { table: slowTable } = await writeAgentsTable({ omp: installation });
    await expect(resolveAgent(slowTable, { agent: "omp" }, { deadline: Date.now() + 1_000 })).rejects.toThrow(/^Could not observe the version of installation "omp"/);
  });

  // Plan issue 5: loop phases do not need the codex catalog, so a transient `debug models` failure must not stop codex
  // work; omp still refuses, since its model must be an exact catalog selector.
  it("a codex catalog that cannot be read degrades the resolution; an omp one refuses it (plan issue 5)", async () => {
    const t = await table();
    await writeFile(`${t.codexMarker}.catalog.json`, JSON.stringify({ exitCode: 3 }));
    await writeFile(`${t.ompMarker}.models.json`, JSON.stringify({ exitCode: 3 }));
    const { resolution } = await resolveAgent(t.table, { agent: "codex" });
    expect(count(`${t.codexMarker}.catalog-calls`)).toBe(1);
    expect(resolution.capabilities.contextWindowTokens).toBeNull();
    expect(resolution.singleCallExecution).toBeNull();
    await expect(resolveAgent(t.table, { agent: "omp" })).rejects.toThrow(/^omp-model-catalog-unavailable: exit 3 · stage exit · elapsedMs \d+$/);
  });

  // Plan issue 3: Orca reads ccloop's code from the start of `control`'s stderr, so the wire path prints no cache line --
  // cold, or with a failing probe (then stderr is the failure alone).
  it("control prints no cache or probe line on its stderr, cold or failing (plan issue 3)", async () => {
    const t = await table();
    const cold = capabilities(t, "omp", cacheEnv(t.dir));
    expect(cold.status, cold.stderr).toBe(0);
    expect(cold.stderr).toBe("");
    expect((await readdir(join(t.dir, "cache"))).length).toBe(1);
    await writeFile(`${t.ompMarker}.models.json`, JSON.stringify({ exitCode: 3 }));
    const failing = capabilities(t, "omp", { ...process.env, CCLOOP_CACHE_DIR: join(t.dir, "cold") });
    expect(failing.status).not.toBe(0);
    expect(failing.stderr).toMatch(/^omp-model-catalog-unavailable: exit 3 · stage exit · elapsedMs \d+\n?$/);
  });

  // Task 4 ruling (Orca session a852f96a): preview may answer from the cache, but Apply re-probes the omp catalog, since
  // the key cannot see a catalog change since preview (ompUpdates.test.ts "refuses Apply if the model vanishes...").
  it("Apply re-probes the omp catalog that preview cached", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agent-catalog-apply-")));
    const marker = join(dir, "omp-marker"), omp = join(dir, "omp"), tablePath = join(dir, "agents.json");
    await writeFile(omp, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
    const work = { kind: "omp", command: [omp], version: "18.10.0", configDir: null, timeoutMs: 60_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null };
    await writeFile(tablePath, JSON.stringify({ schema: "ccloop-agents-table-v1", installations: { work } }), { mode: 0o600 });
    const preview = await previewAgentInstallations(tablePath, { home: dir, path: dir });
    const change = preview.changes.find((row) => row.kind === "version" && row.installationId === "work");
    expect(change?.unavailableReason).toBeUndefined();
    const before = count(`${marker}.catalog-calls`);
    await applyAgentInstallations(tablePath, { opId: "apply-reprobes", requestDigest: "a".repeat(64), previewId: preview.previewId, baseTableHash: preview.baseTableHash, acceptedChangeIds: [change!.changeId] });
    expect(count(`${marker}.catalog-calls`)).toBe(before + 1);
  });

  // Plan issue 3 / Task 4 ruling: the control worker's spawn-time re-check (runOmpSingleCall, the code the worker runs for
  // an omp single call) says on its own stderr whether it missed the cache or its probe failed, as `agents models` will.
  it("the worker's spawn-time re-check logs a miss, and a failed probe, on its own stderr (plan issue 3)", async () => {
    const { runOmpSingleCall, OmpSingleCallRefused } = await import("../../src/runtime/omp/ompSingleCall.js");
    const call = async (t: Awaited<ReturnType<typeof table>>) => {
      const runDir = join(t.dir, "run"), cwd = join(runDir, "cwd");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const config = { schema: "ccloop-agent-config-v1" as const, kind: "omp", installation: t.table.installations.omp!, selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" as const } };
      return runOmpSingleCall(config, { prompt: "p", responseSchema: { type: "object" }, maxOutputTokens: 8192, cwd, runDir, timeoutMs: 30_000 });
    };
    const fine = await table(), failing = await table();
    await writeFile(`${failing.ompMarker}.models.json`, JSON.stringify({ exitCode: 3 }));
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    let refusal: unknown;
    try {
      await call(fine);
      await call(failing).catch((error: unknown) => { refusal = error; });
    } finally { spy.mockRestore(); }
    expect(refusal).toBeInstanceOf(OmpSingleCallRefused);
    expect(writes.filter((line) => line.startsWith("ccloop-agent-catalog:"))).toEqual([
      expect.stringMatching(/^ccloop-agent-catalog: miss omp [0-9a-f]{12}\n$/),
      expect.stringMatching(/^ccloop-agent-catalog: miss omp [0-9a-f]{12}\n$/),
      expect.stringMatching(/^ccloop-agent-catalog: probe-failed omp omp-model-catalog-unavailable: exit 3 · stage exit · elapsedMs \d+\n$/),
    ]);
  });
});
