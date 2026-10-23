import type { JsonLine } from "../streamLines.js";
import { CodexCallFold } from "../failureCause.js";
import { CodexSingleCallFold } from "./codexSingleCall.js";
import { CodexUsageFold, ModelUsageFold, TurnUsageFold } from "./protocol.js";
import { RateLimitFold } from "./rateLimit.js";

/**
 * Live transcript (Orca spec 2026-10-23 §10.2.3): everything the codex adapter reads from a call's stdout, folded line by
 * line as the call prints it, so the stream is never held whole. Each fold gives the verdict its string function gives on
 * the same text (those functions are now the same folds over the text's lines).
 */
export class CodexStream {
  readonly turnUsage = new TurnUsageFold();
  readonly usage = new CodexUsageFold(false);
  readonly uniqueUsage = new CodexUsageFold(true);
  readonly rateLimit = new RateLimitFold();
  readonly call = new CodexCallFold();
  readonly modelUsage = new ModelUsageFold();
  readonly singleCall = new CodexSingleCallFold();

  push(line: JsonLine): void {
    this.turnUsage.push(line); this.usage.push(line); this.uniqueUsage.push(line);
    this.rateLimit.push(line); this.call.push(line); this.modelUsage.push(line); this.singleCall.push(line);
  }
}
