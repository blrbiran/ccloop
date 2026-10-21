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

const ALL_PHASES: ToolRulePhase[] = ["plan", "execute", "verify"];
const SECRET_REASON = "declared only: ccloop does not filter the agent's environment (the place to hold a secret back is the environment ccloop is started with)";

/** What requiredCheckAllowRules (claudeAgentAdapter.ts) answers; passed in so this module stays a leaf the schema can import. */
export type ClaudeAllowRulesOf = (commands: readonly string[]) => { rules: string[]; notAllowed: Array<{ command: string; reason: string }> };

/**
 * One command rule as a claude allow rule, or why not (spec §4 claude rows; claude 2.1.306, plan "Measurements"): the
 * value passes requiredCheckAllowRules' refusals and §3.1's separators; exact ⇒ `Bash(<value>)`, prefix ⇒ `Bash(<value> *)`
 * (compiled by claude to `^value( .*)?$` because that trailing ` *` is the rule's only `*`).
 */
function claudeGrant(rule: ToolCommandRuleV1, allowRulesOf: ClaudeAllowRulesOf): { grant: string } | { refused: string } {
  const separator = separatorRefusal(rule.value);
  if (separator !== null) return { refused: separator };
  const { rules, notAllowed } = allowRulesOf([rule.value]);
  if (notAllowed.length > 0 || rules.length !== 1) return { refused: notAllowed[0]?.reason ?? "not expressible as one claude rule" };
  return { grant: rule.kind === "exact" ? rules[0]! : `Bash(${rule.value} *)` };
}

/**
 * The claude list options for one phase: `allow` is the required-check rules (unchanged), then on execute the grants
 * (de-duplicated) and, with network:true, WebFetch and WebSearch; `disallow` is WebFetch and WebSearch on every phase
 * with network:false. No rules ⇒ exactly the required-check rules, nothing denied.
 */
export function claudeToolRuleArgs(rules: ToolRulesV1 | undefined, phase: ToolRulePhase, requiredCheckRules: readonly string[], allowRulesOf: ClaudeAllowRulesOf): { allow: string[]; disallow: string[] } {
  const allow = [...requiredCheckRules];
  if (rules === undefined) return { allow, disallow: [] };
  const add = (entry: string) => { if (!allow.includes(entry)) allow.push(entry); };
  if (phase === "execute") {
    for (const rule of rules.commands) {
      const grant = claudeGrant(rule, allowRulesOf);
      if ("grant" in grant) add(grant.grant);
    }
    if (rules.network) { add("WebFetch"); add("WebSearch"); }
  }
  return { allow, disallow: rules.network ? [] : ["WebFetch", "WebSearch"] };
}

const CLOSED_MODES = new Set(["acceptEdits", "default", "manual"]);
const LIST_OPTIONS = new Set(["--allowedTools", "--allowed-tools"]);

/** claude's --allowedTools splitter (claudeAgentAdapter.ts note): commas and whitespace separate entries outside parentheses. */
function splitToolList(text: string): string[] {
  const out: string[] = [];
  let current = "", inside = false;
  for (const char of text) {
    if (char === "(") inside = true;
    else if (char === ")") inside = false;
    if (!inside && (char === "," || /\s/.test(char))) { if (current !== "") out.push(current); current = ""; continue; }
    current += char;
  }
  if (current !== "") out.push(current);
  return out;
}

/**
 * Why the installation does not keep un-granted Bash commands out in -p, or null when it does (spec §3.4; plan
 * "Controller calls"): the mode is the --permission-mode flag, else an inline --settings `permissions.defaultMode`, and
 * must be acceptEdits, default or manual; no skip-permissions flag, no --permission-prompt-tool / --sdk-url (they route
 * asks to a host), no settings file path (not read), no inline `sandbox` key (autoAllowBashIfSandboxed), and every
 * installation Bash allow an exact rule. `seen` collects the exact allows and the effective mode for the baseline.
 */
function claudeOpenReason(command: readonly string[], allowRulesOf: ClaudeAllowRulesOf, seen: { exactAllows: string[]; mode?: string }): string | null {
  let mode: string | undefined, settingsMode: string | undefined;
  const allows: string[] = [];
  for (let i = 0; i < command.length; i += 1) {
    const arg = command[i]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? command[++i];
    if (name === "--dangerously-skip-permissions" || name === "--allow-dangerously-skip-permissions") return `the installation command has ${name}`;
    if (name === "--permission-prompt-tool" || name === "--sdk-url") return `the installation command has ${name}, which answers permission prompts instead of denying them`;
    if (name === "--permission-mode") mode = value();
    else if (LIST_OPTIONS.has(name)) {
      if (inline !== undefined) allows.push(...splitToolList(inline));
      else while (command[i + 1] !== undefined && !command[i + 1]!.startsWith("-")) allows.push(...splitToolList(command[++i]!));
    } else if (name === "--settings") {
      const text = (value() ?? "").trim();
      if (!(text.startsWith("{") && text.endsWith("}"))) return "the installation's --settings is a file ccloop does not read";
      let settings: unknown;
      try { settings = JSON.parse(text); } catch { return "the installation's inline --settings is not JSON"; }
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return "the installation's inline --settings is not an object";
      const record = settings as { sandbox?: unknown; permissions?: { defaultMode?: unknown; allow?: unknown } };
      if (record.sandbox !== undefined) return "the installation's inline --settings has a sandbox key (sandboxed Bash is auto-allowed)";
      if (typeof record.permissions?.defaultMode === "string") settingsMode = record.permissions.defaultMode;
      if (Array.isArray(record.permissions?.allow)) for (const entry of record.permissions.allow) allows.push(String(entry));
    }
  }
  const effective = mode ?? settingsMode;
  seen.mode = effective;
  if (effective === undefined) return "the installation sets no permission mode; project or user settings may";
  if (!CLOSED_MODES.has(effective)) return `the installation's permission mode ${effective} does not deny un-granted Bash commands`;
  for (const entry of allows) {
    if (entry !== "Bash" && !entry.startsWith("Bash(")) continue;
    const content = entry.startsWith("Bash(") && entry.endsWith(")") ? entry.slice(5, -1) : null;
    const exact = content === null || content.includes(":*") ? null : allowRulesOf([content]);
    if (exact === null || exact.notAllowed.length > 0 || exact.rules.length !== 1) return `the installation allows ${entry}, which is not one exact command`;
    if (!seen.exactAllows.includes(entry)) seen.exactAllows.push(entry);
  }
  return null;
}

/** The claude report rows and baseline (spec §3.3, §3.4, §4 claude column). */
export function claudeToolRuleRows(rules: ToolRulesV1, installationCommand: readonly string[], allowRulesOf: ClaudeAllowRulesOf): { rows: ToolRuleRowV1[]; baseline: string } {
  const seen: { exactAllows: string[]; mode?: string } = { exactAllows: [] };
  const open = claudeOpenReason(installationCommand, allowRulesOf, seen);
  const exactAllows = seen.exactAllows, acceptEdits = seen.mode === "acceptEdits";
  const rows: ToolRuleRowV1[] = [open === null
    ? { rule: { kind: "commands-closed" }, status: "enforced", reason: null, phases: [...ALL_PHASES] }
    : { rule: { kind: "commands-closed" }, status: "recorded-only", reason: boundedText(open, 512), phases: [] }];
  for (const rule of rules.commands) {
    const grant = claudeGrant(rule, allowRulesOf);
    rows.push("grant" in grant ? { rule: { ...rule }, status: "enforced", reason: null, phases: ["execute"] }
      : { rule: { ...rule }, status: "refused", reason: boundedText(grant.refused, 512), phases: [] });
  }
  rows.push(rules.network
    ? { rule: { kind: "network", value: true }, status: "enforced", reason: null, phases: ["execute"] }
    : { rule: { kind: "network", value: false }, status: "recorded-only", reason: "WebFetch and WebSearch are denied on every phase, but Bash, MCP tools and other tools can still reach the network", phases: [...ALL_PHASES] });
  for (const name of rules.secretEnv) rows.push({ rule: { kind: "secretEnv", name }, status: "recorded-only", reason: SECRET_REASON, phases: [] });
  const baseline = [
    "claude also admits without a rule: its built-in read-only Bash set (e.g. ls, cat, pwd, echo, grep, git status/diff/log with safe flags)",
    ...(acceptEdits ? ["acceptEdits' mkdir, touch, rm, rmdir, mv, cp, sed"] : []),
    "a granted command behind wrappers it strips (timeout, nice, nohup, safe NAME=value), with redirections, and xargs <prefix> for prefix rules",
    ...(exactAllows.length > 0 ? [`the installation's exact allows ${exactAllows.join(", ")}`] : []),
    "and whatever .claude/settings.json, settings.local.json and the person's settings loaded by --setting-sources allow (not read by ccloop)",
  ].join("; ");
  return { rows, baseline: boundedText(baseline, 1024) };
}
