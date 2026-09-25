import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter, CodexPhaseAborted } from "../../../src/runtime/codex/codexAdapter.js";
import { observedTurnUsage, parseCodexConfig, type CodexPhase } from "../../../src/runtime/codex/protocol.js";
import { runCodexPhase } from "../../../src/runtime/codex/runCodexPhase.js";
import { codexFixture } from "./fixture.js";

// Orca handoff delivery (2026-09-25), spec §13.1 C-3 option (i), controller ruling on plan row D-C3: a phase
// stopped by a handoff deadline reports the usage its codex stdout showed before the kill, and null — not 0,
// not a guess — when it showed none. Additive only (ccloop Rule 15).
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Fake codex in script mode for the fixture's task `codex-test`, sleeping 10 s in `phase`. */
async function delayed(phase: CodexPhase, usageBeforeDelay: boolean) {
  const f = await codexFixture("script");
  dirs.push(f.dir);
  const scriptPath = join(f.dir, "script.json");
  await writeFile(scriptPath, JSON.stringify({ "codex-test": { files: { "answer.txt": "42\n" }, delayMs: { [phase]: 10_000 }, usageBeforeDelay } }));
  f.config.command.push(scriptPath);
  return { ...f, config: parseCodexConfig(f.config) };
}

const prompts = {
  plan: "Plan one isolated L2 attempt for task codex-test.\n",
  execute: "Execute one isolated attempt for task codex-test.\n",
  verify: "Verify task codex-test.\n",
} as const;

/** Resolves once the running call's own evidence stdout shows a usage line. */
async function usageSeen(runDir: string, phase: CodexPhase): Promise<void> {
  const root = join(runDir, "codex", "1", phase);
  await expect.poll(async () => {
    try {
      const [call] = await readdir(root);
      return call === undefined ? "" : await readFile(join(root, call, "events.jsonl"), "utf8");
    } catch { return ""; }
  }, { timeout: 5_000 }).toContain('"turn.completed"');
}

describe("usage observed before a codex phase was aborted (Orca handoff delivery C-3)", () => {
  it("reads the last well-formed turn.completed usage, skipping torn and malformed rows", () => {
    const usage = (input: number, output: number) => JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, output_tokens: output } });
    expect(observedTurnUsage(`${usage(5, 1)}\n${usage(12, 3)}\n{"type":"turn.comp`)).toBe(15);
    expect(observedTurnUsage(`${usage(12, 3)}\n${usage(0, 0)}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: 3 } })}\n`)).toBe(15);
    expect(observedTurnUsage(`${JSON.stringify({ type: "item.completed" })}\nnot json\n`)).toBeNull();
    expect(observedTurnUsage("")).toBeNull();
  });

  it("returns the observed tokens on an aborted outcome after a usage line, and null before any", async () => {
    const seen = await delayed("execute", true);
    const abort = new AbortController();
    const pending = runCodexPhase(seen.config, { phase: "execute", prompt: prompts.execute, context: { ...seen.context, abortSignal: abort.signal } });
    await usageSeen(seen.runDir, "execute");
    abort.abort();
    const outcome = await pending;
    expect(outcome.reason).toBe("aborted");
    expect(outcome.final).toBeNull();
    expect(outcome.observedTokens).toBe(15);
    // Killed during the delay: the script's files were never written.
    await expect(readFile(join(seen.repo, "answer.txt"), "utf8")).resolves.toBe("0\n");

    const unseen = await delayed("execute", false);
    const abortEarly = new AbortController();
    const early = runCodexPhase(unseen.config, { phase: "execute", prompt: prompts.execute, context: { ...unseen.context, abortSignal: abortEarly.signal } });
    await expect.poll(async () => readFile(`${unseen.marker}.calls`, "utf8").catch(() => ""), { timeout: 5_000 }).toContain("execute");
    abortEarly.abort();
    const none = await early;
    expect(none.reason).toBe("aborted");
    expect(none.observedTokens).toBeNull();
  });

  it("carries the observation on CodexPhaseAborted for plan and verify, and for execute only when one exists", async () => {
    for (const phase of ["plan", "verify"] as const) {
      const f = await delayed(phase, true);
      const abort = new AbortController();
      const pending = new CodexAdapter(f.config)[phase]({ ...f.context, abortSignal: abort.signal, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } }).catch((error: unknown) => error);
      await usageSeen(f.runDir, phase);
      abort.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(CodexPhaseAborted);
      expect((error as CodexPhaseAborted).message).toMatch(/^codex-aborted: /);
      expect((error as CodexPhaseAborted).observedTokens).toBe(15);
    }
    const seen = await delayed("execute", true);
    const abort = new AbortController();
    const pending = new CodexAdapter(seen.config).execute({ ...seen.context, abortSignal: abort.signal, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } }).catch((error: unknown) => error);
    await usageSeen(seen.runDir, "execute");
    abort.abort();
    const thrown = await pending;
    expect(thrown).toBeInstanceOf(CodexPhaseAborted);
    expect((thrown as CodexPhaseAborted).observedTokens).toBe(15);

    // Nothing observed: execute keeps answering null (the pre-existing adapter criterion pins the pre-aborted case).
    const unseen = await delayed("execute", false);
    const abortEarly = new AbortController();
    const early = new CodexAdapter(unseen.config).execute({ ...unseen.context, abortSignal: abortEarly.signal, plan: { summary: "p", primaryTargetPaths: ["answer.txt"] } });
    await expect.poll(async () => readFile(`${unseen.marker}.calls`, "utf8").catch(() => ""), { timeout: 5_000 }).toContain("execute");
    abortEarly.abort();
    expect(await early).toBeNull();
  }, 20_000);
});
