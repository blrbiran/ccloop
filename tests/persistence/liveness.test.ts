import { describe, expect, it } from "vitest";
import { classifyProcessLiveness } from "../../src/persistence/fileStore.js";

// A pid that is almost certainly not running. Asserted below rather than assumed, the same way
// tests/unlock/inspectLock.test.ts chooses and checks its own.
const DEAD_PID = 999999;

describe("classifyProcessLiveness", () => {
  it("answers dead only for ESRCH, and proves the pid really is gone first", () => {
    expect(() => process.kill(DEAD_PID, 0)).toThrow();

    expect(classifyProcessLiveness(DEAD_PID)).toEqual({ verdict: "dead" });
  });

  it("answers alive for this very process", () => {
    expect(classifyProcessLiveness(process.pid)).toEqual({ verdict: "alive" });
  });

  // pid 0 means "every process in the caller's process group" to kill(2), so the syscall can never
  // answer ESRCH for it. Reading its silence as "alive" is what strands a lock forever, which is
  // why this cell returns before the syscall is issued at all.
  it("answers unknown for pid 0 WITHOUT issuing the syscall, and names why", () => {
    const calls: number[] = [];
    const realKill = process.kill;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).kill = (pid: number, signal?: string | number) => {
      calls.push(pid);
      return realKill.call(process, pid, signal as never);
    };
    try {
      expect(classifyProcessLiveness(0)).toEqual({
        verdict: "unknown",
        reason: "pid 0 does not name a process that can be probed",
      });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).kill = realKill;
    }

    // The literal that matters: not "some syscall count", but zero calls for THIS pid.
    expect(calls).toEqual([]);
  });

  it("answers unknown with the errno for a pid too large to be one", () => {
    expect(classifyProcessLiveness(1e21)).toEqual({
      verdict: "unknown",
      reason: "ERR_INVALID_ARG_TYPE",
    });
  });
});
