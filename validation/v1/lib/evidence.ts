import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ExecutionRecovery } from "../../../src/runtime/types.js";
import type { ScenarioDefinition } from "./scenarios.js";

export type ArtifactStatus = "PRESENT" | "NOT_PRODUCED" | "NOT_RUN" | "MISSING" | "INVALID";

type ArtifactName = Exclude<keyof ScenarioDefinition["expectedArtifacts"], "requiredChecks">;

export type ArtifactRecord = {
  name: ArtifactName;
  status: ArtifactStatus;
  path?: string;
  sha256?: string;
  error?: string;
};

export type GitObservationInput = {
  before: {
    head: string;
    status: string;
  };
  after: {
    head: string;
    status: string;
  };
  worktreeList: string;
};

export type GitObservation = GitObservationInput & {
  mainCheckoutChanged: boolean;
};

export type EvidenceInput = {
  scenario: ScenarioDefinition;
  runDir: string;
  evidenceDir: string;
  invocation: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
    command: string[];
    exitCode: number;
    envNames: string[];
  };
  git: GitObservationInput;
  processes: {
    rootPid: number;
    observedDescendants: Array<{
      pid: number;
      ppid?: number;
      command: string;
    }>;
    survivorPids: number[];
    claudeChildExited: "YES" | "NO" | "NOT_OBSERVABLE";
  };
};

export type EvidenceRecord = {
  scenarioId: ScenarioDefinition["id"];
  invocation: EvidenceInput["invocation"];
  git: GitObservation;
  processes: EvidenceInput["processes"];
  artifacts: ArtifactRecord[];
  executionRecovery: {
    status: "PRESENT" | "MISSING" | "INVALID";
    path: string;
    value?: ExecutionRecovery;
    error?: string;
  };
  requiredChecks: {
    status: ArtifactStatus;
    error?: string;
  };
  observations: {
    loopContract: {
      status: "PRESENT" | "MISSING" | "INVALID";
      path: string;
      error?: string;
    };
    loopState: {
      status: "PRESENT" | "MISSING" | "INVALID";
      path: string;
      error?: string;
    };
    events: {
      status: "PRESENT" | "MISSING" | "INVALID";
      path: string;
      count: number;
      types?: string[];
      error?: string;
    };
    terminalOutcome: {
      status: string | null;
      stopReason: string | null;
      waitingOnHuman: boolean | null;
    };
    cleanupOutcome: {
      status: "WORKTREE_PRESENT" | "WORKTREE_REMOVED" | "CLEANUP_FAILED" | "UNKNOWN";
      detail: string;
    };
  };
};

export type Review = {
  scenarioVerdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  diagnosis: "PRODUCT_DEFECT" | "RUNTIME_VARIANCE" | "ENVIRONMENT_FAILURE" | "CONTRACT_GAP" | null;
  summary: string;
  reviewedAt: string;
};


export type DBoundaryClassification =
  | "PRE_EXECUTE_EXHAUSTION"
  | "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE"
  | "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE"
  | "BOUNDARY_UNRESOLVED";

type JsonObservation = {
  status: "PRESENT" | "MISSING" | "INVALID";
  path: string;
  error?: string;
};

type JsonReadResult = {
  observation: JsonObservation;
  value?: unknown;
};

type EventReadResult = {
  observation: {
    status: "PRESENT" | "MISSING" | "INVALID";
    path: string;
    count: number;
    types?: string[];
    error?: string;
  };
  entries: unknown[];
};

type ArtifactSpec = {
  name: ArtifactName;
  relativePath: string;
  kind: "json" | "text";
};

const artifactSpecs: ArtifactSpec[] = [
  { name: "plan", relativePath: join("attempts", "1", "plan.json"), kind: "json" },
  { name: "execution", relativePath: join("attempts", "1", "execution.json"), kind: "json" },
  { name: "verify", relativePath: join("attempts", "1", "verify.json"), kind: "json" },
  { name: "diff", relativePath: join("attempts", "1", "diff.patch"), kind: "text" },
  { name: "log", relativePath: join("attempts", "1", "stdout-stderr.log"), kind: "text" },
];

const reviewSchema = z
  .object({
    scenarioVerdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    diagnosis: z.enum(["PRODUCT_DEFECT", "RUNTIME_VARIANCE", "ENVIRONMENT_FAILURE", "CONTRACT_GAP"]).nullable(),
    summary: z.string().trim().min(1),
    reviewedAt: z.string().min(1),
  })
  .strict();

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRunDirRoot(runDir: string): Promise<string> {
  if (await pathExists(runDir)) {
    return await realpath(runDir);
  }

  return resolve(runDir);
}

function escapesRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation.startsWith("..") || isAbsolute(relation);
}

async function readContainedFile(
  runDirRoot: string,
  candidatePath: string,
): Promise<
  | { status: "MISSING"; path: string }
  | { status: "INVALID"; path: string; error: string }
  | { status: "PRESENT"; path: string; contents: string }
> {
  const resolvedCandidate = resolve(candidatePath);
  if (!(await pathExists(resolvedCandidate))) {
    return { status: "MISSING", path: resolvedCandidate };
  }

  try {
    const realCandidate = await realpath(resolvedCandidate);
    if (escapesRoot(runDirRoot, realCandidate)) {
      return {
        status: "INVALID",
        path: resolvedCandidate,
        error: `artifact path escapes runDir: ${resolvedCandidate}`,
      };
    }

    return {
      status: "PRESENT",
      path: realCandidate,
      contents: await readFile(realCandidate, "utf8"),
    };
  } catch (error) {
    return {
      status: "INVALID",
      path: resolvedCandidate,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readJsonObservation(runDirRoot: string, candidatePath: string): Promise<JsonReadResult> {
  const file = await readContainedFile(runDirRoot, candidatePath);
  if (file.status === "MISSING") {
    return { observation: { status: "MISSING", path: file.path } };
  }

  if (file.status === "INVALID") {
    return { observation: { status: "INVALID", path: file.path, error: file.error } };
  }

  try {
    return {
      observation: { status: "PRESENT", path: file.path },
      value: JSON.parse(file.contents) as unknown,
    };
  } catch (error) {
    return {
      observation: {
        status: "INVALID",
        path: file.path,
        error: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

async function readEventsObservation(runDirRoot: string, candidatePath: string): Promise<EventReadResult> {
  const file = await readContainedFile(runDirRoot, candidatePath);
  if (file.status === "MISSING") {
    return {
      observation: { status: "MISSING", path: file.path, count: 0 },
      entries: [],
    };
  }

  if (file.status === "INVALID") {
    return {
      observation: { status: "INVALID", path: file.path, count: 0, error: file.error },
      entries: [],
    };
  }

  const entries: unknown[] = [];
  const lines = file.contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as unknown);
    } catch (error) {
      return {
        observation: {
          status: "INVALID",
          path: file.path,
          count: entries.length,
          error: `events.jsonl line ${index + 1} parse error: ${error instanceof Error ? error.message : String(error)}`,
        },
        entries,
      };
    }
  }

  const types = entries
    .map((entry) => (entry && typeof entry === "object" ? (entry as { type?: unknown }).type : undefined))
    .filter((type): type is string => typeof type === "string");

  return {
    observation: { status: "PRESENT", path: file.path, count: entries.length, types },
    entries,
  };
}

function getExpectedArtifactStatus(
  expected: ScenarioDefinition["expectedArtifacts"][keyof ScenarioDefinition["expectedArtifacts"]],
  observedExists: boolean,
): ArtifactStatus {
  if (expected === "PRESENT") {
    return observedExists ? "PRESENT" : "MISSING";
  }

  return observedExists ? "INVALID" : expected;
}

async function buildArtifactRecord(
  runDirRoot: string,
  runDir: string,
  scenario: ScenarioDefinition,
  spec: ArtifactSpec,
): Promise<ArtifactRecord> {
  const expected = scenario.expectedArtifacts[spec.name];
  const candidatePath = join(runDir, spec.relativePath);
  const file = await readContainedFile(runDirRoot, candidatePath);

  if (file.status === "MISSING") {
    return {
      name: spec.name,
      status: getExpectedArtifactStatus(expected, false),
      path: file.path,
    };
  }

  if (file.status === "INVALID") {
    return {
      name: spec.name,
      status: "INVALID",
      path: file.path,
      error: file.error,
    };
  }

  if (expected !== "PRESENT") {
    return {
      name: spec.name,
      status: "INVALID",
      path: file.path,
      error: `artifact was present but scenario expected ${expected}`,
    };
  }

  if (spec.kind === "json") {
    try {
      JSON.parse(file.contents);
    } catch (error) {
      return {
        name: spec.name,
        status: "INVALID",
        path: file.path,
        error: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    name: spec.name,
    status: "PRESENT",
    path: file.path,
    sha256: await sha256File(file.path),
  };
}

function readDeclaredRequiredChecks(loopContractValue: unknown): string[] {
  if (!loopContractValue || typeof loopContractValue !== "object") {
    return [];
  }

  const verification = (loopContractValue as { verification?: unknown }).verification;
  if (!verification || typeof verification !== "object") {
    return [];
  }

  const requiredChecks = (verification as { requiredChecks?: unknown }).requiredChecks;
  if (!Array.isArray(requiredChecks)) {
    return [];
  }

  return requiredChecks.filter((entry): entry is string => typeof entry === "string");
}

function buildRequiredChecksRecord(
  scenario: ScenarioDefinition,
  verifyObservation: JsonReadResult,
  declaredRequiredChecks: string[],
): { status: ArtifactStatus; error?: string } {
  const expected = scenario.expectedArtifacts.requiredChecks;
  if (expected !== "PRESENT") {
    return { status: expected };
  }

  if (verifyObservation.observation.status === "MISSING") {
    return { status: "MISSING" };
  }

  if (verifyObservation.observation.status === "INVALID") {
    return { status: "INVALID", error: verifyObservation.observation.error };
  }

  const verifyValue = verifyObservation.value as { evidence?: unknown };
  const evidenceEntries = Array.isArray(verifyValue.evidence)
    ? verifyValue.evidence.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (declaredRequiredChecks.length === 0) {
    return evidenceEntries.some((entry) => entry.includes("required check ") || entry.includes("command output"))
      ? { status: "PRESENT" }
      : { status: "MISSING", error: "verify evidence did not include required check output" };
  }

  const missingChecks = declaredRequiredChecks.filter(
    (command) =>
      !evidenceEntries.some(
        (entry) => entry.includes(`required check passed: ${command}`) || entry.includes(`required check failed: ${command}`),
      ),
  );

  return missingChecks.length === 0
    ? { status: "PRESENT" }
    : {
        status: "MISSING",
        error: `missing required check evidence: ${missingChecks.join(", ")}`,
      };
}

function getAttemptNumber(loopStateValue: unknown): number {
  if (
    loopStateValue &&
    typeof loopStateValue === "object" &&
    typeof (loopStateValue as { currentAttempt?: unknown }).currentAttempt === "number"
  ) {
    const attempt = (loopStateValue as { currentAttempt: number }).currentAttempt;
    if (Number.isInteger(attempt) && attempt > 0) {
      return attempt;
    }
  }

  return 1;
}

async function getCleanupOutcome(
  runDir: string,
  attemptNumber: number,
  eventEntries: unknown[],
): Promise<EvidenceRecord["observations"]["cleanupOutcome"]> {
  const cleanupFailure = eventEntries.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "workspace_cleanup_failed",
  ) as { detail?: unknown } | undefined;

  if (cleanupFailure) {
    return {
      status: "CLEANUP_FAILED",
      detail: typeof cleanupFailure.detail === "string" ? cleanupFailure.detail : "workspace cleanup failed",
    };
  }

  const worktreePath = join(runDir, "worktrees", `attempt-${attemptNumber}`);
  return {
    status: (await pathExists(worktreePath)) ? "WORKTREE_PRESENT" : "WORKTREE_REMOVED",
    detail: worktreePath,
  };
}

function getArtifactStatusMap(record: EvidenceRecord): Partial<Record<ArtifactName, ArtifactStatus>> {
  return Object.fromEntries(record.artifacts.map((artifact) => [artifact.name, artifact.status])) as Partial<
    Record<ArtifactName, ArtifactStatus>
  >;
}

function getEventTypes(record: EvidenceRecord): string[] {
  return record.observations.events.status === "PRESENT" ? (record.observations.events.types ?? []) : [];
}

function hasContradictoryLayerAEvidence(
  record: EvidenceRecord,
  artifactStatus: Partial<Record<ArtifactName, ArtifactStatus>>,
  eventTypes: string[],
): boolean {
  const terminalStatus = record.observations.terminalOutcome.status;
  const hasExecutionArtifacts = artifactStatus.execution === "PRESENT" || artifactStatus.diff === "PRESENT" || artifactStatus.log === "PRESENT";
  const loopReachedExhaustion = eventTypes.includes("loop_exhausted") || terminalStatus === "exhausted";

  if (hasExecutionArtifacts && !eventTypes.includes("attempt_started")) {
    return true;
  }

  if (eventTypes.includes("execute_started") && !eventTypes.includes("attempt_started")) {
    return true;
  }

  if (eventTypes.includes("loop_exhausted") && terminalStatus !== null && terminalStatus !== "exhausted") {
    return true;
  }

  if (terminalStatus === "exhausted" && eventTypes.some((type) => type === "loop_failed" || type === "loop_succeeded")) {
    return true;
  }

  if (loopReachedExhaustion && record.observations.loopState.status !== "PRESENT") {
    return true;
  }

  return false;
}

function matchesPreExecuteExhaustion(
  record: EvidenceRecord,
  artifactStatus: Partial<Record<ArtifactName, ArtifactStatus>>,
  eventTypes: string[],
): boolean {
  const allowedEventTypes = new Set(["loop_planning", "loop_exhausted"]);

  return (
    artifactStatus.plan === "PRESENT" &&
    artifactStatus.execution === "NOT_PRODUCED" &&
    artifactStatus.diff === "NOT_PRODUCED" &&
    artifactStatus.log === "NOT_PRODUCED" &&
    record.observations.terminalOutcome.status === "exhausted" &&
    eventTypes.includes("loop_planning") &&
    eventTypes.includes("loop_exhausted") &&
    !eventTypes.includes("attempt_started") &&
    eventTypes.every((type) => allowedEventTypes.has(type))
  );
}

function hasSufficientRecoverableExecuteEvidence(record: EvidenceRecord, artifactStatus: Partial<Record<ArtifactName, ArtifactStatus>>): boolean {
  return artifactStatus.execution === "PRESENT" || record.executionRecovery.status === "PRESENT";
}

function hasPassShapeForRecoverableExecuteEvidence(record: EvidenceRecord, artifactStatus: Partial<Record<ArtifactName, ArtifactStatus>>): boolean {
  const executionRecovery = record.executionRecovery.status === "PRESENT" ? record.executionRecovery.value : undefined;

  return (
    executionRecovery?.executeEntered === true &&
    executionRecovery.worktreeDiffObserved === false &&
    executionRecovery.diffPatchCaptured === false &&
    executionRecovery.stdoutStderrLogCaptured === false &&
    executionRecovery.changedPathsObserved === null &&
    executionRecovery.captureStatus === "complete" &&
    executionRecovery.cleanupStatus === "removed" &&
    artifactStatus.plan === "PRESENT" &&
    artifactStatus.execution === "NOT_PRODUCED" &&
    artifactStatus.verify === "NOT_RUN" &&
    artifactStatus.diff === "NOT_PRODUCED" &&
    artifactStatus.log === "NOT_PRODUCED" &&
    record.requiredChecks.status === "NOT_RUN" &&
    record.observations.terminalOutcome.status === "exhausted" &&
    record.observations.cleanupOutcome.status === "WORKTREE_REMOVED"
  );
}

export function classifyDScenarioBoundary(record: EvidenceRecord): DBoundaryClassification {
  const eventTypes = getEventTypes(record);
  const artifactStatus = getArtifactStatusMap(record);

  if (record.observations.events.status !== "PRESENT" || record.observations.loopState.status !== "PRESENT") {
    return "BOUNDARY_UNRESOLVED";
  }

  if (hasContradictoryLayerAEvidence(record, artifactStatus, eventTypes)) {
    return "BOUNDARY_UNRESOLVED";
  }

  if (matchesPreExecuteExhaustion(record, artifactStatus, eventTypes)) {
    return "PRE_EXECUTE_EXHAUSTION";
  }

  if (eventTypes.includes("attempt_started") && eventTypes.includes("execute_started")) {
    return hasSufficientRecoverableExecuteEvidence(record, artifactStatus)
      ? "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE"
      : "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE";
  }

  if (eventTypes.includes("attempt_started")) {
    return "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE";
  }

  return "BOUNDARY_UNRESOLVED";
}

export function mapDBoundaryToReview(
  boundary: DBoundaryClassification,
  record: EvidenceRecord,
): Pick<Review, "scenarioVerdict" | "diagnosis"> {
  switch (boundary) {
    case "PRE_EXECUTE_EXHAUSTION":
      return { scenarioVerdict: "INCONCLUSIVE", diagnosis: "RUNTIME_VARIANCE" };
    case "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE":
      return { scenarioVerdict: "INCONCLUSIVE", diagnosis: "CONTRACT_GAP" };
    case "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE":
      return hasPassShapeForRecoverableExecuteEvidence(record, getArtifactStatusMap(record))
        ? { scenarioVerdict: "PASS", diagnosis: null }
        : { scenarioVerdict: "FAIL", diagnosis: "PRODUCT_DEFECT" };
    case "BOUNDARY_UNRESOLVED":
    default:
      return { scenarioVerdict: "INCONCLUSIVE", diagnosis: "CONTRACT_GAP" };
  }
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

export async function collectArtifacts(input: { scenario: ScenarioDefinition; runDir: string }): Promise<ArtifactRecord[]> {
  const runDirRoot = await resolveRunDirRoot(input.runDir);
  return await Promise.all(artifactSpecs.map((spec) => buildArtifactRecord(runDirRoot, input.runDir, input.scenario, spec)));
}

export async function collectGitObservation(input: GitObservationInput): Promise<GitObservation> {
  return {
    before: { ...input.before },
    after: { ...input.after },
    worktreeList: input.worktreeList,
    mainCheckoutChanged: input.before.head !== input.after.head || input.before.status !== input.after.status,
  };
}

export async function collectEvidence(input: EvidenceInput): Promise<EvidenceRecord> {
  await mkdir(input.evidenceDir, { recursive: true });
  const runDirRoot = await resolveRunDirRoot(input.runDir);

  const [artifacts, loopContract, loopState, events, verifyObservation, executionRecoveryObservation, git] = await Promise.all([
    collectArtifacts({ scenario: input.scenario, runDir: input.runDir }),
    readJsonObservation(runDirRoot, join(input.runDir, "loop-contract.json")),
    readJsonObservation(runDirRoot, join(input.runDir, "loop-state.json")),
    readEventsObservation(runDirRoot, join(input.runDir, "events.jsonl")),
    readJsonObservation(runDirRoot, join(input.runDir, "attempts", "1", "verify.json")),
    readJsonObservation(runDirRoot, join(input.runDir, "attempts", "1", "execution-recovery.json")),
    collectGitObservation(input.git),
  ]);

  const loopStateValue = loopState.value as { status?: unknown; stopReason?: unknown; waitingOnHuman?: unknown } | undefined;
  const attemptNumber = getAttemptNumber(loopState.value);
  const requiredChecks = buildRequiredChecksRecord(input.scenario, verifyObservation, readDeclaredRequiredChecks(loopContract.value));
  const cleanupOutcome = await getCleanupOutcome(input.runDir, attemptNumber, events.entries);

  const evidence: EvidenceRecord = {
    scenarioId: input.scenario.id,
    invocation: {
      ...input.invocation,
      command: [...input.invocation.command],
      envNames: [...input.invocation.envNames],
    },
    git,
    processes: {
      ...input.processes,
      observedDescendants: input.processes.observedDescendants.map((entry) => ({ ...entry })),
      survivorPids: [...input.processes.survivorPids],
    },
    artifacts,
    requiredChecks,
    executionRecovery: {
      status: executionRecoveryObservation.observation.status,
      path: executionRecoveryObservation.observation.path,
      value:
        executionRecoveryObservation.observation.status === "PRESENT"
          ? (executionRecoveryObservation.value as ExecutionRecovery)
          : undefined,
      error: executionRecoveryObservation.observation.error,
    },
    observations: {
      loopContract: loopContract.observation,
      loopState: loopState.observation,
      events: events.observation,
      terminalOutcome: {
        status: typeof loopStateValue?.status === "string" ? loopStateValue.status : null,
        stopReason: typeof loopStateValue?.stopReason === "string" ? loopStateValue.stopReason : null,
        waitingOnHuman: typeof loopStateValue?.waitingOnHuman === "boolean" ? loopStateValue.waitingOnHuman : null,
      },
      cleanupOutcome,
    },
  };

  await Promise.all([
    writeFile(join(input.evidenceDir, "invocation.json"), `${JSON.stringify(evidence.invocation, null, 2)}\n`),
    writeFile(
      join(input.evidenceDir, "artifacts.json"),
      `${JSON.stringify({ artifacts: evidence.artifacts, requiredChecks: evidence.requiredChecks }, null, 2)}\n`,
    ),
    writeFile(join(input.evidenceDir, "git.json"), `${JSON.stringify(evidence.git, null, 2)}\n`),
    writeFile(join(input.evidenceDir, "processes.json"), `${JSON.stringify(evidence.processes, null, 2)}\n`),
    writeFile(join(input.evidenceDir, "observations.json"), `${JSON.stringify(evidence.observations, null, 2)}\n`),
  ]);

  return evidence;
}

export function validateReview(review: unknown): Review {
  return reviewSchema.parse(review);
}
