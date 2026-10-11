import { join } from "node:path";
import { z } from "zod";
import { artifactRefSchema, canonicalHash, ControlProtocolError, type ArtifactRefV1, type StartEnvelopeV3 } from "./protocol.js";
import { readAccepted } from "./store.js";
import { publishTaskResultIndex, readTaskResultFile, taskResultDigest, TaskResultFileError } from "./taskResultEvidence.js";
import { taskResultIdentitySchema } from "./taskResults.js";

const safe=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive=safe.refine(n=>n>0);
const hash=z.string().regex(/^[a-f0-9]{64}$/), oid=z.string().regex(/^[a-f0-9]{40,64}$/);
const ref=artifactRefSchema;
// Leave room for base64 expansion plus the strict control-response envelope.
const MAX_SAVED_BYTES=12*1024*1024-1024;
export const executionSnapshotSchema=z.object({
  schema:z.literal("ccloop-execution-snapshot-v1"),head:oid,indexTree:oid,indexCommit:oid,bundleRefName:z.string().startsWith("refs/ccloop/"),
  index:ref,bundle:ref,status:ref,rootMode:safe.max(0o777),
  files:z.array(z.object({path:z.string().min(1),kind:z.literal("file"),mode:safe,ref}).strict()).max(10000),
  directories:z.array(z.object({path:z.string().min(1),mode:safe}).strict()).max(10000),
  deleted:z.array(z.string()),
}).strict();
export const executionFormatFailureSchema=z.object({
  schema:z.literal("ccloop-execution-format-failure-v1"),identity:taskResultIdentitySchema,attempt:positive,
  executor:z.object({kind:z.literal("codex"),configHash:hash}).strict(), frozenContractHash:hash,
  acceptedBase:z.string().min(1),resolvedBase:oid,attemptStartHead:oid,decoder:z.literal("strict-execution-v1"),classification:z.literal("execution-format-failure-v1"),
  process:z.object({reason:z.literal("completed"),code:z.literal(0),signal:z.null(),isolated:z.literal(true)}).strict(),
  usage:z.object({tokenUsage:positive,highWater:positive}).strict(),
  verifier:z.object({entered:z.literal(false),proof:ref}).strict(),
  artifacts:z.object({envelope:ref,config:ref,acceptedContract:ref,runtimeContract:ref,final:ref,events:ref,schema:ref,decodeError:ref,normalization:ref,outcome:ref,process:ref,plan:ref,usage:ref,usageLedger:ref,usageObservations:z.array(z.object({source:ref,copy:ref}).strict()),owner:ref}).strict(),
  snapshot:ref,completeness:z.object({complete:z.literal(true),parts:z.tuple([z.literal("original-process"),z.literal("original-stream"),z.literal("actual-usage"),z.literal("successful-plan"),z.literal("verifier-not-entered"),z.literal("tree-index-bundle-files")])}).strict(),
  capturedAt:z.string().datetime({offset:true}),captureOwner:z.string().min(1),
}).strict();
export type ExecutionFormatFailureCapsule=z.infer<typeof executionFormatFailureSchema>;
export const savedResultCollectionSchema=z.object({
  schema:z.literal("ccloop-saved-result-evidence-v1"),identity:taskResultIdentitySchema,attempt:safe,capsule:ref.nullable(),reason:z.string().nullable(),
}).strict();
export const savedResultIndexPath=(source:string)=>join(source,"run","saved-result","index.json");
export function savedResultPath(source:string,ref:ArtifactRefV1):string {
  if(!artifactRefSchema.safeParse(ref).success || ref.artifactId!==`saved-result-${ref.hash}`)throw new ControlProtocolError("control-saved-result-ref-invalid");
  return join(source,"control","saved-result-evidence",`${ref.artifactId}.bin`);
}
export async function readSavedBytes(source:string,ref:ArtifactRefV1):Promise<Buffer>{
  const bytes=await readTaskResultFile(source,savedResultPath(source,ref),MAX_SAVED_BYTES);
  if(taskResultDigest(bytes)!==ref.hash)throw new ControlProtocolError("control-saved-result-hash-mismatch");
  return bytes;
}
export async function writeSavedBytes(source:string,bytes:Buffer,assertHeld:()=>Promise<void>):Promise<ArtifactRefV1>{
  if(bytes.length>MAX_SAVED_BYTES)throw new Error("saved-result-evidence-too-large");
  const hash=taskResultDigest(bytes),ref={artifactId:`saved-result-${hash}`,hash};
  try {await readSavedBytes(source,ref);return ref;}catch(error){if(!(error instanceof TaskResultFileError && error.status==="missing"))throw error;}
  await publishTaskResultIndex(source,savedResultPath(source,ref),bytes,assertHeld);
  return ref;
}
export async function savedResultIdentity(input:StartEnvelopeV3){
  const accepted=await readAccepted(input.work.sourceDir);
  if(accepted.envelopeHash!==canonicalHash(input)||accepted.configHash!==input.claim.configHash||accepted.generation!==input.claim.generation)throw new ControlProtocolError("control-envelope-conflict");
  const {groupId,workItemId,taskId,runId,generation,graphVersion,targetVersion}=input.claim;
  return taskResultIdentitySchema.parse({groupId,workItemId,taskId,runId,generation,graphVersion,targetVersion,executionId:accepted.executionId,envelopeHash:accepted.envelopeHash});
}
const same=(a:ArtifactRefV1,b:ArtifactRefV1)=>a.artifactId===b.artifactId&&a.hash===b.hash;
export async function collectSavedResultEvidence(input:StartEnvelopeV3){
  const identity=await savedResultIdentity(input),source=input.work.sourceDir;
  let page:z.infer<typeof savedResultCollectionSchema>;
  try {page=savedResultCollectionSchema.parse(JSON.parse((await readTaskResultFile(source,savedResultIndexPath(source),16*1024*1024)).toString()));}
  catch(error){
    if(!(error instanceof TaskResultFileError&&error.status==="missing"))throw error;
    let reason="saved-result-original-evidence-unavailable";
    try {
      const config=JSON.parse((await readTaskResultFile(source,join(source,"control","config.json"),16*1024*1024)).toString());
      if(config.kind!=="codex")reason="saved-result-provider-original-evidence-unsupported";
    } catch(error) {if(!(error instanceof TaskResultFileError&&error.status==="missing"))throw error;}
    return {schema:"ccloop-saved-result-evidence-v1" as const,identity,attempt:0,capsule:null,reason};
  }
  if(canonicalHash(page.identity)!==canonicalHash(identity))throw new ControlProtocolError("control-saved-result-authority-invalid");
  if(page.capsule)await loadClosure(input,page.capsule,page.attempt);
  return page;
}
async function loadClosure(input:StartEnvelopeV3,capsuleRef:ArtifactRefV1,attempt:number){
  const source=input.work.sourceDir,identity=await savedResultIdentity(input);
  const c=executionFormatFailureSchema.parse(JSON.parse((await readSavedBytes(source,capsuleRef)).toString()));
  if(canonicalHash(c.identity)!==canonicalHash(identity)||c.attempt!==attempt||c.frozenContractHash!==input.contractHash||c.executor.configHash!==input.claim.configHash)throw new ControlProtocolError("control-saved-result-authority-invalid");
  const snapshot=executionSnapshotSchema.parse(JSON.parse((await readSavedBytes(source,c.snapshot)).toString()));
  const {usageObservations,...artifacts}=c.artifacts;
  const refs=[capsuleRef,c.snapshot,c.verifier.proof,...Object.values(artifacts),...usageObservations.map(alias=>alias.copy),snapshot.index,snapshot.bundle,snapshot.status,...snapshot.files.map(f=>f.ref)];
  for(const ref of refs)await readSavedBytes(source,ref);
  const ledger=JSON.parse((await readSavedBytes(source,c.artifacts.usageLedger)).toString());
  if(!Array.isArray(ledger.events)||ledger.events.length!==usageObservations.length
    ||usageObservations.some((alias,i)=>!same(alias.source,ledger.events[i].source)
      ||alias.source.artifactId!==`evidence-${alias.source.hash}`||alias.source.hash!==alias.copy.hash))throw new ControlProtocolError("control-saved-result-authority-invalid");
  return {refs,aliases:usageObservations};
}
export async function readSavedResultEvidence(input:StartEnvelopeV3,capsuleRef:ArtifactRefV1,ref:ArtifactRefV1):Promise<Buffer>{
  const page=await collectSavedResultEvidence(input);
  if(!page.capsule||!same(page.capsule,capsuleRef))throw new ControlProtocolError("control-saved-result-authority-invalid");
  const {refs,aliases}=await loadClosure(input,capsuleRef,page.attempt);
  // Exact declared ID/hash pairs only; raw historical ledger bytes and IDs stay unchanged.
  // Aliases resolve to private immutable copies, never to mutable core evidence paths.
  const alias=aliases.find(alias=>same(alias.source,ref));
  if(alias)return readSavedBytes(input.work.sourceDir,alias.copy);
  if(!refs.some(r=>same(r,ref)))throw new ControlProtocolError("control-saved-result-authority-invalid");
  return readSavedBytes(input.work.sourceDir,ref);
}
