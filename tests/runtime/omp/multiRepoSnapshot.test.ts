// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.3 last bullet, §16.1 C9): omp's read-only phases are
// checked for mutation in every worktree, not only the primary; the evidence names the extra repository's key.
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { createKeyedRepo, git } from "../../controller/multiRepoFixture.js";
import { ompInstallation, RAW_CONTRACT } from "../../fixtures/toolRules/argvCapture.js";
import { loopContractSchema } from "../../../src/contract/schema.js";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-omp-multi.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A primary repo and an extra repo, the fake-omp-multi installation, and a plan context naming the extra worktree. */
async function ompMultiWorld() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-multi-"))); dirs.push(dir);
  const primary = await createKeyedRepo("app"), lib = await createKeyedRepo("lib");
  dirs.push(primary, lib);
  const marker = join(dir, "marker"), runDir = join(dir, "run");
  const installation = await ompInstallation({ dir, marker } as never);
  await writeFile(join(dir, "omp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${JSON.stringify(marker)} "$@"\n`, { mode: 0o700 });
  const contract = loopContractSchema.parse(structuredClone(RAW_CONTRACT));
  const context = { contract, runDir, attempt: 1, worktreePath: primary, extraWorktrees: [{ key: "lib", worktreePath: lib, targetPaths: ["lib/**"], requiredChecks: [] }],
    state: { status: "planning", currentAttempt: 1, attemptsUsed: 1, lastTransitionAt: "2026-10-24T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
      budgetSnapshot: { attemptsRemaining: 0, timeRemainingMs: 60000, tokenBudgetRemaining: 100000 }, recentFailures: [] } };
  return { dir, marker, runDir, primary, lib, installation, context };
}

describe("omp read-only phases in every worktree (C9)", () => {
  it("a plan-phase write in an extra worktree is the read-only mutation failure, with the key in the evidence", async () => {
    const w = await ompMultiWorld();
    await writeFile(`${w.marker}.multi.json`, JSON.stringify({ planWrite: join(w.lib, "lib", "planned.txt") }));
    const error = await new OmpAdapter(w.installation as never).plan(w.context as never).then(() => null, (failure: unknown) => failure);
    expect(String(error)).toContain("omp-read-only-phase-mutated");
    const root = join(w.runDir, "omp", "1", "plan");
    const [call] = (await readdir(root)).filter((name) => name.startsWith("call-"));
    expect(JSON.parse(await readFile(join(root, call!, "worktree-mutation.json"), "utf8"))).toMatchObject({ key: "lib" });
    expect(await git(w.lib, "status", "--porcelain")).toBe("?? lib/planned.txt");
  }, 30_000);

  it("a plan phase that writes nothing passes", async () => {
    const w = await ompMultiWorld();
    await expect(new OmpAdapter(w.installation as never).plan(w.context as never)).resolves.toMatchObject({ summary: "Set answer to 42" });
  }, 30_000);
});
