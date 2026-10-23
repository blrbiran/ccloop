import { z } from "zod";
import { toolRulesSchema } from "../runtime/toolRules.js";

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

// Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.1, §19.2 P7): a key names one repository in prompts, evidence
// and collect; at most 7 extra repositories (8 directories in all).
export const repoKeySchema = z.string().regex(/^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/);
const additionalRepoSchema = z
  .object({
    key: repoKeySchema,
    repoPath: z.string().min(1),
    targetPaths: z.array(z.string()).min(1),
    allowlistPaths: z.array(z.string()).optional(),
    denylistPaths: z.array(z.string()).optional(),
    requiredChecks: z.array(z.string()).optional(),
  })
  .strict();
export type AdditionalRepo = z.infer<typeof additionalRepoSchema>;

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
        // Multi-repo runs (spec 2026-10-24-multi-dir-projects §11.1): optional, no default -- absent leaves the contract
        // byte-identical. repoKey names the primary (repoPath); each extra repository has its own key and paths.
        repoKey: repoKeySchema.optional(),
        additionalRepos: z.array(additionalRepoSchema).min(1).max(7).optional(),
      })
      .strict()
      .superRefine((context, issues) => {
        if ((context.repoKey === undefined) !== (context.additionalRepos === undefined)) {
          issues.addIssue({ code: z.ZodIssueCode.custom, message: "repoKey is present if and only if additionalRepos is" });
        }
        const keys = [context.repoKey, ...(context.additionalRepos ?? []).map((repo) => repo.key)];
        if (context.additionalRepos !== undefined && new Set(keys).size !== keys.length) {
          issues.addIssue({ code: z.ZodIssueCode.custom, message: "repository keys must be unique and differ from repoKey" });
        }
      }),
    executionPolicy: z
      .object({
        autonomyLevel: z.literal("L2"),
        maxAttempts: z.number().int().positive(),
        perAttemptTimeoutMs: z.number().int().positive(),
        totalRuntimeBudgetMs: z.number().int().positive(),
        tokenBudget: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        worktreeRequired: z.literal(true),
        partialOutcomeRecoveryWindowMs: z.number().int().nonnegative(),
        // Per-contract tool rules (spec 2026-10-22 §2): optional, no default -- absent leaves the contract byte-identical.
        toolRules: toolRulesSchema.optional(),
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
