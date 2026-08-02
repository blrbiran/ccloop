# Task A7 报告 —— 读侧收窄（处置一）：ENOENT 归因、abandon 决策、事件与 swallow

分支 `feat/l3-debt1-transactional-continuation`，起始 HEAD `928b9c4`，落地提交 `47eb148`。
验证机制：全局 `rtk` shell hook 会自动过滤/摘要 vitest 输出，因此**每一条验证命令都通过 `rtk proxy "<command>"` 绕过**，
并先 `export ECC_GATEGUARD=off DISABLE_OMC=1`（`rtk proxy` 不接受以 env 赋值开头的引号串）。下文所有输出块均为该机制下的原样粘贴，未截断、未过滤。

---

## 一、实现了什么，以及每一条分支为什么存在

### 1. 读侧：`readPersistedSuccessfulTransferArtifacts` 的 ENOENT 归因

改动前，三次读全在一个 `Promise.all` 里，外面一个裸 `catch { return null }`。这个形状把两件语义相反的事压成了同一个 `null`：

- **「从来没有发生过转移」**——`owner-transfer.json` 不存在。这是**绝大多数 run 的正常状态**，必须放行。
- **「转移产物读不出来」**——任何其他读失败。此时写下去可能用输家的降级覆盖赢家的记录，必须 fail-closed。

`readOwnerTransferRecordRaw` 因此被移出 `Promise.all`，单独一个 `try`：

- 它自己的 catch 里 `code === "ENOENT"` → `{ kind: "no_published_transfer" }`；
- 非 ENOENT → `{ kind: "unreadable", error }`；
- 其余两读留在 `Promise.all` 里，外层 catch 一律 `{ kind: "unreadable", error }`。

**为什么是「哪次读抛的」而不是 `error.path`**：`owner-record.json` 缺失抛出的是一个和 `owner-transfer.json` 缺失**无法区分**的 ENOENT，
`code` 完全相同。用 `error.path` 在同一个 catch 里区分今天读起来一样，但任何一次读将来把原因包进自定义错误类时，
`path` 会被静默丢掉，**而所有既有测试仍然全绿**——这正是计划裁定一拒绝该写法的理由。控制流归因不会有这个失效模式。

第二个 try 上方留了一条就地注释，写明 `readPersistedReconciliationRecord` 自带 `catch { return undefined }`、从不抛，
所以那个 catch 见到的必然来自 owner-record 那一读。**本任务对该性质建立承重依赖，未收窄它**（`git show` 的 diff 里它一个字节未动）。

### 2. 决策侧：`preserveSuccessfulReconciliationIfNeeded` 返回判别式联合

返回类型从 `Promise<ReconciliationRecord>` 改为 `Promise<ReconciliationWriteDecision>`。四格：

| 输入 | 结果 | 为什么 |
|---|---|---|
| `eligibleForContinuation === true` | `{ kind: "write", record: next }`（早退） | 形状不变，保护根本不进门 |
| `no_published_transfer` | `{ kind: "write", record: next }` | **这一格必须保留**，见下 |
| `unreadable` | `{ kind: "abandon", error }` | 新增的唯一一条拒绝 |
| `artifacts` | 委派 `…FromArtifacts`，包成 `{ kind: "write", record }` | `…FromArtifacts` 一个字节未改 |

`no_published_transfer` 那一格带了就地注释说明它不是疏漏：`reconciliationRecord` 的传入条件是
`boundaryAnalysis.status === "stale_candidate"`，**与是否发生过转移无关**，所以把它也 fail-closed 会让
绝大多数 run **再也不写 `reconciliation-record.json`**——那是删掉一条正常路径上的产物，不是「增加拒绝」。
残余 TOCTOU 就地具名传下去，本层不修。

**为什么 abandon 通道是判别式联合而不是 `| null`**：`| null` 会把 error 丢掉，而 error 是这次放弃唯一能说出口的东西
（`detail` 要携带 `String(error)`，A8 的回调也要拿到原始 error）。

### 3. 写侧：`writeBoundaryArtifacts` 的 abandon 分支

顺序严格按计划写死：

1. `boundary-analysis.json` 那次写**照常发生**（它在保护之前，代码位置未动）；
2. abandon 时 `appendEvent(runDir, { type: "reconciliation_write_abandoned", at, detail: String(decision.error) })`，
   包在与 `leaseHeartbeat.ts` 的 `appendLeaseEvent` **同形**的 `try { … } catch { }` 里；
3. 然后 `return`，**不写 `reconciliation-record.json`，不抛**。

A8 的回调调用点插在 `appendEvent` **之前**——就地注释里显式写明了这一点，**但 `writeBoundaryArtifacts` 的第三个可选参数 A7 没有加**（分工写死）。

`RunEvent.type` 是裸 `string`，新增事件类型名因此**没有改动任何类型定义**。

### 4. swallow 的三条约束（就地注释逐条写出，不是「照抄判例」四个字）

1. **人裁「不抛出」**：不吞的话，`events.jsonl` 写不进去（ENOSPC / EACCES / 目录已删）会让 `writeBoundaryArtifacts` 抛 →
   `persistBoundaryAnalysis` 抛 → 落到 `runLoopFromState` 外层 catch → `isLeaseStopError` 匹配不上 I/O 错误 →
   `transitionRunState(state, "failed", …)`。**一次保护性放弃被升级成 attempt failed**，正是人裁明令禁止的那件事。
2. **Rule 12「不许静默」**：吞掉的只有**审计日志**那一半；当场可见性由 A8 排在前面的回调独家兑现。
   在「落盘但不路由」的形态下 `events.jsonl` 是唯一出口，吞它才是真静默——所以「吞」在这里第一次变得正当。
3. **Rule 11「符合既有约定」**：判例在**同一个仓库、同一个函数（`appendEvent`）、同一条理由**。

注释里另外写明**为什么 `appendEvent` 吞而回调不吞**：差别在谁能修好它。回调的实现在本层控制范围内（一次数组 push，不做 I/O），
它抛出只可能是**编程错误**，必须显眼地炸；`appendFile` 的 I/O 不在任何人控制范围内，它抛出是**环境事实**，
把它炸成 attempt failed 只是用一个更大的错误盖住一个更小的。

---

## 二、落地的两个联合类型（逐字，与 brief 同形）

```ts
type PersistedTransferArtifactsRead =
  | {
      kind: "artifacts";
      ownerRecord: OwnerRecord;
      ownerTransferRecord: OwnerTransferRecord;
      reconciliationRecord: ReconciliationRecord | undefined;
    }
  | { kind: "no_published_transfer" }
  | { kind: "unreadable"; error: unknown };

type ReconciliationWriteDecision =
  | { kind: "write"; record: ReconciliationRecord }
  | { kind: "abandon"; error: unknown };

async function preserveSuccessfulReconciliationIfNeeded(
  runDir: string,
  nextReconciliationRecord: ReconciliationRecord,
): Promise<ReconciliationWriteDecision>
```

字段名、成员数、判别子取值均与 brief 一致，未重命名、未增删成员。A8 与组 C 的 12d 可以直接依赖。

---

## 三、Step 1：爆炸半径两条命令重跑

```
$ grep -nF 'eligibleForContinuation' tests/persistence/fileStore.test.ts; echo "EXIT_A=$?"
109:      eligibleForContinuation: true,
115:      eligibleForContinuation: boolean;
120:    expect(transfer.eligibleForContinuation).toBe(true);
176:      eligibleForContinuation: boolean;
183:    expect(audit.eligibleForContinuation).toBe(true);
309:      eligibleForContinuation: true,
384:      eligibleForContinuation: true,
445:      eligibleForContinuation: true,
1604:      eligibleForContinuation: true,
1682:      eligibleForContinuation: true,
1849:        eligibleForContinuation: true,
1885:      eligibleForContinuation: true,
1908:        eligibleForContinuation: true,
1932:        eligibleForContinuation: false,
1942:      eligibleForContinuation: boolean;
1949:    expect(reconciliation.eligibleForContinuation).toBe(true);
1973:      eligibleForContinuation: true,
1996:        eligibleForContinuation: false,
2011:      eligibleForContinuation: boolean;
2017:    expect(reconciliation.eligibleForContinuation).toBe(true);
2047:      eligibleForContinuation: true,
2062:      eligibleForContinuation: false,
2093:      eligibleForContinuation: boolean;
2100:    expect(reconciliation.eligibleForContinuation).toBe(true);
2312:      priorOwnerEpoch: 1, newOwnerEpoch: 2, eligibleForContinuation: true,
2721:  // eligibleForContinuation: true early return short-circuits to that same value, so the two
2733:    eligibleForContinuation: true,
2870:    eligibleForContinuation: true,
EXIT_A=0
```

```
$ grep -rnF 'writeBoundaryArtifacts' tests/; echo "EXIT_B=$?"
tests/controller/runLoop.integration.test.ts:1296:  // persistOwnerTransfer's own transaction, not by the writeBoundaryArtifacts call that used to
tests/controller/runLoop.integration.test.ts:1306:  // .json is written by the very call (writeBoundaryArtifacts) this task's winner path now skips,
tests/controller/runLoop.integration.test.ts:1347:            // writeBoundaryArtifacts call this task removed reconciliation from. Every assertHeld
tests/controller/runLoop.integration.test.ts:1407:      // ABSENT. It is written by the SAME writeBoundaryArtifacts call the winner path now skips
tests/controller/runLoop.integration.test.ts:1411:      // reached" from "reconciliation came from writeBoundaryArtifacts", which — had it run at all —
tests/controller/runLoop.integration.test.ts:1491:  // writeBoundaryArtifacts — persistOwnerTransfer already published it transactionally, so a
tests/controller/runLoop.integration.test.ts:1496:  // fileStore.js's writeBoundaryArtifacts is wrapped, not replaced: the wrapper takes its "before"
tests/controller/runLoop.integration.test.ts:1523:    let writeBoundaryArtifactsCalls = 0;
tests/controller/runLoop.integration.test.ts:1533:        writeBoundaryArtifacts: async (...args: Parameters<typeof actual.writeBoundaryArtifacts>) => {
tests/controller/runLoop.integration.test.ts:1534:          writeBoundaryArtifactsCalls += 1;
tests/controller/runLoop.integration.test.ts:1539:          await actual.writeBoundaryArtifacts(...args);
tests/controller/runLoop.integration.test.ts:1575:      // Guards, not the point of the test: exactly one writeBoundaryArtifacts call happened
tests/controller/runLoop.integration.test.ts:1578:      expect(writeBoundaryArtifactsCalls).toBe(1);
tests/controller/runLoop.integration.test.ts:1728:            await actual.writeBoundaryArtifacts(observedRunDir, {
tests/controller/runLoop.integration.test.ts:1953:      // one from them (writeBoundaryArtifacts's `readPersistedSuccessfulTransferArtifacts` /
tests/controller/leaseLifecycle.integration.test.ts:1010:  // fails when adopt is moved past a genuinely later point (e.g. past writeBoundaryArtifacts).
tests/controller/leaseLifecycle.integration.test.ts:1582:  // but before it reaches the LATER assertHeld that guards writeBoundaryArtifacts — must still
tests/persistence/fileStore.test.ts:20:  writeBoundaryArtifacts,
tests/persistence/fileStore.test.ts:1829:    await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:1888:    await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:1912:    await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:1976:    await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:2065:    await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:2076:    await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:2677:// writeBoundaryArtifacts writes two separate files, and each is pinned separately below.
tests/persistence/fileStore.test.ts:2695://   - writeBoundaryArtifacts has no ensureFreshRunDir or any other guard in front of either
tests/persistence/fileStore.test.ts:2701://     writeBoundaryArtifacts twice against one run directory. boundary-analysis.json is written
tests/persistence/fileStore.test.ts:2707:describe("writeBoundaryArtifacts publishes each of its two files by replacing the path, not by writing through it", () => {
tests/persistence/fileStore.test.ts:2741:  it("gives boundary-analysis.json a new inode when writeBoundaryArtifacts overwrites it", async () => {
tests/persistence/fileStore.test.ts:2745:    await writeBoundaryArtifacts(runDir, { boundaryAnalysis });
tests/persistence/fileStore.test.ts:2756:      await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:2776:  it("gives reconciliation-record.json a new inode when writeBoundaryArtifacts overwrites it", async () => {
tests/persistence/fileStore.test.ts:2780:    await writeBoundaryArtifacts(runDir, { boundaryAnalysis, reconciliationRecord });
tests/persistence/fileStore.test.ts:2786:      await writeBoundaryArtifacts(runDir, {
tests/persistence/fileStore.test.ts:2811:    await writeBoundaryArtifacts(runDir, { boundaryAnalysis, reconciliationRecord });
EXIT_B=0
```

（两条都是 `-F`，退出码可作论据。）

### 与计划实测值的比对 —— **不一致，就地上报**

| 项 | 计划阶段实测 | 我这次实测 | 判断 |
|---|---|---|---|
| `eligibleForContinuation` 命中行数 | 22 | **29** | 行数与行号全部漂移 |
| 作为 `reconciliationRecord` 传入且为 `false` 的三处 | `:1219 :1283 :1349` | **`:1932 :1996 :2062`** | 三处仍是三处，位置漂移 |
| `writeBoundaryArtifacts` 在 `fileStore.test.ts` 的命中 | `:1116 :1175 :1199 :1263 :1352 :1363 :1907 :1918 :1942 :1948 :1973` | `:20(import) :1829 :1888 :1912 :1976 :2065 :2076 :2677 :2695 :2701 :2707 :2741 :2745 :2756 :2776 :2780 :2786 :2811` | 漂移，且多出 `describe("writeBoundaryArtifacts publishes each of its two files…")` 整段 |
| `runLoop.integration.test.ts` 的非 import/注释命中 | `:1430` | `:1533 :1539 :1728` | 漂移 |

**为什么我没有因此停下**：brief 自己在同一条陷阱里写明了这个漂移的成因——「爆炸半径已在计划阶段重跑过一遍，**落地时必须再跑一遍**（§4.3 明确要求，
**因为 A2 的签名扩容本来就要动 `fileStore.test.ts`**）」。A1–A6 全部落地在计划实测之后，行号漂移是被预期的，
不是与计划的事实冲突。**真正需要比对的是那条结论，我逐处核对过它，它成立**：

`:1932`（`preserves a successful reconciliation record when a loser later tries to downgrade it` 的第二次调用）、
`:1996`（`synthesizes a successful reconciliation view…`）、`:2062`（`preserves a synthesized winner reconciliation view…` 的 `loserDowngrade`）
——三处 fixture **都先写了 `owner-record.json` 与 `owner-transfer.json`**（各自 `it` 开头的 `writeOwnerRecord` + `writeOwnerTransferRecord`），
三读不抛，**收窄后不变红**。全套件结果印证：29 个文件全绿，无既有测试被打红。

那条失效条件（「刻意不含 owner-record/owner-transfer 的 describe 一旦改传 `false` 会立刻被打红，而它红得是对的」）仍然成立，本任务没有去碰它。

---

## 四、Step 2/3/4：三条测试与注入前的原始输出

三条各自独立的 `it`，都在 `describe("fileStore")` 下。完整测试名：

- (i) `fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`
- (ii) `fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned`
- (iii) `fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned`

按 Global Constraints 的 `Amended 2026-08-02 (b)`：**具名写完整 `describe > it` 串，代入 `-t` 的换成裸 `it` 名**（箭头形式在 vitest 2.1.9 下零匹配且退出码 0）。
下文每一个单跑块都带 `Tests N passed | M skipped` 或 `1 failed | M skipped` 的**非零具名计数**，没有一块是「全部 skipped」。

### (i) 实现前（brief 预期今天就绿——裸 catch 放行一切）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still writes the reconciliation record when owner-transfer.json is simply absent'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (71 tests | 70 skipped) 4ms

 Test Files  1 passed (1)
      Tests  1 passed | 70 skipped (71)
   Start at  21:04:58
   Duration  520ms (transform 217ms, setup 0ms, collect 251ms, tests 4ms, environment 0ms, prepare 44ms)

EXIT=0
```

绿不算完成——它的护栏由 Step 7 的变异一提供。

### (ii) 实现前（必须红）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (71 tests | 1 failed | 70 skipped) 10ms
   × fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned 9ms
     → promise resolved "'{\n  "staleSuspicionBasis": [\n    "c…'" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned
AssertionError: promise resolved "'{\n  "staleSuspicionBasis": [\n    "c…'" instead of rejecting

- Expected: 
[Error: rejected promise]

+ Received: 
"{
  \"staleSuspicionBasis\": [
    \"continuity evidence missing\"
  ],
  \"staleConfirmed\": true,
  \"ownershipVerdict\": \"OWNER_UNDECIDABLE\",
  \"lastTrustedBoundary\": \"execute\",
  \"conflictingEvidence\": [],
  \"takeoverPermission\": {
    \"allowed\": false,
    \"reason\": \"deny-by-default until strict owner-loss and transfer conditions are fully met\"
  },
  \"priorOwnerEpoch\": 2,
  \"newOwnerEpoch\": null,
  \"eligibleForContinuation\": false
}"

 ❯ tests/persistence/fileStore.test.ts:2224:78
    2222|     expect(analysis.status).toBe("stale_candidate");
    2223| 
    2224|     await expect(readFile(join(runDir, "reconciliation-record.json"), …
       |                                                                              ^
    2225|       code: "ENOENT",
    2226|     });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 70 skipped (71)
   Start at  21:05:06
   Duration  489ms (transform 208ms, setup 0ms, collect 239ms, tests 10ms, environment 0ms, prepare 45ms)

EXIT=1
```

### (iii) 实现前（必须红）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (71 tests | 1 failed | 70 skipped) 13ms
   × fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned 12ms
     → expected { …(9) } to deeply equal { …(9) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned
AssertionError: expected { …(9) } to deeply equal { …(9) }

- Expected
+ Received

  Object {
    "conflictingEvidence": Array [],
-   "eligibleForContinuation": true,
+   "eligibleForContinuation": false,
    "lastTrustedBoundary": "execute",
-   "newOwnerEpoch": 2,
-   "ownershipVerdict": "OWNER_LOST",
-   "priorOwnerEpoch": 1,
+   "newOwnerEpoch": null,
+   "ownershipVerdict": "OWNER_UNDECIDABLE",
+   "priorOwnerEpoch": 2,
    "staleConfirmed": true,
    "staleSuspicionBasis": Array [
-     "owner transfer already published",
+     "continuity evidence missing",
    ],
    "takeoverPermission": Object {
-     "allowed": true,
-     "reason": "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
+     "allowed": false,
+     "reason": "deny-by-default until strict owner-loss and transfer conditions are fully met",
    },
  }

 ❯ tests/persistence/fileStore.test.ts:2310:28
    2308|       await readFile(join(runDir, "reconciliation-record.json"), "utf8…
    2309|     ) as ReconciliationRecord;
    2310|     expect(reconciliation).toEqual(persistedReconciliation);
       |                            ^
    2311| 
    2312|     const events = (await readFile(join(runDir, "events.jsonl"), "utf8…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 70 skipped (71)
   Start at  21:05:12
   Duration  449ms (transform 181ms, setup 0ms, collect 215ms, tests 13ms, environment 0ms, prepare 38ms)

EXIT=1
```

---

## 五、Step 6：实现后三条全绿（三份原始输出）

### (i)

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still writes the reconciliation record when owner-transfer.json is simply absent'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (71 tests | 70 skipped) 4ms

 Test Files  1 passed (1)
      Tests  1 passed | 70 skipped (71)
   Start at  21:06:53
   Duration  482ms (transform 210ms, setup 0ms, collect 241ms, tests 4ms, environment 0ms, prepare 43ms)

EXIT=0
```

### (ii)

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (71 tests | 70 skipped) 5ms

 Test Files  1 passed (1)
      Tests  1 passed | 70 skipped (71)
   Start at  21:07:00
   Duration  450ms (transform 190ms, setup 0ms, collect 225ms, tests 5ms, environment 0ms, prepare 46ms)

EXIT=0
```

### (iii)

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (71 tests | 70 skipped) 5ms

 Test Files  1 passed (1)
      Tests  1 passed | 70 skipped (71)
   Start at  21:07:03
   Duration  441ms (transform 186ms, setup 0ms, collect 218ms, tests 5ms, environment 0ms, prepare 36ms)

EXIT=0
```

上面这三块同时充当三次变异实验的**注入前绿**（第 3 步判据的前一半）：它们跑在提交前的同一个工作副本上，
且这个副本是 git 仓库本身（不是 scratchpad 拷贝），基线全绿见第七节的全套件跑。

---

## 六、Step 7：三次变异实验

变异注入点全部在**生产代码**（`src/persistence/fileStore.ts`），没有一次是改 fixture 或测试数组。
每次注入前先把 pristine 副本复制回去，注入后单跑具名那一条，跑完立刻还原。

### 变异一：删掉 ENOENT 豁免（一律 fail-closed）→ 6f(i) 必红

注入内容：`readPersistedSuccessfulTransferArtifacts` 中 owner-transfer 那一读的 catch 去掉 ENOENT 分支，只留 `return { kind: "unreadable", error };`。

具名：`fileStore > still writes the reconciliation record when owner-transfer.json is simply absent`
注入前绿：见第五节 (i) 那一块（`Tests  1 passed | 70 skipped (71)`，EXIT=0）。
注入后：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still writes the reconciliation record when owner-transfer.json is simply absent'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (71 tests | 1 failed | 70 skipped) 10ms
   × fileStore > still writes the reconciliation record when owner-transfer.json is simply absent 9ms
     → ENOENT: no such file or directory, open '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-wgDj9r/reconciliation-record.json'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > still writes the reconciliation record when owner-transfer.json is simply absent
Error: ENOENT: no such file or directory, open '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-wgDj9r/reconciliation-record.json'
 ❯ tests/persistence/fileStore.test.ts:2164:7
    2162| 
    2163|     const reconciliation = JSON.parse(
    2164|       await readFile(join(runDir, "reconciliation-record.json"), "utf8…
       |       ^
    2165|     ) as ReconciliationRecord;
    2166| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 70 skipped (71)
   Start at  21:07:25
   Duration  448ms (transform 177ms, setup 0ms, collect 217ms, tests 10ms, environment 0ms, prepare 37ms)

EXIT=1
```

**击杀**（`1 failed | 70 skipped`，具名那条本身红）。

### 变异二：归因去掉，一律放行 ENOENT（不区分文件）→ 6f(ii) 必红

注入内容：三读收回同一个 `Promise.all`，共享一个 catch，里面 `if (code === "ENOENT") return { kind: "no_published_transfer" };` 否则 `unreadable`。
这正是计划裁定一拒绝的那个「看起来一样」的写法。

具名：`fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned`
注入前绿：见第五节 (ii) 那一块（`Tests  1 passed | 70 skipped (71)`，EXIT=0）。
注入后：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (71 tests | 1 failed | 70 skipped) 10ms
   × fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned 9ms
     → promise resolved "'{\n  "staleSuspicionBasis": [\n    "c…'" instead of rejecting

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned
AssertionError: promise resolved "'{\n  "staleSuspicionBasis": [\n    "c…'" instead of rejecting

- Expected: 
[Error: rejected promise]

+ Received: 
"{
  \"staleSuspicionBasis\": [
    \"continuity evidence missing\"
  ],
  \"staleConfirmed\": true,
  \"ownershipVerdict\": \"OWNER_UNDECIDABLE\",
  \"lastTrustedBoundary\": \"execute\",
  \"conflictingEvidence\": [],
  \"takeoverPermission\": {
    \"allowed\": false,
    \"reason\": \"deny-by-default until strict owner-loss and transfer conditions are fully met\"
  },
  \"priorOwnerEpoch\": 2,
  \"newOwnerEpoch\": null,
  \"eligibleForContinuation\": false
}"

 ❯ tests/persistence/fileStore.test.ts:2224:78
    2222|     expect(analysis.status).toBe("stale_candidate");
    2223| 
    2224|     await expect(readFile(join(runDir, "reconciliation-record.json"), …
       |                                                                              ^
    2225|       code: "ENOENT",
    2226|     });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 70 skipped (71)
   Start at  21:10:03
   Duration  489ms (transform 204ms, setup 0ms, collect 235ms, tests 10ms, environment 0ms, prepare 45ms)

EXIT=1
```

**击杀**。这一条是三条里唯一能杀掉「一律放行 ENOENT」实现的，符合 brief 的说明。

### 变异三：退回裸 `catch { return null }` 语义（一律放行）→ 6f(iii) 必红

注入内容：三读收回同一个 `Promise.all`，catch 一律 `return { kind: "no_published_transfer" };`（即 A7 之前的语义，只是换了新的类型外壳）。

具名：`fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned`
注入前绿：见第五节 (iii) 那一块（`Tests  1 passed | 70 skipped (71)`，EXIT=0）。
注入后：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (71 tests | 1 failed | 70 skipped) 13ms
   × fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned 12ms
     → expected { …(9) } to deeply equal { …(9) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned
AssertionError: expected { …(9) } to deeply equal { …(9) }

- Expected
+ Received

  Object {
    "conflictingEvidence": Array [],
-   "eligibleForContinuation": true,
+   "eligibleForContinuation": false,
    "lastTrustedBoundary": "execute",
-   "newOwnerEpoch": 2,
-   "ownershipVerdict": "OWNER_LOST",
-   "priorOwnerEpoch": 1,
+   "newOwnerEpoch": null,
+   "ownershipVerdict": "OWNER_UNDECIDABLE",
+   "priorOwnerEpoch": 2,
    "staleConfirmed": true,
    "staleSuspicionBasis": Array [
-     "owner transfer already published",
+     "continuity evidence missing",
    ],
    "takeoverPermission": Object {
-     "allowed": true,
-     "reason": "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
+     "allowed": false,
+     "reason": "deny-by-default until strict owner-loss and transfer conditions are fully met",
    },
  }

 ❯ tests/persistence/fileStore.test.ts:2310:28
    2308|       await readFile(join(runDir, "reconciliation-record.json"), "utf8…
    2309|     ) as ReconciliationRecord;
    2310|     expect(reconciliation).toEqual(persistedReconciliation);
       |                            ^
    2311| 
    2312|     const events = (await readFile(join(runDir, "events.jsonl"), "utf8…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 70 skipped (71)
   Start at  21:10:23
   Duration  449ms (transform 181ms, setup 0ms, collect 215ms, tests 13ms, environment 0ms, prepare 42ms)

EXIT=1
```

**击杀**。这一条同时展示了 (iii) 的独立价值：它断言的是**赢家那份 `reconciliation-record.json` 原样幸存**，
所以即使一个实现「放弃了但仍然覆盖」也逃不掉。

三次变异都是「具名那一条单跑红」（`1 failed | 70 skipped`），不是「套件红」。

---

## 七、Step 8：单独验证 swallow（观察，非正式护栏）

brief 要求 mock `appendEvent` 抛出。`appendEvent` 是 `fileStore.ts` **模块内**的直接调用，`vi.mock` 拦不到自身模块内的绑定，
所以我用了一个**真实**的等价故障：把 `events.jsonl` 建成**目录**，`appendFile` 因此抛 `EISDIR`。
这比 mock 更强——它是 brief 列举的三种环境故障（ENOSPC / EACCES / 目录已被删）的同类。

临时测试文件 `tests/persistence/tmp-swallow-observation.test.ts`（观察完已删除，见第九节 `git status`），
断言 `writeBoundaryArtifacts` **resolve**。

**(a) 有 swallow（当前落地实现）——resolve：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/tmp-swallow-observation.test.ts -t 'resolves even when events.jsonl cannot be appended to'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/tmp-swallow-observation.test.ts (1 test) 3ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  21:10:50
   Duration  278ms (transform 40ms, setup 0ms, collect 41ms, tests 3ms, environment 0ms, prepare 38ms)

EXIT=0
```

**(b) 生产代码变异：把 `try{}catch{}` 拿掉——抛了：**

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/tmp-swallow-observation.test.ts -t 'resolves even when events.jsonl cannot be appended to'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/tmp-swallow-observation.test.ts (1 test | 1 failed) 8ms
   × swallowObservation > resolves even when events.jsonl cannot be appended to 7ms
     → promise rejected "Error: EISDIR: illegal operation on a dir… { …(4) }" instead of resolving

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/tmp-swallow-observation.test.ts > swallowObservation > resolves even when events.jsonl cannot be appended to
AssertionError: promise rejected "Error: EISDIR: illegal operation on a dir… { …(4) }" instead of resolving
 ❯ tests/persistence/tmp-swallow-observation.test.ts:44:5
     42|         },
     43|       }),
     44|     ).resolves.toBeUndefined();
       |     ^
     45|   });
     46| });

Caused by: Error: EISDIR: illegal operation on a directory, open '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-qaIHlF/events.jsonl'
 ❯ appendEvent src/persistence/fileStore.ts:86:3
 ❯ Module.writeBoundaryArtifacts src/persistence/fileStore.ts:380:7
 ❯ tests/persistence/tmp-swallow-observation.test.ts:23:5

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { errno: -21, code: 'EISDIR', syscall: 'open', path: '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-run-qaIHlF/events.jsonl' }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  21:10:59
   Duration  282ms (transform 40ms, setup 0ms, collect 41ms, tests 8ms, environment 0ms, prepare 42ms)

EXIT=1
```

调用栈把整条路径写得很直白：`appendEvent (fileStore.ts:86) ← writeBoundaryArtifacts (fileStore.ts:380)`——
没有 swallow 时，一次保护性放弃确实会把 I/O 错误抛出 `writeBoundaryArtifacts`。看完立刻还原，临时文件已删。
**它的正式护栏是 A8 的 12d(iii) 子断言，本任务不承担。**

---

## 八、三条计数守卫（原始输出）

```
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8

$ grep -rnF 'currentOwnerEpoch + 1' src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;

$ git diff --stat -- src/registry/; echo "registry_diff_empty=$?"

registry_diff_empty=0
```

- `evaluateResumeEligibility` 的八条判据：**仍为 8**，一个字节未改（本任务根本没碰 `resumeLoop.ts`）。
- `currentOwnerEpoch + 1`：**单一命中**，`src/ownership/ownerController.ts:166`。
- `src/registry/`：`git diff --stat` 输出为**空**（零改动）。上面两条 `grep` 都带 `-F`，退出码可作论据。

---

## 九、Step 9：全套件 + typecheck + build（未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"; echo "TEST_EXIT=$?"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 6ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 5ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 410ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 145ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 31ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 5ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 3ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 42ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

 ✓ tests/persistence/fileStore.test.ts (71 tests) 1993ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 1559ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-sXiw4w/does-not-exist'

 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2344ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 316ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 363ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-UNEjKD/run-1  observed 2026-08-02T13:27:25.067Z
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

 ✓ tests/cli/cli.test.ts (15 tests) 447ms
   ✓ parseArgs > returns 0 for the scripted example run 312ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 29ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 2ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 269ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2476ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 650ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 570ms
   ✓ render-contract CLI > rejects a non-git repository path 588ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 659ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3153ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 374ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 325ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 384ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 407ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 389ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 351ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 495ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 2ms
 ✓ tests/validation/fixture.test.ts (2 tests) 526ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 524ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 6577ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop returns, so the next resume proceeds immediately 304ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 579ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 547ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 629ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 497ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 391ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 371ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 385ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 349ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9335ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 571ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 372ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 370ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 374ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 376ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 371ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 367ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 365ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 361ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 356ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 364ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 359ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 377ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 345ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 499ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 363ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 493ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 497ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 359ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 534ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 385ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10181ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 356ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 826ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15410ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1348ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1140ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2549ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1528ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1498ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1502ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 583ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 558ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 564ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 933ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 562ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2463ms

 Test Files  29 passed (29)
      Tests  476 passed (476)
   Start at  21:27:22
   Duration  15.99s (transform 1.97s, setup 0ms, collect 3.23s, tests 53.42s, environment 4ms, prepare 1.61s)

TEST_EXIT=0
```

上面这一块是完整粘贴，**没有省略号、没有截断**：文件清单 29 行全在，`Tests` 行之后的 `Start at` / `Duration` / `TEST_EXIT` 全在。

- `Test Files  29 passed (29)` / `Tests  476 passed (476)`，`TEST_EXIT=0`。
- 起始基线是 473（本报告不引用控制器给的数字作为我的实测，这个 476 来自上面这次执行）。**新增 3 条**（6f 的三个 `it`），473 + 3 = 476，对得上。
- **两条允许的 flake 都没有出现**：`tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid` 显示 `✓ … 2549ms`；
  `tests/controller/runLoop.integration.test.ts` 整个文件 `✓ (51 tests)`，零失败。名单外也无任何失败。

```
$ rtk proxy "npm run typecheck"; echo "typecheck_exit=$?"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

```
$ rtk proxy "npm run build"; echo "build_exit=$?"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

提交前的工作区状态（临时观察文件已删、变异全部还原）：

```
$ git status --porcelain
 M src/persistence/fileStore.ts
 M tests/persistence/fileStore.test.ts
```

---

## 十、Step 10：提交

```
$ git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts && git commit -m "feat(fileStore): fail closed on unreadable transfer artifacts, abandoning the reconciliation write instead of writing through" 2>&1; echo "COMMIT_EXIT=$?"; git log --oneline -1; git status --porcelain
ok 2 files changed, 315 insertions(+), 22 deletions(-)
ok 47eb148
COMMIT_EXIT=0
47eb148 feat(fileStore): fail closed on unreadable transfer artifacts, abandoning the reconciliation write instead of...
```

（`git status --porcelain` 在提交后输出为空，即工作区干净。`ok` 前缀来自 `rtk` hook 对 `git` 的改写，命令本身逐字与 brief 的 Step 10 一致。）

**未 push、未 merge、未做 `git clean` / `reset --hard` / 广域 `restore`。** 变异实验的还原全部用
`/bin/cp -f <scratchpad 里的 pristine 副本> src/persistence/fileStore.ts` 定点覆盖单个文件，没有用任何 git 破坏性命令。

### 文件改动

| 文件 | 改动 |
|---|---|
| `src/persistence/fileStore.ts` | +98 / −22。两个新类型；`readPersistedSuccessfulTransferArtifacts` 拆读与归因；`preserveSuccessfulReconciliationIfNeeded` 返回判别式联合；`writeBoundaryArtifacts` 新增 abandon 分支 |
| `tests/persistence/fileStore.test.ts` | +217 / −0。三个独立的 `it`（6f i/ii/iii）＋ 一段说明其边界的注释 |

`tests/persistence/tmp-swallow-observation.test.ts` 仅在 Step 8 存在，观察完即删，**未进入提交**。

---

## 十一、自评（fresh eyes）

在写下面每一句自证之前，我回滚了整篇报告逐块检查过：**没有任何一处是我做的省略**。
（需要说明的一点，免得被误判为省略：vitest 自己的失败块里会出现单字符 `…`，例如
`await readFile(join(runDir, "reconciliation-record.json"), "utf8…` 与 `expected { …(9) } to deeply equal { …(9) }`——
那是 vitest 对源码行与对象的**自有**截断，逐字照抄，不是我删的内容。凡我粘贴的块，从 `RUN` 行到 `EXIT=` 行都是连续完整的。）
每一条命令都回显了退出码
（`EXIT=` / `EXIT_A=` / `EXIT_B=` / `TEST_EXIT=` / `typecheck_exit=` / `build_exit=` / `COMMIT_EXIT=` / `registry_diff_empty=`）；
每一个算出来的数字（8、单一命中、29/476、+98/−22、+217）旁边都就地附了能重推它的命令与那次执行的输出。

1. **每一条新分支都有一条没有它就会失败的测试吗？——有一处没有，如实上报。**
   - `no_published_transfer` → 变异一击杀 6f(i) ✓
   - 第二个 try 的 `unreadable`（ENOENT 型，来自 owner-record 缺失）→ 变异二击杀 6f(ii) ✓
   - 第二个 try 的 `unreadable`（非 ENOENT 型，SyntaxError）→ 变异三击杀 6f(iii) ✓
   - abandon 分支本身（不写 + 发事件）→ 6f(ii)/(iii) 双向断言 ✓
   - **⚠️ 未被杀掉的一格：owner-transfer 那一读的 catch 里的非 ENOENT 分支**
     （`owner-transfer.json` 存在但内容不是合法 JSON → `{ kind: "unreadable", error }`）。
     brief 的三条子用例没有覆盖这一格：(ii)/(iii) 的 `owner-transfer.json` 都是可读的，失败发生在第二个 try。
     我**没有**擅自加第四条 `it`，因为控制器的指令是「Do exactly what the brief's Steps specify, nothing more」，
     且 A8 / 组 C 12d 依赖这三条的具体形状。**这是留给评审的一个具名缺口**，加一条 `it`（fixture 写坏的 `owner-transfer.json`，断言同 (ii)）即可闭合，成本很低。
   - swallow 本身没有正式护栏——这是 brief 明写的分工（Step 8 只是「亲眼看到」，正式护栏是 A8 的 12d(iii)），不算缺口。

2. **有没有新增*许可*？没有。** 收窄前：任何读失败 → `null` → 写穿。收窄后：只有 owner-transfer 的 ENOENT 写穿，其余一律放弃。
   新代码在每一格上都**不弱于**旧代码，`no_published_transfer` 那一格与旧行为**逐字等价**。唯一的新出口是一条拒绝。

3. **有没有收窄 brief 要我依赖的东西？没有。** `readPersistedReconciliationRecord` 的 `catch { return undefined }` 一个字节未动
   （`git show HEAD -- src/persistence/fileStore.ts` 的 hunk 头是 `@@ -253,48 +253,93 @@ async function readPersistedReconciliationRecord(...)`，
   即它只作为**上下文行**出现，不在改动范围内）。`preserveSuccessfulReconciliationIfNeededFromArtifacts` 同样一个字节未改。

4. **守卫仍然成立**：8 / 单一命中 / `src/registry/` 零改动，三条原始输出见第八节。

5. **S-3 安全阀未被触发**：本任务没有在恢复路径上新增**静默**失败模式（唯一被吞的是审计日志那一半，且理由与判例在注释里逐条写出），
   也**没有改动 `finalizePendingOwnerTransfer` 的 catch 语义**（那个函数完全没被碰）。

6. **A8 分工遵守**：`writeBoundaryArtifacts` **没有**加第三个可选参数，**没有**加回调，只在 `appendEvent` 上方留了注释标明回调的插入位置。

7. **spec §4.6 的「代码零改动」现在为假**——按裁定三，**我没有去改 spec**，也没有因为那句话回避这次改动。

8. **全仓行号引用扫描**（Global Constraints 收尾条）：`grep -rnF 'fileStore.ts:' src/ tests/ docs/` 有命中。逐条核对：
   - `src/registry/observeFields.ts:9` 引用 `fileStore.ts:77 and :82`（`initializeRunFiles` / `writeRunState`）——在我的改动点（253 起）**之上**，未受影响，且 `src/registry/` 是零改动守卫，不可碰。
   - `tests/persistence/fileStore.test.ts:2837` 引用 `fileStore.ts:52-56`（`ensureFreshRunDir`）——同样在改动点之上，未受影响。
   - `tests/registry/readObservedFile.test.ts:97` 引用 `fileStore.ts:535-536`、`tests/registry/zeroWrite.test.ts:6,:92` 引用 `fileStore.ts:549-563`——在改动点之下，我的 +76 净行数会让它们移位。
     **但我核对过它们在我改之前就已经是错的**：`git show HEAD~1:src/persistence/fileStore.ts | sed -n '535,536p'` 得到的是一个空行加 `}`（不是 owner-transfer 的 rename），
     `sed -n '549,563p'` 得到的是 `safeUnlink`（不是 `recoverInterruptedOwnerTransfer`）。这是前几波留下的既有陈旧锚点，不是 A7 造成的，
     且这两个文件都在本任务的 Files 清单之外，按 Rule 3「只清理自己的烂摊子」我没有动它们。**具名留给评审/后续清理。**
   - `docs/superpowers/{plans,specs,decisions}/**` 里的大量 `fileStore.ts:NNN` 同属既有陈旧锚点；裁定三明令不要顺手改 spec，故未动。

9. **测试纪律**：三条是三个独立的 `it`；每条测试名里的每个分句都有能失败的断言（(ii)/(iii) 的「appending reconciliation_write_abandoned」由
   `expect(events[0]?.type).toBe("reconciliation_write_abandoned")` 承担，「abandons the … write」由 `reconciliation-record.json` 的存在性/内容断言承担）；
   两条断言「恰好 1 行事件」的测试都**在同一条 `it` 里显式断言了 fixture 前置条件**（`events.jsonl` 调用前不存在），所以那个 1 不是环境依赖的；
   变异注入点全在生产代码；没有新增依赖跨文件顺序的测试。

---

## 十二、遗留关切

1. **（最重要）上文自评第 1 条里那一格未被击杀的分支**：`owner-transfer.json` 存在但内容损坏 → `unreadable`。
   brief 的三条子用例结构性地不覆盖它。建议评审决定是否补第四条 `it`。
2. **一处被我核对过、判定良性的行为差异**：改动后，当 `owner-transfer.json` 为 ENOENT 时会**提前返回**，因而不再调用
   `readOwnerRecord`——也就不再触发它内部的 `recoverInterruptedOwnerTransfer`。改动前这三读在同一个 `Promise.all` 里，
   数组是**急切求值**的：`readOwnerRecord(runDir)` 先被调用（启动 recovery），紧接着 `readOwnerTransferRecordRaw(runDir)` 发出 `readFile`，
   而 recovery 在任何 rename 之前至少有一个 await，所以那次 `readFile` 看到的**同样是 recovery 之前的状态**；
   并且 `Promise.all` 一旦 reject，那条 recovery promise 就变成无人 await 的悬挂 promise。
   即：改动前后这条保护读看到的都是 pre-recovery 状态，且新写法去掉的是一个本来就不被 await 的副作用。
   recovery 依然由所有真正的所有权路径（`resumeLoop`、`writeOwnerTransferArtifacts`）驱动。**结论是良性，但这是一个我主动改变过的东西，具名交给评审复核。**
3. **`reconciliation_write_abandoned` 至今只落盘、未路由**。这是人裁明确拒绝过的形态，本任务按分工只能做到这里——
   路由由 A8 的回调通道加组 C 的 sweep 承担。
   **（修复轮一更正，我原来的写法被评审判为夸大，此处按评审的更正版本重写）**：swallow 的正当性**并不**依赖回调排在 `appendEvent` **之前**。
   因为 `appendEvent` 被吞掉、抛不出自身，一个排在它**之后**的回调照样会触发——顺序不是承重的。
   真正会让第 2 条约束（Rule 12 不许静默）失效的是**A8 根本不落地那个回调**：那时 `events.jsonl` 又变回唯一出口，吞它就退化成真静默。
   这正是我在 `writeBoundaryArtifacts` 调用点注释里已经写的那件事（注释说的是「可见性由回调兑现」，不是「由回调的位置兑现」），
   **代码注释一直是对的，错的只有这份报告的初版**。承重依赖是「回调必须存在」，不是「回调必须在前」。
4. **Step 8 用的是真实 `EISDIR` 而非 mock**，偏离了 brief 的字面表述（「mock `appendEvent` 抛出」）。
   理由是 `appendEvent` 在 `fileStore.ts` 内被直接调用，`vi.mock` 拦不到同模块内的绑定；`EISDIR` 是同类且更真实的故障。已在第七节就地披露。
5. **Step 1 的爆炸半径比对不一致（行号与行数全部漂移）**，我判定为 A1–A6 落地造成的预期漂移而非事实冲突，未停下上报流程，
   但已在第三节完整列出新旧对照并逐处复核了那条**结论**。若控制器认为 brief「不一致则停下上报」应按字面执行，这是一处需要裁决的判断。

---

# 附：修复轮一（Fix round 1 of 5）

评审判定 Needs fixes：两条 Important、零条 Critical。本节记录五项改动、覆盖测试、命令与原始输出。
验证机制与上文相同：先 `export ECC_GATEGUARD=off DISABLE_OMC=1`，再 `rtk proxy "<cmd>"` 绕过全局 rtk 输出过滤 hook。

## 改了什么

| # | 评审条目 | 改动 | 文件 |
|---|---|---|---|
| 1 | Important 1 | 新增第四条 `it`，覆盖第一个 `try` 的**非 ENOENT** 分支（`owner-transfer.json` 存在但不是合法 JSON） | `tests/persistence/fileStore.test.ts` |
| 2 | Important 2 | 三条 abandon 测试各加一条 `detail` 断言（此前 `detail` 只在解析类型里出现、从未被断言） | `tests/persistence/fileStore.test.ts` |
| 3 | 折叠项 3 | 在 ENOENT 早退处就地写下「此处同时跳过了 `recoverInterruptedOwnerTransfer` 副作用」的理由 | `src/persistence/fileStore.ts` |
| 4 | 折叠项 4 | 修正被我这次改动弄假的注释：`readPersistedSuccessfulTransferArtifacts` 不再返回 `null` | `tests/persistence/fileStore.test.ts` |
| 5 | 折叠项 5 | 更正报告 §十二.3（swallow 的承重依赖是「回调存在」而非「回调在前」） | 本报告 |

关于 #4：同一段注释里的「all 53 tests in this file」在我到达之前就已陈旧，按评审指示**未动**，它不是我的烂摊子。

关于 #1 的计划张力：我在初版报告里具名了这个缺口但没有自行决定。控制器裁定——brief 列三条子用例与
Global Constraints 的「加一个成分和加它的覆盖是一件事」是同一份计划里两条冲突的条款，**通用覆盖条治之**，
补第四条 `it` 是**满足**计划而非违反它。据此补上。

新测试完整测试名：
`fileStore > abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned`

它与测试 (iii) 的断言集相同（赢家记录原样幸存 ＋ 恰好一条 `reconciliation_write_abandoned` ＋ `detail` 含 `JSON`），
这正是让「只改第一个 catch 一处」的局部变异必死的原因。

## 四条测试在变异注入前全绿（原始输出）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'still writes the reconciliation record when owner-transfer.json is simply absent'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (72 tests | 71 skipped) 5ms

 Test Files  1 passed (1)
      Tests  1 passed | 71 skipped (72)
   Start at  21:43:33
   Duration  434ms (transform 179ms, setup 0ms, collect 207ms, tests 5ms, environment 0ms, prepare 44ms)

EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (72 tests | 71 skipped) 5ms

 Test Files  1 passed (1)
      Tests  1 passed | 71 skipped (72)
   Start at  21:43:22
   Duration  447ms (transform 183ms, setup 0ms, collect 214ms, tests 5ms, environment 0ms, prepare 34ms)

EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is not valid JSON, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (72 tests | 71 skipped) 6ms

 Test Files  1 passed (1)
      Tests  1 passed | 71 skipped (72)
   Start at  21:43:29
   Duration  445ms (transform 183ms, setup 0ms, collect 214ms, tests 6ms, environment 0ms, prepare 36ms)

EXIT=0
```

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/persistence/fileStore.test.ts (72 tests | 71 skipped) 5ms

 Test Files  1 passed (1)
      Tests  1 passed | 71 skipped (72)
   Start at  21:43:19
   Duration  461ms (transform 193ms, setup 0ms, collect 224ms, tests 5ms, environment 0ms, prepare 35ms)

EXIT=0
```

## 变异四（Important 1 的击杀证明）：只改第一个 catch 的非 ENOENT 一臂

注入内容——**局部变异，只动一行**，第二个 `try` 与决策层完全不动：

```
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      ...
      return { kind: "no_published_transfer" };
    }

-   return { kind: "unreadable", error };
+   return { kind: "no_published_transfer" };
  }
```

具名：`fileStore > abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned`
注入前绿：上一节第四块（`Tests  1 passed | 71 skipped (72)`，EXIT=0）。
注入后：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (72 tests | 1 failed | 71 skipped) 16ms
   × fileStore > abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned 15ms
     → expected { …(9) } to deeply equal { …(9) }

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > abandons the reconciliation write when owner-transfer.json is not valid JSON, appending reconciliation_write_abandoned
AssertionError: expected { …(9) } to deeply equal { …(9) }

- Expected
+ Received

  Object {
    "conflictingEvidence": Array [],
-   "eligibleForContinuation": true,
+   "eligibleForContinuation": false,
    "lastTrustedBoundary": "execute",
-   "newOwnerEpoch": 2,
-   "ownershipVerdict": "OWNER_LOST",
-   "priorOwnerEpoch": 1,
+   "newOwnerEpoch": null,
+   "ownershipVerdict": "OWNER_UNDECIDABLE",
+   "priorOwnerEpoch": 2,
    "staleConfirmed": true,
    "staleSuspicionBasis": Array [
-     "owner transfer already published",
+     "continuity evidence missing",
    ],
    "takeoverPermission": Object {
-     "allowed": true,
-     "reason": "strict owner-loss conditions satisfied; continuation still requires a later transfer step",
+     "allowed": false,
+     "reason": "deny-by-default until strict owner-loss and transfer conditions are fully met",
    },
  }

 ❯ tests/persistence/fileStore.test.ts:2402:28
    2400|       await readFile(join(runDir, "reconciliation-record.json"), "utf8…
    2401|     ) as ReconciliationRecord;
    2402|     expect(reconciliation).toEqual(persistedReconciliation);
       |                            ^
    2403| 
    2404|     const events = (await readFile(join(runDir, "events.jsonl"), "utf8…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 71 skipped (72)
   Start at  21:43:45
   Duration  482ms (transform 195ms, setup 0ms, collect 234ms, tests 16ms, environment 0ms, prepare 39ms)

EXIT=1
```

**击杀**，且失败信息正是评审预言的那件事：赢家的 `reconciliation-record.json` 被输家的降级覆盖了。
这个变异确实是初版三条测试杀不掉的——它没有把三读收回同一个 catch（那是变异二），只动了一臂。

## 变异五（Important 2 的击杀证明）：`detail: String(decision.error)` → `detail: ""`

具名：`fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned`
注入前绿：上一节第二块（`Tests  1 passed | 71 skipped (72)`，EXIT=0）。
注入后：

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npx vitest run tests/persistence/fileStore.test.ts -t 'abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned'"; echo "EXIT=$?"

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ❯ tests/persistence/fileStore.test.ts (72 tests | 1 failed | 71 skipped) 11ms
   × fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned 10ms
     → expected '' to contain 'owner-record.json'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/persistence/fileStore.test.ts > fileStore > abandons the reconciliation write when owner-record.json is missing, appending reconciliation_write_abandoned
AssertionError: expected '' to contain 'owner-record.json'

- Expected
+ Received

- owner-record.json

 ❯ tests/persistence/fileStore.test.ts:2237:31
    2235|     // detail is the only thing the abandonment says about itself. Nam…
    2236|     // be read is what makes the line actionable, and the ENOENT Error…
    2237|     expect(events[0]?.detail).toContain("owner-record.json");
       |                               ^
    2238|   });
    2239| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 71 skipped (72)
   Start at  21:44:01
   Duration  472ms (transform 189ms, setup 0ms, collect 222ms, tests 11ms, environment 0ms, prepare 35ms)

EXIT=1
```

**击杀**。另两条 abandon 测试断言 `detail` 含 `JSON`（`SyntaxError` 的文本），同一个变异也会打红它们，这里按判据只需具名一条。

## 三条守卫（修复后重跑，原始输出）

```
$ grep -cF 'return { ok: false' src/controller/resumeLoop.ts
8

$ grep -rnF 'currentOwnerEpoch + 1' src/
src/ownership/ownerController.ts:166:  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;

$ git diff --stat -- src/registry/; echo "registry_diff_empty=$?"

registry_diff_empty=0
```

仍为 **8** / **单一命中** / `src/registry/` diff **为空**。

## 全套件 + typecheck + build（修复后，未过滤）

```
$ export ECC_GATEGUARD=off DISABLE_OMC=1 && rtk proxy "npm test -- --run"; echo "TEST_EXIT=$?"

> ccloop@0.1.0 test
> vitest run --run


 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.claude/worktrees/l3-debt1-group-a

 ✓ tests/registry/renderRuns.test.ts (11 tests) 7ms
 ✓ tests/controller/resumeLoop.gate.test.ts (27 tests) 4ms
 ✓ tests/registry/scanRuns.test.ts (9 tests) 7ms
 ✓ tests/controller/leaseHeartbeat.test.ts (20 tests) 753ms
 ✓ tests/registry/zeroWrite.test.ts (2 tests) 277ms
 ✓ tests/ownership/ownerController.test.ts (13 tests) 4ms
 ✓ tests/controller/leaseGate.test.ts (12 tests) 70ms
 ✓ tests/registry/observeFields.test.ts (13 tests) 4ms
 ✓ tests/registry/readObservedFile.test.ts (6 tests) 4ms
 ✓ tests/persistence/leaseStore.test.ts (9 tests) 36ms
stderr | tests/cli/cli.test.ts > parseArgs > returns exit code 1 when required flags are missing
missing required flags

stderr | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 1 when the root does not exist — the scan itself failed
ENOENT: no such file or directory, scandir '/var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-missing-WI7W9e/does-not-exist'

 ✓ tests/persistence/fileStore.test.ts (72 tests) 2655ms
   ✓ fileStore > refuses resume at every pre-commit crash gap of the three-file transaction, commits idempotently past it, and finishes recovery wherever the marker survives 2214ms
stdout | tests/cli/cli.test.ts > main ls (spec §9, §12.8) > exits 0 for a scan that produces an unreadable row, never 2
Fields within a row are independent observations and do not constitute a consistent snapshot. eligibleForContinuation is an observed field, not a decision that the run may be resumed.

RUN  /var/folders/nb/068k_scs4gzgclcp66f9hys40000gn/T/ccloop-ls-damaged-cUMiwF/run-1  observed 2026-08-02T13:44:21.683Z
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

 ✓ tests/controller/resumeLoop.integration.test.ts (11 tests) 2723ms
   ✓ resumeLoop > resumes an eligible run from the next attempt and claims ownership 348ms
   ✓ resumeLoop > refuses (and mutates nothing) when eligibility is not published 388ms
   ✓ resumeLoop > discards a residual worktree from the interrupted attempt during resume (next-attempt-fresh) 381ms
 ✓ tests/cli/cli.test.ts (15 tests) 507ms
   ✓ parseArgs > returns 0 for the scripted example run 368ms
 ✓ tests/ownership/lease.test.ts (16 tests) 4ms
 ✓ tests/registry/observeRun.test.ts (4 tests) 4ms
 ✓ tests/contract/loadContract.test.ts (7 tests) 19ms
 ✓ tests/runtime/scriptedAdapter.test.ts (1 test) 2ms
 ✓ tests/stop/stopController.test.ts (4 tests) 2ms
 ✓ tests/state/stateMachine.test.ts (4 tests) 4ms
 ✓ tests/workspace/worktreeManager.test.ts (1 test) 275ms
 ✓ tests/runtime/processIdentity.test.ts (2 tests) 2ms
 ✓ tests/validation/contracts.test.ts (19 tests) 2571ms
   ✓ render-contract CLI > writes a validated scenario contract JSON file 680ms
   ✓ render-contract CLI > rejects scenario C without an explicit timeout 564ms
   ✓ render-contract CLI > rejects a non-git repository path 611ms
   ✓ render-contract CLI > refuses to overwrite an existing output file 705ms
 ✓ tests/validation/prepareA04.test.ts (52 tests) 3635ms
   ✓ inspectMetadataBackedA04History > uses the brief-specified contradiction phrases for historical diagnoses and paid-call approval 414ms
   ✓ inspectMetadataBackedA04History > confirms paid-call approval from the live 2026-07-18 A-04 boundary wording 528ms
   ✓ inspectMetadataBackedA04History > marks historical diagnoses contradictory when any canonical A-01 through A-03 diagnosis drifts 400ms
   ✓ inspectMetadataBackedA04History > treats retained stashes as present only when a required retained stash matches 394ms
   ✓ inspectMetadataBackedA04History > reports the discovered legacy evidence worktree paths 418ms
   ✓ inspectMetadataBackedA04History > reports an unreadable legacy preserved evidence tree as a soft signal instead of failing inspection 403ms
   ✓ inspectMetadataBackedA04History > reports unreadable required metadata docs through the summary contract 389ms
   ✓ inspectMetadataBackedA04History > keeps the backup branch present when merge-base reachability is unavailable 537ms
 ✓ tests/policy/pathPolicy.test.ts (2 tests) 3ms
 ✓ tests/validation/fixture.test.ts (2 tests) 572ms
   ✓ createFixture > creates a clean Git fixture at one baseline commit 570ms
 ✓ tests/controller/leaseLifecycle.integration.test.ts (25 tests) 7113ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop returns, so the next resume proceeds immediately 329ms
   ✓ lease heartbeat lifecycle > releases the lease when the loop throws 448ms
   ✓ lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy 591ms
   ✓ lease heartbeat lifecycle > retries a busy owner-transfer lock and completes once it clears (spec requirement 1) 575ms
   ✓ lease heartbeat lifecycle > abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2) 636ms
   ✓ lease heartbeat lifecycle > retries zero times on a CAS mismatch (spec requirement 3) 532ms
   ✓ lease heartbeat lifecycle > refuses the catch-path re-read once superseded, rather than finalizing a staged transfer it no longer owns 430ms
   ✓ lease heartbeat lifecycle > blocks a due affirm until the transfer's exclusive span completes, with zero CAS failures and no lease_lost (spec requirement 4) 375ms
   ✓ lease heartbeat lifecycle > a self-performed transfer with adopt inside the exclusive span appends no lease_lost event (spec requirement 5) 363ms
   ✓ lease heartbeat lifecycle > writes no boundary artifact — but its own already-committed transfer's reconciliation record stands — when superseded after its own transfer completes (spec requirement 7, amended by task A4) 359ms
 ✓ tests/runtime/claude/subprocessClaudeAdapter.test.ts (28 tests) 9682ms
   ✓ SubprocessClaudeAdapter > reports token usage for snake-only usage envelope 591ms
   ✓ SubprocessClaudeAdapter > reports token usage for camel-only usage envelope 417ms
   ✓ SubprocessClaudeAdapter > reports token usage for duplicate camel and snake aliases without double counting 386ms
   ✓ SubprocessClaudeAdapter > reports token usage for mixed aliases when only snake input and camel output are present 380ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when missing usage keeps evidence absent 387ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when null usage is recorded as invalid 411ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when all usage aliases have invalid types 399ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when invalid snake input type keeps finite output token usage 391ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative and fractional values preserve current semantics 392ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when zero total is not reported 362ms
   ✓ SubprocessClaudeAdapter > reports usage evidence when negative total is not reported 355ms
   ✓ SubprocessClaudeAdapter > falls back from a non-finite snake alias to a finite camel alias 356ms
   ✓ SubprocessClaudeAdapter > ignores a non-finite alias when no finite fallback exists 358ms
   ✓ SubprocessClaudeAdapter > omits token usage when finite selected fields overflow in sum 357ms
   ✓ SubprocessClaudeAdapter > returns null when aborted execute yields no final result 515ms
   ✓ SubprocessClaudeAdapter > terminates the inner Claude process when plan is interrupted 379ms
   ✓ SubprocessClaudeAdapter > parses a large partial execute payload after wrapper interruption 504ms
   ✓ SubprocessClaudeAdapter > includes brand-new untracked files in partial execute diff recovery 519ms
   ✓ SubprocessClaudeAdapter > includes both staged and unstaged edits in partial execute diff recovery 356ms
   ✓ SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute 550ms
   ✓ SubprocessClaudeAdapter > returns repo-relative target paths for renamed and quoted files 380ms
 ✓ tests/controller/runLoop.integration.test.ts (51 tests) 10894ms
   ✓ runLoop > succeeds when verification approves 349ms
   ✓ runLoop > rejects reusing a runDir that already contains preserved run state 501ms
   ✓ runLoop > succeeds from requiredChecks alone when verifierType is command 309ms
   ✓ runLoop > persists retry-ready planning state before retry cleanup runs 389ms
   ✓ runLoop > passes phase state plus plan/execution context to each adapter step 356ms
   ✓ runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals 742ms
 ✓ tests/validation/evidence.test.ts (39 tests) 15844ms
   ✓ finalize-review CLI > rejects unknown verdicts and diagnoses 1446ms
   ✓ finalize-review CLI > stores diagnosis null as JSON null and refuses overwrite 1174ms
   ✓ run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid 2684ms
   ✓ run-scenario CLI > works when invoked outside the repo root 1546ms
   ✓ run-scenario CLI > runs when invoked through a canonical-path alias 1578ms
   ✓ run-scenario CLI > creates a fresh nested evidence directory when its parent does not exist 1549ms
   ✓ run-scenario CLI > writes evidence files even when ccloop fails before creating the run directory 582ms
   ✓ run-scenario CLI > fails on an existing evidence directory without overwriting it 589ms
   ✓ run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data 565ms
   ✓ run-scenario CLI > rejects a fixture path that does not match the rendered contract repoPath 914ms
   ✓ run-scenario CLI > rejects a scenario that does not match contract objective.taskId before child launch 557ms
   ✓ run-scenario CLI > records claudeChildExited as NOT_OBSERVABLE when no adapter descendant was tracked 2455ms

 Test Files  29 passed (29)
      Tests  477 passed (477)
   Start at  21:44:18
   Duration  16.51s (transform 1.94s, setup 0ms, collect 3.76s, tests 57.68s, environment 3ms, prepare 1.72s)

TEST_EXIT=0
```

- `Test Files  29 passed (29)` / `Tests  477 passed (477)`，`TEST_EXIT=0`。
- 476 + 1（第四条 `it`）= 477，对得上；`detail` 三条断言是加在既有 `it` 内部的，不改条数。
- **两条允许的 flake 都没有出现**：`tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid` 显示 `✓ … 2684ms`；
  `tests/controller/runLoop.integration.test.ts` 整个文件 `✓ (51 tests)`。名单外也无任何失败。

```
$ rtk proxy "npm run typecheck"; echo "typecheck_exit=$?"

> ccloop@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

typecheck_exit=0
```

```
$ rtk proxy "npm run build"; echo "build_exit=$?"

> ccloop@0.1.0 build
> tsc -p tsconfig.json && node -e "const fs=require('fs');fs.writeFileSync('dist/cli.js', '#!/usr/bin/env node\nexport * from \"./src/cli.js\";\nimport { main } from \"./src/cli.js\";\nvoid main(process.argv.slice(2)).then((code) => { process.exitCode = code; });\n');fs.writeFileSync('dist/cli.d.ts', 'export * from \"./src/cli.js\";\n');"

build_exit=0
```

## 自查（修复轮）

在写下面这句自证之前，我把本节每一个输出块从 `RUN`/`>` 首行读到 `EXIT=`/`_exit=` 末行检查过一遍：
**没有一处省略是我做的**；块内出现的单字符 `…`（如 `expected { …(9) } to deeply equal { …(9) }`）全部是 vitest 自有的对象/源码行截断，逐字照抄。
每条命令都回显了退出码；每个数字（8、单一命中、477、476+1）旁边都附了能重推它的命令与那次执行的输出。

- 五项改动全部落地，无一遗漏。
- **无新增许可**：第四条测试只钉一条**拒绝**；`detail` 断言只加约束；第 3 项是纯注释；第 4 项是纯注释；第 5 项只改报告。
- **`src/persistence/fileStore.ts` 的唯一代码语义改动仍然是零**——修复轮对生产代码只加了一段注释，
  两个联合类型、四格决策、abandon 分支的形状与初版提交逐字相同，A8 / 组 C 12d 的依赖面未变。
- 变异实验全部跑在 git 仓库本体上、基线全绿（上文全套件），非 scratchpad 副本。
- 未 push、未 merge、未做 `git clean` / `reset --hard` / 广域 `restore`；变异还原一律 `/bin/cp -f` 定点覆盖单文件。

## 遗留关切（修复轮后）

1. 初版的关切 1（第一个 catch 非 ENOENT 一臂无护栏）**已闭合**——第四条 `it` ＋ 局部变异四。
2. 初版的关切 3 **已按评审更正**（见上文 §十二.3 的更正段）：承重依赖是「A8 必须落地回调」，不是「回调必须排在 `appendEvent` 之前」。
3. 初版的关切 2（recovery-skip）经评审对着代码复核为良性，且现在**已写进生产代码注释**，不再只活在报告里。
4. 其余无新增关切。
