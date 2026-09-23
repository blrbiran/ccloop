# G1 缝 A：capability 词汇表 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ccloop 的 `control capabilities` 答出 Orca `CapabilityViewV1` 的八字段形状，
使 Web 派活到真 ccloop 不再被 `probeBlocksDispatch` 拒绝。

**Architecture:** 线上应答升到 `protocol: 2`，删三个恒真布尔，补四个字段，
`requestBoundEvidence` 升级为 `requestBoundProof` descriptor。Orca 侧把两套 capability schema
合并成一套（`capabilitiesSchema` 由 `capabilityViewSchema` 派生），并把两处**借用 declared profile
来掩盖对端缺口**的判据改成直通——那两处才是本轮真正的验收点。

**Tech Stack:** TypeScript、zod、vitest（两仓皆是）。

**Spec:** `docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md`（本仓库）
—— **执行者必须先读 spec，尤其 §1（G1 是两条缝）与 §10（两次被推翻的论断）。**

## Global Constraints

- *** **本计划只做缝 A。`targetVersion`／`planFile.ts` 一个字节都不许动**（spec §2）。 ***
  ⚠️ `tests/control/webCcloopSmoke.test.ts` 那两条 `start-envelope-conflict:run:targetVersion`
  **本轮【不回绿】，它们红着是预期的**。把它们改绿就是越界。
- **ccloop 侧的改动落在 `main`**（现测：`codex/codex-adapter-0919` 比 main 少 10142 行，
  是落后分支；main 自带 `src/runtime/codex/`，其 build 答的 capabilities 与该分支逐字相同）。
- **Orca 的 `ORCA_CCLOOP_BIN` 改指 ccloop `main` 的 build。**
- **语言**：代码、注释、commit message 一律英文；spec／plan 中文。
- **ccloop 铁律**：不许实施者自改既有判据——**改既有判据必须由人指名到具体测试**（人裁 88）。
  ⚠️ 本计划 Task 5／Task 6 **必然要改既有判据**，那几处**逐一列了名**，执行前需人确认。
- **两仓都不许 push、不许合并进 main、不许删分支或 worktree**（Tier 0）。
- **验证性跑一律重定向到文件再整份读回**；RC 从文件取，**不许读后台通知的 exit code**。
- **清点消费者一律 python 逐行读，不许用 `grep`**（实测：同一文件 grep 报 1 行、python 报 5 行，
  无任何截断提示）。

---

## 文件结构

| 文件 | 责任 | 归属 |
|---|---|---|
| ccloop `src/control/command.ts` | 线上应答的**唯一**产地 | Task 1 |
| Orca `src/control/webProtocol.ts` | `capabilityViewSchema`（**本轮不改**，它是被派生的那一份） | — |
| Orca `src/control/schema.ts` | `capabilitiesSchema` → 由上者派生 | Task 2 |
| Orca `src/control/types.ts` | `Capabilities` → 由 `CapabilityViewV1` 派生 | Task 2 |
| Orca `src/control/budget.ts` | 守卫重写 | Task 3 |
| Orca `src/control/ccloopPort.ts` | `probeProfileCapabilities` 直通 ＋ ERRATUM | Task 4 |
| Orca `tests/control/fixtures/fake-ccloop-control.mjs` | 消费者门的协议替身 | Task 5 |
| Orca `tests/control/webCcloopSmoke.test.ts` | `codexProbe` → 直通；**终点判据在此** | Task 5 |
| Orca 其余 14 个测试/夹具 | 同步 | Task 6 |

---

### Task 1: ccloop 答出新形状

**Files:**
- Modify: ccloop `src/control/command.ts`（`capabilitiesSchema` 定义处与 `defaultHandler` 的
  `method === "capabilities"` 分支）
- Test: ccloop `tests/control/command.test.ts`

**Interfaces:**
- Produces: 线上 JSON 应答，八字段，`protocol: 2`。后续每个 Task 都以它为准。

- [ ] **Step 1: 写失败判据** —— 在 `tests/control/command.test.ts` 追加：

```ts
it("answers the v2 capability vocabulary and nothing else", async () => {
  const answer = await runControl(["capabilities", "--adapter", "codex", "--adapter-config", cfg], {});
  expect(answer).toEqual({
    protocol: 2,
    usageObservation: "phase-end",
    budgetEnforcement: "soft",
    contextObservation: "unavailable",
    handoffControl: "durable",
    handoffExecution: "mechanical-in-run-v1",
    contextWindowTokens: null,
    requestBoundProof: null,
  });
});
```

⚠️ `toEqual` 而非 `toMatchObject`：**多答一个字段必须红**，否则删不掉那三个布尔就没人发现。

- [ ] **Step 2: 跑它，确认红**

`ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run tests/control/command.test.ts > /tmp/…/t1.log 2>&1; echo "RC=$?" >> /tmp/…/t1.log`
整份读回。Expected: FAIL，实际值是旧的七字段。

- [ ] **Step 3: 改 schema 与应答**

`src/control/command.ts` 的 capabilities schema 改成：

```ts
capabilities: z.object({
  protocol: z.literal(2),
  usageObservation: z.enum(["realtime", "phase-end", "unavailable"]),
  budgetEnforcement: z.enum(["bounded", "soft", "unavailable"]),
  contextObservation: z.enum(["realtime", "phase-end", "unavailable"]),
  handoffControl: z.enum(["durable", "phase-end", "unavailable"]),
  handoffExecution: z.enum(["mechanical-in-run-v1", "model-assisted-v1"]).nullable(),
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  requestBoundProof: z.object({
    scheme: z.literal("adapter-request-bound-v1"),
    version: z.string().min(1),
    workDimensions: z.array(z.string()),
    handoffDimensions: z.array(z.string()),
    evidenceKind: z.string().min(1),
  }).strict().nullable(),
}).strict(),
```

`defaultHandler` 的分支改成：

```ts
if (request.method === "capabilities") {
  return {
    protocol: 2,
    usageObservation: "phase-end",
    budgetEnforcement: "soft",
    contextObservation: "unavailable",
    handoffControl: "durable",
    handoffExecution: "mechanical-in-run-v1",
    contextWindowTokens: null,
    requestBoundProof: null,
  };
}
```

⚠️ **`budgetEnforcement` 的第三值从 `unsupported` 改成 `unavailable`** —— 全仓扫 `unsupported`
并逐处处理，**不许留一处**。

- [ ] **Step 4: 跑判据，确认绿**，并跑 `npm run typecheck`、`npm run build`（都重定向读回）

- [ ] **Step 5: 变异 M1** —— 在 `git clone --local` 副本（建在**会话 scratchpad**，人裁 137）里
把 `protocol: 2` 改回 `1`，**确认 Step 1 那条判据打红**。记 sha256 前后比对证明变异落上去了。

- [ ] **Step 6: 变异 M2** —— 副本里给应答**多加一个字段** `durableAccept: true`，
**确认判据打红**（这条证明 `toEqual` 在承重；若不红，判据是空的）。

- [ ] **Step 7: 全量 ＋ 已知红判定**

```sh
# LOG 由执行者赋值为 scratchpad 下的绝对路径；护栏确保未赋值时立刻失败
ECC_GATEGUARD=off DISABLE_OMC=1 ./node_modules/.bin/vitest run \
  --reporter=json --outputFile="${LOG:?set LOG}"
node scripts/check-known-reds.mjs "${LOG:?set LOG}"   # RC 0 才算绿
```

- [ ] **Step 8: Commit**（英文 message，带归属行）

---

### Task 2: Orca 合并两套 schema

**Files:**
- Modify: Orca `src/control/schema.ts`、`src/control/types.ts`
- Test: Orca `tests/control/` 现有消费者（Task 6 统一收口）

**Interfaces:**
- Consumes: Task 1 的八字段应答。
- Produces: `capabilitiesSchema`（= `capabilityViewSchema` + `protocol`）、
  `Capabilities` 类型（= `CapabilityViewV1 & {protocol: 2}`）。Task 3/4/5/6 全部依赖它们。

- [ ] **Step 1: 写失败判据** —— 新增 `tests/control/capabilitySchema.test.ts`：

```ts
import { capabilitiesSchema } from "../../src/control/schema.js";
import { capabilityViewSchema } from "../../src/control/webProtocol.js";

it("is the view schema plus protocol, with no independent field list", () => {
  const view = { usageObservation: "phase-end", budgetEnforcement: "soft",
    contextObservation: "unavailable", handoffControl: "durable",
    handoffExecution: "mechanical-in-run-v1", contextWindowTokens: null, requestBoundProof: null };
  expect(capabilityViewSchema.safeParse(view).success).toBe(true);
  expect(capabilitiesSchema.safeParse({ protocol: 2, ...view }).success).toBe(true);
  // 旧词汇必须被拒，逐个点名
  expect(capabilitiesSchema.safeParse({ protocol: 2, ...view, durableAccept: true }).success).toBe(false);
  expect(capabilitiesSchema.safeParse({ protocol: 1, ...view }).success).toBe(false);
  expect(capabilitiesSchema.safeParse({ protocol: 2, ...view, budgetEnforcement: "unsupported" }).success).toBe(false);
});
```

- [ ] **Step 2: 跑它，确认红**（`npx vitest run tests/control/capabilitySchema.test.ts`，重定向读回）

- [ ] **Step 3: 实现** —— `schema.ts` 里删掉那份独立字段列表，改成：

```ts
export const capabilitiesSchema = capabilityViewSchema.extend({ protocol: z.literal(2) }).strict();
```

`types.ts` 里 `Capabilities` 改为 `CapabilityViewV1 & { protocol: 2 }`（或 `z.infer`）。

⚠️ **循环依赖检查**：`schema.ts` 现在要 import `webProtocol.ts`。**跑 `npm run typecheck` 确认无环**；
若有环，把 `capabilityViewSchema` 下沉到一个两者都能 import 的模块，**并在本 Task 内完成**。

- [ ] **Step 4: 跑判据，确认绿**

- [ ] **Step 5: 变异 M3** —— 副本里把 `.strict()` 去掉，**确认 `durableAccept: true` 那条断言打红**。

- [ ] **Step 6: Commit**

---

### Task 3: Orca 守卫重写（**本 Task 含两条相反的变异结论**）

**Files:**
- Modify: Orca `src/control/budget.ts`
- Test: Orca `tests/control/budget.test.ts`、`tests/control/schedulerBridge.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `capabilitiesSchema`。
- Produces: 无新接口；改的是 `claimWork` 的入口校验。

⚠️ *** **本 Task 要改两处既有判据，逐一点名，需人按人裁 88 指名后方可动**： *** ***
`tests/control/budget.test.ts` 里 `it.each([...])("refuses unproven strict capabilities before reserving")`
的第三格 `{...caps, durableAccept:false}`；以及 `tests/control/schedulerBridge.test.ts` 里
`it("gets capabilities from the peer before a service claim")`。**它们钉的字段本轮被删除。**

- [ ] **Step 1: 先量，别改** —— 在副本里删掉 `budget.ts` 的 `!c.durableAccept` 一格，跑
`tests/control/`，**确认上面两处确实打红**。
*** **这一步是为了证伪「三格恒假所以没人测它」这个已被推翻的说法**（spec §8.2 T3）。 ***

- [ ] **Step 2: 写新判据**（**只加不改**，避开人裁 88 —— 见 ccloop 人裁 119 的先例）
`tests/control/budget.test.ts` 追加：

```ts
it("refuses a peer answering the retired v1 vocabulary", async () => {
  const h = await openTestStore();
  try {
    const s = seedBudgetCase(h.store);
    const legacy = { protocol: 1, durableAccept: true, ownershipIsolation: true,
      evidenceRetention: true, usageObservation: "phase-end",
      budgetEnforcement: "soft", requestBoundEvidence: null } as unknown as Capabilities;
    expect(() => claimWork(h.store, { ...s.t1Claim, capabilities: legacy }))
      .toThrow("control-capability-unsupported");
    expect(getGroup(h.store, "g1").reserved.tokens).toBe(10);
  } finally { await h.dispose(); }
});
```

⚠️ 第二条断言（`reserved.tokens` 未变）是**正向观测**，钉住「拒绝发生在预留之前」——
只断言抛错的判据看不见「先扣了再拒」。

- [ ] **Step 3: 跑它，确认红**

- [ ] **Step 4: 实现** —— `budget.ts` 的两行改成：

```ts
if(!capabilitiesSchema.safeParse(c).success) throw new ControlError("control-capability-unsupported");
if(c.usageObservation==="unavailable" || c.budgetEnforcement==="unavailable" ||
   c.handoffControl!=="durable" || c.handoffExecution===null) throw new ControlError("control-capability-unsupported");
if(mode==="strict" && (c.budgetEnforcement!=="bounded" || c.requestBoundProof===null)) throw new ControlError("control-capability-unsupported");
```

⚠️ *** **`c.protocol!==N` 那个子句【删掉，不要保留】** *** —— `capabilitiesSchema` 是
`z.literal(2)`，第一行已经拦下一切；留着它就是一个**永远打不到**的假守卫（spec §8.2 T4）。

- [ ] **Step 5: 跑判据确认绿**

- [ ] **Step 6: 变异 M4（**必须是 schema 那一处**）** —— 副本里把 `z.literal(2)` 改成
`z.literal(1)`，确认判据红。
⚠️ *** **不要把变异打在 `budget.ts` 上** *** —— 那里已经没有 protocol 子句了，
承重点在 schema 的 literal。

- [ ] **Step 7: 变异 M5** —— 副本里删掉 `c.handoffControl!=="durable"` 一格，确认打红。
若不红 ⇒ **说明本 Task 缺一条判据，补上再走**。

- [ ] **Step 8: Commit**

---

### Task 4: Orca 的端口直通 ＋ 已发布注释的 ERRATUM

**Files:**
- Modify: Orca `src/control/ccloopPort.ts`
- Test: Orca `tests/control/profiles.test.ts`（新增判据，只加不改）

**Interfaces:**
- Consumes: Task 2 的 `capabilitiesSchema`。
- Produces: `probeProfileCapabilities()` 返回对端应答本身（去掉 `protocol`），不再硬编码。

- [ ] **Step 1: 写失败判据** —— 新增：

```ts
it("passes the peer's own answer through without substituting any field", async () => {
  const peer = { protocol: 2, usageObservation: "phase-end", budgetEnforcement: "soft",
    contextObservation: "unavailable", handoffControl: "durable",
    handoffExecution: "mechanical-in-run-v1", contextWindowTokens: null, requestBoundProof: null };
  const port = createCcloopPort({ /* stub raw() 返回 peer */ });
  expect(await port.probeProfileCapabilities()).toEqual({
    usageObservation: "phase-end", budgetEnforcement: "soft",
    contextObservation: "unavailable", handoffControl: "durable",
    handoffExecution: "mechanical-in-run-v1", contextWindowTokens: null, requestBoundProof: null });
});
```

⚠️ 再加一条**钉住「不许自造」**的：让 stub 答 `handoffControl: "phase-end"`，
断言返回的也是 `"phase-end"` —— **不是 `"durable"`**。没有这一条，直通和硬编码分不出来。

- [ ] **Step 2: 跑它确认红**

- [ ] **Step 3: 实现** —— `probeProfileCapabilities()` 改为解析后剥掉 `protocol` 原样返回。

- [ ] **Step 4: 追加 ERRATUM**（**不许就地改原注释**）

在 `ccloopPort.ts` 那段长注释块的**末尾**追加：

```
   * *** ERRATUM (2026-09-24, G1 seam A) *** The paragraph above describes the state before the
   * capability vocabulary was settled: ccloop's `capabilities` now answers the eight-field v2
   * shape, so this method passes the peer's answer through and substitutes nothing. The rule it
   * cites -- that Orca may not invent a substitute source for a peer's observation -- is
   * unchanged and is now enforced by a criterion in `tests/control/profiles.test.ts` rather than
   * by hardcoded `unavailable`s. See docs/superpowers/specs/2026-09-24-g1-control-wire-contract-design.md
   * in the ccloop repository.
```

⚠️ **原文逐字保留**；ERRATUM 放在整个注释块末尾（ccloop 铁律 5 的形状，Orca 侧同样照办）。

- [ ] **Step 5: 跑判据确认绿；跑 `npm run typecheck`**

- [ ] **Step 6: 变异 M6** —— 副本里把直通改回硬编码 `handoffControl:"unavailable"`，
确认 Step 1 的**第二条**判据打红。

- [ ] **Step 7: Commit**

---

### Task 5: 两处「借用 declared 掩盖缺口」的判据改成直通（**本轮的真正验收点**）

**Files:**
- Modify: Orca `tests/control/fixtures/fake-ccloop-control.mjs`
- Modify: Orca `tests/control/webCcloopSmoke.test.ts`（`codexProbe()` 与其调用点）

⚠️ *** **本 Task 整体是「改既有判据」，需人按人裁 88 指名。** *** 逐一点名：
`fake-ccloop-control.mjs` 里写死 `protocol:1` 七字段的那个应答；
`webCcloopSmoke.test.ts` 的 `function codexProbe(...)` 及其全部调用点。

- [ ] **Step 1: 改替身** —— `fake-ccloop-control.mjs` 的 capabilities 应答改成 Task 1 的八字段。
⚠️ 它是 `verify:web-control:consumer` 的协议替身，**不改它那道门 G1 后量的还是旧协议**。

- [ ] **Step 2: 改 `codexProbe` 成直通**

```ts
/** The adapter's own capability answer, used as-is. Nothing is borrowed from the declared profile. */
function codexProbe(answer: Omit<CapabilityViewV1, never>): CapabilityViewV1 {
  return { ...answer };
}
```

调用点改为传入对端应答本身（去掉 `protocol`）。
⚠️ *** **删掉那段「Only the three fields the adapter answers come from the subprocess」的注释**
—— 它描述的行为不存在了。 ***

- [ ] **Step 3: 跑消费者门与控制门，整份读回**

```sh
# CCLOOP_MAIN=ccloop main 的 clone 副本根目录；LOG=scratchpad 下的日志绝对路径
ORCA_CCLOOP_BIN="${CCLOOP_MAIN:?set CCLOOP_MAIN}/dist/cli.js" \
  npm run verify:web-control:consumer > "${LOG:?set LOG}" 2>&1
echo "RC=$?" >> "${LOG}"
```

⚠️ *** **期望：那两条 `targetVersion` 判据【仍然红】**（Global Constraints）。 ***
判别式 ＝ **除它们之外没有新的红**。

- [ ] **Step 4: 终点判据** —— 确认 `webCcloopSmoke.test.ts` 里
`expect((await deliverScheduledStart(soft.deps, "g")).kind).toBe("claimed")` 那条**绿**。
*** **这是本计划的终点：真 ccloop 的应答直通过守卫，开出一个 run。** ***

- [ ] **Step 5: 变异 M7（终点判据的承重证明）** —— 副本里把 ccloop 应答的
`handoffControl` 改成 `"phase-end"`，**确认 Step 4 那条判据打红**。
⚠️ *** **spec §8.2 记着：这条变异在本 Task 落地【之前】没有任何判据能接住它。
所以 M7 是本轮唯一能证明终点判据承重的东西——不跑它，终点判据可能是空的。** ***

- [ ] **Step 6: 变异 M8** —— 副本里把 ccloop 应答的 `handoffExecution` 改成 `null`，确认打红。

- [ ] **Step 7: Commit**

---

### Task 6: 其余消费者同步 ＋ 全门验收

**Files:**
- Modify: Orca `tests/control/{budget,endToEnd,planImport,profiles,schedulerBridge,webFaults}.test.ts`、
  `tests/control/fixtures/{store,web}.ts`、`tests/control/fixtures/fake-control-peer.mjs`、
  `tests/panel/{controlConfig,controlConfigPort,controlReadApi}.test.ts`、
  `tests/panel/fixtures/controlPanel.ts`

- [ ] **Step 1: 用 python 重新清点消费者**（**不许用 grep**，见 Global Constraints）

```python
import os, re
pat = re.compile(r'durableAccept|ownershipIsolation|evidenceRetention|requestBoundEvidence')
for root, _, files in os.walk("."):
    if "node_modules" in root or "/.git" in root: continue
    for f in files:
        if not f.endswith((".ts", ".tsx", ".mjs")): continue
        p = os.path.join(root, f)
        hits = [i for i, l in enumerate(open(p, encoding="utf-8"), 1) if pat.search(l)]
        if hits: print(p, hits)
```

⚠️ **以这次输出为准**，不要沿用计划里的任何计数——**它写下的那一刻就开始过期**。

- [ ] **Step 2: 逐文件同步到 v2 词汇**，每改一个文件跑一次它自己的测试文件。

- [ ] **Step 3: 四道门全跑，逐一重定向读回，RC 从文件取**

```sh
npm run verify:control            # 覆盖 tests/control
npm run verify:web-control        # ⚠️ 只有它覆盖 tests/panel/control*
npm run build --workspace web && npm run verify:panel   # ⚠️ 只有它覆盖 web/tests/*.tsx
npm run verify                    # 收尾整条
```

⚠️ *** **少跑任何一道，都可能出现「改动做完、两道门全绿、而 `npm run verify` 是坏的」。** ***

- [ ] **Step 4: 期望值** —— 除那两条 `targetVersion` 判据外**零红**；
`npm run verify` 的其余各档**全绿**。**把每道门的实际计数抄进台账，不许照抄本计划的数。**

- [ ] **Step 5: ccloop 侧复跑** `check-known-reds.mjs`，RC 0。

- [ ] **Step 6: Commit ＋ 写台账** `.superpowers/sdd/2026-09-24-g1-capability-vocabulary/progress.md`
（带 who／when／在哪一笔上；`git add -f`，该目录被 gitignore）。

---

## 执行者须知（**每条都真栽过**）

1. **变异只在 `git clone --local` 副本里做**，副本建在**会话 scratchpad**（人裁 137），
   主工作树全程零触碰；还原证明看 `git diff` 与 `git diff --cached` 的**字节数**。
   ⚠️ 副本只克隆**已提交**状态；要测未提交改动，先 `cat` 进副本再 `diff` 证明逐字节相同。
   ⚠️ 副本没有 `node_modules` ⇒ 软链主树的；**ccloop 副本必须先 `npm run build`**，
   否则 `endToEnd.test.ts` 会以 `ENOENT … dist/cli.js` 假红。
2. **每组变异先跑出一次绿基线** —— 不报绿基线的电池不算证据。
3. **本机 `rm`/`cp` 都有 `-i` alias** ⇒ 一律 `/bin/rm -rf`、`cat pristine > target`。
   **macOS 没有 `timeout(1)`。**
4. **zsh 吃掉无引号的 `--include=*.ts`**；**zsh 对无引号变量不做词分割**。
5. **`ORCA_CCLOOP_ADAPTER_CONFIG` 的路径必须 `realpath` 等于自身** ⇒ macOS 上写 `/private/tmp/…`。
6. **验证性 git 一律裸 `/usr/bin/git`**；目录列表用 `rtk proxy` ＋ 重定向 ＋ 整份读回。
