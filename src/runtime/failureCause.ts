/**
 * Failure causes (ccloop spec docs/superpowers/specs/2026-10-21-failure-causes-and-transient-retries-design.md §2-§3): one
 * typed vocabulary for why a phase call or a run failed, classified by code from typed fields and the agent CLI's own
 * error rows only -- never model text, tool output or check output. Anything no row matches is `unknown`: a wrong class
 * would retry money away or hide a real cause, so absence of evidence answers `unknown`, not a guess.
 */
import { foldText, type JsonLine } from "./streamLines.js";

export const FAILURE_CAUSES = [
  "auth", "quota", "rate-limited", "provider-5xx", "network", "context-overflow", "stalled", "executable-missing",
  "required-check-failed", "verifier-rejected", "budget-exhausted", "unknown",
  // Per-contract tool rules (spec 2026-10-22 §4): an omp execute call ran a command outside the contract's tool rules.
  // Terminal: never in RETRYABLE_CAUSES, classified only from the decode error code `omp-tool-rule-violated`.
  // ERRATUM (Orca session 7753e97d, 2026-10-27; spec 2026-10-27-plan-phase-tools §3): also classified from the phase fold's
  // `omp-phase-tool-forbidden` when it names a tool the phase does not have (any omp phase, plan in issue 60).
  "tool-rule-violated",
  // Task setup commands (spec 2026-11-04 §4.5): a contract setup command failed, timed out or changed the tree. Terminal:
  // never in RETRYABLE_CAUSES; the same command would fail again.
  "setup-failed",
  // Orca #273 (spec Orca 2026-11-12-worker-lost-recovery-design.md §4.2): the run's worker process died (the machine
  // restarted or it was killed) and settle-lost-worker ended the run. Terminal: never in RETRYABLE_CAUSES, never classified
  // from a call; written only by settleLostWorker.ts.
  "worker-lost",
  // Orca follow-up J (#299): the provider does not serve the selected model (HTTP 404 naming a model). Terminal: never in
  // RETRYABLE_CAUSES -- the same model would be refused again; another agent or model is the way on.
  "model-unavailable",
  // Orca tester #347: an execute call that completed but whose final message the strict execute decode refused
  // (executeAnswerCause below). Terminal: never in RETRYABLE_CAUSES -- Orca retries at task level (its ladder), and a call
  // that ran tools may have changed the worktree, so an in-phase retry would not start from the attempt's base.
  // narration-only: the final is no answer (absent, or prose with no JSON in it) and no tool, command or file change was
  // observed -- the agent said what it would do and ended its turn. execution-not-json: a final that is not JSON (or a
  // missing answer after work was observed). execution-shape: JSON that is not exactly one accepted execute answer.
  "narration-only", "execution-not-json", "execution-shape",
  // Orca tester #349 (human's ruling, session 4389b15f, 2026-11-18): a phase call that failed only in its cleanup (a broken
  // live-usage read or an evidence write after the session deletion; a failed deletion itself is recorded and never fails
  // the call). Terminal: never in RETRYABLE_CAUSES -- the call's work already ran.
  "cleanup-failed",
  // Orca #369 (a) (spec 2026-11-18-omp-launch-isolation-design.md §3): an omp assistant error whose typed provider status is a
  // 4xx no other row names (not 401/402/403/408/429, nor a 404 naming a model). Terminal: never in RETRYABLE_CAUSES -- the
  // same request would be refused again. The detail carries the status (`HTTP <status>: <errorMessage>`).
  "provider-error",
] as const;
export type FailureCauseV1 = (typeof FAILURE_CAUSES)[number];

/** Spec §2: only these are retried inside a phase; every other cause ends the phase on its first occurrence. */
export const RETRYABLE_CAUSES: ReadonlySet<FailureCauseV1> = new Set(["rate-limited", "provider-5xx", "network", "stalled"]);

export type CallClassification = { cause: FailureCauseV1; workObserved: boolean; detail: string | null };

/** The run-level record (spec §5), persisted on RunState and exposed at collect's top level. */
export type RunFailureCauseV1 = { cause: FailureCauseV1; phase: "plan" | "execute" | "verify" | "setup" | null; retries: number; detail: string | null;
  /** Positive proof that this failed run consumed no tokens (a pre-spawn refusal, or a 429 before any work). */
  usageKnownZero?: true };

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
  // Orca follow-up J (#299): codex's own format `unexpected status <status>: <body>` (static string, codex-cli 0.167.0) with a
  // 404 whose body names a model. Real sample (tester ledger issue-20261023, Issue 299, through a proxy):
  // `unexpected status 404 Not Found: "gpt-6-sol" is one of Codex's own models, ... No ChatGPT account in magpie serves it`.
  // A 404 that names no model (a wrong endpoint) stays unknown.
  [/\bunexpected status 404\b[\s\S]*\bmodel/i, "model-unavailable"],
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
  return foldText(events, new CodexCallFold()).value();
}

/**
 * Orca tester #347: the codex item types that are not work -- the agent's messages, its reasoning, and the `error` items
 * codex emits for config warnings (codexSingleCall.ts allows the same three; every other item type, known or not, is a tool
 * there too). A command_execution, file_change, mcp_tool_call, web_search or todo_list item is work.
 */
const CODEX_NON_WORK_ITEMS = new Set(["agent_message", "reasoning", "error"]);

/** Live transcript (Orca spec 2026-10-23 §10.2.3): classifyCodexCall as a fold; a line too large to keep counts as unparsed. */
export class CodexCallFold {
  private message: string | null = null; private completed = false; private workObserved = false;
  /** Orca tester #347: a work item, or a line whose kind cannot be told (absence of work not proven); see toolObserved(). */
  private tool = false;
  push(line: JsonLine): void {
    if (line.kind === "blank") return;
    if (line.kind !== "row") { this.workObserved = true; this.tool = true; return; }
    const row = line.row;
    if (row === null || typeof row !== "object" || Array.isArray(row)) { this.workObserved = true; this.tool = true; return; }
    const r = row as { type?: unknown; message?: unknown; error?: { message?: unknown } | null; item?: { type?: unknown } | null };
    if (typeof r.type !== "string") { this.workObserved = true; this.tool = true; return; }
    if (r.type.startsWith("item.")) {
      this.workObserved = true;
      if (typeof r.item?.type !== "string" || !CODEX_NON_WORK_ITEMS.has(r.item.type)) this.tool = true;
    }
    if (r.type === "turn.completed") this.completed = true;
    const text = r.type === "error" ? r.message : r.type === "turn.failed" ? r.error?.message : undefined;
    if (typeof text === "string") this.message = text;
  }
  value(): CallClassification | null {
    if (this.completed) return null;
    if (this.message === null) return { cause: "unknown", workObserved: this.workObserved, detail: null };
    return { cause: codexRowCause(this.message), workObserved: this.workObserved, detail: causeDetail(this.message) };
  }
  /**
   * Orca tester #347: whether the call did anything but talk -- a work item (CODEX_NON_WORK_ITEMS), or a line that does not
   * parse as a typed row. Unlike `workObserved` (any item, for retry safety), an agent_message or reasoning item is not work.
   */
  toolObserved(): boolean { return this.tool; }
}

/**
 * Orca tester #347: what an execute final the strict decode refused looks like, by structure only (never its words):
 * `absent` (no final, or blank), `json` (the whole final parses as JSON, or it holds an object with an execute answer key),
 * `broken` (it has brace text that does not parse, so an answer may have been attempted), `prose` (none of these).
 * `bytes` is the final's UTF-8 length. Computed by the adapter that decoded the final (executionNormalizer.ts).
 */
export type ExecuteAnswerForm = { form: "absent" | "json" | "broken" | "prose"; bytes: number };
export type ExecuteAnswerCauseV1 = "narration-only" | "execution-not-json" | "execution-shape";
export const EXECUTE_ANSWER_CAUSES: ReadonlySet<FailureCauseV1> = new Set<ExecuteAnswerCauseV1>(["narration-only", "execution-not-json", "execution-shape"]);

/**
 * Orca tester #347: the cause of an execute call that completed but whose answer was refused. `toolObserved` is the
 * adapter's own observation of the call (codex: a work item; claude: a tool_use; omp: a tool_execution_start) and must be
 * `true` whenever the adapter could not tell. Narration-only needs both facts: no answer, and no work. `formatDetail` (the
 * refused field, issues 125/274) is kept as the detail of the other two causes, so Orca's formatRefusal reader still finds it.
 */
export function executeAnswerCause(answer: ExecuteAnswerForm, toolObserved: boolean, formatDetail: string | null): { cause: ExecuteAnswerCauseV1; detail: string } {
  if (answer.form === "json") return { cause: "execution-shape", detail: formatDetail ?? "the final message holds JSON that is not exactly one accepted execute answer" };
  if (answer.form === "broken") return { cause: "execution-not-json", detail: formatDetail ?? `the final message (${answer.bytes} bytes) holds brace text that does not parse as JSON` };
  if (toolObserved) {
    return { cause: "execution-not-json", detail: formatDetail
      ?? (answer.form === "absent" ? "the call ended without a final answer after using tools" : `the final message (${answer.bytes} bytes) is not JSON`) };
  }
  return { cause: "narration-only", detail: answer.form === "absent"
    ? "the call ended without a final answer; no tool, command or file change was observed"
    : `the call ended after a ${answer.bytes}-byte final message that is not an execute answer; no tool, command or file change was observed` };
}

/**
 * Orca tester #347: an adapter's classification of a failed execute try, with the cause executeAnswerCause gives when the
 * error carries an `executeAnswer` form (attached where the strict decode refused the final); otherwise unchanged.
 * Only an `unknown` classification is refined: a cause the agent CLI typed (a claude rate limit that also left no answer,
 * for one) stays. `workObserved` (retry safety) is kept: none of these causes is retryable.
 */
export function withExecuteAnswerCause(classification: CallClassification | null, error: unknown, toolObserved: boolean): CallClassification | null {
  if (classification === null || classification.cause !== "unknown" || error === null || typeof error !== "object") return classification;
  const answer = (error as { executeAnswer?: unknown }).executeAnswer as ExecuteAnswerForm | undefined;
  if (answer === undefined || answer === null || typeof answer !== "object" || !["absent", "json", "broken", "prose"].includes(answer.form)) return classification;
  const formatDetail = (error as { formatDetail?: unknown }).formatDetail;
  const { cause, detail } = executeAnswerCause(answer, toolObserved, typeof formatDetail === "string" ? formatDetail : null);
  return { ...classification, cause, detail: causeDetail(detail) };
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
  // Orca follow-up J (#299): claude's typed `model_not_found` (the assistant error enum, spec §3, read from claude 2.1.304).
  if (assistantError === "model_not_found") return "model-unavailable";
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
 *
 * *** ERRATUM (Orca #369 (a), 2026-11-18; spec 2026-11-18-omp-launch-isolation-design.md §3) -- "classifies `unknown`" no
 * longer holds when that last errored message carries a numeric `errorStatus` (omp's typed provider status; a field sample
 * exists, #369): it is classified by status as the codex table does (OMP_STATUS_CAUSE below) and its detail becomes
 * `HTTP <status>: <errorMessage>`. A message without a status is unchanged. ***
 */
export function classifyOmpCall(events: string): CallClassification {
  return foldText(events, new OmpCallFold()).value();
}

/**
 * Orca #369 (a): an omp assistant error's typed provider status (`errorStatus`) as a cause, mirroring the codex status rows
 * above. Only the typed status is read; `errorMessage` is consulted only to tell a 404 that names a model, as codex's 404 row.
 * 408 stays unknown (a request timeout, not a refusal).
 * Review fixes (spec 2026-11-18 §6, I3): "`errorMessage` is consulted" no longer holds -- an omp 404 is `model-unavailable`
 * whatever its text (the #369 field text is 「模型已下架」, which names no "model"); the message is never read. omp's 404 is
 * the model endpoint's answer to a request for one selected model, so a missing model is the reading the run can act on.
 */
function ompStatusCause(status: number): FailureCauseV1 {
  if (status === 429) return "rate-limited";
  if (status >= 500 && status <= 599) return "provider-5xx";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 404) return "model-unavailable";
  if (status >= 400 && status <= 499 && status !== 408) return "provider-error";
  return "unknown";
}

/** Orca #369 (a): a provider refusal that will not pass on a retry -- a 4xx other than 408 (timeout) and 429 (rate limit). */
function terminalProviderStatus(status: number): boolean {
  return status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

/** Live transcript (Orca spec 2026-10-23 §10.2.3): classifyOmpCall as a fold. */
export class OmpCallFold {
  private workObserved = false; private detail: string | null = null;
  private status: number | null = null; private cause: FailureCauseV1 = "unknown";
  push(line: JsonLine): void {
    if (line.kind !== "row") return;
    const row = line.row;
    if (row === null || typeof row !== "object" || Array.isArray(row)) return;
    const r = row as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; errorStatus?: unknown } };
    if (r.type === "tool_execution_start") this.workObserved = true;
    if (r.type === "message_end" && r.message?.role === "assistant" && r.message.stopReason === "error" && typeof r.message.errorMessage === "string") {
      const status = r.message.errorStatus;
      if (typeof status === "number" && Number.isSafeInteger(status)) {
        this.status = status;
        this.cause = ompStatusCause(status);
        this.detail = causeDetail(`HTTP ${status}: ${r.message.errorMessage}`);
      } else {
        this.status = null; this.cause = "unknown";
        this.detail = causeDetail(r.message.errorMessage);
      }
    } else if (r.type === "message_end" && r.message?.role === "assistant") {
      // A later assistant message that is not an error: the call went on, so an earlier refusal neither ends nor names it.
      // Review fixes (spec §6, M5): nor is its detail kept -- the detail belongs to the final errored message only.
      this.status = null; this.cause = "unknown"; this.detail = null;
    }
  }
  value(): CallClassification { return { cause: this.cause, workObserved: this.workObserved, detail: this.detail }; }
  /** Orca #369 (a): the status when the latest assistant message is a non-retryable 4xx refusal (the phase ends on it); else null. */
  terminalProviderStatus(): number | null { return this.status !== null && terminalProviderStatus(this.status) ? this.status : null; }
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

/**
 * Orca spec 2026-11-06 quota probe §4 step 2: the cause a failed single call's record carries. The codex and claude
 * single-call failure paths attach it as `singleCallCause` (omp's single call does not: it classifies nothing but
 * `unknown`); runSingleCall writes it as the record's `failureCause`. A property of its own, not the `failureCause` the
 * stalled paths already attach, so an adapter that attaches none leaves its record byte-identical.
 */
export type SingleCallCauseV1 = { cause: FailureCauseV1; detail: string | null };

export function singleCallCauseOf(classification: CallClassification | null): { singleCallCause?: SingleCallCauseV1 } {
  return classification === null ? {} : { singleCallCause: { cause: classification.cause, detail: classification.detail === null ? null : causeDetail(classification.detail) } };
}

/** The single-call cause an adapter attached to a failure, when it names a cause of the vocabulary; else null. */
export function attachedSingleCallCause(error: unknown): SingleCallCauseV1 | null {
  if (error === null || typeof error !== "object") return null;
  const attached = (error as { singleCallCause?: unknown }).singleCallCause;
  if (attached === null || typeof attached !== "object") return null;
  const { cause, detail } = attached as { cause?: unknown; detail?: unknown };
  if (typeof cause !== "string" || !(FAILURE_CAUSES as readonly string[]).includes(cause)) return null;
  return { cause: cause as FailureCauseV1, detail: typeof detail === "string" ? causeDetail(detail) : null };
}
