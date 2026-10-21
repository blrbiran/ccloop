// Spec 2026-10-21-prior-failures-start-input-design.md §2.1 (and its review round 1): `work.priorFailures` is optional on
// both loop work schemas; absent, the envelope parses and hashes exactly as before; present, every bound is a UTF-8
// byte bound; refused only next to `mode: "verify-saved-result"`, allowed next to an input checkpoint.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, parseControlRequest } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";
import { resultFixture } from "./taskResultFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const entry = { runId: "run-0", rejectCategory: "required-check-failed", failingCommand: "npm test", evidence: ["boom"] };

async function loopEnvelope() {
  const { root, envelope } = await fixture(); roots.push(root);
  return envelope;
}
const withPrior = <T extends { work: object }>(envelope: T, priorFailures: unknown): T => ({ ...envelope, work: { ...envelope.work, priorFailures } });
const accepts = (envelope: unknown) => parseControlRequest("accept", envelope);
const refuses = (envelope: unknown) => expect(() => parseControlRequest("accept", envelope)).toThrow("control-request-invalid");

describe("work.priorFailures on the start envelope", () => {
  it("absent: parses without adding the key, and the hash is the envelope's own", async () => {
    const envelope = await loopEnvelope();
    const parsed = accepts(envelope) as { work: object };
    expect(Object.keys(parsed.work)).not.toContain("priorFailures");
    expect(canonicalHash(parsed)).toBe(canonicalHash(envelope));
  });

  it("present: accepted on protocol 3 and 4, kept byte for byte (failureCause optional, nulls allowed)", async () => {
    const envelope = await loopEnvelope();
    const prior = [entry, { runId: "run-1", rejectCategory: "run-failed:stalled", failingCommand: null, evidence: null, failureCause: "stalled" }];
    expect(accepts(withPrior(envelope, prior))).toEqual(withPrior(envelope, prior));
    const v4 = withPrior({ ...envelope, protocol: 4 }, prior);
    expect(accepts(v4)).toEqual(v4);
  });

  it("refuses an empty list, more than 3 failures, more than 16 evidence entries, an unknown key and empty strings", async () => {
    const envelope = await loopEnvelope();
    refuses(withPrior(envelope, []));
    refuses(withPrior(envelope, [entry, entry, entry, entry]));
    accepts(withPrior(envelope, [entry, entry, entry]));
    refuses(withPrior(envelope, [{ ...entry, evidence: Array.from({ length: 17 }, () => "x") }]));
    accepts(withPrior(envelope, [{ ...entry, evidence: Array.from({ length: 16 }, () => "x") }]));
    refuses(withPrior(envelope, [{ ...entry, evidence: [] }]));
    refuses(withPrior(envelope, [{ ...entry, extra: 1 }]));
    refuses(withPrior(envelope, [{ ...entry, rejectCategory: "" }]));
    refuses(withPrior(envelope, [{ ...entry, failingCommand: "" }]));
    refuses(withPrior(envelope, [{ ...entry, evidence: [""] }]));
    refuses(withPrior(envelope, [{ ...entry, failureCause: "" }]));
    refuses(withPrior(envelope, [{ rejectCategory: "x", failingCommand: null, evidence: null }]));
  });

  it("bounds are UTF-8 bytes, not UTF-16 code units", async () => {
    const envelope = await loopEnvelope();
    const wide = "中".repeat(1366); // 4098 bytes, 1366 code units
    refuses(withPrior(envelope, [{ ...entry, evidence: [wide] }]));
    refuses(withPrior(envelope, [{ ...entry, failingCommand: wide }]));
    accepts(withPrior(envelope, [{ ...entry, evidence: ["中".repeat(1365)] }])); // 4095 bytes
    refuses(withPrior(envelope, [{ ...entry, rejectCategory: "é".repeat(101) }])); // 202 bytes, 101 code units
    accepts(withPrior(envelope, [{ ...entry, rejectCategory: "é".repeat(100) }]));
    refuses(withPrior(envelope, [{ ...entry, failureCause: "é".repeat(33) }])); // 66 bytes
    accepts(withPrior(envelope, [{ ...entry, failureCause: "é".repeat(32) }]));
  });

  it("allowed next to an input checkpoint; refused next to a saved-result recovery", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const checkpoint = { predecessorRunId: "run-0", checkpointId: "checkpoint-1", checkpointHash: "c".repeat(64), bundlePath: join(root, "input", "checkpoint-1") };
    accepts({ ...envelope, inputCheckpoint: checkpoint });
    accepts(withPrior({ ...envelope, inputCheckpoint: checkpoint }, [entry]));
    accepts(withPrior({ ...envelope, protocol: 4, inputCheckpoint: checkpoint }, [entry]));
    const f = await resultFixture(); roots.push(f.root);
    const recovery = { ...f.input, protocol: 4, mode: "verify-saved-result", savedResultRecovery: { packagePath: f.sourceDir + "/input/recovery", packageHash: "a".repeat(64), admissionHash: "b".repeat(64), recoveryOf: { sourceRunId: "old-run", sourceAttempt: 1, capsuleHash: "c".repeat(64), snapshotHash: "d".repeat(64), normalizedExecutionHash: "e".repeat(64) } } };
    accepts(recovery);
    refuses(withPrior(recovery, [entry]));
  });
});
