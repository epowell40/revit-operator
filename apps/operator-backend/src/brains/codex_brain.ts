import path from "node:path";
import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { appendEvent, setCodexThreadId } from "../memory/sqlite_store.js";
import { CodexAppServer, type CodexNotificationEnvelope, type CodexServerRequest } from "../codex/app_server.js";
import type { UserInput } from "../codex/generated/app_server_0_149_0/v2/UserInput.js";
import { ensureCodexHomeAuth, ensureCodexHomeConfig, prepareCertifiedCodexIsolation } from "../codex/config.js";
import { CodexMcpToolRuntime } from "../codex/mcp_tool_runtime.js";
import { resolveCodexTurnTimeoutMs } from "../codex/timeout_policy.js";
import { formatRevitToolContractMemoryForPrompt } from "../codex/revit_tool_contract_memory.js";
import { beginRevitCourierTurnContext, endRevitCourierTurnContext } from "../courier/revit_courier_context.js";
import { revitCourierTargetFromContext } from "../courier/revit_courier_target.js";
import { getSkillLibraryText } from "../skills/skill_library.js";
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
import { formatActiveGoalContext, getActiveGoalForSession, getGoal } from "../goals/service.js";
import { createAutoGoalTurnObserver } from "../goals/auto_goal_runtime.js";
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
  reconcileTeammateReceiptWithAssistant,
  teammateLoopReceiptForLease
} from "../teammate_loop_runtime.js";
import { adaptDynamicToolCompletedItem, isMissingCodexThreadError } from "./codex_tool_observation.js";
import { enforceAuthoritativeWebEvidence, getAuthoritativeWebEvidenceRequirement } from "./authoritative_web_evidence.js";
import { FRESH_REVIT_EVIDENCE_FAILURE, getFreshRevitEvidenceRequirement } from "./revit_turn_evidence.js";
import { resolveAgentModelSettings } from "../speed_config.js";
import { codexTelemetryThreadKey, createCodexTurnModelTelemetry } from "./codex_turn_model_telemetry.js";
import { assignmentModelReceiptObserver } from "../assignments/model_call_budget.js";
import { createAssignmentKernelV2ModelReceiptRecorder } from "../assignments/assignment_kernel_v2_provider_budget.js";
import {
  classifyAssignmentKernelExecutionFailureV2,
  settleAssignmentKernelExecutionFailureV2
} from "../assignments/assignment_kernel_v2_execution_failure.js";
import { getOrCreateCodexThread } from "./codex_thread_lifecycle.js";
import { awaitAssignmentQuiescence, cancelAssignmentInFlight, requestAssignmentTerminal } from "../assignments/settlement_barrier.js";
import { settleAssignmentTurn } from "../assignments/turn_settlement.js";
import { handleCodexDynamicToolCall } from "./codex_dynamic_tool_handler.js";
import { getRequestOperatorBackendAuth } from "../request_context.js";
import type { AssignmentKernelTurnLeaseV2, OperatorBackendAuthLease } from "../codex/mcp_tool_runtime.js";
import { canonicalAssignmentOutcomeForBinding } from "../assignments/outcome_handoff.js";
import { assignmentKernelV2ForBinding } from "../assignments/assignment_kernel_v2_factory.js";
import { recoverAssignmentKernelOperationsV2 } from "../assignments/assignment_kernel_v2_execution.js";
import { deriveTerminalResultV2 } from "../assignments/assignment_kernel_v2_terminal_result.js";
import {
  beginAssignmentKernelTerminalBarrierV2,
  endAssignmentKernelTerminalBarrierV2,
  type AssignmentKernelTerminalBarrierLeaseV2
} from "../assignments/assignment_kernel_v2_terminal_barrier.js";
import {
  checkpointCodexAssignmentProgressV2,
  codexAssignmentControllerStopMessage,
  currentCodexAssignmentSnapshotV2,
  finalCodexAssignmentMessageV2,
  prepareCodexAssignmentProgressV2,
  settleCodexAssignmentProgressV2
} from "./codex_assignment_progress.js";
import { formatToolResultsForCodex } from "./codex_tool_result_formatting.js";
import { createCodexTurnNotificationObserver } from "./codex_turn_notification_observer.js";

export type StreamCallbacks = {
  onDelta?: (textDelta: string) => void;
  onDone?: (fullText: string) => void;
  abortSignal?: AbortSignal;
};

export { getFreshRevitEvidenceRequirement, isSuccessfulFreshRevitEvidence } from "./revit_turn_evidence.js";

const clientsByProfile = new Map<string, CodexAppServer>();
const mcpRuntimesByWorkspace = new Map<string, CodexMcpToolRuntime>();
const lastPermissionSignatureBySession = new Map<string, string>();
type ActiveCodexTurn = {
  abortController: AbortController;
  interruptRequested: boolean;
  interruptPromise: Promise<void> | null;
  interrupt: () => Promise<void>;
};
const activeCodexTurns = new Map<string, ActiveCodexTurn>();

export { revitCourierTargetFromContext } from "../courier/revit_courier_target.js";
export { formatCodexRequestEnvelope } from "./codex_turn_profile.js";
export { adaptDynamicToolCompletedItem, isMissingCodexThreadError } from "./codex_tool_observation.js";
export { adaptMcpToolCallResultToDynamicResponse } from "./codex_dynamic_result_adapter.js";
export { assertCertifiedMcpServerStatus };

function codexTurnAbortKey(sessionId: string, messageId: string): string {
  return `${sessionId.trim()}:${messageId.trim()}`;
}

function requestActiveCodexTurnInterrupt(active: ActiveCodexTurn): Promise<void> {
  if (active.interruptPromise) return active.interruptPromise;
  active.interruptRequested = true;
  active.interruptPromise = active.interrupt().catch(error => {
    active.abortController.abort();
    throw error;
  });
  return active.interruptPromise;
}

export function cancelCodexBrainTurn(sessionId: string, messageId: string): boolean {
  const key = codexTurnAbortKey(sessionId, messageId);
  const active = activeCodexTurns.get(key);
  if (!active) return false;
  void requestActiveCodexTurnInterrupt(active).catch(() => {});
  return true;
}

export function __testOnlyTrackCodexBrainTurnAbort(
  sessionId: string,
  messageId: string
): { signal: AbortSignal; interruptionRequested: () => boolean; waitForInterrupt: () => Promise<void>; cleanup: () => void } {
  const key = codexTurnAbortKey(sessionId, messageId);
  const abortController = new AbortController();
  const active: ActiveCodexTurn = {
    abortController,
    interruptRequested: false,
    interruptPromise: null,
    interrupt: async () => {}
  };
  activeCodexTurns.set(key, active);
  return {
    signal: abortController.signal,
    interruptionRequested: () => active.interruptRequested,
    waitForInterrupt: () => active.interruptPromise ?? Promise.resolve(),
    cleanup: () => {
      if (activeCodexTurns.get(key) === active) {
        activeCodexTurns.delete(key);
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
    "Success: use safe executable paths, preserve intent, verify writes/files with fresh evidence, and name exact blockers plus the next check.",
    "V2 completion: call `operator_evaluate_assignment_criteria` with criterion/Observation IDs; request missing input with `operator_request_assignment_input` and stable variable IDs. The host supplies lifecycle binding. V1 uses legacy tools.",
    "After any Revit apply succeeds, the very next Revit action must be a target-bound readback, regenerate/capture, or other non-mutating verification of that exact apply. Do not search for tools, request tool docs, preview a correction, or start another apply until the first apply is verified. If a correction is needed, verify the first committed state before beginning the next bounded preview/apply stage.",
    "Bound capability discovery within a turn: reuse a known typed tool or previously documented route; search once for an operation only when no known route fits; request one tool schema only after an argument-shape rejection; and do not repeat synonymous searches or rediscover a route already returned in the same turn. Preserve successful route and schema results as working memory for later steps.",
    "Authoritative complete inventory: cite counts, evaluate the bound criteria from retained observations, and do not recount.",
    ...AGENT_RESPONSE_STYLE_LINES,
    "Use markdown (short headings/bullets/code blocks when helpful) for readable Operator answers.",
    "Users will talk naturally (e.g., \"update the MEP engineers on the cover sheet to WSP\"). Infer the missing details by calling read-only tools first (resolve the sheet, locate the titleblock, inspect candidates). Do not ask the user for exact tool names or brittle JSON unless absolutely required.",
    "Web research: if enabled by the host, use `web_fetch_evidence` to fetch public URLs. When the user asks for authoritative, current, latest, or version-specific external documentation, you must fetch the primary-source page before answering; a plausible URL or remembered claim is not research evidence. It writes evidence under Workspace/evidence/web/** (meta + snapshot + extracted text). Cite only fetched sources and include their evidence paths; if paywalled/blocked, ask the user to provide the relevant excerpt/PDF.",
    "Private KB policy: for standards/codes/specification questions, call `search_private_knowledge_base` first when available, answer from retrieved chunks only, and cite title + page range + heading + confidence. Prefer paraphrase over long verbatim quotes.",
    "Memory: read/write files under Workspace/memory/**. Treat Workspace/memory/daily/*.jsonl and Workspace/memory/longterm.jsonl as read-only memory stores unless the user explicitly asks to save a preference.",
    "For sheets/PDFs: prefer `print_sheets` (defaults to dryRun=true), or `revit_list_sheets` + `revit_export_pdf`. Always resolve what will be printed BEFORE exporting. For PDF preflight or dry-run, omit `outputFolder` so it defaults to `artifacts/prints`, or pass the workspace-relative `artifacts/prints`; never invent an OS temp/test-run directory. If a direct export rejects `outputFolder`, retry once with `artifacts/prints` and require the resulting dry-run or file-verification receipt before reporting the export lane complete. For combined PDF deliverables, use `revit_export_pdf` with combine=true and verify the returned `verification.exists`, `sizeBytes`, and exact `path` before saying the export succeeded.",
    "Sheet-count rule: for requests asking how many sheets exist, call `revit_list_sheets` with `action:\"count\"` (and `exact:true` when an exact total is requested). Do not infer sheet totals by counting DrawingSheet rows from `/revit/views` unless the sheet counter is genuinely unavailable, and state the fallback if that happens.",
    "Schedule-row edit rule: inspect the bounded schedule with `revit_list_schedules` first, then call `revit_update_schedule_cell` in its default dry-run mode. Resolve by a unique row key plus target field, include `expectedValue` when the user supplied the old value, and apply only with `apply:true,dryRun:false` after the dry-run candidate is unambiguous. Do not pretend a visible schedule cell is independent from its backing instance/type parameter.",
    "For new sheet/view placement work, completion requires a presentation QC pass: run `/revit/sheets` detail with viewport geometry, keep viewports inside the drawable sheet area, align related views left/right when they fit, use consistent viewport title types, tighten model/annotation crops so stray annotations do not dominate the viewport box, then export/capture the sheet before reporting success.",
    "New-view preview truth: when the user asks to preview a new, duplicated, dependent, or enlarged view, resolving a source view, rooms, crop bounds, or geometry is discovery only. Before calling that preview complete, execute one real noncommitting create/duplicate-view primitive. Prefer `/revit/transaction-plan` with `duplicateView` or `createDependentView` followed in the same action graph by the requested `setViewCrop`, `setViewScale`, template, visibility, naming, or placement actions. A successful crop-computation or MEP-workflow receipt alone does not preview the requested Revit view.",
    "Tool discovery at scale: reuse an exact primitive already named in these instructions, a current skill, prior successful tool evidence, or the current conversation; call it directly without repeating discovery. Call `operator_discover_capabilities` only when the execution representation is genuinely unclear. Use `revit_search_tools` / `revit_tool_registry` only when an exact primitive is still unknown, and call `revit_tool_doc` / `revit_tool_examples` only when required fields or payload shape remain unclear. Discovery metadata is session-cached and force-refreshable; document/model results are never satisfied from that cache.",
    "If a needed Revit primitive exists but has no dedicated MCP wrapper yet, call it with `revit_call_tool` (method + path + body).",
    "Negative-result scope rule: never conclude that the project lacks an object, family, or type from a zero-result search limited by category, view, selection, or another filter. When the category is uncertain, retry once with category-agnostic identity discovery (for example `/revit/find-elements` with `identityTerms` and no `category`/`categories`), inspect the categories of any matches, and only then query types in the proven category. If the broader check is still inconclusive, state exactly what scope was checked instead of claiming project-wide absence.",
    "Duplicate-element investigation rule: do not treat repeated or unique Mark values or exact co-location as the definition of a duplicate, and do not rule duplicates out when those checks return zero. First request one bounded, project-scope `/revit/find-elements` inventory for the relevant physical category with `includeGeometry:true`; do not export every view before trying this complete inventory. A generic noun such as `device`, `equipment`, or `object` does not ground one Revit category: inventory the small discipline-relevant set of physical device categories together, and exclude route curves, fittings, tags, and annotations unless the user or model evidence names them. For example, HVAC device discovery normally considers Air Terminals, Mechanical Equipment, and Duct Accessories before Duct Fittings; plumbing considers Plumbing Fixtures, Mechanical Equipment, Pipe Accessories, and Sprinklers; electrical considers Electrical Equipment, Electrical Fixtures, Lighting Fixtures, and the relevant device categories. Every document-scope `/revit/find-elements` request must include a real `category`/`categories`, `identityTerms`, or another supported search predicate; `limit` alone is not a bounded predicate. Use only category values grounded by the user, tool documentation, or prior model evidence: never send placeholder or sentinel values such as `__none__`, `none`, `unknown`, or an empty category. If no category is grounded, omit the category field and use real `identityTerms` or another supported predicate. Use canonical `OST_...` category tokens when known; user-facing aliases such as `air terminals` are accepted by category-aware native endpoints. Honor `itemsComplete`, `hasMore`, continuation/offset, and truncation metadata: page the chosen category set to completeness before claiming project-wide absence or switching to one unrelated category. When `spatialDuplicateCandidates` is returned, inspect its ranked review groups first: unique Marks are not duplicate-instance proof, while opposite-facing peers may be intentional. Use insertion-point distance as well as bounding-box-center distance. Treat consecutive or nearby element IDs only as a creation-adjacency triage signal, never as duplicate proof. Batch every returned `candidateElementIds` through one `/revit/get-connectors` call with `includeAllRefs:true`, then compare connector/network signatures across the bounded candidates; rejecting one intentional pair is not evidence that unreviewed candidates are safe. If the summary is absent or incomplete, or custom ranking is needed, use code execution when available to group same-category and same-family/type instances and rank near-spatial candidates by overlapping bounding-box footprints or insertion-point/center separation relative to element size. Compare host, level, facing/hand orientation, parameters, and connector/network relationships; opposite-facing peers on different connector ports may be intentional. Shared-network membership may be intentional too, but neither fact alone proves that the pair is intentional or justifies skipping an explicitly requested rollback test. Immediate `/revit/get-connectors` references establish only one-hop edges: when complete deletion/disconnection impact or cleanup is requested, trace the highest-ranked pair's connected system with `/revit/trace-connected-network`, resolve room or space context with a bounded element, placement, or room read when available, and report the pre-delete network count. Compare repeated arrangements before declaring an opposite-facing pair intentional; a recurring geometric pattern is relevant evidence, while one shared curve or opposite ports alone are not. Before previewing deletion, trace both candidates and use a rollback/dry-run delete on one member of the highest-ranked defensible pair to report the exact disconnection and dependent-element effect. If no candidate is proven genuinely duplicated, label the highest-ranked defensible pair as plausible rather than certain, still complete an explicitly requested rollback impact preview, and distinguish the rollback-verified current state from the predicted post-delete network count. Use `/revit/export-visible-elements` only as a targeted visual follow-up for shortlisted candidates. If no candidate survives these checks, report the inspected category, inventory completeness, spatial thresholds, and how many bounded candidates were topology-reviewed.",
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

export function getCodexBaseInstructionsForTest(): string {
  return getOperatorAgentBaseInstructions();
}

export function formatToolResultsForCodexForTest(toolResults: ToolResult[] | undefined): string {
  return formatToolResultsForCodex(toolResults);
}

function formatCertifiedCodexContinuation(req: ChatRequest): string {
  return [
    formatCodexRequestEnvelope(req),
    formatToolResultsForCodex(req.tool_results, { session_id: req.session_id, model_call_id: req.message_id }),
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
    "Revit execution rule: never issue multiple Revit model calls in one tool batch when a later call depends on an earlier result. Execute one call, inspect its result, then issue the next call only if still needed. The host enforces bounded Revit work per turn: at most 64 admitted Revit calls and 16 discovery calls; a successful identical discovery call is not admitted again, and an identical failed discovery may be tried only once more. If a host attempt budget is exhausted, stop calling tools and report the exact blocker and strongest completed evidence.";
  if (!lib) return executionRule;
  return [executionRule, "Reference docs (read-only; may be truncated):", lib].join("\n\n");
}

export async function handleCodexServerRequest(runtime: CodexMcpToolRuntime, request: CodexServerRequest): Promise<unknown> {
  if (request.method === "item/tool/call") return await handleCodexDynamicToolCall(runtime, request);
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

async function getOrCreateThreadId(
  req: ChatRequest,
  client: CodexAppServer,
  workspaceRoot: string,
  agent = resolveAgentModelSettings(req.context)
): Promise<string> {
  const profile = getCodexThreadStartProfileForTest(req);
  const profilePaths = getCodexProfilePaths(workspaceRoot, profile);
  return getOrCreateCodexThread({
    sessionId: req.session_id,
    client,
    profile,
    cwd: profilePaths.cwd,
    settings: agent,
    getDynamicTools: async () => {
      if (profile.dynamicToolMode !== "revit_runtime") return [];
      const runtime = mcpRuntimesByWorkspace.get(workspaceRoot);
      if (!runtime) throw new Error("Revit Operator MCP runtime is not configured for this workspace.");
      return [await runtime.getDynamicToolNamespace()];
    }
  });
}

export async function decideCodex(req: ChatRequest): Promise<ChatResponse> {
  const chunks: string[] = [];
  const resp = await decideCodexStreaming(req, { onDelta: d => chunks.push(d) });
  return { ...resp, assistant_message: resp.assistant_message || chunks.join("") };
}

export async function decideCodexStreaming(req: ChatRequest, cb: StreamCallbacks): Promise<ChatResponse> {
  const assignmentKernelV2 = req.assignment_id && req.assignment_run_id
    && Number.isSafeInteger(req.assignment_generation) && Number(req.assignment_generation) > 0
    ? assignmentKernelV2ForBinding({
        session_id: req.session_id,
        assignment_id: req.assignment_id,
        run_id: req.assignment_run_id,
        generation: Number(req.assignment_generation)
      })
    : null;
  const threadProfile = getCodexThreadStartProfileForTest(req);
  const agentSettings = resolveAgentModelSettings(req.context);
  const stopBeforeProvider = (
    message: string,
    failureId: string,
    phase: "request_validation" | "runtime_setup" | "provider_start",
    errorClass: "provider" | "transport" | "runtime" | "canceled" | "resource_exhausted" = "runtime"
  ): ChatResponse => {
    const snapshot = assignmentKernelV2
      ? settleAssignmentKernelExecutionFailureV2({
          binding: assignmentKernelV2.binding,
          failure_id: failureId,
          error_class: errorClass,
          phase
        }).snapshot
      : null;
    const assistantMessage = snapshot
      && snapshot.terminal
      && ["complete", "complete_with_issues", "verified_noop"].includes(snapshot.outcome)
      ? finalCodexAssignmentMessageV2(snapshot, message)
      : message;
    cb.onDone?.(assistantMessage);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: assistantMessage,
      actions: [],
      ...(snapshot ? { assignment_snapshot_v2: snapshot } : {}),
      ...(snapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(snapshot) } : {})
    };
  };
  const requestBackendAuth = getRequestOperatorBackendAuth();
  const certifiedDirect = threadProfile.certified;
  let courierTarget: ReturnType<typeof revitCourierTargetFromContext> | undefined;
  if (!certifiedDirect) {
    try {
      courierTarget = revitCourierTargetFromContext(req.context);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : String(error)} I stopped before planning or Revit tool actions.`;
      return stopBeforeProvider(message, `request-validation:${req.message_id}`, "request_validation");
    }
  }
  const workspaceRoot = getWorkspaceRoot();
  let c: CodexAppServer;
  let threadId: string;


  const text = (req.user_text ?? "").toString();
  const freshEvidenceRequirement = certifiedDirect ? { required: false, kind: "none" as const, prompt: "" } : getFreshRevitEvidenceRequirement(text);
  const webEvidenceRequirement = certifiedDirect ? { required: false, prompt: "" } : getAuthoritativeWebEvidenceRequirement(text);
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
    return stopBeforeProvider(message, `requirements-read:${req.message_id}`, "request_validation");
  }
  if (requirementsReceipt && requirementsReceipt.status !== "resolved") {
    const message = `Durable requirements are ${requirementsReceipt.status}. I stopped before planning or tool actions; resolve or narrow the attached receipt first.`;
    return {
      ...stopBeforeProvider(message, `requirements-unresolved:${req.message_id}`, "request_validation"),
      requirements_receipt: requirementsReceipt
    };
  }
  try {
    const query = text.trim() || (getPinnedGoal(req.session_id) ?? "") || "";
    const mem = allowUnscopedLegacyMemory && !freshEvidenceRequirement.required && !webEvidenceRequirement.required && query
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
    activeGoalBlock = formatActiveGoalContext(assignmentKernelV2?.goal ?? getActiveGoalForSession(req.session_id));
  } catch {
    activeGoalBlock = "";
  }
  const input: UserInput[] = text.trim()
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
            if (webEvidenceRequirement.prompt) blocks.push(webEvidenceRequirement.prompt);
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
            const tr = formatToolResultsForCodex(req.tool_results as any, { session_id: req.session_id, model_call_id: req.message_id });
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
        return {
          ...stopBeforeProvider(message, `requirements-changed:${req.message_id}`, "request_validation"),
          requirements_receipt: leasedReceipt
        };
      }
      requirementsReceipt = leasedReceipt;
    } catch (error) {
      endRequirementsPlanningLease(requirementsLease);
      requirementsLease = null;
      const message = `Durable requirements could not be leased and revalidated safely (${error instanceof Error ? error.message : String(error)}). I stopped before planning or tool actions.`;
      return {
        ...stopBeforeProvider(message, `requirements-lease:${req.message_id}`, "request_validation"),
        requirements_receipt: requirementsReceipt
      };
    }
  }
  const mcpRuntime = threadProfile.startRevitTurnRuntime ? mcpRuntimesByWorkspace.get(workspaceRoot) : null;
  if (threadProfile.startRevitTurnRuntime && !mcpRuntime) {
    endRequirementsPlanningLease(requirementsLease);
    requirementsLease = null;
    return stopBeforeProvider(
      "Revit Operator MCP runtime is not configured for this workspace. I stopped before the provider or any Revit tool was called.",
      `runtime-missing:${req.message_id}`,
      "runtime_setup"
    );
  }
  const backendAuth = threadProfile.startRevitTurnRuntime ? requestBackendAuth : undefined;
  if (threadProfile.startRevitTurnRuntime && !backendAuth) {
    endRequirementsPlanningLease(requirementsLease);
    requirementsLease = null;
    const message = "Authenticated Operator backend transport is unavailable. I stopped before the provider or any Revit tool was called.";
    return stopBeforeProvider(message, `backend-transport-missing:${req.message_id}`, "runtime_setup", "transport");
  }
  let backendAuthLease: OperatorBackendAuthLease | null = null;
  let assignmentKernelV2Lease: AssignmentKernelTurnLeaseV2 | null = null;
  let teammateContext: ReturnType<typeof beginTeammateLoopOwner> | null = null;
  let teammateReceipt: ReturnType<typeof teammateLoopReceiptForLease> | undefined;
  let courierContext: ReturnType<typeof beginRevitCourierTurnContext> = null;
  let assignmentProgressTurnStart: ReturnType<typeof currentCodexAssignmentSnapshotV2> = null;
  let assignmentTerminalBarrier: AssignmentKernelTerminalBarrierLeaseV2 | null = null;
  let assignmentBudgetInterrupt: (() => void) | null = null;
  let assignmentControllerStopReason: string | null = null;
  let providerReceiptRecorder: ReturnType<typeof createAssignmentKernelV2ModelReceiptRecorder> | null = null;
  let reconcileStartedProviderTurn: (() => void) | null = null;
  const earlyTurnNotifications: CodexNotificationEnvelope[] = [];
  let liveTurnNotificationHandler: ((notification: CodexNotificationEnvelope) => void) | null = null;
  let notificationSource: CodexAppServer | null = null;
  let unsubscribeTurnNotifications: () => void = () => {};
  const bindTurnNotificationSource = (activeClient: CodexAppServer) => {
    if (notificationSource === activeClient) return;
    unsubscribeTurnNotifications();
    notificationSource = activeClient;
    unsubscribeTurnNotifications = activeClient.onNotification(notification => {
      if (liveTurnNotificationHandler) liveTurnNotificationHandler(notification);
      else earlyTurnNotifications.push(notification);
    });
  };
  let start: Awaited<ReturnType<CodexAppServer["startTurn"]>>;
  const agentTurnStartedAt = new Date().toISOString();
  const agentTurnStartedMs = Date.now();
  try {
    if (threadProfile.startRevitTurnRuntime) {
      backendAuthLease = mcpRuntime!.beginBackendAuthLease(req.session_id, backendAuth!);
      if (assignmentKernelV2) assignmentKernelV2Lease = mcpRuntime!.beginAssignmentKernelV2Lease(assignmentKernelV2.binding);
      teammateContext = beginTeammateLoopOwner(mcpRuntime!, req);
      courierContext = beginRevitCourierTurnContext({
        session_id: req.session_id,
        message_id: req.message_id,
        ttl_ms: codexTurnTimeoutMs() + 60_000,
        ...courierTarget!
      });
      if (assignmentKernelV2 && assignmentKernelV2.snapshot.in_flight_operation_ids.length > 0) {
        const recovered = await recoverAssignmentKernelOperationsV2({
          snapshot: assignmentKernelV2.snapshot,
          runtime: mcpRuntime!
        });
        if (recovered.assignment_version !== assignmentKernelV2.snapshot.assignment_version) {
          input.push({
            type: "text",
            text: `AUTHORITATIVE V2 RESTART RECOVERY:\n${formatActiveGoalContext(getGoal(recovered.spec.binding.assignment_id))}`,
            text_elements: [] as any[]
          });
        }
      }
      if (assignmentKernelV2) {
        const progression = prepareCodexAssignmentProgressV2(assignmentKernelV2.binding);
        if (!progression.prompt) {
          const message = progression.message;
          const canonicalAssignmentOutcome = canonicalAssignmentOutcomeForBinding({
            session_id: assignmentKernelV2.binding.session_id,
            assignment_id: assignmentKernelV2.binding.assignment_id,
            assignment_run_id: assignmentKernelV2.binding.run_id,
            assignment_generation: assignmentKernelV2.binding.generation
          });
          mcpRuntime?.endBackendAuthLease(backendAuthLease);
          backendAuthLease = null;
          mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
          assignmentKernelV2Lease = null;
          endTeammateLoopOwner(teammateContext);
          teammateContext = null;
          endRevitCourierTurnContext(courierContext);
          courierContext = null;
          endRequirementsPlanningLease(requirementsLease);
          requirementsLease = null;
          cb.onDone?.(message);
          return {
            version: OPERATOR_BACKEND_CONTRACT_VERSION,
            assistant_message: message,
            actions: [],
            assignment_snapshot_v2: progression.snapshot,
            ...(progression.snapshot.terminal ? { terminal_result_v2: deriveTerminalResultV2(progression.snapshot) } : {}),
            ...(canonicalAssignmentOutcome ? { canonical_assignment_outcome: canonicalAssignmentOutcome } : {})
          };
        }
        assignmentProgressTurnStart = progression.snapshot;
        input.push({ type: "text", text: progression.prompt, text_elements: [] as any[] });
      }
    }
    try {
      c = await getClient(workspaceRoot, threadProfile);
      threadId = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        return await getOrCreateThreadId(req, activeClient, workspaceRoot, agentSettings);
      });
    } catch (error) {
      mcpRuntime?.endBackendAuthLease(backendAuthLease);
      backendAuthLease = null;
      mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
      assignmentKernelV2Lease = null;
      endTeammateLoopOwner(teammateContext);
      teammateContext = null;
      endRevitCourierTurnContext(courierContext);
      courierContext = null;
      endRequirementsPlanningLease(requirementsLease);
      requirementsLease = null;
      return stopBeforeProvider(
        "The provider connection could not be initialized. I stopped before planning or any Revit tool action.",
        `provider-start:${req.message_id}`,
        "provider_start",
        classifyAssignmentKernelExecutionFailureV2(error)
      );
    }
    providerReceiptRecorder = assignmentKernelV2
      ? createAssignmentKernelV2ModelReceiptRecorder({
          binding: assignmentKernelV2.binding,
          admission_snapshot: assignmentProgressTurnStart ?? assignmentKernelV2.snapshot,
          onStop: () => {
            assignmentControllerStopReason = assignmentControllerStopReason ?? "assignment_progress_controller_stop";
            assignmentBudgetInterrupt?.();
          }
        })
      : null;
    if (assignmentKernelV2) {
      assignmentTerminalBarrier = beginAssignmentKernelTerminalBarrierV2({
        binding: assignmentKernelV2.binding,
        barrier_id: `provider-request:${req.message_id}`
      });
    }
    try {
      start = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        bindTurnNotificationSource(activeClient);
        return await activeClient.startTurn({
          threadId,
          input,
          model: agentSettings.model,
          effort: agentSettings.reasoning_effort
        });
      });
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
      setCodexThreadId(codexTelemetryThreadKey(threadProfile), "");
      threadId = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        return await getOrCreateThreadId(req, activeClient, workspaceRoot, agentSettings);
      });
      bindTurnNotificationSource(c);
      start = await c.startTurn({
        threadId,
        input,
        model: agentSettings.model,
        effort: agentSettings.reasoning_effort
      });
    }
  } catch (error) {
    endAssignmentKernelTerminalBarrierV2(assignmentTerminalBarrier);
    assignmentTerminalBarrier = null;
    unsubscribeTurnNotifications();
    unsubscribeTurnNotifications = () => {};
    mcpRuntime?.endBackendAuthLease(backendAuthLease);
    backendAuthLease = null;
    mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
    assignmentKernelV2Lease = null;
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
    endRequirementsPlanningLease(requirementsLease);
    throw error;
  }

  const turnId = typeof start?.turn?.id === "string" ? start.turn.id : "";
  if (!turnId) {
    endAssignmentKernelTerminalBarrierV2(assignmentTerminalBarrier);
    assignmentTerminalBarrier = null;
    unsubscribeTurnNotifications();
    unsubscribeTurnNotifications = () => {};
    mcpRuntime?.endBackendAuthLease(backendAuthLease);
    backendAuthLease = null;
    mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
    assignmentKernelV2Lease = null;
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
    endRequirementsPlanningLease(requirementsLease);
    throw new Error("Codex turn/start did not return a turn id.");
  }
  let providerTurnResourcesReleased = false;
  let releaseActiveTurnRegistration: (() => void) | null = null;
  const releaseStartedProviderTurn = async (interrupt: boolean): Promise<void> => {
    if (providerTurnResourcesReleased) return;
    const cleanupErrors: string[] = [];
    if (interrupt) {
      try {
        await c.interruptTurn({ threadId, turnId });
      } catch (error) {
        cleanupErrors.push(`interrupt: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await c.waitForTurnCompleted({
          threadId,
          turnId,
          timeoutMs: Math.min(codexTurnTimeoutMs(), 10_000)
        });
      } catch (error) {
        cleanupErrors.push(`interrupt drain: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const cleanup = (label: string, action: () => void) => {
      try {
        action();
      } catch (error) {
        cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    cleanup("provider receipt reconciliation", () => reconcileStartedProviderTurn?.());
    reconcileStartedProviderTurn = null;
    cleanup("notification subscription", () => unsubscribeTurnNotifications());
    unsubscribeTurnNotifications = () => {};
    liveTurnNotificationHandler = null;
    cleanup("active turn registration", () => releaseActiveTurnRegistration?.());
    releaseActiveTurnRegistration = null;
    cleanup("terminal barrier", () => endAssignmentKernelTerminalBarrierV2(assignmentTerminalBarrier));
    assignmentTerminalBarrier = null;
    cleanup("backend auth lease", () => mcpRuntime?.endBackendAuthLease(backendAuthLease));
    backendAuthLease = null;
    cleanup("Assignment Kernel lease", () => mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease));
    assignmentKernelV2Lease = null;
    cleanup("requirements planning lease", () => endRequirementsPlanningLease(requirementsLease));
    requirementsLease = null;
    cleanup("teammate loop owner", () => endTeammateLoopOwner(teammateContext));
    teammateContext = null;
    cleanup("Revit courier context", () => endRevitCourierTurnContext(courierContext));
    courierContext = null;
    providerTurnResourcesReleased = true;
    if (cleanupErrors.length > 0) {
      throw new Error(`Started provider turn cleanup failed (${cleanupErrors.join("; ")}).`);
    }
  };

  try {
  const modelTelemetry = createCodexTurnModelTelemetry({
    sessionId: req.session_id,
    threadId,
    turnId,
    settings: agentSettings,
    startedAtUtc: agentTurnStartedAt,
    onReceipt: providerReceiptRecorder
      ? providerReceiptRecorder.observe
      : assignmentModelReceiptObserver(req.session_id, () => {
          assignmentControllerStopReason = "absolute_model_call_limit_reached";
          assignmentBudgetInterrupt?.();
        })
  });
  reconcileStartedProviderTurn = () => {
    for (const notification of earlyTurnNotifications) modelTelemetry.observe(notification);
    providerReceiptRecorder?.reconcile(modelTelemetry.receipts);
  };
  if (backendAuthLease) mcpRuntime!.bindBackendAuthLeaseTurn(backendAuthLease, turnId);
  if (assignmentKernelV2Lease) mcpRuntime!.bindAssignmentKernelV2LeaseTurn(assignmentKernelV2Lease, turnId);
  if (teammateContext) bindTeammateLoopOwnerTurn(teammateContext, turnId);
  try {
    appendEvent(req.session_id, "assistant", "codex.turn.start", { thread_id: threadId, turn_id: turnId });
  } catch {
    // ignore
  }

  const assignmentObserver = assignmentKernelV2
    ? { observe: (_value: unknown) => {}, finish: (_turnId: string, _assistant: string, _receipt: unknown) => {} }
    : createAutoGoalTurnObserver(req.session_id);
  const turnNotificationObserver = createCodexTurnNotificationObserver({
    sessionId: req.session_id,
    threadId,
    turnId,
    modelTelemetry,
    assignmentObserver,
    freshEvidenceRequirement,
    webEvidenceRequirement,
    mcpRuntime: mcpRuntime ?? null,
    onDelta: cb.onDelta
  });
  liveTurnNotificationHandler = turnNotificationObserver.observe;
  for (const notification of earlyTurnNotifications.splice(0)) turnNotificationObserver.observe(notification);

  const activeTurnAbort = new AbortController();
  const activeTurnKey = codexTurnAbortKey(req.session_id, req.message_id);
  const activeTurn: ActiveCodexTurn = {
    abortController: activeTurnAbort,
    interruptRequested: false,
    interruptPromise: null,
    interrupt: async () => {
      await c.interruptTurn({ threadId, turnId });
    }
  };
  assignmentBudgetInterrupt = () => {
    void requestActiveCodexTurnInterrupt(activeTurn).catch(() => {});
  };
  if (assignmentKernelV2) {
    mcpRuntime?.bindAssignmentKernelV2TurnStop(turnId, reason => {
      assignmentControllerStopReason = assignmentControllerStopReason ?? reason;
      assignmentBudgetInterrupt?.();
    });
  }
  if (assignmentControllerStopReason) assignmentBudgetInterrupt();
  const priorActiveTurn = activeCodexTurns.get(activeTurnKey);
  if (priorActiveTurn) void requestActiveCodexTurnInterrupt(priorActiveTurn).catch(() => {});
  activeCodexTurns.set(activeTurnKey, activeTurn);
  const forwardExternalAbort = () => {
    void requestActiveCodexTurnInterrupt(activeTurn).catch(() => {});
  };
  if (cb.abortSignal?.aborted) forwardExternalAbort();
  else cb.abortSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  releaseActiveTurnRegistration = () => {
    cb.abortSignal?.removeEventListener("abort", forwardExternalAbort);
    if (activeCodexTurns.get(activeTurnKey) === activeTurn) {
      activeCodexTurns.delete(activeTurnKey);
    }
    assignmentBudgetInterrupt = null;
    mcpRuntime?.clearAssignmentKernelV2TurnStop(turnId);
  };
  let turnCancelled = false;
  let providerReceiptReconciliationError: unknown = null;
  const assignmentIdForTurn = assignmentKernelV2?.binding.assignment_id ?? getActiveGoalForSession(req.session_id)?.id ?? null;
  try {
    const completion = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
      c = activeClient;
      bindTurnNotificationSource(activeClient);
      if (!activeClient.hasLoadedThread(threadId)) {
        const resumedThreadId = await getOrCreateThreadId(req, activeClient, workspaceRoot, agentSettings);
        if (resumedThreadId !== threadId) throw new Error(`Codex active thread ${threadId} could not be resumed after reconnect.`);
      }
      return await activeClient.waitForTurnCompleted({
        threadId,
        turnId,
        timeoutMs: codexTurnTimeoutMs(),
        abortSignal: activeTurnAbort.signal
      });
    });
    turnCancelled = completion.interrupted || activeTurn.interruptRequested;
  } catch (error) {
    if (!activeTurnAbort.signal.aborted) {
      if (!assignmentKernelV2 && assignmentIdForTurn && /timed?\s*out|timeout|deadline/i.test(error instanceof Error ? error.message : String(error))) {
        await requestActiveCodexTurnInterrupt(activeTurn).catch(() => {});
        const drained = await awaitAssignmentQuiescence(assignmentIdForTurn);
        if (drained.terminal_state === "open") {
          const requested = `${getGoal(assignmentIdForTurn)?.work_budget?.requested_effect ?? "read"}`;
          const effect = requested === "apply" || requested === "preview" ? requested : "read";
          const settled = settleAssignmentTurn(req.session_id, effect, teammateContext ? teammateLoopReceiptForLease(teammateContext) : undefined);
          if (!settled.completed && settled.projection?.terminal_state === "open") {
            requestAssignmentTerminal(assignmentIdForTurn, "blocked", "provider_timeout_after_in_flight_settlement");
          }
        }
      }
      throw error;
    }
    turnCancelled = true;
  } finally {
    unsubscribeTurnNotifications();
    unsubscribeTurnNotifications = () => {};
    liveTurnNotificationHandler = null;
    if (providerReceiptRecorder) {
      try {
        providerReceiptRecorder.reconcile(modelTelemetry.receipts);
      } catch (error) {
        providerReceiptReconciliationError = error;
      }
    }
    reconcileStartedProviderTurn = null;
    teammateReceipt = teammateContext ? teammateLoopReceiptForLease(teammateContext) : undefined;
    await releaseStartedProviderTurn(false);
  }

  if (providerReceiptReconciliationError) {
    throw new Error(
      `Canonical provider receipt reconciliation failed: ${providerReceiptReconciliationError instanceof Error
        ? providerReceiptReconciliationError.message
        : String(providerReceiptReconciliationError)}`
    );
  }

  if (turnCancelled) {
    if (!assignmentKernelV2 && assignmentIdForTurn) {
      cancelAssignmentInFlight(assignmentIdForTurn);
      const drained = await awaitAssignmentQuiescence(assignmentIdForTurn);
      if (drained.terminal_state === "open") requestAssignmentTerminal(assignmentIdForTurn, "canceled", "user_canceled_after_in_flight_settlement");
    }
    const snapshot = assignmentKernelV2
      ? assignmentControllerStopReason
        ? settleCodexAssignmentProgressV2(assignmentKernelV2.binding)
        : settleAssignmentKernelExecutionFailureV2({
            binding: assignmentKernelV2.binding,
            failure_id: `canceled:${req.message_id}`,
            error_class: "canceled",
            phase: "provider_turn"
          }).snapshot
      : null;
    const budgetMessage = assignmentControllerStopReason
      ? codexAssignmentControllerStopMessage(snapshot, assignmentControllerStopReason)
      : finalCodexAssignmentMessageV2(snapshot, "");
    cb.onDone?.(budgetMessage);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: budgetMessage,
      actions: [],
      model_call_receipts: modelTelemetry.receipts,
      ...(snapshot ? { assignment_snapshot_v2: snapshot } : {}),
      ...(snapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(snapshot) } : {}),
      ...(teammateReceipt ? { teammate_loop_receipt: teammateReceipt } : {})
    };
  }

  let {
    assistantText,
    assistantDeltas,
    hasFreshRevitEvidence,
    hasAuthoritativeWebEvidence
  } = turnNotificationObserver.snapshot();
  assistantText = assistantText || assistantDeltas;
  if (assignmentKernelV2 && assignmentProgressTurnStart) {
    checkpointCodexAssignmentProgressV2({
      binding: assignmentKernelV2.binding,
      turn_start: assignmentProgressTurnStart,
      receipts: modelTelemetry.receipts
    });
  }
  teammateReceipt = reconcileTeammateReceiptWithAssistant(teammateReceipt, assistantText);
  const missingRequiredInputs = teammateReceipt?.missing_required_inputs ?? [];
  if (missingRequiredInputs.length > 0
      && (teammateReceipt?.apply_attempts ?? 0) === 0) {
    const question = missingRequiredInputs.length === 1 && missingRequiredInputs[0] === "replacement_text"
      ? "What exact replacement wording should I use?"
      : `What exact value should I use for ${missingRequiredInputs.join(", ")}?`;
    assistantText = `I did not preview or apply an opaque value that was not bound to your authenticated request.\n\n${question}`;
  }
  if (teammateReceipt?.blocked_reason === "requested_preview_operation_not_completed") {
    assistantText = `${assistantText}\n\nI cannot claim the requested Revit preview is complete because the host received only discovery or configuration evidence, not a matching noncommitting create/duplicate-view operation.`.trim();
  }
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
  const webSettlement = await enforceAuthoritativeWebEvidence({
    required: webEvidenceRequirement.required, alreadySatisfied: hasAuthoritativeWebEvidence,
    runtime: mcpRuntime ?? null, assistantText, sessionId: req.session_id, threadId, turnId,
    observe: observation => assignmentObserver.observe(observation)
  });
  assistantText = webSettlement.assistantText;
  hasAuthoritativeWebEvidence = webSettlement.satisfied;
  if ((freshEvidenceRequirement.required || webEvidenceRequirement.required) && assistantText) cb.onDelta?.(assistantText);
  assignmentObserver.finish(turnId, assistantText, teammateReceipt);
  if (assignmentKernelV2) settleCodexAssignmentProgressV2(assignmentKernelV2.binding);
  const terminalSnapshot = assignmentKernelV2
    ? currentCodexAssignmentSnapshotV2(assignmentKernelV2.binding) ?? assignmentKernelV2.snapshot
    : null;
  assistantText = finalCodexAssignmentMessageV2(terminalSnapshot, assistantText);
  const canonicalAssignmentOutcome = req.assignment_id && req.assignment_run_id
    && Number.isSafeInteger(req.assignment_generation) && Number(req.assignment_generation) > 0
    ? canonicalAssignmentOutcomeForBinding({
        session_id: req.session_id,
        assignment_id: req.assignment_id,
        assignment_run_id: req.assignment_run_id,
        assignment_generation: Number(req.assignment_generation)
      })
    : null;
  cb.onDone?.(assistantText);
  try {
    appendEvent(req.session_id, "assistant", "codex.turn.completed", {
      thread_id: threadId,
      turn_id: turnId,
      assistant_chars: (assistantText || "").length,
      agent_model: agentSettings.model,
      agent_reasoning_effort: agentSettings.reasoning_effort,
      agent_turn_duration_ms: Date.now() - agentTurnStartedMs,
      upstream_response_count: modelTelemetry.receipts.length
    });
  } catch {
    // ignore
  }

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: assistantText || "",
    actions: [],
    model_call_receipts: modelTelemetry.receipts,
    ...(terminalSnapshot ? { assignment_snapshot_v2: terminalSnapshot } : {}),
    ...(terminalSnapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(terminalSnapshot) } : {}),
    ...(canonicalAssignmentOutcome ? { canonical_assignment_outcome: canonicalAssignmentOutcome } : {}),
    ...(teammateReceipt ? { teammate_loop_receipt: teammateReceipt } : {}),
    ...(requirementsReceipt && (requirementsReceipt.status !== "resolved" || requirementsReceipt.applied.length > 0) ? { requirements_receipt: requirementsReceipt } : {})
  };
  } catch (error) {
    try {
      await releaseStartedProviderTurn(true);
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Started provider turn cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      );
    }
    throw error;
  }
}
