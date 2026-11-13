import {afterEach,expect,it} from "vitest";
import {readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {collectSavedResultEvidence,readSavedResultEvidence} from "../../src/control/savedResultEvidence.js";
import {ompHandoffSource} from "./ompHandoffSource.js";

// Orca tester follow-up I (V11 regression): the OMP execute argv of a run with work.handoff carries
// `--add-dir=<inputDir> --add-dir=<outputDir>` after `--cwd`; the malformed-final capture must still publish its
// verification-only capsule, and a run without handoff keeps publishing it as before.
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

it.each([[true],[false]])('publishes the verification-only capsule of a malformed OMP final when the run had handoff directories: %s',async withHandoff=>{
 const f=await ompHandoffSource(withHandoff);roots.push(f.root);
 const call=(await readdir(join(f.runDir,'omp/1/execute')))[0]!;
 const args:string[]=JSON.parse(await readFile(join(f.runDir,'omp/1/execute',call,'outcome.json'),'utf8')).args;
 // The run itself carried exactly the directories the envelope named (or none): the capture had them to match.
 expect(args.filter(a=>a.startsWith('--add-dir'))).toEqual(withHandoff?[`--add-dir=${f.handoff.inputDir}`,`--add-dir=${f.handoff.outputDir}`]:[]);
 const index=await collectSavedResultEvidence(f.input);
 expect(index.capsule,await readFile(join(f.runDir,'events.jsonl'),'utf8')).not.toBeNull();
 expect(JSON.parse((await readSavedResultEvidence(f.input,index.capsule!,index.capsule!)).toString()).schema).toBe('ccloop-execution-without-final-v1');
},30000);
