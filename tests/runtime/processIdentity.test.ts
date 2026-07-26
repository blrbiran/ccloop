import { describe, expect, it } from "vitest";
import { buildProcessInstanceId } from "../../src/runtime/processIdentity.js";

describe("buildProcessInstanceId", () => {
  it("is pid:<pid>:<processStartMs> and is stable within a process", () => {
    const id = buildProcessInstanceId();

    expect(id).toMatch(/^pid:\d+:\d+$/);
    expect(id.startsWith(`pid:${process.pid}:`)).toBe(true);
    expect(buildProcessInstanceId()).toBe(id);
  });

  // §5.1: the whole point of the third component. A recycled PID produces a DIFFERENT
  // identity, so a stale record can never be mistaken for "held by me". Compared only for
  // string equality, so the legacy `pid:<pid>` format also never matches.
  it("never equals the same pid with a different start time, nor the legacy format", () => {
    const id = buildProcessInstanceId();

    expect(id).not.toBe(`pid:${process.pid}`);
    expect(id).not.toBe(`pid:${process.pid}:0`);
  });
});
