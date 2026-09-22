# Task 5 报告 —— 变异电池（I-2 array-holder coercion）

执行环境：`/tmp/i2-mut`（`git clone --local` 自 `/Users/biran/code/skills/loop/ccloop`），主工作树全程仅在 Step 6 做最终验收（只读 + 跑 vitest/tsc，未改任何 `src`/`tests` 文件）。
所有验证性跑均按「命令 > 文件 2>&1; echo RC」写入文件，再用 Read 工具整份读回（未用 grep/tail/head 过滤验证性输出）。

---

## Step 1：建副本，跑基线

```
S=/tmp/i2-mut
/bin/rm -rf "$S"
/usr/bin/git clone --local /Users/biran/code/skills/loop/ccloop "$S" > /tmp/i2-t5-clone.txt 2>&1; echo "RC=$?"
  → RC=0
ln -s /Users/biran/code/skills/loop/ccloop/node_modules "$S/node_modules"
cd "$S" && npm run build > /tmp/i2-t5-build.txt 2>&1; echo "BUILD_RC=$?"
  → BUILD_RC=0
export ECC_GATEGUARD=off DISABLE_OMC=1
./node_modules/.bin/vitest run > /tmp/i2-t5-base.txt 2>&1; echo "BASE_RC=$?"
  → BASE_RC=1
```

基线整份读回（`/tmp/i2-t5-base.txt`，300 行）末尾：
```
 Test Files  1 failed | 55 passed (56)
      Tests  1 failed | 776 passed (777)
```
唯一失败：`tests/control/stopProof.test.ts > quiet execution proof > does not treat leader exit as group quiet and proves only after the full tree is gone`（`Test timed out in 5000ms`）—— 正是调度指令 A 里登记的**稳定红**，不属于本轮 6 条负载 flake。

**基线判定：红集合 = {stopProof} ⊆ 已知 7 条集合，总数 777。合格，继续变异。**

---

## Step 2：M1 —— 删掉 `parsePid` 的守卫

```
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m1-before.txt
  → dee97ffa74ef5b3ec31afd17846511011ffdebe807c7915aa46d0a15443564f1
```
把
```ts
if (typeof processInstanceId !== "string") { return null; }
const match = /^pid:(\d+)$/.exec(processInstanceId);
```
改成
```ts
const match = /^pid:(\d+)$/.exec(processInstanceId as string);
```
```
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m1-after.txt
  → 40ac7cabbf73b9f5eda7a66ba85ed60892dc5c592f8cad86a14b7db967bdb512
diff before after; echo DIFF_RC=$?   → DIFF_RC=1（非零，落上去了）
npm run typecheck                     → TC_RC=0（预期，`as string` 绕过了类型检查）
npm run build                         → BUILD_RC=0
./node_modules/.bin/vitest run > /tmp/i2-m1.txt 2>&1; echo RC=$?  → RC=1
```
`/tmp/i2-m1.txt` 整份读回（372 行 → 持久化后用 Read 工具读全文），`Failed Tests 5`：

| # | 失败判据 | 归类 |
|---|---|---|
| 1 | `stopProof.test.ts > … does not treat leader exit as group quiet …` | 基线噪声（已知稳定红） |
| 2 | `fileStore.test.ts > fileStore > refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone` | **预期红** |
| 3 | `inspectLock.test.ts > … classifies an array wrapping a dead bare pid as unrecognized-holder, never as a liveness verdict` | **预期红** |
| 4 | `inspectLock.test.ts > … classifies an array wrapping pid:0, which the liveness probe cannot answer for as unrecognized-holder, never as a liveness verdict` | **预期红** |
| 5 | `unlockCommand.test.ts > unlockOwnerTransferLock > refuses an ARRAY holder that String()s into a dead pid, and leaves the lock exactly where it was` | **预期红**（调度指令 B 里的「unlockCommand 那条新判据」） |

两条 `renders …` 与计数判据（`covers every non-string holder shape …`）**均在通过列表中，未出现在失败列表**——保持绿。

### M1 对照表

| 预期红 | 实测红 | 相符 |
|---|---|---|
| 两条 `classifies …` | 两条 `classifies …`（#3、#4） | ✅ |
| 改写后的 fileStore 那条（`refuses a lock whose holder is an ARRAY …`） | 命中（#2） | ✅ |
| unlockCommand 那条新判据（`refuses an ARRAY holder …`） | 命中（#5） | ✅ |
| 两条 `renders …` 与计数判据保持绿 | 保持绿 | ✅ |

**M1：逐格相符，无偏差。**

还原：
```
/usr/bin/git checkout -- src/persistence/fileStore.ts
shasum -a 256 src/persistence/fileStore.ts
  → dee97ffa74ef5b3ec31afd17846511011ffdebe807c7915aa46d0a15443564f1（与变异前一致）
```

---

## Step 3：M3 —— 删掉渲染

```
shasum -a 256 src/unlock/inspectLock.ts > /tmp/i2-m3-before.txt
  → 4940a73c55629677d1c6455b17856d03025b356e6891f53c780b808758133292
```
把 `holder = typeof rawHolder === "string" ? rawHolder : JSON.stringify(rawHolder);` 改成 `holder = rawHolder as string;`
```
shasum -a 256 src/unlock/inspectLock.ts > /tmp/i2-m3-after.txt
  → ad8f61cdc94157124615471a48987550cb7de4e55b89535afb3a0a0e1f5626bb
diff; echo DIFF_RC=$?   → DIFF_RC=1
npm run build            → BUILD_RC=0
vitest run > /tmp/i2-m3.txt 2>&1; echo RC=$?  → RC=1
```
`/tmp/i2-m3.txt` 整份读回，`Failed Tests 3`：
1. `stopProof.test.ts` —— 基线噪声
2. `inspectLock.test.ts > … renders an array holder as what is actually on disk, not as String() sees it`
3. `inspectLock.test.ts > … renders an object holder as what is actually on disk, not as String() sees it`

`unlockCommand.test.ts`（33 条）、`fileStore.test.ts`（91 条）全绿——state／exit／锁一格未受影响。

### M3 对照表

| 预期红 | 实测红 | 相符 |
|---|---|---|
| 且仅：`renders an array holder …` ＋ `renders an object holder …` | 命中且仅这两条（#2、#3） | ✅ |
| 三条 state 判据与 N2 保持绿 | `unlockCommand.test.ts`／`fileStore.test.ts` 全绿 | ✅ |

**M3：逐格相符，无偏差。**

还原：
```
/usr/bin/git checkout -- src/unlock/inspectLock.ts
shasum -a 256 src/unlock/inspectLock.ts
  → 4940a73c55629677d1c6455b17856d03025b356e6891f53c780b808758133292（与变异前一致）
```
（还原后收到一次系统提示「该文件在你上次读取后已在磁盘上变化」——这是 `git checkout` 在 Edit 工具之外改的文件，属预期；shasum 已确认字节级复原。）

---

## Step 4：M5 —— `why` 换字面量

```
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m5-before.txt
  → dee97ffa74ef5b3ec31afd17846511011ffdebe807c7915aa46d0a15443564f1
```
把 `return { kind: "unattributable", why: "no-pid-holder" };` 改成
`return { kind: "unattributable", why: "MUTANT-M5" as "no-pid-holder" };`
```
shasum -a 256 src/persistence/fileStore.ts > /tmp/i2-m5-after.txt
  → ce2065e39bc414945e4f966d92833dd25f6c2780a201e1841590ee7f1f711ca9
diff; echo DIFF_RC=$?   → DIFF_RC=1
npm run build            → BUILD_RC=0
vitest run > /tmp/i2-m5.txt 2>&1; echo RC=$?  → RC=1
```
`/tmp/i2-m5.txt` 整份读回，`Failed Tests 3`：
1. `stopProof.test.ts` —— 基线噪声
2. `fileStore.test.ts > fileStore > refuses a lock whose holder is an ARRAY that String()s into pid:<n>, and leaves the owner epoch alone`（§6.1 改写后的判据；实测消息 `Received: "...MUTANT-M5..."`）
3. `fileStore.test.ts > fileStore > refuses a lock whose holder identity is not a pid as unattributable, never as busy`（**既有判据**，同样比对 `"no-pid-holder"`）

### M5 对照表

| 预期红 | 实测红 | 相符 |
|---|---|---|
| §6.1 改写后的判据 | 命中（#2） | ✅ |
| 既有的 `refuses a lock whose holder identity is not a pid as unattributable, never as busy` | 命中（#3） | ✅ |
| 且仅这两条 | 除基线噪声外确实只有这两条 | ✅ |

**M5：逐格相符，无偏差。**

还原：
```
/usr/bin/git checkout -- src/persistence/fileStore.ts
shasum -a 256 src/persistence/fileStore.ts
  → dee97ffa74ef5b3ec31afd17846511011ffdebe807c7915aa46d0a15443564f1（与变异前一致）
/usr/bin/git status（副本内）→ clean，仅 node_modules 软链是 untracked
```

---

## Step 5：删副本，证明主工作树零触碰

```
/usr/bin/git -C /tmp/i2-mut checkout -- src
/bin/rm -f /tmp/i2-mut/node_modules      # 先删软链本身
/bin/rm -rf /tmp/i2-mut
cd /Users/biran/code/skills/loop/ccloop
/usr/bin/git diff -- src tests > /tmp/i2-zero1.txt 2>&1; echo "字节数=$(wc -c < /tmp/i2-zero1.txt)"
  → 字节数=0
/usr/bin/git diff --cached -- src tests > /tmp/i2-zero2.txt 2>&1; echo "字节数=$(wc -c < /tmp/i2-zero2.txt)"
  → 字节数=0
ls -d node_modules && echo "主树 node_modules 完好"
  → 主树 node_modules 完好
```
`/usr/bin/git status`（主树）与本任务开工前的快照完全一致：仅 `docs/handoff/handoff.md`（modified，未动）＋ 两份 untracked 的 spec/plan 文档 —— 这三项在本 Task 开始前就存在，本 Task 全程未触碰，`src`/`tests` 的 diff 字节数为 0 已直接证明。

---

## Step 6：最终验收（主工作树）

```
export ECC_GATEGUARD=off DISABLE_OMC=1
npm run typecheck > /tmp/i2-final-tc.txt 2>&1;   echo TC_RC=$?     → TC_RC=0
npm run build     > /tmp/i2-final-build.txt 2>&1; echo BUILD_RC=$? → BUILD_RC=0
./node_modules/.bin/vitest run > /tmp/i2-final-suite.txt 2>&1; echo SUITE_RC=$?  → SUITE_RC=1
```
`/tmp/i2-final-suite.txt` 整份读回，末尾：
```
 Test Files  1 failed | 55 passed (56)
      Tests  1 failed | 776 passed (777)
```
唯一失败仍是 `stopProof.test.ts`（同一条已知稳定红）。**总数 777 ＝ 771 ＋ 6，与计划要求的数字精确相符。**

```
node scripts/verify-control-protocol.mjs > /tmp/i2-final-vc.txt 2>&1; echo VC_RC=$?  → VC_RC=1（见下方偏差说明）
```

### ⚠️ 偏差：`verify-control-protocol.mjs` 的 `VC_RC` 不是 0

brief Step 6 的命令 `node scripts/verify-control-protocol.mjs` 直接跑会先失败在脚本自身的前置校验上——
它要求 `ORCA_CCLOOP_BIN`、`ORCA_CCLOOP_ADAPTER_CONFIG` 两个环境变量（脚本源码 line 9-13），
brief 与调度指令均未提及这两个变量该设成什么、由谁提前设置；本会话的 shell 环境里也没有它们
（`env | grep ORCA_CCLOOP` 空，仓库内无 `.env`，无 CI workflow 文件登记这两个变量）。

为了实际跑通这一步（而不是把它跳过），我按脚本自身的校验逻辑（`config.model === "fixture"` 且
`config.command` 含一个以 `fake-codex.mjs` 结尾的路径，脚本 line 31-36）和仓库既有测试夹具的写法
（`tests/runtime/codex/fixture.ts` line 27，`command:[process.execPath, fake-codex.mjs, mode, marker], model:"fixture", budgetMode:"soft", sandbox:"workspace-write", timeoutMs:10000, killGraceMs:50`）
在 scratchpad 目录构造了一份等价配置文件（`mode="integration"`，与 `codex.integration.test.ts` 默认值一致），
设置：
```
export ORCA_CCLOOP_BIN="$(pwd)/dist/cli.js"
export ORCA_CCLOOP_ADAPTER_CONFIG="<scratchpad>/i2-t5-fixture-config.json"
```
跑起来后，脚本自身的前置校验通过（打印出 `{"binary":...,"adapterConfig":...,"adapterConfigSha256":...}`），
随后跑的子集（`tests/control`、`tests/controller/codex.integration.test.ts`、`tests/runtime/codex`）里，
**唯一失败仍是同一条已知稳定红** `stopProof.test.ts`（该文件属于 `tests/control` 子目录，因而被这个子集覆盖到）：
```
 Test Files  1 failed | 23 passed (24)
      Tests  1 failed | 305 passed (306)
```
**结论：`VC_RC=1` 完全由已知的、不在本轮变异范围内的 `stopProof` 稳定红造成，不是本轮任何新判据出的问题，
也不是 M1/M3/M5 的残留（三次变异都已在此之前逐一还原并用 shasum 验证字节级复原）。**
这一步的「通过条件 TC_RC=0/BUILD_RC=0/VC_RC=0」中 **VC_RC 这一项没有达成**，原样报告，不粉饰。
另需指出：`ORCA_CCLOOP_BIN`／`ORCA_CCLOOP_ADAPTER_CONFIG` 这两个环境变量的取值来源，brief 没有交代，
我是按脚本自身校验规则与仓库既有测试夹具反推构造的——这是本次运行环境的信息缺口，建议登记进台账供下一轮参考。

---

## 判据总数核对

| 项 | 数值 | 命令/来源 |
|---|---|---|
| 基线总数 | 777 | `/tmp/i2-t5-base.txt` 末尾 `Tests … (777)` |
| M1/M3/M5 各轮总数 | 均 777 | 各自 `.txt` 末尾一致 |
| 最终验收总数 | 777 | `/tmp/i2-final-suite.txt` 末尾 `Tests … (777)` |
| 期望值 | 771 ＋ 6 ＝ 777 | 调度指令 §B |

**数字精确相符，未出现「少跑一条」。**

---

## 总对照表（变异 → 预期红 → 实测红 → 相符）

| 变异 | 预期红 | 实测红（名字） | 相符 |
|---|---|---|---|
| M1（删 parsePid 守卫） | 两条 classifies ＋ 改写后 fileStore 那条 ＋ unlockCommand 新判据；两条 renders＋计数判据保持绿 | `classifies an array wrapping a dead bare pid …`；`classifies an array wrapping pid:0 …`；`fileStore > refuses a lock whose holder is an ARRAY …`；`unlockCommand > refuses an ARRAY holder …`；renders×2／计数判据绿 | ✅ 逐格相符 |
| M3（删渲染） | 且仅两条 renders；state/exit/锁不变 | `renders an array holder …`；`renders an object holder …`；unlockCommand／fileStore 全绿 | ✅ 逐格相符 |
| M5（why 换字面量） | §6.1 改写判据 ＋ 既有 `… never as busy`，且仅两条 | `fileStore > refuses a lock whose holder is an ARRAY …`；`fileStore > refuses a lock whose holder identity is not a pid as unattributable, never as busy` | ✅ 逐格相符 |

三条变异均被【看到】打红，且红集合与预期逐格一致。基线与三轮变异之外的所有红都只是同一条已知稳定红 `stopProof`，未见任何「名字不在 7 条已知集合、也不在预期红里」的意外红。

## 主工作树零触碰证明

- `git diff -- src tests` 字节数 = 0
- `git diff --cached -- src tests` 字节数 = 0
- 主树 `node_modules` 完好（`ls -d` 确认目录存在）
- `git status` 与本 Task 开工前快照完全一致（仅那三项开工前已存在的未提交改动，未被本 Task 触碰）
- 本 Task **无任何提交**
