import { describe, expect, it } from "vitest";
import { attachedSingleCallCause, singleCallCauseOf } from "../../src/runtime/failureCause.js";

// Orca spec 2026-11-06 quota probe §4 step 2: what a failed single call's record may carry as failureCause. Orca reads the
// cause to decide whether an installation's quota is back, so a value outside the vocabulary is never written (the record
// then carries no cause, as before), and the detail stays within ccloop's 512-byte head.
describe("the single-call cause a record carries", () => {
  it("is the classification's cause and detail, and nothing for an aborted call", () => {
    expect(singleCallCauseOf({ cause: "quota", workObserved: true, detail: "limit" })).toEqual({ singleCallCause: { cause: "quota", detail: "limit" } });
    expect(singleCallCauseOf(null)).toEqual({});
  });

  it("drops a cause outside the vocabulary, and bounds the detail", () => {
    expect(attachedSingleCallCause({ singleCallCause: { cause: "out-of-coffee", detail: null } })).toBeNull();
    expect(attachedSingleCallCause(new Error("x"))).toBeNull();
    const long = attachedSingleCallCause({ singleCallCause: { cause: "quota", detail: "é".repeat(400) } });
    expect(long?.cause).toBe("quota");
    expect(Buffer.byteLength(long!.detail!, "utf8")).toBeLessThanOrEqual(512);
  });
});
