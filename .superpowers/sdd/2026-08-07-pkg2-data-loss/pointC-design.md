# 待裁点 C —— 逃生口设计（**§4 三项实测已做完；C 本身仍未裁**）

> 前置：人裁 61 把「C 的逃生口设计」定为**裁 B 的前置条件**。本文只做设计与实测代价，**不动一行生产代码**。
> 红线：`tryRecoverStaleOwnerTransferLock` 一行不许动（人裁 50，B 未裁）。
> 材料复用：候选 E1–E4 出自 `pointB-design.md` §5.3，**本文不重开方向**，只补它自陈缺的那一半（「一个原型都没做」）。

## 0. 结论先写（截至目前）

1. *** **E4 在 C 的死锁轨迹上是空转，`pointB-design.md` §5.3 对它的「中等推荐」在这条轨迹上不成立。** ***
   已机械证实（见 §1）。
2. 逃生口只能落在**读/resume 路径**、**sweep**、或**显式命令**上 —— 即 E1／E3 一族，不是 E4。
3. 尚未测：E1、E3 的实际代价。E2（年龄阈值）是否上桌，取决于人对「无人值守必须永不死锁」的取舍（§3 的待答问题）。
   *** **已过期：E2 已由人裁 69 下桌（§3）；E1／E3 的代价已于 2026-08-19 实测完毕（§4）。** ***
4. **§4 的三项实测已完成，本文自此够格当裁 C 的裁决包**（§5 是待人拍的板，§6 是必须原样复述的残余）。
   **C 裁完才轮到 B**（人裁 61 的顺序未变）。

## 1. E4 是空转 —— 实测

**判据来源**：`ts.createSourceFile` 的 AST 标识符扫描（`scratchpad/callsites.mts`），扫 `src/` 下 30 个 `.ts`。
**不用 grep、不用花括号配平** —— 后者在 §24 骗过评审员，前缀同名兄弟在本仓库骗过两个人。

| 符号 | 标识符引用 | CALL 点 |
|---|---|---|
| `ensureFreshRunDir` | 2 | **1** —— `fileStore.ts:75`（在 `initializeRunFiles` 内） |
| `initializeRunFiles` | 3 | **1** —— `runLoop.ts:969`（**新建 run**） |
| `tryRecoverStaleOwnerTransferLock` | 2 | **1** —— `fileStore.ts:1139` |

*** **提取器验活（承重）**：同一次扫描在 `runLoop.ts` 里**找到了** `initializeRunFiles` 的 CALL，
却**没有**把同文件 973/975/988 行注释里的 `ensureFreshRunDir` 计为命中 ***
⇒ 检索面覆盖该文件（不是假阴性），且确实只认标识符（注释/字符串无法灌水）。

**论证**：`ensureFreshRunDir` 的 `blockingPaths`（`fileStore.ts:53-57`）**第一项是 `loop-contract.json`**。
C 的死锁对象是**一个已存在的 run** 的 runDir ⇒ 它必然已有 `loop-contract.json`／`loop-state.json`／`events.jsonl`，
而且它**不会再走 `initializeRunFiles`**（那是新建 run 的入口），它走的是 resume／读路径。
⇒ 把 `.owner-transfer.lock` 加进 `blockingPaths`：
- 在死锁轨迹上**永远轮不到被检查**（前面三项先抛）；
- 唯一能让它成为**首个**阻塞项的 runDir，是「有锁但无 contract/state/events/attempts/worktrees」——
  而锁只由 `acquireOwnerTransferLock` 在**已存在的 run** 的转移过程中创建 ⇒ 该组合基本不可达。

⚠️ **仍欠一步实测**：端到端造出死锁 runDir、跑 resume 路径、证明「加不加 E4 输出逐字节相同」。
本文的结论目前是**机械论证 ＋ 调用点实测**，按本仓库口径（「读代码的机械论证不等于实测」）**尚未升级为端到端实测**。

## 2. 静默的两层（复述 `pointB-design.md` §5.2，未复测）

1. **恢复侧**：`recoverInterruptedOwnerTransfer` 未持锁分支的 `catch { return; }` 吞掉取锁失败 ⇒ 读不报错，恢复"没发生"。
2. **生产侧**：`ensureFreshRunDir` 的 `blockingPaths` 不含这把锁；`sweepRuns.ts` 完全不引用它；
   全 `src/` 除 `tryRecoverStaleOwnerTransferLock` 与 `release()` 外无任何代码删除它。
⇒ **测试是唯一防线。**

## 3. 人裁 69 —— **不要求永不死锁，但必须响亮**

*** **人裁 69。2026-08-13。「不要求，但必须响亮」。** ***

⇒ **E2（年龄阈值）下桌** —— 本仓库**不为逃生口把时钟引入正确性**（与 `pointB-design.md` §4.1 O3 的一贯口径一致）。
⇒ **逃生口 = E1（显式解锁命令）＋ E3 弱化版（sweep 只报告、不回收）**，两者都不引入时间判据。
⇒ **接受的残余**：无人值守时坏锁仍会**卡住**转移路径，但**不再静默** —— 代价是需要人来一次。
**这条残余必须在裁 B 时被原样复述，不许淡化成「已解决」。**

## 4. 三项实测代价（**已做完，2026-08-19**）

### 4.0 方法与自证（先证工具是活的，再信它的结论）

**基线**（主仓库根，未过滤整份读回，`RUN` 路径已核）：`31 files / 535 tests` 全绿、零 skipped；
`typecheck` rc=0；`build` rc=0。

**变异环境**：`git clone --local` 副本 ＋ 主仓库 `node_modules` 符号链接（省掉 `npm ci`）。
*** **未变异 sanity 先验活**：副本 `534 绿 ＋ 唯一红 = 名单内 flake (B)**
（`evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at
the spawned pid`，`Test timed out in 5000ms`），**隔离复跑 2/2 绿**（2705ms／2589ms）
—— 与台账对 (B) 的记载（全套件并行负载下超时、隔离连过）逐字对上。 ***

**提取器验活（承重）**：`ts.createSourceFile` 标识符扫描，扫 `src/` ＋ `tests/` 共 **61 个 `.ts`**，
**无一文件标识符计数为 0**（扫描面无洞）。同一次扫描在 `sweepRuns.ts`（260 个标识符）里
**找到了** `isObservedEligible` 的两处真命中（:103／:129），却**没有**把该文件 **第 100 行注释里的
`OBSERVED_FILES`** 计为命中 ⇒ 面覆盖该文件、且只认标识符。

**还原**：四轮变异（A1／A2／C／D／E4）**全部只在副本里**，每轮还原后
`git diff` 与 `git diff --cached` **均为 0 字节**；主仓库全程 `git status --porcelain` 空。

---

### 4.1 E3 弱化版的代价 —— **实测**

**结构事实（全称，AST 扫描）**：`.owner-transfer.lock` 字面量全仓 **45 处**，
其中 **`src/` 下只有 1 处** —— `fileStore.ts:652` 的常量定义；其余 44 处全在 `tests/`。
`readObservedFile.ts:39 pickReader` 的 `default:` 分支是 `throw new Error("no reader bound for …")`
⇒ **registry 结构上读不到这把锁**，此前台账多处的说法在 HEAD 上**现测成立**。

*** **判据 1（最贵的一条，机械论证）**：这把锁**今天唯一的读取实现**是
`tryRecoverStaleOwnerTransferLock` 内部的行内 `readFile` ＋ `JSON.parse`（`fileStore.ts:906`／`:916`）
—— 而那个函数是**人裁 50 的红线，一行不许动**。
`readObservedFile.ts:25-28` 自陈的 spec §7.2 是「绑定 fileStore 已在跑的同一批纯读取器，
使得不存在第二套 JSON 读取实现去与第一套漂移」。
⇒ 给 registry 绑一个锁读取器，只有三条路，**每条都要人拍板**：
(i) 新写一个读取器 = **正是 §7.2 禁止的第二套实现**，而第一套在红线函数里；
(ii) 把读取从红线函数里提出来复用 = **动了红线**；
(iii) 解封人裁 50。 ***

**变异 A1 —— 行契约从 3 条长到 4 条**（把锁收进 `OBSERVED_FILES` ＋ 绑读取器 ＋ `pickReader` 分支）：
- **`ObservedFileSpec` 类型无需改动**：锁内容是 `{holderProcessInstanceId, acquiredAt}`，两个 `string`，
  落在现有 `FieldType` 域内。**`src/` 侧 typecheck 零错。**
- **`typecheck` 4 错**，全是手搭 `RunFileReaders` 桩的测试：
  `observeRun.test.ts:19`／`readObservedFile.test.ts:37`／`renderRuns.test.ts:181`／`scanRuns.test.ts:72`
- **套件 5 红**（具名，全在 L2 行契约上）：
  1. `observeFields.test.ts > OBSERVED_FILES > contains exactly the three spec'd files with their declared fields`
  2. `observeRun.test.ts > observeRun > observes all three files with every field present for a fully populated run`
  3. `observeRun.test.ts > observeRun > reports absent files as full rows with every field absent, never omitting them`
  4. `observeRun.test.ts > observeRun > still reports the other two files when one reader throws an unexpected error`
  5. `scanRuns.test.ts > scanRuns > recognizes a run directory by any single marker file, reporting the rest absent`
- **没红的**：`renderRuns` 的渲染断言、`cli.test.ts` 的 `ls` 输出断言 —— 它们不按整段输出比对。

**变异 A2 —— 叠加 sweep 的「只读只报告」半边**（遍历 `rows` 而非 `candidates`）：
- **`typecheck` 不增错；套件相对 A1 增红 0 条。**
- ⚠️ A2 那一跑里出现的第 6 条红是
  `runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`
  —— *** **台账 §2 那条已挂账的名单外失败**，按完整测试名与失败形态（`ENOENT … attempts/1/plan.json`）
  逐条对上，**不重新调查**。 *** 另有两条独立归因：AST 全称清单显示 `sweepRuns` 的调用点只有
  `cli.ts`／`zeroWrite.test.ts`／`sweepRuns.test.ts`，**不含该测试文件**（机械不可达）；
  隔离复跑 **2/2 绿**（793ms／630ms）。
- *** **A2 零新红这件事本身是个发现**：sweep 的 stderr 契约松到「新增一条 note 行不碰任何测试」，
  ⇒ **加它很便宜，但也没有任何测试会在它将来失效时红。** ***

*** **判据 2 —— 报告面必须遍历全部 rows，理由是实测出来的**（`ccloop sweep` ＋ `ccloop ls` 现跑，
一个根下放两种死锁形态，两个 run 卡在同一把坏锁上）： ***

| 形态 | 盘上 | 今天 `ccloop sweep` 说什么 | 今天 `ccloop ls` 说什么 |
|---|---|---|---|
| **形态 2** 资格齐全 ＋ 坏锁 | 有 `owner-transfer.json`（`eligibleForContinuation: true`） | *** **已经响亮** *** —— `…/shape2-eligible	refused	owner-transfer lock busy: OwnerTransferLockBusyError` | 列出该 run，**但整行不含一个字提到锁** |
| **形态 1** 转移中途死掉 ＋ 坏锁 | **无** `owner-transfer.json` | *** **一个字都不报** *** —— 不进候选集，连横幅计数都不含它 | 列出该 run，`eligibleForContinuation: absent`，**同样不含一个字提到锁** |

⇒ **收窄一条此前的说法**：「死锁的 run 进不了 sweep 候选集」**只对形态 1 成立**；形态 2 今天就已经被报为
`refused`。**E3 弱化版真正买到的东西是形态 1 的可见性**，而那要求报告遍历 `rows`（全部）而不是
`candidates`（过滤后）—— 这是一个**新的输出面**，不在 §8「每个被尝试的 run 一行」的契约之内。

**判据 3**：`RUN_MARKER_FILES`（`scanRuns.ts:30`）要不要加这把锁？
不加 ⇒ 只剩一把锁的目录不被认作 run（本轮未变异，未测）；加 ⇒ 改的是 spec §4 的识别语义。**留给人。**

**判据 4**：若走「sweep 直接 stat 锁路径、绕开 registry」这条路，
`sweepRuns.ts` 第 4-5 行自陈的不变量 —— 「**a PURE FUNCTION … reads no file under any run directory (§3 #1)**」
—— *** **会被直接推翻**。 *** 这条路**便宜但要人明令改掉那句自陈**。

---

### 4.2 E1 的代价 —— **实测**

**身份／存活原语的可用面（全称，AST 扫描，含 exported/module-private 判定）**：

| 符号 | 位置 | 可见性 | 调用点 |
|---|---|---|---|
| `parsePid` | `fileStore.ts:882` | **module-private** | **唯一 1 处：`fileStore.ts:917`，在红线函数内** |
| `isProcessActive` | `fileStore.ts:887` | **module-private** | **唯一 1 处：`fileStore.ts:919`，在红线函数内** |
| `safeUnlink` | `fileStore.ts:868` | **module-private** | 20 处，全在 `fileStore.ts` 内 |
| `acquireOwnerTransferLock` | `fileStore.ts:1081` | **module-private** | 4 处，全在 `fileStore.ts` 内 |
| `buildProcessInstanceId`（**强身份**） | `processIdentity.ts:9` | **exported** | 广泛使用；**但锁记录不记它** |

⇒ **E1 要删锁就要判据，而判据原语一个都不在模块外可达**，且它们**唯一的既有调用点就在红线函数里**。

*** **判据 5 —— E1 不能升级锁的身份形式。这一条是实测，不是推理。** ***
**变异 C**：只把 `acquireOwnerTransferLock` 写入的 `holderProcessInstanceId` 从弱形式
`pid:<pid>` 换成强形式 `buildProcessInstanceId()`（`pid:<pid>:<timeOrigin>`）——
**一行改动，`typecheck` 零错，红线函数一行未动**。结果 **3 条红，全是互斥性崩塌**：
  1. `fileStore.test.ts > recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker > lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing`
     —— `renameCount` **4 而非 2**：两个读者**都**完成了事务。
  2. `runLoop.integration.test.ts > runLoop > abandons the loser's reconciliation write against the winner's held transfer lock and finalizes none of the winner's transaction inside the publish window`
     —— 放弃 **0 次而非 1 次**：输家**没被挡住**。
  3. `runLoop.integration.test.ts > runLoop > keeps the winner's reconciliation record as the terminal state when the loser's write is forced to land after the winner's last rename`
     —— `loserReachedItsOwnPublish` **true**：输家**对着活锁发布了**。

**机制**：`parsePid` 的正则是 `/^pid:(\d+)$/`，对强形式返回 `null`
⇒ `if (pid !== null && isProcessActive(pid)) return false;` 整条守卫被跳过
⇒ 直落 `safeUnlink` ⇒ *** **红线函数变成一个无条件偷锁器。** ***
（`fileStore.ts:724-726` 的注释已经预写过这件事：那个弱形式「as written 是正确的 …… do not "unify" it」。
本轮把它从注释升级成了**实测**。）
⇒ **E1 的存活判据只能是裸 pid 的 `process.kill(pid, 0)`** —— 与 C-1 两个失败开放出口**共用同一套判据**；
`acquiredAt` 是时钟，**人裁 69 已把时钟排除出正确性**。

**变异 D —— E1 的 CLI 表面**（第五条命令 `unlock` ＋ 它自己的判据；判据复用 `fileStore` 内的
`parsePid`／`isProcessActive`，**不另起第二套存活实现**；红线函数一行未动）：
- *** **`typecheck` 零错，套件 535/535 全绿。** ***
- *** **零处测试钉住命令集或那句报错文案。** *** `cli.test.ts` 里只有 `missing required flags` 被正则钉住；
  把 `"expected \`run\`, \`resume\`, \`sweep\`, or \`ls\` command"` 改成含 `unlock` 的版本，**没有任何测试红**。
- ⇒ **CLI 表面的代价在「会撞红多少测试」这个尺度上≈0** —— *** **而这正是危险所在：
  新开一个删锁面，没有任何一条现有测试会拦它。** ***

**端到端跑通（`node dist/src/cli.js unlock <runDir>`，五种情形）**：

| 锁内容 | exit | 锁还在? | 输出 |
|---|---|---|---|
| 不存在 | 0 | — | `absent  no owner-transfer lock present` |
| `pid:<死 pid>` | 0 | 否 | `removed  holder=pid:999999 was not alive` |
| `pid:<活 pid>` | 1 | **是** | `refused  pid 16814 is alive` |
| 强身份形式 | 1 | **是** | `refused  unrecognized holder identity: …` |
| 坏 JSON | 1 | **是** | `refused  lock unreadable: …` |

*** **判据 6 —— E1 一旦落地，同一把锁上会存在两套互相矛盾的判据。** *** 上表的 E1 是 **fail-CLOSED**
（读不懂就拒删）；而红线函数在同样两种情形下是 **failure-OPEN**：
身份形式认不出 ⇒ `pid === null` ⇒ 跳过存活判据 ⇒ `safeUnlink` **偷锁**（出口 #1）；
`JSON.parse` 抛且存在 staged artifacts ⇒ `safeUnlink` **偷锁**（出口 #2，更宽）。
⇒ **同一把坏锁，`ccloop unlock` 拒绝，而正常转移路径会把它抢走。**
**E1 的 fail-closed／failure-open 取向必须由人明确拍板，不能由控制器默认。**

---

### 4.3 E4 的端到端否证 —— **实测**（§1 欠的那一步已补上）

**夹具 = C 的真实死锁轨迹**（不是 §1 那种「读就拒了」的浅版本）：
按 `resumeLoop.integration.test.ts` 的 `seedEligibleRun` 形状造一个**资格齐全**的 run
（contract／state／events／owner-record／owner-transfer(`eligibleForContinuation: true`)／reconciliation-record），
再植入一把**永不可回收**的坏锁（`{not json` ＋ 无 staged artifacts
⇒ 红线函数走 `catch` 分支、`hasStagedArtifacts === false` ⇒ `return false`）。
实测轨迹：resume **过了全部读与资格判定** → claim → `acquireOwnerTransferLock` EEXIST
→ 红线函数拒绝回收 → `OwnerTransferLockBusyError` → 有界重试耗尽 → `resume_denied`，**锁留在盘上**，exit 1。

**噪声底先测**：基线连跑两次，原始输出差异**只有三处** —— 标签、临时 runDir 路径、时间戳。

**结果**：加 E4（`blockingPaths` 加入 `.owner-transfer.lock`，`fileStore.ts:53-57`）后重建重跑，
共四份输出（base×2、E4×2）。规范化（标签／时间戳／runDir 路径）后：
*** **四份 md5 全等 `653ab5b85434dc568dc8368a67d6b9b2`，长度全为 636B。** ***
未规范化时唯一的差异是 `events.jsonl` 的字节数（294／294／291／292），
**算术上被路径长度完全解释**：`size − len(runDir)` 四份**全等于 229**。

⇒ *** **E4 在 C 的死锁轨迹上输出逐字节相同 —— 空转。§1 的机械论证本轮升级为端到端实测。** ***

---

## 5. 裁 C 需要人拍的板（**控制器不替人选**）

前置已定：**人裁 69** —— 不要求永不死锁，但必须响亮；**E2（年龄阈值）已下桌**；
逃生口收敛为 **E1 ＋ E3 弱化版**。三项实测齐了，剩下的都是取舍，不是事实问题。

| # | 要拍的板 | 实测给出的约束 |
|---|---|---|
| **C-a** | **E3 走哪条路** | (i) 进 `OBSERVED_FILES`：typecheck 4 错 ＋ 5 条具名红，且**必然撞上 §7.2 与人裁 50 的红线**（判据 1）；(ii) sweep 直接 stat：不撞红线，但**推翻 `sweepRuns.ts` 自陈的 §3 #1 不变量**（判据 4） |
| **C-b** | **E3 报不报形态 2** | 形态 2 **今天已经响亮**。E3 只在**形态 1** 上买到新可见性，代价是一个**遍历全部 rows 的新输出面**（判据 2） |
| **C-c** | `RUN_MARKER_FILES` 加不加锁 | 未测。加 = 改 spec §4 识别语义（判据 3） |
| **C-d** | **E1 的判据取向** | 只能是**裸 pid 存活**（判据 5，实测：升级身份 ⇒ 红线函数变无条件偷锁器）。fail-closed 还是 failure-open **必须人定**，因为它会与 C-1 的两个出口**公开矛盾**（判据 6） |
| **C-e** | **E1 要不要带自己的测试** | 实测：新增删锁命令 **535/535 全绿、零测试拦它**。不补测试 = 开一个**无人看守的删锁面** |
| **C-f** | E4 | *** **已否证，端到端。建议直接从逃生口候选里划掉。** *** |

## 6. 残余（**裁 B 时必须原样复述，不许淡化**）

*** **无人值守时坏锁仍会卡住转移路径，但不再静默 —— 需要人来一次。** ***
本轮实测给这句话补了两处**精确边界**，复述时一并带上：
1. **resume 路径今天并不静默** —— 实测 stderr 有
   `owner-transfer lock busy: OwnerTransferLockBusyError`，events 有 `resume_denied`。
   pointC-design §2 说的「静默」是**读路径**（`recoverInterruptedOwnerTransfer` 未持锁分支的
   `catch { return; }`），**不是这条 resume claim**。两者不要混为一谈。
2. **真正静默的是形态 1**：`owner-transfer.json` 从未落盘的死锁 run，
   `ccloop sweep` **一个字不报**、`ccloop ls` 的行里**没有一个字提到锁**。

**C-1 仍是降级、未关闭**：`tryRecoverStaleOwnerTransferLock` 的两个失败开放出口**逐字节未动**
（本节所有变异只在 `git clone --local` 副本里，四轮还原均证 `git diff` 与 `git diff --cached` 为 0 字节）。
