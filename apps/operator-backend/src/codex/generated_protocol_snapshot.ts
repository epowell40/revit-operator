import fs from "node:fs";
import path from "node:path";

export const CODEX_LIFECYCLE_TYPE_ROOTS = Object.freeze([
  "InitializeParams.ts",
  "InitializeResponse.ts",
  "v2/ThreadStartParams.ts",
  "v2/ThreadStartResponse.ts",
  "v2/ThreadResumeParams.ts",
  "v2/ThreadResumeResponse.ts",
  "v2/TurnStartParams.ts",
  "v2/TurnStartResponse.ts",
  "v2/TurnInterruptParams.ts",
  "v2/TurnInterruptResponse.ts",
  "v2/TurnCompletedNotification.ts"
]);

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}
function canonicalGeneratedSource(data: Buffer): string {
  return data.toString("utf8").replace(/\r\n/g, "\n");
}


function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(normalizeRelative(path.relative(root, fullPath)));
    }
  };
  visit(root);
  return files.sort();
}

export function collectGeneratedLifecycleTypeFiles(generatedTypesRoot: string): string[] {
  const root = path.resolve(generatedTypesRoot);
  const queue = [...CODEX_LIFECYCLE_TYPE_ROOTS];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const relativePath = normalizeRelative(queue.shift()!);
    if (seen.has(relativePath)) continue;
    const filePath = path.resolve(root, relativePath);
    const rootPrefix = `${root}${path.sep}`;
    if (filePath !== root && !filePath.startsWith(rootPrefix)) {
      throw new Error(`Generated protocol dependency escaped its root: ${relativePath}`);
    }
    if (!fs.existsSync(filePath)) throw new Error(`Missing generated lifecycle type: ${relativePath}`);
    seen.add(relativePath);
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const dependency = path.resolve(path.dirname(filePath), `${specifier}.ts`);
      queue.push(normalizeRelative(path.relative(root, dependency)));
    }
  }
  return [...seen].sort();
}

export function assertVendoredLifecycleTypes(generatedTypesRoot: string, vendoredTypesRoot: string): number {
  const expected = collectGeneratedLifecycleTypeFiles(generatedTypesRoot);
  const actual = listFiles(vendoredTypesRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(file => !actual.includes(file));
    const extra = actual.filter(file => !expected.includes(file));
    throw new Error(`Vendored lifecycle type set drifted. Missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}.`);
  }
  for (const relativePath of expected) {
    const generated = fs.readFileSync(path.join(generatedTypesRoot, relativePath));
    const vendored = fs.readFileSync(path.join(vendoredTypesRoot, relativePath));
    if (canonicalGeneratedSource(generated) !== canonicalGeneratedSource(vendored)) throw new Error(`Vendored lifecycle type drifted: ${relativePath}`);
  }
  return expected.length;
}
