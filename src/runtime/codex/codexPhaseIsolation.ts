import { isAbsolute } from "node:path";
import { CODEX_PHASE_CONFIG, codexSingleCallHome, effectiveCodexHome } from "../../agents/codexIsolation.js";
import type { InstallationV1 } from "../../agents/types.js";
import { addressableMcpServer } from "./codexSingleCall.js";

// Codex phase isolation (ccloop spec 2026-10-18 §3.3-§3.5, Orca session a3b2a7a7 design; built in Orca session 3d229487).

export type CodexPhaseIsolationReason = `codex-phase-isolation-${string}`;

/**
 * Spec §3.5 (human's ruling): a phase whose isolation cannot be set up is refused before spawn -- final, not retried --
 * and books usage 0 (`neverStarted`, as the single call's refusals): no process started and no token was sent.
 */
export class CodexPhaseIsolationRefused extends Error {
  readonly neverStarted = true;
  /** The private pair when it was built before the refusal (paths only, for outcome.json); undefined otherwise. */
  constructor(readonly reason: CodexPhaseIsolationReason, readonly pair?: { home: string; codexHome: string }) {
    super(reason);
    this.name = "CodexPhaseIsolationRefused";
  }
}

/**
 * The phase's `-c` pairs: CODEX_PHASE_CONFIG, one `mcp_servers.<name>.enabled=false` per listed server, then spec §3.4's
 * real HOME for the commands codex runs (a TOML basic string; JSON string escaping is valid TOML basic-string escaping for
 * a path). Measured on codex-cli 0.163.0 (Orca session 3d229487, Task 1): accepted by `debug prompt-input` (rc 0) and
 * `codex sandbox` then prints the real HOME, without bringing personal skills back.
 */
export function codexPhaseConfigArgs(mcpServers: readonly string[], realHome: string): string[] {
  return [
    ...CODEX_PHASE_CONFIG.flatMap((value) => ["-c", value]),
    ...mcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-c", `shell_environment_policy.set.HOME=${JSON.stringify(realHome)}`,
  ];
}

/**
 * Builds the phase's isolation, or throws CodexPhaseIsolationRefused. Order: the private pair first (single call fix
 * round 3: a symlinked private dir is named as such, not as a missing MCP list), then the MCP list, its names, the real HOME.
 * The pair is the single call's per installation; without a cache dir it is made under
 * `<runDir>/codex/<attempt>/phase-isolation/home-*` (spec §4).
 */
export async function codexPhaseIsolation(input: { installation: InstallationV1; mcpServers: readonly string[] | null; runDir: string; attempt: number; env: NodeJS.ProcessEnv }): Promise<{ home: string; codexHome: string; args: string[] }> {
  let pair: { home: string; codexHome: string };
  try {
    pair = await codexSingleCallHome({ runDir: input.runDir, sourceCodexHome: effectiveCodexHome(input.installation, input.env), executable: input.installation.command[0],
      env: input.env, fallback: ["codex", String(input.attempt), "phase-isolation"] });
  } catch (error) {
    if ((error as { code?: unknown }).code === "codex-single-call-home-invalid") {
      throw new CodexPhaseIsolationRefused(`codex-phase-isolation-home-invalid:${(error as Error).message.slice("codex-single-call-home-invalid:".length)}`);
    }
    throw error;
  }
  if (input.mcpServers === null) throw new CodexPhaseIsolationRefused("codex-phase-isolation-no-mcp-list", pair);
  const unaddressable = input.mcpServers.find((name) => !addressableMcpServer(name));
  if (unaddressable !== undefined) throw new CodexPhaseIsolationRefused(`codex-phase-isolation-mcp-unaddressable:${JSON.stringify(unaddressable)}`, pair);
  const realHome = input.env.HOME;
  if (realHome === undefined || realHome === "" || !isAbsolute(realHome)) throw new CodexPhaseIsolationRefused("codex-phase-isolation-real-home-unknown", pair);
  return { ...pair, args: codexPhaseConfigArgs(input.mcpServers, realHome) };
}
