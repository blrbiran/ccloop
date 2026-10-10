import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeAttemptArtifacts } from "../../src/persistence/fileStore.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
// Break: serializing optional unknown metadata directly can discard valid execution evidence entirely.
it("persists real execution evidence even when optional metadata cannot be serialized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-result-persist-")); dirs.push(dir);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  await writeAttemptArtifacts(dir, 1, {
    plan: { summary: "Set answer", primaryTargetPaths: ["answer.txt"] },
    execution: { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "log", taskResult: cycle, tokenUsage: 15 } as never,
  });
  const saved = JSON.parse(await readFile(join(dir, "attempts", "1", "execution.json"), "utf8"));
  expect(saved).toMatchObject({ changedFiles: ["answer.txt"], diffPatch: "patch", stdoutStderrLog: "log", tokenUsage: 15 });
  expect(saved.taskResult.schema).toBe("ccloop-task-result-invalid-v1");
});
