import { execFile } from "node:child_process";
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FixtureResult = {
  repoPath: string;
  baseCommit: string;
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

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd });
  return stdout.trim();
}

export async function createFixture(templateDir: string, outputDir: string): Promise<FixtureResult> {
  const repoPath = resolve(outputDir);

  if (await pathExists(repoPath)) {
    throw new Error("fixture output already exists");
  }

  await mkdir(dirname(repoPath), { recursive: true });
  await cp(resolve(templateDir), repoPath, { recursive: true });

  await run("git", ["init"], repoPath);
  await run("git", ["config", "user.name", "ccloop-validation"], repoPath);
  await run("git", ["config", "user.email", "ccloop-validation@example.invalid"], repoPath);
  await run("git", ["add", "package.json", "src/counter.js", "test/counter.test.js"], repoPath);
  await run("git", ["commit", "-m", "fixture: establish validation baseline"], repoPath);
  await run("npm", ["test"], repoPath);

  return {
    repoPath,
    baseCommit: await run("git", ["rev-parse", "HEAD"], repoPath),
  };
}

function parseOutputArg(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--output") {
    throw new Error("expected --output <path>");
  }

  return argv[1]!;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const outputDir = parseOutputArg(argv);
    const templateDir = fileURLToPath(new URL("../fixture", import.meta.url));
    const result = await createFixture(templateDir, outputDir);
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
