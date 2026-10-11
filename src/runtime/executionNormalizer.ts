import { executionSchema, scanFinalMessage, type PhaseAcceptor } from "./codex/protocol.js";
import type { ExecutionResult } from "./types.js";
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
    return {status:"available",execution:executionSchema.parse(unwrap(extraction.value)),diagnostic:{...diagnostic,method:isWhole?"whole":"candidate"}};
  }
  return {status:"unavailable",reason:hidden||diagnostic.valid>0?"execution-format-ambiguous-or-hidden":"execution-format-invalid",diagnostic};
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
