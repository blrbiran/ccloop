import { z } from "zod";
import { artifactRefSchema } from "./protocol.js";

/**
 * Change-sized runs (Orca spec 2026-11-19-change-sized-runs-design.md §7.1; Orca #363 #366): Orca's archive snapshot v2, read
 * by ccloop's continuation (materialize.ts) and by `legacy-published-candidate-v2` saved-result recovery. The attempt is a
 * commit kept by Orca's pin `ref` in the target repository; `bundle` is `git bundle create <base>..<ref>` (null iff
 * attempt === base), so it is readable only in a repository that holds `base`.
 */
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const snapshotV2Schema = z.object({
  version: z.literal(2),
  objectFormat: z.enum(["sha1", "sha256"]),
  base: oid,
  attempt: oid,
  tree: oid,
  head: oid,
  ref: z.string().regex(/^refs\/orca\/runs\/run-[A-Za-z0-9-]+$/),
  source: z.enum(["ccloop-published", "ccloop-live", "orca-commit", "base"]),
  bundle: artifactRefSchema.nullable(),
  missing: z.array(z.string()),
}).strict()
  .refine((snapshot) => (snapshot.bundle === null) === (snapshot.attempt === snapshot.base))
  .refine((snapshot) => [snapshot.base, snapshot.attempt, snapshot.tree, snapshot.head].every((value) => value.length === (snapshot.objectFormat === "sha256" ? 64 : 40)));
export type SnapshotV2 = z.infer<typeof snapshotV2Schema>;
