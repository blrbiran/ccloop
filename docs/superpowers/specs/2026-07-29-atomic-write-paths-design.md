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

| 位置 | 文件 | 说明 |
|---|---|---|
| `fileStore.ts:81` | `loop-state.json` | `writeRunState`，**每次状态转移都重写**，最热 |
| `fileStore.ts:76` | `loop-state.json` | `initializeRunFiles` 内的**创建**写。见下方「为什么必须纳入」 |
| `fileStore.ts:379-381` | `owner-record.json` | `writeOwnerRecord`，生产唯一调用者 `runLoop.ts:868`，即**首次创建** |
| `fileStore.ts:308` | `boundary-analysis.json` | `writeBoundaryArtifacts` 内，无条件写 |
| `fileStore.ts:316` | `reconciliation-record.json` | `writeBoundaryArtifacts` 内，条件写 |

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

**不引入 `vi.mock`，也不给 `fileStore.ts` 加文件系统注入缝。** 本仓库测试套件中**零处** `vi.mock`（已核实），约定是真实 tmpdir 测试，只在已有缝处注入假件（如 registry 的 `scanDeps`）。为了测试而给生产代码开缝，既违反 Rule 11（遵从既有约定），也超出「只改怎么写」的范围。

### 7.1 核心判据：inode 替换

在真实文件系统上区分「rename 落地」与「原地覆写」有一个确定性判据：

- `rename(tmp, target)` 让 `target` **指向新的 inode**。
- `writeFile(target)` 对已存在的文件是**截断并原地重写**，inode **不变**。

所以对五个替换点各写一条测试：

1. 写一次，`stat(target).ino` 记为 `ino1`；
2. **`open(target)` 持有一个文件句柄，直到断言结束才关闭**（见下方「必须做，否则测试会随机失败」）；
3. 用不同内容再写一次，取 `ino2`；
4. 断言 `ino2 !== ino1`。

**第 2 步必须做，否则测试会随机失败。** `rename` 会释放被替换文件的 inode，而文件系统**可以立刻把同一个 inode 号复用**给下一个新建的临时文件，于是 `ino2 === ino1` 偶发成立、测试偶发变红。持有一个打开的句柄会把旧 inode 钉住，使其不可被复用，判据随之变确定。

**不要省略这一步再把偶发失败当成 flake 记账。** 本项目已背着 5 个 flake 债，而 L1b 的最终评审专门为「明知形状易 flake 仍照抄」立过案（Final-3）。

这不需要任何注入，且**变异验证天然成立**：把实现换回裸 `writeFile`，inode 不再变化，测试失败。

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
- `loop-state.json` 的**两个**写者（`:76`、`:81`）都已原子化——只改其一即为未达标。
- `src/registry/` 内零逻辑改动（只有注释）。
- `writeOwnerTransferRecord` 带有 §6 要求的警示注释，签名与调用点未变。
- 转移事务路径（§2.2 列出的四个符号）**逐字节未改**。
- 全套件绿：`ECC_GATEGUARD=off DISABLE_OMC=1 npm test -- --run`，**贴真实输出，不得 `| tail -N`**。
- `npm run typecheck` / `npm run build` 干净。

## 10. 已知会留下的问题（不在本分支解决）

1. **跨文件不一致仍在**：`boundary-analysis.json` 与 `reconciliation-record.json` 之间、`owner-transfer.json` 与 `owner-record.json` 之间。属于债 1，归 L3。
2. **L2 的有界重读变成冗余**：故意保留为纵深防御，见 §5。
3. **`writeOwnerTransferRecord` 仍可被误用**：只加了注释，没有机制强制。真正的防线是 L3 的评审。
