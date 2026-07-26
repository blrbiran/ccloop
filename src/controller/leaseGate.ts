import { isLeaseFresh, LEASE_TTL_MS, parseOwnerRecordForLease, RunLeaseHeldError } from "../ownership/lease.js";
import { appendEvent, readOwnerRecordWithoutRecovery } from "../persistence/fileStore.js";
import type { OwnerRecord } from "../runtime/types.js";

export type LeaseGateOutcome =
  | { kind: "no_record" }
  | { kind: "no_lease"; ownerRecord: OwnerRecord }
  | { kind: "held_by_self"; ownerRecord: OwnerRecord }
  | { kind: "expired"; ownerRecord: OwnerRecord };

// §7. Runs as early as possible, but never before initializeRunFiles, because it may append
// an event and events.jsonl does not exist before that call.
//
// Reads RAW (§7.1): readOwnerRecord would run recoverInterruptedOwnerTransfer first, so a
// refusal would trigger crash recovery as a side effect.
export async function checkRunLease(
  runDir: string,
  selfProcessInstanceId: string,
  nowMs: number = Date.now(),
): Promise<LeaseGateOutcome> {
  let raw: unknown;

  try {
    raw = await readOwnerRecordWithoutRecovery(runDir);
  } catch (error) {
    // ONLY ENOENT means "brand-new run directory, so there is no lease". Every other read
    // failure — unreadable file, malformed JSON — is a refusal, never "no lease here".
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "no_record" };
    }

    throw error;
  }

  const ownerRecord = parseOwnerRecordForLease(raw);
  const leaseAffirmedAt = ownerRecord.leaseAffirmedAt ?? null;

  if (leaseAffirmedAt === null) {
    // §5.0: owned, but nobody is running it. This is the post-transfer state, and the
    // gate must take no position on it.
    return { kind: "no_lease", ownerRecord };
  }

  if (!isLeaseFresh(ownerRecord, nowMs, LEASE_TTL_MS)) {
    // §7: expiry neither permits nor refuses. Record the observation so later layers can
    // see it instead of it being silently swallowed, then pass control on unchanged.
    // The detail names the EXPIRY instant (affirmation + TTL), not the affirmation instant:
    // later layers consume this event as "when did the lease lapse", and the last affirmation
    // is a different, earlier moment. Both are recorded so neither has to be reconstructed.
    //
    // isLeaseFresh also answers "not fresh" for an unparseable timestamp, which has no expiry
    // instant to name — and computing one anyway would throw RangeError out of the gate,
    // turning an observation the gate is required to pass through into a crash.
    const leaseAffirmedAtMs = Date.parse(leaseAffirmedAt);
    const expiredAt = Number.isNaN(leaseAffirmedAtMs)
      ? "an unparseable instant"
      : new Date(leaseAffirmedAtMs + LEASE_TTL_MS).toISOString();
    await appendEvent(runDir, {
      type: "lease_expired_observed",
      at: new Date(nowMs).toISOString(),
      detail: `lease held by ${ownerRecord.currentProcessInstanceId} expired at ${expiredAt} (last affirmed ${leaseAffirmedAt})`,
    });
    return { kind: "expired", ownerRecord };
  }

  // §5.1: opaque, compared only for string equality. A legacy `pid:<pid>` record and a
  // recycled PID with a different start time both fail this comparison, which can only
  // add refusals.
  if (ownerRecord.currentProcessInstanceId !== selfProcessInstanceId) {
    const remainingTtlMs = LEASE_TTL_MS - (nowMs - Date.parse(leaseAffirmedAt));
    throw new RunLeaseHeldError(ownerRecord.currentProcessInstanceId, remainingTtlMs);
  }

  return { kind: "held_by_self", ownerRecord };
}
