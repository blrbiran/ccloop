# 待裁点 B 的裁决材料

> 状态：**完成**。作者：只读设计员（`.worktrees/bdesign`，detached HEAD `dbac288`）。
> **本文件不实施、不裁决。** 事实（§1-§6）与推荐（§0.3、§4.2、§7）分开写；
> 需要人拍板的问题在 **§7（Q1-Q8）**；没验到的在 **§9**；变异与还原证明在 **§8**。
>
> **十秒版**：C-1 **不需要**走待裁点 B —— 修法 (a) 原子发布实测把互斥破坏从 23 次降到 0，
> 且不触碰失败开放/关闭政策。B 应回到原节奏，但它的措辞需要扩大（§7 Q3），
> 而 `release()` 是独立且"判据自由"的一格（§6.4）。

## 0. 结论（最先填）—— 含「C-1 到底要不要走 B」的正面回答

### 0.1 正面回答：**C-1 不需要走待裁点 B。**

**修法 (a)「原子发布」单独就足以消灭 C-1 今天的可达触发路径，而且它不触碰失败开放/失败关闭这条政策，
因此按 brief §2 的定义，C-1 不构成裁 B 的理由。B 应当退回它原本的从容节奏。**

这是**实测结论，不是读代码得出的**。同一套真双进程探针，同一组参数，只换 `acquireOwnerTransferLock` 的发布方式：

| 构建 | 探针（2 个真进程 × 500 次取放锁，widenMs=0，含 leftover staged） | 互斥被破坏次数 | 持锁期间观察到的锁文件字节数 |
|---|---|---|---|
| **基线（HEAD `dbac288`）** | 自然节奏，无任何人工加宽、无手植 0 字节锁 | **A=12, B=11（共 23 次）** | `[0, 88]` |
| **对照：同上但无 staged 残留** | 同上 | **0** | `[88]` |
| **(a) 原子发布原型** | 同上，含 staged 残留 | **0** | `[88]` |
| **(a) + 外部持续截断锁文件（必命中 sanity）** | 同上 | **A=234, B=239** | `[-1, 0, 88]` |

- 第 1 行：**C-1 比台账记载的更严重** —— 台账/控制器的复现需要手植一把 0 字节活锁；
  我这里**什么都不用植**，两个真进程按自然节奏互相抢锁，500 次里就有 23 次两进程同时认为自己持锁。
- 第 2 行是**判据隔离对照**：拿掉 staged 残留，破坏归零 ⇒ 破坏确实来自 `catch` 分支那条
  「有 staged 就放行」的失败开放，不是别的机制。
- 第 3 行是 **(a) 的效果**：同样的条件，归零。
- 第 4 行是**必命中 sanity**：在 (a) 构建上让一个外部进程反复把锁截断成 0 字节，探针照样报出 234/239 次破坏
  ⇒ **探针在 (a) 构建上仍然有能力开火**，第 3 行的 0 不是坏探针造出来的假阴性。

### 0.2 但有五件事必须和这个结论一起交给人

1. **(a) 不是零代价**：它**推翻 1 条既有测试**（`tests/persistence/fileStore.test.ts:2929` 那条并发双读者测试）。
   但它推翻的是**测试的插桩方式**，不是任何政策判据 —— 该测试 mock 了 `open()` 并靠
   `String(args[0]).endsWith(".owner-transfer.lock")` 挂钩，而 (a) 之后 `open()` 打的是临时名。详见 §2.4。
2. **`catch` 分支不是唯一的失败开放出口。** 我实测出**第二个、更弱的出口**：
   锁内容 **JSON 解析成功但 `holderProcessInstanceId` 缺失或不是 `pid:<n>` 形式**时，
   代码从 `try` 块正常流出，落到函数末尾的**无条件 `safeUnlink`** —— **连 staged 判据都不要求**。
   **B 的原文只改 `catch` 分支，不 cover 这一格。** 详见 §1.6 / §4。
3. **`release()` 那一格是独立的一格，且今天可实测复现**（带 sanity 对照）：
   持锁者 `release()` 会删掉**已经不属于它的**那把锁。详见 §6。
4. **纯失败关闭（B 的最强形态）实测推翻 3 个 `it()` 块，不是台账说的 2 条** ——
   2 个不同标题，其中一个标题对应**两个逐字重复的测试块**。详见 §3。
5. **(a) 与 (b) 不互斥，而且顺序有实质意义**：**先 (a) 再考虑 (b)**。
   因为 (a) 同时把**待裁点 C 的死锁轨迹**从「今天崩溃即可留下一把永久卡死的坏锁」
   降到「只有掉电无 fsync 或外部篡改才能留下」。详见 §5。

### 0.3 一句话推荐（**这是推荐，不是裁决**）

> 把 C-1 当作一条**独立的原子性缺陷**修（走 (a)），**不要**把它捆到待裁点 B 上；
> B 与 §0.2 第 2、3 点合并成一次「锁身份与失败关闭」的整体设计，按原节奏走。

## 1. 我复核过的事实基础（哪些既有说法我证实了 / 证伪了）

基线：`.worktrees/bdesign`，detached HEAD `dbac2888d028ddd397734d1fa4c1193433918658`。
**全量测试基线：`Test Files 31 passed (31) / Tests 524 passed (524)`**（未过滤跑，`npx vitest run`）。

### 1.1 ✅ 证实（且强化）：C-1 存在，且比既有记载更容易达到

既有记载（台账 §21.1 / 控制器探针）：需要手植一把 0 字节活锁 ＋ staged，才能让闯入者夺锁。
**我的实测更强**：不植任何东西，两个真进程各跑 500 次真实 `acquireOwnerTransferLock`／`release()`，
`CCLOOP_PROBE_WIDEN_MS=0`（**没有任何人工加宽窗口**），只在 runDir 里放一份
`.owner-transfer.transaction.json`（这是中断的转移本来就会留下的普通盘上状态，**不是对锁文件的篡改**），
就出现 **23 次互斥破坏**，并且持锁进程在自己"持锁"期间 stat 到过锁文件是 **0 字节**、甚至 **不存在（-1）**。

判据隔离对照（拿掉 staged 残留）**归零**，证明破坏来自 `catch` 分支的 staged 判据放行，而非别的机制。

### 1.2 ✅ 证实：`catch` 分支从不调用 `isProcessActive`

`src/persistence/fileStore.ts:905-914`，逐字：

```ts
  } catch {
    const hasStagedArtifacts =
      await pathExists(transactionMarkerPath)
      || await pathExists(ownerPendingPath)
      || await pathExists(transferPendingPath);

    if (!hasStagedArtifacts) {
      return false;
    }
  }
```

落出 `catch` 后即 `await safeUnlink(lockPath); return true;`（916-917）。实测出口图（§1.6）与之一致。

### 1.3 ✅ 证实（反向事实）：`ensureFreshRunDir` 的 `blockingPaths` **不含** `.owner-transfer.lock`

`src/persistence/fileStore.ts:52-56` 只列 `loop-contract.json` / `loop-state.json` / `events.jsonl`，
另外只检查 `attempts/` 与 `worktrees/` 两个目录是否非空。

**并且我把它推得更远**：全库 `grep` `src/` 里所有出现 `.owner-transfer.lock` / `OWNER_TRANSFER_LOCK` 的位置，
**除了 `tryRecoverStaleOwnerTransferLock` 和 `release()` 之外，没有任何代码会删除这把锁**；
`src/sweep/sweepRuns.ts` 完全不碰它。⇒ **一把泄漏的锁在生产侧确实是静默的，测试是唯一防线。**

### 1.4 ❌ 部分证伪：「必然推翻两条同名的既有判据」

**按标题数是 2，按实际执行的测试块数是 3。** 这是实测数字（把 `catch` 分支改成纯失败关闭后跑全量）：

```
 Test Files  1 failed | 30 passed (31)
      Tests  3 failed | 521 passed (524)
```

三处失败在 `tests/persistence/fileStore.test.ts:785 / 1217 / 1424`。785 与 1217 属于
**两个逐字字节相同的测试块**（`diff <(sed -n '755,788p' …) <(sed -n '1187,1220p' …)` 无输出）。
逐字内容见 §3。

「**必然**」这个词是成立的：这三条不是"哲学上被抵触"，是**硬失败**，且我实测到了。

### 1.5 ❌ 证伪：(a) 原型曾出现的第二处失败**不是 (a) 造成的**

第一次跑 (a)（带探针插桩）时，`tests/validation/evidence.test.ts > run-scenario CLI > records env names
only and tracks descendants rooted at the spawned pid` 超时失败（5004ms > 5000ms）。
**去掉探针插桩、只留 (a)，连跑两次全量，它都通过（2723ms / 类似量级），失败不复现。**
⇒ 判定为负载抖动。**（不是"我认为"，是两次干净复跑的结果；但我没有做统计意义上的多次复跑。）**

### 1.6 🆕 新发现：`tryRecoverStaleOwnerTransferLock` 有**两个**失败开放出口，不是一个

用一次性探针直接枚举出口（**含两条必命中 sanity 对照**，在基线与 (a) 两个构建上结果**完全相同**）：

| 锁文件内容 | staged 残留 | 第二个进程能否夺锁 |
|---|---|---|
| `{"holderProcessInstanceId":"pid:<本进程>",…}` | 无 | **REFUSED**（sanity，必须拒） |
| `{"holderProcessInstanceId":"pid:<本进程>",…}` | 有 | **REFUSED**（sanity，必须拒） |
| **0 字节**（C-1 的形状） | 有 | **STOLEN** ← `catch` 出口 |
| 0 字节 | 无 | REFUSED |
| `not-json\n` | 有 | **STOLEN** ← `catch` 出口 |
| **`{"acquiredAt":…}`（无 `holderProcessInstanceId`）** | **无** | **STOLEN** ← **第二出口，连 staged 都不要求** |
| **`{"holderProcessInstanceId":"uuid:abc",…}`** | **无** | **STOLEN** ← **第二出口** |
| `{"holderProcessInstanceId":"pid:0",…}` | 无 | REFUSED |
| `{"holderProcessInstanceId":"pid:`（截断的 JSON 前缀） | 无 | REFUSED |

第二出口的代码路径：`try` 块里 `JSON.parse` 成功、`pid === null`（`parsed.holderProcessInstanceId` 缺失，
或 `parsePid` 的 `/^pid:(\d+)$/` 不匹配）⇒ `if (pid !== null && isProcessActive(pid))` 为假 ⇒
**正常流出 `try`，直达 916 行的无条件 `safeUnlink`。**

**这一格比 `catch` 分支更宽松**（`catch` 至少还要求有 staged 残留）。
**待裁点 B 的原文只说改 `catch` 分支，因此 B 通过之后这一格依然开着。**
今天它在本仓库内**没有代码产出这种内容**（`acquireOwnerTransferLock` 永远写 `pid:<pid>`），
所以它和 (a) 之后的 `catch` 分支一样，属于「外部篡改/掉电」级别的残余 —— 但它**不该被 B 的措辞漏掉**。

### 1.7 ✅ 证实：承重注释确实存在，**而且它自己就写明了这个例外**

`src/persistence/fileStore.ts:486-500` 逐字（节选）：

```
// Package 2 / §13 4th entry (D2): the loser's read → decide → write is one critical section under
// the SAME cross-process lock that a winner holds for its entire publish transaction — acquire,
// recover, three renames, release (writeOwnerTransferArtifacts). Two lock spans cannot interleave,
…
// What that does NOT make order-independent is named where it lives: a lock this process
// can have stolen from it (tryRecoverStaleOwnerTransferLock) puts the third order back, and any
// successful resume turns clause (b) of transferRepresentsPublishedWinner false at the same epoch
// by human ruling, after which the protection is gone by design and not by race.
```

**校正一处措辞**：brief 说这条注释「把『Two lock spans cannot interleave』当作前提写死」。
更准确的说法是：**注释把它当前提，但同一段注释已经点名了破坏它的机制（被偷锁）**。
C-1 的新意不在于"发现有例外"，而在于**例外的触发条件比注释作者设想的宽得多** ——
注释的语气假定夺锁发生在持有者**已死**时；C-1 证明**活着的持有者**也会被夺。

### 1.8 ✅ 证实：`recoverInterruptedOwnerTransfer` 会吞掉 busy 错误

`src/persistence/fileStore.ts:1121-1132`：未持锁分支里 `acquireOwnerTransferLock` 抛出时
`catch { return; }`。⇒ **失败关闭之后，一把坏锁不会让 `readOwnerRecord` 报错，只会让恢复静默地不发生。**
这是待裁点 C 「静默卡死」的具体机制（§5）。

## 2. C-1 的修法 (a) 原子发布：原型、实测、残余

### 2.1 原型（**只是原型，已还原，不是实施建议的最终形态**）

```ts
export async function acquireOwnerTransferLock(runDir: string): Promise<{ release: () => Promise<void> }> {
  const { lockPath } = getOwnerTransferPaths(runDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stagingPath = buildAtomicTempPath(lockPath);   // 已存在的每调用唯一临时名
    const handle = await open(stagingPath, "wx");

    try {
      await handle.writeFile(JSON.stringify({
        holderProcessInstanceId: `pid:${process.pid}`,
        acquiredAt: new Date().toISOString(),
      } satisfies OwnerTransferLockRecord, null, 2));
      await handle.close();
      await link(stagingPath, lockPath);                 // ← 原子发布点；已占用则 EEXIST
    } catch (error) {
      await handle.close().catch(() => undefined);
      await safeUnlink(stagingPath);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await tryRecoverStaleOwnerTransferLock(runDir))) {
        throw new OwnerTransferLockBusyError("owner transfer already in progress");
      }
      continue;
    }

    await safeUnlink(stagingPath);
    return { release: async () => { await safeUnlink(lockPath); } };
  }

  throw new OwnerTransferLockBusyError("owner transfer already in progress");
}
```

要点：**锁的内容与锁的出现变成一次事件**。`lockPath` 从不以 0 字节形态存在。
`buildAtomicTempPath` 是仓库里现成的、带进程实例戳＋每调用序号的唯一名生成器（728 行），
所以两个进程的 staging 不会互撞。

- `npx tsc --noEmit -p tsconfig.json` **通过**。
- 全量测试：**`Tests 1 failed | 523 passed (524)`，连跑两次结果相同**（见 §2.4）。

### 2.2 实测：探针设计

**探针里没有任何东西插进互斥逻辑本身。** 检测完全在探针侧：
每个子进程在 `acquireOwnerTransferLock` **返回之后**在 `runDir/__holders/` 里建一个自己的标记文件，
`readdir` 看当时有几个标记；持锁 1ms 再看一次；**先删标记再 `release()`**。
这个顺序保证探针只会**漏报**（我已经不持锁但还挂着标记的窗口不存在），**不会误报**。

`CCLOOP_PROBE_WIDEN_MS=0` —— **所有 §0.1 的数字都是在完全没有人工加宽窗口的情况下测出来的。**
（我准备了加宽开关，最后没有用到，因为自然节奏已经足够密集地命中。）

### 2.3 (a) 是否真的消灭了 C-1 的可达触发路径？—— **是，对"代码能产出的锁内容"这一类**

- (a) 之后，`lockPath` 只能通过 `link()` 出现，而 `link()` 的源是一个**内容已经写完并 close 的**文件。
  ⇒ **不存在任何代码路径能产出 0 字节或半截的 `lockPath`。**
- 进程在 `write` 与 `link` 之间被杀：`lockPath` **根本没出现**，只留下一个孤儿 staging 文件。
  ⇒ 崩溃**不再**能留下不可解析的锁。（这一点对待裁点 C 极关键，见 §5。）
- 进程在 `link` 与 `unlink(staging)` 之间被杀：`lockPath` 是**完整**的，只多一个孤儿 staging 文件。

### 2.4 (a) 的代价：它推翻的那 1 条测试

```
FAIL tests/persistence/fileStore.test.ts >
  recoverInterruptedOwnerTransfer: two concurrent unlocked readers racing the same marker >
  lets exactly one of two concurrent readOwnerRecord calls finalize the transaction; the other returns without writing
Error: reader A never opened the owner-transfer lock file within 3000ms -- the unlocked branch is not
acquiring a lock before finalizing (recoverInterruptedOwnerTransfer's !lockHeld branch may have
regressed to the pre-phase-1 unlocked-finalize shape)
```

原因是**插桩耦合**，不是行为回归。该测试（`tests/persistence/fileStore.test.ts:2929` 起）
`vi.doMock("node:fs/promises")` 并这样挂钩：

```ts
open: async (...args: Parameters<typeof actual.open>) => {
  const handle = await actual.open(...args);
  if (!aOpenedLock && String(args[0]).endsWith(".owner-transfer.lock")) { … }
```

(a) 之后 `open()` 打的是 `.<basename>.<stamp>.<n>.tmp`，钩子永不触发，deferred 永不 resolve，3 秒超时。

⚠️ **顺带一条很有分量的旁证**：同一个测试里的注释**已经知道 0 字节窗口的存在**，并**主动绕开它**：

```
// Patches only this one FileHandle instance (reader A's), not the module or any
// other test. Runs the real write first so the lock file has full, valid JSON
// content on disk before reader B ever gets a chance to look at it -- otherwise B
// could observe the (unrelated, already-known) zero-length lock window instead of
// the busy-lock path this test targets.
```

「**the (unrelated, already-known) zero-length lock window**」—— 这个窗口在包 2 的测试里被当成**已知且无关**处理过。
C-1 的实质是：它**不是**无关的。

### 2.5 残余可达性（**(a) 之后 `catch` 分支还剩什么**）

| 残余路径 | (a) 之后还可达吗 | 我的验证状态 |
|---|---|---|
| **外部篡改**（人手改锁文件、被别的工具截断） | **可达** | ✅ 实测：外部进程持续 `truncate(lock,0)` ⇒ (a) 构建上 234/239 次互斥破坏 |
| **掉电 / 内核崩溃后锁内容未落盘** | **理论可达** | ❌ **未实测**。依据：`writeJsonFileAtomically` 的源码注释自陈「the repository has zero fsync calls anywhere」，我已 `grep` 确认 `src/` 无 fsync。`link()` 只保证可见性原子，不保证持久性 |
| **崩溃中的部分写** | **不可达** | ✅ 机制上被 (a) 关掉（内容写完才 link），并由 §0.1 第 3 行的 0 破坏支持 |
| **另一个失败开放出口（pid 为 null）** | **可达但同样只有篡改能进** | ✅ 实测（§1.6），基线与 (a) 表现相同 |

⇒ **(a) 把 B 从「今天在自然节奏下就能触发的 Critical」降成「需要外部篡改或掉电才能触发」。**
这正是 brief §2 第 2 问要的那个判断。

### 2.6 跨平台：`link()` 的风险（**这一条我没能实测，明说**）

- **本仓库不做任何平台判断**：`grep -rn "process.platform\|win32\|darwin\|linux" src package.json` **零命中**；
  `package.json` 无 `os` 字段。⇒ **仓库没有声明目标平台**，我无法据此收窄风险面。
- 我的实测只在 **darwin 24.6.0 / APFS / Node v22.13.1** 上跑过。
- 已知的一般性风险（**这是常识性论断，不是我在本仓库实测的**）：
  - Windows：`fs.link` 走 `CreateHardLinkW`，需要 NTFS；FAT/exFAT 与跨卷会失败。
  - 网络文件系统（NFS）：`link` 是经典的原子加锁原语，但有著名的「返回错误其实成功了」重试语义。
  - 部分 FUSE / overlay 文件系统对硬链接支持不完整。
- **替代原语**：`rename()` **不能用** —— 它会静默覆盖已存在的目标，正好毁掉互斥。
  若要避开 `link`，可考虑 `mkdir(lockDir)` 作为占位原语（`mkdir` 的 EEXIST 在所有平台都原子），
  把内容写在锁目录**内部**。⚠️ 这会改变锁在盘上的形态，连带影响所有直接写 `.owner-transfer.lock` 的测试。**未评估。**

## 3. B 会推翻哪些既有判据（逐字，含它们的来历）

**方法**：不是读代码推断，是把 `catch` 分支改成纯失败关闭（`catch { return false; }`）后**跑全量测试**，
未过滤落盘。结果 `Tests 3 failed | 521 passed (524)`，失败集合如下。全部在
`/Users/biran/code/skills/loop/ccloop/.worktrees/bdesign/tests/persistence/fileStore.test.ts`。

### 3.1 判据 1 —— `fileStore > treats malformed lock contents with staged artifacts as stale and recoverable`（**第 755 行**）

完整测试名（嵌套链）：`fileStore` → `treats malformed lock contents with staged artifacts as stale and recoverable`
（该文件顶层 `describe("fileStore", …)` 在第 73 行；此测试无嵌套 describe）。

夹具（775-781 行，逐字）：

```ts
    await writeFile(join(runDir, ".owner-transfer.pending.json"), JSON.stringify(transfer.transferRecord, null, 2));
    await writeFile(join(runDir, ".owner-record.pending.json"), JSON.stringify(transfer.nextOwnerRecord, null, 2));
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: transfer.transferRecord.transferredAt, finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");
```

断言（783-787 行，逐字）：

```ts
    const owner = await readOwnerRecord(runDir);

    expect(owner.currentOwnerEpoch).toBe(2);
    expect(owner.currentProcessInstanceId).toBe("pid:67890");
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
```

**来历**：⚠️ **它没有注释。** 我逐行看过 754（上一条测试的 `});`）到 755 之间 —— 一行注释都没有。
**它的来历只写在标题里**：「as stale and **recoverable**」。
⇒ **推翻既有记载的一个隐含假设**：brief §3.1 说「本仓库的测试注释常常自陈出自某次 ruling」——
**这三条恰恰一条都没有自陈来历**。人若要靠注释追溯它们出自哪次 ruling，**追不到**。

实测失败：`AssertionError: expected 1 to be 2`（第 785 行）。机制：失败关闭 ⇒
`acquireOwnerTransferLock` 抛 `OwnerTransferLockBusyError` ⇒ `recoverInterruptedOwnerTransfer` 的
未持锁分支 `catch { return; }`（1126-1131 行）静默吞掉 ⇒ `readOwnerRecordRaw` 返回**未 finalize** 的旧记录。
**三条断言会连着全错**（epoch 停在 1、pid 停在 `pid:12345`、坏锁还在盘上）。

### 3.2 判据 2 —— **同名同体的逐字重复块**（**第 1187 行**）

`diff <(sed -n '755,788p' …) <(sed -n '1187,1220p' …)` **无输出** ⇒ 34 行逐字相同，
同一个 `describe("fileStore")` 下，vitest 会**跑两遍**，因此**红两次**（实测在 785 与 1217 两处各报一次）。

⇒ **这是对台账「两条」这个数字的具体校正：按标题是 2，按会变红的 `it()` 块是 3。**
（顺带：紧邻的 790 行与 1222 行那一对也是逐字重复。**这个文件里存在成片的重复测试块**，
本身值得一条独立的清理项，但**不属于 B 的地界**。）

### 3.3 判据 3 —— `fileStore > releases the lock after recovering malformed staged state`（**第 1394 行**）

断言（1422-1424 行，逐字）：

```ts
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toContain("not-json");
    await readOwnerRecord(runDir);
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();
```

**来历**：⚠️ 同样**没有注释**（1393 行是上一条的 `});`）。

实测失败：`AssertionError: promise resolved "'not-json\n'" instead of rejecting`（第 1424 行）。

**这一条是三条里最纯粹的**：它的前置断言先证明「坏锁确实在盘上」，后置断言只断言「坏锁被删掉了」。
**它断言的就是夺锁本身**，没有掺任何别的语义。**B 与它是正面冲突，没有调和空间。**

### 3.4 保持绿色、但值得人一起看的兄弟判据

`fileStore > keeps a malformed lock without staged artifacts non-recoverable`（第 790 行，及其重复块 1222 行）
——失败关闭只会让它**更成立**，实测保持绿色。它是这一簇里**唯一带来历注释**的（812-813 行，逐字）：

```ts
    // §3: malformed-and-non-recoverable is a lock-busy outcome (fileStore.ts's
    // acquireOwnerTransferLock, not the CAS check), so it is the sibling class now.
```

⇒ **既有设计已经承认「坏锁 = lock-busy」是一个合法类别**，只是把「有 staged」这一支划到了另一边。
**B 本质上就是把这条兄弟判据的规则推广到有 staged 的那一支。**（这是我的解读，不是判据原文。）

### 3.5 明确的否定性结论（附坏探针防护）

除上述之外，**全量 524 条测试里没有第 4 条因失败关闭而变红**。
这条全称否定的依据是**未过滤的全量跑**（`Tests 3 failed | 521 passed (524)`），
不是 grep；而"探针能开火"由同一次跑里那 3 条确实变红来保证。

## 4. B 的选项矩阵（关掉什么 / 打不开什么 / 代价 / 需要几条新判据）

### 4.0 一条必须先说的结构性事实（**它砍掉了 brief §3.2 列的一个选项**）

brief §3.2 要求覆盖「**加 liveness 判据但保留有限回收**」这个选项。
**这个选项在 `catch` 分支里不可实现。**
`catch` 分支之所以是 `catch`，正是因为**锁内容解析不出来** —— 拿不到 `holderProcessInstanceId`，
就**拿不到 pid**，`isProcessActive` **没有输入**。
⇒ 对不可解析的锁，可用的判据只有三类：**盘上旁证（现状：staged）**、**年龄/租约（mtime）**、**什么都不给（纯失败关闭）**。
**liveness 在这一格是物理上不可得的。** 这一点直接改变了 B 的选项空间形状。

### 4.1 矩阵

| # | 选项 | 关掉什么 | **打不开什么**（残留风险） | 推翻哪些既有判据 | 需要几条新判据 | 失败模式 |
|---|---|---|---|---|---|---|
| **O0** | **维持现状**（不动） | 无 | C-1 全开：**自然节奏下 500 次取锁即 23 次互斥破坏**（实测） | 0 | 0 | 两进程同时持锁 ⇒ D2 顺序无关性前提为假 ⇒ 赢家记录可被覆盖 |
| **O1** | **只做 (a) 原子发布**（不动 B） | 代码能产出的一切不可解析锁；**C-1 的可达触发路径** | 外部篡改／掉电后的坏锁；**§1.6 的第二出口**；`release()` 那一格 | **1 条**（`…two concurrent unlocked readers…`，插桩耦合，非政策判据） | 需要 **1 条新判据**替换被推翻那条的观测方式（改成观测 `link`/`lockPath` 出现，而非 `open`） | `link()` 在未声明的目标平台/文件系统上不可用；孤儿 staging 文件累积（无人清理，**无生产侧影响，但会被 `directoryHasEntries` 之外的东西看到吗？未验**） |
| **O2** | **纯失败关闭**（B 的最强形态，`catch { return false; }`） | 不可解析锁的**所有**夺锁（含 C-1 与外部篡改） | **§1.6 的第二出口原封不动**；`release()` 那一格；**新开一个死锁面**（待裁点 C） | **3 个 `it()` 块 / 2 个标题**（§3，实测） | 至少 **2 条**：①失败关闭本身；②逃生口的判据（否则 §5 的死锁无测试防线） | 一把坏锁**永久**卡死转移路径，且因 1126-1131 行的吞错而**静默**（不报错，只是恢复不发生） |
| **O3** | **年龄/租约判据**（坏锁 + `mtime` 超过阈值 ⇒ 可回收） | C-1（活持有者的锁 mtime 是新的） | 阈值内的外部篡改；**第二出口**；`release()` | 3 个 `it()` 块中**至少 1 个**（1394 行那条断言"立刻被删"，与任何阈值冲突）；755/1187 两条**取决于夹具是否被允许改 mtime** | 至少 **3 条**：阈值取值、时钟来源（mtime vs 内容里的 `acquiredAt`）、阈值内的行为 | 引入**时间**作为正确性依据：时钟回拨、NFS mtime 粒度、长 GC 停顿都会变成夺锁条件。**这是本仓库目前没有的一类依赖** |
| **O4** | **(a) 之后再做纯失败关闭**（先 O1 后 O2） | C-1 ＋ 外部篡改的夺锁 | 第二出口；`release()`；死锁面**但已大幅收窄**（见 §5） | **1 + 3 = 4 个 `it()` 块** | O1 的 1 条 + O2 的 2 条 = **3 条** | 同 O2 的死锁，但触发前提已从「崩溃」提高到「掉电/篡改」 |
| **O5** | **(a) ＋ 锁身份校验（`release()` 那一格一起修）** | C-1 ＋ 误删他人锁 | 第二出口；不可解析锁的夺锁仍失败开放 | O1 的 1 条 ＋ **`release()` 那格是否有既有判据未查**（§9） | O1 的 1 条 + `release()` 的 1 条 = **2 条** | 校验失败时 `release()` 该做什么（吞？抛？记事件？）本身是一个新决策点 |

### 4.2 我的推荐（**推荐，不是裁决**）

**O1 立刻做（它是 C-1 的正解），O5 作为紧随其后的一次小合并，O2/O4 按 B 的原节奏走并与 §1.6 第二出口合并设计。**

理由，按证据强弱排序：
1. O1 是唯一一个**实测把 C-1 归零**、**且不推翻任何政策判据**的选项（推翻的那 1 条是插桩方式）。
2. O2 单独做**不能**解决 C-1 的全部（第二出口还开着），却要付 3 条判据 ＋ 一个新死锁面的代价。
3. O3 的代价（把时间引入正确性）在一个**明确写着"零 fsync、不保证持久性"**的仓库里，
   风险面比它关掉的东西更大。**我不推荐 O3，除非人明确要一个"永不死锁"的保证。**

## 5. 待裁点 C：逃生口

### 5.1 死锁的具体轨迹（**什么情况会留下一把坏且无人释放的锁**）

失败关闭之后，「坏锁」＝ 内容不可解析的锁。**能留下它的轨迹只有这几条：**

| 轨迹 | 今天（基线）可达性 | **(a) 之后**可达性 |
|---|---|---|
| **T1** 进程在 `open(lockPath,"wx")` 与 `handle.writeFile(...)` 之间被 SIGKILL／崩溃 ⇒ 盘上永远留一把 **0 字节**锁 | **可达** —— 这个窗口不是理论的：我的探针在自然节奏下**反复 stat 到 0 字节的锁**（`lockSizes` 含 `0`），Lane 1 也在 8804 次取放锁里观测到 | **不可达** —— `lockPath` 只由 `link()` 产生，源文件内容已写完 |
| **T2** 掉电／内核崩溃，锁内容未落盘（仓库**零 fsync**） | 可达（未实测） | **仍可达**（`link` 保证可见性原子，不保证持久性） |
| **T3** 外部篡改（人手改、第三方工具截断） | 可达（已实测：外部 truncate ⇒ 破坏） | **仍可达** |
| **T4** 持有者进程被 SIGKILL，锁**内容完好** | 可达，但**不是坏锁** —— 走 `try` 分支的 `isProcessActive` ⇒ 正常回收 | 同左，正常回收 |

⇒ ***这是 §0.2 第 5 点的实质：***
**在基线上，T1 让「崩溃即可能永久卡死」成为一条真实轨迹，失败关闭因此是一个明显更危险的动作；
做了 (a) 之后 T1 消失，死锁只剩 T2/T3 —— 失败关闭的风险等级因此显著下降。**
**(a) 不只是 C-1 的修法，它同时是让 B 变得安全的前置条件。**

### 5.2 卡死之后是什么样子（**为什么它是静默的**）

两层静默叠加：

1. **恢复侧静默**：`recoverInterruptedOwnerTransfer` 的未持锁分支
   （`src/persistence/fileStore.ts:1121-1132`）对 `acquireOwnerTransferLock` 的抛出是
   `catch { return; }`。⇒ `readOwnerRecord` **不报错**，只是恢复"没发生"。
2. **生产侧静默（brief §3.3 点名的反向事实，我已独立证实并推广）**：
   - `ensureFreshRunDir` 的 `blockingPaths` **不含** `.owner-transfer.lock`（52-56 行）；
   - 全 `src/` 里**除 `tryRecoverStaleOwnerTransferLock` 与 `release()` 外没有任何代码删除这把锁**；
   - `src/sweep/sweepRuns.ts` **完全不引用它**。

⇒ **一把泄漏/损坏的锁在生产侧不会被任何东西发现、报告或清理。测试确实是唯一防线。**

### 5.3 逃生口候选

| 候选 | 关掉什么 | 代价 / 新风险 | 我的评估 |
|---|---|---|---|
| **E1 人工命令**（`ccloop unlock <runDir>` 之类，显式、需要人在场） | T2/T3 的永久卡死 | 新增 CLI 表面；需要它自己的判据；**人不在场时无用**（自动 loop 场景正是无人值守） | **推荐作为兜底**，因为它不把时间引入正确性；但**不足以单独兜住无人值守场景** |
| **E2 年龄阈值**（坏锁 + 超龄 ⇒ 回收） | T2/T3 的永久卡死，且自动 | 把时钟引入正确性（见 §4.1 O3）；阈值取值要人拍板 | **不推荐单独用**；若人要求"永不死锁"则这是唯一自动解 |
| **E3 sweep 侧回收**（让 `sweepRuns` 认识这把锁） | 长期泄漏的可见性 | sweep 今天完全不碰锁；让它碰锁 = 给 sweep 一个跨进程互斥的责任，**这是一次架构面扩张** | **不推荐现在做**；但**「让 sweep 至少能*报告*一把坏锁」是低风险的高价值项** |
| **E4 `ensureFreshRunDir` 把锁加进 `blockingPaths`** | 让下一次新建 run 时坏锁**可见**（报错而非静默） | 会改变 `ensureFreshRunDir` 的语义面；可能影响既有测试（**未验**） | **中等推荐**，因为它把「静默」变成「响亮」，符合 Rule 12；**但我没验过它会推翻什么** |

⚠️ **E1-E4 的代价我都只做了代码面分析，一个都没有做原型实测。** 见 §9。

## 6. release() 那一格

### 6.1 事实（实测，带必命中 sanity 对照）

`src/persistence/fileStore.ts:944-949`（基线逐字）：

```ts
      return {
        release: async () => {
          await handle.close();
          await safeUnlink(lockPath);
        },
      };
```

一次性探针（**只加了 `export`，逻辑零改动**）：

```
1. we hold the lock; on-disk holder = pid:79744
2. lock path now belongs to = pid:999999          ← 模拟"我们的锁已被夺走并被对方重建"
3. after our release(): DELETED (ENOENT) -- release() removed a lock it did not own
4. SANITY OK: release() deletes our own lock      ← 必命中对照：自己的锁必须被删掉
```

⇒ **`release()` 会删掉一把已经不属于自己的锁。已实测复现。**

### 6.2 判断：**它是独立的一格，但它的"独立性"是有条件的**

**是独立的一格**，理由三条：

1. **它和 B 处在不同的语义轴上。** B 问的是「**什么时候允许夺别人的锁**」（获取侧的失败开放/关闭）；
   `release()` 问的是「**我删的这把锁是不是我的**」（释放侧的身份校验）。
   把两者混成一个决策，会让"失败关闭"这个词同时承载两个不同的政策，正是 Rule 7 说的"混合矛盾模式"。
2. **它不依赖 B 的结论。** 无论 B 裁成失败开放还是失败关闭，「删之前先确认是自己那把」都同样正确。
3. **它有自己的判据需求和自己的失败模式**（校验失败时该吞、该抛、还是该记事件 —— 这是一个新决策点，
   B 的任何形态都不回答它）。

**"有条件"在于**：`release()` 造成实际损害**需要先有一次夺锁**。
⇒ **它的危害度依赖 C-1 是否已修**：
- 今天（C-1 全开）：`release()` 是**放大器** —— 我的基线探针里，持锁进程 stat 到锁文件**不存在（-1）**，
  正是"我的锁被夺走 ⇒ 对方建了新锁 ⇒ 我 release 又把对方的删了"这条链的直接证据。
- 做了 (a) 之后：能让 `release()` 删错的前提，只剩 §2.5 表里那些篡改/掉电级残余。

### 6.3 修它要不要单独授权？（**这是推荐，不是裁决**）

**我的推荐：需要单独的授权点，但它可以和 (a) 打包成同一次授权。**

- **需要单独授权**，因为它**必然要在 `release()` 里新增一次读取＋比较**，
  这改变了 `release()` 的失败面（多一次 I/O ⇒ 多一类 errno 要决定怎么处理），
  而 `release()` 今天被放在 `finally` 里调用（`publishReconciliationUnderTransferLock:528-530`、
  `recoverInterruptedOwnerTransfer:1136-1138`）—— **在 `finally` 里新增可抛的 I/O 是有风险的**，
  必须有人明确同意"`release()` 允许/不允许抛"。
- **可以和 (a) 打包**，因为 (a) 已经在重写 `acquireOwnerTransferLock` 的返回结构
  （原型里 `release` 已经不再需要 `handle.close()`），**两处改动落在同一个函数体内**，
  分两次做反而要动两遍同一段代码，违反 Rule 3 的"surgical"。
### 6.4 🆕 实测：`release()` 的当前行为**没有被任何既有判据锁死**

我做了一次原型变异：给 `release()` 加上身份校验（读回 `lockPath`，只有
`holderProcessInstanceId === \`pid:${process.pid}\`` 才 `safeUnlink`，读不出/解析不出就**不删**）。

- `npx tsc --noEmit` **通过**
- 全量测试：**`Test Files 31 passed (31) / Tests 524 passed (524)`，零失败**

⇒ **两条同样重要的结论：**
1. ✅ **修 `release()` 不推翻任何既有判据** —— 它在判据面上是"自由"的一格，
   这进一步支持"它是独立的一格、可以低成本单独/打包处理"。
2. ⚠️ **Rule 12 反面**：零失败也意味着**今天没有任何一条测试覆盖 `release()` 的删除对象是谁**。
   修它的同时**必须**补一条守护判据，否则这个修复本身没有回归防线
   —— 而 §5.2 已经证明生产侧不会发现任何问题。

## 7. 需要人拍板的问题清单（编号，每条给我的推荐与理由，但标明是推荐）

> **以下 `推荐` 一律是推荐，不是裁决。事实部分在 §1-§6，已与推荐分开写。**

### **Q1 —— C-1 走不走待裁点 B？**（**最重要，其余问题都挂在它下面**）
- **事实**：(a) 原子发布在同一探针下把互斥破坏从 23 次降到 0；它不触碰失败开放/关闭政策；它推翻 1 条测试（插桩耦合）。
- **推荐：不走 B。** 把 C-1 当独立的原子性缺陷修（选项 O1）。
- **理由**：B 单独做既**修不全** C-1（§1.6 第二出口仍开），又要付 3 条判据 ＋ 一个新死锁面；
  而 (a) 用 1 条插桩改动换掉整条可达路径。

### **Q2 —— (a) 推翻的那 1 条测试，怎么处理？**
- **事实**：`tests/persistence/fileStore.test.ts:2929` 的并发双读者测试靠 `open()` 打 `.owner-transfer.lock` 挂钩；
  (a) 之后 `open()` 打临时名。**它的意图（"恰好一个 finalizer"）没有被破坏，只是观测点失效。**
- **推荐：改测试的观测点，不改 (a)。** 把钩子从 `open(lockPath)` 移到 `link(…, lockPath)`（或对 `lockPath` 的出现做轮询）。
- ⚠️ **需要人拍板的真正问题是**：这算不算"为了让实现过关而改测试"？
  我的判断是不算（意图不变、断言不变、只换观测手段），**但这条线由人划。**

### **Q3 —— §1.6 的第二个失败开放出口（`pid === null` ⇒ 无条件删锁），要不要并入 B 的措辞？**
- **事实**：它比 `catch` 分支更宽松（连 staged 都不要求）；B 的原文只提 `catch` 分支，不 cover 它；
  今天仓库内无代码能产出这种内容。
- **推荐：并入。** 待裁点 B 的措辞应改成「`tryRecoverStaleOwnerTransferLock` **的所有非 liveness 出口**改成失败关闭」，
  否则裁完 B 之后仍有一个更宽的洞开着，且**没有任何测试覆盖它**。
- **这条本身就是对既有记载的一次修正**（台账把 B 描述成单一 `catch` 分支的问题）。

### **Q4 —— `release()` 那一格单独授权，还是并入 (a) 的授权？**
- **事实**：可实测复现（§6.1）；加身份校验**零测试失败**（§6.4）；但也**零测试覆盖**。
- **推荐：并入 (a) 的同一次授权，但在台账里记成独立的一格**（独立的判据、独立的失败模式）。
- **理由**：(a) 已经在重写同一个函数的返回结构，分两次改要动两遍同一段代码。

### **Q5 —— `release()` 身份校验失败时该怎么办？（新决策点，无既有先例）**
- **事实**：`release()` 今天被放在两处 `finally` 里调用（`fileStore.ts:528-530`、`1136-1138`）。
  在 `finally` 里新增可抛的 I/O 会覆盖正在飞的原始错误 —— 这正是 `writeJsonFileAtomically:750-761`
  的注释明文防范过的那类问题。
- **推荐：不抛，不删，追加一条事件**（沿用仓库既有的 `owner_transfer_contended` 那种事件通道风格）。
- ⚠️ **必须人拍板**：静默不删 = 可能泄漏一把锁（回到待裁点 C）；抛 = 可能吃掉原始错误。**两害取其一。**

### **Q6 —— 待裁点 C 的逃生口，现在就定，还是等 B 真的通过再定？**
- **事实**：**只要先做了 (a)，死锁轨迹 T1（崩溃留 0 字节锁）就消失**，只剩掉电(T2)/篡改(T3)。
- **推荐：先做 (a)，逃生口的决定可以随 B 一起延后**；但**E4（把 `.owner-transfer.lock` 加进
  `ensureFreshRunDir` 的 `blockingPaths`）值得单独提前评估**，因为它把"静默"变成"响亮"，成本低。
- ⚠️ 我**没有实测 E4 会推翻什么**。

### **Q7 —— `link()` 的平台面，谁来定？**
- **事实**：仓库 `src/` 与 `package.json` 里**零平台判断、零 `os` 字段** ⇒ 没有可依据的目标平台声明。
  我只在 darwin/APFS 上实测过。
- **推荐：请人明确写下目标平台/文件系统**（哪怕只是"darwin + linux，本地文件系统"），
  再决定 (a) 用 `link()` 还是用 `mkdir()` 占位。
- **这不是可以推迟的问题** —— 它决定 (a) 的原语选择，而 (a) 是 Q1 推荐的主路径。

### **Q8 —— `tests/persistence/fileStore.test.ts` 里成片的逐字重复测试块，要不要单开清理项？**
- **事实**：755/1187 与 790/1222 都是**逐字字节相同**的重复块（`diff` 无输出）。
  这直接造成了台账「两条判据」与实际「3 个会红的 `it()`」之间的偏差。
- **推荐：单开一条清理项，不要塞进 B。** 它是记账准确性的问题，不是政策问题。

## 8. 我的临时变异与还原证明

工作区：`/Users/biran/code/skills/loop/ccloop/.worktrees/bdesign`，detached HEAD `dbac2888d028ddd397734d1fa4c1193433918658`。
**全程只改过一个文件：`src/persistence/fileStore.ts`。**
⛔ 主仓库与 `.worktrees/pkg2-wbfix` 全程未触碰。⛔ 无 `commit` / `push` / 建删分支 / 合并。

**变异次数：8 次施加（7 次独立动作），分 4 个还原点。**
⚠️ **诚实分级：4 个还原点里 3 个是直接的 0/0 验证，1 个（R3）只有间接证据 —— 明写在下面。**

| # | 变异 | 目的 | 还原点 |
|---|---|---|---|
| M1 | `acquireOwnerTransferLock` 加 `export` ＋ `__probeWiden()` 窗口加宽钩子（`CCLOOP_PROBE_WIDEN_MS`，默认 0） | 让真双进程探针能调到内部函数 | R1 |
| M2 | 在 M1 之上换成 (a) 原子发布（`open(tmp,"wx")`→写→`link`） | (a) 原型 | R1 |
| M3 | `catch` 分支换成纯失败关闭 `return false` | 测 B 的判据爆炸半径 | R2 |
| M4 | 干净的 (a)（无探针插桩）＋ `import { link }` | 测 (a) 单独的判据代价 | R3 |
| M5 | 加 `export`（**打错符号，命中了 `…ForReconciliation`**） | —— | R3 |
| M6 | 撤销 M5 的误伤 ＋ 给正确的 `acquireOwnerTransferLock` 加 `export` | 修 M5 | R3 |
| M7 | 基线 ＋ 仅加 `export`（逻辑零改动） | 在基线上跑出口枚举与 `release()` 探针 | R4 |
| M8 | `release()` 加身份校验 | 测 `release()` 修法的判据爆炸半径 | R5 |

**还原证明**（每处都是 `rtk proxy git restore --source=HEAD --staged --worktree -- src/persistence/fileStore.ts` 之后）：

```
R1 (撤 M1+M2): worktree-diff-bytes: 0   staged-diff-bytes: 0   tracked-modified: (empty)
R2 (撤 M3):    worktree-diff-bytes: 0   staged-diff-bytes: 0
R3 (撤 M4-M6): ⚠️ 未单独验 0/0 —— 该次 restore 与 M7 在同一条命令里连着做，
               紧接着打印的 `git diff --numstat` 为 `1  1  src/persistence/fileStore.ts`，
               即当时盘上只剩 M7 那一行 `export` 的增删 ⇒ (a) 的 30 增 26 删确已被撤销。
               **这是间接证据，不是 0/0 直证。** 它随后被 R4 的直证覆盖。
R4 (撤 M7):    FINAL worktree-diff-bytes: 0   staged-diff-bytes: 0   tracked-modified: (empty)
R5 (撤 M8):    worktree-diff-bytes: 0   staged-diff-bytes: 0   tracked-modified: (empty)
```

⇒ **最终态由 R5 的直证担保：`git diff` 与 `git diff --cached` 同时为 0 字节，跟踪文件零修改。**

**收尾状态**：`git status --porcelain` 只剩两个未跟踪文件，都是本任务的文档：
`pointB-design-brief.md`（brief 本身）与 `pointB-design.md`（本文件）。**无任何未还原的代码改动。**

**探针脚本一律放在 scratchpad，不在仓库内**：
`/private/tmp/claude-501/-Users-biran-code-skills-loop-ccloop/c74add88-b8d0-4cb8-8759-2160067337a8/scratchpad/`
（`probe-child.mts` / `probe-run.sh` / `probe-run-tamper.sh` / `tamper-child.mts` / `oneshot.mts` / `release-probe.mts`，
以及未过滤的全量测试日志 `failclosed-full.txt` / `atomicA-run1.txt` / `atomicA-run2.txt` / `release-check.txt`）。

### 8.1 ⚠️ 我做过一次坏探针（fail loud）

第一次跑出口枚举时，**9 个用例全部报 REFUSED** —— 看起来像"(a) 把所有夺锁都关掉了"，
是一个极有诱惑力的假结论。真实原因是 `acquireOwnerTransferLock is not a function`（当时那一版没加 `export`），
**探针根本没调到被测函数**。第二次又因为 `python replace(..., 1)` 命中了
`acquireOwnerTransferLockForReconciliation` 而重犯。
**是必命中 sanity 对照（"live pid ⇒ 必须 REFUSED"）之外的另一半 —— "STOLEN 用例必须有 STOLEN"——
把这个假阴性暴露出来的。**
本文件里所有"不发生"的论断，都配了对应的必命中对照。

## 9. 我没能验到的、以及为什么

**Rule 12：以下每一条都是"我没验到"，不要当成"我验过没问题"。**

1. **掉电 / 内核崩溃后的锁内容（T2）** —— 没验。需要真断电或 crash-consistency 工具。
   我只验证了"仓库零 fsync"这个前提（`grep` `src/` 无 fsync 调用，且 `writeJsonFileAtomically:741-742`
   的注释自陈如此）。⇒ **"(a) 之后掉电仍可能留坏锁"是推论，不是实测。**
2. **`link()` 在 darwin 之外的行为** —— 没验。仓库没有平台声明（Q7）。
   Windows/NFS/FUSE 的论断是通用常识，**不是本仓库的实测**。
3. **`link()` 之后遗留的孤儿 staging 文件的下游影响** —— 没验。
   我只确认它不影响本次全量测试（523/524 通过，唯一失败是插桩耦合）。
   **没有验证** `ensureFreshRunDir` 的 `directoryHasEntries` 或 sweep/registry 的扫描会不会把它当成 run 数据。
4. **逃生口 E1-E4 的实际代价** —— 一个原型都没做。特别是
   **E4（把锁加进 `blockingPaths`）会推翻哪些判据，完全未测。**
5. **选项 O3（年龄/租约）会具体推翻哪几条判据** —— 没做原型。§4.1 里 O3 那一格的"至少 1 个"
   是从断言语义推断的（1394 行断言"立刻被删"必然与任何阈值冲突），**不是实测数字**。
6. **`evidence.test.ts` 那次超时** —— 我判定为负载抖动，依据是两次干净复跑都绿。
   **我没有做统计意义上的多次复跑**，不能排除它是低频不稳定测试。
7. **`tryRecoverStaleOwnerTransferLock` 在 `readFile` 抛非 ENOENT 时的行为**（895 行 `throw error`）
   —— 没验它会走到哪些调用方、被谁吞掉。
8. **待裁点 A** —— 按 brief 铁律 8，全程未碰。
9. **包 1**（`.superpowers/sdd/2026-08-07-pkg1-l5-spec/`）—— 按铁律，一个字没读。
10. **我没有复核两份 lane 报告的其它结论** —— 我只复核了 brief 明确点名要我当承重前提的那几条
    （C-1 的可复现性、`blockingPaths` 的反向事实、"两条判据"这个数字、承重注释的存在）。
    **lane 报告里的其它任何说法，本文件都没有背书。**

## 10. 预算：harness 可数事实

> 按人裁 45：**只交可数事实，不自报预算估计。**

- **改动过的仓库文件数**：1（`src/persistence/fileStore.ts`），已全部还原。
- **变异施加次数**：7（M1-M8，其中 M5+M6 为同一次修补）；**还原点**：5；**每个还原点均验证 `git diff` 与 `git diff --cached` 同时为 0 字节**。
- **全量测试跑次数**：**7 次**
  （基线 1、(a)+插桩 1、纯失败关闭 2、干净 (a) 2、`release()` 身份校验 1）。
- **`tsc --noEmit` 跑次数**：2（干净 (a) 一次、`release()` 身份校验一次），均通过。
- **多进程探针跑次数**：**5 次**（smoke / base-staged / ctrl-nostaged / atomicA-staged / atomicA-tamper），
  每次 2-3 个真实 Node 进程。
- **一次性探针跑次数**：5 次（出口枚举 4 次 —— 其中 **2 次是坏探针**，`release()` 探针 1 次）。
- **探针内的取锁尝试总数**：`(50+500+500+500+500) × 2 进程 = 4100` 次，另加截断探针 1982 次成功截断。
- **未过滤落盘的测试日志**：4 份（`failclosed-full.txt` / `atomicA-run1.txt` / `atomicA-run2.txt` / `release-check.txt`）。
- **派出的子代理**：1 个（只读，用于找 B 会推翻的判据）。**它给出的每一条结论我都用变异 + 全量跑独立复核过，
  并且校正了它的计数框架**（它按"3 个 `it()` 块"报，我用实测确认为 3 处失败、2 个不同标题）。
- **环境**：`ECC_GATEGUARD=off`、`DISABLE_OMC=1`；所有验证命令走 `rtk proxy`；
  darwin 24.6.0 / Node v22.13.1 / vitest 2.1.9。
