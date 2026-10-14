import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompSingleCallExecution, readOmpCatalog, readOmpModels } from "../../src/agents/ompModels.js";
import type { InstallationV1 } from "../../src/agents/types.js";

// OMP single call (Orca spec 2026-10-14-omp-single-call-design.md §3.1): the catalog's one spawn gives rows, and a number is
// used only when it is a positive safe integer -- so a malformed or absent value can never become a context window or the
// output bound Orca books. §3.2: only a row that declares the cap pi-ai sends, from a provider other than openrouter (for
// which pi-ai sends no cap without an explicit one), may answer "v1".
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function catalogInstallation(models: unknown[]): Promise<InstallationV1> {
  const dir = await mkdtemp(join(tmpdir(), "ccloop-omp-rows-"));
  dirs.push(dir);
  const binary = join(dir, "omp");
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("models")) { process.stdout.write(${JSON.stringify(`${JSON.stringify({ models })}\n`)}); process.exit(0); }
process.exit(2);
`, { mode: 0o700 });
  return { kind: "omp", command: [binary], version: "18.10.1", configDir: null, timeoutMs: 10_000, killGraceMs: 50, defaultModel: "gateway/a", profile: null };
}
const row = (provider: string, id: string, numbers: Record<string, unknown>) => ({ provider, id, selector: `${provider}/${id}`, kind: "chat", ...numbers });

describe("OMP catalog rows (omp single call §3.1)", () => {
  it("keeps contextWindow and maxTokens only when each is a positive safe integer, with the row's provider", async () => {
    const installation = await catalogInstallation([
      row("gateway", "a", { contextWindow: 200_000, maxTokens: 8_192 }),
      row("gateway", "zero", { contextWindow: 0, maxTokens: 0 }),
      row("gateway", "negative", { contextWindow: -1, maxTokens: -5 }),
      row("gateway", "fraction", { contextWindow: 1.5, maxTokens: 2.5 }),
      row("gateway", "string", { contextWindow: "128000", maxTokens: "16384" }),
      row("gateway", "unsafe", { contextWindow: 2 ** 53, maxTokens: 2 ** 53 }),
      row("gateway", "absent", {}),
      row("openrouter", "vendor/m", { contextWindow: 64_000, maxTokens: 4_096 }),
    ]);
    const none = { contextWindow: null, maxTokens: null };
    expect(await readOmpCatalog(installation)).toEqual([
      { selector: "gateway/a", provider: "gateway", contextWindow: 200_000, maxTokens: 8_192 },
      { selector: "gateway/zero", provider: "gateway", ...none },
      { selector: "gateway/negative", provider: "gateway", ...none },
      { selector: "gateway/fraction", provider: "gateway", ...none },
      { selector: "gateway/string", provider: "gateway", ...none },
      { selector: "gateway/unsafe", provider: "gateway", ...none },
      { selector: "gateway/absent", provider: "gateway", ...none },
      { selector: "openrouter/vendor/m", provider: "openrouter", contextWindow: 64_000, maxTokens: 4_096 },
    ]);
    // The selector-list callers (detect, updates, older criteria) keep exactly what they had: the selectors, in order.
    expect(await readOmpModels(installation)).toEqual([
      "gateway/a", "gateway/zero", "gateway/negative", "gateway/fraction", "gateway/string", "gateway/unsafe", "gateway/absent", "openrouter/vendor/m",
    ]);
  });

  it("still refuses a row whose selector is not provider/id, from both readers", async () => {
    const installation = await catalogInstallation([{ provider: "gateway", id: "a", selector: "gateway/b", maxTokens: 8 }]);
    await expect(readOmpCatalog(installation)).rejects.toThrow("omp-model-catalog-invalid");
    await expect(readOmpModels(installation)).rejects.toThrow("omp-model-catalog-invalid");
  });

  it("answers v1 only for a row with a cap whose provider is not openrouter", () => {
    expect(ompSingleCallExecution({ selector: "gateway/a", provider: "gateway", contextWindow: null, maxTokens: 8_192 })).toBe("v1");
    expect(ompSingleCallExecution({ selector: "gateway/a", provider: "gateway", contextWindow: 200_000, maxTokens: null })).toBeNull();
    expect(ompSingleCallExecution({ selector: "openrouter/vendor/m", provider: "openrouter", contextWindow: 64_000, maxTokens: 4_096 })).toBeNull();
    expect(ompSingleCallExecution(undefined)).toBeNull();
  });
});
