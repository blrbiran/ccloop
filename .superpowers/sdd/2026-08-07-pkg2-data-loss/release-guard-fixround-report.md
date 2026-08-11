# 修复环报告 —— 人裁 64（M-5 / M-2 / M-4）

> 骨架先落盘，逐节填。结论一节最先写。
> 本文件**不覆盖** `release-guard-impl-report.md`，那份留作上一轮的记录。

## 0. 结论

**人裁 64 批的三条全部做完，挂账的两条一个字没动。** 提交 `4f18190`（分支 `feat/pkg2-release-guard`，基点 `0a76c79`）。

1. **M-5（最重要）—— 存活变异现在死了。** 补了 2 条判据把 `dev` 那一半钉住。
   **反向对照**：施加评审员的变异 F（去掉 `dev` 只比 `ino`）后，新判据**红在断言上**，
   真实 `Received` 是 `lockKept: false` / `events: []`（§4.1）。
   *** **我没有造跨文件系统 fixture，也没有造恒绿判据 —— 我把 `dev` 注入进去了。** ***
   这是本轮唯一需要人过目的取舍，正面写在 §1.2：判据钉住的是**比较逻辑**
   （「inode 号相同但 device 不同的文件，必须拒删」），**不是**「内核/挂载能不能造出这个状态」。
2. **M-2 —— 假陈述已消除。** verdict 从 boolean 改成四值（`ours`／`gone`／`foreign`／`unverified`），
   三条 detail 各自只陈述本分支为真的事。**「这一格要不要记事件」这个语义我没有改，理由先写在 §2.1**：
   人裁 62 的原文「含读不出」就是这一格，且「我持锁期间锁凭空消失」本身就值一条审计线。
   反向对照：把 `gone` 那条 detail 改回旧的单句 ⇒ 新判据红，`Received` 里逐字出现
   `left in place`（§4.2）。
3. **M-4 —— 数字已改，并且我自己独立复核过**：`fileStore.ts` 承重注释 `four` → `five`，
   并写明第 5 处是经同前缀兄弟 `acquireOwnerTransferLockForReconciliation` 那条。
   **上一轮报告里同一处口径也已订正**（`release-guard-impl-report.md` §1 尾部，原文保留 ＋ 明标错误）。
4. **M-1 / M-3 逐字节未动**（§6 列了我为确认「没动」而做的检查）。
5. **红线全部保持**：`tryRecoverStaleOwnerTransferLock` 与取锁路径**逐字节未动**（§6.3 有 diff hunk 证据）；
   **没有改任何既有断言**（测试文件本轮 `214 增 / 0 删`，纯追加）。
6. **收口三跑**：`TEST_EXIT=0` ／ `TSC_EXIT=0` ／ `BUILD_EXIT=0`，
   `RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard`（本 worktree）。
   `Test Files 31 passed (31)` ／ `Tests 538 passed (538)`，无 skipped ＝ **基线 535 ＋ 新增 3**。
   **本轮一次都没有遇到 flake**（(B) 与 (F) 都没出现），无需动用 flake 名单。
7. **三次变异全部在 `git archive` 副本里做**，worktree 从未被变异；
   `git diff` = **0 字节**、`git diff --cached` = **0 字节**（§8）。

⚠️ **一句话给下一位评审员**：本轮最该撞的是 §1.2 那个取舍 ——
**注入 `dev` 是不是一条合法的判据**。我认为是（它能杀死变异 F，且不依赖环境），
但它确实不等于真跨设备实测，**这一点我写在正文里，不藏在脚注**。

## 1. M-5 —— `dev` 那一半的守护判据

### 1.1 我先复核了 finding 本身（不是照单收下）

评审员的变异 F ＝ 把 `onDisk.dev === published.dev && onDisk.ino === published.ino` 改成只比 `ino`，
535 条全绿。**我重跑了这个变异**（在本轮新判据加入**之前**的那份代码上，即 `0a76c79`），
结论一致：`dev` 那一半当时零覆盖。**M-5 成立，不是误报。**

### 1.2 *** 我怎么造出「同 `ino` 不同 `dev`」—— 正面写，这是本轮唯一的取舍 ***

**没有挂第二个文件系统。** 单机上无法让两个文件在不同 device 上拿到同一个 `ino`
（那要求两个真实挂载点，且 inode 号恰好撞上），
**而任务书明令：造不出来就停下上报，不许造恒绿判据充数。**

我选的是第三条路：**注入 device 号**，用的是本文件既有的局部 `vi.doMock` 缝
（与仓库既有的 EACCES 故障注入同一条缝、同一种手法）：

```ts
        stat: async (path: string) => {
          const real = await actual.stat(path);
          if (path !== lockPath) { return real; }
          shifted += 1;
          const relocated = Object.assign(Object.create(Object.getPrototypeOf(real) as object), real) as typeof real;
          relocated.dev = real.dev + devShift;
          return relocated;
        },
```

返回的对象**保留真实 Stats 的原型与全部真实字段**，只有 `dev` 移动一位，`ino` 原样不动。

*** **这条判据钉住的是什么，说清楚**：给定一个「inode 号相同、device 不同」的盘上文件，
`release()` **必须拒删**。它钉的是**比较逻辑**。 ***
*** **它不钉什么**：它**不**证明「哪种内核／挂载组合能真的产出这个状态」，
也**不**替代真跨设备实测。这一点也写在测试正文的注释里，不只写在报告里。 ***

**为什么我认为这仍然是一条合法判据、而不是恒绿判据充数**：
- 它**能杀死变异 F**（§4.1 有真实 `Received`）—— 恒绿判据做不到这一点；
- 它**不依赖环境**（不需要 root、不需要 hdiutil／loop device、在 CI 上行为一致），
  因此不会变成一条时红时绿的环境噪声；
- 它配了**必命中对照臂**（下条），所以「拒删」不是因为 wrapper 本身把事情搞坏了。

### 1.3 两条判据（`tests/persistence/fileStore.test.ts`，纯追加）

新 `describe`：**`the owner-transfer lock's release compares the device as well as the inode number`**

| # | `it()` | 作用 |
|---|---|---|
| 1 | `refuses to delete a lock whose inode number matches but whose device does not` | 正面格：`devShift = 1` ⇒ 断言 `lockKept: true` ＋ 记事件 |
| 2 | `still deletes its own lock when the same wrapper leaves the device alone` | **必命中对照臂**：`devShift = 0`，**同一个 wrapper、同样多跑一次 stat** ⇒ 断言 `lockKept: false` ＋ 无事件 |

两条都带**反空转断言** `expect(shifted).toBe(1)` —— 注入一旦不再命中 lockPath，
断言立刻失败，而不是让后面的判据在一个从未被搬动过的文件上「通过」。

**对照臂本身是活的吗？** 是，实测：变异 C2（verdict 恒为 `foreign`，即一律拒删）
在本文件内打挂 **27 条**，**其中就包括这条新对照臂**（§4.3）。

## 2. M-2 —— ENOENT 那一格的假陈述

### 2.1 *** 先说语义：这一格**该不该**记事件 —— 我的判断是「该记」，所以只改措辞、不改语义 ***

任务书要求：若我认为该格根本不该记事件，**先说理由再改，不许默默换语义**。我的判断与三条理由：

1. **人裁 62 的原文覆盖了这一格**：「校验不通过（**含读不出／解析不出**）时：不删、不抛、**记一条事件**」。
   ENOENT 就是「读不出」。**取消这一格的事件＝改人裁过的行为**，不在我的授权内。
2. **它本身就值一条审计线**：我持锁期间锁凭空消失，意味着**有东西删掉了一个活持有者的锁** ——
   这正是 C-1 那一类损害的形状。把它改回静默，等于把一条真实信号扔掉。
3. **评审员自己也没有主张取消**：M-2 的措辞是「detail 是错的」，§2 的建议是
   「把 detail 拆成两种措辞，或删掉 `left in place` 这半句」，**不是**「别记事件」。

⇒ **本轮只改措辞，不改「是否记录」。**

### 2.2 改法：boolean → 四值 verdict，三条 detail 各自只说本分支为真的话

```ts
type LockReleaseVerdict = "ours" | "gone" | "foreign" | "unverified";

async function classifyLockAtRelease(handle: FileHandle, lockPath: string): Promise<LockReleaseVerdict> {
  try {
    const published = await handle.stat();
    const onDisk = await stat(lockPath);

    return onDisk.dev === published.dev && onDisk.ino === published.ino ? "ours" : "foreign";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unverified";
  }
}

const SKIPPED_RELEASE_DETAILS: Record<Exclude<LockReleaseVerdict, "ours">, string> = {
  gone: `${OWNER_TRANSFER_LOCK_FILE} was already off disk at release; nothing was deleted`,
  foreign: `${OWNER_TRANSFER_LOCK_FILE} no longer holds the inode this process published; it was left in place`,
  unverified: `${OWNER_TRANSFER_LOCK_FILE} could not be checked against the inode this process published; nothing was deleted`,
};
```

**为什么是三条而不是两条**（这一点请评审员盯一下，因为它擦到 M-3 的边）：
`catch` 不只会被 ENOENT 进入。若我只分「ENOENT ／ 其它」两类，
那么 `handle.stat()` 抛 EBADF 的那一格（＝ M-3 说的二次 release）会落进 `foreign` 的措辞
「no longer holds the inode this process published; **it was left in place**」——
**那又是一句假话**（那一格锁其实已经被第一次 release 删掉了）。
所以第三条 `unverified` 是**为了不再制造新的假陈述**而存在的，不是防御性编程。

*** **M-3 的行为我一点没改**：二次 release **仍然**会记一条事件（评审员说的「虚假事件」照旧存在，
照旧挂账）。我只让那条事件不再说假话。 ***

⇒ 三条 detail 共同为真的那半句是 **"nothing was deleted"**，这也是这条事件真正要传达的东西：
**这次 release 没有删掉任何文件。**

### 2.3 判据（1 条，纯追加）

新 `describe`：**`the owner-transfer lock's release reports a vanished lock as vanished, not as left in place`**
＋ `it("records that nothing was deleted, and never claims the lock was left in place")`。

用同一条 doMock 缝，在临界区里**只删锁、不补新锁** ⇒ `release()` 撞上 ENOENT。
断言**整条事件对象**（`type` ＋ `detail`，`at` 用 `expect.any(String)`），
并带**双重反空转**：`removals === 1` 且 `lockPresent === false`
—— 证明锁确实被删了、确实处在 ENOENT 那一格，而不是判据在别的分支上蒙对。

## 3. M-4 —— 「four `finally`」的数字

### 3.1 我自己独立复核了这个数字（没有照抄评审员的表）

```
$ grep -n "release()\|\.release()\|lock.release" src/persistence/fileStore.ts
src/persistence/fileStore.ts:546:      await acquisition.lock.release();
src/persistence/fileStore.ts:1291:      await lock.release();
src/persistence/fileStore.ts:1346:    await lock.release();
src/persistence/fileStore.ts:1367:    await lock.release();
src/persistence/fileStore.ts:1418:    await lock.release();
```

并逐一读了上下文确认都在 `finally` 内 —— 其中 546 逐字如下（`preserveSuccessfulReconciliationIfNeeded`）：

```
544	    return decision;
545	  } finally {
546	    await acquisition.lock.release();
547	  }
```

⇒ **5 处，评审员的 M-4 属实。**

**我上一轮为什么漏了 546**：我当时按 `lock.release()` 这个形状去找，
而 546 的调用形式是 `acquisition.lock.release()`，且它经由**同前缀兄弟符号**
`acquireOwnerTransferLockForReconciliation` 取锁 —— 正是本仓库反复踩的那个盲区。
**这是我的检索面缺陷，不是评审员苛刻。**

### 3.2 改了哪两处口径

1. **代码注释**（`src/persistence/fileStore.ts`，承重注释）：

```
// MUST NOT THROW. release() is called from five `finally` blocks (the fifth reaches it through the
// same-prefix sibling acquireOwnerTransferLockForReconciliation), so a rejection here would replace
// whatever error is already in flight — ...
```

**顺带补了「第 5 处是怎么到达的」**，而不是只把 `four` 改成 `five` —— 因为 M-4 的伤害在于
「下一个评审员会按错误的调用面清单去核对」，只改数字不写路径，下一个人照样找不到第 5 处。

2. **上一轮的报告**（`release-guard-impl-report.md` §1 尾部）：原文**保留不删**，
   上方加醒目标注「本段数字是错的，正确答案是 5 处」，下方补订正事实与漏掉的原因。
   **没有偷偷改写历史。**

### 3.3 我顺带核对但**没有**发现问题的同类口径

- `fileStore.ts:557` 的 `four layers`（A8 §4.3 的回调分层）与 `:856` 的 `fourth`（marker 的第四类错误）
  **与 release 调用点无关**，未动。
- 本轮新报告与新注释里我**没有**再写任何未经 grep 复核的计数。

## 4. 反向对照（变异 ⇒ 红；含真实 `Received`）

三次变异**全部在 `git archive HEAD` 的干净副本里**做，每次**重新解包**（互不叠加），
`python3` 替换脚本带 `assert <anchor> in s`（锚点找不到即失败，杜绝「以为变异了其实没变」）。
只跑单文件 ⇒ 按纪律 archive 副本足够（不含 `cli.test.ts` 那条 scripted example run）。

### 4.1 *** 变异 F —— 评审员那条存活变异，现在死了 ***（`EXIT=1`）

变异：`return onDisk.dev === published.dev && onDisk.ino === published.ino ? "ours" : "foreign";`
⇒ `return onDisk.ino === published.ino ? "ours" : "foreign";`

```
 ❯ tests/persistence/fileStore.test.ts (87 tests | 1 failed) 2272ms
   × the owner-transfer lock's release compares the device as well as the inode number > refuses to delete a lock whose inode number matches but whose device does not 15ms
     → expected { outcome: 'completed', …(2) } to deeply equal { outcome: 'completed', …(2) }

AssertionError: expected { outcome: 'completed', …(2) } to deeply equal { outcome: 'completed', …(2) }

- Expected
+ Received

  Object {
-   "events": Array [
-     "owner_transfer_lock_release_skipped",
-   ],
-   "lockKept": true,
+   "events": Array [],
+   "lockKept": false,
    "outcome": "completed",
  }

      Tests  1 failed | 86 passed (87)
```

⇒ **红在断言上**（`AssertionError`，不是异常、不是超时）。
`lockKept: false` 就是「`dev` 不同、但因为没比 `dev`，锁被删了」这件事本身。
**评审员实测 535 全绿的那个变异，现在恰好挂 1 条，且是新增的那条。**
对照臂在这次变异下**保持绿**（`86 passed`）—— 变异 F 不该让它红，它也确实没红。

### 4.2 变异 G —— 把 `gone` 的 detail 改回旧的单句（`EXIT=1`）

```
 FAIL  tests/persistence/fileStore.test.ts > the owner-transfer lock's release reports a vanished lock as vanished, not as left in place > records that nothing was deleted, and never claims the lock was left in place
AssertionError: expected { outcome: 'completed', …(1) } to deeply equal { outcome: 'completed', …(1) }

- Expected
+ Received

  Object {
    "events": Array [
      Object {
        "at": Any<String>,
-       "detail": ".owner-transfer.lock was already off disk at release; nothing was deleted",
+       "detail": ".owner-transfer.lock no longer holds the inode this process published; left in place",
        "type": "owner_transfer_lock_release_skipped",
      },
    ],
    "outcome": "completed",
  }

      Tests  1 failed | 86 passed (87)
```

⇒ `Received` 里**逐字**出现那句假话 `left in place`，而此时盘上根本没有这个文件
（同一条判据的反空转断言已先证明 `lockPresent: false`）。**M-2 的修复现在有执行机制。**

### 4.3 变异 C2 —— verdict 恒为 `foreign`（一律拒删）（`EXIT=1`）

这条不是为了打正面格，是为了**证明新对照臂是活探针**。本文件内挂 **27 条**，其中：

```
   × the owner-transfer lock's release compares the device as well as the inode number > still deletes its own lock when the same wrapper leaves the device alone 4ms
   × the owner-transfer lock's release only deletes the lock this process published > still deletes the lock, and records nothing, when the lock is the one this process published 4ms
      Tests  27 failed | 60 passed (87)
```

⇒ **本轮新增的对照臂（第 1 行）确实会开火**，上一轮的对照臂（第 2 行）也照旧开火。
「过度拒删」这个反方向被既有测试厚重兜底（27 条里绝大多数是既有判据），
与评审员在全套件上测到的 76 条同向。

### 4.4 三次变异的共同性质

- 三次都是 **`AssertionError`**，没有一次靠异常或超时变红；
- 变异 F 与 G **各自只挂 1 条**，且正好是本轮为它们新增的那条 ⇒ 两条新判据**各自独立、各打各的格**；
- 变异 C2 挂 27 条 ⇒ 反方向有厚兜底，新判据不是把守卫改松就能绕过的。

## 5. 收口三跑：退出码与 `RUN` 路径

worktree 内、`rtk proxy`、`ECC_GATEGUARD=off DISABLE_OMC=1`、**整份落盘整份读回、未过滤**，
跑前工作树干净（`git diff` / `--cached` 均 0 字节，见 §8）。

| 命令 | 退出码 |
|---|---|
| `npm test -- --run` | *** **TEST_EXIT=0** *** |
| `npm run typecheck` | *** **TSC_EXIT=0** *** |
| `npm run build` | *** **BUILD_EXIT=0** *** |

vitest **首行 `RUN`**（逐字）：

```
 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard
```

⇒ **本 worktree**，不是主仓库根。

```
 Test Files  31 passed (31)
      Tests  538 passed (538)
```

**无 skipped。** `538 = 535（本轮基线）＋ 3（新增）`。

### 5.1 条数核对

- 总数 535 → **538**，＋3 ＝ 本轮 3 条新 `it()`（M-5 两条 ＋ M-2 一条）；
- `tests/persistence/fileStore.test.ts`：**84 → 87**（§4 各次运行里的 `87 tests` 逐字可见）；
- 其余 30 个文件之和未变（538 − 87 = 451 = 535 − 84）；**没有任何文件条数下降**。

### 5.2 flake

*** **本轮一次都没有遇到 flake。** *** 全套件跑了 1 次，一次过，
名单内的 (B)、(F) 都没有出现，名单外的失败**零条**。
（上一轮 (B) 出现过一次；本轮没有，**这不构成「(B) 已修复」的结论**，只是没撞上。）

## 6. 挂账未动的（M-1 / M-3）＋ 红线证据

### 6.1 M-1（`evidence.ts` 的 `allowedEventTypes` 白名单）—— **一个字节没动**

```
$ git diff --stat 0a76c79..HEAD -- validation/ src/controller/ src/registry/
（空）
```

⇒ `validation/v1/lib/evidence.ts` 与其它任何消费面**都不在本轮 diff 内**。
本轮**没有新增第二个事件类型**（仍然只有 `owner_transfer_lock_release_skipped` 这一个），
所以 M-1 的暴露面**既没扩大也没缩小**。

### 6.2 M-3（二次 release 的虚假事件）—— **行为一个字节没改**

二次 release 仍然：`handle.stat()` 抛 EBADF ⇒ 归入非 `ours` ⇒ **照旧记一条事件**。
**我没有加任何「已释放」标志位、没有加幂等保护、没有抑制这条事件。**

⚠️ **唯一的接触点，主动交代**：这条事件的 **detail 文案**变了 ——
从 `... left in place`（对这一格是假话）变成 `unverified` 分支的
`... could not be checked against the inode this process published; nothing was deleted`（对这一格为真）。
**这是 M-2 修复的必然外溢**（理由见 §2.2：只分两类就必然在这一格制造新的假陈述）。
**是否属于「动了 M-3」请控制器判**；我的判断是**不属于** ——
M-3 说的是「产生了一条不该产生的事件」，那条事件**照旧产生**，我只是让它不说假话。

### 6.3 红线证据（`0a76c79..HEAD`）

**src 侧全部改动只有 3 个 hunk，且仅此 3 个：**

```
@@ -982,18 +982,35 @@ async function discardLockStaging(...)          两个 helper（verdict 化）
@@ -1001,12 +1018,25 @@ async function lockPathStillHoldsPublishedInode(...)  详情表 ＋ 记事件函数
@@ -1090,11 +1120,11 @@ async function acquireOwnerTransferLock(...)     release 闭包内 4 行
```

第 3 个 hunk 的**全部内容**（逐字，只有这些）：

```diff
-          const stillOurs = await lockPathStillHoldsPublishedInode(handle, lockPath);
+          const verdict = await classifyLockAtRelease(handle, lockPath);
           await handle.close();
 
-          if (!stillOurs) {
-            await recordSkippedForeignLockRelease(runDir);
+          if (verdict !== "ours") {
+            await recordSkippedLockRelease(runDir, verdict);
```

⇒ `tryRecoverStaleOwnerTransferLock`（900–935）**不落在任何 hunk 内**。
**独立复核（不靠 hunk 推断）**：两个版本该区段的 `shasum` 相同 ——

```
2f40050e0941ebaf9b09969312280ae77915bb1c  -   （0a76c79 的 900-935 行）
2f40050e0941ebaf9b09969312280ae77915bb1c  -   （HEAD 的 900-935 行）
```

⇒ **逐字节一致，红线 1 成立。**
`acquireOwnerTransferLock` 的取锁路径（`open` → `writeFile` → `link` → `discardLockStaging`）
同样不落在任何 hunk 内 ⇒ **逐字节未动**。

### 6.4 既有断言零改动

```
$ git diff --numstat 0a76c79..HEAD
42	12	src/persistence/fileStore.ts
214	0	tests/persistence/fileStore.test.ts
```

测试文件 **214 增 / 0 删** ⇒ **纯追加**，不存在被改写或被放宽的既有断言
（包括我上一轮写的那两条 —— 它们现在也是「既有」，同样一个字没动）。

## 7. 我没有验到的（Rule 12）

**每条都是「没验」，不是「验过没问题」。**

1. *** **没有做真跨文件系统实测。** *** §1.2 的判据是**注入** `dev`，不是挂第二个 mount。
   「真实内核在什么情况下会让 lockPath 落到另一个 device 上」——**没验**。
2. *** **没有验 `dev` 判据在真实 NFS／bind mount／overlayfs 上的行为。** ***
3. **TOCTOU 仍未覆盖**（`stat` 与 `unlink` 之间被夺锁）—— 与上一轮相同，**本轮没有新增覆盖**。
   评审员 Q4 论证了「仓库内不存在能在该窗口夺锁的合法代码路径」，**那是他的论证，我没有复验。**
4. **inode 号复用**：评审员 Q2/Q4 认为在比较窗口内被 handle 结构性排除（我上一轮把它列为风险）。
   **我没有复验这条论证**，也没有为它加判据。**若控制器要采信，请按「未经第二人复核」对待。**
5. **`unverified` 这一格没有判据**。三条 detail 里我只钉了 `gone` 那一条（M-2 点名的那格）
   和 `foreign` 那条（上一轮已有判据，断言的是事件 type 不是 detail 文案）。
   *** `unverified` 的文案今天零覆盖 —— 明写在这里，不装作它被盖住了。 ***
   （我没有顺手补它：那一格的唯一到达方式是二次 release ＝ M-3，而 M-3 明令不许动。）
6. **`foreign` 那条 detail 的文案也没有判据**（上一轮的判据只断言 `type`，本轮没改既有断言）。
   ⇒ 若有人把 `foreign` 的文案改回假话，**今天没有判据会红**。
7. **没有验事件被谁消费**（与上一轮相同）。M-1 是评审员验的，**我没有复验**，只确认了我没碰那些文件。
8. **没有跑双真进程探针**，本轮同样没有。全部证据是单元判据 ＋ 三次变异。
9. **没有跑 lint／格式检查**，只跑了收口清单的三条命令。
10. **没有动 `progress.md`**（连 worktree 副本也没动），落账归控制器。
11. **没有 push、没有合并、没有建删分支或 worktree、没有碰主仓库与其它 worktree。**

## 8. 变异与还原证明

**变异从未落在 worktree 里。** 流程与上一轮相同：

1. 先把修复提交成 `4f18190`；
2. `git archive HEAD | tar -x -C <scratchpad>/mut`，`node_modules` 软链回 worktree；
3. 在**副本**里用 `python3` 替换，脚本带 `assert <anchor> in s`；
4. 只在副本里跑单文件 vitest；
5. **每次变异前 `rm -rf mut` 重新解包** ⇒ F／G／C2 三次互不叠加；
6. 全部跑完 `rm -rf mut`。

**还原证明**（在 worktree 内、三次变异全部结束之后、收口三跑之前）：

```
git diff bytes:        0
git diff --cached bytes:        0
```

`git status --short` 当时只剩一个 untracked 文件（本报告的骨架）：

```
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/release-guard-fixround-report.md
```

⚠️ **与上一轮相同的偏差，重复声明**：变异只跑**单文件**，**没有在副本里跑全套件**
（archive 副本无 `.git`，会让 `cli.test.ts` 那条 scripted example run 假红）；
**也没有走 `git clone --local` 那条路。**

## 9. 可数事实

**不自报预算估计，只列可数的。**

| 事项 | 数 |
|---|---|
| 全套件跑（`npm test -- --run`，worktree 内，未过滤） | **1** 次，`TEST_EXIT=0`，31 files / 538 tests |
| `npm run typecheck` | **2** 次（新判据落地后各一次，均 `0`） |
| `npm run build` | **1** 次（`0`） |
| 单文件定向跑（`fileStore.test.ts`） | **4** 次（1 次未变异绿 ＋ 3 次变异红） |
| 变异 | **3** 个（F 去 `dev`／G 还原假 detail／C2 恒拒删），全部在 `git archive` 副本 |
| 变异脚本带断言锚点 | **3/3** |
| worktree 内做过的变异 | **0** |
| 新增 `it()` | **3**（M-5 正面格 ＋ M-5 对照臂 ＋ M-2 detail） |
| 新增判据带反空转断言 | **3/3**（`shifted===1` ×2、`removals===1` ＋ `lockPresent===false`） |
| 被我改动的既有断言 | **0**（测试文件 214 增 / **0 删**） |
| 变红的既有判据 | **0** |
| 生产代码改动 | `src/persistence/fileStore.ts` **42 增 / 12 删** |
| src 侧 diff hunk 数 | **3**（`tryRecoverStaleOwnerTransferLock` 与取锁路径均不在其中） |
| `tryRecoverStaleOwnerTransferLock` 改动 | **0 字节**（`shasum` 双向核对一致） |
| 新增事件类型 | **0**（仍只有 `owner_transfer_lock_release_skipped`） |
| 新增 detail 文案 | **3**（`gone` / `foreign` / `unverified`），其中**有判据的 1 条** |
| 挂账项被改动 | **0**（M-1 相关文件 diff 为空；M-3 行为未改，仅文案，见 §6.2） |
| 我独立复核评审 finding 的条数 | **3/3**（M-5 重跑变异、M-2 读代码确认、M-4 自己 grep ＋ 读上下文） |
| 本轮遇到的 flake | **0** |
| 本地提交 | **1**（`4f18190`；报告另计） |
| push／合并／建删分支或 worktree／碰主仓库 | **0** |
| 本轮落盘的验证日志 | **6** 份：`fixround-filestore-1` / `fixround-typecheck-1` / `fixround-mutF` / `fixround-mutG` / `fixround-mutC2` / `fixround-full-1`（＋`fixround-typecheck-2` / `fixround-build-1`，共 **8**），在 `…/scratchpad/logs/` |

⚠️ 日志目录在 scratchpad 里、**不随分支走**；复现请照 §4／§5 的命令重跑（命令与参数已写全）。
