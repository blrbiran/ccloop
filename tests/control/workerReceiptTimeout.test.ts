// Tester #439: on a loaded machine a bare `node` child took 1735 ms to spawn and write its first receipt -- 87% of the
// 2000 ms the launcher waited. Nothing let a machine or a caller raise that, and Orca never could: ccloop's own
// `control accept` dispatch (command.ts acceptStart) passes no receiptTimeoutMs, so the default was the only value in
// production. CCLOOP_WORKER_RECEIPT_TIMEOUT_MS makes it settable without changing any existing behaviour: unset, the
// 2000 ms default stands.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchWorker, workerReceiptTimeoutMs } from "../../src/control/workerLauncher.js";
import { writeAccepted, readAccepted } from "../../src/control/store.js";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

/** A worker that writes its receipt only after `delayMs`, so the launcher's wait is what is under test. */
async function slowWorker(dir: string, delayMs: number): Promise<string> {
  const path = join(dir, "slow-worker.mjs");
  await writeFile(path, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    // launchWorker passes --source-dir / --execution-id / --nonce (workerLauncher.ts launchWorker).
    "const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];",
    "const sourceDir = arg('--source-dir');",
    "const nonce = arg('--nonce');",
    `await new Promise((r) => setTimeout(r, ${delayMs}));`,
    "const file = sourceDir + '/control/accepted.json';",
    "const record = JSON.parse(readFileSync(file, 'utf8'));",
    "writeFileSync(file, JSON.stringify({ ...record, launch: 'claimed', worker: { pid: process.pid, startedAt: new Date().toISOString(), nonce } }));"
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

describe("the worker receipt timeout is settable, and unset keeps 2000 ms (#439)", () => {
  it("reads CCLOOP_WORKER_RECEIPT_TIMEOUT_MS, and falls back to 2000 ms when it is unset or unusable", () => {
    const previous = process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS;
    disposers.push(() => { if (previous === undefined) delete process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS; else process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS = previous; });
    delete process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS;
    // mutation: return the env value without the fallback -> the first assertion red.
    expect(workerReceiptTimeoutMs()).toBe(2000);
    process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS = "15000";
    expect(workerReceiptTimeoutMs()).toBe(15000);
    // an unusable value must not shorten the wait to 0 (a silent never-claimed on every launch)
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS = bad;
      expect(workerReceiptTimeoutMs()).toBe(2000);
    }
  });

  it("waits long enough for a worker slower than the default only when the env raises it", async () => {
    const previous = process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS;
    disposers.push(() => { if (previous === undefined) delete process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS; else process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS = previous; });
    // writeAccepted canonicalises its root (paths.ts), so the source directory must be the real one: on macOS
    // mkdtemp hands back /var/... which is a link to /private/var/...
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ccloop-receipt-")));
    await mkdir(join(dir, "control"), { recursive: true, mode: 0o700 });
    const worker = await slowWorker(dir, 2600);
    const record = {
      protocol: 1 as const, envelopeHash: "a".repeat(64), executionId: `execution-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`,
      configHash: "b".repeat(64), generation: 1, acceptedAt: new Date().toISOString(), launch: "intended" as const, worker: null
    };
    await writeAccepted(dir, record);
    process.env.CCLOOP_WORKER_RECEIPT_TIMEOUT_MS = "6000";
    // No receiptTimeoutMs here on purpose: this must exercise the launcher's OWN default, which is what production
    // uses (command.ts acceptStart passes no binding value). Mutation: the launcher ignores the env and uses a plain
    // 2000 -> the record is marked unknown and this assertion is red.
    await launchWorker(record, { sourceDir: dir, workerCommand: [process.execPath, worker] });
    expect((await readAccepted(dir)).launch).toBe("claimed");
  }, 20_000);
});