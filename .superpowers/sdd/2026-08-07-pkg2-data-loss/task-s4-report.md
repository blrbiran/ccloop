# Task S4 — implementer report（包 2：D-1 ＋ 最薄一格 `#7`）

BASE `8ae495f` ／ HEAD `826593a` ／ 分支 `feat/pkg2-s4` ／ worktree `.worktrees/pkg2-s4`
提交范围 `8ae495f..826593a`（2 笔，均本地，未 push、未合并、未删任何东西）。

---

## 1. 结论

**状态：DONE_WITH_CONCERNS。**两半都做了，全套件／tsc／build 全绿，零既有判据被改。
`DONE_WITH_CONCERNS` 的唯一原因是**第 2 节里如实列出的「仍然敞开」三条**，不是任何验证失败。

**做了什么**

1. **D-1（方案 (a)，人裁 29）**：新建 `src/controller/ownedRunStateWriter.ts`，把
   `createOwnedRunStateWriter` ／ `OwnedRunStateWriter` ／ 仅为写入器服务的私有件
   `observeOwnership` ＋ `OwnershipObservation` 整体搬过去，`runLoop.ts` **不再 import `writeRunState`**
   （连带 `readOwnerRecordWithoutRecovery`、`parseOwnerRecordForLease` 因随之无用而移除）。
   **行为逐字不变**，机械证明见本节末。
2. **执行机制**：新增 `tests/controller/ownedRunStateWriter.structure.test.ts`，读 `runLoop.ts` 源码，
   **按 import 说明符**（不是本地绑定名）断言其中不含 `writeRunState`；
   另加一条断言禁止对 `fileStore` 的 namespace import（这条是我自己发现漏洞后补的，见第 8 节）。
   测试自带**必命中/必零命中双探针**，防止正则失效造成空转。
3. **最薄一格 `#7`**：在 `tests/controller/runLoop.integration.test.ts` 新增具名回归
   `refuses to write the terminal failed status of a retry-cleanup failure into a run a different owner holds`，
   钉住 `cleanupAttemptWorkspace` 抛之后那条终态写点（F-1 的第二个终态写点）。
4. **具名勘误**：搬走后失实的两句已在新模块内**具名改写并逐字引原文**，未静默删改（第 3 节）。

**跑过什么、退出码**（全部经 `rtk proxy`，全文 tee 落盘，未过滤）

| 跑 | 结果 | 退出码 |
|---|---|---|
| 全套件 `npx vitest --run`（终态树，日志 `full2-test.log`） | `Test Files 31 passed (31)` ／ `Tests 520 passed (520)` | `TEST_EXIT=0` |
| `npx tsc --noEmit`（`full2-tsc.log`） | 无输出 | `TSC_EXIT=0` |
| `npm run build`（`full2-build.log`） | 正常 | `BUILD_EXIT=0` |

`RUN` 首行已核：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4` —— **是本 worktree**。
全日志 `^ FAIL ` 计数 = **0**（探针已验活：必命中 `RUN  v2` = 1，必零命中 `zzq-nonsense` = 0）。
**允许名单里的 flake (B)、(F) 以及人裁 10 那条本轮均通过** —— 记为「本轮未复现」，**不视为它们消失的证据**。

基线对照：控制器记的 worktree 基线是 30 files / 518 tests（1 红 = flake (B)）。
本轮 31 / 520 = **+1 测试文件、+2 测试**，正好是新增的两条判据，**无既有测试被删改**
（`git diff --numstat 8ae495f..HEAD` 对 `tests/controller/runLoop.integration.test.ts` 为 `131 0`，**零删除行**）。

**行为不变的机械证明**：把 BASE `src/controller/runLoop.ts` 的第 937–1060 行与新模块正文
（去掉新模块前 5 行 import）**各自剥掉纯注释行与空行、并把新加的 `export ` 关键字归一化后逐行 diff**：

```
IDENTICAL_AFTER_COMMENT_STRIP= true
DIFF_EMPTY=yes
```

⇒ 搬迁是纯位移，代码本体一个 token 未改。

**改动面**（`git diff --numstat 8ae495f..HEAD`）：

```
57	0	.superpowers/sdd/2026-08-07-pkg2-data-loss/task-s4-report.md
156	0	src/controller/ownedRunStateWriter.ts
6	129	src/controller/runLoop.ts
100	0	tests/controller/ownedRunStateWriter.structure.test.ts
131	0	tests/controller/runLoop.integration.test.ts
```

⇒ `src/` 与 `tests/` 的改动面**严格等于本 brief 的两半**。未碰第 4 笔、未碰 A/B/C、未碰 spec、未碰包 1、
未碰 `progress.md`、未引入任何 devDependency（`package.json` 一行未动）。

---

## 2. 7 种绕过写法逐条对照表

新机制是**两段的**，必须一起看，否则会高估也会低估：

- **机制 A（编译器，已在 npm scripts 里）**：`runLoop.ts` 里出现裸的 `writeRunState` 标识符而无 import ⇒
  `tsc` 报 `TS2304: Cannot find name 'writeRunState'`。**实测过**（见下）。
- **机制 B（读源码的测试）**：只要把 import 加回来 ⇒ 结构测试红。**实测过**（含别名形态）。

| # | 绕过写法（再评审员原样） | 新机制 | 挡不挡 | 证据 |
|---|---|---|---|---|
| 1 | `void writeRunState(runDir, state)` | A＋B | **挡住** | **实跑**：无 import 时 `src/controller/runLoop.ts(1476,16): error TS2304: Cannot find name 'writeRunState'.` ／ `TSC_EXIT=2`（日志 `tsc-shape1.log`）。加回 import ⇒ 机制 B 红（见 #3 证据） |
| 2 | `return writeRunState(...)` | A＋B | **挡住** | 与 #1 **同一机制、同一标识符解析**；**未逐条单跑**，标注为「论证 ＋ #1 的实测同型」，不是独立实测 |
| 3 | 别名 import `writeRunState as w`，`await w(...)` | B | **挡住** | **实跑**：结构测试红在断言 —— `AssertionError: expected [ 'execFile', 'promisify', …(43) ] to not include 'writeRunState'`（日志 `struct-mutant.log`，`TEST_EXIT=1`）。这是本表里**最重要**的一条实测：它证明判定确实按 import 说明符而不是本地绑定名 |
| 4 | 双空格 `await  writeRunState(` | A＋B | **挡住** | 同 #2，**未逐条单跑** |
| 5 | `await` 后换行 | A＋B | **挡住** | 同 #2，**未逐条单跑** |
| 6 | `Promise.all([writeRunState(...)])` | A＋B | **挡住** | 同 #2，**未逐条单跑** |
| 7 | 直接 `writeFile(join(runDir,"loop-state.json"), …)` | — | *** **仍然敞开** *** | **实跑证敞开**：把 `#7` 写点换成动态 import 的裸 `writeFile`，**结构测试照样绿**（`struct-under-writefile-mutant.log`，`TEST_EXIT=0`）。控制器的预判成立 |

**控制器预判核对**：第 7 条「直接 `writeFile` 仍然敞开」—— **预判正确，我没挡住，如实写「仍然敞开」。**
唯一的缓和事实（不改变「敞开」这个结论）：在 `#7` 这个具体写点上，这次新增的行为回归测试**确实抓到了它**
（同一次变异让 `#7` 测试红在断言上）。但那是**一条测试盯住一个写点**，不是机制；
别的写点换成 `writeFile` 依然无人拦。

### 我另外发现的、不在那 7 条里的绕过形态（必须一起看，否则第 2 节会被读成「只剩一个洞」）

| # | 形态 | 现状 | 证据 |
|---|---|---|---|
| 8 | `import * as ns from "../persistence/fileStore.js"` ＋ `ns.writeRunState(...)` | **一开始敞开，现已挡住** | **两次实跑**：加这条断言前，该变异下结构测试**绿**（`struct-ns-mutant.log`，`TEST_EXIT=0`）；补上 namespace 断言后，同一变异**红在断言** —— `AssertionError: expected [ '../persistence/fileStore.js' ] to deeply equal []`（`struct-ns-mutant2.log`，`TEST_EXIT=1`） |
| 9 | 动态 `await import("../persistence/fileStore.js")` 后 `.writeRunState(...)` | *** **仍然敞开** *** | **论证，未单跑**：两条正则都只匹配静态 import 子句，动态 import 不是 import 子句。标注为**未验**，不要当已证实 |
| 10 | 让**第三个模块**去 import `writeRunState`，`runLoop.ts` 调那个模块 | *** **仍然敞开** *** | **论证，未单跑**：机制只约束 `runLoop.ts` 一个文件的 import 清单。标注为**未验** |

**一句话总的**：D-1 从「一个没有执行机制的完整性断言」变成
**「一个有两段执行机制、但覆盖面明确有边界的断言」**。
边界就是 #7 / #9 / #10：**任何不经 `writeRunState` 这个名字的写法都仍然敞开。**
彻底关掉它需要方案 (c)（类型级不变量），而 (c) 必然改 `tests/persistence/fileStore.test.ts` 的一大片既有直调，
**本轮无授权**（人裁 29 明确只放行 (a)）。**这一段限制我已经写进新模块的注释里，不只写在本报告里**
—— 因为只写在报告里，下一个读代码的人看不到，那正是 D-1 原本的病。

---

## 3. 具名勘误：`runLoop.ts:986-1008` 那两句

搬走之后失实的是这两句，**逐字引原文**（BASE `8ae495f` 的 `src/controller/runLoop.ts`）：

> (i)（:987-988）`…goes through here, and \`writeRunState\` is called from exactly one place in this module — the line below.`
>
> (ii)（:995-998）`The completeness argument is therefore no longer "I audited the call sites and they are covered"; it is "this module cannot write a run state except through this function", which is a property a reader can check with one grep instead of an audit that already went wrong once.`

**为什么失实**：两句里的 "this module" 指的都是 `runLoop.ts`，而写入器已经不在 `runLoop.ts` 里了。
留在原位就是两句错话。

**改成了什么**（现落在 `src/controller/ownedRunStateWriter.ts` 的注释块里，标题逐字是
`*** ERRATUM, task S4 (package 2, debt D-1) — this paragraph is a NAMED rewrite, not a silent edit.`）：

> (i') `writeRunState` is called from exactly one place in THIS module — the line at the bottom of the
> returned closure — and runLoop.ts does not import `writeRunState` at all.
>
> (ii') The completeness argument is no longer "I audited the call sites and they are covered", and no
> longer "a reader can check it with one grep" either. That grep was the weak part: a scoped
> re-reviewer defeated the acceptance probe … in 7 of 7 attempts …. The argument is now "runLoop.ts
> cannot call writeRunState without first importing it, and a test reads runLoop.ts's source and fails
> if that import specifier reappears" (tests/controller/ownedRunStateWriter.structure.test.ts). That is
> an enforced check, not an assertion of completeness with nothing behind it.

**并且在同一段里逐字写下了限制**（`HONEST LIMIT, stated here rather than in the report only`）：
直接 `writeFile(join(runDir, "loop-state.json"), …)` **STILL OPEN**，关掉它需要方案 (c)，本轮未获授权。

**另一处我自己改的、也一并具名**：`runLoop.ts` 里 `persistTerminalState` 上方原写
`the guard has moved to createOwnedRunStateWriter above`。搬走后 "above" 失实，改为
`…has moved to createOwnedRunStateWriter, which task S4 in turn moved out of this module into ./ownedRunStateWriter.ts`。
**这是我这次改的第二句承重描述，同样不静默。**

---

## 4. `#7` 新判据的三步变异证据

**变异选型的理由**：我特意选了一个**只有 `#7` 这个写点才会被打中**的变异 ——
把 `:1599` 那行 `await writeOwnedRunState(runDir, state)` 换成**绕过守卫的直接 `writeFile`**
（正是第 2 节第 7 条那个仍然敞开的形状）。
用「把守卫整体关掉」当变异是不够的：那种变异连既有的 F-1 测试也会打中，证明不了 `#7` 这一格被单独钉住。

**测试名**：`runLoop > refuses to write the terminal failed status of a retry-cleanup failure into a run a different owner holds`

**步骤 1 —— 注入前绿**（日志 `n1-baseline.log`）

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
 ✓ tests/controller/runLoop.integration.test.ts (59 tests | 58 skipped) 430ms
   ✓ runLoop > refuses to write the terminal failed status of a retry-cleanup failure into a run a different owner holds 429ms
 Test Files  1 passed | 30 skipped (31)
      Tests  1 passed | 519 skipped (520)
TEST_EXIT=0
```

`1 passed | 519 skipped` = **非零计数**，选择器确实命中，不是 `0 matched` 的空跑。

**步骤 2 —— 注入后红**（日志 `n1-mutant.log`）

```
 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > refuses to write the terminal failed status of a retry-cleanup failure into a run a different owner holds
AssertionError: expected 'failed' to be 'planning' // Object.is equality

Expected: "planning"
Received: "failed"

 ❯ tests/controller/runLoop.integration.test.ts:1557:32
    1556|       const persisted = await readRunState(runDir);
    1557|       expect(persisted.status).toBe("planning");
       |                                ^
 Test Files  1 failed | 30 skipped (31)
      Tests  1 failed | 519 skipped (520)
TEST_EXIT=1
```

*** **靠哪一条断言变红：`expect(persisted.status).toBe("planning")`，一条 `AssertionError`。** ***
**不是异常、不是超时、不是 `Promise.all` 抛 ENOENT** —— vitest 明写 `AssertionError` 与
`Expected: "planning" / Received: "failed"`，耗时 308ms（超时阈值 5000ms，差一个数量级）。
被打中的正是「盘上 `loop-state.json` 被改写成 `failed`」这个数据丢失本体。
另有两条独立断言会在同一变异下同时红（字节比对 `toBe(persistedStateBefore)`、
以及喂给生产闸门 `evaluateResumeEligibility` 的那对断言），vitest 只报第一条。

**步骤 3 —— 还原后绿**（日志 `n1-restored.log`）

```
RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
✓ runLoop > refuses to write the terminal failed status of a retry-cleanup failure into a run a different owner holds 316ms
Test Files  1 passed | 30 skipped (31)
     Tests  1 passed | 519 skipped (520)
TEST_EXIT=0
```

**还原证明三件**：
1. `git diff` 原始输出**为空**（还原后即提交 `7c156f1`，此后每轮变异结束都现跑 `git diff -- src/` 与
   `git status --porcelain`，均为空）；
2. 变异标记 `MUTANT-S4-7` ／ `MUTANT_S4_D1` ／ `MUTANT_NS` 在 `src/` 下计数 **0**；
3. sanity 必命中探针：`grep -c 'createOwnedRunStateWriter' src/controller/runLoop.ts` = **4**、
   `grep -c 'writeOwnedRunState' src/controller/runLoop.ts` = **26**（探针是活的）。

**这条测试为什么打得中 `#7` 而不是别的写点**：它把 `cleanupAttemptWorkspace` mock 成抛错
（沿用本文件既有的 `vi.doMock` 写法），且 verification 判 `safeToRetry` 的 reject ⇒ 决策为 `retryable` ⇒
控制流**只能**从 retryable 分支内的 `try/catch` 进到 `:1599`。它**不是**外层 catch 的失败分支
（那条已由既有的 F-1 测试覆盖）。

---

## 5. 读源码那条测试的非空转证明

**测试名**：`runLoop.ts run-state write chokepoint > does not import writeRunState, so no rewrite of a call site inside runLoop.ts can reach it`

**变异 = 把 `writeRunState` 的 import 加回 `runLoop.ts`。** 我特意用**别名**形态
（`writeRunState as MUTANT_S4_D1`），因为那是 7 种绕过里唯一能骗过「按本地绑定名判定」的实现的形态 ——
用裸 import 变异会让这条测试看起来比实际更强。

**注入后红**（日志 `struct-mutant.log`）

```
 FAIL  tests/controller/ownedRunStateWriter.structure.test.ts > runLoop.ts run-state write chokepoint > does not import writeRunState, …
AssertionError: expected [ 'execFile', 'promisify', …(43) ] to not include 'writeRunState'
 ❯ tests/controller/ownedRunStateWriter.structure.test.ts:74:26
    74|     expect(imported).not.toContain("writeRunState");
 Test Files  1 failed | 30 skipped (31)
      Tests  1 failed | 519 skipped (520)
TEST_EXIT=1
```

**红在断言上**（`AssertionError`，第 74 行的 `expect(imported).not.toContain("writeRunState")`），
不是异常、不是超时（耗时 5ms）。
**还原后绿**（`struct-restored.log`）：`✓ … (1 test) 3ms` ／ `Test Files 1 passed | 30 skipped (31)` ／
`Tests 1 passed | 519 skipped (520)` ／ `TEST_EXIT=0`，FAIL 计数 0（探针：必命中 `RUN  v2` = 1、
必零命中 `zzq-nonsense` = 0），`git diff` 为空。

**这条测试自带反空转装置**（因为「一条坏探针永远不能证明不存在」这条纪律，我把它写进了测试本身）：

```ts
expect(imported).toContain("appendEvent");                       // 必命中：正则若失效，这条先红
expect(imported).not.toContain("thisNameIsNotImportedAnywhere"); // 必零命中
expect(namespaceImportedModules('import * as anything from "some/module.js";')).toEqual(["some/module.js"]);
```

第三条尤其必要：`runLoop.ts` 里**没有**任何合法的 namespace import 可以当锚点，
没有它的话「一个已经不匹配任何东西的正则」和「一个真的没有 namespace import 的模块」长得一模一样。

**namespace 那条断言的三步变异**（第 8 节所述我自己发现的缺陷的修复证据）：
注入前绿（`struct-ns-green.log`，`1 passed | 519 skipped`，`TEST_EXIT=0`）／
注入后红（`struct-ns-mutant2.log`，`AssertionError: expected [ '../persistence/fileStore.js' ] to deeply equal []`，
第 98 行，13ms，`TEST_EXIT=1`）／还原后 `git diff -- src/` 为空、`MUTANT_NS` 计数 0。

---

## 6. 全套件 ＋ tsc ＋ build 的未过滤结果

三条跑法全部：**先落盘脚本，再 `rtk proxy zsh <script>` 跑，全文 tee，不 `grep`、不 `tail`**。
脚本在 scratchpad：`run-full.sh`（全套件＋tsc＋build）、`run-named.sh`（单跑块）。

**终态树（HEAD `826593a` 的 `src/`＋`tests/`）的全套件尾部逐字**（`full2-test.log`）：

```
 Test Files  31 passed (31)
      Tests  520 passed (520)
   Start at  00:08:28
   Duration  16.84s (transform 2.44s, setup 0ms, collect 3.92s, tests 57.87s, environment 4ms, prepare 1.83s)

TEST_EXIT=0
```

**`RUN` 首行已核**：`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4` ⇒ **本 worktree，不是仓库根**。
**`^ FAIL ` 全量计数 = 0**，检索面已验活（必命中 `RUN  v2` = 1、必零命中 `zzq-nonsense` = 0）。

```
TSC_EXIT=0
```

```
> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "…"

BUILD_EXIT=0
```

另有一份更早的同样三件（`full1-*.log`），跑在**与 `7c156f1` 逐字相同的树**上，结论一致
（`31 passed (31)` ／ `520 passed (520)` ／ `TEST_EXIT=0` ／ `TSC_EXIT=0` ／ `BUILD_EXIT=0`）。

**关于允许名单**：本轮 flake (B)、(F) 与人裁 10 那条**都通过了**。
按人裁 10 的口径，我**不挥手放过**：这只说明「本轮未复现」，**不是它们无害的证据，根因仍然是空的**。

---

## 7. 预算

*** **拿不到精确数字，不给估计。** ***
我在 subagent 上下文里读不到 harness 的实测 token 计数，本仓库已明令不收自报估计当结论
（上一轮自报「约 100k 的 60–80%」，实测 195,610，低估 2.5–3.3 倍）。
**请控制器按人裁 28 后确立的纪律，从 harness 侧读本任务的实测用量入账。**

可以给的**非 token 客观量**（这些我确实测到了）：全套件跑 **2 次**（各约 17 s wall），
单跑块 **7 次**，`tsc` 跑 **4 次**，`npm run build` **2 次**，注入并还原的变异 **4 个**
（`#7` 直写 `writeFile` ／ 别名 import ／ namespace import ×2 ／ 无 import 的裸 `void` 调用）。

**人裁 30 已预先放行 S4 预算**，故我未为超预算停下请示；**记账未停**，即本节。

---

## 8. 我自己发现的、我自己的缺陷

**缺陷 1（已修，属于我这次交付物本身的漏洞）**：
结构测试第一版**只查具名 import**，于是
`import * as ns from "../persistence/fileStore.js"` ＋ `ns.writeRunState(...)` **可以整条走过去**。
我是在给第 2 节做「仍然敞开」实证时自己撞出来的：那次变异下结构测试**绿**（`struct-ns-mutant.log`）。
**修法**：补 `namespaceImportedModules()` ＋ 一条独立断言 ＋ 一条自带锚点的反空转探针，
并给它跑了完整三步变异（第 5 节末）。提交在 `826593a`，与主提交分开，便于评审员单独核。
**如果我当时按第一版直接交，第 2 节就会写成「只剩 writeFile 一个洞」，那是失实的。**

**缺陷 2（我违反了本仓库的验证纪律一次，已补救，不掩饰）**：
跑 `struct-under-writefile-mutant.log` 那次，我在展示时用了 `| tail -20` ——
**这与 `grep` 同罪，是本仓库明令禁止的「过滤验证输出」**。
被截掉的正是 `RUN` 首行。**补救**：完整日志已 tee 落盘，随后单独取回并核了 `RUN` 首行确为本 worktree；
此后每一次对日志的检索都带**必命中＋必零命中**双探针。
**这是本仓库第五次栽在同一形状上（前四次已入台账），我是第五次。**

**缺陷 3（口径，主动交代）**：
`tsc` 我有两次是**裸跑 `npx tsc --noEmit`**（不经 `rtk proxy`）：
一次是搬迁后的即时自查，一次是第 2 节 #1 那条 `TS2304` 实测。
起因是 `rtk proxy npx tsc --noEmit | cat` 把退出码吞掉了（`TSC_EXIT=` 空）。
**收口用的那两次 `tsc`（`full1-tsc.log` / `full2-tsc.log`）都在 `rtk proxy zsh <script>` 里跑，合规**；
裸跑的两次只用于中间探查，**其结论已被合规的那两次覆盖**。仍如实记下。

**缺陷 4（范围，主动交代）**：
我改了 `runLoop.ts` 里 `persistTerminalState` 上方一句注释（"…moved to createOwnedRunStateWriter above"）。
严格说这超出「只搬必需的最小集合」半步。**理由**：那句是被我这次搬迁**直接改成失实**的描述，
按本仓库对「静默留下失实论证」的零容忍，不改比改更糟。**已在第 3 节具名。**

---

## 9. 与 brief／派单的分歧、未验事项

**与 brief 的分歧：无。** brief 与 `progress.md` §16 我都读了，二者一致，未发现冲突。
派单与 brief 亦一致（派单说 option (a)、brief 说人裁 29 走 (a)）。

**明确标注「未验」的事项**（宁可标未验，也不写成已证实）：

1. 第 2 节 **#2 / #4 / #5 / #6 四种写法未逐条单跑**。它们与 #1 共用同一条标识符解析机制，
   #1 已实测（`TS2304`），但**我没有为这四条各跑一次**。若评审员要逐条实证，这四条是缺口。
2. 第 2 节 **#9（动态 `import()`）与 #10（借道第三个模块）仅有论证，未单跑**。
   我判断它们**仍然敞开**，但这是读正则得出的，不是跑出来的。
3. `progress.md` §13 那条反向事实（`ensureFreshRunDir` 的 `blockingPaths` 不含 `.owner-transfer.lock`）
   我**未复核** —— 与 S4 两半无关，且 brief 未要求，故未花预算。
4. 我**没有**复核远端 `origin/main` 的位置，也**未 push、未合并、未删除任何分支或 worktree**。
5. 本报告不构成收口。**独立评审员请直接重跑第 4、5 节的三步变异** ——
   脚本与全部日志都在 scratchpad
   `/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/2260b5ef-b9b1-4d2c-82d3-115c0f027dc9/scratchpad/`
   （`run-full.sh` / `run-named.sh` / `full1-*.log` / `full2-*.log` / `n1-*.log` / `struct-*.log` / `tsc-shape1.log`）。
   ⚠️ scratchpad 是会话级目录，**评审员不要依赖它还在，请以现跑为准**。

---
---

# 修复环 1 报告（fix round 1 of 5）

FIX_BASE `f49f4b9` → HEAD `66e9696`（1 笔提交）。评审裁定 Spec ✅ / Quality NOT APPROVED，
0 Critical、**1 Important**、4 Minor。**只做 Important-1，4 条 Minor 按令不动。**

## F1. 结论

**Important-1 成立，我不争辩。** 评审员的根因诊断是对的：`importedNames` 与 `namespaceImportedModules`
都写成 `/import\s+…/`，而 JS/TS 里 `import` 后面、`{` 或 `*` 前面的空白是**可选的**，
于是 `import{writeRunState as W}from"…"` 与 `import*as ns from "…"` **对两条正则完全不可见** ——
不是匹配错，是根本没看见。后果正如他所说：**`TSC_EXIT=0` 且结构测试保持绿，而守卫已被绕过**。

**这使我写进 `ownedRunStateWriter.ts` 源码的那句「a test reads runLoop.ts's source and fails if that
import specifier reappears」成为一句失实的断言。** 那正是 F-1 的形状 ——
**把一条没有执行力的完整性主张当成有执行力的写进源码** —— 只不过上升了一层。
这是我这次交付物里最严重的一处，评审员定为 Important 而不是 Minor 是恰当的。

**我选的修法：修机制，不弱化句子。** 评审员给了两条路（改口径 / 换真解析），
并明确指出 `typescript` 已经是 devDependency，`ts.createSourceFile` 不引入任何工具链。
我走后者，理由是本仓库对 D-1 定的标准就是**对排版不敏感**（旧探针正是被一个双空格打败的）；
只改口径等于把同一个弱点从调用点搬到 import 语句再承认一次，**没有清掉那道杠**。

**改了三处，全部具名**：

1. `tests/controller/ownedRunStateWriter.structure.test.ts` —— 两条正则**整体退役**，
   改为 `ts.createSourceFile(...)` 解析后遍历 `ImportDeclaration` 节点：
   具名 import 取 `(element.propertyName ?? element.name).text`（**即导出方拼写的名字，不是本地绑定名**，
   别名因此仍被抓住）；namespace import 取 `moduleSpecifier.text`。
   **无新依赖**：`package.json` 一行未动，devDependencies 仍是 `@types/node` / `tsx` / `typescript` / `vitest` 四项；
   `tsconfig.json` 的 `include` 本来就含 `tests/**/*.ts`，所以 `tsc` 与 `npm run build` 都已覆盖这个文件。
2. `src/controller/ownedRunStateWriter.ts` 的 (ii') 句改为
   「…cannot call writeRunState without first naming it in a **static import declaration**, and a test
   **PARSES** runLoop.ts and fails if that import specifier reappears **in any spelling**」。
3. 同处新增 *** `SECOND ERRATUM, S4 fix round 1` ***：**逐字保留那句失实的旧措辞**，写明它为什么假、
   谁量到的、修法是什么。**不静默覆盖自己曾经下过的论断** —— 这是本仓库的既有纪律，
   我上一轮对别人的论断守住了，这一轮对自己的也要守。

**没做的事**：4 条 Minor 一律未修；`package.json` 未动；option (c) 未碰；
既有判据零改动（`git diff --numstat 8ae495f..HEAD` 下 `tests/` 两项仍是 `125 0` 与 `131 0`，**零删除行**）。

## F2. 三步变异证据（修好的机制）

驱动脚本落盘后经 `rtk proxy zsh` 跑：`fix1-drive.sh` ＋ `fix1-mutate.mjs`（不嵌套引号）。
每个 case 都从**同一份 pristine 备份**重铺 `runLoop.ts`，跑完立刻还原，并当场记 `git diff` 字节数。
单跑块用**文件选择器**而不是 `-t`，所以计数是 `Test Files 1 passed (1) / Tests 1 passed (1)` —— **非零**。

### 步骤 1 —— 变异前绿

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
 ✓ tests/controller/ownedRunStateWriter.structure.test.ts (1 test) 38ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
STRUCT_EXIT=0
```
```
TSC_EXIT=0
```

### 步骤 2 —— 变异后红（**两条必需 case 逐字**）

**case `D_nospace_full`（Important-1 场景 A，无空格具名 import）**
注入 `import{writeRunState as MUT_W}from"../persistence/fileStore.js";` ＋ 把 `#7` 写点改成 `await MUT_W(runDir, state);`

```
TSC_EXIT=0
```
```
 FAIL  tests/controller/ownedRunStateWriter.structure.test.ts > runLoop.ts run-state write chokepoint > does not import writeRunState, so no rewrite of a call site inside runLoop.ts can reach it
AssertionError: expected [ 'execFile', 'promisify', …(43) ] to not include 'writeRunState'
 ❯ tests/controller/ownedRunStateWriter.structure.test.ts:113:26
    113|     expect(imported).not.toContain("writeRunState");
       |                          ^
 Test Files  1 failed (1)
      Tests  1 failed (1)
STRUCT_EXIT=1
```

*** 红在断言 `expect(imported).not.toContain("writeRunState")`，类型 `AssertionError`，耗时 28ms（超时阈值 5000ms）。
不是异常、不是超时。 *** 注意 `TSC_EXIT=0` —— 编译器这一关照样放行，**所以红的确实是新机制，不是 tsc**。

**case `D_ns_nospace`（Important-1 场景 B，无空格 namespace import）**
注入 `import*as MUT_NS from "../persistence/fileStore.js";` ＋ `await MUT_NS.writeRunState(runDir, state);`

```
TSC_EXIT=0
```
```
 FAIL  tests/controller/ownedRunStateWriter.structure.test.ts > runLoop.ts run-state write chokepoint > does not import writeRunState, …
AssertionError: expected [ '../persistence/fileStore.js' ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   "../persistence/fileStore.js",
+ ]

 ❯ tests/controller/ownedRunStateWriter.structure.test.ts:123:95
    123|     expect(namespaceImportedModules(source).filter((module) => module.…
 Test Files  1 failed (1)
      Tests  1 failed (1)
STRUCT_EXIT=1
```

*** 红在断言 `expect(namespaceImportedModules(source).filter(…)).toEqual([])`，`AssertionError`，38ms。 ***

**三条对照 case（证明修复没有把原来挡得住的放过去，也顺带量了 Minor-1 的形状）**

| case | 注入 | 结果 |
|---|---|---|
| `B_alias` | `import { writeRunState as MUT_W } from "…"`（有空格） | **红**，`AssertionError: expected [ …(43) ] to not include 'writeRunState'`，`:113`，30ms，`STRUCT_EXIT=1` |
| `B_namespace` | `import * as MUT_NS from "…"`（有空格） | **红**，`AssertionError: expected [ '../persistence/fileStore.js' ] to deeply equal []`，`:123`，46ms，`STRUCT_EXIT=1` |
| `B_nospacefrom` | `… } from"…"`（Minor-1 的形状） | **红**，`AssertionError: … …(43) … to not include 'writeRunState'`，`:113`，30ms，`STRUCT_EXIT=1` |

### 步骤 3 —— 还原后绿

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
 ✓ tests/controller/ownedRunStateWriter.structure.test.ts (1 test) 44ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
STRUCT_EXIT=0
```
```
TSC_EXIT=0
```

**还原证明**（每个 case 结束当场记一次 ＋ 全部跑完再记一次）：

```
GITDIFF_RAW_BYTES[D_nospace_full]=0
GITDIFF_RAW_BYTES[D_ns_nospace]=0
GITDIFF_RAW_BYTES[B_alias]=0
GITDIFF_RAW_BYTES[B_namespace]=0
GITDIFF_RAW_BYTES[B_nospacefrom]=0

GIT_DIFF_RAW_BYTES[src/controller/runLoop.ts]=0
GIT_DIFF_RAW_BYTES[runLoop.ts + runLoop.integration.test.ts]=0
MARKER[MUT_W]=0  MARKER[MUT_NS]=0  MARKER[MUTANT_S4]=0  MARKER[MUTANT_NS]=0
SANITY_HIT[createOwnedRunStateWriter]=2 个文件   SANITY_HIT[ts.createSourceFile]=1 个文件
SANITY_MISS[zzq-nonsense-token]=0
```

⚠️ **一处口径必须写明**：`git diff` 经 Claude Code 的 rtk 钩子改写时**会吞掉原始输出**
（空 diff 也打印 1 字节）。上表的 0 字节是用 **`rtk proxy git diff`（绕开改写）** 现测的。
**下一位核这条时请照样走 `rtk proxy`，不要用被改写的 `git diff`。**

## F3. 覆盖测试 ＋ tsc ＋ build（未过滤）

命令（脚本落盘 `fix1-verify.sh`，经 `rtk proxy zsh` 跑，环境 `ECC_GATEGUARD=off DISABLE_OMC=1`）：

- `npx vitest --run tests/controller/ownedRunStateWriter.structure.test.ts tests/controller/runLoop.integration.test.ts`
- `npx vitest --run`
- `npx tsc --noEmit -p tsconfig.json`
- `npm run build`

**两个具名文件**：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4
 ✓ tests/controller/ownedRunStateWriter.structure.test.ts (1 test) 38ms
 ✓ tests/controller/runLoop.integration.test.ts (59 tests) 10454ms
 Test Files  2 passed (2)
      Tests  60 passed (60)
COVERING_EXIT=0
```

**全套件**（`fix1-full-test.log`，全文已读，`RUN` 首行已核为本 worktree）：

```
 Test Files  31 passed (31)
      Tests  520 passed (520)
   Duration  17.69s
TEST_EXIT=0
```

**全日志零 `FAIL` 行。** 允许名单里的 flake (B)、(F) 与人裁 10 那条本轮**又都通过** ——
按既有口径只记「本轮未复现」，**不作为它们无害的证据**。

```
TSC_EXIT=0
BUILD_EXIT=0
```

## F4. 更新后的形状表（11 条全列，含评审员补的 5 条）

「修复后」一列区分三种来源：**本轮实跑**、**评审员实跑且本次修复不触及**、**仍然敞开**。
**没有一格因为这次修复而变得更乐观地表述。**

| # | 形状 | 修复前（评审员实测） | **修复后** | 依据 |
|---|---|---|---|---|
| 1 | `void writeRunState(…)`，无 import | 挡住（`TS2304`） | **挡住** | 机制 A（tsc）。本次未改动 tsc 这一段，评审员实测在案，**本轮未复跑** |
| 2 | `return writeRunState(…)`，无 import | 挡住（`TS2304`） | **挡住** | 同上，**本轮未复跑** |
| 3 | 别名 import（有空格）＋ 别名调用 | 挡住 | **仍挡住** | **本轮实跑** `B_alias`：红在 `:113`，`STRUCT_EXIT=1` |
| 4 | `await  writeRunState(` 双空格，无 import | 挡住（`TS2304`） | **挡住** | 机制 A，**本轮未复跑** |
| 5 | `await` 换行，无 import | 挡住（`TS2304`） | **挡住** | 机制 A，**本轮未复跑** |
| 6 | `Promise.all([writeRunState(…)])`，无 import | 挡住（`TS2304`） | **挡住** | 机制 A，**本轮未复跑** |
| 7 | 直接 `writeFile(join(runDir,"loop-state.json"),…)` | **仍然敞开** | *** **仍然敞开** *** | 本次修复只换了解析方式，管不到「不提这个名字」的写法。**本轮未复跑**，结论沿用我与评审员各自的实测 |
| 8 | `import * as ns …`（**有空格**）＋ `ns.writeRunState(…)` | 挡住 | **仍挡住** | **本轮实跑** `B_namespace`：红在 `:123`，`STRUCT_EXIT=1` |
| 8b | `import*as ns …`（**无空格**） | *** 敞开 *** | *** **已挡住** *** | **本轮实跑** `D_ns_nospace`：`TSC_EXIT=0` 但 `STRUCT_EXIT=1`，红在 `:123` |
| 9 | 动态 `await import("…/fileStore.js")` | **仍然敞开** | *** **仍然敞开** *** | 解析只访问 `ImportDeclaration` 节点，动态 import 是 `CallExpression`，**根本不在遍历面上**。**本轮未复跑** |
| 10 | 第三个模块 import 它，`runLoop.ts` 调那个模块 | **仍然敞开** | *** **仍然敞开** *** | 机制只读一个文件的 import 清单。**本轮未复跑** |
| 11 | `import{writeRunState as W}from"…"`（无空格） | *** 敞开 *** | *** **已挡住** *** | **本轮实跑** `D_nospace_full`：`TSC_EXIT=0` 但 `STRUCT_EXIT=1`，红在 `:113` |
| — | `… } from"…"`（Minor-1 的形状） | 挡住，但**靠运气**（名单被吃成 42） | **挡住，且名单正确** | **本轮实跑** `B_nospacefrom`：红在 `:113`，操作数 `…(43)`，与其它红 case 一致 |

**边界的准确表述（修复后）**：机制现在覆盖 **`runLoop.ts` 里任何拼法的静态 import 声明**。
仍然敞开的是 **#7 / #9 / #10** —— 共同点是**都不通过 `runLoop.ts` 的静态 import 清单**。
评审员原话「boundary is wider than the report states」，那句**当时是对的**；
本轮把「排版」这条从边界里去掉了，**但 #7/#9/#10 三条一个都没关掉，仍按敞开记。**
唯一的对冲仍是评审员量到的那条：这四种结构性敞开的形状，在 `#7` 那一个写点上都会被新增的行为回归测试
红在 `expect(persisted.status).toBe("planning")` 上；**其余八个写点没有这样的测试。**

## F5. 勘误句现在是否为真

**(ii') 现在为真** —— 但只在它自己写明的范围内为真，这一点已写进句子本身：
它现在说的是「without first naming it in a **static import declaration**」＋「a test **PARSES** runLoop.ts
and fails if that import specifier reappears **in any spelling**」。
`in any spelling` 由本轮 5 个 case 实测支撑（无空格具名／无空格 namespace／有空格别名／有空格 namespace／`from"…"`），
`static import declaration` 这个限定词把 #9（动态 import）明确排除在承诺之外。

同一注释块里另有两段承重文字，请评审员一并核：
- *** `SECOND ERRATUM, S4 fix round 1` ***：逐字保留失实旧措辞 ＋ 说明为何假、修法为何。
- `HONEST LIMIT`：由原来只点名 `writeFile` 一条，**扩写为三条**（`writeFile` ／ 动态 `import()` ／ 第三个模块），
  与 F4 表严格一致。

## F6. 我的修复顺带 moot 掉了哪些 Minor（按令说明，未去修它们）

| Minor | 是否被 moot | 依据 |
|---|---|---|
| **Minor-1**（惰性正则吃掉相邻 import，名单被吃成 42） | *** **已 moot** *** | 正则整体退役。本轮 `B_nospacefrom` 实测操作数为 `…(43)`，与其它红 case 一致（评审员当时量到 42）。**我没有单独去"修" Minor-1，它是随正则一起消失的** |
| **Minor-3**（namespace 检查按路径子串 `fileStore` 划定范围） | **未 moot** | 解析器给的是精确的 module specifier，但**筛选口径仍是子串**，barrel 重导出仍不覆盖。⚠️ **我在测试注释里补了一句写明这个已知限制**（因为旧注释读起来像「namespace 这条已彻底关死」，而那句现在会被人当承诺）。**这是补口径，不是修 Minor-3；如果控制器认为连这句都超范围，删掉即可，不影响任何断言。** |
| **Minor-2**（反空转锚点用 `appendEvent` 这个外来符号） | **未 moot，也未动** | 锚点原样保留 |
| **Minor-4**（勘误随代码搬走，原址只剩指针） | **未 moot，也未动** | 属控制器裁量 |

## F7. 预算

*** **读不到 harness 实测数字，因此不给数字，也不给估计。** *** 请控制器从 harness 侧入账。
本轮可测的非 token 量：单跑块 **8 次**（1 绿基线 ＋ 5 变异 ＋ 1 还原 ＋ 1 双文件覆盖跑）、
全套件 **1 次**、`tsc` **8 次**、`npm run build` **1 次**、注入并还原的变异 **5 个**。

## F8. 我自己发现的、必须上报的两件

1. *** **`progress.md` 在我的工作区里处于已修改状态（`M`，+90 −1 行），不是我改的。** ***
   我全程未碰它（brief §2.8 明令台账由控制器写）。我**未 stage、未提交、未还原**它，原样留在工作区。
   **提交时只 `git add` 了我自己的两个文件**，`git status` 现仍显示它是 modified。
   若这不是控制器有意为之，请立刻查。
2. **本轮我没有再犯上一轮那次过滤验证输出的错**：所有验证跑全文 tee 并 `cat` 全量，
   未对任何验证输出用 `grep` / `tail` / `head`；对日志的取值一律读全文。
   （上一轮 §8 缺陷 2 已挂账，不重复。）

## F9. 与评审意见的分歧

**无分歧。** Important-1 的诊断、复现步骤、严重度定级我全部接受，且自己重新撞了一遍。
评审员在 §8 建议的「更好的做法：用 `ts.createSourceFile` 一次退掉 Important-1 / Minor-1 / Minor-3」，
我采纳了前两条；**Minor-3 并没有被退掉**（筛选口径仍是子串），这一点我在 F6 里如实纠正了他的预期，
**没有顺着他的措辞把范围说大。**
