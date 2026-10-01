import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../../src/agents/materialize.js";
import type { AgentSelectionV1, AgentsTableV1 } from "../../src/agents/types.js";
import { main, parseArgs, registerStopHandlers } from "../../src/cli.js";
import { createStopRequestSignal } from "../../src/controller/runLoop.js";
import type { LoopContract } from "../../src/contract/schema.js";

// Consolidation step 4 (spec 2026-10-01-retire-old-cli-entry-design.md §3.2, controller ruling C-2): the CLI's runs go
// through an agents table of one codex installation -- ccloop's fake codex in `frames` mode, which plays frame
// `attempt - 1` of `frames` for every task -- instead of the removed `--adapter scripted --adapter-config <file>`.
// The table sits in a fresh directory of its own (owner-only, and its own realpath, as readAgentsTable requires).
// `selectionFile` is the selection file's content, `{selection, configHash}` plus a newline, exactly what
// `run --agents` freezes into a run directory.
const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
type Frame = { changedFiles?: string[]; approved?: boolean; safeToRetry?: boolean; stopSignals?: string[] };
async function framesAgents(frames: Frame[]): Promise<{ tablePath: string; selectionFile: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-cli-agents-")));
  const framesPath = join(dir, "frames.json");
  await writeFile(framesPath, JSON.stringify({ "*": frames }));
  const table: AgentsTableV1 = {
    schema: "ccloop-agents-table-v1",
    installations: {
      "codex-fake": { kind: "codex", command: [process.execPath, fakeCodex, "frames", join(dir, "marker"), framesPath], version: "9.9.9-fake", configDir: null, timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" },
    },
  };
  const tablePath = join(dir, "agents.json");
  await writeFile(tablePath, JSON.stringify(table), { mode: 0o600 });
  const selection: AgentSelectionV1 = { agent: "codex-fake", model: "gpt-6-sol", contextWindow: "agent-default" };
  const { resolution } = await resolveAgent(table, selection);
  return { tablePath, selectionFile: `${JSON.stringify({ selection, configHash: resolution.configHash })}\n` };
}

// Consolidation step 4 (spec 2026-10-01-retire-old-cli-entry-design.md §3.1, controller ruling C-1; replaces the
// criteria whose subject was the deleted parsing -- `--adapter` value validation and `--adapter-config` required).
// Either old flag, on any of the three commands, is refused with one message, exit 1. Rows that omit every other
// required flag (`run --adapter scripted`, `resume --adapter codex`) pin the check BEFORE the other flags: checked
// after them, those rows would report missing flags instead.
describe("the removed --adapter entry", () => {
  it.each([
    [["run", "--contract", "c", "--run-dir", "r", "--adapter", "codex", "--adapter-config", "a"]],
    [["run", "--adapter", "scripted"]],
    [["resume", "--run-dir", "r", "--adapter-config", "a"]],
    [["sweep", "--root", "r", "--adapter", "codex", "--adapter-config", "a", "--max-runs", "1"]],
    [["resume", "--adapter", "codex"]],
  ])("refuses %j with the removal message, exit 1", async (argv) => {
    expect(() => parseArgs(argv)).toThrow(/^--adapter was removed; use --agents <table>$/);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(main(argv)).resolves.toBe(1);
      expect(errorSpy.mock.calls).toEqual([["--adapter was removed; use --agents <table>"]]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("parseArgs", () => {
  it("returns exit code 1 when required flags are missing", async () => {
    await expect(main(["run"])).resolves.toBe(1);
  });

  // Migrated (consolidation step 4, controller ruling C-2): the example contract run, started through
  // `run --agents --agent-selection` with the one frame the removed examples/v1/scripted-adapter-config.json held
  // (src/index.ts changed, approved).
  it("returns 0 for the example contract run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cli-scripted-"));
    const { tablePath, selectionFile } = await framesAgents([{ changedFiles: ["src/index.ts"], approved: true }]);
    const selectionPath = join(tablePath, "..", "selection.json");
    await writeFile(selectionPath, selectionFile, { mode: 0o600 });

    await expect(
      main([
        "run",
        "--contract",
        "examples/v1/minimal-contract.json",
        "--run-dir",
        runDir,
        "--agents",
        tablePath,
        "--agent-selection",
        selectionPath,
      ]),
    ).resolves.toBe(0);
  });
});

describe("parseArgs resume", () => {
  // Migrated (consolidation step 4, controller ruling C-2): the run directory holds only a valid frozen selection, so
  // `resume --agents` builds its adapter and the refusal is resumeLoop's own (no run artifacts to read).
  it("prints the refusal reason to stderr when resume is refused (spec §9)", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cli-resume-empty-"));
    const { tablePath, selectionFile } = await framesAgents([]);
    await writeFile(join(runDir, "agent-selection.json"), selectionFile, { mode: 0o600 });

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await main(["resume", "--run-dir", runDir, "--agents", tablePath]);
      expect(code).toBe(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("cannot read run artifacts"));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("parseArgs ls", () => {
  it("parses a positional root with no --json flag", () => {
    expect(parseArgs(["ls", "/tmp/some-root"])).toEqual({
      command: "ls",
      root: "/tmp/some-root",
      json: false,
    });
  });

  it("parses --json", () => {
    expect(parseArgs(["ls", "/tmp/some-root", "--json"])).toEqual({
      command: "ls",
      root: "/tmp/some-root",
      json: true,
    });
  });

  // Finding: `ls --json <root>` (flag before the positional root) is a normal invocation and
  // must not be misparsed as root === "--json".
  it("parses --json before the positional root", () => {
    expect(parseArgs(["ls", "--json", "/tmp/some-root"])).toEqual({
      command: "ls",
      root: "/tmp/some-root",
      json: true,
    });
  });

  // Trap named in the task brief: `ls` must not require --adapter, --adapter-config, or
  // --contract the way `run`/`resume` do.
  it("does not require --adapter, --adapter-config, or --contract", () => {
    expect(() => parseArgs(["ls", "/tmp/some-root"])).not.toThrow();
  });

  it("throws when the root argument is missing", () => {
    expect(() => parseArgs(["ls"])).toThrow();
  });
});

describe("main ls (spec §9, §12.8)", () => {
  it("exits 1 when the root does not exist — the scan itself failed", async () => {
    const missingRoot = join(await mkdtemp(join(tmpdir(), "ccloop-ls-missing-")), "does-not-exist");
    await expect(main(["ls", missingRoot])).resolves.toBe(1);
  });

  it("exits 0 for a scan that produces an unreadable row, never 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-damaged-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    // Malformed JSON: parse failure survives the bounded re-read and is reported as an
    // `unreadable(parse)` field, not a command failure (spec §8.1, §9).
    await writeFile(join(runDir, "loop-state.json"), "{not valid json");

    const code = await main(["ls", root]);
    expect(code).toBe(0);
    expect(code).not.toBe(2);
  });

  it("emits a parseable ScanResult with schemaVersion 1 under --json", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-json-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["ls", root, "--json"]);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = logSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(printed);
      expect(parsed.schemaVersion).toBe(1);
      expect(Array.isArray(parsed.rows)).toBe(true);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].path).toBe(runDir);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints the human table by default, including the independent-observation notice", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-table-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["ls", root]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]![0] as string;
      expect(printed).toContain(runDir);
      expect(printed).toMatch(/independent observation/i);
    } finally {
      logSpy.mockRestore();
    }
  });

  // Task 10, criterion 1 -- human ruling 85's actual endpoint: `ls` must SHOW a stuck lock, not
  // merely observe run files. pid:0 signals the caller's own process group and never throws
  // (inspectLock.ts), so it lands on liveness-unknown -- the state human ruling 74 invented
  // specifically because a false "alive" here would leave an operator with no escape hatch.
  it("reports a pid:0 owner-transfer lock as liveness-unknown, and still exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-lock-liveness-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "");
    await writeFile(
      join(runDir, ".owner-transfer.lock"),
      JSON.stringify({ holderProcessInstanceId: "pid:0", acquiredAt: "2026-09-23T00:00:00.000Z" }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["ls", root]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]![0] as string;
      expect(printed).toContain("state: liveness-unknown");
    } finally {
      logSpy.mockRestore();
    }
  });

  // Task 10, criterion 2 -- spec §3.6: an unreadable lock file is a reported fact, never a command
  // failure. file-unreadable is the one state with no --force route (its credential is a hash of
  // bytes that could not be read), and losing exit 0 here would be a second, harsher way of saying
  // the same thing the missing digest line already says honestly.
  it("reports an EACCES owner-transfer lock as file-unreadable, and still exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccloop-ls-lock-eacces-"));
    const runDir = join(root, "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), "");
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ holderProcessInstanceId: "pid:1", acquiredAt: "2026-09-23T00:00:00.000Z" }),
    );
    await chmod(lockPath, 0o000);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["ls", root]);
      expect(code).toBe(0);
      const printed = logSpy.mock.calls[0]![0] as string;
      expect(printed).toContain("state: file-unreadable");
    } finally {
      logSpy.mockRestore();
      // Restore permissions so the temp-dir cleanup this test relies on (mkdtemp's OS-level
      // reaping) does not itself get blocked by an unreadable file.
      await chmod(lockPath, 0o600);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Task C2 (L3 §6/§7): the `sweep` CLI surface.
//
// The `main sweep` tests below drive the REAL sweepRuns, the REAL scanRuns and the REAL
// resumeLoop through main() — nothing is injected. What is under test is the CLI surface's own
// wiring, i.e. which failures become exit 1 and which outcomes stay exit 0, and injecting a
// stand-in sweep would move the very number being asserted into the test fixture. The per-run
// pipeline itself (filter, order, quota) is covered by tests/sweep/sweepRuns.test.ts.
// ---------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function createSweepRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "ccloop-sweep-repo-"));
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

// maxAttempts is 2 and the seeded run has already used attempt 1, so the single scripted attempt
// this contract allows is the LAST one: a rejected verification there lands on
// evaluateStopDecision's `attemptNumber >= maxAttempts` branch, i.e. "exhausted".
// *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling FW-3) -- the attempt is no longer scripted: it is
// played by ccloop's fake codex (`frames` mode, through `sweep --agents`), which plays the frame list's second entry
// for attempt 2. ***
function createSweepContract(repoPath: string): LoopContract {
  return {
    objective: { taskId: "task-1", goal: "Fix", successCondition: "pass", nonGoals: [] },
    context: { repoPath, targetPaths: ["src"], relevantDocs: [], buildTestCommands: ["npm test"], constraints: [] },
    executionPolicy: { autonomyLevel: "L2", maxAttempts: 2, perAttemptTimeoutMs: 10_000, totalRuntimeBudgetMs: 60_000, tokenBudget: 1000, worktreeRequired: true, partialOutcomeRecoveryWindowMs: 1000 },
    safetyPolicy: { allowlistPaths: ["src/**"], denylistPaths: [".env"], maxFilesTouched: 10, humanGateConditions: [] },
    verification: { verifierType: "agent", requiredChecks: ["true"], rejectOn: ["tests fail"], evidenceRequired: [] },
    escalationAndExit: { escalationTargets: ["human"], pauseOn: [], stopOn: [], terminalStates: ["succeeded", "blocked_waiting_human", "exhausted", "cancelled", "failed"] },
  };
}

// Same shape as tests/controller/resumeLoop.integration.test.ts's seedEligibleRun: an
// interrupted run at attemptsUsed=1 whose published owner-transfer says it may be continued.
// `eligibleForContinuation: true` is also the field L2 observes and sweepRuns filters on.
async function seedEligibleRun(runDir: string, contract: LoopContract) {
  await mkdir(join(runDir, "attempts"), { recursive: true });
  await writeFile(join(runDir, "loop-contract.json"), JSON.stringify(contract, null, 2));
  await writeFile(join(runDir, "events.jsonl"), "");
  await writeFile(join(runDir, "loop-state.json"), JSON.stringify({
    status: "executing", currentAttempt: 1, attemptsUsed: 1,
    lastTransitionAt: "2026-07-25T00:00:00.000Z", waitingOnHuman: false, stopReason: null,
    budgetSnapshot: { attemptsRemaining: 1, timeRemainingMs: 60_000, tokenBudgetRemaining: 1000 },
    recentFailures: [],
  }));
  await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
    runId: "task-1", logicalSessionId: "task-1:t0", currentOwnerEpoch: 2,
    currentProcessInstanceId: "pid:100", lastAffirmedAt: "2026-07-25T00:00:00.000Z",
    ownerStatus: "current", supersededByEpoch: null,
  }));
  await writeFile(join(runDir, "owner-transfer.json"), JSON.stringify({
    priorOwnerEpoch: 1, newOwnerEpoch: 2, priorProcessInstanceId: "pid:100",
    newProcessInstanceId: "pid:100", transferredAt: "2026-07-25T00:00:00.000Z",
    reason: "owner lost", eligibleForContinuation: true,
  }));
  await writeFile(join(runDir, "reconciliation-record.json"), JSON.stringify({
    staleSuspicionBasis: [], staleConfirmed: true, ownershipVerdict: "OWNER_LOST",
    lastTrustedBoundary: "execute", conflictingEvidence: [],
    takeoverPermission: { allowed: true, reason: "ok" },
    priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
  }));
}

// A frame whose verification is REJECTED: with the run already on its last allowed attempt this
// is what drives the run to "exhausted" rather than "succeeded".
// *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-2) -- the frame is now a
// fake-codex `frames` entry (changed files, approved, safeToRetry) rather than a ScriptedAdapter frame; the seeded run
// resumes at attempt 2, so the fake codex plays the list's second entry. ***
function rejectedFrame(): Frame {
  return { changedFiles: ["src/index.ts"], approved: false, safeToRetry: true };
}

// One eligible run under a scannable root, plus a readable scripted adapter config OUTSIDE that
// root (a stray file inside it would become a scan row of its own).
// *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-2) -- the scripted adapter
// config is gone with `--adapter`: what sits OUTSIDE the root is now the agents table (same reason), and the run
// directory carries the frozen selection `sweep --agents` rebuilds each run's agent from. ***
async function seedSweepRoot(): Promise<{ root: string; runDir: string; tablePath: string }> {
  const repoPath = await createSweepRepo();
  const root = await mkdtemp(join(tmpdir(), "ccloop-sweep-root-"));
  const runDir = join(root, "run-1");
  await seedEligibleRun(runDir, createSweepContract(repoPath));

  const { tablePath, selectionFile } = await framesAgents([rejectedFrame(), rejectedFrame()]);
  await writeFile(join(runDir, "agent-selection.json"), selectionFile, { mode: 0o600 });

  return { root, runDir, tablePath };
}

describe("parseArgs unlock", () => {
  // `unlock` takes a positional run directory like `ls` does, but unlike `ls` it also carries a
  // flag that TAKES A VALUE (--expect). "the first token that is not --prefixed" — the rule `ls`
  // uses — would happily read the digest as the run directory when --expect comes first, and then
  // delete a lock in whatever directory that string named. So the positional has to be found by
  // walking the flags, and these tests pin that it is.
  it("parses a positional run directory", () => {
    expect(parseArgs(["unlock", "/tmp/some-run"])).toEqual({
      command: "unlock",
      runDir: "/tmp/some-run",
      force: false,
    });
  });

  it("parses --force with its --expect credential", () => {
    expect(parseArgs(["unlock", "/tmp/some-run", "--force", "--expect", "abc123"])).toEqual({
      command: "unlock",
      runDir: "/tmp/some-run",
      force: true,
      expectedDigest: "abc123",
    });
  });

  it("does not mistake the --expect value for the run directory when the flag comes first", () => {
    expect(parseArgs(["unlock", "--force", "--expect", "abc123", "/tmp/some-run"])).toEqual({
      command: "unlock",
      runDir: "/tmp/some-run",
      force: true,
      expectedDigest: "abc123",
    });
  });

  it("refuses --force with no credential (human ruling 73)", () => {
    // The credential is the whole of what --force means here. Accepting a bare --force would
    // reinstate exactly the escape hatch ruling 73 declined to build: one that proves nothing
    // about whether the operator ever looked at the lock.
    expect(() => parseArgs(["unlock", "/tmp/some-run", "--force"])).toThrow(/--expect/);
  });

  it("refuses --expect with no --force, rather than silently ignoring it", () => {
    expect(() => parseArgs(["unlock", "/tmp/some-run", "--expect", "abc123"])).toThrow(/--force/);
  });

  it("throws about the MISSING RUN DIRECTORY, not about something else", () => {
    // Matched on the message rather than left bare: `parseArgs(["unlock"])` would also throw if the
    // credential checks ran first, and a bare .toThrow() cannot tell a correct refusal from one
    // that is right by accident.
    expect(() => parseArgs(["unlock"])).toThrow(/run directory/);
    expect(() => parseArgs(["unlock", "--force", "--expect", "abc123"])).toThrow(/run directory/);
  });

  it("does not require --adapter, --adapter-config, or --contract", () => {
    expect(() => parseArgs(["unlock", "/tmp/some-run"])).not.toThrow();
  });

  it("names unlock in the unknown-command message", () => {
    expect(() => parseArgs(["nonsense"])).toThrow(/unlock/);
  });
});

describe("main unlock", () => {
  it("exits 0 and reports absence for a run directory with no lock", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cli-unlock-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["unlock", runDir])).toBe(0);
      expect(log).toHaveBeenCalledWith("absent   no owner-transfer lock present");
    } finally {
      log.mockRestore();
    }
  });

  it("exits 1 and leaves a live holder's lock on disk", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-cli-unlock-"));
    const lockPath = join(runDir, ".owner-transfer.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ holderProcessInstanceId: `pid:${process.pid}`, acquiredAt: "2026-08-20T00:00:00.000Z" }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["unlock", runDir])).toBe(1);
      expect(error).toHaveBeenCalledWith(`refused  pid ${process.pid} is alive`);
    } finally {
      error.mockRestore();
    }
    // The point of the whole command, asserted through the real CLI entry point and not just the
    // module beneath it.
    await expect(readFile(lockPath, "utf8")).resolves.toContain(`pid:${process.pid}`);
  });
});

describe("parseArgs sweep", () => {
  // §6's stated reason for spelling the root as a flag: the flag/value pairing loop this command
  // shares with run/resume would read a POSITIONAL root as the value of nothing and then pair
  // `--adapter` as a key of its own, reporting missing flags on a command line that looks legal.
  // *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-2) -- `--adapter` was
  // removed (and is refused before any pairing); the same misreading now pairs `--agents` and `--max-runs` off by
  // one, which is what this criterion exercises. ***
  it("rejects a positional root, which the flag/value pairing would misread", () => {
    expect(() =>
      parseArgs(["sweep", "/tmp/root", "--agents", "/tmp/agents.json", "--max-runs", "3"]),
    ).toThrow(/missing required flags/);
  });
});

describe("main sweep", () => {
  // §7 / §12: --max-runs is the bound a human approves a sweep against, so its absence is a
  // refusal to sweep, never a defaulted sweep. Every OTHER flag here is valid and the same
  // command with `--max-runs 1` exits 0 below, so exit 1 can only come from this flag.
  it("exits 1 when --max-runs is missing", async () => {
    const { root, tablePath } = await seedSweepRoot();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        main(["sweep", "--root", root, "--agents", tablePath]),
      ).resolves.toBe(1);
      expect(errorSpy).toHaveBeenCalledWith("missing required flags");
      // §8's first line: a sweep that never started never scanned, so no banner was printed.
      // The needle must be a fragment the banner ACTUALLY contains, or this guard cannot fail.
      // `observed eligibleForContinuation=true` is that fragment and is unique to the banner
      // (`grep -rnF` finds it at exactly one site in src/: the stderr call in sweepRuns.ts). It
      // has to be kept in step with the banner's wording — the GATE-C fix wave reworded the
      // banner and left the old needle `eligible run(s)` behind, which zeroed all three of these.
      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("observed eligibleForContinuation=true");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exits 1 when --max-runs is not a positive integer", async () => {
    const { root, tablePath } = await seedSweepRoot();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Every way the value can fail to be a positive integer, including the two that
      // Number()/parseInt() would silently accept ("1e3" -> 1000, "2abc" -> 2).
      for (const value of ["0", "-1", "2.5", "abc", "1e3", "2abc"]) {
        errorSpy.mockClear();
        await expect(
          main(["sweep", "--root", root, "--agents", tablePath, "--max-runs", value]),
        ).resolves.toBe(1);
        // The reason matters: without it this test would pass for any refusal at all — including
        // one that never recognised `sweep` as a command.
        expect(errorSpy).toHaveBeenCalledWith("--max-runs must be a positive integer");
        // Same needle, same reason, as the banner guard above.
        expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("observed eligibleForContinuation=true");
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  // §8's first line: a config that cannot be READ exits 1 WITHOUT scanning. The root here is the
  // same valid root the exit-0 test sweeps, so the assertion is not "some failure happened".
  // *** ERRATUM (consolidation step 4, 2026-10-01, Orca session be653b22, controller ruling C-2) -- the config is now
  // the agents table (`--adapter-config` was removed); main reads it before the scan, so the same holds for it. ***
  it("exits 1 when the agents table cannot be read", async () => {
    const { root, tablePath } = await seedSweepRoot();
    const missingTablePath = join(tablePath, "..", "does-not-exist.json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        main(["sweep", "--root", root, "--agents", missingTablePath, "--max-runs", "1"]),
      ).resolves.toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("ENOENT");
      // Same needle, same reason, as the banner guard above.
      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("observed eligibleForContinuation=true");
    } finally {
      errorSpy.mockRestore();
    }
  });

  // §7: the scan failing at its OWN root is the only per-scan condition that exits non-zero. The
  // stderr assertion is what distinguishes it from the argument failures above, which would also
  // be exit 1 — this run got as far as the scan and the scan is what refused.
  it("exits 1 when the root does not exist", async () => {
    const { tablePath } = await seedSweepRoot();
    const missingRoot = join(await mkdtemp(join(tmpdir(), "ccloop-sweep-missing-")), "does-not-exist");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        main(["sweep", "--root", missingRoot, "--agents", tablePath, "--max-runs", "1"]),
      ).resolves.toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(`sweep: cannot scan ${missingRoot}`);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // §7's exit-code table, the row the `? 0 : 2` mapping would get wrong: a run that ends
  // `exhausted` is a REPORTED OUTCOME of a sweep that completed, not a sweep failure. Were the
  // sweep branch to fall through to either run/resume mapping this would be 2.
  it("exits 0 when a run reaches exhausted", async () => {
    const { root, runDir, tablePath } = await seedSweepRoot();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Precondition, asserted rather than assumed: the run is NOT already terminal, so the
      // status read after the sweep is one this sweep produced.
      const before = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as { status: string };
      expect(before.status).toBe("executing");

      const code = await main([
        "sweep", "--root", root, "--agents", tablePath, "--max-runs", "1",
      ]);

      // The run really did reach `exhausted` — without this the exit code could be 0 for a
      // sweep that adopted nothing at all.
      const after = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as { status: string };
      expect(after.status).toBe("exhausted");
      expect(code).toBe(0);
      expect(code).not.toBe(2);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("registerStopHandlers", () => {
  // §5.4's escape hatch. The counter is ONE counter across both signals: counting per signal
  // kind would make "Ctrl-C, then kill" — the most common escalation an operator reaches for —
  // never reach the escape hatch at all.
  it("sets the slot on the first signal and exits 130 on the second, counting SIGINT and SIGTERM together", () => {
    const signal = createStopRequestSignal();
    const exitCodes: number[] = [];
    const listenersBefore = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };

    const unregister = registerStopHandlers(signal, { exit: (code) => { exitCodes.push(code); } });
    try {
      // Preconditions, asserted rather than assumed: the slot starts CLEAR (so "requested" below
      // is this handler's doing) and a handler for each signal really was installed (so an
      // implementation that registered nothing could not pass by emitting into the void).
      expect(signal.requested).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(listenersBefore.int + 1);
      expect(process.listenerCount("SIGTERM")).toBe(listenersBefore.term + 1);

      process.emit("SIGINT", "SIGINT");
      expect(signal.requested).toBe(true);
      expect(exitCodes).toEqual([]);

      process.emit("SIGTERM", "SIGTERM");
      expect(exitCodes).toEqual([130]);
    } finally {
      unregister();
    }

    // The returned function really unregisters: a test that installs real process handlers and
    // leaves them behind leaks into every test that runs after it.
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore.int);
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore.term);
  });
});
