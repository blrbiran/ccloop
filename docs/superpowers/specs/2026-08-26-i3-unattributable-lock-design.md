# I-3(b) — 让永久卡死的转移锁在操作员面前说真话

**授权**：人裁 106（开 I-3，含改红线函数返回类型的新授权）＋ 人裁 107（指名改写一条既有判据）。
**范围**：I-3 的 **(b) 面**（会打到操作员脸上的那条错误消息）。
**明确不做**：I-3 的 **(a) 面**（`recoverInterruptedOwnerTransfer` 的裸 `catch`）、人裁 85（`ls` 也报锁）、E1、Linux。

---

## 1. 病灶（引自第一轮评审 `pointB-review.md` 的 I-3）

评审员原话是 **"I am reporting both, proposing neither"**。他点的 (b) 面：

`ccloop resume` 撞上一把**永远清不掉**的转移锁时，操作员看到的是

```
resume_denied detail would be: owner-transfer lock busy: OwnerTransferLockBusyError: owner transfer already in progress
```

**当时并没有任何转移在进行。** 这句话不报持有者、不报原因、不指向 `ccloop unlock`。

**根因**：`tryRecoverStaleOwnerTransferLock` 返回 `Promise<boolean>`，而 `false` 同时承载两种截然不同的处境——

| `false` 的两种含义 | 性质 | 操作员该做什么 |
|---|---|---|
| 持有者进程还活着 | **暂态**，持有者退出即清 | 等 |
| 锁不可归属（内容坏了／没有 `pid:<n>` 持有者） | **永久**，非人不可解 | 跑 `ccloop unlock` |

调用方拿不到这个区别，于是只能对两者说同一句话，而那句话对第二种是假的。

### 1.1 一个把范围收窄的判断

`OwnerTransferLockBusyError` 的文本**一个字不改**。逐格核过：对**活持有者**那一格，`owner transfer already in progress` 是**真话**。
假话只发生在**不可归属**那一格。改活持有者那句属于顺手改善邻近代码，CLAUDE.md Rule 3 不许。

---

## 2. 红线函数的返回类型

```ts
type StaleOwnerTransferLockOutcome =
  | { kind: "cleared" }
  | { kind: "holder-alive"; pid: number }
  | { kind: "unattributable"; why: "unparseable" | "no-pid-holder" };
```

五条出口与今天**一一对应，行为等价**：

| 今天 | 之后 |
|---|---|
| ENOENT ⇒ `true` | `cleared` |
| `JSON.parse` 抛（含 `JSON.parse("null")` 的属性读 TypeError）⇒ `false` | `unattributable / unparseable` |
| 解析成功但 `pid === null` ⇒ `false` | `unattributable / no-pid-holder` |
| `isProcessActive(pid)` 为真 ⇒ `false` | `holder-alive` |
| 死 pid ⇒ `safeUnlink` ⇒ `true` | `cleared` |

**人裁 83 的失败关闭语义逐格不变**：唯一删锁的条件仍是「解析成功 ＋ `pid:<n>` ＋ 该进程已不存活」。
本设计只把「为什么不删」说出来，**不新增任何一条删锁路径**。

### 2.1 唯一需要证明的重构

今天 `pid === null || isProcessActive(pid)` 短路在**同一个 `try` 内**。要区分这两格必须拆开，
`isProcessActive` 因此移到 `try` 外。它（`fileStore.ts:956`）自有 `catch`：`ESRCH ⇒ false`，其余 ⇒ `true`，
**是全函数、不抛**（`process.kill(pid, 0)`，catch 里 `ESRCH ⇒ false`、其余 ⇒ `true`）。

但「读过」不是证明。⚠️ **这个差别只有在 `isProcessActive` 会抛时才看得出来** —— 所以它**不能**用「把 `holder-alive`
出口改成 `cleared`」来证（那条变异走到 `:1261` 照样抛 busy，判据全绿，什么都没证明）。
真正的证明是 §5.2 的 EPERM 注入判据 ＋ §6 的 M5。

---

## 3. 新的兄弟错误类

```ts
export class OwnerTransferLockUnattributableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerTransferLockUnattributableError";
  }
}
```

按 `fileStore.ts:861` 已写下的房规做**兄弟，不是子类**：子类会让每个既有的
`instanceof OwnerTransferLockBusyError` 分支继续命中，**悄悄保留只对「会自己清的锁」才正确的重试行为**。
这把锁永远不会自己清。

**消息**（在 `fileStore.ts:1256` 拼，那里有 `runDir`）：

```
owner-transfer lock cannot be attributed to any process (<why>);
it will not clear on its own — inspect it with: ccloop unlock <runDir>
```

指向 `ccloop unlock <runDir>`（**不带** `--force`）是核实过的：对 `unparseable` / `unrecognized-holder`
的锁，该命令打印拒绝理由**并附上完整的 `--force --expect <digest>` 逃生命令**（`unlockCommand.ts:169`、`:215-217`）。

---

## 4. 五个消费点各自重决

房规要求「every consumer must re-decide its own behaviour」。逐条：

| # | 站点 | 决定 | 加代码？ |
|---|---|---|---|
| 1 | `fileStore.ts:1256` | 按 outcome 分抛：`holder-alive` ⇒ busy（原文不动）／`unattributable` ⇒ 新类 | 是 |
| 2 | `fileStore.ts:476` 对账重试 | 新类非 busy ⇒ 落 `{kind:"abandon"}`，**立即放弃，不再空转重试** | 否 |
| 3 | `runLoop.ts:691` 转移重试 | 新类第一次就抛出，不重试。对永久锁重试是纯浪费 | 否 |
| 4 | `runLoop.ts:847` | ⚠️ **必须加分支**，否则新类会 `throw` 出去，把本来被收住的失败变成抛出。照 busy 的样子记 `owner_transfer_contended`，detail 带新消息。**不新增事件类型** | 是 |
| 5 | `resumeLoop.ts:233` | ⚠️ **必须加第三分支**，否则不可归属落进 `claim CAS failed`——**比现在这句假话更假**。这是 I-3 点名的操作员可见路径 | 是 |

### 4.1 ⚠️ 另外三处【吞掉】这个错误，本轮【不修】

⚠️ *** **本节的普查经人裁 108 更正过（Mi-2）。原文把两类东西混成了一类。** *** 准确的说法是：
`acquireOwnerTransferLock` 有 **5 个直接调用点**（`acquireOwnerTransferLockForReconciliation`、
`recoverInterruptedOwnerTransfer`、`writeOwnerTransferArtifacts`、`claimOwnerRecordWithPrecondition`、
`updateOwnerRecordWithPrecondition`），其中**只有 1 个直接吞**。
另外两处吞在**上一层**：`leaseHeartbeat` 调的是 `affirmOwnerLease` ／ `releaseOwnerLease`，
它们才经 `updateOwnerRecordWithPrecondition` 到达锁。**三处吞，但不是「三个调用点」。**

下表列的是**三处吞**，新错误类到那里同样是沉默的：

| 站点 | 后果 | 本轮处置 |
|---|---|---|
| `recoverInterruptedOwnerTransfer:1425` 裸 `catch { return; }` | **就是 I-3(a) 本身** ⇒ 新类在 `readOwnerRecord` 路径上**完全不可见**，本修复对该路径**无效** | 记账，不修（不在人裁 106 措辞内）|
| `leaseHeartbeat.ts:150` | 新类被吞，**每 tick 重试到永远**；该处注释的前提 *"lock contention, transient I/O"* **对新类为假** | 记账，不修 |
| `leaseHeartbeat.ts:254` | 释放期 best-effort 吞掉（较轻）| 记账，不修 |

⇒ *** **本设计修好的是 `resume` 与 transfer 两条链上的操作员可见消息；上面三处吞不受影响。** *** 见 §8。

⚠️ **#2 与 #3 靠「不加代码」得到新行为。** 方向与房规担心的相反——房规怕的是子类**保留**匹配，
这里是兄弟类**丢失**匹配。两处都必须在注释里写明**是重决过的**，不是没想过。

`resumeLoop.ts:233` 的形状（新分支排在 busy 之前，二者是兄弟，顺序不承重，显式书写）：

```ts
const detail = error instanceof OwnerTransferLockUnattributableError
  ? `owner-transfer lock unattributable: ${String(error)}`
  : error instanceof OwnerTransferLockBusyError
    ? `owner-transfer lock busy: ${String(error)}`
    : `claim CAS failed: ${String(error)}`;
```

---

## 5. 判据

### 5.1 改写 1 条（人裁 107 指名，整条改写，**不放宽**）

`tests/persistence/fileStore.test.ts:1074`
`it("keeps a malformed lock without staged artifacts non-recoverable")`

保留原有的「malformed ⇒ 拒绝」事实，**加**类型判别与操作员指路：

```ts
expect(error).toBeInstanceOf(OwnerTransferLockUnattributableError);
expect(error).not.toBeInstanceOf(OwnerTransferLockBusyError);   // 兄弟房规：两个方向都不许混
expect(String(error)).toContain("ccloop unlock");               // I-3 的病灶：必须指路
```

改后注释写明编码的是**人裁 106 ＋ 107**。

### 5.2 新增（只加不改）

| 判据 | 钉的是 |
|---|---|
| `no-pid-holder` 那一格（如 `{"holderProcessInstanceId":"upgrading"}`）⇒ 新类 | 第二条永久出口 |
| 活持有者 ⇒ 仍是 busy **且不是**新类 | 反方向判别 |
| ⭐ `resume_denied` 的 detail 含 `unattributable` 与 `ccloop unlock` | **I-3 的正主** |
| 不可归属**不抛出**，只记 `owner_transfer_contended` | `runLoop:847` 的收敛性 |
| ⭐ `process.kill` 注入 **EPERM**（非 ESRCH）⇒ 仍是 busy 拒绝，**不是 EPERM 裸抛出** | §2.1 的 `try` 边界：`isProcessActive` 是全函数 |

---

## 6. 变异证明

判据钉的是现状行为，天然先绿 ⇒ 「先红」由变异提供。
**只在 `git clone --local` 副本里做，主仓库工作树全程零触碰**；还原证明看 `git diff` 与 `git diff --cached` 的字节数。

| | 变异 | 必须变红 |
|---|---|---|
| M1 | `unattributable` 出口改回抛 busy | 改写后的 1074 ＋ resume detail |
| M2 | 删掉 `resumeLoop` 第三分支 | resume detail |
| M3 | 删掉 `runLoop:847` 第三分支 | 收敛性判据 |
| M4′ | `holder-alive` 出口改成 `cleared` **并 unlink**（把活持有者当可回收）| 既有 `:679`（acquire 会成功，`rejects` 失败）|
| M5 | `isProcessActive` 的 catch 改成**重抛非 ESRCH** | EPERM 注入判据（错误会裸穿出来）|

⚠️ *** **M4′ 是替换品，不是原来那条。** *** 最初写的 M4 是「`holder-alive` 出口改成 `cleared`」（不 unlink），
**它证明不了任何东西**：变异后循环第二次迭代仍 EEXIST，走到 `:1261` 照样抛 `OwnerTransferLockBusyError`，
`:679` 全绿。这是本包第三次撞上「绿可能是空的」——**变异证明本身也要先被证明会红。**

---

## 7. 成功判据

1. *** **`35 files / 609 tests`** *** 全绿**零 skipped**，`typecheck` / `build` 均 `0`（604 ＋ 新增 5 条）
2. 四条变异**各自**把指定判据打红，还原后回绿
3. 红线函数的删锁条件**逐格未变**（人裁 83 语义不动）
4. 除 `fileStore.test.ts:1074` 外，**没有第二条既有判据被改动**

---

## 8. 本设计明确留下的尾巴

- **I-3(a)** —— `recoverInterruptedOwnerTransfer` 的裸 `catch { return; }` 使 `readOwnerRecord`
  无限期返回转移前的旧记录。评审员称之为 *"the project's signature defect"*。
  **不在人裁 106 的措辞内，仍挂账，需人另开授权。**
- **`leaseHeartbeat.ts:150`** —— 新错误类被吞，心跳**每 tick 重试一把永远不会清的锁**，而那段注释的前提
  写着 "transient"。⚠️ **比 I-3(a) 更刺眼一点：走进去的是本轮新造的类。** 同样不在人裁 106 措辞内，
  **记账，需人另开授权**。`leaseHeartbeat.ts:254` 同病较轻。
- **人裁 85**（`ls` 也报锁）—— 仍是独立一轮。
