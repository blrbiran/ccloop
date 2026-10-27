/**
 * Every-agent requirement chain (Orca spec 2026-10-15 §6.1): a single call brings its own JSON Schema, and the codex
 * provider accepts strict schemas only -- every object closed, every property in `required`, an optional property spelled
 * `anyOf: [schema, null]` (ccloop spec 2026-10-20 §4.1). A caller's schema that leaves a key out of `required` is refused
 * by the provider (`invalid_json_schema: schema.required is required to include every key in properties`, measured on the
 * O9 run of 2026-10-26), so the wire schema is projected here and the answer's nulls for those keys are removed again,
 * guided by the schema the caller made. The call's own schema -- its envelope, prompt hash and the answer it validates --
 * is unchanged.
 *
 * Only object nodes are rewritten; every other keyword passes through. A schema strict mode cannot express (a free-form
 * object, `oneOf`, `$ref`) is refused before the spawn instead of sent and refused by the provider after it.
 */
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
// Strict mode states objects only through `properties` and arrays only through `items`; these express shapes it has no
// equivalent for, or that the answer's fold below could not follow (tuples, conditionals, dependents).
const UNSUPPORTED = ["oneOf", "allOf", "not", "$ref", "$defs", "definitions", "patternProperties", "prefixItems", "if", "then", "else",
  "dependentSchemas", "dependentRequired", "dependencies", "unevaluatedProperties", "unevaluatedItems"] as const;
// Beside an `anyOf` these would state a second shape that neither the projection nor the fold follows; `anyOf` stands alone.
const BESIDE_ANY_OF = ["properties", "items", "required", "additionalProperties"] as const;
const typeIncludes = (schema: Record<string, unknown>, name: string) => schema.type === name || (Array.isArray(schema.type) && schema.type.includes(name));
const claimsObject = (schema: Record<string, unknown>) => record(schema.properties) || typeIncludes(schema, "object");
const claimsArray = (schema: Record<string, unknown>) => schema.items !== undefined || typeIncludes(schema, "array");
// An `anyOf`'s alternatives, nested `anyOf`s flattened: the projection and the fold read the same list.
const alternatives = (schema: Record<string, unknown>): Record<string, unknown>[] => Array.isArray(schema.anyOf)
  ? schema.anyOf.flatMap((part) => record(part) ? alternatives(part) : [])
  : [schema];

export class SingleCallSchemaUnsupported extends Error {
  readonly code = "codex-single-call-schema-unsupported";
  constructor(readonly path: string, readonly reason: string) {
    super(`codex-single-call-schema-unsupported:${path}:${reason}`);
    this.name = "SingleCallSchemaUnsupported";
  }
}

export function strictSingleCallSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return project(schema, "root");
}

function project(schema: Record<string, unknown>, path: string): Record<string, unknown> {
  for (const keyword of UNSUPPORTED) if (keyword in schema) throw new SingleCallSchemaUnsupported(path, keyword);
  if (Array.isArray(schema.anyOf)) {
    const beside = BESIDE_ANY_OF.find((keyword) => keyword in schema);
    if (beside !== undefined || typeIncludes(schema, "object")) throw new SingleCallSchemaUnsupported(path, `anyOf-beside-${beside ?? "type-object"}`);
    // The fold picks the one alternative of the answer's own kind; with two of a kind it could not tell which applied.
    const parts = alternatives(schema);
    if (parts.filter(claimsObject).length > 1) throw new SingleCallSchemaUnsupported(path, "anyOf-several-objects");
    if (parts.filter(claimsArray).length > 1) throw new SingleCallSchemaUnsupported(path, "anyOf-several-arrays");
    return { ...schema, anyOf: schema.anyOf.map((part, index) => record(part) ? project(part, `${path}.anyOf.${index}`) : part) };
  }
  const properties = record(schema.properties) ? schema.properties : undefined;
  if (!claimsObject(schema)) {
    if (schema.items !== undefined) {
      if (!record(schema.items)) throw new SingleCallSchemaUnsupported(`${path}.items`, "not-an-object");
      return { ...schema, items: project(schema.items, `${path}.items`) };
    }
    return schema;
  }
  // `properties` absent is expressible only when the object is closed: a closed empty object.
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new SingleCallSchemaUnsupported(path, "additional-properties");
  if (properties === undefined && schema.additionalProperties !== false) throw new SingleCallSchemaUnsupported(path, "free-form-object");
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  // The projection rewrites `required` from `properties`; a required key with no property would be dropped silently, and
  // the closed object would then forbid the very key the caller requires.
  for (const key of required) if (!Object.hasOwn(properties ?? {}, key)) throw new SingleCallSchemaUnsupported(`${path}.required.${key}`, "required-without-property");
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!record(value)) throw new SingleCallSchemaUnsupported(`${path}.properties.${key}`, "not-an-object");
    const child = project(value, `${path}.properties.${key}`);
    projected[key] = required.has(key) ? child : nullable(child);
  }
  return { ...schema, properties: projected, required: Object.keys(projected), additionalProperties: false };
}

// JSON Schema's own reading: every constraint present at this level must let null through (`{}` constrains nothing).
const admitsNull = (schema: unknown): boolean => record(schema)
  && (!("type" in schema) || typeIncludes(schema, "null"))
  && (!Array.isArray(schema.enum) || schema.enum.includes(null))
  && (!("const" in schema) || schema.const === null)
  && (!Array.isArray(schema.anyOf) || schema.anyOf.some(admitsNull));

/**
 * The answer's nulls for a property the call's schema did not require are removed: the projection made those keys
 * required-and-nullable, so a model answers `null` where the caller's contract is an absent key. An optional property
 * whose own schema admits null keeps it -- that null is an answer, not the projection's. The fold descends wherever the
 * projection did: through `items`, `properties` and every `anyOf` (into the one alternative of the value's own kind).
 */
export function stripOptionalNulls(value: unknown, schema: Record<string, unknown>): unknown {
  const parts = alternatives(schema);
  if (Array.isArray(value)) {
    const items = parts.find((part) => record(part.items))?.items as Record<string, unknown> | undefined;
    return items === undefined ? value : value.map((entry) => stripOptionalNulls(entry, items));
  }
  if (!record(value)) return value;
  const branch = parts.find((part) => record(part.properties));
  if (branch === undefined) return value;
  const properties = branch.properties as Record<string, unknown>;
  const required = new Set(Array.isArray(branch.required) ? branch.required.filter((key): key is string => typeof key === "string") : []);
  const stripped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && !required.has(key) && !admitsNull(properties[key])) continue;
    stripped[key] = record(properties[key]) ? stripOptionalNulls(child, properties[key] as Record<string, unknown>) : child;
  }
  return stripped;
}
