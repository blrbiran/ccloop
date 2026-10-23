import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompDescriptor } from "../../../src/agents/omp.js";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { decodeOmpPhase } from "../../../src/runtime/omp/ompProtocol.js";
import { runOmpPhase } from "../../../src/runtime/omp/runOmpPhase.js";
import { codexFixture } from "../codex/fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(mode = "normal") {
  const f = await codexFixture();
  roots.push(f.dir);
  const marker = join(f.dir, "omp-call.json");
  const ready = `${marker}.ready`;
  const registered = join(f.dir, "registered.json");
  const binary = join(f.dir, "omp");
  await writeFile(binary, `#!/usr/bin/env node
import {existsSync,readFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
const mode=${JSON.stringify(mode)};
let prompt="";
for await(const chunk of process.stdin) prompt+=chunk.toString();
if(mode==="registration-required" && !existsSync(${JSON.stringify(registered)}))process.exit(3);
const promptIndex=args.indexOf("--system-prompt");
const systemPrompt=readFileSync(args[promptIndex+1],"utf8");
writeFileSync(${JSON.stringify(marker)},JSON.stringify({args,prompt,systemPrompt}));
let result;
if(mode==="plan-mutates" && systemPrompt.includes("planning phase"))writeFileSync("answer.txt","99\\n");
if(mode==="plan-untracked" && systemPrompt.includes("planning phase"))writeFileSync("stray.txt","not part of plan\\n");
if(mode==="verify-mutates" && systemPrompt.includes("verification phase"))writeFileSync("answer.txt","0\\n");
if(systemPrompt.includes("execution phase")){
  writeFileSync("answer.txt","42\\n");
  result={changedFiles:["answer.txt"],diffPatch:"",commandOutputs:[],stdoutStderrLog:"changed answer"};
}else if(systemPrompt.includes("verification phase")){
  result={approved:true,rejectCategory:"",primaryTargetPaths:["answer.txt"],failingCommand:null,safeToRetry:false,evidence:["answer is 42"],pauseSignals:[],stopSignals:[]};
}else result={summary:"Edit answer.txt once",primaryTargetPaths:["answer.txt"]};
const message={role:"assistant",content:[{type:"text",text:JSON.stringify(result)}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:8,output:2,cacheRead:3,cacheWrite:1,totalTokens:14,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
if(mode==="plan-usage-hang" && systemPrompt.includes("planning phase")){
  process.stdout.write(JSON.stringify({type:"message_end",message})+"\\n",()=>writeFileSync(${JSON.stringify(ready)},"ready"));
  setInterval(()=>{},1000);
}else for(const row of [{type:"session",id:"fake"},{type:"agent_start"},{type:"message_end",message},{type:"agent_end",isTerminal:true,yielded:true,messages:[message]}])process.stdout.write(JSON.stringify(row)+"\\n");
if(mode==="nonzero" && systemPrompt.includes("planning phase"))process.exitCode=7;
`, { mode: 0o700 });
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "omp",
    installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
    selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" },
  };
  return { ...f, marker, ready, registered, binary, config };
}

describe("OMP runtime phase", () => {
  it("plans one attempt with a frozen model, scoped tools, private system prompt and observed usage", async () => {
    const f = await fixture();
    const plan = await ompDescriptor.createAdapter(f.config).plan(f.context);
    expect(plan).toMatchObject({
      summary: "Edit answer.txt once", primaryTargetPaths: ["answer.txt"], tokenUsage: 14,
      usageEvidence: { usageStatus: "present", normalizedTotal: 14 },
      modelUsage: [{ model: "gateway/model-a", input: 8, output: 2, cacheRead: 3, cacheWrite: 1 }],
    });
    const observed = JSON.parse(await readFile(f.marker, "utf8")) as { args: string[]; prompt: string; systemPrompt: string };
    expect(observed.args).toContain("--no-extensions");
    expect(observed.args).toContain("--no-session");
    expect(observed.args).toContain("gateway/model-a");
    expect(observed.args).toContain("read,grep,glob");
    expect(observed.args).not.toContain(observed.prompt);
    expect(observed.prompt).toContain("Plan one isolated L2 attempt");
    expect(observed.systemPrompt).toContain("planning phase");
  });

  it("executes only the attempt's allowed file and then verifies it as separate phases", async () => {
    const f = await fixture();
    const adapter = ompDescriptor.createAdapter(f.config);
    const execution = await adapter.execute(f.context);
    expect(execution).toMatchObject({ changedFiles: ["answer.txt"], tokenUsage: 14 });
    expect(await readFile(join(f.repo, "answer.txt"), "utf8")).toBe("42\n");
    const verification = await adapter.verify({ ...f.context, execution: execution! });
    expect(verification).toMatchObject({ approved: true, tokenUsage: 14, evidence: ["answer is 42"] });
  });

  it("refuses a plan that changed tracked worktree bytes despite returning valid JSON", async () => {
    const f = await fixture("plan-mutates");
    await expect(ompDescriptor.createAdapter(f.config).plan(f.context)).rejects.toThrow("omp-read-only-phase-mutated");
    expect(await readFile(join(f.repo, "answer.txt"), "utf8")).toBe("99\n");
  });

  it("refuses a verifier that edits the already-dirty execution worktree", async () => {
    const f = await fixture("verify-mutates");
    const adapter = ompDescriptor.createAdapter(f.config);
    const execution = await adapter.execute(f.context);
    expect(await readFile(join(f.repo, "answer.txt"), "utf8")).toBe("42\n");
    await expect(adapter.verify({ ...f.context, execution: execution! })).rejects.toThrow("omp-read-only-phase-mutated");
    expect(await readFile(join(f.repo, "answer.txt"), "utf8")).toBe("0\n");
  });

  it("refuses an untracked file a planning phase created", async () => {
    const f = await fixture("plan-untracked");
    await expect(ompDescriptor.createAdapter(f.config).plan(f.context)).rejects.toThrow("omp-read-only-phase-mutated");
    expect(await readFile(join(f.repo, "stray.txt"), "utf8")).toBe("not part of plan\n");
  });

  it("does not accept valid-looking JSON from an OMP process that exited nonzero", async () => {
    const f = await fixture("nonzero");
    await expect(ompDescriptor.createAdapter(f.config).plan(f.context)).rejects.toThrow("omp-exit-error");
  });

  it("refuses a second assistant answer after the phase already returned its final JSON", () => {
    const message = {
      role: "assistant", content: [{ type: "text", text: JSON.stringify({ summary: "one plan", primaryTargetPaths: ["answer.txt"] }) }],
      provider: "gateway", model: "model-a", stopReason: "stop",
      usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    };
    const events = [
      { type: "agent_start" },
      { type: "message_end", message },
      { type: "message_end", message: { ...message, content: [{ type: "text", text: JSON.stringify({ summary: "a second task", primaryTargetPaths: ["answer.txt"] }) }] } },
      { type: "agent_end", isTerminal: true, yielded: true, messages: [message] },
    ].map((row) => JSON.stringify(row)).join("\n");
    expect(() => decodeOmpPhase("plan", events, "gateway/model-a")).toThrow("omp-phase-continuation");
  });

  it("refuses an orphan tool-end event that could hide a forbidden plan command", () => {
    const message = {
      role: "assistant", content: [{ type: "text", text: JSON.stringify({ summary: "plan", primaryTargetPaths: ["answer.txt"] }) }],
      provider: "gateway", model: "model-a", stopReason: "stop",
      usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    };
    const events = [
      { type: "agent_start" },
      { type: "tool_execution_end", toolCallId: "hidden", toolName: "bash", result: { content: [] } },
      { type: "message_end", message },
      { type: "agent_end", isTerminal: true, yielded: true, messages: [message] },
    ].map((row) => JSON.stringify(row)).join("\n");
    expect(() => decodeOmpPhase("plan", events, "gateway/model-a")).toThrow("omp-phase-tool-forbidden");
  });

  it("keeps exact completed-message usage when OMP ends with a model error", () => {
    const message = {
      role: "assistant", content: [{ type: "text", text: "provider rejected" }],
      provider: "gateway", model: "model-a", stopReason: "error",
      usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    };
    const events = [
      { type: "agent_start" }, { type: "message_end", message },
      { type: "agent_end", isTerminal: true, yielded: true, messages: [message] },
    ].map((row) => JSON.stringify(row)).join("\n");
    let failure: unknown;
    try { decodeOmpPhase("plan", events, "gateway/model-a"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ observedTokens: 10 });
  });

  it("keeps a stopped phase's completed-message tokens diagnostic, never exact control usage", async () => {
    const f = await fixture("plan-usage-hang");
    const controller = new AbortController();
    const pending = ompDescriptor.createAdapter(f.config).plan({ ...f.context, abortSignal: controller.signal });
    await expect.poll(() => readFile(f.ready, "utf8").catch(() => "")).toBe("ready");
    controller.abort();
    let failure: unknown;
    try { await pending; } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty("observedTokens");
    const evidenceDir = (failure as Error).message.split("omp-aborted: ")[1];
    expect(JSON.parse(await readFile(join(evidenceDir, "usage-lower-bound.json"), "utf8"))).toEqual({ tokens: 14 });
  });

  it("registers the process identity before the fake CLI can receive its prompt", async () => {
    const f = await fixture("registration-required");
    const plan = await ompDescriptor.createAdapter(f.config).plan({ ...f.context, onProcessRegistered: async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(f.registered, JSON.stringify(record), { mode: 0o600 });
    } });
    expect(plan.summary).toBe("Edit answer.txt once");
    expect(JSON.parse(await readFile(f.registered, "utf8"))).toMatchObject({ phase: "plan", pid: expect.any(Number), pgid: expect.any(Number) });
  });

  it("rejects a successful-looking answer from a different model while preserving its exact spend", () => {
    const message = {
      role: "assistant", content: [{ type: "text", text: JSON.stringify({ summary: "plan", primaryTargetPaths: ["answer.txt"] }) }],
      provider: "other", model: "model-b", stopReason: "stop",
      usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    };
    const events = [
      { type: "agent_start" }, { type: "message_end", message },
      { type: "agent_end", isTerminal: true, yielded: true, messages: [message] },
    ].map((row) => JSON.stringify(row)).join("\n");
    let failure: unknown;
    try { decodeOmpPhase("plan", events, "gateway/model-a"); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "omp-model-mismatch", observedTokens: 10 });
  });

  it("reaps a TERM-ignoring grandchild when an OMP phase times out", async () => {
    const f = await fixture();
    const pidPath = join(f.dir, "grandchild.pid");
    await writeFile(f.binary, `#!/usr/bin/env node
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
for await(const chunk of process.stdin){}
const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
writeFileSync(${JSON.stringify(pidPath)},String(child.pid));
setInterval(()=>{},1000);
`, { mode: 0o700 });
    const config = { ...f.config, installation: { ...f.config.installation, timeoutMs: 1000, killGraceMs: 50 } };
    const outcome = await runOmpPhase(config, "plan", "prompt", f.context);
    expect(outcome.reason).toBe("timeout");
    const pid = Number(await readFile(pidPath, "utf8"));
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  });

  // Human ruling (2026-10-13, session 808feb6a): the fake has no import, so Node 22 parses it as CommonJS and a
  // top-level for-await is a SyntaxError; the body is wrapped so the criterion no longer depends on PATH's node.
  // Ruling O5 (Orca session 0e13a9b7): 「同意。但是我们这里可能要定一下最大能支持多大的输出。作为一个hard limit ，比如1G」, Orca spec
  // 2026-10-23-live-transcript-design.md §11.2 (a): a call printing past 16 MiB and under 1 GiB completes; events.jsonl stays
  // capped at 16 MiB (cut at a line end, labelled stdoutTruncated) and transcript.jsonl (cap 128 MiB) holds the whole stream.
  it("completes an event stream past 16 MiB and under 1 GiB, its evidence capped and its transcript whole", async () => {
    const f = await fixture();
    await writeFile(f.binary, `#!/usr/bin/env node
(async()=>{
for await(const chunk of process.stdin){}
const message={role:"assistant",content:[{type:"text",text:JSON.stringify({summary:"big",primaryTargetPaths:[]})}],provider:"gateway",model:"model-a",stopReason:"stop",usage:{input:8,output:2,cacheRead:3,cacheWrite:1,totalTokens:14}};
const update=JSON.stringify({type:"message_update",delta:"u".repeat(64*1024)})+"\\n";
for(let i=0;i<17*16+1;i++){if(!process.stdout.write(update))await new Promise(r=>process.stdout.once("drain",r));}
process.stdout.write([{type:"message_end",message},{type:"agent_end",isTerminal:true}].map(r=>JSON.stringify(r)).join("\\n")+"\\n");
})();
`, { mode: 0o700 });
    const outcome = await runOmpPhase(f.config, "plan", "prompt", f.context);
    expect(outcome.reason).toBe("completed");
    expect(outcome.stream.phase!.value()).toMatchObject({ summary: "big", tokenUsage: 14 });
    const events = await readFile(join(outcome.evidenceDir, "events.jsonl")), transcript = await readFile(join(outcome.evidenceDir, "transcript.jsonl"));
    expect(transcript.length).toBeGreaterThan(17 * 1024 * 1024); expect(transcript.at(-1)).toBe(10);
    expect(events.length).toBeLessThanOrEqual(16 * 1024 * 1024); expect(events.length).toBeGreaterThan(15 * 1024 * 1024); expect(events.at(-1)).toBe(10);
    expect(transcript.subarray(0, events.length).equals(events)).toBe(true);
    expect(JSON.parse(await readFile(join(outcome.evidenceDir, "outcome.json"), "utf8"))).toMatchObject({ reason: "completed", stdoutTruncated: true, transcriptTruncatedAt: null });
  }, 30000);

  // Ruling O5 (as above), spec §11.2 (b): a call whose stdout passes 1 GiB is stopped with output-limit.
  it("stops an event stream past 1 GiB with output-limit", async () => {
    const f = await fixture();
    await writeFile(f.binary, `#!/usr/bin/env node
(async()=>{
for await(const chunk of process.stdin){}
const block=Buffer.alloc(1024*1024,0x78);
const pump=()=>{while(process.stdout.write(block));process.stdout.once("drain",pump);};pump();
})();
`, { mode: 0o700 });
    const config = { ...f.config, installation: { ...f.config.installation, timeoutMs: 120_000 } };
    const outcome = await runOmpPhase(config, "plan", "prompt", { ...f.context, state: { ...f.context.state, budgetSnapshot: { ...f.context.state.budgetSnapshot, timeRemainingMs: 120_000 } } });
    expect(outcome.reason).toBe("output-limit");
    expect(JSON.parse(await readFile(join(outcome.evidenceDir, "outcome.json"), "utf8"))).toMatchObject({ reason: "output-limit", stdoutTruncated: true });
  }, 150_000);
});
