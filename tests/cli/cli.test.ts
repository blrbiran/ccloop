import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../../src/cli.js";

describe("parseArgs", () => {
  it("parses the run command", () => {
    expect(
      parseArgs([
        "run",
        "--contract",
        "examples/v1/minimal-contract.json",
        "--run-dir",
        ".runs/demo",
        "--adapter",
        "scripted",
        "--adapter-config",
        "examples/v1/scripted-adapter-config.json",
      ]),
    ).toEqual({
      command: "run",
      contractPath: "examples/v1/minimal-contract.json",
      runDir: ".runs/demo",
      adapter: "scripted",
      adapterConfigPath: "examples/v1/scripted-adapter-config.json",
    });
  });

  it("returns exit code 1 when required flags are missing", async () => {
    await expect(main(["run"])).resolves.toBe(1);
  });

  it("returns 0 for the scripted example run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cli-scripted-"));

    await expect(
      main([
        "run",
        "--contract",
        "examples/v1/minimal-contract.json",
        "--run-dir",
        runDir,
        "--adapter",
        "scripted",
        "--adapter-config",
        "examples/v1/scripted-adapter-config.json",
      ]),
    ).resolves.toBe(0);
  });
});

describe("parseArgs resume", () => {
  it("parses a resume command", () => {
    const parsed = parseArgs(["resume", "--run-dir", "/tmp/run", "--adapter", "scripted", "--adapter-config", "/tmp/cfg.json"]);
    expect(parsed).toEqual({ command: "resume", runDir: "/tmp/run", adapter: "scripted", adapterConfigPath: "/tmp/cfg.json" });
  });

  it("still parses a run command", () => {
    const parsed = parseArgs(["run", "--contract", "/c.json", "--run-dir", "/r", "--adapter", "scripted", "--adapter-config", "/a.json"]);
    expect(parsed.command).toBe("run");
  });

  it("prints the refusal reason to stderr when resume is refused (spec §9)", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cli-resume-empty-"));
    const adapterConfigPath = join(runDir, "adapter-config.json");
    await writeFile(adapterConfigPath, JSON.stringify({ frames: [] }));

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await main(["resume", "--run-dir", runDir, "--adapter", "scripted", "--adapter-config", adapterConfigPath]);
      expect(code).toBe(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("cannot read run artifacts"));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("parseArgs ls", () => {
  it("parses a positional root with no --json flag", () => {
    expect(parseArgs(["ls", "/tmp/some-root"])).toEqual({
      command: "ls",
      root: "/tmp/some-root",
      json: false,
    });
  });

  it("parses --json", () => {
    expect(parseArgs(["ls", "/tmp/some-root", "--json"])).toEqual({
      command: "ls",
      root: "/tmp/some-root",
      json: true,
    });
  });

  // Finding: `ls --json <root>` (flag before the positional root) is a normal invocation and
  // must not be misparsed as root === "--json".
  it("parses --json before the positional root", () => {
    expect(parseArgs(["ls", "--json", "/tmp/some-root"])).toEqual({
      command: "ls",
      root: "/tmp/some-root",
      json: true,
    });
  });

  // Trap named in the task brief: `ls` must not require --adapter, --adapter-config, or
  // --contract the way `run`/`resume` do.
  it("does not require --adapter, --adapter-config, or --contract", () => {
    expect(() => parseArgs(["ls", "/tmp/some-root"])).not.toThrow();
  });

  it("throws when the root argument is missing", () => {
    expect(() => parseArgs(["ls"])).toThrow();
  });
});

describe("main ls (spec §9, §12.8)", () => {
  it("exits 1 when the root does not exist — the scan itself failed", async () => {
    const missingRoot = join(await mkdtemp(join(tmpdir(), "ccloop-ls-missing-")), "does-not-exist");
    await expect(main(["ls", missingRoot])).resolves.toBe(1);
  });

  it("exits 0 for a scan that produces an unreadable row, never 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-damaged-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    // Malformed JSON: parse failure survives the bounded re-read and is reported as an
    // `unreadable(parse)` field, not a command failure (spec §8.1, §9).
    await writeFile(join(runDir, "loop-state.json"), "{not valid json");

    const code = await main(["ls", root]);
    expect(code).toBe(0);
    expect(code).not.toBe(2);
  });

  it("emits a parseable ScanResult with schemaVersion 1 under --json", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-json-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["ls", root, "--json"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = logSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(printed);
      expect(parsed.schemaVersion).toBe(1);
      expect(Array.isArray(parsed.rows)).toBe(true);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].path).toBe(runDir);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints the human table by default, including the independent-observation notice", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-table-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["ls", root]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]![0] as string;
      expect(printed).toContain(runDir);
      expect(printed).toMatch(/independent observation/i);
    } finally {
      logSpy.mockRestore();
    }
  });
});
