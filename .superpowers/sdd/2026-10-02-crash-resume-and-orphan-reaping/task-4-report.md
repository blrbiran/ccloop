# Task 4 report: classifyOwnerProcess

Commit: 23b71dc `feat(ownership): tell a dead owner from a live one by pid and start time, refusing when unsure`
Scratch: /private/tmp/claude-501/-Users-biran-code-skills-loop-Orca/ece96b67-2433-4082-9abf-3ed4b0a244dd/scratchpad/t4/

## Implementation
`src/ownership/ownerLiveness.ts` per brief/spec 4.1: exports OwnerVerdict, OwnerLivenessDeps, parseLstartUtc, readProcessStart, classifyOwnerProcess, OWNER_START_MARGIN_S=2. ps: `/bin/ps -o lstart= -p <pid>`, TZ=UTC LC_ALL=C, 1000 ms, 16 KiB.
Deviation from brief code (bug fix): the brief's `parseLstartUtc` read the year from `match[7]`, but the regex has 6 groups (month, day, h, m, s, year), so `match[7]` is undefined. Used `match[6]`. The TZ test would have caught it.
Type check: `LivenessVerdict`/`classifyProcessLiveness` match the brief; `OwnerRecord` has `lastAffirmedAt` and `leaseAffirmedAt: string | null` (required, not optional; the Pick-plus-optional parameter type accepts both). No type adaptation needed.
Structure tests: only tests/controller/ownedRunStateWriter.structure.test.ts restricts fileStore imports, and only for runLoop.ts; no trip.

## Tests (tests/ownership/ownerLiveness.test.ts, 12)
Brief's list plus: malformed id variant, "holder started before the lease affirmation => alive" (M4b criterion; startMs/lastAffirmedAt 04:00 and earlier than holder start 04:05:00, lease 04:10), and parseLstartUtc rejects garbage. The brief's child test additionally asserts `dead`.

## RED / GREEN
Red: `vitest run tests/ownership/ownerLiveness.test.ts` => Failed to load url ../../src/ownership/ownerLiveness.js, RC=1 (t4/red.txt).
Green: same command => 12 passed, RC=0 (t4/green.txt). `npx tsc --noEmit -p .` RC=0.

## Mutations (clone t4/t4-mut, one test file)
| M | Mutation | Red lines | Restore (diff, diff --cached bytes) |
|---|---|---|---|
| M4a | parseLstartUtc returns Date.parse(text)/1000 | "parseLstartUtc reads UTC whatever TZ" (1790939103 vs 1790913903); "recycled => dead" (alive vs dead); "rejects text" (NaN vs null) | 0, 0 |
| M4b | drop leaseAffirmedAt from knownAlive | "holder started before the lease affirmation => alive" (dead vs alive); "within the margin of R" (dead vs alive) | 0, 0 |
| M4c | unknown => dead | "EPERM-like unknown => undetermined" (dead vs undetermined) | 0, 0 |

## Files
src/ownership/ownerLiveness.ts, tests/ownership/ownerLiveness.test.ts (committed). This report is not committed (needs `git add -f`).

## Concerns
- Brief's `match[7]` bug, fixed as above; the brief text itself is not amended.
- "dead child is dead" test depends on no pid reuse within ms; negligible.
- OwnerRecord.leaseAffirmedAt is required in the type; spec says legacy records may omit it, hence the optional parameter type (undefined handled by `moment`).
