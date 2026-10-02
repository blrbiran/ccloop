import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classifyOwnerProcess, OWNER_START_MARGIN_S, parseLstartUtc } from "../../src/ownership/ownerLiveness.js";

const rec = (id: string, lastAffirmedAt = "2026-10-02T04:00:00.000Z", leaseAffirmedAt: string | null = null) => ({
  currentProcessInstanceId: id,
  lastAffirmedAt,
  leaseAffirmedAt,
});
const START = Date.parse("2026-10-02T03:59:00.000Z");
const alive = () => ({ verdict: "alive" as const });

describe("classifyOwnerProcess (spec 4.1: dead only when the holder is certainly not the owner)", () => {
  it("legacy or malformed id => undetermined", async () => {
    expect((await classifyOwnerProcess(rec("pid:100"))).verdict).toBe("undetermined");
    expect((await classifyOwnerProcess(rec("pid:abc:1"))).verdict).toBe("undetermined");
  });

  it("ESRCH => dead", async () => {
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`), { liveness: () => ({ verdict: "dead" }) });
    expect(v.verdict).toBe("dead");
  });

  it("EPERM-like unknown => undetermined", async () => {
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`), { liveness: () => ({ verdict: "unknown", reason: "EPERM" }) });
    expect(v.verdict).toBe("undetermined");
  });

  it("alive, holder started before R => alive", async () => {
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`), { liveness: alive, readStart: async () => "Fri Oct  2 03:59:00 2026" });
    expect(v.verdict).toBe("alive");
  });

  it("alive, holder started after the last affirmation + margin => dead (pid recycled)", async () => {
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`, "2026-10-02T04:00:00.000Z", "2026-10-02T04:05:00.000Z"), {
      liveness: alive,
      readStart: async () => "Fri Oct  2 04:05:03 2026",
    });
    expect(v.verdict).toBe("dead");
  });

  it("alive, holder started before the lease affirmation => alive (the lease moves R later)", async () => {
    // startMs and lastAffirmedAt are earlier than the holder's start; only leaseAffirmedAt is later.
    // Without the lease in R the holder would look newer than the owner and be wrongly called dead.
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`, "2026-10-02T04:00:00.000Z", "2026-10-02T04:10:00.000Z"), {
      liveness: alive,
      readStart: async () => "Fri Oct  2 04:05:00 2026",
    });
    expect(v.verdict).toBe("alive");
  });

  it("alive, holder started within the margin of R => alive", async () => {
    expect(OWNER_START_MARGIN_S).toBe(2);
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`, "2026-10-02T04:00:00.000Z", "2026-10-02T04:05:00.000Z"), {
      liveness: alive,
      readStart: async () => "Fri Oct  2 04:05:02 2026",
    });
    expect(v.verdict).toBe("alive");
  });

  it("ps unavailable => undetermined (Review Focus 2)", async () => {
    const v = await classifyOwnerProcess(rec(`pid:7:${START}`), { liveness: alive, readStart: async () => null });
    expect(v.verdict).toBe("undetermined");
  });

  it("parseLstartUtc reads UTC whatever TZ the process has", () => {
    const saved = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(parseLstartUtc("Fri Oct  2 04:05:03 2026")).toBe(Date.UTC(2026, 9, 2, 4, 5, 3) / 1000);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("parseLstartUtc rejects text that is not an lstart", () => {
    expect(parseLstartUtc("garbage")).toBeNull();
  });

  it("real process: this test process is alive and classified alive", async () => {
    const v = await classifyOwnerProcess(rec(`pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`, new Date().toISOString()));
    expect(v.verdict).toBe("alive");
  });

  it("real process: a dead child is dead", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    const v = await classifyOwnerProcess(rec(`pid:${child.pid}:${Date.now()}`, new Date().toISOString()));
    // pid reuse within milliseconds is negligible; either way it must not throw.
    expect(["dead", "alive"]).toContain(v.verdict);
    expect(v.verdict).toBe("dead");
  });
});
