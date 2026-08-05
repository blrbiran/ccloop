# L3 — Sweep（触发层）与转移事务的跨文件原子性

Status: drafted 2026-08-01。**经四轮独立评审对着代码撞过之后四次大幅修订，外加一次人裁触发的定向修复波（第五波，见本行末与 §20）**：第一轮三个独立评审员撞出 16 条 Critical（索引见 §16），**第二轮另派三个错开视角的评审员对着第一轮的修复波撞出 47 条**（索引见 §17，其中 4 条推翻或更正了第一轮修复本身），**第三轮再派三个对着第二轮的修复波撞出 16 条阻塞（6 Critical ＋ 10 Important）＋ 一批记账类**（索引见 §18，其中 G1/G2 证明第二轮那处最承重的改判既没关闭它要修的缺陷、也没有任何有效护栏），**第四轮再派三个对着第三轮的修复波撞出 6 条 Critical ＋ 10 条 Important ＋ 9 条 Minor ＋ 一条 `grep` 用法规矩**（索引见 §19，其中 C1–C4 证明第三轮为 §4.3 排序改判新写的论证与新写的变异**仍然**不成立——连续三轮零有效护栏）。**第三轮有两次人裁**（marker 原子写的连带范围 G11 → 三份 pending 一并原子化；两处 Rule 7 冲突的取舍 G13 / G15）；**第四轮有一次人裁**（§4.3 处置一「放弃这次 reconciliation 写」的可观测面 = 跳过 ＋ 追加一条具名事件，见 §4.3）。**第五波不是评审轮，是一次人裁触发的定向修复波**：人**推翻了第四轮对同一件事的后半段判断**——那条放弃**必须路由到 sweep 的 stderr**，不接受「落盘但不路由」（索引见 §20；改动限于 §4.3 / §8 / §9 / §10 测试 12d / §15 验收 1b 与验收 9 / §13 第 4 笔 / 本行）。**第六波是对第五波的一轮定向评审 ＋ 一次注入实验**（索引见 §21）：撞出 3 条 Critical（abandon 块里的裸 `appendEvent` 会把一次保护性放弃升级成 attempt failed；测试 12d(iv) 的驱动 fixture 按字面不可构造；**「必须红」的达标判据全文缺少具名归因**——实测 6e 变异二今天就杀掉 6 条与它无关的既有测试）＋ 4 条 Important ＋ 3 条 Minor；**代码仍然一行未动**。本文是父设计 `2026-07-22-ownership-and-reconciliation-boundaries-design.md` §17 item 2 的**后半**（触发），前半（发现）由 L2 `2026-07-28-run-registry-design.md` 完成。

> **「第三轮 16 条阻塞」在第三轮的 spec 里被写成 12，两处（本行与 §18 背景段），且*两处都没有重推命令*——恰好违反 §17 末尾第三轮自己升级的那条规矩。** 第四轮就地改对并附命令：
>
> ```bash
> F=docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
> grep -nE '^\| G[0-9]' "$F"      # 只印 §18 的 G 行（行首锚定，不会命中正文里对 G 行的引用）
> #                                  需要正则：只看输出行，退出码不作为论据
> # ⚠️ **不要用 `grep -nF '| G'`**：它会连同正文里对本规矩的引用一起数进去（本轮实测 30 行，
> #    其中 5 行不是 §18 的表行）。**这是本轮第二个「按模式串计数会数到自己」的实例**，
> #    与 §11 那条 `-E` 命令计数踩的是同一个坑。留痕不删。
> # 实测（第四轮，行首锚定版）：G 行共 **25** 行，级别列逐行为
> #   Critical 7：G1 G2 G3 G4 G6 G11 G12b
> #   Important 9：G7 G8 G9 G10 G12 G13 G14 G15 G16
> #   Minor 1：G5（且它被判定为「不成立」）
> #   记账 8：G17–G24
> # 阻塞 = Critical 7 + Important 9 = **16**。
> ```
>
> **⚠️ 「6 Critical + 10 Important」这个分拆是错的**（它来自第三轮控制器的派单与 handoff 的 Executive Summary，不是从表里数出来的）：实际分拆是 **7 + 9**，差异全部来自 G12b —— 它在表里是独立一行、标 `**Critical**`，而派单口径把它并进了 G12。**合计 16 两边一致，分拆不一致。** 本文档以表为准。

> **本文不写死行号。** 所有代码锚点用「文件名 + 符号名」，并在旁边附一条能重推它的 `grep`。
> **每一个算出来的数字旁边必须就地附重推命令。** 初稿有 13 处数字没附命令，其中 **2 处是错的**；而每一处附了命令的数字都是对的。这条规矩在本文档自己身上又验证了一次。

## 1. 目的

让一个**已经具备续跑资格**的 run 在无人值守条件下被真正续跑，并在此过程中消除两笔被裁决归属本层的债：

- **债 1 — 跨文件事务性**：`owner-transfer.json` 已原子发布、而 `reconciliation-record.json` 要等一个**会抛的** `assertHeld()` 之后才写。第三方在此窗口 supersede，就留下「eligible 但无 reconciliation」的磁盘状态，`resumeLoop` 随即拒绝。这是 **liveness 洞**，不是安全洞。
- **债 3 — `heartbeat.stop()` 释放窗口**：`stop()` 只 await 了它读到的那一个 `queue` 快照，而 `runExclusive` 会重新赋值 `queue`。

裁决记录：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md`。债 2 留给 L5，本层不碰。

## 2. 范围与非目标

**做：**

1. 新增 `ccloop sweep <root>`：扫一次 registry → 对每个观测为 eligible 的 run 顺序调 `resumeLoop` → 退出。
2. 债 1：`reconciliation-record.json` 加入**已有的**转移事务，成为第三个参与文件。
3. 债 3：收紧 `runExclusive` 语义 + 增加一个停机信号槽。

**不做（每条都是刻意的）：**

1. **不发起 transfer。** sweep 永不创建所有权决策，只消费已发布的。全仓库唯一能发布 transfer 的生产路径是 `persistBoundaryAnalysis` → `persistOwnerTransfer` → `writeOwnerTransferArtifacts`；`writeOwnerTransferArtifacts` 只有 `persistOwnerTransfer` 一个生产调用者，而 `persistBoundaryAnalysis` 的**两个**调用点都在 `runLoopFromState` 内部——**transfer 只由活着的控制器发布**。被硬杀的进程不会留下 eligible transfer，那类 run 本层碰不到（属 L5）。

   ```bash
   grep -rnF -e 'writeOwnerTransferArtifacts(' -e 'persistOwnerTransfer(' -e 'persistBoundaryAnalysis(' src/
   ```

2. **不常驻、不轮询、不并发。** 顺序执行，跑完退出。
3. **不做 orphan / cleanup / GC。** 父设计 §17 item 3，属 L5。
4. **不合成 reconciliation，也不放松 `resumeLoop` 对它的必需性。** 裁决记录明令禁止——那是引入新授权。见 §4.0 的 S-3。
5. **不修债 2**（`persistTerminalState` 往已不拥有的 run 写）。

## 3. 授权立场（措辞已按评审收窄）

**L3 不引入任何新授权。** 但初稿把这一点说成「本层不改任何写路径」，那是**假的**——§4 改的正是转移写路径，§5.4 还新增一个写触发点。正确的、可检验的表述分三条：

1. **sweep 自身不新增任何 writer。** `sweepRuns.ts` 只调 `scanRuns` 与 `resumeLoop`，自己不 open/write 任何 run 目录下的文件。
2. **但 sweep 会*导致*写入，这是预期行为，必须承认。** `resumeLoop` 在**任何门之前**就 `appendEvent(runDir, { type: "resume_requested" })`，四条拒绝路径各再追加一条 `resume_denied`。所以一个「观测 eligible 但门拒绝」的 run 目录**确实会变**。

   ```bash
   grep -nF -e 'type: "resume_requested"' -e 'type: "resume_denied"' src/controller/resumeLoop.ts   # 1 + 4 处
   ```

   **⚠️ 上面那条 grep 只扫 `resumeLoop.ts`，据它下「恰好两行」的绝对断言是错的**（第二轮评审撞出，本仓库最近三轮反复吃亏的同一个错法）。`resumeLoop` 调用的 `checkRunLease` 自己也写事件：租约存在但已过期时它**先追加 `lease_expired_observed` 再放行**，控制继续往后面的门走。

   ```bash
   grep -nE 'appendEvent|lease_expired_observed' src/controller/leaseGate.ts   # 需要正则：只看输出行，退出码不作为论据
   # 实测：:2 import、:58-59 追加 lease_expired_observed，随后 :63 return { kind: "expired" }
   grep -cF 'appendEvent(' src/controller/resumeLoop.ts
   # 实测输出 6。**第三轮更正：第二轮写的「5 个追加点」错了**（漏数 resume_adopted 那一处）。
   # 6 = 1 resume_requested（:88）+ 4 resume_denied（:97 租约门 / :119 读失败 /
   #     :125 资格门 / :143 CAS 门）+ 1 resume_adopted（:147）。
   grep -rnF 'appendEvent' src/controller/leaseGate.ts
   # 实测 exit 0，命中 2 行：:2 import、:58 追加 lease_expired_observed
   ```

   **sweep 会导致的写入，完整清单**（每一条都对着代码核过）：

   1. `resume_requested`（无条件，第一条语句）。
   2. `lease_expired_observed`（**仅当** `owner-record.json` 的 `leaseAffirmedAt` 非 `null` 且已过 TTL；`leaseAffirmedAt === null` 走 `no_lease` 分支，不写事件）。
   3. `resume_denied`（四条拒绝路径各一条）或 `resume_adopted`（放行）。
   4. **CAS 拒绝路径上的文件系统副作用**：`claimOwnerRecordWithPrecondition` → `acquireOwnerTransferLock`（建后删 `.owner-transfer.lock`）→ `recoverInterruptedOwnerTransfer(runDir, { lockHeld: true })` → 无 marker 时 `cleanupOwnerTransferStagingWithoutMarker` **删掉若干 staging 文件**；有 marker 时直接 finalize 整个待决事务。

      ```bash
      grep -nF -A12 'export async function claimOwnerRecordWithPrecondition(' src/persistence/fileStore.ts
      grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
      ```

   5. `readOwnerRecord` 本身（`resumeLoop` 的 `Promise.all` 第一项）**也**跑 `recoverInterruptedOwnerTransfer`，且它走的是 `lockHeld` 未传的分支——见 §10 测试 14 与 §15 验收 6 对断言范围的收窄。

   初稿的「不往任何 run 目录写一个字节」按字面为假，且它对应的测试（旧测试 14）只测了**不** eligible 的目录——那种目录 sweep 根本不碰，所以那条测试**证明的是过滤器有效，不是零写入**。已按 L2 `tests/registry/zeroWrite.test.ts` 的承重形状重写，见 §10 测试 14。
3. **L3 改动的两条写路径都只增加拒绝或记录属主有权做的终态**，不新增许可：
   - `evaluateResumeEligibility` 的**八条**判据一条不动。

     ```bash
     grep -cF 'return { ok: false' src/controller/resumeLoop.ts    # 期望 8
     ```
   - §4 让原本可能丢失的 reconciliation 进入事务，只减少「合法转移无法续跑」，不放宽任何准入。
   - §5.3 让 `runExclusive` 在 `stopped` 后**拒绝**，纯增加拒绝。
   - §5.4 的停机信号**不写终态**（见 §5.4），只追加事件。

registry 观测到的 `eligibleForContinuation` 仍然**不是决策**（L2 spec §6、§7.3）。sweep 拿它当「值得一试」的过滤器，最终裁决权完全在 `resumeLoop` 的门。门拒绝是系统按设计工作，不是错误。

## 4. 债 1 — reconciliation 加入转移事务

> **本节是独立的一节、独立的任务组、独立的评审，并且必须完成并通过独立评审之后，§6 的任务组才可开始。**
>
> **这个要求是裁决记录*两处*合起来的结果，不是任何一处的原文**（初稿写成「裁决记录原文是『独立一节、独立任务组、独立评审，先于触发逻辑』」——那句话在裁决记录里不存在，是本 spec 把两处拼接后冠以「原文」，而本文档自己把「引全句、不得拼接冠以原文」立为铁律）。两处分别是：
>
> - 「结论速查」表格债 1 行的括注：**「**L3**（spec 内独立一节，先于触发逻辑）」** —— 给出「先于触发逻辑」，但只说「独立一节」，不含「独立任务组、独立评审」。
> - 「执行约束（人下的指令）」节：**「债 1 在 L3 spec 里必须是独立的一节、独立的任务组、独立的评审，不得与触发逻辑混在同一批任务里。」** —— 给出三个「独立」，但不含「先于」二字（它说的是「不得混在同一批任务里」，那是并列关系，不是先后关系）。
>
> 另有一处「执行顺序」第 2 条写「其中债 1 作为独立一节先于触发逻辑落地」，同时含「独立一节」与「先于」，但不含「独立任务组、独立评审」。**三处都不含另外那一半，所以「原文」只能是拼接。**
>
> ```bash
> grep -nF -e '先于触发逻辑' -e '独立的一节、独立的任务组、独立的评审' \
>          docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
> # 实测 exit 0，命中 3 行（**第三轮更正：第二轮写的「4 行」是本轮唯一一个错的数字，
> # 而它偏偏附了命令 —— 说明贴命令的人没真跑它**）：
> #   :18  结论速查表格债 1 行
> #   :33  执行顺序第 2 条
> #   :124 执行约束节
> ```
>
> 理由（本层自己给的，不冒充裁决记录）：sweep 先落地就等于把触发层挂到一条已知损坏的续跑路径上。

### 4.0 S-3 退路与被禁止的退路（初稿完全遗漏，本节补回）

#### 4.0.1 裁决记录的原文部分

裁决记录「若修法方向不可行时的退路（S-3）」一节，**引全句**：

> 若 L3 的 brainstorming 判定「reconciliation 加入 owner-transfer 事务」不可行，**L3 不得就地发明替代方案**，而应回到本记录重新裁决债 1 的归属与形式。理由：本记录把债 1 判给 L3 的依据是「它是 L3 的功能前提」，不是「这条修法可行」——前者不因后者失败而改变，但**处理形式**（L3 内一节 / 独立分支 / 单开一层）必须重新定。

同节的**被明确禁止的退路**，同样引全句：

> **明确禁止的退路**：放松 `resumeLoop` 对 reconciliation 的必需性（例如「若存在则校验，不存在则跳过」）。那是**引入新授权**，违反 L1/L1b/L2 三层共同的「只增加拒绝，绝不新增许可」边界。缺失即拒绝的 fail-closed 行为必须保留。

```bash
grep -nF -e '若修法方向不可行时的退路（S-3）' -e '明确禁止的退路' \
         docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
```

**以上是裁决记录给的全部。裁决记录没有给触发条件。** 下一小节的触发条件是**本层就地发明的**，不是原文，读者不得把它当成裁决记录的要求。

#### 4.0.2 触发条件（本层就地定义，**非裁决记录原文**）

若实现中发现事务化需要在恢复路径上新增一类**静默**失败模式、或需要改动 `finalizePendingOwnerTransfer` 的 catch **语义**（而不只是对称地多一个 `safeUnlink`，见 §13），**停下，回到裁决记录，不要发明变体。**

这条触发条件是本层的安全阀。**它在第二轮评审中被真实命中过一次，且已被解除；下面记录全过程，不得因为「已经解除」而把它删掉或弱化。**

#### 4.0.3 S-3 命中一次的记录与解除方式（人已裁定）

**命中过程**：§4.4 把 marker 从「写下但从不读取」改判为**被解析**的承重字段。评审随即撞出：marker 今天用 `writeJsonFile`（裸 `writeFile`，非原子）写。

```bash
grep -nF 'await writeJsonFile(paths.transactionMarkerPath, marker);' src/persistence/fileStore.ts
grep -nF -e 'async function writeJsonFile(' -e 'async function writeJsonFileAtomically(' src/persistence/fileStore.ts
# 实测：marker 走的是 writeJsonFile（裸 writeFile），writeJsonFileAtomically 是另一个函数
```

掉电 / ENOSPC 可留下截断的 marker。marker 一旦被解析，截断的 marker 就让该 run 的 `readOwnerRecord` 永久抛——而 `recoverInterruptedOwnerTransfer` 是 `readOwnerRecord` 的第一条语句，`readOwnerRecord` 又是 `resumeLoop` 的 `Promise.all`、`writeOwnerTransferArtifacts`、`claimOwnerRecordWithPrecondition`、`updateOwnerRecordWithPrecondition` 的必经之路。**这正好是「恢复路径新增一类失败模式」，且 §2 把 cleanup/GC 排给了 L5，本层无恢复入口 —— 触发条件成立。**

**解除方式（人下的裁定，走最小解）**：**把 marker 改成原子写（temp + rename，与既有的 `writeOwnerRecordAtomically` 同法）**。

```bash
grep -nF -A5 'async function writeOwnerRecordAtomically(' src/persistence/fileStore.ts
# 实测：safeUnlink(temp) → writeJsonFile(temp) → rename(temp, target)，即本层要照抄的形状
```

#### 4.0.3a 第二次裁定：三份 pending 一并改原子写（第三轮，人已裁定）

**第二轮修复只把 marker 原子化，于是「S-3 不触发」这个结论的证据范围与它的措辞不匹配。** 原子 marker 只消掉**一条**通向永久钉死的路由；`finalizePendingOwnerTransfer` 在 try **之前**还要 `JSON.parse` 每一份 pending，而三份 pending 走的都是裸 `writeJsonFile`：

```bash
grep -nF -e 'await writeJsonFile(paths.transferPendingPath' -e 'await writeJsonFile(paths.ownerPendingPath' -e 'await writeJsonFile(paths.transactionMarkerPath' src/persistence/fileStore.ts
# 实测 exit 0，命中 3 行：:675 transferPending、:676 ownerPending、:677 marker —— 全是裸 writeJsonFile
grep -nF -A4 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
# 实测 exit 0：:608 签名、:610 与 :611 是 try 之前的两次 readFile + JSON.parse
```

**一份被截断的 pending 通向的是与截断 marker 逐字相同的终态**：marker 在盘 + `readOwnerRecord` 每次都重复同一次抛出 + 本层无恢复入口。**证据范围只覆盖 marker、结论却说成整条触发条件不成立 —— 那是结论盖过证据。**

**人已裁定（第三轮）**：**三份 pending 也改成原子写（temp + rename），与本节 marker 的修法逐字同形。**

新增三个 pending temp 常量：`.owner-record.pending.tmp`、`.owner-transfer.pending.tmp`、`.reconciliation-record.pending.tmp`（命名与既有 `<被暂存的产物名>.pending.json` 一一对应，见 §4.3 的常量表）。

**两次裁定合起来之后，S-3 才真正不触发。** 完整论证（**两条路由都覆盖，不再只覆盖 marker**）：

| 通向永久钉死的路由 | 今天为什么可达 | 原子化之后为什么不可达 |
|---|---|---|
| marker 被解析、且被截断 | marker 裸 `writeJsonFile` | rename 前读者看到「无 marker」，rename 后看到「完整 marker」，无第三态 |
| 任一 pending 被解析、且被截断 | 三份 pending 裸 `writeJsonFile`，finalize 在 try 之前 parse 它们 | 同上；pending 只有「不存在」与「完整」两态，而「不存在」由 §4.4 规则 2 的 fail-closed 分支接住 |

**所以那类新失败模式在两条路由上都不存在，S-3 不触发**，§4.4 的 marker 驱动方案原样保留。§4.4 规则 2 与规则 3 的 fail-closed 分支**仍然保留**，作为纵深防御而非可达路径。

**连带收回**：第二轮把「三份 pending 的非原子写」作为第 4 笔推给 L5（§13）。**本轮收回本层。**

**⚠️ 但 §13 的条数与合计*没有*变，不要顺手把它们减一。** 同一轮里 §4.3 的残余 TOCTOU（G1）新占了第 4 笔的位置，所以是**一出一进**：**清单仍是 5 笔，L5 输入合计仍是 6 项。** 对照表见 §13 开头。（**这一句本身就是本轮差点犯下的错**：先写了「5 → 4、6 → 5」，被同一波里更晚的编辑作废；本仓库已两次栽在这个形状上，故就地留痕。）

**这次命中留下的教训**：S-3 的触发条件是有效的——它在一份已经过一轮修复的 spec 上仍然抓到了东西。**不要因为它这次是被「最小解」解除的，就以为它下次也会。**

#### 4.0.4 对裁决记录「更窄」判断的回应（第二轮更正：初稿伪造了论证结构）

**第一轮修订在这里写错了**，且错法是本仓库最忌讳的一种：它写「裁决记录的『这条路比裁决时判断的更窄』有**两条**依据：(a) `newOwnerEpoch` 的排序主张；(b) `assertHeld` 是写者」，然后宣布 §4.1 驳倒了 (a)。**(a) 是本 spec 自己造出来再打倒的——裁决记录从未把它列为「更窄」的依据。** §16 第 11 行还把这个伪结构固化进了修订索引，会被 L5 继承。

对着裁决记录原文重读，**那两段是两件事**：

```bash
grep -nF -e '否决的方向' -e '评审补充的判断' \
         docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
# 实测 exit 0，命中两行，分属「修法方向可行性」一节的两段
```

- **「否决的方向」段（引全句）**：「『先写 reconciliation，再发布 owner-transfer』做不到——reconciliation 的 `newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道（`runLoop.ts` 的 `nextOwnerEpoch = transfer.ownerRecord.currentOwnerEpoch;`）。」
  这是一条**独立的否决**，否决的对象是「先写 reconciliation 再发布 transfer」这条路。**本 spec 根本没走这条路**（§4.3 走的是把三个文件放进同一次事务）。§4.1 驳倒的是**这一条**——它与「更窄」无关。
- **「评审补充的判断」段（引全句）**：「上面『真实缺陷』一节查实 `assertHeld` 本身就是写者（追加事件），这削弱了问题 1 里『不得扩大读会写』那条反对意见的分量——写路径早已不纯。但同时它也说明这条修法要动的东西比初稿设想的多。**「加入事务」这条路比裁决时判断的更窄，L3 不应假定它一定成立。**」
  **「更窄」这个结论只有这一条依据：`assertHeld` 本身就是写者，说明要动的东西比初稿设想的多。**

**因此正确的结论是**：

1. 裁决记录对「更窄」只给了**一条**依据，**这条成立**。本轮评审进一步证实了它——真正要动的东西包含 marker 语义与 marker 的写法、**三处** staging 回收路径的扩容、finalize 的 catch 尾部、以及组装点的 epoch 来源。
2. 另有一条**独立的**否决（「先写 reconciliation 再发布 transfer」做不到，因为 `newOwnerEpoch` 只能事后取到）。§4.1 驳倒的是**那一条**。它与「更窄」无关，**也不改变「更窄」成立**。
3. 「更窄」成立，正是本节必须是独立任务组、独立评审的原因。

### 4.0a 裁决记录留给 L3 的问题 1，正面回答

裁决记录留了两个问题给 L3 spec，并写明「本轮不预设答案」。初稿答了问题 2（签名改动），**问题 1 一次都没点名**。补答如下。

> **问题 1**：`recoverInterruptedOwnerTransfer` 是否也要负责 finalize reconciliation？会扩大「读会写」的范围——而 L2 整层的设计正是围绕规避这一点建立的（禁用 `readOwnerRecord`）。

**答：是，必须由它负责，且这不扩大「读会写」的类别。**

理由三条：

1. **它今天已经是写者。** 第三个文件加入的是**同一次**写，不是新增一类写。

   **数字更正（第二轮评审，2/3 撞到）**：第一轮修订在这里写「已经会做**两次 `rename` 加三次 `safeUnlink`**」，**没附重推命令**——本文档自己立的核心规矩在新写的段落上被自己破了，而且这个数字与同文档 §4.1 的九步枚举直接打架。实测两条路径：

   ```bash
   grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   grep -nF -A6  'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
   grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
   ```

   - **marker 在 → `finalizePendingOwnerTransfer`**：try 内成功路径是 **2 `rename` + 5 `safeUnlink`**（先清 2 个 temp，双 rename 之间无 unlink，尾部再清 marker + 2 个 pending）；进 catch 时另有 **2 `safeUnlink`**。与 §4.1 的九步枚举一致。
   - **无 marker 且 `options.lockHeld` 为真 → `cleanupOwnerTransferStagingWithoutMarker`**：**4 `safeUnlink` + 0 `rename`**（2 个 pending + 2 个 temp）。
   - **无 marker 且 `lockHeld` 未传**：零写。

   本层之后这两个数都要涨，见 §4.3 与 §13。
2. **不让它负责就没有原子性可言。** 事务的定义就是「崩溃后由恢复推完」。把 reconciliation 排除在恢复之外，等于宣布它不在事务里。
3. **L2 的零写入保证不受影响，因为 L2 从不调 `readOwnerRecord`。** L2 spec §7.1 的做法是**禁用**这个函数、改用 `readOwnerRecordWithoutRecovery` 与只读观测。本层不改 L2 一行代码（§9），所以 L2 的保证按原样成立。

**但有一个必须记下的语义后果**（评审发现，初稿没有）：`readPersistedSuccessfulTransferArtifacts` 用 `Promise.all` 并行读三个文件，其中 `readOwnerRecord` 会触发恢复。本层之后，那次恢复**会写 `reconciliation-record.json`**，也就是这个「快照」自己的第三个读目标。**它本来就不是快照**，本层只是让这一点变得可观测。真正承载 fail-closed 的不是快照性，是 §4.3 末尾那两条 epoch 相等判定——见那里。

### 4.1 当前形状

```bash
grep -nF -e 'const OWNER_TRANSFER_MARKER_FILE' -e 'type OwnerTransferTransactionMarker' \
         -e 'async function finalizePendingOwnerTransfer' -e 'async function recoverInterruptedOwnerTransfer' \
         -e 'async function cleanupOwnerTransferStagingWithoutMarker' \
         -e 'export async function writeOwnerTransferArtifacts' src/persistence/fileStore.ts
```

事务由 `writeOwnerTransferArtifacts` 驱动：取锁 → 恢复任何遗留事务 → CAS 比对持久化的 owner record → 暂存两个 pending + 一个 marker → `finalizePendingOwnerTransfer` → 释放锁。

**`finalizePendingOwnerTransfer` 不是「两次 rename」**，它是九步：`safeUnlink(transferTemp) → safeUnlink(ownerTemp) → writeJsonFile(transferTemp) → rename → writeJsonFile(ownerTemp) → rename → safeUnlink(marker) → safeUnlink(transferPending) → safeUnlink(ownerPending)`，外加一个只清**两个** temp 并重抛的 catch。初稿把它简化成「两次/三次 rename」，因此 §4.3 的中间态枚举不穷尽——已修正。

**两个必须先说清的事实：**

1. **marker 的 `finalizeOrder` 字段被写下、却从未被读取。** `finalizePendingOwnerTransfer` 按硬编码顺序直接读两个 pending。这是一个无人核对的主张。**本设计把它变成承重字段**（§4.4）。
2. **`newOwnerEpoch` 在事务开启前就已知。** `applyOwnerEpochTransfer` 是纯同步函数，`nextEpoch = ownerRecord.currentOwnerEpoch + 1` 是它的第一条语句，`persistOwnerTransfer` 在任何 I/O 之前就调用它。

   ```bash
   grep -nF -A8 'export function applyOwnerEpochTransfer(' src/ownership/ownerController.ts
   grep -nF -e 'const transfer = applyOwnerEpochTransfer(' -e 'await writeOwnerTransferArtifacts(' src/controller/runLoop.ts
   ```

   裁决记录的「`newOwnerEpoch` 要等 `persistOwnerTransfer` 返回才知道」只对 `persistBoundaryAnalysis` 的**解构视角**成立，不是排序上的硬约束。

   **⚠️ 这条事实只用来驳倒裁决记录那条独立否决（§4.0.4），不构成「本 spec 可以自己再算一遍 `+ 1`」的许可。** 增量规则的唯一权威实现是 `applyOwnerEpochTransfer`；本层不得复制它，见 §4.3「组装点改判」。

### 4.2 reconciliation 的九个字段：八个在事务前已知，`newOwnerEpoch` 由事务内部填

（**标题已按第二轮评审更正**：初稿写「九个字段在事务前全部已知」。技术上 `newOwnerEpoch` 的**值**确实事务前可推（§4.1 事实 2），但**不得由第二处代码去推**——见 §4.3「组装点改判」。「已知」与「该由谁算」是两件事，初稿把它们混成了一件。）

| 字段 | 来源 | 计算位置 |
|---|---|---|
| `staleSuspicionBasis` | `boundaryEvidence.continuitySuspicion` 或 `boundaryAnalysis.staleCandidateReason` | `runExclusive` **之前** |
| `staleConfirmed` | 字面量 `true` | — |
| `ownershipVerdict` | `ownership.verdict`；transfer 分支内已知为 `OWNER_LOST` | `runExclusive` 内 |
| `lastTrustedBoundary` | `ownership.lastTrustedBoundary` | `runExclusive` 内 |
| `conflictingEvidence` | `boundaryEvidence.conflictingEvidence` | `runExclusive` **之前** |
| `takeoverPermission` | **`{ allowed: ownership.takeoverAllowed, reason: buildTakeoverReason(ownership.takeoverAllowed) }`** —— 是一个对象，不是布尔；`buildTakeoverReason` 必须一起调 | `runExclusive` 内 |
| `priorOwnerEpoch` | `ownerRecord.currentOwnerEpoch` | `runExclusive` 内 |
| `newOwnerEpoch` | **`transfer.transferRecord.newOwnerEpoch`**，即 `applyOwnerEpochTransfer` 的输出 | **`persistOwnerTransfer` 内、`applyOwnerEpochTransfer` 之后**（改判，见 §4.3「组装点改判」） |
| `eligibleForContinuation` | 成功路径上是类型级 `true`（`persistOwnerTransfer` 的返回类型钉死） | — |

**⚠️ 第四轮更正一处抄漏**：本表与 §15 验收 5 的变异表在第三轮都把 `evaluateResumeEligibility` 第 1 条判据抄成了 `ownerTransfer.eligibleForContinuation !== true`，**漏掉了源码里的 `as boolean` cast**：

```bash
sed -n '42p' src/controller/resumeLoop.ts
# 实测：`  if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {`
```

**抄漏的不是一个符号，是动机**：cast 的存在说明该字段的静态类型**不是** `boolean`，第 1 条判据防的正是非布尔的运行时取值（`undefined` / `null` / `"true"` / `0`）。**这直接导致 §15 验收 5 为它建议的 `!== true` → `=== false` 变异成为等价变异**（对布尔取值两写法等价），见那里的更正与补法。

```bash
grep -nF -e 'const boundaryEvidence = buildBoundaryEvidence(' -e 'const evaluateOwnershipFor =' \
         -e 'if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST"' \
         src/controller/runLoop.ts
grep -nF -A20 'reconciliationRecord:' src/controller/runLoop.ts
grep -nF -A10 'export type ReconciliationRecord' src/runtime/types.ts     # 期望印出全部九个字段
```

（**刻意不接 `| head`**：管道会把 `grep` 的退出码换成 `head` 的，而且 `head` 会**提前截断输出**，让「命中几行」这件事不可复核。**纪律的准确范围是「不接会截断输出的管道」**——第二轮评审指出，初稿把它写成「不接任何管道」，而 §9 自己用了 `| wc -l`，两处直接打架。`| wc -l` 同样覆盖退出码，所以本文档的处置是：**凡是要数数的地方一律改用 `grep -c`**，不用 `| wc -l`；§9 已照此改。）

### 4.3 新形状

| 项 | 内容 |
|---|---|
| 新常量（**6 个**，第四轮更正；第三轮标的「7 个」与它自己下一行的枚举矛盾） | 发布面 **2** 个：`.reconciliation-record.pending.json`、`.reconciliation-record.publish.tmp`；原子写 temp **4** 个：`.owner-transfer.transaction.tmp`（marker，§4.0.3）、`.owner-record.pending.tmp`、`.owner-transfer.pending.tmp`、`.reconciliation-record.pending.tmp`（三份 pending，§4.0.3a）。**2 + 4 = 6** |

**⚠️ 「7 个」是错的，逐条给依据（第四轮，Important）：**

1. **它与自己那一格的枚举矛盾**：枚举出来是 2 + 4 = **6** 个，逐个数具名常量也是 6 个。
2. **它与同一张表的 cleanup 一行矛盾**：那一行写「新增 **6** 个逐个具名」，而 **4 + 6 = 10** 正是全文联动的那个 10。若新常量真是 7 个，cleanup 就该是 4 + 7 = 11，与四处（现为六处）联动的 10 全部对不上。
3. **既有常量实测是 5 个，不是 4 个**，所以「7」在「总数」这个口径下也不成立：

   ```bash
   grep -nE 'pending.json|publish.tmp|transaction.json' src/persistence/fileStore.ts   # 需要正则：只看输出行，退出码不作为论据
   # 实测 exit 0，命中 5 行：:326 .owner-record.publish.tmp、:327 .owner-transfer.publish.tmp、
   #   :328 .owner-record.pending.json、:329 .owner-transfer.pending.json、
   #   :330 .owner-transfer.transaction.json
   ```

   落地后总数 **5 + 6 = 11**。**「7」在任何口径下都不成立。**

**错误来源（就地留痕）**：第二轮的 F8 写的「4 → 7」是**常量总数**的口径（当时既有 4 个 staging 常量 ＋ 新增 3 个）；第三轮按 pending 原子化重列枚举时把内容改对了、**标签没改**，于是「7」从「总数」悄悄变成了「新增数」。**这是本仓库第三次栽在「数字被同一波里更晚的编辑作废」上**（前两次见 §4.0.3a 的就地留痕与 §13 的一出一进对照表）。
| **常量命名（第三轮更正）** | 第二轮写的 `.reconciliation.pending.json` / `.reconciliation.publish.tmp` **与既有约定不对齐**。既有四个常量都是「**被暂存产物的文件名去掉 `.json`**」＋后缀：`owner-record.json` → `.owner-record.pending.json` / `.owner-record.publish.tmp`。第三个文件叫 `reconciliation-record.json`，按同一规则应为 `.reconciliation-record.*`，不是 `.reconciliation.*`。**已按既有约定改齐**（Rule 11：符合度优先于口味）。重推命令与实测输出见本表下方 |
| marker | `version: 1` → `2`；`finalizeOrder` 改为 **`[owner-transfer.json, owner-record.json, reconciliation-record.json]`**（改判，见下面「排序改判」）；**并且改为被读取**（§4.4）；**并且改为原子写**（temp + rename，照抄 `writeOwnerRecordAtomically` 的形状） |
| **三份 pending** | **全部改为原子写**（temp + rename，与 marker 逐字同形，§4.0.3a 人已裁定）。今天三份都走裸 `writeJsonFile`（实测 `:675` / `:676` / `:677`） |
| 签名 | `writeOwnerTransferArtifacts` 追加参数 `reconciliationRecord`；`persistOwnerTransfer` 追加参数 `reconciliationDraft` 并**在内部补齐 `newOwnerEpoch`** 后透传（见下面「组装点改判」） |
| **暂存顺序（不变式）** | 三份 pending 全部 **rename 完成**之后才写 marker；**reconciliation pending 的 rename 严格先于 marker 的 rename**。marker 的存在即宣告「三份 pending 齐备**且全部完整**」。**两侧都原子之后这条不变式在读者侧才真正成立**：marker 原子保证「rename 前无 marker」，pending 原子保证「marker 在则三份 pending 各自要么不存在、要么完整」——第二轮只做了前一半，读者仍可能看到「marker 完整 + pending 截断」 |
| 组装点 | **改判**：草稿在 `persistBoundaryAnalysis` 内组装（它是唯一拿得到 `boundaryEvidence` / `ownership` 的地方），但 `newOwnerEpoch` **留空**，由 `persistOwnerTransfer` 在 `applyOwnerEpochTransfer` 之后、`writeOwnerTransferArtifacts` 之前用 `transfer.transferRecord.newOwnerEpoch` 填入 |
| **赢家路径的 `writeBoundaryArtifacts`** | 改为**不传** `reconciliationRecord`（只写 `boundary-analysis.json`）。不改则赢家会在事务外再写一次，重新打开 §4 要关闭的那条路径 |
| **`cleanupOwnerTransferStagingWithoutMarker`** | 从 4 个 `safeUnlink` 扩到 **10** 个（第三轮按 pending 原子化从 7 重数）。原有 **4** 个一个都不能删：`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.owner-record.publish.tmp` / `.owner-transfer.publish.tmp`。新增 **6** 个逐个具名：`.reconciliation-record.pending.json`、`.reconciliation-record.publish.tmp`、`.owner-transfer.transaction.tmp`、`.owner-record.pending.tmp`、`.owner-transfer.pending.tmp`、`.reconciliation-record.pending.tmp`。**4 + 6 = 10；这不是「总数 6」** |
| **`finalizePendingOwnerTransfer` 的 try 首与 catch 尾** | 各多一个对称的 `safeUnlink(.reconciliation-record.publish.tmp)`：try 首从 2 个变 3 个，catch 尾从 2 个变 3 个（见 §13 的窄例外）。**marker temp 与三个 pending temp 都不进 finalize 的对称清理**——finalize 一个都不写它们，写它们的是 `writeOwnerTransferArtifacts` 的暂存段；它们由 `cleanupOwnerTransferStagingWithoutMarker` 回收 |

```bash
grep -nF -A6 'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
# 实测 exit 0：:600 签名，:602–:605 共 4 个 safeUnlink
# （ownerPending / transferPending / ownerTemp / transferTemp），0 个 rename
grep -nE 'pending.json|publish.tmp|transaction.json' src/persistence/fileStore.ts   # 需要正则：只看输出行，退出码不作为论据
# 实测 exit 0，命中 5 行：:326 .owner-record.publish.tmp、:327 .owner-transfer.publish.tmp、
# :328 .owner-record.pending.json、:329 .owner-transfer.pending.json、
# :330 .owner-transfer.transaction.json —— 这就是上表「常量命名」一行的依据
```

**⚠️ `cleanupOwnerTransferStagingWithoutMarker` 的可达条件（第二轮评审补，测试 6c 的构造必需）**：它是无 marker 时**唯一**回收 staging 的地方——属实——但它**只在 `options.lockHeld` 为真时被调用**：

```bash
grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
grep -rnF 'recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
# 实测：传 { lockHeld: true } 的三个入口是 writeOwnerTransferArtifacts /
# claimOwnerRecordWithPrecondition / updateOwnerRecordWithPrecondition；
# readOwnerRecord 不传 options，因此走 readOwnerRecord 的调用**不会**触发这个回收
```

**所以「读一次就把孤儿清掉」是假的**：孤儿只在下一次持锁写路径上才被回收。测试 6c 必须经由 `claimOwnerRecordWithPrecondition`（或另两个持锁入口之一）驱动，不能只 `readOwnerRecord`。

**⚠️ 组装点是个陷阱（第一轮评审发现，仍然成立）**：输家路径上 `ownerRecord` 与 `ownership` 在 CAS 失败后**被重新赋值**（`assertHeld()` → 重读 → 重新 evaluate），现有 reconciliation 刻意用的是**失败后重读**的值。**实施者若把组装点上提为唯一一份，会静默把输家记录退回 CAS 前的值。** 事务专用的那份是**第二份拷贝**；`writeBoundaryArtifacts` 那份原地不动。**输家根本不进 `persistOwnerTransfer`，所以下面的组装点改判不影响这条警告。**

#### 组装点改判 —— 不得把 epoch 递增规则复制成第二份（第二轮评审）

第一轮修订要求「在 `persistOwnerTransfer` 调用**之前**组装事务专用拷贝」，并在 §4.2 表里把 `newOwnerEpoch` 的来源写成 `ownerRecord.currentOwnerEpoch + 1`。**那等于把 epoch 递增规则复制成两份生产实现**，而权威那份在别处：

```bash
grep -nF -A8 'export function applyOwnerEpochTransfer(' src/ownership/ownerController.ts
# 实测：const nextEpoch = ownerRecord.currentOwnerEpoch + 1;
grep -nF -e 'const transfer = applyOwnerEpochTransfer(' -e 'nextOwnerEpoch = transfer.ownerRecord.currentOwnerEpoch;' src/controller/runLoop.ts
# 实测：persistOwnerTransfer 内先调 applyOwnerEpochTransfer；现有 reconciliation 的
# newOwnerEpoch 取自 transfer.ownerRecord.currentOwnerEpoch —— 今天就只有一份公式
```

而 §4.3 又把 `reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch` 定为本层之后不得削弱的承重判定之一。**两者相加的后果**：将来任何人改 `applyOwnerEpochTransfer` 的增量规则（例如改成跳号、或改成从持久记录重算），两份公式漂移 → 每一次合法转移之后 `resumeLoop` 都 fail-closed 拒绝 → **债 1 以另一形式复活，而且两侧都是生产代码，没有任何测试会红。**

**采用的形状（一份公式）：**

1. `persistBoundaryAnalysis` 在 transfer 分支内组装一份 **`ReconciliationDraft`**：九个字段里的八个填好，`newOwnerEpoch` 不由它决定。
2. `persistOwnerTransfer` 收下草稿，在它已有的 `const transfer = applyOwnerEpochTransfer(...)` **之后**、`writeOwnerTransferArtifacts(...)` **之前**，用 `transfer.transferRecord.newOwnerEpoch` 填入 `newOwnerEpoch`，得到完整的 `ReconciliationRecord` 再透传给 `writeOwnerTransferArtifacts`。
3. **`+ 1` 在本层新代码里出现零次。** 这是可检验的：

   ```bash
   grep -rnF 'currentOwnerEpoch + 1' src/
   # 实测 exit 0，命中 1 行：src/ownership/ownerController.ts:166
   #   `  const nextEpoch = ownerRecord.currentOwnerEpoch + 1;`
   # —— 本层落地后必须仍然只有这一行。
   ```

   **⚠️ 第四轮更正一条注释（Minor）**：第三轮在这里写「注意 `-r` 不可省：**不加 `-r` 对目录取 exit 2**」。**本壳实测是 exit 1，不是 2**：

   ```bash
   grep -n 'currentOwnerEpoch + 1' src/ >/dev/null 2>&1; echo "n_exit=$?"
   # 实测（第四轮）：n_exit=1，且 stdout 打的是 `0 matches for 'currentOwnerEpoch + 1'`
   /usr/bin/grep -n 'currentOwnerEpoch + 1' src/ >/dev/null 2>&1; echo "usrbin_exit=$?"
   # 实测（第四轮）：usrbin_exit=2
   ```

   **`-r` 仍然不可省**（不加它拿到零命中，判据整个失效），**但理由是「零命中」不是「exit 2」。**

   **并且这条命令当场证伪了 §4.6a 的全称命题**：§4.6a 断言「决定退出码的是正则方言标志（`-G`/`-E`），与 `grep` 解析到谁无关」。**目录参数这一类里退出码恰恰只由解析到谁决定**（wrapper → 1，`/usr/bin/grep` → 2），**与方言无关**。见下面「关于 `grep` 的规矩（第四轮重写）」。

**若实施者坚持在 `persistBoundaryAnalysis` 内自行算 `newOwnerEpoch`**，则必须新增一条**变异测试**：改掉 `applyOwnerEpochTransfer` 的增量规则（例如 `+ 1` → `+ 2`），**某条测试必须红**。没有这条测试就不许走那条路。**（第六波：「某条测试」按 §10 通用条必须落成一个写下来的完整测试名 ＋ 单跑判据，不许留成不定指。）**

§4.2 表里 `newOwnerEpoch` 一行的「计算位置」相应改为「**由 `persistOwnerTransfer` 在 `applyOwnerEpochTransfer` 之后填入**」；那一行原来写的「可在事务前算」是本缺陷的源头。

#### 排序改判 —— `finalizeOrder` 改为 `[transfer, owner, reconciliation]`（第二轮评审，Critical）

第一轮修订选了 `[reconciliation, transfer, owner]`，并同时规定赢家路径的 `writeBoundaryArtifacts` **不再补写** reconciliation。**这两条合起来会让输家永久覆盖赢家刚发布的 reconciliation。** 机制（逐环回代码核过）：

```bash
grep -nF -A10 'function transferRepresentsPublishedWinner(' src/persistence/fileStore.ts
grep -nF -A22 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
grep -nF -A20 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
```

- `writeBoundaryArtifacts` 写 reconciliation 前过 `preserveSuccessfulReconciliationIfNeeded` → `readPersistedSuccessfulTransferArtifacts` → `transferRepresentsPublishedWinner`。
- `transferRepresentsPublishedWinner` 是**三条**判定的合取（**第三轮更正：第二轮两处都只列了两条，漏了第一条**）：`ownerTransferRecord.eligibleForContinuation === true` **且** `ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch` **且** `ownerRecord.currentProcessInstanceId === ownerTransferRecord.newProcessInstanceId`。

  ```bash
  grep -nF -A10 'function transferRepresentsPublishedWinner(' src/persistence/fileStore.ts
  # 实测 exit 0：:139 签名，:143–:147 是 return ( A && B && C )，逐行为
  # :144 eligibleForContinuation === true
  # :145 currentOwnerEpoch === newOwnerEpoch
  # :146 currentProcessInstanceId === newProcessInstanceId
  ```

  **它隐含默认「reconciliation 是三份文件里最后落盘的」**——今天成立，因为赢家在事务完成之后才经 `writeBoundaryArtifacts` 写它。
- **reconciliation 排第一 + 赢家不再补写 = 把这个默认整个反过来。**

**由此可达的最终态**：rival 控制器 P2 在 P1 的事务窗口内（reconciliation 已 rename、transfer / owner 未发布）走 `writeBoundaryArtifacts`。此时首发转移场景下 `readOwnerTransferRecordRaw` ENOENT → `readPersistedSuccessfulTransferArtifacts` 的**裸 `catch { return null }`** → 保护判定压根没跑，**整个保护退化为无保护直写** → P2 用 `eligibleForContinuation: false` 覆盖 P1 的 reconciliation。P1 随后照常发布 transfer + owner **并删掉 marker**。最终磁盘：transfer eligible、reconciliation 被降级、marker 已删 → `evaluateResumeEligibility` 永久拒绝、`recoverInterruptedOwnerTransfer` 永不介入。**比债 1 更糟——债 1 至少 marker 还在。**

**采用的解法：把 `finalizeOrder` 改成 `[owner-transfer.json, owner-record.json, reconciliation-record.json]`。**

**为什么这不削弱 fail-closed**：§4.3 自己已经论证过「排序不承重，承重的是两条 epoch 相等判定」（论证原样保留在下面）。逐个中间态复核新排序：

| 已发布 | 拦截者 |
|---|---|
| 仅 transfer | `ownerRecord.currentOwnerEpoch`（仍是 N）`!== ownerTransfer.newOwnerEpoch`（N+1）→ 判据 B 拒绝 |
| transfer + owner，reconciliation 未发布（**首发转移**） | `reconciliation-record.json` 不存在 → `readReconciliationRecord` ENOENT → `resumeLoop` 的 `Promise.all` catch → 拒绝 |
| transfer + owner，reconciliation 是**上一次**转移留下的（**双转移**） | `reconciliation.newOwnerEpoch`（N+1）`!== ownerTransfer.newOwnerEpoch`（N+2）→ 判据 A 拒绝 |
| 三者齐备 | 放行——正确 |

**并且新排序恰好恢复 `transferRepresentsPublishedWinner` 依赖的那个默认。** 逐步核过 P2 落在「transfer + owner 已发布、reconciliation 未发布」窗口内的那条路：

1. P2 走 `preserveSuccessfulReconciliationIfNeeded` → `readPersistedSuccessfulTransferArtifacts` → `Promise.all` 的第一项 `readOwnerRecord` → `recoverInterruptedOwnerTransfer(runDir)`（**不传 `options`**）。
2. 该窗口内 `.owner-transfer.lock` **仍被 P1 持有**（`writeOwnerTransferArtifacts` 的 `finally` 尚未执行），于是 `!options?.lockHeld && pathExists(lockPath) && !tryRecoverStaleOwnerTransferLock(...)` 成立——P1 的 pid 活着 → **P2 的恢复直接 return，不会替 P1 finalize**。
3. P2 因此读到「已 rename 的新 owner record」与「已 rename 的新 owner-transfer」，`transferRepresentsPublishedWinner` 的**三个**判定（`eligibleForContinuation === true`、epoch 相等、`currentProcessInstanceId === newProcessInstanceId`）**都成立**。**第一条之所以也成立，是因为本层只在成功转移路径上 finalize**：`persistOwnerTransfer` 的返回类型把 `eligibleForContinuation` 钉成类型级 `true`（§4.2 表末行），所以进 pending 的那份 transfer record 必然带 `true`。
4. P2 的降级尝试被 `shouldSynthesizeSuccessfulReconciliation` 改写为一份「合成的赢家 reconciliation」，随后被 P1 finalize 的真品 rename 覆盖。两次写的内容对同一次转移都是「成功」，无损。

```bash
grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
grep -nF -A26 'export async function writeOwnerTransferArtifacts(' src/persistence/fileStore.ts
# 实测：锁在整个 staging + finalize 期间被持有，finally 才 release；
# 而 recoverInterruptedOwnerTransfer 在 !lockHeld 且锁被活进程持有时直接 return
```

**第 2 步是这条修法能成立的关键，而且它不明显**——若将来有人把锁的持有范围收窄到只包住 staging，这条论证就断了，F6 会以另一种形状回来。**§10 测试 6e 的变异必须覆盖它。**

##### ⚠️ 上面四步只覆盖「P2 的读落在窗口内」——排序改判**缩小**了窗口，没有**关闭**它（第三轮评审，Critical，两个视角独立撞到）

**必须先承认的事实**：输家的「读 → 改 → 写」**既不原子也不持锁**。逐行看：

```bash
grep -nF -A22 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts
# 实测 exit 0：:302 签名、:309 先写 boundary-analysis.json、
# :311 if (artifacts.reconciliationRecord !== undefined)、
# :312 await preserveSuccessfulReconciliationIfNeeded(...)  ← 读
# :317 await writeJsonFileAtomically(reconciliation-record.json, ...) ← 写
grep -nF -A22 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
# 实测 exit 0：:256 签名、:267 Promise.all 三读、:274-:276 裸 catch { return null }
grep -nF -A20 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
# 实测 exit 0：:283 eligibleForContinuation 为 true 直接早退（赢家永不进保护）、
# :287 读、:288-:290 读到 null 就**原样返回输家那份**（保护整个不生效）
```

**读与写之间隔着一个 `await` 的返回边界，中间没有任何锁、也没有任何重新校验。** 于是有一条上面四步没有覆盖的时序：

| 时刻 | 事件 |
|---|---|
| T0 | P2 的 `readPersistedSuccessfulTransferArtifacts` 执行。此刻 P1 **还没 rename 任何东西**，`owner-transfer.json` 不存在 → `readOwnerTransferRecordRaw` ENOENT → **裸 `catch { return null }`** → `preserveSuccessfulReconciliationIfNeeded` 在 `:289` 原样返回输家那份降级记录，**保护判定压根没被求值** |
| T1 | P1 在 P2 的这一个 `await` 间隙里跑完全部三次 rename（transfer → owner → reconciliation），随后删 marker、删三份 pending |
| T2 | P2 的 `:317` `writeJsonFileAtomically` 落盘，**覆盖 P1 刚发布的 reconciliation** |

**终态与 F6 逐字相同**：transfer eligible、reconciliation 被降级、marker 已删 → `evaluateResumeEligibility` 永久拒绝、`recoverInterruptedOwnerTransfer` 永不介入。**`finalizeOrder` 排哪个方向都拦不住这条**——它由「P2 的读早于 P1 的第一次 rename」触发，与 P1 内部三次 rename 的相对顺序无关。

**那么排序改判买到了什么？** 买到的是**窗口宽度**，这一点必须诚实量化，不能说成「关闭」：

- **旧排序 `[reconciliation, transfer, owner]`**：P1 第一次 rename 就发布 reconciliation，而此刻 `owner-transfer.json` 仍不存在。P2 只要在「P1 发布 reconciliation 之后、P1 发布 transfer 之前」读，就**必然**读到 ENOENT → 必然无保护。**这个窗口不要求任何巧合的交错，它是 P1 事务的一个常规阶段。**
- **新排序 `[transfer, owner, reconciliation]`**：P1 最后才发布 reconciliation。P2 要造成损坏，只需让 P1 的某几次 rename 落进 P2 的 read→write 间隙里。

##### ⚠️⚠️ 第三轮为这条「买到了什么」写下的量化**是假的**，因为它把 `Promise.all` 当成了快照（第四轮评审，Critical，三个视角独立撞到）

**第三轮原话**：「P2 的读一旦晚于 P1 的第一次 rename，就读到 transfer，三条判定成立，保护生效」，据此把残余量化为「**需要 P1 的三次 rename 全部落在 P2 的单个 await 间隙内**」。

**这句话为假，而且它的错法正是本文档 §4.0a 白纸黑字写过的那一条**：`transferRepresentsPublishedWinner` 的三条判定**跨两个文件**——

```bash
grep -nF -A12 'function transferRepresentsPublishedWinner(' src/persistence/fileStore.ts
# 实测 exit 0：:139 签名、:143 `return (`、
#   :144 ownerTransferRecord.eligibleForContinuation === true      ← 来自 owner-transfer.json
#   :145 ownerRecord.currentOwnerEpoch === ownerTransferRecord.newOwnerEpoch      ← 跨两个文件
#   :146 ownerRecord.currentProcessInstanceId === ...newProcessInstanceId         ← 跨两个文件
grep -nF -A26 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
# 实测 exit 0：:256 签名、:266 try、:267-:271 Promise.all([readOwnerRecord, readOwnerTransferRecordRaw,
#   readPersistedReconciliationRecord])、:274-:276 裸 catch { return null }
grep -nF -A4 'export async function readOwnerRecord(' src/persistence/fileStore.ts
# 实测 exit 0：:647 签名、:648 `await recoverInterruptedOwnerTransfer(runDir);`、:649 readOwnerRecordRaw
```

数据来自 `Promise.all` 的三个并行读，而**§4.0a 已经就地写明「它本来就不是快照」**。更具体：`readOwnerRecord` 在读 owner-record 之前**先 `await recoverInterruptedOwnerTransfer`**，后者至少要跑一次 `pathExists(marker)`（`:633`），有 marker 时还要跑 `pathExists(lock)` ＋ 一次 `readFile(lockPath)`（`tryRecoverStaleOwnerTransferLock` `:525`）。**于是「读 transfer」与「读 owner-record」之间隔着 3–4 次系统调用，而不是零。**

**由此可达的、第三轮论证没有覆盖的时序**（只需两次 rename，不需要三次）：

| 时刻 | 事件 |
|---|---|
| U0 | P2 进入 `readPersistedSuccessfulTransferArtifacts`。`readOwnerTransferRecordRaw` 先完成（它没有恢复前缀），此刻 P1 的 **rename#1（transfer）已完成** → P2 读到 **transfer(N+1)** |
| U1 | P2 的 `readOwnerRecord` 仍卡在 `recoverInterruptedOwnerTransfer` 的几次 `pathExists`/`readFile` 上。**P1 在这几次系统调用之间完成 rename#2（owner-record）之前**，P2 的 `readOwnerRecordRaw` 落盘读到 **owner-record(仍是 N)** |
| U2 | `transferRepresentsPublishedWinner`：判据 A（`eligibleForContinuation === true`）**成立**，判据 B（`N === N+1`）**不成立** → 保护退化 → 输家的降级版本被 `preserveSuccessfulReconciliationIfNeededFromArtifacts` 原样放行 |
| U3 | P2 的 `:317` 写落盘。若它晚于 P1 的 rename#3，赢家的真品被覆盖 |

**这不需要第三轮声称的那种「三次 rename 全落进一个间隙」的巧合**：它只要求 P2 的两次读**分别**落在 P1 的 rename#1 之后、rename#2 之前——而两次读之间本来就隔着一整个 `writeJsonFile` 的时间（P1 在 rename#1 与 rename#2 之间要跑 `writeJsonFile(ownerTemp)`，见 `finalizePendingOwnerTransfer` `:617`→`:618`→`:619`）。

**Rule 7 冲突，并说明取舍**：§10 测试 6e 的正文**已经写对了这件事**——它写「输家此刻读到 transfer 已在、但 `owner-record.json` 仍是旧 epoch → epoch 判定不成立」。**§4.3 与 §10 在第三轮的同一波里互相矛盾，本轮挑 §10。** 理由：§10 那句是对着 `transferRepresentsPublishedWinner` 的三条判定逐条走出来的（它点名了「epoch 判定不成立」这个具体判据），而 §4.3 那句是对着「读到 transfer 就等于三条都成立」这个未经验证的合并断言写出来的。**§4.3 那句予以撤回。**

**结论（本层的正式表态，取代第三轮那句量化）**：排序改判把这条路径从**「P1 事务的常规阶段即可达、且完全不需要任何交错巧合」**收窄到**「需要 P2 的读与写分别落进 P1 的两个特定间隙」**。**收窄的幅度本 spec 不再量化**——上面两次量化尝试（第二轮「关闭了」、第三轮「三次 rename 落进一个间隙」）都被下一轮证伪，**第三次量化没有理由更可信**。**它没有把这条路径变成不可达，这才是唯一被验证过的结论。**

##### 本层对该残余采用的处置（两条，一条改代码、一条具名交接）

**处置一（改代码，纯增加拒绝）：把 `readPersistedSuccessfulTransferArtifacts` 的裸 `catch` 收窄成 fail-closed，但只对「非 ENOENT-of-`owner-transfer.json`」的失败生效。**

- **今天的行为**：三个读里任何一个抛出 → `return null` → 调用方在 `:289` 原样放行输家的降级写。**这是一条 fail-open**，而 §4 整节存在的理由就是消灭这一类。
- **改成什么**：区分两类失败。`owner-transfer.json` 不存在（ENOENT）是一个**确定的**事实——「此刻没有已发布的赢家可保护」——保持今天的行为（放行）。**其余任何失败**（`readOwnerRecord` 抛、恢复抛、owner-record 损坏、任意 I/O 错误）意味着**无法判定有没有赢家**，一律**放弃这次 reconciliation 写**（`boundary-analysis.json` 那次写不受影响，它在 `:309`、在保护之前）。

##### ⚠️ 「放弃」这个决定怎么从 `preserveSuccessfulReconciliationIfNeeded` 上传到 `writeBoundaryArtifacts` —— 第六波补写约束

**今天没有任何通道**：

```bash
grep -nF -A3 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
# 实测（第六波）exit 0：:279 签名、:280 runDir、:281 nextReconciliationRecord、
#   :282 `): Promise<ReconciliationRecord> {`  ← 返回类型里没有「不要写」这一格
```

**本层不指定具体实现**（返回类型扩成 `| null` / 换成结果对象 / 把收窄后的整块判定上移进 `writeBoundaryArtifacts`，都可以），**但它受 §10 测试 12d(iii) 的两条断言硬约束，这两条把最危险的那条路堵死：**

1. **不得靠「抛出」上传。** 抛出是 fail-closed 最自然的写法，**但它让 `writeBoundaryArtifacts` 抛，正是人裁明令禁止的**。12d(iii) 断言「`writeBoundaryArtifacts` 正常 resolve（不抛）」，杀掉这条路。
2. **必须把原始 error 对象一路带到回调。** 12d(iii) 断言「回调参数含那次读失败的 `String(error)`」，所以一个只返回 `null` 的实现**不达标**——`null` 把 error 丢了，detail 就没得填。

**⚠️ 第五波把这件事写成「刻意不钉 abandon 怎么上传」是措辞错误**（第六波更正）：缝确实已被 12d(iii) 堵住，但那句话读起来像是**给了实施者自由选择抛出**，而抛出恰好是被禁的那一条。**正确表述是「上传方式不指定实现，但受上面两条断言约束」，不是「刻意不钉」。**

**⚠️ 与 §4.6 的一条冲突，本波只标不改（在本波清单之外，见交付报告）**：§4.6 写着「`preserveSuccessfulReconciliationIfNeeded` **代码零改动**」。**处置一落地之后那句话为假** —— 无论选上面哪种实现，这个函数或它的调用块都必然要动。**下一轮请裁定：是改 §4.6 那句话，还是把整块判定上移到 `writeBoundaryArtifacts` 从而真的保住「零改动」。**

##### ⚠️ ENOENT 豁免必须给归因机制，否则最自然的实现会把收窄实现成零改动（第四轮评审，Important）

**问题**：那个裸 catch 包住的是一个**三读的 `Promise.all`**（`:266`–`:276`），ENOENT 可以来自至少四个地方：

```bash
grep -nF -A26 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
# 实测 exit 0：:267-:271 三读并行 —— readOwnerRecord / readOwnerTransferRecordRaw /
#   readPersistedReconciliationRecord
grep -nF -A4 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
# 实测 exit 0：:608 签名、:610 readFile(ownerPendingPath)、:611 readFile(transferPendingPath)
#   —— 两次都在 try 之前，ENOENT 直接逃出
grep -nF -A14 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts
# 实测 exit 0：:520 签名、:525 readFile(lockPath)、:527-:528 ENOENT → return true（这一条被吞）
```

ENOENT 的来源：(a) `readOwnerTransferRecordRaw`（**要豁免的那一个**）、(b) `readOwnerRecordRaw`（owner-record 缺失）、(c) `finalizePendingOwnerTransfer` 的 `:610`/`:611`（pending 缺失，即 §4.4 规则 2 的可达形态，见那里）、(d) 锁读（这一条自己接住了，不会逃出）。

**最自然的实现 `if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;` 会把 (a)(b)(c) 一并放行** —— 而 (b)(c) 恰好落在本改动要关闭的那条并发恢复路径上，**收窄因此在最要紧的那一类上原样保留 fail-open，等于零改动**。**§15 验收 1b 第三轮复制了同样的措辞、同样没写归因方式，于是两条断言在这种实现下都会绿。**

**本层定死的归因方式（二选一，计划阶段必须挑一个并写明）：**

1. **按 `error.path` 归因**：只有 `(error as NodeJS.ErrnoException).path` 等于 `join(runDir, "owner-transfer.json")` 的 ENOENT 才放行，其余一律 fail-closed。**风险**：`path` 是 Node 的 `fs` 错误才带的字段，若将来有人在读侧包一层自定义错误就会丢掉它。
2. **把那一次读移出 `Promise.all`，单独 try**（本层**推荐**这一条）：`readOwnerTransferRecordRaw` 独立 `try { … } catch (e) { if (ENOENT) return null; throw e; }`，其余两读留在原来的 `Promise.all` 里、由收窄后的外层 catch 一律 fail-closed。**它不依赖任何错误字段，判据是「哪一次读抛的」这个结构事实。** 代价：那次读不再与另两次并行（本来也不承重，见 §4.0a「它本来就不是快照」）。

**§15 验收 1b 相应拆成两条独立用例**（见那里）：「ENOENT-of-`owner-transfer.json` → 放行」与「ENOENT-of-其它文件 → 不放行」。**只写一条会让上面那个「一律放行 ENOENT」的实现绿。**

##### 人已裁定（第四轮）：「放弃这次 reconciliation 写」的可观测面 = 跳过 ＋ 追加一条具名事件

**不抛出**（不把输家的一次保护性拒绝升级成 attempt failed），**也不静默**。定死如下：

- **事件类型名**：**`reconciliation_write_abandoned`**。命名与既有事件同形（`resume_denied` / `lease_expired_observed` / `workspace_retry` 都是「名词_过去分词」）。
- **追加位置**：`writeBoundaryArtifacts` 内，在放弃 `:317` 那次写之前。**这不引入任何新依赖**——`appendEvent` 与 `writeBoundaryArtifacts` 在同一个模块里：

  ```bash
  grep -rnF 'export async function appendEvent' src/
  # 实测 exit 0，命中 1 行：src/persistence/fileStore.ts:85
  grep -nF -A5 'export type RunEvent' src/persistence/fileStore.ts
  # 实测 exit 0：:13 `export type RunEvent = {`、:14 `type: string;`、:15 `at: string;`、:16 `detail: string;`
  # —— type 是裸 string，不是联合类型，所以新增一个事件类型名**不改任何类型定义**。
  ```

- **detail** 携带 `String(error)`（与 `workspace_retry` / `workspace_create_failed` 的既有写法同形）。
- **`boundary-analysis.json` 那次写照常发生**（它在 `:309`，在保护之前），所以「这个 run 走过 stale_candidate 分支」这件事仍然留痕。

**它在 §8 里落在哪一格 —— 见下面第五波的人裁。第四轮给的答案（「一格都不落」）已被推翻。**

##### ⚠️ 人已裁定（第五波，推翻第四轮）：这条放弃必须路由到 sweep 的 stderr

**第四轮的处置是「落盘但不路由」**：事件只进 `events.jsonl`，§8 表加一行显式的「不路由」，并把「cron 的『有 stderr 即告警』不会为它响」写成一条具名代价交接给 L5。**人已裁定：不接受。** 理由是本层自己的结构性矛盾——这是一条**保护性放弃**，本层为它写了整节论证、为它配了三条子用例（测试 6f），却让操作者在**当场**看不见它发生过。**一条值得写整节论证的拒绝，就值得让当班的人看见；只留事后审计等于把它降级成一条没有消费者的日志。**

**第一步先核「能不能不新建通道」（人的要求：不许直接假设必须改签名）—— 结论是不能，两条独立理由，各附本轮实测：**

**理由一：sweep 报告层今天的输入里没有任何东西携带它。** sweep 的两路输入是 (1) `scanRuns` 返回的 `ScanRow`，(2) `resumeLoop` 的返回值与抛出。逐路核过：

```bash
grep -nF 'export type ScanRow' src/registry/scanRuns.ts
# 实测输出 1 行：:17 `export type ScanRow = RunObservation | ScanIssue;`
grep -nF 'OBSERVED_FILES' src/registry/observeFields.ts src/registry/observeRun.ts
# 实测输出 4 行：observeFields.ts:5 定义、observeRun.ts:4 import、:16 注释、
#   :23 `OBSERVED_FILES.map((spec) => readObservedFile(runDir, spec, deps)),`
#   —— 即 RunObservation.files 逐项来自 OBSERVED_FILES，没有第二个来源
grep -nF 'file:' src/registry/observeFields.ts
# 实测输出 4 行：
#   :7   file: "loop-state.json",
#   :29  file: "owner-record.json",
#   :45  file: "owner-transfer.json",
#   :111 return { file: spec.file, fields };     ← 返回构造，不是观测文件
#   结论：观测文件 3 个，**无 events.jsonl**
grep -nF 'export async function resumeLoop(' src/controller/resumeLoop.ts
# 实测输出 1 行：:87 `export async function resumeLoop(runDir: string, adapter: RuntimeAdapter): Promise<RunState>`
#   —— 返回 RunState，而 §4.3 的人裁本身规定这条放弃**不改变 run 的终态**
```

**理由二：就算 registry 改成观测 `events.jsonl`，也派生不出来 —— 时序不对。** §6 的流水线是「先 `scanRuns` 一次、再顺序续跑」，扫描**早于**每个 run 的执行；而这条事件产生在续跑**期间**。要靠扫描看见它，必须在续跑之后**再扫一次**，那既违反 §3 第 1 条（sweep 自身不读 run 目录下的文件），也不是「就地派生」。

**⚠️ 顺带撤回第四轮那条类比。** 第四轮写「这与 §5.4 对『人按过 Ctrl-C』的处置是同一个已知缺口，理由也相同」——**不同**：§5.4 那条缺口是**跨进程**的（本次 sweep 其实看得见停机，§8 有 `interrupted` 行；看不见的是**下一次** sweep），跨进程只能靠磁盘契约。而本条是**同一次 sweep、同一个进程内**的可见性，进程内的通道就够。**「理由也相同」这半句是把两个不同的缺口按表面症状归了一类，正是它把第四轮引向了错误结论。**

**第二步：既然必须新建跨层通道，两种形状，本层选后者。**

- **(a) 上行 —— 让 `writeBoundaryArtifacts` 把信息随返回值带上去。** 它今天是 `Promise<void>`：

  ```bash
  grep -nF -A7 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts
  # 实测输出 8 行：:302 签名、:303 runDir、:304-:307 artifacts 对象、
  #   :308 `): Promise<void> {`、:309 写 boundary-analysis.json
  ```

  要上行到 sweep，`writeBoundaryArtifacts` → `persistBoundaryAnalysis`（今天 `Promise<void>`）→ `runLoopFromState`（今天 `Promise<RunState>`）→ `resumeLoop`（今天 `Promise<RunState>`）**四层返回类型全部要改**。
- **(b) 下行 —— 把一个可选回调从 sweep 传到 `writeBoundaryArtifacts`。** 四层各加一个**可选**入参，返回类型一个字节不动。

**否决 (a) 的三条理由，第三条是决定性的：**

1. **爆炸半径**：`runLoopFromState` 与 `resumeLoop` 的返回值是被广泛依赖的公开面（`src/cli.ts:131`/`:135` 的 `finalState.status ? 0 : 2`，以及全部 14 个 `resumeLoop` 调用点），改返回类型要动的是**读端**，每一处都要重新解构。(b) 改的全是**可选入参**，既有调用点一个不断。

   ```bash
   grep -rnF 'resumeLoop(' src/ tests/ | grep -vF 'export async function' | grep -cF 'resumeLoop('
   # 实测输出 14
   grep -rcF 'resumeLoop(runDir' tests/controller/resumeLoop.integration.test.ts tests/controller/leaseLifecycle.integration.test.ts
   # 实测输出 2 行：resumeLoop.integration.test.ts:12、leaseLifecycle.integration.test.ts:1
   #   14 = 12 + 1 + src/cli.ts:130 那一处
   ```
2. **语义错位**：`RunState` 是 run 的**状态**，而这条事件按人裁**不改变 run 的终态**。把它塞进 `RunState` 就是在状态对象里挂一条与状态无关的通知，下一位读者会误以为它是终态的一部分。
3. **（决定性）(a) 在最需要它的那条路径上会把消息丢掉。** §6 已实测：`runLoopFromState` 的 `while (true)` 顶端两个 `await`（`:974` `writeRunState`、`:977` `affirmNow`）**不在任何 try 内**，可以在若干次 attempt 之后直接抛出、逃出 `resumeLoop`。**一旦抛出，返回值不存在，(a) 携带的那条信息随之蒸发**——而那正是「这个 run 出了事」最需要 stderr 的时刻。(b) 的回调在事件发生的**当场**就把记录写进了 sweep 自己的数组里，后续无论 run 正常返回还是抛出，记录都已在 sweep 手上。

**第三步：通道逐层定死（四层，每一层都只是「新增一个可选项」，零破坏性改动）。**

| 层 | 今天 | 改成 | 该层的失败语义 |
|---|---|---|---|
| `fileStore.writeBoundaryArtifacts` | `(runDir, artifacts): Promise<void>`（`:302`–`:308`） | 加**第三个可选参数** `options?: { onReconciliationWriteAbandoned?: (detail: string) => void }`。**返回类型不变。** 在决定跳过 `:317` 那次写的**同一个同步块**里调用它，**且排在 `appendEvent` 之前** | 回调缺省 → 行为与第四轮定的一致（只落 `events.jsonl`，不路由）。**回调排在 `appendEvent` 之前是刻意的**：`appendEvent` 是裸 `appendFile`、可以 reject（`leaseHeartbeat.ts:51` 的注释就是这么写的），排在后面会让一次 I/O 失败连带吞掉 stderr 那条。**并且那次 `appendEvent` 必须按 `appendLeaseEvent` 的同形 swallow 包起来**（第六波，见下面那一节）——不包会把这条放弃升级成 attempt failed |
| `runLoop.persistBoundaryAnalysis` | `(runDir, state, heartbeat, executionRecovery?)`（`:704`） | 加**第五个可选参数**，原样透传。**两个调用点都要改**：`:1109` 追加第 5 实参；`:1141` 今天只传 3 个，要写成 `(runDir, state, heartbeat, undefined, cb)` | 纯透传，不新增任何 catch |
| `runLoop.runLoopFromState` | `(contract, runDir, adapter, initialLoopState, heartbeat?, leaseLoss?)`（`:953`–`:960`） | **不新增位置参数**：搭 §5.4 已经要加的那个可选参数对象（`stopRequested` 走的同一个），加一个键 `onReconciliationWriteAbandoned?` | 纯透传 |
| `controller.resumeLoop` | `(runDir, adapter)`（`:87`） | **不新增位置参数**：§9 已定的可选参数对象从 `{ stopRequested?, onAdopted? }` 扩为 `{ stopRequested?, onAdopted?, onReconciliationWriteAbandoned? }` | 纯透传。既有 14 处调用点全部传 2 个实参，零改动 |
| `sweep.sweepRuns` | — | 为**当前这个 run** 传一个闭包，把 `{ path, detail }` push 进本次 sweep 的备注数组 | 见下面的「回调不得抛出」 |

**`writeBoundaryArtifacts` 的既有调用点全部安全**（可选参数，两参调用照旧合法）：

```bash
grep -rnF 'writeBoundaryArtifacts(' src/
# 实测输出 2 行：src/controller/runLoop.ts:845 唯一生产调用点、src/persistence/fileStore.ts:302 定义
grep -cF 'writeBoundaryArtifacts(runDir, {' tests/persistence/fileStore.test.ts
# 实测输出 11 —— 全是两参调用，加第三个可选参数一条都不断
```

**回调不得抛出，且本层刻意不给它包 try/catch。** 它若抛出，会从 `writeBoundaryArtifacts` 一路逃到 `runLoopFromState`，把一次保护性放弃升级成 attempt 失败——**正是人裁明令禁止的那件事**。包一层 `try{}catch{}` 会静默吞掉它，违反 Rule 12。**本层的处置是把「不得抛出」定成回调的契约，并把 sweep 侧的实现定死为一次数组 push（不做 I/O、不格式化）**，使违约成为一个显眼的编程错误而不是一条被吞的异常。

##### ⚠️ 同一个放弃块里的 `appendEvent` 今天会把这条放弃升级成 attempt failed —— 必须 swallow（第六波，Critical）

**第四轮定的「追加一条 `reconciliation_write_abandoned` 事件」用的是裸 `appendEvent`，而它没有任何守卫：**

```bash
grep -rnF 'export async function appendEvent' src/
# 实测 exit 0，命中 1 行：src/persistence/fileStore.ts:85
sed -n '85,87p' src/persistence/fileStore.ts
# 实测（第六波）函数体只有两行、零守卫：
#   :85 `export async function appendEvent(runDir: string, event: RunEvent): Promise<void> {`
#   :86 '  await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);'
#   :87 `}`
```

**逐环走完这条抛出路径（第六波回代码复核，不是转述）：**

1. `appendEvent` 在 abandon 块里 reject（`events.jsonl` 不可写：ENOSPC / EACCES / 目录已被删）。
2. → `writeBoundaryArtifacts` 抛。
3. → `persistBoundaryAnalysis`（`:704`）抛；它的两个调用点 `:1109` 与 `:1141` **都在 `runLoopFromState` 的外层 try 内**（外层 `} catch (error) {` 在 `:1344`）。
4. → 落到外层 catch；`isLeaseStopError` **匹配不上 I/O 错误**：

   ```bash
   sed -n '105,107p' src/controller/runLoop.ts
   # 实测（第六波）：
   #   :105 `function isLeaseStopError(error: unknown): error is RunLeaseLostError | RunLeaseUnverifiableError {`
   #   :106 `  return error instanceof RunLeaseLostError || error instanceof RunLeaseUnverifiableError;`
   #   :107 `}`
   grep -nF 'transitionRunState(state, "failed", failureReason)' src/controller/runLoop.ts
   # 实测 exit 0，命中 1 行：:1390
   ```

5. → `:1353` 的分支不命中 → 走到 `:1390` `transitionRunState(state, "failed", failureReason)`。

**即：一次保护性放弃，因为 `events.jsonl` 写不进去，被升级成 attempt failed —— 正是第四轮人裁明令要禁的那件事，第四轮自己引入的。**

**修法：抄本仓库自己的判例，不发明新形状。** `src/controller/leaseHeartbeat.ts` 的 `appendLeaseEvent` 对**逐字同一个问题**已经判过一次：

```bash
grep -nF -A4 'const appendLeaseEvent = async' src/controller/leaseHeartbeat.ts
# 实测 exit 0：:58 定义、:59 `try {`、:60 `await appendEvent(options.runDir, {...})`、:61 `} catch {`
sed -n '51,53p' src/controller/leaseHeartbeat.ts
# 实测（第六波）判例的头三行理由，逐字：
#   `  // appendEvent is a raw appendFile with no internal guard, so it can reject on real I/O`
#   `  // failure. Losing the event log must not cost us the stop signal or the refusal that follows`
#   `  // it, so it is swallowed here rather than left to propagate: out of runAffirm's catch block`
sed -n '62,62p' src/controller/leaseHeartbeat.ts
# 实测（第六波）：`      // Swallowed by contract: the stop signal and the refusal must still fire without it.`
```

**abandon 路径与它结构同形**（丢掉事件日志不该连带丢掉那条拒绝本身）。**所以定死：回调先调（第五波已定）→ 然后 `appendEvent` 用与 `appendLeaseEvent` 同形的 `try { … } catch { }` ＋ 同口气的就地注释。**

**这个修法同时满足三条约束，逐条写出来：**

1. **人裁「不抛出」**——抛出路径消失，`writeBoundaryArtifacts` 在 `events.jsonl` 不可写时仍然正常 resolve。
2. **Rule 12「不许静默」**——吞掉的只有**审计日志**那一半；**当场可见性由已经排在前面的回调独家兑现**。**这正是第五波那次路由改动买到的东西，所以「吞」在这里第一次变得正当**：第四轮那种「落盘但不路由」的形态下，`events.jsonl` 是唯一出口，吞它就是真静默。
3. **Rule 11「符合既有约定」**——判例就在**同一个仓库、同一个函数（`appendEvent`）、同一条理由**，不是从别处类比来的。

**⚠️ 为什么 `appendEvent` 吞、而回调不吞（两者危险同构，处置却相反 —— 理由第六波补写）**：`writeBoundaryArtifacts` 在本层新增的写/追加动作恰好只有这两个。差别在**谁能修好它**：回调的实现**在本层的控制范围内**（§9 已把它定死为一次数组 push，不做 I/O），所以它抛出只可能是**编程错误**，必须显眼地炸出来；`appendFile` 的 I/O **不在**任何人的控制范围内，它抛出是**环境事实**，把它炸成 attempt failed 只是用一个更大的错误盖住一个更小的。**第五波把两者一个判成待修缺陷、一个判成契约而没写理由，这一段是补的那个理由。**

**第四步：它落在 sweep 报告的哪一格 —— 写死。**

- **不是 `error`，也不新增 outcome 取值。** `outcome` 那一列是该 run 的**终局**分类，一行一个值；而这条事件与终局**正交**——一个最终 `succeeded` 的 run 照样能产生它。写进 `error` 会把真实终局覆盖掉，等于用一条局部事件谎报整个 run 的结果。
- **落点是一条独立的 stderr 备注行**，格式 **`note  <path>  reconciliation_write_abandoned  <detail>`**。一次调用产生一行，不去重、不聚合。

  **⚠️ 行序承诺只在 stderr *这一条流内部*成立（第六波降级；第五波写的「紧跟该 run 的报告行之后打印」不可兑现）。** 报告行走 stdout、备注行走 stderr，**两条流被重定向到同一个管道或同一个文件时，它们之间的相对顺序在 Node 里不受保证**（两个流各自独立缓冲，是否同步还取决于目标是 TTY / pipe / 文件）。所以那条跨流承诺**既不能被 §10 测试 12d 断言，也不能被操作者依赖**。
  **改成**：**同一次 sweep 内，各条 `note` 行之间保持 run 的遍历顺序**（sweep 是顺序 for-await，§6，所以单流内行序确定，测试 11/13 的确定性依赖不受影响）。**跨流的「紧跟」不再承诺。**

  **⚠️ `detail` 打印前必须折成单行（第六波）。** `detail` 取 `String(error)`，而 `SyntaxError` 之类的 message **可以含换行**（`JSON.parse` 的报错常带位置片段），一条备注会被拆成看起来像多条的输出，把「一次调用产生一行」这条契约在实际输出上打破。**处置：打印前把 `detail` 里的 `\r?\n` 折成单个空格（或 `\\n` 字面），使一次调用在 stderr 上恰好占一行。**
  （**§8 既有的 `errored` 那一行有同样的问题，先于本波存在，本波刻意不动它** —— 那是另一条契约的范围，改它要连带 §7 与测试 12c，收益不抵成本。**具名留给下一轮。**）
- **不复用 `cannot read run artifacts:` 那一行**，且不要假装它能接住：

  ```bash
  grep -rnF 'cannot read run artifacts' src/ tests/
  # 实测输出 3 行：src/controller/resumeLoop.ts:119、:120、tests/cli/cli.test.ts:73
  # —— src/ 内唯一的产生点是 resumeLoop 的**读侧** Promise.all catch。
  # 本事件产生在 fileStore 的**写侧**，根本不经过那个 catch。
  ```

- **退出码不受影响**（§7 表一个字节不改）。理由：退出码钉的是「sweep 有没有干成它的活」，而这条事件既不阻止 sweep 完成扫描、也不改变任何 run 的合法终局。**可见性由 stderr 独家兑现 —— 而 cron 的「有 stderr 即告警」现在会为它响，这正是人裁要的东西。**
- **§8 末尾的汇总行格式不改**（不加计数格）。理由两条：人裁只要求「看得见」，加计数是超出的第二件事（Rule 2）；且该格式已被 §18 附 G24 与 §19 引用，改它会作废那两处而没有对应收益。
- **`ccloop run` / `ccloop resume` 两条 CLI 路径不传回调**，行为与第四轮一致（只进 `events.jsonl`）。**这不是遗漏**：那两条路径是前台命令，操作者本来就在看着它；stderr 路由要解决的是无人值守的 sweep。

- **为什么这不是行为退化**：`writeBoundaryArtifacts` 的调用方 `persistBoundaryAnalysis` 在 `runExclusive` 内已经成功 `readOwnerRecord` 过一次，所以健康路径上 `owner-record.json` 必然存在且可读；`readPersistedReconciliationRecord` 自带 `catch { return undefined }`、从不抛。

  ```bash
  grep -nF -A10 'async function readPersistedReconciliationRecord(' src/persistence/fileStore.ts
  # 实测 exit 0：:246 签名、:251-:253 catch { return undefined } —— 它不会成为 null 的来源
  ```

  **因此健康路径上唯一的 null 来源就是 `owner-transfer.json` ENOENT**，而那一类被显式保留为放行。收窄只在真正的异常上生效，符合本层「只增加拒绝」的边界。

  **⚠️ 「`readPersistedReconciliationRecord` 自带 catch、从不抛」这条依据在第三轮是被*驳回*的理由，本轮把它换成能承重的三条**（见 §13 末尾对 M9 的处置）。第三轮用「先于本层 ⇒ 不在范围」驳回把它收窄——**结论成立但理由不成立**，因为同一波的人裁刚好推翻了这条判据（三份 pending 也是先于本层的，照样被收回自修）。**真正的依据是**：(a) L1 §12 第 7 条的原文范围是 owner record ＋ 租约门，不是 `reconciliation-record.json`；(b) 该文件由 `writeJsonFileAtomically` 发布（`grep -nF -A16 'async function writeJsonFileAtomically(' src/persistence/fileStore.ts` 实测 `:418` 签名、`:423` `writeFile(tempPath)`、`:424` `rename(tempPath, path)`），temp + rename，**截断态不可达**；(c) 即便可达，`undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation`（`:150`–`:159`）→ 合成赢家视图，**赢家不会丢**。
  **并且**：本层现在对这次吞咽建立了**新的承重依赖**——处置一把「它自带 catch、从不抛」当成「健康路径上唯一的 null 来源是 owner-transfer ENOENT」的前提。**因此它具名进 §13 第 4 笔的交接说明**（不单开一笔：它不是一条独立缺陷，而是第 4 笔那条 TOCTOU 的一个前提条件，单开会让 §13 的条数与三处联动数字再动一次，收益不抵成本）。

##### 收窄的爆炸半径 —— 逐个 fixture 走过，不再用「不是行为退化」一句带过（第四轮评审要求可判定）

**第三轮那句「这不是行为退化」是一条无条件断言，没有任何东西说明它对着哪些现有测试成立。** 三个评审员都指出它不可判定。逐个走：

`preserveSuccessfulReconciliationIfNeeded` 只在 `nextReconciliationRecord.eligibleForContinuation` 为**假**时才走到 `readPersistedSuccessfulTransferArtifacts`（`:283`–`:285` 早退）。因此爆炸半径 = 「以 `eligibleForContinuation: false` 调 `writeBoundaryArtifacts` 的现有测试」。全部命中点：

```bash
grep -nF 'eligibleForContinuation' tests/persistence/fileStore.test.ts
# 实测 exit 0，命中 22 行。其中作为 reconciliationRecord 传入且为 false 的是三处：
#   :1219  :1283  :1349
grep -rnF 'writeBoundaryArtifacts' tests/
# 实测 exit 0：tests/persistence/fileStore.test.ts 的 :1116 :1175 :1199 :1263 :1352 :1363
#   :1907 :1918 :1942 :1948 :1973，tests/controller/runLoop.integration.test.ts:1430
```

三处 `false` fixture 的前置状态（逐个读过）：

| 测试 | fixture 是否先写 `owner-record.json` / `owner-transfer.json` | 三读会不会抛 | 收窄后是否变红 |
|---|---|---|---|
| `fileStore.test.ts:1199` 起（`:1219` 是它的 false 记录） | 是（`:1145` 起 `writeOwnerRecord` ＋ `:1165` 起 `writeOwnerTransferRecord`） | 不抛 | **否** |
| `fileStore.test.ts:1263` 起（`:1283`） | 是（`:1243` 起 ＋ `:1253` 起） | 不抛 | **否** |
| `fileStore.test.ts:1314` 起（`:1349`／`:1363` 两次调用） | 是（`:1317` 起 ＋ `:1327` 起） | 不抛 | **否** |

**另外两处曾被点名的爆炸半径也走过**：`tests/controller/runLoop.integration.test.ts:1386`（"preserves the winner reconciliation view …"）与 `:1554`（"writes no synthesized winner reconciliation view …"）——两条都由 mock 的「另一控制器」先写好 `owner-record.json` 与 `owner-transfer.json` 才让本进程走到保护，三读同样不抛。

**还有一组必须点名的、看起来危险但实际不在半径内的**：`fileStore.test.ts:1869` 那个 `describe`（`:1907`/`:1918`/`:1942`/`:1948`/`:1973`）的 fixture 目录**刻意不含 owner-record.json 与 owner-transfer.json**（该 describe 的注释自己写着这一点），若它传 `false` 就会命中 `readOwnerRecordRaw` 的 ENOENT-of-owner-record → **收窄后必红**。**它今天传的是 `eligibleForContinuation: true`**（`:1895`），走 `:283` 早退，**根本不进保护**，所以不红。

**结论（可判定，取代第三轮那句无条件断言）**：**在今天的套件上，收窄不使任何一条现有测试变红**，依据是上表逐条走过的 fixture 前置状态。**但这个结论有一个明确的失效条件**：`fileStore.test.ts:1869` 那个 describe 的 fixture 一旦被改成传 `false`，它会**立刻**成为第一条被收窄打红的测试——**而它红得是对的**（那正是「无法判定有没有赢家就别写」的语义）。**计划阶段必须重跑一遍这三条命令再确认**，因为上面这张表是对**今天**的套件测的，而 §4 的其它改动（签名扩容，§9 的 ⚠️）本来就要动 `fileStore.test.ts`。
- **⚠️ 明确写下它不修什么**：**它不关闭上面那条 T0/T1/T2 残余。** T0 那次 ENOENT 是「确定没有赢家」的**真实**观测，只是这个观测在 T2 已经过期。**把 ENOENT 也一并 fail-closed 会关闭它，但代价不可接受**：任何一个从未发生过转移的 run（即绝大多数 run）在 `boundaryAnalysis.status === "stale_candidate"` 时都走这条路，`owner-transfer.json` 本来就不存在，一律 fail-closed 等于**再也不写 `reconciliation-record.json`**。那不是「增加拒绝」，那是删掉一条正常路径上的产物。

  ```bash
  grep -nF -B2 -A24 'await writeBoundaryArtifacts(runDir, {' src/controller/runLoop.ts
  # 实测 exit 0：:845 起，reconciliationRecord 的传入条件是
  # boundaryAnalysis.status === "stale_candidate"，**与「是否发生过转移」无关**——
  # 没转移时 nextOwnerEpoch 为 null、eligibleForContinuation 为 false，
  # 于是必进 preserveSuccessfulReconciliationIfNeeded，而此时 owner-transfer.json 不存在。
  ```

**处置二（不修，具名交接 L5）：T0/T1/T2 这条残余 TOCTOU。**

- **它是先于本层的缺陷。** 今天赢家也在事务之后经 `writeBoundaryArtifacts` 写 reconciliation，输家同样能用这条时序覆盖它。本层**不新增**这条路径，只是把它收窄。
- **关闭它需要的东西超出本层最小解**：要么给输家的 reconciliation 写加 `acquireOwnerTransferLock`（§4.3 已评估并否决的方案 (c)，爆炸半径远大于改一个常量数组），要么给这次写引入一次文件系统级 CAS / 写后复核重试环——两者都是新机制，不是「改一个常量的顺序」。按 Rule 2 本层不做。
- **具名进 §13 第 4 笔。**

**§15 验收 1a 的范围相应收窄**（见那里）：它承诺的是「在 transfer + owner 已发布、reconciliation 未发布的窗口内不得降级」，**不是**「输家在任何时序下都不得降级」。测试 6e 钉的也正是那个窗口。

**接受的代价（诚实记下）**：「transfer 已发布、reconciliation 缺失」从「连瞬时都不出现」变成**一个真实的瞬时窗口**。该窗口内 marker **必在盘上**（marker 的 `safeUnlink` 在三次 rename 全部完成之后），所以 marker 驱动的恢复覆盖它。次生代价：`resumeLoop` 的 `Promise.all` 里 `readReconciliationRecord` 与触发恢复的 `readOwnerRecord` 并行，可能在恢复完成前读到 ENOENT，于是**该次** sweep 拒绝、下一次 sweep 通过。这是**瞬时且自愈**的 liveness 抖动，不是安全洞，本层接受并在 §15 验收 1 如实写明。

**评估过并否决的另外两条：**

- **(b) 保留赢家事后那次 `writeBoundaryArtifacts` 的 reconciliation 写。** 否决：它只在 `writeBoundaryArtifacts` 之前那个**无条件 `assertHeld()`** 通过时才发生，而「`assertHeld` 抛出」正是债 1 的定义场景。也就是说它恰好在需要它的那个场景里不执行，修不了任何东西，只多一次冗余写。
- **(c) 让输家的 reconciliation 写也进 `acquireOwnerTransferLock`。** 否决：`writeBoundaryArtifacts` 被非转移路径也调用，给它加锁会让一条从不失败的路径新增一类 `OwnerTransferLockBusyError` 失败，爆炸半径远大于改一个常量数组的顺序，且要动锁协议的适用范围。**不排除它是更彻底的解**，但本层不做——按 Rule 2 取最小解。

**钉住这次改判的测试是 §10 测试 6e**（新增），验收面是 §15 验收 1a。

**为什么排序不是承重论证（第一轮结论，原样保留）：**

**真正承载 fail-closed 的不是顺序，是 `evaluateResumeEligibility` 里的两条 epoch 相等判定**：

- **判据 A**：`reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`
- **判据 B**：`ownerRecord.currentOwnerEpoch === ownerTransfer.newOwnerEpoch`

评审员用「N→N+1 已成功、N+1→N+2 崩在中途」的双转移场景逐字段追过，**并且在 `resumeLoop` 那个并行 `Promise.all`（它不是快照，见 §4.0a）的每一种混合采样下追过**：每一种都被这两条之一挡住。marker 恢复对**两种排序同样有效**，所以崩溃论证本身并不能在两个顺序之间做区分——**能做区分的是上面那条输家覆盖路径**。

**这两条 epoch 相等判定是本层之后任何改动都不得削弱的东西**——§10 测试 6b 就是钉它的，而测试 6b 的 fixture 要求见 §10（判据 A 只有双转移 fixture 杀得掉）。

### 4.4 finalize 机制 —— **改判为 marker 驱动**（初稿选错，此处是再决策）

初稿选「pending 存在性驱动」（reconciliation pending 存在就发布、不存在就跳过），理由是「零新失败模式」。**评审证明该理由为假，且它接受的失败模式严格更差：**

**推翻它的场景**：SIGKILL 落在 marker 写入之后、reconciliation pending 写入之前。磁盘：marker 在、两个旧 pending 在、无 reconciliation pending。下一次 `readOwnerRecord` → 恢复 → 见 marker → finalize → 按「不存在就跳过」的规则**发布 transfer 与 owner record，然后删掉 marker**。结果正是「transfer 已发布、reconciliation 缺失」，**且 marker 已删，永不可恢复**。

机制上无法检测——因为「pending 缺席」被**定义**成了「这是 v1 事务」。而初稿的**测试 4 恰好把这个磁盘状态断言为正确行为**，等于把缺陷的形状写进套件。

**「不可解析的 marker」是响亮的失败；「静默降级的提交」不是。初稿避开了前者，接受了后者。**

**⚠️ 「响亮」这个词在第一轮修订里是无依据的**（第二轮评审，Critical）。具名错误从 `readOwnerRecord` 逃出后，被 `resumeLoop` 的 `Promise.all` catch 包成 `ResumeNotEligibleError`；而 §8 的错误表把 `ResumeNotEligibleError` 归为「**正常结果，不是错误**」→ stdout → exit 0。**在实际调用图上它一点都不响亮**，cron 的「有 stderr 即告警」永远不会响。

```bash
grep -nF 'cannot read run artifacts' src/controller/resumeLoop.ts
# 实测 exit 0，2 行：一行 appendEvent(resume_denied)，一行
# `throw new ResumeNotEligibleError(...)` —— Promise.all 的 catch 把任何读侧抛出
# 统一改写成 ResumeNotEligibleError，原错误类型在这里被丢掉
```

**本立论靠 §8 的路由兑现，不靠错误类型本身**：§8 已为这类失败**单开一行** → stderr + outcome `error`，不再落进 `refused`。

**⚠️ 路由判据改判（第三轮评审，Critical）：放弃「按 `Error.cause` 路由」，改为按报告层的 message 前缀路由。** 第二轮写的是「`resumeLoop` 改写时带上 `cause`（`throw new ResumeNotEligibleError(msg, { cause: error })`），sweep 按 `cause` 分类」。**三个问题，逐条附实测：**

1. ~~**方向反了，而且反得正好。** §4.4 自己判定规则 2/3 在生产中不可达（原子 marker + 暂存顺序不变式），所以「具名拒绝错误」这条 `cause` 分支守的是**不可达**分支。……~~

   **⚠️ 这条理由的前提在第四轮被推翻，现予撤回。** 它建立在「规则 2 不可达」之上，而上面「⚠️ 规则 2 **可达**」一节给出了一条可达路径（并发恢复：P2 删锁 → P3 短路进 finalize → P2 先删掉 marker 与 pending → P3 读 pending 得 ENOENT）。**规则 2 的具名错误因此是可达的，「守的是不可达分支」为假。**

   **但否决结论本身仍然成立。**

   **⚠️ 第六波更正：第四轮写的「由理由 2 与理由 3 *独立*承重」为假 —— 那是同一条事实的两种陈述，而且它薄。**

   - 两条事实各自都对：`ResumeNotEligibleError` 确实是单参构造（`src/controller/resumeLoop.ts:21`–`:22`），`new` 它的地方确实只有 4 处（`grep -rnF 'new ResumeNotEligibleError' src/ tests/` **第六波实测 exit 0，命中 4 行：`src/controller/resumeLoop.ts:120` `:126` `:144`、`tests/controller/resumeLoop.gate.test.ts:97`**）。
   - **但理由 2 不能作为反对意见承重。** 「按当前签名编译不过」对**任何**被提议的签名变更都成立——它陈述的是「这需要改签名」，而那正是理由 3 的前件。**两条其实是一条。**
   - **而那条爆炸半径实测很薄**：`src/` 内三处是产生点、本来就要跟着改；测试侧只有 1 文件 1 行，且若第二参设为**可选**，那一行一个字都不用动。**用它作为否决一条设计方案的唯一依据，站不住。**

   **第六波改写后的承重结构（结论不变，依据换掉）**：**否决由「替代方案严格更简且覆盖更宽」这一条承重** —— 前缀路由**恰好接住了那条可达路径**（见紧接的下一段），且 `resumeLoop.ts` **一个字节不改**、`ResumeNotEligibleError` 的签名不动、`resumeLoop.gate.test.ts` 不受影响。**理由 2 与理由 3 保留在下面，但降级为同一条爆炸半径事实的两种陈述，不再各自计为一条独立理由。**

   **并且**：§4.4 采用的替代方案（按 `cannot read run artifacts:` 前缀在报告层路由）**恰好把这条可达路径接住了**——它捕获 `Promise.all` 里**任何**读侧抛出，包括规则 2 的具名错误。**所以撤回这条理由不改变任何落地内容，只是把一条假的论证依据换掉。**
2. **当前签名下编译不过。** 

   ```bash
   grep -rnF -A6 'class ResumeNotEligibleError' src/
   # 实测 exit 0：src/controller/resumeLoop.ts:21 声明，:22 constructor(message: string)
   # —— 单参数。new ResumeNotEligibleError(msg, { cause }) 是 TS2554。
   ```

3. **它被写成了「catch 里改一行」，实际是一个*导出类*的公开签名变更。** `tests/controller/resumeLoop.gate.test.ts` 直接 `new` 它。§9 第二轮把这条列成 `resumeLoop.ts` 行里的一句话，掩盖了爆炸半径。

**（可以撤销一条第二轮遗留的担心：`Error.cause` 的 Node/TS 版本风险不存在。`grep -nF '"target"' tsconfig.json` 实测 exit 0，命中 1 行 `"target": "ES2022"`；`@types/node` 为 `^22.x`。**否决这条改动的理由与版本无关，纯粹是「守错了分支 + 改了导出签名」**。）**

**采用的最小解：本层放弃这笔生产改动，路由判据放在 sweep 自己的报告层。** `resumeLoop` 在读侧失败时抛出的 message 有一个全仓唯一的前缀 `cannot read run artifacts:`：

```bash
grep -rnF 'cannot read run artifacts' src/ tests/
# 实测 exit 0，命中 3 行：
#   src/controller/resumeLoop.ts:119  appendEvent(resume_denied) 的 detail
#   src/controller/resumeLoop.ts:120  throw new ResumeNotEligibleError(...)
#   tests/cli/cli.test.ts:73          既有断言（说明这个前缀已经是被依赖的契约）
# src/ 内只有 resumeLoop.ts 这一处产生它 —— 前缀唯一。
```

`sweepRuns` 判 `error instanceof ResumeNotEligibleError && error.message.startsWith("cannot read run artifacts:")` → outcome `error` → stderr。**`resumeLoop.ts` 一个字节不改，`ResumeNotEligibleError` 的签名不动，`resumeLoop.gate.test.ts` 不受影响。**

**代价，明写**：这条路由把「读侧任何失败」整体归为 `error`，不区分具体原因——比按类型路由粗。**本层接受**：§8 那一行要的性质是「有 stderr 即告警」，而 detail 里会带完整 message（含原错误的 `String(error)`，见 `:120`），诊断信息一点没少。**⚠️ 这使前缀字面量成为一条被依赖的契约**，`resumeLoop.ts:119`/`:120` 与 sweep 的判据必须同笔改动；§10 测试 12c 钉这一点。

**采用的机制：**

1. marker 成为**被读取**的字段：finalize 解析 marker，按其 `finalizeOrder` 声明的文件集合与顺序办事。`version` 成为联合类型（1 | 2），v1 声明两个文件、v2 声明三个。
2. **v2 marker 但某个 pending 缺失 → 拒绝 finalize，保留 marker 与全部 staging**，抛一个具名错误。fail-closed。
3. **marker 不可解析 → 同样拒绝 finalize，保留一切**，抛具名错误。
4. v1 marker 按两文件路径走完，不抛。
5. **marker 改为原子写**（§4.0.3，人已裁定）。

**规则 2 / 3 的可达性与恢复手段 —— 第二轮评审要求正面写清，不得含糊成「可恢复、可诊断」：**

第一轮修订说这两种状态「保持**可恢复、可诊断**」。**「可诊断」成立，「可恢复」在本层没有任何机制兑现——那句话现予撤回。** 逐条：

- **规则 3（marker 不可解析）：因 §4.0.3 的 marker 原子写而不可达。** rename 之前 marker 不可见，rename 之后 marker 完整。分支保留为**纵深防御**（例如有人手工放了一个坏 marker，或将来有人把原子写改回去），不作为可达路径论证。
- **规则 2（v2 marker 但 pending 缺失）：~~因暂存顺序不变式（三份 pending 全部 rename 完成才写 marker，且 marker 原子）而不可达~~ —— 这个结论在第四轮被推翻，见下面「⚠️ 规则 2 可达」。**

##### ⚠️ 规则 2 **可达**（第四轮评审，Important）：原论证只覆盖「谁写坏 pending」，没覆盖「谁*删* pending」

**原论证的形状**：暂存顺序不变式保证 marker 出现时三份 pending 已齐备且完整，加上 pending 原子写消掉截断态，**所以 pending 不会既缺失又有 marker**。**这只排除了「写」这一侧。** 而 pending 也会被**删**——`finalizePendingOwnerTransfer` 尾部三个 `safeUnlink` 干的就是这件事。

**可达路径（逐环回代码走过）：**

```bash
grep -nF -A22 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts
# 实测 exit 0：:520 签名、:538-:540 pid 活 → return false、:552 `await safeUnlink(lockPath);`、:553 return true
grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
# 实测 exit 0：:630 签名、:640 `if (!options?.lockHeld && await pathExists(paths.lockPath)
#   && !(await tryRecoverStaleOwnerTransferLock(runDir))) return;`、:644 finalizePendingOwnerTransfer
grep -nF -A24 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
# 实测 exit 0：:608 签名、:610/:611 try 之前的两次 readFile+JSON.parse（本层之后是 marker 1 + pending 3）、
#   :620 safeUnlink(marker)、:621 safeUnlink(transferPending)、:622 safeUnlink(ownerPending)
```

1. P1 持锁写完三份 pending ＋ marker 之后被 SIGKILL。**锁文件留在盘上，pid 已死。**
2. P2 走 `readOwnerRecord` → `recoverInterruptedOwnerTransfer`（不持锁）→ `:640`：marker 在、锁在，`tryRecoverStaleOwnerTransferLock` 判 pid 死 → 落到 **`:552` `safeUnlink(lockPath)`** → return true → `!true` = false → **P2 进 finalize**。
3. **锁此刻已被 P2 删掉。** P3（另一个并发进程，例如另一次 sweep）随后走同一条路：`:640` 的 `await pathExists(paths.lockPath)` **短路为 false** → 整个合取为 false → **P3 也进 finalize**。
4. P2 先跑完，`:620`–`:622` 把 marker 与三份 pending 全部 `safeUnlink` 掉。
5. P3 停在 `:610`/`:611`（本层之后还多一次 marker 的 readFile）→ **ENOENT** → 正是「v2 marker 但 pending 缺失」。

**后果两条，都必须写下来：**

- **规则 2 规定「保留 marker 与全部 staging」，但 marker 此刻已被 P2 删了。** 规则 2 的处置在这条路径上是**空操作**——它保留的是一组已经不存在的东西。**这不是错误，但「保留 marker 与全部 staging」这句话在这条路径上为假**，不得当成不变式引用。
- **抛出的具名错误逃出 `readOwnerRecord` → `resumeLoop` 的 `Promise.all` catch → 按 §4.4 定的 `cannot read run artifacts:` 前缀路由判为 `error` → stderr。** 也就是说：**一次完全成功的转移会打一次告警。**

**级别与处置**：定 **Important 而非 Critical**——它是**一次性**的，不是永久钉死（P2 已经把事务推完，盘上三个文件齐备；P3 下一次读就正常）。**本层不修**（修它要动锁协议：把「删锁」与「进 finalize」做成一个原子步，属 §13 第 1 笔「锁可被偷」的同一范围）。**本层的处置是把「不可达」这个结论撤回**，规则 2 从「纵深防御分支」升级为**「低频但可达的分支，且它的『保留 staging』承诺在最常见的那条可达路径上落空」**。

**⚠️ 连带：§15 验收 2 的例外清单第 3 条不再能说「三者全部不可达」**，已就地改。**规则 3（marker 不可解析）仍然不可达**——上面这条路径不产生坏 marker，只产生「marker 已被删」。

- **规则 3 之外的其余不可达论证不受影响。** 分支同样保留为纵深防御。
- **「pending 被写坏（截断）」——第二轮列为「真实可达」，第三轮因 §4.0.3a 的裁定改判为不可达。**

  第二轮的可达性论证是对的**在当时**：三份 pending 走裸 `writeJsonFile`，`finalizePendingOwnerTransfer` 在 try **之前**就 `JSON.parse` 它们，parse 抛出一路逃出 `readOwnerRecord`，marker 仍在盘上 → 每一次 `readOwnerRecord` 重复同一次抛出。

  ```bash
  grep -nF -A4 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
  # 实测 exit 0：:608 签名、:610 与 :611 是 try 之前的两次 readFile + JSON.parse
  # （本层加入第三个文件之后是三次 pending，再加规则 1 要解析的 marker，合计四次；见 §10 测试 2）
  grep -nF -e 'await writeJsonFile(paths.transferPendingPath' -e 'await writeJsonFile(paths.ownerPendingPath' src/persistence/fileStore.ts
  # 实测 exit 0，命中 2 行：:675、:676 —— 改动前 pending 确实走裸 writeJsonFile
  ```

  **人已裁定（§4.0.3a）：三份 pending 一并改原子写。** 之后 pending 只有「不存在」与「完整」两态：「不存在」由规则 2 接住（fail-closed，保留 marker 与 staging），「完整」正常 finalize，**中间那个截断态不再存在**。**所以这一条从「真实可达、本层扩大影响面、具名传 L5」改判为「与规则 2/3 同类的纵深防御」**，§13 第二轮那笔（三份 pending 的非原子写）**由本层收回**。

  **⚠️ 这条改判把本层的改动面扩大了，必须诚实记账**：本层现在动的不只是「加第三个文件 + marker 原子」，还包括**把两份既有 pending 的写法从裸写改成原子写**。那是对先于本层的代码的修改，理由是 §4.0.3a 的裁定与 S-3 证据范围必须对齐——**不是实施者顺手改进**。

这三类状态全部写进 §15 验收 2 的具名例外。**不允许再用「可恢复」一词描述其中任何一种，除非同时给出恢复它的代码路径。**

### 4.5 本节修好了什么（措辞已按评审收窄）

`writeBoundaryArtifacts` 之前那个**无条件 `assertHeld()` 原样保留**——L1b 的「只增加拒绝」立场一个字不改。变的是它身后守着的东西：赢家路径上它现在只守 `boundary-analysis.json`。

**关于「没人依赖 `boundary-analysis.json`」—— 初稿把它写成绝对断言，而附的命令刻意只覆盖了它成立的那个目录。** 事实是：

```bash
grep -rnF 'boundary-analysis.json' src/                    # 1 处，是写入
grep -rlF 'boundary-analysis.json' validation/ tests/      # 6 个文件，有读者
```

`validation/v1/lib/evidence.ts` **会读它并做 Zod 校验**，`validation/v1/README.md` 把它列为消费产物，四个测试文件读或断言它。该 harness 对缺失有 `MISSING` 降级，所以**不是正确性破损**——但正确表述是「**`src/` 内无生产读者**」，不是「没有任何读者」。

**⚠️ 归属更正（第二轮评审）**：第一轮修订写「**本层之后**，赢家路径上 `boundary-analysis.json` 在 supersede 窗口内可能缺失」——**那是先于本层的既有事实，不是本层引入的**。L2 spec §13.1 第 1 条已白纸黑字记着：

> **Reconciliation synthesis is unowned.** Consequence of the L1b ruling that the `writeBoundaryArtifacts` call is guarded unconditionally (`src/controller/runLoop.ts`, the `heartbeat.assertHeld()` / `writeBoundaryArtifacts` pair). A completed `owner-transfer.json` may now exist with neither `boundary-analysis.json` nor `reconciliation-record.json`.

```bash
grep -nF -A10 'Reconciliation synthesis is unowned' docs/superpowers/specs/2026-07-28-run-registry-design.md
```

**本层对这条既有事实的改变是单向收窄**：`reconciliation-record.json` 那一半被 §4 消除，`boundary-analysis.json` 那一半按本节刻意保留为有损（validation harness 观测到 `MISSING`，已知且可接受）。**本层没有新增任何缺失窗口。**

**债 1 不是靠移除守卫修好的，是靠把守卫身后那件有生产依赖的东西搬进事务修好的。**

### 4.6 与既有代码的关系

`preserveSuccessfulReconciliationIfNeeded` **代码零改动**。

**⚠️ 但第一轮修订给的理由已过时**（第二轮评审）。它写的是「赢家路径因为 `eligibleForContinuation` 是类型级 `true` 而必然**早退**」。§4.3 之后赢家传 `reconciliationRecord: undefined`，而 `writeBoundaryArtifacts` 里那句 `if (artifacts.reconciliationRecord !== undefined)` 直接跳过整个分支，**赢家根本走不到那个早退**。

```bash
grep -nF -A14 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts
# 实测：reconciliationRecord === undefined 时，preserveSuccessfulReconciliationIfNeeded 不被调用
```

**正确的理由**：本层之后，赢家路径**根本不再调用**这个函数（`reconciliationRecord` 传 `undefined`），输家路径的调用形态与今天逐字节相同。**两侧都不需要改它的代码**，所以结论「代码零改动」仍然成立，只是靠的是另一条依据。（**若将来有人改回 §4.3 否决过的方案 (b)，即赢家继续补写 reconciliation，本段理由要跟着改回早退论证。**）

```bash
grep -nF -A4 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts
```

（**`-F` 必须保留，理由只有一条、且与退出码无关：裸符号名不唯一**——它还会命中 `preserveSuccessfulReconciliationIfNeededFromArtifacts`，带 `async function ` 前缀才唯一。

**⚠️ 第四轮：此前两轮在这里各写过一次「退出码理由」，两次互相矛盾、且都不可复现，现予全部撤销。**

- 初稿写「不加 `-F` 会因未闭合分组报错退出 2」（从裁决记录抄的，没跑）。
- 第一/二轮实测「exit 0」并据此判它为假；第三轮的 §4.6a 又为这个「假」补了一个方言机制。
- **第四轮在同一个壳里重跑同一条命令，得到 exit 2**（原始输出见 §4.6a）。

**处置：不再用退出码作为保留 `-F` 的理由**，改用「裸符号名不唯一」这条与方言、与 `grep` 实现、与退出码全部无关的结构性理由。**完整论证与四轮观测的对照见 §4.6a。**）

**⚠️ 裁决记录该处至今未勘误。第四轮改变了勘误的性质，不再宣称它「为假」。** 主张原文在 `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` 债 1「修法方向可行性」一节：「本仓库的 `grep` 被改写成正则引擎，锚点末尾的 `(` 会被当成未闭合分组而**报错退出 2**，而不是返回 0 命中」。

**本层现在的判定**：**这条主张的真值取决于一次不可复现的观测，不予采信——既不引用它，也不引用它的否定。** 第一/二/三轮判它为假、第四轮实测到它为真，**两边都拿不出可复现的证据**。按本仓库「就地勘误、不改原件」的立场，**不修改裁决记录**；后来者读到那句话时**不应把它当成任何论据的依据**（无论正反），保留 `-F` 的理由以上面那条「裸符号名不唯一」为准。

```bash
grep -nF '会被当成未闭合分组' docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
```

#### 4.6a 这条勘误的**机制**（第三轮补；同时驳回一条本轮被提出的反向改法）

第三轮有人提出：这条勘误「方向反了」，因为交互 shell 里 `grep` 是 `~/.claude/shell-snapshots/` 的 zsh 函数（ugrep 系），末尾带 `(` 的锚点不加 `-F` 会 exit 2，只有子 shell 解析到 `/usr/bin/grep` 才 exit 0；据此应把裁决记录那条从「假」降级为「未限定 grep 实现」。

**实测不支持这条反向改法。** 在**装着那个 zsh 函数的 shell 里**逐条跑（`type grep` 先确认身份）：

```bash
type grep
# 实测：grep is a shell function from /Users/biran/.claude/shell-snapshots/snapshot-zsh-<id>.sh
grep -n  'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts; echo $?
# 实测：命中 1 行（:279），exit 0
grep -nE 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts; echo $?
# 实测：ugrep: error ... mismatched ( ) ，exit 2
/usr/bin/grep -n 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts >/dev/null; echo $?
# 实测：exit 0
declare -f grep
# 实测：该函数体里对 ugrep 显式传了 -G（ARGV0=ugrep "$_cc_bin" -G --ignore-files --hidden -I ...）
```

~~**机制因此是确定的，而且与「在哪个壳里」无关**……~~

#### ⚠️⚠️ 上面那个「机制」在第四轮被自己的仓库证伪，整节重写（第四轮评审，取代此前**四种**互不相容的解释）

**四轮下来，同一个现象出现了四种互不相容的机制解释**：「取决于哪个壳」（第三轮被提出的反向改法）/「取决于 `-E` 方言」（第三轮 §4.6a 采用的）/「取决于 `-c`/`-n` 输出标志」/「目录参数只由解析到谁决定」。**而第四轮在同一个壳、同一次会话里，对同一条命令先后测到 exit 2 与 exit 0。**

**先钉住 `grep` 的身份（本节的范例要求：写「实测」必须连同 `type grep` 一起写）：**

```bash
type grep
# 实测（第四轮）：grep is a shell function from
#   /Users/biran/.claude/shell-snapshots/snapshot-zsh-1785583056984-suirbu.sh
declare -f grep
# 实测：函数体里对 Claude Code 的二进制显式传了 -G 并伪装成 ugrep：
#   ARGV0=ugrep "$_cc_bin" -G --ignore-files --hidden -I --exclude-dir=.git ... "$@"
# 即 `grep` 根本不是 GNU grep，也不是 ugrep 本体，而是 Claude Code 二进制的 -G 子命令。
```

**证伪 §4.6a 原「机制」的实测（三条，同一次会话，逐条贴退出码）：**

```bash
grep -n  'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts >/dev/null 2>&1; echo "exit=$?"
# 实测（第四轮）：exit=2
# —— **与第三轮 §4.6a 就地记录的「命中 1 行（:279），exit 0」直接矛盾**，
#    而两次都在装着同一个 zsh 函数的壳里、都没加 -E/-P。
grep -n  'writeOwnerRecord(runDir' tests/persistence/fileStore.test.ts >/dev/null 2>&1; echo "exit=$?"
# 实测：exit=2，stderr 打 `regex parse error: ... unclosed group`
# —— 这里的 `(` 在**模式中间**，不在末尾。所以「末尾 ( 是字面量」这个位置性解释也不成立。
grep -e 'currentOwnerEpoch' src/ownership/ownerController.ts >/dev/null 2>&1; echo "exit=$?"
# 实测：exit=0 —— `-e` 在本 wrapper 里工作正常，**本轮有人报的「-e 是 invalid option、exit 2」不成立**
#   （本 spec 全文大量使用 `-nF -e X -e Y`，那些命令一直是有效的）。
```

**结论与本层就此定死的规矩（取代此前全部说法）：**

1. **任何不带 `-F` 的 `grep`，它的「实测 exit N」一律不作数** —— 不管是谁跑的、跑出什么。本仓库已在同一个壳里对同一条命令得到过两个不同的退出码，**该观测不可复现，因此不能作为任何论据的依据**。
2. **本文档里所有非 `-F` 的重推命令一律改成 `-F`**；确实需要正则的（例如 §11 末尾那条 `grep -nE '^[0-9]+\. \*\*'`）改用 `-E` 并**显式标注为「需要正则，退出码不作数，只看输出行」**。
3. **§4.6a 原来的全称命题予以撤回**：它写的是「决定退出码的是正则方言标志，不是 `grep` 解析到谁」，**而 §4.3「组装点改判」那条目录参数的命令当场证伪了它**（wrapper 对目录给 exit 1，`/usr/bin/grep` 给 exit 2，两者方言相同）。**表述限定回原来的适用范围**：本节讨论的只是**「末尾 `(` 这一类锚点」**，**并且连这一类的退出码机制也不可复现，因此不作为论据。**
4. **不采用 `-e` 作为 `-F` 的替代**——不是因为 `-e` 坏（实测它工作正常），**而是因为 `-e` 解决的是「多个模式」而不是「模式被当正则解释」**，换成 `-e` 一个字都不改变本节的问题。**`-nF -e X -e Y` 这个既有写法保持不变。**

**裁决记录那条主张的处置（勘误方向本轮再判一次）**：它写的是「锚点末尾的 `(` 会被当成未闭合分组而**报错退出 2**」。**按第四轮的实测，这句话在本壳里是*真的***（exit=2）；按第三轮的实测它是假的。**两轮的观测互相矛盾且都不可复现，所以本层的处置是：既不判它真、也不判它假，而是判定「这条主张所依赖的观测不可复现，因此它不能被任何一方引用为论据」。** §4.6 那条「就地勘误」的措辞相应从「按其字面为假」改为「其真值取决于一次不可复现的观测，不予采信」。

**⚠️ G5 的结论与它的论证分开处理**：G5 判「§4.6/F47 的勘误方向反了」这条 finding **不成立** —— **这个结论本层维持**，但**它的论证必须重写**，因为它建立在「两个壳给同一个答案」这个已被证伪的观测上。**改用的、与退出码完全无关的理由**：**裸符号名不唯一**（`preserveSuccessfulReconciliationIfNeeded` 会同时命中 `preserveSuccessfulReconciliationIfNeededFromArtifacts`），**所以锚点一律 `-F`**；`-F` 让锚点与方言标志、与 `grep` 解析到谁、与退出码机制**三者全部解耦**。**这条理由不依赖任何一次退出码观测，因此不会被下一轮的观测推翻。**

**本轮留下的元教训**：一个被观测到过、但**不可复现**的现象，在四轮里被四个不同的人各自补上了一个「机制」，**每一个都自洽、每一个都被下一轮证伪**。**正确的处置是停止解释它，并把依赖它的论据全部换掉**——而不是补第五个机制。

**语义非零改动**：见 §4.0a 末尾——`readPersistedSuccessfulTransferArtifacts` 的 `Promise.all` 里有一个读会触发恢复，而恢复现在会写第三个文件。代码不用改，但这条性质必须记下来，且 §10 测试 6b 钉住真正承重的东西。

输家路径完全不进事务，继续走 `writeBoundaryArtifacts`，行为不变。

## 5. 债 3 — `heartbeat.stop()` 释放窗口

### 5.1 机制复核

```bash
grep -nF -A10 'const stop = async (): Promise<void> => {' src/controller/leaseHeartbeat.ts
grep -nF -B12 -A8 'const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {' src/controller/leaseHeartbeat.ts
```

`stop()` 置 `stopped = true`、`clearInterval`、`await queue.catch(...)`、`releaseOwnerLease`。今天不可达仅仅因为两个 `stop()` 调用点都在 `await runLoopFromState` 之后的 `finally` 里（`runLoop.ts` 与 `resumeLoop.ts` 各一处）。

### 5.2 完整性论证：为什么「`stopped` 后拒绝」就够

- `stopped = true` 与读取 `queue` 那一步之间**只隔一个同步的 `clearInterval`，没有任何 `await`**。
- `runExclusive` 的函数体是纯同步的，调用返回时 `queue` 已包含 `fn`。

**任何在 `stopped` 置位前发起的 span 必已被折进 `stop()` 读到的 `queue`；任何之后发起的必然看见 `stopped === true`。** 两侧穷尽，无需 drain 循环。（三个评审员独立复核，一致确认。）

**⚠️ 范围声明（第二轮评审补，不得省略）：「两侧穷尽」只对 *exclusive span 内部* 成立。**

`runExclusive` 的拒绝只覆盖进入 `queue` 的那一段。而 `persistBoundaryAnalysis` 里 `runExclusive` **返回之后**的 `assertHeld()` + `writeBoundaryArtifacts` 明确留在 span **外面**——代码注释自己写着这句：

> `writeBoundaryArtifacts` below stays OUTSIDE: there is no reason to make the heartbeat wait behind artifact writes.

```bash
grep -nF -B6 'const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(' src/controller/runLoop.ts
grep -nF -A3 'await heartbeat.assertHeld();' src/controller/runLoop.ts
```

**因此一次并发 `stop()` 完全可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 改动 A 不覆盖这一段，本层也不覆盖它（覆盖它要么把 artifact 写搬进 span——L1b 刚刚明确否决过——要么另设一层守卫）。**§13 据此把债 3 记为「exclusive span 部分关闭」，span 外那段具名传给 L5。**

### 5.3 改动 A — `runExclusive` 拒绝

**先把在先的裁定完整引出来**（初稿只引了前半句，而被略掉的后半句正好禁止本改动——这是 Rule 7 要求「挑一个并说明为什么」的场合）：

> Takes no position on `stopped` or `superseded` — it only serializes. **Refusal is Task 5's job; duplicating it here would just be a second, weaker copy of a decision that already has one home.**

**⚠️ 第一轮修订给的推翻理由已被改判 B 抽掉地基，现予改写（第二轮评审，Critical）。**

第一轮写的是：「那条裁定成立的前提是『`stop()` 之后不会再有 `runExclusive`』——L1b/L2 时期为真，因为没有触发调用者。**L3 是让这个窗口可达的那一层**，前提不再成立。」

**两个问题：**

1. **「那条裁定成立的前提是……」这句话注释里没有**，是本 spec 自己替它重建的。在一份把「引全句、不得替原文补论证」立为铁律的文档里，这是双标。注释的**全文**只有上面引的那两句，它没有陈述任何前提。
2. **更要命的是：§5.4 采用的设计把那个「前提」原样保住了。** 改判 B 把信号处理器装在 `cli.ts`（只置槽）、`sweepRuns.ts` 保持纯函数、逃生口是 `process.exit(130)`，**L3 内没有任何路径会在 `runLoopFromState` 飞行期间调 `heartbeat.stop()`**：

   ```bash
   grep -rnF 'heartbeat.stop()' -- src
   # 实测 2 处：src/controller/runLoop.ts:929、src/controller/resumeLoop.ts:185，
   # 都在 await runLoopFromState(...) 之后的 finally 里
   ```

   **所以「L3 让这个窗口可达」按本 spec 自己采用的设计为假。** 按 Rule 7 必须挑一个，不能两节各说各的。

**本层采用的理由（改写后，不依赖那个被抽掉的前提）：**

**这里的拒绝不是 `assertHeld` 那条决策的第二份弱拷贝，因为「本进程心跳已停」这个命题今天根本没有 home。** 实测 `assertHeld` **从不读 `stopped`**：

```bash
grep -nF 'stopped' src/controller/leaseHeartbeat.ts
# 实测命中 8 行：:38 声明、:78 与 :296 是注释、:138 在 runAffirm 内、:193 是被推翻的那条注释、
# :217 与 :221 在 stop() 自己内、:278 是注释。assertHeld（:252 起）一次都没读它。
grep -nF -A30 'const assertHeld = async (): Promise<void> => {' src/controller/leaseHeartbeat.ts
```

`assertHeld` 判的是「所有权还在不在」（读持久 owner record），`stopped` 判的是「本进程还打不打算继续」（纯进程内状态）。**两个命题不同，而后者今天没有任何守卫读它，所以谈不上「第二份弱拷贝」——这个论据比 spec 第一轮给的强，且不依赖任何关于可达性的主张。**

**关于可达性，本层的诚实表态**：`stopped` 之后的 `runExclusive` 在 **L3 内不可达**（上面那条 grep 就是证据）。本改动是**纵深防御**，也是 §14 常驻形态（`watch`）的前置加固——常驻形态会让飞行中 `stop()` 真正可达。**因此本层不主张「在先裁定的前提不再成立」**；本层主张的是：那条裁定把「refusal 只有一个 home」当作理由，而这个特定命题恰恰没有 home，所以拒绝在此处不构成重复。

**新增错误类型** `RunHeartbeatStoppedError`（`readonly stopReason = "heartbeat_stopped"`，形状照抄现有两个）：

```bash
grep -nF -A4 -e 'export class RunLeaseLostError' -e 'export class RunLeaseUnverifiableError' src/ownership/lease.ts
grep -nF 'export class' src/ownership/lease.ts
# 实测 exit 0，命中 3 行：:10 RunLeaseHeldError、:20 RunLeaseLostError、:29 RunLeaseUnverifiableError
```

**⚠️ 硬约束（第三轮评审，Critical）：`RunHeartbeatStoppedError` 与现有两个是*并列*的，*不得*继承其中任何一个（也不得让它们继承一个共同基类）。** 方案 (a) 的**全部**安全性建立在 `isLeaseStopError` 的 `instanceof` **不**匹配它上——一旦它成了 `RunLeaseLostError` 或 `RunLeaseUnverifiableError` 的子类，谓词一个字不改就会开始匹配它，F14 那条「两个既有调用点写 `cancelled`、把 §5.4 论证要防的永久终结从另一扇门放回来」原样复活，**而且没有任何测试名会提示原因**。

**本仓库对这件事已有判例，照抄它的写法（含那条注释的口气）：**

```bash
grep -rnF 'NOT a subclass' src/
# 实测 exit 0，命中 1 行：src/persistence/fileStore.ts:475
# 「Sibling of OwnerTransferPreconditionError, deliberately NOT a subclass: the two errors mean ...」
```

新类必须带一条同形注释，写明「deliberately NOT a subclass」**并点名它保护的是 `isLeaseStopError`**。§10 测试 9 钉这一点。

**⚠️ 硬约束本身在第四轮被判定为*不充分*（Minor，就地加强）：只写「并列且非子类」漏了抛出点这一半。**

今天 `RunHeartbeatStoppedError` 按设计**只从 `runExclusive` 抛**，而 `runExclusive` 唯一的生产调用点在 `persistBoundaryAnalysis` 内：

```bash
grep -rnF 'runExclusive(' src/
# 实测 exit 0，命中 1 行：src/controller/runLoop.ts:763 —— 在 persistBoundaryAnalysis 内（该函数 :704 起）
grep -nF 'persistBoundaryAnalysis' src/controller/runLoop.ts
# 实测 exit 0，命中 3 行：:704 定义、:1109 与 :1141 两个调用点
grep -nF 'isLeaseStopError' src/controller/runLoop.ts
# 实测 exit 0，命中 3 行：:105 定义（无 export）、:1001、:1353
```

`:1109` / `:1141` 都在 `:1353` 那个**外层** catch 的 try 内、**不在** `:988` 那个内层 `while (!worktreePath)` 的 try 内。**所以方案 (a) 成立**——新错误只会落到 `:1353`，被新分支接住。

**但若将来有人让 `assertHeld` 也抛这个错**（例如「心跳已停也算所有权不可断言」这种看起来合理的改动），它会落进 `:1001` 那个内层 catch：`isLeaseStopError` 不匹配它 → 跳过 `:1002` 的 return → 落到 `:1005` 的 `infraRetryUsed` 分支 → 第一次置位重试、**第二次直接 `persistTerminalState(runDir, state, "blocked_waiting_human", …)`**（`:1011`–`:1017`）。

```bash
sed -n '1000,1018p' src/controller/runLoop.ts
# 实测：:1001 isLeaseStopError → :1002 persistTerminalState(..., "cancelled", ...)；
#   :1005 if (infraRetryUsed) → :1006 appendEvent(workspace_create_failed)
#   → :1011 persistTerminalState(..., "blocked_waiting_human", ...) → :1017 return state;
```

**`blocked_waiting_human` 不在 `RESUMABLE_STATUSES`（`["planning","executing","verifying"]`）内，所以 §5.4 要防的永久终结从第三扇门原样回来**——只是终态名从 `cancelled` 换成了 `blocked_waiting_human`。**后果同构，测试名同样不会提示原因。**

**因此硬约束改写为**：`RunHeartbeatStoppedError` 与现有两个**并列且非子类**，**并且只从 `runExclusive` 抛出、绝不从 `assertHeld` 抛出**。**两半缺一不可**——第一半守 `:1353`，第二半守 `:1001`。**测试 7b 的 `instanceof` 断言只覆盖第一半**；第二半靠 §9 模块表把 `leaseHeartbeat.ts` 的改动面限死在「`runExclusive` 拒绝 + 其上方注释」来守，**并在此写明它是一条约束、不是一条巧合**。

**必须同笔改掉的三样东西**（第一轮修订只列了两条注释，把「谓词本身要接受新错误」降级成了隐含；第二轮评审要求显式列出，并已进 §9 改动清单）：

1. **`isLeaseStopError` 谓词本身**：类型守卫要从 `error is RunLeaseLostError | RunLeaseUnverifiableError` 扩到含 `RunHeartbeatStoppedError`，判定体同步。**这是代码改动，不是注释改动。**
2. `runExclusive` 上方那条注释（上面引的），它记录的裁定被本改动局部推翻。
3. `isLeaseStopError` 上方的「the **two** ways `heartbeat.assertHeld()` can refuse a side effect」——新错误来自 `runExclusive` 而**不是** `assertHeld`，**数量与来源两头都会变假**。

```bash
grep -nF -B4 'function isLeaseStopError(' src/controller/runLoop.ts
```

#### ⚠️ 改动 A 与 §5.4 的冲突（第二轮评审，Critical，2/3 撞到）—— 必须选一个

`isLeaseStopError` 的**两个**使用点都以写终态收尾：

```bash
grep -nF 'isLeaseStopError' src/controller/runLoop.ts
# 实测 3 行：:105 定义、:1001 与 :1353 两个使用点
grep -cF 'state, "cancelled"' src/controller/runLoop.ts     # 实测 4（其中两处正是这两个分支）
grep -nF 'cancelled:' src/state/stateMachine.ts             # cancelled: [] —— 终态，无合法出边
grep -nF 'RESUMABLE_STATUSES' src/controller/resumeLoop.ts  # ["planning","executing","verifying"]，不含 cancelled
```

**于是**：`RunHeartbeatStoppedError` 一旦进 `isLeaseStopError`，一次并发 `stop()` 就能让飞行中的 run 被写成 `cancelled`——**而 §5.4 用一整节论证「写 `cancelled` = 一次 Ctrl-C 永久摧毁飞行中的 run」，§5.3 从另一扇门把同一个后果放了回来。**

**注意这不是「遗漏」。** 下面那条 ⚠️ 确实提到了会终结为 `cancelled / heartbeat_stopped` 并写「接受」，但它给的接受理由只谈「跳过 `exhausted` 与相位超时原因的信息损失」，**从未认出被接受的其实是一次永久终结**。**理由答非所问，比遗漏更难被下一个读者发现。**

**本层的选择：(a) —— 新错误不进 `isLeaseStopError`，另设分支。**

- `isLeaseStopError` 的签名与判定体**保持今天的两种错误不变**（上面第 1 条相应作废；第 3 条那句注释里的「two」因此仍然为真，**不必改**；只有第 2 条注释仍要改）。
- 在 `runLoopFromState` 的外层 catch 里，**在 `isLeaseStopError` 分支之前**新增一条 `error instanceof RunHeartbeatStoppedError` 分支：**追加 `heartbeat_stopped` 事件，`writeRunState(runDir, state)`，返回该非终态 `state`，不调 `persistTerminalState`**。

**⚠️ 新分支的三处副作用，第三轮逐条查实并在此声明（第二轮只声明了第一处，把另两处留成静默）：**

```bash
grep -nF 'isLeaseStopError' src/controller/runLoop.ts
# 实测 exit 0，命中 3 行：:105 定义、:1001 与 :1353 两个使用点
grep -nE 'cleanupAttemptWorkspaceBestEffort|applyPhaseUsage' src/controller/runLoop.ts   # 需要正则：只看输出行，退出码不作为论据
# 实测 exit 0，命中 17 行。与本节相关的是外层 catch 内那三处：
#   :1366 applyPhaseUsage（PhaseExecutionError 分支内）
#   :1389-:1392 transitionRunState(state,"failed") + appendTransitionEvent + writeRunState
#   :1396 cleanupAttemptWorkspaceBestEffort
# 三处全部排在 :1353 的 isLeaseStopError 分支**之后**，而该分支 return 掉了。
```

1. **抢掉兜底的「转 `failed` 并落盘」（`:1389`–`:1392`）。这是意图**——一次停机不是 attempt 失败。
2. **抢掉 `cleanupAttemptWorkspaceBestEffort`（`:1396`）。第二轮未声明。** 本层**接受**它，理由与 L1 §12 第 9 条（「被挡住的副作用就地放弃而非回滚，残留 worktree 留给下一个 owner」）同形：残留 worktree 由下一次续跑的 `cleanupResidualWorktrees` 收拾。**这一条必须在 §10 测试 7b 里被断言**，否则它就是一条静默的行为变更。
3. **抢掉 `applyPhaseUsage`（`:1366`）。第二轮未声明。** 后果是相位耗时不计入 `state`——**这与「不消耗配额」方向一致，本层接受**。
- **⚠️ 「与 §5.4 同构」需要一个第二轮漏掉的前提**：§5.4 的停机点在 `while (true)` 顶端，那里刚跑过 `:974` 的 `writeRunState(runDir, state)`，所以「返回的 `state`」与磁盘**逐字节相同**。而本分支落在 attempt 中段，`state` 可能已被若干次 `applyPhaseUsage` 改过而**尚未**落盘（例如 `:1148` 之后要到 `:1221` 才 `writeRunState`）。**若只 return 不落盘，返回值与磁盘不一致，「同构」为假。** 因此上面明写要补一次 `writeRunState(runDir, state)`——**这是本轮新增的一条要求，不是第二轮的原文。**

  ```bash
  grep -nF 'while (true)' src/controller/runLoop.ts
  # 实测 exit 0，命中 1 行：:973
  grep -nF "await writeRunState(runDir, state);" src/controller/runLoop.ts
  # 实测 exit 0，命中 7 行：:974 :1031 :1078 :1221 :1301 :1310 :1392
  ```

  补上这次 `writeRunState` 之后，两处对「停机」的处置才真正一致：**都返回一个与磁盘相符的非终态 `state`。**
- **为什么不选 (b)（在写终态前判 `stopReason === "heartbeat_stopped"` 就跳过）**：那是在一条 fail-closed 分支里加一个字符串条件，读者要跨两个文件才能看懂它为什么在那儿；(a) 让两条停机路径长得一样。
- **为什么不选 (c)（明确接受终结、撤回 §5.4 的论证）**：§5.4 的论证是对的——写 `cancelled` 后 `resume` / `sweep` / `runLoop` 三条路全部拒绝，代码里没有任何路径退出终态。接受它就等于接受本层存在的理由被一次信号摧毁。

**§9 的改动清单已按 (a) 更新**：`runLoop.ts` 一行「新增 `RunHeartbeatStoppedError` 分支，不写终态」；`isLeaseStopError` 谓词**不改**。

**§13 的连带更正**：第一轮修订写「§5.4 不再新增 `persistTerminalState` 调用点，所以本层对债 2 的接触面为零」——**前提对、结论当时不成立**（§5.3 会让两个**既有**调用点被一类新错误触达，而债 2 恰是「`persistTerminalState` 往已不拥有的 run 写」）。选了 (a) 之后结论才真正成立，§13 已改为写明这个依赖关系。

**调用点事实更正**：`runExclusive` 只有**一个**生产调用点，在 `persistBoundaryAnalysis` 内，**不在** `runLoopFromState` 内。初稿写的「两个、在 `runLoopFromState` 内」两头都错——「两个」是 `persistBoundaryAnalysis` 的调用点数。

```bash
grep -rnF 'runExclusive(' src/    # 期望 1 行
```

落地路径**经由 `persistBoundaryAnalysis` 传递地**成立：它的两个调用点在 `runLoopFromState` 的 attempt `try` 内，外层 catch 的 `isLeaseStopError` 分支把这类错误当停机边界处理。

⚠️ **注意 `INERT_LEASE_HEARTBEAT` 与测试替身**：它们的 `runExclusive: (fn) => fn()` 是**桩**，不是调用点，**不要给它们加拒绝逻辑**——那会打断 `tests/controller/leaseLifecycle.integration.test.ts` 里若干提供同样桩的测试心跳。

⚠️ **新抛出会替换掉更有信息的错误**（记录而非修复；**已按上面的选择 (a) 重写**）：在 execute 超时无结果那条路径上，`RunHeartbeatStoppedError` 会抢在本该发生的处理之前逃出，跳过本来要写的 `exhausted` + 相位超时原因、跳过 `cleanupAttemptWorkspaceWithStatus` 与 `execution-recovery.json` 的 `cleanupStatus` 回填。今天不可达；在 §5.3 要防御的并发 `stop()` 场景下才变活。

**接受，理由**：那条路径上「本进程心跳已停」本来就意味着这些后续写入不该发生。**选了 (a) 之后，被接受的只是「这些写入不发生」，不再包含「run 被永久终结」**——run 停在非终态，下一次 sweep 仍然 eligible（与 §5.4 同构，§15 验收 4 覆盖）。

**这条退化是本层唯一一条被明写「接受」的行为退化，因此必须有断言面**（第二轮评审：第一轮在 §10 里对它零断言）。见 §10 测试 7b：断言 `RunHeartbeatStoppedError` 逃出时 (i) 不写终态、(ii) 不写 `execution-recovery.json` 的 `cleanupStatus`、(iii) 返回的 `state.status` 仍在 `RESUMABLE_STATUSES` 内。**测试的用途是把「接受」钉成一个具体形状，使将来无意中改变它时会红**，不是证明它是好的。

### 5.4 改动 B — 停机信号槽（**不写终态**）

**初稿在这里有一个会摧毁本层全部价值的缺陷**：它规定命中信号槽时 `persistTerminalState(runDir, state, "cancelled", "stop_requested")`。而：

```bash
grep -nF 'cancelled:' src/state/stateMachine.ts             # cancelled: []  —— 终态，无合法出边
grep -nF 'RESUMABLE_STATUSES' src/controller/resumeLoop.ts  # ["planning","executing","verifying"]
```

**后果**：操作者 Ctrl-C 一次 sweep，正在飞行的那个 run 被写成 `cancelled`，从此 `resume` 拒绝、`sweep` 拒绝、`runLoop` 被 `ensureFreshRunDir` 拒绝，代码里没有任何路径退出终态。**优雅停机会永久摧毁本层存在的理由。**

初稿照抄了 `leaseLoss` 的先例，但两者**不类比**：`leaseLoss` 下写终态是对的，因为**有新 owner 会接着跑**；`stop_requested` 下没有新 owner。

**采用的语义：**

- `StopRequestSignal = { requested: boolean }` + `createStopRequestSignal()`，形状照抄 `LeaseLossSignal`

  ```bash
  grep -nF -e 'export type LeaseLossSignal' -e 'export function createLeaseLossSignal' \
           -e 'if (leaseLoss.lost !== null)' src/controller/runLoop.ts
  ```
- `runLoopFromState` 在**已有的**相位边界检查点旁边多查一个；命中则 **`appendEvent(runDir, { type: "stop_requested", ... })` 并返回当前的非终态 `state`**，不启动下一个 attempt，**不调 `persistTerminalState`**

  **⚠️ 「那个检查点」是单数，而代码里是两处（第三轮评审，两个视角撞到）：**

  ```bash
  grep -cF 'leaseLoss.lost !== null' src/controller/runLoop.ts
  # 实测输出 2
  grep -nF 'leaseLoss.lost !== null' src/controller/runLoop.ts
  # 实测 exit 0，命中 2 行：:981（while(true) 顶端、attemptsUsed 递增之前）、
  # :1324（attempt 内部、execute 之后）
  ```

  **本层的选择：停机槽只装在 `:981` 那一处（循环顶端），不装 `:1324`。** 理由两条：

  1. **下面「不消耗配额」那条论证只对 `:981` 成立。** `:1324` 在 `const attempt = state.attemptsUsed + 1`（`:985`）之后，从那里返回会让这次 attempt 已经算进配额。装两处会让同一节的两条结论互相打架。
  2. **`:1324` 的粒度买不到东西。** 走到 `:1324` 意味着 execute 已经跑完（付费调用已经发生），此时停机与走完这个 attempt 再在 `:981` 停，对操作者是同一件事，却多一条要论证的返回路径。

  **代价（明写）**：停机的响应粒度是**一个完整 attempt**，不是「下一个相位边界」。合起来看，界由下面那条「adapter 协作式」的 ⚠️ 给出。**§10 测试 8 必须断言停机发生在 `:981` 那个位置**（表现为 `attemptsUsed` 不变），否则装错位置也会绿。
- `resumeLoop` 的 `finally` 里已有的 `heartbeat.stop()` **尝试**清掉 `leaseAffirmedAt`，所以下一次 sweep 的 `checkRunLease` 会放行，而 owner epoch 未变、门依然通过——**该 run 下一次 sweep 仍然 eligible**。§10 测试 8b 就是钉这一点的

  **⚠️ 「会清掉」是无条件断言，而实际是尽力而为（第二轮评审）**：`stop()` 里那句 `releaseOwnerLease` 被 `try { … } catch {}` 包着，而它走 `updateOwnerRecordWithPrecondition`，**CAS 不匹配就抛、随即被吞**。

  ```bash
  grep -nF -A6 'await releaseOwnerLease(options.runDir, expected);' src/controller/leaseHeartbeat.ts
  grep -nF -A8 'export async function releaseOwnerLease(' src/persistence/fileStore.ts
  # 实测：releaseOwnerLease → updateOwnerRecordWithPrecondition（CAS，失配抛 OwnerTransferPreconditionError）
  ```

  **诚实的表述（§15 验收 4 已按此改写）**：**租约释放成功后立即 eligible；释放失败（CAS 失配、锁忙、I/O）则最迟 `LEASE_TTL_MS` 之后 eligible。** 两种情形下 run 都不会被永久拒绝，这才是 §5.4 要保住的性质。**测试 8b 若只测顺利路径就不承重**，必须同时覆盖释放失败路径（见 §10 测试 8b）
- `resumeLoop` 追加**可选参数**（有默认值；现有调用点全部传 2 个实参，零改动）；它对 `runLoopFromState` 的调用需把信号作为**第七个位置参数**传下去
- **信号处理器装在 `cli.ts`，不装在 `sweepRuns.ts`**。`sweepRuns.ts` 保持纯函数、接收一个信号槽——既让 §3 第 1 条的「sweep 自身不新增 writer」成立，也让测试 13 可测

⚠️ **停机粒度的界是「adapter 协作式」，不是无条件有界**（评审更正）。检查点是 **per-attempt** 边界。而 execute 相位用 `{ awaitAbortedResult: true }`，超时后 `abort()` 再 `await operationPromise` **没有第二重上界**；adapter 的 `onAbort` 只发 `SIGTERM`，无 SIGKILL 升级。一个不响应 SIGTERM 的子进程会让 attempt 无限期挂住。`createAttemptWorkspace` / `cleanupAttemptWorkspace` 的 git 子进程也完全无超时。**诚实的界是**：`planTimeoutMs + verifyTimeoutMs + (execute：adapter 协作则有界，否则无界) + 无超时的 git`。

⚠️ **因此必须留逃生口**（否则装了处理器反而让 sweep 杀不掉，因为默认处置被移除了）：**第二次收到停机信号立即 `process.exit(130)`**。

**「第二次」的定义（第二轮评审要求定死；第一轮 §5.4 写「同一信号」、§7 写「SIGINT/SIGTERM」，两处不一致）：本层采用「跨信号种类合并计数」** —— 计数器是一个，SIGINT 与 SIGTERM 都对它 `+1`；第一次置槽，第二次（无论来自哪一个）立即 `process.exit(130)`。**理由**：操作者第二次按下去表达的是「现在就停」，不是「换一种信号试试」；按信号种类分别计数会让「先 Ctrl-C 再 `kill`」这个最常见的升级序列**永远走不到逃生口**。§7 的退出码表已按此改写。

本层不修 execute 的超时升级——那是行为变更，属独立任务，本层只记录。

⚠️ **停机不消耗任何配额，且不留任何被消费者读到的痕迹（第二轮评审，两条，本层正面表态）：**

1. **停机点落在已有的相位边界检查点旁，而那个位置在 `attemptsUsed` 递增之前。**

   ```bash
   grep -nE 'leaseLoss.lost !== null|const attempt = state.attemptsUsed + 1;|await writeRunState(runDir, state);' src/controller/runLoop.ts   # 需要正则：只看输出行，退出码不作为论据
   # 实测：while(true) 内顺序为 writeRunState(state) → affirmNow → leaseLoss 检查 → const attempt = state.attemptsUsed + 1
   ```

   所以一次 `stop_requested` 之后，`loop-state.json` 的 `status` 与 `attemptsUsed` 与停机前**逐字节相同**（那次 `writeRunState` 写的是同一个 `state`）。而 `attemptsUsed` / `maxAttempts` 是唯一的收敛边界，**因此重复停机不消耗任何配额**：一个被反复 Ctrl-C 的 run 可以被 sweep 无限次重新捡起。

   **本层正面接受这一点**，理由：把停机计入 attempt 配额，等于让「操作者按 Ctrl-C」消耗掉本该留给真实失败重试的预算——一次误按就永久减少了这个 run 的成功机会。**代价（无限次重捡）由 §12 的 `--max-runs` 在每一次 sweep 上界住**，不由 run 侧的配额界住。

2. **「人按过 Ctrl-C」这个信息只进 `events.jsonl`，而没有任何消费者读它。**

   ```bash
   grep -nF 'file:' src/registry/observeFields.ts
   # 实测 exit 0，**命中 4 行**（第四轮重跑并贴原始输出；第三轮三处都只写了解读「3 个观测文件」，
   # 没写命令的输出值 —— 按 §17 末尾升级后的规矩，那属于「写了解读、没写输出值」）：
   #   :7   file: "loop-state.json",
   #   :29  file: "owner-record.json",
   #   :45  file: "owner-transfer.json",
   #   :111 return { file: spec.file, fields };     ← 这一行不是观测文件，是返回构造
   # 结论不变：**观测文件是 3 个**，无 events.jsonl、无 reconciliation-record.json。
   ```

   `evaluateResumeEligibility` 也不读事件流。**所以下一次 sweep 分不清「人主动停的」和「被 OOM 杀的」。**

   **本层刻意放弃这个区分**，理由：**两者的正确处置恰好相同**——run 停在非终态、所有权未变、租约已释放或将过期，正确动作都是「下一次 sweep 重新续跑」。**引入这个区分需要新增一个被 registry 观测的字段，那是新的磁盘契约，属 L2/L5 的范围，不属本层。** 这里写明是为了不让它被沉默继承。

**两个改动互补**：B 提供正常路径上的停机，A 保证并发 `stop()` 只会得到拒绝而非静默无主写入。**债 3 在 exclusive span 内关闭；span 外那段按 §5.2 的范围声明具名传给 L5**（§13）。

## 6. Sweep 触发层

```
ccloop sweep --root <root> --adapter <scripted|claude> --adapter-config <path> --max-runs <N>
        │
        ├─ scanRuns(root, defaultScanDeps)
        ├─ scanRootFailureDetail(rows, root) !== undefined → stderr + exit 1（见 §7）
        ├─ 过滤 kind === "run" 且 owner-transfer.json 的 eligibleForContinuation
        │        观测为 { kind: "present", value: true }
        ├─ 按 path 字典序排序（确定性，测试依赖它）
        ├─ 打印启动横幅到 stderr（root + adapter + eligible 总数 + 配额 N）→ 此后才构造 adapter
        ├─ 顺序 for-await：resumeLoop(runDir, adapter, { stopRequested, onAdopted })
        │        onAdopted 触发（= 四道门全过、resume_adopted 已追加）即 consumed += 1
        │        consumed === N 时停止遍历。**不是「返回即计数」**，见下
        └─ 打印报告 → exit 0（扫描本身失败则 1）
```

**`--max-runs <N>` 是必需参数**（§12 的治理表态；第一轮修订只写在 §12，定义 CLI 形状的**五节**一次都没提它，本轮补齐：§6 调用式与本流水线、§7 退出码、§8 横幅与报告、§9 模块表、§10 测试 12b）。

**截断步放在排序之后**，不是过滤之后——否则「跑哪 N 个」不确定，测试 11 / 13 的确定性依赖就断了。

#### `--max-runs` 只对**实际进入 `runLoopFromState`** 的 run 计数

第二轮评审撞出：「必需 `--max-runs` + 排序确定 + 拒绝也计入配额」三者相加是**确定性饿死**——字典序排在前面的、永久被拒的 run 每一轮吃掉配额，后面真正可跑的 run **永远轮不到**。而被拒的 run 今天**没有任何收敛机制**：

```bash
grep -nF 'file:' src/registry/observeFields.ts
# 实测 exit 0，**命中 4 行**（第四轮重跑贴原始输出，见 §5.4 那处的逐行列表）：
#   :7 loop-state.json、:29 owner-record.json、:45 owner-transfer.json、:111 返回构造。
# 结论：registry 只观测那 3 个文件，**不观测 reconciliation-record.json** ——
# 所以「transfer eligible 但 reconciliation 不合格」的 run 每一次 sweep 都会被重新捡起
```

**本层的处置，两条：**

1. **配额在「门全部通过、`resume_adopted` 已追加」那一刻计入**（第三轮改判，见下面的「⚠️ 计入时点改判」），而不是在 `resumeLoop` 返回时计入。被四条拒绝路径挡住的 run **一次都不计**。**这同时也让 §12 的治理论证成立**——被拒的 run 一次付费调用都没发生。

   **⚠️ 但「`--max-runs` 界的是付费调用次数」这句话过头了（第四轮评审，Minor，就地更正）。** `--max-runs N` 界的是**进入 `runLoopFromState` 的 run 数**，而**每个 run 内部还有一个 `while (true)`**，可以一直跑到它自身的 attempt 上限：

   ```bash
   grep -nF 'while (true)' src/controller/runLoop.ts
   # 实测 exit 0，命中 1 行：:973
   grep -nF 'maxAttempts' src/controller/runLoop.ts
   # 实测 exit 0，命中 3 行：:287 / :360 / :1278，全部取自 contract.executionPolicy.maxAttempts
   ```

   **所以付费调用的上界是 `N × maxAttempts`，不是 `N`。** 准确表述：**`--max-runs` 界的是「本次 sweep 会启动多少个 run 的续跑」，每个 run 的付费调用由它自己的 `maxAttempts` 界住**——两条界叠乘才是 sweep 的付费上界。**§12 的「有界批准」仍然成立**（两条界都有限），**但横幅里的 N 不等于付费调用次数，操作者的「知情」范围要按这个乘积理解**。§12 已同步。

   **⚠️ 计入时点改判（第三轮评审，两个视角撞到；第二轮那条判据依赖一条假的绝对断言）**

   第二轮写的是「配额只计入 `resumeLoop` **正常返回**的次数……`resumeLoop` 只有在 `runLoopFromState` 跑完之后才正常返回，**抛出必然发生在它之前**」。**后半句为假**：`runLoopFromState` 的 `while (true)` 以两条**在任何 `try` 之外**的 `await` 开头。

   ```bash
   grep -nF 'while (true)' src/controller/runLoop.ts
   # 实测 exit 0，命中 1 行：:973
   grep -nF -e 'await writeRunState(runDir, state);' -e 'await heartbeat.affirmNow();' -e 'const attempt = state.attemptsUsed + 1;' src/controller/runLoop.ts
   # 实测 exit 0。循环顶端顺序为 :974 writeRunState → :977 affirmNow → :985 const attempt = ...
   # 而 attempt 内部第一个 try 在 :990（inner while 的 try）—— 即 :974 与 :977 **不在任何 try 内**。
   ```

   **于是这条时序是可达的**：前 k 轮 attempt 全部跑完（**k 次付费调用已经发生**）→ 第 k+1 轮顶端 `writeRunState` 撞上 ENOSPC（或 `affirmNow` 撞上 CAS 失配 / I/O 错误）→ 异常直接逃出 `runLoopFromState`、逃出 `resumeLoop` → sweep 按 §8 末行记 `error` → **按第二轮的判据，这个 run 的配额一次都不计**。**一次 sweep 因此可以在 `--max-runs 1` 下打出任意多次付费调用**，只要每个 run 都以这种方式收尾。§12 的整个「有界批准」论证被这一条掏空。

   **本层的判据改为**：`sweepRuns` 在 `resumeLoop` **成功穿过全部四道门**的那一刻把该 run 计入配额，此后无论 `runLoopFromState` 正常返回还是抛出，都**已经计过**。

   - **可观测的钉子**：那一刻正是 `resumeLoop` 追加 `resume_adopted` 事件的时刻（`src/controller/resumeLoop.ts`，`grep -cF 'appendEvent(' src/controller/resumeLoop.ts` 实测 6，其中 `:147` 那一处即 `resume_adopted`）。
   - **接缝**：`resumeLoop` 的可选参数对象里再加一个可选回调 `onAdopted?: () => void`，在 `resume_adopted` 追加之后、`runLoopFromState` 调用之前触发；`sweepRuns` 传它来自增计数器。**这与 §5.4 的信号槽用同一个参数对象，不新增位置参数**（§9 已同步）。
   - **为什么不用「数 `resume_adopted` 行数」代替回调**：那要读 `events.jsonl`，而 §3 第 1 条承诺 sweep 自身不读写 run 目录下的文件。回调把这件事留在进程内。
   - **不变的部分**：四条拒绝路径（`ResumeNotEligibleError` / `RunLeaseHeldError` / CAS 失败）在 `resume_adopted` 之前抛出，回调不触发，配额不计——§6 的「拒绝不消耗配额、因此不会确定性饿死」原样成立。
2. **排序与退避二选一，本层选「保留字典序、不做退避」。** 理由：选了第 1 条之后，饿死的机制已经消失（拒绝不消耗配额，遍历一定会走到可跑的 run）。退避需要在 run 目录里新增一个被读取的状态文件——那是新的磁盘契约，属 L2/L5。**代价必须记下**：一次 sweep 扫到 M 个永久被拒的 run，就会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件，**无退避、无上限、无标记**。这不影响付费界，但会让 `events.jsonl` 单调增长。**具名传给 L5**（§13）。

**参数语法用 `--root` 而不是位置参数。** `parseArgs` 对非 `ls` 命令走的是 `for (index = 1; index < argv.length; index += 2)` 的纯 flag/value 配对；`sweep <root> --adapter x` 会被配成 `root → "--adapter"`，**在一条完全合法的命令行上报 `missing required flags`**。改用 `--root` 让 sweep 直接复用既有配对循环，不必给它单开分支。

```bash
grep -nF -e 'for (let index = 1; index < argv.length; index += 2)' -e 'const root = rest.find' src/cli.ts
```

**排序是必须的**：`scanRuns` 全文无任何 sort，行序取决于 `readdir` 的文件系统顺序。测试 11 与 13 都依赖「谁先跑」。

**消费 L2 的数据契约，但在进程内调用 `scanRuns`**，不 fork `ccloop ls --json`。**代价要记下来**：sweep 因此耦合到 `ScanRow` 类型，而非 L2 §6.3 定义的版本化 JSON 形状；L2 §14.1 的字面要求是后者。

**对 L2 §13.1 的处置是「收窄」不是「讨清」**（初稿说过头了）：那条记录同时点名 `boundary-analysis.json` 与 `reconciliation-record.json` 可能缺失；本层只消除后者，前者按 §4.5 刻意保留为有损。

**并发 sweep 无需额外处理**：后到者被 `resumeLoop` 的租约门拒绝，记入报告，不是错误。

## 7. CLI 表面与退出码

| 退出码 | 条件 |
|---|---|
| `1` | sweep **未能开始或未能完成扫描**：参数解析失败（**含 `--max-runs` 缺失、非正整数、无法解析**）、`--adapter-config` 读取/解析失败、`scanRootFailureDetail(rows, root)` 返回非 `undefined`（root 不存在或不可读） |
| `0` | 其余一切，**包括**某个 run 跑成 `exhausted` / `failed` / 被门拒绝、以及扫描 issue 行 |
| `130` | 收到**第二次**停机信号（SIGINT 与 SIGTERM **合并计数**，见 §5.4）的强制退出 |
| `2` | **不使用。** sweep 分支必须在 `finalState.status === "succeeded" ? 0 : 2` 那**两处**映射之前返回 |

```bash
grep -rnF 'succeeded" ? 0 : 2' src/
# 实测 2 处：src/cli.ts:131（resume 分支）、src/cli.ts:135（run 分支）。
# 第一轮修订写「那个映射」是单数，实际是两处 —— sweep 分支必须在两处之前返回
```

**`scanRootFailureDetail` 是判据本身，不要重新发明**（第二轮评审）：§7 的「root 不存在或不可读 → exit 1」与 §8 的「扫描 issue 行 → 记录，不中断」在**根目录自身不可读**时重叠。`src/cli.ts` 的 `ls` 分支已经用这个符号区分了两者，sweep 分支照抄同一判据。

```bash
grep -nF 'scanRootFailureDetail' src/cli.ts
# 实测 2 行：:7 import、:118 在 ls 分支内的使用；定义在 src/registry/renderRuns.ts
grep -nF 'export function scanRootFailureDetail(' src/registry/renderRuns.ts
```

前三行都归 `1`，理由一致：都是「sweep 没能干成它的活」。逐 run 结局进输出，不进退出码——一个 run 合法地跑到 `exhausted`，是 sweep 成功地处理了一个失败的 run。

**不加 `--json`。** sweep 的报告今天没有消费者。

## 8. 错误处理汇总

| 情形 | 反应 | 去向 |
|---|---|---|
| 参数解析失败（含 `--max-runs` 缺失/非法）/ adapter-config 读取失败 | exit 1，不扫描 | stderr |
| 扫描本身失败（`scanRootFailureDetail` 非 `undefined`） | exit 1，不跑任何 run | stderr |
| 扫描 issue 行（`directory_unreadable` / `depth_truncated`） | 记录，不续跑，不中断，**不影响退出码** | stderr |
| `ResumeNotEligibleError` | **正常结果**，不是错误 | stdout |
| **`ResumeNotEligibleError` 且 message 以 `cannot read run artifacts:` 开头** | **不是正常结果**：outcome `error`，detail 带完整 message | **stderr** |
| `RunLeaseHeldError` | 正常结果（别人正在跑） | stdout |
| run 跑到任一终态 | 记录终态 + `stopReason` | stdout |
| run 因 `stop_requested` 或 `RunHeartbeatStoppedError` 返回非终态 | 记录为 `interrupted`，**明确标注该 run 仍可续跑** | stdout |
| 意料之外的抛错 | 记录**完整 message**，继续下一个 | **stderr** |
| **`reconciliation_write_abandoned`（§4.3 处置一的人裁；第五波人裁改为路由）** | **一条独立的备注行**，格式 `note  <path>  reconciliation_write_abandoned  <detail>`（**`detail` 折成单行**；**同一次 sweep 内各条 `note` 行之间按 run 的遍历顺序**——**跨 stdout/stderr 的「紧跟报告行」不再承诺，第六波降级，理由见 §4.3 第四步**）。**该 run 自己的 `outcome` 一个字节不变**（这条事件与终局正交），**退出码不变**，**汇总行不变** | **`events.jsonl` ＋ stderr** |

**⚠️ 上面这一行在第四轮写的是「不路由 —— sweep 看不见它」，第五波的人裁把它推翻了**（完整论证、被否决的上行方案、以及逐层通道见 §4.3 的「⚠️ 人已裁定（第五波，推翻第四轮）」）。要点三条：

- **它不落进 `outcome` 那一列的任何一格**——不是 `error`，也不新增取值。`outcome` 是该 run 的终局分类，一行一个值，而一个最终 `succeeded` 的 run 照样能产生这条事件；塞进 `error` 会用一条局部事件谎报整个 run 的结果。**落点是一条另起的备注行，不是那三列里的一格。**
- **它接不住在 `cannot read run artifacts:` 那一行上**，不要复用：那个前缀只在 `resumeLoop` 的**读侧** `Promise.all` catch 里产生（`src/controller/resumeLoop.ts:119`/`:120`，`grep -rnF 'cannot read run artifacts' src/ tests/` 实测输出 3 行，`src/` 内唯一产生点就是那两行），而本事件产生在 `fileStore` 的**写侧**，根本不经过那个 catch。
- **通道是进程内的可选回调，不是新的磁盘契约**（§4.3 的四层表）。sweep 因此仍然不读 run 目录下的任何文件，§3 第 1 条原样成立。**cron 的「有 stderr 即告警」现在会为这条事件响** —— 第四轮把「不会响」写成一条具名代价交接给 L5，那条代价已撤回（§13 第 4 笔）。

**读侧失败为什么单开一行**（第二轮评审 Critical；**判据在第三轮从 `cause` 改为 message 前缀，见 §4.4**）：§4.4 的整条立论是「不可解析的 marker / 缺失的 pending 是**响亮**的失败」。但该错误从 `readOwnerRecord` 逃出后被 `resumeLoop` 的 `Promise.all` catch 统一改写成 `ResumeNotEligibleError`，若让它落进上一行的「正常结果 → stdout → exit 0」，**「响亮」在实际调用图上就不成立**，cron 的「有 stderr 即告警」永远不响。**§4.4 的立论靠这一行兑现，不靠错误类型本身。**

**这一行覆盖的范围比第二轮宽，而这是有意的**：`cannot read run artifacts:` 前缀捕获 `resumeLoop` `Promise.all` 里**任何**读侧抛出——marker/pending 的具名拒绝、`JSON.parse` 的 `SyntaxError`、ENOENT、任意 I/O 错误。第二轮的 `cause` 判据只覆盖具名拒绝（**而那是 §4.4 判定为不可达的那一类**）。**宽一点是对的**：读不出 run 产物这件事本身就该进 stderr。

**报告格式（定死，因为没有 `--json`，人类可读形式就是全部契约）：**

- 每个尝试过的 run 一行，制表对齐三列 `path | outcome | detail`。
- `outcome` 取值域：`succeeded` / `failed` / `exhausted` / `blocked_waiting_human` / **`cancelled`** / `interrupted` / `refused` / `error`。

  **`cancelled` 是本轮补进取值域的**（第二轮评审：第一轮漏了它，而它是可达终态，实施者遇到只能瞎填）。

  ```bash
  grep -cF 'state, "cancelled"' src/controller/runLoop.ts   # 实测 4 —— 四个直接写终态的调用点
  grep -nF 'kind: "cancelled"' src/controller/runLoop.ts    # 实测 1 —— stopOn 命中经 decision.kind 走第五条路
  ```

  即 `cancelled` 今天有 **5 个**生产来源。`detail` 必须携带 `stopReason`。**它不归入 `failed`**：两者对操作者意味着不同的下一步（`failed` 是 run 自身失败，`cancelled` 是所有权/信号原因中止）。
- 末尾一行汇总：`<attempted> attempted, <succeeded> succeeded, <refused> refused, <errored> errored (quota <consumed>/<N>)`。
- 启动横幅格式：**`sweep: <eligible> eligible run(s) under <root>, will attempt at most <N>, adapter=<name>`**，**打印在扫描之后、adapter 构造之前**。

  **横幅必须同时显示 eligible 总数与配额 N**（第二轮评审）：§12 的整个论证是「操作者选 `--adapter claude` 即构成对该次 sweep 的**知情且有界**批准」，而知情的前提是横幅里有 N。第一轮的横幅里没有 N，论证悬空。

  **Amended 2026-08-05：上面这个横幅字面量里裸用的 "eligible" 会让 §12「知情批准」的知情半边落空，已按人的裁定改成带限定的措辞。** 这纠正的是*本文档*的缺陷，不是实现的缺陷。理由：sweep 的过滤器建在 **L2 观测**上——`owner-transfer.json` 的 `eligibleForContinuation` 观测为 literal true（`src/sweep/sweepRuns.ts` 的 `isObservedEligible`），而 `reconciliation-record.json` 根本不在 L2 的 `OBSERVED_FILES` 里，**所以它只覆盖 `evaluateResumeEligibility` 八条判据里的第 1 条**（守卫实测：`rtk proxy "bash -c 'cd <worktree> && grep -cF \"return { ok: false\" src/controller/resumeLoop.ts'"` → **8**）。于是一次「17 eligible」的横幅完全可以对应 17 个全部被门拒的 run：操作者据此批准 `--adapter claude`，批准的那一刻「知情」就是假的——**这与横幅里少写一个 N 是同一种失效，只是发生在另一个数字上**（本条与紧邻上一段是同一条论证的两半）。同仓库同为只读表面的 `ccloop ls` 在**同一个字段**上一直带着这句限定（`src/registry/renderRuns.ts` 的 `CONSISTENCY_NOTICE`：「eligibleForContinuation is an observed field, not a decision that the run may be resumed」），横幅照它的口气写，使两个只读表面对同一字段说同一句话。**读作**：横幅仍**必须**同时显示候选集大小与配额 N（这一条一个字不改），但那个计数**必须被命名为它所计的东西**；「保证 / 一定 / 能续跑」一类措辞不得出现（GATE-B 已钉死「非终态 ≠ 可被 resume 捡起」）。落地字面量逐字为：

  **`sweep: <eligible> run(s) under <root> observed eligibleForContinuation=true (an observed field, not a decision that the run may be resumed), will attempt at most <N>, adapter=<name>`**

  与之配套的计划勘误在 `docs/superpowers/plans/2026-08-02-sweep-and-transactional-continuation.md` 的 `### Task C3` 同一条（同样标 `Amended 2026-08-05`）。

**sweep 从不静默吞任何一种结果**（Rule 12）。意外错误按 §7 不改退出码，但写到 stderr 以便被 cron 的「有 stderr 即告警」捞住。

## 9. 模块边界

| 模块 | 职责 |
|---|---|
| `src/sweep/sweepRuns.ts` | 扫描 → `scanRootFailureDetail` 判据 → 过滤 → 排序 → **按 `--max-runs` 截断遍历（计数由 `onAdopted` 驱动，§6）** → 顺序续跑 → **按 `cannot read run artifacts:` 前缀把读侧失败路由到 `error`/stderr（§8）** → **为每个 run 传 `onReconciliationWriteAbandoned` 回调、把回调收到的记录按 `note` 行打到 stderr（§4.3 第五波人裁、§8）** → 汇报。**纯函数，接收信号槽与配额 N，自身无 writer、不装信号处理器。回调的实现定死为一次数组 push，不做 I/O、不得抛出** |
| `src/cli.ts` | `sweep` 分支、参数解析（**含 `--max-runs`**）、**可注入的信号处理器注册 `registerStopHandlers(signal, { exit = process.exit })`**、退出码映射 |
| `src/controller/resumeLoop.ts` | 追加**一个可选参数对象** `{ stopRequested?, onAdopted?, onReconciliationWriteAbandoned? }`（有默认值；现有 **14** 个调用点全部传 2 个实参，零改动），信号与 `onReconciliationWriteAbandoned` 一并向 `runLoopFromState` 透传，`onAdopted` 在 `resume_adopted` 追加之后触发。**`ResumeNotEligibleError` 的签名与 `Promise.all` 的 catch 一个字节不改**（§4.4 已否决 `cause` 方案） |
| `src/controller/runLoop.ts` | 信号槽检查点；`ReconciliationDraft` 的组装（**不含 `newOwnerEpoch`**）；`persistOwnerTransfer` 内用 `applyOwnerEpochTransfer` 的输出补齐 `newOwnerEpoch` 并透传；赢家路径 `writeBoundaryArtifacts` 改传 `undefined`；**新增 `RunHeartbeatStoppedError` 分支（不写终态，返回非终态 `state`）**；`runExclusive` 注释那一条的连带更新；**`onReconciliationWriteAbandoned` 的透传两层：`runLoopFromState` 搭 `stopRequested` 的同一个可选参数对象（不新增位置参数），`persistBoundaryAnalysis`（`:704`）加第五个可选参数——其两个调用点 `:1109` / `:1141` 都要改，`:1141` 今天只传 3 个实参，须写成 `(runDir, state, heartbeat, undefined, cb)`**（§4.3 第五波人裁） |
| `src/controller/leaseHeartbeat.ts` | `runExclusive` 拒绝 + 其上方注释 |
| `src/persistence/fileStore.ts` | 三文件事务、**marker 原子写（temp + rename）**、**三份 pending 原子写（temp + rename，§4.0.3a 人已裁定）**、marker 驱动 finalize、`cleanupOwnerTransferStagingWithoutMarker` 从 4 扩到 **10** 个 `safeUnlink`、finalize try 首与 catch 尾各从 2 扩到 3 个对称 unlink、**`readPersistedSuccessfulTransferArtifacts` 的裸 catch 收窄为「非 ENOENT-of-`owner-transfer.json` 一律 fail-closed」＋ ENOENT 归因（二选一：按 `error.path`，或把那次读移出 `Promise.all` 单独 try）**（§4.3 处置一）、**`writeBoundaryArtifacts` 在放弃 reconciliation 写时追加一条 `reconciliation_write_abandoned` 事件（同模块内调 `appendEvent`，`RunEvent.type` 是裸 `string`，不改任何类型定义；**那次 `appendEvent` 按 `leaseHeartbeat.ts:58`–`:63` 的 `appendLeaseEvent` 同形 `try{}catch{}` swallow ＋ 同口气注释**，第六波）**（§4.3 第四轮人裁）、**`writeBoundaryArtifacts` 加第三个可选参数 `options?: { onReconciliationWriteAbandoned?: (detail: string) => void }`，返回类型仍是 `Promise<void>`，回调在放弃那次写的同一个同步块内调用且*排在 `appendEvent` 之前*（`appendEvent` 是裸 `appendFile`、可以 reject）**（§4.3 第五波人裁） |
| `src/ownership/lease.ts` | `RunHeartbeatStoppedError`（**并列、不继承既有两个**，见 §5.3 的硬约束） |

**`isLeaseStopError` 的谓词与签名不改**（§5.3 选了方案 (a)）；只改 `runExclusive` 上方那条注释。

**`isLeaseStopError` 与 `registerStopHandlers` 的可见性，本轮定死（第二轮两处都没说，测试够不着）：**

```bash
grep -nF 'isLeaseStopError' src/controller/runLoop.ts
# 实测 exit 0，命中 3 行：:105 `function isLeaseStopError(` —— **无 export**、:1001、:1353
grep -rnF 'registerStopHandlers' src/ tests/
# 实测 exit 1（无输出）—— 它是本层新增的符号，今天不存在
```

- **`isLeaseStopError` 保持模块私有，不导出。** 理由：§10 测试 9 已改为不再依赖直接调用它（见那里），导出一个纯内部谓词只为测试可见性，违反 Rule 2。
- **`registerStopHandlers` 必须从 `src/cli.ts` 导出**，否则 §10 测试 13b 无法注入假 `exit`。它是本层新增的符号，导出它不触动任何既有 API。

**观测 `resumeLoop` 调用次数的缝（第二轮未定义，测试 10 / 11 / 12b / 13 全都要数）**：`sweepRuns` 的签名把 `resumeLoop` 作为**依赖注入的参数**接收（默认值是真实的 `resumeLoop`），测试传一个记录调用的替身。**这与 `scanRuns` 已有的 `defaultScanDeps` 形状一致**，不新发明模式。

`src/registry/` **零改动**。

⚠️ **签名改动的爆炸半径**：`writeOwnerTransferArtifacts` 若加**必需**参数，会打断 `tests/persistence/fileStore.test.ts` 的直接调用与 `tests/controller/leaseLifecycle.integration.test.ts` 的若干 `Parameters<typeof ...>` 包装。计划必须显式安排这批测试的更新，或把参数设为可选并说明。

**⚠️ 第五波新增的那条通道刻意不落进这个爆炸半径**：四层加的**全是可选参数**（`writeBoundaryArtifacts` 的第三参、`persistBoundaryAnalysis` 的第五参、`runLoopFromState` 与 `resumeLoop` 搭已有的可选参数对象），**没有一处新增必需参数、没有一处改返回类型**，因此既有调用点一个都不断。

```bash
grep -cF 'writeBoundaryArtifacts(runDir, {' tests/persistence/fileStore.test.ts
# 实测输出 11 —— 全是两参调用，加第三个可选参数一条都不需要改
grep -rnF 'writeBoundaryArtifacts(' src/
# 实测输出 2 行：src/controller/runLoop.ts:845 唯一生产调用点、src/persistence/fileStore.ts:302 定义
```

```bash
grep -cF 'writeOwnerTransferArtifacts(' tests/persistence/fileStore.test.ts   # 实测 17 —— 直接调用
grep -rnF 'writeOwnerTransferArtifacts' tests/                                # 实测 34 行，含 import 与包装
```

（**第二轮评审更正**：第一轮写「`fileStore.test.ts` 十余处直接调用」，旁边附的却是 `grep -rnF ... tests/ | wc -l`，实测 **34** —— **命令不重推它旁边的数字**。上面两条各自重推自己那个数，且按 §4.2 的纪律改用 `grep -c` 而非 `| wc -l`。）

## 10. 测试要求

**债 1**

1. **修复后行为**（初稿把它写成「证明修复前拒绝、修复后不再」，而一条提交的测试只跑一棵树，那不可表达）：驱动**生产**转移路径并注入 `assertHeld` 抛出，断言 `reconciliation-record.json` 已在盘上且 `resumeLoop` 放行。它变红的方式由测试 6 的变异提供。
2. **崩溃注入**：用本仓库既有手法（`vi.resetModules()` + `vi.doMock("node:fs/promises", …)`，见 `tests/persistence/fileStore.test.ts`）在 finalize 的每一个间隙中断，断言每个中间态都让 `resumeLoop` 拒绝、且 marker 仍在时恢复能推完。

   **⚠️ mock 面必须含 `unlink`**（第二轮评审）：finalize 九步里有 **5 个 `safeUnlink`**，`safeUnlink` 走的是 `node:fs/promises` 的 `unlink`。

   ```bash
   grep -nF -A8 'async function safeUnlink(' src/persistence/fileStore.ts
   grep -nF 'from "node:fs/promises"' src/persistence/fileStore.ts
   # 实测：safeUnlink → unlink；unlink / rename / writeFile 同自 node:fs/promises 导入
   ```

   只 mock `rename` / `writeFile`（第一轮的字面写法）**做不出步 7 之后的两个间隙**——正是测试 6c 需要的孤儿 pending 状态——测试 2 会悄悄退化成七个间隙。

   **⚠️ 区间必须写全**（第二轮评审）：`finalizePendingOwnerTransfer` 在 try **之前**还有 2 次（本层之后 **4** 次）`readFile` + `JSON.parse`，那些间隙**不在九步内**，而 §4.4 新增的拒绝逻辑正是落在那个位置。

   ```bash
   grep -nF -A4 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   # 实测 exit 0：:608 签名、:610 ownerPending 的 readFile+JSON.parse、
   # :611 transferPending 的 readFile+JSON.parse、:613 try —— 即改动前 try 之前是 2 次。
   ```

   **⚠️ 「本层之后是 3 次」少一格（第三轮评审，两个视角撞到）。正确是 4 次。** 第二轮只数了 pending：2 → 3。**但 §4.4 规则 1 把 marker 从「写下却从不读取」改判为*被解析*的承重字段**——finalize 必须先 `readFile` + `JSON.parse` marker 才知道 `version` 与 `finalizeOrder`，才知道要读哪几份 pending。今天 marker 只被 `pathExists` 看一眼：

   ```bash
   grep -nF -A20 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
   # 实测 exit 0：:630 签名、:633 `if (!(await pathExists(paths.transactionMarkerPath)))`
   # —— marker 今天只被 pathExists 判存在性，没有任何地方 readFile 它。
   ```

   **所以 try 之前是 4 次：marker 1 次 + 三份 pending 各 1 次。**

   **⚠️ 少这一格的后果不是「少测一个间隙」，是恰好漏掉唯一承重的那个间隙。** 按第二轮字面（3 次）写出来的测试**正好跳过 marker 解析那一格**——而**规则 3（marker 不可解析 → 拒绝 finalize）与测试 4c 唯一的落点就是那一格**。少一格 = 那条纵深防御分支零覆盖。

   **测试 2 的完整区间 = 「try 之前的 4 次 `readFile` + `JSON.parse`（marker 1 + pending 3）」＋「try 内的每一步」的每一个间隙。**

   try 内的步数：**改动前 9 步** = 2 个 temp 清理 + 2×(`writeJsonFile`, `rename`) + 3 个尾部 `safeUnlink`（marker、transferPending、ownerPending）＝ 2 + 4 + 3。
   **改动后 13 步** = 3 个 temp 清理 + 3×(`writeJsonFile`, `rename`) + 4 个尾部 `safeUnlink`（marker、三份 pending）＝ 3 + 6 + 4。

   **改动前 9 步这个数是从代码数出来的，重推命令与实测：**

   ```bash
   grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   # 实测 exit 0：try 在 :613，try 内 :614–:622 恰好 9 条 await 语句
   #   :614 safeUnlink(transferTemp)  :615 safeUnlink(ownerTemp)
   #   :616 writeJsonFile(transferTemp) :617 rename→transferPath
   #   :618 writeJsonFile(ownerTemp)    :619 rename→ownerPath
   #   :620 safeUnlink(marker) :621 safeUnlink(transferPending) :622 safeUnlink(ownerPending)
   # catch 在 :623，:624–:625 两个 safeUnlink，:626 rethrow
   ```

   **「改动后 13 步」经第三轮两个评审员各自独立重推，都同意是 13，不用改。** 但它是**按本 spec 的设计推出来的 v2 专属数字**，不是从已存在的代码数出来的——**改动前的代码里没有 13 这个数**。**实施者必须按最终落地的代码重数一遍并在计划里附命令**（同上那条 `grep -nF -A22`），**不要照抄 13**。

   **⚠️ fixture 必须有两组**（第二轮评审，为测试 6b 服务）：**(i) 首发转移**（`owner-transfer.json` 事前不存在）；**(ii) 双转移**（N→N+1 已成功落盘，N+1→N+2 崩在中途）。理由见测试 6b。

3. **恢复**：v2 marker + 三个 pending → `readOwnerRecord` 触发恢复 → 三文件就位。
4. **v2 marker 但 pending 缺失 → 拒绝 finalize、保留 marker 与 staging、抛具名错误**（这条取代初稿那条会把缺陷断言为正确的 v1 测试）。**该状态在生产中不可达**（§4.4），fixture 必须手工构造，测试注释要写明它钉的是纵深防御分支。
4b. **v1 marker + 两个 pending → 只发布两个，不抛。**
4c. **marker 不可解析 → 拒绝 finalize、保留一切、抛具名错误。** 同样是手工构造的纵深防御分支（marker 原子写之后不可达，§4.0.3）。
4d. **marker 原子写（§4.0.3 的承重断言）**：mock `rename` 在 marker 的那次 rename 上抛出，断言磁盘上**没有** `.owner-transfer.transaction.json`、只有 `.owner-transfer.transaction.tmp`；随后一次持锁入口把 tmp 回收干净。**变异：marker 退回 `writeJsonFile` 直写 → 本测试必须红。**
4e. **三份 pending 原子写（§4.0.3a 的承重断言，第三轮新增，与 4d 逐字同形）**：对**每一份** pending 各一条子用例——mock `rename` 在该 pending 的那次 rename 上抛出，断言磁盘上**没有**对应的 `.…pending.json`、只有对应的 `.…pending.tmp`；随后一次持锁入口把 tmp 回收干净。**变异：把该 pending 退回 `writeJsonFile` 直写 → 对应子用例必须红。**

   **三条子用例缺一不可**：`.owner-record.pending.json` 与 `.owner-transfer.pending.json` 是**先于本层就存在**的两份，本层是把它们从裸写改成原子写（§4.4 的改判）；只测新增的第三份，就等于对本层实际动过的那两份零覆盖。

   **⚠️ 这条测试与 4c 的关系必须写明**：4c（marker 不可解析）与「pending 不可解析」在原子写之后**都是纵深防御**，fixture 手工构造；4d/4e 钉的是**「原子写这件事本身还在」**。两者不可互相替代——4c/4d 分工与 4e/「pending 不可解析」分工完全平行。
5. **`finalizeOrder` 承重 —— 必须手工 stage 一个被置换过的 v2 marker**（第二轮评审，Critical）。

   第一轮写的是「断言实际发布顺序等于 marker 声明的顺序」。**那是同义反复**：生产代码用同一组常量既生成 marker 又（在最自然的变异下）决定顺序，两者恒等；把 finalize 退回今天的硬编码形状，只要硬编码顺序与常量一致，测试依然绿。**而这是 §4.4 整个方案的支点**（§4.1 把「`finalizeOrder` 被写下却从未被读取」列为必须先说清的两个事实之一）。

   ```bash
   grep -nF -B2 -A6 'const marker: OwnerTransferTransactionMarker = {' src/persistence/fileStore.ts
   # 实测：finalizeOrder 由 [OWNER_TRANSFER_FILE, OWNER_RECORD_FILE] 两个常量拼出
   grep -nF -A16 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
   # 实测：finalize 按硬编码顺序办事，从不读 marker
   ```

   **正确形状**：手工 stage 一个 `finalizeOrder` 与生产默认**不同**的 v2 marker，例如
   `["owner-record.json", "owner-transfer.json", "reconciliation-record.json"]`，
   加上与之匹配的三份 pending，然后断言 `rename` 的实际调用序列**逐项等于 marker 里写的顺序**。
   **这样「忽略 `marker.finalizeOrder`、按 version 硬编码」的实现必红。**
   （**注意 marker 只在全部 rename 之后才被 unlink**，所以 `rename` 的 mock 可在首次调用时读到它。）
6. **反方向变异**：reconciliation 退回事务外 → 测试 1 必须红；`finalizeOrder` 退回 `[reconciliation, transfer, owner]` → 测试 6e 必须红。**两侧各自单独变异都要红。**
6a. **暂存顺序不变式的承重测试（第二轮评审新增）**：§4.3 把「reconciliation pending 严格先于 marker」列为不变式，而第一轮**没有任何测试能证伪它**——第一轮测试 6 的后半句说「暂存顺序改成 marker 先于 reconciliation pending → 测试 4 必须红」，但**测试 4 是手工构造磁盘状态的测试，根本不执行 `writeOwnerTransferArtifacts`，换了暂存顺序它照样绿。**

   **正确形状**：mock 记录 `writeOwnerTransferArtifacts` 的写入序（按路径），驱动一次真实转移，断言 `.reconciliation-record.pending.json` 的 **rename** 严格早于 marker 的 rename。**⚠️ 第三轮按 §4.0.3a 更正：pending 也原子化之后，「pending 出现」的时刻是它那次 rename，不再是 `writeJsonFile` 那一刻**——断言若还盯着 `writeFile`，会在「三份 pending 的 temp 先写、marker 先 rename、pending 后 rename」这种实现下**错误地变绿**。**变异：把 marker 的暂存提到三份 pending 之前 → 本测试必须红。** 测试 6 的后半句已改指本条。
6b. **钉住真正承重的东西**：变异掉 `evaluateResumeEligibility` 的任一条 epoch 相等判定 → 测试 2 必须红。（§4.3 已论证承重的是这两条，不是排序。）

   **⚠️ 两条判据的杀伤 fixture 不同（第二轮评审，第一轮写「任一条」而没写 fixture 要求，判据 A 的变异会存活）：**

   - **判据 B**（`ownerRecord.currentOwnerEpoch === ownerTransfer.newOwnerEpoch`）：~~**任何**单转移场景都能杀。~~ **⚠️ 第四轮更正：这句话只对「整条删掉」这个变异成立。** 对 §15 验收 5 表里那个 `!==` → `<` 的变异，**单转移与双转移两组 fixture 都杀不掉**（首发转移是 `N < N+1`，变异体照样拒绝；双转移是 `N+2 === N+2`，该判据本来就不拒绝）。杀它需要**第三组 fixture**：`currentOwnerEpoch > ownerTransfer.newOwnerEpoch`，且其余七条判据都不抢先挡住。**完整 fixture 约束见 §15 验收 5 的「第 6 条」。**
   - **判据 A**（`reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`）：**只有双转移 fixture 杀得掉**。单转移时，reconciliation 已发布而 transfer 未发布的那些间隙里 `owner-transfer.json` 尚不存在，`readOwnerTransferRecord` 直接抛、`resumeLoop` 在进门前就拒绝，**判据 A 根本没被求值，变异存活**。双转移下（N→N+1 已成功、N+1→N+2 崩在 transfer 发布之后），盘上是「reconciliation.newOwnerEpoch = N+1、ownerTransfer.newOwnerEpoch = N+2、ownerRecord.currentOwnerEpoch = N+2」，判据 B 通过、**只有判据 A 拒绝**——这才是唯一杀得掉它的形状。

   **所以测试 2 必须显式提供上面那两组 fixture，测试 6b 的变异要分别对两组各跑一次。**
6c. **孤儿回收**：中断在 finalize 成功尾部（marker 已删、pending 未删），随后走一次 **`claimOwnerRecordWithPrecondition`**，断言 **10 个** staging 路径全部被回收、无残留（**第三轮按 §4.0.3a 的 pending 原子化从 7 重数**）：

   - 三个 pending：`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.reconciliation-record.pending.json`
   - 三个发布 temp：`.owner-record.publish.tmp` / `.owner-transfer.publish.tmp` / `.reconciliation-record.publish.tmp`
   - 一个 marker temp：`.owner-transfer.transaction.tmp`
   - 三个 pending temp：`.owner-record.pending.tmp` / `.owner-transfer.pending.tmp` / `.reconciliation-record.pending.tmp`

   **fixture 必须把这 10 个全部放上去**，断言逐个不存在。

   **⚠️ 第一轮写的是「三个 pending 与*两个* temp」、第二轮改成 7——两次都会在没被列全的那些 temp 泄漏时*变绿***，等于把泄漏断言为正确，与 §13 那条「不加对称 `safeUnlink` 就会永久泄漏」的窄例外直接对撞。**这条测试的杀伤力等于它列全的路径数，所以数字必须与 §4.3 表、§13 的 `cleanupOwnerTransferStagingWithoutMarker` 那一行三处联动。**

   **⚠️ 驱动入口不能换成 `readOwnerRecord`**：`cleanupOwnerTransferStagingWithoutMarker` 只在 `options.lockHeld` 为真时被调用，而 `readOwnerRecord` 不传 `options`（见 §4.3 的可达条件与那条 grep）。用 `readOwnerRecord` 驱动，测试会因为「什么都没回收」而红，或更糟——被人改成断言「不回收」。
6d. **赢家不二次写**：断言赢家路径上 `writeBoundaryArtifacts` 之后 `reconciliation-record.json` 的 inode/mtime 未变。

   **⚠️ 本条在第三轮被实施者担心「不成立」，第四轮三个评审员独立同结论：它成立。就地写下结论，否则下一位读者要重推一遍。**

   依据：§4.3 已裁定赢家路径**不传** `reconciliationRecord`，而 `writeBoundaryArtifacts` 里 `:311` 那句 `if (artifacts.reconciliationRecord !== undefined)` 会把 `:312`–`:320` **整块跳过**，`:317` 那次 `writeJsonFileAtomically` 根本不执行 → **inode 必然不变**。变异回 §4.3 否决过的方案 (b)（赢家继续补写 reconciliation）则走 `:317` → `writeJsonFileAtomically` 的 `rename`（`:424`）→ **inode 必变 → 可红**。

   ```bash
   grep -nF -A22 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts
   # 实测 exit 0：:309 boundary-analysis 那次写、:311 条件、:317 reconciliation 那次写
   grep -nF -A16 'async function writeJsonFileAtomically(' src/persistence/fileStore.ts
   # 实测 exit 0：:418 签名、:423 writeFile(tempPath)、:424 rename(tempPath, path) —— rename 换 inode
   ```

   **唯一缺陷是第三轮没写基线快照点（第四轮补，Minor）**：**基线 `stat` 必须紧贴 `writeBoundaryArtifacts` 调用*前*取、断言的 `stat` 紧贴调用*后*取。** 若实施者把快照取在 `persistBoundaryAnalysis` **之前**，那期间还夹着事务本身对 `reconciliation-record.json` 的那次发布 rename（§4.3 的 `finalizeOrder` 第三项），**本测试会无条件红**——而红的原因与它要钉的东西无关。**这一句必须进测试注释。**
6e. **输家不得覆盖赢家（第二轮评审新增，钉 §4.3 的排序改判）**：构造 P1 的事务中断在「transfer + owner 已发布、reconciliation pending 与 marker 仍在」；在该磁盘状态上驱动一次**输家**的 `writeBoundaryArtifacts`（`reconciliationRecord.eligibleForContinuation === false`、`newOwnerEpoch === null`）；断言盘上的 `reconciliation-record.json` **不是**降级版本（`preserveSuccessfulReconciliationIfNeeded` 的保护判定成立）；随后让恢复推完，断言 `resumeLoop` 放行。

   **fixture 必须让 `.owner-transfer.lock` 在窗口内存在且由一个活着的 pid 持有**（§4.3 排序改判第 2 步：P2 的 `readOwnerRecord` 靠这一点才不会替 P1 finalize）。

   #### ⚠️ 第二轮给的两条「必须红」的变异，第三轮实测**都不会红**（两个视角独立走完同一条链，结论一致）

   **这是本层最承重的一处改判，而它目前零有效护栏。** 先把两条链走完，再给替代形状。

   **第二轮变异二（删掉 fixture 里的锁文件）逐步复核 —— 它会走成「保护反而生效」：**

   ```bash
   grep -nF -A20 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
   # 实测 exit 0：:640 是
   #   if (!options?.lockHeld && await pathExists(paths.lockPath) && !(await tryRecoverStale...)) return;
   ```

   1. 锁文件被删 → `pathExists(paths.lockPath)` 为 **false** → 整个合取为 false → **不 return**。
   2. → `finalizePendingOwnerTransfer(runDir)`：**输家替赢家把三文件 finalize 了**。
   3. → `readOwnerRecord` 返回**已发布的新 owner record**，`readOwnerTransferRecordRaw` 返回**已发布的 transfer**。
   4. → `transferRepresentsPublishedWinner` 的三条判定**全部成立** → 保护**生效** → 输家的降级被挡。
   5. → spec 规定的两条断言（「不是降级版本」「随后 `resumeLoop` 放行」）**全部通过**。**绿。**

   **第二轮变异一（改 `finalizeOrder` 并「同步改中断点」）：那不是变异，是另写一条测试。** 「同步改中断点」＝改 fixture，而 §10 通用条要求「变异注入点必须在**生产代码 / 生产类型**上」。若只改 `finalizeOrder` 而**不**动 fixture，fixture 里锁仍在、pid 仍活 → 第 1 步 `pathExists(lockPath)` 为 true 且 `tryRecoverStaleOwnerTransferLock` 返回 false → 恢复 return → 输家读到已发布的 transfer + owner → 保护生效 → **也绿**。

   **两条都绿 ⇒ 排序改判目前没有任何测试钉着它。**

   #### 替代形状：两条变异都只动生产代码，fixture 一个字节不改

   **测试 6e 的骨架改为「确定性交错」**：用既有手法（`vi.resetModules()` + `vi.doMock("node:fs/promises", …)`）包住 `rename`，在 **P1 的第一次 `rename` 内部**同步地把输家那次 `writeBoundaryArtifacts` 跑完，再放行 P1 剩下的 rename。**两侧都跑生产代码**，交错点由 mock 决定而不是由 fixture 决定。

   - **变异一（替换）**：只把生产常量 `finalizeOrder` 改成 `[reconciliation, transfer, owner]`，**fixture 与交错点都不动**。
     - 未变异（`[transfer, owner, reconciliation]`）：P1 第一次 rename 发布的是 `owner-transfer.json`。输家此刻读到 transfer 已在、但 `owner-record.json` 仍是旧 epoch → `transferRepresentsPublishedWinner` 的 epoch 判定不成立 → 输家写下降级版本。**收尾断言见下面「⚠️ 第三轮给的收尾断言是错的」。**
     - 变异后（`[reconciliation, transfer, owner]`）：P1 第一次 rename 发布的是 `reconciliation-record.json`。输家此刻 `readOwnerTransferRecordRaw` **ENOENT** → 裸 `catch { return null }` → 保护退化为无保护直写 → **输家的降级盖掉 P1 刚发布的真品**；P1 随后发布 transfer + owner、删 marker → 终态是「transfer eligible + reconciliation 降级 + marker 已删」→ `resumeLoop` **永久**拒绝 → **断言红。** ✅

   #### ⚠️ 第三轮为变异一写的收尾断言把一条**损坏轨迹**断言成了「终态正确」（第四轮评审，Critical）

   第三轮的未变异分支收在「输家写下降级版本 → **随后 P1 的第三次 rename 用真品盖回去** → 终态正确，断言绿」。

   **「盖回去」不是系统性质，是 harness 强加的顺序。** 骨架规定「在 P1 的第一次 `rename` 内部同步地把输家那次 `writeBoundaryArtifacts` 跑完」，所以输家的写必然早于 rename#3。**生产里没有任何机制保证这一点**——§4.3 刚刚论证的那条残余 TOCTOU（U0–U3）就是排在之后的那一半：输家的写完全可以晚于 rename#3。

   **于是这条断言把「输家已在盘上写下降级版本」这条磁盘轨迹断言为正确行为**，而 §4.4 判初稿死刑的理由与它**逐字同形**：

   > 而初稿的**测试 4 恰好把这个磁盘状态断言为正确行为**，等于把缺陷的形状写进套件。

   它还违反 §10 测试 6e 自己刚立的纪律（「把一条关于*过程*的论证用*终态*去钉，就是本轮那两条变异全绿的根因」）——**同一条测试里立了纪律又在隔壁破了它。**

   **本层的处置：变异一的两侧都改用过程断言，不看终态。**

   - **断言对象**：在输家那次 `writeBoundaryArtifacts` 返回的**那一刻**（不是 P1 跑完之后）读 `reconciliation-record.json`。
   - **未变异期望**：该文件**此刻尚不存在**（新排序下 P1 的 rename#3 还没发生，而输家写的是……）——**⚠️ 这里必须诚实**：输家**确实**会在此刻写下一份降级版本。所以未变异的正确期望是「盘上此刻是**输家的降级版本**」，而这**正是残余 TOCTOU 的形状**。**因此变异一不能用「reconciliation 的内容」作断言对象。**
   - **改用的断言对象（两侧真正不同的那一件事）**：**在输家的 `preserveSuccessfulReconciliationIfNeeded` 返回时，`transferRepresentsPublishedWinner` 是否被求值过。** 未变异：`owner-transfer.json` 已存在 → 三读全部成功 → 判定被求值（结果为 false，因为 owner-record 还是旧 epoch）。变异后：`owner-transfer.json` 尚不存在 → 裸 catch → **判定压根没被求值**。
   - **可观测的钉子**：spy `node:fs/promises` 的 `readFile`／`open`，断言输家那次调用期间**发生过一次针对 `owner-transfer.json` 的成功读**。变异后那次读以 ENOENT 结束 → 断言红。✅
   - **⚠️ 这条断言比第三轮那条弱**：它钉的是「保护判定有没有被求值」，不是「赢家有没有被覆盖」。**后者本层钉不住，因为残余 TOCTOU 未关闭**（§4.3、§13 第 4 笔）。**明写这一点，不要让下一位读者以为变异一覆盖了赢家不被覆盖。**

   - **变异二 —— 第三轮选的那条注入点是*结构性等价变异*，已实测证明（第四轮评审，Critical）**

     第三轮选的是「删掉 `recoverInterruptedOwnerTransfer` `:640` 那个合取项 `await pathExists(paths.lockPath)`」。**它在任何 fixture 下都不改变行为**，因为 `tryRecoverStaleOwnerTransferLock` 自己就把「锁不存在」这一格接住了：

     ```bash
     grep -nF -A22 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts
     # 实测 exit 0：:520 签名、:525 readFile(lockPath)、
     #   :526-:529 catch → code === "ENOENT" → **return true**
     #   :534-:540 JSON.parse 成功且 pid 活 → **return false**
     #   :541-:550 parse 抛 → hasStagedArtifacts 为假 → return false
     #   :552-:553 safeUnlink(lockPath); return true
     grep -nF -A16 'async function recoverInterruptedOwnerTransfer(' src/persistence/fileStore.ts
     # 实测 exit 0：:630 签名、:633 pathExists(marker)、
     #   :640 `if (!options?.lockHeld && await pathExists(paths.lockPath)
     #         && !(await tryRecoverStaleOwnerTransferLock(runDir))) return;`
     ```

     **逐格对照（四种锁状态，基线 vs 删掉那个合取项）：**

     | 锁状态 | 基线：`pathExists && !tryRecover` | 变异：`!tryRecover` | 是否进 finalize（两侧） |
     |---|---|---|---|
     | 不存在 | `false && …` → 整体 false | `tryRecover` 走 `:527` ENOENT → `true` → `!true` = false | **两侧都进** |
     | 存在、pid 活 | `true && !false` = true → return | `!false` = true → return | **两侧都不进** |
     | 存在、pid 死 | `true && !true` = false | `!true` = false | **两侧都进** |
     | 存在、内容坏且有 staging | `true && !true` = false | `!true` = false | **两侧都进** |

     **四格逐个相同 ⇒ 那个 `pathExists` 是纯短路优化，删掉它不改变任何可观测行为。** 这不是「fixture 选得不好」，是**结构性等价**——换任何 fixture 都杀不掉。

     **本层改用的注入点（回代码复核过，不是照抄评审员的话）：删掉 `tryRecoverStaleOwnerTransferLock` `:538`–`:540` 的**

     ```ts
     if (pid !== null && isProcessActive(pid)) { return false; }
     ```

     **为什么这一条会红（逐格走，与上表同法）：**

     | 锁状态 | 基线 | 变异后 |
     |---|---|---|
     | 存在、pid **活**（＝测试 6e 的 fixture） | `tryRecover` 在 `:539` return **false** → `:640` 的 `!false` = true → **恢复 return，输家不 finalize** | 早退没了 → 落到 `:552` `safeUnlink(lockPath)` → return **true** → `!true` = false → **恢复进 `finalizePendingOwnerTransfer`，输家替赢家 finalize** |
     | 其余三格 | 见上表 | 与基线相同 |

     **只有 fixture 那一格翻转，且翻转方向正是 §4.3 排序改判第 2 步依赖的那件事**（「锁被活进程持有 → P2 的恢复直接 return，不会替 P1 finalize」）。**fixture 一个字节不改**，注入点在生产代码上，满足 §10 通用条。✅

     **⚠️ 它模拟的不是「锁的持有范围被收窄」，而是「活进程检查被移除」。** 两者都会打断第 2 步那条论证，但形状不同——**不要把这条变异的名字写成「锁的持有范围被收窄」，第三轮就是这么写的**，而那个名字对应的注入点恰好是等价变异。

     ##### ⚠️ 这条变异**今天就已经杀掉 6 条既有测试** —— 于是「套件红」不能作为 6e 的达标判据（第六波，实测）

     **第六波把上面这个注入点真的注进去跑了一遍**（在 scratchpad 的仓库副本上做，工作树未动）。**未过滤的原始结果**：

     ```
     基线（未注入）:  Test Files  29 passed (29)      Tests  446 passed (446)      exit 0
     注入后:          Test Files  4 failed | 25 passed (29)   Tests  6 failed | 440 passed (446)   exit 1
     ```

     **被杀掉的 6 条（逐条抄自那次运行的原始输出）：**

     | # | 测试全名 | 文件 |
     |---|---|---|
     | 1 | `fileStore > rejects owner transfer while a live transfer lock is held` | `tests/persistence/fileStore.test.ts` |
     | 2 | `fileStore > throws OwnerTransferLockBusyError for a busy lock and OwnerTransferPreconditionError for a CAS mismatch, and neither is an instance of the other` | `tests/persistence/fileStore.test.ts` |
     | 3 | `fileStore > keeps a live lock in place when recovery cannot yet proceed` | `tests/persistence/fileStore.test.ts` |
     | 4 | `startLeaseHeartbeat > treats a busy owner-transfer lock as transient: no lease_lost, no supersession concluded, retried next tick` | `tests/controller/leaseHeartbeat.test.ts` |
     | 5 | `resumeLoop > stays fail-closed when the claim hits a busy owner-transfer lock, without claiming a CAS failure` | `tests/controller/resumeLoop.integration.test.ts` |
     | 6 | `lease heartbeat lifecycle > appends owner_transfer_contended and abandons the transfer when the owner-transfer lock stays busy` | `tests/controller/leaseLifecycle.integration.test.ts` |

     **第 3 条就是 §4.3 排序改判第 2 步要钉的那句话**（「锁被活进程持有 → 恢复不推进」），**而它今天就在套件里、与 6e 无关。** 后果：一个实施者可以写一条断言写空了的测试 6e、注入这条变异、看见套件红、贴出这份原始输出，宣布验收 1a 达标 —— **而 6e 本身一条断言都没承重过。**

     **所以 6e 两条变异的达标判据一律改为具名单跑**（不是「套件红」）：

     ```bash
     # 注入变异之后，只跑 6e 那一条，按测试全名过滤
     ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run -t '<测试 6e 的完整测试名>'
     # 判据：这一条自己必须红。套件里另外那 6 条同时红，与本条达标无关，不得替代。
     ```

     **⚠️ 这份名单不是「本条变异的护栏」，是它的*噪声*。** 写进 spec 只为一件事：让下一位读者知道套件红是被这 6 条既有测试制造出来的，**不要把它误读为 6e 的证据**。

     **⚠️ 名单是 6 条不是 7 条 —— 一条被误记的第七条已剔除（第六波，实测更正）。** 第五轮定向评审给的名单里还有 `parseArgs > returns 0 for the scripted example run`。**它不是被这条变异杀掉的**：该测试的 fixture 走 `examples/v1/minimal-contract.json`（`repoPath: "."`、`worktreeRequired: true`），在**不是 git 仓库**的目录里跑必然失败。第六波在 scratchpad 副本里补了一次 `git init` + 首次提交之后，**基线与注入后它都是 `✓`**（原始输出：注入后那次运行的 `✓ parseArgs > returns 0 for the scripted example run 420ms`）。**这正是「变异实验必须在一个基线全绿的副本上做」的理由**——基线不绿时，环境失败会被整个记进击杀名单。

   - **窗口内断言的具体形状（第三轮那条「rename 被调用 0 次」两侧数字都错，第四轮就地更正）**

     **第三轮写的是「未变异：输家期间零 rename；变异后：3 次」。两侧都错。** `writeBoundaryArtifacts` **自己**就会 rename：

     ```bash
     grep -nF -A22 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts
     # 实测 exit 0：:302 签名、:309 writeJsonFileAtomically(boundary-analysis.json)、
     #   :311 if (artifacts.reconciliationRecord !== undefined)、
     #   :312 preserveSuccessfulReconciliationIfNeeded、
     #   :317 writeJsonFileAtomically(reconciliation-record.json)
     grep -nF -A16 'async function writeJsonFileAtomically(' src/persistence/fileStore.ts
     # 实测 exit 0：:418 签名、:420 buildAtomicTempPath、:423 writeFile(tempPath)、:424 rename(tempPath, path)
     ```

     **所以未变异时输家期间至少 2 次 rename**（`:309` 一次 ＋ `:317` 一次），不是 0；变异后再加上 finalize 的 2 次（本层落地后 3 次），也不是 3。

     **改用的断言（与计数无关，因此不会因为实现细节漂移而误红）：断言输家那次 `writeBoundaryArtifacts` 期间，*没有任何 rename 以事务的发布 temp 为源*。** 三个事务发布 temp 的名字是固定常量，而输家自己的原子写用的是**带进程戳与序号的一次性 temp**，两者不可能撞名：

     ```bash
     grep -nF -A8 'export function buildAtomicTempPath(' src/persistence/fileStore.ts
     # 实测 exit 0：:403 签名、:407 `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${seq}.tmp`
     #   —— 与 .owner-transfer.publish.tmp / .owner-record.publish.tmp /
     #      .reconciliation-record.publish.tmp 这三个固定名字完全不重叠
     ```

     - **未变异**：0 次以事务发布 temp 为源的 rename（输家的 2 次 rename 源都是一次性 temp）→ 绿。
     - **变异后**：finalize 跑起来 → 3 次以事务发布 temp 为源的 rename → **断言红。** ✅

     **等价的、更直白的替代**：spy `finalizePendingOwnerTransfer` 进入与否。**但它未导出**（`grep -nF 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts` 实测 `:608`，**无 `export`**），所以只能经 rename 源间接观测。**两条选一即可，写清选了哪条。**

   **为什么必须是「窗口内断言」而不是「终态断言」**：§4.3 论证的第 2 步说的是「**在该窗口内**输家不会替赢家 finalize」。终态断言看不见这件事——输家替赢家 finalize 之后终态照样正确（上面那条链的第 4/5 步）。**把一条关于*过程*的论证用*终态*去钉，就是第三轮那两条变异全绿的根因**——而第四轮发现第三轮**自己在变异一的收尾上又破了一次同样的纪律**。

   #### ⚠️ 合并 C2/C3/C4 之后必须正面写下的账

   **§4.3 那个最承重的改判，到本轮为止连续三轮零有效护栏：**

   | 轮次 | 为它写的变异 | 实测结果 |
   |---|---|---|
   | 第二轮 | 两条（改 `finalizeOrder` 并同步改中断点；删 fixture 里的锁文件） | **都不红**（G2 抓到：前者是改 fixture 不是变异，后者会走成「保护反而生效」） |
   | 第三轮 | 两条（改 `finalizeOrder` 常量；删 `:640` 的 `pathExists` 合取项） | 前者的**收尾断言**把一条损坏轨迹断言为正确（C2）；后者是**结构性等价变异**（C4，四格实测逐格相同）；两者共用的「rename 0 次」窗口断言**两侧数字都错**（C3） |
   | 第四轮（本轮） | 变异一改注入形状＋改断言对象；变异二换注入点为 `:538`–`:540` 的活进程检查；窗口断言改为「以事务发布 temp 为源的 rename 计数」 | **见下面「为什么这次会红」** |

   **本轮必须自己论证「为什么这次会红」，而不是宣布它会红：**

   1. **变异二**：上面那张四格对照表是**逐格走过的**，`lock=live` 那一格由 `false` 翻成 `true`，而 fixture 就钉在那一格。**翻转的是控制流的走向，不是某个数值**，所以断言只要能区分「finalize 跑没跑」就必红——而「以事务发布 temp 为源的 rename 计数」正是这个区分（0 → 3）。
   2. **变异一**：翻转的是「`owner-transfer.json` 在输家读的那一刻存不存在」，断言钉的是「针对该路径的读有没有以 ENOENT 结束」。**这两件事是同一件事的两面**，不经过任何终态。
   3. **两条都不依赖 harness 强加的顺序**：断言全部落在输家那次 `writeBoundaryArtifacts` 的调用窗口内，P1 后续的 rename 发不发生都不影响判定。**这正是第三轮 C2 那条收尾断言违反的东西。**

   **⚠️ 但本轮不宣布「护栏问题已解决」。** 前三轮每一轮都在这里宣布过一次，每一轮都被下一轮推翻。**实施者必须在计划阶段真的把这两条变异注入、跑一次、贴原始输出**——本 spec 只给出注入点与断言形状，**不给「已验证会红」的结论**。
6f. **读侧收窄的双向承重（第四轮新增，§15 验收 1b 在第三轮是孤儿验收，本条补上落点）**

   **为什么必须补**：验收 1b 在第三轮被写进 §15，而 §9 模块表同时把「裸 catch 收窄为非-ENOENT fail-closed」列为要落地的**生产改动**，**§10 区间内却一次都没提到 `readPersistedSuccessfulTransferArtifacts`**：

   ```bash
   F=docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
   grep -nF 'readPersistedSuccessfulTransferArtifacts' "$F"
   # 实测（第四轮，本条落地*之前*）exit 0，命中 12 行：
   #   :239 :369 :373 :387 :402 :426 :437 :452 :671 :1077 :1555 :1762
   # —— §10 区间（约 :1107–:1347）内**一次都没有**。
   ```

   **这正是 G15 刚用四条理由裁掉哈希守卫的那个失效模式（孤儿验收），在同一波以新条目复发，而且比验收 5 更糟——验收 5 至少没有配套的生产改动。**

   **可构造的后果（两种写法今天都能让全套件绿）**：(a) 实施者把判据写成 `error.code === "ENOENT"` 而不区分是哪个文件 → `owner-record.json` 的 ENOENT 也被放行 → 处置一等于没修；(b) 干脆一律 fail-closed → 每个从未转移过的 `stale_candidate` run 都丢掉 `reconciliation-record.json`。

   **本条的形状 —— 三条子用例，缺一不可（对应 §4.3「ENOENT 归因」那一节定的两选一实现）：**

   - **(i) 放行方向**：fixture 目录**只有** `owner-record.json`（可读、完整），**没有** `owner-transfer.json`；以 `eligibleForContinuation: false` 的 reconciliation 调 `writeBoundaryArtifacts`。断言 `reconciliation-record.json` **被写下**、内容是传入的那份。**这一条钉的是「收窄没有被实施成全部 fail-closed」**，它对应 §4.3 那条实测（`runLoop.ts:845` 起，`reconciliationRecord` 的传入条件是 `boundaryAnalysis.status === "stale_candidate"`，与「是否发生过转移」无关）。**变异：把 ENOENT 豁免整条删掉 → 本子用例必须红。**
   - **(ii) 不放行方向 —— ENOENT 但不是 `owner-transfer.json`**：fixture 目录有 `owner-transfer.json`（可读）、**没有** `owner-record.json`。断言 `reconciliation-record.json` **未被写下**，且 `events.jsonl` 多了一条 `reconciliation_write_abandoned`（§4.3 的人裁）。**变异：把归因去掉、改成一律放行 ENOENT → 本子用例必须红。** **这一条是三条里唯一能杀掉上面后果 (a) 的**。
   - **(iii) 非 ENOENT 方向**：fixture 目录三个文件齐备，但 `owner-record.json` 内容不是合法 JSON（`readOwnerRecordRaw` 抛 `SyntaxError`）。断言同 (ii)。**变异：退回今天的裸 `catch { return null }` → 本子用例必须红。**

   **⚠️ (i) 与 (ii)/(iii) 必须是各自独立的用例，不许合成一条**：合成之后一个「一律放行」的实现会让合并断言的一半通过、另一半被同一条 `expect` 掩盖。**这是 §10 通用条「一个测试名讲两件事、只有一件有断言」那条案底的同型。**

   **驱动入口**：直接调导出的 `writeBoundaryArtifacts`（`grep -nF 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts` 实测 `:302`，**有 `export`**），不需要经 `runLoop`——本条钉的是 `fileStore` 内部的判据，不是控制器的调用形态。

   **⚠️ 本条只钉「放弃」这个判定，不钉它的可见性。** 第五波人裁之后，那次放弃还必须被路由到 sweep 的 stderr（§4.3、§8）——**那一半由测试 12d 承重**，本条一个断言都碰不到它。**子用例 (ii)/(iii) 里那句「`events.jsonl` 多了一条 `reconciliation_write_abandoned`」是产物断言，不是路由断言**：一个「事件写了、回调没调」的实现会让本条全绿。

**债 3**

7. `runExclusive` 在 `stopped` 后拒绝；退回不拒绝 → 必须红。
7b. **被明写「接受」的退化的形状钉定（第二轮评审新增，§5.3 的 ⚠️ 指向本条）**：在 execute 超时无结果的路径上注入 `RunHeartbeatStoppedError`，断言 (i) **不调 `persistTerminalState`**（run 未被终结）、(ii) `execution-recovery.json` 的 `cleanupStatus` 未被回填、(iii) 返回的 `state.status` 仍在 `RESUMABLE_STATUSES` 内。**变异：把新错误放回 `isLeaseStopError` → (i) 与 (iii) 必须红**——这条变异同时也是 §5.3 选择 (a) 的护栏。
8. 信号槽置位 → `runLoopFromState` 在相位边界返回**非终态** state、追加 `stop_requested` 事件、不启动新 attempt。**并且断言 `attemptsUsed` 与停机前逐字节相同**——这钉的是「槽装在 `:981`（循环顶端、`attemptsUsed` 递增之前）而不是 `:1324`」（§5.4）。**变异：把槽改装到 `:1324` 那处检查点 → 本条必须红。**
8b. **`stop_requested` 之后，同一个 run 目录在下一次 sweep 中仍然 eligible**（这条是 §5.4 改判的承重断言）。**必须两条子用例**：(i) `releaseOwnerLease` **成功** → 立即 eligible（在 TTL 之内断言，否则一个只 `clearInterval` 的实现也能过）；(ii) `releaseOwnerLease` **失败并被吞** → TTL 之内被 `checkRunLease` 拒绝、TTL 之后 eligible。**只测 (i) 不承重**（§5.4）。

   **⚠️ (ii) 按第二轮的字面不可表达（第三轮评审，第一轮「测试 1 不可表达」的同型复发）**：它要 mock 的 `updateOwnerRecordWithPrecondition` **从未导出**。

   ```bash
   grep -rnF 'updateOwnerRecordWithPrecondition' src/
   # 实测 exit 0，命中 3 行，全在 src/persistence/fileStore.ts 内：
   #   :720 `async function updateOwnerRecordWithPrecondition(` —— **无 export**
   #   :755 affirmOwnerLease 内部调用
   #   :770 releaseOwnerLease 内部调用
   ```

   **采用的替代（更贴生产语义，而且不需要导出任何东西）**：**从测试侧直接改写 `owner-record.json`，让 CAS 真实失配**。`releaseOwnerLease` 走 `updateOwnerRecordWithPrecondition` 的 `sameOwnerRecord` 比对，测试在 `stop()` 之前把盘上的 owner record 换成另一份（模拟被 supersede），CAS 就会真实地抛 `OwnerTransferPreconditionError` 并被 `stop()` 的 `try{}catch{}` 吞掉。

   ```bash
   grep -nF -A8 'export async function releaseOwnerLease(' src/persistence/fileStore.ts
   # 实测 exit 0（**第四轮重跑并更正行号**）：**:769** 签名、**:770-:775** 转调
   # updateOwnerRecordWithPrecondition，失配消息
   # "persisted owner record changed before the lease could be released"
   ```

   **⚠️ 第三轮这里写的 `:768` 签名 / `:769-:774` 整体位移 1（第四轮，Minor）。** `:765`–`:768` 是那段「Best-effort by contract」的注释，签名在 `:769`。**这是「附了命令、写了输出值，但输出值是抄的不是跑的」的又一个实例**——本文档在 §17 末尾刚为同一形状（G17：§4 节首「命中 4 行」实测 3）把规矩升级过一次。**升级后的规矩没有阻止同一形状复发**，因为规矩只要求「写下输出值」，没有要求「输出值必须来自本轮那次执行」。**本轮把规矩再升一级**：**凡是重推命令旁边写着「实测」的行号，修改该行时必须重跑一次；不重跑就不许保留「实测」二字。**

   **另一条可选替代**：mock **已导出**的 `releaseOwnerLease` 本身让它抛。**但它更弱**——它不检验 CAS 的真实判据，只检验「抛出被吞」。**两条都写也可以，只写后者不达标。**
9. **`RunHeartbeatStoppedError` 不被 `isLeaseStopError` 识别**（§5.3 方案 (a)）。

   **⚠️ 第二轮这条没有自有的可失败断言（第三轮评审）**：`isLeaseStopError` 是模块私有的（`grep -nF 'isLeaseStopError' src/controller/runLoop.ts` 实测 exit 0、3 行，`:105` 定义处**无 `export`**），测试够不着它，于是它把杀伤力**整个借给了测试 7b**（「把新错误加进去 → 测试 7b 必须红」），自己是个空壳。**§9 已裁定不导出该谓词**（导出一个纯内部谓词只为测试可见性，违反 Rule 2）。

   **本层的处置：把 9 并进 7b，不留空壳条目。** 7b 的变异（「把新错误放回 `isLeaseStopError` → (i) 与 (iii) 必须红」）本来就是这条的唯一杀伤面，两条并存只是把同一条断言数了两遍。

   **并进 7b 之后，7b 另加一条自有断言**（钉 §5.3 的那条硬约束，而这条**不**依赖谓词可见性）：断言 `new RunHeartbeatStoppedError(...) instanceof RunLeaseLostError === false` **且** `instanceof RunLeaseUnverifiableError === false`。**变异：把 `RunHeartbeatStoppedError` 改成任一个的子类 → 本条必须红**——这正是 §5.3 硬约束要防的那次改动，而且它比「改谓词」更容易被无意做出。

**sweep**

10. 只对观测为 eligible 的行调 `resumeLoop`。
11. 一个 run 被拒绝不中断后续 run（依赖 §6 的排序确定性）。
12. 参数错误 / adapter-config 错误 / 扫描失败 → exit 1；其余一律 exit 0（含 run 跑成 `exhausted`）。**`--max-runs` 缺失也走 exit 1。**
12b. **`--max-runs` 承重（第二轮评审新增）**：fixture 含 5 个 eligible 目录、`--max-runs 2`，断言 `resumeLoop` **恰好被调用 2 次**、且是排序后的前 2 个；横幅同时含 `5` 与 `2`。**另一子用例**：前 2 个目录都被门拒绝（`resumeLoop` 抛出、`onAdopted` 不触发）、第 3 个可跑，断言**第 3 个也被调用**——即拒绝不消耗配额（§6）。**变异：把配额改成「每次调用都计数」→ 第二个子用例必须红。**

   **第三子用例（第三轮新增，钉 §6 的「计入时点改判」）**：一个替身 `resumeLoop` **先触发 `onAdopted`、再抛出**（模拟「门全过、k 次付费调用已发生、第 k+1 轮循环顶端 `writeRunState` 撞 ENOSPC」）。`--max-runs 1`，fixture 含 3 个这样的 eligible 目录。**断言 `resumeLoop` 恰好被调用 1 次**——配额已被那次 `onAdopted` 吃掉，遍历必须停。**变异：把计数点退回「`resumeLoop` 正常返回时 +1」→ 本条必须红**（退回之后三个目录会被全部调用，因为三次都抛出、三次都不计数）。
12c. **`cannot read run artifacts:` 前缀是被依赖的契约（第三轮新增，§4.4 的路由改判靠它）**：驱动一个读侧必失败的 eligible 目录（例如 `owner-transfer.json` 存在且 eligible、`reconciliation-record.json` 缺失），断言该行 outcome 为 **`error`**、写到 **stderr**、detail 含完整 message。**变异：把 `resumeLoop.ts` 那两处（`:119` 事件 detail、`:120` 抛出）的前缀字面量改掉而不同步改 sweep 的判据 → 本测试必须红。** 这条把「前缀是契约」从注释变成断言。
12d. **`reconciliation_write_abandoned` 路由到 stderr 的双端承重（第五波新增，钉 §4.3 的第五波人裁与 §8 那一行的改写）**

   **为什么必须补**：第四轮把这条事件定成「不路由」，因此 §10 里没有任何东西钉它的可见性；第五波人裁把它改成「必须路由到 sweep 的 stderr」，**而路由是一条穿过四个模块的新通道**——不配测试，它会以「回调传了但没人调」或「调了但打进了错的一列」两种形态静默失败。

   **四条子用例，缺一不可。**（i)(ii) 钉 sweep 侧的报告形状，(iii) 钉 `fileStore` 侧的产生，(iv) 钉中间三层的透传。**四条覆盖的是通道的三段，不是同一件事的三种说法。**

   - **(i) 路由发生，且不污染 `outcome`**（`sweepRuns` 层，用 §9 已定的注入式 `resumeLoop` 替身）：替身**先触发它收到的 `onReconciliationWriteAbandoned('<detail>')`、再正常返回一个 `succeeded` 的 `RunState`**。断言（全部对 `sweepRuns` **返回之后**的最终输出取，不对过程取）：**(1)** stderr 里有一行 `note  <path>  reconciliation_write_abandoned  <detail>`；**(2)** 该 run 自己的报告行 outcome 仍是 **`succeeded`**、且在 **stdout**；**(3)** 汇总行的 `errored` 计数为 **0**；**(4)** 退出码 **0**。
     **变异一：把它路由进 `error` 那一格（复用 `cannot read run artifacts:` 那条支路）→ (2) 与 (3) 必须红。**
     **变异二：退回第四轮的「不路由」（回调传了但 sweep 不打印）→ (1) 必须红。**
   - **(ii) 一次后续抛出不得吞掉这条备注**（这一条是**否决上行方案的那条理由的护栏**，§4.3）：替身**先触发 `onAdopted`、再触发 `onReconciliationWriteAbandoned`、再抛出**（即 §6 已实测的那条「k 次付费调用已发生、第 k+1 轮循环顶端 `writeRunState` 撞 ENOSPC」时序）。断言：stderr **同时**有那条 `note` 行**和**该 run 的 `error` 行。
     **变异：把备注的落盘时机从「回调当场记入 sweep 的数组」改成「`resumeLoop` 正常返回后才记」→ 本条必须红**（抛出路径上永远走不到那一步）。**这个变异正是上行方案 (a) 的失效形状**，用一行生产改动表达出来。
   - **(iii) 产生侧确实调了回调**（`fileStore` 层，直接调导出的 `writeBoundaryArtifacts`，驱动入口同测试 6f）：复用 **6f 子用例 (ii) 的 fixture**（目录有 `owner-transfer.json`、**没有** `owner-record.json`，以 `eligibleForContinuation: false` 的 reconciliation 调用），第三参传一个记录用的回调。断言：**回调恰好被调用 1 次**、参数含那次读失败的 `String(error)`，**且 `writeBoundaryArtifacts` 正常 resolve（不抛）**。
     **变异：只 `appendEvent`、不调回调 → 本条必须红。**
     **⚠️ 顺带钉住 `events.jsonl` 写不进去时的行为**：再加一条子断言——**mock `appendEvent` 抛出时，(a) `writeBoundaryArtifacts` 仍然正常 resolve，(b) 回调仍然已被调用过。**

     **⚠️ 这条子断言的承重变异，第六波换了**（第五波给的那条在 swallow 落地后变成等价变异）：

     - **第五波给的变异「把回调与 `appendEvent` 的顺序对调」→ 在 swallow 之后*杀不掉*。** 逐格走：`appendEvent` 被吞之后，无论它排在回调之前还是之后，**回调都照样被调用**，(b) 两侧都绿。**这与第四轮 C4 那条「结构性等价变异」是同一个病，不要再犯。**
     - **第六波改用的承重变异：删掉 `appendEvent` 外面那层 `try{}catch{}`**（即退回第四轮的裸调用）。未变异：`appendEvent` 抛 → 被吞 → `writeBoundaryArtifacts` resolve → (a) 绿。变异后：抛出逃出 `writeBoundaryArtifacts` → **(a) 必红**。**这条变异只动生产代码、非等价，且钉的正是第六波新加的那半个修法。**
     - **「回调排在 `appendEvent` 之前」这条排序仍然保留在 §4.3 里**，但要如实写明：**swallow 落地之后它是纵深防御，没有配套的杀伤变异**（它防的是「将来有人把 swallow 去掉、又没把顺序改回来」）。**不许为了给它凑一条变异而把 swallow 拿掉。**
   - **(iv) 中间三层的透传**（经 `runLoopFromState` 驱动，与测试 1 / 5 / 6e 同一个入口——`persistBoundaryAnalysis` **未导出**，且 §10 通用条禁止为测试导出它）：驱动一次 `runLoopFromState`，参数对象里传一个记录用的 `onReconciliationWriteAbandoned`，断言它被调用。
     **变异：把 `runLoopFromState` → `persistBoundaryAnalysis` 或 `persistBoundaryAnalysis` → `writeBoundaryArtifacts` 任一段的透传删掉 → 本条必须红。**

     ##### ⚠️ 第五波给的驱动 fixture 按字面**不可构造**，第六波换掉（回代码逐环复核过）

     **第五波写的是「复用测试 5 / 6e 构造的那种『输家走到保护判定』的磁盘状态」。在那个盘面上 abandon 根本不会发生：**

     ```bash
     grep -nF -A26 'async function readPersistedSuccessfulTransferArtifacts(' src/persistence/fileStore.ts
     # 实测 exit 0：:256 签名、:267-:271 三读 Promise.all
     #   （readOwnerRecord / readOwnerTransferRecordRaw / readPersistedReconciliationRecord）、
     #   :274-:276 裸 catch { return null }
     ```

     6e 的盘面是「transfer + owner **已发布**、锁由**活** pid 持有」，于是三读**全部成功** → `persistedArtifacts !== null` → `preserveSuccessfulReconciliationIfNeeded` 走**保护判定**那一支，**根本不进放弃分支** → 回调不被调用 → **(iv) 在一个完全正确的实现上也红。** 一条无论实现对错都红的测试不是护栏。

     **倒过来也堵死**：想让第二次读失败，最自然的做法是删掉或写坏 `owner-record.json`（即 6f 的 (ii)/(iii) fixture）。**但经 `runLoopFromState` 驱动时那不可行** —— `persistBoundaryAnalysis` 在 `runExclusive` 内**先**读一次 owner record，**而那一句不在任何 try 内**：

     ```bash
     sed -n '763,766p' src/controller/runLoop.ts
     # 实测（第六波）：
     #   :763 `  const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(`
     #   :764 `    async () => {`
     #   :765 `      let ownerRecord = await readOwnerRecord(runDir);`   ← 不在 try 内
     #   :766 `      let ownership = evaluateOwnershipFor(ownerRecord);`
     ```

     所以 `owner-record.json` 一旦不可读，`persistBoundaryAnalysis` 在到达 `writeBoundaryArtifacts`（`:845`）**之前**就抛了，(iv) 永远走不到被测的那一段。

     **第六波采用的 fixture（唯一一组同时满足两端约束的形状）：`owner-record.json` 合法可读 ＋ `owner-transfer.json` 存在但*不是合法 JSON*。** 逐环：

     1. `persistBoundaryAnalysis` 的 `:765` `readOwnerRecord` **成功**（owner-record 合法；且目录内无 marker，`recoverInterruptedOwnerTransfer` 早退，不会顺手把 transfer 覆盖掉）。
     2. 进 `writeBoundaryArtifacts` → `preserveSuccessfulReconciliationIfNeeded` → `readPersistedSuccessfulTransferArtifacts` 的三读，其中 `readOwnerTransferRecordRaw` 是**裸 `JSON.parse`**，坏 JSON 直接抛 `SyntaxError`：

        ```bash
        grep -nF -A2 'async function readOwnerTransferRecordRaw(' src/persistence/fileStore.ts
        # 实测 exit 0：:443 签名、
        #   :444 `  return JSON.parse(await readFile(join(runDir, OWNER_TRANSFER_FILE), "utf8")) as OwnerTransferRecord;`
        #   —— 无内部 catch，SyntaxError 直接逃出到三读的 Promise.all
        ```

     3. `SyntaxError` **不是 ENOENT** → 收窄后 fail-closed → **放弃这次 reconciliation 写** → 回调被调用。✅

     **附加约束（不写会被自己的生产代码抹掉）**：fixture 还必须让 `ownership.verdict !== "OWNER_LOST"` **或** `ownership.takeoverAllowed` 为假。否则 `persistBoundaryAnalysis` 会先走 `persistOwnerTransfer` 那一支，**把那份坏的 `owner-transfer.json` 用一份合法的覆盖掉**，第 2 步的 `SyntaxError` 随之消失：

     ```bash
     sed -n '771,772p' src/controller/runLoop.ts
     # 实测（第六波）：
     #   :771 `      if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed) {`
     #   :772 `        try {`
     ```

     同时 `boundaryAnalysis.status` 必须是 `stale_candidate`（否则 `:845` 传的 `reconciliationRecord` 是 `undefined`，`:311` 的条件直接跳过整块），且传下去的 reconciliation 的 `eligibleForContinuation` 为 `false`（否则 `preserveSuccessfulReconciliationIfNeeded` 在 `:283` 早退）。**这三条 ＋ 上面那条 owner-transfer 坏 JSON，是 (iv) 的完整 fixture 约束，四条缺一不可。**

     **⚠️ 12d 的其它子用例与测试 6f 已逐条复核，没有同型的不可达问题**（第六波）：6f 的三条与 12d(iii) **全部直接调导出的 `writeBoundaryArtifacts`**，不经过 `persistBoundaryAnalysis`，因此那条「早期 `readOwnerRecord` 不在 try 内」的约束对它们不适用 —— 6f(ii)/12d(iii) 那个「没有 `owner-record.json`」的 fixture 在直接调用下完全可构造。12d(i)/(ii) 在 `sweepRuns` 层用替身 `resumeLoop`，不碰磁盘判据。**只有 (iv) 因为必须经 `runLoopFromState` 才撞上这条约束。**
     **⚠️ 这一条不许省。** (i)(ii) 用替身 `resumeLoop`、(iii) 直接调 `fileStore`，**三条都绕开了中间三层**；少了 (iv)，一次「参数加了但忘记往下传」的实现会让前三条**全绿**。**这正是本仓库「两侧各自绿、中间断掉」那类案底的形状。**

   **⚠️ 终态 / 过程的分工，按子用例分条限定（第六波更正：第五波写成了「本条的断言*全部*钉终态」，那句全称概括为假）**（§19 下一轮优先核查项第 4 类）：

   - **(i) 与 (ii)：钉终态。** 判据是 `sweepRuns` 返回之后 stderr / stdout 的**最终文本**与 `outcome` 列的**最终取值**，不是「回调在第几个 `await` 之后被调用」。**把 harness 强加的替身执行顺序换掉——例如让替身先抛出再触发回调——这两条的断言仍然各自成立或各自失败，不会因为顺序换了就变成另一条测试。**
   - **(iii)：是纯过程断言，而且刻意如此。** 它钉的是生产代码里**两次调用的相对顺序**（回调 vs `appendEvent`），根本不经过 `sweepRuns`，在任何最终文本里都不出现。**这条不是纪律的例外，而是纪律的正面用法**：§10 测试 6e 立的纪律是「**不许把关于过程的论证用终态去钉**」，而这里论证的对象本身就是过程，所以用过程断言钉它是对的；第四轮栽的是**反过来**那一种。
   - **(iv)：也不是终态断言。** 它断言的是「回调这个事件有没有发生过」，而这件事在 `sweepRuns` 的最终文本里同样不出现（(iv) 根本不经 `sweepRuns`，见其驱动入口）。

   **⚠️ 为什么必须改这句话**：照第五波那句全称办事的实施者，可以据此把 (iii) 弱化成一条终态断言——**而那恰好放掉 `appendEvent` 与回调的排序这唯一的护栏**。

13. 信号槽置位后不再开下一个 run（`sweepRuns` 层，纯函数，可自动化）。
13b. **第二次信号 → 130**：`registerStopHandlers(signal, { exit })` 注入一个假 `exit`，断言第二次信号（**SIGINT 与 SIGTERM 混合计数**，§5.4）调用了 `exit(130)`。

   **⚠️ 第一轮把这两件事写成一条测试（「信号槽置位后不再开下一个 run；第二次信号 → 130」），而后半句按字面不可表达**——`process.exit(130)` 装在 `cli.ts` 的处理器里，第一轮没给任何注入缝，而 §10 通用条又要求「变异注入点必须在生产代码/生产类型上」。**本仓库有案底：一个测试名讲两件事、只有一件有断言。** 本层的处置是**把逃生口做成可注入形状**（`registerStopHandlers` 的第二参数，已进 §9 模块表），并拆成 13 / 13b 两条。
14. **写面钉定（取代空洞的「零写入」）**：对一个**观测 eligible 但门拒绝**的 run 目录，断言它**恰好**新增 `resume_requested` + `resume_denied` 两行事件、**其余字节不变**。

   **⚠️ 「恰好两行」只在被显式规定的 fixture 下成立（第二轮评审，Critical，两种独立机制）：**

   - **机制一**：若 owner record 的 `leaseAffirmedAt` 非 `null` 且已过 TTL，`checkRunLease` 会**先追加 `lease_expired_observed` 再放行**（§3 第 2 条那条 grep 只扫 `resumeLoop.ts`，结构上看不到 `leaseGate.ts`）。**fixture 必须把 `leaseAffirmedAt` 设为 `null`，走 `no_lease` 分支。**
   - **机制二**：`resumeLoop` 的 `Promise.all` 调 `readOwnerRecord`，它第一条语句就是 `recoverInterruptedOwnerTransfer` —— 可能 finalize 一个待决事务（本层之后是 3 rename + 若干 unlink），§4 之后还会多写 `reconciliation-record.json`。**L2 早把这个坑标出来了**：L2 §7.1 专门**禁用** `readOwnerRecord`、改用 `readOwnerRecordWithoutRecovery`，而 sweep 走的 `resumeLoop` **没有**那层保护。**fixture 必须规定目录内无任何 staging 残留 —— 逐个具名，共 11 个路径**：

- marker **1** 个：`.owner-transfer.transaction.json`
- pending **3** 份：`.owner-record.pending.json` / `.owner-transfer.pending.json` / `.reconciliation-record.pending.json`
- 发布 temp **3** 个：`.owner-record.publish.tmp` / `.owner-transfer.publish.tmp` / `.reconciliation-record.publish.tmp`
- marker temp **1** 个：`.owner-transfer.transaction.tmp`
- pending temp **3** 个：`.owner-record.pending.tmp` / `.owner-transfer.pending.tmp` / `.reconciliation-record.pending.tmp`

**11 = 1 marker ＋ 10**，其中那 10 个正是 `cleanupOwnerTransferStagingWithoutMarker` 回收的那一组（§4.3 表、§9 模块表、§10 测试 6c、§13、**本条**、§15 验收 8 —— **六处联动**，清单见 §13）。**marker 自己不在那 10 个里**——「无 marker」正是那个函数被调用的前提。

**⚠️ 第四轮更正：第三轮这里写的是「marker、三个 pending、四个 temp」= 8 个。「四个 temp」是 §4.0.3a（三份 pending 原子化）之前的旧数**，正确是 **7 个 temp**（3 发布 ＋ 1 marker ＋ 3 pending），合计 11。**这一处是第三轮那张「改一处必须改四处」联动清单*自己漏掉*的一处**——清单点了 §4.3 表 / §9 模块表 / §10 测试 6c / §13，**没点测试 14 机制二**，也**没点本轮新增的 §15 验收 8**。**立了清单又漏了清单外那处，正是「分类维度立好了，换个范围要原样带过去」那条教训的复发。** §13 的清单已就地补全为**六处**。

   - **机制三（第三轮评审补，第二轮漏掉的第三条前提）**：**拒绝必须由 `evaluateResumeEligibility` 给出**，不能是 CAS 门给的。走 CAS 门那条路（`claimOwnerRecordWithPrecondition`）会**建后删 `.owner-transfer.lock`**，并在持锁期间跑一次 `lockHeld: true` 的 `recoverInterruptedOwnerTransfer`——于是「其余字节不变」在**全树快照**下必假（锁文件的建/删会改目录 mtime，且该次回收本身是写路径）。§3 第 2 条第 4 点已把这串副作用列全，测试 14 的 fixture 却没把它排除掉。

     ```bash
     grep -nF -A12 'export async function claimOwnerRecordWithPrecondition(' src/persistence/fileStore.ts
     # 实测 exit 0：内部先 acquireOwnerTransferLock，再 recoverInterruptedOwnerTransfer(runDir,{lockHeld:true})
     ```

     **fixture 必须让 run 在 `evaluateResumeEligibility` 处就被拒**（最省事的构造：`reconciliation-record.json` 的 `eligibleForContinuation` 为 `false`，命中八条判据的第二条，`resumeLoop.ts:45`），**从而根本走不到 CAS 门。** 三条前提（`leaseAffirmedAt === null`、无 staging 残留、在资格门被拒）必须在测试里被**断言**，不得默认。

   ```bash
   grep -nF -A2 'export async function readOwnerRecord(' src/persistence/fileStore.ts
   grep -nF -B4 'export async function readOwnerRecordWithoutRecovery(' src/persistence/fileStore.ts
   ```

   **伴生断言（措辞已按第二轮评审改明确）**：fixture **必须再包含第二个*非* eligible 的 run 目录**；主断言是**那个非 eligible 目录**字节不变。变异：若 sweep 改为对非 eligible 行也调 `resumeLoop`，**那个非 eligible 目录**就会变 → 断言必须红。（第一轮写「该目录就会变」，按句法指向前半句那个 eligible 目录，而变异实际改变的是非 eligible 那个。）
14b. **恢复确实发生且被记录（第二轮评审新增，与 14 配对）**：对一个刻意 staged 触发恢复的 **eligible** 目录（构造照搬 L2 §12.1：marker present、`.owner-record.pending.json` 与 `.owner-transfer.pending.json` present、`.owner-transfer.lock` **absent**，本层再加 `.reconciliation-record.pending.json`），断言 sweep 之后 (i) 三个文件全部就位、(ii) marker 与全部 pending 已被回收、(iii) `resumeLoop` 放行。**这条把「sweep 会导致恢复」从一个被隐藏的事实变成一个被断言的事实。**

   ```bash
   grep -nF -A14 'Zero-write proof.' docs/superpowers/specs/2026-07-28-run-registry-design.md
   # L2 §12.1 的 fixture 前提集，逐条照搬
   ```

**八条判据（第三轮新增，承接 §15 验收 5 撤销哈希守卫后的空缺）**

15. **`evaluateResumeEligibility` 的八条判据各配一条会红的变异**：逐条放宽一条判据（具体变异见 §15 验收 5 的表），**每一条各自都必须让至少一条已有测试红**。**没有任何一条允许「靠别的判据顺带挡住」而存活。**

   **⚠️ 「至少一条已有测试红」按字面是本条最脆的一句话（第六波）。** 它连要红的那条测试是哪条都没要求写下来，于是八次注入只要各自让**套件**红就算过 —— 而 §10 通用条那一节已实测：一次注入顺手杀掉一批与被测判据无关的既有测试是常态。**本条按通用条改为**：**八条各自必须点名一条测试的完整测试名，并按通用条的三步（注入前单跑绿 / 注入后单跑红 / 两次原始输出都贴）逐条走一遍。** 八条的名单必须写进计划，不许写成「跑一下套件就知道」。

   - **第 4 条（判据 A）与第 6 条（判据 B）必须按测试 6b 的两组 fixture 各跑一次**——判据 A 在单转移 fixture 下根本不被求值，变异会存活（§10 测试 6b 的 ⚠️）。
   - **本条与 §15 验收 5 的计数守卫是互补的、不可互相替代**：计数守卫抓「删一条 / 加一条」，本条抓「把某一条改弱」。
   - **⚠️ 这条测试是本轮用来*取代*函数体哈希守卫的**（§15 验收 5 的 Rule 7 裁定）。若将来有人想把哈希守卫加回来，**必须先说明本条覆盖不到什么**，不许两个并存。

**通用**

- 变异注入点必须在**生产代码 / 生产类型**上。
- 反方向变异：只改 A 侧失败、只改 B 侧也失败。
- 写区间必须带样本数。
- 测试 1 / 5 / 6e / **12d(iv)** 需经 `runLoop` / `runLoopFromState` 驱动（`persistBoundaryAnalysis` **未导出**，`grep -nF 'persistBoundaryAnalysis' src/controller/runLoop.ts` 实测输出 3 行：`:704` 定义**无 export**、`:1109`、`:1141`）；**不要为此导出它**。测试 5 / 6e / **12d(iii)** 里手工构造磁盘状态、直接驱动 `writeBoundaryArtifacts` 的那部分可直接调 `fileStore` 的导出面。
- **凡是断言「恰好 N 行事件」的测试，都必须在同一条里写明 fixture 的前置条件**（`leaseAffirmedAt`、staging 残留），否则那个 N 是环境依赖的。
- **⚠️ 「变异 → 必须红」的达标判据一律是「*具名的那一条*单跑必须红」，不是「套件必须红」（第六波定死，全文适用）。**

  **它修的是什么**：第四波之前，§10 与 §15 通篇写的都是「某条测试必须红 / 本条必须红 / 至少一条已有测试红」，**没有一处要求把击杀归因到具名的那条测试**。第六波实测了 6e 变异二（见那里的原始输出）：它今天就杀掉 **6 条与 6e 无关的既有测试**，其中一条恰好就是 6e 要钉的那句话。**于是「注入 → 套件红 → 贴原始输出」这条流程，在新测试一条断言都没写的情况下照样走得通。** 这不是 6e 一条的问题，是全文性的。

  **达标判据（三步，缺一不可）：**

  1. **先具名**：写下要变红的那条测试的**完整测试名**（`describe > it` 全串），不许只写 spec 里的编号。
  2. **单跑**：`ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run -t '<完整测试名>'`，**只有这一条红才算达标**。
  3. **贴两次原始输出**：注入前该条单跑必须绿、注入后必须红。**只贴注入后那一次不算**——一条本来就红的测试注入后当然还是红。

  **额外要求**：变异实验必须在一个**基线全绿**的工作副本上做。基线不绿时，环境性失败会被整个记进击杀名单（第六波已实测到一次这样的误记，见 6e 变异二那一节）。

  **本条绑定的全部落点**（逐处点名，改一处判据要回来改这张表）：**§10**：测试 4d / 4e（三条子用例）／6（两侧）／6a／6b（两组 fixture 各一次）／6e（变异一、变异二）／6f（三条子用例）／7／7b（含并进来的 9）／8／12b（第二、第三子用例）／12c／12d（(i) 两条变异、(ii)、(iii) 两条变异、(iv)）／14 的伴生断言／15（八条判据）／§4.2 那条「若自行算 `newOwnerEpoch`」的附加变异。**§15**：验收 1a／1b／5（第 1 条的 `undefined` 断言、第 4 条、第 6 条）／8／9 的第 1–5 条。

## 11. 执行约束

- **§4（债 1）是独立的一节、独立的任务组、独立的评审，且必须先于 §6 的触发逻辑完成并通过评审。**
- 每任务一次独立评审 + 整分支一次；**修复波之后必须再评审**。
- **评审必须对着代码撞，不接受实施者自证。**
- **验证跑绝不过滤输出**——`tail` 与 `grep` 同罪。
- **计划不附完整可抄代码。**
- **每一个算出来的数字旁边就地附一条能重推它的命令，并把该命令*本轮那次执行*的输出值一并写下。** **⚠️ 第四轮把这条再升一级**：改动一条带「实测」字样的行时**必须重跑那条命令**；不重跑就不许保留「实测」二字（M3 是这条规矩缺位下的复发实例——命令附了、输出值抄的）。
- **`grep` 的用法（第四轮定死，取代此前四种互相矛盾的说法，完整依据见 §4.6a）：**
  1. **锚点一律 `-F`。** 理由是**裸符号名不唯一**，与退出码、与方言、与 `grep` 解析到谁全部无关。
  2. **任何不带 `-F` 的 `grep`，其「实测 exit N」一律不作数**——本仓库已在同一个壳里对同一条命令测到过两个不同的退出码，该观测不可复现。
  3. **确实需要正则的（多模式交替、行首锚定）改用 `-E`**，并在旁边显式标注「**需要正则：只看输出行，退出码不作为论据**」。本文档现存的、**作为重推命令**的 `-E` 共 **6** 条：

     ```bash
     # ⚠️ **这个数字没有可靠的单条计数命令，本 spec 不假装它有。**
     # 任何按「模式串」计数的写法都会连同正文里对这条规矩的引用、§19 回扫表里的引用、
     # 以及那条命令自己一起数进去 —— 而且每加一处引用数字就变。本轮实测走过三个值：
     #   grep -cF "grep -nE '"  → 先 8、再 11、再 12（每次都是本轮更晚的编辑顶掉前一个）
     #   grep -cF '# 需要正则：只看输出行，退出码不作为论据' → 8（同样含它自己与 §19 那处）
     # **本仓库第四次栽在「数字被同一波里更晚的编辑作废」上，留痕不删。**
     #
     # 可用的重推方式是**列出、不计数**（判据是「行首即 grep -nE 命令」）：
     grep -nE "^ *grep -nE '" docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
     # 需要正则：只看输出行，退出码不作为论据
     # 实测（第四轮）命中 **7 行**。
     #   —— 其中**恰好 1 行不是本层的重推命令**：§4.6 里保留的那条第一/二轮历史观测
     #      （模式是 `async function preserveSuccessfulReconciliationIfNeeded(`）。
     #   **作为重推命令的是其余 6 条。**
     #
     # ⚠️ **这里刻意不写本文档自己的行号。** 本 spec 每编辑一次它自己的行号就整体位移
     #    （本轮实测：同一组命令在几次编辑之间从 68/332/355/878/1089/1199/1916
     #     走到 71/335/358/881/1092/1202/1924）。**指向本文档自身的行号是一类必然腐坏的
     #     数字**，与指向 `src/` 的行号不同——后者只在代码真的改动时才动。留痕不删。
     ```
  4. **`-F` 下不要留正则转义**：`'heartbeat\.stop()'` 在 `-F` 下会去找字面的反斜杠。本轮已就地改掉一处。
  5. **不用 `-e` 替代 `-F`**：实测 `-e` 在本 wrapper 里工作正常（`grep -e 'currentOwnerEpoch' src/ownership/ownerController.ts` 实测 exit 0），**但它解决的是「多个模式」而不是「模式被当正则解释」**，换成它一个字都不改变问题。既有的 `-nF -e X -e Y` 写法保持不变。
  6. **`--include=*.ts` 必须加引号（或干脆不写）—— 不加引号时命令*根本没被执行过*（第六波新增，四条实测）。**

     **机制**：本壳是 zsh，`--include=*.ts` 里的 `*.ts` 会先被**文件名展开**。当前目录下没有名为 `--include=*.ts` 的文件，zsh 于是**在调用 `grep` 之前就整条命令放弃**，报 `no matches found` 并给退出码 1。**四条对照，全部第六波在本壳里实跑：**

     ```bash
     grep -rnF 'appendEvent' --include=*.ts src/ ; echo "exitA=$?"
     # 实测：stderr `(eval):1: no matches found: --include=*.ts`，**stdout 零行**，exitA=1
     command grep -rnF 'appendLeaseEvent' --include=*.ts src/ ; echo "exitB=$?"
     # 实测：**同样** `(eval):1: no matches found: --include=*.ts`，stdout 零行，exitB=1
     command grep -rnF 'appendLeaseEvent' --include='*.ts' src/ ; echo "exitC=$?"
     # 实测：3 行（leaseHeartbeat.ts:58 / :90 / :298），exitC=0
     grep -rnF 'appendLeaseEvent' src/ ; echo "exitD=$?"
     # 实测：同样 3 行，exitD=0
     ```

     **⚠️ 第五波报告里的因果记反了一半，就地更正。** 第五波说「用 `command grep` 可以规避」——**(B) 证明规避不了**：失败发生在 zsh 展开阶段，**早于**决定要调哪个 `grep`，所以 `command` / `rtk proxy` / 绝对路径**一律无效**。**真正的规避是 (C) 加引号**（推荐，保留了过滤器）**或 (D) 不写 `--include`**（第五波给的那一半结论是对的，只是理由错了）。

     **⚠️ 为什么这一条比退出码那三条更危险**：把 stderr 丢掉之后（`2>/dev/null`），**得到的是「零行输出 ＋ exit 1」——与「`grep` 跑过了、一条都没命中」完全无法区分**（第六波实测：`{ command grep -rnF 'appendLeaseEvent' --include=*.ts src/ ; echo "exit=$?"; } 2>/dev/null` 输出仅 `exit=1`）。一条「实测 0 行，命题成立」的论证会就这么写进 spec。**本文档现存的重推命令一律不得使用不加引号的 `--include=`。**
- 跑全套件时**只有 flake (B) 与 (F) 允许出现**；名单外任何失败先捕获完整测试名与失败块。
- 运行约定：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。
- **L1 spec §12 的十九条约束一条都不得弱化**（L2 成功标准 4 的原样继承）。

  **重点核查名单（第二轮评审：第一轮的名单漏掉了两条与本层改动最直接相邻的，且名单本身没附选取依据）：第 2 / 4 / 5 / 6 / 7 / 15 / 17 / 19 条。**

  **选取依据（本轮补，逐条给）：**

  | 条 | 为什么它与本层直接相邻 |
  |---|---|
  | 2 | 进程身份比较——`RunHeartbeatStoppedError` 与 sweep 的多进程形态都踩它 |
  | **4**（新增） | **引全句见下方「第 4 条与第 6 条的全句」**——**全 19 条里唯一直接规定 post-`stop()` 契约的一条**，而 §5.3 改的正是 `stop()` 之后的语义 |
  | 5 | 心跳跨自身写入存活——`runExclusive` 加拒绝后必须仍然成立 |
  | **6**（新增） | **引全句见下方**——它既是 §10 测试 14 的原型，**又**是被 §4「让恢复多写一个文件」直接威胁的对象 |
  | 7 | 「corrupt is not absent」——§4.4 的 marker / pending 解析路径同形 |
  | 15 | 「转移之后立刻 resume 不被拒」——正是 sweep 每一次要走的路 |
  | 17 | 「跑完的 run 释放租约」——§5.4 的 8b 直接依赖它，且 §5.4 已指出释放是尽力而为 |
  | 19 | 「`assertHeld` 从不被节流」——§4 在事务里多了一个文件，不得因此改变 assertHeld 的频次语义 |

  #### 第 4 条与第 6 条的全句（第三轮补；第二轮两条都被省略号截断，而**被省掉的正是与本层冲突的那半句**）

  **本文档把「引全句、不得截断、不得替原文补论证」立为铁律**（§4 节首、§4.0.1、§5.3 各自援引过它），而第二轮自己在这里破了两次。逐条引全，来源命令：

  ```bash
  grep -nF -e '4. **Heartbeat under fake timers**' -e '6. **Mutual exclusion**' -e '17. **A finished run releases its lease**' docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
  # 实测 exit 0，命中 3 行：:357（第 4 条）、:359（第 6 条）、:370（第 17 条）
  ```

  > **第 4 条（全句）**：Heartbeat under fake timers — refreshes repeatedly across a TTL window; after `stop()` no further *heartbeat* write occurs. **The one write `stop()` is permitted — and required — to make is the release of requirement 17;** assert the absence of affirms, not the absence of writes.

  > **第 6 条（全句）**：Mutual exclusion — a second `resume` against a live-lease run is refused, and the run directory is unchanged **except for appended events** (§7.1): owner record, run state, and worktrees compare byte-identical, and no interrupted-transfer recovery ran.

  > **第 17 条（全句，因为第 4 条点名了它）**：A finished run releases its lease — after the loop returns, and separately after it throws, `leaseAffirmedAt` is back to `null` and a subsequent legitimate `resume` proceeds *immediately*, not after a TTL. Asserted while the last heartbeat is still well inside the TTL, so an implementation that only cancels the timer fails it (§6.0).

  #### ⚠️ Rule 7 冲突：第 4/17 条的「required」 vs §15 验收 4 的「尽力而为」——本层挑第 4/17 条

  **冲突的形状**：第 4 条说 `stop()` 那次 release 是「permitted — **and required**」，第 17 条要求「a subsequent legitimate `resume` proceeds *immediately*, not after a TTL」；而 §15 验收 4 写的是「租约释放成功后立即 eligible；**释放失败则最迟 `LEASE_TTL_MS` 之后** eligible」——把一次 required 的写降级成了尽力而为。

  **本层挑第 4/17 条，理由三条：**

  1. **它是在先的、更受测试保护的一方。** 第 17 条自带一条会红的断言（「Asserted while the last heartbeat is still well inside the TTL, so an implementation that only cancels the timer fails it」）；§15 验收 4 的 TTL 兜底没有任何东西强制它**只**在该兜底该生效时生效。按 Rule 7「更近 / 更受测试保护者胜」，选前者。
  2. **本层根本没有权限弱化它。** `stop()` 里那个 `try { releaseOwnerLease } catch {}` 是**先于本层的既有代码**，§9 的改动清单里 `leaseHeartbeat.ts` 一行只写「`runExclusive` 拒绝 + 其上方注释」，**本层一个字节都不改 `stop()`**。所以第 17 条既没有被本层加强、也没有被本层削弱——**§15 验收 4 若读起来像是本层批准了这次降级，那是措辞错误，不是设计决定。**

     ##### ⚠️ 但「本层一个字节不改 `stop()`」不等于「本层不扩大这条路径的失败面」（第四轮评审，Important）

     **第三轮这条理由的前半句对，后半句漏披露了一条本层实际扩大的路径。** 逐环走：

     ```bash
     grep -nF -A8 'export async function releaseOwnerLease(' src/persistence/fileStore.ts
     # 实测 exit 0：**:769** 签名（第三轮写的 :768 是注释行，整体位移 1，见 §19 的 M3）、
     #   :770-:775 转调 updateOwnerRecordWithPrecondition
     grep -nF -A16 'async function updateOwnerRecordWithPrecondition(' src/persistence/fileStore.ts
     # 实测 exit 0：:720 签名、:726 `const lock = await acquireOwnerTransferLock(runDir);`、
     #   :728 `try {`、:729 `await recoverInterruptedOwnerTransfer(runDir, { lockHeld: true });`
     #   —— **这一次恢复不在任何 catch 内**（:728 那个 try 只配了 `finally { await lock.release(); }`）
     ```

     **`stop()` → `releaseOwnerLease` → `updateOwnerRecordWithPrecondition` 内部会跑一次*持锁*恢复**，而本层给这次恢复加了：**第三个参与文件**、**一次 marker 的 `readFile` ＋ `JSON.parse`**（§4.4 规则 1）、以及**规则 2 / 3 两条新的具名 fail-closed 抛出**。

     **任一抛出 → `updateOwnerRecordWithPrecondition` 抛 → `releaseOwnerLease` 抛 → `stop()` 的 `try{}catch{}` 吞掉 → 租约没被释放 → L1 §12 第 17 条的 "immediately" 退化成 "TTL 之后"。**

     **§4.0.3a 对同类扩大记了账**（「本层现在动的不只是加第三个文件 + marker 原子，还包括把两份既有 pending 从裸写改成原子写……不是实施者顺手改进」）。**这一处没记，而它落在 L1 §12 的常驻禁令第 17 条上——比 §4.0.3a 那处更承重。**

     **可达性**：规则 3 不可达；**规则 2 可达**（§4.4 的「⚠️ 规则 2 可达」，第四轮推翻了它的不可达论证）。**所以这条不是纯理论。**

     **本层的处置：记账，不修。** 修它要么给 `stop()` 的 release 加重试（改 `stop()`，本层已表态不改），要么把恢复从 `updateOwnerRecordWithPrecondition` 里摘出来（动锁协议，属 §13 第 1 笔范围）。**具名并入 §13 第 3 笔的「附带一笔同类的残余」**——那一笔原本只列了「锁忙 / I/O 失败」，**本轮补上「本层新增的规则 2 具名抛出」这一类**。
  3. **两者在各自的场景里其实都真**，冲突来自 §15 验收 4 缺了范围限定：CAS 失配意味着**所有权已经易主**，此时「a subsequent legitimate `resume`」说的是**新 owner** 的 resume，与第 17 条那条「run 跑完、无人竞争」的场景不是同一件事。

  **落地**：**§15 验收 4 已改写为显式服从第 4/17 条**（见那里），并把 TTL 兜底限定在「release 的 CAS 因所有权已易主而失配」这一种情形上，同时**具名承认**锁忙 / I/O 失败这一小类是第 17 条的真实残余——**它先于本层存在，本层不修也不弱化**，具名进 §13。**不允许两边都留。**

  **第 9 与第 12 条也值得顺带核**（9：被挡住的副作用「就地放弃而非回滚」，与 §5.3 方案 (a) 的返回非终态同形——**§5.3 已据此论证接受跳过 `cleanupAttemptWorkspaceBestEffort`**；12：`lease_expired_observed` 事件在两种情形下都必须存在，与 §3 第 2 条的写入清单直接对应）。**但这是「重点核查」，不是把其余十一条豁免**——十九条减去八条重点＝**其余十一条**仍然全部适用。

  ```bash
  grep -nE '^[0-9]+\. \*\*' docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md   # 需要正则：只看输出行，退出码不作为论据
  # 实测 exit 0，21 行。**不要直接 -c 取这个数**：其中两行是 §6 的两个心跳写者
  # （"Wall-clock timer" / "Event-driven refresh"），§12 的清单是从 "Pure predicate"
  # 开始的那一段连续 1–19。这条命令刻意打印全部行而非计数，就是为了让读者看见这两行。
  grep -nF -e '4. **Heartbeat under fake timers**' -e '6. **Mutual exclusion**' \
           docs/superpowers/specs/2026-07-26-run-lease-and-heartbeat-design.md
  # 本轮新增进重点名单的两条，各自定位
  ```
- **所有编辑落地之后，全仓扫一遍指向被改文件的行号引用。**

## 12. 治理与付费调用

`ccloop sweep --root <root> --adapter claude` 挂进 cron 就是无人值守的付费调用。

**本设计的表态**：操作者选择 `--adapter claude` 即构成对该次 sweep 全部续跑的批准。为使批准**有界**且知情：

- 启动横幅（§8）必须在扫描之后、adapter 构造之前打到 stderr，**同时写明 eligible 总数、配额 N、root 与 adapter**。少了 N，「知情」就不成立。
- **`--max-runs <N>` 为必需参数**，sweep 处理满 N 个即停。无界的「全部批准」不构成有界批准。

  **⚠️ N 不等于付费调用次数（第四轮更正）**：`--max-runs N` 界的是**进入 `runLoopFromState` 的 run 数**；每个 run 内部的 `while (true)`（`grep -nF 'while (true)' src/controller/runLoop.ts` 实测 1 行 `:973`）可跑到它自己的 `maxAttempts`（`grep -nF 'maxAttempts' src/controller/runLoop.ts` 实测 3 行，全部取自 `contract.executionPolicy.maxAttempts`）。**付费上界是 `N × maxAttempts`。** 「有界批准」仍然成立（两条界都有限），**但操作者按横幅里的 N 理解付费规模会低估一个 `maxAttempts` 倍**。**本层的处置**：不改横幅格式（加一个乘积会把 `maxAttempts` 这个 per-contract 的值提到 sweep 层，而 sweep 在打横幅时还没读任何 contract），**改为在本节写明这条乘积关系**，并把「横幅里的 N 就是付费次数」这个读法明确标为错误。
- **配额在「四道门全过、`resume_adopted` 已追加」那一刻计入**（§6 的「计入时点改判」）。被门拒绝的 run 一次付费调用都没发生，让它吃掉配额既不符合「界的是付费调用」这个目的，又会造成确定性饿死。**⚠️ 第二轮写的「只计入 `resumeLoop` 正常返回的次数」在第三轮被判定为掏空本节论证的判据**：`runLoopFromState` 的循环顶端（`:974` / `:977`）在任何 `try` 之外，第 k+1 轮在那里抛出会让**已经发生的 k 次付费调用**一次都不计。**改判之后本节的「有界」才是真的有界。**

**`--max-runs` 的完整落地面（第二轮评审：第一轮只在本节写了它，定义 CLI 形状的五节一次都没提，导致这条治理要求实际上不可实施）**：§6 调用式与流水线、§7 退出码表（缺失/非法 → exit 1）、§8 横幅与报告汇总行、§9 模块表、§10 测试 12b。

**本节不界的东西，明写出来**：`--max-runs` 界的是**付费调用**，不界事件追加。一次 sweep 扫到 M 个永久被拒的 run 仍会产生 M 次 `resumeLoop` 调用与 2M～3M 行事件（无退避、无上限、无标记，理由与代价见 §6），**这一笔具名传给 L5**（§13）。

## 13. 继承债与不做的事

| 债 | 本层处置 |
|---|---|
| 1 跨文件事务性 | **本层修**（§4） |
| 2 `persistTerminalState` 往已不拥有的 run 写 | **不碰**，留 L5 |
| 3 `heartbeat.stop()` 释放窗口 | **本层修并关闭**（§5）。**第三轮更正归类，见下面「债 3 的归类更正」** |
| 4 非原子写 | 已于 `2026-07-29-atomic-write-paths` 关闭并合并 |

**术语先说清（第二轮评审：第一轮本节首段写「L5 的继承清单确认为 1 笔」、末段写「留给 L5 具名继承的两笔」、§14 第 1 条又写「输入是债 2 + 两笔」= 3，同一节内自相矛盾）：**

- **归属裁决把「技术债」清单降到 1 笔**（只剩债 2）。降到 1 笔是 2026-07-29 那次归属裁决做的，不是本层做的；本层兑现其中的债 1 与债 3，使这份清单不再回涨。
- **本层另行具名了若干「查实、明确不处理」的项**，它们不是那次裁决口径下的「技术债」，但同样要交接。
- **L5 的输入合计 = 债 2 ＋ 下面具名的 5 笔 = 6 项。**（§14 第 1 条已同步。**这个数字随本节末尾的清单条数变化，改清单必须同时改这里。**）

  **⚠️ 第三轮对清单做了一次「一出一进」，条数与合计因此*不变*，但内容变了——不要因为数字没动就以为清单没动：**

  | 编号 | 第二轮 | 第三轮 |
  |---|---|---|
  | 1 | 锁可被偷 | **不变**（补记 `hasStagedArtifacts` 看不见第三份 pending） |
  | 2 | execute abort 后无第二重超时上界 | **不变** |
  | 3 | 「债 3 的 span 外部分」 | **措辞更正**：它是**本轮新发现的独立事实**，不是债 3 的未关闭部分（见下面「债 3 的归类更正」） |
  | 4 | 三份 pending 的非原子写 | **出**：由本层收回自修（§4.0.3a 人已裁定）<br>**进**：§4.3 新具名的**残余 TOCTOU**（输家的读→写既不原子也不持锁）接替此编号 |
  | 5 | 被拒 run 的无退避重捡 | **不变** |

  **净变化：清单仍是 5 笔，合计仍是 6 项。** 三处（本段、本节末尾括注、§14 第 1 条）数字未动，但第 4 笔的内容与第 3 笔的措辞已改。

#### 债 3 的归类更正（第三轮评审）

**第二轮把债 3 记为「exclusive span 内关闭、span 外部分具名传 L5」，这个归类错了。** 逐条：

- **裁决记录对债 3 要的是「显式表态」，不是「全域关闭」，而本层已按可接受方式表了态——按裁定它是*关闭的*。** 引全句：

  ```bash
  grep -nF -A2 'L3 spec **必须显式对债 3 表态**' docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md
  # 实测 exit 0，命中 :189
  ```

  > L3 spec **必须显式对债 3 表态**，不得沉默继承。可接受的表态包括「收紧 `stop` 语义」「收紧 `runExclusive` 语义」「论证 L3 的调用形态不使其可达并加守护测试」——但不接受不提。

  本层做的是其中第二项（**收紧 `runExclusive` 语义**，§5.3）**外加**第三项（§5.3 已诚实论证 `stopped` 之后的 `runExclusive` 在 L3 内不可达，并由 §10 测试 7 / 7b 加守护）。**两项都在「可接受的表态」名单里，所以按裁定债 3 已关闭。**

- **`writeBoundaryArtifacts` 及其前面那个 `assertHeld` 落在 span 外，是*本轮新发现的一条独立事实*，不是「债 3 的未关闭部分」。** 债 3 的定义是「`stop()` 只 await 了它读到的那一个 `queue` 快照，而 `runExclusive` 会重新赋值 `queue`」（§1）——那是一条关于 `queue` 与 `stopped` 的竞态，**已被 §5.3 关闭**。而 span 外那段从来就没进过任何 `queue`，它不是「同一条竞态没修干净」，**它是一条别的竞态**。

  ```bash
  grep -nF -B6 'const { ownerRecord, ownership, nextOwnerEpoch, eligibleForContinuation } = await heartbeat.runExclusive(' src/controller/runLoop.ts
  # 实测 exit 0：注释自己写着 "`writeBoundaryArtifacts` below stays OUTSIDE"，
  # 即它「留在外面」是 L1b 的既有设计，不是本层没修完
  ```

- **归类错误的实际危害**：写成「债 3 部分关闭」会让 L5 以为自己继承的是一笔**已被裁决过归属**的债，从而不再重新裁决；而它其实是一条**从未被任何裁决记录处理过**的新发现，**归属应当重新裁**。

**因此**：债 3 记为**本层关闭**；span 外那段作为**本轮新发现**具名传 L5（下面第 3 笔，措辞已改），并明写它需要一次归属裁决。

**关于债 2**：§5.4 改判为不写终态，**且 §5.3 选了方案 (a)**（`RunHeartbeatStoppedError` 不进 `isLeaseStopError`，另设不写终态的分支），所以本层既不新增 `persistTerminalState` 调用点，也不让任何**既有**调用点被一类新错误触达。**本层对债 2 的接触面为零。**

**⚠️ 这个结论依赖 §5.3 选 (a)。** 第一轮修订在选 (a) 之前就写了「接触面为零」——那时它不成立：§5.3 会让两个既有调用点被 `RunHeartbeatStoppedError` 触达，而债 2 恰是「`persistTerminalState` 往已不拥有的 run 写」。**若将来有人把方案改回 (c)，本段必须一起改。**

**`finalizePendingOwnerTransfer` 的 catch —— 一条明确的窄例外（数目已按 marker 原子写重数）。** 初稿承诺「不触碰 catch 块的形状」。评审证明那做不到：不给 catch 加第三个对称 `safeUnlink`，`.reconciliation-record.publish.tmp` 会在终态失败路径上永久泄漏，且没有任何别处回收它。

**本层的表态与准确数目：**

- `finalizePendingOwnerTransfer` 的 **try 首**：`safeUnlink` 从 **2 个（transferTemp、ownerTemp）扩到 3 个**（加 `reconciliationTemp`）。
- `finalizePendingOwnerTransfer` 的 **catch 尾**：同样从 **2 个扩到 3 个**。**不改变 catch 的形状与错误传播语义。**
- **marker 的 temp（`.owner-transfer.transaction.tmp`）不进这两处**：finalize 不写它，加进来就不对称了。它由 `cleanupOwnerTransferStagingWithoutMarker` 回收。
- `cleanupOwnerTransferStagingWithoutMarker`：**从 4 个 `safeUnlink` 扩到 10 个**（§4.3 已逐个具名；第三轮按 §4.0.3a 的 pending 原子化从 7 重数）。**这个数字与下面**六处**联动，改一处必须改六处**（**第四轮把清单从四处补到六处——第三轮的清单自己漏了两处，见 §10 测试 14 机制二的 ⚠️**）：

  1. **§4.3 表**的 `cleanupOwnerTransferStagingWithoutMarker` 一行
  2. **§9 模块表**的 `fileStore.ts` 一行
  3. **§10 测试 6c**（fixture 必须放上全部 10 个并逐个断言不存在）
  4. **本节**（§13 这一行）
  5. **§10 测试 14 机制二**（fixture 必须规定 **11** 个路径全部不存在 = 10 ＋ marker 自己）**← 第三轮漏**
  6. **§15 验收 8**（「覆盖全部 10 个 staging 路径」）**← 第三轮漏（该验收是第三轮自己新增的）**

```bash
grep -nF -A22 'async function finalizePendingOwnerTransfer(' src/persistence/fileStore.ts
grep -nF -A6  'async function cleanupOwnerTransferStagingWithoutMarker(' src/persistence/fileStore.ts
# 实测改动前：finalize try 首 2 个、catch 尾 2 个；cleanup 4 个
```

catch 那个「两个 `safeUnlink` 都可能替换正在传播的错误」的错误掩盖问题**原样留给 L5**（扩到三个之后是三个都可能），触发条件是「清理失败与转移失败同时发生」，与本层要修的窗口无关。

**本层查实、明确不处理、留给 L5 具名继承的五笔：**

1. **锁可被偷。** `tryRecoverStaleOwnerTransferLock` 在 `JSON.parse(lockContents)` 抛**且** `hasStagedArtifacts` 为真时，才删锁返回 true。

   ```bash
   grep -nF -A18 'async function tryRecoverStaleOwnerTransferLock(' src/persistence/fileStore.ts
   grep -nF -A14 'const handle = await open(lockPath, "wx");' src/persistence/fileStore.ts
   ```

   **场景需要两个前提，第一轮只写了一个（第二轮评审补齐）：**

   - **前提一**：`open(lockPath, "wx")` 之后、`handle.writeFile` 之前的锁文件恰好是**零长度、不可解析**——夺锁者的 `JSON.parse` 因此进 catch。
   - **前提二（第一轮省略）**：catch 分支还要求 `hasStagedArtifacts` 为真（marker 或任一 pending 存在）。**而零长度锁窗口内新持有者尚未 staging 任何东西**，所以场景**还需要一次前一次崩溃留下的残余 staging**。

   **前提二的 `hasStagedArtifacts` 只看三个路径，看不见第三份 pending（第三轮具名）：**

   ```bash
   grep -rnF 'hasStagedArtifacts' src/
   # 实测 exit 0，命中 2 行：src/persistence/fileStore.ts:542 定义、:547 使用
   ```

   它的判定是 `pathExists(transactionMarkerPath) || pathExists(ownerPendingPath) || pathExists(transferPendingPath)` —— **`.reconciliation-record.pending.json` 不在其中**。本层加了第三份 pending 却**不**把它加进这个判定：加进去会让「只剩 reconciliation pending」这种残留也变成可夺锁的依据，那是**放宽**夺锁条件，与本层「只增加拒绝」的边界相反。**因此这里是一处刻意的不对称，具名记下**：`hasStagedArtifacts` 看不见第三份 pending，属 L5 的锁协议整改范围。

   两个前提同时成立时，一个**活着的**持有者可能被夺锁，两个进程并发写入同一组固定 pending 文件名。今天由 epoch 不等挡住；本层之后，若 A、B 都从 epoch N 起算，两者的 `newOwnerEpoch` 都是 N+1，**epoch 三元组会通过**，得到一份「reconciliation 来自 A、transfer 来自 B」的记录——证据记录会对转移原因撒谎。**这是先于本层的缺陷，但 §4 扩大了它的影响面，故在此具名。** 不在本层修，因为修它要动锁协议本身。
2. **execute 相位 abort 后无第二重超时上界**（§5.4 的 ⚠️）。
3. **`writeBoundaryArtifacts` 及其前置 `assertHeld` 落在 exclusive span 之外（*本轮新发现，需要一次归属裁决*——不是「债 3 的未关闭部分」，见上面的「债 3 的归类更正」）。** `runExclusive` 的拒绝只覆盖进入 `queue` 的 span，而 `persistBoundaryAnalysis` 里 `runExclusive` 返回之后的 `assertHeld()` + `writeBoundaryArtifacts` 明确留在 span 外（代码注释自己写着 "`writeBoundaryArtifacts` below stays OUTSIDE"）。**一次并发 `stop()` 可以在 `writeBoundaryArtifacts` 飞行中 `releaseOwnerLease`。** 见 §5.2 的范围声明。本层不修，因为覆盖它要么把 artifact 写搬进 span（L1b 刚明确否决过），要么另设一层守卫。

   **附带一笔同类的残余（第三轮，§11 的 Rule 7 裁定指到这里；第四轮补上第三类）**：L1 §12 第 17 条要求「跑完的 run 释放租约、下一次 legitimate resume *立即*通过」，而 `stop()` 里那次 `releaseOwnerLease` 被 `try{}catch{}` 包着。三类失败：

   - **CAS 因所有权易主而失配**：**不构成违反**（那时 resume 的主体已经换人）。
   - **锁忙 / I/O 失败**：会让第 17 条的「immediately」退化成「TTL 之后」。**先于本层存在**，本层不修也不弱化。
   - **⚠️ `recoverInterruptedOwnerTransfer` 的具名 fail-closed 抛出（第四轮新增，这一类是*本层扩大出来的*）**：`releaseOwnerLease` → `updateOwnerRecordWithPrecondition`（`:720`）内部在 `:729` 跑一次 `lockHeld: true` 的恢复，**不在任何 catch 内**；本层给这次恢复加了第三个参与文件、一次 marker 的 `readFile` ＋ `JSON.parse`、以及规则 2 / 3 两条新的具名抛出。**规则 2 已被第四轮证明可达**（§4.4 的「⚠️ 规则 2 可达」）。抛出 → release 失败 → `stop()` 吞掉 → 第 17 条的 "immediately" 退化。**这一类不是「先于本层」，是本层扩大的**，完整论证见 §11 的「⚠️ 但『本层一个字节不改 `stop()`』不等于……」一节。**本层记账不修**（修它要改 `stop()` 或动锁协议，两者都超出范围）。
4. **输家 reconciliation 写的残余 TOCTOU（第三轮新增，接替第二轮那笔被收回的 pending 非原子写；第四轮扩写为*两条*时序）。** `preserveSuccessfulReconciliationIfNeeded` 的「读 → 判定 → 写」既不原子也不持锁，**而且那次「读」本身是一个跨两个文件的 `Promise.all`，不是快照**（§4.0a 已就地写明）。两条已查实的时序：

   - **时序一**：输家的读早于赢家发布任何东西（`readOwnerTransferRecordRaw` ENOENT → 裸 `catch { return null }` → 保护整个不生效），写晚于赢家的 reconciliation rename。
   - **时序二（第四轮新增）**：输家的两次读**跨在赢家的 rename#1 与 rename#2 之间** —— 读到 transfer(N+1) ＋ owner-record(仍是 N)，`transferRepresentsPublishedWinner` 的判据 B（`currentOwnerEpoch === newOwnerEpoch`）不成立 → 保护同样退化。**这一条不需要 ENOENT，也不需要任何「多次 rename 落进同一个间隙」的巧合**：两次读之间隔着 `readOwnerRecord` 的 `recoverInterruptedOwnerTransfer` 前缀（数次 `pathExists` ＋ 可能一次 `readFile`），而赢家在两次 rename 之间隔着一整个 `writeJsonFile`。**第三轮的 §4.3 声称这条不可达，那句话已在本轮撤回。**

   两条都以「输家的降级版本永久覆盖赢家的真品」收尾。**`finalizeOrder` 排哪个方向都拦不住**——§4.3 的排序改判只是收窄，**没有关闭它**，而**收窄幅度本 spec 不再量化**（前两次量化各被下一轮证伪，理由见 §4.3）。**这是先于本层的缺陷**（今天赢家也在事务后经 `writeBoundaryArtifacts` 写 reconciliation，可被同样覆盖）。修法需要给输家那次写加锁（§4.3 已否决的方案 (c)）或引入文件系统级 CAS / 写后复核重试，两者都超出本层最小解。**完整论证与已采用的部分处置见 §4.3。**

   **本笔附带交接的一件事（第四轮两件，第五波撤回其中一件，见下；不单开一笔——它是本笔的前提条件，不是独立缺陷）：**

   - **`readPersistedReconciliationRecord` 的 `catch { return undefined }`**：本层的处置一把「它自带 catch、从不抛」当成承重前提（「健康路径上唯一的 null 来源是 owner-transfer ENOENT」）。**本层不收窄它**，依据三条见 §4.3（L1 §12 第 7 条的范围不含该文件 / 该文件由 temp+rename 发布故截断态不可达 / 即便可达 `undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation` 合成赢家视图）。**第三轮给的「先于本层 ⇒ 不在范围」那条理由已撤回**——同一波的人裁刚好推翻了这条判据（三份 pending 也先于本层，照样被收回自修）。

   **⚠️ 第五波撤回第四轮在这里交接的第二件事：「`reconciliation_write_abandoned` 事件对 sweep 不可见」。** 第四轮把「cron 的『有 stderr 即告警』不会为它响」写成一条具名代价传给 L5；**人已裁定必须路由到 sweep 的 stderr，本层就地实现，这条代价不再成立，整条从交接清单里删除**（通道与四层签名见 §4.3 的「⚠️ 人已裁定（第五波，推翻第四轮）」，落点见 §8，承重测试 12d，验收 9 第 5 条）。**它当时被并进本笔而不是单开一笔，所以撤回它不改变清单条数：**

   - **§13 清单仍是 5 笔、L5 输入合计仍是 6 项**（本节开头、本节末尾括注、§14 第 1 条**三处数字均不变**）。
   - **第四轮那句「与 §5.4 对『人按过 Ctrl-C』的处置是同一个已知缺口，理由也相同」一并撤回**：两者不同类。§5.4 那条是**跨进程**可见性（本次 sweep 其实看得见停机，看不见的是下一次 sweep），只能靠磁盘契约；本条是**同一次 sweep、同一个进程内**的可见性，进程内回调就够。**是这句错误的归类把第四轮引向了「只能等 L2/L5」的结论。** §5.4 第 2 条本身不受影响，原样保留。
5. **被拒 run 的无退避重捡。** registry 不观测 `reconciliation-record.json`，所以「transfer eligible 但 reconciliation 不合格」的 run 会被**每一次** sweep 重新捡起、每次追加 2～3 行事件，无退避、无上限、无标记。见 §6 与 §12。

（**清单是 5 条**；加上债 2，L5 的输入合计 **6 项**，与本节开头及 §14 第 1 条一致。**改清单必须同时改这三处数字。** 第三轮做的是「一出一进」——第 4 笔换了内容，条数与合计都没动，对照表见本节开头。）

## 14. 后续

1. **L5 — cleanup / orphan handling**（父设计 §17 item 3）。**输入合计 6 项 = 债 2 ＋ §13 具名的 5 笔**（锁可被偷、execute abort 无第二重上界、**`writeBoundaryArtifacts` 落在 span 外（本轮新发现，需重新裁归属）**、**输家 reconciliation 写的残余 TOCTOU**、被拒 run 的无退避重捡）。**这个数字与 §13 的清单联动，改一处必须改两处。**

   **⚠️ 第三轮的一出一进（数字未变，内容变了）**：第二轮那笔「三份 pending 的非原子写」**已由本层收回自修**（§4.0.3a 人已裁定），它的位置由「输家 reconciliation 写的残余 TOCTOU」接替（§4.3）。**下一位读者若只比对数字会以为清单没动——它动了。**
2. **常驻形态**（`watch`）：会让「飞行中 `stop()`」重新成为问题，§5.2 的论证是起点。
3. **execute abort 的 SIGKILL 升级**：独立任务，独立评审。

## 15. 验收标准

1. **没有任何生产路径**能产生一个**持久的**「transfer 已发布、reconciliation 缺失」磁盘状态。（初稿写的「该状态不可构造」是假的——任何人都能 `writeFile` 出来，而且测试 2 必须能构造它。）

   **⚠️ 「持久的」三个字是本轮按 §4.3 排序改判加上去的，不得省略。** 新排序 `[transfer, owner, reconciliation]` 下，该状态是一个**真实的瞬时窗口**；判定它是否可接受的标准是：**该窗口内 marker 必在盘上**（marker 的 `safeUnlink` 排在三次 rename 全部完成之后），因此恢复必然推完。次生后果——`resumeLoop` 的 `Promise.all` 可能在恢复完成前读到 reconciliation ENOENT，使**该次** sweep 拒绝、下一次通过——**本层明确接受**，它是瞬时且自愈的 liveness 抖动，不是安全洞。
1a. **输家不得覆盖赢家已发布的 reconciliation——*在 §4.3 排序改判所覆盖的那个窗口内*。**（第二轮新增；**第三轮就地收窄范围**，第二轮那句无限定的写法为假。）

   **本条承诺的准确内容（第四轮再收窄一次）**：在「transfer + owner 已发布、reconciliation 尚未发布」的窗口内，**且输家的两次读都落在 transfer 与 owner-record 都已 rename 之后**，一次输家的 `writeBoundaryArtifacts` 不得把 `reconciliation-record.json` 降级为 `eligibleForContinuation: false`。测试 6e 承重，两条变异（改 `finalizeOrder`；删 `tryRecoverStaleOwnerTransferLock` 的活进程检查）各自必红，**且都只动生产代码**（§10 测试 6e 已按第四轮重写；**第二轮与第三轮各给的两条变异实测都不会红**）。

   **本条*不*承诺的内容，明写出来（第四轮补第二条）**：

   1. 它**不**承诺「输家在任何时序下都不得降级」。**残余时序之一**——输家的读早于赢家发布任何东西（`readOwnerTransferRecordRaw` ENOENT → 裸 `catch { return null }`），写晚于赢家的 reconciliation rename。
   2. **残余时序之二（第四轮新增，第三轮的验收面只点了上面那一条）**——输家的**两次读跨在赢家的 rename#1 与 rename#2 之间**：读到 transfer(N+1) ＋ owner-record(仍是 N) → `transferRepresentsPublishedWinner` 的**判据 B 不成立** → 保护同样退化。**这一条不需要 ENOENT，也不需要「三次 rename 落进一个间隙」**，完整推导见 §4.3 的 U0–U3 表。**第三轮的 §4.3 声称这条不可达（「P2 的读一旦晚于 P1 的第一次 rename …保护生效」），那句话已被撤回。**

   **两条残余都由排序改判「收窄、未关闭」，一并具名传 L5（§13 第 4 笔）。**
1b. **读侧失败不得退化为无保护直写**（第三轮新增，**第四轮补上落点与归因要求**，**第五波补上路由要求**，钉 §4.3 的处置一）：`readPersistedSuccessfulTransferArtifacts` 在**除「`owner-transfer.json` 的 ENOENT」以外**的任何读失败上都必须让调用方放弃 reconciliation 写，而不是原样放行输家那份；放弃时**追加一条 `reconciliation_write_abandoned` 事件**（§4.3 第四轮人裁）、**并通过 `onReconciliationWriteAbandoned` 回调路由到 sweep 的 stderr**（§4.3 第五波人裁），**不抛出**。

   **⚠️ 「事件已落盘」不等于本条达标**（第五波）：可见性那一半由**验收 9 第 5 条 ＋ 测试 12d** 承重，测试 6f 一个断言都碰不到它。**只跑 6f 的实现可以「事件写了、回调没调」而全绿。**

   **⚠️ 本条在第三轮是孤儿验收——§10 区间内一次都没有对应条目**（重推命令与实测行号见 §10 测试 6f 开头）。**已补：§10 测试 6f。**

   **⚠️ 「ENOENT 豁免」必须写明归因到哪个文件，否则本条与它的反向断言在最自然的实现下*都会绿***：那个 catch 包住的是三读的 `Promise.all`，ENOENT 可来自 `readOwnerTransferRecordRaw`、`readOwnerRecordRaw`、`finalizePendingOwnerTransfer` 的 `:610`/`:611`。归因方式二选一（按 `error.path` / 把那次读移出 `Promise.all` 单独 try），见 §4.3 的「ENOENT 归因」一节。

   **达标判据（三条子用例，缺一不可，见 §10 测试 6f）**：(i) ENOENT-of-`owner-transfer.json` → **放行**（否则每个从未转移过的 `stale_candidate` run 都丢掉 `reconciliation-record.json`）；(ii) ENOENT-of-**其它**文件 → **不放行**；(iii) 非 ENOENT 的任意读失败 → **不放行**。**三条各自配一条会红的变异**（分别是：删掉 ENOENT 豁免 / 去掉归因改成一律放行 ENOENT / 退回裸 `catch { return null }`）。**只写 (i) 与 (iii) 两条，「一律放行 ENOENT」这个实现会全绿——那正是本条要防的那个实现。**
2. 事务的每一个崩溃中间态都让 `resumeLoop` 拒绝；marker 仍在的中间态都能由 `recoverInterruptedOwnerTransfer` 推完。

   **已知例外，全部在此具名（第二轮补全为四条；第三轮合并为*三条*——原第 3 条「pending 写坏」因 §4.0.3a 的 pending 原子化不再可达，已并入第 3 条与原第 4 条合并后的那一条）：**

   1. **marker 缺失的窗口**——恢复无从判断有没有待决事务，只能在持锁入口回收 staging。
   2. **`!lockHeld` 且锁文件存在、`isProcessActive` 为真**时恢复会跳过。`isProcessActive` 对 `ESRCH` 以外的任何错误——含 `EPERM`——返回 true，故被回收的 pid 会把事务钉成暂不可恢复。
   3. **§4.4 规则 2 / 3 的两个 fail-closed 分支**（v2 marker 但 pending 缺失；marker 不可解析），**外加「pending 被写坏（截断）」**。

      **⚠️ 第四轮更正：三者*不是*全部不可达。** 第三轮写的「三者……在生产中全部不可达」按规则 2 为假。逐条：

      - **规则 3（marker 不可解析）：不可达**（§4.0.3 的 marker 原子写）。纵深防御。
      - **「pending 被写坏（截断）」：不可达**（§4.0.3a 的三份 pending 原子写）。纵深防御。
      - **规则 2（v2 marker 但 pending 缺失）：*可达***，路径见 §4.4 的「⚠️ 规则 2 可达」一节（并发恢复：一个进程删掉 stale 锁之后，另一个进程的 `pathExists(lockPath)` 短路，两者同时进 finalize，先跑完的那个删掉 marker 与 pending）。**它是一次性的、非永久钉死的**（事务已被先跑完的那个推完），后果是 sweep 打一次 stderr 告警。**本层不修**（要动锁协议，属 §13 第 1 笔的范围）。

      对**不可达的那两条**：若有人手工构造出它们（或把原子写改回去），表现是「marker 仍在但推不完」，**恢复手段只有人工删除该 run 目录下的 staging，本层无自动化入口**（§2 把 cleanup/GC 排给了 L5）。

      **⚠️ 第三轮的改判必须写明**：第二轮把「pending 写坏」列为**唯一一类真实可达**的钉死状态并具名传 L5。**人对 pending 原子化的裁定（§4.0.3a）之后它不再可达**，那一笔已由本层收回、不再传 L5（§13 的一出一进对照表）。**保留它在本条名单里，是因为它仍然是一个纵深防御分支要处理的形状，不是因为它仍然可达。**

   **本条不得再用「可恢复」一词描述上面任何一种状态**，除非同时给出恢复它的代码路径。
3. `runExclusive` 在 `stopped` 后必然拒绝；退回旧行为则测试 7 变红。
4. **`stop_requested` 或 `RunHeartbeatStoppedError` 中断过的 run，在下一次 sweep 中仍然 eligible。**

   **⚠️ 本条在第三轮按 §11 的 Rule 7 裁定重写——第二轮的写法读起来像是本层批准了对 L1 §12 第 17 条的降级，那是措辞错误，不是设计决定。**

   **第一优先，不可弱化**：**L1 §12 第 4 条与第 17 条原样成立**——`stop()` 那次 release 是「permitted — **and required**」，且「a subsequent legitimate `resume` proceeds *immediately*, not after a TTL」。**本层一个字节都不改 `stop()`**（§9 的 `leaseHeartbeat.ts` 一行只含 `runExclusive` 与其上方注释），所以第 17 条既未被本层加强也未被本层削弱。**任何实施都不得以本条为依据把 release 做成可选的。**

   **TTL 兜底的适用范围（收窄）**：**只**适用于「release 的 CAS 因**所有权已易主**而失配」这一种情形。那时「a subsequent legitimate `resume`」说的是**新 owner** 的 resume，与第 17 条那条「run 跑完、无人竞争」的场景不是同一件事，两者不冲突。

   **具名残余（不掩盖）**：锁忙 / I/O 失败导致 release 失败的那一小类，**确实**会让第 17 条的「immediately」退化成「TTL 之后」。**它先于本层存在，本层不修也不弱化**，具名进 §13 第 3 笔。

   **达标判据**：两条子用例都由测试 8b 覆盖，只测顺利路径不算达标；**且 (ii) 必须用「测试侧改写 `owner-record.json` 让 CAS 真实失配」构造**（§10 测试 8b：第二轮要 mock 的 `updateOwnerRecordWithPrecondition` 从未导出，按字面不可表达）。
5. `evaluateResumeEligibility` 的八条判据一个字节未改。

   **⚠️ 本条必须有钉住手段，第一轮一个都没有（第二轮评审）**：§3 第 3 条的 `grep -cF 'return { ok: false'` 只能数条数、数不出内容——把 `!==` 改成 `>` 仍然是一条 `return { ok: false`，计数不变；§10 里也没有对应测试。

   #### ⚠️ Rule 7 冲突：函数体哈希守卫 vs 八条变异测试 —— **本层挑变异测试，撤销哈希守卫**

   第二轮定的是「计数守卫 ＋ 函数体哈希守卫」两条并用，并为哈希守卫配了三条防护栏。第三轮两个评审员在这里意见相反：一个实测「阈值 20 vs 函数体 28 行合理、防护栏针对的失败模式正确」，另一个认为它违反 Rule 2、更小的解是「八条判据各配一条会红的变异测试」。**按 Rule 7 必须挑一个，不许两边都留。**

   **本层挑「计数守卫 ＋ 八条变异测试」，撤销哈希守卫。理由四条：**

   1. **Rule 2 是项目规约，而哈希守卫是这里的更大解。** 它需要一个函数体提取器、一个配平算法、外加**三条**只为防止提取器自己静默假通过的防护栏。**一个守卫需要三条防护栏来保证它不骗人，本身就是它选错了的证据。** **（第四轮复核：这条**保留**——它是结构性理由，与 §10 通用条「变异注入点必须在生产代码 / 生产类型上」同源，站得住。）**
   2. ~~**它是孤儿验收——§10 里没有任何对应测试条目。**~~ **⚠️ 第四轮撤回这条理由：它逐字适用于被保留下来的计数守卫。** 计数守卫在 §10 里**同样**没有任何条目（测试 15 钉的是八条变异，不是那条 `grep -c`）。**用一把尺子量了对手、没量自己。** 保留下来的那半句仍然成立且值得写：§15 的每一条都应当由 §10 的某一条承重，**而这条配对纪律本轮已扩到全部验收条目，并补上了反方向的检查**（「§10 的每一条测试有没有 §15 面」）——见 **§15 验收 9** 里那张六条无验收面的测试对照表。
   3. **它对无关字节变化误红。** 验收 5 要保住的是「八条判据的**语义**一个都没被放宽」。哈希守卫对**任何**字节变化变红——包括加一行注释、改一个 reason 字符串、`prettier` 换行——而团队对反复误红的守卫的标准反应是调低它或删掉它。变异测试只在语义被改时红。
      **⚠️ 第四轮补一条对称的自我审查**：**计数守卫在同一个失效模式上并不干净。** `grep -cF 'return { ok: false'` 依赖那八行各自把 `return { ok: false` 写在同一行；一次 `prettier` 把某个 return 换行，计数就掉到 7，**同样是零语义改动误红**。**本层仍然保留计数守卫**，理由是它的误红形状**可判定且易修**（换行导致的误红一眼可见，改回去即可），而哈希守卫的误红形状是「一个 40 位十六进制串不匹配」，读者拿不到任何关于改了什么的信息。**这个差别是本层保留其一、撤销其一的真实依据；第三轮那条「假阳性远多于真阳性」是没有测过的比较，予以撤回。**
   4. ~~**计数守卫 ＋ 变异测试的组合覆盖面严格更宽。**~~ **⚠️ 第四轮撤回：「严格更宽」是断言不是证明，而且已被证伪。** 上面「八条里有三条的建议变异杀不掉」证明变异测试这一半有三个洞（第 1、2、6 条），**而哈希守卫会 trivially 抓到那三次编辑**（它们都是字节改动）。**正确的表述是**：两者覆盖面**互有出入**，本层挑变异测试是因为理由 1（Rule 2）与理由 3（误红形状可判定）**，不是因为它覆盖得更宽**。
   5. **（第四轮新增，补一条第三轮留下的不对称门）** 第三轮的裁定文本只要求「加回哈希守卫必须先说明覆盖不到什么」，**没有对称地要求「发现变异存活必须说明如何补」**。本轮补上这条对称要求：**任何一条变异被实测证明存活时，必须就地写下补法或明写「暂无补法」，不许沉默。** 本轮已按此对第 1、2、6 条各给了补法。

   **本层定的手段（两条并用，缺一不可）：**

   1. **计数守卫**：`grep -cF 'return { ok: false' src/controller/resumeLoop.ts` **必须仍为 8**。

      ```bash
      grep -cF 'return { ok: false' src/controller/resumeLoop.ts
      # 实测输出 8
      ```

   2. **八条变异测试**（新增进 §10，见测试 15）：**逐条**变异 `evaluateResumeEligibility` 的一条判据，**每一条各自都必须让至少一条测试红**。变异点全部落在生产代码上。八条判据与它们的行位置：

      ```bash
      grep -nF -A32 'export function evaluateResumeEligibility(' src/controller/resumeLoop.ts
      # 实测 exit 0：签名 :39；函数体 :40–:67（首行解构 + 八条 return { ok: false } + 末行 return { ok: true };）；
      # 闭合大括号 :68。八条判据依次在 :42 :45 :48 :51 :54 :57 :60 :63
      ```

      | # | 行 | 判据（**逐字照抄源码，含 cast**） | 建议的变异 | 第四轮实测判定 |
      |---|---|---|---|---|
      | 1 | :42 | `(ownerTransfer.eligibleForContinuation as boolean) !== true` | ~~改为 `=== false`~~ → **见下方「第 1 条」** | **原变异是等价变异** |
      | 2 | :45 | `reconciliation.eligibleForContinuation !== true` | ~~改为 `=== false`~~ → **整条删掉** | **原变异是等价变异** |
      | 3 | :48 | `reconciliation.ownershipVerdict !== "OWNER_LOST"` | 整条删掉 | 成立 |
      | 4 | :51 | `reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch` | 改为 `>`（§4.3 的**判据 A**，只有双转移 fixture 杀得掉，见测试 6b） | 成立（fixture 有约束） |
      | 5 | :54 | `ownerRecord.supersededByEpoch !== null` | 整条删掉 | 成立 |
      | 6 | :57 | `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch` | ~~改为 `<`~~ → **见下方「第 6 条」** | **原变异被 6b 的两组 fixture 都杀不掉** |
      | 7 | :60 | `ownerRecord.ownerStatus !== "current"` | 整条删掉 | 成立 |
      | 8 | :63 | `!RESUMABLE_STATUSES.includes(runState.status)` | 改为恒 false | 成立 |

      ```bash
      sed -n '39,70p' src/controller/resumeLoop.ts
      # 实测（第四轮）：:39 签名、:40 解构、八条判据依次在 :42 :45 :48 :51 :54 :57 :60 :63、
      #   :67 `return { ok: true };`、:68 闭合。
      #   **:42 的表达式带 `as boolean` cast**：`if ((ownerTransfer.eligibleForContinuation as boolean) !== true) {`
      #   —— §4.2 表与本表在第三轮都把它抄成了没有 cast 的版本，抄漏了动机。
      ```

      #### ⚠️ 八条里有三条的建议变异**杀不掉**（第四轮评审，Important，逐条附依据）

      **第 1 条 —— `!== true` → `=== false` 是等价变异，除非 fixture 里该字段是非布尔。**
      `ownerTransfer.eligibleForContinuation` 的静态类型若是 `boolean`，`x !== true` 与 `x === false` 对**所有**布尔取值等价。**而那个 `as boolean` cast 正说明这里防的就是非布尔的运行时取值**（cast 的存在意味着静态类型不是 `boolean`）——`undefined`、`null`、`"true"`、`0` 在两个写法下结果相反。**第三轮既没有要求这种 fixture，也没有抄下那个 cast，所以变异会存活。**
      **本层的处置**：第 1 条的变异**改为「整条删掉」**（无条件杀得掉），**并另加一条独立断言**——fixture 提供一份 `eligibleForContinuation` 字段**缺失**（`undefined`）的 `owner-transfer.json`，断言 `evaluateResumeEligibility` 仍然拒绝。**变异：把 `!== true` 改成 `=== false` → 该断言必须红。** 这条断言把 cast 的动机从注释变成测试。

      **第 2 条 —— 类型是 `boolean`，`!== true` 与 `=== false` 在*任何*合法 fixture 下都等价。**（它没有 cast，说明 `ReconciliationRecord.eligibleForContinuation` 就是 `boolean`。）**变异改为「整条删掉」。**

      **第 6 条 —— `!==` → `<` 被 §10 测试 6b 强制的两组 fixture *都*杀不掉：**

      - **首发转移 fixture**：`currentOwnerEpoch = N`、`newOwnerEpoch = N+1`。基线 `N !== N+1` → 拒绝；变异体 `N < N+1` → **同样拒绝**。行为相同，不红。
      - **双转移 fixture**：`currentOwnerEpoch = N+2 === newOwnerEpoch = N+2`。基线不拒绝；变异体 `N+2 < N+2` 为 false → **同样不拒绝**。行为相同，不红。

      **要杀掉它需要第三组 fixture**：`currentOwnerEpoch > newOwnerEpoch`（例如 `currentOwnerEpoch = N+2`、`ownerTransfer.newOwnerEpoch = N+1`）。基线 `N+2 !== N+1` → 拒绝；变异体 `N+2 < N+1` 为 false → **放行** → 红。
      **⚠️ 但这组 fixture 必须同时满足*其余七条*判据全部通过**（否则违反测试 15 那条「不许靠别的判据顺带挡住」）。**⚠️ 第六波更正：第四轮这里写「另外四条」却列了五条，数词与列项自相矛盾，而且清单本身漏了两条 —— 正确是七条。** 逐条并附「漏了会怎样」：

      | 判据 | fixture 必须 | 相对第 6 条的位置 | 不满足则 |
      |---|---|---|---|
      | 1（`:42`） | `ownerTransfer.eligibleForContinuation === true` | **之前** | 基线与变异体都在第 1 条被抢先拒绝 → **变异存活** |
      | 2（`:45`） | `reconciliation.eligibleForContinuation === true` | **之前** | 同上 → **变异存活** |
      | 3（`:48`） | `reconciliation.ownershipVerdict === "OWNER_LOST"` | 之前 | 同上 |
      | 4（`:51`） | `reconciliation.newOwnerEpoch === ownerTransfer.newOwnerEpoch`（即也是 N+1） | 之前 | 同上 |
      | 5（`:54`） | `ownerRecord.supersededByEpoch === null` | 之前 | 同上 |
      | 7（`:60`） | `ownerRecord.ownerStatus === "current"` | **之后** | 变异体在第 6 条放行后又被第 7 条拒 → 两侧行为相同 → **变异存活** |
      | 8（`:63`） | `runState.status` 在 `RESUMABLE_STATUSES` 内 | **之后** | 同上 |

      ```bash
      sed -n '39,68p' src/controller/resumeLoop.ts
      # 实测（第六波重跑）：八条判据依次是
      #   1 `(ownerTransfer.eligibleForContinuation as boolean) !== true`
      #   2 `reconciliation.eligibleForContinuation !== true`
      #   3 `reconciliation.ownershipVerdict !== "OWNER_LOST"`
      #   4 `reconciliation.newOwnerEpoch !== ownerTransfer.newOwnerEpoch`
      #   5 `ownerRecord.supersededByEpoch !== null`
      #   6 `ownerRecord.currentOwnerEpoch !== ownerTransfer.newOwnerEpoch`   ← 被变异的那条
      #   7 `ownerRecord.ownerStatus !== "current"`
      #   8 `!RESUMABLE_STATUSES.includes(runState.status)`
      # —— 1–5 在 6 之前，7/8 在 6 之后。故「其余七条全部通过」，一条都不能少。
      ```

      **⚠️ 漏掉的两条里，判据 2 尤其危险**：这组 fixture 的场景描述是「owner record 的 epoch 跑到了 transfer 前面」，与 **reconciliation 的 eligible 位**毫无直觉关联，实施者极易不去设它 → 第 2 条抢先拒绝 → **变异存活** —— **而 §15 验收 5 的这整节正是为了消灭「变异存活」才写的。****这是一份「owner record 的 epoch 跑到了 transfer 前面」的手工 fixture，生产中不可达**（它对应「更晚的一次转移已经完成、但 `owner-transfer.json` 还是旧的」）——**这没关系，测试 15 钉的是判据的语义，不是可达性**，但测试注释必须写明这一点。

      **⚠️ §10 测试 6b 那句「判据 B：任何单转移场景都能杀」与上面直接打架。** 那句话**只对「整条删掉」这个变异成立**（删掉之后单转移 fixture 会被错误放行）。**对 `!==` → `<` 这个变异它为假。** 已在 §10 测试 6b 就地改。

      **第 4 与第 6 条的杀伤 fixture 要求见 §10 测试 6b**（判据 A 只有双转移 fixture 杀得掉；判据 B 的 `<` 变异**需要第三组 fixture**）——**这两条不许用单转移 fixture 交差**。

   **⚠️ 撤销哈希守卫时必须一并撤销的东西**：第二轮为它写的三条防护栏（行数 < 20 报错、断言含全部八个 `return { ok: false`、不假定签名行无大括号）**随之作废**，不要留在计划里变成无主的实现要求。**其中「函数体 28 行」这个实测数字本身仍然正确**（上面那条 grep 重推过），只是不再有任何东西依赖它。
6. sweep 对一个被门拒绝的 run 目录**恰好**新增 `resume_requested` + `resume_denied` 两行事件、其余字节不变，且该断言是承重的（测试 14）。

   **⚠️ 「恰好两行」只在测试 14 显式规定的 fixture 下成立**（本轮收窄；第一轮把它写成了无条件断言，两条独立机制各自证伪它）：fixture 必须满足 **(i) `leaseAffirmedAt` 为 `null`**（否则 `checkRunLease` 会多写一行 `lease_expired_observed`），**(ii) 目录内无任何 staging 残留**（否则 `resumeLoop` 的 `readOwnerRecord` 会触发恢复，写文件而不只是事件）。两条前提必须在测试里被断言，不得默认。
6b. **恢复确实发生时被断言，而不是被回避**（测试 14b）：对一个刻意 staged 触发恢复的 eligible 目录，恢复必须发生、三文件就位、staging 被回收。
7. **§11 的实施顺序硬约束有验收面**（第二轮新增；**第三轮重写——第二轮那条判据在今天的仓库上*无条件通过*，等于没有验收面**）。

   **⚠️ 第二轮那条为什么恒真，两处独立地各自恒真：**

   ```bash
   ls docs/superpowers/
   # 实测输出三行：decisions  plans  specs —— **没有 reviews/**，而且本仓库从未有过这个目录
   git log --oneline -- docs/superpowers/reviews/; echo "exit=$?"
   # 实测：**零输出，exit 0**。git log 对不存在的路径空输出退出 0，
   # 于是「后者中 §4 评审报告那一条」永远是空集，比较永远不发生。
   git log --reverse --format='%h %ad %s' --date=iso -- src/sweep/ src/cli.ts
   # 实测第一条：cf79fd6 2026-07-15 00:44:22 +0800 feat: bootstrap TypeScript CLI loop runner
   # —— src/cli.ts 早有历史，所以「§6 任务组的第一次提交」永远被解析成 2026-07-15 那笔引导提交，
   # 它比任何将来的 §4 评审都早。**即使 reviews/ 存在，这条比较也会给出错误答案。**
   ```

   **两个错叠在一起**：一个仓库从未有过的目录约定 ＋ 一条对已有历史路径取「第一条提交」的命令。**这条验收是为「实施顺序要有验收面」新加的，结果既恒真又不可能给出正确答案。**

   **第三轮改用的判据（不新建目录约定，不依赖任何路径的「第一条提交」）：**

   **§4 任务组与 §6 任务组必须是*两笔各自独立评审过的合并*，且 §4 的那笔在祖先链上早于 §6 的那笔。** 合并前用这三条核，**三条都要贴原始输出**：

   ```bash
   # (1) 定位两个任务组各自的合并提交（评审通过的证据 = 合并提交的提交信息里带评审结论）
   git log --merges --format='%h %ad %s' --date=iso --reverse
   # (2) §4 的合并必须是 §6 的合并的祖先 —— 退出码即判据，不看输出
   git merge-base --is-ancestor <§4 的合并 hash> <§6 的合并 hash>; echo "exit=$?"   # 必须 0
   # (3) §6 任务组*引入* src/sweep/ 的那一笔（不是 src/cli.ts 的历史第一笔）
   git log --diff-filter=A --format='%h %ad %s' --date=iso -- src/sweep/sweepRuns.ts
   # 实测（今天）：**零输出** —— 该文件尚不存在，符合「§6 还没开始」的现状。
   # 落地后这里必须恰好一行，且其日期晚于 (1) 里 §4 那笔合并。
   ```

   **为什么 (3) 用 `--diff-filter=A` 且只针对 `src/sweep/sweepRuns.ts`**：`src/cli.ts` 早有历史（上面 `2026-07-15` 那笔），对它取「第一条提交」必然拿到引导提交；而 `src/sweep/sweepRuns.ts` 是**本层新建的文件**，它的**新增**提交就是 §6 任务组真正的第一笔，没有历史噪声。

   **⚠️ 判据必须能失败才算验收面。** 上面 (2) 的 `--is-ancestor` 退出码在顺序被违反时是 **1**；(3) 在 §6 先落地时会给出一个早于 §4 合并的日期。**若实施时发现这三条里有任何一条又变成恒真，按本条的教训*重写判据*，不要保留一条恒真的命令充数。**

   #### ⚠️ 第三轮的重写**确实可失败了**，但留了两个残余（第四轮评审，Minor，各附实测）

   **先确认好的那一半**：`git merge-base --is-ancestor` 在顺序被违反时确实给 exit 1，**不再是 G4 那种恒真**。这一半保留。

   **残余 (a) —— (2) 会被「同一笔合并」蒙混过关。**

   ```bash
   A=$(git rev-parse HEAD); git merge-base --is-ancestor "$A" "$A"; echo "self_exit=$?"
   # 实测（第四轮）：self_exit=0
   ```

   **`--is-ancestor X X` 退出 0。** 于是若 §4 与 §6 被合进**同一笔** merge（**正是 §11 第 1 条要禁止的那件事**），(2) 会以同一个 hash 自比自己而**通过**。**补一条前置断言：**

   ```bash
   [ "$A4" != "$A6" ] || { echo "§4 与 §6 是同一笔合并 —— 违反 §11 第 1 条"; exit 1; }
   git merge-base --is-ancestor "$A4" "$A6"; echo "exit=$?"   # 必须 0
   ```

   **残余 (b) —— (1) 用 `%ad`（作者日期）比较会误红。**

   ```bash
   git log -1 --format='ad=%ad cd=%cd' --date=iso
   # 实测（第四轮）：ad=2026-08-01 19:55:39 +0800 cd=2026-08-01 19:55:39 +0800
   # —— 本仓库当前两者相同，**但 rebase 会保留作者日期而刷新提交日期，两者随即分叉**。
   ```

   一个**合规**的 §6 分支若在合入前 rebase 过，它的 `%ad` 可能早于 §4 的合并 → **误红**。**处置：把 (1) 与 (3) 的日期比较全部改用 `%cd`（提交日期），或干脆再来一次 `--is-ancestor` 取代日期比较**（后者更强，因为它比的是祖先关系而不是时钟）。**本层推荐后者**：日期比较在任何重写历史的操作下都不可靠，而祖先关系不受 rebase 影响。
8. **`.owner-transfer.transaction.json` 与三份 pending 全部经 temp + rename 发布**（第三轮新增，钉 §4.0.3 与 §4.0.3a 的两次人裁）：四条 rename 路径各由 §10 测试 4d / 4e 承重；任一条退回 `writeJsonFile` 直写，对应子用例必红。**并且 `cleanupOwnerTransferStagingWithoutMarker` 覆盖全部 10 个 staging 路径**（测试 6c），少列一个即在该路径泄漏时变绿。
9. **sweep 的配额、退出码、报告路由与逃生口有验收面**（第四轮新增，补 §10 六条无验收面的测试；**第五波追加第 5 条，承接人裁的路由要求**）。

   **⚠️ 为什么必须新增**：G15 刚用「孤儿验收」裁掉哈希守卫，并立下「§15 的每一条都应当由 §10 的某一条承重」这条配对纪律。**但配对纪律只被单向执行了**——第三轮检查了「验收有没有测试」，没检查「测试有没有验收」。逐条对过之后，**§10 有六条测试完全没有 §15 面**：

   | §10 测试 | 它钉的是哪次改判 | 第三轮的 §15 面 |
   |---|---|---|
   | 5（`finalizeOrder` 承重，手工 stage 置换过的 v2 marker） | F13 的改判（测试 5 曾是同义反复） | **无** |
   | 6a（暂存顺序不变式：reconciliation pending 的 rename 严格先于 marker 的 rename） | F9 ＋ G11 的连带更正 | **无** |
   | **12b（`--max-runs` 承重，含第三子用例）** | **G9 计入时点改判的唯一落点；§12 整节的「有界批准」靠它** | **无** |
   | **12c（`cannot read run artifacts:` 前缀契约）** | **G3 前缀契约改判的唯一落点** | **无** |
   | 13（信号槽置位后不再开下一个 run） | §5.4 改判 B | **无** |
   | 13b（第二次信号 → `exit(130)`，可注入 `registerStopHandlers`） | F34 的拆条 ＋ 逃生口 | **无** |

   **其中 12b 与 12c 承重**：12b 是 §12「有界批准」这条治理表态的唯一钉子，12c 是「前缀字面量是被依赖的契约」这条从注释升级为断言的唯一钉子。**两者失守都不会让任何别的测试红。**

   **本条的内容（第四轮四条 ＋ 第五波第 5 条 = 五条，各自点名承重测试）：**

   1. **配额是按「四道门全过、`resume_adopted` 已追加」计入的**，不是按 `resumeLoop` 返回计入。**测试 12b 的第三子用例承重**（替身先触发 `onAdopted` 再抛出，`--max-runs 1`，三个目录，断言恰好调用 1 次）。**变异：把计数点退回「正常返回时 +1」→ 该子用例必红。**
   2. **拒绝不消耗配额**（因此不会确定性饿死）。**测试 12b 的第二子用例承重。变异：改成「每次调用都计数」→ 必红。**
   3. **`cannot read run artifacts:` 前缀是被依赖的契约**：`resumeLoop.ts:119`/`:120` 与 sweep 的判据必须同笔改动。**测试 12c 承重。变异：改掉那两处前缀字面量而不同步改 sweep 判据 → 必红。**
   4. **逃生口可达且可注入**：第二次停机信号（SIGINT 与 SIGTERM **合并计数**）调用 `exit(130)`。**测试 13b 承重**（`registerStopHandlers(signal, { exit })` 注入假 `exit`）。**变异：改成按信号种类分别计数 → 「先 Ctrl-C 再 kill」这条子用例必红。**
   5. **（第五波新增，钉人裁）`reconciliation_write_abandoned` 必须当场进 sweep 的 stderr，且不得篡改该 run 的 `outcome`。** 达标要求四条同时成立：**(a)** stderr 出现 `note  <path>  reconciliation_write_abandoned  <detail>`；**(b)** 该 run 的 `outcome` 与汇总行的 `errored` 计数**与没发生过时相同**；**(c)** 退出码不变；**(d)** 该 run 随后抛出时备注**仍在** stderr 上。**测试 12d 的四条子用例逐条承重**（(i) 对应 (a)(b)(c)、(ii) 对应 (d)、(iii) 钉 `fileStore` 侧确实调了回调且排在 `appendEvent` 之前、(iv) 钉中间三层的透传）。**变异：退回第四轮的「不路由」→ 12d(i) 必红；把它路由进 `error` 那一格 → 12d(i) 的 (2)(3) 必红；把记录时机改到「`resumeLoop` 正常返回后」→ 12d(ii) 必红；删掉任一段透传 → 12d(iv) 必红。**

      **⚠️ 本条与验收 1b 不重复，分工写死**：1b 钉的是**「该不该放弃这次写」**（判据本身，测试 6f 承重），本条钉的是**「放弃之后有没有人看得见」**（可见性，测试 12d 承重）。**两者可以各自独立地失守**——一个「判据对、回调没接」的实现让 1b 绿而本条红，一个「回调接了、判据写成一律放行 ENOENT」的实现让本条绿而 1b 红。

   **测试 5 / 6a / 13 三条不单列验收，理由写明**：5 与 6a 是验收 8（四条 rename 路径 ＋ 暂存顺序）的组成部分，13 是验收 4（停机不永久终结）的前半；**三条各自已有上位验收，不是孤儿。** 只有 12b / 12c / 13b 是真正悬空的，本条补的就是它们。
10. 全套件、typecheck、build 三者退出 0，且输出**未经任何过滤**地贴出。

## 16. 第一轮修订索引（2026-08-01，三个独立评审员）

初稿的 Critical 级缺陷，逐条对应本文修订处。**本表的第 11 行在第二轮被判定为错误结论，已就地更正（见下面表内注）；其余各行仍然有效。**

| # | 初稿缺陷 | 修订处 |
|---|---|---|
| 1 | 「七条判据」实为**八条** | §3 第 3 条 |
| 2 | 「`runExclusive` 两个生产调用点、在 `runLoopFromState` 内」两头都错，实为**一个**、在 `persistBoundaryAnalysis` 内 | §5.3 |
| 3 | §4.4 选「pending 存在性驱动」会**静默发布降级提交且不可恢复**，且旧测试 4 把该状态断言为正确 | §4.4 **改判为 marker 驱动** |
| 4 | 孤儿 pending / temp 的回收路径（`cleanupOwnerTransferStagingWithoutMarker`、catch 尾）完全不在改动清单里 | §4.3 表、§13 |
| 5 | `stop_requested` 写终态会**永久杀死正在飞行的 run** | §5.4 **改判为不写终态** |
| 6 | 「零写入」声明为假，其测试空洞 | §3 第 2 条、§10 测试 14 |
| 7 | 只引了 `runExclusive` 注释的前半句，而后半句正好禁止本改动 | §5.3 |
| 8 | 裁决记录留给 L3 的问题 1 从未点名 | §4.0a |
| 9 | `parseArgs` 解析不了 `sweep <root> --flag` | §6 改用 `--root` |
| 10 | §4.3 把「排序」当承重论证，实际承重的是两条 epoch 相等判定 | §4.3 |
| 11 | S-3 退路完全遗漏 | §4.0.1–4.0.3 |
| 11b | ~~「更宽不是更窄」只驳倒了裁决记录两条依据中的一条~~ **本行的后半句在第二轮被判定为伪造的论证结构**：裁决记录对「更窄」只给了**一条**依据（`assertHeld` 是写者），**这条成立**；「`newOwnerEpoch` 的排序主张」是裁决记录中一条**独立的否决**，不是「更窄」的依据，是第一轮修订自己造出来再打倒的。**不要把这一行当成「已修好」继承下去。** | §4.0.4（就地更正） |
| 12 | 「先于触发逻辑」的实施顺序强制被漏掉 | §4 节首、§11 |
| 13 | 「无人读 `boundary-analysis.json`」用收窄的 grep 支撑了绝对断言 | §4.5 |
| 14 | 「不加 `-F` 会 exit 2」是抄来的、未跑过的假主张 | §4.6 |
| 15 | 把 L1 §12 的十九条悄悄收窄成六条 | §11 |
| 16 | 测试 1 按字面不可表达；§15 第 1 条「不可构造」为假 | §10 测试 1、§15 验收 1 |

（第 15 行的修订处在第二轮又被改了一次：重点名单从六条扩到八条，「其余十三条」相应变为「其余十一条」——**「十九」这个总数未变**。见 §17 的 F39。）

## 17. 第二轮修订索引（2026-08-01，三个新的独立评审员 + 控制器回代码复核）

**背景**：§16 那一波修复完成后又派了三个错开视角的独立评审员，撞出 47 条；控制器逐条回代码核过承重的那些。**本仓库六轮 100% 命中「修复波自带缺陷」**——第一轮修复新写的 §4.0a 与同文档新写的 §4.1 直接打架（F5），新写的 §4.3 引入了一条比债 1 更糟的永久损坏路径（F6）。**本表是第三轮再评审的清单。**

| # | 级别 | 缺陷摘要 | 修订处 |
|---|---|---|---|
| F1 | Critical | §4.0 伪造裁决记录的论证结构：把「更窄」说成有两条依据、其中 (a) 被驳倒；实际「更窄」只有一条依据且成立，(a) 是另一条独立否决 | §4.0.4、§16 第 11/11b 行 |
| F2 | — | S-3 被命中过一次的过程与解除方式未记录 | §4.0.3 |
| F3 | Minor | 「裁决记录原文」与「本层就地定义的触发条件」版式未分 | §4.0.1 / §4.0.2 拆节 |
| F4 | Minor | §4 节首把两处拼接冠以「原文」 | §4 节首（改写为「两处合起来」，各附定位命令） |
| F5 | Important | 「两次 rename 加三次 safeUnlink」错（实为 2 rename + 5 safeUnlink，另一条路径 4 safeUnlink + 0 rename），且无重推命令 | §4.0a 理由 1 |
| F6 | **Critical** | reconciliation 排第一 + 赢家不补写 ⇒ 输家可**永久**覆盖赢家的 reconciliation（`transferRepresentsPublishedWinner` 的隐含默认被反转 + 裸 `catch { return null }`） | §4.3「排序改判」、§10 测试 6e、§15 验收 1a、**＋ §15 验收 1（把「不可产生该状态」弱化为「不可产生*持久的*该状态」）** —— **第三轮补记**：本行第二轮只记了「新增」，漏记了它**弱化**了一条既有验收；漏记一次弱化比漏记一次新增更危险，因为读者会以为验收 1 从未变过。**并见 §18 的 G1**：本行的修订本身没有关闭 F6，只是收窄了它 |
| F7 | Important | 事务前组装 ⇒ epoch 递增规则被复制成两份生产实现，漂移则债 1 以另一形式复活且无测试会红 | §4.3「组装点改判」、§4.2 表 |
| F8 | Minor | 「必须加上两个新路径」易被读成总数 | §4.3 表（逐个具名，4 → 7） |
| F9 | Important | 「reconciliation pending 严格先于 marker」无任何测试能证伪（测试 4 根本不执行 `writeOwnerTransferArtifacts`） | §10 测试 6a（新增）、测试 6 后半句改指 |
| F10 | **Critical** | marker 用裸 `writeJsonFile` 写；被解析之后截断的 marker 会永久拒绝该 run 的全部路径 | §4.0.3（人已裁定：改原子写）、§4.3 表、§4.4、§10 测试 4d、§13 |
| F11 | **Critical** | §4.4 规则 2/3 制造的「marker 仍在但推不完」状态不在 §15 验收 2 的具名例外里；「可恢复」无机制 | §4.4、§15 验收 2（四条例外全列，撤回「可恢复」） |
| F12 | **Critical** | 「响亮的失败」在实际调用图上不成立——被包成 `ResumeNotEligibleError` → stdout → exit 0 | §4.4、§8 错误表新增一行、~~§9（`cause` 透传）~~ **⚠️ 第四轮补记：`cause` 透传那一半已被第三轮的 G3 整条否决**（方向反了 ＋ `TS2554` ＋ 导出类签名变更），改为按 `cannot read run artifacts:` 前缀在报告层路由。**「§8 错误表新增一行」那一半仍然有效。** 加重情节：**G24 的裁定理由明确引用了 F12**（「`errored` 是 F12 那一行路由改动的必然产物」），说明第三轮读到过这一行却没发现它已被同一轮作废 |
| F13 | **Critical** | 测试 5 是同义反复：同一组常量既生成 marker 又决定顺序 | §10 测试 5（改为手工 stage 置换过的 v2 marker） |
| F14 | **Critical** | 新错误进 `isLeaseStopError` ⇒ 两个既有调用点写 `cancelled`，把 §5.4 论证要防的永久终结从另一扇门放回来 | §5.3「改动 A 与 §5.4 的冲突」（选方案 (a)）、§9、§10 测试 7b/9、§13 |
| F15 | **Critical** | 推翻在先裁定的理由依赖「L3 让窗口可达」，而改判 B 恰恰使它不可达；且「那条裁定成立的前提是……」注释里没有 | §5.3（改写为「`assertHeld` 从不读 `stopped`，该命题没有 home」＋诚实的可达性表态） |
| F16 | Important | 「两侧穷尽」「债 3 关闭」忽略了 span 外的 `assertHeld` + `writeBoundaryArtifacts` | §5.2 范围声明、§13 表与第 3 笔 |
| F17 | Important | 「`stop()` 会清 `leaseAffirmedAt`」是无条件断言，实为被吞的 CAS | §5.4、§15 验收 4、§10 测试 8b（两条子用例） |
| F18 | Important | 停机点在 `attemptsUsed` 递增之前 ⇒ 无字节记录「被停过」，重复停机不消耗配额 | §5.4 ⚠️ 第 1 条（正面接受＋理由） |
| F19 | Important | 「人按过 Ctrl-C」只进 `events.jsonl`，registry 不观测它 | §5.4 ⚠️ 第 2 条（明写刻意放弃区分＋理由） |
| F20 | Minor | 「谓词本身要接受新错误」被降级为隐含 | §5.3（显式三条）、§9（选 (a) 后谓词不改，已写明） |
| F21 | Minor | 「同一信号」vs「SIGINT/SIGTERM」未定 | §5.4（合并计数）、§7 |
| F22 | **Critical** | `--max-runs` 必需，但定义 CLI 形状的五节一次都没提 | §6、§7、§8、§9、§10 测试 12/12b、§12 |
| F23 | Important | §8 outcome 取值域漏 `cancelled` | §8（补入＋5 个生产来源的重推命令） |
| F24 | Minor | 「那个映射」是单数，实为两处 | §7 |
| F25 | Minor | 「十余处直接调用」旁边的命令重推不出它（实测 34 / 17） | §9（改用两条各自重推的 `grep -c`） |
| F26 | Minor | §4.2 立「不接管道」纪律，§9 自己用 `\| wc -l` | §4.2（纪律收窄为「不接会截断输出的管道」＋统一改用 `grep -c`）、§9 |
| F27 | Minor | `scanRootFailureDetail` 从未点名 | §6 流水线、§7、§8 |
| F28 | **Critical** | §3 那条 grep 只扫 `resumeLoop.ts`，看不到 `leaseGate.ts` 的 `lease_expired_observed`；CAS 拒绝路径的文件系统副作用也未列 | §3 第 2 条（五条完整清单） |
| F29 | **Critical** | 「恰好两行、其余字节不变」为假（两种独立机制） | §10 测试 14（fixture 显式化）、测试 14b（新增）、§15 验收 6/6b |
| F30 | Important | 测试 6c 写「三个 pending 与两个 temp」，`.reconciliation.publish.tmp` 泄漏时会变绿 | §10 测试 6c（改为 7 个 staging 路径全列）。**⚠️ 第三轮 G11 因三份 pending 一并原子化把它从 7 重数为 10；常量名也由 `.reconciliation.*` 改为 `.reconciliation-record.*`。本行的 7 是历史值** |
| F31 | Important | 「变异任一条 epoch 判定」——判据 A 只有双转移 fixture 杀得掉 | §10 测试 2（两组 fixture）、测试 6b（分别变异） |
| F32 | Important | 测试 2 的 mock 面漏 `unlink`，做不出步 7 之后的两个间隙 | §10 测试 2 |
| F33 | Important | 「finalize 九步」漏掉 try 之前的 readFile + JSON.parse ——而那正是 §4.4 新逻辑的落点 | §10 测试 2（区间写全＋要求按最终代码重数） |
| F34 | Important | 测试 13 第二个分句按字面不可表达，且一个测试名讲两件事 | §10 测试 13 / 13b（拆开＋`registerStopHandlers` 可注入）、§9 |
| F35 | Important | §15 验收 5 没有任何钉住手段 | §15 验收 5（计数守卫＋哈希守卫＋三条防护栏）。**⚠️ 第三轮 G15 撤销了其中的哈希守卫与三条防护栏，改为计数守卫＋八条变异测试（§10 测试 15）。本行的「修订处」只在计数守卫那一半上仍然有效** |
| F36 | Important | §5.3 明写「接受」的行为退化在 §10 里零断言 | §10 测试 7b（新增）、§5.3 ⚠️ |
| F37 | Minor | 测试 14 伴生断言的「该目录」指代含糊 | §10 测试 14（明写第二个非 eligible 目录为主断言对象） |
| F38 | Important | §11 的实施顺序硬约束在 §15 无验收面 | ~~§15 验收 7（新增，附 `git log` 判据）~~ **⚠️ 第四轮补记：那条 `git log` 判据正是第三轮的 G4 证明*恒真*并整条重写掉的**（指向从未存在过的 `docs/superpowers/reviews/`；对 `src/cli.ts` 取「第一条提交」永远拿到引导提交）。现行判据是 `--merges` ＋ `merge-base --is-ancestor` 退出码 ＋ 对新建文件用 `--diff-filter=A`，见 §15 验收 7 |
| F39 | Important | 重点核查名单漏掉 L1 §12 第 4、6 条，且无选取依据 | §11（名单扩为 8 条＋逐条依据＋「其余十一条」算术同步） |
| F40 | Important | §13 内「1 笔 / 两笔」与 §14 第 1 条的「3」自相矛盾 | §13 术语段、§13 清单、§14 第 1 条（三处联动为 6 项） |
| F41 | Minor | 「锁可被偷」省略了 `hasStagedArtifacts` 这个前提 | §13 第 1 笔（两个前提写全） |
| F42 | Minor | §16 用了不存在的锚点 `§3.3` / `§3.2`（§3 没有小节，只有编号项） | §16 第 1、6 行；**顺带把同一类问题的其余本文档锚点一并规范化**：`§15.1`→「§15 验收 1」、`§15.2`→「§15 验收 2」、`§14.1`→「§14 第 1 条」、`§3.1`→「§3 第 1 条」。**指向 L2 spec 的 `§7.1` / `§12.1` / `§13.1` / `§6.3` / `§14.1` 不动**——那是 L2 自己的编号约定 |
| F43 | Minor | §4.6「必然早退」的理由已被 §4.3 作废 | §4.6（改为「赢家根本不再调用它」） |
| F44 | Minor | 「本层之后 `boundary-analysis.json` 可能缺失」是先于本层的既有事实 | §4.5（引 L2 §13.1 全句） |
| F45 | Minor | `cleanupOwnerTransferStagingWithoutMarker` 只在 `lockHeld` 为真时被调用，测试 6c 的构造依赖它 | §4.3 可达条件、§10 测试 6c |
| F46 | Important | 必需配额 + 确定排序 + 拒绝计入 = 确定性饿死；被拒 run 无收敛机制 | ~~§6（配额**只计实际执行**）~~、§12、§13 第 5 笔。**⚠️ 第四轮补记：「只计实际执行」正是第三轮的 G9 改判掉的**（它依赖「抛出必然发生在 `runLoopFromState` 跑完之前」这条假断言）。现行判据是「四道门全过、`resume_adopted` 已追加之时计入」，经 `onAdopted` 回调，见 §6「计入时点改判」。**「排序/退避的选择与理由」那一半仍然有效** |
| F47 | Minor | 裁决记录里那条假 grep 主张至今未勘误 | §4.6（就地勘误，不改原件）。**⚠️ 第四轮：§4.6a 为它补的「机制」已被实测证伪并重写，见 §4.6a 与 §19 的 M4/M-grep** |

**⚠️ 第四轮对本表的整体补记（I6）：上面三行（F12 / F38 / F46）在第三轮*已被作废或改判*，而第三轮没有回来改它们。** 规律很清楚：**只有当某条 G 行的「修订处」栏点名了 §17 时，第三轮才去动 §17**——G19 / G11 / G15 点了（于是 F6 / F30 / F35 三行被就地补记），**G3 / G4 / G9 没点**（于是 F12 / F38 / F46 三行原样留着一条已死的「修订处」）。

**G19 自己写下的那句话对这三行逐字适用**：「漏记一次弱化比漏记一次新增更危险，因为读者会以为它从未变过。」**这里更糟——读者会以为一条已被否决的改动仍然要落地。**

**本轮立下的规矩**：**每一轮修复波结束前，必须对上一轮索引表做一次「修订处栏是否仍然成立」的回扫**，不依赖「本轮的 G 行有没有点名它」。**§19 已按此回扫过 §18**（结果见 §19 末尾）。

**本轮新增或改判的承重测试**：6a（暂存顺序）、6e（输家不覆盖赢家）、4d（marker 原子写）、7b（被接受的退化）、12b（`--max-runs`）、13b（逃生口）、14b（恢复被断言）。**改判的**：5（`finalizeOrder` 不再同义反复）、6b（两组 fixture）、6c（7 个 staging 路径）、2（mock 面 + 区间 + 两组 fixture）、8b（两条子用例）、9（方向反转）、14（fixture 显式化 + 伴生断言指代）。

**本轮的数字回扫**：全文每一个计数类数字都在本轮被重推过一遍，重推命令就地附在数字旁。**下一轮评审请从「哪个数字旁边没有命令」开始找——本仓库三轮的规律是：附了命令的数字全对，没附命令的地方就是错的地方。**

**⚠️ 上面这条规律在第三轮被破了一次**：唯一一个错的数字（§4 节首「命中 4 行」，实测 3）**恰恰是附了命令的**。**说明贴命令的人没有真跑它。** 规矩因此升级为：**附命令 + 把该命令当时的输出值一并写下**，否则命令只是装饰。§18 的所有数字均按新规矩写。

## 18. 第三轮修订索引（2026-08-01，三个新的独立评审员 + 人的两次裁定）

**背景**：§17 那一波修复完成后又派了三个错开视角的评审员（三处开放设计选择 / 范围蔓延 / 数字与可测性全量回扫），撞出 **16** 条阻塞 ＋ 一批记账类。**本仓库七轮 100% 命中「修复波自带缺陷」，没有一次是实施者自己发现的**——第二轮新写的 §4.3 排序改判没有关闭它要修的缺陷（G1），为它新加的两条「必须红」的变异实测都不会红（G2）。

**⚠️ 「16」在第三轮的原文里写成 12，且没附任何重推命令**（本行与 Status 行两处），恰好违反 §17 末尾第三轮自己升级的规矩。**第四轮就地改对，重推命令与逐行级别见 Status 行下方的引用块**；简述：`grep -nE '^\| G[0-9]' <本文件>`（**行首锚定**，不要用 `-nF '| G'`，那会数到正文里的引用）实测 25 行，Critical 7（G1 G2 G3 G4 G6 G11 G12b）＋ Important 9（G7 G8 G9 G10 G12 G13 G14 G15 G16）＝ **16 条阻塞**，另 Minor 1（G5，判定不成立）＋ 记账 8（G17–G24）。**「6 Critical + 10 Important」这个分拆来自派单口径、与表不符**（差异全在 G12b 是否独立计一行），合计 16 两边一致。

**本轮的失效模式与前几轮不同**：前几轮是「数字错」，本轮数字层几乎全对（唯一一个错的见 G17）。**新的失效模式是「论证链里某一步把非原子的东西当原子用」**——把并发的读写当顺序（G1）、把改 fixture 当变异（G2）、把「不可达分支」当「要守的分支」（G3）。

| # | 级别 | 缺陷摘要 | 修订处 |
|---|---|---|---|
| G1 | **Critical** | §4.3 的排序改判**没有关闭** F6，只是把窗口缩小了。输家的「读→改→写」既不原子也不持锁：读可早于赢家发布任何东西（首发转移 ENOENT → 裸 `catch { return null }` → 保护整个退化为无保护直写），写可晚于赢家的 reconciliation rename。**`finalizeOrder` 排哪个方向都拦不住** | §4.3 新增「上面四步只覆盖…」一节（量化「收窄了多少」＋ 处置一：`readPersistedSuccessfulTransferArtifacts` 的裸 catch 收窄为非-ENOENT fail-closed ＋ 处置二：残余具名传 L5）、§9 模块表、§13 第 4 笔（替换）、§15 验收 1a（就地收窄范围）＋ 新增验收 1b |
| G2 | **Critical** | 为 §4.3 新加的两条「必须红」的变异**实测都不会红**：变异二（删锁文件）会走成「输家替赢家 finalize → 保护*反而*生效 → 两条断言全过」；变异一是「改 fixture 并同步改中断点」，那不是变异、是另写一条测试，违反 §10 通用条。**最承重的改判目前零有效护栏** | §10 测试 6e（整条重写：确定性交错骨架 ＋ 两条只动生产代码的替代变异 ＋ 窗口内断言） |
| G3 | **Critical** | §8 新增的「按 `Error.cause` 路由」**方向是反的**（守的是 §4.4 自己判定不可达的分支，唯一可达的 torn pending 抛 `SyntaxError`、不匹配），**且编译不过**（`ResumeNotEligibleError` 是单参构造，`TS2554`），**且把一个导出类的公开签名变更写成了「catch 里改一行」** | §4.4（放弃这笔生产改动，改按 `cannot read run artifacts:` 前缀在报告层路由）、§8 错误表该行、§9 `resumeLoop.ts` 行、§10 测试 12c（新增） |
| G4 | **Critical** | §15 验收 7 在今天的仓库上**无条件通过**：判据指向从未存在过的 `docs/superpowers/reviews/`（`git log` 对不存在的路径空输出 exit 0），另一条对 `src/cli.ts` 取「第一条提交」永远拿到 2026-07-15 的引导提交 | §15 验收 7（整条重写为 `--merges` ＋ `merge-base --is-ancestor` 退出码 ＋ 对**新建文件** `src/sweep/sweepRuns.ts` 用 `--diff-filter=A`） |
| G5 | Minor | §4.6 / F47 的「就地勘误」被指方向反了，应降级为「未限定 grep 实现」 | **判定不成立**，见 §4.6a：实测该 zsh 函数对 ugrep 显式钉了 `-G`，两个壳给同一答案；决定退出码的是 `-E`/`-P`，不是解析到谁。**勘误方向不变，本轮补的是*机制*** |
| G6 | **Critical** | §10 测试 2 的完整区间**少一格**：§4.4 规则 1 使 finalize 新增一次 marker 的 `readFile` + `JSON.parse`，try 之前是 **4** 次（marker 1 + pending 3）不是 3 次。按字面写出来的测试**恰好跳过 marker 解析那一格**——而那正是规则 3 与测试 4c 唯一的落点 | §10 测试 2（区间改 4 ＋ 「改动前 9 步」补上从代码数出来的重推 ＋ 「改动后 13 步」限定为 v2 专属） |
| G7 | Important | §10 测试 8b(ii) **按字面不可表达**：`updateOwnerRecordWithPrecondition` 从未导出（第一轮「测试 1 不可表达」的同型复发） | §10 测试 8b（改为测试侧改写 `owner-record.json` 让 CAS 真实失配）、§15 验收 4 |
| G8 | Important | §10 测试 14 的 fixture **少第三条前提**：拒绝必须由 `evaluateResumeEligibility` 给出；走 CAS 门会建/删 `.owner-transfer.lock` 并跑一次 `lockHeld: true` 的回收，「其余字节不变」在全树快照下必假 | §10 测试 14（新增「机制三」＋ 三条前提必须被断言） |
| G9 | Important | §6/§12 的配额论证依赖**一条假的绝对断言**：`runLoopFromState` 的 `while (true)` 以 `writeRunState` / `affirmNow` 开头，**两者在任何 try 之外**。第 k+1 轮顶端 ENOSPC → 抛出 → 配额不计，而前 k 次付费调用已经发生 | §6「计入时点改判」（改为门通过、`resume_adopted` 追加之时计入，经 `onAdopted` 回调）、§6 流水线、§9 模块表、§12、§10 测试 12b 第三子用例 |
| G10 | Important | §13 把债 3 归为「部分关闭」错了：裁决记录对债 3 要的是**显式表态**，本层已按可接受方式表了态，**按裁定它是关闭的**；而 span 外那段是**本轮新发现**，不该写成「债 3 的未关闭部分」（会让 L5 以为它已被裁过归属） | §13 表、§13「债 3 的归类更正」（引裁决记录 :189 全句）、§13 第 3 笔（措辞改为「本轮新发现，需重新裁归属」）、§14 第 1 条 |
| G11 | **Critical**（人裁） | §4.0.3 的「S-3 不触发」**结论盖过证据范围**：原子 marker 只消掉 marker 那条路由，torn pending 通向**同一个**永久钉死形态，而本层把它从两份扩到三份 | **人已裁定：三份 pending 一并改原子写，与 marker 逐字同形。** §4.0.3a（新增，含两条路由的完整论证表）、§4.3 表（常量 ~~7~~ **6** 个新增，**第四轮更正，见 §19 的 I10** / cleanup 4→10 / 暂存顺序不变式重写）、~~§4.4（该条从「真实可达」改判为纵深防御）~~ **⚠️ 第四轮补记：「pending 被写坏」那一条改判为纵深防御仍然成立，但同节的「规则 2 不可达」已被第四轮的 I2 推翻——规则 2 因并发恢复而可达，见 §4.4**、§9 模块表、§10 测试 4e（新增）＋ 测试 6c（7→10）、§13（第 4 笔收回，一出一进）、§14 第 1 条、§15 验收 2（四条例外合并为三条）＋ 新增验收 8 |
| G12 | Important | §5.3 方案 (a) 的**三处未声明副作用**：抢掉兜底的「转 `failed` 并落盘」（意图）**和 `cleanupAttemptWorkspaceBestEffort`（未声明）和 `applyPhaseUsage`（未声明）**；且返回的 `state` 与磁盘不一致，所以「与 §5.4 同构」为假 | §5.3（三处逐条声明＋接受理由＋补一次 `writeRunState`）、§10 测试 7b |
| G12b | **Critical** | `RunHeartbeatStoppedError` 与现有两个必须**并列、不得继承**——方案 (a) 的全部安全性建立在 `isLeaseStopError` 的 `instanceof` 不匹配它上 | §5.3（硬约束＋照抄 `fileStore.ts:475` 的「deliberately NOT a subclass」判例）、§10 测试 7b 新增 `instanceof` 断言 |
| G13 | Important | §11 的重点名单里 L1 §12 第 4/6 两条引文**被省略号截断，而被省掉的正是与本层冲突的那半句**（第 4 条的 "and **required**"，而 §15 验收 4 把这次 release 降级为尽力而为） | §11（第 4/6/17 条全句引出＋**Rule 7 裁定：挑第 4/17 条**）、§15 验收 4（重写，TTL 兜底收窄到「所有权已易主」，锁忙/IO 残余具名传 §13 第 3 笔） |
| G14 | Important | §5.4 的停机检查点写成单数，代码两处（`grep -cF 'leaseLoss.lost !== null'` 实测 **2**）；「停机不消耗 `attemptsUsed`」只对循环顶部那一处成立 | §5.4（明写只装 `:981` 一处＋两条理由＋代价）、§10 测试 8（新增 `attemptsUsed` 断言与变异） |
| G15 | Important | §15 验收 5 的哈希守卫是**孤儿验收**（§10 无对应测试条目），两个评审员意见相反 | **Rule 7 裁定：挑「计数守卫 ＋ 八条变异测试」，撤销哈希守卫**（四条理由见 §15 验收 5）、§10 测试 15（新增，含八条判据的行位置与变异表） |
| G16 | Important | §10 测试 9 **没有自有的可失败断言**（`isLeaseStopError` 模块私有），杀伤全借给测试 7b | §9（裁定不导出该谓词）、§10 测试 9（并进 7b，不留空壳；7b 另加一条不依赖谓词可见性的 `instanceof` 断言） |
| G17 | 记账 | §4 节首「命中 **4** 行」实测 **3** ——**本轮唯一一个错的数字，而它偏偏附了命令** | §4 节首（改为 3 并逐行列出 :18 / :33 / :124） |
| G18 | 记账 | §3「resumeLoop 5 个追加点」实测 **6** 个 `appendEvent` 调用点 | §3 第 2 条（改用 `grep -c` 并逐个列出行号与事件类型） |
| G19 | 记账 | §17 的 F6 行只记新增、**漏记它把 §15 验收 1 弱化成了「持久的」** | §17 F6 行（就地补记） |
| G20 | 记账 | `transferRepresentsPublishedWinner` 实为**三条**判定，§4.3 两处只列两条 | §4.3（两处均改为三条，附逐行实测） |
| G21 | 记账 | `hasStagedArtifacts` 看不见第三份 pending | §13 第 1 笔（具名，并说明这是**刻意的不对称**——加进去等于放宽夺锁条件） |
| G22 | 记账 | §9 未说明 `registerStopHandlers` 是否导出（测试 13b 要够得着）；观测 `resumeLoop` 调用次数的缝未定义（测试 10/11/12b/13 都要数） | §9（`registerStopHandlers` 必须导出；`resumeLoop` 作为依赖注入参数，照 `defaultScanDeps` 的既有形状） |
| G23 | 记账 | 新常量命名 `.reconciliation.pending.json` 与既有 `<被暂存产物名>.pending.json` 约定不对齐 | §4.3 表新增「常量命名」一行，全部改为 `.reconciliation-record.*`（附既有五个常量的实测行号） |
| G24 | 记账 | §8 汇总行新增的 `errored` 追不到任何 F 行 | **判定为无害** —— **⚠️ 但第三轮只在这个表格单元格里下了结论，没有按它自己那一波的要求单列一节写依据**（G5 做到了，整节 §4.6a）。**第四轮已补：见下面「§18 附：G24 的判定依据（第四轮补写）」。** 并且**它的来源归属指向的 F12 已被同波的 G3 部分作废**（见 §17 F12 行的第四轮补记），**归属需要改写** |

#### §18 附：G24 的判定依据（第四轮补写，M8）

**第三轮对 G24 下的是「判定为无害」，但把依据压缩进了一个表格单元格。** 本文档同一波对 G5 的要求是「判定某条不成立必须单列一节写依据（跑了什么、输出是什么、为什么）」——**G5 照做了（§4.6a 整节），G24 没有。** 补如下。

**G24 的 finding**：§8 报告汇总行的格式里出现了 `errored` 这个计数项，而 §17 的 47 条 F 行里追不到任何一条引入它的来源。

**跑了什么、输出是什么：**

```bash
F=docs/superpowers/specs/2026-08-01-sweep-and-transactional-continuation-design.md
grep -nF 'errored' "$F"
# 实测 exit 0，命中 2 行（第四轮重跑）：
#   §8 的汇总行格式：`<attempted> attempted, <succeeded> succeeded, <refused> refused,
#                     <errored> errored (quota <consumed>/<N>)`
#   §19 本节的引用
grep -nF 'outcome` 取值域' "$F"
# 实测 exit 0，命中 1 行：§8 报告格式那一段，取值域含 `error`
```

**为什么无害**：`outcome` 的取值域里有 `error`（§8），而汇总行的职责就是把取值域里的每一类数出来。**`errored` 是取值域含 `error` 的必然产物，不是一条独立的设计决定**，因此它「追不到 F 行」不代表它没有来源，只代表它是另一条修订的语法后果。**结论：无害，维持。**

**⚠️ 来源归属改写（第四轮）**：第三轮把它的来源记为 **F12**（「`errored` 是 F12 那一行路由改动的必然产物」）。**F12 的「§9（`cause` 透传）」那一半已被第三轮自己的 G3 整条否决**，所以引用 F12 会把读者引向一条已死的改动。**正确的归属是**：`outcome` 取值域里的 `error` 由 **F12 的「§8 错误表新增一行」那一半** ＋ **G3 改判后的前缀路由**共同确定；**汇总行的 `errored` 计数项归属于 §8 那一行，与 `cause` 透传无关。** **加重情节：G24 的裁定理由明确引用了 F12，说明第三轮读到过那一行，却没发现它已被同一轮作废**——这正是 §17 末尾第四轮新立的「每轮必须回扫上一轮索引表的修订处栏」那条规矩要防的东西。

**本轮新增或改判的承重测试**：4e（三份 pending 原子写）、12c（`cannot read run artifacts:` 前缀契约）、15（八条判据各一条变异）。**改判的**：2（区间 3→4，marker 解析那一格）、6c（7→10 个 staging 路径）、6e（**整条重写**：确定性交错 ＋ 两条只动生产代码的变异 ＋ 窗口内断言）、8（新增 `attemptsUsed` 断言）、8b(ii)（改为 CAS 真实失配）、12b（新增第三子用例）、14（新增第三条 fixture 前提）。**并入其他条目的**：9（并进 7b）。**撤销的**：§15 验收 5 的函数体哈希守卫及其三条防护栏。

**本轮的数字回扫（逐个重推，命令与输出值就地附在数字旁）**：§4 节首 3（原 4，错）、§3 的 6（原 5，错）、finalize try 前 4（原 3，错）、cleanup 10（原 7，因 pending 原子化）、~~常量 7 个新增~~ **← 第四轮更正为 6 个新增（I10）；「7」在任何口径下都不成立，依据见 §4.3 表下方**、`transferRepresentsPublishedWinner` 3 条（原 2，错）、`leaseLoss.lost !== null` 2、`isLeaseStopError` 3 行、`return { ok: false` 8、函数体 28 行、finalize try 内 9 步（改动后 13，v2 专属）、§13 清单 5 笔 / L5 输入 6 项（一出一进，数字未变内容变了）。**下一轮请优先核这三类**：(a) 数字旁边有命令但没写输出值的；(b) 说「所以 X 读到 Y」而两个动作之间隔着 `await` 的；(c) 说「变异 M 会让测试红」而没有逐步走过那条链的。

## 19. 第四轮修订索引（2026-08-01，三个新的独立评审员 + 一次人裁）

**背景**：§18 那一波修复完成后又派了三个错开视角的评审员，撞出 **6 条 Critical ＋ 10 条 Important ＋ 9 条 Minor**，另加一条**关于 `grep` 用法的规矩**（本表末行 M-grep，它不是一条缺陷，是取代此前四种互相矛盾说法的处置）。**表内共 26 行 = 6 + 10 + 9 + 1。****本仓库八轮 100% 命中「修复波自带缺陷」，没有一次是实施者自己发现的。**

**本轮的失效模式**：§18 判定「新的失效模式是『论证链里某一步把非原子的东西当原子用』」——**本轮证明第三轮*自己*在修那条缺陷时又犯了同一个错**（C1：把 `Promise.all` 当快照，而 §4.0a 就在同一份文档里白纸黑字写着它不是）。另一条同样复发：§10 测试 6e 刚立下「不许用终态钉过程」的纪律，**它自己的变异一收尾就用终态钉了过程**（C2）。

**本轮的人裁一次**：§4.3 处置一「放弃这次 reconciliation 写」的可观测面 = **跳过 ＋ 追加一条 `reconciliation_write_abandoned` 事件**（不抛出、也不静默），并要求写清它在 §8 落在哪一格 —— ~~答案是「一格都不落」，已在 §8 表里写成一条显式的「不路由」行。~~

> **⚠️ 第五波回扫作废上面这半句。** 前半（跳过 ＋ 追加具名事件、不抛出、不静默）**维持**；后半（「一格都不落」/「不路由」）**已被人裁推翻**——那条放弃必须路由到 sweep 的 stderr。**落点是一条独立的 `note` 行，不占 `outcome` 那一列的任何一格**（写死见 §8，通道见 §4.3 的第五波人裁一节）。下面 C6 行的「修订处」栏已就地补记。

| # | 级别 | 缺陷摘要 | 修订处 |
|---|---|---|---|
| C1 | **Critical** | §4.3 的「窗口宽度」论证为假：把 `Promise.all` 当快照。`transferRepresentsPublishedWinner` 的三条判定跨两个文件（`:144` 读 transfer、`:145`/`:146` 读 owner-record），而 `readOwnerRecord` 要先 `await recoverInterruptedOwnerTransfer`，两次读之间隔着 3–4 次系统调用。输家只需把两次读落在赢家的 rename#1 与 rename#2 之间（中间隔一整个 `writeJsonFile`），就读到 transfer(N+1) ＋ owner-record(仍是 N) → 判据 B 不成立 → 保护退化。**不需要 spec 声称的那种巧合** | §4.3 新增「⚠️⚠️ 第三轮为这条『买到了什么』写下的量化是假的」一节（撤回第三轮那句量化，**并宣布本 spec 不再做第三次量化**）、§15 验收 1a（补第二条残余时序）、§13 第 4 笔（从一条时序扩为两条）。**Rule 7 冲突：§4.3 与 §10 测试 6e 在第三轮同一波里互相矛盾，本轮挑 §10**（它是对着三条判定逐条走出来的），§4.3 那句撤回 |
| C2 | **Critical** | §10 测试 6e 变异一把一条**损坏轨迹**断言为「终态正确」：「输家写下降级版本 → 随后 P1 的第三次 rename 用真品盖回去 → 终态正确」。**「盖回去」是 harness 强加的顺序，不是系统性质**（骨架规定输家在 P1 的 rename#1 内部同步跑完），生产里没有任何机制保证输家的写早于 rename#3 —— C1 就是排在之后的那半。**与 §4.4 判初稿死刑的理由逐字同形**，并违反 §10 自己刚立的「不许用终态钉过程」 | §10 测试 6e 新增「⚠️ 第三轮为变异一写的收尾断言把一条损坏轨迹断言成了『终态正确』」一节：断言对象改为**「保护判定有没有被求值」**（spy 针对 `owner-transfer.json` 的读是否以 ENOENT 结束），全程落在输家那次 `writeBoundaryArtifacts` 的调用窗口内。**并明写这条断言比第三轮那条弱**——它钉不住「赢家不被覆盖」，因为残余 TOCTOU 未关闭 |
| C3 | **Critical** | 测试 6e 变异二的「rename 0 次」断言**在未变异时就为红**：`writeBoundaryArtifacts` 自己就调 `writeJsonFileAtomically` 两次（`:309` boundary-analysis、`:317` reconciliation），而后者在 `:424` 做 `rename`。所以输家期间**至少 2 次** rename，spec 写 0；变异后也不是它写的 3 次。**两侧数字都错** | §10 测试 6e 新增「窗口内断言的具体形状」一节：断言改为**「没有任何 rename 以事务的三个发布 temp 为源」**（与计数无关）。依据 `buildAtomicTempPath`（`:403`–`:409`）生成的是带进程戳 ＋ 序号的一次性 temp，与三个固定名的事务发布 temp 不可能撞名。**并给出等价替代**（spy `finalizePendingOwnerTransfer` 是否被进入，但它 `:608` 未导出，只能间接观测） |
| C4 | **Critical** | 测试 6e 的变异二是**结构性等价变异**：删掉 `recoverInterruptedOwnerTransfer` `:640` 的 `await pathExists(paths.lockPath)` 合取项，在**四种锁状态下逐格与基线相同**。机制：`tryRecoverStaleOwnerTransferLock` 在 `readFile(lockPath)` ENOENT 时 `:527`–`:528` `return true`，锁可解析且 pid 活时 `:538`–`:540` `return false` —— 那个 `pathExists` 是**纯短路优化** | §10 测试 6e 新增「变异二 —— 第三轮选的那条注入点是结构性等价变异」一节（含四格对照表）。**替代注入点：删掉 `tryRecoverStaleOwnerTransferLock` `:538`–`:540` 的 `if (pid !== null && isProcessActive(pid)) { return false; }`** ——第四轮回代码逐格复核过，`lock=live` 那一格由 `false` 翻成 `true`，而 fixture 就钉在那一格。**并更正它的名字**：它模拟的是「活进程检查被移除」，不是第三轮写的「锁的持有范围被收窄」 |
| C5 | **Critical** | §15 验收 1b 是**孤儿验收**：`grep -nF 'readPersistedSuccessfulTransferArtifacts' <spec>` 命中 12 处，**§10 区间内一次都没有**，而 §9 模块表已把「裸 catch 收窄」列为要落地的生产改动。**这正是 G15 刚用四条理由裁掉哈希守卫的那个失效模式，在同一波以新条目复发，且比验收 5 更糟——验收 5 至少没有配套的生产改动** | §10 **新增测试 6f**（三条子用例：ENOENT-of-`owner-transfer.json` 放行 / ENOENT-of-其它文件不放行 / 非 ENOENT 不放行，各配一条会红的变异）、§15 验收 1b 重写（补落点、补归因要求、达标判据拆成三条） |
| C6 | **Critical**（人裁） | §4.3 处置一「放弃这次 reconciliation 写」的可观测面在第三轮完全未定义 | **人已裁定：跳过 ＋ 追加一条具名事件，不抛出、也不静默。** §4.3 新增「人已裁定（第四轮）」一节（事件类型名 `reconciliation_write_abandoned`、追加位置、detail 形状、`RunEvent.type` 是裸 `string` 故不改类型定义）、~~§8 表**新增一行显式写「不路由」**~~（并写明 `cannot read run artifacts:` 前缀只在 `resumeLoop` 的读侧产生，接不住 fileStore 的写侧 —— **这半句仍然成立**）、§9 模块表、~~§13 第 4 笔（具名交接这个观测缺口）~~。**⚠️ 第五波补记：划掉的两处已被人裁作废** —— §8 那一行改写为一条独立 `note` 行路由到 stderr，§13 第 4 笔那条「cron 不会响」的具名代价整条撤回。**未被作废的部分**：事件类型名、追加位置、detail 形状、`RunEvent.type` 是裸 `string` 故不改类型定义、以及「前缀接不住写侧」那条判定。**新增落点见 §20** |
| I1 | Important | 处置一的 ENOENT 豁免**没有给归因机制**：那个 catch 包住的是三读的 `Promise.all`，ENOENT 可来自 `readOwnerTransferRecordRaw` / `readOwnerRecordRaw` / `finalizePendingOwnerTransfer` 的 `:610`/`:611`。**最自然的实现 `if (e.code === "ENOENT") return null` 会把这些一并放行**，恰好在本改动要关闭的路径上原样保留 fail-open；**§15 验收 1b 复制了同样的措辞，两条断言都会绿** | §4.3 新增「⚠️ ENOENT 豁免必须给归因机制」一节（二选一：按 `error.path` / 把那次读移出 `Promise.all` 单独 try，**本层推荐后者**）、§15 验收 1b 拆成三条独立用例、§9 模块表补上归因要求 |
| I2 | Important | §4.4「规则 2 在生产中不可达」为假：论证只覆盖「谁**写坏** pending」，没覆盖「谁**删** pending」。可达路径：P1 持锁写完 staging 后 SIGKILL → P2 判 pid 死、`:552` `safeUnlink(lockPath)` → P2 进 finalize；**锁已被删**，P3 的 `:640` 合取短路为 false → P3 也进 finalize → P2 先跑完并删掉 marker 与 pending → P3 停在 `:610`/`:611` 读 pending → ENOENT。**一次完全成功的转移会打一次 stderr 告警** | §4.4 新增「⚠️ 规则 2 **可达**」一节（逐环附实测行号 ＋ 两条后果 ＋ 级别定 Important 的理由：一次性、非永久钉死）、§15 验收 2 例外第 3 条（从「三者全部不可达」改为逐条区分）、§18 G11 行的修订处补记。**连带撤回**：§4.4 用「规则 2/3 不可达」作为否决 `Error.cause` 路由的**第 1 条**理由 —— **该理由的前提为假，已撤回**；否决结论由理由 2（`TS2554`）与理由 3（导出类公开签名）独立承重 |
| I3 | Important | §15 验收 5 的八条变异里**至少三条杀不掉**：第 1 条（`!== true` → `=== false`）是等价变异除非 fixture 用非布尔——**而源码那个 `as boolean` cast 正说明它防的就是非布尔，spec 未要求这种 fixture**；第 2 条类型是 `boolean`，任何合法 fixture 下都等价；第 6 条（`!==` → `<`）**被 §10 测试 6b 强制的两组 fixture 都杀不掉** | §15 验收 5 的变异表重写（判据栏改为逐字照抄源码含 cast，新增「第四轮实测判定」列）＋ 新增「⚠️ 八条里有三条的建议变异杀不掉」一节（第 1、2 条改为「整条删掉」＋ 第 1 条另加一条非布尔 fixture 断言；第 6 条给出第三组 fixture 及其五条不许被抢先挡住的约束）、§10 测试 6b 就地更正「判据 B：任何单转移场景都能杀」、**§4.2 表补上抄漏的 `as boolean` cast** |
| I4 | Important | §10 有**六条测试没有 §15 验收面**（5、6a、12b、12c、13、13b）。其中 **12b 是 G9 计入时点改判的唯一落点，§12 整节的「有界批准」靠它**；**12c 是 G3 前缀契约改判的唯一落点**。**G15 立的「验收↔测试配对」纪律只被单向执行了** | §15 **新增验收 9**（四条：配额计入时点 / 拒绝不消耗配额 / 前缀契约 / 逃生口可注入，各点名承重测试与变异），原验收 9 顺延为 10。**并写明 5 / 6a / 13 三条不单列的理由**（各自已有上位验收 8 / 8 / 4）。**⚠️ 第五波补记：「四条」已变为五条**（新增第 5 条「`reconciliation_write_abandoned` 的路由」，承重测试 12d），本行的括注数字就地更正 |
| I5 | Important | §10 测试 14 机制二末句仍写「四个 temp 全部不存在」——pending 原子化后是 **7 个 temp**、合计 **11 个路径**。**并且 §13 那张「改一处必须改四处」的联动清单本身不全**：没列测试 14 机制二，也没列本波新增的 §15 验收 8 | §10 测试 14 机制二（11 个路径逐个具名，分五类列出，并写明 11 = 1 marker ＋ cleanup 的那 10 个）、§13 的联动清单**从四处补到六处**。**「立了清单又漏了清单外那处」是「分类维度立好了、换个范围要原样带过去」那条教训的复发** |
| I6 | Important | §17 索引里 **F12 / F38 / F46 三行已被第三轮作废、无一补记**：F12 的「§9（`cause` 透传）」被 G3 整条否决；F38 的「附 `git log` 判据」正是 G4 证明恒真并重写掉的；F46 的「配额只计实际执行」正是 G9 改判掉的。**规律：只有当某条 G 行的「修订处」点名了 §17 时才去动 §17**（G19/G11/G15 点了，G3/G4/G9 没点）。**加重情节：G24 的裁定理由明确引用了 F12** | §17 的 F12 / F38 / F46 / F47 四行就地补记 ＋ 表末新增「第四轮对本表的整体补记」，**并立下新规矩：每一轮修复波结束前必须对上一轮索引表做一次「修订处栏是否仍然成立」的回扫，不依赖本轮的 G/C 行有没有点名它** |
| I7 | Important | §11 的 Rule 7 裁决一漏披露一条**本层扩大**的路径：`stop()` → `releaseOwnerLease`（`:769`）→ `updateOwnerRecordWithPrecondition`（`:720`）**内部在 `:729` 跑一次持锁恢复，且不在任何 catch 内**；本层给这次恢复加了第三个参与文件、一次 marker 的 `readFile` ＋ `JSON.parse`、以及规则 2/3 两条新的具名抛出。任一抛出 → release 失败 → `stop()` 吞掉 → **L1 §12 第 17 条的 "immediately" 退化成 "TTL 之后"**。§4.0.3a 对同类扩大记了账，这处没记，**而它落在常驻禁令第 17 条上**（且 I2 刚推翻了规则 2 的不可达） | §11 裁决一新增「⚠️ 但『本层一个字节不改 `stop()`』不等于『本层不扩大这条路径的失败面』」一节（逐环附实测行号）、§13 第 3 笔的「附带一笔同类的残余」**从两类扩为三类**，第三类明标「不是先于本层，是本层扩大的」 |
| I8 | Important | §11 的 Rule 7 裁决二（撤哈希守卫）**结论对，理由 2 与理由 4 要重写或撤回**：理由 2（孤儿验收）与理由 3（无关字节变化误红）**逐字适用于被保留下来的计数守卫**（计数守卫在 §10 里同样没条目；`prettier` 换行会让 `grep -c` 掉到 7）——**用一把尺子量了对手、没量自己**；理由 4 的「严格更宽」是断言不是证明，**已被 I3 证伪**（八条里三条杀不掉，而哈希守卫会 trivially 抓到那三次编辑）。裁定文本还留了一条**不对称的门** | §15 验收 5 的四条理由重写：理由 1 保留（结构性，与 §10 通用条同源）；**理由 2 撤回**（改为把配对纪律扩到全部验收，见 I4）；理由 3 保留并**补一条对称的自我审查**（说明计数守卫的误红形状「可判定且易修」才是保留其一的真实依据，撤回「假阳性远多于真阳性」这条没测过的比较）；**理由 4 撤回**（改为「覆盖面互有出入」）；**新增理由 5：补上对称的门——任何一条变异被实测证明存活时必须就地写下补法或明写「暂无补法」** |
| I9 | Important | 「12 条阻塞」应为 **16**，出现在 Status 行与 §18 背景段两处，**且两处都没有重推命令**——恰好违反 §17 末尾第三轮自己升级的规矩 | Status 行与 §18 背景段就地改为 16 ＋ 附命令 ＋ 附逐行级别。**并更正分拆**：`grep -nF '\| G'` 实测 25 行，**Critical 7 ＋ Important 9 = 16**；「6 + 10」这个分拆来自派单口径、与表不符（差异全在 G12b 是否独立计一行）。**错误来源是 handoff 的 Executive Summary 与控制器派单，不是第三轮的实施者** |
| I10 | Important | 「新常量 **7** 个」与它自己下一行的枚举（**6** 个）矛盾：2（发布面）＋ 4（原子写 temp）= 6；同一张表的 cleanup 行自己写「新增 **6** 个逐个具名」，而 4 + 6 = 10 正是全文联动的那个 10。**另：既有常量实测 5 个（`:326`–`:330`），落地后总数 5 + 6 = 11，「7」在任何口径下都不成立** | §4.3 表改为 6 ＋ 表下方新增三条依据 ＋ 就地留痕错误来源（**第二轮 F8 的「4→7」是常量*总数*，第三轮重列枚举后标签没改**）、§18 G11 行的修订处、§18 末尾回扫行 |
| M1 | Minor | §5.3 的硬约束不充分：只写「并列且非子类」漏了抛出点。若将来有人让 `assertHeld` 也抛这个错，它会落进 `:1001` 的内层 catch → `isLeaseStopError` 不匹配 → 掉进 `:1005` 的 `infraRetryUsed` 分支 → 第二次直接 `persistTerminalState(..., "blocked_waiting_human", ...)`（`:1011`），**§5.4 要防的永久终结从第三扇门回来** | §5.3 硬约束下方新增一节（附 `:704`/`:1109`/`:1141`/`:1001`/`:1353` 的实测定位与 `sed -n '1000,1018p'` 的原始输出）。**硬约束改写为「并列且非子类，*并且* 只从 `runExclusive` 抛出、绝不从 `assertHeld` 抛出」**，并写明两半分别守 `:1353` 与 `:1001`、测试 7b 的 `instanceof` 断言只覆盖第一半。**⚠️ 对第三轮报告的一处更正**：第三扇门写的终态是 `blocked_waiting_human` 不是 `cancelled`，**后果同构**（它同样不在 `RESUMABLE_STATUSES` 内） |
| M2 | Minor | §6 那句「`--max-runs` 界的是付费调用次数」过头：它界的是**进入 `runLoopFromState` 的 run 数**，每个 run 内部 `while (true)`（`:973`）还能跑到自身 `maxAttempts`，**付费上界是 `N × maxAttempts`** | §6 第 1 条与 §12 各补一段（附 `while (true)` 与 `maxAttempts` 的实测）。**「有界批准」仍然成立**（两条界都有限），**但横幅里的 N 不等于付费次数**，这个读法被明确标为错误。**不改横幅格式**，理由：加乘积会把 per-contract 的 `maxAttempts` 提到 sweep 层，而 sweep 打横幅时还没读任何 contract |
| M3 | Minor | `releaseOwnerLease` 的行号写 `:768`，实测 `:769` 签名、`:770`–`:775` 转调，整体位移 1 | §10 测试 8b 就地改正 ＋ 写明这是「附了命令、写了输出值，但输出值是抄的不是跑的」的又一实例。**规矩再升一级**（已进 §11）：**改动带「实测」字样的行时必须重跑那条命令，不重跑就不许保留「实测」二字** |
| M4 | Minor | §4.3「组装点改判」那条注释「不加 `-r` 对目录取 exit 2」在本壳实测是 **exit 1**（`/usr/bin/grep` 才是 exit 2）。**并且这条命令当场证伪了 §4.6a 的全称命题**——目录参数这一类里退出码恰恰只由解析到谁决定，与方言无关 | §4.3 组装点那条命令改为 `-rnF` ＋ 附两条对照实测 ＋ 写明「`-r` 仍不可省，但理由是『零命中』不是『exit 2』」。**§4.6a 的全称命题据此撤回**，见下面 M-grep |
| M5 | Minor | 测试 6d **成立**（三个评审员独立同结论；第三轮实施者的担心不成立），**唯一缺陷是没写基线快照点** | §10 测试 6d 新增结论段（附 `:311` 条件跳过与 `:424` rename 换 inode 的实测）＋ **明写基线 `stat` 必须紧贴 `writeBoundaryArtifacts` 调用前、断言 `stat` 紧贴调用后**，否则快照取在 `persistBoundaryAnalysis` 之前会因夹着事务本身那次发布 rename 而**无条件红** |
| M6 | Minor | §15 验收 7 重写后**确实可失败了**，但两个残余：(a) `--is-ancestor X X` 实测 exit 0，若 §4 与 §6 合进同一笔 merge（正是 §11 要禁的）会以同一 hash 自比自己而通过；(b) 用 `%ad`（作者日期）比较，**rebase 保留作者日期而刷新提交日期**，一个合规的 §6 分支也可能误红 | §15 验收 7 新增「⚠️ 第三轮的重写确实可失败了，但留了两个残余」一节：(a) 补一条 `[ "$A4" != "$A6" ]` 前置断言（附 `self_exit=0` 的实测）；(b) 日期比较改用 `%cd`，**或干脆再来一次 `--is-ancestor` 取代日期比较**（本层推荐后者：祖先关系不受 rebase 影响） |
| M7 | Minor | `grep -nF 'file:' src/registry/observeFields.ts` 实测 **4 行**（`:7` `:29` `:45` 三个观测文件 ＋ `:111` `return { file: spec.file, fields }`），spec 三处只写「实测 3 个观测文件」，**没写命令的原始输出**。结论正确，但按升级后的规矩这是「写了解读、没写输出值」 | §5.4 与 §6 两处就地改为贴 4 行原始输出 ＋ 保留「观测文件是 3 个」这个结论。**（第三处即 §5.4 内的重复引用，已随之一并改）** |
| M8 | Minor | G24 只在表格单元格里下了「判定为无害」，**没有按第三轮自己的要求单列一节写依据**（G5 做到了，整节 §4.6a）。且它的来源归属指向已被同波作废的 F12 | §18 表后新增「§18 附：G24 的判定依据（第四轮补写）」整节（跑了什么、输出是什么、为什么无害）＋ **来源归属改写**（归 §8 那一行，与 `cause` 透传无关） |
| M9 | Minor | 第三轮用「先于本层 ⇒ 不在范围」驳回 `readPersistedReconciliationRecord` 的 `catch { return undefined }`。**结论成立但理由不成立**——同一波的人裁刚好推翻了这条判据（三份 pending 也先于本层，照样被收回自修） | §4.3 处置一就地换成三条能承重的依据：(a) L1 §12 第 7 条的原文范围是 owner record ＋ 租约门，不含该文件；(b) 该文件由 `writeJsonFileAtomically`（`:418`，temp+rename）发布，截断态不可达；(c) 即便可达，`undefined` 会命中 `shouldSynthesizeSuccessfulReconciliation`（`:150`–`:159`）合成赢家视图。**并对「本层新建了对这次吞咽的依赖，是否该具名进 §13」这条自行判定：采纳，但不单开一笔**，理由写明——它是第 4 笔那条 TOCTOU 的**前提条件**而非独立缺陷，单开会让 §13 的条数与三处联动数字再动一次，收益不抵成本。**已作为第 4 笔的「附带交接」写下** |
| M-grep | Minor（规矩） | 本仓库的 `grep` 是 Claude Code 二进制伪装成 ugrep（`declare -f grep` 可见 `ARGV0=ugrep "$_cc_bin" -G …`）。**四轮出现了四种互不相容的机制解释**，而第四轮在**同一个壳、同一次会话**里对同一条命令测到 exit 2，**与第三轮 §4.6a 就地记录的 exit 0 直接矛盾** | §4.6a **整节重写**（贴 `type grep` / `declare -f grep` / 三条证伪实测的原始退出码）＋ §4.6 的勘误性质改写（**既不判裁决记录那条真、也不判假，而是判定「它依赖的观测不可复现，不予采信」**）＋ §11 新增五条 `grep` 规矩。**G5 的结论（那条 finding 不成立）维持，但它的论证重写**——改用「裸符号名不唯一」这条与退出码完全无关的理由。**全文非 `-F` 的重推命令已批量改为 `-F`；确实需要正则的 6 条改为 `-E` 并逐条标注「只看输出行，退出码不作为论据」** |

**本轮新增或改判的承重测试**：**6f（读侧收窄的双向承重，三条子用例）**。**改判的**：6b（「判据 B 任何单转移场景都能杀」就地更正）、6d（补基线快照点 ＋ 写下成立结论）、6e（**变异一改断言对象、变异二换注入点、窗口断言换形状**）、14（机制二从 8 个路径改为 11 个）、15 ／ §15 验收 5（三条等价变异各给补法）。**新增的验收**：§15 验收 9（sweep 的配额/退出码/路由/逃生口，**第四轮四条；第五波追加第 5 条，见 §20**）。**撤回的论证**（结论未变，理由换掉）：§4.4 否决 `Error.cause` 的理由 1、§15 验收 5 的理由 2 与理由 4、§4.6/§4.6a 的全部退出码理由、§4.3 处置一对 `readPersistedReconciliationRecord` 的驳回理由。

**本轮的数字回扫（逐个重推，命令与输出值就地附在数字旁；下面每一个都在本轮真跑过一次）：**

| 数字 | 命令 | 本轮实测输出 | 与第三轮相比 |
|---|---|---|---|
| 阻塞条数 16 | `grep -nE '^\| G[0-9]' <spec>`（**行首锚定**） | 25 行；Critical 7 ＋ Important 9 ＋ Minor 1 ＋ 记账 8 → **阻塞 = 7 + 9 = 16** | **原 12，错**（且分拆「6+10」也与表不符）。**⚠️ 这一格最初写的是 `grep -nF '\| G'`，实测 30 行——它会数到正文里对自己的引用。已改为行首锚定** |
| 新常量 6 个 | §4.3 表下方三条依据 | 2 + 4 = 6；既有 5 个（`:326`–`:330`）；总数 11 | **原 7，错** |
| `releaseOwnerLease` `:769` | `grep -nF -A8 'export async function releaseOwnerLease(' src/persistence/fileStore.ts` | `:769` 签名、`:770`–`:775` 转调 | **原 :768，位移 1** |
| `observeFields` 4 行 | `grep -nF 'file:' src/registry/observeFields.ts` | `:7` `:29` `:45` `:111` | **原只写解读「3 个」，无输出值** |
| `runExclusive` 1 个调用点 | `grep -rnF 'runExclusive(' src/` | `runLoop.ts:763` | 不变 |
| `persistBoundaryAnalysis` 3 行 | `grep -nF 'persistBoundaryAnalysis' src/controller/runLoop.ts` | `:704` 定义、`:1109`、`:1141` | 不变 |
| `return { ok: false` 8 | `grep -cF 'return { ok: false' src/controller/resumeLoop.ts` | 8 | 不变 |
| `appendEvent(` 6 | `grep -cF 'appendEvent(' src/controller/resumeLoop.ts` | 6 | 不变 |
| `leaseLoss.lost !== null` 2 | `grep -cE 'leaseLoss.lost !== null' src/controller/runLoop.ts` | 2 | 不变 |
| `isLeaseStopError` 3 行 | `grep -nF 'isLeaseStopError' src/controller/runLoop.ts` | `:105` `:1001` `:1353` | 不变 |
| L1 §12 的 21 行 | `grep -nE '^[0-9]+\. \*\*' <L1 spec>` | 21 | 不变 |
| `-E` 重推命令 6 条 | `grep -nE "^ *grep -nE '" <spec>`（**列出、不计数**） | **7 行**，其中 1 行是 §4.6 保留的历史观测，**重推命令是其余 6 条**（**刻意不记本文档自身的行号**，理由见 §11） | 本轮新增。**⚠️ 这一格先后用两种计数命令写成 8 / 11 / 12 / 8，四次都被本轮更晚的编辑作废（按模式串计数会数到自己）；改为「列出」后又因记录了本文档自身行号而再腐坏一次。最终形态：列出 ＋ 不记自身行号。已就地留痕，见 §11** |
| §13 清单 5 笔 / L5 输入 6 项 | — | **不变**（本轮没有一出一进，第 3 笔与第 4 笔各**扩写内容**但不增减条数） | 不变 |

**⚠️ 本轮明确*没有*重推、因此不得当作已核实的数字**：finalize try 前 4 次 / try 内改动前 9 步 / 改动后 13 步 / cleanup 4→10 / `transferRepresentsPublishedWinner` 3 条中的 `:144`–`:146` 行号 / `writeOwnerTransferArtifacts` 在 tests 里的 17 与 34 / 函数体 28 行。**它们在第三轮附了命令与输出值，本轮未逐条重跑**（本轮的改动没有触及它们所在的那几行）。**下一轮请从这一格开始。**

**下一轮请优先核这四类**（前三类沿用第三轮，第四类是本轮新增）：

1. 数字旁边有命令但没写输出值的，**以及写了输出值但那次改动没重跑命令的**（M3 的形状）。
2. 说「所以 X 读到 Y」而两个动作之间隔着 `await` 的（C1 的形状 —— **它在第三轮修完之后又复发了一次，说明这一类不会因为被点名一次就消失**）。
3. 说「变异 M 会让测试红」而没有逐格走过控制流的（C4 的形状 —— **等价变异不会因为换 fixture 而暴露，必须逐格对照基线**）。
4. **一条断言钉的是过程还是终态**（C2 的形状 —— §10 测试 6e 在同一节里立了纪律又破了它）。**判据：如果把 harness 强加的执行顺序换掉，这条断言还成立吗？不成立就是终态断言冒充过程断言。**

## 20. 第五波修订索引（2026-08-01，一次人裁，非评审轮）

**背景**：**本波不是第五波评审，没有评审员，只有一条人裁。** 人**推翻了第四轮对同一件事的后半段判断**：§4.3 处置一放弃 reconciliation 写时追加的 `reconciliation_write_abandoned` 事件，第四轮实现成「落盘但不路由」（理由是路由需要新的跨层接口、按 Rule 2 超出最小解），并把「cron 的『有 stderr 即告警』不会为它响」写成一条具名代价交接给 L5。**人裁：不接受，必须路由到 sweep 的 stderr。**

**本波的范围硬边界**：只做路由这一件事及其连带面。**代码一行未动**（本波只改这一份 spec）。

| # | 条目 | 处置 | 落点 |
|---|---|---|---|
| H1 | **人裁**：`reconciliation_write_abandoned` 必须路由到 sweep 的 stderr | 推翻第四轮的「不路由」 | §4.3 新增「⚠️ 人已裁定（第五波，推翻第四轮）」整节（四步：先核能不能不新建通道 → 两种通道形状 → 逐层签名表 → 落点写死）；Status 行 |
| H2 | **先核「能不能就地派生」**（人的硬要求：不许直接假设必须改签名） | **不能**，两条独立理由各附实测：(1) sweep 报告层今天的两路输入（`ScanRow` / `resumeLoop` 的返回值与抛出）都不携带它 —— `OBSERVED_FILES` 只有 3 个观测文件、无 `events.jsonl`，`resumeLoop` 返回 `RunState` 而人裁本身规定这条不改终态；(2) **时序不对** —— §6 的流水线是「先扫一次、再顺序续跑」，扫描早于执行，靠扫描看见它必须在续跑后**再扫一次**，既违反 §3 第 1 条也不是「就地派生」 | §4.3 的「第一步」 |
| H3 | **通道形状二选一**：上行（改返回值）vs 下行（可选回调） | **选下行回调**。否决上行的三条理由，第三条决定性：`runLoopFromState` 的 `while (true)` 顶端两个 `await`（`:974` / `:977`）不在任何 try 内，**一旦抛出返回值不存在，上行方案携带的信息随之蒸发** —— 而那正是最需要 stderr 的时刻 | §4.3 的「第二步」；§10 测试 12d 子用例 (ii) 把这条理由做成了护栏变异 |
| H4 | **跨层通道逐层写死**（四层，全部是新增可选项，返回类型一个字节不改） | `writeBoundaryArtifacts` 加第三个可选参数（`Promise<void>` 不变，回调排在 `appendEvent` **之前**）→ `persistBoundaryAnalysis` 加第五个可选参数（`:1141` 须补 `undefined`）→ `runLoopFromState` 搭 `stopRequested` 的同一个可选参数对象 → `resumeLoop` 的可选参数对象从 2 键扩为 3 键 → `sweepRuns` 传闭包。**回调不得抛出，且刻意不包 try/catch**（包了就是静默吞，违反 Rule 12） | §4.3 的四层表；§9 模块表四行（`sweepRuns` / `resumeLoop` / `runLoop` / `fileStore`）＋ 签名爆炸半径 ⚠️ 下方新增一段。**⚠️ 第六波补记（不作废，是补一格）**：同一个块里的 `appendEvent` **必须 swallow**（第六波 C-appendEvent），本波把它漏了 —— 于是「回调不抛」和「`appendEvent` 不抛」这两件危险同构的事被一个判成契约、一个没管；本波也**没写为什么两者处置相反**，该理由第六波已补进 §4.3 |
| H5 | **落在 sweep 报告的哪一格 —— 写死** | **不是 `error`，也不新增 `outcome` 取值**（`outcome` 是 per-run 终局，与这条事件正交；一个 `succeeded` 的 run 照样能产生它）。落点是**一条独立的 stderr 备注行** `note  <path>  reconciliation_write_abandoned  <detail>`，~~紧跟该 run 的报告行之后~~。**退出码不变、汇总行格式不变** | §8 表那一行整条改写 ＋ 其下 ⚠️ 段整条改写（三个要点）。**⚠️ 第六波部分作废**：划掉的「紧跟该 run 的报告行之后」是一条**跨 stdout/stderr 的顺序承诺，Node 不保证**，既不可断言也不可依赖 —— 已降级为「同一次 sweep 内各条 `note` 行之间保持遍历顺序」（单流内可验证）。**另补一格本波漏掉的**：`detail` 取 `String(error)`、可含换行，打印前须折成单行，否则「一次调用产生一行」在实际输出上不成立 |
| H6 | **不复用 `cannot read run artifacts:` 前缀** | 维持第四轮的判定（该前缀只在 `resumeLoop` 读侧的 `Promise.all` catch 产生，接不住 `fileStore` 的写侧），**但不再以它作为「所以不路由」的论据** | §8 第二个要点；§4.3 第四步 |
| H7 | **§13 第 4 笔的具名代价撤回** | 「cron 不会因这件事响」已不成立，整条从交接清单删除。**它当时被并进第 4 笔而非单开一笔，所以撤回不改变条数**：§13 清单仍 5 笔、L5 输入仍 6 项，三处联动数字均不变 | §13 第 4 笔的「附带交接」从**两件**改为**一件** ＋ 新增撤回说明 |
| H8 | **连带撤回第四轮的一条类比** | 第四轮写「与 §5.4 对『人按过 Ctrl-C』的处置是同一个已知缺口，理由也相同」——**不同**：§5.4 那条是**跨进程**可见性（本次 sweep 其实看得见停机，看不见的是下一次），只能靠磁盘契约；本条是**同一次 sweep、同一进程内**的可见性，进程内回调就够。**是这句错误归类把第四轮引向了「只能等 L2/L5」的结论。** §5.4 第 2 条本身不受影响，原样保留 | §4.3 第一步末尾的 ⚠️；§13 第 4 笔的撤回说明 |
| H9 | **新增承重测试 12d**（四条子用例） | (i) 路由发生且不污染 `outcome`／(ii) 一次后续抛出不得吞掉备注（**这条是否决上行方案那条理由的护栏**）／(iii) `fileStore` 侧确实调了回调、且排在 `appendEvent` 之前／(iv) **中间三层的透传**。**(iv) 不许省**：(i)(ii) 用替身 `resumeLoop`、(iii) 直接调 `fileStore`，三条都绕开中间三层，少了 (iv) 一次「参数加了但忘记往下传」会让前三条全绿 | §10 sweep 组新增 12d。**⚠️ 第六波两处部分作废**：(1) **(iv) 的驱动 fixture 作废** —— 本波写的「复用测试 5 / 6e 的磁盘状态」在那个盘面上 abandon 根本不会发生（三读全成功 → 走保护判定），(iv) 在正确实现上也红；已换成「`owner-record.json` 合法 ＋ `owner-transfer.json` 坏 JSON」并附四条 fixture 约束。(2) **(iii) 那条排序变异作废** —— `appendEvent` 改为 swallow 之后「两者顺序对调」成了等价变异，承重变异换成「删掉 swallow 的 try/catch」。**(3) 未作废但被更正**：本波那句「本条的断言**全部**钉终态」为假，(iii) 与 (iv) 都不是终态断言，已改成分条限定 |
| H10 | **新增验收面** | §15 验收 9 从四条变**五条**（第 5 条四项达标要求 ＋ 四条变异，逐条点名 12d 的子用例）；§15 验收 1b 补上路由要求 ＋ 一条「事件已落盘 ≠ 达标」的 ⚠️ | §15 验收 1b、验收 9 |
| H11 | **验收 9 第 5 条与验收 1b 的分工写死**（防重复／防冲突） | 1b 钉**「该不该放弃这次写」**（判据，测试 6f）；验收 9 第 5 条钉**「放弃之后有没有人看得见」**（可见性，测试 12d）。**两者可以各自独立失守**：「判据对、回调没接」让 1b 绿而第 5 条红；「回调接了、判据写成一律放行 ENOENT」反之 | §15 验收 9 第 5 条的 ⚠️；§10 测试 6f 末尾新增的 ⚠️ |
| H12 | **§19 回扫**（按 §19 I6 立的规矩：每一轮修复波结束前回扫上一轮索引表的「修订处」栏） | **三行被本波部分作废，已就地补记**：§19 的「本轮的人裁一次」段（后半句「一格都不落 / 不路由」划掉）、**C6 行**（「§8 表新增一行显式写『不路由』」与「§13 第 4 笔具名交接观测缺口」两处划掉，其余维持）、**I4 行**（「验收 9 四条」→ 五条）。**另一处非作废的更新**：§19 末尾「本轮新增或改判的承重测试」段对验收 9 的括注 | §19 |

**本波未作废、明确维持的第四轮结论**（逐条点名，防止下一位读者以为整条 C6 被推翻）：事件类型名 `reconciliation_write_abandoned`、追加位置（`writeBoundaryArtifacts` 内、在放弃 `:317` 那次写之前）、`detail` 携带 `String(error)`、`RunEvent.type` 是裸 `string` 故不改任何类型定义、**不抛出**、`boundary-analysis.json` 那次写照常发生、以及「`cannot read run artifacts:` 前缀接不住写侧」这条判定。

**本波的数字回扫**（每一个都在本波真跑过一次，命令与输出值就地附在数字旁）：

| 数字 | 命令 | 本波实测输出 | 与第四轮相比 |
|---|---|---|---|
| `OBSERVED_FILES` 观测文件 3 个 | `grep -nF 'file:' src/registry/observeFields.ts` | 4 行：`:7` `:29` `:45` `:111`（`:111` 是返回构造） | 不变 |
| `writeBoundaryArtifacts` 返回 `Promise<void>` | `grep -nF -A7 'export async function writeBoundaryArtifacts(' src/persistence/fileStore.ts` | `:302` 签名、`:303` runDir、`:304`–`:307` artifacts、**`:308` `): Promise<void> {`** | **本波新增** |
| `writeBoundaryArtifacts` 生产调用点 1 个 | `grep -rnF 'writeBoundaryArtifacts(' src/` | 2 行：`runLoop.ts:845` 调用、`fileStore.ts:302` 定义 | **本波新增** |
| `writeBoundaryArtifacts` 测试里的两参调用 11 处 | `grep -cF 'writeBoundaryArtifacts(runDir, {' tests/persistence/fileStore.test.ts` | 11 | **本波新增**（与 §4.3「爆炸半径」一节列的 11 行一致） |
| `persistBoundaryAnalysis` 3 行 | `grep -nF 'persistBoundaryAnalysis' src/controller/runLoop.ts` | `:704` 定义、`:1109`（传 4 实参）、`:1141`（传 3 实参） | 不变 |
| `runLoopFromState` 6 参 | `grep -nF -A8 'export async function runLoopFromState(' src/controller/runLoop.ts` | `:953`–`:959` 六个形参（`:958` `:959` 已有默认值）、`:960` `): Promise<RunState> {` | **本波新增** |
| `resumeLoop` 2 参 | `grep -nF 'export async function resumeLoop(' src/controller/resumeLoop.ts` | 1 行：`:87 export async function resumeLoop(runDir: string, adapter: RuntimeAdapter): Promise<RunState> {` | **本波新增** |
| `resumeLoop` 调用点 14 个 | `grep -rnF 'resumeLoop(' src/ tests/ \| grep -vF 'export async function' \| grep -cF 'resumeLoop('` | 14 | **本波新增**（12 `resumeLoop.integration.test.ts` ＋ 1 `leaseLifecycle.integration.test.ts` ＋ 1 `src/cli.ts:130`） |
| `ScanRow` 的构成 | `grep -nF 'export type ScanRow' src/registry/scanRuns.ts` | `:17 export type ScanRow = RunObservation \| ScanIssue;` | **本波新增** |
| `cannot read run artifacts` 3 行 | `grep -rnF 'cannot read run artifacts' src/ tests/` | `resumeLoop.ts:119`、`:120`、`tests/cli/cli.test.ts:73` | 不变 |
| **cleanup 的 10 个 staging 路径 / 六处联动** | 见 §13 的联动清单 | **本波一处都没动**（六处逐个复核过仍写 10，见下） | 不变 |
| **§13 清单 5 笔 / L5 输入 6 项** | — | **不变**（H7 撤回的是第 4 笔内部的一条「附带交接」，不是一笔） | 不变 |

**⚠️ 本波明确*没有*重推、因此不得当作已核实的数字**：§19 那一格列的全部（finalize try 前 4 次 / try 内 9→13 步 / cleanup 4→10 / `transferRepresentsPublishedWinner` 的 `:144`–`:146` / `writeOwnerTransferArtifacts` 在 tests 里的 17 与 34 / 函数体 28 行），**外加本波未触及的**：`return { ok: false` 的 8、`appendEvent(` 的 6、`isLeaseStopError` 的 3 行、L1 §12 的 21 行、`-E` 重推命令 6 条。**下一轮请从 §19 那一格开始，本波没有替它做。**

**关于 `grep` 退出码**：本波按 §11 的规矩，**没有写任何依赖退出码的新论证**，全部锚点用 `-F`。本波开工时实测 `type grep` 的输出是 **`grep is a shell function from /Users/biran/.claude/shell-snapshots/snapshot-zsh-1785583056984-suirbu.sh`**，与 §4.6a 第四轮记录的一致；**§4.6a 那一节本波一个字节未改，也不再对该机制补任何解释。**

**下一波请优先核这五类**（前四类沿用 §19，第五类是本波新增）：

1.–4. 同 §19 末尾四条，原样沿用。
5. **一条「最小解」的判定是不是把「接口不存在」当成了「接口不该存在」。** 第四轮否决路由的理由是「需要新的跨层接口 ⇒ 超出 Rule 2 的最小解」，**而实际的最小解是四个可选参数、零破坏性改动、零新增磁盘契约** —— 同一份文档里 `onAdopted` 早就走过一模一样的形状（§6：「回调把这件事留在进程内」）。**Rule 2 是「不许上更大的解」，不是「不许上任何解」；把它用成后者，代价是把一条本层能兑现的保证写成了交接给 L5 的债。**

## 21. 第六轮修订索引（2026-08-02，一轮定向评审 ＋ 一次注入实验）

**背景**：第五波（§20）落地后的一轮定向评审撞出 1 条 Critical 语义违反 ＋ 2 条 Critical 护栏缺陷 ＋ 4 条 Important ＋ 3 条 Minor。**本波代码一行未动，只改这一份 spec；未 commit。** **本仓库至此十轮 100% 命中「修复波自带缺陷」** —— 第五波的两条（12d(iv) 不可构造、`appendEvent` 会把放弃升级成 attempt failed）都是它自己引入的。

| # | 级别 | 条目 | 处置 | 落点 |
|---|---|---|---|---|
| C-appendEvent | **Critical** | abandon 块里的 `appendEvent` 是裸 `appendFile`（`fileStore.ts:85`–`:87`，函数体两行零守卫），reject → `writeBoundaryArtifacts` 抛 → `persistBoundaryAnalysis`（`:704`，两个调用点 `:1109`/`:1141` 都在外层 try 内）→ `runLoop.ts:1344` 外层 catch → `isLeaseStopError`（`:105`–`:107`）匹配不上 I/O 错误 → `:1390` `transitionRunState(state, "failed", failureReason)`。**一次保护性放弃因为 `events.jsonl` 写不进去被升级成 attempt failed —— 正是第四轮人裁明令禁止的** | **抄本仓库判例**：按 `leaseHeartbeat.ts:58`–`:63` 的 `appendLeaseEvent` 同形 `try{}catch{}` swallow ＋ 同口气注释。**三条约束同时满足并逐条写出**：(1) 人裁「不抛出」→ 抛出路径消失；(2) Rule 12「不许静默」→ 吞的只是审计日志那一半，**当场可见性由已排在前面的回调独家兑现**（第五波路由改动买到的东西，所以吞在这里第一次正当；第四轮「落盘但不路由」形态下吞它才是真静默）；(3) Rule 11 → 判例在同仓库、同函数、同理由。**并补写「为什么 `appendEvent` 吞而回调不吞」的理由**（回调实现在本层控制范围内、抛出只可能是编程错误；`appendFile` 的 I/O 是环境事实） | §4.3 第三步新增整节「⚠️ 同一个放弃块里的 `appendEvent`…」；§4.3 四层表 `fileStore` 行；§9 模块表 `fileStore` 行；§10 测试 12d(iii) 的承重变异整条替换；§20 H4 行补记 |
| C1 | **Critical** | **测试 12d(iv) 按第五波字面不可构造，而它是「四层传递能全绿」的唯一护栏。** 6e 的盘面上三读全成功 → 走保护判定、不走放弃 → **回调不被调 → (iv) 在正确实现上也红**。倒过来用 6f(ii)/(iii) 的 fixture 也堵死：`persistBoundaryAnalysis` 在 `runExclusive` 内先 `readOwnerRecord`（`runLoop.ts:765`，**不在任何 try 内**），owner-record 一旦不可读就在到达 `writeBoundaryArtifacts` 之前抛 | **换 fixture**：`owner-record.json` 合法可读 ＋ `owner-transfer.json` 存在但**不是合法 JSON**（`readOwnerTransferRecordRaw` 是 `:443`–`:444` 的裸 `JSON.parse`，抛 `SyntaxError` → 非 ENOENT → fail-closed → abandon）。**并写全四条 fixture 约束**：坏 JSON 的 transfer、`ownership.verdict !== "OWNER_LOST"` 或 `takeoverAllowed` 为假（否则 `runLoop.ts:771` 那支 `persistOwnerTransfer` 会把坏 JSON 覆盖掉）、`boundaryAnalysis.status === "stale_candidate"`、传下去的 reconciliation `eligibleForContinuation: false`。**顺带复核 12d 其它子用例与测试 6f：没有同型问题**（它们全部直接调导出的 `writeBoundaryArtifacts`，不经 `persistBoundaryAnalysis`） | §10 测试 12d(iv) 下新增整节；§20 H9 行补记 |
| C2 | **Critical** | **「变异必红」与「6e 必红」是两回事，护栏第四轮仍不具鉴别力。** 第六波真的把 6e 变异二注进去跑了：它**今天就杀掉 6 条既有测试**，其中 `fileStore > keeps a live lock in place when recovery cannot yet proceed` **就是 §4.3 排序改判第 2 步要钉的那句话**。于是「写一条断言写空了的 6e → 注入 → 套件红 → 贴原始输出 → 宣布验收 1a 达标」这条路走得通。**根因：§10 与 §15 通篇只要求「某条测试必须红」，没有一处要求把击杀归因到具名的那条测试** | 两半都做：**(1)** 在 6e 变异二旁就地写下那 6 条既有测试的**完整测试名 ＋ 所在文件 ＋ 本波实测的未过滤计数**，并写明这份名单是**噪声不是护栏**；**(2)** **全文推广** —— §10 通用条新增一条把「必须红」的达标判据整体改成「**具名 ＋ `-t` 单跑 ＋ 注入前后两次原始输出都贴 ＋ 基线必须全绿**」，并**逐处点名它绑定的全部落点**（§10 十六处 ＋ §15 五组）。另**两处不定指就地改掉**：测试 15 的「至少一条已有测试红」、§4.2 那条「某条测试必须红」 | §10 测试 6e 变异二新增整节；§10 通用条新增一条（含落点清单）；§10 测试 15；§4.2 |
| I1 | Important | §15 验收 5 第 6 条那组第三 fixture 的约束清单**说「四条」、列了五条、正确是七条** —— 漏了判据 1 与判据 2。判据 1–5 排在 6 之前（不满足则两边都被抢先拒绝 → 变异存活），7/8 排在 6 之后（不满足则变异体在 6 放行后又被拒 → 行为相同 → 同样存活） | 改写为「其余七条全部通过」＋ 一张逐条表（判据 / fixture 要求 / 相对第 6 条的位置 / 不满足则怎样）＋ 重跑的 `sed -n '39,68p'` 与八条判据原文。**并点名判据 2 最危险**（场景描述与 reconciliation 的 eligible 位毫无直觉关联，实施者极易漏设） | §15 验收 5 第 6 条 |
| I2 | Important | 12d 那条 ⚠️「本条断言**全部**钉终态，不钉过程」为假：只对 (i)(ii) 成立。**(iii) 是纯过程断言且刻意如此**（钉两次调用的相对顺序，根本不经 `sweepRuns`）；**(iv) 也不是终态断言**（钉的是「回调被调用」这个事件，在最终文本里不出现） | 改成**分条限定**，并写明 **(iii) 用过程断言钉过程论证是对的**（第四轮的教训是反过来那一种）。**⚠️ 为什么必须改**：照全称办事的实施者可以据此把 (iii) 弱化成终态断言，而那恰好放掉排序这唯一的护栏 | §10 测试 12d 末尾 ⚠️ 段 |
| I3 | Important | 否决 `Error.cause` 的**理由 2 与理由 3 不是两条独立承重**。两条事实都对（单参构造在 `resumeLoop.ts:21`–`:22`；`new` 它的地方本波实测 4 处，测试侧只有 `resumeLoop.gate.test.ts:97`），但**「按当前签名编译不过」对任何被提议的签名变更都成立**——它陈述的是「这需要改签名」，正是理由 3 的前件。**两条其实是一条**，而那个爆炸半径实测只有 1 文件 1 行 | 改写承重结构：**结论由「替代方案严格更简且覆盖更宽」承重**（前缀路由恰好接住那条可达路径，且 `resumeLoop.ts` 一个字节不改），**理由 2/3 降级为同一条爆炸半径事实的两种陈述**，不再各计一条 | §4.4 否决 `Error.cause` 那一节 |
| I4 | Important | 「刻意不钉 abandon 怎么上传」给了**错误的自由度**。`preserveSuccessfulReconciliationIfNeeded` 今天返回 `Promise<ReconciliationRecord>`（`fileStore.ts:279`–`:282`），没有任何「不要写」的通道；实施者最自然的写法是**抛出**，而那正是人裁明令禁止的 | 缝其实已被 12d(iii) 堵住（「正常 resolve」杀掉抛出；「参数含 `String(error)`」杀掉只返回 `null`），**问题只在措辞**。改写为「**上传方式不指定实现，但受 12d(iii) 两条断言约束：不得抛出、且必须把原始 error 带到回调**」。**并就地标出一条本波清单外的冲突（只标不改）**：§4.6 的「`preserveSuccessfulReconciliationIfNeeded` 代码零改动」在处置一落地后为假 | §4.3 处置一新增整节 |
| M1 | Minor | §8 定死 note 走 stderr、报告行走 stdout，同时要求 note「紧跟该 run 的报告行之后」。**两条流重定向到同一管道/文件时的相对顺序在 Node 里不受保证**，这条既无法被 12d 断言也无法被操作者依赖 | **降级为「同一次 sweep 内各条 `note` 行之间保持 run 的遍历顺序」**（单流内可验证），**删掉跨流的「紧跟」承诺** | §4.3 第四步；§8 表那一行；§20 H5 行补记 |
| M2 | Minor | §8 规定「一次调用产生一行」而 `detail` 取 `String(error)`，`SyntaxError` 之类的 message 可含换行，会把一条备注拆成看起来像多条 | **就地写明 `detail` 打印前折成单行。** 既有 `errored` 那行有同样问题但**先于本波存在，本波不动**，具名留给下一轮 | §4.3 第四步；§8 表那一行；§20 H5 行补记 |
| M3 | Minor | 第五波报告说 `grep -rnF … --include=*.ts` 会被 zsh 的 `no matches found` 先杀掉、并说用 `command grep` 规避。**因果记反了一半** | **§11 新增第 6 条**，四条实测对照写清：失败发生在 **zsh 展开阶段**，早于决定调哪个 `grep`，所以 `command` / `rtk proxy` / 绝对路径**一律无效**；**真正的规避是加引号 `--include='*.ts'`（推荐，保留过滤器）或不写 `--include`**（第五波给的结论对、理由错）。**并写明它比退出码那三条更危险**：丢掉 stderr 之后是「零行输出 ＋ exit 1」，与「跑过了、零命中」完全无法区分 | §11 grep 用法第 6 条 |

**本波判定*不成立*的**：第五轮定向评审给的 6e 变异二击杀名单里的第七条 `parseArgs > returns 0 for the scripted example run` —— **它不是被那条变异杀掉的**，详见 §10 测试 6e 变异二那一节末尾的实测更正。

**本波的注入实验（未过滤原始结果，在 scratchpad 的仓库副本上做，工作树 `git status` 全程只有本 spec 一个 `M`）：**

| 跑 | 结果 |
|---|---|
| 基线（副本，`git init` 之后） | `Test Files  29 passed (29)` / `Tests  446 passed (446)` / exit 0 |
| 注入 6e 变异二（删 `tryRecoverStaleOwnerTransferLock` 的 `if (pid !== null && isProcessActive(pid)) { return false; }`） | `Test Files  4 failed \| 25 passed (29)` / `Tests  6 failed \| 440 passed (446)` / exit 1 |

**本波的数字回扫**（每一个都在本波真跑过一次，命令与输出值就地附在数字旁）：

| 数字 | 命令 | 本波实测输出 | 与第五波相比 |
|---|---|---|---|
| 击杀名单 **6** 条（非 7） | 见上表两跑 | 6 failed / 440 passed | **本波新增，并更正评审员给的 7** |
| 基线 29 files / 446 tests | `ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run` | 29 passed (29) / 446 passed (446) / exit 0 | 与第五轮评审一致 |
| `new ResumeNotEligibleError` **4** 处 | `grep -rnF 'new ResumeNotEligibleError' src/ tests/` | 4 行：`resumeLoop.ts:120` `:126` `:144`、`resumeLoop.gate.test.ts:97` | **本波新增** |
| `appendEvent` 函数体 **2** 行零守卫 | `sed -n '85,87p' src/persistence/fileStore.ts` | `:85` 签名、`:86` `await appendFile(...)`、`:87` `}` | **本波新增** |
| `appendLeaseEvent` 判例 | `grep -nF -A4 'const appendLeaseEvent = async' src/controller/leaseHeartbeat.ts` | `:58` 定义、`:59` `try {`、`:60` `await appendEvent(...)`、`:61` `} catch {`；理由注释在 `:51`–`:53`，吞咽注释在 `:62` | **本波新增** |
| `isLeaseStopError` 只认两个租约错误 | `sed -n '105,107p' src/controller/runLoop.ts` | `:106` `return error instanceof RunLeaseLostError \|\| error instanceof RunLeaseUnverifiableError;` | 不变（第五波未重推） |
| 外层 catch → failed | `grep -nF 'transitionRunState(state, "failed", failureReason)' src/controller/runLoop.ts` | 1 行：`:1390` | **本波新增** |
| `persistBoundaryAnalysis` 内早期读 | `sed -n '763,766p' src/controller/runLoop.ts` | `:765` `let ownerRecord = await readOwnerRecord(runDir);` —— **不在 try 内** | **本波新增** |
| `persistOwnerTransfer` 的守卫条件 | `sed -n '771,772p' src/controller/runLoop.ts` | `:771` `if (boundaryAnalysis.status === "stale_candidate" && ownership.verdict === "OWNER_LOST" && ownership.takeoverAllowed) {` | **本波新增** |
| `readOwnerTransferRecordRaw` 裸 `JSON.parse` | `grep -nF -A2 'async function readOwnerTransferRecordRaw(' src/persistence/fileStore.ts` | `:443` 签名、`:444` `return JSON.parse(await readFile(...)) as OwnerTransferRecord;` | **本波新增** |
| `preserveSuccessfulReconciliationIfNeeded` 返回 `Promise<ReconciliationRecord>` | `grep -nF -A3 'async function preserveSuccessfulReconciliationIfNeeded(' src/persistence/fileStore.ts` | `:279`–`:282`，`:282` `): Promise<ReconciliationRecord> {` | **本波新增** |
| 八条判据 / 其余 **7** 条 | `sed -n '39,68p' src/controller/resumeLoop.ts` | 八条依次在 `:42 :45 :48 :51 :54 :57 :60 :63`；被变异的是 `:57` | **本波更正**（第四轮写「四条」列五条） |
| **`-E` 重推命令 6 条** | `grep -nE "^ *grep -nE '" <spec>`（列出、不计数） | **7 行**，其中 `:1056` 是 §4.6 保留的历史观测 → **重推命令仍是 6 条** | **不变**（本波未新增任何 `-nE`） |
| **12d 四条子用例 / 验收 9 五条 / §13 清单 5 笔 / L5 输入 6 项 / cleanup 10 个 staging 路径六处联动** | — | **本波一处都没动** | 不变 |

**⚠️ 本波明确*没有*重推、因此不得当作已核实的数字**：§20 那一格列的全部（`OBSERVED_FILES` 3 / `writeBoundaryArtifacts` 的 11 与 2 行 / `persistBoundaryAnalysis` 3 行 / `runLoopFromState` 6 参 / `resumeLoop` 14 调用点 / `ScanRow` / `cannot read run artifacts` 3 行），**外加 §19 那一格的全部**（finalize try 前 4 次 / try 内 9→13 步 / cleanup 4→10 / `transferRepresentsPublishedWinner` 的 `:144`–`:146` / `writeOwnerTransferArtifacts` 在 tests 里的 17 与 34 / 函数体 28 行 / `return { ok: false` 的 8 / `appendEvent(` 的 6）。**§19 那一格从第五波起已连续两波没人替它做，下一轮请从它开始。**

**关于 `grep`**：本波开工时实测 `type grep` 的输出是 **`grep is a shell function from /Users/biran/.claude/shell-snapshots/snapshot-zsh-1785583056984-suirbu.sh`**，与 §4.6a / §20 记录的一致。**本波没有写任何依赖退出码的新论证**；新增的 §11 第 6 条**不是退出码论证**——它论证的是「命令根本没被执行」，判据是 stderr 上那句 `no matches found` 与 stdout 的零行，两者与退出码机制无关。**§4.6a 本波一个字节未改。**

**下一波请优先核这五类**（前四类沿用 §19/§20，第五类是本波新增）：

1.–4. 同 §19 末尾四条，原样沿用。
5. **一条新加的「安全网」是不是把它自己要保护的那条护栏变成了等价变异。** 本波的 `appendEvent` swallow 就当场做了一次：swallow 一落地，第五波给 12d(iii) 配的「把回调与 `appendEvent` 顺序对调」立刻变成等价变异（两侧回调都会被调用）。**每加一条 fail-safe，都要回头看它是不是让某条既有变异不再可杀** —— 本波已就地换成「删掉 swallow 的 try/catch」，但这类连带作用不会自己浮出来。
