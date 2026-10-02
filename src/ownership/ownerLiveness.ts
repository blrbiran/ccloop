import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyProcessLiveness, type LivenessVerdict } from "../persistence/fileStore.js";
import type { OwnerRecord } from "../runtime/types.js";

const execFileAsync = promisify(execFile);
export const OWNER_START_MARGIN_S = 2;
export type OwnerVerdict = { verdict: "dead" | "alive" | "undetermined"; reason: string };
export type OwnerLivenessDeps = {
  liveness?: (pid: number) => LivenessVerdict;
  readStart?: (pid: number) => Promise<string | null>;
};

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `ps -o lstart=` under TZ=UTC prints e.g. "Fri Oct  2 04:05:03 2026" with no zone; read it as UTC, never as local time. */
export function parseLstartUtc(text: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (match === null) return null;
  const month = MONTHS[match[1]!];
  if (month === undefined) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
}

export async function readProcessStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: 1_000,
      maxBuffer: 16 * 1024,
    });
    const text = stdout.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

function moment(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Spec 4.1: answers `dead` only when the owner's pid is gone, or is held by a process that started after the owner was
 * last known alive (R = the latest of its start, lastAffirmedAt, leaseAffirmedAt). Everything else is `alive` or
 * `undetermined`, and both refuse adoption.
 */
export async function classifyOwnerProcess(
  record: Pick<OwnerRecord, "currentProcessInstanceId" | "lastAffirmedAt"> & { leaseAffirmedAt?: string | null },
  deps: OwnerLivenessDeps = {},
): Promise<OwnerVerdict> {
  const id = record.currentProcessInstanceId;
  const parsed = /^pid:(\d+):(\d+)$/.exec(id);
  if (parsed === null) return { verdict: "undetermined", reason: `owner id ${JSON.stringify(id)} is not pid:<pid>:<startMs>` };
  const pid = Number(parsed[1]);
  const startMs = Number(parsed[2]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(startMs)) {
    return { verdict: "undetermined", reason: `owner id ${JSON.stringify(id)} is out of range` };
  }
  const live = (deps.liveness ?? classifyProcessLiveness)(pid);
  if (live.verdict === "dead") return { verdict: "dead", reason: `owner pid ${pid} does not exist` };
  if (live.verdict === "unknown") return { verdict: "undetermined", reason: `owner pid ${pid}: ${live.reason}` };
  const lstart = await (deps.readStart ?? readProcessStart)(pid);
  const holderStart = lstart === null ? null : parseLstartUtc(lstart);
  if (holderStart === null) {
    return { verdict: "undetermined", reason: `owner pid ${pid} is alive but its start time could not be read` };
  }
  const knownAlive = Math.max(startMs, moment(record.lastAffirmedAt) ?? startMs, moment(record.leaseAffirmedAt) ?? startMs);
  if (holderStart > Math.ceil(knownAlive / 1000) + OWNER_START_MARGIN_S) {
    return {
      verdict: "dead",
      reason: `pid ${pid} now belongs to a process started ${lstart} UTC, after the owner was last known alive (${new Date(knownAlive).toISOString()})`,
    };
  }
  return { verdict: "alive", reason: `owner pid ${pid} is alive (started ${lstart} UTC)` };
}
