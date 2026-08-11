# 实施报告 —— `release()` 身份校验 ＋ 守护判据（人裁 62/63）

> 骨架先落盘，逐节填。结论一节最先写。

## 0. 结论

**做完了，没有触红线，没有 BLOCKED。** 提交 `061d590`（分支 `feat/pkg2-release-guard`，基点 `d872532`）。

1. **人裁 62 的三件事全部落地**：`release()` 加了身份校验；校验不通过时**不删、不抛、记一条
   `owner_transfer_lock_release_skipped` 事件**；**守护判据同时补上**（2 条 `it()`，一条打正面那一格，
   一条是必命中对照臂）。
2. **事件通道是既有的，不是新造的**（红线 2 已核）：`appendEvent(runDir, event)` 就在
   `src/persistence/fileStore.ts:86`，`runDir` 在 `acquireOwnerTransferLock` 的闭包里本来就有。
   **没有新参数、没有新全局、没有新文件、没有改 `RunEvent` 类型**（它的 `type` 本来就是 `string`）。
3. **`tryRecoverStaleOwnerTransferLock` 一个字节没动**（红线 1）。`acquireOwnerTransferLock` 的
   **取锁路径也一个字节没动** —— 校验用的是取锁时本来就一直开着的那个 handle，
   **发布前不多一次 I/O、发布与 `return` 之间不多一条语句**（这是 Imp-1 那个形状，刻意避开）。
4. **没有任何既有断言被改动，也没有任何既有判据变红**（红线 3 未触发）。
5. **反向对照做了三次变异，三次都红在断言上**（不是异常、不是超时），真实 `Received` 见 §4：
   - 变异 A（把修复退回无条件 `safeUnlink`）⇒ 正面那条红，`lock: "GONE"` / `events: []`；
   - 变异 B（换成旧原型的 `pid:<pid>` 判据）⇒ **同一条同样红** ⇒ 证明 §3 的判据选择是承重的，不是口头的；
   - 变异 C（让校验恒返回 false）⇒ **对照臂**红 ⇒ 证明对照臂是活探针，不是摆设。
6. **收口三跑**：`TEST_EXIT=0` ／ `TSC_EXIT=0` ／ `BUILD_EXIT=0`，
   `RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard`（**本 worktree**）。
   `Test Files 31 passed (31)` ／ `Tests 535 passed (535)`，无 skipped
   ＝ **基线 533 ＋ 我新增的 2**，**没有任何文件条数下降**（`fileStore.test.ts` 82 → 84，其余不变）。
7. **变异全部在 `git archive` 副本里做，worktree 从未被变异**；还原证明：
   `git diff` = **0 字节**、`git diff --cached` = **0 字节**（§7）。

⚠️ **必须和结论一起看的两件事**（详见 §6）：
- 这个校验**缩小了窗口但没有消灭 TOCTOU** —— `stat` 与 `unlink` 仍是两次 syscall，
  夹在它们之间的夺锁**测不出来**；inode 号在删除后也会被复用。**这两格我没有覆盖，也没有判据钉住。**
- 我**没有**跑双真进程探针复测 §6.1 的原始复现；**我的证据面是单元判据 ＋ 三次变异**，不是进程级实测。

## 1. 改了什么（逐字）

提交 `061d590`：`src/persistence/fileStore.ts` ＋68/−3，`tests/persistence/fileStore.test.ts` ＋133/−0。

**(1) `release()` 本身**（`acquireOwnerTransferLock` 内，改前 3 行 → 改后）：

```ts
      return {
        release: async () => {
          // Before the close, because the check is an fstat on this handle and a closed handle
          // cannot answer it. The close itself keeps its original position ahead of the unlink.
          const stillOurs = await lockPathStillHoldsPublishedInode(handle, lockPath);
          await handle.close();

          if (!stillOurs) {
            await recordSkippedForeignLockRelease(runDir);
            return;
          }

          await safeUnlink(lockPath);
        },
      };
```

**(2) 两个新函数**（放在 `discardLockStaging` 之后、`acquireOwnerTransferLock` 的承重注释之前）：

```ts
async function lockPathStillHoldsPublishedInode(handle: FileHandle, lockPath: string): Promise<boolean> {
  try {
    const published = await handle.stat();
    const onDisk = await stat(lockPath);
    return onDisk.dev === published.dev && onDisk.ino === published.ino;
  } catch {
    return false;
  }
}

async function recordSkippedForeignLockRelease(runDir: string): Promise<void> {
  try {
    await appendEvent(runDir, {
      type: "owner_transfer_lock_release_skipped",
      at: new Date().toISOString(),
      detail: `${OWNER_TRANSFER_LOCK_FILE} no longer holds the inode this process published; left in place`,
    });
  } catch {
    // see above
  }
}
```

**(3) import 一行**：`node:fs/promises` 的具名导入里加了 `stat`，并新增 `import type { FileHandle }`。

**(4) 一段承重注释的事实校正**：`acquireOwnerTransferLock` 头上那段 C-1 注释原文写着
「`release()` … deliberately unchanged … because the still-open half of C-1 lives there」——
这句话现在是**假的**，改成了「`release()` 不再是 unchanged，人裁 62 给了它身份校验；取锁路径仍然逐字节不变」。
这是清理我自己造成的不一致（Rule 3 允许的那一类），**没有顺手改任何别的注释或代码**。

**红线 4（不许把异常放出 `release()`）如何满足** —— 我新增的三步逐一说明：
- **读取**（`handle.stat()` ＋ `stat(lockPath)`）：整段包在 `try { } catch { return false; }` 里，
  任何 errno（EBADF／ENOENT／EACCES／ESTALE…）都收敛成 `false` ＝「不是我的，不删」。
- **解析**：**没有解析步骤** —— 这是选 inode 判据的副产品（§2），少一类可抛的地方。
- **记事件**：`appendEvent` 包在 `try { } catch { }` 里，与本文件 `writeBoundaryArtifacts` 中
  **既有的两处 `appendEvent` 同形同理由**（`fileStore.ts:603-611` / `621-636`）—— 是遵循惯例，不是新形状。

⇒ `release()` 唯一还能抛的语句仍然是**改动前就存在的那两条**：`handle.close()` 与 `safeUnlink(lockPath)`。
**我没有增加，也没有减少 `release()` 的可抛面**（`safeUnlink` 对非 ENOENT 仍然重抛，未动）。

*** ⚠️ 本段的数字是错的，人裁 64／评审 M-4 已更正；订正见 `release-guard-fixround-report.md` §3。
下面保留原文不删，只在此标明：正确答案是 **5 处**，不是 4 处。 ***

> ~~`release()` 的四个调用点~~ **全部在 `finally` 里**，都没动：`fileStore.ts` 的
> `recoverInterruptedOwnerTransfer`、`writeOwnerTransferArtifacts`、`claimOwnerRecordWithPrecondition`、
> `updateOwnerRecordWithPrecondition`。
> （⚠️ **对任务书 §2.4 的一处校正**：任务书说「两处 `finally`」，~~**现测是四处**~~ ——
> `pointB-design.md` §6.3 点名的是其中两处。这不改变任何结论，只是把数字更正过来。）

**订正后的事实**：**5 处**，全部形如 `} finally { await …release(); }`，
`fileStore.ts:546 / 1291 / 1346 / 1367 / 1418`。我上面漏掉的是 **546** ——
`preserveSuccessfulReconciliationIfNeeded` 经**同前缀兄弟符号**
`acquireOwnerTransferLockForReconciliation` 间接持锁的那条路径，
调用形式是 `acquisition.lock.release()` 而不是 `lock.release()`，我上一轮的检索面没盖到它。
**行为上无影响**（同样是单次 `finally` release，同样受新守卫保护），但数字是错的，照实订正。

## 2. §3 的设计决策 —— 我选了哪种身份判据，为什么够，同进程重入这一格的行为

### 2.1 我选的是：**本进程发布的那个 inode**（`dev` + `ino`），用取锁时本来就开着的 handle 做 fstat 拿到

不是 `holderProcessInstanceId`，不是锁记录里的任何字段，**不读锁文件的内容**。
比较的是「`lockPath` 这个名字现在指向的 inode」与「我当初 `link()` 上去的那个 inode」。

### 2.2 为什么它够

1. **它比 pid 判据严格更强，而且强的正是任务书点名的那一格**（见 2.3），代价是 0 ——
   handle 在锁的整个生命期里本来就开着（`release()` 里的 `handle.close()` 就是它），
   fstat 不需要新状态、不需要改记录格式。
2. **它比对的是「实际发布的东西」，不是「文件自称是谁」**。锁内容被截断、被改写、被伪造，
   在 inode 判据下统统直接落到「不是我的」，**不需要 parse 步骤**（少一类可抛点，见 §1 红线 4）。
3. **它和 (a) 原子发布的机制天然咬合**：每次取锁都 `buildAtomicTempPath` 出一个**唯一的** staging 文件再 `link`，
   所以**每一次成功取锁 = 一个互不相同的 inode**。这不是我新引入的性质，是 (a) 已经在库里的性质。
4. **它不碰任何既有契约**：`fileStore.ts:723-725` 那段承重注释明确写着
   「`pid:<pid>` 这个更弱的形态是对的，它唯一的消费者 `parsePid` 只用来探活、从不比对身份，**不要去统一它**」。
   inode 判据**完全在带外**，锁记录格式一字未改，`parsePid` 与 `tryRecoverStaleOwnerTransferLock` 都不受影响
   —— 这同时也是它能满足红线 1 的原因。

### 2.3 同进程重入这一格的行为（任务书要求正面回答）

**旧原型的 `holderProcessInstanceId === \`pid:${process.pid}\`` 在这一格是失效的**：
同一个进程先后取两把锁，两条记录里的 holder 值**逐字节相同**，
所以第一把锁的迟到 `release()` 会「校验通过」并删掉第二把锁 —— 正是任务书 §3 说的那格。

**inode 判据在这一格的行为是：拒绝删除，并记事件。** 因为第二次取锁 staging 的是另一个文件、另一个 inode。

**这不是我推理出来的，是判据钉住的**：守护判据里那把「外来锁」的内容**故意写成
`{ holderProcessInstanceId: "pid:<本进程 pid>" , ... }`** —— 也就是**同进程第二次取锁会写下的一模一样的记录**。
于是：
- 对**无条件删**（变异 A）：红；
- 对**pid 判据**（变异 B）：**同样红**（§4.2 有真实 `Received`）。

⇒ 这条判据**同时**是「不是自己那把锁」的判据**和**「同进程重入」的判据，
并且它**能杀掉旧原型**，不只是能杀掉今天的 bug。

### 2.4 它盖不住哪一格（明写，别让下一位以为这里是干净的）

1. *** **TOCTOU 仍在，只是窗口变窄。** *** `stat(lockPath)` 与 `safeUnlink(lockPath)` 是两次 syscall；
   若夺锁恰好落在这两步之间，我仍然会删掉别人的锁。Node 没有「按 inode 删除」的原语
   （没有 `funlinkat` 之类的绑定），**这一格在纯 Node 里我给不出解**，也**没有为它加判据**。
2. *** **inode 号复用。** *** 我的锁被删、别的文件恰好拿到同一个 `ino`（且同 `dev`）时，判据会误判为「是我的」。
   实践上要求删除＋新建＋号复用在同一个 runDir 的同一瞬间发生，**但我没有测它，也没有钉它。**
3. **跨设备/网络文件系统**：判据依赖 `dev`+`ino` 在同一挂载点内唯一。目标平台是 darwin／linux 本地盘
   （`package.json` 的 `"os": ["darwin","linux"]`），**NFS 之类我没有验**。
4. **`handle.close()` 之后 `unlink` 之前进程被 SIGKILL**：锁会留在盘上 —— 这与改动前完全一样，
   属于待裁点 C（逃生口）的地界，**本次没有触碰**。

## 3. 新增的守护判据

位置：`tests/persistence/fileStore.test.ts`，新 `describe`
**`the owner-transfer lock's release only deletes the lock this process published`**，2 条 `it()`：

1. **`leaves a lock it no longer owns on disk, records the refusal, and never throws out of the finally`**
   —— 人裁 62 点名的那一格。
2. **`still deletes the lock, and records nothing, when the lock is the one this process published`**
   —— **必命中对照臂**。

### 3.1 怎么造出「要删的锁不是自己那把」

**没有给源码加任何 `export`，没有碰生产代码，没有碰文件顶部那个共享的 `vi.mock` 工厂。**
用的是本文件既有的 **局部 `vi.doMock("node:fs/promises", …) ＋ 动态 import** 缝
（crash-gap 矩阵、双读者竞态、staging-unlink 故障注入三处都用这条缝）。

`claimOwnerRecordWithPrecondition` 的锁临界区里最后一次写是
`rename(<ownerTempPath>, <runDir>/owner-record.json)`。缝在这次 `rename` **resolve 的瞬间**
把锁文件 `unlink` 掉再写一把**别人的锁**上去 —— 此时本进程仍然以为自己持锁，
紧接着 `finally` 就跑 `release()`。**这是对「锁已被夺走并被对方重建」最直接的模拟。**

### 3.2 断言了什么（人裁 62 的三件事一次断完）

```ts
    expect(thefts).toBe(1);   // 反空转：缝一旦不再开火，下面全部会永远绿

    expect({ outcome, lock: await readLockOrGone(lockPath), events: await readEventTypes(runDir) }).toEqual({
      outcome: "completed",                          // 不抛（release() 在 finally 里）
      lock: FOREIGN_LOCK_CONTENTS,                   // 不删：别人的锁原样还在盘上
      events: ["owner_transfer_lock_release_skipped"], // 记事件
    });

    expect((await readOwnerRecord(runDir)).currentProcessInstanceId).toBe("pid:222"); // 本次调用自己的效果没被牺牲
```

**三件事写在同一个 `toEqual` 里是刻意的**：只满足其中一两件的实现会在这里红，
而且红的时候 `Received` 一次把三件事的实际值都摊开（§4 的输出就是这样）。

**新判据全部红在断言上**，不靠异常、不靠超时 —— 三次变异的失败行都是 `AssertionError`（§4）。
`outcome` 用 `.then(() => "completed", (e) => \`threw ${String(e)}\`)` 捕成**值**再断言，
就是为了「抛了」也表现为**断言失败**而不是测试进程死于 rejection（沿用本文件既有写法）。

### 3.3 对照臂为什么必须存在

只有第 1 条时，「`release()` 永远不删任何东西」也能让它绿。
第 2 条走**完全相同的机器、完全相同的缝**，只把 `steal` 关掉，断言
`lock: "GONE"` ＋ `events: []` ⇒ 把「一律拒绝」这类实现挡死。
**变异 C 证明这条臂确实会开火**（§4.3）。

## 4. 反向对照（变异 ⇒ 红；含真实 `Received`）

**三次变异全部在 `git archive HEAD` 出的副本里做**（副本目录
`…/scratchpad/mut`，`node_modules` 软链回 worktree），**worktree 从未被变异**（§7）。
只跑单文件 ⇒ 按任务书 §5，archive 副本足够（`cli.test.ts` 那条 scripted example run 不在这次运行里）。
每次变异前都**重新解包一份干净副本**，所以三次变异互不叠加。

### 4.0 未变异时（绿）

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard
 ✓ tests/persistence/fileStore.test.ts (84 tests | 82 skipped) 14ms
 Test Files  1 passed (1)
      Tests  2 passed | 82 skipped (84)
```
`EXIT=0`。

### 4.1 变异 A —— 把修复整段退回「无条件 `safeUnlink`」（`EXIT=1`）

变异内容：`release()` 恢复成改动前的两行 `await handle.close(); await safeUnlink(lockPath);`。

```
 ❯ tests/persistence/fileStore.test.ts (84 tests | 1 failed | 82 skipped) 21ms
   × the owner-transfer lock's release only deletes the lock this process published > leaves a lock it no longer owns on disk, records the refusal, and never throws out of the finally 15ms
     → expected { outcome: 'completed', …(2) } to deeply equal { outcome: 'completed', …(2) }

AssertionError: expected { outcome: 'completed', …(2) } to deeply equal { outcome: 'completed', …(2) }

- Expected
+ Received

  Object {
-   "events": Array [
-     "owner_transfer_lock_release_skipped",
-   ],
-   "lock": "{
-   \"holderProcessInstanceId\": \"pid:21913\",
-   \"acquiredAt\": \"2026-08-11T00:00:00.000Z\"
- }",
+   "events": Array [],
+   "lock": "GONE",
    "outcome": "completed",
  }

      Tests  1 failed | 1 passed | 82 skipped (84)
```

⇒ **`lock: "GONE"`** 就是「持锁者删掉了一把不属于它的锁」这件事本身，
**`events: []`** 是「没有任何痕迹」。这条判据**确实钉住了人裁 62 的那一格**。
（对照臂在这次变异下**仍然绿**：`1 passed` —— 变异 A 不该让它红，它也确实没红。）

### 4.2 变异 B —— 换成旧原型的 `pid:<pid>` 判据（`EXIT=1`）

变异内容（`pointB-design.md` §6.4 那个原型，逐字等价）：

```ts
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<OwnerTransferLockRecord>;
    return parsed.holderProcessInstanceId === `pid:${process.pid}`;
```

```
   × the owner-transfer lock's release only deletes the lock this process published > leaves a lock it no longer owns on disk, records the refusal, and never throws out of the finally 15ms
     → expected { outcome: 'completed', …(2) } to deeply equal { outcome: 'completed', …(2) }

- Expected
+ Received

  Object {
-   "events": Array [
-     "owner_transfer_lock_release_skipped",
-   ],
-   "lock": "{
-   \"holderProcessInstanceId\": \"pid:22774\",
-   \"acquiredAt\": \"2026-08-11T00:00:00.000Z\"
- }",
+   "events": Array [],
+   "lock": "GONE",
    "outcome": "completed",
  }

      Tests  1 failed | 1 passed | 82 skipped (84)
```

⇒ *** **这是 §2.3 那个设计决策的举证。** *** 装上一个「看起来也在做身份校验」的实现，
判据照样红、锁照样 `GONE` —— 因为盘上那把外来锁自称 `pid:<本进程 pid>`，pid 判据放行了它。
**§3 的选择不是口头偏好，它有一条会失败的判据在背后。**

### 4.3 变异 C —— 让校验恒为 `false`（`EXIT=1`），打的是**对照臂**

变异内容：`lockPathStillHoldsPublishedInode` 照常做两次 stat，然后 `return false;`
（保留两次 stat 是为了**只变判据、不变 I/O 形状**）。

```
   × the owner-transfer lock's release only deletes the lock this process published > still deletes the lock, and records nothing, when the lock is the one this process published 14ms
     → expected { thefts: +0, …(3) } to deeply equal { thefts: +0, …(3) }

- Expected
+ Received

  Object {
-   "events": Array [],
-   "lock": "GONE",
+   "events": Array [
+     "owner_transfer_lock_release_skipped",
+   ],
+   "lock": "{
+   \"holderProcessInstanceId\": \"pid:24500\",
+   \"acquiredAt\": \"2026-08-11T16:27:03.230Z\"
+ }",
    "outcome": "completed",
    "thefts": 0,
  }

      Tests  1 failed | 1 passed | 82 skipped (84)
```

⇒ **对照臂是活探针**：一个「一律拒绝」的实现会把自己的锁留在盘上（`lock` 是**本进程刚写的**那把，
`acquiredAt` 是运行时刻，不是 fixture 的 `00:00:00`），并且会记一条不该记的事件。
**没有这条臂，§4.1／§4.2 的绿也能由「release() 什么都不删」冒充。**

### 4.4 三次变异的共同性质

- 三次都是 **`AssertionError`**，没有一次是异常逃逸或超时（任务书 §4 第 1 条）；
- 三次都**只红 1 条**、另一条保持绿 ⇒ 两条判据**互相独立**，各打各的那一格；
- 三次的 `Received` 都直接读得出「盘上那把锁到底是谁的」，不需要看日志才能解释。

## 5. 收口三跑：退出码与 `RUN` 路径

全部在 worktree 内、`rtk proxy`、`ECC_GATEGUARD=off DISABLE_OMC=1`、**整份落盘整份读回，未过滤**。
日志：`…/scratchpad/logs/{full-suite-1,full-suite-2,typecheck-2,build-2}.log`。

### 5.1 收口那一跑（第二跑，`full-suite-2.log`）

| 命令 | 退出码 |
|---|---|
| `npm test -- --run` | *** **TEST_EXIT=0** *** |
| `npm run typecheck` | *** **TSC_EXIT=0** *** |
| `npm run build` | *** **BUILD_EXIT=0** *** |

vitest **首行 `RUN`**（逐字）：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard
```

⇒ **是本 worktree，不是主仓库根。**

```
 Test Files  31 passed (31)
      Tests  535 passed (535)
```

**无 skipped。** `535 = 533（任务书给的本轮基线）＋ 2（我新增）`。

### 5.2 第一跑（`full-suite-1.log`）：`TEST_EXIT=1`，唯一失败是名单内的 flake (B)

**不隐瞒，按完整测试名挂账**：

```
 FAIL  tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid
Error: Test timed out in 5000ms.
 Test Files  1 failed | 30 passed (31)
      Tests  1 failed | 534 passed (535)
```

⇒ 逐字命中任务书 §6 允许的 flake **(B)**；同一跑的 `TSC_EXIT=0` / `BUILD_EXIT=0`。
**这一跑的总数同样是 535**（534 passed ＋ 1 failed），第二跑同一条转绿 ⇒ 与我的改动无关。
**名单外的失败：零条。**

### 5.3 条数核对（任何文件下降都要解释）

- 总数：533 → **535**，＋2 ＝ 我新增的两条 `it()`；
- `tests/persistence/fileStore.test.ts`：**82 → 84**，**两头都是实测，不是推算**：
  - 基线 82 —— 在 `git archive d872532` 的副本里单跑该文件（`…/logs/baseline-filestore.log`）：
    ```
     ✓ tests/persistence/fileStore.test.ts (82 tests) 1439ms
     Test Files  1 passed (1)
          Tests  82 passed (82)
    ```
  - 现在 84 —— §4.0 与 §5.1 的 `84 tests` 逐字可见。
- 其余 30 个文件条数之和因此未变（535 − 84 = 451 = 533 − 82）；**没有任何文件条数下降**。

## 6. 我没有验到的（Rule 12）

**下面每一条都是「没验」，不是「验过没问题」。**

1. *** **没有跑双真进程探针。** *** `pointB-design.md` §6.1 那个复现（真进程 × 真取放锁）我**没有复测**，
   也没有在修复后重跑它证明那条链断了。我的全部证据是**单元判据 ＋ 三次变异**，
   模拟夺锁用的是测试缝里的 `unlink`＋`writeFile`，不是第二个进程。
2. *** **没有验 TOCTOU 那一格。** *** `stat` 与 `unlink` 之间被夺锁 ⇒ 仍然会误删。**没测、没判据、没修。**
3. *** **没有验 inode 号复用。** *** 我的锁被删后别的文件拿到同一 `ino` ⇒ 判据会误判为「是我的」。**没测。**
4. **没有验 NFS／跨文件系统**上 `dev`+`ino` 的行为，只在本机 darwin 上跑过。
5. **没有验 `handle.stat()` 在异常文件系统状态下的 errno 谱** —— 我把**所有** errno 一律收敛成
   「不是我的」。这在语义上是保守的（宁可不删），但**「读不出锁」与「锁真的不是我的」在事件里被写成了同一条**，
   `detail` 不区分二者。**这是我的取舍，没有人裁过。**
6. **没有验「事件被谁消费」**。`owner_transfer_lock_release_skipped` 只落在 `events.jsonl`，
   我**没有**把它接进 sweep 的 stderr note（`reconciliation_write_abandoned` 有那条通路），
   也**没有**接进 `runLoop` 的任何判断 —— 任务书只要求「记一条事件」，接线属于新决策，**我没有做，也没有测**。
7. **没有验并发下 `release()` 之间的相互影响**（同进程多个锁生命期交叠），
   §2.3 那格是**用 fixture 内容模拟**的，不是真的先后取两把锁跑出来的。
8. **没有跑 `npm run lint`／格式检查** —— 收口清单只列了三条命令，我只跑了那三条。
9. **没有动 `progress.md`**（连 worktree 里的副本也没动）。台账每一节都是控制器／人裁的编号体系，
   我不去抢那个编号；**这一笔的落账由控制器决定**。
10. **没有 push、没有合并、没有建删分支或 worktree、没有碰主仓库与其它 worktree。**

## 7. 变异与还原证明

**变异从未落在 worktree 里。** 流程逐条：

1. 先把修复提交成 `061d590`；
2. `git archive HEAD | tar -x -C <scratchpad>/mut`，再把 `node_modules` 软链回 worktree；
3. 在**副本**里用 `python3` 做替换，脚本带 `assert <anchor> in s`（锚点找不到就直接失败，
   避免「以为变异了其实没变」这种假红/假绿）；
4. 只在副本里跑单文件 vitest；
5. 每次变异前 `rm -rf mut` 重新解包 ⇒ 三次变异互不叠加；
6. 全部跑完 `rm -rf mut`。

**还原证明（在 worktree 内，跑在三次变异全部结束之后）**：

```
git diff bytes:        0
git diff --cached bytes:        0
```

`git status --short` 只剩两个 untracked 的文档：

```
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/release-guard-impl-brief.md
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/release-guard-impl-report.md
```

（前者是控制器给我的任务书，后者是本报告；**源码与测试的工作区是干净的，全部内容都在 `061d590` 里**。）

⚠️ **一处必须说明的偏差**：§4 的三次变异跑的是 `npx vitest run tests/persistence/fileStore.test.ts -t …`，
**不是全套件** —— 按任务书 §5 的注记，`git archive` 副本没有 `.git`，跑全套件会让 `cli.test.ts` 那条
scripted example run 假红；单文件/探针用 archive 副本是被允许的。
**我没有在副本里跑过全套件，也没有做 `git clone --local` 那条路。**

## 8. 可数事实

**不自报预算估计，只列可数的。**

| 事项 | 数 |
|---|---|
| 全套件跑（`npm test -- --run`，worktree 内，未过滤） | **2** 次（第 1 次 `TEST_EXIT=1` = flake (B)；第 2 次 `TEST_EXIT=0`） |
| `npm run typecheck` | **2** 次（均 `0`） |
| `npm run build` | **2** 次（均 `0`） |
| 单文件定向跑（`fileStore.test.ts`） | **5** 次（1 次未变异绿 ＋ 3 次变异红 ＋ 1 次 d872532 基线计数） |
| 变异 | **3** 个（A 无条件删／B pid 判据／C 恒拒绝），全部在 `git archive` 副本里 |
| 变异脚本带断言锚点 | **3/3**（锚点找不到即失败） |
| worktree 内做过的变异 | **0** |
| 新增 `it()` | **2**（1 条正面格 ＋ 1 条必命中对照臂） |
| 被我改动的既有断言 | **0** |
| 被我改动的既有测试块 | **0** |
| 变红的既有判据 | **0** |
| 生产代码改动 | `src/persistence/fileStore.ts` **＋68 / −3**（含注释）；新函数 **2** 个；改动的 `import` 行 **1** ＋ 新增 type import **1** |
| 测试代码改动 | `tests/persistence/fileStore.test.ts` **＋133 / −0** |
| `tryRecoverStaleOwnerTransferLock` 改动 | **0 字节** |
| `acquireOwnerTransferLock` 取锁路径（`open`→`writeFile`→`link`→`discardLockStaging`）改动 | **0 字节** |
| 新造的事件通道 | **0**（用既有 `appendEvent`，`fileStore.ts:86`） |
| 新增的事件类型 | **1**：`owner_transfer_lock_release_skipped` |
| 为测试给源码加的 `export` | **0** |
| 本地提交 | **1**（`061d590`） |
| push／合并／建删分支或 worktree／碰主仓库 | **0** |
| 落盘的验证日志 | **10** 份：`new-tests-green` / `full-suite-1` / `typecheck-1` / `build-1` / `mutA` / `mutB` / `mutC` / `full-suite-2` / `typecheck-2` / `build-2`（`…/scratchpad/logs/`，均整份落盘、整份读回） |

⚠️ **日志目录在 scratchpad 里，不在仓库里** —— 它**不随分支走**，
评审员要复现请照 §4／§5 的命令重跑（每条命令与参数都在报告里写全了）。
