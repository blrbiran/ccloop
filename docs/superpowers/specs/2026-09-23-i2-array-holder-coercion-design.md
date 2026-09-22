# I-2 —— 关掉 `parsePid` 的强转口：数组 holder 不再换来一次无凭证删锁

**日期**：2026-09-23
**授权**：人裁 121（开口「先动 E1 的 I-2」）＋ **人裁 127**（两侧一起闭 ＋ 人裁 88 具名改写一条既有判据）
＋ **人裁 128**（动生产代码、走 subagent-driven 实施）
**观测锚点**：本文所有实测值取自提交主题行
`docs(handoff): roll the Orca section onto ruling G1, and say what it does not settle` 那一笔。
**⚠️ 本文不写任何当前哈希**——指代某一笔一律引提交主题行，指代材料一律引路径。

> ⚠️ *** **本文是【第二版】。第一版的核心设计被一次独立评审 ＋ 控制器复核推翻。** ***
> 被推翻的是什么、为什么，记在 **§10**。**不要从别处引用第一版的任何结论。**

---

## 1. 缺陷是什么

`parsePid` 的形参**类型标着 `string`，但它拿到的值来自 `JSON.parse`**，而 JSON 允许那个字段是数组。

```ts
export function parsePid(processInstanceId: string): number | null {
  const match = /^pid:(\d+)$/.exec(processInstanceId);
  return match === null ? null : Number.parseInt(match[1], 10);
}
```

`RegExp.prototype.exec` 会把参数过一遍 `String()`。于是 `["pid:999999"]` 强转成 `"pid:999999"`、匹配成功、
吐出一个 pid。**类型系统看不见这件事，因为那个 `string` 标注本身就是假话。**

### 两个调用方，代价不同

| 调用方 | 今天的结果 | 严重性 |
|---|---|---|
| `tryRecoverStaleOwnerTransferLock`（`src/persistence/fileStore.ts`） | 走到 liveness 门 ⇒ `safeUnlink` ⇒ `{ kind: "cleared" }` | **有界**：pid 仍须是死的，没有活锁会因此被夺 |
| `inspectOwnerTransferLock`（`src/unlock/inspectLock.ts`） | 答 `state: "dead"`，于是 `unlockCommand` 的 `dead` 分支 `removeLockIfUnchanged` | **重**：**无 `--force`、无 `--expect` 直接删锁** |

*** **同一个强转，在 E1 那一侧把一格从「拒绝」挪进了「无人值守删除」。** ***

### 今天的逐格实测（**五格，全部现测**）

探针直接调 `inspectOwnerTransferLock` ＋ `unlockOwnerTransferLock`，跑在 `git clone --local` 副本的构建产物上：

| holder 值 | state | exit | 锁 | stderr[0] / stdout[0] |
|---|---|---|---|---|
| `["pid:999999"]` | **`dead`** | **0** | **被删** | `removed  holder=pid:999999 was not alive` |
| `["pid:0"]` | `liveness-unknown` | 1 | 留盘 | `refused  cannot determine whether pid 0 is alive: …` |
| `"pid:999999"` | `dead` | 0 | 被删 | `removed  holder=pid:999999 was not alive` |
| `"garbage"` | `unrecognized-holder` | 1 | 留盘 | `refused  unrecognized holder identity: garbage` |
| `{}` | `unrecognized-holder` | 1 | 留盘 | `refused  unrecognized holder identity: [object Object]` |

⚠️ **第一行那一格今天没有任何判据覆盖** —— 上面这次探针是唯一见过它的东西。
缺陷能活到今天，正是因为**没有任何判据会因为它而红**。

---

## 2. 为什么现在修

人裁 94 当时的处置是「**recorded, not fixed**」，理由写在 `src/persistence/fileStore.ts` 的 ERRATUM 里。
⚠️ *** **那几句【不是假话】，所以本轮不是「推翻它们」。** *** 它们是**索引式**陈述 —— 说的是**当时那一轮的授权面**：

| 原文（逐字） | 今天的状态 |
|---|---|
| 「a `typeof === "string"` guard is NEW LOGIC … outside **ruling 83's** authorisation」 | **仍然为真**。变的是新来了**人裁 121／127**，不是这句变假 |
| 「E1 is outside **this round's** authorisation」 | **仍然为真**（指人裁 94 那一轮）。本轮就是 E1 |
| 「Bounded, not a hole a thief can walk through」 | **只管红线函数那一句**，紧接着的 `MEASURED on the E1 path … costs more` 已经把 E1 的代价写出来了。**它从未宣称 E1 也有界** |

⇒ *** **追 ERRATUM 的理由是「索引式措辞会被读者误当成当前处置」，不是「原文为假」。** ***
按 ccloop 铁律 5：**原文逐字保留，只能追加具名 ERRATUM。**

---

## 3. 设计

### 3.0 *** 承重面在哪（这是第一版栽掉的地方，先说结论） ***

`inspectLock.ts` 里有**一个变量承担了两件事**：

```ts
holder = parsed.holderProcessInstanceId ?? "";   // :168  —— 它既要被【渲染给人看】
…
const pid = holder === "" ? null : parsePid(holder);  // :178  —— 又要被【喂去分类】
```

*** **只要在 `:168` 处做任何规范化，`parsePid` 在 E1 路径上就【不再承重】** *** ——
数组先变成字符串，`parsePid` 拿到它时已经不匹配了。
**实测**：只落渲染、`parsePid` 保持原样，E1 的洞照样关上，**全套零新红**（连人裁 99 那条都绿）。

⇒ *** **本设计的第一件事是把这两件事拆开。** *** 分类喂**原始值**，渲染只作用于**返回的 `holder` 字段**。
拆开之后**守卫**与**渲染**各自承重，且**各自有一条只打红自己的变异**（§6.3 的 M1 与 M3，实测）。

⚠️ *** **如实登记：拆分【本身】在输出层钉不住，没有任何一条 `it` 会因为它被收回去而红。** ***
实测（2026-09-23，独立评审席在 `git clone --local` 副本里跑）：守卫留在位、只把
`parsePid(rawHolder)` 改回 `parsePid(holder)` ⇒ `tsc` RC=0、**全套 141 条零红**。
**结构性原因**：守卫在位时，拆与不拆在 `inspectOwnerTransferLock` 的输出上**不可区分** ——
非字符串经 `JSON.stringify` 后必以 `[`／`{`／数字字面量开头，**没有任何 JSON 值能让渲染结果去匹配 `^pid:(\d+)$`**。
⇒ *** **拆分是纵深防御，它的判据是 M1 这条变异链，不是某一条 `it`。** ***
**不为它编判据**（同 §3.3 的口径）：唯一能接住它的形状是对 `parsePid` **实参类型**下 spy，
那会钉住实现细节而不是行为 —— 正是 Rule 9 的反面。
⚠️ **代价写明**：将来一次「整理代码」把拆分收回去，全套照绿；挡着它的只有那段注释与台账里 M1 的记录。

### 3.1 改动一：`parsePid` 签名改 `unknown` ＋ `typeof` 守卫

```ts
export function parsePid(processInstanceId: unknown): number | null {
  if (typeof processInstanceId !== "string") {
    return null;
  }

  const match = /^pid:(\d+)$/.exec(processInstanceId);
  return match === null ? null : Number.parseInt(match[1], 10);
}
```

**为什么两个调用方一起改**（人裁 127）：红线函数那一侧的强转**没有被 §3.2 的渲染覆盖**——
它有自己的 `JSON.parse` 和自己的 `parsePid` 调用。不改它，那一格仍然是**静默删锁**。
改完是 `{ kind: "unattributable", why: "no-pid-holder" }` ＋ **锁留盘**，方向与人裁 83 的 fail-closed 完全一致。

⚠️ *** **不要把「签名改 unknown」当成防线。** *** 实测：
- 裸删守卫 ⇒ `tsc` RC=**2**（`TS2345`）；
- 但写成 `/^pid:(\d+)$/.exec(processInstanceId as string)`（**一次「整理代码」最可能的写法**）⇒ `tsc` RC=**0**，洞照样重开。

⇒ *** **`unknown` 只提高了误删的成本，真正的防线是 §6.2 的判据。** ***
本条如实记录，**不得据此宣称类型系统挡住了它**。

### 3.2 改动二：`inspectLock` 拆分类值与渲染值

```ts
  let holder: string;
  let rawHolder: unknown;
  try {
    const parsed = JSON.parse(contents.toString("utf8")) as Partial<Record<keyof OwnerTransferLockRecord, unknown>>;
    // （此处既有注释逐字保留，不动）
    rawHolder = parsed.holderProcessInstanceId ?? "";
    holder = typeof rawHolder === "string" ? rawHolder : JSON.stringify(rawHolder);
  } catch (error) {
    …
  }

  const pid = rawHolder === "" ? null : parsePid(rawHolder);
```

三点约束，**每一条都有理由，不许简化掉**：

1. *** **分类必须喂 `rawHolder`，不是 `holder`。** *** 喂 `holder` 就是 §3.0 那个错误。
2. *** **渲染必须排在 `?? ""` 之后。** *** 排在之前的话 `undefined` 会原样流出，
   而 **TS 把 `JSON.stringify` 的返回类型声明成 `string`（不是 `string | undefined`）**，`tsc` 一声不吭，
   操作员会看到 `refused  unrecognized holder identity: undefined`。
   排在 `??` 之后，`JSON.stringify` 拿到的必定是 JSON 值 —— **实测能返回 `undefined` 的三种输入
   （`undefined`／函数／symbol）没有一种能来自 `JSON.parse`**。
3. **`holder` 是外层的 `let holder: string`**，不要写成 `const`（会改掉作用域）。

**字符串原样通过** ⇒ 既有输出与既有判据**一格不变**（实测：全套只翻人裁 99 那一条）。

### 3.3 改动三：读取处的 parse 断言放宽（**只放宽读取处**）

`inspectLock.ts` 原来断言 `Partial<OwnerTransferLockRecord>`，其中 `holderProcessInstanceId: string` ——
所以 §3.2 的 `typeof rawHolder === "string"` 在类型系统眼里是 `never` 分支，**正是 §3.1 警告的形状**。
改成 `Partial<Record<keyof OwnerTransferLockRecord, unknown>>` 之后它是真分支。

⚠️ *** **`OwnerTransferLockRecord` 本身一个字不动，写入方一个都不碰。** ***

⚠️ *** **如实登记：这一条是【类型层面的诚实】，不是运行时守卫。** ***
把断言改回去，**运行时行为一格不变**（`typeof` 在运行时照样工作）⇒
*** **它钉不住，因此【不为它编判据】** *** —— 按本仓库那条实测教训：
**钉不住的登记为冗余守卫，不编假判据。**

### 3.4 数组 holder 落 `unrecognized-holder`，不落 `unparseable`，也不新开 state

`unparseable` 那条路打的是 `refused  lock unreadable: …`，而文件**读得好好的、JSON 也 parse 成功了**——
那是一句假话。本仓库已经为 `liveness-unknown` 讲过同一个道理（`unlockCommand.ts`：
"'unreadable' would be a false statement — the record parsed fine and named a holder; what failed was the probe"）。

**不新开 state**：`unrecognized-holder` 的语义是「记录解析了、有 holder 值、我们不认得它的形式」，
数组精确落在这个定义里，且**没有任何消费者会对这两种情形做不同的事**（Rule 2）。

### 3.5 `why` 不新增第三个值

数组 holder 落既有的 `why: "no-pid-holder"` —— 对数组是诚实的，
而人裁 106 那段注释已经把诊断链设计好了：错误消息指向 `ccloop unlock <runDir>`，那条命令给出 §3.2 的忠实渲染。

---

## 4. 改动点

| # | 文件 | 改什么 |
|---|---|---|
| **1** | `src/persistence/fileStore.ts` | `parsePid` 签名 ＋ 守卫（§3.1） |
| **2** | `src/unlock/inspectLock.ts` | 拆分类值／渲染值（§3.2）＋ 放宽读取处断言（§3.3） |
| **3** | 注释 | 按铁律 5 **追加具名 ERRATUM**，已发布原文**逐字不动** |

### 4.1 ERRATUM 清单（**四处，不是三处**）

| 位置 | 被本轮改变了什么 |
|---|---|
| `fileStore.ts` 人裁 94 的 ERRATUM | **三句**（不是两句）：① `NEW LOGIC … outside ruling 83's authorisation`；② `E1 is outside this round's authorisation`；③ *** `The array case is pinned by a criterion under human ruling 99, so it cannot be "tidied" away silently` —— §6.1 一改写，这条判据钉的就是反面了 *** |
| `fileStore.ts` `parsePid` 上方那组注释 | 「mutation C measured …」那一串的前提再次移动 |
| `fileStore.ts` 人裁 108 的 ERRATUM 结尾 | 逐字：`Recorded, not fixed -- the same disposition the redline function's own ruling-94 erratum gives its array-holder cell.` *** **它把人裁 94 对数组那一格的处置当作仍然有效的先例来援引。本轮掀了那个先例。** *** |
| `inspectLock.ts` 头部人裁 83 的 ERRATUM | 原文：`On BOTH cases it names — an unrecognizable holder identity, … — the redline function no longer steals: it fails closed and refuses, exactly as this command does.` ⚠️ *** **这句对【数组 holder 这一子格】当时就过宽**（实测今天两侧都删），本轮才把它兑现。 *** ERRATUM 要记「它当时就过宽」，**不是**「新增了一格一致」 |

**另有两处「写下时就已过期」的邻近文本**（不是本轮造成的，但机械扫描会捞到，**只能另追 ERRATUM**）：

- `fileStore.ts` 人裁 83 ERRATUM 里「Under ruling 83 an unparsed holder **returns false**」——
  人裁 106 之后它返回 `{ kind: "unattributable", … }`。
- `inspectLock.ts` 人裁 100 ERRATUM 里「a null pid short-circuits **`pid === null || isProcessActive(pid)`**」——
  那个 `||` 表达式已经不存在了。

⚠️ **落地前必须跑一次全树机械扫描**（搜索词从上表被更正的句子机械导出：
`recorded, not fixed` / `array holder` / `array-holder` / `no-pid-holder` / `coerce` / `String()` / `999999`），
**扫描范围含 `src tests docs/superpowers .superpowers`**。上一轮评审**没覆盖** `docs/handoff/**` 与其它目录。

⚠️ **ERRATUM 里不许写会被后续裁决推翻的计数**，指向台账即可（铁律 5）。

---

## 5. 行为逐格（**全部实测，两臂对照**）

| holder | 今天 state / exit / 锁 / 消息 | 落地后 state / exit / 锁 / 消息 |
|---|---|---|
| `["pid:999999"]` | `dead` / **0** / **被删** / `removed  holder=pid:999999 was not alive` | `unrecognized-holder` / **1** / **留盘** / `refused  unrecognized holder identity: ["pid:999999"]` |
| `["pid:0"]`（**及溢出 pid**） | `liveness-unknown` / 1 / 留盘 / `refused  cannot determine whether pid 0 is alive: …` | `unrecognized-holder` / 1 / 留盘 / `refused  unrecognized holder identity: ["pid:0"]` |
| `"pid:999999"` | `dead` / 0 / 被删 / `removed  holder=pid:999999 was not alive` | **逐字不变** |
| `"garbage"` | `unrecognized-holder` / 1 / 留盘 / `refused  unrecognized holder identity: garbage` | **逐字不变** |
| `{}` | `unrecognized-holder` / 1 / 留盘 / `refused  unrecognized holder identity: **[object Object]**` | `unrecognized-holder` / 1 / 留盘 / `refused  unrecognized holder identity: **{}**` |

⚠️ *** **第 2 行退出码前后都是 1** *** —— 这一格**只能在 state／消息层面观测**，CLI 退出码看不见它。§6.2 的 N7 是为它立的。
⚠️ *** **第 5 行是一次【已发布输出】的改动**，今天没有任何既有判据在断言 `[object Object]` *** ——
全树扫描确认 `grep "object Object"` 只命中 `unlockCommand.test.ts` 里 `reasonFrom` 的三处，**与 holder 渲染无关**。
⇒ 它落地后仍是零覆盖，**除非** §6.2 的 N6 立起来。

⚠️ *** **嵌套数组 `[["pid:999999"]]` 与一层的行为完全相同**（今天也是 exit 0 删锁）—— 上表只列一层，
读它的人会低估洞的宽度。§8.2 已写明「嵌套可任意深」。落地后它与 `["pid:999999"]` 共用同一条
`typeof` 分支，按 Rule 2 **不为它立独立判据**。 ***

### ⚠️ `--force` 那一臂（**第二版补记；第一版从头到尾没量过它**）

最终全分支评审实测，这一臂**本轮也变了，而且是安全相关的**：

| 输入 | 今天 | 落地后 |
|---|---|---|
| 数组 holder ＋ `--force --expect <**正确** digest>` | exit 0 / 删锁 / `removed  holder=pid:999999 was not alive` | exit 0 / 删锁 / `removed  forced past unrecognized holder identity: ["pid:999999"]` |
| 数组 holder ＋ `--force --expect <**错误** digest>` | *** **exit 0 / 删锁 —— digest 根本没被检查** *** | *** **exit 1 / 锁留盘** / `refused  --expect does not match the lock on disk` *** |

**原因**：`dead` 分支排在 `if (!options.force)` 与 digest 门**之前**，
所以今天数组 holder 走 `dead` 就**绕过了整个凭证检查**。落地后它落进 `unrecognized-holder`，凭证门才生效。

⚠️ *** **`removed  forced past …` 这条分支在本轮之前【零判据】**（`git grep "forced past" -- tests` 零命中）。 ***
⇒ 已补判据，见 §6.2 的 **N8／N9**。

**红线函数那一侧**：`["pid:999999"]` 从 `{ kind: "cleared" }`（静默删锁）变成
`{ kind: "unattributable", why: "no-pid-holder" }` ⇒ 抛 `OwnerTransferLockUnattributableError`、锁留盘。
`["pid:0"]` 从 `not-determined-dead`（抛 `OwnerTransferLockBusyError`）变成 `unattributable` ⇒ **换了一个错误类**。

---

## 6. 判据计划

### 6.1 改写 1 条（**人裁 127 已具名授权**）

> **被指名的判据**：`tests/persistence/fileStore.test.ts` 的
> `"reclaims a lock whose holder is an ARRAY that String()s into pid:<n> -- pinned as measured"`

**旧判据有两半**，注释自己写着「**The second is why this matters**」：

```ts
await expect(readFile(join(runDir, ".owner-transfer.lock"), "utf8")).rejects.toThrow();  // 锁被删
expect(owner.currentOwnerEpoch).toBe(2);                                                 // owner epoch 推进了
```

*** **第一版的规格只提了第一半。两半都要收紧。** ***

**改写后必须钉的四件**（实测：落地后 `const owner = await readOwnerRecord(runDir)` 那一行**直接抛**，
所以这条判据从「读返回值」变成「接住 rejection」）：

1. `readOwnerRecord(runDir)` **拒绝**，且错误 `toBeInstanceOf(OwnerTransferLockUnattributableError)`；
2. 错误消息含 **`no-pid-holder`** 字面量；
3. 锁文件**仍在盘上且字节与写入时逐字相同**；
4. *** **owner epoch 仍为 1**（正面读回 owner record 确认没推进）—— 这是旧判据「更要紧的那一半」的收紧版。 ***

⚠️ **拿 rejection 一律用 `.then(onFulfilled, onRejected)` 并在 `onFulfilled` 里 throw**，
不要用 `.catch(e => e)`（本包栽过：promise 成功时给出 `undefined`，三条断言全在断言 `undefined`）。

⚠️ *** **判据名今天是假话**（改写后它不再 `reclaims`）。 *** 改名本身按人裁 88 需要具名 ——
**本 spec 把改名读作「整条改写」的一部分**；若人不同意改名，**请在实施前否掉这一句**。
建议新名：`refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone`。

⚠️ **(b) 不许放宽**：✅ 方向是**收紧**（从「钉住缺陷存在」改成「钉住缺陷被闭 ＋ epoch 没推进」）。
⚠️ **(c) 写明编码哪条人裁**：改写后的注释要写明编码的是**人裁 127**，
并**逐字保留**原注释那句退路（"If a later ruling closes the gap, THIS TEST IS THE ONE TO REWRITE"）——
它正是这次改写的合法性来源。

### 6.2 新增判据

| # | 落在哪 | 钉什么 | 独占场景 |
|---|---|---|---|
| **N1** | `tests/unlock/inspectLock.test.ts` | `["pid:999999"]` ⇒ `state === "unrecognized-holder"` | 分类层 |
| **N2** | `tests/unlock/unlockCommand.test.ts` | 同一输入、无 `--force` ⇒ **退出码 1** ＋ **锁文件字节不变** ＋ stderr[0] **以 `refused  unrecognized holder identity:` 开头**（**只钉前缀**） | 后果层：只有它能看见「锁没被删」 |
| **N3** | `tests/unlock/inspectLock.test.ts` | `holder === '["pid:999999"]'`（**字面量**） | 渲染层 |
| **N5** | `tests/persistence/fileStore.test.ts` | ＝ §6.1 改写后的那一条 | 红线函数那一侧 |
| **N6** | `tests/unlock/inspectLock.test.ts` | `{}` ⇒ `holder === "{}"`（**字面量**） | 对象那一格，今天零覆盖 |
| **N7** | `tests/unlock/inspectLock.test.ts` | `["pid:0"]` ⇒ `state === "unrecognized-holder"`（**不是 `liveness-unknown`**） | *** **这一格前后退出码都是 1，CLI 层看不见它** *** |
| **N8** | `tests/unlock/unlockCommand.test.ts` | 数组 holder ＋ `--force --expect <正确 digest>` ⇒ 退出码 **0** ＋ 锁**真的被删** ＋ stdout 首行以 `removed  forced past unrecognized holder identity: ` 开头 | `--force` 那一臂的放行侧，**本轮之前零判据** |
| **N9** | `tests/unlock/unlockCommand.test.ts` | *** **安全判据** ***：同一输入 ＋ `--force --expect <错误 digest>` ⇒ 退出码 **1** ＋ **锁字节不变** ＋ stderr 含 `--expect does not match` | *** **今天这一格 exit 0 删锁（凭证门被绕过），只有它能看见这次修好** *** |

*** **N4 已删除。** *** 第一版为「防无条件 `JSON.stringify`」立了 N4，
**实测证明 9 条既有判据已经接住了那个变异**（§6.3 M4）⇒ 按 Rule 2，不立冗余判据。

**三条硬要求**（§六.1 那七种「空绿」形状）：

1. *** **N2 不许只断言退出码。** *** 同时钉**锁还在**与**拒绝理由的前缀**。
   ⚠️ **前缀，不是整句** —— 整句会让 M3 同时打红 N2，破坏 §6.3 的「仅红一条」。
2. *** **期望值一律写字面量**，不许由被测函数自己算出来。 *** N3／N6 的字符串硬写。
3. *** **不许出现「排在被测调用之前、读回测试自己刚写进去的值」的断言。** *** 验收时先扫这个形状。
4. ⚠️ *** **另加一条计数判据**（`.length` 或文件级条数）*** —— 「少跑一条」在 vitest 里是绿的，只在计数里露头。

### 6.3 变异表（**「预期红在」一栏全部是实测值，不是预测**）

| # | 变异 | 喂它的场景 | **实测红在** |
|---|---|---|---|
| **M1** | `parsePid` 守卫删掉，写成 `exec(processInstanceId as string)` | `["pid:999999"]`、`["pid:0"]` | *** **N1、N2、N5、N7，且仅这四条** *** ⚠️ **N3／N6 保持绿**（渲染没动）—— 这正是两支被拆开的证据 |
| **M3** | 渲染删掉：`holder = rawHolder as string` | `["pid:999999"]`、`{}` | *** **N3、N6，且仅这两条** ***（state／exit／锁一格不变，实测） |
| **M4** | 渲染改成无条件 `JSON.stringify` | 任意字符串 holder | *** **9 条既有判据**（列表见下）⇒ 崩溃式变异，【不当证据】，只作哨兵 *** |
| **M5** | `why` 换成别的字面量 | `["pid:999999"]`，红线函数路径 | *** **N5 ＋ 既有的 `refuses a lock whose holder identity is not a pid as unattributable, never as busy`，且仅这两条** *** |

**M4 实测打红的 9 条既有判据**（在修正后的设计上量的，范围 `tests/unlock` ＋ `fileStore.test.ts` ＋ `tests/cli` ＋ `tests/controller` ＝ 357 条）：
`answers dead for a bare-pid holder whose process is gone`、`answers alive for a bare-pid holder that is still running`、
`answers unrecognized-holder for the strong identity form…`、`answers unrecognized-holder when the record parses but carries no holder at all`、
`answers liveness-unknown for pid 0…`、`still reports the real state when the descriptor fails to close`、
`removes a dead holder's lock on the default path — no --force needed`、
`refuses an unrecognized holder identity, and prints a --force line the operator can copy`、
以及 §6.1 那条。
（同一次跑里还有 `runLoop > persists phase usage evidence…`，**那是已知 flake，不算 M4 的红**。）

⚠️ **M1 是主变异**：*** **它删掉的正是本轮唯一新增的分类分支。** *** 不许缺席，不许只在纸上存在。
⚠️ *** **M1 期间 `tsc` 预期 RC=0** ***（因为用了 `as string`）——
**不要把 typecheck 绿读成「变异没落上去」**，用 `shasum -a 256` 判。
⚠️ **§3.3 那条断言放宽【没有变异】** —— 改回去运行时行为一格不变，**已在 §3.3 登记为冗余守卫，不编假判据。**

### 6.4 变异纪律

- **只在 `git clone --local` 副本里做**；主工作树零触碰，还原证明看 `git diff` 与 `git diff --cached` 的**字节数**。
- **变异落没落上去用 `shasum -a 256` 前后比对**，不相等才算落上去。
- ⚠️ *** **副本必须先 `npm run build`** *** —— `dist/` 被 gitignore，不 build 会让
  `tests/control/endToEnd.test.ts` 的 6 条以 `ENOENT … dist/cli.js` **假红**（实测踩过）。
- ⚠️ **副本没有 `node_modules`** ⇒ 软链主树的；**删副本前先 `/bin/rm -f` 软链本身**，再删目录。
- ⚠️ **每组变异先跑一次基线**，基线口径见 §8.1（**不是全绿**）。

---

## 7. 不做什么（YAGNI）

- **不**新增 `LockInspection` 的 state；**不**新增 `why` 的枚举值；**不**立 N4。
- **不**改 `OwnerTransferLockRecord` 的**类型声明** —— 会波及一大片与本缺陷无关的写入方。
  ⚠️ *** **这一条【不覆盖】读取处的 parse 断言** *** —— §3.3 正是只放宽读取处，写入方一个不碰。
- **不**在 JSON 边界引入共用的 `readLockRecord` 校验器（两个读取方的失败语义本来就不同）。
- **不**碰 `sweep` —— board C-a 把它做成 presence-only，实测它根本不读也不解析这个文件。
- **不**碰 `stopProof` 那条稳定红（§8.1）。

---

## 8. 风险与已知边界

### 8.1 ⚠️ 本包**拿不到全绿基线**，基线口径必须显式写

**稳定红 1 条**（与本缺陷无关，根因未查，无人授权动）：
`tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone`。
判别过程：副本单跑 **3/3 红**、主工作树单跑也红、单跑耗时 **5.37s**（远低于 flake 画像）⇒ **不是 flake**。

**另有 4 条已知负载相关 flake**，全部 `Test timed out in 5000ms`：
`run-scenario CLI > records env names only and tracks descendants rooted at the spawned pid`、
`runLoop > persists phase usage evidence from the subprocess adapter without recomputing controller totals`、
`runLoop > accounts an execute timeout that rejects after the abort as exhaustion`、
`run-scenario CLI > fails on an existing run directory without creating evidence or harvesting stale run data`。

⚠️ *** **第 5 条 flake 是 2026-09-23 本轮实施中新发现的**：`tests/runtime/claude/subprocessClaudeAdapter.test.ts >
SubprocessClaudeAdapter > waits for close before interrupting a close-pending successful execute`。 ***
**判为 flake 的两条证据**：(a) 因果面为零 —— `grep "inspectLock\|parsePid\|OwnerTransferLock\|unlock"
src/runtime/claude/subprocessClaudeAdapter.ts` **零命中**；(b) 在带本轮改动的工作树上**单跑 5 次 5/5 全绿**（28 passed）。

⇒ *** **基线口径 ＝「红的集合 ⊆ 上述 6 条」，不是「恰好 1 条红」。** ***
一条会因为机器忙而变号的判据，循环不到「验证为止」（Rule 4）。

**落地前在修正后的设计上已跑过全套**：`2 failed / 769 passed (771)` ——
`stopProof` ＋ §6.1 那条（它**应该**红，因为还没改写）。

### 8.2 强转面（**已实测，不再是推断**）

一次性 node 脚本枚举 `String()` ＋ `/^pid:(\d+)$/.exec`：

| 输入 | `String()` | 匹配 |
|---|---|---|
| `["pid:999999"]` / `[["pid:999999"]]` / `[[["pid:999999"]]]` | `pid:999999` | **MATCH（任意深度嵌套）** |
| `["pid:999999", ""]` / `["", "pid:999999"]` / `["pid:999999", null]` | 带逗号 | 不匹配 |
| `[]` / `[""]` / `[null]` | `""` | 不匹配 |
| `{}` / `{a:1}` | `[object Object]` | 不匹配 |
| `999999` / `true` / `null` | 各自 | 不匹配 |

⇒ **必须恰好一个元素**（多一个 `join(",")` 就插逗号，`$` 锚点立刻失配）；**嵌套可任意深**。
`String()` 在这批输入上**没有一个会抛**（`JSON.parse` 造不出 null-prototype 对象）。

⚠️ *** **但「能不能强转」不是唯一该量的维度。** *** `["pid:0"]`、`["pid:<溢出>]` 都强转成功，
却落 `liveness-unknown` 而不是 `dead`（§5 第 2 行）。
**实施阶段的枚举探针要按【落地 state】分组，不是按「匹配／不匹配」。**

### 8.3 本轮不解决「操作员看不见卡死的锁」

那是 I-3 的形状（已另行收口）。本轮只改**分类**与**渲染**。

### 8.4 台账与活文档纪律不因本轮放宽

`.superpowers/sdd/**` 历史一个字不改，发现写错另起一节记更正。

---

## 9. 验收判据（**每条都能跑出 0 / 非 0**）

```bash
cd /Users/biran/code/skills/loop/ccloop
export ECC_GATEGUARD=off DISABLE_OMC=1

npm run typecheck > /tmp/i2-tc.txt 2>&1;   echo "TC_RC=$?"
npm run build     > /tmp/i2-build.txt 2>&1; echo "BUILD_RC=$?"
./node_modules/.bin/vitest run > /tmp/i2-suite.txt 2>&1; echo "SUITE_RC=$?"
```

**通过条件**（重定向到文件后**整份读回**，不许过滤）：

1. `TC_RC=0`、`BUILD_RC=0`。
2. *** **全套红的集合 ⊆ §8.1 那 6 条已知集合，且【本轮新增与改写的判据全绿】。** ***
3. 判据总数 ＝ **771 ＋ 本轮净新增条数**，且与 §6.2 的表逐条对得上（**另有一条计数判据**）。
4. *** **§6.3 的 M1、M3、M5 三条变异，每一条都被【看到】打红，且红的集合与「实测红在」一栏逐格相符**
   （写成「红在 X 且仅 X」，不留「至少」）。 *** M4 只作哨兵，不计入证据。
5. 主工作树零触碰证明：变异期间 `git diff` 与 `git diff --cached` 在 `src tests` 范围内**字节数为 0**。

⚠️ **终点判据不是「测试绿了」** —— 是第 4 条。
*** **一条判据在被【看到】打红之前，它不是判据。** ***

---

## 10. 第一版被推翻了什么（**留档，不要引用第一版**）

第一版由一位独立挑错席评审（4 Critical / 9 Important / 6 Minor），控制器**逐条复核、没有照收**。

| 编号 | 第一版的说法 | 结果 |
|---|---|---|
| **C1** | 「渲染贴在 `holder` 赋值处」＋「M1 会打红 N1/N2/N3」 | *** **成立且致命。** *** 那样贴会短路 `parsePid`，守卫在 E1 侧完全不承重。**控制器三臂复现**，据此重写 §3.0／§3.2 |
| **C2** | 「M4 唯一的作用是打红 N4」 | **成立。** 控制器在修正后的设计上重测：M4 打红 **9 条既有判据** ⇒ **删掉 N4** |
| **C3** | 「M5 红在 N5」 | **成立。** 实测 M5 红 2 条 |
| **C4** | §3.4 的守卫是 `never` 分支 | **成立。** 据此新增 §3.3（放宽读取处断言），并**登记为钉不住、不编判据** |
| **I1–I9** | ERRATUM 漏第四处、§2 自相矛盾、§4 item 3 说反、§6.1 漏 owner-epoch 那一半、§5 漏 `pid:0` 那一格、对象格零覆盖、N1 被 N2 蕴含、M3 与 N2 冲突、基线口径漏 4 条 flake | **全部成立**，已逐条落进本版 |
| **Mi1–Mi6** | 表达式贴不上去、判据名是假话、M1 的 typecheck 预期、强转面枚举、两处邻近过期注释 | **全部成立**，已落进本版 |

⚠️ *** **一条控制器【不同意】挑错席的**（它只量了一半） ***：
Mi3 说「M1 按字面落上去过不了 typecheck」，据此暗示类型能挡住误删。
**控制器实测**：裸删确实 RC=2，**但写成 `as string` 的 tidy-up ⇒ RC=0，洞照样重开**。
⇒ §3.1 已如实改写成「`unknown` 只提高成本，真正的防线是判据」。

⚠️ **挑错席自己声明没验证的六项**（全套 771 没跑、真 CLI 字节没看、人裁台账没查、
`docs/handoff/**` 没扫、主树零触碰用的是 `status` 不是字节数、`npm run build` 没跑）——
**控制器已全部补测**，结果写在上文各节。

---

## 11. 下一步

接 `superpowers:writing-plans` 出实施计划，再走 `superpowers:subagent-driven-development`（人裁 128）。
