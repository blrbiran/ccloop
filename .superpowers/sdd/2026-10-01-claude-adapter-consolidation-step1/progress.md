# SDD ledger — plan: docs/superpowers/plans/2026-10-01-claude-adapter-consolidation-step1.md

Controller: Orca session be653b22, 2026-10-01. Spec: docs/superpowers/specs/2026-10-01-claude-adapter-consolidation-step1-design.md (with §11 addendum).
Base (ccloop): commit titled `docs(plan): consolidation step 1, task by task; spec addendum for what planning found`.
Base (Orca): commit titled `docs(handoff): no pinned ahead-counts; name the skills for the adapter/CLI consolidation`.

## Preflight rulings
- Ruling: work on `main` of ccloop and Orca, no worktree — both repos' history lands local commits on main and CLAUDE.md wins over the skill (Rule 11); the human asked for subagent-driven execution without further stops — costs if wrong: commits must be moved to a branch by the human.
- Ruling: this ledger lives in the directory sdd-workspace printed (…-step1), not the plan's Task 5 name (…-consolidation); it is committed with `git add -f` and NOT deleted at the end — `.superpowers/sdd/**` is this project's evidence record (CLAUDE.md Rule 13) — costs if wrong: one extra directory in git.

## Preflight scan
| Pair / task | Shared | Finding |
|---|---|---|
| T1 / T2 | tests/fixtures/fake-claude-cli.mjs | T1 adds modes + a new comment line; T2 appends an ERRATUM to the header block. Compatible: T2 must append after the header block, not inside T1's new comment. |
| T1 / T2 | src/runtime/claude/claudeAgentAdapter.ts | T1 appends the header ERRATUM; T2 does not touch it. OK. |
| T1 / T2 | tests/runtime/claude/claudeAgentAdapter.test.ts | T1 adds a describe at the end; T2 appends an ERRATUM to the header comment. OK. |
| T2 / T3 | scripts/check-known-reds.mjs | T2 renames two entries and writes a comment that mentions the five run-scenario removals; T3 removes them. OK as long as both land in this step. |
| T1 / T5 | criteria names | M1–M6, M9 target T1 criteria 1–7 by name. OK. |
| T4 / T5 | Orca criteria | M7, M8, M10 target T4 criteria. OK. |
| T1 self | tests vs code | Criterion 7 is expected green before the code (it is M1's guard); others red. Consistent. |
| T2 self | Step 4 vs Step 9 | sweepRuns type not narrowed (spec §11) but its comments get ERRATA. Consistent. |
| T3 self | — | consistent. |
| T4 self | formula vs criteria | killGraceMs 0 + window 0 → 65 000; unusable kill + window 0 → 120 000; checked by hand. Consistent. |
| T5 self | — | consistent. |

- Ruling: Task 4 (Orca repo) is dispatched in parallel with Task 1 (ccloop) — no shared file or worktree; the skill's no-parallel rule exists to avoid edit conflicts, which cannot happen across repos — costs if wrong: none beyond machine load during focused test runs (load flakes are judged by single-file reruns).
Task 1: implementer DONE_WITH_CONCERNS (commit 8fda6e5); concerns: criterion 5 green before the change (expected: the error-path partial already worked, spec §2); ERRATUM says "deleted" before Task 2 lands (true at the end of this step); main-tree dist/ stale makes endToEnd red (clone with fresh build green).
Task 4: implementer BLOCKED — two existing criteria outside R5 go red under the new formula: tests/control/driverHandoff.test.ts > "nothing arrives > turns the request outcome-unknown past deadline + grace…" and "the grace is the run's own agent killGraceMs plus the fixed minute > does not call a request outcome-unknown before…" (driverHarness freezes partialOutcomeRecoveryWindowMs 30_000 ⇒ grace 95_000).
- Ruling: rewrite both criteria to the new formula (95_000 boundaries), keeping their structure; they then serve as the spec's wiring criterion (no seam, real frozen window), and M10 must turn them red — the human's standing instruction ("先按你的建议执行，不要再找我") stands in for R5 naming; listed for the human's review at the end — costs if wrong: the human reverts two test edits and names a different shape.
Task 1: review — spec ✅, 1 Important (ERRATUM form at claudeAgentAdapter.ts:28-31), 5 minor (see task-1-review.md); fix round 1 adds the ERRATUM form and the 'existing tokenUsage left alone' criterion (minor promoted: it is a spec §5.2 rule with no pin).
Task 1: fix round 1/5 (1 addressed + 1 added criterion, 0 open; commits 8fda6e5..d250aa0)
Task 1: minor (deferred): see task-1-review.md Minors #2-#5 (criterion 5 pins pre-existing behaviour; fixture header mode list; others)
Task 1: complete (commits 409690f..d250aa0, review clean)
Task 4: implementer DONE_WITH_CONCERNS (Orca commit 08589e0 on top of checkpoint 125d022); concern: the 7_000 driverHandoff criterion no longer discriminates frozen vs default killGraceMs under the 30_000 window
Task 4: review — spec ✅, quality ✗: I1 no criterion pins that the frozen killGraceMs reaches the grace (30_000 window masks it); minors M1 (envelope read before time check / throws on corrupt state), M2 (describe name states old rule), M3 (95_000 hard-coded). Fix round 1: I1 + M1.
Task 4: fix round 1/5 (I1 + M1 addressed, 0 open; Orca commits 08589e0..0593741)
Task 4: minor (deferred): M2 describe name states the old rule; M3 95_000 hard-coded against the fixture window; bare catch records nothing about a corrupt envelope; test header comment ~L58-59 still says frozen killGraceMs is 7 000; collectInto still throws on a corrupt envelope once collecting (pre-existing)
Task 4: complete (Orca commits 125d022..0593741, review clean)
Task 2: implementer DONE_WITH_CONCERNS (7300f67); five run-scenario criteria red until Task 3 (expected, §7.2 deletions); README §6.2 two stale sentences left
- Ruling: Task 3 is dispatched while Task 2 is under review — its files (validation/v1/**, tests/validation/{prepareA04,evidence}.test.ts, scripts/check-known-reds.mjs) overlap a possible Task 2 fix only in check-known-reds.mjs; Task 2 leaves the tree red until Task 3 lands — costs if wrong: one rebase-free follow-up edit to the known-reds list.
Task 2: review — spec ✅, quality ✅ with 1 Important (README.md:242 'point command at it' false now); minor README:237 output-format json (fixed by ruling in the same round); fix round 1 dispatched
Task 2: fix round 1/5 (2 addressed, 0 open; commit a147d1f)
- Ruling: the README-only fix round (2 lines) was verified by the controller against the diff instead of a re-review seat — a two-line doc diff whose claims match scripts/claude-phase-runner.mjs:389 — costs if wrong: a doc inaccuracy the final review should still catch.
Task 2: minor (deferred): check-known-reds.mjs comment true only once Task 3 lands (it has: 7f58b9b)
Task 2: complete (commits 9090b35..a147d1f, review clean)
Task 3: implementer DONE (7f58b9b); prepareA04 had 52 expanded criteria (46 it sites, 2 it.each), spec §7.2 says 44 — count only, describe blocks match; full clone run 1031/1029, 2 known reds, check-known-reds RC 0
- Ruling: step 1's Task 5 gate is folded into one final gate after step 4 (both repos, fresh clones, spec §10 conditions); step 1's mutations are carried by the implementers' clone runs (M1–M6, M9 by Task 1; M10 and the frozen-killGraceMs mutation by Task 4) and M7/M8 are re-checked in the final mutation pass — gating four times over the same day's tree buys little and costs ~4 full runs per repo — costs if wrong: a regression introduced in step 1 is first seen after step 4 and must be bisected across the step commits.
Task 3: review — spec ✅ quality ✅; minor (deferred): validation/v1/README.md:3 and :11 still mention run-scenario.ts / A-04 prepare; check-known-reds.mjs ERRATUM cites the removed R29 name (historical text, leave); spec §7.2's 44 is 52 expanded (spec correction pending)
Task 3: complete (commits 9086586..7f58b9b, review clean)
## Final review
- ccloop: 0 C / 1 I (handoff stale — done at the end by the controller) / 7 m; must-fix: codex strict row assertion, README x3, spec count (done 1e64bbe)
- Orca: 0 C / 2 I (I1 120_000 fallback shorter than default grace; I2 scheduler tests need unpushed ccloop frames commit) / 9 m
- Ruling: an unusable recovery window counts as 60_000 (Orca's loop-plan default) → grace ≥ 125_000 — the only non-guess bound Orca owns; a true ceiling needs handoff.activeMs, which the corrupt envelope is the source of — costs if wrong: on a corrupt envelope with a window > 60_000 the driver calls outcome-unknown early, as before.
- Fix wave dispatched with the list in scratchpad/final/fix-wave.md
- Final fix wave: ccloop 6bc2693, Orca f6caf82; scoped re-review: items 1–8 ADDRESSED, no new breakage. Remaining: handoffs (controller), gate (running).

## Human review (2026-10-01, recorded by Orca session b5e8d368)
- The human approved every `Ruling:` line above, and the criterion edits they carry, as written ("几条都同意"). Nothing is reverted.
