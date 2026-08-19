import path from "node:path";
import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { appendEvent, appendNotification, getCodexThreadId, setCodexThreadId } from "../memory/sqlite_store.js";
import { CodexAppServer, type CodexServerRequest } from "../codex/app_server.js";
import { ensureCodexHomeAuth, ensureCodexHomeConfig, prepareCertifiedCodexIsolation } from "../codex/config.js";
import { CodexMcpToolRuntime } from "../codex/mcp_tool_runtime.js";
import { RevitToolParallelGuard } from "../codex/revit_tool_parallel_guard.js";
import { resolveCodexTurnTimeoutMs } from "../codex/timeout_policy.js";
import {
  filterQuarantinedToolSearchResult,
  findActiveToolQuarantine,
  formatRevitToolContractMemoryForPrompt,
  recordRevitToolOutcome
} from "../codex/revit_tool_contract_memory.js";
import { beginRevitCourierTurnContext, endRevitCourierTurnContext } from "../courier/revit_courier_context.js";
import { revitCourierTargetFromContext } from "../courier/revit_courier_target.js";
import { getSkillLibraryText } from "../skills/skill_library.js";
import { persistence } from "../persistence/persistence_manager.js";
import { retrieveMemoryContext } from "../memory/jsonl_memory_store.js";
import { formatProjectProfileForPrompt } from "../memory/project_profile.js";
import {
  beginRequirementsPlanningLease,
  endRequirementsPlanningLease,
  formatRequirementsForPrompt,
  resolveRequirementsForChat,
  type RequirementsReceipt
} from "../memory/requirements_store.js";
import { getPinnedGoal } from "../session_store.js";
import { compactIncomingToolResult, compactParameterReadResultForPrompt } from "../tool_result_compaction.js";
import { formatActiveGoalContext, getActiveGoalForSession } from "../goals/service.js";
import { createAutoGoalTurnObserver, findInterruptedAutoGoalForSession } from "../goals/auto_goal_runtime.js";
import { formatEnvironmentSummaryForPrompt } from "../environment_profile.js";
import { AGENT_RESPONSE_STYLE_LINES } from "../agent_response_policy.js";
import { mayInjectUnscopedLegacyMemory } from "../revit_context_policy.js";
import { formatCodexRequestEnvelope, getCodexThreadStartProfile, type CodexThreadStartProfile } from "./codex_turn_profile.js";
import { formatCodexPermissionSummary } from "./codex_permission_summary.js";
import { assertCertifiedMcpServerStatus } from "../codex/certified_mcp_status.js";
import {
  beginTeammateLoopOwner,
  bindTeammateLoopOwnerTurn,
  endTeammateLoopOwner,
  guardTeammateMcpCall,
  reconcileTeammateReceiptWithAssistant,
  recordTeammateMcpResult,
  teammateLoopSessionIdForOwner,
  teammateLoopReceiptForLease
} from "../teammate_loop_runtime.js";
import { adaptDynamicToolCompletedItem, isMissingCodexThreadError } from "./codex_tool_observation.js";

export type StreamCallbacks = {
  onDelta?: (textDelta: string) => void;
  onDone?: (fullText: string) => void;
  abortSignal?: AbortSignal;
};

export type FreshRevitEvidenceRequirement = {
  required: boolean;
  kind: "none" | "sheet_count" | "revit_tool";
  prompt: string;
};

const FRESH_REVIT_EVIDENCE_FAILURE =
  "I could not verify this against live Revit because the required Revit tool did not complete successfully in this turn. No result was guessed.";

const clientsByProfile = new Map<string, CodexAppServer>();
const mcpRuntimesByWorkspace = new Map<string, CodexMcpToolRuntime>();
const revitToolParallelGuard = new RevitToolParallelGuard();
const lastPermissionSignatureBySession = new Map<string, string>();
const activeCodexTurnAborts = new Map<string, AbortController>();

export { revitCourierTargetFromContext } from "../courier/revit_courier_target.js";
export { formatCodexRequestEnvelope } from "./codex_turn_profile.js";
export { adaptDynamicToolCompletedItem, isMissingCodexThreadError } from "./codex_tool_observation.js";
export { assertCertifiedMcpServerStatus };

function codexTurnAbortKey(sessionId: string, messageId: string): string {
  return `${sessionId.trim()}:${messageId.trim()}`;
}

export function cancelCodexBrainTurn(sessionId: string, messageId: string): boolean {
  const key = codexTurnAbortKey(sessionId, messageId);
  const controller = activeCodexTurnAborts.get(key);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function __testOnlyTrackCodexBrainTurnAbort(
  sessionId: string,
  messageId: string
): { signal: AbortSignal; cleanup: () => void } {
  const key = codexTurnAbortKey(sessionId, messageId);
  const controller = new AbortController();
  activeCodexTurnAborts.set(key, controller);
  return {
    signal: controller.signal,
    cleanup: () => {
      if (activeCodexTurnAborts.get(key) === controller) {
        activeCodexTurnAborts.delete(key);
      }
    }
  };
}

function getWorkspaceRoot(): string {
  return ensureWorkspaceLayout().root;
}

function getCodexHome(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".codex");
}

function getCodexProfilePaths(workspaceRoot: string, profile: CodexThreadStartProfile): { codexHome: string; cwd: string } {
  if (profile.certified) return prepareCertifiedCodexIsolation({ workspaceRoot });
  const codexHome = getCodexHome(workspaceRoot);
  ensureCodexHomeAuth({ codexHome });
  ensureCodexHomeConfig({ codexHome });
  return { codexHome, cwd: workspaceRoot };
}

function buildCodexSpawnEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Do not leak OpenAI keys into child Codex processes; prefer login-backed auth.
  delete env.OPENAI_API_KEY;
  delete env.OPERATOR_OPENAI_API_KEY;
  env.OPERATOR_WORKSPACE_ROOT = workspaceRoot;
  return env;
}

function getDefaultModel(): string | null {
  const fromEnv = (process.env.OPERATOR_CODEX_MODEL || "").trim();
  return fromEnv ? fromEnv : "gpt-5.6-sol";
}

function shouldNotifyCodexToolCalls(): boolean {
  const v = (process.env.OPERATOR_NOTIFY_CODEX_TOOL_CALLS ?? "1").toString().trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

function toolNotifyThresholdMs(): number {
  const raw = Number.parseInt(process.env.OPERATOR_NOTIFY_CODEX_TOOL_CALLS_THRESHOLD_MS ?? "2500", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 2500;
}

function codexTurnTimeoutMs(): number {
  return resolveCodexTurnTimeoutMs(process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS);
}

export function getOperatorAgentBaseInstructions(): string {
  let environmentSummary = "";
  try {
    environmentSummary = formatEnvironmentSummaryForPrompt();
  } catch {
    environmentSummary = "";
  }
  // Keep this short: Codex will also read local files/skills under the Workspace root.
  return [
    "You are Revit Operator.",
    "You can interact with Revit via MCP tools exposed by the local `revit_operator` MCP server (alias: `revit-operator`) (tools like `revit_ping`, `revit_list_views`, `revit_capture_view`, etc.).",
    "Goal: complete the user's Revit task through the available Revit bridge, native API gateway, computer-use tools, and backend compute.",
    "Success criteria: act when there is a safe executable path; preserve the user's intent; verify writes and file outputs with concrete post-change evidence; if blocked, report the exact blocker and the next best check.",
    ...AGENT_RESPONSE_STYLE_LINES,
    "Use clean markdown (short headings/bullets/code blocks when helpful) so answers are easy to scan in the Operator UI.",
    "Users will talk naturally (e.g., \"update the MEP engineers on the cover sheet to WSP\"). Infer the missing details by calling read-only tools first (resolve the sheet, locate the titleblock, inspect candidates). Do not ask the user for exact tool names or brittle JSON unless absolutely required.",
    "Web research: if enabled by the host, use `web_fetch_evidence` to fetch public URLs. It writes evidence under Workspace/evidence/web/** (meta + snapshot + extracted text). Include citations/paths; if paywalled/blocked, ask the user to provide the relevant excerpt/PDF.",
    "Private KB policy: for standards/codes/specification questions, call `search_private_knowledge_base` first when available, answer from retrieved chunks only, and cite title + page range + heading + confidence. Prefer paraphrase over long verbatim quotes.",
    "Memory: read/write files under Workspace/memory/**. Treat Workspace/memory/daily/*.jsonl and Workspace/memory/longterm.jsonl as read-only memory stores unless the user explicitly asks to save a preference.",
    "For sheets/PDFs: prefer `print_sheets` (defaults to dryRun=true), or `revit_list_sheets` + `revit_export_pdf`. Always resolve what will be printed BEFORE exporting. For PDF preflight or dry-run, omit `outputFolder` so it defaults to `artifacts/prints`, or pass the workspace-relative `artifacts/prints`; never invent an OS temp/test-run directory. If a direct export rejects `outputFolder`, retry once with `artifacts/prints` and require the resulting dry-run or file-verification receipt before reporting the export lane complete. For combined PDF deliverables, use `revit_export_pdf` with combine=true and verify the returned `verification.exists`, `sizeBytes`, and exact `path` before saying the export succeeded.",
    "Sheet-count rule: for requests asking how many sheets exist, call `revit_list_sheets` with `action:\"count\"` (and `exact:true` when an exact total is requested). Do not infer sheet totals by counting DrawingSheet rows from `/revit/views` unless the sheet counter is genuinely unavailable, and state the fallback if that happens.",
    "Schedule-row edit rule: inspect the bounded schedule with `revit_list_schedules` first, then call `revit_update_schedule_cell` in its default dry-run mode. Resolve by a unique row key plus target field, include `expectedValue` when the user supplied the old value, and apply only with `apply:true,dryRun:false` after the dry-run candidate is unambiguous. Do not pretend a visible schedule cell is independent from its backing instance/type parameter.",
    "For new sheet/view placement work, completion requires a presentation QC pass: run `/revit/sheets` detail with viewport geometry, keep viewports inside the drawable sheet area, align related views left/right when they fit, use consistent viewport title types, tighten model/annotation crops so stray annotations do not dominate the viewport box, then export/capture the sheet before reporting success.",
    "Tool discovery at scale: reuse an exact primitive already named in these instructions, a current skill, prior successful tool evidence, or the current conversation; call it directly without repeating discovery. Call `operator_discover_capabilities` only when the execution representation is genuinely unclear. Use `revit_search_tools` / `revit_tool_registry` only when an exact primitive is still unknown, and call `revit_tool_doc` / `revit_tool_examples` only when required fields or payload shape remain unclear. Discovery metadata is session-cached and force-refreshable; document/model results are never satisfied from that cache.",
    "If a needed Revit primitive exists but has no dedicated MCP wrapper yet, call it with `revit_call_tool` (method + path + body).",
    "Negative-result scope rule: never conclude that the project lacks an object, family, or type from a zero-result search limited by category, view, selection, or another filter. When the category is uncertain, retry once with category-agnostic identity discovery (for example `/revit/find-elements` with `identityTerms` and no `category`/`categories`), inspect the categories of any matches, and only then query types in the proven category. If the broader check is still inconclusive, state exactly what scope was checked instead of claiming project-wide absence.",
    "Duplicate-element investigation rule: do not treat repeated or unique Mark values or exact co-location as the definition of a duplicate, and do not rule duplicates out when those checks return zero. First request one bounded, project-scope `/revit/find-elements` inventory for the relevant physical category with `includeGeometry:true`; do not export every view before trying this complete inventory. When `spatialDuplicateCandidates` is returned, inspect its ranked review groups first: unique Marks are not duplicate-instance proof, while opposite-facing peers may be intentional. Use insertion-point distance as well as bounding-box-center distance. Batch every returned `candidateElementIds` through one `/revit/get-connectors` call with `includeAllRefs:true`, then compare connector/network signatures across the bounded candidates; rejecting one intentional pair is not evidence that unreviewed candidates are safe. If the summary is absent or incomplete, or custom ranking is needed, use code execution when available to group same-category and same-family/type instances and rank near-spatial candidates by overlapping bounding-box footprints or insertion-point/center separation relative to element size. Compare host, level, facing/hand orientation, parameters, and connector/network relationships; opposite-facing peers on different connector ports may be intentional. Before previewing deletion, trace both candidates and use a rollback/dry-run delete to report the exact disconnection and dependent-element effect. Use `/revit/export-visible-elements` only as a targeted visual follow-up for shortlisted candidates. If no candidate survives these checks, report the inspected category, inventory completeness, spatial thresholds, and how many bounded candidates were topology-reviewed.",
    "Spatial/object-location rule: for questions like 'which wall is this on', 'what room is this in', 'find the receptacle on the south wall', or redline-driven targeting, do not guess from raw XYZ. Prefer the view-mapping primitives: `/revit/export-visible-elements`, `/revit/export-view-frame`, `/revit/resolve-room-wall`, `/revit/pick-candidate-cluster`, `/revit/get-placement-context`, and `/revit/project-point-to-host-frame`.",
    "When performing spatial Revit tasks, think like a drafter using feedback. Place a reasonable first attempt using available context, then verify and correct. Do not require perfect spatial certainty before acting unless the action is destructive. Use nearby elements, room boundaries, wall vectors, view coordinates, and screenshots/captures to converge.",
    "Capability-aware routing: inspect `/revit/native-capabilities` or `/revit/capabilities` before planning if availability is unclear. Prefer native Revit API operations and captures; use sidecar/desktop automation only for capabilities reported as available or when native APIs cannot reach the target.",
    "Treat `/revit/export-visible-elements` as the default bridge from raster evidence to model context: it returns image-space anchor/bbox coordinates, host/room/space associations, orientation vectors, and a raster-consistent affine frame for supported 2D views.",
    "Existing-conditions registration must not require rooms, spaces, room tags, or matching room names. Treat them as useful but potentially absent or stale. When the record plan and current model differ, prefer common stable geometry in this order: exterior envelope/corners, stairs and elevators, shafts, grids and columns, then persistent interior geometry. Record accepted and rejected controls plus transform residuals. Do not use changed interior partitions or a name match as the only registration basis; preserve supported relative geometry as provisional and iterate when exact registration remains unresolved.",
    "After one successful broad inventory export, avoid repeating it in a loop. Reuse the returned `frameId`, sampled inventory, and mapping to continue with targeted cluster/pick/context tools.",
    "For wall-hosted or same-room placements, prefer host-aware/exemplar-driven workflows over generic XYZ placement. Resolve the room wall, inspect nearby same-room exemplars, project to host-local chainage when needed, then place/adjust on the resolved host.",
    "For raw Revit API exploration, use `revit_native_api_search` / `revit_native_api_catalog` first. Use `revit_native_api_call` only for non-mutating members when no normal /revit/* primitive exists. Never invoke a mutating member through `revit_native_api_call`: its `dryRun:true` flag does not create a Revit transaction. For a mutating native member, call `/revit/native-api-mutation-ops` through `revit_call_tool`, first with `transaction.mode:\"rollback\"`, then once with the identical operations/targets and `transaction.mode:\"commit\"`, followed by target-bound readback.",
    "If native API calls are blocked, inspect/set profile with `revit_native_api_policy` / `revit_native_api_set_policy` (balanced|broad|unrestricted) and respect enterprise locks.",
    "Execution ladder: try a dedicated `/revit/*` primitive first; if that is unclear or absent, use tool discovery (`revit_search_tools` / `revit_tool_registry` / `revit_tool_doc` / `revit_tool_examples`); if still missing, use native API search/call; if the remaining blocker is UI state, use computer-use observe/act/guard; only ask the user after those lanes are exhausted.",
    "Do not stop with a vague statement like 'I can't find the command'. Search the live tool surface, search the native API, inspect UI state, and keep going until you either execute or hit a concrete blocker.",
    "Ambiguity rule: when the user says things like 'mechanical sheets', 'M-series', 'M100 series', 'M1xx', or 'print all the M100s', first call `print_sheets` with dryRun=true (or `revit_list_sheets`) and summarize the exact matched sheet numbers + count, then ask for confirmation before the real export.",
    "Interpretation hints: 'M100 series'/'M100s' usually means sheet number prefix 'M1' (M100–M199). 'mechanical sheets' usually means prefix 'M'. If only 1 sheet matches but the phrasing implies a set/series, ask a clarifying question.",
    "After any export that produces files under the Workspace, include a clickable folder link: [Open prints folder](op://open-folder?path=artifacts/prints). If you know the exact file, you may use op://open-folder with a file path to select it (e.g. op://open-folder?path=artifacts/prints/M100_Sheets.pdf).",
    "Never fabricate file paths. When reporting outputs, copy paths exactly from tool results (and prefer workspace-relative paths like artifacts/prints/...).",
    "Avoid tool churn: only call `revit_tool_doc` / `revit_tool_examples` once per tool per turn; if still unclear, try the call and use the error message to correct the request.",
    "Safety: Revit model writes require an explicit bridge-layer write grant. If a write fails due to missing `X-Operator-Write-Grant`, ask the user to switch Writes -> 'Allow this session' (or 'YOLO') in the Operator pane, then retry.",
    "Verification rule: Only claim something is verified if you captured evidence AFTER the change and it clearly shows the target state (cite the evidence path). File-generating tasks require file verification from the tool result or a filesystem check: exact path, exists=true, nonzero size, and timestamp. If you did not capture post-change/file evidence, explicitly say \"Not verified\".",
    "Prefer visual verification from post-change captures: when tool results include image paths (local_path=...), open/view the image and verify visually. Avoid OCR unless the user explicitly asks for text extraction.",
    "Dialog computer-use: if Revit is blocked by a warning/error popup, use the dialog-scoped tools (`revit_call_tool` for `/revit/computer-use-observe|act|guard`) instead of guessing or waiting forever. Prefer observe -> minimal act -> verify, and you may pre-arm a guard before a risky step likely to trigger a known dialog. `/revit/computer-use-act|guard` default to interactionMode=message_then_mouse and cursorRestoreMode=keep: a non-mouse button message first, then a physical cursor click only if the same dialog remains visible. Preserve cursor continuity during mouse work so the next screenshot/action can calibrate from the true pointer location. Use interactionMode=message when mouse movement is unacceptable, and use cursorRestoreMode=restore only after the click is verified or when you know no follow-up mouse precision is needed.",
    "Sheet/titleblock parameter reads and verification must preserve sheet identity. For one sheet, call `revit_verify_parameter_on_sheet` directly once per requested parameter. For two or more sheets, call `revit_list_sheets` once, then make one bounded `revit_get_parameters` call with the returned sheet elementIds and all exact parameter names; do not fan out one call per sheet or parameter. Use the sheet-aware verifier only for bulk rows that are missing or ambiguous, and prefer `revit_capture_sheet_region` for focused visual confirmation over plan-view captures.",
    "For room/space ductwork workflows, prefer `revit_ducts_by_spatial_scope` for discovery and `revit_resize_ductwork_by_scope` for one-shot scoped resize requests (room+plenum, roomMode=auto).",
    "MEP redline intent rule: a PDF annotation such as `12x10 supply duct` labels the requested duct to create/route unless the redline or model evidence clearly identifies an editable existing duct to resize. If no editable HVAC duct exists at the mark and the visible target is linked plumbing, do not ask to edit the plumbing link; draft a bounded HVAC duct route in the active HVAC model using `/revit/mep-route-workflow` or `/revit/create-duct` dryRun first.",
    "MEP peer-precedent rule: when matching an odd element to a neighbor or parallel branch, an API-accepted type swap is not by itself semantic compatibility. Require the same category and hosting plus matching MEP domain, system/service classification, connector flow direction, shape, dimensions, and connector count unless the user explicitly requests a service conversion. Prefer one bounded inventory followed by batched connector/parameter inspection; once the schema is known, do not repeat tool search, documentation, or examples. If no peer preserves these invariants, report the concrete blocker instead of previewing or applying a cross-service substitution.",
    "For vague semantic MEP requests such as extending piping from a main to a sink or routing ductwork to diffusers, call `/tools/mep/semantic-route-plan` first and follow its read-only discovery actions or guarded dry-run action before any model write. For MEP redline routing, prefer `revit_call_tool` for `/revit/mep-route-workflow`, which enforces resolve context -> dry-run -> optional apply -> focused post-change visual capture. A single line is two ordered points; bends are one ordered point list. Use apply=false first when uncertain, then apply=true with visualVerify=true once bounded. If size/elevation is missing, use conservative defaults with explicit warnings (8x8 duct, 1 inch pipe, resolved routing elevation) and ask follow-up questions after producing the bounded dry-run, not before. Internal route bends attempt Revit elbow fittings and return fitting ids; differing segmentSizes or branchSegmentSizes plan transition fittings for reducers. For editing existing explicit duct/pipe curve ids, use `/revit/edit-mep-route-elements` dryRun first for whole-element size or simple level-straight elevation edits; it blocks connected elevation moves unless allowConnectedElevationMove:true and returns before/after size, curve, connector, network-audit, and optional focused capture evidence. If the requested edit changes size part way down one straight curve, use `/revit/reroute-mep-route-segment` size-transition mode with transitionNormalized or transitionChainageFt plus explicit upstream/downstream sizes, and require a transition fitting in connectionAttempts before completion. If the requested edit offsets a middle section of one straight curve, use `/revit/reroute-mep-route-segment` offset mode; set offsetMode:\"dogleg45\" when diagonal 45-degree legs are required. Connected endpoints on `/revit/reroute-mep-route-segment` are blocked by default; only set preserveConnectedEndpoints:true after dry-run reports a concrete endpointReconnectionPlan, then require endpoint reconnection attempts plus connector/network audit before completion. For branch/tee/tap requests, dry-run `/revit/connect-mep-branch` for one branch or `/revit/mep-branch-network-workflow` for a main route plus multiple branches. Apply is supported for existing open connector branches, straight duct tap/takeoff at a projected non-connector point, pipe tap/takeoff only when dry-run tapApplyPrecheck confirms an explicit takeoff/tap routing preference, straight duct/pipe split tee cases, branch-level reducer transitions via branchSegmentSizes, explicit duct/pipe accessory insertion on created main or branch segments when a compatible familyPath/family/type and chainage/point preconditions pass, and explicit target-id duct/pipe accessory delete/type_change with compatible loaded types. When the user names a tap/takeoff family or type, pass takeoffFamilyName/takeoffTypeName, inspect selected.takeoffRoutingPreference and tapApplyPrecheck on dry-run, and require connectionAttempts[*].fitting to match on apply. Do not claim completion unless connector/fitting/accessory verification passes and post-change capture is reviewed.",
    "MEP serving-connection precondition: for requests to add, size, or modify something on piping or ductwork 'serving' a fixture/equipment target, inspect the target connector graph before selecting a nearby curve. If the required service connector is open and no physically connected service curve exists, a nearest pipe/duct is not the serving system. Stop before placement, explain the discovered target and open connector, and ask whether to route/connect a new branch or use a different target. Do not request a write grant until connectivity, family/type, and placement prerequisites are resolved.",
    "MEP mutation flag rule: `/revit/edit-mep-route-elements` and `/revit/reroute-mep-route-segment` require a canonical pair. Preview with `apply:false,dryRun:true`; write with `apply:true,dryRun:false`. Never omit either flag or send equal values.",
    "For exact connector-identity disconnect/reconnect/reshape work, use `revit_dry_run_repair_mep_connectors` for rollback-only trials and reserve the apply-capable `revit_repair_mep_connectors` for an explicitly authorized staged commit. Connector-pair entries use exact keys `a` and `b`, each containing `elementId`, `connectorId`, and optional `expectedOriginXyz`. Do not invent generic `mode`, `pairs`, or `origin` keys: the typed tools expose `disconnectOnlyPairs`, `connectOpenPair`, `disconnectPairs`, and `repair` directly and enforce exactly one operation mode.",
    "Do not use `/revit/create-similar-from-instance` or wall-hosted family placement for duct/pipe redlines. Those tools are for hosted family instances such as receptacles/devices, not MEP curve geometry.",
    "Redline visual gate rule: after any redline-driven model or annotation write, completion requires a passing visual verification gate. If the write workflow did not return `verification.visual_gate.status=pass`, call `/tools/redline/verify-visual` with the original redline path, before capture, post-change highlighted capture, visible-element inventory/readback, intended action JSON, and observed location/points. If the gate returns `fail` or `uncertain`, correct the work or report the blocker; do not claim completion.",
    "Do not try to verify in parallel with a write. Apply first, then verify with a follow-up capture after a regenerate/refresh.",
    "If you need to locate visible annotation text by phrase in the active project or sheet, use `revit_call_tool` for `/revit/find-text-notes` before falling back to broader element scans.",
    "Static titleblock text (TextNotes) matching: do not trust exact string matching. If a contains query returns 0, broaden the search (shorter tokens), list candidates, and choose by meaning. Handle line breaks/punctuation automatically.",
    "When a tool call fails, include the exact error text returned by the tool (verbatim) so it's debuggable; don't replace it with a generic connection message.",
    "Do not try to modify the repo checkout. You may write only under the per-user Workspace root.",
    environmentSummary
  ].join("\n");
}

export type { CodexThreadStartProfile } from "./codex_turn_profile.js";

export function getCodexThreadStartProfileForTest(req: Pick<ChatRequest, "session_id" | "context">): CodexThreadStartProfile {
  return getCodexThreadStartProfile(req, {
    baseInstructions: getOperatorAgentBaseInstructions(),
    developerInstructions: developerInstructions()
  });
}

function truncateForCodex(value: string, maxChars = 1600): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(truncated)`;
}

function summarizeResultJsonForCodex(r: ToolResult): string | null {
  try {
    const compacted = compactIncomingToolResult(r);
    const resultJson = compacted.result_json;
    if (resultJson === undefined) return null;

    const path = (r.path ?? "").trim().toLowerCase();
    const includeJson =
      path === "/revit/export-visible-elements" ||
      path === "/revit/export-view-frame" ||
      path === "/revit/export-view-region" ||
      path === "/revit/pick-candidate-cluster" ||
      path === "/revit/get-placement-context" ||
      path === "/revit/resolve-room-wall" ||
      path === "/revit/project-point-to-host-frame" ||
      path === "/revit/mep-route-workflow" ||
      path === "/revit/mep-branch-network-workflow" ||
      path === "/revit/edit-mep-route-elements" ||
      path === "/revit/reroute-mep-route-segment" ||
      path === "/revit/audit-hosted-instance-placement" ||
      path === "/tools/redline/verify-visual";
    if (!includeJson) return null;

    const raw = JSON.stringify(resultJson);
    if (!raw) return null;
    return truncateForCodex(raw);
  } catch {
    return null;
  }
}

function formatToolResultsForCodex(toolResults: ToolResult[] | undefined): string {
  const list = Array.isArray(toolResults) ? toolResults : [];
  if (list.length === 0) return "";

  const lines: string[] = [];
  lines.push("Tool results (this step):");
  let i = 0;
  for (const r of list) {
    i++;
    if (i > 12) {
      lines.push(`- … (${list.length - 12} more tool results)`);
      break;
    }
    if (!r || typeof r !== "object") continue;
    const head = `- [${i}] ${String(r.status || "").toUpperCase()} ${r.method} ${r.path} (action_id=${r.action_id})`;
    lines.push(head);
    const failureCode = typeof r.failure_code === "string" ? r.failure_code.trim() : "";
    if (failureCode) lines.push(`  - failure_code: ${failureCode}`);

    const atts = Array.isArray(r.attachments) ? r.attachments : [];
    const imgs = atts.filter(a => a && typeof a === "object" && (a as any).kind === "image");
    for (const a of imgs.slice(0, 3)) {
      const p = typeof (a as any).local_path === "string" ? (a as any).local_path.trim() : "";
      const fn = typeof (a as any).filename === "string" ? (a as any).filename.trim() : "";
      const mime = typeof (a as any).mime === "string" ? (a as any).mime.trim() : "";
      if (p) lines.push(`  - image: ${fn || p} (local_path=${p}${mime ? `, mime=${mime}` : ""})`);
      else if (fn) lines.push(`  - image: ${fn}${mime ? ` (mime=${mime})` : ""}`);
    }

    const resultJsonSummary = summarizeResultJsonForCodex(r);
    if (resultJsonSummary) {
      lines.push(`  - result_json: ${resultJsonSummary}`);
    }
  }
  return lines.join("\n");
}

export function getCodexBaseInstructionsForTest(): string {
  return getOperatorAgentBaseInstructions();
}

export function formatToolResultsForCodexForTest(toolResults: ToolResult[] | undefined): string {
  return formatToolResultsForCodex(toolResults);
}

function formatCertifiedCodexContinuation(req: ChatRequest): string {
  return [
    formatCodexRequestEnvelope(req),
    formatToolResultsForCodex(req.tool_results),
    "Continue from the certified context and the recorded pre-dispatch limitation. Provide a terminal evidence answer without requesting tools."
  ].filter(Boolean).join("\n\n");
}

export function formatCertifiedCodexContinuationForTest(req: ChatRequest): string {
  return formatCertifiedCodexContinuation(req);
}

function developerInstructions(): string {
  // Inject repo-shipped docs + runbooks (best-effort, size-limited by getSkillLibraryText()) so Codex can benefit
  // even when sandboxed to Workspace-write (cannot read the repo checkout directly).
  const lib = (getSkillLibraryText() || "").trim();
  const executionRule =
    "Revit execution rule: never issue multiple Revit model calls in one tool batch when a later call depends on an earlier result. Execute one call, inspect its result, then issue the next call only if still needed.";
  if (!lib) return executionRule;
  return [executionRule, "Reference docs (read-only; may be truncated):", lib].join("\n\n");
}

export function getFreshRevitEvidenceRequirement(userText: string): FreshRevitEvidenceRequirement {
  const text = (userText ?? "").toString().trim().toLowerCase();
  if (!text) return { required: false, kind: "none", prompt: "" };

  const sheetCount =
    /\b(?:how\s+many|count|number\s+of|total)\b[^?\n]{0,80}\bsheets?\b/.test(text) ||
    /\bsheets?\b[^?\n]{0,80}\b(?:how\s+many|count|number|total)\b/.test(text);
  if (sheetCount) {
    return {
      required: true,
      kind: "sheet_count",
      prompt:
        "FRESH REVIT EVIDENCE REQUIRED: this turn must successfully call `revit_list_sheets` with `action:\"count\"` and `exact:true` (or call `/revit/sheets` with the same count request). Do not answer from memory, prior turns, a registry lookup, or `/revit/views`."
    };
  }

  const entity = /\b(?:revit|model|project|document|sheet|view|schedule|element|equipment|family|type|instance|room|space|wall|door|window|duct|pipe|tag|parameter|connector|selection)\b/.test(text);
  const liveIntent = /\b(?:how\s+many|count|list|find|show|which|where|inspect|check|verify|change|update|set|create|add|delete|remove|move|rename|print|export|capture|place|route|connect|resize|edit|select|open|current|active)\b/.test(text);
  if (entity && liveIntent) {
    return {
      required: true,
      kind: "revit_tool",
      prompt:
        "FRESH REVIT EVIDENCE REQUIRED: use at least one relevant `revit_operator` tool successfully in this turn before reporting a live-model fact or completion. Do not answer from memory or prior turns."
    };
  }

  return { required: false, kind: "none", prompt: "" };
}

function parseToolArguments(value: unknown): any {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isSuccessfulFreshRevitEvidence(
  requirement: FreshRevitEvidenceRequirement,
  call: { server?: unknown; tool?: unknown; arguments?: unknown; success?: unknown; status?: unknown; error?: unknown }
): boolean {
  if (!requirement.required) return true;
  const server = typeof call.server === "string" ? call.server.trim().toLowerCase().replace(/-/g, "_") : "";
  if (server && server !== "revit_operator") return false;
  const status = typeof call.status === "string" ? call.status.trim().toLowerCase() : "";
  const succeeded = call.success === true || (call.success !== false && !call.error && ["success", "ok", "done", "completed"].includes(status));
  if (!succeeded) return false;
  if (requirement.kind === "revit_tool") return true;

  const tool = typeof call.tool === "string" ? call.tool.trim() : "";
  const args = parseToolArguments(call.arguments);
  if (tool === "revit_list_sheets") {
    return String(args.action ?? "").toLowerCase() === "count" || args.countOnly === true;
  }
  if (tool === "revit_call_tool") {
    const body = parseToolArguments(args.body);
    return String(args.path ?? "").toLowerCase() === "/revit/sheets" && String(body.action ?? "").toLowerCase() === "count";
  }
  return false;
}

function compactDynamicMcpTextForCodex(tool: unknown, rawArguments: unknown, text: string): string {
  if (typeof tool !== "string" || tool.trim() !== "revit_call_tool") return text;
  const args = parseToolArguments(rawArguments);
  const path = typeof args.path === "string" ? args.path.trim().toLowerCase() : "";
  if (path !== "/revit/get-parameters") return text;
  try {
    const parsed = JSON.parse(text);
    const body = parseToolArguments(args.body);
    const requestedNames = Array.isArray(body.names)
      ? body.names.filter((name: unknown): name is string => typeof name === "string" && Boolean(name.trim()))
      : [];
    const requestedElementCount = Array.isArray(body.elementIds) ? body.elementIds.length : 0;
    const maxEvidence = requestedNames.length > 0 && requestedElementCount > 0
      ? Math.max(16, Math.min(100, requestedNames.length * requestedElementCount))
      : 16;
    return JSON.stringify(compactParameterReadResultForPrompt(parsed, {
      maxEvidence,
      maxElementIds: 64,
      preferredParameterNames: requestedNames
    }), null, 2);
  } catch {
    return text;
  }
}

export function adaptMcpToolCallResultToDynamicResponse(
  result: any,
  context?: { tool?: unknown; arguments?: unknown }
): { contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>; success: boolean } {
  const contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> = [];
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      contentItems.push({ type: "inputText", text: compactDynamicMcpTextForCodex(context?.tool, context?.arguments, item.text) });
      continue;
    }
    if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      contentItems.push({ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` });
      continue;
    }
    try {
      contentItems.push({ type: "inputText", text: JSON.stringify(item) });
    } catch {
      contentItems.push({ type: "inputText", text: String(item) });
    }
  }
  if (contentItems.length === 0 && result?.structuredContent !== undefined) {
    const text = JSON.stringify(result.structuredContent);
    contentItems.push({ type: "inputText", text: compactDynamicMcpTextForCodex(context?.tool, context?.arguments, text) });
  }
  if (contentItems.length === 0) contentItems.push({ type: "inputText", text: result?.isError ? "MCP tool failed without an error body." : "MCP tool completed without output." });
  return { contentItems, success: result?.isError !== true };
}

export async function handleCodexServerRequest(runtime: CodexMcpToolRuntime, request: CodexServerRequest): Promise<unknown> {
  if (request.method === "item/tool/call") {
    const params = request.params ?? {};
    const interruptedAssignment = findInterruptedAutoGoalForSession(teammateLoopSessionIdForOwner(runtime, params.turnId));
    if (interruptedAssignment) {
      return {
        contentItems: [{
          type: "inputText",
          text: `[assignment_${interruptedAssignment.status}] Assignment ${interruptedAssignment.id} is ${interruptedAssignment.status}; no further tool dispatch is allowed until it is explicitly resumed.`
        }],
        success: false
      };
    }
    const namespace = typeof params.namespace === "string" ? params.namespace : "";
    if (namespace !== "revit_operator" && !namespace.startsWith("mcp__")) {
      return { contentItems: [{ type: "inputText", text: `Unsupported dynamic tool namespace: ${namespace || "(none)"}` }], success: false };
    }
    const server = namespace === "revit_operator" ? namespace : namespace.slice("mcp__".length);
    if (server !== "revit_operator") {
      return { contentItems: [{ type: "inputText", text: `Unsupported MCP server namespace: ${namespace}` }], success: false };
    }
    const quarantine = findActiveToolQuarantine(params.tool, params.arguments);
    if (quarantine) {
      const label = quarantine.method && quarantine.path ? `${quarantine.method} ${quarantine.path}` : quarantine.tool ?? "tool";
      return {
        contentItems: [{
          type: "inputText",
          text: `[revit_tool_quarantined] ${label} is retained but unavailable for autonomous execution: ${quarantine.reason}. Inspect current tool docs/evidence and use another primitive or clear the quarantine after a regression-tested repair.`
        }],
        success: false
      };
    }
    const lease = revitToolParallelGuard.tryAcquire(params);
    if (!lease.accepted) {
      return { contentItems: [{ type: "inputText", text: lease.message ?? "Concurrent dependent Revit call blocked." }], success: false };
    }
    const teammateGate = guardTeammateMcpCall(runtime, params);
    if (!teammateGate.allowed) {
      lease.release();
      return { contentItems: [{ type: "inputText", text: teammateGate.message ?? "Host teammate-loop guard blocked this Revit call." }], success: false };
    }
    try {
      const rawResult = await runtime.callTool(params.tool, params.arguments ?? {});
      recordTeammateMcpResult(runtime, teammateGate, rawResult);
      const result = params.tool === "revit_search_tools" ? filterQuarantinedToolSearchResult(rawResult) : rawResult;
      return adaptMcpToolCallResultToDynamicResponse(result, { tool: params.tool, arguments: params.arguments });
    } catch (error) {
      recordTeammateMcpResult(runtime, teammateGate, { isError: true });
      return {
        contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
        success: false
      };
    } finally {
      lease.release();
    }
  }
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/tool/requestUserInput") return { answers: {} };
  if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  throw new Error(`Unsupported Codex server request: ${request.method}`);
}

export async function handleCertifiedCodexServerRequest(request: CodexServerRequest): Promise<unknown> {
  const method = request.method.toLowerCase();
  if (/(?:^|\/)(?:dynamic)?tool\/call$/.test(method) || (method.startsWith("mcp") && request.method !== "mcpServer/elicitation/request")) {
    return { contentItems: [{ type: "inputText", text: "Certified direct mode does not permit dynamic, MCP, or Revit tool execution." }], success: false };
  }
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/tool/requestUserInput") return { answers: {} };
  if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  throw new Error(`Unsupported certified Codex server request: ${request.method}`);
}

function clientCacheKey(workspaceRoot: string, profile: CodexThreadStartProfile): string {
  return `${workspaceRoot}\u0000${profile.profileNamespace}`;
}

async function getClient(workspaceRoot: string, profile: CodexThreadStartProfile): Promise<CodexAppServer> {
  const cacheKey = clientCacheKey(workspaceRoot, profile);
  const existing = clientsByProfile.get(cacheKey);
  if (existing) return existing;
  const { codexHome, cwd } = getCodexProfilePaths(workspaceRoot, profile);
  const spawnEnv = buildCodexSpawnEnv(workspaceRoot);
  let mcpRuntime: CodexMcpToolRuntime | undefined;
  if (!profile.certified) {
    mcpRuntime = mcpRuntimesByWorkspace.get(workspaceRoot);
    if (!mcpRuntime) {
      mcpRuntime = new CodexMcpToolRuntime({
        backendCwd: process.cwd(),
        workspaceRoot,
        codexHome,
        spawnEnv
      });
      mcpRuntimesByWorkspace.set(workspaceRoot, mcpRuntime);
    }
  }

  const client = new CodexAppServer({
    cwd,
    codexHome,
    spawnEnv
  });
  client.setServerRequestHandler(async request => profile.certified
    ? await handleCertifiedCodexServerRequest(request)
    : await handleCodexServerRequest(mcpRuntime!, request));
  clientsByProfile.set(cacheKey, client);
  try {
    await client.ensureStarted();
    if (profile.certified) assertCertifiedMcpServerStatus(await client.request("mcpServerStatus/list", {
      cursor: null,
      limit: 100,
      detail: "toolsAndAuthOnly",
    }));
  } catch (error) {
    if (clientsByProfile.get(cacheKey) === client) clientsByProfile.delete(cacheKey);
    client.stop();
    throw error;
  }

  // Ensure MCP server config is reloaded at least once on startup.
  if (!profile.certified) {
    try {
      await client.request("config/mcpServer/reload", undefined);
    } catch {
      // best effort; some codex versions may not expose this method
    }
  }

  return client;
}

function isTransportClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /transport closed/i.test(msg) || /app-server exited/i.test(msg) || /ECONNRESET/i.test(msg);
}

async function withTransportRetry<T>(workspaceRoot: string, profile: CodexThreadStartProfile, fn: (client: CodexAppServer) => Promise<T>): Promise<T> {
  const cacheKey = clientCacheKey(workspaceRoot, profile);
  let client = await getClient(workspaceRoot, profile);
  try {
    return await fn(client);
  } catch (err) {
    if (!isTransportClosedError(err)) throw err;
    // Best-effort: restart the app-server connection once and retry.
    if (clientsByProfile.get(cacheKey) === client) clientsByProfile.delete(cacheKey);
    client.stop();
    client = await getClient(workspaceRoot, profile);
    // Touch the connection to ensure it's alive.
    try {
      await client.request("initialize", {
        clientInfo: { name: "revit-operator-backend", title: "Revit Operator Backend", version: "0.0.0" },
        capabilities: { experimentalApi: true }
      });
    } catch {
      // ignore; getClient already initialized once in most cases
    }
    return await fn(client);
  }
}

export async function warmCodexAppServer(): Promise<void> {
  await getClient(getWorkspaceRoot(), getCodexThreadStartProfileForTest({ session_id: "warm", context: {} }));
}

export function getCodexAppServerCompatibility(): { version: ReturnType<CodexAppServer["getCompatibilityReceipt"]>["version"]; initialized: boolean } | null {
  const profile = getCodexThreadStartProfileForTest({ session_id: "compatibility", context: {} });
  const receipt = clientsByProfile.get(clientCacheKey(getWorkspaceRoot(), profile))?.getCompatibilityReceipt();
  return receipt ? { version: receipt.version, initialized: receipt.initialize_response !== null } : null;
}

async function getOrCreateThreadId(req: ChatRequest, client: CodexAppServer, workspaceRoot: string): Promise<string> {
  const profile = getCodexThreadStartProfileForTest(req);
  const existing = getCodexThreadId(profile.threadKey);
  if (existing) return existing;

  const dynamicTools: unknown[] = [];
  if (profile.dynamicToolMode === "revit_runtime") {
    const runtime = mcpRuntimesByWorkspace.get(workspaceRoot);
    if (!runtime) throw new Error("Revit Operator MCP runtime is not configured for this workspace.");
    dynamicTools.push(await runtime.getDynamicToolNamespace());
  }
  const resp = (await client.request("thread/start", {
    cwd: getCodexProfilePaths(workspaceRoot, profile).cwd,
    sandbox: profile.sandbox,
    approvalPolicy: profile.approvalPolicy,
    model: getDefaultModel(),
    baseInstructions: profile.baseInstructions,
    developerInstructions: profile.developerInstructions,
    dynamicTools,
    experimentalRawEvents: false
  })) as any;

  const threadId = typeof resp?.thread?.id === "string" ? resp.thread.id : typeof resp?.threadId === "string" ? resp.threadId : "";
  if (!threadId) throw new Error("Codex thread/start did not return a thread id.");

  try {
    // Subscribe to this thread's notifications (required for streaming on some app-server builds).
    await client.request("addConversationListener", { conversationId: threadId, experimentalRawEvents: false });
  } catch {
    // ignore; not required on all builds
  }

  setCodexThreadId(profile.threadKey, threadId);
  try {
    appendEvent(req.session_id, "assistant", "codex.thread.start", profile.certified ? { thread_id: threadId, certified: true } : { thread_id: threadId });
  } catch {
    // ignore
  }
  return threadId;
}

export async function decideCodex(req: ChatRequest): Promise<ChatResponse> {
  const chunks: string[] = [];
  const resp = await decideCodexStreaming(req, { onDelta: d => chunks.push(d) });
  return { ...resp, assistant_message: resp.assistant_message || chunks.join("") };
}

export async function decideCodexStreaming(req: ChatRequest, cb: StreamCallbacks): Promise<ChatResponse> {
  const threadProfile = getCodexThreadStartProfileForTest(req);
  const certifiedDirect = threadProfile.certified;
  let courierTarget: ReturnType<typeof revitCourierTargetFromContext> | undefined;
  if (!certifiedDirect) {
    try {
      courierTarget = revitCourierTargetFromContext(req.context);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : String(error)} I stopped before planning or Revit tool actions.`;
      cb.onDone?.(message);
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [] };
    }
  }
  const workspaceRoot = getWorkspaceRoot();
  let c = await getClient(workspaceRoot, threadProfile);
  let threadId = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
    c = activeClient;
    return await getOrCreateThreadId(req, activeClient, workspaceRoot);
  });

  // Some app-server builds require a conversation listener for streaming notifications;
  // re-assert it each turn (best-effort) to avoid "Transport closed" / silent streams.
  try {
    await c.request("addConversationListener", { conversationId: threadId, experimentalRawEvents: false });
  } catch {
    // ignore
  }

  const text = (req.user_text ?? "").toString();
  const freshEvidenceRequirement = certifiedDirect ? { required: false, kind: "none" as const, prompt: "" } : getFreshRevitEvidenceRequirement(text);
  let memBlock = "";
  let projectProfileBlock = "";
  let requirementsBlock = "";
  let requirementsReceipt: RequirementsReceipt | null = null;
  let requirementsError = "";
  const allowUnscopedLegacyMemory = !certifiedDirect && mayInjectUnscopedLegacyMemory(req.context);
  try {
    projectProfileBlock = allowUnscopedLegacyMemory ? formatProjectProfileForPrompt() : "";
  } catch {
    projectProfileBlock = "";
  }
  if (!certifiedDirect) {
    try {
      requirementsReceipt = resolveRequirementsForChat(req);
      requirementsBlock = formatRequirementsForPrompt(requirementsReceipt);
    } catch (error) {
      requirementsReceipt = null;
      requirementsBlock = "";
      requirementsError = error instanceof Error ? error.message : String(error);
    }
  }
  if (requirementsError) {
    const message = `Durable requirements could not be read safely (${requirementsError}). I stopped before planning or tool actions.`;
    cb.onDone?.(message);
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [] };
  }
  if (requirementsReceipt && requirementsReceipt.status !== "resolved") {
    const message = `Durable requirements are ${requirementsReceipt.status}. I stopped before planning or tool actions; resolve or narrow the attached receipt first.`;
    cb.onDone?.(message);
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [], requirements_receipt: requirementsReceipt };
  }
  try {
    const query = text.trim() || (getPinnedGoal(req.session_id) ?? "") || "";
    const mem = allowUnscopedLegacyMemory && !freshEvidenceRequirement.required && query
      ? retrieveMemoryContext({ queryText: query, maxEntries: 6 })
      : [];
    if (mem.length > 0) {
      const lines: string[] = [];
      let i = 0;
      for (const m of mem) {
        i++;
        lines.push(`[M${i}] (${m.scope}/${m.kind}) ${m.text}`);
      }
      memBlock = lines.join("\n");
    }
  } catch {
    memBlock = "";
  }
  let activeGoalBlock = "";
  try {
    activeGoalBlock = formatActiveGoalContext(getActiveGoalForSession(req.session_id));
  } catch {
    activeGoalBlock = "";
  }
  const input = text.trim()
    ? [
        {
          type: "text",
          text: (() => {
            const blocks: string[] = [];
            if (!certifiedDirect && activeGoalBlock) blocks.push(activeGoalBlock);
            if (projectProfileBlock) blocks.push(projectProfileBlock);
            if (requirementsBlock) blocks.push(requirementsBlock);
            if (!certifiedDirect) {
              try {
                blocks.push(formatEnvironmentSummaryForPrompt());
              } catch {}
              try {
                const contractMemory = formatRevitToolContractMemoryForPrompt();
                if (contractMemory) blocks.push(contractMemory);
              } catch {}
            }
            if (freshEvidenceRequirement.prompt) blocks.push(freshEvidenceRequirement.prompt);
            if (memBlock) blocks.push(`MEMORY CONTEXT (read-only):\n${memBlock}`);
            if (!certifiedDirect) {
              try {
                const perms = formatCodexPermissionSummary(req.context);
                if (perms) {
                  const prev = lastPermissionSignatureBySession.get(req.session_id) || "";
                  lastPermissionSignatureBySession.set(req.session_id, perms.signature);
                  if (prev && prev !== perms.signature) blocks.push(`PERMISSION UPDATE (changed since last message):\n${perms.summary}`);
                  else blocks.push(perms.summary);
                }
              } catch {}
            }
            const requestEnvelope = formatCodexRequestEnvelope(req);
            if (requestEnvelope) blocks.push(requestEnvelope);
            if (text.trim()) blocks.push(`USER:\n${text}`);
            const tr = formatToolResultsForCodex(req.tool_results as any);
            if (tr) blocks.push(tr);
            return blocks.join("\n\n");
          })(),
          text_elements: [] as any[]
        }
      ]
    : certifiedDirect
      ? [{ type: "text", text: formatCertifiedCodexContinuation(req), text_elements: [] as any[] }]
      // If the client sends an empty user_text (legacy tool-loop continuation), still nudge Codex.
      : [{ type: "text", text: [activeGoalBlock, requirementsBlock, "(continue)"].filter(Boolean).join("\n\n"), text_elements: [] as any[] }];

  let requirementsLease: ReturnType<typeof beginRequirementsPlanningLease> | null = null;
  if (requirementsReceipt) {
    try {
      const plannedReceiptSha256 = requirementsReceipt.receipt_sha256;
      requirementsLease = beginRequirementsPlanningLease(plannedReceiptSha256, codexTurnTimeoutMs() + 60_000);
      const leasedReceipt = resolveRequirementsForChat(req);
      if (leasedReceipt.status !== "resolved" || leasedReceipt.receipt_sha256 !== plannedReceiptSha256) {
        endRequirementsPlanningLease(requirementsLease);
        requirementsLease = null;
        const message = leasedReceipt.status === "resolved"
          ? "Durable requirements changed while the planning lease was being acquired. I stopped before tool actions; re-run the request against the attached current receipt."
          : `Durable requirements became ${leasedReceipt.status} while the planning lease was being acquired. I stopped before tool actions; resolve or narrow the attached receipt first.`;
        cb.onDone?.(message);
        return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [], requirements_receipt: leasedReceipt };
      }
      requirementsReceipt = leasedReceipt;
    } catch (error) {
      endRequirementsPlanningLease(requirementsLease);
      requirementsLease = null;
      const message = `Durable requirements could not be leased and revalidated safely (${error instanceof Error ? error.message : String(error)}). I stopped before planning or tool actions.`;
      cb.onDone?.(message);
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [], requirements_receipt: requirementsReceipt };
    }
  }
  const mcpRuntime = threadProfile.startRevitTurnRuntime ? mcpRuntimesByWorkspace.get(workspaceRoot) : null;
  if (threadProfile.startRevitTurnRuntime && !mcpRuntime) throw new Error("Revit Operator MCP runtime is not configured for this workspace.");
  let teammateContext: ReturnType<typeof beginTeammateLoopOwner> | null = null;
  let teammateReceipt: ReturnType<typeof teammateLoopReceiptForLease> | undefined;
  let courierContext: ReturnType<typeof beginRevitCourierTurnContext> = null;
  let start: any;
  try {
    if (threadProfile.startRevitTurnRuntime) {
      teammateContext = beginTeammateLoopOwner(mcpRuntime!, req);
      courierContext = beginRevitCourierTurnContext({
        session_id: req.session_id,
        message_id: req.message_id,
        ttl_ms: codexTurnTimeoutMs() + 60_000,
        ...courierTarget!
      });
    }
    try {
      start = (await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        return await activeClient.request("turn/start", { threadId, input });
      })) as any;
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
      setCodexThreadId(threadProfile.threadKey, "");
      threadId = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        return await getOrCreateThreadId(req, activeClient, workspaceRoot);
      });
      start = (await c.request("turn/start", { threadId, input })) as any;
    }
  } catch (error) {
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
    endRequirementsPlanningLease(requirementsLease);
    throw error;
  }

  const turnId = typeof start?.turn?.id === "string" ? start.turn.id : "";
  if (!turnId) {
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
    endRequirementsPlanningLease(requirementsLease);
    throw new Error("Codex turn/start did not return a turn id.");
  }
  if (teammateContext) bindTeammateLoopOwnerTurn(teammateContext, turnId);
  try {
    appendEvent(req.session_id, "assistant", "codex.turn.start", { thread_id: threadId, turn_id: turnId });
  } catch {
    // ignore
  }

  let assistantText = "";
  let assistantDeltas = "";
  let hasFreshRevitEvidence = !freshEvidenceRequirement.required;
  const assignmentObserver = createAutoGoalTurnObserver(req.session_id);

  const unsubscribe = c.onNotification(n => {
    try {
      if (!n || n.threadId !== threadId) return;
      if (n.method === "item/agentMessage/delta") {
        if (n.params?.turnId !== turnId) return;
        const delta = typeof n.params?.delta === "string" ? n.params.delta : "";
        if (delta) {
          assistantDeltas += delta;
          if (!freshEvidenceRequirement.required) cb.onDelta?.(delta);
        }
      }

      if (n.method === "item/completed") {
        if (n.params?.turnId !== turnId) return;
        const item = n.params?.item;
        if (item?.type === "agentMessage") {
          const full = typeof item.text === "string" ? item.text : "";
          if (full) assistantText = full;
        }
        const dynamicTool = adaptDynamicToolCompletedItem(item);
        if (dynamicTool) {
          assignmentObserver.observe(dynamicTool);
          if (isSuccessfulFreshRevitEvidence(freshEvidenceRequirement, dynamicTool)) hasFreshRevitEvidence = true;
          try {
            recordRevitToolOutcome({
              sessionId: req.session_id,
              threadId,
              turnId,
              tool: dynamicTool.tool,
              arguments: dynamicTool.arguments,
              success: dynamicTool.success,
              error: dynamicTool.error
            });
          } catch {
            // contract memory is best-effort and must never interrupt the active turn
          }
          try {
            appendEvent(req.session_id, "tool", "codex.dynamicToolCall", {
              thread_id: threadId,
              turn_id: turnId,
              ...dynamicTool
            });
          } catch {
            // ignore
          }
          try {
            const ts = new Date().toISOString();
            persistence.appendToolCall(req.session_id, {
              ts,
              kind: "mcp.tool_call",
              session_id: req.session_id,
              tool: dynamicTool.tool,
              server: dynamicTool.server,
              arguments: dynamicTool.arguments,
              status: dynamicTool.status,
              duration_ms: dynamicTool.duration_ms,
              thread_id: threadId,
              turn_id: turnId
            });
            persistence.appendToolOutput(req.session_id, {
              ts,
              kind: "mcp.tool_result",
              session_id: req.session_id,
              tool: dynamicTool.tool,
              server: dynamicTool.server,
              status: dynamicTool.status,
              duration_ms: dynamicTool.duration_ms,
              result: dynamicTool.result,
              error: dynamicTool.error,
              thread_id: threadId,
              turn_id: turnId
            });
          } catch {
            // ignore
          }
          if (shouldNotifyCodexToolCalls()) {
            try {
              const slow = dynamicTool.duration_ms !== null && dynamicTool.duration_ms >= toolNotifyThresholdMs();
              const summary = dynamicTool.error
                ? `Tool ${dynamicTool.tool}: ${dynamicTool.error}`
                : `Tool ${dynamicTool.tool} completed${dynamicTool.duration_ms !== null ? ` (ms=${Math.round(dynamicTool.duration_ms)}${slow ? ", slow=true" : ""})` : ""}.`;
              appendNotification(req.session_id, "codex.tool_call", summary, {
                server: dynamicTool.server,
                tool: dynamicTool.tool,
                status: dynamicTool.status,
                duration_ms: dynamicTool.duration_ms,
                error: dynamicTool.error,
                arguments: dynamicTool.arguments,
                result: dynamicTool.result,
                slow: slow || null
              });
            } catch {
              // ignore
            }
          }
        }
        if (item?.type === "mcpToolCall") {
          const mcpStatus = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
          const mcpError = typeof item.error === "string" ? item.error.trim() : "";
          assignmentObserver.observe({
            server: typeof item.server === "string" ? item.server : null,
            tool: typeof item.tool === "string" ? item.tool : "mcp_tool",
            success: mcpError ? false : mcpStatus ? ["success", "ok", "done", "completed"].includes(mcpStatus) : null,
            status: mcpStatus || null,
            error: mcpError || null,
            duration_ms: typeof item.durationMs === "number" ? item.durationMs : null, arguments: item.arguments ?? null, result: item.result ?? item.content ?? item.contentItems ?? null
          });
          if (isSuccessfulFreshRevitEvidence(freshEvidenceRequirement, {
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            status: item.status,
            error: item.error
          })) hasFreshRevitEvidence = true;
          try {
            const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
            const error = typeof item.error === "string" ? item.error : null;
            const success = error
              ? false
              : status
                ? ["success", "ok", "done", "completed"].includes(status)
                : undefined;
            recordRevitToolOutcome({
              sessionId: req.session_id,
              threadId,
              turnId,
              tool: item.tool,
              arguments: item.arguments,
              success,
              error
            });
          } catch {
            // contract memory is best-effort and must never interrupt the active turn
          }
          try {
            appendEvent(req.session_id, "tool", "codex.mcpToolCall", {
              thread_id: threadId,
              turn_id: turnId,
              server: item.server,
              tool: item.tool,
              status: item.status,
              arguments: item.arguments,
              duration_ms: item.durationMs ?? null,
              result: item.result ?? null,
              error: item.error ?? null
            });
          } catch {
            // ignore
          }

          // Phase 1 journaling: write tool call + tool output to the run bundle JSONL tape.
          try {
            const ts = new Date().toISOString();
            persistence.appendToolCall(req.session_id, {
              ts,
              kind: "mcp.tool_call",
              session_id: req.session_id,
              tool: item.tool ?? "tool",
              server: item.server ?? null,
              arguments: item.arguments ?? null,
              status: item.status ?? null,
              duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
              thread_id: threadId,
              turn_id: turnId
            });
            persistence.appendToolOutput(req.session_id, {
              ts,
              kind: "mcp.tool_result",
              session_id: req.session_id,
              tool: item.tool ?? "tool",
              server: item.server ?? null,
              status: item.status ?? null,
              duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
              result: item.result ?? null,
              error: typeof item.error === "string" ? item.error : null,
              thread_id: threadId,
              turn_id: turnId
            });
          } catch {
            // ignore
          }

          // Web research: always surface "saved evidence" via /notifications (not just slow/fail).
          try {
            if (typeof item.tool === "string" && item.tool.trim() === "web_fetch_evidence") {
              const status = typeof item.status === "string" ? item.status : "";
              const ok = status === "success" || status === "ok" || status === "done";
              appendNotification(req.session_id, "web.research.saved", ok ? "Saved web evidence (see tool output for paths)." : "Web evidence fetch failed (see tool output).", {
                tool: item.tool,
                status: item.status ?? null
              });
            }
          } catch {
            // ignore
          }

          if (shouldNotifyCodexToolCalls()) {
            try {
              const status = typeof item.status === "string" ? item.status : "";
              const durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
              const err = typeof item.error === "string" ? item.error.trim() : "";
              const tool = typeof item.tool === "string" ? item.tool.trim() : "tool";
              const statusNorm = status.toLowerCase();
              const ok = statusNorm === "success" || statusNorm === "ok" || statusNorm === "done";
              const slow = durationMs !== null && durationMs >= toolNotifyThresholdMs();
              const payload = {
                server: item.server ?? null,
                tool: item.tool ?? null,
                status: item.status ?? null,
                duration_ms: durationMs,
                error: err || null,
                arguments: item.arguments ?? null,
                result: item.result ?? null,
                slow: slow || null
              };
              const suffix = [
                status ? `status=${status}` : null,
                durationMs !== null ? `ms=${Math.round(durationMs)}` : null,
                slow ? "slow=true" : null
              ]
                .filter(Boolean)
                .join(", ");
              const summary = err
                ? `Tool ${tool}: ${err}`
                : `Tool ${tool} ${ok ? "completed" : "finished"}${suffix ? ` (${suffix})` : ""}.`;
              appendNotification(req.session_id, "codex.tool_call", summary, payload);
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore per notification
    }
  });

  const activeTurnAbort = new AbortController();
  const activeTurnKey = codexTurnAbortKey(req.session_id, req.message_id);
  const priorActiveTurn = activeCodexTurnAborts.get(activeTurnKey);
  if (priorActiveTurn) priorActiveTurn.abort();
  activeCodexTurnAborts.set(activeTurnKey, activeTurnAbort);
  const forwardExternalAbort = () => activeTurnAbort.abort();
  cb.abortSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  let turnCancelled = false;
  try {
    await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
      c = activeClient;
      return await activeClient.waitForTurnCompleted({
        threadId,
        turnId,
        timeoutMs: codexTurnTimeoutMs(),
        abortSignal: activeTurnAbort.signal
      });
    });
  } catch (error) {
    if (!activeTurnAbort.signal.aborted) throw error;
    turnCancelled = true;
  } finally {
    unsubscribe();
    cb.abortSignal?.removeEventListener("abort", forwardExternalAbort);
    if (activeCodexTurnAborts.get(activeTurnKey) === activeTurnAbort) {
      activeCodexTurnAborts.delete(activeTurnKey);
    }
    endRequirementsPlanningLease(requirementsLease);
    teammateReceipt = teammateContext ? teammateLoopReceiptForLease(teammateContext) : undefined;
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
  }

  if (turnCancelled) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "",
      actions: [],
      ...(teammateReceipt ? { teammate_loop_receipt: teammateReceipt } : {})
    };
  }

  assistantText = assistantText || assistantDeltas;
  teammateReceipt = reconcileTeammateReceiptWithAssistant(teammateReceipt, assistantText);
  if (teammateReceipt && teammateReceipt.apply_attempts > 0 && !teammateReceipt.verified) {
    teammateReceipt = {
      ...teammateReceipt,
      stage: "blocked",
      blocked_reason: teammateReceipt.blocked_reason || "post_apply_verification_required"
    };
    assistantText = `${assistantText}\n\nI cannot claim the Revit change is complete because the host did not receive a successful post-apply readback or focused capture. The apply was not retried.`.trim();
  }
  if (freshEvidenceRequirement.required && !hasFreshRevitEvidence) {
    assistantText = FRESH_REVIT_EVIDENCE_FAILURE;
    try {
      appendEvent(req.session_id, "assistant", "codex.fresh_revit_evidence.missing", {
        thread_id: threadId,
        turn_id: turnId,
        requirement: freshEvidenceRequirement.kind
      });
    } catch {
      // ignore
    }
  } else if (freshEvidenceRequirement.required) {
    try {
      appendEvent(req.session_id, "assistant", "codex.fresh_revit_evidence.satisfied", {
        thread_id: threadId,
        turn_id: turnId,
        requirement: freshEvidenceRequirement.kind
      });
    } catch {
      // ignore
    }
  }
  if (freshEvidenceRequirement.required && assistantText) cb.onDelta?.(assistantText);
  cb.onDone?.(assistantText);
  assignmentObserver.finish(turnId, assistantText, teammateReceipt);
  try {
    appendEvent(req.session_id, "assistant", "codex.turn.completed", {
      thread_id: threadId,
      turn_id: turnId,
      assistant_chars: (assistantText || "").length
    });
  } catch {
    // ignore
  }

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: assistantText || "",
    actions: [],
    ...(teammateReceipt ? { teammate_loop_receipt: teammateReceipt } : {}),
    ...(requirementsReceipt && (requirementsReceipt.status !== "resolved" || requirementsReceipt.applied.length > 0) ? { requirements_receipt: requirementsReceipt } : {})
  };
}
