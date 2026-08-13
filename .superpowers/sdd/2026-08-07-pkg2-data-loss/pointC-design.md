# 待裁点 C —— 逃生口设计（**进行中，未完成**）

> 前置：人裁 61 把「C 的逃生口设计」定为**裁 B 的前置条件**。本文只做设计与实测代价，**不动一行生产代码**。
> 红线：`tryRecoverStaleOwnerTransferLock` 一行不许动（人裁 50，B 未裁）。
> 材料复用：候选 E1–E4 出自 `pointB-design.md` §5.3，**本文不重开方向**，只补它自陈缺的那一半（「一个原型都没做」）。

## 0. 结论先写（截至目前）

1. *** **E4 在 C 的死锁轨迹上是空转，`pointB-design.md` §5.3 对它的「中等推荐」在这条轨迹上不成立。** ***
   已机械证实（见 §1）。
2. 逃生口只能落在**读/resume 路径**、**sweep**、或**显式命令**上 —— 即 E1／E3 一族，不是 E4。
3. 尚未测：E1、E3 的实际代价。E2（年龄阈值）是否上桌，取决于人对「无人值守必须永不死锁」的取舍（§3 的待答问题）。

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

## 4. 下一步（未做，按此顺序）

1. **E3 弱化版的代价**：`sweepRuns.ts` 今天完全不碰锁（`OBSERVED_FILES` 不含它），让它**只读、只报告**要付多少判据。
   ⚠️ 注意 §22.7／台账多处已记：registry **结构上读不到**这把锁，`pickReader` 对不在 `OBSERVED_FILES` 里的路径抛。
2. **E1 的代价**：新增 CLI 表面 ＋ 它自己的判据。⚠️ 它删锁 ⇒ **必须带身份/存活判据**，否则等于开一个新的偷锁面。
3. **E4 的端到端否证实测**（§1 欠的那一步）—— 结论已定，只欠把机械论证升级为实测。
4. 三项都有实测代价后，本文才够格当**裁 C 的裁决包**；**C 裁完才轮到 B**（人裁 61 的顺序）。
