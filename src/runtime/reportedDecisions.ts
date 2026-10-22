/**
 * Reported decisions and debug (spec 2026-10-20-reported-decisions-and-debug-design.md §4.1): the execute answer may carry
 * `decisions` and `debug`, which ccloop carries opaquely, like taskResult -- their contents never fail a run. This is the one
 * "unreported" step every kind applies to its execute answer: a null `decisions` or `debug` is removed; inside an object
 * `debug` its null members are removed, and a `debug` left empty is removed (spec 2026-10-22-debug-located-design.md §4.3:
 * first, inside each plain-object member of `debug`, its null members are removed and a member left empty is removed --
 * codex's strict schema can say "no id" in `debug.located` only as null); a value over 65536 bytes of UTF-8 JSON is
 * removed. Keys are deleted, never set to undefined, so an answer that reports nothing keeps today's bytes (saved-result
 * recovery pins that hash). `decisions: []` is kept.
 */
export const REPORTED_FIELDS = ["decisions", "debug"] as const;
const MAX_REPORTED_BYTES = 65536;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function withinBound(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_REPORTED_BYTES; } catch { return false; }
}

export function dropUnreported<T extends object>(execution: T): T {
  const fields = execution as Record<string, unknown>;
  if (record(fields.debug)) {
    for (const [key, member] of Object.entries(fields.debug)) {
      if (!record(member)) continue;
      for (const [inner, value] of Object.entries(member)) if (value === null) delete member[inner];
      if (Object.keys(member).length === 0) delete fields.debug[key];
    }
    for (const [key, member] of Object.entries(fields.debug)) if (member === null) delete fields.debug[key];
    if (Object.keys(fields.debug).length === 0) delete fields.debug;
  }
  for (const key of REPORTED_FIELDS) {
    if (!Object.hasOwn(fields, key)) continue;
    if (fields[key] === null || !withinBound(fields[key])) delete fields[key];
  }
  return execution;
}
