# 债 4：消除 fileStore 非原子写路径 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/persistence/fileStore.ts` 中五处裸 `writeFile` 换成 temp+rename 原子写，消除撕裂读的写侧根因。

**Architecture:** 新增一个模块私有的原子写辅助与一个可导出的临时名生成器；五个调用点逐一替换；转移事务路径一行不动；L2 读侧只改注释。

**Tech Stack:** TypeScript / Node `node:fs/promises` / vitest / 真实 tmpdir 测试（本仓库零 `vi.mock`）

**唯一真相源：** `docs/superpowers/specs/2026-07-29-atomic-write-paths-design.md`
**上位裁决：** `docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` 债 4

## 计划风格说明（给实施者）

**本计划刻意不给可抄的实现代码。** 你会拿到接口签名、测试必须证明什么、以及已知陷阱清单。实现方式由你判断。这不是疏漏——本项目三轮实践一致表明，附完整代码会让计划的疏漏原样落地，而只给要求时实施者会发现并上报计划缺陷。

**如果你认为计划有缺陷或要求自相矛盾，上报，不要猜着做。** 上一轮 6 个实施者里 4 个上报了计划缺陷，全部被采纳。

## Global Constraints

以下约束对每个任务都生效，逐条来自 spec：

- **转移事务路径逐字节未改**：`finalizePendingOwnerTransfer`、`writeOwnerRecordAtomically`、`acquireOwnerTransferLock`、`recoverInterruptedOwnerTransfer` 及相关常量。理由：它们靠**固定**临时路径做崩溃恢复，换成唯一名会让恢复静默失效（spec §4.2）。
- **`src/registry/` 内零逻辑改动**，只允许注释行变动。`atomic: false` 保留为纵深防御（spec §5）。
- **序列化格式不变**：五处全部是 `JSON.stringify(value, null, 2)`，缩进与键序不得变（spec §3.1 第 4 条）。
- **不引入 `vi.mock`，不给 `fileStore.ts` 加文件系统注入缝**。本仓库测试套件零处 `vi.mock`，约定是真实 tmpdir（spec §7）。
- **不写竞态测试**（spec §7）。
- **不设性能门禁，不专门跑基准**（spec §8）。
- **不改任何文件的写入时机、条件或内容**——只改「怎么写」。`reconciliation-record.json` 的时机属于债 1 / L3。
- **错误向上传播，不吞**（Rule 12）。
- 验证命令：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`。**绝不加 `| tail -N`**——失败块会被截断，只剩不可证伪的归因。
- 起点基线：29 files / 427 tests 全绿，typecheck / build 干净。

---

### Task 1: 原子写辅助与临时名生成器

**Files:**
- Modify: `src/persistence/fileStore.ts`（新增两个函数，**不替换任何现有调用点**）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Produces（Task 2/3/4 依赖）：
  - `async function writeJsonFileAtomically(path: string, value: unknown): Promise<void>` — **模块私有，不导出**
  - `export function buildAtomicTempPath(targetPath: string): string` — **导出，仅为可测**

**本任务不改变任何现有行为。** 五个调用点在后续任务替换。

- [ ] **Step 1: 读 spec §3、§4.1、§4.2，以及 `fileStore.ts` 现有的 `writeJsonFile`(:367) 与 `writeOwnerRecordAtomically`(:632)**

理解为什么不能复用后者。**不要跳过这一步**——本任务最可能的错误就是"顺手泛化"。

- [ ] **Step 2: 写失败的测试（先测 `buildAtomicTempPath`）**

测试必须证明（spec §7.2 R3）：
1. 同一进程内、**相同 `targetPath`** 连续两次调用返回**不同**路径；
2. 返回路径含进程标识（`process.pid`）；
3. 返回路径与 `targetPath` 在**同一目录**下——`rename` 跨文件系统会失败，临时文件必须和目标同目录；
4. 返回路径**不等于**任何 `getOwnerTransferPaths` 返回的路径（spec §4.1 末段）。

**陷阱**：第 1 条决定了它**不是纯函数**（spec §3 已更正此措辞）。若你实现成纯函数，第 1 条必然失败。

- [ ] **Step 3: 跑测试确认失败**

`ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/persistence/fileStore.test.ts -t "AtomicTempPath"`
Expected: FAIL —— 函数不存在。

- [ ] **Step 4: 实现两个函数**

`writeJsonFileAtomically` 必须满足 spec §3.1 全部五条。要点：写临时文件 → `rename` 到目标；失败路径 `unlink` 临时文件后**再向上抛**（不吞）。

**陷阱**：`unlink` 本身可能失败（临时文件根本没创建成功）。清理失败不得掩盖原始错误——参照 `finalizePendingOwnerTransfer`(:539-543) 的 catch 写法。

- [x] ~~**Step 5: 补 R2 测试（残留与错误传播）**~~ —— **已移入 Task 2，本任务不做。**

**计划缺陷 D1，由 Task 1 实施者发现、控制器对着代码证实**：`writeJsonFileAtomically` 未导出（`fileStore.ts:394`），而本任务不替换任何调用点，**所以它在本任务里没有任何测试可达的入口**。禁用 `vi.mock`、Node ESM 也不暴露未导出绑定，无第三条路。R2 被放早了一个任务。

**不得用弱替代凑数**：此时对着仍是裸 `writeFile` 的 `writeRunState` 写 R2，测试会从一开始就绿并永远绿（裸 `writeFile` 同样不留临时文件、同样对目录目标抛错），那是 Rule 9 违规。Task 1 实施者正确地拒绝了这条路，改为**在生产函数上做变异验证后回退脚手架**（删掉 catch 里的 `unlink`，失败路径断言变红），证据记在 ledger。

- [ ] **Step 6: 跑测试确认全过 + 全套件不回归**

`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`
Expected: 427 + 新增数量，**零失败**。**不加 `| tail`。**

- [ ] **Step 7: Commit**

```bash
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: add an atomic JSON write helper and its temp-path generator"
```

---

### Task 2: 原子化 `loop-state.json` 的两个写者

**这是本分支最要紧的一个任务。** `loop-state.json` 既是 `RUN_MARKER_FILES` 之一，又是 L2 唯一逐字段观测的三个文件之一，且每次状态转移都重写。

**Files:**
- Modify: `src/persistence/fileStore.ts:76`（`initializeRunFiles`）、`:81`（`writeRunState`）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `writeJsonFileAtomically`

- [ ] **Step 1: 写失败的 inode 测试（两个写者各一条）**

判据（spec §7.1）：`rename` 让目标指向**新 inode**；原地 `writeFile` **保留** inode。

每条测试的形状：
1. 写一次，取 `stat(target).ino` 记为 `ino1`；
2. **`open(target)` 持有文件句柄**，直到断言结束才关闭；
3. 用**不同内容**再写一次，取 `ino2`；
4. 断言 `ino2 !== ino1`。

**陷阱 —— 第 2 步不做，测试会随机失败。** `rename` 释放被替换文件的 inode，文件系统**可以立刻把同一个 inode 号复用**给下一个临时文件，于是 `ino2 === ino1` 偶发成立。持有打开的句柄会把旧 inode 钉住。**不要省略这步再把偶发失败当 flake 记账**——本项目已背 5 个 flake 债，L1b 最终评审专门为"明知形状易 flake 仍照抄"立过案。

**陷阱 —— 测试不得声称它证明了原子性。** inode 判据证明的是"落地经过了 `rename`"，**不是**"不存在任何中间可见状态"。后者在真实文件系统上无法确定性证明。**测试名与注释都不得越界声称**——本项目上一轮最贵的缺陷正是"测试声称杀 A、实际杀不掉"。

`initializeRunFiles` 那条要注意：它先跑 `ensureFreshRunDir`，对已有 run 数据会抛。测试夹具需要每次用干净目录，所以"写两次比 inode"的形状要相应调整——**这一点由你判断怎么搭，但不得为此放宽断言**。若你认为该写者无法用同一形状测试，**上报，不要降级成弱断言**。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— 两条 inode 断言都不成立（当前是原地覆写）。

- [ ] **Step 3: 替换两个调用点**

`:76` 与 `:81` 改用 `writeJsonFileAtomically`。**两个都要改**——只改其一即为未达标（spec §9）。

- [ ] **Step 4: 跑测试确认通过 + R4 字节等价**

补一条断言：替换前后目标文件内容逐字节一致（`JSON.stringify(value, null, 2)`）。

- [ ] **Step 4b: R2（残留与错误传播）—— 从 Task 1 移来**

`writeRunState` 现在是 `writeJsonFileAtomically` 的真实入口，R2 到这里才可测。必须证明：
1. 成功写入后，目标目录中**没有**临时文件残留；
2. `rename` 失败时**也没有**残留，且错误**向上抛出**（不吞）；
3. 失败用真实手段制造（例如目标路径是一个已存在的**目录**），**不用 mock**。

**陷阱**：Task 1 实施者已在生产函数上验证过——删掉 catch 里的 `unlink` 会让失败路径断言变红（实得 `[".loop-state.json.<pid>.<n>.tmp", "loop-state.json"]`，期望 `["loop-state.json"]`）。**你要把这条变异重新跑一遍并贴输出**，不得引用别人的结论当自己的证据。

- [ ] **Step 5: R5 变异验证（强制）**

把 `writeJsonFileAtomically` 内部临时改回裸 `writeFile`，跑测试，**记录哪几条失败**，再改回来。

**陷阱**：注入点必须在**生产函数**上。往测试的数据结构里注入只证明匹配器有效、没证明覆盖到位——这是上一轮整分支评审抓到的最贵缺陷。

- [ ] **Step 6: 全套件 + commit**

```bash
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: write loop-state.json atomically from both of its writers"
```

---

### Task 3: 原子化 `owner-record.json` 的首次创建

**Files:**
- Modify: `src/persistence/fileStore.ts:379-381`（`writeOwnerRecord`）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `writeJsonFileAtomically`

- [ ] **Step 1: 写失败的 inode 测试**

形状同 Task 2 Step 1，含**持有文件句柄**那一步与"不越界声称"的约束。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 替换 `writeOwnerRecord`**

**陷阱 —— 本任务最容易越界的地方**：`writeOwnerRecordAtomically`(:632-637) 名字相近、写同一个文件，**但它属于转移事务路径，一个字符都不能动**（Global Constraints 第 1 条）。改错对象会破坏崩溃恢复。**动手前确认你改的是 `:379-381` 这个导出函数。**

- [ ] **Step 4: 跑测试通过 + R5 变异验证**

同 Task 2 Step 5 的要求，注入点在生产函数上。

- [ ] **Step 5: 全套件 + commit**

```bash
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: write the initial owner record atomically"
```

---

### Task 4: 原子化 `writeBoundaryArtifacts` 内的两处写

**Files:**
- Modify: `src/persistence/fileStore.ts:308`（`boundary-analysis.json`）、`:316`（`reconciliation-record.json`）
- Test: `tests/persistence/fileStore.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `writeJsonFileAtomically`

- [ ] **Step 1: 写失败的 inode 测试（两个文件各一条）**

形状同 Task 2 Step 1。`:316` 是条件写（仅当 `artifacts.reconciliationRecord !== undefined`），夹具要相应构造。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 替换两处**

**陷阱 —— 严禁顺手做的两件事：**
1. **不得改 `:310` 的条件、不得改 `preserveSuccessfulReconciliationIfNeeded` 的调用位置或语义。** 那是「何时写 / 写不写」，属于债 1 / L3。本任务只改「怎么写」。
2. **不得声称这两个文件之间变原子了。** 它们各自原子之后，**彼此之间仍然不是原子的**——可以观测到 `boundary-analysis.json` 已更新而 `reconciliation-record.json` 未更新（spec §4.3）。测试名、注释、提交信息都不得暗示跨文件一致性已解决。

- [ ] **Step 4: 跑测试通过 + R5 变异验证**

- [ ] **Step 5: 全套件 + commit**

```bash
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
git add src/persistence/fileStore.ts tests/persistence/fileStore.test.ts
git commit -m "feat: write boundary analysis and reconciliation record atomically"
```

---

### Task 5: M-1 警示注释、L2 注释更正、与最终验收

**Files:**
- Modify: `src/persistence/fileStore.ts:383-385`（`writeOwnerTransferRecord` 上方加注释）
- Modify: `src/registry/readObservedFile.ts:3`（注释）、`src/registry/observeFields.ts`（两个 `atomic: false` 处加注释）
- **无测试文件改动**（本任务只动注释与验收）

- [ ] **Step 1: 给 `writeOwnerTransferRecord` 加警示注释**

注释必须说清三件事（spec §6）：
1. 它**非原子**；
2. 它**只供测试搭夹具**（生产代码零调用者）；
3. **生产发布必须走 `finalizePendingOwnerTransfer`**，否则会静默击穿 L2 对该文件的单次读前提（`observeFields.ts:30` 的 `atomic: true`）。

**陷阱**：**不要把它改成原子**。那会让它看起来可以用于生产，而它真正的问题是旁路了整个事务与恢复机制，不是原子性（spec §6 末段）。**不要重命名、不改签名、不动任何测试调用点。**

- [ ] **Step 2: 更正 L2 的两处注释**

`readObservedFile.ts:3` 现在写着 "files known to be written non-atomically"——**这句话在本分支之后为假**，必须改写。`observeFields.ts` 两个 `atomic: false` 处要说明：写侧已原子化，此处保留有界重读作为**纵深防御**，代价上限约 100ms 且仅在 parse 失败时触发。

**陷阱**：**`atomic: false` 不得翻成 `true`**，`src/registry/` 内不得有任何逻辑改动。核验方式：`git diff src/registry/` 应**只有注释行**。

- [ ] **Step 3: R6 回归 —— zeroWrite 实跑**

`ECC_GATEGUARD=off DISABLE_OMC=1 npx vitest run tests/registry/zeroWrite.test.ts`

临时文件会短暂出现在 run 目录里，而 registry 只读，**理论上**不受影响——**但必须实跑证明，不接受推理**（spec §7.2 R6）。

- [ ] **Step 4: 全部验收标准逐条核对**

```bash
ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run
npm run typecheck
npm run build
git diff --stat main...HEAD
git diff main...HEAD -- src/registry/
```

逐条核对 spec §9：
- 五个替换点全部只经 `rename` 落地，R1–R6 全部满足且变异验证有据；
- `loop-state.json` 的**两个**写者都已原子化；
- `src/registry/` 内零逻辑改动；
- `writeOwnerTransferRecord` 有警示注释，签名与调用点未变；
- 转移事务路径四个符号**逐字节未改**（用 `git diff` 核实，不要靠记忆）；
- 全套件绿、typecheck / build 干净，**贴真实输出，不加 `| tail -N`**。

- [ ] **Step 5: Commit**

```bash
git add src/persistence/fileStore.ts src/registry/readObservedFile.ts src/registry/observeFields.ts
git commit -m "docs: mark the non-atomic transfer writer and correct L2's atomicity comments"
```

---

## 计划自审结果

**Spec 覆盖核对**：§2.1 五个替换点 → Task 2/3/4；§3 两个新接口 → Task 1；§5 L2 注释 → Task 5 Step 2；§6 M-1 → Task 5 Step 1；§7 R1–R6 → R1 在 Task 2/3/4，R2/R3 在 Task 1，R4 在 Task 2 Step 4，R5 在 Task 2/3/4，R6 在 Task 5 Step 3；§9 验收 → Task 5 Step 4。**无遗漏。**

**类型一致性**：`writeJsonFileAtomically` 与 `buildAtomicTempPath` 两个名字在 Task 1 定义、Task 2/3/4 引用，全篇一致。

**已知的计划风险，如实标注**：Task 2 中 `initializeRunFiles` 的 inode 测试形状不能照抄另一个写者——因为 `ensureFreshRunDir` 会拒绝已有 run 数据的目录。计划**没有**替实施者解决这个夹具问题，而是要求「若无法用同一形状测试则上报，不得降级成弱断言」。**这是有意的**：预先编一个未经验证的夹具方案，比让实施者撞上并上报更糟。
