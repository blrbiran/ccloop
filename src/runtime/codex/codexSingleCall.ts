import { CODEX_SINGLE_CALL_CONFIG } from "../../agents/codexIsolation.js";
import { parseSingleCallObject } from "../omp/ompSingleCall.js";
import { SingleCallOutputInvalid, type SingleCallResult } from "../types.js";
import { codexModelUsage, decodeCodexUsage, observedTurnUsage } from "./protocol.js";

// Task 8 fix round 3: the isolation (the -c list and the private homes) lives in a leaf module so the catalog read can run
// its MCP probe under it without an import cycle through registry; re-exported here for the adapter and the criteria.
export { CODEX_SINGLE_CALL_CONFIG, codexSingleCallHome, effectiveCodexHome } from "../../agents/codexIsolation.js";

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
