import { execFile } from "node:child_process";
import { mkdtemp, chmod, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
// The harness is intentionally a standalone Node program, also callable by offline tests.
// @ts-expect-error JavaScript validation entrypoint has no declaration file.
import { runValidation, main } from "../../scripts/validate-codex-adapter.mjs";
const exec=promisify(execFile),dirs:string[]=[];
const root=fileURLToPath(new URL("../../",import.meta.url));
beforeAll(async()=>{await exec("npm",["run","build"],{cwd:root,timeout:30000});},35000);
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const json=async(p:string)=>JSON.parse(await readFile(p,"utf8"));
async function fixture(mode:string){
  const dir=await mkdtemp(join(tmpdir(),"codex-acceptance-test-"));dirs.push(dir);
  const bin=join(dir,"fake-codex"),marker=join(dir,"marker"),output=join(dir,"output");
  const fake=fileURLToPath(new URL("../fixtures/fake-codex.mjs",import.meta.url));
  await writeFile(bin,`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("fake-codex 1");}else{process.argv=[process.execPath,${JSON.stringify(fake)},${JSON.stringify(mode)},${JSON.stringify(marker)},...process.argv.slice(2)];await import(${JSON.stringify(new URL("../fixtures/fake-codex.mjs",import.meta.url).href)});}\n`);
  await chmod(bin,0o700);return {dir,bin,marker,output,options:{codex:bin,model:"fixture",output}};
}
describe("isolated Codex acceptance harness",()=>{
  it("requires complete arguments without launching",async()=>{
    const f=await fixture("integration");expect(await main(["--codex",f.bin,"--output",f.output])).toBe(1);await expect(readFile(f.marker)).rejects.toThrow();
  });
  it("succeeds only with real controller, three phases and published answer",async()=>{
    const f=await fixture("integration");expect(await runValidation(f.options)).toBe(0);
    const summary=await json(join(f.output,"summary.json"));expect(summary).toMatchObject({passed:true,cliCode:0,status:"succeeded",tokenUsage:45,dollarCost:"unknown",cleanup:{unresolved:[]}});
    expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan","execute","verify"]);
    expect(await readFile(join(f.output,"answer.txt"),"utf8")).toBe("42\n");
  },30000);
  it.each(["bad-json","quota"])("stops on %s without retry",async mode=>{
    const f=await fixture(mode);expect(await runValidation(f.options)).toBe(1);
    expect((await readFile(f.marker+".calls","utf8")).trim().split("\n")).toEqual(["plan"]);
    expect((await json(join(f.output,"summary.json"))).passed).toBe(false);
  },30000);
  it("refuses existing evidence directories without overwriting or launching",async()=>{
    const f=await fixture("integration");await writeFile(f.output,"sentinel");expect(await main(["--codex",f.bin,"--model","fixture","--output",f.output])).toBe(1);
    expect(await readFile(f.output,"utf8")).toBe("sentinel");await expect(readFile(f.marker)).rejects.toThrow();
  });
  it("independently refuses a succeeded run whose verifier changed answer back",async()=>{
    const f=await fixture("false-answer");expect(await runValidation(f.options)).toBe(1);
    const summary=await json(join(f.output,"summary.json"));expect(summary.status).toBe("succeeded");expect(summary.error).toContain("answer mismatch");
  },30000);
  it("outer watchdog kills a previously observed TERM-ignoring detached Codex",async()=>{
    const f=await fixture("ignore-term");const pending=runValidation(f.options,{outerTimeoutMs:1800});
    let pid:number|undefined;
    try {
      await expect.poll(()=>json(f.marker).catch(()=>null),{timeout:1500}).not.toBeNull();pid=(await json(f.marker)).pid;process.kill(pid!,0);
      const result=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve("test-watchdog"),5000))]);expect(result).toBe(1);
      const summary=await json(join(f.output,"summary.json"));expect(summary.error).toContain("outer timeout");expect(summary.cleanup.unresolved).toEqual([]);
      await expect.poll(()=>exec("ps",["-o","stat=","-p",String(pid)]).then(r=>r.stdout.trim().length>0&&!r.stdout.trim().startsWith("Z"),()=>false),{timeout:1000}).toBe(false);
    } finally {if(pid){try{process.kill(-pid,"SIGKILL");}catch{}}await pending;}
  },10000);
});
