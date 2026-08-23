// Human ruling 70, board C-a: the sweep's owner-transfer lock probe, and the whole of what it is
// allowed to do — ask whether the file EXISTS. It must not read the file, must not parse it, must
// not extract a holder identity and must not judge liveness, because every one of those would
// either need a second JSON reading implementation for this file (spec §7.2 forbids it: the only
// existing one lives inside tryRecoverStaleOwnerTransferLock, which human ruling 50 froze when
// this was decided and human ruling 83 has since changed, for point B alone — the ban on a second
// reading implementation is what carries this choice now, not the freeze) or
// would put a liveness judgment into a read-only reporting path.
//
// The unparseable and empty cases below are what pin that: both are files no reader could make
// sense of, and both must still answer "present", because presence is the only question asked.
// A probe that grew a JSON.parse would fail them — which is the point, since the measurement in
// pointC-design.md §8.4 found the suite would otherwise never execute this code's positive branch
// at all (46 probes, zero of them present).

import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultLockPresence } from "../../src/sweep/lockPresence.js";

describe("defaultLockPresence", () => {
  it("answers false for a run directory with no lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-presence-"));

    expect(await defaultLockPresence(runDir)).toBe(false);
  });

  it("answers false for a directory that does not exist at all", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-presence-"));

    expect(await defaultLockPresence(join(runDir, "no-such-run"))).toBe(false);
  });

  it("answers true for a well-formed lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-presence-"));
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-19T00:00:00.000Z" }),
    );

    expect(await defaultLockPresence(runDir)).toBe(true);
  });

  it("answers true for an unparseable lock — the operator's stuck case, and the one a parse would lose", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-presence-"));
    await writeFile(join(runDir, ".owner-transfer.lock"), "{not json");

    expect(await defaultLockPresence(runDir)).toBe(true);
  });

  it("answers true for a zero-byte lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-presence-"));
    await writeFile(join(runDir, ".owner-transfer.lock"), "");

    expect(await defaultLockPresence(runDir)).toBe(true);
  });
});
