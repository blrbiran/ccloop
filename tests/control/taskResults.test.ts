import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile, open } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { captureTaskResult } from "../../src/control/taskResults.js";
import { MAX_TASK_RESULT_FILE_BYTES, readTaskResultFile } from "../../src/control/taskResultEvidence.js";
vi.mock("node:fs/promises", async importOriginal => { const actual=await importOriginal<typeof fs>();return {...actual,open:vi.fn(actual.open),lstat:vi.fn(actual.lstat)}; });
import { armAncestorSwap } from "./taskResultBoundaryFixture.js";
import { manifestOf, report, resultFixture, verified } from "./taskResultFixture.js";
describe("bounded result snapshots",()=>{
  // Removing safe path/no-follow/bounds checks must expose these sentinel files and fail.
  it("marks unsafe, ancestor symlink, missing, deleted, binary, special, oversized paths without reading targets",async()=>{
    const f=await resultFixture();await mkdir(f.runDir);await mkdir(join(f.repo,"directory"));await symlink(f.root,join(f.repo,"link"));await writeFile(join(f.root,"secret"),"must not capture");await writeFile(join(f.repo,"binary"),Buffer.from([0,255]));await writeFile(join(f.repo,"large"),Buffer.alloc(MAX_TASK_RESULT_FILE_BYTES+1));await promisify(execFile)("mkfifo",[join(f.repo,"fifo")]);await fs.unlink(join(f.repo,"answer.txt"));
    const paths=["../secret","link/secret","missing","answer.txt","binary","large","fifo","directory","https://example.invalid/x","a\\b"];
    await captureTaskResult({input:f.input,runDir:f.runDir,worktreePath:f.repo,attempt:1,execution:{changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"",taskResult:{...report,outputs:paths.map(path=>({path,label:path}))}},assertHeld:async()=>{}});
    const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);const m=await manifestOf(f,JSON.parse(r.stdout).manifests[0].ref);expect(m.outputs.map((o:any)=>o.status)).toEqual(["unsafe","symlink","missing","deleted","binary","too-large","unavailable","unavailable","unsafe","unsafe","symlink"]);expect(m.outputs.slice(0,4).map((o:any)=>o.ref)).toEqual([null,null,null,null]);
  });
  // A growing file must not be admitted after the bounded read has started.
  it("rejects a changed-during-read file using real file I/O",async()=>{
    const f=await resultFixture(),path=join(f.repo,"answer.txt");const original=fs.open;
    const spy=vi.spyOn(fs,"open").mockImplementation(async(...args:Parameters<typeof open>)=>{const handle=await original(...args);if(await fs.realpath(String(args[0])).catch(()=>null)===path){const read=handle.read.bind(handle);handle.read=(async(...readArgs:any[])=>{const result=await (read as any)(...readArgs);await writeFile(path,"changed contents");return result}) as typeof handle.read;}return handle;});
    try{await expect(readTaskResultFile(f.repo,path,MAX_TASK_RESULT_FILE_BYTES)).rejects.toThrow("changed")}finally{spy.mockRestore()}
  });
  // Returning the latest report's attempt would label old bytes as the currently executing attempt.
  it("pages at most 64 immutable observations and reports the independent current attempt",async()=>{
    const f=await resultFixture();await mkdir(f.runDir);await writeFile(join(f.runDir,"loop-state.json"),JSON.stringify({currentAttempt:34}));
    for(let attempt=1;attempt<=33;attempt++){const base={input:f.input,runDir:f.runDir,worktreePath:f.repo,attempt,execution:{changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"",taskResult:report},assertHeld:async()=>{}};await captureTaskResult(base);await captureTaskResult({...base,verification:{...verified,approved:attempt!==1}});}
    const first=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(first.code,first.stderr).toBe(0);const p=JSON.parse(first.stdout);expect(p).toMatchObject({revision:66,currentAttempt:34,nextRevision:64});expect(p.manifests).toHaveLength(64);const second=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:p.nextRevision})).stdout);expect(second.manifests.map((m:any)=>m.revision)).toEqual([65,66]);expect(second.nextRevision).toBe(66);
    const rejected=await manifestOf(f,p.manifests[1].ref);const vr=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:p.manifests[1].ref,ref:rejected.verificationRef});expect(JSON.parse(Buffer.from(JSON.parse(vr.stdout).base64,"base64").toString()).approved).toBe(false);
  },30000);
  // A content-addressed snapshot is immutable, including publication: a later attempt must not replace its inode.
  it("does not replace existing evidence when a later attempt captures identical bytes",async()=>{
    const f=await resultFixture();await mkdir(f.runDir);const base={input:f.input,runDir:f.runDir,worktreePath:f.repo,execution:{changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"",taskResult:report},assertHeld:async()=>{}};
    await captureTaskResult({...base,attempt:1});const index=JSON.parse(await readFile(join(f.runDir,"task-result-captures","index.json"),"utf8")),m=await manifestOf(f,index.manifests[0].ref);const path=join(f.sourceDir,"control","task-result-evidence",`${m.outputs[0].ref.artifactId}.bin`),before=await fs.stat(path);await captureTaskResult({...base,attempt:2});expect((await fs.stat(path)).ino).toBe(before.ino);
  });

  // Unbounded changed-file discovery must not produce more than 64 saved file refs per attempt.
  it("caps controller-observed changed files at 64 and keeps private publication modes",async()=>{
    const f=await resultFixture();await mkdir(f.runDir);for(let i=0;i<70;i++)await writeFile(join(f.repo,`file-${String(i).padStart(2,"0")}.txt`),"captured");
    await captureTaskResult({input:f.input,runDir:f.runDir,worktreePath:f.repo,attempt:1,execution:{changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:""},assertHeld:async()=>{}});const indexPath=join(f.runDir,"task-result-captures","index.json"),index=JSON.parse(await readFile(indexPath,"utf8")),m=await manifestOf(f,index.manifests[0].ref);expect(m.outputs).toHaveLength(64);expect(m.outputs.every((o:any)=>o.origin==="changed"&&o.status==="available")).toBe(true);expect((await fs.stat(join(f.runDir,"task-result-captures"))).mode&0o777).toBe(0o700);expect((await fs.stat(indexPath)).mode&0o777).toBe(0o600);expect((await fs.stat(join(f.sourceDir,"control","task-result-evidence"))).mode&0o777).toBe(0o700);
  });

  // Restoring the pathname cannot authorize bytes opened through a different ancestor.
  it("refuses an ancestor swapped and restored during the bounded read", async () => {
    const f = await resultFixture();
    const directory = join(f.repo, "output");
    const outside = join(f.root, "outside");
    await mkdir(directory);
    await mkdir(outside);
    await writeFile(join(directory, "answer.txt"), "inside snapshot");
    await writeFile(join(outside, "answer.txt"), "OUTSIDE SENTINEL");
    const race = await armAncestorSwap(directory, outside, "answer.txt");
    try {
      await expect(readTaskResultFile(f.repo, join(directory, "answer.txt"), MAX_TASK_RESULT_FILE_BYTES))
        .rejects.toThrow("changed");
      expect(race.wasSwapped()).toBe(true);
    } finally {
      await race.close();
    }
    expect(await readFile(join(directory, "answer.txt"), "utf8")).toBe("inside snapshot");
  });

});
