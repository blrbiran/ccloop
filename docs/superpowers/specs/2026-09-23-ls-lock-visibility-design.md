# 设计：让操作员看得见卡死的 owner-transfer 锁（人裁 85 ＋ I-3）

> **观测锚点** ＝ 提交主题行 `docs(handoff): stop calling E1's I-2 the next thing, and hand over what this round measured` 那一笔。
> 本文引用的**每一个**行号、字节数、条数都在该锚点上现测得到；**引用前必须重测**。
> 本文不写任何当前哈希（提交本文这个动作就会移动 HEAD，人也会自己推远端）。
>
> ⚠️ **本文是第二版。** 第一版经独立评审判 **4 Critical / 11 Important / 9 Minor**，
> 控制器逐条复核后**全部成立**。第一版从未提交、从未为真、未发布 ⇒ 按注释铁律就地重写。
> 被推翻的四条第一版结论逐条记在 §10，**不让已知为假的说法流到下一轮**。

---

## 0. 本轮的人裁

| 编号 | 内容 |
|---|---|
| **85**（2026-08-21） | R3′「`ls` 也报锁：要，但另开一轮」 |
| **121**（2026-08-28） | 挂账里先动 E1 的 I-2 ＋ 人裁 85 |
| **126**（2026-08-28） | E1 的 I-2 与人裁 85 的设计另开会话 |
| **129**（2026-09-23） | **范围**：人裁 85 与 I-3 合并为一轮 |
| **130**（2026-09-23） | **深度**：实施 → 外派独立评审 → 修复 |
| **131**（2026-09-23） | `ls` 报**全量七态**，复用 `inspectOwnerTransferLock` |
| **132**（2026-09-23） | 红线函数的 `not-determined-dead` **分格**，调用点对「活性未定」那一格报真话 |
| **133**（2026-09-23） | 分格走**新错误类型**路线（而非只换 message），补齐全部路由点 |
| **134**（2026-09-23） | 本会话越过 Rule 6 的 T2 继续做完整条 task；授权控制器自行提交（**push 仍归人**）、自行处置执行中的问题、最后统一报审 |

⚠️ **人裁 88 未被人裁 134 覆盖**：改既有判据仍需人**指名到具体测试**。
本轮处置 —— **优先「只加不改」**（人裁 119 的先例）；真改不可免时逐条记台账、**不放宽**、
并在最终报告里**单列**给人复核。**本轮的设计目标之一就是把既有判据改动面压到零**（见 §3.4、§4.2）。

---

## 1. 现测更正：台账 §32 对 I-3 的描述已过期

台账 §32（2026-08-25）记：I-3 的「最小修法并不小 —— 要让 `tryRecoverStaleOwnerTransferLock`
把为什么返回 false 告诉调用方，而它现在是 `Promise<boolean>`」。

**现测（本轮锚点）：它已经不是 `Promise<boolean>`。** `src/persistence/fileStore.ts:1040`：

```ts
type StaleOwnerTransferLockOutcome =
  | { kind: "cleared" }
  | { kind: "not-determined-dead" }
  | { kind: "unattributable"; why: "unparseable" | "no-pid-holder" };
```

返回类型已由 I-3(b)／人裁 106、111 那条线改掉。**台账 §32 那句话作为「今天的现场」为假**，
作为 2026-08-25 的实测保留。⇒ **本轮不需要改返回类型，只需要给它加一格。**

## 2. I-3 今天的真实缺口

`unattributable` 那一支已由人裁 106 修好。剩下的缺口正是 `fileStore.ts:1379` 起那条
**人裁 108 的 ERRATUM**（⚠️ 不是人裁 127 那条，那条在 `:1390` 起）自己记下的三格：

> `pid:0`、越界 pid、EPERM 拒绝 —— 它们走 `not-determined-dead`，抛
> `"owner transfer already in progress"`，与「真有活人正在转移」**逐字不可区分**。

⚠️ **人裁 108 的 ERRATUM 说这三格「none of them will ever clear on its own either」——
这句对 EPERM 格是【过强】的**（见 §4.5）。本轮**不把这句过强断言变成运行时行为**。

---

## 3. `ls` 侧（人裁 85／131）

### 3.1 新模块 `src/unlock/lockRows.ts`

放在 `inspectLock.ts` 旁边，因为它是同一个读实现的**第二个消费方**（第一个是 `unlockCommand.ts`）。

```ts
type ReportedRunRow = RunObservation & { lock: LockInspection };
export type ReportedScanRow = ReportedRunRow | ScanIssue;

export function attachLockInspections(
  rows: ScanRow[],
  deps: { inspect(runDir: string): Promise<LockInspection> },
): Promise<ReportedScanRow[]>;
export const defaultLockRowDeps = { inspect: inspectOwnerTransferLock };
```

⚠️ **类型必须写成 `ReportedRunRow | ScanIssue`，不能写成 `ScanRow | (RunObservation & { lock })`。**
后者因为 `ScanRow = RunObservation | ScanIssue`（`src/registry/scanRuns.ts:17` 现测），
union 在赋值方向塌回 `ScanRow`、在属性访问方向 `row.lock` 仍报错 ⇒
**§3.4 具名决定 B（每个 run 行都带 lock）会失去类型层的执行机制**。
写成前者，`row.kind === "run"` 一窄化就拿到 `lock`，决定 B 变成**编译期事实**。

纯函数 ＋ 注入依赖，照抄 `scanRuns`／`defaultScanDeps` 与 `sweepRuns`／`defaultLockPresence`
的既有形状（run-registry spec §3 #1）。只对 `kind === "run"` 的行调 inspector；`ScanIssue` 行原样穿过。

### 3.2 registry 的改动面（**现测逐处，不是「仅追加」**）

- `src/registry/types.ts`、`scanRuns.ts`、`observeRun.ts`：**一个字节都不动**。
- `src/registry/renderRuns.ts`：**改 3 处 ＋ 追加 1 个渲染分支** ——
  `ScanResult.rows` 的类型（`:10`）、`toScanResult` 的参数类型（`:14`）、
  `renderRunRow` 的参数类型（`:39`），外加锁块的渲染分支。
  ⚠️ `schemaVersion` **保持 1，不动**（见 §3.4 具名决定 A）。

**接受的新耦合**：`renderRuns.ts` 对 `LockInspection` 与 `ReportedScanRow` 做 **type-only import**，
即 `src/registry/` → `src/unlock/` 的**类型方向依赖**。`import type` 会被擦除，不产生运行时环
（⚠️ 需确认：`sweepRuns.ts:14` 从 `renderRuns` **值导入** `scanRootFailureDetail`，
所以 `renderRuns` 不能对 `unlock` 产生值导入）。
备选是在新模块里另写一份表格渲染 —— 那是第二份渲染实现，比这处类型耦合坏得多。

⚠️ **不改 `scanRuns.ts` 的 `ScanRow` 做得到**，理由现测：`ScanResult`（`renderRuns.ts:10`）、
`toScanResult`（`:14`）、`renderRunRow`（`:39`）**三个都住在 `renderRuns.ts`**，不在 `scanRuns.ts`。

### 3.3 为什么方案 B（独立一层）而不是注入进 `scanRuns`

`sweep` 也跑 `scanRuns` —— 现测 `src/sweep/sweepRuns.ts:12`
（`import { scanRuns as defaultScan, ... }`）、`:116`（`const scan = deps?.scan ?? defaultScan;`）、
`:121`（`const rows = await scan(options.root, scanDeps);`）。

把 inspector 做成 `ScanDeps` 的依赖，**`sweep` 会被动地开始做 liveness 探测**。
要躲开就得给 sweep 传 no-op inspector —— 那是为绕开自己的设计而造的洞。
独立一层让 `sweep` 完全不受影响。

### 3.4 输出契约

锁**挂在 run 行内**，不做平行数组（平行数组逼消费者按 path 自己 join，渲染也要 join，两处都能错位）。

**具名决定 A —— `schemaVersion` 保持 1，不升 2。**
⚠️ **第一版写的「现测消费者为零」是假的**，现测有**两条既有判据**在钉它：

| 判据 | 坐标 |
|---|---|
| `it("emits a parseable ScanResult with schemaVersion 1 under --json", ...)` | `tests/cli/cli.test.ts:141`，断言在 `:154` |
| `it("stamps schemaVersion 1 and carries the rows through unchanged", ...)` | `tests/registry/renderRuns.test.ts:80`，断言在 `:82` |

升 2 会打红这两条 ⇒ 必须走**人裁 88** 的指名程序。而升版本的收益（告诉消费者行的形状变了）
**已由锁块自身的存在提供** —— 旧消费者读旧字段不受影响，新消费者看得见 `lock` 键。
⇒ **按「需要新覆盖时先想能不能只加不改」（人裁 119 的先例）撤回第一版的升版本决定。**

**具名决定 B —— 每个 run 行都带 `lock`，包括 `state: "absent"`。**
「这个 run 没有锁」是信息；**行里没有 `lock` 键**会被读成「没测过」。
与 run-registry spec §15 #1「no row is ever omitted」同一个理由。**由 §3.1 的类型在编译期执行。**

**具名决定 C —— `renderScanTable` 顶上那句运行时 notice 不动。**
它说的是 **fields**，锁块不是 field，所以它不因本轮变成假话。

**具名决定 F —— `ls` 不复制 `unlock` 的散文措辞。**
现测 `src/unlock/unlockCommand.ts:172-240`：`ccloop unlock` 已为七态各写了一套诚实措辞
（liveness-unknown 那条还写明「"unreadable" would be a false statement」）。
⇒ `ls` 只报**结构化状态名 ＋ 各态自有字段 ＋ 下一条命令**，散文留给 `unlock`。
两个命令对同一把锁**不可能分叉，因为 `ls` 压根不说那些话**。

### 3.5 七态各渲染成什么（**人裁 131 要全量七态，逐态定死**）

`digest` **渲染全量 sha256，不截断** —— 它是 `unlock --force --expect` 的凭证，截断会让操作员
没法直接复制。`identity`（dev/ino）**不渲染**：它是删除前的再校验用的内部事实，对操作员无意义。

```
  owner-transfer.lock
    state: absent
```
```
  owner-transfer.lock
    state: dead | alive
    holder: pid:12345
    pid: 12345
    digest: <64 hex>
    next: ccloop unlock /runs/run-1
```
```
  owner-transfer.lock
    state: liveness-unknown
    holder: pid:1
    pid: 1
    reason: EPERM
    digest: <64 hex>
    next: ccloop unlock /runs/run-1
```
```
  owner-transfer.lock
    state: unrecognized-holder
    holder: ["pid","1"]
    digest: <64 hex>
    next: ccloop unlock /runs/run-1
```
```
  owner-transfer.lock
    state: unparseable
    reason: <parse detail>
    digest: <64 hex>
    next: ccloop unlock /runs/run-1
```
```
  owner-transfer.lock
    state: file-unreadable
    reason: <io detail>
    next: ccloop unlock /runs/run-1
```

⚠️ `file-unreadable` 是**唯一没有 digest 的态**（`inspectLock.ts:128-131` 现测注释说明：
凭证是文件字节的哈希，而这些字节读不到）⇒ 它的块里**不许出现 `digest:` 行**。
`absent` 态**不渲染 `next:`** —— 没有锁要清。

### 3.6 退出码（**码值不变，含义变宽 —— 两句话分开说**）

- **码值集合不变**：`ls` 仍只返回 0／1，永不 2（`src/cli.ts:276-291` 现测）。
- **`exit 1` 的含义变宽**：从「扫描自身失败」放宽为「扫描自身失败**或**锁层抛了未预期的异常」。
  ⚠️ 依据：`src/cli.ts:352-356` 的外层 catch 把**任何**抛出映射成 1。
  现测锁层**无已知抛出点** —— `inspectOwnerTransferLock`（`inspectLock.ts:141-230`）把
  `open`/`stat`/`readFile` 全包在一个 try 里（ENOENT→`absent`，其余→`file-unreadable`），
  `JSON.parse` 单独包，`classifyHolderLiveness` 是全函数 try/catch。
- **判据**：一把 EACCES 的锁文件 ⇒ 该行 `state: file-unreadable` ⇒ **exit 0**。

### 3.7 被本轮具名推翻的已发布原则（**三条，不是一条**）

1. `src/sweep/lockPresence.ts` 的「judging liveness in a reporting path puts a decision where an
   observation belongs」（board C-d）—— **推翻它对 `ls` 的适用**。⚠️ **对 `sweep` 自身仍然成立**（§6）。
2. run-registry spec `docs/superpowers/specs/2026-07-28-run-registry-design.md:181`：
   「There is no "can this be resumed" column, and **no derived field of any kind**.」
3. 同文件 `:573` §15 #3：「The output contains **no derived judgment** about eligibility,
   resumability, or lease freshness — **enforced by a test**, not by convention.」

⚠️ 第 2、3 条管的正是**输出形状**，而 `lock.state ∈ {dead, alive, liveness-unknown, ...}`
**就是**一个 derived judgment，而且进的是 `toScanResult` 的序列化输出。**三条都引人裁 131 具名推翻。**

⚠️ **实测预警**：§15 #3 自称「enforced by a test」，但那条判据（`tests/registry/renderRuns.test.ts:96-104`
现测）只禁 `/resumable|fresh|stale|expired/i` 和 `eligible`，**`lock`／`state` 一个都不撞 ⇒ 它会照绿**。
而它的注释自己写着「The test's real target is a future well-meaning derived column」——
**本轮就是那个 future column。** 本文必须写明这一点，否则下一轮评审会把「它照绿」当成没问题的证据。

⚠️ `src/registry/types.ts` 那条「观测类型不带派生含义」**不被推翻** ——
方案 B 让锁块不进 `FieldObservation`，该原则对 registry 的**观测类型**继续成立。

---

## 4. I-3 侧（人裁 132／133）

### 4.1 三态判别下沉到 `fileStore.ts`（**这一步是为了不闭合循环依赖**）

⚠️ **第一版说「红线函数调 `inspectLock.ts` 的 `classifyHolderLiveness`」—— 那会闭合一个值级循环。**
现测：`fileStore.ts` 的 7 行 import 里，跨 `src/` 的**全部是 `import type`**（对 `src/` 零值导入）；
而 `inspectLock.ts:72` **值导入** `parsePid` 与 `OWNER_TRANSFER_LOCK_FILE`。
本仓库对此有具名先例 —— `fileStore.ts:438`：

> 「Bound and delay are this module's own, **deliberately NOT imported** from the controller's
> `OWNER_TRANSFER_LOCK_RETRY_*` : runLoop.ts imports this file, so **importing back would close a cycle**.」

**为了不闭合循环，仓库宁可复制两个常量。** ⇒ 反向导入不在桌上。

**修法（零既有判据改动）**：

- 在 `src/persistence/fileStore.ts` **新增** `export type LivenessVerdict` 与
  `export function classifyProcessLiveness(pid: number): LivenessVerdict`（三态，**逻辑与今天
  `inspectLock.ts:98-119` 逐字相同**）。
- `src/unlock/inspectLock.ts` 的 `classifyHolderLiveness` 与 `LivenessVerdict`
  **改为从 `fileStore.ts` 导入并原样转发／re-export**，**导出名与行为一字不改**。
  ⚠️ 现测 `classifyHolderLiveness` **零判据消费者**（只有 `inspectLock.ts:224` 内部调用）
  ⇒ 这一步**不打红任何既有判据**。
- **`isProcessActive` 保持 boolean、定义一字不动** ——
  现测两条判据在断言它（`tests/persistence/fileStore.test.ts:1084` 的 `.toBe(false)`、
  `tests/unlock/inspectLock.test.ts:317` 的 `assertPremise`）。

方向：**L1 提供、L3 消费 —— 与今天 `parsePid` 的方向完全一致，零循环、零第二份实现。**

⚠️ `inspectLock.ts` 里大段讲「为什么这里是三态而 fileStore 是两态」的注释会因此过期
（`:32`、`:82` 起那两段）⇒ **追加具名 ERRATUM 引人裁 132，原文逐字保留。**

### 4.2 红线函数：一次 syscall，三态折叠

红线函数内部统一**只调一次** `classifyProcessLiveness(pid)`，然后自己折叠回决策：

| verdict | 决策 | outcome |
|---|---|---|
| `dead` | 清理 | `cleared` |
| `alive` | **不删** | `holder-alive` |
| `unknown` | **不删** | `liveness-undetermined`（带 `reason`） |

```ts
type StaleOwnerTransferLockOutcome =
  | { kind: "cleared" }
  | { kind: "holder-alive" }
  | { kind: "liveness-undetermined"; reason: string }
  | { kind: "unattributable"; why: "unparseable" | "no-pid-holder" };
```

⚠️ **字段名用 `reason`，与 `LivenessVerdict` 的字段名一致**（`inspectLock.ts:96` 现测）。
第一版写 `why` 与表格写「reason」自相矛盾，已统一。

⚠️ **`holder-alive` 不带 `pid` 字段。** 这个名字是人裁 106 用过、人裁 108 删掉的；本轮三态拆开后
这个名字**重新变真**（它现在真的只在 alive 时出现）。但人裁 108 删 `pid` 的理由**没变**
（`fileStore.ts:1031-1034` 现测：「nothing read it, and carrying it made the exit read as a
determination that was never made」）⇒ **只捡名字，不捡字段。**

⚠️ **为什么不能既调 `isProcessActive` 又调三态函数**：那是**两次** `process.kill(pid, 0)`，
两次之间进程状态可能改变，两个答案会自相矛盾。**一个真相源，一次 syscall。**

⚠️ **删锁行为逐格不变（五格全测，独立评审复验过）：**

| 格 | `isProcessActive` | 三态 | 今天归宿 | 改后归宿 |
|---|---|---|---|---|
| `pid:0` | `true`（`kill(0,0)` 不抛） | `unknown`（`pid<1`，**不发 syscall**） | 不删 | 不删 |
| 越界 `1e21` | `true`（`ERR_INVALID_ARG_TYPE`） | `unknown`（reason `ERR_INVALID_ARG_TYPE`） | 不删 | 不删 |
| EPERM（pid 1） | `true` | `unknown`（reason `EPERM`） | 不删 | 不删 |
| 活 pid（self） | `true` | `alive` | 不删 | 不删 |
| 死 pid（999999） | `false` | `dead` | **删** | **删** |

`parsePid` 的正则是 `/^pid:(\d+)$/`（`fileStore.ts:998` 现测）⇒ pid 恒 ≥ 0，负数格不存在，
`pid<1` 的提前返回只可能被 `pid:0` 命中。人裁 83／86 的终局措辞**一个字不改**。

⚠️ **`isProcessActive` 改完后生产调用点归零**（现测今天唯一调用点是 `fileStore.ts:1128`），
只剩两个判据 import。⚠️ `fileStore.ts:946` 那句「exported for `ccloop unlock`」**今天就已经过期**
（`unlock` 走的是 `classifyHolderLiveness`，`inspectLock.ts:72` 的 import 清单里没有它）
⇒ **追加 ERRATUM 说实话：它现在只为判据导出。留不留由人裁，本轮不删。**

### 4.3 新错误类型：平行兄弟，不做基类

```ts
export class OwnerTransferLockLivenessUndeterminedError extends Error { ... }
```

**不抽 `Unclearable` 基类**，依据是本仓库自己的既有答案 —— `resumeLoop.ts:250` 现测原文：
「a THIRD branch, written first and explicitly, because the two lock errors are siblings and
**neither `instanceof` implies the other**」，加上 `fileStore.ts:880-881` 的 doctrine
「sibling, **deliberately NOT a subclass**」。CLAUDE.md Rule 11：**conformance > taste**。

### 4.4 全部路由点（**十一处，不是七处**）

**A. 构造点（1 处，本轮必改的那一行）**

| 处 | 今天 | 改后 |
|---|---|---|
| `fileStore.ts:1396` | `if (outcome.kind === "not-determined-dead") throw new OwnerTransferLockBusyError(...)` | 拆成两支：`holder-alive` 仍抛 Busy（**逐字不动**）；`liveness-undetermined` 抛新类 |

**B. 处置点（7 处，各加一支）**

| 处 | 今天对 unattributable | 新错误 |
|---|---|---|
| `runLoop.ts:927` | 记 `owner_transfer_contended`，放弃转移、**不判 failed** | 同形，detail 换 |
| `runLoop.ts:1745` | 记 `owner_transfer_contended` ＋ `writeOwnedRunState` 后 return | 同形，见 §5.2 |
| `resumeLoop.ts:225` | detail 说「锁无法归属」而非「读不了工件」 | 第四支，detail 说「活性判不了」 |
| `resumeLoop.ts:256` | 第三支，避免谎称 CAS 失败 | 第四支，同理 |
| `leaseHeartbeat.ts:168` | 自己的事件类型，once per run，不抛进控制循环 | 同形，见 §4.6 |
| `leaseHeartbeat.ts:287` | 释放路径 | 同形，见 §4.6 |
| `fileStore.ts:1572` | **唯一逃出该 catch 的类** | 新错误**也必须逃出**（理由同：recovery can never run） |

**C. 重试闸门（3 处，见 §4.5 —— 本轮【要改】）**

`fileStore.ts:483`、`runLoop.ts:761`、`resumeLoop.ts:75`。

### 4.5 ⭐ 重试预算：新错误**必须仍被重试**（本轮最要紧的一条修正）

⚠️ **第一版漏掉了这件事，独立评审抓到，控制器复核成立。**

现测三处闸门都写着人裁 106 的具名注释 ——「re-decided this site and **deliberately left it
unchanged**: an `OwnerTransferLockUnattributableError` is not an `OwnerTransferLockBusyError`,
so it takes the abandon arm on the **FIRST attempt** instead of consuming the whole retry bound.
That is the wanted answer -- **this lock will never be released**, so every retry is dead time」。

⇒ 新错误若沿用同一条路由，`pid:0`／越界 pid／**EPERM** 三格都会在第一次尝试就放弃。

🔴 **而 EPERM 那一格的持有者很可能【活着】** —— 它只是属于别的用户，`kill(pid, 0)` 被拒。
它**会**在持有者退出时自己清掉。⇒ 沿用 unattributable 的路由会同时造成两个错误：

1. **行为回归**：一把会自清的锁丢掉了重试预算，转移在第一次尝试就放弃。
2. **假话**：操作员被告知「it will not clear on its own」，去执行一个不该执行的 `unlock`。

**修法 —— 三处闸门各加一支，让 `OwnerTransferLockLivenessUndeterminedError` 仍走重试：**

```ts
if (!(error instanceof OwnerTransferLockBusyError
      || error instanceof OwnerTransferLockLivenessUndeterminedError) || isLastAttempt) { ... }
```

**收益**：**行为与今天逐格相同**（今天这三格本来就走满重试），同时重试耗尽后操作员拿到真话。
**代价**：`pid:0` 与越界 pid 这两格仍会付一次有界的 dead time —— 但**它们今天也在付**，
所以这不是新代价。消掉它属于优化，不是本轮的正确性问题（YAGNI）。

⚠️ **措辞硬约束**：新错误的 message **不许说「永不自清」**。它必须说真话：

> `liveness of pid <n> cannot be determined (<reason>); this lock may or may not clear on its own -- inspect it with: ccloop unlock <runDir>`

⚠️ **不再把 `liveness-undetermined` 细分成「结构性永不清」与「探测被拒」两格。**
理由：上面这句措辞对三格**都为真**，而 `reason` 字段已经把它们区分给操作员看了。
再加一格只买到「省掉两格的 dead time」，是优化。**若将来要分，引本节。**

### 4.6 三处「不改代码但须具名 re-decide」的闸门

⚠️ §4.5 之外，人裁 106 当年对**每一处**闸门都写了「re-decided this site and deliberately left
it unchanged」的具名注释（`fileStore.ts:477`、`runLoop.ts:757`、`resumeLoop.ts:70`）。
本轮给同样三格换了错误类**并改了重试归属** ⇒ 那三段注释现在只说「一个类」，
**改完是两个类，且新类的归属与旧类相反**。⇒ **三段都要追加具名 ERRATUM**（引人裁 133 ＋ §4.5）。

### 4.7 `leaseHeartbeat` 的两个具名决定

**决定 D —— 给新错误自己的事件类型** `owner_transfer_lock_liveness_undetermined`。

⚠️ **第一版的论证是循环论证**（「这里有消费者」，而那个消费者是本轮自己要写的判据），
独立评审抓到，控制器复核成立。**换成能自立的论证**：
`owner_transfer_lock_unattributable` 对一把**可归属**（holder 形如 `pid:<n>`）、只是活性判不了的锁
**是一个假名**。事件名必须说真话 —— 这个理由不借人裁 119 的消费者论，也不需要它。

⚠️ 台账 `:4798` 现测：Mi-5（新事件类型无消费者）被判为「人裁 85 的账」⇒ **是本轮的挂账**。
本节即为处置：**新类型的正当性来自「旧名字是假名」，不来自消费者计数。**

**决定 E —— 两个错误各自一个 once-per-run 标志，不共用。**
否则一个 run 里先出 unattributable、再出 liveness-undetermined，**第二条会被静默吞掉** ——
那正是 I-3 要修的那种沉默。

---

## 5. 判据与变异

### 5.1 每条新分支都要有「删掉它自己」的变异

| 新分支 | 删掉它自己的变异 | 喂它的场景 |
|---|---|---|
| 只对 run 行调 inspector | 去掉 `kind === "run"` 判断 | 一个 `directory_unreadable` 行 ＋ 一个 run 行同时在结果里 |
| 每个 run 行都带 `lock` | 改成只在锁存在时挂 `lock` | 一个没有锁的 run 目录 |
| 七态各自的渲染分支（**七条**） | 逐态删掉它的渲染分支 | 七个夹具各一把锁（`file-unreadable` 用 chmod 000） |
| `file-unreadable` 不渲染 digest | 让它也渲染 digest | 一把不可读的锁文件 |
| 三态折叠的 `dead` 支 | 把 `dead` 改成不清理 | 死 pid（999999） |
| 三态折叠的 `unknown` 支 | 把 `unknown` 从「不删」挪到「删」 | `pid:0`／越界 pid／EPERM 各一格 |
| `liveness-undetermined` 新格 | 让它继续返回 `holder-alive` | 同上三格 |
| **重试闸门三处各一支（§4.5）** | 逐处删掉那条 `instanceof LivenessUndetermined` 的或支 | 一把 `pid:0` 的锁 ＋ 断言重试次数 |
| 处置点 7 处各一支 | 逐处删掉那一支 | 每处一个**只有它**会走到的场景 |
| 新事件类型 | 换回 `owner_transfer_lock_unattributable` | 一次被阻断的 lease affirm |
| 两个独立 once 标志 | 改回共用一个 | 同一个 run 里**先 unattributable、再 liveness-undetermined** |
| 三态下沉（§4.1） | 让 `inspectLock` 用回自己那份 | 行为不变 ⇒ **钉不住，见 §5.2** |

⚠️ 最后第二条的场景最难造。**先试着造；造不出来再按 I-2 轮「控制器裁决 6」的先例如实登记
「钉不住」，不编假判据**（台账 §46 `:4925`）。

### 5.2 「钉不住」的登记（**两处都改过，第一版有一处是不诚实的**）

1. **`runLoop.ts:1745` 新分支里的 `writeOwnedRunState`** —— 人裁 118 已实测 M8 删掉照绿。
   ⚠️ **但第一版直接登记「继承同一个钉不住」，那是断言不是实测。**
   注释自己点了名：「**on the path that criterion walks**，返回的 state 和落盘的 state 本来就一致」
   ⇒ 这不是「不可观测」，是「那条判据走的路径上不可观测」。
   **本仓库铁律：有办法看见就不许登记成看不见。**
   ⇒ **先尝试构造 `applyPhaseUsage` 推进过 `state` 的场景**（那时返回值与盘上值分叉，该行被钉住）；
   **构造不出再按人裁 118 登记**，并**本轮重跑 M8**（代码改了，旧变异结果不算数）。

2. ⚠️ **第一版说「换用三态函数这件事本身钉不住」—— 那是【不诚实的】，本版删掉该登记。**
   现测有**两条**独立的看见方式：
   - **reason 字面量**：三态对三格各给**不同**的 reason
     （`pid 0 does not name a process that can be probed` / `ERR_INVALID_ARG_TYPE` / `EPERM`），
     而 `isProcessActive` **一个 reason 都产不出**（返回 boolean）。
     ⇒ 只要按 §5.3 #1 钉住 detail 里的理由字面量，**换回去必然打红**。
   - **syscall 不发**：三态对 `pid < 1` **提前返回、根本不发 `process.kill`**；
     `isProcessActive(0)` 会真发。一条 `vi.spyOn(process, "kill")` 的判据直接钉住这一格零 syscall。
   ⇒ **真正钉不住的只剩 §5.1 最后一行那条**（三态实现住在哪个文件，对行为无影响）。

### 5.3 主动扫这四种「空绿」形状（**都真栽过**）

1. **只断言 verdict、不断言理由的判据看不见整支变异**（实测 104 条全绿）⇒
   十一处路由的判据**必须钉住 detail 里那个理由的字面量**，不许只断言「抛了」。
2. **断言【形状】的那条，在「换成形状合法的固定值」变异下永远绿** ⇒
   `ls` 的锁块判据要有**值**断言（`state`／`holder`／`reason` 的具体字面量）。
3. **期望值由被测函数自己算出来 ⇒ 永远红不了** ⇒
   digest 的期望值**不许调 `digestLockContents` 算**，写字面量或独立算的 sha256；
   reason 的期望值**不许调三态函数算**，写字面量。
4. **排在被测调用【之前】、读回测试自己刚写进去的值的断言，永远不可能红** ⇒
   验收每条判据前先扫这个形状。

### 5.4 零写证明必须覆盖新的读路径

⚠️ 现测 `tests/registry/zeroWrite.test.ts:216-226`：被测对象是
`await scanRuns(scanRoot, defaultScanDeps)`，**不是 `main(["ls", ...])`**；
快照口径是 `{ size, mtimeMs, sha256 }`、**有意省略 atime**（`:32-36`）。

⇒ 方案 B 把锁探测放在 `scanRuns` **之外**，`ls` 的真实读路径长出一段**没有零写证明覆盖**的代码，
而 run-registry spec §15 #2「A scan is provably byte-for-byte non-mutating」**照绿**。

**判据**：对整条 `ls` 路径（或 `attachLockInspections`）跑同一个 `snapshotTree` 前后比对。
`inspectOwnerTransferLock` 只 `open(..., "r")`，**应当能过 —— 但过了才算数**。

### 5.5 变异电池的跑法

副本 `git clone --local` ＋ **先 `npm run build`**（`dist/` 被 gitignore，不 build 会让
`tests/control/endToEnd.test.ts` 的 6 条以 `ENOENT ... dist/cli.js` **假红**）＋ 软链主树 `node_modules`。
主工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**。

⚠️ **本轮的「绿基线」不是全绿。** 定义 ＝「**红集合 ⊆ 下面这 7 条，按名字核，不数条数**」。

### 5.6 既有判据

**本轮的设计目标是把既有判据改动面压到零**，现已做到的：

- `schemaVersion` 保持 1 ⇒ 两条判据不动（§3.4）。
- 三态下沉但 `classifyHolderLiveness` 导出名与行为不变 ⇒ 零判据消费者受影响（§4.1）。
- `isProcessActive` 定义不动 ⇒ 两条断言它的判据不动（§4.1）。

⇒ **若实施中仍出现非改不可的既有判据，停下来把清单（文件／测试名／为什么必须改／改成什么）
交人按人裁 88 指名。在人指名之前一条都不动。**

---

## 6. 本轮不做什么（YAGNI ＋ 具名自决）

- **不动 `src/sweep/lockPresence.ts`。** 依据：`sweep` 用它做**决策输入**（有锁就不碰这个 run），
  boolean 在那里更保守也够用；它**不是给操作员看的报告路径**。CLAUDE.md Rule 1 第 2 档自决。
- ⚠️ **第一版写「不改重试预算语义」—— 那条已被 §4.5 推翻。** 本轮**确实动了三处重试闸门**，
  目的恰恰是**保住今天的重试行为**（不动闸门反而会改变它）。
- **不把 `liveness-undetermined` 细分成两格**（§4.5 末）。
- **不动 `isProcessActive` 的定义**；**不删它**（生产调用点归零，留不留由人裁）。
- **不给 `ls` 加任何开关。** 人裁 131 定的是默认就报。
- **不碰 `stopProof` 那条稳定红**（根因未查，无人授权）。
- **不 push、不合并、不删分支或 worktree。** 四件各自需人单独授权。

---

## 7. 注释铁律的落点

现测：本轮开工时三仓与远端一致 ⇒ 下列段落**全是已发布文本**，
**一个字不就地改，只在块末追加具名 ERRATUM**，引用人裁 131／132／133：

- `src/sweep/lockPresence.ts` 的「judging liveness in a reporting path」段
- `docs/superpowers/specs/2026-07-28-run-registry-design.md` 的 `:181` 与 `:573`（spec 是活文档，追加更正节）
- `src/persistence/fileStore.ts:881` 的「applied to a third meaning」（将变成第四种）
- `src/persistence/fileStore.ts:946` 的「exported for `ccloop unlock`」（今天就已过期）
- `src/persistence/fileStore.ts:1379` 起那条 **人裁 108** 的 ERRATUM（它记的三格正是本轮要修的；
  ⚠️ **不是 `:1390` 起那条人裁 127 的**）
- `src/persistence/fileStore.ts` 红线函数体内引用两态折叠的各段（含 `:1065-1066`）
- `src/unlock/inspectLock.ts:32` 与 `:82` 起讲「三态 vs 两态分工」的两段（§4.1 让它们过期）
- **三处重试闸门的人裁 106 注释**：`fileStore.ts:477`、`runLoop.ts:757`、`resumeLoop.ts:70`（§4.6）
- 处置点各段：`runLoop.ts:927`、`resumeLoop.ts:225`、`resumeLoop.ts:250`、
  `leaseHeartbeat.ts` 人裁 119 那段、`leaseHeartbeat.ts` 人裁 113 那段、`fileStore.ts:1568` 人裁 111 那段

⚠️ **ERRATUM 里不许写新的、会被后续裁决推翻的计数** —— 指向台账即可。
⚠️ **ERRATUM 不许引用会移动的 git 引用**（「remote tip」「HEAD」）。
⚠️ **ERRATUM 放在整个注释块的末尾。**
⚠️ **改注释前做全树扫描，扫描清单从被更正的句子机械导出，且扫描词要覆盖语料的语言**
（中文活文档不会被英文扫描词捞到 —— 2026-09-23 实测栽过）。

---

## 8. 终点判据（**每一条都是能跑出 0／非 0 的命令**）

⚠️ **第一版六条里有四条是散文，已全部改成命令。**

**判据 1 —— 红集合 ⊆ 已知 7 条（机械判定，不靠肉眼）**

```bash
./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/ccloop-run.json > /tmp/ccloop-run.log 2>&1
python3 scripts/check-known-reds.py /tmp/ccloop-run.json   # RC 0 iff 红集合 ⊆ 已知 7 条（按全名）
```
该脚本把已知 7 条的**全名**写死在表里，读 json 取实际失败的全名集合，做子集判定。

**判据 2／3**
```bash
npm run typecheck   # RC 0
npm run build       # RC 0
```

**判据 4 —— 变异电池机械判定**
一张「变异名 → 期望红的判据全名」表，逐条在副本里施加变异、跑
`vitest run <file> -t "<name>"` 并断言 **RC ≠ 0**；全部满足脚本 RC 0，任一不满足 RC 1。
⚠️ 施加变异前后各做一次 `shasum -a 256` 比对，**不相等才算落上去**。

**判据 5 —— 人裁 85 的真终点**
```bash
ccloop ls "$ROOT" > out.txt 2>&1; rc=$?
/usr/bin/grep -q 'state: liveness-unknown' out.txt && [ "$rc" -eq 0 ]
```
（`$ROOT` 下预置一把 `pid:0` 的锁。）

**判据 6 —— I-3 的真终点：两句话必须字面不同**
预置两把锁（一把 `pid:0`、一把活 pid），各触发一次 owner-transfer 获取，捕获两条 detail：
```bash
[ "$DETAIL_UNKNOWN" != "$DETAIL_ALIVE" ] \
  && printf '%s' "$DETAIL_UNKNOWN" | /usr/bin/grep -q 'cannot be determined' \
  && printf '%s' "$DETAIL_ALIVE"   | /usr/bin/grep -q 'already in progress' \
  && printf '%s' "$DETAIL_UNKNOWN" | /usr/bin/grep -qv 'will not clear on its own' \
  && test -f "$LOCK_UNKNOWN"
```

**判据 7 —— 零写证明覆盖 `ls` 全路径**（§5.4）：`snapshotTree` 前后比对，不等则 RC 1。

---

## 9. 开工基线（本轮现测，只抄工具报数）

命令 `./node_modules/.bin/vitest run`（`ECC_GATEGUARD=off DISABLE_OMC=1`，重定向到文件再整份读回），
观测锚点见本文开头。

| 项 | 值 |
|---|---|
| 全套 | **56 files / 779 tests**，1 failed / 778 passed，**0 skipped**，`TEST_RC=1`，耗时 30.55s |
| `npm run typecheck` | `RC=0` |
| `npm run build` | `RC=0` |

⚠️ 台账 §46 与 Orca 检查点都记 **777** 条，本轮现测 **779**。**引用条数前一律现测。**

### 已知红 7 条的**全名**（**brief 必须写满，判据 1 的脚本按这张表判子集**）

**稳定红 1 条（非 flake，根因未查，无人授权动）：**
1. `tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone`

**负载 flake 6 条（全部 `Test timed out in 5000ms`；红的那轮总耗时 25–29s，绿的几轮 17–22s）：**
2. `run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`
3. `runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`
4. `runLoop > accounts an execute timeout that rejects after the abort as exhaustion`
5. `run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data`
6. `SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`
7. `Codex phase process > kills a TERM-ignoring process before returning abort`

⚠️ 本轮开工那次全量跑里，第 2–7 条**全部是绿的**（只有第 1 条红）。
它们是**已知会在负载下 flake** 的名单，不是「现在红着」的名单。

---

## 10. 第一版被推翻的结论（**逐条留档，不让已知为假的说法流到下一轮**）

| 第一版说 | 现测 | 本版改成 |
|---|---|---|
| 红线函数调 `inspectLock.ts` 的 `classifyHolderLiveness` | 会闭合值级循环；`fileStore.ts` 对 `src/` 零值导入，`inspectLock.ts:72` 值导入 `parsePid`；`fileStore.ts:438` 有拒绝闭环的具名先例 | **三态下沉到 `fileStore.ts`，`inspectLock` 反向导入**（§4.1） |
| 「不改重试预算语义」 | 新错误类沿用 unattributable 路由会让三格**丢掉重试**，而 EPERM 格的持有者很可能活着、会自清 | **三处闸门各加一支，让新类仍被重试**（§4.5） |
| `schemaVersion` 升 2，「现测消费者为零」 | 现测**两条既有判据**钉住 `schemaVersion === 1` | **保持 1**（§3.4） |
| 「换用三态函数这件事钉不住」 | reason 字面量可观测；`pid<1` 不发 syscall 可用 spy 钉住 | **删掉该登记，改成两条真判据**（§5.2 #2） |
| 路由点「七处」 | 另有构造点 1 处 ＋ 重试闸门 3 处 | **十一处**（§4.4） |
| `ReportedScanRow` 写成 `ScanRow` 与 `RunObservation & { lock }` 的并 | union 塌回 `ScanRow`，`row.lock` 报错 | `ReportedRunRow` 与 `ScanIssue` 的并（§3.1） |
| 只推翻 `lockPresence.ts` 一条原则 | run-registry spec `:181`／`:573` 两条管输出形状，同样被推翻 | **三条**（§3.7） |
| 引「人裁 6」为「如实登记钉不住」的先例 | 人裁 6 在**另一本台账**，说的是「包 1 只写 `docs/`」 | 改引 **I-2 轮控制器裁决 6**（台账 §46 `:4925`）与人裁 118 |
| 「`isProcessActive` 仍为 `ccloop unlock` 与判据导出」 | `unlock` 走的是 `classifyHolderLiveness`；改完生产调用点归零 | **只为判据导出**，`:946` 追 ERRATUM（§4.2） |
| `fileStore.ts:1380` 是「I-2／人裁 127 的 ERRATUM」 | `:1379` 起是**人裁 108** 那条；`:1390` 起才是人裁 127 | 改引**人裁 108**（§2、§7） |
| `renderRuns.ts`「仅追加」 | 同时要改 3 处签名／类型 | **改 3 处 ＋ 追加 1 个渲染分支**（§3.2） |
| 「`sweep` 只用 `scanRootFailureDetail`」 | `isObservedEligible`（`sweepRuns.ts:108`）消费 `ScanRow` 的内容 | 删掉该说法（§3.3 只声称 sweep 跑 `scanRuns`） |
| outcome 字段名 `why` | `LivenessVerdict` 用的是 `reason` | 统一为 **`reason`**（§4.2） |
| 终点判据 6 条（4 条散文） | —— | **7 条全部可跑**（§8） |
