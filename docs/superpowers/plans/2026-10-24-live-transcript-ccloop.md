# Live transcript — ccloop half — Implementation Plan

**Goal:** every agent call (claude, codex, omp; phases and single calls) records a `transcript.jsonl` as the agent prints it;
codex and omp decode their result incrementally instead of holding the stream; codex/omp stdout is no longer stopped at
16 MiB but at a 1 GiB hard limit; `control collect` lists the transcripts behind `features.transcripts: "v1"`.

**Spec (authoritative, in the Orca repo):** `docs/superpowers/specs/2026-10-23-live-transcript-design.md` §2, §10.2.1–10.2.5,
§11 (O5, 1 GiB), §12 (C1 confirms that claude `content_block_delta` lines never reach a transcript). Orca is the consumer;
ccloop's own rules (CLAUDE.md Rules 13–18) govern this work and are not relaxed (Orca Rule 16).

Author: Orca session `ffec7b28` (implementer subagent), 2026-10-24. Branch `feat/live-transcript`, worktree
`/private/tmp/orca-ffec7b28/ccloop-lt` (node_modules is a symlink to the main checkout's — `unlink` it before removing the
worktree; never `git add -A`). Base `2c4f5ab`.

## Human rulings this plan relies on (verbatim)

- O5 (session `0e13a9b7`): 「同意。但是我们这里可能要定一下最大能支持多大的输出。作为一个hard limit ，比如1G」 — authorizes
  rewriting exactly `tests/runtime/codex/runCodexPhase.test.ts:57-60` and `tests/runtime/omp/ompPhase.test.ts:225-226`
  (spec §11.2; lines re-measured at `2c4f5ab`: the `it.each` at 57-60 whose `output-limit` row is the case, and the two
  `expect`s at 225-226 of "stops an oversized event stream…"). Each rewrite asserts (a) past 16 MiB and under 1 GiB the call
  completes with evidence/transcript capped per §11.1, (b) past 1 GiB it stops with `output-limit`.
- This session: 「这次批准改写所有必要的判据」. Any other existing criterion that turns red is treated as a regression of this
  branch first; a rewrite beyond the two above is stopped and reported, not made.

## Decisions (spec ambiguity resolved here; reversible, so decided per Rule 1 and written down)

- D1 **Scope.** 10.2.6 (`work.operatorNote`) is not in this plan: the dispatch for this branch names the transcript items
  only. It is reported as an open item (Orca T10/L6 depend on it).
- D2 **`events.jsonl` cap.** §11.1 (newer) says recording stops at the last complete line; that wins over 10.2.2/L2's
  "exactly 16 MiB". Past the cap the file ends on a `\n` at ≤ 16 MiB, no marker, `stdoutTruncated: true` (codex as today,
  omp gains the field).
- D3 **1 GiB limit** applies to the stdout ccloop reads from a codex/omp child (the existing byte counter, §11.1). claude's
  stream is read by the runner, which keeps no stream; the adapter's 16 MiB cap on the runner's envelope stays. No 1 GiB
  stop on claude's own stream (open item).
- D4 **`outcome.events`.** Both outcome types keep an `events` property for existing callers, now a lazy non-enumerable
  getter that reads `events.jsonl` (≤ 16 MiB) on access. No `src/` code reads it any more; the decoders use `outcome.stream`.
  This keeps `runCodexPhase.test.ts:31,39` unchanged.
- D5 **On-disk re-decoders** (`executionFormatFailure.ts`, `savedResultRecovery.ts`) are unchanged: they read an
  `events.jsonl` that is ≤ 16 MiB, refuse truncated evidence, and call the string decoders, which are now `fold(lines(text))`.
- D6 **Line splitting** is at byte `0x0A` (never inside a UTF-8 sequence); a complete line is decoded whole. That is
  decoder-grade without a `StringDecoder`. A line over 16 MiB is not kept: it becomes a `too-large` line. Strict decoders fail
  with `<runtime>-events-line-too-large`; lenient classifiers treat it as an unparsed line.
- D7 **collect `transcripts`.** Entry `{attempt, phase, seq, path, bytes, final, truncatedAt}` exactly; `seq` is 1-based per
  (kind, attempt, phase) ordered by `process.json` `startedAt` (parsed as UTC), calls without one after them by name; the
  runtime is the first segment of `path` (`<kind>/<attempt>/<phase>/call-*/transcript.jsonl`, relative to `<sourceDir>/run`).
  No `transcript.jsonl` ⇒ `path: null, bytes: 0, truncatedAt: null`. `truncatedAt` is read from the file's last line (the
  marker, checked against the size). `final`: `outcome.json` exists, or the loop state is terminal, or a stop proof exists.
- D8 The idle watch's tool tracking is fed from the same splitter (one parse per line), not from `lineFeeder`.

## Tasks (TDD: each new test seen red for the right reason first; one commit per task)

1. **Line splitter and capped line file** — `src/runtime/streamLines.ts`: `LineSplitter` (bytes in, `{text|tooLarge}` lines
   out, 16 MiB line ceiling), `CappedLineFile` (kept-open fd, `writeSync`, cut back to the last `\n` under the cap, optional
   marker line). Tests: `tests/runtime/streamFold.test.ts` (split multi-byte char, 17 MiB line), `tests/runtime/cappedLineFile.test.ts`.
2. **codex fold** — `src/runtime/codex/codexStream.ts`: one parse per line feeding reducers for `observedTurnUsage`,
   `decodeCodexUsage` (both modes), `classifyRateLimit`, `classifyCodexCall`, `codexModelUsage`, `decodeCodexSingleCall`'s
   counts. The string functions become fold-of-text; `codexAdapter` reads `outcome.stream`. L3 codex cases.
3. **omp fold** — `src/runtime/omp/ompStream.ts`: reducers for `decodeOmpPhase`, `decodeOmpSingleCall`,
   `ompUsageLowerBound`, `classifyOmpCall`, `ompToolRuleViolation`; `ompAdapter` reads `outcome.stream`. L3 omp cases.
4. **codex/omp process** — `runCodexPhase`, `runOmpProcess`: `transcript.jsonl` (128 MiB, marker), `events.jsonl` (16 MiB,
   no stop), 1 GiB `output-limit`, `transcriptTruncatedAt` and omp `stdoutTruncated` in `outcome.json`; no stream string.
   Rewrite the two O5 tests (own commit, ruling cited). New: `tests/runtime/transcriptCap.test.ts` (L2),
   `tests/control/handoffTranscript.test.ts` (L1).
5. **claude** — runner writes `CCLOOP_CLAUDE_TRANSCRIPT_PATH` (all lines but `stream_event`/`content_block_delta`,
   `ccloop.line-dropped` for a dropped >10 MiB line, 128 MiB cap + marker, `writeSync`); adapter sets the variable for phases
   and single calls and records `transcriptTruncatedAt`. `tests/runtime/claude/runnerTranscript.test.ts` (L4).
6. **collect** — `src/control/transcripts.ts`, `collect` top-level `transcripts` (absent when empty), `features.transcripts:
   "v1"`. `tests/control/collectTranscripts.test.ts` (L5).
7. **perf** — `scripts/perf-stream.mjs`, `npm run perf:stream` (on demand, not in `npm test`): fake codex/omp/claude print
   1 GiB of lines ≤ 1 MiB; the measured process runs under `--max-old-space-size=64`; peak
   `heapUsed+external+arrayBuffers` sampled every 100 ms must stay ≤ 32 MiB (L7).

## Mutations (each seen red; run in a `git clone --local` copy, log `/private/tmp/orca-ffec7b28/lt-mutations.log`)

L1 `transcript.jsonl` in `RAW_AGENT_FILES`; `events.jsonl` cap 128 MiB. L2 stdout `stop("output-limit")` at 16 MiB; no cut-back;
marker into `events.jsonl`. L3 per-chunk `toString`; drop lines > 1 MiB; skip the oversized line. L4 async write stream; drop
`message_delta`; no drop marker; env var for phases only. L5 order by directory name; `final` = `outcome.json` only. L7
`result.events +=` restored; `chunks.push` restored; runner keeping the stream.

## Gate

`npm run typecheck`, `npm run build`, full vitest JSON → `node scripts/check-known-reds.mjs` (RC 0), with
`CCLOOP_CACHE_DIR=/private/tmp/orca-ffec7b28/ccloop-cache`. A red that is not this branch's is also shown red on untouched main.
Not merged, not pushed.

## As built (Orca session `ffec7b28`, 2026-10-24; supersedes the task list above where they differ)

- **One linear branch.** Tasks 1-7 were first split across `feat/live-transcript` and a stacked
  `feat/live-transcript-rulings`, because Tasks 5-6 change bytes five existing criteria pin exactly. The coordinator then
  relayed the human's ruling 「这次批准改写所有必要的判据」 (Orca session `ffec7b28`, 2026-10-24) for exactly those five, rewritten
  minimally (only the new key/file added), one commit each: `tests/runtime/claude/claudeAgentAdapter.test.ts:133`,
  `tests/control/singleCall.test.ts:87-107`, `tests/control/protocol4.test.ts:13`,
  `tests/control/savedResultEvidence.test.ts:107,110`, `tests/control/toolRulesCollect.test.ts:107`. The stacked branch was
  rebased onto `feat/live-transcript` and that branch fast-forwarded to it.
- **collect fix.** collect read the loop state's status before progressOf validated it (TypeError on an unknown status,
  seen red in a full run); progress is now computed first.
- **L7 bounds growth, not the absolute peak** (spec §4.3 wording). Measured: the codex phase process peaked at ~47 MiB with
  only 8 MiB of output, from a pre-existing 16 MiB up-front buffer for final.json (now read in 64 KiB pieces). Growth over
  baseline after that, three runs: codex 24.5-26.2 MiB, omp 24.4-26.3 MiB, claude 25.6-31.0 MiB (main's unchanged runner,
  same workload: 25.2-26.0 MiB). Margin for claude is small and set by V8's floating garbage, not retention.
- **D3 stands** (coordinator: the spec ties the 1 GiB stop to codex/omp): no 1 GiB stop on claude's own stream.
- **D1 superseded**: `work.operatorNote` (10.2.6, L6) is built — optional on both loop work schemas (absent ⇒ same hash),
  rendered by its own lines in plan and execute (never verify, never through priorFailureLines), scoped by
  `src/runtime/operatorNote.ts`. Criterion `tests/runtime/operatorNote.test.ts`; mutations L6a-c seen red.
- Mutations: 23, all red, restores 0 bytes (`/private/tmp/orca-ffec7b28/lt-mutations.log`).
