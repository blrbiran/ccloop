# SDD ledger — plan: docs/superpowers/plans/2026-10-08-codex-phase-output-hardening.md

Controller: Orca development session e34dc963 (Claude), 2026-10-08, working in ccloop at the human's permission.
Branch fix/codex-planner-output, worktree /Users/biran/code/skills/loop/ccloop-planner.
Spec: docs/superpowers/specs/2026-10-08-codex-phase-output-hardening-design.md

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| K1 -> K2 | extractFinalObject + phaseFinalAccepts (protocol.ts) consumed by codexAdapter.ts | consistent names in both briefs (plan dry-run applied all blocks, typecheck RC 0) |
| K2 -> K4 | fake-codex final-text mode + finalExtraction.test.ts used by M8-M10 | consistent |
| K3 -> K4 | phasePrompts.test.ts used by M11-M15 | consistent |
| K1 self | tests (31) vs code; perf cases | agrees; ambiguity rulings below |
| K2 self | new fake mode additive | agrees |
| K3 self | prompt lines vs spec 3.1 | agrees |
| K4 self | gate + mutation runner | agrees |

Ruling: candidate dedupe uses plain JSON.stringify (key order significant) — same object with reordered keys counts as two and yields none — safe side; cost if wrong: a compliant-but-reordered duplicate is refused as today.
Ruling: whole-text [ {plan} ] stays a whole-parse failure as today; accepted only inside prose — spec step 1 is literal; cost if wrong: a bare array answer still fails as today.
Ruling: 4 MiB must-accept case puts the plan in a fence (an unclosed { ends span scanning by spec); unfenced variant expects none — follows spec 3.2; cost if wrong: none beyond test shape.
Ruling: evidence write failure path is not tested (no injection point without changing runCodexPhase) — accepted gap, recorded; cost if wrong: an untested branch that only rethrows.
Ruling: the skill's "delete the workspace at the end" step is overridden by repo CLAUDE.md Rule 16 / Orca Rule 13 — the ledger is force-added and committed, never deleted — cost if wrong: a few KB of extra files in git.

Task K1: implemented 7c79044 (base 2bbe8ef). Concern: pre-change baseline had 8 reds = 7 ENOENT dist/cli.js (dist not built) + codexWatchdog "double-space start identities" timeout (known load flake per handoff). Ruling: K4 builds dist before taking the baseline — environment, not regression — cost if wrong: a real regression in endToEnd would surface at K4's gate anyway.
Task K1: review 1 — spec ✅, Important: unclosed `{` / unparseable wrapper hides a verify rejection behind a fenced approval (spec defect, probe in scratchpad/k1-review). Minor: dedupe not canonical (key order); column-0 fences only (matches spec); report used sed/tail as a convenience view (full file kept).
Ruling: spec §3.2 amended — none on unclosed brace or unparseable top-level span; walk nested objects as candidates; sort keys before dedupe — fail-closed is the spec's safety rule; cost if wrong: less tolerance for prose with stray braces.
Task K1: fix round 1 commit bbcac9e (fail closed, nested walk, sorted-key dedupe); tests changed old→new listed in report.
Ruling: remove fence collection (dead under fail-closed spans; M2 unseeable) — spec note appended; K4 drops M2 — cost if wrong: none, behaviour identical.
Task K1: fix round 1/5 (3 addressed, 0 open — fail-closed hidden text; canonical dedupe; fence collection removed; commits 7c79044..befaea8)
Task K1: minor (deferred): doc-comment line ~170 chars in protocol.ts; spec mutation list still names M2 (dropped by the §6 note).
Task K1: parked — a verify rejection that appears ONLY as an escaped JSON string (or only in prose) is not an object node, so a fenced approval template is accepted — Ruling: out of the spec's "hidden text" class; such an answer has no machine-readable rejection at all and today fails as codex-result-invalid; residual risk recorded for the final review — cost if wrong: a rare malformed verify answer could be read as approval.
Task K1: complete (commits 2bbe8ef..befaea8, review clean after 1 fix round, 1 parked)
Task K2: minor (deferred): an evidence-write failure on a `none` path replaces today's parse error with the write error (spec-sanctioned, untested).
Task K2: complete (commits befaea8..a1be21e, review clean)
Task K3: complete (commits a1be21e..3ed05ce, review clean)
Task K4: gate on 2328f1e — build/vitest/known-reds/typecheck rc 0; 1275/1275 (1212 baseline + 63 new); baseline clone at 2bbe8ef with dist built 1212/1212 (K1's 8 reds were environment). Mutations M1, M3–M17, M8–M10b, M11–M15b and K1-fix a–d seen red; M2 dropped; M7e equivalent mutant (root-dedupe continue). New criterion commit 2328f1e (too-deep span fails closed). Restore proof 0/0 bytes; clones cmp-equal to worktree before deletion.
Task K4: load flakes outside the roster (6 names, see task-K4-report.md) at load 37-39 — each green alone — Ruling: not regressions; registering them is the human's call.
Task K4: complete (commits 3ed05ce..2328f1e)
Final review (ef5caba..2328f1e): Fix before merge. C1 off-schema rejection + valid approval template ⇒ approval; I1 16 MiB wide-array input 76 s / 1.8 GB synchronous; I2 same root for plan examples; M1 no evidence for hidden-text refusals; M2 stack-size-dependent test; M3 dead guard; M4 verifier wording.
Ruling: spec §7 added — answer-shaped nodes (discriminating key) count valid or not, >1 distinct ⇒ none; verify extraction accepts only approved:false; ≤100k nodes and depth ≤1000 else none; zod only on answer-shaped nodes; evidence gains `hidden` and is written whenever text was hidden; remove dead guard; reword verifier line — fail-closed is the spec's safety rule; cost if wrong: less tolerance for decorated approvals (they fail exactly as today).
Ruling: the parked K1 item (prose/escaped-string rejection) is closed by rule 2.
Final fix wave: 252d3ee (on 9527043) — spec §7 rules 1-5; gate 1292/1292, known-reds rc 0, typecheck 0; mutations for each rule seen red; perf2 wide 16 MiB ~1.2 s (was 76 s / 9.6 s); restore 0/0.
Final fix re-review: C1, I1, I2, M2, M3, M4 ADDRESSED; M1 partially (B1 path); new Important B1 — answer-shaped node with a deep subtree throws RangeError (serialise before depth check), regression from K4's fail-closed; no safety flip.
Ruling: one targeted follow-up fix for B1 (deviation from "no second fix wave") — it is a regression introduced by the fix wave, small, and the human asked for the round to be finished in this session; followed by one scoped re-review — cost if wrong: one extra review seat.
Minor (deferred): ~1.1 GiB memory at 16 MiB (JSON.parse allocation; per-task process; time bounded); per-node key count unbounded (1.29M-key object 5 s, base 3.4 s); arrays not counted toward MAX_NODES (16 MiB [] 1.8 s); perf-test 3 s bound has ~2.5x headroom; evidence counts are lower bounds at a limit (marked hidden).
Follow-up B1: a0adad2 — walk each span completely before serialising; 7 new criteria red under "serialise at pop time"; §7 mutations re-run red; gate 1298/1299 (the one red = roster entry claudePhaseRunner "waits for close…", file untouched by this branch; load 12→57); restore 0/0. Scoped re-review: FIXED, no new breakage.
Minor (deferred): 16 MiB single-message cases 2-4 s and ~1 GB RSS (linear; no wall-clock bound in spec); three codex process-kill/cleanup tests (adapter, runCodexPhase TERM-ignoring kill, skillsController verify cleanup) flaked under parallel load, green alone at head and base.
Branch complete: ef5caba..a0adad2. Awaiting human: merge into ccloop main and push; then Orca re-pins.
