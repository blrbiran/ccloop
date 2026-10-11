import { chmod, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import { applyAgentInstallations, previewAgentInstallations } from "../../src/agents/updates.js";
import { assertUpdatesRoot, replaceTableDurably } from "../../src/agents/updateReceipt.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agent-updates-")));
  const cli = join(root, "fake-cli");
  await writeFile(cli, '#!/bin/sh\n[ "$1" = "--custom" ] && [ "$2" = "--version" ] && echo "2.1.283"\n', { mode: 0o700 });
  const path = join(root, "agents.json");
  const row = { kind: "claude", command: [cli, "--custom"], version: "2.1.282", configDir: join(root, "config"), timeoutMs: 1234, killGraceMs: 77 };
  await writeFile(path, JSON.stringify({ schema: "ccloop-agents-table-v1", installations: { custom: row, alias: { ...row, version: "2.1.283" } } }), { mode: 0o600 });
  await chmod(path, 0o600);
  return { root, path, cli, row };
}

async function control(method: string, path: string, payload: object = {}) {
  return runControlCommand([method, "--agents", path], JSON.stringify(payload));
}

describe("configured installation updates", () => {
  it("refuses a table changed after the replacement temporary file was written", async () => {
    const f = await fixture();
    const expected = await readFile(f.path);
    const third = { schema: "ccloop-agents-table-v1", installations: { custom: { ...f.row, version: "9.9.9" } } };
    await writeFile(f.path, JSON.stringify(third), { mode: 0o600 });
    const root = await assertUpdatesRoot(f.path, true);
    await expect(replaceTableDurably(f.path, root, expected, expected, 0o600, "stale-test", "e".repeat(64))).rejects.toMatchObject({ code: "agent-installation-update-stale" });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(third);
  });
  it("refuses a malformed observation response before printing it", async () => {
    const f = await fixture();
    expect(await runControlCommand(["agent-installation-observe", "--agents", f.path], "{}", { handle: async () => ({ arbitrary: true }) })).toEqual({ code: 1, stdout: "", stderr: "control-response-invalid\n" });
  });
  it("rejects payload-owned table paths and shell commands", async () => {
    const f = await fixture();
    expect((await control("agent-installation-observe", f.path, { tablePath: join(f.root, "other.json") })).code).toBe(2);
    expect((await control("agent-installation-preview", f.path, { shell: "echo unsafe" })).code).toBe(2);
    expect((await control("agent-installation-apply", f.path, { opId: "x", requestDigest: "a".repeat(64), previewId: "p", baseTableHash: "b".repeat(64), acceptedChangeIds: ["c"], command: ["/bin/sh"] })).code).toBe(2);
  });
  it("offers a new path as a separate choice and re-probes its exact argv before applying", async () => {
    const f = await fixture();
    const alternateDir = join(f.root, "alternate");
    await (await import("node:fs/promises")).mkdir(alternateDir);
    const alternate = join(alternateDir, "claude");
    await writeFile(alternate, '#!/bin/sh\necho "2.1.284"\n', { mode: 0o700 });
    const preview = await previewAgentInstallations(f.path, { home: f.root, path: alternateDir, probe: async (command) => command[0] === alternate ? "2.1.284" : "2.1.283" });
    const pathChoice = preview.changes.find((change) => change.kind === "path" && change.installationId === "custom" && change.command[0] === alternate);
    expect(pathChoice).toBeDefined();
    expect(preview.changes.some((change) => change.kind === "version" && change.installationId === "custom")).toBe(true);
    const request = { opId: "path-choice", requestDigest: "c".repeat(64), previewId: preview.previewId, baseTableHash: preview.baseTableHash, acceptedChangeIds: [pathChoice!.changeId] };
    await expect(applyAgentInstallations(f.path, request, { probe: async () => "9.9.9" })).rejects.toMatchObject({ code: "agent-installation-update-stale" });
    expect(JSON.parse(await readFile(f.path, "utf8")).installations.custom).toEqual(f.row);
    const receipt = await applyAgentInstallations(f.path, request, { probe: async () => "2.1.284" });
    expect(receipt.after.installations.custom).toEqual({ ...f.row, command: [alternate, "--custom"], version: "2.1.284" });
    expect(receipt.after.installations.alias).toEqual({ ...f.row, version: "2.1.283" });
  });
  it("offers a discovered installation only as an explicit addition choice", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-agent-addition-")));
    const binary = join(root, "claude");
    const path = join(root, "agents.json");
    await writeFile(binary, '#!/bin/sh\necho "2.1.283"\n', { mode: 0o700 });
    await writeFile(path, JSON.stringify({ schema: "ccloop-agents-table-v1", installations: {} }), { mode: 0o600 });
    const original = await readFile(path);
    const preview = await previewAgentInstallations(path, { home: root, path: root, probe: async (command) => command[0] === binary ? "2.1.283" : null });
    const addition = preview.changes.find((change) => change.kind === "addition" && change.installationId === "claude" && change.command[0] === binary);
    expect(addition).toBeDefined();
    expect(await readFile(path)).toEqual(original);
    const receipt = await applyAgentInstallations(path, { opId: "addition", requestDigest: "d".repeat(64), previewId: preview.previewId, baseTableHash: preview.baseTableHash, acceptedChangeIds: [addition!.changeId] }, { probe: async () => "2.1.283" });
    expect(receipt.after.installations.claude.command).toEqual(addition!.command);
    expect(receipt.after.installations.claude.version).toBe("2.1.283");
  });
  it("observes without writing, then applies only an accepted version change and replays the receipt", async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    const observed = await control("agent-installation-observe", f.path);
    expect(observed.code).toBe(0);
    const observation = JSON.parse(observed.stdout);
    expect(observation.installed).toContainEqual(expect.objectContaining({ id: "custom", recordedVersion: "2.1.282", observedVersion: "2.1.283", status: "changed" }));
    expect(await readFile(f.path)).toEqual(before);
    expect(await readdir(f.root)).toEqual(["agents.json", "fake-cli"]);

    const previewResult = await control("agent-installation-preview", f.path);
    expect(previewResult.code).toBe(0);
    const preview = JSON.parse(previewResult.stdout);
    const change = preview.changes.find((entry: { installationId?: string; kind?: string }) => entry.installationId === "custom" && entry.kind === "version");
    expect(change).toBeDefined();
    expect(await readFile(f.path)).toEqual(before);

    const request = { opId: "operation-1", requestDigest: "a".repeat(64), previewId: preview.previewId, baseTableHash: preview.baseTableHash, acceptedChangeIds: [change.changeId] };
    const applied = await control("agent-installation-apply", f.path, request);
    expect(applied.code).toBe(0);
    const receipt = JSON.parse(applied.stdout);
    expect(receipt.beforeHash).toBe(preview.baseTableHash);
    expect(receipt.afterHash).not.toBe(receipt.beforeHash);
    expect(receipt.before.installations.custom).toEqual(f.row);
    expect(receipt.after.installations.custom).toEqual({ ...f.row, version: "2.1.283" });
    expect(receipt.after.installations.alias).toEqual({ ...f.row, version: "2.1.283" });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(await control("agent-installation-apply", f.path, request)).toEqual(applied);
    const changed = await control("agent-installation-apply", f.path, { ...request, requestDigest: "b".repeat(64) });
    expect(changed.code).toBe(2);
  });
});
