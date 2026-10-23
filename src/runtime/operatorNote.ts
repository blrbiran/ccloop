import type { OperatorNote } from "./types.js";

/**
 * Operator note (Orca spec docs/superpowers/specs/2026-10-23-live-transcript-design.md §10.2.6): which attempts of this run
 * get the person's note. `remaining-attempts`: every attempt's plan and execute. `next-attempt`: only the first attempt this
 * run plans or executes -- a continuation that resumes at verify passes the note on to the next attempt, because the
 * resumed attempt's plan and execute are not run again. Verify never gets it (the caller asks only for plan and execute).
 */
export function operatorNoteGate(note: OperatorNote | undefined): (attempt: number) => { operatorNote?: OperatorNote } {
  let first: number | null = null;
  return (attempt) => {
    if (note === undefined) return {};
    if (note.scope === "remaining-attempts") return { operatorNote: note };
    first ??= attempt;
    return attempt === first ? { operatorNote: note } : {};
  };
}
