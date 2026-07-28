import type { FieldObservation, FieldType, FileObservation, ObservedFileSpec } from "./types.js";

// Field names and types verified against src/state/types.ts:26-35 and
// src/runtime/types.ts:82-104 (spec §6). Do not re-derive these by guessing.
export const OBSERVED_FILES: readonly ObservedFileSpec[] = [
  {
    file: "loop-state.json",
    atomic: false,
    fields: [
      { name: "status", type: "string" },
      { name: "currentAttempt", type: "number" },
      { name: "attemptsUsed", type: "number" },
      { name: "lastTransitionAt", type: "string" },
      { name: "stopReason", type: "string-or-null" },
    ],
  },
  {
    file: "owner-record.json",
    atomic: false,
    fields: [
      { name: "runId", type: "string" },
      { name: "currentOwnerEpoch", type: "integer" },
      { name: "ownerStatus", type: "string" },
      { name: "currentProcessInstanceId", type: "string" },
      { name: "leaseAffirmedAt", type: "string-or-null" },
    ],
  },
  {
    file: "owner-transfer.json",
    atomic: true,
    fields: [{ name: "eligibleForContinuation", type: "literal-true" }],
  },
];

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string-or-null":
      return typeof value === "string" || value === null;
    case "literal-true":
      return value === true;
  }
}

// Per-field observation, deliberately not delegating to any existing validator
// (e.g. parseOwnerRecordForLease): this layer assigns no meaning to values, so each
// field is observed independently rather than collapsing the whole record to a
// single verdict. See spec §7.3.
export function observeFields(parsed: unknown, spec: ObservedFileSpec): FileObservation {
  const isRecord = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const record = isRecord ? (parsed as Record<string, unknown>) : undefined;

  const fields: Record<string, FieldObservation> = {};

  for (const fieldSpec of spec.fields) {
    if (!record) {
      fields[fieldSpec.name] = {
        kind: "unreadable",
        reason: "shape",
        detail: `expected an object, got ${describe(parsed)}`,
      };
      continue;
    }

    if (!(fieldSpec.name in record)) {
      fields[fieldSpec.name] = { kind: "absent" };
      continue;
    }

    const value = record[fieldSpec.name];

    if (!matchesType(value, fieldSpec.type)) {
      fields[fieldSpec.name] = {
        kind: "unreadable",
        reason: "shape",
        detail: `expected ${fieldSpec.type}, got ${describe(value)}`,
      };
      continue;
    }

    fields[fieldSpec.name] = { kind: "present", value };
  }

  return { file: spec.file, fields };
}
