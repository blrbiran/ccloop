import { join } from "node:path";
import { z } from "zod";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import type { RunState } from "../state/types.js";
import { ControlProtocolError, type StartEnvelopeV1 } from "./protocol.js";
import { readPrivateFile } from "./paths.js";
import { readUsageEvents, type UsageEventV1 } from "./usage.js";

export interface CollectionV1 {
  events: UsageEventV1[];
  candidate: null;
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
  return {
    events,
    candidate: null,
    terminal: await readTerminal(input.work.sourceDir),
  };
}
