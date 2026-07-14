#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export type ParsedArgs = {
  command: "run";
  contractPath: string;
  runDir: string;
  adapter: "scripted" | "claude";
  adapterConfigPath: string;
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

export async function main(argv: string[]): Promise<number> {
  try {
    parseArgs(argv);
    return 0;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
