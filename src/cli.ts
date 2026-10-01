#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runAgentsCommand } from "./agents/command.js";
import { resolveAgent } from "./agents/materialize.js";
import { getDescriptor } from "./agents/registry.js";
import { readAgentsTable } from "./agents/table.js";
import { AgentError, agentSelectionSchema } from "./agents/types.js";
import type { AgentsTableV1 } from "./agents/types.js";
import { runControlCommand } from "./control/command.js";
import { loadContract } from "./contract/loadContract.js";
import { resumeLoop } from "./controller/resumeLoop.js";
import { ensureFreshRunDir } from "./persistence/fileStore.js";
import { createStopRequestSignal, runLoop } from "./controller/runLoop.js";
import type { StopRequestSignal } from "./controller/runLoop.js";
import { renderScanTable, scanRootFailureDetail, toScanResult } from "./registry/renderRuns.js";
import { defaultScanDeps, scanRuns } from "./registry/scanRuns.js";
import type { RuntimeAdapter } from "./runtime/types.js";
import { sweepRuns } from "./sweep/sweepRuns.js";
import { attachLockInspections, defaultLockRowDeps } from "./unlock/lockRows.js";
import { unlockOwnerTransferLock } from "./unlock/unlockCommand.js";

export type ParsedArgs =
  // Orca agent selection (2026-09-26), spec §4.9: the agents-table form of `run`, used by Orca's reconcile run.
  | {
      command: "run";
      contractPath: string;
      runDir: string;
      agentsTablePath: string;
      agentSelectionPath: string;
    }
  // Consolidation step 2 (spec 2026-10-01-agents-resume-sweep-design.md §3.2/§3.3): the agents-table forms of resume and
  // sweep, which continue runs started by `run --agents` with the selection each run froze into its run directory.
  | {
      command: "resume";
      runDir: string;
      agentsTablePath: string;
    }
  | {
      command: "sweep";
      root: string;
      agentsTablePath: string;
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

// §12's governance position: --max-runs is the bound a human approves the sweep against, so
// anything that is not literally a positive integer refuses the sweep rather than defaulting
// it. The digits-only test is deliberate — Number("1e3") is 1000 and parseInt("2abc") is 2,
// and neither is a bound anyone typed.
// (Consolidation step 2: moved here unchanged from the sweep branch of parseArgs, so both sweep forms share it.)
// *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-1) -- only one sweep
// form is left, `sweep --agents`; the `--adapter` form was removed. ***
function parseMaxRuns(maxRunsRaw: string): number {
  if (!/^\d+$/.test(maxRunsRaw) || Number(maxRunsRaw) < 1) {
    throw new Error("--max-runs must be a positive integer");
  }
  return Number(maxRunsRaw);
}

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

  // Consolidation step 4 (spec 2026-10-01-retire-old-cli-entry-design.md §3.1, controller ruling C-1): the old
  // entry `--adapter scripted|codex --adapter-config <file>` is gone from run, resume and sweep. Checked before any
  // other flag, on the raw arguments, so the refusal reads the same whatever else is on the line.
  if (argv.slice(1).some((arg) => arg === "--adapter" || arg === "--adapter-config")) {
    throw new Error("--adapter was removed; use --agents <table>");
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    values.set(argv[index]!, argv[index + 1]!);
  }

  // Orca agent selection (2026-09-26), spec §4.9: `--agents <table> --agent-selection <file>` replaces
  // --adapter/--adapter-config instead of combining with them, and only `run` takes it — a run started this
  // way cannot be resumed or swept (spec §11). Placed before `sweep`'s own early return (below) rather than
  // after it (plan-review P23 m6): `sweep` must refuse `--agents` too, and its branch returns before the
  // run/resume flag parsing this task was originally anchored to.
  // *** ERRATUM (consolidation step 2, 2026-10-01, Orca session be653b22, controller ruling C-2/C-3) -- "only `run`
  // takes it -- a run started this way cannot be resumed or swept (spec §11)" no longer holds: `run --agents` now
  // freezes its selection into `<runDir>/agent-selection.json`, and `resume`/`sweep` take `--agents <table>` (without
  // `--agent-selection`, which stays `run`'s alone) to continue such runs with it. The exclusivity with
  // --adapter/--adapter-config is unchanged and still checked first. ***
  // *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-1) -- --adapter and
  // --adapter-config no longer exist, so there is nothing for `--agents` to replace or be exclusive with, and no
  // `sweep` early return or run/resume flag parsing below: either old flag is refused by the check above, and
  // `--agents` is required by all three commands (with `--agent-selection` for `run`). ***
  const agentsTablePath = values.get("--agents");
  const agentSelectionPath = values.get("--agent-selection");
  if (command !== "run") {
    // The selection is the run's own (frozen by `run --agents`), not the caller's.
    if (agentSelectionPath !== undefined) {
      throw new Error("--agent-selection is only supported by run");
    }
    if (command === "resume") {
      const resumeRunDir = values.get("--run-dir");
      if (!resumeRunDir || !agentsTablePath) {
        throw new Error("missing required flags");
      }
      return { command, runDir: resumeRunDir, agentsTablePath };
    }
    const sweepRoot = values.get("--root");
    const sweepMaxRunsRaw = values.get("--max-runs");
    if (!sweepRoot || !agentsTablePath || !sweepMaxRunsRaw) {
      throw new Error("missing required flags");
    }
    return { command, root: sweepRoot, agentsTablePath, maxRuns: parseMaxRuns(sweepMaxRunsRaw) };
  }
  const agentsRunDir = values.get("--run-dir");
  const agentsContractPath = values.get("--contract");
  if (!agentsRunDir || !agentsContractPath || !agentsTablePath || !agentSelectionPath) {
    throw new Error("missing required flags");
  }
  return { command, contractPath: agentsContractPath, runDir: agentsRunDir, agentsTablePath, agentSelectionPath };
}

// Selection-file shape (P18: the selection itself is validated with agents/types.js's own
// `agentSelectionSchema` — the single source of that schema — not a second, hand-rolled copy of it).
const selectionFileSchema = z
  .object({ selection: agentSelectionSchema, configHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

// Orca agent selection (2026-09-26), spec §4.9 and §12 C5: the selection Orca froze for this run is
// materialized here against the table as it is NOW. resolveAgent probes `<command> --version` and refuses a
// drifted installation (agent-version-drift); a table entry edited since Orca froze the selection changes the
// hash (control-config-hash-mismatch). Either refusal happens before the contract is read or anything runs.
async function runWithAgents(parsed: Extract<ParsedArgs, { command: "run"; agentsTablePath: string }>): Promise<number> {
  const table = await readAgentsTable(parsed.agentsTablePath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(parsed.agentSelectionPath, "utf8"));
  } catch (error) {
    throw new AgentError("agent-selection-file-invalid", error instanceof Error ? error.message : String(error));
  }
  const { file, adapter } = await adapterForSelectionFile(table, raw);
  // Consolidation step 2 (controller ruling, Orca session be653b22): the contract is read BEFORE the freeze, so an
  // unreadable or invalid contract leaves no agent-selection.json behind for a retry into the same directory to trip on.
  const contract = await loadContract(parsed.contractPath);
  // Consolidation step 2, spec §3.1 (C-1): freeze the validated selection into the run directory so `resume --agents`
  // can rebuild this agent. runLoop's own freshness refusal runs first, so a non-fresh directory is never written
  // into; `wx` refuses a leftover file instead of overwriting it, which would rebind someone else's run.
  await ensureFreshRunDir(parsed.runDir);
  await mkdir(parsed.runDir, { recursive: true });
  const frozenPath = join(parsed.runDir, FROZEN_SELECTION_FILE);
  try {
    await writeFile(frozenPath, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AgentError("agent-selection-exists", frozenPath);
    throw error;
  }
  const finalState = await runLoop(contract, parsed.runDir, adapter);
  return finalState.status === "succeeded" ? 0 : 2;
}

// Consolidation step 2: the selection `run --agents` froze for a run, beside the run's own files.
export const FROZEN_SELECTION_FILE = "agent-selection.json";

// The one place a selection file is validated, resolved against the table as it is now, and compared with its hash
// (shared by `run --agents` and `resume --agents`). Prints the codex soft-budget notice once the adapter exists.
async function adapterForSelectionFile(
  table: AgentsTableV1,
  raw: unknown,
): Promise<{ file: z.infer<typeof selectionFileSchema>; adapter: RuntimeAdapter }> {
  const file = selectionFileSchema.safeParse(raw);
  if (!file.success) throw new AgentError("agent-selection-file-invalid", file.error.message);
  const { config, resolution } = await resolveAgent(table, file.data.selection);
  if (resolution.configHash !== file.data.configHash) {
    throw new AgentError("control-config-hash-mismatch", `selection file ${file.data.configHash}, materialized ${resolution.configHash}`);
  }
  const adapter = getDescriptor(config.kind).createAdapter(config);
  // The same notice `run --adapter codex` prints below.
  // *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-1) -- `run --adapter
  // codex` and its notice line were removed; this is now the only place the notice is printed. ***
  if (config.kind === "codex") console.error("Codex budgetMode=soft: token usage is accounted after each phase; no strict token cap is guaranteed.");
  return { file: file.data, adapter };
}

// Consolidation step 2, spec §3.2 (C-2): the adapter for a run started by `run --agents`, rebuilt from the selection
// that run froze. Reads only; every refusal (no file, unreadable or invalid file, drift, hash mismatch) happens before
// the caller touches the run directory.
async function adapterForFrozenSelection(table: AgentsTableV1, runDir: string): Promise<RuntimeAdapter> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDir, FROZEN_SELECTION_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AgentError("agent-selection-missing", runDir);
    throw new AgentError("agent-selection-file-invalid", error instanceof Error ? error.message : String(error));
  }
  return (await adapterForSelectionFile(table, raw)).adapter;
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
    if (argv[0] === "control") {
      let stdin = "";
      for await (const chunk of process.stdin) stdin += String(chunk);
      const result = await runControlCommand(argv.slice(1), stdin);
      if (result.stdout !== "") process.stdout.write(result.stdout);
      if (result.stderr !== "") process.stderr.write(result.stderr);
      return result.code;
    }

    // Agent selection (2026-09-26) §4.3/§4.4: `agents` prints to stdout only and writes nothing anywhere.
    if (argv[0] === "agents") {
      const result = await runAgentsCommand(argv.slice(1));
      if (result.stdout !== "") process.stdout.write(result.stdout);
      if (result.stderr !== "") process.stderr.write(result.stderr);
      return result.code;
    }

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
      // Lock probing happens AFTER the root-failure check, deliberately: when the root itself
      // failed there are no runs to probe, and probing earlier would spend I/O on a path already
      // headed for exit 1 (human ruling 131, design spec §3.6 / task-10-brief.md M10-2).
      const result = toScanResult(await attachLockInspections(rows, defaultLockRowDeps));
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

    // The agents-table form of `run` (spec §4.9) builds its adapter from the table, not from --adapter.
    // *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling FW-3) -- --adapter no longer exists; the agents
    // table is the only form of `run`, so there is no other adapter source to contrast it with. ***
    if (parsed.command === "run") return await runWithAgents(parsed);

    // Consolidation step 2, spec §3.2: `resume --agents` rebuilds the adapter from the selection the run froze.
    if (parsed.command === "resume") {
      const table = await readAgentsTable(parsed.agentsTablePath);
      const adapter = await adapterForFrozenSelection(table, parsed.runDir);
      const finalState = await resumeLoop(parsed.runDir, adapter);
      return finalState.status === "succeeded" ? 0 : 2;
    }

    // Consolidation step 2, spec §3.3: `sweep --agents` builds each candidate's adapter from the selection that run
    // froze. The table is read before the scan, so an unreadable table exits 1 having swept nothing (as an unreadable
    // adapter config does); a candidate whose adapter cannot be built is reported `refused` by sweepRuns.
    // *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-1) -- there is no
    // adapter config any more: `--adapter-config` was removed with `--adapter`, and this is the only form of sweep. ***
    const table = await readAgentsTable(parsed.agentsTablePath);
    const stopRequested = createStopRequestSignal();
    const unregisterStopHandlers = registerStopHandlers(stopRequested);
    try {
      return await sweepRuns({
        root: parsed.root,
        adapterName: "agents",
        adapterForRun: (runDir) => adapterForFrozenSelection(table, runDir),
        maxRuns: parsed.maxRuns,
        stopRequested,
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      });
    } finally {
      unregisterStopHandlers();
    }
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
