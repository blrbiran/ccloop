# 设计：消除 fileStore 的非原子写路径（债 4）

日期：2026-07-29
起点：`main` @ `26f552f`，29 files / 427 tests 全绿，typecheck / build 干净
上位裁决：`docs/superpowers/decisions/2026-07-29-technical-debt-attribution.md` 的债 4
执行顺序：**本分支先于 L3 完成并合并**

## 1. 目的

`src/persistence/fileStore.ts` 里有多处用裸 `writeFile` 写 JSON，**本分支纳入其中五处**（其余的排除理由见 §2.2）。裸 `writeFile` 不是原子的：读者可以观测到写了一半的文件。L2 registry 为此付出了每个非原子文件最多 `LEASE_VERIFY_READ_ATTEMPTS = 3` 次读、`LEASE_VERIFY_RETRY_DELAY_MS = 50` 的有界重读代价（`src/registry/readObservedFile.ts:99-101`），而**任何后续需要连贯读这些文件的消费者都继承同一问题与同一代价**。

本设计消除写侧的根因。

## 2. 范围

**只改「怎么写」。** 不改任何文件「何时写」「写不写」「写什么内容」。

### 2.1 在范围内

五处裸 `writeFile`：

> ⚠️ **锚点是函数名 + 文件名，不是行号。** 下表的行号是**分支基线 `5e0b75a` 上的**，Task 1 在
> `:379` 之前插入了原子写辅助（约 67 行）并加了一行 import，**这些行号在当前 head 上全部失效**。
> 已实测的漂移：`:76` 现在指向 `loop-contract.json`（本设计**排除**的文件），`:379-381` 现在落在
> Task 1 新增的辅助块里。**照行号动手会改错文件。** 每次动手前先 grep 文件名字符串确认。
> （此警告由 Task 2 的实施者提出、控制器实测确认后写入。）

| 位置（基线行号，已失效） | 锚点 | 文件 | 说明 |
|---|---|---|---|
| `fileStore.ts:81` | `writeRunState` 内写 `loop-state.json` 那一行 | `loop-state.json` | **每次状态转移都重写**，最热 |
| `fileStore.ts:76` | `initializeRunFiles` 内写 `loop-state.json` 那一行 | `loop-state.json` | **创建**写。见下方「为什么必须纳入」 |
| `fileStore.ts:379-381` | `export async function writeOwnerRecord`（**不是** `writeOwnerRecordAtomically`） | `owner-record.json` | 生产唯一调用者是 `runLoop.ts` 里 `await writeOwnerRecord(runDir, ownerRecord);` 那一行，即**首次创建** |
| `fileStore.ts:308` | `writeBoundaryArtifacts` 内写 `boundary-analysis.json` 那一行 | `boundary-analysis.json` | 无条件写 |
| `fileStore.ts:316` | `writeBoundaryArtifacts` 内写 `reconciliation-record.json` 那一行 | `reconciliation-record.json` | 条件写 |

**为什么 `:76` 必须纳入（初稿把它排除了，那是本设计的一个结构性缺陷，已更正）**：`loop-state.json` 有**两个**写者，`:76` 创建、`:81` 每次转移重写。初稿只纳入 `:81`，排除理由是「创建期没有并发读者」——**该理由不成立**。`ccloop ls` 可在任意时刻扫描根目录，**包括某个 run 正在初始化的那一刻**，而 `loop-state.json` 既是 `RUN_MARKER_FILES` 之一、又是 L2 唯一逐字段观测的三个文件之一。`ensureFreshRunDir` 只阻止同一 run 被重复初始化，**不阻止外部扫描**。只改 `:81` 而不改 `:76`，本设计对它最想修的那个文件就是半截的。

外加 M-1 标记（§6）与 L2 注释更正（§5）。

### 2.2 明确的非目标

- **不动转移事务路径**：`finalizePendingOwnerTransfer`、`writeOwnerRecordAtomically`、`acquireOwnerTransferLock`、`recoverInterruptedOwnerTransfer` 及相关常量一律不改。理由见 §4.2。
- **不改 `reconciliation-record.json` 的写入时机**。那是债 1 的范围，属于 L3。本分支只改「怎么写」。已知本分支对该文件所做的一部分工作可能在 L3 中被取代，这是裁决记录已接受的代价。
- **不改 L2 的读行为**（`atomic` 标志保持 `false`）。见 §5。
- **不设性能门禁**。见 §8。
- **不改 `events.jsonl`**：`appendEvent` 是 `appendFile` 追加，不是全文件重写；`initializeRunFiles:77` 写的是空串，原子性对空内容无意义。
- **不改 `initializeRunFiles:75`（`loop-contract.json`）**：它**不在 `OBSERVED_FILES` 里**，L2 只把它当作存在性 marker 用（`RUN_MARKER_FILES`），从不读其内容；没有任何消费者依赖它的连贯性。**注意这与 `:76` 的处置不同**——`:76` 写的 `loop-state.json` 既是 marker 又被逐字段观测，故必须纳入。
- **不改 `writeAttemptArtifacts`（`:712+`）**：写的是 attempt 目录内的产物，不在 run 目录顶层，L2 不观测，且无并发读者依赖其连贯性。若后续证明需要，另开一笔。

## 3. 新增接口

```
async function writeJsonFileAtomically(path: string, value: unknown): Promise<void>
```

私有于 `src/persistence/fileStore.ts`，**不导出**。

其临时名生成拆成一个**可导出的函数**以便单测（见 §7.2）：

```
function buildAtomicTempPath(targetPath: string): string
```

**它不是纯函数**（初稿如此描述，与唯一性要求自相矛盾，已更正）：唯一性要求同一进程内相同输入的连续两次调用返回**不同**路径，这只能靠模块级计数器实现——纯函数做不到。它是一个带内部状态的生成器。

**代价，明说**：这会把 `fileStore` 的公开接口面扩大一个符号，仅仅为了可测。取舍理由：替代方案是只做间接测试（写两次、比较临时文件残留或 inode），**那证明不了「两个并发写者拿到不同的名字」这条本设计的核心安全性质**——而这条性质错了会重新引入撕裂（§4.1）。一个多出来的导出符号，换一条能直接断言的核心不变量，值得。

### 3.1 必须满足的性质

1. **目标路径只经 `rename` 落地**，从不被 `writeFile` 直接写。
2. **临时文件名进程唯一**。见 §4.1——这是本设计最容易做错的一点。
3. **临时文件不残留**：成功路径由 `rename` 消费掉；失败路径必须 `unlink` 后再向上抛。
   **清理失败不得替换正在传播的原始错误。** 注意：`safeUnlink`（`fileStore.ts`）**会重抛非 ENOENT**，所以它**不能**用在这个 catch 里——已由 Task 1 的评审以实跑证实（构造出 `writeFile` 抛 `EISDIR`、`unlink` 抛 `EPERM` 的场景，用 `safeUnlink` 会把 `EISDIR` 替换成 `EPERM`）。
6. **崩溃持久性不在本设计范围内。** 本设计提供的是**并发读者**的可见性（同文件系统的 `rename` 是原子的），**不是**掉电或内核崩溃后的持久性——仓库全域 `fsync` / `fdatasync` 为 **0 处**，本分支也不引入。任何注释或测试都不得暗示更强的保证。
4. **序列化格式与被替换的调用逐字节一致**：现有五处都是 `JSON.stringify(value, null, 2)`（含 `:76` 的 `JSON.stringify(initialState, null, 2)`）。**改变缩进或键序都会让无关测试以看不出原因的方式失败**，且超出「只改怎么写」。
5. **错误向上传播**，不吞。写失败必须让调用者看见（Rule 12）。

## 4. 关键约束

### 4.1 临时文件名必须进程唯一（本设计的核心风险）

现有的 `writeOwnerRecordAtomically`（`fileStore.ts:632-637`）用**固定**临时名 `.owner-record.publish.tmp`。它是安全的，**但安全的原因是它只在转移锁内被调用**（`updateOwnerRecordWithPrecondition` 与 `claimOwnerRecordWithPrecondition` 都先 `acquireOwnerTransferLock`）。

`writeRunState` **没有任何锁**。两个进程同时写同一个 `loop-state.json`，若共用固定临时名，会出现：

```
进程 A: writeFile(tmp, A的内容)
进程 B: writeFile(tmp, B的内容)     ← 覆盖
进程 A: rename(tmp, loop-state.json) ← 发布了 B 的内容
进程 B: rename(tmp, ...)             ← ENOENT
```

即**原子化反而制造了一个新的撕裂来源**。所以临时名必须包含进程标识。

**建议形式**：`.<basename>.<pid>.<单调递增序号>.tmp`，序号为模块级计数器，用于隔离同一进程内的并发写。**不强制具体格式**，但必须满足：同一进程内并发调用得到不同路径，不同进程之间得到不同路径。

**不要复用 `getOwnerTransferPaths` 返回的任何临时路径**——那些名字是事务恢复逻辑的一部分（见 §4.2）。

### 4.2 为什么不泛化 `writeOwnerRecordAtomically`

看上去应该把它和新函数合并成一个通用辅助。**不要这样做。**

`finalizePendingOwnerTransfer`（`fileStore.ts:526-545`）与 `cleanupOwnerTransferStagingWithoutMarker`（`:518-524`）都靠 `getOwnerTransferPaths` 返回的**固定**路径去定位和清理残留的 staged 文件——这是崩溃恢复能工作的前提。把它换成进程唯一名字，崩溃后的另一个进程就**再也找不到前一个进程留下的临时文件**，恢复机制静默失效。

两个辅助语义不同：一个是事务的一步（固定名、锁内、可恢复），一个是独立写（唯一名、无锁、不可恢复）。**保持两个，不要合并。**

### 4.3 `writeBoundaryArtifacts` 内两次写不因本设计变得原子

`:308` 与 `:316` 各自变原子之后，**这两个文件之间仍然不是原子的**：可以观测到 `boundary-analysis.json` 已更新而 `reconciliation-record.json` 未更新。

本设计**不解决跨文件一致性**，那是债 1 的问题域（L3）。此处明写，以免后来者误以为本分支已经消除了跨文件窗口。

## 5. L2 读侧的处理（零行为变更）

`src/registry/observeFields.ts` 把 `loop-state.json` 与 `owner-record.json` 标为 `atomic: false`（`:8`、`:19`），`readObservedFile.ts:101` 据此做 3 次有界重读。

**保留 `atomic: false` 不变。** 只更正注释，使其不再断言一个写侧已消除的事实：

- `readObservedFile.ts:3` 的 "files known to be written non-atomically" 必须改写。
- `observeFields.ts` 中两个 `atomic: false` 处应说明：写侧已原子化，此处保留有界重读作为**纵深防御**，代价上限约 100ms 且仅在 parse 失败时触发。

**理由**：翻成 `true` 是改 L2 的读行为，越过本分支「只改怎么写」的边界，并且一旦未来新增任何非原子写点，安全网就没了。保守选择已通过 L2 的评审，本分支不削弱它。

**验收**：`src/registry/` 下**没有任何逻辑改动**，`git diff` 在该目录内应只有注释行。

## 6. M-1：标记非原子的 transfer 写入口

`writeOwnerTransferRecord`（`fileStore.ts:383-385`）走同一个 `writeJsonFile`，是一个**导出的、非原子的** `owner-transfer.json` 写入口。生产代码零调用者（全部命中在 `tests/`）。

**处置：只加警示注释，不重命名、不改签名、不动测试。**

注释必须说清三件事：它非原子；它只供测试搭夹具；生产发布必须走 `finalizePendingOwnerTransfer`，否则会静默击穿 L2 对该文件的单次读前提（`observeFields.ts:30` 的 `atomic: true`）。

**不把它改成原子**：那会让它看起来可以用于生产，而它绕过了整个事务与恢复机制——问题不在原子性，在于它旁路了事务。

## 7. 测试要求

**不写竞态测试。** 用真实并发去证明原子性既不确定又不可复现。

**不给 `fileStore.ts` 加文件系统注入缝。** 为了测试而给生产代码开缝超出「只改怎么写」的范围。

**关于模块 mock —— 初稿这里写了一个假前提，已更正。**

初稿写：「本仓库测试套件中**零处** `vi.mock`（已核实），…… 为了测试而给生产代码开缝，既违反 Rule 11（遵从既有约定）」。

**那个「已核实」是错的。** `vi.mock(` 字面量确实是 0 处，但 `vi.doMock` 有 **24 处、跨 5 个测试文件**——**其中就包括本设计要改的 `tests/persistence/fileStore.test.ts` 本身**，用来 mock `node:fs/promises` 使 `writeFile` 对特定路径抛错。`vi.doMock` 是 `vi.mock` 的运行时作用域版本，同一套设施。缺陷来源：grep 只搜了 `vi.mock` 字面量，没搜 `doMock`。

**这条错误的方向是反的**：它被用来援引 Rule 11 禁掉 mock，而**真实的既有约定恰好相反**——模块级 fs mock 正是 `fileStore.test.ts` 已确立的失败注入手法。

**更正后的立场（是偏好，不是禁令，且不再援引 Rule 11）**：

- **优先**真实 tmpdir 测试。理由是它证明的东西更强：真实的 `rename`、真实的 inode、真实的错误码。
- **允许**在真实手段做不到时使用 `vi.doMock`，与 `fileStore.test.ts` 现有 4 处保持同一形状。**使用时必须在测试里写明为什么真实手段不可行**——不接受「mock 更方便」。
- 无论哪种，**都不给生产代码开注入缝**。这一条不变，且它本来就不依赖上面那个假前提。

### 7.1 核心判据：inode 替换

在真实文件系统上区分「rename 落地」与「原地覆写」有一个确定性判据：

- `rename(tmp, target)` 让 `target` **指向新的 inode**。
- `writeFile(target)` 对已存在的文件是**截断并原地重写**，inode **不变**。

**判据按调用点逐个选，不是一刀切**（本句替换初稿的「对五个替换点各写一条 inode 测试」，见 §7.1a
的三档表）：**看该写者前面是否有守卫拒绝预先存在的目标**。目标可预先存在 → 用 inode 判据，且**优先**
用它，因为两者之中只有它能杀掉「按目标是否存在分流」的实现；目标不可能预先存在 → 用 §7.1a 的悬挂
符号链接判据。**两个判据互补，不是冗余**——已实测：分流实现只在 inode 判据下死，只改创建路径的实现
只在符号链接判据下死。

对适用 inode 判据的替换点，测试形状是：

1. 写一次，`stat(target).ino` 记为 `ino1`；
2. **`open(target)` 持有一个文件句柄，直到断言结束才关闭**（见下方「必须做，否则测试会随机失败」）；
3. 用不同内容再写一次，取 `ino2`；
4. 断言 `ino2 !== ino1`。

**第 2 步必须做，否则测试会随机失败。** `rename` 会释放被替换文件的 inode，而文件系统**可以立刻把同一个 inode 号复用**给下一个新建的临时文件，于是 `ino2 === ino1` 偶发成立、测试偶发变红。持有一个打开的句柄会把旧 inode 钉住，使其不可被复用，判据随之变确定。

**不要省略这一步再把偶发失败当成 flake 记账。** 本项目已背着 5 个 flake 债，而 L1b 的最终评审专门为「明知形状易 flake 仍照抄」立过案（Final-3）。

这不需要任何注入，且**变异验证天然成立**：把实现换回裸 `writeFile`，inode 不再变化，测试失败。

#### 7.1a 判据的三档分类，与创建型写入的替代判据

**分类维度是「守卫是否拒绝预先存在的目标」，不是「创建 vs 覆写」**（本分类由 Task 4 的实施者提出、
Task 4 的评审员实测确认；此前本节按「创建 vs 覆写」分类，把前提不同的调用点归成了一类）：

| 档 | 替换点 | 目标能否预先存在 | 判据 |
|---|---|---|---|
| 1 不可能 | `initializeRunFiles` 的 `loop-state.json` | 否——`blockingPaths` 列了它，预先存在会抛 | **只能**用符号链接判据 |
| 2 罕见但可达 | `writeOwnerRecord` 的 `owner-record.json` | 可以——无守卫，但生产通常是创建 | inode 判据**适用**；本分支选择不补，理由见下 |
| 3 无守卫且本为覆写而设计 | `writeBoundaryArtifacts` 的两处 | 可以，且是主线——该函数自己的 preserve 逻辑会把目标读回来 | inode 判据**适用且必需** |

第 3 档为何是「必需」：只有 inode 判据能杀掉「按目标是否存在分流」的实现（已实测）。



**本节是初稿的一个结构性缺陷，由 Task 2 的实施者发现、Task 2 的评审员实测确认后补入。**

上面的判据默认目标文件已存在。五个替换点里有**两个通常是创建型写入**——`initializeRunFiles` 的
`loop-state.json` 与 `writeOwnerRecord` 的 `owner-record.json`。目标不存在时 `rename` 与
`writeFile` 的**终态完全相同**，没有 inode 可比。**在那种情况下这不是「夹具不好搭」，是判据本身
不适用——任何夹具都救不回来。** 初稿把它当成夹具问题，是错的。

⚠️ **但这两个写者的前提并不相同，本节初版把它们混为一谈，是第二个错误**（Task 3 的实施者与评审员
各自实测后更正）：

- **`initializeRunFiles` 的目标不可能预先存在**：`ensureFreshRunDir` 的 `blockingPaths`
  （`fileStore.ts:52-56`）里**列了** `loop-state.json`，预先存在会抛。它的夹具因此**依赖**
  `pathExists` 用 `access()` 探测；改成 `lstat()` 会让该测试大声变红（已两次实测）。
- **`writeOwnerRecord` 的目标只是「通常」不预先存在**，**并非保证**。同一份 `blockingPaths`
  **不含** `owner-record.json`，且 `checkRunLease` 对 `leaseAffirmedAt: null`
  （`leaseGate.ts:38-42`，文档化的转移后状态）与**已过期**租约（`:44-64`）**都只是返回、不拒绝**。
  所以一个只含 owner record、租约为空或已过期的 run 目录**会以覆写形式到达这个写者**——已实测
  （`initializeRunFiles` 未抛 → `checkRunLease` 返回 `no_lease` → inode 发生变化）。
  **对它不要写「判据不适用」**：在那个可达角落里判据是适用的。它的夹具**不依赖任何新鲜度探测**，
  前提严格少于前者。

**本分支对 `writeOwnerRecord` 选择不补 inode 测试**，唯一成立的理由是：该写者是对
`writeJsonFileAtomically` 的**无分支整体委托**，而覆写经 `rename` 这一性质已由 `writeRunState`
处的 R1 inode 测试（含持有句柄那一步）钉住。**不得用「它只可能是创建」（假）或「怕 flake」
（§7.1 的持有句柄已解决）当理由。**

**已知残留，必须写明**：符号链接判据只钉住「创建」这一路的实现选择。一个**按目标是否已存在分流**
的包装（存在则走裸写、否则走原子写）能从符号链接测试下存活（实测 48/48 全过），只有 inode 测试
能杀它。**同时也不得声称补了 inode 测试就完全钉死了覆写角落**——`unlink` 后再 `writeFile` 同样
会换 inode，两条测试都杀不掉它。

**替代判据（已在 Task 2 与 Task 3 落地并经独立变异验证）**：在目标路径上放一个**悬挂符号链接**
（指向一个不存在的路径）。

- 若该写者前面有 `ensureFreshRunDir`（仅 `initializeRunFiles`）：它经 `pathExists` 用 `access()`
  探测，`access` **跟随**链接、对悬挂链接报 ENOENT，所以新鲜度检查放行；
- 之后 `writeFile` 会**穿过**链接写：链接存续，它指向的目标被创建；
- 而 `rename` 会**替换**这个目录项：链接消失，它指向的目标从未被创建。

断言 `lstat(target).isSymbolicLink() === false` 且 `stat(链接指向的路径)` 以 ENOENT 拒绝。

**为什么它比 inode 判据更稳**：没有 inode 被释放，所以**根本不存在 inode 号复用的偶发窗口**。
Task 2 连跑 40 次零失败。

**已知代价，必须在测试里写明**：它依赖 `ensureFreshRunDir` 用 `access()`（跟随链接）而非
`lstat()`（不跟随）探测。若那里改成 `lstat`，本测试会**大声变红**（`runDir already contains
prior run data`），不会静默失效——评审员实测确认了这一点。

**同样不得越界声称**：本判据证明的是「落地经过了 `rename`」，与 inode 判据一样，**不证明**
「不存在任何中间可见状态」。

**已知限制，必须在测试里写明**：inode 判据证明的是「落地经过了 rename」，**不是**「不存在任何中间可见状态」。后者在真实文件系统上无法确定性证明。**不要在测试名或注释里声称证明了后者**——本项目上一轮最贵的缺陷正是「测试声称杀 A、实际杀不掉」。

### 7.2 其余要求

**要求 R1 是 §7.1 的 inode 判据。以下为 R2–R6。**

- **R2 无临时文件残留**：成功路径写完后目录中无临时文件；`rename` 失败时同样无残留，且错误向上抛出（不吞）。失败注入用真实手段（例如让目标路径是一个目录，或临时目录只读），不用 mock。
- **R3 临时名唯一性**：对 `buildAtomicTempPath`（§3）单测——同一进程内连续两次调用返回**不同**路径，且路径中含进程标识。**不接受「读注释相信」。**
- **R4 字节等价**：替换前后目标文件内容逐字节一致（`JSON.stringify(value, null, 2)`）。
- **R5 变异验证（强制）**：把 `writeJsonFileAtomically` 内部换回裸 `writeFile`，要求 R1 的 inode 测试失败。**注入点必须在生产函数上，不得在测试的数据结构里注入。** 上一轮最贵的一条缺陷正是「守护测试遍历自己的手写字面量」——往测试数组里注入只证明匹配器有效，没证明覆盖到位。
- **R6 回归**：`tests/registry/zeroWrite.test.ts` 必须仍然全绿。临时文件出现在 run 目录里，而 registry 只读，理论上不受影响——**但必须实跑证明，不接受推理。**

## 8. 性能

`writeRunState` 是热路径（每次状态转移重写），temp+rename 给每次写**多加一次 `rename`**（不给更精确的数字：`writeFile` 本身已是 open+write+close，把它算成「1 个 syscall」是错的，而本项目刚为一句不精确的算术注释付过代价）。

**不设性能门禁。** 该循环每次迭代都包含 Claude 调用与文件系统 I/O，多一次 rename 在量级上不可见。**不要为找它而专门跑基准。** 若实施者在正常测试中观察到可测量的退化，如实上报并停下等裁决——不要悄悄降级实现。

## 9. 验收标准

- **五个**替换点全部只经 `rename` 落地，§7 的六条要求（R1–R6）全部满足且变异验证有据。
- `loop-state.json` 的**两个**写者（`initializeRunFiles` 与 `writeRunState`，基线 `:76`、`:81`，
  行号已失效见 §2.1）都已原子化——只改其一即为未达标。
- `src/registry/` 内零逻辑改动（只有注释）。
- `writeOwnerTransferRecord` 带有 §6 要求的警示注释，签名与调用点未变。
- 转移事务路径（§2.2 列出的四个符号）**逐字节未改**。
- 全套件绿：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`，**贴真实输出，不得 `| tail -N`**。
- `npm run typecheck` / `npm run build` 干净。

## 10. 已知会留下的问题（不在本分支解决）

1. **跨文件不一致仍在**：`boundary-analysis.json` 与 `reconciliation-record.json` 之间、`owner-transfer.json` 与 `owner-record.json` 之间。属于债 1，归 L3。
2. **L2 的有界重读变成冗余**：故意保留为纵深防御，见 §5。
3. **`writeOwnerTransferRecord` 仍可被误用**：只加了注释，没有机制强制。真正的防线是 L3 的评审。
4. **崩溃残留的临时文件没有任何机制会清理**：`SIGKILL` 落在 `writeFile(temp)` 与 `rename` 之间时，
   `.{basename}.{pid}.{startTime}.{seq}.tmp` 会**永久**留在 run 目录里。两条现存清理路径都够不着它，
   已逐一核对代码：`ensureFreshRunDir` 只对三个具名文件（`loop-contract.json`、`loop-state.json`、
   `events.jsonl`）加 `attempts/`、`worktrees/` 两个目录的条目做阻塞；
   `recoverInterruptedOwnerTransfer` 经 `cleanupOwnerTransferStagingWithoutMarker` 只清
   `getOwnerTransferPaths` 的**四个固定名**——而临时名按 §4.1 的要求本就必须不在那四个之内。

   > **Amended 2026-08-07：** 上句「**四个固定名**」在本文写下时为真，今天是**十个**。
   > **在本注落盘之前**，本文最后一次被碰是 `2e30d1c`（2026-08-01），而该集合在 2026-08-02 被扩了两次：
   > 4 → 7（`0f940ea`，marker 与两份 pending 改走 temp+rename）→ 10（`dad8a14`，
   > `reconciliation-record.json` 成为转移事务的第三个文件）。重推：
   >
   > ```bash
   > awk '/^async function cleanupOwnerTransferStagingWithoutMarker/,/^}/' src/persistence/fileStore.ts \
   >   | grep -c "await safeUnlink"
   > # 实测输出：10
   > git log --format='%h %ad %s' --date=short -1 0f940ea
   > # 0f940ea 2026-08-02 feat(fileStore): publish the transaction marker and both pendings by temp+rename
   > git log --format='%h %ad %s' --date=short -1 dad8a14
   > # dad8a14 2026-08-02 feat(fileStore): make reconciliation-record.json the third file of the owner-transfer transaction
   > ```
   >
   > **坏的只是数字，本条的结论不变**：临时名由 `buildAtomicTempPath` 生成，带一个进程戳
   > （`ATOMIC_TEMP_PROCESS_STAMP` = `${process.pid}.${Math.trunc(performance.timeOrigin)}`）
   > 与一个自增序号，因此**不可能**落在任何固定名集合里 —— 集合是四个还是十个都够不着它。
   > 本条其余部分（含下段的定性）未作改动。参见
   > [`2026-08-07-cleanup-and-orphan-gc-design.md`](2026-08-07-cleanup-and-orphan-gc-design.md) §5.1 与 §4.2。

   **定性要准确：这是无界垃圾，不是故障。** 未发现任何功能性破坏：临时名不在 `RUN_MARKER_FILES`
   （`scanRuns.ts:30-36`，五个具名文件）里，所以它不会把一个目录误认成 run；L2 只读
   `OBSERVED_FILES` 的三个文件，不会读到它；`ensureFreshRunDir` 也不会因它而拒绝初始化。
   代价只是崩溃次数足够多之后 run 目录内文件数无上限增长。**不要把它上报成缺陷。** 清理归属未分配。
5. **一处未在 §2 声明的行为变更：这五条路径不再「穿过」符号链接写**。`writeFile` 跟随符号链接、
   写它指向的目标；`rename` 替换目录项，链接本身随之消失。这正是 §7.1a 拿来当判据的那个差异，
   分支内有两条测试正面断言它。§2 的「只改怎么写」框架没有提到这一点，而对任何把这些路径做成
   符号链接的部署来说，它是可观测的行为变更。**在此记录，不上调为风险**：仓库内没有任何生产代码
   创建符号链接（已核实），也没有证据表明有任何东西给这五个文件做链接。
