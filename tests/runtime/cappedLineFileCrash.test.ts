import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Review I3 (Orca session ffec7b28): at the cap the marker is written at the cut offset before the file is truncated, so a
// process that dies between the two leaves the marker at the cut, never a cut transcript that does not say it was cut.
const failTruncate = { on: false };
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, ftruncateSync: (...args: Parameters<typeof fs.ftruncateSync>) => { if (failTruncate.on) throw new Error("simulated crash at truncate"); return fs.ftruncateSync(...args); } };
});
const { CappedLineFile } = await import("../../src/runtime/streamLines.js");

const dirs: string[] = [];
afterEach(async () => { failTruncate.on = false; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("capped line file at the cap", () => {
  it("has the marker at the cut before it truncates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capped-crash-")); dirs.push(dir);
    const path = join(dir, "t.jsonl");
    await writeFile(path, "", { mode: 0o600 });
    const marker = (at: number) => `{"type":"ccloop.transcript-truncated","atBytes":${at}}\n`;
    const out = new CappedLineFile(path, 20, marker);
    out.write(Buffer.from('{"a":1}\n{"bb":2'));
    failTruncate.on = true;
    expect(() => out.write(Buffer.from('2}\n{"ccc":3}\n'))).toThrow("simulated crash at truncate");
    const text = await readFile(path, "utf8");
    expect(text.slice(0, 18 + marker(18).length)).toBe('{"a":1}\n{"bb":22}\n' + marker(18));
  });
});
