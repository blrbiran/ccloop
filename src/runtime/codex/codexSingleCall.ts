import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { catalogCacheDir } from "../../agents/catalogCache.js";
import { parseSingleCallObject } from "../omp/ompSingleCall.js";
import { SingleCallOutputInvalid, type SingleCallResult } from "../types.js";
import { codexModelUsage, decodeCodexUsage, observedTurnUsage } from "./protocol.js";

/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §2.5 last row, §6.1; values from plan Task 0 on codex-cli 0.160.0).
 * `features.plugins=false` is here, not only among the tool flags: Task 0 measured that it removes the
 * <recommended_plugins> block a linked config.toml injects (`features.recommended_plugins=false` does not).
 */
export const CODEX_SINGLE_CALL_CONFIG: readonly string[] = [
  "include_permissions_instructions=false", "include_apps_instructions=false", "include_collaboration_mode_instructions=false",
  "include_environment_context=false", "project_doc_max_bytes=0", "features.plugins=false",
];
const TURNED_ON = new Set(["skip_host_skill_discovery"]);
const ALREADY_SET = new Set(CODEX_SINGLE_CALL_CONFIG.filter((value) => value.startsWith("features.")).map((value) => value.slice(9, value.indexOf("="))));

/** `features` = the tool flags the installed codex lists (codex refuses an unknown flag); each is sent once. */
export function codexSingleCallArgs(input: { model: string; cwd: string; schemaPath: string; finalPath: string; features: readonly string[] }): string[] {
  return ["exec", "--json", "--ephemeral", "--color", "never", "--skip-git-repo-check", "--model", input.model, "--sandbox", "read-only",
    "-C", input.cwd, "--output-schema", input.schemaPath, "-o", input.finalPath,
    ...CODEX_SINGLE_CALL_CONFIG.flatMap((value) => ["-c", value]),
    ...input.features.filter((name) => !ALREADY_SET.has(name)).flatMap((name) => ["-c", `features.${name}=${TURNED_ON.has(name) ? "true" : "false"}`]),
    "-"];
}

/** Creates `dir` with 0700 set explicitly when it is missing; an existing one (also one a concurrent call made) is left alone. */
async function privateDir(dir: string): Promise<void> {
  try { await mkdir(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  await chmod(dir, 0o700);
}

/** `path` becomes a symlink to `target` (replaced atomically when it is anything else), or absent when target is null. */
async function ensureLink(path: string, target: string | null): Promise<void> {
  const current = await lstat(path).then((info) => info, () => null);
  if (target === null) { if (current !== null) await rm(path, { force: true }); return; }
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
 * call. Out-of-repo write: that path; writer = a ccloop control worker running a codex single call; residue on failure =
 * at most one `.<uuid>.link` temp link. With no cache dir, a pair per call under the run directory.
 */
export async function codexSingleCallHome(input: { runDir: string; sourceCodexHome: string | null; executable: string; env: NodeJS.ProcessEnv }): Promise<{ home: string; codexHome: string }> {
  const cache = catalogCacheDir(input.env);
  let base: string;
  if (cache === null) {
    const root = join(input.runDir, "codex", "1", "single-call");
    await mkdir(root, { recursive: true, mode: 0o700 });
    base = await mkdtemp(join(root, "home-"));
  } else {
    const executable = await realpath(input.executable).catch(() => input.executable);
    base = join(cache, "codex-home", createHash("sha256").update(`${executable}\0${input.sourceCodexHome ?? ""}`).digest("hex"));
    const missing: string[] = [];
    for (let at = base; at !== dirname(at); at = dirname(at)) {
      if (await lstat(at).then(() => true, () => false)) break;
      missing.unshift(at);
    }
    for (const dir of missing) await privateDir(dir);
  }
  const home = join(base, "home"), codexHome = join(base, "codex-home");
  for (const dir of [home, codexHome]) await privateDir(dir);
  for (const name of ["auth.json", "config.toml"]) {
    const source = input.sourceCodexHome === null ? null : join(input.sourceCodexHome, name);
    await ensureLink(join(codexHome, name), source !== null && await lstat(source).then(() => true, () => false) ? source : null);
  }
  return { home, codexHome };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const observed = (error: Error, events: string) => Object.assign(error, { observedTokens: observedTurnUsage(events) });
const notSingle = (what: string, events: string) => Object.assign(observed(new Error(`codex-single-call-not-single:${what}`), events), { code: `codex-single-call-not-single:${what}` });

/**
 * §6.1, fail closed: no tool or command item, at most one completed agent message, exactly one completed turn, one object.
 * Every refusal books the turn usage observed so far (null when none), never 0; "no object" is single-call-output-invalid
 * (plan issue 10).
 */
export function decodeCodexSingleCall(events: string, final: string | null, model: string, evidenceDir: string): SingleCallResult {
  let messages = 0, turns = 0, tool = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw observed(new Error("codex-events-invalid"), events); }
    if (!record(row) || typeof row.type !== "string") throw observed(new Error("codex-events-invalid"), events);
    if (row.type.startsWith("item.") && record(row.item) && row.item.type !== "agent_message" && row.item.type !== "reasoning") tool = true;
    if (row.type === "item.completed" && record(row.item) && row.item.type === "agent_message") messages += 1;
    if (row.type === "turn.completed") turns += 1;
  }
  if (tool) throw notSingle("tool", events);
  if (messages > 1) throw notSingle("messages", events);
  if (turns > 1) throw notSingle("turns", events);
  let usage: ReturnType<typeof decodeCodexUsage>;
  try { usage = decodeCodexUsage(events, true); } catch (error) { throw observed(error as Error, events); }
  const modelUsage = codexModelUsage(events, model);
  const output = final === null ? undefined : parseSingleCallObject(final);
  if (output === undefined) throw new SingleCallOutputInvalid(evidenceDir, usage.tokenUsage, usage.usageEvidence);
  return { output, tokenUsage: usage.tokenUsage, usageEvidence: usage.usageEvidence, ...(modelUsage === null ? {} : { modelUsage }) };
}
