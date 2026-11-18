// The omp phase argv the code under test must send: the 2a2ae53 capture (golden-2a2ae53/omp-<phase>.json, left
// byte-for-byte as captured) with exactly the arguments a later human-ruled change added, inserted here in full. An anchor
// that is not in the capture exactly once throws, so the insertion cannot silently do nothing.
import { readFile } from "node:fs/promises";

// Ruling (2026-11-18, Orca session; blanket approval — per-test confirmation pending): Orca #369 (a) / #375 (ccloop spec
// docs/superpowers/specs/2026-11-18-omp-launch-isolation-design.md §3.1) -- every omp phase passes its per-launch overlay
// (omp's own retry and model fallback off, project MCP configs off) as `--config <evidence>/config-overlay.yml` right after
// `--cwd <worktree>`. Human: 「这次批准改写所有必要的判据」.
export async function currentOmpArgsGolden(phase: string): Promise<string[]> {
  const { args } = JSON.parse(await readFile(new URL(`golden-2a2ae53/omp-${phase}.json`, import.meta.url), "utf8")) as { args: string[] };
  const at = args.indexOf("--cwd");
  if (at < 0 || args.lastIndexOf("--cwd") !== at || at + 1 >= args.length) throw new Error(`golden-2a2ae53 omp-${phase}: --cwd not found exactly once`);
  return [...args.slice(0, at + 2), "--config", `<dir>/run/omp/1/${phase}/call-<id>/config-overlay.yml`, ...args.slice(at + 2)];
}
