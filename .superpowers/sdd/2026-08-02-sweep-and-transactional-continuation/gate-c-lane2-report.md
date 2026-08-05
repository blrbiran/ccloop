# GATE-C lane 2 报告 —— 变异与测试证据的全量重扫 + deferred minor 分诊

**评审员**：GATE-C 2 号，整分支评审，未参与 C1–C4 任何一条。
**范围**：`2713c20..4a24a94`，八笔提交，worktree `/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep`。
**车道**：变异证据、抽查复跑、断言强度、deferred minor 分诊。生产代码与整分支设计归 1 号评审员。

## 结论

**PASS WITH CONDITIONS**（0 Critical，1 Important，若干 Minor）。

条件四条，**没有一条要求改生产代码**：

1. **【Important】裁定 C2 concern 4 并记账**——它被上报求裁，然后被沉默关闭了（见 §5.1）。
2. 补记四条清单漏掉的缺陷：C2-M5 / C2-M6 / C3-M6，以及 C4 §B 一处论证错误（§5）。
3. 就地改掉 C3-M4 的算术（文档一行，零风险）。
4. 记下行号引用的统一裁定（§4，独立条目 2）——这一族会反复复发，需要一条常设规则。

---

## 1. 变异实验全量重扫

**我自己数出来的总数：16 次注入 / 14 个不同的变异设计。** 其中 **14 次击杀**、**2 次实测存活且被原样记录**（C2 变异 3 第一版、C3 变异一原版）。
**14 次击杀全部三步齐全、全部显示具名测试的非零计数、全部红在报告声称的那条断言上、机制全部与声称一致。**

| # | 任务 | 变异 | 目标测试 | 三步 | 具名非零计数 | 红在声称的断言 | 机制 |
|---|---|---|---|---|---|---|---|
| 1 | C1 | 配额每次调用都计数 | 12b(b) `does not spend quota on a refused run` | ✅ | `1 failed \| 6 skipped` | ✅ :253 | ✅ |
| 2 | C1 | 计数点退回 `resume` 返回时 | 12b(c) | ✅ | ✅ | ✅ :284 | ✅ |
| 3 | C1 | 去掉排序 | 12b(a) | ✅ | ✅ | ✅ :216 | ✅ |
| 4 | C2 | 按信号种类分别计数 | `registerStopHandlers >` 那条 | ✅ | ✅ | ✅ :426 | ✅ |
| 5 | C2 | `--max-runs` 缺失取默认 `?? "1"` | `exits 1 when --max-runs is missing` | ✅ | ✅ | ✅ :307 | ✅ |
| 6 | C2 | 位置参数 root 第一版 | `rejects a positional root…` | **存活**，原样记录 | ✅ | — | 已诊断（配对整体错位） |
| 7 | C2 | 位置参数 root 第二版 | 同上 | ✅ | ✅ | ✅ :295 | ✅ |
| 8 | C3 | 变异一原版（`resumeLoop.ts` 前缀字面量） | 12c | **存活**，实施者上报 + 评审员独立复现 | ✅ | — | 已证无数据通路 |
| 9 | C3 | 变异一替换版（`sweepRuns.ts` 自己的 `classifyThrow` 字面量） | 12c | ✅ | ✅ | ✅ :511 | ✅ **本车道重跑** |
| 10 | C3 | 变异二（备注路由进 `error` 格） | 12d(i) (2)(3) | ✅ | ✅ | ✅ :544 | ✅ |
| 11 | C3 | 变异三（不路由） | 12d(i) (1) | ✅ | ✅ | ✅ :551 | ✅ |
| 12 | C3 | 变异四（`resume` 返回后才记） | 12d(ii) | ✅ | ✅ | ✅ :585 | ✅ + 12d(i) 同注入存活 |
| 13 | C3 | 变异五（删 `\|\| RunLeaseHeldError`） | 报告格式测试 | ✅ | ✅ | ✅ | ✅ |
| 14 | C3 | 缓冲变异 | 12d(ii) 的 `toEqual` | ✅ | ✅ | ✅ :601 | ✅ 纯置换 **本车道重跑** |
| 15 | C4 | sweep 对非 eligible 行也 `resume` | 测试 14 | ✅ | ✅ | 首红是 stdout 断言，伴生断言由探针另证 | ✅ |
| 16 | C4 | `recoverInterruptedOwnerTransfer` 无锁早退 | 测试 14b | ✅ | ✅ | ✅ :706 | ✅ |

### 1.1 计数与报告目录的不一致（Minor，文档）

**C3 的 §9 标题「计划的四次 + 我自己加的第五次」在两轮修复之后已经作废。** C3 实际的变异实验是 **7 次**（§3 的原版存活、§9.1–9.3b 的四次、R1.2 的替换版、R2.2 的缓冲变异），标题从未勘误，且这七次散落在三个互不索引的章节里——只读 §9 的人会数出 5 并漏掉 R1.2 与 R2.2 这两条**最载重**的。
与 C3-M4（§3.1 遗留的旧算术）同族，高一层：那是数字过期，这是**清单过期**。全分支没有任何一处给出跨任务的变异总数。
→ **只记录**（并建议 GATE 把上面那张表当作该总数的落点）。

### 1.2 证据形状上的三处观察（均不构成缺口）

- **C2 变异 1 与变异 3 没有「本块内的注入前绿」**，指向 §5.2 更早的两道围栏（22:43:49 / 22:44:07）。那两道围栏真实、未过滤、具名、非零、且在同一棵树上先于注入，**三步判据成立**；但读者要跨节导航。C1 对同族缺陷选了「就地补跑」，C2 选了「引用」，两者不一致。→ 只记录。
- **C4 变异一的首红是 stdout 断言，不是计划要求的伴生断言**；实施者用一次带标记的测试侧探针另证了伴生断言本体也红，并已还原、零命中。**我用另一条完全不同的路径独立证实了伴生断言的非空洞性（§3.1 探针 4），结论一致。** → 达标，C4 concern 6 已自曝，只记录。
- **C1 §5 的三道「实现之前」红围栏不可重跑**（C1-M5）。裁定见 §4。

---

## 2. 抽查复跑（三条，我亲手三步齐走）

环境：`export ECC_GATEGUARD=off DISABLE_OMC=1`，每条命令目录写死 `bash -c 'cd <worktree> && …'`，全部以 vitest 首行 `RUN v2.1.9 …/worktrees/l3-group-c-sweep` 验收，**输出零过滤**。

### 2.1 C3 修复轮 1 的替换变异（必挑）—— **完全复现**

注入 `src/sweep/sweepRuns.ts:66` 的 `startsWith("cannot read run artifacts:")` → `startsWith("LANE2MUT1B run artifacts:")`。

- 注入前：`Tests 1 passed | 11 skipped (12)`，`LANE2_PRE_M1B_EXIT=0`
- 注入后：`Tests 1 failed | 11 skipped (12)`，`LANE2_POST_M1B_EXIT=1`，红在 `tests/sweep/sweepRuns.test.ts:511` 的 `expect(h.stderrLines.slice(1))`，`expected [] to deeply equal [ Array(1) ]`，received `Array []`
- 还原后：`Tests 1 passed | 11 skipped (12)`，`LANE2_RESTORED_M1B_EXIT=0`

**判据行、行号、断言文本、diff 方向与报告 R1.2 逐字一致。** 机制经我独立确认：run-1 从 stderr/`error` 整个掉回 stdout/`refused`（`readFailure` 仍是 `ResumeNotEligibleError`，走第二支）——**正是声称的机制，不是别的理由**。

### 2.2 C3 修复轮 2 的缓冲变异（必挑）—— **完全复现，且证据比报告更强**

把回调改回 `lane2BufNotes.push(...)`、循环后统一冲出（三处带 `LANE2-MUT-BUFFERED` 标记）。**我跑的是整文件而不是单条**，因为要同时回答「是不是只有一条断言能区分」。

- 注入前整文件：`Tests 12 passed (12)`，`LANE2_PRE_BUF_WHOLEFILE_EXIT=0`
- 注入后整文件：**`Tests 1 failed | 11 passed (12)`**，`LANE2_POST_BUF_WHOLEFILE_EXIT=1`
- 还原后整文件：`Tests 12 passed (12)`，`LANE2_RESTORED_BUF_EXIT=0`

红在 `:601` 的 `expect(h.stderrLines).toEqual([...])`。**它确因顺序而红，不是因元素多少或内容不同**——这一点我逐条核了 diff：

```
  Array [
    "sweep: 1 eligible run(s) under /fake/root, will attempt at most 100, adapter=scripted",
-   "note  /fake/root/run-1  reconciliation_write_abandoned  EACCES: …"
    "/fake/root/run-1	error	ENOSPC: no space left on device, write loop-state.json",
+   "note  /fake/root/run-1  reconciliation_write_abandoned  EACCES: …"
  ]
```

两侧都是 3 个元素、三条字符串逐字相同、只有 note 与 error 互换位置——**一次纯置换**。
**副产品**：`1 failed | 11 passed` 在**测试粒度**上证明了实施者 R2.2a 的自陈属实且完整（全文件只有这一条能区分即时与缓冲），这比逐条断言的人工表格更硬。

### 2.3 第三条（我自己选）：C1 变异一，跑在**今天**（被 C3 改过）的源码上 —— **复现，且判别力变强了**

选它的理由：它是 12b(b) 的**唯一**判别来源，而 12b(b) 在「还没有配额逻辑」的中间态就是绿的；C1 又是本分支证据事故最多的一条。注入 `adopted += 1; // LANE2-MUT-C1M1` 于 `resume` 之前，并清空 `onAdopted` 体。

- 注入前具名：`Tests 1 passed | 11 skipped (12)`，`LANE2_PRE_C1M1_EXIT=0`
- 注入后整文件：**`Tests 3 failed | 9 passed (12)`**，`LANE2_POST_C1M1_WHOLEFILE_EXIT=1`
  - `does not spend quota on a refused run` 红在 `:260` `expect(adoptions).toEqual(['/fake/root/run-3'])`
  - `prints one tab-aligned report line per attempted run and a summary line` 红在 `:475`，`quota 7/8` → `quota 8/8`
  - `routes a cannot-read-run-artifacts refusal…` 红在 `:513`，`quota 0/100` → `quota 2/100`
- 还原后整文件：`Tests 12 passed (12)`，`LANE2_RESTORED_C1M1_EXIT=0`

**这是一条 ledger 上没有的新信息**：C1 时期配额记账点只有 12b(b) 一条护栏；C3 把 `quota N/M` 写进汇总行之后，它多了**两条独立见证**。判别力不但没退化，还长了。见 §4 对 C1-M5 的裁定。

### 2.4 树是否还原干净

三条复跑 + §3 的五次探针全部还原。最终证明（同一条命令，输出照贴）：

```
LANE2_MARKER_GREP_EXIT=1        ← grep -rnF -e LANE2-MUT -e LANE2-PROBE -e LANE2MUT src tests：零命中
PORCELAIN_ABOVE                 ← 其上无任何行 ⇒ git status --porcelain 为空
4a24a94302afb72efdc5983c9ebbc17f3fac406a   ← git rev-parse HEAD，与开工时逐字相同
25430371393b895aa03a9dc1f4b38e5044c9e49e459660a027d260ab0ca36fa2  src/sweep/sweepRuns.ts
```

`shasum` 在第一次注入之前与全部还原之后取值相同。**命令确实能命中我用过的标记**：`LANE2-MUT-C1M1` / `LANE2-MUT-BUFFERED` / `LANE2MUT1B` / `LANE2-MUT-C2LEAK` / `LANE2-PROBE-C4-P1/P3/P4` 全部是我写进文件的字面串，注入期间同一条 grep 必然命中。
**一处诚实披露**：把扫描面扩到 `docs .superpowers` 时有 **1 条命中**，位于 `.superpowers/sdd/…/gate-b-lane2-report.md:55`——那是**组 B 评审员自己报告里的正文**（`LANE2MUT2_OFF`），不是残留物。`src/` 与 `tests/` 下零命中。

---

## 3. 测试证据本身的强度（不只看变异，看断言能不能失败）

### 3.1 C4 的三条前提断言 + 那条伴生断言 —— **四条全部可失败，我独立撞过**

C4 的任务评审员声称逐条撞过、四次红都是预期机制。**我不接受转述，自己撞了一遍。**

| 探针 | 做法 | 结果 |
|---|---|---|
| 机制一 (b) | fixture 的 `leaseAffirmedAt` 改成 `"2020-01-01T00:00:00.000Z"` | 红在 `:468`，`expected '2020-01-01T00:00:00.000Z' to be null` |
| 机制一 (c)（隔离） | 同上，并把 (a)(b) 置空以放行到 (c) | 红在 `:471`，**`expected 'expired' to be 'no_lease'`** —— 与 C4 评审员的说法逐字一致 |
| 机制三（fixture 侧） | `reconciliation-record` 的 `eligibleForContinuation` 翻成 `true` | 红在 `:489`，`expected true to be false` |
| 机制三（写者侧，隔离） | 同上，并把 `:489` 置空 | 红在 `:523`：该 run **被采纳了**（`quota 1/5`），一路穿过八条判据与 CAS 门，落在 `blocked_waiting_human stopReason=workspace unavailable: Error: spawn git ENOENT` —— 拒绝确实来自资格门 |
| 伴生断言 | 干脆**不建**那个非 eligible 目录 | 红在 `:42`/`:494`：**`snapshotTree` 自己抛 ENOENT** |

**结论：四条前提断言与伴生断言全部可失败，且都因预期机制而红。**

**但由此发现 C4 §B 的一处论证错误（Minor，文档）。** §B 写着「`{}` 与 `{}` 深比较相等，所以『目录不存在 / 快照为空』会让主断言空过」。**「目录不存在」这一半是假的**：`snapshotTree` 用 `readdir` 走树，缺目录直接抛 ENOENT，那个空过场景**根本构造不出来**。`seededFiles` 那道护栏依然正确、依然必要（它挡的是「目录在但空」那一半），但**印在它旁边的理由是错的**。在一条以「红得对不对」为货币的分支上，正确断言旁边一句错误机制值得记一笔。

### 3.2 C3 的「即时 vs 缓冲」只挂在一条断言上 —— **自陈属实且完整**

见 §2.2。整文件在缓冲注入下 `1 failed | 11 passed`——**测试粒度的实测**，不是推断。实施者 R2.2a 逐条列的表（12d(i) 六条全无差别、12d(ii) 三条里两条无差别）与这个观测一致。**它没有把话说满，也没有漏报。**
C3-M5 指出的脆弱性是真的：这条区分成立的前提是 12d(ii) 的替身在 note 之后还会抛出（要有第二条 stderr 行，先后才有意义）。**去掉那次抛出，区分静默消失而全套件仍绿。**

### 3.3 C1 的 12b(b) —— **今天能失败，而且判别力比 C1 时期更强**

见 §2.3。一次注入红三条，12b(b) 本身红在 `:260`。**可失败，且不再是孤证。**

### 3.4 C2 的监听器泄漏断言 —— **能失败，我独立撞过**

把 `registerStopHandlers` 返回的反注册闭包清空（`LANE2-MUT-C2LEAK`）：

```
 × registerStopHandlers > sets the slot on the first signal and exits 130 on the second, counting SIGINT and SIGTERM together
AssertionError: expected 1 to be +0 // Object.is equality
 ❯ tests/cli/cli.test.ts:433:45   expect(process.listenerCount("SIGINT")).toBe(listenersBefore.int);
 Tests  1 failed | 22 skipped (23)      LANE2_POST_C2LEAK_EXIT=1
```

还原后 `Tests 1 passed | 22 skipped (23)`，`LANE2_RESTORED_C2LEAK_EXIT=0`。
**并且它的两条前置断言（`listenersBefore.int + 1` / `+ 1`）挡住了「什么都没注册」那种假绿**——这一点我读了测试正文确认，C2 评审员的说法成立。

**四组小结：可失败 / 可失败 / 可失败 / 可失败。四组都不是恒真，四组都不存疑。**

---

## 4. deferred minor 分诊（16 条）+ 三条独立条目

处置三档：**合并前修** / **带到 L5** / **只记录**。

| 条目 | 处置 | 理由 |
|---|---|---|
| C1-M1 | 只记录（已闭合） | C3 从报告层结构性解决（`tally[outcome] += 1` 每 attempted run 恰好一次），不是继承 |
| C1-M2 | 带到 L5 | 横幅全字面被钉在一条「主语是顺序」的测试里；C3 确实改过横幅也确实动了那条测试。噪声，非缺陷 |
| C1-M3 | 带到 L5 | `rootFailure → stderr + return 1` 是本层唯一非零退出、无测试。**与我在 §5.2 新发现的 C2 concern 8 同族，两条应一起承接** |
| C1-M4 | 只记录 | 措辞过度（「全文披露」实为转述），非伪造 |
| **C1-M5** | **只记录，明确不重建** | 见下方专段裁定 |
| C2-M1 | 带到 L5 | 「`--max-runs` 作为末位 token 无值」未测。注意：变异 5（`?? "1"`）已覆盖「完全缺席」那格并击杀，真正敞开的只有末位那格 |
| C2-M2 | 带到 L5 | `--adapter-config` 指向 `{}` → TypeError → exit 1，退出码表措辞未覆盖；与既有 run/resume 同形，非本波新增 |
| C2-M3 | 带到 L5 | `--adapter bogus` → exit 1 在 `main sweep` 下无 `it` |
| C2-M4 | 带到 L5（见独立条目 2） | 顶失效的是**当前** L3 spec |
| C3-M1 | 只记录 | 汇总行三格不可加，是计划**自己规定**的格式，非任务缺陷 |
| C3-M2 | 只记录，**明确不许「清理」** | 五个只写不读的格是 `Record<Outcome, number>` 让「每 run 恰好一格」成为类型级性质的代价，收成三个变量会丢掉 Outcome 域的穷尽检查 |
| C3-M3 | 已闭合 | 折进修复轮 1 |
| **C3-M4** | **合并前修** | §3.1 仍带着 §3.3 已更正掉的「17+4」。文档一行、零风险，且这是**同一处算术第二次滑过**。在一条以证据完整性为主题的分支上留一个已知错误的数字，信号是错的 |
| C3-M5 | 带到 L5，**触发条件写进条目** | 「若 12d(ii) 的替身不再抛出，区分静默消失」。脆弱性经 §2.2 实测确认为真 |
| C4-M1 | 带到 L5 | 14b 未断言 finalize 自己六个 temp 路径无残留；计划 (ii) 只要了 marker 与 pending |
| C4-M2 | 只记录，**永不修**（见独立条目 2） | 顶失效的是历史 SDD 台账 |

### 4.1 专段：C1-M5 的裁定（控制器明确拒绝表态、留给本车道的那一条）

**问题**：C1 §5 的三道「实现之前」红围栏被节略（缺源码上下文框与 `[1/1]` 分隔线）且**不可重跑**（所钉的中间态今天不存在）。判断信息（`×` 行、`1 failed | N skipped`、AssertionError 的期望/实得）逐字仍在，实施者**没有**伪造替代物。控制器写道：三次变异覆盖了**邻近**地面，但是否覆盖**同一批断言**，正是门该查而不是该假设的。

**我查了，答案是：覆盖的就是同一批断言，而且今天的覆盖比当初更强。**

依据不是推理，是 §2.3 的实测：那三道围栏钉的是**配额与停机语义**在实现前的红。今天对同一语义注入 C1 变异一的形状，**一次红三条**——12b(b)（`:260`）、报告格式测试（`:475`）、12c（`:513`），后两条是 C3 把 `quota N/M` 写进汇总行之后**新长出来**的见证。

**裁定：只记录，不重建。** 重建一个已被删除的中间态，产出的证据会**弱于**今天已经存在的三重击杀。要求重建等于用更差的证据替换更好的证据。**这条 open 问题就此关闭。**

### 4.2 独立条目 1 —— `resumeLoop` 的并发裸读

**我自己读了 `src/controller/resumeLoop.ts` 确认**：五份 artifact 在一个 `Promise.all` 里并发读，只有 `readOwnerRecord` 前面挂着 `recoverInterruptedOwnerTransfer`；`readOwnerTransferRecord` / `readReconciliationRecord` / `readRunState` 是裸读，与 finalize 的 rename 竞争。C4 的红原始输出（`zeroWrite.test.ts:668`）是这条性质的直接证据。

**分级：带到 L5，不阻塞合并。承接方 = L5 中负责 resume 读侧顺序的那一波**（它是 L2 §7.1 registry 侧保护的同胞，resume 路径从未拿到那层保护）。
**理由**：已被独立构造复现，结论是一次**可重试的拒绝**——`Promise.all` 的 reject 不取消 `readOwnerRecord` 链，300ms 后 marker 已消失、epoch 已转到 2、reconciliation record 已发布，sweep #2 直达 `succeeded`；`cli.ts` 只在**双击 SIGINT** 时才 `process.exit`，pending 的 fs 工作正常排空。**不是数据丢失。** sweep 改变的只是撞上它的**频率**。

**但我要给这条加一句评审员没说、而它改变分级理由的事实**：因为 `classifyThrow` 的前缀支路优先，这个**健康的** run 被分类为 `error` 并写到 **stderr**——而 C3 整个设计意图就是「stderr 是 cron 的告警通道」（R2.1 的勘误原话：「可见性由 stderr 独家兑现」）。**于是一次瞬时、自愈的竞争会产生一次假告警（false page）。** 这不只是「一条误导性的 `error` 行」，是一处**可运维性缺陷**。L5 条目应当按这个措辞记，否则承接方会低估它。

### 4.3 独立条目 2 —— 三条行号引用（统一处置意见）

**它们不是一族。分界线是「顶失效的文档今天还活不活」，这一点我逐条查过落点。**

- **B2-M4 与 C4-M2 → 只记录，永不修。** 实测：`zeroWrite.test.ts:92`/`:187` 的引用只出现在 `.superpowers/sdd/2026-07-28-run-registry/progress.md`、本波 `progress.md` 与 `task-C4-report.md`——**全部是历史台账与任务报告**。改写一份历史台账，危害大于一个过期行号。本仓库既有立场（不重写历史文档）在这里完全适用。
- **C2-M4 → 带到 L5 的文档卫生项，不阻塞合并。** 实测：引用在 `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`——**当前 L3 spec**，后续每一波都还在导航它。今天的真值是 244 / 248（两处 `? 0 : 2`）与 241（`loadAdapter`）。
  **两处更正**：(a) C2-M4 说「三处引用」——**是三条不同引用，但四个站点**（`:661`、`:668`、`:1499`、`:2948`）；(b) 不阻塞合并的理由是四个站点**每一处都同时印了符号名**，`:2948` 甚至直接印了重推命令，读者可以自行重derive。
- **统一裁定（根因，只需应用一次）**：**在这份 spec 里，凡已随附符号名或重推命令的引用，一律把行号锚点换成「符号 + grep 命令」锚点。** 建议 GATE 把它记成常设规则——这一族在组 B 与组 C 各复发一次，靠逐条打补丁是止不住的。

### 4.4 独立条目 3 —— 组 B 两条账在组 C 落地后是否仍不可达

**两条都由我从源码重新推导，不继承 C2 的结论。**

- **B1 分支的 `writeRunState` 无 CAS —— 仍然不可达。** 实测：`.stop()` 在 `src/` 下今天恰好两个生产调用点（`src/controller/runLoop.ts:989`、`src/controller/resumeLoop.ts:215`），两处都在 `runLoopFromState` 之后的 `finally` 里；`src/controller/runLoop.ts` 在本分支零改动。sweep 的 `StopRequestSignal` 是**另一套机制**（`signal.requested` 布尔槽），`registerStopHandlers` 的闭包只拿到那个槽和一个注入的 `exit`，够不到任何 heartbeat。→ **GATE-B 条件 1 继续 defer 到 L5，触发条件不变。**
- **谓词加宽半边无测试守卫 —— 仍然不可达，但放大器变了。** 它的安全论证是一条**界**：没有任何一条到 `persistBoundaryAnalysis` 的路由会不经过终态。组 C 只为删除死孪生动过 `fileStore.ts`。C1 的评审员追踪过：sweep **不新增路由**，只让一条既有路由在一个进程内被走 N 次，而全仓每一处 `currentProcessInstanceId` 比较都在**同一个 runDir 之内**，没有跨 run 比较。→ **界成立，仍不可达，仍无测试守卫，原样带到 L5。**
  **要加进那条 L5 条目的一句**：这条界今天由一份**推理产物**而非一条测试守着，而 sweep 把它的走访次数乘了 N。将来任何一波若新增一条绕过终态到 `persistBoundaryAnalysis` 的路由，**每一次人类批准的爆炸半径就是 N 倍**。这个放大器必须写进条目，否则承接方只会看到「不可达」。

---

## 5. 清单上没有的东西（本车道最有价值的产出）

**有。六条。其中一条是 Important。**

### 5.1【Important】C2 concern 4 被上报求裁，然后被沉默关闭了

`exits 1 when --max-runs is not a positive integer` **一条 `it` 里跑了六个值**，而计划明写「每一格各一条 `it`，**不许合成**」。实施者没有自作主张，明确写下：「若评审认为这算合成，需要拆成六条」——**这是一次点名求裁**。

然后：C2 的评审返回 0 Critical / 0 Important / 3 Minor；`progress.md` 记下 C2-M1..M4；**四条里没有一条是它。全分支没有任何地方回答过这个问题。**

这正是本次派单警告的那种形状——「因错误理由而结清」——只不过发生在**规格符合性**问题上而不是变异上：一个被提出的问题，**被沉默关闭**，读台账的人会以为它不存在。

**必须由门回答，不能继续沉默。** 我自己的读法与实施者一致（「格」= 退出码表的一格，「非正整数」是一格，六个值是同格枚举），**所以我建议裁为「符合」**——但它必须被**裁**并**记账**，而不是没人提。

### 5.2 C2 concern 8 未记账，且与已记账的 C1-M3 同形（分诊不对称）

`registerStopHandlers` 的默认分支 `(code) => process.exit(code)` **没有被任何测试执行过**（13b 覆盖的是注入口那一侧）。
C1-M3（「本层唯一的非零退出路径无测试」）**被记成了 deferred minor**；形状完全相同的这一条**没有**。同一个缺陷形状在同一组里被两种标准处理。
→ **补记为 C2-M5，带到 L5，与 C1-M3 同一个承接方。**

### 5.3 C2 concern 5 未记账：一条依赖 vitest 运行器实现细节的测试

13b 用 `process.emit("SIGINT", …)` 触发**真实的进程处理器**。它在 vitest 2.1.9 默认 pool 下不影响 runner，但换 pool（`threads` ↔ `forks`）或换 vitest 大版本时需要重测。**这是一条静默失效触发器，没有任何地方记着它。**
→ **补记为 C2-M6，带到 L5。**

### 5.4 C3 concerns 2 / 4 / 6 未记账，尽管 C3 自己的 R2.5 声明它们「仍然有效、未变」

`progress.md` 的 C3-M1..M5 一条都没有承接它们。最载重的是 **concern 4**：

> **`note` 行的遍历顺序没有独立测试，只被 12d(i) 顺带覆盖。**

而 **12d(i) 正是我在 §2.2 实测证明对 note 管线的结构性改动完全无感的那条断言**（缓冲注入下它整条通过）。也就是说：**遍历顺序这条性质，今天由一条已被证明「note 管线被重构也不会反应」的测试守着。** 而遍历顺序恰恰是计划**唯一**明写要求的 note 行序性质（R2.1 的勘误原话）。
这个组合值得单独记一笔——它不是「某条性质没测试」，是「守卫存在但已被实测为对该维度失明」。
→ **补记为 C3-M6，带到 L5。** concerns 2（双空格 vs tab）与 6（12d(i) 断言顺序被调整过）属流程/外观，**只记录**即可。

### 5.5 C3 §9 的变异清单在两轮修复后过期

见 §1.1。→ **只记录。**

### 5.6 C4 §B 一处论证错误

见 §3.1。断言是对的，印在旁边的机制是错的。→ **只记录。**

---

## 6. 本车道遵守与未做的事（明写，不含糊）

- **未重跑整套件。** 门上由控制器跑。本车道所有跑都是为三步判据服务的针对性单跑或单文件跑，原始输出逐字照贴，**零 `grep` / 零 `tail` / 零 `head`**。
- **接受的分支基线**：C4 报告 Step 6 的 `Test Files 30 passed (30)` / `Tests 512 passed (512)` / `TEST_EXIT=0`，`RUN` 首行为 worktree——与派单给的 30/512 一致（主仓 29/490）。
- **未复核的**：整分支的生产代码正确性与设计（1 号评审员的车道）；四份实施报告里与变异/断言强度无关的章节（如 C2 §1 的 `loadAdapter` 边界论证、C4 §C 的 fixture 构造细节）我只读到足以判断证据形状为止。
- **未能隔离验证的一处**：C4 §B 提到的「7 个 temp 路径若名字拼错则断言恒真」——**拼错的名字永远不存在，这个风险在结构上不可用探针证伪**，只有 §A 的常量逐条对照作保。C4 concern 2 已自曝，我确认这个风险**真实且不可测**，属 C4-M1 的邻居，一并带到 L5。
