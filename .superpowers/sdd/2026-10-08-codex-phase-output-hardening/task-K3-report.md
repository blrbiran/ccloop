# Task K3 report

Status: DONE. Commit: see `git log -1` on fix/codex-planner-output (subject "feat(prompts): tell each phase what it must not do ...").

- Step 0: `git grep -n Constraints -- tests/fixtures scripts` rc=1, empty output (no fake matches the heading).
- Red (before impl): 7 failed / 15 passed, exactly the 7 predicted tests (planner read-only line, planner constraints heading, verifier no-edit line, 3 final-message-line tests, codex envelope-order test).
- Green: `vitest run tests/runtime tests/control/materialize.test.ts tests/controller` rc=0, 52 files, 575 tests passed. `npm run typecheck` rc=0.
- Files: src/runtime/claude/prompts.ts, tests/runtime/claude/phasePrompts.test.ts (new), tests/runtime/codex/finalExtraction.test.ts (one describe appended). No existing test changed. Mutations left to K4 (not run).
- Outputs: scratchpad/ccloop-K3/{k3-red,k3-green,k3-typecheck}.txt
- Note: I did not run check-known-reds (not requested; full run was green so no roster needed).
