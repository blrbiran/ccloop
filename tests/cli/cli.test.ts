import { describe, expect, it } from "vitest";
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
});
