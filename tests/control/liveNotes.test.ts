// Live notes (Orca spec 2026-11-12 tester follow-up G Part 5; human: the note is to 「补充一点信息（它下一步用上就行）」). Orca
// keeps the task's queued notes in <sourceDir>/live-notes.json and may rewrite that file at any time (a new note, or the
// same notes again); ccloop takes the notes it has not delivered at each phase start and acknowledges them, so a note is
// delivered exactly once -- never lost, never twice -- and Orca can read which phase and attempt got it.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_NOTES_DELIVERED_FILE, LIVE_NOTES_FILE, liveNoteInbox, readLiveNoteDeliveries } from "../../src/control/liveNotes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const T = "2026-11-12T10:00:00.000Z";
const NOW = () => new Date(T);

async function source(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "live-notes-")));
  roots.push(dir);
  await mkdir(join(dir, "run"), { mode: 0o700 });
  return dir;
}
const note = (id: string, text = `note ${id}`) => ({ id, text, at: "2026-11-12T09:00:00.000Z" });
async function writeNotes(dir: string, notes: unknown[]): Promise<void> {
  await writeFile(join(dir, LIVE_NOTES_FILE), JSON.stringify({ schema: "orca-live-notes-v1", notes }), { mode: 0o600 });
}

describe("the live note inbox", () => {
  it("no file ⇒ [] and no ack file; a malformed or over-bound file ⇒ []", async () => {
    const dir = await source();
    const inbox = liveNoteInbox(dir, NOW);
    expect(await inbox.take("plan", 1)).toEqual([]);
    expect(await readLiveNoteDeliveries(dir)).toBeNull();
    for (const bad of ["not json", JSON.stringify({ schema: "orca-live-notes-v1", notes: Array.from({ length: 17 }, (_, i) => note(`n${i}`)) }),
      JSON.stringify({ schema: "orca-live-notes-v1", notes: [note("n1", "x".repeat(2049))] }), JSON.stringify({ schema: "other", notes: [note("n1")] })]) {
      await writeFile(join(dir, LIVE_NOTES_FILE), bad, { mode: 0o600 });
      expect(await inbox.take("plan", 1)).toEqual([]);
    }
    expect(await readLiveNoteDeliveries(dir)).toBeNull();
  });

  it("returns the unacked notes in file order once, acks them 0600 with phase and attempt, and never again even when Orca rewrites the file with them", async () => {
    const dir = await source();
    const inbox = liveNoteInbox(dir, NOW);
    await writeNotes(dir, [note("n1"), note("n2")]);
    expect((await inbox.take("plan", 1)).map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(await inbox.take("plan", 1)).toEqual([]);
    await writeNotes(dir, [note("n1"), note("n2"), note("n3")]);
    expect(await inbox.take("execute", 1)).toEqual([note("n3")]);
    expect(await readLiveNoteDeliveries(dir)).toEqual([
      { id: "n1", phase: "plan", attempt: 1, at: T }, { id: "n2", phase: "plan", attempt: 1, at: T }, { id: "n3", phase: "execute", attempt: 1, at: T }]);
    expect((await stat(join(dir, "run", LIVE_NOTES_DELIVERED_FILE))).mode & 0o777).toBe(0o600);
  });

  it("a symlinked notes file is not read", async () => {
    const dir = await source();
    const elsewhere = join(dir, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ schema: "orca-live-notes-v1", notes: [note("n1")] }), { mode: 0o600 });
    await symlink(elsewhere, join(dir, LIVE_NOTES_FILE));
    expect(await liveNoteInbox(dir, NOW).take("plan", 1)).toEqual([]);
    expect(await readLiveNoteDeliveries(dir)).toBeNull();
  });

  it("an acknowledgement file it cannot read delivers nothing rather than delivering twice", async () => {
    const dir = await source();
    await writeNotes(dir, [note("n1")]);
    await writeFile(join(dir, "run", LIVE_NOTES_DELIVERED_FILE), "not json", { mode: 0o600 });
    expect(await liveNoteInbox(dir, NOW).take("plan", 1)).toEqual([]);
    expect(await readFile(join(dir, "run", LIVE_NOTES_DELIVERED_FILE), "utf8")).toBe("not json");
  });
});
