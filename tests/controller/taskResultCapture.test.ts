import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStopRequestSignal, runLoop } from "../../src/controller/runLoop.js";
import type { RuntimeAdapter } from "../../src/runtime/types.js";
import { readOwnerRecord, writeOwnerRecord } from "../../src/persistence/fileStore.js";
import { armAncestorSwap } from "../control/taskResultBoundaryFixture.js";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});
import { manifestOf, report, resultFixture, verified } from "../control/taskResultFixture.js";

describe("immutable live attempt results",()=>{
  // Removing the execute-boundary capture loses the live observation before any candidate exists.
  it("reads execution while verify pauses, then retains the same bytes after verify edits and cleanup",async()=>{
    const f=await resultFixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let executes=0,verifies=0,workspace="";
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{executes++;workspace=c.worktreePath;await writeFile(join(workspace,"answer.txt"),"execute bytes\n");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",tokenUsage:7,taskResult:report}},verify:async()=>{verifies++;entered();await gate;await writeFile(join(workspace,"answer.txt"),"verifier bytes\n");return verified}};
    const running=runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});await ready;
    try{
      await expect.poll(async () => { const r = await f.rpc("task-results", { input: f.input, afterRevision: 0 }); return r.code === 0 ? JSON.parse(r.stdout).manifests.length : 0; }, { timeout: 1000 }).toBe(2);
      const live=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(live.code,live.stderr).toBe(0);
      const collection=JSON.parse(live.stdout);expect(collection).toMatchObject({schema:"ccloop-task-results-v1",currentAttempt:1,revision:2,nextRevision:2});expect(collection.manifests).toHaveLength(2);
      const manifest=await manifestOf(f,collection.manifests[0].ref);expect(manifest).toMatchObject({stage:"execution",attempt:1,explanation:{status:"available"},verificationRef:null});
      const started = await manifestOf(f, collection.manifests[1].ref);
      expect(started).toMatchObject({ stage: "verification", attempt: 1, outputs: manifest.outputs, executionRef: manifest.executionRef });
      const startRead = await f.rpc("read-task-result-evidence", { input: f.input, manifestRef: collection.manifests[1].ref, ref: started.verificationRef });
      expect(JSON.parse(Buffer.from(JSON.parse(startRead.stdout).base64, "base64").toString())).toEqual({ schema: "ccloop-task-result-verification-started-v1", attempt: 1, status: "in-progress" });
      const core=await f.rpc("collect",{input:f.input,afterSeq:0});expect(JSON.parse(core.stdout).candidate).toBeNull();
    }finally{release()}
    expect((await running).status).toBe("succeeded");expect([executes,verifies]).toEqual([1,1]);await expect(access(workspace)).rejects.toThrow();
    const page=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:0})).stdout);expect(page.manifests.map((m:any)=>m.revision)).toEqual([1,2,3]);
    const first=await manifestOf(f,page.manifests[0].ref),last=await manifestOf(f,page.manifests[2].ref);expect(last.stage).toBe("verification");expect(last.outputs).toEqual(first.outputs);expect(last.executionRef).toEqual(first.executionRef);
    const bytes=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:page.manifests[2].ref,ref:last.outputs[0].ref});expect(Buffer.from(JSON.parse(bytes.stdout).base64,"base64").toString()).toBe("execute bytes\n");
    const vr=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:page.manifests[2].ref,ref:last.verificationRef});expect(JSON.parse(Buffer.from(JSON.parse(vr.stdout).base64,"base64").toString()).approved).toBe(true);
  });
  // A partial==failed shortcut would suppress real verification; missing reports must preserve the execution snapshot.
  it.each([undefined,{bad:"report"},report])("retains partial reports without changing actual verification or usage: %j",async taskResult=>{
    const f=await resultFixture();let verifies=0;
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{await writeFile(join(c.worktreePath,"answer.txt"),"partial bytes");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",completionStatus:"partial",failureType:"error",failureMessage:"partial",tokenUsage:9,taskResult}},verify:async()=>{verifies++;return verified}};
    const state=await runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});expect(state.status).toBe("succeeded");expect(verifies).toBe(1);expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(991);
    const page=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:0})).stdout);const m=await manifestOf(f,page.manifests[1].ref);expect(m.explanation.status).toBe(taskResult===undefined?"missing":"bad" in taskResult?"invalid":"available");expect(m.outputs[0].status).toBe("available");
  });
  // Optional namespace refusal must never turn a successful attempt into a failure.
  it("diagnoses capture I/O failure without changing core success",async()=>{
    const f=await resultFixture();await mkdir(join(f.sourceDir,"control","task-result-evidence"));await symlink(f.repo,join(f.sourceDir,"control","task-result-evidence","blocked"));
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{await writeFile(join(c.worktreePath,"answer.txt"),"x");await writeFile(join(f.runDir,"task-result-captures"),"blocks directory");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report}},verify:async()=>verified};
    const state=await runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});expect(state.status).toBe("succeeded");expect(await readFile(join(f.runDir,"events.jsonl"),"utf8")).toContain("task_result_capture_failed");
  });
  // A later successful terminal must never upgrade attempt one's rejected verification.
  it("shows rejected attempt one as history while attempt two executes, then records its separate pass",async()=>{
    const f=await resultFixture();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let verifies=0;
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{if(c.attempt===2){entered();await gate}await writeFile(join(c.worktreePath,"answer.txt"),`attempt ${c.attempt}`);return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report}},verify:async()=>{verifies++;return verifies===1?{...verified,approved:false,rejectCategory:"test-failure",safeToRetry:true}:verified}};
    const running=runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input});await ready;
    try{const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);const page=JSON.parse(r.stdout);expect(page.currentAttempt).toBe(2);expect(page.manifests).toHaveLength(3);expect((await manifestOf(f,page.manifests[2].ref)).attempt).toBe(1)}finally{release()}
    expect((await running).status).toBe("succeeded");const page=JSON.parse((await f.rpc("task-results",{input:f.input,afterRevision:0})).stdout);expect(page.manifests).toHaveLength(6);const rejected=await manifestOf(f,page.manifests[2].ref);const read=await f.rpc("read-task-result-evidence",{input:f.input,manifestRef:page.manifests[2].ref,ref:rejected.verificationRef});expect(JSON.parse(Buffer.from(JSON.parse(read.stdout).base64,"base64").toString()).approved).toBe(false);
  });

  // Handoff before verify must retain only execution evidence, never a fabricated approval.
  it.each(["plan","execute"] as const)("handoff after %s retains only actually executed observations",async phase=>{
    const f=await resultFixture(),stopRequested=createStopRequestSignal();let verifies=0;
    const adapter:RuntimeAdapter={plan:async()=>({summary:"write",primaryTargetPaths:["answer.txt"]}),execute:async c=>{await writeFile(join(c.worktreePath,"answer.txt"),"handoff bytes");return {changedFiles:["answer.txt"],diffPatch:"patch",commandOutputs:[],stdoutStderrLog:"ok",taskResult:report}},verify:async()=>{verifies++;return verified}};
    await runLoop(f.contract,f.runDir,adapter,{taskResultInput:f.input,stopRequested,onPhaseSettled:async observation=>{if(observation.phase===phase)stopRequested.requested=true}});expect(verifies).toBe(0);const r=await f.rpc("task-results",{input:f.input,afterRevision:0});expect(r.code,r.stderr).toBe(0);const page=JSON.parse(r.stdout);expect(page.manifests).toHaveLength(phase==="plan"?0:1);if(phase==="execute")expect(await manifestOf(f,page.manifests[0].ref)).toMatchObject({stage:"execution",verificationRef:null});
  });

  // A transient unsafe ancestor must stay unavailable without failing the actual task.
  it("real capture refuses outside bytes during an ancestor swap and preserves success", async () => {
    const f = await resultFixture();
    let race: Awaited<ReturnType<typeof armAncestorSwap>> | undefined;
    let verifies = 0;
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "answer.txt"), "OUTSIDE SENTINEL");
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "write", primaryTargetPaths: ["output/answer.txt"] }),
      execute: async context => {
        const directory = join(context.worktreePath, "output");
        await mkdir(directory);
        await writeFile(join(directory, "answer.txt"), "inside snapshot");
        race = await armAncestorSwap(directory, outside, "answer.txt");
        return { changedFiles: ["output/answer.txt"], diffPatch: "patch", commandOutputs: [],
          stdoutStderrLog: "ok", tokenUsage: 9,
          taskResult: { ...report, outputs: [{ path: "output/answer.txt", label: "Answer" }] } };
      },
      verify: async () => { await race!.close(); verifies++; return verified; },
    };
    try {
      const state = await runLoop(f.contract, f.runDir, adapter, { taskResultInput: f.input });
      expect(state.status).toBe("succeeded");
      expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(991);
      expect(verifies).toBe(1);
      expect(race!.wasSwapped()).toBe(true);
      const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
      expect(response.code, response.stderr).toBe(0);
      const page = JSON.parse(response.stdout);
      const manifest = await manifestOf(f, page.manifests[0].ref);
      expect(manifest.outputs[0]).toMatchObject({ path: "output/answer.txt", status: "changed", ref: null, byteLength: null });
    } finally { await race?.close(); }
  });

  // Owner loss during staging must not make a late result index reachable.
  it.each(["execution", "verification-started", "verification-completed"] as const)("refuses owner transfer during %s index staging", async stage => {
    const f = await resultFixture();
    const originalOpen = fs.open;
    let publications = 0;
    let changedOwner = false;
    let workspace = "";
    let verifies = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const path = String(args[0]);
      if (dirname(path) === join(f.runDir, "task-result-captures") && basename(path).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          publications++;
          if (publications === (stage === "execution" ? 1 : stage === "verification-started" ? 2 : 3)) {
            const owner = await readOwnerRecord(f.runDir);
            await writeOwnerRecord(f.runDir, { ...owner, currentOwnerEpoch: owner.currentOwnerEpoch + 1,
              currentProcessInstanceId: "foreign-controller" });
            changedOwner = true;
          }
        };
      }
      return handle;
    });
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "write", primaryTargetPaths: ["answer.txt"] }),
      execute: async context => {
        workspace = context.worktreePath;
        await writeFile(join(workspace, "answer.txt"), "execute bytes");
        return { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "ok", taskResult: report };
      },
      verify: async () => { verifies++; return verified; },
    };
    try {
      const state = await runLoop(f.contract, f.runDir, adapter, { taskResultInput: f.input });
      expect(changedOwner).toBe(true);
      expect(state).toMatchObject({ status: "cancelled", stopReason: "lease_lost" });
      expect(verifies).toBe(stage === "execution" ? 0 : 1);
      expect((await readOwnerRecord(f.runDir)).currentProcessInstanceId).toBe("foreign-controller");
      await access(workspace);
      const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
      expect(response.code, response.stderr).toBe(0);
      const page = JSON.parse(response.stdout);
      expect(page.revision).toBe(stage === "execution" ? 0 : stage === "verification-started" ? 1 : 2);
      expect(page.manifests).toHaveLength(stage === "execution" ? 0 : stage === "verification-started" ? 1 : 2);
      if (stage === "verification-started") {
        expect(await manifestOf(f, page.manifests[0].ref)).toMatchObject({ stage: "execution", verificationRef: null });
      }
    } finally { spy.mockRestore(); }
  });

  // A blocked optional start publication must not delay verification or charge metadata wait to its clock.
  it("settles real verification usage while started metadata publication is blocked", async () => {
    const f = await resultFixture();
    const originalOpen = fs.open;
    let publications = 0;
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let blocked!: () => void;
    const metadataBlocked = new Promise<void>(resolve => { blocked = resolve; });
    let settled!: () => void;
    const verificationSettled = new Promise<void>(resolve => { settled = resolve; });
    let clock = Date.now();
    const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const phases: Array<{ phase: string; tokenUsage: number | null; elapsedMs: number }> = [];
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const path = String(args[0]);
      if (dirname(path) === join(f.runDir, "task-result-captures") && basename(path).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          if (++publications === 2) { blocked(); await gate; }
        };
      }
      return handle;
    });
    let verifies = 0;
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "write", primaryTargetPaths: ["answer.txt"] }),
      execute: async context => {
        await writeFile(join(context.worktreePath, "answer.txt"), "execute bytes");
        return { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "ok", tokenUsage: 9, taskResult: report };
      },
      verify: async () => { verifies++; return { ...verified, tokenUsage: 11 }; },
    };
    const running = runLoop(f.contract, f.runDir, adapter, {
      taskResultInput: f.input,
      onPhaseSettled: async observation => {
        phases.push(observation);
        if (observation.phase === "verify") settled();
      },
    });
    try {
      await metadataBlocked;
      await Promise.race([verificationSettled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("verification gated on metadata")), 2000))]);
      expect(verifies).toBe(1);
      expect(phases.find(phase => phase.phase === "verify")).toMatchObject({ tokenUsage: 11, elapsedMs: 0 });
      clock += 500;
    } finally { unblock(); }
    try {
      const state = await running;
      expect(state.status).toBe("succeeded");
      expect(state.budgetSnapshot).toMatchObject({ tokenBudgetRemaining: 980, timeRemainingMs: 30000 });
      const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
      expect(response.code, response.stderr).toBe(0);
      const page = JSON.parse(response.stdout);
      expect(page.manifests).toHaveLength(3);
      const started = await manifestOf(f, page.manifests[1].ref);
      const read = await f.rpc("read-task-result-evidence", { input: f.input, manifestRef: page.manifests[1].ref, ref: started.verificationRef });
      expect(JSON.parse(Buffer.from(JSON.parse(read.stdout).base64, "base64").toString())).toEqual({ schema: "ccloop-task-result-verification-started-v1", attempt: 1, status: "in-progress" });
    } finally { date.mockRestore(); open.mockRestore(); }
  });

  // Measured provider failure settles before optional I/O; its phase context survives to existing error routing.
  it.each(["failure", "handoff", "owner-loss"] as const)("settles blocked-start provider error before release and preserves %s routing", async routing => {
    const f = await resultFixture();
    const stopRequested = createStopRequestSignal();
    const originalOpen = fs.open;
    let publications = 0;
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let blocked!: () => void;
    const metadataBlocked = new Promise<void>(resolve => { blocked = resolve; });
    let settled!: () => void;
    const verificationSettled = new Promise<void>(resolve => { settled = resolve; });
    let clock = Date.now();
    const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const phases: Array<{ phase: string; tokenUsage: number | null; elapsedMs: number; completedWithResult: boolean }> = [];
    let verifies = 0;
    let workspace = "";
    let returned = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const path = String(args[0]);
      if (dirname(path) === join(f.runDir, "task-result-captures") && basename(path).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          if (++publications === 2) {
            blocked();
            await gate;
            if (routing === "owner-loss") {
              const owner = await readOwnerRecord(f.runDir);
              await writeOwnerRecord(f.runDir, { ...owner, currentOwnerEpoch: owner.currentOwnerEpoch + 1,
                currentProcessInstanceId: "foreign-controller" });
            }
          }
        };
      }
      return handle;
    });
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "write", primaryTargetPaths: ["answer.txt"] }),
      execute: async context => {
        workspace = context.worktreePath;
        await writeFile(join(workspace, "answer.txt"), "execute bytes");
        return { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "ok", tokenUsage: 9, taskResult: report };
      },
      verify: async () => {
        verifies++;
        throw Object.assign(new Error("owned provider error"), { observedTokens: 13 });
      },
    };
    const running = runLoop(f.contract, f.runDir, adapter, {
      taskResultInput: f.input,
      stopRequested,
      onPhaseSettled: async observation => {
        phases.push(observation);
        if (observation.phase === "verify") {
          if (routing === "handoff") stopRequested.requested = true;
          settled();
        }
      },
    }).then(state => { returned = true; return state; });
    let beforeRelease = false;
    try {
      await metadataBlocked;
      beforeRelease = await Promise.race([
        verificationSettled.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
      ]);
      expect(verifies).toBe(1);
      expect(beforeRelease, "measured provider-error usage must settle independently of optional metadata").toBe(true);
      expect(phases.filter(phase => phase.phase === "verify")).toEqual([
        expect.objectContaining({ tokenUsage: 13, elapsedMs: 0, completedWithResult: false }),
      ]);
      expect(returned).toBe(false);
      await access(workspace);
      const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
      expect(response.code, response.stderr).toBe(0);
      expect(JSON.parse(response.stdout).revision).toBe(1);
      clock += 500;
    } finally {
      unblock();
      try {
        const state = await running;
        expect(state.budgetSnapshot).toMatchObject({ tokenBudgetRemaining: 978, timeRemainingMs: 30000 });
        expect(phases.filter(phase => phase.phase === "verify")).toHaveLength(1);
        const events = await readFile(join(f.runDir, "events.jsonl"), "utf8");
        if (routing === "failure") {
          expect(state).toMatchObject({ status: "failed", stopReason: "Error: owned provider error" });
          expect(events).toContain('"type":"attempt_failed"');
          await expect(access(workspace)).rejects.toThrow();
        } else if (routing === "handoff") {
          expect(state.status).toBe("verifying");
          expect(events).toContain("handoff requested during verify in attempt 1");
          expect(JSON.parse(await readFile(join(f.runDir, "attempts", "1", "execution.json"), "utf8"))).toMatchObject({ tokenUsage: 9, changedFiles: ["answer.txt"] });
          await expect(access(join(f.runDir, "attempts", "1", "verification.json"))).rejects.toThrow();
          await access(workspace);
        } else {
          expect(state).toMatchObject({ status: "cancelled", stopReason: "lease_lost" });
          expect((await readOwnerRecord(f.runDir)).currentProcessInstanceId).toBe("foreign-controller");
          await access(workspace);
        }
        const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
        expect(response.code, response.stderr).toBe(0);
        expect(JSON.parse(response.stdout).revision).toBe(routing === "owner-loss" ? 1 : 2);
      } finally { date.mockRestore(); open.mockRestore(); }
    }
  });

  // A genuine asynchronous fence refusal must not discard measured provider-error usage.
  it("preserves pending verifier error usage before a queued start publication loses its owner", async () => {
    const f = await resultFixture();
    const originalOpen = fs.open;
    let publications = 0;
    let changedOwner = false;
    let verifies = 0;
    const phases: Array<{ phase: string; tokenUsage: number | null }> = [];
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const path = String(args[0]);
      if (dirname(path) === join(f.runDir, "task-result-captures") && basename(path).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          if (++publications === 2) {
            const owner = await readOwnerRecord(f.runDir);
            await writeOwnerRecord(f.runDir, { ...owner, currentOwnerEpoch: owner.currentOwnerEpoch + 1,
              currentProcessInstanceId: "foreign-controller" });
            changedOwner = true;
          }
        };
      }
      return handle;
    });
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "write", primaryTargetPaths: ["answer.txt"] }),
      execute: async context => {
        await writeFile(join(context.worktreePath, "answer.txt"), "execute bytes");
        return { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "ok", tokenUsage: 9, taskResult: report };
      },
      verify: async () => { verifies++; throw Object.assign(new Error("provider error"), { observedTokens: 13 }); },
    };
    try {
      const state = await runLoop(f.contract, f.runDir, adapter, {
        taskResultInput: f.input, onPhaseSettled: async observation => { phases.push(observation); },
      });
      expect(changedOwner).toBe(true);
      expect(verifies).toBe(1);
      expect(state).toMatchObject({ status: "cancelled", stopReason: "lease_lost" });
      expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(978);
      expect(phases.filter(phase => phase.phase === "verify")).toEqual([expect.objectContaining({ tokenUsage: 13 })]);
      const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
      expect(response.code, response.stderr).toBe(0);
      expect(JSON.parse(response.stdout).revision).toBe(1);
    } finally { open.mockRestore(); }
  });

  // Start-only metadata failure cannot suppress the completed verifier evidence or repeat the start observation.
  it("keeps actual completion and deduplicates a start whose optional evidence write failed", async () => {
    const f = await resultFixture();
    const originalOpen = fs.open;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = (async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        const bytes = writeArgs[0];
        if (Buffer.isBuffer(bytes)) {
          const text = bytes.toString();
          if (text.includes('"schema":"ccloop-task-result-verification-started-v1"')) {
            throw Object.assign(new Error("owned start evidence failure"), { code: "EIO" });
          }
        }
        return await write(...writeArgs);
      }) as typeof handle.writeFile;
      return handle;
    });
    let verifies = 0;
    const adapter: RuntimeAdapter = {
      plan: async () => ({ summary: "write", primaryTargetPaths: ["answer.txt"] }),
      execute: async context => {
        await writeFile(join(context.worktreePath, "answer.txt"), "execute bytes");
        return { changedFiles: ["answer.txt"], diffPatch: "patch", commandOutputs: [], stdoutStderrLog: "ok", tokenUsage: 9, taskResult: report };
      },
      verify: async () => { verifies++; return { ...verified, tokenUsage: 11 }; },
    };
    try {
      const state = await runLoop(f.contract, f.runDir, adapter, { taskResultInput: f.input });
      expect(state.status).toBe("succeeded");
      expect(state.budgetSnapshot.tokenBudgetRemaining).toBe(980);
      expect(verifies).toBe(1);
      const response = await f.rpc("task-results", { input: f.input, afterRevision: 0 });
      expect(response.code, response.stderr).toBe(0);
      const page = JSON.parse(response.stdout);
      expect(page.manifests).toHaveLength(3);
      expect(page.manifests.every((entry: Record<string, unknown>) => !("kind" in entry))).toBe(true);
      const started = await manifestOf(f, page.manifests[1].ref);
      const completed = await manifestOf(f, page.manifests[2].ref);
      expect(started.verificationRef).toBeNull();
      expect(completed.verificationRef).not.toBeNull();
      const read = await f.rpc("read-task-result-evidence", { input: f.input, manifestRef: page.manifests[2].ref, ref: completed.verificationRef });
      expect(JSON.parse(Buffer.from(JSON.parse(read.stdout).base64, "base64").toString()).approved).toBe(true);
      expect(await readFile(join(f.runDir, "events.jsonl"), "utf8")).toContain("task_result_capture_failed");
    } finally { open.mockRestore(); }
  });

});
