import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSkillLibraryText } from "../src/skills/skill_library.js";
import { getCodexThreadStartProfileForTest } from "../src/brains/codex_brain.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

function fixture(t:test.TestContext,files:Record<string,string>){
 const keys=["OPERATOR_WORKSPACE_ROOT","OPERATOR_LOCAL_SKILLS_DIR","OPERATOR_SKILL_LIBRARY_MAX_TOTAL_CHARS","OPERATOR_SKILL_LIBRARY_MANIFEST","LOCALAPPDATA"];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const priorCwd=process.cwd();let source=priorCwd;
 while(!fs.existsSync(path.join(source,"skills/skill_library_manifest.json"))){const parent=path.dirname(source);assert.notEqual(parent,source);source=parent;}
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),"operator-company-guidance-")),repo=path.join(temp,"repo");
 fs.mkdirSync(path.join(repo,"operator-backend"),{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(source,"skills/skill_library_manifest.json"),"utf8"));
 for(const file of manifest.files){const dest=path.join(repo,file.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(source,file.path),dest);}
 fs.writeFileSync(path.join(repo,"skills/skill_library_manifest.json"),JSON.stringify(manifest));
 process.env.OPERATOR_WORKSPACE_ROOT=path.join(temp,"workspace");process.env.OPERATOR_LOCAL_SKILLS_DIR=path.join(temp,"company");process.env.LOCALAPPDATA=path.join(temp,"machine");
 delete process.env.OPERATOR_SKILL_LIBRARY_MAX_TOTAL_CHARS;delete process.env.OPERATOR_SKILL_LIBRARY_MANIFEST;
 fs.mkdirSync(process.env.OPERATOR_LOCAL_SKILLS_DIR,{recursive:true});
 for(const [name,text] of Object.entries(files))fs.writeFileSync(path.join(process.env.OPERATOR_LOCAL_SKILLS_DIR,name),text);
 process.chdir(repo);
 t.after(()=>{__closeForTests();process.chdir(priorCwd);for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}fs.rmSync(temp,{recursive:true,force:true});});
 return temp;
}

test("ordinary assembled profile retains complete reconstruction guidance and company README conventions",t=>{
 fixture(t,{"README.md":"Company convention: corner offices are separate zones.\n"+"Explicit company guidance. ".repeat(150),"second.md":"Use louvered-face supply diffusers and fixed-blade returns.\n"+"Project requirements. ".repeat(150)});
 const profile=getCodexThreadStartProfileForTest({session_id:"company-guidance",context:{}}),text=profile.developerInstructions;
 assert(text.includes("Company convention: corner offices are separate zones."));
 assert(text.includes("Use louvered-face supply diffusers and fixed-blade returns."));
 assert(text.includes("Draft the existing supply devices shown in these rooms; use nearby like devices for elevation and leave the other work unchanged."));
 assert(!text.includes("native diff receipt"));assert(!text.includes("## Required structure"));
 assert(!profile.baseInstructions.includes("`/revit/create-duct` dryRun first."));
 assert(profile.baseInstructions.includes("honor the user's apply, preview or sample-first intent."));
 assert(text.indexOf("--- prompts/system.md ---")<text.indexOf("--- local-skill "));
});

test("large local instructions remain bounded and disclose truncation while retaining core policies",t=>{
 fixture(t,Object.fromEntries(Array.from({length:20},(_,i)=>[String(i).padStart(2,"0")+".md","Company"+i+" "+"x".repeat(4000)])));
 const text=getSkillLibraryText();assert(text.includes("Company0 "));assert(!text.includes("Company19 "));
 assert.match(text,/…\(truncated\)/);assert.match(text,/--- prompts\/policies\/privacy.md ---/);assert(text.length<26000);
});

test("missing manifest fallback retains reconstruction guidance without developer authoring documents",t=>{
 fixture(t,{"company.md":"Use the company's approved device families."});
 process.env.OPERATOR_SKILL_LIBRARY_MANIFEST="skills/unavailable-manifest.json";
 const text=getSkillLibraryText();
 assert(text.includes("Draft the existing supply devices shown in these rooms; use nearby like devices for elevation and leave the other work unchanged."));
 assert(text.includes("Use the company's approved device families."));
 assert(!text.includes("--- skills/README.md ---"));assert(!text.includes("--- docs/PRIMITIVES_VS_SKILLS.md ---"));
});

test("a fresh workspace reads revised company guidance and default-only profiles contain no local scaffolding",t=>{
 const temp=fixture(t,{});const defaults=getSkillLibraryText();assert(!defaults.includes("--- local-skill "));
 fs.writeFileSync(path.join(process.env.OPERATOR_LOCAL_SKILLS_DIR!,"company.md"),"Keep corner offices on separate zones.");
 process.env.OPERATOR_WORKSPACE_ROOT=path.join(temp,"second");assert(getSkillLibraryText().includes("Keep corner offices on separate zones."));
 fs.writeFileSync(path.join(process.env.OPERATOR_LOCAL_SKILLS_DIR!,"company.md"),"Group interior offices by exposure.");
 process.env.OPERATOR_WORKSPACE_ROOT=path.join(temp,"third");const revised=getSkillLibraryText();
 assert(revised.includes("Group interior offices by exposure."));assert(!revised.includes("Keep corner offices on separate zones."));
});
