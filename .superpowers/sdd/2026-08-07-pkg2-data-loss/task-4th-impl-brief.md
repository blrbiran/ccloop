# 第 4 笔 —— 实施 brief（D2，人裁 33 已批）

**工作区**：`/Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-s4`，分支 `feat/pkg2-4th`。
**BASE**：派单消息里写死。**不 push、不合并、不删分支、不开门。**
**台账 `progress.md` 由控制器写，你不要动。**

---

## 0. 先落盘，再检索（硬性，无例外）

第一件事：`Write` 一份只有小节标题的骨架报告 `task-4th-impl-report.md` 并**立刻落盘**。
**在骨架落盘之前不做任何事** —— 包括 `git status`／`ls`／读设计文档。
（上一位设计员就在这一步破了字面规则并如实自曝；**你不要重蹈**。）
之后每次 `Edit` 只填一节，**结论一节最先写**。

---

## 1. 你的需求源（按序读）

1. *** **`task-4th-design.md` 的 D2 一节 —— 那是你的规格。** *** 机制、爆炸半径、举证要求全在里面。
2. `task-4th-design-brief.md` —— 设计员当时受的约束，其中 §2 的**举证责任**同样落在你头上。
3. 本 brief —— 人裁与硬边界。**三者冲突时，以人裁（本文 §2）为准，并立刻上报冲突。**

⚠️ *** **设计文档里每一条「这个测试会/不会变红」都标着「未验（推理）」** —— 设计员刻意没跑变异。
**那些是待验假设，不是既成事实。你必须自己撞一次。** 把它们当结论用，就是本仓库最忌的「接受单方证词」。 ***

---

## 2. 人裁（逐条只在其具名范围内有效，**一律不得外推**）

| # | 内容 |
|---|---|
| **13** | **具名例外**：准改 `runLoop.integration.test.ts > reads owner-transfer.json for the published-winner check and finalizes none of the winner's transaction inside the publish window` **这一条既有判据**。**仅限它。** |
| **19** | 第 4 笔在范围内 ⇒ 人裁 13 的例外激活 |
| **33** | **走 D2**（D1／D3／D4／不修均未选中，其代价分析不作废） |
| **34** | D2 新增 `tryRecoverStaleOwnerTransferLock` 的调用者 —— **只要不改 B 的字节、不改其失败开放/关闭语义，扩大执行面不算动 B**。⚠️ **待裁点 B 本身仍然先不裁，不许顺手改它** |
| **35** | **准新增 `it`** 来覆盖第二种交错。**新增判据 ≠ 改既有判据** |

*** **控制器裁量（Rule 11 一致性，非人裁事项）**：锁忙的语义**沿用代码库既有形状**——
**有界重试 → 耗尽则放弃 ＋ 争用事件恰好追加一次**。既有判据逐字：
  `retries a busy owner-transfer lock and completes once it clears (spec requirement 1)`
  `abandons the transfer once the retry bound is exhausted, with the contention event appended exactly once (spec requirement 2)`
**你必须自己核实它真的可复用，不许照抄假设。核出不可复用 ⇒ 就地停住上报，不许发明第三种语义。** ***

---

## 3. 举证责任（人裁 13 扩权，**明确没有免除**）

你要改的那条判据受 **2026-08-02 的一次 Human ruling** 约束。报告里必须正面处理两句，**不许绕过**：

1. *** **「第 4 笔关闭之后，那条轨迹为什么不再是 damaged」—— 拿今天的代码证。** ***
   原文要害逐字：「"P1's third rename puts the winner's record back" is an ordering **this harness
   imposes, not a property of the system**」。
   ⇒ **合格的关闭必须让终态不依赖谁先谁后。** 设计员已把这一点拆开：D2 **不是**把那个顺序变成
   系统性质，而是让**另一个**命题变得可断言 —— **你要么兑现这个区分，要么推翻它，不许含糊带过。**
   ⚠️ **只断言单一顺序的终态 = 2026-08-02 杀掉的同一条 damaged trajectory 换个名字。**
   **人裁 35 正是为此给的：两种交错都要有判据。**
2. *** **逐字指明这次改动推翻了那次 ruling 的哪一部分、保留了哪一部分。** ***
   设计员已给出一版拆解（4 句推翻 / 5 句保留），**那是他的读法，不是定论 —— 你要自己核一遍**，
   同意就说同意并复述，不同意就说清哪里不同意。**不许静默覆盖。**

*** **「人已授权」不是论据。授权解除的是流程约束，不是举证责任。** ***

---

## 4. 硬边界

1. **除人裁 13 具名那一条外，不许改任何既有判据。** 目前分支上 `tests/` 的删除行数是 0，
   **你改那一条会产生删除行 —— 那是唯一被允许的**，其余一律不许。**报告里要单独把这件事讲清楚。**
2. **不碰待裁点 A / C**（L1/L2「读不许写」／逃生口）。**B 只准扩执行面，不准改语义**（人裁 34）。
3. **不引入 linter／新工具链，不动 `package.json`。**
4. **不碰包 1 的任何东西**（另一条线，冻着）。
5. **不动 spec、不动 plan** —— 若你发现 spec 与代码不符，**记进报告，不要改文件**。
6. 设计文档里被否掉的 D1/D3/D4 **不许顺手做一半**。

---

## 5. 验证纪律（铁律，逐条硬性）

1. *** **验证跑绝不过滤 —— `grep` 与 `tail` 同罪，过滤落盘与过滤显示同罪。** *** 全文 tee 落盘，
   再从盘上日志用**已验活的**探针取结论。（**控制器本会话在这条上栽了 3 次，逐条记在台账。**）
2. **验证性命令一律走 `rtk proxy`**。⚠️ 裸 `git diff` 经 hook 会吞掉原始输出（**空 diff 也打一个字节**）
   ⇒ **还原证明必须 `rtk proxy git diff`**。
3. 跑测试带 `ECC_GATEGUARD=off DISABLE_OMC=1`；**核 vitest 首行 `RUN` 路径确实是本 worktree**。
4. **检索脚本先落盘再 `rtk proxy zsh <script>` 跑**，不要在命令行嵌三层引号。
5. *** **每次检索必带必命中 ＋ 必不命中两条探针。坏探针永远不能证明「不存在」。** ***
   （本仓库已五次同形，**每次都发生在下全称否定那一步**。）
6. ⚠️ `git show "$commit:path"` 在 zsh 下被当作 `:s` 修饰符，静默出 0 且退出码 0 ⇒ 用 `bash -c` 包一层。
7. **变异走三步判据**：注入前绿 / **注入后红** / 还原后绿。单跑块必须显示具名测试的**非零**计数。
   还原必须证明：`rtk proxy git diff` 原始输出空 ＋ 变异标记零命中 ＋ sanity 探针仍命中。
8. *** **新判据必须靠断言变红，不许靠异常或超时变红。** *** 本仓库这个形状已复现两次，**一律不收**。
9. **报不出可重数的计数，就不要报数字。**

**允许出现的 flake 只有两条**：
  (B) `tests/validation/evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（`Test timed out in 5000ms`）
  (F) `continues normally when execute returns a complete result during the recovery window`
**另有一条已挂账、不入名单、不要重新调查**：
  `tests/controller/runLoop.integration.test.ts > runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`（ENOENT `plan.json`）。
按**完整测试名**比对；**仍不得挥手放过**。**其余任何失败一律按新缺陷处理。**

---

## 6. 不要重新发现的事（已查明，直接用）

- *** **`runExclusive`（`leaseHeartbeat.ts`）是纯进程内 promise 队列，不碰文件系统**；
  `runLoop.ts` 的 INERT 版本就是 `(fn) => fn()`。**全仓唯一跨进程原语是 `acquireOwnerTransferLock`。** ***
  ⇒ **「把 `writeBoundaryArtifacts` 挪进 exclusive span 就好了」是错的**，对另一个进程毫无作用。
  **控制器已亲验，可直接引用。**
- 那条具名测试的注释块自陈：**Mutation 2** 会连带弄红别处一批既有测试，名单在 `task-A9-report.md`
  —— *** **那批是噪声，不是本测试的护栏**；唯一算数的证据是该具名测试单跑变红。 ***
- assertion (a) 钉的是**保护性读的前置条件**，**不是判定本身**；注释块自己列了两条
  「(a) 绿但判定从未被求值」的路径。**不要把 (a) 读大。**
- `preserveSuccessfulReconciliationIfNeededFromArtifacts` 与 `readPersistedReconciliationRecord`
  的 `catch { return undefined }` 在 2026-08-02 那层都有**明写的「不要顺手动」**理由。
  **要动其中任何一个，必须逐字引那个理由并说明为什么今天不再成立。**

---

## 7. 交付契约

**交付 `task-4th-impl-report.md`**，必须含：
1. **结论**（最先写）。
2. *** **两种交错的判据各自的三步变异证据** ***，含单跑块非零计数，**并明确说明各自靠哪一条断言变红**。
3. **§3 那两句举证的正面回答**（不再复述要求，直接答）。
4. **被改的那一条既有判据**：改前改后逐字对照，说明为什么新形状不再 damaged。
5. **锁忙语义的复用核实结果**（可复用 / 不可复用 ＋ 证据）。
6. **爆炸半径实测**：设计文档标「未验（推理）」的每一条，你实测的结果是什么。**与他不一致的要点名。**
7. 全套件 ＋ `tsc --noEmit` ＋ `npm run build` 的**未过滤**结果，`RUN` 首行已核。
8. **预算**：*** 读得到 harness 实数就给实数，读不到就明说读不到，不给估计。 *** 人裁 32 已预先放行，
   **你不必为超预算停下来，但记账不停。**
9. **你自己发现的、自己的缺陷**（有就写，没有就写没有）。**自查抓到的缺陷记正面样本。**

**验收**：全套件绿（除允许的 flake）／三个退出码全 0 ／改动面严格等于 D2 ＋ 判据 ／
**除人裁 13 具名那一条外零既有判据被改**。

⚠️ **你的报告不构成收口** —— 之后有**换人**独立评审员实跑核你，**不接受实施者自证**。
本会话已两次实证：独立评审员实跑证伪了实施者的承重前提。
**所以：拿不准就如实标「未验」，比写成已证实划算得多。**
