import { execFile, spawn } from "node:child_process";
import { appendFileSync, constants } from "node:fs";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { readAgentCatalog } from "../../agents/agentCatalog.js";
import type { InstallationV1 } from "../../agents/types.js";
import { CodexPhaseIsolationRefused, codexPhaseIsolation } from "./codexPhaseIsolation.js";
import { withCodexSkillLinks } from "./codexSkills.js";
import type { AttemptContext } from "../types.js";
import { codexToolRow, effectiveIdleTimeoutMs, IdleWatch, type IdleSnapshotV1 } from "../idleWatch.js";
import { attachOutcomeStream, CappedLineFile, jsonLine, LineSplitter, STDOUT_HARD_LIMIT, TRANSCRIPT_LIMIT, transcriptMarker } from "../streamLines.js";
import { CodexStream } from "./codexStream.js";
import { executeWireJsonSchema, phaseJsonSchema, type CodexConfig, type CodexPhase } from "./protocol.js";
import { codexToolRuleNetworkSetting } from "../../agents/codexNetworkConfig.js";
import { codexToolRuleArgs } from "../toolRules.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §6.1): a single call brings its own argv, environment and schema.
export type PhaseRequest = {phase:CodexPhase|"single-call";prompt:string;context:AttemptContext;
  spawn?:{args:(paths:{schemaPath:string;finalPath:string})=>string[];env:NodeJS.ProcessEnv;schema:Record<string,unknown>}};
export type PhaseOutcome = {
  reason:"completed"|"aborted"|"timeout"|"stalled"|"spawn-error"|"exit-error"|"output-limit"|"io-error"|`codex-skills-${string}`|`codex-phase-isolation-${string}`;
  code:number|null;signal:NodeJS.Signals|null;final:string|null;evidenceDir:string;
  /**
   * Live transcript (Orca spec 2026-10-23 §10.2.3): the call's stdout as the adapter reads it, folded line by line while the
   * call ran; the stream itself is never kept. Not enumerable, so outcome.json is unchanged.
   */
  readonly stream:CodexStream;
  /**
   * The recorded events.jsonl evidence (at most 16 MiB, cut at a line end), read from disk on access (plan D4). It equals
   * the call's stdout whenever that was under 16 MiB. No ccloop code reads it; the decoders read `stream`. Not enumerable.
   */
  readonly events:string;
  // Orca handoff delivery C-3: usage observed in the stdout of a phase that did not complete; null otherwise.
  observedTokens:number|null;
  // Failure causes (ccloop spec 2026-10-21 §3 "Every kind"): the errno of a spawn that failed, so ENOENT is executable-missing.
  spawnErrno?:string;
};
const LIMIT=16*1024*1024;
const execFileAsync=promisify(execFile);
// Codex phase isolation (ccloop spec 2026-10-18 §3.3, Orca session 3d229487): with an `installation` (production, through
// codexDescriptor.createAdapter) a phase reads the installation's catalog under its own deadline and runs in the single
// call's private HOME/CODEX_HOME pair with CODEX_PHASE_CONFIG, the MCP servers off and the real HOME for its commands, or is
// refused before spawn (`codex-phase-isolation-*`, outcome.json names it). Without one (the legacy path and every single
// call, which brings its own spawn) nothing changes.
export async function runCodexPhase(config:CodexConfig, request:PhaseRequest, extraEnv?:Record<string,string>, codexSkillsDir?:string, installation?:InstallationV1):Promise<PhaseOutcome> {
  const {context,phase}=request;
  const root=join(context.runDir,"codex",String(context.attempt),phase);
  await mkdir(root,{recursive:true,mode:0o700});
  const evidenceDir=await mkdtemp(join(root,"call-"));
  const stream=new CodexStream();
  const result=attachOutcomeStream({reason:"completed",code:null,signal:null,final:null,evidenceDir,observedTokens:null} as PhaseOutcome,evidenceDir,stream);
  let transcriptTruncatedAt:number|null=null;
  const save=async(name:string,data:string)=>writeFile(join(evidenceDir,name),data,{mode:0o600});
  const schemaPath=join(evidenceDir,"schema.json"),finalPath=join(evidenceDir,"final.json");
  const args=request.spawn!==undefined?[...config.command.slice(1),...request.spawn.args({schemaPath,finalPath})]:[...config.command.slice(1),"exec","--json","--ephemeral","--color","never","--model",config.model,
    "--sandbox",phase==="execute"?config.sandbox:"read-only","-C",context.worktreePath,
    "--output-schema",schemaPath,"-o",finalPath,"-"];
  let isolation:{home:string|null;codexHome:string|null;catalogError:string|null}|undefined;
  let spawnEnv:NodeJS.ProcessEnv={...process.env,...extraEnv};
  let stderr="", logsCreated=false;
  let ioError:string|undefined;
  let stdoutTruncated=false,stderrTruncated=false,finalTruncated=false;
  // Activity watchdog (spec 2026-10-21 §2.3): recorded in outcome.json when the call was stopped as stalled.
  let idle:IdleSnapshotV1|null=null;
  const persist=async()=>{
    if(!logsCreated){await save("events.jsonl","");await save("transcript.jsonl","");await save("stderr.log",stderr);}
    await save("outcome.json",JSON.stringify({...result,final:undefined,executable:config.command[0],args,ioError,stdoutTruncated,stderrTruncated,finalTruncated,transcriptTruncatedAt,...(isolation===undefined?{}:{isolation}),...(result.reason==="stalled"&&idle!==null?{idle}:{})},null,2));
    return result;
  };
  if(context.abortSignal?.aborted){result.reason="aborted";return persist();}
  const timeout=Math.min(config.timeoutMs,context.state.budgetSnapshot.timeRemainingMs);
  if(timeout<=0){result.reason="timeout";return persist();}
  let childTimeout=timeout;
  if(installation!==undefined) {
    // Spec §3.3 "Where the MCP list comes from": read on every phase through the catalog cache, inside the phase deadline.
    // An abort or the deadline landing during the read is reported as such, not as a refusal (plan Review Focus 5).
    const deadline=Date.now()+timeout;
    const catalog=await readAgentCatalog(installation,{deadline,signal:context.abortSignal,log:line=>{process.stderr.write(line+"\n");}});
    isolation={home:null,codexHome:null,catalogError:catalog.catalogError};
    if(context.abortSignal?.aborted){result.reason="aborted";return persist();}
    if(Date.now()>=deadline){result.reason="timeout";return persist();}
    try {
      const isolated=await codexPhaseIsolation({installation,mcpServers:catalog.codexMcpServers,runDir:context.runDir,attempt:context.attempt,env:process.env});
      isolation={home:isolated.home,codexHome:isolated.codexHome,catalogError:catalog.catalogError};
      args.splice(args.length-1,0,...isolated.args);
      spawnEnv={...spawnEnv,HOME:isolated.home,CODEX_HOME:isolated.codexHome};
    } catch(error) {
      if(!(error instanceof CodexPhaseIsolationRefused))throw error;
      // Spec §3.5: refused before spawn and before any skill link (plan Review Focus 3); final, booked 0 by the adapter.
      isolation={home:error.pair?.home??null,codexHome:error.pair?.codexHome??null,catalogError:catalog.catalogError};
      result.reason=error.reason;return persist();
    }
    childTimeout=deadline-Date.now();
  }
  // Per-contract tool rules (spec 2026-10-22 §4 codex): the rules' -c pairs join the phase's, before the trailing `-`.
  // The person's config.toml is read only when it decides something (network:true on a workspace-write execute).
  const toolRules=request.spawn===undefined?context.contract?.executionPolicy?.toolRules:undefined;
  if(toolRules!==undefined&&phase!=="single-call") {
    const setting=await codexToolRuleNetworkSetting(toolRules.network,phase,config.sandbox,installation,extraEnv);
    const ruleArgs=codexToolRuleArgs(toolRules,phase,config.sandbox,setting);
    if(ruleArgs.length>0)args.splice(args.length-1,0,...ruleArgs);
  }
  const wireBusinessSchema=request.spawn?.schema??(phase==="execute"?executeWireJsonSchema():phaseJsonSchema(phase as CodexPhase));
  const wireSchema=phase==="execute"?{type:"object",properties:{result:wireBusinessSchema},required:["result"],additionalProperties:false}:wireBusinessSchema;
  await save("schema.json",JSON.stringify(wireSchema));
  // Pre-create files with private permissions before handing paths to the CLI.
  await save("final.json","");await save("events.jsonl","");await save("transcript.jsonl","");await save("stderr.log","");logsCreated=true;
  const runChild = async () => new Promise<void>(resolve=>{
    const child=spawn(config.command[0],args,{cwd:context.worktreePath,detached:true,stdio:["pipe","pipe","pipe"],env:request.spawn?.env??spawnEnv});
    const err=new StringDecoder("utf8");
    // Live transcript (spec §10.2.1-§10.2.3, §11.1): stdout goes to the 16 MiB evidence file and the 128 MiB transcript, each
    // cut at a line end, and through the line folds; only the 1 GiB hard limit stops the agent for its output.
    const events=new CappedLineFile(join(evidenceDir,"events.jsonl"),LIMIT);
    const transcript=new CappedLineFile(join(evidenceDir,"transcript.jsonl"),TRANSCRIPT_LIMIT,transcriptMarker);
    let outBytes=0,errBytes=0,done=false,exited=false;
    let killTimer:NodeJS.Timeout|undefined,drainTimer:NodeJS.Timeout|undefined;
    const kill=(signal:NodeJS.Signals)=>{if(child.pid!==undefined){try{process.kill(-child.pid,signal);}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH"){ioError=String(e);result.reason="io-error";}}}};
    const finish=()=>{
      if(done)return;done=true;
      kill("SIGKILL");
      clearTimeout(timer);clearTimeout(killTimer);clearTimeout(drainTimer);watch.stop();
      context.abortSignal?.removeEventListener("abort",abort);
      splitter.end();stderr+=err.end();
      events.close();transcript.close();
      stdoutTruncated||=events.truncatedAt!==null;transcriptTruncatedAt=transcript.truncatedAt;
      child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
      // close resolves the phase only after pipes and the child have settled.
    };
    const stop=(reason:PhaseOutcome["reason"])=>{
      if(done||killTimer)return;
      if(result.reason==="completed")result.reason=reason;
      kill("SIGTERM");
      if(!killTimer)killTimer=setTimeout(()=>{kill("SIGKILL");finish();},config.killGraceMs);
    };
    const abort=()=>stop("aborted");
    const timer=setTimeout(()=>stop("timeout"),childTimeout);
    // Activity watchdog (spec 2026-10-21 §2.2 codex): stdout/stderr bytes are activity; tool items suspend the clock.
    const watch=new IdleWatch(effectiveIdleTimeoutMs(config),()=>{idle=watch.snapshot();stop("stalled");});
    const splitter=new LineSplitter(line=>{const parsed=jsonLine(line);stream.push(parsed);if(parsed.kind==="row")codexToolRow(parsed.row,watch);});
    watch.start();
    child.on("error",(e:NodeJS.ErrnoException)=>{result.reason="spawn-error";if(typeof e.code==="string")result.spawnErrno=e.code;finish();});
    child.stdin.on("error",(e)=>{ioError=String(e);if(!exited)stop("io-error");});
    child.stdout.on("data",(b:Buffer)=>{
      if(done)return;
      outBytes+=b.length;watch.activity();
      if(outBytes>STDOUT_HARD_LIMIT){stdoutTruncated=true;stop("output-limit");return;}
      try{events.write(b);transcript.write(b);}catch(e){ioError=String(e);stop("io-error");}
      splitter.write(b);
    });
    child.stderr.on("data",(b:Buffer)=>{
      const kept=b.subarray(0,Math.max(0,LIMIT-errBytes));errBytes+=b.length;
      try{appendFileSync(join(evidenceDir,"stderr.log"),kept);}catch(e){ioError=String(e);stop("io-error");}
      watch.activity();
      stderr+=err.write(kept);if(errBytes>LIMIT){stderrTruncated=true;stop("output-limit");}
    });
    child.on("exit",(code,signal)=>{
      exited=true;result.code=code;result.signal=signal;
      if(result.reason==="completed"&&(code!==0||signal!==null))result.reason="exit-error";
      if(!done)drainTimer=setTimeout(finish,1000);
    });
    child.on("close",()=>{finish();resolve();});
    context.abortSignal?.addEventListener("abort",abort,{once:true});
    if(context.abortSignal?.aborted)abort();
    child.once("spawn",()=>{
      void (async()=>{
        try {
          const {stdout}=await execFileAsync("ps",["-o","lstart=","-p",String(child.pid)],{env:{...process.env,TZ:"UTC",LC_ALL:"C"},timeout:1000});
          if(!stdout.trim())throw new Error("process identity unavailable");
          const registration={pid:child.pid!,pgid:child.pid!,startedAt:stdout.trim(),phase};
          await save("process.json",JSON.stringify(registration,null,2));
          await context.onProcessRegistered?.(registration);
          if(!done&&result.reason==="completed")child.stdin.end(request.prompt);
        } catch(e) {ioError=String(e);stop("io-error");}
      })();
    });
  });
  try {
    if (codexSkillsDir === undefined) await runChild();
    else await withCodexSkillLinks(context.worktreePath,codexSkillsDir,runChild);
  } catch (error) {
    const reason = (error as Error).message;
    if (!reason.startsWith("codex-skills-")) throw error;
    result.reason = reason as `codex-skills-${string}`;
  }
  if(result.reason==="completed") {
    try {
      const file=await open(finalPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const s=await file.stat();
        if(!s.isFile())throw new Error("final is not a regular file");
        if(s.size>LIMIT){finalTruncated=true;result.reason="output-limit";}else{
          const b=Buffer.alloc(LIMIT+1);let length=0;
          while(length<b.length){const {bytesRead}=await file.read(b,length,b.length-length,null);if(!bytesRead)break;length+=bytesRead;}
          if(length>LIMIT){finalTruncated=true;result.reason="output-limit";}
          else if(length===0)result.reason="io-error";
          else result.final=b.subarray(0,length).toString("utf8");
        }
      }finally{await file.close();}
    }catch{result.reason="io-error";}
  }
  if(result.reason!=="completed")result.observedTokens=stream.turnUsage.value();
  return persist();
}
