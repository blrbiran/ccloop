import { homedir } from "node:os";
import { detectAgents } from "./detect.js";
import { probeVersion } from "./materialize.js";
import { listAgentModels } from "./models.js";
import { readAgentsTable } from "./table.js";
import { AgentError } from "./types.js";

export interface AgentsCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function detectFlags(argv: string[]): { home?: string; path?: string } {
  const flags: { home?: string; path?: string } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name !== "--home" && name !== "--path") || value === undefined) throw new AgentError("agents-command-invalid");
    flags[name === "--home" ? "home" : "path"] = value;
  }
  return flags;
}

/** `ccloop agents detect [--home <dir>] [--path <PATH>]` and `ccloop agents validate <table>` (spec §4.3, §4.4). */
// Every-agent requirement chain (Orca spec 2026-10-15 §3): also `ccloop agents models --agents <table> --installation <id> [--refresh]`.
export async function runAgentsCommand(
  argv: string[],
  deps: { probe?: typeof probeVersion } = {},
): Promise<AgentsCommandResult> {
  try {
    if (argv[0] === "detect") {
      const flags = detectFlags(argv.slice(1));
      const result = await detectAgents({
        home: flags.home ?? homedir(),
        path: flags.path ?? process.env.PATH ?? "",
        platform: process.platform,
        probe: deps.probe,
      });
      return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (argv[0] === "validate" && argv.length === 2) {
      const table = await readAgentsTable(argv[1]!);
      const probe = deps.probe ?? probeVersion;
      const installations: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const [id, installation] of Object.entries(table.installations)) {
        const observed = await probe(installation.command);
        installations.push(observed === installation.version ? { id, ok: true } : { id, ok: false, error: "agent-version-drift" });
      }
      return {
        code: installations.every((row) => row.ok) ? 0 : 1,
        stdout: `${JSON.stringify({ installations })}\n`,
        stderr: "",
      };
    }
    if (argv[0] === "models" && (argv.length === 5 || (argv.length === 6 && argv[5] === "--refresh")) && argv[1] === "--agents" && argv[3] === "--installation") {
      // The `ccloop-agent-catalog: miss|probe-failed ...` lines go to stderr here (plan issue 3); `control models` prints none.
      const answer = await listAgentModels(argv[2]!, argv[4]!, { refresh: argv.length === 6, log: (line) => process.stderr.write(`${line}\n`) });
      return { code: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: "" };
    }
    throw new AgentError("agents-command-invalid");
  } catch (error) {
    // An AgentError's message starts with its code, so the first stderr token is always the code.
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stdout: "", stderr: `${message}\n` };
  }
}
