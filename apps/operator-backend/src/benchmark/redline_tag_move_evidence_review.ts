import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./files.js";
import {
  evidenceFromRedlineMoveSummary,
  evaluateRedlineTagLiveAdapterReadiness,
  type RedlineTagLiveAdapterEvidence,
  type RedlineTagLiveAdapterReadiness
} from "../redline/tag_live_adapter_contract.js";
import type { RedlineTagWorkflowAction, RedlineTagWorkflowContext, RedlineTagWorkflowPoint } from "../redline/tag_workflow_skill.js";

type JsonMap = Record<string, unknown>;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return undefined;
}

function point(value: unknown): RedlineTagWorkflowPoint | undefined {
  const candidate = asObject(value);
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const z = Number(candidate.z ?? 0);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y, z: Number.isFinite(z) ? z : 0 } : undefined;
}

function numberArray(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0)));
}

function discoveryTagContext(discovery: JsonMap): {
  action: Partial<RedlineTagWorkflowAction>;
  context: RedlineTagWorkflowContext;
  evidence: Partial<RedlineTagLiveAdapterEvidence>;
} {
  const discoveryRoot = asObject(discovery._discovery);
  const candidate = asObject(discoveryRoot.candidateExistingTagMove);
  const tasks = asObject(discovery.tasks);
  const task = asObject(tasks.demo_redline_move_tag);
  const request = asObject(task.request);
  const tag = asObject(request.tag);
  const existingTarget = asObject(request.existingTarget);
  const move = asObject(request.move);
  const headPosition = point(candidate.point);
  const tagId = positiveNumber(candidate.tagId, numberArray(tag.existingTagIds)[0], numberArray(existingTarget.elementIds)[0]);
  const viewId = positiveNumber(candidate.ownerViewId, request.viewId);
  const taggedElementId = positiveNumber(candidate.taggedElementId, numberArray(tag.elementIds)[0], numberArray(existingTarget.taggedElementIds)[0]);
  const displayValue = firstString(candidate.visibleText, existingTarget.expectedTagText);
  const category = firstString(candidate.category, existingTarget.expectedCategory);
  return {
    action: {
      operation: "move",
      target: "tag",
      viewId,
      tagId,
      taggedElementId,
      displayValue,
      moveVector: {
        x: Number(move.vectorX ?? 0.5),
        y: Number(move.vectorY ?? 0),
        z: Number(move.vectorZ ?? 0)
      }
    },
    context: {
      tags: tagId ? [{
        tagId,
        viewId,
        category,
        taggedElementId,
        displayValue,
        headPosition
      }] : []
    },
    evidence: {
      viewId,
      tagId,
      taggedElementId,
      expectedTagText: displayValue,
      expectedCategory: category,
      beforeHeadPosition: headPosition
    }
  };
}

export type RedlineTagMoveEvidenceReviewInput = {
  moveSummaryPath: string;
  outputPath?: string;
  discoveryPath?: string;
  visualGateArtifactPath?: string;
  leaderPreserved?: boolean;
};

export type RedlineTagMoveEvidenceReview = {
  ok: boolean;
  move_summary_path: string;
  discovery_path?: string;
  visual_gate_artifact_path?: string;
  evidence: RedlineTagLiveAdapterEvidence;
  readiness: RedlineTagLiveAdapterReadiness;
};

export function buildRedlineTagMoveEvidenceReview(input: RedlineTagMoveEvidenceReviewInput): RedlineTagMoveEvidenceReview {
  const moveSummaryPath = path.resolve(input.moveSummaryPath);
  if (!fs.existsSync(moveSummaryPath)) throw new Error(`redline move summary not found: ${moveSummaryPath}`);
  const summary = readJson(moveSummaryPath);
  const discovery = input.discoveryPath ? asObject(readJson(path.resolve(input.discoveryPath))) : {};
  const discoveryContext = discoveryTagContext(discovery);
  const evidence = evidenceFromRedlineMoveSummary(summary, {
    ...discoveryContext.evidence,
    visualGateArtifactPath: input.visualGateArtifactPath ? path.resolve(input.visualGateArtifactPath) : undefined,
    leaderPreserved: input.leaderPreserved
  });
  const action: RedlineTagWorkflowAction = {
    operation: "move",
    target: "tag",
    ...discoveryContext.action,
    tagId: evidence.tagId ?? discoveryContext.action.tagId,
    taggedElementId: evidence.taggedElementId ?? discoveryContext.action.taggedElementId,
    viewId: evidence.viewId ?? discoveryContext.action.viewId
  };
  const readiness = evaluateRedlineTagLiveAdapterReadiness(action, discoveryContext.context, evidence);
  return {
    ok: readiness.status === "ready_for_live_dry_run",
    move_summary_path: moveSummaryPath,
    ...(input.discoveryPath ? { discovery_path: path.resolve(input.discoveryPath) } : {}),
    ...(input.visualGateArtifactPath ? { visual_gate_artifact_path: path.resolve(input.visualGateArtifactPath) } : {}),
    evidence,
    readiness
  };
}

export function writeRedlineTagMoveEvidenceReview(input: RedlineTagMoveEvidenceReviewInput & { outputPath: string }): RedlineTagMoveEvidenceReview {
  const result = buildRedlineTagMoveEvidenceReview(input);
  writeJsonFile(path.resolve(input.outputPath), result);
  return result;
}
