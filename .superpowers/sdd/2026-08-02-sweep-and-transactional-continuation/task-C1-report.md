# Task C1 报告 —— `src/sweep/sweepRuns.ts`：扫描、过滤、排序、配额、顺序续跑

- **工作目录**：`/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep`（分支 `feat/l3-group-c-sweep`，基点 `2713c20`）
- **提交**：`525cdcc`（计划 Step 11 指定的那一笔，逐字使用了 brief 给的 `git add` 清单与 commit message）+ `2b7d3b1`（控制器补充第 2 条追加的死代码删除，单独一笔）
- **未 push**。未碰主仓库工作区，未碰任何别的 worktree。
- **全套件（未过滤）**：`Test Files 30 passed (30)` / `Tests 497 passed (497)` / `EXIT=0`；typecheck exit 0；build exit 0。
- 所有验证命令都走 `rtk proxy "<命令>"`，环境变量先 `export ECC_GATEGUARD=off DISABLE_OMC=1`。**没有任何一条验证命令带 `| grep` / `| tail` / `| head` / `2>/dev/null`。**

---

## 0. C1 修复轮 1（2026-08-04）改了什么

独立评审：规格 ✅、任务质量 Approved、**0 Critical / 0 Important**，三条 Minor 交 GATE-C 分诊。**本轮不碰任何 `.ts` 文件、不碰测试、无新提交**（两笔代码提交 `525cdcc` / `2b7d3b1` 未变），只修本报告的产物完整性：

1. **§8.1 的全套件围栏曾被手工节略** —— 就地标注（原文一字不删）+ §8.1b 补一次**未节略**的全套件重跑（30 文件 / 497 用例 / exit 0）。**这是重跑，不是回填**，原围栏的时间戳与结果原样保留。
2. **变异二/三的「注入前绿」与三道「还原后绿」围栏缺 `$ …` 命令行** —— 选择**重跑**（不是「标注为重建」），逐道补上 2026-08-04 的真实命令与真实输出。
3. **我自己又查出同族缺陷并主动披露**：§5 的部分单跑围栏同样被节略（缺 `RUN` / `Duration` 行、红围栏缺源码上下文框）。可重跑的已重跑或已由 §6 的补跑覆盖；**实现之前那三道红围栏所钉的中间状态今天已不存在、无法重跑复原，也不伪造**——按证据强度损失如实记在 §5。
4. **事故披露**：本轮第一次全套件重跑因 bash cwd 被重置而**跑到了主仓库**（29 文件 / 490 用例），已作废并在 §8.1b 全文记录，之后所有命令都把工作目录写死。

---

## 1. 前置硬门：自己重推 `$A4` 与 `$B`

**没有照抄控制器给的值。** 用验收 7 判据 (1) 的那条命令（只枚举 merge、只打印主题行）重推：

```
$ rtk proxy "git log --merges --format='%h %cd %s' --date=iso --reverse"
143b547 2026-07-19 11:02:03 +0800 Merge branch 'a04-preflight-approval'
c00c96c 2026-07-19 21:38:28 +0800 merge: bring in metadata-backed A-04 boundary
643707a 2026-07-21 23:07:37 +0800 Merge branch 'docs-backlog-truth-alignment-20260721'
2db6db2 2026-07-22 22:36:24 +0800 Merge branch 'stop-no-progress-stale-boundaries-20260721'
1ee7180 2026-07-24 23:37:32 +0800 Merge branch 'ownership-reconciliation-boundaries-20260723'
9960d69 2026-07-25 22:54:31 +0800 Merge branch 'resume-adopt-continuation-20260725'
9ac6855 2026-07-29 00:37:17 +0800 Merge L2 run registry: read-only ccloop ls
3ac12e0 2026-07-31 13:32:37 +0800 Merge debt 4: eliminate the non-atomic write paths in fileStore
d1525c8 2026-07-31 17:59:17 +0800 Merge flake-list correction: the list had made the error it exists to prevent
11cb425 2026-07-31 19:22:25 +0800 Merge BUDGET_EXHAUSTED flake fix: the documented recipe was a no-op
cf4eed4 2026-08-01 09:48:30 +0800 Merge the phase-timing branch: charge budget-capped timeouts from the granted quota
787789e 2026-08-02 13:19:21 +0800 Merge branch 'feat/l3-debt1-transactional-continuation' into main
94d7c0a 2026-08-02 23:10:38 +0800 Merge branch 'feat/l3-debt1-transactional-continuation' into main
e5bf650 2026-08-03 20:03:44 +0800 GATE-A PASSED: L3 debt 1 group A (A1-A9), two independent reviewers, 0 Critical
bafa6a6 2026-08-04 21:03:46 +0800 GATE-B PASSED: L3 debt 3 group B (B1-B2), two independent reviewers, 0 Critical
```

**我推出来的：**

- **`$A4` = `e5bf650`** —— 唯一一笔主题行带组 A 评审结论的 merge（`GATE-A PASSED … two independent reviewers, 0 Critical`）。
- **`$B` = `bafa6a6`** —— 同理，组 B 的门。

**与控制器给的 `e5bf650` / `bafa6a6` 一致，无需停下上报。**

控制器提醒的那两笔干扰项也确认存在且确实不是门：`787789e` 与 `94d7c0a` 都指向 `feat/l3-debt1-transactional-continuation`，主题行只有 `Merge branch … into main`，**不带任何评审结论**。

分支状态（同一次执行的真实输出）：

```
$ rtk proxy "git status"
On branch feat/l3-group-c-sweep
nothing to commit, working tree clean

$ rtk proxy "git log --oneline -3"
2713c20 docs(sdd): record the post-GATE-B clean-up — worktree and branch deleted after two checks
3570caf docs(sdd): record GATE-B's merge — the gate is bafa6a6 and that is group C's $B
bafa6a6 GATE-B PASSED: L3 debt 3 group B (B1-B2), two independent reviewers, 0 Critical
```

即 `$A4` 与 `$B` 都是本分支基点 `2713c20` 的祖先，顺序没有被违反。

---

## 2. 死代码 `shouldPreserveExistingSuccessfulReconciliation` 的零调用证明与删除

**删除之前**（`-F`，锚点按规矩不用行号推理，直接看命中行）：

```
$ rtk proxy "grep -rnF 'shouldPreserveExistingSuccessfulReconciliation' src/ tests/"
src/persistence/fileStore.ts:185:function shouldPreserveExistingSuccessfulReconciliation(
```

**唯一一处命中就是它自己的定义行，零调用点**（若有调用，`-rnF` 对同一个字面串必然也会命中调用处；本仓库特别提醒过裸符号名不唯一——这里反向也成立：`shouldPreserveExistingReconciliationRecord` 不含本串，故不会互相污染，而反过来本串是那个活谓词名字的**非子串**，两者不会混淆）。

**删除之后**（范围扩到 `docs/`，确认没有任何文档锚点指向它）：

```
$ rtk proxy "grep -rnF 'shouldPreserveExistingSuccessfulReconciliation' src/ tests/ docs/"
grep_exit=1
```

零行输出、`-F` 下 exit 1 = 零命中。

**只删了这一个函数**，同文件其它内容一个字节没动，`transferRepresentsPublishedWinner` 原样保留：

```
$ rtk proxy "git show --stat --oneline 2b7d3b1"
2b7d3b1 chore(fileStore): delete the dead shouldPreserveExistingSuccessfulReconciliation twin (GATE-A open item 5)
 src/persistence/fileStore.ts | 12 ------------
 1 file changed, 12 deletions(-)
```

12 行 = 该函数 11 行 + 其后的一个空行。删除后全套件零红（见 §8）。

**为什么单独一笔提交**：brief 的 Step 11 把 `git add` 清单与 commit message 都写死了，而控制器补充第 2 条追加的 `src/persistence/fileStore.ts` 不在那份清单里。为了让 Step 11 那条命令**逐字**成立、同时不让一条与 sweep 无关的清理混进 feature 提交，拆成了两笔。这是我自己的判断，**若评审希望合并成一笔，请指示，我不自行改写已裁定的 Step 11 文本。**

---

## 3. 【控制器补充第 3 条】具名确认：C1 会不会给 `persistBoundaryAnalysis` 添一条不走终态的路由？

**结论：不会。C1 没有新增任何通往 `persistBoundaryAnalysis` 的路由，GATE-A open 项 4 的裁决不重开。**

**这不是一句话断言，下面是沿调用链走的证据。**

### 3.1 `persistBoundaryAnalysis` 今天的全部生产调用点

```
$ rtk proxy "grep -rnF 'persistBoundaryAnalysis' src/ tests/"
src/runtime/types.ts:118:// Task A4 / §4.3: what `persistBoundaryAnalysis` can assemble BEFORE the epoch rule runs.
src/controller/runLoop.ts:724:async function persistBoundaryAnalysis(
src/controller/runLoop.ts:1217:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
src/controller/runLoop.ts:1266:        // What is NOT a route, because a previous fix wave claimed it was: persistBoundaryAnalysis's
src/controller/runLoop.ts:1271:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
src/controller/leaseHeartbeat.ts:120:  // persistBoundaryAnalysis), which rotates the epoch to this same process.
src/controller/leaseHeartbeat.ts:204:  // production call site (persistBoundaryAnalysis, runLoop.ts) is the read -> evaluate -> CAS
src/persistence/fileStore.ts:290:… (其余全部是注释或测试注释，逐条看过，无调用)
```

（完整未过滤输出见本节末尾的原始块。）**函数定义在 `runLoop.ts`（`async function persistBoundaryAnalysis`，**未导出**），生产调用点恰好两处，都在 `runLoopFromState` 内部：`runLoop.ts:1217`（execute 超时且无结果 → 紧接着 `persistTerminalState(… "exhausted" …)` 并 `return state`，终态）与 `runLoop.ts:1271`（execute 无结果 → 紧接着 `throw new Error("execute phase completed without a result")`，异常出到外层）。**这两处 C1 一个字节都没改。**

### 3.2 C1 的改动面里有没有新的入口

C1 的全部代码改动只有三个文件（第四个是 §2 的删除）：

```
$ rtk proxy "git show --stat --oneline 525cdcc"
525cdcc feat(sweep): add sweepRuns with lexicographic ordering and adoption-time quota accounting
 src/controller/resumeLoop.ts  |  10 ++
 src/sweep/sweepRuns.ts        | 124 +++++++++++++++
 tests/sweep/sweepRuns.test.ts | 346 ++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 480 insertions(+)
```

**`src/controller/runLoop.ts` 不在改动面内**（`git status --porcelain` 与两笔提交的 stat 都可证），所以那两个调用点及其后继语句（终态/抛出）**在结构上不可能被 C1 改变**。

`sweepRuns.ts` 自身完全不认识这个符号：

```
$ rtk proxy "grep -nF 'persistBoundaryAnalysis' src/sweep/sweepRuns.ts"
sweep_grep_exit=1
```

（零行、`-F`、exit 1 = 零命中。）

含该符号的生产文件只有四个，`src/sweep/` 不在其中：

```
$ rtk proxy "grep -rlF 'persistBoundaryAnalysis' src/"
src/runtime/types.ts
src/controller/runLoop.ts
src/controller/leaseHeartbeat.ts
src/persistence/fileStore.ts
```

### 3.3 C1 唯一一条能到达它的路径，是既有路径的**复用**，不是新增

`sweepRuns` 只调两样东西：`scanRuns`（`src/registry/`，只读观测，与 boundary 分析无关）与 `resume`（默认值就是既有的 `resumeLoop`）。`resumeLoop` 早在 A8 落地时就已经 `await runLoopFromState(...)`（`resumeLoop.ts`，函数 `resumeLoop` 的 try 块尾部），而 `persistBoundaryAnalysis` 在 `runLoopFromState` 内部。因此：

- **调用图上多出来的边**：`sweepRuns → resumeLoop`。**它止步于 `resumeLoop`**，`resumeLoop → runLoopFromState → persistBoundaryAnalysis` 这一段与 C1 之前逐字相同。
- C1 对 `resumeLoop` 的唯一改动是：`ResumeLoopOptions` 多一个可选键 `onAdopted?`，以及在 `appendEvent(resume_adopted)` 之后、`runLoopFromState` 调用之前**同步调用一次调用方给的回调**。这个回调是 sweep 自己的计数器（`adopted += 1`），**不进入 `runLoop.ts` 的任何函数**。
- 它甚至只能**减少**而不能增加到达次数：若 `onAdopted` 抛出，`runLoopFromState` 根本不会被进入。（sweep 传的那个闭包不抛。）
- **`sweepRuns` 一次 sweep 会多次调用 `resumeLoop`**——这让既有那条路由被**走更多次**，但**没有新增第二条路由**，也没有让任何一次到达绕开原有的后继终态/抛出结构。open 项 4 约束的是「有没有第二条**不走终态**的路由」，被约束的那个「界」（两处调用点各自后接终态或抛出）由 `runLoop.ts` 决定，而 `runLoop.ts` 未被触碰。

**因此：不重开。** 我没有发现「会」的情形；如果评审认为「同一条路由被无界地重复走」也应当算 open 项 4 的触发条件，那属于人裁范围，我把它写进 concerns（见 §10 concern 3），**没有自行决定。**

原始未过滤输出（上文引用的那条 `grep -rnF 'persistBoundaryAnalysis' src/ tests/` 的完整输出）：

```
src/runtime/types.ts:118:// Task A4 / §4.3: what `persistBoundaryAnalysis` can assemble BEFORE the epoch rule runs.
src/controller/runLoop.ts:724:async function persistBoundaryAnalysis(
src/controller/runLoop.ts:1217:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
src/controller/runLoop.ts:1266:        // What is NOT a route, because a previous fix wave claimed it was: persistBoundaryAnalysis's
src/controller/runLoop.ts:1271:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
src/controller/leaseHeartbeat.ts:120:  // process (runLoop's persistBoundaryAnalysis), which rotates the epoch to this same process.
src/controller/leaseHeartbeat.ts:204:  // production call site (persistBoundaryAnalysis, runLoop.ts) is the read -> evaluate -> CAS
src/persistence/fileStore.ts:290:// through persistBoundaryAnalysis, and reaches runLoopFromState's outer catch — where
src/persistence/fileStore.ts:471:      //      writeBoundaryArtifacts, through persistBoundaryAnalysis, into runLoopFromState's outer
src/persistence/fileStore.ts:522:        // removed) would propagate out of writeBoundaryArtifacts, through persistBoundaryAnalysis,
tests/controller/leaseHeartbeat.test.ts:356:  // persistBoundaryAnalysis's read -> evaluate -> CAS-transfer span, and that span publishes
tests/controller/leaseHeartbeat.test.ts:475:  // so an affirm being mid-CAS when persistBoundaryAnalysis reaches its span is precisely the
tests/controller/runLoop.integration.test.ts:1115:  // exactly one production call site, inside persistBoundaryAnalysis.
tests/controller/runLoop.integration.test.ts:1118:  // convenience: it is the route where persistBoundaryAnalysis is followed IMMEDIATELY by
tests/controller/runLoop.integration.test.ts:1164:        // answers `stale_candidate` and persistBoundaryAnalysis does NOT take its `healthy` early
tests/controller/runLoop.integration.test.ts:1196:    // persistBoundaryAnalysis.
tests/controller/runLoop.integration.test.ts:1219:    // value written before persistBoundaryAnalysis ran.
tests/controller/runLoop.integration.test.ts:1233:    // The write persistBoundaryAnalysis performs AFTER runExclusive returns never happened
tests/controller/runLoop.integration.test.ts:1434:  //      persistBoundaryAnalysis calls OUTSIDE any try, before writeBoundaryArtifacts — succeeds
tests/controller/runLoop.integration.test.ts:1657:            // the call at the tail of persistBoundaryAnalysis, immediately before the
tests/controller/runLoop.integration.test.ts:1701:      // The decisive premise: persistBoundaryAnalysis itself threw the injected error, rather
tests/controller/runLoop.integration.test.ts:1708:      // where its last real write left it: "executing", from before persistBoundaryAnalysis was
tests/controller/runLoop.integration.test.ts:1719:      // (src/controller/runLoop.ts, persistBoundaryAnalysis's tail), which sits AFTER the injected
tests/controller/runLoop.integration.test.ts:1805:  // calls persistBoundaryAnalysis internally — persistBoundaryAnalysis itself is not exported).
tests/controller/runLoop.integration.test.ts:1812:  // persistBoundaryAnalysis even starts — would straddle the transaction's OWN publish rename of
tests/controller/runLoop.integration.test.ts:1814:  // persistBoundaryAnalysis), which always changes the inode once, for a reason unrelated to what
tests/controller/runLoop.integration.test.ts:1923:  // The loser side must go through runLoopFromState because persistBoundaryAnalysis is not
tests/controller/runLoop.integration.test.ts:2387:      // Task 5, human ruling: persistBoundaryAnalysis's write guard is unconditional, so this
tests/controller/runLoop.integration.test.ts:2401:        // Task 5: the other controller's record is what persistBoundaryAnalysis's OWN write
tests/controller/runLoop.integration.test.ts:2519:      // Task 5, human ruling: persistBoundaryAnalysis's write guard is unconditional. Unlike
tests/controller/runLoop.integration.test.ts:2539:        // Task 5: same mechanism as the sibling test above — persistBoundaryAnalysis's own
tests/controller/leaseLifecycle.integration.test.ts:439:  // persistBoundaryAnalysis's stale_candidate branch), with one addition: a live-pid holder on
tests/controller/leaseLifecycle.integration.test.ts:452:    // hasBudgetExceeded fires first and diverts the run before persistBoundaryAnalysis is ever
tests/controller/leaseLifecycle.integration.test.ts:940:  // instance persistBoundaryAnalysis uses, and can call affirmNow() on it — simulating the
tests/controller/leaseLifecycle.integration.test.ts:975:    // Gates only the FIRST readOwnerRecord call — persistBoundaryAnalysis's own span read. The
tests/controller/leaseLifecycle.integration.test.ts:1068:      // SAME heartbeat instance persistBoundaryAnalysis is using.
tests/controller/leaseLifecycle.integration.test.ts:1582:  // Task 5 / spec §12 requirement 6: persistBoundaryAnalysis's entry guard must precede
tests/controller/leaseLifecycle.integration.test.ts:1589:  // guard sits between adapter.execute() returning and persistBoundaryAnalysis being called
tests/controller/leaseLifecycle.integration.test.ts:1591:  // first. That makes persistBoundaryAnalysis's own entry guard unambiguously the first (and
tests/controller/leaseLifecycle.integration.test.ts:1609:  // resolves, before any `stop()`, isolates persistBoundaryAnalysis's own guard from that
tests/controller/leaseLifecycle.integration.test.ts:1618:  // what this test targets: persistBoundaryAnalysis's OWN read, not the heartbeat's.
tests/controller/leaseLifecycle.integration.test.ts:1619:  it("refuses persistBoundaryAnalysis before readOwnerRecord can finalize a staged transfer, once superseded (spec requirement 6)", async () => {
tests/controller/leaseLifecycle.integration.test.ts:1664:        // process being superseded by a rival: discovered only when persistBoundaryAnalysis's
tests/controller/leaseLifecycle.integration.test.ts:1670:        return null; // resolves immediately: no timeout, so no guard runs between this and persistBoundaryAnalysis
tests/controller/leaseLifecycle.integration.test.ts:1708:  // persistBoundaryAnalysis's entry guard has passed, a process superseded WHILE the function
tests/controller/leaseLifecycle.integration.test.ts:1746:  // (persistBoundaryAnalysis with executionRecovery) that test exercises. The difference: here
tests/persistence/fileStore.test.ts:2069:  // TypeError leaves writeBoundaryArtifacts, passes persistBoundaryAnalysis, and lands in
```

---

## 4. 实现说明与设计决定

### 4.1 `ResumeLoopOptions`（先读了它今天的样子，控制器补充第 5 条）

动手前读过 `src/controller/resumeLoop.ts` 全文。它今天已经有两个键：A8 建的 `onReconciliationWriteAbandoned?`，B2 加的 `stopRequested?: StopRequestSignal`（并在 `runLoopFromState` 调用处转发）。**我把 `onAdopted?: () => void` 加在同一个类型上**，没有新建第二个 options 类型、没有塌成位置参数、没有动 B2 的转发。

触发点：`appendEvent({ type: "resume_adopted", … })` **之后**、`runLoopFromState` 调用**之前**，具体落在 `resume_adopted` 那次 `appendEvent` 的紧下一行（早于心跳启动）。选这里而不是 try 块内心跳之后的理由写进了代码注释：此时心跳还不存在，**回调若抛出没有任何已启动资源需要停**；放在心跳之后反而要靠 `finally` 兜。

### 4.2 `sweepRuns.ts`

流水线严格照 §6 的顺序：`scan` → `scanRootFailureDetail` 非 undefined 则 stderr + return 1 → 过滤（`kind === "run"` 且 `owner-transfer.json` 的 `eligibleForContinuation` 观测为 `{ kind: "present", value: true }`）→ **按 path 字典序排序** → **横幅到 stderr** → **此后才** `createAdapter()` → 顺序 for-await（配额检查与停机检查都在**开下一个 run 之前**）→ stdout 报告 → return 0。

- **截断在排序之后**：循环里 `if (adopted >= options.maxRuns) break;` 作用在已排序的 `candidates` 上，不在 filter 结果上。
- **配额在 `onAdopted` 计入**，不是 `resumeLoop` 返回时。
- **纯函数**：无 writer、不装信号处理器、不读任何 run 目录下的文件；只调 `scanRuns` 与 `resume`。**代码注释里明写了「一个字节都不写」按字面为假**（`resumeLoop` 会追加 `resume_requested` / `resume_denied` / 可能的 `lease_expired_observed`，CAS 拒绝路径还有文件系统副作用），没有在任何注释或测试名里宣称零写入。
- **措辞守住了 GATE-B 条件 2**：源文件与测试文件的注释都明写这个过滤器只保证「L2 观测到该字段为 literal true」，**不是**「这些 run 能续跑」，并点名 `reconciliation-record.json` 不在 L2 的 `OBSERVED_FILES` 里、八条判据里其余七条在 `resumeLoop` 内评估。
- **`createAdapter` 是闭包**，`sweepRuns` 在横幅之后才调用它；没有接收已构造的 adapter。
- 报告与横幅的**格式**留给 C3；本任务只让两个 sink 存在且被调用（横幅走 stderr，收尾报告走 stdout，`onReconciliationWriteAbandoned` 的通知也走 stderr）。
- **`src/registry/` 零改动**（见 §7 守卫）。

---

## 5. Steps 2–8 的原始输出（未过滤）

### Step 2 —— 加 `onAdopted?` 后的 typecheck

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm run typecheck"; echo "typecheck_exit=$?"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

### Steps 3–4 —— 测试 10 / 11 先红

具名（`describe > it` 全串）：

- `sweepRuns > resumes only the rows observed as eligible for continuation`
- `sweepRuns > continues to the next run after one is refused`

（按 Global Constraints 的 Amended (b)：代入 `-t` 的用裸 `it` 名，因为箭头形式在 vitest 2.1.9 下零匹配。）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t 'resumes only the rows observed as eligible for continuation'"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts [ tests/sweep/sweepRuns.test.ts ]
Error: Failed to load url ../../src/sweep/sweepRuns.js (resolved id: ../../src/sweep/sweepRuns.js) in /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep/tests/sweep/sweepRuns.test.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  no tests
   Start at  21:56:31
   Duration  271ms (transform 25ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 43ms)

EXIT=1
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t 'continues to the next run after one is refused'"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts [ tests/sweep/sweepRuns.test.ts ]
Error: Failed to load url ../../src/sweep/sweepRuns.js (resolved id: ../../src/sweep/sweepRuns.js) in /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep/tests/sweep/sweepRuns.test.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  no tests
   Start at  21:56:37
   Duration  246ms (transform 25ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 48ms)

EXIT=1
```

**披露一处判据形态**：这两次是**整个 suite 加载失败**（模块不存在），因此输出是 `Tests no tests`，不是 `1 failed | N skipped`。按 Amended (b) 的硬性判据，「全 skipped」不算红；这里不是 skipped，而是 `Failed Suites 1` + exit 1，是计划 Step 4 自己预言的形态（「`src/sweep/sweepRuns.ts` 尚不存在 → import 失败」）。真正带具名计数的红/绿在下面每一步与 §6 变异实验里都有。

### Step 5 —— 建 `sweepRuns.ts`（到「顺序续跑」为止）后，测试 10 / 11 转绿

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t 'resumes only the rows observed as eligible for continuation'"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (2 tests | 1 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 1 skipped (2)
   Start at  21:57:18
   Duration  504ms (transform 125ms, setup 0ms, collect 160ms, tests 2ms, environment 0ms, prepare 43ms)

EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t 'continues to the next run after one is refused'"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (2 tests | 1 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 1 skipped (2)
   Start at  21:57:25
   Duration  386ms (transform 106ms, setup 0ms, collect 139ms, tests 2ms, environment 0ms, prepare 45ms)

EXIT=0
```

两次都是 `Tests 1 passed | 1 skipped`，具名那条计数非零，不是「全 skipped 假绿」。

### Steps 6–7 —— 12b 三条子用例

具名：

- `sweepRuns > attempts only the first max-runs directories in lexicographic order`
- `sweepRuns > does not spend quota on a refused run`
- `sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it`

> **本节以下若干围栏的命令行写成 `$ … -t '<裸 it 名>'` 的缩写形式，`…` 是被省略的固定前缀。** 逐字展开为：
>
> ```
> export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t '<裸 it 名>'"; echo "EXIT=$?"
> ```
>
> 记在这里是为了让这些围栏也能被逐字节抽出来重跑（与 §6 的补跑同一动机）。今天若照此重跑，需按 §6 补跑那样把工作目录写死，因为本 agent 线程的 bash cwd 会在调用之间重置。
>
> **⚠️ 同族缺陷，主动补充披露（C1 修复轮 1 发现，控制器交办的两件事之外）：本节的**部分**围栏也被我节略过**，节略方式有三种：删掉开头的 `RUN v2.1.9 <root>` 行、删掉结尾的 `Duration …` 行、删掉红色围栏里 vitest 打印的源码上下文框（`282| … 286|`）与 `[1/1]` 分隔线。**这与 §8.1 是同一个错误**，不因为它发生在单跑围栏上就轻一等。
>
> **可补与不可补，分开说清楚：**
> - **实现之后的三道绿围栏**（`Start at 21:58:31 / 21:58:38 / 21:58:43`）钉的是与今天完全相同的代码状态，**它们的完整未节略版本已经存在于 §6 的 2026-08-04 补跑里**（同样三条测试、同一份代码、带 `RUN` 行与 `Duration` 行）。不重复再跑一遍。
> - **Step 8 的横幅顺序测试**（`Start at 21:59:12`）§6 没覆盖，**已于 2026-08-04 重跑并在该处贴出完整输出**。
> - **实现之前的红围栏**（`Start at 21:57:59 / 21:58:12 / 21:59:08`）钉的是一个**今天已不存在的中间状态**（配额与停机检查都已实现，这些测试今天是绿的）。**它们的完整输出无法重跑复原，也不许伪造**——如实记录：这几道围栏的判定信息（具名那条 `×` 行、`1 failed | N skipped` 计数、AssertionError 的期望/实得数组）逐字保留，被删掉的只有源码上下文框与分隔线。**读者据此可以核验判据是否达标，但无法逐字节比对完整输出。这是一个真实的证据强度损失，记在这里而不是掩盖它。**

**实现配额之前**：

```
$ … -t 'attempts only the first max-runs directories in lexicographic order'; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (5 tests | 1 failed | 4 skipped) 6ms
   × sweepRuns > attempts only the first max-runs directories in lexicographic order 6ms
     → expected [ '/fake/root/run-01', …(4) ] to deeply equal [ '/fake/root/run-01', …(1) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > attempts only the first max-runs directories in lexicographic order
AssertionError: expected [ '/fake/root/run-01', …(4) ] to deeply equal [ '/fake/root/run-01', …(1) ]

- Expected
+ Received

  Array [
    "/fake/root/run-01",
    "/fake/root/run-02",
+   "/fake/root/run-03",
+   "/fake/root/run-04",
+   "/fake/root/run-05",
  ]

 ❯ tests/sweep/sweepRuns.test.ts:216:27

 Test Files  1 failed (1)
      Tests  1 failed | 4 skipped (5)
   Start at  21:57:59
   Duration  366ms (transform 107ms, setup 0ms, collect 140ms, tests 6ms, environment 0ms, prepare 48ms)

EXIT=1
```

```
$ … -t 'does not spend quota on a refused run'; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (5 tests | 4 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
   Start at  21:58:07
   Duration  390ms (transform 104ms, setup 0ms, collect 135ms, tests 2ms, environment 0ms, prepare 40ms)

EXIT=0
```

**如实披露**：12b(b) 在「还没有任何配额逻辑」的中间态下就是**绿**的（没有配额 ⇒ 三个都跑 ⇒ 断言成立）。**它不是「配额存在与否」的判据**，它的判别力全部来自计划为它指定的那次变异（把配额改成「每次调用都计数」），见 §6 变异一——那里它确实红了。我没有为了让它先红而改动它。

```
$ … -t 'spends quota at onAdopted, not at return, so a later throw cannot refund it'; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (5 tests | 1 failed | 4 skipped) 5ms
   × sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it 5ms
     → expected 3 to be 1 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it
AssertionError: expected 3 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 3

 ❯ tests/sweep/sweepRuns.test.ts:284:30

 Test Files  1 failed (1)
      Tests  1 failed | 4 skipped (5)
   Start at  21:58:12
   Duration  387ms (transform 108ms, setup 0ms, collect 145ms, tests 5ms, environment 0ms, prepare 39ms)

EXIT=1
```

**实现配额（由 `onAdopted` 驱动）之后**，三条全绿：

```
$ … -t 'attempts only the first max-runs directories in lexicographic order'; echo "EXIT=$?"
 ✓ tests/sweep/sweepRuns.test.ts (5 tests | 4 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
   Start at  21:58:31
EXIT=0

$ … -t 'does not spend quota on a refused run'; echo "EXIT=$?"
 ✓ tests/sweep/sweepRuns.test.ts (5 tests | 4 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
   Start at  21:58:38
EXIT=0

$ … -t 'spends quota at onAdopted, not at return, so a later throw cannot refund it'; echo "EXIT=$?"
 ✓ tests/sweep/sweepRuns.test.ts (5 tests | 4 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
   Start at  21:58:43
EXIT=0
```

### Step 8 —— 测试 13（停机）

具名：`sweepRuns > starts no further run once the stop signal is set`

**实现停机检查之前（红）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (7 tests | 1 failed | 6 skipped) 6ms
   × sweepRuns > starts no further run once the stop signal is set 5ms
     → expected [ '/fake/root/run-1', …(2) ] to deeply equal [ '/fake/root/run-1' ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > starts no further run once the stop signal is set
AssertionError: expected [ '/fake/root/run-1', …(2) ] to deeply equal [ '/fake/root/run-1' ]

- Expected
+ Received

  Array [
    "/fake/root/run-1",
+   "/fake/root/run-2",
+   "/fake/root/run-3",
  ]

 ❯ tests/sweep/sweepRuns.test.ts:316:27

 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
   Start at  21:59:08
   Duration  382ms (transform 108ms, setup 0ms, collect 144ms, tests 6ms, environment 0ms, prepare 44ms)

EXIT=1
```

**实现之后，整文件全绿：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests) 3ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  21:59:39
   Duration  377ms (transform 123ms, setup 0ms, collect 137ms, tests 3ms, environment 0ms, prepare 53ms)

EXIT=0
```

### 计划四条之外我自己加的第七条测试（主动披露）

`sweepRuns > prints the banner before constructing the adapter`。

**为什么加**：brief 自己写了「**不要把已构造的 adapter 传进来**——那样横幅的位置约束不可测」。既然闭包形状存在的**唯一理由**就是让这条顺序可测，而计划的四条测试没有一条测它，一次未被测试守着的顺序约束正是后续编辑可以静默反转的东西。它断言 `createAdapter` 恰好被调用一次、且横幅是 `order[0]`、`createAdapter` 是 `order[1]`。**这超出了计划列的四条测试；若评审认为超范围，请指示删除，我不会自行改动计划文本。**

```
 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  21:59:12
EXIT=0
```

*（上面这道原始围栏被节略过：命令行是缩写形式，且删掉了 `RUN` 行与 `Duration` 行。下面是 2026-08-04 的补跑，命令与输出均为本次真实执行、一个字节没删。原始围栏与其时间戳原样保留。）*

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npx vitest run tests/sweep/sweepRuns.test.ts -t \"prints the banner before constructing the adapter\"; echo \"EXIT=\$?\"'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:25:40
   Duration  412ms (transform 122ms, setup 0ms, collect 156ms, tests 2ms, environment 0ms, prepare 50ms)

EXIT=0
```

---

## 6. Step 9 —— 三次变异实验，各走三步判据

**基线**：变异跑在真实 git 仓库工作副本（本 worktree，`git status` 干净、`npm ci` 已跑过）上，不是 scratchpad 副本。变异前的整套件见 §8 的第一次跑：`Test Files 1 failed | 29 passed (30)` / `Tests 1 failed | 496 passed (497)`，**唯一那条失败是允许名单里的 flake (B)**（`tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`，`Test timed out in 5000ms`），单跑复现为绿（同一节给出输出）。名单外零失败。

**还原证明用的标记**：三次注入都在注入行上带字面标记 `MUTATION-C1-M1` / `M2` / `M3`，还原后用 **命中该标记本身** 的命令证明干净（`grep -rnF 'MUTATION-C1' src/ tests/`，`-F`、前缀 `MUTATION-C1` 是三个标记的公共前缀，能真正命中我用过的每一个），并且**额外**用 `shasum -a 256` 把文件内容比回注入前的值。

注入前记录的基准哈希（此时 `sweepRuns.ts` 已含配额与停机检查，即最终形态）：

```
$ rtk proxy "shasum -a 256 src/sweep/sweepRuns.ts src/controller/resumeLoop.ts tests/sweep/sweepRuns.test.ts"
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
c8e314bcfdb97d8fe76ea7f5af4ef656ec35bf703e373e590cb3458ce5ef1676  src/controller/resumeLoop.ts
18946b8e783447705b18f0243861c18ddeaa1a15ad31eb8442b69c85a49d8294  tests/sweep/sweepRuns.test.ts
```

三次注入点**全部在生产代码**（`src/sweep/sweepRuns.ts`）上，没有改 fixture、没有往测试数组里注入。

> **⚠️ 产物完整性缺陷 —— C1 修复轮 1（2026-08-04）就地更正，原始围栏一个字不删。**
>
> **变异二与变异三的「注入前绿」围栏、以及三次「还原后绿」围栏，原本只贴了输出、没贴 `$ …` 命令行**（只有变异一的两道贴了）。这与 GATE-A open 项 6（「三个单跑围栏没记 `-t` 命令」）是同一族缺陷：**一道没有命令行的围栏，读者无法把它逐字节抽出来重跑**，只能相信作者贴的是他说的那条命令的输出。
>
> **处置：选「重跑」，不选「标注为重建」。** 下面每一道缺命令行的围栏后面，都补一个 **2026-08-04 的真实执行**（命令 + 输出都是本次跑出来的，不是照着记忆重建的命令模板）。原始围栏与其时间戳原样保留在上面。
>
> **「注入前绿」为什么今天重跑仍然有效：** 今天的工作树与当初注入前的工作树**逐字节相同** —— `src/sweep/sweepRuns.ts` 的 `shasum -a 256` 在每次还原后与今天都仍是 `409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0`，且两笔提交之后 `git status --porcelain` 为空。所以今天跑「注入前」那条命令，考的是同一份代码的同一个状态。**它不能替代当初那次执行，只能证明那条命令确实是这么写、确实产出这样的绿。**
>
> 三道补跑的命令都把工作目录写死（`bash -c 'cd <worktree> && …'`），因为本 agent 线程的 bash cwd 在调用之间会被重置，**曾经因此把一次全套件跑到了主仓库**（详见 §8.1b 的事故披露）。每一道补跑的输出第一行 `RUN v2.1.9 …/worktrees/l3-group-c-sweep` 就是它跑对了目录的自证。所有补跑都用**裸 `it` 名**，且每一块都显示具名测试的**非零计数**（`Tests 1 passed | 6 skipped (7)`），不是「全 skipped 假绿」。

### 变异一：配额改成「每次调用都计数」→ 12b(b) 必红

具名：`sweepRuns > does not spend quota on a refused run`
注入内容：循环里加 `adopted += 1; // MUTATION-C1-M1`（在 `resume` 之前），并把 `onAdopted` 的 `adopted += 1;` 改成空体。

**(1) 注入前（绿）：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t 'does not spend quota on a refused run'"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:01:07
   Duration  373ms (transform 111ms, setup 0ms, collect 148ms, tests 2ms, environment 0ms, prepare 37ms)

EXIT=0
```

**(2) 注入后（红）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (7 tests | 1 failed | 6 skipped) 6ms
   × sweepRuns > does not spend quota on a refused run 6ms
     → expected [] to deeply equal [ '/fake/root/run-3' ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > does not spend quota on a refused run
AssertionError: expected [] to deeply equal [ '/fake/root/run-3' ]

- Expected
+ Received

- Array [
-   "/fake/root/run-3",
- ]
+ Array []

 ❯ tests/sweep/sweepRuns.test.ts:253:23

 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
   Start at  22:01:20
   Duration  517ms (transform 135ms, setup 0ms, collect 182ms, tests 6ms, environment 0ms, prepare 94ms)

EXIT=1
```

`1 failed | 6 skipped`，具名那条计数非零，是真红不是过滤器零匹配。

**(3) 还原后（绿）+ 还原证明：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/sweep/sweepRuns.test.ts -t 'does not spend quota on a refused run'"; echo "EXIT=$?"; rtk proxy "grep -rnF 'MUTATION-C1' src/ tests/"; echo "marker_grep_exit=$?"; rtk proxy "shasum -a 256 src/sweep/sweepRuns.ts"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:01:34
   Duration  400ms (transform 111ms, setup 0ms, collect 148ms, tests 2ms, environment 0ms, prepare 46ms)

EXIT=0
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

标记零命中，哈希与注入前逐字节相同。

*（这一道原始围栏**本来就带命令行**，不属于本轮要补的缺陷。为与另外两道还原围栏保持同一形式，一并附上 2026-08-04 的补跑，命令与输出均为本次真实执行。）*

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npx vitest run tests/sweep/sweepRuns.test.ts -t \"does not spend quota on a refused run\"; echo \"EXIT=\$?\"; grep -rnF \"MUTATION-C1\" src/ tests/; echo \"marker_grep_exit=\$?\"; shasum -a 256 src/sweep/sweepRuns.ts'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:20:38
   Duration  352ms (transform 99ms, setup 0ms, collect 128ms, tests 2ms, environment 0ms, prepare 42ms)

EXIT=0
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

### 变异二：计数点退回「`resume` 正常返回时 +1」→ 12b(c) 必红

具名：`sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it`
注入内容：`onAdopted` 改成空体（`// MUTATION-C1-M2`），try 块内 `await resume(...)` 之后加 `adopted += 1; // MUTATION-C1-M2`。

**(1) 注入前（绿）：**

```
 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:01:46
   Duration  385ms (transform 116ms, setup 0ms, collect 152ms, tests 2ms, environment 0ms, prepare 42ms)
EXIT=0
```

*（上面这道原始围栏未记录命令行。下面是 2026-08-04 的补跑，命令与输出均为本次真实执行。）*

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npx vitest run tests/sweep/sweepRuns.test.ts -t \"spends quota at onAdopted, not at return, so a later throw cannot refund it\"; echo \"EXIT=\$?\"'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:20:30
   Duration  421ms (transform 112ms, setup 0ms, collect 151ms, tests 2ms, environment 0ms, prepare 42ms)

EXIT=0
```

**(2) 注入后（红）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (7 tests | 1 failed | 6 skipped) 8ms
   × sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it 7ms
     → expected 3 to be 1 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > spends quota at onAdopted, not at return, so a later throw cannot refund it
AssertionError: expected 3 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 3

 ❯ tests/sweep/sweepRuns.test.ts:284:30

 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
   Start at  22:02:04
   Duration  520ms (transform 184ms, setup 0ms, collect 264ms, tests 8ms, environment 0ms, prepare 42ms)

EXIT=1
```

**(3) 还原后（绿）+ 还原证明：**

```
 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:02:26
   Duration  407ms (transform 120ms, setup 0ms, collect 155ms, tests 2ms, environment 0ms, prepare 48ms)
EXIT=0
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

*（上面这道原始围栏未记录命令行。下面是 2026-08-04 的补跑，命令与输出均为本次真实执行。`marker_grep_exit=1` = `-F` 下零命中，即标记 `MUTATION-C1-M2` 早已不在树上。）*

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npx vitest run tests/sweep/sweepRuns.test.ts -t \"spends quota at onAdopted, not at return, so a later throw cannot refund it\"; echo \"EXIT=\$?\"; grep -rnF \"MUTATION-C1\" src/ tests/; echo \"marker_grep_exit=\$?\"; shasum -a 256 src/sweep/sweepRuns.ts'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:20:39
   Duration  414ms (transform 104ms, setup 0ms, collect 137ms, tests 2ms, environment 0ms, prepare 42ms)

EXIT=0
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

### 变异三：去掉排序（保留过滤与截断）→ 12b(a) 必红

具名：`sweepRuns > attempts only the first max-runs directories in lexicographic order`
注入内容：`const candidates = rows.filter(isObservedEligible); // MUTATION-C1-M3`（`.sort(...)` 删掉）。

**(1) 注入前（绿）：**

```
 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:02:33
   Duration  391ms (transform 119ms, setup 0ms, collect 155ms, tests 2ms, environment 0ms, prepare 62ms)
EXIT=0
```

*（上面这道原始围栏未记录命令行。下面是 2026-08-04 的补跑，命令与输出均为本次真实执行。）*

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npx vitest run tests/sweep/sweepRuns.test.ts -t \"attempts only the first max-runs directories in lexicographic order\"; echo \"EXIT=\$?\"'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:20:31
   Duration  382ms (transform 112ms, setup 0ms, collect 142ms, tests 2ms, environment 0ms, prepare 49ms)

EXIT=0
```

**(2) 注入后（红）：**

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ❯ tests/sweep/sweepRuns.test.ts (7 tests | 1 failed | 6 skipped) 6ms
   × sweepRuns > attempts only the first max-runs directories in lexicographic order 6ms
     → expected [ '/fake/root/run-04', …(1) ] to deeply equal [ '/fake/root/run-01', …(1) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/sweep/sweepRuns.test.ts > sweepRuns > attempts only the first max-runs directories in lexicographic order
AssertionError: expected [ '/fake/root/run-04', …(1) ] to deeply equal [ '/fake/root/run-01', …(1) ]

- Expected
+ Received

  Array [
+   "/fake/root/run-04",
    "/fake/root/run-01",
-   "/fake/root/run-02",
  ]

 ❯ tests/sweep/sweepRuns.test.ts:216:27

 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
   Start at  22:02:45
   Duration  419ms (transform 119ms, setup 0ms, collect 183ms, tests 6ms, environment 0ms, prepare 43ms)

EXIT=1
```

（fixture 故意把 scan 返回的行序打乱成 `run-04, run-01, run-05, run-03, run-02`，并在测试里**断言**这个顺序确实不是排序后的顺序——否则「去掉排序」根本不会改变答案，这条变异就杀不动。）

**(3) 还原后（绿）+ 还原证明：**

```
 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms
 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:02:58
   Duration  412ms (transform 132ms, setup 0ms, collect 174ms, tests 2ms, environment 0ms, prepare 45ms)
EXIT=0
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

*（上面这道原始围栏未记录命令行。下面是 2026-08-04 的补跑，命令与输出均为本次真实执行。`marker_grep_exit=1` = `-F` 下零命中，即标记 `MUTATION-C1-M3` 早已不在树上。）*

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npx vitest run tests/sweep/sweepRuns.test.ts -t \"attempts only the first max-runs directories in lexicographic order\"; echo \"EXIT=\$?\"; grep -rnF \"MUTATION-C1\" src/ tests/; echo \"marker_grep_exit=\$?\"; shasum -a 256 src/sweep/sweepRuns.ts'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests | 6 skipped) 2ms

 Test Files  1 passed (1)
      Tests  1 passed | 6 skipped (7)
   Start at  22:20:45
   Duration  422ms (transform 122ms, setup 0ms, collect 160ms, tests 2ms, environment 0ms, prepare 45ms)

EXIT=0
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

---

## 7. 守卫值（每个数字旁附重推命令与本次执行的真实输出）

```
$ rtk proxy "grep -cF 'return { ok: false' src/controller/resumeLoop.ts"
8
```

→ **仍是 8**，`evaluateResumeEligibility` 的八条判据一个字节未改。

```
$ rtk proxy "grep -rnF 'currentOwnerEpoch + 1' src/"
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
```

→ **仍单点命中**。

```
$ rtk proxy "git status --porcelain"
 M src/controller/resumeLoop.ts
 M src/persistence/fileStore.ts
?? src/sweep/
?? tests/sweep/
```

（这是提交前的状态。）→ **`src/registry/` 零改动**：改动面只有 `src/controller/resumeLoop.ts`、`src/persistence/fileStore.ts`、新增的 `src/sweep/`、`tests/sweep/`。两笔提交的 stat（§3.2、§2）复核了同一结论。

另：**`src/controller/runLoop.ts` 未改**，因此 B1 在外层 catch 加的分支及其与 `isLeaseStopError` 分支的先后顺序、B2 装在循环顶端的停机槽、`options?.onReconciliationWriteAbandoned` 的两处转发、`stop()` 与 `isLeaseStopError` 的谓词签名，**全部一个字节未动**。`resumeLoop.ts` 里我只加了一个可选键与一行 `options?.onAdopted?.();`，B2 的 `stopRequested` 转发原样保留。

---

## 8. Step 10 —— 全套件 / typecheck / build（未过滤）

### 8.1 变异实验前的基线全套件（含允许 flake 一条）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"; echo "EXIT=$?"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests) 4ms
 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 496ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 10ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 171ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 6ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 46ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 5ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 44ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 2771ms
 ✓ tests/ownership/lease.test.ts (16 tests) 5ms
 ✓ tests/cli/cli.test.ts (15 tests) 568ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 3295ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 6ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 21ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 3ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3920ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 3ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 358ms
 ✓ tests/validation/contracts.test.ts (19 tests) 3539ms
 ✓ tests/validation/fixture.test.ts (2 tests) 633ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 8358ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 10545ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 12789ms
 ❯ tests/validation/evidence.test.ts (39 tests | 1 failed) 19698ms
   × run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 5005ms
     → Test timed out in 5000ms.

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid
Error: Test timed out in 5000ms.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 29 passed (30)
      Tests  1 failed | 496 passed (497)
   Start at  22:00:20
   Duration  20.37s (transform 2.34s, setup 0ms, collect 4.07s, tests 67.32s, environment 4ms, prepare 2.07s)

EXIT=1
```

> **⚠️ 产物完整性缺陷 —— C1 修复轮 1（2026-08-04）就地更正，上面那道围栏一个字不删、原样保留。**
>
> 上面这道围栏**被我手工节略过**：我删掉了 vitest 打到 stderr/stdout 的 `cli.test.ts` 调试块与部分逐条 slow-test 行，并在这里写了一句「为节约篇幅省去」。
>
> **这是违规，理由不是格式洁癖：** 本仓库的铁律是「验证跑绝不过滤输出」，而**手工删行与 `| grep` / `| tail` 同罪**——两者产生的是同一样东西，即一份**评审员无法核验、只能采信作者自述**的围栏。组 A 有一轮正是因为「为了宽度省掉 60 行清单」被记为违规。节略的**命令**没被过滤，不代表节略的**产物**可以被过滤：证据的价值全在「读者能不能自己比对每一行」。
>
> **补救：** 本节末尾 §8.1b 是 2026-08-04 的**重跑**，一个字节没删。**它是重跑，不是把新输出回填到上面那次执行里** —— 上面那次的时间戳（`Start at 22:00:20`）与结果（含允许 flake 一条）原样保留，§8.1b 自带它自己的时间戳。

那条失败**就是允许名单里的 flake (B)**，单跑复现为绿：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npx vitest run tests/validation/evidence.test.ts -t 'records env names only and tracks descendants rooted at the spawned pid'"; echo "EXIT=$?"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/validation/evidence.test.ts (39 tests | 38 skipped) 2442ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2441ms

 Test Files  1 passed (1)
      Tests  1 passed | 38 skipped (39)
   Start at  22:00:52
   Duration  2.83s (transform 106ms, setup 0ms, collect 138ms, tests 2.44s, environment 0ms, prepare 43ms)

EXIT=0
```

**名单外零失败。没有用重跑掩盖任何东西。**

### 8.1b 2026-08-04 重跑：§8.1 那道围栏的未节略版本（C1 修复轮 1）

**这是一次新的执行，不是对 §8.1 那次执行的回填。** 它跑在与 §8.1 同一份代码上（两笔提交 `525cdcc` + `2b7d3b1` 之后的工作树，`git status --porcelain` 空，`src/sweep/sweepRuns.ts` 的 `shasum -a 256` 仍是 `409ef773…`），因此覆盖同样的验证面；**但时间戳、耗时、以及那条 flake 是否复现，都以本次为准，与 §8.1 那次各自独立。** 本次那条允许 flake **没有复现**（全绿），这正是它被列进 flake 名单的原因，不是 §8.1 那次的失败被「跑掉了」——那一次的失败原样留在上面。

**先说一件必须披露的事故：本轮第一次重跑跑错了目录。** 我发出的是 `rtk proxy "npm test -- --run"`（未固定 cwd），它落在了**主仓库** `/Users/biran/code/skills/loop/ccloop`，输出的是 `RUN v2.1.9 /Users/biran/code/skills/loop/ccloop` / `Test Files 29 passed (29)` / `Tests 490 passed (490)` —— **那是 main 的数字，不含本任务的 `tests/sweep/sweepRuns.test.ts`，不能当作本任务的证据。** 原因：本 agent 线程的 bash cwd 在两次调用之间会被重置，早先各次恰好落在 worktree（每一道围栏的 `RUN v2.1.9 …/worktrees/l3-group-c-sweep` 行可自证），本次没有。

**处置**：下面这次把目录写死在命令里，并且**验收标准就是输出第一行的 `RUN` 路径**。顺带一个交叉校验：main = 29 文件 / 490 用例，本分支 = 30 文件 / 497 用例，**差额恰好是本任务新增的 1 个文件 / 7 条用例**，与 §8.2 的数字互相印证。主仓库工作树未被这次误跑弄脏（`git status --porcelain` 只有一行 ` M .superpowers/sdd/…/progress.md`，是控制器自己的 ledger 改动，本任务全程只读过它）。

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && export ECC_GATEGUARD=off DISABLE_OMC=1 && npm test -- --run; echo \"EXIT=\$?\"'"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests) 4ms
 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 443ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 15ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 180ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 5ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 28ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 6ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 7ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 62ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-SwErtw/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-6DSkfp/run-1  observed 2026-08-04T14:19:57.787Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 423ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 2748ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 2308ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 5ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 3158ms
   ✓ resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState 395ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 363ms
   ✓ resumeLoop > does not refuse a resume immediately after an owner transfer (lastAffirmedAt is not the lease field) 370ms
   ✓ resumeLoop > lets an eligible resume through an expired lease and records the observation 310ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 382ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 20ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3658ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 340ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 415ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 430ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 441ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 528ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 408ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 347ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 606ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2856ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 757ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 662ms
   ✓ render-contract CLI > rejects a non-git repository path 701ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 725ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 348ms
   ✓ worktreeManager > creates and removes a detached worktree 347ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 686ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 684ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 7565ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 421ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 313ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 306ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 394ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 397ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 392ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 414ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 428ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 384ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 7679ms
   ✓ lease heartbeat lifecycle > releases the lease after a resume completes 300ms
   ✓ lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 376ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 652ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 584ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 694ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 555ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 363ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 386ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 390ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 359ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 12004ms
   ✓ runLoop > does not succeed when verifierType is command and a required check fails 333ms
   ✓ runLoop > skips adapter.verify when agent verification requiredChecks fail 301ms
   ✓ runLoop > does not succeed when approved verification is missing required evidence 358ms
   ✓ runLoop > blocks for human input when approval also hits a pauseOn gate 319ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 484ms
   ✓ runLoop > stops immediately when a stopOn signal matches 390ms
   ✓ runLoop > publishes reconciliation-record.json inside the transfer transaction even when assertHeld throws afterwards 322ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 616ms
 ✓ tests/validation/evidence.test.ts (39 tests) 16859ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1650ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1373ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2721ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1676ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1587ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1547ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 586ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 608ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 601ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 983ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 710ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2588ms

 Test Files  30 passed (30)
      Tests  497 passed (497)
   Start at  22:19:54
   Duration  17.60s (transform 2.37s, setup 0ms, collect 4.37s, tests 58.79s, environment 4ms, prepare 1.78s)

EXIT=0
```

**30 文件 / 497 用例 / 全绿 / exit 0，输出未删一字节。**

### 8.2 收尾的全套件（完整、未过滤、全绿）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm test -- --run"; echo "EXIT=$?"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep

 ✓ tests/sweep/sweepRuns.test.ts (7 tests) 4ms
 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (22 tests) 437ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 146ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 5ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 26ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 28ms
 ✓ tests/persistence/fileStore.test.ts (76 tests) 1921ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1524ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-VPG1GG/does-not-exist'

stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-eCqRM3/run-1  observed 2026-08-04T14:03:32.706Z
  loop-state.json
    status: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    currentAttempt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    attemptsUsed: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    lastTransitionAt: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
    stopReason: unreadable(parse): Expected property name or '}' in JSON at position 1 (line 1 column 2)
  owner-record.json
    runId: absent
    currentOwnerEpoch: absent
    ownerStatus: absent
    currentProcessInstanceId: absent
    leaseAffirmedAt: absent
  owner-transfer.json
    eligibleForContinuation: absent

 ✓ tests/cli/cli.test.ts (15 tests) 424ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 18ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 2697ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 321ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 375ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 3ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3184ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 332ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 328ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 309ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 391ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 393ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 403ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 309ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 609ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 262ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2663ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 738ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 559ms
   ✓ render-contract CLI > rejects a non-git repository path 742ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 613ms
 ✓ tests/validation/fixture.test.ts (2 tests) 509ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 507ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (27 tests) 7079ms
   ✓ lease heartbeat lifecycle > stays eligible immediately after a stop_requested run releases its lease 310ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 571ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 609ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 723ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 415ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 360ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 386ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 384ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 353ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9802ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 3179ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 484ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 363ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 386ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 381ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 376ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 396ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 422ms
 ✓ tests/controller/runLoop.integration.test.ts (55 tests) 11302ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 397ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 372ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 596ms
 ✓ tests/validation/evidence.test.ts (39 tests) 16439ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1447ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1319ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2542ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1549ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1539ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1568ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 630ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 696ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 600ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 981ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 657ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2699ms

 Test Files  30 passed (30)
      Tests  497 passed (497)
   Start at  22:03:29
   Duration  17.11s (transform 2.24s, setup 0ms, collect 3.63s, tests 56.99s, environment 4ms, prepare 1.83s)

EXIT=0
```

**30 文件 / 497 用例 / 全绿 / exit 0。**（计划基线是 29 文件 446 用例；差额 = 本任务新增的 `tests/sweep/sweepRuns.test.ts` 一个文件 7 条，其余 44 条是组 A/B 落地后本仓库已有的增长——**我用的是我自己这次执行的输出，不是计划里的 446。**）

### typecheck / build

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm run typecheck"; echo "typecheck_exit=$?"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1; rtk proxy "npm run build"; echo "build_exit=$?"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

---

## 9. 行号引用扫描

本任务改了 `src/controller/resumeLoop.ts`（+10 行，全部在文件中部）与 `src/persistence/fileStore.ts`（−12 行，在 185 行附近）。按「所有编辑落地之后，全仓扫一遍指向被改文件的行号引用」的要求，我扫了指向这两个文件的行号锚点：

- `src/registry/observeFields.ts` 的注释里有 `fileStore.ts:77 and :82`（两个 `loop-state.json` 写点）。我删的是 185 行起的函数，**在 77/82 之后**，因此这两个行号不受影响（删除只会让 185 行之后的内容上移）。**这一条不止是推理，删除之后实测了那两行的内容**（读 `src/persistence/fileStore.ts` 第 74–85 行，本次执行的真实内容）：

  ```
  77	  await writeJsonFileAtomically(join(runDir, "loop-state.json"), initialState);   ← initializeRunFiles 内
  81	export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  82	  await writeJsonFileAtomically(join(runDir, "loop-state.json"), state);
  ```

  两个锚点今天仍分别落在 `initializeRunFiles` / `writeRunState` 的 `loop-state.json` 写点上，未失效。
- `src/registry/observeFields.ts` 还有 `src/state/types.ts:26-35`、`src/runtime/types.ts:82-104`、`lease.ts:7-8`、`readObservedFile.ts:118`——都不是本任务改过的文件。
- 本任务**新写**的注释里没有使用任何行号锚点（一律「文件名 + 符号名」）。

---

## 10. Concerns（含我认为该由人裁、没有自作主张的东西）

1. **【范围】我加了计划四条测试之外的第七条**（`sweepRuns > prints the banner before constructing the adapter`）。理由见 §5 末尾：闭包形状存在的唯一理由就是让这条顺序可测。**若判超范围，请指示删除**——我没有改任何计划文本或既有测试名。
2. **【范围】死代码删除单独成一笔提交**（`2b7d3b1`），以保住 Step 11 那条被写死的 `git add` + message 逐字成立。若人裁希望并成一笔，请指示。
3. **【可能需要人裁】open 项 4 的边界解释。** 我按「有没有**新增第二条路由**」来判，结论是不重开（§3）。但 C1 确实让**同一条既有路由被一次进程内重复走 N 次**（sweep 顺序续跑）。如果人裁认为 open 项 4 的「界」也包含「到达次数有界」，那我的结论就不成立。**我没有替人裁做这个扩张解释**，只把事实摆出来。
4. **【已闭合，保留记录】** §9 的行号锚点检查最初只有「删除点在 185、位于 77/82 之后 ⇒ 不移动」的推理；随后**实测了那两行的内容**（见 §9 的代码块），结论升级为实测。此项不再是 concern，保留是为了让评审看到这次升级发生过。
5. **【本层已知代价，按计划具名传下去】** 选了「保留字典序、不做退避」：一次 sweep 扫到 M 个永久被拒的 run，会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**，`events.jsonl` 会单调增长。不影响付费界。**具名传给 L5（§13 第 5 笔）**，本层不处理。
6. **【本层已知代价】** `sweepRuns` 在进程内直接调 `scanRuns`、不 fork `ccloop ls --json`，因此耦合到 `ScanRow` 类型而非 L2 §6.3 的版本化 JSON 形状；**L2 §14.1 的字面要求是后者**。这是计划自己定的取舍，我照做并在此记下。
7. **【我自己不确定的地方，写下来而不是赌】**
   - `onAdopted` 我放在心跳启动**之前**（`resume_adopted` 追加的紧下一行）。brief 只要求「在 `resume_adopted` 之后、`runLoopFromState` 之前」，这个区间里还有心跳启动与 `cleanupResidualWorktrees`。我选最靠前的位置，理由是回调抛出时没有已启动资源需要停。**若评审认为应当放在心跳之后（让 `finally` 兜住回调异常），这是一个真实的可辩点。**
   - `sweepRuns` 传给 `resume` 的 `onReconciliationWriteAbandoned` 目前只往 stderr 写一行通知。**计划的流水线明写要传它，但没规定它做什么**；C3 会重做报告格式，届时可能改写这行。
   - 报告行 `sweep: X adopted, Y not started, of Z eligible` 里的 `Y` 只统计**抛出的**那些；因停机或配额而**根本没开**的 run 既不计入 X 也不计入 Y。**格式与口径归 C3**，本层只保证 sink 被调用。
   - `maxRuns` 为 0 或负数时循环一次都不进（`adopted >= maxRuns` 立即成立）。**参数校验归调用方 C2**，本层不校验，也没有为此写测试。
8. **【修复轮 1 新增】我自己在这一轮制造过一个同类错误并当场改掉**：给 §6 补的「变异三还原后」那道补跑围栏，我第一次粘贴时把 `marker_grep_exit=1` 与 `shasum` 两行**漏掉了**——在一轮专门修「围栏被节略」的修复里又节略了一道围栏。已补全。记在这里而不是悄悄改掉，因为本仓库十四波修复各自带缺陷的模式，正是靠这种自曝才可能被打破。
9. **【修复轮 1 新增，需要你知道】本 agent 线程的 bash 工作目录在两次调用之间会被重置**，本轮因此把一次全套件跑进了主仓库（详见 §8.1b）。**任务期内所有落地证据都自带 `RUN v2.1.9 …/worktrees/l3-group-c-sweep` 行**，可逐道核验；但这是一个会静默出错的环境陷阱，**建议加进组 C 后续任务的环境陷阱清单**（brief 第 7 节现有五条，这是第六条）。是否加由你裁，我没有动 brief。
10. **【修复轮 1 新增】§5 那三道「实现之前」的红围栏无法重跑复原**（所钉的中间状态今天已不存在），被删掉的是 vitest 的源码上下文框与分隔线，判定信息（`×` 行、`1 failed | N skipped` 计数、AssertionError 期望/实得）逐字仍在。**这是一处不可弥补的证据强度损失**，已在 §5 就地记明，不伪造补全。

---

## 11. 修复轮 1 收尾：工作树干净、标记零残留

本轮只改了 `task-C1-report.md`（它在 `.superpowers/sdd/` 下，未被跟踪），**没有动任何 `.ts` 文件、没有新提交**。收尾证明（命令与输出均为 2026-08-04 本次真实执行）：

```
$ rtk proxy "bash -c 'cd /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep && pwd && git status --porcelain && echo WORKTREE_PORCELAIN_ABOVE && git log --oneline -2 && grep -rnF \"MUTATION-C1\" src/ tests/; echo \"marker_grep_exit=\$?\" && shasum -a 256 src/sweep/sweepRuns.ts'"
/Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-group-c-sweep
WORKTREE_PORCELAIN_ABOVE
2b7d3b1 chore(fileStore): delete the dead shouldPreserveExistingSuccessfulReconciliation twin (GATE-A open item 5)
525cdcc feat(sweep): add sweepRuns with lexicographic ordering and adoption-time quota accounting
marker_grep_exit=1
409ef773dce52594e38f38f996acf20f0ec70044165152fd647f4867481b79b0  src/sweep/sweepRuns.ts
```

- `pwd` 与 `WORKTREE_PORCELAIN_ABOVE` **之间没有任何行** ⇒ `git status --porcelain` 输出为空 ⇒ 工作树干净。
- 两笔提交与修复轮前逐字相同（`2b7d3b1` / `525cdcc`），本轮无新提交。
- `marker_grep_exit=1`（`-F` 下零命中）⇒ 我实际用过的三个标记 `MUTATION-C1-M1/M2/M3` 零残留。
- `shasum` 仍是 `409ef773…`，与三次变异注入前的基准值逐字节相同。

主仓库侧：本轮那次误跑没有弄脏主仓库工作树，`git status --porcelain` 只有一行 ` M .superpowers/sdd/…/progress.md`，是控制器自己的 ledger 改动（本任务全程只读过 `progress.md`，从未写入）。
