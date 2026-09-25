// Orca agent selection (2026-09-26), spec §4.8: a stand-in for the `claude` BINARY (the CLI layer), reached
// through ClaudeAgentAdapter -> scripts/claude-phase-runner.mjs. The older tests/fixtures/fake-claude.mjs
// stands in for the runner layer and stays untouched (spec §12 C1).
//
// argv: <mode> <marker> [<scriptPath>, only in mode "script"] ...<the arguments the real claude receives>
// Modes: "ok" (fixed answers), "script" (answers per task, as fake codex's script mode), "hang" (never
// answers), "grandchild" (starts a TERM-ignoring grandchild, not detached so it stays in the runner's process group, then never answers).
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
if (!print || outputFormat !== "json" || schemaText === undefined || prompt === undefined) {
  fail("expected -p --output-format json --json-schema <schema> [--model <model>] <prompt>");
}
writeFileSync(marker, JSON.stringify({ args, cwd: process.cwd(), prompt, model, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null, pid: process.pid }));

if (mode === "hang" || mode === "grandchild") {
  if (mode === "grandchild") {
    const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: "ignore" });
    writeFileSync(`${marker}.grandchild`, String(grandchild.pid));
  }
  setInterval(() => {}, 1000);
} else {
  const CONTINUATION = "Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
  const schema = JSON.parse(schemaText);
  const phase = schema.oneOf ? "execute" : schema.properties?.approved ? "verify" : "plan";
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
  const respond = () => {
    if (mode === "script" && phase === "execute") for (const [path, content] of Object.entries(entry.files)) writeFileSync(path, content);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: body, usage: { input_tokens: 12, output_tokens: 3 } }));
  };
  const delay = entry?.delayMs?.[phase];
  if (!refused) { if (delay === undefined) respond(); else setTimeout(respond, delay); }
}
