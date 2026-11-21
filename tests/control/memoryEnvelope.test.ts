// Memory in runs (Orca spec 2026-11-20-memory-in-runs-and-read-api-design.md §3, and its Correction 2026-11-21): the
// optional envelope key `work.memory` travels on protocol 3 and protocol 4. Most ordinary runs are protocol 3, so a
// protocol-4-only key would silently mean "some runs have memory and some do not". Without the key an envelope parses to
// its own bytes (Orca and ccloop agree on the envelope by hash, and a stored envelope is re-sent unchanged). ccloop
// recomputes the sha256 over `text` rather than trusting the producer, and a text over 8192 UTF-8 bytes is refused here
// as defence in depth (Orca drops an oversized bundle before sending; its own refusal would block the run).
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, parseControlRequest } from "../../src/control/protocol.js";
import { fixture } from "./optionalFixture.js";
import { resultFixture } from "./taskResultFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const TEXT = "## ccmem context\n- (decision) use the existing median helper\n- 中文\n";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const MEMORY = { format: "ccloop-memory-v1", sha256: sha256(TEXT), tokens: 12, ids: [1042, 1057], text: TEXT };

describe("work.memory on the start envelope", () => {
  it("absent: parses without the key and keeps the envelope's own bytes, on both protocols", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const parsed = parseControlRequest("accept", envelope) as { work: object };
    expect(Object.hasOwn(parsed.work, "memory")).toBe(false);
    expect(canonicalJson(parsed)).toBe(canonicalJson(envelope));
    const v4 = { ...envelope, protocol: 4 };
    expect(Object.hasOwn((parseControlRequest("accept", v4) as { work: object }).work, "memory")).toBe(false);
    expect(canonicalJson(parseControlRequest("accept", v4))).toBe(canonicalJson(v4));
  });

  it("present: accepted on protocol 3 and protocol 4 and kept as sent", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const v3 = { ...envelope, work: { ...envelope.work, memory: MEMORY } };
    expect(parseControlRequest("accept", v3)).toEqual(v3);
    const v4 = { ...v3, protocol: 4 };
    expect(parseControlRequest("accept", v4)).toEqual(v4);
    expect(parseControlRequest("collect", { input: v3, afterSeq: 0 })).toEqual({ input: v3, afterSeq: 0 });
  });

  it("is refused beside mode verify-saved-result, which builds no prompt", async () => {
    const f = await resultFixture(); roots.push(f.root);
    const recovery = { ...f.input, protocol: 4, mode: "verify-saved-result", savedResultRecovery: { packagePath: f.sourceDir + "/input/recovery", packageHash: "a".repeat(64), admissionHash: "b".repeat(64), recoveryOf: { sourceRunId: "old-run", sourceAttempt: 1, capsuleHash: "c".repeat(64), snapshotHash: "d".repeat(64), normalizedExecutionHash: "e".repeat(64) } } };
    parseControlRequest("accept", recovery);
    expect(() => parseControlRequest("accept", { ...recovery, work: { ...recovery.work, memory: MEMORY } })).toThrow("control-request-invalid");
  });
});

describe("work.memory bounds", () => {
  it("refuses a sha256 that is not the hash of text", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const wrong = { ...MEMORY, sha256: "a".repeat(64) };
    expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: wrong } })).toThrow("control-request-invalid");
    // The same text and hash with an uppercase hex digest is not the lowercase wire form.
    expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: { ...MEMORY, sha256: MEMORY.sha256.toUpperCase() } } })).toThrow("control-request-invalid");
  });

  it("accepts 8192 UTF-8 bytes and refuses 8193; refuses empty text", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const atCapText = "é".repeat(4096); // 2 UTF-8 bytes each, exactly 8192
    const atCap = { ...MEMORY, text: atCapText, sha256: sha256(atCapText) };
    expect(parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: atCap } })).toEqual({ ...envelope, work: { ...envelope.work, memory: atCap } });
    const overText = `a${"é".repeat(4096)}`; // exactly 8193 bytes: one over the cap
    expect(Buffer.byteLength(overText, "utf8")).toBe(8193);
    const over = { ...MEMORY, text: overText, sha256: sha256(overText) };
    expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: over } })).toThrow("control-request-invalid");
    const empty = { ...MEMORY, text: "", sha256: sha256("") };
    expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: empty } })).toThrow("control-request-invalid");
  });

  it("refuses ids that are not positive integers, an empty id list, and more than 64 ids", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const refuse = (ids: unknown) => expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: { ...MEMORY, ids } } })).toThrow("control-request-invalid");
    refuse([]);
    refuse([0]);
    refuse([-1]);
    refuse([1.5]);
    refuse(["1042"]);
    refuse(Array.from({ length: 65 }, (_, index) => index + 1));
    const capIds = Array.from({ length: 64 }, (_, index) => index + 1);
    expect(parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory: { ...MEMORY, ids: capIds } } })).toBeTruthy();
  });

  it("refuses a tokens value that is not a positive integer, an unknown format, and extra keys", async () => {
    const { root, envelope } = await fixture(); roots.push(root);
    const refuse = (memory: unknown) => expect(() => parseControlRequest("accept", { ...envelope, work: { ...envelope.work, memory } })).toThrow("control-request-invalid");
    refuse({ ...MEMORY, tokens: 0 });
    refuse({ ...MEMORY, tokens: 1.5 });
    refuse({ ...MEMORY, format: "ccloop-memory-v2" });
    refuse({ ...MEMORY, extra: true });
    refuse(null);
  });
});