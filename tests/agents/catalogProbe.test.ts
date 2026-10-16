import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexFeatureNames, readCodexCatalog } from "../../src/agents/codexCatalog.js";
import { probeTimeoutMs } from "../../src/agents/catalogProbe.js";
import { probeVersion } from "../../src/agents/materialize.js";
import { readOmpCatalog } from "../../src/agents/ompModels.js";
import type { InstallationV1 } from "../../src/agents/types.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §4.3, R6; criterion 2): a probe that outlives the caller's deadline
// or abort is killed (its process is gone) and the refusal names the elapsed time and the stage. The old fixed limit was
// 10 s; every deadline here is far below it.
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs"), FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
async function omp(models?: Record<string, unknown>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-probe-")));
  const marker = join(dir, "omp-marker");
  if (models) await writeFile(`${marker}.models.json`, JSON.stringify(models));
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_OMP}' '${marker}' "$@"\n`, { mode: 0o700 });
  const installation: InstallationV1 = { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 60_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null };
  return { marker, installation };
}
async function codex(catalog?: Record<string, unknown>, toml?: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-probe-codex-")));
  const marker = join(dir, "codex-marker");
  if (catalog) await writeFile(`${marker}.catalog.json`, JSON.stringify(catalog));
  if (toml !== undefined) await writeFile(join(dir, "config.toml"), toml);
  const installation: InstallationV1 = { kind: "codex", command: [process.execPath, FAKE_CODEX, "integration", marker], version: "9.9.9-fake", configDir: dir, timeoutMs: 60_000, killGraceMs: 50, sandbox: "read-only", budgetMode: "soft" };
  return { marker, installation };
}
const gone = async (pid: number) => { for (const until = Date.now() + 3_000; Date.now() < until; await new Promise((r) => setTimeout(r, 25))) { try { process.kill(pid, 0); } catch { return true; } } return false; };
// "Without spawning" is counted, not inferred from the fake's call file: a kill at 0 ms lands before the fake writes it.
const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => { spawned.count += 1; return actual.spawn(...args); } };
});
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: Error) => error);
// The fake writes its pid only once node has started (the abort test that waits for it took 2.5 s in one loaded parallel
// run); a kill that lands earlier leaves no pid to check, so the abort waits for it.
const pidWritten = async (marker: string) => { for (const until = Date.now() + 10_000; Date.now() < until; await new Promise((r) => setTimeout(r, 10))) { try { return Number(await readFile(`${marker}.models.pid`, "utf8")); } catch { /* not yet */ } } throw new Error("fake never wrote its pid"); };

describe("criterion 2: deadline and abort (spec §4.3)", () => {
  it("kills a hanging omp catalog probe at the caller's deadline and names stage and elapsed time", async () => {
    // A shell `omp` that leaves its hanging child in the background, so only a kill of the probe's whole process group
    // reaches that child. A freshly written executable's first start was measured past 1 s in a loaded parallel run
    // (the pid file was not there yet at a 1 s deadline), so it is started once (`warm`) before the timed probe.
    const w = await omp();
    await writeFile(w.installation.command[0], `#!/bin/sh\n[ "$1" = warm ] && exit 0\nsleep 30 &\necho $! > '${w.marker}.models.pid'\nwait\n`);
    spawnSync(w.installation.command[0], ["warm"]);
    const started = Date.now();
    const error = await failure(readOmpCatalog(w.installation, { deadline: started + 1_000 }));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(error.message).toMatch(/^omp-model-catalog-unavailable: timeout \d+ms · stage timeout · elapsedMs \d+$/);
    expect(Number(/elapsedMs (\d+)/.exec(error.message)![1])).toBeGreaterThanOrEqual(900);
    expect(await gone(Number(await readFile(`${w.marker}.models.pid`, "utf8")))).toBe(true);
  }, 20_000);

  it("kills it when the caller aborts, as stage abort", async () => {
    const w = await omp({ hang: true });
    const controller = new AbortController(); void pidWritten(w.marker).then(() => controller.abort());
    const error = await failure(readOmpCatalog(w.installation, { signal: controller.signal }));
    expect(error.message).toMatch(/^omp-model-catalog-unavailable: aborted · stage abort · elapsedMs \d+$/);
    expect(await gone(Number(await readFile(`${w.marker}.models.pid`, "utf8")))).toBe(true);
  }, 20_000);

  it("refuses without spawning when the deadline has already passed", async () => {
    const w = await omp();
    const before = spawned.count;
    const error = await failure(readOmpCatalog(w.installation, { deadline: Date.now() - 1 }));
    expect(error.message).toMatch(/^omp-model-catalog-unavailable: timeout 0ms · stage timeout · elapsedMs \d+$/);
    expect(spawned.count).toBe(before);
    await expect(readFile(`${w.marker}.catalog-calls`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses without spawning when the caller has already aborted", async () => {
    const w = await omp();
    const before = spawned.count;
    const error = await failure(readOmpCatalog(w.installation, { signal: AbortSignal.abort() }));
    expect(error.message).toMatch(/^omp-model-catalog-unavailable: aborted · stage abort · elapsedMs \d+$/);
    expect(spawned.count).toBe(before);
    await expect(readFile(`${w.marker}.catalog-calls`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names a binary that cannot be started as stage spawn", async () => {
    const w = await codex();
    const error = await failure(readCodexCatalog({ ...w.installation, command: [join(w.installation.configDir!, "no-such-codex")] }, {}));
    expect(error.message).toMatch(/^agent-catalog-unavailable: spawn ENOENT · stage spawn · elapsedMs \d+$/);
  });

  it("stops output past 1 MiB as stage decode", async () => {
    const w = await omp();
    await writeFile(w.installation.command[0], `#!/bin/sh\n[ "$1" = warm ] && exit 0\nhead -c 2000000 /dev/zero\n`);
    spawnSync(w.installation.command[0], ["warm"]);
    const error = await failure(readOmpCatalog(w.installation));
    expect(error.message).toMatch(/^omp-model-catalog-unavailable: output-limit · stage decode · elapsedMs \d+$/);
  }, 20_000);

  it("caps the timeout at 30 s and follows a nearer deadline", () => {
    expect(probeTimeoutMs(undefined, 1_000)).toBe(30_000);
    expect(probeTimeoutMs(1_000 + 90_000, 1_000)).toBe(30_000);
    expect(probeTimeoutMs(1_000 + 1_234, 1_000)).toBe(1_234);
    expect(probeTimeoutMs(500, 1_000)).toBe(0);
  });

  it("names exit, stage and the stderr tail last for codex (agent-catalog-unavailable)", async () => {
    const w = await codex({ exitCode: 4, stderr: "no catalog\n" });
    const error = await failure(readCodexCatalog(w.installation, {}));
    expect(error.message).toMatch(/^agent-catalog-unavailable: exit 4 · stage exit · elapsedMs \d+ · stderr: no catalog$/);
  });

  it("names a codex probe past its deadline as stage timeout", async () => {
    const w = await codex({ sleepMs: 5_000 });
    const error = await failure(readCodexCatalog(w.installation, { deadline: Date.now() + 400 }));
    expect(error.message).toMatch(/^agent-catalog-unavailable: timeout \d+ms · stage timeout · elapsedMs \d+$/);
  });

  // The version probe runs beside the catalog probe under the same caller (spec §4.3): an abort must stop it too, not
  // leave it running to its own 10 s limit. A hanging `--version` answers null well before that limit.
  it("stops the version probe when the caller aborts, before or during the run", async () => {
    const script = join(await realpath(await mkdtemp(join(tmpdir(), "ccloop-probe-version-"))), "hang.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n");
    const hang = [process.execPath, script];
    const controller = new AbortController(); setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    expect(await probeVersion(hang, { signal: controller.signal })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    const before = Date.now();
    expect(await probeVersion(hang, { signal: AbortSignal.abort() })).toBeNull();
    expect(Date.now() - before).toBeLessThan(3_000);
  });
});

describe("codex catalog decode (spec §3, §6.1)", () => {
  it("reads every row with its window and visibility, and the installed tool flags in order", async () => {
    const w = await codex();
    expect(await readCodexCatalog(w.installation, {})).toEqual({
      rows: [
        { selector: "gpt-6-sol", provider: "codex", contextWindow: 272000, maxTokens: null, listed: true },
        { selector: "gpt-6-luna", provider: "codex", contextWindow: 272000, maxTokens: null, listed: true },
        { selector: "gpt-reserve", provider: "codex", contextWindow: 272000, maxTokens: null, listed: false },
      ],
      features: ["apps", "image_generation", "multi_agent", "plugins", "shell_tool", "skip_host_skill_discovery", "unified_exec", "view_image"],
      // Ruling: rewritten under the human's blanket naming (Orca session a852f96a, 2026-10-16) -- Task 8 fix round 2 adds the
      // MCP server names (`codex mcp list --json`; the fake lists none by default) to the codex catalog read. Still exact.
      mcpServers: [],
    });
  });

  it("lets config.toml's top-level model_context_window win over the catalog, and ignores one inside a table", async () => {
    expect((await readCodexCatalog((await codex(undefined, "model = \"x\"\nmodel_context_window = 100000\n[profiles.a]\n")).installation, {})).rows[0]!.contextWindow).toBe(100000);
    expect((await readCodexCatalog((await codex(undefined, "[profiles.a]\nmodel_context_window = 100000\n")).installation, {})).rows[0]!.contextWindow).toBe(272000);
  });

  // codex-cli 0.160.0 prints `name<pad>stage<pad>enabled`, and a stage can be two words ("under development"); the name is
  // the first word and the enabled flag the last, never a fixed column count. A line without a true/false end is not a flag.
  it("takes each flag's name from the first word even when the stage is two words", () => {
    const listed = "apps                     stable              true\nskip_host_skill_discovery    under development    false\nWARNING: something odd\n\n";
    expect([...codexFeatureNames(listed)]).toEqual(["apps", "skip_host_skill_discovery"]);
  });

  it("refuses malformed rows as stage decode", async () => {
    const w = await codex({ rows: [{ slug: 3 }] });
    expect((await failure(readCodexCatalog(w.installation, {}))).message).toMatch(/^agent-catalog-unavailable: decode · stage decode · elapsedMs \d+$/);
  });
});
