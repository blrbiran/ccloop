# E1 TypeScript review — `ccloop unlock` (commits e7b288e, a4f1fb1)

Independent review, scope limited to `git diff 1441849..HEAD`. Verified against a
`git clone --local` mutant copy (`/private/tmp/.../scratchpad/mutant-e1`) for the type-level
claims, and against a standalone Node/tsx reproduction (in `/private/tmp/.../scratchpad/`, no repo
files touched) for the TOCTOU claim below. The mutant copy was restored and proven clean via
`rtk proxy`, raw output:
`rtk proxy git -C mutant-e1 diff | wc -c` -> `0`, `... diff --cached | wc -c` -> `0`,
`rtk proxy git -C mutant-e1 status --porcelain` -> only the pre-existing `?? node_modules` symlink
entry (present before any mutation, unrelated to this review).

Build/test verification (env `ECC_GATEGUARD=off DISABLE_OMC=1`, raw, unpiped):
- `npm test -- --run` -> 34 files / 578 tests, all green, exit 0.
- `npm run typecheck` -> exit 0, no output.
- `npm run build` -> exit 0, no output.
- No ESLint config exists in this repo (no `.eslintrc*`, no `eslint` devDependency) — the lint
  step was skipped per the review protocol's "skip for projects with no eslint" allowance, not
  silently omitted.

---

## CRITICAL — the "dead" branch's `unlink` is unconditional-by-path; a racing recovery can
## delete a live holder's lock, contradicting Human Ruling 70 C-e

`src/unlock/unlockCommand.ts:73-77`:
```
if (inspection.state === "dead") {
    await unlink(ownerTransferLockPath(runDir));
    stdout(`removed  holder=${inspection.holder} was not alive`);
    return 0;
}
```

`inspection` is produced once, at the top of `unlockOwnerTransferLock`
(`src/unlock/unlockCommand.ts:52`), by a single `readFile` inside
`inspectOwnerTransferLock` (`src/unlock/inspectLock.ts:60`). Nothing re-reads or re-verifies the
file between that read and the `unlink` call four lines later — `unlink` acts purely on the
*path*, not on the inode or content that was inspected.

**Concrete, reproduced scenario:**
1. `<runDir>/.owner-transfer.lock` holds `{"holderProcessInstanceId":"pid:999999","acquiredAt":"..."}`,
   pid 999999 genuinely dead.
2. Operator runs `ccloop unlock <runDir>` (argv `["unlock", "<runDir>"]`, `force: false`).
   `inspectOwnerTransferLock` reads the file, classifies `state: "dead"`.
3. **Concurrently** (a plausible, not contrived, interleaving: a scheduled `ccloop sweep` or an
   operator-run `ccloop resume` targeting the same run directory), `acquireOwnerTransferLock`
   (`src/persistence/fileStore.ts:1094`) hits `EEXIST` on the still-present lock file, calls the
   redline function `tryRecoverStaleOwnerTransferLock`, which independently re-reads the *same*
   dead record, confirms it dead, unlinks it, and lets the caller `link()` a **brand-new, live**
   lock (`holderProcessInstanceId: pid:<a genuinely running pid>`) at the same path — completing
   before step 4.
4. `unlockOwnerTransferLock` reaches its `unlink(ownerTransferLockPath(runDir))` call. This deletes
   whatever is *currently* at that path — the fresh, live lock from step 3, not the dead one read
   in step 2.
5. **Wrong outcome:** the live holder's lock is deleted. The command prints
   `removed  holder=pid:999999 was not alive`, which is now false — the file actually deleted named
   a different, live pid — and exits 0. The live holder still believes it holds an exclusive lock
   (it has an open handle from its successful `link()`), but the on-disk artifact naming it as
   owner is gone, breaking the mutual-exclusion invariant the whole owner-transfer protocol exists
   to provide.

**Empirically reproduced** (no source files modified; script at
`/private/tmp/.../scratchpad/toctou-demo/demo.ts`, calling the real, unmodified
`inspectOwnerTransferLock` export against a real tmp lock file, then simulating the race by
rewriting the file before calling the same `unlink(ownerTransferLockPath(runDir))` the "dead"
branch calls):
```
inspection result: { state: 'dead', holder: 'pid:999999', pid: 999999, digest: '66368c9b...' }
simulated racing process published a fresh LIVE lock: {"holderProcessInstanceId":"pid:81746",...}
RESULT: lock file DELETED -- this was the LIVE pid 81746's lock, not the dead pid 999999's
```

**Why this is not covered by ruling 73's TOCTOU claim.** Ruling 73's commit message
(`1441849`) states the digest credential "closes the TOCTOU window as a side effect"
(`.../progress.md` §25.14: "盘上变了也拒（顺带堵住 TOCTOU）"). That claim is true only for the
`--force` path, and only for drift between *the operator's own earlier observation* (when they ran
`shasum` to get the digest they typed) and *this invocation's read* — `inspection.digest` is
compared against `options.expectedDigest`, both fixed before either digest-bearing check runs. It
says nothing about drift between *this invocation's read* and *this invocation's own later
`unlink`*. And critically: **the "dead" branch has no digest, no `--force`, and no credential check
of any kind** — ruling 73's mitigation does not apply to it at all. This is the branch demonstrated
above.

The `--force` path (`unlockCommand.ts:90-96`) has a much narrower residual window of the same
shape: the digest comparison at line 90 and the `unlink` at line 96 have no `await` between them,
so the gap is on the order of the `unlink` syscall itself — comparable to the residual risk the
codebase's own `classifyLockAtRelease` (`fileStore.ts:1009`, fixed under Human Ruling 62) already
accepts and documents in comment ("the stat and the unlink are still two syscalls, so a theft
landing between them is undetectable here"). I am **not** flagging that narrower residual as a
separate defect — it is the same class of accepted, documented risk elsewhere in this codebase.
What is new and unmitigated is the **default, no-`--force`, "dead" path**, whose window spans the
entirety of a `readFile` + `JSON.parse` + regex + `process.kill(pid,0)` probe, several `await`
points wide, with zero re-verification at delete time.

**Why this matters given Human Ruling 50.** The codebase's own history already demonstrates this
exact bug class: `release()` used to `unlink` unconditionally by path and was found (Human Ruling
62, `pointB-design.md` §6.1) to delete a *new* holder's lock that had stolen the name in the
interim; the fix was `classifyLockAtRelease`, comparing the on-disk file's `(dev, ino)` against an
already-open handle's `fstat`. `unlockCommand.ts`'s two `unlink` call sites have no equivalent
check — no open handle, no inode comparison, no immediately-preceding re-read — reintroducing the
same shape of bug the codebase already paid to fix once, on the one command Human Ruling 70 C-e
requires to *never* delete a live holder's lock.

**Test coverage gap, following from the same defect.** None of the 33 tests added in `e7b288e` /
edited in `a4f1fb1` (`tests/unlock/unlockCommand.test.ts`) construct this interleaving — every test
calls `unlockOwnerTransferLock` against a static, unchanging on-disk fixture. The "live holder's
lock is never removed" assertions (`unlockCommand.test.ts:66-112`) pin the guarantee only for the
*single-read, no-concurrent-writer* case, which is the one case the code already handles correctly.
They do not, and structurally cannot as written, catch the defect above.

**Disposition is not mine to make** — filing this as a defect, not a decision. The fix shape (e.g.
compare an inode/digest recheck immediately before each `unlink`, or take a short-lived exclusive
lock of some kind around the read-then-delete) is an implementation choice for whoever owns this
code, and closing the window may itself need a human ruling given Human Ruling 50/70/72's pattern
of requiring sign-off on this exact lock's failure semantics.

---

## No finding — the redline function is byte-identical

`tryRecoverStaleOwnerTransferLock` extracted from `1441849:src/persistence/fileStore.ts` (lines
904-938) and from `HEAD:src/persistence/fileStore.ts` (lines 914-948): identical line count (35),
identical MD5 (`aff7a1fb6bc19caca9e6bc7bfc87d087`) on both sides. `diff` between the two extracts
is empty. The claim holds.

## No finding — the three `fileStore.ts` exports add no behavior

Full diff of `src/persistence/fileStore.ts` between `1441849` and `HEAD` is exactly three
`export` keyword additions (`OwnerTransferLockRecord` type, `parsePid`, `isProcessActive`) plus
explanatory comments — no other line changed. Confirmed by direct `diff` of the two file
revisions; nothing beyond the seven-hunk export/comment change exists.

## No finding — `parseArgs`'s `unlock` branch (`src/cli.ts:75-129`)

Walked every argv shape named in the brief:
- **`--expect` twice** (`--expect A --expect B <dir>`): last value wins (`expectedDigest` is
  overwritten each time); consistent with the pre-existing `Map`-based flag/value pairing used by
  `run`/`resume`/`sweep` elsewhere in the same file (`cli.ts:136-138`), where repeated flags also
  silently take the last value. Not a new inconsistency, not a route to misparsed deletion.
- **`--force` twice**: idempotent (`force = true` set twice), no effect.
- **A run directory literally starting with `--`** (e.g. `unlock --my-dir`): falls into
  `if (token.startsWith("--")) throw new Error(\`unknown flag ${token}\`)` (`cli.ts:102-104`) —
  refuses to parse at all. Fails closed; cannot reach deletion under any other directory name.
- **`=`-style flags** (`--expect=abc123`): the whole token fails the `=== "--expect"` exact match,
  then hits the same `startsWith("--")` throw. Refuses; consistent with the rest of the file (no
  command in this codebase supports `=`-joined flags).
- **Empty-string argument**: assigned as the positional (`runDir = ""`), then caught by
  `if (!runDir) throw ...` at the end (`cli.ts:112-114`) since `""` is falsy — refuses rather than
  silently proceeding with an empty path.
- **Lone `--`**: `"--".startsWith("--")` is true, so it hits `unknown flag --` and throws; the
  file does not special-case `--` as an end-of-flags sentinel, but that is a refusal, not a
  misparse.
- **`--expect --force` (value = another flag) and `--expect` at end of argv (missing value)**: both
  explicitly caught (`cli.ts:94-96`), throwing `--expect requires a sha256 digest of the lock file`.
- **`--expect`/`--force` before the positional** (the shape `ls`'s rule would misparse): confirmed
  correct — `unlock --force --expect abc123 /tmp/some-run` parses to
  `{runDir: "/tmp/some-run", force: true, expectedDigest: "abc123"}` (also pinned by
  `tests/cli/cli.test.ts:299-306`), because the value-consuming `--expect` branch advances `index`
  past its value before the loop continues.

Every shape either parses correctly or throws before any `runDir`/`force`/`expectedDigest`
combination reaches `unlockOwnerTransferLock`. No argv shape found that reaches a deletion in the
wrong directory or with a misread credential.

## No finding — the state machine's non-TOCTOU logic, and "no route bypasses the digest check"

Setting aside the TOCTOU defect above (a timing/concurrency issue, not a logic-branch issue):
within a single, non-concurrent invocation, `unlockCommand.ts`'s branches are mutually exclusive
and exhaustive over `LockInspection`'s six states (`absent`, `file-unreadable`, `alive` checked and
returned before `force` is ever read; `dead` unlinks with no digest, by design, since it requires
no `--force`; `unrecognized-holder`/`unparseable` fall through to the shared digest-gated branch).
The `alive` check (`unlockCommand.ts:67-71`) returns unconditionally, before `options.force` is
read anywhere — confirmed by reading the file top to bottom and confirmed structurally: there is
no code path from `alive` to either `unlink` call site. Aside from the "dead" branch (the one
explicitly designed to skip the digest, per the ticket's own framing), no other branch reaches
`unlink` (line 96) without first passing the `options.expectedDigest !== inspection.digest` check.

## No finding — the type-level claims hold, verified against structural-typing bypass attempts

Tested in the mutant clone (mutation applied, tested, reverted, restoration proven per the method
rules): three attempts to construct a `force: true` value without `expectedDigest` were all
rejected by `tsc --noEmit -p tsconfig.json`:
1. `const bad1: ParsedArgs = { command: "unlock", runDir: "x", force: true }` — TS2322,
   `expectedDigest` missing.
2. Same shape assigned to `UnlockOptions` — TS2322, same reason.
3. A structural-typing bypass attempt — building the value through an intermediate variable typed
   `{ command: "unlock"; runDir: string; force: boolean; expectedDigest?: string }` (to dodge
   excess-property checks on object literals) and assigning that variable to `ParsedArgs` — still
   rejected (TS2322: `force: boolean` is not assignable to the narrowed `force: true` member).

The intersection-of-union pattern in both `ParsedArgs` (`cli.ts:45`) and `UnlockOptions`
(`unlockCommand.ts:31-41`) is not defeated by excess property checks, structural typing, or
widening through an intermediate binding. `main`'s call site (`cli.ts:283-300`) constructs the
object literal directly inside the ternary branches with no `as` cast — consistent with the type
guarantee rather than working around it.

## No finding — the digest the command prints always matches `shasum -a 256`

`digestLockContents` (`inspectLock.ts:50-52`) hashes the raw `Buffer` returned by
`readFile(path)` (no encoding argument, `inspectLock.ts:60`) — this is a hash over the file's exact
bytes, independent of whether those bytes are valid UTF-8. Since SHA-256 (and `shasum`) operate on
bytes, not decoded characters, there is no byte sequence for which they diverge. Verified directly:
a file containing invalid UTF-8 (`\xff\xfe{"holderProcessInstanceId":"pid:1"}\x80\x81`) produces
identical digests from `shasum -a 256` and from `createHash("sha256").update(buf)` in Node
(`caebec5edcfbf050b7070185e6945130135a914b4377187d7d304c624009719c` on both). The premise in the
brief (find an input where they diverge) does not hold — this is a "no finding," not an unresolved
question. Separately, `JSON.parse(contents.toString("utf8"))` (line 74) uses a lossy re-decode of
the same bytes only for *classification* (holder id extraction), never for the digest — the two
uses are correctly kept apart.

## MINOR — `parseArgs unlock > throws when the run directory is missing` doesn't pin the reason

`tests/cli/cli.test.ts:319-322`:
```
it("throws when the run directory is missing", () => {
    expect(() => parseArgs(["unlock"])).toThrow();
    expect(() => parseArgs(["unlock", "--force", "--expect", "abc123"])).toThrow();
});
```
This is **not vacuous** — I traced both assertions against a version with the
`if (!runDir) throw ...` check (`cli.ts:112-114`) removed: both argv shapes would then return
successfully (`{command: "unlock", runDir: undefined, force: false}` and
`{..., runDir: undefined, force: true, expectedDigest: "abc123"}`) rather than throwing, so the
test would catch that specific regression. It is real, not a rubber stamp.

It is, however, weaker than its siblings: every other `parseArgs unlock` refusal test in the same
file matches the thrown message (`.toThrow(/--expect/)`, `.toThrow(/--force/)`,
`.toThrow(/unlock/)`), so a regression that still throws — but for the wrong reason, or with a
confusing/wrong message an operator would read on their terminal — would not be caught here. Rule
9 asks that a test "encode WHY," and a bare `.toThrow()` encodes only "some refusal happened,"
not "the *stated* reason is that the run directory is missing." Suggested disposition (not mine to
decide): add `.toThrow(/run directory/)` or similar to both assertions, matching the sibling tests'
convention in the same `describe` block.

---

## Summary

| Finding | Severity |
|---|---|
| `unlockCommand.ts`'s "dead" branch unlinks by path with no re-verification; a concurrent, legitimate lock recovery can result in deleting a live holder's lock, contradicting Human Ruling 70 C-e | **Critical** |
| Redline function untouched (byte-identical) | No finding |
| `fileStore.ts`'s three new exports add no behavior | No finding |
| `parseArgs unlock` argv-shape handling (repeated flags, `=`-flags, empty string, lone `--`, dir names starting with `--`) | No finding |
| State machine logic (excluding the TOCTOU issue above): no non-TOCTOU route deletes a live holder's lock or bypasses the digest check outside the intended dead-holder path | No finding |
| `ParsedArgs`/`UnlockOptions` type-level guarantee against `force: true` without `expectedDigest` | No finding (verified against structural-typing bypass) |
| Digest vs `shasum -a 256` divergence | No finding (mathematically cannot diverge; premise did not hold) |
| `parseArgs unlock > throws when the run directory is missing` asserts only `.toThrow()`, not the reason | Minor |

**Recommended action (my finding, not my call to file away):** treat the Critical TOCTOU finding
as blocking until addressed or explicitly accepted by a human ruling analogous to Human Ruling 62 —
the codebase's own precedent is that "unlink by path, unconditionally" on this exact lock file was
already found to be unsafe once.
