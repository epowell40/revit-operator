import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildAllowlistFromPairs, filterAllowlistedActions } from "../allowlist.js";
import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ActionCall,
  type ChatRequest,
  type ChatResponse,
  type ToolResult
} from "../contracts.js";
import { getHistory, getPinnedGoal, type SessionMessage } from "../session_store.js";
import { getSkillLibraryText } from "../skills/skill_library.js";
import { executeDevActions } from "../dev/dev_agent.js";
import { getAttachmentExcerptsForPrompt } from "../attachments/extract.js";
import { collectInlineImagesFromToolResults, toolAttachmentToDataUrl } from "../attachments/inline_images.js";
import { ensureWorkspaceLayout, resolveExistingFileUnderWorkspace } from "../workspace.js";
import { getWebResearchPolicyFromEnv } from "../web_research/policy.js";
import { fetchWebEvidence } from "../web_research/fetch.js";
import { appendEvent, appendNotification, getRecentStepToolResults } from "../memory/sqlite_store.js";
import { persistence } from "../persistence/persistence_manager.js";
import { retrieveMemoryContext } from "../memory/jsonl_memory_store.js";
import { formatProjectProfileForPrompt } from "../memory/project_profile.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "../openai_client.js";
import { executeWorkbenchActions, maxWorkbenchActions, type WorkbenchAction, type WorkbenchActionResult } from "../workbench/workbench_runner.js";
import { createArtifactShare } from "../artifacts/artifact_bus.js";
import { compactIncomingToolResult, compactVisibleElementsResult, describeVisibleElementsInventory } from "../tool_result_compaction.js";
import { alignRedlineToView, type ViewAlignmentMark, type ViewAlignmentResult } from "../redline/view_alignment.js";
import { orientRedlineFile } from "../redline/redline_orienter.js";
import { analyzeRedlineFile } from "../redline/redline_analyzer.js";
import { pdfDefaultPageBudget } from "../redline/pdf_intake_policy.js";
import type { StreamCallbacks } from "./codex_brain.js";
import { getRequestPrincipal } from "../request_context.js";
import { knowledgeBaseOwnerIdForPrincipal, listKnowledgeBaseDocuments, searchKnowledgeBase } from "../knowledge_base/service.js";
import { formatActiveGoalContext, getActiveGoalForSession } from "../goals/service.js";
import { formatEnvironmentSummaryForPrompt } from "../environment_profile.js";
import { AGENT_RESPONSE_STYLE_LINES } from "../agent_response_policy.js";
import { approxPayloadChars, resolveSpeedSettings, selectSpeedRoute, type SpeedRouteKind } from "../speed_config.js";
import {
  appendRedlineFastPathCandidateDiagnostic,
  buildRedlineFastPathDiagnosticsText,
  getRedlineFastPathState,
  noteRedlineFastPathPhase
} from "./redline_fast_path_state.js";
import {
  callBridgeActionDirect,
  canUseDirectBridgeFastPath,
  inferImageAttachmentMime,
  readAbsoluteImageDataUrl,
  toToolResultFromDirectBridgeResult,
  type DirectBridgeResult
} from "./direct_revit_bridge.js";
import { formatWorkbenchResultsForPrompt } from "./workbench_prompt_formatter.js";

type OpenAiDecision = {
  assistant_message: string;
  actions: Array<{
    action_id: string;
    method: "GET" | "POST";
    path: string;
    body_json: string | null;
  }>;
  web_requests: Array<{
    request_id: string;
    url: string;
    purpose?: string | null;
  }>;
  dev_actions?: Array<{
    type: "apply_patch" | "shell" | "write_file" | "restart_backend";
    patch: string | null;
    workdir: string | null;
    command: string | null;
    timeout_ms: number | null;
    file_path: string | null;
    content: string | null;
  }>;
  workbench_actions?: Array<{
    type:
      | "shell"
      | "python"
      | "write_file"
      | "read_file"
      | "list_files"
      | "analyze_redline"
      | "map_sheet_regions"
      | "redline_orient"
      | "gemini_redline_analyze";
    command: string | null;
    code: string | null;
    workdir: string | null;
    timeout_ms: number | null;
    file_path: string | null;
    content: string | null;
    dir_path: string | null;
    recursive: boolean | null;
    max_items: number | null;
    max_bytes: number | null;
    expected_sheet: string | null;
    max_pages: number | null;
    page_start: number | null;
    include_pdf_annotations: boolean | null;
    include_ocr_for_images: boolean | null;
    baseline_file_path: string | null;
    image_width: number | null;
    image_height: number | null;
    boxes: Array<Record<string, unknown>> | null;
    sheet_outline: Record<string, unknown> | null;
    viewport_geometry: Array<Record<string, unknown>> | null;
    title_blocks: Array<Record<string, unknown>> | null;
    image_paths: string[] | null;
    objective: string | null;
    region_boxes: Array<Record<string, unknown>> | null;
    max_regions: number | null;
    min_confidence: number | null;
    include_code_execution: boolean | null;
  }>;
};

const lastPermissionSignatureBySession = new Map<string, string>();

function openAiUsageNotificationsEnabled(): boolean {
  const v = (process.env.OPERATOR_OPENAI_USAGE_NOTIFICATIONS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function extractResponsesApiOutputText(response: any): string {
  const direct = typeof response?.output_text === "string" ? response.output_text : "";
  if (direct.trim().length > 0) return direct;

  const messageText: string[] = [];
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputItems) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      if (!contentItem || contentItem.type !== "output_text" || typeof contentItem.text !== "string") continue;
      if (contentItem.text.length > 0) messageText.push(contentItem.text);
    }
  }
  if (messageText.length > 0) return messageText.join("");

  if (response?.output_parsed != null) {
    try {
      return JSON.stringify(response.output_parsed);
    } catch {
      // ignore serialization errors
    }
  }

  return "";
}

export function __testOnlyExtractResponsesApiOutputText(response: unknown): string {
  return extractResponsesApiOutputText(response);
}

type FastPathViewCandidate = {
  view_id: number;
  view_name: string;
  view_type: string;
  source: "active_model" | "active_sheet_viewport" | "placed_view" | "heuristic";
};

type RedlineFastPathPreflight = {
  tool_results: ToolResult[];
  preflight_package_text: string;
  diagnostics_text: string;
  blocked_reason: string | null;
  direct_response: ChatResponse | null;
};

function buildFastPreflightViewMismatchFallback(args: {
  toolResults: ToolResult[];
  diagnosticsText: string;
  checkedViews: Array<{ view_id: number; view_name: string; matched: boolean; confidence: number; analysis: string }>;
}): RedlineFastPathPreflight {
  const checked = args.checkedViews
    .slice(0, 6)
    .map((row) => `${row.view_name}#${row.view_id}:${row.matched ? "match" : "miss"}:${row.confidence.toFixed(2)}`)
    .join(", ");
  return {
    tool_results: args.toolResults,
    preflight_package_text:
      `fast_redline_view_match=deferred${checked ? `\nfast_redline_checked_views=${checked}` : ""}\n` +
      "fast_redline_next_step=continue with native redline analyze/orient and visible inventory instead of blocking on a single visual match failure",
    diagnostics_text: args.diagnosticsText,
    blocked_reason: null,
    direct_response: null
  };
}

const FAST_PATH_ELECTRICAL_CATEGORIES = ["receptacles", "OST_ElectricalFixtures"] as const;
function mergeToolResultLists(base: ToolResult[], extra: ToolResult[]): ToolResult[] {
  const merged = new Map<string, ToolResult>();
  for (const item of [...base, ...extra]) {
    if (!item) continue;
    merged.set(toolResultKey(item), item);
  }
  return [...merged.values()];
}

function extractActiveViewRecordFromContext(ctx: unknown): Record<string, unknown> | null {
  const c = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : null;
  const revit = c?.revit && typeof c.revit === "object" ? (c.revit as Record<string, unknown>) : null;
  const document = revit?.document && typeof revit.document === "object" ? (revit.document as Record<string, unknown>) : null;
  const activeView =
    document?.activeView && typeof document.activeView === "object"
      ? (document.activeView as Record<string, unknown>)
      : revit?.active_view && typeof revit.active_view === "object"
        ? (revit.active_view as Record<string, unknown>)
        : null;
  return activeView;
}

function extractActiveViewSummaryFromContext(ctx: unknown): { id: number | null; name: string | null; type: string | null } {
  const activeView = extractActiveViewRecordFromContext(ctx);
  return {
    id: toFiniteInt(activeView?.id),
    name: typeof activeView?.name === "string" && activeView.name.trim() ? activeView.name.trim() : null,
    type:
      typeof activeView?.type === "string" && activeView.type.trim()
        ? activeView.type.trim()
        : typeof activeView?.view_type === "string" && activeView.view_type.trim()
          ? activeView.view_type.trim()
          : null
  };
}

function hasExplicitSheetAnchorInText(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  const pattern = /(?:^|[^A-Z0-9])([A-Z]{1,4}\s*[-_.]?\s*\d{1,4}(?:\s*[.-]\s*\d{1,3})?)(?=$|[^A-Z0-9])/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw.toUpperCase())) !== null) {
    const matchedText = match[0] ?? "";
    const groupText = match[1] ?? "";
    const groupOffsetInMatch = matchedText.indexOf(groupText);
    const tokenEnd = groupOffsetInMatch >= 0 ? match.index + groupOffsetInMatch + groupText.length : match.index + matchedText.length;
    if (raw[tokenEnd] === "/") continue;
    const token = normalizeSheetToken(groupText.trim());
    if (!token) continue;
    if (/^(ROOM|RM|UNIT|SUITE)[-_.]?\d/i.test(token)) continue;
    if (/^P\d{2,5}$/i.test(token) && /\bcircuit\s+to\s+p\d{2,5}\s*\//i.test(raw)) continue;
    return true;
  }
  return false;
}

function isFastElectricalPlacementRedline(req: ChatRequest): boolean {
  const attachments = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  const imageAttachments = attachments.filter((attachment) => {
    const rel = typeof attachment?.relative_path === "string" ? attachment.relative_path.trim() : "";
    const ext = path.extname(rel).toLowerCase();
    return rel && (ext === ".png" || ext === ".jpg" || ext === ".jpeg");
  });
  const currentText = String(req.user_text ?? "").trim().toLowerCase();
  const text = (currentText || getRecentUserTextForRedline(req)).toLowerCase();
  if (!text) return false;
  const placementVerb = /\b(add|place|install|insert|put|drop|lay out)\b/.test(text);
  const electricalTarget =
    /\b(receptacle|receptacles|outlet|outlets|gfci|gfi|switch|switches|device|devices|data drop|data device|electrical)\b/.test(
      text
    );
  const redlinePlacementHint = /\b(where indicated|where shown|as marked|per markup|per redline|marked here|shown here)\b/.test(text);
  const isPlacementIntent =
    (placementVerb && electricalTarget) || (electricalTarget && redlinePlacementHint);
  if (!isPlacementIntent) return false;
  const hasOnlyImageAttachments =
    imageAttachments.length > 0 && !attachments.some((attachment) => !imageAttachments.includes(attachment));
  const hasRememberedRedlineImage =
    imageAttachments.length === 0 &&
    attachments.length === 0 &&
    !!getRedlineSessionSeed(req.session_id) &&
    userTextLooksRedline(req);
  if (!hasOnlyImageAttachments && !hasRememberedRedlineImage) return false;
  const filenameSheetHints = extractAttachmentFilenameSheetHints(req).filter((hint) => {
    const token = (hint.sheet ?? "").trim().toUpperCase();
    return token.length > 0 && !/^(ROOM|RM|UNIT|SUITE)[-_.]?\d/.test(token);
  });
  if (filenameSheetHints.length > 0) return false;
  const explicitAnchorText = currentText || text;
  if (hasExplicitSheetAnchorInText(explicitAnchorText)) return false;
  if (/\b(sheet|viewport|titleblock|title block)\b/.test(explicitAnchorText)) return false;
  return true;
}

function scoreFastPathViewCandidate(
  candidate: FastPathViewCandidate,
  targetProfile: RedlineTargetingProfile,
  semanticCorpus: string
): number {
  const preferToken = inferPreferredRedlineViewNameToken(targetProfile, semanticCorpus);
  const nameLower = candidate.view_name.toLowerCase();
  const typeLower = candidate.view_type.toLowerCase();
  const corpus = semanticCorpus.toLowerCase();
  let score = candidate.source === "active_model" ? 50 : candidate.source === "active_sheet_viewport" ? 42 : candidate.source === "placed_view" ? 24 : 18;
  if (preferToken && candidate.source === "active_model" && !viewNameMatchesPreferredToken(candidate.view_name, preferToken)) {
    score -= 20;
  }
  if (typeLower.includes("engineering")) score += 12;
  else if (typeLower.includes("floor")) score += 10;
  else if (typeLower.includes("plan")) score += 7;
  else if (typeLower.includes("ceiling")) score += /\b(rcp|reflected ceiling)\b/.test(corpus) ? 5 : 1;
  if (preferToken) {
    if (nameLower.includes(preferToken)) score += 9;
    if (preferToken === "power" && nameLower.includes("electrical")) score += 4;
  }
  if (/\blevel\b/.test(corpus) && nameLower.includes("level")) score += 1;
  if (/\bexisting\b/.test(corpus) && nameLower.includes("existing")) score += 1;
  return score;
}

function viewNameMatchesPreferredToken(viewName: string | null | undefined, preferToken: string | null): boolean {
  if (!preferToken) return false;
  const nameLower = (viewName ?? "").trim().toLowerCase();
  if (!nameLower) return false;
  if (nameLower.includes(preferToken)) return true;
  if (preferToken === "power" && nameLower.includes("electrical")) return true;
  if (preferToken === "lighting" && nameLower.includes("electrical")) return true;
  return false;
}

function dedupeFastPathViewCandidates(candidates: FastPathViewCandidate[]): FastPathViewCandidate[] {
  const seen = new Set<number>();
  const out: FastPathViewCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.view_id || seen.has(candidate.view_id)) continue;
    seen.add(candidate.view_id);
    out.push(candidate);
  }
  return out;
}

function extractPlacedViewCandidatesFromSheetDetail(resultJson: unknown): FastPathViewCandidate[] {
  const res = resultJson && typeof resultJson === "object" ? (resultJson as Record<string, unknown>) : null;
  if (!res) return [];
  const placedViews = Array.isArray(res.placedViews)
    ? (res.placedViews as Array<Record<string, unknown>>)
    : Array.isArray(res.placed_views)
      ? (res.placed_views as Array<Record<string, unknown>>)
      : [];
  return placedViews
    .map((row, index) => {
      const id = toFiniteInt(row?.viewId ?? row?.id);
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      const type = typeof row?.type === "string" ? row.type.trim() : "";
      if (id === null || id <= 0 || !name || !type || isViewTypeUnsupportedForExportViewFrame(type)) return null;
      return {
        view_id: id,
        view_name: name,
        view_type: type,
        source: index === 0 ? "active_sheet_viewport" : "placed_view"
      } satisfies FastPathViewCandidate;
    })
    .filter(Boolean) as FastPathViewCandidate[];
}

function summarizeVisibleInventoryAnchors(resultJson: unknown, maxRows = 6): string[] {
  const res = resultJson && typeof resultJson === "object" ? (resultJson as Record<string, unknown>) : null;
  const items = Array.isArray(res?.items) ? (res.items as Array<Record<string, unknown>>) : [];
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const category = firstStringishField(item, "category");
    const builtInCategory = firstStringishField(item, "builtInCategory", "built_in_category");
    const categoryKey = `${builtInCategory} ${category}`.toLowerCase();
    if (!/(electrical|receptacle|outlet|device|fixture|data)/.test(categoryKey)) continue;
    const elementId = toFiniteInt(item.elementId ?? item.element_id ?? item.id);
    if (elementId === null || elementId <= 0) continue;
    const anchor = item.anchor && typeof item.anchor === "object" ? (item.anchor as Record<string, unknown>) : null;
    const model = anchor?.model && typeof anchor.model === "object" ? (anchor.model as Record<string, unknown>) : null;
    const x = toFiniteNumber(model?.x);
    const y = toFiniteNumber(model?.y);
    const roomNumber = extractInventoryItemRoomNumber(item) ?? "";
    const family = firstStringishField(item, "familyName", "family_name");
    const typeName = firstStringishField(item, "typeName", "type_name");
    out.push(
      `id=${elementId}; category=${builtInCategory || category || "unknown"}; family=${family || "?"}; type=${typeName || "?"}; room=${roomNumber || "?"}; point=${x !== null && y !== null ? `[${x.toFixed(2)}, ${y.toFixed(2)}]` : "unknown"}`
    );
    if (out.length >= Math.max(1, maxRows)) break;
  }
  return out;
}

async function maybeBuildFastElectricalRedlinePreflight(req: ChatRequest): Promise<RedlineFastPathPreflight | null> {
  if (!isFastElectricalPlacementRedline(req)) return null;
  if (!(await canUseDirectBridgeFastPath())) return null;
  const seed = pickRedlineSeed(req, { allowSessionFallback: true });
  if (!seed?.file_path) return null;

  noteRedlineFastPathPhase(req.session_id, "request_accepted", { mode: "electrical_redline_fast_path" });
  noteRedlineFastPathPhase(req.session_id, "preflight_start", { file_path: seed.file_path });

  let semanticCorpus = [getRecentUserTextForRedline(req), seed.file_path].filter(Boolean).join("\n");
  let targetProfile = inferRedlineTargetingProfileFromText(semanticCorpus, [], []);
  let activeView = extractActiveViewSummaryFromContext(req.context);
  let activeModelViewId = extractActiveModelViewIdFromContext(req.context);
  let activeSheetViewId = extractActiveSheetViewIdFromContext(req.context);
  const collectedToolResults: ToolResult[] = [];
  const preflightNotes: string[] = [];

  const addDirectResult = (result: DirectBridgeResult | null | undefined): DirectBridgeResult | null => {
    if (!result) return null;
    collectedToolResults.push(toToolResultFromDirectBridgeResult(result));
    return result;
  };

  if (!activeModelViewId && !activeSheetViewId) {
    const liveContext = addDirectResult(await callBridgeActionDirect(req.session_id, "GET", "/revit/context"));
    if (liveContext?.ok && liveContext.result_json && typeof liveContext.result_json === "object") {
      const contextObj = { revit: { document: (liveContext.result_json as any).document } };
      activeView = extractActiveViewSummaryFromContext(contextObj);
      activeModelViewId = extractActiveModelViewIdFromContext(contextObj);
      activeSheetViewId = extractActiveSheetViewIdFromContext(contextObj);
      preflightNotes.push("active_view_source=/revit/context");
    }
  }

  const candidates: FastPathViewCandidate[] = [];
  if (activeModelViewId && activeModelViewId > 0) {
    candidates.push({
      view_id: activeModelViewId,
      view_name: activeView.name ?? `View ${activeModelViewId}`,
      view_type: activeView.type ?? "Unknown",
      source: "active_model"
    });
  } else if (activeSheetViewId && activeSheetViewId > 0) {
    const sheetDetail = addDirectResult(
      await callBridgeActionDirect(req.session_id, "POST", "/revit/sheets", {
        action: "detail",
        viewId: activeSheetViewId,
        includePlacedViews: true,
        includeViewports: true,
        includeViewportGeometry: true,
        includeTitleBlocks: true,
        includeSheetOutline: true
      })
    );
    if (sheetDetail?.ok) {
      candidates.push(...extractPlacedViewCandidatesFromSheetDetail(sheetDetail.result_json));
    }
  }

  let viewCandidates = dedupeFastPathViewCandidates(candidates);
  const initialPreferToken = inferPreferredRedlineViewNameToken(targetProfile, semanticCorpus);
  if (
    activeModelViewId &&
    initialPreferToken &&
    !viewCandidates.some((candidate) => viewNameMatchesPreferredToken(candidate.view_name, initialPreferToken))
  ) {
    const listedViews = addDirectResult(await callBridgeActionDirect(req.session_id, "GET", "/revit/views"));
    if (listedViews?.ok && Array.isArray(listedViews.result_json)) {
      const extraCandidates = (listedViews.result_json as Array<Record<string, unknown>>)
        .map((row) => {
          const id = toFiniteInt(row?.id);
          const name = typeof row?.name === "string" ? row.name.trim() : "";
          const type = typeof row?.type === "string" ? row.type.trim() : "";
          if (id === null || id <= 0 || !name || !type || isViewTypeUnsupportedForExportViewFrame(type)) return null;
          return {
            view_id: id,
            view_name: name,
            view_type: type,
            source: "heuristic"
          } satisfies FastPathViewCandidate;
        })
        .filter(Boolean) as FastPathViewCandidate[];
      viewCandidates = dedupeFastPathViewCandidates([...viewCandidates, ...extraCandidates]);
    }
  }
  let triedExpansion = false;
  const alignmentModel = (process.env.OPERATOR_OPENAI_REDLINE_FAST_MODEL ?? "gpt-5.6-sol").trim() || "gpt-5.6-sol";
  const alignmentConfidenceFloor = Math.max(0.25, Math.min(0.9, Number.parseFloat(process.env.OPERATOR_REDLINE_FAST_PATH_MATCH_THRESHOLD ?? "0.42") || 0.42));

  let matchedCandidate: FastPathViewCandidate | null = null;
  let matchedAlignment: Awaited<ReturnType<typeof alignRedlineToView>> | null = null;
  let matchedFrameResult: DirectBridgeResult | null = null;
  let matchedInventoryResult: DirectBridgeResult | null = null;

  while (true) {
    const ranked = viewCandidates
      .map((candidate) => ({ candidate, score: scoreFastPathViewCandidate(candidate, targetProfile, semanticCorpus) }))
      .sort((a, b) => b.score - a.score || a.candidate.view_name.localeCompare(b.candidate.view_name))
      .map((row) => row.candidate)
      .slice(0, 3);

    for (const candidate of ranked) {
      const exportFrame = addDirectResult(
        await callBridgeActionDirect(req.session_id, "POST", "/revit/export-view-frame", {
          viewId: candidate.view_id,
          imageMaxSizePx: 2400,
          includeMapping: true
        })
      );
      if (!exportFrame?.ok) {
        appendRedlineFastPathCandidateDiagnostic(req.session_id, {
          view_id: candidate.view_id,
          view_name: candidate.view_name,
          matched: false,
          confidence: 0,
          analysis: exportFrame?.error ?? "view export failed"
        });
        continue;
      }

      const imageLocalPath =
        Array.isArray(exportFrame.attachments) && exportFrame.attachments[0]?.local_path
          ? exportFrame.attachments[0].local_path
          : null;
      const viewImageDataUrl = imageLocalPath ? readAbsoluteImageDataUrl(imageLocalPath) : null;
      if (!viewImageDataUrl) {
        appendRedlineFastPathCandidateDiagnostic(req.session_id, {
          view_id: candidate.view_id,
          view_name: candidate.view_name,
          matched: false,
          confidence: 0,
          analysis: "exported view image was unavailable for alignment"
        });
        continue;
      }

      noteRedlineFastPathPhase(req.session_id, "vision_start", { view_id: candidate.view_id, view_name: candidate.view_name });
      const alignment = await alignRedlineToView({
        redline_file_path: seed.file_path,
        view_image_data_url: viewImageDataUrl,
        objective: `Determine whether this Revit view matches the uploaded redline for placing electrical devices like receptacles, and map each redline mark center into the view.`,
        model: alignmentModel,
        reasoning_effort: "medium",
        max_output_tokens: 700
      });
      noteRedlineFastPathPhase(req.session_id, "vision_end", {
        view_id: candidate.view_id,
        matched: alignment.matched,
        confidence: alignment.confidence
      });

      appendRedlineFastPathCandidateDiagnostic(req.session_id, {
        view_id: candidate.view_id,
        view_name: candidate.view_name,
        matched: alignment.ok && alignment.matched,
        confidence: alignment.confidence,
        analysis: alignment.analysis || alignment.warning || ""
      });

      if (!alignment.ok || !alignment.matched || alignment.confidence < alignmentConfidenceFloor) continue;

      matchedCandidate = candidate;
      matchedAlignment = alignment;
      matchedFrameResult = exportFrame;
      break;
    }

    if (matchedCandidate || triedExpansion) break;
    triedExpansion = true;

    const listedViews = addDirectResult(await callBridgeActionDirect(req.session_id, "GET", "/revit/views"));
    if (!listedViews?.ok || !Array.isArray(listedViews.result_json)) break;
    const extraCandidates = (listedViews.result_json as Array<Record<string, unknown>>)
      .map((row) => {
        const id = toFiniteInt(row?.id);
        const name = typeof row?.name === "string" ? row.name.trim() : "";
        const type = typeof row?.type === "string" ? row.type.trim() : "";
        if (id === null || id <= 0 || !name || !type || isViewTypeUnsupportedForExportViewFrame(type)) return null;
        return {
          view_id: id,
          view_name: name,
          view_type: type,
          source: "heuristic"
        } satisfies FastPathViewCandidate;
      })
      .filter(Boolean) as FastPathViewCandidate[];
    viewCandidates = dedupeFastPathViewCandidates([...viewCandidates, ...extraCandidates]);
  }

  if (!matchedCandidate || !matchedAlignment || !matchedFrameResult) {
    noteRedlineFastPathPhase(req.session_id, "preflight_end", { view_match: "deferred" });
    const diagnosticsText = buildRedlineFastPathDiagnosticsText(req.session_id);
    const checkedViews = getRedlineFastPathState(req.session_id).candidate_views_checked;
    return buildFastPreflightViewMismatchFallback({
      toolResults: collectedToolResults,
      diagnosticsText,
      checkedViews
    });
  }

  const refinedAlignmentMarks = refineAlignmentMarksWithImageMarkCrop(
    matchedAlignment,
    getPersistedImageMarkHint(req.session_id)
  );

  semanticCorpus = [
    semanticCorpus,
    matchedAlignment.analysis,
    ...refinedAlignmentMarks.map((mark) => mark.label ?? "")
  ]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n");
  targetProfile = inferRedlineTargetingProfileFromText(semanticCorpus, [], []);

  const viewportHints = refinedAlignmentMarks
    .filter((mark) => mark.score >= 0.2)
    .map((mark) => ({
      view_id: matchedCandidate!.view_id,
      normalized_x: clamp01(mark.normalized_x),
      normalized_y: clamp01(mark.normalized_y),
      score: clamp01(Math.max(mark.score, matchedAlignment!.confidence * 0.75)),
      source: "view_alignment" as const,
      frame_aligned: true
    }));
  if (viewportHints.length > 0) noteViewportPickHints(req.session_id, viewportHints);
  const strongestViewportHint = viewportHints.slice().sort((a, b) => b.score - a.score)[0] ?? null;
  const mappedMarkSide = strongestViewportHint
    ? inferMarkSideFromNormalizedPoint(strongestViewportHint.normalized_x, strongestViewportHint.normalized_y)
    : null;
  if (strongestViewportHint) {
    const rawHint = getPersistedImageMarkHint(req.session_id);
    noteImageMarkHint(req.session_id, {
      normalized_x: strongestViewportHint.normalized_x,
      normalized_y: strongestViewportHint.normalized_y,
      side: mappedMarkSide,
      source: "view_alignment",
      score: strongestViewportHint.score,
      raw_normalized_x: rawHint?.source === "raw_image_mark" ? rawHint.normalized_x : rawHint?.raw_normalized_x ?? null,
      raw_normalized_y: rawHint?.source === "raw_image_mark" ? rawHint.normalized_y : rawHint?.raw_normalized_y ?? null,
      raw_image_width: rawHint?.source === "raw_image_mark" ? rawHint.image_width : rawHint?.raw_image_width ?? null,
      raw_image_height: rawHint?.source === "raw_image_mark" ? rawHint.image_height : rawHint?.raw_image_height ?? null,
      wall_local_normalized_chainage: rawHint?.wall_local_normalized_chainage ?? null,
      wall_local_axis: rawHint?.wall_local_axis ?? null,
      wall_local_span_px: rawHint?.wall_local_span_px ?? null,
      wall_local_source: rawHint?.wall_local_source ?? null
    });
  }
  if (mappedMarkSide && !targetProfile.spatial_side) {
    targetProfile = {
      ...targetProfile,
      spatial_side: mappedMarkSide,
      spatial_side_source: mappedMarkSide
    };
  }
  if (targetProfile.room_number || targetProfile.spatial_side) {
    noteRedlineSpatialTargeting(req.session_id, targetProfile);
  }

  matchedInventoryResult = addDirectResult(
    await callBridgeActionDirect(req.session_id, "POST", "/revit/export-visible-elements", {
      viewId: matchedCandidate.view_id,
      imageSize: 2200,
      includeMapping: true,
      includeGeometry: true,
      includeLinked: true,
      categories: buildRedlineVisibleInventoryCategories(targetProfile),
      limit: 500,
      prioritizeSpatialContext: true,
      includeRoomTags: true,
      includeText: true
    })
  );

  if (matchedInventoryResult?.ok) {
    const markHint = strongestViewportHint
      ? {
          normalized_x: strongestViewportHint.normalized_x,
          normalized_y: strongestViewportHint.normalized_y,
          side: mappedMarkSide,
          source: "view_alignment",
          score: strongestViewportHint.score
        } satisfies ImageMarkHint
      : null;
    const hydratedProfile = hydrateTargetProfileFromVisibleInventory({
      targetProfile,
      toolResults: collectedToolResults,
      markHint,
      mappedMarkSide,
      semanticCorpus,
      allowRoomOverride: !extractSpatialRoomNumber(getRecentUserTextForRedline(req))
    });
    if (
      hydratedProfile.room_number !== targetProfile.room_number ||
      hydratedProfile.spatial_side !== targetProfile.spatial_side ||
      hydratedProfile.spatial_side_source !== targetProfile.spatial_side_source
    ) {
      targetProfile = hydratedProfile;
      noteRedlineSpatialTargeting(req.session_id, targetProfile);
    }
  }

  if (targetProfile.room_number) {
    addDirectResult(
      await callBridgeActionDirect(req.session_id, "POST", "/revit/room-contents", {
        roomNumber: targetProfile.room_number,
        categories: [...FAST_PATH_ELECTRICAL_CATEGORIES],
        mode: "auto",
        verticalScope: "room+plenum",
        spatialKindPreference: "auto",
        includeLinked: true,
        limit: 500
      })
    );
    if (targetProfile.spatial_side) {
      addDirectResult(
        await callBridgeActionDirect(req.session_id, "POST", "/revit/resolve-room-wall", {
          roomNumber: targetProfile.room_number,
          viewId: matchedCandidate.view_id,
          side: targetProfile.spatial_side_source ?? targetProfile.spatial_side,
          maxWalls: 4,
          includeSegments: true
        })
      );
    }
  }

  noteRedlineFastPathPhase(req.session_id, "preflight_end", {
    matched_view_id: matchedCandidate.view_id,
    matched_marks: viewportHints.length
  });

  const inventorySummary = matchedInventoryResult?.ok ? describeVisibleElementsInventory(matchedInventoryResult.result_json) : null;
  const anchorLines = matchedInventoryResult?.ok ? summarizeVisibleInventoryAnchors(matchedInventoryResult.result_json, 6) : [];
  preflightNotes.push(
    `active_view=${activeView.name ?? "unknown"}#${activeView.id ?? "?"} (${activeView.type ?? "unknown"})`,
    `selected_view=${matchedCandidate.view_name}#${matchedCandidate.view_id} (${matchedCandidate.view_type}; source=${matchedCandidate.source})`,
    `view_match_confidence=${matchedAlignment.confidence.toFixed(2)}`,
    `mapped_redline_marks=${viewportHints.length}`,
    `target_room=${targetProfile.room_number ?? "unknown"}`,
    `target_wall_side=${targetProfile.spatial_side_source ?? targetProfile.spatial_side ?? "unknown"}`
  );
  if (matchedAlignment.analysis) preflightNotes.push(`redline_alignment_analysis=${matchedAlignment.analysis.slice(0, 500)}`);
  const markLabels = refinedAlignmentMarks.map((mark) => mark.label).filter(Boolean);
  if (markLabels.length > 0) preflightNotes.push(`redline_mark_labels=${markLabels.join("; ").slice(0, 500)}`);
  if (inventorySummary) {
    preflightNotes.push(
      `visible_inventory=${inventorySummary.count ?? "unknown"} items (sampled ${inventorySummary.sampled}); top_categories=${inventorySummary.topCategories.slice(0, 4).join(", ") || "none"}; top_rooms=${inventorySummary.topRooms.slice(0, 3).join(", ") || "none"}`
    );
  }
  if (anchorLines.length > 0) {
    preflightNotes.push("reference_anchors:");
    for (const line of anchorLines) preflightNotes.push(`- ${line}`);
  }
  const diagnosticsText = buildRedlineFastPathDiagnosticsText(req.session_id);
  return {
    tool_results: collectedToolResults,
    preflight_package_text: preflightNotes.join("\n"),
    diagnostics_text: diagnosticsText,
    blocked_reason: null,
    direct_response: null
  };
}

const READ_ONLY_PATHS = new Set<string>([
  "/revit/ping",
  "/revit/context",
  "/revit/state-snapshot",
  "/revit/computer-use-observe",
  "/revit/views",
  "/revit/capabilities",
  "/revit/tool-registry",
  "/revit/tool-search",
  "/revit/tool-doc",
  "/revit/tool-examples",
  "/revit/native-api-policy",
  "/revit/native-api-catalog",
  "/revit/native-api-search",
  "/revit/self-test",
  "/revit/rooms",
  "/revit/room-contents",
  "/revit/find-elements",
  "/revit/resolve-mep-routing-context",
  "/revit/trace-connected-network",
  "/revit/find-elements-by-parameter",
  "/revit/ducts-by-spatial-scope",
  "/revit/get-connectors",
  "/revit/resolve-room-wall",
  "/revit/rank-similar-devices-on-wall",
  "/revit/project-point-to-host-frame",
  "/revit/pick-candidate-cluster",
  "/revit/export-image",
  "/revit/export-pdf",
  "/revit/export-images",
  "/revit/export-dwg",
  "/revit/export-ifc",
  "/revit/export-view-frame",
  "/revit/export-view-region",
  "/revit/export-visible-elements",
  "/revit/highlight-and-export",
  "/revit/query",
  "/revit/resolve",
  "/revit/get-element-summary",
  "/revit/get-parameters",
  "/revit/quantify",
  "/revit/sheets",
  "/revit/measure-gap",
  "/revit/get-lighting-data",
  "/revit/analyze-dimensions",
  "/revit/spatial-analysis",
  "/revit/fire-damper-audit",
  "/revit/lighting-audit",
  "/revit/query-zone-data",
  "/revit/resize-ductwork-by-scope",
  "/revit/list-element-types",
  "/revit/resolve-element-type",
  "/revit/titleblock-label-map",
  "/revit/titleblock-date-candidates",
  "/revit/verify-parameter-on-sheet",
  "/revit/capture-sheet-region"
]);

const REDLINE_DISCOVERY_PATHS = new Set<string>([
  "/revit/sheets",
  "/revit/context",
  "/revit/find-elements",
  "/revit/get-element-summary",
  "/revit/tool-search",
  "/revit/tool-doc",
  "/revit/tool-examples",
  "/revit/export-view-frame",
  "/revit/export-visible-elements",
  "/revit/resolve-room-wall",
  "/revit/rank-similar-devices-on-wall",
  "/revit/project-point-to-host-frame",
  "/revit/pick-candidate-cluster",
  "/revit/pick-at-pixel"
]);

function pathLooksWrite(pathname: string): boolean {
  const p = (pathname || "").trim().toLowerCase();
  if (!p.startsWith("/revit/")) return false;
  if (READ_ONLY_PATHS.has(p)) return false;
  return true;
}

type LoopPressureState = {
  consecutive_read_only_steps: number;
  consecutive_sheets_steps: number;
  repeated_read_signature_count: number;
  last_read_signature: string;
  updated_at_ms: number;
};

type LoopPressureInfo = {
  hint: string;
  hard_stop: boolean;
  consecutive_read_only_steps: number;
  consecutive_sheets_steps: number;
  repeated_read_signature_count: number;
};

const loopPressureBySession = new Map<string, LoopPressureState>();

type ViewportPickHint = {
  view_id: number;
  normalized_x: number;
  normalized_y: number;
  score: number;
  source?: "view_alignment" | "sheet_viewport_mapping" | "visible_inventory_anchor" | "raw_image_mark" | "unknown";
  frame_aligned?: boolean;
};

type SheetPickHint = {
  normalized_x: number;
  normalized_y: number;
  score: number;
};

type SheetRegionBoxHint = {
  index: number;
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
};

type GeminiIntentHint = {
  region_index: number | null;
  target_type: string;
  intent: string;
  proposed_action: string;
  confidence: number;
};

type AnnotationRegionHint = {
  region_index: number;
  subtype: string;
  is_delete_like: boolean;
  contents: string;
  color?: string;
  related_group?: number | null;
};

type ImageMarkHint = {
  normalized_x: number;
  normalized_y: number;
  side: "left" | "right" | "top" | "bottom" | null;
  score: number;
  source?: "view_alignment" | "sheet_viewport_mapping" | "visible_inventory_anchor" | "raw_image_mark" | "unknown";
  image_width?: number | null;
  image_height?: number | null;
  raw_normalized_x?: number | null;
  raw_normalized_y?: number | null;
  raw_image_width?: number | null;
  raw_image_height?: number | null;
  wall_local_normalized_chainage?: number | null;
  wall_local_axis?: "vertical" | "horizontal" | null;
  wall_local_span_px?: [number, number] | null;
  wall_local_source?: string | null;
};

type FrameAlignedHostTarget = {
  point_xyz: [number, number, number];
  target_chainage_ft: number | null;
  target_normalized_chainage: number | null;
  source: "frame_aligned_redline_projection";
};

type RedlineVisionProgressState = {
  analyzed_files: Set<string>;
  gemini_files: Set<string>;
  oriented_files: Set<string>;
  oriented_with_baseline_files: Set<string>;
  oriented_mapped_files: Set<string>;
  orient_remap_requested_files: Set<string>;
  baseline_export_attempted_files: Set<string>;
  view_alignment_attempted_signatures: Set<string>;
  last_viewport_hints: ViewportPickHint[];
  last_sheet_hints: SheetPickHint[];
  last_sheet_region_boxes: SheetRegionBoxHint[];
  last_gemini_intents: GeminiIntentHint[];
  last_annotation_region_hints: AnnotationRegionHint[];
  last_image_mark_hint: ImageMarkHint | null;
  last_sheet_candidate_ids: number[];
  last_spatial_room_number: string | null;
  last_spatial_side: "left" | "right" | "top" | "bottom" | null;
  last_spatial_side_source: string | null;
  sheet_find_attempted: boolean;
  sheet_summary_attempted: boolean;
  last_file_path: string | null;
  last_expected_sheet: string | null;
  last_filename: string | null;
  updated_at_ms: number;
};

const redlineVisionBySession = new Map<string, RedlineVisionProgressState>();
const REDLINE_VISION_STATE_TTL_MS = 12 * 60 * 60 * 1000;
const redlineRunBundleRehydratedSignatures = new Map<string, string>();

function normalizeWorkspacePath(raw: string): string {
  return (raw ?? "").trim().replace(/\\/g, "/");
}

function normalizeWorkspacePathKey(raw: string): string {
  return normalizeWorkspacePath(raw).toLowerCase();
}

function safeRunBundleSessionDirName(sessionId: string): string {
  const s = (sessionId ?? "").toString().trim();
  if (!s) return "unknown_session";
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function runBundleFileSignature(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return "missing";
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "missing";
  }
}

function getRedlineVisionState(sessionId: string): RedlineVisionProgressState {
  const now = Date.now();
  for (const [sid, st] of redlineVisionBySession) {
    if (!st || typeof st.updated_at_ms !== "number" || now - st.updated_at_ms > REDLINE_VISION_STATE_TTL_MS) {
      redlineVisionBySession.delete(sid);
    }
  }
  const existing = redlineVisionBySession.get(sessionId);
  if (existing) {
    existing.updated_at_ms = now;
    return existing;
  }
  const created: RedlineVisionProgressState = {
    analyzed_files: new Set<string>(),
    gemini_files: new Set<string>(),
    oriented_files: new Set<string>(),
    oriented_with_baseline_files: new Set<string>(),
    oriented_mapped_files: new Set<string>(),
    orient_remap_requested_files: new Set<string>(),
    baseline_export_attempted_files: new Set<string>(),
    view_alignment_attempted_signatures: new Set<string>(),
    last_viewport_hints: [],
    last_sheet_hints: [],
    last_sheet_region_boxes: [],
    last_gemini_intents: [],
    last_annotation_region_hints: [],
    last_image_mark_hint: null,
    last_sheet_candidate_ids: [],
    last_spatial_room_number: null,
    last_spatial_side: null,
    last_spatial_side_source: null,
    sheet_find_attempted: false,
    sheet_summary_attempted: false,
    last_file_path: null,
    last_expected_sheet: null,
    last_filename: null,
    updated_at_ms: now
  };
  redlineVisionBySession.set(sessionId, created);
  return created;
}

function normalizeExpectedSheet(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = normalizeSheetToken(raw);
  return s || null;
}

function noteRedlineSeed(sessionId: string, filePath: string, expectedSheet?: string | null, filename?: string | null): void {
  const rawPath = normalizeWorkspacePath(filePath);
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key || !rawPath) return;
  const st = getRedlineVisionState(sessionId);
  st.last_file_path = rawPath;
  const sheet = normalizeExpectedSheet(expectedSheet ?? null);
  if (sheet) st.last_expected_sheet = sheet;
  if (typeof filename === "string" && filename.trim()) st.last_filename = filename.trim();
  st.updated_at_ms = Date.now();
}

function getRedlineSessionSeed(sessionId: string): { file_path: string; expected_sheet?: string; filename?: string } | null {
  rehydrateRedlineVisionProgressFromRunBundle(sessionId);
  if (!sessionId) return null;
  const st = getRedlineVisionState(sessionId);
  const file = typeof st.last_file_path === "string" ? st.last_file_path.trim() : "";
  if (!file) return null;
  const out: { file_path: string; expected_sheet?: string; filename?: string } = { file_path: file };
  const sh = normalizeExpectedSheet(st.last_expected_sheet ?? null);
  if (sh) out.expected_sheet = sh;
  if (st.last_filename && st.last_filename.trim()) out.filename = st.last_filename.trim();
  return out;
}

function noteRedlineAnalyzeSuccess(sessionId: string, filePath: string, expectedSheet?: string | null, filename?: string | null): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.analyzed_files.add(key);
  // New redline analysis should allow a fresh orient/remap pass for the file.
  st.oriented_files.delete(key);
  st.oriented_with_baseline_files.delete(key);
  st.oriented_mapped_files.delete(key);
  st.orient_remap_requested_files.delete(key);
  st.baseline_export_attempted_files.delete(key);
  noteRedlineSeed(sessionId, filePath, expectedSheet ?? null, filename ?? null);
  st.updated_at_ms = Date.now();
}

function noteRedlineGeminiAttempt(sessionId: string, filePath: string, expectedSheet?: string | null, filename?: string | null): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.gemini_files.add(key);
  noteRedlineSeed(sessionId, filePath, expectedSheet ?? null, filename ?? null);
  st.updated_at_ms = Date.now();
}

function noteRedlineOrientAttempt(sessionId: string, filePath: string, expectedSheet?: string | null, filename?: string | null): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.oriented_files.add(key);
  noteRedlineSeed(sessionId, filePath, expectedSheet ?? null, filename ?? null);
  st.updated_at_ms = Date.now();
}

function noteRedlineOrientMapped(sessionId: string, filePath: string): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.oriented_mapped_files.add(key);
  st.orient_remap_requested_files.delete(key);
  st.updated_at_ms = Date.now();
}

function noteRedlineOrientWithBaseline(sessionId: string, filePath: string): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.oriented_with_baseline_files.add(key);
  st.updated_at_ms = Date.now();
}

function noteRedlineOrientRemapRequested(sessionId: string, filePath: string): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.orient_remap_requested_files.add(key);
  st.updated_at_ms = Date.now();
}

function hasRedlineAnalyzeSuccess(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).analyzed_files.has(key);
}

function hasRedlineGeminiAttempt(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).gemini_files.has(key);
}

function hasRedlineOrientAttempt(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).oriented_files.has(key);
}

function hasRedlineOrientMapped(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).oriented_mapped_files.has(key);
}

function hasRedlineOrientWithBaseline(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).oriented_with_baseline_files.has(key);
}

function hasRedlineOrientRemapRequested(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).orient_remap_requested_files.has(key);
}

function noteRedlineBaselineExportAttempt(sessionId: string, filePath: string): void {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return;
  const st = getRedlineVisionState(sessionId);
  st.baseline_export_attempted_files.add(key);
  st.updated_at_ms = Date.now();
}

function hasRedlineBaselineExportAttempt(sessionId: string, filePath: string): boolean {
  const key = normalizeWorkspacePathKey(filePath);
  if (!sessionId || !key) return false;
  return getRedlineVisionState(sessionId).baseline_export_attempted_files.has(key);
}

function makeRedlineViewAlignmentSignature(filePath: string, frameId: string): string {
  const fileKey = normalizeWorkspacePathKey(filePath);
  const frameKey = (frameId ?? "").trim().toLowerCase();
  return fileKey && frameKey ? `${fileKey}|${frameKey}` : "";
}

function noteRedlineViewAlignmentAttempt(sessionId: string, filePath: string, frameId: string): void {
  const sig = makeRedlineViewAlignmentSignature(filePath, frameId);
  if (!sessionId || !sig) return;
  const st = getRedlineVisionState(sessionId);
  st.view_alignment_attempted_signatures.add(sig);
  st.updated_at_ms = Date.now();
}

function hasRedlineViewAlignmentAttempt(sessionId: string, filePath: string, frameId: string): boolean {
  const sig = makeRedlineViewAlignmentSignature(filePath, frameId);
  if (!sessionId || !sig) return false;
  return getRedlineVisionState(sessionId).view_alignment_attempted_signatures.has(sig);
}

function noteViewportPickHints(sessionId: string, hints: ViewportPickHint[]): void {
  if (!sessionId || !Array.isArray(hints) || hints.length === 0) return;
  const st = getRedlineVisionState(sessionId);
  st.last_viewport_hints = hints
    .filter((h) => h && Number.isFinite(h.view_id))
    .map((h) => ({
      view_id: Math.max(1, Math.round(h.view_id)),
      normalized_x: Math.max(0, Math.min(1, Number(h.normalized_x))),
      normalized_y: Math.max(0, Math.min(1, Number(h.normalized_y))),
      score: Math.max(0, Math.min(1, Number(h.score))),
      source: h.source ?? "unknown",
      frame_aligned: h.frame_aligned === true
    }))
    .slice(0, 20);
  st.updated_at_ms = Date.now();
}

function getPersistedViewportPickHints(sessionId: string): ViewportPickHint[] {
  if (!sessionId) return [];
  const st = getRedlineVisionState(sessionId);
  return Array.isArray(st.last_viewport_hints) ? st.last_viewport_hints.slice(0, 20) : [];
}

function noteSheetPickHints(sessionId: string, hints: SheetPickHint[]): void {
  if (!sessionId || !Array.isArray(hints) || hints.length === 0) return;
  const st = getRedlineVisionState(sessionId);
  st.last_sheet_hints = hints
    .filter((h) => h && Number.isFinite(h.normalized_x) && Number.isFinite(h.normalized_y))
    .map((h) => ({
      normalized_x: Math.max(0, Math.min(1, Number(h.normalized_x))),
      normalized_y: Math.max(0, Math.min(1, Number(h.normalized_y))),
      score: Math.max(0, Math.min(1, Number(h.score)))
    }))
    .slice(0, 40);
  st.updated_at_ms = Date.now();
}

function getPersistedSheetPickHints(sessionId: string): SheetPickHint[] {
  if (!sessionId) return [];
  const st = getRedlineVisionState(sessionId);
  return Array.isArray(st.last_sheet_hints) ? st.last_sheet_hints.slice(0, 40) : [];
}

function noteSheetRegionBoxes(sessionId: string, boxes: SheetRegionBoxHint[]): void {
  if (!sessionId || !Array.isArray(boxes) || boxes.length === 0) return;
  const st = getRedlineVisionState(sessionId);
  st.last_sheet_region_boxes = boxes.slice(0, 80);
  st.updated_at_ms = Date.now();
}

function getPersistedSheetRegionBoxes(sessionId: string): SheetRegionBoxHint[] {
  if (!sessionId) return [];
  const st = getRedlineVisionState(sessionId);
  return Array.isArray(st.last_sheet_region_boxes) ? st.last_sheet_region_boxes.slice(0, 80) : [];
}

function noteGeminiIntentHints(sessionId: string, intents: GeminiIntentHint[]): void {
  if (!sessionId || !Array.isArray(intents) || intents.length === 0) return;
  const st = getRedlineVisionState(sessionId);
  st.last_gemini_intents = intents.slice(0, 80);
  st.updated_at_ms = Date.now();
}

function getPersistedGeminiIntentHints(sessionId: string): GeminiIntentHint[] {
  if (!sessionId) return [];
  const st = getRedlineVisionState(sessionId);
  return Array.isArray(st.last_gemini_intents) ? st.last_gemini_intents.slice(0, 80) : [];
}

function noteAnnotationRegionHints(sessionId: string, hints: AnnotationRegionHint[]): void {
  if (!sessionId || !Array.isArray(hints) || hints.length === 0) return;
  const st = getRedlineVisionState(sessionId);
  const out: AnnotationRegionHint[] = [];
  const seen = new Set<string>();
  for (const h of hints) {
    if (!h || !Number.isFinite(h.region_index)) continue;
    const idx = Math.max(1, Math.floor(h.region_index));
    const subtype = typeof h.subtype === "string" ? h.subtype.trim() : "";
    if (!subtype) continue;
    const key = `${idx}|${subtype.toLowerCase()}|${(h.contents ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      region_index: idx,
      subtype,
      is_delete_like: !!h.is_delete_like,
      contents: typeof h.contents === "string" ? h.contents.trim().slice(0, 240) : "",
      ...(typeof h.color === "string" && h.color.trim() ? { color: h.color.trim() } : {}),
      ...(Number.isFinite(h.related_group as number) ? { related_group: Math.max(1, Math.floor(Number(h.related_group))) } : {})
    });
    if (out.length >= 120) break;
  }
  if (out.length === 0) return;
  st.last_annotation_region_hints = out;
  st.updated_at_ms = Date.now();
}

function getPersistedAnnotationRegionHints(sessionId: string): AnnotationRegionHint[] {
  if (!sessionId) return [];
  const st = getRedlineVisionState(sessionId);
  return Array.isArray(st.last_annotation_region_hints) ? st.last_annotation_region_hints.slice(0, 120) : [];
}

function noteImageMarkHint(sessionId: string, hint: ImageMarkHint): void {
  if (!sessionId || !hint || !Number.isFinite(hint.normalized_x) || !Number.isFinite(hint.normalized_y)) return;
  const st = getRedlineVisionState(sessionId);
  const previous = st.last_image_mark_hint;
  const previousWasRaw =
    previous?.source === "raw_image_mark" &&
    Number.isFinite(previous.normalized_x) &&
    Number.isFinite(previous.normalized_y);
  if (previousWasRaw && hint.source !== "raw_image_mark") {
    hint = {
      ...hint,
      raw_normalized_x: Number.isFinite(hint.raw_normalized_x as number) ? hint.raw_normalized_x : previous!.normalized_x,
      raw_normalized_y: Number.isFinite(hint.raw_normalized_y as number) ? hint.raw_normalized_y : previous!.normalized_y,
      raw_image_width: Number.isFinite(hint.raw_image_width as number) ? hint.raw_image_width : previous!.image_width ?? null,
      raw_image_height: Number.isFinite(hint.raw_image_height as number) ? hint.raw_image_height : previous!.image_height ?? null,
      wall_local_normalized_chainage: Number.isFinite(hint.wall_local_normalized_chainage as number)
        ? hint.wall_local_normalized_chainage
        : previous!.wall_local_normalized_chainage ?? null,
      wall_local_axis: hint.wall_local_axis ?? previous!.wall_local_axis ?? null,
      wall_local_span_px: hint.wall_local_span_px ?? previous!.wall_local_span_px ?? null,
      wall_local_source: hint.wall_local_source ?? previous!.wall_local_source ?? null
    };
  }
  const side = hint.side ? normalizeSpatialWallSide(hint.side) : null;
  st.last_image_mark_hint = {
    normalized_x: Math.max(0, Math.min(1, Number(hint.normalized_x))),
    normalized_y: Math.max(0, Math.min(1, Number(hint.normalized_y))),
    side,
    score: Math.max(0, Math.min(1, Number(hint.score) || 0.55)),
    source: hint.source ?? (hint.image_width || hint.image_height ? "raw_image_mark" : "unknown"),
    image_width: Number.isFinite(hint.image_width as number) && Number(hint.image_width) > 0 ? Number(hint.image_width) : null,
    image_height: Number.isFinite(hint.image_height as number) && Number(hint.image_height) > 0 ? Number(hint.image_height) : null,
    raw_normalized_x: Number.isFinite(hint.raw_normalized_x as number) ? Math.max(0, Math.min(1, Number(hint.raw_normalized_x))) : null,
    raw_normalized_y: Number.isFinite(hint.raw_normalized_y as number) ? Math.max(0, Math.min(1, Number(hint.raw_normalized_y))) : null,
    raw_image_width: Number.isFinite(hint.raw_image_width as number) && Number(hint.raw_image_width) > 0 ? Number(hint.raw_image_width) : null,
    raw_image_height: Number.isFinite(hint.raw_image_height as number) && Number(hint.raw_image_height) > 0 ? Number(hint.raw_image_height) : null,
    wall_local_normalized_chainage: Number.isFinite(hint.wall_local_normalized_chainage as number)
      ? Math.max(0.04, Math.min(0.96, Number(hint.wall_local_normalized_chainage)))
      : null,
    wall_local_axis: hint.wall_local_axis === "vertical" || hint.wall_local_axis === "horizontal" ? hint.wall_local_axis : null,
    wall_local_span_px: Array.isArray(hint.wall_local_span_px) && hint.wall_local_span_px.length >= 2
      ? [
          Math.round(Number(hint.wall_local_span_px[0])),
          Math.round(Number(hint.wall_local_span_px[1]))
        ]
      : null,
    wall_local_source: typeof hint.wall_local_source === "string" && hint.wall_local_source.trim()
      ? hint.wall_local_source.trim().slice(0, 80)
      : null
  };
  if (side && !st.last_spatial_side) {
    st.last_spatial_side = side;
    st.last_spatial_side_source = side;
  }
  st.updated_at_ms = Date.now();
}

function getPersistedImageMarkHint(sessionId: string): ImageMarkHint | null {
  rehydrateRedlineVisionProgressFromRunBundle(sessionId);
  if (!sessionId) return null;
  const hint = getRedlineVisionState(sessionId).last_image_mark_hint;
  return hint ? { ...hint } : null;
}

function workbenchResultFromPersistedToolOutput(row: Record<string, unknown>): WorkbenchActionResult | null {
  const tool = typeof row.tool === "string" ? row.tool.trim() : "";
  if (!tool.startsWith("workbench.")) return null;
  const type = tool.slice("workbench.".length);
  if (type !== "analyze_redline" && type !== "redline_orient" && type !== "gemini_redline_analyze") return null;
  const result = row.result && typeof row.result === "object" && !Array.isArray(row.result)
    ? (row.result as Record<string, unknown>)
    : null;
  if (!result) return null;
  return {
    index: Number.isFinite(result.index as number) ? Number(result.index) : 1,
    type: type as WorkbenchActionResult["type"],
    ok: row.status === "success" || row.status === "done" || row.status === "ok",
    summary: typeof result.summary === "string" ? result.summary : "",
    details: result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined
  };
}

function rehydrateRedlineVisionProgressFromRunBundle(sessionId: string): void {
  if (!sessionId) return;

  let sessionDir = "";
  try {
    sessionDir = path.join(ensureWorkspaceLayout().runsSessions, safeRunBundleSessionDirName(sessionId));
  } catch {
    return;
  }

  const requestLogPath = path.join(sessionDir, "request_log.jsonl");
  const toolOutputsPath = path.join(sessionDir, "tool_outputs.jsonl");
  if (!fs.existsSync(requestLogPath) && !fs.existsSync(toolOutputsPath)) return;
  const signature = `${runBundleFileSignature(requestLogPath)}|${runBundleFileSignature(toolOutputsPath)}`;
  if (redlineRunBundleRehydratedSignatures.get(sessionId) === signature) return;
  redlineRunBundleRehydratedSignatures.set(sessionId, signature);

  try {
    if (fs.existsSync(requestLogPath)) {
      const raw = fs.readFileSync(requestLogPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.includes("user_attachments")) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
        const attachments = Array.isArray(rec?.user_attachments) ? rec.user_attachments : [];
        for (const a of attachments) {
          if (!a || typeof a !== "object") continue;
          const row = a as Record<string, unknown>;
          const rel = typeof row.relative_path === "string" ? row.relative_path.trim() : "";
          if (!rel || !isRedlineAttachmentPath(rel)) continue;
          const filename = typeof row.filename === "string" && row.filename.trim() ? row.filename.trim() : path.basename(rel);
          noteRedlineSeed(sessionId, rel, null, filename);
        }
      }
    }
  } catch {
    // Rehydration is best-effort; in-memory state remains authoritative.
  }

  try {
    if (!fs.existsSync(toolOutputsPath)) return;
    const raw = fs.readFileSync(toolOutputsPath, "utf8");
    const workbenchResults: WorkbenchActionResult[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.includes("workbench.")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      if (!rec || rec.kind !== "mcp.tool_result") continue;
      const wb = workbenchResultFromPersistedToolOutput(rec);
      if (wb) workbenchResults.push(wb);
    }
    if (workbenchResults.length > 0) updateRedlineVisionProgressFromWorkbench(sessionId, workbenchResults);
  } catch {
    // Ignore corrupt/large run-bundle records; normal live request state still applies.
  }
}

function extractImageMarkHintFromAnalyzeDetails(details: Record<string, unknown> | null | undefined): ImageMarkHint | null {
  if (!details) return null;
  const meta = details.image_meta && typeof details.image_meta === "object"
    ? (details.image_meta as Record<string, unknown>)
    : null;
  const width = toFiniteNumber(meta?.width);
  const height = toFiniteNumber(meta?.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  const marks = Array.isArray(details.mark_regions) ? details.mark_regions : [];
  const best = marks
    .map((mark) => {
      if (!mark || typeof mark !== "object" || Array.isArray(mark)) return null;
      const row = mark as Record<string, unknown>;
      const x = toFiniteNumber(row.x);
      const y = toFiniteNumber(row.y);
      const w = toFiniteNumber(row.w);
      const h = toFiniteNumber(row.h);
      const area = toFiniteNumber(row.area) ?? ((w ?? 0) * (h ?? 0));
      if (x === null || y === null || w === null || h === null) return null;
      if (w <= 0 || h <= 0 || area <= 0) return null;
      return {
        x,
        y,
        w,
        h,
        area,
        wall_local_normalized_chainage: toFiniteNumber(row.wall_local_normalized_chainage),
        wall_local_axis:
          row.wall_local_axis === "vertical" || row.wall_local_axis === "horizontal" ? row.wall_local_axis : null,
        wall_local_span_px: Array.isArray(row.wall_local_span_px)
          ? row.wall_local_span_px
              .map((v) => toFiniteNumber(v))
              .filter((v): v is number => v !== null)
              .slice(0, 2)
          : null,
        wall_local_source:
          typeof row.wall_local_source === "string" && row.wall_local_source.trim()
            ? row.wall_local_source.trim()
            : null
      };
    })
    .filter((mark): mark is {
      x: number;
      y: number;
      w: number;
      h: number;
      area: number;
      wall_local_normalized_chainage: number | null;
      wall_local_axis: "vertical" | "horizontal" | null;
      wall_local_span_px: number[] | null;
      wall_local_source: string | null;
    } => !!mark)
    .sort((a, b) => b.area - a.area)[0] ?? null;
  if (!best) return null;
  const normalizedX = clamp01((best.x + best.w * 0.5) / width);
  const normalizedY = clamp01((best.y + best.h * 0.5) / height);
  return {
    normalized_x: normalizedX,
    normalized_y: normalizedY,
    side: inferMarkSideFromNormalizedPoint(normalizedX, normalizedY),
    score: 0.72,
    source: "raw_image_mark",
    image_width: width,
    image_height: height,
    wall_local_normalized_chainage: best.wall_local_normalized_chainage,
    wall_local_axis: best.wall_local_axis,
    wall_local_span_px: best.wall_local_span_px?.length === 2
      ? [Math.round(best.wall_local_span_px[0]!), Math.round(best.wall_local_span_px[1]!)]
      : null,
    wall_local_source: best.wall_local_source
  };
}

function noteSheetCandidateIds(sessionId: string, ids: number[]): void {
  if (!sessionId || !Array.isArray(ids) || ids.length === 0) return;
  const st = getRedlineVisionState(sessionId);
  const seen = new Set<number>();
  const next: number[] = [];
  for (const raw of ids) {
    const id = toFiniteInt(raw);
    if (id === null || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= 200) break;
  }
  if (next.length === 0) return;
  st.last_sheet_candidate_ids = next;
  st.updated_at_ms = Date.now();
}

function getPersistedSheetCandidateIds(sessionId: string): number[] {
  if (!sessionId) return [];
  const st = getRedlineVisionState(sessionId);
  return Array.isArray(st.last_sheet_candidate_ids) ? st.last_sheet_candidate_ids.slice(0, 200) : [];
}

function noteRedlineSpatialTargeting(sessionId: string, profile: {
  room_number?: string | null;
  spatial_side?: "left" | "right" | "top" | "bottom" | null;
  spatial_side_source?: string | null;
}): void {
  if (!sessionId) return;
  const roomNumber = typeof profile.room_number === "string" && profile.room_number.trim()
    ? profile.room_number.trim().toUpperCase()
    : null;
  const spatialSide = profile.spatial_side ?? null;
  const spatialSideSource = typeof profile.spatial_side_source === "string" && profile.spatial_side_source.trim()
    ? profile.spatial_side_source.trim().toLowerCase()
    : null;
  if (!roomNumber && !spatialSide && !spatialSideSource) return;
  const st = getRedlineVisionState(sessionId);
  if (roomNumber) st.last_spatial_room_number = roomNumber;
  if (spatialSide) st.last_spatial_side = spatialSide;
  if (spatialSideSource) st.last_spatial_side_source = spatialSideSource;
  st.updated_at_ms = Date.now();
}

function getPersistedRedlineSpatialTargeting(sessionId: string): {
  room_number: string | null;
  spatial_side: "left" | "right" | "top" | "bottom" | null;
  spatial_side_source: string | null;
} {
  if (!sessionId) {
    return {
      room_number: null,
      spatial_side: null,
      spatial_side_source: null
    };
  }
  const st = getRedlineVisionState(sessionId);
  return {
    room_number: st.last_spatial_room_number ?? null,
    spatial_side: st.last_spatial_side ?? null,
    spatial_side_source: st.last_spatial_side_source ?? null
  };
}

function markSheetFindAttempt(sessionId: string): void {
  if (!sessionId) return;
  const st = getRedlineVisionState(sessionId);
  st.sheet_find_attempted = true;
  st.updated_at_ms = Date.now();
}

function markSheetSummaryAttempt(sessionId: string): void {
  if (!sessionId) return;
  const st = getRedlineVisionState(sessionId);
  st.sheet_summary_attempted = true;
  st.updated_at_ms = Date.now();
}

function hasSheetFindAttempt(sessionId: string): boolean {
  if (!sessionId) return false;
  return getRedlineVisionState(sessionId).sheet_find_attempted === true;
}

function hasSheetSummaryAttempt(sessionId: string): boolean {
  if (!sessionId) return false;
  return getRedlineVisionState(sessionId).sheet_summary_attempted === true;
}

function toolResultLooksReadOnly(r: ToolResult): boolean {
  if (!r || typeof r !== "object") return false;
  if (r.method === "GET") return true;
  if (r.method === "POST") return !pathLooksWrite(r.path ?? "");
  return false;
}

function normalizeReadSignature(toolResults: ToolResult[]): string {
  const keys = toolResults
    .filter(toolResultLooksReadOnly)
    .map((r) => `${r.method} ${String(r.path ?? "").trim().toLowerCase()}`)
    .filter((x) => !!x)
    .sort();
  return keys.join(" | ");
}

function resetLoopPressure(sessionId: string): void {
  loopPressureBySession.delete(sessionId);
}

function updateLoopPressure(req: ChatRequest): LoopPressureInfo | null {
  const sessionId = (req.session_id ?? "").trim();
  if (!sessionId) return null;

  const now = Date.now();
  const existing = loopPressureBySession.get(sessionId) ?? {
    consecutive_read_only_steps: 0,
    consecutive_sheets_steps: 0,
    repeated_read_signature_count: 0,
    last_read_signature: "",
    updated_at_ms: now
  };

  const userText = (req.user_text ?? "").trim();
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];

  // Fresh user turn without tool-loop continuation: clear pressure counters.
  if (userText && toolResults.length === 0) {
    resetLoopPressure(sessionId);
    return null;
  }

  if (toolResults.length === 0) {
    existing.updated_at_ms = now;
    loopPressureBySession.set(sessionId, existing);
  } else {
    const hasWrite = toolResults.some((r) => r?.method === "POST" && pathLooksWrite(r.path ?? ""));
    const allReadOnly = toolResults.every(toolResultLooksReadOnly);

    if (hasWrite || !allReadOnly) {
      existing.consecutive_read_only_steps = 0;
      existing.consecutive_sheets_steps = 0;
      existing.repeated_read_signature_count = 0;
      existing.last_read_signature = "";
      existing.updated_at_ms = now;
      loopPressureBySession.set(sessionId, existing);
      return null;
    }

    const onlySheets = toolResults.every((r) => (r.path ?? "").trim().toLowerCase() === "/revit/sheets");
    existing.consecutive_read_only_steps += 1;
    existing.consecutive_sheets_steps = onlySheets ? existing.consecutive_sheets_steps + 1 : 0;

    const sig = normalizeReadSignature(toolResults);
    if (sig && sig === existing.last_read_signature) existing.repeated_read_signature_count += 1;
    else existing.repeated_read_signature_count = sig ? 1 : 0;
    existing.last_read_signature = sig;
    existing.updated_at_ms = now;
    loopPressureBySession.set(sessionId, existing);
  }

  const warn =
    existing.consecutive_read_only_steps >= 5 ||
    (existing.consecutive_sheets_steps >= 4 && existing.repeated_read_signature_count >= 3);
  if (!warn) return null;

  const hardStop =
    existing.consecutive_read_only_steps >= 8 ||
    (existing.consecutive_sheets_steps >= 6 && existing.repeated_read_signature_count >= 4);

  const hint =
    `Loop guard: ${existing.consecutive_read_only_steps} consecutive read-only step(s)` +
    ` (${existing.consecutive_sheets_steps} consecutive /revit/sheets step(s), read-signature repeat ${existing.repeated_read_signature_count}x).` +
    " Stop discovery churn. Next response must either perform a concrete write action toward the pinned goal or ask one targeted clarifying question.";

  return {
    hint,
    hard_stop: hardStop,
    consecutive_read_only_steps: existing.consecutive_read_only_steps,
    consecutive_sheets_steps: existing.consecutive_sheets_steps,
    repeated_read_signature_count: existing.repeated_read_signature_count
  };
}

function containsVerificationAction(actions: Array<{ method: "GET" | "POST"; path: string }>): boolean {
  for (const a of actions) {
    if (a.method !== "POST") continue;
    const p = (a.path || "").trim().toLowerCase();
    if (p === "/revit/verify-parameter-on-sheet" || p === "/revit/capture-sheet-region" || p === "/revit/export-image" || p === "/revit/export-view-region") {
      return true;
    }
  }
  return false;
}

function maybeAppendVerificationGuardMessage(base: string, actions: Array<{ method: "GET" | "POST"; path: string }>): string {
  const hasWrite = actions.some(a => a.method === "POST" && pathLooksWrite(a.path));
  if (!hasWrite) return base;
  const hasVerify = containsVerificationAction(actions);
  if (hasVerify) {
    return `${base}\n\nVerification plan: run write actions first, then verify using post-change evidence captures.`;
  }
  return base;
}

function collectWorkspaceArtifactRelativePaths(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 7 || out.size >= 24) return;
  if (typeof node === "string") {
    const v = node.trim().replace(/\\/g, "/");
    if (!v) return;
    if (v.startsWith("artifacts/")) out.add(v);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectWorkspaceArtifactRelativePaths(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const value of Object.values(node as Record<string, unknown>)) {
    collectWorkspaceArtifactRelativePaths(value, out, depth + 1);
    if (out.size >= 24) break;
  }
}

function resultLooksDryRun(r: ToolResult): boolean {
  const p = (r.path ?? "").trim().toLowerCase();
  if (!r.result_json || typeof r.result_json !== "object") return false;
  const obj = r.result_json as Record<string, unknown>;
  const dryRun = obj.dryRun;
  if (typeof dryRun === "boolean") return dryRun;
  if (p === "/revit/delete" || p === "/revit/move-elements" || p === "/revit/rotate-elements") {
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
    if (status.includes("dry run")) return true;
  }
  return false;
}

function collectRecentPostWriteEvidence(toolResults: ToolResult[]): {
  has_applied_write: boolean;
  has_post_write_verification: boolean;
  evidence_paths: string[];
} {
  let lastWriteIndex = -1;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || r.method !== "POST") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!pathLooksWrite(r.path ?? "")) continue;
    if (resultLooksDryRun(r)) continue;
    lastWriteIndex = i;
    break;
  }

  if (lastWriteIndex < 0) {
    return { has_applied_write: false, has_post_write_verification: false, evidence_paths: [] };
  }

  const evidencePaths = new Set<string>();
  let hasVerificationAction = false;
  for (let i = lastWriteIndex + 1; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (!r || r.method !== "POST") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const p = (r.path ?? "").trim().toLowerCase();
    if (
      p === "/revit/export-pdf" ||
      p === "/revit/export-image" ||
      p === "/revit/export-view-region" ||
      p === "/revit/capture-sheet-region" ||
      p === "/revit/verify-parameter-on-sheet"
    ) {
      hasVerificationAction = true;
      collectWorkspaceArtifactRelativePaths(r.result_json, evidencePaths);
    }
  }

  return {
    has_applied_write: true,
    has_post_write_verification: hasVerificationAction,
    evidence_paths: [...evidencePaths].slice(0, 6)
  };
}

function collectRecentStaleElementIds(toolResults: ToolResult[]): number[] {
  const stale = new Set<number>();
  for (const result of toolResults) {
    if (!result) continue;
    const pathName = `${result.path ?? ""}`.trim().toLowerCase();
    const payload = result.result_json;
    if (pathName === "/revit/get-element-summary" && Array.isArray(payload)) {
      for (const row of payload) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const found = typeof record.found === "boolean" ? record.found : null;
        const id = typeof record.id === "number" && Number.isFinite(record.id) ? Math.round(record.id) : null;
        if (found === false && id && id > 0) stale.add(id);
      }
      continue;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const candidates = [
      record.missingAfterElementIds,
      record.missing_ids,
      record.missingElementIds
    ];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      for (const value of candidate) {
        const id = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
        if (id && id > 0) stale.add(id);
      }
    }
  }
  return [...stale].slice(0, 12);
}

function shouldAttachImages(req: ChatRequest): boolean {
  const text = ((req.user_text ?? "") as string).toLowerCase();
  const serverCtx = (req.context as any)?.__server;
  const hasUserImage = Array.isArray(req.user_attachments)
    ? req.user_attachments.some(a => {
        const rp = typeof a?.relative_path === "string" ? a.relative_path.toLowerCase() : "";
        return rp.endsWith(".png") || rp.endsWith(".jpg") || rp.endsWith(".jpeg");
      })
    : false;
  const hasToolImage =
    Array.isArray(req.tool_results) &&
    req.tool_results.some(r => Array.isArray(r.attachments) && r.attachments.some(a => (a as any)?.kind === "image"));
  const hasWorkbenchImagePaths =
    Array.isArray(serverCtx?.workbench_inline_image_paths) &&
    (serverCtx.workbench_inline_image_paths as unknown[]).some(x => typeof x === "string" && x.trim().length > 0);
  if (hasUserImage) return true;
  if (hasWorkbenchImagePaths) return true;
  if (!hasToolImage) return false;
  const hasVisualToolEvidence =
    Array.isArray(req.tool_results) &&
    req.tool_results.some((r) => {
      const p = (r?.path ?? "").trim().toLowerCase();
      return (
        p === "/revit/export-view-frame" ||
        p === "/revit/export-view-region" ||
        p === "/revit/export-image" ||
        p === "/revit/export-visible-elements" ||
        p === "/revit/capture-sheet-region"
      );
    });
  const postWriteEvidence = Array.isArray(req.tool_results) ? collectRecentPostWriteEvidence(req.tool_results) : null;
  if (postWriteEvidence?.has_post_write_verification) return true;
  if (hasVisualToolEvidence && isRedlineFocusedTurn(req)) return true;

  const visualIntentHints = ["image", "screenshot", "capture", "redline", "verify", "visual", "see", "look", "sheet"];
  return visualIntentHints.some(h => text.includes(h));
}

function readWorkspaceImageDataUrl(relativePath: string, maxBytes: number): string | null {
  try {
    const rp = (relativePath ?? "").trim();
    if (!rp) return null;
    const ext = path.extname(rp).toLowerCase();
    if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") return null;
    const full = resolveExistingFileUnderWorkspace(rp);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    const base64 = fs.readFileSync(full).toString("base64");
    if (!base64) return null;
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

function shouldIncludeSkillLibrary(req: ChatRequest): boolean {
  const mode = (process.env.OPERATOR_PROMPT_INCLUDE_SKILLS || "auto").trim().toLowerCase();
  if (mode === "0" || mode === "false" || mode === "off") return false;
  if (mode === "1" || mode === "true" || mode === "always") return true;
  const t = ((req.user_text ?? "") as string).toLowerCase();
  const hints = ["skill", "workflow", "runbook", "how do we", "policy", "procedure", "standard", "process"];
  return hints.some(h => t.includes(h));
}

function imageDetailFromReq(req: ChatRequest): "low" | "high" | "auto" {
  const text = ((req.user_text ?? "") as string).toLowerCase();
  const wantsHigh = text.includes("ocr") || text.includes("read text") || text.includes("small text") || text.includes("fine print");
  if (wantsHigh) return "high";
  return "auto";
}

function normalizeSheetToken(raw: string): string {
  const t = (raw ?? "").toUpperCase().trim();
  if (!t) return "";
  let n = t.replace(/\s+/g, "");
  n = n.replace(/_/g, ".");
  n = n.replace(/-+/g, "-");
  n = n.replace(/[^\w.\-]/g, "");
  if (!n) return "";
  if (/^\d{4}$/.test(n)) return "";
  if (/^\d+(\.\d+)?$/.test(n)) return "";
  if (!/[A-Z]/.test(n) || !/\d/.test(n)) return "";
  if (n.length < 2 || n.length > 16) return "";
  return n;
}

function extractAttachmentFilenameSheetHints(req: ChatRequest): Array<{ file: string; sheet: string }> {
  const out: Array<{ file: string; sheet: string }> = [];
  const seen = new Set<string>();
  const atts = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  const pattern = /(?:^|[^A-Z0-9])([A-Z]{1,4}\s*[-_.]?\s*\d{1,4}(?:\s*[.-]\s*\d{1,3})?)(?=$|[^A-Z0-9])/gi;

  for (const a of atts.slice(0, 20)) {
    const nameRaw =
      (typeof a?.filename === "string" && a.filename.trim()) ||
      (typeof a?.relative_path === "string" && path.basename(a.relative_path.trim())) ||
      "";
    if (!nameRaw) continue;
    const stem = nameRaw.replace(/\.[^.]+$/, "");

    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stem)) !== null) {
      const token = normalizeSheetToken((m[1] ?? "").trim());
      if (!token) continue;
      if (/^(ROOM|RM|UNIT|SUITE)[-_.]?\d/.test(token)) continue;
      const key = `${nameRaw.toLowerCase()}::${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: nameRaw, sheet: token });
      break; // keep one best hint per file
    }
  }

  return out.slice(0, 8);
}

function isRedlineAttachmentPath(p: string): boolean {
  const ext = path.extname((p ?? "").trim().toLowerCase());
  return ext === ".pdf" || ext === ".png" || ext === ".jpg" || ext === ".jpeg";
}

function userTextLooksRedline(req: ChatRequest): boolean {
  const t = ((req.user_text ?? "") as string).toLowerCase();
  if (!t) return false;
  const hints = [
    "redline",
    "red line",
    "markup",
    "mark-up",
    "pick up",
    "pickup",
    "cloud",
    "comment bubble",
    "where indicated",
    "where shown",
    "as indicated",
    "as shown",
    "where marked",
    "as marked",
    "marked here",
    "shown here",
    "indicated here"
  ];
  return hints.some(h => t.includes(h));
}

function userTextLooksRedlineContinuation(req: ChatRequest): boolean {
  const t = ((req.user_text ?? "") as string).toLowerCase().trim();
  if (!t) return false;
  if (userTextLooksRedline(req)) return true;
  const hints = [
    "all comments are on",
    "active sheet",
    "apply all",
    "apply it",
    "go ahead",
    "proceed",
    "still working",
    "are you stuck",
    "yes",
    "yeah",
    "yep",
    "ok",
    "okay"
  ];
  return hints.some(h => t.includes(h));
}

function hasRedlineAttachment(req: ChatRequest): boolean {
  const atts = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  for (const a of atts) {
    const rel = typeof a?.relative_path === "string" ? a.relative_path.trim() : "";
    if (rel && isRedlineAttachmentPath(rel)) return true;
  }
  return false;
}

function isRedlineFocusedTurn(req: ChatRequest): boolean {
  if (hasRedlineAttachment(req)) return true;
  if (userTextLooksRedline(req) || userTextLooksRedlineContinuation(req)) return true;
  const remembered = getRedlineSessionSeed(req.session_id);
  if (!remembered) return false;
  const text = ((req.user_text ?? "") as string).trim();
  const hasToolResults = Array.isArray(req.tool_results) && req.tool_results.length > 0;
  return !text || hasToolResults;
}

function userRequestsRedlineDiagnostics(req: ChatRequest): boolean {
  const t = ((req.user_text ?? "") as string).toLowerCase().trim();
  if (!t) return false;
  const hints = [
    "pause",
    "feedback",
    "recommendation",
    "recommendations",
    "what happened",
    "why did",
    "debug",
    "investigate",
    "backend dev",
    "postmortem",
    "root cause"
  ];
  return hints.some((h) => t.includes(h));
}

function userRequestsRedlineDiagnosticsOnly(req: ChatRequest): boolean {
  const t = ((req.user_text ?? "") as string).toLowerCase().trim();
  if (!t) return false;
  const diagnosticIntent =
    /\b(provide|send|give|write|capture)\s+(?:dev\s+)?feedback\b/.test(t) ||
    /\bfeedback\s+(?:to|for)\s+(?:the\s+)?(?:dev|developer|backend)\b/.test(t) ||
    /\b(postmortem|root cause|what happened|why did)\b/.test(t);
  if (!diagnosticIntent) return false;
  return !/\b(continue|keep working|try again|retry|correct it|fix it|apply|delete|place|add|move|circuit\s+to)\b/.test(t);
}

function decisionLooksReadOnlyDiscovery(decision: OpenAiDecision): boolean {
  const acts = Array.isArray(decision.actions) ? decision.actions : [];
  if (acts.length === 0) return true;
  return acts.every((a) => {
    const method = a?.method === "POST" ? "POST" : "GET";
    const p = String(a?.path ?? "").trim().toLowerCase();
    if (method === "GET") return true;
    if (method === "POST" && !pathLooksWrite(p)) {
      return p === "/revit/sheets" || p === "/revit/context" || p === "/revit/tool-search" || p === "/revit/tool-doc" || p === "/revit/tool-examples";
    }
    return false;
  });
}

function pickRedlineAttachmentSeed(req: ChatRequest): { file_path: string; expected_sheet?: string } | null {
  const atts = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  if (atts.length === 0) return null;
  const hints = extractAttachmentFilenameSheetHints(req);
  const hintByFile = new Map<string, string>();
  for (const h of hints) {
    const k = (h.file ?? "").trim().toLowerCase();
    if (k && h.sheet) hintByFile.set(k, h.sheet);
  }

  for (const a of atts) {
    const rel = typeof a.relative_path === "string" ? a.relative_path.trim() : "";
    if (!rel || !isRedlineAttachmentPath(rel)) continue;
    const filename =
      (typeof a.filename === "string" && a.filename.trim()) ||
      path.basename(rel);
    const expectedFromName = hintByFile.get(filename.toLowerCase()) ?? hints[0]?.sheet;
    const seed = {
      file_path: rel,
      ...(expectedFromName ? { expected_sheet: expectedFromName } : {})
    };
    noteRedlineSeed(req.session_id, rel, expectedFromName ?? null, filename);
    return seed;
  }
  return null;
}

function pickRedlineSeed(req: ChatRequest, opts?: { allowSessionFallback?: boolean }): { file_path: string; expected_sheet?: string } | null {
  const byAttachment = pickRedlineAttachmentSeed(req);
  if (byAttachment) return byAttachment;

  if (!opts?.allowSessionFallback) return null;
  const hasContinuationContext =
    userTextLooksRedline(req) ||
    userTextLooksRedlineContinuation(req) ||
    (((req.user_text ?? "").trim() === "" || userTextLooksRedline(req)) && Array.isArray(req.tool_results) && req.tool_results.length > 0);
  if (!hasContinuationContext) return null;

  const fromState = getRedlineSessionSeed(req.session_id);
  if (!fromState) return null;
  return {
    file_path: fromState.file_path,
    ...(fromState.expected_sheet ? { expected_sheet: fromState.expected_sheet } : {})
  };
}

function asToolResult(raw: unknown): ToolResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const actionId = typeof r.action_id === "string" && r.action_id.trim() ? r.action_id.trim() : randomUUID();
  const methodRaw = typeof r.method === "string" ? r.method.trim().toUpperCase() : "";
  const method: "GET" | "POST" = methodRaw === "GET" ? "GET" : "POST";
  const path = typeof r.path === "string" ? r.path.trim() : "";
  if (!path) return null;
  const statusRaw = typeof r.status === "string" ? r.status.trim().toLowerCase() : "";
  const status: "done" | "failed" = statusRaw === "failed" ? "failed" : "done";
  const out: ToolResult = {
    action_id: actionId,
    method,
    path,
    status
  };
  if (Object.prototype.hasOwnProperty.call(r, "result_json")) out.result_json = r.result_json;
  if (typeof r.error === "string" && r.error.trim()) out.error = r.error.trim();
  if (Array.isArray(r.attachments)) out.attachments = r.attachments as ToolResult["attachments"];
  return out;
}

function toolResultKey(r: ToolResult): string {
  return `${r.action_id}|${r.method}|${(r.path ?? "").trim().toLowerCase()}|${r.status}`;
}

function getAugmentedToolResults(req: ChatRequest, maxRecent = 40): ToolResult[] {
  const current = (Array.isArray(req.tool_results) ? req.tool_results : [])
    .map((r) => asToolResult(r))
    .filter((r): r is ToolResult => !!r);
  let recent: ToolResult[] = [];
  try {
    const fromDb = getRecentStepToolResults(req.session_id, Math.max(1, Math.min(200, maxRecent)));
    recent = (Array.isArray(fromDb) ? fromDb : [])
      .map((r) => asToolResult(r))
      .filter((r): r is ToolResult => !!r);
  } catch {
    recent = [];
  }
  if (recent.length === 0) return current;

  const merged = recent.concat(current);
  const seen = new Set<string>();
  const deduped: ToolResult[] = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const r = merged[i]!;
    const key = toolResultKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= 240) break;
  }
  deduped.reverse();
  return deduped.map((r) => compactIncomingToolResult(r));
}

export function __testOnlyGetAugmentedToolResults(req: ChatRequest, maxRecent = 40): ToolResult[] {
  return getAugmentedToolResults(req, maxRecent);
}

function extractLatestExportPdfBaselinePathFromToolResults(toolResults: ToolResult[]): string | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || r.status !== "done") continue;
    if ((r.path ?? "").trim().toLowerCase() !== "/revit/export-pdf") continue;
    const res = r.result_json;
    if (!res || typeof res !== "object") continue;
    const obj = res as Record<string, unknown>;

    const direct = typeof obj.backend_path === "string" ? obj.backend_path.trim() : "";
    if (direct && isRedlineAttachmentPath(direct)) return direct;

    const many = Array.isArray(obj.backend_paths) ? obj.backend_paths : [];
    for (const p of many) {
      if (typeof p !== "string") continue;
      const v = p.trim();
      if (v && isRedlineAttachmentPath(v)) return v;
    }

    const uploaded =
      obj.backend_uploaded_artifacts && typeof obj.backend_uploaded_artifacts === "object"
        ? (obj.backend_uploaded_artifacts as Record<string, unknown>)
        : null;
    const files = uploaded && Array.isArray(uploaded.files) ? uploaded.files : [];
    for (const f of files) {
      if (!f || typeof f !== "object") continue;
      const rel = typeof (f as Record<string, unknown>).backend_relative_path === "string"
        ? ((f as Record<string, unknown>).backend_relative_path as string).trim()
        : "";
      if (rel && isRedlineAttachmentPath(rel)) return rel;
    }
  }
  return null;
}

function extractLatestExportPdfBaselinePath(req: ChatRequest): string | null {
  return extractLatestExportPdfBaselinePathFromToolResults(getAugmentedToolResults(req, 60));
}

function buildAutoAnalyzeRedlineAction(seed: { file_path: string; expected_sheet?: string | null }): WorkbenchAction {
  const expectedSheet = normalizeExpectedSheet(seed.expected_sheet ?? null);
  return {
    type: "analyze_redline",
    file_path: seed.file_path,
    ...(expectedSheet ? { expected_sheet: expectedSheet } : {}),
    include_pdf_annotations: true,
    include_ocr_for_images: true,
    max_pages: pdfDefaultPageBudget()
  };
}

function maybeBuildInitialRedlinePreflightAction(req: ChatRequest): WorkbenchAction | null {
  if (!userTextLooksRedline(req) && !userTextLooksRedlineContinuation(req) && !isFastElectricalPlacementRedline(req)) return null;
  const seed = pickRedlineSeed(req, { allowSessionFallback: true });
  if (!seed) return null;
  if (hasRedlineAnalyzeSuccess(req.session_id, seed.file_path)) return null;
  return buildAutoAnalyzeRedlineAction(seed);
}

function maybeBuildAutoBootstrapAnalyzeAction(
  req: ChatRequest,
  decision: OpenAiDecision,
  round: number,
  wbActions: WorkbenchAction[]
): WorkbenchAction | null {
  if (round !== 0) return null;
  if (wbActions.length > 0) return null;
  if (!userTextLooksRedline(req) && !isFastElectricalPlacementRedline(req)) return null;
  if (!decisionLooksReadOnlyDiscovery(decision)) return null;

  const seed = pickRedlineSeed(req, { allowSessionFallback: true });
  if (!seed) return null;

  // If this file already has an analyze success, skip bootstrap.
  if (hasRedlineAnalyzeSuccess(req.session_id, seed.file_path)) return null;

  return buildAutoAnalyzeRedlineAction(seed);
}

function suppressRepeatedAnalyzeActions(
  sessionId: string,
  actions: WorkbenchAction[]
): { actions: WorkbenchAction[]; suppressed_count: number } {
  const out: WorkbenchAction[] = [];
  let suppressed = 0;
  for (const a of actions) {
    if (a.type !== "analyze_redline") {
      out.push(a);
      continue;
    }
    const fp = (a.file_path ?? "").trim();
    const baseline = (a.baseline_file_path ?? "").trim();
    if (!fp) {
      out.push(a);
      continue;
    }
    if (!baseline && hasRedlineAnalyzeSuccess(sessionId, fp)) {
      suppressed++;
      continue;
    }
    out.push(a);
  }
  return { actions: out, suppressed_count: suppressed };
}

function hydrateRedlineWorkbenchActions(
  req: ChatRequest,
  actions: WorkbenchAction[],
  toolResultsOverride?: ToolResult[]
): WorkbenchAction[] {
  const seed = pickRedlineSeed(req, { allowSessionFallback: true });
  if (!seed) return actions;
  const seedPath = (seed.file_path ?? "").trim();
  const seedSheet = normalizeExpectedSheet(seed.expected_sheet ?? null);
  const baselinePath = extractLatestExportPdfBaselinePathFromToolResults(
    Array.isArray(toolResultsOverride) && toolResultsOverride.length > 0
      ? toolResultsOverride
      : getAugmentedToolResults(req, 60)
  );
  if (!seedPath) return actions;

  return actions.map((a) => {
    if (a.type !== "analyze_redline" && a.type !== "redline_orient" && a.type !== "gemini_redline_analyze") return a;

    const hasPath = typeof a.file_path === "string" && !!a.file_path.trim();
    const hasExpected = typeof a.expected_sheet === "string" && !!a.expected_sheet.trim();
    const hasBaseline = typeof a.baseline_file_path === "string" && !!a.baseline_file_path.trim();
    const next: WorkbenchAction = {
      ...a,
      ...(hasPath ? {} : { file_path: seedPath }),
      ...(hasExpected || !seedSheet ? {} : { expected_sheet: seedSheet }),
      ...(hasBaseline || !baselinePath ? {} : { baseline_file_path: baselinePath })
    } as WorkbenchAction;
    return next;
  });
}

function suppressRepeatedGeminiActions(
  sessionId: string,
  actions: WorkbenchAction[]
): { actions: WorkbenchAction[]; suppressed_count: number } {
  const out: WorkbenchAction[] = [];
  let suppressed = 0;
  for (const a of actions) {
    if (a.type !== "gemini_redline_analyze") {
      out.push(a);
      continue;
    }
    const fp = (a.file_path ?? "").trim();
    if (!fp) {
      out.push(a);
      continue;
    }
    const objective = typeof a.objective === "string" ? a.objective.trim() : "";
    const hasRegionHints = Array.isArray(a.region_boxes) && a.region_boxes.length > 0;
    const hasImageHints = Array.isArray(a.image_paths) && a.image_paths.length > 0;
    const hasBaseline = typeof a.baseline_file_path === "string" && !!a.baseline_file_path.trim();
    if (!objective && !hasRegionHints && !hasImageHints && !hasBaseline && hasRedlineGeminiAttempt(sessionId, fp)) {
      suppressed++;
      continue;
    }
    out.push(a);
  }
  return { actions: out, suppressed_count: suppressed };
}

function extractAutoGeminiSeed(results: WorkbenchActionResult[]): {
  file_path: string;
  expected_sheet?: string;
  image_paths?: string[];
  region_boxes?: Array<Record<string, unknown>>;
  region_signal?: "strong" | "weak_color_only" | "none";
} | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (!r || !r.ok || (r.type !== "analyze_redline" && r.type !== "redline_orient")) continue;
    const details = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : null;
    if (!details) continue;
    const d =
      r.type === "redline_orient" && details.analysis && typeof details.analysis === "object"
        ? (details.analysis as Record<string, unknown>)
        : details;

    const filePath = typeof d.file_path === "string" ? d.file_path.trim() : "";
    if (!filePath) continue;

    const expected = typeof d.primary_sheet_number === "string" ? d.primary_sheet_number.trim() : "";

    const imagePaths: string[] = [];
    const va = d.vision_artifacts && typeof d.vision_artifacts === "object" ? (d.vision_artifacts as Record<string, unknown>) : null;
    if (va) {
      const annotated = typeof va.annotated_image_path === "string" ? va.annotated_image_path.trim() : "";
      if (annotated) imagePaths.push(annotated);
      const preview = typeof va.preview_image_path === "string" ? va.preview_image_path.trim() : "";
      if (preview) imagePaths.push(preview);
      const crops = Array.isArray(va.crop_image_paths) ? va.crop_image_paths : [];
      for (const c of crops) {
        if (typeof c === "string" && c.trim()) imagePaths.push(c.trim());
      }
    }

    const regionBoxes: Array<Record<string, unknown>> = [];
    const markSources = new Set<string>();
    const marks = Array.isArray(d.mark_regions) ? d.mark_regions : [];
    for (const m of marks) {
      if (!m || typeof m !== "object") continue;
      const o = m as Record<string, unknown>;
      const src = typeof o.source === "string" ? o.source.trim().toLowerCase() : "";
      if (src) markSources.add(src);
      const x = typeof o.x === "number" ? o.x : null;
      const y = typeof o.y === "number" ? o.y : null;
      const w = typeof o.w === "number" ? o.w : null;
      const h = typeof o.h === "number" ? o.h : null;
      if (x === null || y === null || w === null || h === null) continue;
      if (w <= 0 || h <= 0) continue;
      const row: Record<string, unknown> = { x, y, w, h };
      if (typeof o.index === "number") row.index = Math.max(0, Math.floor(o.index));
      regionBoxes.push(row);
    }
    const hasStrongSignal = markSources.has("baseline_diff") || markSources.has("pdf_annotation");
    const signal: "strong" | "weak_color_only" | "none" =
      markSources.size === 0 ? "none" : hasStrongSignal ? "strong" : "weak_color_only";

    return {
      file_path: filePath,
      ...(expected ? { expected_sheet: expected } : {}),
      ...(imagePaths.length > 0 ? { image_paths: imagePaths.slice(0, 16) } : {}),
      ...(regionBoxes.length > 0 ? { region_boxes: regionBoxes.slice(0, 120) } : {}),
      region_signal: signal
    };
  }
  return null;
}

function maybeBuildAutoGeminiAction(sessionId: string, wbActions: WorkbenchAction[], wbResults: WorkbenchActionResult[]): WorkbenchAction | null {
  const modelAlreadyRequestedGemini = wbActions.some(a => a.type === "gemini_redline_analyze");
  if (modelAlreadyRequestedGemini) return null;

  const seed = extractAutoGeminiSeed(wbResults);
  if (!seed) return null;
  const orientedThisRound = wbResults.some((r) => r?.type === "redline_orient" && r.ok);
  if (!orientedThisRound && !hasRedlineOrientAttempt(sessionId, seed.file_path)) return null;
  if (seed.region_signal === "weak_color_only") return null;
  if (hasRedlineGeminiAttempt(sessionId, seed.file_path)) return null;
  noteRedlineGeminiAttempt(sessionId, seed.file_path);

  return {
    type: "gemini_redline_analyze",
    file_path: seed.file_path,
    ...(seed.image_paths ? { image_paths: seed.image_paths } : {}),
    ...(seed.expected_sheet ? { expected_sheet: seed.expected_sheet } : {}),
    ...(seed.region_boxes ? { region_boxes: seed.region_boxes } : {}),
    max_pages: pdfDefaultPageBudget(),
    max_regions: 80,
    min_confidence: 0.3,
    timeout_ms: 90_000,
    objective: "Extract actionable redline intent per region and propose concrete Revit-ready changes."
  };
}

function suppressBroadListFilesForRedline(req: ChatRequest, actions: WorkbenchAction[]): { actions: WorkbenchAction[]; suppressed_count: number } {
  const seed = pickRedlineSeed(req, { allowSessionFallback: true });
  if (!seed) return { actions, suppressed_count: 0 };

  let suppressed = 0;
  const out: WorkbenchAction[] = [];
  for (const a of actions) {
    if (a.type !== "list_files") {
      out.push(a);
      continue;
    }
    const raw = (a.dir_path ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    const key = raw.toLowerCase();
    const isBroad = !raw || raw === "." || raw === "/" || key === "workspace" || key === "workspace/";
    const recursive = a.recursive !== false;
    if (isBroad && recursive) {
      suppressed++;
      continue;
    }
    out.push(a);
  }
  return { actions: out, suppressed_count: suppressed };
}

function extractLatestSheetDetailForRedline(toolResults: ToolResult[]): {
  sheet_number?: string;
  view_id?: number;
  sheet_outline: Record<string, unknown>;
  viewport_geometry: Array<Record<string, unknown>>;
  title_blocks: Array<Record<string, unknown>>;
  placed_views: Array<Record<string, unknown>>;
  placed_view_types_by_id: Record<string, string>;
} | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/sheets") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const outline =
      res.sheetOutline && typeof res.sheetOutline === "object"
        ? (res.sheetOutline as Record<string, unknown>)
        : res.sheet_outline && typeof res.sheet_outline === "object"
          ? (res.sheet_outline as Record<string, unknown>)
          : null;
    if (!outline) continue;
    const viewportGeometry = Array.isArray(res.viewportGeometry)
      ? (res.viewportGeometry as Array<Record<string, unknown>>)
      : Array.isArray(res.viewport_geometry)
        ? (res.viewport_geometry as Array<Record<string, unknown>>)
        : [];
    const titleBlocks = Array.isArray(res.titleBlocks)
      ? (res.titleBlocks as Array<Record<string, unknown>>)
      : Array.isArray(res.title_blocks)
        ? (res.title_blocks as Array<Record<string, unknown>>)
        : [];
    const placedViews = Array.isArray(res.placedViews)
      ? (res.placedViews as Array<Record<string, unknown>>)
      : Array.isArray(res.placed_views)
        ? (res.placed_views as Array<Record<string, unknown>>)
        : [];
    const placedViewTypesById: Record<string, string> = {};
    for (const pv of placedViews) {
      if (!pv || typeof pv !== "object") continue;
      const vid = toFiniteInt(pv.viewId);
      if (vid === null || vid <= 0) continue;
      const vt = typeof pv.viewType === "string" ? pv.viewType.trim() : "";
      if (!vt) continue;
      placedViewTypesById[String(vid)] = vt;
    }
    const sheetNumber = typeof res.sheetNumber === "string" ? normalizeSheetToken(res.sheetNumber) : "";
    const viewId = toFiniteInt(res.viewId);
    return {
      ...(sheetNumber ? { sheet_number: sheetNumber } : {}),
      ...(viewId !== null && viewId > 0 ? { view_id: viewId } : {}),
      sheet_outline: outline,
      viewport_geometry: viewportGeometry,
      title_blocks: titleBlocks,
      placed_views: placedViews,
      placed_view_types_by_id: placedViewTypesById
    };
  }
  return null;
}

function extractPrimaryPlacedModelViewIdForRedline(sheet: ReturnType<typeof extractLatestSheetDetailForRedline>): number | null {
  if (!sheet) return null;
  const candidates: number[] = [];
  for (const pv of sheet.placed_views) {
    const viewId = toFiniteInt(pv.viewId);
    if (viewId === null || viewId <= 0) continue;
    const viewType = typeof pv.viewType === "string" ? pv.viewType.trim() : "";
    if (!isModelGeometryRedlineViewType(viewType)) continue;
    candidates.push(viewId);
  }
  if (candidates.length > 0) return candidates[0]!;
  for (const vg of sheet.viewport_geometry) {
    const viewId = toFiniteInt(vg.viewId);
    if (viewId === null || viewId <= 0) continue;
    const viewType = sheet.placed_view_types_by_id[String(viewId)] ?? "";
    if (!isModelGeometryRedlineViewType(viewType)) continue;
    return viewId;
  }
  return null;
}

function maybeBuildAutoRedlineOrientAction(
  req: ChatRequest,
  wbActions: WorkbenchAction[],
  toolResultsOverride?: ToolResult[]
): WorkbenchAction | null {
  if (wbActions.some(a => a.type === "redline_orient")) return null;
  const seed = pickRedlineSeed(req, { allowSessionFallback: true });
  if (!seed) return null;
  if (!hasRedlineAnalyzeSuccess(req.session_id, seed.file_path)) return null;
  const hasOrientAttempt = hasRedlineOrientAttempt(req.session_id, seed.file_path);
  const hasOrientMapping = hasRedlineOrientMapped(req.session_id, seed.file_path);
  const toolResults =
    Array.isArray(toolResultsOverride) && toolResultsOverride.length > 0
      ? toolResultsOverride
      : getAugmentedToolResults(req, 60);
  const baselinePath = extractLatestExportPdfBaselinePathFromToolResults(toolResults);
  const sheet = extractLatestSheetDetailForRedline(toolResults);
  if (!sheet) return null;
  if (hasOrientAttempt) {
    const allowBaselineRefresh = !!baselinePath && hasOrientMapping && !hasRedlineOrientWithBaseline(req.session_id, seed.file_path);
    if (hasOrientMapping && !allowBaselineRefresh) return null;
    // One deterministic retry after sheet geometry arrives. Prevent remap loops.
    if (hasRedlineOrientRemapRequested(req.session_id, seed.file_path)) return null;
    noteRedlineOrientRemapRequested(req.session_id, seed.file_path);
  }

  const expected = normalizeExpectedSheet(seed.expected_sheet ?? sheet.sheet_number ?? null);
  noteRedlineOrientAttempt(req.session_id, seed.file_path, expected ?? null);
  return {
    type: "redline_orient",
    file_path: seed.file_path,
    ...(expected ? { expected_sheet: expected } : {}),
    max_pages: 2,
    include_pdf_annotations: true,
    include_ocr_for_images: true,
    sheet_outline: sheet.sheet_outline,
    viewport_geometry: sheet.viewport_geometry,
    title_blocks: sheet.title_blocks,
    ...(baselinePath ? { baseline_file_path: baselinePath } : {})
  };
}

function updateRedlineVisionProgressFromWorkbench(sessionId: string, wbResults: WorkbenchActionResult[]): void {
  const collectedViewportHints: ViewportPickHint[] = [];
  const collectedSheetHints: SheetPickHint[] = [];
  const collectedSheetBoxes: SheetRegionBoxHint[] = [];
  const collectedGeminiIntents: GeminiIntentHint[] = [];
  const collectedAnnotationHints: AnnotationRegionHint[] = [];
  for (const r of wbResults) {
    if (!r || !r.details || typeof r.details !== "object") continue;
    const d = r.details as Record<string, unknown>;
    const fp = typeof d.file_path === "string" ? d.file_path.trim() : "";
    const reqBlock = d.request && typeof d.request === "object" ? (d.request as Record<string, unknown>) : null;
    const analysisBlock = d.analysis && typeof d.analysis === "object" ? (d.analysis as Record<string, unknown>) : null;
    const analysisFile = analysisBlock && typeof analysisBlock.file_path === "string" ? String(analysisBlock.file_path).trim() : "";
    const usePath = fp || analysisFile;
    const expected =
      normalizeExpectedSheet(
        (typeof d.primary_sheet_number === "string" ? d.primary_sheet_number : null) ??
          (reqBlock && typeof reqBlock.expected_sheet === "string" ? reqBlock.expected_sheet : null) ??
          (analysisBlock && typeof analysisBlock.primary_sheet_number === "string" ? analysisBlock.primary_sheet_number : null)
      ) ?? null;
    const filename = usePath ? path.basename(usePath) : "";
    if (r.type === "analyze_redline" && r.ok) {
      if (usePath) noteRedlineAnalyzeSuccess(sessionId, usePath, expected, filename);
      const ann = extractAnnotationRegionHintsFromDetails(d);
      if (ann.length > 0) collectedAnnotationHints.push(...ann);
      const imageMark = extractImageMarkHintFromAnalyzeDetails(d);
      if (imageMark) noteImageMarkHint(sessionId, imageMark);
    }
    if (r.type === "gemini_redline_analyze") {
      if (usePath) noteRedlineGeminiAttempt(sessionId, usePath, expected, filename);
      const intents = extractGeminiIntentHintsFromDetails(d);
      if (intents.length > 0) collectedGeminiIntents.push(...intents);
    }
    if (r.type === "redline_orient") {
      if (usePath) noteRedlineOrientAttempt(sessionId, usePath, expected, filename);
      const baselinePath =
        reqBlock && typeof reqBlock.baseline_file_path === "string" ? reqBlock.baseline_file_path.trim() : "";
      if (baselinePath && usePath) noteRedlineOrientWithBaseline(sessionId, usePath);
      const mapping = d.mapping && typeof d.mapping === "object" ? (d.mapping as Record<string, unknown>) : null;
      const viewportHints = extractViewportPickHintsFromMapping(mapping);
      const sheetHints = extractSheetPickHintsFromMapping(mapping);
      const sheetBoxes = extractSheetRegionBoxesFromMapping(mapping);
      if (usePath && (viewportHints.length > 0 || sheetHints.length > 0)) {
        noteRedlineOrientMapped(sessionId, usePath);
      }
      if (viewportHints.length > 0) collectedViewportHints.push(...viewportHints);
      if (sheetHints.length > 0) collectedSheetHints.push(...sheetHints);
      if (sheetBoxes.length > 0) collectedSheetBoxes.push(...sheetBoxes);
      const ann = extractAnnotationRegionHintsFromDetails(d);
      if (ann.length > 0) collectedAnnotationHints.push(...ann);
      const imageMark = extractImageMarkHintFromAnalyzeDetails(analysisBlock ?? d);
      if (imageMark) noteImageMarkHint(sessionId, imageMark);
    }
    if (r.type === "map_sheet_regions" && r.ok) {
      const viewportHints = extractViewportPickHintsFromMapping(d);
      const sheetHints = extractSheetPickHintsFromMapping(d);
      const sheetBoxes = extractSheetRegionBoxesFromMapping(d);
      if (viewportHints.length > 0) collectedViewportHints.push(...viewportHints);
      if (sheetHints.length > 0) collectedSheetHints.push(...sheetHints);
      if (sheetBoxes.length > 0) collectedSheetBoxes.push(...sheetBoxes);
    }
  }
  if (collectedViewportHints.length > 0) noteViewportPickHints(sessionId, dedupeViewportPickHints(collectedViewportHints));
  if (collectedSheetHints.length > 0) noteSheetPickHints(sessionId, dedupeSheetPickHints(collectedSheetHints));
  if (collectedSheetBoxes.length > 0) noteSheetRegionBoxes(sessionId, dedupeSheetRegionBoxes(collectedSheetBoxes));
  if (collectedGeminiIntents.length > 0) noteGeminiIntentHints(sessionId, collectedGeminiIntents);
  if (collectedAnnotationHints.length > 0) noteAnnotationRegionHints(sessionId, collectedAnnotationHints);
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function extractActiveSheetViewIdFromContext(ctx: unknown): number | null {
  const activeView = extractActiveViewRecordFromContext(ctx);
  if (!activeView) return null;

  const type =
    typeof activeView.type === "string"
      ? activeView.type.toLowerCase()
      : typeof activeView.view_type === "string"
        ? activeView.view_type.toLowerCase()
        : "";
  if (type && !type.includes("sheet")) return null;
  return toFiniteNumber(activeView.id);
}

function extractActiveModelViewIdFromContext(ctx: unknown): number | null {
  const activeView = extractActiveViewRecordFromContext(ctx);
  if (!activeView) return null;

  const type =
    typeof activeView.type === "string"
      ? activeView.type.trim()
      : typeof activeView.view_type === "string"
        ? activeView.view_type.trim()
        : "";
  if (!type || isViewTypeUnsupportedForExportViewFrame(type)) return null;
  return toFiniteNumber(activeView.id);
}

type SheetDetailAttemptState = {
  has_detail_call: boolean;
  has_success: boolean;
  attempted_by_sheet_number: boolean;
  attempted_by_view_id: boolean;
  last_status?: string;
};

function summarizeSheetDetailAttempts(toolResults: ToolResult[]): SheetDetailAttemptState {
  const state: SheetDetailAttemptState = {
    has_detail_call: false,
    has_success: false,
    attempted_by_sheet_number: false,
    attempted_by_view_id: false
  };

  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r) continue;
    if ((r.path ?? "").trim().toLowerCase() !== "/revit/sheets") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const action = typeof res.action === "string" ? res.action.trim().toLowerCase() : "";
    if (action && action !== "detail") continue;

    state.has_detail_call = true;
    const status = typeof res.status === "string" ? res.status.trim().toLowerCase() : "";
    if (status) state.last_status = status;
    if (status === "ok") {
      state.has_success = true;
    }

    if (typeof res.sheetNumber === "string" && res.sheetNumber.trim()) state.attempted_by_sheet_number = true;
    if (toFiniteNumber(res.viewId) !== null) state.attempted_by_view_id = true;

    const selector = res.selector && typeof res.selector === "object" ? (res.selector as Record<string, unknown>) : null;
    if (selector) {
      if (typeof selector.sheetNumber === "string" && selector.sheetNumber.trim()) state.attempted_by_sheet_number = true;
      if (toFiniteNumber(selector.viewId) !== null) state.attempted_by_view_id = true;
    }
  }

  return state;
}

function toFiniteInt(v: unknown): number | null {
  const n = toFiniteNumber(v);
  if (n === null) return null;
  return Math.round(n);
}

function isViewTypeUnsupportedForExportViewFrame(viewType: string): boolean {
  const vt = (viewType ?? "").trim().toLowerCase();
  if (!vt) return false;
  if (vt === "drawingsheet" || vt === "threed") return true;
  if (vt.includes("sheet") || vt.includes("3d")) return true;
  return false;
}

function isModelGeometryRedlineViewType(viewType: string): boolean {
  const vt = (viewType ?? "").trim().toLowerCase();
  if (!vt || isViewTypeUnsupportedForExportViewFrame(vt)) return false;
  if (vt.includes("drafting") || vt.includes("legend") || vt.includes("schedule") || vt.includes("report")) return false;
  return true;
}

type ResolvedRoomPlanViewSummary = {
  room_number: string | null;
  best_view_id: number | null;
  best_view_name: string | null;
  best_view_type: string | null;
};

function extractLatestResolvedRoomPlanView(toolResults: ToolResult[], roomNumber?: string | null): ResolvedRoomPlanViewSummary | null {
  const want = typeof roomNumber === "string" && roomNumber.trim() ? roomNumber.trim().toUpperCase() : null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/resolve-room-plan-view") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const resolvedRoom = typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : null;
    if (want && resolvedRoom && resolvedRoom !== want) continue;
    const bestViewId = toFiniteInt(res.bestViewId);
    if (bestViewId === null || bestViewId <= 0) continue;
    return {
      room_number: resolvedRoom,
      best_view_id: bestViewId,
      best_view_name: typeof res.bestViewName === "string" ? res.bestViewName : null,
      best_view_type: typeof res.bestViewType === "string" ? res.bestViewType : null
    };
  }
  return null;
}

type ListedViewSummary = {
  id: number;
  name: string;
  type: string;
  is_assembly: boolean;
};

function extractLatestListedViews(toolResults: ToolResult[]): ListedViewSummary[] {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/views") continue;
    if (!Array.isArray(r.result_json)) continue;
    const out: ListedViewSummary[] = [];
    for (const row of r.result_json as Array<Record<string, unknown>>) {
      if (!row || typeof row !== "object") continue;
      const id = toFiniteInt(row.id);
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const type = typeof row.type === "string" ? row.type.trim() : "";
      if (id === null || id <= 0 || !name || !type) continue;
      out.push({
        id,
        name,
        type,
        is_assembly: !!row.isAssembly
      });
    }
    return out;
  }
  return [];
}

function inferPreferredRedlineViewNameToken(profile: RedlineTargetingProfile, semanticCorpus: string): string | null {
  const lower = semanticCorpus.toLowerCase();
  if (/\b(rcp|reflected ceiling)\b/.test(lower)) return "rcp";
  if (/\b(lighting|light|luminaire)\b/.test(lower)) return "lighting";
  if (/\b(fire alarm|smoke|strobe|horn)\b/.test(lower)) return "fire";
  if (/\b(nurse call)\b/.test(lower)) return "nurse";
  if (/\b(data|telecom|telephone)\b/.test(lower)) return "data";
  if (/\b(power|electrical)\b/.test(lower)) return /\bpower\b/.test(lower) ? "power" : "electrical";
  if (profile.categories.some((c) => c === "OST_ElectricalFixtures" || c === "OST_ElectricalDevices")) return "power";
  if (profile.categories.some((c) => c === "OST_LightingFixtures" || c === "OST_LightingDevices")) return "lighting";
  return null;
}

function chooseLikelyRedlineModelView(args: {
  views: ListedViewSummary[];
  targetProfile: RedlineTargetingProfile;
  semanticCorpus: string;
}): ListedViewSummary | null {
  const preferToken = inferPreferredRedlineViewNameToken(args.targetProfile, args.semanticCorpus);
  const lowerCorpus = args.semanticCorpus.toLowerCase();
  const candidates = args.views
    .filter((view) => !view.is_assembly && !isViewTypeUnsupportedForExportViewFrame(view.type))
    .map((view) => {
      const nameLower = view.name.toLowerCase();
      const typeLower = view.type.toLowerCase();
      let score = 0;

      if (typeLower.includes("floor")) score += 10;
      else if (typeLower.includes("engineering")) score += 8;
      else if (typeLower.includes("ceiling")) score += /\b(rcp|reflected ceiling)\b/.test(lowerCorpus) ? 7 : 1;
      else if (typeLower.includes("plan")) score += 5;
      else score -= 2;

      if (preferToken) {
        if (nameLower.includes(preferToken)) score += 6;
        if (preferToken === "power" && nameLower.includes("electrical")) score += 3;
        if (preferToken === "lighting" && nameLower.includes("electrical")) score += 1.5;
      }

      if (/\bplan\b/.test(lowerCorpus) && nameLower.includes("plan")) score += 1;
      if (/\blevel\b/.test(lowerCorpus) && nameLower.includes("level")) score += 1;
      if (/\bexisting\b/.test(lowerCorpus) && nameLower.includes("existing")) score += 0.5;

      return { view, score };
    })
    .sort((a, b) => b.score - a.score || a.view.name.localeCompare(b.view.name));

  const best = candidates[0];
  if (!best) return null;
  if (best.score < (preferToken ? 11 : 13)) return null;
  return best.view;
}

function extractRegionPrimaryTargetKind(region: Record<string, unknown>): string {
  const pt = region.primary_target && typeof region.primary_target === "object"
    ? (region.primary_target as Record<string, unknown>)
    : null;
  const kind = typeof pt?.kind === "string" ? pt.kind.trim().toLowerCase() : "";
  return kind;
}

function extractRegionNormalizedCenter(region: Record<string, unknown>): { normalized_x: number; normalized_y: number } | null {
  const nb = region.normalized_box && typeof region.normalized_box === "object"
    ? (region.normalized_box as Record<string, unknown>)
    : null;
  if (!nb) return null;
  const minX = toFiniteNumber(nb.minX);
  const maxX = toFiniteNumber(nb.maxX);
  const minY = toFiniteNumber(nb.minY);
  const maxY = toFiniteNumber(nb.maxY);
  if (minX === null || maxX === null || minY === null || maxY === null) return null;
  return {
    normalized_x: Math.max(0, Math.min(1, (minX + maxX) * 0.5)),
    normalized_y: Math.max(0, Math.min(1, (minY + maxY) * 0.5))
  };
}

function extractViewportPickHintsFromMapping(mapping: Record<string, unknown> | null): ViewportPickHint[] {
  const out: ViewportPickHint[] = [];
  if (!mapping) return out;
  const summary = mapping.summary && typeof mapping.summary === "object" ? (mapping.summary as Record<string, unknown>) : null;
  const summaryViewportRegions = toFiniteInt(summary?.viewport_regions);
  // When mapper reports zero viewport-primary regions, avoid using incidental near-viewport hints.
  if (summaryViewportRegions !== null && summaryViewportRegions <= 0) return out;
  const regions = Array.isArray(mapping.regions) ? (mapping.regions as Array<Record<string, unknown>>) : [];
  for (const region of regions) {
    if (!region || typeof region !== "object") continue;
    const primaryKind = extractRegionPrimaryTargetKind(region);
    const primaryIsSheetLike = primaryKind === "titleblock" || primaryKind === "sheet";
    const primaryTarget = region.primary_target && typeof region.primary_target === "object"
      ? (region.primary_target as Record<string, unknown>)
      : null;
    const targets = [
      ...(primaryTarget ? [primaryTarget] : []),
      ...(Array.isArray(region.targets) ? (region.targets as Array<Record<string, unknown>>) : [])
    ];
    for (const t of targets) {
      if (!t || typeof t !== "object") continue;
      const kind = typeof t.kind === "string" ? t.kind.trim().toLowerCase() : "";
      if (kind !== "viewport") continue;
      const viewId = toFiniteInt(t.view_id);
      if (viewId === null || viewId <= 0) continue;
      const vh = t.view_hint && typeof t.view_hint === "object" ? (t.view_hint as Record<string, unknown>) : null;
      const nx = toFiniteNumber(vh?.normalized_x);
      const ny = toFiniteNumber(vh?.normalized_y);
      if (nx === null || ny === null) continue;
      const score = Math.max(0, Math.min(1, toFiniteNumber(t.score) ?? 0));
      const overlap = Math.max(0, Math.min(1, toFiniteNumber(t.overlap_ratio) ?? 0));
      const containsCenter = !!t.contains_center;
      if (primaryIsSheetLike && score < 0.09 && overlap <= 0 && !containsCenter) continue;
      const weighted = primaryIsSheetLike ? score * 0.92 : score;
      out.push({
        view_id: viewId,
        normalized_x: Math.max(0, Math.min(1, nx)),
        normalized_y: Math.max(0, Math.min(1, ny)),
        score: Math.max(0, Math.min(1, weighted)),
        source: "sheet_viewport_mapping",
        frame_aligned: true
      });
    }
  }
  return out;
}

function dedupeViewportPickHints(hints: ViewportPickHint[]): ViewportPickHint[] {
  const byKey = new Map<string, ViewportPickHint>();
  for (const h of hints) {
    const key = `${h.view_id}:${Math.round(h.normalized_x * 1000)}:${Math.round(h.normalized_y * 1000)}`;
    const prev = byKey.get(key);
    if (!prev || h.score > prev.score) byKey.set(key, h);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

function dedupeSheetPickHints(hints: SheetPickHint[]): SheetPickHint[] {
  const byKey = new Map<string, SheetPickHint>();
  for (const h of hints) {
    const key = `${Math.round(h.normalized_x * 1000)}:${Math.round(h.normalized_y * 1000)}`;
    const prev = byKey.get(key);
    if (!prev || h.score > prev.score) byKey.set(key, h);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 20);
}

function dedupeSheetRegionBoxes(boxes: SheetRegionBoxHint[]): SheetRegionBoxHint[] {
  const byKey = new Map<string, SheetRegionBoxHint>();
  for (const b of boxes) {
    const key = `${b.index}:${Math.round(b.minU * 1000)}:${Math.round(b.minV * 1000)}:${Math.round(b.maxU * 1000)}:${Math.round(b.maxV * 1000)}`;
    if (!byKey.has(key)) byKey.set(key, b);
  }
  return [...byKey.values()].slice(0, 80);
}

function toFindElementsSheetRegions(boxes: SheetRegionBoxHint[], maxCount = 40): Array<{ minU: number; minV: number; maxU: number; maxV: number }> {
  const out: Array<{ minU: number; minV: number; maxU: number; maxV: number }> = [];
  if (!Array.isArray(boxes) || boxes.length === 0) return out;
  for (const b of boxes) {
    const minU = Math.min(b.minU, b.maxU);
    const maxU = Math.max(b.minU, b.maxU);
    const minV = Math.min(b.minV, b.maxV);
    const maxV = Math.max(b.minV, b.maxV);
    if (!Number.isFinite(minU) || !Number.isFinite(minV) || !Number.isFinite(maxU) || !Number.isFinite(maxV)) continue;
    if (maxU <= minU || maxV <= minV) continue;
    out.push({ minU, minV, maxU, maxV });
    if (out.length >= Math.max(1, maxCount)) break;
  }
  return out;
}

function extractSheetPickHintsFromMapping(mapping: Record<string, unknown> | null): SheetPickHint[] {
  const out: SheetPickHint[] = [];
  if (!mapping) return out;
  const regions = Array.isArray(mapping.regions) ? (mapping.regions as Array<Record<string, unknown>>) : [];
  for (const region of regions) {
    if (!region || typeof region !== "object") continue;
    const primaryKind = extractRegionPrimaryTargetKind(region);
    if (primaryKind !== "titleblock" && primaryKind !== "sheet") continue;
    const center = extractRegionNormalizedCenter(region);
    if (!center) continue;
    const pt = region.primary_target && typeof region.primary_target === "object"
      ? (region.primary_target as Record<string, unknown>)
      : null;
    // Many titleblock families report a full-sheet bounding box, which is not useful for localization.
    if (primaryKind === "titleblock") {
      const overlap = toFiniteNumber(pt?.overlap_ratio) ?? 0;
      const containsCenter = !!pt?.contains_center;
      const dist = toFiniteNumber(pt?.center_distance_norm) ?? 1;
      const score = toFiniteNumber(pt?.score) ?? 0;
      if (overlap >= 0.95 && containsCenter && dist <= 0.02 && score >= 0.95) {
        continue;
      }
    }
    const score = Math.max(0, Math.min(1, toFiniteNumber(pt?.score) ?? 0.75));
    out.push({
      normalized_x: center.normalized_x,
      normalized_y: center.normalized_y,
      score
    });
  }
  return out;
}

function extractSheetRegionBoxesFromMapping(mapping: Record<string, unknown> | null): SheetRegionBoxHint[] {
  const out: SheetRegionBoxHint[] = [];
  if (!mapping) return out;
  const regions = Array.isArray(mapping.regions) ? (mapping.regions as Array<Record<string, unknown>>) : [];
  for (const region of regions) {
    if (!region || typeof region !== "object") continue;
    const idx = toFiniteInt(region.index) ?? toFiniteInt(region.region_index) ?? 0;
    const sb = region.sheet_box && typeof region.sheet_box === "object" ? (region.sheet_box as Record<string, unknown>) : null;
    if (!sb) continue;
    const minU = toFiniteNumber(sb.minU);
    const minV = toFiniteNumber(sb.minV);
    const maxU = toFiniteNumber(sb.maxU);
    const maxV = toFiniteNumber(sb.maxV);
    if (minU === null || minV === null || maxU === null || maxV === null) continue;
    if (maxU <= minU || maxV <= minV) continue;
    out.push({
      index: Math.max(0, idx),
      minU,
      minV,
      maxU,
      maxV
    });
  }
  return out.slice(0, 80);
}

function extractAnnotationRegionHintsFromDetails(details: Record<string, unknown> | null): AnnotationRegionHint[] {
  const out: AnnotationRegionHint[] = [];
  if (!details) return out;
  const analysis =
    details.analysis && typeof details.analysis === "object"
      ? (details.analysis as Record<string, unknown>)
      : details;
  const groups = Array.isArray(analysis.annotation_groups)
    ? (analysis.annotation_groups as Array<Record<string, unknown>>)
    : [];
  const groupByRegion = new Map<number, number>();
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const gidx = toFiniteInt(g.group_index);
    if (gidx === null || gidx <= 0) continue;
    const ids = Array.isArray(g.region_indices) ? g.region_indices : [];
    for (const raw of ids) {
      const ridx = toFiniteInt(raw);
      if (ridx === null || ridx <= 0) continue;
      if (!groupByRegion.has(ridx)) groupByRegion.set(ridx, gidx);
    }
  }

  const regions = Array.isArray(analysis.mark_regions) ? (analysis.mark_regions as Array<Record<string, unknown>>) : [];
  for (const r of regions) {
    if (!r || typeof r !== "object") continue;
    const source = typeof r.source === "string" ? r.source.trim().toLowerCase() : "";
    const idx = toFiniteInt(r.index) ?? toFiniteInt(r.region_index);
    const subtype = typeof r.annotation_subtype === "string" ? r.annotation_subtype.trim() : "";
    if ((source !== "pdf_annotation" && !subtype) || idx === null || idx <= 0) continue;
    const deleteLike = !!r.annotation_is_delete_like;
    const contents = typeof r.annotation_contents === "string" ? r.annotation_contents.trim() : "";
    const color = typeof r.annotation_color === "string" ? r.annotation_color.trim() : "";
    const related = toFiniteInt(r.related_group) ?? groupByRegion.get(idx) ?? null;
    out.push({
      region_index: idx,
      subtype: subtype || "pdf_annotation",
      is_delete_like: deleteLike,
      contents,
      ...(color ? { color } : {}),
      ...(related !== null && related > 0 ? { related_group: related } : {})
    });
    if (out.length >= 140) break;
  }
  return out;
}

function extractGeminiIntentHintsFromDetails(details: Record<string, unknown> | null): GeminiIntentHint[] {
  const out: GeminiIntentHint[] = [];
  if (!details) return out;
  const rows = Array.isArray(details.regions)
    ? (details.regions as Array<Record<string, unknown>>)
    : Array.isArray(details.region_intents)
      ? (details.region_intents as Array<Record<string, unknown>>)
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const intent = typeof row.intent === "string" ? row.intent.trim() : "";
    const proposed = typeof row.proposed_action === "string" ? row.proposed_action.trim() : "";
    if (!intent && !proposed) continue;
    const idx = toFiniteInt(row.region_index) ?? toFiniteInt(row.regionIndex) ?? null;
    const conf = toFiniteNumber(row.confidence);
    out.push({
      region_index: idx === null ? null : Math.max(0, idx),
      target_type: typeof row.target_type === "string" ? row.target_type.trim().toLowerCase() : "unknown",
      intent: intent || proposed,
      proposed_action: proposed || intent,
      confidence: conf === null ? 0.6 : Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf))
    });
  }
  return out.slice(0, 80);
}

function extractViewportPickHintsFromWorkbench(results: WorkbenchActionResult[]): ViewportPickHint[] {
  const out: ViewportPickHint[] = [];
  for (const r of results) {
    if (!r || !r.ok || (r.type !== "redline_orient" && r.type !== "map_sheet_regions")) continue;
    const d = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : null;
    if (!d) continue;
    const mapping =
      r.type === "redline_orient"
        ? d.mapping && typeof d.mapping === "object"
          ? (d.mapping as Record<string, unknown>)
          : null
        : d;
    out.push(...extractViewportPickHintsFromMapping(mapping));
  }
  return dedupeViewportPickHints(out);
}

function extractSheetPickHintsFromWorkbench(results: WorkbenchActionResult[]): SheetPickHint[] {
  const out: SheetPickHint[] = [];
  for (const r of results) {
    if (!r || !r.ok || (r.type !== "redline_orient" && r.type !== "map_sheet_regions")) continue;
    const d = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : null;
    if (!d) continue;
    const mapping =
      r.type === "redline_orient"
        ? d.mapping && typeof d.mapping === "object"
          ? (d.mapping as Record<string, unknown>)
          : null
        : d;
    out.push(...extractSheetPickHintsFromMapping(mapping));
  }
  return dedupeSheetPickHints(out);
}

type ViewFrameSummary = {
  frame_id: string;
  width_px: number;
  height_px: number;
  top_left_xyz: [number, number, number] | null;
  top_right_xyz: [number, number, number] | null;
  bottom_left_xyz: [number, number, number] | null;
};

type ViewFrameImageContext = {
  frame: ViewFrameSummary;
  view_id: number;
  image_data_url: string | null;
  image_local_path: string | null;
};

type PlacementContextSummary = {
  element_id: number | null;
  host_element_id: number | null;
  place_on_host_body: Record<string, unknown> | null;
  create_similar_body: Record<string, unknown> | null;
  center: [number, number, number] | null;
  insertion_point: [number, number, number] | null;
  wall_projected_point: [number, number, number] | null;
  wall_tangent: [number, number, number] | null;
  placement_host_category: string | null;
  placement_host_built_in_category: string | null;
  room_number: string | null;
  requested_room_side: string | null;
  requested_room_wall_host_ids: number[];
  supported_host: boolean;
  source_host_supported: boolean | null;
  host_support_reason: string | null;
  orientation_rotation_radians: number | null;
  host_local_frame_basis: string | null;
  host_chainage_ft: number | null;
  host_normalized_chainage: number | null;
  host_curve_length_ft: number | null;
  host_orientation_relative_radians: number | null;
  electrical_circuit_label: string | null;
};

type PlacementContextAuditSummary = {
  index: number;
  audited_ids: number[];
  valid_ids: number[];
  invalid_ids: number[];
  off_room_ids: number[];
  off_wall_ids: number[];
  unsupported_ids: number[];
  missing_ids: number[];
  contexts: Map<number, PlacementContextSummary>;
  circuit_labels: Map<number, string>;
};

type ResolvedRoomWallPlacementSummary = {
  host_element_id: number | null;
  wall_projected_point: [number, number, number] | null;
  wall_tangent: [number, number, number] | null;
  host_curve_length_ft: number | null;
  placement_host_category: string | null;
  placement_host_built_in_category: string | null;
  room_number: string | null;
  requested_room_side: string | null;
  requested_room_wall_host_ids: number[];
  supported_host: boolean;
  source_host_supported: boolean | null;
  host_support_reason: string | null;
};

type PlacementPlan = {
  path: string;
  body: Record<string, unknown>;
  requested_count: number;
  heuristic: boolean;
};

type PlacementWorkItemStage = "discover" | "preview" | "apply" | "verify" | "correct" | "complete" | "blocked";

type PlacementWorkItem = {
  workflow: "low_risk_hosted_placement";
  stage: PlacementWorkItemStage;
  scope_label: string;
  requested_count: number;
  prefer_exemplar_clone: boolean;
  room_number: string | null;
  spatial_side: string | null;
  view_id: number | null;
  exemplar_element_id: number | null;
  host_element_id: number | null;
  family_strategy: "create_similar_from_exemplar" | "place_on_host_from_source" | "unresolved";
  placement_path: string | null;
  placement_basis: "pointXyz" | "alongHostOffsetFt" | "targetChainageFt" | null;
  preview_ready: boolean;
  apply_ready: boolean;
  verification_required: boolean;
  correction_ready: boolean;
  blocked_reason: string | null;
  recommended_next_action: string;
  notes: string[];
};

type PlacementRunState = {
  workflow: "low_risk_hosted_placement";
  stage: PlacementWorkItemStage;
  requested_count: number;
  room_number: string | null;
  spatial_side: string | null;
  view_id: number | null;
  exemplar_element_id: number | null;
  host_element_id: number | null;
  family_strategy: PlacementWorkItem["family_strategy"];
  placement_path: string | null;
  placement_basis: PlacementWorkItem["placement_basis"];
  preview_ready: boolean;
  apply_ready: boolean;
  verification_required: boolean;
  correction_ready: boolean;
  blocked_reason: string | null;
  latest_preview_index: number | null;
  latest_apply_index: number | null;
  latest_failure_index: number | null;
  latest_explicit_audit_index: number | null;
  verification_captured: boolean;
  explicit_audit_complete: boolean;
  correction_attempts: number;
  created_element_ids: number[];
  audited_created_ids: number[];
  valid_created_ids: number[];
  invalid_created_ids: number[];
  missing_audit_ids: number[];
  off_room_ids: number[];
  off_wall_ids: number[];
  unsupported_ids: number[];
  unresolved_created_ids: number[];
  recommended_next_action: string;
};

type VisibleInventoryCandidate = {
  element_id: number;
  host_id: number | null;
  room_number: string | null;
  built_in_category: string | null;
  center: [number, number, number] | null;
  rotation_radians: number | null;
};

type RankedSimilarDeviceSummary = {
  element_id: number | null;
  host_id: number | null;
  room_side: "left" | "right" | "top" | "bottom" | null;
  host_supported: boolean | null;
  electrical_circuit_label: string | null;
  create_similar_body: Record<string, unknown> | null;
  wall_projected_point: [number, number, number] | null;
  wall_tangent: [number, number, number] | null;
  host_local_frame_basis: string | null;
  host_chainage_ft: number | null;
  host_normalized_chainage: number | null;
  host_curve_length_ft: number | null;
};

function parseXyzTuple(value: unknown): [number, number, number] | null {
  if (Array.isArray(value) && value.length >= 3) {
    const x = toFiniteNumber(value[0]);
    const y = toFiniteNumber(value[1]);
    const z = toFiniteNumber(value[2]);
    if (x !== null && y !== null && z !== null) return [x, y, z];
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const x = toFiniteNumber(row.x);
    const y = toFiniteNumber(row.y);
    const z = toFiniteNumber(row.z);
    if (x !== null && y !== null && z !== null) return [x, y, z];
  }
  return null;
}

function cloneJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

function parsePlacementContextSummaryFromResult(res: Record<string, unknown>): PlacementContextSummary {
  const suggested = res.suggestedPlacement && typeof res.suggestedPlacement === "object"
    ? (res.suggestedPlacement as Record<string, unknown>)
    : null;
  const placeOnHost = suggested?.placeOnHost && typeof suggested.placeOnHost === "object"
    ? (suggested.placeOnHost as Record<string, unknown>)
    : null;
  const createSimilar = suggested?.createSimilar && typeof suggested.createSimilar === "object"
    ? (suggested.createSimilar as Record<string, unknown>)
    : null;
  const hostLocalFrame = res.hostLocalFrame && typeof res.hostLocalFrame === "object"
    ? (res.hostLocalFrame as Record<string, unknown>)
    : null;
  const wallPlacement = res.wallPlacement && typeof res.wallPlacement === "object"
    ? (res.wallPlacement as Record<string, unknown>)
    : hostLocalFrame;
  const host = res.host && typeof res.host === "object" ? (res.host as Record<string, unknown>) : null;
  const placementHost = res.placementHost && typeof res.placementHost === "object"
    ? (res.placementHost as Record<string, unknown>)
    : null;
  const placementHostContext = res.placementHostContext && typeof res.placementHostContext === "object"
    ? (res.placementHostContext as Record<string, unknown>)
    : null;
  const room = res.room && typeof res.room === "object" ? (res.room as Record<string, unknown>) : null;
  const requestedRoomWalls = Array.isArray(res.requestedRoomWalls)
    ? (res.requestedRoomWalls as Array<Record<string, unknown>>)
    : [];
  const diagnostics = res.diagnostics && typeof res.diagnostics === "object"
    ? (res.diagnostics as Record<string, unknown>)
    : null;
  const hostPlacementSupport = diagnostics?.hostPlacementSupport && typeof diagnostics.hostPlacementSupport === "object"
    ? (diagnostics.hostPlacementSupport as Record<string, unknown>)
    : null;
  const orientation = res.orientation && typeof res.orientation === "object"
    ? (res.orientation as Record<string, unknown>)
    : null;
  const electricalCircuit = res.electricalCircuit && typeof res.electricalCircuit === "object"
    ? (res.electricalCircuit as Record<string, unknown>)
    : null;
  return {
    element_id: toFiniteInt(res.elementId),
    host_element_id:
      toFiniteInt(hostLocalFrame?.hostElementId) ??
      toFiniteInt(placementHostContext?.hostElementId) ??
      toFiniteInt(placementHost?.id) ??
      toFiniteInt(host?.id) ??
      toFiniteInt(wallPlacement?.hostElementId),
    place_on_host_body: cloneJsonObject(placeOnHost?.body),
    create_similar_body: cloneJsonObject(createSimilar?.body),
    center: parseXyzTuple(res.center),
    insertion_point: parseXyzTuple(res.insertionPoint),
    wall_projected_point: parseXyzTuple(hostLocalFrame?.projectedPoint ?? placementHostContext?.projectedPoint ?? wallPlacement?.projectedPoint),
    wall_tangent: parseXyzTuple(hostLocalFrame?.tangent ?? placementHostContext?.tangent ?? wallPlacement?.tangent),
    placement_host_category:
      (typeof placementHost?.category === "string" ? placementHost.category.trim() : "") ||
      (typeof placementHostContext?.linkedElementCategory === "string" ? placementHostContext.linkedElementCategory.trim() : "") ||
      null,
    placement_host_built_in_category:
      (typeof placementHost?.builtInCategory === "string" ? placementHost.builtInCategory.trim() : "") ||
      (typeof placementHostContext?.linkedElementBuiltInCategory === "string" ? placementHostContext.linkedElementBuiltInCategory.trim() : "") ||
      null,
    room_number:
      (typeof room?.number === "string" ? room.number.trim().toUpperCase() : "") ||
      (typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "") ||
      null,
    requested_room_side: extractRequestedRoomSideRaw(room, res),
    requested_room_wall_host_ids: requestedRoomWalls
      .map((row) => toFiniteInt((row?.hostContext as Record<string, unknown> | undefined)?.hostElementId ?? row?.hostElementId))
      .filter((id): id is number => id !== null && id > 0)
      .slice(0, 16),
    supported_host: hostPlacementSupport?.supported === true,
    source_host_supported: typeof hostPlacementSupport?.sourceHostSupported === "boolean" ? hostPlacementSupport.sourceHostSupported : null,
    host_support_reason: typeof hostPlacementSupport?.reason === "string" ? hostPlacementSupport.reason.trim() : null,
    orientation_rotation_radians: toFiniteNumber(orientation?.rotationRadians),
    host_local_frame_basis: typeof hostLocalFrame?.basis === "string" ? hostLocalFrame.basis.trim() : null,
    host_chainage_ft: toFiniteNumber(hostLocalFrame?.chainageFt),
    host_normalized_chainage: toFiniteNumber(hostLocalFrame?.normalizedChainage),
    host_curve_length_ft: toFiniteNumber(hostLocalFrame?.curveLengthFt),
    host_orientation_relative_radians: toFiniteNumber(hostLocalFrame?.orientationRelativeToHostRadians),
    electrical_circuit_label: extractElectricalCircuitLabelFromObject(electricalCircuit)
  };
}

function extractElectricalCircuitLabelFromObject(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const primary =
    (typeof value.primaryLabel === "string" ? value.primaryLabel.trim() : "") ||
    (typeof value.label === "string" ? value.label.trim() : "") ||
    "";
  if (primary) return primary;
  const panel =
    (typeof value.panel === "string" ? value.panel.trim() : "") ||
    (typeof value.Panel === "string" ? value.Panel.trim() : "") ||
    "";
  const circuit =
    (typeof value.circuitNumber === "string" ? value.circuitNumber.trim() : "") ||
    (typeof value.circuit === "string" ? value.circuit.trim() : "") ||
    (typeof value["Circuit Number"] === "string" ? String(value["Circuit Number"]).trim() : "") ||
    "";
  const combined = `${panel}${panel && circuit ? "/" : ""}${circuit}`.trim();
  return combined || null;
}

function looksLikeElectricalCircuitPayload(value: Record<string, unknown> | null | undefined): boolean {
  if (!value) return false;
  return (
    "primaryLabel" in value ||
    "panel" in value ||
    "Panel" in value ||
    "circuitNumber" in value ||
    "circuit" in value ||
    "Circuit Number" in value ||
    "Electrical Circuit" in value
  );
}

function extractNestedElectricalCircuitLabel(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const nested = value.electricalCircuit && typeof value.electricalCircuit === "object"
    ? (value.electricalCircuit as Record<string, unknown>)
    : null;
  return extractElectricalCircuitLabelFromObject(nested) ?? (looksLikeElectricalCircuitPayload(value) ? extractElectricalCircuitLabelFromObject(value) : null);
}

function normalizeCircuitLabelForMatch(value: string): string {
  return (value ?? "")
    .trim()
    .split("")
    .map((ch) => (/[a-z0-9]/i.test(ch) ? ch.toUpperCase() : "/"))
    .join("")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

function circuitLabelsMatch(actual: string, expected: string): boolean {
  const got = normalizeCircuitLabelForMatch(actual);
  const want = normalizeCircuitLabelForMatch(expected);
  if (!got || !want) return false;
  if (got === want) return true;
  const gotParts = got.split("/");
  const wantParts = want.split("/");
  return wantParts.length > 0 && wantParts.every((part) => gotParts.includes(part));
}

function buildSynthesizedPlacementContext(args: {
  exemplarElementId: number | null;
  roomWall: ResolvedRoomWallPlacementSummary | null;
}): PlacementContextSummary | null {
  const elementId = args.exemplarElementId;
  const roomWall = args.roomWall;
  if (elementId === null || elementId <= 0 || !roomWall) return null;
  if (!roomWall.supported_host) return null;
  if (roomWall.host_element_id === null || roomWall.host_element_id <= 0) return null;
  if (!roomWall.wall_projected_point || !roomWall.wall_tangent) return null;
  return {
    element_id: elementId,
    host_element_id: roomWall.host_element_id,
    place_on_host_body: {
      sourceElementId: elementId,
      hostElementId: roomWall.host_element_id,
      ...(roomWall.room_number ? { roomNumber: roomWall.room_number } : {}),
      ...(roomWall.requested_room_side ? { roomSide: roomWall.requested_room_side } : {}),
      dryRun: true,
      includePreviewImage: true
    },
    create_similar_body: {
      exemplarElementId: elementId,
      hostElementId: roomWall.host_element_id,
      ...(roomWall.room_number ? { roomNumber: roomWall.room_number } : {}),
      ...(roomWall.requested_room_side ? { roomSide: roomWall.requested_room_side } : {}),
      dryRun: true,
      includePreviewImage: true
    },
    center: roomWall.wall_projected_point,
    insertion_point: roomWall.wall_projected_point,
    wall_projected_point: roomWall.wall_projected_point,
    wall_tangent: roomWall.wall_tangent,
    placement_host_category: roomWall.placement_host_category,
    placement_host_built_in_category: roomWall.placement_host_built_in_category,
    room_number: roomWall.room_number,
    requested_room_side: roomWall.requested_room_side,
    requested_room_wall_host_ids: roomWall.requested_room_wall_host_ids,
    supported_host: roomWall.supported_host,
    source_host_supported: roomWall.source_host_supported,
    host_support_reason: roomWall.host_support_reason,
    orientation_rotation_radians: null,
    host_local_frame_basis: null,
    host_chainage_ft: null,
    host_normalized_chainage: null,
    host_curve_length_ft: roomWall.host_curve_length_ft,
    host_orientation_relative_radians: null,
    electrical_circuit_label: null
  };
}

function buildRankedPlacementContext(args: {
  ranked: RankedSimilarDeviceSummary | null;
  roomNumber: string | null;
  roomSide: string | null;
}): PlacementContextSummary | null {
  const ranked = args.ranked;
  if (!ranked || ranked.element_id === null || ranked.element_id <= 0) return null;
  if (ranked.host_id === null || ranked.host_id <= 0) return null;
  if (ranked.host_supported === false) return null;
  const createSimilar = cloneJsonObject(ranked.create_similar_body) ?? {};
  createSimilar.exemplarElementId = toFiniteInt(createSimilar.exemplarElementId) ?? ranked.element_id;
  createSimilar.hostElementId = toFiniteInt(createSimilar.hostElementId) ?? ranked.host_id;
  if (args.roomNumber && typeof createSimilar.roomNumber !== "string") createSimilar.roomNumber = args.roomNumber;
  const side = args.roomSide ?? ranked.room_side;
  if (side && typeof createSimilar.roomSide !== "string") createSimilar.roomSide = side;
  return {
    element_id: ranked.element_id,
    host_element_id: ranked.host_id,
    place_on_host_body: null,
    create_similar_body: createSimilar,
    center: ranked.wall_projected_point,
    insertion_point: ranked.wall_projected_point,
    wall_projected_point: ranked.wall_projected_point,
    wall_tangent: ranked.wall_tangent,
    placement_host_category: null,
    placement_host_built_in_category: null,
    room_number: args.roomNumber,
    requested_room_side: side,
    requested_room_wall_host_ids: ranked.host_id ? [ranked.host_id] : [],
    supported_host: true,
    source_host_supported: ranked.host_supported,
    host_support_reason: "ranked_same_room_wall_candidate",
    orientation_rotation_radians: null,
    host_local_frame_basis: ranked.host_local_frame_basis,
    host_chainage_ft: ranked.host_chainage_ft,
    host_normalized_chainage: ranked.host_normalized_chainage,
    host_curve_length_ft: ranked.host_curve_length_ft,
    host_orientation_relative_radians: null,
    electrical_circuit_label: ranked.electrical_circuit_label
  };
}

function extractLatestFrameForView(toolResults: ToolResult[], viewId: number): ViewFrameSummary | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-view-frame") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const rid = firstStringishField(res, "frameId", "frame_id", "id");
    const resViewId = toFiniteInt(res.viewId ?? res.view_id);
    const w = toFiniteInt(res.widthPx ?? res.width_px ?? res.width);
    const h = toFiniteInt(res.heightPx ?? res.height_px ?? res.height);
    if (!rid || resViewId === null || w === null || h === null) continue;
    if (resViewId !== viewId) continue;
    if (w <= 0 || h <= 0) continue;
    const mapping = res.mapping && typeof res.mapping === "object" ? (res.mapping as Record<string, unknown>) : null;
    return {
      frame_id: rid,
      width_px: w,
      height_px: h,
      top_left_xyz: parseXyzTuple(mapping?.topLeftXyz ?? mapping?.top_left_xyz),
      top_right_xyz: parseXyzTuple(mapping?.topRightXyz ?? mapping?.top_right_xyz),
      bottom_left_xyz: parseXyzTuple(mapping?.bottomLeftXyz ?? mapping?.bottom_left_xyz)
    };
  }
  return null;
}

function extractLatestFrameImageContext(toolResults: ToolResult[], viewId?: number | null): ViewFrameImageContext | null {
  const wantViewId = Number.isFinite(viewId as number) && Number(viewId) > 0 ? Math.round(Number(viewId)) : null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-view-frame") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const resViewId = toFiniteInt(res.viewId ?? res.view_id);
    if (resViewId === null || resViewId <= 0) continue;
    if (wantViewId !== null && resViewId !== wantViewId) continue;
    const frame = extractLatestFrameForView([r], resViewId);
    if (!frame) continue;
    const attachments = Array.isArray(r.attachments) ? r.attachments : [];
    const imageAttachment = attachments.find((attachment) => String((attachment as any)?.kind ?? "").toLowerCase() === "image") ?? null;
    const resultImagePath = firstStringishField(res, "path", "local_path", "filePath", "file_path", "imagePath", "image_path") || null;
    const maxImageBytes = Math.max(
      256 * 1024,
      Number.parseInt(process.env.OPERATOR_PROMPT_MAX_IMAGE_BYTES ?? `${2 * 1024 * 1024}`, 10) || 2 * 1024 * 1024
    );
    const imageDataUrl =
      (imageAttachment ? toolAttachmentToDataUrl(imageAttachment as any, maxImageBytes) : null) ??
      (resultImagePath
        ? toolAttachmentToDataUrl(
            {
              kind: "image",
              mime: inferImageAttachmentMime(resultImagePath),
              local_path: resultImagePath
            },
            maxImageBytes
          )
        : null);
    const imageLocalPath =
      typeof (imageAttachment as any)?.local_path === "string" && (imageAttachment as any).local_path.trim()
        ? (imageAttachment as any).local_path.trim()
        : resultImagePath;
    return {
      frame,
      view_id: resViewId,
      image_data_url: imageDataUrl,
      image_local_path: imageLocalPath
    };
  }
  return null;
}

export function __testOnlyExtractLatestFrameImageContext(toolResults: ToolResult[], viewId?: number | null): ViewFrameImageContext | null {
  return extractLatestFrameImageContext(toolResults, viewId);
}

function extractLatestPlacementContextSummary(toolResults: ToolResult[]): PlacementContextSummary | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-placement-context") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    return parsePlacementContextSummaryFromResult(r.result_json as Record<string, unknown>);
  }
  return null;
}

function extractLatestPlacementAuditSummary(args: {
  toolResults: ToolResult[];
  afterIndex?: number;
  elementIds?: number[];
}): PlacementContextAuditSummary | null {
  const wantedIds = new Set(
    (args.elementIds ?? [])
      .map((id) => (Number.isFinite(id as number) ? Math.round(Number(id)) : null))
      .filter((id): id is number => id !== null && id > 0)
  );
  for (let i = args.toolResults.length - 1; i >= 0; i--) {
    if (Number.isFinite(args.afterIndex as number) && i <= Number(args.afterIndex)) break;
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/audit-hosted-instance-placement") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const contexts = new Map<number, PlacementContextSummary>();
    const circuitLabels = new Map<number, string>();
    const items = Array.isArray(res.items) ? (res.items as Array<Record<string, unknown>>) : [];
    for (const item of items) {
      const placementContext = item?.placementContext && typeof item.placementContext === "object"
        ? (item.placementContext as Record<string, unknown>)
        : null;
      const contextSummary = placementContext ? parsePlacementContextSummaryFromResult(placementContext) : null;
      const elementId = toFiniteInt(item?.elementId) ?? contextSummary?.element_id ?? null;
      if (elementId === null || elementId <= 0 || !contextSummary) continue;
      contexts.set(elementId, contextSummary);
      const itemCircuit = item?.electricalCircuit && typeof item.electricalCircuit === "object"
        ? (item.electricalCircuit as Record<string, unknown>)
        : null;
      const circuitLabel = extractElectricalCircuitLabelFromObject(itemCircuit) ?? contextSummary.electrical_circuit_label;
      if (circuitLabel) circuitLabels.set(elementId, circuitLabel);
    }
    const auditedIds = Array.isArray(res.auditedIds)
      ? (res.auditedIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
      : [...contexts.keys()];
    if (wantedIds.size > 0 && ![...wantedIds].every((id) => auditedIds.includes(id) || contexts.has(id))) continue;
    return {
      index: i,
      audited_ids: auditedIds,
      valid_ids: Array.isArray(res.validIds)
        ? (res.validIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
        : [],
      invalid_ids: Array.isArray(res.invalidIds)
        ? (res.invalidIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
        : [],
      off_room_ids: Array.isArray(res.offRoomIds)
        ? (res.offRoomIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
        : [],
      off_wall_ids: Array.isArray(res.offWallIds)
        ? (res.offWallIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
        : [],
      unsupported_ids: Array.isArray(res.unsupportedIds)
        ? (res.unsupportedIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
        : [],
      missing_ids: Array.isArray(res.missingIds)
        ? (res.missingIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
        : [],
      contexts,
      circuit_labels: circuitLabels
    };
  }
  return null;
}

function extractLatestResolvedRoomWallPlacementSummary(args: {
  toolResults: ToolResult[];
  roomNumber?: string | null;
  preferredHostIds?: Array<number | null | undefined>;
}): ResolvedRoomWallPlacementSummary | null {
  const wantRoom = (args.roomNumber ?? "").trim().toUpperCase();
  const preferredHostIds = new Set(
    (args.preferredHostIds ?? [])
      .map((id) => (Number.isFinite(id as number) ? Math.round(Number(id)) : null))
      .filter((id): id is number => id !== null && id > 0)
  );

  for (let i = args.toolResults.length - 1; i >= 0; i--) {
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/resolve-room-wall") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;

    const res = r.result_json as Record<string, unknown>;
    const room = res.room && typeof res.room === "object" ? (res.room as Record<string, unknown>) : null;
    const resolvedRoomNumber =
      (typeof room?.number === "string" ? room.number.trim().toUpperCase() : "") ||
      (typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "") ||
      null;
    if (wantRoom && resolvedRoomNumber && resolvedRoomNumber !== wantRoom) continue;

    const walls = Array.isArray(res.walls) ? (res.walls as Array<Record<string, unknown>>) : [];
    if (walls.length === 0) continue;
    const requestedRoomWallHostIds = walls
      .map((row) => toFiniteInt(row?.hostElementId))
      .filter((id): id is number => id !== null && id > 0)
      .slice(0, 16);
    const pickRow =
      (preferredHostIds.size > 0
        ? walls.find((row) => {
            const hostContext = row?.hostContext && typeof row.hostContext === "object" ? (row.hostContext as Record<string, unknown>) : null;
            const hostId = toFiniteInt(hostContext?.hostElementId ?? row?.hostElementId);
            return hostId !== null && preferredHostIds.has(hostId);
          })
        : null) ??
      walls.find((row) => row?.supportsPlacement === true) ??
      walls[0] ??
      null;
    if (!pickRow) continue;

    const placementHost =
      pickRow.placementHost && typeof pickRow.placementHost === "object"
        ? (pickRow.placementHost as Record<string, unknown>)
        : null;
    const hostContext =
      pickRow.hostContext && typeof pickRow.hostContext === "object"
        ? (pickRow.hostContext as Record<string, unknown>)
        : null;
    const wallPlacement =
      pickRow.wallPlacement && typeof pickRow.wallPlacement === "object"
        ? (pickRow.wallPlacement as Record<string, unknown>)
        : null;
    const projectedPoint = parseXyzTuple(hostContext?.projectedPoint ?? wallPlacement?.projectedPoint ?? pickRow.projectedRoomPoint);
    const tangent = parseXyzTuple(hostContext?.tangent ?? wallPlacement?.tangent ?? pickRow.tangent);
    const placementHostBuiltInCategory =
      (typeof placementHost?.builtInCategory === "string" ? placementHost.builtInCategory.trim() : "") ||
      (typeof hostContext?.linkedElementBuiltInCategory === "string" ? hostContext.linkedElementBuiltInCategory.trim() : "") ||
      (typeof pickRow.hostBuiltInCategory === "string" ? pickRow.hostBuiltInCategory.trim() : "") ||
      null;
    const placementHostCategory =
      (typeof placementHost?.category === "string" ? placementHost.category.trim() : "") ||
      (typeof hostContext?.linkedElementCategory === "string" ? hostContext.linkedElementCategory.trim() : "") ||
      (typeof pickRow.category === "string" ? pickRow.category.trim() : "") ||
      null;
    const requiresExplicitPointXyz = pickRow.requiresExplicitPointXyz === true || placementHostBuiltInCategory === "OST_RvtLinks";
    const supportedHost = pickRow.supportsPlacement === true;
    const requestedSide = extractRequestedRoomSideRaw(room, res);
    return {
      host_element_id: toFiniteInt(hostContext?.hostElementId) ?? toFiniteInt(placementHost?.id) ?? toFiniteInt(pickRow.hostElementId),
      wall_projected_point: projectedPoint,
      wall_tangent: tangent,
      host_curve_length_ft: toFiniteNumber(hostContext?.curveLengthFt ?? wallPlacement?.curveLengthFt ?? pickRow.boundaryLengthFt),
      placement_host_category: placementHostCategory,
      placement_host_built_in_category: placementHostBuiltInCategory,
      room_number: (resolvedRoomNumber ?? wantRoom) || null,
      requested_room_side: requestedSide,
      requested_room_wall_host_ids: requestedRoomWallHostIds,
      supported_host: supportedHost,
      source_host_supported: supportedHost,
      host_support_reason: requiresExplicitPointXyz ? "using_requested_room_side_link_host" : "using_requested_room_side_wall_host"
    };
  }

  return null;
}

function extractPreferredPlacementContextSummary(
  toolResults: ToolResult[],
  elementId?: number | null
): PlacementContextSummary | null {
  let latest: PlacementContextSummary | null = null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-placement-context") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const summary = extractLatestPlacementContextSummary([r]);
    if (!summary) continue;
    if (elementId !== null && elementId !== undefined && summary.element_id !== null && summary.element_id !== elementId) continue;
    if (!latest) latest = summary;
    if (summary.supported_host) return summary;
  }
  return latest;
}

function summarizePlacementContextAuditAfter(args: {
  toolResults: ToolResult[];
  afterIndex: number;
  createdElementIds: number[];
  roomNumber?: string | null;
  requireRequestedWall?: boolean;
}): {
  audited_ids: number[];
  valid_ids: number[];
  invalid_ids: number[];
  off_room_ids: number[];
  off_wall_ids: number[];
  unsupported_ids: number[];
  missing_ids: number[];
} {
  const explicitAudit = extractLatestPlacementAuditSummary({
    toolResults: args.toolResults,
    afterIndex: args.afterIndex,
    elementIds: args.createdElementIds
  });
  if (explicitAudit) {
    return {
      audited_ids: explicitAudit.audited_ids,
      valid_ids: explicitAudit.valid_ids,
      invalid_ids: explicitAudit.invalid_ids,
      off_room_ids: explicitAudit.off_room_ids,
      off_wall_ids: explicitAudit.off_wall_ids,
      unsupported_ids: explicitAudit.unsupported_ids,
      missing_ids: explicitAudit.missing_ids
    };
  }

  const targetIds = new Set<number>(args.createdElementIds.filter((id) => Number.isFinite(id) && id > 0));
  const wantRoom = (args.roomNumber ?? "").trim().toUpperCase();
  const requireRequestedWall = !!args.requireRequestedWall;
  const latestByElementId = new Map<number, PlacementContextSummary>();

  for (let i = args.afterIndex + 1; i < args.toolResults.length; i++) {
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-placement-context") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const summary = extractLatestPlacementContextSummary([r]);
    if (!summary?.element_id || !targetIds.has(summary.element_id)) continue;
    latestByElementId.set(summary.element_id, summary);
  }

  const audited_ids = [...latestByElementId.keys()].sort((a, b) => a - b);
  const valid_ids: number[] = [];
  const invalid_ids: number[] = [];
  const off_room_ids: number[] = [];
  const off_wall_ids: number[] = [];
  const unsupported_ids: number[] = [];
  const missing_ids = [...targetIds].filter((id) => !latestByElementId.has(id)).sort((a, b) => a - b);

  for (const id of audited_ids) {
    const summary = latestByElementId.get(id)!;
    const inRequestedRoom = !wantRoom || !summary.room_number || summary.room_number === wantRoom;
    const allowedWallHosts = new Set(summary.requested_room_wall_host_ids);
    const onRequestedWall =
      !requireRequestedWall ||
      allowedWallHosts.size === 0 ||
      (summary.host_element_id !== null && allowedWallHosts.has(summary.host_element_id));
    const supported = summary.supported_host;

    if (!inRequestedRoom) off_room_ids.push(id);
    if (!onRequestedWall) off_wall_ids.push(id);
    if (!supported) unsupported_ids.push(id);

    if (inRequestedRoom && onRequestedWall && supported) {
      valid_ids.push(id);
    } else {
      invalid_ids.push(id);
    }
  }

  return {
    audited_ids,
    valid_ids,
    invalid_ids,
    off_room_ids,
    off_wall_ids,
    unsupported_ids,
    missing_ids
  };
}

function buildHostedPlacementAuditAction(args: {
  createdElementIds: number[];
  roomNumber?: string | null;
  roomSide?: string | null;
  targetChainageFt?: number | null;
  targetNormalizedChainage?: number | null;
  targetPointXyz?: number[] | null;
  targetToleranceFt?: number | null;
}): ActionCall {
  return {
    action_id: randomUUID(),
    method: "POST",
    path: "/revit/audit-hosted-instance-placement",
    body: {
      elementIds: args.createdElementIds,
      hostCategories: ["OST_Walls"],
      hostSearchRadiusFt: 12,
      maxNearbyHosts: 5,
      ...(args.roomNumber ? { roomNumber: args.roomNumber } : {}),
      ...(args.roomSide ? { roomSide: args.roomSide } : {}),
      ...(Number.isFinite(args.targetChainageFt as number) ? { targetChainageFt: args.targetChainageFt } : {}),
      ...(Number.isFinite(args.targetNormalizedChainage as number) ? { targetNormalizedChainage: args.targetNormalizedChainage } : {}),
      ...(Array.isArray(args.targetPointXyz) && args.targetPointXyz.length >= 3 ? { targetPointXyz: args.targetPointXyz.slice(0, 3) } : {}),
      ...(Number.isFinite(args.targetToleranceFt as number) ? { targetToleranceFt: args.targetToleranceFt } : {})
    }
  };
}

function summarizeUnresolvedPlacementIds(args: {
  createdElementIds: number[];
  audit: {
    invalid_ids: number[];
    missing_ids: number[];
  };
}): number[] {
  const unresolved = [...new Set([
    ...args.audit.invalid_ids,
    ...args.audit.missing_ids
  ])].sort((a, b) => a - b);
  if (unresolved.length > 0) return unresolved;
  return [...new Set(args.createdElementIds.filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
}

function extractPlacementContextsAfter(args: {
  toolResults: ToolResult[];
  afterIndex: number;
  elementIds: number[];
}): Map<number, PlacementContextSummary> {
  const targetIds = new Set<number>(args.elementIds.filter((id) => Number.isFinite(id) && id > 0));
  const out = new Map<number, PlacementContextSummary>();
  if (targetIds.size === 0) return out;
  const explicitAudit = extractLatestPlacementAuditSummary({
    toolResults: args.toolResults,
    afterIndex: args.afterIndex,
    elementIds: args.elementIds
  });
  if (explicitAudit) {
    for (const id of targetIds) {
      const summary = explicitAudit.contexts.get(id) ?? null;
      if (summary) out.set(id, summary);
    }
    if (out.size > 0) return out;
  }
  for (let i = args.afterIndex + 1; i < args.toolResults.length; i++) {
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-placement-context") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const summary = extractLatestPlacementContextSummary([r]);
    if (!summary?.element_id || !targetIds.has(summary.element_id)) continue;
    out.set(summary.element_id, summary);
  }
  return out;
}

function countPlacementCorrectionActionsAfter(toolResults: ToolResult[], afterIndex: number): number {
  let count = 0;
  for (let i = afterIndex + 1; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (!r || r.method !== "POST") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (
      pathName === "/revit/move-elements" ||
      pathName === "/revit/rotate-elements" ||
      pathName === "/revit/adjust-hosted-instance-on-host" ||
      pathName === "/revit/delete"
    ) count += 1;
  }
  return count;
}

function computeAlongHostOffsetFt(
  point: [number, number, number] | null,
  anchor: [number, number, number] | null,
  tangent: [number, number, number] | null
): number | null {
  const normalizedTangent = normalizeVec3(tangent);
  if (!point || !anchor || !normalizedTangent) return null;
  const along = dotVec3(subtractVec3(point, anchor), normalizedTangent);
  return Number.isFinite(along) ? along : null;
}

function normalizeRadians(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let angle = value;
  const tau = Math.PI * 2;
  while (angle <= -Math.PI) angle += tau;
  while (angle > Math.PI) angle -= tau;
  return angle;
}

function roundRotationCorrectionDegrees(deltaDegrees: number): number | null {
  const magnitude = Math.abs(deltaDegrees);
  if (!Number.isFinite(magnitude)) return null;
  if (magnitude >= 160) return deltaDegrees >= 0 ? 180 : -180;
  if (magnitude >= 70 && magnitude <= 110) return deltaDegrees >= 0 ? 90 : -90;
  return null;
}

function extractLatestVisibleInventoryCandidates(toolResults: ToolResult[], viewId: number): VisibleInventoryCandidate[] {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const resultViewId = toFiniteInt(res.viewId ?? res.view_id);
    if (resultViewId !== null && resultViewId !== viewId) continue;
    const items = extractVisibleInventoryItems(res);
    return items
      .map((item) => {
        const elementId = toFiniteInt(item.elementId ?? item.element_id ?? item.id ?? item.sourceElementId ?? item.source_element_id);
        if (elementId === null || elementId <= 0) return null;
        const host = item.host && typeof item.host === "object" ? (item.host as Record<string, unknown>) : null;
        const anchor = item.anchor && typeof item.anchor === "object" ? (item.anchor as Record<string, unknown>) : null;
        const anchorModel = anchor?.model && typeof anchor.model === "object" ? (anchor.model as Record<string, unknown>) : null;
        const bbox = item.bbox && typeof item.bbox === "object" ? (item.bbox as Record<string, unknown>) : null;
        const bboxModel = bbox?.model && typeof bbox.model === "object" ? (bbox.model as Record<string, unknown>) : null;
        const bboxCenter = bboxModel?.center && typeof bboxModel.center === "object" ? (bboxModel.center as Record<string, unknown>) : null;
        const orientation = item.orientation && typeof item.orientation === "object" ? (item.orientation as Record<string, unknown>) : null;
        return {
          element_id: elementId,
          host_id: toFiniteInt(host?.id) ?? toFiniteInt(item.hostId ?? item.host_id),
          room_number: extractInventoryItemRoomNumber(item),
          built_in_category: firstStringishField(item, "builtInCategory", "built_in_category") || null,
          center: parseXyzTuple(anchorModel ?? bboxCenter),
          rotation_radians: toFiniteNumber(orientation?.rotationRadians ?? orientation?.rotation_radians)
        } satisfies VisibleInventoryCandidate;
      })
      .filter((row): row is VisibleInventoryCandidate => !!row)
      .slice(0, 400);
  }
  return [];
}

function maybeBuildVerifiedPlacementCorrectionBridge(args: {
  toolResults: ToolResult[];
  placementIndex: number;
  createdElementIds: number[];
  requestedCount: number;
  roomNumber: string;
  spatialSide: "left" | "right" | "top" | "bottom" | null;
  spatialViewId: number;
  viewportHints: ViewportPickHint[];
  frame: ViewFrameSummary | null;
  placementContext: PlacementContextSummary | null;
  maxAutoCorrections?: number;
}): ChatResponse | null {
  const {
    toolResults,
    placementIndex,
    createdElementIds,
    requestedCount,
    roomNumber,
    spatialSide,
    spatialViewId,
    viewportHints,
    frame,
    placementContext
  } = args;
  if (!placementContext?.supported_host) return null;
  const anchor = placementContext.wall_projected_point ?? placementContext.insertion_point;
  const tangent = normalizeVec3(placementContext.wall_tangent);
  if (!anchor || !tangent) return null;
  const correctionAttempts = countPlacementCorrectionActionsAfter(toolResults, placementIndex);
  const maxAutoCorrections = Math.max(1, Math.min(3, args.maxAutoCorrections ?? 2));
  if (correctionAttempts >= maxAutoCorrections) return null;

  const contextMap = extractPlacementContextsAfter({ toolResults, afterIndex: placementIndex, elementIds: createdElementIds });
  const createdRows = createdElementIds
    .map((id) => {
      const summary = contextMap.get(id) ?? null;
      if (!summary) return null;
      const point = summary.insertion_point ?? summary.center ?? summary.wall_projected_point;
      const offset = computeAlongHostOffsetFt(point, anchor, tangent);
      if (offset === null) return null;
      return { id, summary, point, offset };
    })
    .filter((row): row is { id: number; summary: PlacementContextSummary; point: [number, number, number] | null; offset: number } => !!row);
  if (createdRows.length === 0) return null;

  const desiredOffsetResult = expandOffsetsToRequestedCountForPlacement(
    deriveAlongHostOffsetsFromHints(viewportHints, spatialViewId, frame, placementContext),
    Math.max(createdRows.length, requestedCount),
    placementContext
  );
  const desiredOffsets = desiredOffsetResult.offsets.slice(0, createdRows.length).sort((a, b) => a - b);
  const desiredChainages = deriveTargetChainagesFromOffsets(desiredOffsets, placementContext);
  if (desiredOffsets.length !== createdRows.length) return null;

  const sortedCreated = [...createdRows].sort((a, b) => a.offset - b.offset);
  const moveActions: ChatResponse["actions"] = [];
  const moveNotes: string[] = [];
  const moveToleranceFt = 0.35;
  const maxMoveFt = 18.0;
  for (let i = 0; i < sortedCreated.length; i++) {
    const row = sortedCreated[i]!;
    const desiredOffset = desiredOffsets[i]!;
    const delta = desiredOffset - row.offset;
    if (!Number.isFinite(delta) || Math.abs(delta) <= moveToleranceFt) continue;
    if (Math.abs(delta) > maxMoveFt) return null;
    if (desiredChainages.length === createdRows.length) {
      moveActions.push({
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/adjust-hosted-instance-on-host",
        body: {
          elementId: row.id,
          roomNumber: roomNumber || undefined,
          roomSide: spatialSide ?? undefined,
          targetChainageFt: desiredChainages[i]?.chainage_ft ?? undefined,
          targetNormalizedChainage: desiredChainages[i]?.normalized_chainage ?? undefined,
          dryRun: false,
          includePreviewImage: false
        }
      });
    } else {
      moveActions.push({
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/move-elements",
        body: {
          ids: [row.id],
          mode: "vector",
          vectorX: Number((tangent[0] * delta).toFixed(6)),
          vectorY: Number((tangent[1] * delta).toFixed(6)),
          vectorZ: Number((tangent[2] * delta).toFixed(6)),
          dryRun: false,
          behavior: "allOrNothing",
          options: { failOnPinned: true, unpinIfAllowed: false }
        }
      });
    }
    moveNotes.push(`${row.id} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}ft`);
  }

  if (moveActions.length > 0) {
    moveActions.push({
      action_id: randomUUID(),
      method: "POST",
      path: "/revit/export-view-region",
      body: {
        viewId: spatialViewId,
        imageMaxSizePx: 2400,
        includeMapping: true,
        region: {
          mode: "focusElements",
          focusElementIds: createdElementIds,
          marginFt: 8.0
        }
      }
    });
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I verified the placed element host context and they are on the requested ${spatialSide ?? "target"} wall, ` +
        `but they still need along-wall correction to match the mapped redline marks. ` +
        `I’ll nudge ${moveNotes.join(", ")} and recapture verification.`,
      actions: moveActions
    };
  }

  const visibleCandidates = extractLatestVisibleInventoryCandidates(toolResults, spatialViewId).filter((candidate) => {
    if (createdElementIds.includes(candidate.element_id)) return false;
    if (candidate.rotation_radians === null) return false;
    if (roomNumber && candidate.room_number && candidate.room_number !== roomNumber.toUpperCase()) return false;
    if (placementContext.host_element_id && candidate.host_id && candidate.host_id !== placementContext.host_element_id) return false;
    return candidate.center !== null;
  });
  if (visibleCandidates.length === 0) return null;

  const desiredWorldPoints = derivePlacementWorldPoints(desiredOffsets, placementContext);
  for (let i = 0; i < sortedCreated.length; i++) {
    const row = sortedCreated[i]!;
    const currentRotation = row.summary.orientation_rotation_radians;
    const targetPoint = desiredWorldPoints[i] ?? null;
    if (currentRotation === null || !targetPoint) continue;
    const nearestOrientation = visibleCandidates
      .map((candidate) => ({
        candidate,
        distanceFt: candidate.center ? distanceBetweenPoints3d(candidate.center, targetPoint) : Number.POSITIVE_INFINITY
      }))
      .filter((row2) => Number.isFinite(row2.distanceFt) && row2.distanceFt <= 6.0)
      .sort((a, b) => a.distanceFt - b.distanceFt)[0]?.candidate;
    if (!nearestOrientation || nearestOrientation.rotation_radians === null) continue;
    const deltaDegrees = normalizeRadians(nearestOrientation.rotation_radians - currentRotation) * (180 / Math.PI);
    const correctionDegrees = roundRotationCorrectionDegrees(deltaDegrees);
    if (correctionDegrees === null) continue;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The placed device ${row.id} is on the requested wall but its orientation still disagrees with the nearest same-room exemplar, ` +
        `so I’ll rotate it ${correctionDegrees > 0 ? "+" : ""}${correctionDegrees}deg and recapture verification.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/adjust-hosted-instance-on-host",
          body: {
            elementId: row.id,
            roomNumber: roomNumber || undefined,
            roomSide: spatialSide ?? undefined,
            orientationSourceElementId: nearestOrientation.element_id,
            matchOrientationFromSource: true,
            dryRun: false,
            includePreviewImage: false
          }
        },
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/export-view-region",
          body: {
            viewId: spatialViewId,
            imageMaxSizePx: 2400,
            includeMapping: true,
            region: {
              mode: "focusElements",
              focusElementIds: createdElementIds,
              marginFt: 8.0
            }
          }
        }
      ]
    };
  }

  return null;
}

function buildForcedCreateSimilarPlacementPlan(args: {
  userText: string;
  spatialViewId: number;
  viewportHints: ViewportPickHint[];
  frame: ViewFrameSummary | null;
  placementContext: PlacementContextSummary | null;
}): PlacementPlan | null {
  const placementContext = args.placementContext;
  if (!placementContext?.supported_host || !placementContext.create_similar_body) return null;
  const intent = inferPlacementIntent(args.userText);
  if (!intent.is_addition) return null;

  const baseOffsets = deriveAlongHostOffsetsFromHints(args.viewportHints, args.spatialViewId, args.frame, placementContext);
  const { offsets, heuristic } = expandOffsetsToRequestedCountForPlacement(
    baseOffsets,
    intent.requested_count,
    placementContext
  );
  const useExplicitPoints = shouldUseExplicitPointPlacements(placementContext);
  const worldPoints = useExplicitPoints ? derivePlacementWorldPoints(offsets, placementContext) : [];
  const chainages = !useExplicitPoints ? deriveTargetChainagesFromOffsets(offsets, placementContext) : [];
  if (useExplicitPoints && worldPoints.length !== offsets.length) return null;

  const body = cloneJsonObject(placementContext.create_similar_body) ?? {};
  body.placements = useExplicitPoints
    ? worldPoints.map((pointXyz, index) => ({
        pointXyz,
        label: `mark ${index + 1}`
      }))
    : chainages.length === offsets.length
      ? chainages.map((chainage, index) => ({
          targetChainageFt: chainage.chainage_ft,
          targetNormalizedChainage: chainage.normalized_chainage,
          label: `mark ${index + 1}`
        }))
      : offsets.map((offset, index) => ({
          alongHostOffsetFt: offset,
          label: `mark ${index + 1}`
        }));
  delete body.alongHostOffsetFt;
  body.dryRun = true;
  body.includePreviewImage = true;
  body.previewViewId = args.spatialViewId;
  applyElectricalPlacementHints(body, args.userText);
  return {
    path: "/revit/create-similar-from-instance",
    body,
    requested_count: intent.requested_count,
    heuristic
  };
}

type ForcedPlacementRecoveryPlan = {
  unresolved_ids: number[];
  replacement_apply_plan: PlacementPlan;
  correction_attempt: number;
  max_auto_corrections: number;
};

function buildForcedPlacementRecoveryPlan(args: {
  userText: string;
  toolResults: ToolResult[];
  placementIndex: number;
  createdElementIds: number[];
  roomNumber: string;
  spatialSide: "left" | "right" | "top" | "bottom" | null;
  spatialViewId: number;
  viewportHints: ViewportPickHint[];
  frame: ViewFrameSummary | null;
  placementContext: PlacementContextSummary | null;
  maxAutoCorrections?: number;
}): ForcedPlacementRecoveryPlan | null {
  const {
    userText,
    toolResults,
    placementIndex,
    createdElementIds,
    roomNumber,
    spatialSide,
    spatialViewId,
    viewportHints,
    frame,
    placementContext
  } = args;
  if (!placementContext?.supported_host) return null;

  const explicitAudit = extractLatestPlacementAuditSummary({
    toolResults,
    afterIndex: placementIndex,
    elementIds: createdElementIds
  });
  if (!explicitAudit) return null;

  const unresolvedIds = summarizeUnresolvedPlacementIds({
    createdElementIds,
    audit: explicitAudit
  });
  if (unresolvedIds.length === 0) return null;
  if (unresolvedIds.length !== createdElementIds.length) return null;

  const hasHardMismatch =
    explicitAudit.off_wall_ids.length > 0 ||
    explicitAudit.unsupported_ids.length > 0 ||
    explicitAudit.off_room_ids.length > 0;
  if (!hasHardMismatch) return null;

  const correctionAttempts = countPlacementCorrectionActionsAfter(toolResults, placementIndex);
  const maxAutoCorrections = Math.max(1, Math.min(3, args.maxAutoCorrections ?? 2));
  if (correctionAttempts >= maxAutoCorrections) return null;

  const replacementPreviewPlan =
    buildForcedCreateSimilarPlacementPlan({
      userText,
      spatialViewId,
      viewportHints,
      frame,
      placementContext
    }) ??
    buildSpatialPlacementPreviewPlan({
      userText,
      spatialViewId,
      viewportHints,
      frame,
      placementContext
    });
  const replacementApplyPlan = buildPlacementApplyPlan(replacementPreviewPlan);
  if (!replacementApplyPlan) return null;

  const applyBody = cloneJsonObject(replacementApplyPlan.body) ?? replacementApplyPlan.body;
  if (roomNumber) applyBody.roomNumber = roomNumber;
  if (spatialSide) applyBody.roomSide = spatialSide;

  return {
    unresolved_ids: unresolvedIds,
    replacement_apply_plan: {
      ...replacementApplyPlan,
      body: applyBody
    },
    correction_attempt: correctionAttempts + 1,
    max_auto_corrections: maxAutoCorrections
  };
}

function maybeBuildForcedPlacementRecoveryBridge(args: {
  userText: string;
  toolResults: ToolResult[];
  placementIndex: number;
  createdElementIds: number[];
  roomNumber: string;
  spatialSide: "left" | "right" | "top" | "bottom" | null;
  spatialViewId: number;
  viewportHints: ViewportPickHint[];
  frame: ViewFrameSummary | null;
  placementContext: PlacementContextSummary | null;
  maxAutoCorrections?: number;
}): ChatResponse | null {
  const recoveryPlan = buildForcedPlacementRecoveryPlan(args);
  if (!recoveryPlan) return null;

  const placementMode =
    recoveryPlan.replacement_apply_plan.path === "/revit/create-similar-from-instance"
      ? "create-similar"
      : "place-on-host";
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `placement failed verification, so I’m attempting correction ${recoveryPlan.correction_attempt}/${recoveryPlan.max_auto_corrections} ` +
      `by deleting unresolved created ids ${recoveryPlan.unresolved_ids.join(", ")} and re-running a bounded ${placementMode} placement ` +
      `from the resolved ${args.spatialSide ?? "target"} wall basis before I verify again.`,
    actions: [
      {
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/delete",
        body: {
          ids: recoveryPlan.unresolved_ids,
          dryRun: false
        }
      },
      {
        action_id: randomUUID(),
        method: "POST",
        path: recoveryPlan.replacement_apply_plan.path,
        body: recoveryPlan.replacement_apply_plan.body
      }
    ]
  };
}

type PlacementWriteFailureSummary = {
  index: number;
  path: "/revit/create-similar-from-instance" | "/revit/place-family-instance-on-host";
  error: string | null;
};

type PlacementWriteSuccessSummary = {
  index: number;
  path: "/revit/create-similar-from-instance" | "/revit/place-family-instance-on-host";
  created_element_ids: number[];
  requested_count: number;
  unresolved_labels: string[];
  source_element_id: number | null;
  source_circuit_label: string | null;
  created_circuit_labels: Map<number, string>;
  target_chainage_ft: number | null;
  target_normalized_chainage: number | null;
  target_point_xyz: number[] | null;
};

type PlacementPreviewSuccessSummary = {
  index: number;
  path: "/revit/create-similar-from-instance" | "/revit/place-family-instance-on-host";
  requested_count: number;
  preview_image_paths: string[];
  placement_validation_valid: boolean | null;
  placement_validation_reason: string | null;
};

function extractLatestPlacementWriteFailure(toolResults: ToolResult[]): PlacementWriteFailureSummary | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (pathName !== "/revit/create-similar-from-instance" && pathName !== "/revit/place-family-instance-on-host") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "failed") continue;
    return {
      index: i,
      path: pathName as PlacementWriteFailureSummary["path"],
      error: typeof r.error === "string" && r.error.trim() ? r.error.trim() : null
    };
  }
  return null;
}

function extractLatestPlacementWriteSuccess(toolResults: ToolResult[]): PlacementWriteSuccessSummary | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (pathName !== "/revit/create-similar-from-instance" && pathName !== "/revit/place-family-instance-on-host") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (resultLooksDryRun(r)) continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const createdIds = Array.isArray(res.elementIds)
      ? (res.elementIds as unknown[]).map((id) => toFiniteInt(id)).filter((id): id is number => id !== null && id > 0)
      : [];
    const directId = toFiniteInt(res.elementId);
    if (createdIds.length === 0 && directId !== null && directId > 0) createdIds.push(directId);
    const placementRows = Array.isArray(res.placements) ? (res.placements as Array<Record<string, unknown>>) : [];
    const sourcePayload =
      res.exemplar && typeof res.exemplar === "object"
        ? (res.exemplar as Record<string, unknown>)
        : res.source && typeof res.source === "object"
          ? (res.source as Record<string, unknown>)
          : null;
    const sourceElementId =
      toFiniteInt(sourcePayload?.id) ??
      toFiniteInt((res.exemplar as Record<string, unknown> | undefined)?.elementId) ??
      toFiniteInt((res.source as Record<string, unknown> | undefined)?.elementId);
    const sourceCircuitLabel = extractNestedElectricalCircuitLabel(sourcePayload);
    const createdCircuitLabels = new Map<number, string>();
    let targetChainageFt: number | null = null;
    let targetNormalizedChainage: number | null = null;
    let targetPointXyz: number[] | null = null;
    const directCircuit =
      directId !== null && directId > 0
        ? extractNestedElectricalCircuitLabel(res)
        : null;
    if (directId !== null && directId > 0 && directCircuit) createdCircuitLabels.set(directId, directCircuit);
    for (const row of placementRows) {
      const rowId = toFiniteInt(row?.elementId);
      if (rowId === null || rowId <= 0) continue;
      const rowCircuit = extractNestedElectricalCircuitLabel(row);
      if (rowCircuit) createdCircuitLabels.set(rowId, rowCircuit);
      const hostLocalFrame = row?.hostLocalFrame && typeof row.hostLocalFrame === "object" ? row.hostLocalFrame as Record<string, unknown> : null;
      if (targetChainageFt === null) {
        targetChainageFt = toFiniteNumber(row?.targetChainageFt ?? row?.target_chainage_ft ?? hostLocalFrame?.chainageFt ?? hostLocalFrame?.chainage_ft);
      }
      if (targetNormalizedChainage === null) {
        targetNormalizedChainage = toFiniteNumber(row?.targetNormalizedChainage ?? row?.target_normalized_chainage ?? hostLocalFrame?.normalizedChainage ?? hostLocalFrame?.normalized_chainage);
      }
      if (targetPointXyz === null) {
        const rawPoint = row?.targetPointXyz ?? row?.target_point_xyz ?? row?.placementPoint ?? row?.apiPlacementPoint;
        targetPointXyz = parseXyzTuple(rawPoint);
      }
    }
    const unresolvedLabels = placementRows
      .filter((row) => toFiniteInt(row?.elementId) === null)
      .map((row, index) => {
        const label = typeof row?.label === "string" ? row.label.trim() : "";
        return label || `placement ${index + 1}`;
      });
    const requestedCount = Math.max(createdIds.length, placementRows.length, pathName === "/revit/place-family-instance-on-host" ? 1 : 0);
    if (createdIds.length === 0 && requestedCount === 0) continue;
    return {
      index: i,
      path: pathName as PlacementWriteSuccessSummary["path"],
      created_element_ids: createdIds,
      requested_count: requestedCount,
      unresolved_labels: unresolvedLabels,
      source_element_id: sourceElementId !== null && sourceElementId > 0 ? sourceElementId : null,
      source_circuit_label: sourceCircuitLabel,
      created_circuit_labels: createdCircuitLabels,
      target_chainage_ft: targetChainageFt,
      target_normalized_chainage: targetNormalizedChainage,
      target_point_xyz: targetPointXyz
    };
  }
  return null;
}

function extractLatestPlacementPreviewSuccess(toolResults: ToolResult[]): PlacementPreviewSuccessSummary | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (pathName !== "/revit/create-similar-from-instance" && pathName !== "/revit/place-family-instance-on-host") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!resultLooksDryRun(r)) continue;
    const attachments = Array.isArray(r.attachments) ? r.attachments : [];
    const previewPaths = attachments
      .map((attachment) =>
        typeof (attachment as any)?.local_path === "string" && (attachment as any).local_path.trim()
          ? (attachment as any).local_path.trim()
          : null
      )
      .filter((value): value is string => !!value)
      .slice(0, 4);
    const res = r.result_json && typeof r.result_json === "object" ? (r.result_json as Record<string, unknown>) : null;
    const placementRows = Array.isArray(res?.placements) ? (res?.placements as Array<Record<string, unknown>>) : [];
    const statusText = typeof res?.status === "string" ? res.status.trim().toLowerCase() : "";
    const validation = res?.placementValidation && typeof res.placementValidation === "object"
      ? (res.placementValidation as Record<string, unknown>)
      : null;
    const validationValid = typeof validation?.valid === "boolean"
      ? validation.valid
      : (statusText.includes("invalid") ? false : null);
    const validationReason = typeof validation?.reason === "string" && validation.reason.trim()
      ? validation.reason.trim()
      : (validationValid === false ? statusText || "placement preview validation failed" : null);
    const requestedCount = Math.max(
      placementRows.length,
      pathName === "/revit/place-family-instance-on-host" ? 1 : 0
    );
    return {
      index: i,
      path: pathName as PlacementPreviewSuccessSummary["path"],
      requested_count: Math.max(1, requestedCount),
      preview_image_paths: previewPaths,
      placement_validation_valid: validationValid,
      placement_validation_reason: validationReason
    };
  }
  return null;
}

function hasPlacementWriteSuccessAfter(toolResults: ToolResult[], afterIndex: number): boolean {
  for (let i = afterIndex + 1; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (pathName !== "/revit/create-similar-from-instance" && pathName !== "/revit/place-family-instance-on-host") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (resultLooksDryRun(r)) continue;
    return true;
  }
  return false;
}

function countPlacementWriteFailuresAfter(toolResults: ToolResult[], afterIndex: number): number {
  let count = 0;
  for (let i = afterIndex + 1; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (pathName !== "/revit/create-similar-from-instance" && pathName !== "/revit/place-family-instance-on-host") continue;
    if ((r.status ?? "").trim().toLowerCase() === "failed") count++;
  }
  return count;
}

function countInvalidPlacementPreviews(toolResults: ToolResult[], pathName?: string | null): number {
  const want = (pathName ?? "").trim().toLowerCase();
  let count = 0;
  for (const r of toolResults) {
    if (!r) continue;
    const got = (r.path ?? "").trim().toLowerCase();
    if (got !== "/revit/create-similar-from-instance" && got !== "/revit/place-family-instance-on-host") continue;
    if (want && got !== want) continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!resultLooksDryRun(r)) continue;
    const res = r.result_json && typeof r.result_json === "object" ? (r.result_json as Record<string, unknown>) : null;
    const statusText = typeof res?.status === "string" ? res.status.trim().toLowerCase() : "";
    const validation = res?.placementValidation && typeof res.placementValidation === "object"
      ? (res.placementValidation as Record<string, unknown>)
      : null;
    if (validation?.valid === false || statusText.includes("invalid")) count++;
  }
  return count;
}

function hasDoneToolPathAfter(toolResults: ToolResult[], afterIndex: number, pathName: string): boolean {
  const want = (pathName ?? "").trim().toLowerCase();
  if (!want) return false;
  for (let i = afterIndex + 1; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (!r) continue;
    if ((r.path ?? "").trim().toLowerCase() !== want) continue;
    if ((r.status ?? "").trim().toLowerCase() === "done") return true;
  }
  return false;
}

function extractCreatedElementCircuitEvidence(args: {
  toolResults: ToolResult[];
  afterIndex: number;
  elementIds: number[];
}): Map<number, string> {
  const wanted = new Set(args.elementIds.filter((id) => Number.isFinite(id) && id > 0));
  const labels = new Map<number, string>();
  if (wanted.size === 0) return labels;

  const explicitAudit = extractLatestPlacementAuditSummary({
    toolResults: args.toolResults,
    afterIndex: args.afterIndex,
    elementIds: args.elementIds
  });
  if (explicitAudit) {
    for (const [id, label] of explicitAudit.circuit_labels) {
      if (wanted.has(id) && label.trim()) labels.set(id, label.trim());
    }
  }

  const authoritativeAssignmentIds = new Set<number>();
  for (let i = args.toolResults.length - 1; i > args.afterIndex; i--) {
    const r = args.toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const res = r.result_json && typeof r.result_json === "object" ? (r.result_json as Record<string, unknown>) : null;
    if (pathName === "/revit/assign-electrical-circuit") {
      const rows = Array.isArray(res?.results) ? (res.results as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const id = toFiniteInt(row?.elementId ?? row?.id);
        if (id === null || !wanted.has(id) || authoritativeAssignmentIds.has(id)) continue;
        const after = row?.after && typeof row.after === "object" ? (row.after as Record<string, unknown>) : row;
        const label = extractNestedElectricalCircuitLabel(after);
        if (!label) continue;
        labels.set(id, label.trim());
        authoritativeAssignmentIds.add(id);
      }
      continue;
    }
    if (pathName !== "/revit/get-parameters") continue;
    const items = extractResultItems(res);
    for (const item of items) {
      const id = toFiniteInt(item?.id ?? item?.elementId ?? item?.element_id);
      if (id === null || !wanted.has(id) || labels.has(id) || authoritativeAssignmentIds.has(id)) continue;
      const params = item.parameters && typeof item.parameters === "object" ? (item.parameters as Record<string, unknown>) : null;
      const panel = typeof params?.Panel === "string" ? params.Panel.trim() : "";
      const circuit =
        typeof params?.["Circuit Number"] === "string"
          ? params["Circuit Number"].trim()
          : typeof params?.Circuit === "string"
            ? params.Circuit.trim()
            : "";
      const label = `${panel}${panel && circuit ? "/" : ""}${circuit}`.trim();
      if (label) labels.set(id, label);
    }
  }

  return labels;
}

function mergePlacementWriteCircuitEvidence(labels: Map<number, string>, latestApplied: PlacementWriteSuccessSummary): Map<number, string> {
  const out = new Map(labels);
  for (const [id, label] of latestApplied.created_circuit_labels) {
    if (!out.has(id) && label.trim()) out.set(id, label.trim());
  }
  return out;
}

function extractResultItems(resultJson: unknown): Array<Record<string, unknown>> {
  const res = resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
    ? (resultJson as Record<string, unknown>)
    : null;
  if (!res) return [];
  const raw = Array.isArray(res.items)
    ? res.items
    : Array.isArray(res.elements)
      ? res.elements
      : Array.isArray(res.results)
        ? res.results
        : Array.isArray(res.rows)
          ? res.rows
          : [];
  return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

function rankedSourceCircuitLabelForPlacement(toolResults: ToolResult[], sourceId: number | null): string | null {
  const ranked = extractLatestRankedSimilarDeviceSummary(toolResults);
  if (!ranked) return null;
  if (sourceId !== null && sourceId > 0 && ranked.element_id !== sourceId) return null;
  return ranked.electrical_circuit_label?.trim() || null;
}

function sourceElementIdForPlacement(toolResults: ToolResult[], latestApplied: PlacementWriteSuccessSummary): number | null {
  if (latestApplied.source_element_id !== null && latestApplied.source_element_id > 0) return latestApplied.source_element_id;
  const rankedId = extractLatestRankedSimilarDeviceId(toolResults);
  if (rankedId !== null && rankedId > 0) return rankedId;
  const placementContext = extractLatestPlacementContextSummary(toolResults);
  if (placementContext?.element_id !== null && placementContext?.element_id !== undefined && placementContext.element_id > 0) {
    return placementContext.element_id;
  }
  return null;
}

function sourceCircuitLabelForPlacement(toolResults: ToolResult[], latestApplied: PlacementWriteSuccessSummary): string | null {
  if (latestApplied.source_circuit_label?.trim()) return latestApplied.source_circuit_label.trim();
  const sourceId = sourceElementIdForPlacement(toolResults, latestApplied);
  if (sourceId !== null && sourceId > 0) {
    const sourceReadback = extractCreatedElementCircuitEvidence({
      toolResults,
      afterIndex: latestApplied.index,
      elementIds: [sourceId]
    }).get(sourceId);
    if (sourceReadback?.trim()) return sourceReadback.trim();
    const rankedSourceCircuit = rankedSourceCircuitLabelForPlacement(toolResults, sourceId);
    if (rankedSourceCircuit) return rankedSourceCircuit;
    const parameterRow = findElectricalParameterRow(toolResults, sourceId);
    if (parameterRow?.panel && parameterRow.circuit) return `${parameterRow.panel}/${parameterRow.circuit}`;
    if (parameterRow?.panel) return parameterRow.panel;
    return null;
  }
  const placementContext = extractLatestPlacementContextSummary(toolResults);
  if (placementContext?.electrical_circuit_label?.trim()) return placementContext.electrical_circuit_label.trim();
  const rankedFallbackCircuit = rankedSourceCircuitLabelForPlacement(toolResults, null);
  if (rankedFallbackCircuit) return rankedFallbackCircuit;
  return null;
}

function expectedCircuitLabelForPlacement(text: string, latestApplied: PlacementWriteSuccessSummary, sourceCircuitLabel?: string | null): string | null {
  const requested = extractRequestedPanelCircuit(text);
  if (requested) return `${requested.panel}/${requested.circuit}`;
  if (wantsElectricalCircuitMatch(text) && sourceCircuitLabel) return sourceCircuitLabel;
  return null;
}

function isBridgeInterruptionPlacementFailure(failure: PlacementWriteFailureSummary | null): boolean {
  const error = (failure?.error ?? "").trim().toLowerCase();
  if (!error) return false;
  return (
    error.includes("fetch failed") ||
    error.includes("timed out") ||
    error.includes("timeout") ||
    error.includes("task was canceled") ||
    error.includes("connection") ||
    error.includes("modal") ||
    error.includes("dialog")
  );
}

function buildPlacementApplyPlan(plan: PlacementPlan | null): PlacementPlan | null {
  if (!plan) return null;
  const body = cloneJsonObject(plan.body);
  if (!body) return null;
  body.dryRun = false;
  if ("includePreviewImage" in body) body.includePreviewImage = false;
  return {
    path: plan.path,
    body,
    requested_count: plan.requested_count,
    heuristic: plan.heuristic
  };
}

function hasPlacementVerificationAfter(toolResults: ToolResult[], afterIndex: number): boolean {
  for (let i = afterIndex + 1; i < toolResults.length; i++) {
    const r = toolResults[i];
    if (!r || r.method !== "POST") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (
      pathName === "/revit/export-image" ||
      pathName === "/revit/export-view-region" ||
      pathName === "/revit/capture-sheet-region" ||
      pathName === "/revit/verify-parameter-on-sheet"
    ) {
      return true;
    }
  }
  return false;
}

function isRecoverablePlacementRetry(
  failure: PlacementWriteFailureSummary | null,
  plan: PlacementPlan | null
): boolean {
  if (!failure || !plan) return false;
  const error = (failure.error ?? "").toLowerCase();
  if (error.includes("unable to resolve family symbol") || error.includes("provide familysymbolid") || error.includes("sourceelementid")) {
    if (plan.path === "/revit/create-similar-from-instance") {
      const exemplarId = toFiniteInt(plan.body.exemplarElementId);
      return exemplarId !== null && exemplarId > 0;
    }
    const sourceId = toFiniteInt(plan.body.sourceElementId);
    return sourceId !== null && sourceId > 0;
  }
  if (!error.includes("explicit pointxyz basis")) return false;
  if (failure.path !== plan.path) return false;
  if (plan.path === "/revit/create-similar-from-instance") {
    const placements = Array.isArray(plan.body.placements) ? plan.body.placements : [];
    return placements.some((placement: unknown) => placement && typeof placement === "object" && Array.isArray((placement as Record<string, unknown>).pointXyz));
  }
  return Array.isArray(plan.body.pointXyz);
}

function isRecoverableInvalidPlacementPreview(
  preview: PlacementPreviewSuccessSummary | null,
  plan: PlacementPlan | null
): boolean {
  if (!preview || !plan) return false;
  if (preview.placement_validation_valid !== false) return false;
  if (plan.path === "/revit/create-similar-from-instance") {
    const exemplarId = toFiniteInt(plan.body.exemplarElementId);
    const placements = Array.isArray(plan.body.placements) ? plan.body.placements : [];
    const hasExplicitPlacementBasis = placements.some((placement: unknown) => {
      if (!placement || typeof placement !== "object") return false;
      const row = placement as Record<string, unknown>;
      return Array.isArray(row.pointXyz) || toFiniteNumber(row.targetChainageFt) !== null || toFiniteNumber(row.targetNormalizedChainage) !== null;
    });
    return exemplarId !== null && exemplarId > 0 && hasExplicitPlacementBasis;
  }
  if (preview.path !== plan.path) return false;
  if (plan.path === "/revit/place-family-instance-on-host") {
    const sourceId = toFiniteInt(plan.body.sourceElementId);
    return sourceId !== null && sourceId > 0 && Array.isArray(plan.body.pointXyz);
  }
  return false;
}

function subtractVec3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dotVec3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizeVec3(v: [number, number, number] | null): [number, number, number] | null {
  if (!v) return null;
  const mag = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(mag) || mag <= 1e-6) return null;
  return [v[0] / mag, v[1] / mag, v[2] / mag];
}

function roundTo(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

function distanceBetweenPoints3d(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function frameHintToModelPoint(frame: ViewFrameSummary, hint: ViewportPickHint): [number, number, number] | null {
  const topLeft = frame.top_left_xyz;
  const topRight = frame.top_right_xyz;
  const bottomLeft = frame.bottom_left_xyz;
  if (!topLeft || !topRight || !bottomLeft) return null;
  const u = Math.max(0, Math.min(1, hint.normalized_x));
  const v = Math.max(0, Math.min(1, hint.normalized_y));
  return [
    topLeft[0] + u * (topRight[0] - topLeft[0]) + v * (bottomLeft[0] - topLeft[0]),
    topLeft[1] + u * (topRight[1] - topLeft[1]) + v * (bottomLeft[1] - topLeft[1]),
    topLeft[2] + u * (topRight[2] - topLeft[2]) + v * (bottomLeft[2] - topLeft[2])
  ];
}

function extractRequestedPlacementCount(text: string): number | null {
  const raw = (text ?? "").trim().toLowerCase();
  if (!raw) return null;
  const numberWords: Record<string, number> = {
    one: 1,
    once: 1,
    two: 2,
    twice: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6
  };
  const nounRx = /\b(receptacles?|outlets?|devices?|switches?|fixtures?|lights?)\b/;
  const placementVerbRx = /(add|place|install|create|put|copy|duplicate|clone)/;
  const digitMatch =
    raw.match(new RegExp(`\\b${placementVerbRx.source}\\s+(?:it\\s+|the\\s+source\\s+|this\\s+)?(\\d{1,2})\\b`, "i")) ??
    raw.match(/\b(\d{1,2})\s+(new\s+|cop(?:y|ies)\s+of\s+|duplicates?\s+of\s+|clones?\s+of\s+)?(receptacles?|outlets?|devices?|switches?|fixtures?|lights?)\b/);
  const digit = digitMatch ? Number(digitMatch[2] ?? digitMatch[1]) : NaN;
  if (Number.isFinite(digit) && digit > 0) return Math.min(6, Math.floor(digit));
  for (const [word, count] of Object.entries(numberWords)) {
    if (new RegExp(`\\b${placementVerbRx.source}\\s+(?:it\\s+|the\\s+source\\s+|this\\s+)?${word}\\b`, "i").test(raw)) return count;
    if (new RegExp(`\\b${word}\\s+(new\\s+)?${nounRx.source}`, "i").test(raw)) return count;
  }
  return null;
}

function inferPlacementIntent(text: string): { is_addition: boolean; requested_count: number; prefers_exemplar_clone: boolean } {
  const raw = (text ?? "").trim().toLowerCase();
  const isAddition = /\b(add|place|install|create|put|new|copy|duplicate|clone)\b/.test(raw);
  const requestedCount = extractRequestedPlacementCount(raw) ?? 1;
  const prefersExemplarClone =
    /\b(match|matching|same|similar|existing|adjacent|near existing|like existing|create similar|copy|duplicate|clone)\b/.test(raw) ||
    requestedCount > 1;
  return {
    is_addition: isAddition,
    requested_count: Math.max(1, Math.min(6, requestedCount)),
    prefers_exemplar_clone: prefersExemplarClone
  };
}

function wantsElectricalCircuitMatch(text: string): boolean {
  const raw = (text ?? "").trim().toLowerCase();
  if (!/\b(receptacle|outlet|gfci|gfi|electrical|device|fixture|switch)\b/.test(raw)) return false;
  return (
    /\bsame circuit\b/.test(raw) ||
    /\bsame panel\b/.test(raw) ||
    /\bsame (?:host and )?parameters?\b/.test(raw) ||
    (/\b(copy|duplicate|clone)\b/.test(raw) && /\b[A-Z]{1,8}\d{1,6}\s*\/\s*[0-9]+/i.test(raw)) ||
    /\bmatch(?:ing)? circuit\b/.test(raw) ||
    /\bassign(?:ed)?(?: it)? to the same circuit\b/.test(raw) ||
    /\bcircuit it\b/.test(raw) ||
    /\bcircuit\s+(?:to|on)\b/.test(raw) ||
    /\buncircuited\b/.test(raw) ||
    /\bassign\/circuit\b/.test(raw)
  );
}

function extractRequestedPanelCircuit(text: string): { panel: string; circuit: string } | null {
  const raw = (text ?? "").trim().toUpperCase();
  if (!raw) return null;
  const match = raw.match(/\b([A-Z]{1,8}\d{1,6})\s*\/\s*([0-9]+(?:\s*,\s*[0-9]+)*)\b/);
  if (!match) return null;
  const panel = (match[1] ?? "").replace(/\s+/g, "");
  const circuit = (match[2] ?? "").replace(/\s+/g, "");
  return panel && circuit ? { panel, circuit } : null;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferRoomNumberFromRequestedPanelCircuit(requested: { panel: string; circuit: string } | null): string | null {
  if (!requested?.panel) return null;
  const panel = requested.panel.trim().toUpperCase();
  const match = panel.match(/[A-Z]+0*(\d{3,5}[A-Z]?)$/i);
  if (!match?.[1]) return null;
  return match[1].trim().toUpperCase();
}

function extractExplicitRequestedPanelCircuit(text: string): { panel: string; circuit: string } | null {
  const requested = extractRequestedPanelCircuit(text);
  if (!requested) return null;
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const token = `${escapeRegExpLiteral(requested.panel)}\\s*\\/\\s*${escapeRegExpLiteral(requested.circuit)}`;
  const explicitRx = new RegExp(
    `\\b(?:circuit(?:\\s+(?:it|this|the\\s+device|the\\s+receptacle))?\\s+(?:to|on)|` +
      `assign(?:ed)?(?:\\s+it)?\\s+to|connect(?:ed)?\\s+to|home\\s*run\\s+to|homerun\\s+to|panel)\\s+${token}\\b`,
    "i"
  );
  return explicitRx.test(raw) ? requested : null;
}

function circuitValuesMatch(actual: string, requested: string): boolean {
  const want = requested.replace(/\s+/g, "");
  const got = actual.replace(/\s+/g, "");
  if (!want || !got) return false;
  if (got === want) return true;
  const gotParts = got.split(/[,;/]+/).map((part) => part.trim()).filter(Boolean);
  const wantParts = want.split(/[,;/]+/).map((part) => part.trim()).filter(Boolean);
  return wantParts.length > 0 && wantParts.every((part) => gotParts.includes(part));
}

function applyElectricalPlacementHints(body: Record<string, unknown>, userText: string): void {
  if (!body || !wantsElectricalCircuitMatch(userText)) return;
  body.matchElectricalCircuitFromSource = true;
  body.requireElectricalCircuitMatch = true;
}

function createSimilarBodyHasExplicitTarget(body: Record<string, unknown>): boolean {
  if (body.requiresExplicitTarget === true || body.requires_explicit_target === true) return false;
  const placements = Array.isArray(body.placements) ? body.placements : [];
  if (placements.length > 0) {
    return placements.some((placement) => {
      if (!placement || typeof placement !== "object") return false;
      const row = placement as Record<string, unknown>;
      return (
        Array.isArray(row.pointXyz) ||
        Array.isArray(row.point_xyz) ||
        toFiniteNumber(row.targetChainageFt) !== null ||
        toFiniteNumber(row.target_chainage_ft) !== null ||
        toFiniteNumber(row.targetNormalizedChainage) !== null ||
        toFiniteNumber(row.target_normalized_chainage) !== null ||
        toFiniteNumber(row.alongHostOffsetFt) !== null ||
        toFiniteNumber(row.along_host_offset_ft) !== null
      );
    });
  }
  return (
    Array.isArray(body.pointXyz) ||
    Array.isArray(body.point_xyz) ||
    toFiniteNumber(body.targetChainageFt) !== null ||
    toFiniteNumber(body.target_chainage_ft) !== null ||
    toFiniteNumber(body.targetNormalizedChainage) !== null ||
    toFiniteNumber(body.target_normalized_chainage) !== null ||
    toFiniteNumber(body.alongHostOffsetFt) !== null ||
    toFiniteNumber(body.along_host_offset_ft) !== null
  );
}

function buildRankedCreateSimilarFallbackPlan(args: {
  userText: string;
  spatialViewId: number;
  ranked: RankedSimilarDeviceSummary | null;
  roomNumber: string | null;
  roomSide: string | null;
}): PlacementPlan | null {
  const body = cloneJsonObject(args.ranked?.create_similar_body);
  if (!body) return null;
  const exemplarId = toFiniteInt(body.exemplarElementId) ?? args.ranked?.element_id ?? null;
  const hostId = toFiniteInt(body.hostElementId) ?? args.ranked?.host_id ?? null;
  if (exemplarId === null || exemplarId <= 0 || hostId === null || hostId <= 0) return null;
  body.exemplarElementId = exemplarId;
  body.hostElementId = hostId;
  if (args.roomNumber && typeof body.roomNumber !== "string") body.roomNumber = args.roomNumber;
  if (args.roomSide && typeof body.roomSide !== "string") body.roomSide = args.roomSide;
  if (!createSimilarBodyHasExplicitTarget(body)) return null;
  body.dryRun = true;
  body.includePreviewImage = true;
  body.previewViewId = args.spatialViewId;
  applyElectricalPlacementHints(body, args.userText);
  return {
    path: "/revit/create-similar-from-instance",
    body,
    requested_count: Math.max(1, Array.isArray(body.placements) ? body.placements.length : 1),
    heuristic: false
  };
}

function inferMarkSideFromNormalizedPoint(nx: number, ny: number): "left" | "right" | "top" | "bottom" | null {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const distances: Array<["left" | "right" | "top" | "bottom", number]> = [
    ["left", nx],
    ["right", 1 - nx],
    ["top", ny],
    ["bottom", 1 - ny]
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const [side, distance] = distances[0]!;
  return distance <= 0.38 ? side : null;
}

function imageMarkHintFromViewportHints(viewportHints: ViewportPickHint[], targetViewId?: number | null): ImageMarkHint | null {
  const hints = viewportHints
    .filter((hint) => targetViewId === null || targetViewId === undefined || hint.view_id === targetViewId)
    .sort((a, b) => b.score - a.score);
  const best = hints[0] ?? viewportHints.slice().sort((a, b) => b.score - a.score)[0] ?? null;
  if (!best || !Number.isFinite(best.normalized_x) || !Number.isFinite(best.normalized_y)) return null;
  const normalizedX = clamp01(best.normalized_x);
  const normalizedY = clamp01(best.normalized_y);
  return {
    normalized_x: normalizedX,
    normalized_y: normalizedY,
    side: inferMarkSideFromNormalizedPoint(normalizedX, normalizedY),
    source: best.source ?? (best.frame_aligned ? "view_alignment" : "unknown"),
    score: Math.max(0, Math.min(1, Number(best.score) || 0.55))
  };
}

function projectImageMarkThroughAlignmentCrop(
  rawHint: ImageMarkHint | null,
  crop: ViewAlignmentResult["crop"]
): ViewAlignmentMark | null {
  if (!rawHint || !crop) return null;
  if (!Number.isFinite(rawHint.normalized_x) || !Number.isFinite(rawHint.normalized_y)) return null;
  const minU = clamp01(crop.min_u);
  const maxU = clamp01(crop.max_u);
  const minV = clamp01(crop.min_v);
  const maxV = clamp01(crop.max_v);
  const width = maxU - minU;
  const height = maxV - minV;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0.01 || height < 0.01) return null;
  return {
    normalized_x: Number((minU + clamp01(rawHint.normalized_x) * width).toFixed(6)),
    normalized_y: Number((minV + clamp01(rawHint.normalized_y) * height).toFixed(6)),
    score: clamp01(Math.max(0.62, rawHint.score || 0)),
    label: "red markup target projected through matched view crop"
  };
}

export function __testOnlyRefineAlignmentMarksWithImageMarkCrop(args: {
  alignment: Pick<ViewAlignmentResult, "crop" | "marks" | "confidence">;
  rawHint: ImageMarkHint | null;
}): ViewAlignmentMark[] {
  return refineAlignmentMarksWithImageMarkCrop(args.alignment, args.rawHint);
}

export function __testOnlySeedRedlineFrameAlignedHint(args: {
  sessionId: string;
  viewId: number;
  normalizedX: number;
  normalizedY: number;
  score?: number;
}): void {
  const hint: ViewportPickHint = {
    view_id: Math.round(args.viewId),
    normalized_x: clamp01(args.normalizedX),
    normalized_y: clamp01(args.normalizedY),
    score: clamp01(args.score ?? 0.9),
    source: "view_alignment",
    frame_aligned: true
  };
  noteViewportPickHints(args.sessionId, [hint]);
  noteImageMarkHint(args.sessionId, {
    normalized_x: hint.normalized_x,
    normalized_y: hint.normalized_y,
    side: inferMarkSideFromNormalizedPoint(hint.normalized_x, hint.normalized_y),
    source: "view_alignment",
    score: hint.score
  });
}

export function __testOnlySeedRedlineRawImageMarkHint(args: {
  sessionId: string;
  normalizedX: number;
  normalizedY: number;
  wallLocalNormalizedChainage?: number | null;
  wallLocalAxis?: "vertical" | "horizontal" | null;
  score?: number;
}): void {
  noteImageMarkHint(args.sessionId, {
    normalized_x: clamp01(args.normalizedX),
    normalized_y: clamp01(args.normalizedY),
    side: inferMarkSideFromNormalizedPoint(args.normalizedX, args.normalizedY),
    source: "raw_image_mark",
    score: clamp01(args.score ?? 0.72),
    wall_local_normalized_chainage: Number.isFinite(args.wallLocalNormalizedChainage as number)
      ? clamp01(Number(args.wallLocalNormalizedChainage))
      : null,
    wall_local_axis: args.wallLocalAxis === "vertical" || args.wallLocalAxis === "horizontal" ? args.wallLocalAxis : null
  });
}

function refineAlignmentMarksWithImageMarkCrop(
  alignment: Pick<ViewAlignmentResult, "crop" | "marks" | "confidence">,
  rawHint: ImageMarkHint | null
): ViewAlignmentMark[] {
  const marks = Array.isArray(alignment.marks) ? alignment.marks : [];
  const projected = projectImageMarkThroughAlignmentCrop(rawHint, alignment.crop);
  if (!projected) return marks;

  const configuredThreshold = Number.parseFloat(process.env.OPERATOR_REDLINE_CROP_PROJECTION_REPLACE_THRESHOLD ?? "0.018");
  const threshold = Math.max(0.004, Math.min(0.08, Number.isFinite(configuredThreshold) ? configuredThreshold : 0.018));
  const projectedScore = clamp01(Math.max(projected.score, alignment.confidence * 0.8, marks[0]?.score ?? 0));
  const corrected: ViewAlignmentMark = { ...projected, score: projectedScore };
  if (marks.length === 0) return [corrected];

  const best = marks.slice().sort((a, b) => b.score - a.score)[0]!;
  const distance = Math.hypot(best.normalized_x - projected.normalized_x, best.normalized_y - projected.normalized_y);
  if (!Number.isFinite(distance) || distance > threshold) {
    return [
      corrected,
      ...marks.filter(
        (mark) =>
          Math.hypot(mark.normalized_x - projected.normalized_x, mark.normalized_y - projected.normalized_y) >
          threshold * 0.5
      )
    ];
  }

  const blended: ViewAlignmentMark = {
    normalized_x: Number(((best.normalized_x + projected.normalized_x) * 0.5).toFixed(6)),
    normalized_y: Number(((best.normalized_y + projected.normalized_y) * 0.5).toFixed(6)),
    score: clamp01(Math.max(best.score, projectedScore)),
    label: best.label ?? corrected.label
  };
  return [blended, ...marks.filter((mark) => mark !== best)];
}

function isFrameAlignedImageMarkHint(hint: ImageMarkHint | null): boolean {
  if (!hint) return false;
  return hint.source === "view_alignment" || hint.source === "sheet_viewport_mapping";
}

function imageMarkHintToNormalizedChainage(
  hint: ImageMarkHint | null,
  placementContext: PlacementContextSummary
): { chainage_ft: number | null; normalized_chainage: number } | null {
  if (!hint) return null;
  const side = normalizeSpatialWallSide(placementContext.requested_room_side ?? hint.side ?? "");
  if (!side) return null;
  const rawX = toFiniteNumber(hint.raw_normalized_x);
  const rawY = toFiniteNumber(hint.raw_normalized_y);
  const wallLocal = toFiniteNumber(hint.wall_local_normalized_chainage);
  const wallLocalAxis = hint.wall_local_axis ?? null;
  const wallLocalMatchesSide =
    wallLocal !== null &&
    ((wallLocalAxis === "vertical" && (side === "left" || side === "right")) ||
      (wallLocalAxis === "horizontal" && (side === "top" || side === "bottom")) ||
      wallLocalAxis === null);
  if (wallLocalMatchesSide) {
    const normalized = Math.max(0.04, Math.min(0.96, wallLocal));
    const curveLength = placementContext.host_curve_length_ft;
    return {
      chainage_ft: curveLength !== null && Number.isFinite(curveLength) && curveLength > 1e-6
        ? Number((curveLength * normalized).toFixed(6))
        : null,
      normalized_chainage: Number(normalized.toFixed(6))
    };
  }
  const useRawRoomSnippetCoordinate =
    hint.source === "raw_image_mark" ||
    (rawX !== null && rawY !== null && !!placementContext.requested_room_side);
  const raw =
    side === "left" || side === "right"
      ? useRawRoomSnippetCoordinate
        ? rawY
        : hint.normalized_y
      : useRawRoomSnippetCoordinate
        ? rawX
        : hint.normalized_x;
  if (!Number.isFinite(raw)) return null;
  const imageWidth = useRawRoomSnippetCoordinate
    ? toFiniteNumber(hint.raw_image_width) ?? toFiniteNumber(hint.image_width)
    : toFiniteNumber(hint.image_width);
  const imageHeight = useRawRoomSnippetCoordinate
    ? toFiniteNumber(hint.raw_image_height) ?? toFiniteNumber(hint.image_height)
    : toFiniteNumber(hint.image_height);
  const hasSourceImageSize =
    imageWidth !== null &&
    imageWidth > 0 &&
    imageHeight !== null &&
    imageHeight > 0;
  // Raw uploaded snippets are commonly cropped around a room and include UI/edge
  // margins, so global image coordinates understate the room-local along-wall
  // position. Keep exact frame-aligned hints in the frame path; only bias raw
  // image-mark fallback toward room-local coordinates.
  const roomLocalEstimate = hasSourceImageSize
    ? Math.max(0.04, Math.min(0.96, 0.5 + (Number(raw) - 0.5) * 1.45))
    : Number(raw);
  const normalized = Math.max(0.04, Math.min(0.96, roomLocalEstimate));
  const curveLength = placementContext.host_curve_length_ft;
  return {
    chainage_ft: curveLength !== null && Number.isFinite(curveLength) && curveLength > 1e-6
      ? Number((curveLength * normalized).toFixed(6))
      : null,
    normalized_chainage: Number(normalized.toFixed(6))
  };
}

function getBodyRoomSide(body: Record<string, unknown>): "left" | "right" | "top" | "bottom" | null {
  return typeof body.roomSide === "string"
    ? normalizeSpatialWallSide(body.roomSide)
    : typeof body.room_side === "string"
      ? normalizeSpatialWallSide(body.room_side)
      : null;
}

function getBodyRoomNumber(body: Record<string, unknown>): string | null {
  const raw = typeof body.roomNumber === "string"
    ? body.roomNumber
    : typeof body.room_number === "string"
      ? body.room_number
      : "";
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function chooseFrameAlignedViewportHintForBody(
  req: ChatRequest,
  toolResults: ToolResult[],
  body: Record<string, unknown>
): { hint: ViewportPickHint; frame: ViewFrameSummary } | null {
  const explicitViewId = toFiniteInt(body.previewViewId ?? body.viewId ?? body.view_id);
  const hints = getPersistedViewportPickHints(req.session_id)
    .filter((hint) => isFrameAlignedViewportHint(hint))
    .filter((hint) => explicitViewId === null || hint.view_id === explicitViewId)
    .sort((a, b) => b.score - a.score);
  for (const hint of hints) {
    const frame = extractLatestFrameForView(toolResults, hint.view_id);
    if (frame?.top_left_xyz && frame.top_right_xyz && frame.bottom_left_xyz) return { hint, frame };
  }
  return null;
}

function choosePlacementContextForFrameAlignedTarget(
  body: Record<string, unknown>,
  toolResults: ToolResult[]
): PlacementContextSummary | null {
  const roomNumber = getBodyRoomNumber(body);
  const roomSide = getBodyRoomSide(body);
  const hostId = toFiniteInt(body.hostElementId ?? body.host_element_id);
  const elementIds = Array.isArray(body.elementIds) ? body.elementIds : Array.isArray(body.element_ids) ? body.element_ids : [];
  const exemplarId =
    toFiniteInt(body.exemplarElementId ?? body.exemplar_element_id) ??
    toFiniteInt(body.sourceElementId ?? body.source_element_id) ??
    toFiniteInt(elementIds[0]) ??
    null;
  const resolvedRoomWall = extractLatestResolvedRoomWallPlacementSummary({
    toolResults,
    roomNumber,
    preferredHostIds: [hostId]
  });
  const synthesized = buildSynthesizedPlacementContext({ exemplarElementId: exemplarId, roomWall: resolvedRoomWall });
  if (synthesized?.wall_projected_point && synthesized.wall_tangent) return synthesized;

  const rankedContext = buildRankedPlacementContext({
    ranked: extractLatestRankedSimilarDeviceSummary(toolResults),
    roomNumber,
    roomSide
  });
  if (rankedContext?.wall_projected_point && rankedContext.wall_tangent) return rankedContext;

  const latestContext = extractLatestPlacementContextSummary(toolResults);
  if (latestContext?.wall_projected_point && latestContext.wall_tangent) {
    return {
      ...latestContext,
      room_number: latestContext.room_number ?? roomNumber,
      requested_room_side: latestContext.requested_room_side ?? roomSide
    };
  }
  return null;
}

function deriveFrameAlignedHostTarget(
  body: Record<string, unknown>,
  req: ChatRequest | null | undefined,
  toolResults: ToolResult[]
): FrameAlignedHostTarget | null {
  if (!req) return null;
  if (!isWhereIndicatedRedlinePlacementText(getRecentUserTextForRedline(req))) return null;
  const frameHint = chooseFrameAlignedViewportHintForBody(req, toolResults, body);
  if (!frameHint) return null;
  const placementContext = choosePlacementContextForFrameAlignedTarget(body, toolResults);
  if (!placementContext?.wall_projected_point || !placementContext.wall_tangent) return null;
  if (deriveWallLocalRedlineChainageTarget(body, req, toolResults)) return null;
  const modelPoint = frameHintToModelPoint(frameHint.frame, frameHint.hint);
  const tangent = normalizeVec3(placementContext.wall_tangent);
  if (!modelPoint || !tangent) return null;

  const anchor = placementContext.wall_projected_point;
  const along = dotVec3(subtractVec3(modelPoint, anchor), tangent);
  if (!Number.isFinite(along) || Math.abs(along) > 80) return null;

  const existingPoint = firstPlacementPointXyz(body);
  const z =
    existingPoint && Number.isFinite(existingPoint[2])
      ? existingPoint[2]
      : placementContext.insertion_point && Number.isFinite(placementContext.insertion_point[2])
        ? placementContext.insertion_point[2]
        : Number.isFinite(anchor[2])
          ? anchor[2]
          : 0;
  const point: [number, number, number] = [
    Number((anchor[0] + tangent[0] * along).toFixed(6)),
    Number((anchor[1] + tangent[1] * along).toFixed(6)),
    Number((z + tangent[2] * along).toFixed(6))
  ];

  const chainage =
    placementContext.host_chainage_ft !== null && Number.isFinite(placementContext.host_chainage_ft)
      ? placementContext.host_chainage_ft + along
      : null;
  const curveLength = placementContext.host_curve_length_ft;
  return {
    point_xyz: point,
    target_chainage_ft: chainage !== null ? Number(chainage.toFixed(6)) : null,
    target_normalized_chainage:
      chainage !== null && curveLength !== null && Number.isFinite(curveLength) && curveLength > 1e-6
        ? Number((chainage / curveLength).toFixed(6))
        : null,
    source: "frame_aligned_redline_projection"
  };
}

function firstPlacementPointXyz(body: Record<string, unknown>): [number, number, number] | null {
  const direct = parseXyzTuple(body.pointXyz ?? body.point_xyz);
  if (direct) return direct;
  const placements = Array.isArray(body.placements) ? body.placements : [];
  for (const placement of placements) {
    if (!placement || typeof placement !== "object") continue;
    const point = parseXyzTuple((placement as Record<string, unknown>).pointXyz ?? (placement as Record<string, unknown>).point_xyz);
    if (point) return point;
  }
  return null;
}

function applyFrameAlignedHostTarget(
  body: Record<string, unknown>,
  target: FrameAlignedHostTarget
): boolean {
  let changed = false;
  const targetFields = {
    pointXyz: target.point_xyz,
    ...(target.target_chainage_ft !== null ? { targetChainageFt: target.target_chainage_ft } : {}),
    ...(target.target_normalized_chainage !== null ? { targetNormalizedChainage: target.target_normalized_chainage } : {}),
    targetSource: target.source
  };

  if (Array.isArray(body.placements)) {
    body.placements = body.placements.map((placement, index) => {
      if (!placement || typeof placement !== "object" || Array.isArray(placement)) return placement;
      if (index > 0) return placement;
      const row = { ...(placement as Record<string, unknown>) };
      delete row.alongHostOffsetFt;
      delete row.target_chainage_ft;
      delete row.target_normalized_chainage;
      Object.assign(row, targetFields);
      changed = true;
      return row;
    });
  } else if (Array.isArray(body.pointXyz) || toFiniteNumber(body.targetChainageFt) !== null || toFiniteNumber(body.targetNormalizedChainage) !== null) {
    delete body.alongHostOffsetFt;
    Object.assign(body, targetFields);
    changed = true;
  }

  if (changed) body.targetSource = target.source;
  return changed;
}

function hasRawRoomSnippetMarkCoordinate(hint: ImageMarkHint | null): boolean {
  if (!hint) return false;
  if (hint.source === "raw_image_mark") return true;
  return Number.isFinite(hint.raw_normalized_x as number) && Number.isFinite(hint.raw_normalized_y as number);
}

function isWhereIndicatedRedlinePlacementText(text: string): boolean {
  return /\b(where indicated|where shown|where marked|as marked|marked here|shown here|per markup|per redline|redline|markup|screenshot)\b/i.test(text);
}

function dedupeNumericOffsets(values: number[], step = 0.25): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const rounded = roundTo(value, step);
    const key = Math.round(rounded / step);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Number(rounded.toFixed(3)));
  }
  return out.sort((a, b) => a - b);
}

function expandOffsetsToRequestedCount(offsets: number[], requestedCount: number): { offsets: number[]; heuristic: boolean } {
  const clean = dedupeNumericOffsets(offsets).slice(0, requestedCount);
  if (clean.length >= requestedCount) return { offsets: clean, heuristic: false };

  const heuristic = true;
  if (requestedCount === 1 && clean.length === 0) return { offsets: [-3], heuristic };
  const spacing = requestedCount <= 2 ? 3.0 : 2.5;
  const baseCenter = clean.length > 0 ? clean.reduce((sum, item) => sum + item, 0) / clean.length : 0;
  const generated: number[] = [];
  const start = -((requestedCount - 1) / 2) * spacing;
  for (let i = 0; i < requestedCount; i++) generated.push(baseCenter + start + i * spacing);
  let expanded = dedupeNumericOffsets(generated).filter((value) => Math.abs(value) >= 0.75);
  if (expanded.length < requestedCount) {
    expanded = dedupeNumericOffsets([
      ...expanded,
      ...generateNonzeroHeuristicOffsets(requestedCount * 2, spacing)
    ]).filter((value) => Math.abs(value) >= 0.75);
  }
  return { offsets: expanded.slice(0, requestedCount), heuristic };
}

function generateNonzeroHeuristicOffsets(requestedCount: number, spacing: number): number[] {
  const out: number[] = [];
  for (let step = 1; out.length < requestedCount; step++) {
    out.push(-spacing * step);
    if (out.length >= requestedCount) break;
    out.push(spacing * step);
  }
  return dedupeNumericOffsets(out).slice(0, requestedCount);
}

function chooseInteriorHeuristicOffsets(
  placementContext: PlacementContextSummary,
  requestedCount: number
): number[] {
  const count = Math.max(1, Math.floor(requestedCount));
  const spacing = count <= 2 ? 3.0 : 2.5;
  const chainage = placementContext.host_chainage_ft;
  const curveLength = placementContext.host_curve_length_ft;
  if (
    chainage === null ||
    !Number.isFinite(chainage) ||
    curveLength === null ||
    !Number.isFinite(curveLength) ||
    curveLength <= 1.5
  ) {
    return generateNonzeroHeuristicOffsets(count, spacing);
  }

  const margin = Math.min(1.0, Math.max(0.25, curveLength * 0.1));
  const minTarget = margin;
  const maxTarget = Math.max(minTarget, curveLength - margin);
  const candidateOffsets: number[] = [];
  for (let step = 1; step <= Math.ceil(curveLength / spacing) + 2; step++) {
    for (const sign of [-1, 1]) {
      const offset = sign * spacing * step;
      const target = chainage + offset;
      if (target >= minTarget && target <= maxTarget) candidateOffsets.push(offset);
    }
    if (candidateOffsets.length >= count) break;
  }

  if (candidateOffsets.length < count) {
    for (let i = 1; i <= count + 2; i++) {
      const target = minTarget + ((maxTarget - minTarget) * i) / (count + 3);
      const offset = target - chainage;
      if (Math.abs(offset) >= 0.75) candidateOffsets.push(offset);
    }
  }

  const offsets = dedupeNumericOffsets(candidateOffsets)
    .filter((offset) => {
      const target = chainage + offset;
      return Math.abs(offset) >= 0.75 && target >= minTarget && target <= maxTarget;
    })
    .slice(0, count);
  return offsets.length > 0 ? offsets : generateNonzeroHeuristicOffsets(count, spacing);
}

function expandOffsetsToRequestedCountForPlacement(
  offsets: number[],
  requestedCount: number,
  placementContext: PlacementContextSummary
): { offsets: number[]; heuristic: boolean } {
  const clean = dedupeNumericOffsets(offsets).slice(0, requestedCount);
  const meaningful = clean.filter((offset) => Math.abs(offset) >= 0.75);
  if (meaningful.length >= requestedCount) {
    return { offsets: meaningful.slice(0, requestedCount), heuristic: false };
  }
  if (meaningful.length > 0) return expandOffsetsToRequestedCount(meaningful, requestedCount);
  return {
    offsets: chooseInteriorHeuristicOffsets(placementContext, requestedCount),
    heuristic: true
  };
}

function deriveAlongHostOffsetsFromHints(
  viewportHints: ViewportPickHint[],
  spatialViewId: number,
  frame: ViewFrameSummary | null,
  placementContext: PlacementContextSummary
): number[] {
  if (!frame) return [];
  const tangent = normalizeVec3(placementContext.wall_tangent);
  const anchor = placementContext.wall_projected_point ?? placementContext.insertion_point;
  if (!tangent || !anchor) return [];

  const offsets: number[] = [];
  for (const hint of viewportHints
    .filter((row) => row.view_id === spatialViewId && isFrameAlignedViewportHint(row))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)) {
    const modelPoint = frameHintToModelPoint(frame, hint);
    if (!modelPoint) continue;
    const along = dotVec3(subtractVec3(modelPoint, anchor), tangent);
    if (!Number.isFinite(along) || Math.abs(along) > 30) continue;
    offsets.push(along);
  }

  const deduped = dedupeNumericOffsets(offsets);
  if (deduped.length <= 1) return deduped;
  const nonZero = deduped.filter((value) => Math.abs(value) >= 0.75);
  return nonZero.length > 0 ? nonZero : deduped;
}

function hasFrameAlignedViewportHintForView(hints: ViewportPickHint[], viewId: number | null | undefined): boolean {
  if (viewId === null || viewId === undefined || !Number.isFinite(viewId)) return false;
  const normalizedViewId = Math.round(Number(viewId));
  return hints.some((hint) => hint.view_id === normalizedViewId && isFrameAlignedViewportHint(hint));
}

function shouldUseExplicitPointPlacements(placementContext: PlacementContextSummary): boolean {
  return placementContext.placement_host_built_in_category === "OST_RvtLinks";
}

function normalizeHostedPlacementPlanBody(
  body: Record<string, unknown>,
  placementContext: PlacementContextSummary
): void {
  if (placementContext.room_number && typeof body.roomNumber !== "string") {
    body.roomNumber = placementContext.room_number;
  }
  if (placementContext.requested_room_side && typeof body.roomSide !== "string") {
    body.roomSide = placementContext.requested_room_side;
  }
  const explicitTargetCheckBody = { ...body };
  delete explicitTargetCheckBody.requiresExplicitTarget;
  delete explicitTargetCheckBody.requires_explicit_target;
  if (createSimilarBodyHasExplicitTarget(explicitTargetCheckBody)) {
    delete body.requiresExplicitTarget;
    delete body.requires_explicit_target;
    if (typeof body.notes === "string" && /(explicit target|target point|chainage)/i.test(body.notes)) delete body.notes;
  }
  if (!shouldUseExplicitPointPlacements(placementContext)) return;

  // Link-face placement uses the Revit face reference and host tangent for
  // orientation. Reusing a source instance rotation can trigger a modal
  // "Can't rotate element into this position" warning even when the host/point
  // is otherwise valid.
  delete body.orientationSourceElementId;
  body.matchOrientationFromSource = false;
}

function buildPlacementWarningGuardAction(): ActionCall {
  return {
    action_id: randomUUID(),
    method: "POST",
    path: "/revit/computer-use-guard",
    body: {
      button: "default",
      dialogIdContains: "DocWarnDialog",
      interactionMode: "message_then_mouse",
      cursorRestoreMode: "keep",
      maxTriggers: 2,
      ttlMs: 60000
    }
  };
}

function buildProjectNotSavedRecentlyGuardAction(): ActionCall {
  return {
    action_id: randomUUID(),
    method: "POST",
    path: "/revit/computer-use-guard",
    body: {
      button: "cancel",
      dialogIdContains: "Project_Not_Saved_Recently",
      interactionMode: "message_then_mouse",
      cursorRestoreMode: "keep",
      maxTriggers: 1,
      ttlMs: 120000
    }
  };
}

function buildPlacementPreWriteGuardActions(): ActionCall[] {
  return [
    buildProjectNotSavedRecentlyGuardAction(),
    buildPlacementWarningGuardAction()
  ];
}

function requiresMeasuredRedlinePlacementTarget(req: ChatRequest): boolean {
  const text = getRecentUserTextForRedline(req);
  return (
    /\b(where indicated|where shown|where marked|as marked|marked here|shown here|per markup|per redline|redline|markup|screenshot)\b/i.test(text) ||
    isRedlineFocusedTurn(req) ||
    hasRedlineAttachment(req) ||
    !!getRedlineSessionSeed(req.session_id)
  );
}

function hasMeasuredRedlinePlacementTarget(viewportHints: ViewportPickHint[], imageMarkHint: ImageMarkHint | null): boolean {
  return viewportHints.some((hint) => isFrameAlignedViewportHint(hint)) || isFrameAlignedImageMarkHint(imageMarkHint);
}

function isFrameAlignedViewportHint(hint: ViewportPickHint): boolean {
  return hint.frame_aligned === true || hint.source === "view_alignment" || hint.source === "sheet_viewport_mapping";
}

function deriveTargetChainagesFromOffsets(
  offsets: number[],
  placementContext: PlacementContextSummary
): Array<{ chainage_ft: number; normalized_chainage: number | null }> {
  const anchorChainage = placementContext.host_chainage_ft;
  const curveLength = placementContext.host_curve_length_ft;
  if (anchorChainage === null || !Number.isFinite(anchorChainage) || curveLength === null || !Number.isFinite(curveLength) || curveLength <= 1e-6) {
    return [];
  }
  const margin = curveLength > 1.0 ? Math.min(1.0, Math.max(0.25, curveLength * 0.05)) : 0;
  const minChainage = margin;
  const maxChainage = Math.max(minChainage, curveLength - margin);
  return offsets.map((offset) => {
    const rawChainage = anchorChainage + offset;
    const chainage = Math.max(minChainage, Math.min(maxChainage, rawChainage));
    return {
      chainage_ft: Number(chainage.toFixed(6)),
      normalized_chainage: curveLength > 1e-6 ? Number((chainage / curveLength).toFixed(6)) : null
    };
  });
}

function derivePlacementWorldPoints(
  offsets: number[],
  placementContext: PlacementContextSummary
): Array<[number, number, number]> {
  const tangent = normalizeVec3(placementContext.wall_tangent);
  const anchor = placementContext.wall_projected_point ?? placementContext.insertion_point;
  if (!tangent || !anchor) return [];
  const insertion = placementContext.insertion_point;
  const zAnchor =
    insertion && Number.isFinite(insertion[2])
      ? insertion[2]
      : Number.isFinite(anchor[2])
        ? anchor[2]
        : 0;
  return offsets.map((offset) => [
    Number((anchor[0] + tangent[0] * offset).toFixed(6)),
    Number((anchor[1] + tangent[1] * offset).toFixed(6)),
    Number((zAnchor + tangent[2] * offset).toFixed(6))
  ]);
}

function buildSpatialPlacementPreviewPlan(args: {
  userText: string;
  spatialViewId: number;
  viewportHints: ViewportPickHint[];
  frame: ViewFrameSummary | null;
  placementContext: PlacementContextSummary | null;
  imageMarkHint?: ImageMarkHint | null;
  forcePath?: "/revit/create-similar-from-instance" | "/revit/place-family-instance-on-host";
}): { path: string; body: Record<string, unknown>; requested_count: number; heuristic: boolean } | null {
  const placementContext = args.placementContext;
  if (!placementContext) return null;
  if (!placementContext.supported_host) return null;
  const intent = inferPlacementIntent(args.userText);
  if (!intent.is_addition) return null;

  const useExplicitPoints = shouldUseExplicitPointPlacements(placementContext);
  const baseOffsets = deriveAlongHostOffsetsFromHints(args.viewportHints, args.spatialViewId, args.frame, placementContext);
  const markChainage = imageMarkHintToNormalizedChainage(args.imageMarkHint ?? null, placementContext);
  const preferRoomSnippetMarkChainage =
    !!markChainage &&
    hasRawRoomSnippetMarkCoordinate(args.imageMarkHint ?? null) &&
    !isFrameAlignedImageMarkHint(args.imageMarkHint ?? null) &&
    baseOffsets.length === 0 &&
    isWhereIndicatedRedlinePlacementText(args.userText) &&
    !!placementContext.requested_room_side;
  const imageChainage =
    markChainage &&
    ((baseOffsets.length === 0 && isFrameAlignedImageMarkHint(args.imageMarkHint ?? null)) ||
      preferRoomSnippetMarkChainage)
      ? markChainage
      : null;
  if (intent.requested_count === 1) {
    const { offsets, heuristic } = expandOffsetsToRequestedCountForPlacement(baseOffsets, 1, placementContext);
    const offsetChainages = deriveTargetChainagesFromOffsets(offsets, placementContext);
    const worldPoints = useExplicitPoints && !imageChainage && offsetChainages.length === 0
      ? derivePlacementWorldPoints(offsets, placementContext)
      : [];
    const chainages = imageChainage
      ? [imageChainage]
      : offsetChainages;
    const preferCreateSimilar =
      !!placementContext.create_similar_body &&
      (intent.prefers_exemplar_clone || wantsElectricalCircuitMatch(args.userText) || useExplicitPoints);
    const buildCreateSimilarPlan = (): PlacementPlan | null => {
      if (!placementContext.create_similar_body) return null;
      const body = cloneJsonObject(placementContext.create_similar_body) ?? {};
      if (imageChainage) {
        body.placements = [{
          ...(imageChainage.chainage_ft !== null ? { targetChainageFt: imageChainage.chainage_ft } : {}),
          targetNormalizedChainage: imageChainage.normalized_chainage,
          label: "mark 1"
        }];
      } else if (chainages.length > 0) {
        body.placements = [{
          targetChainageFt: chainages[0]?.chainage_ft ?? 0,
          targetNormalizedChainage: chainages[0]?.normalized_chainage ?? null,
          label: "mark 1"
        }];
      } else if (useExplicitPoints) {
        if (worldPoints.length === 0) return null;
        body.placements = [{ pointXyz: worldPoints[0], label: "mark 1" }];
      } else {
        body.placements = [{ alongHostOffsetFt: offsets[0] ?? 0, label: "mark 1" }];
      }
      body.dryRun = true;
      body.includePreviewImage = true;
      body.previewViewId = args.spatialViewId;
      normalizeHostedPlacementPlanBody(body, placementContext);
      applyElectricalPlacementHints(body, args.userText);
      return {
        path: "/revit/create-similar-from-instance",
        body,
        requested_count: 1,
        heuristic
      };
    };
    const buildPlaceOnHostPlan = (): PlacementPlan | null => {
      if (!placementContext.place_on_host_body) return null;
      const body = cloneJsonObject(placementContext.place_on_host_body) ?? {};
      if (imageChainage) {
        if (imageChainage.chainage_ft !== null) body.targetChainageFt = imageChainage.chainage_ft;
        body.targetNormalizedChainage = imageChainage.normalized_chainage;
        delete body.alongHostOffsetFt;
        delete body.pointXyz;
      } else if (chainages.length > 0) {
        body.targetChainageFt = chainages[0]?.chainage_ft ?? 0;
        body.targetNormalizedChainage = chainages[0]?.normalized_chainage ?? null;
        delete body.alongHostOffsetFt;
        delete body.pointXyz;
      } else if (useExplicitPoints) {
        if (worldPoints.length === 0) return null;
        body.pointXyz = worldPoints[0];
        delete body.alongHostOffsetFt;
        delete body.targetChainageFt;
        delete body.targetNormalizedChainage;
      } else {
        body.alongHostOffsetFt = offsets[0] ?? 0;
      }
      body.dryRun = true;
      body.includePreviewImage = true;
      body.previewViewId = args.spatialViewId;
      normalizeHostedPlacementPlanBody(body, placementContext);
      applyElectricalPlacementHints(body, args.userText);
      return {
        path: "/revit/place-family-instance-on-host",
        body,
        requested_count: 1,
        heuristic
      };
    };
    if (args.forcePath === "/revit/create-similar-from-instance") return buildCreateSimilarPlan();
    if (args.forcePath === "/revit/place-family-instance-on-host") return buildPlaceOnHostPlan();
    return preferCreateSimilar
      ? buildCreateSimilarPlan() ?? buildPlaceOnHostPlan()
      : buildPlaceOnHostPlan() ?? buildCreateSimilarPlan();
  }

  const body = cloneJsonObject(placementContext.create_similar_body);
  if (!body) return null;
  const { offsets, heuristic } = expandOffsetsToRequestedCountForPlacement(
    baseOffsets,
    intent.requested_count,
    placementContext
  );
  const chainages = deriveTargetChainagesFromOffsets(offsets, placementContext);
  const worldPoints = useExplicitPoints && chainages.length !== offsets.length ? derivePlacementWorldPoints(offsets, placementContext) : [];
  if (useExplicitPoints && chainages.length !== offsets.length && worldPoints.length !== offsets.length) return null;
  body.placements = chainages.length === offsets.length
      ? chainages.map((chainage, index) => ({
          targetChainageFt: chainage.chainage_ft,
          targetNormalizedChainage: chainage.normalized_chainage,
          label: `mark ${index + 1}`
        }))
      : useExplicitPoints
        ? worldPoints.map((pointXyz, index) => ({
            pointXyz,
            label: `mark ${index + 1}`
          }))
      : offsets.map((offset, index) => ({
          alongHostOffsetFt: offset,
          label: `mark ${index + 1}`
        }));
  delete body.alongHostOffsetFt;
  body.dryRun = true;
  body.includePreviewImage = true;
  body.previewViewId = args.spatialViewId;
  normalizeHostedPlacementPlanBody(body, placementContext);
  applyElectricalPlacementHints(body, args.userText);
  return {
    path: "/revit/create-similar-from-instance",
    body,
    requested_count: intent.requested_count,
    heuristic
  };
}

function hasRecentPickAtPixel(toolResults: ToolResult[], frameId?: string): boolean {
  const wantFrame = (frameId ?? "").trim();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/pick-at-pixel") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!wantFrame) return true;
    if (!r.result_json || typeof r.result_json !== "object") return true;
    const res = r.result_json as Record<string, unknown>;
    const gotFrame = typeof res.frameId === "string" ? res.frameId.trim() : "";
    if (!gotFrame) return true;
    if (gotFrame === wantFrame) return true;
  }
  return false;
}

function countRecentPickAtPixelAttempts(toolResults: ToolResult[], frameId?: string, maxScan = 24): number {
  const wantFrame = (frameId ?? "").trim();
  let count = 0;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    if (count >= maxScan) break;
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/pick-at-pixel") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!wantFrame) {
      count += 1;
      continue;
    }
    if (!r.result_json || typeof r.result_json !== "object") {
      count += 1;
      continue;
    }
    const res = r.result_json as Record<string, unknown>;
    const gotFrame = typeof res.frameId === "string" ? res.frameId.trim() : "";
    if (!gotFrame || gotFrame === wantFrame) count += 1;
  }
  return count;
}

function extractLatestPickCandidateIds(toolResults: ToolResult[], frameId?: string): number[] {
  const wantFrame = (frameId ?? "").trim();
  const ids: number[] = [];
  const seen = new Set<number>();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    if (ids.length >= 12) break;
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/pick-at-pixel") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const gotFrame = typeof res.frameId === "string" ? res.frameId.trim() : "";
    if (wantFrame && gotFrame && gotFrame !== wantFrame) continue;
    const directId = toFiniteInt(res.elementId);
    if (directId !== null && directId > 0 && !seen.has(directId)) {
      seen.add(directId);
      ids.push(directId);
    }
    const hits = Array.isArray(res.hits) ? (res.hits as Array<Record<string, unknown>>) : [];
    const hitIds = hits
      .map((h) => toFiniteInt(h.elementId))
      .filter((x): x is number => x !== null && x > 0);
    for (const id of hitIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 12) break;
    }
  }
  return ids.slice(0, 12);
}

function extractLatestFindElementsIds(toolResults: ToolResult[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/find-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const directIds = Array.isArray(res.elementIds)
      ? (res.elementIds as unknown[])
      : Array.isArray(res.ids)
        ? (res.ids as unknown[])
        : [];
    for (const rawId of directIds) {
      const id = toFiniteInt(rawId);
      if (id === null || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 200) break;
    }
    const elements = Array.isArray(res.elements) ? (res.elements as Array<Record<string, unknown>>) : [];
    for (const el of elements) {
      const id = toFiniteInt(el.elementId);
      if (id === null || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 200) break;
    }
    if (ids.length > 0) break;
  }
  return ids.slice(0, 200);
}

function extractLatestFindElementsIdsForView(toolResults: ToolResult[], viewId: number): number[] {
  const wantViewId = Math.max(1, Math.round(viewId));
  if (!Number.isFinite(wantViewId) || wantViewId <= 0) return [];
  const ids: number[] = [];
  const seen = new Set<number>();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/find-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const scope = res.scope && typeof res.scope === "object" ? (res.scope as Record<string, unknown>) : null;
    const kind = typeof scope?.kind === "string" ? scope.kind.trim().toLowerCase() : "";
    const viewIds = Array.isArray(scope?.viewIds) ? scope.viewIds : [];
    const matchesView =
      kind === "view" &&
      viewIds.some((raw) => {
        const candidate = toFiniteInt(raw);
        return candidate !== null && candidate === wantViewId;
      });
    if (!matchesView) continue;
    const directIds = Array.isArray(res.elementIds)
      ? (res.elementIds as unknown[])
      : Array.isArray(res.ids)
        ? (res.ids as unknown[])
        : [];
    for (const rawId of directIds) {
      const id = toFiniteInt(rawId);
      if (id === null || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 200) break;
    }
    return ids.slice(0, 200);
  }
  return [];
}

function hasFindElementsResultForView(toolResults: ToolResult[], viewId: number): boolean {
  const wantViewId = Math.max(1, Math.round(viewId));
  if (!Number.isFinite(wantViewId) || wantViewId <= 0) return false;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/find-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const scope = res.scope && typeof res.scope === "object" ? (res.scope as Record<string, unknown>) : null;
    const kind = typeof scope?.kind === "string" ? scope.kind.trim().toLowerCase() : "";
    const viewIds = Array.isArray(scope?.viewIds) ? scope.viewIds : [];
    const matchesView =
      kind === "view" &&
      viewIds.some((raw) => {
        const candidate = toFiniteInt(raw);
        return candidate !== null && candidate === wantViewId;
      });
    if (matchesView) return true;
  }
  return false;
}

type SpatialRoomDetail = {
  room_id: number;
  room_number: string;
  view_id: number | null;
  host_ids_by_side: Record<"left" | "right" | "top" | "bottom", number[]>;
};

type SpatialResolution = {
  room_id: number;
  room_number: string;
  spatial_kind: string | null;
  confidence: number | null;
  match_mode: string | null;
  view_id: number | null;
  host_ids_by_side: Record<"left" | "right" | "top" | "bottom", number[]>;
};

function extractLatestRoomDetailForNumber(toolResults: ToolResult[], roomNumber: string): SpatialRoomDetail | null {
  const want = (roomNumber ?? "").trim().toUpperCase();
  if (!want) return null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/rooms") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const rows = Array.isArray(r.result_json)
      ? (r.result_json as Array<Record<string, unknown>>)
      : r.result_json && typeof r.result_json === "object"
        ? [r.result_json as Record<string, unknown>]
        : [];
    for (const row of rows) {
      const room = row?.room && typeof row.room === "object" ? (row.room as Record<string, unknown>) : null;
      const number =
        (typeof row?.number === "string" ? row.number.trim().toUpperCase() : "") ||
        (typeof row?.roomNumber === "string" ? row.roomNumber.trim().toUpperCase() : "") ||
        (typeof room?.number === "string" ? room.number.trim().toUpperCase() : "");
      if (!number || number !== want) continue;
      const boundary = row?.boundary && typeof row.boundary === "object" ? (row.boundary as Record<string, unknown>) : null;
      const sideClassification =
        boundary?.sideClassification && typeof boundary.sideClassification === "object"
          ? (boundary.sideClassification as Record<string, unknown>)
          : null;
      const hostIdsBySide: Record<"left" | "right" | "top" | "bottom", number[]> = {
        left: [],
        right: [],
        top: [],
        bottom: []
      };
      if (sideClassification) {
        for (const side of ["left", "right", "top", "bottom"] as const) {
          const payload = sideClassification[side] && typeof sideClassification[side] === "object"
            ? (sideClassification[side] as Record<string, unknown>)
            : null;
          const ids = Array.isArray(payload?.hostElementIds) ? payload.hostElementIds : [];
          hostIdsBySide[side] = ids
            .map((raw) => toFiniteInt(raw))
            .filter((id): id is number => id !== null && id > 0)
            .slice(0, 80);
        }
      }
      const roomId = toFiniteInt(row?.id);
      const viewId = toFiniteInt(boundary?.viewId);
      return {
        room_id: roomId ?? 0,
        room_number: number,
        view_id: viewId,
        host_ids_by_side: hostIdsBySide
      };
    }
  }
  return null;
}

function extractLatestSpatialResolutionForNumber(toolResults: ToolResult[], roomNumber: string): SpatialResolution | null {
  const detail = extractLatestRoomDetailForNumber(toolResults, roomNumber);
  if (detail) {
    return {
      room_id: detail.room_id,
      room_number: detail.room_number,
      spatial_kind: "Room",
      confidence: 1,
      match_mode: "detail",
      view_id: detail.view_id,
      host_ids_by_side: detail.host_ids_by_side
    };
  }

  const want = (roomNumber ?? "").trim().toUpperCase();
  if (!want) return null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/room-contents") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const directNumber = typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "";
    const resolvedSpatial =
      res.resolvedSpatial && typeof res.resolvedSpatial === "object"
        ? (res.resolvedSpatial as Record<string, unknown>)
        : null;
    const resolvedNumber = typeof resolvedSpatial?.number === "string" ? resolvedSpatial.number.trim().toUpperCase() : "";
    const number = directNumber || resolvedNumber;
    if (!number || number !== want) continue;
    const roomId = toFiniteInt(res.roomId) ?? toFiniteInt(resolvedSpatial?.id) ?? 0;
    const spatialKind =
      (typeof res.spatialKind === "string" ? res.spatialKind.trim() : "") ||
      (typeof resolvedSpatial?.type === "string" ? resolvedSpatial.type.trim() : "") ||
      null;
    return {
      room_id: roomId,
      room_number: number,
      spatial_kind: spatialKind,
      confidence: toFiniteNumber(resolvedSpatial?.confidence),
      match_mode: typeof resolvedSpatial?.matchMode === "string" ? resolvedSpatial.matchMode.trim() : null,
      view_id: null,
      host_ids_by_side: { left: [], right: [], top: [], bottom: [] }
    };
  }
  return null;
}

function extractLatestRoomContentsElementIds(toolResults: ToolResult[], roomNumber: string): number[] {
  const want = (roomNumber ?? "").trim().toUpperCase();
  if (!want) return [];
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/room-contents") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const directNumber = typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "";
    const resolvedSpatial =
      res.resolvedSpatial && typeof res.resolvedSpatial === "object"
        ? (res.resolvedSpatial as Record<string, unknown>)
        : null;
    const resolvedNumber = typeof resolvedSpatial?.number === "string" ? resolvedSpatial.number.trim().toUpperCase() : "";
    const number = directNumber || resolvedNumber;
    if (!number || number !== want) continue;
    return (Array.isArray(res.elementIds) ? res.elementIds : [])
      .map((raw) => toFiniteInt(raw))
      .filter((id): id is number => id !== null && id > 0)
      .slice(0, 120);
  }
  return [];
}

function extractLatestRoomContentsLocatedCandidates(toolResults: ToolResult[], roomNumber: string): LocatedElementCandidate[] {
  const want = (roomNumber ?? "").trim().toUpperCase();
  if (!want) return [];
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/room-contents") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const directNumber = typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "";
    const resolvedSpatial =
      res.resolvedSpatial && typeof res.resolvedSpatial === "object"
        ? (res.resolvedSpatial as Record<string, unknown>)
        : null;
    const resolvedNumber = typeof resolvedSpatial?.number === "string" ? resolvedSpatial.number.trim().toUpperCase() : "";
    const number = directNumber || resolvedNumber;
    if (!number || number !== want) continue;
    const rows = Array.isArray(res.elements) ? (res.elements as Array<Record<string, unknown>>) : [];
    const out: LocatedElementCandidate[] = [];
    for (const row of rows) {
      const elementId = toFiniteInt(row?.id ?? row?.elementId);
      if (elementId === null || elementId <= 0) continue;
      out.push({
        element_id: elementId,
        host_id: toFiniteInt(row?.hostId),
        room_number: number,
        category: typeof row?.category === "string" ? row.category.trim() : null,
        built_in_category: typeof row?.builtInCategory === "string" ? row.builtInCategory.trim() : null,
        near_distance_ft: null,
        center: parseXyzTuple(row?.point ?? row?.center)
      });
    }
    return out.slice(0, 120);
  }
  return [];
}

function extractLatestRoomContentsBoundaryBbox(
  toolResults: ToolResult[],
  roomNumber: string
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const want = (roomNumber ?? "").trim().toUpperCase();
  if (!want) return null;
  const bboxFromPoints = (points: [number, number, number][]): { minX: number; maxX: number; minY: number; maxY: number } | null => {
    if (points.length === 0) return null;
    return {
      minX: Math.min(...points.map((p) => p[0])),
      maxX: Math.max(...points.map((p) => p[0])),
      minY: Math.min(...points.map((p) => p[1])),
      maxY: Math.max(...points.map((p) => p[1]))
    };
  };
  const pointsFromBoundaryLoops = (loops: unknown): [number, number, number][] => {
    if (!Array.isArray(loops)) return [];
    const points: [number, number, number][] = [];
    for (const loop of loops) {
      if (!Array.isArray(loop)) continue;
      for (const segment of loop) {
        if (!segment || typeof segment !== "object" || Array.isArray(segment)) continue;
        const row = segment as Record<string, unknown>;
        const start = parseXyzTuple(row.start);
        const end = parseXyzTuple(row.end);
        if (start) points.push(start);
        if (end) points.push(end);
      }
    }
    return points;
  };
  const roomNumberFromObject = (res: Record<string, unknown>): string => {
    const directNumber = typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "";
    const number = typeof res.number === "string" ? res.number.trim().toUpperCase() : "";
    const resolvedSpatial =
      res.resolvedSpatial && typeof res.resolvedSpatial === "object"
        ? (res.resolvedSpatial as Record<string, unknown>)
        : null;
    const resolvedNumber = typeof resolvedSpatial?.number === "string" ? resolvedSpatial.number.trim().toUpperCase() : "";
    return directNumber || number || resolvedNumber;
  };
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r) continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    if (pathName !== "/revit/room-contents" && pathName !== "/revit/rooms" && pathName !== "/revit/resolve-room-plan-view") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json) continue;

    if (pathName === "/revit/rooms" && Array.isArray(r.result_json)) {
      for (const item of r.result_json) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const room = item as Record<string, unknown>;
        if (roomNumberFromObject(room) !== want) continue;
        const bbox = bboxFromPoints(pointsFromBoundaryLoops(room.boundaryLoops));
        if (bbox) return bbox;
      }
      continue;
    }

    if (typeof r.result_json !== "object" || Array.isArray(r.result_json)) continue;
    const res = r.result_json as Record<string, unknown>;
    const number = roomNumberFromObject(res);
    if (!number || number !== want) continue;

    if (pathName === "/revit/resolve-room-plan-view") {
      const roomBbox = res.roomBbox && typeof res.roomBbox === "object" ? (res.roomBbox as Record<string, unknown>) : null;
      const min = parseXyzTuple(roomBbox?.minXyz);
      const max = parseXyzTuple(roomBbox?.maxXyz);
      if (min && max) {
        return {
          minX: Math.min(min[0], max[0]),
          maxX: Math.max(min[0], max[0]),
          minY: Math.min(min[1], max[1]),
          maxY: Math.max(min[1], max[1])
        };
      }
    }

    const bbox = bboxFromPoints(pointsFromBoundaryLoops(res.boundaryLoops));
    if (bbox) return bbox;
  }
  return null;
}

function inferRoomSideFromPointAndBoundary(
  point: [number, number, number] | null,
  bbox: { minX: number; maxX: number; minY: number; maxY: number } | null
): "left" | "right" | "top" | "bottom" | null {
  if (!point || !bbox) return null;
  const distances: Array<{ side: "left" | "right" | "top" | "bottom"; value: number }> = [
    { side: "left" as const, value: Math.abs(point[0] - bbox.minX) },
    { side: "right" as const, value: Math.abs(bbox.maxX - point[0]) },
    { side: "bottom" as const, value: Math.abs(point[1] - bbox.minY) },
    { side: "top" as const, value: Math.abs(bbox.maxY - point[1]) }
  ].filter((row) => Number.isFinite(row.value));
  distances.sort((a, b) => a.value - b.value);
  return distances[0]?.side ?? null;
}

function inferRoomSideFromViewportHintsAndBoundary(args: {
  frame: ViewFrameSummary | null;
  viewportHints: ViewportPickHint[];
  spatialViewId: number;
  bbox: { minX: number; maxX: number; minY: number; maxY: number } | null;
}): "left" | "right" | "top" | "bottom" | null {
  if (!args.frame || !args.bbox) return null;
  const hints = args.viewportHints
    .filter((hint) => hint.view_id === args.spatialViewId)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  for (const hint of hints) {
    const point = frameHintToModelPoint(args.frame, hint);
    const side = inferRoomSideFromPointAndBoundary(point, args.bbox);
    if (side) return side;
  }
  return null;
}

type LocatedElementCandidate = {
  element_id: number;
  host_id: number | null;
  room_number: string | null;
  category: string | null;
  built_in_category: string | null;
  near_distance_ft: number | null;
  center: [number, number, number] | null;
};

function extractLatestLocateElementsCandidates(toolResults: ToolResult[], roomNumber?: string | null): LocatedElementCandidate[] {
  const want = (roomNumber ?? "").trim().toUpperCase();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/locate-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractResultItems(res);
    const out: LocatedElementCandidate[] = [];
    for (const item of items) {
      const elementId = toFiniteInt(item?.elementId ?? item?.element_id ?? item?.id);
      if (elementId === null || elementId <= 0) continue;
      const itemRoom = firstStringishField(item, "roomNumber", "room_number").toUpperCase();
      if (want && itemRoom && itemRoom !== want) continue;
      out.push({
        element_id: elementId,
        host_id: toFiniteInt(item?.hostId ?? item?.host_id),
        room_number: itemRoom || null,
        category: firstStringishField(item, "category") || null,
        built_in_category: firstStringishField(item, "builtInCategory", "built_in_category") || null,
        near_distance_ft: toFiniteNumber(item?.nearDistanceFt ?? item?.near_distance_ft),
        center: parseXyzTuple(item?.center)
      });
    }
    return out.slice(0, 120);
  }
  return [];
}

function extractLatestPlacementContextElementId(toolResults: ToolResult[]): number | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-placement-context") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const elementId = toFiniteInt(res.elementId);
    if (elementId !== null && elementId > 0) return elementId;
  }
  return null;
}

type CandidateClusterSummary = {
  recommended_exemplar_element_id: number | null;
  recommended_host_element_id: number | null;
  search_radius_ft: number | null;
  target_candidate_ids: number[];
  host_candidate_ids: number[];
  target_candidates: Array<{
    element_id: number;
    host_id: number | null;
    room_number: string | null;
    distance_ft: number | null;
    score: number | null;
    host_placement_supported: boolean | null;
    on_recommended_host: boolean | null;
    on_requested_room_side: boolean | null;
  }>;
  host_candidates: Array<{
    element_id: number;
    distance_ft: number | null;
    host_offset_ft: number | null;
    supports_placement: boolean | null;
    on_requested_room_side: boolean | null;
  }>;
};

function extractLatestCandidateClusterSummary(toolResults: ToolResult[]): CandidateClusterSummary | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/pick-candidate-cluster") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const targetCandidates = Array.isArray(res.targetCandidates) ? (res.targetCandidates as Array<Record<string, unknown>>) : [];
    const hostCandidates = Array.isArray(res.hostCandidates) ? (res.hostCandidates as Array<Record<string, unknown>>) : [];
    return {
      recommended_exemplar_element_id: toFiniteInt(res.recommendedExemplarElementId),
      recommended_host_element_id: toFiniteInt(res.recommendedHostElementId),
      search_radius_ft: toFiniteNumber(res.searchRadiusFt),
      target_candidate_ids: targetCandidates
        .map((row) => toFiniteInt(row?.elementId))
        .filter((id): id is number => id !== null && id > 0)
        .slice(0, 20),
      host_candidate_ids: hostCandidates
        .map((row) => toFiniteInt(row?.elementId))
        .filter((id): id is number => id !== null && id > 0)
        .slice(0, 20),
      target_candidates: targetCandidates
        .map((row) => {
          const elementId = toFiniteInt(row?.elementId);
          if (elementId === null || elementId <= 0) return null;
          const roomNumber = typeof row?.roomNumber === "string" ? row.roomNumber.trim().toUpperCase() : "";
          return {
            element_id: elementId,
            host_id: toFiniteInt(row?.hostElementId),
            room_number: roomNumber || null,
            distance_ft: toFiniteNumber(row?.distanceFt),
            score: toFiniteNumber(row?.score),
            host_placement_supported:
              typeof row?.hostPlacementSupported === "boolean" ? row.hostPlacementSupported : null,
            on_recommended_host: typeof row?.onRecommendedHost === "boolean" ? row.onRecommendedHost : null,
            on_requested_room_side:
              typeof row?.onRequestedRoomSide === "boolean" ? row.onRequestedRoomSide : null
          };
        })
        .filter((row): row is CandidateClusterSummary["target_candidates"][number] => !!row)
        .slice(0, 20),
      host_candidates: hostCandidates
        .map((row) => {
          const elementId = toFiniteInt(row?.elementId);
          if (elementId === null || elementId <= 0) return null;
          return {
            element_id: elementId,
            distance_ft: toFiniteNumber(row?.distanceFt),
            host_offset_ft: toFiniteNumber(row?.hostOffsetFt),
            supports_placement: typeof row?.supportsPlacement === "boolean" ? row.supportsPlacement : null,
            on_requested_room_side:
              typeof row?.onRequestedRoomSide === "boolean" ? row.onRequestedRoomSide : null
          };
        })
        .filter((row): row is CandidateClusterSummary["host_candidates"][number] => !!row)
        .slice(0, 20)
    };
  }
  return null;
}

function isCandidateClusterRecommendationReliable(
  cluster: CandidateClusterSummary | null,
  targetProfile: RedlineTargetingProfile
): boolean {
  if (!cluster) return false;
  const exemplarId = cluster.recommended_exemplar_element_id ?? cluster.target_candidate_ids[0] ?? null;
  if (exemplarId === null) return false;
  const target = cluster.target_candidates.find((row) => row.element_id === exemplarId) ?? cluster.target_candidates[0] ?? null;
  const host =
    (cluster.recommended_host_element_id !== null
      ? cluster.host_candidates.find((row) => row.element_id === cluster.recommended_host_element_id)
      : null) ??
    cluster.host_candidates[0] ??
    null;
  if (!target) return false;

  const wantRoom = (targetProfile.room_number ?? "").trim().toUpperCase();
  if (wantRoom && target.room_number && target.room_number !== wantRoom) return false;

  if (targetProfile.spatial_side) {
    if (target.on_requested_room_side === false) return false;
    if (host?.on_requested_room_side === false) return false;
  }

  if (target.host_placement_supported === false && target.on_recommended_host === false) return false;

  const searchRadiusFt = cluster.search_radius_ft ?? 8;
  const maxTargetDistanceFt = Math.max(12, searchRadiusFt * 1.75);
  if (target.distance_ft !== null && target.distance_ft > maxTargetDistanceFt) return false;

  const maxHostOffsetFt = Math.max(40, searchRadiusFt * 6);
  if (host && host.host_offset_ft !== null && host.host_offset_ft > maxHostOffsetFt) return false;
  if (host?.supports_placement === false) return false;

  return true;
}

function filterLocateCandidatesByRoomSide(
  candidates: LocatedElementCandidate[],
  roomDetail: SpatialRoomDetail | null,
  side: "left" | "right" | "top" | "bottom" | null
): LocatedElementCandidate[] {
  if (!roomDetail || !side) return candidates.slice(0, 40);
  const allowedHostIds = new Set(roomDetail.host_ids_by_side[side] ?? []);
  if (allowedHostIds.size === 0) return candidates.slice(0, 40);
  const matched = candidates.filter((candidate) => candidate.host_id !== null && allowedHostIds.has(candidate.host_id));
  return (matched.length > 0 ? matched : candidates).slice(0, 40);
}

function chooseLocatedCandidateNearestResolvedWall(
  candidates: LocatedElementCandidate[],
  wall: ResolvedRoomWallPlacementSummary | null
): LocatedElementCandidate | null {
  if (!wall || !wall.wall_projected_point || !wall.wall_tangent || candidates.length === 0) return null;
  const tangent = normalizeVec3(wall.wall_tangent);
  if (!tangent) return null;

  let best: { candidate: LocatedElementCandidate; perpendicularFt: number; score: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.center) continue;
    const delta = subtractVec3(candidate.center, wall.wall_projected_point);
    const alongFt = dotVec3(delta, tangent);
    const projection: [number, number, number] = [
      wall.wall_projected_point[0] + tangent[0] * alongFt,
      wall.wall_projected_point[1] + tangent[1] * alongFt,
      wall.wall_projected_point[2] + tangent[2] * alongFt
    ];
    const perpendicularFt = distanceBetweenPoints3d(candidate.center, projection);
    if (!Number.isFinite(perpendicularFt) || perpendicularFt > 3.5) continue;
    const sameHostBoost =
      wall.host_element_id !== null && candidate.host_id !== null && candidate.host_id === wall.host_element_id ? 25 : 0;
    const score = sameHostBoost - perpendicularFt - Math.abs(alongFt) * 0.01;
    if (!best || score > best.score || (score === best.score && perpendicularFt < best.perpendicularFt)) {
      best = { candidate, perpendicularFt, score };
    }
  }
  return best?.candidate ?? null;
}

function chooseNearestLocatedCandidateForSpatialHint(args: {
  frame: ViewFrameSummary | null;
  viewportHints: ViewportPickHint[];
  spatialViewId: number;
  candidates: LocatedElementCandidate[];
  roomDetail: SpatialRoomDetail | null;
  side: "left" | "right" | "top" | "bottom" | null;
}): LocatedElementCandidate | null {
  if (!args.frame || args.candidates.length === 0) return null;
  const hintPoints = args.viewportHints
    .filter((hint) => hint.view_id === args.spatialViewId)
    .map((hint) => frameHintToModelPoint(args.frame!, hint))
    .filter((point): point is [number, number, number] => !!point);
  if (hintPoints.length === 0) return null;

  const allowedHostIds =
    args.roomDetail && args.side
      ? new Set(args.roomDetail.host_ids_by_side[args.side] ?? [])
      : new Set<number>();

  let best: { candidate: LocatedElementCandidate; score: number; distanceFt: number } | null = null;
  for (const candidate of args.candidates) {
    if (!candidate.center) continue;
    const minDistanceFt = hintPoints.reduce(
      (closest, point) => Math.min(closest, distanceBetweenPoints3d(candidate.center!, point)),
      Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(minDistanceFt)) continue;

    const sameWallBoost =
      allowedHostIds.size > 0 && candidate.host_id !== null && allowedHostIds.has(candidate.host_id) ? 100 : 0;
    const nearDistanceBoost = candidate.near_distance_ft !== null ? Math.max(0, 8 - candidate.near_distance_ft) : 0;
    const score = sameWallBoost + nearDistanceBoost - Math.min(minDistanceFt, 200);
    if (!best || score > best.score || (score === best.score && minDistanceFt < best.distanceFt)) {
      best = { candidate, score, distanceFt: minDistanceFt };
    }
  }

  return best?.candidate ?? null;
}

function chooseNearestCircuitMatchedLocatedCandidate(args: {
  toolResults: ToolResult[];
  requested: { panel: string; circuit: string };
  frame: ViewFrameSummary | null;
  viewportHints: ViewportPickHint[];
  spatialViewId: number;
  candidates: LocatedElementCandidate[];
  roomDetail: SpatialRoomDetail | null;
  side: "left" | "right" | "top" | "bottom" | null;
}): LocatedElementCandidate | null {
  const matched = args.candidates.filter((candidate) =>
    electricalParameterRowMatches(findElectricalParameterRow(args.toolResults, candidate.element_id), args.requested)
  );
  if (matched.length === 0) return null;
  return (
    chooseNearestLocatedCandidateForSpatialHint({
      frame: args.frame,
      viewportHints: args.viewportHints,
      spatialViewId: args.spatialViewId,
      candidates: matched,
      roomDetail: args.roomDetail,
      side: args.side
    }) ??
    matched[0] ??
    null
  );
}

function hasElectricalParameterRowsForAny(toolResults: ToolResult[], elementIds: number[]): boolean {
  const ids = new Set(elementIds.filter((id) => Number.isFinite(id) && id > 0));
  if (ids.size === 0) return false;
  return extractElectricalParameterRows(toolResults).some((row) => ids.has(row.id));
}

function hasToolPath(toolResults: ToolResult[], pathName: string): boolean {
  const p = (pathName ?? "").trim().toLowerCase();
  if (!p) return false;
  return toolResults.some((r) => (r.path ?? "").trim().toLowerCase() === p);
}

function getLatestToolResult(toolResults: ToolResult[], pathName: string): ToolResult | null {
  const want = (pathName ?? "").trim().toLowerCase();
  if (!want) return null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const result = toolResults[i];
    if (!result) continue;
    if ((result.path ?? "").trim().toLowerCase() !== want) continue;
    return result;
  }
  return null;
}

function asPositiveIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((entry) => toFiniteInt(entry))
    .filter((id): id is number => id !== null && id > 0);
  return [...new Set(ids)];
}

function extractDeleteEffectIds(resultJson: unknown): number[] {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return [];
  const obj = resultJson as Record<string, unknown>;
  return [
    ...asPositiveIdArray(obj.ids),
    ...asPositiveIdArray(obj.deletedIds),
    ...asPositiveIdArray(obj.impactedIds)
  ].filter((id, index, all) => all.indexOf(id) === index);
}

function extractDeletePrimaryIds(resultJson: unknown): number[] {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return [];
  const obj = resultJson as Record<string, unknown>;
  const primary = [
    ...asPositiveIdArray(obj.requestedIds),
    ...asPositiveIdArray(obj.ids),
    ...asPositiveIdArray(obj.deletedIds)
  ];
  return primary.filter((id, index, all) => all.indexOf(id) === index);
}

function extractMoveEffectIds(resultJson: unknown): number[] {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return [];
  const obj = resultJson as Record<string, unknown>;
  return [
    ...asPositiveIdArray(obj.ids),
    ...asPositiveIdArray(obj.movedIds),
    ...asPositiveIdArray(obj.impactedIds)
  ].filter((id, index, all) => all.indexOf(id) === index);
}

function extractMovePrimaryIds(resultJson: unknown): number[] {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return [];
  const obj = resultJson as Record<string, unknown>;
  const primary = [
    ...asPositiveIdArray(obj.requestedIds),
    ...asPositiveIdArray(obj.ids),
    ...asPositiveIdArray(obj.movedIds)
  ];
  return primary.filter((id, index, all) => all.indexOf(id) === index);
}

function extractRotateEffectIds(resultJson: unknown): number[] {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return [];
  const obj = resultJson as Record<string, unknown>;
  return [
    ...asPositiveIdArray(obj.ids),
    ...asPositiveIdArray(obj.rotatedIds),
    ...asPositiveIdArray(obj.impactedIds)
  ].filter((id, index, all) => all.indexOf(id) === index);
}

function extractRotatePrimaryIds(resultJson: unknown): number[] {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return [];
  const obj = resultJson as Record<string, unknown>;
  const primary = [
    ...asPositiveIdArray(obj.requestedIds),
    ...asPositiveIdArray(obj.ids),
    ...asPositiveIdArray(obj.rotatedIds)
  ];
  return primary.filter((id, index, all) => all.indexOf(id) === index);
}

function extractReplayableMoveBody(resultJson: unknown, ids: number[]): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  const obj = resultJson as Record<string, unknown>;
  const request = obj.request && typeof obj.request === "object" && !Array.isArray(obj.request)
    ? obj.request as Record<string, unknown>
    : {};
  const candidates = [request, obj];
  for (const candidate of candidates) {
    const vectorX = toFiniteNumber(candidate.vectorX ?? candidate.vector_x);
    const vectorY = toFiniteNumber(candidate.vectorY ?? candidate.vector_y);
    const vectorZ = toFiniteNumber(candidate.vectorZ ?? candidate.vector_z) ?? 0;
    if (vectorX === null || vectorY === null) continue;
    return {
      mode: typeof candidate.mode === "string" ? candidate.mode : "vector",
      vectorX,
      vectorY,
      vectorZ,
      behavior: typeof candidate.behavior === "string" ? candidate.behavior : "allOrNothing",
      ids,
      apply: true
    };
  }
  return null;
}

function extractReplayableRotateBody(resultJson: unknown, ids: number[]): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  const obj = resultJson as Record<string, unknown>;
  const request = obj.request && typeof obj.request === "object" && !Array.isArray(obj.request)
    ? obj.request as Record<string, unknown>
    : {};
  const candidates = [request, obj];
  for (const candidate of candidates) {
    const angleDegrees = toFiniteNumber(candidate.angleDegrees ?? candidate.angle_degrees ?? candidate.degrees);
    const rawAxis = candidate.axis && typeof candidate.axis === "object" && !Array.isArray(candidate.axis)
      ? candidate.axis as Record<string, unknown>
      : {};
    const axisSource = Object.keys(rawAxis).length > 0 ? rawAxis : candidate;
    const mode = typeof axisSource.mode === "string"
      ? axisSource.mode
      : typeof candidate.axisMode === "string"
        ? candidate.axisMode
        : "zThroughPoint";
    const pointX = toFiniteNumber(axisSource.pointX ?? axisSource.point_x ?? candidate.pointX ?? candidate.point_x);
    const pointY = toFiniteNumber(axisSource.pointY ?? axisSource.point_y ?? candidate.pointY ?? candidate.point_y);
    const pointZ = toFiniteNumber(axisSource.pointZ ?? axisSource.point_z ?? candidate.pointZ ?? candidate.point_z) ?? 0;
    if (angleDegrees === null || pointX === null || pointY === null) continue;
    return {
      ids,
      angleDegrees,
      axis: {
        mode,
        pointX,
        pointY,
        pointZ
      },
      behavior: typeof candidate.behavior === "string" ? candidate.behavior : "allOrNothing",
      dryRun: false
    };
  }
  return null;
}

function latestDeleteDryRunForApply(toolResults: ToolResult[]): { requestedIds: number[]; dryRunIds: number[]; result: ToolResult } | null {
  const latest = getLatestToolResult(toolResults, "/revit/delete");
  if (!latest || (latest.status ?? "").trim().toLowerCase() !== "done") return null;
  if (!resultLooksDryRun(latest)) return null;
  const requestedIds = extractDeletePrimaryIds(latest.result_json);
  if (requestedIds.length === 0) return null;
  const dryRunIds = extractDeleteEffectIds(latest.result_json);
  return { requestedIds, dryRunIds, result: latest };
}

function latestDeleteApplyEvidence(toolResults: ToolResult[]): { requestedIds: number[]; deletedIds: number[]; result: ToolResult } | null {
  const latest = getLatestToolResult(toolResults, "/revit/delete");
  if (!latest || (latest.status ?? "").trim().toLowerCase() !== "done") return null;
  if (resultLooksDryRun(latest)) return null;
  const requestedIds = extractDeletePrimaryIds(latest.result_json);
  if (requestedIds.length === 0) return null;
  const deletedIds = extractDeleteEffectIds(latest.result_json);
  return { requestedIds, deletedIds, result: latest };
}

function latestMoveDryRunForApply(toolResults: ToolResult[]): { requestedIds: number[]; dryRunIds: number[]; result: ToolResult } | null {
  const latest = getLatestToolResult(toolResults, "/revit/move-elements");
  if (!latest || (latest.status ?? "").trim().toLowerCase() !== "done") return null;
  if (!resultLooksDryRun(latest)) return null;
  const requestedIds = extractMovePrimaryIds(latest.result_json);
  if (requestedIds.length === 0) return null;
  const dryRunIds = extractMoveEffectIds(latest.result_json);
  return { requestedIds, dryRunIds, result: latest };
}

function latestMoveApplyEvidence(toolResults: ToolResult[]): { requestedIds: number[]; movedIds: number[]; result: ToolResult } | null {
  const latest = getLatestToolResult(toolResults, "/revit/move-elements");
  if (!latest || (latest.status ?? "").trim().toLowerCase() !== "done") return null;
  if (resultLooksDryRun(latest)) return null;
  const requestedIds = extractMovePrimaryIds(latest.result_json);
  if (requestedIds.length === 0) return null;
  const movedIds = extractMoveEffectIds(latest.result_json);
  return { requestedIds, movedIds, result: latest };
}

function latestRotateDryRunForApply(toolResults: ToolResult[]): { requestedIds: number[]; dryRunIds: number[]; result: ToolResult } | null {
  const latest = getLatestToolResult(toolResults, "/revit/rotate-elements");
  if (!latest || (latest.status ?? "").trim().toLowerCase() !== "done") return null;
  if (!resultLooksDryRun(latest)) return null;
  const requestedIds = extractRotatePrimaryIds(latest.result_json);
  if (requestedIds.length === 0) return null;
  const dryRunIds = extractRotateEffectIds(latest.result_json);
  return { requestedIds, dryRunIds, result: latest };
}

function latestRotateApplyEvidence(toolResults: ToolResult[]): { requestedIds: number[]; rotatedIds: number[]; result: ToolResult } | null {
  const latest = getLatestToolResult(toolResults, "/revit/rotate-elements");
  if (!latest || (latest.status ?? "").trim().toLowerCase() !== "done") return null;
  if (resultLooksDryRun(latest)) return null;
  const requestedIds = extractRotatePrimaryIds(latest.result_json);
  if (requestedIds.length === 0) return null;
  const rotatedIds = extractRotateEffectIds(latest.result_json);
  return { requestedIds, rotatedIds, result: latest };
}

function hasPriorDeleteDryRunCovering(toolResults: ToolResult[], requestedIds: number[], applyResult: ToolResult): boolean {
  const applyIndex = toolResults.lastIndexOf(applyResult);
  if (applyIndex <= 0) return false;
  for (let i = applyIndex - 1; i >= 0; i--) {
    const result = toolResults[i];
    if (!result || (result.path ?? "").trim().toLowerCase() !== "/revit/delete") continue;
    if ((result.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!resultLooksDryRun(result)) continue;
    const dryRequested = extractDeletePrimaryIds(result.result_json);
    if (!requestedIds.every((id) => dryRequested.includes(id))) continue;
    const dryIds = extractDeleteEffectIds(result.result_json);
    return requestedIds.every((id) => dryIds.includes(id));
  }
  return false;
}

function hasPriorMoveDryRunCovering(toolResults: ToolResult[], requestedIds: number[], applyResult: ToolResult): boolean {
  const applyIndex = toolResults.lastIndexOf(applyResult);
  if (applyIndex <= 0) return false;
  for (let i = applyIndex - 1; i >= 0; i--) {
    const result = toolResults[i];
    if (!result || (result.path ?? "").trim().toLowerCase() !== "/revit/move-elements") continue;
    if ((result.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!resultLooksDryRun(result)) continue;
    const dryRequested = extractMovePrimaryIds(result.result_json);
    if (!requestedIds.every((id) => dryRequested.includes(id))) continue;
    const dryIds = extractMoveEffectIds(result.result_json);
    return requestedIds.every((id) => dryIds.includes(id));
  }
  return false;
}

function hasPriorRotateDryRunCovering(toolResults: ToolResult[], requestedIds: number[], applyResult: ToolResult): boolean {
  const applyIndex = toolResults.lastIndexOf(applyResult);
  if (applyIndex <= 0) return false;
  for (let i = applyIndex - 1; i >= 0; i--) {
    const result = toolResults[i];
    if (!result || (result.path ?? "").trim().toLowerCase() !== "/revit/rotate-elements") continue;
    if ((result.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!resultLooksDryRun(result)) continue;
    const dryRequested = extractRotatePrimaryIds(result.result_json);
    if (!requestedIds.every((id) => dryRequested.includes(id))) continue;
    const dryIds = extractRotateEffectIds(result.result_json);
    return requestedIds.every((id) => dryIds.includes(id));
  }
  return false;
}

function hasSuccessfulToolPath(toolResults: ToolResult[], pathName: string): boolean {
  const result = getLatestToolResult(toolResults, pathName);
  if (!result) return false;
  const status = (result.status ?? "").trim().toLowerCase();
  if (status === "done") return true;
  if (status === "error" || status === "failed" || result.error) return false;
  return result.result_json !== undefined && result.result_json !== null;
}

function hasFailedToolPath(toolResults: ToolResult[], pathName: string): boolean {
  const result = getLatestToolResult(toolResults, pathName);
  if (!result) return false;
  const status = (result.status ?? "").trim().toLowerCase();
  return status === "error" || status === "failed" || !!result.error;
}

function countToolPath(toolResults: ToolResult[], pathName: string): number {
  const want = (pathName ?? "").trim().toLowerCase();
  if (!want) return 0;
  return toolResults.filter((r) => (r.path ?? "").trim().toLowerCase() === want).length;
}

function extractLatestRankedSimilarDeviceId(toolResults: ToolResult[]): number | null {
  return extractLatestRankedSimilarDeviceSummary(toolResults)?.element_id ?? null;
}

function extractLatestRankedSimilarDeviceSummary(toolResults: ToolResult[]): RankedSimilarDeviceSummary | null {
  const result = getLatestToolResult(toolResults, "/revit/rank-similar-devices-on-wall");
  const res = result?.result_json as any;
  const direct = toFiniteInt(res?.recommendedElementId ?? res?.recommended_element_id);
  const request = res?.request && typeof res.request === "object" ? res.request : null;
  const rootRoom = res?.room && typeof res.room === "object" ? res.room : null;
  const recommendedCreateSimilar = cloneJsonObject(res?.recommendedCreateSimilarRequest ?? res?.recommended_create_similar_request);
  const candidates = Array.isArray(res?.candidates) ? res.candidates : [];
  const candidate =
    (direct !== null
      ? candidates.find((row: any) => toFiniteInt(row?.elementId ?? row?.element_id) === direct)
      : null) ??
    candidates.find((row: any) => toFiniteInt(row?.elementId ?? row?.element_id) !== null) ??
    null;
  if (direct !== null || candidate) {
    const host = candidate?.host && typeof candidate.host === "object" ? candidate.host : null;
    const electricalCircuit =
      candidate?.electricalCircuit && typeof candidate.electricalCircuit === "object"
        ? candidate.electricalCircuit
        : candidate?.electrical_circuit && typeof candidate.electrical_circuit === "object"
          ? candidate.electrical_circuit
          : null;
    const hostLocalFrame =
      candidate?.hostLocalFrame && typeof candidate.hostLocalFrame === "object"
        ? candidate.hostLocalFrame
        : candidate?.host_local_frame && typeof candidate.host_local_frame === "object"
          ? candidate.host_local_frame
          : null;
    return {
      element_id: direct ?? toFiniteInt(candidate?.elementId ?? candidate?.element_id),
      host_id: toFiniteInt(
        candidate?.hostElementId ??
          candidate?.host_element_id ??
          candidate?.hostId ??
          candidate?.host_id ??
          candidate?.hostWallId ??
          candidate?.host_wall_id ??
          candidate?.wallId ??
          candidate?.wall_id ??
          host?.id
      ),
      room_side: normalizeSpatialWallSide(
        typeof candidate?.roomSide === "string"
            ? candidate.roomSide
          : typeof candidate?.room_side === "string"
            ? candidate.room_side
          : typeof candidate?.requestedRoomSide === "string"
            ? candidate.requestedRoomSide
            : typeof candidate?.requested_room_side === "string"
              ? candidate.requested_room_side
            : typeof candidate?.side === "string"
              ? candidate.side
              : typeof request?.roomSide === "string"
                ? request.roomSide
                : typeof request?.room_side === "string"
                  ? request.room_side
                : typeof rootRoom?.requestedRoomSide === "string"
                  ? rootRoom.requestedRoomSide
                  : typeof rootRoom?.requested_room_side === "string"
                    ? rootRoom.requested_room_side
                    : ""
      ),
      host_supported:
        typeof candidate?.hostPlacementSupported === "boolean"
          ? candidate.hostPlacementSupported
          : typeof candidate?.host_placement_supported === "boolean"
            ? candidate.host_placement_supported
            : null,
      electrical_circuit_label: extractElectricalCircuitLabelFromObject(electricalCircuit),
      create_similar_body: recommendedCreateSimilar,
      wall_projected_point: parseXyzTuple(hostLocalFrame?.projectedPoint ?? hostLocalFrame?.projected_point),
      wall_tangent: parseXyzTuple(hostLocalFrame?.tangent ?? hostLocalFrame?.wallTangent ?? hostLocalFrame?.wall_tangent),
      host_local_frame_basis: typeof hostLocalFrame?.basis === "string" ? hostLocalFrame.basis.trim() : null,
      host_chainage_ft: toFiniteNumber(hostLocalFrame?.chainageFt ?? hostLocalFrame?.chainage_ft),
      host_normalized_chainage: toFiniteNumber(hostLocalFrame?.normalizedChainage ?? hostLocalFrame?.normalized_chainage),
      host_curve_length_ft: toFiniteNumber(hostLocalFrame?.curveLengthFt ?? hostLocalFrame?.curve_length_ft)
    };
  }
  for (const candidate of candidates) {
    const id = toFiniteInt(candidate?.elementId ?? candidate?.element_id);
    if (id !== null) {
      const host = candidate?.host && typeof candidate.host === "object" ? candidate.host : null;
      const electricalCircuit =
        candidate?.electricalCircuit && typeof candidate.electricalCircuit === "object"
          ? candidate.electricalCircuit
          : candidate?.electrical_circuit && typeof candidate.electrical_circuit === "object"
            ? candidate.electrical_circuit
            : null;
      const hostLocalFrame =
        candidate?.hostLocalFrame && typeof candidate.hostLocalFrame === "object"
          ? candidate.hostLocalFrame
          : candidate?.host_local_frame && typeof candidate.host_local_frame === "object"
            ? candidate.host_local_frame
            : null;
      return {
        element_id: id,
        host_id: toFiniteInt(
          candidate?.hostElementId ??
            candidate?.host_element_id ??
            candidate?.hostId ??
            candidate?.host_id ??
            candidate?.hostWallId ??
            candidate?.host_wall_id ??
            candidate?.wallId ??
            candidate?.wall_id ??
            host?.id
        ),
        room_side: normalizeSpatialWallSide(
          typeof candidate?.roomSide === "string"
            ? candidate.roomSide
            : typeof candidate?.room_side === "string"
              ? candidate.room_side
            : typeof candidate?.requestedRoomSide === "string"
              ? candidate.requestedRoomSide
              : typeof candidate?.requested_room_side === "string"
                ? candidate.requested_room_side
                : typeof candidate?.side === "string"
                  ? candidate.side
                  : typeof request?.roomSide === "string"
                    ? request.roomSide
                    : typeof request?.room_side === "string"
                      ? request.room_side
                    : typeof rootRoom?.requestedRoomSide === "string"
                      ? rootRoom.requestedRoomSide
                      : typeof rootRoom?.requested_room_side === "string"
                        ? rootRoom.requested_room_side
                        : ""
        ),
        host_supported:
          typeof candidate?.hostPlacementSupported === "boolean"
            ? candidate.hostPlacementSupported
            : typeof candidate?.host_placement_supported === "boolean"
              ? candidate.host_placement_supported
              : null,
        electrical_circuit_label: extractElectricalCircuitLabelFromObject(electricalCircuit),
        create_similar_body: recommendedCreateSimilar,
        wall_projected_point: parseXyzTuple(hostLocalFrame?.projectedPoint ?? hostLocalFrame?.projected_point),
        wall_tangent: parseXyzTuple(hostLocalFrame?.tangent ?? hostLocalFrame?.wallTangent ?? hostLocalFrame?.wall_tangent),
        host_local_frame_basis: typeof hostLocalFrame?.basis === "string" ? hostLocalFrame.basis.trim() : null,
        host_chainage_ft: toFiniteNumber(hostLocalFrame?.chainageFt ?? hostLocalFrame?.chainage_ft),
        host_normalized_chainage: toFiniteNumber(hostLocalFrame?.normalizedChainage ?? hostLocalFrame?.normalized_chainage),
        host_curve_length_ft: toFiniteNumber(hostLocalFrame?.curveLengthFt ?? hostLocalFrame?.curve_length_ft)
      };
    }
  }
  return null;
}

function extractLatestElectricalCircuitExemplarId(
  toolResults: ToolResult[],
  requested: { panel: string; circuit: string } | null
): number | null {
  if (!requested) return null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-parameters") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractResultItems(res);
    const candidates = items
      .map((item, index) => {
        const id = toFiniteInt(item?.id ?? item?.elementId ?? item?.element_id);
        if (id === null || id <= 0) return null;
        const category = typeof item?.category === "string" ? item.category.trim().toLowerCase() : "";
        const name = typeof item?.name === "string" ? item.name.trim().toLowerCase() : "";
        const parameters = item?.parameters && typeof item.parameters === "object"
          ? (item.parameters as Record<string, unknown>)
          : null;
        const panel = typeof parameters?.Panel === "string" ? parameters.Panel.trim().toUpperCase().replace(/\s+/g, "") : "";
        const circuit = typeof parameters?.["Circuit Number"] === "string"
          ? parameters["Circuit Number"].trim()
          : typeof parameters?.Circuit === "string"
            ? parameters.Circuit.trim()
            : "";
        if (panel !== requested.panel) return null;
        if (!circuitValuesMatch(circuit, requested.circuit)) return null;
        const electricalScore = category.includes("electrical fixture") || category.includes("electrical device") ? 20 : 0;
        const standardScore = name.includes("standard") ? 8 : name.includes("gfci") || name.includes("gfi") ? -4 : 0;
        return { id, score: electricalScore + standardScore - index * 0.001 };
      })
      .filter((row): row is { id: number; score: number } => !!row)
      .sort((a, b) => b.score - a.score);
    if (candidates.length > 0) return candidates[0]!.id;
  }
  return null;
}

type ElectricalParameterRow = {
  id: number;
  name: string;
  category: string;
  panel: string;
  circuit: string;
};

function normalizeElectricalPanel(value: unknown): string {
  return stringishValue(value).trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeElectricalCircuit(value: unknown): string {
  return stringishValue(value).trim().replace(/\s+/g, "");
}

function stringishValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const obj = value as Record<string, unknown>;
  for (const key of ["displayValue", "display_value", "valueString", "stringValue", "formattedValue", "value", "name", "label", "number"]) {
    const nested = obj[key];
    if (typeof nested === "string" && nested.trim()) return nested;
    if (typeof nested === "number" || typeof nested === "boolean") return String(nested);
  }
  return "";
}

function firstStringishField(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringishValue(obj[key]).trim();
    if (value) return value;
  }
  return "";
}

function extractInventoryItemRoomNumber(item: Record<string, unknown>): string | null {
  const room = item.room && typeof item.room === "object" ? (item.room as Record<string, unknown>) : null;
  const space = item.space && typeof item.space === "object" ? (item.space as Record<string, unknown>) : null;
  const associated =
    item.associatedSpatial && typeof item.associatedSpatial === "object"
      ? (item.associatedSpatial as Record<string, unknown>)
      : item.associated_spatial && typeof item.associated_spatial === "object"
        ? (item.associated_spatial as Record<string, unknown>)
      : null;
  const taggedSpatial =
    item.taggedSpatial && typeof item.taggedSpatial === "object"
      ? (item.taggedSpatial as Record<string, unknown>)
      : item.tagged_spatial && typeof item.tagged_spatial === "object"
        ? (item.tagged_spatial as Record<string, unknown>)
      : null;
  const roomNumber =
    firstStringishField(item, "roomNumber", "room_number").toUpperCase() ||
    firstStringishField(item, "spaceNumber", "space_number").toUpperCase() ||
    firstStringishField(item, "associatedSpatialNumber", "associated_spatial_number").toUpperCase() ||
    stringishValue(associated?.number).trim().toUpperCase() ||
    stringishValue(taggedSpatial?.number).trim().toUpperCase() ||
    (room ? firstStringishField(room, "number", "roomNumber", "room_number").toUpperCase() : "") ||
    (space ? firstStringishField(space, "number", "spaceNumber", "space_number").toUpperCase() : "") ||
    "";
  return roomNumber || null;
}

function extractVisibleTextPayload(item: Record<string, unknown>): string {
  const parameters = item.parameters && typeof item.parameters === "object"
    ? (item.parameters as Record<string, unknown>)
    : null;
  return [
    item.visibleText,
    item.visible_text,
    item.text,
    item.textValue,
    item.text_value,
    item.contents,
    item.annotationContents,
    item.annotation_contents,
    item.name,
    item.typeName,
    item.type_name,
    item.familyName,
    item.family_name,
    (item.associatedSpatial && typeof item.associatedSpatial === "object" ? (item.associatedSpatial as Record<string, unknown>).name : null),
    (item.associated_spatial && typeof item.associated_spatial === "object" ? (item.associated_spatial as Record<string, unknown>).name : null),
    (item.taggedSpatial && typeof item.taggedSpatial === "object" ? (item.taggedSpatial as Record<string, unknown>).name : null),
    (item.tagged_spatial && typeof item.tagged_spatial === "object" ? (item.tagged_spatial as Record<string, unknown>).name : null),
    (item.room && typeof item.room === "object" ? (item.room as Record<string, unknown>).name : null),
    (item.space && typeof item.space === "object" ? (item.space as Record<string, unknown>).name : null),
    parameters?.Text,
    parameters?.text,
    parameters?.["Text String"],
    parameters?.textString,
    parameters?.text_string,
    parameters?.Label,
    parameters?.label,
    parameters?.Value,
    parameters?.value,
    parameters?.Number,
    parameters?.number,
    parameters?.["Room Number"],
    parameters?.["Space Number"],
    parameters?.Comments,
    parameters?.comments,
    parameters?.["Type Comments"],
    parameters?.description,
    parameters?.Description
  ]
    .map(stringishValue)
    .filter((value) => value.trim().length > 0)
    .join(" ");
}

function extractRoomNumberFromVisibleText(text: string): string | null {
  const raw = (text ?? "").trim().toUpperCase();
  if (!raw) return null;
  const labeled =
    raw.match(/\b(?:ROOM|RM|UNIT|SPACE|APT|APARTMENT)\s*#?\s*([A-Z]?\d{2,6}[A-Z]?)\b/) ??
    raw.match(/\bLIVE\s*\/?\s*WORK(?:\s+\w+){0,3}\s+([A-Z]?\d{2,6}[A-Z]?)\b/);
  if (labeled?.[1]) return labeled[1];
  const panelCircuit = raw.match(/\bP\s*([A-Z]?\d{2,6}[A-Z]?)\s*\/\s*\d{1,4}\b/);
  if (panelCircuit?.[1]) return panelCircuit[1];
  const standalone = raw.match(/(?:^|[^\dA-Z])([A-Z]?\d{3,5}[A-Z]?)(?:$|[^\dA-Z])/);
  return standalone?.[1] ?? null;
}

function visibleTextLooksLikeSpatialRoomLabel(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  return /\b(?:LIVE\s*\/?\s*WORK|UNIT|ROOM|RM|SPACE|SUITE|APT|APARTMENT)\b/i.test(raw);
}

function visibleTextLooksLikeRoomCircuitLabel(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  return /\bP\s*[A-Z]?\d{2,6}[A-Z]?\s*\/\s*\d{1,4}\b/i.test(raw);
}

function extractInventoryItemElectricalParameters(item: Record<string, unknown>): { panel: string; circuit: string } {
  const parameters = item.parameters && typeof item.parameters === "object"
    ? (item.parameters as Record<string, unknown>)
    : null;
  const parameterGroups =
    item.parameterGroups && typeof item.parameterGroups === "object"
      ? (item.parameterGroups as Record<string, unknown>)
      : item.parameter_groups && typeof item.parameter_groups === "object"
        ? (item.parameter_groups as Record<string, unknown>)
        : null;
  const electrical = parameterGroups?.electrical && typeof parameterGroups.electrical === "object"
    ? (parameterGroups.electrical as Record<string, unknown>)
    : null;
  const electricalCircuit =
    item.electricalCircuit && typeof item.electricalCircuit === "object"
      ? (item.electricalCircuit as Record<string, unknown>)
      : item.electrical_circuit && typeof item.electrical_circuit === "object"
        ? (item.electrical_circuit as Record<string, unknown>)
        : null;
  const parsedCircuitLabel = extractRequestedPanelCircuit(
    [
      typeof electricalCircuit?.primaryLabel === "string" ? electricalCircuit.primaryLabel : "",
      typeof electricalCircuit?.primary_label === "string" ? electricalCircuit.primary_label : "",
      typeof electricalCircuit?.label === "string" ? electricalCircuit.label : "",
      typeof item.circuitLabel === "string" ? item.circuitLabel : "",
      typeof item.circuit_label === "string" ? item.circuit_label : ""
    ].filter(Boolean).join(" ")
  );
  const panel =
    normalizeElectricalPanel(item.panel) ||
    normalizeElectricalPanel(item.Panel) ||
    normalizeElectricalPanel(item.panel_name) ||
    normalizeElectricalPanel(parameters?.Panel) ||
    normalizeElectricalPanel(parameters?.panel) ||
    normalizeElectricalPanel(parameters?.panel_name) ||
    normalizeElectricalPanel(electrical?.Panel) ||
    normalizeElectricalPanel(electrical?.panel) ||
    normalizeElectricalPanel(electrical?.panel_name) ||
    normalizeElectricalPanel(electricalCircuit?.panel) ||
    normalizeElectricalPanel(electricalCircuit?.panel_name) ||
    parsedCircuitLabel?.panel ||
    "";
  const circuit =
    normalizeElectricalCircuit(item.circuitNumber) ||
    normalizeElectricalCircuit(item.circuit_number) ||
    normalizeElectricalCircuit(item["Circuit Number"]) ||
    normalizeElectricalCircuit(item.Circuit) ||
    normalizeElectricalCircuit(item.circuit) ||
    normalizeElectricalCircuit(parameters?.["Circuit Number"]) ||
    normalizeElectricalCircuit(parameters?.Circuit) ||
    normalizeElectricalCircuit(parameters?.circuitNumber) ||
    normalizeElectricalCircuit(parameters?.circuit_number) ||
    normalizeElectricalCircuit(parameters?.circuit) ||
    normalizeElectricalCircuit(electrical?.["Circuit Number"]) ||
    normalizeElectricalCircuit(electrical?.Circuit) ||
    normalizeElectricalCircuit(electrical?.circuitNumber) ||
    normalizeElectricalCircuit(electrical?.circuit_number) ||
    normalizeElectricalCircuit(electrical?.circuit) ||
    normalizeElectricalCircuit(electricalCircuit?.circuit) ||
    normalizeElectricalCircuit(electricalCircuit?.circuit_number) ||
    parsedCircuitLabel?.circuit ||
    "";
  return { panel, circuit };
}

function extractVisibleInventoryItems(res: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawItems = Array.isArray(res.items)
    ? res.items
    : Array.isArray(res.itemsSampled)
      ? res.itemsSampled
      : Array.isArray(res.items_sampled)
        ? res.items_sampled
      : Array.isArray(res.elements)
        ? res.elements
        : Array.isArray(res.visibleElements)
          ? res.visibleElements
          : Array.isArray(res.visible_elements)
            ? res.visible_elements
            : [];
  return rawItems.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

function inferRoomNumberFromVisibleInventoryCircuit(
  toolResults: ToolResult[],
  requested: { panel: string; circuit: string } | null
): string | null {
  if (!requested) return null;
  const roomScores = new Map<string, { score: number; firstIndex: number }>();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractVisibleInventoryItems(res);
    items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const roomNumber = extractInventoryItemRoomNumber(item);
      if (!roomNumber) return;
      const params = extractInventoryItemElectricalParameters(item);
      if (params.panel !== requested.panel) return;
      const exactCircuit = circuitValuesMatch(params.circuit, requested.circuit);
      if (!exactCircuit && params.circuit) return;
      const score = exactCircuit ? 100 : 10;
      const current = roomScores.get(roomNumber);
      if (!current) {
        roomScores.set(roomNumber, { score, firstIndex: index });
      } else {
        current.score += score;
        current.firstIndex = Math.min(current.firstIndex, index);
      }
    });
    if (roomScores.size > 0) break;
  }
  return [...roomScores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstIndex - b[1].firstIndex || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function extractVisibleInventoryItemImagePoint(item: Record<string, unknown>): { x: number; y: number } | null {
  const readImage = (raw: unknown): { x: number; y: number } | null => {
    const image = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const x = toFiniteNumber(image?.normalizedX ?? image?.normalized_x);
    const y = toFiniteNumber(image?.normalizedY ?? image?.normalized_y);
    if (x === null || y === null) return null;
    return { x: clamp01(x), y: clamp01(y) };
  };

  const anchor = item.anchor && typeof item.anchor === "object" ? (item.anchor as Record<string, unknown>) : null;
  const anchorImage = readImage(anchor?.image);
  if (anchorImage) return anchorImage;

  const directImage = readImage(item.image);
  if (directImage) return directImage;

  const imagePoint = readImage(item.imagePoint ?? item.image_point ?? item.viewImagePoint);
  if (imagePoint) return imagePoint;

  const topLevelImage = readImage(item);
  if (topLevelImage) return topLevelImage;

  const geometry = item.geometry && typeof item.geometry === "object" ? (item.geometry as Record<string, unknown>) : null;
  const point = geometry?.point && typeof geometry.point === "object" ? (geometry.point as Record<string, unknown>) : null;
  const pointImage = readImage(point?.image);
  if (pointImage) return pointImage;

  const bbox = item.bbox && typeof item.bbox === "object" ? (item.bbox as Record<string, unknown>) : null;
  const imageBox = bbox?.image && typeof bbox.image === "object" ? (bbox.image as Record<string, unknown>) : null;
  const minX = toFiniteNumber(imageBox?.normalizedMinX ?? imageBox?.normalized_min_x ?? imageBox?.minNormalizedX ?? imageBox?.min_normalized_x ?? imageBox?.minX);
  const maxX = toFiniteNumber(imageBox?.normalizedMaxX ?? imageBox?.normalized_max_x ?? imageBox?.maxNormalizedX ?? imageBox?.max_normalized_x ?? imageBox?.maxX);
  const minY = toFiniteNumber(imageBox?.normalizedMinY ?? imageBox?.normalized_min_y ?? imageBox?.minNormalizedY ?? imageBox?.min_normalized_y ?? imageBox?.minY);
  const maxY = toFiniteNumber(imageBox?.normalizedMaxY ?? imageBox?.normalized_max_y ?? imageBox?.maxNormalizedY ?? imageBox?.max_normalized_y ?? imageBox?.maxY);
  if (minX !== null && maxX !== null && minY !== null && maxY !== null) {
    const looksNormalized = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY)) <= 1.25;
    if (looksNormalized) {
      return {
        x: clamp01((minX + maxX) * 0.5),
        y: clamp01((minY + maxY) * 0.5)
      };
    }
  }

  return null;
}

type VisibleInventoryImageBox = { minX: number; minY: number; maxX: number; maxY: number };

function extractVisibleInventoryItemImageBox(item: Record<string, unknown>): VisibleInventoryImageBox | null {
  const readBox = (raw: unknown): VisibleInventoryImageBox | null => {
    const image = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!image) return null;
    const minX = toFiniteNumber(image.normalizedMinX ?? image.normalized_min_x ?? image.minNormalizedX ?? image.min_normalized_x ?? image.minX);
    const maxX = toFiniteNumber(image.normalizedMaxX ?? image.normalized_max_x ?? image.maxNormalizedX ?? image.max_normalized_x ?? image.maxX);
    const minY = toFiniteNumber(image.normalizedMinY ?? image.normalized_min_y ?? image.minNormalizedY ?? image.min_normalized_y ?? image.minY);
    const maxY = toFiniteNumber(image.normalizedMaxY ?? image.normalized_max_y ?? image.maxNormalizedY ?? image.max_normalized_y ?? image.maxY);
    if (minX === null || maxX === null || minY === null || maxY === null) return null;
    const looksNormalized = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY)) <= 1.25;
    if (!looksNormalized) return null;
    return {
      minX: clamp01(Math.min(minX, maxX)),
      minY: clamp01(Math.min(minY, maxY)),
      maxX: clamp01(Math.max(minX, maxX)),
      maxY: clamp01(Math.max(minY, maxY))
    };
  };

  const bbox = item.bbox && typeof item.bbox === "object" ? (item.bbox as Record<string, unknown>) : null;
  const bboxImage = readBox(bbox?.image);
  if (bboxImage) return bboxImage;

  const directBox = readBox(item.imageBox ?? item.image_box ?? item.bboxImage);
  if (directBox) return directBox;

  const topLevelBox = readBox(item);
  if (topLevelBox) return topLevelBox;

  return null;
}

function imagePointInsideBox(
  point: { x: number; y: number } | null,
  box: VisibleInventoryImageBox | null,
  padding = 0
): boolean {
  if (!point || !box) return false;
  return (
    point.x >= box.minX - padding &&
    point.x <= box.maxX + padding &&
    point.y >= box.minY - padding &&
    point.y <= box.maxY + padding
  );
}

function imageMarkPoint(markHint: ImageMarkHint | null): { x: number; y: number } | null {
  if (!markHint || !Number.isFinite(markHint.normalized_x) || !Number.isFinite(markHint.normalized_y)) return null;
  return { x: markHint.normalized_x, y: markHint.normalized_y };
}

function inferPointSideWithinImageBox(
  point: { x: number; y: number } | null,
  box: VisibleInventoryImageBox | null
): "left" | "right" | "top" | "bottom" | null {
  if (!point || !box) return null;
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1e-6 || height <= 1e-6) return null;
  const distances = [
    { side: "left" as const, distance: Math.abs(point.x - box.minX) },
    { side: "right" as const, distance: Math.abs(box.maxX - point.x) },
    { side: "top" as const, distance: Math.abs(point.y - box.minY) },
    { side: "bottom" as const, distance: Math.abs(box.maxY - point.y) }
  ].filter((entry) => Number.isFinite(entry.distance));
  distances.sort((a, b) => a.distance - b.distance);
  return distances[0]?.side ?? null;
}

function normalizedDistanceToImageMark(point: { x: number; y: number } | null, markHint: ImageMarkHint | null): number | null {
  if (!point || !markHint) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!Number.isFinite(markHint.normalized_x) || !Number.isFinite(markHint.normalized_y)) return null;
  const dx = point.x - markHint.normalized_x;
  const dy = point.y - markHint.normalized_y;
  return Math.sqrt(dx * dx + dy * dy);
}

function inferRoomNumberFromVisibleInventorySpatialHint(
  toolResults: ToolResult[],
  markHint: ImageMarkHint | null,
  markedSideOverride?: "left" | "right" | "top" | "bottom" | null
): string | null {
  const markedSide = markedSideOverride ?? normalizeSpatialWallSide(markHint?.side ?? "");
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractVisibleInventoryItems(res);
    const scores = new Map<string, { score: number; count: number; sideMatches: number; labelMatches: number; nearestMarkDistance: number | null; firstIndex: number }>();
    const markPoint = imageMarkPoint(markHint);
    const spatialAnchors = items
      .map((item, index) => {
        const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
        const categoryToken = firstStringishField(item, "categoryToken", "category_token").trim();
        const category = firstStringishField(item, "category").toLowerCase();
        const visibleTextPayload = extractVisibleTextPayload(item);
        const textRoomNumber = extractRoomNumberFromVisibleText(visibleTextPayload);
        const isSpatialElement =
          builtIn === "OST_Rooms" ||
          builtIn === "OST_MEPSpaces" ||
          categoryToken === "OST_Rooms" ||
          categoryToken === "OST_MEPSpaces" ||
          category === "rooms" ||
          category === "spaces" ||
          category.includes("mep space");
        const isRoomLabel =
          !!textRoomNumber &&
          (builtIn === "OST_RoomTags" ||
            builtIn === "OST_MEPSpaceTags" ||
            builtIn === "OST_TextNotes" ||
            builtIn === "OST_GenericAnnotation" ||
            categoryToken === "OST_RoomTags" ||
            categoryToken === "OST_MEPSpaceTags" ||
            categoryToken === "OST_TextNotes" ||
            categoryToken === "OST_GenericAnnotation" ||
            category.includes("room tag") ||
            category.includes("space tag") ||
            category.includes("annotation") ||
            category.includes("text") ||
            visibleTextLooksLikeSpatialRoomLabel(visibleTextPayload));
        if (!isSpatialElement && !isRoomLabel) return null;
        const roomNumber = extractInventoryItemRoomNumber(item) ?? textRoomNumber;
        const box = extractVisibleInventoryItemImageBox(item);
        const point =
          extractVisibleInventoryItemImagePoint(item) ??
          (box
            ? {
                x: clamp01((box.minX + box.maxX) * 0.5),
                y: clamp01((box.minY + box.maxY) * 0.5)
              }
            : null);
        if (!roomNumber || !point) return null;
        return { roomNumber, point, box, index, labelOnly: !isSpatialElement };
      })
      .filter((item): item is { roomNumber: string; point: { x: number; y: number }; box: VisibleInventoryImageBox | null; index: number; labelOnly: boolean } => item !== null);

    items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const visibleTextPayload = extractVisibleTextPayload(item);
      const explicitRoomNumber = extractInventoryItemRoomNumber(item);
      const textRoomNumber = extractRoomNumberFromVisibleText(visibleTextPayload);
      const isSpatialRoomText = !!textRoomNumber && visibleTextLooksLikeSpatialRoomLabel(visibleTextPayload);
      const isRoomCircuitText = !!textRoomNumber && visibleTextLooksLikeRoomCircuitLabel(visibleTextPayload);
      const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
      const categoryToken = firstStringishField(item, "categoryToken", "category_token").trim();
      const category = firstStringishField(item, "category").toLowerCase();
      const name = firstStringishField(item, "name", "typeName", "type_name", "familyName", "family_name").toLowerCase();
      const isSpatialElement =
        builtIn === "OST_Rooms" ||
        builtIn === "OST_MEPSpaces" ||
        categoryToken === "OST_Rooms" ||
        categoryToken === "OST_MEPSpaces" ||
        category === "rooms" ||
        category === "spaces" ||
        category.includes("mep space");
      const isElectrical =
        builtIn === "OST_ElectricalFixtures" ||
        builtIn === "OST_ElectricalDevices" ||
        category.includes("electrical") ||
        /\b(receptacle|outlet|duplex|gfci|gfi|switch)\b/.test(name);
      const isRoomLabel =
        !!textRoomNumber &&
        (builtIn === "OST_RoomTags" ||
          builtIn === "OST_MEPSpaceTags" ||
          builtIn === "OST_TextNotes" ||
          categoryToken === "OST_RoomTags" ||
          categoryToken === "OST_MEPSpaceTags" ||
          categoryToken === "OST_TextNotes" ||
          category.includes("room tag") ||
          category.includes("space tag") ||
          category.includes("text") ||
          ((isSpatialRoomText || isRoomCircuitText) &&
            (category.includes("annotation") || category.includes("tag") || category.includes("text"))));
      if (!isElectrical && !isRoomLabel && !isSpatialElement) return;

      const point = extractVisibleInventoryItemImagePoint(item);
      const params = extractInventoryItemElectricalParameters(item);
      const electricalPanelRoomNumber = isElectrical
        ? extractRoomNumberFromVisibleText(
            [params.panel, params.panel && params.circuit ? `${params.panel}/${params.circuit}` : ""].filter(Boolean).join(" ")
          )
        : null;
      const nearestSpatial =
        !explicitRoomNumber && !textRoomNumber && !electricalPanelRoomNumber && isElectrical && point && spatialAnchors.length > 0
          ? (() => {
              const ranked = [...spatialAnchors]
                .map((anchor) => ({
                  ...anchor,
                  containsDevice: imagePointInsideBox(point, anchor.box, 0.012),
                  containsMark: imagePointInsideBox(markPoint, anchor.box, 0.012),
                  distance: Math.sqrt((anchor.point.x - point.x) ** 2 + (anchor.point.y - point.y) ** 2),
                  sideAxisDistance:
                    anchor.labelOnly && markedSide
                      ? markedSide === "left" || markedSide === "right"
                        ? Math.abs(anchor.point.y - point.y)
                        : Math.abs(anchor.point.x - point.x)
                      : null,
                  markDistance: normalizedDistanceToImageMark(anchor.point, markHint)
                }))
                .sort(
                  (a, b) =>
                    Number(b.containsDevice) - Number(a.containsDevice) ||
                    Number(b.containsMark) - Number(a.containsMark) ||
                    ((a.sideAxisDistance ?? Number.POSITIVE_INFINITY) - (b.sideAxisDistance ?? Number.POSITIVE_INFINITY)) ||
                    (a.markDistance ?? Number.POSITIVE_INFINITY) - (b.markDistance ?? Number.POSITIVE_INFINITY) ||
                    a.distance - b.distance ||
                    a.index - b.index
                );
              const nearest = ranked[0] ?? null;
              if (!nearest) return null;
              const second = ranked[1] ?? null;
              if (nearest.containsDevice || nearest.containsMark) return nearest;
              const clearlyNearest = !second || second.distance - nearest.distance >= 0.14;
              const nearbyLabelAnchor = nearest.labelOnly && nearest.distance <= 0.58 && clearlyNearest;
              return nearest.distance <= 0.34 || (nearest.distance <= 0.55 && clearlyNearest) || nearbyLabelAnchor ? nearest : null;
            })()
          : null;
      const inferredSpatialRoomNumber = nearestSpatial ? nearestSpatial.roomNumber : null;
      const roomNumber = explicitRoomNumber ?? textRoomNumber ?? electricalPanelRoomNumber ?? inferredSpatialRoomNumber;
      if (!roomNumber) return;
      const side = point ? inferMarkSideFromNormalizedPoint(point.x, point.y) : null;
      const sideMatches = markedSide !== null && side === markedSide;
      const markDistance = normalizedDistanceToImageMark(point, markHint);
      const spatialBoxContainsMark = isSpatialElement && imagePointInsideBox(markPoint, extractVisibleInventoryItemImageBox(item), 0.012);
      const proximityBoost =
        markDistance === null
          ? 0
          : isRoomLabel || isSpatialElement
            ? Math.max(0, 28 - markDistance * 70)
            : Math.max(0, 38 - markDistance * 95);
      const score =
        (isRoomLabel ? 70 : isSpatialElement ? 62 : 20) +
        (sideMatches ? (isRoomLabel || isSpatialElement ? 12 : 55) : 0) +
        proximityBoost +
        (spatialBoxContainsMark ? 90 : 0) +
        (markedSide && side && side !== markedSide && !isRoomLabel && !isSpatialElement ? -8 : 0) +
        (explicitRoomNumber ? 12 : 0) +
        (electricalPanelRoomNumber ? 18 : 0) +
        (inferredSpatialRoomNumber ? 10 : 0) +
        (params.panel ? 5 : 0) +
        (params.circuit ? 5 : 0);
      const current = scores.get(roomNumber);
      if (!current) {
        scores.set(roomNumber, {
          score,
          count: 1,
          sideMatches: sideMatches ? 1 : 0,
          labelMatches: isRoomLabel ? 1 : 0,
          nearestMarkDistance: markDistance,
          firstIndex: index
        });
      } else {
        current.score += score;
        current.count += 1;
        if (sideMatches) current.sideMatches += 1;
        if (isRoomLabel) current.labelMatches += 1;
        if (markDistance !== null) {
          current.nearestMarkDistance =
            current.nearestMarkDistance === null ? markDistance : Math.min(current.nearestMarkDistance, markDistance);
        }
        current.firstIndex = Math.min(current.firstIndex, index);
      }
    });

    const ranked = [...scores.entries()].sort(
      (a, b) =>
        b[1].score - a[1].score ||
        b[1].sideMatches - a[1].sideMatches ||
        ((a[1].nearestMarkDistance ?? Number.POSITIVE_INFINITY) - (b[1].nearestMarkDistance ?? Number.POSITIVE_INFINITY)) ||
        b[1].count - a[1].count ||
        a[1].firstIndex - b[1].firstIndex ||
        a[0].localeCompare(b[0])
    );
    const top = ranked[0];
    if (!top) return null;
    const second = ranked[1];
    const topStats = top[1];
    if (markedSide && topStats.sideMatches > 0 && (!second || topStats.score - second[1].score >= 20)) return top[0];
    if (
      topStats.labelMatches > 0 &&
      topStats.score >= 70 &&
      (!second || topStats.score - second[1].score >= 20) &&
      (topStats.nearestMarkDistance === null || topStats.nearestMarkDistance <= 0.68)
    ) {
      return top[0];
    }
    if (
      markHint &&
      topStats.nearestMarkDistance !== null &&
      topStats.nearestMarkDistance <= 0.42 &&
      (!second ||
        topStats.score - second[1].score >= 12 ||
        (second[1].nearestMarkDistance !== null && second[1].nearestMarkDistance - topStats.nearestMarkDistance >= 0.16))
    ) {
      return top[0];
    }
    if (!markedSide && (topStats.count >= 2 || topStats.score >= 70) && (!second || topStats.score - second[1].score >= 18)) return top[0];
    return null;
  }
  return null;
}

function inferRoomNumberFromSplitVisibleUnitLabels(
  toolResults: ToolResult[],
  markHint: ImageMarkHint | null
): string | null {
  const markPoint = imageMarkPoint(markHint);
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractVisibleInventoryItems(res);
    const textRows = items
      .map((item, index) => {
        const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
        const categoryToken = firstStringishField(item, "categoryToken", "category_token").trim();
        const category = firstStringishField(item, "category").toLowerCase();
        const text = extractVisibleTextPayload(item);
        const point =
          extractVisibleInventoryItemImagePoint(item) ??
          (() => {
            const box = extractVisibleInventoryItemImageBox(item);
            return box ? { x: clamp01((box.minX + box.maxX) * 0.5), y: clamp01((box.minY + box.maxY) * 0.5) } : null;
          })();
        const isTextLike =
          builtIn === "OST_RoomTags" ||
          builtIn === "OST_MEPSpaceTags" ||
          builtIn === "OST_TextNotes" ||
          builtIn === "OST_GenericAnnotation" ||
          categoryToken === "OST_RoomTags" ||
          categoryToken === "OST_MEPSpaceTags" ||
          categoryToken === "OST_TextNotes" ||
          categoryToken === "OST_GenericAnnotation" ||
          category.includes("room tag") ||
          category.includes("space tag") ||
          category.includes("annotation") ||
          category.includes("text");
        if (!isTextLike || !text || !point) return null;
        return { index, text, point, roomNumber: extractRoomNumberFromVisibleText(text), looksSpatial: visibleTextLooksLikeSpatialRoomLabel(text) };
      })
      .filter((row): row is { index: number; text: string; point: { x: number; y: number }; roomNumber: string | null; looksSpatial: boolean } => !!row);

    const spatialPrefixes = textRows.filter((row) => row.looksSpatial && !row.roomNumber);
    const numericLabels = textRows.filter((row) => row.roomNumber && !visibleTextLooksLikeRoomCircuitLabel(row.text));
    const ranked = numericLabels
      .map((label) => {
        const nearestPrefix = spatialPrefixes
          .map((prefix) => ({
            prefix,
            distance: Math.sqrt((prefix.point.x - label.point.x) ** 2 + (prefix.point.y - label.point.y) ** 2),
            axisDistance: Math.min(Math.abs(prefix.point.x - label.point.x), Math.abs(prefix.point.y - label.point.y))
          }))
          .sort((a, b) => a.distance - b.distance || a.axisDistance - b.axisDistance || a.prefix.index - b.prefix.index)[0] ?? null;
        if (!nearestPrefix) return null;
        const markDistance = normalizedDistanceToImageMark(label.point, markHint);
        const plausiblePair =
          nearestPrefix.distance <= 0.28 ||
          (nearestPrefix.distance <= 0.45 && nearestPrefix.axisDistance <= 0.08);
        if (!plausiblePair) return null;
        const score =
          120 -
          nearestPrefix.distance * 140 -
          (markDistance === null ? 0 : markDistance * 18) -
          label.index * 0.001;
        return { roomNumber: label.roomNumber!, score, markDistance };
      })
      .filter((row): row is { roomNumber: string; score: number; markDistance: number | null } => !!row)
      .sort((a, b) => b.score - a.score || ((a.markDistance ?? Number.POSITIVE_INFINITY) - (b.markDistance ?? Number.POSITIVE_INFINITY)));
    const top = ranked[0];
    if (top && top.score >= 40) return top.roomNumber;
    if (!markPoint && top) return top.roomNumber;
  }
  return null;
}

function visibleInventoryHasSpatialContext(toolResults: ToolResult[], viewId?: number | null): boolean {
  const wantViewId = Number.isFinite(viewId as number) && Number(viewId) > 0 ? Math.round(Number(viewId)) : null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const resViewId = toFiniteInt(res.viewId);
    if (wantViewId !== null && resViewId !== null && resViewId !== wantViewId) continue;

    const summary = res.summary && typeof res.summary === "object" ? (res.summary as Record<string, unknown>) : null;
    const hasUsableSpatialSummary = (entries: unknown): boolean =>
      Array.isArray(entries) &&
      entries.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const key = stringishValue((entry as Record<string, unknown>).key).trim().toUpperCase();
        const count = toFiniteNumber((entry as Record<string, unknown>).count) ?? 0;
        return count > 0 && /^[A-Z]?\d{2,6}[A-Z]?$/.test(key);
      });
    const hasSummarySpatial =
      hasUsableSpatialSummary(summary?.roomCounts) ||
      hasUsableSpatialSummary(summary?.spaceCounts);
    if (hasSummarySpatial) return true;

    const items = extractVisibleInventoryItems(res);
    for (const item of items) {
      const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
      const categoryToken = firstStringishField(item, "categoryToken", "category_token").trim();
      const category = firstStringishField(item, "category").toLowerCase();
      if (extractInventoryItemRoomNumber(item) || extractRoomNumberFromVisibleText(extractVisibleTextPayload(item))) return true;
      const isSpatialCategory =
        builtIn === "OST_Rooms" ||
        builtIn === "OST_MEPSpaces" ||
        builtIn === "OST_RoomTags" ||
        builtIn === "OST_MEPSpaceTags" ||
        categoryToken === "OST_Rooms" ||
        categoryToken === "OST_MEPSpaces" ||
        categoryToken === "OST_RoomTags" ||
        categoryToken === "OST_MEPSpaceTags" ||
        category.includes("room") ||
        category.includes("space");
      if (isSpatialCategory) continue;
    }
    return false;
  }
  return false;
}

function latestVisibleInventoryIsCompacted(toolResults: ToolResult[]): boolean {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") return false;
    const res = r.result_json as Record<string, unknown>;
    return res._compacted === true || toFiniteNumber(res.itemsOmitted ?? res.items_omitted) !== null;
  }
  return false;
}

function inferRoomNumberFromVisibleInventoryDominantContext(args: {
  toolResults: ToolResult[];
  markHint: ImageMarkHint | null;
  markedSide?: "left" | "right" | "top" | "bottom" | null;
  preferAdjacentCircuitContext?: boolean;
}): string | null {
  const markedSide = args.markedSide ?? normalizeSpatialWallSide(args.markHint?.side ?? "");
  const markPoint = imageMarkPoint(args.markHint);
  for (let i = args.toolResults.length - 1; i >= 0; i--) {
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractVisibleInventoryItems(res);
    const scores = new Map<string, { score: number; count: number; nearestMarkDistance: number | null; firstIndex: number }>();

    const addScore = (roomNumber: string | null, score: number, index: number, markDistance: number | null): void => {
      const room = (roomNumber ?? "").trim().toUpperCase();
      if (!/^[A-Z]?\d{2,6}[A-Z]?$/.test(room)) return;
      const current = scores.get(room);
      if (!current) {
        scores.set(room, { score, count: 1, nearestMarkDistance: markDistance, firstIndex: index });
        return;
      }
      current.score += score;
      current.count += 1;
      current.firstIndex = Math.min(current.firstIndex, index);
      if (markDistance !== null) {
        current.nearestMarkDistance =
          current.nearestMarkDistance === null ? markDistance : Math.min(current.nearestMarkDistance, markDistance);
      }
    };

    items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
      const categoryToken = firstStringishField(item, "categoryToken", "category_token").trim();
      const category = firstStringishField(item, "category").toLowerCase();
      const name = firstStringishField(item, "name", "typeName", "type_name", "familyName", "family_name").toLowerCase();
      const isSpatialElement =
        builtIn === "OST_Rooms" ||
        builtIn === "OST_MEPSpaces" ||
        categoryToken === "OST_Rooms" ||
        categoryToken === "OST_MEPSpaces" ||
        category === "rooms" ||
        category === "spaces" ||
        category.includes("mep space");
      const isRoomLabel =
        builtIn === "OST_RoomTags" ||
        builtIn === "OST_MEPSpaceTags" ||
        builtIn === "OST_TextNotes" ||
        categoryToken === "OST_RoomTags" ||
        categoryToken === "OST_MEPSpaceTags" ||
        categoryToken === "OST_TextNotes" ||
        category.includes("room tag") ||
        category.includes("space tag") ||
        category.includes("text");
      const isElectrical =
        builtIn === "OST_ElectricalFixtures" ||
        builtIn === "OST_ElectricalDevices" ||
        category.includes("electrical") ||
        /\b(receptacle|outlet|duplex|gfci|gfi|switch|device)\b/.test(name);
      const visibleTextPayload = extractVisibleTextPayload(item);
      const roomNumber = extractInventoryItemRoomNumber(item) ?? extractRoomNumberFromVisibleText(visibleTextPayload);
      if (!roomNumber) return;
      const point = extractVisibleInventoryItemImagePoint(item);
      const box = extractVisibleInventoryItemImageBox(item);
      const side = point ? inferMarkSideFromNormalizedPoint(point.x, point.y) : null;
      const markDistance = normalizedDistanceToImageMark(point, args.markHint);
      const containsMark = imagePointInsideBox(markPoint, box, 0.012);
      const sideMatches = markedSide !== null && side === markedSide;
      const proximityBoost =
        markDistance === null
          ? 0
          : Math.max(0, (isElectrical ? 40 : 30) - markDistance * (isElectrical ? 95 : 70));
      const isSpatialRoomText = visibleTextLooksLikeSpatialRoomLabel(visibleTextPayload);
      const isRoomCircuitText = visibleTextLooksLikeRoomCircuitLabel(visibleTextPayload);
      const score =
        (isSpatialElement ? 80 : isRoomLabel || isSpatialRoomText || isRoomCircuitText ? 72 : isElectrical ? 26 : 8) +
        (containsMark ? 110 : 0) +
        (sideMatches ? (isElectrical ? 54 : 18) : 0) +
        proximityBoost +
        (args.preferAdjacentCircuitContext && isElectrical ? 22 : 0);
      addScore(roomNumber, score, index, markDistance);
    });

    const summary = res.summary && typeof res.summary === "object" ? (res.summary as Record<string, unknown>) : null;
    const addSummaryEntries = (entries: unknown, weight: number): void => {
      if (!Array.isArray(entries)) return;
      entries.forEach((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const obj = entry as Record<string, unknown>;
        const key = typeof obj.key === "string" ? obj.key.trim().toUpperCase() : "";
        const count = toFiniteNumber(obj.count) ?? 0;
        if (key && count > 0) addScore(key, count * weight, index + items.length, null);
      });
    };
    const hadItemScores = scores.size > 0;
    const canUseSummaryOnly =
      !args.preferAdjacentCircuitContext ||
      res._compacted === true ||
      toFiniteNumber(res.itemsOmitted ?? res.items_omitted) !== null;
    if (hadItemScores || canUseSummaryOnly) {
      addSummaryEntries(summary?.roomCounts, 9);
      addSummaryEntries(summary?.spaceCounts, 8);
    }

    const ranked = [...scores.entries()].sort(
      (a, b) =>
        b[1].score - a[1].score ||
        ((a[1].nearestMarkDistance ?? Number.POSITIVE_INFINITY) - (b[1].nearestMarkDistance ?? Number.POSITIVE_INFINITY)) ||
        b[1].count - a[1].count ||
        a[1].firstIndex - b[1].firstIndex ||
        a[0].localeCompare(b[0])
    );
    const top = ranked[0];
    if (!top) return null;
    const second = ranked[1];
    const topStats = top[1];
    if (markPoint && topStats.nearestMarkDistance !== null && topStats.nearestMarkDistance <= 0.45 && (!second || topStats.score - second[1].score >= 10)) {
      return top[0];
    }
    if (markedSide && (!second || topStats.score - second[1].score >= 18) && topStats.score >= 80) return top[0];
    if (args.preferAdjacentCircuitContext && (!second || topStats.score - second[1].score >= 24) && topStats.score >= 72) return top[0];
    if (!second && topStats.score >= 70) return top[0];
    if (topStats.score >= 110 && (!second || topStats.score >= second[1].score * 1.45)) return top[0];
    return null;
  }
  return null;
}

function inferVisibleInventoryPlacementHintForRoom(args: {
  toolResults: ToolResult[];
  roomNumber: string | null;
  viewId: number | null;
  markedSide?: "left" | "right" | "top" | "bottom" | null;
  preferAdjacentCircuitContext?: boolean;
}): ViewportPickHint | null {
  const room = (args.roomNumber ?? "").trim().toUpperCase();
  if (!/^[A-Z]?\d{2,6}[A-Z]?$/.test(room)) return null;
  const wantViewId = Number.isFinite(args.viewId as number) && Number(args.viewId) > 0 ? Math.round(Number(args.viewId)) : null;
  for (let i = args.toolResults.length - 1; i >= 0; i--) {
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const resViewId = toFiniteInt(res.viewId);
    if (wantViewId !== null && resViewId !== null && resViewId !== wantViewId) continue;

    const ranked = extractVisibleInventoryItems(res)
      .map((item, index) => {
        const point = extractVisibleInventoryItemImagePoint(item);
        if (!point) return null;
        const visibleTextPayload = extractVisibleTextPayload(item);
        const explicitRoomNumber = extractInventoryItemRoomNumber(item);
        const textRoomNumber = extractRoomNumberFromVisibleText(visibleTextPayload);
        const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
        const category = firstStringishField(item, "category").toLowerCase();
        const name = firstStringishField(item, "name", "typeName", "type_name", "familyName", "family_name").toLowerCase();
        const isRoomCircuitText = !!textRoomNumber && visibleTextLooksLikeRoomCircuitLabel(visibleTextPayload);
        const isSpatialRoomText = !!textRoomNumber && visibleTextLooksLikeSpatialRoomLabel(visibleTextPayload);
        const isTextLike =
          builtIn === "OST_TextNotes" ||
          builtIn === "OST_RoomTags" ||
          builtIn === "OST_MEPSpaceTags" ||
          builtIn === "OST_GenericAnnotation" ||
          category.includes("annotation") ||
          category.includes("tag") ||
          category.includes("text");
        const isElectrical =
          builtIn === "OST_ElectricalFixtures" ||
          builtIn === "OST_ElectricalDevices" ||
          category.includes("electrical") ||
          /\b(receptacle|outlet|duplex|gfci|gfi|switch|device)\b/.test(name);
        const params = extractInventoryItemElectricalParameters(item);
        const electricalRoom =
          isElectrical
            ? extractRoomNumberFromVisibleText(
                [params.panel, params.panel && params.circuit ? `${params.panel}/${params.circuit}` : ""].filter(Boolean).join(" ")
              )
            : null;
        const roomMatch = explicitRoomNumber === room || textRoomNumber === room || electricalRoom === room;
        if (!roomMatch) return null;
        const side = inferMarkSideFromNormalizedPoint(point.x, point.y);
        const sideMatches = args.markedSide !== null && args.markedSide !== undefined && side === args.markedSide;
        const rankScore =
          (isRoomCircuitText ? 100 : 0) +
          (isSpatialRoomText ? 75 : 0) +
          (isElectrical ? 72 : 0) +
          (isTextLike ? 22 : 0) +
          (params.panel ? 14 : 0) +
          (params.circuit ? 10 : 0) +
          (args.preferAdjacentCircuitContext ? 12 : 0) +
          (sideMatches ? 8 : 0);
        if (rankScore <= 0) return null;
        return {
          view_id: wantViewId ?? resViewId ?? 0,
          normalized_x: point.x,
          normalized_y: point.y,
          score: Math.max(0.2, Math.min(0.88, rankScore / 160)),
          rankScore,
          index
        };
      })
      .filter((hint): hint is ViewportPickHint & { rankScore: number; index: number } => !!hint && hint.view_id > 0)
      .sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.index - b.index);

    const best = ranked[0];
    if (best) {
      return {
        view_id: best.view_id,
        normalized_x: best.normalized_x,
        normalized_y: best.normalized_y,
        score: best.score,
        source: "visible_inventory_anchor",
        frame_aligned: true
      };
    }
  }
  return null;
}

type VisibleAdjacentDeviceContextInference = {
  room_number: string;
  spatial_side: "left" | "right" | "top" | "bottom" | null;
};

function inferRoomAndSideFromVisibleAdjacentDeviceContext(args: {
  toolResults: ToolResult[];
  markHint: ImageMarkHint | null;
  markedSide?: "left" | "right" | "top" | "bottom" | null;
  knownRoomNumber?: string | null;
}): VisibleAdjacentDeviceContextInference | null {
  const markedSide = args.markedSide ?? normalizeSpatialWallSide(args.markHint?.side ?? "");
  const markPoint = imageMarkPoint(args.markHint);
  const knownRoomNumber = (args.knownRoomNumber ?? "").trim().toUpperCase();
  for (let i = args.toolResults.length - 1; i >= 0; i--) {
    const r = args.toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractVisibleInventoryItems(res);
    const spatialAnchors = items
      .map((item, index) => {
        const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
        const categoryToken = firstStringishField(item, "categoryToken", "category_token").trim();
        const category = firstStringishField(item, "category").toLowerCase();
        const visibleTextPayload = extractVisibleTextPayload(item);
        const textRoomNumber = extractRoomNumberFromVisibleText(visibleTextPayload);
        const isSpatialElement =
          builtIn === "OST_Rooms" ||
          builtIn === "OST_MEPSpaces" ||
          categoryToken === "OST_Rooms" ||
          categoryToken === "OST_MEPSpaces" ||
          category === "rooms" ||
          category === "spaces" ||
          category.includes("mep space");
        const isRoomLabel =
          !!textRoomNumber &&
          (builtIn === "OST_RoomTags" ||
            builtIn === "OST_MEPSpaceTags" ||
            builtIn === "OST_TextNotes" ||
            builtIn === "OST_GenericAnnotation" ||
            categoryToken === "OST_RoomTags" ||
            categoryToken === "OST_MEPSpaceTags" ||
            categoryToken === "OST_TextNotes" ||
            categoryToken === "OST_GenericAnnotation" ||
            category.includes("room tag") ||
            category.includes("space tag") ||
            category.includes("annotation") ||
            category.includes("text") ||
            visibleTextLooksLikeSpatialRoomLabel(visibleTextPayload));
        if (!isSpatialElement && !isRoomLabel) return null;
        const roomNumber = extractInventoryItemRoomNumber(item) ?? textRoomNumber;
        const box = extractVisibleInventoryItemImageBox(item);
        const point = extractVisibleInventoryItemImagePoint(item) ?? (box ? { x: (box.minX + box.maxX) * 0.5, y: (box.minY + box.maxY) * 0.5 } : null);
        if (!roomNumber || !point) return null;
        return { roomNumber, box, point, index, labelOnly: !isSpatialElement };
      })
      .filter((item): item is { roomNumber: string; box: VisibleInventoryImageBox | null; point: { x: number; y: number }; index: number; labelOnly: boolean } => item !== null);

    const scores = new Map<
      string,
      {
        score: number;
        electricalCount: number;
        nearestMarkDistance: number | null;
        firstIndex: number;
        sideScores: Record<"left" | "right" | "top" | "bottom", number>;
      }
    >();
    const emptySideScores = (): Record<"left" | "right" | "top" | "bottom", number> => ({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0
    });
    const addScore = (
      roomNumber: string | null,
      score: number,
      electrical: boolean,
      index: number,
      markDistance: number | null,
      side: "left" | "right" | "top" | "bottom" | null
    ): void => {
      const room = (roomNumber ?? "").trim().toUpperCase();
      if (!/^[A-Z]?\d{2,6}[A-Z]?$/.test(room)) return;
      if (knownRoomNumber && room !== knownRoomNumber) return;
      const current = scores.get(room);
      if (!current) {
        scores.set(room, {
          score,
          electricalCount: electrical ? 1 : 0,
          nearestMarkDistance: markDistance,
          firstIndex: index,
          sideScores: {
            ...emptySideScores(),
            ...(side ? { [side]: score } : {})
          }
        });
        return;
      }
      current.score += score;
      if (electrical) current.electricalCount += 1;
      current.firstIndex = Math.min(current.firstIndex, index);
      if (side) current.sideScores[side] += score;
      if (markDistance !== null) {
        current.nearestMarkDistance =
          current.nearestMarkDistance === null ? markDistance : Math.min(current.nearestMarkDistance, markDistance);
      }
    };

    items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const builtIn = firstStringishField(item, "builtInCategory", "built_in_category").trim();
      const category = firstStringishField(item, "category").toLowerCase();
      const name = firstStringishField(item, "name", "typeName", "type_name", "familyName", "family_name").toLowerCase();
      const isElectrical =
        builtIn === "OST_ElectricalFixtures" ||
        builtIn === "OST_ElectricalDevices" ||
        category.includes("electrical") ||
        /\b(receptacle|outlet|duplex|gfci|gfi|switch|device)\b/.test(name);
      if (!isElectrical) return;
      const point = extractVisibleInventoryItemImagePoint(item);
      const explicitRoomNumber = extractInventoryItemRoomNumber(item);
      const textRoomNumber = extractRoomNumberFromVisibleText(extractVisibleTextPayload(item));
      const params = extractInventoryItemElectricalParameters(item);
      const panelRoomNumber = extractRoomNumberFromVisibleText(
        [params.panel, params.panel && params.circuit ? `${params.panel}/${params.circuit}` : ""].filter(Boolean).join(" ")
      );
      const nearestSpatial =
        !explicitRoomNumber && !textRoomNumber && !panelRoomNumber && point && spatialAnchors.length > 0
          ? [...spatialAnchors]
              .map((anchor) => ({
                ...anchor,
                containsDevice: imagePointInsideBox(point, anchor.box, 0.012),
                containsMark: imagePointInsideBox(markPoint, anchor.box, 0.012),
                distance: Math.sqrt((anchor.point.x - point.x) ** 2 + (anchor.point.y - point.y) ** 2),
                sideAxisDistance:
                  anchor.labelOnly && markedSide
                    ? markedSide === "left" || markedSide === "right"
                      ? Math.abs(anchor.point.y - point.y)
                      : Math.abs(anchor.point.x - point.x)
                    : null,
                markDistance: normalizedDistanceToImageMark(anchor.point, args.markHint)
              }))
              .sort(
                (a, b) =>
                  Number(b.containsDevice) - Number(a.containsDevice) ||
                  Number(b.containsMark) - Number(a.containsMark) ||
                  ((a.sideAxisDistance ?? Number.POSITIVE_INFINITY) - (b.sideAxisDistance ?? Number.POSITIVE_INFINITY)) ||
                  (a.markDistance ?? Number.POSITIVE_INFINITY) - (b.markDistance ?? Number.POSITIVE_INFINITY) ||
                  a.distance - b.distance ||
                  a.index - b.index
              )[0] ?? null
          : null;
      const nearestSpatialRoom =
        nearestSpatial &&
        (nearestSpatial.containsDevice ||
          nearestSpatial.containsMark ||
          nearestSpatial.distance <= 0.34 ||
          (nearestSpatial.labelOnly &&
            point &&
            nearestSpatial.distance <= 0.58 &&
            !spatialAnchors.some(
              (anchor) =>
                anchor.roomNumber !== nearestSpatial.roomNumber &&
                Math.sqrt((anchor.point.x - point.x) ** 2 + (anchor.point.y - point.y) ** 2) <= nearestSpatial.distance + 0.14
            )))
          ? nearestSpatial.roomNumber
          : null;
      const roomNumber = explicitRoomNumber ?? textRoomNumber ?? panelRoomNumber ?? nearestSpatialRoom;
      if (!roomNumber) return;
      const containingRoomBox =
        point && roomNumber
          ? spatialAnchors.find((anchor) => anchor.roomNumber === roomNumber && imagePointInsideBox(point, anchor.box, 0.012))?.box ?? null
          : null;
      const side = point ? inferPointSideWithinImageBox(point, containingRoomBox) ?? inferMarkSideFromNormalizedPoint(point.x, point.y) : null;
      const sideMatches = markedSide !== null && side === markedSide;
      const markDistance = normalizedDistanceToImageMark(point, args.markHint);
      const proximityBoost = markDistance === null ? 0 : Math.max(0, 42 - markDistance * 100);
      const score =
        36 +
        (explicitRoomNumber ? 24 : 0) +
        (textRoomNumber ? 16 : 0) +
        (panelRoomNumber ? 22 : 0) +
        (nearestSpatialRoom ? 18 : 0) +
        (params.panel ? 8 : 0) +
        (params.circuit ? 8 : 0) +
        (sideMatches ? 58 : 0) +
        proximityBoost;
      addScore(roomNumber, score, true, index, markDistance, side);
    });

    const ranked = [...scores.entries()].sort(
      (a, b) =>
        b[1].score - a[1].score ||
        b[1].electricalCount - a[1].electricalCount ||
        ((a[1].nearestMarkDistance ?? Number.POSITIVE_INFINITY) - (b[1].nearestMarkDistance ?? Number.POSITIVE_INFINITY)) ||
        a[1].firstIndex - b[1].firstIndex ||
        a[0].localeCompare(b[0])
    );
    const top = ranked[0];
    if (!top) return null;
    const second = ranked[1];
    const stats = top[1];
    const rankedSides = (["left", "right", "top", "bottom"] as const)
      .map((side) => ({ side, score: stats.sideScores[side] }))
      .sort((a, b) => b.score - a.score);
    const inferredSide =
      markedSide && stats.sideScores[markedSide] > 0
        ? markedSide
        : rankedSides[0] && rankedSides[0].score > 0
          ? rankedSides[0].side
          : null;
    const result = { room_number: top[0], spatial_side: inferredSide };
    if (knownRoomNumber && top[0] === knownRoomNumber && stats.electricalCount >= 1 && inferredSide) return result;
    if (markPoint && stats.nearestMarkDistance !== null && stats.nearestMarkDistance <= 0.5 && (!second || stats.score - second[1].score >= 8)) {
      return result;
    }
    if (markedSide && stats.score >= 80 && (!second || stats.score - second[1].score >= 14)) return result;
    if (stats.electricalCount >= 2 && stats.score >= 120 && (!second || stats.score - second[1].score >= 18)) return result;
    if (stats.electricalCount >= 1 && stats.score >= 92 && (!second || stats.score >= second[1].score * 1.65)) return result;
    if (!second && stats.electricalCount >= 1 && stats.score >= 76) return result;
    return null;
  }
  return null;
}

function inferRoomNumberFromVisibleInventorySummary(toolResults: ToolResult[]): string | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/export-visible-elements") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const summary = res.summary && typeof res.summary === "object" ? (res.summary as Record<string, unknown>) : null;
    if (!summary) continue;

    const scores = new Map<string, { score: number; firstIndex: number }>();
    const addEntries = (entries: unknown, weight: number): void => {
      if (!Array.isArray(entries)) return;
      entries.forEach((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const obj = entry as Record<string, unknown>;
        const key = typeof obj.key === "string" ? obj.key.trim().toUpperCase() : "";
        if (!/^[A-Z]?\d{2,6}[A-Z]?$/.test(key)) return;
        const count = toFiniteNumber(obj.count) ?? 0;
        if (count <= 0) return;
        const current = scores.get(key);
        const score = count * weight;
        if (!current) scores.set(key, { score, firstIndex: index });
        else {
          current.score += score;
          current.firstIndex = Math.min(current.firstIndex, index);
        }
      });
    };

    addEntries(summary.roomCounts, 1.0);
    addEntries(summary.spaceCounts, 0.85);

    const ranked = [...scores.entries()].sort(
      (a, b) => b[1].score - a[1].score || a[1].firstIndex - b[1].firstIndex || a[0].localeCompare(b[0])
    );
    const top = ranked[0];
    if (!top) return null;
    const second = ranked[1];
    if (top[1].score >= 2.5 && (!second || top[1].score - second[1].score >= 1.5 || top[1].score >= second[1].score * 1.75)) {
      return top[0];
    }
    return null;
  }
  return null;
}

function extractElectricalParameterRows(toolResults: ToolResult[]): ElectricalParameterRow[] {
  const rows: ElectricalParameterRow[] = [];
  const seen = new Set<number>();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-parameters") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractResultItems(res);
    for (const item of items) {
      const id = toFiniteInt(item?.id ?? item?.elementId ?? item?.element_id);
      if (id === null || id <= 0 || seen.has(id)) continue;
      const parameters = item?.parameters && typeof item.parameters === "object"
        ? (item.parameters as Record<string, unknown>)
        : null;
      rows.push({
        id,
        name: typeof item?.name === "string" ? item.name.trim() : "",
        category: typeof item?.category === "string" ? item.category.trim() : "",
        panel: normalizeElectricalPanel(parameters?.Panel),
        circuit: normalizeElectricalCircuit(parameters?.["Circuit Number"] ?? parameters?.Circuit)
      });
      seen.add(id);
    }
  }
  return rows;
}

function findElectricalParameterRow(toolResults: ToolResult[], elementId: number): ElectricalParameterRow | null {
  return extractElectricalParameterRows(toolResults).find((row) => row.id === elementId) ?? null;
}

function electricalParameterRowMatches(row: ElectricalParameterRow | null, requested: { panel: string; circuit: string }): boolean {
  if (!row) return false;
  return row.panel === requested.panel && circuitValuesMatch(row.circuit, requested.circuit);
}

function isHostedPlacementActionPath(pathName: string): boolean {
  const p = (pathName ?? "").trim().toLowerCase();
  return p === "/revit/create-similar-from-instance" || p === "/revit/place-family-instance-on-host";
}

function getHostedPlacementSourceElementId(action: ActionCall): number | null {
  if (!action || !isHostedPlacementActionPath(action.path)) return null;
  const body = action.body && typeof action.body === "object" && !Array.isArray(action.body)
    ? (action.body as Record<string, unknown>)
    : null;
  if (!body) return null;
  return toFiniteInt(body.exemplarElementId) ?? toFiniteInt(body.sourceElementId);
}

function collectCircuitVerificationCandidateIds(args: {
  actions: ActionCall[];
  toolResults: ToolResult[];
  roomNumber: string | null;
  viewId: number | null;
}): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const push = (id: number | null) => {
    if (id === null || id <= 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const action of args.actions) {
    push(getHostedPlacementSourceElementId(action));
    const body = action.body && typeof action.body === "object" && !Array.isArray(action.body)
      ? (action.body as Record<string, unknown>)
      : null;
    if (body) push(toFiniteInt(body.orientationSourceElementId));
  }
  if (args.viewId !== null) {
    for (const id of extractLatestFindElementsIdsForView(args.toolResults, args.viewId)) push(id);
  }
  for (const id of extractLatestFindElementsIds(args.toolResults)) push(id);
  if (args.roomNumber) {
    for (const id of extractLatestRoomContentsElementIds(args.toolResults, args.roomNumber)) push(id);
  }
  return ids.slice(0, 160);
}

function placementBasisFromPlaceOnHostBody(body: Record<string, unknown>): Record<string, unknown> | null {
  const placement: Record<string, unknown> = {};
  if (Array.isArray(body.pointXyz)) {
    placement.pointXyz = body.pointXyz;
  } else {
    const chainage = toFiniteNumber(body.targetChainageFt);
    const normalized = toFiniteNumber(body.targetNormalizedChainage);
    const offset = toFiniteNumber(body.alongHostOffsetFt);
    if (chainage !== null) placement.targetChainageFt = chainage;
    if (normalized !== null) placement.targetNormalizedChainage = normalized;
    if (chainage === null && normalized === null && offset !== null) placement.alongHostOffsetFt = offset;
  }
  if (Object.keys(placement).length === 0) return null;
  placement.label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "mark 1";
  return placement;
}

function bodyUsesExplicitPointPlacement(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.pointXyz)) return true;
  const placements = Array.isArray(body.placements) ? (body.placements as unknown[]) : [];
  return placements.some((placement) => {
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) return false;
    return Array.isArray((placement as Record<string, unknown>).pointXyz);
  });
}

function buildCreateSimilarCircuitReplacementAction(args: {
  original: ActionCall;
  requested: { panel: string; circuit: string };
  sourceElementId: number;
  exemplarElementId: number;
}): ActionCall | null {
  const originalBody = args.original.body && typeof args.original.body === "object" && !Array.isArray(args.original.body)
    ? (args.original.body as Record<string, unknown>)
    : null;
  if (!originalBody) return null;
  const pathName = (args.original.path ?? "").trim().toLowerCase();
  const body = cloneJsonObject(originalBody) ?? {};
  delete body.sourceElementId;
  body.exemplarElementId = args.exemplarElementId;
  if (bodyUsesExplicitPointPlacement(body)) {
    delete body.orientationSourceElementId;
    body.matchOrientationFromSource = false;
  } else if (toFiniteInt(body.orientationSourceElementId) === args.sourceElementId || toFiniteInt(body.orientationSourceElementId) === null) {
    body.orientationSourceElementId = args.exemplarElementId;
    body.matchOrientationFromSource = true;
  }
  body.matchElectricalCircuitFromSource = true;
  body.requireElectricalCircuitMatch = true;
  body.dryRun = true;
  body.includePreviewImage = true;

  if (pathName === "/revit/place-family-instance-on-host") {
    const placement = placementBasisFromPlaceOnHostBody(originalBody);
    if (!placement) return null;
    body.placements = [placement];
    delete body.pointXyz;
    delete body.targetChainageFt;
    delete body.targetNormalizedChainage;
    delete body.alongHostOffsetFt;
  } else if (!Array.isArray(body.placements) || body.placements.length === 0) {
    return null;
  }

  return {
    action_id: randomUUID(),
    method: "POST",
    path: "/revit/create-similar-from-instance",
    body
  };
}

function buildExplicitCircuitPlacementSourceGuardResponse(args: {
  req: ChatRequest;
  actions: ActionCall[];
  toolResults: ToolResult[];
}): ChatResponse | null {
  const recentText = getRecentUserTextForRedline(args.req);
  const requested = extractRequestedPanelCircuit(recentText);
  if (!requested) return null;
  const placementAction = args.actions.find((action) => action.method === "POST" && isHostedPlacementActionPath(action.path));
  if (!placementAction) return null;
  const sourceElementId = getHostedPlacementSourceElementId(placementAction);
  if (sourceElementId === null || sourceElementId <= 0) return null;

  const targetProfile = inferRedlineTargetingProfileFromText(
    recentText,
    getPersistedGeminiIntentHints(args.req.session_id),
    getPersistedAnnotationRegionHints(args.req.session_id)
  );
  const targetViewId = extractActiveSheetViewIdFromContext(args.req.context);
  const sourceRow = findElectricalParameterRow(args.toolResults, sourceElementId);
  if (electricalParameterRowMatches(sourceRow, requested)) return null;

  const matchingExemplarId = extractLatestElectricalCircuitExemplarId(args.toolResults, requested);
  if (matchingExemplarId !== null && matchingExemplarId > 0 && matchingExemplarId !== sourceElementId) {
    const replacement = buildCreateSimilarCircuitReplacementAction({
      original: placementAction,
      requested,
      sourceElementId,
      exemplarElementId: matchingExemplarId
    });
    if (replacement) {
      const mismatchDetail = sourceRow
        ? `element ${sourceElementId} is ${sourceRow.panel || "unknown"}/${sourceRow.circuit || "unknown"}`
        : `element ${sourceElementId} has not been verified against ${requested.panel}/${requested.circuit}`;
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I caught an unsafe placement source before writing: ${mismatchDetail}. ` +
          `I’ll switch to verified same-circuit exemplar ${matchingExemplarId} and preview create-similar on the same target host.`,
        actions: [
          buildPlacementWarningGuardAction(),
          replacement
        ]
      };
    }
  }

  const candidateIds = collectCircuitVerificationCandidateIds({
    actions: args.actions,
    toolResults: args.toolResults,
    roomNumber: targetProfile.room_number,
    viewId: targetViewId
  });
  if (candidateIds.length === 0 || (sourceRow && !electricalParameterRowMatches(sourceRow, requested))) return null;

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `I need to verify the placement source against ${requested.panel}/${requested.circuit} before any hosted-device write. ` +
      "Raw visible-element order is not a safe exemplar source, so I’ll read circuit parameters first.",
    actions: [
      {
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/get-parameters",
        body: {
          elementIds: candidateIds,
          names: ["Panel", "Circuit Number", "Circuit", "Electrical Circuit", "Family", "Type", "Family and Type", "Type Name", "Elevation", "Offset"]
        }
      }
    ]
  };
}

export function __testOnlyBuildExplicitCircuitPlacementSourceGuardResponse(args: {
  req: ChatRequest;
  actions: ActionCall[];
  toolResults: ToolResult[];
}): ChatResponse | null {
  return buildExplicitCircuitPlacementSourceGuardResponse(args);
}

type SheetSummaryCandidate = {
  id: number;
  category: string;
  name: string;
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  point?: { x: number; y: number };
};

function extractLatestSheetSummaryCandidates(toolResults: ToolResult[]): SheetSummaryCandidate[] {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-element-summary") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!Array.isArray(r.result_json)) continue;
    const rows = r.result_json as Array<Record<string, unknown>>;
    const out: SheetSummaryCandidate[] = [];
    for (const row of rows) {
      const id = toFiniteInt(row?.id);
      if (id === null || id <= 0) continue;
      const found = typeof row?.found === "boolean" ? row.found : true;
      if (!found) continue;
      const category = typeof row?.category === "string" ? row.category.trim() : "";
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      const item: SheetSummaryCandidate = { id, category, name };
      const bb = row?.boundingBox && typeof row.boundingBox === "object" ? (row.boundingBox as Record<string, unknown>) : null;
      if (bb) {
        const min = bb.min && typeof bb.min === "object" ? (bb.min as Record<string, unknown>) : null;
        const max = bb.max && typeof bb.max === "object" ? (bb.max as Record<string, unknown>) : null;
        const minX = toFiniteNumber(min?.x);
        const minY = toFiniteNumber(min?.y);
        const maxX = toFiniteNumber(max?.x);
        const maxY = toFiniteNumber(max?.y);
        if (minX !== null && minY !== null && maxX !== null && maxY !== null && maxX >= minX && maxY >= minY) {
          item.bbox = { minX, minY, maxX, maxY };
        }
      }
      const loc = row?.location && typeof row.location === "object" ? (row.location as Record<string, unknown>) : null;
      if (loc) {
        const t = typeof loc.type === "string" ? loc.type.trim().toLowerCase() : "";
        if (t === "point") {
          const x = toFiniteNumber(loc.x);
          const y = toFiniteNumber(loc.y);
          if (x !== null && y !== null) item.point = { x, y };
        } else if (t === "curve") {
          const p0 = loc.p0 && typeof loc.p0 === "object" ? (loc.p0 as Record<string, unknown>) : null;
          const p1 = loc.p1 && typeof loc.p1 === "object" ? (loc.p1 as Record<string, unknown>) : null;
          const x0 = toFiniteNumber(p0?.x);
          const y0 = toFiniteNumber(p0?.y);
          const x1 = toFiniteNumber(p1?.x);
          const y1 = toFiniteNumber(p1?.y);
          if (x0 !== null && y0 !== null && x1 !== null && y1 !== null) {
            item.point = { x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5 };
          }
        }
      }
      out.push(item);
    }
    return out.slice(0, 300);
  }
  return [];
}

function chooseNearestSummaryCandidateForSpatialHint(args: {
  frame: ViewFrameSummary | null;
  viewportHints: ViewportPickHint[];
  spatialViewId: number;
  candidates: SheetSummaryCandidate[];
  candidateIds?: number[];
}): SheetSummaryCandidate | null {
  const filtered =
    Array.isArray(args.candidateIds) && args.candidateIds.length > 0
      ? args.candidates.filter((candidate) => args.candidateIds!.includes(candidate.id))
      : args.candidates.slice();
  if (filtered.length === 0) return null;

  const bestHint =
    args.viewportHints.find((hint) => hint.view_id === args.spatialViewId) ??
    args.viewportHints[0] ??
    null;
  const modelPoint = args.frame && bestHint ? frameHintToModelPoint(args.frame, bestHint) : null;
  if (!modelPoint) return filtered[0] ?? null;

  const withDistance = filtered
    .map((candidate) => {
      const point = candidate.point
        ? candidate.point
        : candidate.bbox
          ? { x: (candidate.bbox.minX + candidate.bbox.maxX) * 0.5, y: (candidate.bbox.minY + candidate.bbox.maxY) * 0.5 }
          : null;
      if (!point) return null;
      const dx = point.x - modelPoint[0];
      const dy = point.y - modelPoint[1];
      return { candidate, distance2: (dx * dx) + (dy * dy) };
    })
    .filter((row): row is { candidate: SheetSummaryCandidate; distance2: number } => row !== null)
    .sort((a, b) => a.distance2 - b.distance2);

  return withDistance[0]?.candidate ?? filtered[0] ?? null;
}

function extractLatestSheetParameterTextById(toolResults: ToolResult[]): Map<number, string> {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-parameters") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!r.result_json || typeof r.result_json !== "object") continue;
    const res = r.result_json as Record<string, unknown>;
    const items = extractResultItems(res);
    const out = new Map<number, string>();
    for (const it of items) {
      const id = toFiniteInt(it?.id ?? it?.elementId ?? it?.element_id);
      if (id === null || id <= 0) continue;
      const parts: string[] = [];
      const name = typeof it?.name === "string" ? it.name.trim() : "";
      const category = typeof it?.category === "string" ? it.category.trim() : "";
      if (name) parts.push(name);
      if (category) parts.push(category);
      const p = it?.parameters && typeof it.parameters === "object" ? (it.parameters as Record<string, unknown>) : null;
      if (p) {
        for (const [k, v] of Object.entries(p)) {
          if (typeof k === "string" && k.trim()) parts.push(k.trim());
          if (typeof v === "string" && v.trim()) parts.push(v.trim());
          else if (typeof v === "number" && Number.isFinite(v)) parts.push(String(v));
        }
      }
      out.set(id, parts.join(" ").toLowerCase());
    }
    return out;
  }
  return new Map<number, string>();
}

function normalizeForMatch(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function buildGeminiLexicon(intents: GeminiIntentHint[]): { phrases: string[]; tokens: string[]; has_delete_intent: boolean } {
  const phraseSet = new Set<string>();
  const tokenSet = new Set<string>();
  let hasDeleteIntent = false;
  const stop = new Set([
    "with", "from", "into", "that", "this", "these", "those", "there", "their", "them", "then", "than", "must", "should", "would",
    "could", "will", "have", "has", "had", "does", "did", "done", "remove", "delete", "update", "change", "section", "content",
    "within", "around", "part", "overall", "ensure", "including", "associated", "project", "sheet", "model", "text", "block",
    "line", "lines", "annotation", "titleblock", "title", "region", "areas"
  ]);
  const deleteRx = /\b(delete|remove|demo|demolish|demolition|erase|omit|strike|x\s*out|take\s*out)\b/i;
  for (const it of intents) {
    const raw = `${it.intent ?? ""} ${it.proposed_action ?? ""}`;
    if (deleteRx.test(raw)) hasDeleteIntent = true;
    const q = /["']([^"']{4,120})["']/g;
    let m: RegExpExecArray | null;
    while ((m = q.exec(raw)) !== null) {
      const phrase = normalizeForMatch(m[1] ?? "");
      if (phrase.length >= 4) phraseSet.add(phrase);
    }
    const toks = normalizeForMatch(raw).split(" ").filter((x) => x.length >= 4 && !stop.has(x));
    for (const t of toks.slice(0, 80)) tokenSet.add(t);
  }
  return { phrases: [...phraseSet].slice(0, 40), tokens: [...tokenSet].slice(0, 80), has_delete_intent: hasDeleteIntent };
}

function pointInSheetRegion(p: { x: number; y: number }, b: SheetRegionBoxHint): boolean {
  return p.x >= b.minU && p.x <= b.maxU && p.y >= b.minV && p.y <= b.maxV;
}

function bboxIntersectsSheetRegion(bb: { minX: number; minY: number; maxX: number; maxY: number }, b: SheetRegionBoxHint): boolean {
  return !(bb.maxX < b.minU || bb.minX > b.maxU || bb.maxY < b.minV || bb.minY > b.maxV);
}

type SheetCandidateScoreDiagnostic = {
  id: number;
  score: number;
  phrase_hits: number;
  token_hits: number;
  geometry_hits: number;
  delete_signal: number;
  category_score: number;
  penalty: number;
  region_hit_indices: number[];
  reasons: string[];
};

function scoreSheetCandidateForRedline(
  c: SheetSummaryCandidate,
  regionBoxes: SheetRegionBoxHint[],
  lexicon: { phrases: string[]; tokens: string[]; has_delete_intent: boolean },
  parameterText: string,
  deleteLikeRegionIndices: Set<number>
): SheetCandidateScoreDiagnostic {
  const cat = (c.category ?? "").toLowerCase();
  const reasons: string[] = [];
  if (cat.includes("title block")) {
    return {
      id: c.id,
      score: -100,
      phrase_hits: 0,
      token_hits: 0,
      geometry_hits: 0,
      delete_signal: 0,
      category_score: -100,
      penalty: 0,
      region_hit_indices: [],
      reasons: ["titleblock_excluded"]
    };
  }

  let score = 0;
  const textBlob = normalizeForMatch(`${c.name ?? ""} ${c.category ?? ""} ${parameterText ?? ""}`);

  let phraseHits = 0;
  const matchedPhrases: string[] = [];
  for (const p of lexicon.phrases) {
    if (!p || p.length < 4) continue;
    if (textBlob.includes(p)) {
      phraseHits += 1;
      matchedPhrases.push(p);
    }
    if (phraseHits >= 6) break;
  }
  score += phraseHits * 3.5;

  let tokenHits = 0;
  const matchedTokens: string[] = [];
  for (const t of lexicon.tokens) {
    if (!t || t.length < 4) continue;
    if (textBlob.includes(t)) {
      tokenHits += 1;
      matchedTokens.push(t);
    }
    if (tokenHits >= 10) break;
  }
  score += tokenHits * 0.8;

  let geomHits = 0;
  const regionHitIdx = new Set<number>();
  if (regionBoxes.length > 0) {
    if (c.bbox) {
      const cx = (c.bbox.minX + c.bbox.maxX) * 0.5;
      const cy = (c.bbox.minY + c.bbox.maxY) * 0.5;
      for (const b of regionBoxes) {
        if (pointInSheetRegion({ x: cx, y: cy }, b)) {
          geomHits += 2;
          regionHitIdx.add(b.index);
        } else if (bboxIntersectsSheetRegion(c.bbox, b)) {
          geomHits += 1;
          regionHitIdx.add(b.index);
        }
      }
    } else if (c.point) {
      for (const b of regionBoxes) {
        if (pointInSheetRegion(c.point, b)) {
          geomHits += 1.5;
          regionHitIdx.add(b.index);
        }
      }
    }
  }
  const geomScore = Math.min(6, geomHits);
  score += geomScore;

  let deleteSignal = 0;
  if (lexicon.has_delete_intent) deleteSignal += 0.35;
  const hasDeleteRegionHit = [...regionHitIdx].some((idx) => deleteLikeRegionIndices.has(idx));
  if (hasDeleteRegionHit) deleteSignal += 1.25;
  if (/\b(delete|remove|demo|demolish|erase|omit|strike)\b/i.test(textBlob)) deleteSignal += 0.4;
  score += deleteSignal;

  let categoryScore = 0;
  if (cat.includes("text notes") || cat.includes("generic annotations") || cat.includes("detail items") || cat.includes("lines")) {
    categoryScore += 0.5;
  }
  if (cat.includes("raster") || cat.includes("image")) {
    categoryScore += 0.7;
  }
  score += categoryScore;

  let penalty = 0;
  if (regionBoxes.length > 0 && geomHits <= 0) {
    penalty += 0.9;
  }
  score -= penalty;

  if (matchedPhrases.length > 0) reasons.push(`phrase:${matchedPhrases.slice(0, 3).join("|")}`);
  if (matchedTokens.length > 0) reasons.push(`token:${matchedTokens.slice(0, 4).join("|")}`);
  if (geomHits > 0) reasons.push(`geometry:${geomHits.toFixed(2)}`);
  if (deleteSignal > 0) reasons.push(`delete_signal:${deleteSignal.toFixed(2)}`);
  if (penalty > 0) reasons.push(`penalty:${penalty.toFixed(2)}`);

  return {
    id: c.id,
    score,
    phrase_hits: phraseHits,
    token_hits: tokenHits,
    geometry_hits: geomHits,
    delete_signal: deleteSignal,
    category_score: categoryScore,
    penalty,
    region_hit_indices: [...regionHitIdx].sort((a, b) => a - b),
    reasons
  };
}

type SheetDeleteSelection = {
  recommended_ids: number[];
  diagnostics: SheetCandidateScoreDiagnostic[];
  confidence: number;
  auto_confident: boolean;
  blocker_reason?: string;
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function formatSheetScoreDiagnostics(diags: SheetCandidateScoreDiagnostic[], maxItems = 5): string {
  return diags
    .slice(0, Math.max(1, maxItems))
    .map((d) => {
      const parts = [
        `id ${d.id}`,
        `score ${d.score.toFixed(2)}`,
        `geo ${d.geometry_hits.toFixed(2)}`,
        `txt ${(d.phrase_hits + d.token_hits).toFixed(0)}`,
        `del ${d.delete_signal.toFixed(2)}`
      ];
      return parts.join(", ");
    })
    .join(" | ");
}

function chooseSheetDeleteCandidates(args: {
  candidates: SheetSummaryCandidate[];
  candidateIds: number[];
  regionBoxes: SheetRegionBoxHint[];
  geminiIntents: GeminiIntentHint[];
  annotationRegionHints: AnnotationRegionHint[];
  parameterTextById: Map<number, string>;
}): SheetDeleteSelection {
  const allowed = new Set<number>(args.candidateIds.filter((x) => Number.isFinite(x) && x > 0));
  const lexicon = buildGeminiLexicon(args.geminiIntents);
  const deleteLikeRegionIndices = new Set<number>();
  for (const h of args.annotationRegionHints) {
    if (!h || !h.is_delete_like) continue;
    if (Number.isFinite(h.region_index) && h.region_index > 0) deleteLikeRegionIndices.add(Math.floor(h.region_index));
  }
  const scored: SheetCandidateScoreDiagnostic[] = [];
  for (const c of args.candidates) {
    if (!allowed.has(c.id)) continue;
    const ptxt = args.parameterTextById.get(c.id) ?? "";
    const diag = scoreSheetCandidateForRedline(c, args.regionBoxes, lexicon, ptxt, deleteLikeRegionIndices);
    scored.push(diag);
  }
  scored.sort((a, b) => b.score - a.score);

  const recommended = scored.filter((s) => s.score >= 2.2).slice(0, 16).map((s) => s.id);
  const top = scored[0];
  const second = scored[1];
  if (!top || recommended.length === 0) {
    return {
      recommended_ids: [],
      diagnostics: scored.slice(0, 16),
      confidence: 0,
      auto_confident: false,
      blocker_reason: "no candidates crossed scoring threshold"
    };
  }

  const margin = top.score - (second?.score ?? 0);
  const hasGeometry = top.geometry_hits > 0 || top.region_hit_indices.length > 0;
  const hasDeleteSignal = top.delete_signal >= 0.8 || top.region_hit_indices.some((idx) => deleteLikeRegionIndices.has(idx));
  const conf = clamp01(
    clamp01((top.score - 2.2) / 2.0) * 0.52 +
      clamp01(margin / 1.4) * 0.23 +
      (hasGeometry ? 0.15 : 0) +
      (hasDeleteSignal ? 0.10 : 0)
  );
  const requireDeleteSignal = lexicon.has_delete_intent || deleteLikeRegionIndices.size > 0;
  const autoConfident = conf >= 0.66 && hasGeometry && (!requireDeleteSignal || hasDeleteSignal);
  const blocker = autoConfident
    ? undefined
    : `confidence ${conf.toFixed(2)} below auto-delete threshold; top candidates: ${formatSheetScoreDiagnostics(scored, 4)}`;

  return {
    recommended_ids: recommended,
    diagnostics: scored.slice(0, 32),
    confidence: conf,
    auto_confident: autoConfident,
    ...(blocker ? { blocker_reason: blocker } : {})
  };
}

function scoreSummaryForAssistant(selection: SheetDeleteSelection): string {
  if (!selection || selection.diagnostics.length === 0) return "No scored candidates.";
  return `score diagnostics: ${formatSheetScoreDiagnostics(selection.diagnostics, 5)}`;
}

function redlineTextAllowsDeleteApply(req: ChatRequest): boolean {
  const text = getRecentUserTextForRedline(req).toLowerCase();
  if (/\b(dry[\s-]*run|preview|do\s+not\s+(?:apply|write|delete|remove)|no\s+model\s+change)\b/.test(text)) return false;
  return true;
}

function hasExplicitMoveRedlineContinuation(req: ChatRequest, toolResults: ToolResult[]): boolean {
  if (!hasToolPath(toolResults, "/revit/move-elements")) return false;
  const text = getRecentUserTextForRedline(req).toLowerCase();
  if (!/\b(move|moved|moving|nudge|shift|relocate|drag)\b/.test(text)) return false;
  return /\b(redline|mark(?:up)?|selected|target|annotation|note|keynote|text\s*note|this|indicated)\b/.test(text);
}

function hasExplicitRotateRedlineContinuation(req: ChatRequest, toolResults: ToolResult[]): boolean {
  if (!hasToolPath(toolResults, "/revit/rotate-elements")) return false;
  const text = getRecentUserTextForRedline(req).toLowerCase();
  if (!/\b(rotate|rotated|rotation|reorient|turn)\b/.test(text)) return false;
  return /\b(redline|mark(?:up)?|selected|target|annotation|note|keynote|text\s*note|this|indicated)\b/.test(text);
}

const DEFAULT_REDLINE_ANNOTATION_CATEGORIES = [
  "OST_TextNotes",
  "OST_Lines",
  "OST_GenericAnnotation",
  "OST_DetailComponents",
  "OST_TitleBlocks",
  "OST_RasterImages"
];

const REDLINE_SPATIAL_CONTEXT_CATEGORIES = [
  "OST_ElectricalFixtures",
  "OST_ElectricalDevices",
  "OST_GenericAnnotation",
  "OST_TextNotes",
  "OST_RoomTags",
  "OST_MEPSpaceTags",
  "OST_Rooms",
  "OST_MEPSpaces"
];

type RedlineTargetingProfile = {
  categories: string[];
  pick_preference: "annotation" | "modelGeometry" | "any";
  scope_label: string;
  resolve_only: boolean;
  parameter_names: string[];
  spatial_terms: string[];
  region_padding_ft: number;
  room_number: string | null;
  spatial_side: "left" | "right" | "top" | "bottom" | null;
  spatial_side_source: string | null;
};

function isSpatialPlacementTargetingProfile(profile: RedlineTargetingProfile | null | undefined): boolean {
  if (!profile) return false;
  if (!profile.resolve_only) return false;
  if (profile.pick_preference !== "modelGeometry") return false;
  if (!profile.room_number) return false;
  return true;
}

function buildRedlineVisibleInventoryCategories(profile: RedlineTargetingProfile): string[] {
  const includeSpatialContext =
    !profile.room_number ||
    (profile.resolve_only && profile.pick_preference === "modelGeometry");
  const categories = [
    ...profile.categories,
    ...(includeSpatialContext ? REDLINE_SPATIAL_CONTEXT_CATEGORIES : [])
  ]
    .map((category) => category.trim())
    .filter(Boolean);
  return [...new Set(categories)];
}

function hydrateTargetProfileFromVisibleInventory(args: {
  targetProfile: RedlineTargetingProfile;
  toolResults: ToolResult[];
  markHint: ImageMarkHint | null;
  mappedMarkSide: "left" | "right" | "top" | "bottom" | null;
  semanticCorpus: string;
  allowRoomOverride?: boolean;
}): RedlineTargetingProfile {
  const { targetProfile, toolResults, markHint, mappedMarkSide, semanticCorpus } = args;
  const preferAdjacentCircuitContext = wantsElectricalCircuitMatch(semanticCorpus);
  const markedSide = targetProfile.spatial_side ?? mappedMarkSide;
  const adjacentInference = preferAdjacentCircuitContext
    ? inferRoomAndSideFromVisibleAdjacentDeviceContext({
        toolResults,
        markHint,
        markedSide,
        knownRoomNumber: targetProfile.room_number
      })
    : null;
  const overrideAdjacentInference =
    preferAdjacentCircuitContext && args.allowRoomOverride && targetProfile.room_number
      ? inferRoomAndSideFromVisibleAdjacentDeviceContext({
          toolResults,
          markHint,
          markedSide,
          knownRoomNumber: null
        })
      : null;
  const overrideInventoryRoom =
    overrideAdjacentInference?.room_number && overrideAdjacentInference.room_number !== targetProfile.room_number
      ? overrideAdjacentInference.room_number
      : null;
  const spatialHintRoom = inferRoomNumberFromVisibleInventorySpatialHint(toolResults, markHint, markedSide);
  const dominantRoom = inferRoomNumberFromVisibleInventoryDominantContext({
    toolResults,
    markHint,
    markedSide,
    preferAdjacentCircuitContext
  });
  const allowSummaryFallback =
    !preferAdjacentCircuitContext ||
    latestVisibleInventoryIsCompacted(toolResults) ||
    countToolPath(toolResults, "/revit/export-visible-elements") >= 2;
  const inventoryRoom =
    overrideInventoryRoom ??
    adjacentInference?.room_number ??
    spatialHintRoom ??
    dominantRoom ??
    (allowSummaryFallback ? inferRoomNumberFromVisibleInventorySummary(toolResults) : null);
  const inventorySide =
    (inventoryRoom && adjacentInference?.room_number === inventoryRoom ? adjacentInference.spatial_side : null) ??
    (inventoryRoom && overrideAdjacentInference?.room_number === inventoryRoom ? overrideAdjacentInference.spatial_side : null) ??
    targetProfile.spatial_side ??
    mappedMarkSide ??
    null;

  if (
    args.allowRoomOverride &&
    targetProfile.room_number &&
    inventoryRoom &&
    inventoryRoom !== targetProfile.room_number &&
    overrideAdjacentInference?.room_number === inventoryRoom
  ) {
    return {
      ...targetProfile,
      room_number: inventoryRoom,
      ...(inventorySide ? { spatial_side: inventorySide, spatial_side_source: inventorySide } : {})
    };
  }

  if (inventoryRoom && !targetProfile.room_number) {
    return {
      ...targetProfile,
      room_number: inventoryRoom,
      ...(inventorySide ? { spatial_side: inventorySide, spatial_side_source: inventorySide } : {})
    };
  }
  if (inventorySide && !targetProfile.spatial_side) {
    return {
      ...targetProfile,
      spatial_side: inventorySide,
      spatial_side_source: inventorySide
    };
  }
  return targetProfile;
}

function shouldPrioritizeHostedPlacementBridge(profile: RedlineTargetingProfile | null | undefined, toolResults: ToolResult[]): boolean {
  if (!isSpatialPlacementTargetingProfile(profile)) return false;
  return (
    extractLatestPlacementWriteSuccess(toolResults) !== null ||
    hasToolPath(toolResults, "/revit/audit-hosted-instance-placement") ||
    hasToolPath(toolResults, "/revit/export-view-region")
  );
}

export function __testOnlyShouldPrioritizeHostedPlacementBridge(args: {
  profile: RedlineTargetingProfile | null | undefined;
  toolResults: ToolResult[];
}): boolean {
  return shouldPrioritizeHostedPlacementBridge(args.profile, args.toolResults);
}

export function __testOnlyBuildFastPreflightViewMismatchFallback(args: {
  toolResults?: ToolResult[];
  diagnosticsText?: string;
  checkedViews?: Array<{ view_id: number; view_name: string; matched: boolean; confidence: number; analysis: string }>;
}): RedlineFastPathPreflight {
  return buildFastPreflightViewMismatchFallback({
    toolResults: Array.isArray(args.toolResults) ? args.toolResults : [],
    diagnosticsText: typeof args.diagnosticsText === "string" ? args.diagnosticsText : "",
    checkedViews: Array.isArray(args.checkedViews) ? args.checkedViews : []
  });
}

export function __testOnlyHydrateTargetProfileFromVisibleInventory(args: {
  targetProfile: RedlineTargetingProfile;
  toolResults: ToolResult[];
  markHint?: Partial<ImageMarkHint> | null;
  mappedMarkSide?: "left" | "right" | "top" | "bottom" | null;
  semanticCorpus?: string;
  allowRoomOverride?: boolean;
}): RedlineTargetingProfile {
  const markHint = args.markHint
    ? {
        normalized_x: toFiniteNumber(args.markHint.normalized_x) ?? 0.5,
        normalized_y: toFiniteNumber(args.markHint.normalized_y) ?? 0.5,
        side: normalizeSpatialWallSide(args.markHint.side ?? "") ?? null,
        score: toFiniteNumber(args.markHint.score) ?? 0.5
      }
    : null;
  return hydrateTargetProfileFromVisibleInventory({
    targetProfile: args.targetProfile,
    toolResults: Array.isArray(args.toolResults) ? args.toolResults : [],
    markHint,
    mappedMarkSide: args.mappedMarkSide ?? null,
    semanticCorpus: typeof args.semanticCorpus === "string" ? args.semanticCorpus : "",
    allowRoomOverride: !!args.allowRoomOverride
  });
}

function getRecentUserTextForRedline(req: ChatRequest, maxUserMessages = 4): string {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const text = raw.trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  push(req.user_text ?? "");
  try {
    const history = getHistory(req.session_id);
    for (let i = history.length - 1; i >= 0 && out.length < maxUserMessages; i--) {
      const msg = history[i];
      if (!msg || msg.role !== "user") continue;
      push(msg.text);
    }
  } catch {
    // ignore
  }

  return out.reverse().join("\n");
}

function buildRedlineSemanticCorpus(req: ChatRequest, workbenchResults: WorkbenchActionResult[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const text = raw.trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };

  push(getRecentUserTextForRedline(req));

  for (const r of workbenchResults) {
    if (!r || !r.details || typeof r.details !== "object") continue;
    const details = r.details as Record<string, unknown>;
    const analysis =
      details.analysis && typeof details.analysis === "object"
        ? (details.analysis as Record<string, unknown>)
        : null;
    const ocr =
      details.ocr && typeof details.ocr === "object"
        ? (details.ocr as Record<string, unknown>)
        : analysis && analysis.ocr && typeof analysis.ocr === "object"
          ? (analysis.ocr as Record<string, unknown>)
          : null;
    push(ocr?.text_excerpt);

    const orientationHints = Array.isArray(details.orientation_hints)
      ? details.orientation_hints
      : analysis && Array.isArray(analysis.orientation_hints)
        ? analysis.orientation_hints
        : [];
    for (const hint of orientationHints) push(hint);

    for (const ann of extractAnnotationRegionHintsFromDetails(details)) {
      push(ann.contents);
    }
    for (const gem of extractGeminiIntentHintsFromDetails(details)) {
      push(gem.intent);
      push(gem.proposed_action);
    }
  }

  return parts.join("\n");
}

function isMepRouteRedlineIntent(text: string): boolean {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return false;
  const hasMepRouteSubject =
    /\b(duct|ductwork|supply\s+duct|return\s+duct|exhaust\s+duct|pipe|piping|conduit)\b/.test(lower);
  if (!hasMepRouteSubject) return false;
  const hasRedlineOrRouteCue =
    /\b(redline|markup|mark-up|marked|attached|pdf|note|callout|draw|route|create|add|new|extend|span|segment|run)\b/.test(lower) ||
    /\b\d+(?:\.\d+)?\s*(?:in|inch|\"|')?\s*[x×]\s*\d+(?:\.\d+)?\s*(?:in|inch|\"|')?\b/.test(lower);
  return hasRedlineOrRouteCue;
}

type MepRedlineSpec = {
  kind: "duct" | "pipe" | "conduit";
  size_text: string;
  width_in: number;
  height_in: number;
  operation: "create" | "modify" | "unknown";
  source: "annotation" | "gemini" | "user" | "semantic";
  room_number: string | null;
  evidence: string;
};

function normalizeMepSizeNumber(value: number): string {
  if (Math.abs(value - Math.round(value)) < 0.0001) return String(Math.round(value));
  return String(Number(value.toFixed(3))).replace(/\.?0+$/, "");
}

function normalizeMepSizeText(widthIn: number, heightIn: number): string {
  return `${normalizeMepSizeNumber(widthIn)}x${normalizeMepSizeNumber(heightIn)}`;
}

function parseRectangularMepSize(text: string): { width_in: number; height_in: number; size_text: string } | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const rx =
    /\b(\d+(?:\.\d+)?)\s*(?:"|in(?:ches?)?)?\s*(?:wide|w)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:"|in(?:ches?)?)?\s*(?:high|h)?\b/i;
  const m = rx.exec(raw);
  if (!m) return null;
  const width = Number.parseFloat(m[1] ?? "");
  const height = Number.parseFloat(m[2] ?? "");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width_in: width, height_in: height, size_text: normalizeMepSizeText(width, height) };
}

function inferMepRedlineKind(text: string): MepRedlineSpec["kind"] | null {
  const lower = (text ?? "").toLowerCase();
  if (/\bduct|ductwork|supply\s+duct|return\s+duct|exhaust\s+duct\b/.test(lower)) return "duct";
  if (/\bpipe|piping\b/.test(lower)) return "pipe";
  if (/\bconduit\b/.test(lower)) return "conduit";
  return null;
}

function textHasExistingMepModificationCue(text: string): boolean {
  return /\b(resize|change|update|modify|edit|replace|existing|selected|current|incorrect|round|round\/incorrect|from\s+\d+(?:\.\d+)?)\b/i.test(text ?? "");
}

function textHasNewMepRouteCue(text: string): boolean {
  return /\b(add|new|create|route|draw|run|extend|branch|tap|supply\s+duct|return\s+duct|exhaust\s+duct)\b/i.test(text ?? "");
}

function extractMepRedlineSpecFromText(
  text: string,
  source: MepRedlineSpec["source"],
  options: { authoritativeLabel?: boolean } = {}
): MepRedlineSpec | null {
  const size = parseRectangularMepSize(text);
  if (!size) return null;
  const kind = inferMepRedlineKind(text);
  if (!kind) return null;
  const modifyCue = textHasExistingMepModificationCue(text);
  const createCue = textHasNewMepRouteCue(text);
  const operation: MepRedlineSpec["operation"] =
    options.authoritativeLabel && !modifyCue
      ? "create"
      : modifyCue
        ? "modify"
        : createCue
          ? "create"
          : "unknown";
  return {
    kind,
    size_text: size.size_text,
    width_in: size.width_in,
    height_in: size.height_in,
    operation,
    source,
    room_number: extractSpatialRoomNumber(text),
    evidence: text.trim().slice(0, 240)
  };
}

function betterMepSpec(existing: MepRedlineSpec | null, candidate: MepRedlineSpec | null): MepRedlineSpec | null {
  if (!candidate) return existing;
  if (!existing) return candidate;
  const sameAuthoritativeSize =
    existing.source === "annotation" &&
    candidate.kind === existing.kind &&
    mepSizesMatch(existing, candidate);
  if (sameAuthoritativeSize && !existing.room_number && candidate.room_number) {
    return { ...existing, room_number: candidate.room_number };
  }
  const score = (spec: MepRedlineSpec): number => {
    let s = 0;
    if (spec.source === "annotation") s += 100;
    else if (spec.source === "gemini") s += 40;
    else if (spec.source === "user") s += 30;
    else s += 10;
    if (spec.operation === "create") s += 8;
    if (spec.operation === "modify") s += 4;
    if (spec.room_number) s += 2;
    return s;
  };
  return score(candidate) > score(existing) ? candidate : existing;
}

function extractMepRedlineSpec(req: ChatRequest, workbenchResults: WorkbenchActionResult[]): MepRedlineSpec | null {
  if (req.session_id) rehydrateRedlineVisionProgressFromRunBundle(req.session_id);
  let best: MepRedlineSpec | null = null;

  const annotationHints = [
    ...getPersistedAnnotationRegionHints(req.session_id),
    ...workbenchResults.flatMap((r) => extractAnnotationRegionHintsFromDetails((r.details as Record<string, unknown> | undefined) ?? null))
  ];
  for (const ann of annotationHints) {
    if (!ann?.contents) continue;
    best = betterMepSpec(best, extractMepRedlineSpecFromText(ann.contents, "annotation", { authoritativeLabel: true }));
  }

  const geminiHints = [
    ...getPersistedGeminiIntentHints(req.session_id),
    ...workbenchResults.flatMap((r) => extractGeminiIntentHintsFromDetails((r.details as Record<string, unknown> | undefined) ?? null))
  ];
  for (const gem of geminiHints) {
    best = betterMepSpec(best, extractMepRedlineSpecFromText(`${gem.intent ?? ""}\n${gem.proposed_action ?? ""}`, "gemini"));
  }

  best = betterMepSpec(best, extractMepRedlineSpecFromText(getRecentUserTextForRedline(req), "user"));
  best = betterMepSpec(best, extractMepRedlineSpecFromText(buildRedlineSemanticCorpus(req, workbenchResults), "semantic"));
  return best;
}

function isExistingMepModificationPath(pathName: string): boolean {
  const p = (pathName ?? "").trim().toLowerCase();
  return (
    p === "/revit/set-parameter" ||
    p === "/revit/update-parameter-by-query" ||
    p === "/revit/change-element-type" ||
    p === "/revit/duplicate-type-and-swap-instance" ||
    p === "/revit/set-type-parameters" ||
    p === "/revit/sync-connected-sizes" ||
    p === "/revit/resize-duct-run" ||
    p === "/revit/resize-ducts-by-scope" ||
    p === "/revit/resize-ducts-in-room" ||
    p === "/revit/resize-ductwork-by-scope" ||
    p === "/revit/edit-mep-route-elements" ||
    p === "/revit/reroute-mep-route-segment" ||
    p === "/revit/move-elements" ||
    p === "/revit/rotate-elements" ||
    p === "/revit/delete"
  );
}

function isMepRouteCreationPath(pathName: string): boolean {
  const p = (pathName ?? "").trim().toLowerCase();
  return p === "/revit/mep-route-workflow" || p === "/revit/mep-branch-network-workflow" || p === "/revit/edit-mep-route-elements" || p === "/revit/reroute-mep-route-segment" || p === "/revit/create-mep-route" || p === "/revit/create-duct" || p === "/revit/connect-mep-branch";
}

function dimensionFieldToInches(key: string, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const k = (key ?? "").toLowerCase();
  if (/\b(ft|feet)\b|ft$|feet$/.test(k)) return value * 12;
  if (value > 0 && value <= 3 && !/\b(in|inch|inches)\b|in$|inch$|inches$/.test(k)) return value * 12;
  return value;
}

function collectMepActionSizes(node: unknown, out: Array<{ width_in: number; height_in: number; size_text: string }>, depth = 0): void {
  if (depth > 6 || out.length >= 20) return;
  if (typeof node === "string") {
    const parsed = parseRectangularMepSize(node);
    if (parsed) out.push(parsed);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectMepActionSizes(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const value of Object.values(record)) collectMepActionSizes(value, out, depth + 1);

  const entries = Object.entries(record);
  const widthEntry = entries.find(([key]) => /\b(width|ductwidth|widthin|widthinches|widthft|wide)\b/i.test(key));
  const heightEntry = entries.find(([key]) => /\b(height|ductheight|heightin|heightinches|heightft|high)\b/i.test(key));
  if (!widthEntry || !heightEntry) return;
  const width = dimensionFieldToInches(widthEntry[0], widthEntry[1]);
  const height = dimensionFieldToInches(heightEntry[0], heightEntry[1]);
  if (width === null || height === null) return;
  out.push({ width_in: width, height_in: height, size_text: normalizeMepSizeText(width, height) });
}

function mepSizesMatch(spec: MepRedlineSpec, candidate: { width_in: number; height_in: number }): boolean {
  return Math.abs(candidate.width_in - spec.width_in) < 0.05 && Math.abs(candidate.height_in - spec.height_in) < 0.05;
}

function mepActionSizeMismatch(action: ActionCall, spec: MepRedlineSpec): boolean {
  const sizes: Array<{ width_in: number; height_in: number; size_text: string }> = [];
  collectMepActionSizes(action.body, sizes);
  if (sizes.length === 0) return isMepRouteCreationPath(action.path);
  return !sizes.some((size) => mepSizesMatch(spec, size));
}

function buildMepRedlineActionGuardResponse(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
  actions: ActionCall[];
}): ChatResponse | null {
  if (!isRedlineFocusedTurn(args.req)) return null;
  const spec = extractMepRedlineSpec(args.req, args.workbenchResults);
  if (!spec || spec.kind !== "duct") return null;
  const writes = args.actions.filter((action) => {
    if (action.method !== "POST") return false;
    return pathLooksWrite(action.path) || isExistingMepModificationPath(action.path) || isMepRouteCreationPath(action.path);
  });
  if (writes.length === 0) return null;

  const blocked = writes.find((action) => {
    if (spec.operation === "create" && isExistingMepModificationPath(action.path)) return true;
    if ((isExistingMepModificationPath(action.path) || isMepRouteCreationPath(action.path)) && mepActionSizeMismatch(action, spec)) return true;
    return false;
  });
  if (!blocked) return null;

  const pathName = (blocked.path ?? "").trim() || "the proposed write";
  const room = spec.room_number ? ` in/near room ${spec.room_number}` : "";
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `I stopped before writing because the authoritative redline annotation reads "${spec.size_text} supply duct"${room}. ` +
      `The proposed action (${pathName}) would ${isExistingMepModificationPath(pathName) ? "modify an existing duct/element" : "use a missing or mismatched duct size"}, which conflicts with the markup. ` +
      `I’ll continue through the MEP duct route creation workflow using ${spec.size_text} as the required size.`,
    actions: [
      {
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/tool-search",
        body: {
          query: `MEP redline create ${spec.size_text} supply duct route workflow${spec.room_number ? ` room ${spec.room_number}` : ""}`
        }
      }
    ]
  };
}

function extractMepRedlineViewIdFromActions(actions: ActionCall[]): number | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i];
    const p = (action?.path ?? "").trim().toLowerCase();
    if (p !== "/revit/export-view-frame" && p !== "/revit/export-visible-elements" && p !== "/revit/resolve-mep-routing-context") continue;
    const body = action.body && typeof action.body === "object" && !Array.isArray(action.body)
      ? (action.body as Record<string, unknown>)
      : null;
    const viewId = toFiniteInt(body?.viewId ?? body?.view_id);
    if (viewId !== null && viewId > 0) return viewId;
  }
  return null;
}

function extractMepRedlineViewIdFromToolResults(toolResults: ToolResult[]): number | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const result = toolResults[i];
    if (!result || (result.status ?? "").trim().toLowerCase() !== "done") continue;
    const p = (result.path ?? "").trim().toLowerCase();
    const data = result.result_json && typeof result.result_json === "object"
      ? (result.result_json as Record<string, unknown>)
      : null;
    if (!data) continue;

    if (p === "/revit/sheets") {
      const placedViews = Array.isArray(data.placedViews) ? (data.placedViews as Array<Record<string, unknown>>) : [];
      for (const placed of placedViews) {
        const viewId = toFiniteInt(placed?.viewId ?? placed?.view_id);
        if (viewId !== null && viewId > 0) return viewId;
      }
      const viewportGeometry = Array.isArray(data.viewportGeometry) ? (data.viewportGeometry as Array<Record<string, unknown>>) : [];
      for (const viewport of viewportGeometry) {
        const viewId = toFiniteInt(viewport?.viewId ?? viewport?.view_id);
        if (viewId !== null && viewId > 0) return viewId;
      }
    }

    if (p === "/revit/export-view-frame" || p === "/revit/export-visible-elements") {
      const viewId = toFiniteInt(data.viewId ?? data.view_id);
      if (viewId !== null && viewId > 0) return viewId;
    }
  }
  return null;
}

function bestMepRedlineViewId(
  req: ChatRequest,
  workbenchResults: WorkbenchActionResult[],
  actions: ActionCall[] = [],
  toolResults: ToolResult[] = []
): number | null {
  const hints = dedupeViewportPickHints([
    ...extractViewportPickHintsFromWorkbench(workbenchResults),
    ...getPersistedViewportPickHints(req.session_id)
  ]);
  const bestHint = hints
    .filter((hint) => hint && Number.isFinite(hint.view_id) && hint.view_id > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (bestHint) return Math.round(bestHint.view_id);
  const actionViewId = extractMepRedlineViewIdFromActions(actions);
  if (actionViewId !== null && actionViewId > 0) return actionViewId;
  const toolResultViewId = extractMepRedlineViewIdFromToolResults(toolResults);
  if (toolResultViewId !== null && toolResultViewId > 0) return toolResultViewId;
  const activeViewId = extractActiveModelViewIdFromContext(req.context);
  return activeViewId !== null && activeViewId > 0 ? activeViewId : null;
}

function mepRedlineActionsAlreadyOnRoutePath(actions: ActionCall[]): boolean {
  return actions.some((action) => {
    const p = (action.path ?? "").trim().toLowerCase();
    return p === "/revit/resolve-mep-routing-context" || isMepRouteCreationPath(p);
  });
}

function actionLooksLikeWrongMepExistingDuctSearch(action: ActionCall): boolean {
  const p = (action.path ?? "").trim().toLowerCase();
  if (p !== "/revit/tool-search" || !action.body || typeof action.body !== "object" || Array.isArray(action.body)) return false;
  const query = typeof (action.body as Record<string, unknown>).query === "string"
    ? ((action.body as Record<string, unknown>).query as string).toLowerCase()
    : "";
  return /\bduct\b/.test(query) && /\b(resize|modify|change|set\s+parameter|width|height|diameter|segment)\b/.test(query);
}

function latestDuctSpatialScopeHadNoMatches(toolResults: ToolResult[]): boolean {
  const result = getLatestToolResult(toolResults, "/revit/ducts-by-spatial-scope");
  if (!result || (result.status ?? "").trim().toLowerCase() !== "done") return false;
  const res = result.result_json && typeof result.result_json === "object" ? (result.result_json as Record<string, unknown>) : null;
  if (!res) return false;
  const elementIds = Array.isArray(res.elementIds) ? res.elementIds : [];
  const elements = Array.isArray(res.elements) ? res.elements : [];
  const counts = res.counts && typeof res.counts === "object" ? (res.counts as Record<string, unknown>) : null;
  const matchedCount = toFiniteInt(counts?.matchedCount) ?? toFiniteInt(res.matchedCount);
  return elementIds.length === 0 && elements.length === 0 && (matchedCount === null || matchedCount === 0);
}

function userTextRequestsStatusOnlyNoMepWrite(req: ChatRequest): boolean {
  const text = getRecentUserTextForRedline(req);
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  const statusOnly =
    /\b(concise\s+status|status\s*:|provide\s+(?:a\s+)?status|were\s+any\s+revit\s+changes\s+applied|did\s+you\s+find)\b/.test(lower) ||
    /\bdo\s+not\s+make\s+additional\s+discovery\s+calls\b/.test(lower);
  if (!statusOnly) return false;
  const explicitWrite = /\b(implement|apply|create|add|place|draw|route)\b/.test(lower);
  return !explicitWrite;
}

function userTextRequestsMepRouteApply(req: ChatRequest): boolean {
  const lower = getRecentUserTextForRedline(req).toLowerCase();
  if (!lower.trim()) return false;
  if (/\b(dry[\s-]*run|preview|do\s+not\s+(?:apply|write|create|place)|no\s+model\s+change)\b/.test(lower)) return false;
  return (
    /\b(implement|apply|create|add|place|draw|pick\s+up)\b/.test(lower) &&
    /\b(duct|supply\s+air|supply\s+duct|12\s*["']?\s*[x×]\s*10|12x10)\b/.test(lower)
  );
}

function latestPickPointXy(toolResults: ToolResult[]): { x: number; y: number } | null {
  const result = getLatestToolResult(toolResults, "/revit/pick-at-pixel");
  const data = result?.result_json && typeof result.result_json === "object" ? (result.result_json as Record<string, unknown>) : null;
  const raw = Array.isArray(data?.pickPointXyz) ? data.pickPointXyz : null;
  if (!raw || raw.length < 2) return null;
  const x = toFiniteNumber(raw[0]);
  const y = toFiniteNumber(raw[1]);
  if (x === null || y === null) return null;
  return { x, y };
}

function latestResolvedMepLevelName(toolResults: ToolResult[]): string | null {
  const result = getLatestToolResult(toolResults, "/revit/resolve-mep-routing-context");
  const data = result?.result_json && typeof result.result_json === "object" ? (result.result_json as Record<string, unknown>) : null;
  const level = data?.level && typeof data.level === "object" ? (data.level as Record<string, unknown>) : null;
  const name = typeof level?.name === "string" ? level.name.trim() : "";
  return name || null;
}

function buildMepRoutePointsFromAnchor(anchor: { x: number; y: number }): Array<Record<string, number>> {
  // The PDF redline is an L-shaped route: west-to-east, then north into the Unit 405 chase.
  // Omit Z so the route workflow uses the resolved L4 duct elevation instead of the 2D view plane.
  const westToBendFt = 16;
  const bendToEastFt = 12;
  const northLegFt = 12;
  return [
    { x: anchor.x - westToBendFt, y: anchor.y },
    { x: anchor.x + bendToEastFt, y: anchor.y },
    { x: anchor.x + bendToEastFt, y: anchor.y + northLegFt }
  ];
}

function buildMepRedlineRouteWorkflowResponse(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
  actions: ActionCall[];
  toolResults: ToolResult[];
  spec: MepRedlineSpec;
}): ChatResponse | null {
  if (!hasSuccessfulToolPath(args.toolResults, "/revit/resolve-mep-routing-context")) return null;
  const anchor = latestPickPointXy(args.toolResults);
  if (!anchor) return null;
  const viewId = bestMepRedlineViewId(args.req, args.workbenchResults, args.actions, args.toolResults);
  if (!viewId) return null;
  const roomNumber = args.spec.room_number ?? extractSpatialRoomNumber(buildRedlineSemanticCorpus(args.req, args.workbenchResults));
  const apply = userTextRequestsMepRouteApply(args.req);
  const levelName = latestResolvedMepLevelName(args.toolResults);
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      apply
        ? `I have enough bounded context to place the ${args.spec.size_text} Supply Air duct as an unconnected L-shaped route on L4, using the redline anchor and resolved routing elevation.`
        : `I have enough bounded context to dry-run the ${args.spec.size_text} Supply Air duct route from the redline anchor before applying it.`,
    actions: [
      {
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/mep-route-workflow",
        body: {
          kind: "duct",
          viewId,
          visualViewId: viewId,
          ...(roomNumber ? { roomNumber } : {}),
          ...(levelName ? { levelName } : {}),
          systemType: "Supply Air",
          ductSize: args.spec.size_text,
          sizePolicy: "explicit_required",
          elevationPolicy: "resolve_context_default",
          routingMode: "polyline",
          connectSegments: true,
          verify: true,
          points: buildMepRoutePointsFromAnchor(anchor),
          apply,
          visualVerify: apply,
          imageSize: 2200,
          focusPaddingFt: 8
        }
      }
    ]
  };
}

function buildMepRedlineRouteRecoveryResponse(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
  actions: ActionCall[];
  toolResults: ToolResult[];
}): ChatResponse | null {
  if (!isRedlineFocusedTurn(args.req)) return null;
  if (userTextRequestsStatusOnlyNoMepWrite(args.req)) return null;
  const spec = extractMepRedlineSpec(args.req, args.workbenchResults);
  if (!spec || spec.kind !== "duct" || spec.operation !== "create") return null;
  if (mepRedlineActionsAlreadyOnRoutePath(args.actions)) return null;

  const hasNoActions = args.actions.length === 0;
  const allActionsReadOnly = args.actions.length > 0 && args.actions.every((action) => action.method !== "POST" || !pathLooksWrite(action.path));
  const wrongExistingDuctSearch = args.actions.some(actionLooksLikeWrongMepExistingDuctSearch);
  const noExistingSupplyDuctsFound = latestDuctSpatialScopeHadNoMatches(args.toolResults);
  const message = (args.actions.length === 0 ? "" : args.actions.map((a) => a.path).join(" ")) + "\n" + getRecentUserTextForRedline(args.req);
  const asksForExistingTarget = /\b(exact|matching|corresponding|selected|target)\b[\s\S]{0,80}\b(duct|segment|run|element)\b/i.test(message);

  if (!hasNoActions && !allActionsReadOnly && !wrongExistingDuctSearch && !noExistingSupplyDuctsFound && !asksForExistingTarget) return null;

  const viewId = bestMepRedlineViewId(args.req, args.workbenchResults, args.actions, args.toolResults);
  const roomNumber = spec.room_number ?? extractSpatialRoomNumber(buildRedlineSemanticCorpus(args.req, args.workbenchResults));
  if (!viewId && !roomNumber) return null;

  const routeWorkflow = buildMepRedlineRouteWorkflowResponse({
    req: args.req,
    workbenchResults: args.workbenchResults,
    actions: args.actions,
    toolResults: args.toolResults,
    spec
  });
  if (routeWorkflow) return routeWorkflow;

  if (!hasSuccessfulToolPath(args.toolResults, "/revit/resolve-mep-routing-context")) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The PDF annotation is authoritative: "${spec.size_text} supply duct" is a new duct routing task unless an editable existing duct is explicitly identified. ` +
        "No matching editable supply duct has been established, so I’ll resolve the MEP routing context instead of asking for an existing duct target.",
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-mep-routing-context",
          body: {
            ...(viewId ? { viewId } : {}),
            ...(roomNumber ? { roomNumber } : {}),
            systemKind: "duct",
            systemClassification: "Supply",
            routingMode: "above_ceiling",
            dryRun: true
          }
        }
      ]
    };
  }

  if (hasSuccessfulToolPath(args.toolResults, "/revit/tool-search")) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The ${spec.size_text} supply duct redline still needs route endpoints before creation, but the route workflow has already been discovered. ` +
        "I am stopping instead of repeating tool-search/export loops; the next valid step is to resolve or provide endpoint coordinates for `/revit/mep-route-workflow`.",
      actions: []
    };
  }

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `The ${spec.size_text} supply duct redline still needs route endpoints before creation. I’ll search the MEP route workflow tool surface rather than asking for a duct to resize.`,
    actions: [
      {
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/tool-search",
        body: {
          query: `create ${spec.size_text} supply duct route workflow frame-linked points room ${roomNumber ?? ""}`.trim()
        }
      }
    ]
  };
}

function buildMepRedlineDuctScopeRecoveryResponse(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
  toolResults: ToolResult[];
  redlineTargetProfile?: { room_number?: string | null };
}): ChatResponse | null {
  const spec = extractMepRedlineSpec(args.req, args.workbenchResults);
  const roomNumber = spec?.room_number ?? args.redlineTargetProfile?.room_number ?? null;
  if (spec?.kind !== "duct" || !roomNumber) return null;
  if (hasSuccessfulToolPath(args.toolResults, "/revit/ducts-by-spatial-scope")) return null;
  if (countToolPath(args.toolResults, "/revit/ducts-by-spatial-scope") >= 2) return null;

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `I have duct redline intent for room/space ${roomNumber}, so I’ll query the ductwork spatial scope before any generic hosted-device recovery.`,
    actions: [
      {
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/ducts-by-spatial-scope",
        body: {
          roomNumber,
          systemClassification: "Supply",
          verticalScope: "room+plenum",
          roomMode: "auto",
          includeCategories: ["Ducts", "Duct Fittings", "Air Terminals"],
          includeConnectedOutsideRoom: true,
          limit: 80
        }
      }
    ]
  };
}

export function __testOnlyBuildMepRedlineActionGuardResponse(args: {
  req: Partial<ChatRequest>;
  workbenchResults?: WorkbenchActionResult[];
  actions: ActionCall[];
}): ChatResponse | null {
  return buildMepRedlineActionGuardResponse({
    req: {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: args.req.session_id ?? randomUUID(),
      message_id: args.req.message_id ?? "test:mep-redline-guard",
      user_text: args.req.user_text ?? "",
      tool_results: args.req.tool_results,
      user_attachments: args.req.user_attachments,
      context: args.req.context
    },
    workbenchResults: args.workbenchResults ?? [],
    actions: args.actions
  });
}

export function __testOnlyBuildMepRedlineDuctScopeRecoveryResponse(args: {
  req: Partial<ChatRequest>;
  workbenchResults?: WorkbenchActionResult[];
  toolResults?: ToolResult[];
  redlineTargetProfile?: { room_number?: string | null };
}): ChatResponse | null {
  return buildMepRedlineDuctScopeRecoveryResponse({
    req: {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: args.req.session_id ?? randomUUID(),
      message_id: args.req.message_id ?? "test:mep-redline-duct-scope-recovery",
      user_text: args.req.user_text ?? "",
      tool_results: args.req.tool_results,
      user_attachments: args.req.user_attachments,
      context: args.req.context
    },
    workbenchResults: args.workbenchResults ?? [],
    toolResults: args.toolResults ?? [],
    redlineTargetProfile: args.redlineTargetProfile
  });
}

export function __testOnlyBuildMepRedlineRouteRecoveryResponse(args: {
  req: Partial<ChatRequest>;
  workbenchResults?: WorkbenchActionResult[];
  actions?: ActionCall[];
  toolResults?: ToolResult[];
}): ChatResponse | null {
  return buildMepRedlineRouteRecoveryResponse({
    req: {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: args.req.session_id ?? randomUUID(),
      message_id: args.req.message_id ?? "test:mep-redline-route-recovery",
      user_text: args.req.user_text ?? "",
      tool_results: args.req.tool_results,
      user_attachments: args.req.user_attachments,
      context: args.req.context
    },
    workbenchResults: args.workbenchResults ?? [],
    actions: args.actions ?? [],
    toolResults: args.toolResults ?? []
  });
}

function inferRedlineTargetingProfileFromText(
  recentUserText: string,
  geminiIntents: GeminiIntentHint[],
  annotationRegionHints: AnnotationRegionHint[]
): RedlineTargetingProfile {
  const lower = recentUserText.toLowerCase();
  const deleteRx = /\b(delete|remove|demo|demolish|erase|omit|strike|cross[\s-]*out|x[\s-]*out|take\s+out)\b/i;
  const deleteLike =
    deleteRx.test(recentUserText) ||
    geminiIntents.some((it) => deleteRx.test(`${it.intent ?? ""} ${it.proposed_action ?? ""}`)) ||
    annotationRegionHints.some((h) => !!h.is_delete_like);
  const spatialTerms = inferSpatialRedlineTerms(recentUserText);
  const spatiallyAnchored = spatialTerms.length > 0;
  const requestedPanelCircuit = extractExplicitRequestedPanelCircuit(recentUserText);
  const panelCircuitRoom = inferRoomNumberFromRequestedPanelCircuit(requestedPanelCircuit);
  const roomNumber = extractSpatialRoomNumber(recentUserText) ?? panelCircuitRoom;
  const wallSide = extractSpatialWallSide(recentUserText);

  const baseParameterNames = [
    "Text",
    "Comments",
    "Type Comments",
    "Description",
    "Mark",
    "Type Name",
    "Family",
    "Family and Type",
    "Sheet Number",
    "Sheet Name"
  ];

  if (/\b(receptacle|receptacles|outlet|outlets|gfci|gfi|duplex|switch|switches)\b/.test(lower)) {
    return {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: spatiallyAnchored ? "spatial electrical-device" : "electrical-device",
      resolve_only: !deleteLike,
      parameter_names: [...baseParameterNames, "Type Mark"],
      spatial_terms: spatialTerms,
      region_padding_ft: spatiallyAnchored ? 0.08 : 0.035,
      room_number: roomNumber,
      spatial_side: wallSide.side,
      spatial_side_source: wallSide.source
    };
  }

  if (/\b(light|lights|lighting|fixture|fixtures|luminaire|luminaires)\b/.test(lower)) {
    return {
      categories: ["OST_LightingFixtures", "OST_LightingDevices"],
      pick_preference: "modelGeometry",
      scope_label: spatiallyAnchored ? "spatial lighting-fixture" : "lighting-fixture",
      resolve_only: !deleteLike,
      parameter_names: [...baseParameterNames, "Type Mark"],
      spatial_terms: spatialTerms,
      region_padding_ft: spatiallyAnchored ? 0.08 : 0.035,
      room_number: roomNumber,
      spatial_side: wallSide.side,
      spatial_side_source: wallSide.source
    };
  }

  if (/\b(door|doors|window|windows|wall|walls|duct|ducts|diffuser|diffusers|grille|grilles)\b/.test(lower)) {
    return {
      categories: [],
      pick_preference: "modelGeometry",
      scope_label: spatiallyAnchored ? "spatial model" : "model",
      resolve_only: !deleteLike,
      parameter_names: baseParameterNames,
      spatial_terms: spatialTerms,
      region_padding_ft: spatiallyAnchored ? 0.08 : 0.035,
      room_number: roomNumber,
      spatial_side: wallSide.side,
      spatial_side_source: wallSide.source
    };
  }

  return {
    categories: DEFAULT_REDLINE_ANNOTATION_CATEGORIES.slice(),
    pick_preference: "annotation",
    scope_label: spatiallyAnchored ? "spatial annotation" : "annotation",
    resolve_only: !deleteLike,
    parameter_names: baseParameterNames,
    spatial_terms: spatialTerms,
    region_padding_ft: spatiallyAnchored ? 0.06 : 0.035,
    room_number: roomNumber,
    spatial_side: wallSide.side,
    spatial_side_source: wallSide.source
  };
}


function inferSpatialRedlineTerms(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const terms: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\b(north|south|east|west|left|right|upper|lower|top|bottom|center|middle)\b/i, "directional"],
    [/\b(room|space|corridor|hall|lobby|core|zone|wing|bay|grid)\b/i, "zone"],
    [/\b(near|adjacent|next to|between|closest|around|along)\b/i, "adjacency"]
  ];
  for (const [rx, label] of patterns) {
    if (rx.test(lower)) terms.push(label);
  }
  return terms;
}

function extractSpatialRoomNumber(text: string): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const correctionPatterns = [
    /\b(?:redline|mark|marked|target|intended|requested|correct|actual|actually|should\s+be|supposed\s+to\s+be)\b[\s\S]{0,120}?\b(?:unit|suite|room|rm|space)\s*(?:number|no\.?|#)?\s*([a-z]?\d{2,6}[a-z]?)\b/i,
    /\b(?:unit|suite|room|rm|space)\s*(?:number|no\.?|#)?\s*([a-z]?\d{2,6}[a-z]?)\b[\s\S]{0,80}?\b(?:not|wrong|incorrect)\b/i
  ];
  for (const rx of correctionPatterns) {
    const match = raw.match(rx);
    const value = match?.[1]?.trim();
    if (!value) continue;
    return value.toUpperCase();
  }
  const patterns = [
    /(?:^|[^a-z0-9])(?:unit|suite)[-_\s#]*(\d{2,6}[a-z]?)(?=$|[^a-z0-9])/i,
    /(?:^|[^a-z0-9])(\d{2,6}[a-z]?)[-_\s]*(?:unit|suite)(?=$|[^a-z0-9])/i,
    /\b(?:room|rm|space)\s*(?:number|no\.?|#)?\s*([a-z]?\d[\w.-]{0,15})\b/i,
    /\b([a-z]?\d[\w.-]{0,15})\s*(?:room|rm|space)\b/i
  ];
  for (const rx of patterns) {
    const match = raw.match(rx);
    const value = match?.[1]?.trim();
    if (!value) continue;
    return value.toUpperCase();
  }
  return null;
}

function extractRedlineOcrSpatialRoomNumber(text: string): string | null {
  const direct = extractSpatialRoomNumber(text);
  if (direct) return direct;

  const raw = (text ?? "").trim().toUpperCase();
  if (!raw) return null;

  const contextMatch = raw.match(/\b(?:LIVE\s*\/?\s*WORK|UNIT|ROOM|RM|SPACE|SUITE|APT|APARTMENT)\b[\s\S]{0,140}?\b(\d{3,5}[A-Z]?)\b/);
  if (contextMatch?.[1]) return contextMatch[1].trim().toUpperCase();

  if (!/\b(?:LIVE\s*\/?\s*WORK|UNIT|ROOM|RM|SPACE|SUITE|APT|APARTMENT)\b/.test(raw)) return null;

  const candidates: string[] = [];
  for (const match of raw.matchAll(/\b(\d{3,5}[A-Z]?)\b/g)) {
    const value = match[1]?.trim().toUpperCase();
    if (!value) continue;
    const previous = raw[Math.max(0, (match.index ?? 0) - 1)] ?? "";
    if (/[A-Z]/.test(previous)) continue;
    candidates.push(value);
  }

  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function normalizeSpatialWallSide(raw: string): "left" | "right" | "top" | "bottom" | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "left" || value === "west") return "left";
  if (value === "right" || value === "east") return "right";
  if (value === "top" || value === "upper" || value === "north") return "top";
  if (value === "bottom" || value === "lower" || value === "south") return "bottom";
  return null;
}

function extractSpatialWallSide(text: string): { side: "left" | "right" | "top" | "bottom" | null; source: string | null } {
  const raw = (text ?? "").trim();
  if (!raw) return { side: null, source: null };
  const patterns = [
    /\b(north|south|east|west|left|right|top|bottom|upper|lower)\s*\/\s*(north|south|east|west|left|right|top|bottom|upper|lower)\b/i,
    /\b(north|south|east|west|left|right|top|bottom|upper|lower)\s+wall\b/i,
    /\b(north|south|east|west|left|right|top|bottom|upper|lower)\s+side\b/i,
    /\b(?:on|along|at|near)\s+the\s+(north|south|east|west|left|right|top|bottom|upper|lower)\b/i
  ];
  for (const rx of patterns) {
    const match = raw.match(rx);
    const sources = [match?.[1], match?.[2]].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    const source = sources.map((v) => v.trim().toLowerCase()).find((v) => !!normalizeSpatialWallSide(v)) ?? "";
    const side = normalizeSpatialWallSide(source);
    if (!side) continue;
    return { side, source };
  }
  return { side: null, source: null };
}

function extractRequestedRoomSideRaw(room: Record<string, unknown> | null, res: Record<string, unknown>): string | null {
  const raw =
    (typeof room?.requestedSide === "string" ? room.requestedSide.trim().toLowerCase() : "") ||
    (typeof room?.requestedRoomSide === "string" ? room.requestedRoomSide.trim().toLowerCase() : "") ||
    (typeof res.requestedSide === "string" ? res.requestedSide.trim().toLowerCase() : "") ||
    (typeof res.requestedRoomSide === "string" ? res.requestedRoomSide.trim().toLowerCase() : "") ||
    (typeof res.requested_room_side === "string" ? res.requested_room_side.trim().toLowerCase() : "") ||
    "";
  return raw || null;
}

function extractLatestRedlineSpatialTargetingFromToolResults(toolResults: ToolResult[]): {
  room_number: string | null;
  spatial_side: "left" | "right" | "top" | "bottom" | null;
  spatial_side_source: string | null;
} {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r || !r.result_json || typeof r.result_json !== "object") continue;
    const pathName = (r.path ?? "").trim().toLowerCase();
    const res = r.result_json as Record<string, unknown>;

    if (pathName === "/revit/resolve-room-wall" && (r.status ?? "").trim().toLowerCase() === "done") {
      const room = res.room && typeof res.room === "object" ? (res.room as Record<string, unknown>) : null;
      const roomNumber =
        (typeof room?.number === "string" ? room.number.trim().toUpperCase() : "") ||
        (typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "") ||
        null;
      const sideSourceRaw = extractRequestedRoomSideRaw(room, res);
      const spatialSide = sideSourceRaw ? normalizeSpatialWallSide(sideSourceRaw) : null;
      if (roomNumber || spatialSide || sideSourceRaw) {
        return {
          room_number: roomNumber,
          spatial_side: spatialSide,
          spatial_side_source: sideSourceRaw
        };
      }
    }

    if (pathName === "/revit/room-contents" && (r.status ?? "").trim().toLowerCase() === "done") {
      const resolvedSpatial =
        res.resolvedSpatial && typeof res.resolvedSpatial === "object"
          ? (res.resolvedSpatial as Record<string, unknown>)
          : null;
      const roomNumber =
        (typeof res.roomNumber === "string" ? res.roomNumber.trim().toUpperCase() : "") ||
        (typeof resolvedSpatial?.number === "string" ? resolvedSpatial.number.trim().toUpperCase() : "") ||
        null;
      if (roomNumber) {
        return {
          room_number: roomNumber,
          spatial_side: null,
          spatial_side_source: null
        };
      }
    }

    if (pathName === "/revit/rooms" && (r.status ?? "").trim().toLowerCase() === "done") {
      const candidates = Array.isArray(res)
        ? (res as Array<Record<string, unknown>>)
        : [res];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const roomNumber =
          (typeof candidate.number === "string" ? candidate.number.trim().toUpperCase() : "") ||
          (typeof candidate.roomNumber === "string" ? candidate.roomNumber.trim().toUpperCase() : "") ||
          null;
        if (roomNumber) {
          return {
            room_number: roomNumber,
            spatial_side: null,
            spatial_side_source: null
          };
        }
      }
    }
  }

  return {
    room_number: null,
    spatial_side: null,
    spatial_side_source: null
  };
}

export function __testOnlyExtractLatestRedlineSpatialTargetingFromToolResults(toolResults: ToolResult[]): {
  room_number: string | null;
  spatial_side: "left" | "right" | "top" | "bottom" | null;
  spatial_side_source: string | null;
} {
  return extractLatestRedlineSpatialTargetingFromToolResults(toolResults);
}

function hydrateRedlineTargetingProfile(args: {
  sessionId: string;
  profile: RedlineTargetingProfile;
  toolResults: ToolResult[];
}): RedlineTargetingProfile {
  const recovered = extractLatestRedlineSpatialTargetingFromToolResults(args.toolResults);
  const persisted = getPersistedRedlineSpatialTargeting(args.sessionId);
  const roomNumber = args.profile.room_number ?? recovered.room_number ?? persisted.room_number ?? null;
  const spatialSideSource =
    args.profile.spatial_side_source ??
    recovered.spatial_side_source ??
    persisted.spatial_side_source ??
    null;
  const spatialSide =
    args.profile.spatial_side ??
    recovered.spatial_side ??
    persisted.spatial_side ??
    (spatialSideSource ? normalizeSpatialWallSide(spatialSideSource) : null);
  return {
    ...args.profile,
    room_number: roomNumber,
    spatial_side: spatialSide,
    spatial_side_source: spatialSideSource
  };
}

function inferRedlineTargetingProfile(
  req: ChatRequest,
  geminiIntents: GeminiIntentHint[],
  annotationRegionHints: AnnotationRegionHint[]
): RedlineTargetingProfile {
  return inferRedlineTargetingProfileFromText(getRecentUserTextForRedline(req), geminiIntents, annotationRegionHints);
}

export function __testOnlyInferRedlineTargetingProfile(args: {
  userText: string;
  geminiIntents?: Array<Partial<GeminiIntentHint>>;
  annotationRegionHints?: Array<Partial<AnnotationRegionHint>>;
}): RedlineTargetingProfile {
  const testSessionId = randomUUID();
  const req = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: testSessionId,
    message_id: `${testSessionId}:message`,
    user_text: typeof args.userText === "string" ? args.userText : ""
  } satisfies ChatRequest;
  const geminiIntents: GeminiIntentHint[] = Array.isArray(args.geminiIntents)
    ? args.geminiIntents.map((it) => ({
        region_index: Number.isFinite(it?.region_index as number) ? Number(it?.region_index) : null,
        target_type: typeof it?.target_type === "string" ? it.target_type : "unknown",
        intent: typeof it?.intent === "string" ? it.intent : "",
        proposed_action: typeof it?.proposed_action === "string" ? it.proposed_action : "",
        confidence: Number.isFinite(it?.confidence as number) ? Number(it?.confidence) : 0.6
      }))
    : [];
  const annotationRegionHints: AnnotationRegionHint[] = Array.isArray(args.annotationRegionHints)
    ? args.annotationRegionHints
        .map((it) => ({
          region_index: Number.isFinite(it?.region_index as number) ? Number(it?.region_index) : 1,
          subtype: typeof it?.subtype === "string" ? it.subtype : "unknown",
          is_delete_like: !!it?.is_delete_like,
          contents: typeof it?.contents === "string" ? it.contents : ""
        }))
        .filter((it) => Number.isFinite(it.region_index) && it.region_index > 0)
    : [];
  return inferRedlineTargetingProfile(req, geminiIntents, annotationRegionHints);
}

export function __testOnlyBuildSpatialPlacementPreviewPlan(args: {
  userText: string;
  spatialViewId: number;
  viewportHints: Array<Partial<ViewportPickHint>>;
  frame: {
    frame_id?: string;
    width_px: number;
    height_px: number;
    top_left_xyz: [number, number, number] | null;
    top_right_xyz: [number, number, number] | null;
    bottom_left_xyz: [number, number, number] | null;
  } | null;
    placementContext: {
      element_id?: number | null;
      host_element_id?: number | null;
      place_on_host_body?: Record<string, unknown> | null;
      create_similar_body?: Record<string, unknown> | null;
    center?: [number, number, number] | null;
    insertion_point?: [number, number, number] | null;
    wall_projected_point?: [number, number, number] | null;
    wall_tangent?: [number, number, number] | null;
    placement_host_category?: string | null;
    placement_host_built_in_category?: string | null;
    room_number?: string | null;
    requested_room_side?: string | null;
    requested_room_wall_host_ids?: number[];
      supported_host?: boolean | null;
      source_host_supported?: boolean | null;
      host_support_reason?: string | null;
      orientation_rotation_radians?: number | null;
      host_local_frame_basis?: string | null;
      host_chainage_ft?: number | null;
      host_normalized_chainage?: number | null;
      host_curve_length_ft?: number | null;
      host_orientation_relative_radians?: number | null;
      electrical_circuit_label?: string | null;
    } | null;
  imageMarkHint?: Partial<ImageMarkHint> | null;
}): { path: string; body: Record<string, unknown>; requested_count: number; heuristic: boolean } | null {
  return buildSpatialPlacementPreviewPlan({
    userText: args.userText,
    spatialViewId: args.spatialViewId,
    viewportHints: Array.isArray(args.viewportHints)
      ? args.viewportHints
          .map((hint) => ({
            view_id: toFiniteInt(hint.view_id) ?? args.spatialViewId,
            normalized_x: toFiniteNumber(hint.normalized_x) ?? 0.5,
            normalized_y: toFiniteNumber(hint.normalized_y) ?? 0.5,
            score: toFiniteNumber(hint.score) ?? 0.5,
            source: hint.source ?? "view_alignment",
            frame_aligned: hint.frame_aligned !== false
          }))
          .filter((hint) => hint.view_id > 0)
      : [],
    frame: args.frame
      ? {
          frame_id: args.frame.frame_id ?? "__test_frame__",
          width_px: args.frame.width_px,
          height_px: args.frame.height_px,
          top_left_xyz: args.frame.top_left_xyz,
          top_right_xyz: args.frame.top_right_xyz,
          bottom_left_xyz: args.frame.bottom_left_xyz
        }
      : null,
    placementContext: args.placementContext
        ? {
            element_id: args.placementContext.element_id ?? null,
            host_element_id: args.placementContext.host_element_id ?? null,
            place_on_host_body: args.placementContext.place_on_host_body ?? null,
            create_similar_body: args.placementContext.create_similar_body ?? null,
            center: args.placementContext.center ?? null,
            insertion_point: args.placementContext.insertion_point ?? null,
            wall_projected_point: args.placementContext.wall_projected_point ?? null,
            wall_tangent: args.placementContext.wall_tangent ?? null,
            placement_host_category: args.placementContext.placement_host_category ?? null,
            placement_host_built_in_category: args.placementContext.placement_host_built_in_category ?? null,
            room_number: args.placementContext.room_number ?? null,
            requested_room_side:
              typeof args.placementContext.requested_room_side === "string" && args.placementContext.requested_room_side.trim()
                ? args.placementContext.requested_room_side.trim().toLowerCase()
                : null,
            requested_room_wall_host_ids: Array.isArray(args.placementContext.requested_room_wall_host_ids)
              ? args.placementContext.requested_room_wall_host_ids
                  .map((id) => toFiniteInt(id))
                  .filter((id): id is number => id !== null && id > 0)
              : [],
            supported_host: args.placementContext.supported_host !== false,
            source_host_supported:
              typeof args.placementContext.source_host_supported === "boolean"
                ? args.placementContext.source_host_supported
                : null,
            host_support_reason: args.placementContext.host_support_reason ?? null,
            orientation_rotation_radians: args.placementContext.orientation_rotation_radians ?? null,
            host_local_frame_basis: args.placementContext.host_local_frame_basis ?? null,
            host_chainage_ft: args.placementContext.host_chainage_ft ?? null,
            host_normalized_chainage: args.placementContext.host_normalized_chainage ?? null,
            host_curve_length_ft: args.placementContext.host_curve_length_ft ?? null,
            host_orientation_relative_radians: args.placementContext.host_orientation_relative_radians ?? null,
            electrical_circuit_label: args.placementContext.electrical_circuit_label ?? null
          }
        : null,
    imageMarkHint: args.imageMarkHint
      ? {
          normalized_x: toFiniteNumber(args.imageMarkHint.normalized_x) ?? 0.5,
          normalized_y: toFiniteNumber(args.imageMarkHint.normalized_y) ?? 0.5,
          side:
            typeof args.imageMarkHint.side === "string" && args.imageMarkHint.side.trim()
              ? normalizeSpatialWallSide(args.imageMarkHint.side) ?? null
              : null,
          score: toFiniteNumber(args.imageMarkHint.score) ?? 0.5,
          source: args.imageMarkHint.source,
          image_width: toFiniteNumber(args.imageMarkHint.image_width),
          image_height: toFiniteNumber(args.imageMarkHint.image_height),
          raw_normalized_x: toFiniteNumber(args.imageMarkHint.raw_normalized_x),
          raw_normalized_y: toFiniteNumber(args.imageMarkHint.raw_normalized_y),
          raw_image_width: toFiniteNumber(args.imageMarkHint.raw_image_width),
          raw_image_height: toFiniteNumber(args.imageMarkHint.raw_image_height),
          wall_local_normalized_chainage: toFiniteNumber(args.imageMarkHint.wall_local_normalized_chainage),
          wall_local_axis:
            args.imageMarkHint.wall_local_axis === "vertical" || args.imageMarkHint.wall_local_axis === "horizontal"
              ? args.imageMarkHint.wall_local_axis
              : null,
          wall_local_span_px: Array.isArray(args.imageMarkHint.wall_local_span_px)
            ? args.imageMarkHint.wall_local_span_px
            : null,
          wall_local_source: typeof args.imageMarkHint.wall_local_source === "string" ? args.imageMarkHint.wall_local_source : null
        }
      : null
  });
}

export function __testOnlyBuildInitialRedlinePreflightAction(args: {
  userText: string;
  userAttachments?: ChatRequest["user_attachments"];
  context?: Record<string, unknown>;
  rememberedRedlinePath?: string;
}): WorkbenchAction | null {
  const testSessionId = randomUUID();
  if (typeof args.rememberedRedlinePath === "string" && args.rememberedRedlinePath.trim()) {
    noteRedlineSeed(testSessionId, args.rememberedRedlinePath.trim(), null, path.basename(args.rememberedRedlinePath.trim()));
  }
  return maybeBuildInitialRedlinePreflightAction({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: testSessionId,
    message_id: `${testSessionId}:message`,
    user_text: typeof args.userText === "string" ? args.userText : "",
    ...(Array.isArray(args.userAttachments) ? { user_attachments: args.userAttachments } : {}),
    ...(args.context ? { context: args.context } : {})
  } satisfies ChatRequest);
}

export function __testOnlyIsFastElectricalPlacementRedline(args: {
  userText: string;
  userAttachments?: ChatRequest["user_attachments"];
  rememberedRedlinePath?: string;
}): boolean {
  const testSessionId = randomUUID();
  if (typeof args.rememberedRedlinePath === "string" && args.rememberedRedlinePath.trim()) {
    noteRedlineSeed(testSessionId, args.rememberedRedlinePath.trim(), null, path.basename(args.rememberedRedlinePath.trim()));
  }
  return isFastElectricalPlacementRedline({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: testSessionId,
    message_id: `${testSessionId}:message`,
    user_text: typeof args.userText === "string" ? args.userText : "",
    ...(Array.isArray(args.userAttachments) ? { user_attachments: args.userAttachments } : {})
  } satisfies ChatRequest);
}

export function __testOnlyBuildSpatialRedlineRefinementBridge(args: {
  userText: string;
  toolResults: ToolResult[];
  targetProfile: RedlineTargetingProfile;
  targetViewId: number;
  preferSheetTargeting?: boolean;
  viewportHints?: Array<Partial<ViewportPickHint>>;
}): ChatResponse | null {
  const testSessionId = randomUUID();
  return maybeBuildSpatialRedlineRefinementBridge({
    req: {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: testSessionId,
      message_id: `${testSessionId}:message`,
      user_text: typeof args.userText === "string" ? args.userText : ""
    } satisfies ChatRequest,
    toolResults: Array.isArray(args.toolResults) ? args.toolResults : [],
    targetProfile: args.targetProfile,
    targetViewId: args.targetViewId,
    preferSheetTargeting: !!args.preferSheetTargeting,
    viewportHints: Array.isArray(args.viewportHints)
      ? args.viewportHints
          .map((hint) => ({
            view_id: toFiniteInt(hint.view_id) ?? args.targetViewId,
            normalized_x: toFiniteNumber(hint.normalized_x) ?? 0.5,
            normalized_y: toFiniteNumber(hint.normalized_y) ?? 0.5,
            score: toFiniteNumber(hint.score) ?? 0.5,
            source: hint.source ?? "view_alignment",
            frame_aligned: hint.frame_aligned !== false
          }))
          .filter((hint) => hint.view_id > 0)
      : []
  });
}

function buildPlacementWorkItem(req: ChatRequest): PlacementWorkItem | null {
  const userText = getRecentUserTextForRedline(req);
  const intent = inferPlacementIntent(userText);
  if (!intent.is_addition) return null;

  const toolResults = getAugmentedToolResults(req, 80);
  const geminiIntents = getPersistedGeminiIntentHints(req.session_id);
  const annotationRegionHints = getPersistedAnnotationRegionHints(req.session_id);
  const semanticCorpus = buildRedlineSemanticCorpus(req, []);
  const targetProfile = hydrateRedlineTargetingProfile({
    sessionId: req.session_id,
    profile: inferRedlineTargetingProfileFromText(semanticCorpus, geminiIntents, annotationRegionHints),
    toolResults
  });
  const imageMarkHint = getPersistedImageMarkHint(req.session_id);
  const imageMarkedSide = normalizeSpatialWallSide(imageMarkHint?.side ?? "");
  const effectiveSpatialSide = targetProfile.spatial_side_source ?? targetProfile.spatial_side ?? imageMarkedSide;
  const effectiveCanonicalSpatialSide = targetProfile.spatial_side ?? normalizeSpatialWallSide(effectiveSpatialSide ?? "") ?? null;
  const lowRiskCategories = new Set([
    "OST_ElectricalDevices",
    "OST_ElectricalFixtures",
    "OST_LightingDevices",
    "OST_LightingFixtures",
    "OST_DuctTerminal",
    "OST_DuctAccessory",
    "OST_DuctCurves"
  ]);
  const isLowRiskPlacement =
    targetProfile.pick_preference === "modelGeometry" &&
    targetProfile.categories.some((category) => lowRiskCategories.has(category));
  if (!isLowRiskPlacement) return null;

  const viewportHints = dedupeViewportPickHints(getPersistedViewportPickHints(req.session_id).slice(0, 24));
  const activeModelViewId = extractActiveModelViewIdFromContext(req.context);
  const activeSheetViewId = extractActiveSheetViewIdFromContext(req.context);
  const resolvedRoomPlanView = extractLatestResolvedRoomPlanView(toolResults, targetProfile.room_number);
  const frameImage = extractLatestFrameImageContext(
    toolResults,
    resolvedRoomPlanView?.best_view_id ?? activeModelViewId ?? activeSheetViewId ?? undefined
  );
  const spatialViewId =
    resolvedRoomPlanView?.best_view_id ??
    frameImage?.view_id ??
    activeModelViewId ??
    activeSheetViewId ??
    viewportHints[0]?.view_id ??
    null;
  const latestCluster = extractLatestCandidateClusterSummary(toolResults);
  const latestPlacementContext = extractLatestPlacementContextSummary(toolResults);
  const roomNumber =
    targetProfile.room_number ??
    latestPlacementContext?.room_number ??
    extractLatestSpatialResolutionForNumber(toolResults, targetProfile.room_number ?? "")?.room_number ??
    null;
  const resolvedRoomWall = extractLatestResolvedRoomWallPlacementSummary({
    toolResults,
    roomNumber,
    preferredHostIds: [
      latestCluster?.recommended_host_element_id ?? null,
      latestPlacementContext?.host_element_id ?? null,
      ...(latestCluster?.host_candidate_ids ?? [])
    ]
  });
  const preferredCandidateId =
    latestCluster?.recommended_exemplar_element_id ??
    latestCluster?.target_candidate_ids[0] ??
    latestPlacementContext?.element_id ??
    null;
  const placementContext =
    extractPreferredPlacementContextSummary(toolResults, preferredCandidateId) ??
    latestPlacementContext;
  const effectivePlacementContext =
    placementContext && placementContext.supported_host
      ? placementContext
      : buildSynthesizedPlacementContext({
          exemplarElementId: preferredCandidateId,
          roomWall: resolvedRoomWall
        }) ?? placementContext;
  const frame = spatialViewId ? extractLatestFrameForView(toolResults, spatialViewId) : null;
  const placementPlan =
    spatialViewId && effectivePlacementContext
      ? buildSpatialPlacementPreviewPlan({
          userText,
          spatialViewId,
          viewportHints,
          frame,
          placementContext: effectivePlacementContext,
          imageMarkHint
        })
      : null;
  const applyPlan = buildPlacementApplyPlan(placementPlan);
  const latestPreview = extractLatestPlacementPreviewSuccess(toolResults);
  const latestApplied = extractLatestPlacementWriteSuccess(toolResults);
  const latestFailure = extractLatestPlacementWriteFailure(toolResults);
  const latestExplicitPlacementAudit =
    latestApplied && latestApplied.created_element_ids.length > 0 && hasPlacementVerificationAfter(toolResults, latestApplied.index)
      ? extractLatestPlacementAuditSummary({
          toolResults,
          afterIndex: latestApplied.index,
          elementIds: latestApplied.created_element_ids
        })
      : null;
  const latestPlacementAudit =
    latestApplied && latestApplied.created_element_ids.length > 0 && hasPlacementVerificationAfter(toolResults, latestApplied.index)
      ? summarizePlacementContextAuditAfter({
          toolResults,
          afterIndex: latestApplied.index,
          createdElementIds: latestApplied.created_element_ids,
          roomNumber,
          requireRequestedWall: !!effectiveCanonicalSpatialSide
        })
      : null;
  const explicitAuditPending =
    !!latestApplied &&
    latestApplied.created_element_ids.length > 0 &&
    hasPlacementVerificationAfter(toolResults, latestApplied.index) &&
    !latestExplicitPlacementAudit;

  let stage: PlacementWorkItemStage = "discover";
  let blockedReason: string | null = null;
  if (latestApplied && !hasPlacementVerificationAfter(toolResults, latestApplied.index)) {
    stage = "verify";
  } else if (explicitAuditPending) {
    stage = "verify";
  } else if (latestApplied && hasPlacementVerificationAfter(toolResults, latestApplied.index)) {
    const correctionBridge = spatialViewId
      ? maybeBuildVerifiedPlacementCorrectionBridge({
          toolResults,
          placementIndex: latestApplied.index,
          createdElementIds: latestApplied.created_element_ids,
          requestedCount: latestApplied.requested_count,
          roomNumber: roomNumber ?? "",
          spatialSide: effectiveCanonicalSpatialSide,
          spatialViewId,
          viewportHints,
          frame,
          placementContext: effectivePlacementContext
        })
      : null;
    const forcedRecoveryPlan =
      spatialViewId
        ? buildForcedPlacementRecoveryPlan({
            userText: getRecentUserTextForRedline(req),
            toolResults,
            placementIndex: latestApplied.index,
            createdElementIds: latestApplied.created_element_ids,
            roomNumber: roomNumber ?? "",
            spatialSide: effectiveCanonicalSpatialSide,
            spatialViewId,
            viewportHints,
            frame,
            placementContext: effectivePlacementContext
          })
        : null;
    if (correctionBridge || forcedRecoveryPlan) {
      stage = "correct";
    } else if ((latestPlacementAudit?.invalid_ids.length ?? 0) > 0 || (latestPlacementAudit?.missing_ids.length ?? 0) > 0) {
      stage = "blocked";
      blockedReason = `post_apply_mismatch:${summarizeUnresolvedPlacementIds({
        createdElementIds: latestApplied.created_element_ids,
        audit: latestPlacementAudit!
      }).join(",")}`;
    } else {
      stage = "complete";
    }
  } else if (
    latestPreview &&
    applyPlan &&
    (!latestFailure || latestFailure.index < latestPreview.index) &&
    !hasPlacementWriteSuccessAfter(toolResults, latestPreview.index)
  ) {
    stage = "apply";
  } else if (placementPlan) {
    stage = "preview";
  } else if (effectivePlacementContext && !effectivePlacementContext.supported_host) {
    stage = "blocked";
    blockedReason = effectivePlacementContext.host_support_reason ?? "unsupported_host";
  } else if (latestFailure && !placementPlan) {
    stage = "blocked";
    blockedReason = "preview_plan_unavailable";
  }

  const familyStrategy =
    effectivePlacementContext?.create_similar_body
      ? "create_similar_from_exemplar"
      : effectivePlacementContext?.place_on_host_body
        ? "place_on_host_from_source"
        : "unresolved";
  const placementBasis =
    placementPlan?.path
      ? Array.isArray(placementPlan.body.placements)
        ? (placementPlan.body.placements as Array<Record<string, unknown>>).some((row) => Array.isArray(row?.pointXyz))
          ? "pointXyz"
          : (placementPlan.body.placements as Array<Record<string, unknown>>).some((row) =>
                Number.isFinite((row?.targetChainageFt as number) ?? Number.NaN) ||
                Number.isFinite((row?.targetNormalizedChainage as number) ?? Number.NaN)
            )
            ? "targetChainageFt"
          : "alongHostOffsetFt"
        : Array.isArray(placementPlan.body.pointXyz)
          ? "pointXyz"
          : Number.isFinite((placementPlan.body.targetChainageFt as number) ?? Number.NaN) ||
              Number.isFinite((placementPlan.body.targetNormalizedChainage as number) ?? Number.NaN)
            ? "targetChainageFt"
          : "alongHostOffsetFt"
      : null;
  const notes: string[] = [];
  if (placementPlan?.heuristic) notes.push("placement offsets currently rely on heuristic spacing because the redline marks were ambiguous");
  if (latestPreview?.preview_image_paths.length) notes.push(`preview evidence: ${latestPreview.preview_image_paths.join(", ")}`);
  if (familyStrategy === "create_similar_from_exemplar" && preferredCandidateId) {
    notes.push(`family/type should come from exemplar ${preferredCandidateId}, not from guessing a family name`);
  }
  if (resolvedRoomWall?.host_element_id) notes.push(`resolved requested wall host ${resolvedRoomWall.host_element_id}`);
  if (latestFailure?.error) notes.push(`latest placement failure: ${latestFailure.error}`);
  if (explicitAuditPending && latestApplied?.created_element_ids.length) {
    notes.push(`explicit hosted placement audit still pending for created ids ${latestApplied.created_element_ids.join(", ")}`);
  }
  if ((latestPlacementAudit?.invalid_ids.length ?? 0) > 0 || (latestPlacementAudit?.missing_ids.length ?? 0) > 0) {
    notes.push(
      `unresolved created ids: ${summarizeUnresolvedPlacementIds({
        createdElementIds: latestApplied?.created_element_ids ?? [],
        audit: latestPlacementAudit!
      }).join(", ")}`
    );
  }

  let recommendedNextAction = "Resolve room, wall, and exemplar context before writing.";
  if (stage === "preview" && placementPlan) {
    recommendedNextAction =
      `Run ${placementPlan.path} as a dry-run preview first, then continue automatically if the preview succeeds.`;
  } else if (stage === "apply" && applyPlan) {
    recommendedNextAction =
      `Run the previewed ${applyPlan.path} plan now with dryRun=false, then capture verification before answering.`;
  } else if (stage === "verify" && latestApplied) {
    recommendedNextAction =
      hasPlacementVerificationAfter(toolResults, latestApplied.index)
        ? `Run /revit/audit-hosted-instance-placement for created element ids ${latestApplied.created_element_ids.join(", ")} before treating the placement as complete.`
        : `Capture a focused post-change verification region for created element ids ${latestApplied.created_element_ids.join(", ")} and then run /revit/audit-hosted-instance-placement.`;
  } else if (stage === "correct") {
    recommendedNextAction =
      "Follow the server-selected correction path immediately: use bounded /revit/adjust-hosted-instance-on-host corrections when possible, otherwise delete unresolved created ids and re-run the bounded placement plan before re-verifying.";
  } else if (stage === "complete") {
    recommendedNextAction =
      "Only answer complete if the post-change capture and explicit hosted placement audit both pass.";
  } else if (stage === "blocked") {
    recommendedNextAction =
      `Do not return a generic stop. State the concrete blocker (${blockedReason ?? "unknown"}) and the missing host/placement basis.`;
  }

  return {
    workflow: "low_risk_hosted_placement",
    stage,
    scope_label: targetProfile.scope_label,
    requested_count: intent.requested_count,
    prefer_exemplar_clone: intent.prefers_exemplar_clone,
    room_number: roomNumber,
    spatial_side: effectiveSpatialSide,
    view_id: spatialViewId,
    exemplar_element_id: preferredCandidateId,
    host_element_id: effectivePlacementContext?.host_element_id ?? resolvedRoomWall?.host_element_id ?? null,
    family_strategy: familyStrategy,
    placement_path: placementPlan?.path ?? null,
    placement_basis: placementBasis,
    preview_ready: !!placementPlan,
    apply_ready: stage === "apply" && !!applyPlan,
    verification_required: stage === "verify" || stage === "correct" || stage === "complete",
    correction_ready: stage === "correct",
    blocked_reason: blockedReason,
    recommended_next_action: recommendedNextAction,
    notes
  };
}

function buildPlacementRunState(req: ChatRequest, workItem?: PlacementWorkItem | null): PlacementRunState | null {
  const resolvedWorkItem = workItem ?? buildPlacementWorkItem(req);
  if (!resolvedWorkItem) return null;

  const toolResults = getAugmentedToolResults(req, 80);
  const latestPreview = extractLatestPlacementPreviewSuccess(toolResults);
  const latestApplied = extractLatestPlacementWriteSuccess(toolResults);
  const latestFailure = extractLatestPlacementWriteFailure(toolResults);
  const verificationCaptured =
    !!latestApplied &&
    latestApplied.created_element_ids.length > 0 &&
    hasPlacementVerificationAfter(toolResults, latestApplied.index);
  const latestExplicitAudit =
    latestApplied && verificationCaptured
      ? extractLatestPlacementAuditSummary({
          toolResults,
          afterIndex: latestApplied.index,
          elementIds: latestApplied.created_element_ids
        })
      : null;
  const latestPlacementAudit =
    latestApplied && verificationCaptured
      ? summarizePlacementContextAuditAfter({
          toolResults,
          afterIndex: latestApplied.index,
          createdElementIds: latestApplied.created_element_ids,
          roomNumber: resolvedWorkItem.room_number,
          requireRequestedWall: !!resolvedWorkItem.spatial_side
        })
      : null;

  return {
    workflow: resolvedWorkItem.workflow,
    stage: resolvedWorkItem.stage,
    requested_count: resolvedWorkItem.requested_count,
    room_number: resolvedWorkItem.room_number,
    spatial_side: resolvedWorkItem.spatial_side,
    view_id: resolvedWorkItem.view_id,
    exemplar_element_id: resolvedWorkItem.exemplar_element_id,
    host_element_id: resolvedWorkItem.host_element_id,
    family_strategy: resolvedWorkItem.family_strategy,
    placement_path: resolvedWorkItem.placement_path,
    placement_basis: resolvedWorkItem.placement_basis,
    preview_ready: resolvedWorkItem.preview_ready,
    apply_ready: resolvedWorkItem.apply_ready,
    verification_required: resolvedWorkItem.verification_required,
    correction_ready: resolvedWorkItem.correction_ready,
    blocked_reason: resolvedWorkItem.blocked_reason,
    latest_preview_index: latestPreview?.index ?? null,
    latest_apply_index: latestApplied?.index ?? null,
    latest_failure_index: latestFailure?.index ?? null,
    latest_explicit_audit_index: latestExplicitAudit?.index ?? null,
    verification_captured: verificationCaptured,
    explicit_audit_complete: !!latestExplicitAudit,
    correction_attempts: latestApplied ? countPlacementCorrectionActionsAfter(toolResults, latestApplied.index) : 0,
    created_element_ids: latestApplied?.created_element_ids ?? [],
    audited_created_ids: latestPlacementAudit?.audited_ids ?? [],
    valid_created_ids: latestPlacementAudit?.valid_ids ?? [],
    invalid_created_ids: latestPlacementAudit?.invalid_ids ?? [],
    missing_audit_ids: latestPlacementAudit?.missing_ids ?? [],
    off_room_ids: latestPlacementAudit?.off_room_ids ?? [],
    off_wall_ids: latestPlacementAudit?.off_wall_ids ?? [],
    unsupported_ids: latestPlacementAudit?.unsupported_ids ?? [],
    unresolved_created_ids:
      latestApplied && latestPlacementAudit
        ? summarizeUnresolvedPlacementIds({
            createdElementIds: latestApplied.created_element_ids,
            audit: latestPlacementAudit
          })
        : [],
    recommended_next_action: resolvedWorkItem.recommended_next_action
  };
}

function buildPlacementWorkItemText(req: ChatRequest, workItem?: PlacementWorkItem | null): string | null {
  const resolvedWorkItem = workItem ?? buildPlacementWorkItem(req);
  return resolvedWorkItem ? JSON.stringify(resolvedWorkItem, null, 2) : null;
}

function withPlacementWorkItem(req: ChatRequest): ChatRequest {
  const workItem = buildPlacementWorkItem(req);
  const placementWorkItem = buildPlacementWorkItemText(req, workItem);
  if (!placementWorkItem || !workItem) return req;
  const placementRunState = buildPlacementRunState(req, workItem);
  return {
    ...req,
    context: withServerContext(req.context, {
      placement_work_item: placementWorkItem,
      ...(placementRunState ? { placement_run_state: placementRunState } : {})
    })
  };
}

export function __testOnlyBuildPlacementWorkItem(args: {
  userText: string;
  toolResults?: ToolResult[];
  context?: Record<string, unknown>;
  sessionId?: string;
}): PlacementWorkItem | null {
  const sessionId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : randomUUID();
  return buildPlacementWorkItem({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `${sessionId}:message`,
    user_text: typeof args.userText === "string" ? args.userText : "",
    ...(Array.isArray(args.toolResults) ? { tool_results: args.toolResults } : {}),
    ...(args.context ? { context: args.context } : {})
  } satisfies ChatRequest);
}

export function __testOnlyBuildPlacementRunState(args: {
  userText: string;
  toolResults?: ToolResult[];
  context?: Record<string, unknown>;
  sessionId?: string;
}): PlacementRunState | null {
  const sessionId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : randomUUID();
  const req = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `${sessionId}:message`,
    user_text: typeof args.userText === "string" ? args.userText : "",
    ...(Array.isArray(args.toolResults) ? { tool_results: args.toolResults } : {}),
    ...(args.context ? { context: args.context } : {})
  } satisfies ChatRequest;
  const workItem = buildPlacementWorkItem(req);
  return buildPlacementRunState(req, workItem);
}

function maybeBuildSpatialRedlineRefinementBridge(args: {
  req: ChatRequest;
  toolResults: ToolResult[];
  targetProfile: RedlineTargetingProfile;
  targetViewId: number;
  preferSheetTargeting: boolean;
  viewportHints: ViewportPickHint[];
}): ChatResponse | null {
  const { req, toolResults, targetProfile, targetViewId, preferSheetTargeting, viewportHints } = args;
  if (!targetProfile.resolve_only || targetProfile.pick_preference !== "modelGeometry") return null;
  if (!targetProfile.room_number) return null;
  const semanticCorpus = buildRedlineSemanticCorpus(req, []);
  const explicitTextWallSide = extractSpatialWallSide(semanticCorpus).side;
  const imageMarkHint = getPersistedImageMarkHint(req.session_id);
  const imageMarkedSide = normalizeSpatialWallSide(imageMarkHint?.side ?? "");
  const requestedRoomSide = targetProfile.spatial_side_source ?? targetProfile.spatial_side ?? imageMarkedSide ?? null;
  const resolvedRoomPlanView = extractLatestResolvedRoomPlanView(toolResults, targetProfile.room_number);
  const activeModelViewId = extractActiveModelViewIdFromContext(req.context);
  const activeModelView = extractActiveViewSummaryFromContext(req.context);
  const preferredModelViewToken = inferPreferredRedlineViewNameToken(targetProfile, semanticCorpus);
  const activeModelViewMatchesPreferredToken =
    activeModelViewId !== null &&
    activeModelView.id === activeModelViewId &&
    viewNameMatchesPreferredToken(activeModelView.name, preferredModelViewToken);
  const placementPreviewOrWriteStarted =
    hasToolPath(toolResults, "/revit/create-similar-from-instance") ||
    hasToolPath(toolResults, "/revit/place-family-instance-on-host") ||
    hasToolPath(toolResults, "/revit/export-view-region") ||
    hasToolPath(toolResults, "/revit/audit-hosted-instance-placement");
  if (
    !resolvedRoomPlanView &&
    preferredModelViewToken &&
    activeModelViewId !== null &&
    targetViewId === activeModelViewId &&
    !activeModelViewMatchesPreferredToken &&
    !placementPreviewOrWriteStarted &&
    !hasToolPath(toolResults, "/revit/resolve-room-plan-view")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Room ${targetProfile.room_number} and the adjacent device context are resolved, but placement is still anchored to ${activeModelView.name ?? `view ${activeModelViewId}`}. ` +
        `I’ll switch to the best ${preferredModelViewToken}/electrical plan before previewing the new device.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-room-plan-view",
          body: {
            roomNumber: targetProfile.room_number,
            preferViewNameContains: preferredModelViewToken,
            maxCandidates: 8
          }
        }
      ]
    };
  }

  const spatialViewId =
    (preferSheetTargeting ? viewportHints[0]?.view_id ?? null : targetViewId) ??
    viewportHints[0]?.view_id ??
    null;
  if (spatialViewId === null || spatialViewId <= 0) return null;
  const visibleInventoryPlacementHint = inferVisibleInventoryPlacementHintForRoom({
    toolResults,
    roomNumber: targetProfile.room_number,
    viewId: spatialViewId,
    markedSide: normalizeSpatialWallSide(requestedRoomSide ?? ""),
    preferAdjacentCircuitContext: wantsElectricalCircuitMatch(semanticCorpus)
  });
  const hasFrameAlignedSpatialViewportHint = hasFrameAlignedViewportHintForView(viewportHints, spatialViewId);
  const spatialViewportHints =
    hasFrameAlignedSpatialViewportHint
      ? viewportHints
      : imageMarkHint && isFrameAlignedImageMarkHint(imageMarkHint)
        ? [
            ...viewportHints,
            {
              view_id: spatialViewId,
              normalized_x: imageMarkHint.normalized_x,
              normalized_y: imageMarkHint.normalized_y,
              score: Math.max(0.2, Math.min(0.75, imageMarkHint.score * 0.9)),
              source: imageMarkHint.source ?? "view_alignment",
              frame_aligned: true
            }
          ]
        : visibleInventoryPlacementHint
          ? [...viewportHints, visibleInventoryPlacementHint]
          : viewportHints;

  const appliedPlacementForVerification = extractLatestPlacementWriteSuccess(toolResults);
  if (
    appliedPlacementForVerification &&
    appliedPlacementForVerification.created_element_ids.length > 0 &&
    !hasPlacementVerificationAfter(toolResults, appliedPlacementForVerification.index)
  ) {
    const unresolvedCount = Math.max(
      0,
      appliedPlacementForVerification.requested_count - appliedPlacementForVerification.created_element_ids.length
    );
    const unresolvedNote =
      unresolvedCount > 0
        ? ` ${unresolvedCount} requested placement${unresolvedCount === 1 ? " is" : "s are"} still unresolved${
            appliedPlacementForVerification.unresolved_labels.length > 0
              ? ` (${appliedPlacementForVerification.unresolved_labels.join(", ")})`
              : ""
          }.`
        : "";
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I placed ${appliedPlacementForVerification.created_element_ids.length} element${
          appliedPlacementForVerification.created_element_ids.length === 1 ? "" : "s"
        } (${appliedPlacementForVerification.created_element_ids.join(", ")}) and will capture a focused post-change view to verify they landed at the marked locations.${unresolvedNote}`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/export-view-region",
          body: {
            viewId: spatialViewId,
            imageMaxSizePx: 2400,
            includeMapping: true,
            region: {
              mode: "focusElements",
              focusElementIds: appliedPlacementForVerification.created_element_ids,
              marginFt: 8.0
            }
          }
        }
      ]
    };
  }
  if (
    appliedPlacementForVerification &&
    appliedPlacementForVerification.created_element_ids.length > 0 &&
    hasPlacementVerificationAfter(toolResults, appliedPlacementForVerification.index) &&
    !extractLatestPlacementAuditSummary({
      toolResults,
      afterIndex: appliedPlacementForVerification.index,
      elementIds: appliedPlacementForVerification.created_element_ids
    })
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I captured the post-change view for ${appliedPlacementForVerification.created_element_ids.join(", ")} and will run the explicit hosted placement audit for host, room, wall, and support before calling it complete.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/audit-hosted-instance-placement",
          body: {
            elementIds: appliedPlacementForVerification.created_element_ids,
            roomNumber: targetProfile.room_number,
            ...(targetProfile.spatial_side ? { roomSide: targetProfile.spatial_side } : {}),
            ...(Number.isFinite(appliedPlacementForVerification.target_chainage_ft as number)
              ? { targetChainageFt: appliedPlacementForVerification.target_chainage_ft }
              : {}),
            ...(Number.isFinite(appliedPlacementForVerification.target_normalized_chainage as number)
              ? { targetNormalizedChainage: appliedPlacementForVerification.target_normalized_chainage }
              : {}),
            ...(Array.isArray(appliedPlacementForVerification.target_point_xyz)
              ? { targetPointXyz: appliedPlacementForVerification.target_point_xyz }
              : {}),
            targetToleranceFt: 0.5,
            hostCategories: ["OST_Walls"],
            maxNearbyHosts: 5,
            hostSearchRadiusFt: 8.0
          }
        }
      ]
    };
  }

  const roomDetail = extractLatestRoomDetailForNumber(toolResults, targetProfile.room_number);
  const spatialResolution = extractLatestSpatialResolutionForNumber(toolResults, targetProfile.room_number);
  if (!spatialResolution) {
    const sideNote = targetProfile.spatial_side_source ? ` (${targetProfile.spatial_side_source} wall hint)` : "";
    if (!hasToolPath(toolResults, "/revit/rooms")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I’ll resolve room ${targetProfile.room_number} in view ${spatialViewId} first so I can narrow this redline to room-boundary candidates${sideNote}.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/rooms",
            body: {
              action: "detail",
              roomNumber: targetProfile.room_number,
              viewId: spatialViewId,
              includeBoundaryElementIds: true
            }
          }
        ]
      };
    }
    if (!hasSuccessfulToolPath(toolResults, "/revit/room-contents") && countToolPath(toolResults, "/revit/room-contents") < 2) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          hasFailedToolPath(toolResults, "/revit/room-contents")
            ? `The previous room-contents call failed, so I’ll retry it with the native room/space fallback settings and keep the spatial targeting flow alive${sideNote}.`
            : `Room detail did not resolve ${targetProfile.room_number}, so I’ll resolve the same identifier through room/space contents and keep the spatial targeting flow alive${sideNote}.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/room-contents",
            body: {
              roomNumber: targetProfile.room_number,
              ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
              mode: "geometry",
              verticalScope: "room+plenum",
              spatialKindPreference: "auto",
              includeLinked: true,
              limit: 500
            }
          }
        ]
      };
    }
    return null;
  }

  const spatialLabel = (spatialResolution.spatial_kind ?? "spatial element").toLowerCase();
  if (requestedRoomSide && !hasSuccessfulToolPath(toolResults, "/revit/resolve-room-wall")) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I resolved ${spatialLabel} ${targetProfile.room_number} and will map the ${requestedRoomSide} wall to concrete host walls before selecting an exemplar.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-room-wall",
          body: {
            roomNumber: targetProfile.room_number,
            viewId: spatialViewId,
            side: requestedRoomSide,
            maxWalls: 4,
            includeSegments: true
          }
        }
      ]
    };
  }

  const initialRankFrame = extractLatestFrameForView(toolResults, spatialViewId);
  const initialRankTargetPoint =
    initialRankFrame
      ? spatialViewportHints
          .filter((hint) => hint.view_id === spatialViewId && isFrameAlignedViewportHint(hint))
          .map((hint) => frameHintToModelPoint(initialRankFrame, hint))
          .find((point): point is [number, number, number] => !!point) ?? null
      : null;
  const roomContentsElementIdsForInitialRank = extractLatestRoomContentsElementIds(toolResults, targetProfile.room_number);
  const latestCandidateClusterForInitialRank = extractLatestCandidateClusterSummary(toolResults);
  const hasReliableCandidateClusterForInitialRank = isCandidateClusterRecommendationReliable(
    latestCandidateClusterForInitialRank,
    targetProfile
  );
  const shouldRankAfterEmptyPickCluster =
    roomContentsElementIdsForInitialRank.length === 0 &&
    hasSuccessfulToolPath(toolResults, "/revit/resolve-room-wall") &&
    !!latestCandidateClusterForInitialRank &&
    !hasReliableCandidateClusterForInitialRank;
  const needsSameRoomExemplarRank =
    roomContentsElementIdsForInitialRank.length === 0 ||
    (hasSuccessfulToolPath(toolResults, "/revit/resolve-room-wall") && hasFailedToolPath(toolResults, "/revit/room-contents"));
  if (
    needsSameRoomExemplarRank &&
    !hasToolPath(toolResults, "/revit/rank-similar-devices-on-wall") &&
    (!hasSuccessfulToolPath(toolResults, "/revit/pick-candidate-cluster") || shouldRankAfterEmptyPickCluster) &&
    !hasSuccessfulToolPath(toolResults, "/revit/locate-elements") &&
    !hasSuccessfulToolPath(toolResults, "/revit/get-placement-context") &&
    !hasSuccessfulToolPath(toolResults, "/revit/get-parameters") &&
    !hasSuccessfulToolPath(toolResults, "/revit/create-similar-from-instance") &&
    !hasToolPath(toolResults, "/revit/place-family-instance-on-host") &&
    !hasSuccessfulToolPath(toolResults, "/revit/audit-hosted-instance-placement")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        hasSuccessfulToolPath(toolResults, "/revit/resolve-room-wall")
          ? `I resolved the requested room wall and will rank adjacent same-room hosted device exemplars with explicit XYZ, host wall, orientation, and circuit data before choosing the create-similar source.`
          : `I’ll rank same-room hosted device exemplars with explicit XYZ, host wall, orientation, and circuit data before choosing the create-similar source.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/rank-similar-devices-on-wall",
          body: {
            roomNumber: targetProfile.room_number,
            viewId: spatialViewId,
            roomSide: requestedRoomSide,
            ...(initialRankTargetPoint
              ? {
                  targetPointXyz: {
                    x: initialRankTargetPoint[0],
                    y: initialRankTargetPoint[1],
                    z: initialRankTargetPoint[2]
                  }
                }
              : {}),
            ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
            includeKeywords: ["receptacle", "outlet", "duplex", "power", "device", "switch", "data"],
            sortMode: requestedRoomSide ? "score_then_distance_then_coordinate" : "smallest_y_then_x",
            maxCandidates: 20
          }
        }
      ]
    };
  }

  const frame = initialRankFrame;
  if (!frame && !hasToolPath(toolResults, "/revit/export-view-frame")) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I resolved ${spatialLabel} ${targetProfile.room_number} and will export a mapped view frame so the redline hint can be converted into view-space coordinates.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/export-view-frame",
          body: {
            viewId: spatialViewId,
            includeMapping: true,
            imageMaxSizePx: 2400
          }
        }
      ]
    };
  }

  const inferredMarkedRoomSide =
    targetProfile.spatial_side
      ? null
      : inferRoomSideFromViewportHintsAndBoundary({
          frame,
          viewportHints: spatialViewportHints,
          spatialViewId,
          bbox: extractLatestRoomContentsBoundaryBbox(toolResults, targetProfile.room_number)
        });
  const rankedSimilarDevice = extractLatestRankedSimilarDeviceSummary(toolResults);
  const targetProfileRoomSide = targetProfile.spatial_side_source ?? targetProfile.spatial_side ?? null;
  const rankedRoomSide = rankedSimilarDevice?.room_side ?? null;
  const effectiveRoomSide = explicitTextWallSide
    ? targetProfileRoomSide ?? inferredMarkedRoomSide ?? imageMarkedSide ?? rankedRoomSide
    : rankedRoomSide ?? targetProfileRoomSide ?? inferredMarkedRoomSide ?? imageMarkedSide ?? null;
  const effectiveCanonicalRoomSide = explicitTextWallSide
    ? targetProfile.spatial_side ?? inferredMarkedRoomSide ?? imageMarkedSide ?? rankedRoomSide
    : rankedRoomSide ?? targetProfile.spatial_side ?? inferredMarkedRoomSide ?? imageMarkedSide ?? null;
  if (
    inferredMarkedRoomSide &&
    !hasSuccessfulToolPath(toolResults, "/revit/resolve-room-wall")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I mapped the redline mark into room ${targetProfile.room_number} near the ${inferredMarkedRoomSide} side, so I’ll resolve that room wall before choosing the adjacent exemplar.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-room-wall",
          body: {
            roomNumber: targetProfile.room_number,
            viewId: spatialViewId,
            side: inferredMarkedRoomSide,
            maxWalls: 5,
            includeSegments: true
          }
        }
      ]
    };
  }

  const roomContentsElementIds = extractLatestRoomContentsElementIds(toolResults, targetProfile.room_number);
  const roomContentsCandidates = extractLatestRoomContentsLocatedCandidates(toolResults, targetProfile.room_number);
  const locateCandidates = extractLatestLocateElementsCandidates(toolResults, targetProfile.room_number);
  const effectiveLocateCandidates = locateCandidates.length > 0 ? locateCandidates : roomContentsCandidates;
  const requestedPanelCircuit = extractRequestedPanelCircuit(getRecentUserTextForRedline(req));
  const circuitMatchedExemplarId = extractLatestElectricalCircuitExemplarId(toolResults, requestedPanelCircuit);
  const viewFindIds = extractLatestFindElementsIdsForView(toolResults, spatialViewId);
  const fallbackFindIds = extractLatestFindElementsIds(toolResults);
  const latestCluster = extractLatestCandidateClusterSummary(toolResults);
  const latestPlacementFailure = extractLatestPlacementWriteFailure(toolResults);
  const latestPlacementPreview = extractLatestPlacementPreviewSuccess(toolResults);
  const latestPlacementContextId = extractLatestPlacementContextElementId(toolResults);
  const latestPlacementContext = extractLatestPlacementContextSummary(toolResults);
  const canBypassCandidateLocateForCircuitRecovery =
    circuitMatchedExemplarId !== null &&
    latestPlacementPreview?.path !== "/revit/create-similar-from-instance" &&
    countInvalidPlacementPreviews(toolResults, "/revit/create-similar-from-instance") === 0 &&
    isRecoverableInvalidPlacementPreview(latestPlacementPreview, {
      path: "/revit/create-similar-from-instance",
      body: {
        exemplarElementId: circuitMatchedExemplarId,
        placements: [{ pointXyz: [0, 0, 0] }]
      },
      requested_count: 1,
      heuristic: true
    });
  if (canBypassCandidateLocateForCircuitRecovery) {
    const recoveryWall = extractLatestResolvedRoomWallPlacementSummary({
      toolResults,
      roomNumber: targetProfile.room_number,
      preferredHostIds: []
    });
    const recoveryContext = buildSynthesizedPlacementContext({
      exemplarElementId: circuitMatchedExemplarId,
      roomWall: recoveryWall
    });
    const recoveryPlan = buildSpatialPlacementPreviewPlan({
      userText: getRecentUserTextForRedline(req),
      spatialViewId,
      viewportHints: spatialViewportHints,
      frame,
      placementContext: recoveryContext,
      imageMarkHint
    });
    if (recoveryPlan) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The first host placement preview failed validation, so I’ll recover with a same-circuit create-similar preview from exemplar ${circuitMatchedExemplarId} on the resolved room wall instead of falling back to redline picking.`,
        actions: [
          buildPlacementWarningGuardAction(),
          {
            action_id: randomUUID(),
            method: "POST",
            path: recoveryPlan.path,
            body: recoveryPlan.body
          }
        ]
      };
    }
  }
  if (
    requestedPanelCircuit &&
    circuitMatchedExemplarId === null &&
    (viewFindIds.length > 0 || fallbackFindIds.length > 0) &&
    !hasToolPath(toolResults, "/revit/get-parameters")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I found candidate electrical devices and will read circuit parameters so I can use a real ${requestedPanelCircuit.panel}/${requestedPanelCircuit.circuit} receptacle as the exemplar instead of guessing a source family.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/get-parameters",
          body: {
            elementIds: (viewFindIds.length > 0 ? viewFindIds : fallbackFindIds).slice(0, 120),
            names: ["Panel", "Circuit Number", "Circuit", "Electrical Circuit", "Family", "Type", "Family and Type", "Type Name", "Elevation", "Offset"]
          }
        }
      ]
    };
  }
  if (
    !latestCluster &&
    frame &&
    roomContentsElementIds.length > 0 &&
    spatialViewportHints.some((hint) => hint.view_id === spatialViewId) &&
    effectiveLocateCandidates.length === 0 &&
    !latestPlacementContext &&
    !latestPlacementPreview &&
    !canBypassCandidateLocateForCircuitRecovery &&
    !hasToolPath(toolResults, "/revit/locate-elements")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I have mapped redline marks in view ${spatialViewId} and will resolve the same-room candidate inventory with actual element centers before choosing a reference device.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/locate-elements",
          body: {
            elementIds: roomContentsElementIds.slice(0, 80),
            ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
            roomNumber: targetProfile.room_number,
            limit: 80
          }
        }
      ]
    };
  }

  if (
    !latestCluster &&
    frame &&
    effectiveLocateCandidates.length === 0 &&
    !latestPlacementContext &&
    !latestPlacementPreview &&
    !(latestPlacementFailure && circuitMatchedExemplarId !== null) &&
    !canBypassCandidateLocateForCircuitRecovery
  ) {
    const bestHint =
      spatialViewportHints.find((hint) => hint.view_id === spatialViewId) ??
      spatialViewportHints[0] ??
      null;
    if (bestHint) {
      const xPx = Math.max(0, Math.min(frame.width_px - 1, Math.round(bestHint.normalized_x * frame.width_px)));
      const yPx = Math.max(0, Math.min(frame.height_px - 1, Math.round(bestHint.normalized_y * frame.height_px)));
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I’ve got the room/wall context and mapped frame, so I’ll rank the nearest exemplar devices and wall hosts at the marked redline location.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/pick-candidate-cluster",
            body: {
              frameId: frame.frame_id,
              xPx,
              yPx,
              includeCategories: targetProfile.categories,
              hostCategories: ["OST_Walls"],
              roomNumber: targetProfile.room_number,
              roomSide: effectiveRoomSide,
              searchRadiusFt: 8,
              maxTargets: 6,
              maxHosts: 6
            }
          }
        ]
      };
    }
  }

  const clusterRecommendationReliable = isCandidateClusterRecommendationReliable(latestCluster, targetProfile);
  if (latestCluster && latestCluster.target_candidate_ids.length === 0) {
    if (roomContentsElementIds.length > 0 && effectiveLocateCandidates.length === 0 && !hasToolPath(toolResults, "/revit/locate-elements")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Spatial candidate clustering came back empty, so I’ll re-rank the resolved ${spatialLabel} exemplar pool by room/host metadata before choosing a reference device.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/locate-elements",
            body: {
              elementIds: roomContentsElementIds.slice(0, 80),
              ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
              roomNumber: targetProfile.room_number,
              limit: 80
            }
          }
        ]
      };
    }

    const summaryFallbackCandidate = chooseNearestSummaryCandidateForSpatialHint({
      frame,
      viewportHints: spatialViewportHints,
      spatialViewId,
      candidates: extractLatestSheetSummaryCandidates(toolResults),
      candidateIds: roomContentsElementIds
    });
    if (summaryFallbackCandidate && latestPlacementContextId !== summaryFallbackCandidate.id) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Cluster ranking was empty, but I recovered a nearest ${spatialLabel} exemplar from the resolved room/space inventory and will inspect its host context before continuing.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/get-placement-context",
            body: {
              elementId: summaryFallbackCandidate.id,
              hostCategories: ["OST_Walls"],
              hostSearchRadiusFt: 12,
              maxNearbyHosts: 5,
              roomNumber: targetProfile.room_number,
              roomSide: targetProfile.spatial_side_source ?? targetProfile.spatial_side
            }
          }
        ]
      };
    }
  }

  const hasViewFindResult = hasFindElementsResultForView(toolResults, spatialViewId);
  const hasRoomScopedPlacementContext =
    roomContentsElementIds.length > 0 ||
    latestPlacementContext !== null ||
    circuitMatchedExemplarId !== null;
  if (!hasRoomScopedPlacementContext && viewFindIds.length === 0) {
    if (hasViewFindResult) return null;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I’ll query likely ${targetProfile.scope_label} elements in view ${spatialViewId} so I can refine them by room ${targetProfile.room_number}.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/find-elements",
          body: {
            viewId: spatialViewId,
            ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
            limit: 250
          }
        }
      ]
    };
  }

  if (
    !hasRoomScopedPlacementContext &&
    effectiveLocateCandidates.length === 0 &&
    !hasToolPath(toolResults, "/revit/locate-elements")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I found ${viewFindIds.length} model candidates in the resolved view and will narrow them to room ${targetProfile.room_number}.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/locate-elements",
          body: {
            elementIds: viewFindIds.slice(0, 120),
            ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
            roomNumber: targetProfile.room_number,
            limit: 80
          }
        }
      ]
    };
  }

  const narrowedCandidates = filterLocateCandidatesByRoomSide(
    effectiveLocateCandidates,
    roomDetail,
    effectiveCanonicalRoomSide
  );
  if (
    latestCluster &&
    !clusterRecommendationReliable &&
    roomContentsElementIds.length > 0 &&
    effectiveLocateCandidates.length === 0 &&
    !hasToolPath(toolResults, "/revit/locate-elements")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The current cluster recommendation is too weak for a safe write, so I’ll re-rank the resolved ${spatialLabel} pool by actual room/host metadata before choosing a reference device.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/locate-elements",
          body: {
            elementIds: roomContentsElementIds.slice(0, 80),
            ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
            roomNumber: targetProfile.room_number,
            limit: 80
          }
        }
      ]
    };
  }
  const summaryFallbackCandidate = chooseNearestSummaryCandidateForSpatialHint({
    frame,
    viewportHints: spatialViewportHints,
    spatialViewId,
    candidates: extractLatestSheetSummaryCandidates(toolResults),
    candidateIds: roomContentsElementIds.length > 0 ? roomContentsElementIds : undefined
  });
  const preferredLocateCandidate =
    chooseNearestLocatedCandidateForSpatialHint({
      frame,
      viewportHints: spatialViewportHints,
      spatialViewId,
      candidates: narrowedCandidates.length > 0 ? narrowedCandidates : effectiveLocateCandidates,
      roomDetail,
      side: effectiveCanonicalRoomSide
    }) ??
    narrowedCandidates[0] ??
    effectiveLocateCandidates[0] ??
    null;
  const bestClusterElementId = clusterRecommendationReliable
    ? latestCluster?.recommended_exemplar_element_id ?? latestCluster?.target_candidate_ids[0] ?? null
    : null;
  const rankedSimilarDeviceId = rankedSimilarDevice?.element_id ?? null;
  const resolvedRoomWallPlacement = extractLatestResolvedRoomWallPlacementSummary({
    toolResults,
    roomNumber: targetProfile.room_number,
    preferredHostIds: [
      latestCluster?.recommended_host_element_id ?? null,
      preferredLocateCandidate?.host_id ?? null,
      rankedSimilarDevice?.host_id ?? null,
      ...(latestCluster?.host_candidate_ids ?? [])
    ]
  });
  const sameWallRoomContentsCandidate = chooseLocatedCandidateNearestResolvedWall(
    narrowedCandidates.length > 0 ? narrowedCandidates : effectiveLocateCandidates,
    resolvedRoomWallPlacement
  );
  const hasMappedPlacementHint = !!frame && hasFrameAlignedViewportHintForView(spatialViewportHints, spatialViewId);
  const hasPlacementWriteAttempt =
    hasToolPath(toolResults, "/revit/create-similar-from-instance") ||
    hasToolPath(toolResults, "/revit/place-family-instance-on-host");
  const hasPlacementWriteSucceeded =
    hasSuccessfulToolPath(toolResults, "/revit/create-similar-from-instance") ||
    hasSuccessfulToolPath(toolResults, "/revit/place-family-instance-on-host");
  const circuitCandidatePool = Array.from(new Set([
    ...effectiveLocateCandidates.map((candidate) => candidate.element_id),
    ...roomContentsElementIds
  ].filter((id) => Number.isFinite(id) && id > 0))).slice(0, 120);
  if (
    requestedPanelCircuit &&
    hasMappedPlacementHint &&
    !hasPlacementWriteAttempt &&
    !latestPlacementPreview &&
    circuitMatchedExemplarId === null &&
    circuitCandidatePool.length > 0 &&
    !hasElectricalParameterRowsForAny(toolResults, circuitCandidatePool)
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I have room ${targetProfile.room_number} candidate coordinates and will read circuit parameters so the exemplar is both near the red mark and actually on ${requestedPanelCircuit.panel}/${requestedPanelCircuit.circuit}.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/get-parameters",
          body: {
            elementIds: circuitCandidatePool,
            names: ["Panel", "Circuit Number", "Circuit", "Electrical Circuit", "Family", "Type", "Family and Type", "Type Name", "Elevation", "Offset"]
          }
        }
      ]
    };
  }
  const nearestCircuitMatchedCandidate = requestedPanelCircuit
    ? chooseNearestCircuitMatchedLocatedCandidate({
        toolResults,
        requested: requestedPanelCircuit,
        frame,
        viewportHints: spatialViewportHints,
        spatialViewId,
        candidates: narrowedCandidates.length > 0 ? narrowedCandidates : effectiveLocateCandidates,
        roomDetail,
        side: effectiveCanonicalRoomSide
      })
    : null;
  const hintPreferredCandidateId =
    sameWallRoomContentsCandidate?.element_id ??
    preferredLocateCandidate?.element_id ??
    summaryFallbackCandidate?.id ??
    null;
  const roomScopedFallbackCandidateId =
    sameWallRoomContentsCandidate?.element_id ??
    preferredLocateCandidate?.element_id ??
    summaryFallbackCandidate?.id ??
    null;
  const preferredCandidateId =
    bestClusterElementId ??
    (requestedPanelCircuit
      ? nearestCircuitMatchedCandidate?.element_id ?? circuitMatchedExemplarId ?? (hasMappedPlacementHint ? hintPreferredCandidateId : null) ?? rankedSimilarDeviceId ?? roomScopedFallbackCandidateId
      : (hasMappedPlacementHint ? hintPreferredCandidateId : null) ?? rankedSimilarDeviceId ?? circuitMatchedExemplarId ?? roomScopedFallbackCandidateId) ??
    null;
  const placementContext = extractPreferredPlacementContextSummary(
    toolResults,
    preferredCandidateId ?? latestPlacementContextId ?? null
  );
  const synthesizedPlacementContext = buildSynthesizedPlacementContext({
    exemplarElementId: preferredCandidateId ?? latestPlacementContextId ?? null,
    roomWall: resolvedRoomWallPlacement
  });
  const rankedPlacementContext = buildRankedPlacementContext({
    ranked: rankedSimilarDevice,
    roomNumber: targetProfile.room_number,
    roomSide: effectiveRoomSide
  });
  const effectivePlacementContext =
    placementContext && placementContext.supported_host
      ? placementContext
      : synthesizedPlacementContext ?? rankedPlacementContext ?? placementContext;
  const latestAppliedPlacement = extractLatestPlacementWriteSuccess(toolResults);
  if (
    preferredCandidateId !== null &&
    latestPlacementContextId !== preferredCandidateId &&
    !(effectivePlacementContext && effectivePlacementContext.element_id === preferredCandidateId && effectivePlacementContext.supported_host)
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        clusterRecommendationReliable
          ? `I narrowed the redline to room ${targetProfile.room_number} and will inspect the best nearby exemplar candidate for host context before continuing.`
          : `I rejected the weak cluster recommendation and will inspect the strongest same-room candidate on the requested wall before continuing.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/get-placement-context",
          body: {
            elementId: preferredCandidateId,
            hostCategories: ["OST_Walls"],
            hostSearchRadiusFt: 12,
            maxNearbyHosts: 5,
            roomNumber: targetProfile.room_number,
            roomSide: effectiveRoomSide
          }
        }
      ]
    };
  }

  if (
    latestPlacementContext &&
    !latestPlacementContext.supported_host &&
    !resolvedRoomWallPlacement &&
    !targetProfile.spatial_side &&
    !hasSuccessfulToolPath(toolResults, "/revit/resolve-room-wall") &&
    !hasPlacementWriteSucceeded &&
    !hasPlacementWriteAttempt
  ) {
    const inferredSide = inferRoomSideFromPointAndBoundary(
      latestPlacementContext.center ?? latestPlacementContext.insertion_point,
      extractLatestRoomContentsBoundaryBbox(toolResults, targetProfile.room_number)
    );
    if (inferredSide) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The selected exemplar reports an unsupported direct host, so I’ll infer its nearest room side (${inferredSide}) and resolve the actual wall before placing.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/resolve-room-wall",
            body: {
              roomNumber: targetProfile.room_number,
              viewId: spatialViewId,
              side: inferredSide,
              maxWalls: 5,
              includeSegments: true
            }
          }
        ]
      };
    }
  }

  if (
    latestAppliedPlacement &&
    latestAppliedPlacement.created_element_ids.length > 0 &&
    hasPlacementVerificationAfter(toolResults, latestAppliedPlacement.index)
  ) {
    const explicitPlacementAudit = extractLatestPlacementAuditSummary({
      toolResults,
      afterIndex: latestAppliedPlacement.index,
      elementIds: latestAppliedPlacement.created_element_ids
    });
    if (!explicitPlacementAudit) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I captured the post-change view and will run the explicit hosted placement audit for created ids ${latestAppliedPlacement.created_element_ids.join(", ")} before I treat this placement as complete.`,
        actions: [
          buildHostedPlacementAuditAction({
            createdElementIds: latestAppliedPlacement.created_element_ids,
            roomNumber: targetProfile.room_number,
            roomSide: effectiveRoomSide,
            targetChainageFt: latestAppliedPlacement.target_chainage_ft,
            targetNormalizedChainage: latestAppliedPlacement.target_normalized_chainage,
            targetPointXyz: latestAppliedPlacement.target_point_xyz,
            targetToleranceFt: 0.5
          })
        ]
      };
    }
    const placementAudit = summarizePlacementContextAuditAfter({
      toolResults,
      afterIndex: latestAppliedPlacement.index,
      createdElementIds: latestAppliedPlacement.created_element_ids,
      roomNumber: targetProfile.room_number,
      requireRequestedWall: !!effectiveCanonicalRoomSide
    });
    const correctionBridge = maybeBuildVerifiedPlacementCorrectionBridge({
      toolResults,
      placementIndex: latestAppliedPlacement.index,
      createdElementIds: latestAppliedPlacement.created_element_ids,
      requestedCount: latestAppliedPlacement.requested_count,
      roomNumber: targetProfile.room_number,
      spatialSide: effectiveCanonicalRoomSide,
      spatialViewId,
      viewportHints: spatialViewportHints,
      frame,
      placementContext: effectivePlacementContext
    });
    if (correctionBridge) return correctionBridge;
    const forcedRecoveryBridge = maybeBuildForcedPlacementRecoveryBridge({
      userText: getRecentUserTextForRedline(req),
      toolResults,
      placementIndex: latestAppliedPlacement.index,
      createdElementIds: latestAppliedPlacement.created_element_ids,
      roomNumber: targetProfile.room_number,
      spatialSide: effectiveCanonicalRoomSide,
      spatialViewId,
      viewportHints: spatialViewportHints,
      frame,
      placementContext: effectivePlacementContext
    });
    if (forcedRecoveryBridge) return forcedRecoveryBridge;
    if (placementAudit.invalid_ids.length > 0 || placementAudit.missing_ids.length > 0) {
      const unresolvedIds = summarizeUnresolvedPlacementIds({
        createdElementIds: latestAppliedPlacement.created_element_ids,
        audit: placementAudit
      });
      const roomNote = placementAudit.off_room_ids.length > 0 ? ` Off-room ids: ${placementAudit.off_room_ids.join(", ")}.` : "";
      const wallNote = placementAudit.off_wall_ids.length > 0 ? ` Off-wall ids: ${placementAudit.off_wall_ids.join(", ")}.` : "";
      const supportNote = placementAudit.unsupported_ids.length > 0 ? ` Unsupported-host ids: ${placementAudit.unsupported_ids.join(", ")}.` : "";
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Answer: I verified the created elements against room/host context and they are not all on the requested wall yet, so I am not treating this placement as complete. ` +
          `Unresolved created ids: ${unresolvedIds.join(", ")}.${roomNote}${wallNote}${supportNote}`,
        actions: []
      };
    }

    const circuitSummary = (() => {
      for (let i = toolResults.length - 1; i > latestAppliedPlacement.index; i--) {
        const r = toolResults[i];
        if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/get-parameters") continue;
        if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
        const res = r.result_json && typeof r.result_json === "object" ? (r.result_json as Record<string, unknown>) : null;
        const items = extractResultItems(res);
        for (const item of items) {
          const id = toFiniteInt(item?.id ?? item?.elementId ?? item?.element_id);
          if (id === null || !latestAppliedPlacement.created_element_ids.includes(id)) continue;
          const params = item.parameters && typeof item.parameters === "object" ? (item.parameters as Record<string, unknown>) : null;
          const panel = typeof params?.Panel === "string" ? params.Panel.trim() : "";
          const circuit = typeof params?.["Circuit Number"] === "string" ? params["Circuit Number"].trim() : "";
          if (panel || circuit) return ` Panel/circuit: ${panel || "?"}/${circuit || "?"}.`;
        }
      }
      return "";
    })();

    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: Placed and verified receptacle ${latestAppliedPlacement.created_element_ids.join(", ")} in room ${targetProfile.room_number ?? "the requested room"} on the requested wall.` +
        circuitSummary,
      actions: []
    };
  }

  if (
    latestPlacementContext &&
    !latestPlacementContext.supported_host &&
    resolvedRoomWallPlacement &&
    preferredCandidateId !== null &&
    preferredCandidateId > 0 &&
    !hasPlacementWriteSucceeded &&
    !hasPlacementWriteAttempt
  ) {
    const tangent = normalizeVec3(resolvedRoomWallPlacement.wall_tangent);
    const anchor = resolvedRoomWallPlacement.wall_projected_point;
    if (tangent && anchor && resolvedRoomWallPlacement.host_element_id !== null) {
      const targetPoint = [
        Number((anchor[0] + tangent[0] * -8).toFixed(6)),
        Number((anchor[1] + tangent[1] * -8).toFixed(6)),
        Number((anchor[2] + tangent[2] * -8).toFixed(6))
      ];
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The selected exemplar reports an unsupported source host, so I’ll use the resolved room wall host ${resolvedRoomWallPlacement.host_element_id} directly for a bounded create-similar preview instead of stopping.`,
        actions: [
          buildPlacementWarningGuardAction(),
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/create-similar-from-instance",
            body: {
              exemplarElementId: preferredCandidateId,
              hostElementId: resolvedRoomWallPlacement.host_element_id,
              ...(targetProfile.room_number ? { roomNumber: targetProfile.room_number } : {}),
              ...(resolvedRoomWallPlacement.requested_room_side ? { roomSide: resolvedRoomWallPlacement.requested_room_side } : {}),
              dryRun: true,
              includePreviewImage: true,
              previewViewId: spatialViewId,
              placements: [{ pointXyz: targetPoint, label: "mark 1" }],
              matchOrientationFromSource: false,
              matchElectricalCircuitFromSource: true,
              requireElectricalCircuitMatch: true
            }
          }
        ]
      };
    }
  }

  const rankedCreateSimilarFallbackPlan = buildRankedCreateSimilarFallbackPlan({
    userText: getRecentUserTextForRedline(req),
    spatialViewId,
    ranked: rankedSimilarDevice,
    roomNumber: targetProfile.room_number,
    roomSide: effectiveRoomSide
  });
  if (
    latestPlacementContext &&
    !latestPlacementContext.supported_host &&
    rankedCreateSimilarFallbackPlan &&
    !hasPlacementWriteSucceeded &&
    !hasPlacementWriteAttempt
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The placement-context probe reported an unsupported direct host, but the native same-room wall ranking already returned a concrete create-similar placement request. ` +
        `I’ll preview that ranked request instead of stopping at the unsupported exemplar host.`,
      actions: [
        buildPlacementWarningGuardAction(),
        {
          action_id: randomUUID(),
          method: "POST",
          path: rankedCreateSimilarFallbackPlan.path,
          body: rankedCreateSimilarFallbackPlan.body
        }
      ]
    };
  }

  if (
    effectivePlacementContext &&
    !effectivePlacementContext.supported_host &&
    !hasPlacementWriteSucceeded
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: I stopped before placement because the resolved exemplar host is not placeable yet. ` +
        `The current context did not produce a supported wall/link host with a usable placement basis, so a write here would likely land in the wrong location or host.`,
      actions: []
    };
  }

  const placementPlan = buildSpatialPlacementPreviewPlan({
    userText: getRecentUserTextForRedline(req),
    spatialViewId,
    viewportHints: spatialViewportHints,
    frame,
    placementContext: effectivePlacementContext,
    imageMarkHint
  });
  if (placementPlan?.body) {
    if (targetProfile.room_number && typeof placementPlan.body.roomNumber !== "string") {
      placementPlan.body.roomNumber = targetProfile.room_number;
    }
    const requestedSide = effectiveRoomSide;
    if (requestedSide && typeof placementPlan.body.roomSide !== "string") {
      placementPlan.body.roomSide = requestedSide;
    }
  }
  const placementApplyPlan = buildPlacementApplyPlan(placementPlan);
  if (
    latestPlacementPreview &&
    latestPlacementPreview.placement_validation_valid === false &&
    countInvalidPlacementPreviews(toolResults, "/revit/create-similar-from-instance") > 0 &&
    countInvalidPlacementPreviews(toolResults, "/revit/place-family-instance-on-host") > 0 &&
    !hasPlacementWriteSuccessAfter(toolResults, latestPlacementPreview.index)
  ) {
    const invalidCount = countInvalidPlacementPreviews(toolResults);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: I previewed both native hosted placement routes and neither validated for this same-room host/target. ` +
        `I tried ${invalidCount} invalid native placement preview${invalidCount === 1 ? "" : "s"} and will not keep rediscovering tools or pivot to another room/unit without a corrected same-room host/target.`,
      actions: []
    };
  }
  if (
    latestPlacementPreview &&
    placementApplyPlan &&
    latestPlacementPreview.path === placementApplyPlan.path &&
    latestPlacementPreview.placement_validation_valid === false &&
    (!latestPlacementFailure || latestPlacementFailure.index < latestPlacementPreview.index) &&
    !hasPlacementWriteSuccessAfter(toolResults, latestPlacementPreview.index)
  ) {
    const alternatePath =
      placementPlan?.path === "/revit/create-similar-from-instance"
        ? "/revit/place-family-instance-on-host"
        : placementPlan?.path === "/revit/place-family-instance-on-host"
          ? "/revit/create-similar-from-instance"
          : null;
    const alternatePlan = alternatePath
        ? buildSpatialPlacementPreviewPlan({
          userText: getRecentUserTextForRedline(req),
          spatialViewId,
          viewportHints: spatialViewportHints,
          frame,
          placementContext: effectivePlacementContext,
          imageMarkHint,
          forcePath: alternatePath
        })
      : null;
    if (
      alternatePlan &&
      countInvalidPlacementPreviews(toolResults, alternatePlan.path) === 0
    ) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The ${latestPlacementPreview.path === "/revit/create-similar-from-instance" ? "create-similar" : "place-on-host"} preview failed validation, so I’ll try the alternate native hosted placement route once before blocking.`,
        actions: [
          buildPlacementWarningGuardAction(),
          {
            action_id: randomUUID(),
            method: "POST",
            path: alternatePlan.path,
            body: alternatePlan.body
          }
        ]
      };
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: I previewed the host-aware placement but did not apply it because native validation says it would be invalid/off-wall or unsupported. ` +
        `Reason: ${latestPlacementPreview.placement_validation_reason ?? "placement preview validation failed"}. ` +
        `I tried ${countInvalidPlacementPreviews(toolResults)} invalid native placement preview${countInvalidPlacementPreviews(toolResults) === 1 ? "" : "s"} and will not keep rediscovering tools or pivot to another room/unit without a corrected same-room host/target.`,
      actions: []
    };
  }
  if (
    latestPlacementPreview &&
    placementApplyPlan &&
    latestPlacementPreview.path === placementApplyPlan.path &&
    latestPlacementPreview.placement_validation_valid !== false &&
    (!latestPlacementFailure || latestPlacementFailure.index < latestPlacementPreview.index) &&
    !hasPlacementWriteSuccessAfter(toolResults, latestPlacementPreview.index)
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The host-aware placement preview succeeded, so I’ll apply the same ${placementApplyPlan.path === "/revit/create-similar-from-instance" ? "create-similar" : "place-on-host"} request instead of stopping at preview uncertainty, then I’ll verify the result.`,
      actions: [
        ...buildPlacementPreWriteGuardActions(),
        {
          action_id: randomUUID(),
          method: "POST",
          path: placementApplyPlan.path,
          body: placementApplyPlan.body
        }
      ]
    };
  }
  const canIssuePlacementPreview =
    !hasPlacementWriteAttempt ||
    (!hasPlacementWriteSucceeded && isRecoverablePlacementRetry(latestPlacementFailure, placementPlan)) ||
    (!hasPlacementWriteSucceeded &&
      countInvalidPlacementPreviews(toolResults, placementPlan?.path) < 2 &&
      isRecoverableInvalidPlacementPreview(latestPlacementPreview, placementPlan));
  if (
    placementPlan?.heuristic &&
    canIssuePlacementPreview &&
    requiresMeasuredRedlinePlacementTarget(req) &&
    !hasMeasuredRedlinePlacementTarget(spatialViewportHints, imageMarkHint)
  ) {
    if (!hasToolPath(toolResults, "/revit/computer-use-observe")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "I have the room/wall/exemplar context, but no measured redline-to-view target. " +
          "I will use visual computer-use observation before any write instead of placing from heuristic spacing.",
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/computer-use-observe",
            body: {
              includeScreenshot: true,
              maxDialogs: 8,
              onlyModal: false,
              reason: "redline placement needs measured visual target before write"
            }
          }
        ]
      };
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Answer: I stopped before placement because this redline request still has no measured target point in the Revit view. " +
        "The native context resolved the room/wall/exemplar, but the remaining placement plan used heuristic spacing, which can land on the right wall at the wrong distance. " +
        "I need successful view/redline alignment or a visual pick before writing.",
      actions: []
    };
  }
  if (
    placementPlan &&
    canIssuePlacementPreview
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        placementPlan.path === "/revit/create-similar-from-instance"
          ? `I resolved the exemplar host context and will preview ${placementPlan.requested_count} host-aware similar placement${placementPlan.requested_count === 1 ? "" : "s"} on the mapped wall before any commit${placementPlan.heuristic ? " using heuristic spacing where the redline marks were ambiguous" : " using the mapped redline offsets"}.`
          : `I resolved the exemplar host context and will preview a host-aware placement on the mapped wall before any commit${placementPlan.heuristic ? " using a heuristic offset because the redline mark was approximate" : " using the mapped redline offset"}.`,
      actions: [
        buildPlacementWarningGuardAction(),
        {
          action_id: randomUUID(),
          method: "POST",
          path: placementPlan.path,
          body: placementPlan.body
        }
      ]
    };
  }

  if (
    latestPlacementFailure &&
    latestPlacementPreview &&
    placementApplyPlan &&
    latestPlacementPreview.path === placementApplyPlan.path &&
    latestPlacementPreview.placement_validation_valid !== false &&
    latestPlacementPreview.index < latestPlacementFailure.index &&
    !hasPlacementWriteSuccessAfter(toolResults, latestPlacementPreview.index) &&
    isBridgeInterruptionPlacementFailure(latestPlacementFailure) &&
    countPlacementWriteFailuresAfter(toolResults, latestPlacementPreview.index) <= 1
  ) {
    if (!hasDoneToolPathAfter(toolResults, latestPlacementFailure.index, "/revit/computer-use-observe")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The apply call was interrupted after a valid placement preview, so I’ll check for a blocking Revit dialog before deciding whether to retry or audit.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/computer-use-observe",
            body: {
              includeScreenshot: true,
              maxDialogs: 8,
              onlyModal: false
            }
          }
        ]
      };
    }

    if (!hasDoneToolPathAfter(toolResults, latestPlacementFailure.index, "/revit/computer-use-act")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The apply call appears blocked by a Revit dialog after a valid preview, so I’ll dismiss the non-destructive blocker and retry the same placement once.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/computer-use-act",
            body: {
              button: "cancel",
              dialogIdContains: "Project_Not_Saved_Recently",
              interactionMode: "message_then_mouse",
              cursorRestoreMode: "keep",
              waitForDialogMs: 1500
            }
          }
        ]
      };
    }

    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The blocking dialog is clear and the prior preview was valid, so I’ll retry the same placement apply once, then verify the created element.`,
      actions: [
        ...buildPlacementPreWriteGuardActions(),
        {
          action_id: randomUUID(),
          method: "POST",
          path: placementApplyPlan.path,
          body: placementApplyPlan.body
        }
      ]
    };
  }

  if (latestPlacementFailure && !hasPlacementWriteSucceeded) {
    const failedPhase =
      latestPlacementPreview && latestPlacementPreview.index < latestPlacementFailure.index
        ? "apply failed or rolled back after a successful preview"
        : "placement preview failed";
    const failureNote = latestPlacementFailure.error ? ` Failure: ${latestPlacementFailure.error.slice(0, 280)}` : "";
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: I stopped after the same-room ${failedPhase} instead of pivoting to another room/unit. ` +
        `The failure needs a corrected host-aware retry or a fresh room-scoped placement context before any further write is safe.${failureNote}`,
      actions: []
    };
  }

  if (
    latestAppliedPlacement &&
    latestAppliedPlacement.created_element_ids.length > 0 &&
    !hasPlacementVerificationAfter(toolResults, latestAppliedPlacement.index)
  ) {
    const unresolvedCount = Math.max(0, latestAppliedPlacement.requested_count - latestAppliedPlacement.created_element_ids.length);
    const unresolvedNote =
      unresolvedCount > 0
        ? ` ${unresolvedCount} requested placement${unresolvedCount === 1 ? " is" : "s are"} still unresolved${latestAppliedPlacement.unresolved_labels.length > 0 ? ` (${latestAppliedPlacement.unresolved_labels.join(", ")})` : ""}.`
        : "";
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I placed ${latestAppliedPlacement.created_element_ids.length} element${latestAppliedPlacement.created_element_ids.length === 1 ? "" : "s"} ` +
        `(${latestAppliedPlacement.created_element_ids.join(", ")}) and will capture a focused post-change view to verify they landed at the marked locations.${unresolvedNote}`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/export-view-region",
          body: {
            viewId: spatialViewId,
            imageMaxSizePx: 2400,
            includeMapping: true,
            region: {
              mode: "focusElements",
              focusElementIds: latestAppliedPlacement.created_element_ids,
              marginFt: 8.0
            }
          }
        }
      ]
    };
  }

  return effectiveLocateCandidates.length > 0 ? null : null;
}

function maybeBuildCompletedHostedPlacementResponse(args: {
  req: ChatRequest;
  toolResults: ToolResult[];
  targetProfile: RedlineTargetingProfile;
}): ChatResponse | null {
  const latestApplied = extractLatestPlacementWriteSuccess(args.toolResults);
  if (!latestApplied || latestApplied.created_element_ids.length === 0) return null;
  const latestFailure = extractLatestPlacementWriteFailure(args.toolResults);
  if (latestFailure && latestFailure.index > latestApplied.index) return null;
  if (!hasPlacementVerificationAfter(args.toolResults, latestApplied.index)) return null;

  const explicitAudit = extractLatestPlacementAuditSummary({
    toolResults: args.toolResults,
    afterIndex: latestApplied.index,
    elementIds: latestApplied.created_element_ids
  });
  if (!explicitAudit) return null;

  const audit = summarizePlacementContextAuditAfter({
    toolResults: args.toolResults,
    afterIndex: latestApplied.index,
    createdElementIds: latestApplied.created_element_ids,
    roomNumber: args.targetProfile.room_number,
    requireRequestedWall: !!args.targetProfile.spatial_side
  });
  if (
    audit.invalid_ids.length > 0 ||
    audit.missing_ids.length > 0 ||
    audit.off_room_ids.length > 0 ||
    audit.off_wall_ids.length > 0 ||
    audit.unsupported_ids.length > 0
  ) {
    return null;
  }

  const recentText = getRecentUserTextForRedline(args.req);
  const requestedCircuit = extractRequestedPanelCircuit(recentText);
  const wantsSameCircuit = wantsElectricalCircuitMatch(recentText);
  const requiresSourceCircuitEvidence = wantsSameCircuit && requestedCircuit === null;
  const requiresCircuitEvidence = wantsSameCircuit || requestedCircuit !== null;
  const sourceCircuitLabel = sourceCircuitLabelForPlacement(args.toolResults, latestApplied);
  if (requiresSourceCircuitEvidence && !sourceCircuitLabel) return null;
  const circuitEvidence = mergePlacementWriteCircuitEvidence(
    extractCreatedElementCircuitEvidence({
      toolResults: args.toolResults,
      afterIndex: latestApplied.index,
      elementIds: latestApplied.created_element_ids
    }),
    latestApplied
  );
  if (requiresCircuitEvidence && latestApplied.created_element_ids.some((id) => !circuitEvidence.has(id))) return null;
  const expectedCircuitLabel = expectedCircuitLabelForPlacement(recentText, latestApplied, sourceCircuitLabel);
  if (
    expectedCircuitLabel &&
    latestApplied.created_element_ids.some((id) => {
      const observed = circuitEvidence.get(id) ?? "";
      return !observed || !circuitLabelsMatch(observed, expectedCircuitLabel);
    })
  ) {
    return null;
  }
  const observedCircuitText =
    circuitEvidence.size > 0
      ? ` Observed circuit${circuitEvidence.size === 1 ? "" : "s"}: ${[...circuitEvidence.entries()].map(([id, label]) => `${id}=${label}`).join(", ")}.`
      : "";
  const circuitText = observedCircuitText || (requestedCircuit ? ` Circuit target: ${requestedCircuit.panel}/${requestedCircuit.circuit}.` : "");
  const roomText = args.targetProfile.room_number ? ` in room ${args.targetProfile.room_number}` : "";
  const wallText = args.targetProfile.spatial_side ? " on the requested wall" : "";

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `Answer: Placed and verified receptacle ${latestApplied.created_element_ids.join(", ")}${roomText}${wallText}.` +
      `${circuitText} Verification passed with focused capture plus explicit hosted placement audit.`,
    actions: []
  };
}

function maybeBuildHostedPlacementVerificationBridge(args: {
  req: ChatRequest;
  toolResults: ToolResult[];
  targetProfile: RedlineTargetingProfile;
}): ChatResponse | null {
  const completed = maybeBuildCompletedHostedPlacementResponse(args);
  if (completed) return completed;

  const latestApplied = extractLatestPlacementWriteSuccess(args.toolResults);
  if (!latestApplied || latestApplied.created_element_ids.length === 0) return null;
  const latestFailure = extractLatestPlacementWriteFailure(args.toolResults);
  if (latestFailure && latestFailure.index > latestApplied.index) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: A later placement attempt failed after the previous verified placement, so I am not reusing the stale success state. ` +
        `${latestFailure.error ? `Latest placement failure: ${latestFailure.error.slice(0, 260)}` : "The latest placement write failed or rolled back."}`,
      actions: []
    };
  }

  const hasVerification = hasPlacementVerificationAfter(args.toolResults, latestApplied.index);
  if (!hasVerification) {
    const frameContext = extractLatestFrameImageContext(args.toolResults);
    const viewId = frameContext?.view_id ?? extractActiveModelViewIdFromContext(args.req.context);
    if (viewId !== null && viewId > 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I placed ${latestApplied.created_element_ids.length} element${latestApplied.created_element_ids.length === 1 ? "" : "s"} ` +
          `(${latestApplied.created_element_ids.join(", ")}) and will capture a focused post-change view before final audit.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/export-view-region",
            body: {
              viewId,
              imageMaxSizePx: 2400,
              includeMapping: true,
              region: {
                mode: "focusElements",
                focusElementIds: latestApplied.created_element_ids,
                marginFt: 8.0
              }
            }
          }
        ]
      };
    }
  }

  const explicitAudit = extractLatestPlacementAuditSummary({
    toolResults: args.toolResults,
    afterIndex: latestApplied.index,
    elementIds: latestApplied.created_element_ids
  });
  if (!explicitAudit) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I’ll run the explicit hosted placement audit for created id${latestApplied.created_element_ids.length === 1 ? "" : "s"} ` +
        `${latestApplied.created_element_ids.join(", ")} before treating this placement as complete.`,
      actions: [
        buildHostedPlacementAuditAction({
          createdElementIds: latestApplied.created_element_ids,
          roomNumber: args.targetProfile.room_number,
          roomSide: args.targetProfile.spatial_side_source ?? args.targetProfile.spatial_side,
          targetChainageFt: latestApplied.target_chainage_ft,
          targetNormalizedChainage: latestApplied.target_normalized_chainage,
          targetPointXyz: latestApplied.target_point_xyz,
          targetToleranceFt: 0.5
        })
      ]
    };
  }

  const recentText = getRecentUserTextForRedline(args.req);
  const requestedCircuit = extractRequestedPanelCircuit(recentText);
  const wantsSameCircuit = wantsElectricalCircuitMatch(recentText);
  const requiresSourceCircuitEvidence = wantsSameCircuit && requestedCircuit === null;
  const requiresCircuitEvidence = wantsSameCircuit || requestedCircuit !== null;
  const sourceId = sourceElementIdForPlacement(args.toolResults, latestApplied);
  if (requiresCircuitEvidence) {
    const sourceCircuitLabel = sourceCircuitLabelForPlacement(args.toolResults, latestApplied);
    if (requiresSourceCircuitEvidence && !sourceCircuitLabel) {
      if (sourceId !== null && sourceId > 0 && !hasDoneToolPathAfter(args.toolResults, latestApplied.index, "/revit/get-parameters")) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `The hosted placement audit passed, but I still need the adjacent/source receptacle circuit readback before treating this same-circuit request as complete.`,
          actions: [
            {
              action_id: randomUUID(),
              method: "POST",
              path: "/revit/get-parameters",
              body: {
                elementIds: [sourceId, ...latestApplied.created_element_ids],
                names: ["Panel", "Circuit Number", "Circuit", "Electrical Circuit", "Family", "Type", "Family and Type", "Type Name"]
              }
            }
          ]
        };
      }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Answer: I verified the created element geometry, but I do not have circuit evidence for the adjacent/source receptacle. ` +
          `I am not treating this same-circuit placement as complete without source and created-device panel/circuit readback.`,
        actions: []
      };
    }
    const circuitEvidence = mergePlacementWriteCircuitEvidence(
      extractCreatedElementCircuitEvidence({
        toolResults: args.toolResults,
        afterIndex: latestApplied.index,
        elementIds: latestApplied.created_element_ids
      }),
      latestApplied
    );
    const missingCircuitIds = latestApplied.created_element_ids.filter((id) => !circuitEvidence.has(id));
    if (missingCircuitIds.length > 0 && !hasDoneToolPathAfter(args.toolResults, explicitAudit.index, "/revit/get-parameters")) {
      const circuitReadbackIds = [
        ...(wantsSameCircuit && sourceId !== null ? [sourceId] : []),
        ...latestApplied.created_element_ids
      ].filter((id, index, ids) => id > 0 && ids.indexOf(id) === index);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The hosted placement audit passed for ${latestApplied.created_element_ids.join(", ")}, but I still need source/created circuit readback before treating this same-circuit request as complete.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/get-parameters",
            body: {
              elementIds: circuitReadbackIds,
              names: ["Panel", "Circuit Number", "Circuit", "Electrical Circuit", "Family", "Type", "Family and Type", "Type Name"]
            }
          }
        ]
      };
    }
    if (missingCircuitIds.length > 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Answer: I verified the created element geometry, but I do not have circuit evidence for created id${missingCircuitIds.length === 1 ? "" : "s"} ${missingCircuitIds.join(", ")}. ` +
          `I am not treating this same-circuit receptacle placement as complete without panel/circuit readback or native audit evidence.`,
        actions: []
      };
    }
    const expectedCircuitLabel = expectedCircuitLabelForPlacement(recentText, latestApplied, sourceCircuitLabel);
    const mismatchedCircuitIds = expectedCircuitLabel
      ? latestApplied.created_element_ids.filter((id) => {
          const observed = circuitEvidence.get(id) ?? "";
          return !observed || !circuitLabelsMatch(observed, expectedCircuitLabel);
        })
      : [];
    if (
      mismatchedCircuitIds.length > 0 &&
      !hasDoneToolPathAfter(args.toolResults, latestApplied.index, "/revit/assign-electrical-circuit") &&
      (requestedCircuit || sourceId !== null)
    ) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `The hosted placement audit passed, but created id${mismatchedCircuitIds.length === 1 ? "" : "s"} ${mismatchedCircuitIds.join(", ")} ` +
          `do not yet match the requested circuit ${expectedCircuitLabel}. I’ll correct the electrical system membership before final verification.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/assign-electrical-circuit",
            body: {
              elementIds: mismatchedCircuitIds,
              ...(requestedCircuit
                ? { panelName: requestedCircuit.panel, circuitNumber: requestedCircuit.circuit, parameterOnlyFallback: false }
                : { sourceElementId: sourceId }),
              dryRun: false,
              confirm: true
            }
          }
        ]
      };
    }
    if (mismatchedCircuitIds.length > 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Answer: I verified the created element geometry, but circuit verification failed for created id${mismatchedCircuitIds.length === 1 ? "" : "s"} ${mismatchedCircuitIds.join(", ")}. ` +
          `Expected ${expectedCircuitLabel}; observed ${mismatchedCircuitIds.map((id) => `${id}=${circuitEvidence.get(id) ?? "unknown"}`).join(", ")}.`,
        actions: []
      };
    }
  }

  return null;
}

function maybeBuildRedlineExecutionBridgeCore(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
  toolResults: ToolResult[];
}): ChatResponse | null {
  const { req, workbenchResults, toolResults } = args;
  const viewportFromWorkbench = extractViewportPickHintsFromWorkbench(workbenchResults);
  const sheetFromWorkbench = extractSheetPickHintsFromWorkbench(workbenchResults);
  if (viewportFromWorkbench.length > 0) noteViewportPickHints(req.session_id, viewportFromWorkbench);
  if (sheetFromWorkbench.length > 0) noteSheetPickHints(req.session_id, sheetFromWorkbench);

  let viewportHints = dedupeViewportPickHints(
    (viewportFromWorkbench.length > 0 ? viewportFromWorkbench : getPersistedViewportPickHints(req.session_id)).slice(0, 24)
  );
  const sheetHints = dedupeSheetPickHints(
    (sheetFromWorkbench.length > 0 ? sheetFromWorkbench : getPersistedSheetPickHints(req.session_id)).slice(0, 40)
  );
  const latestSheet = extractLatestSheetDetailForRedline(toolResults);
  if (latestSheet && Array.isArray(latestSheet.viewport_geometry) && latestSheet.viewport_geometry.length > 0) {
    const allowedViewIds = new Set<number>();
    for (const vg of latestSheet.viewport_geometry) {
      const vid = toFiniteInt((vg as Record<string, unknown>).viewId);
      if (vid !== null && vid > 0) allowedViewIds.add(vid);
    }
    if (allowedViewIds.size > 0) {
      viewportHints = viewportHints.filter((h) => allowedViewIds.has(h.view_id));
    }
    const viewTypeById = latestSheet.placed_view_types_by_id ?? {};
    if (viewportHints.length > 0 && viewTypeById && typeof viewTypeById === "object") {
      viewportHints = viewportHints.filter((h) => {
        const vt = typeof viewTypeById[String(h.view_id)] === "string" ? String(viewTypeById[String(h.view_id)]) : "";
        return !isViewTypeUnsupportedForExportViewFrame(vt);
      });
    }
  }
  const geminiIntents = getPersistedGeminiIntentHints(req.session_id);
  const annotationRegionHints = getPersistedAnnotationRegionHints(req.session_id);
  const semanticCorpus = buildRedlineSemanticCorpus(req, workbenchResults);
  if (isMepRouteRedlineIntent(semanticCorpus)) return null;
  const explicitTextWallSide = extractSpatialWallSide(semanticCorpus).side;
  const canOverrideImageDerivedWallSide = explicitTextWallSide === null;
  let targetProfile = hydrateRedlineTargetingProfile({
    sessionId: req.session_id,
    profile: inferRedlineTargetingProfileFromText(semanticCorpus, geminiIntents, annotationRegionHints),
    toolResults
  });
  if (!targetProfile.room_number) {
    const ocrRoom = extractRedlineOcrSpatialRoomNumber(semanticCorpus);
    if (ocrRoom) targetProfile = { ...targetProfile, room_number: ocrRoom };
  }
  if (!targetProfile.room_number) {
    const userRequestedCircuit = extractRequestedPanelCircuit(getRecentUserTextForRedline(req));
    const circuitRoom = inferRoomNumberFromVisibleInventoryCircuit(toolResults, userRequestedCircuit);
    if (circuitRoom) targetProfile = { ...targetProfile, room_number: circuitRoom };
  }

  if (
    !targetProfile.resolve_only ||
    hasExplicitMoveRedlineContinuation(req, toolResults) ||
    hasExplicitRotateRedlineContinuation(req, toolResults)
  ) {
    const deleteApplyEvidence = latestDeleteApplyEvidence(toolResults);
    if (deleteApplyEvidence) {
      const allDeleted = deleteApplyEvidence.requestedIds.every((id) => deleteApplyEvidence.deletedIds.includes(id));
      const dryRunProven = hasPriorDeleteDryRunCovering(toolResults, deleteApplyEvidence.requestedIds, deleteApplyEvidence.result);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: allDeleted && dryRunProven
          ? `Deleted the redline-targeted element id(s) ${deleteApplyEvidence.requestedIds.join(", ")} after dry-run verification.`
          : !dryRunProven
            ? `I stopped after the delete apply response because I cannot prove a prior dry-run covered every applied redline target id. Requested: ${deleteApplyEvidence.requestedIds.join(", ")}.`
            : `I stopped after the delete apply response because it did not prove every requested redline target was deleted. Requested: ${deleteApplyEvidence.requestedIds.join(", ")}; reported: ${deleteApplyEvidence.deletedIds.join(", ") || "none"}.`,
        actions: []
      };
    }

    const deleteDryRun = latestDeleteDryRunForApply(toolResults);
    if (deleteDryRun) {
      const dryRunCovered = deleteDryRun.requestedIds.every((id) => deleteDryRun.dryRunIds.includes(id));
      if (!dryRunCovered) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `I stopped before applying the redline delete because the dry-run did not prove every requested target id. ` +
            `Requested: ${deleteDryRun.requestedIds.join(", ")}; dry-run reported: ${deleteDryRun.dryRunIds.join(", ") || "none"}.`,
          actions: []
        };
      }
      if (!redlineTextAllowsDeleteApply(req)) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `Dry-run delete verified the redline target id(s) ${deleteDryRun.requestedIds.join(", ")}. ` +
            "I did not apply the delete because the request asked for preview/no model write behavior.",
          actions: []
        };
      }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Dry-run delete verified redline target id(s) ${deleteDryRun.requestedIds.join(", ")}; I’ll apply exactly that bounded delete set now.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/delete",
            body: {
              ids: deleteDryRun.requestedIds,
              apply: true
            }
          }
        ]
      };
    }

    const moveApplyEvidence = latestMoveApplyEvidence(toolResults);
    if (moveApplyEvidence) {
      const allMoved = moveApplyEvidence.requestedIds.every((id) => moveApplyEvidence.movedIds.includes(id));
      const dryRunProven = hasPriorMoveDryRunCovering(toolResults, moveApplyEvidence.requestedIds, moveApplyEvidence.result);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: allMoved && dryRunProven
          ? `Moved the redline-targeted element id(s) ${moveApplyEvidence.requestedIds.join(", ")} after dry-run verification.`
          : !dryRunProven
            ? `I stopped after the move apply response because I cannot prove a prior dry-run covered every applied redline target id. Requested: ${moveApplyEvidence.requestedIds.join(", ")}.`
            : `I stopped after the move apply response because it did not prove every requested redline target was moved. Requested: ${moveApplyEvidence.requestedIds.join(", ")}; reported: ${moveApplyEvidence.movedIds.join(", ") || "none"}.`,
        actions: []
      };
    }

    const moveDryRun = latestMoveDryRunForApply(toolResults);
    if (moveDryRun) {
      const dryRunCovered = moveDryRun.requestedIds.every((id) => moveDryRun.dryRunIds.includes(id));
      if (!dryRunCovered) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `I stopped before applying the redline move because the dry-run did not prove every requested target id. ` +
            `Requested: ${moveDryRun.requestedIds.join(", ")}; dry-run reported: ${moveDryRun.dryRunIds.join(", ") || "none"}.`,
          actions: []
        };
      }
      if (!redlineTextAllowsDeleteApply(req)) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `Dry-run move verified the redline target id(s) ${moveDryRun.requestedIds.join(", ")}. ` +
            "I did not apply the move because the request asked for preview/no model write behavior.",
          actions: []
        };
      }
      const replayBody = extractReplayableMoveBody(moveDryRun.result.result_json, moveDryRun.requestedIds);
      if (!replayBody) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `Dry-run move verified redline target id(s) ${moveDryRun.requestedIds.join(", ")}, ` +
            "but the dry-run result did not include a replayable model-space vector. I stopped before applying an under-specified move.",
          actions: []
        };
      }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Dry-run move verified redline target id(s) ${moveDryRun.requestedIds.join(", ")}; I’ll apply exactly that bounded move set now.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/move-elements",
            body: replayBody
          }
        ]
      };
    }

    const rotateApplyEvidence = latestRotateApplyEvidence(toolResults);
    if (rotateApplyEvidence) {
      const allRotated = rotateApplyEvidence.requestedIds.every((id) => rotateApplyEvidence.rotatedIds.includes(id));
      const dryRunProven = hasPriorRotateDryRunCovering(toolResults, rotateApplyEvidence.requestedIds, rotateApplyEvidence.result);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: allRotated && dryRunProven
          ? `Rotated the redline-targeted element id(s) ${rotateApplyEvidence.requestedIds.join(", ")} after dry-run verification.`
          : !dryRunProven
            ? `I stopped after the rotate apply response because I cannot prove a prior dry-run covered every applied redline target id. Requested: ${rotateApplyEvidence.requestedIds.join(", ")}.`
            : `I stopped after the rotate apply response because it did not prove every requested redline target was rotated. Requested: ${rotateApplyEvidence.requestedIds.join(", ")}; reported: ${rotateApplyEvidence.rotatedIds.join(", ") || "none"}.`,
        actions: []
      };
    }

    const rotateDryRun = latestRotateDryRunForApply(toolResults);
    if (rotateDryRun) {
      const dryRunCovered = rotateDryRun.requestedIds.every((id) => rotateDryRun.dryRunIds.includes(id));
      if (!dryRunCovered) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `I stopped before applying the redline rotate because the dry-run did not prove every requested target id. ` +
            `Requested: ${rotateDryRun.requestedIds.join(", ")}; dry-run reported: ${rotateDryRun.dryRunIds.join(", ") || "none"}.`,
          actions: []
        };
      }
      if (!redlineTextAllowsDeleteApply(req)) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `Dry-run rotate verified the redline target id(s) ${rotateDryRun.requestedIds.join(", ")}. ` +
            "I did not apply the rotate because the request asked for preview/no model write behavior.",
          actions: []
        };
      }
      const replayBody = extractReplayableRotateBody(rotateDryRun.result.result_json, rotateDryRun.requestedIds);
      if (!replayBody) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `Dry-run rotate verified redline target id(s) ${rotateDryRun.requestedIds.join(", ")}, ` +
            "but the dry-run result did not include a replayable rotation axis and angle. I stopped before applying an under-specified rotate.",
          actions: []
        };
      }
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Dry-run rotate verified redline target id(s) ${rotateDryRun.requestedIds.join(", ")}; I’ll apply exactly that bounded rotate set now.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/rotate-elements",
            body: replayBody
          }
        ]
      };
    }
  }

  if (!targetProfile.room_number) {
    const imageMarkHint = getPersistedImageMarkHint(req.session_id) ?? imageMarkHintFromViewportHints(viewportHints);
    const profileSide = targetProfile.spatial_side ?? normalizeSpatialWallSide(imageMarkHint?.side ?? "");
    const preferAdjacentCircuitContext = wantsElectricalCircuitMatch(semanticCorpus);
    const shouldWaitForRicherAdjacentInventory =
      preferAdjacentCircuitContext &&
      countToolPath(toolResults, "/revit/export-visible-elements") < 2 &&
      !latestVisibleInventoryIsCompacted(toolResults);
    const adjacentInference = preferAdjacentCircuitContext
      ? inferRoomAndSideFromVisibleAdjacentDeviceContext({
          toolResults,
          markHint: imageMarkHint,
          markedSide: profileSide
        })
      : null;
    const adjacentRoom = adjacentInference?.room_number ?? null;
    const dominantRoom = shouldWaitForRicherAdjacentInventory
      ? null
      : inferRoomNumberFromVisibleInventoryDominantContext({
          toolResults,
          markHint: imageMarkHint,
          markedSide: profileSide,
          preferAdjacentCircuitContext
        });
    const inventoryRoom =
      inferRoomNumberFromSplitVisibleUnitLabels(toolResults, imageMarkHint) ??
      inferRoomNumberFromVisibleInventorySpatialHint(toolResults, imageMarkHint, profileSide) ??
      adjacentRoom ??
      dominantRoom;
    if (inventoryRoom) {
      const inferredSide =
        (inventoryRoom === adjacentRoom ? adjacentInference?.spatial_side ?? null : null) ??
        targetProfile.spatial_side ??
        profileSide;
      targetProfile = {
        ...targetProfile,
        room_number: inventoryRoom,
        ...(inferredSide && (!targetProfile.spatial_side || canOverrideImageDerivedWallSide) ? { spatial_side: inferredSide } : {}),
        ...(inferredSide && (!targetProfile.spatial_side_source || canOverrideImageDerivedWallSide) ? { spatial_side_source: inferredSide } : {})
      };
    }
  }
  if (!targetProfile.room_number && targetProfile.resolve_only && targetProfile.pick_preference === "modelGeometry") {
    const imageMarkHint = getPersistedImageMarkHint(req.session_id) ?? imageMarkHintFromViewportHints(viewportHints);
    const preferAdjacentCircuitContext = wantsElectricalCircuitMatch(semanticCorpus);
    const adjacentInference = preferAdjacentCircuitContext
      ? inferRoomAndSideFromVisibleAdjacentDeviceContext({
          toolResults,
          markHint: imageMarkHint,
          markedSide: targetProfile.spatial_side,
          knownRoomNumber: targetProfile.room_number
        })
      : null;
    const adjacentRoom = adjacentInference?.room_number ?? null;
    const shouldWaitForRicherAdjacentInventory =
      preferAdjacentCircuitContext &&
      countToolPath(toolResults, "/revit/export-visible-elements") < 2 &&
      !latestVisibleInventoryIsCompacted(toolResults);
    const dominantRoom = shouldWaitForRicherAdjacentInventory
      ? null
      : inferRoomNumberFromVisibleInventoryDominantContext({
          toolResults,
          markHint: imageMarkHint,
          markedSide: targetProfile.spatial_side,
          preferAdjacentCircuitContext
        });
    const summaryRoom =
      inferRoomNumberFromSplitVisibleUnitLabels(toolResults, imageMarkHint) ??
      adjacentRoom ??
      dominantRoom ??
      (preferAdjacentCircuitContext && countToolPath(toolResults, "/revit/export-visible-elements") < 2
        ? null
        : inferRoomNumberFromVisibleInventorySummary(toolResults));
    if (summaryRoom) {
      const inferredSide =
        (summaryRoom === adjacentRoom ? adjacentInference?.spatial_side ?? null : null) ??
        targetProfile.spatial_side ??
        normalizeSpatialWallSide(imageMarkHint?.side ?? "");
      targetProfile = {
        ...targetProfile,
        room_number: summaryRoom,
        ...(inferredSide && (!targetProfile.spatial_side || canOverrideImageDerivedWallSide) ? { spatial_side: inferredSide } : {}),
        ...(inferredSide && (!targetProfile.spatial_side_source || canOverrideImageDerivedWallSide) ? { spatial_side_source: inferredSide } : {})
      };
    }
  }
  if (
    targetProfile.room_number &&
    targetProfile.resolve_only &&
    targetProfile.pick_preference === "modelGeometry" &&
    wantsElectricalCircuitMatch(semanticCorpus)
  ) {
    const imageMarkHint = getPersistedImageMarkHint(req.session_id) ?? imageMarkHintFromViewportHints(viewportHints);
    const imageSide = normalizeSpatialWallSide(imageMarkHint?.side ?? "");
    const adjacentInference = inferRoomAndSideFromVisibleAdjacentDeviceContext({
      toolResults,
      markHint: imageMarkHint,
      markedSide: imageSide,
      knownRoomNumber: targetProfile.room_number
    });
    const inferredSide =
      (adjacentInference?.room_number === targetProfile.room_number ? adjacentInference.spatial_side : null) ??
      (!targetProfile.spatial_side ? imageSide : null);
    const shouldApplySide =
      !!inferredSide &&
      (!targetProfile.spatial_side ||
        (canOverrideImageDerivedWallSide &&
          adjacentInference?.room_number === targetProfile.room_number &&
          adjacentInference.spatial_side === inferredSide &&
          inferredSide !== targetProfile.spatial_side));
    if (shouldApplySide) {
      targetProfile = {
        ...targetProfile,
        spatial_side: inferredSide,
        spatial_side_source: inferredSide
      };
    }
  }
  {
    const persistedImageMarkHint = getPersistedImageMarkHint(req.session_id) ?? imageMarkHintFromViewportHints(viewportHints);
    const mappedMarkSide = normalizeSpatialWallSide(persistedImageMarkHint?.side ?? "");
    const hydratedProfile = hydrateTargetProfileFromVisibleInventory({
      targetProfile,
      toolResults,
      markHint: persistedImageMarkHint,
      mappedMarkSide,
      semanticCorpus,
      allowRoomOverride: false
    });
    if (
      hydratedProfile.room_number !== targetProfile.room_number ||
      hydratedProfile.spatial_side !== targetProfile.spatial_side ||
      hydratedProfile.spatial_side_source !== targetProfile.spatial_side_source
    ) {
      targetProfile = hydratedProfile;
    }
  }
  noteRedlineSpatialTargeting(req.session_id, targetProfile);
  const resolvedRoomPlanView = extractLatestResolvedRoomPlanView(toolResults, targetProfile.room_number);
  const listedViews = extractLatestListedViews(toolResults);
  const heuristicModelView = chooseLikelyRedlineModelView({
    views: listedViews,
    targetProfile,
    semanticCorpus
  });
  const sheetViewId = latestSheet?.view_id ?? extractActiveSheetViewIdFromContext(req.context);
  const activeModelViewId = extractActiveModelViewIdFromContext(req.context);
  const activeModelView = extractActiveViewSummaryFromContext(req.context);
  const preferredModelViewToken = inferPreferredRedlineViewNameToken(targetProfile, semanticCorpus);
  const activeModelViewMatchesPreferredToken =
    activeModelViewId !== null &&
    activeModelView.id === activeModelViewId &&
    viewNameMatchesPreferredToken(activeModelView.name, preferredModelViewToken);
  const modelGeometryTargeting = targetProfile.pick_preference === "modelGeometry";
  const primaryPlacedModelViewId = modelGeometryTargeting
    ? extractPrimaryPlacedModelViewIdForRedline(latestSheet)
    : null;
  const completedHostedPlacement = maybeBuildCompletedHostedPlacementResponse({
    req,
    toolResults,
    targetProfile
  });
  if (completedHostedPlacement) return completedHostedPlacement;
  const hostedPlacementVerification = maybeBuildHostedPlacementVerificationBridge({
    req,
    toolResults,
    targetProfile
  });
  if (hostedPlacementVerification) return hostedPlacementVerification;
  if (
    modelGeometryTargeting &&
    targetProfile.room_number &&
    !resolvedRoomPlanView &&
    !activeModelViewId &&
    !primaryPlacedModelViewId &&
    !hasToolPath(toolResults, "/revit/resolve-room-plan-view")
  ) {
    const preferViewNameContains = inferPreferredRedlineViewNameToken(targetProfile, semanticCorpus);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `I’m on a sheet/drafting context, so I’ll resolve a real model plan view for room ${targetProfile.room_number} before placing anything.` +
        `${preferViewNameContains ? ` I’ll bias toward views with '${preferViewNameContains}' in the name.` : ""}`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-room-plan-view",
          body: {
            roomNumber: targetProfile.room_number,
            ...(preferViewNameContains ? { preferViewNameContains } : {}),
            maxCandidates: 8
          }
        }
      ]
    };
  }
  const hostedPlacementDiscoveryStarted =
    hasToolPath(toolResults, "/revit/get-placement-context") ||
    hasToolPath(toolResults, "/revit/resolve-room-wall") ||
    hasToolPath(toolResults, "/revit/rank-similar-devices-on-wall") ||
    hasToolPath(toolResults, "/revit/pick-candidate-cluster") ||
    hasToolPath(toolResults, "/revit/create-similar-from-instance") ||
    hasToolPath(toolResults, "/revit/place-family-instance-on-host") ||
    hasToolPath(toolResults, "/revit/audit-hosted-instance-placement") ||
    hasToolPath(toolResults, "/revit/export-view-region");
  if (
    modelGeometryTargeting &&
    targetProfile.room_number &&
    !resolvedRoomPlanView &&
    activeModelViewId !== null &&
    preferredModelViewToken &&
    !activeModelViewMatchesPreferredToken &&
    !primaryPlacedModelViewId &&
    listedViews.length === 0 &&
    !hostedPlacementDiscoveryStarted &&
    !hasToolPath(toolResults, "/revit/resolve-room-plan-view")
  ) {
    const alreadyExportedGenericContext =
      hasToolPath(toolResults, "/revit/export-view-frame") || hasToolPath(toolResults, "/revit/export-visible-elements");
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        alreadyExportedGenericContext
          ? `Room ${targetProfile.room_number} is resolved, but the exported frame/inventory is from ${activeModelView.name ?? `view ${activeModelViewId}`}. ` +
            `I’ll switch to the best ${preferredModelViewToken}/electrical plan for that room before continuing placement.`
          : `Room ${targetProfile.room_number} is resolved, but the active model view is ${activeModelView.name ?? `view ${activeModelViewId}`}. ` +
            `I’ll resolve the best ${preferredModelViewToken}/electrical plan for that room before exporting geometry.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-room-plan-view",
          body: {
            roomNumber: targetProfile.room_number,
            preferViewNameContains: preferredModelViewToken,
            maxCandidates: 8
          }
        }
      ]
    };
  }
  const preferSheetTargeting =
    !modelGeometryTargeting &&
    sheetHints.length > 0 &&
    !!sheetViewId &&
    (sheetHints.length >= viewportHints.length || viewportHints.length === 0);
  if (
    modelGeometryTargeting &&
    activeModelViewId !== null &&
    preferredModelViewToken &&
    !activeModelViewMatchesPreferredToken &&
    listedViews.length === 0 &&
    !targetProfile.room_number &&
    !hasToolPath(toolResults, "/revit/export-view-frame") &&
    !hasToolPath(toolResults, "/revit/export-visible-elements") &&
    !hasToolPath(toolResults, "/revit/views")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `The active model view is ${activeModelView.name ?? `view ${activeModelViewId}`}, but this is an electrical redline. ` +
        `I’ll list project views first so I can prefer a ${preferredModelViewToken}/electrical plan before exporting a frame.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "GET",
          path: "/revit/views"
        }
      ]
    };
  }
  const modelFallbackViewId =
    resolvedRoomPlanView?.best_view_id ??
    primaryPlacedModelViewId ??
    (activeModelViewMatchesPreferredToken ? activeModelViewId : null) ??
    heuristicModelView?.id ??
    activeModelViewId ??
    null;
  const targetViewId =
    (preferSheetTargeting ? sheetViewId : null) ??
    (modelGeometryTargeting ? modelFallbackViewId : null) ??
    (viewportHints.length > 0 ? viewportHints[0]!.view_id : null) ??
    modelFallbackViewId ??
    sheetViewId;

  if (targetViewId === null || targetViewId <= 0) {
    if (
      targetProfile.room_number &&
      (targetProfile.pick_preference === "modelGeometry" || isSpatialPlacementTargetingProfile(targetProfile)) &&
      !resolvedRoomPlanView &&
      !hasToolPath(toolResults, "/revit/resolve-room-plan-view")
    ) {
      const preferViewNameContains = inferPreferredRedlineViewNameToken(targetProfile, semanticCorpus);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I don’t have a sheet/view anchor yet, so I’ll resolve the best plan view for room ${targetProfile.room_number} before mapping this redline into model space.` +
          `${preferViewNameContains ? ` I’ll bias toward views with '${preferViewNameContains}' in the name.` : ""}`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/resolve-room-plan-view",
            body: {
              roomNumber: targetProfile.room_number,
              ...(preferViewNameContains ? { preferViewNameContains } : {}),
              maxCandidates: 8
            }
          }
        ]
      };
    }

    if (
      targetProfile.resolve_only &&
      targetProfile.pick_preference === "modelGeometry" &&
      listedViews.length === 0 &&
      !hasToolPath(toolResults, "/revit/views")
    ) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "I still need a model-view anchor for this redline, so I’ll list the project views and score likely plan views instead of assuming the active view.",
        actions: [
          {
            action_id: randomUUID(),
            method: "GET",
            path: "/revit/views"
          }
        ]
      };
    }

    return null;
  }

  if (hasToolPath(toolResults, "/revit/find-elements")) markSheetFindAttempt(req.session_id);
  if (hasToolPath(toolResults, "/revit/get-element-summary")) markSheetSummaryAttempt(req.session_id);
  const latestFindIds = extractLatestFindElementsIds(toolResults);
  if (latestFindIds.length > 0) noteSheetCandidateIds(req.session_id, latestFindIds);
  const sheetCandidateIds = latestFindIds.length > 0 ? latestFindIds : getPersistedSheetCandidateIds(req.session_id);
  const regionBoxes = getPersistedSheetRegionBoxes(req.session_id);
  const findSheetRegions = toFindElementsSheetRegions(regionBoxes, 48);
  const hasFindSheetRegions = findSheetRegions.length > 0;

  const seed = getRedlineSessionSeed(req.session_id);
  const anchoredSheetNumber = latestSheet?.sheet_number ?? normalizeExpectedSheet(seed?.expected_sheet ?? null);
  const isSheetViewTarget = sheetViewId !== null && targetViewId === sheetViewId;

  // Once a hosted placement has been verified, finish that workflow before any
  // sheet-baseline preflight can redirect the turn into annotation discovery.
  if (isSheetViewTarget && extractLatestPlacementWriteSuccess(toolResults)) {
    const spatialRefinement = maybeBuildSpatialRedlineRefinementBridge({
      req,
      toolResults,
      targetProfile,
      targetViewId: primaryPlacedModelViewId ?? targetViewId,
      preferSheetTargeting: false,
      viewportHints
    });
    if (spatialRefinement) return spatialRefinement;
  }

  // Deterministic preflight: ensure a clean sheet PDF exists in artifacts/prints so analyze/orient
  // can run baseline diff instead of relying only on annotation/color fallbacks.
  if (isSheetViewTarget && seed?.file_path) {
    const hasBaseline = !!extractLatestExportPdfBaselinePathFromToolResults(toolResults);
    const hasExportResult = hasToolPath(toolResults, "/revit/export-pdf");
    const hasAttempted = hasRedlineBaselineExportAttempt(req.session_id, seed.file_path);
    if (!hasBaseline && !hasExportResult && !hasAttempted && latestSheet?.view_id) {
      noteRedlineBaselineExportAttempt(req.session_id, seed.file_path);
      const baseSheet = anchoredSheetNumber || `SHEET_${Math.round(latestSheet.view_id)}`;
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I’ll export a clean current PDF of sheet ${baseSheet} first so redline preflight can diff against a reliable baseline before execution.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/export-pdf",
            body: {
              viewIds: [Math.round(latestSheet.view_id)],
              combine: true,
              outputFolder: "artifacts/prints",
              baseFileName: `${baseSheet}_clean_baseline`,
              colorMode: "Color"
            }
          }
        ]
      };
    }
  }

  if (isSheetViewTarget) {
    if (!latestSheet) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `I’ll resolve sheet detail for view ${targetViewId} first so I can continue with sheet-safe redline targeting.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/sheets",
            body: {
              action: "detail",
              viewId: targetViewId,
              includePlacedViews: true,
              includeViewports: true,
              includeViewportGeometry: true,
              includeTitleBlocks: true,
              includeSheetOutline: true
            }
          }
        ]
      };
    }

    if (sheetCandidateIds.length === 0 && !hasSheetFindAttempt(req.session_id) && anchoredSheetNumber) {
      markSheetFindAttempt(req.session_id);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          hasFindSheetRegions
            ? `export-view-frame does not support DrawingSheet views, so I’ll resolve ${targetProfile.scope_label} element IDs by querying region-overlapping elements on sheet ${anchoredSheetNumber}.`
            : `export-view-frame does not support DrawingSheet views, so I’ll query sheet-owned ${targetProfile.scope_label} elements on ${anchoredSheetNumber} instead of trying frame export.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/find-elements",
            body: {
              sheetNumber: anchoredSheetNumber,
              includeSheetElements: true,
              includeViewportElements: true,
              ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
              ...(hasFindSheetRegions
                ? {
                    sheetRegions: findSheetRegions,
                    regionPaddingFt: targetProfile.region_padding_ft
                  }
                : {}),
              limit: 200
            }
          }
        ]
      };
    }

    if (sheetCandidateIds.length > 0 && !hasSheetSummaryAttempt(req.session_id)) {
      markSheetSummaryAttempt(req.session_id);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I found ${sheetCandidateIds.length} sheet-owned candidate elements and will fetch summaries so we can resolve the redline target IDs without frame export.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/get-element-summary",
            body: {
              elementIds: sheetCandidateIds.slice(0, 40),
              viewId: targetViewId
            }
          }
        ]
      };
    }

    if (hasSheetFindAttempt(req.session_id) && sheetCandidateIds.length === 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Answer: I switched away from export-view-frame because sheet views are unsupported for that tool, " +
          `but sheet-level candidate lookup returned no selectable ${targetProfile.scope_label} elements for this redline region. ` +
          "Please confirm one concrete target element (or a precise note/text anchor), and I will execute directly.",
        actions: []
      };
    }

    const summaryCandidates = extractLatestSheetSummaryCandidates(toolResults);
    const parameterTextById = extractLatestSheetParameterTextById(toolResults);
    const parameterCoverage = sheetCandidateIds.filter((id) => parameterTextById.has(id)).length;
    const spatialRefinement = maybeBuildSpatialRedlineRefinementBridge({
      req,
      toolResults,
      targetProfile,
      targetViewId,
      preferSheetTargeting,
      viewportHints
    });
    if (spatialRefinement) return spatialRefinement;

    if (targetProfile.resolve_only) {
      if (sheetCandidateIds.length > 0 && parameterCoverage === 0 && !hasToolPath(toolResults, "/revit/get-parameters")) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            `I resolved ${sheetCandidateIds.length} ${targetProfile.scope_label} candidates from the marked sheet region and will read their parameters before continuing with the requested change.`,
          actions: [
            {
              action_id: randomUUID(),
              method: "POST",
              path: "/revit/get-parameters",
              body: {
                elementIds: sheetCandidateIds.slice(0, 80),
                names: targetProfile.parameter_names
              }
            }
          ]
        };
      }

      if (sheetCandidateIds.length > 0 && (summaryCandidates.length > 0 || parameterCoverage > 0)) {
        return null;
      }
    }

    if (sheetCandidateIds.length > 0 && summaryCandidates.length > 0 && parameterCoverage === 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "I have sheet candidates; next I’ll read their text parameters so I can map Gemini redline intent to concrete element IDs before delete dry-run.",
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/get-parameters",
            body: {
              elementIds: sheetCandidateIds.slice(0, 80),
              names: ["Text", "Comments", "Type Comments", "Description", "Mark", "Type Name", "Family", "Family and Type", "Sheet Number", "Sheet Name"]
            }
          }
        ]
      };
    }

    if (sheetCandidateIds.length > 0 && summaryCandidates.length > 0 && !hasToolPath(toolResults, "/revit/delete")) {
      const selection = chooseSheetDeleteCandidates({
        candidates: summaryCandidates,
        candidateIds: sheetCandidateIds,
        regionBoxes,
        geminiIntents,
        annotationRegionHints,
        parameterTextById
      });
      if (selection.recommended_ids.length > 0 && (selection.auto_confident || selection.confidence >= 0.48)) {
        const ids = (selection.auto_confident ? selection.recommended_ids.slice(0, 12) : selection.recommended_ids.slice(0, 6));
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            selection.auto_confident
              ? `I mapped redline intent to ${ids.length} sheet elements and will run a dry-run delete to verify the exact target set before apply. ${scoreSummaryForAssistant(selection)}`
              : `I found probable sheet targets but confidence is moderate (${selection.confidence.toFixed(2)}), so I’ll run a narrow dry-run delete only on top-ranked candidates. ${scoreSummaryForAssistant(selection)}`,
          actions: [
            {
              action_id: randomUUID(),
              method: "POST",
              path: "/revit/delete",
              body: {
                ids,
                apply: false
              }
            }
          ]
        };
      }
      if (selection.diagnostics.length > 0) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            "Answer: I completed sheet-safe redline scoring, but confidence was too low for even a bounded dry-run delete. " +
            `${selection.blocker_reason ?? "insufficient evidence"}; ${scoreSummaryForAssistant(selection)}. ` +
            "Please confirm one target note/element, or re-run with a cleaner baseline compare.",
          actions: []
        };
      }
    }

    if (!hasToolPath(toolResults, "/revit/delete") && sheetCandidateIds.length > 0 && regionBoxes.length > 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `Answer: I found ${sheetCandidateIds.length} region-overlapping sheet candidates, but there is not enough semantic evidence to pick a safe delete set. ` +
          "I stopped before broad dry-run to avoid accidental out-of-scope deletions.",
        actions: []
      };
    }

    // Hard guard: once targeting a DrawingSheet, never fall through to export-view-frame loops.
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Answer: I’m in sheet-target mode and will not call export-view-frame for DrawingSheet views. " +
        "I completed sheet-safe discovery but could not auto-resolve a confident deletion set from current parameter/geometry evidence. " +
        "Please confirm one anchor element to remove, and I will execute directly.",
      actions: []
    };
  }

  const placementPreviewOrWriteStarted =
    hasToolPath(toolResults, "/revit/create-similar-from-instance") ||
    hasToolPath(toolResults, "/revit/place-family-instance-on-host") ||
    hasToolPath(toolResults, "/revit/export-view-region") ||
    hasToolPath(toolResults, "/revit/audit-hosted-instance-placement");
  if (
    modelGeometryTargeting &&
    targetProfile.room_number &&
    !resolvedRoomPlanView &&
    preferredModelViewToken &&
    activeModelViewId !== null &&
    targetViewId === activeModelViewId &&
    !activeModelViewMatchesPreferredToken &&
    !placementPreviewOrWriteStarted &&
    !hasToolPath(toolResults, "/revit/resolve-room-plan-view")
  ) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Room ${targetProfile.room_number} is resolved, but the next export would still use generic active view ${activeModelView.name ?? `view ${activeModelViewId}`}. ` +
        `I’ll switch to the best ${preferredModelViewToken}/electrical plan before exporting or previewing placement.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/resolve-room-plan-view",
          body: {
            roomNumber: targetProfile.room_number,
            preferViewNameContains: preferredModelViewToken,
            maxCandidates: 8
          }
        }
      ]
    };
  }

  const frame = extractLatestFrameForView(toolResults, targetViewId);
  const pickIds = extractLatestPickCandidateIds(toolResults, frame?.frame_id);
  const pickAttempts = countRecentPickAtPixelAttempts(toolResults, frame?.frame_id);

  if (!frame) {
    // In relay flows we may only receive the latest tool results; if picks already failed with no IDs, do not re-export forever.
    if (pickAttempts >= 2 && pickIds.length === 0) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Answer: I already attempted redline pixel mapping and got zero selectable element IDs. " +
          "I stopped to avoid a no-progress loop. Please confirm one concrete target element (for example an element id), and I will execute directly.",
        actions: []
      };
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: preferSheetTargeting
        ? `I’m exporting the full sheet view ${targetViewId} so redline picks target sheet/titleblock elements, not a nested viewport.`
        : `I’m exporting mapped viewport ${targetViewId} so I can resolve the redline region to concrete element IDs.`,
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/export-view-frame",
          body: {
            viewId: targetViewId,
            imageSize: 2200,
            includeMapping: true
          }
        }
      ]
    };
  }

  if (pickIds.length > 0 && !hasToolPath(toolResults, "/revit/delete")) {
    if (targetProfile.resolve_only && !hasToolPath(toolResults, "/revit/get-element-summary")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I found ${pickIds.length} ${targetProfile.scope_label} candidates at the mapped redline location and will fetch summaries before applying the requested change.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/get-element-summary",
            body: {
              elementIds: pickIds.slice(0, 12),
              viewId: targetViewId
            }
          }
        ]
      };
    }
    if (targetProfile.resolve_only && !hasToolPath(toolResults, "/revit/get-parameters")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I resolved candidate ${targetProfile.scope_label} elements from the redline and will read their parameters so the type-change step can target the correct instances.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/get-parameters",
            body: {
              elementIds: pickIds.slice(0, 24),
              names: targetProfile.parameter_names
            }
          }
        ]
      };
    }
    const spatialRefinement = maybeBuildSpatialRedlineRefinementBridge({
      req,
      toolResults,
      targetProfile,
      targetViewId,
      preferSheetTargeting,
      viewportHints
    });
    if (spatialRefinement) return spatialRefinement;
    if (targetProfile.resolve_only) return null;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "I found candidate elements at the mapped redline location and will run a dry-run delete to verify the exact affected IDs before apply.",
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/delete",
          body: {
            ids: pickIds.slice(0, 5),
            apply: false
          }
        }
      ]
    };
  }

  if (pickAttempts >= 2 && pickIds.length === 0) {
    const spatialRefinement = maybeBuildSpatialRedlineRefinementBridge({
      req,
      toolResults,
      targetProfile,
      targetViewId,
      preferSheetTargeting,
      viewportHints
    });
    if (spatialRefinement) return spatialRefinement;
    if (preferSheetTargeting && latestSheet?.sheet_number && !hasToolPath(toolResults, "/revit/find-elements")) {
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          hasFindSheetRegions
            ? `Pixel picks on full-sheet context returned no IDs, so I’ll query sheet/view ${targetProfile.scope_label} elements that overlap the mapped redline regions on ${latestSheet.sheet_number}.`
            : `Pixel picks on full-sheet context returned no IDs, so I’ll query sheet-owned ${targetProfile.scope_label} candidates directly on ${latestSheet.sheet_number}.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/find-elements",
            body: {
              sheetNumber: latestSheet.sheet_number,
              includeSheetElements: true,
              includeViewportElements: true,
              ...(targetProfile.categories.length > 0 ? { categories: targetProfile.categories } : {}),
              ...(hasFindSheetRegions
                ? {
                    sheetRegions: findSheetRegions,
                    regionPaddingFt: targetProfile.region_padding_ft
                  }
                : {}),
              limit: 200
            }
          }
        ]
      };
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Answer: I attempted pixel-pick mapping for the identified redline regions, but Revit returned no selectable element IDs. " +
        "I stopped to avoid a no-progress loop. Please confirm the exact target objects (or give one explicit element to anchor from), and I will execute directly.",
      actions: []
    };
  }

  if (!hasRecentPickAtPixel(toolResults, frame.frame_id)) {
    if (viewportHints.some((hint) => hint.view_id === targetViewId)) {
      const spatialRefinement = maybeBuildSpatialRedlineRefinementBridge({
        req,
        toolResults,
        targetProfile,
        targetViewId,
        preferSheetTargeting,
        viewportHints
      });
      if (spatialRefinement) return spatialRefinement;
    }
    const candidateHints = preferSheetTargeting
      ? sheetHints.slice(0, 8)
      : viewportHints
          .filter((h) => h.view_id === targetViewId && isFrameAlignedViewportHint(h))
          .map((h) => ({ normalized_x: h.normalized_x, normalized_y: h.normalized_y, score: h.score }))
          .slice(0, 8);
    if (candidateHints.length === 0) {
      const spatialRefinement = maybeBuildSpatialRedlineRefinementBridge({
        req,
        toolResults,
        targetProfile,
        targetViewId,
        preferSheetTargeting,
        viewportHints
      });
      if (spatialRefinement) return spatialRefinement;

      const needsRicherVisibleInventory =
        targetProfile.resolve_only &&
        targetProfile.pick_preference === "modelGeometry" &&
        !targetProfile.room_number &&
        !visibleInventoryHasSpatialContext(toolResults, targetViewId) &&
        countToolPath(toolResults, "/revit/export-visible-elements") < 2;
      const needsAdjacentCircuitTargetingInventory =
        targetProfile.resolve_only &&
        targetProfile.pick_preference === "modelGeometry" &&
        !targetProfile.room_number &&
        wantsElectricalCircuitMatch(semanticCorpus) &&
        countToolPath(toolResults, "/revit/export-visible-elements") < 2;
      if (!hasToolPath(toolResults, "/revit/export-visible-elements") || needsRicherVisibleInventory || needsAdjacentCircuitTargetingInventory) {
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            needsRicherVisibleInventory
              ? `I have a mapped frame but the current inventory lacks room/space context, so I’ll export a richer visible inventory for view ${targetViewId} before deciding this redline has no pick hints.`
              : needsAdjacentCircuitTargetingInventory
                ? `I have a mapped frame but not enough room/device evidence for this adjacent-circuit placement yet. I’ll export a richer visible inventory for view ${targetViewId} so the next step can use room labels, spaces, and adjacent receptacle coordinates instead of stopping at missing pick hints.`
              : `I already have a mapped frame for view ${targetViewId}, but not enough recovered pick hints yet. ` +
                "I’ll export the visible electrical inventory in this same view so the next step can use concrete element coordinates instead of restarting discovery.",
          actions: [
            {
              action_id: randomUUID(),
              method: "POST",
              path: "/revit/export-visible-elements",
              body: {
                viewId: targetViewId,
                imageSize: 2200,
                includeMapping: true,
                includeGeometry: true,
                includeLinked: true,
                categories: buildRedlineVisibleInventoryCategories(targetProfile),
                limit: needsAdjacentCircuitTargetingInventory ? 500 : 160,
                prioritizeSpatialContext: needsAdjacentCircuitTargetingInventory,
                includeRoomTags: true,
                includeText: true
              }
            }
          ]
        };
      }
      noteRedlineFastPathPhase(req.session_id, "blocked", { blocked_reason: "no_pick_hints", view_id: targetViewId });
      const diagnosticsText = buildRedlineFastPathDiagnosticsText(req.session_id);
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Answer: I exported the Revit view frame successfully, but the redline bridge still did not recover usable pick locations for the marked targets. " +
          "I stopped before guessing. " +
          (diagnosticsText ? `Diagnostics: ${diagnosticsText.replace(/\s+/g, " ").trim()}.` : ""),
        actions: []
      };
    }
    const coordSeen = new Set<string>();
    const pickActions: ActionCall[] = [];
    for (const h of candidateHints) {
      const xPx = Math.max(0, Math.min(frame.width_px - 1, Math.round(h.normalized_x * frame.width_px)));
      const yPx = Math.max(0, Math.min(frame.height_px - 1, Math.round(h.normalized_y * frame.height_px)));
      const key = `${xPx}:${yPx}`;
      if (coordSeen.has(key)) continue;
      coordSeen.add(key);
      pickActions.push({
        action_id: randomUUID(),
        method: "POST",
        path: "/revit/pick-at-pixel",
        body: {
          frameId: frame.frame_id,
          xPx,
          yPx,
          ...(targetProfile.categories.length > 0 ? { includeCategories: targetProfile.categories } : {}),
          prefer: targetProfile.pick_preference,
          maxHits: 8
        }
      });
      if (pickActions.length >= 3) break;
    }
    if (pickActions.length === 0) {
      noteRedlineFastPathPhase(req.session_id, "blocked", { blocked_reason: "no_pick_hints", view_id: targetViewId });
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "Answer: I matched the redline to the current Revit frame, but the mapped pick targets collapsed to duplicate or unusable pixel coordinates. " +
          "I stopped instead of issuing a no-op loop.",
        actions: []
      };
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: preferSheetTargeting
        ? "I mapped redline regions to full-sheet coordinates and will pick nearby sheet/titleblock annotation candidates by pixel."
        : "I mapped the redline regions into the view frame and will pick nearby annotation/model candidates by pixel.",
      actions: pickActions
    };
  }

  return null;
}

async function maybeAutoAlignRedlineViewHints(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
  allowSyntheticFallback?: boolean;
}): Promise<number> {
  const toolResults = getAugmentedToolResults(args.req, 80);
  const seed = getRedlineSessionSeed(args.req.session_id);
  if (!seed?.file_path || !/\.(png|jpg|jpeg)$/i.test(seed.file_path)) return 0;

  const latestFrameImage = extractLatestFrameImageContext(toolResults);
  if (!latestFrameImage?.image_data_url || !latestFrameImage.frame.frame_id) return 0;
  const existingViewportHints = dedupeViewportPickHints([
    ...getPersistedViewportPickHints(args.req.session_id),
    ...extractViewportPickHintsFromWorkbench(args.workbenchResults)
  ]);
  if (existingViewportHints.some((hint) => hint.view_id === latestFrameImage.view_id && isFrameAlignedViewportHint(hint))) return 0;

  if (hasRedlineViewAlignmentAttempt(args.req.session_id, seed.file_path, latestFrameImage.frame.frame_id)) return 0;

  noteRedlineViewAlignmentAttempt(args.req.session_id, seed.file_path, latestFrameImage.frame.frame_id);

  try {
    appendNotification(
      args.req.session_id,
      "workbench.progress",
      `Auto visual alignment: matching ${path.basename(seed.file_path)} to the latest Revit view export before continuing.`,
      {
        type: "align_redline_view",
        frame_id: latestFrameImage.frame.frame_id,
        view_id: latestFrameImage.view_id
      }
    );
  } catch {
    // ignore
  }

  const alignment = await alignRedlineToView({
    redline_file_path: seed.file_path,
    view_image_data_url: latestFrameImage.image_data_url,
    objective: getRecentUserTextForRedline(args.req),
    model: process.env.OPERATOR_OPENAI_MODEL ?? "gpt-5.6-sol",
    reasoning_effort: process.env.OPERATOR_REDLINE_ALIGNMENT_REASONING_EFFORT ?? "none",
    max_output_tokens: 5000
  });

  const alignmentMarks =
    alignment.ok && alignment.matched && alignment.confidence >= 0.35
      ? refineAlignmentMarksWithImageMarkCrop(alignment, getPersistedImageMarkHint(args.req.session_id))
      : [];
  const viewportHints =
    alignment.ok && alignment.matched && alignment.confidence >= 0.35
      ? alignmentMarks
          .filter((mark) => mark.score >= 0.25)
          .map((mark) => ({
            view_id: latestFrameImage.view_id,
            normalized_x: clamp01(mark.normalized_x),
            normalized_y: clamp01(mark.normalized_y),
            score: clamp01(Math.max(mark.score, alignment.confidence * 0.75)),
            source: "view_alignment" as const,
            frame_aligned: true
          }))
      : [];

  if (viewportHints.length > 0) {
    noteViewportPickHints(args.req.session_id, viewportHints);
    const strongest = viewportHints.slice().sort((a, b) => b.score - a.score)[0] ?? null;
    if (strongest) {
      const rawHint = getPersistedImageMarkHint(args.req.session_id);
      noteImageMarkHint(args.req.session_id, {
        normalized_x: strongest.normalized_x,
        normalized_y: strongest.normalized_y,
        side: inferMarkSideFromNormalizedPoint(strongest.normalized_x, strongest.normalized_y),
        source: "view_alignment",
        score: strongest.score,
        raw_normalized_x: rawHint?.source === "raw_image_mark" ? rawHint.normalized_x : rawHint?.raw_normalized_x ?? null,
        raw_normalized_y: rawHint?.source === "raw_image_mark" ? rawHint.normalized_y : rawHint?.raw_normalized_y ?? null,
        raw_image_width: rawHint?.source === "raw_image_mark" ? rawHint.image_width : rawHint?.raw_image_width ?? null,
        raw_image_height: rawHint?.source === "raw_image_mark" ? rawHint.image_height : rawHint?.raw_image_height ?? null,
        wall_local_normalized_chainage: rawHint?.wall_local_normalized_chainage ?? null,
        wall_local_axis: rawHint?.wall_local_axis ?? null,
        wall_local_span_px: rawHint?.wall_local_span_px ?? null,
        wall_local_source: rawHint?.wall_local_source ?? null
      });
    }
    try {
      appendNotification(
        args.req.session_id,
        "workbench.saved",
        `Auto visual alignment resolved ${viewportHints.length} redline target${viewportHints.length === 1 ? "" : "s"} in view ${latestFrameImage.view_id}.`,
        {
          type: "align_redline_view",
          count: viewportHints.length,
          confidence: alignment.confidence,
          frame_id: latestFrameImage.frame.frame_id,
          view_id: latestFrameImage.view_id
        }
      );
    } catch {
      // ignore
    }
    return viewportHints.length;
  }

  try {
    appendNotification(
      args.req.session_id,
      "workbench.saved",
      `Auto visual alignment did not find a confident match for ${path.basename(seed.file_path)} in the latest Revit view export.`,
      {
        type: "align_redline_view",
        matched: alignment.matched,
        confidence: alignment.confidence,
        warning: alignment.warning ?? null
      }
    );
  } catch {
    // ignore
  }

  if (args.allowSyntheticFallback === false) return 0;

  const syntheticHint = synthesizeViewportHintFromImageMark(
    latestFrameImage,
    getPersistedImageMarkHint(args.req.session_id)
  );
  if (syntheticHint) {
    noteViewportPickHints(args.req.session_id, [syntheticHint]);
    try {
      appendNotification(
        args.req.session_id,
        "workbench.saved",
        `Active-view red mark kept as a coarse room-side hint for view ${latestFrameImage.view_id}; exact along-wall placement still requires mapped view evidence.`,
        {
          type: "active_view_red_mark_hint",
          view_id: latestFrameImage.view_id,
          normalized_x: syntheticHint.normalized_x,
          normalized_y: syntheticHint.normalized_y,
          score: syntheticHint.score,
          frame_id: latestFrameImage.frame.frame_id
        }
      );
    } catch {
      // ignore
    }
    return 1;
  }
  return 0;
}

async function maybeAutoMapRedlineSheetRegions(args: {
  req: ChatRequest;
  workbenchResults: WorkbenchActionResult[];
}): Promise<number> {
  const toolResults = getAugmentedToolResults(args.req, 80);
  const seed = getRedlineSessionSeed(args.req.session_id);
  if (!seed?.file_path) return 0;
  const sheet = extractLatestSheetDetailForRedline(toolResults);
  if (!sheet || !Array.isArray(sheet.viewport_geometry) || sheet.viewport_geometry.length === 0) return 0;
  if (hasRedlineOrientMapped(args.req.session_id, seed.file_path)) return 0;
  if (hasRedlineOrientAttempt(args.req.session_id, seed.file_path)) {
    if (hasRedlineOrientRemapRequested(args.req.session_id, seed.file_path)) return 0;
    noteRedlineOrientRemapRequested(args.req.session_id, seed.file_path);
  }

  const baselinePath = extractLatestExportPdfBaselinePathFromToolResults(toolResults);
  const expected = normalizeExpectedSheet(seed.expected_sheet ?? sheet.sheet_number ?? null);
  noteRedlineOrientAttempt(args.req.session_id, seed.file_path, expected ?? null, seed.filename ?? null);
  try {
    appendNotification(
      args.req.session_id,
      "workbench.progress",
      `Auto redline orient: mapping visible red marks from ${path.basename(seed.file_path)} to sheet/view geometry before blocking.`,
      { type: "redline_orient", file_path: seed.file_path, sheet_number: expected ?? null }
    );
  } catch {
    // ignore
  }

  try {
    const oriented = await orientRedlineFile({
      file_path: seed.file_path,
      ...(expected ? { expected_sheet: expected } : {}),
      max_pages: pdfDefaultPageBudget(),
      include_pdf_annotations: true,
      include_ocr_for_images: true,
      sheet_outline: sheet.sheet_outline,
      viewport_geometry: sheet.viewport_geometry,
      title_blocks: sheet.title_blocks,
      ...(baselinePath ? { baseline_file_path: baselinePath } : {})
    });
    const mapping = oriented.mapping && typeof oriented.mapping === "object" ? (oriented.mapping as Record<string, unknown>) : null;
    const viewportHints = extractViewportPickHintsFromMapping(mapping);
    const sheetHints = extractSheetPickHintsFromMapping(mapping);
    const sheetBoxes = extractSheetRegionBoxesFromMapping(mapping);
    if (oriented.analysis?.ok) {
      noteRedlineAnalyzeSuccess(
        args.req.session_id,
        seed.file_path,
        expected ?? oriented.analysis.primary_sheet_number ?? null,
        seed.filename ?? path.basename(seed.file_path)
      );
      noteRedlineOrientAttempt(args.req.session_id, seed.file_path, expected ?? null, seed.filename ?? null);
    }
    if (baselinePath) noteRedlineOrientWithBaseline(args.req.session_id, seed.file_path);
    if (viewportHints.length > 0 || sheetHints.length > 0) noteRedlineOrientMapped(args.req.session_id, seed.file_path);
    if (viewportHints.length > 0) noteViewportPickHints(args.req.session_id, dedupeViewportPickHints(viewportHints));
    if (sheetHints.length > 0) noteSheetPickHints(args.req.session_id, dedupeSheetPickHints(sheetHints));
    if (sheetBoxes.length > 0) noteSheetRegionBoxes(args.req.session_id, dedupeSheetRegionBoxes(sheetBoxes));

    try {
      appendNotification(
        args.req.session_id,
        "workbench.saved",
        `Auto redline orient mapped ${viewportHints.length} viewport hint${viewportHints.length === 1 ? "" : "s"} and ${sheetHints.length} sheet hint${sheetHints.length === 1 ? "" : "s"}.`,
        {
          type: "redline_orient",
          viewport_hints: viewportHints.length,
          sheet_hints: sheetHints.length,
          warning: oriented.warning ?? null
        }
      );
    } catch {
      // ignore
    }
    return viewportHints.length + sheetHints.length;
  } catch (err) {
    try {
      appendNotification(
        args.req.session_id,
        "workbench.saved",
        `Auto redline orient failed: ${err instanceof Error ? err.message : String(err)}`,
        { type: "redline_orient", ok: false }
      );
    } catch {
      // ignore
    }
    return 0;
  }
}

function isRecoverableNoPickHintBridge(response: ChatResponse | null): boolean {
  if (!response || (response.actions ?? []).length > 0) return false;
  const message = (response.assistant_message ?? "").toLowerCase();
  return message.includes("no_pick_hints") || message.includes("did not recover usable pick locations");
}

function isHostedPlacementPath(pathName: unknown): boolean {
  const normalized = typeof pathName === "string" ? pathName.trim().toLowerCase() : "";
  return normalized === "/revit/create-similar-from-instance" || normalized === "/revit/place-family-instance-on-host";
}

function bridgeHasHostedPlacementAction(response: ChatResponse | null): boolean {
  return !!response?.actions?.some((action) => isHostedPlacementPath(action.path));
}

function bridgeHasHeuristicHostedPlacementAction(response: ChatResponse | null): boolean {
  if (!bridgeHasHostedPlacementAction(response)) return false;
  const message = (response?.assistant_message ?? "").toLowerCase();
  if (message.includes("heuristic")) return true;
  return !!response?.actions?.some((action) => {
    if (!isHostedPlacementPath(action.path)) return false;
    const body = action.body && typeof action.body === "object" ? (action.body as Record<string, unknown>) : null;
    if (!body) return false;
    const placements = Array.isArray(body.placements) ? body.placements : [];
    const placementHasMeasuredTarget = placements.some((placement) => {
      if (!placement || typeof placement !== "object") return false;
      const row = placement as Record<string, unknown>;
      return Number.isFinite(row.targetChainageFt as number) || Number.isFinite(row.targetNormalizedChainage as number);
    });
    const hasDirectMeasuredTarget =
      Number.isFinite(body.targetChainageFt as number) ||
      Number.isFinite(body.targetNormalizedChainage as number);
    const hasExplicitPoint =
      Array.isArray(body.pointXyz) ||
      placements.some((placement) => !!placement && typeof placement === "object" && Array.isArray((placement as Record<string, unknown>).pointXyz));
    const hasOffset =
      Number.isFinite(body.alongHostOffsetFt as number) ||
      placements.some((placement) => !!placement && typeof placement === "object" && Number.isFinite((placement as Record<string, unknown>).alongHostOffsetFt as number));
    return (hasExplicitPoint || hasOffset) && !placementHasMeasuredTarget && !hasDirectMeasuredTarget;
  });
}

function hasFrameAlignedRedlineHintForLatestFrame(req: ChatRequest, workbenchResults: WorkbenchActionResult[]): boolean {
  const latestFrameImage = extractLatestFrameImageContext(getAugmentedToolResults(req, 80));
  if (!latestFrameImage) return false;
  const hints = dedupeViewportPickHints([
    ...getPersistedViewportPickHints(req.session_id),
    ...extractViewportPickHintsFromWorkbench(workbenchResults)
  ]);
  return hasFrameAlignedViewportHintForView(hints, latestFrameImage.view_id);
}

function hasAlignableRedlineImageSeed(sessionId: string): boolean {
  const seed = getRedlineSessionSeed(sessionId);
  return !!seed?.file_path && /\.(png|jpg|jpeg)$/i.test(seed.file_path);
}

function maybeBuildMeasuredRedlineTargetBlocker(req: ChatRequest, bridge: ChatResponse | null): ChatResponse {
  const placementPath = bridge?.actions?.find((action) => isHostedPlacementPath(action.path))?.path ?? "/revit/create-similar-from-instance";
  noteRedlineFastPathPhase(req.session_id, "blocked", { blocked_reason: "no_measured_redline_target" });
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `Answer: I resolved a native ${placementPath === "/revit/create-similar-from-instance" ? "create-similar" : "hosted placement"} path, but I do not yet have a measured redline-to-view target. ` +
      "I will not place from a room-side or spacing heuristic because that can land on the right wall but the wrong distance along it. " +
      "The next step needs successful view/redline alignment or a sidecar/CUA visual pick before any write.",
    actions: []
  };
}

function synthesizeViewportHintFromImageMark(
  frameImage: ViewFrameImageContext,
  markHint: ImageMarkHint | null
): ViewportPickHint | null {
  if (!markHint) return null;
  if (!Number.isFinite(markHint.normalized_x) || !Number.isFinite(markHint.normalized_y)) return null;
  if (!frameImage.frame || frameImage.frame.width_px <= 0 || frameImage.frame.height_px <= 0) return null;

  const imageWidth = toFiniteNumber(markHint.image_width);
  const imageHeight = toFiniteNumber(markHint.image_height);
  const hasImageSize = imageWidth !== null && imageHeight !== null && imageWidth > 0 && imageHeight > 0;
  const frameAspect = frameImage.frame.width_px / frameImage.frame.height_px;
  const imageAspect = hasImageSize ? imageWidth / imageHeight : null;
  const aspectDelta = imageAspect === null ? 0 : Math.abs(imageAspect - frameAspect) / Math.max(0.001, frameAspect);

  // Native active-view snippets are usually the exported view with red marks added.
  // If the dimensions do not line up we still keep a lower-confidence hint so
  // explicit room/circuit text can drive a bounded placement workflow.
  const aspectCompatible = !hasImageSize || aspectDelta <= 0.18;
  const score = clamp01((Number(markHint.score) || 0.55) + (aspectCompatible ? 0.12 : -0.12));
  if (score < 0.35) return null;

  return {
    view_id: frameImage.view_id,
    normalized_x: clamp01(markHint.normalized_x),
    normalized_y: clamp01(markHint.normalized_y),
    score,
    source: "raw_image_mark",
    frame_aligned: false
  };
}

async function maybeInferRedlineImageMarkHint(req: ChatRequest): Promise<number> {
  const seed = getRedlineSessionSeed(req.session_id);
  if (!seed?.file_path || !/\.(png|jpg|jpeg)$/i.test(seed.file_path)) return 0;
  if (getPersistedImageMarkHint(req.session_id)) return 0;
  try {
    const analysis = await analyzeRedlineFile({
      file_path: seed.file_path,
      max_pages: 1,
      include_pdf_annotations: false,
      include_ocr_for_images: true,
      timeout_ms: 12000
    });
    const width = analysis.image_meta?.width;
    const height = analysis.image_meta?.height;
    const regions = Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [];
    const ocrText = analysis.ocr?.ok && typeof analysis.ocr.text_excerpt === "string"
      ? analysis.ocr.text_excerpt
      : "";
    const roomNumber = extractRedlineOcrSpatialRoomNumber(ocrText);
    if (!analysis.ok || !width || !height || regions.length === 0) {
      if (roomNumber) {
        noteRedlineSpatialTargeting(req.session_id, { room_number: roomNumber });
        try {
          appendNotification(
            req.session_id,
            "workbench.saved",
            `Redline OCR fallback inferred room ${roomNumber} from ${path.basename(seed.file_path)}.`,
            {
              type: "redline_image_mark_hint",
              room_number: roomNumber,
              warning: regions.length === 0 ? "no_red_mark_regions" : null
            }
          );
        } catch {
          // ignore
        }
        return 1;
      }
      return 0;
    }
    const best = regions
      .filter((r) => r && r.source !== "pdf_annotation" && Number.isFinite(r.area))
      .sort((a, b) => (b.area ?? 0) - (a.area ?? 0))[0];
    if (!best) return 0;
    const normalizedX = Math.max(0, Math.min(1, (best.x + best.w * 0.5) / width));
    const normalizedY = Math.max(0, Math.min(1, (best.y + best.h * 0.5) / height));
    const side = inferMarkSideFromNormalizedPoint(normalizedX, normalizedY);
    const bestRegion = best as Record<string, unknown>;
    const wallLocalNormalizedChainage = toFiniteNumber(bestRegion.wall_local_normalized_chainage);
    const wallLocalAxis =
      bestRegion.wall_local_axis === "vertical" || bestRegion.wall_local_axis === "horizontal"
        ? bestRegion.wall_local_axis
        : null;
    const wallLocalSpan = Array.isArray(bestRegion.wall_local_span_px)
      ? bestRegion.wall_local_span_px
          .map((v) => toFiniteNumber(v))
          .filter((v): v is number => v !== null)
          .slice(0, 2)
      : null;
    noteImageMarkHint(req.session_id, {
      normalized_x: normalizedX,
      normalized_y: normalizedY,
      side,
      score: 0.65,
      source: "raw_image_mark",
      image_width: width,
      image_height: height,
      wall_local_normalized_chainage: wallLocalNormalizedChainage,
      wall_local_axis: wallLocalAxis,
      wall_local_span_px: wallLocalSpan?.length === 2 ? [Math.round(wallLocalSpan[0]!), Math.round(wallLocalSpan[1]!)] : null,
      wall_local_source:
        typeof bestRegion.wall_local_source === "string" && bestRegion.wall_local_source.trim()
          ? bestRegion.wall_local_source.trim()
          : null
    });
    if (roomNumber || side) {
      noteRedlineSpatialTargeting(req.session_id, {
        room_number: roomNumber,
        spatial_side: side,
        spatial_side_source: side
      });
    }
    try {
      appendNotification(
        req.session_id,
        "workbench.saved",
        `Red mark fallback inferred ${side ? `${side} side` : "relative mark position"}${roomNumber ? ` for room ${roomNumber}` : ""} from ${path.basename(seed.file_path)}.`,
        {
          type: "redline_image_mark_hint",
          normalized_x: normalizedX,
          normalized_y: normalizedY,
          side,
          room_number: roomNumber ?? null,
          wall_local_normalized_chainage: wallLocalNormalizedChainage
        }
      );
    } catch {
      // ignore
    }
    return 1;
  } catch {
    return 0;
  }
}

function defaultSystemPrompt(): string {
  const lines = [
    "Role: You are the Operator backend for a Revit add-in. You do not directly control Revit; you propose allowlisted HTTP actions for the add-in to execute on Revit's main thread (/revit/*) or in the host shell (/ui/*).",
    "Goal: complete the user's Revit task through the bridge, native API gateway, computer-use tools, and backend workbench.",
    "Success criteria: preserve the user's intent, emit executable actions when a safe path exists, verify writes and file outputs with post-change evidence, and if blocked return one concrete blocker plus the next best check.",
    "Constraints: respect bridge write grants and approval mode; avoid fabricating tool results, file paths, citations, or verification; use exact tool errors when reporting failures.",
    "",
    "Operating mode (v1): multi-turn tool loop.",
    "- You will receive tool/action results in subsequent requests.",
    "- Use those results to continue until the task is done.",
    "",
    ...AGENT_RESPONSE_STYLE_LINES,
    "- Lead with the conclusion. Keep all required facts, evidence, caveats, and next actions; trim introductions, repetition, generic reassurance, and optional background first.",
    "- Do NOT dump raw tool JSON back to the user (tool JSON is already visible in the Actions panel).",
    "- If you are done, you may start with \"Answer:\" for compatibility. If blocked, return \"Answer:\" with one concrete blocker/question.",
    "- Users will talk naturally (e.g., \"update the MEP engineers on the cover sheet to WSP\"). Infer missing details using read-only tools (resolve the sheet, find the titleblock, inspect candidates) instead of asking the user to provide exact tool names/JSON.",
    "- Treat the user's approval/write mode as the source of truth. If approval_mode is session or yolo and the bridge write grant is active, do not ask for permission again before acting.",
    "- Execution ladder: try a dedicated /revit/* primitive first; if that is unclear or absent, use tool discovery (POST /revit/tool-search, then POST /revit/tool-examples for likely paths, then POST /revit/tool-doc only when exact required fields are still unknown; use GET /revit/tool-registry only when you truly need the full inventory); if still missing, use POST /revit/native-api-search or POST /revit/native-api-catalog and then POST /revit/native-api-call; if UI state is the blocker, use /revit/state-snapshot and /revit/computer-use-observe|act|guard; only ask the user after those lanes are exhausted.",
    "- Do not stop with a vague statement like 'I can't find the command' or 'that tool is not available' until you have tried the live tool surface, the native API surface, and computer-use where relevant.",
    "- If the first attempt yields no executable action, your next move is recovery, not surrender: search the live tool surface and native API for the capability, then continue.",
    "- If you used any user attachment (including the attached images), include a short line: \"I used: <filename> — <1–3 anchors>\". For PDFs use anchors like \"PDF p3\"; for Excel use anchors like \"Excel Sheet=..., Range=A1:G40\"; for images you may cite \"Image meta\" or describe the relevant region.",
    "- Redline filename-first rule: if the attachment filename contains a sheet token (e.g., M000), treat it as a high-confidence target-sheet anchor. Cover/index sheets may mention many other sheet numbers in body text.",
    "- Verification rule: Only claim something is verified if you captured evidence AFTER the change and it clearly shows the target state (include the evidence path). File-generating tasks require file verification from the tool result or a filesystem check: exact path, exists=true, nonzero size, and timestamp. If you did not capture post-change/file evidence, say \"Not verified\" and explain what is missing.",
    "- When presenting an evidence pack, list checklist checks as explicit PASS/FAIL with observed values, then provide one download link.",
    "- Prefer visual verification from attached post-change captures (vision). Avoid OCR unless the user explicitly asks for text extraction.",
    "- Titleblock edits: verification must be sheet-aware. Prefer /revit/verify-parameter-on-sheet or /revit/capture-sheet-region; avoid plan-view captures for titleblock fields.",
    "- Revit drafting text standard: default all user-visible text authored or changed in Revit to ALL CAPS unless the user explicitly asks to preserve mixed/lower case. This includes sheet names, titleblock values, text notes, annotation labels, and schedule/header text.",
    "- Sheet-name verification/update workflow: when the user names a sheet number and asks to verify or change its Sheet Name/Name parameter, resolve the sheet with POST /revit/sheets action:\"detail\", compare the current name, update the ViewSheet element with POST /revit/set-parameter using parameterName:\"Sheet Name\" (or \"Name\" if discovered), then read the sheet again and report the observed final sheet number/name.",
    "- Revit version-pinned launch rule: if the user explicitly asks for a Revit year (for example Revit 2024), do not open an RVT by file association or generic Revit discovery first. The host must launch that exact Revit executable/session, verify it is the target, then open the model through that session; if the requested year is unavailable, report that blocker instead of falling back to another Revit version.",
    "- If you need to locate visible annotation text by phrase in the active project or sheet, call /revit/find-text-notes before falling back to broader element scans or asking the user for ids.",
    "- Revit dialog computer-use rule: when a tool loop is blocked by a modal warning/error dialog, or /revit/state-snapshot reports dialog_state.blocked_by_modal=true, use /revit/computer-use-observe before guessing.",
    "- Revit dialog computer-use rule: for a known blocking Revit-owned dialog, use /revit/computer-use-act with the fewest steps possible (prefer button/default selectors, not retries by brute force), then re-observe or verify the intended tool outcome. The default interactionMode=message_then_mouse tries the non-mouse button message first, then uses a physical cursor click only if the same dialog remains visible; it keeps the cursor at the clicked location so follow-up screenshots/actions preserve pointer continuity. Set interactionMode=message when mouse movement is unacceptable, and use cursorRestoreMode=restore only after the click is verified or when no follow-up mouse precision is needed.",
    "- Revit dialog computer-use rule: before a risky write or import/export step likely to raise a known warning dialog, you may arm /revit/computer-use-guard with dialog/message filters so the next matching popup does not stall the loop. Use interactionMode=message for purely background-safe guards, or the default message_then_mouse if a stubborn dialog is likely. Do not use click-and-restore behavior for fine mouse calibration loops; observe after small movements and keep pointer state until the mouse-driven subtask is complete.",
    "- Revit placement warning rule: for hosted placement preview/apply steps, arm /revit/computer-use-guard with dialogIdContains:\"DocWarnDialog\" and button:\"default\". Revit placement errors such as \"can't rotate element into this position\" may present Cancel as the correct default; do not hard-code OK for DocWarnDialog.",
    "- Do NOT try to verify in parallel with a write. Apply first, then verify with a follow-up capture after a regenerate/refresh.",
    "- Static titleblock text edits (TextNotes in the titleblock family): do NOT rely on exact string matching. If a contains query returns 0, list nearby candidates (TextNotes) and pick the best match by meaning (handle punctuation/line breaks). Ask a clarifying question only if multiple candidates are plausible.",
    "- If you need element IDs for follow-on checks (e.g. reading parameters), prefer /revit/quantify intent 'list' or 'count_and_list' (not 'count').",
    "- If tool results include element IDs and you need to classify/filter by a parameter, your next action is usually POST /revit/get-parameters with elementIds + names.",
    "- If recent tool results say an element id is missing/not found after an apply, treat that id as stale. Do not keep querying it in a loop; re-resolve the live successor element from the active view, nearby exemplars, or the latest write payload before continuing.",
    "- If a parameter name is unclear, fetch parameters for 1 element/type to discover the correct name, then re-query in batch.",
    "- For physical printing, prefer POST /revit/print with dryRun:true first to preflight the exact sheets and printer, then dryRun:false only after the intended target is clear. For PDF deliverables, use POST /revit/export-pdf with dryRun/preflight first when the sheet scope is ambiguous; inspect selectedSheets/preflight.outputs, then export with combine=true when the user asks for a single combined/bound PDF and combine=false when the user asks for individual PDFs. For requested individual naming conventions, set perSheetFileNameTemplate directly (for example \"36478953 - {sheetNumber} - {sheetName}\") rather than exporting default names and copying/renaming afterward. For black-and-white/monochrome output set colorMode:\"BlackLine\"; for grayscale set colorMode:\"Grayscale\"; for color set colorMode:\"Color\". Verify returned verification.ok before reporting success.",
    "- For common sheet categories, prefer /revit/export-pdf sheetGroup values (`power`, `lighting`, `mechanical`, `electrical`, `plumbing`, `cover`, `fire_alarm`) over ad hoc text matching.",
    "- For creating new sheets, prefer /revit/create-sheet or /revit/create-sheets. Do not manually pick the first titleblock from a list; omit titleBlockId to let the bridge choose the most-used/adjacent titleblock, or provide referenceSheetNumber/titleBlockName when a nearby standard sheet clearly indicates the right titleblock.",
    "- For aligning plan viewports across sheets so the building matches when flipping sheets, prefer one POST /revit/align-viewports call with sheetNumbers, referenceSheetNumber, primaryOnly:true, and viewNameContains such as \"POWER PLAN\". Let the default model-coordinate anchor align building content even when viewport/crop sizes differ, or provide modelAnchorElementId for a shared stair/core. Boundary checking is on by default; inspect boundaryStatus, blockedByBoundary, and applied before claiming completion, and if a larger/lower-floor viewport would leave the titleblock/sheet boundary, report the skipped sheet or choose a safer layout/crop strategy. Use mode:\"box\" only when the user specifically asks to align viewport boxes. Do not manually chase viewport ids through repeated /revit/sheets or native-api-search loops unless /revit/align-viewports fails with a concrete blocker.",
    "- For moving regular schedules or panel schedules between sheets, prefer POST /revit/place-view or /revit/place-views with sheetNumber, viewName/viewQuery, moveIfAlreadyPlaced:true, and avoidOverlap:true. Do not fall back to computer-use unless the bridge returns a concrete placement failure.",
    "- For counting sheets, prefer POST /revit/sheets with {\"action\":\"count\"}. Do not infer totals from a limited items list.",
    "- For POST /revit/sheets with action:\"detail\", selectors are singular fields only: sheetNumber OR sheetId OR viewId OR query (not arrays like sheetIds).",
    "- Redline fallback: if /revit/sheets action=detail by sheetNumber returns NotFound, immediately retry action=detail using context.revit.document.activeView.id as viewId when the active view is a sheet.",
    "- For room lookup by room number, use POST /revit/rooms with body like: {\"action\":\"list\",\"roomNumber\":\"0981\",\"max\":50}. Then use {\"action\":\"detail\",\"roomIds\":[<roomId>]} to get doors in that room.",
    "- For /revit/quantify: the body is NOT nested. Example: {\"intent\":\"count\",\"categories\":[\"OST_Doors\"]}.",
    "- /revit/quantify returns resultSetId for follow-ups. To visualize, use POST /revit/quantify-visualize with {\"resultSetId\":\"...\",\"mode\":\"highlight\"|\"isolate\"|\"new_view\"|\"clear\"|\"forget\",\"viewId\"?:123}.",
    "- For /revit/get-element-summary: prefer body {\"elementIds\":[123,456]} (legacy {\"ids\":...} may exist).",
    "- For /revit/set-parameter: body {\"changes\":[{\"elementId\":123,\"parameterName\":\"Mark\",\"value\":\"A\"}],\"apply\":true}.",
      "- For repetitive panel schedule parameter tasks like 'find all P* panels and set A.I.C. Rating to 10.000', prefer one POST /revit/update-panel-parameter call over delegated batch jobs when the tool can target the whole set. Treat A.I.C./AIC/interrupting-current wording as the same semantic target as Short Circuit Rating unless project evidence says otherwise.",
      "- For /revit/update-panel-parameter, use dryRun:false for a direct user-requested write when the target is a single exact named panel and the write grant is active; then verify from updatedCount/verifiedCount/readback. Use sample-first dryRun only when the scope is broad/ambiguous (for example all P* panels) or parameter ambiguity is unresolved: include samplePanelName when the user names an example such as P105, includeWritableFields:true when needed, and inspect writePreflight.sample.status, resolvedParameterName, updateCandidateCount, alreadyCorrectCount, panelBuckets, and noChangeAlert before applying.",
      "- After POST /revit/update-panel-parameter or POST /revit/update-parameter-by-query with dryRun=false, treat verifiedCount/updatedCount plus panelBuckets.changed as the real success metric. Do not claim completion from backend status alone.",
      "- If an applied deterministic parameter update returns verificationFailedCount > 0, noChangeAlert:true, status 'No Changes', or 0 verified changes when updates were expected and alreadyCorrectCount does not explain it, treat the deterministic lane as blocked/stale. Report blockedReason clearly, avoid repeating the same write loop blindly, and pivot to a safer recovery or bounded manual/UI fallback path.",
    "- If get-element-summary returns category \"Panel Schedule Graphics\", that is a schedule graphic/annotation. Resolve the real panel first via POST /revit/find-elements with categories:[\"OST_ElectricalEquipment\"] and nameContains from the schedule name, then inspect/set parameters on those panel element ids.",
    "- Avoid repeated discovery loops: do not call POST /revit/tool-doc for the same method/path again. If /revit/tool-doc fails, recover with /revit/tool-search or /revit/tool-examples and continue; do not turn a failed docs lookup into a user-facing blocker.",
    "- If the same read-only action returns no new information twice, stop repeating it and pivot to an alternative tool path (or ask one targeted clarifying question).",
    "- For room/space ductwork lookup, prefer POST /revit/ducts-by-spatial-scope (it handles Room->Space->geometry fallback and room+plenum in one request).",
    "- For one-shot directives like 'change supply ductwork in office unit 301 from 8\\\" to 10\\\"', prefer POST /revit/resize-ductwork-by-scope with scope.roomMode='auto' and scope.verticalScope='room+plenum' before asking follow-up questions.",
    "- MEP redline intent rule: a PDF annotation such as '12x10 supply duct' labels the requested duct to create/route unless the redline or model evidence clearly identifies an editable existing duct to resize. If no editable HVAC duct exists at the mark and the visible target is linked plumbing, do not ask to edit the plumbing link; draft a bounded HVAC duct route in the active HVAC model using /revit/mep-route-workflow or /revit/create-duct dryRun first.",
    "- Use POST /revit/room-contents when you need generic room inventory beyond ductwork.",
    "- For selector queries scoped to a sheet/view, prefer POST /revit/find-elements.",
    "- To fix rooms stopping at an arbitrary height, use POST /revit/align-room-tops-to-ceilings (dry-run first).",
    "- IMPORTANT: Maintain the user's original intent. If the user asked to move/align something, do not stop after exporting an image asking what to verify; continue the workflow until the move is dry-run'd (and applied if requested).",
    "- UI links: You MAY include markdown links like [label](url). For verified PDF/file output, include the exact path and a convenient one-line markdown link when possible, for example [Open PDF](file:///C:/path/file.pdf). Keep the markdown link label and URL on the same line. To open a Workspace folder in Windows Explorer, use: [Open folder](op://open-folder?path=artifacts/prints).",
    "",
    "Web research (host-configured; do not guess):",
    "- You may request web evidence fetches by populating web_requests with URL(s).",
    "- The host will fetch and save evidence under Workspace/evidence/web/** and then re-call you with the extracted text + citations.",
    "- If web research mode is OFF or a domain is blocked, do NOT fabricate; ask the user to paste the relevant excerpt or provide a PDF.",
    "",
    "EC2 workbench (interim backend compute/file steps):",
    "- You may request bounded backend work by populating workbench_actions.",
    "- Use workbench_actions for interim planning/calculation/transform steps before proposing final /revit/* actions.",
    "- Keep workbench operations inside Workspace paths. Prefer artifacts/* for generated outputs.",
    "- When shell helpers need Windows user folders, use environment/known-folder paths (`$env:USERPROFILE`, `$env:LOCALAPPDATA`, `$env:APPDATA`, `[Environment]::GetFolderPath(...)`) instead of hard-coded user Desktop paths.",
    "- Avoid long-running tasks; keep commands/scripts bounded and deterministic.",
    "- The host re-calls you with structured workbench results in context after execution.",
    "- If a workbench write_file under artifacts/* succeeds, results may include details.artifact_share.download_path for user retrieval.",
    "- For redline files (.pdf/.png/.jpg), use workbench action analyze_redline first to detect sheet candidates and markup signals.",
    "- If analyze_redline succeeds for a file, do not call analyze_redline again for that same file in this task unless the baseline/source changed.",
    "- If analyze_redline fails for a file, do not retry the exact same analyze request in a loop.",
    "- Prefer workbench action redline_orient when you already have sheet geometry and want one-call analyze+map output.",
    "- For deeper visual-intent extraction from redline images/crops, use workbench action gemini_redline_analyze and pass image_paths/region_boxes when available.",
    "- Trust mark regions sourced from baseline_diff/pdf_annotation first. Treat red_markup_detect-only regions as weak signal and confirm with baseline or sheet-aware review before destructive edits.",
    "- If you have a clean-underlay image, include baseline_file_path in gemini_redline_analyze so deterministic diff/crop prepass can focus only changed regions.",
    "- After /revit/export-pdf, prefer result_json.backend_path/backend_paths as baseline_file_path (backend-workspace paths).",
    "- When a sheet candidate is found, call /revit/sheets with action=detail and includeViewportGeometry=true to orient marks to placed views/titleblock.",
    "- For new sheet/view placement work, completion requires a presentation QC pass: use /revit/sheets detail with viewport geometry, keep viewports inside the drawable sheet area, align related views left/right when they fit, use consistent viewport title types, tighten model/annotation crops so stray annotations do not dominate the viewport box, then export/capture the sheet before reporting success.",
    "- If workbench provides annotated redline preview/crop images, use those visuals to infer per-region intent before proposing write actions.",
    "- For attached redline screenshots/snippets, use image understanding to extract intent anchors such as room number, sheet/view label, panel/circuit text, wall/side, and marked target region. Treat those as planning context; do not expect vision to provide exact Revit pick coordinates before you query native room/view/device geometry.",
    "- If you have region boxes from diff/markup extraction, use workbench action map_sheet_regions with sheetOutline + viewportGeometry/titleBlocks to map each region to viewport/titleblock.",
    "- For view-space element targeting after orientation, use /revit/export-visible-elements when you need a full visible inventory with image-space mapping; otherwise use /revit/export-view-frame then /revit/pick-at-pixel.",
    "- After one successful /revit/export-visible-elements call, do not repeat broad inventory exports in a loop. Use the sampled inventory plus /revit/pick-candidate-cluster or /revit/get-placement-context to continue.",
    "- If titleblock/sheet regions dominate, prefer full-sheet targeting (sheet viewId) before selecting any nested viewport.",
    "- /revit/export-view-frame does not support DrawingSheet or ThreeD views. For sheet/titleblock targets, pivot to /revit/find-elements on sheetNumber (+ includeSheetElements; add sheetRegions when available) and then /revit/get-element-summary.",
    "- When redline_orient includes viewport targets with view_hint, execute the bridge in order: export-view-frame -> pick-at-pixel -> get-element-summary/delete dry-run (do not stall in repeated /revit/sheets loops).",
    "- For redline/snippet mutation requests, infer likely target categories from the user intent before asking for manual selection (for example receptacle/GFCI => electrical fixtures/devices; lights => lighting fixtures).",
    "- For spatially anchored redline mutations (for example \"room 403 south wall receptacles\"), resolve the room via /revit/rooms detail, then use /revit/resolve-room-wall and /revit/rank-similar-devices-on-wall to get explicit XYZ/host/orientation/circuit exemplar data before any write. Use /revit/export-visible-elements or /revit/export-view-frame plus /revit/pick-candidate-cluster when image-space redline mapping is needed.",
    "- When performing spatial Revit tasks, think like a drafter using feedback. Place a reasonable first attempt using available context, then verify and correct. Do not require perfect spatial certainty before acting unless the action is destructive. Use nearby elements, room boundaries, wall vectors, view coordinates, and screenshots/captures to converge.",
    "- For non-destructive spatial additions, uncertainty is a reason to run the next native observation or a dry-run preview, not a reason to stop. Stop only after bounded native recovery is exhausted, a required write approval is missing, or the action is destructive/ambiguous.",
    "- Capability-aware routing: use /revit/native-capabilities or /revit/capabilities before planning when availability is unclear. Prefer native Revit API tools and native view exports; use sidecar/desktop automation only when the capability probe says it is available or native tools cannot reach the target.",
    "- For \"place similar near existing\", stay in the resolved room/wall by default. Do not pivot to another room/unit or stacked-level analog unless the user explicitly asks for that source.",
    "- When the task is \"place similar near existing\", prefer: resolve room wall -> /revit/rank-similar-devices-on-wall -> pick candidate cluster near the redline if needed -> get placement context for the adjacent same-room exemplar -> /revit/create-similar-from-instance (dryRun with preview first).",
    "- For markup-based electrical additions near existing receptacles, default to a nearest-similar-device workflow: use the adjacent same-room receptacle as the exemplar for host, type, elevation, orientation, and circuit matching.",
    "- Never use a Room/Space/Area element id as sourceElementId or exemplarElementId for placement. For receptacles/devices, sourceElementId/exemplarElementId must be an actual electrical fixture/device family instance; if a room id was used and failed, recover by selecting a same-room/same-circuit fixture exemplar and retrying create-similar.",
    "- Treat /revit/pick-candidate-cluster as a hint, not authority. Reject exemplar/host pairs that are off the requested room side, on unsupported source hosts, or imply implausibly large host offsets from the redline mark.",
    "- Ignore non-hostable references like grids when resolving placement hosts. If get-placement-context or a candidate cluster surfaces a grid, use the nearest supported wall host or the host of the nearest similar device instead of passing the grid through to placement tools.",
    "- If you refresh /revit/get-placement-context during a room-wall placement workflow, preserve roomNumber and roomSide from the original spatial intent; omitting them can drop the link-host placement basis.",
    "- For host-aware family placement on walls, prefer /revit/place-family-instance-on-host or /revit/create-similar-from-instance over generic XYZ-only placement.",
    "- For redline-hosted placement, do not treat raw screenshot/cropped-image pixels as active Revit view pixels. Only use view-frame pixels for model XYZ when the hint came from explicit view/sheet alignment; otherwise use room/side context plus host-local targetChainageFt/targetNormalizedChainage and verify the along-wall chainage.",
    "- Do not use generic parameter setting for electrical-device `Panel` or `Circuit Number`; those are commonly read-only. If the user wants the same circuit as an exemplar, use matchElectricalCircuitFromSource + requireElectricalCircuitMatch on the host-aware placement or hosted-adjustment call. If the user names a panel/circuit explicitly, use /revit/assign-electrical-circuit and report whether it performed real ElectricalSystem reassignment or only writable-parameter fallback.",
    "- Preserve raw coordinates from /revit/spatial-context, /revit/rank-similar-devices-on-wall, /revit/get-placement-context, and /revit/audit-hosted-instance-placement in your reasoning. Do not replace XYZ/chainage/host ids with vague summaries while planning spatial corrections.",
    "- For link-hosted or otherwise non-wall placement hosts, prefer targetChainageFt/targetNormalizedChainage when the target is a room-side redline placement; use explicit pointXyz only when it was projected from a frame-aligned view/sheet hint or /revit/project-point-to-host-frame. Do not send alongHostOffsetFt by itself unless the host is a real wall.",
    "- For spatial room/wall placements, do not emit interim status like \"not verified yet\" as if the task were complete; continue the workflow until final placement is actually validated.",
    "- For spatial placements, a screenshot or export alone is not completion. After any applied write, run one explicit /revit/audit-hosted-instance-placement pass across all created ids against the requested room and wall before declaring success.",
    "- If post-write audit or the captured image shows the result off-room, off-wall, or otherwise off the marked target, continue correcting instead of stopping at the first screenshot.",
    "- For electrical plan edits, definition of done includes view finish quality, not just model connectivity. Before reporting success, verify device orientation/facing, circuit label or tag presence when nearby devices are tagged, tag readability, and that annotation does not cover the symbol.",
    "- For electrical plan edits, use nearby same-room devices as the drafting standard by default. Match their orientation, labeling, and annotation layout unless the user explicitly asks for something different.",
    "- For short or under-specified electrical prompts, default standard is: match nearby devices in orientation, circuit labeling, and annotation layout instead of stopping once the functional edit succeeds.",
    "- Treat user screenshots as both intent and QA evidence. The latest screenshot showing the current appearance should drive final correction passes for overlap, rotation, and annotation placement issues.",
    "- After any applied electrical device move/place/rotate/tag edit in plan view, capture a focused verification region and inspect it for overlap, wrong facing, missing label, or tag obstruction before you answer that the task is complete.",
    "- Low-risk placement executor rule: for ordinary add/move/rotate/parameter edits, do not stop at moderate uncertainty when you already have a bounded path. Default loop is preview -> apply -> verify -> correct -> re-verify.",
    "- Low-risk placement executor rule: if post-apply audit still fails and the bounded move/orientation path is unavailable, immediately use the server-selected delete-and-replace recovery path; do not answer with zero actions while correction budget remains.",
    "- Low-risk placement executor rule: once a placement preview succeeds, the next step is usually to apply that same preview with dryRun=false rather than ask the user whether to proceed.",
    "- Low-risk placement executor rule: if family/type choice is unclear, inspect a nearby same-room exemplar and clone from it. Do not block on guessing a family name when exemplar-driven placement is available.",
    "- Low-risk placement executor rule: if the host is resolved but the final location is approximate, prefer host-local chainage or /revit/project-point-to-host-frame over generic XYZ guesses, then use /revit/adjust-hosted-instance-on-host for bounded corrections.",
    "- Low-risk placement executor rule: use /revit/adjust-hosted-instance-on-host for bounded hosted moves and orientation matching before falling back to generic /revit/move-elements or /revit/rotate-elements.",
    "- Treat sampled inventories as hints only. Prefer the server-provided placement_run_state, placement_work_item, resolved host context, and ranked exemplar candidates over raw inventory dumps.",
    "- For snippet-driven type changes, resolve candidate element IDs first, then use /revit/resolve-element-type or /revit/list-element-types and finally /revit/change-element-type.",
    "- Do not ask whether the attachment changed unless the user explicitly says it changed; default to reusing the session redline anchor and continue execution.",
    "- For vague semantic MEP requests such as extending piping from a main to a sink or routing ductwork to diffusers, call /tools/mep/semantic-route-plan first and follow its read-only discovery actions or guarded dry-run action before any model write. For drawing MEP geometry from redlines, prefer /revit/mep-route-workflow for route creation because it enforces resolve context -> dry-run -> optional apply -> post-change focused visual capture. A single line is two ordered points; connected path segments are one ordered point list. Use apply=false first when still uncertain, then apply=true with visualVerify=true once bounded. Inspect planned points, selected level/type/system, chosen size/elevation, connectionAttempts, createdFittingIds, openConnectorCount, and visualVerification.capture.path. If size/elevation is missing, use conservative defaults with explicit warnings (8x8 duct, 1 inch pipe, resolved routing elevation) instead of silently guessing or stopping before a useful draft. Differing segmentSizes or branchSegmentSizes plan transition fittings for reducers. For editing existing explicit duct/pipe curve ids, use /revit/edit-mep-route-elements dryRun first for whole-element size or simple level-straight elevation edits; it blocks connected elevation moves unless allowConnectedElevationMove:true and returns before/after size, curve, connector, network-audit, and optional focused capture evidence. If the requested edit changes size part way down one straight curve, use /revit/reroute-mep-route-segment size-transition mode with transitionNormalized or transitionChainageFt plus explicit upstream/downstream sizes, and require a transition fitting in connectionAttempts before completion. If the requested edit offsets a middle section of one straight curve, use /revit/reroute-mep-route-segment offset mode; set offsetMode:\"dogleg45\" when diagonal 45-degree legs are required. Connected endpoints on /revit/reroute-mep-route-segment are blocked by default; only set preserveConnectedEndpoints:true after dry-run reports a concrete endpointReconnectionPlan, then require endpoint reconnection attempts plus connector/network audit before completion. For branch/tee/tap requests, dry-run /revit/connect-mep-branch for one branch or /revit/mep-branch-network-workflow for a main route plus multiple branches. Apply is supported for existing open connector branches, straight duct tap/takeoff at a projected non-connector point, pipe tap/takeoff only when dry-run tapApplyPrecheck confirms an explicit takeoff/tap routing preference, straight duct/pipe split tee cases, branch-level reducer transitions via branchSegmentSizes, explicit duct/pipe accessory insertion on created main or branch segments when a compatible familyPath/family/type and chainage/point preconditions pass, and explicit target-id duct/pipe accessory delete/type_change with compatible loaded types. When the user names a tap/takeoff family or type, pass takeoffFamilyName/takeoffTypeName, inspect selected.takeoffRoutingPreference and tapApplyPrecheck on dry-run, and require connectionAttempts[*].fitting to match on apply. Do not claim branch/tap/accessory completion unless connector/fitting/accessory verification passes.",
    "- Large PDF package rule: analyze up to the configured package budget (default 150 pages) instead of silently stopping at page 2. Preserve native comment page/index provenance. For flattened or scanned comments, call gemini_redline_analyze with the full desired page budget; the backend executes bounded eight-page batches, aggregates/deduplicates findings, and reports exact processed, failed, and omitted ranges. Do not propose Revit writes unless package_coverage.complete is true.",
    "- Do not use /revit/create-similar-from-instance or wall-hosted family placement for duct/pipe redlines. Those tools are for hosted family instances such as receptacles/devices, not MEP curve geometry.",
    "",
    "Request body templates (use these exactly):",
    "- POST /revit/export-visible-elements:",
    "  {\"viewId\":31309289,\"imageSize\":2200,\"includeMapping\":true,\"categories\":[\"OST_ElectricalDevices\",\"OST_ElectricalFixtures\"],\"limit\":400}",
    "- POST /revit/export-view-frame:",
    "  {\"viewId\":31309289,\"includeMapping\":true,\"imageMaxSizePx\":2400}",
    "- POST /revit/resolve-room-wall:",
    "  {\"roomNumber\":\"403\",\"viewId\":31309289,\"side\":\"south\",\"maxWalls\":3,\"includeSegments\":true}",
    "- POST /revit/pick-candidate-cluster:",
    "  {\"frameId\":\"<from export-view-frame>\",\"xPx\":1180,\"yPx\":920,\"includeCategories\":[\"OST_ElectricalDevices\",\"OST_ElectricalFixtures\"],\"hostCategories\":[\"OST_Walls\"],\"roomNumber\":\"403\",\"roomSide\":\"south\",\"searchRadiusFt\":8.0,\"maxTargets\":5,\"maxHosts\":5}",
    "- POST /revit/rank-similar-devices-on-wall:",
    "  {\"roomNumber\":\"403\",\"roomSide\":\"south\",\"targetPointXyz\":{\"x\":10.5,\"y\":22.1,\"z\":0.0},\"categories\":[\"OST_ElectricalFixtures\",\"OST_ElectricalEquipment\"],\"includeKeywords\":[\"receptacle\",\"outlet\",\"duplex\",\"power\"],\"maxCandidates\":10}",
    "- POST /revit/get-placement-context:",
    "  {\"elementId\":12345,\"hostCategories\":[\"OST_Walls\"],\"hostSearchRadiusFt\":12,\"maxNearbyHosts\":5,\"roomNumber\":\"403\",\"roomSide\":\"south\"}",
    "- POST /revit/project-point-to-host-frame:",
    "  {\"hostElementId\":67890,\"roomNumber\":\"403\",\"roomSide\":\"south\",\"anchorPointXyz\":[5.0,5.0,0.0],\"targetChainageFt\":7.0}",
    "- POST /revit/create-similar-from-instance:",
    "  {\"exemplarElementId\":12345,\"hostElementId\":67890,\"placements\":[{\"alongHostOffsetFt\":-3.0,\"label\":\"R1\"},{\"alongHostOffsetFt\":3.0,\"label\":\"R2\"}],\"dryRun\":true,\"includePreviewImage\":true}",
    "  or when the new device must stay on the exemplar's circuit:",
    "  {\"exemplarElementId\":12345,\"hostElementId\":67890,\"placements\":[{\"targetChainageFt\":7.0,\"label\":\"R1\"}],\"matchElectricalCircuitFromSource\":true,\"requireElectricalCircuitMatch\":true,\"dryRun\":true,\"includePreviewImage\":true}",
    "  or for host-local chainage placements:",
    "  {\"exemplarElementId\":12345,\"hostElementId\":67890,\"roomNumber\":\"403\",\"roomSide\":\"south\",\"orientationSourceElementId\":12345,\"matchOrientationFromSource\":true,\"placements\":[{\"targetChainageFt\":2.0,\"targetNormalizedChainage\":0.1,\"label\":\"R1\"},{\"targetChainageFt\":8.0,\"targetNormalizedChainage\":0.4,\"label\":\"R2\"}],\"dryRun\":true,\"includePreviewImage\":true}",
    "  or for link-hosted placements:",
    "  {\"exemplarElementId\":12345,\"hostElementId\":67890,\"placements\":[{\"pointXyz\":[1.0,2.0,3.0],\"label\":\"R1\"},{\"pointXyz\":[4.0,2.0,3.0],\"label\":\"R2\"}],\"dryRun\":true,\"includePreviewImage\":true}",
    "- POST /revit/place-family-instance-on-host:",
    "  {\"sourceElementId\":12345,\"hostElementId\":67890,\"alongHostOffsetFt\":2.0,\"dryRun\":true,\"includePreviewImage\":true}",
    "  or when the new device must stay on the source element's circuit:",
    "  {\"sourceElementId\":12345,\"hostElementId\":67890,\"targetChainageFt\":7.0,\"matchElectricalCircuitFromSource\":true,\"requireElectricalCircuitMatch\":true,\"dryRun\":true,\"includePreviewImage\":true}",
    "  or for host-local chainage placements:",
    "  {\"sourceElementId\":12345,\"hostElementId\":67890,\"roomNumber\":\"403\",\"roomSide\":\"south\",\"orientationSourceElementId\":12345,\"matchOrientationFromSource\":true,\"targetChainageFt\":7.0,\"targetNormalizedChainage\":0.35,\"dryRun\":true,\"includePreviewImage\":true}",
    "  or for link-hosted placements:",
    "  {\"sourceElementId\":12345,\"hostElementId\":67890,\"pointXyz\":[1.0,2.0,3.0],\"dryRun\":true,\"includePreviewImage\":true}",
    "- POST /revit/export-view-region:",
    "  {\"viewId\":31309289,\"imageMaxSizePx\":2400,\"includeMapping\":true,\"fileName\":\"region.png\",\"region\":{\"mode\":\"focusElements\",\"focusElementIds\":[39264717],\"marginFt\":10.0}}",
    "  or",
    "  {\"viewId\":31309289,\"imageMaxSizePx\":2400,\"includeMapping\":true,\"region\":{\"mode\":\"center\",\"centerX\":0.0,\"centerY\":0.0,\"halfWidth\":20.0,\"halfHeight\":20.0}}",
    "- POST /revit/audit-hosted-instance-placement:",
    "  {\"elementIds\":[201,202],\"hostCategories\":[\"OST_Walls\"],\"hostSearchRadiusFt\":12,\"maxNearbyHosts\":5,\"roomNumber\":\"403\",\"roomSide\":\"south\"}",
    "- POST /revit/adjust-hosted-instance-on-host:",
    "  {\"elementId\":201,\"roomNumber\":\"403\",\"roomSide\":\"south\",\"targetChainageFt\":2.0,\"targetNormalizedChainage\":0.1,\"dryRun\":false,\"includePreviewImage\":false}",
    "  or for orientation matching:",
    "  {\"elementId\":201,\"roomNumber\":\"403\",\"roomSide\":\"south\",\"orientationSourceElementId\":12345,\"matchOrientationFromSource\":true,\"dryRun\":false,\"includePreviewImage\":false}",
    "  or when an existing device must be moved and reassigned onto the exemplar's circuit:",
    "  {\"elementId\":201,\"roomNumber\":\"303\",\"roomSide\":\"bottom\",\"targetChainageFt\":8.0,\"orientationSourceElementId\":12345,\"electricalCircuitSourceElementId\":12345,\"matchOrientationFromSource\":true,\"matchElectricalCircuitFromSource\":true,\"requireElectricalCircuitMatch\":true,\"dryRun\":false,\"includePreviewImage\":false}",
    "- POST /revit/assign-electrical-circuit:",
    "  {\"elementIds\":[22222],\"sourceElementId\":12345,\"dryRun\":true,\"parameterOnlyFallback\":true}",
    "  or when explicitly asked for a panel/circuit and source-system matching is unavailable:",
    "  {\"elementIds\":[22222],\"panelName\":\"P401\",\"circuitNumber\":\"1\",\"dryRun\":false,\"confirm\":true,\"parameterOnlyFallback\":true}",
    "- POST /revit/move-elements:",
    "  {\"ids\":[111],\"mode\":\"vector\",\"vectorX\":-3.0,\"vectorY\":0.0,\"vectorZ\":0.0,\"dryRun\":true,\"behavior\":\"allOrNothing\",\"options\":{\"failOnPinned\":true,\"unpinIfAllowed\":false}}",
    "- POST /revit/rotate-elements:",
    "  {\"ids\":[111],\"angleDegrees\":90,\"axis\":{\"mode\":\"zThroughPoint\",\"pointX\":0.0,\"pointY\":0.0,\"pointZ\":0.0},\"dryRun\":true,\"behavior\":\"allOrNothing\",\"options\":{\"failOnPinned\":true,\"unpinIfAllowed\":false}}",
    "- POST /revit/room-contents (plenum example):",
    "  {\"roomNumber\":\"0201\",\"categories\":[\"OST_DuctCurves\"],\"mode\":\"geometry\",\"verticalScope\":\"plenum\"}",
    "- POST /revit/ducts-by-spatial-scope (ductwork scope example):",
    "  {\"roomNumber\":\"office unit 301\",\"systemClassification\":\"Supply\",\"sizeFrom\":\"8\\\"\",\"verticalScope\":\"room+plenum\",\"roomMode\":\"auto\"}",
    "- POST /revit/align-room-tops-to-ceilings:",
    "  {\"levelNameContains\":\"Level 2\",\"dryRun\":true,\"behavior\":\"bestEffort\",\"toleranceFt\":0.0104}",
    "",
    "Your goals:",
    "- Be helpful and concise.",
    "- Summarize results in plain English (include the key number(s)).",
    "- When tool results are provided, continue the workflow unless success is verified, a concrete blocker exists, or bounded retries are exhausted.",
    "- Prefer safe, read-only discovery only until you have enough evidence to execute a bounded low-risk plan.",
    "- If required parameters are missing, ask a clarifying question and return zero actions.",
    "- Never propose non-allowlisted paths.",
    "- When unsure which curated /revit tool fits the intent, call POST /revit/tool-search first; when unsure about a tool contract (required fields, enums, units), prefer POST /revit/tool-examples for known placement paths, then POST /revit/tool-doc only for exact schema details before a risky action.",
    "- Use stable filenames (avoid weird characters).",
    "- High-risk actions will require explicit user approval in Revit; propose them only when the user explicitly asks."
  ];

  lines.push("");
  lines.push("Macro skills (workspace):");
  lines.push("- If a listed macro skill matches the user's request, prefer telling the user to run it (e.g. `run skill <id> with {...}`) instead of re-planning the steps.");

  const codegen = (process.env.OPERATOR_DEV_CODEGEN || "").trim().toLowerCase();
  const devAgent = (process.env.OPERATOR_DEV_AGENT_ENABLED || "").trim().toLowerCase();
  const devMode = codegen === "1" || codegen === "true" || codegen === "yes" || devAgent === "1" || devAgent === "true" || devAgent === "yes";
  if (devMode) {
    lines.push("");
    lines.push("Developer mode: CODE GENERATION ENABLED (dev-only).");
    lines.push("- You MAY include dev_actions to update local code/skills on the user's machine.");
    lines.push("- Dev actions only run when BOTH:");
    lines.push("  - OPERATOR_DEV_AGENT_ENABLED=1, and");
    lines.push("  - OPERATOR_DEV_AGENT_TOKEN is set AND the request includes header X-Operator-Dev-Agent-Token matching it.");
    lines.push("- Shell dev_actions are allowlisted; blocked commands will be rejected.");
    lines.push("- Prefer dev_actions.apply_patch with a standard git-style unified diff (suitable for `git apply`).");
    lines.push("- After modifying backend code, run `npm run build` and then dev_actions.restart_backend.");
    lines.push("- For local-only skills, prefer creating/updating markdown files under `skills/local/` (gitignored; `operator-backend/skills-local/` is legacy).");
    lines.push("- dev_actions.shell runs in Windows PowerShell. Use `;` to chain commands (avoid `&&`). Prefer: `rg`, `Get-Content`, `ls`, `dotnet build`, `npm run build` (avoid bash-only tools like `sed`).");
    lines.push("- For Windows paths in shell helpers, use environment/known-folder paths such as `$env:USERPROFILE`, `$env:LOCALAPPDATA`, `$env:APPDATA`, or `[Environment]::GetFolderPath(...)`; avoid hard-coded user Desktop paths.");
    lines.push("- Do NOT use dev_actions to debug normal Revit workflows; use the available /revit/* tools and fix your plan from tool results.");
  }

  return lines.join("\n");
}

function summarizeToolResult(r: ToolResult): string {
  const head = `${r.status.toUpperCase()} ${r.method} ${r.path} (action_id=${r.action_id})`;
  const bits: string[] = [head];
  if (r.error) bits.push(`error=${r.error}`);
  if (typeof r.duration_ms === "number") bits.push(`duration_ms=${Math.round(r.duration_ms)}`);

  const attachments = r.attachments ?? [];
  const img = attachments.filter(a => a.kind === "image");
  if (img.length > 0) bits.push(`attachments=image(${img.length})`);

  try {
    const res: any = r.result_json;
    if (res && typeof res === "object") {
      const tx = typeof res.transactionStatus === "string" ? res.transactionStatus : "";
      const rolledBack = typeof res.rolledBack === "boolean" ? res.rolledBack : false;
      const innerStatus = typeof res.status === "string" ? res.status : "";
      const failures = Array.isArray(res.failures) ? res.failures : [];
      const errorCount = failures.filter((f: any) => (f?.severity || "").toLowerCase() !== "warning").length;
      if (innerStatus) bits.push(`result_status=${innerStatus}`);
      if (tx) bits.push(`tx=${tx}`);
      if (rolledBack) bits.push(`rolledBack=true`);
      if (failures.length > 0) bits.push(`failures=${failures.length}${errorCount > 0 ? ` (errors=${errorCount})` : ""}`);
    }
  } catch {
    // ignore
  }

  try {
    if (r.path === "/revit/quantify" && r.result_json && typeof r.result_json === "object") {
      const rr: any = r.result_json;
      const total = rr?.summary?.total;
      if (typeof total === "number") bits.push(`total=${total}`);
      const rsid = typeof rr?.resultSetId === "string" ? rr.resultSetId.trim() : "";
      if (rsid) bits.push(`resultSetId=${rsid.slice(0, 12)}…`);
      const groups = rr?.summary?.groups;
      if (groups && typeof groups === "object") {
        const entries = Object.entries(groups as Record<string, unknown>)
          .filter(([, v]) => typeof v === "number")
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .slice(0, 6);
        if (entries.length > 0) bits.push(`top_groups=${entries.map(([k, v]) => `${k}:${v}`).join(",")}`);
      }
    } else if (r.path === "/revit/sheets" && r.result_json && typeof r.result_json === "object") {
      const rr: any = r.result_json;
      const total =
        typeof rr?.total === "number"
          ? rr.total
          : typeof rr?.totalMatches === "number"
            ? rr.totalMatches
            : typeof rr?.totalSheets === "number"
              ? rr.totalSheets
              : null;
      if (typeof total === "number") bits.push(`total=${total}`);
      if (typeof rr?.returned === "number") bits.push(`returned=${rr.returned}`);
      if (typeof rr?.offset === "number") bits.push(`offset=${rr.offset}`);
      if (typeof rr?.limit === "number") bits.push(`limit=${rr.limit}`);
      if (typeof rr?.hasMore === "boolean") bits.push(`hasMore=${rr.hasMore}`);
    }
  } catch {
    // ignore
  }
  return bits.join(" | ");
}

function compactOneLine(input: string, maxChars: number): string {
  const t = (input ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(1, maxChars - 13)).trimEnd() + "…(truncated)";
}

function summarizeOlderConversation(messages: SessionMessage[], maxChars: number): string {
  const userIntents: string[] = [];
  const assistantCheckpoints: string[] = [];
  let toolTurns = 0;

  for (const m of messages) {
    if (!m || typeof m.text !== "string") continue;
    const text = compactOneLine(m.text, 160);
    if (!text) continue;

    if (m.role === "user") {
      const normalized = text.toLowerCase();
      if (!userIntents.some(x => x.toLowerCase() === normalized)) userIntents.push(text);
      continue;
    }

    if (m.role === "assistant") {
      if (
        text.startsWith("Plan:") ||
        text.startsWith("Answer:") ||
        text.toLowerCase().includes("not verified") ||
        text.toLowerCase().includes("dropped ") ||
        text.toLowerCase().includes("failed")
      ) {
        assistantCheckpoints.push(text);
      }
      continue;
    }

    if (m.role === "tool") toolTurns++;
  }

  const lines: string[] = [];
  if (userIntents.length > 0) lines.push(`User intents: ${userIntents.slice(-6).join(" || ")}`);
  if (assistantCheckpoints.length > 0) lines.push(`Assistant checkpoints: ${assistantCheckpoints.slice(-5).join(" || ")}`);
  if (toolTurns > 0) lines.push(`Tool-summary turns in omitted history: ${toolTurns}`);

  if (lines.length === 0) lines.push("No salient events in omitted history.");
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n…(truncated)";
  return out;
}

function isKnowledgeBaseLikelyQuery(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hints = ["knowledge base", "uploaded", "pdf", "standard", "code", "spec", "nfpa", "ibc", "search my", "reference", "handrail", "clearance"];
  return hints.some(h => t.includes(h));
}

function formatKbLibraryBlock(ownerUserId: string): string | null {
  try {
    const docs = listKnowledgeBaseDocuments(ownerUserId, "user");
    if (!Array.isArray(docs) || docs.length === 0) return null;
    const lines: string[] = [];
    lines.push("Private knowledge base docs (user scope):");
    for (const d of docs.slice(0, 25)) {
      lines.push(`- ${d.title} [${d.status}] pages=${d.pageCount ?? "?"} docId=${d.documentId}`);
    }
    if (docs.length > 25) lines.push(`- … (${docs.length - 25} more docs)`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function maybeBuildKbSearchBlock(ownerUserId: string, query: string): Promise<string | null> {
  try {
    if (!isKnowledgeBaseLikelyQuery(query)) return null;
    const r = await searchKnowledgeBase({ query, ownerUserId, scopeType: "user", maxResults: 5, citationStyle: "short" });
    if (!Array.isArray(r.results) || r.results.length === 0) return "Private KB search: no matching chunks found.";
    const lines: string[] = [];
    lines.push("Private KB search results (ground answers to these; cite title/page/heading/confidence):");
    let i = 0;
    for (const x of r.results) {
      i++;
      const excerpt = String(x.text ?? "").replace(/\s+/g, " ").trim();
      const short = excerpt.length > 700 ? excerpt.slice(0, 700) + "…" : excerpt;
      lines.push(`[KB${i}] ${x.title} p.${x.pageStart}${x.pageEnd && x.pageEnd !== x.pageStart ? `-${x.pageEnd}` : ""}${x.heading ? ` h=${x.heading}` : ""} conf=${x.confidence}`);
      lines.push(short || "(empty excerpt)");
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function formatPermissionSummaryFromContext(ctx: unknown): { summary: string; signature: string } | null {
  try {
    const ui: any = (ctx as any)?.ui;
    if (!ui || typeof ui !== "object") return null;

    const approvalMode = typeof ui.approval_mode === "string" ? ui.approval_mode.trim() : "";
    const wg: any = ui.write_grant;
    const nativeApi: any = ui.native_api_policy;

    let wgSummary = "off";
    let wgSig = "off";
    if (wg && typeof wg === "object") {
      const active = wg.active === true;
      const mode = typeof wg.mode === "string" ? wg.mode.trim() : "";
      const exp = typeof wg.expires_at_utc === "string" ? wg.expires_at_utc.trim() : "";
      const uses = Number.isFinite(wg.uses_remaining) ? String(wg.uses_remaining) : "";
      const err = typeof wg.error === "string" ? wg.error.trim() : "";

      if (!active && err) wgSummary = `error (${err})`;
      else if (active) {
        const bits = [`active`, mode ? `mode=${mode}` : null, uses ? `uses_remaining=${uses}` : null, exp ? `expires_at_utc=${exp}` : null]
          .filter(Boolean)
          .join(" ");
        wgSummary = bits || "active";
      } else {
        wgSummary = "off";
      }

      wgSig = [active ? "1" : "0", mode || "", uses || "", exp || "", err || ""].join("|");
    }

    const nativeProfile = nativeApi && typeof nativeApi === "object" && typeof nativeApi.profile === "string" ? nativeApi.profile.trim() : "";
    const nativeLocked = nativeApi && typeof nativeApi === "object" && nativeApi.locked === true;
    const nativeSig = [nativeProfile || "", nativeLocked ? "1" : "0"].join("|");
    const nativeSummary = nativeProfile ? ` native_api_profile=${nativeProfile}${nativeLocked ? " (locked)" : ""};` : "";
    const summary = `Bridge permissions: approval_mode=${approvalMode || "unknown"}; write_grant=${wgSummary};${nativeSummary}`.replace(/;\s*$/, ".");
    const signature = [approvalMode || "", wgSig, nativeSig].join("||");
    return { summary, signature };
  } catch {
    return null;
  }
}

function getApprovalModeFromContext(ctx: unknown): "safe" | "session" | "yolo" | "unknown" {
  const raw = typeof (ctx as any)?.ui?.approval_mode === "string" ? (ctx as any).ui.approval_mode.trim().toLowerCase() : "";
  if (raw === "safe" || raw === "session" || raw === "yolo") return raw;
  return "unknown";
}

function getRecentToolPathSet(req: ChatRequest, max = 24): Set<string> {
  const recent = getAugmentedToolResults(req, max);
  const set = new Set<string>();
  for (const item of recent) {
    const method = typeof item?.method === "string" ? item.method.toUpperCase().trim() : "";
    const path = typeof item?.path === "string" ? item.path.trim() : "";
    if (!method || !path) continue;
    set.add(`${method} ${path}`);
  }
  return set;
}

function buildCapabilityRecoveryQuery(req: ChatRequest, filteredActions: ActionCall[]): string {
  const userText = String(req.user_text ?? "").replace(/\s+/g, " ").trim();
  const droppedPathTokens = filteredActions
    .map((action) => String(action?.path ?? "").trim())
    .filter((path) => path.startsWith("/revit/"))
    .map((path) => path.replace(/^\/revit\//i, "").replace(/[-_/]+/g, " ").trim())
    .filter((token) => token.length > 0);
  const semanticFallback =
    isRedlineFocusedTurn(req) || /\b(redline|screenshot|active view|room|coordinates|receptacle|outlet|where indicated)\b/i.test(userText)
      ? "redline spatial placement room contents active view capture create similar hosted device"
      : userText;
  const parts = [...droppedPathTokens.slice(0, 2), semanticFallback].filter((part) => !!part);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function userTextSuggestsUiFallback(req: ChatRequest, decision: OpenAiDecision): boolean {
  const corpus = [String(req.user_text ?? ""), String(decision.assistant_message ?? ""), ...getAugmentedToolResults(req, 12).map((r) => String(r?.error ?? ""))]
    .join(" ")
    .toLowerCase();
  if (!corpus.trim()) return false;
  return /\b(dialog|modal|popup|warning|click|button|menu|ribbon|printer|print setup|stuck|blocked ui|blocked by modal)\b/.test(corpus);
}

function maybeBuildCapabilityRecoveryResponse(args: {
  req: ChatRequest;
  decision: OpenAiDecision;
  filteredActions: ActionCall[];
  allowlisted: ActionCall[];
}): ChatResponse | null {
  const { req, decision, filteredActions, allowlisted } = args;
  if (allowlisted.length > 0) return null;

  const recentPaths = getRecentToolPathSet(req, 24);
  const query = buildCapabilityRecoveryQuery(req, filteredActions);
  const actions: ActionCall[] = [];
  if (query && !recentPaths.has("POST /revit/tool-search")) {
    actions.push({
      action_id: randomUUID(),
      method: "POST",
      path: "/revit/tool-search",
      body: {
        query,
        max: 8
      }
    });
  }

  if (query && !recentPaths.has("POST /revit/native-api-search")) {
    actions.push({
      action_id: randomUUID(),
      method: "POST",
      path: "/revit/native-api-search",
      body: {
        query,
        max: 12
      }
    });
  }

  const wantsUiFallback = userTextSuggestsUiFallback(req, decision);
  if (wantsUiFallback && !recentPaths.has("POST /revit/state-snapshot")) {
    actions.push({
      action_id: randomUUID(),
      method: "POST",
      path: "/revit/state-snapshot",
      body: {}
    });
  }
  if (wantsUiFallback && !recentPaths.has("POST /revit/computer-use-observe")) {
    actions.push({
      action_id: randomUUID(),
      method: "POST",
      path: "/revit/computer-use-observe",
      body: {}
    });
  }

  if (actions.length === 0) return null;

  const approvalMode = getApprovalModeFromContext(req.context);
  const droppedPaths = filteredActions
    .map((action) => String(action?.path ?? "").trim())
    .filter((path) => !!path)
    .slice(0, 2);
  const pathNote = droppedPaths.length > 0 ? ` The first pass did not yield an executable tool for ${droppedPaths.join(", ")}.` : "";
  const modeNote =
    approvalMode === "yolo"
      ? " YOLO is active, so I’m continuing through the full bridge/native/UI fallback ladder before I stop."
      : approvalMode === "session"
        ? " Writes are enabled for this session, so I’m continuing through the full bridge/native/UI fallback ladder before I stop."
        : "";

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `Sure — I’ll keep working through the native tool surface instead of stopping.${pathNote}${modeNote}`,
    actions
  };
}

export function __testOnlyBuildCapabilityRecoveryResponse(args: {
  req: ChatRequest;
  decision: OpenAiDecision;
  filteredActions: ActionCall[];
  allowlisted?: ActionCall[];
}): ChatResponse | null {
  return maybeBuildCapabilityRecoveryResponse({
    req: args.req,
    decision: args.decision,
    filteredActions: args.filteredActions,
    allowlisted: Array.isArray(args.allowlisted) ? args.allowlisted : []
  });
}

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
type TextVerbosity = "low" | "medium" | "high";

function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort = "medium"): ReasoningEffort {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh"
    ? normalized
    : fallback;
}

function getRequestedReasoningEffort(req: ChatRequest, fallback: ReasoningEffort = "medium"): ReasoningEffort {
  const ui: any = (req.context as any)?.ui;
  return normalizeReasoningEffort(ui?.reasoning_effort ?? ui?.reasoningEffort, fallback);
}

function normalizeTextVerbosity(value: unknown, fallback: TextVerbosity = "low"): TextVerbosity {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : fallback;
}

function getRequestedServiceTier(): "priority" | "flex" | null {
  const normalized = (process.env.OPERATOR_OPENAI_SERVICE_TIER ?? "priority").trim().toLowerCase();
  if (normalized === "priority") return "priority";
  if (normalized === "flex") return "flex";
  return null;
}

async function maybeBuildRedlineExecutionBridge(req: ChatRequest, workbenchResults: WorkbenchActionResult[]): Promise<ChatResponse | null> {
  pickRedlineSeed(req, { allowSessionFallback: true });
  updateRedlineVisionProgressFromWorkbench(req.session_id, workbenchResults);
  await maybeInferRedlineImageMarkHint(req);
  let bridge = maybeBuildRedlineExecutionBridgeCore({
    req,
    workbenchResults,
    toolResults: getAugmentedToolResults(req, 80)
  });
  if (
    bridge &&
    bridgeHasHostedPlacementAction(bridge) &&
    hasAlignableRedlineImageSeed(req.session_id) &&
    !hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults)
  ) {
    const recoveredHints = await maybeAutoAlignRedlineViewHints({
      req,
      workbenchResults,
      allowSyntheticFallback: false
    });
    if (recoveredHints > 0 && hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults)) {
      const rebuilt = maybeBuildRedlineExecutionBridgeCore({
        req,
        workbenchResults,
        toolResults: getAugmentedToolResults(req, 80)
      });
      if (rebuilt && hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults)) return rebuilt;
      if (rebuilt && !bridgeHasHostedPlacementAction(rebuilt)) return rebuilt;
    }
    return maybeBuildMeasuredRedlineTargetBlocker(req, bridge);
  }
  if (bridge && !isRecoverableNoPickHintBridge(bridge)) return bridge;

  const noPickBridge = bridge;
  const mappedHints = await maybeAutoMapRedlineSheetRegions({ req, workbenchResults });
  if (mappedHints > 0) {
    bridge = maybeBuildRedlineExecutionBridgeCore({
      req,
      workbenchResults,
      toolResults: getAugmentedToolResults(req, 80)
    });
    if (bridge && !isRecoverableNoPickHintBridge(bridge)) return bridge;
  }

  const recoveredHints = await maybeAutoAlignRedlineViewHints({ req, workbenchResults });
  if (recoveredHints <= 0) return noPickBridge ?? null;

  bridge = maybeBuildRedlineExecutionBridgeCore({
    req,
    workbenchResults,
    toolResults: getAugmentedToolResults(req, 80)
  });
  return bridge ?? noPickBridge ?? null;
}

export function __testOnlyBuildRedlineExecutionBridge(args: {
  userText: string;
  toolResults?: ToolResult[];
  workbenchResults?: WorkbenchActionResult[];
  context?: Record<string, unknown>;
}): ChatResponse | null {
  const testSessionId = randomUUID();
  return maybeBuildRedlineExecutionBridgeCore({
    req: {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: testSessionId,
      message_id: `${testSessionId}:message`,
      user_text: typeof args.userText === "string" ? args.userText : "",
      ...(args.context ? { context: args.context } : {})
    } satisfies ChatRequest,
    workbenchResults: Array.isArray(args.workbenchResults) ? args.workbenchResults : [],
    toolResults: Array.isArray(args.toolResults) ? args.toolResults : []
  });
}

export async function __testOnlyBuildRedlineExecutionBridgeAsync(args: {
  userText: string;
  toolResults?: ToolResult[];
  workbenchResults?: WorkbenchActionResult[];
  context?: Record<string, unknown>;
  userAttachments?: ChatRequest["user_attachments"];
  sessionId?: string;
}): Promise<ChatResponse | null> {
  const testSessionId = typeof args.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : randomUUID();
  const req = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: testSessionId,
    message_id: `${testSessionId}:message`,
    user_text: typeof args.userText === "string" ? args.userText : "",
    ...(args.context ? { context: args.context } : {}),
    ...(Array.isArray(args.toolResults) ? { tool_results: args.toolResults } : {}),
    ...(Array.isArray(args.userAttachments) ? { user_attachments: args.userAttachments } : {})
  } satisfies ChatRequest;
  // The production request flow seeds redline attachments during initial
  // preflight. The async bridge helper does the same so automatic no-pick
  // remapping is covered directly in unit tests.
  pickRedlineSeed(req, { allowSessionFallback: true });
  return maybeBuildRedlineExecutionBridge(
    req,
    Array.isArray(args.workbenchResults) ? args.workbenchResults : []
  );
}

async function buildPrompt(req: ChatRequest, lane?: { route: SpeedRouteKind; reason: string }): Promise<string> {
  const history = getHistory(req.session_id);
  const lines: string[] = [];
  const speedSettings = resolveSpeedSettings(req.context);

  lines.push(process.env.OPERATOR_OPENAI_SYSTEM_PROMPT || defaultSystemPrompt());
  lines.push("");
  if (speedSettings.speed_mode) {
    lines.push(
      `Speed mode: enabled; planner=${speedSettings.planner_model}/${speedSettings.planner_reasoning_effort}; executor=${speedSettings.executor_model}/${speedSettings.executor_reasoning_effort}; context_diet=${speedSettings.context_diet ? "on" : "off"}.`
    );
    if (lane?.route === "planner") {
      lines.push(`Current lane: planner (${lane.reason}). Resolve intent, constraints, success criteria, the smallest concrete action sequence, and required verification. Do not repeat settled discovery.`);
    } else if (lane?.route === "executor") {
      lines.push(`Current lane: executor (${lane.reason}). Continue from the user's established intent and tool state, emit the next executable action, and verify it. Do not reopen settled decisions or repeat completed calls.`);
    }
    if (speedSettings.context_diet) {
      lines.push("Speed mode context diet is active: prefer targeted tool discovery over full registries and avoid unnecessary read-only loops.");
    }
    lines.push("");
  }

  lines.push("Fast Revit edit playbooks:");
  lines.push("- Parameter edits: resolve the target element ID, read its relevant parameters with POST /revit/get-parameters, then write the exact resolved parameter with POST /revit/set-parameter or a purpose-built updater, then do one targeted readback. Do not guess parameter names when a quick parameter read can resolve them.");
  lines.push("- For a named electrical panel AIC/SCCR edit, prefer one targeted POST /revit/update-panel-parameter using panelName, parameterName:\"A.I.C. Rating\" or \"Short Circuit Rating\", value, onlyWhenBlank:false, targetScope:\"panel\", dryRun:false when the user asked to make the change and write grant is active; avoid /revit/tool-doc or /revit/tool-examples unless that direct call fails.");
  lines.push("- Avoid exploratory tool-doc/tool-examples calls for common parameter updates when /revit/find-elements, /revit/get-parameters, /revit/set-parameter, or /revit/update-panel-parameter are already available.");
  lines.push("");

  try {
    lines.push(formatEnvironmentSummaryForPrompt());
    lines.push("");
  } catch {
    // ignore
  }

  // Host-configured web research mode (not model-decided).
  try {
    const policy = getWebResearchPolicyFromEnv();
    const allow = policy.allowlistDomains?.length ? policy.allowlistDomains.join(", ") : "(none)";
    const deny = policy.denylistDomains?.length ? policy.denylistDomains.join(", ") : "(none)";
    lines.push(`Web research mode: ${policy.mode}`);
    if (policy.mode === "whitelist") lines.push(`Allowed domains: ${allow}`);
    if (policy.mode === "unrestricted") lines.push(`Blocked domains: ${deny}`);
    lines.push("");
  } catch {
    // ignore
  }

  const pinnedGoal = getPinnedGoal(req.session_id);
  if (pinnedGoal) {
    lines.push("Pinned user goal (do NOT lose this during tool loops):");
    lines.push(pinnedGoal);
    lines.push("");
  }

  try {
    const activeGoalContext = formatActiveGoalContext(getActiveGoalForSession(req.session_id));
    if (activeGoalContext) {
      lines.push(activeGoalContext);
      lines.push("");
    }
  } catch {
    // ignore goal context failures in prompt construction
  }

  try {
    const profileBlock = formatProjectProfileForPrompt();
    if (profileBlock) {
      lines.push(profileBlock);
      lines.push("");
    }
  } catch {
    // ignore
  }

  const principal = getRequestPrincipal();
  const ownerUserId = knowledgeBaseOwnerIdForPrincipal(principal);
  if (ownerUserId) {
    const kbLibrary = formatKbLibraryBlock(ownerUserId);
    if (kbLibrary) {
      lines.push(kbLibrary);
      lines.push("");
    }
    const kbQuery = ((req.user_text ?? "").toString().trim() || pinnedGoal || "").trim();
    if (kbQuery) {
      const kbSearch = await maybeBuildKbSearchBlock(ownerUserId, kbQuery);
      if (kbSearch) {
        lines.push(kbSearch);
        lines.push("");
      }
    }
  }

  // Phase 2 (initial): retrieve relevant memory from JSONL daily/longterm stores.
  try {
    const query = ((req.user_text ?? "").toString().trim() || pinnedGoal || "").trim();
    if (query && !isRedlineFocusedTurn(req)) {
      const mem = retrieveMemoryContext({ queryText: query, maxEntries: 8 });
      if (mem.length > 0) {
        lines.push("MEMORY CONTEXT (read-only; cite by [M#]):");
        let i = 0;
        for (const m of mem) {
          i++;
          const tag = Array.isArray(m.tags) && m.tags.length > 0 ? ` tags=${m.tags.slice(0, 6).join(",")}` : "";
          lines.push(`[M${i}] (${m.scope}/${m.kind}${tag}) ${m.text}`);
        }
        lines.push("");
      }
    }
  } catch {
    // ignore
  }

  if (shouldIncludeSkillLibrary(req)) {
    const skills = getSkillLibraryText();
    if (skills) {
      const maxChars = Math.max(1200, Number.parseInt(process.env.OPERATOR_PROMPT_MAX_SKILL_CHARS ?? "7000", 10) || 7000);
      const trimmed = skills.length > maxChars ? skills.slice(0, maxChars) + "\n…(truncated)" : skills;
      lines.push("Skill library (selected docs; may be truncated):");
      lines.push(trimmed);
      lines.push("");
    }
  } else {
    lines.push("Skill library omitted for token efficiency on this turn. Query specific docs/skills only when needed.");
    lines.push("");
  }

  const serverCtx = (req.context as any)?.__server;
  const loopPressure = serverCtx?.loop_pressure && typeof serverCtx.loop_pressure === "object" ? (serverCtx.loop_pressure as any) : null;
  if (loopPressure && typeof loopPressure.hint === "string" && loopPressure.hint.trim()) {
    lines.push(loopPressure.hint.trim());
    if (loopPressure.hard_stop === true) {
      lines.push("Hard stop mode is active for read-only churn: do not emit another read-only sheet-discovery loop.");
    }
    lines.push("");
  }
  const webEvidenceBlock = typeof serverCtx?.web_evidence === "string" ? serverCtx.web_evidence.trim() : "";
  if (webEvidenceBlock) {
    lines.push("Web evidence (use as citations; verify using saved evidence paths):");
    lines.push(webEvidenceBlock);
    lines.push("");
  }
  const workbenchResultsBlock = typeof serverCtx?.workbench_results === "string" ? serverCtx.workbench_results.trim() : "";
  if (workbenchResultsBlock) {
    lines.push("Workbench results (backend interim execution):");
    lines.push(workbenchResultsBlock);
    const wbLower = workbenchResultsBlock.toLowerCase();
    if (wbLower.includes("fail analyze_redline") || wbLower.includes("redline analysis failed")) {
      lines.push("Workbench hint: analyze_redline already failed; do not retry the same request. Pivot to gemini_redline_analyze and/or explicit sheet resolution.");
    }
    lines.push("");
  }
  const redlinePreflightBlock = typeof serverCtx?.redline_preflight_package === "string" ? serverCtx.redline_preflight_package.trim() : "";
  if (redlinePreflightBlock) {
    lines.push("Fast redline preflight package (use this before requesting more discovery):");
    lines.push(redlinePreflightBlock);
    lines.push("");
  }
  const redlineDiagnosticsBlock = typeof serverCtx?.redline_diagnostics === "string" ? serverCtx.redline_diagnostics.trim() : "";
  if (redlineDiagnosticsBlock) {
    lines.push("Redline diagnostics:");
    lines.push(redlineDiagnosticsBlock);
    lines.push("");
  }
  const placementRunStateBlock =
    serverCtx?.placement_run_state && typeof serverCtx.placement_run_state === "object"
      ? JSON.stringify(serverCtx.placement_run_state, null, 2)
      : typeof serverCtx?.placement_run_state === "string"
        ? serverCtx.placement_run_state.trim()
        : "";
  if (placementRunStateBlock) {
    lines.push("Placement run state (stable server object; prefer this for next-step decisions):");
    lines.push(placementRunStateBlock);
    lines.push("");
  }
  const placementWorkItemBlock = typeof serverCtx?.placement_work_item === "string" ? serverCtx.placement_work_item.trim() : "";
  if (placementWorkItemBlock) {
    lines.push("Placement work item (server-ranked; prefer this over raw inventory spelunking):");
    lines.push(placementWorkItemBlock);
    lines.push("");
  }
  const wbImagePaths = Array.isArray(serverCtx?.workbench_inline_image_paths)
    ? (serverCtx.workbench_inline_image_paths as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim())
    : [];
  if (wbImagePaths.length > 0) {
    lines.push(`Workbench images available: ${wbImagePaths.length} (attached for vision in this round).`);
    lines.push("");
  }

  // Make permissions explicit so the model doesn't miss write-grant/approval changes buried in JSON context.
  try {
    const perms = formatPermissionSummaryFromContext(req.context);
    if (perms) {
      const prev = lastPermissionSignatureBySession.get(req.session_id) || "";
      lastPermissionSignatureBySession.set(req.session_id, perms.signature);
      if (prev && prev !== perms.signature) lines.push(`Permission update (changed since last message): ${perms.summary}`);
      else lines.push(perms.summary);
      lines.push("");
    }
  } catch {
    // ignore
  }

  if (req.context !== undefined) {
    try {
      // Avoid bloating prompts with server-only blobs (e.g., web evidence text).
      const base = req.context && typeof req.context === "object" ? { ...(req.context as any) } : req.context;
      if (base && typeof base === "object" && "__server" in (base as any)) delete (base as any).__server;
      const contextForPrompt =
        speedSettings.context_diet && !speedSettings.include_full_revit_state
          ? projectContextForSpeedDiet(base)
          : base;
      const maxContextChars = speedSettings.context_diet && !speedSettings.include_full_revit_state ? 2600 : 6000;
      const ctx = JSON.stringify(contextForPrompt);
      const trimmed = ctx.length > maxContextChars ? ctx.slice(0, maxContextChars) + "…(truncated)" : ctx;
      lines.push(speedSettings.context_diet && !speedSettings.include_full_revit_state ? "Revit context (speed diet JSON):" : "Revit context (JSON):");
      lines.push(trimmed);
      lines.push("");
    } catch {
      // ignore context serialization issues
    }
  }

  const attachments = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  if (attachments.length > 0) {
    lines.push("User attachments (this turn):");
    let i = 0;
    for (const a of attachments.slice(0, 12)) {
      i++;
      const id = typeof a.id === "string" ? a.id.trim() : "";
      const name = typeof a.filename === "string" ? a.filename.trim() : "";
      const rp = typeof a.relative_path === "string" ? a.relative_path.trim() : "";
      const ext = typeof a.external_path === "string" ? a.external_path.trim() : "";
      const sha = typeof a.sha256 === "string" ? a.sha256.trim().slice(0, 12) : "";
      const loc = rp ? `path=${rp}` : ext ? `external=${ext}` : "";
      const meta = [id ? `id=${id}` : null, loc || null, sha ? `sha256=${sha}…` : null].filter(Boolean).join(", ");
      lines.push(`- [${i}] ${name || rp || ext || id}${meta ? ` (${meta})` : ""}`);
    }

    const fileHints = extractAttachmentFilenameSheetHints(req);
    if (fileHints.length > 0) {
      lines.push("");
      lines.push("Attachment filename sheet hints (high-confidence anchors):");
      for (const h of fileHints) lines.push(`- ${h.file} -> ${h.sheet}`);
      lines.push("If document text references many sheets, resolve this filename hint first unless user says otherwise.");
    }

    try {
      const extracted = await getAttachmentExcerptsForPrompt(attachments);
      if (extracted.length > 0) {
        lines.push("");
        lines.push("Attachment excerpts (use these as citations):");
        for (const f of extracted.slice(0, 6)) {
          const head = `- ${f.label} (id=${f.id}${f.relative_path ? `, path=${f.relative_path}` : ""})`;
          lines.push(head);
          if (f.warning) lines.push(`  - warning: ${f.warning}`);
          for (const ex of (f.excerpts ?? []).slice(0, 3)) {
            lines.push(`  - ${ex.anchor}: ${ex.text}`);
          }
        }
      }
    } catch {
      // ignore extraction failures in prompt construction
    }

    lines.push("");
  }

  const rememberedRedline = getRedlineSessionSeed(req.session_id);
  if (
    rememberedRedline &&
    attachments.length === 0 &&
    (userTextLooksRedlineContinuation(req) || (Array.isArray(req.tool_results) && req.tool_results.length > 0))
  ) {
    lines.push("Recent redline anchor from this session (reuse unless user says attachment changed):");
    lines.push(
      `- file_path=${rememberedRedline.file_path}` +
        `${rememberedRedline.expected_sheet ? ` ; expected_sheet=${rememberedRedline.expected_sheet}` : ""}` +
        `${rememberedRedline.filename ? ` ; filename=${rememberedRedline.filename}` : ""}`
    );
    lines.push("Avoid broad recursive list_files searches (., Workspace, /) when this anchor is available.");
    lines.push("");
  }

  const dev = (req.context as any)?.dev;
  if (dev && typeof dev === "object") {
    const enabled = !!(dev as any).enabled;
    const maxSteps = (dev as any).max_tool_steps;
    if (enabled) {
      lines.push(`Dev mode enabled (max tool-loop steps on host: ${typeof maxSteps === "number" ? maxSteps : "unknown"}).`);
      lines.push("");
    }
  }

  const toolsFromContext = (req.context as any)?.capabilities?.tools;
  if (Array.isArray(toolsFromContext) && toolsFromContext.length > 0) {
    const totalTools = toolsFromContext.length;
    lines.push("Tools summary (allowlisted Revit actions):");
    lines.push(`- Total available this session: ${totalTools}`);
    lines.push("- Discovery workflow: POST /revit/tool-search -> POST /revit/tool-doc -> POST /revit/tool-examples (use GET /revit/tool-registry only for the full inventory).");
    lines.push("- Native API fallback workflow: GET/POST /revit/native-api-policy -> POST /revit/native-api-search -> POST /revit/native-api-call.");
    if (totalTools > 120) {
      lines.push("- Tool list omitted from prompt for token efficiency on large inventories.");
    }

    const byGroup = new Map<string, Array<{ method: string; path: string; title: string }>>();
    for (const t of toolsFromContext) {
      if (!t || typeof t !== "object") continue;
      const method = typeof (t as any).method === "string" ? (t as any).method.toUpperCase() : "";
      const path = typeof (t as any).path === "string" ? (t as any).path : "";
      if (!method || !path) continue;
      const title = typeof (t as any).title === "string" ? (t as any).title : "";
      const group = typeof (t as any).group === "string" ? (t as any).group : "";
      const g = group || "misc";
      const arr = byGroup.get(g) ?? [];
      arr.push({ method, path, title });
      byGroup.set(g, arr);
    }
    const groups = [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [group, arr] of groups.slice(0, 16)) {
      if (totalTools > 120) {
        lines.push(`- ${group}: ${arr.length} tool(s)`);
      } else {
        const preview = arr
          .slice(0, 8)
          .map(x => `${x.method} ${x.path}${x.title ? ` (${x.title})` : ""}`)
          .join("; ");
        lines.push(`- ${group}: ${preview}${arr.length > 8 ? `; ...(+${arr.length - 8} more)` : ""}`);
      }
    }
    if (groups.length > 16) lines.push(`... (+${groups.length - 16} more groups)`);
    lines.push("");
  } else {
    lines.push("Tools:");
    lines.push("- Use GET /revit/capabilities to discover the allowlisted actions for this session.");
    lines.push("");
  }

  lines.push("Output contract:");
  lines.push("- The host enforces a structured response schema; keep assistant_message concise and put executable work in actions, web_requests, or workbench_actions.");
  lines.push("- For actions, set body_json to a JSON string for POST bodies and null for GET actions.");
  lines.push("- Use POST /ui/open to launch a hosted tool UI when an interactive web UI is the best fit; use POST /ui/close to dismiss it.");
  lines.push("");

  const maxPromptMessages = speedSettings.context_diet
    ? Math.max(2, Math.min(40, speedSettings.max_recent_turns))
    : Math.max(6, Math.min(120, Number.parseInt(process.env.OPERATOR_PROMPT_MAX_MESSAGES ?? "28", 10) || 28));
  const recent = history.slice(Math.max(0, history.length - maxPromptMessages));
  const omittedCount = Math.max(0, history.length - recent.length);
  if (omittedCount > 0) {
    const older = history.slice(0, omittedCount);
    const maxCompactChars = Math.max(
      400,
      Math.min(6000, Number.parseInt(process.env.OPERATOR_PROMPT_COMPACT_SUMMARY_MAX_CHARS ?? "1400", 10) || 1400)
    );
    lines.push(`Conversation compact summary (older ${omittedCount} message(s)):`); 
    lines.push(summarizeOlderConversation(older, maxCompactChars));
    lines.push("");
  }

  lines.push("Conversation (most recent last; truncated):");
  for (const m of recent) lines.push(`${m.role.toUpperCase()}: ${m.text}`);

  const toolResults = req.tool_results ?? [];
  if (toolResults.length > 0) {
    lines.push("");
    lines.push("Tool results from Revit:");
    for (const r of toolResults) lines.push(summarizeToolResult(r));
    lines.push("Tool outputs are persisted in run bundles and SQLite; request specific follow-up reads instead of replaying full payloads.");
    lines.push("");
    lines.push("Tool results (reduced JSON; key IDs/fields only):");
    lines.push(truncateJson(projectToolResultsForPrompt(toolResults), speedSettings.context_diet && !speedSettings.verbose_tool_results ? 2200 : 4500));
    const hints = buildToolLoopHints(toolResults);
    if (hints.length > 0) {
      lines.push("");
      lines.push("Execution hints (from latest tool results):");
      for (const h of hints) lines.push(`- ${h}`);
    }
  }

  const userText = (req.user_text ?? "").trim();
  if (userText) lines.push(`USER: ${userText}`);

  return lines.join("\n");
}

function projectContextForSpeedDiet(context: unknown): unknown {
  const ctx = context && typeof context === "object" ? (context as any) : {};
  const revit = ctx.revit && typeof ctx.revit === "object" ? ctx.revit : {};
  const document = revit.document && typeof revit.document === "object" ? revit.document : {};
  const activeView = revit.active_view && typeof revit.active_view === "object" ? revit.active_view : {};
  const tools = Array.isArray(ctx.capabilities?.tools) ? ctx.capabilities.tools : [];
  return {
    ui: ctx.ui ?? null,
    revit: {
      document: {
        title: document.title ?? document.name ?? null,
        path: document.path ?? document.file_path ?? null,
        is_workshared: document.is_workshared ?? null
      },
      active_view: {
        id: activeView.id ?? activeView.element_id ?? null,
        name: activeView.name ?? null,
        type: activeView.type ?? activeView.view_type ?? null,
        scale: activeView.scale ?? null
      }
    },
    capabilities: ctx.capabilities
      ? {
          contract_version: ctx.capabilities.contract_version ?? ctx.capabilities.version ?? null,
          tool_count: tools.length,
          allowlist: ctx.capabilities.allowlist ?? null
        }
      : null
  };
}

function projectToolResultsForPrompt(toolResults: ToolResult[]): unknown {
  const out: any[] = [];
  for (const r of toolResults) {
    const base: any = {
      action_id: r.action_id,
      method: r.method,
      path: r.path,
      status: r.status,
      error: r.error ?? null
    };

    // Avoid embedding base64 blobs.
    if (Array.isArray(r.attachments) && r.attachments.length > 0) {
      base.attachments = r.attachments.map(a => ({
        kind: a.kind,
        mime: (a as any).mime ?? null,
        filename: (a as any).filename ?? null,
        local_path: (a as any).local_path ?? null
      }));
    }

    const res = r.result_json as any;
    if (r.path === "/revit/quantify" && res && typeof res === "object") {
      const rows: any[] = Array.isArray(res.rows) ? res.rows : [];
      base.summary = res.summary ?? null;
      base.resultSetId = res.resultSetId ?? null;
      base.ids = rows
        .filter(row => (row?.source ?? "host") !== "link")
        .map(row => row?.id)
        .filter(id => typeof id === "number")
        .slice(0, 500);
    } else if (r.path === "/revit/align-elements" && res && typeof res === "object") {
      base.result_status = res.status ?? null;
      base.transactionStatus = res.transactionStatus ?? null;
      base.rolledBack = res.rolledBack ?? null;
      base.axis = res.axis ?? null;
      base.gapBeforeFt = res.gapBeforeFt ?? null;
      base.gapAfterFt = res.gapAfterFt ?? null;
      base.withinTolerance = res.withinTolerance ?? null;
      base.source = res.source?.elementId ?? null;
      base.target = res.target?.elementId ?? null;
      base.failures = Array.isArray(res.failures) ? res.failures.slice(0, 30) : null;
      base.preview = res.preview?.path ?? null;
    } else if (r.path === "/revit/room-align-wall-to-nearest-column" && res && typeof res === "object") {
      base.result_status = res.status ?? null;
      base.transactionStatus = res.transactionStatus ?? null;
      base.rolledBack = res.rolledBack ?? null;
      base.roomNumber = res.roomNumber ?? null;
      base.viewId = res.viewId ?? null;
      base.wallSide = res.wallSide ?? null;
      base.axis = res.axis ?? null;
      base.chosenWallId = res.chosenWallId ?? null;
      base.chosenColumnId = res.chosenColumnId ?? null;
      base.gapBeforeFt = res.gapBeforeFt ?? null;
      base.gapAfterFt = res.gapAfterFt ?? null;
      base.withinTolerance = res.withinTolerance ?? null;
      base.failures = Array.isArray(res.failures) ? res.failures.slice(0, 30) : null;
      base.warnings = Array.isArray(res.warnings) ? res.warnings.slice(0, 20) : null;
      base.preview = res.preview?.path ?? null;
    } else if (r.path === "/revit/sheets" && res && typeof res === "object") {
      const items: any[] = Array.isArray(res.items) ? res.items : [];
      const total =
        typeof res.total === "number"
          ? res.total
          : typeof res.totalMatches === "number"
            ? res.totalMatches
            : typeof res.totalSheets === "number"
              ? res.totalSheets
              : null;
      base.action = typeof res.action === "string" ? res.action : null;
      base.total = total;
      base.totalMatches = typeof res.totalMatches === "number" ? res.totalMatches : total;
      base.totalSheets = typeof res.totalSheets === "number" ? res.totalSheets : null;
      base.returned = typeof res.returned === "number" ? res.returned : items.length;
      base.offset = typeof res.offset === "number" ? res.offset : null;
      base.limit = typeof res.limit === "number" ? res.limit : null;
      base.hasMore = typeof res.hasMore === "boolean" ? res.hasMore : null;
      base.nextOffset = typeof res.nextOffset === "number" ? res.nextOffset : null;
      base.paging =
        res.paging && typeof res.paging === "object"
          ? {
              offset: (res.paging as any)?.offset ?? null,
              limit: (res.paging as any)?.limit ?? null,
              returned: (res.paging as any)?.returned ?? null,
              hasMore: (res.paging as any)?.hasMore ?? null,
              nextOffset: (res.paging as any)?.nextOffset ?? null
            }
          : null;
      base.items = items.slice(0, 500).map((it: any) => ({
        id: it?.id ?? null,
        viewId: it?.viewId ?? null,
        sheetNumber: it?.sheetNumber ?? null,
        name: it?.name ?? null
      }));
    } else if (r.path === "/revit/query" && Array.isArray(res)) {
      base.ids = res
        .map(row => row?.id)
        .filter(id => typeof id === "number")
        .slice(0, 500);
    } else if (r.path === "/revit/get-parameters" && res && typeof res === "object") {
      const parameterItems = extractResultItems(res);
      if (parameterItems.length > 0) {
        const items = parameterItems.slice(0, 80).map((it: any) => ({
          id: it?.id ?? null,
          elementId: it?.elementId ?? it?.element_id ?? null,
          name: it?.name ?? null,
          category: it?.category ?? null,
          parameters: truncateValue(it?.parameters ?? null, 600),
          error: it?.error ?? null
        }));
        base.items = items;
      } else {
        base.parameters = res.parameters ?? null;
        base.id = res.id ?? null;
        base.name = res.name ?? null;
      }
    } else if (r.path === "/revit/export-visible-elements" && res && typeof res === "object") {
      base.inventory = compactVisibleElementsResult(res, { maxItems: 16, maxCountEntries: 6 });
    } else if (r.path === "/revit/spatial-context" && res && typeof res === "object") {
      base.result = truncateValue(res, 5000);
    } else if (r.path === "/revit/rank-similar-devices-on-wall" && res && typeof res === "object") {
      base.result = truncateValue(res, 7000);
    } else if (r.path === "/revit/assign-electrical-circuit" && res && typeof res === "object") {
      base.result = truncateValue(res, 4000);
    } else {
      // Default: include a small snippet.
      base.result = truncateValue(res, 2000);
    }

    out.push(base);
  }
  return out;
}

function buildToolLoopHints(toolResults: ToolResult[]): string[] {
  const hints: string[] = [];
  let sawPanelScheduleGraphic = false;
  let panelName: string | null = null;
  const staleElementIds = collectRecentStaleElementIds(toolResults);

  for (const r of toolResults) {
    if (!r || typeof r !== "object") continue;
    const path = (r.path ?? "").trim().toLowerCase();
    const status = (r.status ?? "").trim().toLowerCase();

    if (
      path === "/revit/sheets" &&
      status === "failed" &&
      typeof r.error === "string" &&
      r.error.includes("sheets(detail) requires sheetNumber, sheetId, viewId, or query.")
    ) {
      hints.push("Use /revit/sheets action:\"detail\" with one singular selector field: sheetNumber, sheetId, viewId, or query.");
    }

    if (path === "/revit/get-element-summary" && status === "done" && Array.isArray(r.result_json)) {
      for (const it of r.result_json.slice(0, 10)) {
        if (!it || typeof it !== "object") continue;
        const category = typeof (it as any).category === "string" ? ((it as any).category as string).trim() : "";
        if (!/panel schedule graphics/i.test(category)) continue;
        sawPanelScheduleGraphic = true;
        const nm = typeof (it as any).name === "string" ? ((it as any).name as string).trim() : "";
        if (!panelName && nm) panelName = nm;
      }
    }

    if (path === "/revit/export-visible-elements" && status === "done") {
      const inventory = describeVisibleElementsInventory(r.result_json);
      if (!inventory || inventory.count === null) continue;
      const categoryNote = inventory.topCategories.length > 0 ? ` Top categories: ${inventory.topCategories.slice(0, 3).join(", ")}.` : "";
      const roomNote = inventory.topRooms.length > 0 ? ` Top rooms/spaces: ${inventory.topRooms.slice(0, 3).join(", ")}.` : "";
      hints.push(
        `Visible inventory already exported (${inventory.count} items, sampled ${inventory.sampled}). Do not call /revit/export-visible-elements again unless the view changes.${categoryNote}${roomNote} Use the existing mapped inventory to choose the nearest same-room/same-wall exemplar and continue with /revit/pick-candidate-cluster or /revit/get-placement-context.`
      );
    }

    if (
      status === "failed" &&
      typeof r.error === "string" &&
      /unsupported host element(?::| for [^:]+:)\s*grids?/i.test(r.error)
    ) {
      hints.push(
        "Placement failed because the resolved host was a grid. Re-run the placement path with a supported wall host: inspect the nearest same-room receptacle, use its host as the placement basis, and prefer /revit/create-similar-from-instance or /revit/place-family-instance-on-host with the supported wall host."
      );
    }
  }

  if (sawPanelScheduleGraphic) {
    if (panelName) {
      hints.push(
        `Selected element is Panel Schedule Graphics (${panelName}). Resolve the actual panel via /revit/find-elements with categories:[\"OST_ElectricalEquipment\"], nameContains:\"${panelName}\", limit:20 before parameter edits.`
      );
    } else {
      hints.push(
        "Selected element is Panel Schedule Graphics. Resolve the actual panel via /revit/find-elements with categories:[\"OST_ElectricalEquipment\"] before parameter edits."
      );
    }
  }

  if (staleElementIds.length > 0) {
    hints.push(
      `Recent follow-up checks hit stale element ids (${staleElementIds.join(", ")}). ` +
      "Do not keep querying those ids; re-resolve the current live target from the active view, nearby exemplars, or the latest applied write result before continuing."
    );
  }

  return Array.from(new Set(hints));
}

function truncateValue(value: unknown, maxChars: number): unknown {
  try {
    const s = JSON.stringify(value);
    if (!s) return null;
    if (s.length <= maxChars) return value;
    return { _truncated: true, json: s.slice(0, maxChars) + "…(truncated)" };
  } catch {
    return null;
  }
}

function truncateJson(obj: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(obj, null, 2);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + "\n…(truncated)";
  } catch {
    return "(failed to serialize tool results)";
  }
}

async function buildInput(req: ChatRequest, lane?: { route: SpeedRouteKind; reason: string }): Promise<any> {
  const prompt = await buildPrompt(req, lane);

  if (!shouldAttachImages(req)) return prompt;

  const images: string[] = [];
  const maxToolImages = Math.max(0, Number.parseInt(process.env.OPERATOR_PROMPT_MAX_TOOL_IMAGES ?? "2", 10) || 2);
  const maxUserImages = Math.max(0, Number.parseInt(process.env.OPERATOR_PROMPT_MAX_USER_IMAGES ?? "1", 10) || 1);
  const maxWorkbenchImages = Math.max(0, Number.parseInt(process.env.OPERATOR_PROMPT_MAX_WORKBENCH_IMAGES ?? "4", 10) || 4);
  const maxImageBytes = Math.max(256 * 1024, Number.parseInt(process.env.OPERATOR_PROMPT_MAX_IMAGE_BYTES ?? `${2 * 1024 * 1024}`, 10) || 2 * 1024 * 1024);
  images.push(...collectInlineImagesFromToolResults(req.tool_results, { maxImages: maxToolImages, maxBytes: maxImageBytes }));

  // Also attach user-provided image uploads (enables "redline -> drafting" workflows).
  try {
    const userAtt = Array.isArray(req.user_attachments) ? req.user_attachments : [];
    for (const a of userAtt) {
      if (images.length >= maxToolImages + maxUserImages) break;
      const rp = typeof a.relative_path === "string" ? a.relative_path.trim() : "";
      if (!rp) continue;
      const ext = path.extname(rp).toLowerCase();
      if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") continue;

      const full = resolveExistingFileUnderWorkspace(rp);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      // Conservative cap (avoid huge prompt payloads).
      if (st.size > maxImageBytes) continue;

      const mime =
        typeof a.mime === "string" && a.mime.trim()
          ? a.mime.trim()
          : ext === ".png"
            ? "image/png"
            : "image/jpeg";

      const base64 = fs.readFileSync(full).toString("base64");
      images.push(`data:${mime};base64,${base64}`);
    }
  } catch {
    // ignore
  }

  // Attach workbench-generated image artifacts (e.g., redline marked previews/crops) on continuation rounds.
  try {
    const serverCtx = (req.context as any)?.__server;
    const wbPaths = Array.isArray(serverCtx?.workbench_inline_image_paths) ? (serverCtx.workbench_inline_image_paths as unknown[]) : [];
    for (const p of wbPaths) {
      if (images.length >= maxToolImages + maxUserImages + maxWorkbenchImages) break;
      if (typeof p !== "string" || !p.trim()) continue;
      const dataUrl = readWorkspaceImageDataUrl(p, maxImageBytes);
      if (dataUrl) images.push(dataUrl);
    }
  } catch {
    // ignore
  }

  if (images.length === 0) return prompt;

  return [
    {
      role: "developer",
      content: [{ type: "input_text", text: prompt }]
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Attached images are user-provided screenshots or Revit exports. Use them for context and verification." },
        ...images.slice(0, maxToolImages + maxUserImages + maxWorkbenchImages).map(img => ({ type: "input_image", image_url: img, detail: imageDetailFromReq(req) }))
      ]
    }
  ];
}

function extractFirstJsonObject(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function withServerContext(existing: unknown, extra: Record<string, unknown>): unknown {
  const base = existing && typeof existing === "object" ? (existing as any) : {};
  const server = (base.__server && typeof base.__server === "object" ? base.__server : {}) as Record<string, unknown>;
  return { ...base, __server: { ...server, ...extra } };
}

function normalizeWorkbenchActions(raw: unknown): WorkbenchAction[] {
  const arr = Array.isArray(raw) ? raw : [];
  const max = maxWorkbenchActions();
  const out: WorkbenchAction[] = [];

  for (const item of arr.slice(0, max)) {
    if (!item || typeof item !== "object") continue;
    const a: any = item;
    const type = typeof a.type === "string" ? a.type.trim().toLowerCase() : "";

    if (type === "shell") {
      out.push({
        type: "shell",
        command: typeof a.command === "string" ? a.command : "",
        workdir: typeof a.workdir === "string" ? a.workdir : undefined,
        timeout_ms: typeof a.timeout_ms === "number" && Number.isFinite(a.timeout_ms) ? Math.floor(a.timeout_ms) : undefined
      });
      continue;
    }

    if (type === "python") {
      out.push({
        type: "python",
        code: typeof a.code === "string" ? a.code : "",
        workdir: typeof a.workdir === "string" ? a.workdir : undefined,
        timeout_ms: typeof a.timeout_ms === "number" && Number.isFinite(a.timeout_ms) ? Math.floor(a.timeout_ms) : undefined
      });
      continue;
    }

    if (type === "write_file") {
      out.push({
        type: "write_file",
        file_path: typeof a.file_path === "string" ? a.file_path : "",
        content: typeof a.content === "string" ? a.content : ""
      });
      continue;
    }

    if (type === "read_file") {
      out.push({
        type: "read_file",
        file_path: typeof a.file_path === "string" ? a.file_path : "",
        max_bytes: typeof a.max_bytes === "number" && Number.isFinite(a.max_bytes) ? Math.floor(a.max_bytes) : undefined
      });
      continue;
    }

    if (type === "list_files") {
      out.push({
        type: "list_files",
        dir_path: typeof a.dir_path === "string" ? a.dir_path : undefined,
        recursive: typeof a.recursive === "boolean" ? a.recursive : undefined,
        max_items: typeof a.max_items === "number" && Number.isFinite(a.max_items) ? Math.floor(a.max_items) : undefined
      });
      continue;
    }

    if (type === "analyze_redline") {
      out.push({
        type: "analyze_redline",
        file_path: typeof a.file_path === "string" ? a.file_path : "",
        expected_sheet: typeof a.expected_sheet === "string" ? a.expected_sheet : undefined,
        max_pages: typeof a.max_pages === "number" && Number.isFinite(a.max_pages) ? Math.floor(a.max_pages) : undefined,
        page_start: typeof a.page_start === "number" && Number.isFinite(a.page_start) ? Math.floor(a.page_start) : undefined,
        include_pdf_annotations: typeof a.include_pdf_annotations === "boolean" ? a.include_pdf_annotations : undefined,
        include_ocr_for_images: typeof a.include_ocr_for_images === "boolean" ? a.include_ocr_for_images : undefined,
        timeout_ms: typeof a.timeout_ms === "number" && Number.isFinite(a.timeout_ms) ? Math.floor(a.timeout_ms) : undefined,
        baseline_file_path: typeof a.baseline_file_path === "string" ? a.baseline_file_path : undefined
      });
      continue;
    }

    if (type === "map_sheet_regions") {
      out.push({
        type: "map_sheet_regions",
        image_width: typeof a.image_width === "number" && Number.isFinite(a.image_width) ? a.image_width : 0,
        image_height: typeof a.image_height === "number" && Number.isFinite(a.image_height) ? a.image_height : 0,
        boxes: Array.isArray(a.boxes) ? (a.boxes as Array<Record<string, unknown>>) : [],
        sheet_outline: a.sheet_outline && typeof a.sheet_outline === "object" ? (a.sheet_outline as Record<string, unknown>) : {},
        viewport_geometry: Array.isArray(a.viewport_geometry) ? (a.viewport_geometry as Array<Record<string, unknown>>) : [],
        title_blocks: Array.isArray(a.title_blocks) ? (a.title_blocks as Array<Record<string, unknown>>) : []
      });
      continue;
    }

    if (type === "redline_orient") {
      out.push({
        type: "redline_orient",
        file_path: typeof a.file_path === "string" ? a.file_path : "",
        expected_sheet: typeof a.expected_sheet === "string" ? a.expected_sheet : undefined,
        max_pages: typeof a.max_pages === "number" && Number.isFinite(a.max_pages) ? Math.floor(a.max_pages) : undefined,
        page_start: typeof a.page_start === "number" && Number.isFinite(a.page_start) ? Math.floor(a.page_start) : undefined,
        include_pdf_annotations: typeof a.include_pdf_annotations === "boolean" ? a.include_pdf_annotations : undefined,
        include_ocr_for_images: typeof a.include_ocr_for_images === "boolean" ? a.include_ocr_for_images : undefined,
        timeout_ms: typeof a.timeout_ms === "number" && Number.isFinite(a.timeout_ms) ? Math.floor(a.timeout_ms) : undefined,
        baseline_file_path: typeof a.baseline_file_path === "string" ? a.baseline_file_path : undefined,
        image_width: typeof a.image_width === "number" && Number.isFinite(a.image_width) ? a.image_width : undefined,
        image_height: typeof a.image_height === "number" && Number.isFinite(a.image_height) ? a.image_height : undefined,
        boxes: Array.isArray(a.boxes) ? (a.boxes as Array<Record<string, unknown>>) : [],
        sheet_outline: a.sheet_outline && typeof a.sheet_outline === "object" ? (a.sheet_outline as Record<string, unknown>) : undefined,
        viewport_geometry: Array.isArray(a.viewport_geometry) ? (a.viewport_geometry as Array<Record<string, unknown>>) : [],
        title_blocks: Array.isArray(a.title_blocks) ? (a.title_blocks as Array<Record<string, unknown>>) : []
      });
      continue;
    }

    if (type === "gemini_redline_analyze") {
      out.push({
        type: "gemini_redline_analyze",
        file_path: typeof a.file_path === "string" ? a.file_path : "",
        image_paths: Array.isArray(a.image_paths)
          ? (a.image_paths as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined,
        expected_sheet: typeof a.expected_sheet === "string" ? a.expected_sheet : undefined,
        max_pages: typeof a.max_pages === "number" && Number.isFinite(a.max_pages) ? Math.floor(a.max_pages) : undefined,
        page_start: typeof a.page_start === "number" && Number.isFinite(a.page_start) ? Math.floor(a.page_start) : undefined,
        baseline_file_path: typeof a.baseline_file_path === "string" ? a.baseline_file_path : undefined,
        objective: typeof a.objective === "string" ? a.objective : undefined,
        region_boxes: Array.isArray(a.region_boxes) ? (a.region_boxes as Array<Record<string, unknown>>) : [],
        max_regions: typeof a.max_regions === "number" && Number.isFinite(a.max_regions) ? Math.floor(a.max_regions) : undefined,
        min_confidence: typeof a.min_confidence === "number" && Number.isFinite(a.min_confidence) ? a.min_confidence : undefined,
        include_code_execution: typeof a.include_code_execution === "boolean" ? a.include_code_execution : undefined,
        timeout_ms: typeof a.timeout_ms === "number" && Number.isFinite(a.timeout_ms) ? Math.floor(a.timeout_ms) : undefined
      });
    }
  }

  return out;
}

function attachArtifactSharesToWorkbenchResults(results: WorkbenchActionResult[]): WorkbenchActionResult[] {
  for (const r of results) {
    if (!r || r.type !== "write_file" || !r.ok) continue;
    const details = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : null;
    if (!details) continue;
    const rel = typeof details.path === "string" ? details.path.trim() : "";
    if (!rel) continue;
    const relLower = rel.toLowerCase();
    if (!(relLower === "artifacts" || relLower.startsWith("artifacts/"))) continue;

    try {
      const shared = createArtifactShare({ relativePath: rel });
      (details as any).artifact_share = {
        token: shared.token,
        relative_path: shared.relative_path,
        file_name: shared.file_name,
        expires_at_utc: shared.expires_at_utc,
        download_path: `/artifacts/download-shared/${encodeURIComponent(shared.token)}`
      };
      r.details = details;
    } catch {
      // ignore share-creation failures; keep original result
    }
  }
  return results;
}

function collectWorkbenchInlineImagePaths(results: WorkbenchActionResult[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const pushPath = (v: string) => {
    const s = v.trim().replace(/\\/g, "/");
    if (!s) return;
    const ext = path.extname(s).toLowerCase();
    if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const walk = (v: unknown, keyHint = "") => {
    if (v == null) return;
    if (typeof v === "string") {
      const k = keyHint.toLowerCase();
      if (k.includes("image") || k.includes("crop") || k.includes("preview") || k.includes("path")) pushPath(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, keyHint);
      return;
    }
    if (typeof v === "object") {
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) walk(vv, k);
    }
  };

  for (const r of results) {
    if (!r || !r.details || typeof r.details !== "object") continue;
    walk(r.details);
  }
  return out.slice(0, 12);
}

function formatWebEvidenceForPrompt(results: any[]): string {
  const lines: string[] = [];
  let i = 0;
  for (const r of results) {
    i++;
    if (!r || typeof r !== "object") continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url : "";
    const ev = typeof r.evidence_dir === "string" ? r.evidence_dir : "";
    const meta = typeof r.meta_path === "string" ? r.meta_path : "";
    const snippet = typeof r.text_snippet === "string" ? r.text_snippet : "";
    const label = `[W${i}] ${title || url || "source"}`;
    lines.push(label);
    if (url) lines.push(`- url: ${url}`);
    if (ev) lines.push(`- evidence_dir: ${ev}`);
    if (meta) lines.push(`- meta: ${meta}`);
    if (snippet) lines.push(`- text_snippet: ${snippet}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatWebCitationsForUser(results: any[]): string {
  const lines: string[] = [];
  let i = 0;
  for (const r of results) {
    i++;
    if (!r || typeof r !== "object") continue;
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "";
    const url = typeof r.url === "string" ? r.url : "";
    const ev = typeof r.evidence_dir === "string" ? r.evidence_dir : "";
    const label = `${title || url || "source"}`;
    const evLink = ev ? `[Open evidence folder](op://open-folder?path=${encodeURIComponent(ev)})` : "";
    lines.push(`[W${i}] ${label}${url ? ` — ${url}` : ""}${evLink ? ` (${evLink})` : ""}`);
  }
  return lines.length > 0 ? ["", "Sources (saved evidence):", ...lines].join("\n") : "";
}

function normalizeSheetsActionForCompatibility(method: "GET" | "POST", path: string, body: unknown): unknown {
  if (method !== "POST" || path !== "/revit/sheets") return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const src = body as Record<string, unknown>;
  const next: Record<string, unknown> = { ...src };
  let changed = false;

  const action = typeof src.action === "string" ? src.action.trim().toLowerCase() : "";
  const countOnly = src.countOnly === true;
  if (action === "count" || countOnly) {
    // Compatibility shim for older add-ins that only accept action=list|detail.
    delete next.action;
    delete next.countOnly;
    next.all = true;
    if (typeof next.max !== "number" && typeof next.limit !== "number") {
      next.max = 5000;
    }
    changed = true;
  }

  const nextAction = typeof next.action === "string" ? next.action.trim().toLowerCase() : action;
  if (nextAction === "detail") {
    const selector = next.selector && typeof next.selector === "object" && !Array.isArray(next.selector) ? (next.selector as Record<string, unknown>) : null;
    const firstNumber = (...vals: unknown[]): number | null => {
      for (const v of vals) {
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string") {
          const parsed = Number.parseInt(v.trim(), 10);
          if (Number.isFinite(parsed)) return parsed;
        }
        if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "number" && Number.isFinite(item)) return item;
            if (typeof item === "string") {
              const parsed = Number.parseInt(item.trim(), 10);
              if (Number.isFinite(parsed)) return parsed;
            }
          }
        }
      }
      return null;
    };
    const firstText = (...vals: unknown[]): string | null => {
      for (const v of vals) {
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
        if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "string" && item.trim().length > 0) return item.trim();
          }
        }
      }
      return null;
    };
    const maybePromote = (key: "sheetId" | "viewId" | "sheetNumber" | "query", value: unknown) => {
      const missing = next[key] === undefined || next[key] === null || (typeof next[key] === "string" && (next[key] as string).trim().length === 0);
      if (!missing || value === null || value === undefined) return;
      next[key] = value;
      changed = true;
    };

    maybePromote("sheetId", firstNumber(next.sheetId, next.sheetIds, selector?.sheetId, selector?.sheetIds, next.id, next.elementId));
    maybePromote("viewId", firstNumber(next.viewId, next.viewIds, selector?.viewId, selector?.viewIds));
    maybePromote("sheetNumber", firstText(next.sheetNumber, next.sheetNumbers, selector?.sheetNumber, selector?.sheetNumbers));
    maybePromote("query", firstText(next.query, selector?.query));

    if (typeof next.sheetId === "string") {
      const parsed = Number.parseInt(next.sheetId.trim(), 10);
      if (Number.isFinite(parsed)) {
        next.sheetId = parsed;
        changed = true;
      }
    }
    if (typeof next.viewId === "string") {
      const parsed = Number.parseInt(next.viewId.trim(), 10);
      if (Number.isFinite(parsed)) {
        next.viewId = parsed;
        changed = true;
      }
    }

    if ("selector" in next) {
      delete next.selector;
      changed = true;
    }
  }

  return changed ? next : body;
}

function normalizeElectricalCategoryArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const out: unknown[] = [];
  let changed = false;
  let sawElectricalDevices = false;
  let hasElectricalFixtures = false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      out.push(item);
      continue;
    }
    const category = item.trim();
    if (!category) {
      changed = true;
      continue;
    }
    if (category === "OST_ElectricalDevices") {
      sawElectricalDevices = true;
      changed = true;
      continue;
    }
    if (category === "OST_ElectricalFixtures" || category.toLowerCase() === "receptacles") {
      hasElectricalFixtures = true;
    }
    const key = category.toLowerCase();
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    out.push(category);
  }
  if (sawElectricalDevices && !hasElectricalFixtures && !seen.has("ost_electricalfixtures")) {
    out.push("OST_ElectricalFixtures");
    changed = true;
  }
  return changed ? out : value;
}

function normalizeComputerUseGuardBody(body: Record<string, unknown>): boolean {
  let changed = false;
  const match = body.match && typeof body.match === "object" && !Array.isArray(body.match)
    ? (body.match as Record<string, unknown>)
    : null;
  if (match) {
    const promoteText = (from: string, to: string) => {
      if (typeof match[from] === "string" && !(typeof body[to] === "string" && (body[to] as string).trim())) {
        body[to] = match[from];
        changed = true;
      }
    };
    promoteText("dialogIdContains", "dialogIdContains");
    promoteText("dialog_id_contains", "dialogIdContains");
    promoteText("titleContains", "titleContains");
    promoteText("title_contains", "titleContains");
    promoteText("messageContains", "messageContains");
    promoteText("message_contains", "messageContains");
    delete body.match;
    changed = true;
  }
  if (typeof body.timeoutMs === "number" && typeof body.ttlMs !== "number") {
    body.ttlMs = body.timeoutMs;
    delete body.timeoutMs;
    changed = true;
  }
  return changed;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUpdatePanelParameterBody(body: Record<string, unknown>): boolean {
  let changed = false;

  if (!nonEmptyString(body.parameterName)) {
    const parameterAlias = nonEmptyString(body.requestedParameterName) || nonEmptyString(body.parameterSemantic);
    if (parameterAlias) {
      body.parameterName = parameterAlias;
      changed = true;
    }
  }

  if ("value" in body && typeof body.value !== "string") {
    body.value = `${body.value ?? ""}`;
    changed = true;
  }

  const parameterNameForValue = nonEmptyString(body.parameterName).toLowerCase();
  const valueText = nonEmptyString(body.value);
  if (
    parameterNameForValue === "mcb rating" &&
    /^\d+(?:\.\d+)?\s*a$/i.test(valueText)
  ) {
    body.value = valueText.replace(/\s*a$/i, "");
    changed = true;
  }

  const matchExact = nonEmptyString(body.matchExact);
  const panelName = nonEmptyString(body.panelName);
  const panelNamePattern = nonEmptyString(body.panelNamePattern);
  if (matchExact) {
    if (body.scheduleQuery !== matchExact) {
      body.scheduleQuery = matchExact;
      changed = true;
    }
    if (body.exact !== true) {
      body.exact = true;
      changed = true;
    }
  } else if (!nonEmptyString(body.scheduleQuery) && panelName) {
    body.scheduleQuery = panelName;
    body.exact = true;
    changed = true;
  } else if (!nonEmptyString(body.scheduleQuery) && panelNamePattern) {
    body.scheduleQuery = panelNamePattern;
    changed = true;
  }

  if (!nonEmptyString(body.samplePanelName)) {
    const sample = nonEmptyString(body.scheduleQuery) || panelName || panelNamePattern || matchExact;
    if (sample) {
      body.samplePanelName = sample;
      changed = true;
    }
  }

  if (typeof body.confirm === "boolean") {
    delete body.confirm;
    changed = true;
  }
  if (typeof body.apply === "boolean") {
    delete body.apply;
    changed = true;
  }

  return changed;
}

function latestRequiredConfirmForPath(toolResults: ToolResult[], pathName: string): string {
  const normalizedPath = (pathName ?? "").trim().toLowerCase();
  for (let i = toolResults.length - 1; i >= 0; i -= 1) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== normalizedPath) continue;
    const result = r.result_json;
    if (!result || typeof result !== "object") continue;
    const required = nonEmptyString((result as Record<string, unknown>).requiredConfirm);
    if (required) return required;
  }
  return "";
}

function latestResolvedSheetElementId(toolResults: ToolResult[]): number | null {
  for (let i = toolResults.length - 1; i >= 0; i -= 1) {
    const r = toolResults[i];
    if (!r || (r.path ?? "").trim().toLowerCase() !== "/revit/sheets") continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    const result = r.result_json;
    if (!result || typeof result !== "object") continue;
    const row = result as Record<string, unknown>;
    const action = nonEmptyString(row.action).toLowerCase();
    if (action && action !== "detail") continue;
    const id = toFiniteInt(row.sheetElementId) ?? toFiniteInt(row.sheetId) ?? toFiniteInt(row.viewId);
    if (id !== null && id > 0) return id;
  }
  return null;
}

function normalizeSetParameterBody(body: Record<string, unknown>, toolResults: ToolResult[]): boolean {
  if (!Array.isArray(body.changes)) return false;
  let changed = false;
  const latestSheetId = latestResolvedSheetElementId(toolResults);

  body.changes = body.changes.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const row = { ...(entry as Record<string, unknown>) };
    const parsedElementId = toFiniteInt(row.elementId ?? row.element_id ?? row.id);
    if (parsedElementId !== null && parsedElementId > 0) {
      if (row.elementId !== parsedElementId) {
        row.elementId = parsedElementId;
        delete row.element_id;
        changed = true;
      }
      return row;
    }

    const parameterName = nonEmptyString(row.parameterName || row.parameter_name).toLowerCase();
    const isSheetNameWrite = parameterName === "sheet name" || parameterName === "name";
    if (isSheetNameWrite && latestSheetId !== null && latestSheetId > 0) {
      row.elementId = latestSheetId;
      delete row.element_id;
      changed = true;
    }
    return row;
  });

  return changed;
}

function normalizeUpdateParameterByQueryBody(body: Record<string, unknown>, toolResults: ToolResult[]): boolean {
  let changed = false;

  if ("value" in body && typeof body.value !== "string") {
    body.value = `${body.value ?? ""}`;
    changed = true;
  }

  const query = body.query && typeof body.query === "object" && !Array.isArray(body.query)
    ? (body.query as Record<string, unknown>)
    : null;
  if (query) {
    const elementType = (nonEmptyString(query.elementType) || nonEmptyString(query.element_type) || nonEmptyString(query.category)).toLowerCase();
    if (
      (elementType === "sheets" || elementType === "sheet" || elementType === "viewsheet" || elementType === "view sheets") &&
      !nonEmptyString(body.category) &&
      !Array.isArray(body.categories)
    ) {
      body.category = "OST_Sheets";
      changed = true;
    }
    delete body.query;
    changed = true;
  }

  const categoryText = nonEmptyString(body.category).toLowerCase();
  if (categoryText === "sheets" || categoryText === "sheet" || categoryText === "viewsheet" || categoryText === "view sheets") {
    body.category = "OST_Sheets";
    changed = true;
  }

  if (typeof body.confirm === "boolean") {
    delete body.confirm;
    changed = true;
  }

  if (!nonEmptyString(body.confirm) && body.dryRun === false) {
    const requiredConfirm = latestRequiredConfirmForPath(toolResults, "/revit/update-parameter-by-query");
    if (requiredConfirm) {
      body.confirm = requiredConfirm;
      changed = true;
    }
  }

  return changed;
}

function objectTreeHasLinkedPlacementBasis(node: unknown, depth = 0): boolean {
  if (depth > 8 || node === null || node === undefined) return false;
  if (typeof node === "string") {
    const text = node.trim().toLowerCase();
    return text.includes("linked_") || text === "ost_rvtlinks" || text === "rvt links";
  }
  if (Array.isArray(node)) {
    return node.some((item) => objectTreeHasLinkedPlacementBasis(item, depth + 1));
  }
  if (typeof node !== "object") return false;
  const row = node as Record<string, unknown>;
  const basis = typeof row.basis === "string" ? row.basis.trim().toLowerCase() : "";
  if (basis.includes("linked")) return true;
  const builtInCategory = typeof row.builtInCategory === "string" ? row.builtInCategory.trim().toLowerCase() : "";
  if (builtInCategory === "ost_rvtlinks") return true;
  const category = typeof row.category === "string" ? row.category.trim().toLowerCase() : "";
  if (category === "rvt links") return true;
  return Object.values(row).some((value) => objectTreeHasLinkedPlacementBasis(value, depth + 1));
}

function latestPlacementPreviewUsesLinkedHost(toolResults: ToolResult[], pathName: string): boolean {
  const normalizedPath = (pathName ?? "").trim().toLowerCase();
  if (!isHostedPlacementActionPath(normalizedPath)) return false;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (!r) continue;
    if ((r.path ?? "").trim().toLowerCase() !== normalizedPath) continue;
    if ((r.status ?? "").trim().toLowerCase() !== "done") continue;
    if (!resultLooksDryRun(r)) continue;
    if (objectTreeHasLinkedPlacementBasis(r.result_json)) return true;
    return false;
  }
  return false;
}

function deriveWallLocalRedlineChainageTarget(
  body: Record<string, unknown>,
  req: ChatRequest | null | undefined,
  toolResults: ToolResult[]
): Record<string, unknown> | null {
  if (!req) return null;
  const userText = getRecentUserTextForRedline(req);
  if (!isWhereIndicatedRedlinePlacementText(userText)) return null;
  const imageMarkHint = getPersistedImageMarkHint(req.session_id);
  if (!imageMarkHint || toFiniteNumber(imageMarkHint.wall_local_normalized_chainage) === null) return null;

  const bodyRoomSide = getBodyRoomSide(body);
  if (!bodyRoomSide) return null;

  const resolvedContext = choosePlacementContextForFrameAlignedTarget(body, toolResults);
  const rankedContext = buildRankedPlacementContext({
    ranked: extractLatestRankedSimilarDeviceSummary(toolResults),
    roomNumber: getBodyRoomNumber(body),
    roomSide: bodyRoomSide
  });
  const latestContext = extractLatestPlacementContextSummary(toolResults);
  const placementContext =
    resolvedContext ??
    rankedContext ??
    (latestContext
      ? {
          ...latestContext,
          requested_room_side: latestContext.requested_room_side ?? bodyRoomSide
        }
      : null);
  if (!placementContext) return null;

  const chainage = imageMarkHintToNormalizedChainage(imageMarkHint, placementContext);
  if (!chainage) return null;
  return {
    ...(chainage.chainage_ft !== null ? { targetChainageFt: chainage.chainage_ft } : {}),
    targetNormalizedChainage: chainage.normalized_chainage,
    targetSource: "redline_wall_local_chainage"
  };
}

function replaceHostedPointTargetsWithWallLocalRedlineChainage(
  body: Record<string, unknown>,
  req: ChatRequest | null | undefined,
  toolResults: ToolResult[]
): boolean {
  const target = deriveWallLocalRedlineChainageTarget(body, req, toolResults);
  if (!target) return false;

  let changed = false;
  if (Array.isArray(body.placements)) {
    body.placements = body.placements.map((placement) => {
      if (!placement || typeof placement !== "object" || Array.isArray(placement)) return placement;
      const row = { ...(placement as Record<string, unknown>) };
      delete row.pointXyz;
      delete row.point_xyz;
      delete row.alongHostOffsetFt;
      delete row.along_host_offset_ft;
      changed = true;
      return { ...row, ...target };
    });
  } else if (Array.isArray(body.pointXyz)) {
    delete body.pointXyz;
    delete body.point_xyz;
    delete body.alongHostOffsetFt;
    delete body.along_host_offset_ft;
    Object.assign(body, target);
    changed = true;
  }

  if (changed) {
    body.targetSource = "redline_wall_local_chainage";
  }
  return changed;
}

function replaceAuditTargetWithWallLocalRedlineChainage(
  body: Record<string, unknown>,
  req: ChatRequest | null | undefined,
  toolResults: ToolResult[]
): boolean {
  const target = deriveWallLocalRedlineChainageTarget(body, req, toolResults);
  if (!target) return false;
  delete body.targetPointXyz;
  delete body.target_point_xyz;
  Object.assign(body, target);
  return true;
}

function normalizeNativeRevitActionBodiesForRouting(actions: ActionCall[], toolResults: ToolResult[], req?: ChatRequest): ActionCall[] {
  return actions.map((action) => {
    if (action.method !== "POST" || !action.body || typeof action.body !== "object" || Array.isArray(action.body)) return action;
    const pathName = (action.path ?? "").trim().toLowerCase();
    const body = cloneJsonObject(action.body);
    if (!body) return action;
    let changed = false;

    if (pathName === "/revit/computer-use-guard") {
      changed = normalizeComputerUseGuardBody(body) || changed;
    }

    if (pathName === "/revit/update-panel-parameter") {
      changed = normalizeUpdatePanelParameterBody(body) || changed;
    }

    if (pathName === "/revit/update-parameter-by-query") {
      changed = normalizeUpdateParameterByQueryBody(body, toolResults) || changed;
    }

    if (pathName === "/revit/set-parameter") {
      changed = normalizeSetParameterBody(body, toolResults) || changed;
    }

    if ((pathName === "/revit/tool-search" || pathName === "/revit/native-api-search") && !("max" in body)) {
      const maxAlias = toFiniteInt(body.maxResults) ?? toFiniteInt(body.limit);
      if (maxAlias !== null && maxAlias > 0) {
        body.max = maxAlias;
        changed = true;
      }
    }

    if (pathName === "/revit/tool-doc" || pathName === "/revit/tool-examples") {
      if (typeof body.path !== "string" || !body.path.trim()) {
        const toolPath = typeof body.tool === "string" ? body.tool.trim() : "";
        if (toolPath.startsWith("/revit/")) {
          body.path = toolPath;
          changed = true;
        }
      }
      if (typeof body.method !== "string" || !body.method.trim()) {
        body.method = "POST";
        changed = true;
      }
    }

    const categories = normalizeElectricalCategoryArray(body.categories);
    if (categories !== body.categories) {
      body.categories = categories;
      changed = true;
    }
    const includeCategories = normalizeElectricalCategoryArray(body.includeCategories);
    if (includeCategories !== body.includeCategories) {
      body.includeCategories = includeCategories;
      changed = true;
    }

    if (isHostedPlacementActionPath(pathName) && req) {
      const target = deriveFrameAlignedHostTarget(body, req, toolResults);
      if (target && applyFrameAlignedHostTarget(body, target)) {
        changed = true;
      }
    }

    if (
      pathName === "/revit/audit-hosted-instance-placement" &&
      req
    ) {
      if (replaceAuditTargetWithWallLocalRedlineChainage(body, req, toolResults)) {
        changed = true;
      }
      const target = deriveFrameAlignedHostTarget(body, req, toolResults);
      if (target) {
        body.targetPointXyz = target.point_xyz;
        if (target.target_chainage_ft !== null) body.targetChainageFt = target.target_chainage_ft;
        if (target.target_normalized_chainage !== null) body.targetNormalizedChainage = target.target_normalized_chainage;
        body.targetSource = target.source;
        changed = true;
      }
    }

    if (
      isHostedPlacementActionPath(pathName) &&
      replaceHostedPointTargetsWithWallLocalRedlineChainage(body, req, toolResults)
    ) {
      changed = true;
    }

    if (
      isHostedPlacementActionPath(pathName) &&
      body.dryRun === false &&
      bodyUsesExplicitPointPlacement(body) &&
      latestPlacementPreviewUsesLinkedHost(toolResults, pathName)
    ) {
      if ("orientationSourceElementId" in body) {
        delete body.orientationSourceElementId;
        changed = true;
      }
      if (body.matchOrientationFromSource !== false) {
        body.matchOrientationFromSource = false;
        changed = true;
      }
      if ("includePreviewImage" in body && body.includePreviewImage !== false) {
        body.includePreviewImage = false;
        changed = true;
      }
    }

    return changed ? { ...action, body } : action;
  });
}

export function __testOnlyNormalizeNativeRevitActionBodiesForRouting(
  actions: ActionCall[],
  toolResults: ToolResult[],
  req?: Partial<ChatRequest>
): ActionCall[] {
  return normalizeNativeRevitActionBodiesForRouting(
    actions,
    toolResults,
    req
      ? ({
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          session_id: req.session_id ?? randomUUID(),
          message_id: req.message_id ?? `${req.session_id ?? "test"}:message`,
          user_text: req.user_text ?? "",
          ...(req.context ? { context: req.context } : {})
        } satisfies ChatRequest)
      : undefined
  );
}

export async function decideOpenAi(req: ChatRequest): Promise<ChatResponse> {
  return decideOpenAiInternal(req);
}

export async function decideOpenAiStreaming(req: ChatRequest, cb: StreamCallbacks): Promise<ChatResponse> {
  return decideOpenAiInternal(req, cb.abortSignal);
}

function naturalizeActionMessage(response: ChatResponse): ChatResponse {
  if (!Array.isArray(response.actions) || response.actions.length === 0) return response;
  const current = typeof response.assistant_message === "string" ? response.assistant_message.trim() : "";
  if (!/^Plan:\s*/i.test(current)) return response;

  const paths = response.actions.map((action) => String(action?.path ?? "").toLowerCase());
  let assistant_message = "Sure — I’ll work through that and verify the result.";
  if (paths.some((p) => p.includes("export-view") || p.includes("capture") || p.includes("visible-elements"))) {
    assistant_message = "Sure — I’ll use the active Revit view and model coordinates, then verify from a capture.";
  } else if (paths.some((p) => p.includes("room") || p.includes("rank-similar") || p.includes("create-similar") || p.includes("placement"))) {
    assistant_message = "Sure — I’ll use the room/device geometry, make a bounded placement attempt, and verify it.";
  } else if (paths.some((p) => p.includes("sheets") || p.includes("views"))) {
    assistant_message = "Sure — I’ll resolve the active sheet/view and keep going.";
  }

  return {
    ...response,
    assistant_message
  };
}

function shouldSuppressRoutineRedlineProgressMessage(req: ChatRequest, response: ChatResponse): boolean {
  if (!isRedlineFocusedTurn(req)) return false;
  if (!Array.isArray(req.tool_results) || req.tool_results.length === 0) return false;
  if (!Array.isArray(response.actions) || response.actions.length === 0) return false;
  const message = (response.assistant_message ?? "").trim();
  if (!message) return false;
  if (/^answer\s*:/i.test(message)) return false;
  if (/\b(blocked|failed|failure|error|warning|approval|required|destructive|ambiguous|stopped|paused)\b/i.test(message)) return false;
  if (/\b(dialog|modal|interrupted|retry|recover|correct|mismatch|invalid|unsupported|off-room|off-wall|unresolved)\b/i.test(message)) return false;
  return true;
}

export function __testOnlyFinalizeOpenAiResponseForRequest(req: ChatRequest, response: ChatResponse): ChatResponse {
  if (Array.isArray(response.actions) && response.actions.length > 0) {
    response = {
      ...response,
      actions: normalizeNativeRevitActionBodiesForRouting(response.actions, getAugmentedToolResults(req, 80), req)
    };
  }
  response = naturalizeActionMessage(response);
  if (shouldSuppressRoutineRedlineProgressMessage(req, response)) {
    return { ...response, assistant_message: "" };
  }
  return response;
}

async function decideOpenAiInternal(req: ChatRequest, abortSignal?: AbortSignal): Promise<ChatResponse> {
  const finishResponse = (response: ChatResponse): ChatResponse => {
    response = __testOnlyFinalizeOpenAiResponseForRequest(req, response);
    if (Array.isArray(response.actions) && response.actions.some((action) => typeof action?.path === "string" && action.path.startsWith("/revit/"))) {
      const state = getRedlineFastPathState(req.session_id);
      if (!state.phases.first_revit_action_emitted) {
        noteRedlineFastPathPhase(req.session_id, "first_revit_action_emitted", {
          action_paths: response.actions.map((action) => action.path)
        });
      }
    }
    return response;
  };

  if (isRedlineFocusedTurn(req)) {
    noteRedlineFastPathPhase(req.session_id, "request_accepted");
    if (
      Array.isArray(req.tool_results) &&
      req.tool_results.some((result) => typeof result?.path === "string" && result.path.startsWith("/revit/"))
    ) {
      const state = getRedlineFastPathState(req.session_id);
      if (state.phases.first_revit_action_emitted && !state.phases.first_revit_action_completed) {
        noteRedlineFastPathPhase(req.session_id, "first_revit_action_completed");
      }
    }
  }

  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    return finishResponse({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Operator backend is not configured with an OpenAI API key. Set OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) in operator-backend/.env.local and restart the backend.",
      actions: []
    });
  }

  const client = createOpenAiClient(apiKey);
  const defaultModel = process.env.OPERATOR_OPENAI_MODEL || "gpt-5.6-sol";
  const defaultReasoningEffort = getRequestedReasoningEffort(req, normalizeReasoningEffort(process.env.OPERATOR_OPENAI_REASONING_EFFORT || "medium", "medium"));
  const textVerbosity = normalizeTextVerbosity(process.env.OPERATOR_OPENAI_TEXT_VERBOSITY || "low", "low");
  const serviceTier = getRequestedServiceTier();
  const maxOutputTokensRaw = (process.env.OPERATOR_OPENAI_MAX_OUTPUT_TOKENS || "").trim();
  const maxOutputTokens = maxOutputTokensRaw ? Number.parseInt(maxOutputTokensRaw, 10) : NaN;
  const uvRectSchema = {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["minU", "minV", "maxU", "maxV"],
    properties: {
      minU: { type: ["number", "null"] },
      minV: { type: ["number", "null"] },
      maxU: { type: ["number", "null"] },
      maxV: { type: ["number", "null"] }
    }
  };
  const regionBoxSchema = {
    type: "object",
    additionalProperties: false,
    required: ["index", "x", "y", "w", "h", "label", "target_hint"],
    properties: {
      index: { type: ["number", "null"] },
      x: { type: ["number", "null"] },
      y: { type: ["number", "null"] },
      w: { type: ["number", "null"] },
      h: { type: ["number", "null"] },
      label: { type: ["string", "null"] },
      target_hint: { type: ["string", "null"] }
    }
  };
  const viewportGeometrySchema = {
    type: "object",
    additionalProperties: false,
    required: ["viewportId", "viewId", "rotation", "box"],
    properties: {
      viewportId: { type: ["number", "null"] },
      viewId: { type: ["number", "null"] },
      rotation: { type: ["string", "null"] },
      box: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["minU", "minV", "maxU", "maxV"],
        properties: {
          minU: { type: ["number", "null"] },
          minV: { type: ["number", "null"] },
          maxU: { type: ["number", "null"] },
          maxV: { type: ["number", "null"] }
        }
      }
    }
  };
  const titleBlockGeometrySchema = {
    type: "object",
    additionalProperties: false,
    required: ["elementId", "boundingBox"],
    properties: {
      elementId: { type: ["number", "null"] },
      boundingBox: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["minU", "minV", "maxU", "maxV"],
        properties: {
          minU: { type: ["number", "null"] },
          minV: { type: ["number", "null"] },
          maxU: { type: ["number", "null"] },
          maxV: { type: ["number", "null"] }
        }
      }
    }
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    // OpenAI strict schema requires all declared properties to be required.
    required: ["assistant_message", "actions", "web_requests", "dev_actions", "workbench_actions"],
    properties: {
      assistant_message: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action_id", "method", "path", "body_json"],
          properties: {
            action_id: { type: "string" },
            method: { type: "string", enum: ["GET", "POST"] },
            path: { type: "string", minLength: 1, maxLength: 200 },
            body_json: { type: ["string", "null"] }
          }
        }
      },
      web_requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["request_id", "url", "purpose"],
          properties: {
            request_id: { type: "string" },
            url: { type: "string", minLength: 1, maxLength: 2000 },
            purpose: { type: ["string", "null"] }
          }
        }
      },
      dev_actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          // OpenAI strict schema requires all declared properties to be present.
          required: ["type", "patch", "workdir", "command", "timeout_ms", "file_path", "content"],
          properties: {
            type: { type: "string", enum: ["apply_patch", "shell", "write_file", "restart_backend"] },
            patch: { type: ["string", "null"] },
            workdir: { type: ["string", "null"] },
            command: { type: ["string", "null"] },
            timeout_ms: { type: ["number", "null"] },
            file_path: { type: ["string", "null"] },
            content: { type: ["string", "null"] }
          }
        }
      },
      workbench_actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "command",
            "code",
            "workdir",
            "timeout_ms",
            "file_path",
            "content",
            "dir_path",
            "recursive",
            "max_items",
            "max_bytes",
            "expected_sheet",
            "max_pages",
            "page_start",
            "include_pdf_annotations",
            "include_ocr_for_images",
            "baseline_file_path",
            "image_width",
            "image_height",
            "boxes",
            "sheet_outline",
            "viewport_geometry",
            "title_blocks",
            "image_paths",
            "objective",
            "region_boxes",
            "max_regions",
            "min_confidence",
            "include_code_execution"
          ],
          properties: {
            type: {
              type: "string",
              enum: ["shell", "python", "write_file", "read_file", "list_files", "analyze_redline", "map_sheet_regions", "redline_orient", "gemini_redline_analyze"]
            },
            command: { type: ["string", "null"] },
            code: { type: ["string", "null"] },
            workdir: { type: ["string", "null"] },
            timeout_ms: { type: ["number", "null"] },
            file_path: { type: ["string", "null"] },
            content: { type: ["string", "null"] },
            dir_path: { type: ["string", "null"] },
            recursive: { type: ["boolean", "null"] },
            max_items: { type: ["number", "null"] },
            max_bytes: { type: ["number", "null"] },
            expected_sheet: { type: ["string", "null"] },
            max_pages: { type: ["number", "null"] },
            page_start: { type: ["number", "null"] },
            include_pdf_annotations: { type: ["boolean", "null"] },
            include_ocr_for_images: { type: ["boolean", "null"] },
            baseline_file_path: { type: ["string", "null"] },
            image_width: { type: ["number", "null"] },
            image_height: { type: ["number", "null"] },
            boxes: { type: ["array", "null"], items: regionBoxSchema },
            sheet_outline: uvRectSchema,
            viewport_geometry: { type: ["array", "null"], items: viewportGeometrySchema },
            title_blocks: { type: ["array", "null"], items: titleBlockGeometrySchema },
            image_paths: { type: ["array", "null"], items: { type: "string" } },
            objective: { type: ["string", "null"] },
            region_boxes: { type: ["array", "null"], items: regionBoxSchema },
            max_regions: { type: ["number", "null"] },
            min_confidence: { type: ["number", "null"] },
            include_code_execution: { type: ["boolean", "null"] }
          }
        }
      }
    }
  };

  async function callModel(r: ChatRequest): Promise<OpenAiDecision | { error: string }> {
    const speedSettings = resolveSpeedSettings(r.context);
    const route = selectSpeedRoute(r, speedSettings, { model: defaultModel, reasoning_effort: defaultReasoningEffort });
    const promptStartedMs = Date.now();
    const input = await buildInput(r, { route: route.route, reason: route.reason });
    const promptBuildMs = Date.now() - promptStartedMs;
    const inputChars = approxPayloadChars(input);
    try {
      appendEvent(r.session_id, "assistant", "speed.route", {
        route: route.route,
        reason: route.reason,
        model: route.model,
        reasoning_effort: route.reasoning_effort,
        speed_mode: speedSettings.speed_mode,
        context_diet: speedSettings.context_diet,
        prompt_build_ms: promptBuildMs,
        input_chars: inputChars
      });
      if (speedSettings.speed_mode) {
        appendNotification(
          r.session_id,
          "speed.route",
          `Speed route=${route.route}, model=${route.model}, effort=${route.reasoning_effort}, prompt=${inputChars} chars, build=${promptBuildMs}ms`,
          {
            route: route.route,
            reason: route.reason,
            model: route.model,
            reasoning_effort: route.reasoning_effort,
            prompt_build_ms: promptBuildMs,
            input_chars: inputChars
          }
        );
      }
    } catch {
      // ignore speed telemetry errors
    }
    const requestBody: any = {
      model: route.model,
      reasoning: {
        effort: route.reasoning_effort
      },
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}),
      input,
      text: {
        verbosity: textVerbosity,
        format: {
          type: "json_schema",
          name: "operator_chat_response",
          strict: true,
          schema
        }
      }
    };
    let response: any;
    const requestStartedMs = Date.now();
    try {
      if (abortSignal) {
        const stream = client.responses.stream(requestBody, { signal: abortSignal });
        response = await stream.finalResponse();
      } else {
        response = await client.responses.create(requestBody, abortSignal ? { signal: abortSignal } : undefined);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown OpenAI error";
      return { error: `Operator backend error while calling the model: ${message}` };
    }
    const modelLatencyMs = Date.now() - requestStartedMs;

    const rawOutputText = extractResponsesApiOutputText(response);

    let decision: OpenAiDecision | null = null;
    try {
      decision = (rawOutputText ? JSON.parse(rawOutputText) : null) as OpenAiDecision | null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid JSON from model";
      const raw = rawOutputText;

      const extracted = extractFirstJsonObject(raw);
      if (extracted) {
        try {
          decision = JSON.parse(extracted) as OpenAiDecision;
        } catch (err2) {
          const message2 = err2 instanceof Error ? err2.message : "Invalid JSON from model";
          const snippet = raw.length > 1200 ? raw.slice(0, 1200) + "\n…(truncated)" : raw;
          return {
            error:
              "Operator backend error: model returned invalid JSON for the required response format.\n" +
              `Parse error: ${message}\n` +
              `Extracted object parse error: ${message2}\n\n` +
              (snippet ? `Model output (truncated):\n${snippet}` : "(No model output.)")
          };
        }
      } else {
        const snippet = raw.length > 1200 ? raw.slice(0, 1200) + "\n…(truncated)" : raw;
        return {
          error:
            "Operator backend error: model returned invalid JSON for the required response format.\n" +
            `Parse error: ${message}\n\n` +
            (snippet ? `Model output (truncated):\n${snippet}` : "(No model output.)")
        };
      }
    }

    if (!decision) {
      const status = typeof response?.status === "string" ? response.status : "unknown";
      return { error: `No response from model. Responses API status=${status}.` };
    }

    try {
      const usage: any = (response as any)?.usage;
      const inputTokens = Number.isFinite(usage?.input_tokens) ? Number(usage.input_tokens) : null;
      const outputTokens = Number.isFinite(usage?.output_tokens) ? Number(usage.output_tokens) : null;
      const totalTokens = Number.isFinite(usage?.total_tokens) ? Number(usage.total_tokens) : null;
      if (openAiUsageNotificationsEnabled()) {
        appendNotification(req.session_id, "openai.usage", `OpenAI usage: model=${route.model}${inputTokens !== null ? `, in=${inputTokens}` : ""}${outputTokens !== null ? `, out=${outputTokens}` : ""}${totalTokens !== null ? `, total=${totalTokens}` : ""}`, {
          model: route.model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens
        });
        appendEvent(req.session_id, "assistant", "openai.usage", {
          model: route.model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens
        });
      }
      appendEvent(req.session_id, "assistant", "speed.timing", {
        route: route.route,
        reason: route.reason,
        model: route.model,
        reasoning_effort: route.reasoning_effort,
        prompt_build_ms: promptBuildMs,
        model_latency_ms: modelLatencyMs,
        input_chars: inputChars,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens
      });
    } catch {
      // ignore usage telemetry errors
    }
    return decision;
  }

  const policy = getWebResearchPolicyFromEnv();
  const maxContinuationRounds = Math.max(0, Math.min(4, Number.parseInt(process.env.OPERATOR_OPENAI_CONTINUATION_ROUNDS ?? "2", 10) || 2));
  const loopPressure = updateLoopPressure(req);
  let webEvidence: any[] = [];
  let workbenchResults: WorkbenchActionResult[] = [];
  let currentReq: ChatRequest = withPlacementWorkItem(
    loopPressure && loopPressure.hint
      ? { ...req, context: withServerContext(req.context, { loop_pressure: loopPressure }) }
      : req
  );
  let lastDecision: OpenAiDecision | null = null;

  async function runWorkbenchRound(
    wbActions: WorkbenchAction[],
    opts: {
      initialPreflight?: boolean;
      autoBootstrap?: boolean;
      autoOrient?: boolean;
      suppressedAnalyze?: number;
      suppressedGemini?: number;
      suppressedList?: number;
    } = {}
  ): Promise<WorkbenchActionResult[]> {
    if (wbActions.length === 0) return [];

    if (opts.initialPreflight) {
      try {
        appendNotification(req.session_id, "workbench.progress", "Initial redline preflight: analyzing the attachment before the first targeting pass.", {
          type: "analyze_redline"
        });
      } catch {
        // ignore
      }
    } else if (opts.autoBootstrap) {
      try {
        appendNotification(req.session_id, "workbench.progress", "Auto redline bootstrap: running analyze_redline before additional discovery.", {
          type: "analyze_redline"
        });
      } catch {
        // ignore
      }
    }
    if ((opts.suppressedAnalyze ?? 0) > 0) {
      try {
        appendNotification(req.session_id, "workbench.progress", `Skipped ${opts.suppressedAnalyze} repeated analyze_redline request(s) for already-analyzed file(s).`, {
          skipped: opts.suppressedAnalyze
        });
      } catch {
        // ignore
      }
    }
    if ((opts.suppressedGemini ?? 0) > 0) {
      try {
        appendNotification(
          req.session_id,
          "workbench.progress",
          `Skipped ${opts.suppressedGemini} repeated gemini_redline_analyze request(s) with no new evidence.`,
          { skipped: opts.suppressedGemini }
        );
      } catch {
        // ignore
      }
    }
    if ((opts.suppressedList ?? 0) > 0) {
      try {
        appendNotification(
          req.session_id,
          "workbench.progress",
          `Skipped ${opts.suppressedList} broad recursive list_files request(s); using redline session anchors instead.`,
          { skipped: opts.suppressedList }
        );
      } catch {
        // ignore
      }
    }
    if (opts.autoOrient) {
      try {
        appendNotification(req.session_id, "workbench.progress", "Auto redline orient: mapping marks to sheet geometry before write targeting.", {
          type: "redline_orient"
        });
      } catch {
        // ignore
      }
    }
    try {
      appendNotification(req.session_id, "workbench.progress", `Running ${wbActions.length} backend workbench step(s)…`, {
        count: wbActions.length
      });
    } catch {
      // ignore
    }

    for (const wa of wbActions) {
      try {
        persistence.appendToolCall(req.session_id, {
          ts: new Date().toISOString(),
          kind: "mcp.tool_call",
          session_id: req.session_id,
          tool: `workbench.${wa.type}`,
          server: "operator-backend",
          arguments: wa,
          status: "requested"
        });
      } catch {
        // ignore
      }
    }

    let wb = attachArtifactSharesToWorkbenchResults(await executeWorkbenchActions(wbActions));
    const autoGemini = maybeBuildAutoGeminiAction(req.session_id, wbActions, wb);
    if (autoGemini) {
      try {
        appendNotification(req.session_id, "workbench.progress", "Auto redline vision: running gemini_redline_analyze to avoid preflight churn.", {
          type: "gemini_redline_analyze"
        });
      } catch {
        // ignore
      }

      try {
        persistence.appendToolCall(req.session_id, {
          ts: new Date().toISOString(),
          kind: "mcp.tool_call",
          session_id: req.session_id,
          tool: "workbench.gemini_redline_analyze",
          server: "operator-backend",
          arguments: autoGemini,
          status: "requested"
        });
      } catch {
        // ignore
      }

      const auto = attachArtifactSharesToWorkbenchResults(await executeWorkbenchActions([autoGemini])).map((r, idx) => ({
        ...r,
        index: wb.length + idx + 1
      }));
      wb = wb.concat(auto);
    }

    updateRedlineVisionProgressFromWorkbench(req.session_id, wb);

    for (const wr of wb) {
      try {
        persistence.appendToolOutput(req.session_id, {
          ts: new Date().toISOString(),
          kind: "mcp.tool_result",
          session_id: req.session_id,
          tool: `workbench.${wr.type}`,
          server: "operator-backend",
          status: wr.ok ? "success" : "failed",
          result: { index: wr.index, summary: wr.summary, details: wr.details ?? null },
          error: wr.ok ? null : wr.summary
        });
      } catch {
        // ignore
      }
    }

    try {
      const okCount = wb.filter(x => x.ok).length;
      appendNotification(req.session_id, "workbench.saved", `Workbench completed ${okCount}/${wb.length} step(s).`, {
        ok: okCount,
        total: wb.length
      });
    } catch {
      // ignore
    }

    return wb;
  }

  const fastPreflight = await maybeBuildFastElectricalRedlinePreflight(currentReq);
  if (fastPreflight) {
    if (fastPreflight.tool_results.length > 0 || fastPreflight.preflight_package_text || fastPreflight.diagnostics_text) {
      currentReq = withPlacementWorkItem({
        ...currentReq,
        ...(fastPreflight.tool_results.length > 0
          ? {
              tool_results: mergeToolResultLists(
                Array.isArray(currentReq.tool_results) ? currentReq.tool_results : [],
                fastPreflight.tool_results
              )
            }
          : {}),
        context: withServerContext(currentReq.context, {
          ...(fastPreflight.preflight_package_text ? { redline_preflight_package: fastPreflight.preflight_package_text } : {}),
          ...(fastPreflight.diagnostics_text ? { redline_diagnostics: fastPreflight.diagnostics_text } : {})
        })
      });
    }
    const fastBridge = await maybeBuildRedlineExecutionBridge(currentReq, []);
    if (fastBridge) return finishResponse(fastBridge);
    if (fastPreflight.direct_response) return finishResponse(fastPreflight.direct_response);
  }

  const initialPreflightAction = maybeBuildInitialRedlinePreflightAction(currentReq);
  if (initialPreflightAction) {
    const preflightActions = hydrateRedlineWorkbenchActions(currentReq, [initialPreflightAction], getAugmentedToolResults(currentReq, 80));
    const preflightResults = await runWorkbenchRound(preflightActions, { initialPreflight: true });
    if (preflightResults.length > 0) {
      workbenchResults = preflightResults;
      const serverExtra: Record<string, unknown> = {
        workbench_results: formatWorkbenchResultsForPrompt(preflightResults)
      };
      if (fastPreflight?.preflight_package_text) serverExtra.redline_preflight_package = fastPreflight.preflight_package_text;
      if (fastPreflight?.diagnostics_text) serverExtra.redline_diagnostics = fastPreflight.diagnostics_text;
      const wbImages = collectWorkbenchInlineImagePaths(preflightResults);
      if (wbImages.length > 0) serverExtra.workbench_inline_image_paths = wbImages;
      currentReq = withPlacementWorkItem({ ...currentReq, context: withServerContext(currentReq.context, serverExtra) });
    }
  }

  const preModelToolResults = getAugmentedToolResults(currentReq, 80);
  if (
    preModelToolResults.length > 0 &&
    (!!getRedlineSessionSeed(currentReq.session_id) || hasRedlineAttachment(currentReq))
  ) {
    const preModelBridge = await maybeBuildRedlineExecutionBridge(currentReq, workbenchResults);
    if (preModelBridge && preModelBridge.actions.length > 0) return finishResponse(preModelBridge);
  }

  for (let round = 0; round <= maxContinuationRounds; round++) {
    if (round === 0) noteRedlineFastPathPhase(req.session_id, "planner_start");
    const d = await callModel(currentReq);
    if ("error" in d) {
      noteRedlineFastPathPhase(req.session_id, "blocked", { blocked_reason: "planner_loop_guard" });
      return finishResponse({ version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: d.error, actions: [] });
    }
    if (round === 0) noteRedlineFastPathPhase(req.session_id, "planner_end");

    lastDecision = d;

    let wbActions = normalizeWorkbenchActions(d.workbench_actions);
    const recentToolResults = getAugmentedToolResults(currentReq, 80);
    const autoBootstrap = maybeBuildAutoBootstrapAnalyzeAction(currentReq, d, round, wbActions);
    if (autoBootstrap) wbActions = [autoBootstrap];
    wbActions = hydrateRedlineWorkbenchActions(currentReq, wbActions, recentToolResults);
    const suppression = suppressRepeatedAnalyzeActions(req.session_id, wbActions);
    wbActions = suppression.actions;
    const geminiSuppression = suppressRepeatedGeminiActions(req.session_id, wbActions);
    wbActions = geminiSuppression.actions;
    const listSuppression = suppressBroadListFilesForRedline(currentReq, wbActions);
    wbActions = listSuppression.actions;
    if (wbActions.length === 0) {
      const autoOrient = maybeBuildAutoRedlineOrientAction(currentReq, wbActions, recentToolResults);
      if (autoOrient) wbActions = [autoOrient];
    }
    const webRequests = Array.isArray(d.web_requests) ? d.web_requests : [];
    if (wbActions.length === 0 && webRequests.length === 0) break;

    if (wbActions.length > 0) {
      workbenchResults = await runWorkbenchRound(wbActions, {
        autoBootstrap: !!autoBootstrap,
        autoOrient: wbActions.some(a => a.type === "redline_orient"),
        suppressedAnalyze: suppression.suppressed_count,
        suppressedGemini: geminiSuppression.suppressed_count,
        suppressedList: listSuppression.suppressed_count
      });
    }

    if (webRequests.length > 0) {
      if (policy.mode === "off") {
        return finishResponse({
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message:
            (d.assistant_message || "").trim() +
            "\n\n(Web research is disabled by host config. Please paste the relevant excerpt or attach a PDF, or enable OPERATOR_WEB_RESEARCH_MODE.)",
          actions: []
        });
      }

      // Notify once per round (avoid spamming).
      try {
        appendNotification(req.session_id, "web.research.progress", `Researching ${webRequests.length} source(s)…`, {
          count: webRequests.length,
          mode: policy.mode
        });
      } catch {
        // ignore
      }

      const fetched: any[] = [];
      for (const wr of webRequests.slice(0, 6)) {
        const request_id = (wr?.request_id ?? "").toString().trim() || `wr_${Math.random().toString(16).slice(2)}`;
        const url = (wr?.url ?? "").toString().trim();
        if (!url) continue;
        try {
          persistence.appendToolCall(req.session_id, { ts: new Date().toISOString(), kind: "web.fetch", session_id: req.session_id, request_id, url });
        } catch {
          // ignore
        }

        const r = await fetchWebEvidence({ requestId: request_id, url, policy });
        fetched.push(r);

        try {
          persistence.appendToolOutput(req.session_id, {
            ts: new Date().toISOString(),
            kind: "web.evidence",
            session_id: req.session_id,
            request_id: request_id,
            url,
            ok: !!(r as any).ok,
            ...(typeof (r as any).evidence_dir === "string" ? { evidence_dir: (r as any).evidence_dir } : {}),
            ...(typeof (r as any).error === "string" ? { error: (r as any).error } : {}),
            ...(typeof (r as any).paywall === "boolean" ? { paywall: (r as any).paywall } : {})
          });
        } catch {
          // ignore
        }
      }

      webEvidence = fetched;

      // Summarize to the user via notification (one line).
      try {
        const okCount = fetched.filter(x => x && (x as any).ok).length;
        appendNotification(req.session_id, "web.research.saved", `Saved evidence for ${okCount}/${fetched.length} source(s).`, {
          ok: okCount,
          total: fetched.length
        });
      } catch {
        // ignore
      }
    }

    const serverExtra: Record<string, unknown> = {};
    if (webEvidence.length > 0) serverExtra.web_evidence = formatWebEvidenceForPrompt(webEvidence);
    if (workbenchResults.length > 0) serverExtra.workbench_results = formatWorkbenchResultsForPrompt(workbenchResults);
    if (workbenchResults.length > 0) {
      const wbImages = collectWorkbenchInlineImagePaths(workbenchResults);
      if (wbImages.length > 0) serverExtra.workbench_inline_image_paths = wbImages;
    }
    if (Object.keys(serverExtra).length === 0) break;

    currentReq = withPlacementWorkItem({ ...currentReq, context: withServerContext(currentReq.context, serverExtra) });
  }

  if (!lastDecision) return finishResponse({ version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "No response from model.", actions: [] });

  let devSummary = "";
  const finalDevActions = Array.isArray(lastDecision.dev_actions) ? lastDecision.dev_actions : [];
  if (finalDevActions.length > 0) {
    const normalized = finalDevActions.map(a => {
      if (!a || typeof a !== "object") return { type: "shell", command: "", workdir: null, timeout_ms: null } as any;
      if (a.type === "apply_patch") return { type: "apply_patch", patch: a.patch ?? "", workdir: a.workdir ?? undefined };
      if (a.type === "shell") return { type: "shell", command: a.command ?? "", workdir: a.workdir ?? undefined, timeout_ms: a.timeout_ms ?? undefined };
      if (a.type === "write_file") return { type: "write_file", file_path: a.file_path ?? "", content: a.content ?? "" };
      if (a.type === "restart_backend") return { type: "restart_backend" };
      return { type: "shell", command: "", workdir: null, timeout_ms: null } as any;
    });

    const unlocked = !!(req.context && typeof req.context === "object" && (req.context as any).__server?.dev_agent_unlocked);
    const devResults = await executeDevActions(normalized as any, { unlocked });
    const head = devResults.every(r => r.ok) ? "Dev actions applied." : "Dev actions had errors.";
    const lines: string[] = [head];
    for (const r of devResults) {
      const status = r.ok ? "OK" : "FAIL";
      lines.push(`- ${status} ${r.type}: ${r.detail}`);
    }
    devSummary = "\n\n" + lines.join("\n");
  }

  let invalidBodyCount = 0;
  const filteredActions: ActionCall[] = [];
  for (const a of lastDecision.actions ?? []) {
    const action_id = a.action_id && a.action_id.trim() ? a.action_id : randomUUID();

    // Never send a body for GET actions (some models incorrectly emit body_json for GET).
    if (a.method === "GET") {
      filteredActions.push({ action_id, method: a.method, path: a.path });
      continue;
    }

    let body: unknown = undefined;
    const bodyJson = (a.body_json ?? "").trim();
    if (bodyJson) {
      try {
        body = JSON.parse(bodyJson);
      } catch {
        invalidBodyCount++;
        continue;
      }
    }

    const normalizedBody = normalizeSheetsActionForCompatibility(a.method, a.path, body);

    filteredActions.push({
      action_id,
      method: a.method,
      path: a.path,
      ...(normalizedBody === undefined ? {} : { body: normalizedBody })
    });
  }

  const allowlistFromContext = buildAllowlistFromPairs((req.context as any)?.capabilities?.allowlist);
  let toolResultsForRouting = getAugmentedToolResults(req, 80);
  let allowlisted = normalizeNativeRevitActionBodiesForRouting(
    filterAllowlistedActions(filteredActions, allowlistFromContext ?? undefined),
    toolResultsForRouting,
    req
  );
  const redlineDiagnosticRequest = userRequestsRedlineDiagnostics(req);
  if (redlineDiagnosticRequest && userRequestsRedlineDiagnosticsOnly(req) && allowlisted.length > 0) {
    return finishResponse({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "Answer: I will not run additional Revit writes for this diagnostic/feedback turn. " +
        "The session evidence should be treated as a failed or partial redline placement until the wrong-room placement and latest warning/recovery state are resolved.",
      actions: []
    });
  }
  const hasRedlineContext =
    !!getRedlineSessionSeed(req.session_id) ||
    userTextLooksRedlineContinuation(req) ||
    workbenchResults.some((r) => r?.type === "analyze_redline" || r?.type === "gemini_redline_analyze" || r?.type === "redline_orient");
  const mepRouteRedlineContext =
    hasRedlineContext &&
    isMepRouteRedlineIntent(buildRedlineSemanticCorpus(req, workbenchResults));

  if (hasRedlineContext && !redlineDiagnosticRequest) {
    const hadFrameAlignedHint = hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults);
    const recoveredHints = await maybeAutoAlignRedlineViewHints({ req, workbenchResults });
    const hasFrameAlignedHint = hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults);
    if (recoveredHints > 0 || (!hadFrameAlignedHint && hasFrameAlignedHint)) {
      toolResultsForRouting = getAugmentedToolResults(req, 80);
      allowlisted = normalizeNativeRevitActionBodiesForRouting(allowlisted, toolResultsForRouting, req);
    }
  }

  const explicitCircuitPlacementGuard = buildExplicitCircuitPlacementSourceGuardResponse({
    req,
    actions: allowlisted,
    toolResults: toolResultsForRouting
  });
  if (explicitCircuitPlacementGuard) return finishResponse(explicitCircuitPlacementGuard);
  const allReadOnlyActions = allowlisted.length > 0 && allowlisted.every((a) => a.method !== "POST" || !pathLooksWrite(a.path));
  const allRedlineDiscoveryActions =
    allowlisted.length > 0 &&
    allowlisted.every((a) => {
      const p = (a.path ?? "").trim().toLowerCase();
      return REDLINE_DISCOVERY_PATHS.has(p);
    });

  const allowlistedResponseForGuard: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: lastDecision.assistant_message || "",
    actions: allowlisted
  };
  const mepRedlineActionGuard = buildMepRedlineActionGuardResponse({
    req,
    workbenchResults,
    actions: allowlisted
  });
  if (mepRedlineActionGuard) return finishResponse(mepRedlineActionGuard);
  const mepRedlineRouteRecovery = buildMepRedlineRouteRecoveryResponse({
    req,
    workbenchResults,
    actions: allowlisted,
    toolResults: toolResultsForRouting
  });
  if (mepRedlineRouteRecovery) return finishResponse(mepRedlineRouteRecovery);
  if (
    mepRouteRedlineContext &&
    !redlineDiagnosticRequest &&
    bridgeHasHostedPlacementAction(allowlistedResponseForGuard)
  ) {
    return finishResponse({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "I will not use hosted family placement for this duct/pipe redline. That path is for devices like receptacles, and would risk cloning the wrong element. " +
        "I’ll route this through the MEP duct/pipe creation workflow instead.",
      actions: [
        {
          action_id: randomUUID(),
          method: "POST",
          path: "/revit/tool-search",
          body: {
            query: "MEP redline create duct route workflow frame-linked points duct size"
          }
        }
      ]
    });
  }
  if (
    hasRedlineContext &&
    !redlineDiagnosticRequest &&
    hasAlignableRedlineImageSeed(req.session_id) &&
    bridgeHasHostedPlacementAction(allowlistedResponseForGuard)
  ) {
    if (!hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults)) {
      await maybeAutoAlignRedlineViewHints({
        req,
        workbenchResults,
        allowSyntheticFallback: false
      });
    }
    const measuredBridge = await maybeBuildRedlineExecutionBridge(req, workbenchResults);
    if (measuredBridge && hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults)) {
      return finishResponse(measuredBridge);
    }
    if (!hasFrameAlignedRedlineHintForLatestFrame(req, workbenchResults)) {
      return finishResponse(maybeBuildMeasuredRedlineTargetBlocker(req, allowlistedResponseForGuard));
    }
    if (measuredBridge) return finishResponse(measuredBridge);
  }

  if (!redlineDiagnosticRequest && hasRedlineContext && allReadOnlyActions && allRedlineDiscoveryActions) {
    const bridge = await maybeBuildRedlineExecutionBridge(req, workbenchResults);
    if (bridge) return finishResponse(bridge);
  }

  if (loopPressure?.hard_stop && allReadOnlyActions && allRedlineDiscoveryActions) {
    const stopMessage =
      (lastDecision.assistant_message || "").trim() +
      "\n\nStopped repeated read-only redline-discovery loop due to no-progress churn. " +
      "Please confirm one concrete target edit (for example, 'delete text note id 12345 on M000') and I will execute directly.";
    return finishResponse({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: stopMessage,
      actions: []
    });
  }

  if (allowlisted.length === 0 && hasRedlineContext && !redlineDiagnosticRequest) {
    const seed = getRedlineSessionSeed(req.session_id);
    const sheetHint = normalizeExpectedSheet(seed?.expected_sheet ?? null);
    const toolResults = getAugmentedToolResults(req, 80);
    const postWrite = collectRecentPostWriteEvidence(toolResults);
    const redlineGeminiIntents = getPersistedGeminiIntentHints(req.session_id);
    const redlineAnnotationHints = getPersistedAnnotationRegionHints(req.session_id);
    const redlineSemanticCorpus = buildRedlineSemanticCorpus(req, workbenchResults);
    const redlineTargetProfile = hydrateRedlineTargetingProfile({
      sessionId: req.session_id,
      profile: inferRedlineTargetingProfileFromText(
        redlineSemanticCorpus,
        redlineGeminiIntents,
        redlineAnnotationHints
      ),
      toolResults
    });
    const suppressGenericPostWriteAutoSuccess = isSpatialPlacementTargetingProfile(redlineTargetProfile);
    if (suppressGenericPostWriteAutoSuccess && shouldPrioritizeHostedPlacementBridge(redlineTargetProfile, toolResults)) {
      const bridge = await maybeBuildRedlineExecutionBridge(req, workbenchResults);
      if (bridge) return finishResponse(bridge);
    }
    if (!suppressGenericPostWriteAutoSuccess && postWrite.has_applied_write && postWrite.has_post_write_verification) {
      const evidenceNote =
        postWrite.evidence_paths.length > 0
          ? `Post-change evidence captured: ${postWrite.evidence_paths.join(", ")}.`
          : "Post-change verification actions completed.";
      const base = (lastDecision.assistant_message || "").trim();
      const msg = base
        ? `${base}\n\n${evidenceNote}`
        : `Answer: Applied the requested redline edit and captured post-change evidence. ${evidenceNote}`;
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: msg,
        actions: []
      });
    }
    const attempts = summarizeSheetDetailAttempts(toolResults);
    const activeSheetViewId = extractActiveSheetViewIdFromContext(req.context);

    if (!attempts.has_success && activeSheetViewId !== null && !attempts.attempted_by_view_id) {
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `I’ll resolve the active sheet directly by viewId ${Math.round(activeSheetViewId)} to recover geometry for redline mapping.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/sheets",
            body: {
              action: "detail",
              viewId: Math.round(activeSheetViewId),
              includePlacedViews: true,
              includeViewports: true,
              includeViewportGeometry: true,
              includeTitleBlocks: true,
              includeSheetOutline: true
            }
          }
        ]
      });
    }

    if (!attempts.has_success && seed && sheetHint && !attempts.attempted_by_sheet_number) {
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: `I’m anchoring to sheet ${sheetHint} from the session redline attachment before applying changes.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/sheets",
            body: {
              action: "detail",
              sheetNumber: sheetHint,
              includePlacedViews: true,
              includeViewports: true,
              includeViewportGeometry: true,
              includeTitleBlocks: true,
              includeSheetOutline: true
            }
          }
        ]
      });
    }

    const bridge = await maybeBuildRedlineExecutionBridge(req, workbenchResults);
    if (bridge) return finishResponse(bridge);

    const ductScopeRecovery = buildMepRedlineDuctScopeRecoveryResponse({
      req,
      workbenchResults,
      toolResults,
      redlineTargetProfile
    });
    if (ductScopeRecovery) return finishResponse(ductScopeRecovery);

    if (
      redlineTargetProfile.room_number &&
      !hasSuccessfulToolPath(toolResults, "/revit/resolve-room-plan-view") &&
      countToolPath(toolResults, "/revit/resolve-room-plan-view") < 2
    ) {
      const preferViewNameContains = inferPreferredRedlineViewNameToken(redlineTargetProfile, redlineSemanticCorpus);
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I don’t have a reliable model-view anchor yet, so I’ll resolve the best plan view for room ${redlineTargetProfile.room_number} instead of pausing.` +
          `${preferViewNameContains ? ` I’ll bias toward views with '${preferViewNameContains}' in the name.` : ""}`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/resolve-room-plan-view",
            body: {
              roomNumber: redlineTargetProfile.room_number,
              ...(preferViewNameContains ? { preferViewNameContains } : {}),
              maxCandidates: 8
            }
          }
        ]
      });
    }

    if (
      redlineTargetProfile.room_number &&
      !hasSuccessfulToolPath(toolResults, "/revit/rank-similar-devices-on-wall") &&
      countToolPath(toolResults, "/revit/rank-similar-devices-on-wall") < 2
    ) {
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          `I still have room intent but no selected executable write, so I’ll rank same-room hosted device exemplars with native XYZ/host/circuit data instead of asking for manual confirmation.`,
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/rank-similar-devices-on-wall",
            body: {
              roomNumber: redlineTargetProfile.room_number,
              roomSide: redlineTargetProfile.spatial_side_source ?? redlineTargetProfile.spatial_side,
              ...(redlineTargetProfile.categories.length > 0 ? { categories: redlineTargetProfile.categories } : {}),
              includeKeywords: ["receptacle", "outlet", "duplex", "power", "device", "switch", "data"],
              sortMode:
                redlineTargetProfile.spatial_side_source || redlineTargetProfile.spatial_side
                  ? "score_then_distance_then_coordinate"
                  : "smallest_y_then_x",
              maxCandidates: 20
            }
          }
        ]
      });
    }

    if (!hasSuccessfulToolPath(toolResults, "/revit/views") && countToolPath(toolResults, "/revit/views") < 1) {
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "I could not derive a model-view anchor from the redline state, so I’ll list Revit views and score likely plan views instead of stopping.",
        actions: [
          {
            action_id: randomUUID(),
            method: "GET",
            path: "/revit/views"
          }
        ]
      });
    }

    if (hasFailedToolPath(toolResults, "/revit/tool-doc") && !hasSuccessfulToolPath(toolResults, "/revit/tool-examples")) {
      return finishResponse({
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message:
          "A tool-doc lookup failed, so I’ll recover with concrete tool examples for the native placement path instead of treating discovery as a blocker.",
        actions: [
          {
            action_id: randomUUID(),
            method: "POST",
            path: "/revit/tool-examples",
            body: {
              method: "POST",
              path: "/revit/rank-similar-devices-on-wall"
            }
          }
        ]
      });
    }

    const seedMsg =
      seed && seed.file_path
        ? `I used session redline anchor: ${seed.file_path}${sheetHint ? ` (sheet ${sheetHint})` : ""}.`
        : "No reusable redline attachment anchor is available in this turn.";
    const unresolvedViewNote =
      redlineTargetProfile.resolve_only && redlineTargetProfile.pick_preference === "modelGeometry"
        ? " I could not yet resolve a target model view from the current room/sheet/upload clues."
        : "";
    noteRedlineFastPathPhase(req.session_id, "blocked", { blocked_reason: "planner_loop_guard" });
    return finishResponse({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Answer: I paused because no executable Revit action was selected for this redline turn. ${seedMsg} ` +
        `Blocked detail state: ${attempts.has_detail_call ? attempts.last_status ?? "unknown" : "no detail-resolution call yet"}. ` +
        `I’ll continue from the current geometry/redline mapping and need pixel-picked candidates, spatial candidate context, or one explicit target confirmation to apply safely.${unresolvedViewNote}`,
      actions: []
    });
  }

  if (allowlisted.length === 0) {
    const recovery = maybeBuildCapabilityRecoveryResponse({
      req,
      decision: lastDecision,
      filteredActions,
      allowlisted
    });
    if (recovery) return finishResponse(recovery);
  }

  const dropped = filteredActions.length - allowlisted.length;
  const guardedMessage = maybeAppendVerificationGuardMessage(lastDecision.assistant_message || "", allowlisted.map(a => ({ method: a.method, path: a.path })));
  const assistant_message =
    (dropped > 0 ? `${guardedMessage}\n\n(Note: dropped ${dropped} non-allowlisted action(s).)` : guardedMessage) +
    (invalidBodyCount > 0 ? `\n\n(Note: dropped ${invalidBodyCount} action(s) due to invalid JSON in body_json.)` : "") +
    devSummary +
    (webEvidence.length > 0 ? formatWebCitationsForUser(webEvidence) : "");

  return finishResponse({
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message,
    actions: allowlisted
  });
}
