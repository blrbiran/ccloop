import { join } from "node:path";
import { z } from "zod";
import type { LiveNote, LiveNoteInbox } from "../runtime/types.js";
import { atomicReplacePrivateFile, readPrivateFile } from "./paths.js";
import { canonicalJson, idSchema } from "./protocol.js";

// Live notes (Orca spec 2026-11-12 tester follow-up G Part 5): Orca writes the task's queued notes into
// <sourceDir>/live-notes.json; at every phase start ccloop takes the ones it has not delivered yet, puts them into that
// phase's prompt and acknowledges them in <sourceDir>/run/live-notes-delivered.json. Nothing reaches a running call.

export const LIVE_NOTES_FILE = "live-notes.json";
export const LIVE_NOTES_DELIVERED_FILE = "live-notes-delivered.json";

const utf8Bounded = (max: number) => z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= max);
const phaseSchema = z.enum(["plan", "execute", "verify"]);
export const liveNotesFileSchema = z.object({
  schema: z.literal("orca-live-notes-v1"),
  notes: z.array(z.object({ id: idSchema, text: utf8Bounded(2048), at: z.string().datetime({ offset: true }) }).strict()).max(16),
}).strict();
export const liveNoteDeliveriesSchema = z.object({
  schema: z.literal("ccloop-live-notes-delivered-v1"),
  delivered: z.array(z.object({ id: idSchema, phase: phaseSchema, attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    at: z.string().datetime({ offset: true }) }).strict()).max(256),
}).strict();
export type LiveNoteDeliveryV1 = z.infer<typeof liveNoteDeliveriesSchema>["delivered"][number];

function deliveredPath(sourceDir: string): string {
  return join(sourceDir, "run", LIVE_NOTES_DELIVERED_FILE);
}

async function readJsonFile(sourceDir: string, path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse((await readPrivateFile(sourceDir, path)).toString("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The acknowledgements ccloop wrote; null when there is no file. */
export async function readLiveNoteDeliveries(sourceDir: string): Promise<LiveNoteDeliveryV1[] | null> {
  const raw = await readJsonFile(sourceDir, deliveredPath(sourceDir));
  return raw === undefined ? null : liveNoteDeliveriesSchema.parse(raw).delivered;
}

/**
 * Takes the notes of the file not acknowledged yet, in file order, once. A missing, unreadable (a symlink included) or
 * malformed notes file is no notes; so is an acknowledgement file ccloop cannot read or extend, so a note is never
 * delivered twice.
 */
export function liveNoteInbox(sourceDir: string, now: () => Date = () => new Date()): LiveNoteInbox {
  return {
    async take(phase, attempt): Promise<LiveNote[]> {
      let notes: LiveNote[];
      try {
        const parsed = liveNotesFileSchema.safeParse(await readJsonFile(sourceDir, join(sourceDir, LIVE_NOTES_FILE)));
        if (!parsed.success) return [];
        notes = parsed.data.notes;
      } catch {
        return [];
      }
      try {
        const raw = await readJsonFile(sourceDir, deliveredPath(sourceDir));
        const delivered = raw === undefined ? [] : liveNoteDeliveriesSchema.parse(raw).delivered;
        const acked = new Set(delivered.map((entry) => entry.id));
        const pending = notes.filter((note) => !acked.has(note.id));
        if (pending.length === 0) return [];
        const at = now().toISOString();
        const next = liveNoteDeliveriesSchema.parse({ schema: "ccloop-live-notes-delivered-v1",
          delivered: [...delivered, ...pending.map((note) => ({ id: note.id, phase, attempt, at }))] });
        await atomicReplacePrivateFile(sourceDir, deliveredPath(sourceDir), Buffer.from(`${canonicalJson(next)}\n`));
        return pending;
      } catch {
        return [];
      }
    },
  };
}
