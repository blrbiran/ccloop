# 包 2 整分支评审 —— Lane 2 brief（判据面 ／ 声明-代码一致性）

> 你是**独立评审员**，不是实施者。包 2 的四笔（债 2 ／ 第 1 笔 ／ S4 ／ 第 4 笔）都已实施并各自做过独立评审，
> **但从来没有一次跨全部四笔的整分支评审**。你就是那一次的其中一条车道。
> **包 1 的先例是承重的**：包 1 每个任务级评审都是 0 Critical，而整分支评审把一条 Minor 升成了唯一那条 Critical。
> **任务级全绿不能替代整分支级 —— 你要找的正是任务级评审结构上看不见的东西。**
> 另有一条车道（Lane 1）主责生产代码。**你们互不通气，这是刻意的**：包 1 那次两条车道独立撞到同一处，互为印证。

## 0. 你的交付物与落盘协议（**先做这一步，做完再开始检索**）

1. **立刻** `Write` 文件 `.superpowers/sdd/2026-08-07-pkg2-data-loss/wholebranch-lane2-report.md`，
   内容只有小节标题骨架（见下方 §6），**立刻落盘**。在这之前不要做任何检索。
2. 之后每次 `Edit` **只填一节**，**「结论」那一节最先填**。
   （历史教训：曾有一会话 12 名 agent 死 6 名，全部发生在准备一次性落盘时。分节增量落盘后交付率 100%。）
3. 该目录 `.gitignore` 是 `*`，**入库要 `git add -f`** —— 入库由控制器做，你只管写文件。

## 1. 评审范围（**严格**）

- **范围 = `e42e062..HEAD` 触及的 9 个文件**（控制器已实测：包 1 那段对 `src/`、`tests/` 改动为 0 文件）：
  `src/controller/ownedRunStateWriter.ts`（新增）／`src/controller/runLoop.ts`／`src/controller/resumeLoop.ts`／
  `src/persistence/fileStore.ts`／`tests/controller/runLoop.integration.test.ts`（+821）／
  `tests/persistence/fileStore.test.ts`（+211）／`tests/controller/resumeLoop.integration.test.ts`（+119）／
  `tests/controller/leaseLifecycle.integration.test.ts`（+57）／`tests/controller/ownedRunStateWriter.structure.test.ts`（新增）。
- **你的主责有三块**：
  **(a) 判据强度** —— 这 1300+ 行新测试**到底钉住了什么**，**哪些设计上的承重细节今天零判据**；
  **(b) 具名例外与既有判据的完整性** —— 四个例外是否越界，有没有**未申报**的既有判据被改动或被削弱；
  **(c) 声明-代码一致性** —— 台账 `progress.md`（19 节）与各任务报告里的**承重声明**，
  在今天的 `HEAD` 上**是否仍然成立**。（包 1 那条 Critical 就是这类：文档宣称「只有一个面、可以穷举」，而外延未封口。）
- 生产代码由 Lane 1 主责，但你**仍要对下面五个跨笔面全部给出判断**（见 §3）。
- ⛔ **不在范围**：包 1 的 L5 spec（`.superpowers/sdd/2026-08-07-pkg1-l5-spec/` 及其 spec 文档）。
  那是**另一条线**，有它自己未开的修复环 2。**读串了会污染两条线，明令不许碰。**
- ⛔ 待裁点 A / B / C：**人明令先不裁**。可以指出关系，**不得把「应当裁 B」当成 finding**。

## 2. 铁律（本仓库买过血的，逐条都要遵守）

1. *** **不接受实施者自证。** *** 台账、任务报告、既有评审报告里的**任何声明**都**只是线索，不是证据**。
   凡你要当作承重前提的，**必须自己实证**。**你这条车道的一大半价值就在于把这些声明逐条打回原形。**
2. *** **读代码的机械论证不等于实测。** *** 控制器有一次推理**每一环都读对了、结论仍然是错的**，
   被自己要求的实测证伪。**凡结论涉及「判据钉不钉得住」，就变异 → 跑，不要只读。**
3. *** **验证跑绝不过滤。** *** `grep` / `tail` / `sed` **同罪**，**过滤显示与过滤落盘同罪**。
4. *** **坏探针不能证明「不存在」。** *** 下任何全称否定之前，**必须在同一次跑里放一条已知必命中的 sanity 探针**。
   本仓库栽过的形状：`$?` 取到前一条命令 ／ zsh 的 `:s` 修饰符 ／ 未加引号的 `--include=*.ts` ／
   把 `--numstat` 限定到单文件因而错怪别人的报告。
5. **允许为验证做临时变异**（**这是你的主要武器**：改生产代码看判据红不红），**但必须证明还原**：
   - 变异前先确认工作区干净（`git status --porcelain`），否则 `git checkout --` 会还原到错误目标并静默销毁工作；
   - 还原后**同时**验 `git diff` 与 `git diff --cached` 均为 **0 字节** —— `git checkout <commit> -- path` **会进暂存区**；
   - 报告里逐次列出：变异内容、观察结果、还原证明。
6. ⛔ 不得留下未还原的改动；⛔ 不得 `git commit` / `push` / 建删分支 / 合并；
   ⛔ **不得动用第五个具名例外** —— 即**不许修改任何既有测试判据**（哪怕你认为它错了）。
   需要改，就写成 finding 报上来，**由人裁**。
7. **验证命令一律走 `rtk proxy`**；环境变量 `ECC_GATEGUARD=off DISABLE_OMC=1`。
8. *** **finding 与它的「处置建议」是两回事。** *** 分开写，并**明说这一项是否应该在本轮修**。

## 3. 你必须正面回答的五个跨笔面（**任务级评审结构上看不到它们**）

对每一面给出：**你自己的独立判断 ＋ 支撑它的实测证据 ＋ 分级**。
下面括号里是既有说法 —— *** **待检验的断言，不是给你的结论。推翻它们同样是有效交付。** ***

1. **四个具名例外是否越界**（**你的主战场**）：
   - **人裁 13**：准改 `runLoop.integration.test.ts > reads owner-transfer.json for the published-winner check
     and finalizes none of the winner's transaction inside the publish window` **这一条判据（仅限它）**。
     ⚠️ 该注释块逐字写着「**No terminal-state assertion, deliberately** … 断言它 = **把一条 damaged trajectory
     写进套件**」，且自陈出自 **2026-08-02 的一次 Human ruling**。⇒ **实施者是否证明了「第 4 笔之后那条轨迹
     不再是 damaged」**？还是拿「人已授权」当论据了（**授权解除的是流程约束，不是举证责任**）？
     **它是否逐字指明推翻了那次 ruling 的哪一部分**？
   - **人裁 14**：准把 `terminal_write_abandoned` 加进**那两条**测试的期望清单 —— **是否只有那两条**？
   - **人裁 17**：准改 `leaseLifecycle` 的 `seedEligibleRun` 夹具。⚠️ `tests/` 下有**三个互不相干的同名
     `seedEligibleRun`**，另两个（`resumeLoop` / `cli`）**故意不改** —— **是否被顺手改了**？
   - **人裁 37**：仅限 `leaseLifecycle` 那条 busy-lock 护栏测试中**读 `reconciliation-record.json` 的那一半**，
     其 `owner_transfer_contended` 断言**必须保留** —— **是否保留了**？
   - ⇒ 另外：**有没有第五处未申报的既有判据被改动或被削弱**（含「加了个 `if` 让它更容易通过」这类软化）？
     口径提示：本仓库对「既有」有两种读法（「任务之前」vs「本修复环之前」）且**没有消解** ——
     遇到就**两种口径分别报**，不要自己选一个。
2. **重试覆盖的同形缺口**：resume 侧（`resumeLoop.ts`，人裁 38 批准约 100ms、3 次）与转移侧
   **各有一处「争用清空」分支只被 mock 覆盖**；耗尽分支虽由既有判据端到端驱动
   （实测：退避常数 50 → 700 让它从 222ms 变 1515ms，Δ = 恰好两次退避），**但分不清 1 次与 3 次**。
   ⇒ **实证**：把重试次数从 3 改成 1（或 2）、把「争用清空」那条路径拆掉，**全套件还全绿吗**？
   ⚠️ **CAS 从不重试**是既有约定，别当缺陷。
3. **D-1 仍敞开三条路**：（既有说法）已挡住 #1–#6、#8、#11，**仍敞开 #7 直接
   `writeFile(join(runDir,"loop-state.json"))` ／ #9 动态 `await import()` ／ #10 委托第三模块**。
   结构判据在 `tests/controller/ownedRunStateWriter.structure.test.ts`（`ts.createSourceFile` 解析，非正则）。
   ⇒ **那条结构判据本身钉得有多死**？换个合法写法（重命名、别名、re-export、`import type` 混写）它还红吗？
4. **第 4 笔是「降级」不是「关闭」**：（既有说法）顺序无关性**以「转移锁不可被偷」为前提，而那一条今天零判据**。
   ⇒ **确认这个「零判据」**（先证明你的检索面是活的），并判断：**台账/handoff 现在的措辞
   有没有在别处悄悄写成了「已关闭」**（人裁 39 明令一律记「降级」）。
5. **`reconciliation-record.json` 缺席的处理三处口径不一致**：（既有说法）
   `readPersistedReconciliationRecord` 有 `catch → undefined`；registry 结构上读不到它
   （`pickReader` 对它抛，`sweepRuns.ts` 逐字说它不在 L2 的 `OBSERVED_FILES` 里）；
   **`readReconciliationRecord` 完全无守卫，且直通 `resumeLoop.ts` 的 `Promise.all`**。
   ⇒ **有没有任何判据钉住第三处的行为**？没有的话，**这是一条今天可达的红线还是只是理论**？给可构造场景。

## 4. 除了这五面，重点搜索这两个「已在本仓库稳定复现」的根因形状

1. *** **测试「靠异常/超时变红」而不是「靠断言变红」** ***（**这是你的主责形状**）——
   一条回归的实际红法是 `Promise.all` 抛 ENOENT 或超时，而不是它自己那条断言。
   本仓库既有实证：一条断言钉的是**偶然的微任务顺序**，评审员只在测试侧加一次合法的 100ms 重调度，
   它就在**正确行为**下变红。**Rule 9：一条在业务逻辑改变时不会变红的测试是错的。**
   ⇒ 在这 1300+ 行新判据里**系统性地找这个形状**，每找到一条给出**让它在正确行为下变红**或
   **在错误行为下仍然绿**的实证。
2. *** **「一个没有执行机制的完整性断言」** *** —— 设计上承重、但没有任何 lint / CI / 测试在跑它的保证。
   已复现三次（D-1 的 grep 探针、任务 3 的 `release()` 移出 `finally` 后 518 条全绿、Critical F-1）。
   **在四笔叠加后再找一遍。**

## 5. 基线事实（控制器亲跑，`rtk proxy`，未过滤，`RUN` 路径已核）

`HEAD = bfb366a`。`Test Files 31 passed (31)` ／ `Tests 524 passed (524)` ／ `TEST_EXIT=0` / `TSC_EXIT=0` / `BUILD_EXIT=0`。
⚠️ **不要继承这个绿，自己重跑一次做你自己的基线**（你要做大量变异，基线必须是你自己的）。
⚠️ **本轮零红** —— **「本次没跑出来」不构成任何 flake 消失的证据。**
- **允许出现的 flake 只有两条**：
  (B) `evidence.test.ts > run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`（超时）
  (F) `continues normally when execute returns a complete result during the recovery window`
- **另有人裁 10 那条已挂账**：`persists phase usage evidence from the subprocess adapter without recomputing controller totals`
  （ENOENT `plan.json`，累计约 1/11 红，根因至今是空的）。**按完整测试名比对、挂账即可，不要重新调查。**
- ⚠️ **任何不在上述名单内的失败一律按新缺陷处理，不许挥手放过。**

## 6. 报告骨架（`wholebranch-lane2-report.md`，先落盘这几个标题）

```
# 包 2 整分支评审 —— Lane 2 报告（判据面 / 声明-代码一致性）
## 0. 结论（最先填）
## 1. 我自己的基线（重跑结果，未过滤）
## 2. 五个跨笔面的逐条判断
## 3. 具名例外逐条核查（13 / 14 / 17 / 37）＋ 有无第五处未申报改动
## 4. 台账与报告里被我证伪或已腐坏的承重声明（逐条附证据）
## 5. Findings（Critical / Important / Minor，与处置建议分开写）
## 6. 我做过的临时变异与还原证明
## 7. 我下过的全称否定，以及证明检索面为活的 sanity 探针
## 8. 我没能验到的、以及为什么（诚实留白）
## 9. 预算：harness 可数事实
```

**分级口径**：
- **Critical** = 今天可达的数据丢失/正确性破坏，或一条会让评审结论本身失效的错误前提，
  或**一个越界的具名例外**（因为它会把一条 damaged trajectory 钉成「正确行为」）。
- **Important** = 承重保证缺执行机制、判据钉不住设计的承重细节、声明与代码不符。
- **Minor** = 其余。

**每条 finding 必须带**：① 可构造场景（具体输入/状态 → 错误输出或错误终态）；
② **锚点用符号名**（函数名 / 测试全名），**不要用行号**；③ 支撑它的实测证据（不是推理）。

## 7. 预算

**人裁 45：预先放行，记账不停。** ⇒ 不要为省预算削减变异实验。
⚠️ **不要自报预算估计**（本仓库明令：一律以 harness 实测为准）。报告 §9 只写**可数事实**：
跑了几次全套件、做了几次变异、读了哪几个文件。**拿不到精确数字就说拿不到，不要估。**
