import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export async function testCrashPoint(point: string): Promise<void> {
  if (process.env.NODE_ENV !== "test" || process.env.CCLOOP_CONTROL_TEST_CRASH_POINT !== point) return;
  const marker = process.env.CCLOOP_CONTROL_TEST_CRASH_MARKER;
  if (!marker || !isAbsolute(marker)) throw new Error("control-test-crash-marker-invalid");
  const file = await open(
    marker,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${point}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(marker), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
}
