import { z } from "zod";

const text = z.string().max(4000);
const texts = z.array(text).max(32);
const reportSchema = z.object({
  schema: z.literal("task-result-v1"),
  goal: text.refine(value => value.trim().length > 0),
  completedWork: texts,
  conclusions: texts,
  outputs: z.array(z.object({ path: z.string().max(1024), label: z.string().max(256) }).strict()).max(32),
  limitations: texts,
}).strict();
export type TaskResultV1 = z.infer<typeof reportSchema>;
export type NormalizedTaskResult = {
  status: "missing" | "invalid" | "available";
  report: TaskResultV1 | null;
  reason: string | null;
  diagnostic: string | null;
};
const diagnosticSchema = z.object({
  schema: z.literal("ccloop-task-result-invalid-v1"),
  reason: z.string().min(1).max(256),
  diagnostic: z.string().max(4096),
}).strict();
const MAX_BYTES = 65536, MAX_DEPTH = 32;
const invalid = (reason: string, diagnostic: string) => ({ schema: "ccloop-task-result-invalid-v1", reason, diagnostic: diagnostic.slice(0, 4096) });

/**
 * Optional metadata alone is bounded before any core serialization. Walk iteratively, without getters/toJSON,
 * retaining at most 65536 UTF-8 JSON bytes and 32 container levels; invalid diagnostics retain at most 4096 characters.
 * Return bounded arbitrary JSON unchanged in meaning, or the diagnostic marker (never throw through execution).
 */
export function boundedTaskResult(value: unknown): unknown {
  if (value === undefined) return undefined;
  const pieces: string[] = [];
  let bytes = 0;
  type Work = { value: unknown; depth: number; ancestors: object[] } | { token: string };
  const stack: Work[] = [{ value, depth: 0, ancestors: [] }];
  const add = (token: string) => {
    const size = Buffer.byteLength(token, "utf8");
    if (bytes + size > MAX_BYTES) throw new Error("task-result-too-large");
    bytes += size; pieces.push(token);
  };
  try {
    while (stack.length) {
      const work = stack.pop()!;
      if ("token" in work) { add(work.token); continue; }
      const item = work.value;
      if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) { add(JSON.stringify(item)); continue; }
      if (typeof item === "string") {
        if (Buffer.byteLength(item, "utf8") > MAX_BYTES) throw new Error("task-result-too-large");
        add(JSON.stringify(item)); continue;
      }
      if (typeof item !== "object" || work.ancestors.includes(item)) throw new Error("task-result-not-json");
      if (work.depth >= MAX_DEPTH) throw new Error("task-result-too-deep");
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("task-result-not-json");
      if (array && item.length > MAX_BYTES) throw new Error("task-result-too-large");
      const keys = array ? Array.from({ length: item.length }, (_, i) => String(i)) : Object.keys(item);
      // Every entry needs at least one byte; refuse wide containers before allocating a work item for every child.
      if (keys.length > MAX_BYTES) throw new Error("task-result-too-large");
      const ancestors = [...work.ancestors, item];
      add(array ? "[" : "{");
      stack.push({ token: array ? "]" : "}" });
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i], descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("task-result-not-json");
        stack.push({ value: descriptor.value, depth: work.depth + 1, ancestors });
        if (!array) stack.push({ token: JSON.stringify(key) + ":" });
        if (i > 0) stack.push({ token: "," });
      }
    }
    return JSON.parse(pieces.join(""));
  } catch (error) {
    const reason = error instanceof Error && ["task-result-too-large", "task-result-too-deep", "task-result-not-json"].includes(error.message) ? error.message : "task-result-not-json";
    // A failed large scalar has no complete JSON prefix; retain a bounded raw scalar preview instead.
    return invalid(reason, pieces.join("") || (typeof value === "string" ? value.slice(0, 4096) : ""));
  }
}

/** Logical report availability is independent of the controller-owned execution and verification outcomes. */
export function normalizeTaskResult(value: unknown): NormalizedTaskResult {
  if (value === undefined) return { status: "missing", report: null, reason: null, diagnostic: null };
  const bounded = boundedTaskResult(value);
  const diagnostic = diagnosticSchema.safeParse(bounded);
  if (diagnostic.success) return { status: "invalid", report: null, reason: diagnostic.data.reason, diagnostic: diagnostic.data.diagnostic };
  const parsed = reportSchema.safeParse(bounded);
  return parsed.success
    ? { status: "available", report: parsed.data, reason: null, diagnostic: null }
    : { status: "invalid", report: null, reason: "task-result-schema-invalid", diagnostic: JSON.stringify(bounded).slice(0, 4096) };
}
