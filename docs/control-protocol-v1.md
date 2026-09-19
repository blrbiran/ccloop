# ccloop control protocol v1

`ccloop control` is a local JSON-over-stdio boundary for an external controller. Version 1 supports the `codex` adapter with phase-end usage observation and soft budget enforcement. It does not claim strict token caps.

## Invocation and framing

```text
ccloop control capabilities|accept|inspect|handoff|collect|read-evidence \
  --adapter codex --adapter-config /absolute/private/config.json
```

The adapter config must be an absolute, canonical regular file, not a symlink. Stdin contains exactly one JSON value. The selected method determines the strict stdin payload, so stdin does not repeat the method name. A successful response is exactly one compact JSON value followed by one newline. Diagnostics are never written to stdout.

Exit codes are:

- `0`: the response passed its method response schema;
- `2`: a named protocol refusal such as `control-protocol-unsupported`, `control-request-invalid`, or `control-method-unavailable`;
- `1`: malformed CLI/JSON, IO failure, handler failure, or invalid handler response.

## Requests

- `capabilities`: `{}`.
- `accept` and `inspect`: a `StartEnvelopeV1`.
- `handoff`: `{ "input": StartEnvelopeV1, "request": HandoffRequestV1 }`.
- `collect`: `{ "input": StartEnvelopeV1, "afterSeq": <safe nonnegative integer> }`.
- `read-evidence`: `{ "input": StartEnvelopeV1, "ref": ArtifactRef }`.

Every object is strict: unknown fields are refused. IDs match `[A-Za-z0-9][A-Za-z0-9_.-]*`, hashes are lowercase SHA-256 hex, counters are safe integers, and timestamps require an offset. `sourceDir` is an existing canonical absolute directory with no symlink spelling. A continuation bundle must be an existing canonical directory strictly below `sourceDir/input/`.

`StartEnvelopeV1` contains protocol `1`, the complete claim and grant, a contract hash, an optional input checkpoint, and the work contract/target/base/source directory. `HandoffRequestV1` binds request ID, run ID, generation, reason, and deadline. The canonical TypeScript definitions and producer-side schemas live in `src/control/protocol.ts`.

## Responses

- `capabilities`: the protocol/capability record. Codex declares `usageObservation:"phase-end"` and `budgetEnforcement:"soft"`.
- `accept` and `inspect`: `absent`, `accepted`, `unknown`, or `stopped` execution status.
- `handoff`: `latched`, `complete`, or `unknown` acknowledgement bound to the request ID.
- `collect`: the ordered usage/candidate/terminal report added by the supervised worker slice.
- `read-evidence`: `{artifactId,hash,base64}`; raw bytes never share stdout with JSON framing.

Only `capabilities` is operational in the first protocol slice. Until durable accept, collection, handoff, and restore land in later slices, their default handler returns `control-method-unavailable`. This document does not claim handoff or restore completion.

## Private layout and durability

The protocol owns `sourceDir/control/`. Newly created control directories use mode `0700`; newly replaced files use `0600`. Reads open leaves with `O_NOFOLLOW`. All operations reject symlink ancestors and paths escaping the canonical source directory, and they never chmod existing user paths.

Durable replacement is: create an exclusive temporary file in the destination directory, write, fsync the file, rename over the destination, then fsync the directory. A successful response may only be formatted after the method handler returns a schema-valid value. Later slices define the stronger accepted, request, worker seal, evidence, and checkpoint durability boundaries on top of this primitive.
