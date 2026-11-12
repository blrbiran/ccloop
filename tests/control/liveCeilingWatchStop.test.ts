import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Orca follow-up H (Part B, agentSelectionE2E C3): `createLiveCeilingWatch().stop()` called while the watch loop was in
 * the middle of its file read left the loop to arm one more unref'd 50 ms sleep that nothing woke. In the worker, nothing
 * else keeps the event loop alive at that point (onRunSettledBeforeLeaseRelease), so the process exited before the
 * candidate was persisted or the worker sealed: the run stayed `accepted` and a handoff request `collecting` for good.
 * Only a separate process shows it (vitest's own handles keep a test process alive), so the stop runs in a child that
 * holds nothing else, against the built module.
 */
const built = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/control/liveCeilingFile.js");

describe("the live ceiling watch stops in a process that holds nothing else (Orca follow-up H)", () => {
  it("stop() called while the first read is in flight resolves before the process can exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcw-stop-"));
    try {
      const script = join(dir, "stop.mjs");
      writeFileSync(script, [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const { createLiveCeilingWatch } = await import(${JSON.stringify(built)});`,
        `const source = ${JSON.stringify(dir)};`,
        `mkdirSync(join(source, "control"), { recursive: true, mode: 0o700 });`,
        `const ceiling = { protocol: 1, revision: 1, tokens: 100, cause: "group" };`,
        `writeFileSync(join(source, "control", "live-ceiling.json"), JSON.stringify(ceiling) + "\\n", { mode: 0o600 });`,
        // The loop's first read starts synchronously here and is still awaiting when stop() is called.
        `const watch = createLiveCeilingWatch(source, ceiling);`,
        `await watch.stop();`,
        `process.stdout.write("stopped\\n");`,
      ].join("\n"));
      // mutation: drop the `if (stopped) break;` before the sleep -> the child exits with nothing printed, red
      for (let i = 0; i < 5; i += 1) expect(execFileSync(process.execPath, [script], { encoding: "utf8" })).toBe("stopped\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
