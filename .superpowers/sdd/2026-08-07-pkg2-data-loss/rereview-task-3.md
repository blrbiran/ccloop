# 再评审报告 —— 包 2 / 任务 3（第 1 笔）阶段 1 · 修复环 1

范围：`7ff426d..b104397`（scoped 再评审）
评审员：换人（未参与实施，非上一轮评审员）

## 结论

**三条 Important 全部 ADDRESSED**（各带我自己造的变异证据，未采信实施者任何一条复现记录）。
**本次修复 diff 没有引入 Critical / Important 级新破坏。**
**既有断言零改动** —— 本范围 `tests` 侧总共只有 **9 行删除**，全部落在**任务 3 自己上一轮新增**的
那条并发测试里（含被点名要拆的两条 epoch 定值断言 ＋ 那句失实注释）；三条 fail-closed 测试**只被追加**。
`src/` 在本范围内零改动（我自己核过 `git diff 7ff426d..b104397 -- src` 空输出）。

| finding | verdict | 我自己的杀伤性证据 |
|---|---|---|
| Important-1（承重注释为假、断言钉偶然调度） | **ADDRESSED** | 重放上一轮那招（**只改测试**，`bAttemptedAcquire.resolve()` 之后插 100ms 合法重调度）⇒ **77/77 全绿**（`rr-m4.log`）。旧的两条 epoch 定值断言与「held by the same gates」注释已从文件中**删除**（在 9 行删除清单里）。 |
| Important-2（finalize 抛时释放锁全仓零判据） | **ADDRESSED** | 我自己把 `release()` 移出 `finally`（生产侧变异 M2）⇒ **三条新增断言同时红**，红点 `:483` / `:540` / `:579`，消息 `promise resolved "'{\n "holderProcessInstanceId": "pid:…'" instead of rejecting`（`rr-m2.log`，未过滤整份读）。 |
| Important-3（唯一鉴别力是 5 秒超时） | **ADDRESSED（带一条保留意见）** | 我自己把分支还原成阶段 1 之前的形状（M3）⇒ 红点变成**具名错误** `reader A never opened the owner-transfer lock file within 3000ms -- ...may have regressed to the pre-phase-1 unlocked-finalize shape`，3029ms（`rr-m3.log`）。**保留意见**：机制**仍然是超时**，那条 `it` 里的断言在这次回归中**依旧一次都没执行到**；改掉的是「失败消息不指认不变式」，不是「把超时换成断言」。而这**恰好就是上一轮评审员自己在 Findings 里开的处方**（"加一个显式超时并抛出具名错误"），所以按 finding 本身的验收口径判 ADDRESSED。 |

**最重的一句顾虑**：Important-1 的新承重断言 `expect(renameCount).toBe(finalizeOrder.length)`
**是真不变式**（我用 M4 证它扛得住合法重调度，用 M6 证它非空转），但**这条 `it` 对「两个 finalizer 同时跑」
这类回归的实际红法仍然是「`Promise.all` 抛 ENOENT」而不是这条计数断言**（我的 M5 实测），
也就是说 Important-3 抱怨的「靠异常/超时而非断言变红」这个**形状**，在另一个回归类别上还在。
不构成本环退回理由，记为 deferred。

**基线全量（我自己跑，未过滤，整份读）**：`30 files / 518 tests` 全绿，
`TEST_EXIT=0 / TSC_EXIT=0 / BUILD_EXIT=0`，`RUN` 首行 = worktree 路径。
**允许清单里那三条本轮全绿**，未出现任何计划外的红。

## Important-1 / Important-3 verdict

两条落在同一条 `it("lets exactly one of two concurrent readOwnerRecord calls finalize the
transaction; the other returns without writing")` 上，分开判。

### Important-1 —— **ADDRESSED**

**（a）重放上一轮那招（控制器点名要我打的）**：变异 M4，**只改测试、生产代码一个字没动** ——
在 mock 的 `readFile` 里 `bAttemptedAcquire.resolve()` 之后插入

```ts
// MUTATION_RR4: a legal 100ms reschedule of reader B, production untouched.
await new Promise((r) => setTimeout(r, 100));
```

**实跑（`rr-m4.log`）**：

```
 ✓ tests/persistence/fileStore.test.ts (77 tests) 779ms
 Test Files  1 passed (1)
      Tests  77 passed (77)
TEST_EXIT=0
```

⇒ **上一轮用来在正确行为上打红的那一击，现在打不动了。** 这是 Important-1 的核心验收点。

**（b）失实注释已经消失，不是被改写成另一句可疑的话。** 我核了本范围 `tests` 的**全部 9 行删除**
（见「既有断言是否被动过」一节的逐行清单）：`// ... which, held by the same gates, is still the
pre-recovery record ...` 三行连同 `expect(ownerFromB.currentOwnerEpoch).toBe(1)` /
`expect(ownerFromB.currentProcessInstanceId).toBe("pid:12345")` **被删除**，
新注释明写「What is NOT deterministic is how soon after that its own plain read ... happens
relative to A's finalize -- both ... are correct outcomes」。**这句今天为真**：M4 实跑的两种交错都绿。

**（c）新承重断言 `expect(renameCount).toBe(finalizeOrder.length)` 是不是又一个偶然顺序？不是。**
- **它扛得住合法重调度**：M4 下仍绿（同上）。这正是旧断言死掉的那一击。
- **它不是空转**：变异 M6（**只改测试**，把期望值改成 `finalizeOrder.length + 1`）实跑得到
  `AssertionError: expected 2 to be 3`（`rr-m6.log`，红在 `:3059`）
  ⇒ `renameCount` 确实被观测到、确实等于 2，不是 `undefined`/`NaN` 蒙混过关。
- **它的推导链我自己核过**：`src/persistence/fileStore.ts` 的 `finalizePendingOwnerTransfer` 里
  `for (const entry of staged) { await safeUnlink(entry.tempPath); await
  writeJsonFile(entry.tempPath, entry.value); await rename(entry.tempPath, entry.targetPath); }`
  —— 每个 `finalizeOrder` 条目**恰好**一次 `rename`。期望值取自与 marker fixture **同一个**
  `finalizeOrder` 变量，不是写死的魔数。
- **它钉的是可观察的写副作用**（发生了几次 `rename`），不是实现细节字节，不是 D-5 那族。

### Important-3 —— **ADDRESSED，带一条我必须说出口的保留意见**

**（a）具名超时确实生效。** 变异 M3（生产侧）：把 `!lockHeld` 分支整个还原成阶段 1 之前的
「探锁 → 可能删锁 → 不持锁 finalize」形状：

```ts
// MUTATION_RR3: reverted to the pre-phase-1 probe -> maybe delete -> unlocked finalize shape.
if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
  return;
}

await finalizePendingOwnerTransfer(runDir);
```

**实跑（`rr-m3.log`）**：

```
   × recoverInterruptedOwnerTransfer: ... 3029ms
     → reader A never opened the owner-transfer lock file within 3000ms -- the unlocked branch is
       not acquiring a lock before finalizing (recoverInterruptedOwnerTransfer's !lockHeld branch
       may have regressed to the pre-phase-1 unlocked-finalize shape)
 Test Files  1 failed (1)
      Tests  1 failed | 76 passed (77)
TEST_EXIT=1
```

⇒ 通用的 `Test timed out in 5000ms.` **已被具名错误取代**，3029ms 先于 vitest 的 5000ms 触发，
失败消息**直接指认不变式**。上一轮 finding 里「未来维护者看到只会当成 flake」这条后果被消除。

**（b）保留意见（我不替他圆）**：**机制仍然是超时，不是断言。**
M3 下这条 `it` 里的四组断言（含新的 `renameCount`）**依旧一次都没被执行到** ——
换掉的是「失败消息的信息量」，不是「鉴别力的载体」。
上一轮 finding 的标题写的是「唯一鉴别力是 5 秒超时，不是断言」，但它的**建议**原文是
「给 `aLockWritten` 加一个显式超时并抛出具名错误 …… 让回归时的失败消息直接指认不变式」——
实施者做的**正是这条建议的字面内容**。按 finding 自己的验收口径，判 **ADDRESSED**；
按 finding 标题的字面，「换成断言级鉴别力」**没有做到，也做不到**（旧形状下 A 根本不 `open` 锁文件，
`aLockWritten` 永不 resolve，任何后续断言都到不了）。**两种读法我都写在这里，交控制器裁。**

**（c）新增的断言级鉴别力确实增加了，但方向不同。** `renameCount` 给的是**另一类**回归
（「两个读者都跑到 finalize」）的鉴别力。我造了 M5 去撞它（生产侧：取锁失败的 catch 里不 `return`，
改成继续 `await finalizePendingOwnerTransfer(runDir)`），结果这条 `it` 确实红了 ——
但红在 `Promise.all` 抛出的 `ENOENT: ... rename '.owner-transfer.publish.tmp' -> 'owner-transfer.json'`，
**不是红在 `renameCount` 那行**（`rr-m5.log`；同一次跑里既有测试
`keeps a live lock in place when recovery cannot yet proceed` 也红，`expected 2 to be 1`）。
测试里的注释**预告了**这个红法（"or a thrown ENOENT from a second finalizer hitting pendings the
first already deleted"），所以不算注释失实；但**「靠异常而非断言变红」这个形状仍然存在**，
我把它记为 deferred，不据此延长修复环。

## Important-2 verdict

**ADDRESSED。** 我自己造的变异，不用实施者的记录。

**变异 M2（生产侧，`src/persistence/fileStore.ts` → `recoverInterruptedOwnerTransfer`）**：
把

```ts
try {
  await finalizePendingOwnerTransfer(runDir);
} finally {
  await lock.release();
}
```

替换成

```ts
// MUTATION_RR2: release moved out of finally -- finalize throwing leaks the lock forever.
await finalizePendingOwnerTransfer(runDir);
await lock.release();
```

**实跑结果**（`rr-m2.log`，整份读，未过滤；`npx vitest run tests/persistence/fileStore.test.ts`）：

```
 ❯ tests/persistence/fileStore.test.ts (77 tests | 3 failed) 692ms
   × fileStore > refuses to finalize a v2 marker whose finalizeOrder omits a legal file, rather than silently orphaning the omitted pending 9ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting
   × fileStore > refuses to finalize a v2 marker whose reconciliation pending is missing, keeping the marker and staging in place 2ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting
   × fileStore > refuses to finalize an unparseable marker, keeping every staged file in place 2ms
     → promise resolved "'{\n  "holderProcessInstanceId": "pid:…'" instead of rejecting
 Test Files  1 failed (1)
      Tests  3 failed | 74 passed (77)
TEST_EXIT=1
```

三个红点分别落在 `fileStore.test.ts:483` / `:540` / `:579` —— **正是三条新增的那一行**
（vitest 打出的上下文行显示上一行就是本环新加的 `// Task 3 / phase 1 (fix loop 1, Important-2)` 注释）。
`Received` 是**真实的锁文件内容** `{"holderProcessInstanceId": "pid:78788", "acquiredAt": ...}`
—— 泄漏是真的，不是断言写错。

⇒ 上一轮 M2 下「518 全绿」的裸奔状态**已被消灭**，而且**三条抛出原因各不相同的路径
（`OwnerTransferMarkerFinalizeOrderInvalidError` / `OwnerTransferPendingMissingError` /
`OwnerTransferMarkerUnreadableError`）各有一条判据在守**，不是只钉了其中一种。

## 既有断言是否被动过

**没有。三条 fail-closed 测试只被新增了断言，原有断言一个字节没动。**

**我下这个全称否定的搜索面**：`git diff -U0 7ff426d..b104397 -- tests` 的**全部** `^-` 行
（不是抽样、不是收窄的 grep），逐行贴在下面（`rr-diffcheck.sh` 原始输出）：

```
--- a/tests/persistence/fileStore.test.ts                      ← diff 头，非删除行
-        JSON.stringify({ version: 1, stagedAt: ..., finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
-        await aLockWritten.promise;
-        // the one that finalizes; reader B is deterministically forced to attempt its acquire
-        // while A's lock is still held with real content, so it deterministically loses.
-        // Reader B's plain read observes whatever is on disk when it fell back after losing the
-        // acquire race -- which, held by the same gates, is still the pre-recovery record, proving
-        // B took the busy-return path rather than finalizing (or re-finalizing) anything itself.
-        expect(ownerFromB.currentOwnerEpoch).toBe(1);
-        expect(ownerFromB.currentProcessInstanceId).toBe("pid:12345");
```

**numstat**：`76 9 tests/persistence/fileStore.test.ts`（新增 76 / 删除 9）。

逐条归属：

| 删除行 | 归属 | 是否「既有判据」 |
|---|---|---|
| 内联 `finalizeOrder: [...]` | 提成变量 `finalizeOrder`，值逐字不变 | 否（fixture，非断言；且**任务 3 上一轮才写的**） |
| `await aLockWritten.promise;` | 被 `withNamedTimeout(...)` 包住 | 否（gate 等待，非断言） |
| 5 行注释 | 含被点名失实的「held by the same gates」 | 否（注释） |
| `expect(ownerFromB.currentOwnerEpoch).toBe(1)` | **Important-1 点名要拆的那条** | 否 —— **任务 3 上一轮自己新增的**，不是仓库既有判据 |
| `expect(ownerFromB.currentProcessInstanceId).toBe("pid:12345")` | 同上 | 同上 |

⇒ **9 行删除全部在任务 3 上一轮新增的那一个 `describe` 内部**，没有一行落在
`refuses to finalize a v2 marker whose finalizeOrder omits a legal file …` /
`… reconciliation pending is missing …` / `… unparseable marker …` 这三条测试里 ——
它们只各多了 1 行断言 ＋ 注释（见评审包 diff 的 `+` 行）。
brief §2.3「不许为了让测试变绿而改任何既有测试断言」**未被触碰**。

**另一个方向的核对**：`grep -c 'owner-transfer.lock"), "utf8")).rejects.toThrow'
tests/persistence/fileStore.test.ts` = **12** = 上一轮评审员数的 9 ＋ 本环新增 3。数目对得上。

**`src/` 零改动**：`git diff 7ff426d..b104397 -- src` **空输出**（我自己跑的，不是转述控制器）。

**检索面 sanity（证明上面的「零命中/全集」不是被弄坏的检索）**：
- 必命中：`grep -c 'owner-transfer.lock' tests/persistence/fileStore.test.ts` → **27**
- 必零命中：`grep -rn 'ZZQQ_NOPE_7731' src tests` → **0**

## 新破坏排查

**结论：无 Critical、无 Important 级新破坏。**

逐条按控制器点名的四类查：

**（1）恒绿测试？没有。** 本环碰的 4 条测试我都用变异逼红过：
三条 fail-closed 各自被 M2 逼红（`:483` / `:540` / `:579`），并发那条被 M3（具名超时）、
M5（ENOENT）、M6（计数期望值）三种方式逼红。**没有一条我碰不红。**

**（2）无鉴别力断言（D-5 那族）？** 承重的那条（`renameCount`）**有**鉴别力，已用 M6 证非空转。
但同一处新增的两条**几乎没有**鉴别力，记为 deferred（不是本环退回理由）：
- `expect(ownerFromB.runId).toBe("task-1")` —— `runId` 在整个 fixture 里从不变化，
  这条只在「读到的根本不是这个 run 的记录」时才可能红。
- `expect([1, 2]).toContain(ownerFromB.currentOwnerEpoch)` —— 该 fixture 里 epoch 只可能是 1 或 2
  （初值 1，`applyOwnerEpochTransfer` 后 2），所以它接近恒真。
  **它不误导**：紧邻注释明写「Pinning one specific value here would be pinning accidental
  scheduling, not the invariant … the invariant … is asserted below instead」，
  即作者自己声明了这不是承重断言。属于「诚实的弱断言」，不是「伪装成承重的空断言」。

**（3）对实现细节而非可观察行为的断言？没有。**
`renameCount` 数的是**真实发生的 `rename` 系统调用次数**（mock 只包装、真调用仍然发生），
是写副作用的观测，不是字节比对、不是私有函数签名。
新增的三条锁断言读的是**盘上文件是否存在**，同样是可观察状态。

**（4）套件整体**：基线全量 `30 files / 518 tests` 全绿（`rr-full.log` 整份读，未过滤），
`TEST_EXIT=0`、`TSC_EXIT=0`；还原后再跑 `npm run build` → `BUILD_EXIT=0`。
`RUN` 首行 `v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss` —— 是 worktree。
**允许清单三条本轮全部为绿**：
`records env names only and tracks descendants rooted at the spawned pid`（2887ms，绿）、
`continues normally when execute returns a complete result during the recovery window`
（reporter 未单独展开，所属文件 `tests/controller/runLoop.integration.test.ts (58 tests)` 整体绿、总计零失败）、
`persists phase usage evidence from the subprocess adapter without recomputing controller totals`
（1202ms，绿）。**按名比对记录，不重新调查根因，不外推为「已修复」**；
沿用本仓库立场：**「本次没跑出来」不构成 flake 消失的证据**（我只采样一次）。

**我没做的事（如实列）**：
- **没有反复跑 N 次逼 flake**，全量只跑了 1 次。
- **没有复核 `progress.md` 那 +72 行台账笔与实施者报告 +225 行回填的内容真伪** ——
  控制器明示那是噪声、不是被审对象，我按范围不读。
- **没有构造 `EACCES`/`ENOSPC` 注入**（上一轮已记为仍在的缺口，本环未新增覆盖，也不在本环范围）。
- **没有跑真 spawn 两进程的并发测试**（同上，不在改动面内）。

## 变异还原证明

我为验证做了 **5 次临时变异**，全部从已提交基线 `0b5f767` 出发，全部带 `MUTATION_RR` 标记，
全部用 `git checkout -- <明确文件路径>` 还原。

| # | 文件 | 变异 | 结果 |
|---|---|---|---|
| M2 | `src/persistence/fileStore.ts` | `release()` 移出 `finally` | 三条新增断言同红（`:483`/`:540`/`:579`） |
| M3 | `src/persistence/fileStore.ts` | 分支还原成阶段 1 之前形状 | 并发测试红，**具名错误**，3029ms |
| M4 | `tests/persistence/fileStore.test.ts` | B 被重调度 100ms（生产未动） | **77/77 全绿**（旧的一击失效） |
| M5 | `src/persistence/fileStore.ts` | 取锁失败后仍继续 finalize | 并发测试红（ENOENT）＋ 既有 `keeps a live lock in place …` 红 |
| M6 | `tests/persistence/fileStore.test.ts` | 计数期望改 `+1`（非空转探针） | `expected 2 to be 3`，红在 `:3059` |

**还原证明（最终状态，`rr-restore.log` 原始输出，未过滤）**：

```
--- git diff (whole tree, raw):
--- END git diff                       ← 空
--- git diff --stat (whole tree):
--- END git diff --stat                ← 空
--- git status --porcelain:
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/rereview-task-3.md   ← 只有本报告
--- MUTATION_RR grep across src+tests:
grep done                              ← 零命中
--- sanity MUST HIT: acquireOwnerTransferLock in src/persistence/fileStore.ts
9
--- sanity MUST MISS: ZZQQ_NOPE_7731
miss-probe done                        ← 零命中
--- rerun fileStore tests at restored HEAD
 Test Files  1 passed (1)
      Tests  77 passed (77)
TEST_EXIT=0
--- build
BUILD_EXIT=0
```

⇒ `git diff` 全树**原始输出为空** ＋ `MUTATION_RR` 标记零命中 ＋ 检索面已用两条探针验活
（必命中 9、必零命中 0）＋ 还原后重跑绿 ＋ build 绿。**还原完整。**

**纪律说明**：本报告里所有验证性命令都走 `rtk proxy zsh <落盘脚本>` 取原始输出，
长输出先重定向落盘再**整份 Read**，**没有用 `grep`/`tail` 过滤任何一次验证跑**。
（`rr-diffcheck.sh` / `rr-restore.sh` 里出现的 `grep` 是**检索本身**，不是对验证跑输出的过滤，
且每处都配了必命中/必零命中双探针。）
脚本与日志落在 scratchpad，**不在仓库内**：
`rr-diffcheck.sh` / `rr-full.sh` / `rr-fs.sh` / `rr-restore.sh`，
`rr-full.log` / `rr-m2.log` / `rr-m3.log` / `rr-m4.log` / `rr-m5.log` / `rr-m6.log` / `rr-restore.log`。

## Deferred minor（范围外观察，不延长修复环）

**这些都不是本环退回理由。原样挂账，交控制器处置。**

- **D-a（弱断言）**：`expect(ownerFromB.runId).toBe("task-1")` 与
  `expect([1, 2]).toContain(ownerFromB.currentOwnerEpoch)` 在该 fixture 里接近恒真。
  作者已在紧邻注释里声明它们不是承重断言，所以不误导；但它们也不带来任何保护。
  锚点：`tests/persistence/fileStore.test.ts` → 那条并发 `it` 的 `Promise.all` 之后。
- **D-b（超时余量收窄）**：`withNamedTimeout(..., 3000, ...)` 比 vitest 默认 5000ms **更早**触发。
  好处是消息具名，代价是在重载机器上，本来还能在 5s 内完成的合法交错现在 3s 就会被判红 ——
  **flake 窗口从 5s 收到 3s**。上一轮 finding 里「5s 超时本身是慢机器上的 flake 源」这条
  **没有被消除，只是被换了个更短的阈值 ＋ 更好的消息**。（该 gate 是纯等待、无实际计算，
  3s 在正常机器上很宽裕；我不认为需要现在改。）
  锚点：`fileStore.test.ts` → `withNamedTimeout` 调用点与函数定义。
- **D-c（计数器作用域）**：`renameCount` 数的是**该测试内经动态 import 模块发生的全部 `rename`**，
  不只是 `finalizePendingOwnerTransfer` 的。今天该测试里没有别的写路径经过被 mock 的模块
  （fixture 的 `writeOwnerRecord`/`writeFile` 走的是文件顶部的静态 import，不受 mock 影响），
  所以两者相等；但若将来 fixture 里多一次经动态模块的写，这个数字会**静默改变含义**。
  注释把推导写成「finalizePendingOwnerTransfer performs exactly one rename per finalizeOrder
  entry」——**今天为真**（我核过 `src/persistence/fileStore.ts` 的 `finalizePendingOwnerTransfer`
  循环体），但计数器本身没有按「只数 finalize 的 rename」来限定作用域。
- **D-d（红法形状）**：「两个 finalizer 同时跑」这类回归（我的 M5）在这条 `it` 里的实际红法是
  `Promise.all` 抛 ENOENT，不是 `renameCount` 断言 —— 与 Important-3 抱怨的形状同族，
  只是换了个回归类别。注释已预告该红法，不构成注释失实。
  （同一次 M5 里既有测试 `keeps a live lock in place when recovery cannot yet proceed`
  也红，说明这类回归并非只有一条防线。）
- **D-e（上一轮 3 条 Minor）**：Minor-1/2/3 按控制器指示 deferred，**不在我的范围**，我没有处理，
  也没有复核实施者对它们的处置说明。如实记为「我没做」。

## 预算

*** **我拿不到精确数字，也不给估计充数。** ***

这个环境里我没有能读到自身逐调用 token 用量的工具或 API。本仓库已有先例证明「凭操作次数换算」
会错到数量级（实施者上一轮估「6-8 成」、harness 实测 195,610），所以我**不重复那个方法**。

**我能诚实给出的只有可数的事实**：
- 读入：`review-task-3.md`（492 行）、`task-3-impl-brief.md`（183 行）、
  `task-3-impl-report.md` 的修复环 1 一节（第 310 行起）、评审包 `rereview-task3.md`（313 行）、
  `fileStore.test.ts` 定向读 1 段（120 行）、`fileStore.ts` 定向读 2 段。
- 跑：**7 次 vitest**（1 次全量 ＋ 6 次 `fileStore.test.ts` 单文件：M2/M3/M4/M5/M6/还原后），
  1 次 `tsc --noEmit`，1 次 `npm run build`，若干次 `git`/`grep` 检索。
- 写：本报告。
- **未读**：`progress.md` 全篇、handoff、台账 §14（按控制器范围限制）。

**唯一可信的用量来源是 harness 自己的实测。** 若控制器需要数字，请取 harness 读数，
不要采用我这边的任何换算。
