import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_APP_SERVER_COMPATIBILITY, evaluateCodexCliVersion, resolveCodexExecutable } from "../codex/app_server_compatibility.js";
import { findRepoRoot } from "./audit_tool_registry.js";

type DirectoryReceipt = { file_count: number; byte_count: number; sha256: string };

export function sortProtocolFiles(root: string, files: string[]): string[] {
  return [...files].sort((a, b) => {
    const left = path.relative(root, a).replace(/\\/g, "/");
    const right = path.relative(root, b).replace(/\\/g, "/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function canonicalizeProtocolJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeProtocolJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    canonical[key] = canonicalizeProtocolJson(record[key]);
  }
  return canonical;
}

function hashDirectory(root: string): DirectoryReceipt {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  const orderedFiles = sortProtocolFiles(root, files);
  const hash = createHash("sha256");
  let byteCount = 0;
  for (const filePath of orderedFiles) {
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    const data = fs.readFileSync(filePath);
    hash.update(`${relativePath}\n`, "utf8");
    if (path.extname(filePath).toLowerCase() === ".json") {
      hash.update(JSON.stringify(canonicalizeProtocolJson(JSON.parse(data.toString("utf8")))), "utf8");
    } else {
      hash.update(data);
    }
    byteCount += data.length;
  }
  return { file_count: orderedFiles.length, byte_count: byteCount, sha256: hash.digest("hex") };
}

function runCodex(codexBin: string, args: string[]): string {
  const result = spawnSync(codexBin, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    shell: false,
    timeout: 120_000
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Codex command failed (${args.join(" ")}): ${output}`);
  return output;
}

function assertReceipt(label: string, actual: DirectoryReceipt, expected: DirectoryReceipt): void {
  if (actual.file_count !== expected.file_count || actual.byte_count !== expected.byte_count || actual.sha256 !== expected.sha256) {
    throw new Error(`${label} protocol snapshot mismatch. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

function runCli(): void {
  const codexBin = resolveCodexExecutable(process.env.OPERATOR_CODEX_BIN, process.platform, process.env);
  const version = evaluateCodexCliVersion(runCodex(codexBin, ["--version"]), process.env);
  const repoRoot = findRepoRoot(process.cwd());
  const generatedRootArg = process.argv.indexOf("--generated-root");
  const generatedRoot = path.resolve(generatedRootArg >= 0 && process.argv[generatedRootArg + 1]
    ? process.argv[generatedRootArg + 1]!
    : path.join(repoRoot, "local-work", `codex-app-server-${CODEX_APP_SERVER_COMPATIBILITY.codex_cli_version}`));
  const tsRoot = path.join(generatedRoot, "ts");
  const schemaRoot = path.join(generatedRoot, "json-schema");
  if (!fs.existsSync(tsRoot) && !fs.existsSync(schemaRoot)) {
    fs.mkdirSync(generatedRoot, { recursive: true });
    runCodex(codexBin, ["app-server", "generate-ts", "--experimental", "--out", tsRoot]);
    runCodex(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", schemaRoot]);
  }
  if (!fs.existsSync(tsRoot) || !fs.existsSync(schemaRoot)) throw new Error(`Both generated protocol directories are required under ${generatedRoot}.`);
  const typescript = hashDirectory(tsRoot);
  const jsonSchema = hashDirectory(schemaRoot);
  assertReceipt("TypeScript", typescript, CODEX_APP_SERVER_COMPATIBILITY.generated_typescript);
  assertReceipt("JSON Schema", jsonSchema, CODEX_APP_SERVER_COMPATIBILITY.generated_json_schema);
  console.log(JSON.stringify({ ok: true, version, generated_root: generatedRoot, typescript, json_schema: jsonSchema }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
}
