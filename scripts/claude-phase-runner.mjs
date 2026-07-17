import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLAUDE_TERMINATION_GRACE_MS = 250;
const DEFAULT_PARTIAL_OUTCOME_RECOVERY_WINDOW_MS = 1000;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    primaryTargetPaths: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "primaryTargetPaths"],
  additionalProperties: false,
};

const EXECUTION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        changedFiles: { type: "array", items: { type: "string" } },
        diffPatch: { type: "string" },
        commandOutputs: { type: "array", items: { type: "string" } },
        stdoutStderrLog: { type: "string" },
      },
      required: ["changedFiles", "diffPatch", "commandOutputs", "stdoutStderrLog"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        completionStatus: { const: "partial" },
        failureType: { enum: ["timeout", "error"] },
        failureMessage: { type: "string" },
        changedFiles: { type: "array", items: { type: "string" } },
        diffPatch: { type: "string" },
        commandOutputs: { type: "array", items: { type: "string" } },
        stdoutStderrLog: { type: "string" },
      },
      required: [
        "completionStatus",
        "failureType",
        "failureMessage",
        "changedFiles",
        "diffPatch",
        "commandOutputs",
        "stdoutStderrLog",
      ],
      additionalProperties: false,
    },
  ],
};

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    rejectCategory: { type: "string" },
    primaryTargetPaths: { type: "array", items: { type: "string" } },
    failingCommand: { anyOf: [{ type: "string" }, { type: "null" }] },
    safeToRetry: { type: "boolean" },
    evidence: { type: "array", items: { type: "string" } },
    pauseSignals: { type: "array", items: { type: "string" } },
    stopSignals: { type: "array", items: { type: "string" } },
  },
  required: [
    "approved",
    "rejectCategory",
    "primaryTargetPaths",
    "failingCommand",
    "safeToRetry",
    "evidence",
    "pauseSignals",
    "stopSignals",
  ],
  additionalProperties: false,
};

function getSchemaForPhase(phase) {
  if (phase === "plan") {
    return PLAN_SCHEMA;
  }

  if (phase === "execute") {
    return EXECUTION_SCHEMA;
  }

  return VERIFY_SCHEMA;
}

function getTokenUsage(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return undefined;
  }

  const usage = envelope.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const input = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : Number.isFinite(usage.inputTokens)
      ? usage.inputTokens
      : undefined;
  const output = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : Number.isFinite(usage.outputTokens)
      ? usage.outputTokens
      : undefined;
  const candidates = [input, output].filter((value) => Number.isFinite(value));
  const total = candidates.reduce((sum, value) => sum + value, 0);

  return candidates.length > 0 && total > 0 ? total : undefined;
}

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk.toString();
  }
  return JSON.parse(body);
}

function getPartialOutcomeRecoveryWindowMs(request) {
  if (!request || request.phase !== "execute") {
    return CLAUDE_TERMINATION_GRACE_MS;
  }

  const recoveryWindowMs = request.partialOutcomeRecoveryWindowMs;
  if (typeof recoveryWindowMs === "number" && Number.isFinite(recoveryWindowMs) && recoveryWindowMs >= 0) {
    return recoveryWindowMs;
  }

  return DEFAULT_PARTIAL_OUTCOME_RECOVERY_WINDOW_MS;
}

function parsePorcelainEntries(stdout) {
  const records = stdout.split("\0").filter(Boolean);
  const entries = [];

  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length > 0) {
      entries.push({ status, path });
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }

  return entries;
}

async function readPorcelainEntries(worktreePath) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: worktreePath,
    });
    return parsePorcelainEntries(stdout);
  } catch {
    return [];
  }
}

function listChangedFiles(porcelainEntries) {
  return [...new Set(porcelainEntries.map((entry) => entry.path))];
}

async function readGitDiff(args, worktreePath) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error?.code === 1 || error?.code === "1") {
      if (typeof error.stdout === "string") {
        return error.stdout;
      }

      if (Buffer.isBuffer(error.stdout)) {
        return error.stdout.toString();
      }
    }

    return "";
  }
}

async function readDiffPatch(worktreePath, porcelainEntries) {
  const untrackedFiles = porcelainEntries.filter((entry) => entry.status === "??").map((entry) => entry.path);
  const [trackedDiff, untrackedDiffs] = await Promise.all([
    readGitDiff(["diff", "--no-ext-diff", "HEAD"], worktreePath),
    Promise.all(
      untrackedFiles.map((path) =>
        readGitDiff(["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", path], worktreePath),
      ),
    ),
  ]);

  return [trackedDiff, ...untrackedDiffs].filter((patch) => patch.length > 0).join("");
}

const claudeProcessClosedSymbol = Symbol("claudeProcessClosed");
const claudeProcessClosePromiseSymbol = Symbol("claudeProcessClosePromise");

function trackClaudeProcessClose(child) {
  child[claudeProcessClosedSymbol] = false;
  child[claudeProcessClosePromiseSymbol] = new Promise((resolve) => {
    child.once("close", () => {
      child[claudeProcessClosedSymbol] = true;
      resolve();
    });
  });
}

function waitForClaudeProcessClose(child) {
  if (!child) {
    return Promise.resolve();
  }

  if (child[claudeProcessClosedSymbol] === true) {
    return Promise.resolve();
  }

  return child[claudeProcessClosePromiseSymbol] ?? Promise.resolve();
}

async function terminateClaudeProcess(recoveryWindowMs) {
  const child = currentClaudeProcess;
  if (!child) {
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForClaudeProcessClose(child);
    return;
  }

  child.kill("SIGTERM");

  const terminated = await Promise.race([
    waitForClaudeProcessClose(child).then(() => true),
    new Promise((resolve) => {
      setTimeout(() => resolve(false), recoveryWindowMs);
    }),
  ]);

  if (!terminated && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForClaudeProcessClose(child);
  }
}

async function buildPartialExecutionOutcome(request, failureType, failureMessage, commandOutputs, stdoutStderrLog) {
  const porcelainEntries = await readPorcelainEntries(request.worktreePath);
  const changedFiles = listChangedFiles(porcelainEntries);
  const diffPatch = await readDiffPatch(request.worktreePath, porcelainEntries);

  if (changedFiles.length === 0 && diffPatch.length === 0) {
    return null;
  }

  return {
    completionStatus: "partial",
    failureType,
    failureMessage,
    changedFiles,
    diffPatch,
    commandOutputs,
    stdoutStderrLog,
  };
}

async function writeJsonToStdout(value) {
  const payload = JSON.stringify(value);

  if (!process.stdout.write(payload)) {
    await once(process.stdout, "drain");
  }
}

let currentRequest = null;
let currentClaudeProcess = null;
let interruptHandled = false;

async function handleInterrupt(signal) {
  if (interruptHandled) {
    return;
  }

  interruptHandled = true;
  const child = currentClaudeProcess;
  const childHadExited = child !== null && (child.exitCode !== null || child.signalCode !== null);
  await terminateClaudeProcess(getPartialOutcomeRecoveryWindowMs(currentRequest));

  if (childHadExited && child?.exitCode === 0 && child.signalCode === null) {
    return;
  }

  if (currentRequest?.phase === "execute") {
    const partial = await buildPartialExecutionOutcome(
      currentRequest,
      "timeout",
      `claude phase runner interrupted by ${signal}`,
      [],
      `claude phase runner interrupted by ${signal}`,
    );

    if (partial !== null) {
      try {
        await writeJsonToStdout(partial);
        process.exit(0);
      } catch (error) {
        process.stderr.write(String(error));
        process.exit(1);
      }
      return;
    }

    process.exit(1);
    return;
  }

  process.exit(128);
}

process.on("SIGTERM", () => {
  void handleInterrupt("SIGTERM");
});

process.on("SIGINT", () => {
  void handleInterrupt("SIGINT");
});

async function runClaude(request) {
  const schema = getSchemaForPhase(request.phase);
  const child = execFile(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      request.prompt,
    ],
    {
      cwd: request.worktreePath,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    },
  );

  trackClaudeProcessClose(child);
  currentClaudeProcess = child;

  try {
    const result = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `claude exited with code ${code}`));
          return;
        }

        resolve({ stdout, stderr });
      });
    });

    return result;
  } finally {
    currentClaudeProcess = null;
  }
}

async function main() {
  const request = await readStdin();
  currentRequest = request;

  try {
    const result = await runClaude(request);
    const envelope = JSON.parse(result.stdout);
    const structured = envelope.structured_output;

    if (!structured || typeof structured !== "object") {
      throw new Error("Claude CLI did not return structured_output");
    }

    const tokenUsage = getTokenUsage(envelope);
    const response = tokenUsage === undefined ? structured : { ...structured, tokenUsage };
    await writeJsonToStdout(response);
  } catch (error) {
    if (interruptHandled) {
      return;
    }

    if (request.phase === "execute") {
      const partial = await buildPartialExecutionOutcome(request, "error", String(error), [], String(error));
      if (partial !== null) {
        await writeJsonToStdout(partial);
        return;
      }
    }

    process.stderr.write(String(error));
    process.exitCode = 1;
  }
}

void main();
