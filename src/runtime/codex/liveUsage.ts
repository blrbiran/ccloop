import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { CodexPhase } from "./protocol.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exec = promisify(execFile);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export type LiveUsage = { schema: "ccloop-live-usage-v1"; runId: string; attempt: number; phase: CodexPhase; callId: string;
  threadId: string; tokens: number; observedAt: string; revision: number };

// The filename must end in the exact thread UUID from this call's stdout. Never use newest-file selection.
function rollout(home: string, id: string): string | null {
  const root = join(home, "sessions");
  try {
    for (const item of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!item.isFile() || !item.name.startsWith("rollout-") || !item.name.endsWith(`-${id}.jsonl`)) continue;
      const path = join(item.parentPath, item.name);
      if (lstatSync(path).isFile()) return path;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return null;
}

export class CodexLiveObserver {
  private id: string | null = null;
  private offset = 0;
  private path: string | null = null;
  private pending = "";
  private decoder = new StringDecoder("utf8");
  private tokens = 0;
  private revision = 0;
  private polling = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  constructor(private readonly home: string, private readonly command: string[], private readonly env: NodeJS.ProcessEnv,
    private readonly evidenceDir: string, private readonly identity: {runId: string; attempt: number; phase: CodexPhase},
    private readonly onUsage?: (tokens: number) => void) {}
  started(value: unknown): void {
    if (!record(value) || value.type !== "thread.started" || typeof value.thread_id !== "string" || !uuid.test(value.thread_id)) return;
    if (this.id !== null) return;
    this.id = value.thread_id;
    // Durable before the callback or next poll; crash cleanup can discover this UUID after process reaping.
    writeFileSync(join(this.evidenceDir, "thread.json"), JSON.stringify({threadId:this.id, codexHome:this.home,
      command:this.command,home:this.env.HOME}), {mode:0o600});
    this.timer = setInterval(() => { void this.poll().catch(() => undefined); }, 50);
    void this.poll().catch(() => undefined);
  }
  async poll(): Promise<void> {
    if (this.polling || this.id === null || this.stopped) return;
    this.polling = true;
    try {
      const path = this.path ?? rollout(this.home, this.id);
      if (path === null) return;
      this.path = path;
      const fd = openSync(path, "r");
      try {
        const chunk = Buffer.alloc(65536);
        let count: number, scanned=0;
        // Keep timers and abort responsive when a response contains a large transcript.
        while (scanned < 4*1024*1024 && (count = readSync(fd, chunk, 0, chunk.length, this.offset)) > 0) {
          scanned += count;this.offset += count;
          this.pending += this.decoder.write(chunk.subarray(0,count));
          let end: number;
          while ((end = this.pending.indexOf("\n")) !== -1) {
            const line = this.pending.slice(0,end);this.pending = this.pending.slice(end+1);
            if (line.length > 2*1024*1024) continue;
            let event: unknown;
            try { event = JSON.parse(line); } catch { continue; }
            if (!record(event) || event.type !== "event_msg" || !record(event.payload) || event.payload.type !== "token_count" || !record(event.payload.info) || !record(event.payload.info.total_token_usage)) continue;
            const total = event.payload.info.total_token_usage.total_tokens;
            if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= this.tokens) continue;
            this.tokens = total;
            const usage: LiveUsage = {schema:"ccloop-live-usage-v1",...this.identity,callId:basename(this.evidenceDir),threadId:this.id!,tokens:total,
              observedAt:new Date().toISOString(),revision:++this.revision};
            // Atomic publication; collect never sees a partial JSON document.
            const tmp=join(this.evidenceDir,"live-usage.tmp");
            writeFileSync(tmp,JSON.stringify(usage),{mode:0o600});
            renameSync(tmp,join(this.evidenceDir,"live-usage.json"));
            this.onUsage?.(total);
          }
          if (this.pending.length > 2*1024*1024) this.pending="";
        }
      } finally { closeSync(fd); }
    } finally { this.polling = false; }
  }
  async finish(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.polling) await new Promise(resolve=>setTimeout(resolve,10));
    let observationError: unknown;
    try {
      await this.poll();
      while (this.path !== null && statSync(this.path).size > this.offset) {
        await new Promise(resolve=>setImmediate(resolve));
        await this.poll();
      }
    } catch(error) { observationError=error; }
    this.stopped=true;
    if (this.id === null) return;
    // A broken rollout read must never skip deletion of the identified session.
    await deleteSession(this.home,this.command,this.env,this.id);
    await writeFile(join(this.evidenceDir,"session-cleaned.json"),JSON.stringify({threadId:this.id}),{mode:0o600});
    if (observationError !== undefined) throw observationError;
  }
}

async function deleteSession(home:string,command:string[],env:NodeJS.ProcessEnv,id:string):Promise<void> {
  if (!uuid.test(id)) throw new Error("codex-session-id-invalid");
  try { await exec(command[0]!,[...command.slice(1),"delete","--force",id],{env,timeout:10_000,maxBuffer:1024*1024}); }
  catch (error) { throw new Error(`codex-session-delete-failed: ${String(error)}`); }
  if (rollout(home,id)!==null) throw new Error(`codex-session-delete-unverified: ${id}`);
}

/** Called only after reaping all run processes; never sweep another run's or another thread's sessions. */
export async function sweepCodexSessions(runDir:string):Promise<void> {
  const root=join(runDir,"codex");
  let attempts:string[];
  try {attempts=await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  for (const attempt of attempts) for (const phase of ["plan","execute","verify"]) {
    let calls:string[];
    try {calls=await readdir(join(root,attempt,phase));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
    for (const call of calls) {
      const dir=join(root,attempt,phase,call),file=join(dir,"thread.json");
      if (!call.startsWith("call-") || !existsSync(file) || existsSync(join(dir,"session-cleaned.json"))) continue;
      const value:unknown=JSON.parse(readFileSync(file,"utf8"));
      if (!record(value)||typeof value.threadId!=="string"||!uuid.test(value.threadId)||typeof value.codexHome!=="string"||
        !isAbsolute(value.codexHome)||basename(value.codexHome)!=="codex-home"||typeof value.home!=="string"||value.home!==join(dirname(value.codexHome),"home")||
        !Array.isArray(value.command)||!value.command.every(v=>typeof v==="string")||!isAbsolute(value.command[0])) throw new Error("codex-session-cleanup-invalid");
      // A worker crash has no outcome.json; thread.json was written synchronously on thread.started before the crash.
      if (existsSync(join(dir,"outcome.json"))) {
        const outcome:unknown=JSON.parse(readFileSync(join(dir,"outcome.json"),"utf8"));
        if (!record(outcome)||!record(outcome.isolation)||outcome.isolation.codexHome!==value.codexHome||outcome.isolation.home!==value.home) throw new Error("codex-session-cleanup-isolation-invalid");
      }
      await deleteSession(value.codexHome,value.command,{...process.env,CODEX_HOME:value.codexHome,HOME:value.home},value.threadId);
      await writeFile(join(dir,"session-cleaned.json"),JSON.stringify({threadId:value.threadId}),{mode:0o600});
    }
  }
}
