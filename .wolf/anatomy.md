# Anatomy

- validation/v1/lib/scenarios.ts
  - Scenario catalog and contract rendering helpers for validation V1, including Scenario A-only execution-policy override enforcement.
  - ~300 lines / medium token cost.

- tests/validation/contracts.test.ts
  - Focused Vitest coverage for scenario rendering, non-A override rejection, and render-contract CLI behavior.
  - ~220 lines / medium token cost.

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

- validation/v1/lib/a04.ts — Builds A-04 deterministic preflight results with main-branch gating, spec-6.1 read-only preservation inspection, preserved verified-checkout approval packages, and final overlap/on-disk contract guards (~1800 tok)

- validation/v1/scripts/prepare-a04.ts — CLI for non-paid A-04 preparation and approval package output (~400 tok)

- tests/validation/prepareA04.test.ts — Covers A-04 main-branch gating, read-only inspection, preserved verified checkout binding, spec-locked phase order, explicit approval-package fields, overlap guards, and final on-disk contract gating (~2200 tok)
