import { describe, expect, it, vi } from "vitest";
import { classifyCodexCall } from "../../src/runtime/failureCause.js";
import { decodeCodexSingleCall } from "../../src/runtime/codex/codexSingleCall.js";
import { CodexStream } from "../../src/runtime/codex/codexStream.js";
import { codexModelUsage, codexResultOf, decodeCodexResult, decodeCodexUsage, observedTurnUsage } from "../../src/runtime/codex/protocol.js";
import { classifyRateLimit } from "../../src/runtime/codex/rateLimit.js";
import { jsonLine, LineSplitter, MAX_LINE_BYTES, textLines, type StreamLine } from "../../src/runtime/streamLines.js";

// Live transcript (Orca spec 2026-10-23 §10.2.3, criterion L3): codex and omp decode their stdout line by line as it
// arrives instead of keeping the stream. Why each case matters: a multi-byte character cut by a pipe chunk must not turn
// into U+FFFD (that changes what a decoder reads), a long line must not be dropped (a dropped `turn.completed` would lose the
// call's usage), and a line too large to hold is named, never skipped as if it had not been printed.
const collect = (chunks: Buffer[]): StreamLine[] => {
  const lines: StreamLine[] = [];
  const splitter = new LineSplitter((line) => lines.push(line));
  for (const chunk of chunks) splitter.write(chunk);
  splitter.end();
  return lines;
};

describe("stream line splitter", () => {
  it("keeps a multi-byte character that a chunk boundary cuts in two", () => {
    const bytes = Buffer.from('{"t":"中文"}\n{"t":"é"}', "utf8");
    // Cut inside 中 (3 bytes) and inside é (2 bytes).
    const cut1 = bytes.indexOf(Buffer.from("中")) + 1, cut2 = bytes.indexOf(Buffer.from("é")) + 1;
    const lines = collect([bytes.subarray(0, cut1), bytes.subarray(cut1, cut2), bytes.subarray(cut2)]);
    expect(lines).toEqual([{ tooLarge: false, text: '{"t":"中文"}' }, { tooLarge: false, text: '{"t":"é"}' }]);
  });

  it("delivers a 2 MiB line whole", () => {
    const long = `{"t":"${"a".repeat(2 * 1024 * 1024)}"}`;
    const buffer = Buffer.from(`${long}\n{"t":"next"}\n`);
    const chunks: Buffer[] = [];
    for (let i = 0; i < buffer.length; i += 65536) chunks.push(buffer.subarray(i, i + 65536));
    const lines = collect(chunks);
    expect(lines.map((line) => line.tooLarge ? "too-large" : line.text.length)).toEqual([long.length, '{"t":"next"}'.length]);
  });

  it("names a line over 16 MiB as too large and goes on with the next line", () => {
    const big = Buffer.alloc(MAX_LINE_BYTES + 1024 * 1024, 0x61);
    const lines = collect([Buffer.from('{"a":1}\n'), big.subarray(0, 5 * 1024 * 1024), big.subarray(5 * 1024 * 1024), Buffer.from('\n{"b":2}\n')]);
    expect(lines).toEqual([
      { tooLarge: false, text: '{"a":1}' },
      { tooLarge: true, text: null, bytes: MAX_LINE_BYTES + 1024 * 1024 },
      { tooLarge: false, text: '{"b":2}' },
    ]);
  });

  it("names a too-large last line without a newline at the end", () => {
    const lines = collect([Buffer.alloc(MAX_LINE_BYTES + 1, 0x61)]);
    expect(lines).toEqual([{ tooLarge: true, text: null, bytes: MAX_LINE_BYTES + 1 }]);
  });

  it("splits text exactly as split('\\n') does, with the same ceiling", () => {
    expect([...textLines('a\n\nb\n')]).toEqual([{ tooLarge: false, text: "a" }, { tooLarge: false, text: "" }, { tooLarge: false, text: "b" }, { tooLarge: false, text: "" }]);
    expect([...textLines(`x\n${"a".repeat(MAX_LINE_BYTES + 1)}`)]).toEqual([{ tooLarge: false, text: "x" }, { tooLarge: true, text: null, bytes: MAX_LINE_BYTES + 1 }]);
  });
});

// Fold vs string (L3, codex): the live path feeds the adapter's folds from pipe chunks; the string functions feed the same
// folds from text.split("\n"). Every case below must give the same verdict, or the same error, both ways and for every
// chunking -- otherwise a call would decode differently live than its evidence decodes on recovery.
const row = (value: unknown) => JSON.stringify(value);
const completed = (input: number, output: number, extra: Record<string, unknown> = {}) => row({ type: "turn.completed", usage: { input_tokens: input, output_tokens: output, ...extra } });
const CODEX_CORPUS: Record<string, string> = {
  ok: [row({ type: "thread.started", thread_id: "t" }), row({ type: "turn.started" }), row({ type: "item.completed", item: { id: "i", type: "agent_message", text: "中文 é 😀" } }), completed(12, 3, { cached_input_tokens: 4 })].join("\n") + "\n",
  "no trailing newline": [row({ type: "turn.started" }), completed(5, 1)].join("\n"),
  blank: `\n  \n${completed(5, 1)}\n\n`,
  "same completion twice": [completed(5, 1), completed(5, 1)].join("\n"),
  "conflicting completions": [completed(5, 1), completed(6, 1)].join("\n"),
  "turn failed": [row({ type: "turn.started" }), row({ type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests" }), row({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } })].join("\n"),
  "429 after an item": [row({ type: "turn.started" }), row({ type: "item.started", item: { id: "c", type: "command_execution" } }), row({ type: "error", message: "last status: 429" })].join("\n"),
  "5xx": [row({ type: "turn.started" }), row({ type: "turn.failed", error: { message: "unexpected status 503, last status: 503" } })].join("\n"),
  unparsed: [row({ type: "turn.started" }), "{not json", completed(5, 1)].join("\n"),
  "not an object": [row({ type: "turn.started" }), "[1,2]", completed(5, 1)].join("\n"),
  "no type": [row({ item: {} }), completed(5, 1)].join("\n"),
  "no completion": row({ type: "turn.started" }),
  "zero usage": completed(0, 0),
  "bad cached": completed(5, 1, { cached_input_tokens: 9 }),
  "error items": [row({ type: "item.completed", item: { id: "e", type: "error", message: "warning 中" } }), row({ type: "item.completed", item: { type: "agent_message", text: "{\"answer\":\"42\"}" } }), completed(20, 4)].join("\n"),
  "tool item": [row({ type: "item.completed", item: { id: "t", type: "some_future_tool_call" } }), completed(30, 6)].join("\n"),
  "two messages": [row({ type: "item.completed", item: { type: "agent_message", text: "a" } }), row({ type: "item.completed", item: { type: "agent_message", text: "b" } }), completed(3, 1)].join("\n"),
  // A turn.completed padded past 1 MiB: dropping long lines would lose the call's usage.
  "long completion line": completed(7, 2, { pad: "x".repeat(2 * 1024 * 1024) }),
};
const PLAN_FINAL = JSON.stringify({ summary: "s", primaryTargetPaths: ["a"] });
type Settled = { ok: unknown } | { error: string; observedTokens: unknown };
const settle = (fn: () => unknown): Settled => {
  try { return { ok: fn() }; } catch (error) { return { error: String(error), observedTokens: (error as { observedTokens?: unknown }).observedTokens }; }
};
function chunked(text: string, size: number): CodexStream {
  const stream = new CodexStream();
  const splitter = new LineSplitter((line) => stream.push(jsonLine(line)));
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i += size) splitter.write(bytes.subarray(i, i + size));
  splitter.end();
  return stream;
}
function codexVerdicts(text: string): Record<string, Settled> {
  return {
    observed: settle(() => observedTurnUsage(text)), usage: settle(() => decodeCodexUsage(text)), unique: settle(() => decodeCodexUsage(text, true)),
    rateLimit: settle(() => classifyRateLimit(text)), call: settle(() => classifyCodexCall(text)), model: settle(() => codexModelUsage(text, "gpt-x")),
    result: settle(() => decodeCodexResult("plan", text, PLAN_FINAL)),
    single: settle(() => decodeCodexSingleCall(text, "{\"answer\":\"42\"}", "gpt-x", "/evidence")),
  };
}
function codexFoldVerdicts(stream: CodexStream): Record<string, Settled> {
  return {
    observed: settle(() => stream.turnUsage.value()), usage: settle(() => stream.usage.value()), unique: settle(() => stream.uniqueUsage.value()),
    rateLimit: settle(() => stream.rateLimit.value()), call: settle(() => stream.call.value()), model: settle(() => stream.modelUsage.value("gpt-x")),
    result: settle(() => codexResultOf("plan", stream.usage.value(), PLAN_FINAL)),
    single: settle(() => stream.singleCall.value("{\"answer\":\"42\"}", "gpt-x", "/evidence")),
  };
}

describe("codex stream fold", () => {
  const quiet = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  it.each(Object.keys(CODEX_CORPUS))("decodes %s the same from chunks as from text", (name) => {
    const spy = quiet();
    try {
      const text = CODEX_CORPUS[name]!;
      const expected = codexVerdicts(text);
      for (const size of [1, 7, 65536, Buffer.byteLength(text) + 1]) {
        if (size === 1 && text.length > 100_000) continue;
        expect(codexFoldVerdicts(chunked(text, size)), `chunk ${size}`).toEqual(expected);
      }
    } finally { spy.mockRestore(); }
  });

  it("decodes a multi-byte answer cut by every chunk boundary intact", () => {
    const text = CODEX_CORPUS.ok!;
    const stream = chunked(text, 1);
    expect(stream.call.value()).toBeNull();
    expect(settle(() => stream.uniqueUsage.value())).toEqual({ ok: { tokenUsage: 15, usageEvidence: expect.anything() } });
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => { if (!line.tooLarge) lines.push(line.text); });
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i++) splitter.write(bytes.subarray(i, i + 1));
    splitter.end();
    expect(lines.join("\n")).toContain("中文 é 😀");
    expect(lines.join("\n")).not.toContain("�");
  });

  it("names a line over 16 MiB codex-events-line-too-large, and the lenient readers count it as unparsed", () => {
    const spy = quiet();
    try {
      const text = [row({ type: "turn.started" }), row({ type: "item.completed", item: { type: "agent_message", text: "a".repeat(17 * 1024 * 1024) } }), completed(5, 1)].join("\n");
      const stream = chunked(text, 65536);
      expect(settle(() => stream.usage.value())).toMatchObject({ error: "Error: codex-events-line-too-large" });
      expect(settle(() => stream.uniqueUsage.value())).toMatchObject({ error: "Error: codex-events-line-too-large" });
      expect(settle(() => stream.singleCall.value("{}", "m", "/e"))).toMatchObject({ error: "Error: codex-events-line-too-large", observedTokens: 6 });
      expect(stream.call.value()).toBeNull();
      expect(stream.turnUsage.value()).toBe(6);
      expect(codexFoldVerdicts(stream)).toEqual(codexVerdicts(text));
    } finally { spy.mockRestore(); }
  });
});
