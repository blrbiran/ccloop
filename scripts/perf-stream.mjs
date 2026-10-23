#!/usr/bin/env node
// Live transcript (Orca spec docs/superpowers/specs/2026-10-23-live-transcript-design.md §10.2.3, criterion L7): on demand,
// never part of `npm test`. A fake codex, omp and claude each print about 1 GiB of stream lines (each ≤ 1 MiB). The process
// that reads the stream -- the phase process for codex and omp (runCodexPhase / runOmpPhase from dist/, so run
// `npm run build` first), the runner for claude -- runs under `node --max-old-space-size=64` and samples its own
// heapUsed+external+arrayBuffers every 100 ms. Exit 0 when every peak's growth over the process's baseline is ≤ 32 MiB and
// every call ran to the end; non-zero over the limit, on an OOM, or when a call did not complete.
// The bound is on growth (spec §4.3: "leaves the phase's RSS growth under 32 MiB"), not on the absolute peak L7 words:
// measured at 87bb4b5, the codex phase process already holds ~45 MiB of loaded modules before any stream, with 8 MiB of
// output as with 1 GiB. The baseline is sampled after the phase module is imported (codex, omp) or when the runner
// starts (claude). Both numbers are printed. Usage: node scripts/perf-stream.mjs [codex|omp|claude ...]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LIMIT_MIB = 32;
const TOTAL = 1023 * 1024 * 1024; // just under the 1 GiB hard limit, so the call runs to its end
const runtimes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["codex", "omp", "claude"];
const work = mkdtempSync(join(tmpdir(), "ccloop-perf-stream-"));

// Shared by every measured process: imported first (`--import`), samples memory every 100 ms, writes the peak on exit.
const sampler = join(work, "sampler.mjs");
writeFileSync(sampler, `import { writeFileSync } from "node:fs";
let peak = 0, baseline = null;
const current = () => { const m = process.memoryUsage(); return m.heapUsed + m.external + m.arrayBuffers; };
const sample = () => { peak = Math.max(peak, current()); };
// Called by the codex/omp driver once the phase module is loaded; the runner keeps the value taken here, at its start.
globalThis.perfBaseline = () => { baseline = current(); peak = baseline; };
globalThis.perfBaseline();
setInterval(sample, 100).unref();
process.on("exit", () => { sample(); writeFileSync(process.env.PERF_PEAK_FILE, JSON.stringify({ peak, baseline })); });
`);

// The fake agents: each writes TOTAL bytes of lines of at most 1 MiB, honouring backpressure, then a valid ending.
const pumpSource = `const pump=async(total,lineOf)=>{let written=0,n=0;while(written<total){const line=lineOf(n++);written+=Buffer.byteLength(line);if(!process.stdout.write(line))await new Promise(r=>process.stdout.once("drain",r));}};`;
const fakes = {
  codex: `for await (const _ of process.stdin) {}
const out=process.argv[process.argv.indexOf("-o")+1];
${pumpSource}
const pad="r".repeat(1024*1024-100);
await pump(${TOTAL}-4096,(n)=>JSON.stringify({type:"item.completed",item:{id:"r"+n,type:"reasoning",text:pad}})+"\\n");
(await import("node:fs")).writeFileSync(out,JSON.stringify({summary:"perf",primaryTargetPaths:[]}));
process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:12,output_tokens:3}})+"\\n");`,
  omp: `for await (const _ of process.stdin) {}
${pumpSource}
const pad="u".repeat(1024*1024-100);
await pump(${TOTAL}-4096,()=>JSON.stringify({type:"message_update",delta:pad})+"\\n");
const message={role:"assistant",content:[{type:"text",text:JSON.stringify({summary:"perf",primaryTargetPaths:[]})}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:8,output:2,cacheRead:3,cacheWrite:1,totalTokens:14}};
process.stdout.write([{type:"message_end",message},{type:"agent_end",isTerminal:true}].map(r=>JSON.stringify(r)).join("\\n")+"\\n");`,
  claude: `${pumpSource}
const pad="c".repeat(512*1024);
await pump(${TOTAL}-4096,(n)=>JSON.stringify(n%2===0?{type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:pad}}}:{type:"assistant",message:{id:"m"+n,content:[{type:"text",text:pad}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"result",structured_output:{summary:"perf",primaryTargetPaths:[]},usage:{input_tokens:2,output_tokens:7}})+"\\n");`,
};

// The phase process for codex and omp: drives runCodexPhase / runOmpPhase from dist/ against the fake.
const driver = join(work, "driver.mjs");
writeFileSync(driver, `import { join } from "node:path";
const [kind, fake, dir] = process.argv.slice(2);
const context = { runDir: join(dir, "run"), attempt: 1, worktreePath: dir, state: { budgetSnapshot: { timeRemainingMs: 600000 } } };
let outcome;
if (kind === "codex") {
  const { runCodexPhase } = await import(${JSON.stringify(join(ROOT, "dist/src/runtime/codex/runCodexPhase.js"))});
  globalThis.perfBaseline();
  outcome = await runCodexPhase({ command: [process.execPath, fake], model: "perf", budgetMode: "soft", sandbox: "read-only", timeoutMs: 600000, killGraceMs: 100, idleTimeoutMs: null }, { phase: "plan", prompt: "p", context });
  if (outcome.reason === "completed") outcome.stream.usage.value();
} else {
  const { runOmpPhase } = await import(${JSON.stringify(join(ROOT, "dist/src/runtime/omp/runOmpPhase.js"))});
  globalThis.perfBaseline();
  const config = { schema: "ccloop-agent-config-v1", kind: "omp", installation: { kind: "omp", command: [fake], version: "18.10.1", configDir: null, timeoutMs: 600000, killGraceMs: 100, idleTimeoutMs: null, defaultModel: "gateway/model-a", profile: null }, selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" } };
  outcome = await runOmpPhase(config, "plan", "p", context);
  if (outcome.reason === "completed") outcome.stream.phase.value();
}
process.stdout.write(outcome.reason);
`);

let failed = false;
for (const kind of runtimes) {
  const dir = join(work, kind);
  mkdirSync(dir);
  const fake = join(dir, "fake.mjs");
  writeFileSync(fake, `#!${process.execPath}\n${fakes[kind]}\n`);
  chmodSync(fake, 0o700);
  const peakFile = join(dir, "peak");
  const env = { ...process.env, PERF_PEAK_FILE: peakFile };
  const started = Date.now();
  let result, completed;
  if (kind === "claude") {
    const transcript = join(dir, "transcript.jsonl");
    result = spawnSync(process.execPath, ["--max-old-space-size=64", "--import", sampler, join(ROOT, "scripts/claude-phase-runner.mjs")], {
      cwd: dir, input: JSON.stringify({ phase: "plan", prompt: "p", attempt: 1, runDir: dir, worktreePath: dir }),
      env: { ...env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, fake]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]", CCLOOP_CLAUDE_TRANSCRIPT_PATH: transcript },
      maxBuffer: 64 * 1024 * 1024,
    });
    completed = result.status === 0 && JSON.parse(String(result.stdout)).summary === "perf";
  } else {
    result = spawnSync(process.execPath, ["--max-old-space-size=64", "--import", sampler, driver, kind, fake, dir], { cwd: dir, env, maxBuffer: 1024 * 1024 });
    completed = result.status === 0 && String(result.stdout) === "completed";
  }
  let measured = null;
  try { measured = JSON.parse(readFileSync(peakFile, "utf8")); } catch { /* the process died before its exit hook */ }
  const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  const growthMiB = measured === null ? null : (measured.peak - measured.baseline) / 1024 / 1024;
  const ok = completed && growthMiB !== null && growthMiB <= LIMIT_MIB;
  if (!ok) failed = true;
  process.stdout.write(`${kind}: ${ok ? "ok" : "FAIL"} growth=${growthMiB === null ? "unknown" : growthMiB.toFixed(1)}MiB limit=${LIMIT_MIB}MiB peak=${measured === null ? "unknown" : mib(measured.peak)}MiB baseline=${measured === null ? "unknown" : mib(measured.baseline)}MiB exit=${result.status} signal=${result.signal ?? "none"} completed=${completed} elapsedMs=${Date.now() - started}\n`);
  if (!ok) process.stdout.write(`  stderr: ${String(result.stderr).slice(-2000)}\n`);
}
rmSync(work, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
