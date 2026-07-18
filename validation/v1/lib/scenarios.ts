import { V1_TERMINAL_STATES, loopContractSchema, type LoopContract } from "../../../src/contract/schema.js";

export type ScenarioId = "A" | "B" | "C" | "D" | "E";
export type ArtifactExpectation = "PRESENT" | "NOT_PRODUCED" | "NOT_RUN";
export type ScenarioDefinition = {
  id: ScenarioId;
  goal: string;
  expectedArtifacts: Record<"plan" | "execution" | "verify" | "diff" | "log" | "requiredChecks", ArtifactExpectation>;
};

export type ExecutionPolicyOverrides = Partial<
  Pick<
    LoopContract["executionPolicy"],
    | "tokenBudget"
    | "perAttemptTimeoutMs"
    | "totalRuntimeBudgetMs"
    | "partialOutcomeRecoveryWindowMs"
  >
>;

type RenderOptions = {
  repoPath: string;
  timeoutMs?: number;
  executionPolicyOverrides?: ExecutionPolicyOverrides;
};

type ScenarioSpec = ScenarioDefinition & {
  successCondition: string;
  nonGoals: string[];
  targetPaths: string[];
  buildTestCommands: string[];
  constraints: string[];
  allowlistPaths: string[];
  denylistPaths: string[];
  maxFilesTouched: number;
  humanGateConditions: string[];
  verifierType: "command" | "agent";
  requiredChecks: string[];
  evidenceRequired: string[];
};

const DEFAULT_REQUIRED_CHECKS = ["npm test"];
const DEFAULT_BUILD_TEST_COMMANDS = ["npm test"];
const DEFAULT_REJECT_ON = ["required check failed"];
const DEFAULT_MAX_FILES_TOUCHED = 10;
const DEFAULT_EXECUTION_POLICY = {
  autonomyLevel: "L2" as const,
  maxAttempts: 1,
  perAttemptTimeoutMs: 300000,
  totalRuntimeBudgetMs: 600000,
  tokenBudget: 50000,
  worktreeRequired: true as const,
  partialOutcomeRecoveryWindowMs: 3000,
};

export const SCENARIO_IDS = ["A", "B", "C", "D", "E"] as const;

const scenarioCatalog: Record<ScenarioId, ScenarioSpec> = {
  A: {
    id: "A",
    goal: "Add previous(value) to src/counter.js, add a deterministic test in test/counter.test.js, and keep npm test passing.",
    successCondition: "previous(value) is implemented, deterministic coverage is added, and npm test passes.",
    nonGoals: ["Do not modify files outside src/ and test/."],
    targetPaths: ["src/counter.js", "test/counter.test.js"],
    buildTestCommands: DEFAULT_BUILD_TEST_COMMANDS,
    constraints: [
      "Edit only src/counter.js and test/counter.test.js.",
      "Preserve the existing deterministic fixture behavior.",
    ],
    allowlistPaths: ["src/**", "test/**"],
    denylistPaths: [],
    maxFilesTouched: DEFAULT_MAX_FILES_TOUCHED,
    humanGateConditions: [],
    verifierType: "agent",
    requiredChecks: DEFAULT_REQUIRED_CHECKS,
    evidenceRequired: ["command output"],
    expectedArtifacts: {
      plan: "PRESENT",
      execution: "PRESENT",
      verify: "PRESENT",
      diff: "PRESENT",
      log: "PRESENT",
      requiredChecks: "PRESENT",
    },
  },
  B: {
    id: "B",
    goal: "Create restricted.txt containing gate probe.",
    successCondition: "restricted.txt contains exactly gate probe.",
    nonGoals: ["Do not modify any file besides restricted.txt."],
    targetPaths: ["restricted.txt"],
    buildTestCommands: DEFAULT_BUILD_TEST_COMMANDS,
    constraints: [
      "Write exactly gate probe to restricted.txt.",
      "restricted.txt is intentionally denylisted and should trigger a human gate before verification.",
    ],
    allowlistPaths: ["restricted.txt"],
    denylistPaths: ["restricted.txt"],
    maxFilesTouched: DEFAULT_MAX_FILES_TOUCHED,
    humanGateConditions: [],
    verifierType: "agent",
    requiredChecks: DEFAULT_REQUIRED_CHECKS,
    evidenceRequired: [],
    expectedArtifacts: {
      plan: "PRESENT",
      execution: "PRESENT",
      verify: "NOT_RUN",
      diff: "PRESENT",
      log: "PRESENT",
      requiredChecks: "NOT_RUN",
    },
  },
  C: {
    id: "C",
    goal: "Create src/partial-note.txt, then add sumTo(value) to src/counter.js, then run npm test and inspect the result.",
    successCondition: "Partial progress is recoverable if the attempt is interrupted after creating src/partial-note.txt and editing src/counter.js.",
    nonGoals: ["Do not edit files outside src/."],
    targetPaths: ["src/partial-note.txt", "src/counter.js"],
    buildTestCommands: DEFAULT_BUILD_TEST_COMMANDS,
    constraints: [
      "Create src/partial-note.txt before changing src/counter.js.",
      "Run npm test and inspect the result after the code changes.",
      "The execute timeout is supplied by the operator.",
    ],
    allowlistPaths: ["src/**"],
    denylistPaths: [],
    maxFilesTouched: DEFAULT_MAX_FILES_TOUCHED,
    humanGateConditions: [],
    verifierType: "agent",
    requiredChecks: DEFAULT_REQUIRED_CHECKS,
    evidenceRequired: [],
    expectedArtifacts: {
      plan: "PRESENT",
      execution: "PRESENT",
      verify: "NOT_RUN",
      diff: "PRESENT",
      log: "PRESENT",
      requiredChecks: "NOT_RUN",
    },
  },
  D: {
    id: "D",
    goal: "Inspect and reason through the fixture before changing src/counter.js.",
    successCondition: "The attempt records a plan and enters execute after inspecting the fixture, even if the operator timeout interrupts execute before a reported result.",
    nonGoals: ["Do not claim that no worktree change occurred if execute is interrupted."],
    targetPaths: ["src/counter.js"],
    buildTestCommands: DEFAULT_BUILD_TEST_COMMANDS,
    constraints: [
      "Inspect the repository before editing src/counter.js.",
      "Use the operator-supplied execute timeout boundary.",
      "Do not claim that no worktree change occurred if execute is interrupted.",
    ],
    allowlistPaths: ["src/**"],
    denylistPaths: [],
    maxFilesTouched: DEFAULT_MAX_FILES_TOUCHED,
    humanGateConditions: [],
    verifierType: "agent",
    requiredChecks: DEFAULT_REQUIRED_CHECKS,
    evidenceRequired: [],
    expectedArtifacts: {
      plan: "PRESENT",
      execution: "NOT_PRODUCED",
      verify: "NOT_RUN",
      diff: "NOT_PRODUCED",
      log: "NOT_PRODUCED",
      requiredChecks: "NOT_RUN",
    },
  },
  E: {
    id: "E",
    goal: "Change next(1) to return 3 in src/counter.js without modifying tests.",
    successCondition: "src/counter.js is changed so next(1) returns 3 while the unchanged deterministic test fails under npm test.",
    nonGoals: ["Do not modify test/counter.test.js."],
    targetPaths: ["src/counter.js"],
    buildTestCommands: DEFAULT_BUILD_TEST_COMMANDS,
    constraints: [
      "Only edit src/counter.js.",
      "Do not modify tests.",
      "Expect npm test to fail against the unchanged deterministic test.",
    ],
    allowlistPaths: ["src/**"],
    denylistPaths: ["test/**"],
    maxFilesTouched: DEFAULT_MAX_FILES_TOUCHED,
    humanGateConditions: [],
    verifierType: "agent",
    requiredChecks: DEFAULT_REQUIRED_CHECKS,
    evidenceRequired: [],
    expectedArtifacts: {
      plan: "PRESENT",
      execution: "PRESENT",
      verify: "PRESENT",
      diff: "PRESENT",
      log: "PRESENT",
      requiredChecks: "PRESENT",
    },
  },
};

function resolveTimeoutMs(id: ScenarioId, timeoutMs?: number): number {
  if (id !== "C" && id !== "D") {
    return DEFAULT_EXECUTION_POLICY.perAttemptTimeoutMs;
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) {
    throw new Error(`scenario ${id} requires timeoutMs to be a positive integer`);
  }

  return timeoutMs;
}

function buildExecutionPolicy(
  id: ScenarioId,
  timeoutMs?: number,
  executionPolicyOverrides: ExecutionPolicyOverrides = {},
): LoopContract["executionPolicy"] {
  const perAttemptTimeoutMs =
    executionPolicyOverrides.perAttemptTimeoutMs ?? resolveTimeoutMs(id, timeoutMs);

  return {
    ...DEFAULT_EXECUTION_POLICY,
    ...executionPolicyOverrides,
    perAttemptTimeoutMs,
  };
}

export function getScenario(id: ScenarioId): ScenarioDefinition {
  const scenario = scenarioCatalog[id];
  return {
    id: scenario.id,
    goal: scenario.goal,
    expectedArtifacts: { ...scenario.expectedArtifacts },
  };
}

export function renderScenario(id: ScenarioId, options: RenderOptions): LoopContract {
  const scenario = scenarioCatalog[id];

  return loopContractSchema.parse({
    objective: {
      taskId: `validation-v1-${id}`,
      goal: scenario.goal,
      successCondition: scenario.successCondition,
      nonGoals: [...scenario.nonGoals],
    },
    context: {
      repoPath: options.repoPath,
      targetPaths: [...scenario.targetPaths],
      relevantDocs: [],
      buildTestCommands: [...scenario.buildTestCommands],
      constraints: [...scenario.constraints],
    },
    executionPolicy: buildExecutionPolicy(id, options.timeoutMs, options.executionPolicyOverrides),
    safetyPolicy: {
      allowlistPaths: [...scenario.allowlistPaths],
      denylistPaths: [...scenario.denylistPaths],
      maxFilesTouched: scenario.maxFilesTouched,
      humanGateConditions: [...scenario.humanGateConditions],
    },
    verification: {
      verifierType: scenario.verifierType,
      requiredChecks: [...scenario.requiredChecks],
      rejectOn: [...DEFAULT_REJECT_ON],
      evidenceRequired: [...scenario.evidenceRequired],
    },
    escalationAndExit: {
      escalationTargets: ["human"],
      pauseOn: [],
      stopOn: [],
      terminalStates: [...V1_TERMINAL_STATES],
    },
  });
}
