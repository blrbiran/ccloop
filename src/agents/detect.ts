import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { probeVersion } from "./materialize.js";
import { canonicalOmpSelector, readOmpConfiguredDefault, readOmpModels } from "./ompModels.js";
import { getDescriptor, listDescriptors } from "./registry.js";
import type { AgentsTableV1, InstallationV1 } from "./types.js";

export interface CandidateV1 {
  path: string;
  realpath: string;
  version: string | null;
  runnable: boolean;
  source: string;
  isPathDefault: boolean;
  error?: string;
}
export type CandidatePath = Pick<CandidateV1, "path" | "realpath" | "source" | "isPathDefault">;
export interface DetectResultV1 {
  schema: "ccloop-agents-detect-v1";
  table: AgentsTableV1;
  candidates: Record<string, CandidateV1[]>;
}

const DRAFT_TIMEOUT_MS = 1_800_000;
const DRAFT_KILL_GRACE_MS = 5_000;

export function draftCommandForCandidate(kind: string, path: string): [string, ...string[]] {
  return [path, ...(getDescriptor(kind).draftCommandArgs ?? [])];
}

export async function draftInstallationForCandidate(kind: string, path: string, version: string): Promise<InstallationV1 | null> {
  const descriptor = getDescriptor(kind);
  const draft: InstallationV1 = {
    kind,
    command: draftCommandForCandidate(kind, path),
    version,
    configDir: null,
    timeoutMs: DRAFT_TIMEOUT_MS,
    killGraceMs: DRAFT_KILL_GRACE_MS,
    ...descriptor.draftInstallationExtras,
  };
  if (kind !== "omp") return draft;
  const active = process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "";
  draft.profile = active.trim() !== "" && active.trim() !== "default" ? active.trim() : null;
  try {
    const configured = await readOmpConfiguredDefault(draft);
    if (configured === null) return null;
    const defaultModel = canonicalOmpSelector(configured, await readOmpModels(draft));
    if (defaultModel === null) return null;
    return { ...draft, defaultModel };
  } catch { return null; }
}

/** Spec §4.3 / §12 I14: relative PATH entries and world-writable directories are never searched. */
async function searchable(dir: string): Promise<boolean> {
  if (!isAbsolute(dir)) return false;
  try {
    const metadata = await stat(dir);
    return metadata.isDirectory() && (metadata.mode & 0o002) === 0;
  } catch {
    return false;
  }
}

async function executableRealpath(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    await access(path, constants.X_OK);
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Finds every installation of every registered kind (spec §4.3): the descriptor's directories first, then PATH,
 * deduplicated by realpath; runs `--version` once per candidate. Reads only; writes nothing anywhere.
 * No login shell: `home` and `path` are the whole environment it searches, so a criterion can redirect both.
 */
export async function findAgentCandidatePaths(input: {
  home: string;
  path: string;
  platform: NodeJS.Platform;
}): Promise<Record<string, CandidatePath[]>> {
  const pathDirs = input.path.split(delimiter).filter((dir) => dir !== "");
  const candidates: Record<string, CandidatePath[]> = {};
  for (const descriptor of listDescriptors()) {
    const found: Array<{ path: string; realpath: string; source: string }> = [];
    const seen = new Set<string>();
    let pathDefault: string | null = null;
    const sources: Array<[string, string[]]> = [
      ["search-dir", descriptor.searchDirs({ home: input.home, env: { PATH: input.path }, platform: input.platform })],
      ["path", pathDirs],
    ];
    for (const [source, dirs] of sources) {
      for (const dir of dirs) {
        if (!(await searchable(dir))) continue;
        const path = join(dir, descriptor.binary);
        const real = await executableRealpath(path);
        if (real === null) continue;
        if (source === "path" && pathDefault === null) pathDefault = real;
        if (seen.has(real)) continue;
        seen.add(real);
        found.push({ path, realpath: real, source });
      }
    }
    candidates[descriptor.kind] = found.map((candidate) => ({ ...candidate, isPathDefault: candidate.realpath === pathDefault }));
  }
  return candidates;
}

export async function detectAgents(input: {
  home: string;
  path: string;
  platform: NodeJS.Platform;
  probe?: typeof probeVersion;
}): Promise<DetectResultV1> {
  const probe = input.probe ?? probeVersion;
  const paths = await findAgentCandidatePaths(input);
  const installations: Record<string, InstallationV1> = {};
  const candidates: Record<string, CandidateV1[]> = {};
  for (const descriptor of listDescriptors()) {
    const listed: CandidateV1[] = [];
    const ompDrafts = new Map<string, InstallationV1>();
    for (const candidate of paths[descriptor.kind] ?? []) {
      const version = await probe([candidate.path]);
      if (descriptor.kind === "omp" && version !== null) {
        const draft = await draftInstallationForCandidate(descriptor.kind, candidate.path, version);
        if (draft === null) {
          listed.push({ ...candidate, version, runnable: false, error: "omp-default-model-unresolved" });
          continue;
        }
        ompDrafts.set(candidate.path, draft);
      }
      listed.push({ ...candidate, version, runnable: version !== null, ...(version === null ? { error: "version-probe-failed" } : {}) });
    }
    candidates[descriptor.kind] = listed;
    const chosen = listed.find((candidate) => candidate.isPathDefault && candidate.runnable) ?? listed.find((candidate) => candidate.runnable);
    if (chosen !== undefined) {
      const draft = descriptor.kind === "omp" ? ompDrafts.get(chosen.path)! : await draftInstallationForCandidate(descriptor.kind, chosen.path, chosen.version!);
      if (draft !== null) installations[descriptor.kind] = draft;
    }
  }
  return { schema: "ccloop-agents-detect-v1", table: { schema: "ccloop-agents-table-v1", installations }, candidates };
}
