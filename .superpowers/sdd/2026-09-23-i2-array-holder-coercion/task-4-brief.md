## Task 4: 追加具名 ERRATUM（**已发布注释逐字不动**）

**Files:**
- Modify: `src/persistence/fileStore.ts`（三处）、`src/unlock/inspectLock.ts`（一处）—— **只动注释**

**Interfaces:**
- Consumes: Task 1–3 的落地事实。
- Produces: 无。

⚠️ **铁律 5**：就地改**只**适用于本会话自己刚写、从未为真、且未发布的笔误。
这几处都是**已发布文本** ⇒ *** **原文逐字保留 ＋ 在注释块【末尾】追加 `*** ERRATUM (…, HUMAN RULING 127) … ***`。** ***
⚠️ **ERRATUM 里不许写会被后续裁决推翻的计数**，指向台账即可。
⚠️ **ERRATUM 不许引用会移动的 git 引用**（「HEAD」「remote tip」）。

- [ ] **Step 1: 先跑机械扫描，把清单从被更正的句子导出**

```bash
cd /Users/biran/code/skills/loop/ccloop
for w in "recorded, not fixed" "array holder" "array-holder" "no-pid-holder" "String()" "999999" "ruling 99" "ruling 94"; do
  echo "### $w"
  /usr/bin/grep -rin "$w" --include="*.ts" --include="*.md" src tests docs .superpowers
done > /tmp/i2-t4-scan.txt 2>&1; echo "RC=$?"
wc -l /tmp/i2-t4-scan.txt
```
**整份读回** `/tmp/i2-t4-scan.txt`。spec §4.1 列了**四处**必追 ＋ **两处**邻近过期文本。
⚠️ *** **如果扫描捞出第七处，把它报告出来，不要自行决定追不追。** ***

- [ ] **Step 2: `fileStore.ts` 人裁 94 那条 ERRATUM —— 追加**

在那个注释块的**末尾**（`The array case is pinned by a criterion under human ruling 99, so it cannot be "tidied" away silently. ***` 之后）追加：

```
  // *** ERRATUM (I-2, HUMAN RULING 127) -- THE THREE SENTENCES ABOVE ARE KEPT VERBATIM AND WERE
  // NEVER FALSE. Two of them are INDEXED to a round: "outside ruling 83's authorisation" and "E1
  // is outside this round's authorisation" both described the authorisation surface of ruling 94's
  // round, and both are still true of that round. What changed is that ruling 121 opened E1 and
  // ruling 127 authorised closing this cell on both sides -- so a reader must not take those two
  // sentences for the CURRENT disposition. The third, "pinned by a criterion under human ruling
  // 99, so it cannot be 'tidied' away silently", has inverted: that criterion was rewritten whole
  // under ruling 127 (named under ruling 88) and now pins the cell CLOSED. parsePid no longer
  // reads a pid out of a non-string, so the coercion this paragraph describes cannot happen here
  // at all. Which criterion pins which exit is recorded in the ledger, not here. ***
```

- [ ] **Step 3: `fileStore.ts` `parsePid` 上方那组注释 —— 追加**

在该注释块**末尾**（人裁 104 那条 ERRATUM 之后、`export function parsePid` 之前）追加：

```
// *** ERRATUM (I-2, HUMAN RULING 127) -- everything above is kept verbatim. It argues about what a
// second, "upgraded" IDENTITY NOTION would do, and that argument is untouched. What this function
// gained is different in kind: a type guard, because the parameter was annotated `string` while
// both callers hand it a value straight out of JSON.parse. exec() coerces through String(), so an
// array holder used to produce a pid. The signature now says `unknown`, which is what it always
// was. ⚠️ The signature is NOT the defence -- a tidy-up that casts the argument back to `string`
// typechecks clean and reopens the hole. The criteria are the defence; the ledger names them. ***
```

- [ ] **Step 4: `fileStore.ts` 人裁 108 那条 ERRATUM —— 追加**

在那个注释块的**末尾**（`... the same disposition the redline function's own ruling-94 erratum gives its array-holder cell. ***` 之后）追加：

```
      // *** ERRATUM (I-2, HUMAN RULING 127) -- the sentence above is kept verbatim. It cites
      // ruling 94's array-holder disposition as a live precedent for leaving a cell "recorded, not
      // fixed". That precedent no longer stands: ruling 127 closed the array-holder cell. The
      // cells THIS erratum is about -- pid:0, an out-of-range pid, an EPERM refusal -- are
      // untouched by that and are still recorded rather than fixed, so the disposition it
      // describes for ITSELF is unchanged; only the precedent it leans on is gone. ***
```

- [ ] **Step 5: `inspectLock.ts` 人裁 83 那条 ERRATUM —— 追加**

在该 ERRATUM 块的**末尾**（`... not one shared answer. ***` 之后）追加：

```
// *** ERRATUM (I-2, HUMAN RULING 127) -- kept verbatim, and one clause in it was TOO WIDE WHEN
// WRITTEN rather than overtaken later. "On BOTH cases it names -- an unrecognizable holder
// identity, ... -- the redline function no longer steals" was measured on holders that are
// STRINGS. A holder that is not a string at all -- `["pid:999999"]`, which String()s into
// `pid:999999` -- was unrecognizable in exactly the same sense, and on that sub-cell BOTH sides
// deleted: the redline function unlinked, and this command's `dead` branch removed the lock with
// no --force and no --expect. Ruling 127 made the sentence true for that sub-cell too, by giving
// parsePid a type guard and by classifying the value the record carries rather than a rendering
// of it. The sentence is now what it always claimed to be. ***
```

- [ ] **Step 6: 那两处邻近的过期文本 —— 各追一条**

spec §4.1 的第二张表：`fileStore.ts` 人裁 83 ERRATUM 里「Under ruling 83 an unparsed holder **returns false**」，
以及 `inspectLock.ts` 人裁 100 ERRATUM 里那个已不存在的 `pid === null || isProcessActive(pid)` 表达式。
**各追一条具名 ERRATUM 指出它指向的东西已经变了**，原文逐字不动。

- [ ] **Step 7: 字节扫描 ＋ 确认没动到代码**

```bash
cd /Users/biran/code/skills/loop/ccloop
LC_ALL=C /usr/bin/grep -c $'\x00\|\x01\|\x02\|\x1f' src/persistence/fileStore.ts src/unlock/inspectLock.ts > /tmp/i2-t4-bytes.txt 2>&1; echo "RC=$?"
cat /tmp/i2-t4-bytes.txt
/usr/bin/git diff --stat -- src > /tmp/i2-t4-diffstat.txt 2>&1; cat /tmp/i2-t4-diffstat.txt
/usr/bin/git diff -- src | python3 -c "
import sys
for line in sys.stdin:
    if line.startswith('-') and not line.startswith('---'):
        sys.stdout.write(line)
" > /tmp/i2-t4-deleted.txt 2>&1
echo '本 Task 删除的行数（应为 0）:'; wc -l < /tmp/i2-t4-deleted.txt
cat /tmp/i2-t4-deleted.txt
```
Expected: 字节扫描 0 命中；**删除行数为 0**（只追加，不删任何已发布文本）；
diffstat 只有 `+`。⚠️ **删除行数非 0 ⇒ 你动了已发布文本，退回重做。**

- [ ] **Step 8: 跑全套 ＋ 提交**

```bash
export ECC_GATEGUARD=off DISABLE_OMC=1
npm run typecheck > /tmp/i2-t4-tc.txt 2>&1; echo "TC_RC=$?"
./node_modules/.bin/vitest run > /tmp/i2-t4-full.txt 2>&1; echo "RC=$?"
/usr/bin/git add src/persistence/fileStore.ts src/unlock/inspectLock.ts
/usr/bin/git commit -m "docs(comments): record what ruling 127 changed about the array-holder cell, and what it did not

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LWmK9Dj3nxTfp514rtBZT8"
```

---

