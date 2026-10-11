import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";

const cliPath = resolve("src/cli.ts");

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-update-recovery-")));
  const binary = join(root, "fake-cli");
  await writeFile(binary, '#!/bin/sh\necho "2.1.283"\n', { mode: 0o700 });
  const path = join(root, "agents.json");
  const row = { kind: "claude", command: [binary, "--custom"], version: "2.1.282", configDir: root, timeoutMs: 1234, killGraceMs: 77 };
  await writeFile(path, JSON.stringify({ schema: "ccloop-agents-table-v1", installations: { custom: row } }), { mode: 0o600 });
  await chmod(path, 0o600);
  const previewResult = await runControlCommand(["agent-installation-preview", "--agents", path], "{}");
  expect(previewResult.code, previewResult.stderr).toBe(0);
  const preview = JSON.parse(previewResult.stdout);
  const change = preview.changes.find((entry: { kind: string; installationId: string }) => entry.kind === "version" && entry.installationId === "custom");
  expect(change).toBeDefined();
  const request = { opId: "op-recovery", requestDigest: "a".repeat(64), previewId: preview.previewId, baseTableHash: preview.baseTableHash, acceptedChangeIds: [change.changeId] };
  return { root, path, request };
}

async function subprocess(path: string, request: object, crash?: { point: string; marker: string }) {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, "control", "agent-installation-apply", "--agents", path], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(crash ? { NODE_ENV: "test", CCLOOP_CONTROL_TEST_CRASH_POINT: crash.point, CCLOOP_CONTROL_TEST_CRASH_MARKER: crash.marker } : {}) },
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(JSON.stringify(request));
  if (crash) {
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await stat(crash.marker); break; }
      catch { if (Date.now() >= deadline) throw new Error(`crash marker missing: ${stderr}`); await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    child.kill("SIGKILL");
  }
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("close", resolveExit); });
  return { code, stdout, stderr };
}

describe("durable installation update operation", { timeout: 30_000 }, () => {
  it("serializes two separate process writers so exactly one succeeds", async () => {
    const f = await setup();
    const other = { ...f.request, opId: "op-other", requestDigest: "b".repeat(64) };
    const results = await Promise.all([subprocess(f.path, f.request), subprocess(f.path, other)]);
    expect(results.map((result) => result.code).sort(), JSON.stringify(results)).toEqual([0, 2]);
    expect(results.find((result) => result.code === 2)?.stderr).toContain("agent-installation-update-stale");
  });

  it.each(["before-rename", "temp-fsynced", "after-rename", "after-receipt"])("recovers the same receipt after a crash %s", async (point) => {
    const f = await setup();
    const marker = join(f.root, "crash-marker");
    const crashed = await subprocess(f.path, f.request, { point: `agent-update-${point}`, marker });
    expect(crashed.code).not.toBe(0);
    const replay = await runControlCommand(["agent-installation-apply", "--agents", f.path], JSON.stringify(f.request));
    expect(replay.code, replay.stderr).toBe(0);
    const receipt = JSON.parse(replay.stdout);
    expect(receipt.after.installations.custom.version).toBe("2.1.283");
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(`${f.path}.updates`)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await runControlCommand(["agent-installation-apply", "--agents", f.path], JSON.stringify(f.request))).toEqual(replay);
  });

  it("refuses a third table state during same-operation recovery", async () => {
    const f = await setup();
    await subprocess(f.path, f.request, { point: "agent-update-after-rename", marker: join(f.root, "crash-marker") });
    const table = JSON.parse(await readFile(f.path, "utf8"));
    table.installations.custom.version = "9.9.9";
    await writeFile(f.path, JSON.stringify(table), { mode: 0o600 });
    const replay = await runControlCommand(["agent-installation-apply", "--agents", f.path], JSON.stringify(f.request));
    expect(replay.code).toBe(2);
    expect(replay.stderr).toContain("agent-installation-update-conflict");
  });

  it("lets two processes recover one crashed operation through the stale lock and return one receipt", async () => {
    const f = await setup();
    await subprocess(f.path, f.request, { point: "agent-update-after-rename", marker: join(f.root, "crash-marker") });
    const recovered = await Promise.all([subprocess(f.path, f.request), subprocess(f.path, f.request)]);
    expect(recovered.map((result) => result.code)).toEqual([0, 0]);
    expect(recovered[0]!.stdout).toBe(recovered[1]!.stdout);
  });
});
