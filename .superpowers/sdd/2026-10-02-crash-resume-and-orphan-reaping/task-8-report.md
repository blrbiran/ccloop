# Task 8 report: sweep takes killed runs

Status: DONE. Files: src/sweep/sweepRuns.ts, tests/sweep/sweepCrashCandidates.test.ts (new), README.md §3.4.

- Red: new file failed (calls were only ["/fake/root/b-a"]) before implementation.
- Green: sweepCrashCandidates 2/2, sweepRuns 19/19, zeroWrite 2/2, cli 37/37, agentsResume 5/5 (each run alone); tsc --noEmit 0.
- Mutations (clone scratchpad t8-mut, restore diff/cached = 0/0): M8a drop lease-age test red (both tests); M8b accept null lease red (both tests); M8c always print second line red ("no class-b row" test).
- Existing criteria rewritten: none.
- Decisions: class (b) rows that are Orca control run dirs are excluded via isOrcaControlRunDir (spec §4.4); existing banner now counts `eligible.length` (class a) with unchanged text. Comment cites spec §4.4 and that wording is pending human ratification (H8). Existing long comments untouched.
- Note: test D (null lease) also proves R2; rows' fixture paths are not named "run" so the control-dir exclusion is not exercised in the new test (covered by Task 6's own tests of isOrcaControlRunDir).
