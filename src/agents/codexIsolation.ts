import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { catalogCacheDir } from "./catalogCache.js";
import type { InstallationV1 } from "./types.js";

// Every-agent requirement chain Task 8 (Orca spec 2026-10-15 §2.5, §6.1, R9). Moved here from
// src/runtime/codex/codexSingleCall.ts unchanged in fix round 3, so the codex catalog read can list MCP servers under the
// same isolation as the call (a leaf: imports only catalogCache, no registry).

/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §2.5 last row, §6.1; values from plan Task 0 on codex-cli 0.160.0).
 * `features.plugins=false` is here, not only among the tool flags: Task 0 measured that it removes the
 * <recommended_plugins> block a linked config.toml injects (`features.recommended_plugins=false` does not).
 * Final-review I4 (Orca session a852f96a, 2026-10-16): `notify=[]`, so a `notify` program in the linked config.toml is
 * never run by a single call (zero-cost check on codex-cli 0.160.0: `debug prompt-input` with it RC 0, empty stderr).
 */
export const CODEX_SINGLE_CALL_CONFIG: readonly string[] = [
  "include_permissions_instructions=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false",
  "include_environment_context=false", "project_doc_max_bytes=0", "features.plugins=false", "notify=[]",
];

/**
 * Codex phase isolation (ccloop spec 2026-10-18 §3.3; Orca session 3d229487): the `-c` values every codex loop phase sends
 * on top of the private homes. Unlike CODEX_SINGLE_CALL_CONFIG it keeps the target repo's docs, the environment context
 * and the permissions instructions, and touches no tool flag; `features.hooks=false` because the linked config.toml can
 * carry hook definitions (`hooks.state`) the private CODEX_HOME would not otherwise drop. Accepted by codex-cli 0.163.0.
 */
export const CODEX_PHASE_CONFIG: readonly string[] = [
  "notify=[]", "features.plugins=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false", "features.hooks=false",
];

/**
 * The installation's effective CODEX_HOME (Task 8 ruling 2): its configDir, else an inherited absolute non-empty
 * CODEX_HOME, else <HOME>/.codex (HOME absolute), else none.
 */
export function effectiveCodexHome(installation: InstallationV1, env: NodeJS.ProcessEnv): string | null {
  const inherited = env.CODEX_HOME, home = env.HOME;
  return installation.configDir ?? (inherited && isAbsolute(inherited) ? inherited : home && isAbsolute(home) ? join(home, ".codex") : null);
}

/** A private dir that is not a real directory of this user (a symlink, a file, someone else's) refuses the call unspawned. */
const homeInvalid = (path: string) => Object.assign(new Error(`codex-single-call-home-invalid:${path}`), { code: "codex-single-call-home-invalid", neverStarted: true });

/**
 * Creates `dir` with 0700 set explicitly when it is missing; an existing one (also one a concurrent call made) keeps its
 * mode. Either way it must then be a real directory, not a symlink, owned by this user (fix round 1: a symlinked
 * codex-home would make ensureLink rename a link over the installation's own auth.json). Precedent: control/paths.ts
 * ensurePrivateDirectory, which needs an existing canonical root this path does not have.
 */
async function privateDir(dir: string): Promise<void> {
  let created = true;
  try { await mkdir(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; created = false; }
  if (created) await chmod(dir, 0o700);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw homeInvalid(dir);
}

/**
 * Controller ruling (fix round 1): a regular file where a link belongs is never deleted -- codex may have rotated a token
 * into it by temp+rename -- but moved aside to `<name>.displaced-<epoch ms>` in the same private dir, mode unchanged.
 */
async function displace(path: string): Promise<void> {
  const aside = `${path}.displaced-${Date.now()}`;
  await rename(path, aside);
  process.stderr.write(`ccloop-codex-single-call: displaced ${path} to ${aside}\n`);
}

/** `path` becomes a symlink to `target` (replaced atomically when it is anything else), or absent when target is null. */
async function ensureLink(path: string, target: string | null): Promise<void> {
  const current = await lstat(path).then((info) => info, () => null);
  if (current !== null && !current.isSymbolicLink()) await displace(path);
  else if (current !== null && target === null) await rm(path, { force: true });
  if (target === null) return;
  if (current?.isSymbolicLink() === true && await readlink(path) === target) return;
  const temporary = join(dirname(path), `.${randomUUID()}.link`);
  await symlink(target, temporary);
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/**
 * R9: a private, empty HOME and a private CODEX_HOME whose auth.json and config.toml are symlinks to the installation's
 * (never copies). Ruling (Task 8, Orca session a852f96a, 2026-10-16, answering the human): ONE pair per installation,
 * reused, under `<catalog cache dir>/codex-home/<sha256 of realpath(executable) NUL sourceCodexHome>/` -- codex writes
 * ~2.4 MB of its own state plus a remote models fetch into a fresh CODEX_HOME (Task 0). The links are re-checked on every
 * call.
 *
 * Out-of-repo write (Orca Rule 17 / ccloop's equivalent; registration rewritten in Task 8 fix round 4):
 * - Path: `<catalog cache dir>/codex-home/<sha256>/{home,codex-home}` (cache dir = $CCLOOP_CACHE_DIR, else
 *   $XDG_CACHE_HOME/ccloop/agent-catalog, else <HOME>/.cache/ccloop/agent-catalog; catalogCache.ts).
 * - Writers and triggers: (1) any ccloop process whose codex catalog read MISSES the cache -- `control capabilities` /
 *   `control models` / `ccloop agents models`, codex resolution for loop phases and accept (materialize.ts, e.g. `run
 *   --agents`) -- through the isolated `codex mcp list --json` probe (codexCatalog.ts; agents updates read the catalog
 *   for omp only, so they never write here); (2) the control worker
 *   running a codex single call (CodexAdapter.singleCall), on every call.
 * - What is written: by ccloop, the missing dirs (0700, set explicitly; an existing dir's mode is left alone) and the
 *   two symlinks `codex-home/{auth.json,config.toml}` -> the installation's own files (never copies); by codex itself
 *   (its own modes), its runtime state in that codex-home -- models_cache.json, sqlite state/logs, installation_id,
 *   skills/, tmp/, shell_snapshots/, mcp-oauth-locks/ -- for both the probe and the call. `home` stays empty unless codex
 *   writes there.
 * - Residue on failure: at most one `.<uuid>.link` temp link; any regular file found where a link belongs is kept as
 *   `<name>.displaced-<epoch ms>` (never deleted); whatever codex wrote before it failed. The dirs are never removed.
 * - No cache dir: the single call makes a pair per call under its run directory (`<runDir>/codex/1/single-call/home-*`);
 *   the catalog probe makes a pair under a fresh `mkdtemp(<tmpdir>/ccloop-codex-mcp-*)` removed in `finally` -- a
 *   crash before that leaves the temp dir (its links and codex's state) behind.
 *
 * *** 2026-10-20 (codex phase isolation, ccloop spec 2026-10-18 §4; Orca session 3d229487, design Orca session a3b2a7a7):
 * writer (3) -- every codex loop phase, on every call (`runCodexPhase` given an installation, i.e. every phase of an
 * adapter built by codexDescriptor.createAdapter), through codexPhaseIsolation: creates the missing dirs and re-checks the
 * two links exactly as (2), and codex writes its own state into the same pair while the phase runs. Its catalog read is
 * writer (1). Without a cache dir the phase makes a pair per call under `<runDir>/codex/<attempt>/phase-isolation/home-*`
 * (never removed). Residue unchanged. ***
 */
export async function codexSingleCallHome(input: { runDir: string; sourceCodexHome: string | null; executable: string; env: NodeJS.ProcessEnv; fallback?: readonly string[] }): Promise<{ home: string; codexHome: string }> {
  const cache = catalogCacheDir(input.env);
  let base: string;
  if (cache === null) {
    let root = input.runDir;
    for (const part of input.fallback ?? ["codex", "1", "single-call"]) { root = join(root, part); await privateDir(root); }
    base = await mkdtemp(join(root, "home-"));
    await chmod(base, 0o700);
    await privateDir(base);
  } else {
    const executable = await realpath(input.executable).catch(() => input.executable);
    base = join(cache, "codex-home", createHash("sha256").update(`${executable}\0${input.sourceCodexHome ?? ""}`).digest("hex"));
    const missing: string[] = [];
    for (let at = cache; at !== dirname(at); at = dirname(at)) {
      if (await lstat(at).then(() => true, () => false)) break;
      missing.unshift(at);
    }
    for (const dir of missing) await privateDir(dir);
    for (const dir of [join(cache, "codex-home"), base]) await privateDir(dir);
  }
  const home = join(base, "home"), codexHome = join(base, "codex-home");
  for (const dir of [home, codexHome]) await privateDir(dir);
  for (const name of ["auth.json", "config.toml"]) {
    const source = input.sourceCodexHome === null ? null : join(input.sourceCodexHome, name);
    await ensureLink(join(codexHome, name), source !== null && await lstat(source).then(() => true, () => false) ? source : null);
  }
  return { home, codexHome };
}

