import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Task handoffs (Orca spec 2026-11-12 tester follow-up G §10.2): the agent writes handoff.md and summary.md into Orca's
 * output directory, outside the worktree. ccloop does not count those writes as changed paths, so an agent that lists them
 * in changedFiles is not blocked as an allowlist miss. Every other entry is kept, in order.
 */
export function dropHandoffOutput(changedFiles: string[], worktreePath: string | null, outputDir: string | undefined): string[] {
  if (outputDir === undefined) return changedFiles;
  const root = resolve(outputDir);
  const inside = (path: string): boolean => {
    const absolute = isAbsolute(path) ? resolve(path) : worktreePath === null ? null : resolve(worktreePath, path);
    if (absolute === null) return false;
    const difference = relative(root, absolute);
    return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
  };
  return changedFiles.filter((path) => !inside(path));
}
