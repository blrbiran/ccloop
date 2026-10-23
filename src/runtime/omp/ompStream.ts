import type { JsonLine } from "../streamLines.js";
import { OmpCallFold } from "../failureCause.js";
import { OmpToolRuleFold, type ToolRulesV1 } from "../toolRules.js";
import { OmpLowerBoundFold, OmpPhaseFold } from "./ompProtocol.js";
import { OmpSingleCallFold } from "./ompSingleCall.js";
import type { OmpPhase } from "./phasePrompt.js";

export type OmpStreamPurpose =
  | { phase: OmpPhase; selector: string; toolRules?: { rules: ToolRulesV1; requiredChecks: readonly string[] } }
  | { phase: "single-call"; selector: string };

/**
 * Live transcript (Orca spec 2026-10-23 §10.2.3): everything the omp adapter reads from a call's stdout, folded line by line
 * as the call prints it, so the stream is never held whole. The decoder is the phase's or the single call's; the tool-rule
 * check runs only for an execute whose contract has rules.
 */
export class OmpStream {
  readonly lowerBound = new OmpLowerBoundFold();
  readonly call = new OmpCallFold();
  readonly phase: OmpPhaseFold | null;
  readonly singleCall: OmpSingleCallFold | null;
  readonly toolRule: OmpToolRuleFold | null;

  constructor(purpose: OmpStreamPurpose) {
    this.phase = purpose.phase === "single-call" ? null : new OmpPhaseFold(purpose.phase, purpose.selector);
    this.singleCall = purpose.phase === "single-call" ? new OmpSingleCallFold(purpose.selector) : null;
    this.toolRule = purpose.phase !== "single-call" && purpose.toolRules !== undefined ? new OmpToolRuleFold(purpose.toolRules.rules, purpose.toolRules.requiredChecks) : null;
  }

  push(line: JsonLine): void {
    this.lowerBound.push(line); this.call.push(line);
    this.phase?.push(line); this.singleCall?.push(line); this.toolRule?.push(line);
  }
}
