import { executionSchema, scanFinalMessage, type PhaseAcceptor } from "./codex/protocol.js";
import type { ExecutionResult } from "./types.js";
import { dropUnreported } from "./reportedDecisions.js";
import { causeDetail } from "./failureCause.js";
import type { ZodIssue } from "zod";
export const EXECUTION_NORMALIZER_VERSION = "strict-execution-v1";
type Diagnostic = { method:"whole"|"candidate"|"none"; candidates:number; valid:number; hidden:boolean; originalBytes:number };
export type ExecutionNormalization =
  | { status:"available"; execution:ExecutionResult; diagnostic:Diagnostic }
  | { status:"unavailable"; reason:"execution-format-invalid"|"execution-format-ambiguous-or-hidden"; diagnostic:Diagnostic };
const record = (x:unknown):x is Record<string,unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const unwrap = (value:unknown):unknown => record(value) && Object.keys(value).length===1 && Object.hasOwn(value,"result") ? value.result : value;
const accepts:PhaseAcceptor = Object.assign((value:unknown)=>executionSchema.safeParse(unwrap(value)).success, {
  keys:["result","changedFiles","diffPatch","commandOutputs","stdoutStderrLog","completionStatus","failureType","failureMessage"], opaqueTaskResult:true,
});
/** Exact execute shapes only; the bounded scanner owns ambiguity and original report fingerprints. */
export function normalizeExecutionFinal(final:string):ExecutionNormalization {
  let whole:unknown, isWhole=false;
  try { whole=JSON.parse(final);isWhole=true; } catch { /* decorated */ }
  const {extraction,hidden}=scanFinalMessage(final,accepts,true);
  const diagnostic:Diagnostic={method:extraction.method,candidates:"candidates" in extraction?extraction.candidates:1,valid:"valid" in extraction?extraction.valid:1,hidden,originalBytes:Buffer.byteLength(final,"utf8")};
  if (extraction.method === "candidate" && (!isWhole || accepts(whole))) {
    return {status:"available",execution:dropUnreported(executionSchema.parse(unwrap(extraction.value))),diagnostic:{...diagnostic,method:isWhole?"whole":"candidate"}};
  }
  return {status:"unavailable",reason:hidden||diagnostic.valid>0?"execution-format-ambiguous-or-hidden":"execution-format-invalid",diagnostic};
}

/**
 * What the strict execute shape refused in a final that is one JSON object, for diagnosis only -- the normalizer alone
 * decides acceptance. The issues are those of the shape the answer aimed at (partial when it names completionStatus),
 * parsed alone: zod's union would report whichever branch failed only on unrecognized keys (Orca tester issues 125/158).
 */
export function executionShapeIssues(final:string):ZodIssue[] {
  let value:unknown;
  try { value=JSON.parse(final); } catch { return []; }
  value=unwrap(value);
  if (executionSchema.safeParse(value).success) return [];
  const parsed=executionSchema.options[record(value)&&Object.hasOwn(value,"completionStatus")?1:0].safeParse(value);
  return parsed.success?[]:parsed.error.issues;
}

/**
 * Orca tester issue #274: the field the strict execute shape refused, with what it expected and what it received when zod
 * says so (a wrong type, a missing field, a wrong literal). At most 8, for the call's execution-format-issues.json.
 */
export type ExecutionFormatField = { path:string; expected?:string; received?:string; message:string };
export function executionFormatFields(final:string):ExecutionFormatField[] {
  return executionShapeIssues(final).slice(0,8).map((issue)=>{
    const path=issue.path.join("."), message=causeDetail(issue.message);
    if (issue.code==="invalid_type") return {path,expected:issue.expected,received:issue.received,message};
    if (issue.code==="invalid_literal") return {path,expected:causeDetail(JSON.stringify(issue.expected)??String(issue.expected)),received:causeDetail(JSON.stringify(issue.received)??String(issue.received)),message};
    return {path,message};
  });
}
/** The first refused field as one bounded line, e.g. `commandOutputs: expected array, received string`; null when none. */
export function executionFormatFieldDetail(fields:readonly ExecutionFormatField[]):string|null {
  const first=fields[0];
  if (first===undefined) return null;
  return causeDetail(`${first.path===""?"(top level)":first.path}: ${first.expected===undefined?first.message:`expected ${first.expected}, received ${first.received}`}`.replace(/[\r\n]+/g," "));
}

import type { ModelUsageV1 } from "../control/usage.js";
import type { UsageEvidence } from "./types.js";
/** Only constructed after successful process/stream/usage validation, never from provider claims. */
export class ExecutionFormatFailure extends Error {
  constructor(message:string, readonly evidenceDir:string, readonly observedTokens:number,
    readonly usageEvidence:UsageEvidence, readonly modelUsage:ModelUsageV1[]|undefined,
    readonly normalization:ExecutionNormalization) {
    super(message); this.name="ExecutionFormatFailure";
  }
}
