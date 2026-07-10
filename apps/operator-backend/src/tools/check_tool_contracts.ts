import fs from "node:fs";
import path from "node:path";

type ToolKey = `${"GET" | "POST"} ${string}`;

function fail(msg: string): never {
  throw new Error(msg);
}

function findRepoRoot(startDir: string): string {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const directLayout =
      fs.existsSync(path.join(cur, "operator-backend", "src", "allowlist.ts")) &&
      fs.existsSync(path.join(cur, "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs")) &&
      fs.existsSync(path.join(cur, "revit-bridge-addin", "RevitBridge", "Tooling", "tool_examples.json"));
    const appsLayout =
      fs.existsSync(path.join(cur, "apps", "operator-backend", "src", "allowlist.ts")) &&
      fs.existsSync(path.join(cur, "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs")) &&
      fs.existsSync(path.join(cur, "apps", "revit-bridge-addin", "RevitBridge", "Tooling", "tool_examples.json"));
    if (directLayout || appsLayout) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir, "..");
}

function parseAllowlistKeys(filePath: string): { keys: Set<ToolKey>; duplicates: ToolKey[] } {
  const txt = fs.readFileSync(filePath, "utf8");
  const out = new Set<ToolKey>();
  const dupes: ToolKey[] = [];

  let mode: "GET" | "POST" | null = null;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("GET: new Set([")) mode = "GET";
    else if (line.startsWith("POST: new Set([")) mode = "POST";
    else if (mode && line.startsWith("])")) mode = null;

    if (!mode) continue;
    for (const m of line.matchAll(/"([^"]+)"/g)) {
      const p = m[1] ?? "";
      if (!p.startsWith("/revit/")) continue;
      const key = `${mode} ${p}` as ToolKey;
      if (out.has(key)) dupes.push(key);
      out.add(key);
    }
  }
  return { keys: out, duplicates: dupes };
}

function parseManifestKeys(filePath: string): { keys: Set<ToolKey>; duplicates: ToolKey[] } {
  const txt = fs.readFileSync(filePath, "utf8");
  const out = new Set<ToolKey>();
  const dupes: ToolKey[] = [];
  for (const m of txt.matchAll(/new OperatorToolInfo\("[^"]+",\s*"(GET|POST)",\s*"([^"]+)"/g)) {
    const method = (m[1] ?? "").toUpperCase();
    const p = m[2] ?? "";
    if ((method !== "GET" && method !== "POST") || !p.startsWith("/revit/")) continue;
    const key = `${method} ${p}` as ToolKey;
    if (out.has(key)) dupes.push(key);
    out.add(key);
  }
  return { keys: out, duplicates: dupes };
}

function parseExamplesKeys(filePath: string): { keys: Set<ToolKey>; duplicates: ToolKey[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as any;
  const tools = Array.isArray(raw?.tools) ? raw.tools : [];
  const out = new Set<ToolKey>();
  const dupes: ToolKey[] = [];
  for (const t of tools) {
    const method = String(t?.method ?? "GET").toUpperCase();
    const p = String(t?.path ?? "");
    if ((method !== "GET" && method !== "POST") || !p.startsWith("/revit/")) continue;
    const key = `${method} ${p}` as ToolKey;
    if (out.has(key)) dupes.push(key);
    out.add(key);
  }
  return { keys: out, duplicates: dupes };
}

function diff(a: Set<ToolKey>, b: Set<ToolKey>): ToolKey[] {
  return [...a].filter(k => !b.has(k)).sort();
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function main(): void {
  const repoRoot = findRepoRoot(process.cwd());
  const appsLayout = fs.existsSync(path.join(repoRoot, "apps", "operator-backend", "src", "allowlist.ts"));
  const backendRoot = appsLayout ? path.join(repoRoot, "apps", "operator-backend") : path.join(repoRoot, "operator-backend");
  const addinRoot = appsLayout ? path.join(repoRoot, "apps", "revit-bridge-addin") : path.join(repoRoot, "revit-bridge-addin");
  const allowlistPath = path.join(backendRoot, "src", "allowlist.ts");
  const manifestPath = path.join(addinRoot, "RevitBridge", "Operator", "OperatorToolManifest.cs");
  const examplesPath = path.join(addinRoot, "RevitBridge", "Tooling", "tool_examples.json");

  const allow = parseAllowlistKeys(allowlistPath);
  const manifest = parseManifestKeys(manifestPath);
  const examples = parseExamplesKeys(examplesPath);
  const requireExampleCoverage = parseBool(process.env.OPERATOR_TOOL_CONTRACT_REQUIRE_EXAMPLES, true);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (allow.duplicates.length > 0) errors.push(`allowlist duplicates (${allow.duplicates.length}): ${allow.duplicates.join(", ")}`);
  if (manifest.duplicates.length > 0) errors.push(`manifest duplicates (${manifest.duplicates.length}): ${manifest.duplicates.join(", ")}`);
  if (examples.duplicates.length > 0) errors.push(`tool_examples duplicates (${examples.duplicates.length}): ${examples.duplicates.join(", ")}`);

  const allowNotManifest = diff(allow.keys, manifest.keys);
  if (allowNotManifest.length > 0) {
    errors.push(
      `allowlist entries missing from OperatorToolManifest (${allowNotManifest.length}):\n` +
        allowNotManifest.map(x => `  - ${x}`).join("\n")
    );
  }

  const manifestNotAllow = diff(manifest.keys, allow.keys);
  if (manifestNotAllow.length > 0) {
    errors.push(
      `OperatorToolManifest entries missing from allowlist (${manifestNotAllow.length}):\n` +
        manifestNotAllow.map(x => `  - ${x}`).join("\n")
    );
  }

  const examplesNotManifest = diff(examples.keys, manifest.keys);
  if (examplesNotManifest.length > 0) {
    errors.push(
      `tool_examples entries missing from OperatorToolManifest (${examplesNotManifest.length}):\n` +
        examplesNotManifest.map(x => `  - ${x}`).join("\n")
    );
  }

  const examplesNotAllow = diff(examples.keys, allow.keys);
  if (examplesNotAllow.length > 0) {
    errors.push(
      `tool_examples entries missing from allowlist (${examplesNotAllow.length}):\n` +
        examplesNotAllow.map(x => `  - ${x}`).join("\n")
    );
  }

  const allowMissingExamples = diff(allow.keys, examples.keys);
  if (allowMissingExamples.length > 0) {
    const msg =
      `allowlisted endpoints without tool_examples (${allowMissingExamples.length}).\n` +
      allowMissingExamples.map(x => `  - ${x}`).join("\n");
    if (requireExampleCoverage) errors.push(msg);
    else warnings.push(msg);
  }

  console.log(
    [
      "Tool contract summary:",
      `- allowlist entries: ${allow.keys.size}`,
      `- manifest entries: ${manifest.keys.size}`,
      `- tool_examples entries: ${examples.keys.size}`
    ].join("\n")
  );

  if (warnings.length > 0) {
    console.warn("\nWarnings:");
    for (const w of warnings) console.warn(`- ${w}`);
  }

  if (errors.length > 0) {
    fail(`\nTool contract checks failed:\n${errors.join("\n\n")}`);
  }

  console.log("Tool contract checks passed.");
}

main();
