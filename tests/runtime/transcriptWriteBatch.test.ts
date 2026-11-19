import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Orca tester issue #397: `ObservedTranscriptFile` used to write a line as body, "\n" and marker -- three `writeSync`
// calls per JSON line (968-1083 ms for 33 MB / 200k lines, against 23-32 ms buffered). The criteria below count
// `fs.writeSync`, not `CappedLineFile.write`: retrying a short write is exactly what shows up as a second syscall
// there, so the syscall is the level the claim is made at. The bytes are asserted against the shape the three separate
// writes produced, so "fewer syscalls" never buys a different file.
const counted = vi.hoisted(() => ({ writes: [] as number[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      counted.writes.push(args[0]);
      return actual.writeSync(...args);
    },
  };
});

import { ObservedTranscriptFile } from "../../src/runtime/streamLines.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function transcript(cap?: number): Promise<{ file: ObservedTranscriptFile; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "transcript-write-batch-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, "", { mode: 0o600 });
  return { file: cap === undefined ? new ObservedTranscriptFile(path) : new ObservedTranscriptFile(path, cap), path };
}

const marker = (atBytes: number, at: number): string =>
  JSON.stringify({ type: "ccloop.line-observed", atBytes, ccloopObservedAt: at }) + "\n";

describe("transcript writes: one syscall per line at most, batched across a chunk", () => {
  it("writes a line's body, newline and marker in one write and keeps the bytes the separate writes produced", async () => {
    const { file, path } = await transcript();
    const clock = vi.spyOn(Date, "now").mockReturnValue(7);
    try {
      // Objects carry a marker; text, blank and array lines are kept exactly as received.
      const lines = ['{"type":"a"}', "plain text", "", "[1,2]", '{"type":"b","n":2}'];
      const before = counted.writes.length;
      for (const line of lines) file.write(Buffer.from(line + "\n"));
      expect(counted.writes.length - before).toBe(lines.length);
      const first = lines[0]! + "\n" + marker(0, 7);
      const atLast = Buffer.byteLength(first + "plain text\n\n[1,2]\n");
      file.close();
      expect(await readFile(path, "utf8"))
        .toBe(first + "plain text\n\n[1,2]\n" + lines[4] + "\n" + marker(atLast, 7));
    } finally { clock.mockRestore(); }
  });

  it("costs one write for a chunk of many lines and still writes a trailing partial line before returning", async () => {
    const { file, path } = await transcript();
    const clock = vi.spyOn(Date, "now").mockReturnValue(9);
    try {
      const before = counted.writes.length;
      file.write(Buffer.from('{"a":1}\n{"b":2}\nnot json\n{"partial"'));
      // Three complete lines share one write; the unfinished fourth is written before write() returns.
      expect(counted.writes.length - before).toBe(1);
      const first = '{"a":1}\n' + marker(0, 9);
      const second = '{"b":2}\n' + marker(Buffer.byteLength(first), 9);
      expect(await readFile(path, "utf8")).toBe(first + second + 'not json\n{"partial"');
      file.close();
    } finally { clock.mockRestore(); }
  });

  it("does not cost a syscall per line for a long run of lines in fixed-size chunks", async () => {
    const { file } = await transcript();
    const line = '{"type":"message_update"}\n';
    const stream = Buffer.from(line.repeat(10_000));
    const before = counted.writes.length;
    for (let at = 0; at < stream.length; at += 64 * 1024) file.write(stream.subarray(at, Math.min(at + 64 * 1024, stream.length)));
    // 10 000 lines were 30 000 writes in the old shape. The exact flush count depends on where the 256 KiB threshold
    // falls inside a chunk, so the criterion is an order-of-magnitude one: fewer than one write per 1 KiB of stream,
    // against 10 000 for one-per-line and 30 000 for the old shape.
    expect(counted.writes.length - before).toBeLessThan(stream.length / 1024);
    file.close();
  });

  it("puts each marker immediately after its own line, at that line's first byte", async () => {
    const { file, path } = await transcript();
    const clock = vi.spyOn(Date, "now").mockReturnValue(11);
    try {
      const before = counted.writes.length;
      file.write(Buffer.from('{"a":1}\nplain\n{"b":2}\n'));
      expect(counted.writes.length - before).toBe(1);
      file.close();
      const text = await readFile(path, "utf8");
      const rows = text.split("\n");
      expect(rows[0]).toBe('{"a":1}');
      expect(JSON.parse(rows[1]!)).toEqual({ type: "ccloop.line-observed", atBytes: 0, ccloopObservedAt: 11 });
      expect(rows[2]).toBe("plain");
      expect(rows[3]).toBe('{"b":2}');
      expect(JSON.parse(rows[4]!)).toEqual({
        type: "ccloop.line-observed", atBytes: Buffer.byteLength('{"a":1}\n' + rows[1] + "\nplain\n"), ccloopObservedAt: 11,
      });
    } finally { clock.mockRestore(); }
  });

  it("appends the final newline and marker for an unterminated object in one write at close", async () => {
    const { file, path } = await transcript();
    const clock = vi.spyOn(Date, "now").mockReturnValue(13);
    try {
      const body = '{"final":true}';
      const before = counted.writes.length;
      file.write(Buffer.from(body));
      expect(counted.writes.length - before).toBe(1);
      file.close();
      expect(counted.writes.length - before).toBe(2);
      expect(await readFile(path, "utf8")).toBe(body + "\n" + marker(0, 13));
    } finally { clock.mockRestore(); }
  });
});
