import { spawn } from "node:child_process";
import { z } from "zod";
import { canonicalHash } from "../control/protocol.js";
import { getDescriptor } from "./registry.js";
import { parseInstallation } from "./table.js";
import {
  AgentError,
  agentSelectionSchema,
  type AgentResolutionV1,
  type AgentsTableV1,
  type MaterializedAgentConfigV1,
  type PartialSelectionV1,
} from "./types.js";

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[\w.]+)?/;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Runs `<command> --version` once (spec §4.2 / §12 C6) and answers the first `x.y.z[-tag]` in its stdout, or
 * null when it cannot be run, exits non-zero, prints no version, prints too much, or outlives the timeout.
 */
export function probeVersion(command: string[], options: { timeoutMs?: number } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn(command[0]!, [...command.slice(1), "--version"], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, options.timeoutMs ?? VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > VERSION_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(null);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? (VERSION_PATTERN.exec(output)?.[0] ?? null) : null));
  });
}

export function agentConfigHash(config: MaterializedAgentConfigV1): string {
  return canonicalHash(config);
}

/**
 * Fills the partial selection from the installation's descriptor defaults, validates it, materializes the
 * config and checks the installed version (spec §4.6). Fields the partial carries are echoed verbatim (M5).
 */
export async function resolveAgent(
  table: AgentsTableV1,
  partial: PartialSelectionV1,
  deps: { probeVersion?: (command: string[]) => Promise<string | null> } = {},
): Promise<{ config: MaterializedAgentConfigV1; resolution: AgentResolutionV1 }> {
  if (partial.agent === undefined) throw new AgentError("agent-unselected");
  const installation = Object.hasOwn(table.installations, partial.agent) ? table.installations[partial.agent] : undefined;
  if (installation === undefined) throw new AgentError("agent-installation-missing", partial.agent);
  const descriptor = getDescriptor(installation.kind);
  const selection = {
    agent: partial.agent,
    model: partial.model ?? descriptor.defaults.model,
    contextWindow: partial.contextWindow ?? descriptor.defaults.contextWindow,
  };
  descriptor.validateSelection(selection);
  const config: MaterializedAgentConfigV1 = { schema: "ccloop-agent-config-v1", kind: installation.kind, installation, selection };
  const observed = await (deps.probeVersion ?? probeVersion)(installation.command);
  if (observed !== installation.version) {
    throw new AgentError("agent-version-drift", `${partial.agent}: table ${installation.version}, observed ${observed ?? "none"}`);
  }
  return {
    config,
    resolution: {
      selection,
      configHash: agentConfigHash(config),
      timeoutMs: installation.timeoutMs,
      killGraceMs: installation.killGraceMs,
      capabilities: descriptor.capabilities(config),
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
