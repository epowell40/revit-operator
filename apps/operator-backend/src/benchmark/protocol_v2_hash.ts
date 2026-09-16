import crypto from "node:crypto";
import fs from "node:fs";

export { canonicalJson, sha256Value } from "../canonical_json_hash.js";

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a complete SHA-256 digest.`);
  }
}
