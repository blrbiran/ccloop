import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, type ArtifactRefV1 } from "./protocol.js";
import type { AcceptedRecordV1 } from "./store.js";
import { readPrivateFile } from "./paths.js";
import { writeEvidence } from "./evidence.js";

const execFileAsync = promisify(execFile);

export interface StopProofV1 {
  executionId: string;
  generation: number;
  isolated: true;
  source: ArtifactRefV1;
}

export interface StopProofRecord {
  sourceDir: string;
  accepted: AcceptedRecordV1;
}

interface RegisteredProcessV1 {
  pid: number;
  pgid: number;
  startedAt: string;
  phase: string;
  registeredAt: string;
}

type ProbeResult = "quiet" | "alive" | "unknown";

export interface StopProofDeps {
  graceMs?: number;
  probeGroup?: (process: RegisteredProcessV1) => Promise<ProbeResult>;
  sleep?: (ms: number) => Promise<void>;
}

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const registeredSchema = z.array(z.object({
  pid: positive,
  pgid: positive,
  startedAt: z.string().min(1),
  phase: z.string().min(1),
  registeredAt: z.string().datetime({ offset: true }),
}).strict());
const ownerSchema = z.object({
  leaseAffirmedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).passthrough();

async function readJson(sourceDir: string, target: string): Promise<unknown> {
  return JSON.parse((await readPrivateFile(sourceDir, target)).toString("utf8")) as unknown;
}

async function readProcesses(sourceDir: string): Promise<RegisteredProcessV1[] | null> {
  try {
    const parsed = registeredSchema.safeParse(await readJson(sourceDir, join(sourceDir, "control", "processes.json")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function ownerReleased(sourceDir: string): Promise<boolean> {
  try {
    const parsed = ownerSchema.safeParse(await readJson(sourceDir, join(sourceDir, "run", "owner-record.json")));
    return parsed.success && (parsed.data.leaseAffirmedAt ?? null) === null;
  } catch {
    return false;
  }
}

async function defaultProbe(processRecord: RegisteredProcessV1): Promise<ProbeResult> {
  try {
    process.kill(-processRecord.pgid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "quiet";
    return "unknown";
  }

  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(processRecord.pid)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: 1_000,
      maxBuffer: 16 * 1024,
    });
    const observed = stdout.trim();
    if (observed !== "" && observed !== processRecord.startedAt) return "unknown";
    return "alive";
  } catch {
    // The group probe above succeeded. A missing leader therefore means descendants still
    // occupy the registered group, which is alive rather than quiet.
    return "alive";
  }
}

async function probeAll(
  processes: RegisteredProcessV1[],
  probe: (process: RegisteredProcessV1) => Promise<ProbeResult>,
): Promise<boolean> {
  for (const processRecord of processes) {
    if (await probe(processRecord) !== "quiet") return false;
  }
  return true;
}

export async function proveStopped(record: StopProofRecord, deps: StopProofDeps = {}): Promise<StopProofV1 | null> {
  if (record.accepted.launch !== "sealed" || record.accepted.worker === null) return null;
  if (!(await ownerReleased(record.sourceDir))) return null;
  const probe = deps.probeGroup ?? defaultProbe;
  const first = await readProcesses(record.sourceDir);
  if (first === null || !(await probeAll(first, probe))) return null;
  await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(deps.graceMs ?? 100);
  if (!(await ownerReleased(record.sourceDir))) return null;
  const second = await readProcesses(record.sourceDir);
  if (second === null || !(await probeAll(second, probe))) return null;

  const evidence = {
    executionId: record.accepted.executionId,
    generation: record.accepted.generation,
    probedAt: new Date().toISOString(),
    graceMs: deps.graceMs ?? 100,
    registered: second.map(({ pid, pgid, startedAt, phase }) => ({ pid, pgid, startedAt, phase })),
    ownerLeaseReleased: true,
    workerSealed: true,
  };
  const source = await writeEvidence(record.sourceDir, Buffer.from(canonicalJson(evidence)));
  return {
    executionId: record.accepted.executionId,
    generation: record.accepted.generation,
    isolated: true,
    source,
  };
}
