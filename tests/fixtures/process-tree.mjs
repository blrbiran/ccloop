import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const [mode, marker] = process.argv.slice(2);

if (mode === "grandchild") {
  await appendFile(marker, `${JSON.stringify({ role: "grandchild", pid: process.pid })}\n`);
  setInterval(() => {}, 1_000);
} else if (mode === "child") {
  await appendFile(marker, `${JSON.stringify({ role: "child", pid: process.pid })}\n`);
  setTimeout(() => {
    const grandchild = spawn(process.execPath, [process.argv[1], "grandchild", marker], {
      detached: false,
      stdio: "ignore",
    });
    grandchild.unref();
  }, 50);
  setInterval(() => {}, 1_000);
} else {
  await writeFile(marker, `${JSON.stringify({ role: "leader", pid: process.pid })}\n`);
  const child = spawn(process.execPath, [process.argv[1], "child", marker], {
    detached: false,
    stdio: "ignore",
  });
  child.unref();
  setTimeout(() => process.exit(0), 150);
}
