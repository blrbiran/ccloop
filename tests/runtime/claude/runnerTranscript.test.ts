import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";
// @ts-expect-error -- plain ESM script without types
import { createLineSplitter, createTranscriptWriter } from "../../../scripts/claude-stream.mjs";

// Live transcript (Orca spec 2026-10-23 §10.2.1-§10.2.2, criterion L4). claude's stream is read only by the runner, so the
// runner is what records it. Deltas are left out (they repeat the final message and multiply the size), but message_start
// and message_delta stay: they are small, and they carry the usage Orca shows. The adapter SIGKILLs the runner's group when
// a call ends, so a line must be in the file the moment the runner has read it. A line the splitter cannot keep leaves a
// trace instead of a silent gap. Single calls (estimates, clarify, split) are watched like phases.
const runner = fileURLToPath(new URL("../../../scripts/claude-phase-runner.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const dirs: string[] = [];
const groups: number[] = [];
afterEach(async () => {
  for (const pgid of groups.splice(0)) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-transcript-"))); dirs.push(dir);
  return dir;
}
const lines = (text: string) => text.split("\n").filter((line) => line !== "");

const ROWS = {
  init: { type: "system", subtype: "init", model: "fake" },
  start: { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 2, output_tokens: 1 } } } },
  delta: (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }),
  blockStart: { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  messageDelta: { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 2, output_tokens: 7 } } },
  assistant: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "plan 中文" }] } },
  result: { type: "result", structured_output: { summary: "s", primaryTargetPaths: [] }, usage: { input_tokens: 2, output_tokens: 7 } },
};

describe("the runner's transcript writer", () => {
  it("has each kept line in the file when line() returns, and leaves out content_block_delta only", async () => {
    const dir = await tempDir(), path = join(dir, "transcript.jsonl");
    const writer = createTranscriptWriter(path);
    for (const row of [ROWS.init, ROWS.start, ROWS.blockStart, ROWS.delta("pl"), ROWS.delta("an"), ROWS.messageDelta, ROWS.assistant]) {
      writer.line(JSON.stringify(row), row);
      // Synchronous on purpose: read back in the same tick, before any I/O callback could run.
      const onDisk = readFileSync(path, "utf8");
      if (row.type === "stream_event" && (row as { event: { type: string } }).event.type === "content_block_delta") expect(onDisk.endsWith(`${JSON.stringify(row)}\n`)).toBe(false);
      else expect(onDisk.endsWith(`${JSON.stringify(row)}\n`)).toBe(true);
    }
    writer.line("not json", undefined);
    writer.dropped(11 * 1024 * 1024);
    writer.close();
    expect(lines(await readFile(path, "utf8"))).toEqual([ROWS.init, ROWS.start, ROWS.blockStart, ROWS.messageDelta, ROWS.assistant].map((row) => JSON.stringify(row))
      .concat(["not json", JSON.stringify({ type: "ccloop.line-dropped", bytes: 11 * 1024 * 1024 })]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("stops at its cap at a line end with one marker", async () => {
    const dir = await tempDir(), path = join(dir, "transcript.jsonl");
    const writer = createTranscriptWriter(path, 40);
    for (const text of ['{"a":"0123456789"}', '{"b":"0123456789"}', '{"c":1}']) writer.line(text, JSON.parse(text));
    writer.close();
    expect(await readFile(path, "utf8")).toBe('{"a":"0123456789"}\n{"b":"0123456789"}\n{"type":"ccloop.transcript-truncated","atBytes":38}\n');
  });

  it("the splitter reports a dropped line with its size", () => {
    const kept: string[] = [], dropped: number[] = [];
    const splitter = createLineSplitter((line: string) => kept.push(line), 16, (bytes: number) => dropped.push(bytes));
    splitter.push('{"a":1}\n{"long":"'); splitter.push('0123456789abcdef"}\n{"b":2}\n'); splitter.push("x".repeat(20)); splitter.end();
    expect(kept).toEqual(['{"a":1}', '{"b":2}']);
    expect(dropped).toEqual([Buffer.byteLength('{"long":"0123456789abcdef"}'), 20]);
  });
});

describe("the runner records claude's stream", () => {
  async function fakeClaude(dir: string, body: string): Promise<string> {
    const path = join(dir, "fake-claude.mjs");
    await writeFile(path, `import { writeFileSync } from "node:fs";\nconst emit=(row)=>new Promise(r=>{if(process.stdout.write((typeof row==="string"?row:JSON.stringify(row))+"\\n"))r();else process.stdout.once("drain",r);});\n${body}\n`);
    return path;
  }
  function start(dir: string, fake: string, transcript: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, CCLOOP_CLAUDE_COMMAND: JSON.stringify([process.execPath, fake]), CCLOOP_CLAUDE_EXTRA_ARGS: "[]", CCLOOP_CLAUDE_TRANSCRIPT_PATH: transcript };
    delete env.CCLOOP_CLAUDE_OBSERVED_USAGE_PATH;
    const child = spawn(process.execPath, [runner], { cwd: dir, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    groups.push(child.pid!);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    const done = new Promise<{ code: number | null }>((resolve) => child.on("close", (code) => resolve({ code })));
    child.stdin.end(JSON.stringify({ phase: "plan", prompt: "Plan one isolated L2 attempt for task t.", attempt: 1, runDir: dir, worktreePath: dir }));
    return { child, done, out: () => stdout };
  }

  it("keeps every line but the deltas, marks a line too large for the splitter, and still answers", async () => {
    const dir = await tempDir(), transcript = join(dir, "transcript.jsonl");
    const fake = await fakeClaude(dir, `
for (const row of ${JSON.stringify([ROWS.init, ROWS.start, ROWS.blockStart, ROWS.delta("pl"), ROWS.delta("an 中")])}) await emit(row);
await emit(JSON.stringify({type:"user",pad:"p".repeat(11*1024*1024)}));
for (const row of ${JSON.stringify([ROWS.messageDelta, ROWS.assistant, ROWS.result])}) await emit(row);`);
    const run = start(dir, fake, transcript);
    expect((await run.done).code).toBe(0);
    expect(JSON.parse(run.out())).toMatchObject({ summary: "s", tokenUsage: 9 });
    const padBytes = Buffer.byteLength(JSON.stringify({ type: "user", pad: "p".repeat(11 * 1024 * 1024) }));
    expect(lines(await readFile(transcript, "utf8"))).toEqual([
      JSON.stringify(ROWS.init), JSON.stringify(ROWS.start), JSON.stringify(ROWS.blockStart),
      JSON.stringify({ type: "ccloop.line-dropped", bytes: padBytes }),
      JSON.stringify(ROWS.messageDelta), JSON.stringify(ROWS.assistant), JSON.stringify(ROWS.result),
    ]);
  }, 30_000);

  it("leaves on disk every line it has read when its group is SIGKILLed", async () => {
    const dir = await tempDir(), transcript = join(dir, "transcript.jsonl"), printed = join(dir, "printed");
    const fake = await fakeClaude(dir, `
for (let i = 0; i < 50; i++) await emit({ type: "assistant", message: { id: "m" + i, content: [{ type: "text", text: "line " + i }] } });
writeFileSync(${JSON.stringify(printed)}, "50");
setInterval(() => {}, 1000);`);
    const run = start(dir, fake, transcript);
    await expect.poll(() => readFile(printed, "utf8").catch(() => ""), { timeout: 10_000 }).toBe("50");
    await expect.poll(async () => lines(await readFile(transcript, "utf8").catch(() => "")).length, { timeout: 10_000 }).toBe(50);
    process.kill(-run.child.pid!, "SIGKILL");
    await run.done;
    const kept = lines(await readFile(transcript, "utf8"));
    expect(kept).toHaveLength(50);
    expect(JSON.parse(kept[49]!)).toMatchObject({ message: { id: "m49" } });
  }, 30_000);
});

describe("the adapter names the transcript for phases and single calls", () => {
  async function adapterWorld() {
    const dir = await tempDir();
    const cwd = join(dir, "cwd"), runDir = join(dir, "run"), marker = join(dir, "marker.json"), script = join(dir, "script.json");
    await mkdir(cwd, { mode: 0o700 }); await mkdir(runDir, { mode: 0o700 });
    await writeFile(script, JSON.stringify({ "single-call": { output: { answer: "42" } } }));
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1", kind: "claude",
      installation: { kind: "claude", command: [process.execPath, fakeCli, "script", marker, script], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
      selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
    };
    return { cwd, runDir, config };
  }

  it("a single call writes transcript.jsonl in its call directory, and outcome.json says it was not truncated", async () => {
    const w = await adapterWorld();
    const result = await new ClaudeAgentAdapter(w.config).singleCall({ prompt: "estimate", responseSchema: { type: "object" }, maxOutputTokens: 1024, cwd: w.cwd, runDir: w.runDir, timeoutMs: 20_000,
      onProcessRegistered: async (registration) => { groups.push(registration.pgid); } });
    expect(result).toMatchObject({ output: { answer: "42" } });
    const root = join(w.runDir, "claude", "1", "single-call");
    const [call] = await readdir(root);
    const recorded = lines(await readFile(join(root, call!, "transcript.jsonl"), "utf8")).map((line) => JSON.parse(line) as { type: string });
    expect(recorded.map((row) => row.type)).toContain("result");
    expect(JSON.parse(await readFile(join(root, call!, "outcome.json"), "utf8"))).toMatchObject({ transcriptTruncatedAt: null });
  }, 30_000);
});
