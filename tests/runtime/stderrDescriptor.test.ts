import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Orca tester issue #397: stderr used `appendFileSync` per chunk -- open, write, close each time. The criterion counts
// the descriptor's lifetime instead of wall time: one open in append mode for the call, one close, and the bytes in the
// order the chunks arrived (the record is evidence, and a reordering would change what a reader reconstructs).
const fsCalls = vi.hoisted(() => ({ opens: [] as { path: string; flags: unknown; fd: number }[], closes: [] as number[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fsCalls.opens.push({ path: String(args[0]), flags: args[1], fd });
      return fd;
    },
    closeSync: (fd: number) => { fsCalls.closes.push(fd); return actual.closeSync(fd); },
  };
});

import { runCodexPhase } from "../../src/runtime/codex/runCodexPhase.js";
import type { AttemptContext } from "../../src/runtime/types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("stderr descriptor per call", () => {
  it("opens stderr.log once for the call and keeps the chunks in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stderr-descriptor-"));
    dirs.push(dir);
    const fake = join(dir, "fake.mjs");
    const chunks = 400;
    await writeFile(fake, `for await (const _ of process.stdin) {}
for (let i = 0; i < ${chunks}; i++) { if (!process.stderr.write(i + "\\n")) await new Promise((r) => process.stderr.once("drain", r)); }
const { writeFileSync } = await import("node:fs");
writeFileSync(process.argv[process.argv.indexOf("-o") + 1], JSON.stringify({ summary: "p", primaryTargetPaths: [] }));
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");
`, { mode: 0o700 });
    const context = { worktreePath: dir, runDir: join(dir, "run"), attempt: 1, state: { budgetSnapshot: { timeRemainingMs: 20_000 } } } as AttemptContext;
    const outcome = await runCodexPhase(
      { command: [process.execPath, fake], model: "fixture", budgetMode: "soft", sandbox: "read-only", timeoutMs: 20_000, killGraceMs: 50 },
      { phase: "plan", prompt: "p", context },
    );
    expect(outcome.reason).toBe("completed");
    const path = join(outcome.evidenceDir, "stderr.log");
    expect(await readFile(path, "utf8")).toBe(Array.from({ length: chunks }, (_, i) => `${i}\n`).join(""));
    const appends = fsCalls.opens.filter((call) => call.path === path && call.flags === "a");
    expect(appends).toHaveLength(1);
    expect(fsCalls.closes.filter((fd) => fd === appends[0]!.fd)).toHaveLength(1);
  }, 30_000);
});
