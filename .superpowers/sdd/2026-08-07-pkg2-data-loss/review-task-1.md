# 任务 1 独立评审报告

## 1. 结论

**规范符合：✅ 符合。**
**任务质量：通过。**

- 提交 `ed22305` 只新增了 1 个测试与本任务报告，`src/` 在最终提交里零改动（`git diff --stat -- src/` 与
  `git status --short` 均已由我独立复核，见 §2/§6）。没有修 `persistTerminalState`，没有碰它的调用点，
  没有改任何既有测试的判据（diff 里唯一非新增内容是 import 行的重排以引入新符号，不涉及断言）。
- 新测试真实驱动生产函数 `runLoopFromState`→`persistTerminalState`，并用生产的
  `evaluateResumeEligibility` 网关函数验证「数据丢失」这件事本身（不可续跑），不是断言某个中间变量的
  形状。我逐行核对了 `evaluateResumeEligibility`（`src/controller/resumeLoop.ts:40-69`）的判据顺序，
  手工推算出测试构造的 fixture 在该函数里会精确产生报告声称的两个结果——这一核验不依赖信任报告，是我
  自己用生产代码逐条判据算出来的。
- 三步判据中的「注入前绿」我自己重新独立跑了一遍，结果与报告逐字一致（`1 passed | 55 skipped`）。
  「注入后红」「还原后绿」两步因为我被硬性禁止改任何代码（含临时改后还原），没有literal重跑；改用
  静态交叉验证：报告贴出的两处调用栈行号（`persistTerminalState src/controller/runLoop.ts:941:11` 与
  `runLoopFromState src/controller/runLoop.ts:1068:14`）在假设插入 6 行变异代码的前提下互相自洽
  （`1062+6=1068`，且 6 行插入能让 throw 语句落在新的 941 行），加上 `readOwnerRecord`/
  `buildProcessInstanceId` 确认本就已在 `runLoop.ts` 导入（不需要新增 import，与报告所述一致）——
  这不是决定性证据，但没有发现任何不自洽或可疑之处（详见 §6 我自报未验到的部分）。

## 2. 规范符合逐条核对

逐条对照 `task-1-brief.md` 的「范围（硬边界）」与「新测试应该是什么形状」：

1. **只补注入，不修债 2** —— ✅。`git log --oneline -5` 确认 `ed22305` 是唯一新增提交，`review-task1.diff`
   diffstat 只有 `task-1-report.md`（新文件）与 `tests/controller/runLoop.integration.test.ts`
   （+115/-4）。我 `Read` 了完整 diff，`src/controller/runLoop.ts` 不在改动文件列表里——**没有给
   `persistTerminalState` 加守卫，没有改它的任何调用点**，与实施者报告 §1/§4 的自述一致。
2. **不许改任何既有测试的判据** —— ✅。diff 里对既有代码的唯一改动是文件顶部的 `import` 语句（把
   `createLeaseLossSignal`/`RunLeaseLostError`/`evaluateResumeEligibility`/
   `OwnerRecord, OwnerTransferRecord, ReconciliationRecord` 加进已有的 import 行），新测试整块以
   `+` 插入在两条既有 lease-loss 测试之间，前后既有测试的代码逐字未动。-4/+... 的删除行全部是被重新
   格式化的 import 行本身，不是断言。人裁 13 的具名例外（第 4 笔那条测试）本任务未援引，也不需要援引。
3. **三步判据齐全，各带命令、未过滤输出、具名测试非零计数** —— ✅（格式层面）。报告 §4 三个代码块
   分别是 `1 passed | 55 skipped`（A）、`1 failed | 55 skipped`（B，附精确报错信息与调用栈）、
   `1 passed | 55 skipped`（C，附 `git status --short` 与 `git diff --stat -- src/` 零输出）——都是
   具名测试（`-t` 精确匹配单条测试名）而非 `0 matched` 或聚合计数。我自己独立重跑了步骤 A，结果逐字
   一致（见 §6）。步骤 B/C 因我被禁止改代码而未 literal 重跑，改用静态交叉验证（见 §1、§6），未发现
   不自洽。
4. **变异已还原，`git status` 干净** —— ✅。我自己读取的当前
   `src/controller/runLoop.ts:931-941`（`persistTerminalState` 全函数体）不含任何 `TEST_MUTATION`
   标记，与撤除变异前报告贴出的原函数体逐字一致；我自己跑的 `git status --short` 只有我自己的评审
   文件，`src/` 无残留改动。
5. **测试文件位置与命名照既有约定** —— ✅。新测试插入 `tests/controller/runLoop.integration.test.ts`，
   与两条既有 `runLoopFromState` 直驱 lease-loss/heartbeat 检查点的测试相邻分组，复用既有 helper
   （`readEventTypes`/`readRunState`/`makeRunState`/`createRepo`/`createContract`），符合 Rule 11。
6. **报告 8 节齐全** —— ✅。`task-1-report.md` 含全部 8 节，顺序与 brief §「报告骨架」一致，第 1 节
   （结论）内容也确实回答了 brief 要求的两个问题（注入是否建立、债 2 今天是否可达且丢数据）。
7. **发现文档论据不成立时原样上报，不许改判据** —— 适用性核实：实施者在 §2 重核扫描员 1 的四个数字
   （15 个调用点、4 个 lease-loss 行号、`cancelled: []`、`RESUMABLE_STATUSES` 三态）时全部判定"成立"。
   我用独立的 `grep`/`Read`（未看报告先自己跑）复核了全部四条（§6 的 `review-stepB-numbers.sh` 输出），
   **结果与实施者、扫描员 1 三方一致**，没有发现应该被判"腐坏"却被实施者悄悄放过的情况。

## 3. 任务质量评估（新测试鉴别力）

**核心问题逐条回答：**

1. **断言的是不是「数据丢失」本身，不是中间变量的形状？** —— 是数据丢失本身。测试链条的终点不是
   `persisted.status === "cancelled"` 这类形状断言（虽然也有，作为中间锚点），而是把落盘后的
   `runState` 喂给生产的续跑网关函数 `evaluateResumeEligibility`，得到
   `{ ok: false, reason: "run status cancelled is not resumable" }`——这直接是"这个本来完全合规、
   当前归属他人的 run，现在永久续不上了"这件事的生产级判定，不是我或实施者自己写的判断逻辑。
   我逐行读了 `evaluateResumeEligibility` 的判据顺序（`src/controller/resumeLoop.ts:40-69`），手工
   核对测试构造的 `ownerRecord`/`ownerTransfer`/`reconciliation` 三元组在每一条前置判据
   （`eligibleForContinuation`×2、`ownershipVerdict`、`newOwnerEpoch` 匹配、`supersededByEpoch`、
   `currentOwnerEpoch` 匹配、`ownerStatus`）上都合规，唯一会失败的就是最后一条
   `RESUMABLE_STATUSES.includes(runState.status)`——这是我自己用生产代码算出来的，不是信报告的转述。

2. **会不会是恒绿测试？** —— 不会。若 `persistTerminalState` 加了任何形式的所有权检查（brief 举的
   反向变异例子），第 4 步 `runLoopFromState` 调用要么抛错要么不再写出 `"cancelled"`，第 5 步
   `expect(await readEventTypes(runDir)).toEqual(["loop_cancelled"])`（精确相等，非
   `toContain`）会先断在这里——这条断言对"写了别的东西/什么都没写"两种情况都会红，不是只对某一种
   特定实现形状的修复敏感。今天代码没有这个守卫（我独立读了 `persistTerminalState`
   931-941 全函数体：只有 `transitionRunState`+`appendTransitionEvent`+`writeRunState` 三步，零次
   `readOwnerRecord`），所以测试今天必然绿——这与 Rule 9 的要求（测试要编码 WHY）相符，不是"怎么改
   都绿"的空测试。

3. **「注入后红」红得对不对？** —— 报告贴出的调用栈精确指向
   `persistTerminalState src/controller/runLoop.ts:941:11`，报错文本与变异注入的字符串逐字对上。
   我做了一次独立的算术自洽检查：变异调用点在 `runLoopFromState` 里的原始行号是 1062
   （`return await persistTerminalState(runDir, state, "cancelled", "lease_lost")`，我自己 grep 出来
   的，见 §6），报告里贴的红跑调用栈第二帧是 `runLoopFromState ...:1068:14`，两者之差是 6 行——与
   `persistTerminalState` 函数体内插入变异代码（4 行核心代码 + 报告贴的代码块前后各留白/格式化）
   的合理插入量级吻合，且两处行号在"插入 N 行"这同一个假设下互相自洽（941 与 1068 对应同一个 N）。
   这不是决定性证明（我没有 literal 重跑，见 §6 的解释），但没有发现任何矛盾或可疑的错位。

4. **有没有把 `expect` 写成永不执行/永远成立的形式？** —— 没发现。`readEventTypes`/`readRunState`
   是从磁盘读取真实文件解析 JSON 的普通异步函数（我读了它们的定义，`tests/controller/
   runLoop.integration.test.ts:72-92`），不是桩/mock；`evaluateResumeEligibility` 是被 `import` 进来
   的生产函数本体，不是重新实现的假函数。控制组断言（`controlResult` 应为 `{ ok: true }`）我用生产
   代码逐条判据手算过，在这组 fixture 下确实会走到 `{ ok: true }`，不是巧合或摆设。

**结论：任务质量通过。** 测试形状符合 brief 对"能失败、断数据丢失本身、有鉴别力"的全部要求，且我用
独立的静态推导（不是信任报告的转述）证实了断言链条在今天代码上会产生报告声称的确切结果。

## 4. Findings

**Critical：无。**

**Important：无。** 我独立核对了任务范围内的全部承重断言（调用点计数、lease-loss 可达行号、状态机
终态表、续跑网关判据顺序、`INERT_LEASE_HEARTBEAT` 与 `initializeRunFiles`/`writeOwnerRecord` 的写入
顺序不冲突），没有发现足以推翻"规范符合"或"质量通过"结论的问题。

**Minor（2 条）：**

1. **报告 §4 对变异插入位置的描述不够精确，锚点仍隐含依赖行号算术。** 报告说变异插入在
   "`persistTerminalState` 函数体开头"，并贴出 4 行核心代码；但报告贴出的红跑调用栈
   （`persistTerminalState ...:941:11`，`runLoopFromState ...:1068:14`）与"紧贴函数体开头无空行插入
   4 行代码"这个字面描述对不上——按字面描述反推，`throw` 语句应落在新的第 939 行而不是 941 行。
   我用两处调用栈行号做了算术自洽检查（`1062→1068` 与 `937→941` 在同一个"插入 6 行"的假设下互相吻合，
   即变异代码块前后大概率各带一处空行/格式化，报告没有明说），结果自洽、未发现矛盾，但这依赖我事后
   反推，而不是报告本身把插入位置交代到能让人**不用算行号**就复核。**可构造场景**：另一名评审员如果
   直接照报告里"函数体开头插入"这句话 verbatim 复现变异（不带空行），会在第 939 行而不是第 941 行
   触发 throw，调用栈对不上报告贴的行号，可能误判"红跑证据造假"。级别定 Minor：不影响本次三步判据的
   实质结论（我已用其它独立路径核实过其正确性），但违反了 brief"锚点用符号名不用行号"的精神——报告
   本可以只贴"插在 `readOwnerRecord` 调用之后、`transitionRunState` 调用之前"这种符号锚点，不必让
   行号的精确复现成为交叉验证的唯一路径。
2. **§2 的"四个数字全部成立"结论稍有过度简化，`:1514` 与其余三个 lease-loss 检查点在控制流形状上并
   不完全对等，报告没有点出这一差异。** 我读了 `runLoop.ts:1499-1515`：`:1514` 处的
   `persistTerminalState` 调用前面多包了一层 `isTerminalRunStatus(state.status) ? state : ...`
   三元判断，只有当 `state.status` 还不是终态时才会真正调用到 `persistTerminalState`；而 `:1062`（本
   测试实跑覆盖的那个）没有这层前置门槛。报告 §2 第 2 点确实提到了这个三元表达式和它的 alternate
   分支，但把它和另外三个检查点一起归入"成立"时未特别指出"这一个的可达条件比其余三个多一层"这个结构
   性差异。**可构造场景**：任务 2 设计所有权守卫时，如果照抄 `:1062` 的"直接加门槛"方案套到 `:1514`，
   需要先想清楚它是在 `isTerminalRunStatus` 判断为 false 的分支里生效，行为分析不能简单复制。级别定
   Minor：不影响本任务"是否可达"这一判定本身（`:1514` 确实可达，只是可达路径的形状与另外三个不完全
   一样），只是报告的归纳颗粒度可以再细一点，供任务 2 的实施者注意。

## 5. 对实施者自报未验部分的裁定

逐条裁定控制器转述的四点自报缺口（不接受自证，也不替他辩护，独立判断）：

1. **「4 个 lease-loss 可达调用点只实跑 1 个，另 3 个仅静态核对」—— 真缺口，但严重度低，不影响本任务
   结论。** 我独立读了另外 3 处（`:1110`/`:1455`/`:1514`）的完整上下文，确认它们与 `:1062` 一样最终
   都调用同一个无所有权守卫的 `persistTerminalState` 函数体，行为在函数内部层面是同构的。但如 §4
   Minor #2 所指出，`:1514` 的可达路径比其余三个多一层 `isTerminalRunStatus` 门槛，结构并不完全等价
   ——静态核对是可信的，但"另外 3 个入口的动态行为与 :1062 完全一致"这个推论目前只有代码结构支持，
   没有实跑支持。brief 原文要求的是"钉住这条路径今天可达且是数据丢失"（单数"这条路径"，指
   `persistTerminalState` 无守卫这一件事），不是要求覆盖全部 4 个入口，所以这不构成规范违反，但任务
   2 设计所有权守卫时不能把"这 4 个入口行为完全等价"当作已证事实来用。
2. **「新 owner 已接管是直接写 owner-record.json 模拟的，非真实双进程竞态」—— 真缺口，但是可接受的
   标准技法，不构成本任务的质量问题。** 我核对了 `writeOwnerRecord`（`fileStore.ts:672-674`）就是
   一次普通的原子 JSON 写入，没有隐藏校验；同一技法在这个文件里已有既有测试在用（报告指出的
   `:1473`，我也独立 grep 确认该文件里 `writeOwnerRecord` 共 5 处调用，非本任务新发明）。brief 要求
   的是"实跑证明可达+丢数据"，没有要求"真实时序竞态"，双进程竞态测试是完全不同量级的工程（需要真实
   spawn 子进程、控制心跳时序），明显超出本任务范围。裁定：非缺口，是恰当的范围控制。
3. **「未验证另外 11 个非 lease-loss 调用点」—— 非缺口，在 brief 界定范围之外。** brief 明确把本任务
   的"这条路径"限定在"由 lease-loss 到达"，我读 brief 全文没有找到要求覆盖全部 15 个调用点的表述。
   如实标注未验证是对的做法，不构成任务质量问题。
4. **「未重跑 `npm run build`」—— 真缺口，但风险极低。** 我查了 `package.json` 的 `build` 脚本，核心
   就是 `tsc -p tsconfig.json`（再加一步写版本文件），报告里已经跑过的 `./node_modules/.bin/tsc
   --noEmit`（`TYPECHECK_EXIT=0`）覆盖了这个脚本里唯一会因为本次改动而失败的部分；本次改动之后
   `src/` 零改动（我已独立核实 `git diff --stat -- src/` 为空），`npm run build` 唯一可能捕获而
   `tsc --noEmit` 捕获不到的失败面（build 脚本末尾那步写文件的逻辑）与本次改动无关。裁定：如实自报
   是对的，但按现有证据风险可忽略，我评估后未消耗额外预算去重跑一次全量 build 来确认这一点（详见 §7
   预算记账）。

**综合裁定**：四点自报缺口里，1 与 4 是真缺口但严重度低，均不足以推翻"规范符合"或"质量通过"；2 与 3
经核实根本不构成缺口（分别是恰当的标准技法与恰当的范围控制）。

## 6. 探针记录（命令 + 未过滤输出）

**我未做任何代码改动**（含临时改后还原）——控制器给我的硬性纪律第 5 条明确禁止，所以下面所有探针都是
只读命令（`grep`/`Read`/`git status`/`git log`）加一次独立重跑既有测试（步骤 A），没有对 `src/` 或
`tests/` 做任何 `Edit`。这也是本报告"三步判据"里 B/C 两步只能做静态交叉验证、不能 literal 重跑的原因，
已在 §1/§5 说明。

### 探针 0 — 环境 sanity（先于一切检索）

```
$ grep -c '' src/controller/runLoop.ts
1561
```
非零，探针面是活的。

### 探针 1 — 独立重跑步骤 A（注入前绿），脚本先落盘再 `rtk proxy zsh` 跑，`set -x`，未过滤

脚本：`/private/tmp/claude-501/.../scratchpad/review-stepA.sh`（sanity 探针 + 目标测试，`-t` 精确匹配
测试名）。输出（逐字）：
```
+.../review-stepA.sh:6> grep -c '' src/controller/runLoop.ts
1561
+.../review-stepA.sh:8> ./node_modules/.bin/vitest run tests/controller/runLoop.integration.test.ts -t '...'

 RUN  v2.1.9 /Users/biran/code/skills/loop/ccloop/.worktrees/pkg2-data-loss

 ✓ tests/controller/runLoop.integration.test.ts (56 tests | 55 skipped) 114ms

 Test Files  1 passed (1)
      Tests  1 passed | 55 skipped (56)
+.../review-stepA.sh:9> echo EXIT_A=0
EXIT_A=0
+.../review-stepA.sh:10> git status --short
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task-1.md
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task1.diff
```
**具名测试非零计数复现：`1 passed`，与报告逐字一致。** `git status --short` 只有我自己的评审文件，
`src/`、`tests/` 均无残留改动——确认此刻代码库处于"变异已还原"的干净状态。

### 探针 2 — 独立复核扫描员 1 的四个数字（不看报告转述，自己 grep）

脚本：`/private/tmp/claude-501/.../scratchpad/review-stepB-numbers.sh`，输出（逐字）：
```
+.../review-stepB-numbers.sh:5> grep -c '' src/controller/runLoop.ts
1561
+.../review-stepB-numbers.sh:7> grep -n 'persistTerminalState(' src/controller/runLoop.ts
931:async function persistTerminalState(
1062:      return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
1110:          return await persistTerminalState(runDir, state, "cancelled", error.stopReason);
1119:          state = await persistTerminalState(
1150:        state = await persistTerminalState(
1173:        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
1218:          state = await persistTerminalState(
1292:          state = await persistTerminalState(
1301:        state = await persistTerminalState(
1327:        state = await persistTerminalState(
1338:        state = await persistTerminalState(runDir, state, "exhausted", BUDGET_EXHAUSTED_REASON);
1370:        state = await persistTerminalState(
1455:          return await persistTerminalState(runDir, state, "cancelled", "lease_lost");
1461:      state = await persistTerminalState(runDir, state, decision.kind, decision.reason);
1514:          : await persistTerminalState(runDir, state, "cancelled", error.stopReason);
1532:            state = await persistTerminalState(
+.../review-stepB-numbers.sh:9> grep -c 'persistTerminalState(' src/controller/runLoop.ts
16
+.../review-stepB-numbers.sh:11> grep -n cancelled: src/state/stateMachine.ts
11:  cancelled: [],
+.../review-stepB-numbers.sh:13> grep -n RESUMABLE_STATUSES src/controller/resumeLoop.ts
38:const RESUMABLE_STATUSES: readonly RunStatus[] = ["planning", "executing", "verifying"];
64:  if (!RESUMABLE_STATUSES.includes(runState.status)) {
```
16 行（1 定义 + 15 调用，行号列表）与实施者报告、扫描员 1 三方逐字一致；`cancelled: []`、
`RESUMABLE_STATUSES` 三态白名单同样逐字一致。

### 探针 3 — `Read` 独立确认 4 个 lease-loss 检查点、`evaluateResumeEligibility`、`writeOwnerRecord`、
`INERT_LEASE_HEARTBEAT`、`initializeRunFiles`（不经过 grep，逐段通读，用于 §2/§3/§4/§5 的所有具体
判断），锚点均用符号名：

- `src/controller/runLoop.ts`：`persistTerminalState`（931-941 全函数体，确认零次
  `readOwnerRecord`）、`runLoopFromState` 循环顶端到第一个 `leaseLoss.lost !== null`
  （1032-1119，确认 `while(true)` 顶端无条件 `writeRunState` 先于 `leaseLoss` 检查、`:1109`
  `isLeaseStopError` 分支）、第二处 `leaseLoss`/`isLeaseStopError` 三元分支
  （1440-1519，确认 `:1454`、`:1507`、`:1511` 注释、`:1514` 的 `isTerminalRunStatus` 门槛）、
  `isLeaseStopError` 定义（107-109，确认判定 `RunLeaseLostError`/`RunLeaseUnverifiableError`
  两种）、`INERT_LEASE_HEARTBEAT`（996-1002，确认全员 no-op/inert）。
- `src/controller/resumeLoop.ts`：`evaluateResumeEligibility` 全函数体（40-69，手工核对报告构造的
  fixture 在每条判据上的取值）。
- `src/persistence/fileStore.ts`：`writeOwnerRecord`（672-674，确认普通原子写入无隐藏校验）、
  `initializeRunFiles`（73-79，确认不写 `owner-record.json`，与随后的 `writeOwnerRecord` 调用无写入
  顺序冲突）。

### 探针 4 — git 元信息核对

```
$ git log --oneline -5
ed22305 test(controller): 补债 2 实跑注入 —— persistTerminalState 无所有权守卫的数据丢失
f6a35d0 docs(sdd): 包 2 实施阶段开工记账 ...
531ef32 docs(sdd): 包 2 任务 1 brief ...
15db1e1 docs(sdd): 包 2 worktree 与新工作区基线入账 ...
ddb604a docs(sdd): 记人裁 13 ...
$ git status --short
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task-1.md
?? .superpowers/sdd/2026-08-07-pkg2-data-loss/review-task1.diff
$ git branch --show-current
feat/pkg2-data-loss
```
提交 hash、分支均与控制器给的输入材料一致；工作树除本次评审新增的两个未入库文件外干净。

### 我没有做到的部分（如实列）

- **没有 literal 重跑三步判据的 B（注入后红）与 C（还原后绿）**——被硬性禁止修改任何代码（含临时改后
  还原）。改用 §1/§4 已述的静态交叉验证（两处调用栈行号的算术自洽、`evaluateResumeEligibility` 判据
  手工核算），没有发现矛盾，但这不是与报告等价的独立复现，如实标注这一限制的性质，不假装等同于
  literal 重跑。
- **没有重跑全量 `vitest run` / `npm run build`**——预算与成本考虑（会话累计成本已过控制器提示的
  阈值），且 §5 第 4 点已给出不重跑的风险评估依据。
- **没有验证另外 11 个非 lease-loss 调用点、没有做真实双进程竞态复现**——与实施者相同的范围边界，
  §5 已裁定这两点均在 brief 范围之外，不构成本任务的验证缺口。

## 7. 预算记账

上限：单任务 100,000 tokens（本任务指令 / Rule 6）。没有精确的逐 token 计数器，以下是基于工具调用量
与内容体积的诚实估计，口径与实施者报告 §8 一致：

- 强制读取的三份输入：`task-1-brief.md`（92 行）、`task-1-report.md`（381 行全文）、
  `review-task1.diff`（557 行，一次性 `Read` 全量）——这三份合计约 1030 行是开工前必读项，单这一批
  体量就不小（`review-task1.diff` 尤其大，包含完整报告正文的逐字重复）。
- 独立核验：约 8-10 次 `Read`/`Bash grep`（`runLoop.ts` 多段、`resumeLoop.ts`、`stateMachine.ts`、
  `fileStore.ts` 多段），单次 `Read` 常在 30-90 行区间；4 个探针脚本落盘 + 4 次 `rtk proxy zsh`/
  `Bash` 执行。
- 报告写作：1 次 `Write`（骨架）+ 7 次 `Edit`（逐节填充，每节含较长的论证文字，部分段落较长）。

**估计总量落在约 55,000-75,000 tokens 区间，在 100,000 上限之内，未破线。** 会话累计成本在执行期间
收到过控制器/环境的成本提示（约 $144，这是跨多个子任务的会话累计值，不是本任务单独的成本），但本任务
自身预算按上述估计未超上限，如实记录、不隐瞒这一环境层面的提示信息，供控制器复核。
