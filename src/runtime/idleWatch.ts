/**
 * Activity watchdog (ccloop spec docs/superpowers/specs/2026-10-21-activity-watchdog-design.md §2.2): a phase or single call
 * that shows no activity for its idle limit is stopped as `stalled`. An open tool suspends the clock -- a test suite prints
 * nothing while it runs -- but only up to 3 × the limit, so a hung tool is not left to the wall clock alone.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

/** Spec §2.1: absent ⇒ min(10 min, timeoutMs); null ⇒ no watchdog. */
export function effectiveIdleTimeoutMs(installation: { timeoutMs: number; idleTimeoutMs?: unknown }): number | null {
  if (installation.idleTimeoutMs === null) return null;
  return typeof installation.idleTimeoutMs === "number" ? installation.idleTimeoutMs : Math.min(DEFAULT_IDLE_TIMEOUT_MS, installation.timeoutMs);
}

export type IdleSnapshotV1 = { limitMs: number; lastActivityAt: string; openTools: number; toolOpenedAt: string | null };

export class IdleWatch {
  private lastActivityAt = Date.now();
  private readonly openIds = new Set<string>();
  private reportedOpen = 0;
  private toolOpenedAt: number | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly limitMs: number | null, private readonly onStall: () => void) {}

  start(): void {
    if (this.limitMs === null || this.timer !== undefined) return;
    this.lastActivityAt = Date.now();
    const every = Math.max(10, Math.min(1_000, Math.floor(this.limitMs / 5)));
    this.timer = setInterval(() => this.check(), every);
  }

  stop(): void { clearInterval(this.timer); }

  activity(): void { this.lastActivityAt = Date.now(); }

  toolStarted(id: string): void { this.openIds.add(id); this.noteOpen(); }
  toolEnded(id: string): void { this.openIds.delete(id); this.noteOpen(); }
  /** claude: the runner reports the count itself (fd-4 lines). */
  reportOpenTools(count: number): void { this.reportedOpen = count; this.noteOpen(); }

  private openTools(): number { return this.openIds.size + this.reportedOpen; }
  private noteOpen(): void {
    if (this.openTools() === 0) this.toolOpenedAt = null;
    else if (this.toolOpenedAt === null) this.toolOpenedAt = Date.now();
  }

  private check(): void {
    if (this.limitMs === null) return;
    const idle = Date.now() - this.lastActivityAt;
    if (idle >= this.limitMs && (this.openTools() === 0 || idle >= 3 * this.limitMs)) {
      this.stop();
      this.onStall();
    }
  }

  snapshot(): IdleSnapshotV1 | null {
    if (this.limitMs === null) return null;
    return { limitMs: this.limitMs, lastActivityAt: new Date(this.lastActivityAt).toISOString(), openTools: this.openTools(),
      toolOpenedAt: this.toolOpenedAt === null ? null : new Date(this.toolOpenedAt).toISOString() };
  }
}

/** codex `--json` lines: tool items open on item.started and close on item.completed (spec §2.2 codex). */
const CODEX_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "web_search"]);
export function codexToolEvent(line: string, watch: IdleWatch): void {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  const r = row as { type?: unknown; item?: { id?: unknown; type?: unknown } } | null;
  if (r === null || typeof r !== "object" || typeof r.item?.id !== "string") return;
  if (r.type === "item.started" && typeof r.item.type === "string" && CODEX_TOOL_ITEMS.has(r.item.type)) watch.toolStarted(r.item.id);
  if (r.type === "item.completed") watch.toolEnded(r.item.id);
}

/** omp `--mode json` lines: tool_execution_start / tool_execution_end by toolCallId (spec §2.2 omp). */
export function ompToolEvent(line: string, watch: IdleWatch): void {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  const r = row as { type?: unknown; toolCallId?: unknown } | null;
  if (r === null || typeof r !== "object" || typeof r.toolCallId !== "string") return;
  if (r.type === "tool_execution_start") watch.toolStarted(r.toolCallId);
  if (r.type === "tool_execution_end") watch.toolEnded(r.toolCallId);
}

/** Splits a byte stream into complete lines for the tool trackers (the bytes themselves are activity already). */
export function lineFeeder(onLine: (line: string) => void): (chunk: Buffer) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    let index;
    while ((index = pending.indexOf("\n")) !== -1) { onLine(pending.slice(0, index)); pending = pending.slice(index + 1); }
    if (pending.length > 1024 * 1024) pending = "";
  };
}
