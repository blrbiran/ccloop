#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadContract } from "./contract/loadContract.js";
import { resumeLoop } from "./controller/resumeLoop.js";
import { createStopRequestSignal, runLoop } from "./controller/runLoop.js";
import type { StopRequestSignal } from "./controller/runLoop.js";
import { renderScanTable, scanRootFailureDetail, toScanResult } from "./registry/renderRuns.js";
import { defaultScanDeps, scanRuns } from "./registry/scanRuns.js";
import { SubprocessClaudeAdapter } from "./runtime/claude/subprocessClaudeAdapter.js";
import { ScriptedAdapter } from "./runtime/scriptedAdapter.js";
import type { RuntimeAdapter } from "./runtime/types.js";
import { sweepRuns } from "./sweep/sweepRuns.js";
import { unlockOwnerTransferLock } from "./unlock/unlockCommand.js";

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
      command: "sweep";
      root: string;
      adapter: "scripted" | "claude";
      adapterConfigPath: string;
      maxRuns: number;
    }
  | {
      command: "ls";
      root: string;
      json: boolean;
    }
  // The credential rides in the type, not alongside it: `force: true` without a digest cannot be
  // represented, so unlockOwnerTransferLock needs no runtime check for the combination human
  // ruling 73 forbids. The refusal happens once, in parseArgs, where the operator typed it.
  | ({ command: "unlock"; runDir: string } & ({ force: false } | { force: true; expectedDigest: string }));

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

  // `unlock` (human ruling 70, board C-d) also takes a positional run directory and needs neither
  // adapter nor contract, so it is handled here beside `ls` rather than through the flag/value
  // pairing below. It cannot reuse `ls`'s "first token that is not --prefixed" rule, though: this
  // command has a flag that TAKES A VALUE, and `unlock --force --expect <digest> <runDir>` would
  // make that rule read the digest as the run directory — and then delete a lock in whatever
  // directory that string happened to name. Hence the explicit walk.
  if (command === "unlock") {
    const rest = argv.slice(1);
    let runDir: string | undefined;
    let force = false;
    let expectedDigest: string | undefined;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;

      if (token === "--force") {
        force = true;
        continue;
      }

      if (token === "--expect") {
        const value = rest[index + 1];
        // A missing value, or the next flag standing where the digest should be, is a typo — and
        // taking "--force" as the digest would produce a credential that never matches, refusing
        // for the wrong stated reason.
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--expect requires a sha256 digest of the lock file");
        }
        expectedDigest = value;
        index += 1;
        continue;
      }

      if (token.startsWith("--")) {
        throw new Error(`unknown flag ${token}`);
      }

      if (runDir !== undefined) {
        throw new Error("expected exactly one run directory");
      }
      runDir = token;
    }

    if (!runDir) {
      throw new Error("missing required run directory argument");
    }

    if (force && expectedDigest === undefined) {
      throw new Error("--force requires --expect <sha256 of the lock file>");
    }

    if (!force && expectedDigest !== undefined) {
      // Refused rather than ignored: silently dropping a credential the operator typed would let
      // a mistyped `--force` read as a successful forced removal that never happened.
      throw new Error("--expect is only meaningful together with --force");
    }

    return expectedDigest === undefined
      ? { command, runDir, force: false }
      : { command, runDir, force: true, expectedDigest };
  }

  if (command !== "run" && command !== "resume" && command !== "sweep") {
    throw new Error("expected `run`, `resume`, `sweep`, `ls`, or `unlock` command");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    values.set(argv[index]!, argv[index + 1]!);
  }

  // `sweep` takes its root as `--root`, not as a positional (L3 §6): the pairing loop above is
  // pure flag/value, so `sweep <root> --adapter x` would pair `<root>` with `--adapter` and then
  // report missing flags on a command line that reads as legal. Handled before the `--run-dir`
  // check below because a sweep has no single run directory to require.
  if (command === "sweep") {
    const root = values.get("--root");
    const sweepAdapter = values.get("--adapter");
    const sweepAdapterConfigPath = values.get("--adapter-config");
    const maxRunsRaw = values.get("--max-runs");

    if (!root || !sweepAdapter || !sweepAdapterConfigPath || !maxRunsRaw) {
      throw new Error("missing required flags");
    }

    if (sweepAdapter !== "scripted" && sweepAdapter !== "claude") {
      throw new Error("invalid adapter");
    }

    // §12's governance position: --max-runs is the bound a human approves the sweep against, so
    // anything that is not literally a positive integer refuses the sweep rather than defaulting
    // it. The digits-only test is deliberate — Number("1e3") is 1000 and parseInt("2abc") is 2,
    // and neither is a bound anyone typed.
    if (!/^\d+$/.test(maxRunsRaw) || Number(maxRunsRaw) < 1) {
      throw new Error("--max-runs must be a positive integer");
    }

    return {
      command,
      root,
      adapter: sweepAdapter,
      adapterConfigPath: sweepAdapterConfigPath,
      maxRuns: Number(maxRunsRaw),
    };
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

// Construction only, no I/O. Split out of loadAdapter because `sweep` has to read and parse its
// adapter config BEFORE the scan (§8's first line: a config that cannot be read exits 1 without
// scanning) yet must not construct the adapter until sweepRuns adopts a run — the two halves that
// run/resume perform together happen at different times there.
function buildAdapter(adapter: "scripted" | "claude", config: unknown): RuntimeAdapter {
  if (adapter === "scripted") {
    return new ScriptedAdapter((config as ScriptedAdapterConfig).frames);
  }

  return new SubprocessClaudeAdapter(config as ConstructorParameters<typeof SubprocessClaudeAdapter>[0]);
}

// `sweep` is deliberately NOT in this parameter's type. It carries an `adapter` and an
// `adapterConfigPath` and so is structurally accepted by `Exclude<ParsedArgs, { command: "ls" }>`,
// which would let a future edit place the sweep branch after this call — legal to the compiler,
// and a violation of both the config-read ordering above and C3's banner ordering.
async function loadAdapter(parsed: Extract<ParsedArgs, { command: "run" | "resume" }>): Promise<RuntimeAdapter> {
  return buildAdapter(parsed.adapter, JSON.parse(await readFile(parsed.adapterConfigPath, "utf8")) as unknown);
}

// L3 §5.4's escape hatch. ONE counter across both signals: the first fills the stop slot the loop
// reads at its next boundary, the second exits immediately. Counting per signal kind would mean
// "Ctrl-C, then kill" — the escalation an operator reaches for when the first press seems to have
// done nothing — never reaches the hatch at all.
//
// The handler is handed the stop SLOT and nothing else. It cannot stop the heartbeat, and does
// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
export function registerStopHandlers(
  signal: StopRequestSignal,
  options?: { exit?: (code: number) => void },
): () => void {
  const exit = options?.exit ?? ((code: number) => process.exit(code));
  let received = 0;

  const handle = () => {
    received += 1;
    signal.requested = true;
    if (received >= 2) {
      exit(130);
    }
  };

  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);

  return () => {
    process.off("SIGINT", handle);
    process.off("SIGTERM", handle);
  };
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

    // `unlock` returns here for the same reason `ls` does: it runs no loop, so the succeeded/failed
    // -> 0/2 mapping below has nothing to say about it. Its codes are its own — 0 when the lock is
    // gone or was never there, 1 for every refusal (human ruling 72's fail-closed).
    if (parsed.command === "unlock") {
      return await unlockOwnerTransferLock(
        parsed.force
          ? {
              runDir: parsed.runDir,
              force: true,
              expectedDigest: parsed.expectedDigest,
              stdout: (line) => console.log(line),
              stderr: (line) => console.error(line),
            }
          : {
              runDir: parsed.runDir,
              force: false,
              stdout: (line) => console.log(line),
              stderr: (line) => console.error(line),
            },
      );
    }

    // `sweep` returns HERE — before loadAdapter, not merely before the two `? 0 : 2` mappings
    // below. Its exit codes are sweepRuns' own (1 iff the scan failed at its root, else 0), and
    // exit 2 is not among them. Placing it after loadAdapter would still satisfy "before the
    // mappings" while constructing the adapter before the sweep has scanned or printed its
    // banner, breaking §8's ordering and C1's createAdapter contract.
    if (parsed.command === "sweep") {
      // §8's first line: read and parse the config before scanning, so an unreadable config
      // exits 1 having swept nothing. What crosses into sweepRuns is a closure that does no I/O.
      const config = JSON.parse(await readFile(parsed.adapterConfigPath, "utf8")) as unknown;
      const adapterName = parsed.adapter;
      const stopRequested = createStopRequestSignal();
      const unregisterStopHandlers = registerStopHandlers(stopRequested);

      try {
        return await sweepRuns({
          root: parsed.root,
          adapterName,
          createAdapter: () => buildAdapter(adapterName, config),
          maxRuns: parsed.maxRuns,
          stopRequested,
          stdout: (line) => console.log(line),
          stderr: (line) => console.error(line),
        });
      } finally {
        unregisterStopHandlers();
      }
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
