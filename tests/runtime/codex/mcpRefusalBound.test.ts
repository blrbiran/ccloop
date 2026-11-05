// Orca tester issue 125 (session 3cfc2e73, batch I5): a refusal for a missing MCP server list carries the probe's own error.
// The probe's text is already short today (a 400-byte stderr tail), so the 512-byte bound on what the refusal carries is
// checked here with a catalog read that answers a longer error, as a later probe change could. Both the single call's
// message and a phase's failureCause.detail stay within 512 bytes and cut on a character boundary.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationV1 } from "../../../src/agents/types.js";
import { runLoop } from "../../../src/controller/runLoop.js";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { parseCodexConfig } from "../../../src/runtime/codex/protocol.js";
import { codexFixture } from "./fixture.js";

const LONG_ERROR = `agent-catalog-unavailable: exit 1 · stage exit · stderr: ${"é".repeat(600)}`;
vi.mock("../../../src/agents/agentCatalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/agents/agentCatalog.js")>();
  return { ...original, readAgentCatalog: async (...args: Parameters<typeof original.readAgentCatalog>) => ({ ...(await original.readAgentCatalog(...args)), codexMcpServers: null, mcpError: LONG_ERROR }) };
});

async function world() {
  const f = await codexFixture("integration");
  const source = join(f.dir, "source-codex-home");
  await mkdir(source); await writeFile(join(source, "auth.json"), "{}"); await writeFile(join(source, "config.toml"), "");
  vi.stubEnv("CCLOOP_CACHE_DIR", await realpath(await mkdtemp(join(tmpdir(), "ccloop-mcp-bound-cache-"))));
  const installation: InstallationV1 = { kind: "codex", command: f.config.command as [string, ...string[]], version: "9.9.9-fake", configDir: source,
    timeoutMs: 10_000, killGraceMs: 50, sandbox: "workspace-write", budgetMode: "soft" };
  const adapter = new CodexAdapter(parseCodexConfig(f.config), { CODEX_HOME: source }, undefined, { installation, rateLimitDelaysMs: [10, 10, 10] });
  return { ...f, adapter };
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const bounded = (text: string) => {
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512);
  expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(500);
  expect(text).not.toContain("�");
};

afterEach(() => { vi.unstubAllEnvs(); });

it("a phase refusal's failureCause.detail is bounded to 512 bytes", async () => {
  const w = await world();
  const state = await runLoop(w.contract, w.runDir, w.adapter);
  expect(state.status).toBe("failed");
  const detail = state.failureCause?.detail ?? "";
  expect(detail.startsWith("codex-phase-isolation-no-mcp-list: agent-catalog-unavailable: exit 1 · stage exit · stderr: é")).toBe(true);
  bounded(detail);
}, 30_000);

it("a single call refusal carries at most 512 bytes of the probe's error", async () => {
  const w = await world();
  const cwd = join(w.runDir, "cwd"); await mkdir(cwd, { recursive: true, mode: 0o700 });
  const error = await failure(w.adapter.singleCall!({ prompt: "Estimate.", responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    maxOutputTokens: 4096, cwd, runDir: w.runDir, timeoutMs: 30_000 }));
  expect(error).toMatchObject({ code: "codex-single-call-unavailable", neverStarted: true });
  const message = (error as Error).message, prefix = "codex-single-call-unavailable: no MCP server list: ";
  expect(message.startsWith(`${prefix}agent-catalog-unavailable: exit 1 · stage exit · stderr: é`)).toBe(true);
  bounded(message.slice(prefix.length));
}, 30_000);
