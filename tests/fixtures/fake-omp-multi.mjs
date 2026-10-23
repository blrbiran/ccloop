#!/usr/bin/env node
// A fake `omp` phase for multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §16.1 C9, C13). Wrapped like
// fake-omp.mjs:  exec <node> <this file> <marker> "$@". It runs one plan/execute/verify phase the way ccloop drives OMP
// (system prompt file, prompt on stdin, JSON events on stdout) and appends its argv to `<marker>.argv`.
// `<marker>.multi.json` ({planWrite?: string, extraWrites?: [{dir, path}]}) scripts it: plan writes the file planWrite
// (an absolute path); execute writes answer.txt in its cwd and each <dir>/<path>. Execute reports changedFiles as the
// prompt asks: only the working directory's paths when the prompt says so, otherwise `<key>:<path>` for every directory
// (the primary as `app`, an extra as its directory's basename) -- what an agent told to key its paths would report.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [marker, ...args] = process.argv.slice(2);
appendFileSync(`${marker}.argv`, `${JSON.stringify(args)}\n`);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
const system = readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8");
const script = existsSync(`${marker}.multi.json`) ? JSON.parse(readFileSync(`${marker}.multi.json`, "utf8")) : {};
const phase = system.includes("execution phase") ? "execute" : system.includes("verification phase") ? "verify" : "plan";
const put = (file) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${phase}\n`); };
if (phase === "plan" && script.planWrite !== undefined) put(script.planWrite);
let changedFiles = [];
if (phase === "execute") {
  writeFileSync("answer.txt", "42\n");
  for (const write of script.extraWrites ?? []) put(join(write.dir, write.path));
  changedFiles = prompt.includes("changedFiles lists only the paths you changed in the working directory")
    ? ["answer.txt"] : ["app:answer.txt", ...(script.extraWrites ?? []).map((write) => `${basename(write.dir)}:${write.path}`)];
}
const result = phase === "plan" ? { summary: "Set answer to 42", primaryTargetPaths: ["answer.txt"] }
  : phase === "execute" ? { changedFiles, diffPatch: "", commandOutputs: [], stdoutStderrLog: "wrote answer" }
    : { approved: true, rejectCategory: "", primaryTargetPaths: ["answer.txt"], failingCommand: null, safeToRetry: false, evidence: ["answer is 42"], pauseSignals: [], stopSignals: [] };
const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }], provider: "gateway", model: "model-a", stopReason: "stop", usage: { input: 8, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
for (const row of [{ type: "session", id: "fake" }, { type: "agent_start" }, { type: "message_end", message }, { type: "agent_end", isTerminal: true, yielded: true, messages: [message] }]) {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
