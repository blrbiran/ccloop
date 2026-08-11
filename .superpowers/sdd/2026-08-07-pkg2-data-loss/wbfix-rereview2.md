# 包 2 修复环第三轮 —— scoped 再评审（第四个人）

> 状态：**已完成**（§0 结论最先填，其余逐节回填；所有结论均为本人实测，未采信实施者自证）
> scoped = `845694b..HEAD`（`179d776` / `c659d2a` / `7062fc9`）＋「有没有把前两轮已 ADDRESSED 的弄坏」

## 0. 结论（最先填：ADDRESSED / 有无新破坏 / 有无越界 / 有无新引入缺陷）

| 判据 | 结论 | 凭据（本人实测） |
| --- | --- | --- |
| 第三轮两项（Imp-1 修法、Imp-2 新列）是否 ADDRESSED | **ADDRESSED（两项都是）** | Imp-1：双向变异实测（M1/M2）；Imp-2：我造出了实施者说造不出的变异（M3） |
| 有无新破坏 | **无** | 本机 HEAD 全套件 31 files / **533 passed / 0 failed**，exit 0；typecheck exit 0；build exit 0；逐文件计数无一下降 |
| 有无越界 | **无** | `tryRecoverStaleOwnerTransferLock`（969 B）与 `release()`（135 B）相对 `845694b` **逐字节相同**（程序比对，非目测） |
| 有无新引入缺陷 | **无（未发现能证据化的新缺陷）** | 「修一个洞开一个新洞」的假设我按 8 条路径实测证伪，见 §2.3 |
| 前两轮已 ADDRESSED 有无被弄坏 | **无** | 原子发布仍成立：probe `staged` 臂在 FIXED build 上 4069 个 CAS base **0 违约**，同机 must-hit 控制臂非零 |

三条附带结论：

1. *** **实施者关于 Imp-2 的自陈是不诚实的——但方向对它自己不利。** *** 它自称「造不出只让新列变红的变异」，
   我造出来了（M3：`cleanupOwnerTransferStagingWithoutMarker` 跳过三个 pending 的回收）。崩溃矩阵 34 行里
   **只有 `afterResume` 一列动了**（两个 fixture 的 gap 15/16/17），`staged`/`resume=`/`recovery=`/`after` 四列逐字不变。
   **这一列不是恒真的**，它守的是「resume 侧持锁回收」这一类回归，而这一类是既有 `after` 列**结构上看不见**的。
   自陈属于**低估自己**，不是自证过头——但按本仓库口径，任何自陈都得独立复核，这次复核把结论改好了。
2. *** **C-1 不得记「已关闭」，应记「降级」。** *** 我不认为「降级」过强，理由与可直接引用的一句话见 §6。
3. **探针自陈灵敏度诚实**：我在 10s 各测得 **1 / 2** violations（3293 / 3057 bases），落在第三个人的 1–4 带内，
   低于实施者自报的 6；`SENSITIVITY` 注释写的「single-digit magnitude、不是可复现常数」与实测一致。
   一处**措辞偏强**：注释说 5s「frequently reads ZERO」，我唯一一次 5s 跑读到 **2**，单次不足以证伪 "frequently"，
   但也不构成支持——记为 Info-3，不建议本轮改。

## 1. 全套件与逐文件计数比对

环境：`ECC_GATEGUARD=off DISABLE_OMC=1`，全部经 `rtk proxy`，整份输出落盘后整份读回，**未过滤**
（本轮我没有对任何验证跑用过 `grep`/`tail`/`sed`；`grep` 只用于源码定位，不用于验证输出）。

### 1.1 三个退出码（工作树 HEAD `7062fc9`）

| 跑法 | 命令 | 退出码 | 落盘 |
| --- | --- | --- | --- |
| 全套件 | `npx vitest run` | **0** | `scratchpad/head-tests.log`（153 行，含 `RUN v2.1.9 …/.worktrees/pkg2-wbfix` 路径行） |
| typecheck | `npm run typecheck` | **0** | `scratchpad/head-typecheck.log` |
| build | `npm run build` | **0** | `scratchpad/head-build.log` |

全套件末行：`Test Files 31 passed (31)` / `Tests 533 passed (533)` / `Duration 18.80s`。
**零红**，因此本轮连允许的 flake (B)/(F) 都没出现。

### 1.2 逐文件计数比对 `845694b` → HEAD

基线跑法：`git archive 845694b` 展开到 scratchpad 副本、软链 `node_modules`、同样跑全套件
（`scratchpad/base-tests.log`，178 行）。计数由两份 `--reporter=json` 报告程序化比对，31 个文件全部逐行打印：

```
基线  HEAD   Δ   文件
  80    82   +2  tests/persistence/fileStore.test.ts
其余 30 个文件 Δ 全为 0
TOTAL 531 -> 533   files 31 -> 31   DECREASED FILES: NONE
```

- **531 → 533 由我自己两次跑出来，不是抄的**；`+2` 全部落在 `fileStore.test.ts`，正是 Imp-1 的两条新判据。
- **无一文件下降。**
- `dbac288`(524) → `c2db9c7`(529) → `845694b`(531) 这三段我**没有重跑**（超出 scoped 范围，且 `845694b..HEAD`
  只碰了 `fileStore.test.ts` 一个测试文件，见 §9「没验到的」第 1 条）。

### 1.3 基线副本里的两条红——是我副本的环境产物，不是 `845694b` 的问题

基线跑出 `Tests 2 failed | 529 passed (531)`：
`tests/cli/cli.test.ts > parseArgs > returns 0 for the scripted example run`（expected 2 to be +0）与
`tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（5000ms 超时）。

**我做了对照实验**：把 **HEAD** 也 `git archive` 成同样的副本再跑，**同样这两条、同样红**
（`scratchpad/m3.log` 的 5 条失败里含这两条；单独重跑 `tests/cli/cli.test.ts` 于 HEAD 副本仍红，确定性复现）。
同一份代码在真实工作树里 533 全绿。⇒ **归因于 `git archive` 副本缺 `.git`/仓库上下文，与提交无关**，
不是 flake，也不是回归。**逐文件 collected 计数不受影响**，1.2 的比对结论成立。

## 2. Imp-1 修法：先例同形性、双向实测、以及"有没有开新洞"

### 2.1 与先例是否真同形——**不完全同形，而且差异点实施者自己写清楚了**

先例 `writeJsonFileAtomically`（`src/persistence/fileStore.ts:759`）的吞掉只发生在 **catch 里**，
它的理由原文是 "cleanup here runs while an error is already in flight"。
新的 `discardLockStaging`（`src/persistence/fileStore.ts:957`）被用在**两条路径**上：

- 失败路（`fileStore.ts:1028`，link 抛错后）——**与先例同形**，先例的理由逐字适用。
- 成功路（`fileStore.ts:1034`，link 成功后）——**先例的理由在这里不成立**：此刻没有 in-flight error。

这不是隐瞒：`discardLockStaging` 上方的注释明确写了「The SUCCESS path needs a second reason」，并给出
「丢 staging 名字是污点，丢锁是停摆」的取舍。**判定：论证诚实、形状有意偏离先例，偏离处已具名。**
代价是成功路上一个真实的环境故障（EROFS/EIO）现在**完全无声**——记为 Low-1（§7），**不建议本轮修**。

关键结构性核对（这才是 Imp-1 的要害）：**`link()` 成功之后到 `return` 之间，现在还有没有会抛的语句？**
`discardLockStaging` 的 `try { await unlink } catch { }` catch 体为空、不 rethrow，**不可能抛**；
成功路上没有 `handle.close()`。⇒ **窗口关死。**

### 2.2 双向实测（变异都在 `git archive HEAD` 的副本里做，工作树全程不脏）

| 变异 | 改动 | 结果 |
| --- | --- | --- |
| **M1** 成功路回退 | `fileStore.ts:1034` `discardLockStaging` → `safeUnlink` | `fileStore.test.ts` **1 failed / 81 passed (82)**，红的正是 `a failure to clear the lock's publish staging file never costs the caller its lock > completes the claim and leaves no lock behind when clearing the staging file fails after the publish`，**红在断言**（`expected { kind: 'threw', …} to deeply equal { kind: 'completed' }`，detail = `Error: EACCES: permission denied, unlink`），不是死于异常 |
| **M2** 失败路回退 | `fileStore.ts:1028` `discardLockStaging` → `safeUnlink` | 同文件 **1 failed / 81 passed (82)**，红的正是另一条 `… still reports a busy lock, not the cleanup's errno, when the staging cleanup fails on a contended acquire`，**红在断言**（`expected 'Error' to be 'OwnerTransferLockBusyError'`） |
| 未变异（HEAD） | — | 两条都绿（§1.1 的 533 全绿里） |

**两条新判据互相不掩盖**：M1 只杀第一条，M2 只杀第二条。二者都是**红在断言**，不是红在抛异常。
第一条的写法（把 outcome 捕成值再断言）是必要的，否则未修版本会以异常收场而不是失败断言。

### 2.3 *** 「修一个洞开了新洞吗」——8 条路径实测 ***

`discardLockStaging` 的吞掉意味着 **staging 文件可能永久留在磁盘上**。注释断言它「inert：唯一命名、没人读、
没有 acquisition path 找它」。**这句我没有信，我跑了**（`scratchpad/mut/leftover-experiment.mts`，用生产的
`buildAtomicTempPath` 生成真实名字，不是手编字符串）：

```
LEFTOVER NAME: /run-1/..owner-transfer.lock.9980.1786459005823.2.tmp
1 claim with leftover present: OK, owner now pid:222
2 lock present after claim: false | leftover still present: true
3 scan rows: 1 run                      （registry 只出 1 条 run 行，无 issue 行）
4 initializeRunFiles with a leftover present: OK (not blocking)
5 readOwnerRecord with leftover: OK
6 run dir listing: ..owner-transfer.lock.9980.1786459005823.2.tmp owner-record.json
7 leftover content readable: 87 bytes
8 acquire against unparseable lock + leftover only: OwnerTransferLockBusyError
```

逐条判读：

1. **后续加锁不受影响**（`claimOwnerRecordWithPrecondition` 成功）。
2. `release()` 照常删掉锁；**残留物自己不会消失**。
3. **registry/`scanRuns` 看不见它**：识别靠 `RUN_MARKER_FILES` 具名，descent 只进目录，残留是文件 ⇒ 既不成行也不成 issue。
4. **`ensureFreshRunDir` 的 `blockingPaths` 不含它**（只有 `loop-contract.json`/`loop-state.json`/`events.jsonl`
   ＋ `attempts`/`worktrees` 两个目录的非空判定）⇒ 不会把一个新 run dir 卡死。
5. `readOwnerRecord`（无锁恢复入口）不受影响。
6. **它不被任何后续正常操作回收**（`cleanupOwnerTransferStagingWithoutMarker` 只回收 10 个**固定名**，
   锁 staging 是第 11 个名字、且名字不可预测 ⇒ 无回收路径）。
7. 成功路上残留是**锁 inode 的第二个名字**，`release()` 删掉锁名后内容仍在（87 B）——占空间，不改变可见性。
8. *** **最要紧的一格：残留物不会喂给 point B 的偷锁分支。** *** 我构造了「锁文件不可解析 ＋ 目录里只有一个
   残留 staging」的现场，加锁的结果是 `OwnerTransferLockBusyError` ——即 `hasStagedArtifacts` 只看
   marker/ownerPending/transferPending 三个具名路径，**残留不算 staged artifact，没有把偷锁窗口开大**。

⇒ **没有开新洞。** 残留物的全部后果是「占空间 ＋ 目录里多一个没人回收的点文件」，这是 Low-1，不是缺陷。
sweep（`src/sweep/sweepRuns.ts`）按其头部注释「reads no file under any run directory」，对残留同样无感。

## 3. 人裁 50 红线

**不是目测，是程序化逐字节比对**（从 `git show 845694b:src/persistence/fileStore.ts` 与
`git show HEAD:...` 两个 blob 里按具名锚点切片后 `===`）：

| 符号 | `845694b` 字节数 | HEAD 字节数 | 逐字节相同 |
| --- | --- | --- | --- |
| `tryRecoverStaleOwnerTransferLock`（从函数签名到 `await safeUnlink(lockPath); return true; }`） | 969 | 969 | **true** |
| `acquireOwnerTransferLock` 的 `release()` 闭包（`return { release: async () => { … } };`） | 135 | 135 | **true** |

`release: async` 在两版里各出现 **1 次**，不存在「改了另一个同名闭包」的可能。
HEAD 上 `release()` 的全文：

```ts
      return {
        release: async () => {
          await handle.close();
          await safeUnlink(lockPath);
        },
      };
```

⇒ **红线成立，无越界。** 另核：`845694b..HEAD` 的三个提交里，只有 `179d776` 动了 `src/`，
且只动 `src/persistence/fileStore.ts` 一个文件；包 1 与待裁点 A/B/C 的代码一行未碰。

## 4. Imp-2 新列：取样正确性、墙钟泄漏、以及这一列到底有没有价值

### 4.1 取样的是不是**跑过 resume 的那份副本**——是（第二轮的错没有重犯）

`tests/persistence/fileStore.test.ts` 的 `observeCrashMatrix` 里两份副本是分开的：
`forResume`（跑 `observeResume`）与 `forRecovery`（跑 `observeRecovery`）。新列取的是
`await crashSnapshot(forResume)`，**正是跑过 resume 的那一份**；旧的 `after` 列仍取自 `forRecovery`。
⇒ **取样正确。**

### 4.2 有没有墙钟字段能漏进去——没有

`crashSnapshot` 的输出只由三样东西组成：`publishedEpoch()`（只 `JSON.parse` 后取一个具名 epoch key，
渲染成 `e<N>` / `absent` / `torn`）、marker 的 `version`（`v2`/`unparseable`/`absent`）、
三个 pending 文件的 **presence 字母**。**没有任何时间字段进入这一列**，
`lastAffirmedAt` 那类自证伪断言在这里构造不出来。
旁证（实测而非读码）：这条测试在我这里被完整跑了 **4 次**（HEAD 全套件、M1、M2、M3），
新列在 3 次未变异跑中**逐字一致**，无时间抖动。

### 4.3 *** 这一列到底有没有价值——有，而且我推翻了实施者的自陈 ***

实施者自陈「造不出只让新列变红的变异，所以不声称抓到什么」。**我造出来了。**

**M3**：把 `cleanupOwnerTransferStagingWithoutMarker` 里对三个 pending 的回收
（`safeUnlink(ownerPendingPath/transferPendingPath/reconciliationPendingPath)`）用环境变量门控跳过，
其余一律不动，跑**全套件**。崩溃矩阵那条测试的两个 fixture 各红 1 次，diff 里动的行是：

```
-   "gap 15 | … | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=--- | recovery=ok | after … P=TOR"
+   "gap 15 | … | resume=accepted | afterResume T=e2 O=e2 R=e2 M=absent P=TOR | recovery=ok | after … P=TOR"
```

（gap 15/16/17，两个 fixture 共 6 行；另 28 行逐字不变。）

**这就是判据**：同一行里 `staged`、`resume=`、`recovery=`、`after` 四列**全部没动**，
**只有 `afterResume` 变了**。⇒ 新列**不是恒真**，它独立看见了一类既有列结构上看不见的回归：
**resume 侧「持锁进入 ⇒ 回收 staging」这一步**。
为什么旧 `after` 列结构上看不见：gap 15..17 的 marker 已不在，`recoverInterruptedOwnerTransfer` 的
**无锁**路径（`readOwnerRecord` 的入口）在 `!lockHeld` 时**根本不做回收**（`fileStore.ts:1206-1211`），
所以 `after` 天然就是 `P=TOR`；只有走 resume 的持锁路径才会把 pending 抹掉成 `P=---`。
**旧列和新列在 gap 15..17 上期望值本来就不同**——这本身就证明这一列携带了旧列没有的信息。

诚实性判定：实施者的自陈**低估了自己的产出**（说没抓到，其实抓得到），属于保守的错，不是自证过头。
但它写进了 `wbfix-impl-report.md`，会让台账把这一列记成「只守未来」，**建议按 §7 的 Info-2 更正措辞**。

M3 的**波及面**（诚实报告，不藏）：全套件下 M3 还杀了同文件另一条
`fileStore > reclaims all ten staging paths on the next lock-held entry when the marker is already gone`。
这不削弱上面的结论——问题问的是「新列能否独立变红」，答案是**能，且在同一条测试内它是唯一动的列**。

## 5. 探针灵敏度自陈是否老实

我自己跑了 **5 个臂**（`scratchpad/probe.log`，全部 `EXIT=0`，整份落盘整份读回）：

| 跑法 | `distinctBasesConsumed` | `mutualExclusionViolations` | 判读 |
| --- | --- | --- | --- |
| `truncated 10000`（must-hit） | 3293 | **1** | 控制臂能打中 |
| `truncated 10000`（must-hit，重复） | 3057 | **2** | 同上 |
| `truncated 5000` | 1647 | **2** | 短跑也打中了一次 |
| `nostaged 10000`（must-not-hit） | 4752 | **0** | 指标本身自洽 |
| `staged 10000`（FIXED build，本轮的正题） | 4069 | **0** | 原子发布仍然成立 |

判读：

- **自陈的量级诚实。** `SENSITIVITY` 注释说「10s 稳定落在 1–4」「single-digit magnitude」「不是可复现常数」——
  我测到 1 和 2，落在带内。实施者自报的 **6/3195** 高于该带但同量级；第三个人的 1–4 与我一致。
  **没有人在夸大探针。**
- **「0 也可能是探针坏了」这句落到位了。** 注释第 22-24 行写明 zero「is also exactly what a BROKEN probe
  looks like」，并且 `run.mts:48-53` 有**代码级**的短跑告警——我用 `truncated 5000` 触发过，
  stderr 确实打出 `WARNING: the must-hit control fires at roughly 0.3/s; at 5000ms a reading of 0 is common…`。
  这一条不是靠读者记住段落，是靠程序提醒，**合格**。
- **一处措辞偏强**：注释称 5s「frequently reads ZERO」。我唯一一次 5s 跑读到 **2**。
  单次样本**不能证伪** "frequently"，但也不支持它；且 `~0.3/s` 与我实测的 ~0.1–0.2/s 略有出入。
  记 Info-3，**不建议本轮改**（改了就得再攒样本，收益低于噪音）。
- **关键的负结论有对照**：`staged` 臂在 FIXED build 上读 0 的同一台机器、同一天，
  must-hit 臂读非零 ⇒ **这个 0 不是「未验证的负例」**。

## 6. 专判：C-1 现在到底关掉了多少（给可直接引用的一句话）

### 6.1 事实基础（我自己核过，不是转述）

**关掉的**：`acquireOwnerTransferLock` 自己的发布。旧的 `open(lockPath,"wx")` + `handle.writeFile` 之间
锁存在且零字节的窗口没有了——现在写 staging、`link()` 一步发布。
本机实测：FIXED build 的 `staged` 臂 **4069 个 CAS base，0 次互斥违约**，
同机 must-hit 控制臂非零 ⇒ 这个 0 有对照。

**没关掉的**：`tryRecoverStaleOwnerTransferLock`（`fileStore.ts:900-934`）**逐字节未动**，
它有 **两个不问存活就删锁的出口**：

- **出口 ①**（`catch` 分支，`fileStore.ts:921-930`）：锁内容 `JSON.parse` 失败 **且** marker/ownerPending/
  transferPending 三者任一存在 ⇒ 直接 `safeUnlink(lockPath); return true`，**从不检查持有者是否活着**。
- **出口 ②**（`fileStore.ts:916-920` 的落空路径）：锁**能**解析，但 `holderProcessInstanceId` 缺失或不是
  `pid:N` 形状 ⇒ `pid === null` ⇒ `if (pid !== null && isProcessActive(pid))` 为假 ⇒ 同样落到
  `safeUnlink(lockPath); return true`，**也不检查存活**。

**出口 ① 在 FIXED build 上依然会造成真实的跨进程互斥违约**：`truncated` 臂（外部进程把锁文件截成 0 字节）
10s 两次分别测得 **1** 与 **2** 次 lost update。⇒ **C-1 的危害路径没有被消灭，只是被收窄。**

### 6.2 「降级」过不过强——我的判断：**不过强，正合适**

支持「降级」而非「未变」的硬事实：修前，**不需要任何外部行为者**，两个正常生产进程互相竞争就能踩中
（三个人分别测到 140/137/213/252 量级）；修后，同样的竞争在 4069 个 base 上 **0** 次。
剩下的两个出口**都需要一个非生产的写者**去动 `.owner-transfer.lock`（截断、半写、或写入一个
`holderProcessInstanceId` 不是 `pid:N` 的记录）——生产代码本身再也造不出这样的锁文件。
这是**触发条件的实质收窄**，不是措辞游戏。

反对「已关闭」的硬事实：危害类型（两个进程同时持锁 ⇒ lost update）**一模一样没变**，
只是入口少了一个；而且**剩下的两个出口一行没改**（待裁点 B 未裁）。

### 6.3 *** 可直接引用的一句话（给台账与开门主题行） ***

> **C-1 降级，未关闭。** 人裁 50 只批了 O1：`acquireOwnerTransferLock` 的锁发布已改为
> staging + `link()` 的原子发布，生产代码自己再也造不出「锁已存在但内容不可解析」的窗口——
> FIXED build 上 `staged` 臂 4069 个 CAS base 实测 0 次互斥违约。
> 但 `tryRecoverStaleOwnerTransferLock` 的**两个失败开放出口逐字节未动**（① 锁不可解析 ＋ 任一 staged
> artifact 存在 ⇒ 不问存活直接删锁；② 锁可解析但 `holderProcessInstanceId` 不是 `pid:N` ⇒ 不问存活直接删锁），
> 它们属于**未裁的待裁点 B**；只要有非生产写者动过锁文件，同样的跨进程 lost update 依旧会发生——
> 同机 `truncated` 必命中臂 10s 各测得 1 次与 2 次。**故台账记「降级」（触发条件从"两个正常进程即可"
> 收窄为"需要外部写者损坏锁文件"），不得记「已关闭」。**

（口径与人裁 39 对第 4 笔的同形处理一致：**一律记降级**。）

## 7. Findings（分级，finding 与处置建议分开）

**Critical: 0　Important: 0　Low: 2　Info: 3**（scoped = `845694b..HEAD`）

### Low-1 — 成功路上的静默吞掉没有任何诊断出口，残留物也没有回收路径

**Finding（只陈述事实）**：`discardLockStaging`（`src/persistence/fileStore.ts:957`）在 `link()` 成功之后
被调用时，没有 in-flight error，此时吞掉一个非 ENOENT errno 意味着**一次真实的环境故障
（EROFS/ESTALE/EIO）在整个系统里不留任何痕迹**——没有日志、没有 event、没有返回值。
残留文件也不会被任何东西回收：`cleanupOwnerTransferStagingWithoutMarker` 只回收 10 个**固定名**，
锁 staging 的名字带 pid＋进程启动时刻＋序号，**不可预测、因而无回收路径**（§2.3 实测第 6 条）。
持续故障下会在 run dir 里单调累积 `..owner-transfer.lock.*.tmp`。

**处置建议（与 finding 分开）**：**不建议本轮修**。三条理由：(a) 残留已实测为 inert（§2.3 八条全过，
尤其第 8 条证明它不喂给偷锁分支）；(b) `acquireOwnerTransferLock` 没有 event 追加面，加一个是本轮范围外的
新接口；(c) 能让 unlink 失败却让 open+link 成功的 errno 面很窄（创建文件与删除文件要的目录权限相同）。
建议**挂账到待裁点 B 的设计里一并考虑**，不要单独开一轮。

### Low-2 — 同一个 catch 里还有一条同类的抛出语句：`handle.close()`

**Finding**：失败路的 catch 是 `await handle.close(); await discardLockStaging(stagingPath); throw error;`
（`fileStore.ts:1027-1029`）。Imp-1 只把第二句换成了不抛的版本，**第一句 `handle.close()` 仍然会抛**，
一旦它抛，原始的 `EEXIST` 就被 close 的 errno 顶掉，外层 `if (code !== "EEXIST") throw error` 会把
**一次真实的锁竞争**当成陌生 errno 直接抛出去——这正是 `discardLockStaging` 注释自己点名的
「third effect」的同形残余。**严重度只到 Low**：此刻锁尚未发布（`link` 失败才进这条 catch），
**不会重演 Imp-1 的「锁已发布却拿不到 release」停摆**，只会错分类。
**这一行相对 `845694b` 逐字未动**，即它不是第三轮引入的；它是第二轮那段新代码的遗留。

**处置建议**：**不建议本轮修**（本轮 scoped 到 `845694b..HEAD`，改它会动到红线之外的语义）。
建议记入台账，与 Low-1 一起在待裁点 B 的设计里处理。

### Info-1 — `discardLockStaging` 与所抄先例并非同形，偏离处在成功路

见 §2.1。**已在代码注释里具名说明**，不构成缺陷。**处置：无需动作。**

### Info-2 — `wbfix-impl-report.md` 里关于新列的自陈低估了产出

**Finding**：实施者自陈「造不出只让新列变红的变异，所以不声称抓到什么，只说守未来的回归类」。
我造出来了（§4.3 的 M3），且在崩溃矩阵那条测试内**新列是唯一变红的列**。

**处置建议**：**docs-only，可选**。若控制器要让台账口径准确，把该自陈改成
「新列已被独立变异证实可单独变红（M3：跳过 `cleanupOwnerTransferStagingWithoutMarker` 的三个 pending 回收）」。
**不改也不影响代码正确性**，故不列为必修。

### Info-3 — 探针 SENSITIVITY 注释里「5s frequently reads ZERO」措辞偏强

见 §5。我唯一一次 5s 跑读到 2；单样本不能证伪，也不支持。**处置：不建议本轮改。**

## 8. 变异与还原证明

**变异次数：3（M1 / M2 / M3）。全部在 `git archive HEAD` 展开的副本
`scratchpad/mut/` 里做，工作树 `src/`、`tests/` 全程零改动。**

| 编号 | 目标符号 | 改法 | 观察 |
| --- | --- | --- | --- |
| M1 | `acquireOwnerTransferLock` 成功路（`fileStore.ts:1034`） | `discardLockStaging` → `safeUnlink` | 新判据 1 红在断言，其余 81 绿 |
| M2 | `acquireOwnerTransferLock` 失败路（`fileStore.ts:1028`） | `discardLockStaging` → `safeUnlink` | 新判据 2 红在断言，其余 81 绿 |
| M3 | `cleanupOwnerTransferStagingWithoutMarker` | 三个 pending 的 `safeUnlink` 用 `MUT3` 环境变量门控跳过 | 崩溃矩阵**只有 `afterResume` 列**变红（6 行）；另杀 `reclaims all ten staging paths…` 1 条 |

**还原全证（三重，程序化，不是目测）**：

1. 每次变异都是**从 pristine 副本 `scratchpad/fileStore.orig.ts` 重写**，不是在上一次变异之上叠加。
2. 收尾后把 `scratchpad/mut/src/persistence/fileStore.ts` 还原，并与 `git show HEAD:src/persistence/fileStore.ts`
   做 `Buffer.compare`：**`mut copy restored identical to HEAD blob: true`**（这同时证明 `fileStore.orig.ts` 本身
   就等于 HEAD blob，即 M1/M2 也都是从 pristine 起跳的）。
3. 工作树：`git status --porcelain --untracked-files=all` 在开工时、中途、收尾时各查一次，
   收尾唯一一行是 `?? .superpowers/sdd/2026-08-07-pkg2-data-loss/wbfix-rereview2.md`（本报告，交付物本身）。
   `HEAD` 仍是 `7062fc9`，分支仍是 `feat/pkg2-wb-fixes`，无 commit / push / 建删分支 / 合并 / stash。

**⚠️ 一处必须自曝的操作失误（Rule 12）**：我第一次落骨架时把报告写到了**主仓库**路径
`/Users/biran/code/skills/loop/ccloop/.superpowers/sdd/…/wbfix-rereview2.md`（少了 `.worktrees/pkg2-wbfix`）。
发现后已 `mv -n` 移到工作树正确路径并核实：主仓库该路径**已不存在该文件**，
主仓库 `git status --porcelain -u` **为空**。该文件是我新建的（Write 报 "File created"，未覆盖任何已有文件），
**未触碰主仓库任何既有内容**。除此之外没有碰过主仓库。

## 9. 没验到的

1. **`dbac288`(524) 与 `c2db9c7`(529) 两个更早基线我没有重跑**，只跑了 `845694b`(531) 与 HEAD(533)。
   理由：scoped 范围是 `845694b..HEAD`。**风险是有界的**：`845694b..HEAD` 只改了
   `tests/persistence/fileStore.test.ts` 一个测试文件（`git diff --stat` 核过），
   其余 30 个文件的计数在我这次比对里 Δ 全为 0，因此 524→529→531 段的「无一下降」我**沿用前两轮的记录，未独立复核**。
2. **`git archive` 副本里那两条红我只做到了「归因于副本环境」**（HEAD 副本同样红、真实工作树全绿、
   `cli.test.ts` 在副本里确定性复现），**没有进一步定位到具体是哪一个仓库上下文依赖**。
3. **Low-1 的累积路径没有做长时间实测**：我验证了单个残留物的 8 条后果，**没有**构造「持续 unlink 失败下
   累积上千个残留物」的场景来测目录规模影响。
4. **平台只覆盖 darwin**。人裁 52 声明目标平台是 darwin＋linux；`link(2)` 的原子性在 linux 上我**没有跑过**。
5. **`truncated` 臂我只跑了 3 次**（10s/10s/5s）。「0.3/s」这个率我的样本给不出置信区间。
6. **没有做并发压力下的残留物累积 × 偷锁分支的交叉实验**（残留 ＋ 外部截断同时存在）。
   §2.3 第 8 条是静态构造的现场，不是竞态下的。
7. **待裁点 A/B/C 与包 1 完全没碰**，按 brief 要求。

## 10. 预算：可数事实

- 全套件跑：**4 次**（HEAD 工作树 1、`845694b` 副本 1、M3 副本 1；另 M1/M2 各跑 1 次单文件，M3 后单跑 `cli.test.ts` 1 次）。
- typecheck / build：各 **1** 次，退出码各 **0**。
- 探针跑：**5** 臂（truncated×3、nostaged×1、staged×1），退出码全 **0**。
- 变异：**3** 次；还原核验：**1** 次程序化 `Buffer.compare`（结果 true）。
- 自写实验脚本：**1** 个（`scratchpad/mut/leftover-experiment.mts`，8 条观测，退出码 0），**在副本里**，工作树无此文件。
- 程序化字节比对：**2** 个符号（`tryRecoverStaleOwnerTransferLock` 969 B、`release()` 135 B），均 identical。
- 落盘的验证日志：`head-tests.log`(153 行) / `base-tests.log`(178 行) / `head-typecheck.log` / `head-build.log` /
  `m1.log` / `m2.log` / `m3.log` / `probe.log`，**全部整份落盘、整份读回、未过滤**。
- 工作树状态检查：**3** 次。主仓库状态检查：**2** 次。
