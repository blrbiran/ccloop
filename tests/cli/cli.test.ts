import { mkdtemp, writeFile } from "node:fs/promises";
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
