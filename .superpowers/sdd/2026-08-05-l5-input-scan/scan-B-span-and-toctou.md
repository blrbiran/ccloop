# L5 输入盘点 — 切片 B：exclusive span 外的 artifact 写 ＋ 输家 reconciliation 的残余 TOCTOU

> 只读盘点。仓库 `/Users/biran/code/skills/loop/ccloop`，分支 `main`，HEAD `e9021ef`，工作区干净。
> 主文档：`docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md`（§13）。
> 本文件是本次扫描唯一写入的文件。未改动 `src/`、`tests/`、`docs/`、任何 spec 或 plan。

## 完整度声明

**完整（证据齐、命令与逐字输出全部当场重跑）**：

- 项 A-1 主体 —— 除下面列的一处缺口外完整
- 项 A-2 附带（三类失败，含第 (iii) 类的 pre-L3 / 今天逐字对照）—— 除下面列的一处缺口外完整
- 项 B-1 主体（两条时序的可达性构造、论据逐句核对、后果分级含静默性补核）—— 完整
- 项 B-2 附带 —— 除下面列的一处缺口外完整

**不完整，逐条写明缺什么**：

1. **项 A-1**：未核 L1b「明确否决过把 artifact 写搬进 span」这条裁定的原文出处。**缺：L1b 那次否决的裁定记录定位与逐字引用。**
2. **项 A-2**：未核 §11「⚠️ 但『本层一个字节不改 `stop()`』不等于……」整节的全部论证（只核了被 §13 引用的那几句），也未核 §15 验收 4 的措辞。**缺：§11 该节剩余论证 ＋ §15 验收 4 的逐句核对。**
3. **项 B-2**：未核原文依据 (a)「L1 §12 第 7 条的范围不含该文件」。**缺：`2026-07-26-run-lease-and-heartbeat-design.md` §12 第 7 条的逐字引用与范围核对。**
4. **全局**：没有把任何一条时序写成可运行的测试场景，也没有运行 `tests/` 下任何用例。本报告的可达性结论全部来自逐环读代码，不是观测到的运行结果。**这一点适用于 A-1 命题二、A-2 第 (iii) 类、B-1 两条时序。**

**⚠️ 两处需要人裁、我按铁律 5 未自行改判的地方**（详见「我发现的、原文没写的东西」）：

- **发现 1**：§5.2 :1143 仍在用 §13 已撤回的「债 3 部分关闭」归类，G10 的修订处清单未列 §5.2。
- **发现 2**：§4.4「规则 3 仍然不可达」被它自己那条 P2/P3 路径在今天的代码上证伪（marker 的 ENOENT 落进规则 3 的无条件 catch）。

**⚠️ 归属提示（不得丢失）**：**项 A 明写「需要一次归属裁决」；项 B 明写「这是先于本层的缺陷」。两笔的归属属性相反，不可互换。** 项 A-2 第 (iii) 类另有一个独立属性：**它是 L3 扩大出来的**，与 A-1 主体的「本轮新发现」不同源。

## 项 A-1：`writeBoundaryArtifacts` 及其前置 `assertHeld` 落在 exclusive span 之外（主体）

### 归属是否需要重裁 —— ⚠️ 是，原文明写

原文 §13 第 3 笔标题逐字：

> 3. **`writeBoundaryArtifacts` 及其前置 `assertHeld` 落在 exclusive span 之外（*本轮新发现，需要一次归属裁决*——不是「债 3 的未关闭部分」，见上面的「债 3 的归类更正」）。**

§13「债 3 的归类更正」小节的落款句，逐字：

> - **归类错误的实际危害**：写成「债 3 部分关闭」会让 L5 以为自己继承的是一笔**已被裁决过归属**的债，从而不再重新裁决；而它其实是一条**从未被任何裁决记录处理过**的新发现，**归属应当重新裁**。

**L5 不得把这一笔当作已裁决过的继承债处理。它需要一次新的归属裁决。**

### 原文出处

- `docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md` §13 第 3 笔（今天在 :2417 起）、§13「债 3 的归类更正」（:2348 起）、§5.2「⚠️ 范围声明」（:1133 起）。
- §13 第 3 笔正文逐字：

  > `runExclusive` 的拒绝只覆盖进入 `queue` 的 span，而 `persistBoundaryAnalysis` 里 `runExclusive` 返回之后的 `assertHeld()` + `writeBoundaryArtifacts` 明确留在 span 外（代码注释自己写着 "`writeBoundaryArtifacts` below stays OUTSIDE"）。**一次并发 `stop()` 可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 见 §5.2 的范围声明。本层不修，因为覆盖它要么把 artifact 写搬进 span（L1b 刚明确否决过），要么另设一层守卫。

### 今天的落点

- `persistBoundaryAnalysis` in `src/controller/runLoop.ts`（今天在 :724）
- 入口守卫 `await heartbeat.assertHeld()` in `persistBoundaryAnalysis`（今天在 :744）
- `heartbeat.runExclusive(...)` 的 span（今天 :786 起、:872 `});` 收）
- span 外的第二个 `await heartbeat.assertHeld()`（今天在 :891）
- span 外的两个 `writeBoundaryArtifacts` 调用（今天在 :903 与 :927）
- `runExclusive` / `stop` in `src/controller/leaseHeartbeat.ts`（今天 :209 / :237 起）

### 重推命令与当时输出

原文引的那条命令，今天逐字重跑：

```
$ grep -nF -B6 'const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(' src/controller/runLoop.ts; echo "EXIT=$?"
780-  // Task 4 / owner-transfer-contention design §4: the whole read → evaluate → CAS transfer →
781-  // adopt span runs inside the heartbeat's own serialization queue, so no affirm (whether the
782-  // interval timer's or a directly-invoked one) can land between the read and the CAS — the
783-  // race defect 2 exploited — or between the CAS and `adopt()` — the residual L1's review
784-  // parked. `writeBoundaryArtifacts` below stays OUTSIDE: there is no reason to make the
785-  // heartbeat wait behind artifact writes.
786:  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(
EXIT=0
```

**核实结论：exit 0，注释逐字写着 "`writeBoundaryArtifacts` below stays OUTSIDE"。原文这一句今天成立。**

`stop()` 的今天形状（`sed -n '100,290p' src/controller/leaseHeartbeat.ts` 的相关片段，逐字）：

```
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearInterval(timer);
    await queue.catch(() => {});

    // §6.0: cancelling the timer is only half. Without this release, a run that has already
    // finished still reads as "somebody is running this" for up to one TTL and refuses the
    // next legitimate process. Best-effort: on the lease_lost path the CAS cannot match and
    // the write is swallowed, which is exactly right — a superseded process must not touch
    // the new owner's record.
    try {
      await releaseOwnerLease(options.runDir, expected);
    } catch {
      // Swallowed by contract: the lease simply ages out.
    }
  };
```

`runExclusive` 的拒绝，今天逐字：

```
  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const refuseIfStopped = async (): Promise<T> => {
      if (stopped) {
        throw new RunHeartbeatStoppedError(
          `run heartbeat has stopped: refusing an exclusive owner-record operation for ${expected.currentProcessInstanceId} at epoch ${expected.currentOwnerEpoch}`,
        );
      }

      return await fn();
    };

    const result = queue.then(refuseIfStopped, refuseIfStopped);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
```

`stop()` 的今天全部生产调用点：

```
$ grep -rnF 'heartbeat.stop()' -- src
src/cli.ts:169:// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
src/controller/runLoop.ts:989:    await heartbeat.stop();
src/controller/resumeLoop.ts:215:    await heartbeat.stop();
```

两个调用点的上下文（`sed -n '975,995p' src/controller/runLoop.ts` 与 `sed -n '200,220p' src/controller/resumeLoop.ts`，逐字节选）：

```
  try {
    return await runLoopFromState(contract, runDir, adapter, state, heartbeat, leaseLoss);
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}
```

```
    return await runLoopFromState(contract, runDir, adapter, resumedState, heartbeat, leaseLoss, {
      onReconciliationWriteAbandoned: options?.onReconciliationWriteAbandoned,
      stopRequested: options?.stopRequested,
    });
  } finally {
    // §6.0: every exit path — normal completion, stop-boundary exit, and any throw.
    await heartbeat.stop();
  }
}
```

`cli.ts` 的信号处理器（`sed -n '150,185p' src/cli.ts` 逐字节选）：

```
// L3 §5.4's escape hatch. ONE counter across both signals: the first fills the stop slot the loop
// reads at its next boundary, the second exits immediately. Counting per signal kind would mean
// "Ctrl-C, then kill" — the escalation an operator reaches for when the first press seems to have
// done nothing — never reaches the hatch at all.
//
// The handler is handed the stop SLOT and nothing else. It cannot stop the heartbeat, and does
// not: the two `heartbeat.stop()` call sites stay in the `finally` after runLoopFromState.
export function registerStopHandlers(
  signal: StopRequestSignal,
  options?: { exit?: (code: number) => void },
): () => void {
```

### 今天是否可达

**必须拆成两个命题，原文把它们合在一句里。**

**命题一（结构）：span 外那段没有任何守卫覆盖它 —— 今天成立，已核实。**
`runExclusive` 的 `refuseIfStopped` 只跑在 `queue` 的续体头部。:891 的 `assertHeld()` 与 :903/:927 的 `writeBoundaryArtifacts` 在 `await heartbeat.runExclusive(...)` **返回之后**，从未进入 `queue`。且 `stop()` 只 `await queue.catch(...)` —— 而 `runExclusive` 返回时已把 `queue` 重置为一个**已决**的 promise，所以 `stop()` 读到的 `queue` 不包含 span 外那段。**结论：`stop()` 不等待 `writeBoundaryArtifacts`。**

**命题二（触发）：「一次并发 `stop()` 可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`」 —— 在今天的 `src/` 里 *没有* 调用者能构造出来。**

写死的触发条件（三条全部满足才可达）：

1. 存在一个在 `persistBoundaryAnalysis` **飞行期间**调用 `heartbeat.stop()` 的调用者。今天没有：上面 grep 实测生产调用点恰好两处，都在 `await runLoopFromState(...)` 之后的 `finally` 里，而 `persistBoundaryAnalysis` 的两个调用点（:1217、:1271）都在 `runLoopFromState` **内部**并被 `await`。串行，不重叠。
2. 或：信号处理器直接调 `stop()`。今天不可能 —— `registerStopHandlers` 只写 `signal.requested = true` 与 `exit(130)`，注释与代码一致（"It cannot stop the heartbeat"）。
3. 或：§14 第 2 条的常驻形态（`watch`）落地，让 `stop()` 与飞行中的 run 并存。**这是原文自己点名的那条路**（§14 第 2 条：「常驻形态（`watch`）：会让「飞行中 `stop()`」重新成为问题」）。

**⚠️ 这里有一处必须交给人裁的不对称，我不自行改判：**
§5.3 对**同族**的姊妹命题（`stopped` 之后的 `runExclusive`）做了**明确的可达性表态**，逐字：

> **关于可达性，本层的诚实表态**：`stopped` 之后的 `runExclusive` 在 **L3 内不可达**（上面那条 grep 就是证据）。本改动是**纵深防御**，也是 §14 常驻形态（`watch`）的前置加固——常驻形态会让飞行中 `stop()` 真正可达。

而 §5.2 / §13 第 3 笔对 span 外那段写的是无条件的「**完全可以**／**可以**」，**没有配上同一条可达性限定**。两处依据的是同一条 grep 事实（`stop()` 只在 `finally` 里被调）。**我不判定哪一处措辞对。原样上报：结论（这一笔该传 L5）不受影响，但「一次并发 `stop()` 可以……」这句在今天的 `src/` 上缺一个「L3 内不可达、常驻形态下可达」的限定，而它的同族句子有。**

### 论据是否腐坏

| 原文论据句 | 今天是否成立 | 备注 |
|---|---|---|
| 「代码注释自己写着 "`writeBoundaryArtifacts` below stays OUTSIDE"」 | **成立** | 逐字命中 runLoop.ts:784 |
| 「`runExclusive` 的拒绝只覆盖进入 `queue` 的 span」 | **成立** | `refuseIfStopped` 在续体头部，:209-:227 |
| 「`runExclusive` 返回之后的 `assertHeld()` + `writeBoundaryArtifacts` 明确留在 span 外」 | **成立** | :891 / :903 / :927 均在 `await runExclusive(...)` 之后 |
| 「一次并发 `stop()` 可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`」 | **机制成立，触发在今天的 `src/` 内无调用者** | 见上面命题二。**这是「结论不腐、论据缺限定」，不是结论腐坏** |
| §13 说本笔「是一条别的竞态」「从来就没进过任何 `queue`」 | **成立** | 同上 |

### 后果分级

**数据丢失**（条件性：仅在触发条件满足时）。据以分级的证据：`stop()` 里的 `releaseOwnerLease` 把 `leaseAffirmedAt` 置 `null`（`fileStore.ts:1171`-`:1178` 实测），此后 `writeBoundaryArtifacts` 仍会写 `boundary-analysis.json` 与 `reconciliation-record.json`（`fileStore.ts:446` / `:494` 实测），即**一个已经宣告「不再运行」的进程仍在写 run 目录**，且此刻 `assertHeld` 已经跑完、不会再拦。在今天的 `src/` 上因无触发者而**未实际发生**，所以对 L5 的现实分级是：**常驻形态（§14 第 2 条）落地前为「仅文档 / 纵深防御」，落地后为「数据丢失」。**

### 我不确定的地方

- 我没有把三条触发条件写成一个可运行的测试场景。构造它需要一个在 `persistBoundaryAnalysis` 飞行中调 `stop()` 的测试替身（`startLeaseHeartbeat` 是 exported 的，测试可直接持有 handle），但那构造的是**测试内**可达，不是生产可达，我不认为它能回答归属裁决要问的问题，所以没写。
- 我没有核 L1b「刚明确否决过把 artifact 写搬进 span」这条裁定的原文出处（原文只给了转述，没给命令）。**本项这一小块未完成，缺：L1b 那次否决的裁定记录定位与逐字引用。**

## 项 A-2：附带残余 —— L1 §12 第 17 条与 `stop()` 里被吞掉的 `releaseOwnerLease`（三类失败）

原文明写**不单开一笔**：「附带一笔同类的残余（第三轮，§11 的 Rule 7 裁定指到这里；第四轮补上第三类）」——它是 A-1 的前提条件。

### 原文出处

§13 第 3 笔的「附带一笔同类的残余」（今天在 :2417-:2421）。三类逐字：

> - **CAS 因所有权易主而失配**：**不构成违反**（那时 resume 的主体已经换人）。
> - **锁忙 / I/O 失败**：会让第 17 条的「immediately」退化成「TTL 之后」。**先于本层存在**，本层不修也不弱化。
> - **⚠️ `recoverInterruptedOwnerTransfer` 的具名 fail-closed 抛出（第四轮新增，这一类是*本层扩大出来的*）**：`releaseOwnerLease` → `updateOwnerRecordWithPrecondition`（`:720`）内部在 `:729` 跑一次 `lockHeld: true` 的恢复，**不在任何 catch 内**；本层给这次恢复加了第三个参与文件、一次 marker 的 `readFile` ＋ `JSON.parse`、以及规则 2 / 3 两条新的具名抛出。**规则 2 已被第四轮证明可达**（§4.4 的「⚠️ 规则 2 可达」）。抛出 → release 失败 → `stop()` 吞掉 → 第 17 条的 "immediately" 退化。**这一类不是「先于本层」，是本层扩大的**，完整论证见 §11 的「⚠️ 但『本层一个字节不改 `stop()`』不等于……」一节。**本层记账不修**（修它要改 `stop()` 或动锁协议，两者都超出范围）。

被违反的那条要求，`docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md` §12 第 17 条，逐字（今天在 :370）：

> 17. **A finished run releases its lease** — after the loop returns, and separately after it throws, `leaseAffirmedAt` is back to `null` and a subsequent legitimate `resume` proceeds *immediately*, not after a TTL. Asserted while the last heartbeat is still well inside the TTL, so an implementation that only cancels the timer fails it (§6.0).

### ⚠️ 第 (iii) 类的关键属性：这一类是 L3 扩大出来的，不是先于 L3 的

**这个属性对 L5 排优先级承重，下面用 pre-L3 与今天的代码逐字对照证明它今天仍然成立。**

### 今天的落点（第 (iii) 类的完整链路，逐个符号确认）

`stop()` → `releaseOwnerLease` → `updateOwnerRecordWithPrecondition` → `recoverInterruptedOwnerTransfer({ lockHeld: true })` → `finalizePendingOwnerTransfer` → 三条具名抛出。

- `stop` in `src/controller/leaseHeartbeat.ts`（今天在 :237），`releaseOwnerLease` 在 :254，包在 `try{}catch{}` 内（见 A-1 已贴的逐字输出）
- `releaseOwnerLease` in `src/persistence/fileStore.ts`（今天在 :1171；**原文写的 `:769` 已腐坏**）
- `updateOwnerRecordWithPrecondition` in `src/persistence/fileStore.ts`（今天在 :1122；**原文写的 `:720` 已腐坏**）
- 那次持锁恢复（今天在 :1131；**原文写的 `:729` 已腐坏**）
- `recoverInterruptedOwnerTransfer` in `src/persistence/fileStore.ts`（今天在 :1007）
- `finalizePendingOwnerTransfer` in `src/persistence/fileStore.ts`（今天在 :931）
- 具名抛出：`OwnerTransferMarkerUnreadableError`(:940)、`OwnerTransferMarkerFinalizeOrderInvalidError`(:949)、`OwnerTransferPendingMissingError`(:993)

### 重推命令与当时输出

```
$ grep -nF -A8 'export async function releaseOwnerLease(' src/persistence/fileStore.ts; echo "EXIT=$?"
1171:export async function releaseOwnerLease(runDir: string, expected: OwnerRecord): Promise<void> {
1172-  await updateOwnerRecordWithPrecondition(
1173-    runDir,
1174-    expected,
1175-    (persisted) => ({ ...persisted, leaseAffirmedAt: null }),
1176-    "persisted owner record changed before the lease could be released",
1177-  );
1178-}
1179-
EXIT=0
```

```
$ grep -nF -A16 'async function updateOwnerRecordWithPrecondition(' src/persistence/fileStore.ts; echo "EXIT=$?"
1122:async function updateOwnerRecordWithPrecondition(
1123-  runDir: string,
1124-  expectedOwnerRecord: OwnerRecord,
1125-  buildNext: (persisted: OwnerRecord) => OwnerRecord,
1126-  mismatchMessage: string,
1127-): Promise<OwnerRecord> {
1128-  const lock = await acquireOwnerTransferLock(runDir);
1129-
1130-  try {
1131-    await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });
1132-    const persistedOwnerRecord = await readOwnerRecordRaw(runDir);
1133-
1134-    if (!sameOwnerRecord(persistedOwnerRecord, expectedOwnerRecord)) {
1135-      throw new OwnerTransferPreconditionError(mismatchMessage);
1136-    }
1137-
1138-    const nextOwnerRecord = buildNext(persistedOwnerRecord);
EXIT=0
```

**核实：`:1130` 那个 `try` 只配 `finally { await lock.release(); }`（见下方 `sed` 输出），恢复调用 `:1131` 不在任何 `catch` 内。原文这一句今天成立。** `sed -n '1000,1200p'` 中该函数的收尾部分逐字：

```
    const nextOwnerRecord = buildNext(persistedOwnerRecord);
    await writeOwnerRecordAtomically(runDir, nextOwnerRecord);
    return nextOwnerRecord;
  } finally {
    await lock.release();
  }
}
```

```
$ grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts; echo "EXIT=$?"
1007:async function recoverInterruptedOwnerTransfer(runDir: string, options?: { lockHeld?: boolean }): Promise<void> {
1008-  const paths = getOwnerTransferPaths(runDir);
1009-
1010-  if (!(await pathExists(paths.transactionMarkerPath))) {
1011-    if (options?.lockHeld) {
1012-      await cleanupOwnerTransferStagingWithoutMarker(runDir);
1013-    }
1014-    return;
1015-  }
1016-
1017-  if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStaleOwnerTransferLock(runDir))) {
1018-    return;
1019-  }
1020-
1021-  await finalizePendingOwnerTransfer(runDir);
1022-}
1023-
EXIT=0
```

```
$ grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts; echo "EXIT=$?"
931:async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
932-  const paths = getOwnerTransferPaths(runDir);
933-
934-  let marker: OwnerTransferTransactionMarker;
935-
936-  try {
937-    marker = JSON.parse(await readFile(paths.transactionMarkerPath, "utf8")) as OwnerTransferTransactionMarker;
938-  } catch {
939-    // §4.4 rule 3: an unparseable marker is fail-closed — reject before anything is touched.
940-    throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker could not be read or parsed");
941-  }
942-
943-  if (!isValidFinalizeOrder(marker.finalizeOrder, legalFinalizeOrderFileNames(marker.version))) {
944-    // Fail-closed, same as rules 2/3: nothing has been read or touched on disk yet. Without this,
945-    // a v2 marker whose finalizeOrder named only 2 of the 3 legal files would iterate exactly what
946-    // it names, publish those, delete the marker, and leave the omitted pending silently orphaned
947-    // with no error and no cleanup path pointing at it — strictly less safe than the pre-A3 code,
948-    // which ignored finalizeOrder and unconditionally handled all three v2 files.
949-    throw new OwnerTransferMarkerFinalizeOrderInvalidError(
950-      `owner transfer transaction marker's finalizeOrder is not a valid permutation of the v${marker.version} file set`,
951-    );
952-  }
953-
EXIT=0
```

规则 2 的抛出点，`sed -n '880,1006p'` 中该循环的逐字片段：

```
  for (const fileName of marker.finalizeOrder) {
    const target = fileTargets[fileName];
    let value: unknown;

    try {
      value = JSON.parse(await readFile(target.pendingPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // §4.4 rule 2: fail-closed — a marker that promises this file but finds no pending for
        // it refuses to finalize, leaving the marker and every already-checked pending in place.
        throw new OwnerTransferPendingMissingError(
          `owner transfer pending file for ${fileName} is missing while finalizing a v${marker.version} marker`,
        );
      }

      throw error;
    }

    staged.push({ ...target, value });
  }
```

**pre-L3 对照** —— `git show 0289846~1:src/persistence/fileStore.ts`（`0289846` 是 L3 spec 落地的首个提交，`git log --reverse` 实测）：

```
$ git show 0289846~1:src/persistence/fileStore.ts | grep -nF -A30 'async function finalizePendingOwnerTransfer('
608:async function finalizePendingOwnerTransfer(runDir: string): Promise<void> {
609-  const paths = getOwnerTransferPaths(runDir);
610-  const ownerRecord = JSON.parse(await readFile(paths.ownerPendingPath, "utf8")) as OwnerRecord;
611-  const transferRecord = JSON.parse(await readFile(paths.transferPendingPath, "utf8")) as OwnerTransferRecord;
612-
613-  try {
614-    await safeUnlink(paths.transferTempPath);
615-    await safeUnlink(paths.ownerTempPath);
616-    await writeJsonFile(paths.transferTempPath, transferRecord);
617-    await rename(paths.transferTempPath, paths.transferPath);
618-    await writeJsonFile(paths.ownerTempPath, ownerRecord);
619-    await rename(paths.ownerTempPath, paths.ownerPath);
620-    await safeUnlink(paths.transactionMarkerPath);
621-    await safeUnlink(paths.transferPendingPath);
622-    await safeUnlink(paths.ownerPendingPath);
623-  } catch (error) {
624-    await safeUnlink(paths.transferTempPath);
625-    await safeUnlink(paths.ownerTempPath);
626-    throw error;
627-  }
628-}
```

**对照结论（第 (iii) 类「是 L3 扩大出来的」，今天成立）**：pre-L3 的 finalize **没有** marker 的 `readFile`+`JSON.parse`、**没有** 任何具名抛出、**只有两个**参与文件。今天三样全在。原文这一句今天成立。

### 今天是否可达

**可达。** 构造（跨进程，不需要任何测试替身；这是 §4.4「⚠️ 规则 2 可达」那条路径的下游）：

1. P1 持锁写完三份 pending ＋ marker 后被 SIGKILL。锁文件留在盘上，pid 已死。
2. P2 走 `readOwnerRecord` → `recoverInterruptedOwnerTransfer`（**不**持锁）→ :1017 判定：marker 在、锁在，`tryRecoverStaleOwnerTransferLock` 判 pid 死 → `safeUnlink(lockPath)` → 返回 true → `!true` 为 false → P2 进 `finalizePendingOwnerTransfer`。
3. **锁此刻已被 P2 删掉。** 我们这个进程的 `stop()` → `releaseOwnerLease` → `updateOwnerRecordWithPrecondition` → `acquireOwnerTransferLock` **成功拿到锁**（锁已不存在），→ :1131 `recoverInterruptedOwnerTransfer({ lockHeld: true })` → :1010 `pathExists(marker)` 为真（P2 还没删到）→ 跳过 :1017（`lockHeld` 短路）→ 进 finalize。
4. P2 抢先跑完，把 marker 与三份 pending 全部 `safeUnlink`。
5. 我们停在 :937 的 marker `readFile` → ENOENT → **`OwnerTransferMarkerUnreadableError`**；或已读到 marker、停在 pending 的 `readFile` → ENOENT → **`OwnerTransferPendingMissingError`**。
6. 抛出穿过 `updateOwnerRecordWithPrecondition`（`finally` 只 release 锁，不吞）→ 穿过 `releaseOwnerLease`（无 catch）→ 落进 `stop()` 的 `catch {}` → **被吞**。
7. `leaseAffirmedAt` **没有**被置回 `null` → L1 §12 第 17 条的 "immediately" 退化成 "TTL 之后"。

`tryRecoverStaleOwnerTransferLock` 今天的形状（供第 2 步复核）：

```
$ grep -nF -A22 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts; echo "EXIT=$?"
780:async function tryRecoverStaleOwnerTransferLock(runDir: string): Promise<boolean> {
781-  const { lockPath, ownerPendingPath, transferPendingPath, transactionMarkerPath } = getOwnerTransferPaths(runDir);
782-  let lockContents = "";
783-
784-  try {
785-    lockContents = await readFile(lockPath, "utf8");
786-  } catch (error) {
787-    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
788-      return true;
789-    }
790-
791-    throw error;
792-  }
793-
794-  try {
795-    const parsed = JSON.parse(lockContents) as Partial<OwnerTransferLockRecord>;
796-    const pid = parsed.holderProcessInstanceId ? parsePid(parsed.holderProcessInstanceId) : null;
797-
798-    if (pid !== null && isProcessActive(pid)) {
799-      return false;
800-    }
801-  } catch {
802-    const hasStagedArtifacts =
EXIT=0
```

### 论据是否腐坏

| 原文论据句 | 今天是否成立 | 备注 |
|---|---|---|
| `releaseOwnerLease` 在 `:769` | **腐坏（行号）** | 今天 `:1171`。符号在，行号已腐。 |
| `updateOwnerRecordWithPrecondition` 在 `:720` | **腐坏（行号）** | 今天 `:1122` |
| 那次持锁恢复在 `:729` | **腐坏（行号）** | 今天 `:1131` |
| 「**不在任何 catch 内**」 | **成立** | :1130 的 `try` 只配 `finally` |
| 「本层给这次恢复加了第三个参与文件」 | **成立** | pre-L3 两个文件，今天三个 |
| 「一次 marker 的 `readFile` ＋ `JSON.parse`」 | **成立** | pre-L3 无，今天 :937 |
| 「**规则 2 / 3 两条**新的具名抛出」 | **数目偏低（论据腐坏，方向是低估）** | 今天是**三条**：:940、:949、:993。第三条 `OwnerTransferMarkerFinalizeOrderInvalidError` 是 `b7bf227`（2026-08-02，L3 期内）加的，代码注释自称 "Fail-closed, same as rules 2/3"。**结论（本层扩大了失败面）不受影响，只是扩大得比原文写的多一条。** |
| 「**规则 2 已被第四轮证明可达**」 | **成立** | §4.4「⚠️ 规则 2 可达」（:932 起）在文档内；其路径今天在代码上逐环可走（见上面构造） |
| 「这一类不是『先于本层』，是本层扩大的」 | **成立** | pre-L3 对照已证 |
| 第 (i) 类「CAS 失配不构成违反」 | **成立** | `updateOwnerRecordWithPrecondition` :1134-:1136 抛 `OwnerTransferPreconditionError`，`stop()` 吞掉；此时记录已属他人 |
| 第 (ii) 类「锁忙 / I/O 失败，先于本层存在」 | **成立** | `acquireOwnerTransferLock` 与 `readOwnerRecordRaw` 均先于 L3；`stop()` 的 `try{}catch{}` 亦是 pre-L3 代码 |

### 后果分级

**可重试拒绝**（不是数据丢失）。据以分级的证据：抛出发生在 `writeOwnerRecordAtomically` **之前**（:1138-:1139 在 :1131 之后），所以盘上的 owner record **没有被改坏**；损失是 `leaseAffirmedAt` 未被置 `null`，下一次 legitimate resume 要等一个 TTL。`readOwnerRecordRaw` 在 :1132、CAS 在 :1134，都排在抛出点之后 —— **零写**。且 §4.4 实测这条路径是**一次性**的（P2 已把事务推完，下一次读就正常），不永久钉死。

### 归属是否需要重裁

原文**没有**对这一笔单独写「需要重裁归属」。它明写「不单开一笔——它是本笔的前提条件」，即随 A-1 一起走 A-1 那次归属裁决。**但第 (iii) 类被明标为「本层扩大出来的」，与 A-1 主体的「本轮新发现」不同源 —— L5 排优先级时这两个属性不可互换。**

### 我不确定的地方

- 我没有实测跑出第 (iii) 类的那条跨进程竞态（需要两个真实进程 ＋ 精确的 SIGKILL 时点）。上面的构造是逐环读代码走出来的，不是观测到的。
- 我没有核 §11「⚠️ 但『本层一个字节不改 `stop()`』不等于……」那一节的**全部**论证（只核了它被 §13 引用的那几句）。**本项这一小块未完成，缺：§11 该节剩余论证与 §15 验收 4 措辞的逐句核对。**

## 项 B-1：输家 reconciliation 写的残余 TOCTOU（两条时序）

### 原文出处

§13 第 4 笔（今天在 :2422-:2427）。逐字：

> 4. **输家 reconciliation 写的残余 TOCTOU（第三轮新增，接替第二轮那笔被收回的 pending 非原子写；第四轮扩写为*两条*时序）。** `preserveSuccessfulReconciliationIfNeeded` 的「读 → 判定 → 写」既不原子也不持锁，**而且那次「读」本身是一个跨两个文件的 `Promise.all`，不是快照**（§4.0a 已就地写明）。两条已查实的时序：
>
>    - **时序一**：输家的读早于赢家发布任何东西（`readOwnerTransferRecordRaw` ENOENT → 裸 `catch { return null }` → 保护整个不生效），写晚于赢家的 reconciliation rename。
>    - **时序二（第四轮新增）**：输家的两次读**跨在赢家的 rename#1 与 rename#2 之间** —— 读到 transfer(N+1) ＋ owner-record(仍是 N)，`transferRepresentsPublishedWinner` 的判据 B（`currentOwnerEpoch === newOwnerEpoch`）不成立 → 保护同样退化。**这一条不需要 ENOENT，也不需要任何「多次 rename 落进同一个间隙」的巧合**：两次读之间隔着 `readOwnerRecord` 的 `recoverInterruptedOwnerTransfer` 前缀（数次 `pathExists` ＋ 可能一次 `readFile`），而赢家在两次 rename 之间隔着一整个 `writeJsonFile`。**第三轮的 §4.3 声称这条不可达，那句话已在本轮撤回。**

（末句是原文自陈的一处**已发生的自我证伪**：第三轮判不可达，第四轮撤回。）

### 今天的落点

全部在 `src/persistence/fileStore.ts`：

- `preserveSuccessfulReconciliationIfNeeded`（今天在 :392）
- `readPersistedSuccessfulTransferArtifacts`（今天在 :351）—— 承载那两次读
- `readOwnerTransferRecordRaw`（今天在 :664）
- `readPersistedReconciliationRecord`（今天在 :314）
- `transferRepresentsPublishedWinner`（今天在 :163）
- `shouldProtectSuccessfulTransferTruth`（今天在 :198）
- 输家实际那次写：`writeBoundaryArtifacts` 里的 `writeJsonFileAtomically(join(runDir, "reconciliation-record.json"), decision.record)`（今天在 :494）
- 赢家的三次 rename：`finalizePendingOwnerTransfer` 的发布循环（今天在 :984-:988），顺序由 `marker.finalizeOrder` 驱动

### 重推命令与当时输出

`transferRepresentsPublishedWinner` 今天的函数体（`sed -n '140,440p' src/persistence/fileStore.ts` 逐字节选）：

```
function transferRepresentsPublishedWinner(
  ownerRecord: OwnerRecord,
  ownerTransferRecord: OwnerTransferRecord,
): boolean {
  return (
    ownerTransferRecord.eligibleForContinuation === true
    && ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch
    && ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId
  );
}
```

**「L3 期间一个字节不动（保留即放宽）」的核实：**

```
$ git log --oneline -L :transferRepresentsPublishedWinner:src/persistence/fileStore.ts
97ed9aa fix: keep task 4 reconciliation truth coherent
[…diff hunk 略，下同：本条只用它的提交列表…]
d0eeb1a fix: preserve transfer-backed reconciliation truth
815c7f6 fix: preserve winner reconciliation outcome
```

```
$ git log -1 --format='%h %ad %s' --date=short 97ed9aa
97ed9aa 2026-07-23 fix: keep task 4 reconciliation truth coherent
```

```
$ git log --oneline --reverse --format='%h %ad %s' --date=short -- docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md | head -5
0289846 2026-08-01 docs(spec): L3 — sweep trigger layer plus transactional continuation
ba4dfbc 2026-08-01 docs(spec): rewrite L3 after three independent reviews found sixteen defects
08bf685 2026-08-01 docs(spec): second fix wave on L3 after three more independent reviews
bca349a 2026-08-01 docs(spec): third fix wave on L3 after round-three review
e8398e0 2026-08-01 docs(spec): fourth fix wave on L3 after round-four review
```

**核实结论：`git log -L` 实测最新一次触到该函数区间的提交是 `97ed9aa`（2026-07-23），早于 L3 spec 的首个提交 `0289846`（2026-08-01）。L3 期间该函数体确实一个字节没动。原文这一条今天成立。**

那两次读今天的形状（`readPersistedSuccessfulTransferArtifacts`，逐字）：

```
  try {
    ownerTransferRecord = await readOwnerTransferRecordRaw(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // This return also skips the owner-record read below, and with it that read's
      // recoverInterruptedOwnerTransfer side effect. Deliberate, and not a behavior loss: when the
      // three reads shared one Promise.all, the array was evaluated eagerly, so this file's
      // readFile was issued before recovery reached any rename — the observation was pre-recovery
      // either way — and a rejecting Promise.all left that recovery dangling and unawaited. An
      // interrupted transfer's marker and pendings are reclaimed by every path that actually
      // claims or transfers ownership; a protective read is not one of them and must not write.
      return { kind: "no_published_transfer" };
    }

    return { kind: "unreadable", error };
  }

  // readPersistedReconciliationRecord carries its own `catch { return undefined }` and never
  // throws, so anything this catch sees came from the owner-record read.
  try {
    const [ownerRecord, reconciliationRecord] = await Promise.all([
      readOwnerRecord(runDir),
      readPersistedReconciliationRecord(runDir),
    ]);

    return { kind: "artifacts", ownerRecord, ownerTransferRecord, reconciliationRecord };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}
```

`preserveSuccessfulReconciliationIfNeeded` 今天的形状（逐字）：

```
async function preserveSuccessfulReconciliationIfNeeded(
  runDir: string,
  nextReconciliationRecord: ReconciliationRecord,
): Promise<ReconciliationWriteDecision> {
  if (nextReconciliationRecord.eligibleForContinuation) {
    return { kind: "write", record: nextReconciliationRecord };
  }

  const persistedArtifacts = await readPersistedSuccessfulTransferArtifacts(runDir);

  if (persistedArtifacts.kind === "no_published_transfer") {
    // Deliberately permissive, and this square must stay: every stale_candidate run reaches here
    // with a reconciliation record whether or not ownership ever changed hands, so failing closed
    // on a merely-absent owner-transfer.json would stop most runs from ever writing
    // reconciliation-record.json. That deletes a product of the normal path; it does not add a
    // refusal. The residual TOCTOU behind this observation is named and carried onward (§13).
    return { kind: "write", record: nextReconciliationRecord };
  }

  if (persistedArtifacts.kind === "unreadable") {
    return { kind: "abandon", error: persistedArtifacts.error };
  }
```

`readOwnerTransferRecordRaw` 今天的形状（`sed -n '660,680p'` 逐字节选）：

```
async function readOwnerTransferRecordRaw(runDir: string): Promise<OwnerTransferRecord> {
  return JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_FILE), "utf8")) as OwnerTransferRecord;
}
```

赢家的发布循环与 finalizeOrder（`sed -n '880,1006p'` 与 `sed -n '1000,1200p'` 逐字节选）：

```
    const marker: OwnerTransferTransactionMarker =
      reconciliationRecord === undefined
        ? {
            version: 1,
            stagedAt: transferRecord.transferredAt,
            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE],
          }
        : {
            version: 2,
            stagedAt: transferRecord.transferredAt,
            finalizeOrder: [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE, RECONCILIATION_RECORD_FILE],
          };
```

```
  try {
    for (const entry of staged) {
      await safeUnlink(entry.tempPath);
      await writeJsonFile(entry.tempPath, entry.value);
      await rename(entry.tempPath, entry.targetPath);
    }
```

**核实：rename#1 = `owner-transfer.json`，rename#2 = `owner-record.json`，rename#3 = `reconciliation-record.json`。两次 rename 之间确实隔着一整个 `safeUnlink` ＋ `writeJsonFile`。原文这一句今天成立。**

### 今天是否可达

**两条都可达。**

**时序一 —— 可达。** 构造：
1. run 从未发生过所有权转移，盘上没有 `owner-transfer.json`。
2. 输家进 `writeBoundaryArtifacts` → `preserveSuccessfulReconciliationIfNeeded`，`nextReconciliationRecord.eligibleForContinuation` 为 false（降级版本）→ 进 `readPersistedSuccessfulTransferArtifacts`。
3. `readOwnerTransferRecordRaw` → ENOENT → **`return { kind: "no_published_transfer" }`** → 回到 `preserveSuccessfulReconciliationIfNeeded` 的 `no_published_transfer` 分支 → **`return { kind: "write", record: nextReconciliationRecord }`**，`preserveSuccessfulReconciliationIfNeededFromArtifacts` 与 `transferRepresentsPublishedWinner` **一次都没被调用** → 保护整个不生效。
4. 赢家随后跑完事务，rename#1/#2/#3 全部落盘，`reconciliation-record.json` 是赢家真品。
5. 输家在 :494 `writeJsonFileAtomically` 写下降级版本 → **永久覆盖赢家真品**。

**时序二 —— 可达，且不需要 ENOENT。** 构造：
1. 赢家在 `finalizePendingOwnerTransfer` 的发布循环里跑完 rename#1（`owner-transfer.json` 已是 N→N+1 的转移记录），尚未跑到 rename#2。此刻它正在 `safeUnlink(ownerTempPath)` ＋ `writeJsonFile(ownerTempPath, …)` 中间。
2. 输家的读#1 `readOwnerTransferRecordRaw` 读到 **transfer(newOwnerEpoch = N+1)**。
3. 输家的读#2 `readOwnerRecord` → 先跑 `recoverInterruptedOwnerTransfer`（**不**持锁）：:1010 `pathExists(marker)` 为真（赢家还没删 marker）→ :1017 `pathExists(lockPath)` 为真（赢家持锁中）→ `tryRecoverStaleOwnerTransferLock` 读到合法锁内容、pid 活 → :798-:800 **`return false`** → :1017 整个合取为真 → **`return`（恢复空操作）** → 再 `readOwnerRecordRaw` 读到 **owner-record(currentOwnerEpoch 仍是 N)**。
4. `transferRepresentsPublishedWinner`：判据 B `ownerRecord.currentOwnerEpoch (N) === ownerTransferRecord.newOwnerEpoch (N+1)` → **false** → `shouldProtectSuccessfulTransferTruth` 的第一个合取项为 false → `preserveSuccessfulReconciliationIfNeededFromArtifacts` 直接 `return nextReconciliationRecord` → 保护退化。
5. 赢家跑完 rename#2、rename#3。输家在 :494 写下降级版本 → **永久覆盖赢家真品**。

**⚠️ 关于「窗口宽度」我给一条原文没写的观察（不改判、不量化）**：L3 期内的 `47eb148`（2026-08-02，"feat(fileStore): fail closed on unreadable transfer artifacts"）把三次读从**一个 `Promise.all`** 改成 **「读#1 单独 `await` 完 → 再 `Promise.all` 读#2/#3」**。改动前三个 `readFile` 是同一 tick 内**急切发出**的；改动后读#1 必须**完全 settle** 才开始读#2。这在方向上**放大**了时序二依赖的那个间隙。代码自己的注释也承认旧形状是"the three reads shared one Promise.all, the array was evaluated eagerly"。**原文 §13 没有记这一点。我不量化幅度**（原文明写「收窄幅度本 spec 不再量化」，前两次量化各被下一轮证伪，我不去当第三个）。

### 论据是否腐坏

| 原文论据句 | 今天是否成立 | 备注 |
|---|---|---|
| 「`preserveSuccessfulReconciliationIfNeeded` 的『读 → 判定 → 写』既不原子也不持锁」 | **成立** | 读在 :351、判定在 :234、写在 :494，全程无 `acquireOwnerTransferLock` |
| 「那次『读』本身是一个跨两个文件的 `Promise.all`，不是快照」 | **半腐坏（结论成立，描述已过期）** | 今天的 `Promise.all` 确实跨两个文件（owner-record ＋ reconciliation-record），**但整次读跨的是三个文件、分两段**：读#1 `readOwnerTransferRecordRaw` 已被 `47eb148` 移出 `Promise.all` 单独 `await`。「不是快照」这个**结论更成立了**；「一个跨两文件的 Promise.all」这个**描述**不再刻画整次读 |
| 时序一：「`readOwnerTransferRecordRaw` ENOENT → **裸 `catch { return null }`**」 | **⚠️ 论据腐坏（结论不腐）** | 今天**没有**裸 `catch { return null }`。`47eb148` 换成了三态联合 `PersistedTransferArtifactsRead`：ENOENT → `{ kind: "no_published_transfer" }`，非 ENOENT → `{ kind: "unreadable" }`（新增 fail-closed）。**时序一的结论完全不受影响**——ENOENT 仍然走到一个无保护的 `{ kind: "write" }`。但原文那半句描述的是 `47eb148` 之前的代码 |
| 时序一：「保护整个不生效」 | **成立** | ENOENT 分支上 `transferRepresentsPublishedWinner` 一次都没被调用 |
| 时序二：「读到 transfer(N+1) ＋ owner-record(仍是 N)」 | **成立** | finalizeOrder 实测 transfer 在前、owner 在后 |
| 时序二：「判据 B（`currentOwnerEpoch === newOwnerEpoch`）不成立」 | **成立** | 函数体逐字核过，判据 B 在第二个合取项 |
| 时序二：「两次读之间隔着 `readOwnerRecord` 的 `recoverInterruptedOwnerTransfer` 前缀（数次 `pathExists` ＋ 可能一次 `readFile`）」 | **成立，且今天更宽** | :1010 与 :1017 两次 `pathExists`，`tryRecoverStaleOwnerTransferLock` 一次 `readFile`。**外加 `47eb148` 让读#1 完全 settle 后才开始读#2**（原文未记） |
| 时序二：「赢家在两次 rename 之间隔着一整个 `writeJsonFile`」 | **成立** | 发布循环 :984-:988：`safeUnlink` ＋ `writeJsonFile` ＋ `rename` |
| 「`transferRepresentsPublishedWinner` 在 L3 期间一个字节不动」 | **成立** | `git log -L` 实测最后触碰是 2026-07-23 的 `97ed9aa` |
| 「这是先于本层的缺陷（今天赢家也在事务后经 `writeBoundaryArtifacts` 写 reconciliation，可被同样覆盖）」 | **成立** | :494 是唯一的输家/无转移写入点；赢家 nextOwnerEpoch 非 null 时走 :903 那条不带 reconciliationRecord 的分支，其真品由事务 rename#3 发布 |

### 后果分级

**数据丢失。** 据以分级的证据：终点是 :494 的 `writeJsonFileAtomically(join(runDir, "reconciliation-record.json"), decision.record)` —— 一次 temp+rename 的**完整覆盖**，赢家已发布的 `eligibleForContinuation: true` 真品被输家的降级版本取代，**盘上没有第二份副本**，且原文明写「`finalizeOrder` 排哪个方向都拦不住」。降级后的记录会让后续 resume 读到「不合格续跑」这个假事实。

**有一个部分缓解，必须同时记下**：L3 加了 `describePublishedWinnerReplacement`（:284）＋ `reconciliation_published_winner_replaced` 事件（:499-:507）。**但它盖不住这两条时序**：
- 时序一走 `no_published_transfer` 分支，**在 `describePublishedWinnerReplacement` 被调用之前就 return 了** → 无事件。
- 时序二同样无事件，逐字核见下。

**后果分级 —— 补核（两条时序都是*静默*数据丢失）**

补跑的命令与输出：

```
$ grep -nF -A12 'function isSuccessfulReconciliationForTransfer(' src/persistence/fileStore.ts; echo "EXIT=$?"
115:function isSuccessfulReconciliationForTransfer(
116-  reconciliationRecord: ReconciliationRecord,
117-  ownerTransferRecord: OwnerTransferRecord,
118-): boolean {
119-  return (
120-    reconciliationRecord.eligibleForContinuation
121-    && reconciliationRecord.ownershipVerdict === "OWNER_LOST"
122-    && reconciliationRecord.priorOwnerEpoch === ownerTransferRecord.priorOwnerEpoch
123-    && reconciliationRecord.newOwnerEpoch === ownerTransferRecord.newOwnerEpoch
124-  );
125-}
126-
127-function isLoserDowngradeAttempt(
EXIT=0
```

推导（`shouldPreserveExistingReconciliationRecord` 的第一个合取项是 `persistedReconciliationRecord !== undefined`，:186）：

- **时序一**：走 `no_published_transfer` 分支，在 `describePublishedWinnerReplacement` 被调用**之前**就 `return` 了 → **无事件**。
- **时序二**：赢家此刻还没跑 rename#3，所以盘上的 `reconciliation-record.json` 要么**不存在**（`readPersistedReconciliationRecord` → `undefined` → `shouldPreserveExistingReconciliationRecord` 第一个合取项即 false），要么是**上一次转移**留下的旧记录（`isSuccessfulReconciliationForTransfer` 的 `priorOwnerEpoch === ownerTransferRecord.priorOwnerEpoch` 对不上当前 N→N+1 → false）。两种情况 `shouldPreserveExistingReconciliationRecord` 都为 false → `describePublishedWinnerReplacement` 的第二个析取项 `!false` = true → **`return undefined` → 无事件**。

**结论：两条时序都是「数据丢失且静默」。L3 新加的 `reconciliation_published_winner_replaced` 事件一条都盖不住它们。** 这一点原文 §13 第 4 笔没有写。

## 项 B-2：附带交接 —— `readPersistedReconciliationRecord` 的 `catch { return undefined }`

原文明写**不单开一笔**：「不单开一笔——它是本笔的前提条件，不是独立缺陷」。

### 原文出处

§13 第 4 笔的「本笔附带交接的一件事」（今天在 :2431）。逐字：

> - **`readPersistedReconciliationRecord` 的 `catch { return undefined }`**：本层的处置一把「它自带 catch、从不抛」当成承重前提（「健康路径上唯一的 null 来源是 owner-transfer ENOENT」）。**本层不收窄它**，依据三条见 §4.3（L1 §12 第 7 条的范围不含该文件 / 该文件由 temp+rename 发布故截断态不可达 / 即便可达 `undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation` 合成赢家视图）。**第三轮给的「先于本层 ⇒ 不在范围」那条理由已撤回**——同一波的人裁刚好推翻了这条判据（三份 pending 也先于本层，照样被收回自修）。

§19 的 M9 行（今天在 :2892）记了这次撤回的原委，逐字节选：

> | M9 | Minor | 第三轮用「先于本层 ⇒ 不在范围」驳回 `readPersistedReconciliationRecord` 的 `catch { return undefined }`。**结论成立但理由不成立**——同一波的人裁刚好推翻了这条判据（三份 pending 也先于本层，照样被收回自修）

### 今天的落点

- `readPersistedReconciliationRecord` in `src/persistence/fileStore.ts`（今天在 :314）
- 承重前提的书面依赖：`readPersistedSuccessfulTransferArtifacts` 的第二个 `try` 上方注释（今天在 :378-:379）
- `shouldSynthesizeSuccessfulReconciliation`（今天在 :174）
- 发布该文件的写：`writeJsonFileAtomically`（`writeBoundaryArtifacts` :494）与事务的 rename#3

### 重推命令与当时输出

`catch` 今天还在（`sed -n '140,440p' src/persistence/fileStore.ts` 逐字节选）：

```
async function readPersistedReconciliationRecord(runDir: string): Promise<ReconciliationRecord | undefined> {
  try {
    return JSON.parse(
      await readFile(join(runDir, "reconciliation-record.json"), "utf8"),
    ) as ReconciliationRecord;
  } catch {
    return undefined;
  }
}
```

承重前提今天被**写进注释、且确实在承重**（同一次 `sed` 的逐字节选）：

```
  // readPersistedReconciliationRecord carries its own `catch { return undefined }` and never
  // throws, so anything this catch sees came from the owner-record read.
  try {
    const [ownerRecord, reconciliationRecord] = await Promise.all([
      readOwnerRecord(runDir),
      readPersistedReconciliationRecord(runDir),
    ]);
```

`git log -L` 实测该函数的改动史：

```
$ git log --format='%h %ad %s' --date=short -L :readPersistedReconciliationRecord:src/persistence/fileStore.ts
47eb148 2026-08-02 feat(fileStore): fail closed on unreadable transfer artifa…
97ed9aa 2026-07-23 fix: keep task 4 reconciliation truth coherent
d0eeb1a 2026-07-23 fix: preserve transfer-backed reconciliation truth
```

### 今天是否可达 / 承重前提今天是否成立

- **`catch { return undefined }` 今天还在** —— 是，逐字核过。
- **承重前提「它自带 catch、从不抛」今天成立** —— 是。函数体内唯一可能抛的是 `readFile` 与 `JSON.parse`，两者都在 `try` 内，`catch` 无条件 `return undefined`。
- **⚠️ 但这个前提今天承重得比原文写的更重**：`47eb148` 之后，`readPersistedSuccessfulTransferArtifacts` 的第二个 `catch` 被明确窄化为「anything this catch sees came from the owner-record read」，并据此把非 ENOENT 的读失败路由到 `{ kind: "unreadable" }` → `abandon`。**也就是说：如果哪天有人让 `readPersistedReconciliationRecord` 抛，一次 reconciliation 文件的读失败会被误判成 owner-record 读失败，进而把一次本该写入的 reconciliation 变成 `abandon`。** 这条误判链是 L3 新建的，原文 §13 只写了「本层的处置一把它当成承重前提」，没有写出误判后的具体后果形状。
- **原文给的第二条依据「该文件由 temp+rename 发布故截断态不可达」今天成立**：`writeBoundaryArtifacts` :494 走 `writeJsonFileAtomically`，事务路径走 rename#3，两条发布路径都不是裸写。
- **原文给的第三条依据「即便可达 `undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation` 合成赢家视图」—— 有条件成立，不是无条件**。`shouldSynthesizeSuccessfulReconciliation`（:174）要求 `persistedReconciliationRecord === undefined` **且** `isLoserDowngradeAttempt(...)`；而 `shouldProtectSuccessfulTransferTruth`（:198）在它**外面**还压着一个 `transferRepresentsPublishedWinner(...)` 合取项。**在本报告 B-1 的时序二里那个合取项恰恰为 false**，此时 `undefined` 并不会命中合成，而是直接落到「输家降级版本原样写下去」。**我不改判原文，原样上报：这条依据在 `transferRepresentsPublishedWinner` 为真时成立，在时序二那种它为假的窗口里不成立。**

代码自己也在两处注释里承认 `catch { return undefined }` 会把**损坏**映射成 `undefined`（逐字节选）：

```
// a CORRUPT one, where readPersistedReconciliationRecord's `catch { return undefined }` routes the
// corruption into the synthesis arm
```

```
// readPersistedReconciliationRecord's `catch { return undefined }` maps a CORRUPT
// reconciliation-record.json to undefined as well, so on that square a corrupt file is still
// overwritten with no event — the same silence this signal exists to remove, one square over. It
// is carried as a named gap in progress.md rather than fixed here; widening the signal to cover
// absent-vs-corrupt is a different change with a different justification.
```

### 论据是否腐坏

| 原文论据句 | 今天是否成立 |
|---|---|
| 「`catch { return undefined }`」还在 | **成立** |
| 「它自带 catch、从不抛」 | **成立** |
| 「本层的处置一把它当成承重前提」 | **成立，且承重面比原文所写更宽**（见上） |
| 依据 (a) L1 §12 第 7 条范围不含该文件 | **未核**（见「我不确定的地方」） |
| 依据 (b) temp+rename 发布，截断态不可达 | **成立** |
| 依据 (c) `undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation` 合成赢家视图 | **有条件成立**，被 `transferRepresentsPublishedWinner` 门控；时序二下不成立 |
| 「第三轮给的『先于本层 ⇒ 不在范围』那条理由**已撤回**」 | **成立**（文档内，§19 M9 行逐字确认） |

### 后果分级

**仅可操作性（今天）**，但它是 B-1 那笔数据丢失的**前提条件**，不是独立缺陷 —— 原文的归类今天仍然对。据以分级的证据：今天没有任何生产路径能让这个 catch 吞掉真实错误（发布走原子写，截断态不可达）；它的危害全部是「将来有人改动时前提会静默失效」。

### 归属是否需要重裁

原文**没有**写需要重裁。它明写「不单开一笔——它是本笔的前提条件」，随 B-1 走。

### 我不确定的地方

- **未核**：原文依据 (a)「L1 §12 第 7 条的范围不含该文件」。我没有打开 L1 spec 的 §12 第 7 条读原文。**本项这一小块未完成，缺：`2026-07-26-run-lease-and-heartbeat-design.md` §12 第 7 条的逐字引用与范围核对。**
- 我没有核 `progress.md` 里那条「named gap」（代码注释提到它）与 §13 的关系。

### 归属是否需要重裁

原文**没有**对第 4 笔写「需要重裁归属」。它明写「**这是先于本层的缺陷**」。**与 A-1 相反 —— A-1 明写需要重裁，B-1 明写先于本层。L5 不要把两笔的归属属性混起来。**

### 我不确定的地方

- （原留的这条不确定已在本次扫描内核完，结论并入上面的「后果分级 —— 补核」。）
- 我没有把两条时序写成可运行的测试场景，也没有跑 `tests/` 里已有的相关用例（`tests/persistence/fileStore.test.ts`、`tests/controller/runLoop.integration.test.ts`、`tests/sweep/sweepRuns.test.ts` 实测含相关字符串，但我没读它们）。

## 我发现的、原文没写的东西

按对 L5 的重要性排。**全部只上报，不自行改判。**

### 发现 1（最重）：§5.2 末句仍在用**已被 §13 撤回**的归类，且 G10 的修订处清单没列 §5.2

```
$ grep -nF '部分关闭' docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
1143:**因此一次并发 `stop()` 完全可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 改动 A 不覆盖这一段，本层也不覆盖它（覆盖它要么把 artifact 写搬进 span——L1b 刚刚明确否决过——要么另设一层守卫）。**§13 据此把债 3 记为「exclusive span 部分关闭」，span 外那段具名传给 L5。**
2358:- **归类错误的实际危害**：写成「债 3 部分关闭」会让 L5 以为自己继承的是一笔**已被裁决过归属**的债，从而不再重新裁决；而它其实是一条**从未被任何裁决记录处理过**的新发现，**归属应当重新裁**。
2812:| G10 | Important | §13 把债 3 归为「部分关闭」错了：裁决记录对债 3 要的是**显式表态**，本层已按可接受方式表了态，**按裁定它是关闭的**；而 span 外那段是**本轮新发现**，不该写成「债 3 的未关闭部分」（会让 L5 以为它已被裁过归属） | §13 表、§13「债 3 的归类更正」（引裁决记录 :189 全句）、§13 第 3 笔（措辞改为「本轮新发现，需重新裁归属」）、§14 第 1 条 |
```

**:1143 仍逐字写着「§13 据此把债 3 记为「exclusive span 部分关闭」」。** 而 :2358 明写这个写法的危害就是「会让 L5 以为自己继承的是一笔已被裁决过归属的债，从而不再重新裁决」。G10 那一行的「修订处」栏实测只列了 **§13 表、§13 归类更正、§13 第 3 笔、§14 第 1 条** —— **没有 §5.2**。

**对 L5 的直接影响**：一个从 §5.2 读进来的读者会得到与 §13 相反的归属结论。**这正是 §13 自己点名要防的那个失败模式，今天在同一份文档里仍然可复现。** 我不改文档，交人裁。

### 发现 2：§4.4 的「规则 3 仍然不可达」在今天的代码上被 §4.4 **自己那条 P2/P3 路径**证伪

§4.4 逐字：

> **⚠️ 连带：§15 验收 2 的例外清单第 3 条不再能说「三者全部不可达」**，已就地改。**规则 3（marker 不可解析）仍然不可达**——上面这条路径不产生坏 marker，只产生「marker 已被删」。

**但今天的代码把「marker 已被删」和「marker 不可解析」收进了同一个 catch**（A-2 已贴逐字输出，:936-:941）：

```
  try {
    marker = JSON.parse(await readFile(paths.transactionMarkerPath, "utf8")) as OwnerTransferTransactionMarker;
  } catch {
    // §4.4 rule 3: an unparseable marker is fail-closed — reject before anything is touched.
    throw new OwnerTransferMarkerUnreadableError("owner transfer transaction marker could not be read or parsed");
  }
```

`readFile` 的 **ENOENT 落进这个无条件 `catch`**，抛出的正是规则 3 的具名错误，错误消息自己写着 "could not be **read** or parsed"。**所以 §4.4 那条 P2/P3 路径（marker 被并发删掉）产生的是规则 3 的抛出，而 §4.4 只把它记在规则 2 名下、并同时断言规则 3 不可达。**

**这是「论据腐坏」而非「结论腐坏」**：§4.4 的上位结论（这条路径可达、后果是一次 stderr 告警、本层不修）不受影响；受影响的是「规则 3 仍然不可达」这一句，以及 §15 验收 2 例外清单第 3 条的措辞。**对 A-2 第 (iii) 类的影响是它的可达面比原文写的宽一条。** 我不改判，交人裁。

### 发现 3：具名 fail-closed 抛出今天是**三条**，不是原文写的两条

§13 第 3 笔写「规则 2 / 3 **两条**新的具名抛出」。今天实测三条：`OwnerTransferMarkerUnreadableError`(:940)、`OwnerTransferMarkerFinalizeOrderInvalidError`(:949)、`OwnerTransferPendingMissingError`(:993)。第三条由 `b7bf227`（2026-08-02，"fix(fileStore): reject a v2 marker whose finalizeOrder is …"，`git log -L :finalizePendingOwnerTransfer:` 实测是唯一触碰该区间的提交）在 L3 期内加入，代码注释自称 "Fail-closed, same as rules 2/3"。**方向是低估：本层扩大的失败面比原文记的多一条。**

### 发现 4：`47eb148` 在方向上**放大**了时序二依赖的间隙，§13 未记

详见 B-1「今天是否可达」末段。读#1 从「与另两读同 tick 急切发出」变成「完全 settle 后才开始读#2」。**我不量化幅度**（原文明写不再量化，前两次量化各被下一轮证伪）。

### 发现 5：两条时序都是**静默**数据丢失，L3 新加的告警事件一条都盖不住

详见 B-1「后果分级 —— 补核」。§13 第 4 笔没有写这一点。

### 发现 6（最轻）：`fileStore.ts:469` 的注释与 spec 已同步的事实不一致

```
$ grep -nF 'a single array push, no I/O' src/persistence/fileStore.ts src/controller/runLoop.ts docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
src/persistence/fileStore.ts:469:      // control (a single array push, no I/O), so a throw from it is a programming error and must
```

```
$ grep -nF 'array push' docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
（无输出，exit 1）
```

```
$ git show --stat b9afbf3
commit b9afbf3930c531e245c4555e10cf6e8d3219749d
    docs(spec): GATE-C residual — sync the second same-family sentence, the callback is an immediate stderr write, not an array push
 .../specs/2026-08-01-sweep-and-transactional-continuation-design.md   | 4 ++++
 1 file changed, 4 insertions(+)
```

回调实测确实是即时 stderr 写：

```
$ grep -n -B4 -A10 'onReconciliationWriteAbandoned' src/sweep/sweepRuns.ts
205:        onReconciliationWriteAbandoned: (detail) => {
206-          options.stderr(
207-            `note  ${candidate.path}  reconciliation_write_abandoned  ${detail.replace(/\r?\n/g, " ")}`,
208-          );
209-        },
```

**`b9afbf3` 只改了 spec（1 file changed），源码那条注释没跟着同步。** 属「仅文档」级，但它落在 B-1 的写入路径（`writeBoundaryArtifacts`）上，所以记在这里。

## 与其它扫描员的交叉校验

**扫描员 C 的输入**：复核 `resumeLoop` 那条并发裸读时确认，抛出点排在 CAS 与 heartbeat 之前、因而除两行 append 外零写。

**我的结论：不冲突。** 两点说明：

1. **路径不同。** C 核的是 `resumeLoop` 的并发裸读；我在 B-1 核的是 `writeBoundaryArtifacts` → `preserveSuccessfulReconciliationIfNeeded` 这条**输家保护**路径。两者不共享抛出点，我的时序一 / 时序二都不经过 `resumeLoop`。
2. **形状一致。** 我在 A-2 得到的是一个**结构同型**的结论：`updateOwnerRecordWithPrecondition` 里那次恢复的抛出点（:1131）排在 `readOwnerRecordRaw`（:1132）、CAS（:1134）与 `writeOwnerRecordAtomically`（:1139）**之前**，因而那条路径也是**零写**，损失只是租约没被释放。这与 C 报告的「抛出点在 CAS 之前 ⇒ 零写」是同一种排序性质，互相印证而非冲突。

**我没有独立验证 C 关于 `resumeLoop` 的那条结论**（不在我的切片内，我没有读 `resumeLoop` 的裸读段）。上面第 1 条只是说明它与我的结论不相交，不是对它的背书。
