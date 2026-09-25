import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { runCodexPhase } from "../../../src/runtime/codex/runCodexPhase.js";
import { codexFixture } from "./fixture.js";

// Orca agent selection (2026-09-26), spec §4.8: fake codex also appends each call's codex arguments to
// `<marker>.argv` and answers `--version`, so the mixed-agent E2E can see each selection reach its CLI and
// ccloop can probe the fake's version. The marker file itself keeps being overwritten as before.
const fake = fileURLToPath(new URL("../../fixtures/fake-codex.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("fake codex .argv and --version (Orca agent selection)", () => {
  it("appends one JSON array line per call, from `exec` on, including the model", async () => {
    const f = await codexFixture("ok");
    dirs.push(f.dir);
    for (const phase of ["plan", "verify"] as const) {
      expect((await runCodexPhase(parseCodexConfig({ ...f.config, model: `model-${phase}` }), { phase, prompt: "p", context: f.context })).reason).toBe("completed");
    }
    const lines = (await readFile(`${f.marker}.argv`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines).toHaveLength(2);
    expect(lines.map((argv) => argv[0])).toEqual(["exec", "exec"]);
    expect(lines.map((argv) => argv[argv.indexOf("--model") + 1])).toEqual(["model-plan", "model-verify"]);
    expect(JSON.parse(await readFile(f.marker, "utf8")).args).toEqual(lines[1]!.slice(1));
  });

  it("answers --version and writes nothing", async () => {
    const f = await codexFixture("script");
    dirs.push(f.dir);
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [fake, "script", f.marker, `${f.dir}/script.json`, "--version"], { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
    });
    expect(result).toEqual({ code: 0, stdout: "9.9.9-fake\n" });
    for (const suffix of ["", ".argv", ".calls", ".tasks"]) expect(existsSync(`${f.marker}${suffix}`)).toBe(false);
  });
});
