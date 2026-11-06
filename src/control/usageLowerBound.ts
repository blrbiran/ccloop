import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTEMPT, CALL, KINDS, PHASE, realDirectories } from "./transcripts.js";

/**
 * Orca #116: the tokens the run's calls were observed to spend before they ended without a usage report (each such call's
 * usage-lower-bound.json), summed; null when there is none. A floor to show a person, never an exact figure to book. An
 * unreadable or malformed file contributes nothing, so collect, which Orca polls for the whole run, does not fail on it.
 *
 * *** ERRATUM (Orca spec 2026-11-06-soft-mode-loop-run-settlement-design.md §3.2, §6; Orca session 86352010) -- "never booked" no longer holds in an unlimited group: under that design Orca books this floor (0 when there is none) as the run's approximate work usage under its own principal `orca-auto`, and saved-result recovery checks that booking (src/control/savedResultRecovery.ts, `approximate-floor`). It is still a floor, never an exact figure; a finite group still never books it. ***
 */
export async function observedUsageLowerBound(sourceDir: string): Promise<number | null> {
  let total = 0;
  for (const kind of KINDS) {
    const kindDir = join(sourceDir, "run", kind);
    for (const { name: attempt } of await realDirectories(kindDir, ATTEMPT)) {
      for (const { name: phase } of await realDirectories(join(kindDir, attempt), PHASE)) {
        for (const { name: call } of await realDirectories(join(kindDir, attempt, phase), CALL)) {
          const tokens = await readFile(join(kindDir, attempt, phase, call, "usage-lower-bound.json"), "utf8")
            .then((text) => (JSON.parse(text) as { tokens?: unknown }).tokens).catch(() => undefined);
          if (Number.isSafeInteger(tokens) && (tokens as number) > 0) total += tokens as number;
        }
      }
    }
  }
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}
