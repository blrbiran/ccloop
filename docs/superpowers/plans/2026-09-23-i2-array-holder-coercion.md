# I-2 Array-Holder Coercion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「holder 不是字符串」的 owner-transfer 锁在两条读取路径上都 fail closed —— `ccloop unlock` 拒绝而不是无凭证删锁，红线函数答 `unattributable` 而不是静默删锁。

**Architecture:** 两处生产改动。① `parsePid` 形参改 `unknown` ＋ `typeof` 守卫，一处修好两个调用方的分类。② `inspectLock` 把「喂去分类的值」与「渲染给人看的值」拆成两个变量 —— 这一拆是承重的：不拆的话渲染会先把数组变成字符串，`parsePid` 的守卫在 E1 路径上就完全不起作用。

**Tech Stack:** TypeScript 5.5 / Node 22 / vitest 2.0（`tsc --noEmit` ＋ `vitest run` ＋ `scripts/verify-control-protocol.mjs`，**本仓库没有 linter**）

**Spec:** `docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md`
⚠️ **执行者必须连 spec 一起读**，尤其 §3.0（承重面在哪）、§6.3（变异表）、§8.1（基线口径）。

---

## Global Constraints

以下每一条都来自本仓库 `CLAUDE.md` 与 spec，**每个 Task 都隐含包含**：

- **跑测试前必须 `export ECC_GATEGUARD=off DISABLE_OMC=1`。**
- *** **绝不过滤验证性跑。** *** `grep`/`tail`/`head`/`sed` 都算过滤，**管道还会吞退出码** ——
  一律 `命令 > 文件 2>&1; echo "RC=$?"` 再**整份读回**。
- *** **验证性 git 一律 `/usr/bin/git`** *** —— 本机 `rtk` 会改写 git 且有六种骗法。
- *** **本机 `rm`／`cp` 有 `-i` alias** *** ⇒ 一律 `/bin/rm -rf` 和 `cat pristine > target`。
- **zsh 吃掉无引号的 `--include=*.ts`** ⇒ 加引号。
- *** **不许 push。不许合并进 main。不许删分支或 worktree。** *** 这四件归人，且 Tier 0 闸门会拦。
- *** **不许自改既有判据。** *** 本轮**只有一条**既有判据获授权改写（Task 1），授权是**人裁 127**。
  碰到任何其它既有判据变红 ⇒ **停下报告，不要改它**。
- **已发布注释逐字保留，只能追加具名 ERRATUM**（铁律 5）。
- **基线不是全绿**：`tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as
  group quiet and proves only after the full tree is gone` 在当前 HEAD 上**稳定红**（超时），与本轮无关。
  另有 **5** 条已知负载 flake（spec §8.1 列全，其中第 5 条
  `SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute` 是 2026-09-23 本轮新发现的）。
  ⇒ *** **判别式 ＝「红的集合 ⊆ 这 6 条（1 条稳定红 ＋ 5 条 flake），且本轮新增／改写的判据全绿」。** ***
  ⚠️ **按【名字】核对，不要只数条数。**
- **提交在本地做，一笔一个 Task**；commit message 用英文。

---

## File Structure

| 文件 | 本轮的职责 |
|---|---|
| `src/persistence/fileStore.ts` | `parsePid` 的类型守卫（Task 1）＋ 三处 ERRATUM（Task 4） |
| `tests/persistence/fileStore.test.ts` | 改写人裁 99 那条判据（Task 1） |
| `src/unlock/inspectLock.ts` | 分类值／渲染值拆分 ＋ 放宽读取处断言（Task 2）＋ 一处 ERRATUM（Task 4） |
| `tests/unlock/inspectLock.test.ts` | N1／N3／N6／N7 ＋ 计数判据（Task 2） |
| `tests/unlock/unlockCommand.test.ts` | N2（Task 3） |

**不新建任何文件。不碰 `src/sweep/**`、`OwnerTransferLockRecord` 的类型声明、任何写入方。**

---

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
Expected: `RC=1`，**红的集合 ⊆ Global Constraints 里那 6 条已知集合**（正常情况下只有 `stopProof` 一条）。
⚠️ **出现任何第 6 条红 ⇒ 停下报告，不要自行修。**

- [ ] **Step 7: 提交**

```bash
/usr/bin/git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
/usr/bin/git commit -m "fix(fileStore): stop parsePid from reading a pid out of a value that is not a string

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

## Task 2: `inspectLock` 把分类值与渲染值拆开，并立四条新判据

**Files:**
- Modify: `src/unlock/inspectLock.ts`（`inspectOwnerTransferLock` 函数体里 holder 赋值与 pid 计算两处）
- Test: `tests/unlock/inspectLock.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parsePid(processInstanceId: unknown): number | null` ——
  **没有那个 `unknown` 签名，本 Task 的 `parsePid(rawHolder)` 过不了 typecheck。**
- Produces: `LockInspection` 的 `holder: string` 字段**语义变了**：
  非字符串 holder 现在装的是 `JSON.stringify(原值)`，不再是 `String(原值)` 的隐式强转结果。
  Task 3 依赖这个语义。

⚠️ *** **本 Task 是整个计划的承重点。** *** 拆分的理由见 spec §3.0：
不拆的话渲染会先把数组变成字符串，Task 1 的守卫在这条路径上完全不起作用。

- [ ] **Step 1: 先写四条新判据（此时应该红）**

在 `tests/unlock/inspectLock.test.ts` 顶部的 import 区，把 `fileStore.js` 那一行补上 `isProcessActive`：

```ts
import { isProcessActive, OWNER_TRANSFER_LOCK_FILE } from "../../src/persistence/fileStore.js";
```

在文件**最外层 `describe` 的末尾**（最后一个 `});` 之前）加入：

```ts
  // HUMAN RULING 127 (2026-09-23), I-2. A holder that is not a string at all used to reach the
  // liveness gate, because RegExp.prototype.exec coerces its argument through String(). On this
  // path that cost more than it did in the redline function: the inspection answered "dead", and
  // unlockCommand's dead branch deletes with NO --force and NO --expect digest.
  //
  // The state assertions and the rendering assertion are deliberately SEPARATE `it` blocks with
  // NARROW assertions, rather than one toEqual over the whole inspection the way the criteria
  // above are written. That is not style: deleting parsePid's guard and deleting the rendering are
  // two different mutations, and a single toEqual would go red for both, so neither mutation could
  // be shown to hold up its own branch.
  describe("a holder that is not a string at all (human ruling 127)", () => {
    const NON_STRING_STATE_CASES = [
      { name: "an array wrapping a dead bare pid", holder: ["pid:999999"] },
      { name: "an array wrapping pid:0, which the liveness probe cannot answer for", holder: ["pid:0"] },
    ];

    const NON_STRING_RENDER_CASES = [
      { name: "an array", holder: ["pid:999999"], rendered: '["pid:999999"]' },
      { name: "an object", holder: {}, rendered: "{}" },
    ];

    it("covers every non-string holder shape this round measured", () => {
      // "One case fewer" is GREEN in vitest -- it only shows up in a count. Both tables are
      // pinned so a case cannot be quietly dropped.
      expect(NON_STRING_STATE_CASES).toHaveLength(2);
      expect(NON_STRING_RENDER_CASES).toHaveLength(2);
    });

    for (const { name, holder } of NON_STRING_STATE_CASES) {
      it(`classifies ${name} as unrecognized-holder, never as a liveness verdict`, async () => {
        // Premise, asserted not assumed: 999999 must really be dead, or this would be pinning the
        // ordinary refusal instead of the coercion.
        expect(isProcessActive(999999)).toBe(false);

        const runDir = await makeRunDir();
        await writeLock(
          runDir,
          JSON.stringify({ holderProcessInstanceId: holder, acquiredAt: "2026-09-23T00:00:00.000Z" }),
        );

        const inspection = await inspectOwnerTransferLock(runDir);

        // Only the state. The rendering has its own criterion below.
        expect(inspection.state).toBe("unrecognized-holder");
      });
    }

    for (const { name, holder, rendered } of NON_STRING_RENDER_CASES) {
      it(`renders ${name} holder as what is actually on disk, not as String() sees it`, async () => {
        const runDir = await makeRunDir();
        await writeLock(
          runDir,
          JSON.stringify({ holderProcessInstanceId: holder, acquiredAt: "2026-09-23T00:00:00.000Z" }),
        );

        const inspection = await inspectOwnerTransferLock(runDir);

        // The literal, not the shape: a "shape" assertion stays green under any mutation that
        // swaps in another well-formed string. `["pid:999999"]` and `pid:999999` are both
        // well-formed; only one of them tells the operator the record is malformed.
        expect(inspection).toHaveProperty("holder", rendered);
      });
    }
  });
```

- [ ] **Step 2: 跑它们，确认【红】，并确认红的是哪几条**

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts > /tmp/i2-t2-red.txt 2>&1; echo "RC=$?"
```
Expected: `RC=1`，红 **2 条**，**两条都是渲染判据**：
- `renders an array holder as what is actually on disk, …`（现为 `["pid:999999"]` 的**数组本身**，不是字符串）
- `renders an object holder as what is actually on disk, …`（现为 `{}` 对象本身）

⚠️ *** **两条 `classifies …` 判据【此时都已经是绿的】** *** —— Task 1 的守卫按 `typeof` 无条件拦、
**不看值**，所以 `["pid:999999"]` 与 `["pid:0"]` 在 Task 1 之后就双双落 `unrecognized-holder`。
**这是预期的，不是错误。**
⚠️ *** **本段原写「红 3 条」并说 `pid:0` 那条现为 `liveness-unknown`，那是计划的错，实测打脸。** ***
更正记于 2026-09-23，控制器 Ruling 5。**它不影响 Task 5 的变异链** —— 删掉守卫后两条仍会转红。

- [ ] **Step 3: 落生产改动 —— 拆分类值与渲染值**

在 `src/unlock/inspectLock.ts` 里，用这一整块做锚点（命中数必须 ==1）：

```ts
  let holder: string;
  try {
    const parsed = JSON.parse(contents.toString("utf8")) as Partial<OwnerTransferLockRecord>;
```

替换成：

```ts
  // TWO values, not one, and this split is load-bearing. `rawHolder` is what the record actually
  // holds and it is what gets CLASSIFIED; `holder` is a rendering of it and it is only ever
  // DISPLAYED. Collapsing them back into one variable silently disarms parsePid's type guard on
  // this path: the rendering would turn an array into a string before parsePid ever saw it, and
  // the guard would stop being reachable. Measured 2026-09-23 -- with them collapsed, deleting
  // parsePid's guard changes nothing here at all.
  let holder: string;
  let rawHolder: unknown;
  try {
    // `unknown` per field, not `string`: this is JSON, and the record's declared field types are
    // a statement about what WE write, not about what is on disk. OwnerTransferLockRecord itself
    // is unchanged -- only this read is honest about what it got.
    const parsed = JSON.parse(contents.toString("utf8")) as Partial<Record<keyof OwnerTransferLockRecord, unknown>>;
```

再用这一行做锚点（命中数必须 ==1）：

```ts
    holder = parsed.holderProcessInstanceId ?? "";
```

替换成：

```ts
    rawHolder = parsed.holderProcessInstanceId ?? "";
    // AFTER the `??`, never before. TypeScript declares JSON.stringify's return type as `string`
    // rather than `string | undefined`, so a `undefined` slipping through here would reach the
    // operator as the word "undefined" with tsc saying nothing. Past the `??` the value is
    // always a JSON value, and no JSON value makes JSON.stringify return undefined.
    holder = typeof rawHolder === "string" ? rawHolder : JSON.stringify(rawHolder);
```

最后用这一行做锚点（命中数必须 ==1）：

```ts
  const pid = holder === "" ? null : parsePid(holder);
```

替换成：

```ts
  const pid = rawHolder === "" ? null : parsePid(rawHolder);
```

- [ ] **Step 4: 跑测试 ＋ typecheck，确认全绿**

```bash
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts > /tmp/i2-t2-green.txt 2>&1; echo "TEST_RC=$?"
npm run typecheck > /tmp/i2-t2-tc.txt 2>&1; echo "TC_RC=$?"
npm run build > /tmp/i2-t2-build.txt 2>&1; echo "BUILD_RC=$?"
```
Expected: 三个 RC 全是 `0`。`inspectLock.test.ts` 应为 **18 tests**（原 13 ＋ 新 5）。

- [ ] **Step 5: 跑全套**

```bash
./node_modules/.bin/vitest run > /tmp/i2-t2-full.txt 2>&1; echo "RC=$?"
```
Expected: 红的集合 ⊆ 那 6 条已知集合。⚠️ **出现任何【名字不在那 6 条里】的红 ⇒ 停下报告。**

- [ ] **Step 6: 提交**

```bash
/usr/bin/git add src/unlock/inspectLock.ts tests/unlock/inspectLock.test.ts
/usr/bin/git commit -m "fix(inspectLock): classify the holder the record actually carries, and render it honestly

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

## Task 3: 在 `unlock` 命令这一层钉住「锁没有被删」

**Files:**
- Test: `tests/unlock/unlockCommand.test.ts`（**只加判据，不动生产代码**）

**Interfaces:**
- Consumes: Task 2 的 `LockInspection.holder` 新语义；Task 1 的 `parsePid` 守卫。
- Produces: 无。

⚠️ 这一条与 Task 2 的 N1 **不是重复**：N1 在库层钉分类，本条在命令层钉**后果** ——
只有它能看见「锁文件还在盘上」和「退出码是 1」。

- [ ] **Step 1: 写判据**

在 `tests/unlock/unlockCommand.test.ts` 最外层 `describe` 末尾（最后一个 `});` 之前）加入：

```ts
  it("refuses an ARRAY holder that String()s into a dead pid, and leaves the lock exactly where it was", async () => {
    // HUMAN RULING 127 (2026-09-23), I-2. This cell used to exit 0 and DELETE, with no --force and
    // no --expect digest, because the inspection answered "dead" for a holder nobody could
    // attribute. This file's header says it plainly: this file is the only thing standing between
    // a new delete surface and no supervision.
    const runDir = await makeRunDir();
    const contents = JSON.stringify({
      holderProcessInstanceId: [`pid:${DEAD_PID}`],
      acquiredAt: "2026-09-23T00:00:00.000Z",
    });
    await seedLock(runDir, contents);

    // The existence assertion this file requires before every deletion assertion: without it,
    // "the lock is still there" would pass against a run directory where it was never created.
    expect(await lockExists(runDir)).toBe(true);

    const { code, out, err } = await run(runDir);

    expect(await lockExists(runDir), "an unattributable holder's lock was deleted").toBe(true);
    // Byte-for-byte, not merely present.
    expect(await readFile(join(runDir, OWNER_TRANSFER_LOCK_FILE), "utf8")).toBe(contents);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    // The PREFIX only. The holder's rendering has its own criterion in inspectLock.test.ts, and
    // pinning the whole line here would make the rendering mutation go red in two places, so
    // neither place could be shown to carry its own branch.
    expect(err[0]).toMatch(/^refused  unrecognized holder identity: /);
  });
```

- [ ] **Step 2: 跑它，确认【绿】—— 并解释为什么这次不先红**

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/unlock/unlockCommand.test.ts > /tmp/i2-t3.txt 2>&1; echo "RC=$?"
```
Expected: `RC=0`，**33 tests**（原 32 ＋ 新 1）。

⚠️ *** **这一条是在生产改动【之后】写的，所以它现在就绿 —— 光凭这次跑，它【不是】判据。** ***
它的红证由 **Task 5 的 M1** 提供：删掉 `parsePid` 的守卫，这一条必须变红。
**Task 5 没看到它红之前，不许在任何地方说它钉住了什么。**

- [ ] **Step 3: 提交**

```bash
/usr/bin/git add tests/unlock/unlockCommand.test.ts
/usr/bin/git commit -m "test(unlock): pin that an unattributable holder's lock survives the default path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

## Task 4: 追加具名 ERRATUM（**已发布注释逐字不动**）

**Files:**
- Modify: `src/persistence/fileStore.ts`（三处）、`src/unlock/inspectLock.ts`（一处）—— **只动注释**

**Interfaces:**
- Consumes: Task 1–3 的落地事实。
- Produces: 无。

⚠️ **铁律 5**：就地改**只**适用于本会话自己刚写、从未为真、且未发布的笔误。
这几处都是**已发布文本** ⇒ *** **原文逐字保留 ＋ 在注释块【末尾】追加 `*** ERRATUM (…, HUMAN RULING 127) … ***`。** ***
⚠️ **ERRATUM 里不许写会被后续裁决推翻的计数**，指向台账即可。
⚠️ **ERRATUM 不许引用会移动的 git 引用**（「HEAD」「remote tip」）。

- [ ] **Step 1: 先跑机械扫描，把清单从被更正的句子导出**

```bash
cd /Users/biran/code/skills/loop/ccloop
for w in "recorded, not fixed" "array holder" "array-holder" "no-pid-holder" "String()" "999999" "ruling 99" "ruling 94"; do
  echo "### $w"
  /usr/bin/grep -rin "$w" --include="*.ts" --include="*.md" src tests docs .superpowers
done > /tmp/i2-t4-scan.txt 2>&1; echo "RC=$?"
wc -l /tmp/i2-t4-scan.txt
```
**整份读回** `/tmp/i2-t4-scan.txt`。spec §4.1 列了**四处**必追 ＋ **两处**邻近过期文本。
⚠️ *** **如果扫描捞出第七处，把它报告出来，不要自行决定追不追。** ***

- [ ] **Step 2: `fileStore.ts` 人裁 94 那条 ERRATUM —— 追加**

在那个注释块的**末尾**（`The array case is pinned by a criterion under human ruling 99, so it cannot be "tidied" away silently. ***` 之后）追加：

```
  // *** ERRATUM (I-2, HUMAN RULING 127) -- THE THREE SENTENCES ABOVE ARE KEPT VERBATIM AND WERE
  // NEVER FALSE. Two of them are INDEXED to a round: "outside ruling 83's authorisation" and "E1
  // is outside this round's authorisation" both described the authorisation surface of ruling 94's
  // round, and both are still true of that round. What changed is that ruling 121 opened E1 and
  // ruling 127 authorised closing this cell on both sides -- so a reader must not take those two
  // sentences for the CURRENT disposition. The third, "pinned by a criterion under human ruling
  // 99, so it cannot be 'tidied' away silently", has inverted: that criterion was rewritten whole
  // under ruling 127 (named under ruling 88) and now pins the cell CLOSED. parsePid no longer
  // reads a pid out of a non-string, so the coercion this paragraph describes cannot happen here
  // at all. Which criterion pins which exit is recorded in the ledger, not here. ***
```

- [ ] **Step 3: `fileStore.ts` `parsePid` 上方那组注释 —— 追加**

在该注释块**末尾**（人裁 104 那条 ERRATUM 之后、`export function parsePid` 之前）追加：

```
// *** ERRATUM (I-2, HUMAN RULING 127) -- everything above is kept verbatim. It argues about what a
// second, "upgraded" IDENTITY NOTION would do, and that argument is untouched. What this function
// gained is different in kind: a type guard, because the parameter was annotated `string` while
// both callers hand it a value straight out of JSON.parse. exec() coerces through String(), so an
// array holder used to produce a pid. The signature now says `unknown`, which is what it always
// was. ⚠️ The signature is NOT the defence -- a tidy-up that casts the argument back to `string`
// typechecks clean and reopens the hole. The criteria are the defence; the ledger names them. ***
```

- [ ] **Step 4: `fileStore.ts` 人裁 108 那条 ERRATUM —— 追加**

在那个注释块的**末尾**（`... the same disposition the redline function's own ruling-94 erratum gives its array-holder cell. ***` 之后）追加：

```
      // *** ERRATUM (I-2, HUMAN RULING 127) -- the sentence above is kept verbatim. It cites
      // ruling 94's array-holder disposition as a live precedent for leaving a cell "recorded, not
      // fixed". That precedent no longer stands: ruling 127 closed the array-holder cell. The
      // cells THIS erratum is about -- pid:0, an out-of-range pid, an EPERM refusal -- are
      // untouched by that and are still recorded rather than fixed, so the disposition it
      // describes for ITSELF is unchanged; only the precedent it leans on is gone. ***
```

- [ ] **Step 5: `inspectLock.ts` 人裁 83 那条 ERRATUM —— 追加**

在该 ERRATUM 块的**末尾**（`... not one shared answer. ***` 之后）追加：

```
// *** ERRATUM (I-2, HUMAN RULING 127) -- kept verbatim, and one clause in it was TOO WIDE WHEN
// WRITTEN rather than overtaken later. "On BOTH cases it names -- an unrecognizable holder
// identity, ... -- the redline function no longer steals" was measured on holders that are
// STRINGS. A holder that is not a string at all -- `["pid:999999"]`, which String()s into
// `pid:999999` -- was unrecognizable in exactly the same sense, and on that sub-cell BOTH sides
// deleted: the redline function unlinked, and this command's `dead` branch removed the lock with
// no --force and no --expect. Ruling 127 made the sentence true for that sub-cell too, by giving
// parsePid a type guard and by classifying the value the record carries rather than a rendering
// of it. The sentence is now what it always claimed to be. ***
```

- [ ] **Step 6: 那两处邻近的过期文本 —— 各追一条**

spec §4.1 的第二张表：`fileStore.ts` 人裁 83 ERRATUM 里「Under ruling 83 an unparsed holder **returns false**」，
以及 `inspectLock.ts` 人裁 100 ERRATUM 里那个已不存在的 `pid === null || isProcessActive(pid)` 表达式。
**各追一条具名 ERRATUM 指出它指向的东西已经变了**，原文逐字不动。

- [ ] **Step 7: 字节扫描 ＋ 确认没动到代码**

```bash
cd /Users/biran/code/skills/loop/ccloop
# ⚠️ 不要用 grep 配 $'\x00…' —— bash 会在 NUL 处【截断参数】，模式变成空串、命中【每一行】。
# 实测踩过（2026-09-23）：报 1798/222 命中，正好等于两个文件的总行数。用 python 直接读字节。
python3 -c "
import sys
bad = 0
for p in ['src/persistence/fileStore.ts', 'src/unlock/inspectLock.ts']:
    data = open(p, 'rb').read()
    hits = sum(data.count(bytes([b])) for b in (0, 1, 2, 31))
    print('%s control-byte hits=%d' % (p, hits))
    bad += hits
print('TOTAL_CONTROL_BYTES=%d' % bad)
sys.exit(1 if bad else 0)
" > /tmp/i2-t4-bytes.txt 2>&1; echo "RC=$? （必须 0）"
cat /tmp/i2-t4-bytes.txt
/usr/bin/git diff --stat -- src > /tmp/i2-t4-diffstat.txt 2>&1; cat /tmp/i2-t4-diffstat.txt
/usr/bin/git diff -- src | python3 -c "
import sys
for line in sys.stdin:
    if line.startswith('-') and not line.startswith('---'):
        sys.stdout.write(line)
" > /tmp/i2-t4-deleted.txt 2>&1
echo '本 Task 删除的行数（应为 0）:'; wc -l < /tmp/i2-t4-deleted.txt
cat /tmp/i2-t4-deleted.txt
```
Expected: 字节扫描 0 命中；**删除行数为 0**（只追加，不删任何已发布文本）；
diffstat 只有 `+`。⚠️ **删除行数非 0 ⇒ 你动了已发布文本，退回重做。**

- [ ] **Step 8: 跑全套 ＋ 提交**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
npm run typecheck > /tmp/i2-t4-tc.txt 2>&1; echo "TC_RC=$?"
./node_modules/.bin/vitest run > /tmp/i2-t4-full.txt 2>&1; echo "RC=$?"
/usr/bin/git add src/persistence/fileStore.ts src/unlock/inspectLock.ts
/usr/bin/git commit -m "docs(comments): record what ruling 127 changed about the array-holder cell, and what it did not

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

## Task 5: 变异电池 —— **把每一条新判据都【看着】打红**

**Files:** 无（全部在 `git clone --local` 副本里；主工作树零触碰）

**Interfaces:**
- Consumes: Task 1–4 的全部落地。
- Produces: 一张「变异 → 实际红在哪」的表，进台账。

⚠️ *** **这是整个计划的终点判据。** *** 不是「测试绿了」，是**每条变异都被看见打红**。
*** **一条判据在被【看到】打红之前，它不是判据。** ***

- [ ] **Step 1: 建副本，跑基线**

```bash
S=/tmp/i2-mut
/bin/rm -rf "$S"
/usr/bin/git clone --local /Users/biran/code/skills/loop/ccloop "$S" > /tmp/i2-t5-clone.txt 2>&1; echo "RC=$?"
ln -s /Users/biran/code/skills/loop/ccloop/node_modules "$S/node_modules"
cd "$S"
npm run build > /tmp/i2-t5-build.txt 2>&1; echo "BUILD_RC=$?"
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run > /tmp/i2-t5-base.txt 2>&1; echo "BASE_RC=$?"
```
⚠️ *** **`npm run build` 这一步不能省** *** —— `dist/` 被 gitignore，不 build 会让
`tests/control/endToEnd.test.ts` 的 6 条以 `ENOENT … dist/cli.js` **假红**。
Expected: 基线红的集合 ⊆ 那 6 条已知集合。**基线不合格就停，别在红基线上跑变异（整组会作废）。**

- [ ] **Step 2: M1 —— 删掉 `parsePid` 的守卫**

```bash
cd /tmp/i2-mut
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m1-before.txt
```
把 `parsePid` 里的

```ts
  if (typeof processInstanceId !== "string") {
    return null;
  }

  const match = /^pid:(\d+)$/.exec(processInstanceId);
```

改成（**用 `as string`，因为裸删过不了 typecheck，而 tidy-up 最可能这么写**）：

```ts
  const match = /^pid:(\d+)$/.exec(processInstanceId as string);
```

```bash
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m1-after.txt
diff /tmp/i2-m1-before.txt /tmp/i2-m1-after.txt; echo "DIFF_RC=$? （必须非 0，相等就是变异没落上去，当场停）"
npm run build > /tmp/i2-m1-build.txt 2>&1; echo "BUILD_RC=$?"
./node_modules/.bin/vitest run > /tmp/i2-m1.txt 2>&1; echo "RC=$?"
```
**预期红在（实测过的，写成「且仅」）**：
- `refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone`
- `classifies an array wrapping a dead bare pid as unrecognized-holder, never as a liveness verdict`
- `classifies an array wrapping pid:0, … as unrecognized-holder, never as a liveness verdict`
- `refuses an ARRAY holder that String()s into a dead pid, and leaves the lock exactly where it was`

⚠️ *** **两条【渲染】判据必须保持绿** ***（`renders an array holder …`、`renders an object holder …`）
—— 它们绿，才证明两支真的被拆开了。**它们若也红，说明 Step 3 的拆分没做对，停下报告。**
⚠️ **M1 期间 `npm run typecheck` 预期 RC=0** —— 不要把 typecheck 绿读成变异没落上去，看 shasum。

- [ ] **Step 3: 还原，跑 M3 —— 删掉渲染**

```bash
cd /tmp/i2-mut
/usr/bin/git checkout -- src/persistence/fileStore.ts
shasum -a 256 src/unlock/inspectLock.ts > /tmp/i2-m3-before.txt
```
把 `holder = typeof rawHolder === "string" ? rawHolder : JSON.stringify(rawHolder);`
改成 `holder = rawHolder as string;`

```bash
shasum -a 256 src/unlock/inspectLock.ts > /tmp/i2-m3-after.txt
diff /tmp/i2-m3-before.txt /tmp/i2-m3-after.txt; echo "DIFF_RC=$? （必须非 0）"
npm run build > /tmp/i2-m3-build.txt 2>&1
./node_modules/.bin/vitest run > /tmp/i2-m3.txt 2>&1; echo "RC=$?"
```
**预期红在且仅**：`renders an array holder …` ＋ `renders an object holder …`。
⚠️ **三条 state 判据与 N2 必须保持绿**（state／exit／锁一格不变）。

- [ ] **Step 4: 还原，跑 M5 —— `why` 换字面量**

```bash
cd /tmp/i2-mut
/usr/bin/git checkout -- src/unlock/inspectLock.ts
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m5-before.txt
```
把 `return { kind: "unattributable", why: "no-pid-holder" };`
改成 `return { kind: "unattributable", why: "MUTANT-M5" as "no-pid-holder" };`

```bash
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m5-after.txt
diff /tmp/i2-m5-before.txt /tmp/i2-m5-after.txt; echo "DIFF_RC=$? （必须非 0）"
npm run build > /tmp/i2-m5-build.txt 2>&1
./node_modules/.bin/vitest run > /tmp/i2-m5.txt 2>&1; echo "RC=$?"
```
**预期红在且仅两条**：§6.1 那条改写后的判据 ＋ **既有的**
`refuses a lock whose holder identity is not a pid as unattributable, never as busy`。
⚠️ **第二条是既有判据，它红是预期的，不要改它。**

- [ ] **Step 5: 删副本，证明主工作树零触碰**

```bash
/usr/bin/git -C /tmp/i2-mut checkout -- src
/bin/rm -f /tmp/i2-mut/node_modules
/bin/rm -rf /tmp/i2-mut
cd /Users/biran/code/skills/loop/ccloop
/usr/bin/git diff -- src tests > /tmp/i2-zero1.txt 2>&1; echo "diff 字节数 = $(wc -c < /tmp/i2-zero1.txt)"
/usr/bin/git diff --cached -- src tests > /tmp/i2-zero2.txt 2>&1; echo "cached 字节数 = $(wc -c < /tmp/i2-zero2.txt)"
ls -d /Users/biran/code/skills/loop/ccloop/node_modules && echo "主树 node_modules 完好"
```
Expected: 两个字节数都是 **0**；`node_modules` 还在（**先删软链本身再删目录**，否则会删穿到主树）。

- [ ] **Step 6: 最终验收**

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
npm run typecheck > /tmp/i2-final-tc.txt 2>&1;   echo "TC_RC=$?"
npm run build     > /tmp/i2-final-build.txt 2>&1; echo "BUILD_RC=$?"
./node_modules/.bin/vitest run > /tmp/i2-final.txt 2>&1; echo "SUITE_RC=$?"
node scripts/verify-control-protocol.mjs > /tmp/i2-final-vc.txt 2>&1; echo "VC_RC=$?"
```
**通过条件**（每个输出文件都**整份读回**）：
1. `TC_RC=0`、`BUILD_RC=0`、`VC_RC=0`。
2. 全套红的集合 ⊆ 那 6 条已知集合，**且本轮新增／改写的 6 条判据全绿**。
3. 判据总数 ＝ **771 ＋ 6**（新增 5 条 ＋ 1 条计数判据；改写那条不增不减）＝ **777**。
   ⚠️ **数不对就停** —— 「少跑一条」在 vitest 里是绿的。
4. M1／M3／M5 三张变异表逐格相符，**每条都被看见红**。

---

## Self-Review（**控制器已跑，结论留档**）

**1. Spec 覆盖**：spec §3.1→Task 1；§3.2／§3.3→Task 2；§4.1→Task 4；
§6.1→Task 1 Step 2；§6.2 的 N1／N3／N6／N7 ＋计数→Task 2，N2→Task 3，N5→Task 1；
§6.3→Task 5；§9→Task 5 Step 6。**无遗漏。**
⚠️ §3.3 那条断言放宽**故意没有判据** —— spec 已登记为「钉不住，不编假判据」。

**2. 占位符扫描**：0 命中（扫描器带必抓／必不抓自检）。

**3. 类型一致性**：`parsePid(processInstanceId: unknown)` 在 Task 1 定义、Task 2 消费 ——
Task 2 的 Interfaces 块已写明**没有那个签名就编译不过**。
`rawHolder`／`holder` 两个变量名在 Task 2、Task 5 Step 3 里一致。
`DEAD_PID`（`unlockCommand.test.ts` 既有常量，值 999999）只在 Task 3 用，Task 2 用字面量 999999
因为 `inspectLock.test.ts` 没有那个常量 —— **两边都写了 `isProcessActive(999999)` 的前提断言**。

**4. 已知会偏离 TDD 的一处**：Task 3 的判据写在生产改动之后，**当场就是绿的**。
计划已在 Task 3 Step 2 明说这一点，并把它的红证指派给 Task 5 的 M1。
*** **不许在 Task 5 跑完之前宣称它钉住了任何东西。** ***
