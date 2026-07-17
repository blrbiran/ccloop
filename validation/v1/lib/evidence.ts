import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
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

  return {
    observation: { status: "PRESENT", path: file.path, count: entries.length },
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

  const [artifacts, loopContract, loopState, events, verifyObservation, git] = await Promise.all([
    collectArtifacts({ scenario: input.scenario, runDir: input.runDir }),
    readJsonObservation(runDirRoot, join(input.runDir, "loop-contract.json")),
    readJsonObservation(runDirRoot, join(input.runDir, "loop-state.json")),
    readEventsObservation(runDirRoot, join(input.runDir, "events.jsonl")),
    readJsonObservation(runDirRoot, join(input.runDir, "attempts", "1", "verify.json")),
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
