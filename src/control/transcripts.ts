import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { transcriptTruncatedAt } from "../runtime/streamLines.js";

/**
 * Live transcript (Orca spec docs/superpowers/specs/2026-10-23-live-transcript-design.md §10.2.4; ccloop plan
 * 2026-10-24-live-transcript-ccloop.md D7): one agent call's transcript as `control collect` lists it, so Orca never walks
 * ccloop's directories by guess. `path` is relative to the run directory (`<sourceDir>/run`) and its first segment names the
 * runtime; null for a call recorded before transcripts existed (bytes 0, truncatedAt null). `seq` is the call's 1-based order
 * within its phase. `final`: the call wrote outcome.json, or the run is terminal, or a stop proof exists -- so a call whose
 * worker died does not read as live forever.
 */
export interface TranscriptEntryV1 {
  attempt: number;
  phase: string;
  seq: number;
  path: string | null;
  bytes: number;
  final: boolean;
  truncatedAt: number | null;
}

const KINDS = ["claude", "codex", "omp"] as const;
const ATTEMPT = /^[1-9][0-9]{0,8}$/;
const PHASE = /^[a-z][a-z-]{0,31}$/;
const CALL = /^call-[A-Za-z0-9]{1,64}$/;

async function realDirectories(dir: string, pattern: RegExp): Promise<string[]> {
  let names: string[];
  try { names = await readdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
  const kept: string[] = [];
  for (const name of names.filter((candidate) => pattern.test(candidate)).sort()) {
    // lstat: a symlink is never followed, so every listed path stays inside the run directory.
    const stats = await lstat(join(dir, name)).catch(() => null);
    if (stats?.isDirectory()) kept.push(name);
  }
  return kept;
}

async function regularFile(path: string): Promise<{ size: number } | null> {
  const stats = await lstat(path).catch(() => null);
  return stats?.isFile() ? { size: stats.size } : null;
}

/** process.json's `startedAt` (ps lstart, written with TZ=UTC) as milliseconds, or null when absent or unreadable. */
async function startedAtMs(callDir: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(join(callDir, "process.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return null;
    const startedAt = (JSON.parse((await handle.readFile()).toString("utf8")) as { startedAt?: unknown }).startedAt;
    if (typeof startedAt !== "string") return null;
    const ms = Date.parse(`${startedAt} UTC`);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; } finally { await handle?.close(); }
}

/**
 * Every call under `<sourceDir>/run/<kind>/<attempt>/<phase>/call-*`, ordered by kind, attempt, phase and seq. Call
 * directories are mkdtemp names, so their order means nothing: within a phase, calls are ordered by process.json
 * `startedAt` (then by name), and calls that never registered a process follow, by name.
 */
export async function listTranscripts(sourceDir: string, runFinal: boolean): Promise<TranscriptEntryV1[]> {
  const runDir = join(sourceDir, "run");
  const entries: TranscriptEntryV1[] = [];
  for (const kind of KINDS) {
    const kindDir = join(runDir, kind);
    const attempts = (await realDirectories(kindDir, ATTEMPT)).sort((left, right) => Number(left) - Number(right));
    for (const attempt of attempts) {
      for (const phase of await realDirectories(join(kindDir, attempt), PHASE)) {
        const phaseDir = join(kindDir, attempt, phase);
        const calls = await Promise.all((await realDirectories(phaseDir, CALL)).map(async (name) => ({ name, startedAt: await startedAtMs(join(phaseDir, name)) })));
        calls.sort((left, right) => (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        for (const [index, call] of calls.entries()) {
          const callDir = join(phaseDir, call.name);
          const transcript = await regularFile(join(callDir, "transcript.jsonl"));
          const outcome = await regularFile(join(callDir, "outcome.json"));
          entries.push({
            attempt: Number(attempt), phase, seq: index + 1,
            path: transcript === null ? null : [kind, attempt, phase, call.name, "transcript.jsonl"].join("/"),
            bytes: transcript?.size ?? 0,
            final: outcome !== null || runFinal,
            truncatedAt: transcript === null ? null : await transcriptTruncatedAt(join(callDir, "transcript.jsonl")),
          });
        }
      }
    }
  }
  return entries;
}
