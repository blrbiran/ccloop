import { CODEX_SINGLE_CALL_CONFIG } from "../../agents/codexIsolation.js";
import { parseSingleCallObject } from "../omp/ompSingleCall.js";
import { SingleCallOutputInvalid, type SingleCallResult } from "../types.js";
import { CodexUsageFold, ModelUsageFold, TurnUsageFold, type decodeCodexUsage } from "./protocol.js";
import { foldText, type JsonLine } from "../streamLines.js";

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
const observed = (error: Error, observedTokens: number | null) => Object.assign(error, { observedTokens });
const notSingle = (what: string, observedTokens: number | null) => Object.assign(observed(new Error(`codex-single-call-not-single:${what}`), observedTokens), { code: `codex-single-call-not-single:${what}` });

/**
 * §6.1, fail closed: no tool or command item, at most one completed agent message, exactly one completed turn, one object.
 * Task 8 fix round 2 (P1, codex-cli 0.160.0): an `error` item is a diagnostic codex emits for config warnings (an
 * unrecognized key in the linked config.toml, an under-development feature) -- allowed and logged on stderr; it stays in
 * events.jsonl. Every other item type that is not agent_message or reasoning, known or not, is a tool.
 * Every refusal books the turn usage observed so far (null when none), never 0; "no object" is single-call-output-invalid
 * (plan issue 10).
 */
export function decodeCodexSingleCall(events: string, final: string | null, model: string, evidenceDir: string): SingleCallResult {
  return foldText(events, new CodexSingleCallFold()).value(final, model, evidenceDir);
}

/** codex `error` items logged at decode time; real codex prints one to three (config warnings), the rest are counted. */
const MAX_LOGGED_ERROR_ITEMS = 64;

/**
 * Live transcript (Orca spec 2026-10-23 §10.2.3): decodeCodexSingleCall as a fold. Its own loop stopped at the first
 * invalid line; the usage folds beside it read every line, as observedTurnUsage, decodeCodexUsage and codexModelUsage did
 * over the whole text. The error items are logged when the answer is decoded, as before.
 */
export class CodexSingleCallFold {
  private error: string | null = null;
  private messages = 0; private turns = 0; private tool = false;
  private readonly errorItems: string[] = []; private unloggedErrorItems = 0;
  private readonly observed = new TurnUsageFold();
  private readonly usage = new CodexUsageFold(true);
  private readonly modelUsage = new ModelUsageFold();
  push(line: JsonLine): void {
    this.observed.push(line); this.usage.push(line); this.modelUsage.push(line);
    if (this.error !== null || line.kind === "blank") return;
    if (line.kind === "too-large") { this.error = "codex-events-line-too-large"; return; }
    if (line.kind === "unparsed") { this.error = "codex-events-invalid"; return; }
    const row = line.row;
    if (!record(row) || typeof row.type !== "string") { this.error = "codex-events-invalid"; return; }
    if (row.type.startsWith("item.") && record(row.item) && row.item.type === "error") {
      const text = `ccloop-codex-single-call: codex error item ${JSON.stringify(typeof row.item.message === "string" ? row.item.message : null)}\n`;
      if (this.errorItems.length < MAX_LOGGED_ERROR_ITEMS) this.errorItems.push(text); else this.unloggedErrorItems += 1;
    } else if (row.type.startsWith("item.") && record(row.item) && row.item.type !== "agent_message" && row.item.type !== "reasoning") this.tool = true;
    if (row.type === "item.completed" && record(row.item) && row.item.type === "agent_message") this.messages += 1;
    if (row.type === "turn.completed") this.turns += 1;
  }
  /** observedTurnUsage over every line of the call. */
  observedTokens(): number | null { return this.observed.value(); }
  value(final: string | null, model: string, evidenceDir: string): SingleCallResult {
    for (const text of this.errorItems) process.stderr.write(text);
    if (this.unloggedErrorItems > 0) process.stderr.write(`ccloop-codex-single-call: ${this.unloggedErrorItems} more codex error items not logged\n`);
    const observedTokens = this.observed.value();
    if (this.error !== null) throw observed(new Error(this.error), observedTokens);
    if (this.tool) throw notSingle("tool", observedTokens);
    if (this.messages > 1) throw notSingle("messages", observedTokens);
    if (this.turns > 1) throw notSingle("turns", observedTokens);
    let usage: ReturnType<typeof decodeCodexUsage>;
    try { usage = this.usage.value(); } catch (error) { throw observed(error as Error, observedTokens); }
    const modelUsage = this.modelUsage.value(model);
    const output = final === null ? undefined : parseSingleCallObject(final);
    if (output === undefined) throw new SingleCallOutputInvalid(evidenceDir, usage.tokenUsage, usage.usageEvidence);
    return { output, tokenUsage: usage.tokenUsage, usageEvidence: usage.usageEvidence, ...(modelUsage === null ? {} : { modelUsage }) };
  }
}
