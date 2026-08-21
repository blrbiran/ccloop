# 待裁点 B —— 裁决包 **v2（post-E1／E3 版）**

> 作者：控制器（2026-08-21）。**本文件不实施、不裁决。**
> 它把 `pointB-ruling-package.md`（v1，测于 `d6bd51c`／**533 条**／**E1 未落**）更新到今天的现状，
> 并把 v1 之后**已经变了**的四件事逐条标出来。**每条事实都标注它测于哪个面；v1 的数字一律不直接继承。**
> 本文测于主仓库 `main`，其时 HEAD 是 `docs(handoff): rewrite the session log for a fresh agent, and price the loop` 那一笔
> （**提交本文会让 HEAD 前移，别把这行读成"当前值"**）。门锚点 `86d3bd6`（GATE-PKG2）为固定引用。

## 0. 结论（最先填，全部来自本次跑）

1. **两个失败开放出口今天仍在，出口 2 仍比出口 1 宽** —— 出口枚举探针现测，见 §3。
2. **B 的原文（只关 `catch`）实测仍盖不住出口 2** —— BUILD_A 上出口 2 原样 STOLEN。v1 的结论在新基线上复现。
3. **扩大措辞的判据增量仍然 = 0** —— BUILD_A 与 BUILD_B′ 推翻的是**同一个集合**，`2 failed | 598 passed`，两跑逐条相同（同名、同行、同报错）。
4. *** **代价比 v1 便宜了：从 3 个 `it()` 块降到 2 个。** *** 那个逐字重复块已按**人裁 53 第 3 件**删除
   （提交主题行：`test(fileStore): delete three byte-identical duplicate test blocks`，在 GATE-PKG2 之后）。
5. *** **v1 的 R3「B 与 C 必须同批裁」，其论据已经被 E1／E3 消解了一大半 —— 但没有全消。** *** 见 §2 与 §6。
6. *** **开着的第 7 项（红线里的假阳性"活"）与 B 正交：B 既不修它，也不恶化它。** *** 现测：`pid:0` 与溢出 pid
   在**今天的 HEAD 上就已经是永久 REFUSED**，B 的两种措辞都不改变这一格（§3 末两行）。

## 1. 本文的实测基线

| 项 | 值 |
|---|---|
| 主仓库全量跑（`rtk proxy`、未过滤、整份读回、`RUN` 路径已核 = `/Users/biran/code/skills/loop/ccloop`） | `Test Files 34 passed (34)` ／ `Tests 600 passed (600)`，**零 skipped**，`TEST_RC=0`／`TYPECHECK_RC=0`／`BUILD_RC=0` |
| 红线函数 | `tryRecoverStaleOwnerTransferLock` 与 `86d3bd6` **逐字节一致**：两侧 **970 字节**，`diff rc=0`，签名命中数两侧 **=1**（防同前缀兄弟） |
| 变异测量面 | **本地 clone**（`git clone --local`，HEAD 与源同为 `558c54f`）＋ 符号链接复用 `node_modules`；**不进 `git worktree` 注册表**（现验：`git worktree list` 只有主仓库） |
| 该面的 sanity（未变异） | `1 failed | 599 passed` —— 唯一的红是**名单内 flake (B)**：`evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（5004ms 超时）。**按完整测试名比对，未重新调查。** |

## 2. v1 之后变了的四件事（**这是本文存在的理由**）

| # | v1 怎么写的 | 今天的实测 |
|---|---|---|
| **1** | 爆炸半径 = **3 个 `it()` 块**（`:844` ／ `:1276` 逐字重复块 ／ `:1483`） | *** **2 个** ***：`:844` 与 `:1419`。重复块已按人裁 53 第 3 件删除；`:1483` 因行号腐坏现为 `:1419`。**测试名与语义未变** |
| **2** | 「失败关闭 ⇒ 坏锁**零逃生口**」 | *** **逃生口已落地** ***：`ccloop unlock <runDir> [--force --expect <sha256>]`，打的正是这把锁（`inspectLock.ts:90` 用 `OWNER_TRANSFER_LOCK_FILE`）。且它是**三态**（人裁 74）：`pid:0`／溢出 pid／EPERM 归 `liveness-unknown` 而非 `alive` ⇒ **`--force` 救得了它们** |
| **3** | 「形态 1 **完全静默**」 | *** **部分解决** ***：`sweep` 现在对**每一个盘上有锁的 row**（不是 candidate）打 `note … owner_transfer_lock_present`（`sweepRuns.ts:174-181`，人裁 70 板 C-b）。⚠️ **`ccloop ls` 仍然一个字不提锁**（现验：`src/registry/renderRuns.ts` 全文无 `lock`） |
| **4** | 吞错点在 `fileStore.ts:1216-1224` | **仍在，行号已腐坏**：现为 `1321-1329`（`recoverInterruptedOwnerTransfer` 未持锁分支的 `catch { return; }`，注释自陈「must not surface a new failure mode」）。⇒ **符号锚定有效，行号不可引用** |

## 3. 出口枚举（PRISTINE ／ BUILD_A ／ BUILD_B′）

探针**只经公开入口** `claimOwnerRecordWithPrecondition` 驱动，**没有给源码加任何 `export`**。
判定口径同 v1：`OwnerTransferLockBusyError` ⇒ REFUSED；其余任何抛出或成功 ⇒ STOLEN；并同时记录锁文件是否还在盘上（两者逐行一致）。
活进程夹具 = **探针自己的 pid**，且**在每一格的断言时刻**重新 `kill(pid,0)` 核过（输出里 `liveFixtureAlive` / `deadFixtureAlive` 两列就是它）。

| 用例 | PRISTINE | BUILD_A（只关 `catch`） | BUILD_B′（关全部非 liveness 出口） |
|---|---|---|---|
| `pid:<探针自己>`（活），无 staged —— **必命中 REFUSED** | REFUSED | REFUSED | REFUSED |
| `pid:4000000`（已死），无 staged —— **必命中 STOLEN** | STOLEN | STOLEN | *** **STOLEN** *** |
| `not-json` ＋ staged（**出口 1**） | **STOLEN** | REFUSED | REFUSED |
| `not-json`，无 staged | REFUSED | REFUSED | REFUSED |
| `{"acquiredAt":…}` 无 holder（**出口 2**） | **STOLEN** | *** **STOLEN** *** | REFUSED |
| `{"holderProcessInstanceId":"uuid:abc"}`（**出口 2**） | **STOLEN** | *** **STOLEN** *** | REFUSED |
| **`pid:0`**（开着的第 7 项） | **REFUSED** | REFUSED | REFUSED |
| **`pid:99999999999999999999`**（开着的第 7 项） | **REFUSED** | REFUSED | REFUSED |

- **第 2 行是关键对照**：BUILD_B′ 上「已死 pid」**依然 STOLEN** ⇒ 探针在该构建上仍有能力印出 STOLEN，
  同列的四个 REFUSED **不是假阴性**。
- **末两行是本轮新增**：`pid:0`（`kill(0,·)` 指调用者自己的进程组，永不抛 ⇒ 两态判据读成"活"）与溢出 pid（TypeError，非 errno ⇒ 同样读成"活"）
  **在今天的 HEAD 上就已经永久 REFUSED**。⇒ **B 不是这两格的原因，也不是它们的解药。** 解药是 E1 的 `--force`，或另裁把三态搬进红线函数。

## 4. 爆炸半径重测（600 条基线）

| 构建 | 变异 | 结果 |
|---|---|---|
| sanity | 无 | `1 failed | 599 passed` —— 仅 flake (B) |
| **A**（§23.3 原文） | `catch { … }` ⇒ `catch { return false; }` | **`2 failed | 598 passed`** |
| **B′**（v1 §5 修订措辞） | 同上 ＋ `if (pid === null \|\| isProcessActive(pid)) return false;` | **`2 failed | 598 passed`，与 A 逐条相同** |

**两条失败（A 与 B′ 完全一致）：**

| # | 完整测试名 | 现行号 | 断言 | 实测报错 |
|---|---|---|---|---|
| 1 | `fileStore > treats malformed lock contents with staged artifacts as stale and recoverable` | `:844` | `expect(owner.currentOwnerEpoch).toBe(2)` | `expected 1 to be 2` |
| 2 | `fileStore > releases the lock after recovering malformed staged state` | `:1419` | `await expect(readFile(lock)).rejects.toThrow()` | `promise resolved "'not-json\n'" instead of rejecting` |

⚠️ 变异锚点用**逐字块匹配并断言命中次数 = 1**（两个锚点各自打印了 `hit count = 1 OK`），不用行号、不用符号名前缀。
⚠️ **A 那一跑 flake (B) 是绿的（3737ms）** —— 不构成 flake 消失的证据，只说明那两条红不是它。

## 5. 选项矩阵（门后 ＋ E1 之后）

| # | 选项 | 关掉什么 | **打不开什么** | 判据代价 | 需要的新判据 |
|---|---|---|---|---|---|
| **O0** | 维持现状（B 不裁） | —— | 两个出口都开着，**但都只有外部写者／掉电能进**（O1 之后生产代码进不去） | 0 | 0 |
| **O2** | **§23.3 原文**：只关 `catch` | 出口 1 | *** **出口 2 原样开着（实测）** ***；`release()`；`pid:0`／溢出 pid 那两格 | **2 个 `it()` 块** | ≥1（失败关闭本身）。**逃生口那条已由 E1 兑现** |
| **O2′** | **修订措辞**：关掉全部非 liveness 出口 | 出口 1 ＋ 出口 2 | `release()`；`pid:0`／溢出 pid 那两格 | **2 个 `it()` 块（与 O2 相同）** | ≥1（同上） |
| **O3** | 年龄／租约 | 出口 1／2 的一部分 | 阈值内的篡改；`release()` | **仍未实测**（v1 那一格是旧材料的推断，本轮同样没做原型） | ≥3 |
| **O5** | `release()` 加身份校验（**独立轴**） | 误删他人的锁 | 两个出口都不关 | **已在人裁 62 落地并评审过**（§24）—— 这一格 v1 已过期 | —— |

⚠️ **O5 那一格 v1 写的是"待办"，现已过期**：`release()` 的身份校验（比 `dev`+`ino`，不是 pid）**已经实施并经独立评审**（台账 §24）。
⇒ **v1 的 R5 不再是一个待裁问题。**

## 6. 残余（**裁 B 时原样复述，不许淡化**）

> *** **无人值守时坏锁仍会卡住转移路径，但不再静默 —— 需要人来一次。** ***
> 1. **resume 路径今天并不静默**（stderr 有 `owner-transfer lock busy`，events 有 `resume_denied`）。
>    §2 说的「静默」是**读路径**的 `catch { return; }`，**不是这条 resume claim**，不要混。
> 2. **真正静默的是形态 1**（`owner-transfer.json` 从未落盘的死锁 run）：`ccloop sweep` 一个字不报、`ccloop ls` 的行里没有一个字提到锁。

**本轮对第 2 条的更正（必须与原文一起说）**：**形态 1 的静默已被 E3 部分解决** ——
`ccloop sweep` 现在会对每个盘上有锁的 row 打一行 `note … owner_transfer_lock_present`（现验于 `sweepRuns.ts:174-181`）。
⚠️ **但 `ccloop ls` 仍然一个字不提锁**（现验：`renderRuns.ts` 全文无 `lock`）⇒ **"部分"这两个字是字面意思，不许省。**

## 7. 仍需你拍板的问题

| # | 问题 | 现测依据 | 我的推荐（**是推荐，不是裁决**） |
|---|---|---|---|
| **R1** | **B 现在裁不裁？** | 两个出口今天仍只有外部写者／掉电能进；逃生口已存在；代价从 3 条降到 2 条 | **可以裁了。** v1 说"可以继续不裁"的两条理由（无逃生口、代价 3 条）都已经变了 |
| **R2** | 若裁 B，用 §23.3 **原文**还是 v1 §5 的**修订措辞**？ | 原文实测盖不住出口 2；扩大措辞判据增量为 **0** | **用修订措辞。** 没有任何成本理由支持裁一半 |
| **R3′** | **C 的逃生口今天够不够？**（v1 的 R3 是"B 与 C 必须同批裁"） | E1 已落且三态覆盖；E3 让 sweep 出声；**`ls` 仍不出声**；无人值守仍需人来一次 | **够开工，但请连带裁一句 `ls`**：要不要让 `ls` 也报锁。否则残余第 2 条只解决一半 |
| **R4** | 那 **2 个** `it()` 块怎么处理？**这是第八个具名例外的申请** | 2 条硬失败：`:844` 无来历注释；`:1419` 纯粹断言「坏锁被删」，**与 B 正面冲突** | ⚠️ **先答「这个仓库为什么需要第八个例外」再批**（人裁 44 之后台账里那条自我提问）。技术上：`:1419` 必须**整条改写**而非放宽 |
| **R6** | **B 的措辞里，liveness 用两态还是三态？** | 现测：`pid:0`／溢出 pid 今天已永久 REFUSED，B 的两种措辞都不改变；红线仍是两态 `isProcessActive` | **本轮先不动**（与 B 正交，动它要改红线函数、要另开一轮）。**但请明确一句**：B 的"已不存活"= **今天这个两态判据**，不是 E1 的三态。否则将来读者会以为 B 顺手修了第 7 项 |

## 8. 我没验到的（**Rule 12：以下都是「没验」，不是「验过没问题」**）

1. **掉电／内核崩溃后的锁内容（T2）** —— 没验，需真断电。
2. **darwin 之外的平台** —— 本包只在 darwin 上跑。⚠️ **整套在 Linux 上不绿（5 failed，第六位评审实测）**，本包**没有**在 Linux 上重跑任何一格。
3. **O3（年龄／租约）的判据代价** —— 没做原型，矩阵里那一格仍是旧材料的推断。
4. **双进程真争用** —— 本包没跑；探针是单进程顺序驱动的。
5. **`ccloop unlock` 在真实坏锁上的端到端演练** —— 本包只读了它的分类代码与常量，**没有真跑一次 `--force --expect`**。
6. **flake (B) 的性质** —— 按名单挂账、按完整测试名比对，未重新调查。
7. **包 1** —— 一个字没读（另一条线）。

## 9. 变异与还原证明

- 变异全部发生在 **clone**（`scratchpad/mutclone`）里，**主仓库工作树全程零触碰**。
  跑完现验（`rtk proxy` 取原始字节）：`git status --porcelain -u` **0 字节**、`git diff` **0 字节**、`git diff --cached` **0 字节**、
  HEAD 未动、`git worktree list` 只有主仓库、红线函数仍 **970 字节 `diff rc=0`**。
- clone 收尾已用 `cat pristine > target` 回退并 `diff` 现证 rc=0（**不用 `cp`** —— 本机 `cp` 有 `-i` alias，会静默不覆盖）。
- 全量跑：**4 次** = 主仓库基线 1 ＋ clone 3（sanity／A／B′），全部未过滤落盘并整份读回。
- 出口枚举：**5 次**（PRISTINE ／ A ／ B′ ／ PRISTINE-扩展 ／ B′-扩展），每次施加变异前断言锚点命中次数 = 1。
