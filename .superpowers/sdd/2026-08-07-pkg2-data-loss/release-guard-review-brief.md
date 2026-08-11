# 评审任务书 —— `release()` 身份校验（人裁 62/63）

**你是独立评审员，不是实施者。** 范围：`d872532..feat/pkg2-release-guard`，工作区
`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-release-guard`。
环境 `ECC_GATEGUARD=off DISABLE_OMC=1`，一切命令走 `rtk proxy`。
**禁止**：push ／ 合并 ／ 建删分支或 worktree ／ 改主仓库 ／ 改实施者的代码（你只评审，修复由另一轮做）。

## 0. 铁律（本仓库逐条咬过人）

- *** **不接受实施者自证。** *** 他的报告 `release-guard-impl-report.md` 是**待验材料**，不是证据。
  他自己的反向对照要你**重跑一遍**，不是读一遍。
- *** **坏探针不能证明「不存在」** *** —— 任何「没有发生／没有别的地方」的论断，必须配一条必命中对照。
  ⚠️ **控制器本轮刚犯过一次**：按函数名前缀提取函数体，命中了 `acquireOwnerTransferLockForReconciliation`，
  得出「取锁路径未改」的假结论。**你用符号名锚定时注意同前缀兄弟符号。**
- **验证跑绝不过滤**（`grep`/`tail`/`sed` 同罪，过滤显示与过滤落盘同罪）。
- **允许为验证做临时变异，但必须证明还原**（同时验 `git diff` 与 `git diff --cached` 为 0 字节）。
  全套件跑要在副本里做时**用 `git clone --local`，不要用 `git archive`**（后者无 `.git`，会让 `cli.test.ts` 假红）。
- **落盘协议**：骨架先落盘，逐节填，结论最先写。报告写 `release-guard-review.md`。
- *** **finding 与它的处置建议分开写** *** —— 控制器吃过「只读 finding 就派工」的亏。
- **预算：不自报估计，只交可数事实。**

## 1. 改动落点（决定你重点看哪）

`src/persistence/fileStore.ts` ＋68/−3：
① 新 helper `lockPathStillHoldsPublishedInode`（`handle.stat()` vs `stat(lockPath)` 比 `dev`+`ino`）；
② 新 helper `recordSkippedForeignLockRelease`（`appendEvent`，新事件类型 `owner_transfer_lock_release_skipped`）；
③ `acquireOwnerTransferLock` 返回的 **`release()` 闭包**：先 fstat 校验 → `handle.close()` → 不是自己的就记事件并 `return`，否则 `safeUnlink`。
`tests/persistence/fileStore.test.ts` ＋133：新增 2 条 `it()`（正面格 ＋ 必命中对照臂）。

*** **⚠️ 这个落点有前科，这是你被派来的原因。** *** 修复环**第二轮**就是在 `acquireOwnerTransferLock`
**里面**引入了一条 Important（Imp-1：成功 `link` 之后、`return` 之前多了一条可抛语句，一旦抛出**锁已发布而调用方拿不到 `release`** ⇒ 该 run 长期停摆），
是第三名评审员查出来的。**所以你的头号问题是：修一个洞，是不是开了个新的？**

## 2. 必须正面回答的问题（逐条给结论 ＋ 可构造场景）

1. **新的可抛面**：`release()` 现在多了 `handle.stat()` 与 `stat(lockPath)` 两次 I/O 与一次 `appendEvent`。
   实施者声称全部内部收敛、`release()` 的可抛面不增不减。**实测证伪或证实它**（它在**四个** `finally` 里被调用）。
2. **fstat 的时机**：校验在 `handle.close()` **之前**。确认闭合前后没有把原有的 `close()` 语义弄坏，
   且 `close()` 自身抛错时的行为与改动前一致。
3. **「锁已经不在盘上」这一格**：`stat(lockPath)` 抛 ENOENT ⇒ 返回 false ⇒ **不删 ＋ 记事件**。
   这条事件是否是噪声？**它是否改变了任何既有观测面**（events.jsonl 的读者、registry、sweep、
   `RunEvent` 是否有穷举校验或 zod schema 会拒绝未知 `type`）？**这是全称否定，请给检索面证明。**
4. **inode 判据的失效格**：TOCTOU（stat 与 unlink 之间被夺锁）与 inode 复用，实施者已自认未测。
   **判断它们今天是否可达、以及是否需要判据钉住**（finding 与处置建议分开写）。
5. **判据质量**：那 2 条新 `it()` 是否**红在断言**、是否**反空转**（有没有可能恒绿）。
   **你自己造变异复核**，至少复核实施者声称的 A（无条件删）与 B（换回 `pid` 判据）两种；
   **B 那条尤其重要** —— 它是「inode 判据比 pid 判据强」这个主张的唯一支点。
6. **既有判据零破坏**：确认没有任何既有断言被改动或被放宽（`git diff` 逐条看测试文件）。
7. **红线**：`tryRecoverStaleOwnerTransferLock` 与取锁路径必须逐字节未动（控制器已验，**你独立再验一次**）。

## 3. 收口

在本 worktree 内、`rtk proxy`、未过滤：全套件 ＋ typecheck ＋ build，报三个退出码与 vitest 首行 `RUN` 路径。
**基线**：`d872532` 上 `31 files / 533 tests`；本分支应为 **535**。
**允许的 flake 只有 (B) 与 (F)**；名单外失败按完整测试名挂账上报，**不重新调查、也不挥手放过**。
