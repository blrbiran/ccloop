import { spawn } from "node:child_process";
import { z } from "zod";
import { canonicalHash } from "../control/protocol.js";
import { descriptorDefaults, getDescriptor } from "./registry.js";
import { readOmpCatalog, readOmpModels } from "./ompModels.js";
import { parseInstallation } from "./table.js";
import {
  AgentError,
  agentSelectionSchema,
  type AgentResolutionV1,
  type AgentsTableV1,
  type CatalogRowV1,
  type MaterializedAgentConfigV1,
  type PartialSelectionV1,
} from "./types.js";

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[\w.]+)?/;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Runs `<command> --version` once (spec §4.2 / §12 C6) and answers the first `x.y.z[-tag]` in its stdout, or
 * null when it cannot be run, exits non-zero, prints no version, prints too much, or outlives the timeout.
 * Every-agent requirement chain (Orca spec 2026-10-15 §4.3): also null when the caller's `signal` aborts it.
 */
export function probeVersion(command: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    let output = "";
    // A private process group lets timeout/overflow reap descendants that a CLI leaves behind.
    const child = spawn(command[0]!, [...command.slice(1), "--version"], { stdio: ["ignore", "pipe", "ignore"], env: process.env, detached: true });
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortTree);
      resolve(value);
    };
    const abortTree = (): void => {
      if (aborted) return;
      aborted = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => {
      abortTree();
    }, options.timeoutMs ?? VERSION_TIMEOUT_MS);
    options.signal?.addEventListener("abort", abortTree, { once: true });
    if (options.signal?.aborted) abortTree();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > VERSION_OUTPUT_LIMIT) {
        abortTree();
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(!aborted && code === 0 ? (VERSION_PATTERN.exec(output)?.[0] ?? null) : null));
  });
}

/**
 * The canonical hash of the materialized config without the installation's `version` (Orca final review I-2, human
 * ruling 2026-09-26: keep agent CLIs free to upgrade). The version stays in the sealed config.json and is still
 * checked against `--version` at every resolution (agent-version-drift), so an in-place upgrade still stops new
 * work until the table records the new version -- but once it does, a group frozen under the old version resolves
 * to the same hash and can go on instead of being refused forever as control-config-hash-mismatch.
 *
 * *** ERRATUM (Orca ruling review R1, HUMAN RULING 2026-09-27: "command 等安装字段 => 同意移除hash") ***
 * "without the installation's `version`" is no longer the whole list: `command`, `timeoutMs` and `killGraceMs` are
 * left out as well. `command` is where the CLI is installed, not which agent runs (a path under
 * ~/.nvm/versions/node/<v>/ moves with the node version); the two limits bound a run without changing the agent.
 * Hashing them would strand a started group the same way hashing the version did. Still hashed: kind, `configDir`
 * (account and settings), the kind's own fields, and the selection. The sealed config.json still records every field.
 */
export function agentConfigHash(config: MaterializedAgentConfigV1): string {
  const {
    version: _checkedByDriftNotHash,
    command: _whereInstalledNotWhich,
    timeoutMs: _runLimitNotIdentity,
    killGraceMs: _stopLimitNotIdentity,
    ...installation
  } = config.installation;
  return canonicalHash({ ...config, installation });
}

/**
 * Fills the partial selection from the installation's descriptor defaults, validates it, materializes the
 * config and checks the installed version (spec §4.6). Fields the partial carries are echoed verbatim (M5).
 */
export async function resolveAgent(
  table: AgentsTableV1,
  partial: PartialSelectionV1,
  deps: {
    probeVersion?: (command: string[]) => Promise<string | null>;
    probeModels?: typeof readOmpModels;
    probeCatalog?: typeof readOmpCatalog;
  } = {},
): Promise<{ config: MaterializedAgentConfigV1; resolution: AgentResolutionV1 }> {
  if (partial.agent === undefined) throw new AgentError("agent-unselected");
  const installation = Object.hasOwn(table.installations, partial.agent) ? table.installations[partial.agent] : undefined;
  if (installation === undefined) throw new AgentError("agent-installation-missing", partial.agent);
  const descriptor = getDescriptor(installation.kind);
  const defaults = descriptorDefaults(descriptor, installation);
  const selection = {
    agent: partial.agent,
    model: partial.model ?? defaults.model,
    contextWindow: partial.contextWindow ?? defaults.contextWindow,
  };
  descriptor.validateSelection(selection);
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: installation.kind, installation, selection };
  const observed = await (deps.probeVersion ?? probeVersion)(installation.command);
  // Orca wave-2 review I-3 (2026-09-26): a probe that observed no version at all (spawn failure, non-zero exit, no
  // x.y.z, oversized output, timeout) may be transient, so it is NOT the named refusal agent-version-drift. It is a
  // plain Error: `control` exits 1 (Orca treats it as unknown and retries) and `run --agents` exits 1 with a message
  // that is not a code (Orca: reconcile-spawn). Only an observed version that differs from the table is a drift.
  if (observed === null) {
    throw new Error(`Could not observe the version of installation ${JSON.stringify(partial.agent)}: \`--version\` answered no x.y.z (table ${installation.version})`);
  }
  if (observed !== installation.version) {
    throw new AgentError("agent-version-drift", `${partial.agent}: table ${installation.version}, observed ${observed}`);
  }
  // OMP single call (Orca spec 2026-10-14 §3.2): the selected catalog row decides the window, the single-call answer and
  // its cap. `probeModels` is the selector-only injection older criteria use; its rows declare no numbers.
  let row: CatalogRowV1 | undefined;
  if (installation.kind === "omp") {
    const rows: CatalogRowV1[] = deps.probeCatalog !== undefined ? await deps.probeCatalog(installation)
      : deps.probeModels !== undefined
        ? (await deps.probeModels(installation)).map((selector) => ({ selector, provider: selector.slice(0, selector.indexOf("/")), contextWindow: null, maxTokens: null }))
        : await readOmpCatalog(installation);
    row = rows.find((candidate) => candidate.selector === selection.model);
    if (row === undefined) throw new AgentError("agent-selection-invalid", `OMP model is not an exact catalog selector: ${selection.model}`);
  }
  return {
    config,
    resolution: {
      selection,
      configHash: agentConfigHash(config),
      timeoutMs: installation.timeoutMs,
      killGraceMs: installation.killGraceMs,
      capabilities: descriptor.capabilities(config, row),
      singleCallExecution: descriptor.singleCallExecution(config, row),
      singleCallOutputCap: descriptor.singleCallOutputCap(config, row),
    },
  };
}

const materializedShape = z
  .object({ schema: z.literal("ccloop-agent-config-v1"), kind: z.string(), installation: z.unknown(), selection: agentSelectionSchema })
  .strict();

/** Reads back a config.json written at accept; the same checks as resolution, minus the version probe. */
export function parseMaterializedAgentConfig(raw: unknown): MaterializedAgentConfigV1 {
  const parsed = materializedShape.safeParse(raw);
  if (!parsed.success) throw new AgentError("agent-config-invalid", parsed.error.message);
  const installation = parseInstallation(parsed.data.installation);
  if (installation.kind !== parsed.data.kind) throw new AgentError("agent-config-invalid", "kind differs from the installation's kind");
  getDescriptor(installation.kind).validateSelection(parsed.data.selection);
  return { schema: "ccloop-agent-config-v1", kind: installation.kind, installation, selection: parsed.data.selection };
}
