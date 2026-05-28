import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCodexHomeConfig } from "../src/codex/config.js";

test("codex config writer upserts managed MCP block", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-codexcfg-"));
  const repoRoot = path.join(tmp, "repo");
  const codexHome = path.join(tmp, "codexhome");

  fs.mkdirSync(path.join(repoRoot, "Feature Request"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "operator-backend"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "mcp-server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "mcp-server", "dist", "server.js"), "// stub", "utf8");

  ensureCodexHomeConfig({ codexHome, repoRoot });
  ensureCodexHomeConfig({ codexHome, repoRoot });

  const configPath = path.join(codexHome, "config.toml");
  const txt = fs.readFileSync(configPath, "utf8");
  assert.match(txt, /\[mcp_servers\.revit_operator\]/);
  assert.match(txt, /\[mcp_servers\."revit-operator"\]/);
  assert.match(txt, /env = \{ OPERATOR_WORKSPACE_ROOT = /);
  assert.match(txt, /CODEX_HOME = /);
  assert.match(txt, /BEGIN RevitOperator/);
  assert.match(txt, /END RevitOperator/);
  if (process.platform === "win32") assert.match(txt, /mcp-server\\\\dist\\\\server\.js/);
  else assert.match(txt, /mcp-server\/dist\/server\.js/);

  const beginCount = (txt.match(/BEGIN RevitOperator/g) || []).length;
  assert.equal(beginCount, 1);
});

