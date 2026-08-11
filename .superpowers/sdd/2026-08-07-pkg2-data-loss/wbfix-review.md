# 包 2 修复环 —— 独立评审报告

> 评审员：独立评审员（换人，未参与本轮实施）。工作区 `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix`，分支 `feat/pkg2-wb-fixes`。
> 本报告中每一条承重结论都以**我自己跑出的输出**为准；实施者报告只当线索。

## 0. 结论（最先填：每项 ADDRESSED / NOT ADDRESSED / 越界，以及有无新破坏）

| 项 | 我的裁断 | 我自己的实测依据（不引用实施者） |
|---|---|---|
| 2.1(a) 人裁 13 源码锚点 | **ADDRESSED** | 锚点在 `runLoop.integration.test.ts` 的 `abandons the loser's reconciliation write against the winner's held transfer lock…` 上方；人裁 13 在 `progress.md` 确实存在；「全仓 `ruling 13` 零命中而 14/17/37 命中」这个前提我自己重跑，**成立**（见 §4） |
| 2.1(b) HONEST LIMIT 第 4 条路径 | **ADDRESSED** | 三条子断言逐条对代码核过，全部为真；其中一条全称否定我加了必命中 sanity 探针（见 §4） |
| 2.1(c) 两处勘误 | **ADDRESSED**（含 1 条 Low 精确性 finding） | 两句原文**逐字保留、零删除**（diff 在这两处只有 `+` 行）；勘误里每条事实陈述都对代码/台账核过 |
| 2.2 D2 reconciliation 重试判据 | **ADDRESSED** | `ATTEMPTS 3→1` ⇒ 2 条**各自变红，全部 `AssertionError`**；还原 ⇒ 79/79 绿（§2.1） |
| 2.3(a) 三终态所有权拒写判据 | **ADDRESSED** | 守卫对三终态放行 ⇒ 3 条**各自变红，全部 `AssertionError`**；`failed`/`cancelled` 两条**保持绿**；反向必命中对照打红 5 条既有（§2.2） |
| 2.3(b) 常数绝对值断言 | **ADDRESSED**（含 1 条 Low finding） | `3→2` 与 `50→70` **各自变红，全部 `AssertionError`**；两条自指断言 `toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS)` **一条都没被删改**（§2.3） |
| 2.4 resume 读顺序 | **BLOCKED —— 停得对**（含 1 条 Important finding，在**报告措辞**上） | 三项独立核验全部亲跑：18 行/gap 编号**完全对**；判据在未修代码上**红在断言**；理由①注释**逐字属实**、理由② S-3 原文**找到并逐字引**（§5） |
| 越界（人裁 48 之外） | **有 4 处触及既有行，其中 1 处（`vi.mock` 工厂）不在人裁 48 点名范围内** | 见 §3，两种口径**分别裁**，我不替人消解 |
| 有无新破坏 | **无** | 分支尖端我自己跑：`31 files / 529 tests / 0 failed`，`TEST_EXIT=0` `TYPECHECK_EXIT=0` `BUILD_EXIT=0`；基线我自己跑：`31 files / 524 tests / 0 failed`。**529 − 524 = 5，与新增 5 条 `it` 精确对上，没有任何既有测试被删** |

**Findings 计数：Critical 0 ／ Important 2 ／ Low 4。** 逐条见 §6，**finding 与处置建议分开写**，每条都明说是否应在本轮修。

**Rule 12 明说**：
- 本轮**没有出现任何 brief §5 之外的红**；brief 允许的 flake (B)/(F) 与三条挂账项在我两次全套件跑里**全绿**。
- 我做了 **8 次临时变异**，**每次都验了 `git diff` 与 `git diff --cached` 双 0 字节还原**（§7）。
- 我**没验到**的两件事列在 §8，不粉饰。

## 1. 我自己的基线与分支尖端验证（未过滤，RUN 路径已核）

环境：`export ECC_GATEGUARD=off DISABLE_OMC=1`；全部 `rtk proxy`；整份落盘、整份读回，**未做任何 grep/tail/sed 过滤**。
日志目录：`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/c74add88-b8d0-4cb8-8759-2160067337a8/scratchpad/`

**RUN 路径已核**（两次跑的日志第 6 行都是）：
`RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix` —— 是本工作区，**不是主仓库**。

### 1.1 分支尖端（`2993a76`，工作树 `git status --porcelain` 除本报告外干净）

`tip-test.log`（158 行，整份读回）：
```
 Test Files  31 passed (31)
      Tests  529 passed (529)
   Duration  20.53s
TEST_EXIT=0
```
`tip-typecheck.log`：`TYPECHECK_EXIT=0`；`tip-build.log`：`BUILD_EXIT=0`。
**零失败、零 skip**。brief §5 允许的 flake (B)（`records env names only and tracks descendants rooted at the spawned pid`, 3663ms）、
flake (F)、以及三条挂账项（`persists phase usage evidence…` 777ms、`waits for close before interrupting a close-pending successful execute` 450ms、
`finalize-review CLI > rejects unknown verdicts and diagnoses` 1832ms）**本次全部为绿**。

### 1.2 基线（六个被改文件 `git checkout dbac288 --`，其余不动）

`baseline-test.log`（157 行，整份读回）：
```
 Test Files  31 passed (31)
      Tests  524 passed (524)
TEST_EXIT=0
```
**逐文件差额（这是「没删任何既有测试」的硬证据，不是加减法推断）**：
- `tests/persistence/fileStore.test.ts`：基线 **77** → 尖端 **79**（+2 = 2.2 的两条）
- `tests/controller/runLoop.integration.test.ts`：基线 **61** → 尖端 **64**（+3 = 2.3(a) 的三条）
- 其余 29 个文件：**逐个文件计数一字不差**（`leaseLifecycle` 27→27、`resumeLoop.integration` 14→14 等）

⇒ 524 + 5 = 529，**且增量全部落在两个文件上，没有任何文件的计数下降**。

### 1.3 src/ 的非注释改动为空（我自己读完 58 行完整 src diff）

`git diff dbac288..HEAD -- src/` 共 58 行，落在两个文件：
- `src/controller/ownedRunStateWriter.ts`：`@@ -98,7 +98,25 @@`，1 行删除 + 19 行新增，**删除的那一行也是注释**（只是把块结束符 ` ***` 从该行末尾移到新段末尾，句子一字未改）
- `src/persistence/fileStore.ts`：`@@ -498,6 +498,22 @@`，**零删除**，16 行全部以 `//` 开头

⇒ **产品代码零行为改动，C-1 确实一行没修**（`acquireOwnerTransferLock` / `tryRecoverStaleOwnerTransferLock` 一字未动）。这条我是读完整份 diff 得出的，不是抽样。

## 2. 五项已完成项的逐项独立实测（变异红 / 还原绿，并判断"红在断言还是红在异常"）

> 判定口径：**红在断言** = vitest 报 `AssertionError` 并打印 Expected/Received；
> **红在异常/超时** = `Error: …` / `Test timed out in …ms`。本仓库明令禁止后者作为判据。
> 下面每一条都是我自己跑的，日志整份落盘。

### 2.1 D2 reconciliation 重试判据（brief §2.1）—— 红在断言 ✅

变异 **M1**：`src/persistence/fileStore.ts` 的 `RECONCILIATION_LOCK_RETRY_ATTEMPTS` `3 → 1`。
`m1.log`（49 行）：`Tests 2 failed | 77 passed (79)`，`M1_EXIT=1`，**两条全红且只有这两条红**：

| 测试（完整名） | 失败类型 | 失败文本 |
|---|---|---|
| `fileStore > retries a busy owner-transfer lock for the reconciliation publish and writes the record once it clears` | **`AssertionError`** | `expected [ 'reconciliation_write_abandoned' ] to not include 'reconciliation_write_abandoned'` |
| `fileStore > abandons the reconciliation publish once the reconciliation retry bound is exhausted, after exactly three lock attempts` | **`AssertionError`** | `expected 1 to be 3 // Object.is equality` |

*** **两条都红在断言，没有一条红在异常或超时。** ***
特别值得记一笔：第一条测试的作者把 `expect(...).not.toContain("reconciliation_write_abandoned")`
**故意放在任何文件读之前**，正是为了不让它红成 ENOENT —— 我实测证实这个设计**奏效了**（失败文本是断言，不是 ENOENT）。

还原 `1 → 3`：`git diff` / `git diff --cached` **双 0 字节**；`m1-restore.log`：`79 passed (79)`，`M1_RESTORE_EXIT=0`。

### 2.2 三种终态的所有权拒写判据（brief §2.2）—— 各自红在断言 ✅

变异 **M2a**：`src/controller/ownedRunStateWriter.ts` 把守卫改成
`if (ownership.kind === "foreign" && !["exhausted","blocked_waiting_human","succeeded"].includes(state.status))`，即对三终态放行。
`m2a.log`（76 行）：`Tests 3 failed | 61 passed (64)`，**恰好这三条红，一条不多**：

| 测试（完整名） | 失败类型 | 失败文本 |
|---|---|---|
| `runLoop > refuses to write a terminal succeeded status into a run a different owner holds` | **`AssertionError`** | `expected 'succeeded' to be 'planning'` |
| `runLoop > refuses to write a terminal exhausted status into a run a different owner holds` | **`AssertionError`** | `expected 'exhausted' to be 'planning'` |
| `runLoop > refuses to write a terminal blocked_waiting_human status into a run a different owner holds` | **`AssertionError`** | `expected 'blocked_waiting_human' to be 'planning'` |

*** **三条各自独立变红，全部 `AssertionError`。** ***
**既有的 `failed` / `cancelled` 两条在 M2a 下保持绿** —— `refuses to write a terminal failed status into a run a different owner holds when the attempt fails for a non-lease reason`
与 `refuses to write a terminal status into a run a different, current owner already holds when this process's own lease is lost, leaving that run resumable` 都不在失败列表里。✅

变异 **M2b（必命中反向对照，证明变异面是活的）**：同一处改成放行 `["failed","cancelled"]`。
`m2b.log`（132 行）：`Tests 5 failed | 59 passed (64)`，**5 条既有测试变红**，其中
`expected 'failed' to be 'planning'` ×2（断言）、`terminal_write_abandoned` 从事件序列里消失 ×3（断言，deep-equal 数组差异）。
⇒ **变异面确实是活的**；三条新判据不是靠一个死掉的探针"证明"出来的。
同时 M2b 下**三条新判据保持绿**（守卫对三终态仍然生效），说明两组判据互不串扰。

还原：`git diff` / `git diff --cached` **双 0 字节**。

### 2.3 两个重试常数的绝对值断言（brief §2.3）—— 红在断言 ✅

变异 **M3a**：`OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS` `3 → 2`。
`m3a.log`（63 行）：`Tests 2 failed | 39 passed (41)`，两条都是 **`AssertionError: expected 2 to be 3 // Object.is equality`**，
分别打在 `leaseLifecycle…:693` 与 `resumeLoop…:336` 的 `expect(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS).toBe(3)` 上。

变异 **M3b**：还原 ATTEMPTS，改 `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS` `50 → 70`。
`m3b.log`（63 行）：`Tests 2 failed | 39 passed (41)`，两条都是 **`AssertionError: expected 70 to be 50`**，
打在 `…:694` / `…:337` 的 `expect(OWNER_TRANSFER_LOCK_RETRY_DELAY_MS).toBe(50)` 上。

*** **两次变异都红在断言，没有异常也没有超时。** ***

变异 **M3c（我自己加的一步，用来独立验证「本轮之前没有任何东西钉住这个值」这个承重前提）**：
ATTEMPTS `3 → 2` 之后跑**全套件**。`m3c-full.log`（187 行）：
```
 Test Files  2 failed | 29 passed (31)
      Tests  2 failed | 527 passed (529)
M3C_EXIT=1
```
**全库 529 条里唯二变红的就是这两条新增断言。** ⇒ 实施者注释里那句「3→2 曾让整套件保持绿」，
在等价形式下**被我自己的实测证实**（尖端 = 基线 + 新增，所以尖端只红这两条 ⟺ 基线全绿）。

**两条既有自指断言逐字核对：一条都没被删改。**
- `tests/controller/leaseLifecycle.integration.test.ts`：`expect(writeCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS);` —— **在，原样**
- `tests/controller/resumeLoop.integration.test.ts`：`expect(claimCalls).toBe(OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS);` —— **在，原样**

两个文件的 diff 里**没有任何 `expect(` 行被删除**；唯一被改写的既有行是那条 `await import(...)` 解构语句（见 §3）。

还原：`git diff` / `git diff --cached` **双 0 字节**；`m3-restore.log`：`41 passed (41)`，`M3_RESTORE_EXIT=0`。

## 3. 越界核查：第五个具名例外之外有没有被动到（含 vi.mock 工厂那一处，两种口径分别裁）

### 3.0 人裁 48 的原文范围（我自己去读的，不听转述）

`wbfix-impl-brief.md` 第 82 行，逐字：

> *** **人裁 48 = 第五个具名例外。它只覆盖 2.3 这两项点名的改动，不得外推到任何其它既有判据。** ***

⇒ 授权的对象是「**既有判据**」。它点名的两项是 2.3(a)（三终态新判据）与 2.3(b)（两处常数断言）。

### 3.1 全分支上**触及既有行**的一共 4 处（我逐 hunk 数的，不是抽样）

| # | 位置 | 性质 | 是否在人裁 48 点名范围内 |
|---|---|---|---|
| 1 | `tests/persistence/fileStore.test.ts` 的 `vi.mock("node:fs/promises", …)` 工厂 | **既有共享夹具**，加了一个 `open` 透传条目 | **否** —— 它不是"判据"，人裁 48 一个字没提它 |
| 2 | `tests/controller/leaseLifecycle.integration.test.ts` 的 `await import("../../src/controller/runLoop.js")` 解构语句 | 既有语句被改写成 5 行，**只为多绑一个 `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS`** | **是**（2.3(b) 的机械前提：不绑就写不出那条断言） |
| 3 | `tests/controller/resumeLoop.integration.test.ts` 的同一形状语句 | 同上 | **是**（同理） |
| 4 | `src/controller/ownedRunStateWriter.ts` 一行既有注释 | 只把块结束符 ` ***` 从行尾移走，**句子一字未改** | 属 2.1(b)（纯注释项） |

**第 2/3 处我核过：改的是 import 绑定，不是断言。** 两个文件里没有任何 `expect(` 行被删除或改写。
**第 4 处我核过**：删除行与新增行只差末尾 ` ***`，正文逐字相同 —— 不构成"把原话改软"。

⇒ **真正需要人裁的只有第 1 处。**

### 3.2 第 1 处：`open` 透传 spy —— 它到底转发不转发、有没有行为改变

工厂现状（逐字）：
```ts
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => { renameSpy(...args); return actual.rename(...args); },
    open:   async (...args: Parameters<typeof actual.open>)   => { openSpy(...args);   return actual.open(...args); },
  };
});
```

**(a) 是否"全部转发"—— 是。** 无条件、无过滤、无分支：每一次调用都同参转发给 `actual.open`，
返回值原样返回，rejection 原样传播。`...actual` 保证其它导出不受影响。形状与既有的 `renameSpy` **完全同构**。

**(b) 有没有行为改变 —— 有三处，但都不可被生产代码观测：**
1. 包装器是 `async` 函数，`FileHandle` 的兑现比直调 `actual.open` **晚约 2 个 microtask hop**（`actual.open(...)` 本身仍在同一 tick 发起）；
2. `open.name` / `open.length` 变了（无人依赖）；
3. `openSpy.mock.calls` **在整个文件生命周期内持有每次调用的参数引用**（内存留存，非语义）。

**实测证据（不是机械论证）**：
- 基线（**无** spy）`tests/persistence/fileStore.test.ts` = **77/77 绿**；
- 尖端（**有** spy）= **79/79 绿**，即同样那 77 条 + 2 条新增；
- `vi.mock` 是 **per-test-file** 的，所以影响半径**被限制在这一个文件内** —— 其余 30 个文件的计数与结果在基线/尖端两次全套件跑里**一字不差**。

⇒ **在"通过/失败"这个粒度上，我实测不到任何行为改变。** 我没验到的那一格（时序敏感性）见 §8。

### 3.3 两种「既有」口径，**分别裁，我不替人消解**

先把事实钉死（我自己 `git log -S` 查的）：
**这个 `vi.mock("node:fs/promises", …)` 工厂引入于 `fb62714`（2026-08-02，"drive finalize from the transaction marker…"）**，
早于包 2 的基点 `e42e062`（PKG3 gate）。

- **口径 A（"任务之前"＝包 2 开工之前）**：该工厂**是既有的**（早于包 2 三整轮）。
  本轮修改了它 ⇒ **动了一件人裁 48 没点名的既有东西。按口径 A，这是越界。**
- **口径 B（"本修复环之前"＝ `dbac288`）**：该工厂**同样是既有的**。
  ⇒ **按口径 B，这也是越界。**

*** **两种口径给出同一个答案：它是越界的。** *** 这一点没有解释空间，我不为它圆场。

**但同时要把边界说准，否则就变成另一种夸大**：
- 它**不是**对任何**既有判据（expectation）**的修改 —— 人裁 48 那句话防的是"改既有判据"，而这一处没有改任何 `expect`；
- 它**是**对**既有共享夹具**的修改，而共享夹具的改动会波及同文件的**全部 79 条**测试。

⇒ 这两句都为真，**它们指向不同严重度，人需要在这两句之间做裁断，而不是由我或实施者替他选一句。**
实施者已据实自曝了这一处（我核过，`wbfix-impl-report.md` §0 与 §8 都写了），**没有隐瞒**。

### 3.4 人裁 48 点名之外**还有没有别的**被动到 —— 没有

- `src/` 非注释改动 **零行**（§1.3，读完整份 58 行 diff）；
- 六个文件之外的文件：`git diff dbac288..HEAD --stat` 只列出 6 个代码文件 + 5 个 `.md`，**没有第七个代码文件**；
- 既有 `expect(` 行：**零删除、零改写**（我在四个测试文件的 diff 里逐 hunk 数过）。

## 4. 勘误措辞核查：原句是否保留、有无 overclaim

### 4.1 两句原文是否**逐字保留**（不许被改软）—— 保留 ✅

| 原句 | 位置 | 现状 |
|---|---|---|
| `Two lock spans cannot interleave` | `src/persistence/fileStore.ts`，`publishReconciliationUnderTransferLock` 上方注释块 | **仍在原处、逐字**。该 hunk（`@@ -498,6 +498,22 @@`）**零删除行**，勘误是纯追加 |
| `(unrelated, already-known) zero-length lock window` | `tests/persistence/fileStore.test.ts`，`recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing` describe 内的夹具注释 | **仍在原处、逐字**。该 hunk（`@@ -2988,6 +3133,19 @@`）**零删除行** |

⇒ 两处都是「保留原话 + 追加勘误」，**没有任何一句被就地改软或删掉**。这正是本仓库自陈的做法，做到了。

### 4.2 勘误里每一句**事实陈述**是否成立 —— 逐条对代码/台账核过

**勘误一（`fileStore.ts`）**：

| 陈述 | 我的核验 | 结论 |
|---|---|---|
| "creates the lock with `open(lockPath, "wx")` and only then does `handle.writeFile(...)`" | `acquireOwnerTransferLock` 里确是 `const handle = await open(lockPath, "wx");` 后跟 `await handle.writeFile(...)` | **真** |
| "Between those two awaits the lock file exists and is ZERO BYTES" | 直接推论，且我在 §6 的探针里**实地造出了这个 0 字节锁并观测到它被摘走** | **真（并已实测）** |
| "`JSON.parse("")` throws, so control lands in the `catch` branch — and that branch NEVER CALLS isProcessActive" | `tryRecoverStaleOwnerTransferLock`：`isProcessActive` 只出现在 `try` 里的 `if (pid !== null && isProcessActive(pid))`；`catch` 分支只有 `pathExists` 三连 | **真，逐字属实** |
| "It asks only whether staged artifacts exist, and if they do it `safeUnlink`s the lock and reports it recovered" | `catch` 分支 `if (!hasStagedArtifacts) return false;` 之后落到 `await safeUnlink(lockPath); return true;` | **真** |
| "The controller reproduced this with two REAL processes (ledger §21.1, with a must-hit and a must-miss control)" | 台账 §21.1 存在，含三行表：SANITY-1（必须被尊重）／PROBE（锁被偷）／SANITY-2（必须被尊重）—— **确有一条必命中与一条必不命中对照** | **真** |
| "no line of acquireOwnerTransferLock or tryRecoverStaleOwnerTransferLock was touched" | §1.3：`src/` 非注释 diff 为空 | **真** |

**勘误二（`fileStore.test.ts`）**：所有 C-1 机制陈述与勘误一同源，同上为真。
"The fixture below is deliberately UNCHANGED" —— 核过，该 hunk 零删除行，`handle.writeFile` 那段夹具一字未动。**真**。

### 4.3 有没有 overclaim —— **勘误本身没有；但同轮新增的另一处注释有一句真的说过头了**

- **两处勘误本身：我找不到 overclaim。** 它们的措辞反而偏保守（例如都明写"repair … was DELIBERATELY NOT MADE in this round"）。
- **一处 Low 级精确性瑕疵**（勘误二）：开头写 `but it IS FALSE AFTER D2`。
  0 字节锁窗口是 `acquireOwnerTransferLock` 的固有形状，**在写下 "unrelated" 那一刻就已经是假的**，并非 D2 造成。
  `AFTER D2` 这个时间限定容易让读者以为窗口是 D2 引入的。→ **Low-1**，见 §6。
- **一处 Important 级 overclaim（不在勘误里，在 2.2 那个 `openSpy` 的注释里）**：
  「fileStore.ts calls `open` in exactly one place — acquireOwnerTransferLock — **so one open of the lock path is one acquisition attempt**」。
  前半句真（`open` 全 `src/` 只在 `fileStore.ts` 导入、只在一处调用）；**后半句是假的，而且我实测证伪了它** —— 见 §6 的 **Imp-1**。

### 4.4 2.1(a) 与 2.1(b) 的事实核验（brief 未单列，但属同一"注释是否说得准"的家族）

**2.1(a) 人裁 13 锚点**：
- 人裁 13 确实存在：`progress.md` —— `*** **人裁 13。2026-08-07。人选 (ii)「扩权：允许包 2 改这条判据」。** ***`
- 新注释自陈的探针前提「全仓搜 `ruling 13` 零命中，同次搜 14/17/37 命中 ⇒ 检索面已证活」——
  **我自己重跑了这条探针**：`grep -rn "ruling 1[0-9]\|ruling [23][0-9]\|ruling 4[0-9]\|RULING [0-9]" src/ tests/`
  命中 `human ruling 14`（×2）、`human ruling 17`、`human ruling 37`、`ruling 38`，**同类同面**；
  本轮之前 `ruling 13` 确实零命中（现在的两条命中就是本轮新加的锚点本身）。**前提成立。**
- ⚠️ **Low-2**：新注释把人裁 13 描述成「a NAMED EXCEPTION to this repository's standing rule that an existing test's name is not to be changed」，
  而台账原文授权的是「**改这条判据**」（改名只是其后果之一，见台账「实施者按人裁 13 授权改了它的名字」）。
  这是**把授权说窄**，不是说过头，无害；但既然本轮的主题就是"注释要说得准"，记一条 Low。

**2.1(b) HONEST LIMIT 第 4 条路径**：三条子断言我逐条对代码核过 ——
1. 「structure test PARSES EXACTLY ONE FILE，`runLoopSourcePath` 硬编码到 `src/controller/runLoop.ts`」——
   `tests/controller/ownedRunStateWriter.structure.test.ts` 顶部：`const runLoopSourcePath = fileURLToPath(new URL("../../src/controller/runLoop.ts", import.meta.url));`，**全文只此一个源路径**。**真**。
2. 「dynamic `await import()` 不可见（它走 `ImportDeclaration` 节点）」—— 两个 helper 都 `if (!ts.isImportDeclaration(statement)) continue;`。**真**。
3. 「`src/controller/resumeLoop.ts` 完全在视野之外；它今天不 import `writeRunState`」——
   `resumeLoop.ts` 从 `fileStore.js` 导入的是 `appendEvent / claimOwnerRecordWithPrecondition / OwnerTransferLockBusyError / readOwnerRecord / readOwnerTransferRecord / readReconciliationRecord / readRunState`，**没有 `writeRunState`**；structure test 也确实从不读这个文件。**真**。
4. 其中夹了一条**全称否定**：「no test in this repository observes the set of files under `src/`」。
   **我加了必命中 sanity 探针后再下结论**：`grep -rn "readdir\|globSync\|fast-glob\|readdirSync" tests/` **有 16 行命中（检索面是活的）**，
   但**每一处的目标都是 `runDir` / `runDir/worktrees` / `runDir/attempts`，没有任何一处指向 `src/`**。**该全称否定成立。**

## 5. BLOCKED 那一项：18 行翻转、判据红法、两条理由的逐字核验

> **这一节是要交给人的材料。三项我全部亲跑，`f584bb6` 用 `git apply` 打到工作树上实测，之后 `git checkout HEAD --` 还原并验双 0 字节。**

### 5(a) 18 行翻转与 gap 编号 —— **完全对，一个不差** ✅

把 `f584bb6` 的 **src 半 + test 半**都打上，跑 `fileStore.test.ts` + `resumeLoop.integration.test.ts`（`blocked-a.log`，107 行）：

```
 ❯ tests/persistence/fileStore.test.ts (79 tests | 1 failed)
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, …
     → expected [ …(17) ] to deeply equal [ …(17) ]
     → expected [ …(17) ] to deeply equal [ …(17) ]
 ✓ tests/controller/resumeLoop.integration.test.ts (15 tests) 2526ms
```

**逐行核对结果**：

| 项 | 实施者的说法 | 我的实测 | 判定 |
|---|---|---|---|
| 翻转行数 | 18 | **18**（两个 fixture 各 9 行） | ✅ |
| gap 编号 | 05–13 | **05–13**，两个 fixture 都是这九个 | ✅ |
| 01–04 不变 | 是 | **是**（仍 `refused: cannot read run artifacts` / `recovery=throws …`） | ✅ |
| 14–17 不变 | （未提） | **不变**（本来就 `accepted`） | ✅ |
| 翻转方向 | `refused` → `accepted` | **`refused` → `accepted`** | ✅ |
| 红法 | （未提） | 两条都是 **`AssertionError`**（`expect.soft(...).toEqual([...])`），**不是异常也不是超时** | ✅ |

*** **一条实施者没说、但人裁必须知道的关键细节 —— 那 18 行不是同一回事，它们是两半：** ***

- **`stageFirstOwnerTransferCrashedAt` fixture 的 9 行（gap 05–13）**，翻转前的拒绝理由**全部**是
  `resume=refused: cannot read run artifacts` —— *** **这正是 I-4 那个读顺序缺陷本身**，不是任何 epoch 判据。 ***
- **`stageDoubleOwnerTransferCrashedAt` fixture 的 9 行（gap 05–13）**，翻转前的拒绝理由才是两条 epoch 判据：
  - gap 05–07：`refused: published eligibility has been superseded by a newer owner epoch`（判据 B）
  - gap 08–13：`refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch`（判据 A）

⇒ **18 行里只有 9 行真正牵涉 epoch 判据的承重性；另外 9 行擦掉的是缺陷自身产生的假拒绝。**
这个区分对人裁很重要，因为它把"这是放宽"与"这是修 bug"分到了不同的行上。

### 5(b) 回归判据在**未修**代码上是否**红在断言** —— **是，红在断言** ✅

只打 `f584bb6` 的 **test 半**（产品代码保持未修），跑 `resumeLoop.integration.test.ts`（`blocked-b.log`）：

```
 ❯ tests/controller/resumeLoop.integration.test.ts (15 tests | 1 failed) 2490ms
   × resumeLoop > resumes a run interrupted between the transaction's owner-record and reconciliation renames, instead of refusing it as unreadable
AssertionError: expected { kind: 'refused', …(1) } to deeply equal { Object (kind, detail) }
- Expected
+ Received
  Object {
-   "detail": "succeeded",
-   "kind": "resumed",
+   "detail": "cannot read run artifacts: Error: ENOENT: no such file or directory, open '…/reconciliation-record.json'",
+   "kind": "refused",
  }
BLOCKED_B_EXIT=1
```

*** **`AssertionError`，不是 throw、不是 timeout。** *** 结果被 `.then(ok, err)` 捕成**值**再比较，
所以「拒绝」与「炸掉」在失败输出里是可区分的 —— 这正是本仓库反复要求的形状，**做到了**。
而且它红出来的 `detail` 与判据注释里预写的那一句**逐字一致**，说明作者不是事后补的。
打上 src 半之后该判据转绿（5(a) 的 `resumeLoop.integration.test.ts (15 tests) ✓`）。**双向实测成立。**

### 5(c) 两条「不该由它决定」的理由

#### 理由① 矩阵注释是否**逐字**自陈「当前交错让两条 epoch 判据承重」—— **是，逐字属实** ✅

`tests/persistence/fileStore.test.ts`，紧邻那条 `it(` 上方，**逐字**：

> `//   - resumeLoop reads the owner record THROUGH recovery (readOwnerRecord) and the other two`
> `//     RAW, all inside one Promise.all. So a mid-transaction gap is seen as "post-recovery owner`
> `//     record + pre-recovery transfer/reconciliation". That interleaving is exactly what the two`
> `//     epoch-equality criteria in evaluateResumeEligibility exist to refuse, and it is why the`
> `//     double-transfer fixture — not the first-transfer one — is what makes them load-bearing.`

⇒ 注释**确实**把当前交错写成"让那两条 epoch 判据承重"的原因。理由①**成立**。

*** **但实施者在报告里把它拔高了一档，那一档是假的（→ Imp-2）：** ***
`wbfix-impl-report.md` §6 写「…是让那两条 epoch 判据成为承重判据的**唯一来源**」。
**我实测证伪**：`tests/controller/resumeLoop.gate.test.ts` **直接**断言这两条拒绝理由（三处
`reason: "reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch"` /
`reason: "published eligibility has been superseded by a newer owner epoch"`），
且在 `f584bb6` 打上之后**仍然 27/27 全绿**（`blocked-c.log`，`GATE_EXIT=0`）。
⇒ 那两条判据**不会因为这 18 行翻转而变成零断言**；被擦掉的是它们在**真实崩溃交错**下的承重性，**不是全部覆盖**。
注意矩阵注释自己只作了较窄的主张（"是**哪个 fixture**让它们承重"），**"唯一来源"是报告加上去的，注释没这么说。**

#### 理由② 「permit more resumes」是否真的撞上 S-3「绝不放宽」—— **该立场原文存在，我逐字引到了；但它是否覆盖本次，文本没有裁死** ⚠️

**原文找到了**，在 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`，
「### 若修法方向不可行时的退路（S-3）」一节，**逐字**：

> **明确禁止的退路**：放松 `resumeLoop` 对 reconciliation 的必需性（例如「若存在则校验，不存在则跳过」）。那是**引入新授权**，违反 L1/L1b/L2 三层共同的「只增加拒绝，绝不新增许可」边界。缺失即拒绝的 fail-closed 行为必须保留。

**仓库内的援引先例也找到了**，`src/persistence/fileStore.ts` 的 `transferRepresentsPublishedWinner` 上方，**逐字**：

> `// was measured to permit MORE resumes — for a surviving winner record, for an ABSENT one, and for`
> `// a CORRUPT one, … — and S-3's "never permit more" forbids that.`

**我的独立裁断（把两边都说清，不替人选）**：

- **支持"撞上了"的一面**：S-3 那句边界写的是**通则** ——「只增加拒绝，**绝不新增许可**」，不限于 reconciliation 那个例子；
  而且仓库**确有先例**用这条通则否掉过一处改动，那处改动的"罪名"同样只是"permit MORE resumes"。
  本次 18 行 `refused → accepted`，字面上就是"新增许可"。
- **支持"没撞上"的一面**：S-3 **点名禁止**的是「放松 `resumeLoop` 对 reconciliation 的**必需性**（若存在则校验，不存在则跳过）」。
  `f584bb6` **没有**放松任何必需性：reconciliation 仍然必需、仍然全量校验，
  它只是**先 `await` 已经在跑的恢复**，让后续的读看到恢复**已提交**的结果。
  翻转后的 `after` 列显示三份文件都齐、epoch 一致（`after T=e3 O=e3 R=e3 M=absent P=---`），
  即被放行的格子是**事务已经补完整**的格子，不是"缺一份也放行"的格子。
  而且 5(a) 已经证明：18 行里有 9 行的原拒绝理由压根不是 epoch 判据，而是 `cannot read run artifacts` —— 缺陷自产的假拒绝。

⇒ **结论：立场原文存在且措辞足够宽，能够够到本次改动；但"够得到"不等于"已经裁定"。**
S-3 的**具名禁止项**与本次改动**不同形**，所以这是一个**真的判断题**，文本本身没有替人回答。
**实施者停下来问人是对的**；它在报告里的措辞（"本次是不是该立场的例外，不是我能决定的"）**也是校准过的、没有过度声称**。
过度声称只出现在理由①的"唯一来源"上（Imp-2）。

## 6. Findings（分级，finding 与处置建议分开写）

**Critical 0 ／ Important 2 ／ Low 4。**

> ⚠️ **给控制器**：下面每条的「FINDING」与「处置建议」是**分开的两段**。
> 上一轮控制器只读了 finding 就派工，做了评审员明说不该做的修改。**请连"是否应在本轮修"那一行一起读。**

---

### Imp-1（Important）—— `openSpy` 注释里的等价关系是假的，**我实测证伪**

**FINDING（只陈述事实）**
`tests/persistence/fileStore.test.ts` 中 `const openSpy = vi.fn();` 上方的注释写：

> `// fileStore.ts calls 'open' in exactly one place — acquireOwnerTransferLock —`
> `// so one open of the lock path is one acquisition attempt`

- **前半句真**：`grep -rn "open" src/` 显示 `open` 只在 `src/persistence/fileStore.ts` 被导入，且只有一个调用点。
- **后半句假**：`acquireOwnerTransferLock` **自己内部还有一层循环** ——
  `for (let attempt = 0; attempt < 2; attempt += 1)`。当 `tryRecoverStaleOwnerTransferLock` 返回 `true`（锁被判为可回收）时，
  **同一次 `acquireOwnerTransferLock` 调用会第二次 `open`**。
- **实测（不是读代码推的）**：我临时加了一条探针测试，造出 0 字节锁 + staged marker（即 C-1 那个窗口），
  调用 `writeBoundaryArtifacts` 一次，然后数 `lockAcquireAttempts`：

```
 × fileStore > REVIEWER TEMPORARY PROBE — one open of the lock path is NOT one acquisition attempt
     → expected 2 to be -1 // Object.is equality
```
  *** **一次重试循环迭代 = 2 次 open。等价关系被实测证伪。** ***

**影响面（说准，不夸大）**：
`expect(lockAcquireAttempts(runDir)).toBe(3)` **今天是对的**，因为那两条新测试的夹具写的是
`holderProcessInstanceId: pid:${process.pid}` —— 一个**活着**的 pid，于是 `tryRecoverStale…` 返回 `false`，
每次迭代恰好 1 次 open。**断言没错，错的是它给自己写的理由**，而这个理由一旦被后人当真去改夹具，断言就会静默失准。
讽刺之处：把这个映射打破的那个场景，**正好就是本轮两处勘误在讲的 C-1 零字节窗口**。

**处置建议（与 finding 分开）**
- **本轮不必修。** 它不让任何现有断言变错，且修它要动 `fileStore.test.ts` —— 又是一次共享文件改动，
  在人裁 48 的边界正在被讨论的当口，不值得为一条注释再开一个越界口子。
- **建议**：与 C-1 的修复（待裁点 B）**同批**处理。最小改法是把那句改成
  「一次 `open(lockPath)` 是一次**锁尝试**；只要锁的持有者是活进程，一次锁尝试就等于一次重试循环迭代 —— 这两条新测试的夹具正是如此」，
  并在 `toBe(3)` 那条断言旁点明它依赖"活持有者"这个夹具前提。
- ⛔ **不要**在本轮擅自改。

---

### Imp-2（Important）—— BLOCKED 材料里的理由①被拔高成「唯一来源」，**这一句是假的**

**FINDING（只陈述事实）**
`wbfix-impl-report.md` §6 第 2 点写：「…**而且是**让那两条 epoch 判据成为承重判据的**唯一来源**」。
**实测证伪**：`tests/controller/resumeLoop.gate.test.ts` 直接断言这两条判据的拒绝理由（三处），
且在 `f584bb6` 打上之后 **27/27 全绿**（`GATE_EXIT=0`）。
矩阵注释**自己**只作了较窄的主张（"是**哪个 fixture**让它们承重"），**"唯一来源"是报告加上去的**。

进一步（§5(a) 已测）：18 行里只有 **9 行**（double-transfer fixture）原本由 epoch 判据拒绝；
另 **9 行**（first-transfer fixture）原本是 `refused: cannot read run artifacts` —— **缺陷自产的假拒绝**。

**为什么这是 Important 而不是 Low**：这是**要送到人手上做裁决的材料**。
一个人读着「唯一来源」去裁「要不要放弃这 18 行」，与读着「realistic-crash 交错下的承重覆盖会没，但单元层覆盖还在，且 18 行里有 9 行是假拒绝」去裁，
**很可能得出不同结论**。brief §3 明写这份材料"必须准"。

**处置建议（与 finding 分开）**
- **应在本轮修，但修的是"报告措辞"，不是代码。**
- 具体：把 `wbfix-impl-report.md` §6 第 2 点的「唯一来源」改成准确表述，并补上 §5(a) 的 9/9 拆分。
- ⛔ **不要**因为这条 finding 去动 `f584bb6`、去动矩阵、或去动任何测试代码。**BLOCKED 的裁决权仍在人手上。**

---

### Low-1 —— 勘误二的 `IS FALSE AFTER D2` 时间限定不准

**FINDING**：0 字节锁窗口是 `acquireOwnerTransferLock` 的固有两步发布形状，**在写下 `(unrelated, already-known)` 那一刻就已经使该词为假**，并非 D2 造成。`AFTER D2` 可能让读者以为窗口是 D2 引入的。
**处置建议**：**本轮不必修**（纯注释精确度，不影响任何判据）。若日后回头改这段勘误，把 `AFTER D2` 换成 `and was already false when that word was written` 即可。

### Low-2 —— 人裁 13 锚点把授权范围说窄了

**FINDING**：新注释说人裁 13 是「an existing test's **name** is not to be changed」的具名例外；台账原文授权的是「**扩权：允许包 2 改这条判据**」，改名只是其后果之一。**说窄，不是说过头。**
**处置建议**：**本轮不必修**。

### Low-3 —— 第三条常数断言在算术上是死的

**FINDING**：两个文件里的
`expect((OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS - 1) * OWNER_TRANSFER_LOCK_RETRY_DELAY_MS).toBe(100);`
只有在它前面两条（`toBe(3)` / `toBe(50)`）**已经失败**时才可能失败 —— 3 和 50 一旦被钉死，`(3-1)*50` 恒为 100。
**实测佐证**：我三次变异（`3→2`、`50→70`、全套件 `3→2`）里，失败点**每次都停在前两行**，第三行**一次都没执行到**。
它的变异检出力为 **0**。（轻微反讽：本轮要治的正是"对任何取值都成立的自指断言"。）
**处置建议**：**本轮不必修**，它零成本且无害；删它反而要再动一次既有文件。仅作记录。

### Low-4 —— `vi.mock` 工厂那一处在**两种口径下都是越界**（事实记录，裁断留给人）

**FINDING**：见 §3.3。工厂引入于 `fb62714`（2026-08-02），早于包 2 基点 `e42e062`，
所以**口径 A（任务之前）与口径 B（本修复环之前）给出同一答案：它是既有共享夹具，人裁 48 没点名它**。
同时为真的另一句：**它没有修改任何既有 `expect`**。这两句指向不同严重度。
实施者已主动自曝，**没有隐瞒**。行为层面我实测不到差异（§3.2）。
**处置建议**：**本轮不要动它**（改法本身又是一次共享文件改动）。**请人在 §3.3 的两句之间裁一次**：
是按"没改判据 ⇒ 可接受，补记一笔"了结，还是按"动了共享夹具 ⇒ 需第六个具名例外"补授权。
⛔ 我**不**替人消解这个口径，也**不**建议控制器代裁。

## 7. 我的临时变异与还原证明

**开工前**：`git status --porcelain` 只有 `?? .superpowers/…/wbfix-review.md`（本报告，我自己新建）。
**全程**：只在 `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix` 内动手；
**没有** `git commit` / `push` / 建删分支 / 合并；**没有触碰主仓库**。
`f584bb6` 是用 `git apply`（工作树）实测的，**不是 `cherry-pick`**，所以没有产生任何提交。

**共 8 次临时变异，每次还原后都同时验 `git diff` 与 `git diff --cached` 均为 0 字节**
（brief §0 特别点名 `git checkout <commit> -- path` 会进暂存区 —— 我用的正是 `git checkout HEAD -- <paths>`，
它把 index 与工作树一起对齐到 HEAD，所以两个 diff 同时归零；**我每次都实测了，不是假定**）：

| # | 变异 | 目标文件 | 还原方式 | `git diff` | `git diff --cached` |
|---|---|---|---|---|---|
| M1 | `RECONCILIATION_LOCK_RETRY_ATTEMPTS 3→1` | `src/persistence/fileStore.ts` | Edit 改回 | **0** | **0** |
| M2a | 守卫放行三终态 | `src/controller/ownedRunStateWriter.ts` | Edit 改回（经 M2b） | — | — |
| M2b | 守卫放行 `failed`/`cancelled`（必命中对照） | `src/controller/ownedRunStateWriter.ts` | Edit 改回 | **0** | **0** |
| M3a | `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS 3→2` | `src/controller/runLoop.ts` | perl 改回（经 M3b） | — | — |
| M3b | `OWNER_TRANSFER_LOCK_RETRY_DELAY_MS 50→70` | `src/controller/runLoop.ts` | perl 改回 | **0** | **0** |
| M0 | 六个文件回退到 `dbac288`（取基线） | 6 个文件 | `git checkout HEAD -- <6 paths>` | **0** | **0** |
| B-b/B-a | `git apply` `f584bb6` 的 test 半、再加 src 半 | `src/controller/resumeLoop.ts`、`tests/controller/resumeLoop.integration.test.ts` | `git checkout HEAD -- <2 paths>` | **0** | **0** |
| B-c | 再次 `git apply` `f584bb6` src 半（查 gate 覆盖） | `src/controller/resumeLoop.ts` | `git checkout HEAD -- <path>` | **0** | **0** |
| P1 | 临时探针 `it("REVIEWER TEMPORARY PROBE …")` | `tests/persistence/fileStore.test.ts` | `git checkout HEAD -- <path>` | **0** | **0** |
| M3c | `OWNER_TRANSFER_LOCK_RETRY_ATTEMPTS 3→2` + 全套件 | `src/controller/runLoop.ts` | `git checkout HEAD -- <path>` | **0** | **0** |

**收工时实测**：
```
DIFFBYTES=       0 CACHEDBYTES=       0
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/wbfix-review.md
```
⇒ *** **工作树除本报告外，与 `HEAD` 逐字节一致。没有留下任何未还原的改动。** ***
（`npm run build` 产生的 `dist/` 是 gitignored，不出现在 `git status` 里 —— 我核过。）

## 8. 我没能验到的、以及为什么

**Rule 12 fail loud —— 下面每一条我都没做到，不粉饰、不用"应该没问题"代替。**

1. **`openSpy` 的时序敏感性没有测。**
   我证明了 spy 在**通过/失败**粒度上零影响（基线 77/77 ↔ 尖端 79/79，同一批 77 条）。
   我**没有**做的是：重复跑 `fileStore.test.ts` N 次，看那 2 个额外 microtask hop 会不会扰动同文件里那些
   race 形状的测试（`two concurrent unlocked readers racing` 那一族）。
   **结论边界**：我能说"我实测不到行为改变"，**不能说"证明不存在行为改变"**。
   （缓解事实：既有的 `renameSpy` 是同一形状且已在库里跑了很久，但那是先例，不是证据。）

2. **理由② 的最终裁断我没有下，也不该由我下。**
   我做到的是：**找到 S-3 原文并逐字引**、找到仓库内的援引先例、把"够得到"与"已裁定"分开。
   我**没有**做的是替人决定这 18 行该不该接受 —— brief 明写这是人裁材料，我只负责让它准。

3. **我没有独立复现 C-1 本身（双真进程）。**
   两处勘误引用的是台账 §21.1 的控制器复现。我核了 §21.1 **确实存在**、**确实含必命中(SANITY-1)与必不命中(SANITY-2)两条对照**、
   且勘误对机制的每一句描述**都对得上代码**；我还用探针**单进程**实地造出了 0 字节窗口并观测到锁被摘走（§6 Imp-1 的副产品）。
   但**双真进程那一格我没重跑** —— 它不在本轮 brief 的六件事里，且 C-1 明令本轮不修。

4. **`f584bb6` 打上后我没有跑全套件。**
   我跑的是受影响的三个文件（`fileStore.test.ts`、`resumeLoop.integration.test.ts`、`resumeLoop.gate.test.ts`）。
   所以"除了那 18 行还会不会打红别的"这个问题，**我只覆盖到这三个文件的范围**。
   人若要落地 `f584bb6`，**应先跑一次全套件**再定稿那 18 行。

5. **我没有核 `wbfix-impl-report.md` 的全部 435 行。**
   我只核了它的 §0 结论表、§1 基线、§6 BLOCKED 段、§7 最终验证、§8 自曝段 —— 即所有**承重断言**所在处。
   其余段落（逐项施工叙述）我没逐字核，那些不构成本次裁断的依据。

## 9. 预算：harness 可数事实（不要自报估计）

**⚠️ 不自报 token 估计。** 只交可数事实：

| 可数项 | 数 |
|---|---|
| 全套件跑（`npm test`，未过滤，整份落盘） | **3** 次（尖端 / 基线 / `ATTEMPTS 3→2` 全套件） |
| 单/多文件 vitest 跑 | **9** 次 |
| `npm run typecheck` | **1** 次（`TYPECHECK_EXIT=0`） |
| `npm run build` | **1** 次（`BUILD_EXIT=0`） |
| 临时变异 | **8** 次（M1 / M2a / M2b / M3a / M3b / M3c / M0 / P1）＋ `git apply` `f584bb6` **3** 次 |
| 还原后双 0 字节实测 | **8** 次（每次变异后各一次） |
| 落盘日志文件 | **11** 份，全在 `/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/c74add88-b8d0-4cb8-8759-2160067337a8/scratchpad/` |
| 我自己新建的临时测试（探针） | **1** 条，已还原 |
| 本轮我产生的提交 | **0** |

**日志清单（整份落盘、整份读回，未做 grep/tail/sed 过滤）**：
`tip-test.log`(158) / `tip-typecheck.log` / `tip-build.log` / `baseline-test.log`(157) /
`m1.log`(49) / `m1-restore.log` / `m2a.log`(76) / `m2b.log`(132) /
`m3a.log`(63) / `m3b.log`(63) / `m3-restore.log` / `m3c-full.log`(187) /
`blocked-a.log`(107) / `blocked-b.log` / `blocked-c.log` / `probe-open.log`

> 唯一一次我用了过滤显示的是 `m3c-full.log` 的首次查看（`grep` 摘要）——
> **我当场自曝并立刻整段无过滤读回了失败区与汇总区**，结论以无过滤读回为准。据实记账。
