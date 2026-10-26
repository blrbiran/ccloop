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
// Strict mode states objects only through `properties`; these express shapes it has no equivalent for.
const UNSUPPORTED = ["oneOf", "allOf", "not", "$ref", "$defs", "definitions", "patternProperties"] as const;

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
    return { ...schema, anyOf: schema.anyOf.map((part, index) => record(part) ? project(part, `${path}.anyOf.${index}`) : part) };
  }
  const properties = record(schema.properties) ? schema.properties : undefined;
  const claimsObject = properties !== undefined || schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
  if (!claimsObject) {
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
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!record(value)) throw new SingleCallSchemaUnsupported(`${path}.properties.${key}`, "not-an-object");
    const child = project(value, `${path}.properties.${key}`);
    projected[key] = required.has(key) ? child : nullable(child);
  }
  return { ...schema, properties: projected, required: Object.keys(projected), additionalProperties: false };
}

const admitsNull = (schema: unknown): boolean => record(schema)
  && (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || (Array.isArray(schema.anyOf) && schema.anyOf.some(admitsNull)));

/**
 * The answer's nulls for a property the call's schema did not require are removed: the projection made those keys
 * required-and-nullable, so a model answers `null` where the caller's contract is an absent key. An optional property
 * whose own schema admits null keeps it -- that null is an answer, not the projection's.
 */
export function stripOptionalNulls(value: unknown, schema: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return record(schema.items) ? value.map((entry) => stripOptionalNulls(entry, schema.items as Record<string, unknown>)) : value;
  if (!record(value)) return value;
  const properties = record(schema.properties) ? schema.properties : undefined;
  if (properties === undefined) {
    const branch = Array.isArray(schema.anyOf) ? schema.anyOf.find((part) => record(part) && record(part.properties)) : undefined;
    return branch === undefined ? value : stripOptionalNulls(value, branch as Record<string, unknown>);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const stripped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && !required.has(key) && !admitsNull(properties[key])) continue;
    stripped[key] = record(properties[key]) ? stripOptionalNulls(child, properties[key] as Record<string, unknown>) : child;
  }
  return stripped;
}
