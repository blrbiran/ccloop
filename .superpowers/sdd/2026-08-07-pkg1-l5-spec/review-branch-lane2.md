# 包 1 整分支评审 —— Lane 2（代码事实面）

评审员：独立 Lane 2（未参与本轮任何一条）
范围：BASE = `30cbdd5`，HEAD = `c842257`
只读边界：未改动 `src/` / `tests/` / 工作树 / HEAD；未做变异注入。

## 0. 结论（最先写）—— 含破坏线索的判词

### 0.1 破坏线索的判词（最显眼处，直接决定 Lane 1 §7.2）

> *** **判词：不成立。** ***
> 「若有经 `buildAtomicTempPath` 的写目标位于 `<runDir>/worktrees/` 下」——
> **今天的第一方源码里不存在这样的写目标，且是结构性地不存在，不是「我没找到」。**

> **⚠️ Amended（控制器复核后，2026-08-07）**：本节原有**三条**理由，
> **第 3 条被控制器证伪，我复核后认领并作废**（`ensureFreshRunDir` 的
> `attempts/`/`worktrees/` 两个 guard 走 `directoryHasEntries` = `readdir().length > 0`，
> **与名字完全无关**，见 §1.2 的 Amended 订正）。
> **我重推了一遍，判词不变**，支撑改为**只靠下面两条**。新增 §1.4 与 Important-3。

**支撑（两段，均独立于 `ensureFreshRunDir` 的 guard 面，全文见 §1.3）**：

1. `buildAtomicTempPath` 只做 `dirname(targetPath)` + `basename(targetPath)`，
   **不接受目录参数，没有任何输入能让它下钻一层**（`src/persistence/fileStore.ts:628-634`）。
2. *** **承重的一条** *** —— 它在 `src/` 内的**唯一真调用者**是 `writeJsonFileAtomically`；
   后者的 **5 个 `src/` 调用点（`:77`/`:82`/`:446`/`:497-498`/`:673`），
   写目标全部是 `join(runDir, <字面量/模块常量>)`，无一带子目录段**
   ⇒ `dirname` 恒 = `runDir` 本身，**恒在 `worktrees/` 的上一层**（枚举与判别式见 §1.1）。

⇒ **这条线索的前件（「有经 `buildAtomicTempPath` 的写目标位于 `<runDir>/worktrees/` 下」）
在今天的第一方源码里不成立**，后件无从触发。
⇒ ***「无界垃圾不是故障」这条定性在这条线索上**没有被证伪**。
spec §5.4 与其立项论证**不需要重写**。***

> *** **但请不要把判词读成「`worktrees/` 下的残留无害」—— 那是假命题。** ***
> `worktrees/` 的 guard **名字无关，任何一个条目都会让 `ensureFreshRunDir` 抛**，
> 且那里有一个**无界写入者**（`runLoop.ts:169-170` 经 `sh -lc` 跑的用户自带命令，
> cwd 就是 worktree）。判词说的是**前件不成立**，不是**后件无害**。详见 §1.4。

**限定（必须一并读）**：我的检索面 = `src/` `tests/` `scripts/` `examples/` `validation/`，
**不含 `dist/`、`node_modules/`**；且**不覆盖** `runLoop.ts` 经 `sh -lc` 执行的**用户自带命令**
（它在 worktree 里跑，可写任意名字）。另有一条真实但属**带外配置**的路径：
若操作者把 `--run-dir` 指向另一个 run 的 `worktrees/` 之下，物理上 temp 会落进外层 worktrees ——
但那不是代码路径，且此时外层 worktrees 早已因 `git worktree add` 的目录本身而非空，temp 非必要条件。
**我未做变异注入、未实跑真 run，以上全部是静态源码推理。**

### 0.2 总判词

> *** **可开门。** ***

技术理由（两句）：
(1) 本车道把 spec 对今天代码下的 **8 条承重断言全部重推，8 条全部属实**
（10 个固定名、`releaseOwnerLease` 唯一调用点、`cleanupStatus` 语义、
`writeOwnerTransferRecord` 零生产调用者 ＋ 23/21 计数、`writeJsonFileViaFixedTemp` 4 个调用点、
`RUN_MARKER_FILES`、`OBSERVED_FILES`、分层表 deletion 的限定），**零条被证伪**；
(2) 唯一可能推翻立项前提的那条破坏线索**不成立**，因此**没有 Critical**，
两条 Important 都是「论证缺一个可执行落点」而非「据以立论的代码事实是假的」，
其中 Important-2 已被人裁 8 第 1 条（N1）覆盖并明令先不改。

**不是「需修复环 2」的理由**：环 2 的门槛是承重前提被证伪或存在数据丢失路径；
本车道两者皆无。两条 Important 建议进**下一轮**（且 Important-2 必须守人裁 8 第 2 条的顺序约束：
**先封 N1，再补 INV-4 进 §8.2 验收表**）。

### 0.3 计数

- **Critical：0**
- **Important：3**（**由 2 增至 3**）
  - **I-1** INV-3 消费入口未指名，且 spec 所指入口（L2 registry 观测）今天运不了 reconciliation 输出
  - **I-2**「位于一个 run 目录内」外延未封口 —— 现有**两个**可构造实例
    （`.validation-runs/`；**新增**：用户命令在 worktree 内写出的五段形文件）
  - **I-3（新增）** spec §4.2 `:271-272` 把 `ensureFreshRunDir` 的两类 guard 合并成一句
    「临时名不在其中」，**论据腐坏、结论未腐坏**；错的方向会让读者低估 `worktrees/` 的约束
- **Minor：2**（§4.1 四段写法；`releaseOwnerLease` 全称否定限定偏薄）— **不变**
- **正面样本：4**（见 §7）— **不变**
- **我自报的未完成项：9 条**（**由 8 增至 9**，见 §8）
- **预算：超支，约 4.5×，已明写（见 §9）**

**总判词仍为「可开门」**：I-3 是**论据**瑕疵而非结论被证伪，
I-2 已被人裁 8 第 1 条覆盖并明令先不改，三条 Important 都不构成环 2 的门槛
（承重前提被证伪 / 数据丢失路径），建议全部进**下一轮**。

## 1. 必撞项：buildAtomicTempPath / <runDir>/worktrees/ / ensureFreshRunDir

**判词：不成立（结构性理由，非「我没找到」）。** 详见 §1.3，含检索面声明与它盖不住的部分。

### 1.1 调用点枚举（判别式 + 完整清单）

**判别式声明**：下面数的是**「含符号 `buildAtomicTempPath` 的行」**与**「带 `(` 的调用点」**两个不同的量，
两者数值不同，分别给命令。

命令（写进脚本用 bash 跑，避开陷阱 4/9）：

```
grep -rn 'buildAtomicTempPath' src/          # 输出 3 行
grep -rno 'buildAtomicTempPath(' src/ | wc -l # 输出 2
```

**含符号的行（3 行，全部，未摘要）**：

```
src/persistence/fileStore.ts:628:export function buildAtomicTempPath(targetPath: string): string {
src/persistence/fileStore.ts:645:  const tempPath = buildAtomicTempPath(path);
src/persistence/fileStore.ts:1118:// whose buildAtomicTempPath stamps a process id and per-call sequence number into the temp
```

判别式解释：`:628` 是定义、`:645` 是唯一真调用、`:1118` 是注释。
`grep -o '(' ` 数出 2 是因为定义行的 `(targetPath` 也带括号 —— **带括号计数 2 ≠ 调用点数 1**。
**`src/` 内 `buildAtomicTempPath` 的真调用点只有一个：`writeJsonFileAtomically`（`fileStore.ts:643`）。**

**因此可达写目标集合 = `writeJsonFileAtomically` 的全部 `src/` 调用点。**
命令 `grep -rn 'writeJsonFileAtomically' src/` 输出 10 行，逐行分类后**真调用点 5 个**
（`:643` 是定义，`:503`/`:617`/`:1117`/`observeFields.ts:31` 是注释）：

| # | 位置（符号锚点） | 目标表达式 | `dirname(target)` |
|---|---|---|---|
| 1 | `initializeRunFiles`（fileStore.ts:77） | `join(runDir, "loop-state.json")` | `runDir` |
| 2 | `writeRunState`（fileStore.ts:82） | `join(runDir, "loop-state.json")` | `runDir` |
| 3 | `writeBoundaryArtifacts`（fileStore.ts:446） | `join(runDir, "boundary-analysis.json")` | `runDir` |
| 4 | `writeBoundaryArtifacts`（fileStore.ts:497） | `join(runDir, "reconciliation-record.json")` | `runDir` |
| 5 | `writeOwnerRecord`（fileStore.ts:673） | `join(runDir, OWNER_RECORD_FILE)` | `runDir` |

**五个目标全部是 `join(runDir, <字符串字面量/模块常量>)`，无一带子目录段。**
而 `buildAtomicTempPath` 逐字把 temp 放在 `dirname(targetPath)`：

```
return join(dirname(targetPath), `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`);
```

⇒ **所有原子 temp 落在 `runDir` 根，不落在 `<runDir>/worktrees/` 之下。**

**间接路径的回溯**：`runDir` 是参数，不是 `src/` 里构造的。`grep -rn 'runDir' src/cli` 为空
（`src/cli` 不存在），`grep -rn 'join(.*runs\|runsDir\|\.ccloop' src` 为空 ——
**`src/` 内没有任何一处构造 runDir 的字面路径**，它由调用方（契约 / `--run-dir`）传入。
所以「目标目录被传成 worktrees 之下」这条在 `src/` 内**没有生产者**；
它只能由外部传入一个本身位于某个 worktrees 之下的 runDir 来实现（见 §1.3 的限定）。

### 1.2 ensureFreshRunDir 的抛错条件

> **⚠️ Amended（控制器复核后，2026-08-07）**：本节原文已**写全了五个 guard**，
> 但**下方 §1.3 与 §0.1 的「理由 3」把它读窄了**，只用了前三个精确名 guard，
> 并据此下了「名字层面就不可能相等」的**结构性否证**。
> **那条推理只对 `runDir` 根成立，对 `attempts/` 与 `worktrees/` 恰好不成立** ——
> 后两个 guard 是 `readdir().length > 0`，**与名字完全无关**。
> 原文保留在下，订正见本节末的「Amended 订正」与改写后的 §1.3。

`ensureFreshRunDir`（`src/persistence/fileStore.ts:49`，`async function`，**未 export**）
唯一调用者是 `initializeRunFiles`（`:74`）；`initializeRunFiles` 在 `src/` 内唯一调用点是
`runLoop.ts:946`。它的抛错面**逐字**是：

1. `mkdir(runDir, { recursive: true })`
2. **三个精确路径存在即抛**：`loop-contract.json`、`loop-state.json`、`events.jsonl`
   （`pathExists`，逐名精确比对，**不是前缀 / 通配 / 目录扫描**）
3. `directoryHasEntries(join(runDir, "attempts"))` 为真即抛
4. `directoryHasEntries(join(runDir, "worktrees"))` 为真即抛

错误文本一律 `runDir already contains prior run data (<label>); V1 does not support reinitializing an existing automated run`。

**「残留」的形态判别**：对 3/4 是**目录非空即抛（任意一个 entry，任意名字）**；
对 2 是**恰好这三个文件名**。**runDir 根下的任何其它残留 —— 包括点开头的原子 temp —— 一律不触发。**

#### Amended 订正 —— guard 面必须分成两类，不能合并成一句

我把两个辅助函数的**完整函数体**原样打出（`awk` 范围取，未过滤，`bash` 跑）：

```
async function directoryHasEntries(path: string): Promise<boolean> {   // fileStore.ts:37
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { return false; }
    throw error;
  }
}
```

`pathExists`（`fileStore.ts:29`）走 `access(path)`，是**逐名精确**的。
两者性质不同，**必须分成两类记**：

| 类 | guard | 判据 | 与文件名的关系 |
|---|---|---|---|
| **A（名字精确）** | `runDir/loop-contract.json`、`runDir/loop-state.json`、`runDir/events.jsonl` | `pathExists` | **依赖名字**。点开头的 `.tmp` 名不可能等于这三个之一 |
| **B（名字无关）** | `runDir/attempts/`（`:64`）、`runDir/worktrees/`（`:68`） | `directoryHasEntries` = `readdir().length > 0` | *** **与名字完全无关。这两个目录下多出任何一个条目就抛 —— 包括一个 `.foo.<pid>.<t0>.1.tmp`。** *** |

*** **结论：「残留会让 `ensureFreshRunDir` 抛错」这半句，在 `<runDir>/worktrees/` 与
`<runDir>/attempts/` 这两个位置上是成立的。** ***
我原先的「理由 3」把 A 类的性质套到了整个函数上，**是一次把探针读窄了当结构性证明** ——
正是本仓库反复栽的形状，**由控制器复核抓出，我认领**。

**这条订正不改判词**（判词改由 §1.3 的理由 2 独立承重），
但它**改变了「worktrees/ 下的残留无害」这个假命题的归属** —— 那个命题是**假的**，
不得被下一轮划 L5 授权面的人继承。新增的后果见 §1.4 与 §7 的 **Important-3**。

### 1.3 判词与可构造场景

> **⚠️ Amended（控制器复核后，2026-08-07）**：原文用**三条**理由支撑判词，
> **理由 3 已被证伪并降级**（见 §1.2 的 Amended 订正）。
> 我**重推了一遍**，判词**不变**，但支撑改为**只靠理由 1+2**。原三条理由的原文保留在下方引用块内。

<details><summary>原文（已订正，保留留痕）</summary>

> **结构性理由（三段，缺一不可）**：1. `buildAtomicTempPath` 把 temp 放进 `dirname(targetPath)`；
> 2. 唯一调用者 `writeJsonFileAtomically` 的 5 个调用点目标全是 `join(runDir, <literal>)`；
> 3. ~~`ensureFreshRunDir` 对 `runDir` 根只做三个精确文件名检查，temp 名不可能相等~~
>    ← **此条只对 runDir 根成立，对 `attempts/`/`worktrees/` 不成立，已作废为「局部论证」。**

</details>

*** **重推后的判词：仍然不成立。** ***

**这次的支撑（两段，两段都独立于 `ensureFreshRunDir` 的 guard 面）**：

1. **`buildAtomicTempPath` 无法下钻。** 它的函数体只有 `dirname(targetPath)` 与
   `basename(targetPath)` 两次调用，**不接受任何目录参数**
   （`src/persistence/fileStore.ts:628-634`，§4 已贴全文）。
   ⇒ temp 的所在目录**恒等于目标文件的所在目录**，一层都不多。
2. *** **承重的一条：调用点穷举。** *** `buildAtomicTempPath` 在 `src/` 的真调用者只有
   `writeJsonFileAtomically`（`fileStore.ts:645`，判别式见 §1.1）；后者的 **5 个 `src/` 调用点**
   目标全部是 `join(runDir, <字符串字面量或模块常量>)`：
   `:77`、`:82`（`loop-state.json`）、`:446`（`boundary-analysis.json`）、
   `:497-498`（`reconciliation-record.json`）、`:673`（`OWNER_RECORD_FILE`）。
   **无一带子目录段** ⇒ `dirname(target)` **恒 = `runDir` 本身，恒在 `worktrees/` 的上一层**。

⇒ **「经 `buildAtomicTempPath` 的写目标位于 `<runDir>/worktrees/` 下」在今天的第一方源码里
不存在**，因此这条线索的**前件不满足**，后件（`ensureFreshRunDir` 抛错）无从触发。

**关键的自我约束（这次必须写明，否则又会读窄）**：
判词是 **「前件不成立」**，**不是**「worktrees/ 下的残留无害」。
**后者是假命题** —— §1.2 已证 `worktrees/` guard 名字无关，任何条目都会让它抛。
两句话不能互相替代。**下一轮划 L5 授权面的人请读 §1.4。**

**因此：`2026-07-29-atomic-write-paths-design.md` §10 第 4 条的「这是无界垃圾，不是故障」
这条定性，在这条线索上没有被证伪；新 spec §5.4 的立项前提这一侧不需要重写。**

**我的检索面，以及它盖不住的部分（必须写明）**：

- 检索面 = `src/` 全树 + `tests/` 全树 + `scripts/` + `examples/` + `validation/`。
  **不含** `dist/`（构建产物）与 `node_modules/`。
- **盖不住 A（沿用上一轮扫描员的限定，本仓库铁律 3）**：`src/controller/runLoop.ts` 经 `sh -lc`
  执行**用户自带命令**。用户命令可以在 `<runDir>/worktrees/` 下写任何东西，也可以写出形如
  原子 temp 的名字。**任何「`src/` 内不产生 worktrees 下残留」的断言都不覆盖这条**；
  但那不是「经 `buildAtomicTempPath` 的写」，不在这条线索的判词范围内。
- **盖不住 B（真实但属外部输入）**：`runDir` 由调用方传入，`src/` 不构造它。
  若操作者把 `--run-dir` 指向**另一个 run 的 `<runDir>/worktrees/attempt-N/…` 之下**，
  内层的原子 temp 会物理落在外层的 `worktrees/` 子树里，从而让**外层**的
  `ensureFreshRunDir` 在第 4 条上抛。**这是带外配置，不是代码路径**，且此时外层
  `worktrees/` 早已因 `git worktree add` 建出的目录本身而非空 —— temp 并非必要条件。
  据此**不构成**对这条线索的证成。
- **盖不住 C（我未做的）**：我**没有**做变异注入、没有实跑一次真 run 去盘上取证
  （包 1 授权面禁止改 `src/`/`tests/`，且本 checkout 只读）。以上全部是**静态源码推理**。

### 1.4 新问题（控制器复核逼出）：谁会往 `<runDir>/worktrees/` 里写东西？

**这条被 §1.2 的订正逼出来 —— 既然那个 guard 名字无关，写入者的面就直接决定它有多容易被绊。**

**方法**：`grep -rn 'worktreePath' src/`（全部 42 行，未过滤）＋
`grep -rn 'cwd:' src/`（全部 4 行）＋ `grep -rn 'spawn(\|execFile'`（全部 5 行）。
判别式：我数的是**「能让路径落在 `<runDir>/worktrees/` 之下的写入者」**，不是「提到 worktreePath 的行」。

**完整清单（4 个，我认为已穷举第一方代码面）**：

| # | 写入者 | 锚点 | 写什么 | 有界吗 |
|---|---|---|---|---|
| 1 | `createAttemptWorkspace` | `src/workspace/worktreeManager.ts:18-25`：`join(runDir,"worktrees",\`attempt-${attempt}\`)` + `mkdir` + `git worktree add --detach` | **两个条目**：`worktrees/` 目录本身，以及其下 `attempt-N/` 目录 | 有界（每 attempt 一个） |
| 2 | *** **用户自带命令（`sh -lc`）** *** | *** `src/controller/runLoop.ts:169-170`：`execFileAsync("sh", ["-lc", command], { cwd: worktreePath })` *** | *** **任意内容、任意名字、任意深度 —— cwd 就在 `<runDir>/worktrees/attempt-N/` 里** *** | *** **无界** *** |
| 3 | `observeChangedPathsBestEffort` | `runLoop.ts:499-502`：`execFileAsync(git…, { cwd: worktreePath })` | 只读 git 查询；git 自身可能在 worktree 内落 `index.lock` 等 | 有界 |
| 4 | Claude 适配器子进程 | `src/runtime/claude/subprocessClaudeAdapter.ts:25` `spawn(...)`，`:104/:119/:141` 传 `context.worktreePath` | 由被驱动的代理在 worktree 内写 | 无界（同 #2 性质） |

**回收侧（对称记账）**：`cleanupAttemptWorkspace`（`worktreeManager.ts:30`，`git worktree remove --force`）
与 `resumeLoop.ts` 的 `cleanupResidualWorktrees`（`readdir(join(runDir,"worktrees"))` 后**逐条**
`cleanupAttemptWorkspaceBestEffort`）。**两者都只会对 `worktrees/` 的直接子项调用
`git worktree remove --force`。**

*** **回答控制器的第 3 问：除 worktree 本身外，有别的写入者，而且是无界的 —— 用户自带命令。** ***
**它是否会成为 `ensureFreshRunDir` 的绊脚石？会，但需要一步额外的条件。** 可构造场景：

1. 用户命令的 cwd 是 `<runDir>/worktrees/attempt-1/`。它执行 `echo x > ../leftover`
   （或任何 `../` 逃逸写），文件落在 **`<runDir>/worktrees/leftover`** ——
   **`worktrees/` 的直接子项，但不在任何 worktree 内部**。
2. `git worktree remove --force <runDir>/worktrees/attempt-1` **删不掉它**（不在那个 worktree 里）。
3. resume 时 `cleanupResidualWorktrees` 会对 `leftover` 调
   `git worktree remove --force <runDir>/worktrees/leftover` ——
   **它不是一个 worktree，命令失败** → 走 `cleanupAttemptWorkspaceWithStatus` 的 `catch` →
   落 `workspace_cleanup_failed` 事件、记 `retained`（`runLoop.ts:329-339`）→ **文件永久留下**。
4. 此后 `<runDir>/worktrees/` **永远非空** ⇒ `ensureFreshRunDir` 的第 5 个 guard **永远抛**。

**但它今天不构成新的功能性破坏**，理由要说准：`ensureFreshRunDir` 只在
`initializeRunFiles`（`runLoop.ts:946`，全 `src/` 唯一调用点）里跑，即**只在一个 runDir 上开新 run 时**。
到那一刻 `loop-state.json` 早已存在，**guard 1–3 会先抛**，错误标签是 `loop-state.json` 而不是 `worktrees`。
⇒ **`worktrees/` 残留在今天是被更早的 guard 遮住的**，它是**第二道绊索，不是第一道**。

*** **对 L5 spec §4.2 授权面的直接后果（这才是这条的价值）** ***：

- **`worktrees/` 不该进 §4.2 的授权面。** spec §4.5 `:320` 已经明确把
  「任何 `worktrees/` 下的条目（它归 run 生命周期，不归 GC）」列为非授权，**这个判断是对的**，
  而且我这次给它补上了一条它自己没给的理由：**那里的内容有一个无界写入者（用户命令），
  L5 无法为它建立任何「可删」判据** —— 你无法区分用户的产物与垃圾。**支持 spec 的现状，不建议改。**
- **但 §4.2 的判据措辞会误伤。** §4.2 `:282` 要求目标「匹配五段形**且**位于**一个 run 目录内**」。
  用户命令**完全可以**在 `<runDir>/worktrees/attempt-1/` 下写出一个**碰巧是五段形**的文件
  （名字无限制）。若「位于一个 run 目录内」被读成「run 目录树下的任何位置」，
  **L5 会把用户产物判为可删**。这使我原先的 **Important-2（N1）更尖锐**，见 §7。
- **`attempts/` 是同构的一条**（同为名字无关 guard），但它的写入者只有
  `fileStore.ts:1197` 的 `join(runDir,"attempts",String(attempt))`，**有界**，故不并列。

**顺带的真实相邻事实（不是这条线索，但同族，见 §7 的 Important-2）**：
`<runDir>/worktrees/` 的**目录本身**确实是 `ensureFreshRunDir` 的抛错源
（`directoryHasEntries`，任意 entry）。它由 `createAttemptWorkspace`
（`src/workspace/worktreeManager.ts:18-25`，`git worktree add --detach`）创建，
由 `cleanupAttemptWorkspace`（`git worktree remove --force`）与
`resumeLoop.ts:74-81` 的残留清理回收。**这条对 L5 的 GC 设计有直接后果**，见 §7。

## 2. spec 承重代码断言的逐条重推

**全部命令写进脚本用 `bash` 跑（避陷阱 4/9），`rtk proxy` 直发、未过滤、未 `tail`。**

| # | 断言 | 我的重推命令 | 我这次的输出 | 判别式 | 裁定 |
|---|---|---|---|---|---|
| 1 | `cleanupOwnerTransferStagingWithoutMarker` 清 **10** 个固定名 | **换判别式**：`awk '/^async function cleanupOwnerTransferStagingWithoutMarker/,/^}/' … \| cat -n` 后**逐行数** `await safeUnlink(` 语句 | 函数体共 24 行，第 14–23 行**逐条**是 `await safeUnlink(<x>)`，10 条，解构出的 10 个变量名与之一一对应 | 数的是**语句**，不是 `grep -c` 的**行**（本例两者恰好相等，因每行一条语句） | **✅ 10 属实**。spec §5.1、勘误的承重内容成立 |
| 2 | `releaseOwnerLease` 只有 `stop()` 一个生产调用者（INV-1 的全部依据） | `grep -rn 'releaseOwnerLease' src/ tests/`；**并加查** `scripts/ examples/ validation/` | `src/` 恰 3 行：`fileStore.ts:1175` 定义、`leaseHeartbeat.ts:16` import、`leaseHeartbeat.ts:254` **唯一调用**；`scripts/ examples/ validation/` **零命中**（同一命令对 `ccloop` 命中 3 个文件，**证明探针本身有效**，非坏探针零输出） | 数的是**含符号的行**；`src/` 内**调用点** = 1 | **✅ 成立，但必须带限定**（见下） |
| 3 | `cleanupStatus: "retained" \| "removed"` 是活的保留判定 | `grep -rn 'cleanupStatus\|workspace_cleanup_failed' src/` + 读 `cleanupAttemptWorkspaceWithStatus` | `src/runtime/types.ts:67` 字段在；`cleanupAttemptWorkspaceWithStatus`（runLoop.ts:323-340）`try` 成功 → `"removed"`，`catch` → **先 `appendEvent({type:"workspace_cleanup_failed"})` 再 `return "retained"`** | 语义按**函数体**判，不按字段名 | **✅ 语义与 spec §3.2 所述完全一致**：清理失败即保留并落该事件 |
| 4 | `writeOwnerTransferRecord` 零生产调用者、仍 `export`、`tests/` 21 处调用 | `grep -rn 'writeOwnerTransferRecord' src/` / `tests/`；两种计数 | `src/` **恰 1 行 = `:689` 定义**（`export async function`），**无任何生产调用点**；`tests/` 符号 **23**、带 `(` **21**；差额 2 = `fileStore.test.ts:23` 与 `zeroWrite.test.ts:22` 两处 import | 23 = 符号出现，21 = 带左括号 | **✅ 三项全部属实**。逐处复核见 §6 |
| 5 | `writeJsonFileViaFixedTemp` 有 **4** 个调用点 | `grep -rno 'writeJsonFileViaFixedTemp(' src/ \| wc -l` = 5，减定义行 | `:1064` transfer-pending、`:1065` owner-pending、`:1068` reconciliation-pending、`:1071` **transaction marker**；`:1120` 是定义 | 带 `(` 计数 5 − 定义 1 = **4** | **✅ 4 属实；台账「三份 pending」确实漏了事务标记** |
| 6 | `RUN_MARKER_FILES` 两条路径（至今无人核过） | `grep -rn 'RUN_MARKER_FILES' src/` + 读定义 | `scanRuns.ts:30` 定义 + `:87` 唯一消费点（`for (const marker of RUN_MARKER_FILES)`）。内容 **5 个**：`loop-contract.json`、`loop-state.json`、`events.jsonl`、`owner-record.json`、`owner-transfer.json` | 数的是**数组字面量元素** | **✅ 核过**。⚠️ 与 `ensureFreshRunDir` 的**三名**阻塞集**不是同一个集合**（5 vs 3），spec §4.2 引的是后者且引对了 |
| 7 | `OBSERVED_FILES` 两条路径 | `grep -rn 'OBSERVED_FILES' src/` + 读定义 | `observeFields.ts:5` 定义、`observeRun.ts:4/16/23` 消费。内容 **3 项**：`loop-state.json`(atomic:false)、`owner-record.json`(atomic:false)、`owner-transfer.json`(**atomic:true**) | 数的是**数组元素** | **✅ 核过**；spec §6.1 引的 `owner-transfer.json atomic:true` 属实。⚠️ **副产物见 §5 的 Important-1** |
| 8 | 分层表 `deletion` 授权只能证「只有 L5 被**显式标注**为 deletion」 | 读 spec `:398`、`:302-309` | spec `:398` 逐字写 **「⚠️ 这条只能证『只有 L5 被*显式标注*为 deletion』，不能证『只有 L5 可能删东西』。」**，`:305` 举 `git worktree remove --force` 为反例，`:307-309` 把限定落成两条设计后果 | —— | **✅ spec 守住了限定，并把它落成了可执行的后果，不只是免责声明**。正面样本 |

**#2 必须带的限定（铁律 3）**：我的检索面是 `src/` `tests/` `scripts/` `examples/` `validation/`，
**不含 `dist/`（构建产物）与 `node_modules/`**。且 —— **沿用上一轮扫描员的正确限定** ——
`src/controller/runLoop.ts` 经 `sh -lc` 跑**用户自带命令**，用户命令可以做任何事。
因此正确表述是：**「在今天的第一方源码里，`releaseOwnerLease` 只有 `leaseHeartbeat.ts` 的 `stop()`
一个调用点」**，而不是无限定的「全仓只有一个调用者」。
spec `:19` 用的是「全仓**只有 `stop()` 一个生产调用者**」——「生产」二字承担了这个限定，
**够用但偏薄**，见 §7 Minor-2。

**我没有重推的两条（自报，见 §8）**：残留面 4→7→10 的逐提交演进（`0f940ea` / `dad8a14`），
以及「该设计文档最后一次被碰是 2026-08-01、零 `Amended`」。两条都是**文档史**断言，
不是「今天的代码」断言，我把预算给了必撞项。**这在我这里是未独立复核，不是已确认。**

## 3. §4.2 授权面的代码侧外延

**问题**：spec §4.2 的删除判据要求目标「**位于一个 run 目录内**」，而全 spec 未定义该外延（N1）。
Lane 1 查文本面，我查代码面。

**(a) 今天的代码里「run 目录」实际是什么？**
**`src/` 内没有任何一处构造 run 目录的路径**（`grep -rn 'join(.*runs\|runsDir\|\.ccloop' src` **零命中**，
`src/cli` 不存在）。`runDir` 一律是**参数**，由调用方传入。代码里唯一的**识别**判据是
`RUN_MARKER_FILES`（`scanRuns.ts:30`，5 个名，任一直接存在即算 run 目录，`:87` 消费）。
其下的子目录由代码创建的只有两个：`attempts/`（`initializeRunFiles`，fileStore.ts:75）与
`worktrees/`（`createAttemptWorkspace`，worktreeManager.ts:19）。

⇒ **代码面上「run 目录」有一个现成的、可执行的定义：`RUN_MARKER_FILES` 命中的目录。**
**spec §4.2 没有引它**，尽管它就在同一份 spec §5 引过的同一批文件里。**这是 N1 在代码面的具体化路径**，
见 §7 Important-2（**评估，不动手** —— 人裁 8 第 1 条）。

**(b) `.validation-runs/<run>/` 与 `<run>/worktrees/` 会不会产生五段形临时文件？**
**从代码回答（不是从盘上看）**：

- **`.validation-runs/<run>/`：会。** `validation/v1/README.md` 逐字把 `--run-dir .validation-runs/runs/A-01`
  传给运行器，即 `runDir = .validation-runs/runs/A-01`。§1.1 已证 5 个原子写目标全是
  `join(runDir, <literal>)` ⇒ temp 落在 `.validation-runs/runs/A-01/.loop-state.json.<pid>.<t0>.<n>.tmp`。
  **这条是「代码必然产生」，不依赖盘上现在有没有。**
- **`<run>/worktrees/`：不会（第一方代码路径下）。** 理由见 §1.3 的三段结构性论证。
  **唯一的例外是 `runLoop.ts` 经 `sh -lc` 跑的用户自带命令**——它在 worktree 里执行，
  可以写出任意名字，包括碰巧长得像五段形的名字。**这条例外我明确不排除。**

**(c) 「INV-4 让 §4.2 赢」会不会删掉不该删的？**
**§4.2 的判据在 `.validation-runs/` 上会命中**（它就是一个 run 目录），
而 spec `:214` 引的委任状逐字禁止 `deletion or mutation of .validation-runs/`，
`:320` 又把 `.validation-runs/` 列进「非授权面」举例。
**两条在字面上打架**：§4.2 授权「位于一个 run 目录内的五段形 temp」，
而 `.validation-runs/runs/A-01/` **既是** run 目录**又**在 `.validation-runs/` 之下。
spec 没有给出这两条相撞时谁赢的裁决。**这是 N1 的代码面实例化，Important-2 的第二半。**
（人裁 8：**只评估、不动手、不重开方向讨论**。）

## 4. 临时名：源码实际生成的确切格式

**唯一裁判 = `buildAtomicTempPath` 的函数体本身**（`src/persistence/fileStore.ts:628-634`），逐字：

```ts
const ATOMIC_TEMP_PROCESS_STAMP = `${process.pid}.${Math.trunc(performance.timeOrigin)}`;  // :610
let atomicTempPathSequence = 0;                                                            // :612

export function buildAtomicTempPath(targetPath: string): string {
  atomicTempPathSequence += 1;
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${ATOMIC_TEMP_PROCESS_STAMP}.${atomicTempPathSequence}.tmp`,
  );
}
```

**关键**：`ATOMIC_TEMP_PROCESS_STAMP` **自身含一个点**（`pid` `.` `timeOrigin`）。
把它展开后，basename 的确切形态是：

```
.{basename}.{pid}.{trunc(performance.timeOrigin)}.{seq}.tmp
```

即 **前导点 + 5 个点分段**（basename、pid、timeOrigin、seq、tmp）。

**裁定**：
- **§10 第 4 条的五段形 `.{basename}.{pid}.{startTime}.{seq}.tmp` —— 正确**，
  与源码展开逐段对应（`startTime` = `Math.trunc(performance.timeOrigin)`）。
- **台账 / handoff 的四段 `.{basename}.{stamp}.{seq}.tmp` —— 作为「文件名格式」是错的**
  （它把两段并成一段），**但错得有来历**：源码常量确实叫 `ATOMIC_TEMP_PROCESS_STAMP`，
  四段写法是「按源码变量拼接层次」而非「按落盘字符串」数的。判为 **Minor**，不是事实错误。
- **§4.1「建议形式」的第三种四段写法** —— 同一类偏差，见 §7 Minor-1。

**独立重推（不照抄前几轮的命令）**：用 `node` 直接执行同一表达式，验证段数。
本 checkout 只读、未跑；此处**以源码字符串常量的字面展开为准**，
并**明写：我没有实跑一次真 run 去盘上取一个真实文件名**（属 §8 自报未完成项）。

**同族对照（`writeJsonFileViaFixedTemp` 走的是固定名，不是这条）**：
`grep -rno 'writeJsonFileViaFixedTemp(' src/ | wc -l` = **5**，其中 `:1120` 是定义，
**真调用点 4 个**（`:1064` transfer-pending、`:1065` owner-pending、`:1068` reconciliation-pending、
`:1071` **transaction marker**）。**台账「三份 pending」的说法确实漏了第 4 个（事务标记）** ——
扫描员 2 那条附带发现，**在我这里独立复现成立**。判别式：带 `(` 计数 5，减去定义行 1 = 4。

## 5. 第二份委任状的代码面兑现

**义务逐字**（`2026-07-21-stop-no-progress-stale-boundaries-design.md` §13）：
`Later cleanup design must consume stale/reconciliation output **explicitly** rather than being fused into it.`

**第一步：今天代码里 stale / reconciliation 的输出具体是什么？**（我自己重推，命令与输出）

```
grep -rn 'staleConfirmed\|staleSuspicionBasis' src/
src/runtime/types.ts:107:  staleSuspicionBasis: string[];
src/runtime/types.ts:108:  staleConfirmed: boolean;
src/controller/runLoop.ts:804,808 / :910,914   （两处生产者）
src/persistence/fileStore.ts:94,96,98          （buildSuccessfulReconciliationFromTransfer）
```

⇒ **具名答案**：
- **类型** = `ReconciliationRecord`（`src/runtime/types.ts`，符号锚点）
- **字段** = `staleSuspicionBasis: string[]`、`staleConfirmed: boolean`
  （＋ `ownershipVerdict` / `takeoverPermission` / `eligibleForContinuation`）
- **落盘面** = `<runDir>/reconciliation-record.json`，由 `writeBoundaryArtifacts`
  （`fileStore.ts:497`）经 `writeJsonFileAtomically` 发布
- **事件** = `reconciliation_write_abandoned`（fileStore.ts:486）、
  `reconciliation_published_winner_replaced`（fileStore.ts:507），落 `events.jsonl`

**第二步：spec 的 L5 是否真能「显式消费」它？**

spec **给了机制，不是只复述**：§3.4 把义务拆成三条可检验的不变式 ——
INV-3a（数据流单向：L5 只**读**已落盘输出，不调写路径）、
INV-3b（不得内联进 stale/reconciliation 的代码路径）、
INV-3c（**消费不到就不删**）；§4.3 把 INV-3b 落成「独立模块 ＋ 独立入口」；
§8.2 验收表 `:532`/`:533` 给了两条可写的测试（不 import 写路径；拿走 reconciliation 输出后断言不删）。
**这已经越过了「只在文字上兑现」的门槛。**

**但有一个具体的洞（Important-1）**：§4.3 `:296` 把 L5 的输入写成
「**已落盘的观测输出（L2 registry 的观测、reconciliation 的记录）**」。
其中「L2 registry 的观测」这条通道**在今天的代码里结构性地运不了 reconciliation 输出**：

```
OBSERVED_FILES（src/registry/observeFields.ts:5）只有三项：
  loop-state.json (atomic:false) / owner-record.json (atomic:false) / owner-transfer.json (atomic:true)
```

**`reconciliation-record.json` 与 `boundary-analysis.json` 都不在 `OBSERVED_FILES` 里。**
`src/sweep/sweepRuns.ts:100` 的注释**自己就写着**
`reconciliation-record.json is not in L2's OBSERVED_FILES at all`。
⇒ L5 若按 §4.3 的字面去「从 L2 registry 的观测里拿 reconciliation 输出」，**拿不到**；
它必须**直接读 `<runDir>/reconciliation-record.json`**，而 spec **从头到尾没有点这个文件名**
（`grep -n 'reconciliation-record.json' spec` 只在 `:199` 作为「证据类」被点名要**保留**，
**不是**作为 INV-3 的消费入口）。**义务的形状兑现了，唯一的具体消费入口没有指名，
而 spec 指的那个入口今天不通。** 分级 Important，见 §7。

## 6. writeOwnerTransferRecord 的 21 处逐处复核

**这是本轮再评审员明写未复核的一块。我逐处打开了。**
方法：`grep -n -B6 -A3 'writeOwnerTransferRecord(' <三个文件>`（**未过滤、未 `tail`**），
逐处读上下文判定它在 arrange 段还是 assert 段。

**21 处的完整分布（判别式：带左括号的调用点）**：

| 文件 | 行号 | 处数 |
|---|---|---|
| `tests/persistence/fileStore.test.ts` | 102, 250, 313, 388, 449, 509, 558, 1878, 1994, 2088, 2147, 2221, 2357, 2443, 2601, 2657 | **16** |
| `tests/controller/runLoop.integration.test.ts` | 2290, 2458（均为 `actual.writeOwnerTransferRecord(...)`，经 `vi.mock` 的 `actual`） | **2** |
| `tests/registry/zeroWrite.test.ts` | 117, 165, 170 | **3** |
| | | **合计 21 ✅** |

**逐处判定结论（三类，无第四类）**：

1. **纯 fixture 构造（全部 21 处）** —— 每一处的形态都是
   `await writeOwnerTransferRecord(runDir, {…})` 或 `(runDir, transfer.transferRecord)`，
   **无一出现在 `expect(...)` 之内、也无一被 `await expect(...).rejects` 包裹**。
   上下文一律是 arrange 段（`mkdtemp` 之后、被测函数调用之前），与
   `writeOwnerRecord` / `writeFile(".owner-transfer.pending.json", …)` 等其它 fixture 写并列。
   典型样本：`fileStore.test.ts:249-253`（写 owner record → 写 transfer → 手写三份 pending），
   `zeroWrite.test.ts:161-171`（为 registry 扫描造两个畸形 run 目录）。
2. **断言那条约束本身（「生产只许经 `finalizePendingOwnerTransfer` 发布」）的：0 处。**
   **无一处断言**该函数不得被生产调用、无一处断言它的非原子性、
   无一处断言 `src/` 内零调用者。
3. **唯一形态特殊的 2 处**（`runLoop.integration.test.ts:2290/:2458`）走
   `actual.writeOwnerTransferRecord(...)` —— 那是 `vi.mock` 工厂里拿到的**真实模块**，
   用途仍是在被测流程中途**制造**一次 owner transfer 的盘上状态，**仍是 fixture 构造**。

⇒ **spec §6.1 / RISK-1 的表述「21 处全是 fixture 构造、无一断言那条约束本身」——
在我这里逐处复核后成立。**（这是**独立复核**，不是继承再评审员的结论；
再评审员明写他未逐处打开。）**这块未复核区已关闭。**

## 7. Findings（Critical / Important / Minor 分级）

### Critical：0

**必撞项那条破坏线索不成立**（§1.3），所以本车道**没有**证伪「无界垃圾不是故障」的定性，
也就没有 Critical。spec §5.4（`:404-410`）逐字承接该定性、明写不升级、并预留了
「若后续有人找到新的功能性破坏路径，原样上报由人裁重新定性，不由实施者自改」——
**这个预留正好是我这次判词的落点，spec 已经把口子留对了。**

### Important-1 —— INV-3 的唯一具体消费入口没有指名，而 spec 指的那个入口今天不通

- **锚点**：spec §4.3 `:296`；代码侧 `OBSERVED_FILES`（`src/registry/observeFields.ts`）、
  `ReconciliationRecord`（`src/runtime/types.ts`）、`writeBoundaryArtifacts`（`src/persistence/fileStore.ts`）、
  `sweepRuns.ts` 的自证注释。
- **可构造的场景**：L5 实现者照 §4.3 字面办事 —— 「输入是 L2 registry 的观测」——
  去 `observeRun` 的返回里找 reconciliation 输出。`OBSERVED_FILES` 只有三项，
  `reconciliation-record.json` 不在其中，他拿到 `undefined`。
  此时 **INV-3c「消费不到就不删」会让 L5 永远不删任何东西**（最好的情形，义务落空但无害），
  或者他自行去读一个 spec 没授权他读的文件（次坏），或者他把
  `reconciliation-record.json` 加进 `OBSERVED_FILES` —— **那会改动 L2 的读行为**，
  而 `observeFields.ts:5` 上方的注释明写这类改动「outside that branch's scope」。
- **为什么重要**：这是**第二份委任状的核心义务**（`explicitly` 一词是人裁点名的）。
  义务的**形状**兑现了（INV-3a/b/c ＋ 两条验收），**唯一的具体入口**没兑现。
- **分级依据**：不是数据丢失，也不是承重前提被证伪 ⇒ 不是 Critical；
  是「关键约束缺一个可执行的落点，实现者按字面办事会走进死路」⇒ Important。
- **修法建议**：在 §4.3 或 §3.4 点名消费入口 = `<runDir>/reconciliation-record.json`
  的 `staleConfirmed` / `staleSuspicionBasis` 字段（`ReconciliationRecord`，`src/runtime/types.ts`），
  并**明写它不在 `OBSERVED_FILES` 里、L5 不得为此改 `OBSERVED_FILES`**。

### Important-2 —— 「位于一个 run 目录内」在代码面有现成定义未被引用，且与 `.validation-runs/` 禁令相撞

- **锚点**：spec §4.2 `:282`「且位于一个 run 目录内」；`:214` 与 `:320` 的 `.validation-runs/` 禁令；
  代码侧 `RUN_MARKER_FILES`（`src/registry/scanRuns.ts`）。
- **可构造的场景**：`.validation-runs/runs/A-01/` 是一个真 run 目录
  （`validation/v1/README.md` 把它作为 `--run-dir` 传入；`RUN_MARKER_FILES` 必然命中它），
  §1.1 已证原子 temp 必然落在它的根下。L5 实现者按 §4.2 三条判据检查：
  五段形 ✅、位于 run 目录内 ✅、进程已死 ✅、无进行中事务 ✅ ⇒ **判为可删**。
  而 `:214` 引的委任状逐字禁止 `deletion or mutation of .validation-runs/`。
  **spec 没有裁决这两条相撞时谁赢。**
- **为什么重要**：这正是人裁 8 第 1 条 N1「授权面外延未封口」在代码面的**实例化**——
  它不是抽象的措辞问题，有一个今天就能构造出来的具体目录。
- **分级依据**：「读者按字面办事会删掉不该删的东西」在分级校准里被列为 Critical 的判据之一。
  **我压到 Important**，理由有二且都写明：(1) 人裁 8 已经把 N1 记录在案并明令**先不改**，
  这条是给它补代码面证据、不是新开一条；(2) `.validation-runs/` 目前无第一方代码
  自动创建，需要人工跑验证脚本才存在，触发要多一步人为前提。
  **若人裁认为该升级，证据齐备，我不反对升级。**
- **修法建议（评估，不动手）**：给「run 目录」一个引 `RUN_MARKER_FILES` 的可执行定义，
  并在 §4.2 上加一条**排除项优先于授权项**的裁决（禁令 > 授权），
  顺序按人裁 8 第 2 条：**先封 N1，再补 INV-4 进 §8.2 验收表，不得跳过 N1 直接补表。**

### Important-3 —— spec §4.2 的「够不着」论证里，把两类 guard 合并成了一句，论据是坏的（结论仍对）

> **新增（控制器复核后，2026-08-07）。** 我自己犯了同一个错（§1.2 Amended），
> 订正后回头查 spec，发现**同型错误也在 spec 的承重论证里**。

- **锚点**：spec §4.2 `:271-272`；代码侧 `ensureFreshRunDir` / `directoryHasEntries` / `pathExists`
  （均在 `src/persistence/fileStore.ts`，符号锚点）。
- **原文逐字**：
  > `ensureFreshRunDir` 只对三个具名文件（`loop-contract.json`、`loop-state.json`、`events.jsonl`）
  > 加 `attempts/`、`worktrees/` 两个目录的条目做阻塞 —— **临时名不在其中**；
- **哪里错**：末句「**临时名不在其中**」被写成对**整个 guard 面**的判断。
  它对前三个（`pathExists`，**名字精确**）成立；
  对后两个（`directoryHasEntries` = `readdir().length > 0`，**名字无关**）**不成立** ——
  在 `attempts/` 或 `worktrees/` 里，**临时名恰恰「在其中」**，因为那两个 guard 根本不看名字。
- **结论是否受损**：**不受损。** 「`ensureFreshRunDir` 够不着那些原子 temp」这个结论**对**，
  但正确的理由是 **§1.3 的理由 2（5 个调用点的目标全在 runDir 根，不在这两个目录下）**，
  **不是** spec 写的「临时名不在其中」。⇒ 典型的**「论据腐坏、结论未腐坏」**。
- **可构造的场景（为什么这不是 nitpick）**：下一轮读这份 spec 去划 L5 授权面的人，
  会拿 §4.2 的这句话去回答一个相邻问题 —— 「`worktrees/` 下那个五段形文件，
  `ensureFreshRunDir` 管不管？」。按 spec 的字面他会答**「不管，临时名不在其中」**，
  **而正确答案是「管，而且任何名字都管」**（§1.2 已给完整函数体）。
  他据此会低估 `worktrees/` 残留的后果，进而可能把它划进「无害垃圾」。
- **为什么重要**：§4.2 是**全 spec 唯一一个明确授权的删除面**，这句话是它「为什么现有清理路径
  够不着」的两条支柱之一。支柱的**判据类型**说错了，而 §4.5 的边界判断正好靠同一片区域。
- **分级依据**：不是数据丢失、不是承重结论被证伪 ⇒ 不是 Critical；
  是**承重论证的判据说错，且错的方向会让读者低估一个真实约束** ⇒ Important。
  （本仓库既有先例把「论据腐坏、结论未腐坏」按此档记账。）
- **修法建议**：把那一句拆成两类写，例如 ——
  「`ensureFreshRunDir` 有五个 guard：三个是**按名精确**的文件存在性检查
  （`loop-contract.json` / `loop-state.json` / `events.jsonl`），临时名不在这三个名字里；
  另两个是 `attempts/` 与 `worktrees/` 的**目录非空**检查（`directoryHasEntries`，**与名字无关**）。
  原子 temp 够不着它们的真正理由是**位置**而非名字：5 个原子写目标全是 `join(runDir, <字面量>)`，
  temp 恒落在 runDir 根，不在这两个目录之下。」

### Important-2 的补强（不新增一条，就地加证据）

§1.4 给 Important-2 补了一个**比 `.validation-runs/` 更容易构造**的实例：
`runLoop.ts:169-170` 的 `execFileAsync("sh", ["-lc", command], { cwd: worktreePath })`
让**用户自带命令以 `<runDir>/worktrees/attempt-N/` 为 cwd** 运行，
它写出的文件名**不受任何约束**，可以碰巧是五段形。
若 §4.2 的「位于**一个 run 目录内**」被读成「run 目录树下任意位置」，
**L5 会把用户在 worktree 里的产物判为可删。**
⇒ N1（授权面外延未封口）**不只是措辞问题，有两个可构造实例了**。
**分级仍维持 Important**（人裁 8 第 1 条已把 N1 记录在案并明令先不改）；
**但我把「若人裁认为该升级、证据齐备」这句话在此重申一次，且证据比上一版强。**

### Minor-1 —— §4.1「建议形式」的四段写法与源码五段不一致

`ATOMIC_TEMP_PROCESS_STAMP` 自身含点，按变量层次数是四段、按落盘字符串数是五段。
spec `:381` 已经在 §5.2 给出正确的五段裁定并点明源码，**内部已经自洽**；
§4.1 的四段属残留。可延后。

### Minor-2 —— `releaseOwnerLease` 全称否定的限定偏薄

spec `:19`「全仓**只有 `stop()` 一个生产调用者**」靠「生产」二字承担限定。
本仓库一轮内出过 6 次「用收窄的搜索面支撑全称否定」，建议把检索面写进去
（`src/ tests/ scripts/ examples/ validation/`，不含 `dist/` `node_modules/`），
并沿用扫描员对 `sh -lc` 用户命令的限定。**结论本身属实**（§2 #2 已重推）。

**Minor 计数：2。**

### 记为正面样本（不重报为缺陷）

1. spec §5.3 `:398` 对分层表 `deletion` 授权**主动下了限定**，并在 §4.4 把限定**落成两条设计后果**
   （删前重新观测、目标已不存在不报故障），不是免责声明。
2. spec §6.1 `:450-461` **先给判别式再给数字**（23 符号 / 21 调用 / 差额 2 = 两处 import），
   我逐项重推**全部吻合**。
3. spec §5.4 `:409` 预留了「若后续有人找到新破坏路径，原样上报由人裁重新定性」——
   我这次的判词正好落进这个预留里，口子留对了。
4. §4.2 `:271-272` 对 `ensureFreshRunDir` 的描述（三个具名文件 ＋ `attempts/`/`worktrees/` 两个目录条目，
   临时名不在其中）与我读到的源码（`fileStore.ts:49-71`）**逐条吻合**。

## 8. 我没做完的事（自报，逐条）

1. **残留面演进 4 →(`0f940ea`) 7 →(`dad8a14`) 10、两笔都在 2026-08-02** —— **未重推**。
   我把预算给了必撞项。**这在我这里是未独立复核，不是已确认。**
2. **「该设计文档最后一次被碰是 2026-08-01、零 `Amended`」** —— **未重推**（同上）。
3. **未实跑任何一次真 run**，也未在盘上取一个真实的原子 temp 文件名。
   §4 的格式裁定是**源码字符串常量的字面展开**，不是实测文件名。
   （包 1 授权面禁改 `src/`/`tests/`，本 checkout 只读；我也**未做变异注入**。）
4. **未跑测试套件 / typecheck / build** —— 沿用控制器基线
   （30/30 文件、514/514 测试、三个 EXIT=0）。**这在我这里是未独立复核。**
5. **未查 `dist/`** —— 它是构建产物，我判为非源码面，但这意味着我的全称否定
   （`releaseOwnerLease`、`writeOwnerTransferRecord` 零生产调用者）**不覆盖 `dist/`**。
6. **`sh -lc` 用户自带命令这条口子我没有也无法穷举** —— 所有「`src/` 内不产生 X」的断言都不覆盖它。
7. **spec 551 行我没有逐行通读**，我是按断言类型 grep 提取的（命令见 §2/§3/§5）。
   **可能漏掉未被我的模式命中的事实断言。**
8. **§5 的「stale 检测」一侧我只查到 `ReconciliationRecord` 的两个字段**，
   没有独立确认仓库里是否另有一条与 reconciliation 并列的、独立的 stale 检测输出面。
9. **（Amended 新增）§1.4 的 `../` 逃逸写场景我是静态推理，未实跑验证。**
   具体没验的两点：(a) `git worktree remove --force` 对一个**非 worktree 的普通文件**路径
   究竟报什么错、是否一定进 `catch`（我从 `cleanupAttemptWorkspaceWithStatus` 的
   `try/catch` 结构推断它进 `catch`，**但没有实跑 git 确认这一点**）；
   (b) 我**没有**穷举 `subprocessClaudeAdapter` 驱动的子进程在 worktree 内的实际写行为。
   ⇒ §1.4 的「无界写入者」这个**定性**我有把握（cwd 就是 worktree，命令内容不受约束），
   但那条**四步可构造场景**的第 3 步**是未实测的推断**，请按此看待。

### 本次 Amended 的自我记账（对称，本仓库规矩）

**我犯的错**：把 `ensureFreshRunDir` 的 guard 面**读窄了**——只用了三个 `pathExists` guard，
漏掉两个 `directoryHasEntries` guard **性质不同**这一点，并据此下了一条**结构性否证**
（「名字层面就不可能相等」）。**这正是本仓库铁律 3/4 反复点名的形状**：
用一个覆盖不全的观察面去支撑一条结构性断言。
**由控制器复核抓出，我复核了他的证据（原样打出两个函数体）后认领。**
**判词未因此改变**，但**理由 3 已作废、报告中三处（§0.1 / §1.2 / §1.3）已就地留痕订正、未改原件。**

**控制器同时自报了一个坏探针**（`awk '/interface ReconciliationRecord/,/^}/'` 零输出，
实为 `export type` 不是 `interface`，见 `src/runtime/types.ts:106`）。
**这是本轮第三次「坏探针差点证成不存在」**（前两次：控制器的三层引号交替模式、
我的 120s 超时截断 grep）。**三次全部发生在下全称否定的那一步上。**

## 9. 预算（Rule 6）

**破了。** 单任务预算 12,000 token，本任务实际消耗**约 55,000 token**（≈ **4.5×**）。
**（Amended：控制器复核后的订正轮又花了约 12,000 token —— 一次订正轮就用掉一整个预算，
如实计入，不摊薄。）**

**破在哪里**：必撞项要求「枚举全部调用点 + 回溯间接路径 + 读三处实现 + 三选一给证据」，
§6 又要求逐处打开 21 个测试调用点并给未过滤输出 —— 单是 §6 那一次
`grep -B6 -A3` 的未过滤输出就约 6,000 token。**铁律 2（验证跑绝不过滤输出）与
Rule 6 在本任务上直接冲突，我选择服从铁律 2 并在此明写超支**，而不是靠 `tail`/摘要压预算。
本轮已有两名 agent 明写超预算 2–3×；**我超得比他们更多，如实上报。**

**一次真实的坏探针**：首轮 `grep -rn 'releaseOwnerLease' .`（排除 node_modules/.git/dist）
**跑满 120s 超时被移到后台**，输出在第 137 行被截断。我**没有**据此下任何结论，
改用按目录收窄的探针重跑，并加了一条**必命中的 sanity 探针**（`ccloop` → 3 个文件）
证明新探针的检索面是活的 —— **零输出先验命令本身**（铁律 4），已照做。
