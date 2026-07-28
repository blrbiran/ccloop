#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadContract } from "./contract/loadContract.js";
import { resumeLoop } from "./controller/resumeLoop.js";
import { runLoop } from "./controller/runLoop.js";
import { renderScanTable, scanRootFailureDetail, toScanResult } from "./registry/renderRuns.js";
import { defaultScanDeps, scanRuns } from "./registry/scanRuns.js";
import { SubprocessClaudeAdapter } from "./runtime/claude/subprocessClaudeAdapter.js";
import { ScriptedAdapter } from "./runtime/scriptedAdapter.js";
import type { RuntimeAdapter } from "./runtime/types.js";

export type ParsedArgs =
  | {
      command: "run";
      contractPath: string;
      runDir: string;
      adapter: "scripted" | "claude";
      adapterConfigPath: string;
    }
  | {
      command: "resume";
      runDir: string;
      adapter: "scripted" | "claude";
      adapterConfigPath: string;
    }
  | {
      command: "ls";
      root: string;
      json: boolean;
    };

type ScriptedAdapterConfig = {
  frames: ConstructorParameters<typeof ScriptedAdapter>[0];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];

  // `ls` takes a positional root and, unlike `run`/`resume`, needs neither an adapter nor a
  // contract — it runs no loop (spec §9, §10). Handled before the `run`/`resume` flag parsing
  // below so it is never forced through their required-flags check.
  if (command === "ls") {
    const rest = argv.slice(1);
    // The positional root may follow a flag (e.g. `ls --json <root>`), so it is the first
    // token that isn't itself a `--`-prefixed flag, not simply `argv[1]`.
    const root = rest.find((arg) => !arg.startsWith("--"));
    if (!root) {
      throw new Error("missing required root argument");
    }
    const json = rest.includes("--json");
    return { command, root, json };
  }

  if (command !== "run" && command !== "resume") {
    throw new Error("expected `run`, `resume`, or `ls` command");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    values.set(argv[index]!, argv[index + 1]!);
  }

  const runDir = values.get("--run-dir");
  const adapter = values.get("--adapter");
  const adapterConfigPath = values.get("--adapter-config");

  if (!runDir || !adapter || !adapterConfigPath) {
    throw new Error("missing required flags");
  }

  if (adapter !== "scripted" && adapter !== "claude") {
    throw new Error("invalid adapter");
  }

  if (command === "resume") {
    return {
      command,
      runDir,
      adapter,
      adapterConfigPath,
    };
  }

  const contractPath = values.get("--contract");
  if (!contractPath) {
    throw new Error("missing required flags");
  }

  return {
    command,
    contractPath,
    runDir,
    adapter,
    adapterConfigPath,
  };
}

async function loadAdapter(parsed: Exclude<ParsedArgs, { command: "ls" }>): Promise<RuntimeAdapter> {
  const config = JSON.parse(await readFile(parsed.adapterConfigPath, "utf8")) as unknown;

  if (parsed.adapter === "scripted") {
    return new ScriptedAdapter((config as ScriptedAdapterConfig).frames);
  }

  return new SubprocessClaudeAdapter(config as ConstructorParameters<typeof SubprocessClaudeAdapter>[0]);
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);

    // `ls` runs no loop and has no run outcome to report, so it never goes through the
    // succeeded/failed -> 0/2 mapping below (spec §9): exit 1 iff the scan itself failed
    // (root missing or unreadable), else 0 — including when rows themselves are `unreadable`.
    if (parsed.command === "ls") {
      const rows = await scanRuns(parsed.root, defaultScanDeps);
      const failureDetail = scanRootFailureDetail(rows, parsed.root);
      if (failureDetail !== undefined) {
        console.error(failureDetail);
        return 1;
      }
      const result = toScanResult(rows);
      console.log(parsed.json ? JSON.stringify(result, null, 2) : renderScanTable(result));
      return 0;
    }

    const adapter = await loadAdapter(parsed);
    if (parsed.command === "resume") {
      const finalState = await resumeLoop(parsed.runDir, adapter);
      return finalState.status === "succeeded" ? 0 : 2;
    }
    const contract = await loadContract(parsed.contractPath);
    const finalState = await runLoop(contract, parsed.runDir, adapter);
    return finalState.status === "succeeded" ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
