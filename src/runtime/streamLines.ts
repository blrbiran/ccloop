import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

/**
 * Live transcript (Orca spec docs/superpowers/specs/2026-10-23-live-transcript-design.md §10.2.3, ccloop plan
 * 2026-10-24-live-transcript-ccloop.md D6): a line longer than this is not kept in memory. It is the ceiling a whole codex or
 * omp stream had before the stream stopped being kept, so no stream that decoded before can fail on it now.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** A complete line (without its `\n`), or a line that passed MAX_LINE_BYTES and was not kept (its byte count only). */
export type StreamLine = { tooLarge: false; text: string } | { tooLarge: true; text: null; bytes: number };

/**
 * Splits a byte stream into lines at `\n` (0x0A never occurs inside a UTF-8 sequence) and decodes each complete line whole,
 * so a multi-byte character cut by a chunk boundary decodes intact. Nothing is dropped silently: a line over the ceiling is
 * delivered as `tooLarge` at its newline (or at end()). The bytes of a pending line are kept as the chunks' own buffers.
 */
export class LineSplitter {
  private parts: Buffer[] = [];
  private pending = 0;
  private dropping = false;

  constructor(private readonly onLine: (line: StreamLine) => void, private readonly maxLineBytes = MAX_LINE_BYTES) {}

  write(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) break;
      this.add(chunk.subarray(start, newline));
      this.flush();
      start = newline + 1;
    }
    if (start < chunk.length) this.add(chunk.subarray(start));
  }

  end(): void {
    if (this.pending > 0 || this.dropping) this.flush();
  }

  private add(bytes: Buffer): void {
    this.pending += bytes.length;
    if (this.dropping) return;
    if (this.pending > this.maxLineBytes) { this.dropping = true; this.parts = []; return; }
    if (bytes.length > 0) this.parts.push(bytes);
  }

  private flush(): void {
    const line: StreamLine = this.dropping ? { tooLarge: true, text: null, bytes: this.pending }
      : { tooLarge: false, text: this.parts.length === 1 ? this.parts[0]!.toString("utf8") : Buffer.concat(this.parts).toString("utf8") };
    this.parts = []; this.pending = 0; this.dropping = false;
    this.onLine(line);
  }
}

/** The same lines for text already in memory: exactly `text.split("\n")`, with the same ceiling (by UTF-8 bytes). */
export function* textLines(text: string, maxLineBytes = MAX_LINE_BYTES): Generator<StreamLine> {
  for (const line of text.split("\n")) {
    // A UTF-16 code unit is at most 3 UTF-8 bytes; only a line that could pass the ceiling is counted.
    const bytes = line.length * 3 > maxLineBytes ? Buffer.byteLength(line, "utf8") : 0;
    yield bytes > maxLineBytes ? { tooLarge: true, text: null, bytes } : { tooLarge: false, text: line };
  }
}

/**
 * Live transcript (spec §10.2.2, §11.1): a record capped at `cap` bytes. Bytes go out through a kept-open descriptor with
 * writeSync, so they are in the file when write() returns (a SIGKILLed process loses none it accepted). When a chunk would
 * pass the cap, the file is cut back to the end of the last complete line under the cap, `marker(atBytes)` (if any) is
 * appended once, and nothing more is written; the caller's process goes on.
 */
export class CappedLineFile {
  private readonly fd: number;
  private size = 0;
  private lastLineEnd = 0;
  private stopped = false;
  private closed = false;
  truncatedAt: number | null = null;

  constructor(path: string, private readonly cap: number, private readonly marker?: (atBytes: number) => string) {
    this.fd = openSync(path, "a", 0o600);
  }

  write(chunk: Buffer): void {
    if (this.stopped || this.closed) return;
    if (this.size + chunk.length <= this.cap) {
      this.writeAll(chunk);
      const newline = chunk.lastIndexOf(10);
      if (newline >= 0) this.lastLineEnd = this.size + newline + 1;
      this.size += chunk.length;
      return;
    }
    const room = this.cap - this.size;
    const newline = room > 0 ? chunk.subarray(0, room).lastIndexOf(10) : -1;
    let end = this.lastLineEnd;
    if (newline >= 0) { this.writeAll(chunk.subarray(0, newline + 1)); end = this.size + newline + 1; }
    ftruncateSync(this.fd, end);
    this.size = end;
    this.truncatedAt = end;
    this.stopped = true;
    if (this.marker !== undefined) this.writeAll(Buffer.from(this.marker(end), "utf8"));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  private writeAll(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
  }
}
