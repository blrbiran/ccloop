import { chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentsCommand } from "../../src/agents/command.js";
import { main } from "../../src/cli.js";

async function root(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "ccloop-agents-command-")));
}

async function cli(dir: string, version: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "claude");
  await writeFile(path, `#!/bin/sh\necho "${version} (fake)"\n`, { mode: 0o700 });
  return path;
}

async function tableWith(r: string, installations: Record<string, unknown>): Promise<string> {
  const path = join(r, "agents.json");
  await writeFile(path, JSON.stringify({ schema: "ccloop-agents-table-v1", installations }), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

const record = (command: string, version: string) => ({ kind: "claude", command: [command], version, configDir: null, timeoutMs: 1000, killGraceMs: 50 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ccloop agents validate", () => {
  it("answers ok per installation and exits 0 only when every recorded version is what the CLI reports", async () => {
    const r = await root();
    const current = await cli(join(r, "a"), "2.1.282");
    const upgraded = await cli(join(r, "b"), "2.1.283");
    const good = await runAgentsCommand(["validate", await tableWith(r, { claude: record(current, "2.1.282") })]);
    expect(good).toEqual({ code: 0, stdout: `${JSON.stringify({ installations: [{ id: "claude", ok: true }] })}\n`, stderr: "" });
    const drifted = await runAgentsCommand(["validate", await tableWith(r, { claude: record(current, "2.1.282"), work: record(upgraded, "2.1.282") })]);
    expect(drifted.code).toBe(1);
    expect(JSON.parse(drifted.stdout)).toEqual({ installations: [{ id: "claude", ok: true }, { id: "work", ok: false, error: "agent-version-drift" }] });
  });

  it("names an unreadable table and prints nothing on stdout", async () => {
    const r = await root();
    const path = await tableWith(r, {});
    await chmod(path, 0o660);
    const result = await runAgentsCommand(["validate", path]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toBe("agents-table-invalid: table is group- or world-writable\n");
  });
});

describe("ccloop agents detect", () => {
  it("prints the detect result for the given home and PATH", async () => {
    const r = await root();
    const inHome = await cli(join(r, "home", ".local", "bin"), "2.1.282");
    const path = await cli(join(r, "bin"), "2.1.282");
    // The probe is injected so no real CLI on this machine runs; only the fake one answers a version.
    const result = await runAgentsCommand(["detect", "--home", join(r, "home"), "--path", join(r, "bin")], {
      probe: async (command) => (command[0] === path || command[0] === inHome ? "2.1.282" : null),
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.schema).toBe("ccloop-agents-detect-v1");
    expect(parsed.candidates.claude).toContainEqual({ path: inHome, realpath: inHome, version: "2.1.282", runnable: true, source: "search-dir", isPathDefault: false });
    expect(parsed.candidates.claude).toContainEqual({ path, realpath: path, version: "2.1.282", runnable: true, source: "path", isPathDefault: true });
    expect(parsed.table.installations.claude).toMatchObject({ command: [path], version: "2.1.282" });
  });

  it.each([[["detect", "--home"]], [["detect", "--shell", "zsh"]], [["validate"]], [["validate", "a", "b"]], [["list"]], [[]]])(
    "refuses %j as agents-command-invalid",
    async (argv) => {
      expect(await runAgentsCommand(argv)).toEqual({ code: 1, stdout: "", stderr: "agents-command-invalid\n" });
    },
  );
});

// Plan §0.2 P23 m7: `agents detect`/`agents validate` must never write under HOME or any of the four XDG roots,
// even when those are redirected to the sandbox's temp directories (as the real gate does).
describe("agents detect/validate write nothing under a redirected HOME or the XDG roots", () => {
  it("leaves HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME and XDG_CACHE_HOME untouched", async () => {
    const r = await root();
    const home = join(r, "home");
    const xdg = {
      XDG_CONFIG_HOME: join(r, "xdg-config"),
      XDG_DATA_HOME: join(r, "xdg-data"),
      XDG_STATE_HOME: join(r, "xdg-state"),
      XDG_CACHE_HOME: join(r, "xdg-cache"),
    };
    await mkdir(home, { recursive: true, mode: 0o700 });
    for (const dir of Object.values(xdg)) await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = await cli(join(r, "bin"), "2.1.282");
    const table = await tableWith(r, { claude: record(path, "2.1.282") });

    const saved: Record<string, string | undefined> = { HOME: process.env.HOME, ...Object.fromEntries(Object.keys(xdg).map((key) => [key, process.env[key]])) };
    process.env.HOME = home;
    Object.assign(process.env, xdg);
    try {
      const probe = async (command: string[]) => (command[0] === path ? "2.1.282" : null);
      const detected = await runAgentsCommand(["detect", "--path", join(r, "bin")], { probe });
      expect(detected.code).toBe(0);
      const validated = await runAgentsCommand(["validate", table], { probe });
      expect(validated.code).toBe(0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const dir of [home, ...Object.values(xdg)]) {
      expect(await readdir(dir, { recursive: true })).toEqual([]);
    }
  });
});

describe("the ccloop CLI entry", () => {
  it("routes `agents` to the agents command before run/resume flag parsing", async () => {
    const r = await root();
    const path = await cli(join(r, "bin"), "2.1.282");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["agents", "validate", await tableWith(r, { claude: record(path, "2.1.282") })])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({ installations: [{ id: "claude", ok: true }] })}\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["agents", "list"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith("agents-command-invalid\n");
  });
});
