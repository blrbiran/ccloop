# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-07-21T00:29:15Z
> Files: 8 tracked | Anatomy hits: 4 | Misses: 3

## .wolf/

- `anatomy.md` — OpenWolf file index for this worktree with short summaries of the files touched in Task 1 (~350 tok)
- `buglog.json` — Append-only log of fixes and test/environment failures discovered across the D-boundary implementation and final review fix waves (~1100 tok)
- `cerebrum.md` — Learned project preferences and do-not-repeat notes, including the Vitest command, worktree dependency layout gotchas, and Scenario D recovery-boundary contradiction rules (~5200 tok)
- `memory.md` — Session checkpoint log for this worktree's Task 1 implementation steps (~350 tok)

## src/runtime/

- `types.ts` — Core runtime attempt/plan/execute/verify types, including `ExecutionRecovery` for controller-owned interrupted-execute evidence (~1700 tok)

## src/persistence/

- `fileStore.ts` — Filesystem persistence for run state, events, and per-attempt artifacts including `execution-recovery.json` (~2700 tok)

## tests/persistence/

- `fileStore.test.ts` — Persistence regression coverage for run files and execution recovery artifact writing (~1200 tok)

## src/controller/

- `runLoop.ts` — Controller orchestration for plan/execute/verify attempts, now emitting `execute_started`, persisting interrupted execute recovery for abort-return-null and abort-throw timeout paths, and finalizing recovery cleanupStatus from the real cleanup outcome (~4600 tok)

## tests/controller/

- `runLoop.integration.test.ts` — End-to-end controller integration coverage for event ordering, timeout/recovery boundaries, terminal states, and execute-started recovery regressions including abort-throw and cleanup-failure recovery contracts (~9800 tok)

## docs/superpowers/

- `plans/2026-07-20-d-scenario-boundary-classification.md` — Approved D-scenario implementation plan with Task 2 TDD steps and exact scope boundaries (~4500 tok)
- `specs/2026-07-20-d-scenario-boundary-classification-design.md` — Design/spec for D boundary evidence, including `execute_started` semantics and `execution-recovery.json` shape (~3500 tok)

## validation/v1/lib/

- `evidence.ts` — Evidence collection, artifact/observation parsing, D-boundary classification helpers, raw/recovery-backed Layer A contradiction checks, trust-boundary validation for `execution-recovery.json`, terminal-attempt attempt-path resolution for Scenario D evidence, and `ReclassifiedReview` schema/validation for immutable historical review preservation in validation V1 (~5600 tok)

## validation/v1/scripts/

- `finalize-review.ts` — Validation CLI for writing immutable `review.json` once or explicit `review-reclassified.json` artifacts with original/reclassified reviews, boundary classification, rule version, and Layer A evidence references (~1800 tok)

## tests/validation/

- `evidence.test.ts` — Synthetic evidence fixtures plus validation/evidence regression coverage for artifact collection, D-boundary mapping, recovery-backed contradiction cases, malformed recovery evidence, verify/recovery-backed trust boundaries, terminal-attempt attempt-2 recovery classification, execution-json-only recovery classification, immutable `review-reclassified.json` output, and CLI behaviors (~16000 tok)

## .superpowers/sdd/

- `task-1-report.md` — Task 1 implementation, TDD evidence, verification results, self-review, and concerns for the D-scenario boundary classification branch (~1200 tok)
- `task-2-report.md` — Task 2 implementation report plus reviewer fix-wave notes, verification results, and self-review for execute boundary recovery evidence (~1700 tok)
- `task-3-report.md` — Task 3 implementation report plus reviewer fix-wave notes for malformed recovery evidence and historical verify-backed boundary disqualification (~2100 tok)
- `task-4-report.md` — Task 4 implementation report covering immutable historical review preservation, explicit reclassification output, verification, and self-review (~1800 tok)
- `task-5-brief.md` — Task 5 brief for doc/handover alignment, OpenWolf bookkeeping, verification, commit, and reporting requirements (~1400 tok)
- `task-5-report.md` — Task 5 implementation report covering operator-doc alignment for the implemented D-boundary rule, verification, commit, and self-review (~1600 tok)
- `final-branch-fix-report.md` — Final whole-branch review fix report covering the raw Layer A contradiction correction, recovery-backed contradiction follow-up, porcelain -z rename/copy parser fix, terminal-attempt evidence-path correction, focused regressions, verification, and final commit (~2300 tok)

## docs/handover/

- `ccloop-handover.md` — Operator handover snapshot for accepted V1 evidence and takeover guidance, now noting the implemented D-01 reclassification target while preserving immutable historical review truth (~5200 tok)


## validation/v1/

- `README.md` — Operator guide for evidence-first V1 validation scenarios, now documenting the implemented D-boundary rule, immutable reclassification rule, and explicit `review-reclassified.json` command flow (~4500 tok)

