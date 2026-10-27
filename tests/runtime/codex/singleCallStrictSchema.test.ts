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

// Review of 2026-10-27 (Orca session 7753e97d): the fold must descend wherever the projection did. The projection closes
// an object inside a caller's nullable array (`anyOf: [array, null]`) and makes its optional key required-and-nullable, so
// the model answers null there; the fold followed `items` only at the same level and left that null for Orca to reject.
it("removes a projected null inside a caller-side nullable array of objects", () => {
  const item = { type: "object", additionalProperties: false, required: ["id"], properties: { id: str, note: str } };
  const schema = { type: "object", additionalProperties: false, required: ["list"], properties: { list: { anyOf: [{ type: "array", items: item }, { type: "null" }] } } };
  const wire = strictSingleCallSchema(schema);
  expect(strictErrors(wire)).toEqual([]);
  expect(stripOptionalNulls({ list: [{ id: "a", note: null }] }, schema)).toEqual({ list: [{ id: "a" }] });
  // The caller's own null for the nullable array is an answer and stays.
  expect(stripOptionalNulls({ list: null }, schema)).toEqual({ list: null });
});

it("removes a projected null inside a caller-side nullable object", () => {
  const inner = { type: "object", additionalProperties: false, required: ["a"], properties: { a: str, b: str } };
  const schema = { type: "object", additionalProperties: false, required: ["o"], properties: { o: { anyOf: [inner, { type: "null" }] } } };
  expect(stripOptionalNulls({ o: { a: "x", b: null } }, schema)).toEqual({ o: { a: "x" } });
});

// A deliberate null is an answer: an optional key whose own schema admits null -- by a caller-side `anyOf`, an `enum` or
// `const` naming null, or no constraint at all -- keeps it; dropping it would change what the caller was told.
it("keeps a null an optional key admits through anyOf, enum, const or an empty schema", () => {
  const schema = { type: "object", additionalProperties: false, required: [], properties: {
    viaAnyOf: { anyOf: [str, { type: "null" }] }, viaEnum: { enum: ["a", null] }, viaConst: { const: null }, any: {},
    notNull: { enum: ["a", "b"] }, typed: { type: "string", enum: ["a", null] },
  } };
  expect(stripOptionalNulls({ viaAnyOf: null, viaEnum: null, viaConst: null, any: null, notNull: null, typed: null }, schema))
    .toEqual({ viaAnyOf: null, viaEnum: null, viaConst: null, any: null });
});

// With two object (or two array) alternatives the fold could not tell which one the answer took, and folding by the wrong
// one drops keys the other admits; such a schema is refused before the spawn instead.
it("refuses an anyOf with two alternatives of the same container kind", () => {
  const a = { type: "object", additionalProperties: false, required: ["a"], properties: { a: str } };
  const b = { type: "object", additionalProperties: false, required: ["b"], properties: { b: str } };
  for (const [schema, path, reason] of [
    [{ type: "object", additionalProperties: false, required: ["x"], properties: { x: { anyOf: [a, b] } } }, "root.properties.x", "anyOf-several-objects"],
    [{ anyOf: [{ anyOf: [a, { type: "null" }] }, b] }, "root", "anyOf-several-objects"],
    [{ anyOf: [{ type: "array", items: a }, { type: "array", items: b }] }, "root", "anyOf-several-arrays"],
  ] as const) {
    try { strictSingleCallSchema(schema as Record<string, unknown>); throw new Error("expected a refusal"); }
    catch (error) { expect(error).toMatchObject({ code: "codex-single-call-schema-unsupported", path, reason }); }
  }
  expect(() => strictSingleCallSchema({ anyOf: [a, { type: "array", items: b }, { type: "null" }] })).not.toThrow();
});

// Shapes the projection would have passed through unclosed, or rewritten into a different contract, are refused by name.
it("refuses tuples, conditionals, dependents, an anyOf beside properties and a required key with no property", () => {
  const obj = { type: "object", additionalProperties: false, required: ["a"], properties: { a: str } };
  for (const [schema, path, reason] of [
    [{ type: "array", prefixItems: [obj] }, "root", "prefixItems"],
    [{ ...obj, if: { required: ["a"] }, then: obj }, "root", "if"],
    [{ ...obj, then: obj }, "root", "then"],
    [{ ...obj, else: obj }, "root", "else"],
    [{ ...obj, dependentSchemas: { a: obj } }, "root", "dependentSchemas"],
    [{ ...obj, unevaluatedProperties: false }, "root", "unevaluatedProperties"],
    [{ type: "object", properties: { a: str }, anyOf: [{ required: ["a"] }] }, "root", "anyOf-beside-properties"],
    [{ type: "object", anyOf: [obj] }, "root", "anyOf-beside-type-object"],
    [{ type: "object", additionalProperties: false, required: ["a", "ghost"], properties: { a: str } }, "root.required.ghost", "required-without-property"],
  ] as const) {
    try { strictSingleCallSchema(schema as Record<string, unknown>); throw new Error("expected a refusal"); }
    catch (error) { expect(error).toMatchObject({ code: "codex-single-call-schema-unsupported", path, reason }); }
  }
});
