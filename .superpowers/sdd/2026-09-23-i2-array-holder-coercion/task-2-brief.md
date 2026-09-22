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
Expected: `RC=1`，红 **3 条**：
- `classifies an array wrapping pid:0, … as unrecognized-holder, never as a liveness verdict`（现为 `liveness-unknown`）
- `renders an array holder as what is actually on disk, …`（现为 `["pid:999999"]` 的**数组本身**，不是字符串）
- `renders an object holder as what is actually on disk, …`（现为 `{}` 对象本身）

⚠️ *** **`classifies an array wrapping a dead bare pid …` 这一条【此时已经是绿的】** ***
—— Task 1 的守卫已经让它落 `unrecognized-holder`。**这是预期的，不是错误。**

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
Expected: 红的集合 ⊆ 那 5 条已知集合。⚠️ **出现第 6 条 ⇒ 停下报告。**

- [ ] **Step 6: 提交**

```bash
/usr/bin/git add src/unlock/inspectLock.ts tests/unlock/inspectLock.test.ts
/usr/bin/git commit -m "fix(inspectLock): classify the holder the record actually carries, and render it honestly

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

