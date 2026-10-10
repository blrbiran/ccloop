import * as fs from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";

/** Schedule a real directory swap after its stat, and restoration after the second leaf stat. */
export async function armAncestorSwap(directory: string, outside: string, leaf: string) {
  const saved = `${directory}-saved`;
  const actualLstat = fs.lstat;
  let swapped = false;
  let restored = false;
  let leafStats = 0;
  const restore = async () => {
    if (!swapped || restored) return;
    await fs.unlink(directory);
    await fs.rename(saved, directory);
    restored = true;
  };
  const implementation = async (...args: Parameters<typeof fs.lstat>) => {
    const metadata = await actualLstat(...args);
    if (args[0] === directory && !swapped) {
      swapped = true;
      await fs.rename(directory, saved);
      await fs.symlink(outside, directory);
    } else if (args[0] === join(directory, leaf) && ++leafStats === 2) {
      await restore();
    }
    return metadata;
  };
  const spy = vi.spyOn(fs, "lstat").mockImplementation(implementation as typeof fs.lstat);
  return {
    wasSwapped: () => swapped,
    close: async () => { spy.mockRestore(); await restore(); },
  };
}
