import {afterEach,expect,it,vi} from "vitest";
import {readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import type {HandoffDirs} from "../../src/runtime/types.js";
import {collectSavedResultEvidence} from "../../src/control/savedResultEvidence.js";
import {ompHandoffSource} from "./ompHandoffSource.js";

// Orca tester follow-up I (V11 regression): the capture expects the handoff arguments the envelope names, through the
// runtime's own builder. Here the capture's view of that builder is replaced (the runtime keeps the real one), so the
// recorded argv carries handoff directories the capture does not expect -- other directories, or none at all.
const view=vi.hoisted(()=>({expect:(_:HandoffDirs|undefined):string[]=>[]}));
vi.mock("../../src/runtime/omp/runOmpPhase.js",async original=>({...(await original<object>()),ompHandoffArgs:(h:HandoffDirs|undefined)=>view.expect(h)}));
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it.each([
 ['directories other than the recorded ones',(h:HandoffDirs|undefined)=>h===undefined?[]:[`--add-dir=${h.inputDir}`,`--add-dir=${h.outputDir}-elsewhere`]],
 ['no handoff directories where the run recorded two',()=>[]],
] as const)('refuses to capture a malformed OMP final when the capture expects %s',async(_,expectArgs)=>{
 view.expect=expectArgs;
 const f=await ompHandoffSource(true);roots.push(f.root);
 const events=await readFile(join(f.runDir,'events.jsonl'),'utf8');
 expect((await collectSavedResultEvidence(f.input)).capsule,events).toBeNull();
 expect(events).toContain('execution_without_final_capture_failed');
 expect(events).toContain('saved-result-config-mismatch');
},30000);
