# E1 security review — `ccloop unlock` (commits e7b288e, a4f1fb1)

Independent review. Verified in a `git clone --local` mutant copy
(`/tmp/.../scratchpad/mutant-e1`, source identical to HEAD since a4f1fb1 only edits test-message
strings) plus direct Node reproductions. Copy restored and proven clean:
`git -C mutant-e1 diff | wc -c` -> `0`, `git diff --cached | wc -c` -> `0`.

## CRITICAL — TOCTOU: the unlink is unconditional-by-path, with no re-verification at delete time

`src/unlock/unlockCommand.ts:75-79` (the "dead" branch):
```
if (inspection.state === "dead") {
    await unlink(ownerTransferLockPath(runDir));
    stdout(`removed  holder=${inspection.holder} was not alive`);
    return 0;
}
```
and the `--force` branch, `unlockCommand.ts:96-104`:
```
if (options.expectedDigest !== inspection.digest) { ... return 1; }
await unlink(ownerTransferLockPath(runDir));
```

Both branches unlink by **path only**. `inspection` (holder, pid, digest) was captured once, at the
top of `unlockOwnerTransferLock`, by `inspectOwnerTransferLock` (`src/unlock/inspectLock.ts:56`).
Nothing re-reads or re-checks the file between that read and the `unlink` call. If the file on disk
changes in that window — is deleted and **re-acquired by a new, live process** for the same run —
the command deletes the new holder's lock while that holder is alive.

This is not a hypothetical the code failed to anticipate: this exact bug class was already found
and fixed once in this file, for the *release* path, under **human ruling 62**
(`src/persistence/fileStore.ts:978-1013`, `classifyLockAtRelease`). That fix's own comment records
the prior incident (`pointB-design.md §6.1`, commit `dbac288`): "release() used to unlink `lockPath`
unconditionally: whatever file bore that name at that instant was deleted, whether or not it was
the file this holder published." The fix was to stat the *inode* (`dev`+`ino`) of the handle this
process actually published and compare it against what is on disk immediately before unlinking —
not a content digest taken earlier, an identity check taken at the moment of deletion.
`unlockCommand.ts` reintroduces the exact anti-pattern ruling 62 removed: it deletes by path, and
where it has any check at all (`--force`), that check is against a digest captured **before** the
race window, not at unlink time.

### Concrete construction (reproduced, not theoretical)

Script: `/private/tmp/claude-501/.../scratchpad/toctou_proof.ts` (calls the real exported
`inspectOwnerTransferLock`, `ownerTransferLockPath`, and Node's `unlink` — the exact sequence
`unlockCommand.ts`'s "dead" branch runs, verbatim).

1. Spawn a real child process (`node -e 'setInterval(()=>{},1000)'`). Confirm alive:
   `process.kill(pid, 0)` throws nothing, immediately before the scenario.
2. Write `.owner-transfer.lock` naming a genuinely dead pid (`pid:999999`, confirmed not alive).
3. Call the real `inspectOwnerTransferLock(runDir)` — returns `{ state: "dead", pid: 999999, ... }`.
4. **The race, injected explicitly to stand in for a concurrent writer**: overwrite the lock file to
   name the real live child's pid.
5. Confirm the child is *still* alive right before deleting (`process.kill(pid, 0)` — proof the
   probe is not stale, per the method rules).
6. Run the literal production statement: `await unlink(ownerTransferLockPath(runDir))`.
7. Confirm the child is *still* alive right after (proves it didn't exit on its own).

Actual output:
```
PRE-CHECK  live child pid: 77506 alive now? true
INSPECTION: { state: 'dead', holder: 'pid:999999', pid: 999999, digest: '...' }
MID-CHECK  live child pid: 77506 alive now? true
POST-CHECK live child pid: 77506 alive now? true
RESULT: live holder's lock file gone? true  | live holder still alive throughout? true
VULNERABILITY CONFIRMED
```
The live holder's lock was deleted while the live holder was provably alive immediately before and
immediately after the deletion. This directly bypasses human ruling 70 board C-e / the commit
message's claim ("A live holder's lock is never removed, --force included").

### How real is the window

Between `inspectOwnerTransferLock`'s `readFile` resolving and the later `unlink()` call there is no
further file I/O and no further `await` — only synchronous branching on `inspection.state`. That
sounds narrow, but "narrow" is measured in JS microtask ticks plus libuv threadpool queuing/
scheduling latency for both the prior `readFile` and the coming `unlink`, not in guaranteed
nanoseconds; under real load (a busy event loop, a contended threadpool) this can be milliseconds,
and this project's own concurrent actor — `tryRecoverStaleOwnerTransferLock` inside another live
`ccloop` process doing exactly a steal-then-reacquire sequence on the same path — is precisely the
kind of writer that can land in it. The scenario above proves the *mechanism* (no re-check exists);
it does not need a contrived attacker to be dangerous, an ordinarily-timed automatic recovery in a
second process racing a human's `ccloop unlock` on the same stale-looking lock is enough.

**Disposition is not mine to make** — flagging only: fixing this the way ruling 62 already fixed the
sibling bug (fstat the handle you're about to touch, or at minimum re-`stat`/re-digest the file
immediately before the `unlink` and abort on mismatch, for *both* the `dead` and `--force` branches)
looks like the natural remedy, given the precedent already in this codebase.

## Point 2 — does `--expect`'s digest close the TOCTOU window? No, it only narrows a different one.

Two different gaps, both real, and it's important not to conflate them:

- **The gap `--expect` genuinely closes**: the *human decision-making window*, between the moment an
  operator reads a refusal (which prints the digest, `unlockCommand.ts:41-45`) and the moment they
  later type `--force --expect <digest>` as a **separate process invocation**, possibly minutes or
  hours afterward. If the lock changed in that interval, the freshly-computed `inspection.digest` in
  the new invocation won't match what the operator typed, and it's refused (`unlockCommand.ts:97`).
  This is real and valuable — it is exactly ruling 73's "proves the operator looked at THIS lock."
- **The gap it does not close**: *within one invocation*, between that invocation's own
  `inspectOwnerTransferLock` read and its own `unlink` call. The digest compared at
  `unlockCommand.ts:97` is `inspection.digest` — captured from the *same* read at the top of the
  function, not a fresh read taken at unlink time. So the `--force` branch has exactly the same
  unconditional-unlink-by-path structure as the `dead` branch (see CRITICAL above); the only
  difference is that reaching it requires a human-typed credential, which does nothing to protect
  the sub-millisecond-to-millisecond window inside that one invocation.
- **The `dead` (non-forced) branch has neither protection**: no digest check of any kind precedes its
  `unlink`. It is the branch demonstrated above.

Severity: same CRITICAL bucket as above — this is elaboration of the same root cause (unlink by path
with a decision made from a stale read), not a separate independent bug.

## Point 1 — live-holder prohibition: no path found that deletes a *content-stable* live lock; but the liveness predicate has an unreached-escape-hatch failure mode

No construction was found where `unlockOwnerTransferLock` deletes a lock whose file *content did not
change* between read and delete and whose named pid is alive — `isProcessActive` correctly returns
`true` for a genuinely running pid, and the `alive` branch (`unlockCommand.ts:69-73`) refuses before
any credential is even considered, with no `--force` line printed, exactly as designed.

However, three related inputs all make `isProcessActive` report **falsely alive**, and because
`alive` is checked *before* `--force` is ever consulted, each produces a lock with **no escape hatch
at all** — worse than the `{not json` + no-staged-artifacts case the design docs call out as the
reason `--force` exists (that one *does* have a `--force` route: see point 4). This is an
availability/DoS gap, not itself a data-loss path, but it directly undercuts the documented rationale
for `--force` ("the hatch exists for locks that are permanently stranded").

- **`pid:0`**. `/^pid:(\d+)$/` matches `"pid:0"`; `parsePid` returns `0`. `process.kill(0, 0)` signals
  the caller's own process group and does not throw for the calling process. Reproduced directly:
  `isProcessActive(0)` -> `true`. A lock file `{"holderProcessInstanceId":"pid:0", ...}` is therefore
  classified `alive` forever, by both readers, with no way to remove it short of manual filesystem
  surgery outside the tool.
- **Overflowing pid** (`pid:9999999999999999999999999`, all-digit so it passes the regex).
  `Number.parseInt` yields `1e+25`; `process.kill(1e+25, 0)` throws `TypeError
  ERR_INVALID_ARG_TYPE`, whose `.code` is `"ERR_INVALID_ARG_TYPE"`, not `"ESRCH"`. `isProcessActive`'s
  catch treats every non-`ESRCH` code as "still active" — reproduced directly, `isProcessActive`
  returns `true`. Same permanently-`alive`, no-escape outcome.
- **EPERM (pid owned by another user, reachable via ordinary pid recycling on a shared/multi-tenant
  host)**: not independently reproduced here (would need a process the reviewing user cannot signal),
  but it is the identical code path as the two cases above — `process.kill` throws a non-`ESRCH`
  error, `isProcessActive` returns `true`. If a crashed holder's pid is later reused by a process
  owned by a different user (or root), the lock becomes permanently `alive` with no `--force` escape,
  through entirely ordinary OS pid recycling, no attacker required. This is the most realistic of the
  three and is not mentioned anywhere in the design docs, which only analyze the `{not json`-with-no-
  artifacts stranding case as needing `--force`.

Negative pids (`pid:-1`) cannot be constructed: the regex requires `\d+` with no sign, so
`parsePid("pid:-1")` returns `null` and the state is `unrecognized-holder`, not `alive` — that state
*does* have a `--force` route.

Severity: **Important**. Not data loss (nothing gets deleted that shouldn't), but a real,
unaddressed way for `ccloop unlock` to be permanently unable to clear a lock, defeating the stated
purpose of the `--force` hatch for exactly the class of case (unrecognizable/misbehaving liveness
answer) it was built for.

## Point 3 — is `--expect <sha256>` doing ruling 73's job?

Yes, for the thing it can actually prove, but that thing is narrower than "the operator looked at
this lock and is authorizing removal of what they saw." What it proves is: *the bytes present at
`--force` invocation time equal the bytes the digest was computed from* — which could have been
learned by the operator reading the refusal output (the intended path, printed unprompted at
`unlockCommand.ts:41-45`), or copy-pasted with zero comprehension, or computed independently via
`shasum` without ever reading the content. It buys real protection against one specific mistake:
running a stale `--force --expect <old-digest>` command against a lock that has since changed (e.g.,
a different process re-acquired it) — that mismatch is caught. It buys nothing against an operator
who reflexively copies the printed digest back without looking at `holder`/`pid`/`reason` in the
same output (the message is right there, but nothing stops copy-paste), and — per point 2 — it buys
nothing against a change happening *within* the same invocation, between its own read and its own
unlink. Net: real credential, narrower guarantee than "looked at it," not theatre.

## Point 4 — the recorded disagreement claim

Enumerated by cross-referencing `tryRecoverStaleOwnerTransferLock` (`fileStore.ts:914-937`) against
`inspectOwnerTransferLock`'s six states, on identical lock bytes:

| lock content | (a) redline recovery | (b) `ccloop unlock` (no `--force`) | (b) with `--force --expect <digest>` |
|---|---|---|---|
| absent (ENOENT) | proceeds (no lock) | `absent`, exit 0 | n/a |
| holder = live pid | refuses (busy) | `alive`, refuses, **no `--force` line printed** | still refused — alive is checked before force |
| holder = dead pid | **steals**, no confirmation | **removes**, no confirmation (see CRITICAL) | n/a, already removed above |
| holder unrecognized (`parsePid` null, non-empty) | **steals** immediately | refuses, digest given | removes |
| unreadable JSON (`unparseable`), staged artifacts present | **steals** | refuses, digest given | removes |
| unreadable JSON, **no** staged artifacts | leaves in place (`return false`) | refuses, digest given | **removes** |
| read error, not ENOENT (`file-unreadable`) | **throws** (propagates as a hard error, not a silent leave) | refuses, **no digest exists, so `--force` can never reach it** | not constructible — no digest to type |

Confirming/refuting the recorded claim ("`{not json` with no staged artifacts is the ONE state where
both give up, stranding the lock on disk permanently"): **partially confirmed, with a material
correction**. It is the one state where (a) leaves it in place *and* (b)'s default (no `--force`)
also refuses — that part is correct and reproducible from the code as read. But it is **not**
permanent for (b): the code's own comment says as much ("That intersection is the entire reason
`--force` exists") — a human running `ccloop unlock <runDir> --force --expect <digest>` **can**
remove it, since `unparseable` carries a digest. So "stranding the lock on disk permanently" is true
only of the *unattended* path (a); for (b) it is "stranded pending a human running `--force`," which
is the documented, intended behavior, not a bug.

What the claim **misses**: `file-unreadable` is strictly worse and is not called out anywhere in the
docs I found. There, (b) has **no `--force` route at all** — no digest exists, so `--force` is
structurally unreachable (confirmed by the type: `LockInspection`'s `file-unreadable` variant has no
`digest` field, `inspectLock.ts:44-46`) — and (a) does not "leave it in place" either, it **throws**,
propagating a hard error to whatever called `tryRecoverStaleOwnerTransferLock`'s caller. That is a
second, more severe "both give up" state than the one that's documented, and unlike the documented
one it has genuinely no operator escape through this tool (short of `chmod`-ing the file readable
first, which is outside `ccloop`'s own remediation path). Recommend flagging this gap to whoever owns
point-C's disposition record — not filing it myself.

## Point 5 — filesystem surface beyond the intended unlink

- **Path traversal / arbitrary `runDir`**: `parseArgs`'s `unlock` branch (`src/cli.ts:75-121`) takes
  the run directory as a raw positional with no containment check (no resolution against a root, no
  rejection of `..`). This matches `run`/`resume`/`sweep --root`, none of which sandbox their
  directory arguments either (Rule 11: consistent with existing convention). Given `ccloop unlock` is
  invoked directly by a human operator who already has unrestricted filesystem access equal to what
  `unlink` could do anyway, this is not a privilege boundary the tool is trying to enforce elsewhere,
  and I found nothing that makes `unlock` uniquely dangerous here relative to the rest of the CLI. No
  finding at Critical/Important; noting only for completeness per the brief.
- **Symlinked `runDir` or symlinked lock file**: `readFile` (in `inspectOwnerTransferLock`) follows
  symlinks to read content, but `unlink` (both here and in Node generally) removes the **directory
  entry**, not the symlink's target — so even a `.owner-transfer.lock` replaced with a symlink to an
  arbitrary file elsewhere cannot cause that target to be deleted via this code path; only the
  symlink itself is removed. No finding.
- **Lock path is a directory**: `unlink()` on a directory throws (`EISDIR`/`EPERM`), which is
  unhandled here — `unlockOwnerTransferLock` would reject with an uncaught rejection rather than a
  clean refusal message. Nothing is deleted (unlink fails closed by OS behavior), so this is not a
  data-loss or lock-stealing issue — it's a Minor robustness/UX gap (an ugly stack trace instead of a
  clean `refused` line) if `.owner-transfer.lock` is ever replaced by a directory of that name.

## Summary by severity

- **CRITICAL (1 root cause, two manifestations)**: unconditional `unlink(path)` in both the `dead`
  and `--force` branches of `unlockCommand.ts`, decided from a lock inspection taken before the
  delete rather than re-verified at delete time. Reproduced: a lock naming a provably-alive pid is
  deleted through the `dead` branch when the file is replaced between inspection and unlink. The
  `--force` branch has the identical structural gap (digest compared against a stale read, not a
  fresh one at unlink time); not independently reproduced but mechanically identical, argued from
  the code at `unlockCommand.ts:88-104`. This is the same bug class the project already fixed once,
  for `release()`, under human ruling 62, using inode identity rather than a point-in-time read —
  that fix was not applied here.
- **Important (1)**: the liveness predicate (`isProcessActive`) reports "alive" for `pid:0`, for
  regex-legal but out-of-range pids, and (analytically, same code path) for pids owned by a different
  user (EPERM) — and because `alive` is gated before `--force` is even considered, all three produce
  a lock `ccloop unlock` can never remove, contradicting the documented purpose of `--force` as the
  escape hatch for permanently-stranded locks.
- **Important (1)**: `file-unreadable` is a second "both give up" state beyond the one recorded in
  the design docs, and it is strictly worse than the documented one — it has no `--force` route at
  all (no digest exists), whereas the documented `{not json`/no-artifacts case does have one.
- **Minor (1)**: `unlink()` on a lock path that is a directory throws unhandled rather than producing
  a clean refusal.
- **No finding**: path traversal on `runDir` (matches existing CLI convention, not unique to this
  command); symlinked lock file (unlink doesn't follow, target is safe); negative pids (rejected by
  regex before reaching liveness logic).

## Commands run and outcomes

```
git log --oneline -15                                  # confirmed scope: e7b288e, a4f1fb1 on top of 1441849
git diff 1441849..HEAD --stat                           # 7 files, +804/-5
git show e7b288e --stat / git show a4f1fb1 --stat        # commit messages + file lists read in full
git diff 1441849..HEAD -- src/persistence/fileStore.ts   # confirmed the 3 new exports, no behavior change
cat src/unlock/inspectLock.ts, src/unlock/unlockCommand.ts, relevant fileStore.ts ranges, src/cli.ts
rtk proxy git -C mutant-e1 status --porcelain            # clean except pre-existing node_modules symlink
node -e '...'                                            # isProcessActive(0)=true, pid:-1 regex rejects,
                                                           # huge-pid kill() throws ERR_INVALID_ARG_TYPE
                                                           # (non-ESRCH) -> isProcessActive returns true
ECC_GATEGUARD=off DISABLE_OMC=1 npx tsx toctou_proof.ts   # TOCTOU reproduced against mutant-e1's real
                                                           # exported inspectOwnerTransferLock/unlink code;
                                                           # live child (kill-0 verified alive immediately
                                                           # before and after) had its lock deleted
rtk proxy git -C mutant-e1 diff | wc -c                   # 0
rtk proxy git -C mutant-e1 diff --cached | wc -c          # 0
rtk proxy git -C mutant-e1 status --porcelain             # only untracked node_modules (pre-existing symlink)
```

No source or test file in the main repo was modified. All construction happened in the
`git clone --local` mutant copy (import-only, no writes into its tree) and in OS tmpdir.
