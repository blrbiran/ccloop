import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializedAgentConfigV1 } from "../../../src/agents/types.js";
import { ClaudeAgentAdapter } from "../../../src/runtime/claude/claudeAgentAdapter.js";

// Orca ruling 26 (Orca ledger 2026-09-27-single-call-estimate §3.21; session c85d2c4e, 2026-09-28): a prompt over the
// runner's 100 KiB argv limit reaches claude on stdin, because one argv string over 128 KiB cannot be spawned on Linux
// and argv as a whole over 1 MiB cannot be spawned on macOS either -- which is how this file shows the failure here: its
// 1.5 MiB prompt made the old runner fail to spawn. A prompt at the limit or under it stays the last argument, byte for
// byte what the paid runs used. The runner also reads its request as one UTF-8 stream now, so a non-ASCII prompt is not
// altered on the way in. These read what the fake claude actually received. Additive only (ccloop Rule 15).
const fakeCli = fileURLToPath(new URL("../../fixtures/fake-claude-cli.mjs", import.meta.url));
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const LIMIT = 100 * 1024;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function call(prompt: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-large-prompt-"))); dirs.push(dir);
  const cwd = join(dir, "cwd"), runDir = join(dir, "run"), marker = join(dir, "marker.json"), scriptPath = join(dir, "script.json");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(runDir, { mode: 0o700 });
  await writeFile(scriptPath, JSON.stringify({ "single-call": { output: { answer: "forty-two" } } }));
  const config: MaterializedAgentConfigV1 = {
    schema: "ccloop-agent-config-v1", kind: "claude",
    installation: { kind: "claude", command: [process.execPath, fakeCli, "script", marker, scriptPath], version: "9.9.9-fake", configDir: null, timeoutMs: 20_000, killGraceMs: 300 },
    selection: { agent: "claude", model: "claude-opus-5-5", contextWindow: "agent-default" },
  };
  const result = await new ClaudeAgentAdapter(config).singleCall({ prompt, responseSchema: SCHEMA, maxOutputTokens: 2048, cwd, runDir, timeoutMs: 20_000, onProcessRegistered: async () => {} });
  const received = JSON.parse(await readFile(marker, "utf8")) as { prompt: string; promptVia: string; args: string[] };
  return { result, received };
}

describe("a prompt too large for argv goes to claude on stdin (ruling 26)", () => {
  it("hands a 1.5 MiB prompt over whole on stdin, and not as an argument", async () => {
    const prompt = `Estimate the plan below.\n\n${"x".repeat(1536 * 1024)}`;
    const { result, received } = await call(prompt);
    expect(result).toMatchObject({ output: { answer: "forty-two" } });
    expect(received.promptVia).toBe("stdin");
    expect(received.prompt).toBe(prompt);
    expect(received.args.some((arg) => arg.length > LIMIT)).toBe(false);
  }, 30_000);

  it("hands a non-ASCII prompt over byte for byte, however the runner's stdin is chunked", async () => {
    // Three-byte characters after one ASCII byte, over many read chunks: a chunk boundary falls inside a character
    // (measured: the runner once decoded each chunk alone and this prompt reached the fake with U+FFFD in it).
    const prompt = `x${"估算计划".repeat(40_000)}`;
    const { received } = await call(prompt);
    expect(received.promptVia).toBe("stdin");
    expect(received.prompt.includes("\ufffd")).toBe(false);
    expect(received.prompt).toBe(prompt);
  }, 30_000);

  it("keeps a prompt of exactly the limit as the last argument, and one byte more goes to stdin", async () => {
    const at = "é".repeat(LIMIT / 2);
    expect(Buffer.byteLength(at, "utf8")).toBe(LIMIT);
    const kept = await call(at);
    expect(kept.received.promptVia).toBe("argv");
    expect(kept.received.args.at(-1)).toBe(at);
    const over = await call(`${at}x`);
    expect(over.received.promptVia).toBe("stdin");
    expect(over.received.prompt).toBe(`${at}x`);
  }, 30_000);
});
