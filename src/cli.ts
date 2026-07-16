#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadContract } from "./contract/loadContract.js";
import { runLoop } from "./controller/runLoop.js";
import { SubprocessClaudeAdapter } from "./runtime/claude/subprocessClaudeAdapter.js";
import { ScriptedAdapter } from "./runtime/scriptedAdapter.js";
import type { RuntimeAdapter } from "./runtime/types.js";

export type ParsedArgs = {
  command: "run";
  contractPath: string;
  runDir: string;
  adapter: "scripted" | "claude";
  adapterConfigPath: string;
};

type ScriptedAdapterConfig = {
  frames: ConstructorParameters<typeof ScriptedAdapter>[0];
};

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== "run") {
    throw new Error("expected `run` command");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    values.set(argv[index]!, argv[index + 1]!);
  }

  const contractPath = values.get("--contract");
  const runDir = values.get("--run-dir");
  const adapter = values.get("--adapter");
  const adapterConfigPath = values.get("--adapter-config");

  if (!contractPath || !runDir || !adapter || !adapterConfigPath) {
    throw new Error("missing required flags");
  }

  if (adapter !== "scripted" && adapter !== "claude") {
    throw new Error("invalid adapter");
  }

  return {
    command: "run",
    contractPath,
    runDir,
    adapter,
    adapterConfigPath,
  };
}

async function loadAdapter(parsed: ParsedArgs): Promise<RuntimeAdapter> {
  const config = JSON.parse(await readFile(parsed.adapterConfigPath, "utf8")) as unknown;

  if (parsed.adapter === "scripted") {
    return new ScriptedAdapter((config as ScriptedAdapterConfig).frames);
  }

  return new SubprocessClaudeAdapter(config as ConstructorParameters<typeof SubprocessClaudeAdapter>[0]);
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const contract = await loadContract(parsed.contractPath);
    const adapter = await loadAdapter(parsed);
    const finalState = await runLoop(contract, parsed.runDir, adapter);
    return finalState.status === "succeeded" ? 0 : 2;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
