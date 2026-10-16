import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §4.2): every test file, and every process it spawns, caches agent
 * catalogs under this file's scoped TMPDIR (scopeTmpdir.ts removes it), never in the person's ~/.cache.
 *
 * It also points CODEX_HOME at an empty dir under the same TMPDIR: a codex installation with no configDir reads
 * `$CODEX_HOME/config.toml` (else `$HOME/.codex/config.toml`) for `model_context_window`, so without this a criterion
 * would read the person's real ~/.codex and answer that window instead of the fake catalog's (measured 2026-10-16:
 * 1000000 instead of 272000). Orca Rule 17: no criterion reads or writes the person's own data.
 */
process.env.CCLOOP_CACHE_DIR = mkdtempSync(join(tmpdir(), "ccache-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "chome-"));
