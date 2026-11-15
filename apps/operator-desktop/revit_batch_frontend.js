import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const JOB_TYPE_ROOM_VIEW_CAPTURE = "room_view_capture";
export const JOB_TYPE_DELEGATED_REVIT_TASK_BATCH = "delegated_revit_task_batch";

function nowIso() {
  return new Date().toISOString();
}

function trimText(value, max = 400) {
  const text = `${value || ""}`.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

export function normalizeBatchBinding(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const target = row.target_context && typeof row.target_context === "object" ? row.target_context : {};
  const sessionId = trimText(row.session_id || row.sessionId, 200);
  const targetExecutorId = trimText(row.target_executor_id || row.targetExecutorId || target.executor_id, 160);
  const projectFingerprint = trimText(row.project_fingerprint || row.projectFingerprint || target.project_fingerprint, 64).toLowerCase();
  if (!sessionId) throw new Error("session_id is required for Revit batch binding.");
  if (!targetExecutorId) throw new Error("target_executor_id is required for Revit batch binding.");
  if (!/^[a-f0-9]{64}$/.test(projectFingerprint)) throw new Error("project_fingerprint must be a 64-character SHA-256 value.");
  return {
    session_id: sessionId,
    target_executor_id: targetExecutorId,
    project_fingerprint: projectFingerprint,
    target_context: {
      executor_id: targetExecutorId,
      project_fingerprint: projectFingerprint,
      ...(trimText(row.document_title || target.document_title, 512) ? { document_title: trimText(row.document_title || target.document_title, 512) } : {}),
      ...(trimText(row.document_path || target.document_path, 2048) ? { document_path: trimText(row.document_path || target.document_path, 2048) } : {})
    }
  };
}

export function sameBatchBinding(left, right) {
  const a = normalizeBatchBinding(left);
  const b = normalizeBatchBinding(right);
  return a.session_id === b.session_id &&
    a.target_executor_id === b.target_executor_id &&
    a.project_fingerprint === b.project_fingerprint;
}

export function batchBindingPayload(value) {
  return normalizeBatchBinding(value);
}

export function buildBatchSettlementBody(executorId, claimToken, ok, payload, binding) {
  const normalizedExecutorId = trimText(executorId, 160);
  const normalizedClaimToken = trimText(claimToken, 160);
  if (!normalizedExecutorId) throw new Error("executor_id is required for batch settlement.");
  if (!normalizedClaimToken) throw new Error("claim_token is required for batch settlement.");
  return {
    ...batchBindingPayload(binding),
    executor_id: normalizedExecutorId,
    claim_token: normalizedClaimToken,
    ...(ok
      ? { result: payload }
      : { error: payload?.error || "Batch item failed.", result: payload?.result || {} })
  };
}

const BATCH_SETTLEMENT_HANDOFF_VERSION = "revit-operator.batch-settlement-handoff.v1";

function batchSettlementRecordKey(jobId, itemId) {
  return Buffer.from(`${jobId || ""}\0${itemId || ""}`, "utf8").toString("base64url");
}

function batchSettlementStorePath(deps) {
  if (`${deps.settlementStorePath || ""}`.trim()) return path.resolve(`${deps.settlementStorePath}`.trim());
  const workspaceRoot = typeof deps.getWorkspaceRoot === "function" ? `${deps.getWorkspaceRoot() || ""}`.trim() : "";
  const root = workspaceRoot || path.join(os.tmpdir(), "revit-operator");
  return path.join(root, "artifacts", "revit-batch", "batch-settlement-handoff.json");
}

function readBatchSettlementState(storePath) {
  if (!fs.existsSync(storePath)) return { version: BATCH_SETTLEMENT_HANDOFF_VERSION, records: [] };
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (parsed?.version !== BATCH_SETTLEMENT_HANDOFF_VERSION || !Array.isArray(parsed?.records)) {
    throw new Error("Batch settlement handoff is unreadable or has an unsupported version; refusing to claim new work.");
  }
  return parsed;
}

function writeBatchSettlementState(storePath, state) {
  ensureDir(path.dirname(storePath));
  fs.writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function saveBatchSettlementRecord(storePath, record) {
  const state = readBatchSettlementState(storePath);
  const key = batchSettlementRecordKey(record.job_id, record.item_id);
  const existingIndex = state.records.findIndex((entry) => entry?.key === key);
  const nextRecord = {
    ...(existingIndex >= 0 ? state.records[existingIndex] : {}),
    ...record,
    key,
    updated_at: nowIso()
  };
  if (existingIndex >= 0) state.records[existingIndex] = nextRecord;
  else state.records.push(nextRecord);
  writeBatchSettlementState(storePath, state);
  return nextRecord;
}

function isConfirmedBatchCompletion(response, record) {
  const item = response?.item;
  if (response?.ok !== true || !item || `${item.status || ""}`.trim().toLowerCase() !== "succeeded") return false;
  const responseItemId = `${item.id || ""}`.trim();
  return !responseItemId || responseItemId === record.item_id;
}

function slugifyText(value, fallback = "batch-job") {
  const cleaned = `${value || ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function sanitizeFileName(value, fallback = "capture") {
  let text = `${value || ""}`.trim();
  if (!text) text = fallback;
  text = text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  text = text.replace(/[. ]+$/g, "").trim();
  if (!text) text = fallback;
  if (text.length > 180) text = text.slice(0, 180).trim();
  return text || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringList(value, max = 200) {
  return asArray(value)
    .map((item) => `${item || ""}`.trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseRoomNumbers(value) {
  if (Array.isArray(value)) return asStringList(value, 500);
  const text = `${value || ""}`.trim();
  if (!text) return [];
  return [...new Set(
    text
      .split(/[\s,;\n\r]+/g)
      .map((item) => item.trim())
      .filter(Boolean)
  )].slice(0, 500);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function resolveWorkspaceFile(workspaceRoot, rawPath) {
  const text = `${rawPath || ""}`.trim();
  if (!text) return null;
  if (path.isAbsolute(text) && fs.existsSync(text)) return text;
  const candidate = path.resolve(workspaceRoot, text);
  return fs.existsSync(candidate) ? candidate : null;
}

function normalizeRelativeArtifactPath(workspaceRoot, rawValue, fallback) {
  const raw = `${rawValue || ""}`.trim().replace(/\\/g, "/");
  const normalized = raw.replace(/^\/+/, "");
  const candidate = normalized || fallback;
  if (!candidate) throw new Error("A relative artifact path is required.");
  const fullPath = path.resolve(workspaceRoot, candidate);
  const resolvedRoot = path.resolve(workspaceRoot);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (fullPath !== resolvedRoot && !fullPath.startsWith(prefix)) {
    throw new Error("Artifact path must stay inside the local workspace.");
  }
  return path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");
}

export function listDefaultBatchTemplates() {
  return [
    {
      job_type: JOB_TYPE_DELEGATED_REVIT_TASK_BATCH,
      title: "Run a repeated Revit task across a scope",
      description: "Plan a worklist for a repeated Revit task, preview a few items, then run each item through the deterministic delegated Revit lane with resumable job control.",
      task_prompt: "",
      scope_description: "",
      work_item_hint: "",
      preview_count: 3,
      max_items: 50,
      per_item_max_rounds: 8
    },
    {
      job_type: JOB_TYPE_ROOM_VIEW_CAPTURE,
      title: "Capture room discipline screenshots",
      description: "Resolve a plan view for each room, export the image, and file it with a deterministic name.",
      view_name_hint: "coord",
      image_size: 2048,
      file_name_pattern: "{roomNumber}_{viewName}",
      output_folder_relative: "artifacts/revit-batch/exports/room-captures",
      sample_count: 3,
      max_rooms: 200
    }
  ];
}

function normalizeRoomViewCaptureParams(getWorkspaceRoot, input = {}) {
  const workspaceRoot = getWorkspaceRoot();
  const sampleCount = Math.max(1, Math.min(10, Number.parseInt(`${input.sample_count ?? input.sampleCount ?? 3}`, 10) || 3));
  const maxRooms = Math.max(1, Math.min(500, Number.parseInt(`${input.max_rooms ?? input.maxRooms ?? 200}`, 10) || 200));
  const imageSize = Math.max(400, Math.min(8000, Number.parseInt(`${input.image_size ?? input.imageSize ?? 2048}`, 10) || 2048));
  const title = trimText(input.title || "Capture room discipline screenshots", 160);
  const outputFolderRelative = normalizeRelativeArtifactPath(
    workspaceRoot,
    input.output_folder_relative ?? input.outputFolderRelative,
    `artifacts/revit-batch/exports/${slugifyText(title, "room-captures")}`
  );
  return {
    title,
    room_numbers: parseRoomNumbers(input.room_numbers ?? input.roomNumbers ?? input.room_numbers_csv ?? input.roomNumbersCsv),
    level_name: trimText(input.level_name ?? input.levelName, 160),
    room_name_includes: asStringList(input.room_name_includes ?? input.roomNameIncludes, 24),
    view_name_hint: trimText(input.view_name_hint ?? input.viewNameHint, 120),
    image_size: imageSize,
    file_name_pattern: trimText((input.file_name_pattern ?? input.fileNamePattern ?? "{roomNumber}_{viewName}"), 200),
    output_folder_relative: outputFolderRelative,
    sample_count: sampleCount,
    max_rooms: maxRooms,
    success_checks: asStringList(input.success_checks ?? input.successChecks, 12)
  };
}

function normalizeDelegatedBatchParams(input = {}) {
  const title = trimText(input.title || "Run a repeated Revit task across a scope", 160);
  const previewCount = Math.max(1, Math.min(10, Number.parseInt(`${input.preview_count ?? input.previewCount ?? 3}`, 10) || 3));
  const maxItems = Math.max(1, Math.min(300, Number.parseInt(`${input.max_items ?? input.maxItems ?? 50}`, 10) || 50));
  const perItemMaxRounds = Math.max(1, Math.min(24, Number.parseInt(`${input.per_item_max_rounds ?? input.perItemMaxRounds ?? 8}`, 10) || 8));
  return {
    title,
    description: trimText(input.description || "", 800),
    task_prompt: trimText((input.task_prompt ?? input.taskPrompt ?? ""), 4000),
    scope_description: trimText((input.scope_description ?? input.scopeDescription ?? ""), 2000),
    work_item_hint: trimText((input.work_item_hint ?? input.workItemHint ?? ""), 800),
    preview_count: previewCount,
    max_items: maxItems,
    per_item_max_rounds: perItemMaxRounds,
    success_checks: asStringList(input.success_checks ?? input.successChecks, 12)
  };
}

function dedupeRooms(rows) {
  const seen = new Set();
  const out = [];
  for (const row of asArray(rows)) {
    if (!row || typeof row !== "object") continue;
    const id = Number.parseInt(`${row.id ?? 0}`, 10);
    const roomNumber = `${row.number || ""}`.trim();
    const key = id > 0 ? `id:${id}` : roomNumber ? `num:${roomNumber.toUpperCase()}` : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      number: roomNumber,
      name: `${row.name || ""}`.trim(),
      level: `${row.level || ""}`.trim(),
      spatialKind: `${row.spatialKind || row.spatial_kind || ""}`.trim()
    });
  }
  return out;
}

function passesRoomNameFilter(room, filters) {
  const filterList = asStringList(filters, 24).map((item) => item.toLowerCase());
  if (filterList.length === 0) return true;
  const haystack = `${room?.name || ""}`.toLowerCase();
  return filterList.some((token) => haystack.includes(token));
}

async function fetchCandidateRooms(readBackendJson, params) {
  const byNumber = params.room_numbers;
  const roomRows = [];
  if (byNumber.length > 0) {
    for (const roomNumber of byNumber) {
      const rows = await readBackendJson("/revit/rooms", {
        method: "POST",
        body: JSON.stringify({
          action: "list",
          roomNumber,
          max: 20
        })
      });
      roomRows.push(...asArray(rows));
    }
  } else {
    const rows = await readBackendJson("/revit/rooms", {
      method: "POST",
      body: JSON.stringify({
        action: "list",
        levelName: params.level_name || undefined,
        max: params.max_rooms
      })
    });
    roomRows.push(...asArray(rows));
  }

  return dedupeRooms(roomRows)
    .filter((room) => passesRoomNameFilter(room, params.room_name_includes))
    .slice(0, params.max_rooms);
}

function deriveOutputRelativePath(job, item, extension) {
  const pattern = `${job?.params?.file_name_pattern || "{roomNumber}_{viewName}"}`.trim() || "{roomNumber}_{viewName}";
  const rendered = pattern
    .replace(/\{index\}/g, `${item.index}`)
    .replace(/\{roomNumber\}/g, `${item.room_number || ""}`)
    .replace(/\{roomName\}/g, `${item.room_name || ""}`)
    .replace(/\{levelName\}/g, `${item.level_name || ""}`)
    .replace(/\{viewName\}/g, `${item.view_name || ""}`)
    .replace(/\{viewId\}/g, `${item.view_id || ""}`)
    .replace(/\{jobId\}/g, `${job.id || ""}`);
  return path.posix.join(job.output_folder_relative, `${sanitizeFileName(rendered, `room-${item.index}`)}${extension || ".png"}`);
}

function buildPreviewItem(job, item) {
  return {
    index: item?.index,
    room_number: `${item?.room_number || ""}`.trim(),
    room_name: `${item?.room_name || ""}`.trim(),
    level_name: `${item?.level_name || ""}`.trim(),
    view_id: item?.view_id || null,
    view_name: `${item?.view_name || ""}`.trim(),
    expected_output_relative_path: item?.view_id ? deriveOutputRelativePath(job, item, ".png") : "",
    status: `${item?.status || "pending"}`.trim(),
    error: `${item?.error || ""}`.trim()
  };
}

function buildDelegatedPreviewItem(item) {
  return {
    index: item?.index,
    label: `${item?.label || ""}`.trim(),
    item_key: `${item?.item_key || ""}`.trim(),
    task_preview: trimText(item?.task_prompt || "", 220),
    status: `${item?.status || "pending"}`.trim(),
    error: `${item?.error || ""}`.trim()
  };
}

export async function planRoomViewCaptureBatchInput(input = {}, deps) {
  const params = normalizeRoomViewCaptureParams(deps.getWorkspaceRoot, input);
  const rooms = await fetchCandidateRooms(deps.readBackendJson, params);
  if (rooms.length === 0) {
    throw new Error("No rooms matched the requested batch scope.");
  }
  const items = [];
  const planningWarnings = [];
  for (const room of rooms) {
    const item = {
      id: `${Date.now()}-${items.length + 1}-${Math.random().toString(16).slice(2)}`,
      index: items.length + 1,
      room_id: room.id || null,
      room_number: room.number || "",
      room_name: room.name || "",
      level_name: room.level || "",
      view_id: null,
      view_name: "",
      view_type: "",
      status: "pending",
      error: "",
      output_relative_path: ""
    };
    try {
      const resolved = await deps.readBackendJson("/revit/resolve-room-plan-view", {
        method: "POST",
        body: JSON.stringify({
          roomNumber: room.number,
          ...(params.view_name_hint ? { preferViewNameContains: params.view_name_hint } : {}),
          maxCandidates: 6
        })
      });
      item.view_id = Number.parseInt(`${resolved?.bestViewId ?? 0}`, 10) || null;
      item.view_name = `${resolved?.bestViewName || ""}`.trim();
      item.view_type = `${resolved?.bestViewType || ""}`.trim();
      if (!item.view_id) {
        item.status = "failed";
        item.error = "No plan view could be resolved for this room.";
      }
    } catch (error) {
      item.status = "failed";
      item.error = trimText(error instanceof Error ? error.message : String(error), 220);
      planningWarnings.push(`${room.number || room.name || `room-${item.index}`}: ${item.error}`);
    }
    items.push(item);
  }
  const previewItems = items.slice(0, params.sample_count).map((item) => buildPreviewItem({ params, output_folder_relative: params.output_folder_relative }, item));
  return {
    job_type: JOB_TYPE_ROOM_VIEW_CAPTURE,
    title: params.title,
    params,
    preview_items: previewItems,
    items,
    result: {
      preview_items: previewItems,
      planning_warnings: planningWarnings,
      matched_room_count: items.length,
      failed_to_plan_count: items.filter((item) => item.status === "failed").length
    },
    approval: {
      required: true,
      sample_count: params.sample_count
    },
    output_folder_relative: params.output_folder_relative,
    executor_kind: "revit_delegate"
  };
}

export async function planDelegatedBatchInput(input = {}, deps) {
  const params = normalizeDelegatedBatchParams(input);
  if (!params.task_prompt) throw new Error("A generic delegated batch job requires task_prompt.");
  const planned = await deps.planDelegatedBatch(params);
  const workItems = asArray(planned?.work_items).slice(0, params.max_items);
  if (workItems.length === 0) {
    throw new Error(trimText(planned?.planner_summary || "The planner did not produce any runnable work items.", 320));
  }
  const items = workItems.map((item, index) => ({
    id: `${Date.now()}-${index + 1}-${Math.random().toString(16).slice(2)}`,
    index: index + 1,
    label: trimText(item?.label || item?.title || `Item ${index + 1}`, 160),
    item_key: trimText(item?.item_key || item?.itemKey || "", 120),
    task_prompt: trimText(item?.task_prompt || item?.taskPrompt || "", 4000),
    status: "pending",
    error: "",
    result_summary: "",
    assistant_message: "",
    artifact_paths: asStringList(item?.artifact_paths ?? item?.artifactPaths, 12),
    planning_note: trimText(item?.planning_note || item?.planningNote || "", 240)
  })).filter((item) => item.task_prompt);
  if (items.length === 0) {
    throw new Error("The planner returned items, but none contained a runnable task prompt.");
  }
  const previewItems = items.slice(0, params.preview_count).map((item) => buildDelegatedPreviewItem(item));
  return {
    job_type: JOB_TYPE_DELEGATED_REVIT_TASK_BATCH,
    title: trimText(planned?.title || params.title, 160),
    params,
    preview_items: previewItems,
    items,
    result: {
      planner_summary: trimText(planned?.planner_summary || planned?.summary || "", 1200),
      strategy_summary: trimText(planned?.strategy_summary || "", 1200),
      planning_warnings: asStringList(planned?.warnings, 20),
      matched_item_count: items.length,
      truncated_to_max_items: asArray(planned?.work_items).length > items.length || asArray(planned?.work_items).length > params.max_items
    },
    approval: {
      required: true,
      sample_count: params.preview_count
    },
    output_folder_relative: trimText(input.output_folder_relative, 300),
    executor_kind: "revit_delegate"
  };
}

export async function executeRoomViewCaptureBatchItem(job, item, deps) {
  const response = await deps.readBackendJson("/revit/export-image", {
    method: "POST",
    body: JSON.stringify({
      viewId: item.view_id,
      imageSize: job?.params?.image_size || 2048
    })
  });
  const rawPath = `${response?.path || ""}`.trim();
  const workspaceRoot = deps.getWorkspaceRoot();
  const sourceFullPath = resolveWorkspaceFile(workspaceRoot, rawPath);
  if (!sourceFullPath) {
    throw new Error(`Exported image could not be found locally: ${rawPath || "missing path"}`);
  }
  const extension = path.extname(sourceFullPath) || ".png";
  const relativeOutputPath = deriveOutputRelativePath(job, item, extension);
  const destinationFullPath = path.resolve(workspaceRoot, relativeOutputPath);
  ensureDir(path.dirname(destinationFullPath));
  fs.copyFileSync(sourceFullPath, destinationFullPath);
  return {
    output_relative_path: relativeOutputPath,
    output_full_path: destinationFullPath,
    source_path: rawPath,
    exported_at: nowIso()
  };
}

export function createBackendRevitBatchWorker(deps) {
  const fallbackExecutorId = `${deps.executorId || `${os.hostname()}-${process.pid}`}`.trim();
  const executorKind = `${deps.executorKind || "revit_delegate"}`.trim();
  const settlementStorePath = batchSettlementStorePath(deps);
  const settlementRetryDelaysMs = Array.isArray(deps.settlementRetryDelaysMs)
    ? deps.settlementRetryDelaysMs.slice(0, 8).map((value) => Math.max(0, Number(value) || 0))
    : [0, 100, 500];
  let running = false;
  let timer = null;

  async function settle(jobId, itemId, settlementExecutorId, claimToken, ok, payload, binding) {
    const suffix = ok ? "complete" : "fail";
    return deps.readBackendJson(`/api/revit-batch/jobs/${encodeURIComponent(jobId)}/items/${encodeURIComponent(itemId)}/${suffix}`, {
      method: "POST",
      body: JSON.stringify(buildBatchSettlementBody(settlementExecutorId, claimToken, ok, payload, binding))
    });
  }

  async function settleSuccessfulExecution(record) {
    let lastError = null;
    for (let attempt = 0; attempt < settlementRetryDelaysMs.length; attempt += 1) {
      if (settlementRetryDelaysMs[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, settlementRetryDelaysMs[attempt]));
      }
      try {
        const response = await settle(
          record.job_id,
          record.item_id,
          record.executor_id,
          record.claim_token,
          true,
          record.result,
          record.binding
        );
        if (!isConfirmedBatchCompletion(response, record)) {
          throw new Error("Batch completion response was malformed or did not confirm succeeded status.");
        }
        return saveBatchSettlementRecord(settlementStorePath, {
          ...record,
          status: "settled",
          attempts: (record.attempts || 0) + attempt + 1,
          settled_at: nowIso(),
          last_error: ""
        });
      } catch (error) {
        lastError = error;
        saveBatchSettlementRecord(settlementStorePath, {
          ...record,
          status: "pending",
          attempts: (record.attempts || 0) + attempt + 1,
          last_error: trimText(error instanceof Error ? error.message : String(error), 500)
        });
      }
    }
    return saveBatchSettlementRecord(settlementStorePath, {
      ...record,
      status: "outcome_unknown",
      attempts: (record.attempts || 0) + settlementRetryDelaysMs.length,
      outcome_unknown_at: nowIso(),
      last_error: trimText(lastError instanceof Error ? lastError.message : String(lastError || "Completion settlement was not confirmed."), 500)
    });
  }

  async function reconcilePendingSettlements() {
    const state = readBatchSettlementState(settlementStorePath);
    for (const record of state.records.filter((entry) => entry?.status === "pending")) {
      await settleSuccessfulExecution(record);
    }
  }

  async function processOne() {
    // A cheap owner/session-scoped backend hint precedes any Revit work. The
    // fresh binding below, claim fence, and pre-execution check remain required.
    if (typeof deps.hasPendingWork === "function" && await deps.hasPendingWork() !== true) return false;
    if (typeof deps.shouldYield === "function" && deps.shouldYield()) return false;
    const binding = normalizeBatchBinding(await deps.getBatchBinding());
    // A foreground run can start while the already-admitted binding read waits
    // for Revit. Let that read settle, but do not claim new background work.
    if (typeof deps.shouldYield === "function" && deps.shouldYield()) return false;
    const executorId = binding.target_executor_id || fallbackExecutorId;
    if (executorId !== binding.target_executor_id) throw new Error("Batch executor does not match the live Revit binding.");
    const claimed = await deps.readBackendJson("/api/revit-batch/claim-next", {
      method: "POST",
      body: JSON.stringify({
        ...batchBindingPayload(binding),
        executor_id: executorId,
        executor_kind: executorKind
      })
    });
    const job = claimed?.job;
    const item = claimed?.item;
    if (!job || !item) return false;
    const storedBinding = normalizeBatchBinding({
      session_id: job.session_id,
      target_context: job.target_context
    });
    if (!sameBatchBinding(binding, storedBinding)) {
      throw new Error("Claimed batch job binding does not match this Revit session, executor, and project.");
    }
    const claimToken = trimText(claimed?.claim_token || item?.claim?.fencing_token, 160);
    if (!claimToken) {
      throw new Error("Backend batch claim omitted the required fencing token; refusing to execute the item.");
    }
    const priorSettlement = readBatchSettlementState(settlementStorePath).records.find(
      (entry) => entry?.key === batchSettlementRecordKey(job.id, item.id)
    );
    if (priorSettlement) {
      if (priorSettlement.status === "pending") await settleSuccessfulExecution(priorSettlement);
      else throw new Error(`Batch item ${item.id} was offered again after local ${priorSettlement.status}; refusing to replay execution.`);
      return true;
    }
    if (typeof deps.onJobEvent === "function") {
      deps.onJobEvent(job, `Claimed batch item ${item.index || "?"} from '${job.title || "batch job"}'.`);
    }
    let normalizedResult;
    try {
      const liveBinding = normalizeBatchBinding(await deps.getBatchBinding());
      if (!sameBatchBinding(binding, liveBinding)) {
        throw new Error("Revit executor or project changed after claim; refusing to execute the batch item in the wrong document.");
      }
      const result = `${job?.job_type || ""}`.trim().toLowerCase() === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
        ? await deps.executeDelegatedWorkItem({
            job,
            item,
            maxRounds: job?.params?.per_item_max_rounds
          })
        : await executeRoomViewCaptureBatchItem(job, item, deps);
      normalizedResult = `${job?.job_type || ""}`.trim().toLowerCase() === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
        ? {
            assistant_message: trimText(result?.assistant_message || "", 1600),
            result_summary: trimText(result?.assistant_message || "Delegated item completed.", 320),
            rounds: Array.isArray(result?.rounds) ? result.rounds.length : 0,
            session_id: `${result?.session_id || ""}`.trim(),
            ...(typeof result?.effect_state === "string" ? { effect_state: trimText(result.effect_state, 80) } : {}),
            ...(typeof result?.outcome_unknown === "boolean" ? { outcome_unknown: result.outcome_unknown } : {}),
            ...(typeof result?.retryable === "boolean" ? { retryable: result.retryable } : {}),
            ...(typeof result?.reconciliation_required === "boolean" ? { reconciliation_required: result.reconciliation_required } : {}),
            ...(typeof result?.failure_code === "string" ? { failure_code: trimText(result.failure_code, 160) } : {}),
            ...(typeof result?.failure_hint === "string" ? { failure_hint: trimText(result.failure_hint, 600) } : {}),
            ...(typeof result?.handler_code === "string" ? { handler_code: trimText(result.handler_code, 200) } : {})
          }
        : result;
      if (`${job?.job_type || ""}`.trim().toLowerCase() === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH && !result?.ok) {
        const message = trimText(result?.error || result?.assistant_message || "Delegated work item failed.", 260);
        await settle(job.id, item.id, executorId, claimToken, false, { error: message, result: normalizedResult }, binding);
        if (typeof deps.onJobEvent === "function") {
          deps.onJobEvent(job, `Failed batch item ${item.index || "?"} from '${job.title || "batch job"}': ${message}`);
        }
        return true;
      }
    } catch (error) {
      const message = trimText(error instanceof Error ? error.message : String(error), 260) || "Batch item failed.";
      await settle(job.id, item.id, executorId, claimToken, false, { error: message }, binding);
      if (typeof deps.onJobEvent === "function") {
        deps.onJobEvent(job, `Failed batch item ${item.index || "?"} from '${job.title || "batch job"}': ${message}`);
      }
      return true;
    }

    let settlementRecord;
    try {
      settlementRecord = saveBatchSettlementRecord(settlementStorePath, {
        job_id: `${job.id}`,
        item_id: `${item.id}`,
        executor_id: executorId,
        binding,
        claim_token: claimToken,
        result: normalizedResult,
        status: "pending",
        attempts: 0,
        created_at: nowIso(),
        last_error: ""
      });
    } catch (error) {
      if (typeof deps.onJobEvent === "function") {
        deps.onJobEvent(job, `Batch item ${item.index || "?"} executed, but its completion handoff could not be persisted; outcome unknown and execution will not be replayed.`);
      }
      return true;
    }

    const settled = await settleSuccessfulExecution(settlementRecord);
    if (typeof deps.onJobEvent === "function") {
      deps.onJobEvent(job, settled.status === "settled"
        ? `Completed batch item ${item.index || "?"} from '${job.title || "batch job"}'.`
        : `Batch item ${item.index || "?"} executed, but completion could not be confirmed; outcome unknown and execution will not be replayed.`);
    }
    return true;
  }

  async function tick() {
    if (running) return;
    // The foreground Operator turn owns Revit's single ExternalEvent lane.
    // Polling for background batch work must not acquire a fresh model binding
    // while that turn is inspecting, applying, or verifying live model state.
    if (typeof deps.shouldYield === "function" && deps.shouldYield()) return;
    running = true;
    try {
      await reconcilePendingSettlements();
      let claimedAny = true;
      while (claimedAny) {
        if (typeof deps.shouldYield === "function" && deps.shouldYield()) break;
        claimedAny = await processOne();
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(() => {
        // best effort; explicit job failures are written back through the settle calls
      });
    }, 1500);
    tick().catch(() => {
      // ignore startup errors
    });
  }

  function poke() {
    return tick();
  }

  return {
    start,
    poke,
    runOnce: tick,
    executorId: fallbackExecutorId,
    executorKind,
    settlementStorePath
  };
}
