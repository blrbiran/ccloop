// Memory in runs (Orca spec 2026-11-20-memory-in-runs-and-read-api-design.md §3): collect carries one top-level optional
// key `memory: { sha256, ids, tokens }` describing the current attempt's bundle -- present iff the envelope carried one,
// never null (a null would change every existing collect answer and trip Orca's strict collection schema). The text is
// deliberately not echoed: the envelope Orca stored already names the same hash. `features` announces `memory: "v1"` so
// Orca can start sending the key in lockstep.
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { runControlCommand } from "../../src/control/command.js";
import { resultFixture } from "./taskResultFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const TEXT = "## ccmem context\n- (decision) use the median helper\n";
const MEMORY = { format: "ccloop-memory-v1" as const, sha256: createHash("sha256").update(TEXT).digest("hex"), tokens: 12, ids: [1042, 1057], text: TEXT };

it("collect echoes sha256, ids and tokens only when the envelope carried memory", async () => {
  const f = await resultFixture(); roots.push(f.root);
  const keyed = await f.rpc("collect", { input: { ...f.input, work: { ...f.input.work, memory: MEMORY } }, afterSeq: 0 });
  expect(keyed.code, keyed.stderr).toBe(0);
  const collected = JSON.parse(keyed.stdout) as Record<string, unknown>;
  expect(collected.memory).toEqual({ sha256: MEMORY.sha256, ids: MEMORY.ids, tokens: MEMORY.tokens });
  expect(Object.hasOwn(collected.memory as object, "text")).toBe(false);
  expect(Object.hasOwn(collected.memory as object, "format")).toBe(false);

  const plain = await f.rpc("collect", { input: f.input, afterSeq: 0 });
  expect(plain.code, plain.stderr).toBe(0);
  expect(Object.hasOwn(JSON.parse(plain.stdout), "memory")).toBe(false);
}, 30_000);

it("features announces memory v1", async () => {
  const result = await runControlCommand(["features"], "{}");
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ memory: "v1" });
});