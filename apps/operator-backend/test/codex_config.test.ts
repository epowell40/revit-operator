import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCodexHomeConfig, prepareCertifiedCodexIsolation } from "../src/codex/config.js";

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
  assert.match(txt, /\[mcp_servers\.revit_operator\]\nenabled = false/);
  assert.equal((txt.match(/\[mcp_servers\./g) || []).length, 1);
  assert.match(txt, /env = \{ OPERATOR_WORKSPACE_ROOT = /);
  assert.match(txt, /CODEX_HOME = /);
  assert.match(txt, /OPERATOR_REVIT_TRANSPORT = "direct"/);
  assert.match(txt, /startup_timeout_sec = 20/);
  assert.doesNotMatch(txt, /cwd = .*dist/);
  assert.match(txt, /BEGIN RevitOperator/);
  assert.match(txt, /END RevitOperator/);
  if (process.platform === "win32") assert.match(txt, /mcp-server\\\\dist\\\\server\.js/);
  else assert.match(txt, /mcp-server\/dist\/server\.js/);

  const beginCount = (txt.match(/BEGIN RevitOperator/g) || []).length;
  assert.equal(beginCount, 1);
});

test("codex config resolves the public apps layout from the repository root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-public-codexcfg-"));
  const publicRoot = path.join(tmp, "public");
  const codexHome = path.join(tmp, "codexhome");
  fs.mkdirSync(path.join(publicRoot, "apps", "operator-backend"), { recursive: true });
  fs.mkdirSync(path.join(publicRoot, "apps", "mcp-server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(publicRoot, "apps", "mcp-server", "dist", "server.js"), "// stub", "utf8");

  ensureCodexHomeConfig({ codexHome, repoRoot: publicRoot });
  const txt = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  if (process.platform === "win32") assert.match(txt, /apps\\\\mcp-server\\\\dist\\\\server\.js/);
  else assert.match(txt, /apps\/mcp-server\/dist\/server\.js/);
});

test("certified Codex startup discards adversarial normal MCP config and runs outside project config ancestry", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-certified-codexcfg-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const normalHome = path.join(workspaceRoot, ".codex");
  const isolationRoot = path.join(tmp, "certified-runtime");
  fs.mkdirSync(normalHome, { recursive: true });
  const fakeMcp = "[mcp_servers.evil]\nenabled = true\ncommand = \"fake-mcp-server\"\n";
  fs.writeFileSync(path.join(normalHome, "config.toml"), fakeMcp, "utf8");

  const isolated = prepareCertifiedCodexIsolation({ workspaceRoot, isolationRoot });
  const certifiedConfigPath = path.join(isolated.codexHome, "config.toml");
  const certifiedConfig = fs.readFileSync(certifiedConfigPath, "utf8");
  assert.notEqual(isolated.codexHome, normalHome);
  assert.ok(path.relative(workspaceRoot, isolated.cwd).startsWith(".."));
  assert.doesNotMatch(certifiedConfig, /mcp_servers|evil|fake-mcp-server/);
  assert.equal(fs.readFileSync(path.join(normalHome, "config.toml"), "utf8"), fakeMcp);

  fs.writeFileSync(certifiedConfigPath, fakeMcp, "utf8");
  const restarted = prepareCertifiedCodexIsolation({ workspaceRoot, isolationRoot });
  assert.equal(restarted.cwd, isolated.cwd);
  assert.doesNotMatch(fs.readFileSync(certifiedConfigPath, "utf8"), /mcp_servers|evil|fake-mcp-server/);
});

