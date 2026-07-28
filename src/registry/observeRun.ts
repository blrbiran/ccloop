// L2 run registry — composes the per-file observations into one observation record for a
// single run directory. See docs/superpowers/specs/2026-07-28-run-registry-design.md §6.

import { OBSERVED_FILES } from "./observeFields.js";
import { readObservedFile } from "./readObservedFile.js";
import type { ObserveDeps } from "./readObservedFile.js";
import type { FileObservation } from "./types.js";

export type RunObservation = {
  kind: "run";
  path: string;
  observedAt: string;
  files: FileObservation[];
};

// One entry per OBSERVED_FILES entry, in that order, always (spec §6: a row is never
// omitted). readObservedFile never rejects — every reader failure it sees (ENOENT, parse
// failure, or any other error) resolves to a FileObservation whose fields carry the
// corresponding absent/unreadable state — so a failure reading one file can never prevent
// the other two from being observed here.
export async function observeRun(runDir: string, deps: ObserveDeps): Promise<RunObservation> {
  const files = await Promise.all(
    OBSERVED_FILES.map((spec) => readObservedFile(runDir, spec, deps)),
  );

  return {
    kind: "run",
    path: runDir,
    observedAt: deps.now().toISOString(),
    files,
  };
}
