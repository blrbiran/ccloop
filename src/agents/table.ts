import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { idSchema } from "../control/protocol.js";
import { getDescriptor } from "./registry.js";
import { AgentError, type AgentsTableV1, type InstallationV1 } from "./types.js";

const MAX_TABLE_BYTES = 1024 * 1024;
const commonInstallation = {
  kind: z.string().min(1),
  command: z.tuple([z.string().min(1).refine(isAbsolute)]).rest(z.string()),
  version: z.string().min(1),
  configDir: z.string().min(1).refine(isAbsolute).nullable(),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  killGraceMs: z.number().int().nonnegative().max(60_000),
};
const tableShape = z
  .object({ schema: z.literal("ccloop-agents-table-v1"), installations: z.record(z.unknown()) })
  .strict();
const kindShape = z.object({ kind: z.string() }).passthrough();

function invalid(detail: string): AgentError {
  return new AgentError("agents-table-invalid", detail);
}

/** One installation record, checked against the common fields plus its kind's strict extras. */
export function parseInstallation(raw: unknown): InstallationV1 {
  const kind = kindShape.safeParse(raw);
  if (!kind.success) throw invalid("installation has no kind");
  let extras: z.ZodRawShape;
  try {
    extras = getDescriptor(kind.data.kind).installationExtras;
  } catch {
    throw invalid(`unknown agent kind ${JSON.stringify(kind.data.kind)}`);
  }
  const parsed = z.object({ ...commonInstallation, ...extras }).strict().safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.message);
  return parsed.data as InstallationV1;
}

export function parseAgentsTable(raw: unknown): AgentsTableV1 {
  const table = tableShape.safeParse(raw);
  if (!table.success) throw invalid(table.error.message);
  const installations: Record<string, InstallationV1> = {};
  for (const [id, entry] of Object.entries(table.data.installations)) {
    if (!idSchema.safeParse(id).success) throw invalid(`installation id ${JSON.stringify(id)}`);
    try {
      installations[id] = parseInstallation(entry);
    } catch (error) {
      throw invalid(`${id}: ${error instanceof AgentError ? error.detail ?? error.code : String(error)}`);
    }
  }
  return { schema: "ccloop-agents-table-v1", installations };
}

function assertPrivate(metadata: { uid: number; mode: number }, euid: number, what: string): void {
  if (metadata.uid !== euid) throw invalid(`${what} is not owned by the effective user`);
  if ((metadata.mode & 0o022) !== 0) throw invalid(`${what} is group- or world-writable`);
}

/**
 * Spec §4.2 / §12 I14: the table is read only through a no-follow handle, must be a regular file whose path
 * is its own realpath, and it and its directory must belong to the effective user and be writable by no one
 * else. `deps.euid` exists so a criterion can observe the owner check without root.
 */
export async function readAgentsTable(path: string, deps: { euid?: number } = {}): Promise<AgentsTableV1> {
  if (!isAbsolute(path)) throw invalid("table path is not absolute");
  const euid = deps.euid ?? process.geteuid!();
  let handle;
  let text: string;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalid("table is not a regular file");
    assertPrivate(metadata, euid, "table");
    if (metadata.size > MAX_TABLE_BYTES) throw invalid("table is larger than 1 MiB");
    if ((await realpath(path)) !== path) throw invalid("table path is not its own realpath");
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory()) throw invalid("table directory is not a directory");
    assertPrivate(parent, euid, "table directory");
    text = (await handle.readFile()).toString("utf8");
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw invalid(error instanceof Error ? error.message : String(error));
  } finally {
    await handle?.close();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw invalid("table is not JSON");
  }
  return parseAgentsTable(raw);
}

/** Spec §12 I4: methods other than capabilities/accept check only the path's shape, never the content. */
export async function assertAgentsTablePath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw invalid("table path is not absolute");
  try {
    const canonical = await realpath(path);
    const metadata = await lstat(path);
    if (canonical !== path || !metadata.isFile()) throw invalid("table path is not a canonical regular file");
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}
