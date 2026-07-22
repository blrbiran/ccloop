# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-07-22

## User Preferences

- 后续与用户讨论 ccloop 时使用中文，除非用户明确要求其他语言。
- 后续本项目运行测试、validation script、scenario invocation 时，默认直接使用 `ECC_GATEGUARD=off`。
- 后续本项目运行测试、validation script、scenario invocation 时，也默认直接使用 `DISABLE_OMC=1`。

## Key Learnings

- This worktree starts without `.wolf/anatomy.md`, `.wolf/cerebrum.md`, and `.wolf/memory.md`; create them when a task explicitly requires OpenWolf bookkeeping.
- In this repo, `.wolf/anatomy.md`, `.wolf/memory.md`, and `.wolf/cerebrum.md` are gitignored, so any task that must commit them needs `git add -f` on those exact paths.

## Do-Not-Repeat

- [2026-07-18] For non-PDF Read calls, omit `pages` entirely; never pass an empty string.
- [2026-07-20] Task briefs may mention Jest-style flags, but this repository runs Vitest; use `npm test -- <test-path>` or another Vitest-supported form instead.
- [2026-07-21] When working in an isolated Claude Code agent worktree, do not use `git -C <shared-worktree>`; run git from the target worktree itself if git work is required.

## Decision Log

- [2026-07-22] Operator-facing stale-boundary docs must stay narrow: `boundary-analysis.json` and `reconciliation-record.json` are descriptive controller-owned artifacts only, and `stale-confirmed` remains deny-by-default without authorizing continuation, cleanup, or historical evidence rewrites until a later ownership/resume design proves stronger conditions.
