import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without types
import { createUsageObserver } from "../../../scripts/claude-stream.mjs";

// Orca backlog #12(b) (2026-09-29; Orca spec 2026-09-27-claude-stream-usage-design.md §8 item 4): claude tags every
// stream event with the parent_tool_use_id of the agent that streamed it -- null for the main agent (the spec's §2
// probe lines carry it as a top-level field). A subagent's message may open while the main one is still open; each
// message_delta must close the message its OWN stream opened, or one message is booked with the other's usage and
// the other stays "open" at its opening snapshot.
const MAIN_OPEN = { input_tokens: 2, output_tokens: 1 };
const MAIN_FINAL = { input_tokens: 2, output_tokens: 7 };
const SUB_OPEN = { input_tokens: 40, output_tokens: 1 };
const SUB_FINAL = { input_tokens: 40, output_tokens: 20 };
const event = (parent: string | null, inner: unknown) => ({ type: "stream_event", event: inner, parent_tool_use_id: parent });

describe("claude stream observation across a subagent's stream (Orca backlog #12(b))", () => {
  it("closes each message with the delta from its own stream when a subagent's message interleaves the main one", () => {
    const o = createUsageObserver();
    expect(o.observe(event(null, { type: "message_start", message: { id: "main", usage: MAIN_OPEN } }))).toBe(true);
    expect(o.observe(event("toolu_1", { type: "message_start", message: { id: "sub", usage: SUB_OPEN } }))).toBe(true);
    expect(o.observe(event(null, { type: "message_delta", usage: MAIN_FINAL }))).toBe(true);
    expect(o.observe(event("toolu_1", { type: "message_delta", usage: SUB_FINAL }))).toBe(true);
    expect(o.snapshot()).toEqual({
      total: 9 + 60,
      openMessage: false,
      messages: [{ id: "main", state: "closed", fields: MAIN_FINAL }, { id: "sub", state: "closed", fields: SUB_FINAL }],
    });
  });

  it("does not close a message from a stream that has opened none", () => {
    const o = createUsageObserver();
    o.observe(event(null, { type: "message_start", message: { id: "main", usage: MAIN_OPEN } }));
    expect(o.observe(event("toolu_1", { type: "message_delta", usage: SUB_FINAL }))).toBe(false);
    expect(o.snapshot()).toMatchObject({ total: 3, openMessage: true, messages: [{ id: "main", state: "open", fields: MAIN_OPEN }] });
  });
});
