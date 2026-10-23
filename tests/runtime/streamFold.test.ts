import { describe, expect, it } from "vitest";
import { LineSplitter, MAX_LINE_BYTES, textLines, type StreamLine } from "../../src/runtime/streamLines.js";

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
