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
  await writeFile(codex,`#!${process.execPath}\nif(process.argv.includes("--version")){console.log("fixture 1.0.0");}else{process.argv=[process.execPath,${JSON.stringify(fileURLToPath(fake))},"ignore-term",${JSON.stringify(marker)},...process.argv.slice(2)];await import(${JSON.stringify(fake.href)});}`);await chmod(codex,0o700);
  return {dir,bin,marker,codex,output};
}
const json=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

// HUMAN RULING 139 (2026-10-07, named this criterion for rewrite under ruling 88): this encodes that a start identity
// recorded in ps's padded form ("Oct  1") still matches the watchdog's fresh observation, so the TERM-ignoring group is
// confirmed and reaped (nothing unresolved, pid dead). The rewrite only widens the timing budget -- outerTimeoutMs
// 1800 -> 6000, marker poll 1500 -> 5500 ms, test timeout 10000 -> 20000 ms -- because the marker took 1.4-1.7 s at load ~28
// and the 1.5 s poll lost the race. Assertions unchanged.
it("matches historical double-space start identities on single-digit days",async()=>{
  const f=await fixture();const ps=join(f.bin,"ps"),oldPath=process.env.PATH;
  await writeFile(ps,`#!${process.execPath}\nconst {execFileSync}=require("node:child_process");const s=execFileSync("/bin/ps",process.argv.slice(2),{encoding:"utf8"});process.stdout.write(s.replace(/([A-Za-z]{3} [A-Za-z]{3}) +[0-9]{1,2}(?= [0-9]{2}:)/g,"$1  1"));`);await chmod(ps,0o700);
  process.env.PATH=f.bin+":"+oldPath;let pid:number|undefined;
  const pending=runValidation({codex:f.codex,model:"fixture",output:f.output},{outerTimeoutMs:6000});
  try {
    await expect.poll(()=>json(f.marker).catch(()=>null),{timeout:5500}).not.toBeNull();pid=(await json(f.marker)).pid;expect(alive(pid!)).toBe(true);
    expect(await pending).toBe(1);const summary=await json(join(f.output,"summary.json"));
    expect(summary.cleanup.unresolved).toEqual([]);expect(alive(pid!)).toBe(false);
  }finally{process.env.PATH=oldPath;if(pid){try{process.kill(-pid,"SIGKILL");}catch{}}await pending;await rm(f.dir,{recursive:true,force:true});}
},20000);

// HUMAN RULING 139 (2026-10-07, named this criterion for rewrite under ruling 88): this encodes that a failure to
// persist process observations (EISDIR) is reported but never stops the watchdog from reaping every registered group.
// The rewrite widens the same timing budget as above, and retries the rm -> mkdir swap on EEXIST: the watchdog's
// 100 ms tick can recreate the file between the two calls. Assertions unchanged.
it("still reaps registered groups when the observation file becomes unwritable",async()=>{
  const f=await fixture();let pid:number|undefined;const knownGroups=new Set<number>();
  const pending=runValidation({codex:f.codex,model:"fixture",output:f.output},{outerTimeoutMs:6000});
  try {
    await expect.poll(()=>json(f.marker).catch(()=>null),{timeout:5500}).not.toBeNull();pid=(await json(f.marker)).pid;expect(alive(pid!)).toBe(true);
    const observations=join(f.output,"process-observations.json");
    for(const row of await json(observations))knownGroups.add(row.pgid);
    knownGroups.add(pid!);
    for(;;){await rm(observations,{force:true});try{await mkdir(observations);break;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}}
    expect(await pending).toBe(1);const summary=await json(join(f.output,"summary.json"));
    expect(summary.cleanup.unresolved.join(" ")).toContain("EISDIR");
    expect(alive(pid!)).toBe(false);
    for(const group of summary.cleanup.registered)knownGroups.add(group.pgid);
    expect(summary.cleanup.registered.length).toBeGreaterThanOrEqual(2);
  }finally{for(const pgid of knownGroups){try{process.kill(-pgid,"SIGKILL");}catch{}}await pending;await rm(f.dir,{recursive:true,force:true});}
},20000);
