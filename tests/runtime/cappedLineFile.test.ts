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
