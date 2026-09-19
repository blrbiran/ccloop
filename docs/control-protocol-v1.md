# ccloop control protocol v1

`ccloop control` is a local JSON-over-stdio boundary for an external controller. Version 1 supports the `codex` adapter with durable execution acceptance, ordered phase-end usage observation, named handoff, verifiable process-tree isolation, evidence reads, and first-attempt materialization from a committed continuation bundle. Codex budget enforcement remains explicitly `soft`; this protocol does not claim strict token caps.

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
- `accept` and `inspect`: `absent`, `accepted`, `unknown`, or `stopped` execution status. `accepted` includes the durable execution ID and sealed config hash; `stopped` includes the matching generation and an evidence-backed `isolated:true` proof.
- `handoff`: `latched` or `complete` acknowledgement bound to the request ID. An acknowledgement means the immutable request was persisted; only `complete` names a produced candidate checkpoint.
- `collect`: ordered usage events after the caller's sequence watermark plus the current candidate and terminal state. A terminal state is withheld until its candidate is durable, so a controller cannot mistake an incomplete publication boundary for an archival source.
- `read-evidence`: `{artifactId,hash,base64}`; raw bytes never share stdout with JSON framing.

All six methods above are operational. The controller must still treat them as separate facts: accepted is not terminal, a handoff acknowledgement is not a quiet proof, a candidate is not an Orca-committed checkpoint, and a terminal state without complete usage observations cannot release budget. Protocol v1 never authorizes an ambient fallback to legacy `run` or `resume`.

## Execution, usage, and handoff guarantees

`accept` seals the canonical validated adapter configuration and the complete envelope before launching a detached worker. Replaying the same `runId`/generation/command identity and envelope returns the same execution; changing any envelope byte produces `control-envelope-conflict`. If launch state cannot be proven, inspection returns `unknown` and no replacement worker is guessed into existence.

The worker registers each detached Codex process group before sending its prompt. Usage events have a run-global increasing `eventSeq` and per-bucket cumulative high-water values. Missing token usage is represented by `cumulative:null`, never synthetic zero; explicit zero remains a real amount. Codex thread totals are treated as cumulative observations rather than deltas.

A named handoff binds request ID, run ID, generation, reason, and deadline. Identical replay is idempotent; changed payloads, stale generation, or envelope drift are refused. Once latched, no new phase begins. At the boundary or deadline the worker finalizes work usage, builds mechanical packet/evidence, writes candidate and explicit handoff usage (including zero), seals itself, and releases the owner lease.

`stopProof` exists only after the worker is sealed, the owner lease is released, every registered process group is quiet, a grace interval passes, and a second complete probe is quiet. PID-leader disappearance, unreadable process state, or incomplete evidence yields `null`. The proof's raw evidence and public response both carry `isolated:true`.

## Continuation and result repository

For a terminal execution, ccloop materializes `{sourceDir}/repo` as the exact archival source expected by Orca. If the attempt worktree is retained, tracked, staged, unstaged, untracked, mode, symlink, and index bytes are copied from that live workspace. Otherwise ccloop clones the published attempt ref. A pre-existing destination is accepted only when it is a real Git repository; an empty or forged directory fails closed.

When `inputCheckpoint` is present, the first attempt is constructed from the verified immutable bundle below `{sourceDir}/input/`, not from the target repository's current HEAD and not through legacy `resumeLoop`. ccloop verifies the manifest, checkpoint/predecessor binding, nested artifact hashes, Git objects, worktree bytes, modes, symlinks, and index stages before constructing the adapter. It also writes structured continuation input for `unfinished`, `pendingDecisions`, and `awaitingHuman`. The continuation always has a new run ID; predecessor state and usage remain immutable.

## Private layout and durability

The protocol owns `sourceDir/control/`. Newly created control directories use mode `0700`; newly replaced files use `0600`. Reads open leaves with `O_NOFOLLOW`. All operations reject symlink ancestors and paths escaping the canonical source directory, and they never chmod existing user paths.

Durable replacement is: create an exclusive temporary file in the destination directory, write, fsync the file, rename over the destination, then fsync the directory. Accepted/config/envelope records are durable before spawn; handoff requests are durable before acknowledgement; usage, evidence, candidate, and worker seal are independently durable. A successful response is formatted only after the method handler returns a schema-valid value.

The protocol deliberately stops at ccloop's producer boundary. Orca independently archives and re-reads evidence, captures its snapshot, commits the authoritative checkpoint, publishes D3 projections, and only then may authorize cleanup or a new continuation run. ccloop never deletes `sourceDir` or claims that its candidate alone is recoverable authority.
