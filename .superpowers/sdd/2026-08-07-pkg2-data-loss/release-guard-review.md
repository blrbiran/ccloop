# 独立评审 —— `release()` 身份校验（人裁 62/63）

范围 `d872532..feat/pkg2-release-guard`，工作区 `/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard`。
评审员为独立第二双眼睛。实施者报告 `release-guard-impl-report.md` 全程按**待验材料**处理，
其反向对照由我**重跑**，不是重读。

---

## 0. 结论（最先写）

**Critical 0 条，Important 0 条，Minor 5 条。**

**头号问题「修一个洞，是不是开了个新的」—— 答案是否定的，而且我有实测支撑，不是静态推断。**

第二轮的 Imp-1 是「在成功 `link` 之后、`return` 之前多了一条可抛语句」。这一轮的改动**没有**重复那个形状：
取锁路径（`acquireOwnerTransferLock` 除 `release` 闭包外的全部函数体）与 `tryRecoverStaleOwnerTransferLock`
**逐字节未动**，我用带必命中对照的探针独立验过（§3 Q7）。

更强的一条：`release()` 的可抛面不是「不增不减」（实施者的说法），而是**严格减少了**。
我实测到改动前存在、改动后消失的一条抛出路径 —— `lockPath` 被替换成目录时，
旧代码的 `safeUnlink` 抛 `EPERM` **穿出 `finally`**，新代码不抛（§3 Q1，探针格 7）。
这是往安全方向偏，但它证伪了实施者的自陈，所以照实记。

实施者自陈的两个「没验」我替他验了，结论都是往好的方向：
- 自陈 gap #7（同进程先后取两把锁只用 fixture 内容**模拟**过）—— 我**真跑了**先后两次取锁 ＋ 第一把锁的迟到
  `release()`，第二把锁**存活**（探针格 5）。这是 C-1 的真实场景，第一次被端到端复现并验证修好。
- 自陈 gap #3（inode 号复用会误判为「是我的」）—— 在**比较窗口内不可能发生**：比较发生在 `handle.close()` 之前，
  开着的 handle 把 inode 钉住，内核不可能把这个 ino 分配给别的文件。可降级。

判据质量合格：变异 A、B、D、E 全红，且**红在断言上**；反向的变异 C（一律拒删）打挂 7 个文件 76 条测试，
说明「过度拒删」有厚重的既有测试兜底。**唯一存活的变异是 F**（去掉 `dev` 只比 `ino`，535 条全绿）。

三条收口命令**全绿**：test `0`（31 files / 535 tests）、typecheck `0`、build `0`。

**建议：可以放行。** 5 条 Minor 都不阻塞，处置建议见 §2（与 finding 分开写）。

---

## 1. 分级 finding 清单

> 只陈述事实与可构造场景。**处置建议一律在 §2**，不在本节。

### Critical
无。

### Important
无。

### Minor

**M-1 —— 新事件类型确实触到了一个既有观测面：`evidence.ts` 的事件类型白名单。**
实施者自陈 gap #6 写明「**没有验事件被谁消费**」。我验了，检索面与必命中对照见 §3 Q3。
结果：全仓库对 events.jsonl 事件类型敏感的消费点只有一个 —— `validation/v1/lib/evidence.ts:638/651`：

```ts
const allowedEventTypes = new Set(["loop_planning", "loop_exhausted"]);
...
eventTypes.every((type) => allowedEventTypes.has(type))
```

`matchesPreExecuteExhaustion` 要求事件集合是 `{loop_planning, loop_exhausted}` 的**子集**。
`owner_transfer_lock_release_skipped` 一旦落进同一个 `events.jsonl`，这个子集判定即为假，该 run 就**不再**被判为
「pre-execute exhaustion」，落到后面的分支上，验证结论随之改变。
其余所有消费点都是 `eventTypes.includes("具体类型")` / `.find(type === "workspace_cleanup_failed")`，
对**新增**类型免疫。`RunEvent` 是 `{ type: string }`，**没有** zod schema、**没有** enum、**没有**穷举 switch。

**可构造场景**：一个在 execute 之前就 exhausted 的验证 scenario，同时该 run 期间发生过一次锁被夺
（并发第二控制器），于是 events.jsonl 里同时有 `loop_planning`、`loop_exhausted`、
`owner_transfer_lock_release_skipped` ⇒ `matchesPreExecuteExhaustion` 返回 false ⇒ 判定改变。
**今天的可达性**：现有 validation scenario 都是单控制器，不制造夺锁，因此**当前不可达**；
它是一条在未来引入并发 scenario 时会被踩到的耦合。**不是数据丢失，是验证判定的稳定性。**

**M-2 —— ENOENT 这一格的事件 `detail` 是错的（「left in place」，但盘上根本没有文件）。**
实测（探针格 2，锁在 `release()` 前已被删）：

```
{"type":"owner_transfer_lock_release_skipped","at":"...",
 "detail":".owner-transfer.lock no longer holds the inode this process published; left in place"}
```

`left in place`（原地保留）在这一格是**假陈述** —— 什么都没保留，文件不存在。
实施者自陈 gap #5 承认了「读不出锁」与「锁真的不是我的」被写成同一条，但**没有**提到这条 detail 在
ENOENT 格里是字面错误的。另外，改动前这一格是 `safeUnlink` 静默吞 ENOENT ⇒ **无事件**；
改动后**产生一条事件**，这是一个新增的观测面（也是 M-1 的触发条件之一）。

**M-3 —— 二次 `release()` 现在会产生一条虚假事件。**
实测（探针格 4）：同一个 lock 对象连调两次 `release()`，第二次因 handle 已关闭 ⇒ `handle.stat()` 抛 EBADF
⇒ 收敛成「不是我的」⇒ 记一条 `owner_transfer_lock_release_skipped`。改动前二次 release 是**完全静默**的
（`safeUnlink` 吞 ENOENT）。
**今天的可达性：不可达。** 我逐个查过全部 release 调用点（§3 Q1），5 处都是「一次取锁 → 一个 `finally` → 一次 release」，
不存在二次调用。属于潜在语义，不是现存缺陷。

**M-4 —— 「四个 `finally`」这个数字是错的，实际是五处。**
实施者在报告里专门「更正」了任务书（把「两处」改成「四处」），并列举了四个函数；
`fileStore.ts:987` 的承重注释也写 `four finally blocks`。**实测是 5 处**，全部在 `finally` 内：

| 行号 | 所在函数 |
|---|---|
| 546 | `preserveSuccessfulReconciliationIfNeeded` 的调用方（经 `acquireOwnerTransferLockForReconciliation`）|
| 1291 | `recoverInterruptedOwnerTransfer` |
| 1346 | `writeOwnerTransferArtifacts` |
| 1367 | `claimOwnerRecordWithPrecondition` |
| 1418 | `updateOwnerRecordWithPrecondition` |

被漏掉的是 **546**，即 reconciliation 那条经由同前缀兄弟函数 `acquireOwnerTransferLockForReconciliation`
间接持锁的路径。**行为上无影响**（它同样是单次 `finally` release，且同样受益于新守卫），
但它正是本仓库反复踩的「同前缀兄弟符号」盲区，所以按事实挂账。

**M-5 —— 存活变异：`dev` 比较没有任何断言钉住。**
变异 F（把 `onDisk.dev === published.dev && onDisk.ino === published.ino` 改成只比 `ino`）
⇒ **31 files / 535 tests 全绿，退出码 0**。
即判据的 `dev` 那一半是**未被测试覆盖**的。
**说明**：这不是代码缺陷 —— 代码比测试要求的更严格是对的；单文件系统下 `dev` 恒定，
要杀掉这个变异需要跨文件系统 fixture。据实记为「判据未完全被变异覆盖」，避免留下「变异覆盖完备」的错误印象。

---

## 2. 处置建议（与 §1 的 finding 分开）

> 控制器吃过「只读 finding 就派工」的亏，所以这一节是**独立的判断**，不是 finding 的一部分。
> 我的总体建议：**本轮不因这 5 条 Minor 返工**，全部可放行后处理。

| # | 建议处置 | 理由 |
|---|---|---|
| M-1 | **记入台账，本轮不改。** 若将来引入并发 validation scenario，届时再决定是把该事件排除出 `matchesPreExecuteExhaustion` 的集合判定，还是把白名单改成「忽略未知类型」 | 当前不可达；且真出现夺锁时，该 run 本就不是干净的 pre-execute exhaustion，重分类**可能反而是正确行为**。现在改属于无判据的投机修改，违反 Rule 2 |
| M-2 | **建议改，但可以并到下一轮。** 把 detail 拆成两种措辞（「盘上已无此锁」／「锁已不是本进程发布的那个」），或删掉 `left in place` 这半句 | 一行字符串，零行为风险；但它是**写进审计事件里的假陈述**，而审计事件的全部价值就是可信 |
| M-3 | **不改。** 记为已知语义即可 | 无调用点可达。为不可达路径加防御码是 Rule 2 明令禁止的投机 |
| M-4 | **建议把 `fileStore.ts:987` 注释里的 `four` 改成 `five` 并补上第 5 处** | 承重注释写错数字，会让下一个评审员按错误的调用面清单去核对。纯文档，零风险 |
| M-5 | **不改。** 明确记录「`dev` 未被覆盖」这一事实即可 | 补跨文件系统 fixture 的成本远高于收益，且 `dev` 比较本身是免费的保守加固 |

**关于放行**：以上没有一条构成阻塞。若人裁要求「零已知假陈述」，则只有 **M-2** 需要在合并前处理。

---

## 3. 任务书 §2 七问逐条

### Q1 新的可抛面 —— **证伪了实施者的「不增不减」，实际是严格减少**

静态：两个新 helper 的函数体**整体**包在 `try { … } catch { … }` 内，`try` 之外没有任何语句，
`catch` 块自身不抛（一个 `return false`，一个空块）⇒ 二者**不可能** reject。
`release()` 仍能抛的语句只剩 `handle.close()` 与 `safeUnlink(lockPath)`，均未改动。

实测（探针 7 格 × 2 轮：改动后 vs 变异 A 还原的改动前），这是**必命中对照**：

| 格 | 改动前（变异 A） | 改动后 |
|---|---|---|
| 1 正常 release | 锁删除，无事件 | 锁删除，无事件（**一致**）|
| 2 锁已不在盘上 | 无事件 | **多一条事件**（见 M-2）|
| 3 外来锁 ＋ events.jsonl 不可写 | **外来锁被删**（C-1 数据丢失）| 外来锁存活，不抛 |
| 4 二次 release | 静默 | **多一条事件**（见 M-3）|
| 5 迟到 release vs 新持有者 | **DELETED BY STALE RELEASE** | **STILL PRESENT** |
| 6 runDir 整个消失 | 不抛 | 不抛（**一致**）|
| 7 `lockPath` 被换成目录 | ***抛 `EPERM` 穿出 `finally`*** | **不抛**，目录保留，记事件 |

**格 7 就是结论的依据**：改动前 `safeUnlink` 对 `EPERM`（非 ENOENT）重抛，直接穿出四/五个 `finally`
之一，替换掉正在飞行中的错误 —— 与第二轮 Imp-1 完全同类的伤害。改动后这条路径不再可达。
⇒ **可抛面严格减少，没有新增。**

调用点核对（M-4 的来源）：5 处 `await lock.release()`，全部形如 `} finally { await lock.release(); }`，
每处对应同作用域内恰好一次取锁，**无二次 release 路径**。

### Q2 fstat 的时机与 `close()` 语义 —— **未破坏**

校验在 `handle.close()` 之前，理由成立且必要：fstat 需要活的 handle。
- `close()` 相对 `unlink` 的**先后位置未变**（仍是先 close 后 unlink）。
- `close()` 自身抛错时的行为与改动前**一致**：抛出后 `safeUnlink` 都不会执行，错误同样穿出。
  新代码只是在它之前多了两个**不可能抛**的调用，不改变 `close()` 的任何语义。
- 顺带的正面性质：把比较放在 close 之前，使**开着的 handle 在比较期间钉住了该 inode**，
  内核无法把这个 ino 分配给任何新文件 ⇒ 实施者自陈 gap #3（inode 复用致误判）在**比较窗口内被结构性排除**。
  唯一代价：`close()` 现在被两次 stat 延后（慢文件系统上略有延迟），无正确性影响。

### Q3 「锁已经不在盘上」这一格 —— 是新观测面，且触到一个既有消费点

行为实测（探针格 2）：`stat(lockPath)` ENOENT ⇒ `false` ⇒ 不删（本就无可删）＋ **记一条事件**。
**是否噪声**：正常单进程路径下不产生 —— 全仓库只有两处 `safeUnlink(lockPath)`
（`tryRecoverStaleOwnerTransferLock:933` 与 `release:1101`），我们自己持锁期间前者会因
`isProcessActive(本进程)` 为真而**拒绝**回收。所以这一格只在异常/并发下出现，**不是常规噪声**。
但它确实把这一格从「静默成功」变成了「产生事件」，见 M-2。

**「是否改变既有观测面」—— 这是全称否定，检索面与必命中对照如下：**

| 检索 | 命中 |
|---|---|
| `grep -rn "RunEvent" src/` | 2 处：`fileStore.ts:14` 类型定义 = `{ type: string; at: string; detail: string }`，`:86` `appendEvent` 签名 |
| `grep -rn "eventTypes" src/ validation/` | 17 处，**全部**在 `validation/v1/lib/evidence.ts` |
| `grep -rn "new Set(\[" src/ validation/` | 3 处：`fileStore.ts:1155/1156`（**文件名**集合，与事件无关）、`evidence.ts:638`（**事件类型白名单**）|
| `grep -rn "z.object\|safeParse" evidence.ts` | 3 处 safeParse：boundaryAnalysis / reconciliationRecord / executionRecovery —— **没有一个校验事件** |
| 事件解析入口 `readEventsObservation` (`evidence.ts:344-384`) | `JSON.parse` 每行后 `.map(e => e.type).filter(typeof === "string")` —— **未知 type 被原样收集，不拒绝** |

**必命中对照**：上述检索**确实命中了**两个已知的事件类型消费点 ——
`evidence.ts:651` 的白名单、`getCleanupOutcome:552` 的 `type === "workspace_cleanup_failed"` ——
证明检索面不是瞎的。

**结论**：不存在 zod schema 或 enum 会拒绝未知 `type`；`registry` / `scanRuns` 只把 `events.jsonl`
当**文件名**用（`scanRuns.ts:33`），不解析内容；`sweep` 走的是 `onReconciliationWriteAbandoned` **回调**，
不读 events.jsonl。**唯一**对类型集合敏感的消费点是 `matchesPreExecuteExhaustion` 的子集判定 ⇒ **M-1**。

### Q4 inode 判据的失效格 —— 今天均不可达，且其中一格被结构性排除

**inode 号复用**：比较期间 handle 处于打开状态，内核不能释放并复用该 inode ⇒
**比较本身不可能因复用而误判**。实施者把它列为未测风险，实际是**结构性不可能**（见 Q2）。可降级。

**TOCTOU（`stat` 与 `unlink` 之间被夺锁）**：窗口真实存在。但要在该窗口夺锁，攻击者必须先删掉我们的锁；
合法路径 `tryRecoverStaleOwnerTransferLock` 读到 `pid:<本进程>` 后 `isProcessActive` 为真 ⇒ **拒绝回收**。
所以只要本进程存活，**仓库内不存在能在该窗口夺锁的合法代码路径**。
残余窗口从改动前的「整个 release 期间」收窄到「stat→unlink 两条 syscall 之间」—— **严格变好**。
**是否需要判据钉住**：见 §2，我的判断是**不需要**（finding 与处置已分开）。

### Q5 判据质量 —— 我自己造变异复核，A/B 均按实施者所述红，另加 4 个

每个变异都跑**完整套件**（不过滤），跑完立即从 pristine 备份还原并打印 `git diff` / `--cached` 字节数。

| 变异 | 内容 | 结果 | 判读 |
|---|---|---|---|
| **A** | 还原成无条件删（改动前行为）| **1 failed / 534 passed**，唯一失败＝新增的夺锁用例 | 红在断言（`lock: "GONE"`, `events: []`）。且**只有**新用例挂 ⇒ 印证「既有覆盖为零」，新判据是承重的 |
| **B** | 换回 `pid:<pid>` 判据（旧原型）| **1 failed / 534 passed**，同一条用例 | **「inode 强于 pid」这一主张成立。** fixture 故意把外来锁写成本进程自己的 pid，pid 判据据此判定「是我的」并删掉别人的锁 ⇒ 该用例是真的在区分两种判据，不是摆设 |
| **C** | 守卫一律返回 false（全部拒删）| **76 failed / 459 passed，7 个文件** | 反向过度拒删被既有测试厚重兜底；**新增的对照臂也在其中** ⇒ 对照臂非空转 |
| **D** | 守卫一律返回 true（等价 A，但走 helper）| 1 failed，同 A | 与 A 一致，helper 层无旁路 |
| **E** | 保留拒删、**删掉记事件** | 1 failed | 事件断言是承重的，不是装饰 |
| **F** | 只比 `ino`，去掉 `dev` | **535 passed，退出码 0 —— 存活** | ⇒ **M-5** |

**是否恒绿 / 反空转**：两条新 `it()` 各自带反空转断言（`thefts` 为 1 / 为 0）。
变异 D 杀掉正面臂、变异 C 杀掉对照臂 ⇒ **两臂都有区分力，均不可能恒绿**。

### Q6 既有判据零破坏 —— 数值证明

`git diff --numstat d872532..HEAD -- tests/persistence/fileStore.test.ts` ⇒ **`133  0`**
（133 增，**0 删**）。测试文件为**纯追加**，不存在被改写或被放宽的既有断言。

### Q7 红线 —— 独立复验，带必命中对照，且避开了同前缀兄弟符号

探针以 `function <名字>(`（**含左括号**）为锚，这正是把 `acquireOwnerTransferLock(` 与
同前缀兄弟 `acquireOwnerTransferLockForReconciliation(` 区分开的判别位；
探针对每个符号打印「匹配到几处声明」，匹配数 ≠ 1 即报错退出，**不会静默取错**。

| 符号 | 声明匹配数（旧/新）| 结果 |
|---|---|---|
| `tryRecoverStaleOwnerTransferLock` | 1 / 1 | **逐字节一致**（35 行）|
| `acquireOwnerTransferLock` | 1 / 1 | **DIFFERS —— 且差异只有 `release` 闭包那 9 行**（必命中对照：证明探针有区分力）|
| `acquireOwnerTransferLockForReconciliation` | 1 / 1 | 未变（见下方订正）|
| `safeUnlink` | 1 / 1 | 逐字节一致 |
| `discardLockStaging` | 1 / 1 | 逐字节一致 |

**我自己探针的一处缺陷，据实说明**：花括号配平法对**多行签名 ＋ 返回类型里带 `{}`** 的函数会提前收尾 ——
`acquireOwnerTransferLockForReconciliation` 只抽出了 4 行，**不足以支撑「整个函数未变」**。
故该行结论**不采用**探针，改用下面这条更强的证据。

**全称证明（权威）**：该文件的完整 diff 共 **4 个 hunk**，且仅此 4 个：

```
@@ -1,4 +1,5 @@                 imports（加 stat / FileHandle）
@@ -963,6 +964,55 @@            插入两个新 helper
@@ -993,8 +1043,11 @@           承重注释改写
@@ -1035,7 +1088,16 @@          release 闭包
```

`tryRecoverStaleOwnerTransferLock`（901–935）、`acquireOwnerTransferLockForReconciliation`（460–485）、
以及 `acquireOwnerTransferLock` 除 release 闭包外的全部函数体，**均不落在任何 hunk 内 ⇒ 定义上未改动**。
**红线成立。**

---

## 4. 收口：三个退出码与 `RUN` 路径

在本 worktree 内、`ECC_GATEGUARD=off DISABLE_OMC=1`、**未过滤**、干净树（跑前 `git diff` / `--cached` 均 0 字节）：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test` | **0** | **Test Files 31 passed (31) / Tests 535 passed (535)**，Duration 18.45s |
| `npm run typecheck` | **0** | `tsc --noEmit -p tsconfig.json`，无输出 |
| `npm run build` | **0** | `tsc -p tsconfig.json` ＋ dist/cli.js 生成 |

vitest 首行 `RUN`：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard
```

**基线对照**：任务书给的 `d872532` 基线为 31 files / 533 tests，本分支应为 **535** ⇒ **实测 535，吻合。**
**名单外失败：0 条。** 未触发任何 flake，(B)/(F) 两条豁免均未动用。

**还原证明**：全部 8 次源码临时改动（变异 A–F ＋ 两次临时 `export`）逐次还原，
每次还原后打印 `git diff` 与 `git diff --cached` 字节数，**9 次全部为 `0 / 0`**。
最终工作区状态：`git status --porcelain` 仅剩两个未跟踪的 `.md`（任务书与本报告），**无源码改动残留**。

---

## 5. 我**没有**验到的

按 Rule 12 逐条列出，不挥手放过：

1. **NFS ／ 跨文件系统上 `dev`+`ino` 的行为。** 只在本机 darwin 24.6.0 单文件系统上跑过。
   这也是变异 F 无法被杀掉的同一个原因。
2. **Linux 上探针格 7 的 errno。** 我实测到的是 macOS 的 `EPERM`；Linux 对 `unlink(目录)` 给 `EISDIR`。
   两者都非 ENOENT ⇒ 结论（改动前会抛穿 `finally`）不变，但**Linux 未实跑**。
3. **真实并发下的 TOCTOU。** 我论证了它在仓库内不可达（Q4），**没有**构造多进程实验去实打实地撞那个窗口。
4. **M-1 的端到端后果。** 我证明了白名单会因新类型而失配，**没有**真跑一个 validation scenario
   把判定翻转出来 —— 因为现有 scenario 不制造夺锁，构造它需要新写并发 fixture。
5. **事件的下游接线是否*应该*存在**（sweep stderr note / runLoop 判断）。这是人裁范畴的新决策，
   实施者自陈 gap #6 也说明没做；我只验了「不接线不会打坏既有消费点」，**没有**评价该不该接。
6. **lint ／ 格式检查。** 仓库 `package.json` **不存在** lint script，三条收口命令之外我没跑别的。
7. **`handle.stat()` 在异常文件系统状态下的完整 errno 谱。** 我覆盖了 EBADF（格 4）、ENOENT（格 2）、
   目录（格 7）、runDir 消失（格 6），**没有**覆盖 ESTALE / EIO 等需要特殊挂载才能造出的 errno。
8. **性能影响。** 每次 release 多两次 stat syscall，我**没有**测量。
9. **我没有复核实施者报告的其余章节**（§4 之后的叙述性内容），只复核了任务书 §2 点名的七个问题
   所对应的事实主张。

---

## 6. 可数事实（预算）

不自报估计，只交可数事实：

| 项 | 数 |
|---|---|
| 完整测试套件运行（未过滤）| **7** 次（1 基线 ＋ 变异 A/B/C/D/E/F）|
| `typecheck` ／ `build` 运行 | 各 **1** 次 |
| 对抗性探针运行 | **2** 次（改动后 ／ 变异 A 还原的改动前），每次 **7** 格 |
| 施加并还原的源码临时改动 | **8** 次（变异 A–F ＋ 2 次临时 `export`）|
| 还原后的 `git diff`／`--cached` 零字节校验 | **9** 次，全部 `0 / 0` |
| 我自己写的探针脚本 | **3** 个（`mutate.py` ／ `extract_fn.py` ／ `probe.ts`，均在 scratchpad，未入库）|
| 被我独立复跑的实施者反向对照 | **2** 个（A、B），另**自加 4** 个（C、D、E、F）|
| 发现的存活变异 | **1** 个（F）|
| 分级 finding | Critical **0** ／ Important **0** ／ Minor **5** |
| 实施者自陈 gap 中被我关闭的 | **2** 个（#7 真跑同进程重入；#3 降级为结构性不可能）|
| 实施者事实主张中被我证伪的 | **2** 个（可抛面「不增不减」→ 实为减少；「四个 `finally`」→ 实为五个）|

**禁止项遵守情况**：未 push、未合并、未建删分支或 worktree、未改实施者的代码、未改主仓库
（骨架曾误落主仓库一次，已 `mv` 进 worktree，主仓库 `git status` 已复验干净）。
