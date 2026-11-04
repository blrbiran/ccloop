import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { runLoop } from "../../src/controller/runLoop.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { createContract, createRepo } from "./optionalFixture.js";

// Final-review M2 ruling, the other half: a setup command stopped by its own cap (15 minutes in production, shortened
// here so a test can reach it) is the setup's failure, `<cmd> timeout`, not the attempt out of time -- the attempt had
// time left, so the cap is what the operator must raise or the command what they must fix.
vi.mock("../../src/controller/setupCommands.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/controller/setupCommands.js")>();
  return {
    ...real,
    runSetupCommands: (...args: Parameters<typeof real.runSetupCommands>) =>
      real.runSetupCommands(args[0], args[1], args[2], args[3], args[4], { ...args[5], commandTimeoutMs: 300 }),
  };
});

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("a setup command stopped by its cap ends the run setup-failed naming the timeout", async () => {
  const repo = await createRepo();
  dirs.push(repo);
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  await execFileAsync("git", ["add", ".gitignore"], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "ignores"], { cwd: repo });
  const runDir = await mkdtemp(join(tmpdir(), "ccloop-setup-cap-"));
  dirs.push(runDir);
  const contract = createContract(repo, ["true"]);
  contract.context.setupCommands = ["sleep 5"];
  let calls = 0;
  const adapter = new ScriptedAdapter([]);
  adapter.plan = async () => { calls += 1; throw new Error("plan should not run"); };
  await runLoop(contract, runDir, adapter);
  const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8"));
  expect(calls).toBe(0);
  expect(persisted.status).toBe("failed");
  expect(persisted.failureCause).toEqual({ cause: "setup-failed", phase: "setup", retries: 0, detail: "sleep 5 timeout" });
});
