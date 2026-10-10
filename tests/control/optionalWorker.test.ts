import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "../../src/control/paths.js";
import { canonicalHash, canonicalJson, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { writeAccepted } from "../../src/control/store.js";
import { runControlWorker } from "../../src/control/worker.js";
import { codexFixture } from "../runtime/codex/fixture.js";
import { sealCodex } from "./agentsFixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function runWorker(workTokens: number | null = null): Promise<void> {
  const runtime = await codexFixture("high-usage");
  dirs.push(runtime.dir);
  const fake = join(runtime.dir,"million-codex.mjs");
  await writeFile(fake, (await readFile(join(process.cwd(),"tests/fixtures/fake-codex.mjs"),"utf8")).replace('39997','1_599_997'));
  const config = {...runtime.config,command:[process.execPath,fake,"high-usage",runtime.marker]};
  runtime.contract.executionPolicy.tokenBudget=null;
  runtime.contract.executionPolicy.maxAttempts=3;
  runtime.contract.executionPolicy.totalRuntimeBudgetMs=60_000;
  const sealed=await sealCodex(config as Parameters<typeof sealCodex>[0]);
  const amount={tokens:100,activeMs:60_000,attempts:2,sessions:1};
  const envelope:LoopStartEnvelope={protocol:4,claim:{groupId:"g",workItemId:"w",taskId:"t",runId:"r",generation:1,graphVersion:1,targetVersion:1,commandId:"c",configHash:sealed.configHash,agent:sealed.selection,grant:{work:{...amount,tokens:workTokens},handoff:amount},ownerToken:"o"},tokenPolicy:{authoredTokenCeiling:null,bindingCauses:workTokens===null?[]:["spend-cap"],inheritedUsage:{tokens:0,activeMs:0,attempts:0,sessions:0}},contractHash:"c".repeat(64),inputCheckpoint:null,work:{kind:"loop",contract:runtime.contract,targetRepo:runtime.repo,base:"HEAD",sourceDir:runtime.dir}};
  const controlDir = join(runtime.dir, "control");
  await ensurePrivateDirectory(runtime.dir, controlDir);
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "config.json"), Buffer.from(canonicalJson(sealed.config)));
  await atomicReplacePrivateFile(runtime.dir, join(controlDir, "envelope.json"), Buffer.from(canonicalJson(envelope)));
  await writeAccepted(runtime.dir, {
    protocol: 1, envelopeHash: canonicalHash(envelope), executionId: "execution-1", configHash: envelope.claim.configHash,
    generation: 1, acceptedAt: new Date().toISOString(), launch: "intended", worker: null,
  });
  await runControlWorker(["--source-dir", runtime.dir, "--execution-id", "execution-1", "--nonce", "nonce-1"]);
  expect((await readFile(`${runtime.marker}.calls`, "utf8")).trim().split("\n")).toEqual(workTokens===null?["plan", "execute", "verify"]:["plan"]);
  const {runControlCommand}=await import("../../src/control/command.js");
  const result=await runControlCommand(["collect","--agents",join(runtime.dir,"absent-agents.json")],JSON.stringify({input:envelope,afterSeq:0}));
  expect(result.code,result.stderr).toBe(0);
  const collected=JSON.parse(result.stdout);
  if (workTokens !== null) {
    expect(collected.terminal).toMatchObject({status:"blocked_waiting_human",waitingOnHuman:false,waitingCause:"token-allowance",allowanceNextPhase:"execute"});
    expect(collected.candidate.missing).toEqual([]);
    const {readEvidence}=await import("../../src/control/evidence.js");
    const packet=JSON.parse((await readEvidence(runtime.dir,collected.candidate.handoff)).toString());
    expect(packet.allowanceContinuation).toMatchObject({nextPhase:"execute",execution:null});
    expect(packet.artifacts).toContainEqual(packet.allowanceContinuation.plan);
    expect(JSON.parse((await readEvidence(runtime.dir,packet.acceptedContract)).toString())).toEqual(envelope.work.contract);
    expect(packet.contractHash).toBe(envelope.contractHash);
    expect(packet.allowanceContinuation.usage).toEqual(expect.objectContaining({artifactId:expect.any(String),hash:expect.any(String)}));
    expect(packet.artifacts).toContainEqual(packet.allowanceContinuation.usage);
    const sourceLedger=JSON.parse((await readEvidence(runtime.dir,packet.allowanceContinuation.usage)).toString());
    const settledWork=collected.events.filter((event:any)=>event.bucket==="work").at(-1);
    expect(sourceLedger.events.at(-1)).toEqual(settledWork);
    expect(sourceLedger.totals.work).toEqual(settledWork.cumulative);
    expect(sourceLedger.totals.work).toMatchObject({tokens:1_600_000,attempts:1,sessions:1});
    expect(sourceLedger.nextSeq).toBe(packet.usageHighWater);

    return;
  }
  expect(collected.terminal.status).toBe("succeeded");
  expect(collected.terminal.budgetSnapshot).toMatchObject({tokenBudgetRemaining:null,tokenRemainingStatus:"unlimited"});
  expect(collected.events.filter((e:any)=>e.bucket==="work").at(-1).cumulative.tokens).toBe(4_800_000);
}
it("v4 worker executes all phases and publishes finite usage above three million tokens",{timeout:60000},()=>runWorker());
it("v4 worker parks a cap allowance and retains reachable completed phase evidence",{timeout:60000},()=>runWorker(1_600_000));

it("review I2: worker captures actual work usage including soft allowance overshoot",{timeout:60000},()=>runWorker(1_500_000));
