/**
 * Spec docs/superpowers/specs/2026-10-13-codex-rate-limit-backoff-design.md §3.1: a Codex phase that failed on HTTP 429.
 * Only the wording of the tester's real samples is recognised ("last status: 429"); no 5xx or other wording is.
 * "before-work": a turn started, no item ran and every line parsed, so the worktree was not touched and the call booked
 * nothing (human ruling 2026-10-13). "after-work": any other 429. null: no 429, or a completed turn reported usage.
 */
export type RateLimitClass = "before-work" | "after-work";

const LIMITED = /\blast status: 429\b/;

export function classifyRateLimit(events: string): RateLimitClass | null {
  let limited = false, started = false, item = false, completed = false, unparsed = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { unparsed = true; continue; }
    if (row === null || typeof row !== "object" || Array.isArray(row)) { unparsed = true; continue; }
    const r = row as { type?: unknown; message?: unknown; error?: { message?: unknown } | null };
    if (typeof r.type !== "string") { unparsed = true; continue; }
    if (r.type === "turn.started") started = true;
    if (r.type.startsWith("item.")) item = true;
    if (r.type === "turn.completed") completed = true;
    const message = r.type === "error" ? r.message : r.type === "turn.failed" ? r.error?.message : undefined;
    if (typeof message === "string" && LIMITED.test(message)) limited = true;
  }
  if (!limited || completed) return null;
  return started && !item && !unparsed ? "before-work" : "after-work";
}
