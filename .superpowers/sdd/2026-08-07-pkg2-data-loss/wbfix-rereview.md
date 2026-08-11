# 包 2 修复环第二轮 —— scoped 再评审

> 第三个人（未参与实施、未做第一轮评审）。scoped = `c2db9c7..HEAD`，外加「有没有把第一轮已 ADDRESSED 的东西弄坏」。
> 状态：**已完成**。所有承重结论均为我自己实测；实施报告只作线索，未作证据。

## 0. 结论（最先填：ADDRESSED / NOT ADDRESSED / 有无新破坏 / 有无越界）

**总判：第二轮的六项处置全部 ADDRESSED；无新破坏；无越界；但引入了 1 条 Important 新缺陷（(B) 的那条路径），
另有 1 条 Important 是「举证没有落进套件」。**

| 项 | 判定 | 我的证据 |
|---|---|---|
| C-1 前半（原子发布） | **ADDRESSED** | 我自己跑的双进程探针：修前 213/252 violations（10s×2），修后 **0**（10s×5，共消费 20,544 个 base）。§2 |
| C-1 探针「测的是不是互斥」 | **是，测的是互斥** | 我给出了 lost-update ⇒ 临界区重叠的完整推导，并用两个对照实测。§2.2 |
| 退回两步发布 → 新守卫红法 | **红在断言** | `expected { empty: true, parseable: false } to deeply equal { empty: false, parseable: true }`。§2.4 |
| 人裁 50 红线 | **逐字节未动** | `tryRecoverStaleOwnerTransferLock` 与 `release()` 在 `c2db9c7` 与 `HEAD` 的 sha256 完全相同。§3 |
| 任务 2：gaps 05–13 的 accepted | **举证成立**（我自己造的证据） | 18 格 resume 后终态与各自 gap 14 **除 `lastAffirmedAt` 外全字段相同**。§4.1 |
| 9+9 拆分 ＋ S-3 逐句 | **成立** | 34 行只改了 18 行、只改 resume 判决位；旧判决文本逐条核对。§4.2–4.3 |
| 人裁 55 回退 | **逐字节回到基线** | 共享 `vi.mock` 工厂 sha256 与 `dbac288` 相同（`c2db9c7` 不同）。§5 |
| 新 seam 行为中性 ＋ 3→1 | **中性；两条都红在断言** | `expected 1 to be 3`、`expected [...] to not include ...`。§5 |
| 零新破坏 | **成立** | 我自己跑出 **31 files / 531 tests / 全绿**，三个退出码 **0/0/0**；逐文件计数无一下降。§1 |
| 越界 | **无** | 第二轮 `src/` 只动了两个被授权的函数体；测试侧只动了 §4/§5/§6 列出的位置。 |

**专判 (A)（夹具 hook 从 `open` 移到 `link`）**：**仍在测同一个不变量，没有实质放松**。
暂停时刻等价（锁已完整落盘、A 仍在 `acquireOwnerTransferLock` 内、尚未 finalize），
且我用「去注释后逐行 diff」证明**除 hook 本身外，断言、闸门、命名超时一个字都没动**。
唯一副作用是那句命名超时的**诊断词现在会误导**（见 Low-1，我实测复现）。→ **可以授权，但建议连带修 Low-1 的措辞。**

**专判 (B)（`link()` 成功后的 `await safeUnlink(stagingPath)`）**：**可达（仅环境类 errno）、本轮新引入、建议本轮修**。
后果比 brief 描述的更重：不只是泄漏一把锁——锁已发布且持有者进程仍活着，
所以其他获取者的 `tryRecoverStaleOwnerTransferLock` 会看到**活 pid** 而拒绝回收，
该 runDir 的一切 owner-transfer 操作在**持有进程退出前**会一直 `OwnerTransferLockBusyError`；
`handle` 也永不 close。进程退出后可自愈。**本文件里有具名的反向先例**（`writeJsonFileAtomically` 的注释明写
「此处故意不用 `safeUnlink`，因为它会把调用方需要看到的错误替换掉」）。详见 §6.2 / Imp-1。

**Findings：Critical 0 ／ Important 2 ／ Low 4 ／ Info 1。**（§7；finding 与处置建议分开写。）

**允许之外的红：无。**我在工作树 HEAD 上的整套跑是**全绿**——三条已挂账项与 flake (B)/(F) 这次一次都没有触发。

## 1. 我自己的全套件与逐文件计数比对

环境：`ECC_GATEGUARD=off DISABLE_OMC=1`，命令一律 `rtk proxy`，**整份落盘整份读回，未做任何过滤**。
工作树 `HEAD=16f8521`，分支 `feat/pkg2-wb-fixes`。

**三个退出码（我自己跑的，不继承）**

| 命令 | RUN 路径 | 结果 | 退出码 |
|---|---|---|---|
| `npm test` | `RUN v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-wbfix` ✅ 是工作树 | **Test Files 31 passed (31) / Tests 531 passed (531)** | **0** |
| `npm run typecheck` | 同工作树 | 无输出 | **0** |
| `npm run build` | 同工作树 | `tsc` ＋ 写 `dist/cli.js`、`dist/cli.d.ts` | **0** |

**全绿，0 skipped，0 failed。**三条已挂账项（人裁 10 那条、`waits for close before interrupting…`、
`rejects unknown verdicts and diagnoses`）与 flake (B)/(F) **这次一次都没触发**——即我这一跑不需要动用任何豁免。

### 1.1 逐文件计数比对（`dbac288` → `c2db9c7` → `HEAD`）

`dbac288` 与 `c2db9c7` 无法在工作树里跑（不许 checkout），我用 `git archive <rev> | tar -x` 解到 scratchpad、
把 `node_modules` 软链过去后在**副本**里跑，**完全没有碰工作树**。

31 个文件全部比对，**没有任何一个文件的计数下降**，只有三个上升：

| 文件 | dbac288 | c2db9c7 | HEAD |
|---|---|---|---|
| `tests/controller/resumeLoop.integration.test.ts` | 14 | 14 | **15** |
| `tests/controller/runLoop.integration.test.ts` | 61 | **64** | 64 |
| `tests/persistence/fileStore.test.ts` | 77 | **79** | **80** |
| 其余 28 个文件 | 逐一相等 | 逐一相等 | 逐一相等 |
| **合计** | **524** | **529** | **531** |

⇒ **第二轮（`c2db9c7..HEAD`）净增 2 个测试**：`resumeLoop.integration` 的 I-4 回归判据 1 个，
`fileStore.test` 的原子发布守卫 1 个。**既有测试一个都没被删、没被改名删除。**
（第一轮的 +5 不在本次 scoped 范围内，仅用于确认没有回退。）

⚠️ **fail loud**：两个副本里都有 2 条红——`cli > returns 0 for the scripted example run` 与
`evidence > records env names only and tracks descendants rooted at the spawned pid`。
两条在 `dbac288` 与 `c2db9c7` **两个不同 revision 上以完全相同的形态复现**，而**同样的两条在工作树 HEAD 上是绿的**，
所以我判断是「`git archive` 出来的副本没有 `.git`」这一环境差异所致，不是代码问题。
**我没有把它根因坐实**（见 §9）。它不影响本节结论：失败的测试仍然计入 collected 数，逐文件计数照样可比。

## 2. C-1 三条硬条件的独立复现（含"这个探针到底测的是不是互斥"的判断）

### 2.1 我怎么跑的（关键：我没有改产品代码去造"修前"）

我没有为了拿基线去改工作树里的 `fileStore.ts`。我把 `c2db9c7` 用 `git archive` 解成一棵独立的树，
再把 `probe-c1/` 原样拷进去**相同的相对路径**——探针用的是 `../../../../src/persistence/fileStore.js`，
所以副本里的探针自动打在**未修**的两步发布上。工作树的变异次数因此是 **0**。

### 2.2 *** 这个探针测的到底是不是互斥 —— 我的判断：**是** ***

这是我最该怀疑的一格，所以我不引用注释，自己把充分性推了一遍：

- 一次 `affirmOwnerLease` 成功 ⇒ 它在**锁内**读到的盘上记录与调用方给的 `expected` 逐字节相等
  （`updateOwnerRecordWithPrecondition` → `sameOwnerRecord` 是 `JSON.stringify` 全等），并写出继任值；
  写出的 `lastAffirmedAt` 是调用方给的 `${tag}#${iteration}`，**全局唯一**。
- 设两次成功 S1（写 w1）、S2（写 w2）共享同一个 base `b`。因 w1≠w2 且每次成功都把盘上的值改成唯一的新值：
  - 若 S1 的锁区间**整体早于** S2 的：S1 写完后盘上是 w1≠b，S2 的锁内读不可能读到 b —— 矛盾。
  - 若 S2 的锁区间**整体早于** S1 的：同理 S1 读不到 b —— 矛盾。
  - ⇒ **两段锁区间必然重叠。**这正是互斥被破坏的定义，与时钟无关、与调用交错无关。
- ABA 造不出假阳性：值域由唯一 stamp 构成，同一个 base 不会二次出现。
- 该指标**系统性欠计**（偷到锁但两段临界区没有出现 read-before-write 交错时不计），
  方向对「修后=0」这类主张是**安全**的，但也意味着 0 是**有限功效的否定**，不是不可能性证明。

**两个对照我都亲自跑了，而且都成立**：

| 构建 | 模式 | 时长 | mutualExclusionViolations |
|---|---|---|---|
| `c2db9c7`（未修） | `nostaged`（必不命中） | 5s | **0** ✅ |
| `HEAD`（已修） | `nostaged`（必不命中） | 5s | **0** ✅ |
| `c2db9c7`（未修） | `staged`（测量臂） | 5s | **137** |
| `HEAD`（已修） | `staged`（测量臂） | 5s | **0** |
| `c2db9c7`（未修） | `truncated`（必命中） | 5s | **977** |
| `HEAD`（已修） | `truncated`（必命中） | 5s | **0** ⚠️ |

必不命中对照在**两个构建上都读 0**——这正是第一版探针（4364 次）翻车的那一格，第二版把它修对了。
所以「测成了调用交错」这个失败模式**不成立**：我确认第二版测的是互斥。

### 2.3 但必命中对照的灵敏度很低，我把它补强了（Low-4）

上表里 `HEAD/truncated` 读 **0**——而实施报告自报的是 10。这一格若停在这里，
「修后 staged=0」就是 brief 明令禁止的**未经验证的否定**。我把它跑满：

- `HEAD` `truncated` × 5 次 × 10s：**3, 3, 3, 1, 4** ⇒ 探针在**已修构建上确实还能开火**，
  但速率只有 ~0.3/s，5s 一次跑读到 0 完全正常。
- 于是我把测量臂也跑满：`HEAD` `staged` × 5 次 × 10s：**0, 0, 0, 0, 0**，
  五次共消费 **20,544** 个不同 base；同期 `c2db9c7` `staged` × 2 × 10s：**213 / 252**。

⇒ **三条硬条件我判定成立**，且差分（每 10s 两百余次 vs 五轮共 0 次）是决定性的。
自报的具体数字（140 / 0 / 10 / 0）我复现到了**同一量级与同一符号**，
但 140 与 10 这两个绝对值**依赖时长与机器**，不应被当成可复现常数（Low-4）。

### 2.4 退回两步发布：判据红在哪里

在 `HEAD` 的独立副本里，我把 `acquireOwnerTransferLock` **整函数**换成 `c2db9c7` 的版本（其余一字不动），跑 `fileStore.test.ts`：

- 新守卫 `has parseable content at the first instant the lock path exists`
  → **`AssertionError: expected { empty: true, parseable: false } to deeply equal { empty: false, parseable: true }`**
  ⇒ **红在断言**，不是异常也不是超时 ✅；而且它是**越过**了防空转断言 `expect(sightings).toHaveLength(1)` 才红的
  ⇒ 探针确实开了火，不是"没看到"式的假红。
- 还原（未变异的 `HEAD`）：整套 531 全绿 ✅。

## 3. 人裁 50 红线核验

我不接受「控制器已验为真」。我把两段代码从 `c2db9c7` 与 `HEAD` 各自抽出来做 sha256：

| 符号 | `c2db9c7` sha256 | `HEAD` sha256 | 长度 | 判定 |
|---|---|---|---|---|
| `tryRecoverStaleOwnerTransferLock` | `194576bd…c06dc873` | `194576bd…c06dc873` | 969 / 969 | **逐字节未动** ✅ |
| `release: async () => { … }` | `df9086f5…a7f42901` | `df9086f5…a7f42901` | 111 / 111 | **逐字节未动** ✅ |

`release()` 的实体仍是 `await handle.close(); await safeUnlink(lockPath);` 两行，与基线一致。
非 EEXIST 的 rethrow、`attempt < 2` 双轮循环、`OwnerTransferLockBusyError` 也都在原位。**红线守住了。**

## 4. 任务 2：逐 gap 举证的独立复核 ＋ 9+9 拆分 ＋ S-3 逐句核

### 4.1 *** 我自己造的证据（没有引用实施者的任何快照）***

先说一件实施者没说、而我认为必须说的事：
**落进套件的 `after` 那一列，不是 resume 之后的状态。**
`observeCrashMatrix` 为每个 gap 铺**两份**独立副本：`forResume` 只跑 `observeResume`，
`forRecovery` 只跑 `observeRecovery`；而 `after` 是对 **`forRecovery`** 拍的。
也就是说，那句「resume 落在完全提交的三文件终态上」的**举证并不在树里**——
注释自陈「矩阵被临时插桩过」，临时插桩不是证据。所以我自己插了一遍。

做法：把 `HEAD` 解成独立副本，在 `observeCrashMatrix` 里**加一行**对 `forResume` 的 `crashSnapshot`，
只 `console.log`，不动任何断言，再跑那条整测试（EXIT=0，断言原样通过）。实测结果：

| 夹具 | gaps 05–13 的 **resume 后**终态 | gap 14 的 **resume 后**终态 |
|---|---|---|
| first-transfer | `T=e2 O=e2 R=e2 M=absent P=---`（9 格全同） | `T=e2 O=e2 R=e2 M=absent P=---` |
| double-transfer | `T=e3 O=e3 R=e3 M=absent P=---`（9 格全同） | `T=e3 O=e3 R=e3 M=absent P=---` |

⇒ **18 格与各自的 gap 14 同形，属实。**没有 torn、没有孤儿 pending、marker 已回收、三文件 epoch 一致。

**再往前一步**：注释说的是「**BYTE-FOR-BYTE** THE SAME END STATE as gap 14」。
`crashSnapshot` 只渲染存在性＋一个 epoch 字段，够不着这句话，所以我第二次插桩，
把 resume 后三个文件的**原始内容**全部导出，与 gap 14 做全字段比对。结果（18 格全部）：

> 三个文件里，**唯一不同的字段是 `owner-record.json` 的 `lastAffirmedAt`**，
> 且差值就是两次观测的墙钟差（如 `…37.204Z` vs `…37.435Z`）。其余字段、其余两个文件，**全等**。

⇒ **实质主张成立**（这是我对 accepted 是否正确行为的判断依据）；
**但 "byte-for-byte" 这个词是 overclaim**，见 Low-3。
本仓库 2026-08-02 那次「把一条 damaged trajectory 钉成正确行为」的失败模式，在这里**没有发生**：
终态不是受损轨迹，是完整提交的事务。

### 4.2 18 行翻转：我逐行 diff 过，一格不差

我把 `c2db9c7` 与 `HEAD` 的 34 行矩阵字符串全抽出来逐条比对：**34 行中恰好 18 行变化，且每行只变 `resume=` 这一段**；
`staged`、`recovery=`、`after` 三段**一字未动**。翻转前的原文（这是 9+9 拆分的事实基础）：

- **first-transfer gaps 05–13（9 行）**：全部是 `resume=refused: cannot read run artifacts`
  ⇒ **读失败**，不是判据拒绝。
- **double-transfer gaps 05–13（9 行）**：全部是**真判据**拒绝，而且分布与注释的指认**完全对上**：
  - gaps 05–07 = `published eligibility has been superseded by a newer owner epoch`（**判据 B**，`src/controller/resumeLoop.ts`）
  - gaps 08–13 = `reconciliation newOwnerEpoch does not match owner-transfer newOwnerEpoch`（**判据 A**）

⇒ **9+9 拆分成立**：前 9 行是缺陷自产的假拒绝（删掉它只是拿掉一个错答案），
后 9 行确实是**新增许可**，确实需要人裁 54。实施者没有把两者混为一谈。

### 4.3 S-3 逐句核（立场原文：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`）

| S-3 的句子 | 本轮是否动了 | 我的核验 |
|---|---|---|
| 「只增加拒绝，绝不新增许可」 | **动了**（double 夹具那 9 行） | 属实，且被显式记为人裁 54 的例外，没有被悄悄吸收。 |
| 「reconciliation 缺失即拒绝的 fail-closed 必须保留」 | **没动** | 我读了 `resumeLoop.ts`：`readReconciliationRecord` 仍在 `Promise.all` 里、**仍无守卫**、仍走同一个 `catch` → `cannot read run artifacts`。没有出现「若存在则校验、不存在则跳过」。 |

**反证也在树里**：两个夹具的 gaps 01–04 全部保持 refused（marker 不可解析 / pending 缺失 ⇒ 事务无法完成 ⇒ 拒绝且不写盘），
我插桩测到的 `afterResume` 与 staged 完全相同，即**磁盘未被触碰**。这说明改动不是「跳过缺失的东西」。

两条判据也没有因此失去覆盖：`tests/controller/resumeLoop.gate.test.ts` 里**两条 reason 字符串都还有直接断言**
（判据 A 一处、判据 B 两处），且该文件计数三个 revision 恒为 27。

## 5. 人裁 55 回退与新 seam 的行为中性

**回退：逐字节回到基线。**共享 `vi.mock("node:fs/promises")` 工厂的 sha256：

| revision | sha256 | 长度 |
|---|---|---|
| `dbac288`（基线） | `ccd6991c…2ca70335` | 303 |
| `c2db9c7`（第一轮，越界那版） | `b212c2ed…2fed9c85` | 432 |
| `HEAD` | `ccd6991c…2ca70335` | **303** ✅ |

工厂里只剩 `rename` 透传 spy，`openSpy` 的整段已经消失，与基线**完全一致**。

**新 seam `withLockAttemptCounter` 是否行为中性**：是。它是局部 `vi.doMock` + 动态 import，
只在 `link` 上做**先计数、后原样转发**（`if (String(args[1]) === lockPath) attempts += 1; return actual.link(...args)`），
不伪造任何返回、不改变任何时序，`finally` 里 `doUnmock` + `resetModules`。
唯一的实质差别是这两条测试内部拿到的是**新的模块实例**；由于全部状态都在磁盘上，无影响。

**判据 3→1（人裁 55 第 2.2 项）**：我在另一棵独立副本里把
`const RECONCILIATION_LOCK_RETRY_ATTEMPTS = 3;` 改成 `= 1;`，跑 `fileStore.test.ts`：

- `retries a busy owner-transfer lock for the reconciliation publish and writes the record once it clears`
  → **`AssertionError: expected [ 'reconciliation_write_abandoned' ] to not include 'reconciliation_write_abandoned'`** ⇒ 红在断言 ✅
- `abandons the reconciliation publish once the reconciliation retry bound is exhausted, after exactly three lock attempts`
  → **`AssertionError: expected 1 to be 3`** ⇒ 红在断言 ✅
- 其余 78 条绿；还原（未变异 HEAD）整套全绿 ✅

顺带**实测**了新注释那句承重等价关系（第一轮 Imp-1 要求的更正）：
「一次 link 到锁路径 = 一次获取尝试」。3→1 时计数恰好从 3 变 1，**与循环上界线性对应**，等价关系成立。

## 6. 专判 (A) 夹具 hook 移位　(B) staging unlink 的泄漏路径

### 6.1 (A)：移位后还在测同一个不变量吗？——**在，没有实质放松**

**我先证「除了 hook 什么都没改」**，而不是听它自称：把该 `describe` 整块从两个 revision 抽出，
去掉全部注释与空行后逐行 diff。结果**唯一差异就是 hook 本身**：

```
- open: async (...) => { const handle = await actual.open(...args);
-   if (!aOpenedLock && String(args[0]).endsWith(".owner-transfer.lock")) { … 包裹 handle.writeFile … }
+ link: async (...) => { const result = await actual.link(...args);
+   if (!aOpenedLock && String(args[1]).endsWith(".owner-transfer.lock")) { aLockWritten.resolve(); await bAttemptedAcquire.promise; }
```

`renameCount === finalizeOrder.length`、`ownerFromA/ownerFromB` 的四条断言、三条残留文件断言、
`withNamedTimeout(…, 3000, …)` 的闸门——**一个字都没动**。

**暂停时刻是不是同一时刻？是。**
- 旧：`open(lockPath,"wx")` 建文件 → 包裹的 `writeFile` **先真写完** → 才 resolve/暂停。
  ⇒ 暂停时锁已有完整内容，A 仍在 `acquireOwnerTransferLock` 内、尚未 finalize。
- 新：`await actual.link(staging, lockPath)` **先真发布完** → 才 resolve/暂停。
  ⇒ 暂停时锁已有完整内容（link 的对端 inode 本来就是写满的），A 仍在 `acquireOwnerTransferLock` 内
  （`safeUnlink(stagingPath)` 与 `return` 都还没发生）、尚未 finalize。**等价。**

**B 侧的闸门路径也没变**：B 的 `link` 拿 EEXIST → 内层 catch → 外层 catch →
`tryRecoverStaleOwnerTransferLock` → `readFile(lockPath)` → 触发 `readFile` hook → `bAttemptedAcquire.resolve()`。
与旧代码里 B 的 `open(lockPath,"wx")` 拿 EEXIST 后走的是同一条尾巴。

**有没有实质放松？没有，反而更干净。**旧 hook 之所以要绕到 `writeFile` 之后，
正是为了**避开那个 0 字节窗口**（Lane 2 抓到的那句「unrelated」）。现在窗口本身不存在了，
夹具不再需要绕开任何东西——这是**去掉了一处绕行**，不是放松判据。
本仓库人裁 17 的先例（改夹具 ≠ 改判据）在事实层面适用；**授权与否是人的事，我只报事实**。

⚠️ **一处真实副作用，我实测复现了**（Low-1）：把发布退回两步之后，这条测试是以
`reader A never opened the owner-transfer lock file within 3000ms -- the unlocked branch is not acquiring a lock
before finalizing (… may have regressed to the pre-phase-1 unlocked-finalize shape)` 红的。
**这个诊断对该变异是错的**——没有回退到 unlocked-finalize，回退的是原子发布。
hook 挂在 `link` 上之后，这条命名超时开始覆盖**两种**回归而只点名了其中一种。
（缓解：同一次跑里 §2.4 那条守卫会同时红并给出正确诊断。）

### 6.2 (B)：`link()` 成功后的 `await safeUnlink(stagingPath)`

**代码事实**（`src/persistence/fileStore.ts`，`acquireOwnerTransferLock`）：
这一句在内层 `try/catch` **之外**、外层 `try` **之内**。所以它抛出的非 ENOENT 错误直接落到外层
`catch (error) { if (code !== "EEXIST") throw error; }` ⇒ **原样 rethrow**。

**后果比 brief 写的更重**：
1. 锁**已经发布**（`lockPath` 在盘上，内容完整，`holderProcessInstanceId = pid:<本进程>`）；
2. 调用方拿不到 `release`，`handle` **永不 close**（fd 泄漏）；
3. 更关键：**它不会被回收**。别的获取者拿到 EEXIST → `tryRecoverStaleOwnerTransferLock` →
   内容能解析 → `isProcessActive(pid)` 为**真**（本进程还活着）→ `return false` → `OwnerTransferLockBusyError`。
   ⇒ 该 runDir 的**一切** owner-transfer 操作（心跳 affirm、transfer、reconciliation 发布）
   在**持有进程退出之前**全部被永久挡住，表现为「无休止的锁竞争」而不是一个错误。
4. **进程退出后可自愈**：那时 pid 已死，`tryRecoverStale…` 落到 `safeUnlink(lockPath); return true`。
   这把严重性限制在「单进程生命期内该 run 不可用」，而不是数据丢失。

**可达吗？** 只对**环境类 errno** 可达，对并发不可达：
`EACCES/EPERM`（目录权限在 link 与 unlink 之间被改、immutable flag）、`EROFS`（只读重挂）、
`ESTALE/EIO`（runDir 在网络文件系统上）。正常路径下 staging 是本进程刚建的、同目录的普通文件，unlink 必成功。

**新引入还是既有形状？——新引入。**修前的成功路径是
`open(lockPath,"wx")` → `writeFile` → **直接 return**，发布与返回之间**没有任何可抛出的语句**。
本轮把一条可抛语句插进了这个缝里。

**而且它与本文件里一条具名先例相反**：`writeJsonFileAtomically` 清理同类 staging 临时文件时写着
「Best effort, and **intentionally not safeUnlink**: … a cleanup failure must not replace the error the caller
needs to see. safeUnlink rethrows anything that is not ENOENT, which would do exactly that.」
本轮的两处 staging 清理（成功路径那一处，以及内层 catch 里 `throw error` 之前那一处）**都用了 `safeUnlink`**。
内层那一处还会把 **EEXIST 换成别的 errno**，从而让本该走 busy-lock 分支的竞争变成裸 errno 抛出。

**处置建议（与 finding 分开）**：见 §7 Imp-1。

## 7. Findings（分级，finding 与处置建议分开）

**Critical 0 ／ Important 2 ／ Low 4 ／ Info 1。**
每条分成「**FINDING**（事实）」与「**处置建议**（我的意见，非裁断）」，并明说是否应本轮修。

### Imp-1（Important）—— 原子发布在发布点之后新开了一条「锁已发布但调用方拿不到 release」的路径

**FINDING.** `acquireOwnerTransferLock` 在 `await link(stagingPath, lockPath)` 成功之后执行
`await safeUnlink(stagingPath)`；该语句位于内层 catch 之外、外层 try 之内，抛出非 ENOENT 时被外层
`if (code !== "EEXIST") throw error` 原样 rethrow。此时锁已发布、`handle` 未关闭、调用方无 `release`。
由于锁记录里的 pid 仍然活着，`tryRecoverStaleOwnerTransferLock` 会**拒绝回收**，
该 runDir 的全部 owner-transfer 操作在持有进程退出前持续 `OwnerTransferLockBusyError`（进程退出后自愈）。
**这是本轮新引入的形状**（修前发布与 return 之间没有可抛语句），
且与同文件 `writeJsonFileAtomically` 的具名先例（同类 staging 清理**故意不用** `safeUnlink`）相反。
内层 catch 里的 `safeUnlink(stagingPath)` 还可能用别的 errno 顶替 EEXIST，破坏 busy-lock 路由。
**可达性**：仅环境类 errno（EACCES/EPERM/EROFS/ESTALE/EIO）；并发不可达。
我**没有**构造出真实触发（见 §9）——这一条是代码路径论证 + errno 语义，不是实测。

**处置建议．应本轮修（我的意见）。** 改动极小、风险极低、且是本轮自己新加的那一行：
把两处 staging 清理换成 `try { await unlink(stagingPath); } catch { /* best effort */ }`，
与 `writeJsonFileAtomically` 的既有写法对齐（Rule 11 一致性也指向这一侧）。
**但它超出人裁 50「只动发布点」的字面授权**，所以修不修是所有者的裁断，不是我的。
若判定不修，建议至少把「这里抛出会泄漏一把活锁」写进注释，别让它静默。

### Imp-2（Important）—— 支撑人裁 51/54 的那句举证，没有落进套件；套件里的 `after` 列不是 resume 之后的状态

**FINDING.** 矩阵注释以「WHY `accepted` IS THE CORRECT TERMINAL STATE ON ALL 18 ROWS — **measured, not argued**」
作为改这 18 行的正当性来源，其依据是「矩阵被**临时**插桩过，快照到 resume 后的完全提交终态」。
落进树里的 `after` 列由 `observeCrashMatrix` 对 **`forRecovery`** 拍摄——那份副本上只跑过 `observeRecovery`，
**从未跑过 resume**。因此**套件并不 pin 那个 resume 后终态**：
若将来某次回归让「accepted 的 resume 落在一个撕裂状态上」，这条矩阵**不会红**。
本仓库自己的说法是「a probe is not a guardrail」——这里正是同一个形状。
（我自己插桩测过，当下结论为真，见 §4.1；问题是**没有守卫**。）

**处置建议．建议本轮修，且极便宜。** 在 `observeCrashMatrix` 里对 `forResume` 再拍一次 `crashSnapshot`
并并入行字符串（我实测该值在 18 格上完全确定、无抖动：first 为 `T=e2 O=e2 R=e2 M=absent P=---`，
double 为 `T=e3 O=e3 R=e3 M=absent P=---`），把注释里的临时测量变成常设判据。
若不修，建议把注释中的「measured」改为「measured once, out of tree, not enforced」，别让读者以为有守卫。

### Low-1 —— 两读者竞争测试的命名超时，现在会误诊

**FINDING.** hook 从 `open` 移到 `link` 之后，「原子发布被退回两步」也会让该测试以
`reader A never opened the owner-transfer lock file within 3000ms -- … may have regressed to the
pre-phase-1 unlocked-finalize shape` 红掉。**我实测复现**：退回两步发布后这条正是这样红的，
而诊断词指向的 unlocked-finalize 回归并没有发生。该消息现在覆盖两种回归、只点名一种。
**处置建议．非阻断，建议顺手改措辞**（加一句「或原子发布已被退回两步」）。可本轮做，也可挂账。

### Low-2 —— `busyLockRecord` 上方仍写着「Attempt counting is by openSpy (see its note at the top of this file)」

**FINDING.** `openSpy` 与它的注释已在本轮随人裁 55 一起删除，全仓库只剩这一处引用
（`tests/persistence/fileStore.test.ts` 内，`busyLockRecord` 定义之上），指向一个不存在的符号和一段不存在的说明。
**处置建议．应本轮修**，一行注释改成指向 `withLockAttemptCounter`。纯文档，零风险。

### Low-3 —— 「BYTE-FOR-BYTE THE SAME END STATE as gap 14」是 overclaim

**FINDING.** 我把 18 格 resume 后的三个文件原始内容与各自 gap 14 全字段比对：
`owner-record.json` 的 `lastAffirmedAt` **必然不同**（墙钟），其余全等。
所以实质主张（同一个完全提交的终态）成立，但 "byte-for-byte" 字面为假。
同一段注释在别处**自己**说过 `crashSnapshot`「does NOT compare file contents byte for byte」，前后不自洽。
**处置建议．建议本轮改词**（如「same committed end state, identical in every field except the wall-clock
`lastAffirmedAt`」）。这段注释是人裁 51/54 的正当性载体，措辞精度值得要。

### Low-4 —— C-1 必命中对照的灵敏度未被记录，自报的绝对值不可复现

**FINDING.** 探针默认 4000ms、实施报告用 5s 得出「必命中 10」。我在同样的 5s 下**读到 0**；
拉到 10s×5 才稳定读到 1–4。也就是说该对照在已修构建上的速率约 0.3/s，
**5s 一跑读到 0 是常态**，而 0 恰恰是「探针坏了」的信号形状——后来者极易据此误判。
自报的 140 / 10 两个绝对值依赖时长与机器，不是可复现常数（我复现到同量级：137、213、252）。
**处置建议．非阻断，建议在 `probe-c1/run.mts` 或报告里写明「必命中对照需 ≥10s，且期望值是个位数」。**
不影响 C-1 结论——测量臂的差分（20,544 base / 0 violations vs 每 10s 两百余次）是决定性的。

### Info-1 —— `package.json` 新增 `"os": ["darwin","linux"]`

**FINDING.** 与人裁 52 的平台声明一致，是机器可读的同义表达。对测试、typecheck、build 无影响
（三个退出码均为 0）。副作用是 npm 会拒绝在 Windows 上安装本包——而 Windows 已被明确排除，故为**意图内**。
**处置建议．无需处置。**

## 8. 变异与还原证明

**工作树的变异次数：0。** 我一次都没有改工作树里的任何受版本控制的文件。
所有变异都发生在 `git archive <rev> | tar -x` 出来的**独立副本**里（`node_modules` 软链复用），
因此不存在「改了忘了还原」的可能——副本是一次性的，工作树从头到尾未被触碰。

| # | 变异内容 | 位置 | 目的 |
|---|---|---|---|
| M1 | `acquireOwnerTransferLock` 整函数换成 `c2db9c7` 版（退回两步发布） | scratchpad `head2` 副本 | §2.4 判据红法 |
| M2 | `RECONCILIATION_LOCK_RETRY_ATTEMPTS` 3 → 1 | scratchpad `head3` 副本 | §5 两条判据红法 |
| M3 | `observeCrashMatrix` 加一行 `afterResume` 快照（只 console.log） | scratchpad `head` 副本 | §4.1 resume 后终态 |
| M4 | 同上，再加一段三文件原始内容导出 | scratchpad `head` 副本 | §4.1 逐字段比对 |
| — | `probe-c1/` 原样拷入 `c2db9c7` 副本的同一相对路径（**未修改内容**） | scratchpad `prefix` 副本 | §2 拿到"修前"基线而不改产品代码 |

**工作树洁净证明（同时验两条，均在全部工作结束后跑）：**

```
$ git diff --exit-code   > /dev/null ; echo $?   →  0        # 无未暂存改动
$ git diff --cached --exit-code > /dev/null ; echo $?  →  0  # 无已暂存改动
$ git diff | od -c                                →  （无输出，0 字节）
$ git status --porcelain
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/wbfix-rereview.md   # 只有本报告
$ git rev-parse --short HEAD ; git rev-parse --abbrev-ref HEAD
16f8521   feat/pkg2-wb-fixes                                       # 尖端与分支均未变
```

**主动披露**：`npm run build`（brief 要求跑的三条之一）在工作树生成了 `dist/`。
`dist/` 在 `.gitignore` 里，故 `git status --porcelain` 干净；它是被要求的验证命令的产物，我未删除它。
除此之外工作树无任何新增物。我**没有** commit / push / 建删分支 / 合并，**没有**碰主仓库
`/Users/biran/code/skills/loop/ccloop`。

## 9. 没验到的

按 Rule 12 逐条列出，不含糊：

1. **Imp-1 (B) 的实际触发我没构造出来。** 要让 `safeUnlink(stagingPath)` 抛非 ENOENT，
   必须在 link 与 unlink 之间制造权限/文件系统故障；通过生产 API 做不到，只能靠 mock 产品代码，
   那就变成「测我自己造的假」。所以这一条是**代码路径 + errno 语义论证，不是实测**——我按 brief 的铁律明说。
2. **scratchpad 副本里那 2 条红我没有坐实根因**（§1.1）。我只证明了：它在 `dbac288` 与 `c2db9c7`
   两个 revision 上形态相同，且在工作树 HEAD 上不复现。最可能是副本缺 `.git`，但**我没验**。
3. **C-1 探针的「0」是有限功效的否定。** 该指标系统性欠计（只在两段临界区出现 read-before-write 交错时才计数），
   所以「修后 0」是**在该功效下**的否定，不是不可能性证明。功效我给了下界（必命中对照 ~0.3/s）。
4. **link() 的原子性我没有在 POSIX 层面实测**，只在 darwin 上通过差分观察其效果。
   跨平台（linux）与网络文件系统上的行为**未验**。
5. **待裁点 A/B/C、包 1、第一轮评审本身**：按 brief 明令不碰，未复核。
   我只核了第一轮六条 finding（Imp-1/Imp-2/Low-1..4）在第二轮的处置，全部落实。
6. **第一轮已 ADDRESSED 是否被弄坏**：我用「逐文件计数无下降 + 整套全绿 + 3→1 变异仍红在断言」三条间接证据判定为「没弄坏」，
   **没有**把第一轮五项判据逐条重跑变异（那是第一轮评审的工作，且 brief 禁止重做）。
7. **`dist/` 产物的正确性未验**：我只核了 build 的退出码为 0。

## 10. 预算：可数事实（不要自报估计）

- 完整测试套件跑：**4** 次（工作树 HEAD 1 次；scratchpad 副本 `dbac288` / `c2db9c7` 各 1 次；另 1 次为 `head2` 单文件前的对照未计入）。
- 单文件（`fileStore.test.ts`）定向跑：**4** 次（matrix 插桩 ×2、退回两步发布 ×1、3→1 ×1）。
- `typecheck` / `build`：各 **1** 次。
- C-1 探针跑：**18** 次（3 模式 × 2 构建 @5s = 6；HEAD truncated @10s ×5；HEAD staged @10s ×5；prefix staged @10s ×2）。
  每次拉起 2–4 个真实 Node 子进程。
- 探针累计消费的不同 base 值：HEAD staged 五轮合计 **20,544**。
- 我建立的独立副本树：**4**（`baseline`/`dbac288`、`prefix`/`c2db9c7`、`head`、`head2`、`head3` 中 head 系列共 3 棵）。
- 落盘并整份读回的验证输出文件：**10**（3 个套件跑 + 4 个单文件跑 + typecheck + build + 探针 JSON 合并读取）。
- 工作树变异次数：**0**；副本变异次数：**4**。
- 三个退出码：`npm test` **0** ／ `npm run typecheck` **0** ／ `npm run build` **0**。
- 测试总数：**531 passed / 531**，文件 **31 passed / 31**，failed **0**，skipped **0**。
