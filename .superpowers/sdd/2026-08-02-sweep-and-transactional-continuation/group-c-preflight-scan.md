# 组 C 开工前计划冲突扫描 (pre-flight scan)

日期：2026-08-04。执行者：只读扫描，未改动任何源码 / 测试 / 计划文件。
范围：计划 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md`
的 `## Global Constraints`(15–159) 与 `# 组 C`(1402) → `### GATE-C`(1811)，以及
`## 四条未结清风险`(1845) / `## 我不确定的地方`(1933)。
进度真理源：`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`
第 387 行（`*** GATE-A: PASSED ***`）到文件末尾（1145 行）。

命令一律经 `rtk proxy "<单条命令>"`，输出未过滤、未接管道裁剪。

---

## A. 需要人裁的条目（7 条）

### A-1. GATE-A open 项 5（删除死代码）被分诊给组 C，但组 C 的计划文本里没有任何落点

**冲突**：ledger 把一次生产代码删除派给了组 C，而组 C 四个任务的 Files 清单里没有
一个包含 `src/persistence/fileStore.ts`，组 C 全文（1402–1817）也从未提到这个函数。

**ledger 原话**（progress.md:514–517，GATE-A「WHAT IS STILL OPEN」第 5 条）：

> 5. shouldPreserveExistingSuccessfulReconciliation is DEAD CODE. It agrees with
>    the live shouldPreserveExistingReconciliationRecord only through an unreduced
>    (A || A); anyone who simplifies that disjunction desynchronises a live
>    predicate from a same-named dead twin. Triaged to group C as a deletion.

**另一边（计划文本）**：
- C1 Files（1408–1411）：`src/sweep/sweepRuns.ts` / `src/controller/resumeLoop.ts` / `tests/sweep/sweepRuns.test.ts`
- C2 Files（1528–1530）：`src/cli.ts` / `tests/cli/cli.test.ts`
- C3 Files（1618–1620）：`src/sweep/sweepRuns.ts` / `tests/sweep/sweepRuns.test.ts`
- C4 Files（1738–1739）：**Test only**：`tests/registry/zeroWrite.test.ts`
- GATE-C Step 1 的评审重点（1813）也不含它。

**代码的真实情况（今天仍在，且确实是死代码）**：

```
$ rtk proxy "grep -rnF 'shouldPreserveExistingSuccessfulReconciliation' src/ tests/"
src/persistence/fileStore.ts:185:function shouldPreserveExistingSuccessfulReconciliation(
```

只有定义行，零调用点。`(A || A)` 也复现了：`src/persistence/fileStore.ts:197–208`
的活谓词第三个合取项是
`isLoserDowngradeAttempt(next, transfer) || shouldSynthesizeSuccessfulReconciliation(undefined, next, transfer)`，
而 `shouldSynthesizeSuccessfulReconciliation` 的第一个合取项是
`persistedReconciliationRecord === undefined`（:180），传 `undefined` 时恒真，于是第二个
析取支化简回 `isLoserDowngradeAttempt(next, transfer)`——与第一个析取支逐字相同。

**影响**：组 C 无任务承接。要么给某个任务（最合理是 C1 或 GATE-C 修复波）加一条
Files 条目与一个步骤，要么把它改判给 L5。**删除范围是清楚的**：`fileStore.ts:185–195`
整个函数，无调用点、无导出、无测试引用；但 Global Constraints「S-3 安全阀」与
Rule 3（只碰必须碰的）都会让一个只看 C1 brief 的实施者拒绝去动 `fileStore.ts`。

---

### A-2. GATE-A open 项 4 要求组 C 自己做一次确认，但组 C 没有任何一步要求做它

**冲突**：ledger 三处强制要求组 C 做**自己的**确认、不许继承 B1/B2 的，而计划的
C1–C4 Steps 与 GATE-C Step 1 的评审重点里，没有一步提到 `persistBoundaryAnalysis`
或「第二条非终态路由」。

**ledger 原话**（progress.md:511–513，需逐字带进组 C 的 brief）：

> 4. IF GROUP B OR C ADDS A SECOND, NON-TERMINAL ROUTE TO persistBoundaryAnalysis,
>    the bound that makes the predicate change unsafe today disappears and THE
>    RULING REOPENS. Group C's brief must carry this line.

同一要求另有两处重申：
- progress.md:614–618（POST-GATE 清理）：「In particular item 4 … still stands and
  must be carried into group C's brief.」
- progress.md:905–910（B2 自证）：「THIS COVERS B2 ONLY. Group C must make its own,
  and its brief must still carry open item 4 verbatim.」
- progress.md:1104–1106：「Group C has NOT started. Its brief must carry, verbatim:
  GATE-A open item 4; the four GATE-B conditions above; and the obligation to make
  its OWN confirmation rather than inherit B1's or B2's.」

**另一边（计划文本）**：`# 组 C`(1402) 到 `### GATE-C`(1817) 全文没有出现
`persistBoundaryAnalysis`、`preserving is permitting`、`open item 4` 或等价措辞。
C1 Step 12 / C2 Step 10 / C3 Step 10 / C4 Step 8 / GATE-C Step 1 的评审重点清单里
也都没有。

**我的读代码结论（供人裁参考，不代替组 C 自己做的确认）**：组 C 计划中的改动
（C1 在 `resumeLoop` 加 `onAdopted?` 回调；C2 加 CLI 分支与信号处理器；C3 只改
`src/sweep/`；C4 只改测试）**都不新增进入 `persistBoundaryAnalysis` 的路由**——
`persistBoundaryAnalysis` 的两个调用点都在 `runLoopFromState` 内，组 C 不碰它。
唯一擦边处是 C3 规定的 `onReconciliationWriteAbandoned` 回调「刻意不包 try/catch」
（计划 1679 行）：它若抛出会经 `writeBoundaryArtifacts` → `persistBoundaryAnalysis`
→ `runLoopFromState` 的外层 catch，但那条 catch 对普通异常走
`persistTerminalState`（终态），不是新的**非终态**路由。

**影响**：C1（`resumeLoop` 的第一处改动）或 GATE-C Step 1。需要人裁：是否给组 C
加一个显式的确认步骤，还是接受由 GATE-C 的整分支评审兜住。

---

### A-3. GATE-B 条件 1 的「同一笔提交」要求，在计划的 C2 形状下没有主语

**冲突**：GATE-B 条件 1 断言「让 B1 分支变可达的接线」与「设置 `stopRequested` 的
接线」是同一件事，因此要求组 C 把接线与所有权守卫的裁决放进**同一笔提交**。
但计划的 C2 只装一个设置 `stopRequested` 的信号处理器，**完全不把 heartbeat 交给
处理器、也不新增 `stop()` 调用点**——于是 B1 分支仍不可达，条件 1 的前提为假，
而「所有权守卫的裁决」在计划里没有任何落点（`src/controller/runLoop.ts` 不在组 C
任何任务的 Files 清单里）。

**ledger 原话**（progress.md:1003–1010，GATE-B「CONDITIONS ON THIS PASS」第 1 条）：

> 1. REACHABILITY AND HARM ARE ONE WIRING, NOT TWO (lane 1, F-1). The recorded
>    "writeRunState has no CAS" and "B1's branch is unreachable today" have been
>    tracked as separate items. They are the same item: the single change that
>    brings the branch to life — handing the heartbeat to a SIGINT handler or a
>    resident watch, the same wiring that sets stopRequested — brings the
>    unguarded overwrite to life in the same commit. REQUIREMENT: group C's
>    wiring commit and the ownership-guard ruling must happen in ONE commit, not
>    two. No test will red if they are split.

**另一边（计划 C2 文本）**：

- 1542–1543（C2 Produces）：
  `export function registerStopHandlers(signal: StopRequestSignal, options?: { exit?: (code: number) => void }): () => void;`
  —— 参数里**只有 `signal`**，没有 heartbeat、没有 run 目录。
- 1580（C2 陷阱清单）：「**信号处理器装在 `cli.ts`，不装在 `sweepRuns.ts`。** 这既让
  「sweep 自身不新增 writer」成立，也让测试 13 可测。」
- 1567（C2 逃生口）：第二次信号 → `exit(130)`。也不经过 heartbeat。

**代码的真实情况**：B1 分支的触发条件是 `heartbeat.stop()` 已被调用后再进
`runExclusive`。今天 `stop()` 的两个生产调用点都在 `runLoopFromState` 之后的
`finally` 里：

```
$ rtk proxy "grep -rnF 'createStopRequestSignal' src"
src/controller/runLoop.ts:1020:export function createStopRequestSignal(): StopRequestSignal {

$ rtk proxy "grep -nF 'StopRequestSignal' src/controller/runLoop.ts"
1018:export type StopRequestSignal = { requested: boolean };
1020:export function createStopRequestSignal(): StopRequestSignal {
1029:  stopRequested?: StopRequestSignal;
```

`src/controller/resumeLoop.ts:203–206` 的 `finally { await heartbeat.stop(); }`
也复核过：`stop()` 仍在 `runLoopFromState` 返回**之后**。ledger 自己把这条记为
「THE MOST FRAGILE PREMISE OF THIS WHOLE GATE」（progress.md:1042–1047）：
「`stopped` is false for the entire duration of runLoopFromState … NOTHING TESTS IT」。

**影响**：C2（Step 4/Step 5/Step 6 与 Step 9 的提交边界）。需要人裁三选一：
(a) 认定 C2 不是条件 1 说的那笔接线，条件 1 顺延给 L5；
(b) 认定 C2 就是那笔接线，于是必须在 C2 的同一笔提交里补所有权守卫的裁决——
    但那要改 `src/controller/runLoop.ts`，超出 C2 的 Files 清单；
(c) 给 C2 加一条「记录该分支仍不可达并说明理由」的步骤。
无论哪一条，**都不能靠测试发现**——条件 1 自己写着「No test will red if they are split」。

---

### A-4. C3 强制打印「该 run 仍可续跑」，与 GATE-B 条件 2 实测的「非终态 ≠ 可续跑」正面撞上

**冲突**：C3 的错误路由表要求对非终态返回的 run **明确标注它仍可续跑**，而 GATE-B
条件 2 是一条实测结论：非终态并不蕴含 `resumeLoop` 会接受它。计划没有任何一步要求
证明「sweep 打出 `interrupted` 的那些 run 确实可被 resume 捡起」。

**计划原话**（C3「错误路由（§8 表，逐行）」，1650 行）：

> | run 因 `stop_requested` 或 `RunHeartbeatStoppedError` 返回非终态 | 记录为 **`interrupted`**，**明确标注该 run 仍可续跑** | stdout |

**另一边（ledger 原话，progress.md:1011–1019，GATE-B 条件 2）**：

> 2. NON-TERMINAL IS NOT THE SAME AS RESUMABLE (lane 1, F-2). evaluateResume-
>    Eligibility's first four criteria require owner-transfer.json AND
>    reconciliation-record.json with OWNER_LOST / matching epoch, while
>    initializeRunFiles writes only loop-contract.json, loop-state.json and
>    events.jsonl. So a BRAND-NEW run stopped at the loop top returns a
>    non-terminal state that resumeLoop then REFUSES. 8b(i) is green because
>    seedEligibleRun pre-seeds both files — it proves "a run that has ALREADY
>    been taken over can be picked up again", which is a weaker claim than the
>    one §5.4 leans on. Group C's sweep must not inherit the stronger reading.

**代码的真实情况（八条判据，`src/controller/resumeLoop.ts:40–69`）**：

```
$ rtk proxy "grep -cF 'return { ok: false' src/controller/resumeLoop.ts"
8
```

判据 1（:43）读 `ownerTransfer.eligibleForContinuation`，判据 2（:46）读
`reconciliation.eligibleForContinuation`，判据 3（:49）要 `ownershipVerdict === "OWNER_LOST"`，
判据 4（:52）要两个 `newOwnerEpoch` 相等。四条都要求 `owner-transfer.json` 与
`reconciliation-record.json` 同时存在且已被写成转移后的形状。

**sweep 的过滤器建在哪里，查清楚了**：C1 的过滤器**不是**建在
`evaluateResumeEligibility` 上，而是建在 L2 的**观测**上——

```
$ rtk proxy "grep -rnF 'eligibleForContinuation' src/"
...
src/registry/observeFields.ts:47:    fields: [{ name: "eligibleForContinuation", type: "literal-true" }],
src/registry/renderRuns.ts:60:  "eligibleForContinuation is an observed field, not a decision that the run may be resumed.";
```

`src/registry/observeFields.ts` 的 `OBSERVED_FILES` 只观测三个文件
（`loop-state.json` / `owner-record.json` / `owner-transfer.json`），
`eligibleForContinuation` 只挂在 **`owner-transfer.json`**（:44–48）上，
**`reconciliation-record.json` 根本不在观测清单里**。所以 C1 的
「观测为 `{ kind: "present", value: true }` 才算 eligible」在代码上成立
（C1 Interfaces 1418 行那句话是**对的**），但它是八条判据里的**第一条**，
剩下七条 sweep 看不见。

**因此**：sweep 打出的横幅数字 `<eligible>` 是一个**上界**，不是可续跑数；被拒的
run 走 `refused`，计划已按「拒绝不消耗配额」处理，这部分**无冲突**。真正需要人裁
的是 `interrupted` 那一行的措辞：它是一句**打在操作者眼前的持久断言**，而计划没有
任何步骤或断言去建立它。我读代码的推断是：sweep 只会对**已被它自己 adopt 过**的
run 打 `interrupted`（`stopRequested` 的检查点在 `runLoopFromState` 的 loop 顶端，
在 `resume_adopted` 之后），而那种 run 的 `owner-transfer.json` 与
`reconciliation-record.json` 都已就位，所以那句话**在 sweep 的路径上多半为真**——
但 `evaluateResumeEligibility` 还有判据 5–8（`supersededByEpoch`、
`currentOwnerEpoch` 匹配、`ownerStatus === "current"`、`runState.status` 可续），
第二次 sweep 之前若有别的进程接管，这句话就会假。

**影响**：C3 Step 1/Step 2（报告行格式）与 C3 Step 10 的评审重点。需要人裁：
把「仍可续跑」改成一句可验证的弱断言，还是给 C3 加一条建立它的测试。

---

### A-5. `cannot read run artifacts` 的「计划阶段实测 3 行」在今天为假（3 → 22）

**冲突**：C3 用一条带数字的 grep 论证「前缀唯一、只有两处生产者、测试侧只有一处
既有断言」，并据此设计变异一。组 A 落地之后这个数字腐坏了一个数量级。

**计划原话**（C3，1658–1663 行）：

```bash
grep -rnF 'cannot read run artifacts' src/ tests/
# 计划阶段实测 3 行：src/controller/resumeLoop.ts 两行（resume_denied 的 detail 与 throw），
#   tests/cli/cli.test.ts 一行（既有断言，说明这个前缀已经是被依赖的契约）。
#   src/ 内只有 resumeLoop.ts 一处产生它 —— 前缀唯一。
```

**代码的真实情况**：

```
$ rtk proxy "bash -c \"grep -rnF 'cannot read run artifacts' src tests | wc -l\""
      22
```

逐行看过（完整输出见本轮第一次 grep）：
- `src/` 仍是 **2 行**（`src/controller/resumeLoop.ts:136` 的 `resume_denied` detail 与
  `:137` 的 `throw`）——**「src/ 内前缀唯一」这半句仍然成立**；
- `tests/cli/cli.test.ts:73` 仍是 1 行；
- **新增 19 行全在 `tests/persistence/fileStore.test.ts`**（组 A 的崩溃矩阵）：
  `:2816–2828`（13 行）、`:2842–2845`（4 行）是矩阵期望字符串，
  `:3702–3703` 是把 `error.message.startsWith("cannot read run artifacts")` 映射成
  `"refused: cannot read run artifacts"` 的辅助函数。

**影响**：C3 Step 7 的变异一（1719 行：「前缀字面量改掉而不同步改判据 → 12c 必红」）。
变异照样能杀掉 12c（判据是单条具名跑，不是套件），**但它会同时打红
`fileStore.test.ts` 里那一整块组 A 的崩溃矩阵**，因为 `:3702` 那个辅助函数会随之
失配。这正是 Global Constraints 42–116 行反复警告的「套件红不是证据」场景的镜像：
实施者贴出的注入后输出会包含大量与 12c 无关的红。需要人裁：是否要求 C3 就地更正
这个数字、并在变异一的记录里预先声明预期的连带红（否则评审员会把它当新缺陷）。
同时 C3 1666 行那句「`resumeLoop.ts` 那两处与 sweep 的判据**必须同笔改动**」现在
漏掉了第三方——`fileStore.test.ts:3702` 也依赖这个前缀。

---

### A-6. C2 的位置硬约束指错了边界：真正卡死的是 `loadAdapter`，不是两处 `? 0 : 2`

**冲突**：C2 三处（退出码表、陷阱清单、Step 10 评审重点）都把 sweep 分支的位置约束
写成「必须在两处 `finalState.status === "succeeded" ? 0 : 2` 映射之前返回」。但在
`src/cli.ts` 的真实结构里，满足这条约束的位置里**有一部分会破坏 C1/C3 的
`createAdapter` 闭包设计**——真正的边界是 `loadAdapter` 那一行，它比两处映射更早。

**计划原话**（三处逐字）：
- 退出码表（1558）：「`2` | **不使用。** sweep 分支必须在 `finalState.status === "succeeded" ? 0 : 2` 那**两处**映射之前返回」
- 陷阱清单（1581）：「**`sweep` 分支必须在两处 `? 0 : 2` 映射之前返回。** exit 2 在 sweep 上**不使用**。」
- Step 10（1612）：「重点：sweep 分支是否在两处 `? 0 : 2` 之前返回……」

**代码的真实情况**（`src/cli.ts`，`export async function main` 第 109–140 行）：

```
$ rtk proxy "grep -rnF 'succeeded\" ? 0 : 2' src/"
src/cli.ts:131:      return finalState.status === "succeeded" ? 0 : 2;
src/cli.ts:135:    return finalState.status === "succeeded" ? 0 : 2;
```

两处映射复核为 **2 行、都在 `src/cli.ts`**——计划 1562 行那句实测**仍然成立**。
但 `main` 的实际结构是：

- :116–126 `ls` 分支（自己 return）
- **:128 `const adapter = await loadAdapter(parsed);`** ← 无条件构造 adapter
- :129–131 `resume` 分支（第一处 `? 0 : 2`）
- :133–135 `run` 分支（第二处 `? 0 : 2`）

`loadAdapter` 的签名是
`async function loadAdapter(parsed: Exclude<ParsedArgs, { command: "ls" }>)`（:99），
它一次做完「读配置 + 构造 adapter」两件事（:100 读文件、:102–106 `new`）。给
`ParsedArgs` 加 sweep 分支后，sweep 会被 `Exclude<…, {command:"ls"}>` 收进去，
而且 sweep 分支带 `adapter` 与 `adapterConfigPath` 两个键，**类型检查会通过**。
于是「在 :131 之前、但在 :128 之后」是一个满足计划字面约束、却在**打横幅之前就
构造了 adapter** 的合法落点，直接违反 C1 1460 行「不要把已构造的 adapter 传进来
——那样横幅的位置约束不可测」与 C3 1701 行「测试要断言横幅先于 `createAdapter`
被调用」。

**影响**：C2 Step 4 与 Step 10 的评审重点。需要人裁：是否把三处约束的锚点改成
「必须在 `loadAdapter` 调用之前返回」（严格更强，且蕴含原来那条），以及
`loadAdapter` 要不要拆成「读」与「构造」两半——C2 的 Files 清单（1529）确实列了
`async function loadAdapter(` 作为修改对象，但正文没有一句说要怎么拆。

---

### A-7. C4 测试 14b 需要一整套 contract/adapter fixture，而 C4 是「Test only」且要求「照搬该文件既有的承重写法」

**冲突**：测试 14b 要求 `resumeLoop` **放行**，也就是要真的进
`runLoopFromState` 跑一次 attempt；这需要合法的 `loop-contract.json`（含真实
`repoPath`）与一个 `createAdapter` 闭包。而计划指定的落点文件今天没有任何这类
构造，计划却说「形状照搬该文件既有的承重写法」。

**计划原话**：
- C4 Files（1739）：「**Test only: `tests/registry/zeroWrite.test.ts`**（形状照搬该文件既有的承重写法）」
- C4 Interfaces（1742）：「Consumes（C1/C2/C3 产出）：`sweepRuns(options, deps?)` 与它的默认 `resume`（本任务用**真实的** `resumeLoop`，不用替身——本条钉的正是真实调用带来的写面）」
- 测试 14b（1769–1771）：「断言 sweep 之后 (i) **三个文件全部就位**、(ii) **marker 与全部 pending 已被回收**、(iii) `resumeLoop` **放行**。」

**代码的真实情况**：

```
$ rtk proxy "grep -nF -e 'describe(' -e 'it(' -e 'loop-contract' -e 'repoPath' -e 'resumeLoop' tests/registry/zeroWrite.test.ts"
38:      const relPath = relative(root, fullPath).split(sep).join("/");
182:describe("zero-write proof against a real filesystem (spec §7.1, §12.1)", () => {
183:  it("is load-bearing: readOwnerRecord itself mutates the recovery fixture (brief step 1)", async () => {
211:  it("scans a realistic tree with defaultScanDeps and writes nothing, including on the recovery path", async () => {
```

该文件今天**零处** `loop-contract`、`repoPath`、`resumeLoop`——它只驱动
`scanRuns` / `readOwnerRecord`。而 `resumeLoop` 放行之后会依次走
`loadContract(join(runDir, "loop-contract.json"))`（resumeLoop.ts:133）与
`cleanupResidualWorktrees(contract.context.repoPath, runDir)`（:184），
再进 `runLoopFromState`（:199）跑真实 attempt。Global Constraints 第 40 行同时
禁止真实 Claude 调用（「本计划全部测试走 `ScriptedAdapter` 或替身」），所以 14b
还得自带一份 scripted frames 配置。

**影响**：C4 Step 4（写测试 14b）与 Step 5 变异二。需要人裁：是接受 C4 在
`zeroWrite.test.ts` 里新建一整套 run fixture（与「照搬既有写法」这句冲突），还是
把 14b 挪到一个已有 run fixture 的测试文件（那要改 C4 的 Files 清单）。
附带一提，测试 14（gate-refused 那条）**没有这个问题**——见下面 B-9 的验证。

---

## B. 我查证后判定无冲突的条目（12 条，记录以免下一轮重查）

**B-1. C4 机制二的 11 个 staging 路径，逐个在代码里存在。**

```
$ rtk proxy "grep -rnoF -e '.owner-transfer.transaction.json' -e '.owner-record.pending.json' -e '.owner-transfer.pending.json' -e '.reconciliation-record.pending.json' -e '.owner-record.publish.tmp' -e '.owner-transfer.publish.tmp' -e '.reconciliation-record.publish.tmp' -e '.owner-transfer.transaction.tmp' -e '.owner-record.pending.tmp' -e '.owner-transfer.pending.tmp' -e '.reconciliation-record.pending.tmp' src/persistence/fileStore.ts"
src/persistence/fileStore.ts:536:.owner-record.publish.tmp
src/persistence/fileStore.ts:537:.owner-transfer.publish.tmp
src/persistence/fileStore.ts:538:.reconciliation-record.publish.tmp
src/persistence/fileStore.ts:539:.owner-record.pending.json
src/persistence/fileStore.ts:540:.owner-transfer.pending.json
src/persistence/fileStore.ts:541:.reconciliation-record.pending.json
src/persistence/fileStore.ts:542:.owner-transfer.transaction.json
src/persistence/fileStore.ts:544:.owner-transfer.transaction.tmp
src/persistence/fileStore.ts:545:.owner-record.pending.tmp
src/persistence/fileStore.ts:546:.owner-transfer.pending.tmp
src/persistence/fileStore.ts:547:.reconciliation-record.pending.tmp
```

11/11 命中，与计划 1754–1757 行的四组分类（marker 1 / pending 3 / 发布 temp 3 /
marker temp 1 / pending temp 3）逐条对上。:543 是 `.owner-transfer.lock`，
按计划所述**不在这 11 个里**，正确。

**B-2. `cleanupOwnerTransferStagingWithoutMarker` 恰好 10 个逐个具名的 `safeUnlink`。**
`src/persistence/fileStore.ts:872–895`：解构 10 个路径（:874–883），然后
:885–894 逐个 `await safeUnlink(...)`，共 10 行，marker 自己不在其中。
与计划 1759 行「11 = 1 marker ＋ 10」一致。

**B-3. `evaluateResumeEligibility` 计数守卫仍为 8。**

```
$ rtk proxy "grep -cF 'return { ok: false' src/controller/resumeLoop.ts"
8
```

C1 Step 2 要改 `resumeLoop.ts`（加 `onAdopted?`），但不碰这八条，守卫不受影响。

**B-4. C4 机制三指的「八条判据的第二条」在代码上正确。**
`src/controller/resumeLoop.ts:46`：`if (reconciliation.eligibleForContinuation !== true)`
——确实是第二条，确实读 `reconciliation-record.json`。计划 1761 行说
「让 `reconciliation-record.json` 的 `eligibleForContinuation` 为 `false`，命中八条
判据的第二条」**成立**。注意它与 C1 Interfaces 1418 行说的
「`eligibleForContinuation` 是 `owner-transfer.json` 上的一个被观测字段」**不矛盾**：
两个文件各有一个同名字段，判据 1（:43）读 transfer 的、判据 2（:46）读
reconciliation 的，而 L2 只观测前者。

**B-5. C4 测试 14 的「其余字节不变」在无 staging 残留时确实可达。**
`src/persistence/fileStore.ts:1019–1034`：

```
1022-  if (!(await pathExists(paths.transactionMarkerPath))) {
1023-    if (options?.lockHeld) {
1024-      await cleanupOwnerTransferStagingWithoutMarker(runDir);
1025-    }
1026-    return;
1027-  }
```

`readOwnerRecord`（:1036–1039）调用它时**不传 `lockHeld`**，所以「无 marker」时
它立刻 return，既不建锁也不 unlink。机制二因此是真前提，不是猜的。
测试 14b 的路径也复核过：marker 在盘、锁不在盘 → :1029 的三合取为假 → 落到
:1033 `finalizePendingOwnerTransfer(runDir)`，恢复确实发生。

**B-6. C4 Step 1 那条命令今天仍然复现（但输出里带失效行号）。**

```
$ rtk proxy "grep -nF -A14 'Zero-write proof.' docs/superpowers/specs/2026-07-28-run-registry-design.md"
400:1. **Zero-write proof.** Snapshot the whole tree as `(path, size, mtime,
...
404-   recovery, which requires **all** of: `.owner-transfer.transaction.json`
405-   present (`fileStore.ts:552` — the trigger), both `.owner-record.pending.json`
406-   and `.owner-transfer.pending.json` present (`finalizePendingOwnerTransfer`
407-   reads them and throws ENOENT otherwise), and `.owner-transfer.lock` **absent**
408-   (with a live lock, `readOwnerRecord` returns without writing, `:559-561`).
EXIT=0
```

**fixture 前提集本身仍然正确**（已由 B-5 对着代码复核）。但输出里的两个行号锚点
已失效：今天 `fileStore.ts:552` 是
`const RECONCILIATION_RECORD_FILE = "reconciliation-record.json";`（一个常量声明），
真正的 trigger 在 `:1022`；`:559-561` 同样错位。属于 Global Constraints
第 120 行禁止的行号锚点，由 D1 Step 6（全仓行号引用扫描）覆盖，**不是组 C 的冲突**，
但 C4 Step 1 会把这段带失效行号的输出原样贴进报告，先记在这里。

**B-7. C1 消费的 registry 导出面全部存在且签名对得上。**

```
$ rtk proxy "grep -nF 'export' src/registry/scanRuns.ts"
13:export type ScanIssue =
17:export type ScanRow = RunObservation | ScanIssue;
21:export type DirReader = {
26:export type ScanDeps = ObserveDeps & { dir: DirReader };
42:export const defaultScanDeps: ScanDeps = {
128:export async function scanRuns(root: string, deps: ScanDeps): Promise<ScanRow[]> {

$ rtk proxy "grep -nF 'export' src/registry/observeRun.ts"
9:export type RunObservation = {
21:export async function observeRun(runDir: string, deps: ObserveDeps): Promise<RunObservation> {

$ rtk proxy "grep -nF 'scanRootFailureDetail' src/registry/renderRuns.ts"
86:export function scanRootFailureDetail(rows: ScanRow[], root: string): string | undefined {
```

与计划 1416–1418 行逐条一致。`RunObservation.kind` 是字面量 `"run"`
（observeRun.ts:10），C1 流水线的 `过滤 kind === "run"` 成立。

**B-8. 「`scanRuns` 全文无任何 sort」成立。**

```
$ rtk proxy "grep -nF 'sort' src/registry/scanRuns.ts"
EXIT=1
```

零行输出、exit 1（用了 `-F`，按 Global Constraints 第 124 行退出码可作论据）。
C1 陷阱清单 1486 行「排序是必须的」有据。

**B-9. 「`src/sweep/` 目录不存在」（未结清风险 2）今天仍然成立。**

```
$ rtk proxy "find src -iname '*sweep*'"
（零行输出）
```

C1 Step 4「确认失败」的原因（import 失败）仍然有效。

**B-10. C2 描述的 `parseArgs` 结构与代码一致。**
`src/cli.ts:55` 是 `if (command !== "run" && command !== "resume") { throw … }`；
`:60` 是 `for (let index = 1; index < argv.length; index += 2)`；
`:64–70` 是 `--run-dir` / `--adapter` / `--adapter-config` 的必需检查。
计划 1547 行「`sweep <root> --adapter x` 会被配成 `root → "--adapter"`」在这个配对
循环下确实如此，1549 行说的插入点（配对循环之后、必需检查之前）**是可行的**。

**B-11. C3 消费的既有类型面存在。**
`ResumeNotEligibleError` 为单参构造（`src/controller/resumeLoop.ts:22–27`），签名
未被组 A/B 改动；`RunLeaseHeldError` 存在（`src/ownership/lease.ts:10–16`）。
一处锚点不精确、不构成冲突：C3 Interfaces 1625 行把两者并列在
「（`src/controller/resumeLoop.ts`）」之后，但 `RunLeaseHeldError` 实际导出自
`src/ownership/lease.ts`，`resumeLoop` 只是经 `checkRunLease`（leaseGate.ts:71）
间接抛出它。
`ResumeLoopOptions` 今天是 `{ onReconciliationWriteAbandoned?; stopRequested? }`
（resumeLoop.ts:91–98），与计划 1922 行预期的 C1 前形状一致，C1 只需加
`onAdopted?` 一个键。

**B-12. C3 的 `cancelled` 五个来源，数得过去（且非承重）。**
直接写终态的 4 个调用点：`src/controller/runLoop.ts:1062`、`:1110`、`:1455`、`:1514`
（都是 `persistTerminalState(runDir, state, "cancelled", …)`）。
经 `decision.kind` 的一条路径，其 `{ kind: "cancelled" }` 产生处有两个
（`src/stop/stopController.ts:62` 与 `src/controller/runLoop.ts:1402`），但它们汇入
同一条消费路径，所以「4 ＋ 1 条路径」的读法成立。该数字不被任何测试断言，
非承重，记录即可。

**B-13.（顺序依赖）C1→C2→C3→C4 可以按序独立实施。**
逐条对过每个任务的 Consumes：C1 只消费 GATE-A hash 与既有 registry / A8 / B2 的
产出（全部已在树上，见 B-7、B-11）；C2 消费 C1 的 `sweepRuns` / `SweepOptions`；
C3 消费 C1 的两个 sink 与 `SweepDeps.resume`；C4 消费 C1/C2/C3 的成品与真实
`resumeLoop`。**没有任何任务需要更后面任务的产物。**
唯一一处张力是自解的：C1 Step 5 说「报告与横幅的**格式**留给 C3」，而 C1 的测试
12b(a)（1478 行）已经要求「**横幅同时含 `5` 与 `2`**」——所以 C1 必须先打一个含
两个数字的横幅。C3 定死的格式
（`sweep: <eligible> eligible run(s) under <root>, will attempt at most <N>, adapter=<name>`，
1631 行）本来就同时含这两个数字，C1 的断言不会被 C3 推翻。**不需要人裁。**

---

## C. 方法与自限

- 本轮**未跑测试套件**（按指示）。所有结论来自读代码与 `grep`/`find`/`sed` 复核。
- 计划里带数字或带「实测」的断言，逐条重推的结果：
  **对上的**：`? 0 : 2` = 2 行（1562）；`return { ok: false` = 8（143）；
  11 个 staging 路径（1754–1757）；cleanup = 10 个 safeUnlink（1759）；
  `src/sweep/` 不存在（1850）；`scanRuns` 无 sort（1486）；
  L2 §12.1 fixture 前提集（1774）。
  **对不上的**：`cannot read run artifacts` = 3 行 → **22 行**（1660–1662，见 A-5）。
- 我**没有**验证的（超出只读扫描范围，留给实施者）：C4 测试 14 的「恰好两行事件」
  在真实 fixture 上的实测（需要构造 fixture 并跑）；C3 的 `interrupted` 行在
  第二次 sweep 场景下的真假（需要构造两轮 sweep）。两处都已在 A-4 / A-7 里具名。
- 按指示，本报告**只摆出两边的原话与实测输出，不提出改计划的方案**。
