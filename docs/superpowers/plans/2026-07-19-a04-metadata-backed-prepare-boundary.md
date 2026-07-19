# A-04 Metadata-Backed Prepare Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deleted-worktree hard gate in the non-paid A-04 prepare / approval-package flow with a metadata-backed read-only inspection that still enforces explicit hard blockers, soft signals, contradiction checks, and non-substitution of fresh dry-run artifacts for historical preserved evidence.

**Architecture:** Keep `prepareA04(...)` and the approval-package flow intact, but replace the current `ReadOnlyInspection` dependency on the deleted `evidence-first-v1` worktree with a structured `MetadataInspectionSummary` built from current-repo metadata and branch history anchors. The implementation is test-first: first reshape the inspection contract, then implement the new metadata-backed inspection and contradiction logic, then align the older docs that still describe the deleted worktree as a hard prerequisite.

**Tech Stack:** TypeScript 5.5, Node.js ESM, Vitest 2, Git, current `validation/v1` scripts, Markdown docs.

## Global Constraints

- redesign the non-paid A-04 prepare / approval-package boundary so it no longer hard-depends on the deleted `evidence-first-v1` linked worktree or its preserved `.validation-runs/` tree, while preserving the evidence-first intent through mechanically checked metadata.
- recover or recreate deleted preserved evidence trees must not happen.
- treat newly created local `.validation-runs/**` artifacts as historical preserved evidence must not happen.
- change the A-04 envelope (`550000 / 600000 / 1200000 / 5000`) must not happen.
- change Scenario A success criteria, stop rules, or paid-call approval semantics must not happen.
- allow destructive cleanup or silent evidence substitution must not happen.
- The required metadata set is exactly:
  - `docs/handover/ccloop-handover.md`
  - `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`
  - `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
  - `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`
  - local branch `backup/evidence-first-v1-before-memory-history-cleanup`
- Retained stashes, the legacy `evidence-first-v1` linked worktree, and the legacy preserved `.validation-runs/` tree are soft signals only; they must not block non-paid prepare by themselves.
- Hard blockers must map one-to-one to the required metadata set plus contradiction checks.
- The metadata-backed inspection must produce a machine-checkable summary contract rather than ad hoc strings.
- If the current checkout is `main`, implementation must happen in a fresh feature branch/worktree before Task 1 code changes.
- Update `.wolf/anatomy.md` and append to `.wolf/memory.md` after creating this new plan and after any later file creation/rename during implementation.

---

## File Map

- Modify: `validation/v1/lib/a04.ts` — replace the legacy worktree-based `ReadOnlyInspection` shape and `defaultInspectReadOnlyInspection(...)` implementation with metadata-backed sources, contradiction checks, and soft-signal reporting.
- Modify: `tests/validation/prepareA04.test.ts` — replace current worktree-oriented inspection fixtures with metadata-backed summary fixtures and add regression coverage for hard-blocker vs soft-signal behavior.
- Modify: `validation/v1/README.md` — document that A-04 prepare now checks current-repo metadata rather than requiring the deleted linked worktree, while preserving the non-substitution rule.
- Modify: `docs/handover/ccloop-handover.md` — record that the old linked worktree / preserved evidence tree are gone and that A-04 historical context now reconstructs from metadata and branch history anchors.
- Modify: `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md` — supersede the legacy §6.1 hard gate on the deleted worktree/evidence tree.
- Modify: `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md` — align older implementation guidance with the new metadata-backed boundary.
- Modify: `.wolf/anatomy.md` — add or update entries for the new plan and any changed file descriptions.
- Modify: `.wolf/memory.md` — append implementation checkpoints.

### Task 1: Redefine the inspection contract and approval-package surface

**Files:**
- Modify: `validation/v1/lib/a04.ts`
- Modify: `tests/validation/prepareA04.test.ts`
- Test: `tests/validation/prepareA04.test.ts`

**Interfaces:**
- Produces:
  - `export type RequiredSourceStatus = "PRESENT" | "MISSING" | "UNREADABLE";`
  - `export type SoftSignalStatus = "PRESENT" | "MISSING" | "UNREADABLE";`
  - `export type ContradictionStatus = "CONFIRMED" | "CONTRADICTORY" | "INSUFFICIENT";`
  - `export type MetadataInspectionSummary = { mainCheckout: { status: "PRESENT"; path: string; head: string; branch: "main" }; requiredSources: { handoverDoc: { status: RequiredSourceStatus; path: string }; a04BoundarySpec: { status: RequiredSourceStatus; path: string }; a04BoundaryPlan: { status: RequiredSourceStatus; path: string }; usageEvidenceSpec: { status: RequiredSourceStatus; path: string }; backupBranch: { status: RequiredSourceStatus; name: string; head?: string; mergeBaseWithMain?: string; distinctFromMain?: boolean; }; }; softSignals: { retainedStashes: { status: SoftSignalStatus; matches: string[] }; legacyEvidenceWorktree: { status: SoftSignalStatus; path: string }; legacyPreservedEvidenceTree: { status: SoftSignalStatus; path: string }; }; contradictionChecks: { firstRealPaidScenarioA: { status: ContradictionStatus; sources: string[] }; historicalA01ToA03Diagnoses: { status: ContradictionStatus; sources: string[] }; localDryRunArtifactsNotHistoricalEvidence: { status: ContradictionStatus; sources: string[] }; paidCallStillRequiresExplicitApproval: { status: ContradictionStatus; sources: string[] }; }; }`
  - `export type ReadOnlyInspection = MetadataInspectionSummary`
- Consumes:
  - existing `ApprovalPackage.readOnlyInspection`
  - existing `buildApprovalPackage(...)`
  - existing `prepareA04(...)`

- [ ] **Step 1: Write the failing test for the new inspection summary shape**

Add this new helper and test near the top of `tests/validation/prepareA04.test.ts`:

```ts
function buildReadOnlyInspection(): ReadOnlyInspection {
  return {
    mainCheckout: {
      status: "PRESENT",
      path: "/repo",
      head: "main-head",
      branch: "main",
    },
    requiredSources: {
      handoverDoc: {
        status: "PRESENT",
        path: "/repo/docs/handover/ccloop-handover.md",
      },
      a04BoundarySpec: {
        status: "PRESENT",
        path: "/repo/docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md",
      },
      a04BoundaryPlan: {
        status: "PRESENT",
        path: "/repo/docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md",
      },
      usageEvidenceSpec: {
        status: "PRESENT",
        path: "/repo/docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md",
      },
      backupBranch: {
        status: "PRESENT",
        name: "backup/evidence-first-v1-before-memory-history-cleanup",
        head: "backup-head",
        mergeBaseWithMain: "merge-base",
        distinctFromMain: true,
      },
    },
    softSignals: {
      retainedStashes: {
        status: "MISSING",
        matches: [],
      },
      legacyEvidenceWorktree: {
        status: "MISSING",
        path: "/repo/.worktrees/evidence-first-v1",
      },
      legacyPreservedEvidenceTree: {
        status: "MISSING",
        path: "/repo/.worktrees/evidence-first-v1/.validation-runs",
      },
    },
    contradictionChecks: {
      firstRealPaidScenarioA: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "a04BoundarySpec"],
      },
      historicalA01ToA03Diagnoses: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "usageEvidenceSpec"],
      },
      localDryRunArtifactsNotHistoricalEvidence: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "a04BoundaryPlan"],
      },
      paidCallStillRequiresExplicitApproval: {
        status: "CONFIRMED",
        sources: ["handoverDoc", "a04BoundarySpec", "usageEvidenceSpec"],
      },
    },
  };
}

it("builds an approval package with the metadata-backed inspection summary", () => {
  const pkg = buildApprovalPackage({
    verifiedCheckoutPath: "/tmp/a04-main-checkout",
    verifiedCheckoutHead: "verified-main-head",
    readOnlyInspection: buildReadOnlyInspection(),
    contract: buildContract(),
    contractPath: "/tmp/a04-main-checkout/.validation-runs/contracts/A-04.json",
    contractSha256: "abc123",
    fixturePath: "/repo/.validation-runs/fixture-01",
    runDir: "/repo/.validation-runs/runs/A-04",
    evidenceDir: "/repo/.validation-runs/evidence/A-04",
    adapterConfigPath: "/tmp/a04-main-checkout/examples/v1/claude-adapter-config.json",
  });

  expect(pkg.readOnlyInspection.softSignals.legacyEvidenceWorktree.status).toBe("MISSING");
  expect(pkg.readOnlyInspection.requiredSources.usageEvidenceSpec.status).toBe("PRESENT");
  expect(pkg.readOnlyInspection.contradictionChecks.paidCallStillRequiresExplicitApproval.status).toBe("CONFIRMED");
});
```

- [ ] **Step 2: Run the focused test to verify the contract mismatch fails first**

Run:

```bash
npm test -- --run tests/validation/prepareA04.test.ts
```

Expected: FAIL with type or property-shape errors because `ReadOnlyInspection` still uses `evidenceFirstValidationWorktree`, `retainedStashes`, and `preservedEvidenceTree` directly.

- [ ] **Step 3: Replace the exported inspection types in `validation/v1/lib/a04.ts`**

Replace the current `ReadOnlyInspection` type block with:

```ts
export type RequiredSourceStatus = "PRESENT" | "MISSING" | "UNREADABLE";
export type SoftSignalStatus = "PRESENT" | "MISSING" | "UNREADABLE";
export type ContradictionStatus = "CONFIRMED" | "CONTRADICTORY" | "INSUFFICIENT";

export type MetadataInspectionSummary = {
  mainCheckout: {
    status: "PRESENT";
    path: string;
    head: string;
    branch: "main";
  };
  requiredSources: {
    handoverDoc: { status: RequiredSourceStatus; path: string };
    a04BoundarySpec: { status: RequiredSourceStatus; path: string };
    a04BoundaryPlan: { status: RequiredSourceStatus; path: string };
    usageEvidenceSpec: { status: RequiredSourceStatus; path: string };
    backupBranch: {
      status: RequiredSourceStatus;
      name: typeof A04_RETAINED_BACKUP_BRANCH;
      head?: string;
      mergeBaseWithMain?: string;
      distinctFromMain?: boolean;
    };
  };
  softSignals: {
    retainedStashes: { status: SoftSignalStatus; matches: string[] };
    legacyEvidenceWorktree: { status: SoftSignalStatus; path: string };
    legacyPreservedEvidenceTree: { status: SoftSignalStatus; path: string };
  };
  contradictionChecks: {
    firstRealPaidScenarioA: { status: ContradictionStatus; sources: string[] };
    historicalA01ToA03Diagnoses: { status: ContradictionStatus; sources: string[] };
    localDryRunArtifactsNotHistoricalEvidence: { status: ContradictionStatus; sources: string[] };
    paidCallStillRequiresExplicitApproval: { status: ContradictionStatus; sources: string[] };
  };
};

export type ReadOnlyInspection = MetadataInspectionSummary;
```

Do not change `ApprovalPackage.readOnlyInspection` or `buildApprovalPackage(...)` signatures beyond consuming the new type.

- [ ] **Step 4: Update the test helper to use the new type and rerun the focused suite**

Run:

```bash
npm test -- --run tests/validation/prepareA04.test.ts
```

Expected: PASS for the new approval-package summary-shape test; other tests may still fail because the runtime inspection implementation is still legacy.

- [ ] **Step 5: Commit Task 1**

```bash
git status --short
git add validation/v1/lib/a04.ts tests/validation/prepareA04.test.ts
git commit -m "refactor: define metadata-backed A-04 inspection summary"
```

Expected: commit contains only the type-contract reshaping and matching tests.

### Task 2: Implement metadata-backed inspection and contradiction logic

**Files:**
- Modify: `validation/v1/lib/a04.ts`
- Modify: `tests/validation/prepareA04.test.ts`
- Test: `tests/validation/prepareA04.test.ts`

**Interfaces:**
- Consumes:
  - `MetadataInspectionSummary`
  - `A04_RETAINED_BACKUP_BRANCH`
  - existing `prepareA04(...)`
- Produces:
  - `export async function inspectMetadataBackedA04History(repoRoot: string): Promise<MetadataInspectionSummary>`
  - `defaultInspectReadOnlyInspection(...)` delegated to `inspectMetadataBackedA04History(...)`

- [ ] **Step 1: Write failing tests for hard blockers, soft signals, and contradiction checks**

Append these tests to `tests/validation/prepareA04.test.ts`:

```ts
it("does not fail when the legacy evidence worktree is missing but required metadata is present", async () => {
  const result = await prepareA04(
    buildOptions(),
    buildDeps({
      inspectReadOnlyInspection: async () => ({
        ...buildReadOnlyInspection(),
        softSignals: {
          ...buildReadOnlyInspection().softSignals,
          legacyEvidenceWorktree: {
            status: "MISSING",
            path: "/repo/.worktrees/evidence-first-v1",
          },
          legacyPreservedEvidenceTree: {
            status: "MISSING",
            path: "/repo/.worktrees/evidence-first-v1/.validation-runs",
          },
        },
      }),
    }),
  );

  expect(result.approvalPackage.readOnlyInspection.softSignals.legacyEvidenceWorktree.status).toBe("MISSING");
});

it("fails when the usage-evidence spec is missing", async () => {
  await expect(
    prepareA04(
      buildOptions(),
      buildDeps({
        inspectReadOnlyInspection: async () => ({
          ...buildReadOnlyInspection(),
          requiredSources: {
            ...buildReadOnlyInspection().requiredSources,
            usageEvidenceSpec: {
              status: "MISSING",
              path: "/repo/docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md",
            },
          },
        }),
      }),
    ),
  ).rejects.toThrow(/usage-evidence spec/i);
});

it("fails when contradiction checks are insufficient", async () => {
  await expect(
    prepareA04(
      buildOptions(),
      buildDeps({
        inspectReadOnlyInspection: async () => ({
          ...buildReadOnlyInspection(),
          contradictionChecks: {
            ...buildReadOnlyInspection().contradictionChecks,
            firstRealPaidScenarioA: {
              status: "INSUFFICIENT",
              sources: ["handoverDoc"],
            },
          },
        }),
      }),
    ),
  ).rejects.toThrow(/first real paid scenario a/i);
});

it("fails when the backup branch is not a distinct history anchor", async () => {
  await expect(
    prepareA04(
      buildOptions(),
      buildDeps({
        inspectReadOnlyInspection: async () => ({
          ...buildReadOnlyInspection(),
          requiredSources: {
            ...buildReadOnlyInspection().requiredSources,
            backupBranch: {
              status: "PRESENT",
              name: "backup/evidence-first-v1-before-memory-history-cleanup",
              head: "main-head",
              mergeBaseWithMain: "main-head",
              distinctFromMain: false,
            },
          },
        }),
      }),
    ),
  ).rejects.toThrow(/backup branch/i);
});
```

- [ ] **Step 2: Run the focused test to verify the new cases fail**

Run:

```bash
npm test -- --run tests/validation/prepareA04.test.ts
```

Expected: FAIL because `prepareA04(...)` still trusts any `inspectReadOnlyInspection(...)` result and the default inspection logic still points at the deleted legacy worktree.

- [ ] **Step 3: Add metadata source constants and contradiction helpers in `validation/v1/lib/a04.ts`**

Insert these constants above `defaultInspectReadOnlyInspection(...)`:

```ts
const A04_REQUIRED_METADATA_PATHS = {
  handoverDoc: "docs/handover/ccloop-handover.md",
  a04BoundarySpec: "docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md",
  a04BoundaryPlan: "docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md",
  usageEvidenceSpec: "docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md",
} as const;

function contradictionResult(
  status: ContradictionStatus,
  sources: string[],
): { status: ContradictionStatus; sources: string[] } {
  return { status, sources };
}

function classifyRequiredSource(path: string, body: string | null): RequiredSourceStatus {
  if (body === null) {
    return "MISSING";
  }
  return body.length > 0 ? "PRESENT" : "UNREADABLE";
}
```

Then add a helper for the four minimum contradiction checks:

```ts
function evaluateContradictions(input: {
  handoverDoc: string;
  a04BoundarySpec: string;
  a04BoundaryPlan: string;
  usageEvidenceSpec: string;
}): MetadataInspectionSummary["contradictionChecks"] {
  const firstRealPaidScenarioA =
    input.handoverDoc.includes("No successful real-Claude Scenario A exists yet.") &&
    input.a04BoundarySpec.includes("Prepare one fresh A-04 Scenario A invocation")
      ? contradictionResult("CONFIRMED", ["handoverDoc", "a04BoundarySpec"])
      : contradictionResult("INSUFFICIENT", ["handoverDoc", "a04BoundarySpec"]);

  const historicalA01ToA03Diagnoses =
    input.handoverDoc.includes("Historical verdict: `INCONCLUSIVE / RUNTIME_VARIANCE`") &&
    input.usageEvidenceSpec.includes("Historical A-01 through A-03 artifacts remain immutable")
      ? contradictionResult("CONFIRMED", ["handoverDoc", "usageEvidenceSpec"])
      : contradictionResult("INSUFFICIENT", ["handoverDoc", "usageEvidenceSpec"]);

  const localDryRunArtifactsNotHistoricalEvidence =
    input.handoverDoc.includes("These are **not** preserved real-run evidence.") &&
    input.a04BoundaryPlan.includes("This branch assessment remains non-paid and non-destructive.")
      ? contradictionResult("CONFIRMED", ["handoverDoc", "a04BoundaryPlan"])
      : contradictionResult("INSUFFICIENT", ["handoverDoc", "a04BoundaryPlan"]);

  const paidCallStillRequiresExplicitApproval =
    input.handoverDoc.includes("Every real call requires separate approval.") &&
    input.a04BoundarySpec.includes("This design governs branch assessment and branch-local tightening only. It does not authorize a paid Scenario A invocation.") &&
    input.usageEvidenceSpec.includes("The invocation remains unapproved and unrun until separately presented to the user.")
      ? contradictionResult("CONFIRMED", ["handoverDoc", "a04BoundarySpec", "usageEvidenceSpec"])
      : contradictionResult("INSUFFICIENT", ["handoverDoc", "a04BoundarySpec", "usageEvidenceSpec"]);

  return {
    firstRealPaidScenarioA,
    historicalA01ToA03Diagnoses,
    localDryRunArtifactsNotHistoricalEvidence,
    paidCallStillRequiresExplicitApproval,
  };
}
```

- [ ] **Step 4: Implement `inspectMetadataBackedA04History(...)` and delegate the default inspection to it**

Replace the old `defaultInspectReadOnlyInspection(...)` body with a metadata-backed implementation shaped like this:

```ts
export async function inspectMetadataBackedA04History(repoRoot: string): Promise<MetadataInspectionSummary> {
  const mainHead = await gitOutput(repoRoot, ["rev-parse", "HEAD"]);

  const readOptionalText = async (path: string): Promise<string | null> => {
    try {
      return await readFile(resolve(repoRoot, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  const [handoverDoc, a04BoundarySpec, a04BoundaryPlan, usageEvidenceSpec] = await Promise.all([
    readOptionalText(A04_REQUIRED_METADATA_PATHS.handoverDoc),
    readOptionalText(A04_REQUIRED_METADATA_PATHS.a04BoundarySpec),
    readOptionalText(A04_REQUIRED_METADATA_PATHS.a04BoundaryPlan),
    readOptionalText(A04_REQUIRED_METADATA_PATHS.usageEvidenceSpec),
  ]);

  let backupHead: string | undefined;
  let mergeBaseWithMain: string | undefined;
  let distinctFromMain = false;
  try {
    backupHead = await gitOutput(repoRoot, ["rev-parse", "--verify", `refs/heads/${A04_RETAINED_BACKUP_BRANCH}`]);
    mergeBaseWithMain = await gitOutput(repoRoot, ["merge-base", "HEAD", `refs/heads/${A04_RETAINED_BACKUP_BRANCH}`]);
    distinctFromMain = backupHead !== mainHead;
  } catch {
    backupHead = undefined;
    mergeBaseWithMain = undefined;
    distinctFromMain = false;
  }

  const stashLinesOutput = await gitOutput(repoRoot, ["stash", "list"]);
  const stashLines = stashLinesOutput === "" ? [] : stashLinesOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  const worktrees = parseGitWorktreeList(await gitOutput(repoRoot, ["worktree", "list", "--porcelain"]));
  const legacyWorktree = worktrees.find((entry) => entry.branch === "refs/heads/evidence-first-v1");

  const contradictionChecks = handoverDoc && a04BoundarySpec && a04BoundaryPlan && usageEvidenceSpec
    ? evaluateContradictions({ handoverDoc, a04BoundarySpec, a04BoundaryPlan, usageEvidenceSpec })
    : {
        firstRealPaidScenarioA: contradictionResult("INSUFFICIENT", []),
        historicalA01ToA03Diagnoses: contradictionResult("INSUFFICIENT", []),
        localDryRunArtifactsNotHistoricalEvidence: contradictionResult("INSUFFICIENT", []),
        paidCallStillRequiresExplicitApproval: contradictionResult("INSUFFICIENT", []),
      };

  return {
    mainCheckout: {
      status: "PRESENT",
      path: repoRoot,
      head: mainHead,
      branch: "main",
    },
    requiredSources: {
      handoverDoc: {
        status: classifyRequiredSource(A04_REQUIRED_METADATA_PATHS.handoverDoc, handoverDoc),
        path: resolve(repoRoot, A04_REQUIRED_METADATA_PATHS.handoverDoc),
      },
      a04BoundarySpec: {
        status: classifyRequiredSource(A04_REQUIRED_METADATA_PATHS.a04BoundarySpec, a04BoundarySpec),
        path: resolve(repoRoot, A04_REQUIRED_METADATA_PATHS.a04BoundarySpec),
      },
      a04BoundaryPlan: {
        status: classifyRequiredSource(A04_REQUIRED_METADATA_PATHS.a04BoundaryPlan, a04BoundaryPlan),
        path: resolve(repoRoot, A04_REQUIRED_METADATA_PATHS.a04BoundaryPlan),
      },
      usageEvidenceSpec: {
        status: classifyRequiredSource(A04_REQUIRED_METADATA_PATHS.usageEvidenceSpec, usageEvidenceSpec),
        path: resolve(repoRoot, A04_REQUIRED_METADATA_PATHS.usageEvidenceSpec),
      },
      backupBranch: {
        status: backupHead ? "PRESENT" : "MISSING",
        name: A04_RETAINED_BACKUP_BRANCH,
        head: backupHead,
        mergeBaseWithMain,
        distinctFromMain,
      },
    },
    softSignals: {
      retainedStashes: {
        status: stashLines.length > 0 ? "PRESENT" : "MISSING",
        matches: stashLines.filter((line) => A04_REQUIRED_RETAINED_STASH_LINES.some((required) => line.includes(required))),
      },
      legacyEvidenceWorktree: {
        status: legacyWorktree ? "PRESENT" : "MISSING",
        path: resolve(repoRoot, ".worktrees/evidence-first-v1"),
      },
      legacyPreservedEvidenceTree: {
        status: legacyWorktree && (await pathExists(resolve(legacyWorktree.path, ".validation-runs"))) ? "PRESENT" : "MISSING",
        path: resolve(repoRoot, ".worktrees/evidence-first-v1/.validation-runs"),
      },
    },
    contradictionChecks,
  };
}

async function defaultInspectReadOnlyInspection(repoRoot: string): Promise<MetadataInspectionSummary> {
  return inspectMetadataBackedA04History(repoRoot);
}
```

Do not reintroduce any direct hard read of `refs/heads/evidence-first-v1` worktree or `legacy .validation-runs` paths.

- [ ] **Step 5: Enforce the hard-blocker rules inside `prepareA04(...)`**

Immediately after `const readOnlyInspection = await deps.inspectReadOnlyInspection(resolvedOptions.repoRoot);`, add this gate:

```ts
for (const [label, source] of Object.entries(readOnlyInspection.requiredSources)) {
  if (source.status !== "PRESENT") {
    throw new Error(`${label} must be present for metadata-backed A-04 inspection`);
  }
}

if (readOnlyInspection.requiredSources.backupBranch.distinctFromMain !== true) {
  throw new Error("backup branch must remain a distinct history anchor for metadata-backed A-04 inspection");
}

if (!readOnlyInspection.requiredSources.backupBranch.mergeBaseWithMain) {
  throw new Error("backup branch must remain locally reachable for metadata-backed A-04 inspection");
}

for (const [label, check] of Object.entries(readOnlyInspection.contradictionChecks)) {
  if (check.status !== "CONFIRMED") {
    throw new Error(`${label} must be mechanically confirmed for metadata-backed A-04 inspection`);
  }
}
```

Do not fail on `softSignals`.

- [ ] **Step 6: Rerun the focused suite to verify the metadata-backed boundary**

Run:

```bash
npm test -- --run tests/validation/prepareA04.test.ts
```

Expected: PASS for the new missing-legacy-worktree, missing-stash, missing-usage-evidence-spec, insufficient-contradiction, and weak-backup-branch tests.

- [ ] **Step 7: Commit Task 2**

```bash
git status --short
git add validation/v1/lib/a04.ts tests/validation/prepareA04.test.ts
git commit -m "feat: add metadata-backed A-04 inspection"
```

Expected: commit contains only the metadata-backed inspection implementation and matching tests.

### Task 3: Align README, handover, and superseded governing docs

**Files:**
- Modify: `validation/v1/README.md`
- Modify: `docs/handover/ccloop-handover.md`
- Modify: `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`

**Interfaces:**
- Consumes:
  - `MetadataInspectionSummary`
  - `inspectMetadataBackedA04History(...)`
- Produces:
  - consistent human-facing docs that no longer describe the deleted worktree / preserved evidence tree as a hard requirement

- [ ] **Step 1: Update `validation/v1/README.md` to describe the metadata-backed boundary**

Replace the legacy hard-gate wording in the A-04 section with this paragraph immediately after the A-04 command block:

```md
A-04 prepare now checks metadata-backed historical context from the current `main` checkout. It no longer requires the deleted `evidence-first-v1` linked worktree or its preserved `.validation-runs/` tree to remain present as hard prerequisites. Fresh local `.validation-runs/**` outputs created during non-paid prepare are not historical preserved evidence and must not be treated as A-01 through A-03 artifacts.
```

- [ ] **Step 2: Update the handover to state the new reality explicitly**

Add this subsection to `docs/handover/ccloop-handover.md` near the current A-04 prepare discussion:

```md
### Metadata-backed A-04 historical context

- The old linked `evidence-first-v1` worktree and its preserved `.validation-runs/` tree are no longer available.
- A-04 historical context is now reconstructed from current repository metadata and branch history anchors.
- Historical A-01 through A-03 semantics remain binding even though the old preserved artifact tree is gone.
- Fresh local `.validation-runs/**` outputs created during prepare remain non-paid dry-run artifacts only.
```

- [ ] **Step 3: Supersede the deleted-worktree hard gate in the 2026-07-18 A-04 design**

Replace `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md` §6.1 bullet list with:

```md
### 6.1 Metadata-backed read-only inspection

Inspect without cleaning or resetting:

- the current `main` checkout;
- `docs/handover/ccloop-handover.md`;
- `docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md`;
- `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`;
- `docs/superpowers/specs/2026-07-18-claude-usage-evidence-design.md`;
- local branch `backup/evidence-first-v1-before-memory-history-cleanup`.

Retained stashes, the legacy `evidence-first-v1` linked worktree, and the legacy preserved `.validation-runs/` tree are now soft signals surfaced in the inspection summary rather than hard blockers by themselves.
```

- [ ] **Step 4: Add a superseded note to the older A-04 implementation plan**

Insert this note near the top of `docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md`:

```md
> Superseded in part by `docs/superpowers/specs/2026-07-19-a04-metadata-backed-prepare-boundary-design.md` for the A-04 read-only inspection boundary. The deleted `evidence-first-v1` linked worktree and its preserved `.validation-runs/` tree are no longer hard prerequisites when the required metadata set is present and mechanically consistent.
```

- [ ] **Step 5: Update OpenWolf bookkeeping for the new plan file and doc changes**

Add this line under the `## docs/superpowers/plans/` section of `.wolf/anatomy.md`:

```md
- `2026-07-19-a04-metadata-backed-prepare-boundary.md` — Implementation plan for metadata-backed A-04 inspection and legacy-boundary supersession (~6200 tok)
```

Then append this line to `.wolf/memory.md`:

```md
| HH:MM | Wrote metadata-backed A-04 inspection implementation plan and aligned superseded-doc updates | docs/superpowers/plans/2026-07-19-a04-metadata-backed-prepare-boundary.md, validation/v1/README.md, docs/handover/ccloop-handover.md, docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md, docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md | done | ~2200 |
```

- [ ] **Step 6: Verify the doc alignment**

Run:

```bash
rg -n "metadata-backed|deleted `evidence-first-v1`|soft signals|not historical preserved evidence|Superseded in part" \
  validation/v1/README.md \
  docs/handover/ccloop-handover.md \
  docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md \
  docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md
```

Expected: all four files contain the new metadata-backed / superseded-boundary language.

- [ ] **Step 7: Commit Task 3**

```bash
git status --short
git add \
  validation/v1/README.md \
  docs/handover/ccloop-handover.md \
  docs/superpowers/specs/2026-07-18-a04-preflight-and-stop-boundaries-design.md \
  docs/superpowers/plans/2026-07-18-a04-preflight-and-approval.md \
  .wolf/anatomy.md \
  .wolf/memory.md
git commit -m "docs: align A-04 metadata-backed boundary"
```

Expected: commit contains only documentation and OpenWolf bookkeeping updates.

### Task 4: Verify the implementation and current live-repo behavior

**Files:**
- Test: `tests/validation/prepareA04.test.ts`
- Test: `tests/validation/contracts.test.ts`
- Modify only on verification failure: `.wolf/buglog.json`

**Interfaces:**
- Consumes:
  - `inspectMetadataBackedA04History(...)`
  - metadata-backed `prepareA04(...)`
- Produces:
  - final verification evidence for the metadata-backed boundary

- [ ] **Step 1: Run the focused deterministic verification set**

Run:

```bash
npm test -- --run tests/validation/contracts.test.ts tests/validation/prepareA04.test.ts tests/runtime/claude/subprocessClaudeAdapter.test.ts tests/controller/runLoop.integration.test.ts tests/validation/evidence.test.ts
npm run typecheck
npm run build
```

Expected: PASS; no real Claude call; no destructive cleanup.

- [ ] **Step 2: If any verification command fails, log the failure before changing code**

Append a JSON object like this to `.wolf/buglog.json` before fixing anything:

```json
{
  "id": "bug-NNN",
  "timestamp": "2026-07-19T18:00:00+08:00",
  "error_message": "npm run build failed during metadata-backed A-04 boundary verification",
  "file": "validation/v1/lib/a04.ts",
  "root_cause": "replace with the concrete build or test failure",
  "fix": "replace with the exact next code or test fix",
  "tags": ["a04", "metadata-boundary", "verification", "non-paid"],
  "related_bugs": [],
  "occurrences": 1,
  "last_seen": "2026-07-19T18:00:00+08:00"
}
```

Then stop and return to Task 2 or Task 3 as appropriate.

- [ ] **Step 3: Check current live-repo behavior for the backup-branch gate**

Run:

```bash
if git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup' | grep -q .; then
  echo "backup-branch-present"
else
  echo "backup-branch-missing"
fi
```

Expected: one of the two exact outputs, with no guesswork.

- [ ] **Step 4: Verify the live `prepare-a04.ts` path against the current repo state**

Run from the repository root:

```bash
npx --no-install tsx validation/v1/scripts/create-fixture.ts --output .validation-runs/fixture-01

if git branch --list 'backup/evidence-first-v1-before-memory-history-cleanup' | grep -q .; then
  npx --no-install tsx validation/v1/scripts/prepare-a04.ts \
    --fixture .validation-runs/fixture-01 \
    --contract .validation-runs/contracts/A-04.json \
    --run-dir .validation-runs/runs/A-04 \
    --evidence-dir .validation-runs/evidence/A-04 \
    --adapter-config examples/v1/claude-adapter-config.json \
    --token-budget 550000 \
    --per-attempt-timeout-ms 600000 \
    --total-runtime-budget-ms 1200000 \
    --partial-recovery-window-ms 5000
else
  if npx --no-install tsx validation/v1/scripts/prepare-a04.ts \
    --fixture .validation-runs/fixture-01 \
    --contract .validation-runs/contracts/A-04.json \
    --run-dir .validation-runs/runs/A-04 \
    --evidence-dir .validation-runs/evidence/A-04 \
    --adapter-config examples/v1/claude-adapter-config.json \
    --token-budget 550000 \
    --per-attempt-timeout-ms 600000 \
    --total-runtime-budget-ms 1200000 \
    --partial-recovery-window-ms 5000; then
    echo "unexpected-success-without-backup-branch"
    exit 1
  fi
fi
```

Expected:
- if the backup branch is present, the command succeeds and prints an approval package whose inspection summary reports soft legacy signals without treating them as hard blockers;
- if the backup branch is missing, the command fails specifically on the backup-branch hard blocker rather than on the deleted legacy worktree.

- [ ] **Step 5: Commit Task 4**

```bash
git status --short
```

Expected: no new code changes from verification only. If the working tree is clean, no commit is needed.

## Self-Review

- **Spec coverage:**
  - `Superseded governing sections` → Task 3 updates the old A-04 spec and plan so the deleted worktree hard gate is no longer simultaneously active.
  - `Required Metadata Set` + `Hard blockers` → Task 2 implements the full required source set and one-to-one blocker mapping, including the usage-evidence spec and backup-branch anchor checks.
  - `Machine-checkable inspection summary contract` → Task 1 defines the summary shape; Task 2 implements and tests it.
  - `Soft signals vs Hard blockers` → Task 2 adds focused regressions for missing stashes / legacy worktree as soft signals and missing docs / weak backup branch as hard failures.
  - `Explicit Non-Substitution Rule` → Tasks 2 and 3 preserve the distinction between fresh local `.validation-runs/**` outputs and historical evidence in both code/tests and docs.
  - `Unchanged Boundaries` → Tasks 2 and 4 keep the A-04 envelope, approval semantics, and non-paid behavior intact while verifying the new inspection boundary.
- **Placeholder scan:** no `TODO`, `TBD`, or “implement later” placeholders remain; every code-changing step includes exact code or exact shell commands.
- **Type consistency:** `MetadataInspectionSummary`, `RequiredSourceStatus`, `SoftSignalStatus`, and `ContradictionStatus` are defined once in Task 1 and reused consistently across Task 2 and later doc/test steps.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-a04-metadata-backed-prepare-boundary.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
