import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DYNAMIC_RUNTIME_PACKAGE_IDENTITY_SCHEMA = "dynamic-revit-runtime-package-directory/v1";
export const DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_FILE_COUNT = 256;
export const DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_FILE_BYTES = 256 * 1024 * 1024;
export const DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_TOTAL_BYTES = 512 * 1024 * 1024;
export const DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_RELATIVE_PATH_UTF8_BYTES = 1024;

type IdentityFile = { fullPath: string; relativePath: string };

/** Byte-for-byte compatible with DynamicRuntimePackageDirectoryIdentity.Compute. */
export function computeDynamicRuntimePackageDirectoryIdentity(directory: string): string {
  if (typeof directory !== "string" || !directory.trim()) throw new Error("Runtime package directory is required.");
  const fullRoot = path.resolve(directory); const parsedRoot = path.parse(fullRoot).root;
  const root = fullRoot.replace(/[\\/]+$/, ""); const volumeRoot = parsedRoot.replace(/[\\/]+$/, "");
  if (root.toLowerCase() === volumeRoot.toLowerCase()) throw new Error("A filesystem root may not be used as a runtime package directory.");
  if (!fs.existsSync(root)) throw new Error("Runtime package directory does not exist.");
  rejectReparse(root, "Runtime package root");

  const pending = [root]; const files: IdentityFile[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!; rejectReparse(current, "Runtime package directory");
    for (const name of fs.readdirSync(current)) {
      const fullPath = path.resolve(current, name); ensureContained(root, fullPath); rejectReparse(fullPath, "Runtime package entry");
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) pending.push(fullPath);
      else if (stat.isFile()) {
        files.push({ fullPath, relativePath: relativePath(root, fullPath) });
        if (files.length > DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_FILE_COUNT) throw new Error("Runtime package exceeds the file-count limit.");
      } else throw new Error(`Runtime package contains an unsupported filesystem object: ${relativePath(root, fullPath)}`);
    }
    rejectReparse(current, "Runtime package directory");
  }
  if (files.length === 0) throw new Error("Runtime package identity has no files.");
  const folded = new Set<string>();
  for (const file of files) {
    const key = file.relativePath.toLowerCase();
    if (folded.has(key)) throw new Error(`Runtime package contains an ambiguous relative path: ${file.relativePath}`);
    folded.add(key);
  }

  let totalBytes = 0; let canonical = `${DYNAMIC_RUNTIME_PACKAGE_IDENTITY_SCHEMA}\n`;
  for (const file of files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)) {
    const relativePathBytes = Buffer.byteLength(file.relativePath, "utf8");
    if (relativePathBytes > DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_RELATIVE_PATH_UTF8_BYTES) throw new Error(`Runtime package path exceeds the UTF-8 length limit: ${file.relativePath}`);
    rejectReparse(file.fullPath, "Runtime package file");
    const descriptor = fs.openSync(file.fullPath, "r");
    let length: number; let fileHash: string;
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.size > BigInt(DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_FILE_BYTES)) throw new Error(`Runtime package file exceeds the byte limit: ${file.relativePath}`);
      const bytes = fs.readFileSync(descriptor); const after = fs.fstatSync(descriptor, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || BigInt(bytes.length) !== after.size) throw new Error(`Runtime package file changed while it was being identified: ${file.relativePath}`);
      length = bytes.length; fileHash = createHash("sha256").update(bytes).digest("hex");
    } finally { fs.closeSync(descriptor); }
    rejectReparse(file.fullPath, "Runtime package file");
    totalBytes += length;
    if (totalBytes > DYNAMIC_RUNTIME_PACKAGE_MAXIMUM_TOTAL_BYTES) throw new Error("Runtime package exceeds the aggregate byte limit.");
    canonical += `${relativePathBytes}:${file.relativePath}:${length}:${fileHash}\n`;
  }
  rejectReparse(root, "Runtime package root");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function relativePath(root: string, candidate: string): string {
  ensureContained(root, candidate); return candidate.slice(root.length + 1).replaceAll("\\", "/");
}

function ensureContained(root: string, candidate: string): void {
  const prefix = `${root}${path.sep}`;
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Runtime package entry resolves outside its root.");
}

function rejectReparse(candidate: string, kind: string): void {
  if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`${kind} may not be a reparse point: ${candidate}`);
}
