import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { buildUsageEvidence, createLineSplitter, createUsageObserver, writeObservation } from "./claude-stream.mjs";

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

// Orca paid claude round (2026-09-27): the Anthropic API takes this schema as a tool's input_schema, which must
// have `type: "object"` at the top. The earlier top-level `oneOf` of the complete and the partial shapes was refused
// as "400 tools.N.custom.input_schema.type: Field required" on every execute call (claude 2.1.283, claude-opus-5-5).
// One object carries both shapes; the partial shape's rule -- completionStatus comes with failureType and
// failureMessage -- is checked in code on the answer (partialExecutionRuleBroken below).
const EXECUTION_SCHEMA = {
  type: "object",
  properties: {
    changedFiles: { type: "array", items: { type: "string" } },
    diffPatch: { type: "string" },
    commandOutputs: { type: "array", items: { type: "string" } },
    stdoutStderrLog: { type: "string" },
    completionStatus: { type: "string", enum: ["partial"] },
    failureType: { type: "string", enum: ["timeout", "error"] },
    failureMessage: { type: "string" },
  },
  required: ["changedFiles", "diffPatch", "commandOutputs", "stdoutStderrLog"],
  additionalProperties: false,
};

/** Null when an execute answer is a complete one or a well-formed partial one; otherwise what is wrong with it. */
function partialExecutionRuleBroken(structured) {
  const partialFields = ["completionStatus", "failureType", "failureMessage"].filter((field) => Object.prototype.hasOwnProperty.call(structured, field));
  if (partialFields.length === 0) return null;
  if (structured.completionStatus !== "partial") return "completionStatus must be \"partial\" when any partial field is given";
  if (structured.failureType !== "timeout" && structured.failureType !== "error") return "a partial answer needs failureType timeout or error";
  if (typeof structured.failureMessage !== "string") return "a partial answer needs a failureMessage";
  return null;
}

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

// Orca agent selection (2026-09-26), spec §4.7 and §12 I14: ClaudeAgentAdapter names the claude binary and
// the extra arguments (`--model <model>[1m]`) as JSON arrays in these two variables, never as a
// whitespace-split string. Unset, the runner behaves exactly as before: `claude` from PATH, no extra argument.
function readArgvEnv(name, fallback, requireCommand) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`claude-runner-env-invalid: ${name} is not JSON`);
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || (requireCommand && (value.length === 0 || value[0] === ""))) {
    throw new Error(`claude-runner-env-invalid: ${name} must be a JSON array of strings${requireCommand ? " naming a command" : ""}`);
  }

  return value;
}

// Agent selection (2026-09-26), wave-1 review I-1: CCLOOP_CLAUDE_COMMAND/_EXTRA_ARGS are this runner's own input. The claude
// CLI, and everything it starts, gets the rest of the environment unchanged but never these two, so a runner nested
// under it resolves its own `claude` instead of inheriting the outer installation.
// Orca claude stream usage (2026-09-27): so is the observation path the adapter hands this runner.
function claudeEnv() {
  const { CCLOOP_CLAUDE_COMMAND: _command, CCLOOP_CLAUDE_EXTRA_ARGS: _extraArgs, CCLOOP_CLAUDE_OBSERVED_USAGE_PATH: _observedUsagePath, ...env } = process.env;
  return env;
}

// Orca paid claude round (2026-09-27): with `-p --output-format json` claude reports an API error in the envelope on
// stdout, so a failure message built from stderr alone lost the cause (a 400 left only a stdin warning behind). Both
// streams are kept, each cut to its last FAILURE_OUTPUT_TAIL characters.
const FAILURE_OUTPUT_TAIL = 8192;

function outputTail(text, length = text.length) {
  const kept = text.slice(-FAILURE_OUTPUT_TAIL);
  return length > FAILURE_OUTPUT_TAIL ? `[${length - FAILURE_OUTPUT_TAIL} earlier characters dropped]${kept}` : kept;
}

function failureMessage(code, stdout, stderr) {
  return [
    `claude exited with code ${code}`,
    stderr ? `stderr: ${outputTail(stderr)}` : null,
    stdout.length > 0 ? `stdout: ${outputTail(stdout.tail, stdout.length)}` : null,
  ].filter((line) => line !== null).join("\n");
}

async function runClaude(request, claudeCommand, extraArgs) {
  const schema = getSchemaForPhase(request.phase);
  // Orca claude stream usage (2026-09-27), spec §3.1: stream-json with partial messages, so the usage claude spends is
  // seen as it streams and survives an abort. Read line by line and never kept whole: the stream is several times the
  // size of the json envelope and echoes tool results (spec §2.2 item 8), so the old 10 MiB buffer could fail a long
  // execute. Kept: the result line, the observation, and the last FAILURE_OUTPUT_TAIL characters for failures (B2).
  const child = spawn(
    claudeCommand[0],
    [...claudeCommand.slice(1), "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(schema), ...extraArgs, request.prompt],
    { cwd: request.worktreePath, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] },
  );

  // Orca paid claude round (2026-09-27): the prompt is an argument, so claude reads nothing from stdin; left open, the
  // pipe made every call wait 3 s ("no stdin data received in 3s, proceeding without it").
  child.stdin?.end();
  trackClaudeProcessClose(child);
  currentClaudeProcess = child;
  const observationPath = process.env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH;
  const observer = createUsageObserver();
  let resultEvent = null;
  let fallbackEnvelope = null;
  const splitter = createLineSplitter((line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event && event.type === "result") { resultEvent = event; return; }
    // Orca claude stream usage (2026-09-27): real claude's json envelope and its stream's result event both carry
    // type "result"; the older SubprocessClaudeAdapter criteria's stand-ins print a bare {structured_output, usage}
    // line, still accepted so they keep testing what they test.
    if (event && typeof event === "object" && !Array.isArray(event) && Object.prototype.hasOwnProperty.call(event, "structured_output")) {
      fallbackEnvelope = event;
    }
    if (observer.observe(event) && observationPath) {
      const snapshot = observer.snapshot();
      if (snapshot.total !== null) {
        try { writeObservation(observationPath, snapshot); } catch (error) { process.stderr.write(`claude-runner: observation not written: ${String(error)}\n`); }
      }
    }
  });

  try {
    return await new Promise((resolve, reject) => {
      let stdoutTail = "", stdoutLength = 0, stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutLength += chunk.length;
        stdoutTail = (stdoutTail + chunk).slice(-FAILURE_OUTPUT_TAIL);
        splitter.push(chunk);
      });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        splitter.end();
        if (code !== 0) { reject(new Error(failureMessage(code, { tail: stdoutTail, length: stdoutLength }, stderr))); return; }
        resolve({ envelope: resultEvent ?? fallbackEnvelope, stderr });
      });
    });
  } finally {
    currentClaudeProcess = null;
  }
}

async function main() {
  let claudeCommand;
  let extraArgs;
  try {
    claudeCommand = readArgvEnv("CCLOOP_CLAUDE_COMMAND", ["claude"], true);
    extraArgs = readArgvEnv("CCLOOP_CLAUDE_EXTRA_ARGS", [], false);
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const request = await readStdin();
  currentRequest = request;

  try {
    const result = await runClaude(request, claudeCommand, extraArgs);
    const envelope = result.envelope;
    if (envelope === null) throw new Error("Claude CLI did not return structured_output");
    const structured = envelope.structured_output;

    if (!structured || typeof structured !== "object") {
      throw new Error("Claude CLI did not return structured_output");
    }
    const broken = request.phase === "execute" ? partialExecutionRuleBroken(structured) : null;
    if (broken !== null) {
      throw new Error(`claude-execute-partial-incomplete: ${broken}`);
    }

    const usageEvidence = buildUsageEvidence(envelope);
    const response = usageEvidence.normalizedTotal === null
      ? { ...structured, usageEvidence }
      : { ...structured, usageEvidence, tokenUsage: usageEvidence.normalizedTotal };
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
