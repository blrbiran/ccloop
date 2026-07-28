import { describe, expect, it } from "vitest";
import { readObservedFile } from "../../src/registry/readObservedFile.js";
import { OBSERVED_FILES } from "../../src/registry/observeFields.js";
import type { ObservedFileSpec } from "../../src/registry/types.js";
import type { ObserveDeps, RunFileReaders } from "../../src/registry/readObservedFile.js";
import { LEASE_VERIFY_READ_ATTEMPTS, LEASE_VERIFY_RETRY_DELAY_MS } from "../../src/ownership/lease.js";

function specFor(file: string): ObservedFileSpec {
  const spec = OBSERVED_FILES.find((s) => s.file === file);
  if (!spec) throw new Error(`no spec for ${file}`);
  return spec;
}

// loop-state.json: atomic: false — eligible for retry on parse failure.
const loopStateSpec = specFor("loop-state.json");
// owner-transfer.json: atomic: true — written by rename, retry would be wrong (spec §8.1, §12.4 req 3).
const ownerTransferSpec = specFor("owner-transfer.json");

function enoentError(): NodeJS.ErrnoException {
  const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function eaccesError(): NodeJS.ErrnoException {
  const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

// Fresh fakes per test — a leaked call counter across tests would produce a green suite
// that proves nothing (brief trap).
function makeDeps(overrides: Partial<RunFileReaders>): { deps: ObserveDeps; sleepCalls: number[] } {
  const sleepCalls: number[] = [];
  const noop = async () => ({});

  const readers: RunFileReaders = {
    readRunState: overrides.readRunState ?? noop,
    readOwnerRecordWithoutRecovery: overrides.readOwnerRecordWithoutRecovery ?? noop,
    readOwnerTransferRecord: overrides.readOwnerTransferRecord ?? noop,
  };

  const deps: ObserveDeps = {
    readers,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  };

  return { deps, sleepCalls };
}

describe("readObservedFile", () => {
  // Requirement 1: torn read on a non-atomic file is retried, and the retry is real — not
  // just a lucky result. Asserting only the parsed value would pass against an
  // implementation that never actually invokes the reader twice.
  it("retries a parse failure on a non-atomic file and reports the parsed values once it succeeds", async () => {
    let calls = 0;
    const { deps, sleepCalls } = makeDeps({
      readRunState: async () => {
        calls += 1;
        if (calls === 1) throw new SyntaxError("Unexpected end of JSON input");
        return { status: "queued", currentAttempt: 1 };
      },
    });

    const result = await readObservedFile("/fake/run", loopStateSpec, deps);

    expect(calls).toBe(2);
    expect(result.fields.status).toEqual({ kind: "present", value: "queued" });
    expect(result.fields.currentAttempt).toEqual({ kind: "present", value: 1 });
    expect(sleepCalls).toEqual([LEASE_VERIFY_RETRY_DELAY_MS]);
  });

  // Requirement 2: ENOENT is absent, and is not retried — retrying every absence would make
  // scanning a tree of half-initialized runs needlessly slow.
  it("reports ENOENT as absent for every field, calling the reader exactly once", async () => {
    let calls = 0;
    const { deps, sleepCalls } = makeDeps({
      readRunState: async () => {
        calls += 1;
        throw enoentError();
      },
    });

    const result = await readObservedFile("/fake/run", loopStateSpec, deps);

    expect(calls).toBe(1);
    expect(sleepCalls).toEqual([]);
    for (const fieldSpec of loopStateSpec.fields) {
      expect(result.fields[fieldSpec.name]).toEqual({ kind: "absent" });
    }
  });

  // Requirement 3: an atomic-spec file that fails to parse is not retried. owner-transfer.json
  // is written by rename and cannot tear (fileStore.ts:535-536) — retrying it would be wrong.
  it("does not retry a parse failure on an atomic-spec file", async () => {
    let calls = 0;
    const { deps, sleepCalls } = makeDeps({
      readOwnerTransferRecord: async () => {
        calls += 1;
        throw new SyntaxError("Unexpected token");
      },
    });

    const result = await readObservedFile("/fake/run", ownerTransferSpec, deps);

    expect(calls).toBe(1);
    expect(sleepCalls).toEqual([]);
    expect(result.fields.eligibleForContinuation).toMatchObject({ kind: "unreadable", reason: "parse" });
  });

  // Requirement 4: retry is bounded. Parse failure on every attempt exhausts the budget and
  // reports unreadable/parse, having called the reader exactly LEASE_VERIFY_READ_ATTEMPTS times.
  it("reports unreadable/parse after exhausting all retry attempts", async () => {
    let calls = 0;
    const { deps, sleepCalls } = makeDeps({
      readRunState: async () => {
        calls += 1;
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    const result = await readObservedFile("/fake/run", loopStateSpec, deps);

    expect(calls).toBe(LEASE_VERIFY_READ_ATTEMPTS);
    for (const fieldSpec of loopStateSpec.fields) {
      expect(result.fields[fieldSpec.name]).toMatchObject({ kind: "unreadable", reason: "parse" });
    }
  });

  // Requirement 5: sleep is called with LEASE_VERIFY_RETRY_DELAY_MS between attempts, and not
  // after the final attempt — exactly LEASE_VERIFY_READ_ATTEMPTS - 1 sleeps.
  it("sleeps LEASE_VERIFY_RETRY_DELAY_MS between attempts, and not after the final attempt", async () => {
    const { deps, sleepCalls } = makeDeps({
      readRunState: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });

    await readObservedFile("/fake/run", loopStateSpec, deps);

    expect(sleepCalls).toEqual(
      Array.from({ length: LEASE_VERIFY_READ_ATTEMPTS - 1 }, () => LEASE_VERIFY_RETRY_DELAY_MS),
    );
  });

  // Trap: EACCES is neither absent nor a parse failure (spec §11). It must not fall through
  // to "absent", which would report a present-but-forbidden file as missing, and it must not
  // retry, since it is not a torn read.
  it("reports a permission error (EACCES) as unreadable/io for every field, with no retry", async () => {
    let calls = 0;
    const { deps, sleepCalls } = makeDeps({
      readRunState: async () => {
        calls += 1;
        throw eaccesError();
      },
    });

    const result = await readObservedFile("/fake/run", loopStateSpec, deps);

    expect(calls).toBe(1);
    expect(sleepCalls).toEqual([]);
    for (const fieldSpec of loopStateSpec.fields) {
      expect(result.fields[fieldSpec.name]).toMatchObject({ kind: "unreadable", reason: "io" });
    }
  });
});
