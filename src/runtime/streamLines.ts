import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

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
 * positional writeSync at the record's own offset (no O_APPEND), so they are in the file when write() returns (a SIGKILLed
 * process loses none it accepted). When a chunk would pass the cap, the record is cut back to the end of the last complete
 * line under the cap: the marker (if any) is written at that offset first and the file is truncated after it, so a process
 * that dies between the two still has its marker at the cut. Nothing more is written; the caller's process goes on.
 * Review I2 (Orca session ffec7b28): any write error stops the record for good and is rethrown; the descriptor is never
 * written again, so a later chunk can neither land after a gap nor go to a reused descriptor number.
 */
export class CappedLineFile {
  private readonly fd: number;
  private size: number;
  private lastLineEnd: number;
  private stopped = false;
  private closed = false;
  truncatedAt: number | null = null;

  constructor(path: string, private readonly cap: number, private readonly marker?: (atBytes: number) => string) {
    this.fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    // An existing record is continued after its last byte (callers pre-create it empty).
    this.size = fstatSync(this.fd).size;
    this.lastLineEnd = this.size;
  }

  write(chunk: Buffer): void {
    if (this.stopped || this.closed) return;
    try {
      if (this.size + chunk.length <= this.cap) {
        this.writeAt(chunk, this.size);
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) this.lastLineEnd = this.size + newline + 1;
        this.size += chunk.length;
        return;
      }
      const room = this.cap - this.size;
      const newline = room > 0 ? chunk.subarray(0, room).lastIndexOf(10) : -1;
      let end = this.lastLineEnd;
      if (newline >= 0) { this.writeAt(chunk.subarray(0, newline + 1), this.size); end = this.size + newline + 1; }
      this.stopped = true;
      this.truncatedAt = end;
      const marker = this.marker === undefined ? Buffer.alloc(0) : Buffer.from(this.marker(end), "utf8");
      if (marker.length > 0) this.writeAt(marker, end);
      ftruncateSync(this.fd, end + marker.length);
      this.size = end + marker.length;
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  get sizeBytes(): number { return this.size; }

  private writeAt(bytes: Buffer, position: number): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset, position + offset);
  }
}

const NEWLINE = Buffer.from("\n");
const NO_MARKER = Buffer.alloc(0);
/** Bytes of complete lines held before they go to the file in one write; write() also flushes on return. */
const FLUSH_BYTES = 256 * 1024;

/**
 * Append receipt metadata after complete object rows; provider bytes are written unchanged before the metadata.
 * Orca tester #397: complete lines (body, "\n", marker) are queued and handed to the file in one write per incoming
 * chunk, instead of the three writeSync calls per line that cost 968-1083 ms for 33 MB (a buffered write costs 23-32 ms).
 * write() flushes before returning, so a SIGKILLed writer still loses nothing it accepted.
 */
export class ObservedTranscriptFile {
  private readonly file: CappedLineFile;
  private parts: Buffer[] = [];
  private pending = 0;
  private oversized = false;
  private failed = false;
  /** Bytes not yet handed to `file`: complete lines, and the unfinished line this call received. */
  private out: Buffer[] = [];
  private outBytes = 0;
  /** Offset in the file where the line being observed began. */
  private lineStart: number;

  constructor(path: string, private readonly cap = TRANSCRIPT_LIMIT) {
    this.file = new CappedLineFile(path, cap, transcriptMarker);
    this.lineStart = this.file.sizeBytes;
  }

  get truncatedAt(): number | null { return this.file.truncatedAt; }

  write(chunk: Buffer): void {
    if (this.failed || this.file.truncatedAt !== null) return;
    const receivedAt = Date.now();
    try {
      let start = 0;
      /** First byte of the pending line that this call has not queued yet (earlier calls queued theirs and flushed). */
      let lineStartInChunk = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        if (newline < 0) break;
        this.add(chunk.subarray(start, newline));
        if (this.oversized) {
          // A line over MAX_LINE_BYTES is never kept whole: its bytes go straight out, then the newline.
          this.queue(chunk.subarray(lineStartInChunk, newline));
          this.queue(NEWLINE);
        } else {
          // Queued as pieces; flush() concatenates them into the one write for this chunk.
          this.queue(chunk.subarray(lineStartInChunk, newline));
          this.queue(NEWLINE);
          this.queue(this.marker(this.lineStart, receivedAt));
        }
        this.parts = []; this.pending = 0; this.oversized = false;
        start = newline + 1; lineStartInChunk = start;
        this.lineStart = this.size;
        this.flushIfFull();
        if (this.file.truncatedAt !== null) { this.reset(); return; }
      }
      if (start < chunk.length) this.add(chunk.subarray(start));
      if (chunk.length > lineStartInChunk) this.queue(chunk.subarray(lineStartInChunk));
      // Everything write() accepted is on disk before it returns.
      this.flush();
    } catch (error) { this.failed = true; throw error; }
  }

  close(): void {
    try {
      if (!this.failed && this.file.truncatedAt === null && !this.oversized && this.pending > 0) {
        const marker = this.marker(this.lineStart, Date.now());
        // A final line without a newline is already durable. Optional metadata must not evict it at the cap.
        if (marker.length > 0 && this.size + 1 + marker.length <= this.cap) this.queue(Buffer.concat([NEWLINE, marker]));
      }
      if (!this.failed) this.flush();
    } finally { this.file.close(); }
  }

  /** The file position the queued bytes will occupy. */
  private get size(): number { return this.file.sizeBytes + this.outBytes; }

  private queue(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.out.push(bytes);
    this.outBytes += bytes.length;
  }

  private flushIfFull(): void { if (this.outBytes >= FLUSH_BYTES) this.flush(); }

  private flush(): void {
    if (this.outBytes === 0) return;
    const bytes = this.out.length === 1 ? this.out[0]! : Buffer.concat(this.out, this.outBytes);
    this.out = []; this.outBytes = 0;
    this.file.write(bytes);
  }

  private reset(): void { this.parts = []; this.pending = 0; this.oversized = false; this.out = []; this.outBytes = 0; }

  private add(bytes: Buffer): void {
    if (bytes.length === 0 || this.oversized) return;
    this.parts.push(bytes);
    this.pending += bytes.length;
    if (this.pending > MAX_LINE_BYTES) { this.oversized = true; this.parts = []; }
  }

  /** The observation marker for a complete line, or nothing when the line is not a JSON object (kept as received). */
  private marker(atBytes: number, receivedAt: number): Buffer {
    const bytes = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.pending);
    let row: unknown;
    try { row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return NO_MARKER; /* Preserve invalid input as received. */ }
    if (row === null || typeof row !== "object" || Array.isArray(row)) return NO_MARKER;
    return Buffer.from(`${JSON.stringify({ type: "ccloop.line-observed", atBytes, ccloopObservedAt: receivedAt })}\n`, "utf8");
  }
}

/** One stdout line as every runtime decoder reads it: blank, a parsed JSON value, text that does not parse, or too large. */
export type JsonLine = { kind: "blank" } | { kind: "row"; row: unknown } | { kind: "unparsed" } | { kind: "too-large" };

export function jsonLine(line: StreamLine): JsonLine {
  if (line.tooLarge) return { kind: "too-large" };
  if (!line.text.trim()) return { kind: "blank" };
  try { return { kind: "row", row: JSON.parse(line.text) }; } catch { return { kind: "unparsed" }; }
}

/**
 * Live transcript (spec §10.2.3): a decoder written as a fold reads lines one at a time. Its string form is
 * `fold(lines(text))`: this feeds a whole text through the same fold.
 */
export function foldText<F extends { push(line: JsonLine): void }>(text: string, fold: F): F {
  for (const line of textLines(text)) fold.push(jsonLine(line));
  return fold;
}

/** Live transcript (Orca spec 2026-10-23 §11.1): a codex/omp call whose stdout passes 1 GiB stops as output-limit (runaway guard). */
export const STDOUT_HARD_LIMIT = 1024 * 1024 * 1024;
/** Spec §10.2.2: the live view's record of one call; past it recording stops at a line end and a marker says where. */
export const TRANSCRIPT_LIMIT = 128 * 1024 * 1024;
export const transcriptMarker = (atBytes: number): string => `${JSON.stringify({ type: "ccloop.transcript-truncated", atBytes })}\n`;

/**
 * Plan D4: a codex/omp outcome carries its stream folds and, for existing readers, the recorded events.jsonl text read from
 * disk on access. Both are non-enumerable, so the outcome.json that spreads the outcome keeps its keys.
 */
export function attachOutcomeStream<T extends object, S>(result: T, evidenceDir: string, stream: S): T {
  Object.defineProperty(result, "stream", { value: stream, enumerable: false });
  Object.defineProperty(result, "events", { enumerable: false, get: () => { try { return readFileSync(join(evidenceDir, "events.jsonl"), "utf8"); } catch { return ""; } } });
  return result;
}

/**
 * Live transcript (spec §10.2.2, §10.2.4): where a transcript stopped recording, read from its last line -- the
 * `ccloop.transcript-truncated` marker -- and checked against the file's size (the marker's atBytes plus the marker line
 * is the whole file). Null when it was not truncated, or the file cannot be read. Reads at most the last 256 bytes.
 */
export async function transcriptTruncatedAt(path: string): Promise<number | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { size } = await handle.stat();
    const length = Math.min(size, 256);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);
    const text = tail.toString("utf8");
    if (!text.endsWith("\n")) return null;
    const line = text.slice(text.lastIndexOf("\n", text.length - 2) + 1);
    const marker = JSON.parse(line) as { type?: unknown; atBytes?: unknown };
    if (marker.type !== "ccloop.transcript-truncated" || typeof marker.atBytes !== "number" || !Number.isSafeInteger(marker.atBytes)) return null;
    return marker.atBytes + Buffer.byteLength(transcriptMarker(marker.atBytes)) === size ? marker.atBytes : null;
  } catch { return null; } finally { await handle?.close(); }
}
