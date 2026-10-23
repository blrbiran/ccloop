// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.3, §11.5, §16.1 C13; review 1): omp's own check compares
// the reported changedFiles with `git status` of the primary worktree. The executor prompt keeps changedFiles relative to
// the working directory, so an omp that changes one primary file and one extra-repo file, reporting only the primary
// one, passes that check; the extra-repo change reaches collect's `dirs` through ccloop's own observation.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../../src/control/collect.js";
import type { LoopStartEnvelope } from "../../../src/control/protocol.js";
import { runLoop } from "../../../src/controller/runLoop.js";
import { OmpAdapter } from "../../../src/runtime/omp/ompAdapter.js";
import { createKeyedRepo, git } from "../../controller/multiRepoFixture.js";
import { fixture } from "../../control/optionalFixture.js";
import { ompInstallation } from "../../fixtures/toolRules/argvCapture.js";

const FAKE = fileURLToPath(new URL("../../fixtures/fake-omp-multi.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("omp with an extra repository (C13)", () => {
  it("reports only the primary's path, passes omp's changed-files check, and the extra change is in collect's dirs", async () => {
    const { root, envelope } = await fixture(); dirs.push(root);
    const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-multi-run-"))); dirs.push(dir);
    const primary = await createKeyedRepo("app"), lib = await createKeyedRepo("lib");
    dirs.push(primary, lib);
    await writeFile(join(primary, "answer.txt"), "0\n");
    await git(primary, "add", "answer.txt");
    await git(primary, "commit", "-m", "answer");
    const marker = join(dir, "marker"), runDir = join(root, "run");
    const installation = await ompInstallation({ dir, marker } as never);
    await writeFile(join(dir, "omp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${JSON.stringify(marker)} "$@"\n`, { mode: 0o700 });
    await writeFile(`${marker}.multi.json`, JSON.stringify({ extraWrites: [{ dir: join(runDir, "dirs", "attempt-1", "lib"), path: "lib/extra.txt" }] }));
    const contract = { ...envelope.work.contract,
      context: { ...envelope.work.contract.context, repoPath: primary, targetPaths: ["answer.txt"], repoKey: "app",
        additionalRepos: [{ key: "lib", repoPath: lib, targetPaths: ["lib/**"] }] },
      safetyPolicy: { ...envelope.work.contract.safetyPolicy, allowlistPaths: ["answer.txt"] },
      verification: { ...envelope.work.contract.verification, requiredChecks: ["test -f answer.txt"] },
      executionPolicy: { ...envelope.work.contract.executionPolicy, maxAttempts: 1, perAttemptTimeoutMs: 20_000, totalRuntimeBudgetMs: 60_000, tokenBudget: 100_000 } };

    const state = await runLoop(contract, runDir, new OmpAdapter(installation as never));
    expect({ status: state.status, stopReason: state.stopReason }).toEqual({ status: "succeeded", stopReason: "success condition satisfied" });
    const input = { ...envelope, work: { ...envelope.work, contract, additionalRepos: [{ key: "lib", targetRepo: lib, base: "HEAD" }] } } as LoopStartEnvelope;
    expect((await collectExecution(input, 0)).dirs).toEqual([{ key: "lib", resultRepo: "repos/lib", changedPaths: ["lib/extra.txt"] }]);
  }, 60_000);
});
