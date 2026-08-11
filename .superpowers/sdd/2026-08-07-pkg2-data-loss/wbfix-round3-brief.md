# 包 2 修复环 —— 第三轮 brief（人裁 56/57）

> scoped 再评审（第三个人）已交付：**六项全 ADDRESSED、无新破坏、无越界、Critical 0**，
> 分支尖端 31/531 全绿、逐文件计数无一下降。**它没接受你的举证，自己插桩重造了 18 格的 resume 后终态**
> —— 实质主张成立。**但它查出本轮我们自己引入了一条 Important。**

| 人裁 | 内容 |
|---|---|
| **56** | 夹具 hook 从 `open` 移到 `link` —— *** **追认为第七个具名例外** ***（沿用人裁 17「改夹具 ≠ 改判据」）。**已完成，本轮不必再动，只需在报告里记明它现在有授权。** |
| **57** | 本轮修 **Imp-1 ＋ Imp-2 ＋ Low-1~Low-4**。 |

---

## 任务 1（Imp-1）—— 修掉**本轮自己引入**的泄漏路径

**缺陷**：`acquireOwnerTransferLock` 里 `await link(stagingPath, lockPath)` **成功之后**那句
`await safeUnlink(stagingPath)` —— `safeUnlink` 只吞 ENOENT。**若它抛别的 errno**：
锁**已经发布**，但函数带着异常出去，**调用方永远拿不到 `release`**，`handle` 也永不 close。
且持有者 pid 仍活着 ⇒ `tryRecoverStaleOwnerTransferLock` **拒绝回收** ⇒
*** **该 runDir 的全部 owner-transfer 操作在进程退出前持续 `OwnerTransferLockBusyError`。** ***
泄漏的锁在生产侧是静默的（`ensureFreshRunDir` 的 `blockingPaths` 不含它）。

*** **⚠️ 这条与本文件里的具名先例相反**：`writeJsonFileAtomically` 对同类清理明写「**故意不用 `safeUnlink`**」。
先去把那段先例读懂，再决定修法 —— **Rule 11：与既有约定一致优先于你的口味。** ***

**硬条件（缺一不算做完）**：
1. **一条判据**：让 staging 的清理抛一个**非 ENOENT** 的 errno，断言**调用方仍拿到可用的 `release`**、
   且 `release()` 之后锁确实被释放。*** **在未修的代码上它必须变红，且红在断言上**（不是异常/超时）；修后必须绿。 ***
   两次输出都要进报告。**没有这条，就是又一个「没有执行机制的完整性断言」。**
2. ⛔ **仍然不许碰** `tryRecoverStaleOwnerTransferLock`（待裁点 B）与 `release()` 本身（人裁 53 已把它立成独立一格）。
3. 修法要**与 `writeJsonFileAtomically` 的既有约定同形**，或在报告里逐字说明为什么这里必须不同。

## 任务 2（Imp-2）—— 把人裁 51/54 的举证**落进套件**

**缺陷**：支撑「gaps 05–13 的 `accepted` 是正确行为」的证据**只存在于报告里**，
**套件并不 pin resume 之后的终态** ⇒ 举证没有执行机制。

**要做**：在那个 crash-gap 矩阵里**新增断言**，pin 住 resume 之后的终态
（第三个人已实测：18 格 resume 后与各自 gap 14 **三个文件全字段相同，唯一差异是墙钟 `lastAffirmedAt`**）。
⚠️ **墙钟字段要排除或按形状断言**，别写成恒假。
*** **硬条件**：把 `resumeLoop` 的读顺序退回 `Promise.all` 并列，**新断言必须变红**；还原必须绿。 ***
⚠️ 这会再动那个矩阵 —— **仍在人裁 51 的第六个具名例外之内**（它就是为这 18 行开的），**不得扩到别处**。

## 任务 3（Low-1~Low-4）—— 只改措辞，零行为风险

- **Low-1**：那句命名超时的**诊断词现在会误诊** —— 它现在覆盖两种回归却只点名一种。改准。
- **Low-2**：`busyLockRecord` 上方仍引用**已删除的 `openSpy`**（全仓库仅此一处）。改准。
- **Low-3**：「**BYTE-FOR-BYTE**」是 **overclaim**（`lastAffirmedAt` 必然不同），且与同段注释自陈矛盾。改准。
- **Low-4**：必命中对照的**灵敏度未记录** —— 第三个人实测其速率仅 ~0.3/s，**5s 下读到 0，10s×5 才稳定读到 1–4**，
  ⇒ **你自报的绝对值不可复现**。把灵敏度与观测窗口写进探针文档，并把自报数改成可复现的表述。

## 铁律（不软化）
**验证跑绝不过滤**（整份落盘整份读回）／**坏探针不能证明「不存在」**／***读代码的机械论证不等于实测***／
`rtk proxy` ＋ `ECC_GATEGUARD=off DISABLE_OMC=1`／⛔ 不 push / 不建删分支 / 不合并，commit message 英文／
⛔ **不碰待裁点 A/B/C、不碰包 1、不动本 brief 点名之外的任何既有判据**（要动就停下来问人）／
**Rule 12 fail loud**。⚠️ **建议学第三个人那一手**：变异在 `git archive` 出的副本里做，工作树全程不脏。

## 报告
追加「第三轮」大节到 `wbfix-impl-report.md`，**结论最先写**。必须含：三个任务的 DONE/BLOCKED ＋
任务 1、2 的**先红后绿**双向实测 ＋ 人裁 56 的记明 ＋ 最终全套件/typecheck/build（未过滤、`RUN` 路径已核）
＋ 逐文件计数比对 ＋ 没做的/被挡住的 ＋ 预算可数事实（**不要自报估计**）。
