# E1 fix-round review (scoped to `3f6a61c`) — silent-failure / swallowing audit

Reviewer: third, independent reviewer. Scope: the FIX commit `3f6a61c` only
(`fix(unlock): re-check WHICH FILE before deleting, and stop guessing liveness`),
diffed against `e7b288e`. The original implementation was reviewed by two
prior, independent reviewers (`E1-review-typescript.md`, `E1-review-security.md`);
their findings are not re-litigated here. This report evaluates only whether the
fix itself introduced new swallowing, misclassification, or lost-diagnostic
defects, per the brief.

All claims below were verified independently — not accepted from the commit
message, the prior reviews, or the implementer's account — against a clean
`git clone --local` mutation copy (`mutant-e1b`, confirmed at `3f6a61c`,
restored clean after every experiment: `git diff | wc -c` = 0 and
`git diff --cached | wc -c` = 0, checked repeatedly throughout).

## Invariant check (required by the brief)

`tryRecoverStaleOwnerTransferLock` in `src/persistence/fileStore.ts`, frozen by
human ruling 50: confirmed byte-for-byte unchanged. `git diff e7b288e..3f6a61c
-- src/persistence/fileStore.ts` produces **zero lines of output** — the file
is not touched at all in this commit, which is the strongest form of "frozen."

## Findings

### 1. [Important] `handle.close()` inside `finally` can replace a real result — success or a real error — with its own failure

- Location: `src/unlock/inspectLock.ts:109-116`, inside `inspectOwnerTransferLock`:
  ```
  const handle = await open(ownerTransferLockPath(runDir), "r");
  try {
    const stats = await handle.stat();
    identity = { dev: stats.dev, ino: stats.ino };
    contents = await handle.readFile();
  } finally {
    await handle.close();
  }
  ```
  The outer `catch` (`inspectLock.ts:117-124`) has no way to distinguish "the
  read failed" from "the read succeeded but the close failed" — both land in
  the same branch and are reported as `state: "file-unreadable", reason:
  <whatever error surfaced last>`.

- Verified independently, not assumed: constructed a fake `node:fs/promises`
  module (via `vi.mock`, in `mutant-e1b`, deleted after) whose `open()` returns
  a handle where `stat()` and `readFile()` both **succeed** (holder
  `pid:1`, valid JSON) but `close()` **rejects** with a simulated `EIO`. Result:
  ```
  {"state":"file-unreadable","reason":"simulated close failure"}
  ```
  A fully successful read — one that would otherwise resolve to `dead` /
  `alive` / `liveness-unknown` with a valid digest — is silently converted into
  the one state the design itself calls out as uniquely bad: `file-unreadable`
  is "the only state with no digest, and therefore the only one human ruling
  73's `--force` cannot reach" (`inspectLock.ts:84-87`). A transient `close()`
  fault on an otherwise-perfectly-readable lock takes away the escape hatch
  human ruling 74 exists to guarantee.

- Also verified the error-racing case explicitly named in the task brief: made
  `stat()` throw a real, actionable error (`EACCES`, "permission denied
  reading run dir") **and** `close()` throw a different one (`EBADF`, "close()
  also failed"). Result:
  ```
  {"state":"file-unreadable","reason":"close() also failed"}
  ```
  The original, actionable error (`EACCES` — a permissions problem the
  operator can fix) is discarded; the operator is told about a synthetic
  `close()` failure that has nothing to do with the actual problem.

- This is exactly the hazard `fileStore.ts` has a written position on
  (`classifyLockAtRelease` / the `release()` comment at
  `src/persistence/fileStore.ts:1006-1009`: "MUST NOT THROW... a rejection here
  would replace whatever error is already in flight"). `inspectLock.ts`'s own
  header cites `fileStore.ts` and human ruling 62 as precedent for the
  dev/ino technique, but does not replicate — or even discuss — fileStore's
  discipline for the close-swallow hazard. Compare `fileStore.ts:1134-1137`
  (`release()`), which computes the verdict **before** closing and calls
  `handle.close()` as a plain, unguarded, sequential `await` outside any
  `try/finally` that could let it clobber an already-computed result — a
  different, and here safer, shape than "compute the result and close it,
  both inside the block whose `finally` can swap in a different error."

- Likelihood: low (a read-mode file descriptor's `close()` rarely fails on
  local disks; NFS/fault-injected/exotic filesystems are the plausible
  trigger). Impact when it does fire: an unnecessary, unrecoverable-by
  `--force` refusal for a lock that was actually fully readable — not data
  loss, not a wrong deletion, but a diagnosability and availability
  regression on the fail-closed path itself.

- Fix direction (not mine to decide, offered for the record): capture
  `stats`/`contents` inside the `try`, and treat a `close()` failure inside
  `finally` the way `fileStore.ts` treats it elsewhere in this codebase —
  either swallow it explicitly (with a comment saying why, per the codebase's
  own convention) if the read already succeeded, or at minimum preserve the
  original error rather than letting the `finally`'s throw win.

### 2. [Important] `removeLockIfUnchanged`'s two catches discard the errno entirely; the operator-facing message for `unremovable` carries zero diagnostic content

- Location: `src/unlock/unlockCommand.ts:62-84`:
  ```
  try {
    onDisk = await stat(lockPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unremovable";
  }
  ...
  try {
    await unlink(lockPath);
  } catch {
    return "unremovable";
  }
  ```
  Both catches collapse every non-ENOENT errno — `EACCES`, `EPERM`, `EIO`,
  `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`, and anything else the platform can
  produce — into the single string `"unremovable"`, with the original `Error`
  object (message, `code`, `errno`, `syscall`) discarded at the return
  statement. The `unlink` catch is a bare `catch {}` — it does not even bind
  the error to a name.

- Verified independently: mocked `stat` to throw `EACCES` ("permission denied
  reading run dir") and called `removeLockIfUnchanged` directly. Result:
  `"unremovable"` — no trace of which errno produced it.

- Downstream, `reportFailedRemoval` (`unlockCommand.ts:169-187`) turns
  `"unremovable"` into exactly one line, for every one of those distinct
  underlying failures:
  ```
  stderr("refused  the lock could not be removed; nothing was deleted");
  ```
  No errno, no path, no syscall name. Contrast this with its sibling branch
  two lines above, `"changed"`, which does explain itself ("the file now at
  that name is not the one that was inspected"). An operator who hits this
  because of a permissions problem (fixable: `chmod`/`chown`) cannot tell that
  apart, from this output alone, from an I/O error, a filesystem mounted
  read-only, or something else entirely. They have to go find the errno by
  other means (strace, manual `stat`/`unlink`, re-running with extra
  instrumentation) that this command already had and threw away.

- This is a genuine loss of information relative to what the codebase
  considers correct elsewhere: `fileStore.ts`'s analogous three-way verdict
  (`ours` / `foreign` / `gone` / `unverified` at `classifyLockAtRelease`,
  `fileStore.ts:1017-1028`) keeps `"unverified"` as its own bucket for the
  genuinely-unknown case, and even that bucket's audit detail
  (`SKIPPED_RELEASE_DETAILS.unverified`, `fileStore.ts:1041`) says more than
  this command's `"unremovable"` line does — it at least names what could not
  be checked ("could not be checked against the inode this process
  published"). `unlockCommand.ts` has no analogous audit-detail table and
  prints nothing beyond the fixed string.

- Not a finding: the *catching itself* is not wrong — letting `stat`/`unlink`
  rejections escape a delete path would (per the code's own comment) be worse,
  turning "nothing was deleted" into an unhandled rejection. The finding is
  specifically that the errno is captured and then thrown away rather than
  surfaced, at the one place (a human-typed CLI command, ruling 70 board C-e)
  where an operator is standing by to read exactly that kind of detail and
  act on it.

- Fix direction (not mine to decide): include `error.code` (and ideally
  `error.message`) in the `"refused"` line for `unremovable`, the way
  `file-unreadable`, `liveness-unknown`, and `unparseable` already do
  (`unlockCommand.ts:103,133-134`) for their own reasons.

### 3. `reportFailedRemoval`'s `"gone"` → `stdout` + exit 0 — no finding at Important/Critical

Checked per the brief's specific instruction to attack this. `removeLockIfUnchanged`'s
`stat` catch already distinguishes real ENOENT (`"gone"`) from every other
errno (`"unremovable"`, finding 2 above) *before* returning `"gone"` — so
`"gone"` is never produced by a masked failure; when it fires, the file really
is off disk. The audit line (`"absent   the lock was already off disk by the
time it would have been removed"`) does not claim `removed`, matching the
design constraint stated in the brief, and matches what `unlockCommand.ts:166-168`'s
own comment states as the reason. I looked for a race in which the dead-holder
path's TOCTOU window (documented, not closed — `unlockCommand.ts:55-57`) could
let `"gone"` paper over an actual live-holder deletion, and did not find one:
the identity check (`dev`/`ino`) runs *before* the `stat` that could produce
`"gone"` even reaches its own try block for a *second* time — `"gone"` can only
come from the `stat` at the top of `removeLockIfUnchanged`, which happens
before the identity comparison, so a live holder's freshly-republished lock
at that name is caught by `"changed"`, not `"gone"` (confirmed by the existing
`vi.doMock` test — see finding 5). I am not filing a finding here; flagging
that I looked, per Rule 12 (fail loud about what I checked and found nothing
at severity, not just what I found).

### 4. `classifyHolderLiveness` (`pid < 1` guard, three-verdict split) — no finding

Checked per the brief's specific instruction to attack this. `process.kill(pid,
0)` has exactly one errno that means "the target does not exist": `ESRCH`.
There is no other errno on POSIX that means "definitely dead" — `EPERM` means
the process (or process group) exists but the caller lacks permission to
signal it, `EINVAL` doesn't apply because the signal is `0`. So the `unknown`
bucket (`inspectLock.ts:71-73`) does not swallow anything that was actually
knowable as "dead"; every non-`ESRCH` outcome genuinely is inconclusive. The
`pid < 1` boundary (`inspectLock.ts:58-60`) is correct against POSIX semantics:
both `0` (caller's process group) and negative values (process-group signal)
are special-cased by `kill(2)` and neither is a query about a single process,
so guarding both before the syscall (rather than relying on `kill` to throw)
is the right call — an unguarded negative pid could easily hit a real process
group and return successfully, which would have been misread as "alive." No
swallowing found here.

### 5. Test: TOCTOU refusal (`vi.doMock` block, `tests/unlock/unlockCommand.test.ts:126-173`) — verified independently to fail on regression, and no cross-test leak found

- Verified per the brief's explicit instruction, not accepted from the
  implementer's claim: reverted the `mutant-e1b` clone to `3f6a61c`, then
  mutated `removeLockIfUnchanged` in that clone to remove the `dev`/`ino`
  comparison (`if (false) { return "changed"; }` in place of the real guard),
  and ran `tests/unlock/unlockCommand.test.ts`. Result: **2 tests fail**, not
  just the `vi.doMock`-based one:
  ```
  × removeLockIfUnchanged ... > refuses when the name now holds a DIFFERENT
    file, and leaves that file alone
    → expected 'removed' to be 'changed'
  × the dead-holder path refuses once the file underneath it has been
    replaced > does not delete a lock that is no longer the file the
    inspection read
    → a live holder's republished lock was deleted by the dead path:
      expected false to be true
  ```
  21/23 pass, 2/23 fail — confirms the guard is pinned by two independent
  tests (a direct unit test on `removeLockIfUnchanged`, and the `vi.doMock`
  test that exercises it through `unlockOwnerTransferLock`), and both catch
  the regression. Restored the clone; `git diff | wc -c` = 0 afterward.

- Cross-test leak: the `describe` block containing the `vi.doMock` test has
  exactly one `it`, with `afterEach` calling `vi.resetModules()` and
  `vi.doUnmock(...)`. The file's other tests (`run()` helper, used throughout
  the rest of the file) close over `unlockOwnerTransferLock` from the file's
  **static** top-level import, which was resolved before any `resetModules()`
  call and is not affected by it — `resetModules()` only clears the registry
  vitest consults for *future* dynamic imports/`require`s, not already-bound
  ES-module live bindings. Ran the full file clean (unmutated): **23/23
  pass**, including every test after the `vi.doMock` block, which is
  consistent with no leak. I did not find an assertion in this file that
  cannot fail — every state-pinning test I read has either an explicit
  anti-vacuity check (e.g. `expect(() => process.kill(DEAD_PID, 0)).toThrow()`
  before asserting the dead path, `unlockCommand.test.ts:272`) or asserts a
  concrete, mutation-sensitive value (confirmed for the TOCTOU tests above by
  actually breaking the guard and watching them fail).

## Full-suite verification (main repo, read-only — no mutation in the main tree)

```
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
npm test -- --run   # exit 0, 590/590 tests passed, 34/34 files
npm run typecheck    # exit 0
npm run build         # exit 0
```
Exit codes captured directly (`echo $?` immediately after each command, no
pipe into `tail`/`grep`/`head` on the verification command itself — output was
redirected to a file and read separately with the Read tool).

Main repo confirmed untouched throughout: `git status --porcelain` empty,
`git diff | wc -c` = 0.

## Severity summary

- **Critical**: none found in the fix round. In particular, I did not find a
  path by which the fix's new `removeLockIfUnchanged` / `classifyHolderLiveness`
  swallowing lets a live holder's lock be removed, or bypasses the frozen
  redline function — the identity re-check is real and independently
  mutation-tested (finding 5), and the liveness three-way split does not
  misclassify a genuinely-dead process as unknown or vice versa (finding 4).
- **Important**: finding 1 (`handle.close()` in `finally` can turn a
  successful read into `file-unreadable`, discarding the digest / `--force`
  route, and can replace a real error with an unrelated `close()` error) and
  finding 2 (errno discarded entirely for the `unremovable` outcome, leaving
  the operator-facing refusal line with no actionable diagnostic content).
- **Minor**: none identified beyond the two Important findings above.

These are findings, not dispositions — whether they warrant another fix round
is not my call.
