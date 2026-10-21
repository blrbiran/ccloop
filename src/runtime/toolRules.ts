import { z } from "zod";

/**
 * Per-contract tool rules (ccloop spec docs/superpowers/specs/2026-10-22-per-contract-tool-rules-design.md; plan
 * docs/superpowers/plans/2026-10-22-per-contract-tool-rules.md). One pure module: the contract field's schema, each kind's
 * mapping to its own mechanisms (never wider than the rule, spec §3.2), the omp after-exit check and the report rows.
 */

export type ToolCommandRuleV1 = { kind: "exact" | "prefix"; value: string };
export type ToolRulesV1 = { commands: ToolCommandRuleV1[]; network: boolean; secretEnv: string[] };
export type ToolRuleStatus = "enforced" | "detected" | "recorded-only" | "refused";
export type ToolRulePhase = "plan" | "execute" | "verify";
export type ToolRuleRowV1 = {
  rule: { kind: "commands-closed" } | ToolCommandRuleV1 | { kind: "network"; value: boolean } | { kind: "secretEnv"; name: string };
  status: ToolRuleStatus;
  reason: string | null;
  phases: ToolRulePhase[];
  present?: boolean;
};
export type ToolRulesReportV1 = { schema: "ccloop-tool-rules-report-v1"; agentKind: "claude" | "codex" | "omp"; baseline: string; rules: ToolRuleRowV1[] };

// Spec §2: bounds are UTF-8 bytes (zod's .max counts UTF-16 code units), as protocol.ts utf8Bounded.
const commandValue = z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 4096 && !value.includes("\u0000"));
const commandRule = z.object({ kind: z.enum(["exact", "prefix"]), value: commandValue }).strict();
const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

/** Spec §2: strict at every level, every key required, no default anywhere -- one rule set has exactly one spelling. */
export const toolRulesSchema = z.object({
  commands: z.array(commandRule).max(64)
    .refine((commands) => new Set(commands.map((rule) => JSON.stringify([rule.kind, rule.value]))).size === commands.length),
  network: z.boolean(),
  secretEnv: z.array(secretName).max(32).refine((names) => new Set(names).size === names.length),
}).strict();

const SEPARATOR_REASON = "a compound command cannot be one rule";
/** Spec §3.1: a value with a shell separator (`&`, `|`, `;`, newline) is refused on every kind. */
export function separatorRefusal(value: string): string | null {
  return /[&|;\n]/.test(value) ? SEPARATOR_REASON : null;
}

/** Head of `text` within `maxBytes` UTF-8 bytes, cut back to a code-point boundary (failureCause.ts causeDetail). */
export function boundedText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
