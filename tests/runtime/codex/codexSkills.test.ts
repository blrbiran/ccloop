import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withCodexSkillLinks } from "../../../src/runtime/codex/codexSkills.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function fixture() {
 const root=await realpath(await mkdtemp(join(tmpdir(),"skills-")));roots.push(root);
 const work=join(root,"work"),source=join(root,"snapshot","skills"),links=join(work,".agents","skills");
 await mkdir(work);await mkdir(join(source,"a"),{recursive:true});await writeFile(join(source,"a","SKILL.md"),"selected");
 return {root,work,source,links};
}
it("preserves existing skills and unrelated bytes after success or callback failure",async()=>{
 for(const fail of [false,true]) {
 const f=await fixture();await mkdir(join(f.links,"legacy"),{recursive:true});
 await writeFile(join(f.links,"legacy","SKILL.md"),"legacy\0bytes");await writeFile(join(f.links,"notes"),"notes");
 const p=withCodexSkillLinks(f.work,f.source,async()=>{expect(await readFile(join(f.links,"a","SKILL.md"),"utf8")).toBe("selected");if(fail) throw new Error("child failed");return 42;});
 if(fail) await expect(p).rejects.toThrow("child failed");else expect(await p).toBe(42);
 await expect(lstat(join(f.links,"a"))).rejects.toMatchObject({code:"ENOENT"});
 expect(await readFile(join(f.links,"legacy","SKILL.md"),"utf8")).toBe("legacy\0bytes");expect(await readFile(join(f.links,"notes"),"utf8")).toBe("notes");
 }
});
it("removes only parents it created",async()=>{const f=await fixture();await withCodexSkillLinks(f.work,f.source,async()=>{});await expect(lstat(join(f.work,".agents"))).rejects.toMatchObject({code:"ENOENT"});});
it.each(["directory","file","symlink"])("refuses %s collisions without touching the entry or starting the child",async(kind)=>{
 const f=await fixture();await mkdir(f.links,{recursive:true});const leaf=join(f.links,"a");
 if(kind==="directory") await mkdir(leaf);else if(kind==="file") await writeFile(leaf,"original");else await symlink(f.work,leaf);
 await expect(withCodexSkillLinks(f.work,f.source,async()=>{throw new Error("spawned");})).rejects.toThrow("codex-skills-path-conflict:a");
 if(kind==="file") expect(await readFile(leaf,"utf8")).toBe("original");else if(kind==="symlink") expect(await readlink(leaf)).toBe(f.work);else expect((await lstat(leaf)).isDirectory()).toBe(true);
});
it.each([".agents",".agents/skills"])("refuses a symlink parent %s without traversing its target",async(parent)=>{
 const f=await fixture();await mkdir(join(f.root,"foreign"));if(parent.includes("/")) await mkdir(join(f.work,".agents"));
 await symlink(join(f.root,"foreign"),join(f.work,parent));
 await expect(withCodexSkillLinks(f.work,f.source,async()=>{})).rejects.toThrow("codex-skills-path-conflict:");
 await expect(lstat(join(f.root,"foreign","a"))).rejects.toMatchObject({code:"ENOENT"});
});
it.each([".agents",".agents/skills"])("preserves non-directory parent %s",async(parent)=>{
 const f=await fixture();if(parent.includes("/")) await mkdir(join(f.work,".agents"));await writeFile(join(f.work,parent),"original");
 await expect(withCodexSkillLinks(f.work,f.source,async()=>{})).rejects.toThrow("codex-skills-path-conflict:");expect(await readFile(join(f.work,parent),"utf8")).toBe("original");
});
it("cleans partial setup and keeps a later conflicting entry",async()=>{
 const f=await fixture();await mkdir(join(f.source,"z"));await mkdir(f.links,{recursive:true});await writeFile(join(f.links,"z"),"foreign");
 await expect(withCodexSkillLinks(f.work,f.source,async()=>{})).rejects.toThrow("codex-skills-path-conflict:z");
 await expect(lstat(join(f.links,"a"))).rejects.toMatchObject({code:"ENOENT"});expect(await readFile(join(f.links,"z"),"utf8")).toBe("foreign");
});
it("adopts and removes the exact same snapshot link",async()=>{const f=await fixture();await mkdir(f.links,{recursive:true});await symlink(join(f.source,"a"),join(f.links,"a"));await withCodexSkillLinks(f.work,f.source,async()=>{});await expect(lstat(join(f.links,"a"))).rejects.toMatchObject({code:"ENOENT"});expect((await lstat(f.links)).isDirectory()).toBe(true);});
it("rejects noncanonical roots and escaping source children before touching worktree",async()=>{
 const f=await fixture();const alias=join(f.root,"alias");await symlink(f.source,alias);
 await expect(withCodexSkillLinks(f.work,alias,async()=>{})).rejects.toThrow("codex-skills-source-invalid:");
 await symlink(f.work,join(f.source,"z"));await expect(withCodexSkillLinks(f.work,f.source,async()=>{})).rejects.toThrow("codex-skills-source-invalid:");
 await expect(lstat(join(f.work,".agents"))).rejects.toMatchObject({code:"ENOENT"});
});
it("reports cleanup failure and preserves a replaced foreign entry",async()=>{
 const f=await fixture();await expect(withCodexSkillLinks(f.work,f.source,async()=>{await rm(join(f.links,"a"));await writeFile(join(f.links,"a"),"foreign");})).rejects.toThrow("codex-skills-cleanup-failed:");expect(await readFile(join(f.links,"a"),"utf8")).toBe("foreign");
});

it("leaves syncskill lock metadata external while loading selected directories",async()=>{const f=await fixture();await writeFile(join(f.source,"syncskill-lock.json"),'{"skills":[]}');await withCodexSkillLinks(f.work,f.source,async()=>{expect(await readFile(join(f.links,"a/SKILL.md"),"utf8")).toBe("selected");await expect(lstat(join(f.links,"syncskill-lock.json"))).rejects.toMatchObject({code:"ENOENT"});});expect(await readFile(join(f.source,"syncskill-lock.json"),"utf8")).toBe('{"skills":[]}');});
