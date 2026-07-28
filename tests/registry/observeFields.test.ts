import { describe, expect, it } from "vitest";
import { observeFields, OBSERVED_FILES } from "../../src/registry/observeFields.js";
import type { ObservedFileSpec } from "../../src/registry/types.js";

function specFor(file: string): ObservedFileSpec {
  const spec = OBSERVED_FILES.find((s) => s.file === file);
  if (!spec) throw new Error(`no spec for ${file}`);
  return spec;
}

const loopStateSpec = specFor("loop-state.json");
const ownerRecordSpec = specFor("owner-record.json");
const ownerTransferSpec = specFor("owner-transfer.json");

describe("OBSERVED_FILES", () => {
  it("contains exactly the three spec'd files with their declared fields", () => {
    expect(OBSERVED_FILES.map((s) => s.file)).toEqual([
      "loop-state.json",
      "owner-record.json",
      "owner-transfer.json",
    ]);

    expect(loopStateSpec.atomic).toBe(false);
    expect(loopStateSpec.fields.map((f) => f.name)).toEqual([
      "status",
      "currentAttempt",
      "attemptsUsed",
      "lastTransitionAt",
      "stopReason",
    ]);

    expect(ownerRecordSpec.atomic).toBe(false);
    expect(ownerRecordSpec.fields.map((f) => f.name)).toEqual([
      "runId",
      "currentOwnerEpoch",
      "ownerStatus",
      "currentProcessInstanceId",
      "leaseAffirmedAt",
    ]);

    expect(ownerTransferSpec.atomic).toBe(true);
    expect(ownerTransferSpec.fields.map((f) => f.name)).toEqual(["eligibleForContinuation"]);
  });
});

describe("observeFields", () => {
  // Requirement 1: a field present with the right type is reported present, carrying the value.
  it("reports a present field of the right type as present, carrying its value", () => {
    const result = observeFields({ status: "queued" }, loopStateSpec);
    expect(result.fields.status).toEqual({ kind: "present", value: "queued" });
  });

  // Requirement 2: missing field is absent, never unreadable. Kills an implementation that
  // collapses "missing" into "unreadable" (spec §11 rows 4 and 5 are distinct).
  it("reports a field missing from the parsed object as absent, not unreadable", () => {
    const result = observeFields({ currentOwnerEpoch: 1 }, ownerRecordSpec);
    expect(result.fields.runId).toEqual({ kind: "absent" });
  });

  // Requirement 3: field present with the wrong JSON type is unreadable/shape.
  it("reports a field of the wrong JSON type as unreadable with reason shape", () => {
    const result = observeFields(
      { currentOwnerEpoch: "1", leaseAffirmedAt: 12345 },
      ownerRecordSpec,
    );

    expect(result.fields.currentOwnerEpoch).toMatchObject({ kind: "unreadable", reason: "shape" });
    expect(result.fields.leaseAffirmedAt).toMatchObject({ kind: "unreadable", reason: "shape" });
  });

  // Requirement 4: observation granularity is per-field, not per-file. This is the one
  // assertion that distinguishes per-field observation from delegating to
  // parseOwnerRecordForLease, which THROWS on a non-integer currentOwnerEpoch and so could
  // only mark the whole file unreadable -- losing the fields that were fine (spec §7.3
  // consequence 1). Do not import parseOwnerRecordForLease here.
  it("observes each field independently: a bad currentOwnerEpoch does not blank out the rest of the row", () => {
    const result = observeFields(
      {
        runId: "task-1",
        currentOwnerEpoch: "not-an-integer",
        ownerStatus: "current",
        currentProcessInstanceId: "pid:1:1",
        leaseAffirmedAt: null,
      },
      ownerRecordSpec,
    );

    expect(result.fields.runId).toEqual({ kind: "present", value: "task-1" });
    expect(result.fields.currentOwnerEpoch).toMatchObject({ kind: "unreadable", reason: "shape" });
    expect(result.fields.ownerStatus).toEqual({ kind: "present", value: "current" });
    expect(result.fields.currentProcessInstanceId).toEqual({ kind: "present", value: "pid:1:1" });
    expect(result.fields.leaseAffirmedAt).toEqual({ kind: "present", value: null });
  });

  // Requirement 5: runId and ownerStatus are observed at all -- parseOwnerRecordForLease
  // validates neither, so an implementation trusting "the parser passed" would never
  // surface either field's corruption.
  it("observes runId and ownerStatus: absent when missing, unreadable/shape when non-string", () => {
    const missing = observeFields(
      { currentOwnerEpoch: 1, currentProcessInstanceId: "pid:1:1" },
      ownerRecordSpec,
    );
    expect(missing.fields.runId).toEqual({ kind: "absent" });
    expect(missing.fields.ownerStatus).toEqual({ kind: "absent" });

    const wrongType = observeFields(
      { runId: 42, ownerStatus: true, currentOwnerEpoch: 1, currentProcessInstanceId: "pid:1:1" },
      ownerRecordSpec,
    );
    expect(wrongType.fields.runId).toMatchObject({ kind: "unreadable", reason: "shape" });
    expect(wrongType.fields.ownerStatus).toMatchObject({ kind: "unreadable", reason: "shape" });
  });

  // Requirement 6: null is a value, not an absence. Kills a truthiness check.
  it("reports stopReason: null as present with value null, not absent", () => {
    const result = observeFields({ stopReason: null }, loopStateSpec);
    expect(result.fields.stopReason).toEqual({ kind: "present", value: null });
  });

  // Requirement 7: leaseAffirmedAt entirely absent is absent, not normalized to null.
  // OwnerRecord documents absent-means-null for legacy records, but the registry reports
  // the raw observation (src/runtime/types.ts:90-93).
  it("reports leaseAffirmedAt absent entirely as absent, without normalizing to null", () => {
    const result = observeFields(
      { runId: "task-1", currentOwnerEpoch: 1, ownerStatus: "current", currentProcessInstanceId: "pid:1:1" },
      ownerRecordSpec,
    );
    expect(result.fields.leaseAffirmedAt).toEqual({ kind: "absent" });
  });

  // Requirement 8: eligibleForContinuation's declared type is the literal true. Anything
  // else -- including false or the string "true" -- means corruption (spec §6.2).
  it.each([
    ["false", false],
    ["the string \"true\"", "true"],
  ])("reports eligibleForContinuation: %s as unreadable/shape", (_label, value) => {
    const result = observeFields({ eligibleForContinuation: value }, ownerTransferSpec);
    expect(result.fields.eligibleForContinuation).toMatchObject({ kind: "unreadable", reason: "shape" });
  });

  // Requirement 9: a non-object parsed value marks every spec'd field unreadable/shape,
  // never throws. Explicitly covers null, since typeof null === "object" is a trap that
  // only an explicit null case catches.
  it.each([
    ["an array", []],
    ["a string", "not an object"],
    ["null", null],
  ])("marks every field unreadable/shape for a non-object parsed value (%s), without throwing", (_label, value) => {
    expect(() => observeFields(value, ownerRecordSpec)).not.toThrow();
    const result = observeFields(value, ownerRecordSpec);

    for (const fieldSpec of ownerRecordSpec.fields) {
      expect(result.fields[fieldSpec.name]).toMatchObject({ kind: "unreadable", reason: "shape" });
    }
  });
});
