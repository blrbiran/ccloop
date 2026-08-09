# Task S4 — implementer brief（包 2：D-1 ＋ 最薄一格 `#7`）

**BASE**：见派单消息里写死的 commit。**工作区**：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`，分支 `feat/pkg2-s4`。
**唯一可信进度源**：同目录 `progress.md`（16 节）。**本 brief 与它冲突时，以 `progress.md` 为准并立刻上报。**

---

## 0. 先落盘，再检索（落盘协议，硬性）

**你要做的第一件事**：`Write` 一份只有小节标题的骨架报告 `task-s4-report.md` 到本目录并**立刻落盘**，
**在此之前不做任何检索**。之后每次 `Edit` 只填一节，**「结论」一节最先写**。
（历史教训：曾有一会话 12 名 agent 死 6 名，全部发生在准备落盘那一刻。采用本协议后交付率 100%。）

---

## 1. 任务范围（两半，都要做）

### 半 1 —— D-1：给所有权守卫一个真执行机制，**走方案 (a)**

**背景（事实，已由控制器亲核，但你必须自己再撞一次）**：
包 2 任务 2 建了 `createOwnedRunStateWriter()`（`src/controller/runLoop.ts:1011`），
9 处 `writeRunState` 全部经它。**覆盖面事实成立**，但它的验收探针是
`grep -c 'await writeRunState(' src/controller/runLoop.ts` = 1，而 scoped 再评审员在副本上试了
**7 种平常写法**（`void` ／ `return` ／ 别名 import ／ 双空格 ／ `await` 换行 ／ `Promise.all` ／
直接 `writeFile`），***7/7 计数都留在 1***；且**无 lint / CI / npm script / 测试在跑这条探针**。
⇒ **这是「一个没有执行机制的完整性断言」，与 Critical F-1 的根因同形。**

**人裁 29 定的做法 = (a)**：
1. **把写入器搬出 `runLoop.ts`**，使 `runLoop.ts` **不再 import `writeRunState`**。
   建议（不强制）新模块 `src/controller/ownedRunStateWriter.ts`，导出 `createOwnedRunStateWriter`
   与 `OwnedRunStateWriter` 类型；`observeOwnership` 等**仅为写入器服务**的私有件一并搬走。
   **只搬必需的最小集合**（Rule 3：只动你必须动的）。**行为必须逐字不变。**
2. **补一条读源码的测试**钉住这个结构：断言 `src/controller/runLoop.ts` 的源码
   **不含对 `writeRunState` 的 import**（按 import 说明符判定，**不是**按本地绑定名 —— 否则别名 import 就绕过去了）。

**⚠️ 承重要求 —— 报告里必须正面回答，不许含糊**：
逐条列出上面那 **7 种绕过写法**，说明新机制**挡住哪几种、挡不住哪几种**。
***挡不住的必须明写「仍然敞开」，不许淡化成「已改善」。*** 这是衡量 D-1 是否真变好的唯一尺子。
（控制器的预判：直接 `writeFile(join(runDir,"loop-state.json"), …)` 这一路**仍然敞开** ——
若你的实现挡住了它，请给证据；若没挡住，如实写，**不要为了好看去加一条你证明不了的断言**。）

**⚠️ 注释是承重的，不是装饰**：`runLoop.ts:986-1008` 那一大段逐字写着
「`writeRunState` is called from exactly one place in this module — the line below」
与「this module cannot write a run state except through this function」。
**搬走之后这两句在原位就成了失实描述。** 必须**具名勘误**（说明哪一句因本次结构变更而改写、改成什么），
**不许静默删改**。本仓库对「静默覆盖既有论证」是零容忍的（F-1 就是这么来的）。

### 半 2 —— 最薄一格 `#7`：补具名回归测试

**位置（控制器已定位，你仍要自己核）**：`src/controller/runLoop.ts:1594-1608`。
`cleanupAttemptWorkspace` 抛 → `transitionRunState(state,"failed")` →
`appendTransitionEvent(…, "attempt_failed")` → **`:1599 await writeOwnedRunState(runDir, state)`** →
`assertHeld()` → `cleanupAttemptWorkspaceBestEffort(…, "cleanup after retry cleanup failure")` → `return state`。

*** **这是 Critical F-1 的第二个终态写点**（第一个是外层 catch 的失败分支）。
9 处写点里，再评审员只变异了 3 处，**这一处既没被变异、也没有任何具名回归测试钉住**，
目前只靠 D-1 那条没有执行机制的结构性事实覆盖。 ***

**要补的判据**：这条写点在「run 已被异己属主接管」时**必须被守卫拒绝**——
即盘上的 `loop-state.json` **不得**被改写成 `failed`（那正是「不可 resume 的数据丢失」本体），
且**必须**留下 `terminal_write_abandoned` 事件。

**⚠️ 硬性：必须靠断言变红，不许靠异常／超时变红。**
本仓库这个形状已复现两次（任务 3 的 Important-3 及其残余）。
一条「真回归时靠 `Promise.all` 抛 ENOENT 或靠 5 秒超时才红」的测试**不算数**。

---

## 2. 硬边界（越界即失败，不许自行放宽）

1. *** **不许改任何既有测试判据。** *** 人裁 13／14／17 的例外**各自只对其具名的那一条**，
   **明写不得援引到本任务**。本任务**没有任何改判据的授权**。
2. **不许走方案 (c)**（把 `writeRunState` 收成模块私有／给它加 token 参数）。
   它形状最正确，但**必然改 `tests/persistence/fileStore.test.ts` 一大片既有直调**
   （`:1802 :2746 :3275 :3288 :3314 :3326 :3383 :3395 :3415` 等）＋
   `tests/controller/leaseLifecycle.integration.test.ts:196`。**需单独人裁，本轮无授权。**
3. **不许引入 linter／新工具链**。全仓 devDependencies 完整枚举只有 4 项
   （`@types/node` / `tsx` / `typescript` / `vitest`），无任何 linter。加 eslint 与 Rule 2 正面冲突。
4. **不碰第 4 笔**（`reads owner-transfer.json for the published-winner check…` 那条判据）——
   它是本会话的**下一个**任务，人裁 26 定了顺序，**不许提前动**。
5. **不碰三个待裁点 A/B/C**（L1/L2「读不许写」／`tryRecoverStaleOwnerTransferLock` 失败关闭／逃生口），
   **人明令先不裁，也不要重开方向讨论。**
6. **不碰任何 spec**、不碰包 1 的任何东西（包 1 修复环 2 是另一条线，人裁 9 冻着）。
7. **不 push、不合并、不删分支、不开门** —— 四件各需人单独授权，与你无关。
8. **台账 `progress.md` 由控制器写，你不要动它。** 你只写 `task-s4-report.md`。

---

## 3. 验证纪律（本仓库铁律，逐条硬性）

1. *** **验证跑绝不过滤输出 —— `grep` 与 `tail` 同罪。** *** 全套件跑要全文落盘（tee），
   **核 vitest 首行 `RUN` 路径确实是本 worktree**。
2. *** **验证性命令一律走 `rtk proxy`** *** —— rtk 的默认改写会把输出折叠成假计数。
   本仓库已四次栽在这上面（含控制器本会话一次）。
3. **检索脚本先落盘再 `rtk proxy zsh <script>` 跑**，不要在命令行里嵌三层引号
   （多层引号会静默弄坏 `grep` 交替模式，退出码仍是 0）。
4. *** **每次检索必带一条「必命中」的 sanity 探针**证明检索面是活的，外加一条无意义 token 证明它会零命中。
   一条坏探针永远不能证明「不存在」。 *** 这条在本仓库已四方四次同形，**且每次都发生在下全称否定那一步**。
5. **下全称否定前，先确认 grep 面覆盖你断言的范围**；不许用收窄的搜索面支撑全称否定。
6. **锚点用符号名，不用行号**（行号会腐坏）。
7. **变异走三步判据**：注入前绿 ／ 注入后红 ／ 还原后绿。
   **单跑块必须显示具名测试的非零计数**（`1 passed | N skipped` 才证明选择器命中，
   `0 matched` 是空跑）。**还原必须证明**：`git diff` 原始输出为空 ＋ 变异标记零命中 ＋ sanity 探针命中。
8. **允许为验证做临时变异**（这是上一轮 brief 的修正，已兑现两次），**但必须证明还原**。

**允许出现的 flake 只有两条**：
  (B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（`Test timed out in 5000ms`）
  (F) `continues normally when execute returns a complete result during the recovery window`
**另有一条已挂账、不入名单、不要重新调查**（人裁 10）：
  `tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`（ENOENT `plan.json`）。
**见到它按完整测试名比对，但仍不得挥手放过** —— 人裁的是「暂不深挖」，不是「它无害」，**根因至今是空的**。
**任何不在上述之列的失败，一律按新缺陷处理。**

---

## 4. 控制器已核的事实（**只供参考，不供免验**）

以下是控制器读代码得出的机械论证，**不构成你的免验理由，你必须自己再撞一次**：
- `runLoop.ts:14` 仍 import `writeRunState`；`createOwnedRunStateWriter` 是模块私有、未导出。
- `writeRunState` 由 `src/persistence/fileStore.ts:81` 导出；`src/` 侧只有 `runLoop.ts` 真 import
  （`resumeLoop.ts:101`、`observeFields.ts:9` 两处命中**是注释**）。
- `tests/` 侧 `fileStore.test.ts` 直接 import 并大量直调，`leaseLifecycle.integration.test.ts:196` 包了一层。
- 工作区基线：30 files / 518 tests，唯一红是 flake (B)，`TSC_EXIT=0`、`BUILD_EXIT=0`。

**另一条必须知道的反向事实**（来自台账 §13）：`ensureFreshRunDir` 的 `blockingPaths`
**不含** `.owner-transfer.lock` ⇒ 一把泄漏的锁**在生产侧是静默的**，测试是唯一防线。

---

## 5. 交付物与验收

**交付 `task-s4-report.md`**，必须含：
1. **结论**（最先写）：做了什么、哪些验证跑过、退出码。
2. **7 种绕过写法逐条对照表**：新机制挡住哪几种、挡不住哪几种（挡不住的明写「仍然敞开」）。
3. **具名勘误**：`runLoop.ts:986-1008` 那两句因本次结构变更改写成了什么，逐字引原文。
4. **`#7` 新判据的三步变异证据**（注入前绿／注入后红／还原后绿），**含单跑块的非零计数**，
   并**明确说明它是靠哪一条断言变红的**（不是靠异常、不是靠超时）。
5. **读源码那条测试的非空转证明**：变异 = 把 `writeRunState` 的 import 加回 `runLoop.ts`
   ⇒ 该测试必须红，且**红在断言上**。
6. **全套件 ＋ tsc ＋ build 的未过滤结果**，`RUN` 首行路径已核。
7. **预算**：*** 给得出 harness 实测实数就给实数；给不出就明说「拿不到精确数字，不给估计」。 ***
   **本仓库不再收自报估计当结论**（上一轮实施者自报「约 100k 的 60–80%」，实测 195,610，低估 2.5–3.3 倍）。
   **人裁 30 已预先放行 S4 的预算，你不必为超预算停下来请示，但记账不停。**
8. **你自己发现的、自己的缺陷**（有就写，没有就写没有）。**本仓库把自查抓到的缺陷记正面样本。**

**验收条件**：全套件绿（除允许的 flake）／`tsc --noEmit` 退出 0 ／`npm run build` 退出 0 ／
`src/` 与 `tests/` 的改动面严格等于本 brief 的两半 ／**零既有判据被改**。

**⚠️ 你的报告不构成收口** —— 之后会有**换人**的独立评审员实跑核你，**不接受实施者自证**。
上一轮实证：独立评审员实跑证伪了实施者钉住的承重前提，换来 3 条 Important。
**所以：拿不准的地方如实标「未验」，比写成已证实划算得多。**
