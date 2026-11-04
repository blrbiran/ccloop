// Task setup commands (spec 2026-11-04-task-setup-and-check-retry-design §4.5): saved-result recovery re-runs the
// checks on a saved result without the attempt's setup, so an accept in verify-saved-result mode for a contract that
// declares context.setupCommands is refused by name at the protocol layer.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlRequest, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { readSavedResultEligibility, readSavedResultSourceEligibility } from "../../src/control/savedResultRecovery.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const hash = "c".repeat(64);
const recovery = { packagePath: "/nowhere/package", packageHash: hash, admissionHash: hash,
  recoveryOf: { sourceRunId: "run-0", sourceAttempt: 1, capsuleHash: hash, snapshotHash: hash, normalizedExecutionHash: hash } };

async function recoveryEnvelope(setupCommands?: string[]): Promise<LoopStartEnvelope> {
  const { root, envelope } = await fixture(); roots.push(root);
  const { setupCommands: _drop, ...context } = envelope.work.contract.context as Record<string, unknown>;
  const contract = { ...envelope.work.contract, context: setupCommands === undefined ? context : { ...context, setupCommands } };
  return { ...envelope, protocol: 4 as const, mode: "verify-saved-result" as const, savedResultRecovery: recovery,
    work: { ...envelope.work, contract } } as LoopStartEnvelope;
}

describe("saved-result recovery of a contract with setup commands is refused", () => {
  it("verify-saved-result of a contract with setupCommands is refused by name", async () => {
    const envelope = await recoveryEnvelope(["npm ci"]);
    expect(() => parseControlRequest("accept", envelope)).toThrow("control-setup-recovery-unsupported");
  });

  it("the same envelope without setupCommands is not refused for that reason", async () => {
    const envelope = await recoveryEnvelope();
    let thrown: unknown;
    try { parseControlRequest("accept", envelope); } catch (error) { thrown = error; }
    expect(String(thrown)).not.toContain("control-setup-recovery-unsupported");
  });

  it("a normal accept (not recovery) of a contract with setupCommands is not refused", async () => {
    const { mode: _mode, savedResultRecovery: _r, protocol: _p, ...rest } = await recoveryEnvelope(["npm ci"]);
    const normal = { ...rest, protocol: 3 as const, mode: "run" as const } as unknown as LoopStartEnvelope;
    let thrown: unknown;
    try { parseControlRequest("accept", normal); } catch (error) { thrown = error; }
    expect(String(thrown)).not.toContain("control-setup-recovery-unsupported");
  });

  it("saved-result-eligibility answers unavailable by name for a contract with setupCommands", async () => {
    expect(await readSavedResultEligibility(await recoveryEnvelope(["npm ci"])))
      .toEqual({ status: "unavailable", reason: "control-setup-recovery-unsupported" });
  });

  it("saved-result-source-eligibility answers unavailable by name for a source with setupCommands", async () => {
    const source = await recoveryEnvelope(["npm ci"]);
    expect(await readSavedResultSourceEligibility({ source, sourceAttempt: 1, packagePath: "/nowhere/package", packageHash: hash }))
      .toEqual({ status: "unavailable", reason: "control-setup-recovery-unsupported" });
  });
});
