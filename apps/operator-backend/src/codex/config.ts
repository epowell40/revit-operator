import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureDir(p: string): void {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

function resolveAppsRoot(candidate: string): string | null {
  const direct = path.resolve(candidate);
  if (fs.existsSync(path.join(direct, "operator-backend")) && fs.existsSync(path.join(direct, "mcp-server"))) return direct;
  const nested = path.join(direct, "apps");
  if (fs.existsSync(path.join(nested, "operator-backend")) && fs.existsSync(path.join(nested, "mcp-server"))) return nested;
  return null;
}

function findRepoRoot(startDir: string): string {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const appsRoot = resolveAppsRoot(cur);
    if (appsRoot) return appsRoot;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  // Fallback: assume we started in operator-backend.
  return path.resolve(startDir, "..");
}

function normalizePathForTomlArg(p: string): string {
  const normalized = path.normalize(p);
  if (process.platform === "win32") return normalized.replace(/\//g, "\\");
  return normalized.replace(/\\/g, "/");
}

function renderMcpServerBlock(opts: { repoRoot: string; workspaceRoot: string; codexHome: string }): string {
  const serverJs = normalizePathForTomlArg(path.join(opts.repoRoot, "mcp-server", "dist", "server.js"));
  const serverCwd = normalizePathForTomlArg(path.dirname(path.dirname(serverJs)));
  const workspaceRoot = normalizePathForTomlArg(opts.workspaceRoot);
  const codexHome = normalizePathForTomlArg(opts.codexHome);
  const requestedTransport = (process.env.OPERATOR_REVIT_TRANSPORT || "direct").trim().toLowerCase();
  const transport = requestedTransport === "courier" ? "courier" : "direct";
  const envInline = `env = { OPERATOR_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)}, CODEX_HOME = ${JSON.stringify(codexHome)}, OPERATOR_REVIT_TRANSPORT = ${JSON.stringify(transport)} }`;
  return [
    "# BEGIN RevitOperator (managed)",
    "# The embedded app-server receives Operator tools through thread/start.dynamicTools.",
    "# Keep this definition disabled so Codex does not add a second approval layer around the same MCP runtime.",
    "[mcp_servers.revit_operator]",
    "enabled = false",
    "command = \"node\"",
    `args = [${JSON.stringify(serverJs)}]`,
    `cwd = ${JSON.stringify(serverCwd)}`,
    envInline,
    "startup_timeout_sec = 20",
    // Codex defaults tool_timeout_sec=60. Revit exports + family reloads can exceed that.
    "tool_timeout_sec = 240",
    "# Inherit environment (OPERATOR_TOKEN is read from the Workspace token file as well).",
    "# END RevitOperator (managed)",
    ""
  ].join("\n");
}

function upsertManagedBlock(existing: string, block: string): string {
  const begin = "# BEGIN RevitOperator (managed)";
  const end = "# END RevitOperator (managed)";
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b >= 0 && e > b) {
    const afterEnd = existing.indexOf("\n", e);
    const tail = afterEnd >= 0 ? existing.slice(afterEnd + 1) : "";
    return (existing.slice(0, b) + block + tail).trimEnd() + "\n";
  }
  const trimmed = existing.trimEnd();
  if (!trimmed) return block;
  return trimmed + "\n\n" + block;
}

export function ensureCodexHomeConfig(opts: { codexHome: string; repoRoot?: string }): void {
  const codexHome = path.resolve(opts.codexHome);
  ensureDir(codexHome);

  const requestedRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : findRepoRoot(process.cwd());
  const repoRoot = resolveAppsRoot(requestedRoot) ?? requestedRoot;
  const workspaceRoot = path.resolve(codexHome, "..");
  const configPath = path.join(codexHome, "config.toml");

  let existing = "";
  try {
    existing = fs.readFileSync(configPath, "utf8");
  } catch {
    existing = "";
  }

  const block = renderMcpServerBlock({ repoRoot, workspaceRoot, codexHome });
  const next = upsertManagedBlock(existing, block);

  try {
    fs.writeFileSync(configPath, next, "utf8");
  } catch {
    // ignore
  }
}

export function ensureCodexHomeAuth(opts: { codexHome: string }): void {
  try {
    ensureDir(opts.codexHome);
    const dst = path.join(opts.codexHome, "auth.json");
    const defaultHome = path.join(os.homedir(), ".codex");
    const src = path.join(defaultHome, "auth.json");
    if (!fs.existsSync(src)) return;

    const srcStat = fs.statSync(src);
    const dstStat = fs.existsSync(dst) ? fs.statSync(dst) : null;
    const shouldCopy = !dstStat || srcStat.mtimeMs > dstStat.mtimeMs || srcStat.size !== dstStat.size;
    if (!shouldCopy) return;

    fs.copyFileSync(src, dst);
  } catch {
    // ignore
  }
}
