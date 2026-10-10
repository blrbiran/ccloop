import { evaluateResumeEligibility } from "../../src/controller/resumeLoop.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLoop, runLoopFromState } from "../../src/controller/runLoop.js";
import { ScriptedAdapter } from "../../src/runtime/scriptedAdapter.js";
import { loopContractSchema } from "../../src/contract/schema.js";
import { amountSchema, remainingBudget, budgetFits, tokenRemainingStatus } from "../../src/budget/tokenPolicy.js";
import { createContract, createRepo } from "./optionalFixture.js";

describe("optional cumulative token ceiling", () => {
  it("executes and verifies beyond three million observed tokens", async () => {
    const contract = createContract(await createRepo(), ["true"], null);
    const phases: string[] = [];
    const state = await runLoop(contract, await mkdtemp(join(tmpdir(), "optional-")), new ScriptedAdapter([{
      plan: { summary: "plan", primaryTargetPaths: ["src/index.ts"], tokenUsage: 1_600_000 },
      execution: { changedFiles: [], diffPatch: "", commandOutputs: [], stdoutStderrLog: "", tokenUsage: 1_600_000 },
      verification: { approved: true, rejectCategory: "", primaryTargetPaths: [], failingCommand: null, safeToRetry: false, evidence: [], pauseSignals: [], stopSignals: [] },
    }]), { onPhaseSettled: async observation => { phases.push(observation.phase); } });
    expect(phases).toEqual(["plan", "execute", "verify"]);
    expect(state.status).toBe("succeeded");
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBeNull();
    expect(state.budgetSnapshot.tokenRemainingStatus).toBe("unlimited");
  });
  it("parses null and zero ceilings but refuses invalid ceiling and extra fields", async () => {
    const contract = createContract(await createRepo(), ["true"], null);
    expect(loopContractSchema.safeParse(contract).success).toBe(true);
    for (const tokenBudget of [0, 100]) expect(loopContractSchema.safeParse({...contract, executionPolicy:{...contract.executionPolicy, tokenBudget}}).success).toBe(true);
    for (const tokenBudget of [-1, Infinity, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) expect(loopContractSchema.safeParse({...contract, executionPolicy:{...contract.executionPolicy, tokenBudget}}).success).toBe(false);
  });
  it("keeps finite dimensions and finite usage independent of unlimited tokens", () => {
    const cap={tokens:null,activeMs:100,attempts:2,sessions:1};
    const used={tokens:3_200_000,activeMs:40,attempts:1,sessions:1};
    expect(remainingBudget(cap,used)).toEqual({tokens:null,activeMs:60,attempts:1,sessions:0});
    expect(budgetFits(used,cap)).toBe(true);
    for (const key of ["activeMs","attempts","sessions"] as const) expect(budgetFits({...used,[key]:cap[key]+1},cap)).toBe(false);
    expect(budgetFits(used,{...cap,tokens:0})).toBe(false);
    for (const tokens of [null,Infinity,-1,Number.MAX_SAFE_INTEGER+1]) expect(amountSchema.safeParse({...used,tokens}).success).toBe(false);
    expect(tokenRemainingStatus(undefined,false)).toBe("unknown");
    expect(tokenRemainingStatus(null,true)).toBe("unlimited");
    expect(tokenRemainingStatus(null,false)).toBe("unknown");
  });
  it("retains unknown status after an absent phase observation under a null ceiling", async () => {
    const state = await runLoop(createContract(await createRepo(),["true"],null), await mkdtemp(join(tmpdir(), "unknown-")),new ScriptedAdapter([{
      plan:{summary:"plan",primaryTargetPaths:[]},
      execution:{changedFiles:[],diffPatch:"",commandOutputs:[],stdoutStderrLog:"",tokenUsage:1},
      verification:{approved:true,rejectCategory:"",primaryTargetPaths:[],failingCommand:null,safeToRetry:false,evidence:[],pauseSignals:[],stopSignals:[]},
    }]));
    expect(state.budgetSnapshot.tokenRemainingStatus).toBe("unknown");
    expect(state.budgetSnapshot.tokenBudgetRemaining).toBeNull();
  });

  it.each(["tokens", "activeMs", "attempts", "sessions"] as const)("exhausts a zero %s grant before a provider is called", async dimension => {
    const contract = createContract(await createRepo(), ["true"], null);
    const grant = {tokens:null as number|null,activeMs:10_000,attempts:2,sessions:1,[dimension]:0};
    const state = await runLoop(contract, await mkdtemp(join(tmpdir(), "bounded-")), () => { throw new Error("provider must not launch"); }, { workGrant: grant });
    expect(state.status).toBe("exhausted");
    expect(state.attemptsUsed).toBe(0);
  });

  it("refuses a legacy null remaining observation under a finite authored ceiling", async () => {
    const contract = createContract(await createRepo(),["true"],100);
    const initial={status:"planning" as const,currentAttempt:0,attemptsUsed:0,lastTransitionAt:new Date().toISOString(),waitingOnHuman:false,stopReason:null,budgetSnapshot:{attemptsRemaining:2,timeRemainingMs:10000,tokenBudgetRemaining:null},recentFailures:[]};
    await expect(runLoopFromState(contract,await mkdtemp(join(tmpdir(),"legacy-unknown-")),()=>{throw new Error("provider launched");},initial)).rejects.toThrow("token-usage-unknown");
  });

  it("refuses unknown usage at resume eligibility before destructive cleanup", () => {
    const gate={ownerRecord:{supersededByEpoch:null,currentOwnerEpoch:1,ownerStatus:"current"},ownerTransfer:{eligibleForContinuation:true,newOwnerEpoch:1},reconciliation:{eligibleForContinuation:true,ownershipVerdict:"OWNER_LOST",newOwnerEpoch:1},runState:{status:"planning",budgetSnapshot:{tokenBudgetRemaining:null}}};
    for(const tokenRemainingStatus of [undefined,"unknown"]) expect(evaluateResumeEligibility({...gate,runState:{...gate.runState,budgetSnapshot:{...gate.runState.budgetSnapshot,tokenRemainingStatus}}} as any)).toEqual({ok:false,reason:"token-usage-unknown"});
    expect(evaluateResumeEligibility({...gate,runState:{...gate.runState,budgetSnapshot:{...gate.runState.budgetSnapshot,tokenRemainingStatus:"unlimited"}}} as any)).toEqual({ok:true});
  });

});
