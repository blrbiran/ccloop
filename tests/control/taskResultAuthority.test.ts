import * as fs from "node:fs/promises";
import { copyFile, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureTaskResult, taskResultManifestSchema, taskResultCollectionSchema } from "../../src/control/taskResults.js";
import { taskResultDigest, taskResultEvidencePath } from "../../src/control/taskResultEvidence.js";
import { armAncestorSwap } from "./taskResultBoundaryFixture.js";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});
import { manifestOf, report, resultFixture } from "./taskResultFixture.js";
async function seed(){const f=await resultFixture();await mkdir(f.runDir);await writeFile(join(f.runDir,"loop-state.json"),JSON.stringify({currentAttempt:1}));await writeFile(join(f.repo,"answer.txt"),"snapshot");await captureTaskResult({input:f.input,runDir:f.runDir,worktreePath:f.repo,attempt:1,execution:{changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report},assertHeld:async()=>{}});const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);const page=JSON.parse(r.stdout);return {...f,page,ref:page.manifests[0].ref};}
describe("result authority",()=>{
  // Disabling envelope/hash validation exposes another generation's private outputs.
  it.each(["generation","groupId","sourceDir"])("refuses accepted %s mismatches before reading results",async field=>{const f=await seed();const input=structuredClone(f.input);if(field==="sourceDir")input.work.sourceDir=f.root;else if(field==="generation")input.claim.generation=2;else input.claim.groupId="other-group";const r=await f.rpc("task-results",{input,afterRevision:0});expect(r.code).not.toBe(0);});
  // A content hash is not authorization; the manifest and its exact closure both matter.
  it("refuses a known foreign hash and a forged manifest",async()=>{const f=await seed();const m=await manifestOf(f,f.ref);const foreign=Buffer.from("private foreign bytes"),hash=taskResultDigest(foreign),ref={artifactId:`task-result-${hash}`,hash};await writeFile(taskResultEvidencePath(f.sourceDir,ref),foreign);for(const payload of [{input:f.input,manifestRef:f.ref,ref},{input:f.input,manifestRef:ref,ref:m.outputs[0].ref}]){const r=await f.rpc("read-task-result-evidence",payload);expect(r.stderr).toContain("control-task-result-authority-invalid");}});
  it("refuses damaged output bytes and symlinked evidence ancestors",async()=>{const f=await seed();const m=await manifestOf(f,f.ref);await writeFile(taskResultEvidencePath(f.sourceDir,m.outputs[0].ref),"tampered");const r=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:f.ref,ref:m.outputs[0].ref});expect(r.stderr).toContain("control-task-result-hash-mismatch");await rename(join(f.sourceDir,"control","task-result-evidence"),join(f.sourceDir,"saved"));await symlink(join(f.sourceDir,"saved"),join(f.sourceDir,"control","task-result-evidence"));expect((await f.rpc("task-results",{input:f.input,afterRevision:0})).code).not.toBe(0);});
  // Read must never manufacture an index or snapshot, even with accepted authority.
  it("empty live collection is read-only and does not require candidate/table",async()=>{const f=await resultFixture();const before=await readdir(f.sourceDir,{recursive:true});const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({currentAttempt:0,revision:0,manifests:[],nextRevision:0});expect(await readdir(f.sourceDir,{recursive:true})).toEqual(before);});
  it("refuses extra wire fields and forged index identity",async()=>{const f=await seed();const m=await manifestOf(f,f.ref);expect(taskResultManifestSchema.safeParse({...m,ownerToken:"forged"}).success).toBe(false);expect(taskResultCollectionSchema.safeParse({...f.page,extra:true}).success).toBe(false);const path=join(f.runDir,"task-result-captures","index.json"),index=JSON.parse(await readFile(path,"utf8"));index.identity.executionId="other-execution";await writeFile(path,JSON.stringify(index));expect((await f.rpc("task-results",{input:f.input,afterRevision:0})).stderr).toContain("control-task-result-authority-invalid");});
  // A correct content hash cannot authorize reading through a replaced private ancestor.
  it("refuses a changing evidence ancestor even when outside bytes have the authorized hash", async () => {
    const f = await seed();
    const directory = join(f.sourceDir, "control", "task-result-evidence");
    const outside = join(f.root, "outside-evidence");
    const leaf = `${f.ref.artifactId}.bin`;
    await mkdir(outside);
    await copyFile(join(directory, leaf), join(outside, leaf));
    const race = await armAncestorSwap(directory, outside, leaf);
    try {
      const response = await f.rpc("read-task-result-evidence", {
        input: f.input, manifestRef: f.ref, ref: f.ref,
      });
      expect(race.wasSwapped()).toBe(true);
      expect(response.code).not.toBe(0);
      expect(response.stderr).toContain("changed");
    } finally { await race.close(); }
    const response = await f.rpc("read-task-result-evidence", {
      input: f.input, manifestRef: f.ref, ref: f.ref,
    });
    expect(response.code, response.stderr).toBe(0);
  });

});
