# close-2 — `recoverInterruptedOwnerTransfer` 的「不持锁 finalize」路径推到底

派单：把 lane 1 评审员点名的两条「不持锁 finalize」路径推到底，判断 §13 第 1 笔
（锁可被偷）的面是否已从**锁协议**扩大到 **recovery 路径**。

只读任务。本文件是唯一被写的文件。所有数字附可重推命令与逐字输出。锚点用符号名。

（本文件按「先落骨架、逐节 Edit 填」的方式写入 —— 本轮 6 名 agent 里 5 名在准备落盘
时被流中断，该机制已连续复现。）

---

## §0 基线与锚点表

```
$ cd /Users/biran/code/skills/loop/ccloop && git rev-parse HEAD && git status --porcelain
e9021ef87770acf8052bc4c509e56a1aa226523f
```
（`git status --porcelain` 零输出 = 工作区干净。本报告落盘前该文件本身是唯一新增。）

**符号锚点（行号仅供本次定位，已知会腐坏，一律附重推命令）**

| 符号 | 文件 | 本次实测行 | 重推命令 |
|---|---|---|---|
| `recoverInterruptedOwnerTransfer` | `src/persistence/fileStore.ts` | `:1007` | `grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts` |
| `tryRecoverStaleOwnerTransferLock` | 同上 | `:780` | `grep -nF -A33 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts` |
| `finalizePendingOwnerTransfer` | 同上 | `:931`–`:1005` | `grep -nF 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts` |
| `acquireOwnerTransferLock` | 同上 | `:816` | `grep -nF 'async function acquireOwnerTransferLock(' src/persistence/fileStore.ts` |
| `readOwnerRecord` | 同上 | `:1024` | `grep -rn 'readOwnerRecord(' src/` |
| `getOwnerTransferPaths` | 同上 | `:569` | `grep -nF -A30 'function getOwnerTransferPaths(' src/persistence/fileStore.ts` |
| `RUN_MARKER_FILES` | `src/registry/scanRuns.ts` | `:30` | `grep -n 'RUN_MARKER_FILES' -r src/` |

文件名常量（逐字，命令 `grep -n 'OWNER_TRANSFER_LOCK_FILE =\|OWNER_TRANSFER_MARKER_FILE =\|OWNER_RECORD_PENDING_FILE =\|OWNER_TRANSFER_PENDING_FILE =\|RECONCILIATION_RECORD_PENDING_FILE =' src/persistence/fileStore.ts`）：

```
src/persistence/fileStore.ts:527:const OWNER_RECORD_PENDING_FILE = ".owner-record.pending.json";
src/persistence/fileStore.ts:528:const OWNER_TRANSFER_PENDING_FILE = ".owner-transfer.pending.json";
src/persistence/fileStore.ts:529:const RECONCILIATION_RECORD_PENDING_FILE = ".reconciliation-record.pending.js...
src/persistence/fileStore.ts:530:const OWNER_TRANSFER_MARKER_FILE = ".owner-transfer.transaction.json";
src/persistence/fileStore.ts:531:const OWNER_TRANSFER_LOCK_FILE = ".owner-transfer.lock";
```
（`:529` 一行被 grep 工具在 80 列截断，原样保留、不补全；完整值可由
`sed -n '529p' src/persistence/fileStore.ts` 取得，本报告不依赖它的尾部字符。）

---

## §1 `recoverInterruptedOwnerTransfer` 的完整形状

```
$ grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
1007:async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
1008-  const paths = getOwnerTransferPaths(runDir);
1009-
1010-  if (!(await pathExists(paths.transactionMarkerPath))) {
1011-    if (options?.lockHeld) {
1012-      await cleanupOwnerTransferStagingWithoutMarker(runDir);
1013-    }
1014-    return;
1015-  }
1016-
1017-  if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
1018-    return;
1019-  }
1020-
1021-  await finalizePendingOwnerTransfer(runDir);
1022-}
1023-
```

**`finalizePendingOwnerTransfer` 全仓只有两个调用点**（命令 `grep -rn 'finalizePendingOwnerTransfer' src/`，
逐字输出，六行里三行是注释）：

```
src/persistence/fileStore.ts:676:// Production must publish owner-transfer.json only through finalizePendingOwnerTransfer.
src/persistence/fileStore.ts:894:// That stays driven by finalizeOrder itself (see the comment on finalizePendingOwnerTransfer).
src/persistence/fileStore.ts:931:async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
src/persistence/fileStore.ts:1021:  await finalizePendingOwnerTransfer(runDir);
src/persistence/fileStore.ts:1068:    await finalizePendingOwnerTransfer(runDir);
src/registry/observeFields.ts:32:    // transaction's writeOwnerRecordAtomically and finalizePendingOwnerTransfer, which both
```

- `:1068` 在 `writeOwnerTransferArtifacts` 内、`acquireOwnerTransferLock` 与 `finally { lock.release() }` 之间 —— **持锁**。
- `:1021` 是 `recoverInterruptedOwnerTransfer` 的最后一行。它在 `options.lockHeld === true` 时**持锁**
  （三个持锁入口：`writeOwnerTransferArtifacts` `:1039`、`claimOwnerRecordWithPrecondition` `:1082`、
  `updateOwnerRecordWithPrecondition` `:1131`），在 `lockHeld` 未传时**不持锁**。

**`lockHeld` 未传的唯一入口是 `readOwnerRecord`**：

```
$ grep -rn 'recoverInterruptedOwnerTransfer' src/persistence/fileStore.ts
src/persistence/fileStore.ts:366:      // recoverInterruptedOwnerTransfer side effect. Deliberate, and not a behavior loss: when the
src/persistence/fileStore.ts:711:// unlocked recoverInterruptedOwnerTransfer / tryRecoverStaleOwnerTransferLock path — so a subclass
src/persistence/fileStore.ts:1007:async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
src/persistence/fileStore.ts:1025:  await recoverInterruptedOwnerTransfer(runDir);
src/persistence/fileStore.ts:1039:    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
src/persistence/fileStore.ts:1082:    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
src/persistence/fileStore.ts:1131:    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
```

`:1025` 就是 `readOwnerRecord` 的第一条语句（`:1024` 是签名）。

### 1.1 `!lockHeld` 时到达 `:1021` 的四条互斥格

`:1017` 的三个合取项，第一个（`!options?.lockHeld`）在本节恒为真。于是**只要 marker 存在**，
「不进 `:1018` return、落到 `:1021` finalize」有且仅有下列四格：

| 格 | 条件 | 结果 |
|---|---|---|
| **G0** | `pathExists(lockPath)` 为 **false** | 第二合取项短路 → 直接 finalize，**从未接触锁** |
| **G1** | 锁存在，但 `readFile(lockPath)` 抛 `ENOENT`（`:787-788`） | `return true` → finalize，**不 unlink** |
| **G2** | 锁存在且可解析，`pid === null` 或 `!isProcessActive(pid)` | 落到 `:812` `safeUnlink(lockPath)` → `return true` → finalize |
| **G3** | 锁存在但 `JSON.parse` **抛**，且 `hasStagedArtifacts` 为真 | 落到 `:812` `safeUnlink(lockPath)` → `return true` → finalize |

四格**全部**不持锁就 finalize。派单给的两条 = 「G3（偷锁）」与「G0/G1/G2（`readOwnerRecord` 常规读路径）」。
本报告把它们分别记作 **P-STEAL**（G3）与 **P-READ**（G0/G1/G2），并在 §4 说明 G2 内部还藏着一格
今天不可达、但机制上与 G3 同形的 **G2-null**。

### 1.2 一处结构性观察（本报告的核心，先在此点明）

`:1010` 已经保证「到达 `:1017` ⇒ marker 存在」。而 `tryRecoverStaleOwnerTransferLock` 的
`hasStagedArtifacts`（`:802-805`）第一个析取项就是 `await pathExists(transactionMarkerPath)`。

⇒ **在 recovery 路径上，`hasStagedArtifacts` 由入口条件本身满足，恒为真**（除非 marker 恰在
`:1010` 与 `:803` 之间被别人删掉）。

这与 §13 第 1 笔原文讲的那条入口（`acquireOwnerTransferLock` `:816` 的 `EEXIST` → `tryRecover…`）
**不是同一个难度**：那条入口需要「前一次崩溃留下的残余 staging」把 `hasStagedArtifacts` 顶成真
（scan-A 的六步构造第 4 步、lane 1 复核 CONFIRMED）。recovery 路径上这一步是**免费**的。
详见 §2.4 与 §6。

## §2 路径 P-STEAL —— 偷锁分支后不重开锁直接 finalize

### 2.1 调用链（符号名）

```
（任一 readOwnerRecord 调用点）
  → readOwnerRecord                     fileStore.ts :1024
  → recoverInterruptedOwnerTransfer(runDir)      ← 不传 options ⇒ lockHeld undefined   :1025
      :1010  pathExists(transactionMarkerPath) == true   → 不早退
      :1017  !lockHeld == true
             && pathExists(lockPath) == true
             && !(await tryRecoverStaleOwnerTransferLock(runDir))
                 → tryRecoverStaleOwnerTransferLock       :780
                     :785 readFile(lockPath) 成功，读到 ""（零长度）
                     :795 JSON.parse("") 抛
                     :801 catch
                     :802-805 hasStagedArtifacts = pathExists(marker) → true
                     :807 !true → 不 return false
                     :812 safeUnlink(lockPath)   ← 删掉活着的持有者的锁
                     :813 return true
                 → !true == false ⇒ 整个 :1017 条件为假 ⇒ 不 return
      :1021  finalizePendingOwnerTransfer(runDir)   ← 中间没有任何 acquireOwnerTransferLock
```

**逐字确认「中间没有重新取锁」**：`:1013`–`:1021` 之间只有 `:1017` 一个 `if` 与 `:1021` 的
finalize（见 §1 的 `-A16` 输出）。`acquireOwnerTransferLock` 在 `fileStore.ts` 内的调用点是
`:1035`(`writeOwnerTransferArtifacts`) / `:1078`(`claimOwnerRecordWithPrecondition`) /
`:1127`(`updateOwnerRecordWithPrecondition`)，**没有一个在 `recoverInterruptedOwnerTransfer` 内**：

```
$ grep -n 'acquireOwnerTransferLock(' src/persistence/fileStore.ts
816:async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
1035:  const lock = await acquireOwnerTransferLock(runDir);
1078:  const lock = await acquireOwnerTransferLock(runDir);
1127:  const lock = await acquireOwnerTransferLock(runDir);
```
（该命令的逐字输出见 §7.4；此处为同一次运行的转录。）

### 2.2 进入条件

1. run 目录里存在 `.owner-transfer.transaction.json`（marker）—— 即上一次转移事务被中断且已 durable staging；
2. 另一个进程 **P_live** 此刻正处在 `acquireOwnerTransferLock` 的**零长度锁窗口**内 ——
   `:821` `open(lockPath,"wx")` 已返回、`:824` `handle.writeFile(...)` 尚未落盘：

```
$ grep -nF -A22 'async function acquireOwnerTransferLock(' src/persistence/fileStore.ts
816:async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
817-  const { lockPath } = getOwnerTransferPaths(runDir);
818-
819-  for (let attempt = 0; attempt < 2; attempt += 1) {
820-    try {
821-      const handle = await open(lockPath, "wx");
822-
823-      try {
824-        await handle.writeFile(
825-          JSON.stringify(
826-            {
827-              holderProcessInstanceId: `pid:${process.pid}`,
828-              acquiredAt: new Date().toISOString(),
829-            } satisfies OwnerTransferLockRecord,
830-            null,
831-            2,
832-          ),
833-        );
834-      } catch (error) {
835-        await handle.close();
836-        await safeUnlink(lockPath);
837-        throw error;
838-      }
```

3. 读者进程 **P_read** 在此窗口内调用任一 `readOwnerRecord`。四个生产调用点：

```
$ grep -rn 'readOwnerRecord(' src/
src/controller/runLoop.ts:788:      let ownerRecord = await readOwnerRecord(runDir);
src/controller/runLoop.ts:866:          ownerRecord = await readOwnerRecord(runDir);
src/controller/resumeLoop.ts:137:      readOwnerRecord(runDir),
src/persistence/fileStore.ts:382:      readOwnerRecord(runDir),
src/persistence/fileStore.ts:1024:export async function readOwnerRecord(runDir: string): Promise<OwnerRecord> {
```

`resumeLoop.ts:137` 在 `Promise.all` 里（sweep / resume 的必经之路）；`fileStore.ts:382` 在
`readPersistedSuccessfulTransferArtifacts` 的保护性读里；`runLoop.ts:788`/`:866` 是控制器主路径。
**四个都不需要任何特权，也不需要 P_read 自己拥有这个 run。**

### 2.3 今天是否可达 —— 可达。构造如下

前置：run 目录 `R`，磁盘上有 marker（上一次转移被中断，L3 之后 marker 是 v2、三份 pending 齐）。

| 步 | P_live（要做一次转移/心跳/claim） | P_read（跑 sweep 或 resume 或第二个控制器） |
|---|---|---|
| 1 | `acquireOwnerTransferLock` `:821` `open(lockPath,"wx")` 返回，锁文件长度 0 | |
| 2 | （调度切走，`:824` 尚未执行） | `readOwnerRecord` → `recoverInterruptedOwnerTransfer` |
| 3 | | `:1010` marker 存在 → 继续 |
| 4 | | `:1017` `pathExists(lockPath)` 真 → 调 `tryRecover…` |
| 5 | | `:785` `readFile` 得 `""`；`:795` `JSON.parse("")` 抛 |
| 6 | | `:801` catch → `:803` `pathExists(marker)` **真**（入口条件本身）→ 不 return false |
| 7 | | `:812` `safeUnlink(lockPath)` —— **P_live 的锁被删** |
| 8 | | `:813` `return true` → `:1021` **不持锁 finalize** |
| 9 | `:824` 写入锁内容（写进一个已被 unlink 的 inode，对目录不可见）→ `:1039` `recoverInterruptedOwnerTransfer(lockHeld:true)` → `:1021` **同一个 marker 的第二次 finalize** | 正在 finalize |

**第 9 步是本条与 §13 第 1 笔原文的分水岭**：原文的后果是「A 的锁被删、B 拿到锁」，
是**互斥失效**；这里的后果是**两个 `finalizePendingOwnerTransfer` 并发跑在同一组固定
临时路径上**。`finalizePendingOwnerTransfer` 的发布循环（`:988`–`:991`）对每个文件做
`safeUnlink(tempPath)` → `writeJsonFile(tempPath)` → `rename(tempPath, targetPath)`，
而 `tempPath` 是**全进程共享的固定名**（`getOwnerTransferPaths` `:574`–`:576`
`ownerTempPath`/`transferTempPath`/`reconciliationTempPath`，无 pid、无序号 —— 这是
`writeJsonFileViaFixedTemp` 上方注释逐字声明的设计选择）。

可能的交错终态（每一种都只需两条指令交错，无需额外巧合）：
- P_read 的 `writeJsonFile(tempPath)` 尚未写完，P_live 的 `rename(tempPath, targetPath)` 先到
  ⇒ **`owner-record.json` / `owner-transfer.json` / `reconciliation-record.json` 落成半截 JSON**；
- P_live 的 `safeUnlink(entry.tempPath)`（`:989`）落在 P_read 的 `writeJsonFile`（`:990`）与
  `rename`（`:991`）之间 ⇒ P_read 的 `rename` 抛 `ENOENT` ⇒ 走 `:999` catch ⇒ 再 `safeUnlink`
  三个 temp ⇒ 原样 rethrow（**一个未分类的 `ENOENT` Error，不是那三条具名 fail-closed**）；
- 一方已跑完 `safeUnlink(marker)`（`:994`）与 `safeUnlink(pending)`（`:996`–`:997`），另一方
  才走到 `:937` 读 marker ⇒ `ENOENT` ⇒ `:940` `OwnerTransferMarkerUnreadableError`；
  或已读到 marker、才走到 `:971` 读 pending ⇒ `ENOENT` ⇒ `:976` `OwnerTransferPendingMissingError`。

### 2.4 与 §13 第 1 笔原文的差别（这一条是本报告最硬的论据）

原文那条入口（`acquireOwnerTransferLock` `:846` catch → `:847` `EEXIST` 判定 → `:851`
`tryRecoverStaleOwnerTransferLock`）需要
`hasStagedArtifacts` 为真，而 scan-A 的构造第 4 步靠的是**前一次崩溃的残余 staging**
（lane 1 复核 CONFIRMED）。在那条入口上，「零长度锁窗口」与「残余 staging」是**两个独立的
偶然**，必须同时成立。

在 recovery 路径上，`:1010` 已经把 marker 的存在**作为进入条件**校验过了，而 marker 正是
`hasStagedArtifacts` 的第一个析取项。⇒ **两个偶然塌缩成一个**。而且剩下的那个偶然
（marker 存在）根本不是偶然 —— 它是这条代码路径**存在的理由**：没有 marker，
`recoverInterruptedOwnerTransfer` 在 `:1014` 就 return 了。

**结论：P-STEAL 的可达性严格强于 §13 第 1 笔原文那条入口。** 原文写的是这个缺陷面上
**较难的那一半**。

### 2.5 后果分级：**数据丢失**

据以分级的证据，逐条：

1. **发生了写**，而且是对 run 的三份权威产物的写。`finalizePendingOwnerTransfer` 的发布
   循环对 `finalizeOrder` 里每个文件 `rename(tempPath, targetPath)`，v2 的 `targetPath`
   集合是 `owner-transfer.json` / `owner-record.json` / `reconciliation-record.json`
   （`:954`–`:962` 的 `fileTargets`，`rename` 在 `:991`）。⇒ 与「抛出点排在写之前 ⇒ 零写 ⇒ 可重试拒绝」
   （scan-B A-2、scan-C 项 B 的分级依据）**不同类**，那条论证在这里不适用。
2. **并发的两个 finalize 共用固定临时名**（`getOwnerTransferPaths` `:574`–`:576`，见 §1 引文）。
   `writeJsonFileViaFixedTemp` 上方的注释逐字给出这个选择的理由：

   ```
   // Deliberately not sharing writeJsonFileAtomically,
   // whose buildAtomicTempPath stamps a process id and per-call sequence number into the temp
   // name — that name is unrecoverable by any later process.
   ```
   即：固定名是**为了跨进程可恢复**才选的，代价正是**跨进程不隔离**。锁本该补上这个代价，
   而这条路径不持锁。
3. **`rename` 的目标是终态文件，没有 CAS、没有前置比较**。`finalizePendingOwnerTransfer`
   全函数内零 `sameOwnerRecord`、零 `OwnerTransferPreconditionError`
   （`sed -n '931,1005p' … | grep -c 'sameOwnerRecord\|Precondition'` 见 §7.5）。
4. **半截 JSON 的下游后果不可自愈**：`owner-record.json` 是 `RUN_MARKER_FILES` 之一
   （§5），且 `readOwnerRecordRaw` 无 catch；一旦落成半截，该 run 的每一条读路径都抛。
5. 三条具名 fail-closed 抛出（`:940`/`:949`/`:976`）**只能把「该 run 从此读不动」变响亮，
   不能把已经 rename 出去的半截文件变回来**。

⚠️ **不做量化。** 本仓库已两次因量化窗口宽度被下一轮证伪（spec §4.3 的两次撤回）。
本报告只主张「该交错存在且只需两条指令交错」，不主张任何概率或纳秒数。

## §3 路径 P-READ —— `readOwnerRecord` 常规读路径的不持锁 finalize

评审员说的第二条。它不是「偷锁」的变体，而是**根本不需要偷**：`:1017` 的第二个合取项
`await pathExists(paths.lockPath)` 为假时整个条件短路，代码**直接**落到 `:1021` finalize。

### 3.1 调用链

```
runLoop.ts:788 / runLoop.ts:866 / resumeLoop.ts:137 / fileStore.ts:382
  → readOwnerRecord                                fileStore.ts :1024
  → recoverInterruptedOwnerTransfer(runDir)                     :1025   ← 不传 options
      :1010  pathExists(marker) == true
      :1017  !lockHeld == true
             && pathExists(lockPath) == false      ← G0：短路，tryRecover 根本没被调用
      :1021  finalizePendingOwnerTransfer(runDir)   ← 不持锁、不曾持锁、也不打算持锁
```

G1（`:787`–`:788`，锁在 `pathExists` 与 `readFile` 之间消失 → `return true`，**不 unlink**）
与 G2（锁可解析且 `pid === null || !isProcessActive(pid)` → `:812` unlink → `return true`）
在 `:1021` 之后与 G0 完全同形，只是到达方式不同。**G2 是本条路径唯一被设计意图覆盖的一格**
（真·陈旧锁回收），但它**同样**不重新取锁。

### 3.2 进入条件

- G0：marker 存在 **且** 锁文件不存在。
- G1：marker 存在，锁文件在 `:1017` 的 `pathExists` 时存在、在 `:785` 的 `readFile` 时已不存在。
- G2：marker 存在，锁文件存在且是合法 JSON，其 `holderProcessInstanceId` 解析出的 pid 已死
  （或字段缺失/形状不符 ⇒ `parsePid` 返回 `null`，见 §4.2）。

三格都**不需要**任何进程崩溃在特定时刻、不需要零长度窗口、不需要残余 staging。
G0 只需要「上一次转移被中断留下了 marker」——这恰恰是 recovery 存在的前提。

### 3.3 今天是否可达 —— 可达，且比 P-STEAL 更容易

**构造（跨进程，无需 SIGKILL、无需零长度窗口）**

前置：run 目录 `R` 有 marker（上一次转移中断），无锁文件。

| 步 | P_read（sweep / resume / 第二个控制器） | P_own（要做转移、心跳或 claim 的进程） |
|---|---|---|
| 1 | `readOwnerRecord` → `:1010` marker 在 | |
| 2 | `:1017` `pathExists(lockPath)` → **false**，短路 | |
| 3 | （调度切走） | `acquireOwnerTransferLock` `:821` `open(lockPath,"wx")` **成功**（锁确实不存在） |
| 4 | | `:1039`/`:1082`/`:1131` → `recoverInterruptedOwnerTransfer(lockHeld:true)` → `:1021` finalize |
| 5 | `:1021` finalize | finalize |

⇒ 与 P-STEAL 第 9 步**同一个终态**：两个 `finalizePendingOwnerTransfer` 并发，共用固定 temp 名。
差别只在于 P-STEAL 里 P_read 主动删了锁，P-READ 里**没人做错任何事** —— 锁协议
被完整遵守，而 finalize 依然没有互斥。

**同进程内也可达**：`resumeLoop.ts:137` 的 `readOwnerRecord` 在 `Promise.all` 里，
若同一 run 目录被两次并发读（Node 单线程但 `await` 会交错），两次 `recoverInterruptedOwnerTransfer`
可以交错到 `:1021`。本报告**不把这一条算作独立构造**，因为我没有在今天的 `src/` 里找到
对同一 `runDir` 并发发起两次 `readOwnerRecord` 的调用点（`fileStore.ts:382` 的 `Promise.all`
里 `readOwnerRecord` 只出现一次）。**跨进程那条才是承重的。**

**旁证（不是我构造的，是本仓库自己记下来的）**：`docs/handoff/handoff.md:426` 逐字记录了
把 fixture 的锁文件删掉之后的实测行为：

```
$ grep -n 'pathExists(lock)' docs/handoff/handoff.md
426:   变异二（删掉 fixture 里的锁文件）：无锁 → `recoverInterruptedOwnerTransfer` 的 `!lockHeld && pathExists(lock) && !tryRecover…` 短路 → 输家**替赢家**把三文件 finalize 了 → `transferRepresentsPublishedWinner` 反而成立 → 保护生效 → spec 规定的两条断言**全部通过**
```

「输家**替赢家**把三文件 finalize 了」= G0 的行为，**在本仓库自己的测试里被实际观察到过**。
（该记录的语境是一次变异测试的分析，结论是那次变异不合格；我引它只用它记录的**行为事实**，
不引它的结论。⚠️ `handoff.md` 已被本轮 progress.md 判定为**非权威源**、两处腐坏；
故此处只作旁证，承重论据是上面的代码引文。）

**反证也在仓库里**（说明这条路径的行为差异是被测试意识到的）：

```
$ grep -n 'A live lock makes' tests/registry/zeroWrite.test.ts
734:      // A live lock makes recoverInterruptedOwnerTransfer a no-op, which would make every
```

### 3.4 后果分级：**数据丢失**（与 P-STEAL 同级，理由同 §2.5）

据以分级的证据：

1. 终态与 P-STEAL 第 9 步逐字相同 —— 两个 finalize 并发、共用 `ownerTempPath` /
   `transferTempPath` / `reconciliationTempPath`、`rename` 直落三份权威产物。
2. `finalizePendingOwnerTransfer` **函数体内零守卫**，命令与逐字输出：

   ```
   $ awk 'NR>=931 && NR<=1005' src/persistence/fileStore.ts | grep -c 'sameOwnerRecord\|OwnerTransferPreconditionError\|isProcessActive\|lockPath'
   0
   ```
   即：全函数**不比较所有权、不做 CAS、不检查活进程、连锁路径的名字都没出现**。
   它对「自己是不是唯一的 finalizer」**没有任何判断能力**，完全依赖调用者持锁 ——
   而它的两个调用点里，`:1021` 在四格 G0/G1/G2/G3 下都不持锁。
3. `isProcessActive` 全仓只有**一个**调用点，且在解析成功路径上：

   ```
   $ grep -rn 'isProcessActive' src/
   src/persistence/fileStore.ts:766:function isProcessActive(pid: number): boolean {
   src/persistence/fileStore.ts:798:    if (pid !== null && isProcessActive(pid)) {
   ```
   ⇒ G0 这一格**连 `tryRecoverStaleOwnerTransferLock` 都没进**，活进程检查更无从谈起。

### 3.5 P-READ 的一个额外性质：它使 P-STEAL 的「偷」在后果上是多余的

P-STEAL 比 P-READ 多做的事只有一件：`safeUnlink(lockPath)`（`:812`）。它的增量后果是
**让第三个进程也能 `open(lockPath,"wx")` 成功**，从而把并发 finalizer 数从 2 提到 N。
但**数据丢失这个分级在 P-READ 上就已经达到了**。

⇒ 对 L5 的排序有直接影响：**即使把 `tryRecoverStaleOwnerTransferLock` 的 catch 分支修好
（补上活进程检查），P-READ 依然完整存活。** 第 1 笔的修法不能只动锁协议的 catch。

## §4 有没有第三条同形路径 —— 自己扫的结果

### 4.1 扫法（先说搜索面，因为本轮刚栽过一次「收窄的 grep 支撑全称否定」）

「同形」= **不持锁地把 staging 发布成终态产物**。终态发布的唯一原语是 `rename`。
故先枚举 `src/` 里**全部** `rename` 调用点：

```
$ grep -rn 'await rename(\|rename(' src/ | grep -v '^\s*//'
src/persistence/fileStore.ts:645:    await rename(tempPath, path);
src/persistence/fileStore.ts:991:      await rename(entry.tempPath, entry.targetPath);
src/persistence/fileStore.ts:1107:  await rename(ownerTempPath, ownerPath);
src/persistence/fileStore.ts:1119:  await rename(tempPath, targetPath);
```

逐条定位所属函数与持锁状态：

| rename | 所属函数 | 调用点 | 持锁？ |
|---|---|---|---|
| `:645` | `writeJsonFileAtomically` | 与转移事务无关（`loop-state.json` 等，L3 的原子写路径） | 不在锁协议内，**也不发布转移产物** |
| `:991` | `finalizePendingOwnerTransfer` | `:1021`（四格全不持锁）＋ `:1068`（持锁） | **两者兼有** |
| `:1107` | `writeOwnerRecordAtomically` | `:1089`（`claimOwnerRecordWithPrecondition` 内）＋ `:1139`（`updateOwnerRecordWithPrecondition` 内） | **两处都在 `acquireOwnerTransferLock`…`finally lock.release()` 之间** |
| `:1119` | `writeJsonFileViaFixedTemp` | `:1060`/`:1061`/`:1064`/`:1067`，**全部**在 `writeOwnerTransferArtifacts` 的锁内 | 持锁 |

命令：
```
$ grep -rn 'writeOwnerRecordAtomically' src/
src/persistence/fileStore.ts:1089:    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
src/persistence/fileStore.ts:1103:async function writeOwnerRecordAtomically(runDir: string, ownerRecord: OwnerRecord): Promise<void> {
src/persistence/fileStore.ts:1110:// Same shape as writeOwnerRecordAtomically, generalized to a caller-supplied temp path: the
src/persistence/fileStore.ts:1139:    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
src/registry/observeFields.ts:32:    // transaction's writeOwnerRecordAtomically and finalizePendingOwnerTransfer, which both
$ grep -rn 'writeJsonFileViaFixedTemp' src/
src/persistence/fileStore.ts:1060:    await writeJsonFileViaFixedTemp(paths.transferPendingTempPath, paths.transferPendingPath, transferRecord);
src/persistence/fileStore.ts:1061:    await writeJsonFileViaFixedTemp(paths.ownerPendingTempPath, paths.ownerPendingPath, ownerRecord);
src/persistence/fileStore.ts:1064:      await writeJsonFileViaFixedTemp(paths.reconciliationPendingTempPath, paths.reconciliationPendingPath, reconciliationRecord);
src/persistence/fileStore.ts:1067:    await writeJsonFileViaFixedTemp(paths.transactionMarkerTempPath, paths.transactionMarkerPath, marker);
$ grep -rn 'finalizePendingOwnerTransfer' src/     # 见 §1，两个调用点 :1021 / :1068
```

**结论（限定在 `src/`，搜索面 = 全部四个 `rename` 调用点）：不存在第五个发布点。
不持锁 finalize 的机制只有 `recoverInterruptedOwnerTransfer:1021` 一处，
但它有四格进入条件（G0–G3）。** 派单给的两条覆盖 G3（P-STEAL）与 G0（P-READ 的主格）；
**G1 与 G2 是我补的，属同一机制的不同格，不另计为「第三条路径」。**

### 4.2 但确实有一条**独立的第三格**：G2-null —— 今天不可达，触发条件是写死的

`tryRecoverStaleOwnerTransferLock` 的**成功解析**路径（`:794`–`:799`）：

```
794-  try {
795-    const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
796-    const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
797-
798-    if (pid !== null && isProcessActive(pid)) {
799-      return false;
800-    }
801-  } catch {
```

`pid === null` 时，`:798` 的第一个合取项为假 ⇒ 不 `return false` ⇒ 直落 `:812`
`safeUnlink(lockPath)` + `:813` `return true`。

⚠️ **注意这一格与 G3 的差别：G3 至少还过了一次 `hasStagedArtifacts`；G2-null 连那一步都没有** ——
`hasStagedArtifacts` 只写在 `catch` 块里（`:802`–`:809`），成功解析路径**根本不查**。
⇒ 一个 `holderProcessInstanceId` 不符 `^pid:\d+$` 的**合法 JSON 锁文件，会被任何读者
无条件删除**，既不查活进程，也不查有无 staging。

`parsePid` 的判据（逐字）：
```
761: function parsePid(processInstanceId: string): number | null {
762:   const match = /^pid:(\d+)$/.exec(processInstanceId);
763:   return match === null ? null : Number.parseInt(match[1], 10);
764: }
```

**今天不可达。写死的触发条件（三选一即可）：**
1. 锁记录里 `holderProcessInstanceId` **缺失或为空串**（`:796` 的 `? :` 直接给 `null`）；
2. 该字段存在但**不匹配 `^pid:\d+$`**；
3. 有第二个写者往 `.owner-transfer.lock` 写内容。

今天三条都不成立：唯一的写者是 `acquireOwnerTransferLock` `:827`
``holderProcessInstanceId: `pid:${process.pid}` ``，`process.pid` 恒为十进制正整数。
测试里也没有反例（`grep -rn 'holderProcessInstanceId' src/ tests/` 的 10 条 test 命中中，
写 `.owner-transfer.lock` 的全部用 `pid:${process.pid}` 或 `"pid:999999"`；唯一带两个冒号的
`tests/controller/leaseGate.test.ts:77 holderProcessInstanceId: "pid:100:1000"` 写的是
**lease 记录**，类型来自 `src/ownership/lease.ts:12`，不是转移锁）。

*** 但这条离触发只差一次「顺手统一」，而代码自己知道这一点 *** —— `fileStore.ts:603`–`:605`
逐字：

```
603: // A third and deliberately weaker form exists in acquireOwnerTransferLock (`pid:<pid>`, no
604: // start time). It is correct as written — its only consumer, parsePid, extracts the pid for a
605: // liveness probe and never compares process identity — so do not "unify" it with this one.
```

而 `buildProcessInstanceId()` 的形式是 `pid:<pid>:<origin>`（`src/runtime/processIdentity.ts:7`
``const PROCESS_INSTANCE_ID = `pid:${process.pid}:${Math.trunc(performance.timeOrigin)}`;``），
**它不匹配 `^pid:\d+$`**。⇒ 任何一次把锁记录「统一」到 `buildProcessInstanceId()` 的改动，
会让**每一把锁对每一个读者立即可删**，而唯一的防线是上面那三行注释 —— **没有测试钉住它**
（`grep -rn 'holderProcessInstanceId' src/ tests/` 里没有任何一条断言 `parsePid` 对
`pid:<pid>:<origin>` 的行为）。

**G2-null 的分级：今天零后果；一旦触发 = 数据丢失**（终态与 P-STEAL 相同，且门槛更低）。
形状与 progress.md 记的「组 B 两条债」同类（今天不可达、触发即数据丢失），
按 lane 1 的改述要求，此处措辞为「**未发现可达路径**」而非「不可达」。

### 4.3 一处**加重情节**，不是新路径，但必须记：`runLoop.ts:866` 那个第二次读

```
$ grep -rn 'readOwnerRecord(' src/     # 见 §2.2
src/controller/runLoop.ts:866:          ownerRecord = await readOwnerRecord(runDir);
```

`docs/superpowers/specs/2026-07-27-owner-transfer-contention-design.md:123` 逐字（节选）：

> Taken literally the sentence bans a guard on the catch path's *second* `readOwnerRecord`
> (`runLoop.ts:782`, reached on a CAS mismatch or an exhausted lock-busy retry) — which runs
> `recoverInterruptedOwnerTransfer` and therefore **writes**, the exact hazard the entry bullet
> above exists to prevent, on the path that most strongly indicates a rival now owns the run and
> up to a full retry backoff after the entry guard passed.

（文档写 `runLoop.ts:782`，今天是 `:866` —— **行号腐坏，符号与语义未腐坏**。）

⇒ P-READ 的一个生产调用点，**恰好长在「最可能有对手正在持锁」的那条路径上**，
且**在一整个重试退避之后**。这是 P-READ 可达性的加强证据，不是第三条路径。

## §5 `RUN_MARKER_FILES` 与 marker 读写路径在两条上各扮演什么角色

### 5.0 先消歧：本仓库有**两个**叫 marker 的东西，本节两个都用到

| 名字 | 值 | 定义处 | 作用 |
|---|---|---|---|
| `RUN_MARKER_FILES` | 5 个**无点前缀**的文件名 | `src/registry/scanRuns.ts:30` | **run 目录识别**（scanRuns） |
| 事务 marker | `.owner-transfer.transaction.json` | `fileStore.ts:530` `OWNER_TRANSFER_MARKER_FILE` | **转移事务的待决标记**（recovery 的入口条件） |

```
$ grep -n 'RUN_MARKER_FILES' -r src/
src/registry/scanRuns.ts:30:export const RUN_MARKER_FILES: readonly string[] = [
src/registry/scanRuns.ts:87:  for (const marker of RUN_MARKER_FILES) {
$ sed -n '28,37p' src/registry/scanRuns.ts
// Spec §4: recognition is permissive — any one of these, present directly in a directory,
// makes it a run directory. Order carries no meaning; presence of any one is sufficient.
export const RUN_MARKER_FILES: readonly string[] = [
  "loop-contract.json",
  "loop-state.json",
  "events.jsonl",
  "owner-record.json",
  "owner-transfer.json",
];
```

**事务 marker 不在 `RUN_MARKER_FILES` 里。** 两者唯一的交集是：`RUN_MARKER_FILES` 的第 4、5 项
（`owner-record.json`、`owner-transfer.json`）**正是 `finalizePendingOwnerTransfer:991` 的
rename 目标**（`fileTargets` `:954`–`:962`）。

### 5.1 事务 marker 在 P-STEAL 上的角色：**一物两用，这就是可达性塌缩的机制**

同一个 `pathExists(.owner-transfer.transaction.json)` 被查了两次，用途不同：

- `:1010` —— **入口闸**：无 marker 则 `recoverInterruptedOwnerTransfer` 在 `:1014` 直接 return，
  P-STEAL 与 P-READ 都不存在。
- `:803` —— **`hasStagedArtifacts` 的第一个析取项**：G3 的 catch 里，它是「这把锁值不值得偷」
  的唯一判据（`isProcessActive` 只在 `:798` 的成功路径上，`grep -rn 'isProcessActive' src/`
  只有定义 `:766` 与 `:798` 两行，见 §3.4）。

⇒ **凡是能到达 `:803` 的执行，`:1010` 必然已经判过 marker 存在。** 于是 §13 第 1 笔原文里
「靠前一次崩溃的残余 staging 顶起 `hasStagedArtifacts`」这一环，在 recovery 路径上
**由入口条件免费提供**。这是 §2.4 那个结论的完整机制。

（唯一的例外：marker 在 `:1010` 与 `:803` 之间被第三方删掉。那要求另一个 finalizer 已跑到
`:994`，属更严重的交错，不构成对上述结论的削弱。）

### 5.2 事务 marker 在 P-READ 上的角色：**只当入口闸，不参与判定**

G0 短路在 `:1017` 的第二个合取项，`tryRecoverStaleOwnerTransferLock` 根本没被调用，
`hasStagedArtifacts` 也就无从谈起。marker 在这条路径上**只负责决定「要不要 finalize」，
完全不负责「谁有资格 finalize」**。这正是 P-READ 无需任何人犯错的原因。

### 5.3 L3 给这次 recovery 加的三样东西，在两条路径上各是什么

L3 给这条 recovery 加了：(a) 第三个参与文件 `.reconciliation-record.pending.json`；
(b) 一次 marker 的 `readFile` + `JSON.parse`（`:937`）；(c) 三条具名 fail-closed 抛出
（`:940`/`:949`/`:976`，均在 `finalizePendingOwnerTransfer` `:931`–`:1005` 内 —— 独立重推：

```
$ grep -n 'throw new OwnerTransferMarkerUnreadableError\|throw new OwnerTransferMarkerFinalizeOrderInvalidError\|throw new OwnerTransferPendingMissingError' src/persistence/fileStore.ts
3 matches in 1 files:
src/persistence/fileStore.ts:940:throw new OwnerTransferMarkerUnreadableError("owner transfer transaction mark...
src/persistence/fileStore.ts:949:throw new OwnerTransferMarkerFinalizeOrderInvalidError(
src/persistence/fileStore.ts:976:throw new OwnerTransferPendingMissingError(
```
⇒ **三条，不是两条。与 scan-A、scan-B、lane 1 三方独立结论一致，本报告是第四方。**）

**(a) 第三个参与文件 —— 只出现在事务侧，`hasStagedArtifacts` 看不见它。**

```
$ awk 'NR>=780 && NR<=814' src/persistence/fileStore.ts | grep -n 'reconciliation'
（零输出）
```
`tryRecoverStaleOwnerTransferLock` 的解构（`:781`）只取
`lockPath, ownerPendingPath, transferPendingPath, transactionMarkerPath` —— **无
`reconciliationPendingPath`**（见 §1 的 `-A33` 输出 `:781`）。这坐实了派单里给的
「`hasStagedArtifacts` 只看三个路径、看不见第三份 pending」这一条**在今天仍成立**。

**在本报告的两条路径上，这个不对称的实际影响是：零。** 因为 `:803` 的第一个析取项
（marker）在 recovery 路径上恒为真，后面两个析取项**根本不会被求值**（`||` 短路）。
⇒ 「第三份 pending 不在 `hasStagedArtifacts` 里」是 §13 第 1 笔**原入口**上的缺陷，
**不是** recovery 路径上的缺陷；recovery 路径上它被更强的东西（入口闸本身）盖过了。
*** 这是一处必须写清的界限：不要把这条不对称当成 recovery 路径的成因。 ***

**(b)(c) marker 的 `readFile`+`JSON.parse` 与三条抛出 —— 它们是这两条路径的可观测签名。**

双 finalize 交错时，落后的那个 finalizer 会命中：

| 交错 | 命中 | 抛出 |
|---|---|---|
| 对方已跑完 `:994 safeUnlink(marker)`，本方才到 `:937 readFile(marker)` | `ENOENT` 落进 `:938` 的**无条件 `catch {`** | `:940` `OwnerTransferMarkerUnreadableError`（消息含 "could not be **read** or parsed"） |
| 本方已读到 marker，对方跑完 `:996`–`:997 safeUnlink(pending)`，本方才到 `:971 readFile(pending)` | `:973` `ENOENT` 分支 | `:976` `OwnerTransferPendingMissingError` |
| 本方 `:990 writeJsonFile(temp)` 与对方 `:989 safeUnlink(temp)` / `:991 rename(temp)` 交错 | `rename` 的 `ENOENT` | `:999` catch → 清三个 temp → **原样 rethrow 一个未分类 Error** |

`:949` 的 `OwnerTransferMarkerFinalizeOrderInvalidError` **不由这两条路径产生** ——
`finalizeOrder` 只由 `writeOwnerTransferArtifacts` `:1047`–`:1058` 写死为合法排列
（v1 = `[OWNER_TRANSFER_FILE, OWNER_RECORD_FILE]`，v2 = 前二 + `RECONCILIATION_RECORD_FILE`），
竞态改不了它的内容。（这是我能给出的、把三条抛出**分开**处理的结论：两条是竞态签名，
一条不是。）

⇒ **重要推论**：scan-B 在 A-2 §4.4 独立发现的「marker 的 ENOENT 落进 `:938` 无条件 catch，
抛的正是规则 3」，在本报告的两条路径上**同样成立，且不需要跨进程 SIGKILL** ——
P-READ 就够了。**scan-B 那条的可达面因此又宽一格。**

### 5.4 `RUN_MARKER_FILES` 的角色：让被污染的 run **继续被喂回这条路径**

`isRunDirectory` 只查**存在性**，不查内容：

```
$ awk 'NR>=83 && NR<=93 {print NR": "$0}' src/registry/scanRuns.ts
83: // Spec §4: a directory is a run directory iff it directly contains at least one marker file.
84: // Checked with the injected `fileExists` rather than by inspecting a `readDir` listing, so
85: // recognition and descent are two independently swappable decisions.
86: async function isRunDirectory(path: string, deps: ScanDeps): Promise<boolean> {
87:   for (const marker of RUN_MARKER_FILES) {
88:     if (await deps.dir.fileExists(join(path, marker))) {
89:       return true;
90:     }
91:   }
92:   return false;
93: }
```

而 `readOwnerRecordRaw` 无 catch：

```
$ grep -nF -A2 'async function readOwnerRecordRaw(' src/persistence/fileStore.ts
660:async function readOwnerRecordRaw(runDir: string): Promise<OwnerRecord> {
661-  return JSON.parse(await readFile(join(runDir, OWNER_RECORD_FILE), "utf8")) as OwnerRecord;
662-}
```

⇒ 半截的 `owner-record.json` **仍然让该目录被识别为 run**（存在性满足），于是每次 sweep
都会把它捡起来 → `resumeLoop` → `readOwnerRecord` → `recoverInterruptedOwnerTransfer` →
（marker 已被某一方删掉的话）`:1014` 早退 → `readOwnerRecordRaw` **抛 `SyntaxError`**。
**该 run 从此每一轮 sweep 都失败一次，且没有任何路径会删掉它** —— 这正是委任状
（cleanup / orphan handling）字面覆盖的形态。

### 5.5 一处被这两条路径证伪的既有注释（只上报，不改）

`src/registry/observeFields.ts:29`–`:35` 逐字：

```
29:     file: "owner-record.json",
30:     // Same story as loop-state.json above: owner-record.json is published by rename on every path
31:     // that writes it (writeOwnerRecord via writeJsonFileAtomically, plus the transfer
32:     // transaction's writeOwnerRecordAtomically and finalizePendingOwnerTransfer, which both
33:     // rename into place), and this stays false as the same defence in depth, at the same bounded
34:     // cost.
35:     atomic: false,
```

「published by rename ⇒ 观测到的永远是完整文件」这个前提，**在单写者假设下成立，在双
finalize 下不成立**：`writeJsonFile` 是裸 `writeFile`（`:589`–`:591`
`await writeFile(path, JSON.stringify(value, null, 2));`，非原子、无 fsync），
而两个 finalizer 共用同一个 `ownerTempPath`；一方 `rename` 走的是另一方**写到一半的**
temp，rename 本身原子，**发布出去的内容却是半截的**。

`atomic: false` 让 L2 会重读一次（纵深防御），**但磁盘上的文件已经永久半截，重读救不回来**。
⇒ 记为**仅文档**（注释的前提被本报告的两条路径证伪），**不自行改注释**。

## §6 决定性问题 —— 第 1 笔的面：锁协议 vs recovery 路径

### 6.1 结论

*** 已经扩到 recovery 路径。而且不止是「扩」—— recovery 路径上的面**严格更宽**，
并且其中一条（P-READ）**根本不经过第 1 笔所描述的那个缺陷**。 ***

### 6.2 三条硬论据（每条都可由 §1–§5 的引文独立重推）

**论据一：recovery 路径上的偷锁，比锁协议入口少一个前提。**
§13 第 1 笔原文那条入口（`acquireOwnerTransferLock` `:846`→`:847`→`:851`）要求
「零长度锁窗口」**且**「前一次崩溃的残余 staging」两个偶然同时成立（scan-A 六步构造第 4 步，
lane 1 复核 CONFIRMED）。recovery 路径（P-STEAL）上第二个前提由 `:1010` 的入口闸**免费提供**，
因为 `hasStagedArtifacts` 的第一个析取项就是同一个 marker（`:803`）。
⇒ 同一个缺陷，在 recovery 路径上门槛更低。**第 1 笔原文写的是这个面上较难的那一半。**

**论据二：P-READ 完全不依赖第 1 笔的缺陷，修好第 1 笔也关不掉它。**
第 1 笔的缺陷位于 `tryRecoverStaleOwnerTransferLock` 的 `catch`（`:801`–`:809`，缺活进程检查）。
P-READ 的主格 G0 在 `:1017` 的第二个合取项就短路了，**`tryRecoverStaleOwnerTransferLock`
一次都没被调用**。⇒ 即便把那个 catch 补成「先查活进程再决定」，P-READ 依然完整存活，
终态依然是双 finalize / 数据丢失。
*** 这条把问题从「锁协议有个洞」升级为「recovery 的发布步骤根本不在互斥内」。 ***
两者的修法不同：前者改一个 catch，后者要么让 `recoverInterruptedOwnerTransfer` 在
`!lockHeld` 时**取锁再 finalize**（会把「读」变成「可能阻塞/可能抛 lock-busy」的写路径，
牵动 L2 §7.1 整套「读不许触发恢复」的设计），要么让 `readOwnerRecord` 不再 finalize
（牵动 L1/L2 四处已落地的契约）。**这是一次设计裁决，不是一次补丁。**

**论据三：后果的类型变了 —— 从「互斥失效」变成「同一组固定临时路径上的并发发布」。**
第 1 笔原文的终态是「A 的锁被删、A 与 B 同时以为自己持锁」，再由 scan-A 的附带发现
（`evaluateResumeEligibility` 八条判据无一比进程身份，lane 1 CONFIRMED）放大成
「矛盾记录通过全部八条 → `resume_adopted` 照常发生」。
recovery 路径的终态**多一层**：两个 `finalizePendingOwnerTransfer` 并发，共用
`ownerTempPath`/`transferTempPath`/`reconciliationTempPath`（`getOwnerTransferPaths`
`:574`–`:576`，无 pid 无序号，且注释逐字说明这是**为跨进程可恢复**才选的固定名），
`writeJsonFile` 是裸 `writeFile`（`:589`–`:591`）。
⇒ 后果不只是「谁拥有这个 run」判错，而是**三份权威产物可能落成半截 JSON**，
`readOwnerRecordRaw`（`:661`，无 catch）此后永久抛。
⇒ 分级同为**数据丢失**，但**失效模式是新的一类**，不能靠第 1 笔原文的论证覆盖。

### 6.3 对「第 1 笔排不排在债 2 前面」的直接回答

本报告**不替人做这个排序裁决**（归属与优先级是人裁事项，本轮已有先例）。
但把决定该排序所需的事实摆全：

| 维度 | 债 2（`persistTerminalState` 无所有权守卫） | §13 第 1 笔（含本报告的 recovery 面） |
|---|---|---|
| 今天可达 | 是（scan-A + lane 1 CONFIRMED） | 是，**且有两条独立路径** |
| 分级 | 数据丢失 | 数据丢失 |
| 触发是否需要对手进程 | **否** —— `leaseLoss.lost !== null` 后本进程裸写 | **是** —— 需要两个 `readOwnerRecord`/lock 参与者交错 |
| 触发是否需要前置崩溃 | 否 | **是** —— 需要磁盘上已有事务 marker |
| 破坏范围 | 别人的 `loop-state.json`（一份产物，写入合法 JSON） | `owner-record.json` / `owner-transfer.json` / `reconciliation-record.json`（**最多三份，且可能是半截 JSON**） |
| 是否自愈 | 状态错但文件可读 | **不可读 ⇒ 该 run 每轮 sweep 失败一次，且无路径删它** |
| 修法规模 | 加一个所有权守卫（局部） | **一次设计裁决**（见论据二），牵动 L1/L2 的「读不许写」契约 |
| L3 的接触面 | **零**（`git log -S` 证 L3 没增没减，lane 1 CONFIRMED） | **非零** —— L3 加了第三个参与文件、marker 的 `readFile`+`JSON.parse`、三条具名抛出 |

*** 本报告能给出的、对排序最有分量的一条：第 1 笔的**修法规模**比原文描述的大一个量级。 ***
原文（只讲锁协议入口）读起来像「补一个活进程检查」；本报告证明那样改**关不掉 P-READ**。
如果排序的依据里含「修起来多大」，这条必须进去。

*** 反方向的一条，同样必须说：本报告没有把第 1 笔的**触发难度**降到债 2 的水平。 ***
债 2 单进程即可触发、无需前置崩溃；第 1 笔的两条路径都需要「磁盘上已有事务 marker」
＋「两个参与者交错」。**谁排前面取决于人对『触发难度』与『破坏不可逆性』的权重，
这不是我能替人定的。**

### 6.4 给记账用的一句话（可直接贴进未来 brief）

> §13 第 1 笔的面不止锁协议。`recoverInterruptedOwnerTransfer`（`fileStore.ts`，符号锚点）
> 在 `options.lockHeld` 未传时，**四格进入条件（锁不存在 / 锁读时消失 / 锁可解析且 pid 死或
> 不可解析成 pid / 锁不可解析且有 staging）全部直落 `finalizePendingOwnerTransfer`，
> 中间不重新 `acquireOwnerTransferLock`**。其唯一入口 `readOwnerRecord` 有四个生产调用点
> （`runLoop` ×2、`resumeLoop` ×1、`readPersistedSuccessfulTransferArtifacts` ×1）。
> 后果：两个 finalizer 并发跑在同一组**固定**临时路径上，`owner-record.json` /
> `owner-transfer.json` / `reconciliation-record.json` 可落成半截 JSON。
> **补上 `tryRecoverStaleOwnerTransferLock` catch 里的活进程检查关不掉其中的第一格。**

## §7 与「已确立事实」的核对（独立重推，不照抄）

派单给了五条「已确立、但你要独立验证仍成立」的事实。逐条：

### 7.1 六步夺锁构造仍成立 —— **仍成立，无一环报废**
- 零长度锁窗口 `:821` `open(lockPath,"wx")` ↔ `:824` `handle.writeFile(...)`：§2.2 逐字输出。
- `JSON.parse("")` 进 catch：`:795` parse ↔ `:801` `} catch {`：§1 的 `-A33` 输出。
- **catch 内没有任何活进程检查**：`grep -rn 'isProcessActive' src/` 只有 `:766`（定义）与
  `:798`（成功路径），§3.4 逐字输出。**独立重推确认。**
- `hasStagedArtifacts` 靠残余 staging 为真：`:802`–`:805`，成立。
  ⚠️ **但见 §2.4 / §5.1：在 recovery 路径上这一步不需要「残余」，marker 就够。**
- 删掉活着的持有者的锁：`:812` `await safeUnlink(lockPath);`，成立。

### 7.2 `hasStagedArtifacts` 只看三个路径、看不见第三份 pending —— **仍成立**
```
$ awk 'NR>=780 && NR<=814' src/persistence/fileStore.ts | grep -c 'reconciliation'
0
```
解构行 `:781` 逐字只取四个字段（`lockPath, ownerPendingPath, transferPendingPath,
transactionMarkerPath`），见 §1 输出。
*** 但本报告对这条的用途作了一处限定，见 §5.3：在本报告的两条路径上，
该不对称的实际影响是零（`||` 在第一个析取项就短路）。这不是推翻，是划界。 ***

### 7.3 `evaluateResumeEligibility` 八条判据无一比较进程身份 —— **仍成立，独立重推**
```
$ grep -nF -A45 'export function evaluateResumeEligibility' src/controller/resumeLoop.ts
```
八条判据分别在 `:43` / `:46` / `:49` / `:52` / `:55` / `:58` / `:61` / `:64`，
比较对象逐条为：`ownerTransfer.eligibleForContinuation` / `reconciliation.eligibleForContinuation` /
`reconciliation.ownershipVerdict` / `reconciliation.newOwnerEpoch` vs `ownerTransfer.newOwnerEpoch` /
`ownerRecord.supersededByEpoch` / `ownerRecord.currentOwnerEpoch` vs `ownerTransfer.newOwnerEpoch` /
`ownerRecord.ownerStatus` / `runState.status`。
**没有任何一条读 `currentProcessInstanceId` 或 `priorProcessInstanceId`。**
```
$ awk 'NR>=40 && NR<=69' src/controller/resumeLoop.ts | grep -c 'ProcessInstanceId'; echo "exit=$?"
0
exit=1
```
（`exit=1` 是 `grep -c` 零命中的正常退出码，不是命令失败。搜索面 = 函数体 `:40`–`:69` 全部，
即八条判据加返回语句；**这条否定的范围仅限该函数体，不是全仓**。）

### 7.4 `:1017` 分支夺锁成功后不重开锁 —— **仍成立**
```
$ grep -n 'acquireOwnerTransferLock(' src/persistence/fileStore.ts
816:async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
1035:  const lock = await acquireOwnerTransferLock(runDir);
1078:  const lock = await acquireOwnerTransferLock(runDir);
1127:  const lock = await acquireOwnerTransferLock(runDir);
```
三个调用点分属 `writeOwnerTransferArtifacts` / `claimOwnerRecordWithPrecondition` /
`updateOwnerRecordWithPrecondition`，**没有一个在 `:1007`–`:1022` 区间内**。

### 7.5 三条具名 fail-closed 抛出 —— **仍成立，本报告是第四方独立确认**
见 §5.3 的 grep 输出：`:940` / `:949` / `:976`，全部落在
`finalizePendingOwnerTransfer` `:931`–`:1005` 内（§4.1 的 awk 全文可核）。
**附加**：`finalizePendingOwnerTransfer` 函数体内零所有权守卫：
```
$ awk 'NR>=931 && NR<=1005' src/persistence/fileStore.ts | grep -c 'sameOwnerRecord\|OwnerTransferPreconditionError\|isProcessActive\|lockPath'
0
```

### 7.6 与派单前提的偏差 —— 一处，按铁律 6 原样上报，不自改判据

派单写：「lane 1 评审员**顺带发现那里其实有两条**不持锁 finalize 的路径」。
**实测是四格（G0–G3）＋ 一格今天不可达的 G2-null。** 派单给的「两条」把
G0/G1/G2 合并成了「`readOwnerRecord` 常规读路径」一条、G3 单列一条 ——
**这个归并本身是对的**（G3 与其余三格在「是否有人做错事」上性质不同），
但**格数是 4+1 不是 2**。本报告按派单的两条口径组织 §2/§3，并在 §1.1 与 §4.2
把完整的格数摆出来。**这不构成对评审员结论的推翻，只是补全。**

---

## §8 未完成项（明写缺什么，不用部分证据凑完整结论）

1. **两条路径都只做到「静态可达性论证」，没有实跑注入验证。**
   缺：一次真实的两进程注入（或用 vitest 的 fake 调度在 `:1021` 前插入 await 点），
   实测双 finalize 的终态。本报告的分级依据是代码结构与交错枚举，**不是观测**。
   ⚠️ 派单铁律 7 要求明写 —— **这是本条最主要的未完成项**。
   （补充说明为什么没做：铁律 1 限定只读，注入验证需要写测试文件。**这是任务约束
   造成的边界，不是我省略的**。若人要闭合，需另派一个允许写 `tests/` 的任务。）

2. **`RUN_MARKER_FILES` 与半截 `owner-record.json` 的下游后果只推到 `readOwnerRecordRaw` 抛出为止。**
   缺：sweep 侧对该抛出的分类（走不走 `classifyThrow` 的 stderr 支路、是否触发 cron 告警），
   因而 §5.4 那句「每轮 sweep 失败一次」**没有给出可操作性分级**。
   我读到 scan-C 的项 B 对 `resumeLoop.ts:145` 有同型分析，**但我未独立重推，不引为背书。**

3. **G1 格（`:787`–`:788` 的 `readFile` ENOENT → `return true` 且不 unlink）没有单独构造。**
   我论证了它与 G0 同形，但**没有给出一个只经 G1 的完整交错**。
   缺：锁文件恰在 `:1017` 的 `pathExists` 与 `:785` 的 `readFile` 之间被释放的具体时序。

4. **没有核对这两条路径在 `tests/` 里是否已被某条测试覆盖或反向钉死。**
   我只用了两处测试注释作旁证（`zeroWrite.test.ts:734`、`handoff.md:426`），
   **没有通读 `tests/persistence/fileStore.test.ts` 里 `recoverInterruptedOwnerTransfer`
   相关的用例**（`grep` 显示至少 `:1770`、`:3708` 两处提及）。
   ⇒ **「今天没有测试钉住 P-READ」这句话我不敢下 —— 那会是一条我未覆盖搜索面的全称否定。**
   （本轮刚栽过这个形状，见 progress.md lane 2 的「唯一一处两份报告直接矛盾」。）

5. **G2-null 的「一次统一就触发」只查到 `src/`。** 我没有查 plan/spec 里有没有已经写下
   「把锁记录统一到 `buildProcessInstanceId()`」的计划条目。若存在，G2-null 的紧迫度要重估。

6. **没有回答「该不该改」。** 本报告只给可达性与分级。修法方向在 §6.2 论据二里列了两条，
   **两条都牵动 L1/L2 已落地的契约，属人裁**，我不自裁。

7. **本任务超出 CLAUDE.md Rule 6 的 12,000 token/任务预算。** 按 Rule 12 明写而非静默超支：
   本任务需要通读 `fileStore.ts` 的锁/事务/恢复三段（约 450 行）＋ 六份既有报告的相关段落，
   且铁律 2 要求逐字贴完整输出。**已超支，未静默。**
