import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runCodexPhase } from "../../../src/runtime/codex/runCodexPhase.js";
import type { AttemptContext } from "../../../src/runtime/types.js";
import type { CodexConfig } from "../../../src/runtime/codex/protocol.js";
const fake=fileURLToPath(new URL("../../fixtures/fake-codex.mjs",import.meta.url));
const read=async(p:string)=>readFile(p,"utf8");
const alive=async(pid:number)=>promisify(execFile)("ps",["-o","stat=","-p",String(pid)]).then(r=>r.stdout.trim().length>0&&!r.stdout.trim().startsWith("Z"),()=>false);
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse()) await f();});
async function fixture(mode="ok") {
  const dir=await realpath(await mkdtemp(join(tmpdir(),"codex-phase-")));
  cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const marker=join(dir,"marker");
  const config:CodexConfig={command:[process.execPath,fake,mode,marker],model:"fixture;touch nope",budgetMode:"soft",sandbox:"workspace-write",timeoutMs:4000,killGraceMs:50};
  const context={worktreePath:dir,runDir:join(dir,"run"),attempt:1,state:{budgetSnapshot:{timeRemainingMs:5000}}} as AttemptContext;
  cleanup.push(async()=>{for(const p of [marker,marker+".child"]) {try{const raw=await read(p);const pid=p===marker?JSON.parse(raw).pid:Number(raw);if(await alive(pid))process.kill(pid,"SIGKILL");}catch{}}});
  return {dir,marker,config,context};
}
describe("Codex phase process",()=>{
  it("uses exact safe argv, cwd, stdin and private raw evidence",async()=>{
    const f=await fixture(); const r=await runCodexPhase(f.config,{phase:"plan",prompt:"prompt 中文",context:f.context});
    expect(r.reason).toBe("completed");const m=JSON.parse(await read(f.marker));
    expect(m).toMatchObject({cwd:f.dir,prompt:"prompt 中文"});
    expect(m.args).toEqual(["--json","--ephemeral","--color","never","--model","fixture;touch nope","--sandbox","read-only","-C",f.dir,"--output-schema",join(r.evidenceDir,"schema.json"),"-o",join(r.evidenceDir,"final.json"),"-"]);
    expect(await read(join(r.evidenceDir,"events.jsonl"))).toBe(r.events);
    expect(await read(join(r.evidenceDir,"stderr.log"))).toBe("fixture stderr 中文\n");
    expect((await stat(r.evidenceDir)).mode&0o777).toBe(0o700);
    expect((await stat(join(r.evidenceDir,"events.jsonl"))).mode&0o777).toBe(0o600);
    expect(JSON.parse(await read(join(r.evidenceDir,"process.json")))).toMatchObject({pid:m.pid,pgid:m.pid});
  });
  it("uses execute sandbox and reconstructs split UTF8",async()=>{
    const f=await fixture("split-utf8");const r=await runCodexPhase(f.config,{phase:"execute",prompt:"p",context:f.context});
    expect(r.events).toContain("中文");expect(r.events).not.toContain("�");
    expect(JSON.parse(await read(f.marker)).args).toContain("workspace-write");
  });
  it("does not launch an already aborted request",async()=>{
    const f=await fixture();const a=new AbortController();a.abort();
    expect((await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:{...f.context,abortSignal:a.signal}})).reason).toBe("aborted");
    await expect(read(f.marker)).rejects.toThrow();
  });
  it("does not spawn with exhausted time",async()=>{
    const f=await fixture();f.context.state.budgetSnapshot.timeRemainingMs=0;
    expect((await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context})).reason).toBe("timeout");
    await expect(read(f.marker)).rejects.toThrow();
  });
  it("does not fall back when absolute executable is missing",async()=>{
    const f=await fixture();f.config.command=[join(f.dir,"missing-codex")];
    expect((await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context})).reason).toBe("spawn-error");
    await expect(read(f.marker)).rejects.toThrow();
  });
  it.each(["nonzero","missing-final","symlink","output-limit"])("refuses %s output",async(mode)=>{
    const f=await fixture(mode);const r=await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context});
    expect(r.reason).toBe(mode==="nonzero"?"exit-error":mode==="output-limit"?"output-limit":"io-error");
  },10000);
  it("never reuses a preceding final message",async()=>{
    const f=await fixture();const a=await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context});
    f.config.command[2]="missing-final";const b=await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context});
    expect(b.evidenceDir).not.toBe(a.evidenceDir);expect(b.reason).toBe("io-error");expect(b.final).toBeNull();
  });
  it("kills a TERM-ignoring process before returning abort",async()=>{
    const f=await fixture("ignore-term");const a=new AbortController();const p=runCodexPhase(f.config,{phase:"execute",prompt:"p",context:{...f.context,abortSignal:a.signal}});
    await expect.poll(()=>read(f.marker).then(JSON.parse).catch(()=>null),{timeout:2000}).not.toBeNull();
    const {pid}=JSON.parse(await read(f.marker));expect(await alive(pid)).toBe(true);a.abort();
    expect((await p).reason).toBe("aborted");await expect.poll(()=>alive(pid),{timeout:2000}).toBe(false);
    expect(await read(f.marker+".term")).toContain("TERM");
  },10000);
  it("times out a hanging process without external cancellation",async()=>{
    const f=await fixture("hang");f.config.timeoutMs=500;
    const p=runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context});
    await expect.poll(()=>read(f.marker).catch(()=>null),{timeout:2000}).not.toBeNull();
    const {pid}=JSON.parse(await read(f.marker));expect((await p).reason).toBe("timeout");
    await expect.poll(()=>alive(pid),{timeout:2000}).toBe(false);
  },3000);
  it("reaps same-group pipe holders before test cleanup",async()=>{
    const f=await fixture("child-holds-pipe");const p=runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context});
    await expect.poll(()=>read(f.marker+".child").catch(()=>null),{timeout:2000}).not.toBeNull();
    const pid=Number(await read(f.marker+".child"));expect(await alive(pid)).toBe(true);
    expect((await p).reason).toBe("completed");await expect.poll(()=>alive(pid),{timeout:2000}).toBe(false);
  },6000);
  it("retains raw stderr while the process is still running",async()=>{
    const f=await fixture("ignore-term");const a=new AbortController();
    const p=runCodexPhase(f.config,{phase:"execute",prompt:"p",context:{...f.context,abortSignal:a.signal}});
    try {
      await expect.poll(()=>read(f.marker).catch(()=>null),{timeout:2000}).not.toBeNull();
      const {readdir}=await import("node:fs/promises");
      const root=join(f.context.runDir,"codex","1","execute");const [call]=await readdir(root);
      await expect.poll(()=>read(join(root,call!,"stderr.log")),{timeout:1000}).toContain("fixture stderr");
    } finally {a.abort();await p;}
  });
  it("labels truncated evidence explicitly",async()=>{
    const f=await fixture("output-limit");const r=await runCodexPhase(f.config,{phase:"plan",prompt:"p",context:f.context});
    expect(await read(join(r.evidenceDir,"outcome.json"))).toContain('"stdoutTruncated": true');
  });

  it("returns its own deadline result before the test watchdog",async()=>{
    const f=await fixture("hang");f.config.timeoutMs=500;const a=new AbortController();
    const p=runCodexPhase(f.config,{phase:"plan",prompt:"p",context:{...f.context,abortSignal:a.signal}});
    let timer:NodeJS.Timeout|undefined;
    try {expect(await Promise.race([p.then(r=>r.reason),new Promise(resolve=>{timer=setTimeout(()=>resolve("test-watchdog"),2000);})])).toBe("timeout");}
    finally {clearTimeout(timer);a.abort();await p;}
  },10000);

});
