# omp 18.10.1 stream-watchdog transcripts (M0, tester #62)

Recorded by Orca session `3cd8fb02` on 2026-10-27 (Orca spec
`docs/superpowers/specs/2026-10-27-single-call-unknown-usage-settlement-design.md` §3.1): omp 18.10.1 in ccloop's
single-call argv shape with `OMP_SINGLE_CALL_OVERLAY`, an `openai-completions` provider pointed at a local fake upstream
(no provider, no cost), `PI_STREAM_IDLE_TIMEOUT_MS=3000`, `PI_STREAM_FIRST_EVENT_TIMEOUT_MS=3000`. Each file is that run's
stdout verbatim, except the `session` line's `cwd`, scrubbed from the recording directory to `/tmp/omp-m0`.

| file | upstream behaviour | omp exit |
|---|---|---|
| `A.jsonl` | a few deltas, then silence; no usage chunk | 1 (`... stream stalled while waiting for the next event`, usage all zeros) |
| `A_usage.jsonl` | as A, plus a usage chunk (111 + 22 = 133) before the silence | 1 (same error, usage 133) |
| `B.jsonl` | headers flushed, no body | 1 (`... stream timed out while waiting for the first event`, usage all zeros) |
| `C.jsonl` | a full `{"answer": "hello"}` answer with usage, `[DONE]` | 0 |

Model `fake/fake-model`. Replayed with `tests/fixtures/fake-omp.mjs`'s `<marker>.single.json` `{ rows, exitCode }`.
