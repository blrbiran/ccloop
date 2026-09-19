import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { proveStopped, type StopProofRecord } from "../../src/control/stopProof.js";

const execFileAsync = promisify(execFile);
const fixturePath = resolve("tests/fixtures/process-tree.mjs");
const groups = new Set<number>();

async function waitForRows(path: string, count: number): Promise<Array<{ role: string; pid: number }>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const rows = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (rows.length >= count) return rows;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("process tree marker timeout");
}

async function stoppedFixture(): Promise<{ record: StopProofRecord; sourceDir: string }> {
  const sourceDir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-stop-proof-")));
  await mkdir(join(sourceDir, "control"));
  await mkdir(join(sourceDir, "run"));
  await writeFile(join(sourceDir, "run", "owner-record.json"), JSON.stringify({
    runId: "task-1",
    logicalSessionId: "session-1",
    currentOwnerEpoch: 1,
    currentProcessInstanceId: "process-1",
    lastAffirmedAt: new Date().toISOString(),
    ownerStatus: "current",
    supersededByEpoch: null,
    leaseAffirmedAt: null,
  }));
  return {
    sourceDir,
    record: {
      sourceDir,
      accepted: {
        protocol: 1,
        envelopeHash: "a".repeat(64),
        executionId: "execution-1",
        configHash: "b".repeat(64),
        generation: 2,
        acceptedAt: new Date().toISOString(),
        launch: "sealed",
        worker: { pid: process.pid, startedAt: new Date().toISOString(), nonce: "nonce-1" },
      },
    },
  };
}

afterEach(() => {
  for (const pgid of groups) {
    try { process.kill(-pgid, "SIGKILL"); } catch {}
  }
  groups.clear();
});

describe("quiet execution proof", () => {
  it("does not treat leader exit as group quiet and proves only after the full tree is gone", async () => {
    const f = await stoppedFixture();
    const marker = join(f.sourceDir, "tree.jsonl");
    const leader = spawn(process.execPath, [fixturePath, "leader", marker], { detached: true, stdio: "ignore" });
    const pgid = leader.pid!;
    groups.add(pgid);
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pgid)], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
    await waitForRows(marker, 3);
    await new Promise<void>((resolveExit) => leader.once("exit", () => resolveExit()));
    await writeFile(join(f.sourceDir, "control", "processes.json"), JSON.stringify([{ pid: pgid, pgid, startedAt: stdout.trim(), phase: "execute", registeredAt: new Date().toISOString() }]));

    expect(await proveStopped(f.record, { graceMs: 20 })).toBeNull();
    process.kill(-pgid, "SIGKILL");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    const proof = await proveStopped(f.record, { graceMs: 20 });
    expect(proof).toMatchObject({ executionId: "execution-1", generation: 2, isolated: true });
    expect(proof?.source.artifactId).toMatch(/^evidence-/);
    groups.delete(pgid);
  });

  it("requires a sealed worker and released owner lease", async () => {
    const f = await stoppedFixture();
    await writeFile(join(f.sourceDir, "control", "processes.json"), "[]\n");
    expect(await proveStopped({ ...f.record, accepted: { ...f.record.accepted, launch: "claimed" } }, { graceMs: 0 })).toBeNull();
    const owner = JSON.parse(await readFile(join(f.sourceDir, "run", "owner-record.json"), "utf8"));
    await writeFile(join(f.sourceDir, "run", "owner-record.json"), JSON.stringify({ ...owner, leaseAffirmedAt: new Date().toISOString() }));
    expect(await proveStopped(f.record, { graceMs: 0 })).toBeNull();
  });

  it("requires two quiet probes and treats permission/identity uncertainty as unknown", async () => {
    const f = await stoppedFixture();
    await writeFile(join(f.sourceDir, "control", "processes.json"), JSON.stringify([{ pid: 123, pgid: 123, startedAt: "start", phase: "plan", registeredAt: new Date().toISOString() }]));
    let calls = 0;
    expect(await proveStopped(f.record, {
      graceMs: 0,
      probeGroup: async () => (++calls === 1 ? "quiet" : "alive"),
    })).toBeNull();
    expect(calls).toBe(2);
    expect(await proveStopped(f.record, { graceMs: 0, probeGroup: async () => "unknown" })).toBeNull();
  });
});
