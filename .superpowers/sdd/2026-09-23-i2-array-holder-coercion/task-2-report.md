# Task 2 report — inspectLock 把分类值与渲染值拆开

状态：**DONE**（Step 1–5 已完成并验证；Step 5 首次跑出触发简报"出现第 6 条 ⇒ 停下报告"的条件，
按指令停下并交回报告；协调者复核后裁定该条为新的第 6 条已知 flake、放行提交，见文末
"控制器裁决后的收尾"一节，Step 6 已于裁决后执行，提交 sha `994f662`）。

仓库根：`/Users/biran/code/skills/loop/ccloop`
起始 HEAD：`42792806a997e124b3887ec509677021a858eced fix(fileStore): stop parsePid from reading a pid out of a value that is not a string`
（brief 里写的 `4279280` 是这个 sha 的前缀，核对一致。）

工作树在本 Task 开始前不是全净：`docs/handoff/handoff.md` 已被修改，且有两个未跟踪文件
（`docs/superpowers/plans/2026-09-23-i2-array-holder-coercion.md`、
`docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md`）。这些**不是本 Task 产生的**，
本 Task 全程未碰它们（见下方 Step 6 前的 `git status`／`git diff --stat` 证据）——按 Rule 3，多 agent 共享仓库下
别的 agent 的工作不是我的禁区之外的东西，我只报现象不动手。

---

## Step 0：确认基线

```
cd /Users/biran/code/skills/loop/ccloop
/usr/bin/git log -1 --format='%H %s'
```
输出：`42792806a997e124b3887ec509677021a858eced fix(fileStore): stop parsePid from reading a pid out of a value that is not a string`
RC=0

`grep -n "export function parsePid" src/persistence/fileStore.ts` → `971:export function parsePid(processInstanceId: unknown): number | null {`
确认接口已按预期落地，带 `typeof processInstanceId !== "string"` 的无条件类型守卫（sed -n 971,983p 读回确认）。

## Step 1：加四条新判据（逐字照抄 brief 的代码块）

- `tests/unlock/inspectLock.test.ts` 顶部 import 行改为：
  `import { isProcessActive, OWNER_TRANSFER_LOCK_FILE } from "../../src/persistence/fileStore.js";`
  （Edit 工具的锚点唯一性检查通过，原文只有一处匹配。）
- 在最外层 `describe` 末尾、最后一个 `});` 之前，插入 brief 给的整段
  `describe("a holder that is not a string at all (human ruling 127)", ...)` 块，一字未改。
  锚点 `^});$`（文件末尾闭合外层 describe 的那一行）grep -c 命中 1，是本文件里唯一顶格的 `});`。

## Step 2：跑新判据，确认红（且确认红的是哪几条）—— **与 brief 的"3 条"不完全一致，已展开核实**

```
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts > /tmp/i2-t2-red.txt 2>&1; echo "RC=$?"
```
`RC=1`（整份回读 `/tmp/i2-t2-red.txt`，非过滤）

实测：**18 tests | 2 failed**（brief 预期 3 failed），红的两条逐字：

```
× inspectOwnerTransferLock > a holder that is not a string at all (human ruling 127) > renders an array holder as what is actually on disk, not as String() sees it 4ms
  → expected { state: 'unrecognized-holder', …(3) } to have property "holder" with value '["pid:999999"]'
× inspectOwnerTransferLock > a holder that is not a string at all (human ruling 127) > renders an object holder as what is actually on disk, not as String() sees it 1ms
  → expected { state: 'unrecognized-holder', …(3) } to have property "holder" with value '{}'
```

brief 预期第三条红是 `classifies an array wrapping pid:0, … as unrecognized-holder, never as a liveness verdict`
（说"现为 liveness-unknown"）。**实测这一条在 Step 1 之后、Step 3 生产改动之前就已经是绿的**，
和 brief 明确标注为"预期绿"的 `classifies an array wrapping a dead bare pid …` 一样。

**为什么**（已用 Task 1 落地的代码核实，不是猜测）：`src/persistence/fileStore.ts:971` 的 `parsePid` 守卫是
`if (typeof processInstanceId !== "string") return null;` —— **无条件按类型拦，不看值**。Step 3 生产改动之前，
`inspectLock.ts` 里 `holder = parsed.holderProcessInstanceId ?? "";` 这一行把原始值（可能是数组／对象）直接赋给
声明为 `string` 的变量，TS 的类型注解在运行时不做任何转换，所以此时 `holder` 运行时其实就是原始的
`["pid:0"]` / `["pid:999999"]`。随后 `parsePid(holder)` 拿到的就是这个原始数组，无论数组里包的是
`"pid:999999"` 还是 `"pid:0"`，`typeof` 守卫都会在看到内容之前就返回 `null` —— 两个 state 判据因此
**都**已经落 `unrecognized-holder`，不是只有 999999 那一条。这不是本 Task 引入的偏差，是 Task 1 的守卫本来就
比 brief Step 2 注释预想的更宽（按类型拦、不按值），我没有改动 Task 1 的任何代码来验证这一点。

对 Task 5 的 mutation 证明链没有影响：若日后删掉 `parsePid` 的类型守卫，`["pid:999999"]`/`["pid:0"]`
经 `RegExp.prototype.exec` 的隐式 `String()` 强转后会分别解析出 `999999`（→ `dead`）和 `0`
（→ `liveness-unknown`），两条 state 判据都会转红——两条判据依然各自扛得住"删守卫"这条变异，只是在
**当前**（守卫已在、拆分未做）这一步就已经先转绿了，不是靠 Step 3 的拆分才转绿。

按 Rule 1 的阶梯：此判断可逆（未提交），且有上面这条可复核的代码证据支持，我按此结论继续到 Step 3，
未升级为阻塞点；本节保留在报告里供复核。

## Step 3：生产改动（逐字照抄 brief 的三处替换，Edit 工具强制锚点唯一）

三处替换均通过 Edit 工具完成，每处的 `old_string` 在文件中只有一次匹配（Edit 工具在非唯一时会报错，
三次调用均一次成功，无重试）：

1. `let holder: string;\n  try {\n    const parsed = JSON.parse(...) as Partial<OwnerTransferLockRecord>;`
   → 拆成 `holder` / `rawHolder` 两个变量，`parsed` 类型改为
   `Partial<Record<keyof OwnerTransferLockRecord, unknown>>`，并加 brief 给定的注释，逐字未改。
2. `holder = parsed.holderProcessInstanceId ?? "";`
   → `rawHolder = parsed.holderProcessInstanceId ?? "";` 加 brief 给定注释，随后
   `holder = typeof rawHolder === "string" ? rawHolder : JSON.stringify(rawHolder);`（`??` 之后渲染）。
3. `const pid = holder === "" ? null : parsePid(holder);`
   → `const pid = rawHolder === "" ? null : parsePid(rawHolder);`

`holder` 仍是外层 `let holder: string;`，未改成 `const`。

## Step 4：测试 + typecheck + build

```
./node_modules/.bin/vitest run tests/unlock/inspectLock.test.ts > /tmp/i2-t2-green.txt 2>&1; echo "TEST_RC=$?"
npm run typecheck > /tmp/i2-t2-tc.txt 2>&1; echo "TC_RC=$?"
npm run build > /tmp/i2-t2-build.txt 2>&1; echo "BUILD_RC=$?"
```
`TEST_RC=0`　`TC_RC=0`　`BUILD_RC=0`（三份文件均整份回读，非过滤）

`/tmp/i2-t2-green.txt` 关键行：
```
✓ tests/unlock/inspectLock.test.ts (18 tests) 16ms
Test Files  1 passed (1)
     Tests  18 passed (18)
```
**实测 18 tests**（原 13 ＋ 新 5：1 条 length 判据 ＋ 2 条 classify ＋ 2 条 render），与 brief 预期一致。

## Step 5：全套 —— **触发了"出现第 6 条 ⇒ 停下报告"**

```
./node_modules/.bin/vitest run > /tmp/i2-t2-full.txt 2>&1; echo "RC=$?"
```
`RC=1`，整份回读 335 行。`Test Files  2 failed | 54 passed (56)`　`Tests  2 failed | 774 passed (776)`。

红的两条，逐字：
1. `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone`
   —— `Error: Test timed out in 5000ms.` —— **在已知的稳定红名单内**，与本 Task 无关。
2. `tests/runtime/claude/subprocessClaudeAdapter.test.ts > SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`
   —— `AssertionError: expected { completionStatus: 'partial', …(6) } to match object { …(4) }`
   —— **不在简报给的 5 条已知集合（1 条稳定红 + 4 条已知 flake）里的任何一条**，按名字核对，是第 6 条。

按简报第 6 点与仓库铁律"红的集合 ⊆ 那 5 条已知集合……出现第 6 条 ⇒ 停下报告"，**在此处停下，未执行 Step 6**。

**额外证据**（为报告收集，不改变"未提交"的决定）：原地重跑一次全套：
```
./node_modules/.bin/vitest run > /tmp/i2-t2-full-rerun.txt 2>&1; echo "RC=$?"
```
`RC=1`，整份回读 293 行。`Test Files  1 failed | 55 passed (56)`　`Tests  1 failed | 775 passed (776)`，
唯一红的是 `stopProof` 那一条（已知稳定红）；`subprocessClaudeAdapter … waits for close before interrupting a
close-pending successful execute` 这次是绿的（`✓ … 901ms`）。两次运行之间我没有改动任何代码。

这与该测试的失败样式（`AssertionError`，两次运行内容不同——一次是 `inner-success.txt`/`ok` 的成功产物，
一次是 `dirty.txt`/`"claude phase runner interrupted by SIGTERM"` 的中断产物）一致地指向一个**时序型
flake**：`waits for close before interrupting a close-pending successful execute` 这个用例名本身就在描述一个
"close 挂起 vs. interrupt 竞速"的时序窗口，与本 Task 改动的 `src/unlock/inspectLock.ts`（holder 分类/渲染）
和 `tests/unlock/inspectLock.test.ts` 完全是两个子系统，没有代码路径交叉。但这是**我的推断**，不是我被授权
自行拍板"这是良性 flake、可以放行"的依据——简报把"出现第 6 条"明确列为停下报告的条件，没有给"重跑确认后可
继续"的例外，我没有替它加这个例外。

## 尚未执行

- **Step 6（`git add` + `git commit`）未执行。** `src/unlock/inspectLock.ts` 与
  `tests/unlock/inspectLock.test.ts` 的改动都在工作树里，处于未暂存状态（下方 `git status` 证据）。

```
/usr/bin/git status --porcelain=v1
```
```
 M docs/handoff/handoff.md
 M src/unlock/inspectLock.ts
 M tests/unlock/inspectLock.test.ts
?? docs/superpowers/plans/2026-09-23-i2-array-holder-coercion.md
?? docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md
```
```
/usr/bin/git diff --stat -- src/unlock/inspectLock.ts tests/unlock/inspectLock.test.ts
```
```
 src/unlock/inspectLock.ts        | 21 +++++++++++--
 tests/unlock/inspectLock.test.ts | 67 +++++++++++++++++++++++++++++++++++++++-
 2 files changed, 84 insertions(+), 4 deletions(-)
```
`docs/handoff/handoff.md` 与两个未跟踪的 docs 文件不是本 Task 产生的，本 Task 全程未 `git add`／未修改它们。

## 给协调者的决定点

1. 是否把 `tests/runtime/claude/subprocessClaudeAdapter.test.ts > … waits for close before interrupting a
   close-pending successful execute` 追加进已知 flake 名单（第 6 条），从而允许 Step 6 提交？
   —— 重跑证据支持这是 flake，但这是我的推断，不是我被授权自行认定的结论。
2. Step 2 的"classifies an array wrapping pid:0 …"判据比 brief 注释预期的更早转绿（Task 1 的类型守卫按类型
   拦、不按值），是否需要更新 brief/spec 里的这条注释以免误导后续 Task 的读者？我没有改动 brief 或任何既有
   判据。

## 控制器裁决后的收尾

协调者复核后下达了裁决（未采信我的自陈，自己独立复核）：

**Ruling 4 —— 那条新红判为 flake，放行提交。** 协调者的复核依据：
(a) 因果面：`/usr/bin/grep -n "inspectLock\|parsePid\|OwnerTransferLock\|unlock" src/runtime/claude/subprocessClaudeAdapter.ts`
零命中 —— 本 Task 的改动够不着该文件；
(b) 在我留下的、带 Task 2 未提交改动的工作树上单跑该测试文件 5 次，5/5 全绿，28 passed。
⇒ 判定为第 6 条负载相关 flake，此前没人记过，已加入已知名单。协调者同时明确：
"你停下来报告是对的做法，不是多余的谨慎——出现第 6 条就停这条指令就是为这种情形写的，
自行认定良性放行才是错的。"（即 Step 5 当时的 BLOCKED 停下决定被确认为正确，不是过度谨慎。）

**Ruling 5 —— 顾虑 2 成立：是计划写错了，不是我做错了。** Step 2 写"应红 3 条"，实测 2 条；
原因是 `parsePid` 的守卫按 `typeof` 无条件拦、不看值，两条数组 state 判据在 Task 1 之后就双双已绿，
不只 999999 那一条。brief 里"现为 `liveness-unknown`"那句对 `pid:0` 那一行是过期的。
裁决：**不为此改任何判据或生产代码**（本 Task 全程未改）；不影响 Task 5 的变异链（删守卫后两条仍会转红）；
计划正文由控制器一侧更正，本 Task 不用管。

### 提交前的最后一次全套（Step 6 之前）

```
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run > /tmp/i2-t2-full-precommit.txt 2>&1; echo "RC=$?"
```
`RC=1`（整份回读 298 行，非过滤）。`Test Files  1 failed | 55 passed (56)`　`Tests  1 failed | 775 passed (776)`。

红的集合（按名字列全，仅 1 条）：
- `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone`
  —— `Error: Test timed out in 5000ms.` —— 已知稳定红，与本 Task 无关。

`tests/runtime/claude/subprocessClaudeAdapter.test.ts` 全部 28 tests 本次全绿（含之前那条 flake 用例，
673ms 通过）。红的集合 ⊆ 已知 6 条集合（1 条稳定红 ＋ 5 条已知 flake，含 Ruling 4 新加入的这条），符合
"通过"标准，随即执行 Step 6。

### Step 6：提交

```
/usr/bin/git add src/unlock/inspectLock.ts tests/unlock/inspectLock.test.ts
/usr/bin/git status --porcelain=v1
```
提交前暂存区确认（整份回读）：
```
 M docs/handoff/handoff.md
M  src/unlock/inspectLock.ts
M  tests/unlock/inspectLock.test.ts
?? docs/superpowers/plans/2026-09-23-i2-array-holder-coercion.md
?? docs/superpowers/specs/2026-09-23-i2-array-holder-coercion-design.md
```
`docs/handoff/handoff.md` 保持未暂存（` M`），两个未跟踪 docs 文件保持未跟踪——确认没有被一并带上。

```
/usr/bin/git commit -m "fix(inspectLock): classify the holder the record actually carries, and render it honestly

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```
`COMMIT_RC=0`，提交 sha：`994f66289b9697d6d453a2eaa173b8992e3661db`（短 sha `994f662`）。

`/usr/bin/git show --stat HEAD` 整份回读：
```
commit 994f66289b9697d6d453a2eaa173b8992e3661db
Author: biran <blrbiran@163.com>
Date:   Wed Sep 23 01:39:48 2026 +0800

    fix(inspectLock): classify the holder the record actually carries, and render it honestly

    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8

 src/unlock/inspectLock.ts        | 21 +++++++++++--
 tests/unlock/inspectLock.test.ts | 67 +++++++++++++++++++++++++++++++++++++++-
 2 files changed, 84 insertions(+), 4 deletions(-)
```

证明：本次提交只带了 `src/unlock/inspectLock.ts` 与 `tests/unlock/inspectLock.test.ts` 两个文件，
commit message 与 brief Step 6 给定文本逐字一致（含两行 trailer）。`docs/handoff/handoff.md` 与两个
未跟踪的 `docs/superpowers/*` 文件全程未被本 Task 触碰、未被带入本次提交。
