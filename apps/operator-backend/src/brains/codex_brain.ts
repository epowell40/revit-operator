import path from "node:path";
import type { ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { appendEvent } from "../memory/sqlite_store.js";
import { appendNotification } from "../memory/sqlite_store.js";
import { getCodexThreadId, setCodexThreadId } from "../memory/sqlite_store.js";
import { CodexAppServer } from "../codex/app_server.js";
import { ensureCodexHomeAuth, ensureCodexHomeConfig } from "../codex/config.js";
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
import { compactIncomingToolResult } from "../tool_result_compaction.js";
import { formatActiveGoalContext, getActiveGoalForSession } from "../goals/service.js";
import { formatEnvironmentSummaryForPrompt } from "../environment_profile.js";
import { AGENT_RESPONSE_STYLE_LINES } from "../agent_response_policy.js";

export type StreamCallbacks = {
  onDelta?: (textDelta: string) => void;
  onDone?: (fullText: string) => void;
  abortSignal?: AbortSignal;
};

let client: CodexAppServer | null = null;
const lastPermissionSignatureBySession = new Map<string, string>();
const activeCodexTurnAborts = new Map<string, AbortController>();

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
  const raw = Number.parseInt(process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS ?? "420000", 10);
  if (!Number.isFinite(raw)) return 420_000;
  return Math.max(60_000, Math.min(30 * 60_000, raw));
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
    "For sheets/PDFs: prefer `print_sheets` (defaults to dryRun=true), or `revit_list_sheets` + `revit_export_pdf`. Always resolve what will be printed BEFORE exporting. For combined PDF deliverables, use `revit_export_pdf` with combine=true and verify the returned `verification.exists`, `sizeBytes`, and exact `path` before saying the export succeeded.",
    "For new sheet/view placement work, completion requires a presentation QC pass: run `/revit/sheets` detail with viewport geometry, keep viewports inside the drawable sheet area, align related views left/right when they fit, use consistent viewport title types, tighten model/annotation crops so stray annotations do not dominate the viewport box, then export/capture the sheet before reporting success.",
    "Tool discovery at scale: prefer `revit_search_tools` / `revit_tool_registry` to find primitives by intent, then inspect exact contracts with `revit_tool_doc` and runnable payloads with `revit_tool_examples`.",
    "If a needed Revit primitive exists but has no dedicated MCP wrapper yet, call it with `revit_call_tool` (method + path + body).",
    "Spatial/object-location rule: for questions like 'which wall is this on', 'what room is this in', 'find the receptacle on the south wall', or redline-driven targeting, do not guess from raw XYZ. Prefer the view-mapping primitives: `/revit/export-visible-elements`, `/revit/export-view-frame`, `/revit/resolve-room-wall`, `/revit/pick-candidate-cluster`, `/revit/get-placement-context`, and `/revit/project-point-to-host-frame`.",
    "When performing spatial Revit tasks, think like a drafter using feedback. Place a reasonable first attempt using available context, then verify and correct. Do not require perfect spatial certainty before acting unless the action is destructive. Use nearby elements, room boundaries, wall vectors, view coordinates, and screenshots/captures to converge.",
    "Capability-aware routing: inspect `/revit/native-capabilities` or `/revit/capabilities` before planning if availability is unclear. Prefer native Revit API operations and captures; use sidecar/desktop automation only for capabilities reported as available or when native APIs cannot reach the target.",
    "Treat `/revit/export-visible-elements` as the default bridge from raster evidence to model context: it returns image-space anchor/bbox coordinates, host/room/space associations, orientation vectors, and a raster-consistent affine frame for supported 2D views.",
    "Existing-conditions registration must not require rooms, spaces, room tags, or matching room names. Treat them as useful but potentially absent or stale. When the record plan and current model differ, prefer common stable geometry in this order: exterior envelope/corners, stairs and elevators, shafts, grids and columns, then persistent interior geometry. Record accepted and rejected controls plus transform residuals. Do not use changed interior partitions or a name match as the only registration basis; preserve supported relative geometry as provisional and iterate when exact registration remains unresolved.",
    "After one successful broad inventory export, avoid repeating it in a loop. Reuse the returned `frameId`, sampled inventory, and mapping to continue with targeted cluster/pick/context tools.",
    "For wall-hosted or same-room placements, prefer host-aware/exemplar-driven workflows over generic XYZ placement. Resolve the room wall, inspect nearby same-room exemplars, project to host-local chainage when needed, then place/adjust on the resolved host.",
    "For raw Revit API exploration, use `revit_native_api_search` / `revit_native_api_catalog` first, then call via `revit_native_api_call` only when no normal /revit/* primitive exists.",
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
    "Titleblock edits: verification must be sheet-aware. Prefer `revit_capture_sheet_region` / `revit_verify_parameter_on_sheet` over plan-view captures for titleblock fields.",
    "For room/space ductwork workflows, prefer `revit_ducts_by_spatial_scope` for discovery and `revit_resize_ductwork_by_scope` for one-shot scoped resize requests (room+plenum, roomMode=auto).",
    "MEP redline intent rule: a PDF annotation such as `12x10 supply duct` labels the requested duct to create/route unless the redline or model evidence clearly identifies an editable existing duct to resize. If no editable HVAC duct exists at the mark and the visible target is linked plumbing, do not ask to edit the plumbing link; draft a bounded HVAC duct route in the active HVAC model using `/revit/mep-route-workflow` or `/revit/create-duct` dryRun first.",
    "For vague semantic MEP requests such as extending piping from a main to a sink or routing ductwork to diffusers, call `/tools/mep/semantic-route-plan` first and follow its read-only discovery actions or guarded dry-run action before any model write. For MEP redline routing, prefer `revit_call_tool` for `/revit/mep-route-workflow`, which enforces resolve context -> dry-run -> optional apply -> focused post-change visual capture. A single line is two ordered points; bends are one ordered point list. Use apply=false first when uncertain, then apply=true with visualVerify=true once bounded. If size/elevation is missing, use conservative defaults with explicit warnings (8x8 duct, 1 inch pipe, resolved routing elevation) and ask follow-up questions after producing the bounded dry-run, not before. Internal route bends attempt Revit elbow fittings and return fitting ids; differing segmentSizes or branchSegmentSizes plan transition fittings for reducers. For editing existing explicit duct/pipe curve ids, use `/revit/edit-mep-route-elements` dryRun first for whole-element size or simple level-straight elevation edits; it blocks connected elevation moves unless allowConnectedElevationMove:true and returns before/after size, curve, connector, network-audit, and optional focused capture evidence. If the requested edit changes size part way down one straight curve, use `/revit/reroute-mep-route-segment` size-transition mode with transitionNormalized or transitionChainageFt plus explicit upstream/downstream sizes, and require a transition fitting in connectionAttempts before completion. If the requested edit offsets a middle section of one straight curve, use `/revit/reroute-mep-route-segment` offset mode; set offsetMode:\"dogleg45\" when diagonal 45-degree legs are required. Connected endpoints on `/revit/reroute-mep-route-segment` are blocked by default; only set preserveConnectedEndpoints:true after dry-run reports a concrete endpointReconnectionPlan, then require endpoint reconnection attempts plus connector/network audit before completion. For branch/tee/tap requests, dry-run `/revit/connect-mep-branch` for one branch or `/revit/mep-branch-network-workflow` for a main route plus multiple branches. Apply is supported for existing open connector branches, straight duct tap/takeoff at a projected non-connector point, pipe tap/takeoff only when dry-run tapApplyPrecheck confirms an explicit takeoff/tap routing preference, straight duct/pipe split tee cases, branch-level reducer transitions via branchSegmentSizes, explicit duct/pipe accessory insertion on created main or branch segments when a compatible familyPath/family/type and chainage/point preconditions pass, and explicit target-id duct/pipe accessory delete/type_change with compatible loaded types. When the user names a tap/takeoff family or type, pass takeoffFamilyName/takeoffTypeName, inspect selected.takeoffRoutingPreference and tapApplyPrecheck on dry-run, and require connectionAttempts[*].fitting to match on apply. Do not claim completion unless connector/fitting/accessory verification passes and post-change capture is reviewed.",
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

function developerInstructions(): string {
  // Inject repo-shipped docs + runbooks (best-effort, size-limited by getSkillLibraryText()) so Codex can benefit
  // even when sandboxed to Workspace-write (cannot read the repo checkout directly).
  const lib = (getSkillLibraryText() || "").trim();
  if (!lib) return "";
  return ["Reference docs (read-only; may be truncated):", lib].join("\n\n");
}

async function getClient(): Promise<CodexAppServer> {
  if (client) return client;

  const workspaceRoot = getWorkspaceRoot();
  const codexHome = getCodexHome(workspaceRoot);
  ensureCodexHomeAuth({ codexHome });
  ensureCodexHomeConfig({ codexHome });

  client = new CodexAppServer({
    cwd: workspaceRoot,
    codexHome,
    spawnEnv: buildCodexSpawnEnv(workspaceRoot)
  });
  await client.ensureStarted();

  // Ensure MCP server config is reloaded at least once on startup.
  try {
    await client.request("config/mcpServer/reload", undefined);
  } catch {
    // best effort; some codex versions may not expose this method
  }

  return client;
}

function isTransportClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /transport closed/i.test(msg) || /app-server exited/i.test(msg) || /ECONNRESET/i.test(msg);
}

async function withTransportRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransportClosedError(err)) throw err;
    // Best-effort: restart the app-server connection once and retry.
    client = null;
    const c = await getClient();
    // Touch the connection to ensure it's alive.
    try {
      await c.request("initialize", {
        clientInfo: { name: "revit-operator-backend", title: "Revit Operator Backend", version: "0.0.0" },
        capabilities: null
      });
    } catch {
      // ignore; getClient already initialized once in most cases
    }
    return await fn();
  }
}

export async function warmCodexAppServer(): Promise<void> {
  await getClient();
}

async function getOrCreateThreadId(sessionId: string): Promise<string> {
  const existing = getCodexThreadId(sessionId);
  if (existing) return existing;

  const c = await getClient();
  const workspaceRoot = getWorkspaceRoot();

  const resp = (await c.request("thread/start", {
    cwd: workspaceRoot,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    model: getDefaultModel(),
    baseInstructions: getOperatorAgentBaseInstructions(),
    developerInstructions: developerInstructions(),
    experimentalRawEvents: false
  })) as any;

  const threadId = typeof resp?.thread?.id === "string" ? resp.thread.id : typeof resp?.threadId === "string" ? resp.threadId : "";
  if (!threadId) throw new Error("Codex thread/start did not return a thread id.");

  try {
    // Subscribe to this thread's notifications (required for streaming on some app-server builds).
    await c.request("addConversationListener", { conversationId: threadId, experimentalRawEvents: false });
  } catch {
    // ignore; not required on all builds
  }

  setCodexThreadId(sessionId, threadId);
  try {
    appendEvent(sessionId, "assistant", "codex.thread.start", { thread_id: threadId });
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
  const c = await getClient();
  const threadId = await withTransportRetry(() => getOrCreateThreadId(req.session_id));

  // Some app-server builds require a conversation listener for streaming notifications;
  // re-assert it each turn (best-effort) to avoid "Transport closed" / silent streams.
  try {
    await c.request("addConversationListener", { conversationId: threadId, experimentalRawEvents: false });
  } catch {
    // ignore
  }

  const text = (req.user_text ?? "").toString();
  let memBlock = "";
  let projectProfileBlock = "";
  let requirementsBlock = "";
  let requirementsReceipt: RequirementsReceipt | null = null;
  let requirementsError = "";
  try {
    projectProfileBlock = formatProjectProfileForPrompt();
  } catch {
    projectProfileBlock = "";
  }
  try {
    requirementsReceipt = resolveRequirementsForChat(req);
    requirementsBlock = formatRequirementsForPrompt(requirementsReceipt);
  } catch (error) {
    requirementsReceipt = null;
    requirementsBlock = "";
    requirementsError = error instanceof Error ? error.message : String(error);
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
    const mem = query ? retrieveMemoryContext({ queryText: query, maxEntries: 6 }) : [];
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
            if (activeGoalBlock) blocks.push(activeGoalBlock);
            if (projectProfileBlock) blocks.push(projectProfileBlock);
            if (requirementsBlock) blocks.push(requirementsBlock);
            try {
              blocks.push(formatEnvironmentSummaryForPrompt());
            } catch {}
            if (memBlock) blocks.push(`MEMORY CONTEXT (read-only):\n${memBlock}`);
            try {
              const perms = formatPermissionSummaryFromContext(req.context);
              if (perms) {
                const prev = lastPermissionSignatureBySession.get(req.session_id) || "";
                lastPermissionSignatureBySession.set(req.session_id, perms.signature);
                if (prev && prev !== perms.signature) blocks.push(`PERMISSION UPDATE (changed since last message):\n${perms.summary}`);
                else blocks.push(perms.summary);
              }
            } catch {}
            if (text.trim()) blocks.push(`USER:\n${text}`);
            const tr = formatToolResultsForCodex(req.tool_results as any);
            if (tr) blocks.push(tr);
            return blocks.join("\n\n");
          })(),
          text_elements: [] as any[]
        }
      ]
    : // If the client sends an empty user_text (legacy tool-loop continuation), still nudge Codex.
      [{ type: "text", text: [activeGoalBlock, requirementsBlock, "(continue)"].filter(Boolean).join("\n\n"), text_elements: [] as any[] }];

  let requirementsLease: ReturnType<typeof beginRequirementsPlanningLease> | null = null;
  if (requirementsReceipt) {
    try {
      const plannedReceiptSha256 = requirementsReceipt.receipt_sha256;
      requirementsLease = beginRequirementsPlanningLease(plannedReceiptSha256);
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
  let start: any;
  try {
    start = (await withTransportRetry(() =>
      c.request("turn/start", {
        threadId,
        input
      })
    )) as any;
  } catch (error) {
    endRequirementsPlanningLease(requirementsLease);
    throw error;
  }

  const turnId = typeof start?.turn?.id === "string" ? start.turn.id : "";
  if (!turnId) {
    endRequirementsPlanningLease(requirementsLease);
    throw new Error("Codex turn/start did not return a turn id.");
  }
  try {
    appendEvent(req.session_id, "assistant", "codex.turn.start", { thread_id: threadId, turn_id: turnId });
  } catch {
    // ignore
  }

  let assistantText = "";

  const unsubscribe = c.onNotification(n => {
    try {
      if (!n || n.threadId !== threadId) return;
      if (n.method === "item/agentMessage/delta") {
        if (n.params?.turnId !== turnId) return;
        const delta = typeof n.params?.delta === "string" ? n.params.delta : "";
        if (delta) {
          cb.onDelta?.(delta);
        }
      }

      if (n.method === "item/completed") {
        if (n.params?.turnId !== turnId) return;
        const item = n.params?.item;
        if (item?.type === "agentMessage") {
          const full = typeof item.text === "string" ? item.text : "";
          if (full) assistantText = full;
        }
        if (item?.type === "mcpToolCall") {
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
    await withTransportRetry(() =>
      c.waitForTurnCompleted({
        threadId,
        turnId,
        timeoutMs: codexTurnTimeoutMs(),
        abortSignal: activeTurnAbort.signal
      })
    );
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
  }

  if (turnCancelled) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "",
      actions: []
    };
  }

  cb.onDone?.(assistantText);
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
    ...(requirementsReceipt && (requirementsReceipt.status !== "resolved" || requirementsReceipt.applied.length > 0) ? { requirements_receipt: requirementsReceipt } : {})
  };
}
