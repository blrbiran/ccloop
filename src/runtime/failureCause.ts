/**
 * Failure causes (ccloop spec docs/superpowers/specs/2026-10-21-failure-causes-and-transient-retries-design.md §2-§3): one
 * typed vocabulary for why a phase call or a run failed, classified by code from typed fields and the agent CLI's own
 * error rows only -- never model text, tool output or check output. Anything no row matches is `unknown`: a wrong class
 * would retry money away or hide a real cause, so absence of evidence answers `unknown`, not a guess.
 */
export const FAILURE_CAUSES = [
  "auth", "quota", "rate-limited", "provider-5xx", "network", "context-overflow", "stalled", "executable-missing",
  "required-check-failed", "verifier-rejected", "budget-exhausted", "unknown",
] as const;
export type FailureCauseV1 = (typeof FAILURE_CAUSES)[number];

/** Spec §2: only these are retried inside a phase; every other cause ends the phase on its first occurrence. */
export const RETRYABLE_CAUSES: ReadonlySet<FailureCauseV1> = new Set(["rate-limited", "provider-5xx", "network", "stalled"]);

export type CallClassification = { cause: FailureCauseV1; workObserved: boolean; detail: string | null };

/** The run-level record (spec §5), persisted on RunState and exposed at collect's top level. */
export type RunFailureCauseV1 = { cause: FailureCauseV1; phase: "plan" | "execute" | "verify" | null; retries: number; detail: string | null };

const DETAIL_BYTES = 512;

/** Head of the matched text, cut back to a code-point boundary (no U+FFFD from a split character). */
export function causeDetail(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= DETAIL_BYTES) return text;
  let end = DETAIL_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

// Spec §3 codex table. The first row is the only one with real samples (orca_archived_files/recommendations-{1,2}); the
// rest are codex-cli 0.163.0's own format strings, read statically from the binary.
const CODEX_ROWS: ReadonlyArray<[RegExp, FailureCauseV1]> = [
  [/\blast status: 429\b/, "rate-limited"],
  [/\blast status: (401|403)\b/, "auth"],
  [/\blast status: 402\b/, "quota"],
  [/\blast status: 5\d\d\b/, "provider-5xx"],
  [/ve hit your usage limit/, "quota"],
  [/Quota exceeded\. Check your plan and billing details/, "quota"],
  [/Selected model is at capacity/, "provider-5xx"],
  [/stream disconnected before completion/, "network"],
  [/^Connection failed: /, "network"],
  [/Error while reading the server response/, "network"],
];

function codexRowCause(message: string): FailureCauseV1 {
  for (const [pattern, cause] of CODEX_ROWS) if (pattern.test(message)) return cause;
  return "unknown";
}

/**
 * Spec §3 codex: only `error` rows' `message` and `turn.failed` rows' `error.message` are read (the reader of
 * rateLimit.ts). The last error signal wins. A call with `turn.completed` reported usage and is not classified (null).
 * `workObserved`: any `item.*` row, or any line that does not parse (absence of work not proven).
 */
export function classifyCodexCall(events: string): CallClassification | null {
  let message: string | null = null, completed = false, workObserved = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { workObserved = true; continue; }
    if (row === null || typeof row !== "object" || Array.isArray(row)) { workObserved = true; continue; }
    const r = row as { type?: unknown; message?: unknown; error?: { message?: unknown } | null };
    if (typeof r.type !== "string") { workObserved = true; continue; }
    if (r.type.startsWith("item.")) workObserved = true;
    if (r.type === "turn.completed") completed = true;
    const text = r.type === "error" ? r.message : r.type === "turn.failed" ? r.error?.message : undefined;
    if (typeof text === "string") message = text;
  }
  if (completed) return null;
  if (message === null) return { cause: "unknown", workObserved, detail: null };
  return { cause: codexRowCause(message), workObserved, detail: causeDetail(message) };
}

/** What the claude runner records per call (spec §3 claude), written to CCLOOP_CLAUDE_SIGNALS_PATH. */
export type ClaudeSignalsV1 = { schema: "ccloop-claude-signals-v1"; assistantError: string | null; errorText: string | null; toolUses: number; assistantMessages: number };

const CLAUDE_AUTH = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"]);
// Spec §3: the phrases the claude 2.1.304 binary attaches to a plan/credit limit (static strings).
const CLAUDE_QUOTA_PHRASES = ["usage limit reached", "usage credit limit reached", "spend limit reached"];
const CLAUDE_OVERFLOW_PHRASES = ["Prompt is too long", "input is too long for requested model"];

export function claudeErrorCause(assistantError: string | null, errorText: string | null): FailureCauseV1 {
  if (assistantError === null) return "unknown";
  const text = errorText ?? "";
  if (CLAUDE_AUTH.has(assistantError)) return "auth";
  if (assistantError === "billing_error") return "quota";
  if (assistantError === "rate_limit") return CLAUDE_QUOTA_PHRASES.some((phrase) => text.includes(phrase)) ? "quota" : "rate-limited";
  if (assistantError === "overloaded" || assistantError === "server_error") return "provider-5xx";
  if (assistantError === "invalid_request" && CLAUDE_OVERFLOW_PHRASES.some((phrase) => text.includes(phrase))) return "context-overflow";
  return "unknown";
}

/**
 * Spec §3 claude. `signals` null means the file was missing or unparseable: work is then assumed (not retried) and the
 * cause is unknown -- a runner killed before its first write proves nothing either way.
 */
export function classifyClaudeCall(signals: ClaudeSignalsV1 | null): CallClassification {
  if (signals === null) return { cause: "unknown", workObserved: true, detail: null };
  return {
    cause: claudeErrorCause(signals.assistantError, signals.errorText),
    workObserved: signals.toolUses > 0,
    detail: signals.errorText === null ? null : causeDetail(signals.errorText),
  };
}

export function parseClaudeSignals(text: string): ClaudeSignalsV1 | null {
  try {
    const value = JSON.parse(text) as Partial<ClaudeSignalsV1>;
    if (value.schema !== "ccloop-claude-signals-v1") return null;
    if (!(value.assistantError === null || typeof value.assistantError === "string")) return null;
    if (!(value.errorText === null || typeof value.errorText === "string")) return null;
    if (!Number.isSafeInteger(value.toolUses) || !Number.isSafeInteger(value.assistantMessages)) return null;
    return value as ClaudeSignalsV1;
  } catch { return null; }
}

/**
 * Spec §3 omp v1: no provider error sample exists, so a failed call classifies `unknown`; a final assistant message with
 * stopReason "error" records its errorMessage as detail. `workObserved`: any tool_execution_start.
 */
export function classifyOmpCall(events: string): CallClassification {
  let workObserved = false, detail: string | null = null;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (r.type === "tool_execution_start") workObserved = true;
    if (r.type === "message_end" && r.message?.role === "assistant" && r.message.stopReason === "error" && typeof r.message.errorMessage === "string") {
      detail = causeDetail(r.message.errorMessage);
    }
  }
  return { cause: "unknown", workObserved, detail };
}

/** Spec §3 "Every kind": a spawn that failed with ENOENT. `spawnError` is the runner's `<code>: <message>` string. */
export function isExecutableMissing(spawnError: string | null | undefined): boolean {
  return typeof spawnError === "string" && spawnError.startsWith("ENOENT");
}

/** Reads the cause an adapter attached to an error or a runner-built partial (spec §5); undefined when none. */
export function attachedCause(value: unknown): { classification: CallClassification; retries: number } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const attached = (value as { failureCause?: unknown }).failureCause;
  if (attached === null || typeof attached !== "object") return undefined;
  const { cause, workObserved, detail, retries } = attached as Partial<CallClassification> & { retries?: unknown };
  if (typeof cause !== "string" || !(FAILURE_CAUSES as readonly string[]).includes(cause)) return undefined;
  return {
    classification: { cause: cause as FailureCauseV1, workObserved: workObserved === true, detail: typeof detail === "string" ? detail : null },
    retries: typeof retries === "number" && Number.isSafeInteger(retries) && retries >= 0 ? retries : 0,
  };
}
