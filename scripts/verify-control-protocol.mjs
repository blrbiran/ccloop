import { createHash } from "node:crypto";
import { constants, readFileSync, realpathSync } from "node:fs";
import { accessSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const binary = process.env.ORCA_CCLOOP_BIN;
const configPath = process.env.ORCA_CCLOOP_ADAPTER_CONFIG;
if (!binary || !configPath) {
  throw new Error("verify:control requires ORCA_CCLOOP_BIN and ORCA_CCLOOP_ADAPTER_CONFIG");
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

const canonicalConfigPath = realpathSync(configPath);
const configBytes = readFileSync(canonicalConfigPath);
const config = JSON.parse(configBytes.toString());
if (
  config.model !== "fixture" ||
  !Array.isArray(config.command) ||
  !config.command.some((value) => String(value).endsWith("fake-codex.mjs"))
) {
  throw new Error("formal control verification refuses a non-fixture Codex config");
}
process.stdout.write(`${JSON.stringify({
  binary: actual,
  adapterConfig: canonicalConfigPath,
  adapterConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
})}\n`);

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
run(process.execPath, [
  vitest,
  "run",
  "tests/control",
  "tests/controller/codex.integration.test.ts",
  "tests/runtime/codex",
]);
