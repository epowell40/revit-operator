import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addProjectStandard, formatProjectProfileForPrompt, readProjectProfile } from "../src/memory/project_profile.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  return root;
}

test("project profile saves structured standards and mirrors to memory", () => {
  const root = mkWorkspace();

  const saved = addProjectStandard({
    category: "sheet naming",
    text: "Use M100 series for mechanical floor plans.",
    source: "test",
    session_id: "s1",
    tags: ["mechanical", "sheets"]
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.standard.category, "sheet_naming");
  assert.equal(saved.standard.text, "Use M100 series for mechanical floor plans.");
  assert.ok(fs.existsSync(path.join(root, "memory", "project_profile.json")));
  assert.ok(fs.existsSync(path.join(root, "memory", "longterm.jsonl")));

  const profile = readProjectProfile();
  assert.equal(profile.standards.length, 1);
  assert.equal(profile.standards[0]!.category, "sheet_naming");
});

test("project profile upserts duplicate category/text standards", () => {
  mkWorkspace();

  const first = addProjectStandard({ category: "views", text: "Prefer reflected ceiling plans for lighting work.", source: "test" });
  const second = addProjectStandard({ category: "views", text: "Prefer reflected ceiling plans for lighting work.", source: "test2" });

  assert.equal(first.standard.id, second.standard.id);
  const profile = readProjectProfile();
  assert.equal(profile.standards.length, 1);
  assert.equal(profile.standards[0]!.source, "test2");
});

test("project profile prompt block is explicit and prioritized", () => {
  mkWorkspace();
  addProjectStandard({ category: "titleblocks", text: "Verify titleblock edits on the sheet, not the plan view.", source: "test" });

  const block = formatProjectProfileForPrompt();
  assert.match(block, /PROJECT STANDARDS PROFILE/);
  assert.match(block, /\[PS1\]/);
  assert.match(block, /titleblocks/);
  assert.match(block, /before generic memory/);
});

