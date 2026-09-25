import { execFile, spawn } from "node:child_process";
import { appendFileSync, constants } from "node:fs";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { AttemptContext } from "../types.js";
import { observedTurnUsage, phaseJsonSchema, type CodexConfig, type CodexPhase } from "./protocol.js";

export type PhaseRequest = {phase:CodexPhase;prompt:string;context:AttemptContext};
export type PhaseOutcome = {
  reason:"completed"|"aborted"|"timeout"|"spawn-error"|"exit-error"|"output-limit"|"io-error";
  code:number|null;signal:NodeJS.Signals|null;events:string;final:string|null;evidenceDir:string;
  // Orca handoff delivery C-3: usage observed in the stdout of a phase that did not complete; null otherwise.
  observedTokens:number|null;
};
const LIMIT=16*1024*1024;
const execFileAsync=promisify(execFile);
export async function runCodexPhase(config:CodexConfig, request:PhaseRequest, extraEnv?:Record<string,string>):Promise<PhaseOutcome> {
  const {context,phase}=request;
  const root=join(context.runDir,"codex",String(context.attempt),phase);
  await mkdir(root,{recursive:true,mode:0o700});
  const evidenceDir=await mkdtemp(join(root,"call-"));
  const result:PhaseOutcome={reason:"completed",code:null,signal:null,events:"",final:null,evidenceDir,observedTokens:null};
  const save=async(name:string,data:string)=>writeFile(join(evidenceDir,name),data,{mode:0o600});
  const schemaPath=join(evidenceDir,"schema.json"),finalPath=join(evidenceDir,"final.json");
  const args=[...config.command.slice(1),"exec","--json","--ephemeral","--color","never","--model",config.model,
    "--sandbox",phase==="execute"?config.sandbox:"read-only","-C",context.worktreePath,
    "--output-schema",schemaPath,"-o",finalPath,"-"];
  let stderr="", logsCreated=false;
  let ioError:string|undefined;
  let stdoutTruncated=false,stderrTruncated=false,finalTruncated=false;
  const persist=async()=>{
    if(!logsCreated){await save("events.jsonl",result.events);await save("stderr.log",stderr);}
    await save("outcome.json",JSON.stringify({...result,events:undefined,final:undefined,executable:config.command[0],args,ioError,stdoutTruncated,stderrTruncated,finalTruncated},null,2));
    return result;
  };
  if(context.abortSignal?.aborted){result.reason="aborted";return persist();}
  const timeout=Math.min(config.timeoutMs,context.state.budgetSnapshot.timeRemainingMs);
  if(timeout<=0){result.reason="timeout";return persist();}
  const businessSchema=phaseJsonSchema(phase);
  const wireSchema=phase==="execute"?{type:"object",properties:{result:businessSchema},required:["result"],additionalProperties:false}:businessSchema;
  await save("schema.json",JSON.stringify(wireSchema));
  // Pre-create files with private permissions before handing paths to the CLI.
  await save("final.json","");await save("events.jsonl","");await save("stderr.log","");logsCreated=true;
  await new Promise<void>(resolve=>{
    const child=spawn(config.command[0],args,{cwd:context.worktreePath,detached:true,stdio:["pipe","pipe","pipe"],env:{...process.env,...extraEnv}});
    const out=new StringDecoder("utf8"),err=new StringDecoder("utf8");
    let outBytes=0,errBytes=0,done=false,exited=false;
    let killTimer:NodeJS.Timeout|undefined,drainTimer:NodeJS.Timeout|undefined;
    const kill=(signal:NodeJS.Signals)=>{if(child.pid!==undefined){try{process.kill(-child.pid,signal);}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH"){ioError=String(e);result.reason="io-error";}}}};
    const finish=()=>{
      if(done)return;done=true;
      kill("SIGKILL");
      clearTimeout(timer);clearTimeout(killTimer);clearTimeout(drainTimer);
      context.abortSignal?.removeEventListener("abort",abort);
      result.events+=out.end();stderr+=err.end();
      child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
      resolve();
    };
    const stop=(reason:PhaseOutcome["reason"])=>{
      if(done||killTimer)return;
      if(result.reason==="completed")result.reason=reason;
      kill("SIGTERM");
      if(!killTimer)killTimer=setTimeout(()=>{kill("SIGKILL");finish();},config.killGraceMs);
    };
    const abort=()=>stop("aborted");
    const timer=setTimeout(()=>stop("timeout"),timeout);
    child.on("error",()=>{result.reason="spawn-error";finish();});
    child.stdin.on("error",(e)=>{ioError=String(e);if(!exited)stop("io-error");});
    child.stdout.on("data",(b:Buffer)=>{
      const kept=b.subarray(0,Math.max(0,LIMIT-outBytes));outBytes+=b.length;
      try{appendFileSync(join(evidenceDir,"events.jsonl"),kept);}catch(e){ioError=String(e);stop("io-error");}
      result.events+=out.write(kept);if(outBytes>LIMIT){stdoutTruncated=true;stop("output-limit");}
    });
    child.stderr.on("data",(b:Buffer)=>{
      const kept=b.subarray(0,Math.max(0,LIMIT-errBytes));errBytes+=b.length;
      try{appendFileSync(join(evidenceDir,"stderr.log"),kept);}catch(e){ioError=String(e);stop("io-error");}
      stderr+=err.write(kept);if(errBytes>LIMIT){stderrTruncated=true;stop("output-limit");}
    });
    child.on("exit",(code,signal)=>{
      exited=true;result.code=code;result.signal=signal;
      if(result.reason==="completed"&&(code!==0||signal!==null))result.reason="exit-error";
      if(!done)drainTimer=setTimeout(finish,1000);
    });
    child.on("close",finish);
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
  if(result.reason!=="completed")result.observedTokens=observedTurnUsage(result.events);
  return persist();
}
