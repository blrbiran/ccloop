import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import { FAKE_CODEX, codexInstallation, writeAgentsTable } from "./agentsFixture.js";

// Orca backlog #11(c) (2026-09-29; ccloop handoff §2 "descriptor 维度偏松", Orca handoff §9.1): a request-bound proof
// names its dimensions the way Orca's capabilitiesSchema accepts them -- a sorted, duplicate-free subset of the four
// budget dimensions. Every descriptor answers null today; the day one does not, a misspelt or unsorted dimension is
// refused here, by name, instead of printed for Orca to refuse the whole answer (and with it soft groups too).
async function tablePath(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccloop-dimensions-")));
  const { path } = await writeAgentsTable({
    codex: await codexInstallation({
      command: [process.execPath, FAKE_CODEX, "integration", join(root, "codex-marker")],
      sandbox: "workspace-write",
      budgetMode: "soft",
      timeoutMs: 1_000,
      killGraceMs: 100,
    }),
  }, root);
  return path;
}

const answer = (workDimensions: string[], handoffDimensions: string[]) => ({
  protocol: 3,
  selection: { agent: "codex", model: "fixture", contextWindow: "agent-default" },
  configHash: "a".repeat(64),
  timeoutMs: 1_000,
  killGraceMs: 0,
  singleCallExecution: null,
  capabilities: {
    usageObservation: "phase-end", budgetEnforcement: "bounded", contextObservation: "unavailable", handoffControl: "durable",
    handoffExecution: "mechanical-in-run-v1", contextWindowTokens: null,
    requestBoundProof: { scheme: "adapter-request-bound-v1", version: "1", workDimensions, handoffDimensions, evidenceKind: "proof" },
  },
});

describe("request-bound proof dimensions (Orca backlog #11(c))", () => {
  it("prints a proof whose dimensions are a sorted, unique subset of the four budget dimensions, and refuses any other", async () => {
    const path = await tablePath();
    const run = (value: unknown) => runControlCommand(["capabilities", "--agents", path], JSON.stringify({ agent: null }), { handle: async () => value });
    const accepted = await run(answer(["activeMs", "tokens"], ["activeMs"]));
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout).capabilities.requestBoundProof.workDimensions).toEqual(["activeMs", "tokens"]);
    expect((await run(answer([], []))).code).toBe(0);
    const refused: Array<[string[], string[]]> = [
      [["token"], []],               // not a budget dimension
      [[], ["wallclock"]],           // not a budget dimension, on the handoff side
      [["tokens", "activeMs"], []],  // unsorted
      [["tokens", "tokens"], []],    // duplicate
    ];
    for (const [work, handoff] of refused) {
      expect([work, handoff, await run(answer(work, handoff))]).toEqual([work, handoff, { code: 1, stdout: "", stderr: "control-response-invalid\n" }]);
    }
  });
});
