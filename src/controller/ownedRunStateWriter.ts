import { appendEvent, readOwnerRecordWithoutRecovery, writeRunState } from "../persistence/fileStore.js";
import { isTerminalRunStatus } from "../state/stateMachine.js";
import { parseOwnerRecordForLease } from "../ownership/lease.js";
import { buildProcessInstanceId } from "../runtime/processIdentity.js";
import type { RunState } from "../state/types.js";

// Package 2 / debt 2. Answers ONE question: does owner-record.json on disk name a process other
// than this one? That is deliberately NOT checkRunLease's question and this must not be rewritten
// to call it. The gate asks "is a LIVE lease held by someone else", because taking over a run
// whose lease has lapsed is legitimate; this asks "am I the owner", and a lapsed lease does not
// promote a non-owner into one. Ownership changes hands only through the epoch transfer, so a
// record naming someone else refuses here whether their lease is fresh, stale, or absent.
//
// Reads RAW, for leaseGate's §7.1 reason: readOwnerRecord runs recoverInterruptedOwnerTransfer
// first, and a refusal to write must not trigger crash recovery as its side effect.
//
// The four answers are kept DISTINCT rather than collapsed to a boolean, because "no record" and
// "a record I could not read" are not the same fact and must not be handled the same way. An
// earlier version of this guard collapsed them and thereby failed open in silence (review finding
// F-3); the caller below now reports the unreadable case.
type OwnershipObservation =
  | { kind: "unowned" }
  | { kind: "self" }
  | { kind: "unverified"; detail: string }
  | { kind: "foreign"; ownerProcessInstanceId: string };

async function observeOwnership(runDir: string): Promise<OwnershipObservation> {
  let raw: unknown;

  try {
    raw = await readOwnerRecordWithoutRecovery(runDir);
  } catch (error) {
    // ONLY ENOENT means "no record at all", i.e. nobody to protect. leaseGate draws the same line
    // for the same reason, and it is the ordinary observation for a run driven through
    // runLoopFromState directly.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "unowned" };
    }

    return { kind: "unverified", detail: String(error) };
  }

  try {
    const ownerProcessInstanceId = parseOwnerRecordForLease(raw).currentProcessInstanceId;

    // §5.1: opaque, compared only for string equality — the same comparison the gate makes, so a
    // legacy or recycled id can only add refusals here.
    return ownerProcessInstanceId === buildProcessInstanceId()
      ? { kind: "self" }
      : { kind: "foreign", ownerProcessInstanceId };
  } catch (error) {
    return { kind: "unverified", detail: String(error) };
  }
}

// Package 2 / debt 2, review round 1. THE chokepoint: every loop-state.json write performed by
// runLoopFromState and by persistTerminalState goes through here.
//
// *** ERRATUM, task S4 (package 2, debt D-1) — this paragraph is a NAMED rewrite, not a silent
// edit. Until S4 this function lived in runLoop.ts, and the two sentences below read, verbatim:
//   (i)  "…goes through here, and `writeRunState` is called from exactly one place in this module
//         — the line below."
//   (ii) "The completeness argument is therefore no longer 'I audited the call sites and they are
//         covered'; it is 'this module cannot write a run state except through this function',
//         which is a property a reader can check with one grep instead of an audit that already
//         went wrong once."
// Both became false descriptions in place the moment the writer moved out of runLoop.ts: "this
// module" in (i) and (ii) meant runLoop.ts, and the writer is no longer in it. They are rewritten
// rather than deleted because the argument they carry is still the load-bearing one; only its
// mechanism changed. The rewrite:
//   (i')  `writeRunState` is called from exactly one place in THIS module — the line at the bottom
//         of the returned closure — and runLoop.ts does not import `writeRunState` at all.
//   (ii') The completeness argument is no longer "I audited the call sites and they are covered",
//         and no longer "a reader can check it with one grep" either. That grep was the weak part:
//         a scoped re-reviewer defeated the acceptance probe
//         `grep -c 'await writeRunState(' src/controller/runLoop.ts` in 7 of 7 attempts with
//         ordinary rewrites (void / return / aliased import / double space / newline after await /
//         Promise.all / a direct writeFile), and nothing in the repository ran that probe. The
//         argument is now "runLoop.ts cannot call writeRunState without first importing it, and a
//         test reads runLoop.ts's source and fails if that import specifier reappears"
//         (tests/controller/ownedRunStateWriter.structure.test.ts). That is an enforced check,
//         not an assertion of completeness with nothing behind it.
//   HONEST LIMIT, stated here rather than in the report only: this does NOT stop runLoop.ts from
//   writing loop-state.json through some OTHER module — a direct
//   `writeFile(join(runDir, "loop-state.json"), …)` bypasses the guard and the test alike. That
//   path is STILL OPEN. Closing it needs the type-level invariant (option (c)), which changes
//   existing test expectations in tests/persistence/fileStore.test.ts and was not authorised. ***
//
// That structure is the point, and it is a correction of how the first version of this guard
// argued for its own completeness. That version sat inside persistTerminalState and justified its
// coverage with the claim "persistTerminalState is the only writer of a terminal loop-state.json".
// The claim was FALSE (review finding F-1): the outer catch's failure branches transition to
// "failed" — which is terminal, `failed: []` in legalTransitions — and call writeRunState
// directly, so a terminal status still reached a run this process did not own.
//
// Refusing NON-terminal writes too (review finding F-2) is deliberate and is what makes the rule
// one rule. The invariant is "do not modify a run you do not own"; terminal vs non-terminal
// describes how bad the damage is, not whether this process is allowed to do it.
//
// Reporting is latched per writer instance — one event of each kind per runLoopFromState
// invocation. Without a bound, a loop refused at every phase boundary would append an unbounded
// number of identical lines to a run owned by someone else; with no event at all it would be the
// silent failure writeBoundaryArtifacts warns about (fileStore.ts). One line is the smallest
// record that is still a record.
export type OwnedRunStateWriter = (runDir: string, state: RunState) => Promise<boolean>;

export function createOwnedRunStateWriter(): OwnedRunStateWriter {
  const reported = new Set<string>();

  const reportOnce = async (runDir: string, type: string, detail: string): Promise<void> => {
    if (reported.has(type)) {
      return;
    }

    reported.add(type);
    await appendEvent(runDir, { type, at: new Date().toISOString(), detail });
  };

  return async (runDir, state) => {
    const ownership = await observeOwnership(runDir);

    if (ownership.kind === "foreign") {
      // Two event types rather than one, and NOT merely for readability: `terminal_write_abandoned`
      // is the refusal that prevents an unresumable run (the debt itself), while the non-terminal
      // one prevents a lesser mutation. Latching them separately also keeps the terminal refusal
      // observable even when a non-terminal write was refused earlier in the same invocation.
      await reportOnce(
        runDir,
        isTerminalRunStatus(state.status) ? "terminal_write_abandoned" : "run_state_write_abandoned",
        `refused to write run status ${state.status} into a run owned by `
          + `${ownership.ownerProcessInstanceId}, not by ${buildProcessInstanceId()}`,
      );
      return false;
    }

    if (ownership.kind === "unverified") {
      // F-3/F-4: this proceeds — a guard that cannot read the record must not turn a stop into a
      // crash, and an unreadable record has identified nobody, least of all a DIFFERENT owner. But
      // proceeding UNRECORDED is the silent failure this repository already has a stated position
      // against, so the fail-open is written down where an operator can find it. The earlier
      // version justified the silence by saying leaseHeartbeat answers this case with
      // lease_unverifiable; that reason is withdrawn (F-4) — it holds only when a real heartbeat is
      // running, and runLoopFromState's default is INERT_LEASE_HEARTBEAT.
      await reportOnce(
        runDir,
        "ownership_unverified",
        `proceeding with a run-state write for ${buildProcessInstanceId()}: `
          + `owner record present but unreadable: ${ownership.detail}`,
      );
    }

    // The ONLY writeRunState call in this module. Everything else routes here.
    await writeRunState(runDir, state);
    return true;
  };
}
