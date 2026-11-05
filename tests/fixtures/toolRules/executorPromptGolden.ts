// The executor prompt for RAW_CONTRACT with no toolRules, as the code under test must build it: the 2a2ae53 capture
// (golden-2a2ae53/executor-prompt.txt, left byte-for-byte as captured) with exactly the lines a later human-ruled change
// replaced, each written out here in full. A replaced line that is not in the capture exactly once throws, so a
// substitution cannot silently do nothing.
import { readFile } from "node:fs/promises";

// Orca session 3cfc2e73, batch D6 (Orca tester issues 123 and 138; human: 「这个session允许改写必要的判据」).
export const EXECUTOR_PROMPT_REPLACEMENTS: ReadonlyArray<readonly [before: string, after: string]> = [
  [
    'When possible, include optional taskResult metadata in that same complete or partial object: {"schema":"task-result-v1","goal":string,"completedWork":string[],"conclusions":string[],"outputs":[{"path":string,"label":string}],"limitations":string[]}.',
    'When possible, include optional taskResult metadata as one nested object under the "taskResult" key of that complete or partial object, never as top-level fields: "taskResult":{"schema":"task-result-v1","goal":string,"completedWork":string[],"conclusions":string[],"outputs":[{"path":string,"label":string}],"limitations":string[]}. decisions, debug and flow, when you report them, are top-level keys beside changedFiles, not inside taskResult.',
  ],
  [
    "undo.how names what to change back: the files or fields (for example: restore the retry loop in src/x.ts), or a command when one applies; git revert only fits right after the change lands, so do not rely on it.",
    'undo.how names what to change back: the files or fields (for example: restore the retry loop in src/x.ts), or a command when one applies; git revert only fits right after the change lands, so do not rely on it. When you chose to change nothing or declined a change, undo.how names that declined change concretely, with its file path or field (for example: if needed, add boundary assertions to test/math.test.js), not "nothing to undo".',
  ],
];

export async function currentExecutorPromptGolden(): Promise<string> {
  const lines = (await readFile(new URL("golden-2a2ae53/executor-prompt.txt", import.meta.url), "utf8")).split("\n");
  for (const [before, after] of EXECUTOR_PROMPT_REPLACEMENTS) {
    const at = lines.indexOf(before);
    if (at < 0 || lines.lastIndexOf(before) !== at) throw new Error(`golden-2a2ae53 executor prompt: replaced line not found exactly once: ${before}`);
    lines[at] = after;
  }
  return lines.join("\n");
}
