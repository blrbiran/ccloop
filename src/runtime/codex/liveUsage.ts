import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { CodexPhase } from "./protocol.js";
import { codexConfigFileArgs } from "../../agents/codexIsolation.js";
import { causeDetail } from "../failureCause.js";

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
  // `source`: the installation's own CODEX_HOME the private one links to (Orca tester #349: the delete's config-file pair).
  constructor(private readonly home: string, private readonly command: string[], private readonly env: NodeJS.ProcessEnv,
    private readonly evidenceDir: string, private readonly identity: {runId: string; attempt: number; phase: CodexPhase},
    private readonly onUsage?: (tokens: number) => void, private readonly source: string | null = null) {}
  started(value: unknown): void {
    if (!record(value) || value.type !== "thread.started" || typeof value.thread_id !== "string" || !uuid.test(value.thread_id)) return;
    if (this.id !== null) return;
    this.id = value.thread_id;
    // Durable before the callback or next poll; crash cleanup can discover this UUID after process reaping.
    writeFileSync(join(this.evidenceDir, "thread.json"), JSON.stringify({threadId:this.id, codexHome:this.home,
      command:this.command,home:this.env.HOME,sourceCodexHome:this.source}), {mode:0o600});
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
  get watermark(): number | null { return this.tokens > 0 ? this.tokens : null; }
  async finish(): Promise<number | null> {
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
    if (this.id === null) return null;
    // A broken rollout read must never skip deletion of the identified session.
    // Orca tester #349 (human's ruling, session 4389b15f, 2026-11-18): a failed deletion never changes the phase's outcome;
    // it is recorded beside the call (session-cleanup-failed.json) for collect and the next sweep.
    await settleDeletion(this.evidenceDir,null,this.home,this.command,this.source,this.env,this.id);
    if (observationError !== undefined) throw observationError;
    return this.watermark;
  }
}

/** Orca tester #349: one recorded deletion failure (session-cleanup-failed.json beside the call's thread.json). */
export type SessionCleanupFailureV1 = { schema:"ccloop-session-cleanup-failed-v1"; threadId:string; home:string; command:string[];
  exitCode:number|null; signal:string|null; stderr:string; detail:string; state:"failed"|"retry-failed"; at:string;
  /** Orca #349 review: the HOME the delete ran with (the private one), so a person's manual delete runs as ccloop's did. */
  userHome:string|null };
const FAILED="session-cleanup-failed.json";

/**
 * Orca tester #349: the delete loads the private CODEX_HOME's config.toml -- a link to the installation's -- so it needs
 * the same config-file `-c` pair the phase got (codexConfigFileArgs, Orca issue 121), read now from the source home it
 * links to. Without it, a relative `model_catalog_json` fails the delete with "failed to load configuration" (codex-cli
 * 0.167.0, measured Orca session 4389b15f) while every phase ran. A source config whose catalog file is missing gives no
 * pair: the delete then fails and is recorded like any other.
 */
async function deleteSession(home:string,command:string[],source:string|null,env:NodeJS.ProcessEnv,id:string):
  Promise<{ok:true}|{ok:false;command:string[];exitCode:number|null;signal:string|null;stderr:string}> {
  if (!uuid.test(id)) throw new Error("codex-session-id-invalid");
  const argv=[...command.slice(1),...await codexConfigFileArgs(source).catch(()=>[]),"delete","--force",id];
  let failure:{exitCode:number|null;signal:string|null;stderr:string}|null=null;
  try { await exec(command[0]!,argv,{env,timeout:10_000,maxBuffer:1024*1024}); }
  catch (error) {
    const e=error as {code?:unknown;signal?:unknown;stderr?:unknown;message?:unknown};
    failure={exitCode:typeof e.code==="number"?e.code:null,signal:typeof e.signal==="string"?e.signal:null,
      stderr:causeDetail(typeof e.stderr==="string"&&e.stderr!==""?e.stderr:String(e.message))};
  }
  // The deletion's proof is the rollout being gone, whatever the command answered (a thread codex never persisted here
  // has nothing to delete; codex then exits 1 "failed to delete session").
  // Orca #349 review: a sessions directory that cannot be read proves nothing either way, so it is a recorded failure
  // (retried as any other), never a throw that would end the phase or the sweep.
  let unreadable:string|null=null;
  try { if (rollout(home,id)===null) return {ok:true}; } catch (error) { unreadable=String(error); }
  return {ok:false,command:[command[0]!,...argv],...(failure??{exitCode:0,signal:null,
    stderr:causeDetail(unreadable!==null?`codex-session-rollout-unreadable: ${unreadable}`:`codex-session-delete-unverified: ${id}`)})};
}

/** Deletes the session and writes session-cleaned.json, or records the failure as `failed` (no prior record) or `retry-failed`. */
async function settleDeletion(dir:string,prior:SessionCleanupFailureV1|null,home:string,command:string[],source:string|null,env:NodeJS.ProcessEnv,id:string):Promise<void> {
  const result=await deleteSession(home,command,source,env,id);
  if (result.ok) { await writeFile(join(dir,"session-cleaned.json"),JSON.stringify({threadId:id}),{mode:0o600}); return; }
  const how=result.exitCode!==null?`exit ${result.exitCode}`:result.signal!==null?`signal ${result.signal}`:"not run";
  const record:SessionCleanupFailureV1={schema:"ccloop-session-cleanup-failed-v1",threadId:id,home,command:result.command,exitCode:result.exitCode,
    signal:result.signal,stderr:result.stderr,detail:causeDetail(`${how}: ${result.stderr.trim()}`),state:prior===null?"failed":"retry-failed",at:new Date().toISOString(),
    userHome:typeof env.HOME==="string"?env.HOME:null};
  const tmp=join(dir,`${FAILED}.tmp`);
  await writeFile(tmp,JSON.stringify(record),{mode:0o600});
  renameSync(tmp,join(dir,FAILED));
}

/** The call's recorded deletion failure, or null when there is none or it is not one this code wrote. */
export function readCleanupFailure(dir:string):SessionCleanupFailureV1|null {
  let value:unknown;
  try { value=JSON.parse(readFileSync(join(dir,FAILED),"utf8")); } catch { return null; }
  if (!record(value)||value.schema!=="ccloop-session-cleanup-failed-v1"||typeof value.threadId!=="string"||!uuid.test(value.threadId)||
    typeof value.home!=="string"||!isAbsolute(value.home)||(value.state!=="failed"&&value.state!=="retry-failed")||typeof value.detail!=="string") return null;
  return value as SessionCleanupFailureV1;
}

/** Orca tester #349: whether the session's rollout is still in its private home (a person may have deleted it by hand). */
export function sessionRemains(home:string,id:string):boolean { return uuid.test(id)&&rollout(home,id)!==null; }

/**
 * Called only after reaping all run processes; never sweep another run's or another thread's sessions.
 * Orca tester #349 (human's ruling, session 4389b15f, 2026-11-18): a deletion that fails is recorded, never thrown; a
 * recorded `failed` deletion is retried once, and a second failure is `retry-failed` -- never retried automatically again.
 * `failedOnly` (the run's next codex phase, while no process of the run is reaped): only calls with a recorded failure,
 * whose own deletion already ran, are touched.
 */
/**
 * Orca #349 review: the run's end retries, once, every deletion still recorded as `failed` -- the last phase's included,
 * which no later phase would retry. Called after the run's last phase returned (its codex process closed) and before the
 * run's result is handed off. Housekeeping: it never changes the run's outcome.
 */
export async function retryFailedSessionDeletions(runDir:string):Promise<void> {
  await sweepCodexSessions(runDir,{failedOnly:true}).catch((error:unknown)=>{process.stderr.write(`ccloop-codex-session-retry: ${String(error)}\n`);});
}

export async function sweepCodexSessions(runDir:string,options:{failedOnly?:boolean}={}):Promise<void> {
  const root=join(runDir,"codex");
  let attempts:string[];
  try {attempts=await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  for (const attempt of attempts) for (const phase of ["plan","execute","verify"]) {
    let calls:string[];
    try {calls=await readdir(join(root,attempt,phase));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
    for (const call of calls) {
      const dir=join(root,attempt,phase,call),file=join(dir,"thread.json");
      if (!call.startsWith("call-") || !existsSync(file) || existsSync(join(dir,"session-cleaned.json"))) continue;
      const prior=readCleanupFailure(dir);
      if (prior?.state==="retry-failed" || (options.failedOnly===true && prior===null)) continue;
      const value:unknown=JSON.parse(readFileSync(file,"utf8"));
      if (!record(value)||typeof value.threadId!=="string"||!uuid.test(value.threadId)||typeof value.codexHome!=="string"||
        !isAbsolute(value.codexHome)||basename(value.codexHome)!=="codex-home"||typeof value.home!=="string"||value.home!==join(dirname(value.codexHome),"home")||
        !Array.isArray(value.command)||!value.command.every(v=>typeof v==="string")||!isAbsolute(value.command[0])||
        // Orca tester #349: the installation's source CODEX_HOME (absent in a record written before it was kept).
        (value.sourceCodexHome!==undefined&&value.sourceCodexHome!==null&&(typeof value.sourceCodexHome!=="string"||!isAbsolute(value.sourceCodexHome)))) throw new Error("codex-session-cleanup-invalid");
      // A worker crash has no outcome.json; thread.json was written synchronously on thread.started before the crash.
      if (existsSync(join(dir,"outcome.json"))) {
        const outcome:unknown=JSON.parse(readFileSync(join(dir,"outcome.json"),"utf8"));
        if (!record(outcome)||!record(outcome.isolation)||outcome.isolation.codexHome!==value.codexHome||outcome.isolation.home!==value.home) throw new Error("codex-session-cleanup-isolation-invalid");
      }
      await settleDeletion(dir,prior,value.codexHome,value.command,typeof value.sourceCodexHome==="string"?value.sourceCodexHome:null,
        {...process.env,CODEX_HOME:value.codexHome,HOME:value.home},value.threadId);
    }
  }
}
