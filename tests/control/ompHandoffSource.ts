import {execFile} from "node:child_process";
import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";
import {resultFixture} from "./taskResultFixture.js";
import {ompInstallation,FAKE_OMP} from "../fixtures/toolRules/argvCapture.js";
import {parseMaterializedAgentConfig,agentConfigHash} from "../../src/agents/materialize.js";
import {writeAccepted} from "../../src/control/store.js";
import {runControlWorker} from "../../src/control/worker.js";
import {canonicalHash,canonicalJson} from "../../src/control/protocol.js";
import {atomicReplacePrivateFile} from "../../src/control/paths.js";

const exec=promisify(execFile);
/**
 * Orca tester follow-up I (V11 regression): a real worker run of an opted-in OMP task whose execute final is malformed,
 * with or without the work.handoff directories every Orca task run now carries (ccloop afb9a51).
 */
export async function ompHandoffSource(withHandoff:boolean){
 const f=await resultFixture();
 const marker=join(f.root,"marker"),binary=join(f.root,"omp");
 const installation=await ompInstallation({dir:f.root,marker} as never);
 await writeFile(binary,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OMP)} ${JSON.stringify(marker)} "$@"\n`,{mode:0o700});
 await writeFile(`${marker}.reported.json`,JSON.stringify({unexpected:true}));
 const config=parseMaterializedAgentConfig({...installation,installation:{...(installation.installation as object),command:[binary]}});
 f.contract.verification={verifierType:"command",requiredChecks:["test \"$(cat answer.txt)\" = 42"],rejectOn:["wrong answer"],evidenceRequired:[],commandChecksDecideGoal:true};
 f.contract.executionPolicy.maxAttempts=1;f.contract.executionPolicy.totalRuntimeBudgetMs=30000;
 f.input.claim.agent=config.selection;f.input.claim.configHash=agentConfigHash(config);f.input.work.contract=f.contract;f.input.contractHash=canonicalHash(f.contract);
 f.input.work.base=(await exec("/usr/bin/git",["rev-parse","HEAD"],{cwd:f.repo})).stdout.trim();
 const handoff={inputDir:join(f.root,"handoff-in"),outputDir:join(f.root,"handoff-out")};
 if(withHandoff){await mkdir(handoff.inputDir,{mode:0o700});await mkdir(handoff.outputDir,{mode:0o700});f.input.work.handoff=handoff;}
 await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,"control/config.json"),Buffer.from(canonicalJson(config)));
 await atomicReplacePrivateFile(f.sourceDir,join(f.sourceDir,"control/envelope.json"),Buffer.from(canonicalJson(f.input)));
 await writeAccepted(f.sourceDir,{protocol:1,envelopeHash:canonicalHash(f.input),executionId:"execution-1",configHash:f.input.claim.configHash,generation:1,acceptedAt:new Date().toISOString(),launch:"intended",worker:null});
 await runControlWorker(["--source-dir",f.sourceDir,"--execution-id","execution-1","--nonce","nonce-1"]);
 return {...f,handoff};
}
