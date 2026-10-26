# OMP empty-stop continuation and perf:stream L7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two defects ccloop's handoff registered as unfixed: (1) a real OMP phase that answers after omp's own empty-stop retry is refused as `omp-phase-continuation`; (2) `npm run perf:stream` (L7) fails on claude under current Node because the measured process's heap is not actually bounded by `--max-old-space-size=64`.

**Architecture:** One predicate in `src/runtime/omp/ompProtocol.ts` mirrors omp 18.10.1's `isEmptyAssistantStop` stop branch, so a thinking-only `stop` is not taken for the answer and the continuation `agent_start` that follows is admitted; every post-answer guard is unchanged. One V8 flag (`--max-semi-space-size=1`) joins the existing `--max-old-space-size=64` in the two measured spawns of `scripts/perf-stream.mjs`; the 32 MiB threshold is unchanged.

**Spec:** Orca `docs/superpowers/specs/2026-10-23-live-transcript-design.md` criterion L7 and §4.3 for the perf side. The omp side has no spec: it is a registered defect with real-run evidence (below).

**Round:** Orca session `ffec7b28`, 2026-10-26. Branch `feat/omp-empty-stop-perf`, worktree `/private/tmp/orca-ffec7b28/ccloop-c-wt` (node_modules symlinked to the main tree's). Base `c205d55`.

## Global Constraints

- ccloop CLAUDE.md applies in full, especially Rule 14 (no filtered verification runs; costs/durations only as tool-reported), Rule 15 (no implementer changing an existing criterion), Rule 17 (mutations only in a built `git clone --local` copy), Rule 18 (never announce a human ruling).
- **No existing test is changed by this round.** Both tasks add tests; neither rewrites one. If an existing test must change, stop and report instead.
- The perf threshold stays 32 MiB. Do not raise `LIMIT_MIB`, do not weaken `completed`, do not move the flag to the parent process.
- Fake agents only. No paid agent run.
- One commit per task; a review-fix follow-up may be a separate commit, named as such in the As built. Plan doc committed separately after both.

## Evidence this plan rests on (measured, not estimated)

### omp: the real failing call

`/private/tmp/orca-ffec7b28/evidence/omp-empty-stop/` (copied from the paid codex-accept round's OMP verify call `call-ToBJCb`; `events.jsonl`, `decode-error.txt`, `failure-cause.json`, `outcome.json`). The stream is 576 JSON lines (1-based below):

| line | event |
| --- | --- |
| 2 | `agent_start` |
| 181 | assistant `message_end`, `stopReason: "toolUse"`, blocks `thinking,toolCall×4`, usage total 3980 |
| 333 | assistant `message_end`, `stopReason: "stop"`, blocks **`thinking` only, `thinkingSignature: ""`**, usage total 4640 |
| 334 | `turn_end` |
| 335 | **`agent_start`** (the empty-stop retry's continuation) |
| 574 | assistant `message_end`, `stopReason: "stop"`, blocks `thinking,text` (932 chars), the verify JSON, usage total 4909 |
| 576 | `agent_end`, `isTerminal: true, yielded: true` |

`decode-error.txt` = `Error: omp-phase-continuation`. There is **no** public `agent_end` between the empty stop (333) and the continuation `agent_start` (335).

omp 18.10.1 source (`@oh-my-pi/pi-coding-agent@18.10.1`, checked in place):

- `src/session/messages.ts:568` `isEmptyAssistantStop`: for `stopReason === "stop"`, empty iff **no** block is actionable.
- `src/session/messages.ts:544` `isActionableContent`: `toolCall`, `image`, `redactedThinking`, `anthropicServerTool`; `text` with non-whitespace (`hasText`, line 531); `thinking` **only with a non-empty `thinkingSignature`**.
- `src/session/turn-recovery.ts:1023` `#handleEmptyAssistantStop` drops the empty turn, appends an `empty-stop-retry` reminder and schedules an agent continue (`:1095`).
- `src/session/agent-session.ts:4327-4331` on `"continue"` emits only the extension `agent_end` notification with `willContinue: true`; print mode still prints the empty assistant's `message_end`.

So the second `agent_start` is legitimate, and its usage is spent tokens ccloop must keep counting.

### perf:stream L7

- Node `v24.13.0` (`/usr/local/bin/node`): `--max-old-space-size=64` alone yields `v8.getHeapStatistics().heap_size_limit` **256 MB** (the young generation is auto-sized); adding `--max-semi-space-size=1` yields **67 MB**.
- The claude measured process's live heap after a major GC was **4.6 MB** (`Mark-Compact 87.1 (194.8) -> 4.6 (134.1) MB`); the 62-98 MiB "growth" is floating garbage in the oversized young generation, not retention.
- Recorded failure shape before the fix: `claude: FAIL growth=95.7MiB limit=32MiB peak=101.5MiB baseline=5.7MiB ... completed=true` (and 98.0, 90.8, 62.8 in repeated runs). codex/omp passed.
- With `--max-semi-space-size=1` beside the old flag, two pre-implementation probe runs of all three runtimes passed: codex 22.8/16.8, omp 17.0/16.6, claude 22.7/21.5 MiB growth. (The as-built runs are in the As built section.)

## Review Focus

1. `ended` must become true **exactly** when omp's own loop would treat the message as a real stop: `stopReason === "stop"` and at least one actionable block, including signed thinking. Unsigned thinking alone is not actionable.
2. Every post-answer guard stays: a second assistant answer, a second `agent_end`, an `agent_end` with `isTerminal: false`/`willContinue: true`, and any tool event after the answer are still refused with today's codes (existing tests).
3. A phase whose only assistant message is an empty stop and which then ends is still refused. Its code becomes `omp-no-completion` (no answer was ever given) instead of `omp-result-invalid`; no existing criterion pins the old code (checked: no test asserts `omp-result-invalid` for an empty final stop).
4. The perf change is an environment pin, not a threshold change: `LIMIT_MIB` stays 32, baseline/peak logic stays, and the flag goes only on the two measured `spawnSync` calls.

## Accepted gaps

- `OmpSingleCallFold` is not changed: its overlay disables omp retries, and if an empty stop were continued anyway the second assistant message is refused as `omp-single-call-multiple-requests` (existing criterion `C5`, `tests/runtime/omp/ompSingleCall.test.ts:163`). Fail closed.
- A `length` stop is not an empty stop in omp (it is not retried), so it stays terminal here.
- No 1 GiB stop is added to claude's own stream (unchanged D3 from the live-transcript round).

---

### Task 1: Decode the answer that follows OMP's empty-stop retry

**Files:**
- Modify: `src/runtime/omp/ompProtocol.ts` (the `message_end` branch, line 108, plus a module-level helper)
- Test: `tests/runtime/omp/ompPhase.test.ts`, `tests/runtime/streamFold.test.ts`

**Interfaces (produces):**
```ts
// module-private; mirrors omp's isActionableContent (messages.ts:544) for the stop branch.
function actionableStop(message: Record<string, unknown>): boolean;
```
No exported API changes.

- [ ] **Step 1: Failing tests first.** Add to `tests/runtime/omp/ompPhase.test.ts`:
  - `it("decodes the answer that follows an empty-stop continuation", ...)` — the measured shape, trimmed: `agent_start`, a `toolUse` assistant message (usage total 5) with one `tool_execution_start`/`tool_execution_end` pair after it, `turn_end`, `message_end` with **`content: [{type:"thinking",thinking:"...",thinkingSignature:""}]`, `stopReason:"stop"`** and usage total 10, `turn_end`, `agent_start` (the continuation), `message_end` with the plan JSON and usage total 14, `turn_end`, `agent_end isTerminal:true`. Assert the plan result **and** `tokenUsage === 29` (every message is billed).
  - `it("still treats a signed thinking stop as the answer", ...)` — empty-stop shape but the thinking block carries `thinkingSignature: "sig"`; a following `agent_start` must throw `omp-phase-continuation` (proves the predicate is not simply "text is empty").
  - `it("decodes after two consecutive empty-stop continuations", ...)` — two thinking-only stops, two `agent_start`s, then the answer.
- [ ] **Step 2: Run them and see each fail for the right reason** (the first and third with `omp-phase-continuation`; the second already passes — keep it as the guard's proof, and say so in the report).
- [ ] **Step 3: Implement.** Add `actionableStop(message)`:
  ```ts
  const ACTIONABLE_BLOCKS = new Set(["toolCall", "image", "redactedThinking", "anthropicServerTool"]);
  function actionableStop(message: Record<string, unknown>): boolean {
    if (!Array.isArray(message.content)) return false;
    return message.content.some((block) => {
      if (!record(block) || typeof block.type !== "string") return false;
      if (ACTIONABLE_BLOCKS.has(block.type)) return true;
      if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
      if (block.type === "thinking") return typeof block.thinkingSignature === "string" && block.thinkingSignature.trim().length > 0;
      return false;
    });
  }
  ```
  and change line 108 to `if (raw.message.stopReason === "stop" && actionableStop(raw.message)) this.ended = true;`. Keep a one-line comment naming omp's `isEmptyAssistantStop` as the mirrored rule. Do not touch the guards at 89-90 or `value()`.
- [ ] **Step 4: Add the fold-parity corpus entry** `"empty stop continuation": ompRows({type:"message_end", message: assistant("", {content:[{type:"thinking",thinking:"hmm"}]})}, {type:"agent_start"}, {type:"message_end", message: assistant(PLAN_ANSWER)}, {type:"agent_end", isTerminal:true})` to `OMP_CORPUS` in `tests/runtime/streamFold.test.ts`, so fold and string decoding stay equal on this shape.
- [ ] **Step 5: Focused verification, unfiltered:** `npx vitest run tests/runtime/omp/ompPhase.test.ts tests/runtime/streamFold.test.ts` redirected to a file and read whole; `npm run typecheck`.
- [ ] **Step 6: Commit** `fix(omp): an empty stop that OMP retries is not the phase's answer`.

### Task 2: Pin the young generation in perf:stream

**Files:**
- Modify: `scripts/perf-stream.mjs` (header comment; both `spawnSync` argument arrays at lines 93 and 100)

- [ ] **Step 1: Add `"--max-semi-space-size=1"` immediately after `"--max-old-space-size=64"` in both measured spawns.**
- [ ] **Step 2: Extend the header comment** with the measured reason: under Node 24, `--max-old-space-size=64` alone leaves the total heap limit at 256 MB because the young generation is auto-sized; `--max-semi-space-size=1` brings it to 67 MB. Quote the measured live-heap (`4.6 MB` after a major GC) and that the bound is on growth (already documented). State that the 32 MiB threshold is unchanged.
- [ ] **Step 3: Build and measure.** `npm run build`, then `npm run perf:stream` twice, each redirected to its own file and read whole (Rule 14). All three runtimes must report `ok` in both runs; record the exact lines in the report.
- [ ] **Step 4: Commit** `fix(perf): pin the young generation so L7 measures retention, not V8 slack`.

### Task 3: Gates, mutations, handoff

- [ ] **Step 1: Full gate on the branch tip.** `npm run typecheck`; `npm run build`; full vitest to JSON (no filter) with a temp `CCLOOP_CACHE_DIR` under `/private/tmp/orca-ffec7b28/`; `node scripts/check-known-reds.mjs <json>` must exit 0. Read the vitest JSON whole enough to confirm the `RUN` path and the failing set.
- [ ] **Step 2: Mutations in a `git clone --local` copy under `/private/tmp/orca-ffec7b28/`**, `npm run build` there, running the named criteria; append every result to `/private/tmp/orca-ffec7b28/c-mutations.log`; restore byte-identically (`git diff`/`git diff --cached` byte counts).
  - M1 (restores the bug): `if (raw.message.stopReason === "stop") this.ended = true;` ⇒ Task 1's continuation test must fail with `omp-phase-continuation`.
  - M2 (over-relaxed guard): delete the `this.ended && raw.type !== "turn_end" && raw.type !== "agent_end"` check ⇒ `ompPhase.test.ts` "refuses a second assistant answer…" must fail.
  - M3 (perf): remove `--max-semi-space-size=1` from both spawns, rebuild the clone's dist and rerun `npm run perf:stream` ⇒ claude must fail the 32 MiB bound.
- [ ] **Step 3: Handoff.** Update `docs/handoff/handoff.md` in place (rolling single current-round section, no growth of history): the omp fix and its real evidence, the perf pin and its measured numbers, and that the Orca-side repin is the next human step. Commit `docs(handoff): omp empty-stop continuation and the L7 young-generation pin`.
- [ ] **Step 4: Commit the plan doc** (this file, with an `As built` section appended) as `docs(plan): omp empty-stop continuation and perf L7 — as built`.
- [ ] **Step 5: Stop.** No merge, no push, no branch/worktree deletion without the human's separate authorization.

## Gate

`npm run typecheck`, `npm run build`, full vitest JSON → `node scripts/check-known-reds.mjs` RC 0 with `CCLOOP_CACHE_DIR=/private/tmp/orca-ffec7b28/ccloop-cache-c`; `npm run perf:stream` green twice; mutations M1-M3 seen red and restored; no existing criterion changed.

## As built (2026-10-26, Orca session `ffec7b28`)

**Commits on `feat/omp-empty-stop-perf`** (base `c205d55`):

| commit | subject |
| --- | --- |
| `48b8013` | `fix(omp): an empty stop that OMP retries is not the phase's answer` |
| `92278b2` | `test(omp): the empty-stop case follows the measured event order` (spec-review follow-up) |
| `ee6ac90` | `test(omp): pin the measured empty-stop shapes, not an idealized one` (quality-review follow-up) |
| `b371f66` | `fix(perf): pin the young generation so L7 measures retention, not V8 slack` |
| `943837b` | `docs(handoff): omp empty-stop continuation and the L7 young-generation pin` |

**Task 1 as built.** `src/runtime/omp/ompProtocol.ts` gains module-private `ALWAYS_ACTIONABLE_BLOCKS` and `actionableStop`, mirroring omp's `isActionableContent` (the four always-actionable block types, non-whitespace text, non-empty `thinkingSignature`); `ended` is set only for `stopReason === "stop" && actionableStop(message)`. Guards and `value()` untouched; `OmpSingleCallFold` untouched. `tests/runtime/omp/ompPhase.test.ts` gained four tests (the measured continuation, two consecutive empty stops where the second is whitespace-only text, a signed-thinking stop that is the answer, and a phase whose only answer was an empty stop → `omp-no-completion` with `observedTokens` 10); `tests/runtime/streamFold.test.ts` gained the `"empty stop continuation"` corpus entry. Decoding the real 576-line evidence stream now yields the verify JSON with `tokenUsage` 13529. The empty-stop fixtures carry the measured `thinkingSignature: ""`, not a missing field.

**Task 2 as built.** Both measured spawns in `scripts/perf-stream.mjs` now run under `--max-old-space-size=64 --max-semi-space-size=1`; `LIMIT_MIB` stays 32 and the sampler/baseline/completion logic is byte-identical. As-built runs (`/private/tmp/orca-ffec7b28/c-wt-perf-run1.log`, `-run2.log`, both RC 0):

```
codex: ok growth=17.1MiB / 15.6MiB
omp: ok growth=14.8MiB / 16.8MiB
claude: ok growth=19.9MiB / 20.7MiB
```

**Reviews.** Task 1 spec: PASS (the real evidence stream decodes; guards unchanged; additions only). Task 1 quality: REQUEST_CHANGES on one Important issue — the empty-stop fixtures omitted the measured empty `thinkingSignature`, so dropping `trim().length > 0` survived; fixed in `ee6ac90`, closure review APPROVED. Task 2 spec: PASS. Task 2 quality: APPROVED (minor notes only).

**Gate on the branch tip (unfiltered, `CCLOOP_CACHE_DIR=/private/tmp/orca-ffec7b28/ccloop-cache-c`).** `npm run typecheck` RC 0, `npm run build` RC 0. First full run: 2398/2399, the only red `tests/agents/updates.test.ts` "observes without writing…" timed out at 20 s and is not on the known-reds roster; run alone 3/3 green (load). Second full run: 2399/2399, `check-known-reds` RC 0 (failed 0, unexpected 0).

**Mutations** (built `git clone --local` at `/private/tmp/orca-ffec7b28/ccloop-c-mut`; log `/private/tmp/orca-ffec7b28/c-mutations.log`):
- M1 restoring `stopReason === "stop"` alone: 3 new tests red (`omp-phase-continuation` twice, `omp-result-invalid` once).
- M2 deleting the post-answer continuation guard: "refuses a second assistant answer…" red, signed-stop probe red.
- M3 removing the semi-space pin: `claude: FAIL growth=91.9MiB`.
- Every restore: `git diff` 0 bytes, `git diff --cached` 0 bytes.

**Deviations.** Task 1 is three commits (fix plus two review follow-ups) rather than one. The plan's Task 1 Step 1 originally put the retry `agent_start` before the empty stop and asserted `tokenUsage === 24`; the implementation follows the measured order and asserts 29 (5 + 10 + 14) — the plan text was corrected above. No existing criterion was changed.

**State.** Branch not merged, not pushed; worktree kept for the human's review.
