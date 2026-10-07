import { execFile, spawn } from "node:child_process";
import { Socket } from "node:net";
import { promisify } from "node:util";
import { buildModelUsage, buildUsageEvidence, createLineSplitter, createUsageObserver, writeObservation } from "./claude-stream.mjs";

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
  // Orca ruling 26 (session c85d2c4e, 2026-09-28), measured: decoding each Buffer chunk on its own split a multi-byte
  // character at a chunk boundary into U+FFFD, so a non-ASCII prompt over ~64 KiB reached claude altered. Decode as the
  // stream (as claude's stdout below already is).
  process.stdin.setEncoding("utf8");
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
    // Crash resume (2026-10-02), spec §5.1 (R-B): this partial is the runner's own, not claude's answer; runLoop
    // keeps today's terminal decision for it instead of sending it to verify.
    partialOrigin: "runner",
  };
}

// Resolves once the payload has left the process, not once it is queued: on macOS a pipe write is asynchronous, and the
// interrupt path calls process.exit right after this, which drops whatever is still queued (live claude, 2026-10-01: a
// partial cut at 8192 bytes). write() returning true only means the queue is under its high-water mark.
async function writeJsonToStdout(value) {
  const payload = JSON.stringify(value);

  await new Promise((resolve, reject) => {
    process.stdout.write(payload, (error) => (error ? reject(error) : resolve()));
  });
}

let currentRequest = null;
let currentClaudeProcess = null;
let interruptHandled = false;
// Crash resume (2026-10-02), spec §3.1/§3.2: set by onParentGone below.
let parentGone = false;
let claudeEverStarted = false;
let lastSpawnFailure = null; // "<code>: <message>" of the latest failed spawn in this call

async function handleInterrupt(signal) {
  if (interruptHandled) {
    return;
  }

  interruptHandled = true;
  // Spec §3.2: interrupted while waiting to retry a failed spawn -- no claude ever ran in this call, so the answer is
  // "never started", not a timeout partial. Main sees interruptHandled and writes nothing.
  if (!claudeEverStarted && lastSpawnFailure !== null) {
    if (!parentGone) {
      try { await writeNeverStarted(lastSpawnFailure); } catch { process.exit(1); }
    }
    process.exit(0);
    return;
  }
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
  // Crash resume (2026-10-02): CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS is this runner's own input too.
  // Crash resume (2026-10-02), spec §3.1: so are CCLOOP_PARENT_WATCH_FD and CCLOOP_PARENT_GONE_GRACE_MS.
  const { CCLOOP_CLAUDE_COMMAND: _command, CCLOOP_CLAUDE_EXTRA_ARGS: _extraArgs, CCLOOP_CLAUDE_OBSERVED_USAGE_PATH: _observedUsagePath, CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS: _spawnRetryDelay, CCLOOP_PARENT_WATCH_FD: _parentWatchFd, CCLOOP_PARENT_GONE_GRACE_MS: _parentGoneGrace, ...env } = process.env;
  return env;
}

// Crash resume (2026-10-02), spec §3.2 (R-A): "never started" is Node's own verdict -- spawn() threw, or `error` came
// before `spawn`. Only a missing binary (a reinstall takes one to two seconds) is retried.
const CLAUDE_SPAWN_ATTEMPTS = 3;

function readNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

const CLAUDE_SPAWN_RETRY_DELAY_MS = readNonNegativeIntEnv("CCLOOP_CLAUDE_SPAWN_RETRY_DELAY_MS", 2000);

class ClaudeNeverStarted extends Error {
  constructor(spawnError, code) {
    super(`claude never started: ${spawnError}`);
    this.spawnError = spawnError;
    this.code = code;
  }
}

function describeSpawnError(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "ESPAWN";
  return `${code}: ${error instanceof Error ? error.message : String(error)}`;
}

// The listeners go on before any stdio stream is touched: for EMFILE/ENFILE Node returns before creating the streams.
function spawnClaudeOnce(command, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, options);
    } catch (error) {
      reject(new ClaudeNeverStarted(describeSpawnError(error), error?.code));
      return;
    }
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(new ClaudeNeverStarted(describeSpawnError(error), error?.code));
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve(child);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

async function spawnClaude(command, args, options) {
  // Task 3 review, deferred into Task 9: nobody reads the answer of a runner whose parent is gone, so the first spawn is
  // refused too, not only the retries below. Main writes nothing for it (parentGone).
  if (parentGone) throw new ClaudeNeverStarted("EPARENTGONE: parent gone before claude was spawned", "EPARENTGONE");
  for (let attempt = 1; ; attempt += 1) {
    try {
      const child = await spawnClaudeOnce(command, args, options);
      claudeEverStarted = true;
      return child;
    } catch (error) {
      if (error instanceof ClaudeNeverStarted) lastSpawnFailure = error.spawnError;
      const retry = error instanceof ClaudeNeverStarted && error.code === "ENOENT" && attempt < CLAUDE_SPAWN_ATTEMPTS && !interruptHandled && !parentGone;
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, CLAUDE_SPAWN_RETRY_DELAY_MS));
      if (interruptHandled || parentGone) throw error;
    }
  }
}

const PARENT_GONE_GRACE_MS = readNonNegativeIntEnv("CCLOOP_PARENT_GONE_GRACE_MS", 5000);

// Crash resume (2026-10-02), spec §3.1: once the parent is gone nobody reads this runner's output and nobody will stop
// its group, so the runner stops it itself -- after a grace for claude's SIGTERM, and in any case on its own way out.
function killOwnGroup() { try { process.kill(-process.pid, "SIGKILL"); } catch { /* already gone */ } }

function onParentGone() {
  if (parentGone) return;
  parentGone = true;
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.on("exit", killOwnGroup);
  try { currentClaudeProcess?.kill("SIGTERM"); } catch { /* exited */ }
  setTimeout(killOwnGroup, PARENT_GONE_GRACE_MS);
}

// Only an adapter-spawned runner (always detached, so its group's leader) is handed fd 3 and this variable.
function watchParent() {
  if (process.env.CCLOOP_PARENT_WATCH_FD !== "3") return;
  let watch;
  try { watch = new Socket({ fd: 3, readable: true, writable: false }); } catch { onParentGone(); return; }
  watch.on("end", onParentGone);
  watch.on("close", onParentGone);
  watch.on("error", onParentGone);
  watch.resume();
  watch.unref();
}

async function writeNeverStarted(spawnError) {
  await writeJsonToStdout({ claudeNeverStarted: true, spawnError });
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

// Orca ruling 26 (Orca ledger 2026-09-27-single-call-estimate §3.21; session c85d2c4e, 2026-09-28): Linux caps one argv
// string at MAX_ARG_STRLEN (128 KiB) and every platform caps argv as a whole (macOS ARG_MAX, 1 MiB), so a large prompt --
// an estimate over a big plan -- could not even be spawned. A prompt over this many bytes goes to claude on stdin instead
// (claude 2.1.283, static: "Input must be provided either through stdin or as a prompt argument when using --print");
// a smaller one stays the argument it has always been, the form the paid runs used.
const PROMPT_ARGV_MAX_BYTES = 100 * 1024;

// Orca accounts plan, Part B Task B2 (2026-10-07): an answer carries claude's per-model breakdown only when the envelope
// has one buildModelUsage can read whole; otherwise the key is absent, so an answer without one is unchanged.
function withModelUsage(envelope) {
  const modelUsage = envelope === null ? null : buildModelUsage(envelope);
  return modelUsage === null ? {} : { modelUsage };
}

async function runClaude(request, claudeCommand, extraArgs) {
  // Orca single-call estimate (2026-09-27), spec §5.4 and Task 0 item 1 (claude 2.1.283, static): a single call answers
  // the caller's schema with every tool off (`--tools ""`; claude --help: 'Use "" to disable all tools') and its output
  // capped through CLAUDE_CODE_MAX_OUTPUT_TOKENS, in the empty directory the caller gave it. Phases are unchanged.
  const singleCall = request.phase === "single-call";
  const schema = singleCall ? request.schema : getSchemaForPhase(request.phase);
  // Orca claude stream usage (2026-09-27), spec §3.1: stream-json with partial messages, so the usage claude spends is
  // seen as it streams and survives an abort. Read line by line and never kept whole: the stream is several times the
  // size of the json envelope and echoes tool results (spec §2.2 item 8), so the old 10 MiB buffer could fail a long
  // execute. Kept: the result line, the observation, and the last FAILURE_OUTPUT_TAIL characters for failures (B2).
  const promptOnStdin = Buffer.byteLength(request.prompt, "utf8") > PROMPT_ARGV_MAX_BYTES;
  const child = await spawnClaude(
    claudeCommand[0],
    [...claudeCommand.slice(1), "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(schema), ...(singleCall ? ["--tools", ""] : []), ...extraArgs, ...(promptOnStdin ? [] : [request.prompt])],
    {
      cwd: singleCall ? request.cwd : request.worktreePath,
      env: singleCall ? { ...claudeEnv(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens) } : claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Orca paid claude round (2026-09-27): the prompt is an argument, so claude reads nothing from stdin; left open, the
  // pipe made every call wait 3 s ("no stdin data received in 3s, proceeding without it").
  // Ruling 26: a prompt too large for argv is written here instead. A claude that exits before reading it all breaks the
  // pipe; that is its exit to report, not an uncaught error in this runner.
  child.stdin?.on("error", () => {});
  child.stdin?.end(promptOnStdin ? request.prompt : undefined);
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
    // *** ERRATUM (consolidation step 1, 2026-10-01, Orca session be653b22, ruling R5) -- SubprocessClaudeAdapter was deleted in consolidation step 1
    // (ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md); the stand-ins this sentence means now live, unchanged,
    // in tests/runtime/claude/claudePhaseRunner.test.ts, and tests/controller/runLoop.integration.test.ts's usage-aware
    // fake reaches this runner through ClaudeAgentAdapter with the same bare line. ***
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
      // Orca backlog #12(a) (2026-09-29): decoded as a stream, like claude's stdout just above and this runner's stdin
      // (ruling 26); a chunk's own toString turned a multi-byte character cut at a chunk boundary into U+FFFD in the
      // failure message.
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
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
  watchParent();
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

  let request;
  try {
    request = await readStdin();
  } catch (error) {
    // Spec §3.1, Review Focus 4: a parent that died mid-request leaves a partial body; the exit hook kills the group.
    if (parentGone) return;
    throw error;
  }
  // Task 3 review, deferred into Task 9: the parent can be gone with a whole request already read; spawning claude then
  // would spend until the grace kill. The exit hook kills the group.
  if (parentGone) return;
  currentRequest = request;

  try {
    const result = await runClaude(request, claudeCommand, extraArgs);
    const envelope = result.envelope;
    // Orca single-call estimate (2026-09-27), spec §5.2 item 8: an answer with no structured object is reported, not
    // thrown, so the usage claude spent on it is still booked. The caller's schema is claude's to enforce (--json-schema);
    // ccloop carries no JSON Schema validator, and the caller validates what it receives.
    if (request.phase === "single-call") {
      const usageEvidence = envelope === null ? null : buildUsageEvidence(envelope);
      const structured = envelope === null ? undefined : envelope.structured_output;
      const valid = structured !== null && typeof structured === "object" && !Array.isArray(structured);
      await writeJsonToStdout({
        output: valid ? structured : null,
        outputError: valid ? null : "single-call-output-invalid",
        usageEvidence,
        tokenUsage: usageEvidence === null ? null : usageEvidence.normalizedTotal,
        ...withModelUsage(envelope),
      });
      return;
    }
    if (envelope === null) throw new Error("Claude CLI did not return structured_output");
    const structured = envelope.structured_output;

    if (!structured || typeof structured !== "object") {
      throw new Error("Claude CLI did not return structured_output");
    }
    // Crash resume (2026-10-02), spec §5.1: only the runner may say a partial is its own.
    if (request.phase === "execute" && Object.prototype.hasOwnProperty.call(structured, "partialOrigin")) delete structured.partialOrigin;
    // Orca accounts plan B2 fix round 1 (2026-10-07): only the envelope says what each model spent; a modelUsage the model
    // wrote into its own answer is never the breakdown it is charged by.
    if (Object.prototype.hasOwnProperty.call(structured, "modelUsage")) delete structured.modelUsage;
    const broken = request.phase === "execute" ? partialExecutionRuleBroken(structured) : null;
    if (broken !== null) {
      throw new Error(`claude-execute-partial-incomplete: ${broken}`);
    }

    const usageEvidence = buildUsageEvidence(envelope);
    const response = usageEvidence.normalizedTotal === null
      ? { ...structured, usageEvidence, ...withModelUsage(envelope) }
      : { ...structured, usageEvidence, tokenUsage: usageEvidence.normalizedTotal, ...withModelUsage(envelope) };
    await writeJsonToStdout(response);
  } catch (error) {
    if (interruptHandled) {
      return;
    }

    // Spec §3.2: before the execute partial branch -- nothing ran, so there is nothing to recover.
    if (error instanceof ClaudeNeverStarted) {
      if (!parentGone) await writeNeverStarted(error.spawnError);
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
