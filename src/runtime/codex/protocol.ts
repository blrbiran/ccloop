import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ModelUsageV1 } from "../../control/usage.js";
import type { AttemptPlan, ExecutionResult, UsageEvidence, VerificationResult } from "../types.js";

export type CodexPhase = "plan" | "execute" | "verify";
const configSchema = z.object({
  command: z.tuple([z.string().min(1).refine(isAbsolute)]).rest(z.string()),
  model: z.string().trim().min(1), budgetMode: z.literal("soft"),
  sandbox: z.enum(["read-only", "workspace-write"]),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  killGraceMs: z.number().int().nonnegative().max(60_000),
}).strict();
export type CodexConfig = z.infer<typeof configSchema>;
export function parseCodexConfig(raw: unknown): CodexConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`codex-config-invalid: ${parsed.error.message}`);
  return parsed.data;
}

const strings = z.array(z.string());
const plan = z.object({summary:z.string(), primaryTargetPaths:strings}).strict();
const executionFields = {changedFiles:strings, diffPatch:z.string(), commandOutputs:strings, stdoutStderrLog:z.string()};
const complete = z.object(executionFields).strict();
const partial = z.object({...executionFields,completionStatus:z.literal("partial"),failureType:z.enum(["timeout","error"]),failureMessage:z.string()}).strict();
const execution = z.union([complete,partial]);
const verification = z.object({approved:z.boolean(),rejectCategory:z.string(),primaryTargetPaths:strings,failingCommand:z.string().nullable(),safeToRetry:z.boolean(),evidence:strings,pauseSignals:strings,stopSignals:strings}).strict();
const schemas = {plan,execute:execution,verify:verification};
const string = {type:"string"};
const array = {type:"array",items:string};
const object = (properties: Record<string,unknown>) => ({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
export function phaseJsonSchema(phase: CodexPhase): Record<string, unknown> {
  if (phase === "plan") return object({summary:string,primaryTargetPaths:array});
  if (phase === "verify") return object({approved:{type:"boolean"},rejectCategory:string,primaryTargetPaths:array,failingCommand:{type:["string","null"]},safeToRetry:{type:"boolean"},evidence:array,pauseSignals:array,stopSignals:array});
  const fields = {changedFiles:array,diffPatch:string,commandOutputs:array,stdoutStderrLog:string};
  return {anyOf:[object(fields),object({...fields,completionStatus:{type:"string",enum:["partial"]},failureType:{type:"string",enum:["timeout","error"]},failureMessage:string})]};
}

const record = (x: unknown): x is Record<string,unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export type PhaseResults = {plan:AttemptPlan; execute:ExecutionResult; verify:VerificationResult};
/**
 * Orca handoff delivery (2026-09-25), spec §13.1 C-3: the total of the last well-formed
 * `turn.completed` usage in the stdout a phase wrote before it stopped, or null when there is none.
 * Unlike decodeCodexResult this tolerates a torn last line and other rows: a stopped phase's stdout
 * ends wherever the kill landed.
 * Honest registration: real codex reports usage only at phase end, so a handoff deadline that aborts
 * mid-turn usually leaves no `turn.completed` line to read here — this function then answers null (not
 * an estimate) and that run's usage stays unknown, keeping it unrecoverable.
 *
 * *** ERRATUM (Orca backlog #15, human-authorized 2026-09-29, Orca session 2724716d) -- the sentence above that
 * "real codex reports usage only at phase end" is written as a fact, but it was never measured. The plan it came
 * from (Orca docs/superpowers/plans/2026-09-25-handoff-delivery.md, §0 item (10)) inferred it from reading this
 * source and marked it as a guess, because no events.jsonl from a real codex run was kept in either repository to
 * check it against; Orca's final review of that round names this comment (finding M4 in Orca
 * .superpowers/sdd/2026-09-25-handoff-delivery/final-review.md). Read that sentence as unmeasured. What this function
 * reads, and that it answers null rather than an estimate, is unchanged. ***
 */
export function observedTurnUsage(events: string): number | null {
  let observed: number | null = null;
  for (const line of events.split("\n")) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!record(row) || row.type !== "turn.completed" || !record(row.usage)) continue;
    const input = row.usage.input_tokens, output = row.usage.output_tokens;
    if (!integer(input) || !integer(output) || !Number.isSafeInteger(input + output) || input + output === 0) continue;
    observed = input + output;
  }
  return observed;
}

export function decodeCodexResult<P extends CodexPhase>(phase:P, events:string, final:string): PhaseResults[P] {
  let completed: Record<string, unknown> | undefined;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error("codex-events-invalid"); }
    if (!record(row) || typeof row.type !== "string") throw new Error("codex-events-invalid");
    if (row.type === "turn.failed" || row.type === "error") throw new Error("codex-event-error");
    if (row.type !== "turn.completed") continue;
    if (completed && JSON.stringify(completed) !== JSON.stringify(row)) throw new Error("codex-conflicting-completion");
    completed = row;
  }
  if (!completed) throw new Error("codex-no-completion");
  const usage = completed.usage;
  if (!record(usage)) throw new Error("codex-usage-invalid");
  const input = usage.input_tokens, output = usage.output_tokens;
  if (!integer(input) || !integer(output) || !Number.isSafeInteger(input + output)) throw new Error("codex-usage-invalid");
  for (const [field,limit] of [["cached_input_tokens",input],["reasoning_output_tokens",output]] as const) {
    const v = usage[field];
    if (v !== undefined && (!integer(v) || v > limit)) throw new Error("codex-usage-invalid");
  }
  const tokenUsage = input + output;
  if (tokenUsage === 0) throw new Error("codex-usage-unavailable");
  let raw: unknown;
  try { raw = JSON.parse(final); } catch { throw new Error("codex-result-invalid"); }
  const parsed = schemas[phase].safeParse(raw);
  if (!parsed.success) throw new Error(`codex-result-invalid: ${parsed.error.message}`);
  const usageEvidence: UsageEvidence = {
    usageStatus:"present", fields:{input_tokens:{status:"finite",value:input},output_tokens:{status:"finite",value:output},inputTokens:{status:"absent"},outputTokens:{status:"absent"}},
    selectedInputField:"input_tokens",selectedOutputField:"output_tokens",normalizedTotal:tokenUsage,
  };
  // Validation above selects the phase schema; the generic preserves that selection for callers.
  return {...parsed.data, tokenUsage, usageEvidence} as PhaseResults[P];
}

/**
 * Orca accounts plan B3 (2026-10-07): the usage of the run's single model, re-read from the `turn.completed` row that
 * decodeCodexResult validated (call it on events that decoded). `input` is the non-cached input, so the entry adds up to
 * input_tokens + output_tokens, the tokenUsage decodeCodexResult reports. Null when there is no usable completion or the
 * model name is one the usage schema refuses (empty, over 200 chars): absent, never a guess.
 */
export function codexModelUsage(events: string, model: string): ModelUsageV1[] | null {
  if (model.length < 1 || model.length > 200) return null;
  let usage: Record<string, unknown> | undefined;
  for (const line of events.split("\n")) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (record(row) && row.type === "turn.completed" && record(row.usage)) usage = row.usage;
  }
  if (!usage) return null;
  const { input_tokens: total, output_tokens: output, cached_input_tokens: cached = 0 } = usage;
  if (!integer(total) || !integer(output) || !integer(cached) || cached > total) return null;
  return [{ model, input: total - cached, output, cacheRead: cached, cacheWrite: 0 }];
}

/**
 * Codex phase output hardening (2026-10-08), spec §3.2: the phase's strict acceptance test for extractFinalObject. Plan
 * and verify use their phase schema; execute uses the strict {result} envelope whose result must pass the execution union.
 * Spec §7 (final-review fix): the acceptor carries the phase's discriminating keys, which make a node *answer-shaped*
 * (rule 1), and a verify acceptor takes only a rejection (rule 2), so extraction can never yield approval.
 */
const executeEnvelope = z.object({result:execution}).strict();
const phaseAnswerKeys: Record<CodexPhase, readonly string[]> = { plan: ["summary", "primaryTargetPaths"], execute: ["result"], verify: ["approved"] };
export type PhaseAcceptor = ((value: unknown) => boolean) & { readonly keys: readonly string[] };
export function phaseFinalAccepts(phase: CodexPhase): PhaseAcceptor {
  const schema: z.ZodTypeAny = phase === "execute" ? executeEnvelope : schemas[phase];
  const accepts = phase === "verify"
    ? (value: unknown) => schema.safeParse(value).success && (value as { approved: unknown }).approved === false
    : (value: unknown) => schema.safeParse(value).success;
  return Object.assign(accepts, { keys: phaseAnswerKeys[phase] });
}

export type FinalExtraction =
  | { method: "whole"; value: unknown }
  | { method: "candidate"; value: unknown; candidates: number; valid: number }
  | { method: "none"; candidates: number; valid: number };
const MAX_NODES = 100_000, MAX_DEPTH = 1_000;
/**
 * Codex phase output hardening (2026-10-08), spec §3.2 as corrected by §7: find the phase answer in a final message a
 * provider let the model decorate. A final message that is whole JSON is returned as is (acceptance is then decided
 * exactly as before). Otherwise every top-level balanced {…} span is parsed (a fence needs no separate handling: the brace
 * pass scans its text) and every object node of every span is walked. A node carrying one of the phase's discriminating
 * keys is answer-shaped and counts whether or not it is valid: the answer is the one distinct answer-shaped node, and only
 * if the acceptor takes it. Two or more distinct answer-shaped nodes are `none`, so a schema-valid template can never
 * stand in for an off-schema real answer. Fail closed on hidden text: an unclosed `{`, a span that is not JSON, or a walk
 * past MAX_NODES object nodes or MAX_DEPTH levels could hide another answer, so the result is `none` and `hidden` is true.
 * `candidates` counts distinct parsed spans, `valid` the accepted ones among the distinct answer-shaped nodes seen (the
 * walk stops examining answer-shaped nodes at the second: the result is then `none` whatever follows).
 */
export function scanFinalMessage(final: string, accepts: PhaseAcceptor): { extraction: FinalExtraction; hidden: boolean } {
  try { return { extraction: { method: "whole", value: JSON.parse(final) }, hidden: false }; } catch { /* not whole JSON: look for candidates */ }
  const spans: string[] = [];
  // Brace spans: string state only inside an object (depth >= 1), so a stray quote in prose cannot hide one; a `}` at
  // depth 0 is ignored; an unclosed `{` never closes (its text is hidden from the matcher, handled below).
  let depth = 0, spanStart = 0, inString = false, escaped = false;
  for (let i = 0; i < final.length; i++) {
    const c = final[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === "{") {
      if (depth === 0) spanStart = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0 && --depth === 0) spans.push(final.slice(spanStart, i + 1));
    } else if (c === '"' && depth > 0) inString = true;
  }
  let hidden = depth > 0, nodes = 0, answer: unknown;
  const sortKeys = (_key: string, v: unknown) => record(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v;
  const seen = new Set<string>(), roots = new Set<string>(), shaped = new Map<string, boolean>();
  scan: for (const text of spans) {
    if (seen.has(text)) continue; // the same span text again: same tree, nothing new to walk
    seen.add(text);
    let value: unknown;
    try { value = JSON.parse(text); } catch { hidden = true; continue; }
    // Every container of the tree, iteratively, with its depth: an answer wrapped inside another object is still seen.
    const stack: Array<[object, number]> = [[value as object, 1]];
    for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
      const [node, level] = entry;
      if (level > MAX_DEPTH || (record(node) && ++nodes > MAX_NODES)) { hidden = true; break scan; }
      for (const item of Object.values(node)) if (item !== null && typeof item === "object") stack.push([item, level + 1]);
      if (record(node) && shaped.size < 2 && accepts.keys.some((key) => Object.hasOwn(node, key))) {
        const key = JSON.stringify(node, sortKeys);
        if (!shaped.has(key)) {
          const ok = accepts(node);
          shaped.set(key, ok);
          if (ok) answer = node;
        }
      }
    }
    roots.add(JSON.stringify(value, sortKeys));
  }
  const counts = { candidates: roots.size, valid: [...shaped.values()].filter(Boolean).length };
  const unique = !hidden && shaped.size === 1 && counts.valid === 1;
  return { extraction: unique ? { method: "candidate", value: answer, ...counts } : { method: "none", ...counts }, hidden };
}
export function extractFinalObject(final: string, accepts: PhaseAcceptor): FinalExtraction {
  return scanFinalMessage(final, accepts).extraction;
}
