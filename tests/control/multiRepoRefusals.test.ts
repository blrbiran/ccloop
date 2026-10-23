// Multi-repo runs (Orca spec 2026-10-24-multi-dir-projects §11.7, §16.1 C11, §19.2 P6): continuation and saved-result
// recovery bundle or verify one repository, so a multi-repo envelope is refused by name at accept -- a non-null
// inputCheckpoint answers control-multi-repo-continuation-unsupported, the verify-saved-result mode
// control-multi-repo-recovery-unsupported -- and both eligibility methods answer ineligible with the recovery code.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlRequest, type LoopStartEnvelope } from "../../src/control/protocol.js";
import { readSavedResultEligibility, readSavedResultSourceEligibility } from "../../src/control/savedResultRecovery.js";
import { fixture } from "./optionalFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function multiEnvelope(): Promise<LoopStartEnvelope> {
  const { root, envelope } = await fixture(); roots.push(root);
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "ccloop-multi-refusal-"))); roots.push(elsewhere);
  await mkdir(join(elsewhere, "lib"));
  const contract = { ...envelope.work.contract, context: { ...envelope.work.contract.context, repoKey: "app",
    additionalRepos: [{ key: "lib", repoPath: join(elsewhere, "lib"), targetPaths: ["lib/**"] }] } };
  return { ...envelope, work: { ...envelope.work, contract, additionalRepos: [{ key: "lib", targetRepo: join(elsewhere, "target-lib"), base: "main" }] } };
}
const hash = "c".repeat(64);
const recovery = { packagePath: "/nowhere/package", packageHash: hash, admissionHash: hash,
  recoveryOf: { sourceRunId: "run-0", sourceAttempt: 1, capsuleHash: hash, snapshotHash: hash, normalizedExecutionHash: hash } };

describe("continuation and saved-result recovery refused for multi-repo envelopes (C11)", () => {
  it("accept with a non-null inputCheckpoint is control-multi-repo-continuation-unsupported", async () => {
    const envelope = await multiEnvelope();
    expect(parseControlRequest("accept", envelope)).toEqual(envelope);
    const continued = { ...envelope, inputCheckpoint: { predecessorRunId: "run-0", checkpointId: "checkpoint-1", checkpointHash: hash, bundlePath: join(envelope.work.sourceDir, "input", "checkpoint-1") } };
    expect(() => parseControlRequest("accept", continued)).toThrow("control-multi-repo-continuation-unsupported");
    // A single-repo continuation is accepted as before.
    const { additionalRepos: _work, ...work } = envelope.work;
    const { repoKey: _key, additionalRepos: _contract, ...context } = envelope.work.contract.context;
    const single = { ...continued, work: { ...work, contract: { ...envelope.work.contract, context } } };
    expect(parseControlRequest("accept", single)).toEqual(single);
  });

  it("accept in verify-saved-result mode is control-multi-repo-recovery-unsupported", async () => {
    const envelope = await multiEnvelope();
    const v4 = { ...envelope, protocol: 4 as const, mode: "verify-saved-result" as const, savedResultRecovery: recovery };
    expect(() => parseControlRequest("accept", v4)).toThrow("control-multi-repo-recovery-unsupported");
  });

  it("saved-result-eligibility and saved-result-source-eligibility answer ineligible with the recovery code", async () => {
    const envelope = await multiEnvelope();
    const v4 = { ...envelope, protocol: 4 as const, mode: "verify-saved-result" as const, savedResultRecovery: recovery } as LoopStartEnvelope;
    expect(await readSavedResultEligibility(v4)).toEqual({ status: "unavailable", reason: "control-multi-repo-recovery-unsupported" });
    expect(await readSavedResultSourceEligibility({ source: envelope, sourceAttempt: 1, packagePath: "/nowhere/package", packageHash: hash }))
      .toEqual({ status: "unavailable", reason: "control-multi-repo-recovery-unsupported" });
  });
});
