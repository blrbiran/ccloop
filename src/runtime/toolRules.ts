import { z } from "zod";
import type { CodexNetworkSetting } from "../agents/codexNetworkConfig.js";
import { foldText, type JsonLine } from "./streamLines.js";

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
/**
 * Spec §3.1: a value with a shell separator (`&`, `|`, `;`, newline) is refused on every kind. Review round 1 follow-up
 * (Orca session b37f7ce9): a carriage return counts as a newline, so it can neither split a command nor add prompt lines.
 */
export function separatorRefusal(value: string): string | null {
  return /[&|;\n\r]/.test(value) ? SEPARATOR_REASON : null;
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
/** Review round 1 (Orca session b37f7ce9, M5): tools besides Bash that run commands or reach outside the Bash rules. */
const OTHER_COMMAND_TOOLS = new Set(["Monitor", "PowerShell", "REPL"]);

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
function claudeOpenReason(command: readonly string[], allowRulesOf: ClaudeAllowRulesOf, seen: { exactAllows: string[]; mode?: string; skills?: boolean }): string | null {
  let mode: string | undefined, settingsMode: string | undefined;
  const allows: string[] = [];
  for (let i = 0; i < command.length; i += 1) {
    const arg = command[i]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? command[++i];
    if (name === "--dangerously-skip-permissions" || name === "--allow-dangerously-skip-permissions") return `the installation command has ${name}`;
    // Review round 1 (Orca session b37f7ce9, I1): a plugin's skills can declare allowed-tools, and it can carry settings and hooks.
    if (name === "--plugin-dir") { seen.skills = true; return "the claude command loads a plugin (--plugin-dir); its skills' allowed-tools, settings and hooks can allow more"; }
    if (name === "--permission-prompt-tool" || name === "--sdk-url") return `the installation command has ${name}, which answers permission prompts instead of denying them`;
    // Controller call (Orca session b37f7ce9; claude 2.1.306): `--permission-prompts host` hands prompts to a host; only
    // `none` (deny anything that would prompt) keeps the set closed. No settings key carries it (static read of the binary).
    if (name === "--permission-prompts") {
      const target = value();
      if (target !== "none") return `the installation command has --permission-prompts ${target ?? ""}, which can answer permission prompts instead of denying them`;
      continue;
    }
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
      const record = settings as { sandbox?: unknown; hooks?: unknown; permissions?: { defaultMode?: unknown; allow?: unknown } };
      if (record.sandbox !== undefined) return "the installation's inline --settings has a sandbox key (sandboxed Bash is auto-allowed)";
      if (record.hooks !== undefined) return "the installation's inline --settings has a hooks key (a hook can allow a tool call)";
      if (typeof record.permissions?.defaultMode === "string") settingsMode = record.permissions.defaultMode;
      if (Array.isArray(record.permissions?.allow)) for (const entry of record.permissions.allow) allows.push(String(entry));
    }
  }
  const effective = mode ?? settingsMode;
  seen.mode = effective;
  if (effective === undefined) return "the installation sets no permission mode; project or user settings may";
  if (!CLOSED_MODES.has(effective)) return `the installation's permission mode ${effective} does not deny un-granted Bash commands`;
  for (const entry of allows) {
    const tool = entry.split("(")[0]!;
    if (OTHER_COMMAND_TOOLS.has(tool) || tool.startsWith("mcp__")) return `the installation allows ${entry}, which runs commands or tools outside the Bash rules`;
    if (entry !== "Bash" && !entry.startsWith("Bash(")) continue;
    const content = entry.startsWith("Bash(") && entry.endsWith(")") ? entry.slice(5, -1) : null;
    const exact = content === null || content.includes(":*") ? null : allowRulesOf([content]);
    if (exact === null || exact.notAllowed.length > 0 || exact.rules.length !== 1) return `the installation allows ${entry}, which is not one exact command`;
    if (!seen.exactAllows.includes(entry)) seen.exactAllows.push(entry);
  }
  if (!command.includes("--disable-slash-commands")) { seen.skills = true; return "the claude command has no --disable-slash-commands, so skills load; a skill's allowed-tools can allow more"; }
  return null;
}

/** The claude report rows and baseline (spec §3.3, §3.4, §4 claude column). */
export function claudeToolRuleRows(rules: ToolRulesV1, installationCommand: readonly string[], allowRulesOf: ClaudeAllowRulesOf): { rows: ToolRuleRowV1[]; baseline: string } {
  const seen: { exactAllows: string[]; mode?: string; skills?: boolean } = { exactAllows: [] };
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
    ...(seen.skills === true ? ["whatever the skills and plugins claude loads allow (allowed-tools, settings, hooks; not read by ccloop)"] : []),
    "and whatever .claude/settings.json, settings.local.json and the person's settings loaded by --setting-sources allow (not read by ccloop)",
  ].join("; ");
  return { rows, baseline: boundedText(baseline, 1024) };
}

/**
 * Why codex may not switch the sandbox network on for `network:true`, or null (spec §3.2.2): a read-only installation has
 * no write sandbox to open; the person's explicit `network_access = false` is a restriction; an unreadable or
 * unparseable config.toml cannot be shown not to be one.
 */
function codexNetworkRefusal(sandbox: "read-only" | "workspace-write", setting: CodexNetworkSetting): string | null {
  if (sandbox === "read-only") return "the installation runs codex read-only; ccloop never changes --sandbox";
  if (setting.kind === "value" && !setting.value) return "the person's config.toml sets sandbox_workspace_write.network_access = false; ccloop never overrides it";
  if (setting.kind === "unparseable") return `cannot show that switching the network on is not widening: ${setting.reason}`;
  return null;
}

/**
 * The codex `-c` pairs for one phase (spec §4 codex column; codex 0.163.0, measure-codex.md Q1/Q2), joined before the
 * trailing `-`: network:true ⇒ `sandbox_workspace_write.network_access=true` on execute unless refused; network:false ⇒
 * `...network_access=false` on execute and `web_search="disabled"`, `features.apps=false` on every phase. No rules ⇒ none.
 */
export function codexToolRuleArgs(rules: ToolRulesV1 | undefined, phase: ToolRulePhase, sandbox: "read-only" | "workspace-write", setting: CodexNetworkSetting): string[] {
  if (rules === undefined) return [];
  if (rules.network) return phase === "execute" && codexNetworkRefusal(sandbox, setting) === null ? ["-c", "sandbox_workspace_write.network_access=true"] : [];
  return [...(phase === "execute" ? ["-c", "sandbox_workspace_write.network_access=false"] : []), "-c", "web_search=\"disabled\"", "-c", "features.apps=false"];
}

/** The codex report rows and baseline (spec §3.3, §4 codex column). */
export function codexToolRuleRows(rules: ToolRulesV1, sandbox: "read-only" | "workspace-write", setting: CodexNetworkSetting): { rows: ToolRuleRowV1[]; baseline: string } {
  const rows: ToolRuleRowV1[] = [{ rule: { kind: "commands-closed" }, status: "recorded-only", reason: "codex exec has no per-command allowlist; the sandbox runs any command", phases: [] }];
  for (const rule of rules.commands) {
    const separator = separatorRefusal(rule.value);
    rows.push({ rule: { ...rule }, status: separator === null ? "recorded-only" : "refused", reason: separator ?? "codex exec has no per-command allowlist", phases: [] });
  }
  const refusal = rules.network ? codexNetworkRefusal(sandbox, setting) : null;
  rows.push(!rules.network ? { rule: { kind: "network", value: false }, status: "enforced", reason: null, phases: [...ALL_PHASES] }
    : refusal === null ? { rule: { kind: "network", value: true }, status: "enforced", reason: null, phases: ["execute"] }
      : { rule: { kind: "network", value: true }, status: "refused", reason: boundedText(refusal, 512), phases: [] });
  for (const name of rules.secretEnv) rows.push({ rule: { kind: "secretEnv", name }, status: "recorded-only", reason: SECRET_REASON, phases: [] });
  const baseline = "codex runs any command inside its sandbox; ccloop reads only the linked config.toml, not managed, MDM or system config layers (which sit above -c), a --profile in the installation command, or a trusted target repo's .codex/config.toml; this report reads config.toml once at worker start, while each execute re-reads it";
  return { rows, baseline: boundedText(baseline, 1024) };
}

/** Spec §4 omp step 2: constructs ccloop does not split; a command holding one is a violation (fail closed). */
const UNSPLIT = ["`", "$(", "(", ")", "<(", ">(", "{", "}"];

/** Spec §4 omp steps 1-3 for one bash command: null when allowed, else the reason. */
function ompCommandViolation(command: string, rules: ToolRulesV1, requiredChecks: readonly string[]): string | null {
  if (requiredChecks.includes(command)) return null;
  if (UNSPLIT.some((construct) => command.includes(construct))) return `bash command ccloop cannot split: ${command}`;
  for (const raw of command.split(/&&|\|\||;|\||&|\n/)) {
    const segment = raw.trim();
    if (segment === "") continue;
    const allowed = requiredChecks.includes(segment) || rules.commands.some((rule) =>
      rule.kind === "exact" ? segment === rule.value : segment === rule.value || segment.startsWith(`${rule.value} `));
    if (!allowed) return `bash command outside the tool rules: ${segment}`;
  }
  return null;
}

/**
 * The omp after-exit check (spec §4 "omp after-exit check"; omp 18.10.1, measure-omp.md Q1/Q3): over every
 * `tool_execution_start` of an execute call -- `bash` must carry a string `args.command` that passes
 * ompCommandViolation; a `write` whose `args.path` starts with `xd://` runs a tool with no bash event and is a violation.
 * Review round 1 (Orca session b37f7ce9, M3): `write` or `edit`, and any path starting `xd:` (any case or slash count).
 * Lines that do not parse are skipped (decodeOmpPhase refuses them on its own). Null: clean; else a bounded detail.
 */
export function ompToolRuleViolation(events: string, rules: ToolRulesV1, requiredChecks: readonly string[]): string | null {
  return foldText(events, new OmpToolRuleFold(rules, requiredChecks)).value();
}

/** Live transcript (Orca spec 2026-10-23 §10.2.3): ompToolRuleViolation as a fold; the first violation decides. */
export class OmpToolRuleFold {
  private violation: string | null = null;
  constructor(private readonly rules: ToolRulesV1, private readonly requiredChecks: readonly string[]) {}
  push(line: JsonLine): void {
    if (this.violation !== null || line.kind !== "row") return;
    const row = line.row;
    if (row === null || typeof row !== "object" || Array.isArray(row)) return;
    const event = row as { type?: unknown; toolName?: unknown; args?: { command?: unknown; path?: unknown } | null };
    if (event.type !== "tool_execution_start") return;
    let detail: string | null = null;
    if (event.toolName === "bash") {
      const command = event.args?.command;
      detail = typeof command !== "string" ? "bash call without a command string" : ompCommandViolation(command, this.rules, this.requiredChecks);
    } else if ((event.toolName === "write" || event.toolName === "edit") && typeof event.args?.path === "string" && event.args.path.trim().toLowerCase().startsWith("xd:")) {
      detail = `${event.toolName} to ${event.args.path.trim()} runs a tool without a bash event`;
    }
    if (detail !== null) this.violation = boundedText(detail, 512);
  }
  value(): string | null { return this.violation; }
}

/** The omp report rows (spec §3.3, §4 omp column): the check is built, so commands-closed is `detected` on execute. */
export function ompToolRuleRows(rules: ToolRulesV1): ToolRuleRowV1[] {
  const rows: ToolRuleRowV1[] = [{ rule: { kind: "commands-closed" }, status: "detected", reason: "omp has no allowlist ccloop can set; execute's bash calls are checked after the call and a violation fails the run", phases: ["execute"] }];
  for (const rule of rules.commands) {
    const separator = separatorRefusal(rule.value);
    rows.push({ rule: { ...rule }, status: separator === null ? "recorded-only" : "refused", reason: separator ?? "omp has no allowlist; the command is admitted by the after-exit check", phases: [] });
  }
  rows.push({ rule: { kind: "network", value: rules.network }, status: "recorded-only", reason: "omp has no network switch ccloop can set (bash and read reach the network)", phases: [] });
  for (const name of rules.secretEnv) rows.push({ rule: { kind: "secretEnv", name }, status: "recorded-only", reason: SECRET_REASON, phases: [] });
  return rows;
}

/**
 * The executor prompt's tool-rule section (spec §5 "Prompt"; executor only): the allowed commands besides the required
 * checks, whether the network is allowed, the secret names. One string of lines; only called when the contract has rules.
 * Review round 1 (Orca session b37f7ce9, M6): `rows` are this kind's report rows; a refused rule is not listed (and a
 * separator one never is, rows or not, so a value with a newline cannot add lines), and network:true whose row is refused
 * is stated as not granted.
 */
export function toolRulesPromptSection(rules: ToolRulesV1, rows?: readonly ToolRuleRowV1[]): string {
  const refused = (rule: ToolCommandRuleV1) => separatorRefusal(rule.value) !== null
    || rows?.some((row) => row.status === "refused" && (row.rule.kind === "exact" || row.rule.kind === "prefix") && row.rule.kind === rule.kind && row.rule.value === rule.value) === true;
  const commands = rules.commands.filter((rule) => !refused(rule)).map((rule) => (rule.kind === "exact" ? `- ${rule.value}` : `- ${rule.value} (optionally followed by arguments)`));
  const networkRefused = rows?.some((row) => row.rule.kind === "network" && row.status === "refused") === true;
  return [
    "Tool rules for this attempt: run only the required checks and these commands, each as one simple command (no cd prefix, no subshells); other commands are denied or fail the attempt:",
    commands.length === 0 ? "(none)" : commands.join("\n"),
    rules.network && !networkRefused ? "Network access: allowed."
      : rules.network ? "Network access: not granted for this attempt (the installation cannot switch it on without widening); do not fetch URLs or call web tools."
        : "Network access: not allowed; do not fetch URLs or call web tools.",
    ...(rules.secretEnv.length === 0 ? [] : [`Secret environment variables this task may use (by name; never print their values): ${rules.secretEnv.join(", ")}`]),
  ].join("\n");
}
