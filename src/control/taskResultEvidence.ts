import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactRefSchema, ControlProtocolError, type ArtifactRefV1 } from "./protocol.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "./paths.js";

export const MAX_TASK_RESULT_FILES = 64;
export const MAX_TASK_RESULT_FILE_BYTES = 1048576;
export const MAX_TASK_RESULT_PREVIEW_BYTES = 131072;
export const MAX_TASK_RESULT_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const taskResultDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function safeTaskResultPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\\0:]/.test(path) && !isAbsolute(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
export class TaskResultFileError extends Error {
  constructor(readonly status: "symlink" | "unsafe" | "unavailable" | "too-large" | "changed" | "missing") { super(status); }
}
/** No discovery, no symlink targets, no blocking special files, and a bounded read even if the file grows. */
export async function readTaskResultFile(root: string, target: string, limit: number): Promise<Buffer> {
  const suffix = relative(root, resolve(target));
  if (!isAbsolute(root) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new TaskResultFileError("unsafe");
  let handle;
  try {
    if (await realpath(root) !== root) throw new TaskResultFileError("symlink");
    const ancestors: Array<{path:string;dev:number;ino:number}> = [];
    let current=root;
    for (const part of suffix.split(sep).filter(Boolean)) {
      const parent=await lstat(current);
      if(parent.isSymbolicLink()) throw new TaskResultFileError("symlink");
      if(!parent.isDirectory()) throw new TaskResultFileError("unavailable");
      ancestors.push({path:current,dev:parent.dev,ino:parent.ino});current=join(current,part);
    }
    const leaf=await lstat(target);
    if(leaf.isSymbolicLink())throw new TaskResultFileError("symlink");
    if(!leaf.isFile())throw new TaskResultFileError("unavailable");
    if(leaf.size>limit)throw new TaskResultFileError("too-large");
    handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await handle.stat();
    if(!before.isFile() || before.dev!==leaf.dev || before.ino!==leaf.ino)throw new TaskResultFileError("changed");
    if(before.size>limit)throw new TaskResultFileError("too-large");
    const buffer=Buffer.alloc(before.size+1);let size=0;
    while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,null);if(read.bytesRead===0)break;size+=read.bytesRead;}
    const after=await handle.stat(),now=await lstat(target);
    if(size!==before.size || before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || now.dev!==before.dev || now.ino!==before.ino || now.isSymbolicLink()) throw new TaskResultFileError("changed");
    for(const ancestor of ancestors){const metadata=await lstat(ancestor.path);if(!metadata.isDirectory()||metadata.isSymbolicLink()||metadata.dev!==ancestor.dev||metadata.ino!==ancestor.ino)throw new TaskResultFileError("changed");}
    return buffer.subarray(0,size);
  }catch(error){
    if(error instanceof TaskResultFileError)throw error;
    throw new TaskResultFileError((error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"unavailable");
  }finally{await handle?.close();}
}
export function taskResultEvidencePath(sourceDir:string,ref:ArtifactRefV1):string {
  const parsed=artifactRefSchema.safeParse(ref);
  if(!parsed.success || ref.artifactId!==`task-result-${ref.hash}`)throw new ControlProtocolError("control-task-result-ref-invalid");
  return join(sourceDir,"control","task-result-evidence",`${ref.artifactId}.bin`);
}
export async function writeTaskResultEvidence(sourceDir:string,bytes:Buffer,assertHeld:()=>Promise<void>):Promise<ArtifactRefV1> {
  if(bytes.length>MAX_TASK_RESULT_EVIDENCE_BYTES)throw new Error("task-result-evidence-too-large");
  const hash=taskResultDigest(bytes),ref={artifactId:`task-result-${hash}`,hash};
  try {
    await readCapturedTaskResultEvidence(sourceDir,ref);
    return ref;
  } catch (error) {
    if (!(error instanceof TaskResultFileError && error.status === "missing")) throw error;
  }
  await assertHeld();await ensurePrivateDirectory(sourceDir,join(sourceDir,"control","task-result-evidence"));
  await assertHeld();await atomicReplacePrivateFile(sourceDir,taskResultEvidencePath(sourceDir,ref),bytes);
  return ref;
}
export async function readCapturedTaskResultEvidence(sourceDir:string,ref:ArtifactRefV1):Promise<Buffer> {
  const bytes=await readTaskResultFile(sourceDir,taskResultEvidencePath(sourceDir,ref),MAX_TASK_RESULT_EVIDENCE_BYTES);
  if(taskResultDigest(bytes)!==ref.hash)throw new ControlProtocolError("control-task-result-hash-mismatch");
  return bytes;
}
