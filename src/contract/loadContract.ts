import { readFile } from "node:fs/promises";
import { loopContractSchema, type LoopContract } from "./schema.js";

export async function loadContract(filePath: string): Promise<LoopContract> {
  const rawText = await readFile(filePath, "utf8");
  const rawJson = JSON.parse(rawText) as unknown;
  return loopContractSchema.parse(rawJson);
}
