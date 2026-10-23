import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Review I1 (Orca session ffec7b28): the call's two records are opened before the agent is spawned. A record that cannot be
// opened ends the call as io-error with no agent process (an agent nobody records would spend unseen), and the record that
// did open is closed, not leaked.
const opened: Array<{ path: string; closed: boolean }> = [];
vi.mock("../../src/runtime/streamLines.js", async (original) => {
  const real = await original<typeof import("../../src/runtime/streamLines.js")>();
  class FailingTranscript extends real.CappedLineFile {
    private readonly entry: { path: string; closed: boolean };
    constructor(path: string, cap: number, marker?: (at: number) => string) {
      if (path.endsWith("transcript.jsonl")) throw Object.assign(new Error("EMFILE: simulated"), { code: "EMFILE" });
      super(path, cap, marker);
      this.entry = { path, closed: false };
      opened.push(this.entry);
    }
    override close(): void { this.entry.closed = true; super.close(); }
  }
  return { ...real, CappedLineFile: FailingTranscript };
});
const { runCodexPhase } = await import("../../src/runtime/codex/runCodexPhase.js");
const { runOmpPhase } = await import("../../src/runtime/omp/runOmpPhase.js");
const { codexFixture } = await import("./codex/fixture.js");

const roots: string[] = [];
afterEach(async () => { opened.splice(0); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("a record that cannot be opened", () => {
  it("codex: io-error, no agent spawned, the events record closed", async () => {
    const f = await codexFixture("ok"); roots.push(f.dir);
    const outcome = await runCodexPhase(f.config as never, { phase: "plan", prompt: "p", context: f.context });
    expect(outcome.reason).toBe("io-error");
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(join(outcome.evidenceDir, "process.json"))).toBe(false);
    expect(opened.map((entry) => [entry.path.endsWith("events.jsonl"), entry.closed])).toEqual([[true, true]]);
  });

  it("omp: io-error, never started, no agent spawned, the events record closed", async () => {
    const f = await codexFixture(); roots.push(f.dir);
    const binary = join(f.dir, "omp"), started = join(f.dir, "started");
    await writeFile(binary, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(started)}, "1");\n`, { mode: 0o700 });
    const outcome = await runOmpPhase({ schema: "ccloop-agent-config-v1", kind: "omp",
      installation: { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/model-a", profile: null },
      selection: { agent: "omp", model: "gateway/model-a", contextWindow: "agent-default" } }, "plan", "prompt", f.context);
    expect(outcome).toMatchObject({ reason: "io-error", neverStarted: true });
    expect(existsSync(started)).toBe(false);
    expect(opened.map((entry) => [entry.path.endsWith("events.jsonl"), entry.closed])).toEqual([[true, true]]);
  });
});
