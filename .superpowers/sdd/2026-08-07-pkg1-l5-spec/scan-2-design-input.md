# 扫描员 2 报告 —— L5 设计输入的现状核验（只读）

日期：2026-08-07。状态：**骨架已落盘，各节待填。**

## 0. 结论（最先写）：起点今天还站得住吗？站不住的是哪几句？

**总判：起点大体站得住，但§10 第 4 条里有一句已被今天的代码证伪，且正是包 1 要拿来当量纲的那一句。**

- **站得住**：A1（临时名格式，设计文档原文对，台账压缩写法错）、A2（SIGKILL 窗口仍在）、
  A3（`ensureFreshRunDir` 仍是三具名文件 + 两目录）、A5（`RUN_MARKER_FILES` 仍五个）、
  A6（`OBSERVED_FILES` 仍三个）、A7（不阻塞初始化）。
  **「这是无界垃圾，不是故障，不要上报成缺陷」这条约束今天仍然成立** —— 我没有发现任何功能性破坏。
- **站不住 —— A4**：§10 第 4 条写 `cleanupOwnerTransferStagingWithoutMarker`「只清
  `getOwnerTransferPaths` 的**四个固定名**」。**今天是十个**（十次 `safeUnlink`，见 §1 A4）。
  §10 第 4 条的**结论**（这条清理路径够不着 `buildAtomicTempPath` 生成的名字）仍然成立，
  但**它引用的数字已过期**。包 1 若逐字抄这句「四个」，会把一个已过期的计数固化进 L5 的 spec。
- **A8（全称否定）**：在我验到的搜索面内（`src/` 全部 29 个文件），**没有任何按模式删除的代码**。
  但 *** 我明确不下无限定的全称否定 ***：`runLoop.ts` 用 `sh -lc` 执行契约里用户自带的
  `requiredChecks` 命令，那条命令的内容不在 `src/` 里，`src/` 的搜索面覆盖不到它（见 §1 A8）。
- **任务 D（`retained`）**：委任状路径与节号我已独立确认（**不是** run-registry 那份）。
  全仓今天**存在**若干「保留」侧的既有行为与既有约束（见 §4），不是一张白纸。
- **任务 C**：我的结论是 *** 无法判断防线是否兑现 ***，缺的东西写在 §3，不拿部分证据凑。

## 1. 任务 A：§10 第 4 条 A1–A8 逐条

被核对的原文（`awk '/^## 10\./,/^## 11\./' docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`；
该文件无 `## 11.`，awk 从 `## 10.` 打到文件尾，即第 4 条被完整覆盖）。

### A1 —— 临时文件名格式：**设计文档原文对，台账的压缩写法是错的（作为文件名格式而言）**

今天真正生成临时名的唯一函数是 `buildAtomicTempPath`（`src/persistence/fileStore.ts`），逐字：

```
const ATOMIC_TEMP_PROCESS_STAMP = `${process.pid}.${Math.trunc(performance.timeOrigin)}`;
let atomicTempPathSequence = 0;
export function buildAtomicTempPath(targetPath: string): string {
  atomicTempPathSequence += 1;
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`,
  );
}
```

重推命令：`grep -rn "tmp" src/ | grep -v "\.test\."` → 唯一的模板串在 `fileStore.ts:632`；
`grep -n "ATOMIC_TEMP_PROCESS_STAMP\|atomicTempPathSequence" -A 12 -B 12 src/persistence/fileStore.ts`。

**判定**：展开后文件名是 `.<basename>.<pid>.<trunc(timeOrigin)>.<seq>.tmp` —— **点分五段**。
§10 第 4 条写的 `.{basename}.{pid}.{startTime}.{seq}.tmp` **逐字正确**
（`startTime` = `Math.trunc(performance.timeOrigin)`，源码注释自己称之为 "start time"：
「A third and deliberately weaker form exists in acquireOwnerTransferLock (`pid:<pid>`, no
start time)」）。
台账／handoff 的 `.{basename}.{stamp}.{seq}.tmp` **只有四段，作为文件名格式是错的**。
⚠️ 但要公平地说：它错得有来历 —— 源码里那个常量就叫 `ATOMIC_TEMP_PROCESS_STAMP`，
`stamp` 在源码语汇里正好指 `pid.timeOrigin` 这一对。**所以这是一次有依据的有损转写，不是凭空编造**；
**包 1 的 spec 请用五段的源码原形，不要用台账的四段形。**

⚠️ 顺带：§4.1 的「**建议形式**」写的是 `.<basename>.<pid>.<单调递增序号>.tmp`（**四段，无 startTime**）。
实现比 §4.1 的建议更强（多了 timeOrigin，防 pid 回收），§4.1 自己写明「**不强制具体格式**」，
所以这不是偏离。但**仓库里同时存在三种写法（§4.1 四段建议 / §10 五段实录 / 台账四段压缩）**，
包 1 引用时必须指明引的是哪一种。

### A2 —— SIGKILL 窗口仍然存在：**成立**

`writeJsonFileAtomically`（`fileStore.ts`）逐字：

```
  const tempPath = buildAtomicTempPath(path);
  try {
    await writeFile(tempPath, serialized);
    await rename(tempPath, path);
  } catch (error) {
    ...
      await unlink(tempPath);
```

`unlink` 只在 **`catch` 里**。`SIGKILL` 不进 `catch`，进程直接消失，temp 留在原地。
且 `buildAtomicTempPath` 的名字含 pid 与 timeOrigin，**任何后来的进程都推不出这个名字**
——源码注释自己说：「that name is unrecoverable by any later process」（`fileStore.ts:1119` 附近）。
**成立。**

调用面（`grep -rn "writeJsonFileAtomically\|buildAtomicTempPath" src/`）：
`fileStore.ts:77`（`initializeRunFiles` 写 `loop-state.json`）、`:82`（`writeRunState`）、
`:446`（`boundary-analysis.json`）、`:497`、`:673`（`writeOwnerRecord`）—— **五处**，与 §2 的「五条路径」对得上。

### A3 —— `ensureFreshRunDir` 只挡三具名文件 + 两目录：**成立**

`grep -n "ensureFreshRunDir" -A 60 src/persistence/fileStore.ts` 逐字给出
`blockingPaths` = `loop-contract.json` / `loop-state.json` / `events.jsonl`（三条），
其后两个独立 `if (await directoryHasEntries(join(runDir, "attempts")))` 与 `"worktrees"`。
**三具名 + 两目录，与 §10 第 4 条一致。它不删任何东西，只抛错。**

### A4 —— 「只清四个固定名」：*** 已被证伪 —— 今天是十个 ***

```
awk '/^async function cleanupOwnerTransferStagingWithoutMarker/,/^}/' src/persistence/fileStore.ts \
  | grep -c "await safeUnlink"
→ 10
```

十次 `safeUnlink` 逐字为：`ownerPendingPath`、`transferPendingPath`、`reconciliationPendingPath`、
`ownerTempPath`、`transferTempPath`、`reconciliationTempPath`、`ownerPendingTempPath`、
`transferPendingTempPath`、`reconciliationPendingTempPath`、`transactionMarkerTempPath`。

`getOwnerTransferPaths` 今天返回 **15 个键**（`grep -n "getOwnerTransferPaths" -A 25`：
`ownerPath`/`transferPath`/`reconciliationPath` + 三个 `*TempPath` + 三个 `*PendingPath` +
`transactionMarkerPath`/`lockPath`/`transactionMarkerTempPath` + 三个 `*PendingTempPath`）。

**结论**：函数**仍然只按固定名删**（十个名字全部是 `fileStore.ts:528-539` 的模块级常量，
无一处模式匹配），所以 §10 第 4 条**要证的那件事仍然成立**：它够不着 `buildAtomicTempPath` 的名字。
**但「四个」这个数字今天是错的，实为十个。** 这正是任务 B1 的实质（见 §2）。

### A5 —— `RUN_MARKER_FILES` 仍是五个且不含临时名模式：**成立**

`grep -rn "RUN_MARKER_FILES" src/` → 只有 `src/registry/scanRuns.ts:30` 定义、`:87` 使用。逐字：

```
export const RUN_MARKER_FILES: readonly string[] = [
  "loop-contract.json", "loop-state.json", "events.jsonl",
  "owner-record.json", "owner-transfer.json",
];
```

五个字面量，`:87` 处 `for (const marker of RUN_MARKER_FILES) { if (await deps.dir.fileExists(...)) return true; }`
—— **精确文件名存在性检查，无通配、无后缀匹配**。临时名以 `.` 起首且带 `.tmp`，不在其中。**成立。**

### A6 —— `OBSERVED_FILES` 仍是三个：**成立**

`grep -c "^    file:" src/registry/observeFields.ts` → `3`，分别是
`loop-state.json`（:7）、`owner-record.json`（:29）、`owner-transfer.json`（:45）。
`src/registry/observeRun.ts:23` 用 `OBSERVED_FILES.map(...)` 逐条读，**不枚举目录**。**成立。**

### A7 —— 临时文件不会让 `ensureFreshRunDir` 拒绝初始化：**成立**

由 A3：阻塞判据是三个精确路径 + `attempts/`、`worktrees/` 两个**子目录**是否非空。
`buildAtomicTempPath` 把 temp 放在 `dirname(targetPath)`，即 run 目录根（或
`boundary-analysis.json` 所在目录），**不落进 `attempts/` 或 `worktrees/`**，也不叫那三个名字。**成立。**

### A8 —— *** 全称否定：`src/` 内没有按模式删除的东西 ***

**先声明搜索面**：`find src -type f | wc -l` → **29** 个文件，全部为 `.ts`，**我对这 29 个文件跑了下述检索**。

1. `grep -rn "unlink\|rmdir\|rm(\|rimraf\|readdir" src/` —— 全部命中如下，**未过滤**：
   - `src/controller/resumeLoop.ts:1,74`：`readdir(join(runDir, "worktrees"))` —— **只列不删**。
   - `src/persistence/fileStore.ts:39`：`(await readdir(path)).length > 0` —— `directoryHasEntries`，**只数不删**。
   - `src/persistence/fileStore.ts:655`：`await unlink(tempPath)` —— 删的是**本次调用自己刚建的那个精确路径**。
   - `src/persistence/fileStore.ts:753`：`safeUnlink` 的实现本体。
   - `src/registry/scanRuns.ts:46`：`readdir(path, { withFileTypes: true })` —— 扫描，**只列不删**。
   - `src/registry/renderRuns.ts:83`：注释里出现 `readdir` 一词。
   - `src/sweep/sweepRuns.ts:125`：注释里出现 `readdir` 一词。
   **没有 `fs.rm`、没有 `rmdir` 调用、没有 `rimraf`。**
2. `grep -rn "safeUnlink" src/` —— 22 处命中（含定义与两处注释），**每一处实参都是变量名，
   而这些变量无一例外来自 `getOwnerTransferPaths` 或 `FinalizeFileTarget.tempPath/pendingPath`，
   最终追溯到 `fileStore.ts:528-539` 的字符串常量**。**无一处按模式匹配。**
3. 外部命令面：`grep -rn "child_process\|execa\|spawn\|execFile\|exec(" src/`：
   - `src/workspace/worktreeManager.ts:25,30`：`git worktree add --detach` / `git worktree remove --force <worktreePath>`
     —— **删除一整个工作区目录，但按精确路径，不按模式**。⚠️ 这是 `src/` 内唯一会删除目录树的东西，
     包 1 设计 L5 时必须知道它已经存在。
   - `src/runtime/claude/subprocessClaudeAdapter.ts:25`：`spawn(file, args, ...)` 起 Claude 子进程。
   - `src/controller/runLoop.ts:169`：*** `await execFileAsync("sh", ["-lc", command], { cwd: worktreePath })` ***
     —— `command` 来自契约的 `requiredChecks`，**是用户自带的任意 shell 命令**。
   - `src/controller/runLoop.ts:499`：`git status --porcelain=v1 -z --untracked-files=all` —— 只读。
4. 依赖面：`cat package.json` —— `dependencies` 只有 `zod`；**没有 glob / fast-glob / del / rimraf 之类的库**。

*** 我的断言（带限定，不是无限定全称否定）***：
**在「`src/` 下 29 个 TypeScript 文件的源码文本」这个面上，没有任何按模式（通配符／正则／后缀）
枚举并删除文件的代码。删除全部是精确路径删除，共两类：`safeUnlink`／`unlink` 打常量名，
和 `git worktree remove --force` 打一个具体路径。**

*** 我没有覆盖的面（明写）***：
- `runLoop.ts:169` 的 `sh -lc` 会执行**契约里用户写的**命令。那段文本不在 `src/` 里，
  它完全可以是 `rm -rf *.tmp`。**「`src/` 内无按模式删除」不等于「本程序运行时不会按模式删除」。**
- 我**没有**检索 `tests/`、`scripts/`、`.superpowers/` 下的任何可执行物，也**没有**检索
  `dist/`（构建产物）。任务只问 `src/`，我据此限定。
- 我**没有**检查任何运行时之外的东西（CI 配置、宿主机 cron、`/tmp` 清理策略）。

### ⚠️ §10 第 4 条那条「定性」约束：**今天仍然成立，请勿在包 1 里偷偷升级**

原文逐字：「**定性要准确：这是无界垃圾，不是故障。**」「**不要把它上报成缺陷。**」
按 A5/A6/A7，我**没有找到**任何功能性破坏路径：残留的 `.xxx.tmp` 不会被认成 run 标记、
不会被 L2 读到、不会阻塞初始化。**我确认这条约束在今天仍然站得住。**
唯一的代价仍是原文说的「run 目录内文件数无上限增长」。

## 2. 任务 B：B1「残留面已扩大」/ B2「从未被勘误」各自重推

**两条我都是从 git 与源码重推的，没有引用任何台账句子。**

### B1 —— 「L3 把三份 pending 改原子写之后，残留面已扩大」：**成立，且我能给出确切数字**

**重推命令**（脚本落在
`/private/tmp/claude-501/.../scratchpad/count.sh`，内容为：对 `git log --reverse --format=%h -- src/persistence/fileStore.ts`
的每个提交跑
`git show "$c:$P" | awk '/^async function cleanupOwnerTransferStagingWithoutMarker/,/^}/' | grep -c "await safeUnlink"`）。
⚠️ 必须用 **bash** 跑：zsh 会把 `$c:src/...` 当成参数修饰符 `:s`，静默产出全 0 的假结果——我第一次就中了，
**这里记一笔，免得复核者重蹈**。

输出（未过滤，只截关键跃迁；完整 39 行在脚本里可复现）：

```
...
7a3490d  4  docs: correct the retry comment's atomicity claim at the maxAtte
0f940ea  7  feat(fileStore): publish the transaction marker and both pendings by temp+rename
dad8a14 10  feat(fileStore): make reconciliation-record.json the third file of the owner-transfer transaction
fb62714 10  ...（其后至 HEAD 一直是 10）
```

**答三问**：

1. **哪三份 pending？** `.owner-record.pending.json`、`.owner-transfer.pending.json`、
   `.reconciliation-record.pending.json`（常量 `OWNER_RECORD_PENDING_FILE` / `OWNER_TRANSFER_PENDING_FILE` /
   `RECONCILIATION_RECORD_PENDING_FILE`，`fileStore.ts:531-533`）。
   ⚠️ **严格说 L3 改的是四份而不是三份** —— 还有**事务标记** `.owner-transfer.transaction.json`。
   `grep -n "writeJsonFileViaFixedTemp" src/persistence/fileStore.ts` 给出**四个**调用点
   （`:1064` transferPending、`:1065` ownerPending、`:1068` reconciliationPending、`:1071` transactionMarker）。
   **「三份 pending」这个说法漏掉了 marker。**
2. **L3 具体把哪些写路径改成原子写？** `0f940ea` 的提交信息逐字：
   「switches `writeOwnerTransferArtifacts`'s staging section from bare `writeJsonFile` to it
   \[= `writeJsonFileViaFixedTemp`\]」，并自陈
   「`cleanupOwnerTransferStagingWithoutMarker` **grows from 4 to 7** `safeUnlink` calls
   (still an intermediate count; **A2 takes it to 10**)」。`dad8a14` 把
   `reconciliation-record.json` 变成事务的第三个文件，兑现了那个 10。
   ⚠️ 注意：这里用的是 `writeJsonFileViaFixedTemp`（**固定**临时名，可恢复），
   **不是** `writeJsonFileAtomically`（进程唯一名，不可恢复）。**两者在源码里被明确要求不许合并**
   （`fileStore.ts:1116-1119` 注释）。
3. **残留面从几条扩到几条？** 两个可数口径，我两个都给：
   - **清理口径**：`cleanupOwnerTransferStagingWithoutMarker` 的 `safeUnlink` 数 **4 → 7 → 10**（上表）。
   - **固定临时名口径**：`grep -n '\.tmp"' src/persistence/fileStore.ts` → **7** 个常量（今天）；
     `git show 7a3490d:src/persistence/fileStore.ts | grep -n '\.tmp"'` → **2** 个
     （`.owner-record.publish.tmp`、`.owner-transfer.publish.tmp`）。**2 → 7。**

**结论：「残留面已扩大」为真**，但要说清扩的是**哪一种**残留面：扩大的是**固定名、可被后来进程按名清理**
的那一类（2→7，且清理端同步从 4 涨到 10 全部盖住）。
*** §10 第 4 条关心的那一类残留（`buildAtomicTempPath` 的进程唯一名）数量没变，且**至今无人清理**。 ***
包 1 不要把这两类混为一谈 —— L3 扩大的那一面**是自带清理的**，L5 要接的是**没有清理的那一面**。

### B2 —— 「`2026-07-29-atomic-write-paths-design.md` 从未被勘误」：**在我确立的判别式下成立**

**我确立的判别式**（写明，供复核）：本仓库的**事后勘误**体例是在正文里插入 `Amended <日期>` 记号，
三种见到的形态：`Amended 2026-07-28 in eight places (a)–(h)`（`2026-07-28-run-registry-design.md:3`）、
`**Amended 2026-08-06 — note on the Status line above**`（同文件 `:7`）、
中文冒号形态 `**Amended 2026-08-02 (b)：...**`（`2026-08-02-sweep-and-transactional-continuation.md:49`）。
**共同的、可判别的不变量是字符串 `Amended`。** 我以它作判别式，并另加一层宽判别式兜底。

- 窄判别式：`grep -c "Amended" docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md` → **0**。
- 宽判别式：`grep -inE "amend|errat|勘误|订正|更正|作废|已过期|不再成立|已失效|Superseded|superseded|Correction" <同文件>`
  → 命中 10 行（`:28 :36 :38 :64 :117 :142 :150 :205 :212 :213 :270`）。
  ⚠️ **我逐条读了这些命中，它们没有一条是事后勘误**：全部是**定稿过程中对「初稿」的自我更正**
  （逐字如 `:36`「初稿把它排除了……**已更正**」、`:64`「初稿如此描述……**已更正**」、
  `:142`「初稿这里写了一个假前提，**已更正**」）或对行号的失效声明（`:28`「基线行号，**已失效**」）。
  **无一条带日期、无一条形如 `Amended <日期>`、无一条指向本分支合并之后发生的事。**
- 覆盖面佐证：`grep -rlnE "Amended" docs/` → **7 个文件**带勘误记号
  （`docs/handoff/handoff.md`、`plans/2026-08-02-...`、`plans/2026-07-27-...`、
  `specs/2026-07-28-run-registry-design.md`、`specs/2026-07-27-...`、`specs/2026-07-26-...`、
  `specs/2026-08-01-...`）—— **`2026-07-29-atomic-write-paths-design.md` 不在其中。**
- 时间线佐证（这条最有力）：
  `git log --follow --format='%h %ad %s' --date=short -- docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`
  → 9 个提交，**最后一个是 `2e30d1c`，日期 2026-08-01**。
  而把 A4 那个「四个」打成「十个」的两笔 L3 提交是 `0f940ea` 与 `dad8a14`，**日期均为 2026-08-02**。
  *** 该文档最后一次被碰，比推翻它那句话的代码变更早一天，此后再没被碰过。 ***

**结论：B2 成立。** 而且 B2 与 §1 的 A4 合起来正好解释了 A4 为什么会过期 ——
**这不是一次疏漏的重复，而是一条可预期的后果：文档冻结在 08-01，代码在 08-02 动了它引用的数字。**

*** 我没验的一面（明写）***：我只查了 `docs/` 与该文件自身的 git 历史。
**我没有检查**是否存在把勘误写在别处（例如某份台账、某个提交信息、某份 review 报告）而**不回写正文**的情况 ——
若本仓库允许「异地勘误」，我的判别式盖不住它。

## 3. 任务 C：§10 第 3 条是否兑现

**我的判定分三层，请分开读，不要合并成一句。**

### C-1 —— 上一轮 lane 2 的**前提是假的**：门报告落盘了

上一轮 lane 2 说「防线已用掉，是否兑现无法判断，**因为 GATE-A 的门报告没落盘**」。
*** 这个前提今天不成立。 *** `ls -la .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/`
给出五份门报告，全部在盘上：

```
gate-a-fix-wave-report.md   51.9K
gate-a-option2-report.md    55.6K
gate-b-lane2-report.md      30.5K
gate-c-fix-wave-report.md   56.8K
gate-c-lane2-report.md      25.7K
```

外加 43 份 `review-*.diff` 评审切片。**「门报告没落盘」这句话请不要再被引用。**
（我按记忆里的习惯做法先验前提再采信结论 —— 这次前提没过。）

### C-2 —— 但「防线兑现了吗」**仍然答不了**，理由和 lane 2 说的不是同一条

```
grep -c "writeOwnerTransferRecord" \
  .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-{a-option2,a-fix-wave,b-lane2,c-lane2,c-fix-wave}-report.md
→ gate-a-option2-report.md:0
→ gate-a-fix-wave-report.md:0
→ gate-b-lane2-report.md:0
→ gate-c-lane2-report.md:0
→ gate-c-fix-wave-report.md:0
```

**五份门报告里，`writeOwnerTransferRecord` 这个符号一次都没出现。**

`grep -rln "writeOwnerTransferRecord" .superpowers/ docs/` 在 L3 工作区内只命中：
7 份 `review-*.diff`（符号出现在 diff 的**上下文行**里，因为该函数正好紧邻被改的代码，
**不是评审意见**）与 `task-A7-report.md:197`（逐字：「各自 `it` 开头的 `writeOwnerRecord` +
`writeOwnerTransferRecord`」—— 讲的是**测试夹具怎么造**，不是误用面）。
L3 的设计文档 `2026-08-01-...-design.md:815` 那一处同样是测试夹具表格。

*** 结论：防线**落下过大量可复核证据**（五份门报告 + 43 份评审切片），
但**没有任何一处证据显示有人评审过 `writeOwnerTransferRecord` 的误用问题**。
「评审员看过、判断无需处置」与「评审员根本没看到这一条」在今天的产物里**不可区分**。
我判定：**无法判断防线是否兑现。** ***

**缺的到底是什么（明写）**：缺的**不是**门报告，而是**门报告与 §10 第 3 条之间的对应关系** ——
没有任何一份门报告声明它承接了 §10 第 3 条，也没有任何一处记录说「§10 第 3 条已由 GATE-x 处置」。
要补上这条判断，需要的证据是：L3 的评审委任状里是否列入了「§10 遗留项逐条过一遍」这项要求。
**我没有读 L3 的评审委任状**（见 §7）。

### C-3 —— 今天 `writeOwnerTransferRecord` 的误用面：**和 §10 第 3 条写的完全一样，一点没变**

- **机制强制：仍然没有。** `grep -rln "production has none|no production caller|生产无调用" tests/ src/`
  只命中两处：`src/persistence/fileStore.ts:678`（就是那条注释本身）与
  `tests/ownership/ownerController.test.ts:140`（讲的是 `§9.1 regression fence`，**与本函数无关**）。
  *** 没有任何测试、lint 规则或类型约束钉住「生产不得调用它」。 ***
- **注释仍在，且其自陈的事实今天仍然为真。** 注释逐字：
  「every call site is under `tests/` (fileStore, runLoop.integration, registry/zeroWrite);
  **production has none**」。实测 `grep -rn "writeOwnerTransferRecord" src/ tests/`：
  `src/` 内**只有 `fileStore.ts:689` 的定义本身**，其余 22 处命中全部落在
  `tests/persistence/fileStore.test.ts`、`tests/controller/runLoop.integration.test.ts`、
  `tests/registry/zeroWrite.test.ts` —— **恰好就是注释点名的那三个文件，一个不多一个不少。**
- **它仍然是 `export` 的**，因此误用面 = 「任何新写的生产代码 import 它即可绕过整个转移事务」，
  唯一的拦阻物是那条注释和评审。**§10 第 3 条的描述今天逐字准确。**

## 4. 任务 D：retained 那一半的全仓落点

### 4.0 先把委任状的**路径与节号**自己确认一遍（不采信任何转述）

```
grep -n '^## ' docs/superpowers/specs/2026-07-28-run-registry-design.md
→ ... :557:## 14. Follow-On   :567:## 15. Success Criteria      ← 该文件止于 §15，无 §17
grep -n '^## ' docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md
→ ... :375:## 17. Follow-On Specs Required   :386:## 18. Success Criteria
```

*** 证实：run-registry 那份**没有 §17**（止于 §15）；委任状在
`docs/superpowers/specs/2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17。 ***
`sed -n '375,390p'` 逐字（item 3）：

```
3. **Cleanup / orphan handling design**
   - how superseded or lost-owner workspaces and evidence are retained or cleaned up safely.
```

**`retained or cleaned up` 是并列的两半，逐字确认。**

### 4.1 检索角度（写明我用了哪些、覆盖了什么）

1. `grep -rniE "retain|retention" docs/superpowers/ docs/handoff/ src/`
2. `grep -rn "保留" docs/superpowers/specs/`
3. `grep -rniE "preserve|do not delete|never delete|must not delete" src/`
4. `grep -rn "deletion" docs/superpowers/`
5. `grep -rn "cleanupStatus\|retained" src/` 与 `grep -rn "removeWorktree" src/` + 通读
   `src/workspace/worktreeManager.ts` 全文（32 行）

### 4.2 **今天活着的「保留」行为（生产代码里就有，不是纸面）**

*** 这是本次扫描最该被包 1 知道的一条：仓库今天已经有一个持久化的 retained/removed 判定。 ***

- `src/runtime/types.ts:67` 逐字：`cleanupStatus: "retained" | "removed";` ——
  它是 `ExecutionRecovery` 的一个字段，**会被写进 attempt 产物**。
- `src/controller/runLoop.ts` 的 `cleanupAttemptWorkspaceWithStatus` 逐字：

```
  try {
    await cleanupAttemptWorkspace(repoPath, worktreePath);
    return "removed";
  } catch (error) {
    await appendEvent(runDir, { type: "workspace_cleanup_failed", ... });
    return "retained";
  }
```

  **语义**：清理失败 ⇒ 工作区**被保留**，并**落一条 `workspace_cleanup_failed` 事件**，
  且 `runLoop.ts:1232` 会在状态与先前记录不一致时**重写 attempt 产物**把真实结局写回去。
- `runLoop.ts:1211` 处还有一个**先验地写死 `"retained"`** 的构造点（execute 超时且无结果时），
  再由随后的实际清理结果覆盖。
- 被清理的东西是什么：`src/workspace/worktreeManager.ts` 的
  `cleanupAttemptWorkspace` = `git worktree remove --force <worktreePath>`，
  工作区路径是 `join(runDir, "worktrees", "attempt-<n>")`。
  ⚠️ **`--force` 会连未提交的改动一起丢弃** —— 这与「evidence safety」是直接张力，
  **包 1 设计 L5 时不能假装这条已有行为不存在。**

### 4.3 **既有的「不许删」类约束（纸面，但是上位约束）**

- `docs/superpowers/specs/2026-07-21-stop-no-progress-stale-boundaries-design.md` §10.2
  「Reconciliation must not: ... **silently clean up retained evidence or workspaces**;」
- 同文件 §13「Cleanup Is Not Part of This Layer」逐字：
  「stale detection and reconciliation may identify retained or orphaned execution surfaces,
  **but they may not treat "stale" as permission to delete them**.
  Later cleanup design must consume stale/reconciliation output explicitly rather than being fused into it.」
  *** 这一句是直接写给 L5 的：L5 必须**显式消费** stale/reconciliation 的输出，不许把两者融合。 ***
- 同文件 §15 item 3（**第二份、更早的 L5 委任状**，与 §4.0 那份措辞不同）：
  「define how retained stale surfaces are **inspected, preserved, or eventually cleaned up**
  **without violating evidence safety**.」
  ⚠️ **这是一条九份报告也没提过的独立委任状，且它把「inspected / preserved」排在「cleaned up」前面。**
- `docs/superpowers/plans/2026-07-17-evidence-first-v1-validation.md:19`
  「**Never delete** prior run directories, retained worktrees, stashes, or evidence.
  Every retry gets a new run ID.」
- `docs/superpowers/specs/2026-07-21-docs-and-backlog-truth-alignment-design.md:54`
  该 pass 明确不含「**deletion or mutation of `.validation-runs/`, backup branches, or stashes**」。
- `docs/superpowers/specs/2026-07-19-a04-branch-assessment-and-merge-readiness-design.md:57`
  「backup branch `backup/evidence-first-v1-before-memory-history-cleanup` and retained stashes
  **must not be deleted or published**」。

### 4.4 结论

**「保留」这一半不是一张白纸。** 全仓至少有：**一个活的运行期 retained/removed 判定 + 一条落盘事件**、
**两份措辞不同的 L5 委任状（§4.0 与 §4.3 的 §15 item 3）**、**四条以上「不许删」的既有约束**。
包 1 的 spec 必须把这些当输入，而不是从零发明保留策略。

**我没覆盖的面（明写）**：我只检索了 `docs/`（superpowers + handoff）与 `src/`。
**我没有检索 `tests/`**（那里可能有钉住 retained 语义的测试）、**没有检索 `validation/`**、
**没有检索 `reference/`**（第三方参考实现，按理不是本仓库约束，但我没验证这个假设）、
**也没有检索 `.superpowers/` 下的历史台账**（任务明确要求不从台账继承）。

## 5. 任务 E：分层表 deletion 授权原文与「唯一」的核实

### 5.1 原文（**逐字，含出处**）

文件：`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md`，
小节 `## 3. Position in the frontier decomposition`。`sed -n '30,50p'` 逐字：

```
| Layer | Content | New authority |
|---|---|---|
| **L1 (this design)** | lease + heartbeat | none |
| L2 | run registry / queue (read-only multi-run index) | none |
| L3 | scheduler (pure decision function over the registry) | none |
| L4 | daemon (executes scheduler decisions unattended) | large |
| L5 | cleanup / orphan GC | deletion |
```

**`| L5 | cleanup / orphan GC | deletion |` 这一行今天逐字如此，一字不差。**
（`grep -rn "| L5 |" docs/` → 全仓**只有这一行**命中。）

同节紧随其后还有一句，**包 1 应当一并引用**（逐字）：

> L5 corresponds to the third follow-on spec named in the ownership design §17 and remains unwritten.

*** 这一句在 L1 的文档里就把 L5 与 §4.0 的委任状**显式对上了号** —— 不需要靠台账转述。 ***

### 5.2 「全五层唯一的删除授权」这条**全称否定**的核实

**搜索面（明写）**：`grep -rni "deletion" docs/` —— **对整个 `docs/` 树**，不区分大小写。
全部命中**两行，未过滤**：

```
docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md:41:| L5 | cleanup / orphan GC | deletion |
docs/superpowers/specs/2026-07-21-docs-and-backlog-truth-alignment-design.md:54:- deletion or mutation of `.validation-runs/`, backup branches, or stashes;
```

第二条是一份**排除清单**（该 pass 不做删除），不是授权。
另核：`grep -rn "New authority\|new authority" docs/` → **该分层表在全仓只出现一次**
（`:35` 是表头，无第二份分层表；其余 4 处命中都是「不新增授权」的散文句）。

*** 我的判定（带限定）***：
**在「`docs/` 树内、以字符串 `deletion` 为判据、且只看那张唯一的分层表」这个面上，
`deletion` 确实是五层里唯一被标注的删除授权。** 其余四层的 `New authority` 列是
`none` / `none` / `none` / `large`。

*** 我明确**不**下无限定的全称否定，理由有二 ***：

1. **`L4` 的授权写的是 `large`，不是一个枚举。** 「large」没有被展开，
   *** 它在字面上并不排除删除 ***。所以严格说，可证的是「**只有 L5 被显式标注为 deletion**」，
   **不是**「只有 L5 可能删东西」。这两句不等价，包 1 请用前一句。
2. **我的判据是英文字符串 `deletion`。** 我**没有**用 `delete`/`remove`/`GC`/`清理`/`删除`
   等同义词再扫一遍全仓来找「实质上是删除授权但没用 deletion 这个词」的条款。
   `git worktree remove --force`（§4.2）就是一个**实质删除行为却不叫 deletion** 的现存反例
   —— 它在 L1 之前就已经在生产代码里了。**这说明单靠 `deletion` 一个词的搜索面不足以支撑
   「全五层唯一」的强读法。**

## 6. 我自己发现的、清单外的东西

1. *** 存在**第二份 L5 委任状**，措辞与 §17 那份不同，且更偏向「保留」。 ***
   `docs/superpowers/specs/2026-07-21-stop-no-progress-stale-boundaries-design.md` §15 item 3：
   「define how retained stale surfaces are **inspected, preserved, or eventually cleaned up**
   without violating **evidence safety**.」外加同文件 §13 那条硬边界：
   「they may not treat "stale" as permission to delete them」+「Later cleanup design must
   **consume stale/reconciliation output explicitly** rather than being fused into it」。
   **包 1 若只按 §17 那一句写，会漏掉「显式消费 stale/reconciliation 输出」这条结构性要求。**
2. **`git worktree remove --force` 是仓库里唯一会删掉目录树的东西，而且它丢弃未提交改动。**
   `src/workspace/worktreeManager.ts` 的 `cleanupAttemptWorkspace` 就一行。
   L5 谈 workspace 清理，绕不过它。
3. **`writeJsonFileViaFixedTemp` 与 `writeJsonFileAtomically` 被源码明令不许合并**
   （`fileStore.ts:1116-1119` 与设计 §4.2）。两者产生的残留在 L5 眼里性质完全相反：
   前者**可按名恢复/清理**，后者**不可恢复**。**这是 L5 分类残留的天然分界线，建议直接采用。**
4. **无 `fsync`。** `writeJsonFileAtomically` 的注释逐字：「There is no fsync on the temp file
   or its directory (spec §3.1 item 6; **the repository has zero fsync calls anywhere**)」。
   L5 若要论证「清理是安全的」，这条前提要知道。
5. **工具坑，记一笔给复核者**：`git show "$c:src/..."` 在 **zsh** 下会被解析成参数修饰符 `:s`，
   **静默产出全 0 的假计数**（不报错、退出码 0）。**跨提交计数脚本必须用 bash 跑。**
   我第一次就是这么拿到一张全 0 的假表的。

## 7. 我没做完的事 —— 逐条明写

1. **任务 C 我给不出结论，只给了「无法判断」。** 缺的是 L3 的**评审委任状**
   （门评审的 brief）：只有它能回答「§10 遗留项是否被列入评审范围」。
   我**没有读** `.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/` 下的
   任何 `task-*-brief.md`，也没读 5 份门报告的正文（只跑了 `grep -c`）。**这是我最大的缺口。**
2. **A8 的全称否定我只验到 `src/`。** `tests/`、`scripts/`、`dist/`、CI 配置、
   以及 `runLoop.ts:169` 经 `sh -lc` 执行的用户自带 `requiredChecks` 命令，**全部没验**。
3. **B2 的判别式盖不住「异地勘误」。** 若本仓库允许把勘误写在台账/提交信息里而不回写正文，
   我的 `grep "Amended"` 会漏掉。**我没有验证本仓库是否允许异地勘误。**
4. **任务 E 的「唯一」我只用英文 `deletion` 一个词做判据。** 没有用
   `delete`/`remove`/`purge`/`GC`/`删除`/`清理` 等同义词复扫，因此**不能排除**存在
   「实质是删除授权但换了词」的条款。`git worktree remove --force` 就是这类反例的现成证据。
5. **任务 D 的开放检索只覆盖 `docs/` 与 `src/`。** `tests/`、`validation/`、`reference/`
   一律没查。特别是 **`tests/` 里可能有钉住 `cleanupStatus: "retained"` 语义的测试**，
   那会是比文档更硬的约束，**我没查**。
6. **A2 我是靠读代码结构推的，没有做崩溃注入实验。** 我没跑任何测试（brief 禁止），
   所以「SIGKILL 落在窗口内会留下文件」这条**没有实测证据**，只有代码路径论证。
7. **`buildAtomicTempPath` 的测试我没读。** 源码注释说「the temp-name test pins that by
   asserting this stamp against `buildProcessInstanceId()`'s own components」，
   **我没有打开那个测试确认它确实存在且确实这么断言**。A1 的结论因此建立在源码本身，不含测试佐证。
8. **我没有核对 §10 第 4 条以外的其余四条遗留项**（第 1、2、5 条），任务没要求，我也没做。
9. **Token 预算**：本次扫描的检索量已明显超过 CLAUDE.md Rule 6 的单任务 12,000 token 上限
   （逐字读了 §10 全文、`fileStore.ts` 多个片段、39 提交的历史计数表、六份设计文档的片段）。
   **按 Rule 12 在此明写，不静默超支。**
