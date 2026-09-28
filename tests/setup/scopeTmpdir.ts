import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Every test file gets a temp root of its own, and the root is removed when the file is done.
 *
 * Measured before this existed (2026-09-28, TMPDIR relocated to an empty directory): one full run
 * left 805 directories behind in $TMPDIR, from 35 test files, most of which never remove what they
 * `mkdtemp`. Fixing each call site would touch hundreds of lines of existing criteria; pointing
 * TMPDIR at a scoped root fixes them all, including any child process the file spawns, because
 * `os.tmpdir()` reads TMPDIR on every call and children inherit the environment.
 *
 * ⚠️ A child spawned with an env object that does not carry TMPDIR still writes to the outer temp
 * directory. `scripts/check-tmp-leak.mjs` is the guard that would show it.
 * ⚠️ Keep the prefix short: tsx puts its IPC socket at `$TMPDIR/tsx-<uid>/<pid>.pipe`, and macOS
 * caps a socket path at 104 bytes. A long TMPDIR was measured turning seven criteria red.
 */
const outer = process.env.TMPDIR;
const scoped = mkdtempSync(join(tmpdir(), "ccloop-tmp-"));
process.env.TMPDIR = scoped;

afterAll(() => {
  if (outer === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = outer;
  // Retries cover a child that is still writing while the file's own teardown has already returned.
  rmSync(scoped, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
