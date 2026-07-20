import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReclassifiedReview, validateReview } from "../lib/evidence.js";

type ParsedArgs = {
  evidenceDir: string;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  diagnosis: "PRODUCT_DEFECT" | "RUNTIME_VARIANCE" | "ENVIRONMENT_FAILURE" | "CONTRACT_GAP" | null;
  summary: string;
  reclassifyFrom?: string;
  boundaryClassification?: "PRE_EXECUTE_EXHAUSTION" | "EXECUTE_ENTERED_NO_RECOVERABLE_EVIDENCE" | "EXECUTE_ENTERED_WITH_RECOVERABLE_EVIDENCE" | "BOUNDARY_UNRESOLVED";
  ruleVersion?: string;
  evidenceReferences: string[];
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const evidenceReferences: string[] = [];

  for (let index = 0; index < argv.length; ) {
    const key = argv[index];
    if (!key) {
      break;
    }

    if (key === "--evidence-reference") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("expected --evidence-reference <path>");
      }
      evidenceReferences.push(value);
      index += 2;
      continue;
    }

    values.set(key, argv[index + 1] ?? "");
    index += 2;
  }

  const evidenceDir = values.get("--evidence-dir");
  const verdict = values.get("--verdict");
  const diagnosisValue = values.get("--diagnosis");
  const summary = values.get("--summary");
  const reclassifyFrom = values.get("--reclassify-from");
  const boundaryClassification = values.get("--boundary-classification");
  const ruleVersion = values.get("--rule-version");

  if (!evidenceDir || !verdict || diagnosisValue === undefined || summary === undefined) {
    throw new Error("expected --evidence-dir <path> --verdict <PASS|FAIL|INCONCLUSIVE> --diagnosis <value|null> --summary <text>");
  }

  if (
    (reclassifyFrom && (!boundaryClassification || !ruleVersion || evidenceReferences.length === 0)) ||
    (!reclassifyFrom && (boundaryClassification || ruleVersion || evidenceReferences.length > 0))
  ) {
    throw new Error(
      "reclassification requires --reclassify-from <review.json> --boundary-classification <value> --rule-version <value> and at least one --evidence-reference <path>",
    );
  }

  const diagnosis = diagnosisValue === "null" ? null : diagnosisValue;
  const review = validateReview({
    scenarioVerdict: verdict,
    diagnosis,
    summary,
    reviewedAt: new Date().toISOString(),
  });

  return {
    evidenceDir,
    verdict: review.scenarioVerdict,
    diagnosis: review.diagnosis,
    summary: review.summary,
    reclassifyFrom: reclassifyFrom ? resolve(reclassifyFrom) : undefined,
    boundaryClassification: boundaryClassification as ParsedArgs["boundaryClassification"],
    ruleVersion,
    evidenceReferences,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const evidenceDir = resolve(parsed.evidenceDir);
    await mkdir(evidenceDir, { recursive: true });

    const review = validateReview({
      scenarioVerdict: parsed.verdict,
      diagnosis: parsed.diagnosis,
      summary: parsed.summary,
      reviewedAt: new Date().toISOString(),
    });

    if (parsed.reclassifyFrom) {
      const originalReviewPath = parsed.reclassifyFrom;
      const reclassifiedReviewPath = join(evidenceDir, "review-reclassified.json");

      if (await pathExists(reclassifiedReviewPath)) {
        throw new Error("review-reclassified.json already exists");
      }

      const originalReview = validateReview(JSON.parse(await readFile(originalReviewPath, "utf8")) as unknown);
      const reclassifiedReview = validateReclassifiedReview({
        original: originalReview,
        reclassified: review,
        boundaryClassification: parsed.boundaryClassification,
        ruleVersion: parsed.ruleVersion,
        evidenceReferences: parsed.evidenceReferences,
      });
      await writeFile(reclassifiedReviewPath, `${JSON.stringify(reclassifiedReview, null, 2)}
`);
      return 0;
    }

    const reviewPath = join(evidenceDir, "review.json");
    if (await pathExists(reviewPath)) {
      throw new Error("review.json already exists");
    }

    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}
`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
}

if (process.argv[1]) {
  void realpath(process.argv[1])
    .then((entryPath) => entryPath === fileURLToPath(import.meta.url))
    .catch(() => false)
    .then((shouldRunMain) => {
      if (!shouldRunMain) {
        return;
      }

      void main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
      });
    });
}
