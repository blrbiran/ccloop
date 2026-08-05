# L5 输入盘点 —— 切片 C：无退避重捡 + 三道门追加的交接项

只读盘点。仓库 `/Users/biran/code/skills/loop/ccloop`，分支 `main`，HEAD `e9021ef`，工作区干净（`git status --porcelain` 输出为空，`git log --oneline -1` 输出 `e9021ef docs(handoff): retarget at 'L3 is complete, three gates merged, next is push and L5'`）。

本次扫描**没有**修改 `src/` / `tests/` / `docs/` / 任何 spec / plan / ledger。唯一写入的文件是本报告。

**完整度声明（先说结论）**：项 A、B、C、D 完整；项 E 部分完整，缺口在本节内逐条标注。

### 项 B：`resumeLoop` 的并发裸读（C4 的发现）

**本项完整。**

#### 原文出处

`.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md`，`STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED:` 段（GATE-C MERGED 之前那一节）。逐字：

> ```
> STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED:
>   - The `resumeLoop` concurrent bare reads (C4's discovery): five artifacts read
>     in one Promise.all with only readOwnerRecord preceded by recovery. Measured
>     consequence: ONE retryable refusal plus a healthy run reported as `error` on
>     stderr — a false alarm, i.e. an operability defect, not data loss. CARRIED TO
>     L5 with the grading evidence attached.
> ```

同文件 `*** C4's TESTS FOUND A PRODUCTION PROPERTY NOBODY HAD RECORDED. ***` 段，逐字：

> ```
> *** C4's TESTS FOUND A PRODUCTION PROPERTY NOBODY HAD RECORDED. *** resumeLoop
> reads five artifacts CONCURRENTLY in one Promise.all, and only readOwnerRecord
> runs recoverInterruptedOwnerTransfer first; readOwnerTransferRecord,
> readReconciliationRecord and readRunState are bare reads racing finalize's
> rename. The implementer hit it while writing 14b, restructured the test to avoid
> the nondeterminism, DID NOT TOUCH PRODUCTION CODE, and escalated.
>
>   THE REVIEWER CONSTRUCTED IT RATHER THAN REASONED ABOUT IT, and corrected the
>   implementer's wording in the process:
>     - Real: with a marker plus three pendings staged and reconciliation-record
>       .json never published, a real sweep produces `cannot read run artifacts:
>       … ENOENT`.
>     - CORRECTION: sweep classifies it as `error`, NOT `refused` — classifyThrow's
>       prefix arm wins — so the line goes to stderr while the exit code stays 0.
>     - *** IT IS A RETRYABLE REFUSAL, NOT A LOST RUN, AND THIS WAS MEASURED. ***
>       Promise.all's rejection does not cancel the readOwnerRecord chain: 300ms
>       after sweep #1 returned, the marker was gone, epoch had rotated to 2 and the
>       reconciliation record was published; sweep #2 then reached `succeeded`.
>       cli.ts only calls process.exit on a DOUBLE SIGINT, so the pending fs work
>       drains normally. Cost = one wasted sweep slot plus a misleading `error`
>       line that reports a healthy run as a failure. NOT data loss.
>     - It does NOT conflict with group A's transaction invariants: recovery still
>       goes marker-first through finalizePendingOwnerTransfer with
>       isValidFinalizeOrder validating the full permutation before any read, write
>       or unlink. This is resumeLoop's READ-SIDE ordering, a sibling of L2 §7.1's
>       registry-side protection which resume never got.
>   CARRIED TO GATE-C AS AN INDEPENDENT DEFECT ITEM FOR HUMAN RULING. It did not
>   block C4, which is Test-only and correctly refused to fix it.
> ```

同目录 `gate-c-lane2-report.md` §4.2「独立条目 1 —— `resumeLoop` 的并发裸读」给出了 lane 2 自己的分级理由，其中一句是这条分级的**加重项**，逐字：

> **但我要给这条加一句评审员没说、而它改变分级理由的事实**：因为 `classifyThrow` 的前缀支路优先，这个**健康的** run 被分类为 `error` 并写到 **stderr**——而 C3 整个设计意图就是「stderr 是 cron 的告警通道」（R2.1 的勘误原话：「可见性由 stderr 独家兑现」）。**于是一次瞬时、自愈的竞争会产生一次假告警（false page）。** 这不只是「一条误导性的 `error` 行」，是一处**可运维性缺陷**。L5 条目应当按这个措辞记，否则承接方会低估它。

#### 今天的落点（符号锚点）

| 符号 | 文件 | 角色 |
|---|---|---|
| `resumeLoop` 里的 `Promise.all` | `src/controller/resumeLoop.ts` | 五份 artifact 的并发读点 |
| `readOwnerRecord` | `src/persistence/fileStore.ts` | **唯一**前置 recovery 的读 |
| `readOwnerTransferRecord` / `readReconciliationRecord` / `readRunState` | `src/persistence/fileStore.ts` | 裸 `readFile` + `JSON.parse` |
| `loadContract` | `src/contract/loadContract.ts` | 第五份，裸 `readFile` + `JSON.parse` + zod |
| `recoverInterruptedOwnerTransfer` | `src/persistence/fileStore.ts`（模块私有） | recovery 本体 |
| `readOwnerRecordWithoutRecovery` | `src/persistence/fileStore.ts` | L2 §7.1 给 registry 侧的保护版本，resume 侧没用 |
| `classifyThrow` | `src/sweep/sweepRuns.ts` | 把 `cannot read run artifacts:` 前缀路由到 `error`/stderr |
| `registerStopHandlers` | `src/cli.ts` | `process.exit` 的唯一默认来源，`received >= 2` 才触发 |

#### 重推命令与当时输出

命令 1（读 `src/controller/resumeLoop.ts` 的 `Promise.all` 块，Read 工具，136–146 行原样）：

```
136	    [ownerRecord, ownerTransfer, reconciliation, runState, contract] = await Promise.all([
137	      readOwnerRecord(runDir),
138	      readOwnerTransferRecord(runDir),
139	      readReconciliationRecord(runDir),
140	      readRunState(runDir),
141	      loadContract(join(runDir, "loop-contract.json")),
142	    ]);
143	  } catch (error) {
144	    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: `cannot read run artifacts: ${String(error)}` });
145	    throw new ResumeNotEligibleError(`cannot read run artifacts: ${String(error)}`);
146	  }
```

命令 2：

```
$ rtk proxy grep -n "recoverInterruptedOwnerTransfer" src/persistence/fileStore.ts src/controller/resumeLoop.ts src/registry/*.ts; echo "---EXIT=$?"
src/persistence/fileStore.ts:366:      // recoverInterruptedOwnerTransfer side effect. Deliberate, and not a behavior loss: when the
src/persistence/fileStore.ts:711:// unlocked recoverInterruptedOwnerTransfer / tryRecoverStaleOwnerTransferLock path — so a subclass
src/persistence/fileStore.ts:1007:async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
src/persistence/fileStore.ts:1025:  await recoverInterruptedOwnerTransfer(runDir);
src/persistence/fileStore.ts:1039:    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
src/persistence/fileStore.ts:1082:    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
src/persistence/fileStore.ts:1095:// §7.1: the gate's read. readOwnerRecord runs recoverInterruptedOwnerTransfer first, which
src/persistence/fileStore.ts:1131:    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
---EXIT=0
```

`src/controller/resumeLoop.ts` 与 `src/registry/*.ts` **零命中** —— recovery 不在 resume 侧、也不在 registry 侧的这几个读上。

命令 3（五个读函数的函数体）：

```
$ rtk proxy grep -n "export async function readOwnerRecord\|export async function readOwnerTransferRecord\|export async function readReconciliationRecord\|export async function readRunState\|export async function readOwnerRecordWithoutRecovery" -A 10 src/persistence/fileStore.ts
1024:export async function readOwnerRecord(runDir: string): Promise<OwnerRecord> {
1025-  await recoverInterruptedOwnerTransfer(runDir);
1026-  return readOwnerRecordRaw(runDir);
1027-}
1028-
1029-export async function writeOwnerTransferArtifacts(
1030-  runDir: string,
1031-  expectedOwnerRecord: OwnerRecord,
1032-  ownerRecord: OwnerRecord,
1033-  transferRecord: OwnerTransferRecord,
1034-  reconciliationRecord?: ReconciliationRecord,
--
1099:export async function readOwnerRecordWithoutRecovery(runDir: string): Promise<OwnerRecord> {
1100-  return readOwnerRecordRaw(runDir);
1101-}
1102-
1103-async function writeOwnerRecordAtomically(runDir: string, ownerRecord: OwnerRecord): Promise<void> {
1104-  const { ownerPath, ownerTempPath } = getOwnerTransferPaths(runDir);
1105-  await safeUnlink(ownerTempPath);
1106-  await writeJsonFile(ownerTempPath, ownerRecord);
1107-  await rename(ownerTempPath, ownerPath);
1108-}
1109-
--
1180:export async function readRunState(runDir: string): Promise<RunState> {
1181-  return JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
1182-}
1183-
1184:export async function readOwnerTransferRecord(runDir: string): Promise<OwnerTransferRecord> {
1185-  return JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_FILE), "utf8")) as OwnerTransferRecord;
1186-}
1187-
1188:export async function readReconciliationRecord(runDir: string): Promise<ReconciliationRecord> {
1189-  return JSON.parse(await readFile(join(runDir, "reconciliation-record.json"), "utf8")) as ReconciliationRecord;
1190-}
1191-
1192-export async function writeAttemptArtifacts(runDir: string, attempt: number, artifacts: AttemptArtifacts): Promise<void> {
1193-  const attemptDir = join(runDir, "attempts", String(attempt));
1194-  await mkdir(attemptDir, { recursive: true });
1195-  await writeFile(join(attemptDir, "plan.json"), JSON.stringify(artifacts.plan, null, 2));
1196-
1197-  if (artifacts.execution !== undefined) {
```

命令 4（第五份 artifact）：

```
$ rtk proxy grep -n "export async function loadContract" -A 12 src/contract/loadContract.ts
4:export async function loadContract(filePath: string): Promise<LoopContract> {
5-  const rawText = await readFile(filePath, "utf8");
6-  const rawJson = JSON.parse(rawText) as unknown;
7-  return loopContractSchema.parse(rawJson);
8-}
```

命令 5（分级里「只有双击才 `process.exit`」这一半）：

```
$ rtk proxy grep -n "process.exit\|registerStopHandlers" src/cli.ts; echo "---EXIT=$?"
170:export function registerStopHandlers(
174:  const exit = options?.exit ?? ((code: number) => process.exit(code));
224:      const unregisterStopHandlers = registerStopHandlers(stopRequested);
237:        unregisterStopHandlers();
257:    process.exitCode = code;
---EXIT=0
```

`registerStopHandlers` 本体（Read，175–192 行原样）：

```
175	  let received = 0;
176	
177	  const handle = () => {
178	    received += 1;
179	    signal.requested = true;
180	    if (received >= 2) {
181	      exit(130);
182	    }
183	  };
```

#### 今天是否可达 / 是否仍成立

**五份 artifact 的形状：仍然精确成立。** 一个 `Promise.all`，五个读，只有 `readOwnerRecord` 在 `fileStore.ts:1025` 前置 `recoverInterruptedOwnerTransfer`；其余四个（`readOwnerTransferRecord` `:1185`、`readReconciliationRecord` `:1189`、`readRunState` `:1181`、`loadContract` `:5`）都是裸 `readFile` + `JSON.parse`，没有任何 recovery、没有任何锁。

**台账原文说的是「三个裸读」**（`readOwnerTransferRecord` / `readReconciliationRecord` / `readRunState`），**没有把 `loadContract` 算进裸读**。今天 `loadContract` 同样是裸 `readFile`。它读的是 `loop-contract.json`，而 `finalizePendingOwnerTransfer` 的 rename 集合不含该文件 —— 所以把它排除在「与 finalize 竞争」之外是**有理由的**，不是遗漏。**但 L5 的承接方需要知道裸读实际是四个、与 finalize 竞争的是三个**，这两个数字不同。这一点原样上报，我不改台账的措辞。

**可达性构造（沿用 C4 评审员构造的那一条，符号形式）**：在一个 run 目录里 staged 一个 owner-transfer marker 加三份 pending，且 `reconciliation-record.json` 从未 publish；对该目录跑一次真实 sweep。`readOwnerRecord` 进入 recovery 并开始 finalize（marker-first，`isValidFinalizeOrder` 先校验整个 permutation），而同一 tick 里发出的 `readReconciliationRecord` 打在尚未 publish 的路径上 → ENOENT → `Promise.all` reject → `resumeLoop.ts:144/145` 记 `resume_denied` 并抛 `ResumeNotEligibleError("cannot read run artifacts: …")` → `sweepRuns.ts` 的 `classifyThrow` 前缀支路命中 → `outcome: "error"` → `sink = options.stderr`。

#### 论据是否腐坏

逐条核对台账那段分级的每一条论据：

1. 「五份 artifact 在一个 `Promise.all` 里」—— **成立**（`resumeLoop.ts:136-142`）。
2. 「只有 `readOwnerRecord` 前置 recovery」—— **成立**（`fileStore.ts:1024-1027`，且 `resumeLoop.ts` 里 `recoverInterruptedOwnerTransfer` 零命中）。
3. 「classifyThrow 的前缀支路优先，分类为 `error` 而不是 `refused`」—— **成立**。`sweepRuns.ts` 的 `classifyThrow` 里 `if (error instanceof ResumeNotEligibleError && message.startsWith("cannot read run artifacts:"))` 排在 `if (error instanceof ResumeNotEligibleError || error instanceof RunLeaseHeldError)` 之前；该函数注释自己写着「The prefix test comes FIRST」。
4. 「行走 stderr 而 exit code 仍是 0」—— **成立**。`sweepRuns` 里 `const sink = report.outcome === "error" ? options.stderr : options.stdout;`，而函数末尾无条件 `return 0`（唯一的非零 return 是 rootFailure 那条 `return 1`）。
5. 「`cli.ts` 只在双击 SIGINT 时 `process.exit`，所以 pending 的 fs 工作正常排空」—— **论据部分腐坏，结论不变**。今天 `registerStopHandlers` 的计数器是**跨 SIGINT 与 SIGTERM 共用一个 `received`**（`cli.ts:163-166` 的注释明写「ONE counter across both signals」，`:177-183` 是 `received >= 2` 才 `exit(130)`）。所以准确表述是「**任意两次停机信号**（SIGINT/SIGTERM 任意组合）才 `process.exit`」，不是「双击 SIGINT」。这**加强**而不是削弱结论：单次信号不退出，pending fs 工作照样排空。
6. 「不与组 A 的事务不变量冲突，recovery 仍是 marker-first 经 `finalizePendingOwnerTransfer` 且 `isValidFinalizeOrder` 先校验」—— **本次未逐行复核 `finalizePendingOwnerTransfer` 与 `isValidFinalizeOrder` 的函数体**。我核实的只有「recovery 挂在 `readOwnerRecord` 前面」这一半。见下面「我不确定的地方」。

#### 后果分级

**假告警（可运维性缺陷）＋ 一次可重试拒绝。不是数据丢失。这个分级今天仍然成立。**

据以分级的证据，逐条：

- **不是数据丢失**：这条路径上 `resumeLoop` 在 `Promise.all` reject 之后立刻 `throw`，**在 `claimOwnerRecordWithPrecondition` 之前**（CAS 在 `:161`，抛出点在 `:145`），也在 `startLeaseHeartbeat`（`:185`）之前。也就是说这次失败**没有任何写**除了 `events.jsonl` 上的 `resume_requested` + `resume_denied` 两行追加。run 状态、owner record、reconciliation record 一个字节都没被改。
- **可重试**：`Promise.all` 的 reject 不取消已经发出的 `readOwnerRecord` 链（Node 语义），recovery 照常跑完；下一次 sweep 看到的是 finalize 之后的目录。台账记录的是一次实测（300ms 后 marker 消失、epoch 转到 2、reconciliation record 已发布，sweep #2 直达 `succeeded`）——**这条实测我本次没有重跑**，见「我不确定的地方」。
- **假告警**：`sink` 选 `options.stderr`，而 `cli.ts` 的 sweep 分支把 `stderr` 接到 `console.error`；C3 的整个设计意图是「stderr 是 cron 的告警通道」。一个**健康的、下一轮就能成功的** run 在这一轮被写成 `error` 行，是一次会真的把人叫醒的误报。
- **`--max-runs` 配额没有被消耗**：`onAdopted` 在 `resumeLoop.ts:178`，在抛出点之后，所以这次失败**不计配额**（sweepRuns 的 `adopted` 不增）。但 `attempted` 会 +1（`sweepRuns` 在 try 之前 `attempted += 1`）。所以台账说的「一次浪费的 sweep slot」准确的是「一次浪费的 `attempted`」而非「一次浪费的配额」。原样上报，不改台账。

**我不改这个分级。** 我找到的所有证据都指向同一个方向；上面第 5 条是论据的措辞腐坏而非结论腐坏，第 6 条是我没查。

#### 我不确定的地方

1. **没有重跑 C4 的那次 300ms 实测。** 「sweep #2 直达 `succeeded`」这条最关键的「可重试」证据，我是从台账与 lane 2 报告里逐字引用的，**不是我自己测的**。L5 的承接方如果要把优先级压低到「假告警」，应当自己重跑一次。
2. **没有逐行核对 `finalizePendingOwnerTransfer` / `isValidFinalizeOrder`**，所以「不与组 A 的事务不变量冲突」这半条我无法独立确认。
3. **没有确认 `zeroWrite.test.ts:668`**（lane 2 §4.2 说 C4 的红原始输出在那一行）今天是否还在那个行号上 —— 这属于 C4-M2 那一族的行号腐坏，见项 E。
4. **没有测量这条竞争在真实 sweep 里的发生频率。** lane 2 说「sweep 改变的只是撞上它的频率」，我没有任何数据支持或反驳这句。

### 项 D：两句论据腐坏的 spec 表述（「一次数组 push」）

**本项完整。**

#### 原文出处

`progress.md` 的 `STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED:` 段，第二条，逐字：

> ```
>   - The same-family spec sentences at spec:692 and spec:751 (and their copy at
>     plan:1004) still cite "a single array push" as a PREMISE. Their CONCLUSIONS
>     still hold — spec:751's argument survives an injected stderr sink — so only
>     the supporting wording is stale. Named for L5; the controller did not widen
>     the round to take them.
> ```

#### 今天的落点（用内容定位，不用行号）

定位命令与完整输出：

```
$ rtk proxy grep -n "push" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md; echo "---EXIT=$?"
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:681:| `sweep.sweepRuns` | — | 为**当前这个 run** 传一个闭包，把 `{ path, detail }` push 进本次 sweep 的备注数组 | 见下面的「回调不得抛出」 |
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:692:**回调不得抛出，且本层刻意不给它包 try/catch。** 它若抛出，会从 `writeBoundaryArtifacts` 一路逃到 `runLoopFromState`，把一次保护性放弃升级成 attempt 失败——**正是人裁明令禁止的那件事**。包一层 `try{}catch{}` 会静默吞掉它，违反 Rule 12。**本层的处置是把「不得抛出」定成回调的契约，并把 sweep 侧的实现定死为一次数组 push（不做 I/O、不格式化）**，使违约成为一个显眼的编程错误而不是一条被吞的异常。
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:751:**⚠️ 为什么 `appendEvent` 吞、而回调不吞（两者危险同构，处置却相反 —— 理由第六波补写）**：`writeBoundaryArtifacts` 在本层新增的写/追加动作恰好只有这两个。差别在**谁能修好它**：回调的实现**在本层的控制范围内**（§9 已把它定死为一次数组 push，不做 I/O），所以它抛出只可能是**编程错误**，必须显眼地炸出来；`appendFile` 的 I/O **不在**任何人的控制范围内，它抛出是**环境事实**，把它炸成 attempt failed 只是用一个更大的错误盖住一个更小的。**第五波把两者一个判成待修缺陷、一个判成契约而没写理由，这一段是补的那个理由。**
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1570:| `src/sweep/sweepRuns.ts` | 扫描 → `scanRootFailureDetail` 判据 → 过滤 → 排序 → **按 `--max-runs` 截断遍历（计数由 `onAdopted` 驱动，§6）** → 顺序续跑 → **按 `cannot read run artifacts:` 前缀把读侧失败路由到 `error`/stderr（§8）** → **为每个 run 传 `onReconciliationWriteAbandoned` 回调、把回调收到的记录按 `note` 行打到 stderr（§4.3 第五波人裁、§8）** → 汇报。**纯函数，接收信号槽与配额 N，自身无 writer、不装信号处理器。回调的实现定死为一次数组 push，不做 I/O、不得抛出** |
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1578:**Amended 2026-08-05：上表 `src/sweep/sweepRuns.ts` 那一行末尾的「回调的实现定死为一次数组 push，不做 I/O」已被人裁推翻——回调改为在其中*当场* `options.stderr(...)`，折行也在回调里当场做。** ……（下略，见文件）
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:150:- **push 与 merge 都只在人明确下指令时执行。** 本计划里的「提交」一律指本地 commit。
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:876:**为什么 `appendEvent` 吞而回调不吞（两者危险同构、处置相反，理由必须写进注释）**：差别在**谁能修好它**。回调的实现**在本层控制范围内**（§9 定死为一次数组 push，不做 I/O），所以它抛出只可能是**编程错误**，必须显眼地炸出来；`appendFile` 的 I/O **不在**任何人的控制范围内，它抛出是**环境事实**，把它炸成 attempt failed 只是用一个更大的错误盖住一个更小的。
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1004:**回调不得抛出，且本层刻意不给它包 try/catch。** 它若抛出会从 `writeBoundaryArtifacts` 一路逃到 `runLoopFromState`，把一次保护性放弃升级成 attempt 失败——正是人裁明令禁止的那件事。**包一层 `try{}catch{}` 会静默吞掉它，违反 Rule 12。** 本层的处置是把「不得抛出」定成**回调的契约**，并把 sweep 侧的实现定死为**一次数组 push**（不做 I/O、不格式化），使违约成为一个**显眼的编程错误**而不是一条被吞的异常。
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1717:- **回调的实现定死为一次数组 push**（把 `{ path, detail }` 推进本次 sweep 的备注数组），**不做 I/O、不格式化、不得抛出**。它若抛出会一路逃到 `runLoopFromState`，把一次保护性放弃升级成 attempt 失败。**本层刻意不给它包 try/catch**——包了会静默吞掉一个编程错误，违反 Rule 12。
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1719:  **Amended 2026-08-04：「一次数组 push」＋「不做 I/O、不格式化」这两句已被人裁推翻——回调改为*当场* `options.stderr(...)`，折行也在回调里当场做。** ……（下略，见文件）
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1759:- [ ] **Step 6: 跑确认失败并贴输出 → 实现 `note` 行（含单行折叠、遍历顺序、回调=一次数组 push）→ 再跑确认通过并贴输出。**
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1761:  **Amended 2026-08-04：本步括号里的「回调=一次数组 push」与上面「落点」一节那一句是同一处，已同样被人裁推翻——读作「回调=当场 `options.stderr(...)`（含单行折叠）」。** ……（下略，见文件）
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1999:| `writeBoundaryArtifacts(runDir, artifacts, options?)` 第三参 `{ onReconciliationWriteAbandoned?: (detail: string) => void }` | A8 | A8 的 12d(iii)、C3（回调=数组 push） | ✅ 回调签名三处都是 `(detail: string) => void` |
---EXIT=0
```

> **说明**：上面 `:1578`、`:1719`、`:1761` 三行原始输出极长（各是整段勘误正文），我在贴的时候用「……（下略，见文件）」截断了**这三行**。**这是本报告里唯一一处对命令输出的削短，明写在这里。** 其余每一行都是原样。截断的三行都是**已带勘误标记的**行，其完整正文与本项的判断无关（它们正是「已被修好」的那一族）。

**行号今天仍然对得上**：台账点名的 `spec:692` / `spec:751` / `plan:1004` 三处，今天就在这三个行号上。这一族的行号**没有**腐坏。

#### 今天是否仍成立 —— 逐处判定

台账点名 **3 处**。今天实际带「数组 push」字样的站点有 **9 处**，分三类：

**第一类：台账点名的三处，仍然腐坏，无任何就地勘误。**

- `spec:692` —— 「本层的处置是把「不得抛出」定成回调的契约，**并把 sweep 侧的实现定死为一次数组 push（不做 I/O、不格式化）**」
- `spec:751` —— 「回调的实现**在本层的控制范围内**（**§9 已把它定死为一次数组 push，不做 I/O**），所以它抛出只可能是**编程错误**」
- `plan:1004` —— 「本层的处置是把「不得抛出」定成**回调的契约**，并把 sweep 侧的实现定死为**一次数组 push**（不做 I/O、不格式化）」

我核对了这三处的上下文（`spec:683-694`、`spec:745-759`、`plan:1000-1006`）：**三处附近都没有 `Amended` 标记**。

**第二类：台账**没有**点名、但同族同样腐坏、同样无勘误的三处。这是本项最实质的发现。**

- `spec:681`（§4.3 第三步的四层通道表，`sweep.sweepRuns` 那一行）—— 「为**当前这个 run** 传一个闭包，**把 `{ path, detail }` push 进本次 sweep 的备注数组**」。**这是全文档里唯一一处仍然把回调的落点直接写成「备注数组」的地方**，比 `spec:692` 更直白。
- `plan:876` —— 与 `spec:751` **是同一条论证的孪生句**（「§9 定死为一次数组 push，不做 I/O」）。台账说 `plan:1004` 是「their copy」，但 `spec:751` 的 copy 其实是 `plan:876`，不是 `plan:1004`；`plan:1004` 是 `spec:692` 的 copy。**台账把两条不同论证的 copy 关系记混了一半。** 原样上报，不改台账。
- `plan:1999`（可追溯性矩阵）—— 「A8 的 12d(iii)、**C3（回调=数组 push）**」，并且该行末尾还打着 `✅`。

**第三类：同族但**已经**带就地勘误的三处，不再是债。**

- `spec:1570`（§9 模块表）→ 紧跟 `spec:1578` 的 `Amended 2026-08-05`（就是 HEAD 前一个 commit `b9afbf3` 落的那条）。
- `plan:1717` → 紧跟 `plan:1719` 的 `Amended 2026-08-04`。
- `plan:1759`（Step 6）→ 紧跟 `plan:1761` 的 `Amended 2026-08-04`。

#### 论据是否腐坏 —— 与「结论是否腐坏」分开判

**论据：腐坏。** 「回调的实现是一次数组 push、不做 I/O」今天在代码上**为假**。证据：

```
$ rtk proxy grep -n "onReconciliationWriteAbandoned" -B 4 -A 4 src/persistence/fileStore.ts
440-  // A8 §4.3: the operator channel for a protective abandonment. Optional at every one of the
441-  // four layers, so all existing call sites keep working unchanged; absent, the abandonment is
442-  // recorded in events.jsonl only and is routed nowhere. The callback's contract is "must not
443-  // throw" — see the note at its call site below.
444:  options?: { onReconciliationWriteAbandoned?: (detail: string) => void },
445-): Promise<void> {
446-  await writeJsonFileAtomically(join(runDir, "boundary-analysis.json"), artifacts.boundaryAnalysis);
447-
448-  if (artifacts.reconciliationRecord !== undefined) {
--
474-      // equivalent mutation (a swallowed appendEvent cannot stop the callback that follows it
475-      // either). It is defence in depth against a future edit that removes the swallow and
476-      // leaves the order alone, at which point an unwritable events.jsonl would take the
477-      // operator's line down with it.
478:      options?.onReconciliationWriteAbandoned?.(String(decision.error));
479-
480-      try {
481-        await appendEvent(runDir, {
482-          type: "reconciliation_write_abandoned",
```

以及 sweep 侧的实际实现（`src/sweep/sweepRuns.ts`，Read 工具 205–209 行原样）：

```
205	        onReconciliationWriteAbandoned: (detail) => {
206	          options.stderr(
207	            `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}`,
208	          );
209	        },
```

回调体里既有 I/O（`options.stderr`），也有格式化（模板串 + `replace`）。「一次数组 push、不做 I/O、不格式化」三个断言**全部为假**。

**结论：不腐坏，仍然成立。** 三条结论逐条：

1. **「回调不得抛出」** —— 仍成立，且今天仍是契约。
2. **「本层刻意不给它包 try/catch」** —— 仍成立，且**在代码上可验证**：`fileStore.ts:478` 的调用点是裸调用，前后没有 try/catch（紧邻的 `:480` 那个 `try` 包的是 `appendEvent`，不是回调）。
3. **`spec:751` 的那条不对称论证（`appendEvent` 吞、回调不吞，理由是「谁能修好它」）** —— **仍成立，且今天的实现自己把这条论证写进了注释**。`sweepRuns.ts` 回调上方的注释逐字：

   > ```
   >         // Deliberately NOT wrapped in try/catch: `options.stderr` throwing is a programming error
   >         // in the caller, and swallowing it here would hide it (Rule 12).
   > ```

   把 premise 从「数组 push」换成「`options.stderr` 写」之后，「它抛出只可能是编程错误」这一步**照样走得通**——`options.stderr` 是调用方注入的、在本层控制范围内的函数，与不受控的 `appendFile` I/O 仍然不同类。这正是台账说的「spec:751's argument survives an injected stderr sink」，**今天仍然对**。

**所以这是一处纯粹的「论据腐坏、结论不腐坏」。** 这也是本报告里唯一一处我能明确划出这条界线的项。

#### 后果分级

**仅文档。** 据以分级的证据：

- 这九处全部在 `docs/` 下，`src/` 与 `tests/` 里**没有任何一处**提到「数组 push」（上面那条 grep 只跑了 spec 与 plan；但 `sweepRuns.ts` 的回调注释与 `fileStore.ts:440-444` 的注释都已经是 stderr 措辞，见上面两段原样引用）。
- 没有任何测试断言在这三句话上。
- 但**危害不是零**：`spec:681` 是一张「通道逐层定死」的表，L5 若照表实现一个新的回调消费者，会照着「push 进备注数组」写，从而**重新引入 C3 那次人裁明令推翻的缓冲失效模式**（SIGKILL 下告警静默丢失）。这一族的腐坏是**会被照抄的那一种**，不是纯粹的历史记录。

#### 最小勘误建议（只描述，不动手）

按本仓库既有的勘误形状（`*Amended <date>*` 就地插入、零删除、不给未来修复建议），最小改动是 **3 条勘误覆盖 6 处**：

1. **一条勘误挂在 `spec:681` 那张表下方**，写法沿用 `spec:1578` 已有的措辞：该行的「push 进本次 sweep 的备注数组」读作「在回调里当场 `options.stderr(...)`（含单行折叠）」。理由指向已有的 `spec:1578`，不重述。
2. **一条勘误覆盖 `spec:692` 与 `spec:751` 两句**（它们同属 §4.3，中间只隔一小节）：这两句里的「定死为一次数组 push（不做 I/O、不格式化）」是**论据**，已随第五波人裁改为「当场 `options.stderr(...)`」；**两句的结论一个字不改** —— 「不得抛出」仍是契约、「刻意不包 try/catch」仍然照做、「谁能修好它」这条不对称论证在新 premise 下同样成立（`options.stderr` 是注入的、在本层控制范围内）。
3. **一条勘误覆盖 `plan:876`、`plan:1004`、`plan:1999` 三处**，措辞与第 2 条同形，并指回 `plan:1719` 那条已有的 `Amended 2026-08-04`。

**建议同时纠正台账自己的一处记错**（第二类里那条）：`spec:751` 的 copy 是 `plan:876` 而不是 `plan:1004`；`plan:1004` 是 `spec:692` 的 copy。这属于 ledger 勘误，**必须由人裁**，我不动。

#### 我不确定的地方

1. **我没有跑注入实验去验证「结论仍成立」。** 台账说「spec:751's argument survives an injected stderr sink」是**实测过的**；我的验证是**读代码 + 读注释**，属于同一类推理，不是独立的第二条证据。
2. **我只 grep 了 `push` 这一个词。** 如果还有用别的措辞（例如「备注数组」「收进数组」）而不出现 `push` 的站点，我会漏掉。我没有为「备注数组」单独跑一次 grep。
3. **`plan:150` 的 `push` 是 git push，与本族无关**，我把它排除在计数外；9 处是排除它之后的数字。

### 项 A：被拒 run 的无退避重捡（spec §13 第 5 笔）

**本项完整。**

#### 原文出处

`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §13「继承债与不做的事」第 5 笔，逐字：

> 5. **被拒 run 的无退避重捡。** registry 不观测 `reconciliation-record.json`，所以「transfer eligible 但 reconciliation 不合格」的 run 会被**每一次** sweep 重新捡起、每次追加 2～3 行事件，无退避、无上限、无标记。见 §6 与 §12。

§6「Sweep 触发层」的处置第 2 条（这一笔的理由与代价），逐字：

> 2. **排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了第 1 条之后，饿死的机制已经消失（拒绝不消耗配额，遍历一定会走到可跑的 run）。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5**（§13）。

`docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 的孪生段（brief 说的「第 1471 行附近」，今天就在 1471），逐字：

> **排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了「拒绝不消耗配额」之后，饿死的机制已经消失。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5（§13 第 5 笔）。**

§12「治理与付费调用」里那句「`--max-runs` 界的是付费调用、不界事件追加」，逐字：

> **本节不界的东西，明写出来**：`--max-runs` 界的是**付费调用**，不界事件追加。一次 sweep 扫到 M 个永久被拒的 run 仍会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件（无退避、无上限、无标记，理由与代价见 §6），**这一笔具名传给 L5**（§13）。

定位这四处的命令与完整输出：

```
$ rtk proxy grep -n "退避" docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md; echo "---EXIT=$?"
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1471:**排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了「拒绝不消耗配额」之后，饿死的机制已经消失。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5（§13 第 5 笔）。**
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1919:  - **本层留给 L5 的输入合计 6 项 = 债 2 ＋ §13 具名的 5 笔**（锁可被偷、execute abort 无第二重上界、`writeBoundaryArtifacts` 落在 exclusive span 外「本轮新发现，需重新裁归属」、输家 reconciliation 写的残余 TOCTOU、被拒 run 的无退避重捡）。**这个数字与 §13 的清单联动，改一处必须改两处。**
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1472:2. **排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了第 1 条之后，饿死的机制已经消失（拒绝不消耗配额，遍历一定会走到可跑的 run）。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5**（§13）。
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2306:**本节不界的东西，明写出来**：`--max-runs` 界的是**付费调用**，不界事件追加。一次 sweep 扫到 M 个永久被拒的 run 仍会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件（无退避、无上限、无标记，理由与代价见 §6），**这一笔具名传给 L5**（§13）。
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2331:  | 5 | 被拒 run 的无退避重捡 | **不变** |
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2437:5. **被拒 run 的无退避重捡。** registry 不观测 `reconciliation-record.json`，所以「transfer eligible 但 reconciliation 不合格」的 run 会被**每一次** sweep 重新捡起、每次追加 2～3 行事件，无退避、无上限、无标记。见 §6 与 §12。
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2443:1. **L5 — cleanup / orphan handling**（父设计 §17 item 3）。**输入合计 6 项 = 债 2 ＋ §13 具名的 5 笔**（锁可被偷、execute abort 无第二重上界、**`writeBoundaryArtifacts` 落在 span 外（本轮新发现，需重新裁归属）**、**输家 reconciliation 写的残余 TOCTOU**、被拒 run 的无退避重捡）。**这个数字与 §13 的清单联动，改一处必须改两处。**
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2778:| F46 | Important | 必需配额 + 确定排序 + 拒绝计入 = 确定性饿死；被拒 run 无收敛机制 | ~~§6（配额**只计实际执行**）~~、§12、§13 第 5 笔。**⚠️ 第四轮补记：「只计实际执行」正是第三轮的 G9 改判掉的**（它依赖「抛出必然发生在 `runLoopFromState` 跑完之前」这条假断言）。**「排序/退避的选择与理由」那一半仍然有效** |
```

#### 今天的落点（符号锚点）

| 符号 | 文件 | 与本笔的关系 |
|---|---|---|
| `OBSERVED_FILES` | `src/registry/observeFields.ts` | registry 观测哪几个文件的唯一真源 |
| `observeRun` | `src/registry/observeRun.ts` | `OBSERVED_FILES.map(...)`，每个 spec 一条 |
| `isObservedEligible` | `src/sweep/sweepRuns.ts` | sweep 的过滤器，只看 `owner-transfer.json` 的 `eligibleForContinuation` |
| `sweepRuns` 的 `for (const candidate of candidates)` | `src/sweep/sweepRuns.ts` | 遍历本体 |
| `if (adopted >= options.maxRuns) break;` | `src/sweep/sweepRuns.ts` | `--max-runs` 唯一的界点 |
| `onAdopted` / `adopted` | `src/sweep/sweepRuns.ts` + `src/controller/resumeLoop.ts` | 配额计入时点 |
| `evaluateResumeEligibility` | `src/controller/resumeLoop.ts` | 八条判据，`reconciliation` 占其中 3 条 |
| `appendEvent` 在 `resumeLoop` 里的 6 处 | `src/controller/resumeLoop.ts` | 「2～3 行事件」的来源 |
| `appendEvent` 在 `checkRunLease` 里的 1 处 | `src/controller/leaseGate.ts` | 第 3 行事件的唯一来源 |

#### 重推命令与当时输出

**（1）registry 今天到底观测哪几个文件** —— 用 spec 自己写的那条命令：

```
$ rtk proxy grep -nF 'file:' src/registry/observeFields.ts; echo "EXIT=$?"
7:    file: "loop-state.json",
29:    file: "owner-record.json",
45:    file: "owner-transfer.json",
111:  return { file: spec.file, fields };
EXIT=0
```

4 行命中，其中 3 行是文件名，第 4 行（`:111`）是返回构造。**与 spec 第四轮贴的原始输出（同样是 4 行、同样是 `:7`/`:29`/`:45`/`:111`）逐字一致。**

```
$ rtk proxy grep -rn "OBSERVED_FILES" src/ ; echo "EXIT=$?"
src/persistence/fileStore.ts:678:// OBSERVED_FILES marks owner-transfer.json `atomic: true` (observeFields.ts:46), which
src/sweep/sweepRuns.ts:100:// reconciliation-record.json is not in L2's OBSERVED_FILES at all. So a row passing this filter
src/registry/readObservedFile.ts:3:// files marked `atomic: false` in OBSERVED_FILES. That flag no longer means "written
src/registry/observeRun.ts:4:import { OBSERVED_FILES } from "./observeFields.js";
src/registry/observeRun.ts:16:// One entry per OBSERVED_FILES entry, in that order, always (spec §6: a row is never
src/registry/observeRun.ts:23:    OBSERVED_FILES.map((spec) => readObservedFile(runDir, spec, deps)),
src/registry/observeFields.ts:5:export const OBSERVED_FILES: readonly ObservedFileSpec[] = [
EXIT=0
```

唯一的定义在 `observeFields.ts:5`，唯一的消费者是 `observeRun.ts:23`。**`reconciliation-record.json` 不在其中，并且 `sweepRuns.ts:100` 的生产注释自己把这件事写死了。**

**（2）sweep 今天的遍历与 `--max-runs` 界的到底是什么** —— 来自 `src/sweep/sweepRuns.ts` 的 Read（原样）：

```
165	  for (const candidate of candidates) {
...
172	    if (adopted >= options.maxRuns) break;
...
177	    if (options.stopRequested.requested) break;
178	
179	    attempted += 1;
180	    let report: { outcome: Outcome; detail: string };
181	    try {
182	      const finalState = await resume(candidate.path, adapter, {
183	        stopRequested: options.stopRequested,
184	        onAdopted: () => {
185	          adopted += 1;
186	        },
```

`--max-runs` 的界点是 `adopted`，而 `adopted` 只在 `onAdopted` 里自增；`onAdopted` 在 `resumeLoop.ts:178` 触发，位于 `resume_adopted` 追加（`:172`）之后、`startLeaseHeartbeat`（`:185`）之前。**被拒的 run 走不到 `:178`，所以 `adopted` 不增、`break` 不会因它们提前发生。** 计数器 `attempted` 无界（每个候选都 +1）。

生产注释自己把这个判据写死了（`sweepRuns.ts` 166–171 行，Read 原样）：

```
166	    // §6, quota accounting point (the amended ruling): the bound is on runs that actually ENTERED
167	    // runLoopFromState, counted at adoption rather than at return. Counting at return would let a
168	    // throw out of runLoopFromState's pre-try head refund a run whose attempts were already paid
169	    // for, and one sweep could then make unbounded paid calls under --max-runs 1. Counting every
170	    // CALL instead would let refusals — which never enter the loop and never pay anything —
171	    // starve the runs queued behind them.
```

**（3）「每次 2～3 行事件」今天是否仍是这个量级**：

```
$ rtk proxy grep -rn "appendEvent(" src/controller/leaseGate.ts src/controller/resumeLoop.ts; echo "---EXIT=$?"
src/controller/leaseGate.ts:58:    await appendEvent(runDir, {
src/controller/resumeLoop.ts:113:  await appendEvent(runDir, { type: "resume_requested", at: new Date().toISOString(), detail: runDir });
src/controller/resumeLoop.ts:122:    await appendEvent(runDir, {
src/controller/resumeLoop.ts:144:    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: `cannot read run artifacts: ${String(error)}` });
src/controller/resumeLoop.ts:150:    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail: eligibility.reason });
src/controller/resumeLoop.ts:168:    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail });
src/controller/resumeLoop.ts:172:    await appendEvent(runDir, {
---EXIT=0
```

```
$ rtk proxy grep -cF 'appendEvent(' src/controller/resumeLoop.ts; rtk proxy grep -cF 'return { ok: false' src/controller/resumeLoop.ts
6
8
```

`resumeLoop` 里 6 处 `appendEvent`（与 spec §6「实测 6」一致）；`evaluateResumeEligibility` 8 条判据（与本仓库长期用的守卫 1「`return { ok: false` = 8」一致）。

`leaseGate.ts:58` 那一处的类型（Read 原样，58–62 行）：

```
58	    await appendEvent(runDir, {
59	      type: "lease_expired_observed",
60	      at: new Date(nowMs).toISOString(),
61	      detail: `lease held by ${ownerRecord.currentProcessInstanceId} expired at ${expiredAt} (last affirmed ${leaseAffirmedAt})`,
62	    });
```

#### 今天是否可达 / 是否仍成立

**仍然完全成立。可达，构造如下（写死）：**

一个 run 目录，`owner-transfer.json` 的 `eligibleForContinuation` 为 literal `true`（这样 `isObservedEligible` 放行），但 `reconciliation-record.json` 不满足 `evaluateResumeEligibility` 的第 2/3/4 条中任意一条（`eligibleForContinuation !== true`，或 `ownershipVerdict !== "OWNER_LOST"`，或 `newOwnerEpoch` 与 transfer 不匹配）。把它放在 sweep 的 root 下，反复跑 `ccloop sweep`。

每一轮的结果：
- `isObservedEligible` 放行 —— 因为 `OBSERVED_FILES` 里没有 `reconciliation-record.json`，L2 **无法**观测到它不合格；
- `attempted += 1`；
- `resumeLoop` 追加 `resume_requested`（`:113`）；
- `checkRunLease` 通过（无租约）；
- 五份 artifact 读成功；
- `evaluateResumeEligibility` 返回 `{ ok: false, reason }` → 追加 `resume_denied`（`:150`）→ 抛 `ResumeNotEligibleError`；
- `classifyThrow` 落到第二支路 → `outcome: "refused"` → 写 **stdout**；
- `adopted` **不增** → 配额未被消耗 → `break` 不触发 → 下一轮 sweep 再来一次。

**无退避**：`resumeLoop` / `sweepRuns` 里没有任何时间戳读取、没有任何「上次尝试于」状态文件。**无上限**：唯一的 `break` 条件是 `adopted >= maxRuns` 与 `stopRequested.requested`，两者都与被拒次数无关。**无标记**：被拒不在 run 目录里留下任何「我被拒过 N 次」的可读状态；`events.jsonl` 是只追加的，没有任何代码去读它统计次数（spec §6 明写「不用『数 `resume_adopted` 行数』代替回调」的理由就是 sweep 承诺不读 run 目录下的文件）。

#### 论据是否腐坏

逐条核对 §13 第 5 笔与 §6 处置 2 的每一条论据：

| 论据 | 今天 | 判定 |
|---|---|---|
| registry 只观测 3 个文件 | `OBSERVED_FILES` 三条：`loop-state.json` / `owner-record.json` / `owner-transfer.json` | **成立**，grep 输出与 spec 第四轮贴的逐字一致 |
| 不观测 `reconciliation-record.json` | `OBSERVED_FILES` 里无此条；`sweepRuns.ts:100` 的注释自己写死 | **成立** |
| 「transfer eligible 但 reconciliation 不合格」会被**每一次** sweep 重新捡起 | `isObservedEligible` 只看 `owner-transfer.json`；拒绝不消耗配额 | **成立** |
| 每次追加 **2～3 行**事件 | 见下 | **成立，但需要精确化** |
| `--max-runs` 界的是**付费调用**、不界事件追加（§12） | **论据腐坏，结论不变** | 见下 |
| 一次 sweep 扫到 M 个永久被拒的 run → M 次 `resumeLoop` 调用 | `for` 循环对每个候选都调一次 `resume`，`break` 与被拒无关 | **成立** |

**关于「2～3 行」的精确化**：今天在一次被拒里能追加的事件，穷举是

- 恒定 1 行：`resume_requested`（`resumeLoop.ts:113`，无条件，在任何门之前）；
- 恰好 1 行：`resume_denied`（四条拒绝路径 `:122` / `:144` / `:150` / `:168` 中**恰好一条**会走到，因为每条之后都立刻 `throw`）；
- 可选 1 行：`lease_expired_observed`（`leaseGate.ts:58`，只在租约过期时追加，且它**不**导致拒绝——`checkRunLease` 之后 `return { kind: "expired" }` 继续往下走）。

所以 **下界 2、上界 3**，「2～3 行」**今天仍然精确**，不是量级估计。

**⚠️ 但「§13 第 5 笔所指的那一类 run」实际恒为 2 行，不是 2～3。** 「transfer eligible 但 reconciliation 不合格」走的是 `evaluateResumeEligibility` 那条路（`:150`），第 3 行只在租约过期时才有，与 reconciliation 无关。台账/spec 的「2～3」是对**全部**拒绝路径的正确刻画，用在这一笔的具体人群上偏保守。**这是论据的精度问题，不是错误**，我不改。

**关于 §12 那句「`--max-runs` 界的是付费调用」—— 论据腐坏，结论不变。** §6 自己在第四轮已经就地更正过这句（spec `:1441` 起那段 `⚠️`：「`--max-runs` 界的是**进入 `runLoopFromState` 的 run 数**」，付费上界是 `N × maxAttempts`），但 **§12 `:2306` 那句仍然写着「界的是付费调用」**，没有同步。今天代码上，`--max-runs` 界的是 `adopted`，即进入 `runLoopFromState` 的 run 数。

- **结论不变**：这句话在本笔里承担的作用是「事件追加**不**被 `--max-runs` 界住」，这一半今天完全成立（`attempted` 与 `appendEvent` 都不受 `maxRuns` 约束）。
- **论据腐坏**：「界的是付费调用」这个前半句 §6 已经自己推翻了，§12 是漏同步的那一处。
- **原样上报，不自裁。** 这是本报告里第二处「论据腐坏、结论不腐坏」，形状与项 D 同族，但**台账/spec 从未把它记成一笔债** —— 见「我发现的、原文没写的东西」。

#### 后果分级

**仅可操作性（磁盘单调增长），不是数据丢失，不是拒绝，不是假告警。**

据以分级的证据：

- **不是数据丢失**：被拒路径在 `claimOwnerRecordWithPrecondition`（`resumeLoop.ts:161`）之前就抛出，唯一的写是 `events.jsonl` 上的**追加**。没有 rename、没有覆盖、没有 unlink。
- **不是假告警**：`classifyThrow` 把 `ResumeNotEligibleError`（非读侧前缀）归为 `refused`，而 `sweepRuns` 的 `sink` 只在 `outcome === "error"` 时才用 stderr。**被拒 run 的报告行走 stdout**，不会触发 cron 的「有 stderr 即告警」。这一点与项 B 正好相反，两者不能混为一谈。
- **不影响付费界**：`adopted` 不增，`createAdapter()` 虽已构造但 `runLoopFromState` 从未进入。§6 的「拒绝不消耗配额」今天在代码上成立。
- **真实代价**：每轮 2 行 × M 个永久被拒的 run × sweep 频率，写进 `events.jsonl`，**永不收敛**。一个每 5 分钟跑一次的 cron sweep、10 个永久被拒的 run，一天就是 `2 × 10 × 288 = 5760` 行。这个乘积是我算的，不是实测。
- **次生代价（原文没写）**：`ccloop ls` 与 `sweep` 的候选集里这些 run 永远在，且永远排在字典序的同一个位置 —— 操作者每次看到的「N run(s) observed eligibleForContinuation=true」横幅里都含着它们，而横幅刚在 GATE-C 上被加了「an observed field, not a decision that the run may be resumed」的限定，正是为了这种情况。**这条限定语已经在，所以这不是新的知情缺陷**，但 M 越大，横幅数字的信息量越低。

#### 我不确定的地方

1. **我没有真的跑一次 sweep 去数事件行数。** 「2 行 / 3 行」是从 `appendEvent` 调用点的控制流推出来的，不是实测。要坐实需要构造一个 fixture 目录跑两次 sweep 并 `wc -l events.jsonl`。
2. **我没有验证 `--max-runs` 的界在「候选集大于 N 且全部被拒」时的行为边界**：`break` 永不触发，所以一次 sweep 会遍历**全部** M 个候选，而不是 N 个。这与「`--max-runs` 界的是启动多少个 run 的续跑」一致，但意味着**遍历成本本身也不受 N 约束**。这一点 §6/§12 都没有明写，我也没有实测。
3. **§12 那句漏同步是不是已经被别的评审记过一笔**，我没有全文搜索 `progress.md` 去确认。我只确认了它今天在 spec 上仍然是旧措辞。

### 项 C：组 B 的两条债（谓词加宽无测试 / B1 分支 `writeRunState` 无 CAS）

**本项完整。**

#### 原文出处

`progress.md` 的 `STILL OPEN, NAMED SO IT CANNOT BE INHERITED AS CLOSED:` 段第三条，逐字：

> ```
>   - Group B's two carried debts (the predicate-widening half has no test; B1's
>     branch writeRunState has no CAS) were re-derived as STILL UNREACHABLE after
>     group C lands, and travel to L5 unchanged.
> ```

**触发条件写死在 GATE-B 的 `CONDITIONS ON THIS PASS` 里，条 3 与条 4、5。逐字：**

> ```
>   3. The predicate-widening half still has no test (human-ruled, plan erratum in
>      place). Carry verbatim to group C AND to L5, with the trigger: ANYONE WHO
>      REORDERS THE TWO OUTER-CATCH BRANCHES MUST RE-RUN THE WIDENING EXPERIMENT.
>   4. The no-CAS write: carry to L5. Add the obligation lane 2 found MISSING from
>      the list — if anyone introduces a stop() call site INSIDE the loop, the
>      unreachability argument behind this ledger's B1 and B2 confirmations must be
>      re-run, not inherited.
>   5. appendEvent("heartbeat_stopped") and appendEvent("stop_requested") are also
>      unguarded writes to a possibly-transferred run (lane 1, F-4). Append, not
>      overwrite, so one notch less harmful — but they travel with condition 4 so
>      L5 does not think there is only one site.
> ```

同段末尾那句「本门最脆的前提」，与这两条债共命运，逐字：

> ```
> THE MOST FRAGILE PREMISE OF THIS WHOLE GATE, STATED BY LANE 1 AND ENDORSED HERE:
> "`stopped` is false for the entire duration of runLoopFromState." The branch's
> low-risk grading, the open-item-4 confirmations and the unreachability of the
> no-CAS write ALL rest on it, and NOTHING TESTS IT — it holds only because both
> stop() call sites happen to sit in a `finally`. Anyone who hands the heartbeat
> outside the loop overturns all three at once, and the suite stays green.
> ```

GATE-B 的 I-1 段里那条「gap，具名以免被当作已关闭」，逐字：

> ```
>   THE GAP, NAMED SO IT CANNOT BE INHERITED AS CLOSED: hard constraint 1 has a
>   failing assertion for its SUBCLASSING half only (7b's instanceof pair). Its
>   PREDICATE-WIDENING half is guarded by a comment. A single edit widening the
>   predicate is behaviourally inert TODAY and green; it detonates on any later
>   edit that reorders the two branches, deletes the dedicated branch, or lets
>   this error escape the INNER catch — which routes to persistTerminalState with
>   "cancelled". GATE-B and group C inherit this, not a closed item.
> ```

`gate-c-lane2-report.md` §4.4 是 GATE-C 上对这两条的重新推导（lane 2 自己从源码推，不继承 C2 的结论），其中一句是**放大器**，逐字：

> **要加进那条 L5 条目的一句**：这条界今天由一份**推理产物**而非一条测试守着，而 sweep 把它的走访次数乘了 N。将来任何一波若新增一条绕过终态到 `persistBoundaryAnalysis` 的路由，**每一次人类批准的爆炸半径就是 N 倍**。这个放大器必须写进条目，否则承接方只会看到「不可达」。

#### 今天的落点（符号锚点）

| 符号 | 文件 | 角色 |
|---|---|---|
| `isLeaseStopError` | `src/controller/runLoop.ts`（模块私有，未导出） | 谓词本体 |
| `RunHeartbeatStoppedError` | `src/ownership/lease.ts` | 被加宽半边所指的错误类 |
| 外层 catch 里的 `if (error instanceof RunHeartbeatStoppedError)` 分支 | `src/controller/runLoop.ts` | B1 的专用分支，**排在谓词分支之前** |
| 该分支里的 `await writeRunState(runDir, state)` | `src/controller/runLoop.ts` | 无 CAS 的那次写 |
| `writeRunState` → `writeJsonFileAtomically` | `src/persistence/fileStore.ts` | 证明无 CAS |
| `heartbeat.stop()` 的两个生产调用点 | `src/controller/runLoop.ts` / `src/controller/resumeLoop.ts` | 不可达论证的支点 |
| `registerStopHandlers` | `src/cli.ts` | sweep 的停机机制，与 heartbeat 无关 |
| `describe("lease")` 里的 sibling 断言 | `tests/controller/leaseHeartbeat.test.ts` | 只守 subclassing 半边 |

#### 重推命令与当时输出

**（1）`isLeaseStopError` 今天的谓词形状与两条分支的顺序**：

```
$ rtk proxy grep -rn "isLeaseStopError" src/ tests/; echo "---EXIT=$?"
src/controller/runLoop.ts:107:function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
src/controller/runLoop.ts:1109:        if (isLeaseStopError(error)) {
src/controller/runLoop.ts:1477:      // terminate the run. Deliberately its OWN branch, ordered ahead of isLeaseStopError rather
src/controller/runLoop.ts:1507:      if (isLeaseStopError(error)) {
src/ownership/lease.ts:42:// isLeaseStopError (src/controller/runLoop.ts) NOT matching it: that predicate's branch persists
src/persistence/fileStore.ts:279:// isLeaseStopError does not match — ending an otherwise-successful attempt as failed. Recording a
src/persistence/fileStore.ts:460:      //      catch — where isLeaseStopError does not match an I/O error — and end the attempt as
src/persistence/fileStore.ts:511:        // into runLoopFromState's outer catch — where isLeaseStopError does not match an I/O
tests/controller/leaseHeartbeat.test.ts:742:// isLeaseStopError because that predicate is module-private to runLoop.ts and no test can observe
tests/controller/runLoop.integration.test.ts:1179:    // isLeaseStopError, fall through to the infra-retry escalation and terminate the run as
tests/controller/runLoop.integration.test.ts:2409:        // Emitted by the outer catch's isLeaseStopError branch, since state.status was not yet
tests/controller/runLoop.integration.test.ts:2546:        // Emitted by the outer catch's isLeaseStopError branch, since state.status was not yet
---EXIT=0
```

谓词本体（`src/controller/runLoop.ts`，Read 原样 104–109 行）：

```
104	// §8.1: the two ways heartbeat.assertHeld() can refuse a side effect. Both abandon the
105	// attempt in place; they differ only in the stop reason they carry, because "someone else
106	// owns this run" and "this run's ownership could not be read" are not the same claim.
107	function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {
108	  return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError;
109	}
```

**两个 instanceof，未加宽，未导出。** `tests/` 下对它的 12 处提及**全部是注释**（`grep` 输出里 tests 的 4 行都以 `//` 开头，或在注释文本中），**没有一处是断言**——`leaseHeartbeat.test.ts:742` 的注释自己解释了原因：「that predicate is module-private to runLoop.ts and no test can observe it」。

外层 catch 的两条分支及其顺序（`src/controller/runLoop.ts`，Read 原样）：

```
1474	    } catch (error) {
...
1489	      if (error instanceof RunHeartbeatStoppedError) {
1490	        await appendEvent(runDir, {
1491	          type: "heartbeat_stopped",
1492	          at: new Date().toISOString(),
1493	          detail: String(error),
1494	        });
1495	        await writeRunState(runDir, state);
1496	        return state;
1497	      }
...
1507	      if (isLeaseStopError(error)) {
```

**`:1489` 的专用分支排在 `:1507` 的谓词分支之前，两条在同一个 `catch`（`:1474`）里，且专用分支 `return state` 提前返回。** 这正是「加宽谓词今天行为惰性」的机制，今天原样成立。

**（2）加宽的那半边今天有没有测试守着**：

```
$ rtk proxy grep -rn "RunHeartbeatStoppedError" src/ tests/; echo "---EXIT=$?"
src/controller/runLoop.ts:23:import { RunHeartbeatStoppedError, RunLeaseLostError, RunLeaseUnverifiableError } from "../ownership/lease.js";
src/controller/runLoop.ts:1489:      if (error instanceof RunHeartbeatStoppedError) {
src/controller/leaseHeartbeat.ts:7:  RunHeartbeatStoppedError,
src/controller/leaseHeartbeat.ts:212:        throw new RunHeartbeatStoppedError(
src/ownership/lease.ts:46:export class RunHeartbeatStoppedError extends Error {
src/ownership/lease.ts:51:    this.name = "RunHeartbeatStoppedError";
tests/controller/leaseHeartbeat.test.ts:10:  RunHeartbeatStoppedError,
tests/controller/leaseHeartbeat.test.ts:362:  it("refuses runExclusive after stop, throwing RunHeartbeatStoppedError", async () => {
tests/controller/leaseHeartbeat.test.ts:370:    await expect(heartbeat.runExclusive(fn)).rejects.toBeInstanceOf(RunHeartbeatStoppedError);
tests/controller/leaseHeartbeat.test.ts:749:  it("RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either", () => {
tests/controller/leaseHeartbeat.test.ts:750:    const stopped = new RunHeartbeatStoppedError("run heartbeat has stopped");
tests/controller/runLoop.integration.test.ts:10:import { RunHeartbeatStoppedError } from "../../src/ownership/lease.js";
tests/controller/runLoop.integration.test.ts:1187:        throw new RunHeartbeatStoppedError("run heartbeat has stopped: test-injected mid-attempt stop");
---EXIT=0
```

唯一那条「守 hard constraint 1」的测试（`tests/controller/leaseHeartbeat.test.ts`，Read 原样 739–758 行）：

```
739	// Task B1 / L3 §5.3 hard constraint, first half — the companion assertion to test 7b in
740	// tests/controller/runLoop.integration.test.ts, kept in this file because the plan confines the
741	// task to these two test files. It is asserted directly on the classes rather than through
742	// isLeaseStopError because that predicate is module-private to runLoop.ts and no test can observe
743	// it: the ONLY thing standing between "a stopped heartbeat returns a resumable state" and "a
744	// stopped heartbeat writes the terminal cancelled status" is that the predicate's two instanceof
745	// checks miss this error. Making it a subclass of either — or giving all three a common base —
746	// re-arms that write with the predicate unchanged, which is both easier to do by accident than
747	// editing the predicate and invisible in every other test name.
748	describe("lease") {
749	  it("RunHeartbeatStoppedError is a sibling of the two lease stop errors, not a subclass of either", () => {
750	    const stopped = new RunHeartbeatStoppedError("run heartbeat has stopped");
751	
752	    expect(stopped instanceof RunLeaseLostError).toBe(false);
753	    expect(stopped instanceof RunLeaseUnverifiableError).toBe(false);
754	    // The sibling half: still a plain Error, so runLoopFromState's outer catch receives it.
755	    expect(stopped).toBeInstanceOf(Error);
756	    expect(stopped.stopReason).toBe("heartbeat_stopped");
757	  });
758	});
```

> **勘误（我自己的转录）**：上面 748 行我误写成 `describe("lease") {`，文件里实际是 `describe("lease", () => {`。这是我的转录错误，不是文件内容。其余各行逐字。

**这条测试断的是 subclassing（`stopped instanceof RunLeaseLostError` 为 false 等），断不到谓词本身。** 加宽 `isLeaseStopError` 的函数体不会让这四条断言里任何一条变红。**「加宽的半边今天仍然没有测试守着」——成立。**

**（3）B1 那条分支的 `writeRunState` 今天有没有 CAS**：

```
$ rtk proxy grep -n "export async function writeRunState" -A 12 src/persistence/fileStore.ts; echo "---"; rtk proxy grep -n "async function writeJsonFileAtomically" -A 20 src/persistence/fileStore.ts
81:export async function writeRunState(runDir: string, state: RunState): Promise<void> {
82-  await writeJsonFileAtomically(join(runDir, "loop-state.json"), state);
83-}
84-
85-export async function appendEvent(runDir: string, event: RunEvent): Promise<void> {
86-  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
87-}
88-
89-function buildSuccessfulReconciliationFromTransfer(
90-  currentRecord: ReconciliationRecord | undefined,
91-  ownerTransferRecord: OwnerTransferRecord,
92-): ReconciliationRecord {
93-  return {
---
639:async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
640-  const serialized = JSON.stringify(value, null, 2);
641-  const tempPath = buildAtomicTempPath(path);
642-
643-  try {
644-    await writeFile(tempPath, serialized);
645-    await rename(tempPath, path);
646-  } catch (error) {
647-    // Best effort, and intentionally not safeUnlink: cleanup here runs while an error is
648-    // already in flight, and a cleanup failure must not replace the error the caller needs
649-    // to see. safeUnlink rethrows anything that is not ENOENT, which would do exactly that.
650-    try {
651-      await unlink(tempPath);
652-    } catch {
653-      // swallowed on purpose; the original error is rethrown below
654-    }
655-
656-    throw error;
657-  }
658-}
659-
```

`writeRunState` → `writeJsonFileAtomically` = `JSON.stringify` → temp → `rename`。**没有 read-modify-write、没有 expected 参数、没有 owner/epoch 前置条件。「无 CAS」今天成立**，与 GATE-B 的 I-2 记录逐字一致（「stringify -> temp -> rename with NO CAS, no read-modify-write and no owner/epoch precondition」）。

**（4）不可达论证的支点：`.stop()` 的生产调用点**：

```
$ rtk proxy grep -rn "\.stop()" src/; echo "---EXIT=$?"
src/cli.ts:169:// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
src/controller/runLoop.ts:989:    await heartbeat.stop();
src/controller/resumeLoop.ts:215:    await heartbeat.stop();
---EXIT=0
```

3 个命中，其中 `cli.ts:169` 是**注释**，所以**生产调用点恰好 2 个**：`runLoop.ts:989` 与 `resumeLoop.ts:215`。`resumeLoop.ts:215` 的上下文（Read 原样 213–216 行）确认它在 `finally` 里：

```
213	  } finally {
214	    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
215	    await heartbeat.stop();
216	  }
```

**⚠️ 行号腐坏，原样上报**：GATE-B 的 I-2 段记的是「`runLoop.ts:989, resumeLoop.ts:198`」，`gate-c-lane2-report.md` §4.4 记的是「`src/controller/runLoop.ts:989`、`src/controller/resumeLoop.ts:215`」。今天是 **989 / 215**。lane 2 在 GATE-C 上已经把它更新过一次；**GATE-B 台账里的 `:198` 是腐坏的行号**。我不去改台账。

**（5）sweep 的停机机制够不到 heartbeat**（lane 2 §4.4 的论据，我独立复核）：

```
$ rtk proxy grep -n "process.exit\|registerStopHandlers" src/cli.ts; echo "---EXIT=$?"
170:export function registerStopHandlers(
174:  const exit = options?.exit ?? ((code: number) => process.exit(code));
224:      const unregisterStopHandlers = registerStopHandlers(stopRequested);
237:        unregisterStopHandlers();
257:    process.exitCode = code;
---EXIT=0
```

`registerStopHandlers` 的签名（Read 原样 170–174 行）：

```
170	export function registerStopHandlers(
171	  signal: StopRequestSignal,
172	  options?: { exit?: (code: number) => void },
173	): () => void {
174	  const exit = options?.exit ?? ((code: number) => process.exit(code));
```

**它只拿到 `signal` 和一个可注入的 `exit`，闭包里够不到任何 heartbeat。** `cli.ts:169` 的生产注释自己写死了这件事：「The handler is handed the stop SLOT and nothing else. It cannot stop the heartbeat, and does not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.」

#### 今天是否可达 / 是否仍成立

**两条今天都仍然不可达。** 不可达的**同一条**理由（这是 GATE-B 条件 1 的核心洞见，两条债其实是一条线）：

`RunHeartbeatStoppedError` 只在 `leaseHeartbeat.ts:212` 抛出，而抛出它需要 `stopped === true`；`stopped` 只由 `stop()` 置位；`stop()` 的两个生产调用点都在 `await runLoopFromState(...)` **之后**的 `finally` 里；而抛出点 `runExclusive` 的唯一生产调用点在 `runLoopFromState` **内部**。所以在 `runLoopFromState` 执行期间 `stopped` 恒为 false，`:1489` 的分支永不进入，其中的无 CAS `writeRunState` 永不执行；同时，加宽 `isLeaseStopError` 也永远够不到一个真实的 `RunHeartbeatStoppedError`（就算够到了，`:1489` 也会先返回）。

sweep 引入的 `StopRequestSignal` 是**另一套机制**（一个布尔槽），`registerStopHandlers` 的闭包够不到 heartbeat，所以组 C 落地**没有**改变这个结论。

#### 触发条件 —— 写成一句可以贴进未来 brief 的话

> **凡在 `runLoopFromState` 的执行期内引入任何一个 `heartbeat.stop()` 调用点（含把 heartbeat 交给 SIGINT / SIGTERM 处理器、交给常驻 `watch`、或任何让 `stopped` 在循环运行期间变为 true 的接线），或改动 `src/controller/runLoop.ts` 外层 catch 里 `if (error instanceof RunHeartbeatStoppedError)` 与 `if (isLeaseStopError(error))` 这两条分支的顺序、删除前者、或让该错误从内层 catch 逃出者 —— 必须重跑 B1 与 B2 的不可达论证与谓词加宽实验，不得继承本台账的结论；并且，接线提交与所有权守卫的裁定必须在同一个 commit 里落地，因为拆成两个不会有任何测试变红（GATE-B 条件 1）。**

配套必须一起带走的三件事（否则承接方会以为只有一个写点）：

1. **`appendEvent("heartbeat_stopped")` 与 `appendEvent("stop_requested")` 同样是对一个可能已被转移的 run 的无守卫写**（GATE-B 条件 5）。是追加不是覆盖，危害低一档，但站点不止一个。
2. **本门最脆的前提「`stopped` is false for the entire duration of runLoopFromState」没有任何测试守着**，它成立只是因为两个 `stop()` 恰好在 `finally` 里。谁把 heartbeat 交到循环外，三件事同时翻盘而套件全绿。
3. **lane 2 在 GATE-C 上补的放大器**：谓词加宽那条的安全界今天由一份**推理产物**而非测试守着，而 sweep 把这条界的走访次数乘了 N —— 将来任何一波若新增一条绕过终态到 `persistBoundaryAnalysis` 的路由，每一次人类批准的爆炸半径就是 N 倍。

#### 论据是否腐坏

逐条核对，**四条论据全部成立，一条行号腐坏**：

| 论据 | 今天 | 判定 |
|---|---|---|
| `isLeaseStopError` 两个 instanceof、未加宽、未导出 | `runLoop.ts:107-109` | **成立** |
| 加宽半边无测试；只有 subclassing 半边有断言 | `leaseHeartbeat.test.ts:749-757` 四条断言全是类关系 | **成立** |
| 专用分支排在谓词分支之前并提前 return | `:1489` 早于 `:1507`，同一 catch，`:1496 return state` | **成立** |
| `writeRunState` 无 CAS | `fileStore.ts:81-83` → `:639-658` | **成立** |
| `.stop()` 两个生产调用点、都在 `finally` | grep 3 命中其一为注释；`resumeLoop.ts:213-216` 确认 | **成立** |
| GATE-B 记的 `resumeLoop.ts:198` | 今天是 `:215` | **行号腐坏**，lane 2 已在 GATE-C 上更正过，GATE-B 台账未改 |

#### 后果分级

**两条债今天都是「零后果 + 潜在数据丢失」的组合，必须分开说：**

- **今天：零后果。** 不可达 ⇒ 无 CAS 的那次写永不执行，加宽谓词行为惰性。没有任何现有路径会踩到。
- **一旦触发：数据丢失（覆盖，非追加）。** 据以分级的证据：`writeRunState` → `writeJsonFileAtomically` 是 `rename` **整体替换** `loop-state.json`，没有 read-modify-write。如果 B1 的分支被激活而 run 已被转移给新 owner，这次写会把新 owner 的 `loop-state.json` **整份覆盖成一个非终态**。这是本报告里唯一一条后果为「数据丢失」的项 —— 与项 B（假告警）、项 A（仅可操作性）、项 D（仅文档）都不同类。
- **⚠️ 「不可达 ⇒ 可删」是明确被禁止的推论。** GATE-B 的 I-2 人裁是「RECORD IT, DO NOT CHANGE THE CODE」，理由是计划文本有三处把这次写定为无条件且必需，加所有权守卫会**与计划矛盾**（`7b` 的 `expect(persisted).toEqual(finalState)` 会红），加终态守卫则会是永久死代码。**L5 若要动它，必须先处理这个矛盾，不能直接删或直接加守卫。**

#### 我不确定的地方

1. **我没有跑加宽注入实验。** GATE-B 记录的实测是「注入 `|| error instanceof RunHeartbeatStoppedError` 到 `isLeaseStopError`，整套仍全绿（29 files / 487 tests）」。我今天的证据是**控制流推理 + 测试文件读**，不是重跑。而且当时是 487 tests，今天是 514 tests（GATE-C 记录的数字），**新增的 27 个 case 是否有哪一个恰好会在加宽下变红，我没有验证**。这是本项最实质的不确定点：如果 L5 要依赖「加宽仍然惰性」，**必须重跑那次注入**。
2. **我没有核对 `leaseHeartbeat.ts:212` 抛出点的完整前置条件**（只从 grep 确认了它是唯一抛出点），也没有核对 `runExclusive` 的生产调用点今天是否仍然只有一个、且仍然在 `runLoopFromState` 内部。这两条是不可达论证的直接支点，**我是从 GATE-B / lane 2 的记录继承的，不是自己推的**。
3. **`runLoop.ts:1109` 那处 `isLeaseStopError`（内层 catch）我没有读上下文。** GATE-B 的 gap 描述里提到「让这个错误逃出 INNER catch」是触发条件之一，我没有独立确认内层 catch 今天的形状。
4. **`appendEvent("stop_requested")` 我没有在 `src/` 里定位过**（GATE-B 条件 5 点名了它）。本次 grep 没有覆盖这个字符串。

### 项 E：GATE-C 上分诊的 deferred minor 清单

**⚠️ 本项未完成。缺的是：15 条里有 6 条我只做了「台账原话抽取 + 归类」，没有对今天的代码/文档做独立复核** —— 具体是 C1-M4、C1-M5、C3-M1、C3-M2、C3-M4、C4-M1（每条下方都标了「**未复核**」）。其余 9 条已复核。另外，**GATE-C 的分诊结论没有落进 ledger**，这本身是本项最重要的发现，见末尾。

#### 条数

```
$ rtk proxy grep -c "^Task C[1-4]: minor (deferred" .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md; echo "--- and the list:"; rtk proxy grep -n "^Task C[1-4]: minor (deferred" .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
15
--- and the list:
1237:Task C1: minor (deferred): C1-M1 *** the one C3 must not inherit blindly. ***
1242:Task C1: minor (deferred): C1-M2 — the banner-ordering test pins the banner's
1246:Task C1: minor (deferred): C1-M3 — the `rootFailure → stderr + return 1` path is
1291:Task C1: minor (deferred): C1-M4 — the report says the wrong-repo run was
1295:Task C1: minor (deferred): C1-M5 — §5's three PRE-implementation red fences were
1356:Task C2: minor (deferred): C2-M1 — the report claims coverage of "--max-runs as
1360:Task C2: minor (deferred): C2-M2 — C2 only JSON.parses the adapter config without
1365:Task C2: minor (deferred): C2-M3 — the exit table's "bad argument" square has no
1367:Task C2: minor (deferred, FOR THE GATE TO RULE): C2-M4 — this change invalidates
1441:Task C3: minor (deferred): C3-M1 — the summary line's `attempted` and its three
1445:Task C3: minor (deferred): C3-M2 — `tally` carries five write-only cells (Rule 2
1514:Task C3: minor (deferred): C3-M4 — §3.1's prediction table still carries the
1517:Task C3: minor (deferred): C3-M5 — the immediate-vs-buffered distinction hangs
1572:Task C4: minor (deferred): C4-M1 — 14b asserts the marker and three pendings are
1572:Task C4: minor (deferred): C4-M2 — four historical SDD documents cite
```

> **勘误（我自己的转录）**：上面最后一行的行号我误抄成 `1572`，原始输出是 `1576:Task C4: minor (deferred): C4-M2 — four historical SDD documents cite`。命中数 15 与其余各行逐字。

**ledger 里 15 条。C3-M3 不在其中**（它是 `minor (folded into fix round 1)`，已在修复轮里关闭，不是 deferred）。

**另有 3 条 GATE-C 明确承诺「记在下面」但 ledger 里根本没有**：

```
$ rtk proxy grep -n "C2-M5\|C2-M6\|C3-M6" .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-c-lane2-report.md; echo "---EXIT=$?"
14:2. 补记四条清单漏掉的缺陷：C2-M5 / C2-M6 / C3-M6，以及 C4 §B 一处论证错误（§5）。
247:→ **补记为 C2-M5，带到 L5，与 C1-M3 同一个承接方。**
252:→ **补记为 C2-M6，带到 L5。**
262:→ **补记为 C3-M6，带到 L5。** concerns 2（双空格 vs tab）与 6（12d(i) 断言顺序被调整过）属流程/外观，**只记录**即可。
```

而在 ledger 里搜同样三个 ID：

```
$ rtk proxy grep -n "C2-M5\|C2-M6\|C3-M6\|C1-M\|C2-M\|C3-M\|C4-M" .superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md
1237:Task C1: minor (deferred): C1-M1 *** the one C3 must not inherit blindly. ***
1242:Task C1: minor (deferred): C1-M2 — the banner-ordering test pins the banner's
1246:Task C1: minor (deferred): C1-M3 — the `rootFailure → stderr + return 1` path is
1291:Task C1: minor (deferred): C1-M4 — the report says the wrong-repo run was
1295:Task C1: minor (deferred): C1-M5 — §5's three PRE-implementation red fences were
1356:Task C2: minor (deferred): C2-M1 — the report claims coverage of "--max-runs as
1360:Task C2: minor (deferred): C2-M2 — C2 only JSON.parses the adapter config without
1365:Task C2: minor (deferred): C2-M3 — the exit table's "bad argument" square has no
1367:Task C2: minor (deferred, FOR THE GATE TO RULE): C2-M4 — this change invalidates
1433:C1-M1 WAS SOLVED, NOT INHERITED: every summary cell is now derived from the
1441:Task C3: minor (deferred): C3-M1 — the summary line's `attempted` and its three
1445:Task C3: minor (deferred): C3-M2 — `tally` carries five write-only cells (Rule 2
1450:Task C3: minor (folded into fix round 1): C3-M3 — report §3.3's arithmetic
1514:Task C3: minor (deferred): C3-M4 — §3.1's prediction table still carries the
1517:Task C3: minor (deferred): C3-M5 — the immediate-vs-buffered distinction hangs
1572:Task C4: minor (deferred): C4-M1 — 14b asserts the marker and three pendings are
1576:Task C4: minor (deferred): C4-M2 — four historical SDD documents cite
1578:  B2-M4 and C2-M4; GATE-C should rule on all of them together rather than
1631:below as C2-M5, C2-M6, C3-M6 and two doc items.
1774:  sentences still citing "a single array push" as a premise; group B's two
```

**`:1631` 承诺「they are logged below as C2-M5, C2-M6, C3-M6 and two doc items」，而 `:1631` 之后的 ledger 里这三个 ID 一次都没再出现，「两条 doc items」也没有。** 承诺未兑现。

**所以 L5 的实际输入是 15 + 3 = 18 条**（其中 3 条只存在于 `gate-c-lane2-report.md`），外加 lane 1 的 3 条 Minor（见末尾「缺口」）。

---

#### C1 组（5 条）

**C1-M1** —— 原话逐字：

> ```
> Task C1: minor (deferred): C1-M1 *** the one C3 must not inherit blindly. ***
>   In sweepRuns' catch, `refused += 1` is not mutually exclusive with `adopted`,
>   so a run that was adopted and then threw is counted BOTH as adopted and as not
>   started ("1 adopted, 1 not started, of 3 eligible"). The FORMAT belongs to C3
>   but the COUNTING SEMANTICS are set here. C3's brief must carry this.
> ```

- **今天**：**已关闭，不成立。** ledger `:1433` 自己记了「C1-M1 WAS SOLVED, NOT INHERITED」；我在 `src/sweep/sweepRuns.ts` 上独立确认：今天没有 `refused += 1`，取而代之是 `tally[report.outcome] += 1`，而 `report` 在 try 与 catch 两条路上**各恰好被赋值一次**，`Outcome` 是 8 值联合，`tally` 是 `Record<Outcome, number>`。一个 run 只能落进一格。
- **代码 / 文档**：代码。
- **L5 该不该接**：**依据陈述** —— 此条已由 C3 在本波内解决并有 ledger 记录与源码佐证；把它带进 L5 只会让承接方去找一个不存在的 `refused += 1`。

**C1-M2** —— 原话逐字：

> ```
> Task C1: minor (deferred): C1-M2 — the banner-ordering test pins the banner's
>   FULL literal text while the brief says the banner's format belongs to C3, and
>   12b(a) in the same file uses toContain. A one-word change in C3 reds a test
>   whose subject is ordering, not wording.
> ```

- **今天**：**仍成立，且已被 GATE-C 的修复轮实证放大。** 复核命令与完整输出：

```
$ rtk proxy grep -n "observed eligibleForContinuation=true" src/ tests/ docs/ -r; echo "---EXIT=$?"
src/sweep/sweepRuns.ts:146:    `sweep: ${candidates.length} run(s) under ${options.root} observed eligibleForContinuation=true ` +
tests/cli/cli.test.ts:313:      // `observed eligibleForContinuation=true` is that fragment and is unique to the banner
tests/cli/cli.test.ts:317:      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("observed eligibleForContinuation=true");
tests/cli/cli.test.ts:338:        expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("observed eligibleForContinuation=true");
tests/cli/cli.test.ts:357:      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("observed eligibleForContinuation=true");
tests/sweep/sweepRuns.test.ts:354:      `stderr:sweep: 1 run(s) under ${ROOT} observed eligibleForContinuation=true ` +
tests/sweep/sweepRuns.test.ts:392:      `stderr:sweep: 3 run(s) under ${ROOT} observed eligibleForContinuation=true ` +
tests/sweep/sweepRuns.test.ts:653:      `sweep: 1 run(s) under ${ROOT} observed eligibleForContinuation=true ` +
tests/registry/zeroWrite.test.ts:529:        `sweep: 1 run(s) under ${scanRoot} observed eligibleForContinuation=true ` +
tests/registry/zeroWrite.test.ts:820:        `sweep: 1 run(s) under ${scanRoot} observed eligibleForContinuation=true ` +
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1648:  `sweep: <eligible> run(s) under <root> observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most <N>, adapter=<name>`
docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1578:  **`sweep: <eligible> run(s) under <root> observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most <N>, adapter=<name>`**
---EXIT=0
```

> **勘误（我自己的转录）**：倒数第二/第三行我把两处文档命中的文件名/行号抄乱了。原始输出的最后两行是
> `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md:1648:` 与
> `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1560:`。
> 即一处在 plan:1648、一处在 **spec:1560**（不是 plan:1578）。其余各行逐字。

  横幅字面量今天被钉在 **1 处生产 + 5 处正向断言 + 3 处 `not.toContain` + 2 处文档**。GATE-C 的修复轮正是因为改了这个字面量而让三条 `not.toContain` 静默变成永不失败（ledger 记为「FIFTEEN WAVES IN A ROW」的那次自伤），并因此产出了常设规则 1。
- **代码 / 文档**：代码（测试）。
- **L5 该不该接**：**依据陈述** —— 耦合面今天比 C1-M2 提出时更宽（10 个测试站点 + 2 个文档站点），且 GATE-C 已经为这个形状付过一次缺陷代价并立了常设规则；但规则本身（「改输出字面量时同一 commit 里重扫 negative 家族」）是否已经足够、还是需要把断言重构成不依赖全文，是判断题。

**C1-M3** —— 原话逐字：

> ```
> Task C1: minor (deferred): C1-M3 — the `rootFailure → stderr + return 1` path is
>   this layer's ONLY non-zero exit and has NO test. The plan's four required tests
>   do not ask for one, so this is not a violation; if a later edit turns it into
>   `return 0`, §7's whole error contract fails silently and nothing reds.
> ```

- **今天**：**⚠️ 论据在今天的代码上不成立 —— 这条已经有测试了。** 复核证据（`tests/cli/cli.test.ts`，Read 原样 363–378 行）：

```
363	  // §7: the scan failing at its OWN root is the only per-scan condition that exits non-zero. The
364	  // stderr assertion is what distinguishes it from the argument failures above, which would also
365	  // be exit 1 — this run got as far as the scan and the scan is what refused.
366	  it("exits 1 when the root does not exist", async () => {
367	    const { adapterConfigPath } = await seedSweepRoot();
368	    const missingRoot = join(await mkdtemp(join(tmpdir(), "ccloop-sweep-missing-")), "does-not-exist");
369	    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
370	    try {
371	      await expect(
372	        main(["sweep", "--root", missingRoot, "--adapter", "scripted", "--adapter-config", adapterConfigPath, "--max-runs", "1"]),
373	      ).resolves.toBe(1);
374	      expect(errorSpy.mock.calls.flat().join("\n")).toContain(`sweep: cannot scan ${missingRoot}`);
375	    } finally {
376	      errorSpy.mockRestore();
377	    }
378	  });
```

  而 `src/cli.ts` 的 sweep 分支把 `sweepRuns` 的返回值**直接**当作 exit code（Read 原样 226–238 行）：

```
226	      try {
227	        return await sweepRuns({
228	          root: parsed.root,
...
235	        });
236	      } finally {
237	        unregisterStopHandlers();
238	      }
```

  所以把 `sweepRuns` 那条 `return 1` 改成 `return 0`，`:373` 的 `resolves.toBe(1)` **会红**。C1-M3 的假设情景（「nothing reds」）今天为假。
  **⚠️ 更要紧的是：`gate-c-lane2-report.md` §5.2 在 GATE-C 上把 C1-M3 当作仍然成立的对照物**，用它论证 C2 concern 8 分诊不对称（逐字：「C1-M3（「本层唯一的非零退出路径无测试」）**被记成了 deferred minor**；形状完全相同的这一条**没有**」）。而这条测试是 C2 自己加的，**在 GATE-C 之前就已经存在**。也就是说 lane 2 的那条 Important（C2-M5 的由来）建立在一个当时就已过期的前提上。**我原样上报，不自裁分级，也不推翻 C2-M5 —— C2-M5 自身的事实（`process.exit` 默认分支无覆盖）我另行复核为成立，见下。**
- **代码 / 文档**：代码（测试）。
- **L5 该不该接**：**依据陈述** —— 条目所述的覆盖缺口今天已被填上，但填上它的测试与条目不在同一层（条目说的是 sweep 层，测试在 CLI 层）；是否算「已关闭」取决于要不要在 `tests/sweep/sweepRuns.test.ts` 里也有一条同语义的单测。

**C1-M4** —— 原话逐字：

> ```
> Task C1: minor (deferred): C1-M4 — the report says the wrong-repo run was
>   "disclosed in full"; it is a PARAPHRASE, not a pasted terminal block. Not
>   fabrication (it never poses as real output) but the wording overstates it. Same
>   family as group A's false sentence about `git rev-parse --short`.
> ```

- **今天**：**未复核。** 我没有打开 `task-C1-report.md` 去看那句措辞今天还在不在。
- **代码 / 文档**：文档（任务报告）。
- **L5 该不该接**：**依据陈述** —— 落点是一份历史任务报告；本仓库对 B2-M4/C4-M2 那一族的既有立场是「不重写历史文档」，但那一族是**行号腐坏**，这一条是**措辞夸大**，不是同一种东西，先例是否适用需要人判。

**C1-M5** —— 原话逐字：

> ```
> Task C1: minor (deferred): C1-M5 — §5's three PRE-implementation red fences were
>   abridged (source-context frames and the [1/1] separator are missing) and CANNOT
>   be re-run: the intermediate state they pinned no longer exists now that quota
>   and the stop check are implemented. The implementer did NOT fabricate a
>   replacement, and the judging information (× line, `1 failed | N skipped`, the
>   AssertionError's expected/actual) is verbatim intact. FOR GATE-C's EVIDENCE LANE
>   TO TRIAGE: is that sufficient, or must the intermediate state be reconstructed
>   and re-run? The controller does not rule it either way — the three mutation
>   experiments cover neighbouring ground with complete fences, but whether they
>   cover the SAME assertions is exactly what the gate should check rather than
>   assume.
> ```

- **今天**：**未复核**（我没有重跑注入、也没有读 `task-C1-report.md` 的 §5）。**但它在 GATE-C 上被明确裁掉了**，`gate-c-lane2-report.md` §4.1 逐字：「**裁定：只记录，不重建。** 重建一个已被删除的中间态，产出的证据会**弱于**今天已经存在的三重击杀。要求重建等于用更差的证据替换更好的证据。**这条 open 问题就此关闭。**」—— **而这个裁定没有落进 ledger。**
- **代码 / 文档**：文档（证据）。
- **L5 该不该接**：**依据陈述** —— lane 2 已裁「关闭」，但裁定只存在于 lane 2 报告里；ledger 上它仍以未分诊的 deferred minor 形态躺着。承接方读 ledger 会以为它是 open 的。

#### C2 组（4 条 ledger + 2 条只在 lane 2 报告里）

**C2-M1 / C2-M2 / C2-M3** —— 原话逐字：

> ```
> Task C2: minor (deferred): C2-M1 — the report claims coverage of "--max-runs as
>   the last token with no value" but only the fully-absent case is tested. A benign
>   refactor of the pairing loop (`?? "1"`) would silently start a sweep with
>   maxRuns=1 and all eight new tests stay green.
> Task C2: minor (deferred): C2-M2 — C2 only JSON.parses the adapter config without
>   validating its shape, and createAdapter() is invoked after the banner and
>   outside the per-run try. `--adapter-config` pointing at `{}` prints the banner,
>   then throws a TypeError out of the scripted adapter → exit 1, a square the exit
>   table's wording does not cover. Same shape as the pre-existing run/resume paths.
> Task C2: minor (deferred): C2-M3 — the exit table's "bad argument" square has no
>   `it` under `main sweep` (e.g. `--adapter bogus` → exit 1 is untested).
> ```

复核命令与完整输出（`main sweep` 一族的 `it` 全名单）：

```
$ rtk proxy grep -n 'it("' tests/cli/cli.test.ts
12:  it("parses the run command", () => {
34:  it("returns exit code 1 when required flags are missing", async () => {
38:  it("returns 0 for the scripted example run", async () => {
58:  it("parses a resume command", () => {
63:  it("still parses a run command", () => {
68:  it("prints the refusal reason to stderr when resume is refused (spec §9)", async () => {
85:  it("parses a positional root with no --json flag", () => {
93:  it("parses --json", () => {
103:  it("parses --json before the positional root", () => {
113:  it("does not require --adapter, --adapter-config, or --contract", () => {
117:  it("throws when the root argument is missing", () => {
123:  it("exits 1 when the root does not exist — the scan itself failed", async () => {
128:  it("exits 0 for a scan that produces an unreadable row, never 2", async () => {
141:  it("emits a parseable ScanResult with schemaVersion 1 under --json", async () => {
163:  it("prints the human table by default, including the independent-observation notice", async () => {
277:  it("parses --root, --adapter, --adapter-config and --max-runs", () => {
292:  it("rejects a positional root, which the flag/value pairing would misread", () => {
303:  it("exits 1 when --max-runs is missing", async () => {
323:  it("exits 1 when --max-runs is not a positive integer", async () => {
347:  it("exits 1 when the adapter config cannot be read", async () => {
366:  it("exits 1 when the root does not exist", async () => {
383:  it("exits 0 when a run reaches exhausted", async () => {
414:  it("sets the slot on the first signal and exits 130 on the second, counting SIGINT and SIGTERM together", () => {
```

```
$ rtk proxy grep -rn "bogus\|unknown adapter\|buildAdapter" tests/cli/cli.test.ts src/cli.ts; echo "---2EXIT=$?"
src/cli.ts:147:function buildAdapter(adapter: "scripted" | "claude", config: unknown): RuntimeAdapter {
src/cli.ts:160:  return buildAdapter(parsed.adapter, JSON.parse(await readFile(parsed.adapterConfigPath, "utf8")) as unknown);
src/cli.ts:230:          createAdapter: () => buildAdapter(adapterName, config),
---2EXIT=0
```

- **C2-M1 今天：仍成立。** sweep 一族的 `it` 里只有「`--max-runs` is missing」（`:303`）与「not a positive integer」（`:323`），**没有**「last token with no value」。
- **C2-M2 今天：未独立复核 shape 校验的缺失**，但 `src/cli.ts:221` 的 sweep 分支确实只 `JSON.parse` 不校验（见项 A 引用的 `cli.ts:218-239`），且 `createAdapter` 在 `sweepRuns` 里被调用于横幅之后、`for` 循环之外（`sweepRuns.ts:151`）。**结构前提成立**；我没有跑那个 `{}` 场景。
- **C2-M3 今天：仍成立。** 上面两条 grep 里 `tests/cli/cli.test.ts` 对 `bogus` 零命中，`main sweep` 的 23 个 `it` 里没有一条打 bad adapter。
- **代码 / 文档**：三条都是代码（测试覆盖）。
- **L5 该不该接**：**依据陈述** —— 三条同属「退出码表的某一格没有 `it`」，都是**静默失效**形状（重构后全绿）；但三条都不是当前可观察的缺陷，且 C2-M2 那一格连表的措辞都还没覆盖，所以它至少一半是文档问题。

**C2-M4** —— 原话逐字：

> ```
> Task C2: minor (deferred, FOR THE GATE TO RULE): C2-M4 — this change invalidates
>   three line-number citations in docs/superpowers/specs/2026-08-01-…-design.md
>   (:131/:135/:130 are now 244/248/241). The implementer did NOT touch them: they
>   are outside the Files list and this repo's stance is not to rewrite historical
>   documents. But unlike B2-M4's 2026-07-27 documents, this is the CURRENT L3
>   spec, so the precedent is not obviously the same. GATE-C should rule.
> ```

- **今天：仍成立，且站点数比条目说的多一个。** 复核：

```
$ rtk proxy grep -n "? 0 : 2\|resumeLoop(" src/cli.ts; echo "---EXIT=$?"
213:    // `sweep` returns HERE — before loadAdapter, not merely before the two `? 0 : 2` mappings
243:      const finalState = await resumeLoop(parsed.runDir, adapter);
244:      return finalState.status === "succeeded" ? 0 : 2;
248:    return finalState.status === "succeeded" ? 0 : 2;
---EXIT=0
```

  今天两处 `? 0 : 2` 在 **244 / 248**，`loadAdapter` 在 **241**（见项 A 引用的 `cli.ts:241`）—— 与 C2-M4 预告的 244/248/241 **完全一致**。spec 侧的引用站点：

```
$ rtk proxy grep -n "zeroWrite.test.ts:92\|zeroWrite.test.ts:187\|cli.ts:131\|cli.ts:135\|cli.ts:130" -r docs/ .superpowers/; echo "---EXIT=$?"
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:661:1. **爆炸半径**：`runLoopFromState` 与 `resumeLoop` 的返回值是被广泛依赖的公开面（`src/cli.ts:131`/`:135` 的 `finalState.status ? 0 : 2`，以及全部 14 个 `resumeLoop` 调用点）……
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:668:   #   14 = 12 + 1 + src/cli.ts:130 那一处
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:1499:# 实测 2 处：src/cli.ts:131（resume 分支）、src/cli.ts:135（run 分支）。
docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md:2958:| `resumeLoop` 调用点 14 个 | … | 14 | **本波新增**（12 … ＋ 1 … ＋ 1 `src/cli.ts:130`） |
.superpowers/sdd/2026-07-28-run-registry/progress.md:24:Task 5: load-bearing assertion IS committed (zeroWrite.test.ts:187), not merely narrated …
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/progress.md:1577:  zeroWrite.test.ts:92 and :187, now shifted by the added imports. …
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/gate-c-lane2-report.md:214:- **B2-M4 与 C4-M2 → 只记录，永不修。** …
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-C4-report.md:680: …
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/task-C2-report.md:1055: …
.superpowers/sdd/2026-08-02-sweep-and-transactional-continuation/group-c-preflight-scan.md:278:src/cli.ts:131:      return finalState.status === "succeeded" ? 0 : 2;
---EXIT=0
```

> **说明**：上面这条 grep 的原始输出共 14 行，我在贴的时候对其中 6 行（正文极长的引用行）用 `…` 截断了尾部。**这是本报告第二处、也是最后一处对输出的削短，明写在此。** 被截断的都是 `.superpowers/` 下报告文件里的转引行，不影响本条判定；spec 的四个站点（`:661` `:668` `:1499` `:2958`）是完整的。

  **⚠️ lane 2 §4.3 说站点是「`:661`、`:668`、`:1499`、`:2948`」；今天第四个在 `:2958`。** 差 10 行，与 HEAD 前一个 commit `b9afbf3` 往 spec `:1578` 插入勘误的位置一致。**即 lane 2 报告里那条「更正 C2-M4 行号」的记录，自己也已经行号腐坏了。** 原样上报。
- **代码 / 文档**：文档（当前 L3 spec）。
- **L5 该不该接**：**依据陈述** —— lane 2 §4.3 已给出裁定与根因方案（逐字：「**统一裁定（根因，只需应用一次）**：**在这份 spec 里，凡已随附符号名或重推命令的引用，一律把行号锚点换成「符号 + grep 命令」锚点。** 建议 GATE 把它记成常设规则——这一族在组 B 与组 C 各复发一次，靠逐条打补丁是止不住的。」），**但这个裁定没有落进 ledger，也没有出现在 GATE-C 的四条人裁里**；同时 C4-M2 明写「GATE-C should rule on all of them together」，而 GATE-C 的人裁清单里没有这一条。

**C2-M5 / C2-M6**（只在 `gate-c-lane2-report.md`，ledger 缺）—— 原话逐字：

> `registerStopHandlers` 的默认分支 `(code) => process.exit(code)` **没有被任何测试执行过**（13b 覆盖的是注入口那一侧）。
> C1-M3（「本层唯一的非零退出路径无测试」）**被记成了 deferred minor**；形状完全相同的这一条**没有**。同一个缺陷形状在同一组里被两种标准处理。
> → **补记为 C2-M5，带到 L5，与 C1-M3 同一个承接方。**

> 13b 用 `process.emit("SIGINT", …)` 触发**真实的进程处理器**。它在 vitest 2.1.9 默认 pool 下不影响 runner，但换 pool（`threads` ↔ `forks`）或换 vitest 大版本时需要重测。**这是一条静默失效触发器，没有任何地方记着它。**
> → **补记为 C2-M6，带到 L5。**

- **C2-M5 今天：事实成立。** 复核：

```
$ rtk proxy grep -rn "registerStopHandlers" tests/; echo "---1EXIT=$?"
tests/cli/cli.test.ts:7:import { main, parseArgs, registerStopHandlers } from "../../src/cli.js";
tests/cli/cli.test.ts:410:describe("registerStopHandlers", () => {
tests/cli/cli.test.ts:419:    const unregister = registerStopHandlers(signal, { exit: (code) => { exitCodes.push(code); } });
---1EXIT=0
```

  唯一的调用（`:419`）注入了 `exit`，所以 `cli.ts:174` 的 `?? ((code) => process.exit(code))` 默认分支从未被执行。**但它的论证支柱（与 C1-M3 的对称性）今天已经塌了** —— 见上文 C1-M3。**事实成立、论证支柱腐坏，两者要分开看。原样上报。**
- **C2-M6 今天：未独立复核**（我没有查 vitest 版本与 pool 配置）。
- **代码 / 文档**：C2-M5 代码；C2-M6 代码（测试脆性）。
- **L5 该不该接**：**依据陈述** —— 两条都**根本不在 ledger 里**，只在一份 lane 2 报告里；若 L5 只读 ledger，它们会整条消失。这一点比条目本身的轻重更要紧。

#### C3 组（4 条）与 C4 组（2 条）

**C3-M1 / C3-M2 / C3-M4** —— 原话逐字：

> ```
> Task C3: minor (deferred): C3-M1 — the summary line's `attempted` and its three
>   outcome cells are not addable: failed/exhausted/blocked_waiting_human/
>   cancelled/interrupted fall into no cell at all. This is the plan's own mandated
>   format, not a task defect, but it is quieter than the C1 line it replaced.
> Task C3: minor (deferred): C3-M2 — `tally` carries five write-only cells (Rule 2
>   would call them surplus). The reviewer judged them acceptable: the
>   Record<Outcome, number> shape is what makes "exactly one cell per attempted
>   run" a TYPE-LEVEL property, and collapsing to three variables would lose the
>   exhaustiveness check over the Outcome domain. Recorded, not to be "cleaned up".
> Task C3: minor (deferred): C3-M4 — §3.1's prediction table still carries the
>   "17 + 4" arithmetic that §3.3 corrected to 13 + 4 = 17. Same typo family, one
>   place further up, documentation only.
> ```

- **C3-M1 / C3-M2 今天：未逐条复核**（我读过 `sweepRuns.ts` 的汇总行与 `tally`，形状与描述一致 —— 汇总行只印 `succeeded`/`refused`/`error` 三格而 `tally` 有八格 —— 但我没有把「五个只写不读的格」逐个数出来，也没有验证 C3-M1 列的那五个 status 确实无处可落）。
- **C3-M4 今天：未复核**（我没有打开 `task-C3-report.md` §3.1）。
- **代码 / 文档**：C3-M1 代码（输出格式，且是计划自己规定的）；C3-M2 代码（Rule 2 的取舍，评审已判可接受）；C3-M4 文档。
- **L5 该不该接**：**依据陈述** —— C3-M2 已被评审明确判为「Recorded, not to be 'cleaned up'」，把它当 TODO 接手会**违反**那条记录；C3-M1 触及的是计划规定的格式，改它需要改计划；C3-M4 是纯文档 typo。三者轻重与性质都不同，不宜作为一族处理。

**C3-M5** —— 原话逐字：

> ```
> Task C3: minor (deferred): C3-M5 — the immediate-vs-buffered distinction hangs
>   on ONE assertion, and that assertion only works while 12d(ii)'s stub still
>   throws after the note (two stderr lines are needed before order means
>   anything). Remove that throw later and the distinction vanishes silently with
>   the suite still green.
> ```

- **今天：结构前提仍成立。** 我在 `src/sweep/sweepRuns.ts` 上确认回调今天确实是「当场 `options.stderr`」（见项 D 引用的 `:205-209`），所以「immediate vs buffered」这个区分确实是活的性质；而 ledger 自己在两处独立记了「整套里只有一条断言能分辨」（C3 fix round 1 的实施者自述、以及 scoped re-review 的复核：「under the buffering injection exactly ONE assertion in the whole file reds」）。**我没有重跑那次 buffering 注入。**
- **⚠️ 与 lane 2 的 C3-M6 是同一个失效面的两半**：C3-M5 说「immediate/buffered 只有一条断言守着」，C3-M6 说「遍历顺序由一条**已被实测证明对 note 管线重构失明**的断言（12d(i)）守着」。**两条合起来是：note 管线今天的两条性质，各由一条脆弱断言守着，而其中一条已知失明。** ledger 只有前一半。
- **代码 / 文档**：代码（测试）。
- **L5 该不该接**：**依据陈述** —— 这是项 D 那条人裁（「immediate write 买到的是 SIGKILL 下不丢告警」）的**唯一守卫**；守卫塌了，人裁买到的性质会静默消失，而项 D 的 spec 论据同时还在腐坏状态。三者是同一条线上的。

**C4-M1 / C4-M2** —— 原话逐字：

> ```
> Task C4: minor (deferred): C4-M1 — 14b asserts the marker and three pendings are
>   reclaimed but not that finalize's own six temp paths leave no residue; a
>   success path that forgot to unlink .owner-record.publish.tmp keeps 14b green.
>   The plan's clause (ii) only asked for the marker and the pendings.
> Task C4: minor (deferred): C4-M2 — four historical SDD documents cite
>   zeroWrite.test.ts:92 and :187, now shifted by the added imports. Same family as
>   B2-M4 and C2-M4; GATE-C should rule on all of them together rather than
>   one at a time.
> ```

- **C4-M1 今天：未复核**（我没有读 `tests/registry/zeroWrite.test.ts` 的 14b）。
- **C4-M2 今天：仍成立，且已被 lane 2 裁定但未落账。** 上面那条 grep 显示 `zeroWrite.test.ts:92`/`:187` 的引用今天仍在 `.superpowers/sdd/2026-07-28-run-registry/progress.md:24`、本波 `progress.md:1577`、`task-C4-report.md:680` 等处；lane 2 §4.3 的裁定逐字：「**B2-M4 与 C4-M2 → 只记录，永不修。**……改写一份历史台账，危害大于一个过期行号。本仓库既有立场（不重写历史文档）在这里完全适用。」
- **代码 / 文档**：C4-M1 代码（测试）；C4-M2 文档。
- **L5 该不该接**：**依据陈述** —— C4-M2 已有明确裁定「永不修」，接它等于推翻裁定；但该裁定同样只存在于 lane 2 报告里。C4-M1 与项 B 同源（都出自 C4 的 14b），若 L5 要动 resume 读侧顺序，14b 大概率要重写，届时这条缺口顺带可关。

#### 本项的缺口，明写

1. **6 条未做独立复核**：C1-M4、C1-M5、C3-M1、C3-M2、C3-M4、C4-M1（另 C2-M2、C2-M6、C3-M5 只做了部分复核，已在各条下标注）。
2. **⚠️ GATE-C 的 deferred-minor 分诊结论**（ledger `:1589` 说 lane 2 的职责之一就是「deferred-minor triage」，`:1775` 说「the deferred-minor list triaged at this gate」）**在 ledger 里找不到逐条落点**。对照 GATE-B —— 它有一段 `DEFERRED-MINOR TRIAGE (lane 2): B1 M-2 record only; B2 M-1 UPGRADED …; B2 M-2 carry to group C …; B2 M-3 … carry to group C; B2 M-4 … record only` —— **GATE-C 的同位段落不存在**。分诊实际发生在 `gate-c-lane2-report.md` §4.1/§4.3 里（我引用了三条），但**没有被搬进 ledger**。L5 若按台账「唯一可信进度源」的约定只读 ledger，会拿到 15 条**未分诊**的条目，而不是 18 条**已部分分诊**的条目。
3. **lane 1 的 3 条 Minor 我完全没有拿到。** ledger `:1588` 记 lane 1 是「PASS WITH CONDITIONS, 0 Critical, 2 Important, 3 Minor」，两条 Important 在人裁 I-1/I-2 里有落点，**但那 3 条 Minor 在 ledger 里一个字都没有**。要拿到它们必须读 lane 1 的报告 —— 我没有定位到 lane 1 报告的文件名（目录里有 `gate-c-lane2-report.md` 与 `gate-c-fix-wave-report.md`，**没有** `gate-c-lane1-report.md`）。**这可能意味着 lane 1 的报告根本没有落盘。** 这是我在本项里最不确定、也最值得下一个人先查的一件事。
4. **`:1631` 承诺的「two doc items」我没有找到。** 三个 ID（C2-M5/M6/C3-M6）我在 lane 2 报告里定位到了，但那两条 doc items 既不在 ledger、我也没有在 lane 2 报告 §5 里辨认出哪两条是它们（§5 说「六条。其中一条是 Important」，我只逐字读了 §5.1–§5.5）。

#### 我不确定的地方（本项）

- 上面四条缺口即是。此外：**我没有验证 `gate-c-lane2-report.md` 本身是否被 ledger 以外的任何索引引用**，所以「若只读 ledger 就会丢 3 条」这个判断，取决于承接方的实际读法，不是我能定的。

---

## 我发现的、原文没写的东西

按「若不上报就会被继承为已关闭」的严重度排序。**这些全部是观察 + 证据，不是裁定。**

1. **GATE-C 的 deferred-minor 分诊结论从未落进 ledger。** GATE-B 有一整段 `DEFERRED-MINOR TRIAGE (lane 2): …` 逐条写处置；GATE-C 的同位段落**不存在**，分诊实际只活在 `gate-c-lane2-report.md` §4.1/§4.3 里。ledger `:1775` 却写着「the deferred-minor list triaged at this gate」——**承接方会以为分诊已入账。**
2. **ledger `:1631` 承诺「they are logged below as C2-M5, C2-M6, C3-M6 and two doc items」，而 `:1631` 之后这三个 ID 在 ledger 里一次都没出现。** 承诺未兑现。L5 的真实输入是 18 条而非 15 条。
3. **lane 1 的报告可能根本没有落盘。** 目录里有 `gate-b-lane2-report.md`、`gate-c-lane2-report.md`、`gate-c-fix-wave-report.md`，**没有任何 lane 1 报告**。而 lane 1 的 3 条 Minor 在 ledger 里零记录。这是「两名独立评审员」这套流程里**只有一半留下了可追溯物**。
4. **C1-M3 的论据在今天的代码上不成立**（`tests/cli/cli.test.ts:366` 已经守住了那条 `return 1`），**而 lane 2 在 GATE-C 上把 C1-M3 当作仍然成立的对照物**，用它论证 C2-M5 的分诊不对称。C2-M5 自身的事实我复核为成立，但它的论证支柱当时就已过期。
5. **台账把两条不同论证的 copy 关系记混了一半。** `spec:751` 的孪生句是 `plan:876`，不是 `plan:1004`；`plan:1004` 是 `spec:692` 的孪生句。而 `plan:876` **从未被点名**，至今无勘误。
6. **「一次数组 push」这一族腐坏站点是 9 处不是 3 处**，其中 6 处无勘误（`spec:681`、`spec:692`、`spec:751`、`plan:876`、`plan:1004`、`plan:1999`）。`spec:681` 是一张**会被照抄的实现表**，照抄它就会重新引入人裁推翻过的缓冲失效模式。
7. **spec §12 `:2306` 那句「`--max-runs` 界的是付费调用」是漏同步的旧措辞** —— §6 自己在第四轮已就地更正为「界的是进入 `runLoopFromState` 的 run 数，付费上界是 N × maxAttempts」。**这一处论据腐坏从未被记成任何一笔债。**
8. **lane 2 §4.3 那条「更正 C2-M4 行号」的记录，自己已经行号腐坏**（它写 `:2948`，今天是 `:2958`，差值与 `b9afbf3` 插入的勘误长度一致）。**行号锚点在这个仓库里已经腐坏到第三层：代码 → spec → 纠正 spec 的报告。** lane 2 提的根因方案（「一律换成符号 + grep 命令锚点」）没有被 GATE-C 采纳成规则。
9. **GATE-B 台账里 `resumeLoop.ts:198` 是腐坏行号**，今天是 `:215`（lane 2 在 GATE-C 上已更新，GATE-B 台账未改）。
10. **项 B 的裸读实际是 4 个不是 3 个**（`loadContract` 也是裸 `readFile`）。把它排除在「与 finalize 竞争」之外有正当理由（`loop-contract.json` 不在 finalize 的 rename 集合里），但两个数字不同，L5 需要知道。
11. **项 B 的「一次浪费的 sweep slot」准确说是「一次浪费的 `attempted`」，配额（`adopted`）并未被消耗** —— `onAdopted` 在抛出点之后。
12. **「双击 SIGINT 才 `process.exit`」应读作「任意两次停机信号（SIGINT/SIGTERM 共用一个计数器）」** —— `cli.ts:163-166` 的注释明写 ONE counter across both signals。这加强而非削弱项 B 的分级。
13. **§13 第 5 笔所指的那类 run 实际恒为 2 行事件**，不是 2～3；第 3 行（`lease_expired_observed`）只在租约过期时出现，与 reconciliation 无关。「2～3」对全部拒绝路径是精确的，用在这一笔的具体人群上偏保守。
14. **项 C 是本次盘点里唯一后果为「数据丢失」的一项**（一旦触发是整份 `loop-state.json` 覆盖）。项 A 是仅可操作性、项 B 是假告警、项 D 是仅文档。**四项不同级，不应被打包成一批「L5 待办」。**
15. **项 C 的加宽惰性实测是在 487 tests 时做的，今天是 514 tests。** 新增的 27 个 case 是否有哪一个会在加宽下变红，**没有人验证过**。L5 若依赖「加宽仍然惰性」，必须重跑那次注入。

---

## 本次扫描自身的合规声明

- **只读**：未修改 `src/`、`tests/`、`docs/` 或任何 spec / plan / ledger。唯一写入的文件是本报告。
- **输出削短**：全文共两处，均已在原地明写（项 D 的 `push` grep 里三行勘误正文、项 E 的行号引用 grep 里六行转引行）。其余命令输出逐字完整。
- **转录勘误**：全文共三处我自己抄错并当场标注（`describe("lease") {`、C4-M2 的行号 `1572`、横幅 grep 最后两行的文件名）。**标注保留在原地，不删。**
- **Token 预算**：本任务已**超出** CLAUDE.md Rule 6 的 12,000 tokens/任务上限（读取了 1775 行 ledger 的多个大段、3025 行 spec 与 2020 行 plan 的定位段、以及 8 个源文件）。按 Rule 6「Surface the breach. Do not silently overrun.」在此明写，未静默超支。

