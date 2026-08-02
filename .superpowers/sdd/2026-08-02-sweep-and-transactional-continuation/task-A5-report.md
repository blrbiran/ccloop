# Task A5 报告 — 崩溃中间态矩阵与两条 epoch 判定的承重（测试 2、6b）

分支 `feat/l3-debt1-transactional-continuation`，worktree `.claude/worktrees/l3-debt1-group-a`，BASE = `412f8157`，提交 = `84c7825`。

**验证输出的过滤机制**：全局 `rtk` shell hook 会静默摘要 vitest 输出。本任务所有验证跑一律先
`export ECC_GATEGUARD=off DISABLE_OMC=1`，再用 `rtk proxy "<command>"` 绕过 hook。下文每一段贴出的
输出都是完整的、未截断的（含 `Start at` / `Duration` / 回显的退出码）；**我没有从任何一段被贴出的输出里
删掉过一行**。全文确实出现过字面 `...`，但没有一处是省略掉输出：它们分别是源码里的展开运算符
（`{ ...target, value }`）、`.superpowers/sdd/.../progress.md` 这个路径缩写（全路径为
`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`）、以及本文两处自查
段落里对 `...` 这个符号本身的引用。另有 vitest 自己渲染的 `…(17)` 与它截断的源码帧，逐字保留。
**判据是「有没有从被贴出的输出里删行」，答案是没有。**

---

## 1. 实现了什么

只动测试，`src/` 零永久改动。全部落在 `tests/persistence/fileStore.test.ts`：

- 两组具名 fixture 构造器（模块作用域，未导出到 `src/`）：
  `stageFirstOwnerTransferCrashedAt(gap)`、`stageDoubleOwnerTransferCrashedAt(gap)`。
- 两条 fixture 冒烟测试（Step 2）。
- 测试 2（**名字已被取代，见紧随其后的说明**）：
  `fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives`。
- 辅助：`crashOwnerTransferAtStep`（故障注入）、`crashSnapshot`、`observeResume`、`observeRecovery`、
  `observeCrashMatrix`。

> ⚠️ **已被取代（修复轮 1）**：上面「测试 2」那一条列出的是本任务的**初版**测试名，**当前代码树里不存在**。
> 人在修复轮 1 裁定改名，现名为
> `fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives`。
> 理由与三个分句各自的可失败断言见本文件下方「修复轮 1」的 F2 一节。

**偏离（必须由评审确认）**：`tests/controller/runLoop.integration.test.ts` **一行未改**。理由见 §7。

---

## 2. Step 1：从落地代码重数步数

命令与**本次执行**的原始输出：

```
$ grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
734:async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
735-  const paths = getOwnerTransferPaths(runDir);
736-
737-  let marker: OwnerTransferTransactionMarker;
738-
739-  try {
740-    marker = JSON.parse(await readFile(paths.transactionMarkerPath, "utf8")) as OwnerTransferTransactionMarker;
741-  } catch {
742-    // §4.4 rule 3: an unparseable marker is fail-closed — reject before anything is touched.
743-    throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker could not be read or parsed");
744-  }
745-
746-  if (!isValidFinalizeOrder(marker.finalizeOrder, legalFinalizeOrderFileNames(marker.version))) {
747-    // Fail-closed, same as rules 2/3: nothing has been read or touched on disk yet. Without this,
748-    // a v2 marker whose finalizeOrder named only 2 of the 3 legal files would iterate exactly what
749-    // it names, publish those, delete the marker, and leave the omitted pending silently orphaned
750-    // with no error and no cleanup path pointing at it — strictly less safe than the pre-A3 code,
751-    // which ignored finalizeOrder and unconditionally handled all three v2 files.
752-    throw new OwnerTransferMarkerFinalizeOrderInvalidError(
753-      `owner transfer transaction marker's finalizeOrder is not a valid permutation of the v${marker.version} file set`,
754-    );
755-  }
756-
GREP_EXIT=0
```

brief 指定的 `-A22` 只覆盖到 756 行（marker 的 1 次 parse + finalizeOrder 校验），函数体后半段要另外两条
命令才数得全。两条都用 `-F`，锚点是唯一字面串；**本次执行的原始输出**：

```
$ grep -nF -A20 'const staged: Array<FinalizeFileTarget & { value: unknown }> = [];' src/persistence/fileStore.ts
767:  const staged: Array<FinalizeFileTarget & { value: unknown }> = [];
768-
769-  for (const fileName of marker.finalizeOrder) {
770-    const target = fileTargets[fileName];
771-    let value: unknown;
772-
773-    try {
774-      value = JSON.parse(await readFile(target.pendingPath, "utf8"));
775-    } catch (error) {
776-      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
777-        // §4.4 rule 2: fail-closed — a marker that promises this file but finds no pending for
778-        // it refuses to finalize, leaving the marker and every already-checked pending in place.
779-        throw new OwnerTransferPendingMissingError(
780-          `owner transfer pending file for ${fileName} is missing while finalizing a v${marker.version} marker`,
781-        );
782-      }
783-
784-      throw error;
785-    }
786-
787-    staged.push({ ...target, value });
GREP2_EXIT=0

$ grep -nF -A18 'await safeUnlink(entry.tempPath);' src/persistence/fileStore.ts
792:      await safeUnlink(entry.tempPath);
793-      await writeJsonFile(entry.tempPath, entry.value);
794-      await rename(entry.tempPath, entry.targetPath);
795-    }
796-
797-    await safeUnlink(paths.transactionMarkerPath);
798-
799-    for (const entry of staged) {
800-      await safeUnlink(entry.pendingPath);
801-    }
802-  } catch (error) {
803-    await safeUnlink(paths.transferTempPath);
804-    await safeUnlink(paths.ownerTempPath);
805-    await safeUnlink(paths.reconciliationTempPath);
806-    throw error;
807-  }
808-}
809-
810-async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
GREP3_EXIT=0
```

**我数出来的两个数**：

- **try 之前的 readFile + JSON.parse：N = 4**（marker 1 次 @740，加上 `marker.finalizeOrder` 每个条目
  1 次 @774；v2 marker 的 finalizeOrder 是 3 个文件名 → 3 次）。
- **try 内的步数：M = 13**（3 个 staged 条目 × [safeUnlink temp、writeJsonFile temp、rename] = 9，
  加 `safeUnlink(marker)` = 1，加 3 × `safeUnlink(pending)` = 3）。

N + M = **17 个注入点**。这两个数是从上面这次 grep 的输出 + 同一函数体后半段数出来的；spec 推的
13 恰好等于 M，但那是巧合，不是依据。

这 17 个注入点对应的执行序列，**是从上面三段 grep 的原始输出推出来的，不是实测打印的**
（推导链：740 行的 marker readFile → 769–774 行按 `marker.finalizeOrder` 顺序的三次 pending readFile
→ 792–794 行按 `staged` 顺序（即 finalizeOrder 顺序 `[owner-transfer, owner-record,
reconciliation-record]`）的三轮 `safeUnlink`/`writeJsonFile`/`rename` → 797 行 `safeUnlink(marker)`
→ 799–801 行三次 `safeUnlink(pending)`）：

```
1: readFile .owner-transfer.transaction.json
2: readFile .owner-transfer.pending.json
3: readFile .owner-record.pending.json
4: readFile .reconciliation-record.pending.json
5: unlink .owner-transfer.publish.tmp
6: writeFile .owner-transfer.publish.tmp
7: rename -> owner-transfer.json
8: unlink .owner-record.publish.tmp
9: writeFile .owner-record.publish.tmp
10: rename -> owner-record.json
11: unlink .reconciliation-record.publish.tmp
12: writeFile .reconciliation-record.publish.tmp
13: rename -> reconciliation-record.json
14: unlink .owner-transfer.transaction.json
15: unlink .owner-transfer.pending.json
16: unlink .owner-record.pending.json
17: unlink .reconciliation-record.pending.json
```

**这段序列本身不是我要求评审接受的证据，它是被测试钉住的结论**：测试 2 的期望矩阵按这个序列写，
第 k 个注入点产生的磁盘快照唯一地对应「前 k−1 步已完成」。序列若与代码不符，矩阵里对应行的快照就对不上，
测试直接红。（本报告先前一版把这段写成「实测打印」而没有贴出产生它的原始输出——那条探针测试当时已被
删除。措辞已按上面的推导链更正，不再声称实测。）

**mock 面**：`readFile` / `writeFile` / `unlink` / `rename` 四个都 mock。`unlink` 是必需的——
步 14..17 全是 `safeUnlink`，只 mock `rename`/`writeFile` 做不出尾部四个中间态。注入的错误码
是 `EIO` 而不是 `ENOENT`，因为 `safeUnlink` 会吞掉 `ENOENT`（`src/persistence/fileStore.ts` 的
`safeUnlink`），用 `ENOENT` 会让这四格静默失效。

---

## 3. 间隙枚举：每一格断言了什么

矩阵每一格产出一行字符串，四个字段都可失败：

```
gap NN | <崩溃后磁盘快照> | resume=<resumeLoop 判决> | recovery=<readOwnerRecord 判决> | after <恢复后磁盘快照>
```

快照记法：`T` = `owner-transfer.json` 的 `newOwnerEpoch`，`O` = `owner-record.json` 的
`currentOwnerEpoch`，`R` = `reconciliation-record.json` 的 `newOwnerEpoch`，`M` = marker
（`absent` / `unparseable` / `v2`），`P` = 三个 pending 的存在位（`TOR` / `-OR` / `T-R` / `TO-` / `---`）。
两个观测各自用一份新构造的 fixture（resume 会 claim、recovery 会 finalize，都会改盘）。

- **间隙 1–4（try 之前的 4 次 read + parse）**：**不是用 mock 读失败做的**。mock 读失败会留下一个
  完好的 staging，四格会塌缩成同一个状态，其中三格什么都不断言（这正是既往「被自己的形状守卫遮住的
  断言」那类缺陷）。所以先用「故障打在步 1」拿到完整 staging（此时磁盘一个字节没动），再把对应的真实
  磁盘损坏加上去：
  - 间隙 1：marker 被写成不可解析（`{ not json`）→ 断言 `recovery=throws OwnerTransferMarkerUnreadableError`
    且恢复后磁盘**一字不动**（`after` 与崩溃快照全等）。这是 §4.4 规则 3 的落点。测试注释里明确写了
    它是**纵深防御、原子写之后不可达**，不是可达路径。
  - 间隙 2 / 3 / 4：分别删掉 `.owner-transfer.pending.json` / `.owner-record.pending.json` /
    `.reconciliation-record.pending.json`（顺序即 finalizeOrder 顺序）→ 断言
    `recovery=throws OwnerTransferPendingMissingError` 且磁盘一字不动。注释写明规则 2 **是可达的**
    （并发恢复路径：先完成的那次恢复会把 pending 删掉）。
  - 双转移下这四格还额外断言了一件事：盘上已发布的三元组在 e2 上**自洽、单看会通过闸门**，
    拒绝**只**来自恢复的 fail-closed。即「事务状态不可判定时不许 resume，哪怕已发布的部分看起来合格」。
- **间隙 5–13（try 内前 9 步）**：断言崩溃时哪些文件已发布、哪些还没有（首发下 T/O/R 的
  `absent → e2` 三段推进；双转移下 e2 → e3 的三段推进），断言 `resume` 的**具体拒绝理由**，
  断言 marker 仍在时 `recovery=ok` 且 `after` 是三文件全部发布、marker 与三个 pending 全部清掉。
- **间隙 14（`safeUnlink(marker)`）**：三文件已全部发布、marker 仍在 → `resume=accepted`，
  `recovery=ok` 且把 marker 与 pending 收干净（幂等重发布）。
- **间隙 15–17（三次 `safeUnlink(pending)`）**：marker 已经没了 → `resume=accepted`，
  `recovery=ok` 且 `after` **与崩溃快照全等**——这一条钉的是 A1 的
  「无 marker 分支的 cleanup 受 `lockHeld` 门控，未传 `lockHeld` 时是零写读」。
  残留 pending 的位模式 `TOR` / `-OR` / `--R` 把 15/16/17 三格区分开。

**必须说清楚的一条边界（原 brief 的字面表述与代码不符，见 §8 关切 1 与修复轮 F2）**：间隙 14–17 处
事务已经过了提交点（三个文件都已发布），**`resumeLoop` 在这四格是接受的，而且接受才是对的**——在那里
断言拒绝等于把 bug 钉成规范。**修复轮 1 已按人的裁定把测试改名**，新名的第一分句限定为
`every pre-commit crash gap`（覆盖间隙 1–13），第二分句 `commits idempotently past it` 正是间隙 14–17
承担的部分。这一点在测试注释里写死了，不是隐含的。

**已知的观测粒度上限（如实记）**：同一个发布三元组内的三步（如 5/6/7）崩溃后**磁盘状态完全相同**——
catch 块会把三个 `.publish.tmp` 都删掉，所以「unlink temp 失败」「writeFile temp 失败」「rename 失败」
留下的可观测残留是同一个。矩阵里这三行因此字面相同。这不是断言写空，是这三步在崩溃后不可区分；
再加任何字段也区分不出来。

---

## 4. 两组 fixture 与冒烟断言

两组构造器都只手写**一个**事务相关文件（`owner-record.json`，epoch 1；另有 `loop-contract.json` /
`loop-state.json` / `events.jsonl` 三个非事务文件由 `seedCrashRunDir` 写），其余全部由生产路径
`writeOwnerTransferArtifacts` 产出。**准确说法**：冒烟断言里只有 `O=e1` 这一个字段是 fixture 自己写下去
的（首发 fixture 的起始 epoch，它是被断言的对象里唯一的输入项）；marker 的 `finalizeOrder`、三个 pending
的 epoch、以及双转移 fixture 里 `T=e2 O=e2 R=e2` 这三个已发布值，全部是被测代码的产出。既往
「fixture 先写再断同一个值」的空断言模式因此不成立，但「什么都不是 fixture 写的」这句话如果照字面读
是不对的，这里更正。

- `stageFirstOwnerTransferCrashedAt(gap)`：`owner-transfer.json` 事前不存在，N=1 → N+1=2。
  冒烟测试 `stages a first owner transfer with no owner-transfer.json on disk beforehand`
  （用 gap 5，即 marker 完好、什么都还没发布的那一格）断言：
  `crashSnapshot === "T=absent O=e1 R=absent M=v2 P=TOR"`，marker 的 `finalizeOrder` 恰为
  `["owner-transfer.json","owner-record.json","reconciliation-record.json"]`，三个 pending 的 epoch 都是 2。
- `stageDoubleOwnerTransferCrashedAt(gap)`：先完整跑一次 1→2（未 mock），再让 2→3 崩在 `gap`。
  冒烟测试 `stages a second owner transfer over a first one that already published all three files`
  断言：`crashSnapshot === "T=e2 O=e2 R=e2 M=v2 P=TOR"`，三个 pending 的 epoch 都是 3。

两条快照字符串不同（`T=absent O=e1 R=absent` vs `T=e2 O=e2 R=e2`），这就是「两组 fixture 真的不同」的
机器可查证据。

---

## 5. Step 5：四次变异实验（**本节全部证据已作废，仅作历史保留**）

> ⚠️ **已被取代（修复轮 1）**：本节所有 `-t` 命令与四份原始输出引的都是**初版测试名**
> （`fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives`），
> 该名字在人裁定改名后**已不存在于代码树**。这些输出是当时真实跑出来的，逐字保留、不做改写，
> 但**不要拿它们当现行证据**。现行证据是「修复轮 1」一节里对着新名重跑的**八次独立运行**
> （四次实验 × 注入前绿/注入后各一次）。本节其余分析文字里若出现「零次求值 / 一次都没有被求值」
> 的措辞，同样已被**修复轮 2** 的更正取代（判据在首发转移下是「从不成立」，不是「从不被求值」）。


注入点全部在**生产代码** `src/controller/resumeLoop.ts` 的 `evaluateResumeEligibility` 判据上。
判据 A = `reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch`；
判据 B = `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch`。变异方式：整条 `if` 删掉。

**关于「每组 fixture 各跑一次」的实现方式**：测试 2 是一条测试，里面用 `expect.soft` 分别比对
**首发 fixture 矩阵**和**双转移 fixture 矩阵**两个数组。soft 的作用就是让一次运行同时报出**两组
fixture 各自的判决**——某组没有出现在失败 diff 里，就是该组在这个变异下**存活**的直接证据（它被求值
过、并且相等）。所以下面两次注入各自同时给出「× 首发」和「× 双转移」两个结论，共四份判决。

单跑命令（下同）：

```
ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t 'refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives'
```

### 5.1 注入前单跑（绿）— 变异 A 之前

```
=== PRE-INJECTION GREEN (mutation A) ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 546ms
   ✓ fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives 545ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  13:57:25
   Duration  1.00s (transform 188ms, setup 0ms, collect 220ms, tests 546ms, environment 0ms, prepare 36ms)

TEST_EXIT=0
```

同时测得计数守卫 `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` → `8`，
`git status --short` → 仅 `.superpowers/.../progress.md`（控制者所写，非本任务）与
`tests/persistence/fileStore.test.ts`，`src/` 无改动。

### 5.2 变异 1（判据 A × 首发 fixture）与变异 2（判据 A × 双转移 fixture）

注入后计数守卫读到 `7`（证明确实删掉了一条）。原始输出：

```
=== MUTATION A INJECTED (criterion A deleted) ===
7

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (68 tests | 1 failed | 67 skipped) 733ms
   × fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives 733ms
     → expected [ …(17) ] to deeply equal [ …(17) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives
AssertionError: expected [ …(17) ] to deeply equal [ …(17) ]

- Expected
+ Received

  Array [
    "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
    "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
    "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
    "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
    "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
    "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
    "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
  ]

 ❯ tests/persistence/fileStore.test.ts:2212:80
    2210|       ]);
    2211| 
    2212|       expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCra…
       |                                                                                ^
    2213|         // Gaps 1..4: the published triple is internally consistent at…
    2214|         // on its own. The refusal comes only from recovery refusing t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  13:57:39
   Duration  1.20s (transform 182ms, setup 0ms, collect 219ms, tests 733ms, environment 0ms, prepare 45ms)

TEST_EXIT=1
```

**变异 1（判据 A × 首发 fixture）判决：非击杀（存活）**。首发 fixture 的矩阵在这次运行里被求值且完全
相等，没有出现在失败 diff 里（失败点是 `:2212` 的第二个 `expect.soft`，即双转移矩阵）。这**不是**我造
不出红，而是 brief 预期的事实本身：首发转移下，reconciliation 已发布而 transfer 未发布的那些间隙里
`owner-transfer.json` 根本不存在，`readOwnerTransferRecord` 直接抛，`resumeLoop` 在进闸门前就拒绝，
判据 A 从来没有被求值。矩阵里首发 fixture 间隙 1–13 的 `resume` 字段清一色是
`refused: cannot read run artifacts`，正是这件事的记录。

**变异 2（判据 A × 双转移 fixture）判决：击杀**。间隙 8–13 的形状恰是
`reconciliation.newOwnerEpoch = e2、ownerTransfer.newOwnerEpoch = e3、ownerRecord.currentOwnerEpoch = e3`
——判据 B 通过（e3 === e3），只有判据 A 拒绝；删掉判据 A 后这六格从 `resume=refused: reconciliation
newOwnerEpoch does not match owner-transfer newOwnerEpoch` 变成 `resume=accepted`。三步判据齐全：
注入前单跑绿（§5.1）+ 注入后单跑红（本节）+ 两份原始输出。

### 5.3 还原证明（变异 A）与变异 B 的注入前单跑（绿）

```
=== REVERT PROOF (mutation A) ===
8
 M .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
 M tests/persistence/fileStore.test.ts
(empty src diff above means reverted)
=== PRE-INJECTION GREEN (mutation B) ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 507ms
   ✓ fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives 507ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  13:57:57
   Duration  941ms (transform 178ms, setup 0ms, collect 211ms, tests 507ms, environment 0ms, prepare 35ms)

TEST_EXIT=0
```

（`8` 是计数守卫；`git diff --stat src/` 与 `git status --short` 都不含 `src/` 条目。）

### 5.4 变异 3（判据 B × 首发 fixture）与变异 4（判据 B × 双转移 fixture）

```
=== MUTATION B INJECTED (criterion B deleted) ===
7

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (68 tests | 1 failed | 67 skipped) 540ms
   × fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives 539ms
     → expected [ …(17) ] to deeply equal [ …(17) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives
AssertionError: expected [ …(17) ] to deeply equal [ …(17) ]

- Expected
+ Received

  Array [
    "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
    "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
    "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
    "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
-   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
    "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
    "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
  ]

 ❯ tests/persistence/fileStore.test.ts:2212:80
    2210|       ]);
    2211| 
    2212|       expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCra…
       |                                                                                ^
    2213|         // Gaps 1..4: the published triple is internally consistent at…
    2214|         // on its own. The refusal comes only from recovery refusing t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  13:58:09
   Duration  966ms (transform 181ms, setup 0ms, collect 215ms, tests 540ms, environment 0ms, prepare 38ms)

TEST_EXIT=1
```

**变异 3（判据 B × 首发 fixture）判决：非击杀（存活）——与 brief 的预期相反，见 §8 关切 2。**
首发 fixture 矩阵在这次运行里同样被求值且完全相等，未出现在 diff 里。结构性原因：判据 B 要求
「盘上（未经恢复的）`ownerTransfer.newOwnerEpoch`」与「经恢复后的 `ownerRecord.currentOwnerEpoch`」
不等；首发转移下 `owner-transfer.json` 要么不存在（读就抛，进不了闸门），要么已经是 N+1、与恢复后的
owner record 相等。所以在 17 个间隙里判据 B 一次都没有被求值过。

**变异 4（判据 B × 双转移 fixture）判决：击杀**。间隙 5–7 的形状是
`ownerTransfer.newOwnerEpoch = e2、reconciliation.newOwnerEpoch = e2`（判据 A 通过）而恢复把
`ownerRecord.currentOwnerEpoch` 推到了 e3——只有判据 B 拒绝。删掉后这三格由
`resume=refused: published eligibility has been superseded by a newer owner epoch` 变成 `resume=accepted`。
三步判据齐全：注入前单跑绿（§5.3）+ 注入后单跑红（本节）+ 两份原始输出。

### 5.5 还原证明（变异 B）与还原后单跑

```
=== REVERT PROOF (mutation B) ===
8
 M .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
 M tests/persistence/fileStore.test.ts--- git diff src/ (must be empty) ---

--- end ---
=== POST-REVERT GREEN ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 502ms
   ✓ fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives 501ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  13:58:27
   Duration  935ms (transform 176ms, setup 0ms, collect 205ms, tests 502ms, environment 0ms, prepare 36ms)

TEST_EXIT=0
```

未经 rtk 过滤的最终 `src/` 洁净证明：

```
$ rtk proxy "git status --short src/"
GIT_SRC_STATUS_EXIT=0
$ rtk proxy "git diff --stat src/"
GIT_SRC_DIFFSTAT_EXIT=0
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
```

（两条 git 命令都是零行 stdout + exit 0，即 `src/` 无任何改动；计数守卫回到 8。）

---

## 6. Step 6：全套件 + typecheck + build（未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1
$ rtk proxy "npm test -- --run"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 8ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 413ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 150ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 29ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 4ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 36ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/persistence/fileStore.test.ts (68 tests) 1930ms
   ✓ fileStore > refuses resume at every crash gap of the three-file transaction and finishes recovery wherever the marker survives 1612ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-P9Roz3/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-avfFR7/run-1  observed 2026-08-02T05:58:52.733Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 421ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2367ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 349ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 321ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 23ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/controller/resumeLoop.gate.test.ts (17 tests) 3ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 283ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3163ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 362ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 374ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 355ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 370ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 380ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 391ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 364ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 441ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2693ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 690ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 580ms
   ✓ render-contract CLI > rejects a non-git repository path 687ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 726ms
 ✓ tests/validation/fixture.test.ts (2 tests) 531ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 529ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6585ms
   ✓ lease heartbeat lifecycle > releases the lease after a resume completes 319ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 545ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 576ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 596ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 469ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 392ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 389ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 370ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 362ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9386ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 570ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 371ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 366ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 386ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 356ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 378ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 369ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 365ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 363ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 349ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 347ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 362ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 349ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 360ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 520ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 384ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 498ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 544ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 351ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 533ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 383ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10279ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 380ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 743ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15780ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1447ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1282ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2506ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1528ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1528ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1549ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 597ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 572ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 574ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 934ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 572ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2512ms

 Test Files  29 passed (29)
      Tests  463 passed (463)
   Start at  13:58:49
   Duration  16.39s (transform 2.19s, setup 0ms, collect 3.30s, tests 54.12s, environment 9ms, prepare 1.62s)

TEST_EXIT=0
```

29 个测试文件全部列出，无省略。**允许的两条 flake (B) 与 (F) 都是 `✓`**，没有名单外失败。
本次 463 = A5 前的 460 + 本任务新增 3 条。

```
$ rtk proxy "npm run typecheck"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

---

## 7. 改动的文件

- `tests/persistence/fileStore.test.ts`：+406 / −1。新增 3 条测试、2 组 fixture 构造器与 6 个辅助函数；
  新增 3 个 import（`resumeLoop` / `ResumeNotEligibleError`、`ScriptedAdapter`、类型 `OwnerTransferRecord`）。
- `tests/controller/runLoop.integration.test.ts`：**未改动**（`git add` 对它是空操作）。

**为什么没动 `runLoop.integration.test.ts`**：测试 2 的完整测试名前缀是 `fileStore >`，即 `describe("fileStore")`，
它只在 `tests/persistence/fileStore.test.ts` 里；两组 fixture 构造器要被测试 2 直接调用，跨测试文件无法
共享（不新增 `src/` 导出、不新增依赖跨文件顺序的测试是硬约束）。Global Constraints 也明确允许
「手工构造磁盘状态的部分直接调 `fileStore` 的导出面」。所以把 fixture 与测试 2 放在同一个文件是唯一
不重复代码、不越界的落法。**代价**：A6 若要复用这两组构造器，需要自己在 `runLoop.integration.test.ts`
里再写一份，或者由 A6 决定把测试放进 `fileStore.test.ts`。请评审确认这个取舍。

提交：`84c7825 test(transaction): pin every crash gap of the three-file transaction and both epoch equality criteria`
（提交信息正文里带了 Step 1 的 grep 原始输出与两个数的推导）。

---

## 8. 自查与关切

### 自查结论

- **每条断言都能失败吗**：能。34 行矩阵字符串里，9 行被两次生产代码变异实测证明可失败（判据 A 杀 6 行、
  判据 B 杀 3 行）；其余各行由崩溃后磁盘快照 + 恢复判决 + 恢复后快照三段独立事实钉住——改动发布顺序、
  漏掉一个 `safeUnlink`、把 fail-closed 改成继续推进、或者让无 marker 的读产生写，都会改掉对应的字段。
- **有没有空断言 / 恒真断言**：没有找到。两条冒烟断言断的都是 `writeOwnerTransferArtifacts` 的产物，
  fixture 自己只写了 `owner-record.json`（epoch 1），不存在「先写再断同一个值」。
- **有没有「被更便宜的守卫抢先」的问题**（既往 6d 的模式）：矩阵是**一次 `toEqual` 比一整个数组**，
  没有前置形状守卫可以抢跑；变异实测确认失败落在具体的间隙行上，不是落在长度或类型上。
- **是否永久改了 `src/`**：没有。四次注入全部还原，`git status --short src/` 与 `git diff --stat src/`
  都是零行 + exit 0，计数守卫 `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` = **8**。
- **是否遵循了既有约定**：`vi.resetModules()` + `vi.doMock` + `vi.doUnmock` + 动态 import 的注入写法、
  `mkdtemp` 造 run dir、用字面 basename 而不是从 `src/` 导出常量——都照抄本文件既有测试。
  两处新东西并已在代码注释里写明理由：(a) `expect.soft`（本文件此前未用过），(b) 在 persistence 测试里
  import `resumeLoop`（brief 要求断言的是 `resumeLoop` 的拒绝）。
- **证据形式自查**：本报告已从头到尾扫过一遍，**我没有删掉任何一行输出**。唯一出现的省略号是 vitest
  自己渲染的 `…(17)` 与错误帧里被 vitest 截断的源码行（`2213| // Gaps 1..4: ... at…`）——那是被贴出的
  工具输出本身长这样，逐字保留，不是我做的省略。每一段命令都回显了退出码
  （`TEST_EXIT` / `typecheck_exit` / `build_exit` / `GREP_EXIT` / `GIT_*_EXIT`），每一个 vitest 块都含
  `Start at` 与 `Duration`。

### 关切 1（**必须由人裁定**）：间隙 14–17 处 `resumeLoop` 是接受的，不是拒绝的

brief 写「每个中间态都让 `resumeLoop` 拒绝」。实测：间隙 14、15、16、17（两组 fixture 都一样）处三个
文件已经全部发布，事务已过提交点，`resumeLoop` **接受**，而且接受是正确行为——在那里断言拒绝就是把 bug
钉成规范。我按实测事实写断言，并在测试注释与本报告里显式标注了这条边界；测试名按 brief 逐字保留，
但它字面上覆盖的是间隙 1–13。**如果计划的本意是这四格也必须拒绝，那说明的是生产代码需要改，不是测试
需要改，那已经超出 A5 的「test only」范围。**

### 关切 2（**必须由人裁定**）：判据 B 也只有双转移 fixture 杀得掉，首发 fixture 杀不掉

brief 写「判据 B『整条删掉』这个变异任何单转移场景都能杀」。实测相反（§5.4）：首发转移 fixture 的
17 个间隙里，判据 B **从来不成立、因而从来不决定结果**（**修复轮 2 更正**：先前这里写「一次都没有被求值」，
那比事实更强也自相矛盾——`evaluateResumeEligibility` 只有八条判据全部跑完才返回 `{ ok: true }`，判据 B 是
第六条，所以首发间隙 14–17 处它确实被求值了、只是通过；间隙 1–13 处才是闸门没进、未被求值）。
结构性原因与 brief 自己给判据 A 的论证是同一条：
`resumeLoop` 的 `Promise.all` 里 `readOwnerRecord` 是**经恢复**的读，另外两条是**未经恢复**的裸读；
首发转移下未经恢复的 `owner-transfer.json` 要么不存在（读就抛，进不了闸门），要么已经等于恢复后的
owner epoch。于是：

| 变异 | 首发 fixture | 双转移 fixture |
|---|---|---|
| 判据 A 整条删掉 | 存活（brief 预期一致） | **击杀**（间隙 8–13） |
| 判据 B 整条删掉 | **存活（与 brief 预期相反）** | **击杀**（间隙 5–7） |

也就是说**两条 epoch 判定都只有双转移 fixture 承重**，首发 fixture 承重的是另一件事：证明首发转移下
闸门根本到不了（这正是判据 A 存活的原因，也是 A6 的第三组 fixture 存在的前提）。首发 fixture 并非
无用，但它不是任何一条 epoch 判定的杀伤面。**这可能意味着计划里给 A6 的分工需要重排。**

### 关切 3：判据 B 的击杀依赖一个并发读窗口

间隙 5–7 之所以只被判据 B 拒绝，是因为 `resumeLoop` 的 `Promise.all` 里 `readOwnerRecord`（跑完恢复，
读到 e3）与 `readOwnerTransferRecord`（同一 tick 发出的裸 `readFile`，读到恢复前的 e2）之间的交错。
这个交错在实现上是稳的（裸读是 1 次 fs 往返，恢复要串行走 8 次以上才轮到那次 rename），实测 6 次运行
全部一致，但它**是一个竞态而不是一个顺序保证**。若将来把 `resumeLoop` 的读改成串行、或让
`readOwnerTransferRecord` 也走恢复，这三格会翻成 `accepted`，测试会红——那时红的是对的，说明判据 B
的可达形状消失了，需要重新论证它是不是死代码。已在测试注释里写明。

### 关切 4：同一发布三元组内的三步崩溃后不可区分

间隙 5/6/7、8/9/10、11/12/13 各自三行字面相同：catch 块会删掉三个 `.publish.tmp`，所以
「unlink temp 失败」「writeFile temp 失败」「rename 失败」留下的可观测磁盘残留是同一个。
矩阵仍然逐格注入、逐格观测（17 次注入货真价实），但这三步之间没有可断言的差异。如实记录。

### 关切 5：`progress.md` 有一处不属于本任务的未提交改动

`git status --short` 里的 `.superpowers/sdd/.../progress.md` 是控制者在派发我之前写的
「SESSION 2 RESUMED HERE」段落，我没有碰它，也没有把它纳入本次提交（提交只含
`tests/persistence/fileStore.test.ts`）。

---

# 修复轮 1（Fix round 1 of 5）— 提交 `88dea3c`

评审判定 Needs fixes，三条 finding + 一条证据形式要求 + 四次变异重跑。全部已处理。
本轮所有验证仍是 `export ECC_GATEGUARD=off DISABLE_OMC=1` 后用 `rtk proxy "<cmd>"` 绕过 rtk hook，
输出未过滤。

## F1（Important）— `publishedEpoch` 会把「撕裂的已发布文件」渲染成 `absent`

**改了什么**：`tests/persistence/fileStore.test.ts` 的 `publishedEpoch` 由「`readFile` + `JSON.parse`
共用一个 flat catch → `absent`」改为**嵌套 try/catch**：读失败 → `absent`，读到了但 parse 失败 →
`torn`。与几行之下 `crashSnapshot` 的 marker 分支同构。

**为什么重要（照抄评审的判断，我确认属实）**：若将来把某个发布用的 `rename` 换成非原子 `writeFile`，
崩在写一半会留下撕裂的 `owner-transfer.json`；旧写法把它渲染成 `T=absent`，而这正是首发 fixture 间隙
5–7 已经期望的字符串——34 行矩阵会原样全绿，回归静默通过。

**回归检查**：评审要求「若有任何一行期望值因此改变就停下上报」。**没有任何一行改变**——修完之后测试 2
直接绿（见 §实验 1 的注入前绿块，`TEST_EXIT=0`）。即当前 17×2 个间隙里没有一个产生 `torn`，这与
「三个发布点全部走 `rename`」一致。

## F2（Important，人已裁定）— 重命名测试

旧名 → 新名（逐字）：

```
fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives
```

三个分句各自的可失败断言：

1. **"refuses resume at every pre-commit crash gap"** → 间隙 1–13（两组 fixture 共 26 行）的
   `resume=refused: <具体理由>` 字段。变异实验 2 与 4 实测可失败（共 9 行翻成 `accepted`）。
2. **"commits idempotently past it"** → 间隙 14 的 `recovery=ok` +
   `after T=eN O=eN R=eN M=absent P=---`（marker 尚在 → 幂等重发布并回收 marker 与三个 pending），
   以及间隙 15–17 的 `after` 快照字符串与崩溃快照字符串**完全相等**（marker 已无 → 零写读，`lockHeld` 未传不走
   cleanup，残留原样存活）。任何一处「无 marker 时也去清理」的改动都会把 `P=TOR`/`-OR`/`--R` 变成
   `P=---`，这三行立刻红。**修复轮 2 更正**：此处先前写作「逐字节相等」，超出了观测面——快照渲染的是
   文件存在性、每个文件一个 epoch 字段、以及 marker/pending 的存在位，**不做逐字节内容比对**。这一句
   钉住的是存在性与 epoch 层面的幂等，不是字节层面的。测试注释已同步改正。
3. **"finishes recovery wherever the marker survives"** → 间隙 5–14 的 `recovery=ok`，对照间隙 1–4 的
   `recovery=throws OwnerTransferMarkerUnreadableError` / `throws OwnerTransferPendingMissingError`
   （marker 在但事务不可判定 → 必须 fail-closed，不许推完）。

同时改了测试上方注释里那段「为名字道歉」的话：现在正面陈述 14–17 为什么接受，以及它们承载的是
第二个分句，不再有「名字覆盖不到」的措辞。**保留**了「为什么 14–17 接受」的解释。

**连带后果已执行**：上文 §5 的四次变异证据全部作废（`-t` 引的是旧名），已按新名整体重跑，见下。

## F3（Important，人已裁定）— 计划就地标注

改 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`，**只动 `### Task A5`
一节**，按本仓 `**Amended <date> (x)**` 惯例（先例：`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md`）。
原文一字未删，注记贴在旁边。两处：

1. **测试要求 → 判据 B 那一条**：新增 `**Amended 2026-08-02 (a)：「任何单转移场景都能杀」这个前提是假的，A5 实测证伪。**`
   注记内容包含：前提为假、A5 实测（指向本报告第 3 次变异实验的原始输出）、结构原因
   （`resumeLoop` 的 `Promise.all` 里 `readOwnerRecord` 经恢复、另两条裸读；首发下
   `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` 永不成立；唯一本可能咬到的形状
   间隙 8–10 被 `reconciliation-record.json` 仍缺失遮住，`readReconciliationRecord` 先抛、闸门没进）、
   以及结论「磁盘层面判据 B 与判据 A 一样只由双转移 fixture 承重」。并明确 `!==` → `<` 那半句不受影响。
2. **Steps → Step 5 第 3 条**：新增同一编号的 `Amended 2026-08-02 (a)` 注记，写明实测不红=变异存活是
   预期结果、这一条与第 1 条同类（贴原始输出作证据而非击杀）、真正杀掉判据 B 的是第 4 条。并对
   紧随其后那行「第 2、3 两条走完整三步判据」加了一句连带更正：走完整三步的是**第 2、4**。

计划文件此前无任何 `Amended` 标记（`grep -nF 'Amended' <plan>` → exit 1），所以本次是该文件的
修订 (a)。Global Constraints 与其他任务的正文一个字未动。

## 四次变异实验，四次独立运行，全部对着新测试名

单跑命令模板（`$TNAME` = 上面那个新全名）：

```
ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t "$TNAME"
```

注入点全部在 `src/controller/resumeLoop.ts` 的 `evaluateResumeEligibility` 生产判据上，整条 `if` 删掉。
每次实验独立走「计数守卫 → 注入前单跑绿 → 注入 → 注入后单跑 → 还原 → 守卫 + `git status --short src/`」。
测试内两组 fixture 的矩阵各由一条 `expect.soft` 断言，所以**每一次运行都会同时报出两组 fixture 的判决**：
某组没有出现在失败 diff 里，就是该组在这个变异下被求值过且完全相等（＝存活）。

### 实验 1：判据 A 整条删掉 × 首发转移 fixture → 预期非击杀

```
=== EXPERIMENT 1 :: PRE-INJECTION GREEN (criterion A x first-transfer fixture) ===
8

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 498ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 498ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  14:54:23
   Duration  998ms (transform 203ms, setup 0ms, collect 233ms, tests 498ms, environment 0ms, prepare 43ms)

TEST_EXIT=0
```

```
=== EXPERIMENT 1 :: POST-INJECTION (criterion A deleted) x first-transfer fixture ===
7

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (68 tests | 1 failed | 67 skipped) 667ms
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 666ms
     → expected [ …(17) ] to deeply equal [ …(17) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives
AssertionError: expected [ …(17) ] to deeply equal [ …(17) ]

- Expected
+ Received

  Array [
    "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
    "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
    "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
    "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
    "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
    "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
    "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
  ]

 ❯ tests/persistence/fileStore.test.ts:2215:80
    2213|       ]);
    2214| 
    2215|       expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCra…
       |                                                                                ^
    2216|         // Gaps 1..4: the published triple is internally consistent at…
    2217|         // on its own. The refusal comes only from recovery refusing t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  14:54:42
   Duration  1.11s (transform 169ms, setup 0ms, collect 201ms, tests 667ms, environment 0ms, prepare 33ms)

TEST_EXIT=1
```

**判决：非击杀（存活）**。这次运行里唯一的失败 diff 落在 `:2215`，即**双转移** fixture 那条
`expect.soft`；**首发** fixture 的矩阵被求值且 17 行全等，没有产生任何 diff。理由与 brief 对判据 A 的
论证一致：首发转移下闸门根本进不去（间隙 1–13 的 `resume` 字段清一色
`refused: cannot read run artifacts`），判据 A 在这 13 格未被求值；余下的间隙 14–17 闸门进了、判据 A
被求值并通过。两段合起来，判据 A 在首发 fixture 下从不决定结果。（**修复轮 2 更正**：此处先前写作
「零次求值」。）

还原证明：

```
=== EXPERIMENT 1 :: REVERT PROOF ===
8
(zero lines above = src clean)
```

### 实验 2：判据 A 整条删掉 × 双转移 fixture → 必红

```
=== EXPERIMENT 2 :: PRE-INJECTION GREEN (criterion A x double-transfer fixture) ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 551ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 551ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  14:55:03
   Duration  1.00s (transform 182ms, setup 0ms, collect 217ms, tests 551ms, environment 0ms, prepare 41ms)

TEST_EXIT=0
```

```
=== EXPERIMENT 2 :: POST-INJECTION (criterion A deleted) x double-transfer fixture ===
7

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (68 tests | 1 failed | 67 skipped) 610ms
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 609ms
     → expected [ …(17) ] to deeply equal [ …(17) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives
AssertionError: expected [ …(17) ] to deeply equal [ …(17) ]

- Expected
+ Received

  Array [
    "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
    "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
    "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
    "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
    "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
    "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
    "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
  ]

 ❯ tests/persistence/fileStore.test.ts:2215:80
    2213|       ]);
    2214| 
    2215|       expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCra…
       |                                                                                ^
    2216|         // Gaps 1..4: the published triple is internally consistent at…
    2217|         // on its own. The refusal comes only from recovery refusing t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  14:55:21
   Duration  1.06s (transform 194ms, setup 0ms, collect 225ms, tests 610ms, environment 0ms, prepare 43ms)

TEST_EXIT=1
```

**判决：击杀**。双转移间隙 8–13（`T=e3`、`R=e2`、owner record 读到 e3）——判据 B 通过、只有判据 A 拒绝；
删掉判据 A 后这六格翻成 `resume=accepted`。三步齐全：注入前绿 + 注入后红 + 两份原始输出。

还原证明：

```
=== EXPERIMENT 2 :: REVERT PROOF ===
8
(zero lines above = src clean)
```

### 实验 3：判据 B 整条删掉 × 首发转移 fixture → **实测非击杀**（计划勘误的证据）

```
=== EXPERIMENT 3 :: PRE-INJECTION GREEN (criterion B x first-transfer fixture) ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 521ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 520ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  14:55:38
   Duration  959ms (transform 181ms, setup 0ms, collect 213ms, tests 521ms, environment 0ms, prepare 43ms)

TEST_EXIT=0
```

```
=== EXPERIMENT 3 :: POST-INJECTION (criterion B deleted) x first-transfer fixture ===
7

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (68 tests | 1 failed | 67 skipped) 530ms
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 529ms
     → expected [ …(17) ] to deeply equal [ …(17) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives
AssertionError: expected [ …(17) ] to deeply equal [ …(17) ]

- Expected
+ Received

  Array [
    "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
    "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
    "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
    "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
-   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
    "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
    "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
  ]

 ❯ tests/persistence/fileStore.test.ts:2215:80
    2213|       ]);
    2214| 
    2215|       expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCra…
       |                                                                                ^
    2216|         // Gaps 1..4: the published triple is internally consistent at…
    2217|         // on its own. The refusal comes only from recovery refusing t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  14:55:51
   Duration  1.11s (transform 180ms, setup 0ms, collect 212ms, tests 530ms, environment 0ms, prepare 40ms)

TEST_EXIT=1
```

**判决：非击杀（存活）——这是计划勘误 `Amended 2026-08-02 (a)` 的原始证据。** 唯一的失败 diff 仍落在
`:2215` 的**双转移**矩阵；**首发**矩阵 17 行被求值且全等，未产生任何 diff。结构原因（评审已独立复核）：
`src/controller/resumeLoop.ts` 的 `Promise.all` 里 `readOwnerRecord` 是经恢复的读，
`readOwnerTransferRecord` / `readReconciliationRecord` 是裸读；首发转移下
`ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` 永不成立，唯一本可能咬到的形状
（间隙 8–10：`owner-transfer.json` 已发布、`owner-record.json` 尚未发布）被
`reconciliation-record.json` 仍然缺失遮住——`readReconciliationRecord` 先抛，resume 在进闸门前就拒绝。
**判据 B 在全部 17 个首发间隙里从不成立、因而从不决定结果**：间隙 1–13 闸门没进故未被求值，间隙 14–17
闸门进了、判据 B 被求值并通过（这四格记的正是 `resume=accepted`）。（**修复轮 2 更正**：此处先前写作
「被求值 0 次」，那比事实更强，且可能被后来的读者当成「单转移下判据 B 不可达、可以删」的依据。）

还原证明：

```
=== EXPERIMENT 3 :: REVERT PROOF ===
8
(zero lines above = src clean)
```

### 实验 4：判据 B 整条删掉 × 双转移 fixture → 必红

```
=== EXPERIMENT 4 :: PRE-INJECTION GREEN (criterion B x double-transfer fixture) ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 486ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 485ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  14:56:07
   Duration  907ms (transform 169ms, setup 0ms, collect 204ms, tests 486ms, environment 0ms, prepare 35ms)

TEST_EXIT=0
```

```
=== EXPERIMENT 4 :: POST-INJECTION (criterion B deleted) x double-transfer fixture ===
7

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (68 tests | 1 failed | 67 skipped) 525ms
   × fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 524ms
     → expected [ …(17) ] to deeply equal [ …(17) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives
AssertionError: expected [ …(17) ] to deeply equal [ …(17) ]

- Expected
+ Received

  Array [
    "gap 01 | T=e2 O=e2 R=e2 M=unparseable P=TOR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferMarkerUnreadableError | after T=e2 O=e2 R=e2 M=unparseable P=TOR",
    "gap 02 | T=e2 O=e2 R=e2 M=v2 P=-OR | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=-OR",
    "gap 03 | T=e2 O=e2 R=e2 M=v2 P=T-R | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=T-R",
    "gap 04 | T=e2 O=e2 R=e2 M=v2 P=TO- | resume=refused: cannot read run artifacts | recovery=throws OwnerTransferPendingMissingError | after T=e2 O=e2 R=e2 M=v2 P=TO-",
-   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
-   "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=refused: published eligibility has been superseded by a newer owner epoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 05 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 06 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
+   "gap 07 | T=e2 O=e2 R=e2 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 08 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 09 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 10 | T=e3 O=e2 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 11 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 12 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 13 | T=e3 O=e3 R=e2 M=v2 P=TOR | resume=refused: reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 14 | T=e3 O=e3 R=e3 M=v2 P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=---",
    "gap 15 | T=e3 O=e3 R=e3 M=absent P=TOR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=TOR",
    "gap 16 | T=e3 O=e3 R=e3 M=absent P=-OR | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=-OR",
    "gap 17 | T=e3 O=e3 R=e3 M=absent P=--R | resume=accepted | recovery=ok | after T=e3 O=e3 R=e3 M=absent P=--R",
  ]

 ❯ tests/persistence/fileStore.test.ts:2215:80
    2213|       ]);
    2214| 
    2215|       expect.soft(await observeCrashMatrix(stageDoubleOwnerTransferCra…
       |                                                                                ^
    2216|         // Gaps 1..4: the published triple is internally consistent at…
    2217|         // on its own. The refusal comes only from recovery refusing t…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  14:56:19
   Duration  973ms (transform 175ms, setup 0ms, collect 209ms, tests 525ms, environment 0ms, prepare 38ms)

TEST_EXIT=1
```

**判决：击杀**。双转移间隙 5–7（盘上 `T=e2 R=e2` 自洽 → 判据 A 通过；恢复把 owner record 推到 e3 →
只有判据 B 拒绝）。删掉判据 B 后这三格翻成 `resume=accepted`。三步齐全。

最终还原证明与守卫：

```
=== EXPERIMENT 4 :: REVERT PROOF / FINAL GUARD ===
8
(zero lines from both git commands = src byte-identical to HEAD)
```

（`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` → **8**；
`rtk proxy "git status --short src/"` 与 `rtk proxy "git diff --stat src/"` 都是零行输出。）

### 四次实验汇总

| 实验 | 变异 | fixture | 判决 | 落点 |
|---|---|---|---|---|
| 1 | 判据 A 整条删掉 | 首发转移 | 非击杀（存活） | 间隙 1–13 闸门未进；14–17 求值但通过 |
| 2 | 判据 A 整条删掉 | 双转移 | **击杀** | 间隙 8–13 |
| 3 | 判据 B 整条删掉 | 首发转移 | 非击杀（存活）→ 计划勘误 (a) | 间隙 1–13 闸门未进；14–17 求值但通过 |
| 4 | 判据 B 整条删掉 | 双转移 | **击杀** | 间隙 5–7 |

## 全套件 + typecheck + build（修复轮后，未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1
$ rtk proxy "npm test -- --run"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 403ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 140ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 26ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 40ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/persistence/fileStore.test.ts (68 tests) 1778ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1456ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-Lgh1Nx/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-0gNgQ2/run-1  observed 2026-08-02T06:56:40.984Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/cli/cli.test.ts (15 tests) 422ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 23ms
 ✓ tests/controller/resumeLoop.gate.test.ts (17 tests) 6ms
 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2449ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 347ms
   ✓ resumeLoop > lets an eligible resume through an expired lease and records the observation 314ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 280ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2506ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 672ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 536ms
   ✓ render-contract CLI > rejects a non-git repository path 651ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 638ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3160ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 367ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 354ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 337ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 390ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 419ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 357ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 322ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 496ms
 ✓ tests/validation/fixture.test.ts (2 tests) 524ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 522ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6542ms
   ✓ lease heartbeat lifecycle > releases the lease after a resume completes 309ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 584ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 577ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 616ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 460ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 367ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 369ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 363ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 362ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9291ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 505ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 388ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 372ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 386ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 372ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 391ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 377ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 375ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 412ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 348ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 343ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 345ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 349ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 345ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 515ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 368ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 495ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 485ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 347ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 527ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 373ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10211ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 350ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 765ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15602ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1503ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1238ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2528ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1511ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1512ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1511ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 561ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 559ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 577ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 912ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 567ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2453ms

 Test Files  29 passed (29)
      Tests  463 passed (463)
   Start at  14:56:38
   Duration  16.19s (transform 2.05s, setup 0ms, collect 3.33s, tests 53.45s, environment 3ms, prepare 1.55s)

TEST_EXIT=0
```

29 个测试文件全部列出，无省略；两条允许的 flake (B) 与 (F) 都是 `✓`；名单外零失败。

```
$ rtk proxy "npm run typecheck"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

## 报告本体的两处更正（评审要求）

- **§2 的 17 步序列**：原先写成「实测打印」却没有贴出产生它的原始输出（那条探针测试当时已删）。
  已改写为**从三段已贴出的 grep 原始输出推导**，并写出推导链，去掉「实测」二字；同时说明这段序列不是
  要求评审接受的证据，而是被矩阵的 17 行磁盘快照钉住的结论。
- **§4 的措辞**：原句「冒烟断言断的不是 fixture 自己写下去的值」照字面读不成立——`O=e1` 就是
  `writeOwnerRecord` 写下去的起始 epoch。已改为准确说法：被断言的对象里只有 `O=e1` 一个字段是输入项，
  marker 的 `finalizeOrder`、三个 pending 的 epoch、双转移的三个已发布值全部是被测代码的产出，因此
  「先写再断同一个值」的空断言模式不成立。

## 本轮改动的文件

- `tests/persistence/fileStore.test.ts`：`publishedEpoch` 嵌套 try/catch + `torn`；测试重命名；
  上方注释改写（第二分句正面陈述，不再为名字道歉）。
- `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`：`### Task A5` 一节内
  两处 `Amended 2026-08-02 (a)` 就地标注（另加一句对「第 2、3 两条走完整三步」的连带更正）。
- `src/`：**零改动**（四次注入全部还原，守卫 = 8，两条 git 命令零行输出）。
- 本报告文件：§2 / §4 更正 + 本节。

提交：`88dea3c test(transaction): distinguish a torn publish from an absent one, rename test 2 to match its pre-commit scope`

## 本轮证据形式自查

写下这句之前我从头翻了一遍本节：8 个 vitest 输出块每一个都含 `RUN` 头、结果行、`Test Files`、`Tests`、
`Start at`、`Duration`，并各自回显 `TEST_EXIT`；`typecheck_exit` / `build_exit` 都在；全套件块 29 个文件
逐行列全。**我没有删掉任何一行输出。** 唯一出现的省略号是 vitest 自己渲染的 `…(17)` 与错误帧里被
vitest 截断的源码行，逐字保留。

## 本轮遗留关切

1. **判据 B 的击杀依赖并发读窗口**（原 §8 关切 3，仍然成立且未被本轮改动触及）：双转移间隙 5–7 之所以
   只被判据 B 拒绝，靠的是 `readOwnerRecord`（经恢复，读到 e3）与同一 tick 发出的裸
   `readFile(owner-transfer.json)`（读到 e2）之间的交错。实现上稳定（裸读 1 次 fs 往返 vs 恢复 8 次以上
   串行），本轮 8 次运行全部一致，但它是竞态不是顺序保证。若将来把 `resumeLoop` 的读改成串行，这三格会
   翻成 `accepted`、测试会红——那时红是对的，说明判据 B 的可达形状消失，需要重新论证它是否成了死代码。
   已写在测试注释里。
2. **同一发布三元组内的三步崩溃后不可区分**（原 §8 关切 4）：间隙 5/6/7、8/9/10、11/12/13 各自三行字面
   相同，因为 catch 会删掉三个 `.publish.tmp`。17 次注入货真价实，但这三步之间没有可断言的差异。

---

# 修复轮 2（Fix round 2 of 5）— 提交 `86d0d34`

三条文本准确性更正，落在永久制品上。**未动矩阵、未动 fixture、未动 `src/`**，无任何逻辑改动。
验证仍是 `export ECC_GATEGUARD=off DISABLE_OMC=1` 后 `rtk proxy "<cmd>"`，输出未过滤。

## 1. 计划勘误的标题句写错了——纠正为「从不成立」，不是「从不被求值」

**问题**：`Amended 2026-08-02 (a)` 的标题句写「判据 B ……**一次都没有被求值**」。这是假的。
`src/controller/resumeLoop.ts` 的 `evaluateResumeEligibility` 要**八条判据全部跑完**才返回 `{ ok: true }`，
判据 B 是其中第六条；而首发转移 fixture 的间隙 14–17 在矩阵里记的正是 `resume=accepted`，
说明闸门进了、八条判据全跑了——**判据 B 在那四格确实被求值了，只是通过**。该注记里另一句
（「`ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` 永远不成立」）本来就是准确的，
于是注记在自己的标题句上自相矛盾。

**改法**（`docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`，仍只在
`### Task A5` 一节内，原文一字未删）：

- 判据 B 那条注记的标题句改为「**从来不成立、因而从来不决定结果**」，并显式加了一句警告：
  「这里的措辞要精确，不能读成『判据 B 在单转移下不可达』——那比事实更强，会给『把它删掉』提供借口」。
- 并按评审建议补上那一个从句，把两段分清楚：**间隙 1–13 闸门没进**（`Promise.all` 里某条裸读先抛，
  `resumeLoop` 在 `evaluateResumeEligibility` 之前就拒绝），判据 B **未被求值**；
  **间隙 14–17 闸门进了**，判据 B **被求值并通过**。两段合起来才是「删掉它对首发 fixture 的 17 行矩阵
  零影响」的完整理由。
- Step 5 第 3 条那处注记里的「（首发转移下判据 B 零次求值）」同样改为
  「（首发转移下判据 B 从不成立、因而从不决定结果；间隙 1–13 闸门没进故未求值，间隙 14–17 求值了但通过）」。

**机制部分一字未改**：经恢复读 vs 裸读的不对称、间隙 8–10 被仍然缺失的 `reconciliation-record.json`
遮住——这两条评审已独立复核为正确。

**本报告里同一处错误也一并更正**（都就地标注了「修复轮 2 更正」）：§8 关切 2、修复轮 1 的实验 1 与
实验 3 判决段、以及四次实验汇总表的第 1、3 行。**唯一没有改写的是已作废的 §5 里的同类措辞**——那一节
按评审要求原样保留作历史，改由该节顶部的取代标记统一声明其措辞已被本轮更正取代。

## 2. 报告 §1 与 §5 加了就地取代标记（旧证据块原样保留）

**问题**：§1 用改名前的名字声明测试 2，§5 的 `-t` 命令块与四份初版原始输出也都引旧名，而「已作废」的
声明只出现在文件很靠后的修复轮 1 一节。读者落在 §1 会带走一个代码树里根本不存在的测试名。

**改法**（不删、不改写任何历史输出块）：

- **§1**：测试 2 那一条加「**名字已被取代，见紧随其后的说明**」，并在该列表后插入一段引用块：
  声明这是初版名、当前代码树里不存在、人在修复轮 1 裁定改名、给出现行全名、并指向修复轮 1 的 F2 一节。
- **§5 标题**：改为「四次变异实验（**本节全部证据已作废，仅作历史保留**）」，标题下插入引用块：
  声明本节所有 `-t` 命令与四份原始输出引的都是初版名；这些输出是当时真实跑出来的，**逐字保留、不做
  改写**，但不要拿它们当现行证据；现行证据是修复轮 1 里对着新名重跑的**八次独立运行**；并声明本节
  分析文字里的「零次求值 / 一次都没有被求值」措辞已被修复轮 2 的更正取代。

## 3. 测试注释不再声称字节级幂等

**问题**：测试 2 头部注释写间隙 14 「republishes identical bytes」、间隙 15–17 的残留
「must survive byte-exact」。而可观测面只有渲染出来的快照字符串：**文件存在性、每个文件一个 epoch
字段、marker 与三个 pending 的存在位**。那是存在性与 epoch 层面的幂等，不是字节层面的。

**改法**（`tests/persistence/fileStore.test.ts`，测试 2 头部注释）：去掉 `identical bytes` 与
`byte-exact` 两处措辞，改为 `republishes` / `the residue survives unchanged`，并补一句明写观测面上限：

```
//     What the snapshot actually observes, and therefore all this clause pins, is presence and
//     epoch: which of the three files exist and what epoch each carries, whether the marker is
//     there (and parses), and which pendings remain. It does NOT compare file contents byte for
//     byte, so a republish that rewrote a field the snapshot does not render would pass here.
```

报告修复轮 1 的 F2 一节里同一处「逐字节相等」也一并更正为「快照字符串完全相等」，并就地标注了
观测面上限。

## 验证（未过滤）

### 覆盖测试单跑（现行全名）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1
$ export TNAME='refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives'
$ rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t '$TNAME'"

=== ROUND 2 :: COVERING TEST ALONE ===

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (68 tests | 67 skipped) 514ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 513ms

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  15:13:48
   Duration  1.00s (transform 199ms, setup 0ms, collect 230ms, tests 514ms, environment 0ms, prepare 40ms)

TEST_EXIT=0
```

同一次调用里的守卫与 `src/` 洁净证明：

```
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
$ rtk proxy "git status --short src/"
SRC_STATUS_EXIT=0
```

（`git status --short src/` 输出零行，退出码 0：`src/` 与 HEAD 完全一致。）

### 全套件

```
$ rtk proxy "npm test -- --run"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 398ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 152ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 28ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 32ms
 ✓ tests/persistence/fileStore.test.ts (68 tests) 1662ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1326ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-mczc5j/does-not-exist'

 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-1i3vSj/run-1  observed 2026-08-02T07:14:03.430Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 374ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 17ms
 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2288ms
 ✓ tests/controller/resumeLoop.gate.test.ts (17 tests) 5ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 261ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3076ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 369ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 313ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 359ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 428ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 423ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 308ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 464ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2505ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 630ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 567ms
   ✓ render-contract CLI > rejects a non-git repository path 628ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 669ms
 ✓ tests/validation/fixture.test.ts (2 tests) 562ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 559ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6554ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 552ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 605ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 579ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 482ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 392ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 382ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 400ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 370ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10198ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 358ms
   ✓ runLoop > stops immediately when a stopOn signal matches 303ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 725ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 11402ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 1721ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 757ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 484ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 387ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 358ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 349ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 361ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 436ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 349ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 375ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 384ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 380ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 367ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 384ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 510ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 510ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when execute is interrupted 317ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 511ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 502ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 395ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 537ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 390ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15817ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1392ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1206ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2478ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1547ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1518ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1533ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 599ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 592ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 593ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 1034ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 612ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2510ms

 Test Files  29 passed (29)
      Tests  463 passed (463)
   Start at  15:14:00
   Duration  16.41s (transform 2.06s, setup 0ms, collect 3.32s, tests 55.38s, environment 4ms, prepare 1.52s)

TEST_EXIT=0
```

29 个测试文件全部列出；两条允许的 flake (B) 与 (F) 都是 `✓`；名单外零失败。

### typecheck 与 build

```
$ rtk proxy "npm run typecheck"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

## 本轮改动的文件

- `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`：`### Task A5` 一节内
  两处 `Amended 2026-08-02 (a)` 注记的措辞更正（标题句 + Step 5 第 3 条的括注）。原文仍一字未删。
- `tests/persistence/fileStore.test.ts`：测试 2 头部注释去掉 `identical bytes` / `byte-exact`，
  改写为快照实际观测的层面并明写上限。**代码零改动**（矩阵、fixture、辅助函数全未动）。
- 本报告文件：§1 与 §5 的取代标记；§8 关切 2、修复轮 1 实验 1 与实验 3 判决段、汇总表第 1/3 行的
  「求值」措辞更正；修复轮 1 的 F2 一节「逐字节相等」更正；本节。
- `src/`：**零改动**（守卫 `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` = 8，
  `git status --short src/` 零行输出）。

提交：`86d0d34 docs(sdd): correct the criterion-B erratum's headline and the idempotence comment's scope`

## 本轮证据形式自查

写下这句之前我从头翻了一遍本节：3 个 vitest / npm 输出块每一个都含调用命令、完整输出、
`Test Files` / `Tests` / `Start at` / `Duration`（全套件与单跑）以及回显的 `TEST_EXIT` /
`typecheck_exit` / `build_exit`；全套件块 29 个文件逐行列全。**我没有从任何一段被贴出的输出里删掉
过一行。** 本节文字里出现的 `...` 只有这一处，是在引用这个符号本身，不是省略。

## 本轮新增的一条关切

计划原文第 592 行（**不是我的注记，是计划的原始文字**）对判据 A 用了同一种过强措辞：
「**判据 A 根本没被求值，变异存活**」。按本轮同一条推理，那也不准确——首发转移 fixture 的间隙 14–17
闸门进了，判据 A（第四条判据）同样被求值并通过。我**没有改**它，因为本轮指令明确要求只动我自己的
注记、不得改写计划原文。**建议由控制者决定是否补一条针对判据 A 的同类勘误**，否则同一个「不可达 →
可以删」的误读风险在判据 A 上原样存在。
