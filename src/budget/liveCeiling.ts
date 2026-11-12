import { z } from "zod";

/**
 * Live token ceiling (Orca tester follow-up G part 2, spec docs/superpowers/specs/2026-11-12-live-ceiling-design.md): an
 * opt-in, Orca-updatable bound on a run's whole work tokens. It rides in the protocol-4 start envelope (`liveCeiling`) and
 * Orca raises it while the run runs through the `live-ceiling` control method; each write carries a strictly higher
 * revision. `cause` is Orca's own label for why this value binds; ccloop only records it on a stop.
 */
const safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const liveCeilingSchema = z.object({
  protocol: z.literal(1),
  revision: safe.refine((value) => value > 0),
  tokens: safe,
  cause: z.enum(["group", "pause-line", "task-cap"]),
}).strict();
export type LiveCeiling = z.infer<typeof liveCeilingSchema>;
export type LiveCeilingCause = LiveCeiling["cause"];

/** The stop reason of a run ended at its live ceiling, mid-call or at a phase boundary. */
export const LIVE_CEILING_STOP_REASON = "live token ceiling reached";

/** At a phase boundary: the run's whole work tokens have reached the ceiling, so no further phase starts. */
export function ceilingReachedAtBoundary(runTokens: number, ceiling: LiveCeiling): boolean {
  return runTokens >= ceiling.tokens;
}

/** Mid-call: the phase total at which the phase is stopped; may be <= 0 (the boundary check runs before any phase). */
export function phaseCeilingThreshold(runTokensBeforePhase: number, ceiling: LiveCeiling): number {
  return ceiling.tokens - runTokensBeforePhase;
}
