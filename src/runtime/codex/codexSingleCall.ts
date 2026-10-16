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

/**
 * A server name `-c mcp_servers.<name>.enabled=false` can address. Measured on codex-cli 0.160.0: a quoted segment
 * (`mcp_servers."figma".enabled`) is taken literally and breaks the config ("invalid transport"), so only bare names are
 * addressable; the adapter refuses a call whose installation lists any other (codex-single-call-unavailable).
 */
export const addressableMcpServer = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name);

/**
 * `features` = the tool flags the installed codex lists (codex refuses an unknown flag); each is sent once.
 * `mcpServers` = the MCP servers the installation's config defines (Task 8 fix round 2, spec §6.1 "the matching -c
 * override"): each is turned off by name -- measured on codex-cli 0.160.0 with `codex mcp list --json`, a whole-table
 * `-c mcp_servers={}` leaves them on.
 */
export function codexSingleCallArgs(input: { model: string; cwd: string; schemaPath: string; finalPath: string; features: readonly string[]; mcpServers: readonly string[] }): string[] {
  return ["exec", "--json", "--ephemeral", "--color", "never", "--skip-git-repo-check", "--model", input.model, "--sandbox", "read-only",
    "-C", input.cwd, "--output-schema", input.schemaPath, "-o", input.finalPath,
    ...CODEX_SINGLE_CALL_CONFIG.flatMap((value) => ["-c", value]),
    ...input.features.filter((name) => !ALREADY_SET.has(name)).flatMap((name) => ["-c", `features.${name}=${TURNED_ON.has(name) ? "true" : "false"}`]),
    ...input.mcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-"];
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
 * call. Out-of-repo write: that path; writer = a ccloop control worker running a codex single call; residue on failure =
 * at most one `.<uuid>.link` temp link, plus any `<name>.displaced-<ms>` file moved aside. With no cache dir, a pair per
 * call under the run directory.
 */
export async function codexSingleCallHome(input: { runDir: string; sourceCodexHome: string | null; executable: string; env: NodeJS.ProcessEnv }): Promise<{ home: string; codexHome: string }> {
  const cache = catalogCacheDir(input.env);
  let base: string;
  if (cache === null) {
    let root = input.runDir;
    for (const part of ["codex", "1", "single-call"]) { root = join(root, part); await privateDir(root); }
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

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const observed = (error: Error, events: string) => Object.assign(error, { observedTokens: observedTurnUsage(events) });
const notSingle = (what: string, events: string) => Object.assign(observed(new Error(`codex-single-call-not-single:${what}`), events), { code: `codex-single-call-not-single:${what}` });

/**
 * §6.1, fail closed: no tool or command item, at most one completed agent message, exactly one completed turn, one object.
 * Task 8 fix round 2 (P1, codex-cli 0.160.0): an `error` item is a diagnostic codex emits for config warnings (an
 * unrecognized key in the linked config.toml, an under-development feature) -- allowed and logged on stderr; it stays in
 * events.jsonl. Every other item type that is not agent_message or reasoning, known or not, is a tool.
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
    if (row.type.startsWith("item.") && record(row.item) && row.item.type === "error") {
      process.stderr.write(`ccloop-codex-single-call: codex error item ${JSON.stringify(typeof row.item.message === "string" ? row.item.message : null)}\n`);
    } else if (row.type.startsWith("item.") && record(row.item) && row.item.type !== "agent_message" && row.item.type !== "reasoning") tool = true;
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
