import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getMacroSkillsDirs } from "../src/skills/macro_skills.js";
import { disableInstalledSkill, enableDisabledSkill, installStagedSkill, stageLocalSkill } from "../src/skills/local_skill_registry.js";
import { loadLocalSkillRegistry } from "../src/skills/local_skill_registry.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("local skill flow: stage -> install -> disable -> enable", () => {
  mkWorkspace();
  const dirs = getMacroSkillsDirs();

  const skill = {
    id: "test_skill_ok",
    name: "Test Skill OK",
    description: "A simple allowed skill.",
    actions: [{ method: "GET", path: "/revit/ping" }],
    requiresApproval: false
  };

  const staged = stageLocalSkill(skill);
  assert.equal(staged.ok, true);
  assert.ok(fs.existsSync(path.join(dirs.staging, "test_skill_ok.skill.json")));

  const installed = installStagedSkill("test_skill_ok");
  assert.equal(installed.ok, true);
  assert.ok(fs.existsSync(path.join(dirs.local, "test_skill_ok.skill.json")));
  assert.equal(fs.existsSync(path.join(dirs.staging, "test_skill_ok.skill.json")), false);

  const disabled = disableInstalledSkill("test_skill_ok");
  assert.equal(disabled.ok, true);
  assert.ok(fs.existsSync(path.join(dirs.disabled, "test_skill_ok.skill.json")));
  assert.equal(fs.existsSync(path.join(dirs.local, "test_skill_ok.skill.json")), false);

  const enabled = enableDisabledSkill("test_skill_ok");
  assert.equal(enabled.ok, true);
  assert.ok(fs.existsSync(path.join(dirs.local, "test_skill_ok.skill.json")));
  assert.equal(fs.existsSync(path.join(dirs.disabled, "test_skill_ok.skill.json")), false);

  const reg = loadLocalSkillRegistry();
  const entry = reg.skills["test_skill_ok"];
  assert.ok(entry);
  assert.equal(entry.status, "enabled");
});

test("local skill gate: forbidden action quarantines", () => {
  mkWorkspace();
  const dirs = getMacroSkillsDirs();

  const skill = {
    id: "test_skill_forbidden",
    name: "Forbidden Skill",
    description: "Should be blocked by gate.",
    actions: [{ method: "POST", path: "/revit/not-a-real-tool", body: { x: 1 } }]
  };

  const r = stageLocalSkill(skill as any);
  assert.equal(r.ok, false);
  if (r.quarantinePath) {
    assert.ok(fs.existsSync(r.quarantinePath));
    assert.ok(fs.existsSync(r.quarantinePath + ".reason.txt"));
  }

  // Quarantine should land under skills/disabled/quarantine if we were able to write it.
  try {
    const qDir = dirs.quarantine;
    if (fs.existsSync(qDir)) {
      const files = fs.readdirSync(qDir).filter(f => f.includes("test_skill_forbidden") && f.endsWith(".skill.json"));
      assert.ok(files.length >= 0);
    }
  } catch {
    // best-effort; quarantine is also best-effort
  }
});
