export type OmpPhase = "plan" | "execute" | "verify";

/** The tools each phase passes to omp's `--tools` and the phase fold admits; one list, so the prompt cannot drift from it. */
export function ompPhaseTools(phase: OmpPhase): readonly string[] {
  return phase === "execute" ? ["read", "grep", "glob", "edit", "write", "bash"] : ["read", "grep", "glob"];
}

export function phaseSystemPrompt(phase: OmpPhase): string {
  const action = phase === "plan" ? "planning phase: inspect and describe one attempt; do not change files"
    : phase === "execute" ? "execution phase: make only the attempt's allowed changes; leave acceptance to ccloop"
      : "verification phase: inspect and judge the saved attempt; do not change files";
  return [
    "You are the agent for exactly one ccloop phase, not the owner of the whole task loop.",
    `This invocation is the ${action}.`,
    // Plan phase tools (spec 2026-10-27-plan-phase-tools, Orca issue 60): a plan model that was never told its tools reached
    // for an MCP bridge through `write`; the human kept plan read-only, so the prompt says what it has and what waits.
    ...(phase === "plan" ? [`Tools available in this phase: ${ompPhaseTools(phase).join(", ")}. Writes, shell commands and MCP calls (including xd:// paths) are unavailable until the execute phase; describe what execute should run instead of calling them.`] : []),
    "The phase is complete when you return one final JSON object with the fields the user prompt requests. Stop immediately then.",
    "Do not start another plan, execute, verify, retry, subagent, or background follow-up.",
    "Do not claim that the whole task is accepted; ccloop owns checks, retries, and final status.",
    "Do not run git add, git reset, git commit, git checkout, or git branch; ccloop owns Git staging, commits, and publication.",
    ...(phase === "verify" ? ['In the final JSON, rejectCategory must be a string; use "" when approved, never null. safeToRetry must be false when approved.'] : []),
  ].join("\n");
}

/**
 * OMP single call (Orca spec 2026-10-14 §3.3.4): the whole answer is one JSON object satisfying the request's schema.
 * Task 0 measured this prompt's request-body overhead against the operator's framingTokenOverhead (spec §7).
 */
export function singleCallSystemPrompt(responseSchema: Record<string, unknown>): string {
  return [
    "This invocation is one ccloop single call: answer the user prompt once, with no tools and no follow-up.",
    "Reply with exactly one JSON object that satisfies the JSON Schema below, and nothing else: no prose before or after it.",
    JSON.stringify(responseSchema),
  ].join("\n");
}
