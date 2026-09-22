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
Expected: 基线红的集合 ⊆ 那 5 条已知集合。**基线不合格就停，别在红基线上跑变异（整组会作废）。**

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
2. 全套红的集合 ⊆ 那 5 条已知集合，**且本轮新增／改写的 6 条判据全绿**。
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
