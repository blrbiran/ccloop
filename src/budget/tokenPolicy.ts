import { z } from "zod";

const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const amountSchema = z.object({ tokens: safe, activeMs: safe, attempts: safe, sessions: safe }).strict();
export const budgetAmountSchema = amountSchema.extend({ tokens: safe.nullable() });
export type Amount = z.infer<typeof amountSchema>;
export type BudgetAmount = z.infer<typeof budgetAmountSchema>;
export type TokenRemainingStatus = "known" | "unlimited" | "unknown";

export function remainingTokens(limit: number | null, used: number): number | null {
  safe.parse(used);
  safe.nullable().parse(limit);
  return limit === null ? null : Math.max(0, limit - used);
}
export function minTokenCeiling(left: number | null, right: number | null): number | null {
  safe.nullable().parse(left); safe.nullable().parse(right);
  return left === null ? right : right === null ? left : Math.min(left, right);
}
export function remainingBudget(limit: BudgetAmount, used: Amount): BudgetAmount {
  budgetAmountSchema.parse(limit); amountSchema.parse(used);
  return { tokens: remainingTokens(limit.tokens, used.tokens), activeMs: Math.max(0, limit.activeMs-used.activeMs), attempts: Math.max(0, limit.attempts-used.attempts), sessions: Math.max(0, limit.sessions-used.sessions) };
}
export function budgetFits(used: Amount, limit: BudgetAmount): boolean {
  amountSchema.parse(used); budgetAmountSchema.parse(limit);
  return (limit.tokens === null || used.tokens <= limit.tokens) && used.activeMs <= limit.activeMs && used.attempts <= limit.attempts && used.sessions <= limit.sessions;
}
/**
 * Live token threshold (ccloop issue #225; spec 2026-11-10-live-token-threshold-design.md). Human ruling R4: budgets are soft,
 * no hard cap is promised, but a phase an adapter can stop mid-call (claude, omp) is stopped once its observed total passes
 * the remainder it started with by this factor. Not a contract field.
 */
export const LIVE_TOKEN_THRESHOLD_FACTOR = 1.2;
/** The abort reason of a phase stopped at the threshold, so an adapter can book what it observed instead of a floor. */
export const LIVE_TOKEN_STOP_REASON = "ccloop-live-token-threshold";
/** The observed phase total above which the phase is stopped; null (no ceiling) never stops. */
export function liveTokenThreshold(remainingBeforePhase: number | null): number | null {
  return remainingBeforePhase === null ? null : Math.ceil(remainingBeforePhase * LIVE_TOKEN_THRESHOLD_FACTOR);
}
/** Null remaining alone is never evidence of an unlimited policy. */
export function tokenRemainingStatus(ceiling: number | null | undefined, usageKnown: boolean): TokenRemainingStatus {
  return !usageKnown || ceiling === undefined ? "unknown" : ceiling === null ? "unlimited" : "known";
}

export const tokenPolicySchema = z.object({
  authoredTokenCeiling: safe.nullable(),
  bindingCauses: z.array(z.enum(["task", "group", "spend-cap"])).refine(values => new Set(values).size === values.length),
  inheritedUsage: amountSchema,
}).strict();
export type TokenPolicy = z.infer<typeof tokenPolicySchema>;
