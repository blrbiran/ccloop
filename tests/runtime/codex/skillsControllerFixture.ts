import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexFixture } from "./fixture.js";

export async function skillsControllerFixture(phase: "plan" | "execute" | "verify", replace: boolean) {
  const f = await codexFixture();
  const skills = join(f.dir, "snapshot", "skills");
  await mkdir(join(skills, "selected"), { recursive: true });
  await writeFile(join(skills, "selected", "SKILL.md"), "marker");
  const wrapper = join(f.dir, "wrapper.mjs");
  await writeFile(wrapper, `
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const [target, replace, observation, fake] = process.argv.slice(2, 6);
const args = process.argv.slice(6);
if (args.includes("--version") && !args.includes("exec")) { console.log("9.9.9-fake"); process.exit(0); }
const wire = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
const schema = wire.properties?.result ?? wire;
const phase = schema.anyOf ? "execute" : schema.properties?.approved ? "verify" : "plan";
if (phase === target) {
  const leaf = ".agents/skills/selected";
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (replace === "true") { unlinkSync(leaf); writeFileSync(leaf, "foreign replacement"); }
    writeFileSync(observation + ".started", JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
    process.on("SIGTERM", () => setTimeout(() => {
      writeFileSync(observation + ".closed", JSON.stringify({ skillPresentBeforeExit: existsSync(leaf), cwd: process.cwd() }));
      process.exit(0);
    }, 250));
    setInterval(() => {}, 1000);
  });
} else {
  process.argv.splice(2, 4);
  await import(fake);
}
`);
  f.config.command = [process.execPath, wrapper, phase, String(replace), f.marker, f.config.command[1]!, "integration", f.marker];
  f.config.killGraceMs = 1000;
  f.contract.executionPolicy.perAttemptTimeoutMs = 1000;
  return { ...f, skills };
}

export async function waitForOwnFixture(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`fixture marker missing: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
