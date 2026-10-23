import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CappedLineFile } from "../../src/runtime/streamLines.js";

// Live transcript (Orca spec 2026-10-23 §10.2.2, §11.1): a capped record stops at the last complete line under its cap,
// so a reader never sees half a JSON line; the transcript then says where it stopped, the evidence file says nothing (its
// strict decoders reject foreign lines). Writes are synchronous, so a SIGKILLed writer leaves every line it accepted.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function file() {
  const dir = await mkdtemp(join(tmpdir(), "capped-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  await writeFile(path, "", { mode: 0o600 });
  return path;
}

describe("capped line file", () => {
  it("keeps everything under the cap and has written it before write returns", async () => {
    const path = await file();
    const out = new CappedLineFile(path, 64);
    out.write(Buffer.from('{"a":1}\n{"b"'));
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"b"');
    out.write(Buffer.from(':2}\n'));
    out.close();
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(out.truncatedAt).toBeNull();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("cuts back to the last complete line under the cap and then writes one marker and nothing more", async () => {
    const path = await file();
    const out = new CappedLineFile(path, 20, (at) => `{"type":"ccloop.transcript-truncated","atBytes":${at}}\n`);
    out.write(Buffer.from('{"a":1}\n{"bb":2}\n{"ccc":3}\n'));
    out.write(Buffer.from('{"d":4}\n'));
    out.close();
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"bb":2}\n{"type":"ccloop.transcript-truncated","atBytes":17}\n');
    expect(out.truncatedAt).toBe(17);
  });

  it("removes a partial line already written when the next chunk passes the cap", async () => {
    const path = await file();
    const out = new CappedLineFile(path, 16);
    out.write(Buffer.from('{"a":1}\n{"b":'));
    out.write(Buffer.from('"long value"}\n'));
    out.close();
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n');
    expect(out.truncatedAt).toBe(8);
  });

  it("admits exactly the cap", async () => {
    const path = await file();
    const out = new CappedLineFile(path, 8);
    out.write(Buffer.from('{"a":1}\n'));
    out.close();
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n');
    expect(out.truncatedAt).toBeNull();
  });
});

// Review I2/I3 (Orca session ffec7b28): a write error stops the record for good (a later chunk must not land after a gap at
// a stale offset), and the record writes at its own offsets, never relying on O_APPEND.
describe("capped line file, failure and offsets", () => {
  it("stops recording after a write error and never writes again", async () => {
    const path = await file();
    const out = new CappedLineFile(path, 1024);
    out.write(Buffer.from('{"a":1}\n'));
    const { closeSync } = await import("node:fs");
    closeSync((out as unknown as { fd: number }).fd); // the descriptor goes bad underneath
    expect(() => out.write(Buffer.from('{"b":2}\n'))).toThrow();
    // A descriptor number reused by another open file must never be written through again.
    const { openSync, readFileSync } = await import("node:fs");
    const other = join(path + ".other");
    await writeFile(other, "", { mode: 0o600 });
    const reused = openSync(other, "r+");
    try {
      expect(() => out.write(Buffer.from('{"c":3}\n'))).not.toThrow();
      expect(readFileSync(other, "utf8")).toBe("");
    } finally { closeSync(reused); }
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n');
  });

  it("writes at its own offset even when the file is opened by others in append mode", async () => {
    const path = await file();
    await writeFile(path, '{"pre":0}\n', { mode: 0o600 });
    const out = new CappedLineFile(path, 1024);
    out.write(Buffer.from('{"a":1}\n'));
    out.close();
    expect(await readFile(path, "utf8")).toBe('{"pre":0}\n{"a":1}\n');
  });
});
