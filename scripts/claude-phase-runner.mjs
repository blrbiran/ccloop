import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLAUDE_TERMINATION_GRACE_MS = 250;

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

  const candidates = [usage.input_tokens, usage.output_tokens, usage.inputTokens, usage.outputTokens]
    .filter((value) => typeof value === "number");
  const total = candidates.reduce((sum, value) => sum + value, 0);

  return total > 0 ? total : undefined;
}

async function readStdin() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk.toString();
  }
  return JSON.parse(body);
}

async function listChangedFiles(worktreePath) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: worktreePath });
    return stdout
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readDiffPatch(worktreePath) {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "HEAD"], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

function waitForClaudeProcessClose(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
}

async function terminateClaudeProcess() {
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
      setTimeout(() => resolve(false), CLAUDE_TERMINATION_GRACE_MS);
    }),
  ]);

  if (!terminated && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForClaudeProcessClose(child);
  }
}

async function buildPartialExecutionOutcome(request, failureType, failureMessage, commandOutputs, stdoutStderrLog) {
  const changedFiles = await listChangedFiles(request.worktreePath);
  const diffPatch = await readDiffPatch(request.worktreePath);

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

let currentRequest = null;
let currentClaudeProcess = null;
let interruptHandled = false;

async function handleInterrupt(signal) {
  if (interruptHandled) {
    return;
  }

  interruptHandled = true;
  await terminateClaudeProcess();

  if (currentRequest?.phase === "execute") {
    const partial = await buildPartialExecutionOutcome(
      currentRequest,
      "timeout",
      `claude phase runner interrupted by ${signal}`,
      [],
      `claude phase runner interrupted by ${signal}`,
    );

    if (partial !== null) {
      process.stdout.write(JSON.stringify(partial));
      process.exit(0);
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
    process.stdout.write(JSON.stringify(response));
  } catch (error) {
    if (interruptHandled) {
      return;
    }

    if (request.phase === "execute") {
      const partial = await buildPartialExecutionOutcome(request, "error", String(error), [], String(error));
      if (partial !== null) {
        process.stdout.write(JSON.stringify(partial));
        return;
      }
    }

    process.stderr.write(String(error));
    process.exitCode = 1;
  }
}

void main();
