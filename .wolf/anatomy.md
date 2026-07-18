# Anatomy

- validation/v1/lib/scenarios.ts
  - Scenario catalog and contract rendering helpers for validation V1.
  - ~260 lines / medium token cost.

- tests/validation/contracts.test.ts
  - Focused Vitest coverage for scenario rendering and render-contract CLI behavior.
  - ~200 lines / medium token cost.

- .superpowers/sdd/task-1-brief.md
  - Task 1 brief with exact TDD steps and commit/report requirements.
  - ~160 lines / low token cost.

- .wolf/cerebrum.md
  - OpenWolf long-term learnings, preferences, and do-not-repeat notes.
  - ~60 lines / low token cost.

- .wolf/buglog.json
  - Session bug log entries for fixes and failures.
  - JSON array / low token cost.

- .wolf/memory.md
  - Session action log with short checkpoint entries.
  - Append-only markdown table / low token cost.

- validation/v1/lib/a04.ts
  - A-04 deterministic preflight helper that enforces the fixed approval envelope and checks repo-root cleanliness before and after deterministic verification.
  - ~280 lines / medium token cost.

- validation/v1/scripts/prepare-a04.ts
  - CLI wrapper that accepts the A-04 flags, rejects non-approved execution-policy values, and prints approval-package JSON only.
  - ~120 lines / low token cost.

- tests/validation/prepareA04.test.ts
  - Focused Vitest coverage for fixed-envelope refusal, existing-path refusal, main-checkout cleanliness invariants, preflight ordering, and CLI stdout-only behavior.
  - ~360 lines / medium token cost.
