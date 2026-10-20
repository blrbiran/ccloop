import { parseKnownWorkUsageLedger } from "./usage.js";
import { tokenPolicySchema } from "../budget/tokenPolicy.js";
import { evaluateStopDecision } from "../stop/stopController.js";
import type { RunControlHooks } from "../controller/runLoop.js";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loopContractSchema, type LoopContract } from "../contract/schema.js";
import { createAttemptWorkspace } from "../workspace/worktreeManager.js";
import { canonicalHash, artifactRefSchema, type ArtifactRefV1, type InputCheckpointV1, type LoopStartEnvelope } from "./protocol.js";

const execFileAsync = promisify(execFile);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const oidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const relativePathSchema = z.string().min(1).refine(path =>
 !isAbsolute(path) && !path.includes("\\") && !path.split("/").some(part => part === "" || part === "." || part === ".."),
 "control-resume-path-invalid",
);
const safeMode = z.number().int().nonnegative().max(0o777);
const fileTreeEntry = z.object({path:relativePathSchema,kind:z.literal("file"),mode:safeMode,ref:artifactRefSchema,target:z.never().optional()}).strict();
const directoryTreeEntry = z.object({path:relativePathSchema,kind:z.literal("directory"),mode:safeMode,ref:z.never().optional(),target:z.never().optional()}).strict();
const symlinkTreeEntry = z.object({path:relativePathSchema,kind:z.literal("symlink"),mode:safeMode,ref:z.never().optional(),target:z.string()}).strict();
const snapshotSchema = z.object({
 version:z.literal(1),head:oidSchema,bundle:artifactRefSchema,
 index:z.array(z.object({path:relativePathSchema,mode:z.string().regex(/^[0-7]{6}$/),oid:oidSchema,stage:z.number().int().min(0).max(3),ref:artifactRefSchema.nullable()}).strict()),
 tree:z.array(z.union([fileTreeEntry,directoryTreeEntry,symlinkTreeEntry])),deleted:z.array(relativePathSchema),missing:z.array(z.string()),
}).strict();
const resumeBundleSchema = z.object({
 protocol:z.literal(1),predecessorRunId:z.string().min(1),checkpointId:z.string().min(1),checkpointHash:hashSchema,
 checkpoint:artifactRefSchema,snapshot:artifactRefSchema,
 artifacts:z.array(z.object({ref:artifactRefSchema,file:relativePathSchema}).strict()).min(1),
 unfinished:z.array(z.string()),pendingDecisions:z.array(z.string()),awaitingHuman:z.array(z.string()),
}).strict();

type SnapshotV1 = z.infer<typeof snapshotSchema>;
type ResumeBundleV1 = z.infer<typeof resumeBundleSchema>;
interface LoadedBundle { manifest:ResumeBundleV1;snapshot:SnapshotV1;bytes:Map<string,Buffer>;fingerprints:Map<string,string> }
export interface MaterializeDependencies { afterValidation?:()=>Promise<void> }

function fail(code: string): never { throw new Error(code); }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function within(parent: string, child: string): boolean {
 const rel=relative(parent,child);return rel===""||(!rel.startsWith(`..${sep}`)&&rel!==".."&&!isAbsolute(rel));
}
function safeChild(root:string,path:string):string {
 const parsed=relativePathSchema.safeParse(path);if(!parsed.success) fail("control-resume-path-invalid");
 const result=join(root,...path.split("/"));if(!within(root,result)||result===root) fail("control-resume-path-invalid");return result;
}
async function fingerprint(path:string):Promise<string> {
 const stat=await lstat(path,{bigint:true});
 return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.mode,stat.nlink].map(String).join(":");
}
async function readPrivateRegular(path:string):Promise<{bytes:Buffer;fingerprint:string}> {
 let stat;try{stat=await lstat(path);}catch{fail("control-resume-file-missing");}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o777)!==0o600) fail("control-resume-unsafe-file");
 const before=await fingerprint(path);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes:Buffer;
 try{bytes=await file.readFile();}finally{await file.close();}
 if(await fingerprint(path)!==before) fail("control-resume-source-changed");return {bytes,fingerprint:before};
}
async function assertDirectoryTree(root:string,allowedFiles:Set<string>):Promise<void> {
 const allowedDirs=new Set<string>();for(const file of allowedFiles){let current=dirname(file);while(current!=="."){allowedDirs.add(current);current=dirname(current);}}
 async function walk(dir:string,prefix=""):Promise<void>{
  for(const name of await readdir(dir)){const rel=prefix?`${prefix}/${name}`:name,path=join(dir,name),stat=await lstat(path);
   if(stat.isSymbolicLink()) fail("control-resume-unsafe-file");
   if(stat.isDirectory()){if(!allowedDirs.has(rel))fail("control-resume-unmanifested-input");await walk(path,rel);}
   else if(!stat.isFile()||!allowedFiles.has(rel))fail("control-resume-unmanifested-input");
  }
 }
 await walk(root);
}
function collectSnapshotRefs(snapshot:SnapshotV1):ArtifactRefV1[]{
 return [snapshot.bundle,...snapshot.index.flatMap(entry=>entry.ref?[entry.ref]:[]),...snapshot.tree.flatMap(entry=>entry.kind==="file"?[entry.ref]:[])];
}
function assertUniquePaths(snapshot:SnapshotV1):void {
 const tree=new Set<string>();for(const entry of snapshot.tree){if(tree.has(entry.path))fail("control-resume-snapshot-invalid");tree.add(entry.path);}
 for(const path of tree){let parent=dirname(path);while(parent!=="."){const entry=snapshot.tree.find(item=>item.path===parent);if(entry&&entry.kind!=="directory")fail("control-resume-snapshot-invalid");parent=dirname(parent);}}
 const expectedDeleted=new Set(snapshot.index.filter(entry=>!tree.has(entry.path)).map(entry=>entry.path));
 if(expectedDeleted.size!==new Set(snapshot.deleted).size||snapshot.deleted.some(path=>!expectedDeleted.has(path)))fail("control-resume-snapshot-invalid");
}
/** Recovery mode remains in the original archive even though the core handoff projects it away. */
function refuseRecoveryCheckpoint(checkpoint:Record<string,unknown>,manifest:ResumeBundleV1,bytes:Map<string,Buffer>):void {
 const roots=z.array(artifactRefSchema).safeParse(checkpoint.artifacts);if(!roots.success)return;
 const decode=(ref:ArtifactRefV1):any=>{const value=bytes.get(ref.artifactId);if(!value||sha256(value)!==ref.hash)fail("control-resume-artifact-missing");try{return JSON.parse(value.toString("utf8"));}catch{fail("control-resume-checkpoint-invalid");}};
 for(const ref of roots.data){
  if(!ref.artifactId.startsWith("archive-"))continue;
  const archive=decode(ref);
  if(archive.version!==1||archive.runId!==manifest.predecessorRunId||canonicalHash(archive.snapshot)!==canonicalHash(manifest.snapshot))fail("control-resume-checkpoint-invalid");
  if(!Array.isArray(archive.logs))fail("control-resume-checkpoint-invalid");
  for(const path of ["control/envelope.json","run/loop-state.json"]){
   const entries=archive.logs.filter((entry:any)=>entry.path===path);if(entries.length>1)fail("control-resume-checkpoint-invalid");
   if(!entries.length)continue;
   const parsed=artifactRefSchema.safeParse(entries[0].ref);if(!parsed.success)fail("control-resume-checkpoint-invalid");
   const value=decode(parsed.data);
   if(value.mode==="verify-saved-result"||value.savedResult?.mode==="verify-saved-result")fail("saved-result-explicit-command-required");
  }
 }
}
async function loadBundle(input:InputCheckpointV1):Promise<LoadedBundle>{
 if(!isAbsolute(input.bundlePath))fail("control-resume-bundle-path-invalid");
 let root:string;try{root=await realpath(input.bundlePath);}catch{fail("control-resume-bundle-path-invalid");}
 if(root!==input.bundlePath||!(await lstat(root)).isDirectory())fail("control-resume-bundle-path-invalid");
 const manifestRead=await readPrivateRegular(join(root,"resume-bundle.json"));let raw:unknown;
 try{raw=JSON.parse(manifestRead.bytes.toString("utf8"));}catch{fail("control-resume-manifest-invalid");}
 const parsed=resumeBundleSchema.safeParse(raw);if(!parsed.success)fail("control-resume-manifest-invalid");const manifest=parsed.data;
 if(manifest.predecessorRunId!==input.predecessorRunId)fail("control-resume-predecessor-mismatch");
 if(manifest.checkpointId!==input.checkpointId||manifest.checkpointHash!==input.checkpointHash||manifest.checkpoint.hash!==input.checkpointHash)fail("control-resume-checkpoint-mismatch");
 const byId=new Map<string,ArtifactRefV1>(),files=new Set<string>(["resume-bundle.json"]);
 for(const entry of manifest.artifacts){const old=byId.get(entry.ref.artifactId);if(old&&old.hash!==entry.ref.hash)fail("control-resume-artifact-conflict");if(files.has(entry.file))fail("control-resume-file-conflict");byId.set(entry.ref.artifactId,entry.ref);files.add(entry.file);}
 await assertDirectoryTree(root,files);
 const bytes=new Map<string,Buffer>(),fingerprints=new Map<string,string>([["resume-bundle.json",manifestRead.fingerprint]]);
 for(const entry of manifest.artifacts){const path=safeChild(root,entry.file),read=await readPrivateRegular(path);if(sha256(read.bytes)!==entry.ref.hash)fail("control-resume-artifact-hash-mismatch");bytes.set(entry.ref.artifactId,read.bytes);fingerprints.set(entry.file,read.fingerprint);}
 const checkpointBytes=bytes.get(manifest.checkpoint.artifactId);if(!checkpointBytes||sha256(checkpointBytes)!==input.checkpointHash)fail("control-resume-checkpoint-mismatch");
 let checkpoint:unknown;try{checkpoint=JSON.parse(checkpointBytes.toString("utf8"));}catch{fail("control-resume-checkpoint-invalid");}
 const checkpointRecord=checkpoint as Record<string,unknown>;if(checkpointRecord.checkpointId!==input.checkpointId||JSON.stringify(checkpointRecord.snapshot)!==JSON.stringify(manifest.snapshot))fail("control-resume-checkpoint-invalid");
 refuseRecoveryCheckpoint(checkpointRecord,manifest,bytes);
 const snapshotBytes=bytes.get(manifest.snapshot.artifactId);if(!snapshotBytes)fail("control-resume-artifact-missing");let snapshotRaw:unknown;
 try{snapshotRaw=JSON.parse(snapshotBytes.toString("utf8"));}catch{fail("control-resume-snapshot-invalid");}
 const snapshotParsed=snapshotSchema.safeParse(snapshotRaw);if(!snapshotParsed.success)fail("control-resume-snapshot-invalid");const snapshot=snapshotParsed.data;
 if(snapshot.missing.length)fail("control-resume-snapshot-partial");assertUniquePaths(snapshot);
 for(const ref of collectSnapshotRefs(snapshot)){const listed=byId.get(ref.artifactId);if(!listed)fail("control-resume-artifact-missing");if(listed.hash!==ref.hash)fail("control-resume-artifact-conflict");}
 return {manifest,snapshot,bytes,fingerprints};
}
async function assertUnchanged(input:InputCheckpointV1,loaded:LoadedBundle):Promise<void>{
 for(const [file,expected] of loaded.fingerprints){const path=safeChild(input.bundlePath,file);if(await fingerprint(path)!==expected)fail("control-resume-source-changed");const reread=await readPrivateRegular(path);if(reread.fingerprint!==expected)fail("control-resume-source-changed");if(file!=="resume-bundle.json"){const entry=loaded.manifest.artifacts.find(item=>item.file===file)!;if(sha256(reread.bytes)!==entry.ref.hash)fail("control-resume-source-changed");}}
}
async function writePrivate(path:string,bytes:Buffer):Promise<void>{await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,"wx",0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}const directory=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}}
async function gitInput(repo:string,args:string[],input:Buffer|string):Promise<Buffer>{
 return await new Promise<Buffer>((resolve,reject)=>{const child=spawn("git",["-C",repo,...args],{stdio:["pipe","pipe","pipe"]});let stderr="";const stdout:Buffer[]=[];child.stdout.on("data",chunk=>stdout.push(Buffer.from(chunk)));child.stderr.on("data",chunk=>stderr+=chunk);child.once("error",reject);child.once("close",code=>code===0?resolve(Buffer.concat(stdout)):reject(new Error(`git ${args[0]} failed: ${stderr}`)));child.stdin.end(input);});
}
async function clearWorktree(worktree:string):Promise<void>{for(const name of await readdir(worktree)){if(name!==".git")await rm(join(worktree,name),{recursive:true,force:true});}}
async function restoreTree(worktree:string,snapshot:SnapshotV1,bytes:Map<string,Buffer>):Promise<void>{
 await clearWorktree(worktree);
 const directories=snapshot.tree.filter(entry=>entry.kind==="directory").sort((a,b)=>a.path.split("/").length-b.path.split("/").length);
 for(const entry of directories)await mkdir(safeChild(worktree,entry.path),{recursive:false,mode:0o700});
 for(const entry of snapshot.tree.filter(entry=>entry.kind!=="directory")){
  const path=safeChild(worktree,entry.path);await mkdir(dirname(path),{recursive:true,mode:0o700});
  if(entry.kind==="file"){const content=bytes.get(entry.ref.artifactId);if(!content)fail("control-resume-artifact-missing");await writePrivate(path,content);await chmod(path,entry.mode);}
  else await symlink(entry.target,path);
 }
 for(const entry of [...directories].reverse())await chmod(safeChild(worktree,entry.path),entry.mode);
}
async function restoreIndex(worktree:string,snapshot:SnapshotV1,bytes:Map<string,Buffer>):Promise<void>{
 for(const entry of snapshot.index){if(!entry.ref)fail("control-resume-snapshot-partial");const content=bytes.get(entry.ref.artifactId);if(!content)fail("control-resume-artifact-missing");const stdout=await gitInput(worktree,["hash-object","-w","--stdin"],content);if(stdout.toString().trim()!==entry.oid)fail("control-resume-index-hash-mismatch");}
 await execFileAsync("git",["read-tree","--empty"],{cwd:worktree});
 const lines=snapshot.index.map(entry=>`${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\n`).join("");await gitInput(worktree,["update-index","--index-info"],lines);
}
async function verifyMaterialized(worktree:string,snapshot:SnapshotV1,bytes:Map<string,Buffer>):Promise<void>{
 const {stdout:head}=await execFileAsync("git",["rev-parse","HEAD"],{cwd:worktree});if(head.trim()!==snapshot.head)fail("control-resume-head-mismatch");
 const expected=Buffer.from(snapshot.index.map(entry=>`${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`).join(""));const {stdout:index}=await execFileAsync("git",["ls-files","--stage","-z"],{cwd:worktree,encoding:"buffer"});if(!Buffer.from(index).equals(expected))fail("control-resume-index-mismatch");
 const expectedPaths=new Set(snapshot.tree.map(entry=>entry.path));
 async function walk(dir:string):Promise<void>{for(const name of await readdir(dir)){if(dir===worktree&&name===".git")continue;const path=join(dir,name),rel=relative(worktree,path),stat=await lstat(path),entry=snapshot.tree.find(item=>item.path===rel);if(!entry)fail("control-resume-tree-mismatch");expectedPaths.delete(rel);if(entry.kind==="file"){if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==entry.mode||sha256(await readFile(path))!==entry.ref.hash)fail("control-resume-tree-mismatch");}else if(entry.kind==="symlink"){if(!stat.isSymbolicLink()||await readlink(path)!==entry.target)fail("control-resume-tree-mismatch");}else{if(!stat.isDirectory()||(stat.mode&0o777)!==entry.mode)fail("control-resume-tree-mismatch");await walk(path);}}}
 await walk(worktree);if(expectedPaths.size)fail("control-resume-tree-mismatch");
}

export async function materializeFirstWorkspace(repoPath:string,runDir:string,attempt:number,input:InputCheckpointV1,deps:MaterializeDependencies={}):Promise<{worktreePath:string}>{
 const canonicalRun=await realpath(runDir),canonicalBundle=await realpath(input.bundlePath),inputRoot=await realpath(join(dirname(canonicalRun),"input"));if(!within(inputRoot,canonicalBundle)||canonicalBundle===inputRoot)fail("control-resume-bundle-path-invalid");
 const loaded=await loadBundle(input);await deps.afterValidation?.();await assertUnchanged(input,loaded);
 const localBundle=join(canonicalRun,"continuation-repo.bundle");await writePrivate(localBundle,loaded.bytes.get(loaded.snapshot.bundle.artifactId)!);
 await execFileAsync("git",["fetch","-q",localBundle,"HEAD"],{cwd:repoPath});const {stdout:fetched}=await execFileAsync("git",["rev-parse","FETCH_HEAD"],{cwd:repoPath});if(fetched.trim()!==loaded.snapshot.head)fail("control-resume-head-mismatch");
 const {worktreePath}=await createAttemptWorkspace(repoPath,canonicalRun,attempt,loaded.snapshot.head);
 try{await restoreTree(worktreePath,loaded.snapshot,loaded.bytes);await restoreIndex(worktreePath,loaded.snapshot,loaded.bytes);await verifyMaterialized(worktreePath,loaded.snapshot,loaded.bytes);return {worktreePath};}
 catch(error){await execFileAsync("git",["worktree","remove","--force",worktreePath],{cwd:repoPath}).catch(()=>undefined);throw error;}
}

const CONTINUATION_CONSTRAINT="Treat continuation input fields unfinished, pendingDecisions, and awaitingHuman as required planning inputs.";
// Orca backlog #7 (2026-09-29; Orca handoff §9.0b): the constraint above told the model to treat these fields as inputs
// while no prompt ever showed them -- continuation-input.json was only a path in relevantDocs, which the prompts do
// not print. The fields themselves ride in one more constraint line, which both claude and codex print in their plan
// and execute prompts (src/runtime/claude/prompts.ts).
const CONTINUATION_INPUT_PREFIX="Continuation input from the predecessor run: ";
export async function prepareContinuationContract(contract:LoopContract,runDir:string,input:InputCheckpointV1):Promise<LoopContract>{
 await mkdir(runDir,{recursive:true,mode:0o700});const runStat=await lstat(runDir);if(!runStat.isDirectory()||runStat.isSymbolicLink())fail("control-resume-run-dir-invalid");
 const canonicalRun=await realpath(runDir),canonicalBundle=await realpath(input.bundlePath),inputRoot=await realpath(join(dirname(canonicalRun),"input"));if(!within(inputRoot,canonicalBundle)||canonicalBundle===inputRoot)fail("control-resume-bundle-path-invalid");
 const loaded=await loadBundle(input);await assertUnchanged(input,loaded);const path=join(canonicalRun,"continuation-input.json");
 const continuation={protocol:1,predecessorRunId:input.predecessorRunId,checkpointId:input.checkpointId,checkpointHash:input.checkpointHash,unfinished:loaded.manifest.unfinished,pendingDecisions:loaded.manifest.pendingDecisions,awaitingHuman:loaded.manifest.awaitingHuman};
 await writePrivate(path,Buffer.from(JSON.stringify(continuation)));const copy=structuredClone(contract);copy.context.relevantDocs=[...copy.context.relevantDocs,path];
 copy.context.constraints=[...copy.context.constraints,CONTINUATION_CONSTRAINT,`${CONTINUATION_INPUT_PREFIX}${JSON.stringify({unfinished:continuation.unfinished,pendingDecisions:continuation.pendingDecisions,awaitingHuman:continuation.awaitingHuman})}`];return copy;
}


const savedPlanSchema = z.object({ summary: z.string(), primaryTargetPaths: z.array(z.string()), tokenUsage: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).passthrough();
const savedExecutionSchema = z.object({ changedFiles: z.array(z.string()), diffPatch: z.string(), commandOutputs: z.array(z.string()), stdoutStderrLog: z.string(), tokenUsage: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), completionStatus: z.never().optional() }).passthrough();
const allowanceSchema = z.object({ nextPhase: z.enum(["plan", "execute", "verify"]), plan: artifactRefSchema.nullable(), execution: artifactRefSchema.nullable(), verification: artifactRefSchema.nullable(), state: artifactRefSchema, usage: artifactRefSchema }).strict();

const fingerprintSchema = z.object({ rejectCategory: z.string(), primaryTargetPaths: z.array(z.string()), failingCommand: z.string().nullable() }).strict();
const savedStateSchema = z.object({ currentAttempt: z.number().int().positive(), attemptsUsed: z.number().int().positive(),
  budgetSnapshot: z.object({ attemptsRemaining: z.number().int().positive(), timeRemainingMs: z.number().int().positive(), tokenBudgetRemaining: z.literal(0), tokenRemainingStatus: z.literal("known") }).passthrough(),
  recentFailures: z.array(fingerprintSchema), waitingCause: z.literal("token-allowance"), allowanceNextPhase: z.enum(["plan", "execute", "verify"]),
}).passthrough();
const savedVerificationSchema = z.object({ approved: z.literal(false), rejectCategory: z.string(), primaryTargetPaths: z.array(z.string()), failingCommand: z.string().nullable(), safeToRetry: z.literal(true), pauseSignals: z.array(z.string()), stopSignals: z.array(z.string()) }).passthrough();

function semanticContract(contract: LoopContract): unknown {
  const copy = structuredClone(contract);
  const { repoPath: _repo, ...context } = copy.context;
  const { tokenBudget: _tokens, maxAttempts: _attempts, totalRuntimeBudgetMs: _time, ...executionPolicy } = copy.executionPolicy;
  return { ...copy, context, executionPolicy };
}

/** The checkpoint's own handoff is the only root allowed to select already-paid phase artifacts. */
export async function readAllowanceContinuation(envelope: LoopStartEnvelope): Promise<RunControlHooks["allowanceContinuation"]> {
  if (envelope.protocol !== 4 || envelope.inputCheckpoint === null) return undefined;
  const input = envelope.inputCheckpoint;
  const loaded = await loadBundle(input);
  await assertUnchanged(input, loaded);
  const decode = (ref: ArtifactRefV1): unknown => {
    const bytes = loaded.bytes.get(ref.artifactId);
    if (!bytes || sha256(bytes) !== ref.hash) fail("control-allowance-evidence-missing");
    try { return JSON.parse(bytes.toString("utf8")); } catch { return fail("control-allowance-evidence-invalid"); }
  };
  const checkpoint = decode(loaded.manifest.checkpoint) as Record<string, unknown>;
  if (checkpoint.handoff === undefined) return undefined;
  const handoffRef = artifactRefSchema.safeParse(checkpoint.handoff);
  if (!handoffRef.success) fail("control-allowance-evidence-invalid");
  const packet = decode(handoffRef.data) as Record<string, unknown>;
  if (packet.allowanceContinuation === undefined) {
    if ((packet.runState as Record<string, unknown> | undefined)?.waitingCause === "token-allowance") fail("control-allowance-evidence-missing");
    return undefined;
  }
  const continuation = allowanceSchema.safeParse(packet.allowanceContinuation);
  if (!continuation.success) fail("control-allowance-evidence-invalid");
  const identity = packet.identity as Record<string, unknown> | undefined;
  if (!identity || identity.runId !== input.predecessorRunId || identity.groupId !== envelope.claim.groupId
    || identity.workItemId !== envelope.claim.workItemId || identity.taskId !== envelope.claim.taskId || identity.graphVersion !== envelope.claim.graphVersion
    || identity.targetVersion !== envelope.claim.targetVersion || packet.contractHash !== envelope.contractHash) fail("control-allowance-authority-mismatch");
  const state = packet.runState as Record<string, unknown> | undefined;
  if (state?.waitingCause !== "token-allowance" || state.allowanceNextPhase !== continuation.data.nextPhase) fail("control-allowance-evidence-invalid");
  const artifacts = z.array(artifactRefSchema).safeParse(packet.artifacts);
  if (!artifacts.success) fail("control-allowance-evidence-invalid");
  const reachable = (raw: unknown): ArtifactRefV1 => {
    const ref = artifactRefSchema.safeParse(raw);
    if (!ref.success || !artifacts.data.some(item => item.artifactId === ref.data.artifactId && item.hash === ref.data.hash)) fail("control-allowance-evidence-unreachable");
    return ref.data;
  };
  const source = loopContractSchema.safeParse(decode(reachable(packet.acceptedContract)));
  if (!source.success || canonicalHash(semanticContract(source.data)) !== canonicalHash(semanticContract(envelope.work.contract))) fail("control-allowance-authority-mismatch");
  const savedState = savedStateSchema.safeParse(decode(reachable(continuation.data.state)));
  const policy = tokenPolicySchema.safeParse(packet.tokenPolicy);
  if (!savedState.success || canonicalHash(savedState.data) !== canonicalHash(packet.runState) || !policy.success) fail("control-allowance-evidence-invalid");
  const localUsage = parseKnownWorkUsageLedger(decode(reachable(continuation.data.usage)), {
    runId: input.predecessorRunId, generation: identity.generation, usageHighWater: packet.usageHighWater,
  });
  if (localUsage.attempts !== savedState.data.attemptsUsed) fail("control-allowance-usage-invalid");
  const currentPolicy = tokenPolicySchema.safeParse(envelope.tokenPolicy);
  if (!currentPolicy.success) fail("control-allowance-lineage-invalid");
  for (const dimension of ["tokens", "activeMs", "attempts", "sessions"] as const) {
    const consumed = policy.data.inheritedUsage[dimension] + localUsage[dimension];
    if (!Number.isSafeInteger(consumed) || currentPolicy.data.inheritedUsage[dimension] < consumed) fail("control-allowance-lineage-invalid");
  }
  const recentFailures = savedState.data.recentFailures;
  if (continuation.data.nextPhase === "plan") {
    if (continuation.data.plan !== null || continuation.data.execution !== null) fail("control-allowance-phase-invalid");
    const verification = savedVerificationSchema.safeParse(decode(reachable(continuation.data.verification)));
    if (!verification.success || !recentFailures.length) fail("control-allowance-phase-invalid");
    const value = verification.data;
    const fingerprint = { rejectCategory: value.rejectCategory, primaryTargetPaths: value.primaryTargetPaths, failingCommand: value.failingCommand };
    if (canonicalHash(recentFailures.at(-1)) !== canonicalHash(fingerprint)) fail("control-allowance-phase-invalid");
    const decision = evaluateStopDecision({ humanCancelled: false, successSatisfied: false,
      humanGateHit: value.pauseSignals.some(signal => source.data.escalationAndExit.pauseOn.includes(signal)),
      attemptNumber: policy.data.inheritedUsage.attempts + savedState.data.currentAttempt,
      maxAttempts: policy.data.inheritedUsage.attempts + savedState.data.currentAttempt + savedState.data.budgetSnapshot.attemptsRemaining,
      budgetExceeded: false, recentFailures: recentFailures.slice(0, -1), verifier: value,
    });
    if (decision.kind !== "retryable" || value.stopSignals.some(signal => source.data.escalationAndExit.stopOn.includes(signal))) fail("control-allowance-phase-invalid");
    // Ruling B (spec 2026-10-20-verifier-sees-checks-and-last-failure-design.md §5.2(i)): the rejection's evidence, already
    // hash-checked above, so the renewed attempt's plan sees why the last one failed. Absent unless a string array.
    const evidence = (value as { evidence?: unknown }).evidence;
    const lastRejectionEvidence = Array.isArray(evidence) && evidence.every((entry) => typeof entry === "string") ? { lastRejectionEvidence: evidence as string[] } : {};
    return { nextPhase: "plan", plan: null, execution: null, recentFailures, ...lastRejectionEvidence };
  }
  if (continuation.data.verification !== null) fail("control-allowance-phase-invalid");
  const plan = savedPlanSchema.safeParse(decode(reachable(continuation.data.plan)));
  if (!plan.success) fail("control-allowance-phase-invalid");
  if (continuation.data.nextPhase === "execute") {
    if (continuation.data.execution !== null) fail("control-allowance-phase-invalid");
    return { nextPhase: "execute", plan: plan.data, execution: null, recentFailures };
  }
  const execution = savedExecutionSchema.safeParse(decode(reachable(continuation.data.execution)));
  if (!execution.success) fail("control-allowance-phase-invalid");
  return { nextPhase: "verify", plan: plan.data, execution: execution.data, recentFailures };
}
