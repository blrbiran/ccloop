import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexAdapter } from "../../../src/runtime/codex/codexAdapter.js";
import { codexFixture } from "./fixture.js";

function expectStrictObjects(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.type === "object") {
    const properties = node.properties as Record<string, unknown>;
    expect(node.additionalProperties, path).toBe(false);
    expect([...node.required as string[]].sort(), path).toEqual(Object.keys(properties).sort());
  }
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((part, i) => expectStrictObjects(part, `${path}.anyOf.${i}`));
  if (node.properties && typeof node.properties === "object") {
    for (const [key, part] of Object.entries(node.properties)) expectStrictObjects(part, `${path}.${key}`);
  }
  if (node.items) expectStrictObjects(node.items, `${path}.items`);
}

it("sends provider-strict execute alternatives with or without a complete report", async () => {
  const fixture = await codexFixture("ok");
  try {
    await new CodexAdapter(fixture.config).execute(fixture.context);
    const [call] = await readdir(join(fixture.runDir, "codex", "1", "execute"));
    const schema = JSON.parse(await readFile(join(fixture.runDir, "codex", "1", "execute", call!, "schema.json"), "utf8"));
    expectStrictObjects(schema, "root");
    const phases = schema.properties.result.anyOf as Array<{ anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> }>;
    expect(phases).toHaveLength(2);
    const alternatives = phases.flatMap((phase) => phase.anyOf);
    expect(alternatives.filter((part) => "taskResult" in part.properties)).toHaveLength(2);
    expect(alternatives.filter((part) => !("taskResult" in part.properties))).toHaveLength(2);
    for (const part of alternatives.filter((each) => "taskResult" in each.properties)) {
      expect(part.required).toContain("taskResult");
      const report = part.properties.taskResult as { properties: Record<string, unknown> };
      expect(Object.keys(report.properties)).toEqual(["schema", "goal", "completedWork", "conclusions", "outputs", "limitations"]);
    }
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

// Reported decisions and debug (ccloop spec 2026-10-20 §4.1, §7 criterion 5): the provider refuses an answer whose schema has
// an optional or loose node, so both fields are required in all four alternatives and nullable through `anyOf` -- which the
// checker above walks member by member, where `type: [..,"null"]` would have hidden a loose node from it.
it("sends decisions and debug required and nullable in every one of the 2x2 strict alternatives", async () => {
  const fixture = await codexFixture("ok");
  try {
    await new CodexAdapter(fixture.config).execute(fixture.context);
    const [call] = await readdir(join(fixture.runDir, "codex", "1", "execute"));
    const schema = JSON.parse(await readFile(join(fixture.runDir, "codex", "1", "execute", call!, "schema.json"), "utf8"));
    expectStrictObjects(schema, "root");
    const phases = schema.properties.result.anyOf as Array<{ anyOf: Array<{ properties: Record<string, any>; required: string[] }> }>;
    expect(phases.map((phase) => phase.anyOf.length)).toEqual([2, 2]);
    for (const part of phases.flatMap((phase) => phase.anyOf)) {
      expect(part.required).toEqual(expect.arrayContaining(["decisions", "debug"]));
      const [decisions, noDecisions] = part.properties.decisions.anyOf;
      expect(noDecisions).toEqual({ type: "null" });
      expect(decisions.type).toBe("array");
      expect(Object.keys(decisions.items.properties)).toEqual(["question", "chose", "alternatives", "because", "undo", "scope", "kind", "importance"]);
      expect(Object.keys(decisions.items.properties.undo.properties)).toEqual(["how", "cost", "blast_radius"]);
      expect(Object.keys(decisions.items.properties.alternatives.items.properties)).toEqual(["option", "why_not"]);
      const [debug, noDebug] = part.properties.debug.anyOf;
      expect(noDebug).toEqual({ type: "null" });
      expect(Object.keys(debug.properties)).toEqual(["choseInstead", "reproTests", "reproCommand", "reproduction", "reproductionReason"]);
      for (const member of Object.values(debug.properties) as Array<{ anyOf: unknown[] }>) expect(member.anyOf.at(-1)).toEqual({ type: "null" });
    }
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
