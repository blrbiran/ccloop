# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-20T17:39:53Z
> Files: 8 tracked | Anatomy hits: 4 | Misses: 3

## .wolf/

- `anatomy.md` — OpenWolf file index for this worktree with short summaries of the files touched in Task 1 (~350 tok)
- `buglog.json` — Append-only log of fixes and test/environment failures discovered while implementing Task 1 (~900 tok)
- `cerebrum.md` — Learned project preferences and do-not-repeat notes, including the Vitest command and worktree dependency layout gotchas (~5000 tok)
- `memory.md` — Session checkpoint log for this worktree's Task 1 implementation steps (~350 tok)

## src/runtime/

- `types.ts` — Core runtime attempt/plan/execute/verify types, including `ExecutionRecovery` for controller-owned interrupted-execute evidence (~1700 tok)

## src/persistence/

- `fileStore.ts` — Filesystem persistence for run state, events, and per-attempt artifacts including `execution-recovery.json` (~2700 tok)

## tests/persistence/

- `fileStore.test.ts` — Persistence regression coverage for run files and execution recovery artifact writing (~1200 tok)

## .superpowers/sdd/

- `task-1-report.md` — Task 1 implementation, TDD evidence, verification results, self-review, and concerns for the D-scenario boundary classification branch (~1200 tok)

## src/controller/

- `runLoop.ts` — Controller orchestration for plan/execute/verify attempts, now emitting `execute_started`, persisting interrupted execute recovery for abort-return-null and abort-throw timeout paths, and finalizing recovery cleanupStatus from the real cleanup outcome (~4600 tok)

## tests/controller/

- `runLoop.integration.test.ts` — End-to-end controller integration coverage for event ordering, timeout/recovery boundaries, terminal states, and execute-started recovery regressions including abort-throw and cleanup-failure recovery contracts (~9800 tok)

## docs/superpowers/

- `plans/2026-07-20-d-scenario-boundary-classification.md` — Approved D-scenario implementation plan with Task 2 TDD steps and exact scope boundaries (~4500 tok)
- `specs/2026-07-20-d-scenario-boundary-classification-design.md` — Design/spec for D boundary evidence, including `execute_started` semantics and `execution-recovery.json` shape (~3500 tok)

## validation/v1/lib/

- `evidence.ts` — Evidence collection, artifact/observation parsing, D-boundary classification helpers, trust-boundary validation for `execution-recovery.json`, and `ReclassifiedReview` schema/validation for immutable historical review preservation in validation V1 (~5200 tok)

## validation/v1/scripts/

- `finalize-review.ts` — Validation CLI for writing immutable `review.json` once or explicit `review-reclassified.json` artifacts with original/reclassified reviews, boundary classification, rule version, and Layer A evidence references (~1800 tok)

## tests/validation/

- `evidence.test.ts` — Synthetic evidence fixtures plus validation/evidence regression coverage for artifact collection, D-boundary mapping, malformed recovery evidence, verify/recovery-backed trust boundaries, execution-json-only recovery classification, immutable `review-reclassified.json` output, and CLI behaviors (~15200 tok)

## .superpowers/sdd/

- `task-2-report.md` — Task 2 implementation report plus reviewer fix-wave notes, verification results, and self-review for execute boundary recovery evidence (~1700 tok)
- `task-3-report.md` — Task 3 implementation report plus reviewer fix-wave notes for malformed recovery evidence and historical verify-backed boundary disqualification (~2100 tok)
- `task-4-report.md` — Task 4 implementation report covering immutable historical review preservation, explicit reclassification output, verification, and self-review (~1800 tok)
