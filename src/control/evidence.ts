import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { artifactRefSchema, ControlProtocolError, type ArtifactRefV1 } from "./protocol.js";
import { atomicReplacePrivateFile, ensurePrivateDirectory } from "./paths.js";

export const MAX_CONTROL_BYTES = 16 * 1024 * 1024;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertRef(ref: ArtifactRefV1): ArtifactRefV1 {
  const parsed = artifactRefSchema.safeParse(ref);
  if (!parsed.success || !parsed.data.artifactId.startsWith("evidence-")) {
    throw new ControlProtocolError("control-evidence-ref-invalid");
  }
  return parsed.data;
}

export function evidencePath(sourceDir: string, ref: ArtifactRefV1): string {
  const checked = assertRef(ref);
  return join(sourceDir, "control", "evidence", `${checked.artifactId}.bin`);
}

export async function writeEvidence(sourceDir: string, bytes: Buffer): Promise<ArtifactRefV1> {
  if (bytes.byteLength > MAX_CONTROL_BYTES) {
    throw new ControlProtocolError("control-evidence-too-large");
  }
  const hash = digest(bytes);
  const ref = { artifactId: `evidence-${hash}`, hash };
  const directory = join(sourceDir, "control", "evidence");
  await ensurePrivateDirectory(sourceDir, directory);
  await atomicReplacePrivateFile(sourceDir, evidencePath(sourceDir, ref), bytes);
  return ref;
}

export async function readEvidence(sourceDir: string, ref: ArtifactRefV1): Promise<Buffer> {
  const target = evidencePath(sourceDir, ref);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new ControlProtocolError("control-evidence-invalid");
    if (metadata.size > MAX_CONTROL_BYTES) {
      throw new ControlProtocolError("control-evidence-too-large");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_CONTROL_BYTES) {
      throw new ControlProtocolError("control-evidence-too-large");
    }
    if (digest(bytes) !== ref.hash) {
      throw new ControlProtocolError("control-evidence-hash-mismatch");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ControlProtocolError) throw error;
    throw new ControlProtocolError("control-evidence-invalid");
  } finally {
    await handle?.close();
  }
}
