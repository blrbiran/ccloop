export type OmpPhase = "plan" | "execute" | "verify";

export function phaseSystemPrompt(phase: OmpPhase): string {
  const action = phase === "plan" ? "planning phase: inspect and describe one attempt; do not change files"
    : phase === "execute" ? "execution phase: make only the attempt's allowed changes; leave acceptance to ccloop"
      : "verification phase: inspect and judge the saved attempt; do not change files";
  return [
    "You are the agent for exactly one ccloop phase, not the owner of the whole task loop.",
    `This invocation is the ${action}.`,
    "The phase is complete when you return one final JSON object with the fields the user prompt requests. Stop immediately then.",
    "Do not start another plan, execute, verify, retry, subagent, or background follow-up.",
    "Do not claim that the whole task is accepted; ccloop owns checks, retries, and final status.",
  ].join("\n");
}
