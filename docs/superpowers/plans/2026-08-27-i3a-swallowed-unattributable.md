# I-3(a) ＋ 心跳两处吞 —— 逐任务实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本仓库覆盖 `executing-plans` 的隔离 worktree 要求**：铁律 1 把「删 worktree」列为需人单独授权，历轮都直接在 `main` 上落**本地**提交。CLAUDE.md 优先。

**Goal:** 让一把永远不会被释放的转移锁在三处被吞掉的地方停止静默，并沿它抛出后的路径把每个消费点重决一遍。

**Architecture:** 收窄 `recoverInterruptedOwnerTransfer` 的裸 `catch`，只放 `OwnerTransferLockUnattributableError` 出来；它在 `runLoop` 里由**外层 catch 一处路由**接住（不在两个调用点各接一次），在 `resumeLoop` 里只是把已有的拒绝**改说真名**；心跳两处保持行为不变，只在一个运行里留下**恰好一条**事件。

**Tech Stack:** TypeScript (ESM, NodeNext)、vitest 2.1.9、Node `node:fs/promises`。无新依赖。

**Spec:** `docs/superpowers/specs/2026-08-27-i3a-swallowed-unattributable-design.md`

## Global Constraints

- **授权**：人裁 109／111／112／113／114／115。**超出这些措辞的改动一律停下来问人**，不许自行外推。
- **控制器绝不 `push`**；不开门、不合并、不删分支或 worktree。
- **不许实施者自改判据**。本计划**只**改人裁 115 指名的那四条；需要新覆盖时只加不改。
- **变异只在 `git clone --local` 副本里做**，主仓库工作树全程零触碰。副本只克隆**已提交**状态 ⇒ 要测未提交改动必须先 `cat 工作树文件 > 副本对应文件`，并 `diff` 证明逐字节相同；删副本前做「副本文件 vs 工作树文件」最终字节比对。
- **注释铁律**：已发布或上一会话写的注释，**原文逐字保留 ＋ 块末追加具名 `*** ERRATUM (…, HUMAN RULING N) … ***`**；erratum 里不写会被后续裁决推翻的计数，不引用会移动的 git 引用。只有「本会话刚写、从未为真、且未发布」才可就地改。
- **编辑一律「行号 ＋ 整行锚点 ＋ 断言命中数 ==1 否则退出」**，不许用子串 `replace`。
- **绝不过滤验证性跑**：重定向到文件、整份读回、核 vitest 第一行 `RUN` 指向的路径。验证性命令一律走 `rtk proxy`。
- 测试环境变量：`export ECC_GATEGUARD=off DISABLE_OMC=1`。
- **基线**：`35 files / 609 tests` 全绿零 skipped（2026-08-27 现测，耗时 17.77s）。本计划**只加 4 条判据**，完工后应为 **613**。
- **已知 flake 共 4 条**，红了先对这份名单 ＋ 是否 `Test timed out in 5000ms` ＋ 总耗时（正常 17–22s，红的那轮 25–29s），再单独重跑那个文件：
  1. `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
  2. `subprocessClaudeAdapter > persists phase usage evidence…`（`runLoop > persists phase usage evidence from the subprocess adapter…`）
  3. `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
  4. `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data`
- **一条变异在被【看到】打红之前，它不是证明。** 钉「什么都没发生」的判据必须配一条正向观测。拿 rejection 一律用 `.then(onFulfilled, onRejected)` 并在 onFulfilled 里 throw，**不要用 `.catch(e => e)`**。
- ⚠️ **Task 1 落地后、Task 3 落地前存在一个中间态**：生产里撞上不可归属的锁会让运行被判 `failed`。本地提交可以，**但不要在这个中间态上派评审或收工**。

---

## File Structure

| 文件 | 本轮的职责 |
|---|---|
| `src/persistence/fileStore.ts` | 收窄未持锁分支的 `catch`（唯一改动点），并在该注释块末尾追加 ERRATUM |
| `src/controller/resumeLoop.ts` | 入口读的 catch 里加不可归属分支，只改 detail 的措辞 |
| `src/controller/runLoop.ts` | `runLoopFromState` 外层 catch 加一支：记事件 ＋ 原地放弃本次尝试 |
| `src/controller/leaseHeartbeat.ts` | `runAffirm` 与 `stop()` 各加一支，共用一个实例级「已记过」标志 |
| `tests/persistence/fileStore.test.ts` | 人裁 115 指名改写的四条 |
| `tests/controller/resumeLoop.integration.test.ts` | 新判据 N2 |
| `tests/controller/leaseLifecycle.integration.test.ts` | 新判据 N1 |
| `tests/controller/leaseHeartbeat.test.ts` | 新判据 N3、N4 |

---

### Task 1: 收窄 `recoverInterruptedOwnerTransfer`，并改写人裁 115 指名的四条

**Files:**
- Modify: `src/persistence/fileStore.ts`（`recoverInterruptedOwnerTransfer` 的未持锁分支，`catch` 那几行 ＋ 其上注释块）
- Test: `tests/persistence/fileStore.test.ts`（四条既有判据，人裁 115 指名）

**Interfaces:**
- Consumes: 既有 `OwnerTransferLockUnattributableError`（`src/persistence/fileStore.ts` 已导出）
- Produces: `readOwnerRecord(runDir: string): Promise<OwnerRecord>` **新增一个失败面** —— 当且仅当转移锁不可归属时 reject `OwnerTransferLockUnattributableError`。Busy 与非 EEXIST errno 的行为逐格不变。Task 2／3 依赖这个失败面。

- [ ] **Step 1: 先确认基线与锚点**

```bash
cd /Users/biran/code/skills/loop/ccloop
git ls-remote origin refs/heads/main            # 开工核一次
git status --porcelain > /tmp/st.txt; wc -c < /tmp/st.txt   # 期望 0
grep -n "keeps a malformed lock non-recoverable even when staged artifacts are present" tests/persistence/fileStore.test.ts
grep -n "keeps a lock non-recoverable when its live holder is in the strong instance-id form" tests/persistence/fileStore.test.ts
grep -n "observes that the redline function actually ran on the strong-holder fixture" tests/persistence/fileStore.test.ts
grep -n "leaves the lock on disk when malformed staged state names no dead holder" tests/persistence/fileStore.test.ts
```

四条都必须**各命中一次**。命中数不是 1 就停下来问人（判据可能已被别的轮次动过）。

- [ ] **Step 2: 改写那四条（先改判据，后改实现 —— 这是真 TDD 红）**

前三条形状相同，把 `const owner = …` ＋ epoch 断言换成 rejects：

```ts
    await expect(readOwnerRecord(runDir)).rejects.toBeInstanceOf(OwnerTransferLockUnattributableError);
```

第四条 `leaves the lock on disk when malformed staged state names no dead holder` **没有 `const owner`**，它是裸 `await readOwnerRecord(runDir);`，同样换成上面这一行。

**逐字保留**：锁仍在盘上的断言、staged pending 未被 finalize 的断言、第三条里 `lockReads > 0` 那个正向观测（它是「代码真的被进入过」的唯一证据，去掉整条就变空）。

每条改动处**加一行注释写明编码的是哪条人裁**，例如：

```ts
    // Human ruling 111: readOwnerRecord no longer returns the pre-transfer record when the
    // transfer lock cannot be attributed to any process. This criterion encodes that reversal;
    // the lock-on-disk assertions below still encode human ruling 83, unchanged.
```

`OwnerTransferLockUnattributableError` **已在该文件 import**（`tests/persistence/fileStore.test.ts` 第 13 行，本会话现测），无需改 import。

- [ ] **Step 3: 跑它们，确认【先红】**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run tests/persistence/fileStore.test.ts > /tmp/t1-red.txt 2>&1; echo "RC=$?" >> /tmp/t1-red.txt
cat /tmp/t1-red.txt
```

期望：**4 条红**，红的方式是 `promise resolved instead of rejecting`（收窄还没做，`readOwnerRecord` 仍然 resolve）。
⚠️ **红的条数不是 4、或红的原因不是这个，就停下来查**，别往下走。

- [ ] **Step 4: 做收窄**

`src/persistence/fileStore.ts`，`recoverInterruptedOwnerTransfer` 的未持锁分支。锚点（整行，必须命中一次）：

```
    } catch {
```

改成：

```ts
    } catch (error) {
      // Human ruling 111 (I-3(a)). Narrowed to what the paragraph below actually names. An
      // OwnerTransferLockUnattributableError is neither of those two: nothing will ever release
      // that lock, so returning here published a pre-transfer record for the rest of the run's
      // life with nobody told. It is the ONLY class that escapes; busy and errno are unchanged.
      if (error instanceof OwnerTransferLockUnattributableError) {
        throw error;
      }
```

其余行（那段注释与 `return;`）**一字不动**。

- [ ] **Step 5: 在该注释块末尾追加 ERRATUM**

那段注释是上一会话写的 ⇒ **原文逐字保留**，在 `return;` 之前、注释块的**最末尾**追加：

```ts
      //
      // *** ERRATUM (I-3(a), HUMAN RULING 111) -- "this read must not surface a new failure mode"
      // above is kept verbatim and still governs the two cases it names. It no longer governs a
      // third: a lock that cannot be attributed to any process now escapes this catch. That case
      // is not "recovery can't run right now" -- it is "recovery can never run", and the caller
      // that was told the read succeeded went on deciding ownership from a record the transfer
      // had already superseded. Which criteria pin this is recorded in the ledger, not here. ***
```

- [ ] **Step 6: 跑，确认四条转绿，且同文件其余判据不受影响**

```bash
rtk proxy npm test -- --run tests/persistence/fileStore.test.ts > /tmp/t1-green.txt 2>&1; echo "RC=$?" >> /tmp/t1-green.txt
cat /tmp/t1-green.txt
```

期望：`91 passed`，`RC=0`。

- [ ] **Step 7: 跑全量 ＋ typecheck ＋ build**

```bash
rtk proxy npm test -- --run > /tmp/t1-all.txt 2>&1; echo "TEST_RC=$?" >> /tmp/t1-all.txt
rtk proxy npm run typecheck > /tmp/t1-tc.txt 2>&1; echo "TYPECHECK_RC=$?" >> /tmp/t1-tc.txt
rtk proxy npm run build > /tmp/t1-bd.txt 2>&1; echo "BUILD_RC=$?" >> /tmp/t1-bd.txt
cat /tmp/t1-all.txt; cat /tmp/t1-tc.txt; cat /tmp/t1-bd.txt
```

期望 `35 files / 609 tests` 全绿零 skipped。红了先对已知 flake 名单。

- [ ] **Step 8: 变异证明 M6（副本里做）**

```bash
S=/tmp/i3a; /bin/rm -rf $S; mkdir -p $S
git clone --local -q . $S/m6
cat src/persistence/fileStore.ts > $S/m6/src/persistence/fileStore.ts   # 副本只克隆已提交状态
cat tests/persistence/fileStore.test.ts > $S/m6/tests/persistence/fileStore.test.ts
diff src/persistence/fileStore.ts $S/m6/src/persistence/fileStore.ts && echo SRC_IDENTICAL
diff tests/persistence/fileStore.test.ts $S/m6/tests/persistence/fileStore.test.ts && echo TEST_IDENTICAL
ln -s "$PWD/node_modules" $S/m6/node_modules
```

在副本里把 Step 4 的 `if (error instanceof …) { throw error; }` 三行删掉（`catch (error)` 改回 `catch {`），跑：

```bash
cd $S/m6 && ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run --run tests/persistence/fileStore.test.ts > $S/m6.txt 2>&1; echo "RC=$?" >> $S/m6.txt; cat $S/m6.txt
```

**期望：那四条【变红】**（撤掉收窄后 `readOwnerRecord` 恢复 resolve，而它们断言的是 `rejects`）。
⚠️ **不是「回绿」** —— 看到绿反而说明改写没承重，停下来查。

跑完做还原证明：主仓库 `git status --porcelain` / `git diff` / `git diff --cached` **三项字节数**，再 `/bin/rm -rf $S/m6`（本机 `rm` 有 `-i` alias，**必须用 `/bin/rm`**）。

- [ ] **Step 9: 提交**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -F - <<'MSG'
fix(fileStore): stop a lock that can never clear from being swallowed as if it would (I-3(a), human rulings 111/115)

The bare catch swallowed three things while its own comment named two. The third
-- an owner-transfer lock no process can be attributed to -- was not "recovery
can't run right now" but "recovery can never run", and readOwnerRecord went on
returning the pre-transfer record for the rest of the run's life with nobody told.

Ruling 115 names the four criteria this reverses; every lock-on-disk, staged-
pending and lockReads assertion in them is kept verbatim, and each records which
ruling it now encodes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: `resumeLoop` 的入口读说出病名

**Files:**
- Modify: `src/controller/resumeLoop.ts`（入口读那个 `catch`，即 `cannot read run artifacts` 的那处）
- Test: `tests/controller/resumeLoop.integration.test.ts`（新判据 N2）

**Interfaces:**
- Consumes: Task 1 的失败面（`readOwnerRecord` 会 reject `OwnerTransferLockUnattributableError`）
- Produces: 无新导出。`resume_denied` 事件的 detail 多一种取值 `owner-transfer lock unattributable: …`。

- [ ] **Step 1: 写 N2（先红）**

加在既有那条 `stays fail-closed when the claim hits a busy owner-transfer lock…` 附近。⚠️ **必须同时写 marker 与坏锁** —— 没有 `.owner-transfer.transaction.json`，`recoverInterruptedOwnerTransfer` 会在 `pathExists` 那里直接返回，**根本不去拿锁**，判据就空了。

```ts
  // Human ruling 111 (I-3(a)). The entry read -- not the claim -- is what walks into recovery, and
  // recovery is what takes the lock. Before this, an unattributable lock made that read throw into
  // the catch that says "cannot read run artifacts": true of nothing here. The artifacts are
  // perfectly readable; what cannot run is the recovery, and only a human can clear it.
  it("names an unattributable transfer lock on the entry read, instead of calling the artifacts unreadable", async () => {
    const repoPath = await createRepo();
    const contract = createContract(repoPath);
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    await seedEligibleRun(runDir, contract, 1);

    // Both files are required: the marker is what makes recoverInterruptedOwnerTransfer go for the
    // lock at all, and the unparseable lock is what makes that acquisition unattributable.
    await writeFile(
      join(runDir, ".owner-transfer.transaction.json"),
      JSON.stringify({ version: 1, stagedAt: new Date().toISOString(), finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
    );
    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    await expect(resumeLoop(runDir, new ScriptedAdapter([successFrame()]))).rejects.toBeInstanceOf(
      ResumeNotEligibleError,
    );

    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; detail: string });
    const denied = events.filter((event) => event.type === "resume_denied");

    expect(denied).toHaveLength(1);
    expect(denied[0].detail).toContain("owner-transfer lock unattributable");
    expect(denied[0].detail).toContain("ccloop unlock");
    expect(denied[0].detail).not.toContain("cannot read run artifacts");
    // The lock is still on disk, byte for byte: this refusal must not have reclaimed anything.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe("not-json\n");
  });
```

- [ ] **Step 2: 跑，确认先红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run tests/controller/resumeLoop.integration.test.ts -t "names an unattributable transfer lock on the entry read" > /tmp/t2-red.txt 2>&1; echo "RC=$?" >> /tmp/t2-red.txt
cat /tmp/t2-red.txt
```

期望：红，且 detail 实际是 `cannot read run artifacts: OwnerTransferLockUnattributableError: …`。
⚠️ **把实际 detail 抄下来** —— 它是 M3 的期望值。

- [ ] **Step 3: 实现**

`src/controller/resumeLoop.ts` 入口读的那个 `catch (error)` 内，把固定串换成分支（形状抄同文件 claim 站点已有的三分支）：

```ts
    // Human ruling 111 (I-3(a)). "cannot read run artifacts" is true of an ENOENT or a bad parse.
    // It is false of this: every artifact is readable, and what failed is the recovery the read
    // performs on the way -- blocked by a lock nothing will ever release. Same fail-closed exit,
    // a detail the operator can act on.
    const detail = error instanceof OwnerTransferLockUnattributableError
      ? `owner-transfer lock unattributable: ${String(error)}`
      : `cannot read run artifacts: ${String(error)}`;
    await appendEvent(runDir, { type: "resume_denied", at: new Date().toISOString(), detail });
    throw new ResumeNotEligibleError(detail);
```

`OwnerTransferLockUnattributableError` 已在该文件 import（claim 站点在用），**先确认，没有再加**。

- [ ] **Step 4: 跑，确认转绿 ＋ 整文件不回归**

```bash
rtk proxy npm test -- --run tests/controller/resumeLoop.integration.test.ts > /tmp/t2-green.txt 2>&1; echo "RC=$?" >> /tmp/t2-green.txt
cat /tmp/t2-green.txt
```

期望 `17 passed`（原 16 ＋ N2），`RC=0`。

- [ ] **Step 5: 变异证明 M3（副本）**

副本里把 `detail` 那个三元式换回固定的 `cannot read run artifacts: ${String(error)}`，跑 N2。
**期望：N2 红，且 detail 退回 Step 2 抄下来的那个字符串。**
还原证明 ＋ `/bin/rm -rf` 副本。

- [ ] **Step 6: 提交**

```bash
git add src/controller/resumeLoop.ts tests/controller/resumeLoop.integration.test.ts
git commit -F - <<'MSG'
fix(resumeLoop): stop calling a blocked recovery an unreadable artifact (I-3(a), human ruling 111)

Every artifact is readable. What could not run is the recovery the entry read
performs on the way, blocked by a lock no process can be attributed to -- so the
operator was handed a diagnosis pointing at the wrong file. Same fail-closed
exit, a detail naming the lock and the one command that clears it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 3: `runLoop` 的一处路由（**含那条未量前提的度量**）

**Files:**
- Modify: `src/controller/runLoop.ts`（`runLoopFromState` 外层 catch，在 `RunHeartbeatStoppedError` 分支附近、**通用失败处理之前**）
- Test: `tests/controller/leaseLifecycle.integration.test.ts`（新判据 N1）

**Interfaces:**
- Consumes: Task 1 的失败面
- Produces: 无新导出。`owner_transfer_contended` 事件多一种 detail 取值 `owner transfer recovery blocked: …`。

- [ ] **Step 1: 写 N1（先红），并把它当作前提的度量**

加在既有那条 `contains an unattributable transfer lock as a recorded contention…` 之后。fixture ＝ 那条的 fixture **再加 marker**：

```ts
  // Human ruling 114 (I-3(a)). The sibling test above walks the TRANSFER path, which already
  // contains this class. This one walks the READ path: with the transaction marker present, the
  // ownership evaluation's readOwnerRecord goes into recovery, recovery goes for the lock, and
  // human ruling 111 lets that failure out. Nothing about this is an attempt failure -- no phase
  // ran and no verification was rejected -- so the run must not be transitioned to "failed".
  it("abandons the attempt in place when the ownership read hits an unattributable transfer lock, without failing the run", async () => {
    const repoPath = await createRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ccloop-run-"));
    const baseContract = createContract(repoPath);
    const contract: LoopContract = {
      ...baseContract,
      executionPolicy: {
        ...baseContract.executionPolicy,
        perAttemptTimeoutMs: 200,
      },
    };

    const adapter: RuntimeAdapter = {
      async plan() {
        return { summary: "change src/index.ts", primaryTargetPaths: ["src/index.ts"] };
      },
      async execute(context) {
        await writeFile(join(runDir, "owner-record.json"), JSON.stringify({
          runId: "task-1",
          logicalSessionId: "task-1:lost",
          currentOwnerEpoch: 1,
          currentProcessInstanceId: buildProcessInstanceId(),
          lastAffirmedAt: "2026-07-23T00:00:00.000Z",
          ownerStatus: "lost",
          supersededByEpoch: null,
        }, null, 2));
        // The marker is what sends the ownership read into recovery; the unparseable lock is what
        // makes that recovery unattributable. Either alone leaves this test vacuous.
        await writeFile(
          join(runDir, ".owner-transfer.transaction.json"),
          JSON.stringify({ version: 1, stagedAt: "2026-07-23T00:00:00.000Z", finalizeOrder: ["owner-transfer.json", "owner-record.json"] }, null, 2),
        );
        await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");
        await waitForAbort(context.abortSignal);
        return null;
      },
      async verify() {
        throw new Error("verify should not run");
      },
    };

    const finalState = await runLoop(contract, runDir, adapter);

    // The positive observation this test exists for: the branch was entered.
    const contended = (await readEvents(runDir)).filter(
      (event) => event.type === "owner_transfer_contended",
    );
    expect(contended).toHaveLength(1);
    expect(contended[0].detail).toContain("cannot be attributed");
    expect(contended[0].detail).toContain("ccloop unlock");
    // And, having been entered, it did NOT upgrade a blocked recovery into an attempt failure.
    expect(finalState.status).not.toBe("failed");
    expect(finalState.status).not.toBe("cancelled");
    // The lock is untouched: this exit reclaims nothing.
    await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).resolves.toBe("not-json\n");
    // Spec §2.3 premise 2, measured rather than assumed: the branch persists what it returns, so
    // the returned state and the one on disk do not disagree. Mutation M8 is what proves this
    // assertion is load-bearing -- if deleting the write leaves it green, the write is unpinned
    // and that is a finding to report, not to paper over.
    const persisted = JSON.parse(await readFile(join(runDir, "loop-state.json"), "utf8")) as RunState;
    expect(persisted.status).toBe(finalState.status);
    expect(persisted.attemptsUsed).toBe(finalState.attemptsUsed);
  });
```

⚠️ `readFile` 与 `RunState` **已在该文件 import**（第 2 行与类型 import 块，本会话现测），无需改 import。

- [ ] **Step 2: 跑，并把实际状态抄下来 —— 这就是那条未量前提的度量**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run tests/controller/leaseLifecycle.integration.test.ts -t "abandons the attempt in place when the ownership read hits" > /tmp/t3-red.txt 2>&1; echo "RC=$?" >> /tmp/t3-red.txt
cat /tmp/t3-red.txt
```

**期望：红，且红在 `expect(finalState.status).not.toBe("failed")` —— 即实测到运行确实被判了 `failed`。**

⛔ **这一步是决策点，不是走过场：**
- 若红的是**别的断言**（例如事件根本没出现、或状态是 `exhausted`）⇒ **spec §2.3 第 1 条前提不成立**。**停下来**，把实测状态与栈报给人，**不要**照计划往下写分支。
- 若这条判据**直接绿了** ⇒ 说明这条路上已经有别的东西接住了它，**分支可能是多余的**。同样停下来报人。

- [ ] **Step 3: 实现那一支**

`src/controller/runLoop.ts`，`runLoopFromState` 的外层 catch 内。锚点（整行，命中一次）：

```
      if (error instanceof RunHeartbeatStoppedError) {
```

在这一段**之后**、`isLeaseStopError` 那一段**之前**插入（相对 `isLeaseStopError` 的次序无所谓，两者的类不相交；**唯一承重的是排在通用失败处理之前**）：

```ts
      // Human ruling 114 (I-3(a)). An owner-transfer lock nothing can be attributed to reaches
      // here from the ownership read, through the narrowed catch human ruling 111 opened. It is
      // routed ONCE, here, rather than at each readOwnerRecord call site: one of those sites sits
      // inside the catch that just contained this same class, and catching it there would take
      // that containment apart.
      //
      // Contained exactly as the transfer path contains it: an abandonment, not an attempt
      // failure. Nothing was attempted and nothing was rejected -- a lock is stuck, and only
      // `ccloop unlock` moves it. Falling through to the generic handling below would transition
      // the run to "failed" and fingerprint an attempt that never ran. Deliberately NOT a new
      // event type, for the reason the transfer path already recorded: this stream already names
      // "a transfer blocked by a lock", and a second type would split every consumer of it.
      //
      // The writeOwnedRunState mirrors the RunHeartbeatStoppedError branch above and is not
      // redundant with the loop's own write: this branch fires mid-attempt, where `state` may
      // have been advanced by applyPhaseUsage since that write.
      if (error instanceof OwnerTransferLockUnattributableError) {
        await appendEvent(runDir, {
          type: "owner_transfer_contended",
          at: new Date().toISOString(),
          detail: `owner transfer recovery blocked: ${String(error)}`,
        });
        await writeOwnedRunState(runDir, state);
        return state;
      }
```

`OwnerTransferLockUnattributableError` 已在该文件 import（转移路径在用），**先确认**。

- [ ] **Step 4: 跑，确认转绿 ＋ 整文件不回归**

```bash
rtk proxy npm test -- --run tests/controller/leaseLifecycle.integration.test.ts > /tmp/t3-green.txt 2>&1; echo "RC=$?" >> /tmp/t3-green.txt
cat /tmp/t3-green.txt
```

期望 `29 passed`（原 28 ＋ N1），`RC=0`。

- [ ] **Step 5: 变异证明 M1／M2／M7（同一个副本里依次做，每次只改一处并跑）**

| | 怎么变 | 期望 |
|---|---|---|
| M1 | 整段 `if (error instanceof OwnerTransferLockUnattributableError) { … }` 删掉 | N1 红，且红在 `not.toBe("failed")` |
| M2 | 把该段整体移到通用失败处理**之后**（即那句 `if (state.status !== "failed") { … }` 之后） | N1 红 —— 通用处理以 `return state` 结尾，排在其后不可达 |
| M7 | 把条件放宽成 `error instanceof Error` | `tests/controller/runLoop.integration.test.ts` 里那些断言 `status).toBe("failed")` 的判据**变红**（该文件现有 14 处这样的断言） |
| M8 | 只删掉 `await writeOwnedRunState(runDir, state);` 这一行 | N1 里那两条 `persisted.*` 断言**变红** —— 这是 spec §2.3 前提 2 的度量。⚠️ **若它不红**，说明这一行没有被钉住（返回值与盘上本来就一致）⇒ **停下来把实测报给人**，由人决定是删掉这一行还是留着；**不许实施者自行判断** |

每次变异都必须**看到红**才算数；跑完 `git checkout -- src/controller/runLoop.ts` 回到副本基线再做下一个。
最后做还原证明（主仓库三项字节数）＋ `/bin/rm -rf` 副本。

- [ ] **Step 6: 提交**

```bash
git add src/controller/runLoop.ts tests/controller/leaseLifecycle.integration.test.ts
git commit -F - <<'MSG'
fix(runLoop): route a blocked transfer recovery to abandonment, not to a failed attempt (I-3(a), human ruling 114)

Routed once, in the outer catch, rather than at each readOwnerRecord call site:
one of those sites is inside the catch that just contained this same class, and
catching it there would take that containment apart.

Measured before the branch existed: the run was transitioned to "failed" --
fingerprinting an attempt that never ran, for a lock only `ccloop unlock` can
move. Contained now exactly as the transfer path contains it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 4: 心跳两处 —— 一个运行恰好一条

**Files:**
- Modify: `src/controller/leaseHeartbeat.ts`（`runAffirm` 的 catch、`stop()` 的 catch，以及新增的实例级标志）
- Test: `tests/controller/leaseHeartbeat.test.ts`（新判据 N3、N4）

**Interfaces:**
- Consumes: 既有 `OwnerTransferLockUnattributableError`（需新增 import）、既有 `appendLeaseEvent`
- Produces: 无新导出、无签名变化。`LeaseHeartbeat` 的对外形状**一字不变**。

- [ ] **Step 1: 写 N3 与 N4（先红）**

N3 抄既有那条 `treats a busy owner-transfer lock as transient…` 的形状。⚠️ **这条路径不需要 marker**：心跳的 affirm 直接走 `acquireOwnerTransferLock`，不经 `recoverInterruptedOwnerTransfer` 的 `pathExists` 早退。

```ts
  // Human ruling 112. The busy-lock test above is the transient case: it clears when its holder
  // exits, and retrying every tick is right. This one never clears -- nothing holds it -- so the
  // heartbeat would retry it for the life of the run with nobody told. The retry itself is
  // deliberately unchanged (ruling 112); what changes is that it stops being silent.
  it("records an unattributable owner-transfer lock once, and keeps ticking", async () => {
    const runDir = await seed(record());
    const lost: unknown[] = [];
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: (error) => lost.push(error),
    });

    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    const types = await readEventTypes(runDir);
    expect(types.filter((type) => type === "owner_transfer_contended")).toHaveLength(1);
    expect(types).not.toContain("lease_lost");
    expect(lost).toHaveLength(0);

    // Still ticking: free the lock and the next tick affirms normally. Without this the test
    // could pass against a heartbeat that recorded the event and then stopped affirming.
    await rm(join(runDir, ".owner-transfer.lock"));
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
    await heartbeat.affirmNow();

    expect((await readOwner(runDir)).leaseAffirmedAt).not.toBeNull();
    await heartbeat.stop();
  });

  // Human ruling 112/113. "Recorded" and "recorded once" are two different claims: a per-tick
  // append would drown the stream, and the flag is shared with stop() so a run leaves at most one
  // of these however many times it hits the lock.
  it("records the unattributable lock at most once per run, across repeated ticks and stop()", async () => {
    const runDir = await seed(record());
    const heartbeat = startLeaseHeartbeat({
      runDir,
      ownerRecord: record(),
      onLeaseLost: () => {},
    });

    await writeFile(join(runDir, ".owner-transfer.lock"), "not-json\n");

    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS);
      await heartbeat.affirmNow();
    }

    // stop() hits the same lock through releaseOwnerLease, and shares the same flag.
    await heartbeat.stop();

    const types = await readEventTypes(runDir);
    expect(types.filter((type) => type === "owner_transfer_contended")).toHaveLength(1);
  });
```

- [ ] **Step 2: 跑，确认先红**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run tests/controller/leaseHeartbeat.test.ts -t "unattributable" > /tmp/t4-red.txt 2>&1; echo "RC=$?" >> /tmp/t4-red.txt
cat /tmp/t4-red.txt
```

期望：**两条都红**，红在 `toHaveLength(1)` 收到 `0`（事件根本没被记）。

- [ ] **Step 3: 实现**

1) import 里加 `OwnerTransferLockUnattributableError`（加进既有那个 `from "../persistence/fileStore.js"` 的块）。

2) 在 `startLeaseHeartbeat` 的局部状态处（`let superseded = false;` 附近）加：

```ts
  // Human ruling 112/113: at most one of these per run. Every tick hits the same lock, and the
  // stop path hits it again through releaseOwnerLease; without this the event stream would carry
  // one line per tick for a condition that is a single standing fact.
  let unattributableLockRecorded = false;
```

3) `runAffirm` 的 catch 内，**在既有 `if (!(error instanceof OwnerTransferPreconditionError))` 之前**插入：

```ts
      // Human ruling 112. This one is NOT what the paragraph below means by transient: no process
      // holds it, so no tick will ever find it cleared. The retry is deliberately left alone --
      // stopping the affirm would let the lease age out and invite a second process onto a run
      // the same lock will block -- but it stops being invisible.
      if (error instanceof OwnerTransferLockUnattributableError) {
        if (!unattributableLockRecorded) {
          unattributableLockRecorded = true;
          await appendLeaseEvent("owner_transfer_contended", `lease affirm blocked: ${String(error)}`);
        }

        return;
      }
```

4) `stop()` 的 `catch {}` 改成：

```ts
    } catch (error) {
      // Swallowed by contract: the lease simply ages out.
      //
      // Human ruling 113: the swallow stands, byte for byte. Only the silence goes -- and only
      // when the release failed on a lock nobody will ever clear, and only if no tick already
      // said so (the flag is shared with runAffirm).
      if (error instanceof OwnerTransferLockUnattributableError && !unattributableLockRecorded) {
        unattributableLockRecorded = true;
        await appendLeaseEvent("owner_transfer_contended", `lease release blocked: ${String(error)}`);
      }
    }
```

⚠️ 既有那行注释 `// Swallowed by contract: the lease simply ages out.` **原文逐字保留**。

- [ ] **Step 4: 跑，确认转绿 ＋ 整文件不回归**

```bash
rtk proxy npm test -- --run tests/controller/leaseHeartbeat.test.ts > /tmp/t4-green.txt 2>&1; echo "RC=$?" >> /tmp/t4-green.txt
cat /tmp/t4-green.txt
```

期望 `24 passed`（原 22 ＋ N3 ＋ N4），`RC=0`。

- [ ] **Step 5: 变异证明 M4／M5（副本）**

| | 怎么变 | 期望 |
|---|---|---|
| M4 | 删掉 `runAffirm` 里新增的那一支 | N3 红（事件不出现）；N4 也会红 |
| M5 | 去掉 `unattributableLockRecorded` 的判断（每次都记） | **N4 红**（条数 > 1），N3 仍绿 |

M5 是关键的一条：它证明 N4 钉的确实是「只记一次」而不是「记了」。
还原证明 ＋ `/bin/rm -rf` 副本。

- [ ] **Step 6: 提交**

```bash
git add src/controller/leaseHeartbeat.ts tests/controller/leaseHeartbeat.test.ts
git commit -F - <<'MSG'
fix(leaseHeartbeat): stop retrying a lock that can never clear in silence (I-3(a), human rulings 112/113)

Both swallows predate the class they were swallowing. runAffirm's comment calls
what it drops "transient"; this one is the opposite of transient -- nothing holds
the lock, so no tick will ever find it cleared, and the heartbeat retried it for
the life of the run with nobody told. stop()'s swallow is deliberate and stays,
byte for byte.

Neither tick behaviour nor the release contract changes. A run leaves at most one
of these events, however many times it hits the lock: the flag is shared.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 5: 收尾 —— 全量实测、台账、handoff

**Files:**
- Create: `.superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md` 的**新一节 §42**（⚠️ 该目录 `.gitignore` 内容是 `*`，**必须 `git add -f`**）
- Modify: `docs/handoff/handoff.md`（活文档，可整篇重写）

- [ ] **Step 1: 全量实测（未过滤整份读回）**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
rtk proxy npm test -- --run > /tmp/t5-all.txt 2>&1; echo "TEST_RC=$?" >> /tmp/t5-all.txt
rtk proxy npm run typecheck > /tmp/t5-tc.txt 2>&1; echo "TYPECHECK_RC=$?" >> /tmp/t5-tc.txt
rtk proxy npm run build > /tmp/t5-bd.txt 2>&1; echo "BUILD_RC=$?" >> /tmp/t5-bd.txt
cat /tmp/t5-all.txt; cat /tmp/t5-tc.txt; cat /tmp/t5-bd.txt
```

期望：`35 files / 613 tests` 全绿零 skipped（609 ＋ N1／N2／N3／N4），三个 RC 全 0。
**核 vitest 第一行 `RUN` 指向的路径确实是本仓库。**

- [ ] **Step 2: 现测红线函数字节数（改名/改行后必须重测）**

```bash
python3 - <<'PY'
p='src/persistence/fileStore.ts'
ls=open(p).read().splitlines(keepends=True)
sig=[i for i,l in enumerate(ls,1) if 'async function tryRecoverStaleOwnerTransferLock' in l]
assert len(sig)==1, sig
start=sig[0]; depth=0; started=False; end=None
for i in range(start-1,len(ls)):
    for ch in ls[i]:
        if ch=='{': depth+=1; started=True
        elif ch=='}':
            depth-=1
            if started and depth==0: end=i+1; break
    if end: break
print('lines', start, end, 'bytes', sum(len(x.encode()) for x in ls[start-1:end]))
PY
```

**报数必须连口径**：`src/persistence/fileStore.ts` 的整行范围、含末尾换行。

- [ ] **Step 3: 写台账 §42**

必须写进去的：人裁 109／111／112／113／114／115 的**原话**；四条改写判据的**逐条清单**；六条变异（M1–M7）的**实测结果**；那条未量前提**在 Task 3 Step 2 量到了什么**；本轮的判据基线 613；红线函数字节数连口径。
⚠️ **§40／§41 一个字不改**，本节只做新增。

- [ ] **Step 4: 重写 handoff**

`docs/handoff/handoff.md` 是活文档，整篇重写。**不写任何当前哈希**（提交 handoff 本身就会改 HEAD），引提交主题行与路径。把已作废的基线（609）逐条替换为现测值，并把「已知 flake 4 条」原样带下去。

- [ ] **Step 5: 收尾核远端**

```bash
git ls-remote origin refs/heads/main   # 【必须】再核一次 —— 人会自己推远端
git log --oneline -8
git status --porcelain > /tmp/st-end.txt; wc -c < /tmp/st-end.txt
```

- [ ] **Step 6: 提交**

```bash
git add -f .superpowers/sdd/2026-08-07-pkg2-data-loss/progress.md
git add docs/handoff/handoff.md
git commit -F - <<'MSG'
docs(sdd): record section 42 -- I-3(a) and the two heartbeat swallows, and what the unmeasured premise turned out to be

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
```

- [ ] **Step 7: 报给人**

报：判据基线（现测）、三个 RC、六条变异各自的实测结果、那条前提的实测答案、成本（**只报工具给出的数**）、以及**仍然挂账的四件**（`leaseHeartbeat` 已在本轮清掉 ⇒ 剩 I-3(a) 之外的：E1 的 I-2、Linux、人裁 85、以及本轮这几笔要不要再派评审）。
**不许替人宣布收口** —— 要不要派评审是人的事。

---

## 执行后更正（**上文一字未改**）

本计划已按 Task 1–5 执行完毕。执行中有四处与上文不符，**上文保留原样**（它记录了当时的判断），实际以本节为准：

1. **Task 4 的事件类型换了。** 上文所有代码块里的 `owner_transfer_contended`（心跳那两处）实际用的是
   **`owner_transfer_lock_unattributable`**。原因：复用共享类型**实测打红两条在数该类型的判据**，
   其中一条是人裁 106 立的既有判据。**人裁 119** 定了新类型，既有判据一字未动。
   ⇒ Task 4 的 N3／N4 也数新类型。
2. **Task 3 Step 2 的判别方式不足。** 上文说「红在 `not.toBe("failed")` 就证明前提成立」。
   实际 N1 的事件断言排在前面会**先短路**，红的位置区分不了。真正的度量靠副本里一条**定向探针**
   （把 `finalState.status` 打印出来）：`MEASURED_STATUS= failed`。**前提成立，但不是靠红的位置证明的。**
3. **M8 没红。** `writeOwnedRunState` 那一行没有判据承重。**人裁 118**：留着 ＋ 注释写明理由是继承来的。
4. **Task 1 多做了两件计划没预见的**：`:816` 那条判据里人裁 104 的 ERRATUM 有两处计数会被改写变成假话
   ⇒ 追加具名 ERRATUM；第三条判据走 `vi.resetModules()` ＋ 动态 import ⇒ `toBeInstanceOf` 必须用
   **动态模块实例上的类**，否则会因类身份不同而失败。

**落地实测**：`35 files / 613 tests` 全绿零 skipped，三个 RC 全 0。详见台账 §42。

---

## 第二次更正（独立评审之后，人裁 124；**上文包括第一节更正在内一字未改**）

独立评审（报告在 `.superpowers/sdd/2026-08-07-pkg2-data-loss/i3a-review.md`）之后，本计划又查出两处不准，
**控制器逐条自己复跑过**，不是照收自陈：

5. **Step 5 的 M5 预期方向写窄了。** 上文预测 M5（去掉去重标志）⇒「**N4 红**（条数 > 1），N3 仍绿」。
   实测 **N3 与 N4 都红**（N3 的 fixture 也走了两次 tick）。台账 §42 的记法（「计数变 2 与 7」）是准的，
   **只有计划正文这一句不准**，而第一节更正没收进来。
6. **Task 4 的判据没有覆盖 `stop()` 那一支。** 上文让 N4 一条同时承担「多次 tick」与「stop() 也不重复记」，
   实际 N4 到 `stop()` 时共享标志**已经是 `true`**，分支体从未执行 ⇒ **删掉整个 `stop()` 记录分支，全套照绿**
   （评审员实测，控制器复跑证实：唯一红的是已知 flake，单跑该文件全绿）。人裁 124 补了一条新判据把它钉住，
   并**断言 detail 而不只是类型**（`lease release blocked` vs `lease affirm blocked`），否则先记一条的 affirm
   会让它为错误的理由变绿。

⇒ **方法论（与第一节第 2 条同源，方向相反）**：*** 「没跑过的那条变异」也不是证据。 ***
本轮八条变异看着完备，是因为每条新增分支都有一条以它命名的变异 —— 唯独 `stop()` 那一支只被**别的分支的变异**
间接掠过。**下一轮的机械检查：每新增一个分支，点名那条删掉【它自己】的变异，并确认它存在。**
