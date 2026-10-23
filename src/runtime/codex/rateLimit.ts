/**
 * Spec docs/superpowers/specs/2026-10-13-codex-rate-limit-backoff-design.md §3.1: a Codex phase that failed on HTTP 429.
 * Only the wording of the tester's real samples is recognised ("last status: 429"); no 5xx or other wording is.
 * "before-work": a turn started, no item ran and every line parsed, so the worktree was not touched and the call booked
 * nothing (human ruling 2026-10-13). "after-work": any other 429. null: no 429, or a completed turn reported usage.
 */
import { foldText, type JsonLine } from "../streamLines.js";

export type RateLimitClass = "before-work" | "after-work";

const LIMITED = /\blast status: 429\b/;

export function classifyRateLimit(events: string): RateLimitClass | null {
  return foldText(events, new RateLimitFold()).value();
}

/** Live transcript (Orca spec 2026-10-23 §10.2.3): classifyRateLimit as a fold; a line too large to keep counts as unparsed. */
export class RateLimitFold {
  private limited = false; private started = false; private item = false; private completed = false; private unparsed = false;
  push(line: JsonLine): void {
    if (line.kind === "blank") return;
    if (line.kind !== "row") { this.unparsed = true; return; }
    const row = line.row;
    if (row === null || typeof row !== "object" || Array.isArray(row)) { this.unparsed = true; return; }
    const r = row as { type?: unknown; message?: unknown; error?: { message?: unknown } | null };
    if (typeof r.type !== "string") { this.unparsed = true; return; }
    if (r.type === "turn.started") this.started = true;
    if (r.type.startsWith("item.")) this.item = true;
    if (r.type === "turn.completed") this.completed = true;
    const message = r.type === "error" ? r.message : r.type === "turn.failed" ? r.error?.message : undefined;
    if (typeof message === "string" && LIMITED.test(message)) this.limited = true;
  }
  value(): RateLimitClass | null {
    if (!this.limited || this.completed) return null;
    return this.started && !this.item && !this.unparsed ? "before-work" : "after-work";
  }
}
