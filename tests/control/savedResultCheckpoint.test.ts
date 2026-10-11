import {it,expect} from "vitest";
import {readFile,mkdtemp,mkdir,cp,rm,chmod,readdir} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {prepareContinuationContract,materializeFirstWorkspace,readAllowanceContinuation} from "../../src/control/materialize.js";
import {savedRecoveryFixture} from "./savedRecoveryFixture.js";

it("refuses ordinary continuation of a genuine recovery checkpoint even though core handoff mode is projected away",async()=>{
 const f=await savedRecoveryFixture();try{
  const fixtureRoot=fileURLToPath(new URL('../fixtures/saved-result-checkpoint/',import.meta.url)),fixture=JSON.parse(await readFile(join(fixtureRoot,'fixture.json'),'utf8'));
  const bundlePath=join(f.sourceDir,'input/checkpoint');await cp(join(fixtureRoot,'bundle'),bundlePath,{recursive:true});
  async function privateFiles(dir:string):Promise<void>{for(const name of await readdir(dir,{withFileTypes:true})){const p=join(dir,name.name);if(name.isDirectory())await privateFiles(p);else await chmod(p,0o600);}}
  await privateFiles(bundlePath);await mkdir(f.runDir,{recursive:true});const input={...fixture.input,bundlePath};
  const manifest=JSON.parse(await readFile(join(bundlePath,'resume-bundle.json'),'utf8'));
  const decode=async(ref:any)=>JSON.parse(await readFile(join(bundlePath,manifest.artifacts.find((e:any)=>e.ref.artifactId===ref.artifactId).file),'utf8'));
  const checkpoint=await decode(manifest.checkpoint),handoff=await decode(checkpoint.handoff);
  expect(checkpoint.result).toBe('partial');expect(handoff.runState.savedResult).toBeUndefined();
  const archive=await decode(checkpoint.artifacts.find((r:any)=>r.artifactId.startsWith('archive-')));
  expect((await decode(archive.logs.find((e:any)=>e.path==='control/envelope.json').ref)).mode).toBe('verify-saved-result');
  expect((await decode(archive.logs.find((e:any)=>e.path==='run/loop-state.json').ref)).savedResult.mode).toBe('verify-saved-result');
  await expect(prepareContinuationContract(f.input.work.contract,f.runDir,input)).rejects.toThrow('saved-result-explicit-command-required');
  await expect(materializeFirstWorkspace(f.repo,f.runDir,1,input)).rejects.toThrow('saved-result-explicit-command-required');
  await expect(readAllowanceContinuation({...f.input,mode:undefined,savedResultRecovery:undefined,inputCheckpoint:input})).rejects.toThrow('saved-result-explicit-command-required');
  await expect(readFile(join(f.runDir,'continuation-input.json'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
