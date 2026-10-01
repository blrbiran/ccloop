# SDD ledger — plan: docs/superpowers/plans/2026-10-01-retire-old-cli-entry.md

Controller: Orca session be653b22, 2026-10-01. Spec: docs/superpowers/specs/2026-10-01-retire-old-cli-entry-design.md.

## Preflight scan
| Pair / task | Shared | Finding |
|---|---|---|
| T1 / T2 | README.md | T1 does not touch README; T2 rewrites README incl. step 2 Task 3 (folded) resume/sweep --agents docs. Consistent. |
| T1 self | removal check first vs exclusivity rows | exclusivity rows now expect the removal message. Consistent. |

- Ruling: step 4 starts while Orca step 3 Task 2 is still running — Orca tests use a ccloop clone built before step 4, and the pinned package is not touched; step 4 commits only to ccloop — costs if wrong: none for Orca until a repin.
Task 1: implementer DONE (9335665); tests/validation codex* 8 red until Task 2 (validate-codex-adapter.mjs spawns --adapter codex)
- Ruling: Task 2 is dispatched while Task 1 is reviewed — disjoint files; the tree is red between them by design — costs if wrong: a Task 1 fix lands after Task 2, trivially.
Task 1: review — spec ✅ quality ✅; minors (deferred to the final review): m1 codex.test strict row now refused by the table schema (assertions unchanged; CodexAdapter strict covered by protocol.test.ts); m2 report header count; m3 three stale comments without ERRATUM (agentsRun.test.ts P23 m6, cli.ts 'not from --adapter', cli.test.ts 'single scripted attempt'); m4 sweepRuns createAdapter doc comment (registered by spec)
Task 1: complete (commits 5cb7aa9..9335665, review clean)
Task 2: implementer DONE (4d0c3ca); full clone run 1043/1042, stopProof only, check-known-reds RC 0
- Ruling: the three version-line edits in validation fixtures ('fake-codex 1'→'fake-codex 1.0.0', 'fixture'→'fixture 1.0.0' x2) count as fixture construction, not assertion changes — run --agents probes --version for x.y.z, which the old entry never did — costs if wrong: the human names them as criterion edits after the fact.
Task 2: review — spec ✅ quality ✅; minors: script throws on a codex --version without x.y.z and reads stdout only; script stubs probeVersion in resolveAgent (run --agents re-probes); README §7 says '真实 scripted 跑完' and omits agent-selection.json from the run-dir tree
Task 2: complete (commits 9335665..4d0c3ca, review clean)
- Ruling: Task 3 (mutations E1/E2) folded — Task 1's implementer saw both red in a clone.
Task 3: complete (folded)
