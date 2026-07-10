import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./files.js";

type JsonMap = Record<string, unknown>;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readArtifactObject(filePath: string): JsonMap | null {
  try {
    return asObject(readJsonFile<unknown>(filePath));
  } catch {
    return null;
  }
}

export function resolvePromotionArtifactPath(filePath: string, baseDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir || ".", filePath);
}

export function promotionArtifactExists(filePath: string, baseDir: string): boolean {
  if (!filePath.trim()) return false;
  return fs.existsSync(resolvePromotionArtifactPath(filePath, baseDir));
}

export function writeGrantArtifactActive(filePath: string): boolean {
  const obj = readArtifactObject(filePath);
  if (!obj) return false;
  const nested = asObject(asObject(obj.write_grant_status).body);
  return obj.write_grant_active === true || obj.active === true || nested.active === true;
}

export function preflightArtifactOk(filePath: string): boolean {
  const obj = readArtifactObject(filePath);
  if (!obj) return false;
  const nested = asObject(asObject(obj.write_grant_status).body);
  const writeGrantActive = obj.write_grant_active === true || nested.active === true || obj.require_write_grant !== true;
  return (obj.ok === true || obj.diagnosis === "ok") && writeGrantActive;
}

export function verificationArtifactOk(filePath: string): boolean {
  const obj = readArtifactObject(filePath);
  if (!obj) return false;
  const verifications = Array.isArray(obj.verification_results) ? obj.verification_results.map(asObject) : [];
  if (verifications.length > 0 && verifications.some((entry) => entry.ok !== true)) return false;
  return verifications.length > 0 && verifications.every((entry) => entry.ok === true);
}

export function cleanupOrRevertArtifactOk(filePath: string): boolean {
  const obj = readArtifactObject(filePath);
  if (!obj) return false;
  const cleanupIds = [
    ...(Array.isArray(obj.cleanupDeletedIds) ? obj.cleanupDeletedIds : []),
    ...(Array.isArray(obj.deletedIds) ? obj.deletedIds : []),
    ...(Array.isArray(obj.revertedIds) ? obj.revertedIds : []),
    ...(Array.isArray(obj.revertAppliedIds) ? obj.revertAppliedIds : []),
    ...(Array.isArray(obj.finalRevertedIds) ? obj.finalRevertedIds : [])
  ];
  const rows = Array.isArray(obj.rows) ? obj.rows.map(asObject) : [];
  return obj.finalRestored === true ||
    obj.final_restored === true ||
    obj.reverted === true ||
    (obj.workflowStatus === "success" && obj.revertAfterVerify === true) ||
    cleanupIds.length > 0 ||
    rows.some((row) => /cleanup|revert/i.test(stringValue(row.primitive)) && positiveCleanupStatus(row.status));
}

function positiveCleanupStatus(value: unknown): boolean {
  const status = stringValue(value).trim().toLowerCase();
  return status === "success" ||
    status === "deleted" ||
    status === "reverted" ||
    status === "restored" ||
    status === "applied" ||
    status === "nocreatedelementsgraphicsonly";
}
