import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Orca execution driver (2026-09-25), ccloop change C3: a scripted fake-codex mode. Every existing mode
// keeps its own branch unchanged and stays pinned by the criteria that already use it.
const fake = fileURLToPath(new URL("../../fixtures/fake-codex.mjs", import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function run(prompt: string, script: Record<string, unknown>): Promise<{ code: number | null; stderr: string; cwd: string }> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "fake-codex-script-")));
  roots.push(cwd);
  const scriptPath = join(cwd, "script.json"), schemaPath = join(cwd, "schema.json");
  await writeFile(scriptPath, JSON.stringify(script));
  // An `anyOf` schema is how the fixture recognises the execute phase.
  await writeFile(schemaPath, JSON.stringify({ anyOf: [{}] }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fake, "script", join(cwd, "marker.json"), scriptPath, "exec", "-o", join(cwd, "final.json"), "--output-schema", schemaPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, cwd }));
    child.stdin.end(prompt);
  });
}

describe("fake codex script mode (Orca execution driver C3)", () => {
  it("writes the files the script names for the task in the prompt, and nothing for other tasks", async () => {
    const result = await run("Return JSON only.\nExecute one isolated attempt for task b.\nGoal: x\n", {
      a: { files: { "shared.txt": "A\n" } }, b: { files: { "shared.txt": "B\n", "b.txt": "only b\n" } },
    });
    expect(result.code).toBe(0);
    expect(await readFile(join(result.cwd, "shared.txt"), "utf8")).toBe("B\n");
    expect(await readFile(join(result.cwd, "b.txt"), "utf8")).toBe("only b\n");
    expect(await readFile(join(result.cwd, "marker.json.calls"), "utf8")).toBe("execute\n");
  });

  it("refuses by name, writes nothing and no final answer, when the script has no entry for the task", async () => {
    const result = await run("Execute one isolated attempt for task c.\n", { a: { files: { "shared.txt": "A\n" } } });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("fake-codex script has no entry for task c");
    await expect(readFile(join(result.cwd, "shared.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(result.cwd, "final.json"), "utf8")).rejects.toThrow();
  });
});
