# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-07-14

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** ccloop
- This worktree keeps OpenWolf enabled but may omit `.wolf/anatomy.md`, `.wolf/buglog.json`, and `.wolf/memory.md` initially; create those metadata files before following the workflow.
- The CLI bootstrap for V1 uses a minimal TypeScript/Vitest workspace under `src/` and `tests/cli/` with ESM-style `.js` import specifiers in TypeScript source/tests.
- When this agent must modify the separate implementation worktree, Read can inspect it directly but file creation/edits need Bash with absolute paths because Edit/Write are scoped to the agent's own isolated worktree.

- Task 4 persistence stores run metadata with camelCase JSON in `loop-contract.json`, `loop-state.json`, newline-delimited `events.jsonl`, and per-attempt files under `attempts/<n>/`.

- Task 5 workspaces are created as detached git worktrees at `runDir/worktrees/attempt-<n>` and cleaned up with `git worktree remove --force` from the repo root.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-07-14] When running npm commands for the implementation worktree, use `npm --prefix /absolute/worktree/path ...` because this agent's own cwd is a different isolated worktree.

- [2026-07-15] When generating TypeScript files via Python in this implementation worktree, double-escape intended `\n` sequences so JSONL/template literals do not become accidental physical newlines.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
