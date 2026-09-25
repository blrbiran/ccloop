import { createHash } from "node:crypto";
import { constants, readFileSync, realpathSync } from "node:fs";
import { accessSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const binary = process.env.ORCA_CCLOOP_BIN;
const tablePath = process.env.ORCA_AGENTS_TABLE;
if (!binary || !tablePath) {
  throw new Error("verify:control requires ORCA_CCLOOP_BIN and ORCA_AGENTS_TABLE");
}

// Agent selection (2026-09-26): the formal gate runs over an agents table, and refuses one in which ANY
// installation names something other than a test fixture CLI (fake codex or the CLI-level fake claude). Task 5 review
// fix M-c: the fixture must be what actually runs, i.e. this node running the fixture script, not a real CLI that
// merely carries a fixture-looking argument somewhere later in its argv.
const canonicalTablePath = realpathSync(tablePath);
const tableBytes = readFileSync(canonicalTablePath);
const table = JSON.parse(tableBytes.toString());
const installations =
  table !== null && typeof table === "object" && table.installations !== null && typeof table.installations === "object"
    ? Object.values(table.installations)
    : [];
if (
  table?.schema !== "ccloop-agents-table-v1" ||
  installations.length === 0 ||
  !installations.every(
    (installation) =>
      Array.isArray(installation?.command) &&
      installation.command[0] === process.execPath &&
      /(^|\/)fake-(codex|claude-cli)\.mjs$/.test(String(installation.command[1])),
  )
) {
  throw new Error("formal control verification refuses a non-fixture agents table");
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("npm", ["run", "build"]);
const expected = realpathSync(join(root, "dist", "cli.js"));
const actual = realpathSync(binary);
if (actual !== expected) throw new Error(`ORCA_CCLOOP_BIN must name this build: ${expected}`);
accessSync(actual, constants.X_OK);
if (!statSync(actual).isFile()) throw new Error("ORCA_CCLOOP_BIN is not a regular file");

process.stdout.write(`${JSON.stringify({
  binary: actual,
  agentsTable: canonicalTablePath,
  agentsTableSha256: createHash("sha256").update(tableBytes).digest("hex"),
})}\n`);

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
run(process.execPath, [
  vitest,
  "run",
  "tests/control",
  "tests/controller/codex.integration.test.ts",
  "tests/runtime/codex",
]);
