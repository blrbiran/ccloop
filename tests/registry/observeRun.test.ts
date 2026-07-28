import { describe, expect, it } from "vitest";
import { observeRun } from "../../src/registry/observeRun.js";
import { OBSERVED_FILES } from "../../src/registry/observeFields.js";
import type { ObserveDeps, RunFileReaders } from "../../src/registry/readObservedFile.js";

function enoentError(): NodeJS.ErrnoException {
  const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

// Fresh fakes per test — a leaked call counter across tests would produce a green suite
// that proves nothing.
function makeDeps(overrides: Partial<RunFileReaders>): ObserveDeps {
  const noop = async () => {
    throw enoentError();
  };

  const readers: RunFileReaders = {
    readRunState: overrides.readRunState ?? noop,
    readOwnerRecordWithoutRecovery: overrides.readOwnerRecordWithoutRecovery ?? noop,
    readOwnerTransferRecord: overrides.readOwnerTransferRecord ?? noop,
  };

  return {
    readers,
    sleep: async () => {},
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  };
}

const validLoopState = {
  status: "queued",
  currentAttempt: 1,
  attemptsUsed: 0,
  lastTransitionAt: "2026-07-28T00:00:00.000Z",
  stopReason: null,
};

const validOwnerRecord = {
  runId: "run-1",
  currentOwnerEpoch: 1,
  ownerStatus: "active",
  currentProcessInstanceId: "proc-1",
  leaseAffirmedAt: "2026-07-28T00:00:00.000Z",
};

const validOwnerTransfer = { eligibleForContinuation: true };

describe("observeRun", () => {
  // Requirement 1: a fully populated run directory reports all three files, every field present.
  it("observes all three files with every field present for a fully populated run", async () => {
    const deps = makeDeps({
      readRunState: async () => validLoopState,
      readOwnerRecordWithoutRecovery: async () => validOwnerRecord,
      readOwnerTransferRecord: async () => validOwnerTransfer,
    });

    const result = await observeRun("/fake/run", deps);

    expect(result.kind).toBe("run");
    expect(result.path).toBe("/fake/run");
    expect(result.files.map((f) => f.file)).toEqual(OBSERVED_FILES.map((s) => s.file));

    for (const file of result.files) {
      for (const observation of Object.values(file.fields)) {
        expect(observation.kind).toBe("present");
      }
    }
  });

  // Requirement 2: a run with only loop-state.json still reports all three files, in
  // OBSERVED_FILES order — the missing two are not omitted, every field is `absent`.
  it("reports absent files as full rows with every field absent, never omitting them", async () => {
    const deps = makeDeps({
      readRunState: async () => validLoopState,
      // owner-record.json and owner-transfer.json fall through to the ENOENT-throwing noop.
    });

    const result = await observeRun("/fake/run", deps);

    expect(result.files).toHaveLength(3);
    expect(result.files.map((f) => f.file)).toEqual([
      "loop-state.json",
      "owner-record.json",
      "owner-transfer.json",
    ]);

    for (const observation of Object.values(result.files[0].fields)) {
      expect(observation.kind).toBe("present");
    }
    for (const observation of Object.values(result.files[1].fields)) {
      expect(observation).toEqual({ kind: "absent" });
    }
    for (const observation of Object.values(result.files[2].fields)) {
      expect(observation).toEqual({ kind: "absent" });
    }
  });

  // Requirement 3: observedAt is the injected now(), asserted exactly rather than as a range.
  it("stamps observedAt with deps.now().toISOString() exactly", async () => {
    const deps = makeDeps({});

    const result = await observeRun("/fake/run", deps);

    expect(result.observedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  // Requirement 4: a failure reading one file (an unexpected error kind, not ENOENT or a parse
  // failure) must not prevent the other two files from being observed. This kills an
  // implementation that lets one rejected/failing read short-circuit the whole run.
  it("still reports the other two files when one reader throws an unexpected error", async () => {
    const deps = makeDeps({
      readRunState: async () => {
        throw new TypeError("boom: unexpected failure mode");
      },
      readOwnerRecordWithoutRecovery: async () => validOwnerRecord,
      readOwnerTransferRecord: async () => validOwnerTransfer,
    });

    const result = await observeRun("/fake/run", deps);

    expect(result.files).toHaveLength(3);

    for (const observation of Object.values(result.files[0].fields)) {
      expect(observation).toMatchObject({ kind: "unreadable", reason: "io" });
    }
    for (const observation of Object.values(result.files[1].fields)) {
      expect(observation.kind).toBe("present");
    }
    for (const observation of Object.values(result.files[2].fields)) {
      expect(observation.kind).toBe("present");
    }
  });
});
