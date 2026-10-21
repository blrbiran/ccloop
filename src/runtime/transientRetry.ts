import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RETRYABLE_CAUSES, type CallClassification } from "./failureCause.js";
import type { AttemptContext } from "./types.js";

/**
 * Transient retries inside one phase (ccloop spec docs/superpowers/specs/2026-10-21-failure-causes-and-transient-retries-design.md
 * §4), generalising codex's 429 backoff (spec 2026-10-13) to every kind's phases. Single calls are not retried here: their
 * callers own retries.
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];

/**
 * What one failed try booked (spec §4 "Usage"): `rule0` under the two existing zero rules (never started; codex 429 before
 * work), `tokens` when usage was observed, `null` when nothing could be observed.
 */
export type TryObservation = { kind: "rule0" } | { kind: "tokens"; tokens: number } | { kind: "null" };

export type TryResult<T> =
  | { ok: true; value: T; evidenceDir: string }
  | {
    ok: false; error: Error; evidenceDir: string;
    /** null: the try is not classified (an abort, or a completed codex turn); never retried. */
    classification: CallClassification | null;
    /** Spec §4 "Retry-safety, per kind": the caller's verdict for this try. */
    retrySafe: boolean;
    observation: TryObservation;
    /** Called once the loop decided the try's next delay (null: no retry); codex writes rate-limit.json here. */
    onDecided?: (call: number, nextDelayMs: number | null) => Promise<void>;
  };

/** Spec §4 "Time": the phase limit, taken once at phase start. */
export function phaseLimitMs(installationTimeoutMs: number, context: AttemptContext): number {
  const perAttempt = context.contract?.executionPolicy?.perAttemptTimeoutMs;
  return Math.min(installationTimeoutMs, typeof perAttempt === "number" ? perAttempt : Number.POSITIVE_INFINITY, context.state.budgetSnapshot.timeRemainingMs);
}

/** A copy of the context whose remaining time is what this try may use (spec §4: each try's timer is L − elapsed). */
export function tryContext(context: AttemptContext, tryLimitMs: number): AttemptContext {
  return { ...context, state: { ...context.state, budgetSnapshot: { ...context.state.budgetSnapshot, timeRemainingMs: tryLimitMs } } };
}

/** Resolves after ms, or at once when the signal aborts (the next call then reports the abort through its own path). */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const ZERO_FLAGS = ["neverStarted", "rateLimitedBeforeWork"] as const;

/**
 * Runs `attempt` until it succeeds, fails with a cause that is not retryable or not safe to retry, the delays are used up,
 * the next delay would not fit in `limitMs`, or the run is aborted. The phase books the sum over all its tries (spec §4,
 * round 2 I-A): a success gains the earlier tries' observed tokens; a final failure carries the sum as observedTokens, keeps
 * a zero flag only when every try booked 0 by rule, and answers null when some try was unobserved and the sum is 0.
 */
export async function runWithTransientRetry<T>(options: {
  limitMs: number;
  delaysMs: readonly number[];
  signal?: AbortSignal;
  attempt: (tryLimitMs: number, call: number) => Promise<TryResult<T>>;
}): Promise<T> {
  const startedAt = Date.now();
  let priorTokens = 0, unobserved = 0, allRule0 = true;
  for (let call = 1; ; call++) {
    const elapsed = Date.now() - startedAt;
    const result = await options.attempt(Math.max(0, options.limitMs - elapsed), call);
    if (result.ok) {
      if (call === 1) return result.value;
      const value = result.value as T & { tokenUsage?: unknown };
      if (value !== null && typeof value === "object" && (priorTokens > 0 || typeof value.tokenUsage === "number")) {
        (value as { tokenUsage?: number }).tokenUsage = (typeof value.tokenUsage === "number" ? value.tokenUsage : 0) + priorTokens;
      }
      await writeFile(join(result.evidenceDir, "retry-usage.json"), JSON.stringify({ priorTries: call - 1, priorObservedTokens: priorTokens, retriedTriesUnobserved: unobserved }), { mode: 0o600 }).catch(() => undefined);
      return result.value;
    }
    const { classification, observation } = result;
    const retryable = classification !== null && RETRYABLE_CAUSES.has(classification.cause) && result.retrySafe;
    const delay = options.delaysMs[call - 1];
    const next = retryable && delay !== undefined && Date.now() - startedAt + delay < options.limitMs && !options.signal?.aborted ? delay : null;
    await result.onDecided?.(call, next);
    if (classification !== null) {
      await writeFile(join(result.evidenceDir, "failure-cause.json"), JSON.stringify({
        cause: classification.cause, workObserved: classification.workObserved, call, nextDelayMs: next, detail: classification.detail,
        usageObserved: observation.kind !== "null",
        ...(next === null && call > 1 ? { retriedTriesUnobserved: unobserved } : {}),
      }), { mode: 0o600 }).catch(() => undefined); // Best-effort evidence: never replaces the call's own failure.
    }
    if (next === null) {
      const error = result.error;
      if (call > 1) {
        const tokens = priorTokens + (observation.kind === "tokens" ? observation.tokens : 0);
        const anyNull = unobserved > 0 || observation.kind === "null";
        if (!(allRule0 && observation.kind === "rule0")) {
          for (const flag of ZERO_FLAGS) delete (error as unknown as Record<string, unknown>)[flag];
          (error as unknown as { observedTokens?: number | null }).observedTokens = tokens > 0 ? tokens : anyNull ? null : 0;
        }
      }
      if (classification !== null) {
        Object.defineProperty(error, "failureCause", { value: { ...classification, retries: call - 1 }, enumerable: true, configurable: true, writable: true });
      }
      throw error;
    }
    if (observation.kind === "tokens") { priorTokens += observation.tokens; allRule0 = false; }
    else if (observation.kind === "null") { unobserved += 1; allRule0 = false; }
    await wait(next, options.signal);
  }
}
