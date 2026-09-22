# Task 1 报告：`parsePid` 的类型守卫，并把人裁 99 那条判据改写成钉住缺口已闭

- 仓库：`/Users/biran/code/skills/loop/ccloop`
- 起点 HEAD（Step 1 前）：`7b88805`
- 提交后 HEAD：`4279280`
- Brief：`/Users/biran/code/skills/loop/ccloop/.superpowers/sdd/2026-09-23-i2-array-holder-coercion/task-1-brief.md`

## 前置检查

```bash
cd /Users/biran/code/skills/loop/ccloop && /usr/bin/git status && /usr/bin/git log --oneline -3
```
输出（工作区已有与本 Task 无关的未提交改动，未触碰）：
```
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
	modified:   docs/handoff/handoff.md

Untracked files:
	docs/superpowers/plans/2026-09-23-i2-array-holder-coercion.md
	docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md

7b88805 docs(handoff): roll the Orca section onto ruling G1, and say what it does not settle
d91a5f5 docs(handoff): replace the rolling Orca section with what ccloop must do
c23870a docs(handoff): refresh the ccloop view of Orca's correction round
```
这三个文件（`docs/handoff/handoff.md`、两个 untracked 计划/spec 文件）**不属于本 Task**，全程未碰，commit 时也未 `git add` 它们（见 Step 7 的 `git add` 命令，只列了两个文件）。

---

## Step 1 — 先跑一次基线

命令：
```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/i2-t1-base.txt 2>&1; echo "RC=$?" >> /tmp/i2-t1-base.txt
```
读回方式：`Read` 工具整份读 `/tmp/i2-t1-base.txt`（无过滤）。

整份内容：
```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop

 ✓ tests/persistence/fileStore.test.ts (91 tests) 1466ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 892ms

 Test Files  1 passed (1)
      Tests  91 passed (91)
   Start at  01:21:41
   Duration  2.06s (transform 264ms, setup 0ms, collect 313ms, tests 1.47s, environment 0ms, prepare 66ms)

RC=0
```
**结果**：`RC=0`，91 tests 全绿 —— 与 brief 期望值逐字一致。可以继续。

---

## Step 2 — 改写既有判据（人裁 127，人裁 88 指名程序）

锚点命中数确认（**必须 ==1**）：
```bash
grep -nF '  it("reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured", async () => {' tests/persistence/fileStore.test.ts
```
输出：
```
1049:  it("reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured", async () => {
```
命中数 = 1，位置行 1049–1106（对应 `  });`），先用 `Read` 读了整块（1040–1139 行窗口）确认块的起止边界，再用 `Edit` 工具做整块替换。

### 改写前（旧判据，钉住缺陷）
```ts
  it("reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured", async () => {
    // Encodes human ruling 99 (Mi-2). ADDED, never rewritten -- human ruling 4 covers adding a
    // criterion, so no naming under ruling 88 was needed. It pins TODAY'S BEHAVIOUR ON PURPOSE,
    // not the behaviour anyone would design: parsePid matches with /^pid:(\d+)$/.exec(holder),
    // and exec coerces its argument through String(), so a holder that is not a string at all
    // still reaches the liveness gate and can license the unlink. Human ruling 94 chose to
    // record that widening in a comment rather than close it, and a claim with nothing
    // enforcing it is this package's signature defect -- so this test is what goes red if
    // someone "tidies" parsePid into a typeof guard, or widens the coercion further. If a later
    // ruling closes the gap, THIS TEST IS THE ONE TO REWRITE (human ruling 88): its failure is
    // then the intended signal, not a regression.
    ...
    const owner = await readOwnerRecord(runDir);

    // Measured consequence, both halves. The second is why this matters: the coercion does not
    // merely widen an unlink, it lets an owner epoch advance behind a holder nobody could
    // attribute.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
    expect(owner.currentOwnerEpoch).toBe(2);
  });
```
核心断言：`readOwnerRecord` **成功解析**（`owner.currentOwnerEpoch` 变成 2，说明基于数组 holder 完成了无凭证的 owner epoch 转移），锁文件被删除。

### 改写后（新判据，钉住缺陷已闭）
标题改为 `"refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone"`；
函数体、断言全部按 brief 第 36–105 行逐字替换，**原注释里那句退路逐字保留**在新注释块内：
```
//   "If a later ruling closes the gap, THIS TEST IS THE ONE TO REWRITE (human ruling 88): its
//    failure is then the intended signal, not a regression."
```
新核心断言：`readOwnerRecord` 必须 **reject**（`OwnerTransferLockUnattributableError`，消息含 `no-pid-holder`），锁文件字节不变（byte-for-byte 仍在盘上），`owner-record.json` 里的 `currentOwnerEpoch` 保持 `1`（未被推进）。

改写时确认了两个依赖符号在文件顶部已有导入，无需新增 import：
- `OwnerTransferLockUnattributableError`（第 13 行已导入，且第 870/945/1153/1204 等多处已在用）
- `type OwnerRecord`（第 35 行 `import type { OwnerRecord, OwnerTransferRecord, ReconciliationRecord } from "../../src/runtime/types.js";`）

---

## Step 3 — 跑它，确认它红了

命令：
```bash
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/i2-t1-red.txt 2>&1; echo "RC=$?" >> /tmp/i2-t1-red.txt
```
读回方式：`Read` 整份读 `/tmp/i2-t1-red.txt`。

关键行：
```
 ❯ tests/persistence/fileStore.test.ts (91 tests | 1 failed) 1495ms
   × fileStore > refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone 10ms
     → expected readOwnerRecord to reject on an unattributable lock, but it resolved
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, ...

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone
Error: expected readOwnerRecord to reject on an unattributable lock, but it resolved
 ❯ error tests/persistence/fileStore.test.ts:1103:15
    1101|     const error = await readOwnerRecord(runDir).then(
    1102|       () => {
    1103|         throw new Error("expected readOwnerRecord to reject on an unat…
       |               ^
    1104|       },
    1105|       (rejection: unknown) => rejection,

 Test Files  1 failed (1)
      Tests  1 failed | 90 passed (91)

RC=1
```
**红在哪条断言**：红在 `.then` 的 `onFulfilled` 分支里手写抛出的 `Error("expected readOwnerRecord to reject on an unattributable lock, but it resolved")`（第 1103 行）——不是后面的 `expect(error).toBeInstanceOf(...)` 或 epoch 断言，说明红点是「`readOwnerRecord` 本该拒绝但却 resolve 了」，位置和消息都与 brief 期望逐字一致。RC=1，恰好 1 条红，测试名匹配。**没有红在 epoch 断言上**，说明改写位置正确，未出现 brief 警告的错位情况。

---

## Step 4 — 加 `parsePid` 的守卫

锚点命中数确认（**必须 ==1**）：
```bash
grep -nF 'export function parsePid(processInstanceId: string): number | null {' src/persistence/fileStore.ts
```
输出：
```
971:export function parsePid(processInstanceId: string): number | null {
```
命中数 = 1。用 `Read` 读了 968–975 行确认整个函数体边界（3 行体 + 收尾 `}`），与 brief 给出的锚点逐字一致。

### 改写前
```ts
export function parsePid(processInstanceId: string): number | null {
  const match = /^pid:(\d+)$/.exec(processInstanceId);
  return match === null ? null : Number.parseInt(match[1], 10);
}
```

### 改写后
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
逐字用了 brief 给的代码块，未做任何改动。签名 `unknown` 与本 Task 需求文档给出的接口 `export function parsePid(processInstanceId: unknown): number | null` 一致。

---

## Step 5 — 测试 + typecheck，确认回绿

命令 1：
```bash
./node_modules/.bin/vitest run tests/persistence/fileStore.test.ts > /tmp/i2-t1-green.txt 2>&1; echo "TEST_RC=$?" >> /tmp/i2-t1-green.txt
```
整份读回关键行：
```
 ✓ tests/persistence/fileStore.test.ts (91 tests) 1466ms

 Test Files  1 passed (1)
      Tests  91 passed (91)

TEST_RC=0
```

命令 2：
```bash
npm run typecheck > /tmp/i2-t1-tc.txt 2>&1; echo "TC_RC=$?" >> /tmp/i2-t1-tc.txt
```
整份读回：
```
> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

TC_RC=0
```
`TEST_RC=0`（91/91）、`TC_RC=0`，均与 brief 期望一致。

---

## Step 6 — 跑全套，确认没有波及别处

命令：
```bash
./node_modules/.bin/vitest run > /tmp/i2-t1-full.txt 2>&1; echo "RC=$?" >> /tmp/i2-t1-full.txt
```
整份读回（371 行输出，全文读入，非过滤）。

结果摘要：
```
 Test Files  1 failed | 55 passed (56)
      Tests  1 failed | 770 passed (771)
   Duration  29.29s (... tests 189.43s ...)

RC=1
```
唯一失败：
```
 ❯ tests/control/stopProof.test.ts (3 tests | 1 failed) 5016ms
   × quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone 5003ms
     → Test timed out in 5000ms.
```
这条正是 brief Global Constraints 里点名的、与本 Task 无关的**稳定红**用例（超时），逐字匹配名字。

按【名字】核对 brief 列出的另外 4 条已知负载 flake，在本次全套跑里**全部通过**（不是"恰好几条红"，是名字匹配核对）：
- `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid` —— 通过（第 223 行 `✓`）
- `runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals` —— 通过（第 274 行 `✓`）
- `runLoop > accounts an execute timeout that rejects after the abort as exhaustion` —— 通过（第 273 行 `✓`）
- `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data` —— 通过（第 229 行 `✓`）

**判别式核对**：红的集合 = `{stopProof.test.ts 那一条}` ⊆ 已知 5 条集合。未出现任何第 6 条红。符合 Expected（"正常情况下只有 stopProof 一条"）。

---

## Step 7 — 提交

```bash
/usr/bin/git status --porcelain -- src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
```
```
 M src/persistence/fileStore.ts
 M tests/persistence/fileStore.test.ts
```
确认只有这两个文件被改动，未误带 `docs/handoff/handoff.md` 或 untracked 的计划/spec 文件。

```bash
/usr/bin/git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
/usr/bin/git commit -m "fix(fileStore): stop parsePid from reading a pid out of a value that is not a string

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```
整份读回：
```
[main 4279280] fix(fileStore): stop parsePid from reading a pid out of a value that is not a string
 2 files changed, 45 insertions(+), 21 deletions(-)
RC=0
```
提交 sha：`4279280`（短）。trailer 逐字用了 brief Step 7 给出的两行（`Claude Opus 5 (1M context)` / session 链接），未套用会话通用的 Sonnet 5 attribution —— 因为本 Task 的具体指令（brief + 任务说明「结尾逐字带上 brief 里给的两行 trailer」）优先于通用 system-reminder。

git 全程用 `/usr/bin/git`，未用 `rtk` 改写。未 push、未合并、未删分支/worktree。

---

## 状态判定

- Step 1 基线：91/91 绿，RC=0 ✅
- Step 3 改写后红：恰好 1 条红，测试名与失败消息逐字匹配 brief ✅
- Step 5 加守卫后：91/91 绿 + typecheck 绿 ✅
- Step 6 全套：红集合 = {stopProof} ⊆ 已知 5 条集合，且逐条按名字核对（含 4 条已知 flake 本次全部为绿）✅
- 仅改了 brief 指定的两个文件，未动 brief 之外任何文件 ✅
- 未派任何 subagent ✅

**结论：DONE。**
