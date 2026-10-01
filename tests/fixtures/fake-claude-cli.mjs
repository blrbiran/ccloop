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
// Orca single-call estimate (2026-09-27, spec §5.4): `--tools ""` marks a single call (phase "single-call"),
// answered from the script's "single-call" entry {output, delayMs, usageBeforeDelay}; <marker> also records
// maxOutputTokensEnv.
// Orca N1 (2026-10-02, plan Task C1): with no "single-call" entry, "single-call-queue" answers a sequence of single calls
// in order (each entry optionally only for a prompt containing its `match`); <marker>.single-call-queue lists used indexes.
// Files next to <marker>, all appended, one line per call:
//   <marker>.argv   the claude arguments as one JSON array (every call except `--version`)
//   <marker>.calls  `<phase>`                     (fake codex's format; not written by hang/grandchild)
//   <marker>.tasks  `<phase> <entry key or ->`   (fake codex's format; script mode only)
// <marker> itself is overwritten with {args, cwd, prompt, model, claudeConfigDir, pid} on every call.
// *** ERRATUM (consolidation step 1, 2026-10-01, Orca session be653b22, ruling R5) -- tests/fixtures/fake-claude.mjs no longer exists: it was deleted in
// consolidation step 1 (ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md) together with SubprocessClaudeAdapter, its
// only user. This file is the only fake claude left. ***
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2], marker = process.argv[3];
const args = process.argv.slice(mode === "script" ? 5 : 4);
if (args.length === 1 && args[0] === "--version") {
  await new Promise((resolve) => process.stdout.write("9.9.9-fake\n", resolve));
  process.exit(0);
}
appendFileSync(`${marker}.argv`, `${JSON.stringify(args)}\n`);

const fail = (message) => { process.stderr.write(`fake-claude-cli: ${message}\n`); process.exit(2); };
let print = false, outputFormat, schemaText, model = null, prompt, tools;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "-p") { print = true; continue; }
  if (arg === "--verbose" || arg === "--include-partial-messages") continue;
  if (arg === "--output-format" || arg === "--json-schema" || arg === "--model" || arg === "--tools") {
    const value = args[index + 1];
    if (value === undefined) fail(`missing value for ${arg}`);
    if (arg === "--output-format") outputFormat = value;
    if (arg === "--json-schema") schemaText = value;
    if (arg === "--model") model = value;
    if (arg === "--tools") tools = value;
    index += 1;
    continue;
  }
  if (arg.startsWith("-")) fail(`unknown argument ${arg}`);
  if (index !== args.length - 1) fail(`unexpected positional argument ${JSON.stringify(arg)}`);
  prompt = arg;
}
// Orca ruling 26 (2026-09-28): like claude -p, with no prompt argument the prompt is the whole of stdin.
const promptVia = prompt === undefined ? "stdin" : "argv";
if (prompt === undefined && print) prompt = readFileSync(0, "utf8");
if (!print || (outputFormat !== "json" && outputFormat !== "stream-json") || schemaText === undefined || prompt === undefined) {
  fail("expected -p --output-format json|stream-json --json-schema <schema> [--model <model>] <prompt>");
}
writeFileSync(marker, JSON.stringify({
  args, cwd: process.cwd(), prompt, promptVia, model, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null, pid: process.pid,
  // Orca claude stream usage (2026-09-27, spec §5.1): lets criteria see whether the runner's observation path env
  // var reached this process, without the fake acting on it.
  observedUsagePathEnv: process.env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH ?? null,
  // Orca single-call estimate (2026-09-27), spec §5.4: lets criteria see the output cap the runner handed claude.
  maxOutputTokensEnv: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
}));

// Orca claude stream usage (2026-09-27, spec §5.1): shared by every mode that can stream, so both the
// usage-then-hang/start-then-hang branch below and the normal answer branch draw on the same event shapes.
const START_USAGE = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 };
const DELTA_USAGE = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 };
const stream = outputFormat === "stream-json";
const emit = (event) => new Promise((resolve) => { if (process.stdout.write(`${JSON.stringify(event)}\n`)) resolve(); else process.stdout.once("drain", resolve); });
const emitInit = () => emit({ type: "system", subtype: "init", model: model ?? "fake" });
const emitStart = () => emit({ type: "stream_event", event: { type: "message_start", message: { id: "msg_fake_1", usage: START_USAGE } } });
// Fix round 1 of Task 1 (Orca claude stream usage, 2026-09-27, spec §5.1 / §2.2's order): split out the part of a
// closed message that comes after message_start, so "flood" can interleave its delta burst between message_start
// and this tail instead of emitting message_start twice (once explicitly, once inside emitClosedMessage).
const emitMessageTail = async () => {
  await emit({ type: "assistant", message: { id: "msg_fake_1", usage: START_USAGE, content: [] } });
  await emit({ type: "stream_event", event: { type: "message_delta", usage: DELTA_USAGE } });
  await emit({ type: "stream_event", event: { type: "message_stop" } });
};
const emitClosedMessage = async () => { await emitStart(); await emitMessageTail(); };

// Consolidation step 1 (2026-10-01, ccloop spec 2026-10-01-claude-adapter-consolidation-step1-design.md §7.4):
// "write-then-hang" writes partial.txt (400 kB) in its cwd, under stream-json emits init + one closed message, then
// hangs; "write-quiet-then-hang" the same without any stream event; "write-ignore-term" writes partial.txt, ignores
// SIGTERM and hangs; "write-then-fail" writes partial.txt and exits 1; "answer-then-linger" answers like "ok", leaves a
// grandchild holding its stdout (so the runner's close waits), writes <marker>.answered and exits 0.
const PARTIAL_BYTES = "x".repeat(400_000) + "\n";
const NEW_WRITE_MODES = new Set(["write-then-hang", "write-quiet-then-hang", "write-ignore-term", "write-then-fail"]);
if (NEW_WRITE_MODES.has(mode)) {
  writeFileSync("partial.txt", PARTIAL_BYTES);
  if (mode === "write-ignore-term") process.on("SIGTERM", () => {});
  if (mode === "write-then-hang" && stream) { await emitInit(); await emitClosedMessage(); }
  writeFileSync(`${marker}.wrote`, "1");
  if (mode === "write-then-fail") { process.stderr.write("fake-claude-cli: failing after a write\n"); process.exit(1); }
  setInterval(() => {}, 1000);
} else if (mode === "usage-then-hang" || mode === "start-then-hang") {
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
  // Orca single-call estimate (2026-09-27), spec §5.4: the runner turns every tool off with `--tools ""` only for a
  // single call, so that flag -- not the caller's schema, which can be anything -- tells a single call apart.
  const singleCall = tools === "";
  // Orca paid claude round (2026-09-27): the runner's execute schema is now one object (the API refused a top-level
  // oneOf), so execute is told by its changedFiles property; the older oneOf shape is still recognised.
  const phase = singleCall ? "single-call" : schema.oneOf || schema.properties?.changedFiles ? "execute" : schema.properties?.approved ? "verify" : "plan";
  let body = { summary: "fixture", primaryTargetPaths: ["answer.txt"] };
  if (phase === "execute") body = { changedFiles: ["answer.txt"], diffPatch: "fixture patch", commandOutputs: ["changed answer"], stdoutStderrLog: "fixture execution" };
  if (phase === "verify") body = { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] };
  if (phase === "single-call") body = { answer: "fixture" };
  appendFileSync(`${marker}.calls`, `${phase}\n`);
  let entry, refused = false;
  if (mode === "script") {
    const task = phase === "single-call"
      ? "single-call"
      : { plan: /^Plan one isolated L2 attempt for task (.+)\.$/m, execute: /^Execute one isolated attempt for task (.+)\.$/m, verify: /^Verify task (.+)\.$/m }[phase].exec(prompt)?.[1];
    const script = task === undefined ? {} : JSON.parse(readFileSync(process.argv[4], "utf8"));
    let key = prompt.includes(CONTINUATION) && script[`${task}#continuation`] !== undefined ? `${task}#continuation` : script[task] !== undefined ? task : undefined;
    entry = key === undefined ? undefined : script[key];
    // Orca N1 (2026-10-02, requirement to split, plan Task C1): with no "single-call" entry, a "single-call-queue" answers a
    // sequence of single calls: the first unused entry whose `match` (if any) the prompt contains. Used indexes are
    // appended to <marker>.single-call-queue, so a script rewritten between calls keeps its consumed prefix.
    if (phase === "single-call" && key === undefined && Array.isArray(script["single-call-queue"])) {
      const usedPath = `${marker}.single-call-queue`;
      const used = new Set(existsSync(usedPath) ? readFileSync(usedPath, "utf8").split("\n").filter(Boolean).map(Number) : []);
      const index = script["single-call-queue"].findIndex((candidate, i) => !used.has(i) && (candidate.match === undefined || prompt.includes(candidate.match)));
      if (index >= 0) { appendFileSync(usedPath, `${index}\n`); key = `single-call-queue#${index}`; entry = script["single-call-queue"][index]; }
    }
    appendFileSync(`${marker}.tasks`, `${phase} ${key ?? "-"}\n`);
    if ((phase === "execute" || phase === "single-call") && entry === undefined) {
      process.stderr.write(`fake-claude-cli script has no entry for task ${task}\n`);
      process.exitCode = 3;
      refused = true;
    }
    // Orca single-call estimate (2026-09-27): a single call answers what its entry scripts; null stands for an answer
    // with no structured object at all.
    if (phase === "single-call" && entry !== undefined) body = entry.output;
  }
  // Orca claude stream usage (2026-09-27, spec §5.1): under stream-json, "flood" answers exactly like "ok" (same
  // phase detection, body and .calls) but interleaves a burst of content_block_delta lines before its closed
  // message, standing in for a real answer too large to buffer.
  let openedBeforeDelay = false;
  const respond = async () => {
    if (mode === "script" && phase === "execute") for (const [path, content] of Object.entries(entry.files)) writeFileSync(path, content);
    const envelope = { type: "result", subtype: "success", is_error: false, ...(body === null ? {} : { structured_output: body }), usage: { input_tokens: 12, output_tokens: 3 } };
    if (!stream) { process.stdout.write(JSON.stringify(envelope)); return; }
    if (!openedBeforeDelay) {
      await emitInit();
      if (mode === "flood") {
        await emitStart();
        const text = "x".repeat(1000);
        for (let i = 0; i < 11 * 1024; i += 1) await emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
        await emitMessageTail();
      } else {
        await emitClosedMessage();
      }
    }
    await emit(envelope);
  };
  const delay = entry?.delayMs?.[phase];
  if (!refused) {
    if (delay === undefined) {
      await respond();
      if (mode === "answer-then-linger") {
        spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "ignore"] });
        writeFileSync(`${marker}.answered`, "1");
        process.exit(0);
      }
    } else {
      if (stream && entry?.usageBeforeDelay === true) { await emitInit(); await emitClosedMessage(); openedBeforeDelay = true; }
      setTimeout(() => { void respond(); }, delay);
    }
  }
}
