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
