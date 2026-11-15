import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const JOB_TYPE_ROOM_VIEW_CAPTURE = "room_view_capture";
const JOB_TYPE_DELEGATED_REVIT_TASK_BATCH = "delegated_revit_task_batch";
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "failed", "succeeded", "succeeded_with_failures"]);
const RUNNABLE_JOB_STATUSES = new Set(["queued", "running", "pausing", "cancelling"]);

function nowIso() {
  return new Date().toISOString();
}

function trimText(value, max = 400) {
  const text = `${value || ""}`.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
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

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function toPosixRelative(baseRoot, fullPath) {
  const relative = path.relative(baseRoot, fullPath);
  return relative.replace(/\\/g, "/");
}

function normalizeRelativeArtifactPath(workspaceRoot, rawValue, fallback) {
  const raw = `${rawValue || ""}`.trim().replace(/\\/g, "/");
  const normalized = raw.replace(/^\/+/, "");
  const candidate = normalized || fallback;
  if (!candidate) {
    throw new Error("A relative artifact path is required.");
  }
  const fullPath = path.resolve(workspaceRoot, candidate);
  const resolvedRoot = path.resolve(workspaceRoot);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (fullPath !== resolvedRoot && !fullPath.startsWith(prefix)) {
    throw new Error("Artifact path must stay inside the workspace.");
  }
  return toPosixRelative(workspaceRoot, fullPath);
}

function resolveWorkspaceFile(workspaceRoot, rawPath) {
  const text = `${rawPath || ""}`.trim();
  if (!text) return null;
  if (path.isAbsolute(text) && fs.existsSync(text)) return text;
  const candidate = path.resolve(workspaceRoot, text);
  return fs.existsSync(candidate) ? candidate : null;
}

function jobsRoot(getWorkspaceRoot) {
  return ensureDir(path.join(getWorkspaceRoot(), "artifacts", "revit-batch", "jobs"));
}

function jobDir(getWorkspaceRoot, jobId) {
  return path.join(jobsRoot(getWorkspaceRoot), jobId);
}

function jobRecordPath(getWorkspaceRoot, jobId) {
  return path.join(jobDir(getWorkspaceRoot, jobId), "job.json");
}

function jobSummaryPath(getWorkspaceRoot, jobId) {
  return path.join(jobDir(getWorkspaceRoot, jobId), "summary.json");
}

function manifestCsvPath(getWorkspaceRoot, jobId) {
  return path.join(jobDir(getWorkspaceRoot, jobId), "manifest.csv");
}

function summarizeItems(items) {
  const summary = {
    total: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0
  };
  for (const item of asArray(items)) {
    summary.total += 1;
    const status = `${item?.status || "pending"}`.trim().toLowerCase();
    if (status === "succeeded") summary.succeeded += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "running") summary.running += 1;
    else if (status === "skipped") summary.skipped += 1;
    else summary.pending += 1;
  }
  return summary;
}

function publicJob(job, { includeItems = true } = {}) {
  const itemSummary = summarizeItems(job?.items);
  const previewItems = asArray(job?.preview_items).slice(0, 6);
  return {
    id: `${job?.id || ""}`.trim(),
    title: `${job?.title || ""}`.trim(),
    job_type: `${job?.job_type || ""}`.trim(),
    status: `${job?.status || ""}`.trim(),
    created_at: `${job?.created_at || ""}`.trim(),
    updated_at: `${job?.updated_at || ""}`.trim(),
    started_at: `${job?.started_at || ""}`.trim() || null,
    finished_at: `${job?.finished_at || ""}`.trim() || null,
    error: `${job?.error || ""}`.trim() || null,
    output_folder_relative: `${job?.output_folder_relative || ""}`.trim(),
    job_dir: `${job?.job_dir || ""}`.trim(),
    approval: job?.approval && typeof job.approval === "object" ? job.approval : {},
    item_summary: itemSummary,
    planning_progress: job?.planning_progress && typeof job.planning_progress === "object" ? job.planning_progress : null,
    preview_items: previewItems,
    params: job?.params && typeof job.params === "object" ? job.params : {},
    source: job?.source && typeof job.source === "object" ? job.source : {},
    result: job?.result && typeof job.result === "object" ? job.result : {},
    ...(includeItems ? { items: asArray(job?.items) } : {})
  };
}

function writeManifestCsv(getWorkspaceRoot, job) {
  const jobType = `${job?.job_type || ""}`.trim().toLowerCase();
  const lines = jobType === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
    ? ["index,label,itemKey,status,resultSummary,error,artifactPaths"]
    : ["index,roomNumber,roomName,levelName,viewId,viewName,status,outputRelativePath,error"];
  for (const item of asArray(job?.items)) {
    const cells = (jobType === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
      ? [
          item?.index,
          item?.label,
          item?.item_key,
          item?.status,
          item?.result_summary,
          item?.error,
          asArray(item?.artifact_paths).join(" | ")
        ]
      : [
          item?.index,
          item?.room_number,
          item?.room_name,
          item?.level_name,
          item?.view_id,
          item?.view_name,
          item?.status,
          item?.output_relative_path,
          item?.error
        ]).map((value) => `"${`${value ?? ""}`.replace(/"/g, "\"\"")}"`);
    lines.push(cells.join(","));
  }
  fs.writeFileSync(manifestCsvPath(getWorkspaceRoot, job.id), `${lines.join("\n")}\n`, "utf8");
}

function saveJob(getWorkspaceRoot, job) {
  const dirPath = ensureDir(jobDir(getWorkspaceRoot, job.id));
  const next = {
    ...job,
    job_dir: dirPath,
    updated_at: nowIso()
  };
  writeJsonFile(jobRecordPath(getWorkspaceRoot, job.id), next);
  writeJsonFile(jobSummaryPath(getWorkspaceRoot, job.id), publicJob(next, { includeItems: false }));
  writeManifestCsv(getWorkspaceRoot, next);
  return next;
}

function readJob(getWorkspaceRoot, jobId) {
  const parsed = readJsonFile(jobRecordPath(getWorkspaceRoot, jobId));
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

function listJobsInternal(getWorkspaceRoot, limit = 20) {
  const root = jobsRoot(getWorkspaceRoot);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const job = readJob(getWorkspaceRoot, entry.name);
      return job || null;
    })
    .filter(Boolean)
    .sort((a, b) => `${b.updated_at || ""}|${b.id || ""}`.localeCompare(`${a.updated_at || ""}|${a.id || ""}`));
  return entries.slice(0, Math.max(1, limit));
}

function buildDefaultBatchTemplate() {
  return {
    job_type: JOB_TYPE_ROOM_VIEW_CAPTURE,
    title: "Capture room discipline screenshots",
    description: "Resolve a plan view for each room, export the image, and file it with a deterministic name.",
    view_name_hint: "coord",
    image_size: 2048,
    file_name_pattern: "{roomNumber}_{viewName}",
    output_folder_relative: "artifacts/revit-batch/exports/room-captures",
    sample_count: 3,
    max_rooms: 200,
    success_checks: [
      "Each requested room resolved to a plan view.",
      "An image file was exported for each succeeded room.",
      "The saved filename matches the requested naming pattern."
    ]
  };
}

function buildDefaultDelegatedBatchTemplate() {
  return {
    job_type: JOB_TYPE_DELEGATED_REVIT_TASK_BATCH,
    title: "Run a repeated Revit task across a scope",
    description: "Plan a worklist for a repeated Revit task, preview a few items, then run each item through the deterministic delegated Revit lane with resumable job control.",
    task_prompt: "",
    scope_description: "",
    work_item_hint: "",
    preview_count: 3,
    max_items: 50,
    per_item_max_rounds: 8,
    success_checks: [
      "Each work item is independently executable with a bounded deterministic Revit workflow.",
      "The run reports which items succeeded, failed, or need retry.",
      "The user can approve, pause, resume, cancel, and retry the batch."
    ]
  };
}

function normalizeRoomViewCaptureParams(getWorkspaceRoot, input = {}) {
  const sampleCount = Math.max(1, Math.min(10, Number.parseInt(`${input.sample_count ?? input.sampleCount ?? 3}`, 10) || 3));
  const maxRooms = Math.max(1, Math.min(500, Number.parseInt(`${input.max_rooms ?? input.maxRooms ?? 200}`, 10) || 200));
  const imageSize = Math.max(400, Math.min(8000, Number.parseInt(`${input.image_size ?? input.imageSize ?? 2048}`, 10) || 2048));
  const title = trimText(input.title || "Capture room discipline screenshots", 160);
  const outputFolderRelative = normalizeRelativeArtifactPath(
    getWorkspaceRoot(),
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
  const outputRelativePath = item?.view_id
    ? deriveOutputRelativePath(job, item, ".png")
    : "";
  return {
    index: item?.index,
    room_number: `${item?.room_number || ""}`.trim(),
    room_name: `${item?.room_name || ""}`.trim(),
    level_name: `${item?.level_name || ""}`.trim(),
    view_id: item?.view_id || null,
    view_name: `${item?.view_name || ""}`.trim(),
    expected_output_relative_path: outputRelativePath,
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

async function planRoomViewCaptureJob(job, deps) {
  const { readBackendJson } = deps;
  const params = normalizeRoomViewCaptureParams(deps.getWorkspaceRoot, job.params);
  let next = saveJob(deps.getWorkspaceRoot, {
    ...job,
    params,
    planning_progress: { total: 0, resolved: 0 },
    error: null
  });

  const rooms = await fetchCandidateRooms(readBackendJson, params);
  if (rooms.length === 0) {
    throw new Error("No rooms matched the requested batch scope.");
  }

  const items = [];
  const planningWarnings = [];
  next = saveJob(deps.getWorkspaceRoot, {
    ...next,
    planning_progress: { total: rooms.length, resolved: 0 }
  });

  for (const room of rooms) {
    const item = {
      id: randomUUID().replace(/-/g, ""),
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
      const resolved = await readBackendJson("/revit/resolve-room-plan-view", {
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
    next = saveJob(deps.getWorkspaceRoot, {
      ...next,
      items,
      planning_progress: { total: rooms.length, resolved: items.length }
    });
  }

  const previewItems = items.slice(0, params.sample_count).map((item) => buildPreviewItem({ ...next, params }, item));
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const approvalRequired = pendingCount > 0;
  const result = {
    preview_items: previewItems,
    planning_warnings: planningWarnings,
    matched_room_count: items.length,
    failed_to_plan_count: failedCount
  };

  return saveJob(deps.getWorkspaceRoot, {
    ...next,
    title: params.title,
    params,
    preview_items: previewItems,
    planning_progress: null,
    result,
    approval: {
      required: approvalRequired,
      approved_at: null,
      sample_count: params.sample_count
    },
    status: pendingCount === 0 ? "failed" : approvalRequired ? "awaiting_approval" : "queued",
    error: pendingCount === 0 ? "No runnable items were planned for this batch job." : null
  });
}

async function planDelegatedBatchJob(job, deps) {
  if (typeof deps.planDelegatedBatch !== "function") {
    throw new Error("Generic delegated batch planning is not configured.");
  }
  const params = normalizeDelegatedBatchParams(job.params);
  if (!params.task_prompt) {
    throw new Error("A generic delegated batch job requires task_prompt.");
  }

  let next = saveJob(deps.getWorkspaceRoot, {
    ...job,
    params,
    planning_progress: { total: 0, resolved: 0 },
    error: null
  });

  const planned = await deps.planDelegatedBatch(params);
  const workItems = asArray(planned?.work_items).slice(0, params.max_items);
  if (workItems.length === 0) {
    throw new Error(trimText(planned?.planner_summary || "The planner did not produce any runnable work items.", 320));
  }

  const items = workItems.map((item, index) => ({
    id: randomUUID().replace(/-/g, ""),
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
  const plannerWarnings = asStringList(planned?.warnings, 20);
  const result = {
    planner_summary: trimText(planned?.planner_summary || planned?.summary || "", 1200),
    strategy_summary: trimText(planned?.strategy_summary || "", 1200),
    planning_warnings: plannerWarnings,
    matched_item_count: items.length,
    truncated_to_max_items: workItems.length > items.length || (asArray(planned?.work_items).length > params.max_items)
  };

  next = saveJob(deps.getWorkspaceRoot, {
    ...next,
    title: trimText(planned?.title || params.title, 160),
    params,
    items,
    preview_items: previewItems,
    planning_progress: null,
    result,
    approval: {
      required: true,
      approved_at: null,
      sample_count: params.preview_count
    },
    status: "awaiting_approval",
    error: null
  });

  return next;
}

function buildFinalSummary(job) {
  const counts = summarizeItems(job.items);
  const failedItems = asArray(job.items)
    .filter((item) => item.status === "failed")
    .slice(0, 12)
    .map((item) => `${job?.job_type || ""}`.trim().toLowerCase() === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
      ? ({
          index: item.index,
          label: item.label,
          item_key: item.item_key,
          error: item.error
        })
      : ({
          index: item.index,
          room_number: item.room_number,
          view_name: item.view_name,
          error: item.error
        }));
  return {
    counts,
    failed_items: failedItems,
    output_folder_relative: job.output_folder_relative,
    finished_at: job.finished_at,
    status: job.status
  };
}

async function executeRoomViewCaptureItem(job, item, deps) {
  const response = await deps.readBackendJson("/revit/export-image", {
    method: "POST",
    body: JSON.stringify({
      viewId: item.view_id,
      imageSize: job.params.image_size
    })
  });

  const rawPath = `${response?.path || ""}`.trim();
  const sourceFullPath = resolveWorkspaceFile(deps.getWorkspaceRoot(), rawPath);
  if (!sourceFullPath) {
    throw new Error(`Exported image could not be found locally: ${rawPath || "missing path"}`);
  }

  const extension = path.extname(sourceFullPath) || ".png";
  const relativeOutputPath = deriveOutputRelativePath(job, item, extension);
  const destinationFullPath = path.resolve(deps.getWorkspaceRoot(), relativeOutputPath);
  ensureDir(path.dirname(destinationFullPath));
  fs.copyFileSync(sourceFullPath, destinationFullPath);

  return {
    output_relative_path: relativeOutputPath,
    output_full_path: destinationFullPath,
    source_path: rawPath,
    exported_at: nowIso()
  };
}

async function executeDelegatedBatchItem(job, item, deps) {
  if (typeof deps.executeDelegatedWorkItem !== "function") {
    throw new Error("Generic delegated batch execution is not configured.");
  }
  const result = await deps.executeDelegatedWorkItem({
    job,
    item,
    maxRounds: job?.params?.per_item_max_rounds
  });
  if (!result?.ok) {
    throw new Error(trimText(result?.error || result?.assistant_message || "Delegated work item failed.", 260));
  }
  return {
    assistant_message: trimText(result?.assistant_message || "", 1600),
    result_summary: trimText(result?.assistant_message || "Delegated item completed.", 320),
    rounds: Array.isArray(result?.rounds) ? result.rounds.length : 0,
    session_id: `${result?.session_id || ""}`.trim()
  };
}

function findNextPendingItem(job) {
  return asArray(job?.items).find((item) => `${item?.status || ""}`.trim().toLowerCase() === "pending") || null;
}

export function createRevitBatchManager(deps) {
  const {
    getWorkspaceRoot,
    readBackendJson,
    planDelegatedBatch,
    executeDelegatedWorkItem,
    onJobEvent
  } = deps;
  const runningJobs = new Map();

  function emitJobEvent(job, text) {
    if (typeof onJobEvent === "function") {
      onJobEvent(job, text);
    }
  }

  function getJob(jobId) {
    const job = readJob(getWorkspaceRoot, jobId);
    return job ? publicJob(job) : null;
  }

  function listJobs(limit = 20) {
    return listJobsInternal(getWorkspaceRoot, limit).map((job) => publicJob(job, { includeItems: false }));
  }

  async function runJob(jobId) {
    let active = readJob(getWorkspaceRoot, jobId);
    if (!active) return;

    active = saveJob(getWorkspaceRoot, {
      ...active,
      status: "running",
      started_at: active.started_at || nowIso(),
      finished_at: null,
      error: null
    });
    emitJobEvent(active, `Batch job '${active.title}' started.`);

    while (true) {
      let job = readJob(getWorkspaceRoot, jobId);
      if (!job) break;
      if (!RUNNABLE_JOB_STATUSES.has(job.status)) break;

      if (job.status === "cancelling" || job.cancel_requested) {
        job = saveJob(getWorkspaceRoot, {
          ...job,
          status: "cancelled",
          finished_at: nowIso(),
          result: buildFinalSummary(job)
        });
        emitJobEvent(job, `Batch job '${job.title}' was cancelled.`);
        break;
      }

      if (job.status === "pausing" || job.pause_requested) {
        job = saveJob(getWorkspaceRoot, {
          ...job,
          status: "paused",
          result: buildFinalSummary(job)
        });
        emitJobEvent(job, `Batch job '${job.title}' paused.`);
        break;
      }

      const nextItem = findNextPendingItem(job);
      if (!nextItem) {
        const counts = summarizeItems(job.items);
        const finalStatus = counts.failed > 0 && counts.succeeded > 0
          ? "succeeded_with_failures"
          : counts.failed > 0
            ? "failed"
            : "succeeded";
        job = saveJob(getWorkspaceRoot, {
          ...job,
          status: finalStatus,
          finished_at: nowIso(),
          result: buildFinalSummary(job)
        });
        emitJobEvent(job, finalStatus === "succeeded"
          ? `Batch job '${job.title}' finished successfully.`
          : finalStatus === "succeeded_with_failures"
            ? `Batch job '${job.title}' finished with some failed items.`
            : `Batch job '${job.title}' finished with failures.`);
        break;
      }

      const runningItems = asArray(job.items).map((item) =>
        item.id === nextItem.id
          ? {
              ...item,
              status: "running",
              started_at: item.started_at || nowIso(),
              error: ""
            }
          : item
      );
      job = saveJob(getWorkspaceRoot, {
        ...job,
        items: runningItems
      });

      try {
        const itemResult = `${job?.job_type || ""}`.trim().toLowerCase() === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
          ? await executeDelegatedBatchItem(job, nextItem, { executeDelegatedWorkItem })
          : await executeRoomViewCaptureItem(job, nextItem, { getWorkspaceRoot, readBackendJson });
        job = readJob(getWorkspaceRoot, jobId) || job;
        job = saveJob(getWorkspaceRoot, {
          ...job,
          items: asArray(job.items).map((item) =>
            item.id === nextItem.id
              ? {
                  ...item,
                  status: "succeeded",
                  finished_at: nowIso(),
                  ...(itemResult.output_relative_path ? { output_relative_path: itemResult.output_relative_path } : {}),
                  ...(itemResult.output_full_path ? { output_full_path: itemResult.output_full_path } : {}),
                  ...(itemResult.exported_at ? { exported_at: itemResult.exported_at } : {}),
                  ...(itemResult.assistant_message ? { assistant_message: itemResult.assistant_message } : {}),
                  ...(itemResult.result_summary ? { result_summary: itemResult.result_summary } : {}),
                  ...(itemResult.rounds ? { rounds: itemResult.rounds } : {}),
                  ...(itemResult.session_id ? { session_id: itemResult.session_id } : {}),
                  error: ""
                }
              : item
          )
        });
      } catch (error) {
        const message = trimText(error instanceof Error ? error.message : String(error), 260);
        job = readJob(getWorkspaceRoot, jobId) || job;
        job = saveJob(getWorkspaceRoot, {
          ...job,
          items: asArray(job.items).map((item) =>
            item.id === nextItem.id
              ? {
                  ...item,
                  status: "failed",
                  finished_at: nowIso(),
                  error: message
                }
              : item
          )
        });
      }
    }
  }

  function ensureJobStarted(jobId) {
    if (runningJobs.has(jobId)) return;
    const promise = runJob(jobId)
      .catch(() => {
        // Job record captures the failure state.
      })
      .finally(() => {
        runningJobs.delete(jobId);
      });
    runningJobs.set(jobId, promise);
  }

  async function createJob(input = {}) {
    const createdAt = nowIso();
    const implicitGeneric = `${input?.task_prompt ?? input?.taskPrompt ?? ""}`.trim().length > 0;
    const requestedJobType = `${input?.job_type || input?.jobType || (implicitGeneric ? JOB_TYPE_DELEGATED_REVIT_TASK_BATCH : "")}`.trim().toLowerCase();
    const genericDefault = buildDefaultDelegatedBatchTemplate();
    const roomDefault = buildDefaultBatchTemplate();
    const defaultTemplate = requestedJobType === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH ? genericDefault : roomDefault;
    const mergedInput = {
      ...defaultTemplate,
      ...(input && typeof input === "object" ? input : {})
    };
    const normalizedJobType = `${mergedInput.job_type || requestedJobType || roomDefault.job_type}`.trim().toLowerCase() || roomDefault.job_type;
    const jobId = randomUUID().replace(/-/g, "");
    let job = saveJob(getWorkspaceRoot, {
      id: jobId,
      job_type: normalizedJobType,
      title: trimText(mergedInput.title || defaultTemplate.title, 160),
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null,
      status: "planning",
      params: mergedInput,
      approval: {
        required: true,
        approved_at: null,
        sample_count: Number.parseInt(`${mergedInput.sample_count ?? defaultTemplate.sample_count}`, 10) || defaultTemplate.sample_count
      },
      source: mergedInput.source && typeof mergedInput.source === "object" ? mergedInput.source : {},
      items: [],
      preview_items: [],
      output_folder_relative: normalizeRelativeArtifactPath(
        getWorkspaceRoot(),
        mergedInput.output_folder_relative,
        normalizedJobType === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
          ? `artifacts/revit-batch/jobs/${jobId}`
          : `artifacts/revit-batch/exports/${slugifyText(mergedInput.title || "room-captures")}`
      ),
      planning_progress: { total: 0, resolved: 0 },
      result: {},
      error: null
    });

    emitJobEvent(job, `Planning batch job '${job.title}'.`);

    try {
      job = normalizedJobType === JOB_TYPE_DELEGATED_REVIT_TASK_BATCH
        ? await planDelegatedBatchJob(job, { getWorkspaceRoot, planDelegatedBatch })
        : await planRoomViewCaptureJob(job, { getWorkspaceRoot, readBackendJson });
      emitJobEvent(
        job,
        job.status === "awaiting_approval"
          ? `Batch job '${job.title}' is ready for approval.`
          : job.status === "failed"
            ? `Batch job '${job.title}' could not produce runnable items.`
            : `Batch job '${job.title}' queued.`
      );
      if (job.status === "queued") ensureJobStarted(job.id);
      return publicJob(job);
    } catch (error) {
      job = saveJob(getWorkspaceRoot, {
        ...job,
        status: "failed",
        finished_at: nowIso(),
        error: trimText(error instanceof Error ? error.message : String(error), 400)
      });
      emitJobEvent(job, `Batch job '${job.title}' failed during planning.`);
      return publicJob(job);
    }
  }

  function updateJobStatus(jobId, mutateFn) {
    const current = readJob(getWorkspaceRoot, jobId);
    if (!current) throw new Error("Batch job not found.");
    const next = mutateFn(current);
    if (!next || typeof next !== "object") throw new Error("Invalid batch job update.");
    return saveJob(getWorkspaceRoot, next);
  }

  function approveJob(jobId) {
    const job = updateJobStatus(jobId, (current) => {
      if (current.status !== "awaiting_approval") {
        throw new Error("Only jobs awaiting approval can be started.");
      }
      return {
        ...current,
        status: "queued",
        approval: {
          ...(current.approval || {}),
          approved_at: nowIso()
        },
        error: null
      };
    });
    emitJobEvent(job, `Batch job '${job.title}' approved and queued.`);
    ensureJobStarted(job.id);
    return publicJob(job);
  }

  function pauseJob(jobId) {
    const job = updateJobStatus(jobId, (current) => {
      if (current.status === "queued") {
        return { ...current, status: "paused" };
      }
      if (current.status === "running") {
        return { ...current, status: "pausing", pause_requested: true };
      }
      throw new Error("Only queued or running jobs can be paused.");
    });
    emitJobEvent(job, `Pause requested for batch job '${job.title}'.`);
    return publicJob(job);
  }

  function resumeJob(jobId) {
    const job = updateJobStatus(jobId, (current) => {
      if (current.status !== "paused") {
        throw new Error("Only paused jobs can be resumed.");
      }
      return {
        ...current,
        status: "queued",
        pause_requested: false,
        error: null
      };
    });
    emitJobEvent(job, `Batch job '${job.title}' resumed.`);
    ensureJobStarted(job.id);
    return publicJob(job);
  }

  function cancelJob(jobId) {
    const job = updateJobStatus(jobId, (current) => {
      if (TERMINAL_JOB_STATUSES.has(current.status)) {
        throw new Error("This batch job is already finished.");
      }
      if (current.status === "running" || current.status === "pausing") {
        return { ...current, status: "cancelling", cancel_requested: true };
      }
      return {
        ...current,
        status: "cancelled",
        finished_at: nowIso(),
        cancel_requested: true,
        result: buildFinalSummary(current)
      };
    });
    emitJobEvent(job, `Cancel requested for batch job '${job.title}'.`);
    return publicJob(job);
  }

  function retryFailedItems(jobId) {
    const job = updateJobStatus(jobId, (current) => {
      const items = asArray(current.items);
      const failedCount = items.filter((item) => item.status === "failed").length;
      if (failedCount === 0) {
        throw new Error("This batch job has no failed items to retry.");
      }
      return {
        ...current,
        status: current.approval?.approved_at ? "queued" : "awaiting_approval",
        finished_at: null,
        error: null,
        cancel_requested: false,
        pause_requested: false,
        items: items.map((item) =>
          item.status === "failed"
            ? {
                ...item,
                status: "pending",
                error: "",
                finished_at: null,
                started_at: null
              }
            : item
        )
      };
    });
    emitJobEvent(job, `Retry requested for failed items in '${job.title}'.`);
    if (job.status === "queued") ensureJobStarted(job.id);
    return publicJob(job);
  }

  function resumePendingJobs() {
    for (const job of listJobsInternal(getWorkspaceRoot, 200)) {
      if (job.status === "running" || job.status === "queued" || job.status === "pausing" || job.status === "cancelling") {
        const normalized = saveJob(getWorkspaceRoot, {
          ...job,
          status: job.status === "running" ? "queued" : job.status
        });
        ensureJobStarted(normalized.id);
      }
    }
  }

  function listTemplates() {
    return [buildDefaultDelegatedBatchTemplate(), buildDefaultBatchTemplate()];
  }

  return {
    JOB_TYPE_ROOM_VIEW_CAPTURE,
    JOB_TYPE_DELEGATED_REVIT_TASK_BATCH,
    listTemplates,
    listJobs,
    getJob,
    createJob,
    approveJob,
    pauseJob,
    resumeJob,
    cancelJob,
    retryFailedItems,
    resumePendingJobs
  };
}
