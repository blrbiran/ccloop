// L2 run registry — observation types.
//
// These types carry no derived meaning (no eligibility, resumability, freshness,
// staleness, or expiry). They record only: was a field present, and did it match
// the declared JSON type. See docs/superpowers/specs/2026-07-28-run-registry-design.md §6, §7.3.

export type FieldObservation =
  | { kind: "present"; value: unknown }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: "parse" | "shape" | "io"; detail: string };

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "string-or-null"
  | "literal-true";

export type ObservedFileSpec = {
  file: string;
  atomic: boolean;
  fields: { name: string; type: FieldType }[];
};

export type FileObservation = {
  file: string;
  fields: Record<string, FieldObservation>;
};
