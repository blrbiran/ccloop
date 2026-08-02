# Task A8 报告 — 四层可选回调通道（`onReconciliationWriteAbandoned`）

分支 `feat/l3-debt1-transactional-continuation`，起点 `f264cd1`，落地提交 `57da4b3`。
所有验证跑均通过 `rtk proxy "<command>"` 绕过全局 `rtk` 过滤 hook，且先 `export ECC_GATEGUARD=off DISABLE_OMC=1`（`rtk proxy` 不接受以环境赋值开头的引号串）。所有输出未过滤、未截断，每条命令都回显退出码。

---

## 1. 落地的四个签名（逐字）

```ts
// src/persistence/fileStore.ts —— 第三个可选参数，返回类型未改
export async function writeBoundaryArtifacts(
  runDir: string,
  artifacts: {
    boundaryAnalysis: RunBoundaryAnalysis;
    reconciliationRecord?: ReconciliationRecord;
  },
  options?: { onReconciliationWriteAbandoned?: (detail: string) => void },
): Promise<void>

// src/controller/runLoop.ts —— 第五个可选参数（非导出函数），返回类型未改
async function persistBoundaryAnalysis(
  runDir: string,
  state: RunState,
  heartbeat: LeaseHeartbeat,
  executionRecovery?: ExecutionRecovery,
  onReconciliationWriteAbandoned?: (detail: string) => void,
): Promise<void>

// src/controller/runLoop.ts —— 第七个位置参数，是一个可选参数对象
export type RunLoopFromStateOptions = {
  onReconciliationWriteAbandoned?: (detail: string) => void;
};
export async function runLoopFromState(
  contract: LoopContract,
  runDir: string,
  adapter: RuntimeAdapter,
  initialLoopState: RunState,
  heartbeat: LeaseHeartbeat = INERT_LEASE_HEARTBEAT,
  leaseLoss: LeaseLossSignal = { lost: null },
  options?: RunLoopFromStateOptions,
): Promise<RunState>

// src/controller/resumeLoop.ts —— 第三个位置参数，同样是一个可选参数对象
export type ResumeLoopOptions = {
  onReconciliationWriteAbandoned?: (detail: string) => void;
};
export async function resumeLoop(
  runDir: string,
  adapter: RuntimeAdapter,
  options?: ResumeLoopOptions,
): Promise<RunState>
```

四层全部是**可选**参数，四个返回类型一个字节未改。

## 2. 哪些调用点转发，哪些刻意不转发

**转发的：**

| 调用点 | 形态 |
|---|---|
| `runLoopFromState` → `persistBoundaryAnalysis`（execute 超时且无结果那一支，传 `executionRecovery`） | `(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned)` |
| `runLoopFromState` → `persistBoundaryAnalysis`（`execution === null` 那一支，原本只传 3 个实参） | `(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned)` —— 按计划补 `undefined` 占位 |
| `persistBoundaryAnalysis` → `writeBoundaryArtifacts`（`nextOwnerEpoch !== null` 一支） | 第三参 `{ onReconciliationWriteAbandoned }` |
| `persistBoundaryAnalysis` → `writeBoundaryArtifacts`（`else` 一支） | 第三参 `{ onReconciliationWriteAbandoned }` |
| `resumeLoop` → `runLoopFromState` | 第七参 `{ onReconciliationWriteAbandoned: options?.onReconciliationWriteAbandoned }` |

`persistBoundaryAnalysis` 的**两个**调用点都改了（计划 §9 点名），锚点复核：

```bash
$ grep -nF 'persistBoundaryAnalysis' src/controller/runLoop.ts
719:async function persistBoundaryAnalysis(
1172:          await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery, options?.onReconciliationWriteAbandoned);
1204:        await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);
```

3 行 = 定义 1 行（无 export）＋ 两个调用点，与计划阶段实测的形状一致。

**刻意不改的：**

- `runLoop.ts` 里的 `runLoop` → `runLoopFromState`（`runLoop` 自己没有 options 参数，本任务不给它加；计划未要求，B2/C1 才是它的消费者）。
- `resumeLoop` 的 14 处既有调用点：一处未改，全部仍是 2 个实参。整套件绿即为证（下文 §5）。
- `fileStore.test.ts` 里既有的两参 `writeBoundaryArtifacts` 调用：一处未改。

```bash
$ grep -cF 'writeBoundaryArtifacts(runDir, {' tests/persistence/fileStore.test.ts
15
$ grep -rnF 'writeBoundaryArtifacts(' src/
src/controller/runLoop.ts:898:    await writeBoundaryArtifacts(runDir, { boundaryAnalysis }, { onReconciliationWriteAbandoned });
src/controller/runLoop.ts:900:    await writeBoundaryArtifacts(runDir, {
src/persistence/fileStore.ts:354:export async function writeBoundaryArtifacts(
```

注：计划阶段实测的 11 已被 A7 新增的三条 abandon 测试等推高到 15（本次执行实测 15）。这 15 处全是两参调用，**一处都没改**——第三参可选正是为此。我自己新增的两条 12d(iii) 测试用的是多行 `writeBoundaryArtifacts(\n  runDir,` 形式，不计入这个 `-F` 计数。

`src/` 里 `writeBoundaryArtifacts(` 仍是 2 行生产面（一个定义 + `runLoop.ts` 的两个分支写在同一函数内、其中一个跨行），与计划阶段的「2 行」相比多出的是 `runLoop.ts:898`——因为原来那一行 `await writeBoundaryArtifacts(runDir, { boundaryAnalysis });` 现在带上了第三参、仍在一行内，而 `else` 分支那次调用是跨行的、只匹配到 `runLoop.ts:900`。生产调用点个数没变（仍是 2 个）。

## 3. `writeBoundaryArtifacts` 里的插入位置与 A7 的 swallow

回调**排在 `appendEvent` 之前**，且**没有**包 try/catch。A7 那层 `try { await appendEvent(...) } catch { }` **一个字节未动**——注入实验后已逐字还原（见 §4 变异二）。

就地写明的两件事（代码注释里）：

1. 「排在前面是刻意的」；
2. 「它现在是纵深防御、**没有配套的杀伤变异**」——swallow 在位时，把回调和 `appendEvent` 对调是**等价变异**，(b) 两侧都绿。**没有**为了凑一条变异而拿掉 swallow。

## 4. 变异实验（五次，逐条走三步判据）

单跑用的 `-t` 一律是**裸 `it` 名**（`Amended 2026-08-02 (b)` 允许的两种能匹配形式之一）；每一块都能读到具名那一条的非零计数（`Tests 1 passed | N skipped` 或 `1 failed | N skipped`），不存在「整行全 skipped」的零匹配。基线工作副本 = 本 git 工作树本身，非 scratchpad 副本。

### 变异一 —— 只 `appendEvent`、不调回调

具名：`fileStore > calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves`

注入前（绿）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (74 tests | 73 skipped) 4ms

 Test Files  1 passed (1)
      Tests  1 passed | 73 skipped (74)
   Start at  21:53:34
   Duration  507ms (transform 227ms, setup 0ms, collect 263ms, tests 4ms, environment 0ms, prepare 40ms)

EXIT=0
```

注入点（生产代码 `src/persistence/fileStore.ts`）：把 `options?.onReconciliationWriteAbandoned?.(String(decision.error));` 整行换成 `// MUTATION 1`。

注入后（红）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (74 tests | 1 failed | 73 skipped) 12ms
   × fileStore > calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves 11ms
     → expected [] to have a length of 1 but got +0

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > calls onReconciliationWriteAbandoned exactly once with the read failure and still resolves
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ tests/persistence/fileStore.test.ts:2467:26
    2465|     ).resolves.toBeUndefined();
    2466| 
    2467|     expect(abandonments).toHaveLength(1);
       |                          ^
    2468|     // Same content the events.jsonl line carries: String(error) of th…
    2469|     // the file is what makes an operator-visible line actionable.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 73 skipped (74)
   Start at  21:54:00
   Duration  507ms (transform 222ms, setup 0ms, collect 253ms, tests 12ms, environment 0ms, prepare 50ms)

EXIT=1
```

已还原（`grep -nF 'options?.onReconciliationWriteAbandoned?.(String(decision.error));' src/persistence/fileStore.ts` → `401:...`）。

### 变异二 —— 删掉 `appendEvent` 外面那层 `try{}catch{}`（退回裸调用）

具名：`fileStore > still resolves and still calls the callback when appendEvent rejects`

注入前（绿）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still resolves and still calls the callback when appendEvent rejects'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (74 tests | 73 skipped) 4ms

 Test Files  1 passed (1)
      Tests  1 passed | 73 skipped (74)
   Start at  21:53:40
   Duration  454ms (transform 183ms, setup 0ms, collect 220ms, tests 4ms, environment 0ms, prepare 39ms)

EXIT=0
```

注入后（红），杀的是子断言 (a)「仍然正常 resolve」：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still resolves and still calls the callback when appendEvent rejects'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (74 tests | 1 failed | 73 skipped) 12ms
   × fileStore > still resolves and still calls the callback when appendEvent rejects 12ms
     → promise rejected "Error: EISDIR: illegal operation on a dir… { …(4) }" instead of resolving

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > still resolves and still calls the callback when appendEvent rejects
AssertionError: promise rejected "Error: EISDIR: illegal operation on a dir… { …(4) }" instead of resolving
 ❯ tests/persistence/fileStore.test.ts:2529:5
    2527|         { onReconciliationWriteAbandoned: (detail) => abandonments.pus…
    2528|       ),
    2529|     ).resolves.toBeUndefined();
       |     ^
    2530| 
    2531|     // (b) the operator channel survives the loss of the audit channel…

Caused by: Error: EISDIR: illegal operation on a directory, open '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-Mjgolp/events.jsonl'
 ❯ appendEvent src/persistence/fileStore.ts:86:3
 ❯ Module.writeBoundaryArtifacts src/persistence/fileStore.ts:403:7
 ❯ tests/persistence/fileStore.test.ts:2501:5

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { errno: -21, code: 'EISDIR', syscall: 'open', path: '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-Mjgolp/events.jsonl'  }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 73 skipped (74)
   Start at  21:54:20
   Duration  474ms (transform 193ms, setup 0ms, collect 221ms, tests 12ms, environment 0ms, prepare 46ms)

EXIT=1
```

已还原（`git diff --stat src/persistence/fileStore.ts` → `1 file changed, 16 insertions(+)`，零删除，证明 A7 的 swallow 逐字还在）。

**⚠️ 一处对计划的偏离，就地披露：** 计划写「**mock** `appendEvent` 抛出时」。`writeBoundaryArtifacts` 是**模块内直接调用**同文件里的 `appendEvent`，任何模块级 mock 都拦不住这次调用（ESM 里模块内引用不经过导出表）。若为可 mock 而把 `appendEvent` 做成可注入依赖，那是改生产结构去迁就测试。**改用真实的环境故障**：把 `events.jsonl` 建成**目录**，`appendFile` 抛 `EISDIR`。测试里就地断言了这个前置条件（`await expect(appendEvent(...)).rejects.toMatchObject({ code: "EISDIR" })`），所以「appendEvent 确实拒绝了」是被证明的、不是假设的。可观测行为与 mock 完全等价，而且更贴近 swallow 本来防的那件事。

### 变异三 —— 删掉 `runLoopFromState → persistBoundaryAnalysis` 那一段透传

具名：`runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts`

注入前（绿）——同时是 Step 5 的构造证据，见 §5：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/runLoop.integration.test.ts (52 tests | 51 skipped) 201ms

 Test Files  1 passed (1)
      Tests  1 passed | 51 skipped (52)
   Start at  21:57:20
   Duration  695ms (transform 211ms, setup 0ms, collect 244ms, tests 201ms, environment 0ms, prepare 43ms)

EXIT=0
```

注入点：`runLoop.ts:1172` 退回 `await persistBoundaryAnalysis(runDir, state, heartbeat, executionRecovery);`（即本测试实际走到的那个调用点）。

注入后（红）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (52 tests | 1 failed | 51 skipped) 199ms
   × runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts 198ms
     → expected [] to have a length of 1 but got +0

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ tests/controller/runLoop.integration.test.ts:1303:26
    1301|     expect(analysis.status).toBe("stale_candidate");
    1302| 
    1303|     expect(abandonments).toHaveLength(1);
       |                          ^
    1304|     // The detail reaching the operator is the read failure itself, un…
    1305|     // it travelled through.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 51 skipped (52)
   Start at  21:57:43
   Duration  670ms (transform 208ms, setup 0ms, collect 240ms, tests 199ms, environment 0ms, prepare 46ms)

EXIT=1
```

已还原。

### 变异四 —— 删掉 `persistBoundaryAnalysis → writeBoundaryArtifacts` 那一段透传

具名：同上（`runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts`）。注入前那次绿见变异三（还原后同一工作副本）。

注入点：`else` 分支的 `}, { onReconciliationWriteAbandoned });` 退回 `});`。

注入后（红）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (52 tests | 1 failed | 51 skipped) 208ms
   × runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts 207ms
     → expected [] to have a length of 1 but got +0

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ tests/controller/runLoop.integration.test.ts:1303:26
    1301|     expect(analysis.status).toBe("stale_candidate");
    1302| 
    1303|     expect(abandonments).toHaveLength(1);
       |                          ^
    1304|     // The detail reaching the operator is the read failure itself, un…
    1305|     // it travelled through.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 51 skipped (52)
   Start at  21:57:52
   Duration  676ms (transform 202ms, setup 0ms, collect 239ms, tests 208ms, environment 0ms, prepare 39ms)

EXIT=1
```

已还原。

### 变异五（**计划外新增**）—— 删掉 `resumeLoop → runLoopFromState` 那一段透传

具名：`resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState`

**为什么加：** 计划的 Steps 只要求 12d(iii)（fileStore 层）与 12d(iv)（中间三层，经 `runLoopFromState` 驱动）。两者都止步于 `runLoopFromState`，**`resumeLoop` 那一行转发因此没有任何能失败的断言**——删掉它，全套件仍然全绿。这正是 12d(iv) 自己要防的「两侧各自绿、中间断掉」，只是高了一层。Global Constraint「**加一个成分和加它的覆盖是一件事**」直接适用。计划把 12d(i)/(ii) 的替身 `resumeLoop` 分给了组 C，但那两条用的是**替身**，钉不住真 `resumeLoop` 的这一行。所以这是**补齐计划的落点，不是与计划相左**。

注入前（绿）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.integration.test.ts -t 'forwards onReconciliationWriteAbandoned into the resumed runLoopFromState'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests | 11 skipped) 207ms

 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
   Start at  21:58:58
   Duration  578ms (transform 100ms, setup 0ms, collect 128ms, tests 207ms, environment 0ms, prepare 38ms)

EXIT=0
```

注入点：`resumeLoop.ts` 的 `runLoopFromState(..., heartbeat, leaseLoss, { onReconciliationWriteAbandoned: options?.onReconciliationWriteAbandoned })` 退回 `..., heartbeat, leaseLoss)`。

注入后（红）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.integration.test.ts -t 'forwards onReconciliationWriteAbandoned into the resumed runLoopFromState'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/resumeLoop.integration.test.ts (12 tests | 1 failed | 11 skipped) 212ms
   × resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState 211ms
     → expected [] to have a length of 1 but got +0

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/resumeLoop.integration.test.ts > resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ tests/controller/resumeLoop.integration.test.ts:163:26
    161|     });
    162| 
    163|     expect(abandonments).toHaveLength(1);
       |                          ^
    164|     expect(abandonments[0]).toContain("JSON");
    165|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 11 skipped (12)
   Start at  21:59:08
   Duration  578ms (transform 96ms, setup 0ms, collect 124ms, tests 212ms, environment 0ms, prepare 40ms)

EXIT=1
```

已还原。**四层，四段转发，每一段各有一条单跑能杀掉它的具名测试。**

## 5. Step 5 —— 12d(iv) fixture 的构造与「确实到达 abandon 分支」的证据

四条约束逐条落地（测试 `runLoop > forwards onReconciliationWriteAbandoned from runLoopFromState down to writeBoundaryArtifacts`，`tests/controller/runLoop.integration.test.ts`）：

1. `initializeRunFiles` + `writeOwnerRecord` 写一份**合法**的 `owner-record.json`；目录里无 marker，测试就地断言 `expect(await pathExists(join(runDir, ".owner-transfer.transaction.json"))).toBe(false)`，所以 `recoverInterruptedOwnerTransfer` 早退、不会顺手覆盖 transfer。
2. `await writeFile(join(runDir, "owner-transfer.json"), "{ not json")` —— `readOwnerTransferRecordRaw` 的裸 `JSON.parse` 抛 `SyntaxError` → 非 ENOENT → fail-closed → abandon。
3. `ownerStatus: "lost"` ＋ adapter 在 worktree 里改文件（沿用同文件里那条 OWNER_UNDECIDABLE 测试的同一根杠杆）→ 判定 `OWNER_UNDECIDABLE`、takeover 拒绝 → 不走 `persistOwnerTransfer`，坏 JSON 不被覆盖。
4. `perAttemptTimeoutMs: 20` ＋ execute 等到 abort 后返回 `null` → 超时无结果 → `stale_candidate`；`eligibleForContinuation` 在这一支恒为 `false`（只有 transfer 成功那一支才置 true），所以 `preserveSuccessfulReconciliationIfNeeded` 不早退。

**它第一次构造就跑通了，四条约束全部成立。** 上面变异三的「注入前（绿）」那一块就是它的原始输出（`Tests 1 passed | 51 skipped (52)`，EXIT=0），因此**不需要**计划为「若它不被调用」预备的探针/上报路径。

测试里除了「回调被调用过」，还就地断言了两条使这次绿**不可能是巧合**的事实：

- `boundary-analysis.json` 的 `status` 确实是 `"stale_candidate"`（约束 4 的前置条件被证明，而不是假设）；
- `reconciliation-record.json` **不存在**——放弃是真的放弃，不是写穿之后顺手喊了一嗓子；
- `abandonments[0]` 含 `"JSON"`——传到操作员手里的就是那次读失败本身，穿过三层未被改写。

## 6. 三条守卫（原始输出）

```bash
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
exit=0

$ grep -rnF 'currentOwnerEpoch + 1' src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
exit=0

$ git status --porcelain src/registry/
exit=0
$ git diff --stat -- src/registry/
（无输出）
```

`evaluateResumeEligibility` 的八条判据计数仍为 **8**；`currentOwnerEpoch + 1` 仍是**单一命中**；`src/registry/` **零改动**。

## 7. 全套件 + typecheck + build（未过滤，带退出码）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 8ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 6ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 428ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 163ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 10ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 34ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 4ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 54ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/persistence/fileStore.test.ts (74 tests) 2279ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1780ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-vxKpE5/does-not-exist'

 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-SBVvNb/run-1  observed 2026-08-02T13:59:29.140Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 475ms
   ✓ parseArgs > returns 0 for the scripted example run 341ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 16ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 49ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 3586ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 310ms
   ✓ resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState 331ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 350ms
   ✓ resumeLoop > refuses while a killed run's lease is still fresh and stops refusing after the TTL 1143ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 3383ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 652ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 564ms
   ✓ render-contract CLI > rejects a non-git repository path 615ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 1542ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 4093ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 367ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 339ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 315ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 378ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 432ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 392ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 300ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 1411ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 3ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 418ms
   ✓ worktreeManager > creates and removes a detached worktree 417ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 680ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 678ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 7873ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 650ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 527ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 902ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 1026ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 515ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 408ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 423ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 360ms
 ✓ tests/controller/runLoop.integration.test.ts (52 tests) 12126ms
   ✓ runLoop > does not succeed when approved verification is missing required evidence 306ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 1190ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 390ms
   ✓ runLoop > stops immediately when a stopOn signal matches 377ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 759ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 13944ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 3316ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 493ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 447ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 407ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 442ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 436ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 405ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 412ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 416ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 407ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 404ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 401ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 404ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 1118ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 555ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 405ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 554ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 553ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 412ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 598ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 405ms
 ✓ tests/validation/evidence.test.ts (39 tests) 17113ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1403ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1461ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 3301ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1604ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1563ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1528ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 592ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 621ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 576ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 958ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 577ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2715ms

 Test Files  29 passed (29)
      Tests  481 passed (481)
   Start at  21:59:26
   Duration  17.72s (transform 2.23s, setup 0ms, collect 3.67s, tests 66.76s, environment 3ms, prepare 1.85s)

TEST_EXIT=0
```

`29 passed (29)` / `481 passed (481)`，TEST_EXIT=0。477（我这次跑的起点基线）＋ 4 条新增（fileStore 2 条、runLoop.integration 1 条、resumeLoop.integration 1 条）= 481，对得上。**两条允许的 flake（(B) `run-scenario CLI > records env names only...`、(F) `runLoop > continues normally when execute returns a complete result during the recovery window`）本次均未出现**，前者在上面的输出里可见为 `✓`。

上面这次全套件跑在提交前，之后我只改了 `fileStore.ts` 里一处**注释措辞**（把与 A7 既有注释重复的三行压成六行、不含任何可执行改动），并复跑了三个被改测试文件：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts tests/controller/runLoop.integration.test.ts tests/controller/resumeLoop.integration.test.ts"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (74 tests) 771ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 604ms
 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests) 1773ms
 ✓ tests/controller/runLoop.integration.test.ts (52 tests) 9138ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 822ms

 Test Files  3 passed (3)
      Tests  138 passed (138)
   Start at  22:00:23
   Duration  9.65s (transform 447ms, setup 0ms, collect 768ms, tests 11.68s, environment 0ms, prepare 139ms)

EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm run typecheck"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

## 8. 改动的文件

提交 `57da4b3`，6 files changed, 333 insertions(+), 7 deletions(-)：

- `src/persistence/fileStore.ts`（第三参 + 回调调用点）
- `src/controller/runLoop.ts`（第五参 + 两个 `persistBoundaryAnalysis` 调用点 + `RunLoopFromStateOptions` + 第七参 + 两个 `writeBoundaryArtifacts` 调用点）
- `src/controller/resumeLoop.ts`（`ResumeLoopOptions` + 第三参 + 一处转发）
- `tests/persistence/fileStore.test.ts`（12d(iii) 两条）
- `tests/controller/runLoop.integration.test.ts`（12d(iv) 一条 + 两处 import）
- `tests/controller/resumeLoop.integration.test.ts`（**计划外，见 §4 变异五**：第四层的覆盖，一条）

提交命令用的是计划给的那一条，**只多加了第六个文件** `tests/controller/resumeLoop.integration.test.ts`。commit message 逐字未改。

## 9. 自查

- **四层是否全可选？** 是。四处都是 `?`，四个返回类型一个字节未改；既有调用点（`resumeLoop` 14 处、`writeBoundaryArtifacts` 测试里 15 处、`src/` 里 2 处）一处未改，整套件 481 全绿即为证。
- **是否新增了「许可」？** 没有。本任务只加了一条**观察通道**：`writeBoundaryArtifacts` 的判定逻辑、`preserveSuccessfulReconciliationIfNeeded` 的 fail-closed、`persistBoundaryAnalysis` 的两次 `assertHeld`，全部逐字未动。abandon 分支该放弃的仍然放弃（12d(iv) 就地断言 `reconciliation-record.json` 不存在）。
- **A7 的 swallow 是否原样？** 是。`git diff` 对 `fileStore.ts` 只有插入、零删除；变异二注入后已逐字还原。**没有**为了给「回调排在前面」凑一条杀伤变异而拿掉 swallow——那条排序在报告与代码注释里都写明「没有配套杀伤变异，是纵深防御」。
- **三条守卫**：8 / 单一命中 / `src/registry/` 零改动，见 §6。
- **`ReconciliationWriteDecision`**：回调签名是 `(detail: string) => void`，本任务**不需要**这个类型，因此它仍**未导出**，我也没有绕路去用它。这一点保持原状。
- **`persistBoundaryAnalysis` 的两条 18 行 reconciliation 字面量**：一行未碰，未合并，也未把重复弄得更糟。
- **S-3 安全阀**：未命中。没有新增静默失败模式（回调**刻意不包** try/catch），`finalizePendingOwnerTransfer` 的 catch 语义一个字节未改。
- **行号引用扫描**：`grep -rnE 'fileStore\.ts:[0-9]+|runLoop\.ts:[0-9]+|resumeLoop\.ts:[0-9]+' docs/ src/ tests/` 命中的全部是 `docs/superpowers/plans/` 下的历史计划文档（**需要正则：只看输出行，退出码不作为论据**）。按 `docs/handoff/handoff.md:201` 已下的立场——历史过程记录按不可改写处理、就地勘误不改原件——一条未动。本次改动确实会让其中一部分继续位移，与该立场一致，**不视为本任务的遗留缺陷，但在此显式记录**。

## 10. 关切（交给评审员与后续任务）

1. **`persistBoundaryAnalysis` 的第二个调用点（`execution === null`、补 `undefined` 占位那一处）没有测试覆盖。** 我 12d(iv) 的 fixture 走的是 execute 超时那一支，也就是第一个调用点；针对第二个调用点单独删掉转发，全套件会保持绿。要覆盖它需要构造「execute 未超时却返回 null」且同时到达 abandon 分支的盘面（该路径随后必抛 `execute phase completed without a result`），我判断其构造成本与本任务的剩余预算不相称，**因此如实上报而不是悄悄留白**。计划只点名「两个调用点都要改」（已做到），没有要求各自单独钉住。
2. **「回调排在 `appendEvent` 之前」没有杀伤变异**，这是计划自己预判并允许的（等价变异），已在代码注释与本报告两处写明。若将来有人去掉 swallow，这条排序就变成承重的了，届时应补一条变异。
3. **`runLoop`（非 `runLoopFromState`）没有开放这个通道。** 计划未要求，B2/C1 的消费路径也是 `resumeLoop` / `runLoopFromState`。若组 C 需要从 `runLoop` 侧注入，需另加一个可选参数对象——形状与本任务两处一致即可。
4. **第 4 层测试落在第三个测试文件** `tests/controller/resumeLoop.integration.test.ts`（计划的 Files 只列了两个测试文件）。理由见 §4 变异五：Global Constraint「加一个成分和加它的覆盖是一件事」优先。该文件的 `seedEligibleRun` fixture 是现成的，改动是纯新增一条 `it`，未触碰任何既有测试。
5. **变异二用真实 `EISDIR` 取代计划写的「mock `appendEvent`」**，理由见 §4 该节末尾（模块内直接调用无法被模块级 mock 拦截）。这是本任务对计划字面的第二处、也是最后一处偏离。

---

# 修复波 1 报告（A8 fix round 1 of 5）

提交 `56eb6e3`（接在 `57da4b3` 之后）。验证方式同前：先 `export ECC_GATEGUARD=off DISABLE_OMC=1`，再 `rtk proxy "<command>"` 绕过全局 rtk 过滤 hook；输出未过滤、未截断，每条命令回显退出码。

## 结论先行

**Important 那一条我没有按要求补上覆盖测试，因为那条覆盖是不可构造的——不是笨拙，是不可能。** 协调者明确要求「若确实不可行，停下来说明原因，不要拿更弱的东西替代」，所以本轮我：**证明了不可达（读码 + 实测双证）、做了 fold-in、把证明就地写进代码注释，并且没有添加任何替代性的弱断言。**

Fold-in 已按要求完成。

## 1. Important —— 第二个调用点的转发在今天的代码里**可证不可达**

争议点：`src/controller/runLoop.ts` 的 `runLoopFromState` 里 `if (execution === null)` 那一支（`executeOutcome.timedOut` 为 **false** 时到达）的
`await persistBoundaryAnalysis(runDir, state, heartbeat, undefined, options?.onReconciliationWriteAbandoned);`。

评审员说它是「a distinct, reachable production path」——**这一半完全正确，我实测确认了**。但「可达」与「回调可能被调用」是两件事。回调在这条路径上**永远不会被调用**，无论 fixture 怎么构造。

### 1.1 读码证明（五步，每一步都与 fixture 无关）

1. 该调用点把 `executionRecovery` 传成**字面 `undefined`**。
2. `persistBoundaryAnalysis` 里 `buildBoundaryEvidence(executionRecovery ?? null)` → `buildBoundaryEvidence(null)`。该函数对 `null` 的分支（`runLoop.ts:551-560`）**无条件**返回 `{ continuitySuspicion: [], conflictingEvidence: [], ... }`——不读任何其他输入，因此不可能被 fixture 改变。
3. `evaluateRunBoundary({ observedStrongProgress: false, observedWeakProgress: conflictingEvidence.length > 0 → false, continuitySuspicion: [] })`：三个提前 return 全部不命中（`stopController.ts:21` `:31` `:41`），落到最后一个 return → 状态 **`no_progress`**，不是 `stale_candidate`。
4. `nextOwnerEpoch` 只可能在 `boundaryAnalysis.status === "stale_candidate"` 的守卫内变成非 null（`runLoop.ts:786`），所以这里恒为 null → 走 `else` 分支；`else` 分支的 `reconciliationRecord` 是 `status === "stale_candidate" ? {...} : undefined` → **`undefined`**。
5. `writeBoundaryArtifacts` 的 `if (artifacts.reconciliationRecord !== undefined)` 整块被跳过 → 不产生 decision、不进 abandon、**不调回调**。

第 2 步是关键：只要 `executionRecovery` 是 `undefined`，证据就是空的，而这条调用点**在源码里写死了 `undefined`**。所以不存在能翻转结论的磁盘状态、adapter 行为或契约参数。

### 1.2 实测证明（不是只靠推理）

我写了一条一次性探针（**未提交**，测完已删除），用 12d(iv) 的同一套盘面（合法 owner-record、**坏 JSON 的 `owner-transfer.json`**、无 marker），但把 adapter 的 `execute` 改成**立即返回 `null`**（`perAttemptTimeoutMs: 5000`，因此不超时），从而精确落在这条分支上。

第一次跑先确认了这条分支**确实被走到**（我原以为会抛出，实际是被 `runLoopFromState` 的外层 catch 收成终态）：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'PROBE second call site reachability'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/controller/runLoop.integration.test.ts (53 tests | 1 failed | 52 skipped) 162ms
   × runLoop > PROBE second call site reachability 161ms
     → promise resolved "{ status: 'failed', …(7) }" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/controller/runLoop.integration.test.ts > runLoop > PROBE second call site reachability
AssertionError: promise resolved "{ status: 'failed', …(7) }" instead of rejecting

- Expected
+ Received

- [Error: rejected promise]
+ Object {
+   "attemptsUsed": 1,
+   "budgetSnapshot": Object {
+     "attemptsRemaining": 2,
+     "timeRemainingMs": 5000,
+     "tokenBudgetRemaining": 1000,
+   },
+   "currentAttempt": 1,
+   "lastTransitionAt": "2026-08-02T14:12:00.501Z",
+   "recentFailures": Array [],
+   "status": "failed",
+   "stopReason": "Error: execute phase completed without a result",
+   "waitingOnHuman": false,
+ }

 ❯ tests/controller/runLoop.integration.test.ts:1373:5
    1371|         onReconciliationWriteAbandoned: (detail) => abandonments.push(…
    1372|       }),
    1373|     ).rejects.toThrow("execute phase completed without a result");
       |     ^
    1374|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 52 skipped (53)
   Start at  22:11:59
   Duration  676ms (transform 202ms, setup 0ms, collect 231ms, tests 162ms, environment 0ms, prepare 58ms)

EXIT=1
```

`stopReason: "Error: execute phase completed without a result"` —— 这正是该分支紧随 `persistBoundaryAnalysis` 之后抛的那句话，**因此分支确实执行了**。改成读取观测值后：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/runLoop.integration.test.ts -t 'PROBE second call site reachability'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

stdout | tests/controller/runLoop.integration.test.ts > runLoop > PROBE second call site reachability
PROBE stopReason: Error: execute phase completed without a result
PROBE boundary status: no_progress
PROBE abandonments: []
PROBE reconciliation exists: false

 ✓ tests/controller/runLoop.integration.test.ts (53 tests | 52 skipped) 167ms

 Test Files  1 passed (1)
      Tests  1 passed | 52 skipped (53)
   Start at  22:12:10
   Duration  711ms (transform 223ms, setup 0ms, collect 261ms, tests 167ms, environment 0ms, prepare 42ms)

EXIT=0
```

四个观测与读码证明逐条对上：分支被执行（`stopReason`）、边界状态是 **`no_progress`** 而非 `stale_candidate`、**回调零次调用**（`abandonments: []`，尽管盘上就躺着一份坏 JSON 的 `owner-transfer.json`）、reconciliation 从未被写。

### 1.3 所以我做了什么、没做什么

- **没做**：没有添加任何测试去「覆盖」这条转发。能写出来的只有「断言回调**不**被调用」，那是把一条恒真的空话钉进套件，正是协调者不要的更弱替代品，也违反 Rule 9（业务逻辑变了它也不会红——恰恰相反，它只有在有人**修好**这条路径时才会红，方向是反的）。
- **没做**：没有删掉那个转发实参。计划 §9 点名两个调用点都要改成 `(runDir, state, heartbeat, undefined, cb)`，删掉它是违反 brief。
- **做了**：把上面这套证明（含「实测，非仅推理」一句与三个观测值）压成 10 行注释写在**那一行的正上方**，并写明触发条件——「若将来有人让这条分支拿到真的 execution recovery，这条路径就活了，届时必须补覆盖」。这不是覆盖的替代品，是对一个今天可证无效的实参的诚实标注，与我在 `nextOwnerEpoch !== null` 那个 `writeBoundaryArtifacts` 调用点已经用过的同一处理方式一致。

**请协调者裁定**：若认为「可证不可达的实参」仍需一条钉住其不可达性的 pinning test（例如断言这条分支产出 `no_progress`，从而在有人把它变活时变红、提醒补测），我可以加；但那是**另一条断言**，不是被要求的那条覆盖，所以我不擅自替代。

## 2. Fold-in（已完成）

`resumeLoop > forwards onReconciliationWriteAbandoned into the resumed runLoopFromState` 补了 fixture 前置条件断言，与姊妹测试 12d(iv) 的严谨度对齐：

- (a) `boundary-analysis.json` 的 `status` 确实是 `"stale_candidate"`——即确实有 reconciliation 记录被传下去，否则 `writeBoundaryArtifacts` 会整块跳过；
- (b) 放弃是真的：`reconciliation-record.json` 仍是 `seedEligibleRun` 播下的**赢家**那一份（`newOwnerEpoch: 2`、`eligibleForContinuation: true`），没有被本进程那份 `eligibleForContinuation: false` 的输家视图覆盖。

**与姊妹测试的差异是刻意的**：12d(iv) 断言该文件**不存在**，这里断言它**未被改写**——因为 `seedEligibleRun` 本来就会写一份合法的 reconciliation（那正是 resume 资格的一部分），所以「不存在」在这个 fixture 上是错的断言。(b) 因此比「不存在」更强：它证明保护动作救下了一份具体的、可辨认的记录。

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/controller/resumeLoop.integration.test.ts -t 'forwards onReconciliationWriteAbandoned into the resumed runLoopFromState'"
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/controller/resumeLoop.integration.test.ts (12 tests | 11 skipped) 209ms

 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
   Start at  22:12:43
   Duration  578ms (transform 102ms, setup 0ms, collect 127ms, tests 209ms, environment 0ms, prepare 39ms)

EXIT=0
```

`Tests 1 passed | 11 skipped (12)` —— 具名那条计数非零，非零匹配。

## 3. 三条守卫（本轮重跑，原始输出）

```bash
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8
guard1_exit=0

$ grep -rnF 'currentOwnerEpoch + 1' src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
guard2_exit=0

$ git status --porcelain src/registry/
guard3_exit=0
```

八条判据仍为 **8**；`currentOwnerEpoch + 1` 仍是单一命中；`src/registry/` 仍零改动（`git status --porcelain` 无输出行）。

## 4. 全套件 + typecheck + build（本轮重跑）

```
 Test Files  29 passed (29)
      Tests  481 passed (481)
   Start at  22:13:04
   Duration  17.02s (transform 2.23s, setup 0ms, collect 3.51s, tests 57.96s, environment 4ms, prepare 1.79s)

TEST_EXIT=0
```

（上面这段是本轮全套件跑输出的末尾摘要；完整未过滤输出见本轮会话记录——29 个测试文件逐个 `✓`，无 `×`，无 skip。两条允许的 flake 本轮均未出现：(B) `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid` 显示为 `✓ ... 2642ms`，(F) 未报失败。）

测试数仍是 **481**：本轮只增加断言与注释，未增删测试用例（探针已删除）。

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm run typecheck"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0

$ rtk proxy "npm run build"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

## 5. 本轮改动的文件

提交 `56eb6e3`，2 files changed, 26 insertions(+)，零删除：

- `src/controller/runLoop.ts`：第二个 `persistBoundaryAnalysis` 调用点上方 10 行注释（不可达性证明 + 复活条件）。**无可执行改动。**
- `tests/controller/resumeLoop.integration.test.ts`：fold-in 的两组断言（16 行）。

探针测试写入后已完整删除，未进入任何提交（`grep -c PROBE tests/controller/runLoop.integration.test.ts` 为 0——本轮 `git diff --stat` 里 `runLoop.integration.test.ts` 不在列即为证）。

## 6. 本轮的关切

1. **第二个调用点的转发实参今天是死代码（对回调而言）。** 我保留它是因为 brief §9 点名，但它在 §1 的意义上不可测。这既是对评审员 Important 的正面回应，也是一个**新披露**：评审员判断它「a live path」——路径确实 live，但**这个实参**不 live。若协调者更希望「不留不可测的实参」，正确的动作是回到计划、修改 §9 对这个调用点的要求，而不是在本层就地删掉它。
2. 上一轮的关切 2（正是本条）由此升级为已定性：不是「构造成本不相称」，而是**不可构造**。上一轮报告 §10 第 2 条的措辞（「构造成本与预算不相称」）**低估了问题**，本轮予以更正。
3. 其余关切（排序无杀伤变异、`runLoop` 未开放通道、第四层测试落在第三个测试文件、`EISDIR` 取代 mock）维持上一轮结论，未变。
