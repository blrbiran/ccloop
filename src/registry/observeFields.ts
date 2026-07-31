import type { FieldObservation, FieldType, FileObservation, ObservedFileSpec } from "./types.js";

// Field names and types verified against src/state/types.ts:26-35 and
// src/runtime/types.ts:82-104 (spec §6). Do not re-derive these by guessing.
export const OBSERVED_FILES: readonly ObservedFileSpec[] = [
  {
    file: "loop-state.json",
    // Kept false deliberately, and it no longer means "written non-atomically": both writers of
    // loop-state.json (initializeRunFiles and writeRunState, fileStore.ts:77 and :82) now publish
    // by rename. The bounded re-read in readObservedFile is retained as defence in depth, so the
    // safety net survives if a non-atomic write point is ever added back. Flipping this to true
    // would change L2's read behaviour, which is outside that branch's scope (spec §5).
    //
    // The retained cost is bounded and rarely paid: readObservedFile retries only on a parse
    // failure (readObservedFile.ts:118 continues for SyntaxError alone — ENOENT becomes `absent`
    // and any other error becomes unreadable(io), both without retrying), and it is capped at
    // LEASE_VERIFY_READ_ATTEMPTS = 3 attempts spaced by LEASE_VERIFY_RETRY_DELAY_MS = 50ms
    // (lease.ts:7-8). Sleeps run between attempts only, so the worst case is 2 × 50ms ≈ 100ms.
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
    // Same story as loop-state.json above: owner-record.json is published by rename on every path
    // that writes it (writeOwnerRecord via writeJsonFileAtomically, plus the transfer
    // transaction's writeOwnerRecordAtomically and finalizePendingOwnerTransfer, which both
    // rename into place), and this stays false as the same defence in depth, at the same bounded
    // cost.
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
