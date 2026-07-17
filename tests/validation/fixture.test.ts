import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFixture } from "../../validation/v1/scripts/create-fixture.js";

const execFileAsync = promisify(execFile);
const templateDir = join(process.cwd(), "validation", "v1", "fixture");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("createFixture", () => {
  it("creates a clean Git fixture at one baseline commit", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-fixture-"));
    const outputDir = join(tempRoot, "repo");

    const result = await createFixture(templateDir, outputDir);

    expect(result.repoPath).toBe(outputDir);
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(outputDir, ["status", "--porcelain"])).toBe("");
    expect(await git(outputDir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("refuses to overwrite an existing output directory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ccloop-fixture-"));
    const outputDir = join(tempRoot, "repo");
    await mkdir(outputDir, { recursive: true });

    await expect(createFixture(templateDir, outputDir)).rejects.toThrow("fixture output already exists");
  });
});
