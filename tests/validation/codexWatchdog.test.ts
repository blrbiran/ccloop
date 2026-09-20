import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error Standalone JavaScript harness.
import { runValidation } from "../../scripts/validate-codex-adapter.mjs";

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"codex-watchdog-")),bin=join(dir,"bin");await mkdir(bin);
  const marker=join(dir,"marker"),codex=join(bin,"fake-codex"),output=join(dir,"output");
  const fake=new URL("../fixtures/fake-codex.mjs",import.meta.url);
  await writeFile(codex,`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("fixture");}else{process.argv=[process.execPath,${JSON.stringify(fileURLToPath(fake))},"ignore-term",${JSON.stringify(marker)},...process.argv.slice(2)];await import(${JSON.stringify(fake.href)});}`);await chmod(codex,0o700);
  return {dir,bin,marker,codex,output};
}
const json=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

it("matches historical double-space start identities on single-digit days",async()=>{
  const f=await fixture();const ps=join(f.bin,"ps"),oldPath=process.env.PATH;
  await writeFile(ps,`#!${process.execPath}\nconst {execFileSync}=require("node:child_process");const s=execFileSync("/bin/ps",process.argv.slice(2),{encoding:"utf8"});process.stdout.write(s.replace(/([A-Za-z]{3} [A-Za-z]{3}) +[0-9]{1,2}(?= [0-9]{2}:)/g,"$1  1"));`);await chmod(ps,0o700);
  process.env.PATH=f.bin+":"+oldPath;let pid:number|undefined;
  const pending=runValidation({codex:f.codex,model:"fixture",output:f.output},{outerTimeoutMs:1800});
  try {
    await expect.poll(()=>json(f.marker).catch(()=>null),{timeout:1500}).not.toBeNull();pid=(await json(f.marker)).pid;expect(alive(pid!)).toBe(true);
    expect(await pending).toBe(1);const summary=await json(join(f.output,"summary.json"));
    expect(summary.cleanup.unresolved).toEqual([]);expect(alive(pid!)).toBe(false);
  }finally{process.env.PATH=oldPath;if(pid){try{process.kill(-pid,"SIGKILL");}catch{}}await pending;await rm(f.dir,{recursive:true,force:true});}
},10000);

it("still reaps registered groups when the observation file becomes unwritable",async()=>{
  const f=await fixture();let pid:number|undefined;const knownGroups=new Set<number>();
  const pending=runValidation({codex:f.codex,model:"fixture",output:f.output},{outerTimeoutMs:1800});
  try {
    await expect.poll(()=>json(f.marker).catch(()=>null),{timeout:1500}).not.toBeNull();pid=(await json(f.marker)).pid;expect(alive(pid!)).toBe(true);
    const observations=join(f.output,"process-observations.json");
    for(const row of await json(observations))knownGroups.add(row.pgid);
    knownGroups.add(pid!);
    await rm(observations);await mkdir(observations);
    expect(await pending).toBe(1);const summary=await json(join(f.output,"summary.json"));
    expect(summary.cleanup.unresolved.join(" ")).toContain("EISDIR");
    expect(alive(pid!)).toBe(false);
    for(const group of summary.cleanup.registered)knownGroups.add(group.pgid);
    expect(summary.cleanup.registered.length).toBeGreaterThanOrEqual(2);
  }finally{for(const pgid of knownGroups){try{process.kill(-pgid,"SIGKILL");}catch{}}await pending;await rm(f.dir,{recursive:true,force:true});}
},10000);
