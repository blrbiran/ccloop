import type { OwnerRecord } from "../runtime/types.js";

export const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
// >= 3x the interval, so two consecutive missed refreshes do not expire a healthy run.
export const LEASE_TTL_MS = 90_000;
export const LEASE_AFFIRM_THROTTLE_MS = 10_000;
export const LEASE_VERIFY_READ_ATTEMPTS = 3;
export const LEASE_VERIFY_RETRY_DELAY_MS = 50;

export class RunLeaseHeldError extends Error {
  constructor(
    readonly holderProcessInstanceId: string,
    readonly remainingTtlMs: number,
  ) {
    super(`run lease is held by ${holderProcessInstanceId} for another ${remainingTtlMs}ms`);
    this.name = "RunLeaseHeldError";
  }
}

export class RunLeaseLostError extends Error {
  readonly stopReason = "lease_lost";

  constructor(message: string) {
    super(message);
    this.name = "RunLeaseLostError";
  }
}

export class RunLeaseUnverifiableError extends Error {
  readonly stopReason = "lease_unverifiable";

  constructor(message: string) {
    super(message);
    this.name = "RunLeaseUnverifiableError";
  }
}

// Sibling of RunLeaseLostError and RunLeaseUnverifiableError, deliberately NOT a subclass of
// either — and they must not be given a common base class either: this error says "this process's
// own heartbeat has stopped", which is neither "someone else owns this run" nor "this run's
// ownership could not be read". The entire safety of L3 §5.3's option (a) rests on
// isLeaseStopError (src/controller/runLoop.ts) NOT matching it: that predicate's branch persists
// the terminal "cancelled" status, and no path in this codebase leads out of a terminal status,
// so one stop signal would end the run permanently. A subclass would make that predicate start
// matching without a single character of it changing, and no test name would hint at the cause.
export class RunHeartbeatStoppedError extends Error {
  readonly stopReason = "heartbeat_stopped";

  constructor(message: string) {
    super(message);
    this.name = "RunHeartbeatStoppedError";
  }
}

// §5: a total function on a validated record. `null`, an absent field and an unparseable
// timestamp all answer "not fresh" — but only as a defensive default. The rule that
// governs a malformed record is parseOwnerRecordForLease's refusal, not this `false`.
export function isLeaseFresh(record: OwnerRecord, nowMs: number, ttlMs: number): boolean {
  const affirmedAt = record.leaseAffirmedAt;

  if (typeof affirmedAt !== "string") {
    return false;
  }

  const affirmedAtMs = Date.parse(affirmedAt);

  if (Number.isNaN(affirmedAtMs)) {
    return false;
  }

  return nowMs - affirmedAtMs < ttlMs;
}

// §7: readOwnerRecordRaw is a bare JSON.parse plus a cast, so it accepts a structurally
// invalid record silently. The gate validates the fields it depends on itself, and a
// failure here is a REFUSAL, never "no lease here".
//
// Returns the input object unchanged. It must not normalize an absent leaseAffirmedAt
// into an explicit null: the returned record is used as the `expected` side of a CAS that
// compares JSON.stringify output, and adding a key would make every such CAS fail.
export function parseOwnerRecordForLease(raw: unknown): OwnerRecord {
  const invalid = (detail: string): never => {
    throw new Error(`owner record is structurally invalid: ${detail}`);
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("not a JSON object");
  }

  const record = raw as Partial<OwnerRecord>;

  if (typeof record.currentProcessInstanceId !== "string" || record.currentProcessInstanceId === "") {
    return invalid("currentProcessInstanceId is missing or not a non-empty string");
  }

  if (typeof record.currentOwnerEpoch !== "number" || !Number.isInteger(record.currentOwnerEpoch)) {
    return invalid("currentOwnerEpoch is missing or not an integer");
  }

  // §7: absent means null — a record predating this design, carrying no lease. Present
  // but neither a string nor null is malformed.
  if (
    "leaseAffirmedAt" in record
    && record.leaseAffirmedAt !== null
    && typeof record.leaseAffirmedAt !== "string"
  ) {
    return invalid("leaseAffirmedAt is neither a string nor null");
  }

  return raw as OwnerRecord;
}
