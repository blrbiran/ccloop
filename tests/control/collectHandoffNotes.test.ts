// Task handoffs and live notes in collect (Orca spec 2026-11-12 tester follow-up G §10.2, Part 5). Orca ingests a run's
// handoff from its own output directory and must know, from ccloop, whether the agent left the two files; it learns which
// notes reached the agent from ccloop's acknowledgements. Both keys appear only with their trigger (work.handoff; the ack
// file), so every collect answer Orca reads today is byte-identical, and Orca's strict collect schema sees them only for
// runs that opted in. A symlink is never reported as a handoff file Orca could copy.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExecution } from "../../src/control/collect.js";
import { runControlCommand } from "../../src/control/command.js";
import { LIVE_NOTES_DELIVERED_FILE } from "../../src/control/liveNotes.js";
import type { LoopStartEnvelope } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function world(withHandoff: boolean): Promise<{ root: string; envelope: LoopStartEnvelope; outputDir: string }> {
  const { root, envelope } = await fixture();
  roots.push(root);
  const dirs = await realpath(await mkdtemp(join(tmpdir(), "collect-handoff-")));
  roots.push(dirs);
  const inputDir = join(dirs, "in"), outputDir = join(dirs, "out");
  await mkdir(inputDir); await mkdir(outputDir);
  return { root, outputDir, envelope: withHandoff ? { ...envelope, work: { ...envelope.work, handoff: { inputDir, outputDir } } } : envelope };
}

describe("collect: handoffFiles and liveNotes", () => {
  it("an envelope without handoff and no ack file: the collection has neither key", async () => {
    const { envelope } = await world(false);
    const collection = await collectExecution(envelope, 0);
    expect(Object.keys(collection)).not.toContain("handoffFiles");
    expect(Object.keys(collection)).not.toContain("liveNotes");
  });

  it("reports presence and bytes; a symlink is not present; a removed outputDir is two absences", async () => {
    const { root, envelope, outputDir } = await world(true);
    await writeFile(join(outputDir, "handoff.md"), "hello world");
    await writeFile(join(root, "elsewhere.md"), "secret");
    await symlink(join(root, "elsewhere.md"), join(outputDir, "summary.md"));
    expect((await collectExecution(envelope, 0)).handoffFiles).toEqual({ handoff: { present: true, bytes: 11 }, summary: { present: false, bytes: null } });
    await rm(outputDir, { recursive: true });
    expect((await collectExecution(envelope, 0)).handoffFiles).toEqual({ handoff: { present: false, bytes: null }, summary: { present: false, bytes: null } });
  });

  it("reports the ack file's deliveries, and both keys pass the strict collect answer schema", async () => {
    const { root, envelope, outputDir } = await world(true);
    await writeFile(join(outputDir, "summary.md"), "S\n");
    const delivered = [{ id: "n1", phase: "plan", attempt: 1, at: "2026-11-12T10:00:00.000Z" }];
    await mkdir(join(root, "run"), { mode: 0o700 });
    await writeFile(join(root, "run", LIVE_NOTES_DELIVERED_FILE), JSON.stringify({ schema: "ccloop-live-notes-delivered-v1", delivered }), { mode: 0o600 });
    const result = await runControlCommand(["collect", "--agents", join(root, "absent-agents.json")], JSON.stringify({ input: envelope, afterSeq: 0 }));
    expect(result.code, result.stderr).toBe(0);
    const collected = JSON.parse(result.stdout);
    expect(collected.liveNotes).toEqual({ delivered });
    expect(collected.handoffFiles).toEqual({ handoff: { present: false, bytes: null }, summary: { present: true, bytes: 2 } });
  });
});
