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

function requireCriticalParity(
  addinRoot: string,
  criticalPaths: string[],
  errors: string[]
): void {
  const sources = [
    {
      label: "native OperatorActionAllowlist",
      file: path.join(addinRoot, "RevitBridge", "Operator", "OperatorActionAllowlist.cs"),
      pattern: (p: string) => new RegExp(`"${escapeRegExp(p)}"`)
    },
    {
      label: "Operator approval policy",
      file: path.join(addinRoot, "RevitBridge", "Operator", "OperatorApprovalPolicy.cs"),
      pattern: (p: string) => new RegExp(`string\\.Equals\\(p,\\s*"${escapeRegExp(p)}"[\\s\\S]{0,180}OperatorActionRisk\\.High`)
    },
    {
      label: "Operator tool introspection",
      file: path.join(addinRoot, "RevitBridge", "Operator", "OperatorToolIntrospection.cs"),
      pattern: (p: string) => new RegExp(`\\{\\s*"${escapeRegExp(p)}",\\s*typeof\\(`)
    },
    {
      label: "Operator action schema",
      file: path.join(addinRoot, "RevitBridge", "Operator", "OperatorActionSchemaValidator.cs"),
      pattern: (p: string) => new RegExp(`string\\.Equals\\(path,\\s*"${escapeRegExp(p)}"`)
    },
    {
      label: "Operator action runtime",
      file: path.join(addinRoot, "RevitBridge", "Operator", "OperatorActionRunner.cs"),
      pattern: (p: string) => new RegExp(`\\{\\s*"${escapeRegExp(p)}",\\s*new\\s+`)
    },
    {
      label: "direct HTTP runtime",
      file: path.join(addinRoot, "RevitBridge", "Server", "RevitHttpServer.cs"),
      pattern: (p: string) => new RegExp(`\\{\\s*"${escapeRegExp(p)}",\\s*new\\s+`)
    },
    {
      label: "logic runtime",
      file: path.join(addinRoot, "RevitBridge.Logic", "LogicService.cs"),
      pattern: (p: string) => new RegExp(`\\{\\s*"${escapeRegExp(p)}",\\s*new\\s+`)
    }
  ];

  for (const source of sources) {
    if (!fs.existsSync(source.file)) {
      errors.push(`${source.label} file is missing: ${source.file}`);
      continue;
    }
    const text = fs.readFileSync(source.file, "utf8");
    const missing = criticalPaths.filter(p => !source.pattern(p).test(text));
    if (missing.length > 0) {
      errors.push(
        `${source.label} is missing critical repair endpoints (${missing.length}):\n` +
          missing.map(p => `  - POST ${p}`).join("\n")
      );
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const criticalRepairPaths = [
    "/revit/connect-existing-mep-branch",
    "/revit/resize-ductwork-by-scope",
    "/revit/repair-duct-continuity-by-scope",
    "/revit/repair-mep-connectors"
  ];

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

  requireCriticalParity(addinRoot, criticalRepairPaths, errors);

  console.log(
    [
      "Tool contract summary:",
      `- allowlist entries: ${allow.keys.size}`,
      `- manifest entries: ${manifest.keys.size}`,
      `- tool_examples entries: ${examples.keys.size}`,
      `- critical four-way parity endpoints: ${criticalRepairPaths.length}`
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
