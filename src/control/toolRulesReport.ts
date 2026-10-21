import { dirname, join } from "node:path";
import { z } from "zod";
import type { CodexNetworkSetting } from "../agents/codexNetworkConfig.js";
import type { InstallationV1 } from "../agents/types.js";
import { requiredCheckAllowRules } from "../runtime/claude/claudeAgentAdapter.js";
import { boundedText, claudeToolRuleRows, codexToolRuleRows, ompToolRuleRows, type ToolRulesReportV1, type ToolRulesV1 } from "../runtime/toolRules.js";
import { atomicReplacePrivateFile, readPrivateFile } from "./paths.js";

/**
 * Per-contract tool rules: the run's report (ccloop spec 2026-10-22 §5). Computed once per run by code in the control
 * worker, before the first phase, from the contract's rules, the installation and the names in the environment -- no
 * agent call. Lives here, not in src/runtime/toolRules.ts, because it needs the claude adapter's requiredCheckAllowRules
 * and the control paths, and toolRules.ts must stay a leaf the contract schema can import.
 */
export const TOOL_RULES_REPORT_FILE = "tool-rules.json";

const OMP_BASELINE = "omp adds tools to --tools by its own settings (a call to one fails the phase closed); read fetches URLs; a bash call's cwd, async or service mode is not checked";

export function buildToolRulesReport(input: { rules: ToolRulesV1; kind: "claude" | "codex" | "omp"; installation: InstallationV1; codexNetwork: CodexNetworkSetting | null; env: NodeJS.ProcessEnv; savedResult?: boolean }): ToolRulesReportV1 {
  const { rows, baseline } = input.kind === "claude" ? claudeToolRuleRows(input.rules, input.installation.command, requiredCheckAllowRules)
    : input.kind === "codex" ? codexToolRuleRows(input.rules, input.installation.sandbox === "read-only" ? "read-only" : "workspace-write", input.codexNetwork ?? { kind: "absent" })
      : { rows: ompToolRuleRows(input.rules), baseline: OMP_BASELINE };
  // Spec §4 secretEnv: the name only -- set and non-empty in ccloop's environment at worker start -- never the value.
  const present = (name: string) => typeof input.env[name] === "string" && input.env[name] !== "";
  return {
    schema: "ccloop-tool-rules-report-v1", agentKind: input.kind, baseline: boundedText(baseline, 1024),
    // Spec §6 Saved-result recovery: a recovery runs verify only, so a row names only the verify mechanism, if any.
    rules: rows.map((row) => (input.savedResult === true ? { ...row, phases: row.phases.filter((phase) => phase === "verify") } : row))
      .map((row) => (row.rule.kind === "secretEnv" ? { ...row, present: present(row.rule.name) } : row)),
  };
}

/** `<sourceDir>/run/tool-rules.json`, replaced atomically, mode 0600 (the other run files' rule). */
export async function writeToolRulesReport(runDir: string, report: ToolRulesReportV1): Promise<void> {
  await atomicReplacePrivateFile(dirname(runDir), join(runDir, TOOL_RULES_REPORT_FILE), Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
}

const ruleSchema = z.union([
  z.object({ kind: z.literal("commands-closed") }).strict(),
  z.object({ kind: z.enum(["exact", "prefix"]), value: z.string() }).strict(),
  z.object({ kind: z.literal("network"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("secretEnv"), name: z.string() }).strict(),
]);
/** The report as collect answers it; strict, so ccloop never answers a shape Orca's strict parse would refuse. */
export const toolRulesReportSchema = z.object({
  schema: z.literal("ccloop-tool-rules-report-v1"),
  agentKind: z.enum(["claude", "codex", "omp"]),
  baseline: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 1024),
  rules: z.array(z.object({
    rule: ruleSchema,
    status: z.enum(["enforced", "detected", "recorded-only", "refused"]),
    reason: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= 512).nullable(),
    phases: z.array(z.enum(["plan", "execute", "verify"])),
    present: z.boolean().optional(),
  }).strict()),
}).strict();

/** The run's report for collect, or undefined when the file does not exist. Bytes that are not the report fail collect. */
export async function readToolRulesReport(sourceDir: string): Promise<ToolRulesReportV1 | undefined> {
  let bytes: Buffer;
  try { bytes = await readPrivateFile(sourceDir, join(sourceDir, "run", TOOL_RULES_REPORT_FILE)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("control-tool-rules-invalid"); }
  const report = toolRulesReportSchema.safeParse(parsed);
  if (!report.success) throw new Error("control-tool-rules-invalid");
  return report.data as ToolRulesReportV1;
}
