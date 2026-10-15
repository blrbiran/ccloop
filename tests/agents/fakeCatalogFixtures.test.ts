import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Every-agent requirement chain (Orca spec 2026-10-15 §9): the fakes answer the catalog commands, count every catalog and
// version spawn in files of their own (criterion 1 reads the count), and never log a catalog call as a phase call.
const FAKE_CODEX = resolve("tests/fixtures/fake-codex.mjs");
const FAKE_OMP = resolve("tests/fixtures/fake-omp.mjs");
const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "ccloop-fake-catalog-")));
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : []);

describe("fake catalog answers (spec 2026-10-15 §9)", () => {
  it("fake codex answers debug models and features list, counts them, and leaves argv and calls alone", () => {
    const marker = join(dir(), "codex-marker");
    const models = spawnSync(process.execPath, [FAKE_CODEX, "integration", marker, "debug", "models"], { encoding: "utf8" });
    expect(models.status).toBe(0);
    expect(JSON.parse(models.stdout).models.map((row: { slug: string; context_window: number; visibility: string }) => [row.slug, row.context_window, row.visibility]))
      .toEqual([["gpt-6-sol", 272000, "list"], ["gpt-6-luna", 272000, "list"], ["gpt-reserve", 272000, "hide"]]);
    const features = spawnSync(process.execPath, [FAKE_CODEX, "integration", marker, "features", "list"], { encoding: "utf8" });
    expect(features.status).toBe(0);
    expect(features.stdout.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0]))
      .toEqual(["apps", "browser_use", "image_generation", "multi_agent", "plugins", "shell_tool", "skip_host_skill_discovery", "unified_exec", "view_image"]);
    spawnSync(process.execPath, [FAKE_CODEX, "integration", marker, "--version"], { encoding: "utf8" });
    expect(lines(`${marker}.catalog-calls`)).toEqual(["debug-models", "features-list"]);
    expect(lines(`${marker}.version-calls`)).toEqual(["version"]);
    expect(existsSync(`${marker}.argv`)).toBe(false);
    expect(existsSync(`${marker}.calls`)).toBe(false);
  });

  it("fake codex obeys <marker>.catalog.json: rows, exit code with stderr, and a sleep", () => {
    const marker = join(dir(), "codex-marker");
    writeFileSync(`${marker}.catalog.json`, JSON.stringify({ rows: [{ slug: "only", context_window: 1000, visibility: "list" }] }));
    expect(JSON.parse(spawnSync(process.execPath, [FAKE_CODEX, "integration", marker, "debug", "models"], { encoding: "utf8" }).stdout).models)
      .toEqual([{ slug: "only", context_window: 1000, visibility: "list" }]);
    writeFileSync(`${marker}.catalog.json`, JSON.stringify({ exitCode: 4, stderr: "no catalog\n" }));
    const failed = spawnSync(process.execPath, [FAKE_CODEX, "integration", marker, "debug", "models"], { encoding: "utf8" });
    expect([failed.status, failed.stderr]).toEqual([4, "no catalog\n"]);
    writeFileSync(`${marker}.catalog.json`, JSON.stringify({ sleepMs: 400 }));
    const started = Date.now();
    spawnSync(process.execPath, [FAKE_CODEX, "integration", marker, "debug", "models"], { encoding: "utf8" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("fake omp counts models and version calls, records the models pid, and sleeps on request", () => {
    const marker = join(dir(), "omp-marker");
    spawnSync(process.execPath, [FAKE_OMP, marker, "--no-extensions", "--profile", "default", "models", "--json"], { encoding: "utf8" });
    spawnSync(process.execPath, [FAKE_OMP, marker, "--version"], { encoding: "utf8" });
    expect(lines(`${marker}.catalog-calls`)).toEqual(["models"]);
    expect(lines(`${marker}.version-calls`)).toEqual(["version"]);
    expect(Number(readFileSync(`${marker}.models.pid`, "utf8"))).toBeGreaterThan(0);
    writeFileSync(`${marker}.models.json`, JSON.stringify({ sleepMs: 400 }));
    const started = Date.now();
    const slow = spawnSync(process.execPath, [FAKE_OMP, marker, "models", "--json"], { encoding: "utf8" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(slow.stdout).models[0].selector).toBe("gateway/model-a");
  });
});
