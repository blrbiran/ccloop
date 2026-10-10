import { describe, expect, it } from "vitest";
import { boundedTaskResult, normalizeTaskResult } from "../../src/runtime/taskResult.js";
const report = { schema: "task-result-v1", goal: "Goal", completedWork: [], conclusions: [], limitations: [], outputs: [] };
// Break: treating report-only invalidity as execution failure or accepting unbounded metadata violates the optional channel.
describe("bounded task-result-v1 interpretation", () => {
  it("distinguishes absent from invalid and available metadata", () => {
    expect(normalizeTaskResult(undefined)).toEqual({ status: "missing", report: null, reason: null, diagnostic: null });
    expect(normalizeTaskResult(report)).toEqual({ status: "available", report, reason: null, diagnostic: null });
    for (const value of [null, 0, {}, [], { ...report, taskId: "forged" }, { ...report, goal: " " }]) expect(normalizeTaskResult(value).status).toBe("invalid");
  });
  it("preserves explanatory text when an output path later proves unavailable", () => {
    const raw = { ...report, outputs: [{ path: "../unsafe", label: "Unavailable later" }] };
    expect(normalizeTaskResult(raw)).toMatchObject({ status: "available", report: raw });
  });
  it.each(["goal", "completedWork", "conclusions", "limitations", "outputs", "path", "label"])("enforces the %s schema bound", field => {
    const invalid = field === "goal" ? { ...report, goal: "x".repeat(4001) }
      : field === "path" || field === "label" ? { ...report, outputs: [{ path: "a", label: "a", [field]: "x".repeat(field === "path" ? 1025 : 257) }] }
      : { ...report, [field]: Array.from({ length: 33 }, () => field === "outputs" ? { path: "a", label: "a" } : "a") };
    expect(normalizeTaskResult(invalid).status).toBe("invalid");
  });
  it.each(["completedWork", "conclusions", "limitations"])("enforces text length inside %s", field => {
    expect(normalizeTaskResult({ ...report, [field]: ["x".repeat(4001)] }).status).toBe("invalid");
    expect(normalizeTaskResult({ ...report, [field]: ["x".repeat(4000)] }).status).toBe("available");
  });
  it("accepts individual maxima while enforcing total UTF-8 JSON size", () => {
    expect(normalizeTaskResult({ ...report, goal: "x".repeat(4000), outputs: [{ path: "x".repeat(1024), label: "x".repeat(256) }] }).status).toBe("available");
    expect(normalizeTaskResult({ ...report, completedWork: Array(32).fill("x") }).status).toBe("available");
    expect(normalizeTaskResult({ ...report, completedWork: Array(32).fill("中".repeat(1000)) }).reason).toBe("task-result-too-large");
    expect(Buffer.byteLength(JSON.stringify("x".repeat(65535)),"utf8")).toBe(65537);
    expect(normalizeTaskResult("x".repeat(65535)).reason).toBe("task-result-too-large");
    expect(boundedTaskResult("x".repeat(65534))).toBe("x".repeat(65534));
  });
  it("bounds deep, cyclic and non-JSON values without throwing or running accessors", () => {
    let deep: unknown = {}; for (let i=0;i<20000;i++) deep = { a: deep };
    const cycle: Record<string, unknown> = {}; cycle.a = cycle;
    const throwing = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("should not execute"); } });
    for (const value of [deep, cycle, throwing, 1n, Number.NaN, new Date(), { a: undefined }]) {
      expect(() => JSON.stringify(boundedTaskResult(value))).not.toThrow();
      expect(normalizeTaskResult(boundedTaskResult(value)).status).toBe("invalid");
      expect(Buffer.byteLength(JSON.stringify(boundedTaskResult(value)),"utf8")).toBeLessThan(20000);
    }
  });
  it("recognizes only a bounded valid diagnostic marker and caps raw diagnostics", () => {
    const marker = { schema: "ccloop-task-result-invalid-v1", reason: "task-result-too-deep", diagnostic: "raw" };
    expect(normalizeTaskResult(marker)).toEqual({ status: "invalid", report: null, reason: "task-result-too-deep", diagnostic: "raw" });
    for (const value of [{ ...marker, diagnostic: 0 }, { ...marker, reason: "x".repeat(257) }, { ...marker, diagnostic: "x".repeat(4097) }]) expect(normalizeTaskResult(value).reason).toBe("task-result-schema-invalid");
    const invalid = normalizeTaskResult("x".repeat(65535));
    expect(invalid.diagnostic!.length).toBeLessThanOrEqual(4096);
  });
});
