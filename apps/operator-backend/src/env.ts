import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

let loaded = false;

function tryReadJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isBackendRoot(dir: string): boolean {
  try {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = tryReadJson(pkgPath);
    return pkg?.name === "revit-operator-backend";
  } catch {
    return false;
  }
}

function findBackendRoot(): string {
  const cwd = process.cwd();
  if (isBackendRoot(cwd)) return cwd;

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let cur = here;
    for (let i = 0; i < 8; i++) {
      if (isBackendRoot(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    // ignore
  }

  return cwd;
}

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const root = findBackendRoot();
  const candidates = [path.join(root, ".env"), path.join(root, ".env.local")];

  const parsed: Record<string, string> = {};
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const envText = fs.readFileSync(p, "utf8");
      Object.assign(parsed, dotenv.parse(envText));
    } catch {
      // ignore unreadable env files
    }
  }

  for (const [key, value] of Object.entries(parsed)) {
    const existing = process.env[key];
    if (existing === undefined || existing.trim() === "") {
      process.env[key] = value;
    }
  }
}

loadEnv();
