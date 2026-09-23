// L3 — tests for the `ls` lock column's attachment layer. See
// docs/superpowers/specs/2026-09-23-ls-lock-visibility-design.md §3.1, task-8-brief.md.

import { describe, expect, it } from "vitest";
import { attachLockInspections } from "../../src/unlock/lockRows.js";
import type { LockInspection } from "../../src/unlock/inspectLock.js";
import type { ScanRow } from "../../src/registry/scanRuns.js";

const runRow: ScanRow = {
  kind: "run",
  path: "/runs/run-1",
  observedAt: "2026-09-23T00:00:00.000Z",
  files: [],
};

const issueRow: ScanRow = { kind: "directory_unreadable", path: "/runs/bad", detail: "EACCES" };

describe("attachLockInspections", () => {
  it("attaches an inspection to every run row, including one with no lock on disk", async () => {
    const attached = await attachLockInspections([runRow], {
      inspect: async () => ({ state: "absent" }) as LockInspection,
    });

    // The literal, not the shape: a row whose `lock` key is missing reads as "never probed", which
    // is a different fact from "probed, and there is nothing there".
    expect(attached).toEqual([{ ...runRow, lock: { state: "absent" } }]);
  });

  it("never probes an issue row, and passes it through byte for byte", async () => {
    const probed: string[] = [];
    const attached = await attachLockInspections([issueRow, runRow], {
      inspect: async (runDir: string) => {
        probed.push(runDir);
        return { state: "absent" } as LockInspection;
      },
    });

    expect(probed).toEqual(["/runs/run-1"]);
    expect(attached[0]).toEqual(issueRow);
  });

  it("probes each run row at its own path, in scan order", async () => {
    const second: ScanRow = { ...runRow, path: "/runs/run-2" } as ScanRow;
    const probed: string[] = [];
    await attachLockInspections([runRow, issueRow, second], {
      inspect: async (runDir: string) => {
        probed.push(runDir);
        return { state: "absent" } as LockInspection;
      },
    });

    expect(probed).toEqual(["/runs/run-1", "/runs/run-2"]);
  });
});
