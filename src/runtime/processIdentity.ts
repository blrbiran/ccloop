import { performance } from "node:perf_hooks";

// §5.1: PIDs are recycled, so `pid:<pid>` alone can be handed to an unrelated later
// process which would then match a stale lease as "held by me". performance.timeOrigin is
// this process's start time in epoch milliseconds, which no concurrent process with the
// same PID can share. The value is opaque and only ever compared for string equality.
const PROCESS_INSTANCE_ID = `pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`;

export function buildProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}
