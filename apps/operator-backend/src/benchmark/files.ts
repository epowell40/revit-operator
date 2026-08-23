import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function backendRoot(): string {
  const candidate = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  return path.basename(candidate).toLowerCase() === "dist" ? path.dirname(candidate) : candidate;
}

export function repoRoot(): string {
  return path.resolve(backendRoot(), "..");
}

export function benchmarkDataRoot(): string {
  return path.join(backendRoot(), "benchmark");
}

/** Every enclosing Git checkout/worktree that owns backend source. */
export function sourceControlledRoots(start = backendRoot()): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) roots.push(fs.realpathSync.native(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(roots.map(root => path.normalize(root)))];
}

/** Canonicalize existing paths and the nearest existing parent of new output. */
export function canonicalContainmentPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  let existing = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync.native(existing), ...suffix);
}

export function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(canonicalContainmentPath(root), canonicalContainmentPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeJsonFileNew(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

export function writeTextFile(filePath: string, value: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

export function writeTextFileNew(filePath: string, value: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, { encoding: "utf8", flag: "wx" });
}

export function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf8");
}

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function listJsonFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function replaceTemplateTokens(template: string, tokens: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(tokens)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

export function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayStamp(): string {
  return nowIso().slice(0, 10);
}

export function recursiveFindRunJsonFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (entry.isFile() && entry.name === "run.json") out.push(next);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
