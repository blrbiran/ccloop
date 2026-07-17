import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateReview } from "../lib/evidence.js";

type ParsedArgs = {
  evidenceDir: string;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  diagnosis: "PRODUCT_DEFECT" | "RUNTIME_VARIANCE" | "ENVIRONMENT_FAILURE" | "CONTRACT_GAP" | null;
  summary: string;
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
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index] ?? "", argv[index + 1] ?? "");
  }

  const evidenceDir = values.get("--evidence-dir");
  const verdict = values.get("--verdict");
  const diagnosisValue = values.get("--diagnosis");
  const summary = values.get("--summary");

  if (!evidenceDir || !verdict || diagnosisValue === undefined || summary === undefined) {
    throw new Error("expected --evidence-dir <path> --verdict <PASS|FAIL|INCONCLUSIVE> --diagnosis <value|null> --summary <text>");
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
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const evidenceDir = resolve(parsed.evidenceDir);
    const reviewPath = join(evidenceDir, "review.json");

    if (await pathExists(reviewPath)) {
      throw new Error("review.json already exists");
    }

    await mkdir(evidenceDir, { recursive: true });
    const review = validateReview({
      scenarioVerdict: parsed.verdict,
      diagnosis: parsed.diagnosis,
      summary: parsed.summary,
      reviewedAt: new Date().toISOString(),
    });
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
