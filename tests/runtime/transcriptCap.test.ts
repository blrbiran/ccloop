import { spawn } from "node:child_process";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservedTranscriptFile, transcriptMarker } from "../../src/runtime/streamLines.js";
import type { MaterializedAgentConfigV1 } from "../../src/agents/types.js";
import { runCodexPhase } from "../../src/runtime/codex/runCodexPhase.js";
import { runOmpPhase } from "../../src/runtime/omp/runOmpPhase.js";
import { codexFixture } from "./codex/fixture.js";

// Live transcript (Orca spec 2026-10-23 §10.2.2, §11.1; criterion L2). A long agent turn is not a failure: the agent runs
// on past both record caps. The live view's transcript keeps the first ≤ 128 MiB cut at a line end and then says where it
// stopped; the evidence file keeps ≤ 16 MiB cut at a line end and carries no foreign line (its decoders are strict), its
// truncation labelled in outcome.json so saved-result recovery keeps refusing it.
const MIB = 1024 * 1024;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function lastLine(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 4096));
    await handle.read(tail, 0, tail.length, size - tail.length);
    const text = tail.toString("utf8");
    return text.slice(text.lastIndexOf("\n", text.length - 2) + 1);
  } finally { await handle.close(); }
}

async function expectCapped(evidenceDir: string): Promise<void> {
  const transcriptPath = join(evidenceDir, "transcript.jsonl"), eventsPath = join(evidenceDir, "events.jsonl");
  const outcome = JSON.parse(await readFile(join(evidenceDir, "outcome.json"), "utf8")) as { stdoutTruncated: boolean; transcriptTruncatedAt: number | null };
  // Positive observation first: the transcript did fill up to near its cap.
  expect(outcome.transcriptTruncatedAt).toBeGreaterThan(127 * MIB);
  expect(outcome.transcriptTruncatedAt).toBeLessThanOrEqual(128 * MIB);
  const at = outcome.transcriptTruncatedAt!;
  const marker = `${JSON.stringify({ type: "ccloop.transcript-truncated", atBytes: at })}\n`;
  expect((await stat(transcriptPath)).size).toBe(at + Buffer.byteLength(marker));
  expect(await lastLine(transcriptPath)).toBe(marker);
  // The byte before the marker ends a complete line, and that line parses.
  const handle = await open(transcriptPath, "r");
  try {
    const before = Buffer.alloc(70 * 1024);
    await handle.read(before, 0, before.length, at - before.length);
    expect(before.at(-1)).toBe(10);
    const text = before.toString("utf8", 0, before.length - 1);
    expect(() => JSON.parse(text.slice(text.lastIndexOf("\n") + 1))).not.toThrow();
  } finally { await handle.close(); }
  expect(outcome.stdoutTruncated).toBe(true);
  const events = await readFile(eventsPath);
  expect(events.length).toBeLessThanOrEqual(16 * MIB);
  expect(events.length).toBeGreaterThan(15 * MIB);
  expect(events.at(-1)).toBe(10);
  expect(events.includes(Buffer.from("ccloop.transcript-truncated"))).toBe(false);
}

describe("per-row transcript observation", () => {
  it("keeps partial stdout bytes on disk when the writer process dies before a newline or close", async () => {
    const f = await codexFixture(); roots.push(f.dir);
    const path = join(f.dir, "interrupted.jsonl");
    await writeFile(path, "", { mode: 0o600 });
    const source = fileURLToPath(new URL("../../src/runtime/streamLines.ts", import.meta.url));
    const raw = Buffer.from('{"type":"unfinished","text":"中');
    const code = `import { ObservedTranscriptFile } from ${JSON.stringify(source)};\nconst file = new ObservedTranscriptFile(${JSON.stringify(path)});\nfile.write(Buffer.from(${JSON.stringify([...raw])}));\nprocess.stdout.write("received");\nsetInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", (status) => reject(new Error(`writer exited before receipt: ${status}`)));
      });
      expect(await readFile(path)).toEqual(raw);
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(await readFile(path)).toEqual(raw);
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
  });
  it("timestamps each complete object at receipt, preserving raw lines, split UTF-8, and final no-newline flush", async () => {
    const f = await codexFixture(); roots.push(f.dir);
    const path = join(f.dir, "observed.jsonl");
    await writeFile(path, "", { mode: 0o600 });
    const file = new ObservedTranscriptFile(path, 1024);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(101);
      const first = Buffer.from('{"type":"a","text":"中文"}\n');
      const split = first.indexOf(Buffer.from("中")) + 1;
      file.write(first.subarray(0, split));
      expect(await readFile(path)).toEqual(first.subarray(0, split));
      clock.mockReturnValueOnce(101).mockReturnValue(999);
      file.write(Buffer.concat([first.subarray(split), Buffer.from('not json\n{"type":"same-chunk"}\n[1,2]\n')]));
      clock.mockReturnValue(202);
      file.write(Buffer.from('{"type":"b"}'));
      file.close();
      expect(await readFile(path, "utf8")).toBe('{"type":"a","text":"中文","ccloopObservedAt":101}\nnot json\n{"type":"same-chunk","ccloopObservedAt":101}\n[1,2]\n{"type":"b","ccloopObservedAt":202}\n');
    } finally { clock.mockRestore(); }
  });

  it("cuts at the preceding complete row when timestamp bytes push a raw row past the cap", async () => {
    const f = await codexFixture(); roots.push(f.dir);
    const path = join(f.dir, "timestamp-cap.jsonl");
    await writeFile(path, "", { mode: 0o600 });
    const file = new ObservedTranscriptFile(path, 60);
    file.write(Buffer.from('{"id":1}\n'));
    const first = await readFile(path, "utf8");
    expect(JSON.parse(first)).toMatchObject({ id: 1, ccloopObservedAt: expect.any(Number) });
    file.write(Buffer.from('{"id":2}\n'));
    expect(file.truncatedAt).toBe(Buffer.byteLength(first));
    file.close();
    expect(await readFile(path, "utf8")).toBe(first + transcriptMarker(Buffer.byteLength(first)));
  });

  it("leaves malformed UTF-8 untouched rather than turning replacement characters into valid JSON", async () => {
    const f = await codexFixture(); roots.push(f.dir);
    const path = join(f.dir, "invalid.jsonl");
    await writeFile(path, "", { mode: 0o600 });
    const raw = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]);
    const file = new ObservedTranscriptFile(path, 1024);
    file.write(raw.subarray(0, 7)); file.write(raw.subarray(7)); file.close();
    expect(await readFile(path)).toEqual(raw);
  });

  it("keeps an over-line-cap record raw and preserves the truncation marker", async () => {
    const f = await codexFixture(); roots.push(f.dir);
    const path = join(f.dir, "observed.jsonl");
    await writeFile(path, "", { mode: 0o600 });
    const line = Buffer.from(JSON.stringify({ payload: "x".repeat(16 * MIB) }) + "\n");
    const file = new ObservedTranscriptFile(path, line.length + 2);
    file.write(line.subarray(0, 100)); file.write(line.subarray(100));
    file.write(Buffer.from('{"type":"later"}\n'));
    expect(file.truncatedAt).toBe(line.length);
    file.close();
    expect((await readFile(path)).subarray(0, line.length).equals(line)).toBe(true);
    expect(await lastLine(path)).toBe(`${JSON.stringify({ type: "ccloop.transcript-truncated", atBytes: line.length })}\n`);
  });
});

describe("transcript and evidence caps", () => {
  it("codex: a 130 MiB stream completes; the transcript is cut at a line end ≤ 128 MiB with one marker; events.jsonl ≤ 16 MiB", async () => {
    const f = await codexFixture("large-stream");
    roots.push(f.dir);
    const outcome = await runCodexPhase({ ...f.config, timeoutMs: 120_000 } as never, { phase: "plan", prompt: "p", context: { ...f.context, state: { ...f.context.state, budgetSnapshot: { ...f.context.state.budgetSnapshot, timeRemainingMs: 120_000 } } } }, { FAKE_CODEX_STREAM_MIB: "130" });
    expect(outcome.reason).toBe("completed");
    expect(outcome.stream.usage.value().tokenUsage).toBe(15);
    await expectCapped(outcome.evidenceDir);
  }, 150_000);

  it("omp: a 130 MiB stream completes the same way", async () => {
    const f = await codexFixture();
    roots.push(f.dir);
    const binary = join(f.dir, "omp");
    await writeFile(binary, `#!/usr/bin/env node
(async()=>{
for await(const chunk of process.stdin){}
const message={role:"assistant",content:[{type:"text",text:JSON.stringify({summary:"big",primaryTargetPaths:[]})}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:8,output:2,cacheRead:3,cacheWrite:1,totalTokens:14}};
const update=JSON.stringify({type:"message_update",delta:"u".repeat(64*1024-50)})+"\\n";
for(let i=0;i<130*16;i++){if(!process.stdout.write(update))await new Promise(r=>process.stdout.once("drain",r));}
process.stdout.write([{type:"message_end",message},{type:"agent_end",isTerminal:true}].map(r=>JSON.stringify(r)).join("\\n")+"\\n");
})();
`, { mode: 0o700 });
    const config: MaterializedAgentConfigV1 = {
      schema: "ccloop-agent-config-v1", kind: "omp",
      installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 120_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
      selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
    };
    const outcome = await runOmpPhase(config, "plan", "prompt", { ...f.context, state: { ...f.context.state, budgetSnapshot: { ...f.context.state.budgetSnapshot, timeRemainingMs: 120_000 } } });
    expect(outcome.reason).toBe("completed");
    expect(outcome.stream.phase!.value()).toMatchObject({ summary: "big", tokenUsage: 14 });
    await expectCapped(outcome.evidenceDir);
  }, 150_000);
});
