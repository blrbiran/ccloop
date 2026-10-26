import { expect, it } from "vitest";
import { SingleCallSchemaUnsupported, strictSingleCallSchema, stripOptionalNulls } from "../../../src/runtime/codex/strictSingleCall.js";

// Every-agent requirement chain (Orca spec 2026-10-15 §6.1): Orca's hand-written single-call schemas leave keys out of
// `required`, and the codex provider refuses such a schema (measured on the O9 run of 2026-10-26, `invalid_json_schema`).
// The wire schema is projected to the strict dialect and the answer's nulls for those keys are removed again.
const str = { type: "string" };
const strings = { type: "array", items: str };
// N1 spec §7.2's clarify schema, the one the paid run refused: slug, title and classification are optional.
const CLARIFY = {
  type: "object", additionalProperties: false,
  required: ["statement", "acceptanceCriteria", "questions", "frontierEmpty", "openBranches", "glossary", "adrs"],
  properties: {
    slug: str, title: str, statement: str,
    acceptanceCriteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: str, text: str } } },
    questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "question"], properties: { key: str, question: str, dependsOn: strings } } },
    frontierEmpty: { type: "boolean" }, openBranches: strings,
    glossary: { type: "array", items: { type: "object", additionalProperties: false, required: ["term"], properties: { term: str, definition: str } } },
    adrs: strings,
    classification: { type: "object", additionalProperties: false, required: ["scope"], properties: { scope: str, clarity: str } },
  },
};
const strictErrors = (value: unknown, path = "root", found: string[] = []): string[] => {
  if (value === null || typeof value !== "object") return found;
  const node = value as Record<string, unknown>;
  if (node.type === "object") {
    const properties = node.properties as Record<string, unknown>;
    if (node.additionalProperties !== false) found.push(`${path}: open`);
    const required = [...(node.required as string[] ?? [])].sort(), keys = Object.keys(properties ?? {}).sort();
    if (JSON.stringify(required) !== JSON.stringify(keys)) found.push(`${path}: required ${JSON.stringify(required)} != ${JSON.stringify(keys)}`);
  }
  for (const [i, part] of ((node.anyOf as unknown[]) ?? []).entries()) strictErrors(part, `${path}.anyOf.${i}`, found);
  for (const [key, part] of Object.entries((node.properties as Record<string, unknown>) ?? {})) strictErrors(part, `${path}.${key}`, found);
  if (node.items !== undefined) strictErrors(node.items, `${path}.items`, found);
  return found;
};

it("projects a schema with optional keys into the strict dialect the provider accepts", () => {
  const wire = strictSingleCallSchema(CLARIFY as Record<string, unknown>);
  expect(strictErrors(wire)).toEqual([]);
  const properties = wire.properties as Record<string, { anyOf?: unknown[]; type?: string }>;
  expect(properties.title.anyOf).toEqual([str, { type: "null" }]);
  expect(properties.classification.anyOf?.[1]).toEqual({ type: "null" });
  // A required key is untouched, and a nested optional key is wrapped at its own level.
  expect(properties.statement).toEqual(str);
  const questions = (properties.questions as { items: { properties: Record<string, { anyOf?: unknown[] }>; required: string[] } }).items;
  expect(questions.required).toEqual(["key", "question", "dependsOn"]);
  expect(questions.properties.dependsOn.anyOf).toEqual([strings, { type: "null" }]);
});

it("leaves an already-strict schema byte-identical", () => {
  const strict = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: str } };
  expect(strictSingleCallSchema(strict)).toEqual(strict);
});

it("projects nullable `type` arrays and preserves every other keyword", () => {
  const wire = strictSingleCallSchema({ type: "object", additionalProperties: false, required: ["a"], properties: {
    a: { type: ["string", "null"] }, b: { anyOf: [{ type: "object", additionalProperties: false, required: ["c"], properties: { c: str } }, { type: "null" }] },
  } });
  expect(strictErrors(wire)).toEqual([]);
  expect((wire.properties as Record<string, { anyOf?: unknown[] }>).b.anyOf?.[1]).toEqual({ type: "null" });
});

// Orca's flow ask is a record with template-named keys; strict mode has no way to say it. Refusing it before the spawn
// names the shape instead of letting the provider answer 400 (`invalid_json_schema`) after the call began.
it("refuses a free-form record before anything is spawned", () => {
  const ask = { type: "object", additionalProperties: false, required: ["candidates"], properties: {
    candidates: { type: "object", additionalProperties: { type: "object", additionalProperties: false, required: ["items"], properties: { items: strings } } },
  } };
  expect(() => strictSingleCallSchema(ask)).toThrow(SingleCallSchemaUnsupported);
  try { strictSingleCallSchema(ask); } catch (error) {
    expect(error).toMatchObject({ code: "codex-single-call-schema-unsupported", path: "root.properties.candidates", reason: "additional-properties" });
  }
});

it("refuses shapes strict mode cannot express, by keyword and by path", () => {
  for (const [schema, path, reason] of [
    [{ type: "object", required: [], properties: {} , oneOf: [] }, "root", "oneOf"],
    [{ type: "object" }, "root", "free-form-object"],
    [{ type: "object", additionalProperties: false, required: ["a"], properties: { a: { $ref: "#/a" } } }, "root.properties.a", "$ref"],
    [{ type: "array", items: "not-a-schema" }, "root.items", "not-an-object"],
  ] as const) {
    try { strictSingleCallSchema(schema as Record<string, unknown>); throw new Error("expected a refusal"); }
    catch (error) { expect(error).toMatchObject({ code: "codex-single-call-schema-unsupported", path, reason }); }
  }
  expect(() => strictSingleCallSchema({ type: "object", additionalProperties: false, required: [], properties: {} })).not.toThrow();
});

it("removes the null an optional key was projected into, and keeps every other null", () => {
  const answer = { slug: null, title: null, statement: "x", acceptanceCriteria: [{ id: "AC1", text: "t" }], questions: [{ key: "q", question: "?", dependsOn: null }],
    frontierEmpty: true, openBranches: [], glossary: [], adrs: [], classification: { scope: null, clarity: "clear" } };
  expect(stripOptionalNulls(answer, CLARIFY as Record<string, unknown>)).toEqual({
    statement: "x", acceptanceCriteria: [{ id: "AC1", text: "t" }], questions: [{ key: "q", question: "?" }],
    frontierEmpty: true, openBranches: [], glossary: [], adrs: [], classification: { scope: null, clarity: "clear" },
  });
});

it("keeps a null an optional property's own schema admits", () => {
  const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: str, b: { type: ["string", "null"] } } };
  expect(stripOptionalNulls({ a: "x", b: null }, schema)).toEqual({ a: "x", b: null });
});
