import { join } from "node:path";
import { z } from "zod";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import type { RunState } from "../state/types.js";
import { ControlProtocolError, type StartEnvelopeV1 } from "./protocol.js";
import { readPrivateFile } from "./paths.js";
import { readUsageEvents, type UsageEventV1 } from "./usage.js";
import { readHandoffCandidate, type CandidateV1 } from "./handoff.js";
import { proveStopped, type StopProofV1 } from "./stopProof.js";
import { inspectStart, type ExecutionStatusV1 } from "./accept.js";
import { readAcceptedOptional } from "./store.js";

export interface CollectionV1 {
  events: UsageEventV1[];
  candidate: (Omit<CandidateV1, "stopProof"> & { stopProof: StopProofV1 | null }) | null;
  terminal: RunState | null;
}

const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

async function readTerminal(sourceDir: string): Promise<RunState | null> {
  const target = join(sourceDir, "run", "loop-state.json");
  try {
    const state = JSON.parse((await readPrivateFile(sourceDir, target)).toString("utf8")) as RunState;
    return isTerminalRunStatus(state.status) ? state : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new ControlProtocolError("control-terminal-invalid");
    throw error;
  }
}

export async function collectExecution(input: StartEnvelopeV1, afterSeq: number): Promise<CollectionV1> {
  if (!safe.safeParse(afterSeq).success) throw new ControlProtocolError("control-collect-invalid");
  const events = (await readUsageEvents(input.work.sourceDir)).filter((event) => event.eventSeq > afterSeq);
  const storedCandidate = await readHandoffCandidate(input.work.sourceDir);
  const accepted = storedCandidate === null ? null : await readAcceptedOptional(input.work.sourceDir);
  const proof = accepted === null
    ? null
    : await proveStopped({ sourceDir: input.work.sourceDir, accepted });
  return {
    events,
    candidate: storedCandidate === null ? null : { ...storedCandidate, stopProof: proof },
    terminal: await readTerminal(input.work.sourceDir),
  };
}

export async function inspectExecution(input: StartEnvelopeV1): Promise<ExecutionStatusV1> {
  const status = await inspectStart(input);
  if (status.kind !== "accepted") return status;
  const accepted = await readAcceptedOptional(input.work.sourceDir);
  const candidate = await readHandoffCandidate(input.work.sourceDir);
  if (accepted === null || candidate === null) return status;
  const proof = await proveStopped({ sourceDir: input.work.sourceDir, accepted });
  return proof === null ? status : { kind: "stopped", proof };
}
