import fs from "node:fs";
import path from "node:path";

export function diagnosticId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(value) || value === "." || value === "..") throw new Error("Invalid diagnostic identity.");
  return value;
}

/** Validate real paths as well as lexical paths before following a queued link. */
export function diagnosticFile(root: string, relative: string): string {
  const base = fs.realpathSync(root), candidate = path.resolve(base, relative);
  const inside = (file: string) => {
    const rel = path.relative(base, file);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!inside(candidate)) throw new Error("Diagnostic path leaves workspace.");
  if (fs.existsSync(candidate) && !inside(fs.realpathSync(candidate))) throw new Error("Diagnostic link leaves workspace.");
  return candidate;
}
