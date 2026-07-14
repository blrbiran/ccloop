import { z } from "zod";

export const V1_TERMINAL_STATES = [
  "succeeded",
  "blocked_waiting_human",
  "exhausted",
  "cancelled",
  "failed",
] as const;

export const terminalStateSchema = z.enum(V1_TERMINAL_STATES);

const terminalStatesSchema = z.array(terminalStateSchema).refine(
  (states) =>
    states.length === V1_TERMINAL_STATES.length &&
    new Set(states).size === V1_TERMINAL_STATES.length &&
    V1_TERMINAL_STATES.every((state) => states.includes(state)),
  {
    message:
      "terminalStates must include exactly the full V1 terminal states: succeeded, blocked_waiting_human, exhausted, cancelled, failed",
  },
);

export const loopContractSchema = z
  .object({
    objective: z
      .object({
        taskId: z.string().min(1),
        goal: z.string().min(1),
        successCondition: z.string().min(1),
        nonGoals: z.array(z.string()).default([]),
      })
      .strict(),
    context: z
      .object({
        repoPath: z.string().min(1),
        targetPaths: z.array(z.string()).min(1),
        relevantDocs: z.array(z.string()).default([]),
        buildTestCommands: z.array(z.string()).min(1),
        constraints: z.array(z.string()).default([]),
      })
      .strict(),
    executionPolicy: z
      .object({
        autonomyLevel: z.literal("L2"),
        maxAttempts: z.number().int().positive(),
        perAttemptTimeoutMs: z.number().int().positive(),
        totalRuntimeBudgetMs: z.number().int().positive(),
        tokenBudget: z.number().int().positive(),
        worktreeRequired: z.literal(true),
      })
      .strict(),
    safetyPolicy: z
      .object({
        allowlistPaths: z.array(z.string()).default([]),
        denylistPaths: z.array(z.string()).default([]),
        maxFilesTouched: z.number().int().positive(),
        humanGateConditions: z.array(z.string()).default([]),
      })
      .strict(),
    verification: z
      .object({
        verifierType: z.enum(["command", "agent"]),
        requiredChecks: z.array(z.string()).min(1),
        rejectOn: z.array(z.string()).min(1),
        evidenceRequired: z.array(z.string()).default([]),
      })
      .strict(),
    escalationAndExit: z
      .object({
        escalationTargets: z.array(z.string()).default([]),
        pauseOn: z.array(z.string()).default([]),
        stopOn: z.array(z.string()).default([]),
        terminalStates: terminalStatesSchema.default(() => [...V1_TERMINAL_STATES]),
      })
      .strict(),
  })
  .strict();

export type LoopContract = z.infer<typeof loopContractSchema>;
