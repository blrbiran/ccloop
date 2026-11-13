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

/**
 * Working time (Orca issue #262; human, Orca session d467cbd2, 2026-11-13: 「时间预算只算真正在干活的时间」): inside a watched
 * agent process, a silence longer than this -- no stdout/stderr byte (codex, omp) or fd-4 line (claude), and no tool open --
 * is charged only up to this long. Two minutes: a single model turn that streams nothing until it is complete (claude
 * stream-json without partial messages, a codex reasoning item) stays working time, while a network stall that the idle
 * watchdog stops (default 10 min, too long to serve here) is charged two minutes, not ten.
 */
export const IDLE_CHARGE_LIMIT_MS = 120_000;

/**
 * Working time (Orca issue #262): what a phase's charged time leaves out. A window opens when a watched agent process starts
 * and closes when its watch stops; inside a window, each gap between consecutive observations (activity or a change of the
 * open-tool count) with no tool open counts as idle by what exceeds the limit. Time outside every window -- ccloop's own work
 * before, between and after the agent processes, a retry's backoff -- is never idle.
 */
export class IdleLedger {
  private from: number | null = null;
  private open = 0;
  private idle = 0;

  constructor(private readonly limitMs: number = IDLE_CHARGE_LIMIT_MS) {}

  /** A watched agent process started. */
  start(): void { this.close(Date.now()); this.from = Date.now(); this.open = 0; }

  /** An observation from the agent, with its open-tool count from now on. */
  mark(openTools: number): void {
    if (this.from === null) return;
    const now = Date.now();
    this.close(now);
    this.from = now;
    this.open = openTools;
  }

  /** The process's watch stopped: what follows is ccloop's own work. */
  stop(): void { this.close(Date.now()); this.from = null; }

  /** Idle time so far, the current gap of an open window included. */
  idleMs(now: number = Date.now()): number { return this.idle + this.excess(now); }

  private excess(now: number): number {
    return this.from === null || this.open > 0 ? 0 : Math.max(0, now - this.from - this.limitMs);
  }

  private close(now: number): void { this.idle += this.excess(now); }
}

export class IdleWatch {
  private lastActivityAt = Date.now();
  private readonly openIds = new Set<string>();
  private reportedOpen = 0;
  private toolOpenedAt: number | null = null;
  private timer: NodeJS.Timeout | undefined;

  private started = false;

  constructor(private readonly limitMs: number | null, private readonly onStall: () => void, private readonly ledger?: IdleLedger) {}

  start(): void {
    if (!this.started) { this.started = true; this.ledger?.start(); }
    if (this.limitMs === null || this.timer !== undefined) return;
    this.lastActivityAt = Date.now();
    const every = Math.max(10, Math.min(1_000, Math.floor(this.limitMs / 5)));
    this.timer = setInterval(() => this.check(), every);
  }

  stop(): void { clearInterval(this.timer); this.ledger?.stop(); }

  activity(): void { this.lastActivityAt = Date.now(); this.ledger?.mark(this.openTools()); }

  toolStarted(id: string): void { this.openIds.add(id); this.noteOpen(); }
  toolEnded(id: string): void { this.openIds.delete(id); this.noteOpen(); }
  /** claude: the runner reports the count itself (fd-4 lines). */
  reportOpenTools(count: number): void { this.reportedOpen = count; this.noteOpen(); }

  private openTools(): number { return this.openIds.size + this.reportedOpen; }
  private noteOpen(): void {
    if (this.openTools() === 0) this.toolOpenedAt = null;
    else if (this.toolOpenedAt === null) this.toolOpenedAt = Date.now();
    this.ledger?.mark(this.openTools());
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
  codexToolRow(row, watch);
}
/** codexToolEvent on a line already parsed (live transcript: the phase's stream fold parses each line once). */
export function codexToolRow(row: unknown, watch: IdleWatch): void {
  const r = row as { type?: unknown; item?: { id?: unknown; type?: unknown } } | null;
  if (r === null || typeof r !== "object" || typeof r.item?.id !== "string") return;
  if (r.type === "item.started" && typeof r.item.type === "string" && CODEX_TOOL_ITEMS.has(r.item.type)) watch.toolStarted(r.item.id);
  if (r.type === "item.completed") watch.toolEnded(r.item.id);
}

/** omp `--mode json` lines: tool_execution_start / tool_execution_end by toolCallId (spec §2.2 omp). */
export function ompToolEvent(line: string, watch: IdleWatch): void {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  ompToolRow(row, watch);
}
/** ompToolEvent on a line already parsed (live transcript: the phase's stream fold parses each line once). */
export function ompToolRow(row: unknown, watch: IdleWatch): void {
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
