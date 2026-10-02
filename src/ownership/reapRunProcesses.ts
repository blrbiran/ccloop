import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent } from "../persistence/fileStore.js";
import { readProcessStart } from "./ownerLiveness.js";

export const REAP_GRACE_MS = 5_000;
export const REAP_TIMEOUT_MS = 15_000;
export type ReapResult = { ok: true; reaped: number } | { ok: false; reason: string };
export type ReapDeps = {
  probeGroup?: (pgid: number) => "gone" | "present" | { error: string };
  readStart?: (pid: number) => Promise<string | null>;
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  timeoutMs?: number;
  pollMs?: number;
};
type Registered = { pid: number; pgid: number; startedAt: string; phase: string };

const exists = (path: string) => access(path).then(() => true, () => false);

async function unfinishedCalls(runDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, top: boolean): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "process.json") && !entries.some((e) => e.isFile() && e.name === "outcome.json")) found.push(dir);
    for (const e of entries) if (e.isDirectory() && !(top && e.name === "worktrees")) await walk(join(dir, e.name), false);
  }
  await walk(runDir, true);
  return found.sort();
}

function parseRegistered(text: string): Registered | null {
  try {
    const v = JSON.parse(text) as Partial<Registered>;
    const ok = Number.isSafeInteger(v.pid) && v.pid! > 0 && Number.isSafeInteger(v.pgid) && v.pgid! > 0 && typeof v.startedAt === "string" && v.startedAt !== "" && typeof v.phase === "string";
    return ok ? (v as Registered) : null;
  } catch { return null; }
}

function defaultProbe(pgid: number): "gone" | "present" | { error: string } {
  try { process.kill(-pgid, 0); return "present"; }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; return code === "ESRCH" ? "gone" : { error: String(code) }; }
}

/** Spec §4.2. Only calls the adapter never finished (no outcome.json); reaps only an exact lstart match; refuses when unsure. */
export async function reapRunProcesses(runDir: string, deps: ReapDeps = {}): Promise<ReapResult> {
  const probe = deps.probeGroup ?? defaultProbe;
  const readStart = deps.readStart ?? readProcessStart;
  const signal = deps.signalGroup ?? ((pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* raced to exit */ } });
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = deps.graceMs ?? REAP_GRACE_MS, timeoutMs = deps.timeoutMs ?? REAP_TIMEOUT_MS, pollMs = deps.pollMs ?? 100;
  const targets: Registered[] = [];
  for (const dir of await unfinishedCalls(runDir)) {
    const registered = parseRegistered(await readFile(join(dir, "process.json"), "utf8").catch(() => ""));
    if (registered === null) {
      if (!(await exists(join(dir, "request.json")))) continue; // the runner never received a prompt
      return { ok: false, reason: `${join(dir, "process.json")} is unreadable and the call had a request` };
    }
    const state = probe(registered.pgid);
    if (state === "gone") continue;
    if (typeof state === "object") return { ok: false, reason: `process group ${registered.pgid}: ${state.error}` };
    const lstart = await readStart(registered.pid);
    if (lstart === null) return { ok: false, reason: `process group ${registered.pgid} is alive but its leader ${registered.pid} is gone` };
    if (lstart !== registered.startedAt.trim()) return { ok: false, reason: `pid ${registered.pid} started ${lstart}, not ${registered.startedAt}` };
    targets.push(registered);
  }
  const waitGone = async (pgid: number, ms: number) => {
    for (let waited = 0; waited <= ms; waited += pollMs) { if (probe(pgid) === "gone") return true; await sleep(pollMs); }
    return probe(pgid) === "gone";
  };
  for (const t of targets) {
    signal(t.pgid, "SIGTERM");
    if (!(await waitGone(t.pgid, graceMs))) {
      signal(t.pgid, "SIGKILL");
      if (!(await waitGone(t.pgid, timeoutMs))) return { ok: false, reason: `process group ${t.pgid} survived SIGKILL for ${timeoutMs}ms` };
    }
    await appendEvent(runDir, { type: "orphan_process_group_reaped", at: new Date().toISOString(), detail: `pid ${t.pid} pgid ${t.pgid} phase ${t.phase}` });
  }
  return { ok: true, reaped: targets.length };
}
