#!/usr/bin/env node
// A fake `omp` (oh-my-pi 18.10.1) for criteria and for Orca's real-ccloop worlds (OMP skill injection, 2026-10-13).
// Installations allow only the binary in `command`, so a test wraps this in a tiny shell script:
//   exec <node> <this file> <marker> "$@"
// ccloop puts --no-extensions/--profile before a subcommand, so subcommands are found anywhere in argv.
// It answers `--version`, the model catalog and the configured default, and runs a plan/execute/verify phase the way
// ccloop drives OMP (system prompt file, prompt on stdin, JSON events on stdout). Per phase it appends the phase name to
// `<marker>.calls`; when the system prompt lists frozen skills it reads every listed SKILL.md (as a model told to would)
// and appends each one's bytes to `<marker>.skills`. Execute sets answer.txt to 42.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [marker, ...args] = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("18.10.1\n");
  process.exit(0);
}
// OMP single call (Orca spec 2026-10-14 §5): `<marker>.catalog.json`, when present, is the catalog's rows; without it the
// one row below, as before.
if (args.includes("models")) {
  const rows = existsSync(`${marker}.catalog.json`) ? JSON.parse(readFileSync(`${marker}.catalog.json`, "utf8"))
    : [{ provider: "gateway", kind: "chat", id: "model-a", selector: "gateway/model-a", contextWindow: 200000, maxTokens: 8192 }];
  process.stdout.write(`${JSON.stringify({ models: rows })}\n`);
  process.exit(0);
}
if (args.includes("config")) {
  process.stdout.write(`${JSON.stringify({ value: { default: "gateway/model-a" } })}\n`);
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
const system = readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8");
// OMP single call (Orca spec 2026-10-14 §5): ccloop's single-call system prompt says "one ccloop single call". Records the
// call and its argv, then prints `<marker>.single.json` ({rows?, exitCode?, hang?}) or one complete {"answer":"42"}.
if (system.includes("one ccloop single call")) {
  appendFileSync(`${marker}.calls`, "single-call\n");
  appendFileSync(`${marker}.argv`, `${JSON.stringify(args)}\n`);
  const script = existsSync(`${marker}.single.json`) ? JSON.parse(readFileSync(`${marker}.single.json`, "utf8")) : {};
  if (script.hang === true) setInterval(() => {}, 1000);
  else {
    const answer = { role: "assistant", content: [{ type: "text", text: "{\"answer\":\"42\"}" }], provider: "gateway", model: "model-a", stopReason: "stop", usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const rows = script.rows ?? [{ type: "agent_start" }, { type: "message_end", message: answer }, { type: "agent_end", isTerminal: true, yielded: true, messages: [answer] }];
    process.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""), () => process.exit(script.exitCode ?? 0));
  }
  await new Promise(() => {});
}
const phase = system.includes("execution phase") ? "execute" : system.includes("verification phase") ? "verify" : "plan";
appendFileSync(`${marker}.calls`, `${phase}\n`);
for (const match of system.matchAll(/\(SKILL\.md: ([^)]+)\)$/gmu)) appendFileSync(`${marker}.skills`, readFileSync(match[1], "utf8"));
if (phase === "execute") writeFileSync("answer.txt", "42\n");
const result = phase === "plan" ? { summary: "Set answer to 42", primaryTargetPaths: ["answer.txt"] }
  : phase === "execute" ? { changedFiles: ["answer.txt"], diffPatch: "", commandOutputs: [], stdoutStderrLog: "wrote answer" }
    : { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: ["answer is 42"], pauseSignals: [], stopSignals: [] };
const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }], provider: "gateway", model: "model-a", stopReason: "stop", usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
for (const row of [{ type: "session", id: "fake" }, { type: "agent_start" }, { type: "message_end", message }, { type: "agent_end", isTerminal: true, yielded: true, messages: [message] }]) {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
