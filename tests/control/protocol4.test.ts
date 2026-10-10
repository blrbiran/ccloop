import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectExecution } from "../../src/control/collect.js";
import { describe, expect, it } from "vitest";
import { fixture } from "./optionalFixture.js";
import { parseControlRequest, canonicalHash } from "../../src/control/protocol.js";
import { runControlCommand, usageEventSchema } from "../../src/control/command.js";

describe("optional token policy protocol boundary", () => {
 it("negotiates features independently without advertising unfinished features", async () => {
   const result = await runControlCommand(["features"], "{}");
   expect(result.code).toBe(0);
   expect(JSON.parse(result.stdout)).toEqual({protocol:1, tokenPolicy:"optional-v1"});
 });
 it("accepts v4 nullable normal work while preserving v3 hash and refusing nullable v3", async () => {
   const {envelope} = await fixture(); const hash=canonicalHash(envelope);
   expect(canonicalHash(parseControlRequest("accept", envelope))).toBe(hash);
   const nullable = structuredClone(envelope); nullable.work.contract.executionPolicy.tokenBudget = null;
   nullable.claim.grant.work = {...nullable.claim.grant.work, tokens:null};
   expect(() => parseControlRequest("accept", nullable)).toThrow("control-request-invalid");
   const v4 = {...nullable, protocol:4};
   expect(parseControlRequest("accept", v4)).toEqual(v4);
   expect(() => parseControlRequest("accept", {...v4,claim:{...v4.claim,grant:{...v4.claim.grant,work:{...v4.claim.grant.work,sessions:0}}}})).toThrow("control-request-invalid");
   expect(() => parseControlRequest("accept", {...v4,claim:{...v4.claim,grant:{...v4.claim.grant,handoff:{...v4.claim.grant.handoff,tokens:null}}}})).toThrow("control-request-invalid");
   expect(() => parseControlRequest("accept", {...v4,tokenPolicy:{authoredTokenCeiling:null,bindingCauses:["spend-cap"],inheritedUsage:{tokens:null,activeMs:0,attempts:0,sessions:0}}})).toThrow("control-request-invalid");
   expect(() => parseControlRequest("accept", {...v4, unexpected:true})).toThrow("control-request-invalid");
 });
 it("never accepts null, infinite or unsafe usage", () => {
   const event={runId:"r",generation:1,eventSeq:1,bucket:"work",cumulative:{tokens:1,activeMs:0,attempts:1,sessions:1},source:{artifactId:"a",hash:"a".repeat(64)}};
   expect(usageEventSchema.safeParse(event).success).toBe(true);
   for (const tokens of [null, Infinity, -1, Number.MAX_SAFE_INTEGER+1]) expect(usageEventSchema.safeParse({...event,cumulative:{...event.cumulative,tokens}}).success).toBe(false);
 });
 it("projects internal extensions out of the exact v3 terminal and candidate shape", async () => {
   const {root,envelope}=await fixture();
   await mkdir(join(root,"control")); await mkdir(join(root,"run"));
   const state={status:"exhausted",currentAttempt:1,attemptsUsed:1,lastTransitionAt:"2026-10-11T00:00:00Z",waitingOnHuman:false,stopReason:"budget",budgetSnapshot:{attemptsRemaining:1,timeRemainingMs:10,tokenBudgetRemaining:0},recentFailures:[]};
   const candidate={groupId:"g",workItemId:"w",taskId:"t",runId:"r",generation:1,graphVersion:1,targetVersion:1,checkpointId:"c",usageHighWater:0,result:"partial",artifacts:[],snapshot:null,missing:[],unresolvedRequestIds:[],stopProof:null,terminalOutcome:"exhausted",handoff:{artifactId:"h",hash:"a".repeat(64)}};
   await writeFile(join(root,"run","loop-state.json"),JSON.stringify({...state,waitingCause:"token-allowance",budgetSnapshot:{...state.budgetSnapshot,tokenRemainingStatus:"known"}}),{mode:0o600});
   await writeFile(join(root,"control","candidate.json"),JSON.stringify({...candidate,privateRecovery:{mode:"future"}}),{mode:0o600});
   const result=await collectExecution(envelope,0);
   expect(result.terminal).toEqual(state);
   expect(result.candidate).toEqual(candidate);
 });

});
