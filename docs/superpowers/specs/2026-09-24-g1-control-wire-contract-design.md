# G1：control v1 线上契约设计（capability 词汇表）

**作者**：Orca 控制器会话 `a4f77b1f-c842-41ee-8e25-70d1dcdfaa75`（Opus 5 1M），2026-09-24。
**写在哪一笔上**：ccloop `3b9a361`、Orca `eaf9112`。写本文时三仓 `ls-remote` 与本地一致。
**权属**：人裁 G1（2026-09-22）——**ccloop↔Orca 的线上契约归 ccloop**。

> ⚠️ *** **本文是第三版。前两版的两处论断被推翻，经过逐字记录在 §10。** ***
> **不要把 §10 当历史注脚删掉** —— 它记的是「作者自己写着『不许照名字猜』，然后猜了两次」，
> 是「派独立评审席」这个做法本身唯一的现测证据。

---

## 1. 最重要的一条：G1 是**两条独立的缝**，不是一条链

三份 handoff 都把 G1 描述成一条链：「定契约 → Orca 跟随 → 两条红判据回绿 → Web 派活开出一个 run」。
*** **现测表明这条因果链不存在。** ***

| | **缝 A：capability 词汇表** | **缝 B：`targetVersion` 类型分叉** |
|---|---|---|
| 症状 | 真 ccloop 答不满 ⇒ Web 派活被拒 | `webCcloopSmoke` 两条判据红 |
| 拒点 | `src/control/webDispatch.ts` 的 `probeBlocksDispatch` | `src/control/startEnvelope.ts` 的 `safeInteger` 解析 |
| 根因 | ccloop 的 `capabilities` 不答五个字段 | plan 文件的 `targetVersion` 是字符串 |

**证据（现测）**：`tests/control/webCcloopSmoke.test.ts` 的 `codexProbe()` 注释逐字写着
「Only the three fields the adapter answers come from the subprocess; the rest are what a
deployment declares」—— `handoffControl`／`handoffExecution`／`contextWindowTokens`
**是从 declared profile 借的**。*** **该测试故意绕过了缝 A，所以它的红与缝 A 无关。** ***

⇒ *** **修好 A，那两条判据仍然红；修好 B，Web 派活仍然被拒。** ***

**本文只做缝 A。** 缝 B 的现测记录在 §9，**不在 G1 范围内**，理由见 §2。

## 2. 范围

**做**：`control capabilities` 的应答形状，以及 Orca 侧为跟随它而必须改的地方（含测试与夹具）。

**不做**：

- **缝 B（`targetVersion` 收敛）**。它的下游是 `src/scheduler/planFile.ts` 的
  `targetVersion: z.string().min(1).optional()`，改它就是**改人写的 plan 文件格式**
  ——2026-09-24 人裁已把 `planFile.ts` 排除在 G1 之外。
  ⚠️ *** **由此得出一条必须写明的推论：那两条红判据【在 G1 内不可能回绿】。** ***
  把它们列进 G1 的回绿判据，等于给 G1 设一个它结构上达不成的目标。
- **`capabilities` 计算化**（2026-09-24 人裁：分两步，此为第二步）。
- **`contextObservation` 的实时 emit**（缺口二）。G1 只要求诚实申报它不存在。
- Orca 的 `work item`／`group`／`orca-raw-command-v1`／`expectedRevision` —— 本仓库零消费者。

## 3. 现状（**全部现测**）

### 3.1 ccloop 今天答什么

```sh
# CCLOOP_TREE / ADAPTER_CONFIG 由调用者赋值；ADAPTER_CONFIG 必须 realpath 等于自身（见 §8）
echo '{}' | node "${CCLOOP_TREE:?set CCLOOP_TREE}/dist/cli.js" control capabilities \
  --adapter codex --adapter-config "${ADAPTER_CONFIG:?set ADAPTER_CONFIG}"
```

RC 0，逐字：

```json
{"protocol":1,"durableAccept":true,"ownershipIsolation":true,"evidenceRetention":true,
 "usageObservation":"phase-end","budgetEnforcement":"soft","requestBoundEvidence":null}
```

*** **整个应答是一个字面量常量**（`src/control/command.ts` 的 `method === "capabilities"` 那一支）。 ***
`defaultHandler` 手上有 `context.adapter` 与 `adapterConfigPath`，**一个都没用**。

⚠️ *** **「三个布尔恒真」只对【生产对端】成立，不等于「无判据覆盖」。** *** 见 §7 的 T3。

### 3.2 两套词汇表

`webProtocol.ts` 的 `capabilityViewSchema`（七字段）与 `schema.ts` 的 `capabilitiesSchema`（七字段），
交集只有 `usageObservation`／`budgetEnforcement`，且后者第三值两边拼法不同
（`unsupported` vs `unavailable`）。`usageObservation` 两边都是 `unavailable` ⇒ `unsupported` 是孤例。
`ccloopPort.ts` 的 `probeProfileCapabilities()` 已在做 `unsupported → unavailable` 的转换。

### 3.3 拦住 Web 派活的是哪个守卫（**核对象：`webDispatch.ts`**）

⚠️ *** **终点判据走的是 `src/control/webDispatch.ts` 的 `probeBlocksDispatch`，不是
`src/control/service.ts` 的 `profiledCapabilities`。** *** 后者服务 `claimProfiled`／`runProfiled`
那条非 Web 路径。两者形状相同，但**本文的终点只经过前者**
（`tests/control/webCcloopSmoke.test.ts` import 并调用 `deliverScheduledStart`）。

`probeBlocksDispatch` 的完整条件（现测）：

| 字段 | 阻塞派活 | 今天是否已满足 |
|---|---|---|
| `probeFailureCode !== null` | 是 | 满足（探测本身不失败） |
| `usageObservation === "unavailable"` | **是** | **已满足**（答 `phase-end`） |
| `budgetEnforcement === "unavailable"` | **是** | **已满足**（答 `soft`） |
| `handoffControl !== "durable"` | **是** | **今天缺** |
| `handoffExecution === null` | **是** | **今天缺** |
| `contextObservation` | 否 | — |
| `contextWindowTokens` | 否（但见 §6.1） | — |
| `requestBoundProof` | 仅 strict | strict 在 Codex 上不可达 |

⇒ *** **阻塞派活的是四格，其中【今天还缺的】是两格。** ***
这两句不能混为一谈——上一版写成「关键路径只有两个字段」，那是把「还缺两格」说成了「只有两格承重」。

⚠️ **strict 不可达的硬依据**：`webProtocol.ts` 的 superRefine 强制
`adapter === "codex"` 的 profile 必须声明 `budgetEnforcement === "soft"`；
ccloop 的 codex adapter config schema 里 `budgetMode: z.literal("soft")`，**类型上就无法表达别的值**。
⚠️ **但 group 的 `budgetMode` 默认是 `strict`** ⇒ **终点判据必须显式用 soft group**。

## 4. 前提：粒度

| | 粒度 |
|---|---|
| Orca `CapabilityViewV1` | **per execution profile** |
| ccloop `control capabilities` | 契约上按 **(adapter, config)** 解释（§3.1 已证：今天它与两者都无关） |

⚠️ *** **不是 1:1。** *** 一次 `confirm` 要绑四个槽位（estimator／worker／handoff／goalReview），
**四个 profile 完全可以共用一份 adapter config**；而 Orca 的 profile 快照含
`allowedWorkKinds`／`modelPolicyRef`／`contextTokenizer`／`workMaxOutputTokens` 等
**adapter config 里没有的字段**。

⇒ 真正要对齐的不是「一份 config 对一个 profile」，而是
*** **每个 profile 声明的 capabilities 必须与对端答的一致** *** —— 见 §5.3。

## 5. 新的线上形状

### 5.1 应答

`protocol` 升到 `2`：

```json
{
  "protocol": 2,
  "usageObservation": "phase-end",
  "budgetEnforcement": "soft",
  "contextObservation": "unavailable",
  "handoffControl": "durable",
  "handoffExecution": "mechanical-in-run-v1",
  "contextWindowTokens": null,
  "requestBoundProof": null
}
```

**删掉** `durableAccept`／`ownershipIsolation`／`evidenceRetention`。
**`requestBoundEvidence`（`string|null`）→ `requestBoundProof`（descriptor|null）**，
descriptor 形状见 `webProtocol.ts` 的 `requestBoundProofDescriptorSchema`。

### 5.2 两格关键值的现测依据

- **`handoffControl = "durable"`**：`src/control/handoff.ts` 的 `requestHandoff` 应答
  **两态** `latched`／`complete`（⚠️ `unknown` 是 **Orca 侧**补的第三态，不是对端答的），
  请求可在运行中被闩住、经 `atomicReplacePrivateFile` 落盘、带 `testCrashPoint`
  ⇒ 不受阶段边界约束且持久。
- **`handoffExecution = "mechanical-in-run-v1"`**：见 §10.2（这一格推翻过一次）。

### 5.3 由 5.2 推出的约束

`profiles.ts` 的 `intersectCapabilities` 对该字段是**相等才保留、否则取 `null`**，
而守卫拒绝 `null`。⇒ *** **profile 里 declared 的 `handoffExecution` 也必须是
`mechanical-in-run-v1`。** *** 否则失败会报成 `control-capability-unsupported`，
**看起来像「对端没答」，实际是「两边答得不一样」** —— 判据必须**分别钉住这两种成因**。

⚠️ *** **落脚点缺失（未解决，实施第一步要处理）** ***：全仓 grep
`orca-execution-profile-snapshot-v1` 的命中**全在 `tests/`／`docs/`／schema 定义**，
**仓库里没有任何真实的 profile 快照**。终点判据缺这个必需输入。

## 6. 明确留给后续的

1. **`capabilities` 计算化**（人裁第二步）。
   ⚠️ *** **`contextWindowTokens: null` 有一个必须登记的代价**：`src/control/estimator.ts`
   检查它（`observed.contextWindowTokens === null` ⇒ blocked），而交集规则是任一侧 null 则 null
   ⇒ **每个 Web group 的 budget estimate 恒为 `estimate-blocked-capability`**。
   已核**不挡终点**（import 仍返回 `imported`，终点路径不经过 estimate），但**代价要登记**。 ***
   ⚠️ `webService.ts` 的 `contextWindowTokens` 读的是 **declared 快照而非交集**，confirm 不受影响。
2. **缝 B（`targetVersion`）** —— 见 §9。
3. **`contextObservation` 实时 emit**（缺口二）。
4. **`estimator.ts` 是 6/7 个能力字段的消费者**，本轮不改，但任何改能力语义的轮次都要把它算进去。

## 7. Orca 侧的跟随改动

### 7.1 生产文件

| 位置 | 改法 |
|---|---|
| `src/control/schema.ts` | *** **`capabilitiesSchema = capabilityViewSchema.extend({protocol: z.literal(2)}).strict()`** *** —— 不要再维护第二份字段列表，否则拼写漂移会原样复发 |
| `src/control/types.ts` | `Capabilities` 从 `CapabilityViewV1` 派生 |
| `src/control/budget.ts` | 见 T3／T4 |
| `src/control/ccloopPort.ts` | `probeProfileCapabilities()` 变直通 |

⚠️ *** **`ccloopPort.ts` 里那段说明缺口的长注释是【已发布文本】。** *** G1 落地后它会变成假的。
**唯一合法的修法是在该注释块末尾追加具名 ERRATUM，原文逐字保留。**

### 7.2 测试与夹具（**上一版整个漏掉了这一层**）

`grep -rn "durableAccept\|ownershipIsolation\|evidenceRetention\|requestBoundEvidence"`
命中 **18 个文件**（作者以 python 直读现测，**不经 grep**——见下方警告），
其中这两个**不是跟着改的夹具，它们是判据本身**：

- *** **`tests/control/fixtures/fake-ccloop-control.mjs`** *** 是 `verify:web-control:consumer`
  的协议替身，写死 `protocol:1` 的七字段。**不改它，那道门 G1 后量的还是旧协议。**
- *** **`tests/control/webCcloopSmoke.test.ts` 的 `codexProbe()`** *** 把对端答不出的四格
  从 declared profile 借过来（§1 的证据）。G1 后它必须重写成直通 ——
  ⚠️ *** **§8 那条「把 `handoffControl` 答成 `phase-end` 必须有判据红」的变异，今天没有任何
  判据能实现，它的家就在这个文件里。** ***

⚠️ *** **这一族文件清点不许用 `grep`。** *** 本轮实测：同一个文件 `grep` 报 1 行、python 直读 5 行，
**工具静默漏报了 4 行且没有任何截断提示**。清点消费者一律 python 逐行读。

其余需要同步的：`tests/control/` 下 budget／endToEnd／planImport／profiles／schedulerBridge／
webFaults ＋ `fixtures/{store,web}.ts`、`fixtures/fake-control-peer.mjs`；
`tests/panel/` 下 controlConfig／controlConfigPort／controlReadApi ＋ `fixtures/controlPanel.ts`。

## 8. 判据

### 8.1 回绿的定义（**上一版继承错了**）

⚠️ *** **两条 `webCcloopSmoke` 的 `targetVersion` 判据【不在 G1 的回绿范围内】** ***（§2）。
沿用 Orca handoff §三 那条「432 通过」是错的——那个数字描述的是**改动前**的基线。

**本轮的判据**：

| 门 | 为什么必须跑 |
|---|---|
| `npm run verify:control` | 覆盖 `tests/control` |
| `npm run verify:web-control` | ⚠️ **上一版漏了**：它才覆盖 `tests/panel/control*.test.ts` |
| `npm run build --workspace web` ＋ `npm run verify:panel` | ⚠️ **上一版漏了**：`web/tests/*.tsx` 两道 control 门一个都不跑 |
| `npm run verify`（整条） | 收尾一次 |

⇒ *** **上一版的两道门覆盖不到 §7 要改的文件**：可以做完全部改动、两道门全绿，而 `npm run verify` 是坏的。 ***

**ccloop 侧**：⚠️ `scripts/check-known-reds.mjs` **只在 `main` 上存在，
`codex/codex-adapter-0919` 分支上没有**（`git diff --stat` 现测：该文件 90 行，分支侧为空）。
**实施第一步必须先定：ccloop 侧的改动落在哪个分支**；若落在 codex 分支，这条判据要换或要先把脚本带过去。

**终点**：Web 派活到真 ccloop 能开出一个 run，**用 soft group**（§3.3）。

### 8.2 变异要求（**每条都点名它打红哪里**）

| 变异 | 期望 | 注意 |
|---|---|---|
| T1 把 `handoffControl` 答成 `"phase-end"` | 红 | **今天没有判据能接住**，家在 `codexProbe()`（§7.2） |
| T2 把 `handoffExecution` 答成 `null` | 红 | 同上 |
| T3 删 `budget.ts` 的 `!c.durableAccept` | ⚠️ *** **今天就会红** *** | `tests/control/budget.test.ts` 的 `it.each` 里有 `{...caps,durableAccept:false}`，`caps.budgetEnforcement="bounded"` ⇒ strict 分支走不到，唯一能抛的就是这一格；`schedulerBridge.test.ts` 同形。**删字段必须同时处理这两处，并说明删掉的是什么保证** |
| T4 删 `budget.ts` 的 `c.protocol!==N` 子句 | ⚠️ *** **不会红** *** | `budget.ts` 先 `capabilitiesSchema.safeParse`，而 schema 是 `z.literal(N)` ⇒ **该子句永远打不到**。**承重的是 schema 的 literal，变异要打那里** |
| T5 把 schema 的 `z.literal(2)` 改回 `1` | 红 | 这才是 protocol 的承重点 |

⚠️ *** **T3／T4 是同一族（守卫是否承重）的两个相反答案。** *** 上一版把 T3 断言成「不会红」——
那是从「对生产对端恒真」外推到「无判据覆盖」，**而测试用的是合成对象，不是对端的应答**。

## 9. 缝 B 的现测记录（**不做，登记**）

`targetVersion` 在 ccloop 侧**已定为安全整数**：`src/control/protocol.ts` 的接口字段与 schema 字段、
`handoff.ts` 的接口字段、`command.ts` 的 schema 字段，逐一点名全是 `safeInteger`／`number`。

Orca 侧是**两个生产者**：

- `src/control/commands.ts` 的 `(old?.targetVersion ?? 0) + 1` —— **整数**
- `src/control/planImport.ts` 把 plan 文件的值原样传下去 —— **字符串**（`fixtures/web.ts` 里是 `"v1"`）

⇒ `panel/controlViews.ts` 的 `z.union([string, safeInteger])` ＋ `String()` 比较
*** **是这条已知裂缝上的胶布，不是无意识的 bug。** *** 上一版写成「一处在生效的缺陷」，
措辞会误导实施者**去撕胶布而不是补裂缝** —— 撕掉 union 之后，Web 导入的 work body 过不了
`workBodySchema`，`controlViews.ts` 直接 `blocked("work-item-invalid:…")`，**终点判据自己就挂了**。

**缝 B 与 `planFile.ts` 是同一件事，要么一起做、要么一起不做。**

## 10. 被推翻的论断（**逐字保留**）

### 10.1 第一版：`handoffExecution` 按名字推成 `model-assisted-v1`

理由曾是「Codex adapter 能跑模型，所以它的 handoff 是模型辅助的」。现测推翻：
`src/control/handoff.ts` 构造 `HandoffPacketV1` 的那一段里，`completed`／`unfinished`／`awaitingHuman`
**全部是从 `runState` 机械派生的三元表达式**，**全文件零模型调用**
（该文件含 `codex` 的共 **5 行**：`RAW_CODEX_FILES` 集合、`retainCodexLogs` 的定义与两处调用、
一处路径字面量 `join(runDir, "codex")` —— 全是**保留日志与文件名**，没有一处是模型调用。
⚠️ 上一版写「唯一出现」是假的；**而本轮用 `grep` 复核时只报出 1 行，是工具漏报**，
5 这个数是 python 逐行直读得到的）。
⇒ **从 adapter 的能力推 handoff 的实现，两件事无关。**

### 10.2 第二版：把 G1 当成一条链，并把两条门当成回绿判据

第二版 §8 沿用了 Orca handoff §三 的「432 通过」，并把两条 `targetVersion` 判据列为回绿目标。
独立评审席 ＋ 作者复核现测推翻：**那两条判据的红因在缝 B，而缝 B 被人裁排除在 G1 之外**
⇒ 第二版给 G1 设了一个**结构上达不成**的目标。同轮还查出：两道门**覆盖不到**要改的文件（§8.1）、
核的是**用不到的那个守卫**（§3.3）、把 T3 断言反了（§8.2）。

*** **两次推翻的形状是同一个：把一处的性质外推到别处，且没去量。** ***
本文 §1 那句「不许照名字猜」是作者自己写的，然后自己犯了两次。**这就是派独立评审席的理由。**
