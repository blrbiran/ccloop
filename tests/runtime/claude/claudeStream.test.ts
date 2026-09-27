import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without types
import { createLineSplitter, createUsageObserver, writeObservation, OBSERVED_USAGE_SCHEMA } from "../../../scripts/claude-stream.mjs";

// Orca claude stream usage (2026-09-27), spec §3.1 items 2, 4, 5 and §4: what the runner counts from claude's stream.
const START = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 };
const DELTA = { ...START, output_tokens: 7 };
const start = (id: string, usage: unknown = START) => ({ type: "stream_event", event: { type: "message_start", message: { id, usage } } });
const delta = (usage: unknown = DELTA) => ({ type: "stream_event", event: { type: "message_delta", usage } });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("claude stream observation (spec §3.1)", () => {
  it("counts each message once: its message_start snapshot until message_delta closes it", () => {
    const o = createUsageObserver();
    expect(o.observe(start("m1"))).toBe(true);
    expect(o.snapshot()).toMatchObject({ total: 1103, openMessage: true });
    expect(o.observe({ type: "assistant", message: { id: "m1", usage: START } })).toBe(false);
    expect(o.observe(delta())).toBe(true);
    expect(o.snapshot()).toMatchObject({ total: 1109, openMessage: false, messages: [{ id: "m1", state: "closed" }] });
    o.observe(start("m2"));
    expect(o.snapshot()).toMatchObject({ total: 1109 + 1103, openMessage: true });
  });

  it("gives no total for nothing, for zero, and skips non-finite or negative fields", () => {
    const o = createUsageObserver();
    expect(o.snapshot().total).toBeNull();
    o.observe(start("m0", { input_tokens: 0, output_tokens: 0 }));
    expect(o.snapshot().total).toBeNull();
    const p = createUsageObserver();
    p.observe(start("m1", { input_tokens: 5, output_tokens: -3, cache_read_input_tokens: "7" }));
    expect(p.snapshot().total).toBe(5);
  });

  it("ignores a message_delta with no open message and events that are not usage", () => {
    const o = createUsageObserver();
    expect(o.observe(delta())).toBe(false);
    expect(o.observe({ type: "result", usage: { input_tokens: 9 } })).toBe(false);
    expect(o.snapshot().total).toBeNull();
  });

  it("splits lines across chunks, parses a last line without newline at end, and drops a line over the cap", () => {
    const seen: string[] = [];
    const s = createLineSplitter((line: string) => seen.push(line), 16);
    s.push('{"a":1}\n{"b"'); s.push(':2}\n'); s.push("x".repeat(40)); s.push("\n{\"c\":3}");
    s.end();
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  // Orca claude stream usage (2026-09-27), spec §3.1: the cap's two branches, pinned separately -- the prior
  // test only ever exercised them together, so either one could regress without turning anything red.
  it("pins each branch of the per-line cap on its own: a whole over-cap line in one chunk, and a partial buffer that grows over cap before any newline", () => {
    // Branch A: a complete line, over the cap, arrives with its own newline in a single chunk -- dropped whole.
    const seenA: string[] = [];
    const a = createLineSplitter((line: string) => seenA.push(line), 8);
    a.push('123456789012\nok\n');
    a.end();
    expect(seenA).toEqual(["ok"]);

    // Branch B: no newline arrives until the buffered text has already grown over the cap across chunks --
    // it keeps dropping until the next newline, then recovers; a following normal line still comes through.
    const seenB: string[] = [];
    const b = createLineSplitter((line: string) => seenB.push(line), 8);
    b.push("12345"); b.push("67890123"); b.push('45\nok\n');
    b.push('{"d":4}\n');
    b.end();
    expect(seenB).toEqual(["ok", '{"d":4}']);
  });

  it("writes the observation atomically with mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-stream-")); dirs.push(dir);
    const o = createUsageObserver(); o.observe(start("m1"));
    const path = join(dir, "observed-usage.json");
    writeObservation(path, o.snapshot());
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema: OBSERVED_USAGE_SCHEMA, total: 1103, messages: [{ id: "m1", state: "open", fields: START }], source: "stream-before-abort", lowerBound: true, openMessage: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
