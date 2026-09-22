## Task 1: `parsePid` 的类型守卫，并把人裁 99 那条判据改写成钉住缺口已闭

**Files:**
- Modify: `src/persistence/fileStore.ts`（`parsePid` 函数体，约 971–974 行 —— ⚠️ **行号会移动，用签名行做锚点**）
- Test: `tests/persistence/fileStore.test.ts`（既有判据 `reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured`）

**Interfaces:**
- Consumes: 无（第一个 Task）
- Produces: `export function parsePid(processInstanceId: unknown): number | null` ——
  Task 2 会把一个 `unknown` 值喂给它。**签名里的 `unknown` 是 Task 2 能编译的前提。**

⚠️ *** **本 Task 改写一条既有判据，授权是人裁 127（人 2026-09-23 亲自指名这条测试、授权整条改写）。** ***
人裁 88 三条件：(a) 已指名 ✅ (b) 方向是**收紧**不是放宽 ✅ (c) 改后注释要写明编码的是人裁 127 ✅。

- [ ] **Step 1: 先跑一次基线，把「哪些红是本来就红」钉死**

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/i2-t1-base.txt 2>&1; echo "RC=$?"
```
Expected: `RC=0`，**91 tests 全绿**（`fileStore.test.ts` 单文件，实测值；若不是 91，**先停下报告**，不要继续）。

- [ ] **Step 2: 改写那条既有判据（此时它应该变红）**

在 `tests/persistence/fileStore.test.ts` 里找到这一行做锚点（**整行匹配，命中数必须 ==1**）：

```
  it("reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured", async () => {
```

把**从这一行起到它对应的 `  });` 为止**整块替换成下面这块。
⚠️ **原注释里那句退路必须逐字保留** —— 它是这次改写的合法性来源。

```ts
  it("refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone", async () => {
    // Encodes HUMAN RULING 127 (2026-09-23). This criterion was rewritten under human ruling 88:
    // the human named this test by name and authorised rewriting it whole. It used to pin the
    // DEFECT -- that the coercion let the lock be reclaimed -- and the original note said so:
    //
    //   "If a later ruling closes the gap, THIS TEST IS THE ONE TO REWRITE (human ruling 88): its
    //    failure is then the intended signal, not a regression."
    //
    // That is what happened. It now pins the gap CLOSED, and it pins BOTH halves the original
    // measured, because the second is why this ever mattered: the coercion did not merely widen an
    // unlink, it let an owner epoch advance behind a holder nobody could attribute. The epoch
    // assertion below is the positive observation -- "nothing happened" cannot be polled for.
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const initialOwnerRecord = {
      runId: "task-1",
      logicalSessionId: "task-1/session-1",
      currentOwnerEpoch: 1,
      currentProcessInstanceId: "pid:12345",
      lastAffirmedAt: "2026-07-22T10:00:00.000Z",
      ownerStatus: "current" as const,
      supersededByEpoch: null,
      leaseAffirmedAt: null,
    };
    const transfer = applyOwnerEpochTransfer(
      initialOwnerRecord,
      "pid:67890",
      "2026-07-22T10:05:00.000Z",
      "owner lost after reconciliation",
    );

    // Both premises asserted rather than assumed, so this cannot quietly become a test of
    // something else: the pid must be DEAD (otherwise the guard refuses for the ordinary reason
    // and the coercion is never exercised), and the holder must be a NON-STRING (otherwise
    // there is no coercion to pin).
    const deadPid = 999999;
    expect(isProcessActive(deadPid)).toBe(false);
    const arrayHolder = [`pid:${deadPid}`];
    expect(typeof arrayHolder).not.toBe("string");

    await writeOwnerRecord(runDir, initialOwnerRecord);
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    const lockContents = JSON.stringify({ holderProcessInstanceId: arrayHolder, acquiredAt: "2026-07-22T10:05:00.000Z" });
    await writeFile(join(runDir, ".owner-transfer.lock"), lockContents);

    // .then(onFulfilled, onRejected) rather than .catch(e => e): a .catch on a promise that
    // RESOLVES hands back undefined, and every assertion below would then be asserting about
    // undefined while reporting green. Throwing from onFulfilled makes a resolve a failure.
    const error = await readOwnerRecord(runDir).then(
      () => {
        throw new Error("expected readOwnerRecord to reject on an unattributable lock, but it resolved");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(OwnerTransferLockUnattributableError);
    expect(String(error)).toContain("no-pid-holder");

    // The lock is byte-for-byte still on disk -- not merely "present".
    expect(await readFile(join(runDir, ".owner-transfer.lock"), "utf8")).toBe(lockContents);

    // The half that matters. Read the file directly: readOwnerRecord itself now rejects, so it
    // cannot be the observer here.
    const persisted = JSON.parse(await readFile(join(runDir, "owner-record.json"), "utf8")) as OwnerRecord;
    expect(persisted.currentOwnerEpoch).toBe(1);
  });
```

- [ ] **Step 3: 跑它，确认它【红】了**

```bash
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/i2-t1-red.txt 2>&1; echo "RC=$?"
```
Expected: `RC=1`，**恰好 1 条红**，红的是
`refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone`，
失败信息是 `expected readOwnerRecord to reject on an unattributable lock, but it resolved`。

⚠️ *** **如果红在别的断言上（例如 epoch 是 2 而不是 1），说明你改的位置不对** *** —— 停下报告。

- [ ] **Step 4: 加上 `parsePid` 的守卫**

在 `src/persistence/fileStore.ts` 里用**整个函数体**做锚点（命中数必须 ==1）：

```ts
export function parsePid(processInstanceId: string): number | null {
  const match = /^pid:(\d+)$/.exec(processInstanceId);
  return match === null ? null : Number.parseInt(match[1], 10);
}
```

替换成：

```ts
export function parsePid(processInstanceId: unknown): number | null {
  // The parameter is `unknown` rather than `string` because that is what it actually is: both
  // callers hand over a value that came out of JSON.parse, and JSON is free to put an array
  // there. The old `string` annotation was not a description, it was a claim nobody checked --
  // and RegExp.prototype.exec coerces through String(), so `["pid:999999"]` used to match.
  //
  // This guard is LOAD-BEARING and criteria are what hold it: `unknown` makes a naive deletion
  // fail tsc, but a tidy-up that writes `exec(processInstanceId as string)` typechecks clean and
  // reopens the hole. Measured, 2026-09-23. Do not read the signature as the defence.
  if (typeof processInstanceId !== "string") {
    return null;
  }

  const match = /^pid:(\d+)$/.exec(processInstanceId);
  return match === null ? null : Number.parseInt(match[1], 10);
}
```

- [ ] **Step 5: 跑测试 ＋ typecheck，确认回绿**

```bash
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/i2-t1-green.txt 2>&1; echo "TEST_RC=$?"
npm run typecheck > /tmp/i2-t1-tc.txt 2>&1; echo "TC_RC=$?"
```
Expected: `TEST_RC=0`（91 tests 全绿）、`TC_RC=0`。

- [ ] **Step 6: 跑全套，确认没有波及别处**

```bash
./node_modules/.bin/vitest run > /tmp/i2-t1-full.txt 2>&1; echo "RC=$?"
```
Expected: `RC=1`，**红的集合 ⊆ Global Constraints 里那 5 条已知集合**（正常情况下只有 `stopProof` 一条）。
⚠️ **出现任何第 6 条红 ⇒ 停下报告，不要自行修。**

- [ ] **Step 7: 提交**

```bash
/usr/bin/git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
/usr/bin/git commit -m "fix(fileStore): stop parsePid from reading a pid out of a value that is not a string

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

