import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §4.2): every test file, and every process it spawns, caches agent
 * catalogs under this file's scoped TMPDIR (scopeTmpdir.ts removes it), never in the person's ~/.cache.
 */
process.env.CCLOOP_CACHE_DIR = mkdtempSync(join(tmpdir(), "ccache-"));
