import { agentModelRequiresReasoning, isOptionalProviderModel, normalizeAgentModel } from './agent_model_catalog.mjs';
import { parseTaskNavigation, renderTaskList, renderSessionStart, taskDraftKey, taskStateLabel, currentTaskState, computerStateMatchesTask, computerStateIncludesSubmittedMessage } from "./task_navigation.mjs";
import { createComposerDraftStore, staleComposerNotice, saveComposerRefreshTarget, readComposerRefreshTarget, clearComposerRefreshTarget } from "./composer_draft.mjs";
import { beginComposerSend, selectChatSubmissionMode, startsFreshComputerConversation, routeSavedChatSubmission } from "./composer_intake.mjs";
import { mayRestoreRejectedChatSubmission } from "./chat_submission_admission.mjs";
import { checkpointDirectionContext, checkpointResumeReady, checkpointResourceRenewalContext, assertNewTaskAfterReport } from "./checkpoint_followup.mjs";
import { acceptAssignmentMutationViewV2, retainNewerAssignmentViewsV2, savedAssignmentNavigationTargetV2, readSavedAssignmentHistoryV2 } from "./assignment_mutation.mjs";
import { createAssignmentInputControl, assignmentInputErrorText } from "./assignment_input_controls.mjs";
import { refreshAssignmentDisplayContext } from "./assignment_display_context.mjs";
import { environmentDiagnosticSummary } from "./environment_diagnostics_ui.mjs";
import { assertLoadedBrowserFresh, STALE_BROWSER_MESSAGE } from "./browser_asset_freshness_ui.js";
const loadedBrowserIdentity = typeof LOADED_BROWSER_ASSET_IDENTITY === "string" ? LOADED_BROWSER_ASSET_IDENTITY : "";
import { renderVerifiedWorkPacketHtml } from "./verified_work_packet_ui.js";
import { renderWorkReturnHtml } from "./work_return_ui.js";
import { compactWorkSummary, conciseStatus, appendInlineText, mergeConversationHistory, renderAssistantBlocks, linkedTextParts, renderTaskActivity } from "./conversation_ui.js";

const CONTRACT_VERSION = "operator.backend.v1";
const STORAGE_KEY = "operator-desktop.session-id";
const composerDraftStore = createComposerDraftStore();
let composerDraftKey = "";
let composerDraftTimer = null;
let composerDraftRevision = 0;
try {
  composerDraftKey = sessionStorage.getItem("operator-desktop.draft-tab") || crypto.randomUUID();
  sessionStorage.setItem("operator-desktop.draft-tab", composerDraftKey);
} catch { /* The composer remains usable when local recovery is unavailable. */ }
const CAPTURE_TRANSCRIBE_INTERVAL_MS = 90 * 1000;
const LEARN_REVIEW_INTERVAL_MS = 45 * 1000;
const LISTEN_SCREENSHOT_INTERVAL_MS = 60 * 1000;
const LEARN_SCREENSHOT_INTERVAL_MS = 30 * 1000;
const LISTEN_SCREENSHOT_LIMIT = 6;
const LEARN_SCREENSHOT_LIMIT = 5;
const BACKEND_BOOTSTRAP_TIMEOUT_MS = 5_500;
const BACKEND_BOOTSTRAP_RETRY_MS = 15_000;

const state = {
  sessionId: "",
  taskNavigationMode: true,
  taskNavigation: [],
  taskNavigationBusy: false,
  taskCatalogueBusy: false,
  taskShowArchived: false,
  taskCatalogueLoading: true,
  taskCatalogueUnavailable: false,
  taskNavigationUpdatedAt: 0,
  taskNavigationEpoch: 0,
  taskNavigationAssignmentId: "",
  streaming: false,
  resetting: false,
  composerSubmissionPending: false,
  activeRunKind: "",
  backendAbortController: null,
  backendMessageId: "",
  backendBootstrapBusy: false,
  backendBootstrapRetryTimer: null,
  backendUrl: "",
  backendLocal: true,
  backendAuthMode: "shared_token",
  runtimeProfile: null,
  authStatus: null,
  environmentStatus: null,
  environmentProfile: null,
  environmentProfileStatus: "unknown",
  certifiedReadUi: null,
  demoReadiness: null,
  environmentDetailsOpen: false,
  computerUseAvailable: false,
  localExecutor: null,
  backendAvailable: false,
  backendConfigStatus: "unknown",
  shellEnabled: false,
  pendingAttachments: [],
  attachmentLimits: null,
  attachmentReadsPending: 0,
  screenTimer: null,
  computerStateTimer: null,
  notificationsTimer: null,
  batchJobsTimer: null,
  goalsTimer: null,
  writeGrantTimer: null,
  writeGrantStatus: null,
  writeGrantBusy: false,
  notificationsAfterId: 0,
  feedbackVisible: false,
  backendMessages: [],
  computerMessages: [],
  checkedProjectCopy: null,
  computerEvents: [],
  computerProgress: null,
  computerScreen: null,
  computerError: "",
  computerSyncRequestId: 0,
  computerPollPending: false,
  computerSubmissionMessageId: "",
  pendingComputerUserMessages: [],
  captureArtifacts: [],
  batchJobs: [],
  focusedBatchJobId: "",
  goals: [],
  goalsSyncRequestId: 0,
  activeGoalId: "",
  goalSelectionPinned: false,
  verifiedWorkPacket: null,
  verifiedWorkPacketAssignmentId: "",
  verifiedWorkPacketRequestId: 0,
  workReturn: null,
  pendingClarification: null,
  assignmentRevitContext: null,
  batchTemplates: [],
  batchDraftSource: null,
  artifactPreviewPath: "",
  lastComputerSignature: "",
  lastScreenshotVersion: 0,
  screenObjectUrl: "",
  screenPreviewObjectUrl: "",
  screenLoading: false,
  computerRunSubmissionPending: false,
  desktopCaptureSuppressed: false,
  screenError: "",
  screenCapturedAt: "",
  captureState: {
    mode: "",
    busy: false,
    micSession: null,
    systemSession: null,
    displayStream: null,
    displayLabel: "",
    displayAudioEnabled: false,
    screenshots: [],
    screenshotTimer: null,
    chunkTimer: null,
    reviewTimer: null,
    warnings: [],
    startedAt: "",
    micTranscript: "",
    systemTranscript: "",
    micTranscriptPromise: Promise.resolve(""),
    systemTranscriptPromise: Promise.resolve(""),
    micChunkCount: 0,
    systemChunkCount: 0,
    liveReviewBusy: false,
    lastLearnReviewInputSignature: "",
    lastLearnReviewMessageSignature: "",
    eventTimeline: [],
    liveReviewHistory: []
  },
  recState: {
    recording: false,
    busy: false,
    session: null,
    micDevices: [],
    micDeviceId: ""
  }
};

// TESTABLE_BACKEND_BOOTSTRAP_POLICY_START
function backendBootstrapPresentation(config = {}, error = null) {
  const status = `${config?.backendConfigStatus || (error ? "unavailable" : "ready")}`.trim().toLowerCase();
  const degraded = !!error || status !== "ready";
  return {
    degraded,
    retryVisible: degraded,
    statusText: degraded
      ? status === "timeout"
        ? "Sidecar ready — backend timed out."
        : "Sidecar ready — backend unavailable."
      : "Ready."
  };
}

function sidecarHealthStatusText(presentation = {}) {
  return presentation.degraded ? presentation.statusText : "Sidecar ready.";
}

function beginNonBlockingBootstrapServices({ restoreSession, startPolling, refreshEnvironment }) {
  restoreSession();
  startPolling();
  void Promise.resolve().then(refreshEnvironment).catch(() => null);
}
// TESTABLE_BACKEND_BOOTSTRAP_POLICY_END

// TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_START
function runtimeProfilePresentation(profile = null, backendAvailable = true) {
  if (!backendAvailable) {
    return {
      key: "offline",
      label: "Service offline",
      summary: "Operator cannot reach its execution service. No Revit work will be started.",
      tone: "tone-danger",
      projectQueries: false
    };
  }
  if (profile?.general_agent === true && profile?.project_queries === true) {
    const hosted = `${profile?.key || ""}` === "general_agent";
    return {
      key: hosted ? "general_agent" : "general_agent_laboratory",
      label: "Service connected",
      summary: hosted
        ? "Connected to BIMTools. Revit availability and model permissions are checked when a task starts."
        : "Connected to the local service. Revit availability and model permissions are checked when a task starts.",
      tone: "tone-positive",
      projectQueries: true
    };
  }
  if (`${profile?.key || ""}` === "general_agent_unavailable" || profile?.general_agent === false) {
    return {
      key: "general_agent_unavailable",
      label: "Service unavailable",
      summary: "Operator cannot start tasks on this connection. No Revit task will be started.",
      tone: "tone-danger",
      projectQueries: false
    };
  }
  return {
    key: "unknown",
    label: "Checking connection",
    summary: "Waiting for the service to report its availability.",
    tone: "tone-neutral",
    projectQueries: false
  };
}

function goalProgressPresentation(goal = null) {
  const projected = goal?._projection?.progress;
  if(projected?.basis === 'review_handoff')return {completed:0,total:0,percent:null,
    text:'Result ready for review. Formal completion checks remain unverified.'};
  if(projected?.basis === 'actor_work_plan')return {
    completed:0,total:projected.total,percent:null,
    text:`${projected.reported} of ${projected.total} work items reported done · ${projected.checked} with a recorded actor backcheck. Not independently verified.`
  };
  if (projected && projected.determinate === true && Number.isFinite(Number(projected.total)) && Number(projected.total) > 0) {
    const completed = Number(projected.completed || 0) + Number(projected.skipped || 0);
    const total = Number(projected.total);
    return {
      completed,
      total,
      percent: Number.isFinite(Number(projected.ratio)) ? Math.round(Number(projected.ratio) * 100) : Math.round((completed / total) * 100),
      text: `${completed} of ${total} steps complete`
    };
  }
  const workItems = Array.isArray(goal?.work_items) ? goal.work_items : [];
  const completeStatuses = new Set(["complete", "skipped"]);
  const completed = workItems.filter((item) => completeStatuses.has(`${item?.status || "pending"}`)).length;
  const total = workItems.length;
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : null,
    text: total > 0 ? `${completed} of ${total} steps complete` : "No plan yet"
  };
}

function goalStatusPresentation(goal = null) {
  const status = `${goal?._assignmentPhase || goal?.status || "idle"}`.trim().toLowerCase();
  const presentations = {
    active: { label: "Active", tone: "tone-info" },
    understanding: { label: "Understanding", tone: "tone-info" },
    inspecting: { label: "Inspecting model", tone: "tone-info" },
    planning: { label: "Planning", tone: "tone-info" },
    preparing: { label: "Preparing automation", tone: "tone-info" },
    previewing: { label: "Previewing", tone: "tone-info" },
    preview_ready: { label: "Preview ready", tone: "tone-positive" },
    awaiting_approval: { label: "Awaiting approval", tone: "tone-warning" },
    awaiting_user_input: { label: "Waiting for your input", tone: "tone-warning" },
    awaiting_user_review: { label: "Waiting for your review", tone: "tone-warning" },
    applying: { label: "Applying", tone: "tone-warning" },
    verifying: { label: "Verifying", tone: "tone-info" },
    correcting: { label: "Correcting", tone: "tone-warning" },
    complete_with_issues: { label: "Complete with issues", tone: "tone-warning" },
    outcome_uncertain: { label: "Outcome uncertain", tone: "tone-danger" },
    stopping_after_usage_limit: { label: "Stopping after usage limit", tone: "tone-warning" },
    waiting_for_usage: { label: "Waiting for usage", tone: "tone-warning" },
    paused: { label: "Paused", tone: "tone-warning" },
    pausing: { label: "Pausing", tone: "tone-warning" },
    blocked: { label: "Blocked", tone: "tone-danger" },
    complete: { label: "Complete", tone: "tone-positive" },
    canceled: { label: "Cancelled", tone: "tone-neutral" },
    cancelled: { label: "Cancelled", tone: "tone-neutral" },
    failed: { label: "Failed", tone: "tone-danger" },
    draft: { label: "Draft", tone: "tone-neutral" },
    idle: { label: "Idle", tone: "tone-neutral" }
  };
  return presentations[status] || { label: status.replace(/_/g, " ") || "Unknown", tone: "tone-neutral" };
}

function assignmentProjectionToGoalView(assignment = null) {
  if (!assignment || typeof assignment !== "object") return null;
  if (`${assignment.schema || ""}` !== "revit-operator.assignment-projection/v1") return assignment;
  const evidenceEntries = Array.isArray(assignment?.evidence?.entries) ? assignment.evidence.entries : [];
  const criteria = Array.isArray(assignment?.verification?.criteria) ? assignment.verification.criteria : [];
  const phase = `${assignment?.lifecycle?.phase || "unknown"}`;
  return {
    id: assignment.id,
    title: assignment.title,
    objective: assignment.objective || assignment.source_user_request || "",
    status: assignment?.lifecycle?.source_status || phase,
    updated_at: assignment.updated_at,
    created_at: assignment.created_at,
    acceptance_criteria: Array.isArray(assignment.acceptance_criteria)
      ? assignment.acceptance_criteria
      : criteria.map((item) => item?.criterion).filter(Boolean),
    related_session_id: assignment?.target?.session_id || "",
    current_phase: assignment?.lifecycle?.source_phase || phase,
    current_step: assignment?.lifecycle?.current_step || assignment?.lifecycle?.summary || "",
    progress_summary: assignment?.lifecycle?.summary || "",
    work_items: Array.isArray(assignment?.plan?.steps) ? assignment.plan.steps : [],
    assumptions: Array.isArray(assignment.assumptions) ? assignment.assumptions : [],
    blocker: Array.isArray(assignment.blockers) ? assignment.blockers[0] || "" : "",
    error: phase === "failed" && Array.isArray(assignment.blockers) ? assignment.blockers[0] || "" : "",
    action_log: evidenceEntries.filter((entry) => entry?.kind === "action"),
    evidence_log: evidenceEntries.filter((entry) => entry?.kind !== "action" && entry?.kind !== "validation"),
    validation_log: evidenceEntries.filter((entry) => entry?.kind === "validation"),
    completion_audit: assignment?.verification?.state && assignment.verification.state !== "unknown"
      ? {
          complete: assignment.verification.state === "passed",
          recommendation: Array.isArray(assignment.verification.notes) ? assignment.verification.notes.join(" · ") : "",
          requested_at: assignment.finished_at || assignment.updated_at
        }
      : null,
    _assignmentPhase: phase,
    _sourceKind: assignment.source_kind,
    _sourceRecordId: assignment.source_record_id,
    _projection: assignment
  };
}

function assignmentContextPresentation(goal = null, current = null) {
  const projection = goal?._projection || null;
  const target = projection?.target || {};
  const truth = projection?.truth || {};
  const reasons = [];
  let wrongTarget = false;
  const clean = (value) => `${value || ""}`.trim().toLowerCase();
  const cleanTitle = (value) => clean(value).replace(/\.rvt$/i, "");
  const targetFingerprint = clean(target.document_fingerprint);
  const currentFingerprint = clean(current?.document_fingerprint);
  const targetTitle = cleanTitle(target.document_title);
  const currentTitle = cleanTitle(current?.document_title);
  const targetPath = clean(target.document_path);
  const currentPath = clean(current?.document_path);
  const targetExecutor = clean(target.executor_id);
  const currentExecutor = clean(current?.executor_id);
  const targetKnown = !!(targetFingerprint || targetTitle || targetPath || targetExecutor);
  const currentKnown = !!(currentFingerprint || currentTitle || currentPath);
  let unverifiable = false;

  if (truth.stale === true) {
    reasons.push("The backend marked this assignment stale.");
    wrongTarget = true;
  }
  if (targetFingerprint && currentFingerprint && targetFingerprint !== currentFingerprint) {
    reasons.push("The open Revit project does not match the assignment fingerprint.");
    wrongTarget = true;
  } else if (targetTitle && currentTitle && targetTitle !== currentTitle) {
    reasons.push(`This assignment targets ${target.document_title}; ${current?.document_title || "another model"} is open.`);
    wrongTarget = true;
  } else if (targetPath && currentPath && targetPath !== currentPath) {
    reasons.push("The open Revit document path does not match the assignment target.");
    wrongTarget = true;
  } else if (targetKnown && !currentKnown) {
    reasons.push("The current Revit document could not be verified.");
    unverifiable = true;
  }
  if (targetExecutor && currentExecutor && targetExecutor !== currentExecutor) {
    reasons.push("The active Revit executor does not match the assignment executor.");
    wrongTarget = true;
  } else if (targetExecutor && !currentExecutor) {
    reasons.push("The assignment executor could not be verified.");
    unverifiable = true;
  }
  if (truth.reconciliation_required === true) reasons.push("A prior effect requires reconciliation before continuation.");
  if (truth.outcome_uncertain === true) reasons.push("A prior effect has an uncertain outcome and must be reconciled.");

  const resumeBlocked = wrongTarget || unverifiable || truth.reconciliation_required === true || truth.outcome_uncertain === true;
  return {
    targetKnown,
    wrongTarget,
    unverifiable,
    selectableAsCurrent: !wrongTarget && !unverifiable,
    resumeBlocked,
    reasons,
    label: wrongTarget
      ? "Stale target"
      : truth.reconciliation_required === true || truth.outcome_uncertain === true
        ? "Reconciliation required"
        : unverifiable
          ? "Target unverifiable"
          : targetKnown ? "Target verified" : "Target not recorded"
  };
}

function assignmentIsActionable(goal = null) {
  const phase = `${goal?._assignmentPhase || goal?.status || ""}`.trim().toLowerCase();
  return ["active", "understanding", "inspecting", "planning", "preparing", "previewing", "preview_ready", "awaiting_approval", "applying", "executing", "running", "pausing", "verifying", "correcting", "paused", "blocked", "stopping_after_usage_limit", "waiting_for_usage"].includes(phase);
}

function chooseCurrentAssignment(goals = [], current = null, sessionId = undefined) {
  if (sessionId !== undefined) {
    return goals.find(goal => sessionId && goal.related_session_id === sessionId) || null;
  }
  // The assignments endpoint is newest-first. Keep the newest assignment for
  // the active Revit target selected even after it reaches a terminal state so
  // its verified result does not immediately get replaced by an older paused
  // or blocked history item. A changed executor makes Resume stale but does not
  // make the completed result belong to a different document.
  const currentFingerprint = `${current?.document_fingerprint || ""}`.trim();
  const currentPath = `${current?.document_path || ""}`.trim().toLowerCase();
  const currentTitle = `${current?.document_title || ""}`.trim().toLowerCase();
  const targetMatched = goals.find((goal) => {
    const target = goal?._projection?.target || {};
    const targetFingerprint = `${target.document_fingerprint || ""}`.trim();
    const targetPath = `${target.document_path || ""}`.trim().toLowerCase();
    const targetTitle = `${target.document_title || ""}`.trim().toLowerCase();
    if (targetFingerprint && currentFingerprint) return targetFingerprint === currentFingerprint;
    if (targetPath && currentPath) return targetPath === currentPath;
    return Boolean(targetTitle && currentTitle && targetTitle === currentTitle);
  });
  if (targetMatched) return targetMatched;
  const actionable = goals.filter(assignmentIsActionable);
  return actionable.find((goal) => assignmentContextPresentation(goal, current).selectableAsCurrent) || actionable[0] || goals[0] || null;
}

function assignmentIsNewer(candidate = null, selected = null) {
  if (!candidate) return false;
  if (!selected) return true;
  const candidateTime = Date.parse(candidate.updated_at || candidate.created_at || "");
  const selectedTime = Date.parse(selected.updated_at || selected.created_at || "");
  return Number.isFinite(candidateTime) && (!Number.isFinite(selectedTime) || candidateTime > selectedTime);
}
// TESTABLE_ASSIGNMENT_WORKSPACE_POLICY_END

// TESTABLE_CERTIFIED_READ_UX_START
function certifiedReadStatusPresentation(input = {}) {
  const requested = `${typeof input === "string" ? input : input?.status || "unknown"}`.trim().toLowerCase();
  const states = {
    off: {
      key: "off",
      label: "Certified reads off",
      summary: "Certified reads are not configured for this Sidecar.",
      tone: "tone-neutral",
      writesCopy: ""
    },
    configured: {
      key: "configured",
      label: "Certified reads configured",
      summary: "A certified read route is configured, but availability has not been confirmed.",
      tone: "tone-info",
      writesCopy: ""
    },
    available: {
      key: "available",
      label: "Certified reads available",
      summary: "Read-only certified operations are available.",
      tone: "tone-positive",
      writesCopy: "Works with Writes Off."
    },
    degraded: {
      key: "degraded",
      label: "Certified reads degraded",
      summary: "Certified reads are temporarily unavailable. Sidecar readiness is separate.",
      tone: "tone-warning",
      writesCopy: ""
    },
    unknown: {
      key: "unknown",
      label: "Certified reads unknown",
      summary: "Certified read availability has not been reported.",
      tone: "tone-neutral",
      writesCopy: ""
    }
  };
  return { ...(states[requested] || states.unknown) };
}

function certifiedReadLifecyclePresentation(input = {}) {
  const requested = `${typeof input === "string" ? input : input?.lifecycle || ""}`.trim().toLowerCase();
  const states = {
    authorizing: {
      key: "authorizing",
      label: "Authorizing certified read…",
      summary: "Checking read permission before contacting Revit.",
      tone: "tone-info",
      busy: true
    },
    authorized: {
      key: "authorized",
      label: "Certified read authorized",
      summary: "Read authorization succeeded. No model write was authorized.",
      tone: "tone-info",
      busy: false
    },
    executing: {
      key: "executing",
      label: "Running certified read…",
      summary: "Reading from Revit. Works with Writes Off.",
      tone: "tone-info",
      busy: true
    },
    stopping: {
      key: "stopping",
      label: "Stopping certified read…",
      summary: "Stop requested. Waiting for a truthful terminal result.",
      tone: "tone-warning",
      busy: true
    },
    interrupted: {
      key: "interrupted",
      label: "Certified read interrupted",
      summary: "The read was interrupted before a confirmed result.",
      tone: "tone-warning",
      busy: false
    },
    recovering_result: {
      key: "recovering_result",
      label: "Recovering certified read result…",
      summary: "The request may have completed. Checking for its existing result without replaying it.",
      tone: "tone-info",
      busy: true
    },
    recovered: {
      key: "recovered",
      label: "Certified read result recovered",
      summary: "Recovered the existing read result without running the request again.",
      tone: "tone-positive",
      busy: false
    },
    failed_pre_dispatch: {
      key: "failed_pre_dispatch",
      label: "Certified read blocked before dispatch",
      summary: "Nothing was sent to Revit. No model write was authorized.",
      tone: "tone-danger",
      busy: false
    },
    outcome_unknown: {
      key: "outcome_unknown",
      label: "Certified read outcome unknown",
      summary: "The read may have reached Revit, but no result was confirmed. No model write was authorized. It will not retry automatically.",
      tone: "tone-warning",
      busy: false
    },
    completed: {
      key: "completed",
      label: "Certified read completed",
      summary: "Read-only result confirmed. No model write was authorized.",
      tone: "tone-positive",
      busy: false
    }
  };
  return states[requested] ? { ...states[requested] } : null;
}

const CERTIFIED_READ_STATUS_KEYS = new Set(["off", "configured", "available", "degraded", "unknown"]);
const CERTIFIED_READ_LIFECYCLE_KEYS = new Set([
  "authorizing", "authorized", "executing", "stopping", "interrupted",
  "recovering_result", "recovered", "failed_pre_dispatch", "outcome_unknown", "completed"
]);
const CERTIFIED_READ_BUSY_LIFECYCLE_KEYS = new Set([
  "authorizing", "executing", "stopping", "recovering_result"
]);
const CERTIFIED_READ_REQUIRES_AVAILABLE_LIFECYCLE_KEYS = new Set([
  "authorizing", "authorized", "executing", "stopping", "recovering_result", "recovered", "completed"
]);

function normalizeCertifiedReadFixture(fixture = {}) {
  const safeFixture = fixture && typeof fixture === "object" && !Array.isArray(fixture) ? fixture : {};
  const requestedStatus = `${safeFixture.status || ""}`.trim().toLowerCase();
  const requestedLifecycle = `${safeFixture.lifecycle || ""}`.trim().toLowerCase();
  const status = CERTIFIED_READ_STATUS_KEYS.has(requestedStatus) ? requestedStatus : "unknown";
  const lifecycle = CERTIFIED_READ_LIFECYCLE_KEYS.has(requestedLifecycle) ? requestedLifecycle : "";

  if (lifecycle && CERTIFIED_READ_REQUIRES_AVAILABLE_LIFECYCLE_KEYS.has(lifecycle) && status !== "available") {
    return { status: "unknown", lifecycle: "outcome_unknown" };
  }
  return { status, lifecycle };
}

function certifiedReadUiPresentation(fixture = {}) {
  const normalized = normalizeCertifiedReadFixture(fixture);
  return {
    status: certifiedReadStatusPresentation(normalized.status),
    lifecycle: certifiedReadLifecyclePresentation(normalized.lifecycle)
  };
}

function certifiedReadEnvelopeUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hasStatus = Object.prototype.hasOwnProperty.call(value, "status");
  const hasLifecycle = Object.prototype.hasOwnProperty.call(value, "lifecycle");
  if (!hasStatus && !hasLifecycle) return null;
  const update = {};
  if (hasStatus) {
    const status = `${value.status || ""}`.trim().toLowerCase();
    update.status = CERTIFIED_READ_STATUS_KEYS.has(status) ? status : "unknown";
  }
  if (hasLifecycle) {
    const lifecycle = `${value.lifecycle || ""}`.trim().toLowerCase();
    update.lifecycle = CERTIFIED_READ_LIFECYCLE_KEYS.has(lifecycle) ? lifecycle : "";
  }
  return hasStatus && hasLifecycle ? normalizeCertifiedReadFixture(update) : update;
}

function certifiedReadFixtureFromPresentation(presentation = {}) {
  return normalizeCertifiedReadFixture({
    status: CERTIFIED_READ_STATUS_KEYS.has(presentation?.status?.key) ? presentation.status.key : "unknown",
    lifecycle: CERTIFIED_READ_LIFECYCLE_KEYS.has(presentation?.lifecycle?.key) ? presentation.lifecycle.key : ""
  });
}

function nextCertifiedReadUiFixture(currentPresentation, envelope, missingPolicy = "preserve") {
  const current = certifiedReadFixtureFromPresentation(currentPresentation);
  const update = certifiedReadEnvelopeUpdate(envelope);
  if (!update) {
    if (missingPolicy === "reset") return { status: "unknown", lifecycle: "" };
    if (missingPolicy === "clear_lifecycle") return { ...current, lifecycle: "" };
    return null;
  }
  return normalizeCertifiedReadFixture({
    status: Object.prototype.hasOwnProperty.call(update, "status")
      ? update.status
      : missingPolicy === "reset" ? "unknown" : current.status,
    lifecycle: Object.prototype.hasOwnProperty.call(update, "lifecycle")
      ? update.lifecycle
      : missingPolicy === "reset" ? "" : current.lifecycle
  });
}

function certifiedReadConnectionLossFixture(currentPresentation) {
  const current = certifiedReadFixtureFromPresentation(currentPresentation);
  if (!CERTIFIED_READ_BUSY_LIFECYCLE_KEYS.has(current.lifecycle)) return null;
  return { status: "unknown", lifecycle: "outcome_unknown" };
}

function certifiedReadSseFixture(currentPresentation, eventName, payload = {}) {
  const fromServer = nextCertifiedReadUiFixture(currentPresentation, payload?.certifiedReadUi, "preserve");
  if (fromServer) return fromServer;
  const event = `${eventName || ""}`.trim().toLowerCase();
  if (event === "chat.start" && currentPresentation?.lifecycle?.key !== "outcome_unknown") {
    return nextCertifiedReadUiFixture(currentPresentation, null, "clear_lifecycle");
  }
  if (["done", "error"].includes(event)) {
    return certifiedReadConnectionLossFixture(currentPresentation);
  }
  return null;
}

function certifiedReadComputerStateFixture(currentPresentation, payload = {}) {
  const fromServer = nextCertifiedReadUiFixture(currentPresentation, payload?.certifiedReadUi, "preserve");
  if (fromServer) return fromServer;
  if (payload?.running === false) {
    return certifiedReadConnectionLossFixture(currentPresentation);
  }
  return null;
}

async function consumeAuthoritativeBackendSse(reader, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        const terminal = onEvent({ event: currentEvent, data: currentData });
        currentEvent = "message";
        currentData = [];
        if (terminal) return;
        continue;
      }

      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        currentData.push(line.slice(5).trim());
      }
    }
  }

  const error = new Error("Backend stream ended before an authoritative terminal event.");
  error.code = "BACKEND_STREAM_TRUNCATED";
  throw error;
}
// TESTABLE_CERTIFIED_READ_UX_END

const elements = {
  messages: document.querySelector("#messages"),
  chatPane: document.querySelector("#chatPane"),
  chatScroll: document.querySelector("#chatScroll"),
  events: document.querySelector("#events"),
  statusText: document.querySelector("#statusText"),
  statusPill: document.querySelector("#statusPill"),
  backendRetryButton: null,
  sessionBadge: document.querySelector("#sessionBadge"),
  runtimeProfileBadge: document.querySelector("#runtimeProfileBadge"),
  runtimeProfileSummary: document.querySelector("#runtimeProfileSummary"),
  authBadge: document.querySelector("#authBadge"),
  environmentBadge: document.querySelector("#environmentBadge"),
  certifiedReadPanel: document.querySelector("#certifiedReadPanel"),
  certifiedReadStatusLabel: document.querySelector("#certifiedReadStatusLabel"),
  certifiedReadStatusSummary: document.querySelector("#certifiedReadStatusSummary"),
  certifiedReadWritesCopy: document.querySelector("#certifiedReadWritesCopy"),
  certifiedReadLifecycle: document.querySelector("#certifiedReadLifecycle"),
  certifiedReadLifecycleLabel: document.querySelector("#certifiedReadLifecycleLabel"),
  certifiedReadLifecycleSummary: document.querySelector("#certifiedReadLifecycleSummary"),
  writeGrantBadge: document.querySelector("#writeGrantBadge"),
  writeGrantMode: document.querySelector("#writeGrantMode"),
  authSignInButton: document.querySelector("#authSignInButton"),
  computerBadge: document.querySelector("#computerBadge"),
  shellBadge: document.querySelector("#shellBadge"),
  inputBadge: document.querySelector("#inputBadge"),
  showWork: document.querySelector("#showWork"),
  agentModel: document.querySelector("#agentModel"),
  agentReasoning: document.querySelector("#agentReasoning"),
  backendText: document.querySelector("#backendText"),
  screenMeta: document.querySelector("#screenMeta"),
  screenFrame: document.querySelector("#screenFrame"),
  screenImage: document.querySelector("#screenImage"),
  screenDialog: document.querySelector("#screenDialog"),
  screenDialogImage: document.querySelector("#screenDialogImage"),
  closeScreenDialogButton: document.querySelector("#closeScreenDialogButton"),
  authDialog: document.querySelector("#authDialog"),
  authForm: document.querySelector("#authForm"),
  authEmailInput: document.querySelector("#authEmailInput"),
  authPasswordInput: document.querySelector("#authPasswordInput"),
  authStatusSummary: document.querySelector("#authStatusSummary"),
  authSubmitButton: document.querySelector("#authSubmitButton"),
  authLogoutButton: document.querySelector("#authLogoutButton"),
  authCancelButton: document.querySelector("#authCancelButton"),
  authErrorText: document.querySelector("#authErrorText"),
  runSummary: document.querySelector("#runSummary"),
  runProgressBar: document.querySelector("#runProgressBar"),
  runProgressFill: document.querySelector("#runProgressFill"),
  runProgressMeta: document.querySelector("#runProgressMeta"),
  environmentSummary: document.querySelector("#environmentSummary"),
  environmentDetailsBody: document.querySelector("#environmentDetailsBody"),
  environmentDetailsToggle: document.querySelector("#environmentDetailsToggle"),
  environmentRefreshButton: document.querySelector("#environmentRefreshButton"),
  demoReadinessButton: document.querySelector("#demoReadinessButton"),
  copyDiagnosticsButton: document.querySelector("#copyDiagnosticsButton"),
  clearEnvironmentButton: document.querySelector("#clearEnvironmentButton"),
  environmentActionsBottom: document.querySelector(".environmentActionsBottom"),
  artifacts: document.querySelector("#artifacts"),
  artifactPreview: document.querySelector("#artifactPreview"),
  batchTemplateMeta: document.querySelector("#batchTemplateMeta"),
  batchJobTypeSelect: document.querySelector("#batchJobTypeSelect"),
  batchTitleInput: document.querySelector("#batchTitleInput"),
  batchTaskPromptInput: document.querySelector("#batchTaskPromptInput"),
  batchScopeInput: document.querySelector("#batchScopeInput"),
  batchWorkItemHintInput: document.querySelector("#batchWorkItemHintInput"),
  batchRoomNumbersInput: document.querySelector("#batchRoomNumbersInput"),
  batchLevelInput: document.querySelector("#batchLevelInput"),
  batchRoomNameInput: document.querySelector("#batchRoomNameInput"),
  batchViewHintInput: document.querySelector("#batchViewHintInput"),
  batchOutputFolderInput: document.querySelector("#batchOutputFolderInput"),
  batchFilePatternInput: document.querySelector("#batchFilePatternInput"),
  batchSampleCountInput: document.querySelector("#batchSampleCountInput"),
  batchImageSizeInput: document.querySelector("#batchImageSizeInput"),
  batchMaxRoomsInput: document.querySelector("#batchMaxRoomsInput"),
  batchPlanButton: document.querySelector("#batchPlanButton"),
  batchResetButton: document.querySelector("#batchResetButton"),
  batchJobs: document.querySelector("#batchJobs"),
  assignmentPane: document.querySelector("#assignmentPane"),
  assignmentInputs: document.querySelector("#assignmentInputs"),
  assignmentKicker: document.querySelector("#assignmentKicker"),
  assignmentHeading: document.querySelector("#assignmentHeading"),
  assignmentStatus: document.querySelector("#assignmentStatus"),
  assignmentCompact: document.querySelector("#assignmentCompact"),
  assignmentCompactStatus: document.querySelector("#assignmentCompactStatus"),
  assignmentCompactTitle: document.querySelector("#assignmentCompactTitle"),
  assignmentCompactStep: document.querySelector("#assignmentCompactStep"),
  assignmentCompactToggle: document.querySelector("#assignmentCompactToggle"),
  assignmentContext: document.querySelector("#assignmentContext"),
  assignmentProgressBar: document.querySelector("#assignmentProgressBar"),
  assignmentProgressFill: document.querySelector("#assignmentProgressFill"),
  assignmentProgressText: document.querySelector("#assignmentProgressText"),
  assignmentPlan: document.querySelector("#assignmentPlan"),
  assignmentPlanList: document.querySelector("#assignmentPlanList"),
  assignmentBlocker: document.querySelector("#assignmentBlocker"),
  assignmentAssumptions: document.querySelector("#assignmentAssumptions"),
  assignmentAssumptionList: document.querySelector("#assignmentAssumptionList"),
  workReturn: document.querySelector("#workReturn"),
  workReturnContent: document.querySelector("#workReturnContent"),
  verifiedWorkPacket: document.querySelector("#verifiedWorkPacket"),
  verifiedWorkPacketContent: document.querySelector("#verifiedWorkPacketContent"),
  goalSummary: document.querySelector("#goalSummary"),
  goalList: document.querySelector("#goalList"),
  goalReturnCurrentButton: document.querySelector("#goalReturnCurrentButton"),
  goalOpenSavedTaskButton: document.querySelector("#goalOpenSavedTaskButton"),
  goalLog: document.querySelector("#goalLog"),
  goalForm: document.querySelector("#goalForm"),
  goalNewButton: document.querySelector("#goalNewButton"),
  goalPauseButton: document.querySelector("#goalPauseButton"),
  goalResumeButton: document.querySelector("#goalResumeButton"),
  goalRecoverButton: document.querySelector("#goalRecoverButton"),
  goalAuditButton: document.querySelector("#goalAuditButton"),
  goalCancelButton: document.querySelector("#goalCancelButton"),
  goalTitleInput: document.querySelector("#goalTitleInput"),
  goalObjectiveInput: document.querySelector("#goalObjectiveInput"),
  goalCriteriaInput: document.querySelector("#goalCriteriaInput"),
  goalNonGoalsInput: document.querySelector("#goalNonGoalsInput"),
  goalCreateButton: document.querySelector("#goalCreateButton"),
  attachStrip: document.querySelector("#attachStrip"),
  feedbackBar: document.querySelector("#feedbackBar"),
  fbWorked: document.querySelector("#fbWorked"),
  fbPartial: document.querySelector("#fbPartial"),
  fbFailed: document.querySelector("#fbFailed"),
  fbNote: document.querySelector("#fbNote"),
  attachButton: document.querySelector("#attachButton"),
  attachInput: document.querySelector("#attachInput"),
  promptInput: document.querySelector("#promptInput"),
  chatForm: document.querySelector("#chatForm"),
  sendButton: document.querySelector("#sendButton"),
  recStartButton: document.querySelector("#recStartButton"),
  recStopButton: document.querySelector("#recStopButton"),
  micDeviceSelect: document.querySelector("#micDeviceSelect"),
  micLevelText: document.querySelector("#micLevelText"),
  speakButton: document.querySelector("#speakButton"),
  stopButton: document.querySelector("#stopButton"),
  newSessionButton: document.querySelector("#newSessionButton"),
  switchDisplayButton: document.querySelector("#switchDisplayButton"),
  refreshScreenButton: document.querySelector("#refreshScreenButton")
};

// TESTABLE_DESKTOP_PREVIEW_POLICY_START
function desktopPreviewCaptureBlocked(computerRunSubmissionPending, desktopCaptureSuppressed) {
  return !!computerRunSubmissionPending || !!desktopCaptureSuppressed;
}

function nextDesktopPreviewCaptureState(current, event, serverSuppressed = false) {
  if (event === "submission_started") return { pending: true, suppressed: true };
  if (event === "submission_resolved") return { pending: false, suppressed: !!serverSuppressed };
  if (event === "cleared") return { pending: false, suppressed: false };
  return {
    pending: !!current.pending,
    suppressed: current.pending ? !!current.suppressed : !!serverSuppressed
  };
}
// TESTABLE_DESKTOP_PREVIEW_POLICY_END

// TESTABLE_COMPUTER_MESSAGE_POLICY_START
function normalizePendingComputerUserMessages(pendingUserMessages) {
  if (Array.isArray(pendingUserMessages)) return pendingUserMessages.filter((message) => message?.id);
  return pendingUserMessages?.id ? [pendingUserMessages] : [];
}

function reconcileComputerMessages(serverMessages, pendingUserMessages) {
  const messages = Array.isArray(serverMessages) ? serverMessages : [];
  const pending = normalizePendingComputerUserMessages(pendingUserMessages);
  const remaining = pending.filter((pendingMessage) => !messages.some((message) =>
    message?.role === "user" && message?.id === pendingMessage.id
  ));
  return {
    messages: remaining.length > 0 ? [...messages, ...remaining] : messages,
    pendingUserMessages: remaining,
    pendingUserMessage: remaining.at(-1) || null
  };
}
// TESTABLE_COMPUTER_MESSAGE_POLICY_END

// TESTABLE_CHAT_SUBMISSION_POLICY_START
function nextOptimisticChatSubmissionState(current, submission) {
  const message = {
    id: submission.id,
    role: "user",
    text: submission.text,
    attachments: submission.attachments.map((attachment) => ({ ...attachment }))
  };
  const backend = submission.mode === "backend";
  return {
    activeRunKind: backend ? "backend" : "computer",
    message,
    backendMessages: backend ? [...current.backendMessages, message] : current.backendMessages,
    computerMessages: backend ? current.computerMessages : [...current.computerMessages, message],
    pendingComputerUserMessages: backend
      ? current.pendingComputerUserMessages
      : [...current.pendingComputerUserMessages, message]
  };
}
// TESTABLE_CHAT_SUBMISSION_POLICY_END

function applyDesktopPreviewCaptureState(event, serverSuppressed = false) {
  const next = nextDesktopPreviewCaptureState({
    pending: state.computerRunSubmissionPending,
    suppressed: state.desktopCaptureSuppressed
  }, event, serverSuppressed);
  state.computerRunSubmissionPending = next.pending;
  state.desktopCaptureSuppressed = next.suppressed;
}

function setStatus(text) {
  elements.statusText.textContent = conciseStatus(text);
  updateStatusTone();
}

function showComposerNotice(text, refresh = false) {
  let notice = document.getElementById("composerNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "composerNotice";
    notice.setAttribute("role", "alert");
    elements.chatForm.appendChild(notice);
  }
  notice.replaceChildren();
  const copy = document.createElement("span");
  copy.textContent = text;
  notice.appendChild(copy);
  notice.hidden = !text;
  if (refresh) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Refresh";
    button.addEventListener("click", async () => {
      await refreshComposerPage();
    });
    notice.appendChild(button);
  }
}

async function refreshComposerPage() {
  if (!await persistComposerDraft()) return showComposerNotice(staleComposerNotice(false));
  try {
    saveComposerRefreshTarget(sessionStorage, composerDraftKey, state.sessionId);
    window.location.reload();
  } catch { showComposerNotice(staleComposerNotice(false)); }
}

async function restoreComposerAfterRefresh() {
  try {
    const target = readComposerRefreshTarget(sessionStorage, composerDraftKey);
    if (!target) return;
    if (target.sessionId) await openTaskConversation({ session_id: target.sessionId });
    else await restoreComposerDraft();
    if (state.sessionId === target.sessionId) clearComposerRefreshTarget(sessionStorage);
  } catch { /* Retain the saved draft and refresh target for a later recovery. */ }
}

async function persistComposerDraft() {
  if (composerDraftTimer) clearTimeout(composerDraftTimer);
  composerDraftTimer = null;
  try {
    const draft = { text: elements.promptInput.value, attachments: [...state.pendingAttachments], sessionId: state.sessionId };
    const key = await taskDraftKey(composerDraftKey, draft.sessionId);
    await composerDraftStore.save(key, draft);
    return true;
  } catch { return false; }
}

function scheduleComposerDraftSave() {
  composerDraftRevision++;
  if (composerDraftTimer) clearTimeout(composerDraftTimer);
  composerDraftTimer = setTimeout(() => void persistComposerDraft(), 250);
}

async function restoreComposerDraft() {
  const revision = composerDraftRevision;
  try {
    const sessionId = state.sessionId;
    const key = await taskDraftKey(composerDraftKey, sessionId);
    let draft = await composerDraftStore.load(key);
    if (!draft) {
      const legacy = await composerDraftStore.load(composerDraftKey);
      if (legacy?.sessionId === sessionId) { draft = legacy; await composerDraftStore.save(key, legacy); await composerDraftStore.clear(composerDraftKey); }
    }
    const direction = await composerDraftStore.load(await taskDraftKey("steer-" + composerDraftKey, sessionId));
    if (revision !== composerDraftRevision || state.sessionId !== sessionId) return;
    let command = null;
    try { command = direction ? JSON.parse(direction.text) : null; } catch {}
    state.pendingCheckpointDirection = command?.checkpoint && command.session_id === sessionId ? command : null;
    if (!draft || revision !== composerDraftRevision || elements.promptInput.value || state.pendingAttachments.length) return;
    if (draft.sessionId && draft.sessionId !== state.sessionId) return;
    elements.promptInput.value = draft.text;
    state.pendingAttachments = draft.attachments;
    renderAttachStrip();
    updateFeedbackBarVisibility();
  } catch { /* An unavailable recovery store does not block starting a chat. */ }
}

async function showStaleComposerNotice() {
  const saved = await persistComposerDraft();
  showComposerNotice(staleComposerNotice(saved), saved);
  setStatus("Refresh required");
}

function renderRuntimeProfile(profile = state.runtimeProfile, backendAvailable = true) {
  const presentation = runtimeProfilePresentation(profile, backendAvailable);
  if (elements.runtimeProfileBadge) {
    elements.runtimeProfileBadge.textContent = presentation.label;
    elements.runtimeProfileBadge.className = `badge capabilityBadge ${presentation.tone}`;
    elements.runtimeProfileBadge.title = presentation.summary;
  }
  if (elements.runtimeProfileSummary) elements.runtimeProfileSummary.textContent = presentation.summary;
  return presentation;
}

function renderCertifiedReadUi(fixture = {}) {
  const presentation = certifiedReadUiPresentation(fixture);
  state.certifiedReadUi = presentation;
  if (!elements.certifiedReadPanel) return presentation;

  elements.certifiedReadPanel.className = `certifiedReadPanel ${presentation.status.tone}`;
  elements.certifiedReadStatusLabel.textContent = presentation.status.label;
  elements.certifiedReadStatusSummary.textContent = presentation.status.summary;
  elements.certifiedReadWritesCopy.textContent = presentation.status.writesCopy;
  elements.certifiedReadWritesCopy.hidden = !presentation.status.writesCopy;

  const lifecycle = presentation.lifecycle;
  elements.certifiedReadLifecycle.hidden = !lifecycle;
  elements.certifiedReadLifecycle.setAttribute("aria-busy", lifecycle?.busy ? "true" : "false");
  elements.certifiedReadLifecycle.className = `certifiedReadLifecycle ${lifecycle?.tone || "tone-neutral"}`;
  elements.certifiedReadLifecycleLabel.textContent = lifecycle?.label || "";
  elements.certifiedReadLifecycleSummary.textContent = lifecycle?.summary || "";
  return presentation;
}

function renderNextCertifiedReadUi(fixture) {
  if (!fixture) return state.certifiedReadUi;
  const next = certifiedReadUiPresentation(fixture);
  if (state.certifiedReadUi
    && state.certifiedReadUi.status.key === next.status.key
    && state.certifiedReadUi.lifecycle?.key === next.lifecycle?.key) {
    return state.certifiedReadUi;
  }
  return renderCertifiedReadUi(fixture);
}

function clearCertifiedReadLifecycle() {
  if (state.certifiedReadUi?.lifecycle?.key === "outcome_unknown") return state.certifiedReadUi;
  return renderNextCertifiedReadUi(nextCertifiedReadUiFixture(state.certifiedReadUi, null, "clear_lifecycle"));
}

function ensureBackendRetryButton() {
  if (elements.backendRetryButton) return elements.backendRetryButton;
  const button = document.createElement("button");
  button.id = "backendRetryButton";
  button.type = "button";
  button.textContent = "Retry backend";
  button.title = "Retry the Sidecar backend connection.";
  button.hidden = true;
  button.addEventListener("click", () => void retryBackendBootstrap());
  elements.statusPill.insertAdjacentElement("afterend", button);
  elements.backendRetryButton = button;
  return button;
}

function renderBackendBootstrapState(config = {}, error = null) {
  const presentation = backendBootstrapPresentation(config, error);
  const retryButton = ensureBackendRetryButton();
  retryButton.hidden = !presentation.retryVisible;
  retryButton.disabled = state.backendBootstrapBusy;
  renderRuntimeProfile(state.runtimeProfile, !presentation.degraded);
  setStatus(sidecarHealthStatusText(presentation));

  if (state.backendBootstrapRetryTimer) clearTimeout(state.backendBootstrapRetryTimer);
  state.backendBootstrapRetryTimer = null;
  if (presentation.degraded) {
    state.backendBootstrapRetryTimer = setTimeout(() => void retryBackendBootstrap({ automatic: true }), BACKEND_BOOTSTRAP_RETRY_MS);
  }
  return presentation;
}

function renderWriteGrantStatus() {
  if (!elements.writeGrantBadge || !elements.writeGrantMode) return;
  const grant = state.writeGrantStatus || {};
  const active = grant.active === true;
  const mode = active ? `${grant.mode || "session"}`.trim().toLowerCase() : "off";
  elements.writeGrantBadge.textContent = active ? "Model changes allowed" : "Read only";
  elements.writeGrantBadge.className = `badge ${active ? (mode === "yolo" ? "tone-warning" : "tone-positive") : "tone-neutral"}`;
  elements.writeGrantBadge.title = active && grant.expires_at_utc
    ? `Revit write grant expires ${grant.expires_at_utc}`
    : `${grant.error || "Revit write access is disabled."}`;
  if (!state.writeGrantBusy) elements.writeGrantMode.value = ["once", "session", "yolo"].includes(mode) ? mode : "off";
  elements.writeGrantMode.disabled = state.writeGrantBusy;
}

async function refreshWriteGrantStatus() {
  state.writeGrantStatus = await fetchJson("/api/revit/write-grant");
  renderWriteGrantStatus();
  return state.writeGrantStatus;
}

async function setWriteGrantMode(mode) {
  state.writeGrantBusy = true;
  renderWriteGrantStatus();
  try {
    state.writeGrantStatus = await fetchJson("/api/revit/write-grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
    renderWriteGrantStatus();
  } finally {
    state.writeGrantBusy = false;
    renderWriteGrantStatus();
  }
}

function scheduleWriteGrantPolling() {
  if (state.writeGrantTimer) clearInterval(state.writeGrantTimer);
  state.writeGrantTimer = setInterval(() => refreshWriteGrantStatus().catch(() => null), 5000);
}

function activeMessages() {
  if (state.activeRunKind === "backend") return state.backendMessages;
  if (state.activeRunKind === "computer" || state.computerMessages.length > 0) return state.computerMessages;
  return state.backendMessages;
}

function splitAssistantControlText(text) {
  let remaining = `${text || ""}`.trim();
  let plan = "";
  const planMatch = remaining.match(/^Plan:\s*([\s\S]*?)(?:\n\s*\n(?=Answer:)|$)/i);
  if (planMatch) {
    plan = `${planMatch[1] || ""}`.trim();
    remaining = remaining.slice(planMatch[0].length).trim();
  }
  remaining = remaining.replace(/^Answer:\s*/i, "").trim();
  return { plan, text: remaining };
}

function latestAssistantMessage() {
  for (let index = state.backendMessages.length - 1; index >= 0; index -= 1) {
    const message = state.backendMessages[index];
    if (message?.role === "assistant" && splitAssistantControlText(message?.text).text) {
      return message;
    }
  }
  for (let index = state.computerMessages.length - 1; index >= 0; index -= 1) {
    const message = state.computerMessages[index];
    if (message?.role === "assistant" && splitAssistantControlText(message?.text).text) {
      return message;
    }
  }
  return null;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function defaultBatchDraft() {
  return {
    job_type: "delegated_revit_task_batch",
    title: "Run a repeated Revit task across a scope",
    task_prompt: "",
    scope_description: "",
    work_item_hint: "",
    room_numbers: "",
    level_name: "",
    room_name_includes: "",
    view_name_hint: "coord",
    output_folder_relative: "artifacts/revit-batch/exports/room-captures",
    file_name_pattern: "{roomNumber}_{viewName}",
    sample_count: 3,
    image_size: 2048,
    max_rooms: 200
  };
}

function normalizeBatchTemplateClient(template) {
  if (!template || typeof template !== "object") return null;
  return {
    job_type: `${template.job_type || ""}`.trim() || "delegated_revit_task_batch",
    title: `${template.title || ""}`.trim(),
    description: `${template.description || ""}`.trim(),
    task_prompt: `${template.task_prompt || ""}`.trim(),
    scope_description: `${template.scope_description || ""}`.trim(),
    work_item_hint: `${template.work_item_hint || ""}`.trim(),
    room_numbers: Array.isArray(template.room_numbers) ? template.room_numbers.map((item) => `${item || ""}`.trim()).filter(Boolean) : [],
    level_name: `${template.level_name || ""}`.trim(),
    room_name_includes: Array.isArray(template.room_name_includes) ? template.room_name_includes.map((item) => `${item || ""}`.trim()).filter(Boolean) : [],
    view_name_hint: `${template.view_name_hint || ""}`.trim(),
    output_folder_relative: `${template.output_folder_relative || ""}`.trim(),
    file_name_pattern: `${template.file_name_pattern || ""}`.trim(),
    sample_count: Number.parseInt(`${template.sample_count ?? 3}`, 10) || 3,
    image_size: Number.parseInt(`${template.image_size ?? 2048}`, 10) || 2048,
    max_rooms: Number.parseInt(`${template.max_rooms ?? 200}`, 10) || 200,
    max_items: Number.parseInt(`${template.max_items ?? 50}`, 10) || 50,
    per_item_max_rounds: Number.parseInt(`${template.per_item_max_rounds ?? 8}`, 10) || 8,
    success_checks: Array.isArray(template.success_checks) ? template.success_checks.map((item) => `${item || ""}`.trim()).filter(Boolean) : []
  };
}

function attachmentMeta(attachment) {
  const bits = [];
  if (attachment?.mimeType) bits.push(attachment.mimeType);
  if (attachment?.sizeBytes) bits.push(formatBytes(attachment.sizeBytes));
  return bits.join("  ");
}

function renderAttachStrip() {
  elements.attachStrip.innerHTML = "";
  if (!state.pendingAttachments.length) return;

  for (const attachment of state.pendingAttachments) {
    const item = document.createElement("div");
    item.className = "attachItem";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = attachment.name;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = attachmentMeta(attachment);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.pendingAttachments = state.pendingAttachments.filter((entry) => entry.id !== attachment.id);
      renderAttachStrip();
      scheduleComposerDraftSave();
    });

    item.appendChild(name);
    if (meta.textContent) item.appendChild(meta);
    item.appendChild(remove);
    elements.attachStrip.appendChild(item);
  }
}

function renderMessages() {
  renderSessionStartScreen();
  elements.messages.innerHTML = "";
  const messages = activeMessages();
  const copy = state.checkedProjectCopy;
  const liveCopy = state.activeRunKind !== "backend" && copy?.sessionId === state.sessionId
    && copy.epoch === state.taskNavigationEpoch ? copy.message : null;
  for (const message of liveCopy ? [...messages, liveCopy] : messages) {
    const normalizedRole = message.role === "user" ? "user" : message.role === "error" ? "error" : "assistant";
    const assistantParts = normalizedRole === "assistant" ? splitAssistantControlText(message.text) : null;
    const messageText = assistantParts ? assistantParts.text : `${message.text || ""}`;
    if (normalizedRole === "assistant" && !messageText) continue;

    const article = document.createElement("article");
    article.className = `msg ${normalizedRole}`;

    const role = document.createElement("div");
    role.className = "role";
    role.textContent = normalizedRole === "user" ? "You" : normalizedRole === "error" ? "Error" : "Operator";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (normalizedRole === "assistant") renderAssistantBlocks(bubble, messageText, renderLinkedText);
    else renderLinkedText(bubble, messageText);

    article.appendChild(role);
    article.appendChild(bubble);

    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      const attachments = document.createElement("div");
      attachments.className = "messageAttachments";
      for (const attachment of message.attachments) {
        const chip = document.createElement("span");
        chip.className = "messageAttachment";
        chip.textContent = attachment.name || attachment.filename || "Attachment";
        attachments.appendChild(chip);
      }
      article.appendChild(attachments);
    }

    elements.messages.appendChild(article);
  }
  updateFeedbackBarVisibility();
  scrollMessagesToBottom();
}

function renderLinkedText(container, text) {
  container.innerHTML = "";
  for (const part of linkedTextParts(text)) {
    if (Object.hasOwn(part, "text")) { appendInlineText(container, part.text); continue; }
    const { href, label } = part;
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (isLocalFileLink(href)) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openLocalPath(href).catch((error) => {
          appendActivityEvent(`Could not open file link: ${error.message || error}`, "", { tone: "tone-danger" });
          renderEvents();
        });
      });
    }
    container.appendChild(link);
  }
}

function cleanLinkHref(value) {
  let href = `${value || ""}`.trim();
  while (/[),.;:]$/.test(href)) href = href.slice(0, -1);
  if (/^[A-Za-z]:\\/.test(href)) {
    return `file:///${href.replace(/\\/g, "/")}`;
  }
  return href;
}

function isLocalFileLink(href) {
  return /^file:\/\/\//i.test(`${href || ""}`);
}

async function openLocalPath(href) {
  if (!href) return;
  await fetchJson("/api/open-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: href })
  });
}

function scrollMessagesToBottom() {
  const scrollHost = elements.chatScroll || elements.messages.parentElement;
  if (!scrollHost) return;

  const scroll = () => {
    elements.messages.lastElementChild?.scrollIntoView({ block: "end", inline: "nearest" });
    scrollHost.scrollTop = elements.messages.lastElementChild ? scrollHost.scrollHeight : 0;
  };

  scroll();
  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  });
}

if (elements.messages && window.MutationObserver) {
  new MutationObserver(() => scrollMessagesToBottom()).observe(elements.messages, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function renderEvents() {
  const shouldStickToBottom =
    elements.events.scrollHeight - elements.events.scrollTop - elements.events.clientHeight < 32;
  elements.events.innerHTML = "";
  const events = state.computerEvents;
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "event empty";
    empty.textContent = "No live activity yet.";
    elements.events.appendChild(empty);
    return;
  }

  for (const entry of events) {
    const el = document.createElement("div");
    el.className = `event ${entry.tone || "tone-neutral"}`.trim();

    if (entry.time) {
      const header = document.createElement("div");
      header.className = "eventHeader";

      const time = document.createElement("span");
      time.className = "eventTime";
      time.textContent = entry.time;

      header.appendChild(time);
      el.appendChild(header);
    }

    const body = document.createElement("div");
    body.className = "eventText";
    body.textContent = entry.text;
    el.appendChild(body);

    if (entry.url) {
      const link = document.createElement("a");
      link.className = "eventLink";
      link.href = entry.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = entry.urlLabel || "Open";
      el.appendChild(link);
    }

    elements.events.appendChild(el);
  }

  if (shouldStickToBottom) {
    elements.events.scrollTop = elements.events.scrollHeight;
  }
}

function formatElapsed(iso) {
  if (!iso) return "";
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return "";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// TESTABLE_CURRENT_ACTIVITY_POLICY_START
function focusedActiveBatchJob(jobs, focusedBatchJobId) {
  const normalizedJobs = Array.isArray(jobs) ? jobs : [];
  const focusedId = `${focusedBatchJobId || ""}`.trim();
  if (!focusedId) return null;
  const priority = ["running", "queued", "awaiting_approval", "paused"];
  for (const key of priority) {
    const match = normalizedJobs.find(
      (job) => `${job?.id || ""}`.trim() === focusedId && `${job?.status || ""}`.trim().toLowerCase() === key
    );
    if (match) return match;
  }
  return null;
}

function environmentBadgePresentation(statusKey, backendLocal, preferredOutputDir) {
  const label = statusKey === "ready" ? "Ready" : statusKey === "unavailable" ? "Unavailable" : statusKey === "needs_setup" ? "Needs setup" : "Unknown";
  const scope = backendLocal ? "Environment" : "Hosted service";
  const preferred = `${preferredOutputDir || ""}`.trim();
  const title = !preferred
    ? ""
    : backendLocal
      ? preferred
      : `Hosted backend output path: ${preferred}. This does not describe the Windows Revit workstation.`;
  return { text: `${scope} ${label}`, title };
}
// TESTABLE_CURRENT_ACTIVITY_POLICY_END

function activeBatchJob() {
  return focusedActiveBatchJob(state.batchJobs, state.focusedBatchJobId);
}

function renderScreenMeta() {
  const parts = [];
  const screen = state.computerScreen || {};
  applyScreenFrameLayout(screen);
  if (state.screenLoading) {
    parts.push("Refreshing desktop capture…");
  } else if (state.screenError) {
    parts.push(`Desktop capture failed: ${state.screenError}`);
  } else if (state.screenCapturedAt) {
    parts.push(`Last refreshed ${new Date(state.screenCapturedAt).toLocaleTimeString("en-US", { hour12: false })}`);
  } else {
    parts.push("Waiting for the first desktop capture.");
  }
  if (Number(screen.width) > 0 && Number(screen.height) > 0) {
    parts.push(`${screen.width}x${screen.height}`);
  }
  if (Number(screen.monitorCount) > 1) {
    parts.push(`${screen.monitorCount} monitors`);
  }
  elements.screenMeta.textContent = parts.join(" • ");
}

function computeDesktopPreviewAspectRatio(screen) {
  const monitors = normalizedMonitorRects(screen);
  if (monitors.length > 1) {
    const targetHeight = 210;
    const gap = 12;
    const totalWidth =
      monitors.reduce((sum, monitor) => sum + Math.max(1, Math.round((monitor.width / monitor.height) * targetHeight)), 0) +
      gap * Math.max(0, monitors.length - 1);
    return Math.max(1.8, Math.min(4.8, totalWidth / targetHeight));
  }

  const width =
    Number(screen?.width) > 0
      ? Number(screen.width)
      : Number(monitors[0]?.width) > 0
        ? Number(monitors[0].width)
        : 0;
  const height =
    Number(screen?.height) > 0
      ? Number(screen.height)
      : Number(monitors[0]?.height) > 0
        ? Number(monitors[0].height)
        : 0;
  if (width > 0 && height > 0) {
    return Math.max(1.2, Math.min(3.2, width / height));
  }
  return 1.6;
}

function applyScreenFrameLayout(screen) {
  if (!elements.screenFrame) return;
  const aspectRatio = computeDesktopPreviewAspectRatio(screen);
  const maxHeight =
    aspectRatio >= 3.4 ? 220 :
    aspectRatio >= 2.7 ? 240 :
    aspectRatio >= 2.1 ? 260 :
    280;
  elements.screenFrame.style.setProperty("--screen-aspect", `${aspectRatio}`);
  elements.screenFrame.style.setProperty("--screen-max-height", `${maxHeight}px`);
}

async function cropDarkScreenshotBorders(blob) {
  if (!(blob instanceof Blob) || typeof createImageBitmap !== "function") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height) return blob;

    const sampleWidth = Math.min(900, bitmap.width);
    const sampleHeight = Math.max(1, Math.round((bitmap.height / bitmap.width) * sampleWidth));
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleWidth;
    sampleCanvas.height = sampleHeight;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) return blob;
    sampleCtx.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
    const { data } = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight);

    const rowThreshold = Math.max(10, Math.floor(sampleWidth * 0.006));
    const colThreshold = Math.max(6, Math.floor(sampleHeight * 0.006));

    const rowActive = (rowIndex) => {
      let activePixels = 0;
      for (let x = 0; x < sampleWidth; x += 1) {
        const offset = (rowIndex * sampleWidth + x) * 4;
        const alpha = data[offset + 3];
        const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
        if (alpha > 20 && luminance > 14) activePixels += 1;
      }
      return activePixels >= rowThreshold;
    };

    const colActive = (colIndex) => {
      let activePixels = 0;
      for (let y = 0; y < sampleHeight; y += 1) {
        const offset = (y * sampleWidth + colIndex) * 4;
        const alpha = data[offset + 3];
        const luminance = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
        if (alpha > 20 && luminance > 14) activePixels += 1;
      }
      return activePixels >= colThreshold;
    };

    let top = 0;
    while (top < sampleHeight - 1 && !rowActive(top)) top += 1;
    let bottom = sampleHeight - 1;
    while (bottom > top && !rowActive(bottom)) bottom -= 1;
    let left = 0;
    while (left < sampleWidth - 1 && !colActive(left)) left += 1;
    let right = sampleWidth - 1;
    while (right > left && !colActive(right)) right -= 1;

    const cropWidth = right - left + 1;
    const cropHeight = bottom - top + 1;
    if (cropWidth <= 0 || cropHeight <= 0) return blob;

    const widthRatio = cropWidth / sampleWidth;
    const heightRatio = cropHeight / sampleHeight;
    if (widthRatio > 0.94 && heightRatio > 0.94) return blob;

    const sourceX = Math.max(0, Math.floor((left / sampleWidth) * bitmap.width));
    const sourceY = Math.max(0, Math.floor((top / sampleHeight) * bitmap.height));
    const sourceWidth = Math.max(1, Math.ceil((cropWidth / sampleWidth) * bitmap.width));
    const sourceHeight = Math.max(1, Math.ceil((cropHeight / sampleHeight) * bitmap.height));

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = sourceWidth;
    cropCanvas.height = sourceHeight;
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) return blob;
    cropCtx.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );

    const croppedBlob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));
    return croppedBlob || blob;
  } finally {
    bitmap.close();
  }
}

function normalizedMonitorRects(screen) {
  const monitors = Array.isArray(screen?.monitors) ? screen.monitors : [];
  const originX = Number.isFinite(Number(screen?.x)) ? Number(screen.x) : 0;
  const originY = Number.isFinite(Number(screen?.y)) ? Number(screen.y) : 0;
  return monitors
    .map((monitor, index) => ({
      index: Number.isFinite(Number(monitor?.index)) ? Number(monitor.index) : index,
      primary: Boolean(monitor?.primary),
      x: Number.isFinite(Number(monitor?.x)) ? Number(monitor.x) - originX : 0,
      y: Number.isFinite(Number(monitor?.y)) ? Number(monitor.y) - originY : 0,
      width: Number.isFinite(Number(monitor?.width)) ? Number(monitor.width) : 0,
      height: Number.isFinite(Number(monitor?.height)) ? Number(monitor.height) : 0
    }))
    .filter((monitor) => monitor.width > 0 && monitor.height > 0);
}

async function buildDesktopPreviewBlob(blob, screen) {
  if (!(blob instanceof Blob) || typeof createImageBitmap !== "function") return blob;
  const monitors = normalizedMonitorRects(screen);
  if (monitors.length <= 1) {
    return await cropDarkScreenshotBorders(blob);
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const targetHeight = 210;
    const gap = 12;
    const scaled = monitors.map((monitor) => {
      const scale = targetHeight / monitor.height;
      return {
        ...monitor,
        drawWidth: Math.max(1, Math.round(monitor.width * scale)),
        drawHeight: targetHeight
      };
    });
    const totalWidth = scaled.reduce((sum, monitor) => sum + monitor.drawWidth, 0) + gap * Math.max(0, scaled.length - 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, totalWidth);
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return await cropDarkScreenshotBorders(blob);
    }

    ctx.fillStyle = "#f7fbff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let offsetX = 0;
    for (const monitor of scaled) {
      ctx.drawImage(
        bitmap,
        monitor.x,
        monitor.y,
        monitor.width,
        monitor.height,
        offsetX,
        0,
        monitor.drawWidth,
        monitor.drawHeight
      );
      offsetX += monitor.drawWidth + gap;
    }

    const previewBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return previewBlob || blob;
  } finally {
    bitmap.close();
  }
}

function renderRunSummary() {
  const progress = state.computerProgress || {};
  const batchJob = activeBatchJob();
  const goal = selectedGoal();
  let summary = "Idle. Ready for a new task.";
  let meta = goal ? goal.progress_summary || "Assignment is ready." : "No active operation.";
  let percent = null;
  let progressText = "Idle";

  if (state.streaming || progress.phase) {
    const phase = `${progress.phase || ""}`.trim().replace(/_/g, " ");
    const elapsed = formatElapsed(progress.startedAt);
    const currentAction = `${progress.currentAction || progress.lastEvent || ""}`.trim();

    if (state.streaming || (phase && phase !== "idle")) {
      summary = currentAction || (phase ? `Run ${phase}.` : "Run in progress.");
      const bits = [];
      if (phase) bits.push(`phase ${phase}`);
      if (elapsed) bits.push(`elapsed ${elapsed}`);
      if (`${progress.lastEvent || ""}`.trim()) bits.push(`latest ${progress.lastEvent}`);
      meta = bits.join(" • ") || "Run in progress.";
      progressText = currentAction || (phase ? `Operation ${phase}` : "Operation in progress");
    }
  }

  if ((!state.streaming && (!progress.phase || progress.phase === "idle")) && batchJob) {
    const counts = batchJob.item_summary || {};
    const total = Number(counts.total) || 0;
    const done = Number(counts.succeeded) || 0;
    const failed = Number(counts.failed) || 0;
    summary = batchJob.title || batchJob.id || "Batch job active";
    meta =
      `${batchStatusLabel(batchJob)} • ${done}/${total || "?"} complete` +
      `${failed ? ` • ${failed} failed` : ""}` +
      `${batchJob.output_folder_relative ? ` • ${batchJob.output_folder_relative}` : ""}`;
    percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    progressText = total > 0 ? `${done} of ${total} batch items complete` : batchStatusLabel(batchJob);
  }

  if (!state.streaming && !batchJob && state.computerError) {
    summary = "Run failed.";
    meta = state.computerError;
    progressText = "Operation failed";
  }

  if (goal?._projection?.truth?.reconciliation_required === true || goal?._projection?.truth?.outcome_uncertain === true) {
    summary = "Result needs checking.";
    meta = "A prior operation has an unconfirmed outcome. Verify or reconcile it before starting another model task.";
    progressText = "Reconciliation required";
    percent = null;
  }

  elements.runSummary.textContent = summary;
  elements.runProgressMeta.textContent = meta;
  elements.runProgressFill.style.width = `${percent ?? 0}%`;
  if (elements.runProgressBar) {
    elements.runProgressBar.setAttribute("aria-valuetext", progressText);
    if (percent === null) elements.runProgressBar.removeAttribute("aria-valuenow");
    else elements.runProgressBar.setAttribute("aria-valuenow", `${percent}`);
  }
}

function readScreenMetadataHeader(response) {
  const encoded = `${response?.headers?.get("x-operator-screen") || ""}`.trim();
  if (!encoded) return null;
  try {
    const json = atob(encoded);
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function setBatchDraftFromTemplate(template, source = null) {
  if (!elements.batchJobTypeSelect) return;
  const next = {
    ...defaultBatchDraft(),
    ...(normalizeBatchTemplateClient(template) || {})
  };
  elements.batchJobTypeSelect.value = next.job_type || "delegated_revit_task_batch";
  elements.batchTitleInput.value = next.title;
  elements.batchTaskPromptInput.value = next.task_prompt || "";
  elements.batchScopeInput.value = next.scope_description || "";
  elements.batchWorkItemHintInput.value = next.work_item_hint || "";
  elements.batchRoomNumbersInput.value = Array.isArray(next.room_numbers) ? next.room_numbers.join(", ") : `${next.room_numbers || ""}`;
  elements.batchLevelInput.value = next.level_name;
  elements.batchRoomNameInput.value = Array.isArray(next.room_name_includes) ? next.room_name_includes.join(", ") : `${next.room_name_includes || ""}`;
  elements.batchViewHintInput.value = next.view_name_hint;
  elements.batchOutputFolderInput.value = next.output_folder_relative;
  elements.batchFilePatternInput.value = next.file_name_pattern;
  elements.batchSampleCountInput.value = `${next.sample_count}`;
  elements.batchImageSizeInput.value = `${next.image_size}`;
  elements.batchMaxRoomsInput.value = `${next.max_rooms}`;
  state.batchDraftSource = source;
  renderBatchDraftMeta();
}

function renderBatchDraftMeta() {
  if (!elements.batchTemplateMeta || !elements.batchJobTypeSelect) return;
  const source = state.batchDraftSource;
  const jobType = `${elements.batchJobTypeSelect.value || "delegated_revit_task_batch"}`.trim();
  if (source?.skillId) {
    elements.batchTemplateMeta.textContent =
      `Using ${jobType === "delegated_revit_task_batch" ? "general" : "room-capture"} Teach batch template from ${source.skillName || source.skillId}.`;
    return;
  }
  elements.batchTemplateMeta.textContent =
    jobType === "delegated_revit_task_batch"
      ? "Using the general repeated Revit task template."
      : "Using the default room capture template.";
}

function batchStatusLabel(job) {
  const status = `${job?.status || "unknown"}`.trim().toLowerCase();
  if (status === "awaiting_approval") return "Awaiting approval";
  if (status === "succeeded_with_failures") return "Succeeded with failures";
  return status.replace(/_/g, " ");
}

function buildBatchPlanRequest() {
  if (!elements.batchJobTypeSelect) {
    throw new Error("Batch planning controls are not available in this sidecar build.");
  }
  const request = {
    job_type: elements.batchJobTypeSelect.value || "delegated_revit_task_batch",
    title: elements.batchTitleInput.value.trim(),
    task_prompt: elements.batchTaskPromptInput.value.trim(),
    scope_description: elements.batchScopeInput.value.trim(),
    work_item_hint: elements.batchWorkItemHintInput.value.trim(),
    room_numbers: elements.batchRoomNumbersInput.value,
    level_name: elements.batchLevelInput.value.trim(),
    room_name_includes: elements.batchRoomNameInput.value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    view_name_hint: elements.batchViewHintInput.value.trim(),
    output_folder_relative: elements.batchOutputFolderInput.value.trim(),
    file_name_pattern: elements.batchFilePatternInput.value.trim(),
    sample_count: Number.parseInt(elements.batchSampleCountInput.value, 10) || 3,
    image_size: Number.parseInt(elements.batchImageSizeInput.value, 10) || 2048,
    max_rooms: Number.parseInt(elements.batchMaxRoomsInput.value, 10) || 200,
    max_items: Number.parseInt(elements.batchMaxRoomsInput.value, 10) || 200,
    per_item_max_rounds: 8
  };
  if (state.batchDraftSource?.artifactId) request.artifact_id = state.batchDraftSource.artifactId;
  if (state.batchDraftSource?.skillId) request.skill_id = state.batchDraftSource.skillId;
  return request;
}

function renderBatchJobs() {
  if (!elements.batchJobs) return;
  elements.batchJobs.innerHTML = "";
  const jobs = Array.isArray(state.batchJobs) ? state.batchJobs : [];
  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event empty";
    empty.textContent = "No planned changes or approvals.";
    elements.batchJobs.appendChild(empty);
    return;
  }

  const activeStatuses = new Set(["planning", "awaiting_approval", "queued", "running", "pausing", "paused", "cancelling"]);
  const activeJobs = jobs.filter((job) => activeStatuses.has(`${job?.status || ""}`.trim().toLowerCase()));
  const visibleJobs = activeJobs.length > 0 ? activeJobs : jobs.slice(0, 2);

  for (const job of visibleJobs) {
    const statusKey = `${job.status || ""}`.trim().toLowerCase();
    const card = document.createElement("article");
    card.className = `batchJobCard ${statusKey === "awaiting_approval" ? "awaitingApproval" : ""}`.trim();

    const header = document.createElement("div");
    header.className = "batchJobHeader";

    const title = document.createElement("div");
    title.className = "batchJobTitle";
    title.textContent = job.title || job.id || "Batch job";
    title.id = `batch-job-${job.id || Math.random().toString(16).slice(2)}`;
    card.setAttribute("aria-labelledby", title.id);

    const status = document.createElement("div");
    status.className = "batchJobStatus";
    status.textContent = batchStatusLabel(job);

    header.appendChild(title);
    header.appendChild(status);

    const counts = job.item_summary || {};
    const targetDocument = `${job?.target_context?.document_title || ""}`.trim();
    const meta = document.createElement("div");
    meta.className = "batchJobMeta";
    meta.textContent =
      `${job.job_type === "delegated_revit_task_batch" ? "delegated batch" : "batch"}: items ${counts.succeeded || 0}/${counts.total || 0} complete` +
      `${counts.failed ? `, ${counts.failed} failed` : ""}` +
      `${targetDocument ? `, model ${targetDocument}` : ""}` +
      `${job.output_folder_relative ? `, output ${job.output_folder_relative}` : job.job_dir ? `, bundle ${job.job_dir}` : ""}`;

    const preview = document.createElement("div");
    preview.className = "batchJobPreview";
    const previewItems = Array.isArray(job.preview_items) ? job.preview_items.slice(0, 3) : [];
    if (previewItems.length > 0) {
      preview.textContent = previewItems
        .map((item) =>
          job.job_type === "delegated_revit_task_batch"
            ? `${item.label || item.item_key || item.index}: ${item.task_preview || item.error || "pending"}`
            : `${item.room_number || item.index}: ${item.view_name || item.error || "pending"} → ${item.expected_output_relative_path || item.output_relative_path || ""}`
        )
        .join(" | ");
    } else if (`${job.error || ""}`.trim()) {
      preview.textContent = job.error.trim();
    } else {
      preview.textContent = "No preview items saved yet.";
    }

    const actions = document.createElement("div");
    actions.className = "batchJobActions";
    let approvalNotice = null;

    const addAction = (label, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", handler);
      actions.appendChild(button);
    };

    if (statusKey === "awaiting_approval") {
      approvalNotice = document.createElement("p");
      approvalNotice.className = "approvalNotice";
      approvalNotice.textContent = "Review the preview and target model before approving. Revit authorization is still enforced at execution.";
      addAction("Approve preview", () => runBatchJobAction(job.id, "approve"));
    }
    if (statusKey === "running" || statusKey === "queued") {
      addAction("Pause", () => runBatchJobAction(job.id, "pause"));
    }
    if (statusKey === "paused") {
      addAction("Resume", () => runBatchJobAction(job.id, "resume"));
    }
    if (statusKey !== "cancelled" && statusKey !== "succeeded" && statusKey !== "failed" && statusKey !== "succeeded_with_failures") {
      addAction("Cancel", () => runBatchJobAction(job.id, "cancel"));
    }
    if ((counts.failed || 0) > 0) {
      addAction("Retry Failed", () => runBatchJobAction(job.id, "retry-failed"));
    }
    const openPath = `${job.output_folder_relative || ""}`.trim() || `${job.job_dir || ""}`.trim();
    if (openPath) {
      addAction("Open Folder", () => openArtifactFolder(openPath));
    }

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(preview);
    if (approvalNotice) card.appendChild(approvalNotice);
    if (actions.childElementCount > 0) card.appendChild(actions);
    elements.batchJobs.appendChild(card);
  }
}

function setSession(sessionId) {
  const nextSessionId = sessionId || "";
  if (state.sessionId !== nextSessionId) {
    state.notificationsAfterId = 0;
  }
  state.sessionId = nextSessionId;
  try {
    const saved = JSON.parse(localStorage.getItem("operator-desktop.task-target") || "null");
    state.taskNavigationAssignmentId = Array.isArray(saved) && saved[0] === nextSessionId
      && typeof saved[1] === "string" && saved[1].length <= 240 ? saved[1] : "";
  } catch { state.taskNavigationAssignmentId = ""; }
  if (state.sessionId) {
    localStorage.setItem(STORAGE_KEY, state.sessionId);
    elements.sessionBadge.textContent = `Session ${state.sessionId.slice(0, 8)}`;
    elements.sessionBadge.className = "badge tone-info";
  } else {
    localStorage.removeItem(STORAGE_KEY);
    elements.sessionBadge.textContent = "No session";
    elements.sessionBadge.className = "badge tone-neutral";
  }
  updateFeedbackBarVisibility();
}

async function restoreConversationHistory() {
  const sessionId = state.sessionId;
  if (!sessionId) return;
  const assignmentId = state.taskNavigationAssignmentId;
  const epoch = state.taskNavigationEpoch;
  const taskQuery = assignmentId ? `&assignment_id=${encodeURIComponent(assignmentId)}` : "";
  try {
    const payload = await fetchJson(`/api/session/history?session_id=${encodeURIComponent(sessionId)}${taskQuery}`);
    if (state.sessionId !== sessionId || payload?.session_id !== sessionId
        || state.taskNavigationAssignmentId !== assignmentId || state.taskNavigationEpoch !== epoch) return;
    state.backendMessages = mergeConversationHistory(state.backendMessages, payload.messages);
    renderMessages();
  } catch {
    if (state.sessionId === sessionId && state.taskNavigationAssignmentId === assignmentId
        && state.taskNavigationEpoch === epoch && !state.streaming) setStatus("Conversation history is unavailable.");
  }
}

function initializeConversationView() {
  renderMessages();
  renderEvents();
  updateControls();
  updateStatusTone();
}

function setStreaming(streaming) {
  if (streaming && !state.streaming) {
    state.activityStartedAt = Date.now();
    state.activityUpdatedAt = Date.now();
    state.activityLastSeenAt = null;
    state.activityConnectionLost = false;
  }
  if (!streaming || !state.streaming) state.agentProgress = "";
  state.streaming = streaming;
  renderCompactWork();
  updateControls();
  updateStatusTone();
  updateFeedbackBarVisibility();
}

function pausedTaskAcceptsDirection() {
  const goal = selectedGoal();
  return !state.streaming && goal?._bindingV2?.session_id === state.sessionId
    && (Boolean(goal?._providerUsageHold) || ["paused", "awaiting_user_review", "stopping_after_usage_limit", "waiting_for_usage"].includes(goal?._assignmentPhase)
      || Boolean(state.pendingCheckpointDirection) && ["assignment_id", "session_id", "run_id", "generation"]
        .every(key => goal._bindingV2[key] === state.pendingCheckpointDirection[key]));
}

function updateControls() {
  elements.assignmentInputs?._questionState?.refreshDisabled();
  const captureActive = !!state.captureState.mode;
  const captureBusy = state.captureState.busy || state.resetting || state.composerSubmissionPending || state.assignmentResumePending;
  const backendSubmissionActive = state.streaming && state.activeRunKind === "backend";
  elements.sendButton.disabled = captureBusy || state.attachmentReadsPending > 0;
  elements.sendButton.textContent = state.composerSubmissionPending
    ? "Sending…"
    : backendSubmissionActive || state.streaming && state.activeRunKind === "computer"
      ? "Steer"
      : newRequestAfterReport() ? "Start new task" : pausedTaskAcceptsDirection() ? "Add direction" : "Send";
  elements.chatForm?.setAttribute("aria-busy", state.streaming || state.composerSubmissionPending ? "true" : "false");
  elements.newSessionButton.disabled = captureActive || captureBusy;
  elements.stopButton.disabled = !state.streaming;
  elements.stopButton.hidden = true;
  if (elements.speakButton) {
    elements.speakButton.disabled = !latestAssistantMessage() || captureBusy;
  }
  elements.attachButton.disabled = captureActive || captureBusy;
  elements.attachInput.disabled = captureActive || captureBusy;
  elements.refreshScreenButton.disabled = captureBusy;
  if (elements.switchDisplayButton) elements.switchDisplayButton.disabled = !captureActive || captureBusy;
  elements.promptInput.disabled = captureBusy;
  if (elements.listenButton) elements.listenButton.disabled = state.streaming || captureBusy || (captureActive && state.captureState.mode !== "listen");
  if (elements.learnButton) elements.learnButton.disabled = state.streaming || captureBusy || (captureActive && state.captureState.mode !== "learn");
}

function updateStatusTone() {
  const text = `${elements.statusText.textContent || ""}`.toLowerCase();
  let tone = "tone-neutral";

  if (state.streaming || text.includes("working") || text.includes("running") || text.includes("starting") || text.includes("stopping")) {
    tone = "tone-info";
  } else if (text.includes("failed") || text.includes("error") || text.includes("unavailable")) {
    tone = "tone-danger";
  } else if (text.includes("ready")) {
    tone = "tone-positive";
  } else if (text.includes("connecting")) {
    tone = "tone-warning";
  }

  elements.statusPill.className = `statusPill ${tone}${state.streaming ? " busy" : ""}`;
}

function updateFeedbackBarVisibility() {
  const visible = !!state.sessionId && !state.streaming && !!latestAssistantMessage();
  state.feedbackVisible = visible;
  elements.feedbackBar.classList.toggle("on", visible);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, "X-Operator-Browser-Identity": loadedBrowserIdentity } });
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(payload.error || text || `${options.method || "GET"} ${url} failed`);
    if (payload && typeof payload === "object") Object.assign(error, payload);
    throw error;
  }

  return payload;
}

// TESTABLE_EXECUTION_ADMISSION_PRESENTATION_START
function hasTrustedReadOnlyEffect(detail) {
  return !!detail && typeof detail === "object" && detail.request_effect === "read";
}

function honestExecutionFailureText(error) {
  const raw = `${error?.message || error || ""}`.trim();
  let detail = error && typeof error === "object" ? error : null;
  if (!detail && raw.startsWith("{")) {
    try { detail = JSON.parse(raw); } catch { detail = null; }
  }
  if (detail?.request_dispatched === false && detail?.outcome_unknown === false) {
    return `Blocked before dispatch: ${detail.error || "Revit execution was not authorized."} It was not sent to Revit.`;
  }
  if (detail?.outcome_unknown === true || detail?.reconciliation_required === true) {
    if (hasTrustedReadOnlyEffect(detail)) {
      return `The read-only request may have reached Revit, but no result was confirmed. No model write was authorized. It will not retry automatically. ${detail.error || ""}`.trim();
    }
    return `Revit may have received the action, but its outcome is unknown. Reconcile the model before continuing; do not retry. ${detail.error || ""}`.trim();
  }
  return raw || "Request failed.";
}
// TESTABLE_EXECUTION_ADMISSION_PRESENTATION_END

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_BOOTSTRAP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchJson(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error(`Backend request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
  }
}

function appendActivityEvent(text, id = "", options = {}) {
  const eventId = id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (state.computerEvents.some((event) => event?.id === eventId)) {
    return;
  }

  const timestamp = options?.time
    ? new Date(options.time).toLocaleTimeString("en-US", { hour12: false })
    : new Date().toLocaleTimeString("en-US", { hour12: false });
  state.computerEvents = [
    ...state.computerEvents,
    {
      id: eventId,
      time: timestamp,
      text,
      tone: `${options?.tone || "tone-neutral"}`.trim() || "tone-neutral",
      url: `${options?.url || ""}`.trim(),
      urlLabel: `${options?.urlLabel || ""}`.trim()
    }
  ].slice(-200);
}

function appendCaptureTimeline(text, kind = "status", extra = {}) {
  const capture = state.captureState;
  if (!capture?.mode) return;
  const entry = {
    at: new Date().toISOString(),
    kind,
    text: `${text || ""}`.trim()
  };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null || value === "") continue;
    entry[key] = value;
  }
  capture.eventTimeline = [...(Array.isArray(capture.eventTimeline) ? capture.eventTimeline : []), entry].slice(-400);
}

function mergeActivityEvents(existingEvents, incomingEvents) {
  const merged = [];
  const seen = new Set();
  for (const event of [...(Array.isArray(existingEvents) ? existingEvents : []), ...(Array.isArray(incomingEvents) ? incomingEvents : [])]) {
    if (!event || typeof event !== "object") continue;
    const id = `${event.id || ""}`.trim();
    const text = `${event.text || ""}`.trim();
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      ...event,
      tone: `${event.tone || "tone-neutral"}`.trim() || "tone-neutral",
      url: `${event.url || ""}`.trim(),
      urlLabel: `${event.urlLabel || ""}`.trim()
    });
  }

  return merged.slice(-200);
}

function updateAuthBadge(payload = null) {
  const authMode = `${payload?.authMode || state.backendAuthMode || "shared_token"}`.toLowerCase();
  let badgeText = "Auth unknown";
  let tone = "tone-neutral";
  const parts = [state.backendLocal ? "Local backend" : "EC2 backend", state.backendUrl].filter(Boolean);
  const signInNeeded = authMode === "clashpilot" && (payload?.signInRequired === true || !payload?.accessTokenCached);

  if (authMode === "clashpilot") {
    if (payload?.accessTokenCached && !signInNeeded) {
      const label = payload?.email || (payload?.userId ? `user ${payload.userId.slice(0, 8)}` : "cached sign-in");
      badgeText = `BIMTools ${label}`;
      tone = "tone-positive";
      parts.push("BIMTools cached sign-in");
    } else {
      badgeText = "BIMTools sign-in needed";
      tone = "tone-warning";
      parts.push("BIMTools sign-in needed");
    }
  } else if (payload?.sharedTokenAvailable) {
    badgeText = "Shared token ready";
    tone = "tone-positive";
    parts.push("Shared token ready");
  } else {
    badgeText = authMode === "shared_token" ? "Shared token missing" : "Auth not ready";
    tone = authMode === "shared_token" ? "tone-warning" : "tone-danger";
    parts.push(badgeText);
  }

  elements.authBadge.textContent = badgeText;
  elements.authBadge.className = `badge ${tone}`;
  elements.backendText.textContent = parts.join(" • ");
  if (elements.authSignInButton) {
    elements.authSignInButton.hidden = authMode !== "clashpilot";
    elements.authSignInButton.textContent = signInNeeded ? "Sign In" : "Account";
    elements.authSignInButton.title = signInNeeded
      ? "Sign in to BIMTools."
      : "View account details or sign out.";
  }
  if (elements.authBadge) {
    elements.authBadge.title =
      authMode === "clashpilot" ? "Click to manage your BIMTools account." : parts.join(" • ");
  }
}

function authNeedsSidecarSignIn(payload = null) {
  const authMode = `${payload?.authMode || state.backendAuthMode || "shared_token"}`.toLowerCase();
  return authMode === "clashpilot" && (payload?.signInRequired === true || !payload?.accessTokenCached);
}

function environmentTone(statusKey) {
  if (statusKey === "ready") return "tone-positive";
  if (statusKey === "unavailable") return "tone-danger";
  if (statusKey === "needs_setup") return "tone-danger";
  return "tone-neutral";
}

function computeEnvironmentStatus(payload = null, backendLocal = state.backendLocal) {
  const manifest = payload?.manifest || state.environmentStatus || {};
  const caps = manifest.capabilities || {};
  if (!manifest || !Object.keys(manifest).length) return "unknown";
  if (!caps.filesystem_write) return "needs_setup";
  if (backendLocal && (caps.revit_api === false || caps.screen_capture === false || caps.powershell === false)) return "unavailable";
  if (!backendLocal && caps.screen_capture === false) return "unavailable";
  return "ready";
}

function renderEnvironmentProfile(payload = null) {
  const env = payload || {};
  const profile = env.profile || state.environmentProfile || {};
  const manifest = env.manifest || state.environmentStatus || {};
  const caps = manifest.capabilities || {};
  const statusKey = state.demoReadiness?.status || computeEnvironmentStatus(env, state.backendLocal);
  const label = statusKey === "ready" ? "Ready" : statusKey === "unavailable" ? "Unavailable" : statusKey === "needs_setup" ? "Needs setup" : "Unknown";
  const presentation = environmentBadgePresentation(statusKey, state.backendLocal, manifest.preferred_output_dir);
  const profileStatus = `${payload?.environmentProfileStatus || state.environmentProfileStatus || "unknown"}`.trim().toLowerCase();
  if (elements.environmentBadge) {
    const degraded = profileStatus === "timeout" || profileStatus === "unavailable";
    elements.environmentBadge.textContent = degraded
      ? profileStatus === "timeout" ? "Environment timed out" : "Environment unavailable"
      : presentation.text;
    elements.environmentBadge.className = `badge ${degraded ? "tone-danger" : environmentTone(statusKey)}`;
    elements.environmentBadge.title = degraded
      ? `${payload?.environmentProfileError || "Backend environment profile is unavailable."}`
      : presentation.title;
  }
  if (elements.environmentSummary) {
    elements.environmentSummary.textContent = environmentDiagnosticSummary({
      backendLocal: state.backendLocal, label, profileStatus, manifest, profile, health: state.environmentRevitHealth
    });
  }
  if (elements.environmentDetailsBody) {
    const restrictions = Array.isArray(manifest.restrictions) ? manifest.restrictions : [];
    const checks = Array.isArray(state.demoReadiness?.checks) ? state.demoReadiness.checks : [];
    const rows = [];
    rows.push(`<div><strong>Local Revit checked</strong>: ${escapeHtml(state.environmentRevitHealth?.checked_at || 'Not yet observed')}${state.environmentRevitHealth?.cached || state.environmentRevitHealth?.deferred ? ' (last known state)' : ''}</div>`);
    rows.push(`<div><strong>Local Revit connection</strong>: ${escapeHtml(state.environmentRevitHealth?.revit_bridge?.error || state.environmentRevitHealth?.error || 'See connection summary above.')}</div>`);
    rows.push(`<div><strong>Profile</strong>: ${escapeHtml(env.profile_path || "")}</div>`);
    rows.push(`<div><strong>Type</strong>: ${escapeHtml(manifest.environment_type || profile.environment_type || "unknown")}</div>`);
    rows.push(`<div><strong>Preferred exports</strong>: ${escapeHtml(manifest.preferred_output_dir || "")}</div>`);
    rows.push(`<div><strong>Fallback temp</strong>: ${escapeHtml(manifest.fallback_temp_dir || "")}</div>`);
    if (restrictions.length) rows.push(`<div><strong>Restrictions</strong><ul>${restrictions.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>`);
    if (checks.length) rows.push(`<div><strong>Demo readiness</strong><ul>${checks.map((c) => `<li>${c.ok ? "OK" : "Issue"}: ${escapeHtml(c.name)} - ${escapeHtml(c.status || "")}</li>`).join("")}</ul></div>`);
    elements.environmentDetailsBody.innerHTML = rows.join("");
    elements.environmentDetailsBody.hidden = !state.environmentDetailsOpen;
    if (elements.environmentActionsBottom) elements.environmentActionsBottom.hidden = !state.environmentDetailsOpen;
  }
  if (elements.environmentDetailsToggle) {
    elements.environmentDetailsToggle.textContent = state.environmentDetailsOpen ? "Hide Details" : "Details";
    elements.environmentDetailsToggle.setAttribute("aria-expanded", state.environmentDetailsOpen ? "true" : "false");
  }
}

async function refreshEnvironmentRevitHealth({fresh=false}={}) {
  const revision=(state.environmentRevitHealthRevision || 0)+1;
  state.environmentRevitHealthRevision=revision;
  let health;
  try { health=await fetchJsonWithTimeout(fresh ? '/api/revit/health' : '/api/revit/health?prefer_cached=1'); }
  catch { health={ok:false,context:null,error:'Local Revit connection check unavailable.'}; }
  if(state.environmentRevitHealthRevision===revision) state.environmentRevitHealth=health;
}

async function refreshEnvironmentProfile() {
  let payload;
  try {
    payload = await fetchJsonWithTimeout("/api/environment/profile");
  } catch (error) {
    const status = /timed out/i.test(`${error?.message || ""}`) ? "timeout" : "unavailable";
    state.environmentProfileStatus = status;
    renderEnvironmentProfile({
      profile: state.environmentProfile,
      manifest: state.environmentStatus,
      environmentProfileStatus: status,
      environmentProfileError: status === "timeout" ? "Environment profile timed out." : "Environment profile is unavailable."
    });
    renderBackendBootstrapState({ backendConfigStatus: status });
    return { ok: true, backendAvailable: false, environmentProfileStatus: status };
  }
  state.environmentProfile = payload.profile || null;
  state.environmentStatus = payload.manifest || null;
  state.environmentProfileStatus = payload.environmentProfileStatus || "ready";
  await refreshEnvironmentRevitHealth();
  renderEnvironmentProfile(payload);
  if (state.environmentProfileStatus !== "ready") {
    renderBackendBootstrapState({ backendConfigStatus: state.environmentProfileStatus });
  }
  return payload;
}

async function refreshEnvironmentProfileFromProbe() {
  const [profileResult]=await Promise.allSettled([
    fetchJson("/api/environment/refresh", { method: "POST" }),
    refreshEnvironmentRevitHealth({fresh:true})
  ]);
  if(profileResult.status!=='fulfilled') {
    state.environmentProfileStatus='unavailable';
    renderEnvironmentProfile();
    throw profileResult.reason;
  }
  const payload=profileResult.value;
  state.environmentProfile = payload.profile || null;
  state.environmentStatus = payload.manifest || null;
  state.environmentProfileStatus = "ready";
  state.demoReadiness = null;
  renderEnvironmentProfile(payload);
  appendActivityEvent("Environment profile refreshed.", "", { tone: "tone-positive" });
}

async function runDemoReadinessCheck() {
  const payload = await fetchJson("/api/environment/demo-readiness");
  state.demoReadiness = payload.result || null;
  await refreshEnvironmentProfile().catch(() => null);
  renderEnvironmentProfile({ profile: state.environmentProfile, manifest: state.environmentStatus, profile_path: payload.profile_path || "" });
  const title = state.demoReadiness?.title || "Demo readiness checked";
  appendActivityEvent(`${title}.`, "", { tone: state.demoReadiness?.ready ? "tone-positive" : "tone-warning" });
}

async function clearEnvironmentMemory() {
  const payload = await fetchJson("/api/environment/clear", { method: "POST" });
  state.environmentProfile = payload.profile || null;
  state.environmentStatus = payload.manifest || null;
  state.demoReadiness = null;
  renderEnvironmentProfile(payload);
  appendActivityEvent("Environment memory cleared and rebuilt.", "", { tone: "tone-warning" });
}

async function copyEnvironmentDiagnostics() {
  const payload = {
    profile: state.environmentProfile,
    manifest: state.environmentStatus,
    demo_readiness: state.demoReadiness,
    local_revit_health: state.environmentRevitHealth || null
  };
  await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  appendActivityEvent("Environment diagnostics copied.", "", { tone: "tone-positive" });
}

function setAuthDialogError(message = "") {
  if (!elements.authErrorText) return;
  const text = `${message || ""}`.trim();
  elements.authErrorText.textContent = text;
  elements.authErrorText.hidden = !text;
}

function setAuthDialogBusy(busy) {
  const active = !!busy;
  if (elements.authEmailInput) elements.authEmailInput.disabled = active;
  if (elements.authPasswordInput) elements.authPasswordInput.disabled = active;
  if (elements.authCancelButton) elements.authCancelButton.disabled = active;
  if (elements.authLogoutButton) elements.authLogoutButton.disabled = active;
  if (elements.authSubmitButton) {
    elements.authSubmitButton.disabled = active;
    elements.authSubmitButton.textContent = active ? "Signing In..." : "Sign In";
  }
}

function syncAuthDialogContent(payload = null) {
  const auth = payload || state.authStatus || {};
  const authMode = `${auth?.authMode || state.backendAuthMode || "shared_token"}`.toLowerCase();
  const signedIn = authMode === "clashpilot" && !!auth?.accessTokenCached && auth?.signInRequired !== true;
  if (elements.authStatusSummary) {
    elements.authStatusSummary.textContent = signedIn
      ? `Signed in as ${auth?.email || auth?.userId || "cached user"}.`
      : authMode === "clashpilot"
        ? "Not signed in. Sign in with your BIMTools account."
        : "This installation uses a local connection; no BIMTools login is needed.";
  }
  if (elements.authLogoutButton) {
    elements.authLogoutButton.hidden = !signedIn;
  }
  if (elements.authSubmitButton) {
    elements.authSubmitButton.hidden = authMode !== "clashpilot";
  }
}

function openAuthDialog() {
  if (!elements.authDialog) return;
  setAuthDialogError("");
  syncAuthDialogContent(state.authStatus);
  const emailHint = `${state.authStatus?.email || ""}`.trim();
  if (elements.authEmailInput && !elements.authEmailInput.value.trim() && emailHint) {
    elements.authEmailInput.value = emailHint;
  }
  if (typeof elements.authDialog.showModal === "function" && !elements.authDialog.open) {
    elements.authDialog.showModal();
  }
  if (elements.authEmailInput && !elements.authEmailInput.value.trim()) {
    elements.authEmailInput?.focus();
  } else {
    elements.authPasswordInput?.focus();
  }
}

function closeAuthDialog() {
  if (!elements.authDialog?.open) return;
  elements.authDialog.close();
}

function looksLikeAuthBootstrapError(error) {
  const text = `${error?.message || error || ""}`.trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes("clashpilot auth is configured") || text.includes("bimtools sign-in is configured") ||
    text.includes("sign in through the sidecar") ||
    text.includes("sign in through the revit add-in") ||
    text.includes("no cached access token was found") ||
    text.includes("no refresh token was found")
  );
}

async function refreshAuthStatus() {
  const authStatus = await fetchJson("/api/auth/status");
  state.authStatus = authStatus;
  updateAuthBadge(authStatus);
  syncAuthDialogContent(authStatus);
  return authStatus;
}

async function submitSidecarSignIn() {
  const email = `${elements.authEmailInput?.value || ""}`.trim();
  const password = `${elements.authPasswordInput?.value || ""}`;
  setAuthDialogError("");
  setAuthDialogBusy(true);
  try {
    const payload = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    state.authStatus = payload;
    updateAuthBadge(payload);
    syncAuthDialogContent(payload);
    if (elements.authPasswordInput) elements.authPasswordInput.value = "";
    closeAuthDialog();
    appendActivityEvent("Signed in to BIMTools.", "", { tone: "tone-positive" });
    try {
      await fetchJson("/api/backend/health");
      setStatus("Sidecar ready.");
    } catch {
      setStatus("Signed in.");
    }
    elements.promptInput?.focus();
  } finally {
    setAuthDialogBusy(false);
  }
}

async function submitSidecarLogout() {
  setAuthDialogError("");
  setAuthDialogBusy(true);
  try {
    const payload = await fetchJson("/api/auth/logout", {
      method: "POST"
    });
    state.authStatus = payload;
    updateAuthBadge(payload);
    syncAuthDialogContent(payload);
    if (elements.authPasswordInput) elements.authPasswordInput.value = "";
    elements.promptInput.value = "";
    state.pendingAttachments = [];
    renderAttachStrip();
    await persistComposerDraft();
    appendActivityEvent("Signed out of BIMTools.", "", { tone: "tone-neutral" });
    setStatus("Signed out.");
  } finally {
    setAuthDialogBusy(false);
  }
}

async function submitFeedback(rating) {
  if (!state.sessionId) {
    throw new Error("No backend session is available for feedback yet.");
  }

  const feedbackSession=state.sessionId;
  const feedbackGoal=selectedGoal();
  const selectedBinding=feedbackGoal?._bindingV2;
  if(feedbackGoal?._sourceKind==='assignment_kernel_v2'&&!selectedBinding)throw Error('Reopen this task before submitting feedback.');
  if(selectedBinding&&selectedBinding.session_id!==state.sessionId)throw Error('Reopen this task before submitting feedback.');
  const taskBinding=selectedBinding?Object.fromEntries(['assignment_id','session_id','run_id','generation'].map(k=>[k,selectedBinding[k]])):undefined;
  const payload = await fetchJson("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: state.sessionId,
      rating,
      task_binding:taskBinding,
      note: `${elements.fbNote.value || ""}`.trim()
    })
  });

  // A saved rating belongs to the submitted task even if the user navigates
  // away while the request is in flight. Do not clear the new task's note.
  if(state.sessionId!==feedbackSession||taskBinding&&!['assignment_id','session_id','run_id','generation']
    .every(key=>selectedGoal()?._bindingV2?.[key]===taskBinding[key]))return;

  const feedbackSummary = payload?.github_issue?.started
    ? "Feedback saved. GitHub issue creation started."
    : payload?.improvement_job?.id
      ? "Feedback saved. Dev handoff queued."
      : "Feedback saved.";

  elements.fbNote.value = "";
  state.feedbackVisible = false;
  elements.feedbackBar.classList.remove("on");
  setStatus(feedbackSummary);
  appendActivityEvent(
    payload?.github_issue?.started
      ? `Feedback submitted: ${rating}. GitHub issue creation started.`
      : payload?.improvement_job?.id
        ? `Feedback submitted: ${rating}. Dev handoff queued.`
        : `Feedback submitted: ${rating}.`,
    "",
    {
      tone: payload?.github_issue?.started ? "tone-info" : payload?.improvement_job?.id ? "tone-positive" : "tone-neutral"
    }
  );
  renderEvents();
}

function base64FromUint8(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function encodeWav16Mono(samplesF32, sampleRate) {
  const numSamples = samplesF32.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    let sample = Math.max(-1, Math.min(1, samplesF32[i]));
    sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  return u8;
}

function setRecUiState() {
  elements.recStartButton.disabled = state.recState.busy || state.recState.recording;
  elements.recStopButton.disabled = state.recState.busy || !state.recState.recording;
  if (elements.micDeviceSelect) {
    elements.micDeviceSelect.disabled = state.recState.busy || state.recState.recording;
  }
  elements.recStartButton.classList.toggle("active", state.recState.recording);
  elements.recStartButton.setAttribute("aria-label", state.recState.recording ? "Recording" : "Start dictation");
  elements.recStartButton.title = state.recState.recording ? "Recording" : "Start dictation";
  updateControls();
}

function selectedMicLabel() {
  const selectedId = state.recState.micDeviceId || "";
  const selected = state.recState.micDevices.find((device) => device.deviceId === selectedId);
  return selected?.label || (selectedId ? "Selected microphone" : "Default microphone");
}

function buildMicAudioConstraints() {
  const deviceId = `${state.recState.micDeviceId || ""}`.trim();
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio };
}

function renderMicDevices() {
  if (!elements.micDeviceSelect) return;
  const previous = state.recState.micDeviceId || elements.micDeviceSelect.value || "";
  elements.micDeviceSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Default microphone";
  elements.micDeviceSelect.appendChild(defaultOption);
  for (const device of state.recState.micDevices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || "Microphone";
    elements.micDeviceSelect.appendChild(option);
  }
  const canRestore = previous && state.recState.micDevices.some((device) => device.deviceId === previous);
  state.recState.micDeviceId = canRestore ? previous : "";
  elements.micDeviceSelect.value = state.recState.micDeviceId;
}

async function refreshMicDevices({ requestPermission = false } = {}) {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let probeStream = null;
  try {
    if (requestPermission && navigator.mediaDevices.getUserMedia) {
      probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.recState.micDevices = devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({ deviceId: device.deviceId, label: device.label || "Microphone" }));
    renderMicDevices();
  } catch {
    // Browser permission errors are surfaced when the user starts dictation.
  } finally {
    try { probeStream?.getTracks?.().forEach((track) => track.stop()); } catch {}
  }
}

function describeNoAudioCaptured(session) {
  const diagnostics = session?.getDiagnostics?.() || {};
  const label = diagnostics.deviceLabel || selectedMicLabel();
  const details = [];
  if (Number.isFinite(diagnostics.recorderBytes)) details.push(`${diagnostics.recorderBytes} recorder bytes`);
  if (Number.isFinite(diagnostics.fallbackSamples)) details.push(`${diagnostics.fallbackSamples} raw samples`);
  const suffix = details.length ? ` (${details.join(", ")}).` : ".";
  return `No microphone audio was captured from ${label}${suffix} Check the headset mute button, Windows input device, or choose another microphone.`;
}

async function startWavRecordingFromStream(stream, options = {}) {
  const stopTracksOnStop = options.stopTracksOnStop !== false;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx({ sampleRate: 16000 });
  const sampleRate = audioCtx.sampleRate;
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  const chunks = [];
  let total = 0;
  let flushedSamples = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    total += copy.length;
  };

  source.connect(processor);
  processor.connect(gain);
  gain.connect(audioCtx.destination);
  try { await audioCtx.resume(); } catch {}

  const exportPendingSamples = (force = false) => {
    const available = total - flushedSamples;
    if (available <= 0) return null;
    if (!force && available < sampleRate * 4) return null;

    const out = new Float32Array(available);
    let offset = 0;
    let cursor = 0;
    for (const chunk of chunks) {
      const nextCursor = cursor + chunk.length;
      if (nextCursor <= flushedSamples) {
        cursor = nextCursor;
        continue;
      }
      const startIndex = Math.max(0, flushedSamples - cursor);
      const slice = chunk.subarray(startIndex);
      out.set(slice, offset);
      offset += slice.length;
      cursor = nextCursor;
    }
    flushedSamples = total;
    return { samples: out, sampleRate };
  };

  return {
    flushChunk: async ({ force = false } = {}) => exportPendingSamples(force),
    getDiagnostics: () => ({
      deviceLabel: stream.getAudioTracks?.()[0]?.label || "",
      fallbackSamples: total
    }),
    stop: async () => {
      try { processor.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
      if (stopTracksOnStop) {
        try { stream.getTracks().forEach((track) => track.stop()); } catch {}
      }
      try { await audioCtx.close(); } catch {}
      return exportPendingSamples(true);
    }
  };
}

async function startWavRecording() {
  await refreshMicDevices({ requestPermission: false });
  const stream = await navigator.mediaDevices.getUserMedia(buildMicAudioConstraints());
  return await beginAudioCaptureSession(stream);
}

function preferredCompressedAudioMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "";
}

function formatFromMimeType(mimeType) {
  const lower = `${mimeType || ""}`.trim().toLowerCase();
  if (lower.includes("webm")) return "webm";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  return "wav";
}

function base64FromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = `${reader.result || ""}`;
      const commaIndex = dataUrl.indexOf(",");
      if (commaIndex < 0) {
        reject(new Error("Failed to encode recorded audio."));
        return;
      }
      resolve(dataUrl.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(new Error("Failed to read recorded audio."));
    reader.readAsDataURL(blob);
  });
}

function audioBufferToMonoSamples(audioBuffer) {
  const channels = Math.max(1, audioBuffer.numberOfChannels || 1);
  const length = audioBuffer.length || 0;
  const samples = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      samples[index] += data[index] / channels;
    }
  }
  return samples;
}

async function wavPayloadFromBlob(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Audio decoding is not available in this browser.");
  }
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioCtx();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const samples = audioBufferToMonoSamples(audioBuffer);
    const wavBytes = encodeWav16Mono(samples, audioBuffer.sampleRate);
    return {
      audioBase64: base64FromUint8(wavBytes),
      format: "wav"
    };
  } finally {
    try { await audioCtx.close(); } catch {}
  }
}

async function startCompressedRecording(stream) {
  const mimeType = preferredCompressedAudioMimeType();
  if (!mimeType || typeof MediaRecorder === "undefined") {
    throw new Error("Compressed browser audio capture is not available.");
  }
  const sampleFallback = await startWavRecordingFromStream(stream, { stopTracksOnStop: false });
  const diagnostics = {
    deviceLabel: stream.getAudioTracks?.()[0]?.label || selectedMicLabel(),
    recorderBytes: 0,
    fallbackSamples: 0
  };
  let currentSegment = null;
  let closed = false;
  let rotateChain = Promise.resolve(null);

  function startSegment() {
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          diagnostics.recorderBytes += event.data.size;
          chunks.push(event.data);
        }
      });
      recorder.addEventListener("stop", async () => {
        try {
          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size <= 0) {
            resolve(null);
            return;
          }
          try {
            const decoded = await wavPayloadFromBlob(blob);
            const flushed = await sampleFallback.flushChunk({ force: true });
            diagnostics.fallbackSamples += flushed?.samples?.length || 0;
            resolve(decoded);
          } catch {
            const fallback = await sampleFallback.flushChunk({ force: true });
            diagnostics.fallbackSamples += fallback?.samples?.length || 0;
            resolve(fallback);
          }
        } catch (error) {
          reject(error);
        }
      }, { once: true });
      recorder.addEventListener("error", (event) => {
        reject(event?.error || new Error("Audio recording failed."));
      }, { once: true });
    });
    recorder.start();
    return { recorder, stopped };
  }

  currentSegment = startSegment();

  async function rotateSegment({ restart = true } = {}) {
    if (!currentSegment) return null;
    const segment = currentSegment;
    currentSegment = null;
    if (segment.recorder.state !== "inactive") {
      segment.recorder.stop();
    }
    const audio = await segment.stopped;
    if (!closed && restart) {
      currentSegment = startSegment();
    }
    return audio;
  }

  async function flushChunk() {
    rotateChain = rotateChain.then(() => rotateSegment({ restart: true }));
    return await rotateChain;
  }

  return {
    flushChunk,
    getDiagnostics: () => ({ ...diagnostics }),
    stop: async () => {
      closed = true;
      rotateChain = rotateChain.then(() => rotateSegment({ restart: false }));
      const audio = await rotateChain;
      try { await sampleFallback.stop(); } catch {}
      try { stream.getTracks().forEach((track) => track.stop()); } catch {}
      return audio;
    }
  };
}

async function beginAudioCaptureSession(stream) {
  const audioTrackStream = new MediaStream(stream.getAudioTracks());
  if (audioTrackStream.getAudioTracks().length === 0) {
    throw new Error("No audio track is available for capture.");
  }
  try {
    return await startCompressedRecording(audioTrackStream);
  } catch {
    return await startWavRecordingFromStream(audioTrackStream);
  }
}

function captureModeLabel(mode) {
  return mode === "learn" ? "Teach" : "Listen In";
}

function captureSourceLabel(sourceKey) {
  return sourceKey === "system" ? "computer audio" : "local audio";
}

function captureScreenshotLimit(mode) {
  return mode === "learn" ? LEARN_SCREENSHOT_LIMIT : LISTEN_SCREENSHOT_LIMIT;
}

function captureScreenshotIntervalMs(mode) {
  return mode === "learn" ? LEARN_SCREENSHOT_INTERVAL_MS : LISTEN_SCREENSHOT_INTERVAL_MS;
}

function currentLearnReviewInputSignature(capture = state.captureState) {
  return JSON.stringify({
    micTranscript: `${capture?.micTranscript || ""}`.trim(),
    systemTranscript: `${capture?.systemTranscript || ""}`.trim(),
    screenshotNames: Array.isArray(capture?.screenshots)
      ? capture.screenshots.map((item) => item?.name || item?.filename || "").filter(Boolean)
      : []
  });
}

function appendTranscriptText(existing, next) {
  const current = `${existing || ""}`.trim();
  const incoming = `${next || ""}`.trim();
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.includes(incoming)) return current;
  return `${current}\n${incoming}`.trim();
}

async function captureModeScreenshot(tag) {
  if (!state.captureState.mode) return;
  if (state.captureState.screenshots.length >= captureScreenshotLimit(state.captureState.mode)) return;
  const screenshot = await captureAmbientScreenshot(tag);
  state.captureState.screenshots.push(screenshot);
  appendCaptureTimeline(`Captured screenshot ${screenshot?.name || tag}.`, "screenshot", {
    tag,
    filename: screenshot?.name || ""
  });
}

async function transcribeCaptureAudioChunk(sourceKey, audioPayload, contextLabel = "chunk") {
  if (!audioPayload?.audio_base64) return "";
  const payload = await fetchJson("/api/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(audioPayload)
  });
  const text = `${payload?.text || ""}`.trim();
  if (!text) return "";

  if (sourceKey === "system") {
    state.captureState.systemTranscript = appendTranscriptText(state.captureState.systemTranscript, text);
    state.captureState.systemChunkCount += 1;
    appendActivityEvent(`${captureModeLabel(state.captureState.mode)} transcribed ${captureSourceLabel(sourceKey)} ${contextLabel} ${state.captureState.systemChunkCount}.`);
    appendCaptureTimeline(`Transcribed ${captureSourceLabel(sourceKey)} ${contextLabel}.`, "transcript", {
      source: sourceKey,
      chunk_index: state.captureState.systemChunkCount,
      context: contextLabel
    });
  } else {
    state.captureState.micTranscript = appendTranscriptText(state.captureState.micTranscript, text);
    state.captureState.micChunkCount += 1;
    appendActivityEvent(`${captureModeLabel(state.captureState.mode)} transcribed ${captureSourceLabel(sourceKey)} ${contextLabel} ${state.captureState.micChunkCount}.`);
    appendCaptureTimeline(`Transcribed ${captureSourceLabel(sourceKey)} ${contextLabel}.`, "transcript", {
      source: sourceKey,
      chunk_index: state.captureState.micChunkCount,
      context: contextLabel
    });
  }
  renderEvents();
  if (state.captureState.mode === "learn" && !state.captureState.lastLearnReviewInputSignature) {
    const combinedLength = `${state.captureState.micTranscript || ""}\n${state.captureState.systemTranscript || ""}`.trim().length;
    if (combinedLength >= 120) {
      void runLearnLiveReview();
    }
  }
  return text;
}

function queueCaptureChunkTranscription(sourceKey) {
  const capture = state.captureState;
  const session = sourceKey === "system" ? capture.systemSession : capture.micSession;
  if (!session?.flushChunk) return Promise.resolve("");

  const promiseKey = sourceKey === "system" ? "systemTranscriptPromise" : "micTranscriptPromise";
  capture[promiseKey] = (capture[promiseKey] || Promise.resolve(""))
    .catch(() => "")
    .then(async () => {
      const chunk = await session.flushChunk();
      return await transcribeCaptureAudioChunk(sourceKey, await normalizeRecordedAudio(chunk), "chunk");
    })
    .catch((error) => {
      capture.warnings.push(`Failed to transcribe ${captureSourceLabel(sourceKey)}: ${error?.message || String(error)}`);
      appendActivityEvent(`Capture warning: failed to transcribe ${captureSourceLabel(sourceKey)}.`);
      appendCaptureTimeline(`Failed to transcribe ${captureSourceLabel(sourceKey)}.`, "warning", {
        source: sourceKey,
        error: error?.message || String(error)
      });
      renderEvents();
      return "";
    });

  return capture[promiseKey];
}

function scheduleCaptureChunking() {
  if (state.captureState.chunkTimer) clearInterval(state.captureState.chunkTimer);
  state.captureState.chunkTimer = setInterval(() => {
    if (!state.captureState.mode || state.captureState.busy) return;
    void queueCaptureChunkTranscription("mic");
    if (state.captureState.systemSession) {
      void queueCaptureChunkTranscription("system");
    }
  }, CAPTURE_TRANSCRIBE_INTERVAL_MS);
}

function scheduleCaptureScreenshots() {
  if (state.captureState.screenshotTimer) clearInterval(state.captureState.screenshotTimer);
  const intervalMs = captureScreenshotIntervalMs(state.captureState.mode);
  state.captureState.screenshotTimer = setInterval(async () => {
    if (!state.captureState.mode || state.captureState.busy) return;
    if (state.captureState.screenshots.length >= captureScreenshotLimit(state.captureState.mode)) return;
    try {
      const prefix = state.captureState.mode === "learn" ? "learn" : "listen";
      await captureModeScreenshot(`${prefix}_${state.captureState.screenshots.length + 1}`);
    } catch {
      // best effort
    }
  }, intervalMs);
}

function buildLearnReviewMessage(review) {
  const direct = `${review?.message_to_user || ""}`.trim();
  if (direct) return direct;

  const lines = [];
  const summary = `${review?.status_summary || ""}`.trim();
  if (summary) lines.push(summary);
  const questions = Array.isArray(review?.open_questions) ? review.open_questions.filter(Boolean).slice(0, 3) : [];
  if (questions.length > 0) {
    lines.push("Questions:");
    for (const question of questions) lines.push(`- ${question}`);
  }
  const focus = `${review?.suggested_next_focus || ""}`.trim();
  if (focus) lines.push(`Next focus: ${focus}`);
  return lines.join("\n").trim();
}

async function runLearnLiveReview({ force = false } = {}) {
  const capture = state.captureState;
  if (capture.mode !== "learn" || capture.busy || capture.liveReviewBusy) return;

  const hasContent =
    `${capture.micTranscript || ""}`.trim() ||
    `${capture.systemTranscript || ""}`.trim() ||
    capture.screenshots.length > 0;
  if (!hasContent) return;

  const inputSignature = currentLearnReviewInputSignature(capture);
  if (!force && inputSignature === capture.lastLearnReviewInputSignature) return;

  capture.liveReviewBusy = true;
  capture.lastLearnReviewInputSignature = inputSignature;

  try {
    const payload = await fetchJson("/api/learn/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId || undefined,
        started_at: capture.startedAt,
        mic_transcript: capture.micTranscript,
        system_transcript: capture.systemTranscript,
        warnings: capture.warnings,
        pending_attachments: capture.screenshots
      })
    });
    if (state.captureState !== capture) return;
    if (payload?.sessionId) setSession(payload.sessionId);

    const review = payload?.review || {};
    const message = buildLearnReviewMessage(review);
    const messageSignature = JSON.stringify({
      message,
      questions: Array.isArray(review?.open_questions) ? review.open_questions : [],
      focus: `${review?.suggested_next_focus || ""}`.trim()
    });
    const shouldMessageUser = review?.should_message_user !== false && !!message;

    if (shouldMessageUser && messageSignature !== capture.lastLearnReviewMessageSignature) {
      capture.lastLearnReviewMessageSignature = messageSignature;
      state.computerMessages.push({ role: "assistant", text: message, attachments: [] });
      renderMessages();
    }

    const openQuestions = Array.isArray(review?.open_questions) ? review.open_questions.filter(Boolean) : [];
    capture.liveReviewHistory = [
      ...(Array.isArray(capture.liveReviewHistory) ? capture.liveReviewHistory : []),
      {
        at: new Date().toISOString(),
        review
      }
    ].slice(-40);
    appendCaptureTimeline(
      openQuestions.length > 0
        ? `Teach review requested ${openQuestions.length} clarification question${openQuestions.length === 1 ? "" : "s"}.`
        : "Teach review refreshed current understanding.",
      "live_review",
      {
        confidence: Number.isFinite(Number(review?.confidence)) ? Number(review.confidence) : undefined,
        ready_for_repeat_execution: review?.ready_for_repeat_execution === true,
        open_questions: openQuestions
      }
    );
    appendActivityEvent(
      openQuestions.length > 0
        ? `Teach review asked ${openQuestions.length} clarification question${openQuestions.length === 1 ? "" : "s"}.`
        : "Teach review refreshed current understanding."
    );
    renderEvents();
  } catch (error) {
    if (state.captureState === capture) {
      capture.warnings.push(`Teach live review failed: ${error?.message || String(error)}`);
    }
    appendCaptureTimeline("Teach live review failed.", "warning", {
      error: error?.message || String(error)
    });
    appendActivityEvent("Teach live review failed.");
    renderEvents();
  } finally {
    if (state.captureState === capture) {
      capture.liveReviewBusy = false;
    }
  }
}

function scheduleLearnLiveReview() {
  if (state.captureState.reviewTimer) clearInterval(state.captureState.reviewTimer);
  if (state.captureState.mode !== "learn") return;
  state.captureState.reviewTimer = setInterval(() => {
    void runLearnLiveReview();
  }, LEARN_REVIEW_INTERVAL_MS);
}

function renderArtifacts() {
  if (!elements.artifacts) return;
  elements.artifacts.innerHTML = "";
  const artifacts = Array.isArray(state.captureArtifacts) ? state.captureArtifacts : [];
  if (artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event empty";
    empty.textContent = "No Listen or Teach artifacts saved yet.";
    elements.artifacts.appendChild(empty);
    return;
  }

  for (const artifact of artifacts) {
    const card = document.createElement("div");
    card.className = "artifactCard";

    const header = document.createElement("div");
    header.className = "artifactCardHeader";

    const title = document.createElement("div");
    title.className = "artifactTitle";
    title.textContent = artifact.title || artifact.dirName || "Artifact";

    const meta = document.createElement("div");
    meta.className = "artifactMeta";
    meta.textContent = [artifact.kind, artifact.mode, artifact.capturedAt].filter(Boolean).join(" • ");

    header.appendChild(title);
    header.appendChild(meta);

    const summary = document.createElement("div");
    summary.className = "artifactSummary";
    summary.textContent = artifact.summary || artifact.assignmentTemplate || "No summary available.";

    const actions = document.createElement("div");
    actions.className = "artifactActions";

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.textContent = "Preview";
    previewBtn.disabled = !artifact.markdownPath;
    previewBtn.addEventListener("click", () => {
      previewArtifact(artifact.markdownPath).catch((error) => {
        state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
        renderMessages();
        setStatus("Failed.");
      });
    });

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.textContent = "Open Folder";
    folderBtn.addEventListener("click", () => {
      openArtifactFolder(artifact.sessionDir).catch((error) => {
        state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
        renderMessages();
        setStatus("Failed.");
      });
    });

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "Send to Agent";
    sendBtn.disabled = !artifact.sessionDir;
    sendBtn.addEventListener("click", () => {
      sendArtifactToAgent(artifact).catch((error) => {
        state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
        renderMessages();
        setStatus("Failed.");
      });
    });

    if (artifact?.kind === "learn" && artifact?.batchTemplate) {
      const batchBtn = document.createElement("button");
      batchBtn.type = "button";
      batchBtn.textContent = "Use as Batch";
      batchBtn.addEventListener("click", () => {
        setBatchDraftFromTemplate(artifact.batchTemplate, {
          artifactId: artifact.id,
          skillId: artifact.localSkillId || "",
          skillName: artifact.localSkillId || "Teach skill"
        });
        appendActivityEvent(`Loaded Teach batch template from ${artifact.title || artifact.dirName || "artifact"}.`);
        renderEvents();
      });
      actions.appendChild(batchBtn);
    }

    actions.appendChild(previewBtn);
    actions.appendChild(sendBtn);
    actions.appendChild(folderBtn);

    card.appendChild(header);
    card.appendChild(summary);
    if (`${artifact?.localSkillId || ""}`.trim()) {
      const skillMeta = document.createElement("div");
      skillMeta.className = "artifactMeta";
      skillMeta.textContent = artifact.localSkillPath
        ? `skill: ${artifact.localSkillId}`
        : `skill pending: ${artifact.localSkillId}`;
      card.appendChild(skillMeta);
    }
    if (artifact?.batchTemplate?.job_type) {
      const batchMeta = document.createElement("div");
      batchMeta.className = "artifactMeta";
      batchMeta.textContent = `batch: ${artifact.batchTemplate.job_type}`;
      card.appendChild(batchMeta);
    }
    card.appendChild(actions);
    elements.artifacts.appendChild(card);
  }
}

async function previewArtifact(filePath) {
  if (!filePath || !elements.artifactPreview) return;
  const payload = await fetchJson(`/api/capture/artifact-content?path=${encodeURIComponent(filePath)}`);
  state.artifactPreviewPath = filePath;
  elements.artifactPreview.textContent = `${payload?.content || ""}`.trim() || "Artifact is empty.";
  elements.artifactPreview.hidden = false;
}

async function openArtifactFolder(dirPath) {
  if (!dirPath) return;
  await fetchJson("/api/capture/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: dirPath })
  });
}

async function sendArtifactToAgent(artifact) {
  if (!artifact?.sessionDir) return;
  setStatus("Sending artifact to backend agent…");
  const payload = await fetchJson("/api/capture/send-to-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_dir: artifact.sessionDir,
      session_id: state.sessionId || ""
    })
  });
  if (payload?.sessionId) setSession(payload.sessionId);
  if (`${payload?.assistantMessage || ""}`.trim()) {
    const attachments = Array.isArray(payload?.uploadedFiles)
      ? payload.uploadedFiles.map((name) => ({ name }))
      : [];
    state.computerMessages.push({
      role: "assistant",
      text: payload.assistantMessage,
      attachments
    });
    renderMessages();
  }
  appendActivityEvent(`Sent ${artifact.title || artifact.dirName || "artifact"} to backend agent review.`);
  renderEvents();
  setStatus("Sidecar ready.");
}

async function syncBatchJobs() {
  const payload = await fetchJson("/api/batch/jobs?limit=12");
  if (payload?.deferred && !Array.isArray(payload?.jobs)) return;
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const nextSignature = JSON.stringify(jobs.map((job) => [job.id, job.status, job.updated_at, job.item_summary?.succeeded, job.item_summary?.failed]));
  const currentSignature = JSON.stringify((state.batchJobs || []).map((job) => [job.id, job.status, job.updated_at, job.item_summary?.succeeded, job.item_summary?.failed]));
  if (nextSignature !== currentSignature) {
    state.batchJobs = jobs;
    renderBatchJobs();
  }
  renderRunSummary();
}

async function planBatchJob() {
  setStatus("Planning batch job…");
  const payload = await fetchJson("/api/batch/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBatchPlanRequest())
  });
  if (payload?.job?.id) {
    state.focusedBatchJobId = payload.job.id;
    appendActivityEvent(`Batch job planned: ${payload.job.title || payload.job.id}.`);
    renderEvents();
  }
  await syncBatchJobs();
  setStatus("Sidecar ready.");
}

async function runBatchJobAction(jobId, operation) {
  if (!jobId || !operation) return;
  const endpoint = `/api/batch/jobs/${encodeURIComponent(jobId)}/${operation}`;
  setStatus(`Batch ${operation.replace(/-/g, " ")}…`);
  const payload = await fetchJson(endpoint, { method: "POST" });
  if (payload?.job?.id) {
    state.focusedBatchJobId = payload.job.id;
    appendActivityEvent(`Batch job ${payload.job.id} ${operation.replace(/-/g, " ")}.`);
    renderEvents();
  }
  await syncBatchJobs();
  setStatus("Sidecar ready.");
}

function resetBatchDraft() {
  if (!elements.batchJobTypeSelect) return;
  const currentType = `${elements.batchJobTypeSelect?.value || "delegated_revit_task_batch"}`.trim();
  const base = defaultBatchDraft();
  if (currentType === "room_view_capture") {
    base.job_type = "room_view_capture";
    base.title = "Capture room discipline screenshots";
    base.task_prompt = "";
    base.scope_description = "";
    base.work_item_hint = "";
  }
  setBatchDraftFromTemplate(base, null);
}

function nowIso() {
  return new Date().toISOString();
}

function randomCaptureId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function blobToPendingAttachment(blob, name, mimeType = blob.type || "application/octet-stream") {
  const array = new Uint8Array(await blob.arrayBuffer());
  return {
    id: randomCaptureId("capture"),
    name,
    mimeType,
    sizeBytes: blob.size || array.byteLength || 0,
    dataBase64: base64FromUint8(array)
  };
}

async function captureAmbientScreenshot(tag = "capture") {
  const response = await fetch(`/api/desktop/screenshot?ts=${Date.now()}`);
  if (!response.ok) {
    throw new Error("Failed to capture the current screen for capture mode.");
  }
  const blob = await response.blob();
  const stamp = nowIso().replace(/[:.]/g, "-");
  return await blobToPendingAttachment(blob, `${tag}_${stamp}.png`, blob.type || "image/png");
}

function updateAmbientCaptureButtons() {
  const mode = state.captureState.mode;
  const busy = state.captureState.busy;
  if (elements.listenButton) elements.listenButton.textContent = mode === "listen" ? (busy ? "Processing Listen..." : "Stop Listen") : "Listen In";
  if (elements.learnButton) elements.learnButton.textContent = mode === "learn" ? (busy ? "Processing Teach..." : "Stop Teach") : "Teach";
  if (elements.switchDisplayButton) {
    elements.switchDisplayButton.textContent = busy ? "Switching..." : "Switch Share";
    elements.switchDisplayButton.title = mode
      ? state.captureState.displayLabel
        ? `Switch the current ${captureModeLabel(mode)} display share (${state.captureState.displayLabel})`
        : `Add or switch a shared display for ${captureModeLabel(mode)}`
      : "Switch the shared display";
  }
  elements.listenButton?.classList.toggle("active", mode === "listen");
  elements.learnButton?.classList.toggle("active", mode === "learn");
  updateControls();
}

function resetAmbientCaptureState() {
  if (state.captureState.screenshotTimer) {
    clearInterval(state.captureState.screenshotTimer);
  }
  if (state.captureState.chunkTimer) {
    clearInterval(state.captureState.chunkTimer);
  }
  if (state.captureState.reviewTimer) {
    clearInterval(state.captureState.reviewTimer);
  }
  state.captureState = {
    mode: "",
    busy: false,
    micSession: null,
    systemSession: null,
    displayStream: null,
    displayLabel: "",
    displayAudioEnabled: false,
    screenshots: [],
    screenshotTimer: null,
    chunkTimer: null,
    reviewTimer: null,
    warnings: [],
    startedAt: "",
    micTranscript: "",
    systemTranscript: "",
    micTranscriptPromise: Promise.resolve(""),
    systemTranscriptPromise: Promise.resolve(""),
    micChunkCount: 0,
    systemChunkCount: 0,
    liveReviewBusy: false,
    lastLearnReviewInputSignature: "",
    lastLearnReviewMessageSignature: "",
    eventTimeline: [],
    liveReviewHistory: []
  };
  updateAmbientCaptureButtons();
}

function buildListenSummary(payload) {
  const analysis = payload?.analysis || {};
  const lines = [];
  const title = `${analysis.title || ""}`.trim();
  if (title) lines.push(title);
  const mode = `${analysis.mode || "note"}`.trim();
  lines.push(`Mode: ${mode}`);
  if (`${analysis.speaker_confidence_note || ""}`.trim()) {
    lines.push(`Speaker attribution: ${analysis.speaker_confidence_note.trim()}`);
  }
  if (`${analysis.reply || ""}`.trim()) lines.push(`Reply: ${analysis.reply.trim()}`);
  if (`${analysis.meeting_summary || ""}`.trim()) lines.push(`Summary: ${analysis.meeting_summary.trim()}`);
  const keyPoints = Array.isArray(analysis.key_points) ? analysis.key_points.filter(Boolean) : [];
  if (keyPoints.length > 0) {
    lines.push("Key points:");
    for (const point of keyPoints.slice(0, 8)) lines.push(`- ${point}`);
  }
  const actions = Array.isArray(analysis.action_items) ? analysis.action_items.filter(Boolean) : [];
  if (actions.length > 0) {
    lines.push("Action items:");
    for (const item of actions.slice(0, 8)) {
      const owner = `${item.owner || "unknown"}`.trim();
      const task = `${item.task || ""}`.trim();
      if (task) lines.push(`- ${owner}: ${task}`);
    }
  }
  if (`${payload?.artifactMarkdownPath || ""}`.trim()) lines.push(`Saved minutes: ${payload.artifactMarkdownPath}`);
  return lines.join("\n").trim();
}

function buildLearnSummary(payload) {
  const analysis = payload?.analysis || {};
  const lines = [];
  const title = `${analysis.title || ""}`.trim();
  if (title) lines.push(title);
  const sessionType = `${analysis.session_type || "teaching_demo"}`.trim();
  lines.push(`Teach mode: ${sessionType}`);
  if (`${payload?.localSkillId || ""}`.trim()) lines.push(`Generated skill: ${payload.localSkillId.trim()}`);
  if (`${payload?.localSkillPath || ""}`.trim()) lines.push(`Saved skill: ${payload.localSkillPath.trim()}`);
  if (`${analysis.summary || ""}`.trim()) lines.push(`Summary: ${analysis.summary.trim()}`);
  if (`${analysis.junior_brief || ""}`.trim()) lines.push(`Junior brief: ${analysis.junior_brief.trim()}`);
  if (`${analysis.assignment_template || ""}`.trim()) lines.push(`Assignment template: ${analysis.assignment_template.trim()}`);
  if (`${analysis.assignment_prompt || ""}`.trim()) lines.push(`Assignment prompt: ${analysis.assignment_prompt.trim()}`);
  if (`${analysis?.batch_template?.job_type || ""}`.trim()) {
    lines.push(`Batch template: ${analysis.batch_template.job_type}`);
  }
  const checklist = Array.isArray(analysis.verification_checklist) ? analysis.verification_checklist.filter(Boolean) : [];
  if (checklist.length > 0) {
    lines.push("Verification checklist:");
    for (const item of checklist.slice(0, 8)) lines.push(`- ${item}`);
  }
  if (`${payload?.artifactMarkdownPath || ""}`.trim()) lines.push(`Supporting brief: ${payload.artifactMarkdownPath}`);
  if (`${payload?.artifactJsonPath || ""}`.trim()) lines.push(`Supporting analysis: ${payload.artifactJsonPath}`);
  if (`${payload?.artifactEventLogPath || ""}`.trim()) lines.push(`Event log: ${payload.artifactEventLogPath}`);
  if (`${payload?.artifactLiveReviewPath || ""}`.trim()) lines.push(`Live review log: ${payload.artifactLiveReviewPath}`);
  if (`${payload?.memoryMessage || ""}`.trim()) lines.push(`Memory: ${payload.memoryMessage.trim()}`);
  if (`${payload?.skillStageMessage || ""}`.trim()) lines.push(`Skill staging: ${payload.skillStageMessage.trim()}`);
  return lines.join("\n").trim();
}

async function onRecStart() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not available in this browser.");
  }
  if (state.recState.busy || state.recState.recording) return;

  state.recState.busy = true;
  setRecUiState();
  try {
    if (elements.micLevelText) elements.micLevelText.textContent = `Using ${selectedMicLabel()}`;
    state.recState.session = await startWavRecording();
    state.recState.recording = true;
  } finally {
    state.recState.busy = false;
    setRecUiState();
  }
}

async function onRecStop() {
  if (state.recState.busy || !state.recState.recording || !state.recState.session) return;

  state.recState.busy = true;
  setRecUiState();
  const session = state.recState.session;
  state.recState.session = null;
  state.recState.recording = false;

  try {
    const result = await session.stop();
    const audioPayload = await normalizeRecordedAudio(result);
    if (!audioPayload?.audio_base64) {
      const message = describeNoAudioCaptured(session);
      setStatus(message);
      if (elements.micLevelText) elements.micLevelText.textContent = `No input from ${selectedMicLabel()}`;
      appendActivityEvent(message, "", { tone: "tone-warning" });
      renderEvents();
      return;
    }
    const payload = await fetchJson("/api/voice/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioPayload)
    });
    const text = `${payload?.text || ""}`.trim();
    if (text) {
      const spacer = elements.promptInput.value && !elements.promptInput.value.endsWith(" ") ? " " : "";
      elements.promptInput.value = `${elements.promptInput.value || ""}${spacer}${text}`.trim();
      elements.promptInput.focus();
      if (elements.micLevelText) elements.micLevelText.textContent = "Transcribed";
    } else {
      setStatus("No speech was transcribed.");
      if (elements.micLevelText) elements.micLevelText.textContent = "No speech";
    }
  } finally {
    state.recState.busy = false;
    setRecUiState();
  }
}

async function normalizeRecordedAudio(sessionResult) {
  if (!sessionResult) return null;
  if (typeof sessionResult.audioBase64 === "string" && sessionResult.audioBase64.trim()) {
    return {
      audio_base64: sessionResult.audioBase64.trim(),
      format: `${sessionResult.format || "webm"}`.trim().toLowerCase()
    };
  }
  if (sessionResult.samples instanceof Float32Array && Number.isFinite(sessionResult.sampleRate)) {
    const wavBytes = encodeWav16Mono(sessionResult.samples, sessionResult.sampleRate);
    return {
      audio_base64: base64FromUint8(wavBytes),
      format: "wav"
    };
  }
  return null;
}

function describeDisplayStream(displayStream) {
  if (!displayStream) return "shared display";
  const videoTrack = displayStream.getVideoTracks?.()[0];
  const label = `${videoTrack?.label || "shared display"}`.trim();
  return label || "shared display";
}

async function requestAmbientDisplayShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Display sharing is not available in this browser.");
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true
  });
  const systemAudioStream = new MediaStream(displayStream.getAudioTracks());
  const systemSession =
    systemAudioStream.getAudioTracks().length > 0 ? await beginAudioCaptureSession(systemAudioStream) : null;

  return {
    displayStream,
    systemSession,
    displayLabel: describeDisplayStream(displayStream),
    displayAudioEnabled: !!systemSession
  };
}

function stopMediaStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // ignore
  }
}

async function finalizeCaptureAudioSession(sourceKey, contextLabel = "final chunk") {
  const capture = state.captureState;
  const sessionKey = sourceKey === "system" ? "systemSession" : "micSession";
  const promiseKey = sourceKey === "system" ? "systemTranscriptPromise" : "micTranscriptPromise";
  const session = capture?.[sessionKey];
  if (!session?.stop) return null;
  await (capture?.[promiseKey] || Promise.resolve("")).catch(() => "");
  const rawAudio = await session.stop();
  capture[sessionKey] = null;
  const normalized = await normalizeRecordedAudio(rawAudio);
  if (normalized) {
    await transcribeCaptureAudioChunk(sourceKey, normalized, contextLabel);
  }
  return normalized;
}

async function switchAmbientDisplayShare() {
  const capture = state.captureState;
  if (!capture?.mode || capture.busy) return;

  capture.busy = true;
  updateAmbientCaptureButtons();
  setStatus(`Switching ${captureModeLabel(capture.mode)} display share...`);
  let nextShare = null;
  try {
    nextShare = await requestAmbientDisplayShare();
    const previousDisplay = capture.displayStream;
    await finalizeCaptureAudioSession("system", "before share switch");
    stopMediaStream(previousDisplay);

    capture.displayStream = nextShare.displayStream;
    capture.systemSession = nextShare.systemSession;
    capture.displayLabel = nextShare.displayLabel;
    capture.displayAudioEnabled = nextShare.displayAudioEnabled;
    appendActivityEvent(
      `${captureModeLabel(capture.mode)} switched shared display to ${capture.displayLabel}${capture.displayAudioEnabled ? " with system audio." : " without system audio."}`
    );
    appendCaptureTimeline("Switched the shared display during capture.", "capture", {
      display_label: capture.displayLabel,
      system_audio: capture.displayAudioEnabled
    });
    renderEvents();
    setStatus(`${captureModeLabel(capture.mode)} capturing...`);
  } catch (error) {
    stopMediaStream(nextShare?.displayStream || null);
    capture.warnings.push(`Display share switch failed: ${error?.message || String(error)}`);
    appendActivityEvent(`Display share switch failed: ${error?.message || String(error)}`);
    appendCaptureTimeline("Failed to switch the shared display.", "warning", {
      error: error?.message || String(error)
    });
    renderEvents();
    setStatus(`${captureModeLabel(capture.mode)} capturing...`);
    return false;
  } finally {
    capture.busy = false;
    updateAmbientCaptureButtons();
  }
  return true;
}

async function startAmbientCapture(mode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Audio capture is not available in this browser.");
  }
  if (state.captureState.busy || state.captureState.mode) return;

  state.captureState.busy = true;
  updateAmbientCaptureButtons();

  let micStream = null;
  let displayShare = null;
  const warnings = [];

  try {
    micStream = await navigator.mediaDevices.getUserMedia(buildMicAudioConstraints());
    const micSession = await beginAudioCaptureSession(micStream);

    try {
      if (navigator.mediaDevices?.getDisplayMedia) {
        displayShare = await requestAmbientDisplayShare();
      }
    } catch (error) {
      warnings.push(`System audio capture not enabled: ${error?.message || String(error)}`);
    }

    if (displayShare && !displayShare.displayAudioEnabled) {
      warnings.push("No system-audio track was shared. Listen In will rely on microphone audio only.");
    }

    state.captureState = {
      mode,
      busy: false,
      micSession,
      systemSession: displayShare?.systemSession || null,
      displayStream: displayShare?.displayStream || null,
      displayLabel: displayShare?.displayLabel || "",
      displayAudioEnabled: !!displayShare?.displayAudioEnabled,
      screenshots: [],
      screenshotTimer: null,
      chunkTimer: null,
      reviewTimer: null,
      warnings,
      startedAt: nowIso(),
      micTranscript: "",
      systemTranscript: "",
      micTranscriptPromise: Promise.resolve(""),
      systemTranscriptPromise: Promise.resolve(""),
      micChunkCount: 0,
      systemChunkCount: 0,
      liveReviewBusy: false,
      lastLearnReviewInputSignature: "",
      lastLearnReviewMessageSignature: "",
      eventTimeline: [],
      liveReviewHistory: []
    };
    appendCaptureTimeline(`${captureModeLabel(mode)} capture started.`, "capture", {
      mode,
      started_at: state.captureState.startedAt
    });
    if (state.captureState.displayLabel) {
      appendActivityEvent(
        `${captureModeLabel(mode)} shared ${state.captureState.displayLabel}${state.captureState.displayAudioEnabled ? " with system audio." : " without system audio."}`
      );
      appendCaptureTimeline("Shared display selected for capture.", "capture", {
        display_label: state.captureState.displayLabel,
        system_audio: state.captureState.displayAudioEnabled
      });
    } else {
      appendActivityEvent(`${captureModeLabel(mode)} started with microphone capture only. Use Switch Share to add a screen or system audio.`);
      appendCaptureTimeline("Capture started without a shared display.", "warning", {
        system_audio: false
      });
    }

    try {
      await captureModeScreenshot(mode === "learn" ? "learn_start" : "listen_start");
    } catch (error) {
      state.captureState.warnings.push(error?.message || String(error));
      appendCaptureTimeline(`Initial screenshot failed: ${error?.message || String(error)}`, "warning");
    }

    scheduleCaptureChunking();
    scheduleCaptureScreenshots();
    scheduleLearnLiveReview();

    updateAmbientCaptureButtons();
    setStatus(mode === "listen" ? "Listen In capturing…" : "Teach capturing…");
    if (mode === "learn") {
      state.computerMessages.push({
        role: "assistant",
        text: "Teach mode is active. Walk me through the task naturally. I’ll review the transcript and screenshots as we go, and I’ll ask follow-up questions here if I need clarification before I can repeat it.",
        attachments: []
      });
      renderMessages();
    }
    if (warnings.length > 0) {
      appendActivityEvent(warnings[0]);
      appendCaptureTimeline(warnings[0], "warning");
      renderEvents();
    }
  } catch (error) {
    try { micStream?.getTracks().forEach((track) => track.stop()); } catch {}
    stopMediaStream(displayShare?.displayStream || null);
    resetAmbientCaptureState();
    throw error;
  }
}

async function stopAmbientCapture() {
  if (state.captureState.busy || !state.captureState.mode) return;
  const capture = state.captureState;
  state.captureState.busy = true;
  updateAmbientCaptureButtons();
  setStatus(capture.mode === "listen" ? "Processing Listen In…" : "Processing Teach…");

  try {
    if (capture.screenshotTimer) clearInterval(capture.screenshotTimer);
    if (capture.chunkTimer) clearInterval(capture.chunkTimer);
    if (capture.reviewTimer) clearInterval(capture.reviewTimer);
    appendCaptureTimeline(`${captureModeLabel(capture.mode)} capture stopped. Processing session output.`, "capture", {
      mode: capture.mode
    });

    if (capture.screenshots.length < captureScreenshotLimit(capture.mode)) {
      try {
        await captureModeScreenshot(capture.mode === "learn" ? "learn_end" : "listen_end");
      } catch {
        // ignore
      }
    }

    await Promise.all([
      finalizeCaptureAudioSession("mic", "final chunk"),
      finalizeCaptureAudioSession("system", "final chunk")
    ]);
    stopMediaStream(capture.displayStream);
    const requestBody = {
      session_id: state.sessionId || undefined,
      started_at: capture.startedAt,
      ended_at: nowIso(),
      warnings: capture.warnings,
      mic_transcript: capture.micTranscript,
      system_transcript: capture.systemTranscript,
      pending_attachments: capture.screenshots,
      event_timeline: Array.isArray(capture.eventTimeline) ? capture.eventTimeline : [],
      live_review_history: Array.isArray(capture.liveReviewHistory) ? capture.liveReviewHistory : []
    };

    let payload = null;
    if (capture.mode === "listen") {
      payload = await fetchJson("/api/listen/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      if (payload?.sessionId) setSession(payload.sessionId);
      const summary = buildListenSummary(payload);
      if (summary) {
        state.computerMessages.push({ role: "assistant", text: summary, attachments: [] });
        renderMessages();
      }
      appendActivityEvent(`Listen In processed as ${payload?.analysis?.mode || "note"}.`);
      renderEvents();
      const promptToExecute = `${payload?.analysis?.prompt_to_execute || ""}`.trim();
      if (`${payload?.analysis?.mode || ""}`.trim().toLowerCase() === "directive" && promptToExecute) {
        appendActivityEvent("Instruction detected. Starting the task.");
        renderEvents();
        await sendPrompt(promptToExecute, []);
      } else {
        setStatus("Sidecar ready.");
      }
    } else {
      await runLearnLiveReview({ force: true });
      payload = await fetchJson("/api/learn/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      if (payload?.sessionId) setSession(payload.sessionId);
      const summary = buildLearnSummary(payload);
      if (summary) {
        state.computerMessages.push({ role: "assistant", text: summary, attachments: [] });
        renderMessages();
      }
      appendActivityEvent("Teach session compiled into a reusable skill with supporting evidence.");
      if (`${payload?.localSkillPath || ""}`.trim()) {
        appendActivityEvent(`Teach skill saved to ${payload.localSkillPath}`);
      }
      if (`${payload?.artifactMarkdownPath || ""}`.trim()) {
        appendActivityEvent(`Teach evidence brief saved to ${payload.artifactMarkdownPath}`);
      }
      if (`${payload?.artifactEventLogPath || ""}`.trim()) {
        appendActivityEvent(`Teach event log saved to ${payload.artifactEventLogPath}`);
      }
      renderEvents();
      setStatus("Sidecar ready.");
    }
    await syncCaptureArtifacts();
  } finally {
    resetAmbientCaptureState();
  }
}

async function speakLastAssistantMessage() {
  const message = latestAssistantMessage();
  if (!message) return;

  const payload = await fetchJson("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: splitAssistantControlText(message.text).text })
  });
  const format = `${payload?.format || "mp3"}`.trim() || "mp3";
  const audioBase64 = `${payload?.audio_base64 || ""}`.trim();
  if (!audioBase64) {
    throw new Error("Voice playback returned no audio.");
  }

  const audio = new Audio(`data:audio/${format};base64,${audioBase64}`);
  await audio.play();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function assertAttachmentTotalSize(attachments, files = []) {
  const limit = state.attachmentLimits?.maxTotalBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0) return;
  const total = attachments.reduce((sum, file) => sum + (file.sizeBytes || 0), 0)
    + files.reduce((sum, file) => sum + file.size, 0);
  if (total > limit) {
    throw new Error(`The combined attachment size exceeds ${formatBytes(limit)}. Remove a reference and try again.`);
  }
}

async function addSelectedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const limits = state.attachmentLimits;
  const assertAttachmentCount = () => {
    if (limits && state.pendingAttachments.length + files.length > limits.maxCount) {
      throw new Error(`You can send at most ${limits.maxCount} attachments per message. Remove extra files and try again.`);
    }
  };
  assertAttachmentCount();
  const oversized = limits && files.find(file => file.size > limits.maxFileBytes);
  if (oversized) {
    throw new Error(`${oversized.name} exceeds the ${limits.maxFileBytes}-byte limit.`);
  }
  assertAttachmentTotalSize(state.pendingAttachments, files);

  const sessionId = state.sessionId;
  const navigationEpoch = state.taskNavigationEpoch;
  state.attachmentReadsPending++;
  updateControls();
  try {
    const next = [];
    for (const file of files) {
      const dataUrl = await readFileAsDataUrl(file);
      const commaIndex = dataUrl.indexOf(",");
      if (commaIndex === -1 || commaIndex === dataUrl.length - 1) {
        throw new Error(`Could not read ${file.name} as an attachment.`);
      }

      next.push({
        id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        mimeType: file.type || "",
        sizeBytes: file.size || 0,
        dataBase64: dataUrl.slice(commaIndex + 1)
      });
    }

    // File reads can outlive the original conversation or a second selection.
    if (state.sessionId !== sessionId || state.taskNavigationEpoch !== navigationEpoch) {
      throw new Error("The conversation changed while reading these files. Attach them again in the intended conversation.");
    }
    assertAttachmentCount();
    assertAttachmentTotalSize(state.pendingAttachments, files);
    state.pendingAttachments = [...state.pendingAttachments, ...next];
    renderAttachStrip();
    composerDraftRevision++;
    const recoveryWarning = 'Attachments are available in this tab. Keep the original files before refreshing because local draft recovery is unavailable.';
    if (!await persistComposerDraft()) {
      showComposerNotice(recoveryWarning);
    } else if (document.getElementById('composerNotice')?.textContent === recoveryWarning) {
      showComposerNotice('');
    }
  } finally {
    state.attachmentReadsPending--;
    updateControls();
  }
}

async function attachComposerFiles(fileList) {
  try {
    await addSelectedFiles(fileList);
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Attachment failed.");
  }
}

function isFileDrop(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

async function addClipboardItems(items) {
  const files = [];
  for (const item of Array.from(items || [])) {
    if (!item || item.kind !== "file" || !item.type?.startsWith("image/")) continue;
    const file = item.getAsFile?.();
    if (!file) continue;
    files.push(new File([file], file.name || `pasted-image-${Date.now()}.png`, { type: file.type || "image/png" }));
  }
  if (files.length > 0) {
    await addSelectedFiles(files);
  }
  return files.length;
}

async function handlePasteAttachments(event) {
  const added = await addClipboardItems(event.clipboardData?.items || []);
  if (added > 0) {
    event.preventDefault();
    setStatus(`Attached ${added} pasted image${added === 1 ? "" : "s"}.`);
  }
}

function pushBackendMessage(role, text) {
  state.backendMessages.push({ role, text, attachments: [] });
}

function createChatSubmission(prompt, attachments) {
  const rawPrompt = `${prompt || ""}`;
  const text = rawPrompt.trim();
  const copiedAttachments = Array.isArray(attachments)
    ? attachments.map((attachment) => ({ ...attachment }))
    : [];
  if (!text && copiedAttachments.length === 0) return null;
  return {
    id: randomId(),
    rawPrompt,
    text,
    attachments: copiedAttachments,
    mode: selectChatSubmissionMode(state, text),
    newComputerConversation: startsFreshComputerConversation(state),
    transportStarted: false,
    optimisticMessage: null
  };
}

function beginOptimisticChatSubmission(submission) {
  // Freeze observation intent before the first async preflight can let a timer
  // see the previous idle relay. Only the exact submitted nonce acknowledges it.
  if (submission.mode === "computer-run") state.computerSubmissionMessageId = submission.id;
  const next = nextOptimisticChatSubmissionState({
    backendMessages: state.backendMessages,
    computerMessages: state.computerMessages,
    pendingComputerUserMessages: state.pendingComputerUserMessages
  }, submission);
  state.activeRunKind = next.activeRunKind;
  state.backendMessages = next.backendMessages;
  state.computerMessages = next.computerMessages;
  state.pendingComputerUserMessages = next.pendingComputerUserMessages;
  submission.optimisticMessage = next.message;
  renderMessages();
}

function clearChatComposerForSubmission() {
  elements.promptInput.value = "";
  elements.promptInput.focus();
  state.pendingAttachments = [];
  renderAttachStrip();
  updateFeedbackBarVisibility();
  scheduleComposerDraftSave();
  showComposerNotice("");
}

function restoreChatSubmissionInput(submission) {
  if (!elements.promptInput.value) elements.promptInput.value = submission.rawPrompt;
  if (state.pendingAttachments.length === 0) {
    state.pendingAttachments = submission.attachments.map((attachment) => ({ ...attachment }));
    renderAttachStrip();
  }
  elements.promptInput.focus();
  updateFeedbackBarVisibility();
  scheduleComposerDraftSave();
}

async function ensureSession(resetTranscript = false) {
  if (state.sessionId && !resetTranscript) {
    return state.sessionId;
  }

  const epoch = state.taskNavigationEpoch;
  const payload = await fetchJson("/api/session/new", { method: "POST" });
  if (epoch !== state.taskNavigationEpoch) throw Object.assign(new Error("The selected conversation changed."), { name: "AbortError" });
  setSession(payload.session_id || "");
  if (resetTranscript) {
    state.backendMessages = [];
  }
  return state.sessionId;
}

async function refreshScreen() {
  if (desktopPreviewCaptureBlocked(state.computerRunSubmissionPending, state.desktopCaptureSuppressed)) return;
  state.screenLoading = true;
  state.screenError = "";
  renderScreenMeta();
  try {
    const response = await fetch(`/api/desktop/screenshot?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Screenshot request failed.");
    }
    const responseScreen = readScreenMetadataHeader(response);
    if (responseScreen) {
      state.computerScreen = responseScreen;
    }
    const blob = await response.blob();
    const previewBlob = await buildDesktopPreviewBlob(blob, state.computerScreen);
    const nextOriginalUrl = URL.createObjectURL(blob);
    const nextPreviewUrl = URL.createObjectURL(previewBlob);
    const previousOriginalUrl = state.screenObjectUrl;
    const previousPreviewUrl = state.screenPreviewObjectUrl;
    state.screenObjectUrl = nextOriginalUrl;
    state.screenPreviewObjectUrl = nextPreviewUrl;
    elements.screenImage.src = nextPreviewUrl;
    if (elements.screenDialogImage) {
      elements.screenDialogImage.src = nextOriginalUrl;
    }
    state.screenCapturedAt = new Date().toISOString();
    if (previousOriginalUrl) URL.revokeObjectURL(previousOriginalUrl);
    if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl);
  } catch (error) {
    state.screenError = error?.message || String(error);
  } finally {
    state.screenLoading = false;
    renderScreenMeta();
  }
}

function scheduleScreenRefresh() {
  if (state.screenTimer) clearInterval(state.screenTimer);
  state.screenTimer = setInterval(refreshScreen, 10000);
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readBoolSetting(key, fallback) {
  try {
    const value = `${localStorage.getItem(key) || ""}`.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
  } catch {
    // ignore storage failures
  }
  return !!fallback;
}

function writeBoolSetting(key, value) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch {}
}

function readStringSetting(key, fallback) {
  try {
    const value = `${localStorage.getItem(key) || ""}`.trim();
    if (value) return value;
  } catch {
    // ignore storage failures
  }
  return `${fallback || ""}`;
}

function writeStringSetting(key, value) {
  try { localStorage.setItem(key, `${value || ""}`); } catch {}
}

function normalizeSpeedModel(value, fallback) {
  return normalizeAgentModel(value, fallback);
}

function normalizeReasoningEffort(value, fallback = "medium") {
  const effort = `${value || ""}`.trim().toLowerCase();
  return ["none", "low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : fallback;
}

function getSpeedSettings() {
  const speedMode = true; // Managed defaults; no cryptic performance switches.
  const contextDiet = true;
  return {
    agent_model: normalizeSpeedModel(elements.agentModel?.value, "gpt-5.6-sol"),
    agent_reasoning_effort: normalizeReasoningEffort(elements.agentReasoning?.value, "medium"),
    speed_mode: speedMode,
    show_work_as_it_runs: !!elements.showWork?.checked,
    context_diet: contextDiet,
    max_recent_turns: 8,
    include_full_revit_state: !contextDiet,
    include_screenshot_every_turn: false,
    verbose_tool_results: !contextDiet,
    batch_execution: false,
    persistent_session_mode: false
  };
}

function synchronizeModelReasoning() {
  if (!elements.agentReasoning) return;
  const model = elements.agentModel?.value;
  const requiresReasoning = agentModelRequiresReasoning(model);
  const optional = isOptionalProviderModel(model);
  for (const option of elements.agentReasoning.options || []) {
    option.disabled = (option.value === "none" && requiresReasoning) || (optional && ["xhigh", "max"].includes(option.value));
  }
  if (optional && ["xhigh", "max"].includes(elements.agentReasoning.value)) elements.agentReasoning.value = "medium";
  if (requiresReasoning && elements.agentReasoning.value === "none") {
    elements.agentReasoning.value = "low";
    writeStringSetting("operator.agentReasoning", "low");
  }
}

function initializeSpeedControls() {
  if (elements.showWork) {
    elements.showWork.checked = readBoolSetting('operator.showWork', false);
    elements.showWork.addEventListener('change', () => writeBoolSetting('operator.showWork', !!elements.showWork.checked));
  }
  if (elements.agentModel) {
    elements.agentModel.value = normalizeSpeedModel(readStringSetting("operator.agentModel", "gpt-5.6-sol"), "gpt-5.6-sol");
    elements.agentModel.addEventListener("change", () => {
      elements.agentModel.value = normalizeSpeedModel(elements.agentModel.value, "gpt-5.6-sol");
      writeStringSetting("operator.agentModel", elements.agentModel.value);
      synchronizeModelReasoning();
    });
  }
  if (elements.agentReasoning) {
    elements.agentReasoning.value = normalizeReasoningEffort(readStringSetting("operator.agentReasoning", "medium"), "medium");
    elements.agentReasoning.addEventListener("change", () => {
      elements.agentReasoning.value = normalizeReasoningEffort(elements.agentReasoning.value, "medium");
      synchronizeModelReasoning();
      writeStringSetting("operator.agentReasoning", elements.agentReasoning.value);
    });
  }
  synchronizeModelReasoning();
}

function escapeHtml(value) {
  return `${value ?? ""}`.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[ch] || ch);
}

function selectedGoal() {
  if (state.activeGoalId) {
    const explicit = state.goals.find((goal) => goal?.id === state.activeGoalId);
    if (explicit) return explicit;
  }
  return chooseCurrentAssignment(state.goals, state.assignmentRevitContext, state.sessionId);
}

function goalStatusLabel(goal) {
  return `${goal?.status || "none"}`.replace(/_/g, " ");
}

function assignmentSettledForPacket(goal = null) {
  const status = `${goal?.status || ""}`.trim().toLowerCase();
  const phase = `${goal?._assignmentPhase || ""}`.trim().toLowerCase();
  return ["blocked", "complete", "canceled", "cancelled", "failed"].includes(status)
    || ["blocked", "complete", "complete_with_issues", "canceled", "cancelled", "failed", "outcome_uncertain"].includes(phase);
}

function renderVerifiedWorkPacketPanel(goal = null) {
  if (!elements.verifiedWorkPacket || !elements.verifiedWorkPacketContent) return;
  const assignmentId = `${goal?.id || ""}`;
  const packet = assignmentId && state.verifiedWorkPacketAssignmentId === assignmentId
    ? state.verifiedWorkPacket
    : null;
  const html = packet ? renderVerifiedWorkPacketHtml(packet, assignmentId) : "";
  elements.verifiedWorkPacket.hidden = !html;
  elements.verifiedWorkPacketContent.innerHTML = html;
}

function renderWorkReturnPanel() {
  if (!elements.workReturn || !elements.workReturnContent) return;
  const html = renderWorkReturnHtml(state.workReturn);
  elements.workReturn.hidden = !html;
  elements.workReturnContent.innerHTML = html;
}

async function syncSavedWorkReturn(goal, requestId) {
  const binding = goal?._bindingV2;
  if (!binding) return;
  try {
    const payload = await fetchJson(`/api/assignments/${encodeURIComponent(binding.assignment_id)}/work-return`);
    if (requestId !== state.verifiedWorkPacketRequestId) return;
    const current = selectedGoal()?._bindingV2, value = payload?.work_return;
    if (!current || !['assignment_id', 'run_id', 'generation'].every(key => current[key] === binding[key] && value?.[key] === binding[key])) return;
    if (value.schema !== 'revit-operator.work-return/v1') return;
    state.workReturn = value;
  } catch {
    if (requestId !== state.verifiedWorkPacketRequestId) return;
    state.workReturn = null;
  }
  renderWorkReturnPanel();
}

async function syncVerifiedWorkPacket(goal = null) {
  const assignmentId = `${goal?.id || ""}`.trim();
  const requestId = ++state.verifiedWorkPacketRequestId;
  if (!assignmentId || !assignmentSettledForPacket(goal)) {
    state.verifiedWorkPacket = null;
    state.verifiedWorkPacketAssignmentId = "";
    renderVerifiedWorkPacketPanel(goal);
    return;
  }
  if (state.taskNavigationMode) await syncSavedWorkReturn(goal, requestId);
  if (requestId !== state.verifiedWorkPacketRequestId) return;
  if (state.verifiedWorkPacket && state.verifiedWorkPacketAssignmentId === assignmentId) {
    renderVerifiedWorkPacketPanel(goal);
    return;
  }
  try {
    const payload = await fetchJson(`/api/assignments/${encodeURIComponent(assignmentId)}/verified-work-packet`);
    if (requestId !== state.verifiedWorkPacketRequestId) return;
    state.verifiedWorkPacket = payload?.packet || null;
    state.verifiedWorkPacketAssignmentId = state.verifiedWorkPacket ? assignmentId : "";
  } catch {
    if (requestId !== state.verifiedWorkPacketRequestId) return;
    state.verifiedWorkPacket = null;
    state.verifiedWorkPacketAssignmentId = "";
  }
  renderVerifiedWorkPacketPanel(selectedGoal());
}

function renderGoalPanel() {
  const goal = selectedGoal();
  if (!elements.goalSummary) return;
  if (!goal) {
    if (elements.assignmentKicker) elements.assignmentKicker.textContent = "Active assignment";
    elements.assignmentHeading.textContent = "Ready for work";
    elements.assignmentStatus.textContent = "Idle";
    elements.assignmentStatus.className = "assignmentStatus tone-neutral";
    elements.goalSummary.textContent = "No active assignment. Ask Operator to do something in Revit.";
    elements.assignmentCompact.hidden = true;
    elements.assignmentProgressText.textContent = "No plan yet";
    elements.assignmentProgressFill.style.width = "0%";
    elements.assignmentProgressBar.removeAttribute("aria-valuenow");
    elements.assignmentProgressBar.setAttribute("aria-valuetext", "No plan yet");
    elements.assignmentPlan.hidden = true;
    elements.assignmentPlanList.innerHTML = "";
    elements.assignmentBlocker.hidden = true;
    elements.assignmentBlocker.textContent = "";
    elements.assignmentAssumptions.hidden = true;
    elements.assignmentAssumptionList.innerHTML = "";
    elements.assignmentPane.classList.add("emptyAssignment");
    elements.assignmentPane.classList.remove("quickAssignment");
    if (elements.assignmentContext) {
      elements.assignmentContext.textContent = "";
      elements.assignmentContext.className = "assignmentContext";
    }
    renderVerifiedWorkPacketPanel(null);
  } else {
    const criteria = Array.isArray(goal.acceptance_criteria) ? goal.acceptance_criteria : [];
    const workItems = Array.isArray(goal.work_items) ? goal.work_items : [];
    const openWorkItems = workItems.filter((item) => !["complete", "skipped", "reported_complete"].includes(`${item?.status || "pending"}`));
    const assumptions = Array.isArray(goal.assumptions) ? goal.assumptions.filter((item) => ["proposed", "accepted"].includes(`${item?.status || "proposed"}`)) : [];
    const workPreview = openWorkItems.slice(0, 3).map((item) => `${item?.title || "Untitled work item"} (${item?.status || "pending"})`).join(" · ");
    const statusPresentation = goalStatusPresentation(goal);
    const progress = goalProgressPresentation(goal);
    const currentStep = goal.current_step || goal.current_phase || goal.progress_summary || "Assignment ready.";
    const projection = goal._projection || null;
    const approvals = Array.isArray(projection?.approvals) ? projection.approvals : [];
    const effects = projection?.effects || null;
    const artifacts = Array.isArray(projection?.artifacts) ? projection.artifacts : [];
    const target = projection?.target || {};
    const truth = projection?.truth || {};
    const execution = projection?.execution || {};
    const contextPresentation = assignmentContextPresentation(goal, state.assignmentRevitContext);
    const mutatingEffects = Number(effects?.create_count || 0) + Number(effects?.modify_count || 0) + Number(effects?.delete_count || 0);
    const awaitingApproval = approvals.some((item) => item?.status === "awaiting" || item?.status === "required");
    const quickAssignment = workItems.length <= 1 && criteria.length <= 2 && mutatingEffects === 0 && !awaitingApproval && !contextPresentation.resumeBlocked;
    const effectCounts = effects
      ? `${effects.create_count ?? "?"} create · ${effects.modify_count ?? "?"} modify · ${effects.delete_count ?? "?"} delete`
      : "";

    elements.assignmentPane.classList.remove("emptyAssignment");
    elements.assignmentPane.classList.toggle("quickAssignment", quickAssignment);
    if (elements.assignmentKicker) elements.assignmentKicker.textContent = state.goalSelectionPinned ? "Assignment history" : "Active assignment";
    elements.assignmentHeading.textContent = goal.title || "Untitled assignment";
    const displayedStatus = contextPresentation.resumeBlocked
      ? { label: contextPresentation.label, tone: "tone-danger" }
      : statusPresentation;
    elements.assignmentStatus.textContent = displayedStatus.label;
    elements.assignmentStatus.className = `assignmentStatus ${displayedStatus.tone}`;
    elements.assignmentCompact.hidden = !state.streaming;
    elements.assignmentCompactStatus.textContent = displayedStatus.label;
    elements.assignmentCompactStatus.className = `assignmentStatus ${displayedStatus.tone}`;
    elements.assignmentCompactTitle.textContent = goal.title || "Untitled assignment";
    elements.assignmentCompactStep.textContent = state.streaming ? state.agentProgress || compactWorkSummary(goal, true) : "";

    const heldWorker = goal._providerUsageHold?.worker_identity;
    const workerCopy = heldWorker ? [
      heldWorker.configured_billing_mode === "chatgpt" ? "Configured ChatGPT sign-in" : heldWorker.configured_billing_mode === "api_key" ? "Configured API-key login" : "Account mode unconfirmed",
      heldWorker.requested_model ? `Requested model: ${heldWorker.requested_model}` : "Requested model unconfirmed",
      heldWorker.requested_reasoning_effort ? `Requested reasoning: ${heldWorker.requested_reasoning_effort}` : "",
      heldWorker.reported_model ? `Provider-reported model: ${heldWorker.reported_model}` : ""
    ].filter(Boolean).join(" · ") : "";
    const targetCopy = [target.document_title, target.document_fingerprint ? `fingerprint ${target.document_fingerprint}` : "", target.executor_id ? `executor ${target.executor_id}` : ""].filter(Boolean).join(" · ");
    const truthFlags = [truth.stale === true ? "stale" : "", truth.outcome_uncertain === true ? "outcome uncertain" : "", truth.reconciliation_required === true ? "reconciliation required" : ""].filter(Boolean);
    const approvalCopy = approvals.map((item) => [item.status, item.binding_status, item.principal_id ? `by ${item.principal_id}` : "", item.preview_hash ? `preview ${item.preview_hash}` : ""].filter(Boolean).join(" · "));
    const artifactCopy = artifacts.slice(0, 6).map((item) => `${item.path || "artifact"}${item.sha256 ? ` · sha256 ${item.sha256}` : ""}${Number.isFinite(item.size_bytes) ? ` · ${item.size_bytes} bytes` : ""}`);
    const requestedEffect = ["read", "preview", "apply"].includes(execution.requested_effect) ? `${execution.requested_effect} requested` : "";
    const completionMode = execution.completion_mode === "verified_noop" ? "verified no-op (already satisfied)" : "";
    const executionCopy = [requestedEffect, completionMode, execution.substrate, ...(Array.isArray(execution.task_ids) ? execution.task_ids.map((id) => `task ${id}`) : []), ...(Array.isArray(execution.batch_job_ids) ? execution.batch_job_ids.map((id) => `batch ${id}`) : [])].filter(Boolean).join(" · ");
    const affectedCategories = Array.isArray(effects?.affected_categories) ? effects.affected_categories.filter(Boolean) : [];
    elements.goalSummary.innerHTML = `
      <div>${escapeHtml(goal.objective || "No objective recorded.")}</div>
      <div class="goalCurrentStep"><strong>Now:</strong> ${escapeHtml(currentStep)}</div>
      <div>${criteria.length} acceptance ${criteria.length === 1 ? "criterion" : "criteria"} · ${Array.isArray(goal.evidence_log) ? goal.evidence_log.length : 0} evidence · ${Array.isArray(goal.validation_log) ? goal.validation_log.length : 0} validations</div>
      <div>${workItems.length} work ${workItems.length === 1 ? "item" : "items"} · ${openWorkItems.length} open · ${assumptions.length} active ${assumptions.length === 1 ? "assumption" : "assumptions"}</div>
      ${workPreview ? `<div>${escapeHtml(workPreview)}</div>` : ""}
      ${workerCopy ? `<div><strong>Held worker:</strong> ${escapeHtml(workerCopy)}</div>` : ""}
      ${targetCopy ? `<div><strong>Target:</strong> ${escapeHtml(targetCopy)}</div>` : `<div><strong>Target:</strong> not recorded; Revit identity will be verified before dispatch.</div>`}
      ${truthFlags.length ? `<div><strong>Truth:</strong> ${escapeHtml(truthFlags.join(" · "))}</div>` : ""}
      ${effects ? `<div><strong>Planned/observed effects:</strong> ${escapeHtml(effectCounts)}${effects.summary ? ` · ${escapeHtml(effects.summary)}` : ""}</div>` : ""}
      ${affectedCategories.length ? `<div><strong>Affected categories:</strong> ${escapeHtml(affectedCategories.join(", "))}</div>` : ""}
      ${approvalCopy.length ? `<div><strong>Approval:</strong><br>${approvalCopy.map((item) => `<code class="assignmentIdentity">${escapeHtml(item)}</code>`).join("<br>")}</div>` : ""}
      ${executionCopy ? `<div><strong>Execution:</strong> ${escapeHtml(executionCopy)}</div>` : ""}
      ${artifactCopy.length ? `<div><strong>Artifacts:</strong><ul class="assignmentArtifactList">${artifactCopy.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${goal.completion_audit ? `<div>Audit: ${goal.completion_audit.complete ? "complete" : "incomplete"} · ${escapeHtml(goal.completion_audit.recommendation || "")}</div>` : ""}
    `;
    if (elements.assignmentContext) {
      elements.assignmentContext.textContent = contextPresentation.reasons.length
        ? `${contextPresentation.label}: ${contextPresentation.reasons.join(" ")}`
        : `${contextPresentation.label}${target.document_title ? ` · ${target.document_title}` : ""}`;
      elements.assignmentContext.className = `assignmentContext ${contextPresentation.resumeBlocked ? "assignmentContextDanger" : ""}`;
    }

    elements.assignmentProgressText.textContent = progress.text;
    elements.assignmentProgressFill.style.width = `${progress.percent ?? 0}%`;
    elements.assignmentProgressBar.setAttribute("aria-valuetext", progress.text);
    if (progress.percent === null) elements.assignmentProgressBar.removeAttribute("aria-valuenow");
    else elements.assignmentProgressBar.setAttribute("aria-valuenow", `${progress.percent}`);

    elements.assignmentPlan.hidden = workItems.length === 0;
    elements.assignmentPlanList.innerHTML = "";
    for (const item of workItems) {
      const row = document.createElement("li");
      const itemStatus = `${item?.status || "pending"}`;
      row.className = `assignmentPlanItem status-${itemStatus}`;
      const status = document.createElement("span");
      status.className = "assignmentPlanItemStatus";
      status.textContent = itemStatus.replace(/_/g, " ");
      const copy = document.createElement("span");
      copy.className = "assignmentPlanItemCopy";
      const title = document.createElement("strong");
      title.textContent = item?.title || "Untitled step";
      copy.appendChild(title);
      const detailText = item?.blocker || item?.result_summary || "";
      if (detailText) {
        const detail = document.createElement("span");
        detail.textContent = detailText;
        copy.appendChild(detail);
      }
      row.appendChild(status);
      row.appendChild(copy);
      elements.assignmentPlanList.appendChild(row);
    }

    const blocker = [`${goal.blocker || goal.error || ""}`.trim(), ...contextPresentation.reasons].filter(Boolean).join(" ");
    elements.assignmentBlocker.hidden = !blocker;
    elements.assignmentBlocker.textContent = blocker ? `Blocked: ${blocker}` : "";

    elements.assignmentAssumptions.hidden = assumptions.length === 0;
    elements.assignmentAssumptionList.innerHTML = "";
    for (const assumption of assumptions) {
      const item = document.createElement("li");
      item.textContent = `${assumption.statement || "Unspecified assumption"}${assumption.basis ? ` — ${assumption.basis}` : ""}`;
      elements.assignmentAssumptionList.appendChild(item);
    }
    renderVerifiedWorkPacketPanel(goal);
  }

  const status = `${goal?.status || ""}`;
  const goalBacked = !goal?._sourceKind || goal._sourceKind === "goal";
  const contextPresentation = assignmentContextPresentation(goal, state.assignmentRevitContext);
  const historyPinned = state.goalSelectionPinned === true;
  const canonical = goal?._sourceKind === "assignment_kernel_v2";
  if (elements.goalPauseButton) elements.goalPauseButton.disabled = historyPinned || (canonical ? !goal._canPause : !goalBacked || status !== "active");
  if (elements.goalResumeButton) elements.goalResumeButton.disabled = state.assignmentResumePending || historyPinned || contextPresentation.resumeBlocked || (canonical ? !goal._canResume || state.streaming : !goalBacked || (status !== "paused" && status !== "blocked"));
  if (elements.goalRecoverButton) {
    elements.goalRecoverButton.hidden = !canonical || !goal._canRecover;
    elements.goalRecoverButton.disabled = historyPinned || state.streaming;
  }
  if (elements.goalAuditButton) elements.goalAuditButton.disabled = historyPinned || !goalBacked || status !== "active";
  if (elements.goalCancelButton) elements.goalCancelButton.disabled = historyPinned || !goalBacked || !goal || status === "complete" || status === "canceled" || status === "failed";
  if (elements.goalReturnCurrentButton) elements.goalReturnCurrentButton.hidden = !historyPinned;
  if (elements.goalOpenSavedTaskButton) {
    elements.goalOpenSavedTaskButton.hidden = !historyPinned || !savedAssignmentNavigationTargetV2(goal, state.sessionId);
    elements.goalOpenSavedTaskButton.disabled = state.streaming || state.resetting || Boolean(state.assignmentResumePending);
  }
  renderAssignmentInputsV2(goal);

  if (elements.goalList) {
    elements.goalList.innerHTML = "";
    for (const item of state.goals.slice(0, 8)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `goalListItem ${item.id === goal?.id ? "active" : ""}`;
      const itemContext = assignmentContextPresentation(item, state.assignmentRevitContext);
      row.innerHTML = `<strong>${escapeHtml(item.title || "Untitled goal")}</strong><br><span>${escapeHtml(goalStatusLabel(item))}${itemContext.wrongTarget ? " · stale target" : ""} · ${escapeHtml(item.updated_at || "")}</span>`;
      row.setAttribute("aria-pressed", item.id === goal?.id ? "true" : "false");
      row.addEventListener("click", () => {
        state.activeGoalId = item.id || "";
        state.goalSelectionPinned = true;
        renderGoalPanel();
        void syncVerifiedWorkPacket(item);
      });
      elements.goalList.appendChild(row);
    }
  }

  if (elements.goalLog) {
    const canonicalHistory = Array.isArray(goal?._projection?.history)
      ? goal._projection.history.map((entry) => ({ ts: entry?.ts, summary: entry?.text, label: `${entry?.kind || "History"}`.replace(/_/g, " ") }))
      : [];
    const entries = [
      ...canonicalHistory,
      ...(Array.isArray(goal?.action_log) ? goal.action_log.map((entry) => ({ ...entry, label: "Action" })) : []),
      ...(Array.isArray(goal?.evidence_log) ? goal.evidence_log.map((entry) => ({ ...entry, label: "Evidence" })) : []),
      ...(Array.isArray(goal?.validation_log) ? goal.validation_log.map((entry) => ({ ...entry, label: "Validation" })) : []),
      ...(goal?.completion_audit ? [{ ts: goal.completion_audit.requested_at, summary: goal.completion_audit.recommendation, label: "Audit" }] : [])
    ].sort((a, b) => `${b.ts || ""}`.localeCompare(`${a.ts || ""}`)).slice(0, 12);
    elements.goalLog.innerHTML = entries.length
      ? entries.map((entry) => {
          const artifactPaths = Array.isArray(entry.artifact_paths) ? entry.artifact_paths.filter(Boolean) : [];
          return `<div class="goalLogEntry"><strong>${escapeHtml(entry.label)}</strong> ${escapeHtml(entry.ts || "")}<br>${escapeHtml(entry.summary || "")}${artifactPaths.length ? `<br><code>${escapeHtml(artifactPaths.join(" · "))}</code>` : ""}</div>`;
        }).join("")
      : "<div>No action, evidence, or validation entries yet.</div>";
  }
  renderRunSummary();
}

function assignmentRevitContextFromHealth(health = null) {
  const context = health?.context || {};
  const document = context?.document || {};
  return health?.ok ? {
    document_title: document.title || health?.revit_bridge?.document_title || "",
    document_path: document.path || context?.readiness?.active_document_path || "",
    document_fingerprint: document?.projectIdentity?.fingerprint || "",
    executor_id: context.courier_executor_id || ""
  } : null;
}

async function refreshAssignmentRevitContext({ cachedOnly = false } = {}) {
  return await refreshAssignmentDisplayContext(state, fetchJson, assignmentRevitContextFromHealth, { cachedOnly });
}

async function syncGoals() {
  if (state.resetting) return;
  const requestId = ++state.goalsSyncRequestId;
  const sessionId = state.sessionId;
  const navigationAssignmentId = state.streaming ? "" : state.taskNavigationAssignmentId || "";
  const qs = new URLSearchParams({ limit: "30" });
  // Assignment history spans conversations. Backend ownership filtering keeps
  // this user-scoped while the UI can recover paused work after a restart or
  // a new chat session.
  // Cached display polling never occupies Revit's API lane. Keep it active
  // while the worker runs so its fresh preflight identity reaches Details.
  const contextRefresh = refreshAssignmentRevitContext({ cachedOnly: true });
  const [payload, workspace] = await Promise.all([
    navigationAssignmentId ? Promise.resolve({ assignments: [] }) : fetchJson(`/api/assignments?${qs.toString()}`),
    sessionId && navigationAssignmentId
      ? readSavedAssignmentHistoryV2(fetchJson, sessionId, navigationAssignmentId)
      : sessionId ? fetchJson(`/api/assignment-workspace/v2?session_id=${encodeURIComponent(sessionId)}&limit=30`)
      : Promise.resolve({ assignments: [] }),
    contextRefresh
  ]);
  if (state.resetting || requestId !== state.goalsSyncRequestId || sessionId !== state.sessionId) return;
  const legacy = Array.isArray(payload?.assignments)
    ? payload.assignments.map(assignmentProjectionToGoalView).filter(Boolean)
    : [];
  const canonical = retainNewerAssignmentViewsV2(Array.isArray(workspace?.assignments) ? workspace.assignments : [], state.goals);
  const canonicalIds = new Set(canonical.map(goal => goal.id));
  state.goals = [...canonical, ...legacy.filter(goal => !canonicalIds.has(goal.id))]
    .sort((a, b) => `${b.updated_at || ""}|${b.id}`.localeCompare(`${a.updated_at || ""}|${a.id}`));
  if (state.activeGoalId && !state.goals.some((goal) => goal?.id === state.activeGoalId)) {
    state.activeGoalId = "";
    state.goalSelectionPinned = false;
  }
  const explicit = state.goals.find((goal) => goal?.id === state.activeGoalId);
  const current = navigationAssignmentId
    ? canonical.find(goal => goal._bindingV2?.assignment_id === navigationAssignmentId)
    : chooseCurrentAssignment(state.goals, state.assignmentRevitContext, state.sessionId);
  // History selection is useful for inspection, but it must never hide a newer
  // assignment created by a run that just started or completed. Automatically
  // return to the live result when the backend publishes a newer record.
  if (!state.goalSelectionPinned || !explicit || assignmentIsNewer(current, explicit)) {
    state.activeGoalId = current?.id || "";
    state.goalSelectionPinned = false;
  }
  renderGoalPanel();
  await syncVerifiedWorkPacket(selectedGoal());
  renderCompactWork();
}

function scheduleGoalsPolling() {
  if (state.goalsTimer) clearInterval(state.goalsTimer);
  state.goalsTimer = setInterval(() => {
    syncGoals().catch(() => setStatus("Assignment status unavailable. Reconnecting…"));
  }, 15000);
}

async function createGoalFromForm(event) {
  event.preventDefault();
  const title = `${elements.goalTitleInput?.value || ""}`.trim();
  const objective = `${elements.goalObjectiveInput?.value || ""}`.trim();
  const acceptanceCriteria = `${elements.goalCriteriaInput?.value || ""}`.split(/\r?\n/g).map((x) => x.trim()).filter(Boolean);
  const nonGoals = `${elements.goalNonGoalsInput?.value || ""}`.split(/\r?\n/g).map((x) => x.trim()).filter(Boolean);
  if (!title || !objective || acceptanceCriteria.length === 0) {
    setStatus("Goal needs title, objective, and acceptance criteria.");
    return;
  }
  const sessionId = await ensureSession(false);
  const payload = await fetchJson("/api/goals", {
    method: "POST",
    body: JSON.stringify({
      title,
      objective,
      acceptance_criteria: acceptanceCriteria,
      non_goals: nonGoals,
      related_session_id: sessionId,
      status: "active"
    })
  });
  state.activeGoalId = payload?.goal?.id ? `goal:${payload.goal.id}` : "";
  state.goalSelectionPinned = false;
  elements.goalForm?.reset();
  await syncGoals();
  setStatus("Goal created.");
}

async function resumeCanonicalAssignment(goal, options = {}) {
  if (state.streaming) throw new Error("Wait for admitted work to settle before resuming.");
  if (state.sessionId !== goal._bindingV2.session_id) throw new Error("Return to this task's conversation before resuming.");
  const submission = createChatSubmission("Continue the existing task using its saved answers and evidence.", []);
  if (!submission) return;
  submission.assignmentBindingV2 = goal._bindingV2;
  const owner = await fetchJson("/api/assignment-workspace/v2/executor", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal._bindingV2)
  });
  if (owner?.ok !== true || !["computer", "backend"].includes(owner.executor)
      || !["assignment_id", "session_id", "run_id", "generation"].every(key => owner.binding?.[key] === goal._bindingV2[key]))
    throw new Error("The saved task executor could not be confirmed. Refresh before resuming.");
  if (state.streaming || state.sessionId !== goal._bindingV2.session_id
      || !["assignment_id", "session_id", "run_id", "generation"].every(key => selectedGoal()?._bindingV2?.[key] === goal._bindingV2[key]))
    throw new Error("The selected task changed while its executor was being checked.");
  if (owner.executor === "computer") {
    submission.assignmentResumeControl = { command_id: goal._executionControl?.command_id, assignment_version: goal._assignmentVersion };
    return sendComputerPrompt(routeSavedChatSubmission(submission, owner.executor), options);
  }
  return sendBackendPrompt(routeSavedChatSubmission(submission, owner.executor), options);
}

async function runCanonicalGoalControl(goal, action, stillCurrent = () => true, options = {}) {
  if (!["pause", "resume"].includes(action)) return;
  if (state.sessionId !== goal._bindingV2.session_id) throw new Error("This control belongs to another conversation.");
  if (action === "resume" && state.assignmentResumePending) return;
  if (action === "resume" && (!goal._canResume || state.streaming)) throw new Error("Resolve pending questions and wait for admitted work to settle before resuming.");
  const binding = { ...goal._bindingV2 };
  const command = { ...binding, command_id: crypto.randomUUID(), expected_command_id: goal._executionControl?.command_id || null,
    expected_hold_id: goal._providerUsageHold?.hold_id || null, expected_assignment_version: goal._assignmentVersion, action,
    ...(goal._projection?.target?.document_fingerprint ? { document_fingerprint: goal._projection.target.document_fingerprint } : {}) };
  if (action === "resume") state.assignmentResumePending = command.command_id;
  try {
    if (action === "resume") await assertLoadedBrowserFresh(loadedBrowserIdentity);
    if (!stillCurrent()) return;
    const result = await fetchJson("/api/assignment-workspace/v2/control", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command)
    });
    if (!stillCurrent()) return;
    // The exact control acknowledgment supersedes polls started before it.
    // Keep all Resume hold/version/document/settlement fences below intact.
    acceptAssignmentMutationViewV2(state, result, binding);
    await syncGoals();
    if (!stillCurrent()) return;
    if (action === "pause") { setStatus("Pause requested. Admitted work will finish before the task pauses."); return; }
    const acknowledged = result?.assignment_snapshot_v2;
    const current = selectedGoal();
    const same = candidate => ["assignment_id", "session_id", "run_id", "generation"].every(key => candidate?.[key] === binding[key]);
    if (result?.ok !== true || !same(acknowledged?.current_binding) || !Number.isSafeInteger(command.expected_assignment_version)
        || !Number.isSafeInteger(acknowledged?.assignment_version) || acknowledged.assignment_version <= command.expected_assignment_version
        || acknowledged.execution_control?.command_id !== command.command_id || acknowledged.execution_control?.state !== "running"
        || acknowledged.provider_usage_hold || acknowledged.terminal || acknowledged.quiescent !== true
        || acknowledged.unresolved_unknown_operation_ids?.length !== 0 || acknowledged.pending_input_variable_ids?.length !== 0 || acknowledged.pending_review_ids?.length !== 0
        || !same(current?._bindingV2) || current._assignmentVersion < acknowledged.assignment_version
        || current._executionControl?.command_id !== command.command_id || current._executionControl?.state !== "running"
        || current._providerUsageHold || !current._canResume
        || command.document_fingerprint && (acknowledged.current_binding.document_fingerprint !== command.document_fingerprint
          || current._projection?.target?.document_fingerprint !== command.document_fingerprint)) {
      throw new Error("The task or its controls changed. Refresh task details before resuming.");
    }
    setStatus("Resuming the saved task…");
    return await resumeCanonicalAssignment(current, { ...options, onAccepted: () => {
      if (state.assignmentResumePending === command.command_id) state.assignmentResumePending = false;
      if (typeof updateControls === "function") updateControls();
      options.onAccepted?.();
    } });
  } catch (error) {
    if (error?.code === "SIDECAR_BROWSER_STALE") { await showStaleComposerNotice(); return; }
    throw error;
  } finally {
    if (action === "resume" && state.assignmentResumePending === command.command_id) {
      state.assignmentResumePending = false;
      if (typeof updateControls === "function") updateControls();
    }
  }
}

async function recoverCanonicalAssignmentResults(goal) {
  if (goal?._sourceKind !== "assignment_kernel_v2" || !goal._canRecover) return;
  if (state.sessionId !== goal._bindingV2.session_id) throw new Error("This control belongs to another conversation.");
  if (state.streaming || state.goalSelectionPinned) throw new Error("Return to the current task and wait for the active request to finish.");
  const result = await fetchJson("/api/assignment-workspace/v2/recover-completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal._bindingV2)
  });
  await syncGoals();
  const recovered = result.recovered_operation_ids?.length || 0;
  const unresolved = result.unresolved_operation_ids?.length || 0;
  setStatus(unresolved > 0 || recovered === 0
    ? "Some results are still unavailable. Recovery cannot yet establish what finished."
    : "Saved results recovered. Resume to verify the result and finish remaining work.");
}

function renderAssignmentInputsV2(goal) {
  const container = elements.assignmentInputs;
  if (!container) return;
  const questions = goal?._sourceKind === "assignment_kernel_v2" ? goal._pendingInputs || [] : [];
  container.hidden = questions.length === 0;
  const signature = JSON.stringify([goal?._sourceRecordId, goal?._bindingV2, questions]);
  if (container.dataset.signature === signature) { container._questionState?.refreshDisabled(); return; }
  container.dataset.signature = signature;
  container.replaceChildren();
  const binding = { ...goal?._bindingV2 };
  const current = () => !state.goalSelectionPinned && !state.streaming && !state.resetting
    && state.sessionId === binding.session_id && selectedGoal()?._sourceRecordId === goal?._sourceRecordId
    && ["assignment_id", "session_id", "run_id", "generation"].every(key => selectedGoal()?._bindingV2?.[key] === binding[key]);
  const rendered = { busy: false, forms: [], refreshDisabled() {
    for (const { input, button } of rendered.forms) input.disabled = button.disabled = rendered.busy || !current();
  } };
  container._questionState = rendered;
  for (const question of questions) {
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.textContent = question.question;
    if (question.work_summary) {
      const details = document.createElement("details");
      const heading = document.createElement("summary");
      heading.textContent = "Review saved work";
      const content = document.createElement("div");
      renderAssistantBlocks(content, question.work_summary, renderLinkedText);
      details.append(heading, content);
      container.appendChild(details);
    }
    const control = createAssignmentInputControl(document, question);
    const input = control.input;
    label.appendChild(input);
    if (control.sourceClause) {
      const clause = document.createElement("small");
      clause.textContent = control.sourceClause;
      label.appendChild(clause);
    }
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = control.buttonText;
    rendered.forms.push({ input, button });
    form.append(label, button);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (rendered.busy || container._questionState !== rendered || !current()) return;
      rendered.busy = true;
      rendered.refreshDisabled();
      try {
        const answer = control.value();
        const acknowledged = await fetchJson("/api/assignment-workspace/v2/input", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...binding,
            clarification_id: question.clarification_id, supplied_values: { [question.variable_id]: answer } })
        });
        if (!current()) return;
        const saved = acceptAssignmentMutationViewV2(state, acknowledged, binding);
        if (!saved) { setStatus(acknowledged?.refresh_error || "Answer saved. Refresh task details before continuing."); return; }
        renderGoalPanel();
        if (saved?._canResume && !saved._providerUsageHold && saved._executionControl?.state !== "paused" && !saved._pendingInputs?.length) await runGoalControl("resume", binding);
        else setStatus(saved?._pendingInputs?.length
          ? "Answer saved. Please answer the remaining task questions."
          : saved?._providerUsageHold ? "Answer saved. The task is still waiting for usage. Use Resume when ready."
          : "Answer saved. Check task details before resuming.");
      } catch (error) {
        if (current()) setStatus(assignmentInputErrorText(error));
      } finally {
        rendered.busy = false;
        rendered.refreshDisabled();
      }
    });
    container.appendChild(form);
  }
  rendered.refreshDisabled();
}

async function runGoalControl(action, expectedBinding = null, options = {}) {
  const goal = selectedGoal();
  const stillCurrent = () => (!expectedBinding || ["assignment_id", "session_id", "run_id", "generation"]
    .every(key => selectedGoal()?._bindingV2?.[key] === expectedBinding[key]))
    && selectedGoal()?._sourceRecordId === goal?._sourceRecordId && !state.goalSelectionPinned
    && (action !== "resume" || !state.streaming && state.sessionId === goal?._bindingV2?.session_id);
  if (expectedBinding && !stillCurrent()) return;
  if (state.goalSelectionPinned) {
    setStatus("Return to the current assignment before using assignment controls.");
    return;
  }
  if (action === "resume") {
    const liveContext = await refreshAssignmentRevitContext();
    if (goal?._sourceKind === "assignment_kernel_v2" && !stillCurrent()) return;
    const contextPresentation = assignmentContextPresentation(goal, liveContext);
    if (contextPresentation.resumeBlocked) {
      renderGoalPanel();
      setStatus(`Resume blocked: ${contextPresentation.reasons.join(" ") || "the assignment target cannot be verified."}`);
      return;
    }
  }
  if (goal?._sourceKind === "assignment_kernel_v2") return runCanonicalGoalControl(goal, action, stillCurrent, options);
  const goalId = goal?._sourceKind === "goal" ? goal._sourceRecordId : goal?.id;
  if (!goalId || (goal?._sourceKind && goal._sourceKind !== "goal")) return;
  const body =
    action === "completion-audit"
      ? { criteria_results: (goal.acceptance_criteria || []).map((criterion) => ({ criterion, status: "unknown", evidence_refs: [] })) }
      : {};
  const payload = await fetchJson(`/api/goals/${encodeURIComponent(goalId)}/${action}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (action === "pause" && state.streaming && state.activeRunKind === "backend" && state.sessionId && state.backendMessageId) {
    await fetchJson("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.sessionId, message_id: state.backendMessageId })
    });
    state.backendAbortController?.abort();
  }
  if (payload?.goal?.id) state.activeGoalId = `goal:${payload.goal.id}`;
  if (payload?.goal?.id) state.goalSelectionPinned = false;
  await syncGoals();
  setStatus(action === "completion-audit" ? "Goal audit recorded." : `Goal ${action}.`);
  if (action === "resume" && !state.streaming) {
    const resumed = selectedGoal() || goal;
    if (resumed?.related_session_id) setSession(resumed.related_session_id);
    await sendPrompt(`Resume the active assignment from its durable checkpoint. Continue the existing objective: ${resumed?.objective || resumed?.title || "the requested Revit work"}`);
  }
}

function dispatchBackendSseEvent(rawEvent, assistantMessage) {
  const dataText = rawEvent.data.join("\n");
  let payload = {};

  try {
    payload = JSON.parse(dataText);
  } catch {
    payload = { raw: dataText };
  }

  renderNextCertifiedReadUi(certifiedReadSseFixture(state.certifiedReadUi, rawEvent.event, payload));

  switch (rawEvent.event) {
    case "chat.start":
      setStatus("Working…");
      break;
    case "assistant.delta":
      assistantMessage.text += payload.text || "";
      renderMessages();
      break;
    case "assistant.done":
      // Final text supersedes preambles and earlier streamed message items.
      assistantMessage.text = payload.text || "";
      renderMessages();
      break;
    case "assistant.progress":
      state.agentProgress = String(payload.text || "").replace(/\s+/g, " ").slice(0, 240);
      state.activityUpdatedAt = Date.now();
      renderCompactWork();
      break;
    case "assistant.replace":
      assistantMessage.text = payload.text || "";
      assistantMessage.directContextAnswer = payload.direct_context_answer === true;
      assistantMessage.historySaved = payload.history_saved;
      renderMessages();
      break;
    case "actions":
      // Tool/action lifecycle details belong in activity panels, not assistant chat.
      break;
    case "error":
      pushBackendMessage("error", payload.error || "Unknown backend error.");
      renderMessages();
      break;
    case "done":
      return true;
    default:
      break;
  }

  return false;
}

async function streamBackendChat(body, assistantMessage, options = {}) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Operator-Browser-Identity": loadedBrowserIdentity },
    body: JSON.stringify(body),
    signal: options.signal
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    let detail; try { detail = JSON.parse(text); } catch {}
    throw Object.assign(new Error(detail?.error || text || "Stream request failed."), detail || {});
  }

  const reader = response.body.getReader();
  let accepted = false;
  await consumeAuthoritativeBackendSse(
    reader,
    (rawEvent) => {
      if (state.sessionId !== body.session_id || state.backendMessageId !== body.message_id) return false;
      if (rawEvent.event === "error") {
        let rejection; try { rejection = JSON.parse(rawEvent.data.join("\n")); } catch {}
        if (rejection?.submission_admission) {
          throw Object.assign(new Error(rejection.error || "The task was not admitted."), {
            submission_admission: rejection.submission_admission
          });
        }
      }
      if (!accepted && rawEvent.event === "chat.start") {
        let payload; try { payload = JSON.parse(rawEvent.data.join("\n")); } catch {}
        if (payload?.session_id === body.session_id && payload?.message_id === body.message_id) {
          accepted = true;
          options.onAccepted?.();
        }
      }
      return dispatchBackendSseEvent(rawEvent, assistantMessage);
    }
  );
}

async function sendBackendPrompt(submission, { browserFreshnessChecked = false, onAccepted } = {}) {
  if (!browserFreshnessChecked) await assertLoadedBrowserFresh(loadedBrowserIdentity);
  const text = submission.text;
  const attachments = submission.attachments;
  if (!text && attachments.length === 0) return;
  if (!submission.assignmentBindingV2) {
    state.taskNavigationAssignmentId = "";
    try { localStorage.removeItem("operator-desktop.task-target"); } catch {}
  }

  if (state.streaming) {
    state.backendAbortController?.abort();
  }

  state.activeRunKind = "backend";
  clearCertifiedReadLifecycle();
  setStreaming(true);
  setStatus("Starting backend session…");
  if (!submission.optimisticMessage) beginOptimisticChatSubmission(submission);
  const assistantMessage = { id: submission.id, role: "assistant", text: "" };
  state.backendMessages.push(assistantMessage);
  const controller = new AbortController();
  state.backendAbortController = controller;
  state.backendMessageId = submission.id;
  const navigationEpoch = state.taskNavigationEpoch;

  try {
    const sessionId = await ensureSession(false);
    if (state.backendAbortController !== controller || state.taskNavigationEpoch !== navigationEpoch) return;
    controller.signal.throwIfAborted();
    const body = {
      version: CONTRACT_VERSION,
      session_id: sessionId,
      message_id: submission.id,
      user_text: text,
      ...(submission.assignmentBindingV2 ? {
        assignment_id: submission.assignmentBindingV2.assignment_id,
        assignment_run_id: submission.assignmentBindingV2.run_id,
        assignment_generation: submission.assignmentBindingV2.generation
      } : {}),
      context: {
        ui: {
          client: "operator-desktop",
          surface: "external-sidecar",
          response_style: "conversation",
          speed_settings: getSpeedSettings()
        }
      },
      speed_settings: getSpeedSettings(),
      pending_attachments: attachments
    };

    submission.sessionId = sessionId;
    submission.transportStarted = true;
    await streamBackendChat(body, assistantMessage, { signal: controller.signal, onAccepted: () => {
      submission.backendAccepted = true;
      if (state.backendAbortController === controller && state.taskNavigationEpoch === navigationEpoch && !controller.signal.aborted) onAccepted?.();
    } });
    if (state.backendAbortController !== controller || state.sessionId !== sessionId) return;
    renderMessages();
    setStatus(assistantMessage.historySaved === false ? "Answer shown; conversation could not be saved." : "Sidecar ready.");
    // The answer is complete. Optional diagnostics must not hold Send/Stop busy.
    if (!assistantMessage.directContextAnswer) {
      void syncGoals().catch(() => {});
      void refreshScreen().catch(() => {});
    }
  } catch (error) {
    if (state.backendAbortController !== controller || state.taskNavigationEpoch !== navigationEpoch) return;
    if (!submission.transportStarted || mayRestoreRejectedChatSubmission(submission, error)) restoreChatSubmissionInput(submission);
    if (error?.name === "AbortError") {
      if (!assistantMessage.text.trim()) state.backendMessages.pop();
      if (state.certifiedReadUi?.lifecycle?.busy) {
        renderCertifiedReadUi({ ...certifiedReadFixtureFromPresentation(state.certifiedReadUi), lifecycle: "interrupted" });
      }
      setStatus("Stopped.");
      return;
    }
    state.backendMessages.pop();
    if (error?.code === "SIDECAR_BROWSER_STALE") { if (submission.transportStarted) restoreChatSubmissionInput(submission); renderMessages(); await showStaleComposerNotice(); return; }
    renderNextCertifiedReadUi(certifiedReadConnectionLossFixture(state.certifiedReadUi));
    pushBackendMessage("error", error.message || String(error));
    renderMessages();
    setStatus("Failed.");
  } finally {
    if (state.backendAbortController === controller) {
      state.backendAbortController = null;
      state.backendMessageId = "";
      if (state.activeRunKind === "backend") state.activeRunKind = "";
      if (state.activeRunKind !== "computer") setStreaming(false);
    }
  }
}

async function syncComputerState() {
  if (state.resetting || state.activeRunKind === "backend") return;
  if (state.taskNavigationMode && state.activeRunKind !== "computer"
      && (!state.sessionId || !state.taskNavigationAssignmentId)) return;
  // Timer ticks must not invalidate every response when the relay takes longer
  // than the polling interval. Navigation still invalidates the request below.
  if (state.computerPollPending) return;
  state.computerPollPending = true;
  try {
  const sessionId = state.sessionId, epoch = state.taskNavigationEpoch;
  const savedBinding = state.taskNavigationMode && state.taskNavigationAssignmentId
    ? { ...selectedGoal()?._bindingV2 } : null;
  const selectedAssignmentId = state.taskNavigationAssignmentId;
  const requestId = ++state.computerSyncRequestId;
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  const payload = await fetchJsonWithTimeout(`/api/computer/state${query}`, {}, 10_000);
  if (requestId !== state.computerSyncRequestId) return;
  if (state.resetting) return;
  // A fallback backend stream owns its busy state and transcript. An idle
  // computer relay must not enable Send/disable Stop during that run.
  if (state.activeRunKind === "backend") return;
  if (sessionId !== state.sessionId || epoch !== state.taskNavigationEpoch) return;
  const submittedTurn = !!state.computerSubmissionMessageId
    && computerStateIncludesSubmittedMessage(payload, state.computerSubmissionMessageId);
  if (state.computerSubmissionMessageId && !submittedTurn) return;
  if (selectedAssignmentId !== state.taskNavigationAssignmentId
      || savedBinding && savedBinding.assignment_id !== selectedAssignmentId) return;
  if (savedBinding && (!computerStateMatchesTask(payload, savedBinding, sessionId)
      || !computerStateMatchesTask(payload, selectedGoal()?._bindingV2, sessionId))) return;
  if (!savedBinding && sessionId && payload.backendSessionId !== sessionId && !submittedTurn) return;
  // Native context/authorization refresh can replace a provisional backend
  // session before Assignment admission. Keep the submitted-message correlation
  // until the canonical binding exists (or startup stops); otherwise subsequent
  // polls reject the real task as foreign and the UI stays busy forever.
  // Opened saved tasks still require their exact binding above. This observer
  // transition neither dispatches work nor grants completion/control authority.
  const awaitingAdmission = submittedTurn && payload.running && !payload.assignmentBindingV2;
  if (!awaitingAdmission) state.computerSubmissionMessageId = "";
  const copy = payload.checkedProjectCopy;
  const checkedProjectCopy = payload.running && computerStateMatchesTask(payload, copy?.binding, sessionId)
    ? copy.message : null;
  state.checkedProjectCopy = checkedProjectCopy ? { message:checkedProjectCopy, sessionId, epoch } : null;
  state.activityLastSeenAt = Date.now();
  state.activityConnectionLost = false;
  const wasDesktopPreviewCaptureBlocked = desktopPreviewCaptureBlocked(state.computerRunSubmissionPending, state.desktopCaptureSuppressed);
  applyDesktopPreviewCaptureState("state", !!payload.desktopCaptureSuppressed);
  const certifiedReadFixture = certifiedReadComputerStateFixture(state.certifiedReadUi, payload);
  const signature = JSON.stringify({
    backendSessionId: payload.backendSessionId,
    assignmentBindingV2: payload.assignmentBindingV2,
    running: payload.running,
    error: payload.error,
    messages: payload.messages,
    checkedProjectCopy,
    events: payload.events,
    progress: payload.progress,
    certifiedReadUi: certifiedReadFixture,
    screenshotVersion: payload.screenshotVersion,
    screen: payload.screen,
    workReturn: payload.workReturn,
    pendingClarification: payload.pendingClarification
  });

  renderNextCertifiedReadUi(certifiedReadFixture);

  state.computerProgress = payload.progress || null;
  state.computerScreen = payload.screen || null;
  state.computerError = `${payload.error || ""}`.trim();
  state.workReturn = payload.workReturn || null;
  state.pendingClarification = payload.pendingClarification || null;
  renderWorkReturnPanel();
  const nextScreenshotVersion = Number(payload.screenshotVersion) || 0;
  if (nextScreenshotVersion !== state.lastScreenshotVersion) {
    state.lastScreenshotVersion = nextScreenshotVersion;
    void refreshScreen();
  }
  if (wasDesktopPreviewCaptureBlocked && !desktopPreviewCaptureBlocked(state.computerRunSubmissionPending, state.desktopCaptureSuppressed)) {
    void refreshScreen();
  }

  if (signature !== state.lastComputerSignature) {
    state.lastComputerSignature = signature;
    const reconciled = reconcileComputerMessages(payload.messages, state.pendingComputerUserMessages);
    state.computerMessages = reconciled.messages;
    state.pendingComputerUserMessages = reconciled.pendingUserMessages;
    state.computerEvents = mergeActivityEvents(state.computerEvents, payload.events);
    // A freshly restarted Sidecar has no computer-run session yet. Preserve
    // the durable conversation/assignment binding restored from local storage.
    if (!awaitingAdmission && `${payload.backendSessionId || ""}`.trim() && (payload.running || state.activeRunKind === "computer")) {
      setSession(payload.backendSessionId);
    }
    renderMessages();
    renderEvents();
  }

  renderRunSummary();
  renderScreenMeta();

  if (payload.running) {
    state.activeRunKind = "computer";
    const step = Number(state.computerProgress?.currentStep) || 0;
    const maxSteps = Number(state.computerProgress?.maxSteps) || 0;
    const stepLabel = step > 0 && maxSteps > 0 ? ` Step ${step}/${maxSteps}.` : "";
    setStatus("Working…");
    setStreaming(true);
  } else if (state.computerRunSubmissionPending || state.pendingComputerUserMessages.length > 0) {
    state.activeRunKind = "computer";
    setStatus("Starting task…");
    setStreaming(true);
  } else if (payload.error) {
    if (state.activeRunKind === "computer") state.activeRunKind = "";
    setStatus(payload.error);
    setStreaming(false);
  } else {
    if (state.activeRunKind === "computer") state.activeRunKind = "";
    setStatus("Sidecar ready.");
    setStreaming(false);
  }
  } finally {
    state.computerPollPending = false;
  }
}

async function syncNotifications() {
  if (!state.sessionId) return;
  const sessionId = state.sessionId, epoch = state.taskNavigationEpoch;
  const payload = await fetchJson(`/api/notifications?after_id=${state.notificationsAfterId}&limit=50`);
  if (state.resetting || sessionId !== state.sessionId || epoch !== state.taskNavigationEpoch) return;
  const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
  const nextAfterId = Number.parseInt(`${payload.next_after_id ?? state.notificationsAfterId}`, 10);
  if (Number.isFinite(nextAfterId) && nextAfterId >= state.notificationsAfterId) {
    state.notificationsAfterId = nextAfterId;
  }

  if (notifications.length === 0) return;

  for (const notification of notifications) {
    const id = `notify-${notification?.id ?? Math.random().toString(16).slice(2)}`;
    const type = `${notification?.type || ""}`.trim();
    const text = `${notification?.text || type || "Notification"}`.trim();
    const details = notification?.payload && typeof notification.payload === "object" ? notification.payload : {};
    const timestamp = notification?.created_at || notification?.ts;
    if (!text) continue;
    if (type === "feedback.github_issue.created") {
      const issueNumber = Number(details.issue_number);
      appendActivityEvent(text, id, {
        time: timestamp,
        tone: "tone-positive",
        url: details.issue_url,
        urlLabel: Number.isFinite(issueNumber) ? `Open issue #${issueNumber}` : "Open GitHub issue"
      });
      setStatus(text);
      continue;
    }

    if (type === "feedback.github_issue.failed") {
      appendActivityEvent(text, id, {
        time: timestamp,
        tone: "tone-danger"
      });
      setStatus(text);
      continue;
    }

    if (type === "feedback.github_issue.started") {
      appendActivityEvent(text, id, {
        time: timestamp,
        tone: "tone-info"
      });
      continue;
    }

    if (type === "feedback.github_issue.duplicate") {
      const issueNumber = Number(details.issue_number);
      appendActivityEvent(text, id, {
        time: timestamp,
        tone: "tone-warning",
        url: details.issue_url,
        urlLabel: Number.isFinite(issueNumber) ? `Open issue #${issueNumber}` : "Open linked issue"
      });
      setStatus(text);
      continue;
    }

    appendActivityEvent(text, id, {
      time: timestamp
    });
  }

  renderEvents();
}

async function syncCaptureArtifacts() {
  if (!elements.artifacts) return;
  const payload = await fetchJson("/api/capture/artifacts?limit=12");
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  const nextSignature = JSON.stringify(artifacts.map((item) => [item.id, item.capturedAt, item.markdownPath]));
  const currentSignature = JSON.stringify((state.captureArtifacts || []).map((item) => [item.id, item.capturedAt, item.markdownPath]));
  if (nextSignature !== currentSignature) {
    state.captureArtifacts = artifacts;
    renderArtifacts();
    if (state.artifactPreviewPath) {
      const stillExists = artifacts.some((item) => item.markdownPath === state.artifactPreviewPath);
      if (!stillExists) {
        state.artifactPreviewPath = "";
        if (elements.artifactPreview) {
          elements.artifactPreview.textContent = "Select an artifact to preview it here.";
        }
      }
    }
  }
}

function scheduleComputerPolling() {
  if (state.computerStateTimer) clearInterval(state.computerStateTimer);
  state.computerStateTimer = setInterval(async () => {
    try {
      await syncComputerState();
    } catch {
      renderNextCertifiedReadUi(certifiedReadConnectionLossFixture(state.certifiedReadUi));
      if (state.streaming && state.activeRunKind === "computer") {
        state.activityConnectionLost = true;
        renderLiveActivity();
        setStatus("Connection interrupted. Checking task status…");
      }
    }
  }, 1500);
}

function scheduleNotificationsPolling() {
  if (state.notificationsTimer) clearInterval(state.notificationsTimer);
  state.notificationsTimer = setInterval(async () => {
    try {
      await syncNotifications();
    } catch {
      // ignore polling failures
    }
  }, 1500);
}

function scheduleBatchJobsPolling() {
  if (state.batchJobsTimer) clearInterval(state.batchJobsTimer);
  state.batchJobsTimer = setInterval(async () => {
    // Batch inventory needs a live Revit binding. During an active foreground
    // turn, keep the last rendered inventory instead of competing for Revit's
    // serialized ExternalEvent lane.
    if (state.streaming) return;
    try {
      await syncBatchJobs();
    } catch {
      // ignore polling failures
    }
  }, 15000);
}

async function sendComputerPrompt(submission, { browserFreshnessChecked = false, onAccepted } = {}) {
  if (!browserFreshnessChecked) await assertLoadedBrowserFresh(loadedBrowserIdentity);
  if (submission.assignmentBindingV2 && (state.streaming || state.sessionId !== submission.assignmentBindingV2.session_id
      || !["assignment_id", "session_id", "run_id", "generation"].every(key => selectedGoal()?._bindingV2?.[key] === submission.assignmentBindingV2[key])))
    throw new Error("The saved task changed before desktop continuation.");
  const text = submission.text;
  const attachments = submission.attachments;
  if (!text && attachments.length === 0) return;

  if (!state.computerUseAvailable) {
    throw new Error("Computer relay is unavailable. Check backend reachability and NODE_EXTRA_CA_CERTS in operator-desktop/.env.");
  }

  if (submission.mode === "computer-interject") {
    submission.transportStarted = true;
    await fetchJson("/api/computer/interject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        message_id: submission.id,
        pending_attachments: attachments,
        speed_settings: getSpeedSettings()
      })
    });
    setStatus("Steering sent…");
    await syncComputerState();
    return;
  }

  state.activeRunKind = "computer";
  clearCertifiedReadLifecycle();
  setStreaming(true);
  setStatus("Starting task…");
  if (!submission.optimisticMessage) beginOptimisticChatSubmission(submission);
  applyDesktopPreviewCaptureState("submission_started");
  try {
    submission.transportStarted = true;
    const runPayload = await fetchJson("/api/computer/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        new_conversation: submission.newComputerConversation === true,
        ...(submission.assignmentBindingV2 ? { assignment_binding_v2: submission.assignmentBindingV2,
          resume_control: submission.assignmentResumeControl } : {}),
        message_id: submission.id,
        pending_attachments: attachments,
        speed_settings: getSpeedSettings()
      })
    });
    applyDesktopPreviewCaptureState("submission_resolved", !!runPayload.desktopCaptureSuppressed);
    onAccepted?.();
    await syncComputerState();
  } catch (error) {
    applyDesktopPreviewCaptureState("cleared");
    if(mayRestoreRejectedChatSubmission(submission,error)&&state.activeRunKind==='computer'
      &&state.sessionId===submission.sessionId&&state.computerSubmissionMessageId===submission.id){
      state.computerSubmissionMessageId='';state.activeRunKind='';setStreaming(false);
    }
    state.pendingComputerUserMessages = state.pendingComputerUserMessages.filter((message) => message?.id !== submission.id);
    renderMessages();
    throw error;
  }
}

async function stopComputerRun() {
  if (!state.streaming) return;
  if (state.activeRunKind === "computer") {
    const sessionId = state.sessionId, epoch = state.taskNavigationEpoch;
    const stillCurrent = () => state.sessionId === sessionId && state.taskNavigationEpoch === epoch
      && state.activeRunKind === "computer" && state.streaming;
    await syncGoals();
    if (!stillCurrent()) return;
    const goal = selectedGoal();
    if (goal?._bindingV2?.session_id !== sessionId || !goal._canPause)
      throw new Error("The current task cannot acknowledge Pause yet. Refresh its status; it has not been canceled.");
    await runCanonicalGoalControl(goal, "pause", stillCurrent);
    return;
  }
  if (state.activeRunKind === "backend") {
    const sessionId = state.sessionId, messageId = state.backendMessageId;
    const stillCurrent = () => state.sessionId === sessionId && state.backendMessageId === messageId && state.streaming;
    await syncGoals();
    if (!stillCurrent()) return;
    const goal = selectedGoal();
    if (goal?._bindingV2?.session_id === sessionId && goal._canPause) {
      await runCanonicalGoalControl(goal, "pause", stillCurrent);
    } else {
      await fetchJson("/api/chat/stop", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message_id: messageId }) });
    }
    if (!stillCurrent()) return;
    if (state.certifiedReadUi?.lifecycle?.busy) {
      renderCertifiedReadUi({ ...certifiedReadFixtureFromPresentation(state.certifiedReadUi), lifecycle: "stopping" });
    }
    setStatus("Stopping…");
    return;
  }
  await fetchJson("/api/computer/stop", { method: "POST" });
  if (state.certifiedReadUi?.lifecycle?.busy) {
    renderCertifiedReadUi({ ...certifiedReadFixtureFromPresentation(state.certifiedReadUi), lifecycle: "stopping" });
  }
  setStatus("Stopping…");
}

async function resetCurrentMode() {
  return openTaskConversation(null);
}

function initializeFreshConversation() {
  // Saved selection is navigation history, never authority to resume on load.
  setSession("");
  state.taskNavigationAssignmentId = "";
  renderSessionStartScreen();
}

function renderSessionStartScreen() {
  const container = document.querySelector("#sessionStart");
  if (!container) return;
  container.hidden = Boolean(state.sessionId || activeMessages().length || state.streaming);
  if (container.hidden) return;
  renderSessionStart(container, state.taskNavigation, {
    loading: state.taskCatalogueLoading,
    unavailable: state.taskCatalogueUnavailable,
    showSavedWork: false
  }, task => void openTaskConversation(task), () => {
    setTaskSidebarOpen(true);
    void syncTaskNavigation({ refreshCatalogue: true });
  }, prompt => {
    if (!elements.promptInput.value.trim()) {
      elements.promptInput.value = prompt;
      scheduleComposerDraftSave();
    }
    elements.promptInput.focus();
  });
}

function renderTaskHistory() {
  renderTaskList(document.querySelector("#taskList"), state.taskNavigation, state.sessionId,
    task => void openTaskConversation(task), { query: document.querySelector("#taskSearch")?.value,
      loading: state.taskCatalogueLoading, unavailable: state.taskCatalogueUnavailable,
      onArchive: task => void archiveTaskHistory(task) });
}

async function archiveTaskHistory(task) {
  try {
    await fetchJson('/api/task-navigation/archive',{method:'POST',body:JSON.stringify(task
      ? {session_id:task.session_id,archived:!task.archived} : {all:true,archived:true})});
    setStatus(task?.archived ? 'Chat restored.' : 'History archived. You can restore it from Archived.');
    await syncTaskNavigation({refreshCatalogue:true});
  } catch(error) { setStatus(error.message || 'Could not archive history.'); }
}

function setTaskSidebarOpen(open, remember = true) {
  const drawer = document.querySelector("#taskDrawer");
  if (open && !drawer.open) {
    if (window.matchMedia("(min-width: 1000px)").matches) drawer.show();
    else drawer.showModal();
  } else if (!open && drawer.open) drawer.close();
  document.querySelector("#tasksButton").setAttribute("aria-expanded", String(drawer.open));
  if (remember) try { localStorage.setItem("operator-desktop.task-sidebar", String(open)); } catch {}
  if (open) renderTaskHistory();
}

function initializeTaskSidebar() {
  const wide = window.matchMedia("(min-width: 1000px)");
  let preferred; try { preferred = localStorage.getItem("operator-desktop.task-sidebar"); } catch {}
  setTaskSidebarOpen(preferred === 'true' || preferred !== 'false' && wide.matches, false);
  wide.addEventListener('change', () => {
    const drawer=document.querySelector('#taskDrawer');
    if (!drawer.open) return;
    drawer.close(); setTaskSidebarOpen(true, false);
  });
}

async function openSelectedSavedAssignmentV2() {
  if (!state.goalSelectionPinned || state.streaming || state.resetting || state.assignmentResumePending) return;
  const target = savedAssignmentNavigationTargetV2(selectedGoal(), state.sessionId);
  if (!target) { setStatus("This saved task cannot be opened from the current conversation. Refresh task history."); return; }
  return openTaskConversation(target);
}

async function openTaskConversation(task) {
  if (state.resetting || state.composerSubmissionPending || state.captureState.mode || state.captureState.busy) return;
  if (!state.goalSelectionPinned && task?.session_id === state.sessionId && (!task.assignment_id || task.assignment_id === selectedGoal()?._bindingV2?.assignment_id)) {
    if (document.querySelector("#taskDrawer")?.matches?.(":modal")) document.querySelector("#taskDrawer").close(); return;
  }
  state.resetting = true;
  updateControls();
  try {
    if (!await persistComposerDraft()) throw new Error("Your draft could not be saved. Keep this conversation open and try again.");
    state.taskNavigationEpoch = (state.taskNavigationEpoch || 0) + 1;
    state.computerSubmissionMessageId = "";
    const observer = state.backendAbortController;
    state.backendAbortController = null; state.backendMessageId = "";
    observer?.abort();
    state.computerSyncRequestId++; state.goalsSyncRequestId++; state.verifiedWorkPacketRequestId++;
    state.taskNavigationMode = true;
    state.activeRunKind = "";
    state.focusedBatchJobId = "";
    state.backendMessages = []; state.computerMessages = []; state.computerEvents = [];
    state.pendingComputerUserMessages = []; state.computerProgress = null; state.agentProgress = "";
    state.workReturn = null; state.pendingClarification = null; state.verifiedWorkPacket = null;
    state.verifiedWorkPacketAssignmentId = ""; state.activeGoalId = task?.assignment_id ? `goal:${task.assignment_id}` : "";
    state.goalSelectionPinned = false; state.goals = [];
    setSession(task?.session_id || "");
    state.taskNavigationAssignmentId = task?.assignment_id || "";
    try { localStorage.setItem("operator-desktop.task-target", JSON.stringify([state.sessionId, state.taskNavigationAssignmentId])); } catch {}
    elements.promptInput.value = ""; state.pendingAttachments = []; composerDraftRevision++;
    setStreaming(false); showComposerNotice("");
    if (document.querySelector("#taskDrawer")?.matches?.(":modal")) document.querySelector("#taskDrawer").close();
    renderAttachStrip(); renderMessages(); renderEvents(); renderGoalPanel(); renderWorkReturnPanel();
    await restoreComposerDraft();
    await restoreConversationHistory();
    setStatus(task ? "Saved conversation opened. Review its status before continuing." : "Ready");
  } catch (error) { setStatus(error.message || "Could not open the conversation."); }
  finally { state.resetting = false; updateControls(); }
  renderTaskHistory();
  const recovered = await Promise.allSettled([syncGoals(), syncTaskNavigation()]);
  if (task?.assignment_id && recovered[0].status === "rejected") setStatus("The conversation is open, but its saved task could not be loaded. Try opening it again.");
  elements.promptInput.focus();
}

function showTaskCatalogue(payload) {
  state.taskNavigation = parseTaskNavigation(payload);
  state.taskCatalogueLoading = payload.loading !== false;
  state.taskCatalogueUnavailable = false;
  renderSessionStartScreen();
  renderTaskHistory();
  const working = state.taskNavigation.filter(task => ["working", "pausing", "stopping_after_usage_limit"].includes(task.state)).length;
  document.querySelector("#tasksButton").textContent = working ? "Tasks · " + working : "Tasks";
  renderCompactWork();
}

async function loadTaskCatalogue() {
  if (state.taskCatalogueBusy) return;
  state.taskCatalogueBusy = true;
  let reader;
  try {
    const response = await fetch("/api/task-navigation?stream=1&archived=" + (state.taskShowArchived ? '1' : '0'), { headers: { "X-Operator-Browser-Identity": loadedBrowserIdentity } });
    if (!response.ok || !response.body) throw new Error("Task history is unavailable.");
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = "", complete = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error("Task history response is too large.");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload.error) throw new Error(payload.error);
        showTaskCatalogue(payload);
        complete = payload.loading === false;
      }
    }
    if (!complete || buffer.trim()) throw new Error("Task history loading was interrupted.");
    state.taskNavigationUpdatedAt = Date.now();
  } catch {
    state.taskCatalogueUnavailable = true;
    state.taskCatalogueLoading = false;
    renderSessionStartScreen();
    if (document.querySelector("#taskDrawer")?.open) renderTaskHistory();
  } finally { await reader?.cancel().catch(() => {}); state.taskCatalogueBusy = false; }
}

async function syncTaskNavigation({ refreshCatalogue = false } = {}) {
  if (state.resetting) return;
  const drawerOpen = document.querySelector("#taskDrawer")?.open;
  if (refreshCatalogue || !state.taskNavigationUpdatedAt || (drawerOpen || !state.sessionId) && Date.now() - state.taskNavigationUpdatedAt > 15000) void loadTaskCatalogue();
  if (state.taskNavigationBusy) return;
  state.taskNavigationBusy = true;
  const sessionId = state.sessionId;
  try {
    const runPayload = sessionId ? await fetchJson("/api/task-run?session_id=" + encodeURIComponent(sessionId)) : null;
    if (sessionId !== state.sessionId || state.resetting) return;
    if (!state.backendAbortController && state.activeRunKind !== "computer") {
      const wasRunning = state.streaming;
      const run = runPayload?.active_run;
      state.backendMessageId = run?.message_id || "";
      state.activeRunKind = run ? "backend" : "";
      setStreaming(Boolean(run));
      if (run || wasRunning) await restoreConversationHistory();
      if (wasRunning && !run) { await syncGoals(); state.taskNavigationUpdatedAt = 0; setStatus("Task updated."); }
    }
    renderCompactWork();
  } catch { /* A task list failure must not erase the current conversation. */ }
  finally { state.taskNavigationBusy = false; }
}

async function sendPrompt(input, attachments = [], { browserFreshnessChecked = false } = {}) {
  if (state.resetting) return;
  if (!browserFreshnessChecked) await assertLoadedBrowserFresh(loadedBrowserIdentity);
  if (state.resetting) return;
  const submission = input?.id && input?.mode
    ? input
    : createChatSubmission(input, attachments);
  if (!submission) return;
  if (!submission.optimisticMessage) beginOptimisticChatSubmission(submission);
  if (submission.mode === "computer-run" || submission.mode === "computer-interject") {
    return sendComputerPrompt(submission, { browserFreshnessChecked: true });
  }
  return sendBackendPrompt(submission, { browserFreshnessChecked: true });
}

function applyRuntimeSpeedDefaults(config) {
  if (config?.backendConfigStatus !== 'ready') return;
  const defaults = config.speedDefaults;
  // A fresh browser has no user preference. Do not let its static HTML
  // fallback silently override the configured workstation model on Resume.
  if (elements.agentModel && !normalizeSpeedModel(readStringSetting('operator.agentModel', ''), '')) {
    const model = normalizeSpeedModel(defaults?.agent_model, '');
    if (model && (!isOptionalProviderModel(model) || config.optionalAgentModels?.includes(model))) elements.agentModel.value = model;
  }
  if (elements.agentReasoning && !readStringSetting('operator.agentReasoning', ''))
    elements.agentReasoning.value = normalizeReasoningEffort(defaults?.agent_reasoning_effort, elements.agentReasoning.value);
}

function applySidecarConfig(config = {}) {
  applyRuntimeSpeedDefaults(config);
  if (elements.agentModel && config.backendConfigStatus === "ready") {
    const available = new Set(Array.isArray(config.optionalAgentModels) ? config.optionalAgentModels : []);
    for (const option of elements.agentModel.options || []) {
      if (!isOptionalProviderModel(option.value)) continue;
      option.hidden = !available.has(option.value);
      option.disabled = option.hidden;
    }
    synchronizeModelReasoning();
  }
  state.attachmentLimits = config.attachmentLimits || null;
  state.backendUrl = config.backendUrl || "";
  state.backendLocal = !!config.backendLocal;
  state.backendAuthMode = config.backendAuthMode || "unknown";
  state.runtimeProfile = config.runtimeProfile || null;
  state.computerUseAvailable = !!config.computerUseAvailable;
  state.localExecutor = config.localExecutor || null;
  state.backendAvailable = config.backendAvailable === true;
  state.backendConfigStatus = config.backendConfigStatus || "unknown";
  state.shellEnabled = !!config.shellEnabled;
  state.environmentStatus = config.environmentStatus || null;
  state.environmentProfileStatus = config.backendConfigStatus === "ready" ? "ready" : config.backendConfigStatus || "unknown";
  renderRuntimeProfile(state.runtimeProfile, config.backendAvailable !== false && config.backendConfigStatus === "ready");
  renderNextCertifiedReadUi(nextCertifiedReadUiFixture(state.certifiedReadUi, config?.certifiedReadUi, "reset"));
  elements.inputBadge.textContent = config.inputEnabled ? "Input on" : "Input off";
  elements.computerBadge.textContent = state.computerUseAvailable ? "Screen control available" : "Screen control unavailable";
  elements.shellBadge.textContent = state.shellEnabled ? "Shell ready" : "Shell off";
  elements.inputBadge.className = `badge ${config.inputEnabled ? "tone-positive" : "tone-warning"}`;
  elements.computerBadge.className = `badge ${state.computerUseAvailable ? "tone-positive" : "tone-warning"}`;
  elements.shellBadge.className = `badge ${state.shellEnabled ? "tone-positive" : "tone-warning"}`;
  updateAuthBadge({ authMode: state.backendAuthMode });
  renderEnvironmentProfile({
    manifest: state.environmentStatus,
    environmentProfileStatus: state.environmentProfileStatus,
    environmentProfileError: config.backendConfigError || ""
  });
}

async function loadConfig() {
  const config = await fetchJsonWithTimeout("/api/config");
  applySidecarConfig(config);
  const bootstrap = renderBackendBootstrapState(config);
  if (bootstrap.degraded) return config;

  try {
    const authStatus = await fetchJsonWithTimeout("/api/auth/status");
    state.authStatus = authStatus;
    updateAuthBadge(authStatus);
    syncAuthDialogContent(authStatus);
    if (authNeedsSidecarSignIn(authStatus)) {
      setStatus("Sign in needed.");
      openAuthDialog();
      return { ...config, frontendAuthBlocked: true };
    }
  } catch {
    updateAuthBadge({ authMode: state.backendAuthMode });
  }

  try {
    await fetchJsonWithTimeout("/api/backend/health");
    renderBackendBootstrapState({ backendConfigStatus: "ready" });
  } catch (error) {
    renderBackendBootstrapState({ backendConfigStatus: "unavailable" }, error);
    return { ...config, frontendBackendHealthy: false };
  }
  return { ...config, frontendBackendHealthy: true };
}

async function retryBackendBootstrap({ automatic = false } = {}) {
  if (state.backendBootstrapBusy) return;
  state.backendBootstrapBusy = true;
  const retryButton = ensureBackendRetryButton();
  retryButton.disabled = true;
  if (!automatic) setStatus("Retrying backend…");
  try {
    const config = await loadConfig();
    if (`${config?.backendConfigStatus || "ready"}` === "ready" && !config?.frontendAuthBlocked) {
      const environment = await refreshEnvironmentProfile();
      if (`${environment?.environmentProfileStatus || "ready"}` === "ready" && config?.frontendBackendHealthy !== false) {
        renderBackendBootstrapState({ backendConfigStatus: "ready" });
      }
    }
  } catch (error) {
    renderBackendBootstrapState({ backendConfigStatus: /timed out/i.test(`${error?.message || ""}`) ? "timeout" : "unavailable" }, error);
  } finally {
    state.backendBootstrapBusy = false;
    retryButton.disabled = false;
  }
}

async function initializeBackendBootstrap() {
  ensureBackendRetryButton();
  try {
    await loadConfig();
  } catch (error) {
    applySidecarConfig({ backendAuthMode: "unknown" });
    renderBackendBootstrapState({ backendConfigStatus: /timed out/i.test(`${error?.message || ""}`) ? "timeout" : "unavailable" }, error);
  }
}

function handleChatSubmissionFailure(error, submission) {
  if (!submission.transportStarted || error?.code === "SIDECAR_BROWSER_STALE") restoreChatSubmissionInput(submission);
  if (error?.code === "SIDECAR_BROWSER_STALE") {
    state.pendingComputerUserMessages = state.pendingComputerUserMessages.filter((message) => message?.id !== submission.id);
    if (submission.mode !== "computer-interject") setStreaming(false);
    void showStaleComposerNotice(); return;
  }
  const message = honestExecutionFailureText(error);
  const authBootstrapBlocked = authNeedsSidecarSignIn(state.authStatus) || looksLikeAuthBootstrapError(error);
  if (authBootstrapBlocked) {
    openAuthDialog();
    setStatus("Sign in needed.");
  }
  if (submission.mode === "backend") {
    pushBackendMessage("error", message);
  } else {
    state.computerMessages.push({ role: "error", text: message, attachments: [] });
  }
  renderMessages();
  if (!authBootstrapBlocked) {
    setStatus(submission.mode === "computer-interject" ? "Steering failed." : "Failed.");
  }
  if (submission.mode !== "computer-interject" || state.activeRunKind !== "computer") {
    setStreaming(false);
  }
}

function newRequestAfterReport() {
  return !state.streaming && !state.goalSelectionPinned && !state.pendingCheckpointDirection
    && selectedGoal()?._assignmentPhase === 'awaiting_user_review';
}

elements.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.attachmentReadsPending > 0) return;
  if (newRequestAfterReport()) {
    if(state.composerSubmissionPending || state.resetting || state.assignmentResumePending)return;
    const text=elements.promptInput.value, attachments=state.pendingAttachments.map(a=>({...a})), goal=selectedGoal();
    if(!text.trim() && !attachments.length)return;
    state.composerSubmissionPending=true;updateControls();
    try {
      await assertLoadedBrowserFresh(loadedBrowserIdentity);
      const current=await fetchJson('/api/assignments/v2/'+encodeURIComponent(goal._bindingV2.assignment_id));
      // A polling refresh may replace the view object without changing identity.
      // Validate the current selection's canonical binding and control version.
      assertNewTaskAfterReport(current.assignment_kernel_v2,selectedGoal());
      // The navigation helper retains the old task and its draft before switching.
      state.composerSubmissionPending=false;
      await openTaskConversation(null);
      if(state.sessionId || state.resetting)throw Error('Could not start a new conversation. Your draft is retained.');
      elements.promptInput.value=text;state.pendingAttachments=attachments;renderAttachStrip();
    } catch(error) { setStatus(error.message || 'Could not start the next task.'); return; }
    finally { state.composerSubmissionPending=false;updateControls(); }
  }
  if (state.streaming && state.activeRunKind === "backend" || pausedTaskAcceptsDirection()) { await submitTaskDirection(); return; }
  const captured = beginComposerSend(state, elements.promptInput.value);
  if (!captured) return;
  setStatus("Sending…");
  updateControls();
  let submission;
  try {
    assertAttachmentTotalSize(captured.attachments);
    await persistComposerDraft();
    await assertLoadedBrowserFresh(loadedBrowserIdentity);
    if (state.resetting) return;
    submission = createChatSubmission(captured.prompt, captured.attachments);
    clearChatComposerForSubmission();
    beginOptimisticChatSubmission(submission);
    // Persist the cleared composer under its original conversation key before
    // ensureSession can assign a new one. A delayed debounce would otherwise
    // clear the new key and resurrect the already-sent first message in New Chat.
    if (!await persistComposerDraft()) throw new Error("Your draft could not be updated. Please try sending again.");
    // This same admission already checked the loaded assets. All
    // other sendPrompt callers still check, and the server fences every send.
    void sendPrompt(submission, [], { browserFreshnessChecked: true }).catch((error) => handleChatSubmissionFailure(error, submission));
  } catch (error) {
    if (submission) handleChatSubmissionFailure(error, submission);
    else if (error?.code === "SIDECAR_BROWSER_STALE") await showStaleComposerNotice();
    else setStatus(error.message || String(error));
  } finally {
    state.composerSubmissionPending = false;
    updateControls();
  }
});

elements.promptInput.addEventListener("input", scheduleComposerDraftSave);

async function submitTaskDirection({renewResources=false}={}) {
  if (state.composerSubmissionPending || state.resetting) return;
  const text = elements.promptInput.value;
  const sessionId = state.sessionId;
  const initialGoal = selectedGoal();
  const binding = { ...initialGoal?._bindingV2 };
  const wasHeld = Boolean(initialGoal?._providerUsageHold);
  const checkpointFollowup = wasHeld || ["paused", "awaiting_user_review"].includes(initialGoal?._assignmentPhase)
    || Boolean(state.pendingCheckpointDirection) && ["assignment_id", "session_id", "run_id", "generation"]
      .every(key => binding[key] === state.pendingCheckpointDirection[key]);
  const wasPaused = initialGoal?._assignmentPhase === "paused" || initialGoal?._executionControl?.state === "paused";
  const stillCurrent = () => state.sessionId === sessionId && !state.goalSelectionPinned
    && ["assignment_id", "session_id", "run_id", "generation"].every(key => selectedGoal()?._bindingV2?.[key] === binding[key]);
  let checkpointSaved = false;
  if (!text.trim()) return;
  if (state.pendingAttachments.length) { setStatus("Task directions currently accept text only. Your text and attachments are retained in the draft."); return; }
  state.composerSubmissionPending = true;
  let ownsSubmissionLock = true;
  const releaseSubmissionLock = () => {
    if (!ownsSubmissionLock) return;
    ownsSubmissionLock = false;
    state.composerSubmissionPending = false;
    updateControls();
  };
  updateControls();
  try {
    if (!await persistComposerDraft()) throw new Error("Your draft could not be saved. Your direction has not been sent.");
    await assertLoadedBrowserFresh(loadedBrowserIdentity);
    await syncGoals();
    const goal = selectedGoal();
    if (goal?._bindingV2?.session_id !== sessionId || !stillCurrent()) throw new Error("The selected task changed. Your direction is retained.");
    const commandKey = await taskDraftKey("steer-" + composerDraftKey, sessionId);
    let savedCommand = null;
    const saved = await composerDraftStore.load(commandKey);
    if (saved) { try { savedCommand = JSON.parse(saved.text); } catch {} }
    const control = await fetchJson("/api/assignment-workspace/v2/turn-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goal._bindingV2) });
    if (!stillCurrent()) return;
    const sameCommand = savedCommand?.text === text && (!renewResources||Boolean(savedCommand?.checkpoint?.resource_renewal))
      && ["assignment_id", "session_id", "run_id", "generation"].every(key => savedCommand[key] === goal._bindingV2[key]);
    let checkpoint = null;
    if (checkpointFollowup) {
      const current = await fetchJson(`/api/assignments/v2/${encodeURIComponent(binding.assignment_id)}`);
      if (!stillCurrent()) return;
      checkpoint = renewResources ? checkpointResourceRenewalContext(current.assignment_kernel_v2,initialGoal)
        : checkpointDirectionContext(current.assignment_kernel_v2, initialGoal).checkpoint;
      if (control.active_turn) throw new Error("Wait for the current work to settle. Your direction is retained.");
      if (initialGoal._assignmentPhase === "awaiting_user_review" && !checkpoint && !(sameCommand && savedCommand.checkpoint)) {
        throw new Error("The checkpoint changed. Refresh the task before sending this direction. Your draft is retained.");
      }
    }
    const command = sameCommand && (Boolean(savedCommand.checkpoint) === Boolean(checkpoint) || savedCommand.checkpoint)
      ? savedCommand : { ...binding, command_id: crypto.randomUUID(), text, expected_turn_id: control.active_turn?.turn_id || null,
        ...(checkpoint ? { checkpoint, expected_turn_id: null } : {}) };
    // Retrying a lost response keeps the exact command identity and turn fence.
    await composerDraftStore.save(commandKey, { text: JSON.stringify(command), attachments: [], sessionId });
    if (!stillCurrent()) return;
    if (command.checkpoint) state.pendingCheckpointDirection = command;
    const response = await fetchJson("/api/assignment-workspace/v2/steer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
    if (response.receipt?.state === "rejected") throw new Error(response.receipt.error || "The direction could not be applied. Your draft is retained.");
    if (command.checkpoint && (response.receipt?.state !== "saved" || response.receipt.command_id !== command.command_id)) {
      throw new Error("The direction could not be confirmed. Your draft is retained; retry to check the same saved request.");
    }
    checkpointSaved = Boolean(command.checkpoint);
    if (!stillCurrent()) return;
    if (["saved", "accepted", "delivered"].includes(response.receipt?.state)) await composerDraftStore.clear(commandKey);
    if (command.checkpoint) state.pendingCheckpointDirection = null;
    if (elements.promptInput.value === text) { elements.promptInput.value = ""; await persistComposerDraft(); }
    await restoreConversationHistory();
    if (command.checkpoint) {
      setStatus(wasPaused ? "Direction saved. The task remains paused." : wasHeld ? "Direction saved. The task is still waiting for usage. Use Resume when ready." : "Direction saved. Refresh the task and use Resume if work does not continue.");
      await syncGoals();
      if (!stillCurrent() || wasPaused || wasHeld || selectedGoal()?._providerUsageHold || state.streaming) return;
      const current = await fetchJson(`/api/assignments/v2/${encodeURIComponent(binding.assignment_id)}`);
      if (!stillCurrent() || !selectedGoal()?._canResume || state.streaming) return;
      if (checkpointResumeReady(current.assignment_kernel_v2, selectedGoal(), command)) await runGoalControl("resume", binding, {
        // Resume keeps ownership of its stream and errors. Only this accepted
        // request releases this short submission lock, once; its late finally
        // must not unlock another direction sent while that stream is running.
        onAccepted: () => { if (stillCurrent()) releaseSubmissionLock(); }
      });
      return;
    }
    setStatus(wasHeld ? "Direction saved. The task is still waiting for usage. Use Resume when ready." : response.receipt?.state === "delivered" ? "Direction delivered." : response.receipt?.state === "unconfirmed"
      ? "Direction saved. Delivery is not yet confirmed." : "Direction saved.");
  } catch (error) {
    if (error?.code === "SIDECAR_BROWSER_STALE") await showStaleComposerNotice();
    else setStatus(checkpointSaved ? `Direction saved. ${error.message || "Continuation could not be confirmed."} Refresh the task before using Resume.` : error.message || "Could not send the direction. Your draft is retained.");
  } finally { releaseSubmissionLock(); }
}

elements.newSessionButton.addEventListener("click", resetCurrentMode);
document.querySelector("#tasksButton").addEventListener("click", () => {
  setTaskSidebarOpen(!document.querySelector("#taskDrawer").open);
  void syncTaskNavigation({ refreshCatalogue: true });
});
document.querySelector("#closeTasksButton").addEventListener("click", () => setTaskSidebarOpen(false));
document.querySelector("#taskSearch").addEventListener("input", renderTaskHistory);
document.querySelector('#taskArchiveAll').addEventListener('click',()=>void archiveTaskHistory());
document.querySelector('#taskShowArchived').addEventListener('click',async()=>{
  if(state.taskCatalogueBusy)return;
  state.taskShowArchived=!state.taskShowArchived;
  document.querySelector('#taskShowArchived').setAttribute('aria-pressed',String(state.taskShowArchived));
  document.querySelector('#taskShowArchived').textContent=state.taskShowArchived?'Back to history':'Archived';
  document.querySelector('#taskArchiveAll').hidden=state.taskShowArchived;
  state.taskNavigation=[];
  await syncTaskNavigation({refreshCatalogue:true});
});
document.querySelector("#taskDrawer").addEventListener("close", () => {
  document.querySelector("#tasksButton").setAttribute("aria-expanded", "false");
  document.querySelector("#tasksButton").focus();
});
document.querySelector("#taskNewChatButton").addEventListener("click", resetCurrentMode);
document.querySelector("#taskPauseButton").addEventListener("click", () => stopComputerRun().catch(error => setStatus(error.message)));
document.querySelector("#taskResumeButton").addEventListener("click", () => runGoalControl("resume").catch(error => setStatus(error.message)));
const taskBudgetContinueButton=document.createElement('button');
const taskContinueReportButton=document.createElement('button');
taskContinueReportButton.id='taskContinueReportButton';taskContinueReportButton.hidden=true;
taskContinueReportButton.textContent='Continue this task';
taskContinueReportButton.title='Apply the typed direction to the existing task and its original scope. Use Start new task for a separate request.';
document.querySelector('#taskResumeButton').after(taskContinueReportButton);
taskContinueReportButton.addEventListener('click',()=>{
  if(!elements.promptInput.value.trim())elements.promptInput.value='Continue the remaining work on this task using its saved answers and evidence.';
  void submitTaskDirection();
});
taskBudgetContinueButton.id='taskBudgetContinueButton';taskBudgetContinueButton.hidden=true;
taskBudgetContinueButton.textContent='Continue with +64 calls / +16M tokens';
taskBudgetContinueButton.title='Explicitly authorize one additional bounded window on this task. Prior usage remains counted; native permissions and the drawing scope do not change.';
document.querySelector('#taskResumeButton').after(taskBudgetContinueButton);
taskBudgetContinueButton.addEventListener('click',()=>{
  if(!elements.promptInput.value.trim())elements.promptInput.value='Continue the remaining work on this task with the additional bounded allowance I am authorizing here. Preserve prior work and verify the result.';
  void submitTaskDirection({renewResources:true});
});
elements.refreshScreenButton.addEventListener("click", refreshScreen);
if (elements.screenFrame && elements.screenDialog) {
  elements.screenFrame.addEventListener("click", () => {
    if (!state.screenObjectUrl) return;
    elements.screenDialog.showModal();
  });
}
function renderCompactWork() {
  if (!elements.assignmentCompact) return;
  const storedTask = state.taskNavigation.find(task => task.session_id === state.sessionId);
  const goal = selectedGoal();
  const continueReport=document.querySelector('#taskContinueReportButton');
  if(continueReport){continueReport.hidden=!newRequestAfterReport();continueReport.disabled=Boolean(state.composerSubmissionPending||state.assignmentResumePending);}
  const taskState = currentTaskState(storedTask, goal, state.sessionId);
  const task = taskState ? { ...storedTask, state: taskState } : null;
  const saved = task && ["paused", "pausing", "needs_input", "needs_review", "ready", "unknown", "failed", "stopping_after_usage_limit", "waiting_for_usage"].includes(task.state);
  elements.assignmentCompact.hidden = !state.streaming && !saved;
  elements.assignmentCompactStep.textContent = goal?._providerUsageHold && task ? taskStateLabel(task.state)
    : state.streaming ? state.agentProgress || compactWorkSummary(selectedGoal(), true) : saved ? taskStateLabel(task.state) : "";
  document.querySelector("#taskPauseButton").hidden = !state.streaming || task?.state === "pausing";
  document.querySelector("#taskResumeButton").hidden = state.streaming || state.goalSelectionPinned || !goal?._canResume;
  document.querySelector("#taskResumeButton").disabled = Boolean(state.assignmentResumePending);
  const renewalButton=document.querySelector('#taskBudgetContinueButton');
  if(renewalButton){
    renewalButton.textContent=goal?._resourceRenewalAddsTime===true
      ?'Continue with +20 min / +64 calls / +16M tokens':'Continue with +64 calls / +16M tokens';
    renewalButton.hidden=state.streaming||state.goalSelectionPinned||goal?._assignmentPhase!=='awaiting_user_review'
      ||goal?._canRenewResources!==true;
    renewalButton.disabled=Boolean(state.composerSubmissionPending||state.assignmentResumePending||goal?._providerUsageHold);
  }
  elements.stopButton.hidden = true;
  if (document.getElementById?.("taskActivity")) renderLiveActivity();
}

function renderLiveActivity() {
  const computer = state.activeRunKind === "computer";
  renderTaskActivity(document.getElementById("taskActivity"), {
    running: state.streaming,
    progress: computer ? state.computerProgress : null,
    events: computer ? state.computerEvents : [],
    agentProgress: state.agentProgress,
    fallback: compactWorkSummary(selectedGoal(), true),
    startedAt: state.activityStartedAt,
    updatedAt: state.activityUpdatedAt,
    lastSeenAt: computer ? state.activityLastSeenAt : null,
    connectionLost: computer && state.activityConnectionLost,
    now: Date.now()
  });
}

// Local animation/timer only: no model call, capture, native read or task mutation.
setInterval(() => { if (state.streaming) renderLiveActivity(); }, 1000);

function showWorkDetails(open) {
  const panel = document.querySelector("#workDetails");
  panel.hidden = !open;
  for (const id of ["workDetailsButton", "assignmentCompactToggle"]) document.getElementById(id)?.setAttribute("aria-expanded", String(open));
  if (open) elements.assignmentHeading?.focus?.({ preventScroll: true });
  else document.querySelector("#workDetailsButton")?.focus();
}
elements.assignmentCompactToggle?.addEventListener("click", () => showWorkDetails(true));
document.querySelector("#workDetailsButton")?.addEventListener("click", () => showWorkDetails(document.querySelector("#workDetails").hidden));
document.querySelector("#closeWorkDetails")?.addEventListener("click", () => showWorkDetails(false));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !document.querySelector("#workDetails").hidden) showWorkDetails(false);
});
elements.authSignInButton?.addEventListener("click", openAuthDialog);
elements.authBadge?.addEventListener("click", () => {
  if (`${state.backendAuthMode || ""}`.toLowerCase() === "clashpilot") {
    openAuthDialog();
  }
});
elements.authCancelButton?.addEventListener("click", () => {
  if (elements.authPasswordInput) elements.authPasswordInput.value = "";
  setAuthDialogError("");
  closeAuthDialog();
});
elements.authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await submitSidecarSignIn();
  } catch (error) {
    setAuthDialogError(error.message || String(error));
    setStatus("Sign-in failed.");
  }
});
elements.authLogoutButton?.addEventListener("click", async () => {
  try {
    await submitSidecarLogout();
  } catch (error) {
    setAuthDialogError(error.message || String(error));
    setStatus("Sign-out failed.");
  }
});
elements.environmentRefreshButton?.addEventListener("click", () => refreshEnvironmentProfileFromProbe().catch((error) => setStatus(error.message || "Environment refresh failed.")));
elements.demoReadinessButton?.addEventListener("click", () => runDemoReadinessCheck().catch((error) => setStatus(error.message || "Demo check failed.")));
elements.clearEnvironmentButton?.addEventListener("click", () => clearEnvironmentMemory().catch((error) => setStatus(error.message || "Clear environment failed.")));
elements.copyDiagnosticsButton?.addEventListener("click", () => copyEnvironmentDiagnostics().catch((error) => setStatus(error.message || "Copy diagnostics failed.")));
elements.environmentDetailsToggle?.addEventListener("click", () => {
  state.environmentDetailsOpen = !state.environmentDetailsOpen;
  renderEnvironmentProfile({ profile: state.environmentProfile, manifest: state.environmentStatus });
});
elements.switchDisplayButton?.addEventListener("click", async () => {
  try {
    await switchAmbientDisplayShare();
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
  }
});
if (elements.batchPlanButton) {
  elements.batchPlanButton.addEventListener("click", () => {
    planBatchJob().catch((error) => {
      state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
      renderMessages();
      setStatus("Failed.");
    });
  });
}
if (elements.batchResetButton) {
  elements.batchResetButton.addEventListener("click", () => resetBatchDraft());
}
if (elements.batchJobTypeSelect) {
  elements.batchJobTypeSelect.addEventListener("change", () => {
    state.batchDraftSource = null;
    renderBatchDraftMeta();
  });
}
elements.goalForm?.addEventListener("submit", (event) => {
  createGoalFromForm(event).catch((error) => {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  });
});
elements.goalNewButton?.addEventListener("click", () => {
  elements.goalTitleInput?.focus();
});
elements.goalPauseButton?.addEventListener("click", () => runGoalControl("pause").catch((error) => setStatus(error.message || "Goal pause failed.")));
elements.goalResumeButton?.addEventListener("click", () => runGoalControl("resume").catch((error) => setStatus(error.message || "Goal resume failed.")));
elements.goalRecoverButton?.addEventListener("click", () => recoverCanonicalAssignmentResults(selectedGoal()).catch((error) => setStatus(error.message || "Result recovery failed.")));
elements.goalOpenSavedTaskButton?.addEventListener("click", () => openSelectedSavedAssignmentV2().catch(error => setStatus(error.message || "Could not open the saved task.")));
elements.goalReturnCurrentButton?.addEventListener("click", () => {
  state.goalSelectionPinned = false;
  const current = chooseCurrentAssignment(state.goals, state.assignmentRevitContext, state.sessionId);
  state.activeGoalId = current?.id || "";
  renderGoalPanel();
  setStatus(current ? "Returned to the current assignment." : "No current assignment is available.");
});
elements.goalCancelButton?.addEventListener("click", () => runGoalControl("cancel").catch((error) => setStatus(error.message || "Goal cancel failed.")));
elements.goalAuditButton?.addEventListener("click", () => runGoalControl("completion-audit").catch((error) => setStatus(error.message || "Goal audit failed.")));
elements.stopButton.addEventListener("click", stopComputerRun);
elements.listenButton?.addEventListener("click", async () => {
  try {
    if (state.captureState.mode === "listen") {
      await stopAmbientCapture();
    } else {
      await startAmbientCapture("listen");
    }
  } catch (error) {
    resetAmbientCaptureState();
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.learnButton?.addEventListener("click", async () => {
  try {
    if (state.captureState.mode === "learn") {
      await stopAmbientCapture();
    } else {
      await startAmbientCapture("learn");
    }
  } catch (error) {
    resetAmbientCaptureState();
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.recStartButton.addEventListener("click", async () => {
  try {
    await onRecStart();
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.recStopButton.addEventListener("click", async () => {
  try {
    await onRecStop();
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.micDeviceSelect?.addEventListener("change", () => {
  state.recState.micDeviceId = elements.micDeviceSelect.value || "";
  if (elements.micLevelText) elements.micLevelText.textContent = selectedMicLabel();
});
elements.writeGrantMode?.addEventListener("change", async () => {
  try {
    await setWriteGrantMode(elements.writeGrantMode.value);
    setStatus(state.writeGrantStatus?.active ? "Model changes allowed." : "Read-only mode enabled.");
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Write permission update failed.");
    await refreshWriteGrantStatus().catch(() => null);
  }
});
if (navigator.mediaDevices) {
  navigator.mediaDevices.ondevicechange = () => {
    refreshMicDevices({ requestPermission: false }).catch(() => {});
  };
}
elements.speakButton?.addEventListener("click", async () => {
  try {
    await speakLastAssistantMessage();
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.attachButton.addEventListener("click", () => elements.attachInput.click());
elements.attachInput.addEventListener("change", async (event) => {
  try {
    await attachComposerFiles(event.target.files);
  } finally {
    event.target.value = "";
  }
});
elements.chatPane.addEventListener("dragover", (event) => {
  if (!isFileDrop(event)) return;
  event.preventDefault();
  const allowed = !elements.attachInput.disabled;
  event.dataTransfer.dropEffect = allowed ? "copy" : "none";
  elements.chatPane.classList.toggle("fileDropActive", allowed);
});
elements.chatPane.addEventListener("dragleave", (event) => {
  if (!elements.chatPane.contains(event.relatedTarget)) elements.chatPane.classList.remove("fileDropActive");
});
elements.chatPane.addEventListener("drop", (event) => {
  elements.chatPane.classList.remove("fileDropActive");
  if (!isFileDrop(event)) return;
  event.preventDefault();
  if (!elements.attachInput.disabled) void attachComposerFiles(event.dataTransfer.files);
});
// A file dropped outside the conversation must never navigate away from the draft.
for (const name of ["dragover", "drop"]) {
  window.addEventListener(name, (event) => {
    if (isFileDrop(event)) event.preventDefault();
  });
}
elements.promptInput.addEventListener("paste", async (event) => {
  try {
    await handlePasteAttachments(event);
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  elements.chatForm.requestSubmit();
});
elements.chatForm.addEventListener("paste", async (event) => {
  if (event.target === elements.promptInput) return;
  try {
    await handlePasteAttachments(event);
  } catch (error) {
    state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
    renderMessages();
    setStatus("Failed.");
  }
});
elements.fbWorked.addEventListener("click", () => submitFeedback("worked").catch((error) => {
  state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
  renderMessages();
  setStatus("Failed.");
}));
elements.fbPartial.addEventListener("click", () => submitFeedback("partial").catch((error) => {
  state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
  renderMessages();
  setStatus("Failed.");
}));
elements.fbFailed.addEventListener("click", () => submitFeedback("failed").catch((error) => {
  state.computerMessages.push({ role: "error", text: error.message || String(error), attachments: [] });
  renderMessages();
  setStatus("Failed.");
}));

initializeSpeedControls();
initializeTaskSidebar();
initializeFreshConversation();
await restoreComposerDraft();
elements.promptInput.focus();
await initializeBackendBootstrap();
await restoreComposerAfterRefresh();
initializeConversationView();
resetBatchDraft();
renderAttachStrip();
setRecUiState();
updateAmbientCaptureButtons();
renderRunSummary();
renderGoalPanel();
renderScreenMeta();
renderBatchJobs();
beginNonBlockingBootstrapServices({
  restoreSession: () => {
    renderSessionStartScreen();
  },
  startPolling: () => {
    scheduleScreenRefresh();
    scheduleComputerPolling();
    scheduleNotificationsPolling();
    scheduleBatchJobsPolling();
    scheduleGoalsPolling();
    setInterval(() => void syncTaskNavigation(), 3000);
    void syncTaskNavigation();
    scheduleWriteGrantPolling();
  },
  refreshEnvironment: refreshEnvironmentProfile
});
void refreshWriteGrantStatus().catch(() => null);
void refreshMicDevices({ requestPermission: false }).catch(() => null);
void syncComputerState().catch(() => null);
void syncNotifications().catch(() => null);
void syncBatchJobs().catch(() => null);
void syncGoals().catch(() => null);
void syncCaptureArtifacts().catch(() => null);
void refreshScreen().catch(() => null);

window.addEventListener("beforeunload", () => {
  if (state.screenObjectUrl) URL.revokeObjectURL(state.screenObjectUrl);
  if (state.screenPreviewObjectUrl) URL.revokeObjectURL(state.screenPreviewObjectUrl);
});
