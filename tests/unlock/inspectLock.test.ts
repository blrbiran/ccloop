// Human ruling 70 board C-d (held at fail-closed by human ruling 72) and human ruling 73: the
// inspection half of `ccloop unlock`. It ANSWERS, it never deletes — deletion lives in exactly one
// place, unlockCommand.ts, so that the question "may this lock go" and the act of removing it can
// never drift apart.
//
// The five states below are the ones pointC-design.md §4.2 measured end-to-end on the prototype,
// plus a sixth the prototype never reached: a lock file that cannot be READ at all. That one is
// kept separate because human ruling 73's credential is a digest of the file's bytes, and a file
// whose bytes are unreachable has no digest — so it is the one state with no --force route, and
// saying so out loud is the honest thing rather than pretending a credential exists.
//
// The liveness predicate is deliberately the bare-pid one. pointC-design.md §4.2 mutation C
// measured what happens when the holder identity is "upgraded" to the strong form: parsePid's
// /^pid:(\d+)$/ stops matching, the liveness guard is skipped entirely, and the redline function
// tryRecoverStaleOwnerTransferLock degenerates into an unconditional lock stealer. This module
// reuses fileStore's own parsePid/isProcessActive for that reason — a second liveness
// implementation here would be free to drift into exactly that failure.
//
// *** ERRATUM (point B, HUMAN RULING 83) — THE DIRECTION REVERSED. The paragraph above is kept
// verbatim because it records what mutation C measured under ruling 50. Ruling 83 turned the guard
// into `pid === null || isProcessActive(pid)`, so an unparsed holder now REFUSES instead of falling
// through: the same "upgrade" makes the redline function an unconditional lock REFUSER, not a
// stealer — silent data loss became a silent stall. The reason to reuse fileStore's predicates
// rather than grow a second one is unchanged. ***

import { createHash } from "node:crypto";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_TRANSFER_LOCK_FILE } from "../../src/persistence/fileStore.js";
import { inspectOwnerTransferLock } from "../../src/unlock/inspectLock.js";

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccloop-unlock-"));
}

async function writeLock(runDir: string, contents: string): Promise<string> {
  await writeFile(join(runDir, OWNER_TRANSFER_LOCK_FILE), contents);
  return createHash("sha256").update(Buffer.from(contents)).digest("hex");
}

// A pid that is almost certainly not running. Chosen the same way pointC-design.md §4.2 chose it
// for the prototype, and asserted to be dead below rather than assumed.
const DEAD_PID = 999999;

describe("inspectOwnerTransferLock", () => {
  it("answers absent when there is no lock on disk", async () => {
    const runDir = await makeRunDir();

    expect(await inspectOwnerTransferLock(runDir)).toEqual({ state: "absent" });
  });

  it("answers dead for a bare-pid holder whose process is gone", async () => {
    const runDir = await makeRunDir();
    // Anti-vacuity: if this pid were somehow alive, the test below would pass for the wrong
    // reason — it would be asserting the "alive" path's absence rather than the dead path.
    expect(() => process.kill(DEAD_PID, 0)).toThrow();
    const digest = await writeLock(
      runDir,
      JSON.stringify({ holderProcessInstanceId: `pid:${DEAD_PID}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
    );

    const onDisk = await stat(join(runDir, OWNER_TRANSFER_LOCK_FILE));
    expect(await inspectOwnerTransferLock(runDir)).toEqual({
      state: "dead",
      holder: `pid:${DEAD_PID}`,
      pid: DEAD_PID,
      digest,
      // Carried so the deletion can re-check that the file it is about to unlink is still the file
      // this inspection looked at. Without it the "dead" verdict authorizes a path, not a file.
      identity: { dev: onDisk.dev, ino: onDisk.ino },
    });
  });

  it("answers alive for a bare-pid holder that is still running", async () => {
    const runDir = await makeRunDir();
    const digest = await writeLock(
      runDir,
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
    );

    const onDisk = await stat(join(runDir, OWNER_TRANSFER_LOCK_FILE));
    expect(await inspectOwnerTransferLock(runDir)).toEqual({
      state: "alive",
      holder: `pid:${process.pid}`,
      pid: process.pid,
      digest,
      identity: { dev: onDisk.dev, ino: onDisk.ino },
    });
  });

  it("answers unrecognized-holder for the strong identity form, rather than skipping the liveness guard", async () => {
    // This is mutation C's shape (pointC-design.md §4.2). parsePid returns null for it, and in the
    // redline function that null SKIPS the liveness check and falls through to the unlink. Here it
    // must instead land in a state that refuses, because "I cannot tell whose it is" is the one
    // answer that must never authorize a deletion.
    const runDir = await makeRunDir();
    const holder = `pid:${process.pid}:1787154059514`;
    const digest = await writeLock(
      runDir,
      JSON.stringify({ holderProcessInstanceId: holder, acquiredAt: "2026-08-20T00:00:00.000Z" }),
    );

    const onDisk = await stat(join(runDir, OWNER_TRANSFER_LOCK_FILE));
    expect(await inspectOwnerTransferLock(runDir)).toEqual({
      state: "unrecognized-holder",
      holder,
      digest,
      identity: { dev: onDisk.dev, ino: onDisk.ino },
    });
  });

  it("answers unrecognized-holder when the record parses but carries no holder at all", async () => {
    const runDir = await makeRunDir();
    const digest = await writeLock(runDir, JSON.stringify({ acquiredAt: "2026-08-20T00:00:00.000Z" }));

    expect(await inspectOwnerTransferLock(runDir)).toMatchObject({
      state: "unrecognized-holder",
      holder: "",
      digest,
    });
  });

  it("answers unparseable for a lock that is not JSON — the permanently stranded cell", async () => {
    // pointC-design.md §8.5 / human ruling 72: `{not json` with no staged artifacts is the ONE
    // shape the normal transfer path gives up on for good (JSON.parse throws, hasStagedArtifacts
    // is false, the redline function returns false and the lock stays on disk forever). It is also
    // the cell fail-closed refuses. That intersection is why --force exists at all.
    //
    // *** ERRATUM (point B, human ruling 83): the paragraph above is kept verbatim and its premise
    // has widened, not broken. There is no `hasStagedArtifacts` any more, staged artifacts no
    // longer change the answer, and the permanently-stranded set is no longer ONE shape: it is now
    // every lock that is not a parsed `pid:<n>` whose process is dead. The intersection this test
    // names therefore grew, which makes the case for --force stronger rather than weaker. This
    // cell is still in it. ***
    const runDir = await makeRunDir();
    const digest = await writeLock(runDir, "{not json");

    const inspection = await inspectOwnerTransferLock(runDir);

    expect(inspection.state).toBe("unparseable");
    expect(inspection).toMatchObject({ digest });
    expect((inspection as { reason: string }).reason).not.toBe("");
  });

  it("answers unparseable for a zero-byte lock, and still yields a digest for it", async () => {
    const runDir = await makeRunDir();
    const digest = await writeLock(runDir, "");

    expect(await inspectOwnerTransferLock(runDir)).toMatchObject({ state: "unparseable", digest });
  });

  it("answers unparseable for valid JSON that is not an object, without throwing on the property read", async () => {
    // JSON.parse("null") succeeds, and reading .holderProcessInstanceId off it throws a TypeError.
    // In the redline function that TypeError is caught by the same catch that handles bad JSON; here
    // it must not escape as a crash.
    const runDir = await makeRunDir();
    const digest = await writeLock(runDir, "null");

    expect(await inspectOwnerTransferLock(runDir)).toMatchObject({ state: "unparseable", digest });
  });

  describe("liveness that cannot be determined is its own answer, not a guess in either direction (human ruling 74)", () => {
    // fileStore's isProcessActive collapses every non-ESRCH outcome of process.kill into "alive".
    // That is the safe collapse for the redline recovery function, which must never steal a lock it
    // is unsure about. It is the WRONG collapse for this command: the reviewers measured that it
    // makes a pid:0 or overflow-pid lock refuse forever, --force included, because unlockCommand
    // checks `alive` BEFORE it considers the credential. So this module keeps the third outcome
    // instead of folding it away. The syscall is the same one; only the collapsing is dropped.

    it("answers liveness-unknown for pid 0, which names the caller's own process group, not a holder", async () => {
      // process.kill(0, 0) does not throw — it signals the caller's process group. Reading that as
      // "the holder is alive" is a false positive with no escape hatch behind it.
      const runDir = await makeRunDir();
      const digest = await writeLock(
        runDir,
        JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-08-20T00:00:00.000Z" }),
      );

      const inspection = await inspectOwnerTransferLock(runDir);

      expect(inspection).toMatchObject({ state: "liveness-unknown", holder: "pid:0", pid: 0, digest });
      expect((inspection as { reason: string }).reason).not.toBe("");
    });

    it("answers liveness-unknown for a pid too large to be one", async () => {
      // process.kill throws a TypeError here, not an errno — and a TypeError is emphatically not
      // evidence that a process is running.
      const runDir = await makeRunDir();
      const digest = await writeLock(
        runDir,
        JSON.stringify({ holderProcessInstanceId: "pid:99999999999999999999", acquiredAt: "2026-08-20T00:00:00.000Z" }),
      );

      expect(await inspectOwnerTransferLock(runDir)).toMatchObject({ state: "liveness-unknown", digest });
    });

    it("still answers alive for a process that really is running, and dead for one that is not", async () => {
      // Anti-vacuity for the two tests above: if the classifier had simply started answering
      // "unknown" for everything, they would both pass and mean nothing.
      const live = await makeRunDir();
      await writeLock(live, JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "x" }));
      expect((await inspectOwnerTransferLock(live)).state).toBe("alive");

      const gone = await makeRunDir();
      expect(() => process.kill(DEAD_PID, 0)).toThrow();
      await writeLock(gone, JSON.stringify({ holderProcessInstanceId: `pid:${DEAD_PID}`, acquiredAt: "x" }));
      expect((await inspectOwnerTransferLock(gone)).state).toBe("dead");
    });
  });

  describe("a failing close() must not overwrite a read that already succeeded", () => {
    afterEach(() => {
      vi.resetModules();
      vi.doUnmock("node:fs/promises");
    });

    it("still reports the real state when the descriptor fails to close", async () => {
      // The hazard this repo already wrote down for itself: fileStore.ts:776 — "a cleanup failure
      // must not replace the error the caller needs to see". Here it is worse than losing an error.
      // The close() sits inside the same try whose catch produces `file-unreadable`, so a close()
      // failure after a PERFECTLY GOOD read would be reported as an unreadable lock — and
      // `file-unreadable` is the one state with no digest, hence the one state with no --force
      // route at all. A failed close would take the escape hatch away from a readable lock.
      const runDir = await makeRunDir();
      // Anti-vacuity, the same guard this file applies everywhere it leans on DEAD_PID: if that pid
      // were alive, the assertion below would be pinning the "alive" path rather than the fact that
      // a failed close() left the real state alone.
      expect(() => process.kill(DEAD_PID, 0)).toThrow();
      const contents = JSON.stringify({ holderProcessInstanceId: `pid:${DEAD_PID}`, acquiredAt: "x" });
      await writeFile(join(runDir, OWNER_TRANSFER_LOCK_FILE), contents);

      const actualFs = await import("node:fs/promises");
      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (path: string, flags: string) => {
          const handle = await actualFs.open(path, flags);
          return {
            stat: () => handle.stat(),
            readFile: () => handle.readFile(),
            // Really closed, so the test leaks no descriptor — and then it reports failure anyway.
            close: async () => {
              await handle.close();
              throw Object.assign(new Error("simulated close failure"), { code: "EIO" });
            },
          };
        },
      }));
      const { inspectOwnerTransferLock: freshlyLoaded } = await import("../../src/unlock/inspectLock.js");

      expect(await freshlyLoaded(runDir)).toMatchObject({ state: "dead", holder: `pid:${DEAD_PID}` });
    });
  });

  it("answers file-unreadable — the one state with no digest and therefore no --force route", async () => {
    const runDir = await makeRunDir();
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    await writeFile(lockPath, "{not json");
    await chmod(lockPath, 0o000);

    const inspection = await inspectOwnerTransferLock(runDir);

    // Running as root defeats the permission bit, and a silent pass there would be a test that
    // cannot fail. Skip loudly instead of asserting something untrue.
    if (inspection.state !== "file-unreadable") {
      expect(process.getuid?.()).toBe(0);
      return;
    }

    expect(inspection).toMatchObject({ state: "file-unreadable" });
    expect(inspection).not.toHaveProperty("digest");
    expect((inspection as { reason: string }).reason).not.toBe("");
  });
});
