import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { GoalRecord } from "../goals/service.js";
import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { ensureWorkspaceLayout, resolveFileUnderWorkspace } from "../workspace.js";
import { readLatestVerifiedWorkPacket } from "../work_packets/store.js";
import type { PersistedWorkReturn, WorkReturnV1 } from "./contract.js";
import { generateWorkReturn, renderWorkReturnMarkdown, verifyWorkReturnHash } from "./generator.js";

function directory(assignmentId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(assignmentId)) throw new Error("Assignment id is unsafe for Work Return persistence.");
  return resolveFileUnderWorkspace(path.posix.join("artifacts", "goals", assignmentId, "work-returns"));
}

function writeImmutable(filePath: string, bytes: Buffer): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, bytes, { flag: "wx", mode: 0o600 });
    try { fs.linkSync(tempPath, filePath); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!fs.readFileSync(filePath).equals(bytes)) throw new Error("Immutable Work Return collision.");
      return false;
    }
  } finally { try { fs.rmSync(tempPath, { force: true }); } catch {} }
}

function readAll(assignmentId: string): WorkReturnV1[] {
  const root = directory(assignmentId);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(name => /^wr1_[A-Za-z0-9_-]{32}\.json$/.test(name)).flatMap(name => {
    try {
      const workReturn = JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as WorkReturnV1;
      return verifyWorkReturnHash(workReturn) && workReturn.assignment_id === assignmentId ? [workReturn] : [];
    } catch { return []; }
  }).sort((left, right) => left.created_at.localeCompare(right.created_at) || left.work_return_id.localeCompare(right.work_return_id));
}

function relative(filePath: string): string {
  return path.relative(ensureWorkspaceLayout().root, filePath).split(path.sep).join("/");
}

function sourceEquivalent(left: WorkReturnV1, right: WorkReturnV1): boolean {
  const strip = (value: WorkReturnV1) => {
    const { work_return_id: _id, work_return_hash: _hash, parent_work_return_id: _parent, ...body } = value;
    return JSON.stringify(body);
  };
  return strip(left) === strip(right);
}

export function persistWorkReturn(goal: GoalRecord, canonicalSnapshotV2?: AssignmentSnapshotV2): PersistedWorkReturn {
  const existing = readAll(goal.id);
  let packet = null;
  try { packet = readLatestVerifiedWorkPacket(goal, canonicalSnapshotV2).packet; } catch {}
  const unparented = generateWorkReturn(goal, null, packet, canonicalSnapshotV2);
  const equivalent = [...existing].reverse().find(candidate => sourceEquivalent(candidate, unparented));
  const workReturn = equivalent ?? generateWorkReturn(goal, existing.at(-1)?.work_return_id ?? null, packet, canonicalSnapshotV2);
  const root = directory(goal.id);
  const jsonPath = path.join(root, `${workReturn.work_return_id}.json`);
  const markdownPath = path.join(root, `${workReturn.work_return_id}.md`);
  const createdJson = writeImmutable(jsonPath, Buffer.from(`${JSON.stringify(workReturn, null, 2)}\n`, "utf8"));
  const createdMarkdown = writeImmutable(markdownPath, Buffer.from(renderWorkReturnMarkdown(workReturn), "utf8"));
  return { work_return: workReturn, json_path: relative(jsonPath), markdown_path: relative(markdownPath), created: createdJson || createdMarkdown };
}

export function readLatestWorkReturn(goal: GoalRecord, canonicalSnapshotV2?: AssignmentSnapshotV2): PersistedWorkReturn {
  return persistWorkReturn(goal, canonicalSnapshotV2);
}

export function listWorkReturns(assignmentId: string): WorkReturnV1[] {
  return readAll(assignmentId);
}
