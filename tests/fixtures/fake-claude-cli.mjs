// Orca agent selection (2026-09-26), spec §4.8: a stand-in for the `claude` BINARY (the CLI layer), reached
// through ClaudeAgentAdapter -> scripts/claude-phase-runner.mjs. The older tests/fixtures/fake-claude.mjs
// stands in for the runner layer and stays untouched (spec §12 C1).
//
// argv: <mode> <marker> [<scriptPath>, only in mode "script"] ...<the arguments the real claude receives>
// Modes: "ok" (fixed answers), "script" (answers per task, as fake codex's script mode), "hang" (never
// answers), "grandchild" (starts a TERM-ignoring grandchild, not detached so it stays in the runner's process group, then never answers).
// Orca claude stream usage (2026-09-27, spec §5.1): "usage-then-hang" (emits init + one closed message, then hangs),
// "start-then-hang" (emits init + message_start only, then hangs), "flood" (behaves like "ok" but, under
// --output-format stream-json, emits 11 * 1024 content_block_delta lines before its result). Accepts
// --output-format stream-json (spec §2.2's measured event order) alongside the existing json format.
// Files next to <marker>, all appended, one line per call:
//   <marker>.argv   the claude arguments as one JSON array (every call except `--version`)
//   <marker>.calls  `<phase>`                     (fake codex's format; not written by hang/grandchild)
//   <marker>.tasks  `<phase> <entry key or ->`   (fake codex's format; script mode only)
// <marker> itself is overwritten with {args, cwd, prompt, model, claudeConfigDir, pid} on every call.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2], marker = process.argv[3];
const args = process.argv.slice(mode === "script" ? 5 : 4);
if (args.length === 1 && args[0] === "--version") {
  await new Promise((resolve) => process.stdout.write("9.9.9-fake\n", resolve));
  process.exit(0);
}
appendFileSync(`${marker}.argv`, `${JSON.stringify(args)}\n`);

const fail = (message) => { process.stderr.write(`fake-claude-cli: ${message}\n`); process.exit(2); };
let print = false, outputFormat, schemaText, model = null, prompt;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "-p") { print = true; continue; }
  if (arg === "--verbose" || arg === "--include-partial-messages") continue;
  if (arg === "--output-format" || arg === "--json-schema" || arg === "--model") {
    const value = args[index + 1];
    if (value === undefined) fail(`missing value for ${arg}`);
    if (arg === "--output-format") outputFormat = value;
    if (arg === "--json-schema") schemaText = value;
    if (arg === "--model") model = value;
    index += 1;
    continue;
  }
  if (arg.startsWith("-")) fail(`unknown argument ${arg}`);
  if (index !== args.length - 1) fail(`unexpected positional argument ${JSON.stringify(arg)}`);
  prompt = arg;
}
if (!print || (outputFormat !== "json" && outputFormat !== "stream-json") || schemaText === undefined || prompt === undefined) {
  fail("expected -p --output-format json|stream-json --json-schema <schema> [--model <model>] <prompt>");
}
writeFileSync(marker, JSON.stringify({
  args, cwd: process.cwd(), prompt, model, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null, pid: process.pid,
  // Orca claude stream usage (2026-09-27, spec §5.1): lets criteria see whether the runner's observation path env
  // var reached this process, without the fake acting on it.
  observedUsagePathEnv: process.env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH ?? null,
}));

// Orca claude stream usage (2026-09-27, spec §5.1): shared by every mode that can stream, so both the
// usage-then-hang/start-then-hang branch below and the normal answer branch draw on the same event shapes.
const START_USAGE = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 };
const DELTA_USAGE = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 };
const stream = outputFormat === "stream-json";
const emit = (event) => new Promise((resolve) => { if (process.stdout.write(`${JSON.stringify(event)}\n`)) resolve(); else process.stdout.once("drain", resolve); });
const emitInit = () => emit({ type: "system", subtype: "init", model: model ?? "fake" });
const emitStart = () => emit({ type: "stream_event", event: { type: "message_start", message: { id: "msg_fake_1", usage: START_USAGE } } });
const emitClosedMessage = async () => {
  await emitStart();
  await emit({ type: "assistant", message: { id: "msg_fake_1", usage: START_USAGE, content: [] } });
  await emit({ type: "stream_event", event: { type: "message_delta", usage: DELTA_USAGE } });
  await emit({ type: "stream_event", event: { type: "message_stop" } });
};

if (mode === "usage-then-hang" || mode === "start-then-hang") {
  // Orca claude stream usage (2026-09-27, spec §5.1): these two modes only emit under stream-json, matching a
  // runner that opened a stream and then stopped receiving before the message closed or even started.
  if (stream) { await emitInit(); if (mode === "usage-then-hang") await emitClosedMessage(); else await emitStart(); }
  setInterval(() => {}, 1000);
} else if (mode === "hang" || mode === "grandchild") {
  if (mode === "grandchild") {
    const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: "ignore" });
    writeFileSync(`${marker}.grandchild`, String(grandchild.pid));
  }
  setInterval(() => {}, 1000);
} else {
  const CONTINUATION = "Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
  const schema = JSON.parse(schemaText);
  // Orca paid claude round (2026-09-27): the runner's execute schema is now one object (the API refused a top-level
  // oneOf), so execute is told by its changedFiles property; the older oneOf shape is still recognised.
  const phase = schema.oneOf || schema.properties?.changedFiles ? "execute" : schema.properties?.approved ? "verify" : "plan";
  let body = { summary: "fixture", primaryTargetPaths: ["answer.txt"] };
  if (phase === "execute") body = { changedFiles: ["answer.txt"], diffPatch: "fixture patch", commandOutputs: ["changed answer"], stdoutStderrLog: "fixture execution" };
  if (phase === "verify") body = { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };
  appendFileSync(`${marker}.calls`, `${phase}\n`);
  let entry, refused = false;
  if (mode === "script") {
    const task = { plan: /^Plan one isolated L2 attempt for task (.+)\.$/m, execute: /^Execute one isolated attempt for task (.+)\.$/m, verify: /^Verify task (.+)\.$/m }[phase].exec(prompt)?.[1];
    const script = task === undefined ? {} : JSON.parse(readFileSync(process.argv[4], "utf8"));
    const key = prompt.includes(CONTINUATION) && script[`${task}#continuation`] !== undefined ? `${task}#continuation` : script[task] !== undefined ? task : undefined;
    entry = key === undefined ? undefined : script[key];
    appendFileSync(`${marker}.tasks`, `${phase} ${key ?? "-"}\n`);
    if (phase === "execute" && entry === undefined) {
      process.stderr.write(`fake-claude-cli script has no entry for task ${task}\n`);
      process.exitCode = 3;
      refused = true;
    }
  }
  // Orca claude stream usage (2026-09-27, spec §5.1): under stream-json, "flood" answers exactly like "ok" (same
  // phase detection, body and .calls) but interleaves a burst of content_block_delta lines before its closed
  // message, standing in for a real answer too large to buffer.
  let openedBeforeDelay = false;
  const respond = async () => {
    if (mode === "script" && phase === "execute") for (const [path, content] of Object.entries(entry.files)) writeFileSync(path, content);
    const envelope = { type: "result", subtype: "success", is_error: false, structured_output: body, usage: { input_tokens: 12, output_tokens: 3 } };
    if (!stream) { process.stdout.write(JSON.stringify(envelope)); return; }
    if (!openedBeforeDelay) {
      await emitInit();
      if (mode === "flood") {
        await emitStart();
        const text = "x".repeat(1000);
        for (let i = 0; i < 11 * 1024; i += 1) await emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
      }
      await emitClosedMessage();
    }
    await emit(envelope);
  };
  const delay = entry?.delayMs?.[phase];
  if (!refused) {
    if (delay === undefined) await respond();
    else {
      if (stream && entry?.usageBeforeDelay === true) { await emitInit(); await emitClosedMessage(); openedBeforeDelay = true; }
      setTimeout(() => { void respond(); }, delay);
    }
  }
}
