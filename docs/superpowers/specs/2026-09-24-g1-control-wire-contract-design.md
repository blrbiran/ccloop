# G1：control v1 线上契约设计（capability 词汇表 ＋ `targetVersion` 定型）

**作者**：Orca 控制器会话 `a4f77b1f-c842-41ee-8e25-70d1dcdfaa75`（Opus 5 1M），2026-09-24。
**写在哪一笔上**：ccloop `d8708c7`（`docs(handoff): the queue is empty here; the next thing is
the wire contract`）、Orca `eaf9112`（`docs(sdd): rebuild the control gate baseline …`）。
写本文时三仓 `ls-remote` 与本地一致。

**权属**：人裁 G1（2026-09-22）——**ccloop↔Orca 的线上契约归 ccloop**。本文是 Orca 侧
调度方整理的设计，**ccloop 对其中每一格有最终裁量权**；标着 🔴 的两格**尚未由 ccloop 现测确认**，
见 §7。

---

## 1. 范围

**做**：`control capabilities` 的应答形状（capability 词汇表）＋ `targetVersion` 的类型定型，
以及 Orca 侧为跟随它们而必须改的地方。

**不做**（都在本轮明确排除，不是遗漏）：

- **`scheduler/planFile.ts` 的 `targetVersion`**。它是**人写的 plan 文件**的 schema，
  改它是对外破坏性变更，与线上契约不是一回事。**2026-09-24 人裁：排除在 G1 之外。**
- **把 `capabilities` 从静态常量改成按 adapter 计算**。**2026-09-24 人裁：分两步走**——
  G1 只做「补齐字段 ＋ 打通 Web 派活」，计算化另开一轮。见 §6。
- **`contextObservation` 的实时观测 emit**（handoff 记的「缺口二」）。G1 只要求**诚实申报**它不存在。
- Orca 的 `work item`／`group`／`orca-raw-command-v1`／`expectedRevision`
  —— 那是 Orca Panel ↔ Orca Web 的内部契约，**本仓库零消费者，不搬过来**。

## 2. 现状（**全部现测，命令与锚点随值同列**）

### 2.1 ccloop 今天答什么

命令（在 `codex/codex-adapter-0919` 的 `clone --local` 副本上 `npm run build` 之后）：

```sh
# CCLOOP_TREE / ADAPTER_CONFIG 由调用者赋值；护栏确保未赋值时立刻失败而不是展开成空串。
# ADAPTER_CONFIG 必须 realpath 等于自身（见 §8），macOS 上即必须写 /private/tmp/… 而非 /tmp/…
echo '{}' | node "${CCLOOP_TREE:?set CCLOOP_TREE}/dist/cli.js" control capabilities \
  --adapter codex --adapter-config "${ADAPTER_CONFIG:?set ADAPTER_CONFIG}"
```

RC 0，逐字应答：

```json
{"protocol":1,"durableAccept":true,"ownershipIsolation":true,"evidenceRetention":true,
 "usageObservation":"phase-end","budgetEnforcement":"soft","requestBoundEvidence":null}
```

*** **这整个应答是一个字面量常量**（`src/control/command.ts` 的 `method === "capabilities"` 那一支，
主线现测）。 *** 七个字段没有一个是算出来的；`defaultHandler` 手上有 `context.adapter` 与
`adapterConfigPath`，**一个都没用**。

⇒ 由此得到两条本设计要处置的结论：

1. *** **`durableAccept`／`ownershipIsolation`／`evidenceRetention` 恒为 `true`，不携带信息。** ***
   Orca `src/control/budget.ts` 的 `!c.durableAccept || !c.ownershipIsolation || !c.evidenceRetention`
   **三格永远为假、零承重**。留着它们等于在生产代码里留三个看起来在工作的假守卫。
2. Orca 的 `intersectCapabilities(declared, observed)` 本意是拿**两个独立来源**取保守下界，
   而 `observed` 这一侧现在也是常量 ⇒ **这条路上的交集运算零信息增益**。这条在 G1 里不修（见 §6），
   但**不许在别处被描述成「已经在做能力协商」**。

### 2.2 Orca 今天要什么

`src/control/webProtocol.ts` 的 `capabilityViewSchema`（七字段）与 `src/control/schema.ts` 的
`capabilitiesSchema`（七字段）是**两套词汇表**，交集只有 `usageObservation` 与 `budgetEnforcement`，
且后者**第三个枚举值两边拼法不同**：

```
schema.ts        budgetEnforcement: ["bounded","soft","unsupported"]   ← 线上词汇
webProtocol.ts   budgetEnforcement: ["bounded","soft","unavailable"]   ← Web 词汇
```

`usageObservation` 两边都是 `unavailable`，所以 `unsupported` 是**孤例**。
Orca `src/control/ccloopPort.ts` 的 `probeProfileCapabilities()` 已经在做
`unsupported → unavailable` 的转换，**该方向已被实践认可**。

### 2.3 硬失败是刻意的守卫，不是缺口

Orca `src/control/service.ts` 的 `profiledCapabilities` 要求 `handoffControl === "durable"`
**且** `handoffExecution !== null`，比「不是 unavailable」严格。`profiles.ts` 的
`unavailableCapabilities` 不是「降级继续派活」的兜底，而是**探测失败时的确定保守值**，
正好喂给这个守卫让它必然拒绝。两者是配合的。

⇒ *** **G1 不放宽这个守卫，而是让 ccloop 真答满。** *** （2026-09-24 人裁的方向。）

### 2.4 关键路径只有两个字段

在 Codex 的 soft 模式下逐条核 `service.ts` 的守卫：

| 字段 | 守卫 | 阻塞派活 |
|---|---|---|
| `handoffControl` | 必须 `=== "durable"` | **是** |
| `handoffExecution` | 必须 `!== null` | **是** |
| `contextObservation` | 不检查 | 否 |
| `contextWindowTokens` | 不检查 | 否 |
| `requestBoundProof` | 仅 `mode === "strict"` 检查 | 否（strict 在 Codex 上不可达） |

⇒ *** **打通「Web 派活能开出一个 run」的最小真集是两个字段。** *** 另外三个仍要补齐
（能力视图要诚实），但**不在关键路径上**，不得因为它们而推迟终点判据。

## 3. 前提：粒度对齐（**必须显式，否则会被读错**）

| | 粒度 |
|---|---|
| Orca `CapabilityViewV1` | **per execution profile**（`snapshot.profile.capabilities`） |
| ccloop `control capabilities` | **per (adapter, adapter-config)** |

合并隐含一条断言：*** **一份 adapter config ↔ 一个 execution profile。** ***
它站得住——adapter config 的内容正是 `model`／`sandbox`／`timeoutMs`，就是一个 profile 的内容。

⚠️ *** **这条必须写在契约里，不能靠读者自己意会。** *** `handoffExecution` 在
「ccloop 整体的能力」与「这个 profile 的能力」两种读法下**取值不同**：
`src/control/stopIntent.ts` 的语义是 `run.handoffProfile === null ⇒ "mechanical-in-run-v1"`，
即该字段答的是**这次 handoff 要不要模型参与**，不是对端的固有属性。

## 4. 新的线上形状

`control capabilities` 的应答，**`protocol` 升到 `2`**（破坏性变更要能被对端识别）：

```json
{
  "protocol": 2,
  "usageObservation": "phase-end",
  "budgetEnforcement": "soft",
  "contextObservation": "unavailable",
  "handoffControl": "durable",
  "handoffExecution": "model-assisted-v1",
  "contextWindowTokens": null,
  "requestBoundProof": null
}
```

逐格依据：

| 字段 | 值 | 依据 |
|---|---|---|
| `protocol` | `2` | 删字段 ＋ 改类型，对端必须能分辨新旧 |
| `usageObservation` | `"phase-end"` | 现状；Codex 只支持它（不得在任何地方宣称 realtime） |
| `budgetEnforcement` | `"soft"` | 现状；**第三值统一为 `unavailable`**，`unsupported` 废弃 |
| `contextObservation` | `"unavailable"` | **诚实**：ccloop 侧无实时观测 emit。守卫不查它 |
| `handoffControl` | 🔴 `"durable"` | **关键路径。需 ccloop 现测确认，不许照名字猜**（§7） |
| `handoffExecution` | 🔴 `"model-assisted-v1"` | **关键路径。需 ccloop 现测确认**（§7） |
| `contextWindowTokens` | `null` | 人裁第一步：暂留常量。**它今天是个诚实的「不知道」，不是测得的值** |
| `requestBoundProof` | `null` | Codex 只 soft ⇒ strict 不可达 ⇒ 该 descriptor 无消费场景 |

**删掉**：`durableAccept`、`ownershipIsolation`、`evidenceRetention`。
理由见 §2.1 结论 1。⚠️ **反方论证已做**：将来若某 adapter 真的不做 ownership isolation，
该字段就有信息了——但那时它该是一个**算出来的**字段，届时加回来；
而「accept 是持久的」这个从未为假的声明属于 spec 文档，不属于线上字节。

`requestBoundEvidence`（`string | null`）→ `requestBoundProof`（descriptor | null）。
**这不是改名，是类型升级**：descriptor 形状为
`{scheme:"adapter-request-bound-v1", version, workDimensions:已排序[], handoffDimensions:已排序[], evidenceKind}`，
strict 模式的判据要读它的 `workDimensions`。

## 5. Orca 侧的跟随改动

| 位置 | 改法 |
|---|---|
| `src/control/schema.ts` 的 `capabilitiesSchema` | 与 §4 形状对齐；删三个布尔；`unsupported` 废弃 |
| `src/control/types.ts` 的 `Capabilities` | 同上 |
| `src/control/budget.ts` | **删三格恒假守卫**；按新字段重写该处判断 |
| `src/control/ccloopPort.ts` 的 `probeProfileCapabilities()` | 形状一致后从「硬编码翻译」变直通 |

⚠️ *** **`ccloopPort.ts` 里那段说明缺口的长注释是【已发布文本】。** ***
它写着「ccloop's `capabilities` … none of them covers …」「that is a ccloop-side change」——
这些话在 G1 落地后会变成假的。**唯一合法的修法是在该注释块末尾追加一条具名 ERRATUM，
原文逐字保留**，不许就地改。

## 6. 明确留给后续的（**登记，不是遗漏**）

1. **`capabilities` 计算化**。`contextWindowTokens` 必然要按模型算 ⇒ 补它就必须让
   `capabilities` 从常量变成计算。**人裁分两步**，此为第二步，G1 不做。
   ⚠️ 在它落地之前，*** **不许任何文档把 `contextWindowTokens: null` 描述成「测得该模型无窗口限制」** ***
   —— 它是「没去测」。
2. **`contextObservation` 的实时 emit**（缺口二）。
3. **`intersectCapabilities` 的信息增益**：两侧都是常量期间，该函数在这条路上不产生约束。

## 7. 🔴 待 ccloop 现测确认的两格（**契约归它拍，本文不替它宣布**）

1. **`handoffControl` 是否真的是 `"durable"`**。三值语义为 `durable | phase-end | unavailable`。
   需要 ccloop 侧给出：handoff 的控制在崩溃后是否可从文件重建。
   **答 `phase-end` 会使 Web 派活继续被拒**——所以这一格答错，终点判据就达不成，
   而**答错的代价是把不成立的前提写进契约**。
2. **`handoffExecution` 是 `"model-assisted-v1"` 还是 `"mechanical-in-run-v1"`**。
   按 §3 的粒度前提，它答的是「这份 adapter config 描述的 profile，做 handoff 时要不要模型参与」。
   Codex adapter 能跑模型 ⇒ 倾向 `model-assisted-v1`，但**归 ccloop 拍**。
   ⚠️ 选 `model-assisted-v1` 会额外触发 Orca `webService.ts` 的一条要求：
   handoff grant 的各维度必须 ≥ 1。

## 8. 判据

**回绿**（Orca 侧，定义取自 Orca handoff §三，本轮已完整复现）：

- `npm run verify:control` ＝ RC 0 / 43 文件 / 432 通过 / **0 skipped**
- `npm run verify:web-control:consumer` ＝ RC 0 / 4 通过 / 0 失败

⚠️ *** **跑这两道门之前必须重建 `ORCA_CCLOOP_BIN` 指向的 `dist`** *** —— 否则量的是旧二进制。
⚠️ `ORCA_CCLOOP_ADAPTER_CONFIG` 的路径**必须 `realpath` 等于自身**
（ccloop `src/control/command.ts` 的检查），macOS 上 `/tmp` 是软链 ⇒ **必须写 `/private/tmp/…`**。
⚠️ `verify:web-control:consumer` **不需要** `ORCA_CCLOOP_ADAPTER_CONFIG`，只需 `ORCA_CCLOOP_BIN`。

**ccloop 侧**：`node scripts/check-known-reds.mjs <vitest --reporter=json 输出>` 退 0
（按全名做子集判定；名单本身是会过期的现测，引用前确认它是哪一轮测的）。

**终点**：*** **Web 派活到真 ccloop 能开出一个 run。** ***

**变异要求**（Rule 9 / ccloop 铁律 6）：每新增一个分支，点名那条**删掉它自己**的变异，
并确认它存在且**被看见打红**。特别地：

- 删掉 `protocol === 2` 的判断 ⇒ 必须有判据红。
- 把 `handoffControl` 答成 `"phase-end"` ⇒ 必须有判据红（这是关键路径字段，
  «答对了» 和 «答了个能过守卫的值» 是两件事）。
- 删掉 `budget.ts` 里重写后的守卫 ⇒ 必须有判据红。
  ⚠️ **删掉它今天的版本不会红**（三格恒假），所以这条变异**只有在重写之后才有意义**
  —— 不得拿旧版本跑一次绿就宣称覆盖。

## 9. `targetVersion` 定型

*** **定为安全整数。** *** 这不是新拍的决定，是**承认 ccloop 已经拍了的**：

| 侧 | 现测 |
|---|---|
| ccloop（契约权属方） | 类型声明处**逐一点名**：`src/control/protocol.ts` 的接口字段与 schema 字段、`handoff.ts` 的接口字段、`command.ts` 的 schema 字段 —— 全是 `safeInteger`／`number`。**全仓 `targetVersion` 无一处字符串。**（`handoff.ts` 另有一处是赋值而非类型声明，不计入。） |
| Orca 唯一的生产者 | `src/control/commands.ts` 的 `(old?.targetVersion ?? 0) + 1` —— 单调递增计数器 |
| Orca `src/control/**` | 全部整数 |
| Orca 字符串处 | `webProtocol.ts`（`nonemptyString`）、`web/src/controlTypes.ts` |
| Orca 胶水 | `panel/controlViews.ts` 的 `z.union([z.string().min(1), safeInteger])` ＋ `String()` 比较 |

*** **最后一行是一处在生效的缺陷，不是一种设计。** *** `String(1) === String("1")`
⇒ 那道 union 的类型守卫在该路径上**不承重**。这正是 Orca handoff §六.1 的第八种形状
（一个变量同时承担「被判断」与「被展示」，规范化静默解除守卫）。

**收敛动作**：`webProtocol.ts` 两处 `nonemptyString` → `safeInteger`；
`web/src/controlTypes.ts` → `number`；`panel/controlViews.ts` 删 union、删 `String()` 强转。
**`scheduler/planFile.ts` 不动**（§1）。

⚠️ **反方论证已做**：字符串更宽，将来若要放 git sha 或语义版本，整数堵死。
——不成立：该字段的语义由 `+1` 与 `target-version-conflict` 的相等判断固定为
「同一份工作的第几版」，**是字段名误导了**；要放 sha 那是新字段。
且放宽有迁移成本（已有台账写入方）。
