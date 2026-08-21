# E1 review — fix round 4 (`92018a8`), sixth independent reviewer

Range: exactly `92018a8` (parent `4da041e`), two files. Seat: fresh; I inherited none of the five
previous reviewers' conclusions and re-measured every claim I report on.

Headline: **all four claimed landings are real and I reproduced every measurement in the commit
message and in ledger §25.21, including the two I expected to be weakest** (the linux errno and the
43/43 linux run). The round did what it says. What it did **not** do is make `reasonFrom` total — the
brief's sharpest question — and I measured four distinct values that make the helper throw, one of
them from inside the very class its own comment names. All of them are unreachable through `node:fs`,
so nothing here is a correctness risk to the shipped command; it is an accuracy problem in a comment,
which is the same defect class this round existed to fix.

---

## Strengths

Named specifically, because several of these are better than the commit claims for itself.

1. **The three new tests are each genuinely red against the parent, at exactly the lines the ledger
   claims.** Measured: with `4da041e`'s `src/unlock/unlockCommand.ts` restored under the new test
   file, 3 fail — `:81` (`errno.code` on `null` → `TypeError: Cannot read properties of null`) and
   `:84` / `:97` (`String(Object.create(null))` → `Cannot convert object to primitive value`). Ledger
   §25.21 names 81 / 84 / 97; those are the lines. Not one of the three is a test that would pass
   against the code it was written to pin.

2. **M-D / M-E / M-F reproduce exactly, 1 / 2 / 1 red.** M-E's two reds land at
   `unlockCommand.ts:102` (stat catch) and `:115` (unlink catch) — so the claim "the helper is
   load-bearing on both sides" is not rhetoric, the stack frames say so.

3. **The per-platform assertion bites on _both_ halves, which is more than the commit proved.** The
   commit measured only the darwin flip (M-F). I additionally ran the linux half in `node:22-alpine`
   with the ternary rewritten to `/EPERM/`: 1 red, `reason: "EISDIR: illegal operation on a
   directory, unlink '/tmp/ccloop-unlock-cmd-…'"`. Both branches of the ternary are now
   independently demonstrated to fail when wrong. Neither is vacuous.

4. **The platform errnos are correct and I measured them myself, root and non-root.** darwin →
   `EPERM`; `node:22-alpine` → `EISDIR` as uid 0 and as uid 1000. `package.json` really does declare
   `"os": ["darwin","linux"]`, so the test comment's "package.json declares both as targets" is true.

5. **43/43 on linux reproduces from a genuinely fresh install.** `git archive HEAD` → container →
   `npm ci` (51 packages, no node_modules carried over) → `npx vitest run tests/unlock` → `Test Files
   2 passed (2) / Tests 43 passed (43)`, rc=0. The commit's arithmetic checks out too: 30
   (`unlockCommand`) + 13 (`inspectLock`) = 43.

6. **The bad-probe correction is itself correct, and I checked it rather than believing it.**
   `command -v timeout` → not found; `command -v gtimeout` → not found; `docker` is at
   `/usr/local/bin/docker` and `docker info` returns **rc=0** against an already-running OrbStack
   daemon. Last round's 127 was the shell, exactly as §25.21 says. I did not have to start anything.

7. **The commit is honestly scoped where it would have been easy not to be.** It says "the whole
   unlock suite… 43 passed" and does not say "598 on linux". That restraint turns out to matter: the
   full 598 on linux is **not** green (see the out-of-range observation below), and a looser sentence
   would now be a false record.

8. **Red line independently verified.** `tryRecoverStaleOwnerTransferLock` extracted from
   `86d3bd6:src/persistence/fileStore.ts` and from `HEAD:src/persistence/fileStore.ts`: 970 bytes
   each, identical sha256 `517b54e4…f5218`, `diff` rc=0. `92018a8` touches only the two files under
   review (`--name-only` confirms). I propose nothing for it.

9. **Landing #4 is real.** No paragraph about how the reason is taken now sits above the ENOENT
   branch; the reason-taking rationale moved to the `reasonFrom` header (`:53-61`), where it belongs,
   and the ENOENT branch's comment now describes the optional chaining that is actually on that line.

10. **The "nothing was deleted" half of each new test is checked against the real filesystem, not the
    mock.** `lockExists` closes over the test file's *static* `stat` import, bound before any
    `vi.doMock`; `doMock` is non-hoisting and affects only later dynamic imports. So a mock cannot
    fake the survival assertion. (Read-only argument; the mocked module is reached only via the
    `await import(…)` inside each test, which M1/M2 confirm by stack frame.)

11. **The `afterEach` placement the previous round introduced is what makes these three tests safe**,
    and the new tests correctly rely on it rather than trailing cleanup.

12. **Ledger §25.21 is accurate.** Everything in it that I checked — 598/34/0 skipped, typecheck 0,
    build 0, 970-byte red line, the darwin/linux errnos, 43/43, the M-D/M-E/M-F counts, the "not the
    whole 598 on linux" caveat — reproduced. I found no overstatement in it.

---

## Issues

### Critical

None.

### Important

None. Every residue below is unreachable through `node:fs`, which rejects only with `Error`
subclasses; I verified that the reviewed code's behaviour for real `fs` errors is byte-for-byte
unchanged (598 green, and `reasonFrom(err) === err.message` for an `Error`, `?.code` identical to
`.code` for an object).

### Minor

#### M-1 — `reasonFrom`'s fallback is not total, and it fails inside the exact class its comment names

**Anchor:** `src/unlock/unlockCommand.ts:57-71` (the comment paragraph and the helper body); the
throwing lines are `:64` (`return error.message`) and `:70`
(`return Object.prototype.toString.call(error)`).

**What is wrong.** The comment at `:57-60` says String() "throws on an object with a null prototype…
so the fallback keeps even that case a value." Measured against the **real** `removeLockIfUnchanged`,
four values make the helper throw straight out of the catch:

| thrown value | escapes at | why |
|---|---|---|
| null-prototype object with a throwing `Symbol.toStringTag` getter | `:70` | `Object.prototype.toString` performs `Get(O, @@toStringTag)` |
| `Proxy` whose `get` trap throws | `:68` then `:70` | both the `toString`/`valueOf` lookups and the tag lookup hit the trap |
| `Proxy` whose `getPrototypeOf` trap throws | `:63` | `instanceof` walks the prototype chain, and that line is **outside** the `try` |
| `Error` whose `message` is a throwing accessor | `:64` | also outside the `try` |

The first row matters most: it *is* "an object with a null prototype", the class the comment names,
and the fallback does not keep it a value. So the sentence asserts a property the code lacks — which
landing point 5 of the brief, and this round's own item 1, call the defect being fixed.

**Why it matters.** Zero production impact (`node:fs` cannot produce these). It matters because
`reasonFrom` is now sold as *the* structural guarantee for both catches, and the next person to add a
third caller — or to hand it a value from somewhere that is not `node:fs` — will read the comment,
not re-derive the spec of `Object.prototype.toString`.

**Constructible scenario.**
```ts
const evil = Object.create(null);
Object.defineProperty(evil, Symbol.toStringTag, { get() { throw new Error("boom"); } });
// stat or unlink rejects with `evil`  ->  removeLockIfUnchanged rejects with "boom"
// operator sees "the command crashed", not "the lock is still there"
```

**How verified.** **Measured**, twice: a standalone probe of the helper's exact text, and then a
temporary vitest file in the clone driving the **real** `removeLockIfUnchanged` through mocked
`stat`/`unlink`. Result: `promise rejected "Error: tag getter" instead of resolving`, with the frame
`reasonFrom src/unlock/unlockCommand.ts:70:38` (stat side, via `:106`) and the same at `:119`
(unlink side). Both sides fail identically — the helper's symmetry holds even in its failure.

**How to fix (3 added lines, this file's style):**
```ts
function reasonFrom(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message;
    }
    return String(error);
  } catch {
    // fall through
  }
  try {
    return Object.prototype.toString.call(error);
  } catch {
    return "a rejection that could not be described";
  }
}
```
Alternatively, if the project prefers not to add machinery for an unreachable case: narrow the
comment to what is true — "the fallback covers the ordinary null-prototype object; a value whose
`@@toStringTag`, prototype, or `message` is a throwing accessor still escapes, and is out of reach of
`node:fs`."

**Disposition:** report **and** fix, in whatever the next round is. I would not block the merge on
it — see the assessment.

#### M-2 — the optional chaining does not make the ENOENT guard total, and the cast omits `undefined`

**Anchor:** `src/unlock/unlockCommand.ts:102` —
`if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")`.

**What is wrong.** Two separate small things.

(a) `?.` guards only `null`/`undefined` *receivers*. A caught object whose `code` is an accessor that
throws still throws a `TypeError`-class rejection out of the delete path — the same shape the fix was
for, one property lookup later. Note the asymmetry this leaves: the stat catch touches `error.code`
*before* it reaches `reasonFrom`, so it has a strictly larger throw surface than the unlink catch,
even though the comment at `:100` says "one function must not disagree with itself".

(b) The cast is `NodeJS.ErrnoException | null`, but `undefined` is one of the values that actually
arrives (`throw undefined` is legal, and `?.` was added precisely because non-objects arrive). The
cast is a claim to the reader, and it is false for `undefined`. `NodeJS.ErrnoException` also asserts
`.code?: string` for a value that could carry anything.

**Why it matters.** Same as M-1: unreachable through `node:fs`, but the comment on those lines is
load-bearing documentation and currently reads as if the guard were now safe against "something that
is not an object at all" — which is true — while implying more.

**Constructible scenario.**
```ts
const o = {}; Object.defineProperty(o, "code", { get() { throw new Error("code getter"); } });
// stat rejects with o -> TypeError escapes at unlockCommand.ts:102
```

**How verified.** **Measured** (probe P3 in the clone, against the real function): `promise rejected
"Error: code getter" instead of resolving`, frame `removeLockIfUnchanged
src/unlock/unlockCommand.ts:102:10`.

**How to fix.** Either widen the cast honestly —
`(error as { code?: unknown } | null | undefined)?.code === "ENOENT"` — and add one clause to the
comment naming the accessor residue, or move the ENOENT test inside a `try` alongside `reasonFrom`.
The cast widening alone is a one-line change and removes the false half of the claim.

#### M-3 — `reason` is typed `string` but can be a Symbol, and that one throws in `reportFailedRemoval`

**Anchor:** `src/unlock/unlockCommand.ts:64` (`return error.message`), surfacing at `:224`
(`stderr(\`refused  the lock could not be removed: ${removal.reason}\`)`).

**What is wrong.** `Error#message` is a writable data property. An `Error` whose `message` has been
set to a Symbol makes `reasonFrom` return a Symbol, violating its `: string` signature and the
`LockRemoval` union at `:51`. Nothing catches it there; the failure surfaces later, at the template
interpolation in `reportFailedRemoval`, as `TypeError: Cannot convert a Symbol value to a string` —
i.e. after the refusal decision was made and while it is being reported. That is the "quietly becomes
a different, less useful answer" shape the brief's landing point 6 asks about, at the worst possible
moment in the path.

**Why it matters.** Pre-existing (the parent's `error instanceof Error ? error.message : …` had the
identical hole), so this round did not introduce it — but this round created the single place where
it can be fixed once instead of twice, and did not.

**Constructible scenario.**
```ts
const e = new Error("x"); (e as any).message = Symbol("weird");   // unlink rejects with e
// removeLockIfUnchanged resolves with reason: Symbol(weird)  (typeof === "symbol")
// reportFailedRemoval then throws TypeError while printing the refusal
```

**How verified.** **Measured** (probe P5 in the clone, plus a direct interpolation probe):
`expected 'symbol' to be 'string'`, and `interpolated: … THREW TypeError: Cannot convert a Symbol
value to a string`.

**How to fix.** The M-1 rewrite above already fixes it (`typeof error.message === "string"` guard).

#### M-4 — `expect.stringMatching(/\S/)` cannot distinguish the answer the code gives from any other

**Anchor:** `tests/unlock/unlockCommand.test.ts:238` and `:260`.

**What is wrong.** The value the code actually produces for `Object.create(null)` is deterministic
and platform-stable: `"[object Object]"`. `/\S/` accepts anything non-blank. Its sibling test three
blocks up pins `reason: "null"` **exactly**, so the round is internally inconsistent about how hard
it pins the same helper's output.

The matcher is not worthless — the real claim ("the call resolves at all rather than rejecting") is
what M-E proved, and `/\S/` does go red for that. But it buys nothing beyond `resolves`.

**Constructible scenario / measurement.** **Measured (mutation M4):** I replaced the fallback body
with `return "?";`. **30 passed (30), rc=0** — the degradation is invisible. A future edit that
replaces `Object.prototype.toString.call(error)` with any non-blank placeholder passes these two
tests, and the operator silently loses the only descriptive fragment left in that path.

**How to fix.** `reason: "[object Object]"` in both tests, with the existing comment already
explaining why that string is the right answer. (Confirmed stable: same value under darwin node
v22.13.1 and linux `node:22-alpine`.)

#### M-5 — the non-linux branch silently asserts EPERM on a platform nobody measured

**Anchor:** `tests/unlock/unlockCommand.test.ts:145` —
`expect.stringMatching(process.platform === "linux" ? /EISDIR/ : /EPERM/)`.

**What is wrong.** It is **not** vacuous anywhere — that part of the brief's worry does not
materialise; the else branch always asserts a concrete errno, and `EPERM` is both the POSIX-specified
value and what win32 produces. `process.platform` is also the right discriminator (the errno comes
from the kernel that owns `tmpdir()`).

The residue is the reverse: on a platform that is neither of the two declared targets, the test
asserts an errno **nobody measured**, and if it is wrong the failure message blames the code. The
concrete case is `process.platform === "android"` (Node on Termux): Linux kernel, so `EISDIR`, but
the ternary demands `EPERM`. `package.json`'s `os` field does not list android, so this is a
paper-thin scenario — I raise it only because the brief asked the question directly and because the
fix makes the test say what it knows.

**How verified.** **Measured** for the two real cases (both branches shown red when wrong, on their
own platforms — see Strengths 3). The android case is a **read-only argument** from the kernel's
`unlink(2)` semantics; I did not obtain an android runtime.

**How to fix.**
```ts
const expected = { linux: /EISDIR/, darwin: /EPERM/ }[process.platform as "linux" | "darwin"];
expect(expected, `unlink(2) on a directory has not been measured on ${process.platform}`).toBeDefined();
expect(result).toMatchObject({ outcome: "unremovable", reason: expect.stringMatching(expected!) });
```

#### M-6 — nit: for `throw undefined`, the new answer is literally the string the file calls the failure it prevents

**Anchor:** `src/unlock/unlockCommand.ts:102` → `:106`.

Before this commit, `throw undefined` crashed at `.code`. Now it flows to `reasonFrom` → `String(undefined)`
→ the operator reads `refused  the lock could not be removed: undefined`. The parent's own comment
(and the commit message, para 2) name `"reason: undefined"` as the uninformative answer this command
exists to prevent. The new behaviour is still strictly better than a crash — nothing was deleted,
exit 1, a line was printed — and it is unreachable. Recording it only because the round's stated
standard is that the reason must be actionable; if M-1 is taken, one extra clause there could map a
blank/`"undefined"`/`"null"` result onto something like `"a rejection with no message"`. **Read-only
argument** plus the measured `reason: "null"` case that the new test pins.

---

## Out of the reviewed range — reported, not proposed

**`tests/persistence/fileStore.test.ts:4148` (comment) and `:4158` (assertion) hard-code
`code: "EPERM"` for `unlink(<directory>)` — the same syscall this commit just pinned per platform —
and that test is RED on linux.**

```
FAIL  tests/persistence/fileStore.test.ts > … > has its cleanup failure swallowed, …
AssertionError: expected Error: EISDIR: illegal operation on a dir… to match object { code: 'EPERM' }
- "code": "EPERM"
+ "code": "EISDIR"
```

The comment above it states "writeFile fails EISDIR and unlink fails EPERM. Both errnos are asserted
below rather than asserted-by-comment" — which is a false statement about the second declared
platform. This is precisely the defect class round 4 fixed in its own file; the round did not sweep
for the sibling. **Measured** (full 598 in `node:22-alpine`). It is a different file, not in
`92018a8`, and not the red-line function, so I propose nothing and it does not affect this commit's
verdict — but the next person to touch platform errnos should know it exists.

**Also from that run, for the record, not investigated (protocol item 10 / environmental):** the full
suite on linux is `5 failed | 593 passed`. Besides the fileStore one: `evidence.test.ts > run-scenario
CLI > records env names only and tracks descendants rooted at the spawned pid` is the brief's named
allowed flake; `prepareA04 … unreadable legacy preserved evidence tree` fails because the container
ran as root and `chmod 000` is still readable to root; `cli.test.ts > returns 0 for the scripted
example run` and `evidence.test.ts > records claudeChildExited as NOT_OBSERVABLE` look like
container/process-visibility artifacts. **I chased none of them.** The brief's statement that the
full 598 has never been run on linux was accurate before this review; it now has been, once, in one
container, as root — please do not read that as "the suite is linux-clean", because it is not.

---

## Verification performed

Node `v22.13.1`, darwin 24.6.0. Every run below was redirected to a file and read back whole; no
`grep`/`head`/`tail` stood between a verification command and its verdict.

### On the working checkout (read-only w.r.t. HEAD, index, branches)

```
ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm test -- --run          rc=0
  RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop
  Test Files  34 passed (34)
       Tests  598 passed (598)          0 skipped; no named flake triggered
ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm run typecheck          rc=0
ECC_GATEGUARD=off DISABLE_OMC=1 rtk proxy npm run build              rc=0
rtk proxy git status --porcelain                                     (empty)
rtk proxy git log --oneline -1                                       470744f
rtk proxy git diff | wc -c            -> 0
rtk proxy git diff --cached | wc -c   -> 0
```

### Independent red-line byte comparison

```
git show 86d3bd6:src/persistence/fileStore.ts  -> awk-extract tryRecoverStaleOwnerTransferLock -> 970 bytes
git show HEAD:src/persistence/fileStore.ts     -> same extraction                              -> 970 bytes
diff  rc=0
sha256 both: 517b54e4461d4be94eef7c3e58f3b7d0a7395d7b6014902345bd2886699f5218
git show --name-only 92018a8 -> src/unlock/unlockCommand.ts, tests/unlock/unlockCommand.test.ts  (only)
```

### Mutation experiments — all in `git clone --local` copy at `<scratchpad>/clone`

Sanity: unmutated clone, `npx vitest run tests/unlock/unlockCommand.test.ts` → `30 passed (30)`,
`RUN` path `…/scratchpad/clone`.

| id | mutation | result |
|---|---|---|
| M1 | drop the optional chaining at `:102` | **1 red** — `TypeError: Cannot read properties of null (reading 'code')` at `unlockCommand.ts:102:42`, from the `throw null` test |
| M2 | delete the `try/catch` in `reasonFrom`, leave bare `String(error)` | **2 red** — `Cannot convert object to primitive value` at `reasonFrom:67`, reached via `:102` (stat) and `:115` (unlink) |
| M3 | darwin branch of the ternary rewritten to `/EISDIR/` | **1 red** — received `"EPERM: operation not permitted, unlink '…/.owner-transfer.lock'"` |
| M4 (mine) | fallback body → `return "?";` | **30 passed, rc=0** — proves `/\S/` cannot see the degradation |
| M5 (mine) | `git checkout 4da041e -- src/unlock/unlockCommand.ts` under the new tests | **3 red**, at `:81` / `:84` / `:97` — all three new tests bite against the parent |
| P1–P5 (mine) | temporary untracked probe test file driving the real function with adversarial thrown values | 5 red — see M-1 / M-2 / M-3 above for the exact frames |

**Restoration proof on the clone** (after removing the probe file and restoring M5's checkout, which
writes the index):

```
rtk proxy git diff | wc -c            -> 0
rtk proxy git diff --cached | wc -c   -> 0
rtk proxy git status --porcelain      -> (empty)
```

and on the working repo, both before and after everything:

```
rtk proxy git diff | wc -c            -> 0
rtk proxy git diff --cached | wc -c   -> 0
rtk proxy git status --porcelain      -> (empty)     HEAD still 470744f
```

File copies were verified with `diff -q` (`src identical`, `test identical`); I used `/bin/cp` to
bypass the `cp -i` alias the brief warns about, and `cp` returned rc=0 with 42 entries landed.

### Probe hygiene (protocol item 7)

Before believing anything about the container runtime I checked the probe itself:

```
command -v timeout   -> (not found)      <- confirms last round's 127 was the shell
command -v gtimeout  -> (not found)
command -v docker    -> /usr/local/bin/docker
docker info          -> rc=0, Context: orbstack, Server present
```

The OrbStack daemon was **already running**; I did not start it.

### Measurements taken in a container

```
docker run --rm -v <scratchpad>:/probe:ro node:22-alpine node /probe/probe-linux.mjs
  platform=linux code=EISDIR message=EISDIR: illegal operation on a directory, unlink '/tmp/…'
docker run --rm --user 1000:1000 … same probe
  platform=linux code=EISDIR …                      (so it is not a root artifact)
local, darwin:
  platform=darwin code=EPERM message=EPERM: operation not permitted, unlink '/var/folders/…'

git archive HEAD -> extract to <scratchpad>/linuxrun/app
docker run --rm -v …/app:/app -w /app node:22-alpine sh -c 'npm ci --no-audit --no-fund && npx vitest run tests/unlock'
  added 51 packages in 5s
  Test Files  2 passed (2)
       Tests  43 passed (43)                        rc=0
same copy, ternary rewritten to /EPERM/ on both branches:
       Tests  1 failed | 29 passed (30)  -> received "EISDIR: …"       (linux half bites)
  then restored from repo.tar and diff-verified against the working repo's file: identical
full suite on linux (informational): Test Files 4 failed | 30 passed (34); Tests 5 failed | 593 passed
```

### Everything I did to the local machine or fetched from the network

Stated in full, per protocol item 6:

1. Ran `docker info` against the already-running OrbStack daemon. **I started nothing.**
2. Pulled and ran the public image `node:22-alpine` — five container runs, all `--rm`.
3. Inside one container, `npm ci` fetched **51 packages from the public npm registry** into a
   scratchpad copy of `HEAD` (never into this repository).
4. Inside one throwaway container, `apk add --no-cache git` (needed by the validation tests; the
   container was discarded on exit).
5. `git clone --local` of this repo into the scratchpad, and `/bin/cp -R node_modules` into that
   clone. Both live under the session scratchpad.
6. **In the working repository I ran `npm run build`**, which regenerated the git-ignored `dist/`
   directory. `git status --porcelain` is empty before and after; HEAD, the index and every branch
   are untouched; I pushed nothing and created no commit, tag, branch or worktree.
7. No configuration on this machine was modified, nothing was installed into this repository, and I
   touched nothing belonging to another line of work.

---

## Recommendations

1. **Land M-1** (make `reasonFrom` total, or narrow its comment to what it actually guarantees). Four
   lines either way. This is the one finding that matters by the project's own standard, because the
   comment claims a property inside the class it names.
2. **Take M-3 with it** — the `typeof error.message === "string"` guard is one clause of the same
   rewrite and closes the only residue that fails *after* the decision, in the reporting path.
3. **Tighten M-4** to `"[object Object]"`; it costs nothing and removes the round's internal
   inconsistency about how hard it pins the same helper.
4. **M-2 and M-5** are cheap and optional; if only one is taken, take M-2(b) (the cast widening),
   because a false type assertion is read as documentation here.
5. **Do not let the out-of-range fileStore EPERM assertion vanish into this report.** It is a live
   red on the second declared platform, and it is the twin of what this round just fixed. It deserves
   its own line in the ledger's open items, not a mention inside a review of a different file.
6. When the ledger records the linux data point, record my extra one honestly beside it: the full 598
   has now been run on linux exactly once, as root, in one container, and it was **not** green.

---

## Assessment

**Ready to merge?** **Yes.**

The commit does exactly what it claims, and it is the rare case where I could not find a claim that
overstated the work — the platform measurements, the red counts, the 43/43, the red-line bytes and
the ledger all reproduced, and two of them (the linux half of the ternary; the three tests red
against the parent) I proved harder than the commit had. The code is strictly safer than its parent
on every value that can actually arrive, with `node:fs` behaviour unchanged. Every finding I have is
unreachable through `node:fs`, and the largest of them — that `reasonFrom` is not the total function
its comment implies — is a comment-accuracy defect of the same shape and the same (zero) blast radius
as the four Minors the previous reviewer filed and this round happily landed. Consistency with that
precedent says: merge, and land M-1/M-3/M-4 in the next small pass rather than spending a round
gating on them.
