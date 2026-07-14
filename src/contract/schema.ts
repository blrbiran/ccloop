import { z } from "zod";

export const terminalStateSchema = z.enum([
  "succeeded",
  "blocked_waiting_human",
  "exhausted",
  "cancelled",
  "failed",
]);

export const loopContractSchema = z.object({
  objective: z.object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    successCondition: z.string().min(1),
    nonGoals: z.array(z.string()).default([]),
  }),
  context: z.object({
    repoPath: z.string().min(1),
    targetPaths: z.array(z.string()).min(1),
    relevantDocs: z.array(z.string()).default([]),
    buildTestCommands: z.array(z.string()).min(1),
    constraints: z.array(z.string()).default([]),
  }),
  executionPolicy: z.object({
    autonomyLevel: z.literal("L2"),
    maxAttempts: z.number().int().positive(),
    perAttemptTimeoutMs: z.number().int().positive(),
    totalRuntimeBudgetMs: z.number().int().positive(),
    tokenBudget: z.number().int().positive(),
    worktreeRequired: z.literal(true),
  }),
  safetyPolicy: z.object({
    allowlistPaths: z.array(z.string()).default([]),
    denylistPaths: z.array(z.string()).default([]),
    maxFilesTouched: z.number().int().positive(),
    humanGateConditions: z.array(z.string()).default([]),
  }),
  verification: z.object({
    verifierType: z.enum(["command", "agent"]),
    requiredChecks: z.array(z.string()).min(1),
    rejectOn: z.array(z.string()).min(1),
    evidenceRequired: z.array(z.string()).default([]),
  }),
  escalationAndExit: z.object({
    escalationTargets: z.array(z.string()).default([]),
    pauseOn: z.array(z.string()).default([]),
    stopOn: z.array(z.string()).default([]),
    terminalStates: z.array(terminalStateSchema).default([
      "succeeded",
      "blocked_waiting_human",
      "exhausted",
      "cancelled",
      "failed",
    ]),
  }),
});

export type LoopContract = z.infer<typeof loopContractSchema>;
