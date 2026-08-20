// Human ruling 70 board C-e: `ccloop unlock` must come with its own tests, pinned state by state,
// and above all it must pin that a LIVE holder's lock is never removed. pointC-design.md §4.2
// measured why that sentence had to be written down: adding this command to the CLI passed
// typecheck and all 535 tests of the day, and NOT ONE of them would have caught it deleting
// anything. This file is the only thing standing between a new delete surface and no supervision.
//
// The live-holder case is asserted twice on purpose — once without --force and once with a
// correct --force credential — because "never" has to mean never. Human ruling 70's C-e says pin
// that a live pid is never deleted; the strongest reading of that is that no path reaches the
// deletion, and --force is a path. An escape hatch exists for locks that are permanently stranded
// (human ruling 72), and a live holder's lock is not stranded: it goes away when that process
// exits. Nothing here may be relaxed without a new ruling.
//
// Every deletion assertion is preceded by an existence assertion. Without it, a test that pins
// "the lock is still there" would pass just as happily against a run directory where the lock was
// never created — it would be asserting nothing at all.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_TRANSFER_LOCK_FILE } from "../../src/persistence/fileStore.js";
import { removeLockIfUnchanged, unlockOwnerTransferLock } from "../../src/unlock/unlockCommand.js";

const DEAD_PID = 999999;

type Run = { code: number; out: string[]; err: string[] };

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccloop-unlock-cmd-"));
}

async function seedLock(runDir: string, contents: string): Promise<string> {
  await writeFile(join(runDir, OWNER_TRANSFER_LOCK_FILE), contents);
  return createHash("sha256").update(Buffer.from(contents)).digest("hex");
}

async function lockExists(runDir: string): Promise<boolean> {
  try {
    await stat(join(runDir, OWNER_TRANSFER_LOCK_FILE));
    return true;
  } catch {
    return false;
  }
}

async function run(runDir: string, force?: { expectedDigest: string }): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await unlockOwnerTransferLock(
    force === undefined
      ? { runDir, force: false, stdout: (line) => out.push(line), stderr: (line) => err.push(line) }
      : {
          runDir,
          force: true,
          expectedDigest: force.expectedDigest,
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
        },
  );
  return { code, out, err };
}

describe("removeLockIfUnchanged — the deletion re-checks WHICH FILE, not just the path", () => {
  // In afterEach, NOT at the end of the test bodies below. A failing assertion aborts the body, so
  // trailing cleanup never runs and the fs mock leaks into every test that follows — which is
  // exactly what a mutation run surfaced here: one real failure turned into two, and the second
  // pointed at innocent code. afterEach runs either way.
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:fs/promises");
  });

  // Human ruling 62 fixed this exact bug class once already, in release(): it "used to unlink
  // `lockPath` unconditionally: whatever file bore that name at that instant was deleted", measured
  // on `dbac288` — a holder deleted the NEW holder's lock on its way out. Both independent reviews
  // of this command found the same shape here: `inspectOwnerTransferLock` reads the file, and the
  // unlink that follows names only the path. In between, a legitimate concurrent recovery can
  // reclaim a dead holder's lock and publish a fresh, LIVE one at the same name.
  //
  // The residual window is named rather than papered over: the stat and the unlink are still two
  // syscalls, so a theft landing between THEM is undetectable — the same residue fileStore's own
  // comment records for release(). This narrows the window from "the whole inspection" to "two
  // adjacent syscalls"; it does not close it.

  it("removes the lock when the name still holds the very file that was inspected", async () => {
    const runDir = await makeRunDir();
    await seedLock(runDir, "{not json");
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    const onDisk = await stat(lockPath);

    expect(await removeLockIfUnchanged(lockPath, { dev: onDisk.dev, ino: onDisk.ino })).toEqual({ outcome: "removed" });
    expect(await lockExists(runDir), "the inspected file was not removed").toBe(false);
  });

  it("refuses when the name now holds a DIFFERENT file, and leaves that file alone", async () => {
    const runDir = await makeRunDir();
    await seedLock(runDir, "{not json");
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    const inspected = await stat(lockPath);

    // What a concurrent recovery does: reclaim the stale lock and publish a fresh one at the same
    // name. Same path, different inode.
    await unlink(lockPath);
    await seedLock(runDir, JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "later" }));
    const republished = await stat(lockPath);
    expect(republished.ino, "the fixture failed to produce a different file").not.toBe(inspected.ino);

    expect(await removeLockIfUnchanged(lockPath, { dev: inspected.dev, ino: inspected.ino })).toEqual({ outcome: "changed" });
    expect(await lockExists(runDir), "a lock that was NOT the inspected file was deleted").toBe(true);
  });

  it("reports gone rather than throwing when the lock left on its own", async () => {
    const runDir = await makeRunDir();
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);

    expect(await removeLockIfUnchanged(lockPath, { dev: 1, ino: 1 })).toEqual({ outcome: "gone" });
  });

  it("reports unremovable rather than throwing when the name holds something unlink cannot take", async () => {
    // A directory at the lock's name reaches this function only if an inspection somehow classified
    // it; the command's own read refuses it earlier with EISDIR. Pinned anyway, because an
    // unhandled rejection out of a delete path is the kind of failure that gets reported as "the
    // command crashed" rather than "nothing was deleted".
    const runDir = await makeRunDir();
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);
    await mkdir(lockPath);
    const onDisk = await stat(lockPath);

    const result = await removeLockIfUnchanged(lockPath, { dev: onDisk.dev, ino: onDisk.ino });

    expect(result.outcome).toBe("unremovable");
    // The errno is kept, not collapsed into the word "unremovable". This command exists for a human
    // operator; telling them "could not be removed" without saying EACCES / EPERM / EIO leaves them
    // with nothing to act on, which is the failure this project keeps calling a silent one.
    expect((result as { reason: string }).reason).toContain("EPERM");
  });

  it("keeps the errno when the stat that guards the delete fails, instead of collapsing it", async () => {
    const runDir = await makeRunDir();
    await seedLock(runDir, "{not json");
    const lockPath = join(runDir, OWNER_TRANSFER_LOCK_FILE);

    const actualFs = await import("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      stat: async () => {
        throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
      },
    }));
    const { removeLockIfUnchanged: freshlyLoaded } = await import("../../src/unlock/unlockCommand.js");

    const result = await freshlyLoaded(lockPath, { dev: 1, ino: 1 });

    expect(result.outcome).toBe("unremovable");
    expect((result as { reason: string }).reason).toContain("EACCES");
    expect(await lockExists(runDir), "a lock was deleted despite the guard stat failing").toBe(true);
  });

  it("puts the reason in front of the operator, not just in the return value", async () => {
    const runDir = await makeRunDir();
    await seedLock(runDir, "{not json");

    const actualFs = await import("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      stat: async () => {
        throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
      },
    }));
    const { unlockOwnerTransferLock: freshlyLoaded } = await import("../../src/unlock/unlockCommand.js");

    const err: string[] = [];
    const digest = createHash("sha256").update(Buffer.from("{not json")).digest("hex");
    const code = await freshlyLoaded({
      runDir,
      force: true,
      expectedDigest: digest,
      stdout: () => {},
      stderr: (line) => err.push(line),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("EACCES");
  });
});

describe("the dead-holder path refuses once the file underneath it has been replaced", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../src/unlock/inspectLock.js");
  });

  it("does not delete a lock that is no longer the file the inspection read", async () => {
    const runDir = await makeRunDir();
    // On disk: a live holder's lock, published by the concurrent recovery that won the race.
    await seedLock(
      runDir,
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:01.000Z" }),
    );

    // The inspection that ran a moment earlier saw the previous, dead-holder file. Its identity no
    // longer matches anything on disk — which is exactly the state the race produces.
    const actual = await import("../../src/unlock/inspectLock.js");
    // Before doMock, not after: this file imports unlockCommand statically at the top, so without
    // the reset the dynamic import below hands back the already-cached module that closed over the
    // real inspection — and the test would pass or fail for reasons unrelated to what it pins.
    vi.resetModules();
    vi.doMock("../../src/unlock/inspectLock.js", () => ({
      ...actual,
      inspectOwnerTransferLock: async () => ({
        state: "dead" as const,
        holder: `pid:${DEAD_PID}`,
        pid: DEAD_PID,
        digest: "irrelevant-to-the-dead-path",
        identity: { dev: 0, ino: 0 },
      }),
    }));
    const { unlockOwnerTransferLock: freshlyLoaded } = await import("../../src/unlock/unlockCommand.js");

    const out: string[] = [];
    const err: string[] = [];
    const code = await freshlyLoaded({
      runDir,
      force: false,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

    expect(await lockExists(runDir), "a live holder's republished lock was deleted by the dead path").toBe(true);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toContain("changed on disk");
  });
});

describe("liveness that cannot be determined refuses, but keeps the escape hatch (human ruling 74)", () => {
  // The reviewers measured that folding "cannot tell" into "alive" produces locks with NO way out:
  // `alive` is checked before the credential, so pid:0 and overflow-pid locks refused even a
  // correct --force. The redline recovery function strands them too, since it shares the collapse.
  // Refusing by default is right; refusing without a hatch is what human ruling 74 undid.
  const cases = [
    { name: "pid 0, which names the caller's own process group", holder: "pid:0" },
    { name: "a pid too large to be one", holder: "pid:99999999999999999999" },
  ];

  for (const { name, holder } of cases) {
    it(`refuses ${name} by default, and offers a --force line`, async () => {
      const runDir = await makeRunDir();
      const digest = await seedLock(runDir, JSON.stringify({ holderProcessInstanceId: holder, acquiredAt: "x" }));

      const { code, err } = await run(runDir);

      expect(await lockExists(runDir), "a lock of undetermined liveness was deleted by default").toBe(true);
      expect(code).toBe(1);
      expect(err[0]).toContain("cannot determine whether");
      expect(err.join("\n")).toContain(`--force --expect ${digest}`);
    });

    it(`lets --force with a matching digest clear ${name}`, async () => {
      const runDir = await makeRunDir();
      const digest = await seedLock(runDir, JSON.stringify({ holderProcessInstanceId: holder, acquiredAt: "x" }));

      const { code, out } = await run(runDir, { expectedDigest: digest });

      expect(await lockExists(runDir), "human ruling 74's escape hatch did not open").toBe(false);
      expect(code).toBe(0);
      expect(out[0]).toContain("forced");
    });
  }
});

describe("unlockOwnerTransferLock", () => {
  describe("a live holder's lock is never removed — not by the default path, not by --force", () => {
    it("refuses a live holder and leaves the lock on disk", async () => {
      const runDir = await makeRunDir();
      await seedLock(
        runDir,
        JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
      );
      expect(await lockExists(runDir)).toBe(true);

      const { code, out, err } = await run(runDir);

      expect(await lockExists(runDir), "the lock of a LIVE holder was deleted").toBe(true);
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(err[0]).toBe(`refused  pid ${process.pid} is alive`);
    });

    it("refuses a live holder even when --force carries the correct digest", async () => {
      const runDir = await makeRunDir();
      const digest = await seedLock(
        runDir,
        JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
      );
      expect(await lockExists(runDir)).toBe(true);

      const { code, err } = await run(runDir, { expectedDigest: digest });

      // The credential was correct and the answer is still no. This is the assertion that would
      // fail first if someone ever wires --force straight to the unlink.
      expect(await lockExists(runDir), "--force deleted the lock of a LIVE holder").toBe(true);
      expect(code).toBe(1);
      expect(err[0]).toBe(`refused  pid ${process.pid} is alive`);
    });

    it("never offers a --force command line for a live holder, and says what to do instead", async () => {
      const runDir = await makeRunDir();
      await seedLock(
        runDir,
        JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
      );

      const { err } = await run(runDir);

      expect(err.join("\n")).not.toContain("--expect");
      expect(err.join("\n")).toContain(`wait for pid ${process.pid} to exit`);
    });
  });

  it("reports an absent lock and exits 0 without touching anything", async () => {
    const runDir = await makeRunDir();

    const { code, out, err } = await run(runDir);

    expect(code).toBe(0);
    expect(out).toEqual(["absent   no owner-transfer lock present"]);
    expect(err).toEqual([]);
  });

  it("removes a dead holder's lock on the default path — no --force needed", async () => {
    const runDir = await makeRunDir();
    expect(() => process.kill(DEAD_PID, 0)).toThrow();
    await seedLock(
      runDir,
      JSON.stringify({ holderProcessInstanceId: `pid:${DEAD_PID}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
    );
    expect(await lockExists(runDir)).toBe(true);

    const { code, out, err } = await run(runDir);

    expect(await lockExists(runDir), "a DEAD holder's lock was left behind").toBe(false);
    expect(code).toBe(0);
    expect(out).toEqual([`removed  holder=pid:${DEAD_PID} was not alive`]);
    expect(err).toEqual([]);
  });

  describe("the two states the code refuses to interpret", () => {
    const cases = [
      {
        name: "an unrecognized holder identity",
        contents: JSON.stringify({
          holderProcessInstanceId: "pid:4242:1787154059514",
          acquiredAt: "2026-08-20T00:00:00.000Z",
        }),
        firstLine: "refused  unrecognized holder identity: pid:4242:1787154059514",
      },
      {
        // Human ruling 72's permanently stranded cell: the normal transfer path returns false on
        // this and leaves the lock forever, and this command refuses it too. --force is the only
        // way out, which is exactly why human ruling 73 had to give --force a credential that
        // works here — a holder id cannot be read off this file.
        name: "a lock that is not JSON at all",
        contents: "{not json",
        firstLine: "refused  lock unreadable",
      },
    ];

    for (const { name, contents, firstLine } of cases) {
      it(`refuses ${name}, and prints a --force line the operator can copy`, async () => {
        const runDir = await makeRunDir();
        const digest = await seedLock(runDir, contents);
        expect(await lockExists(runDir)).toBe(true);

        const { code, out, err } = await run(runDir);

        expect(await lockExists(runDir), "a lock the code refuses to interpret was deleted anyway").toBe(true);
        expect(code).toBe(1);
        expect(out).toEqual([]);
        expect(err[0]).toContain(firstLine);
        // Human ruling 72 attached this: the refusal must hand over a command line that already
        // has the digest computed, so "the operator has to read the scene" costs one paste.
        expect(err.join("\n")).toContain(`ccloop unlock ${runDir} --force --expect ${digest}`);
      });

      it(`removes ${name} when --force carries the matching digest, and says the removal was forced`, async () => {
        const runDir = await makeRunDir();
        const digest = await seedLock(runDir, contents);
        expect(await lockExists(runDir)).toBe(true);

        const { code, out, err } = await run(runDir, { expectedDigest: digest });

        expect(await lockExists(runDir), "--force with a matching digest failed to remove the lock").toBe(false);
        expect(code).toBe(0);
        expect(err).toEqual([]);
        // The forced removal must not be reportable as an ordinary one: an operator reading a log
        // has to be able to tell "the criterion authorized this" from "a human overrode it".
        expect(out[0]).toContain("forced");
        expect(out[0]).not.toBe(`removed  holder=pid:${DEAD_PID} was not alive`);
      });

      it(`refuses ${name} when --force carries a stale digest, and leaves the lock alone`, async () => {
        const runDir = await makeRunDir();
        await seedLock(runDir, contents);
        const staleDigest = createHash("sha256").update(Buffer.from("something else entirely")).digest("hex");

        const { code, out, err } = await run(runDir, { expectedDigest: staleDigest });

        expect(await lockExists(runDir), "--force with a STALE digest deleted the lock").toBe(true);
        expect(code).toBe(1);
        expect(out).toEqual([]);
        expect(err[0]).toContain("--expect does not match the lock on disk");
      });
    }
  });

  it("refuses --force whose digest was computed before the lock changed underneath it", async () => {
    // The TOCTOU half of human ruling 73. The operator inspected one lock, and by the time they
    // typed the command a different one held the name. A credential that only proved "you passed
    // --force" would delete the new lock; this one refuses it.
    //
    // Both shapes here are ones the code declines to interpret, so the digest is the ONLY thing
    // that can refuse — a live holder in the second slot would be refused for being alive instead,
    // and the test would pass without the credential ever being consulted.
    const runDir = await makeRunDir();
    const digestOfTheOldLock = await seedLock(runDir, "{not json");
    await seedLock(runDir, "{also not json, but different");

    const { code, err } = await run(runDir, { expectedDigest: digestOfTheOldLock });

    expect(await lockExists(runDir), "a digest computed before the lock changed still authorized a delete").toBe(true);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--expect does not match the lock on disk");
    // And the file that survived is the NEW one, byte for byte, not a rewritten copy of anything.
    expect(await readFile(join(runDir, OWNER_TRANSFER_LOCK_FILE), "utf8")).toBe("{also not json, but different");
  });

  it("refuses a live holder for being alive, not for a mismatched credential — the order matters", async () => {
    // Both refusals would leave the lock alone and exit 1, so this is not about the outcome. It is
    // about the liveness check sitting BEFORE the credential check: an operator who is told
    // "--expect does not match" reads it as "recompute the digest and retry", and retrying would
    // then be refused for the real reason anyway. Told "pid N is alive", they wait instead. The
    // ordering is also what makes "no --force route past a live holder" structural rather than a
    // property of which branch happens to run first.
    const runDir = await makeRunDir();
    const digestOfTheOldLock = await seedLock(runDir, "{not json");
    await seedLock(
      runDir,
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:01.000Z" }),
    );

    const { code, err } = await run(runDir, { expectedDigest: digestOfTheOldLock });

    expect(await lockExists(runDir), "the lock of a LIVE holder was deleted").toBe(true);
    expect(code).toBe(1);
    expect(err[0]).toBe(`refused  pid ${process.pid} is alive`);
    expect(err.join("\n")).not.toContain("--expect");
  });

  it("reports an absent lock as absent even under --force, rather than claiming a removal", async () => {
    const runDir = await makeRunDir();
    const digest = createHash("sha256").update(Buffer.from("{not json")).digest("hex");

    const { code, out, err } = await run(runDir, { expectedDigest: digest });

    expect(code).toBe(0);
    expect(out).toEqual(["absent   no owner-transfer lock present"]);
    expect(err).toEqual([]);
  });
});
