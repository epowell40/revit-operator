type BridgeCheck = {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
};

export type RevitHostEvidence = {
  platform?: string;
  checked_at?: string;
  revit_processes?: Array<{
    id?: number;
    path?: string;
    main_window_title?: string;
    responding?: boolean;
    start_time?: string;
  }>;
  modal_windows?: Array<{
    process_id?: number;
    title: string;
  }>;
  recent_crash_events?: Array<{
    time_created?: string;
    provider_name?: string;
    id?: number;
    message: string;
    faulting_module?: string;
    exception_code?: string;
    exit_code?: string;
  }>;
  collection_error?: string;
};

export type RevitBridgePreflightReport = {
  bridge_url: string;
  checked_bridge_urls?: string[];
  ping: BridgeCheck;
  context: BridgeCheck;
  write_grant_status?: BridgeCheck;
  capabilities?: BridgeCheck;
  cad_link_dry_run_probe?: BridgeCheck;
  text_note_replace_dry_run_probe?: BridgeCheck;
  required_paths?: string[];
  missing_required_paths?: string[];
  require_write_grant?: boolean;
  local_port_owner?: unknown;
  host_evidence?: RevitHostEvidence;
  ok: boolean;
  diagnosis: "ok" | "wrong_service" | "auth_or_endpoint_failure" | "unreachable" | "host_crash" | "host_modal_blocker" | "missing_capability" | "missing_write_grant";
  message: string;
  next_steps: string[];
};

export type RevitBridgePreflightSummary = {
  ok: boolean;
  diagnosis: RevitBridgePreflightReport["diagnosis"];
  bridge_url: string;
  message: string;
  require_write_grant: boolean;
  write_grant_active: boolean | null;
  write_grant_mode?: string;
  write_grant_error?: string;
  active_document_name?: string;
  active_document_path?: string;
  active_view_name?: string;
  active_view_type?: string;
  required_paths: string[];
  missing_required_paths: string[];
  checked_bridge_urls?: string[];
  host_revit_process_count?: number;
  host_modal_windows?: string[];
  recent_revit_crash_count?: number;
  latest_revit_crash?: {
    time_created?: string;
    provider_name?: string;
    faulting_module?: string;
    exception_code?: string;
    exit_code?: string;
  };
  next_steps: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bodyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function looksLikeGeneric404(check: BridgeCheck): boolean {
  if (check.status !== 404) return false;
  const text = bodyText(check.body).toLowerCase();
  return text.includes("404 not found") || text.includes("requested url was not found") || text.includes("<html");
}

function isUnreachable(check: BridgeCheck): boolean {
  if (check.error) return true;
  return check.status === undefined && !check.ok;
}

function latestRevitCrash(evidence: RevitHostEvidence | undefined): NonNullable<RevitHostEvidence["recent_crash_events"]>[number] | undefined {
  const events = evidence?.recent_crash_events ?? [];
  const revitEvents = events.filter((event) => {
    const text = `${event.provider_name ?? ""}\n${event.message ?? ""}`.toLowerCase();
    return text.includes("revit.exe")
      || text.includes("faulting application name: revit")
      || text.includes("application: revit.exe");
  });
  return revitEvents.find((event) => event.faulting_module || event.exception_code || event.exit_code)
    ?? revitEvents[0];
}

function firstBlockingModal(evidence: RevitHostEvidence | undefined): NonNullable<RevitHostEvidence["modal_windows"]>[number] | undefined {
  const titles = evidence?.modal_windows ?? [];
  return titles.find((window) => {
    const title = window.title.trim();
    if (!title) return false;
    return !/^autodesk revit\b/i.test(title);
  });
}

function isWriteGrantFailure(check: BridgeCheck | undefined): boolean {
  if (!check) return false;
  const text = bodyText(check.body ?? check.error).toLowerCase();
  return text.includes("x-operator-write-grant") || text.includes("write requires approval");
}

function hasCadLinkPreflightOnlyShape(check: BridgeCheck | undefined): boolean {
  if (!check?.ok || !check.body || typeof check.body !== "object") return false;
  const obj = check.body as Record<string, unknown>;
  const requiredEvidence = Array.isArray(obj.requiredApplyEvidence)
    ? new Set(obj.requiredApplyEvidence.filter((entry): entry is string => typeof entry === "string"))
    : new Set<string>();
  return obj.dryRun === true
    && obj.preflightOnly === true
    && obj.targetMode === "view_then_sheet"
    && obj.supportsOwnerViewSheetPlacement === true
    && obj.supportsCadCategories === true
    && [
      "elementId",
      "ownerViewId",
      "sheetViewId",
      "viewportId",
      "viewportBox",
      "elementBoundingBoxInOwnerView",
      "cadCategories"
    ].every((key) => requiredEvidence.has(key));
}

function isTextNoteReplaceDocIdContractFailure(check: BridgeCheck | undefined): boolean {
  if (!check) return false;
  const text = bodyText(check.body ?? check.error).toLowerCase();
  return text.includes("replace-text-note.docid is required")
    || (text.includes("docid is required") && text.includes("replace-text-note"));
}

function hasTextNoteReplaceDryRunShape(check: BridgeCheck | undefined): boolean {
  if (!check?.ok || !check.body || typeof check.body !== "object") return false;
  const obj = check.body as Record<string, unknown>;
  const status = String(obj.status ?? "").toLowerCase();
  return obj.dryRun === true || status.includes("dry run") || status.includes("preview");
}

export function summarizeRevitBridgePreflightReport(report: RevitBridgePreflightReport): RevitBridgePreflightSummary {
  const writeGrantBody = asRecord(report.write_grant_status?.body);
  const contextBody = asRecord(report.context.body);
  const readiness = asRecord(contextBody.readiness);
  const document = asRecord(contextBody.document);
  const activeView = asRecord(document.activeView);
  const writeGrantActive = typeof writeGrantBody.active === "boolean" ? writeGrantBody.active : null;
  const writeGrantMode = typeof writeGrantBody.mode === "string" ? writeGrantBody.mode : undefined;
  const writeGrantError = typeof writeGrantBody.error === "string" ? writeGrantBody.error : undefined;
  const latestCrash = latestRevitCrash(report.host_evidence);
  const modalWindows = (report.host_evidence?.modal_windows ?? []).map((entry) => entry.title).filter(Boolean);

  return {
    ok: report.ok,
    diagnosis: report.diagnosis,
    bridge_url: report.bridge_url,
    message: report.message,
    require_write_grant: report.require_write_grant === true,
    write_grant_active: writeGrantActive,
    ...(writeGrantMode ? { write_grant_mode: writeGrantMode } : {}),
    ...(writeGrantError ? { write_grant_error: writeGrantError } : {}),
    active_document_name: String(readiness.active_document_name ?? document.title ?? "").trim() || undefined,
    active_document_path: String(readiness.active_document_path ?? document.path ?? "").trim() || undefined,
    active_view_name: String(readiness.active_view_name ?? activeView.name ?? "").trim() || undefined,
    active_view_type: String(readiness.active_view_type ?? activeView.type ?? "").trim() || undefined,
    required_paths: report.required_paths ?? [],
    missing_required_paths: report.missing_required_paths ?? [],
    checked_bridge_urls: report.checked_bridge_urls,
    ...(report.host_evidence?.revit_processes ? { host_revit_process_count: report.host_evidence.revit_processes.length } : {}),
    ...(modalWindows.length > 0 ? { host_modal_windows: modalWindows } : {}),
    ...(report.host_evidence?.recent_crash_events ? { recent_revit_crash_count: report.host_evidence.recent_crash_events.length } : {}),
    ...(latestCrash ? {
      latest_revit_crash: {
        time_created: latestCrash.time_created,
        provider_name: latestCrash.provider_name,
        faulting_module: latestCrash.faulting_module,
        exception_code: latestCrash.exception_code,
        exit_code: latestCrash.exit_code
      }
    } : {}),
    next_steps: report.next_steps
  };
}

function hasActiveWriteGrant(check: BridgeCheck | undefined): boolean {
  if (!check?.ok || !check.body || typeof check.body !== "object") return false;
  const obj = check.body as Record<string, unknown>;
  return obj.active === true;
}

function collectCapabilityPaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.path === "string" && obj.path.startsWith("/")) paths.add(obj.path);
    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  };
  visit(value);
  return paths;
}

export function buildRevitBridgePreflightReport(input: {
  bridgeUrl: string;
  ping: BridgeCheck;
  context: BridgeCheck;
  capabilities?: BridgeCheck;
  writeGrantStatus?: BridgeCheck;
  cadLinkDryRunProbe?: BridgeCheck;
  textNoteReplaceDryRunProbe?: BridgeCheck;
  requiredPaths?: string[];
  requireWriteGrant?: boolean;
  localPortOwner?: unknown;
  hostEvidence?: RevitHostEvidence;
  checkedBridgeUrls?: string[];
}): RevitBridgePreflightReport {
  const requiredPaths = Array.from(new Set((input.requiredPaths ?? []).filter((path) => path.startsWith("/")))).sort();
  const capabilityPaths = input.capabilities?.ok ? collectCapabilityPaths(input.capabilities.body) : new Set<string>();
  const missingRequiredPaths = requiredPaths.filter((path) => !capabilityPaths.has(path));
  const requiredCapabilitiesOk = requiredPaths.length === 0 || (input.capabilities?.ok === true && missingRequiredPaths.length === 0);
  const cadLinkDryRunWriteGated = requiredPaths.includes("/revit/link-cad") && isWriteGrantFailure(input.cadLinkDryRunProbe);
  const cadLinkPreflightShapeMissing = requiredPaths.includes("/revit/link-cad") && !hasCadLinkPreflightOnlyShape(input.cadLinkDryRunProbe);
  const textNoteReplaceDryRunWriteGated = requiredPaths.includes("/revit/replace-text-note") && isWriteGrantFailure(input.textNoteReplaceDryRunProbe);
  const textNoteReplaceDocIdContractMissing = requiredPaths.includes("/revit/replace-text-note") && isTextNoteReplaceDocIdContractFailure(input.textNoteReplaceDryRunProbe);
  const textNoteReplaceProbeMissing = requiredPaths.includes("/revit/replace-text-note")
    && !textNoteReplaceDryRunWriteGated
    && !textNoteReplaceDocIdContractMissing
    && !hasTextNoteReplaceDryRunShape(input.textNoteReplaceDryRunProbe);
  const writeGrantOk = input.requireWriteGrant !== true || hasActiveWriteGrant(input.writeGrantStatus);
  const blockingModal = firstBlockingModal(input.hostEvidence);
  const modalOk = input.requireWriteGrant !== true || !blockingModal;
  const ok = input.ping.ok
    && input.context.ok
    && requiredCapabilitiesOk
    && writeGrantOk
    && modalOk
    && !cadLinkDryRunWriteGated
    && !cadLinkPreflightShapeMissing
    && !textNoteReplaceDryRunWriteGated
    && !textNoteReplaceDocIdContractMissing
    && !textNoteReplaceProbeMissing;
  if (ok) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
      missing_required_paths: requiredPaths.length > 0 ? [] : undefined,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: true,
      diagnosis: "ok",
      message: "Revit bridge preflight passed.",
      next_steps: [
        "Run discover-revit-demo to generate live benchmark request overrides.",
        "Run deterministic_skill_only live benchmarks with OPERATOR_BENCHMARK_USE_MOCKS=0."
      ]
    };
  }

  if (isUnreachable(input.ping) || isUnreachable(input.context)) {
    const crash = latestRevitCrash(input.hostEvidence);
    if (crash) {
      return {
        bridge_url: input.bridgeUrl,
        checked_bridge_urls: input.checkedBridgeUrls,
        ping: input.ping,
        context: input.context,
        write_grant_status: input.writeGrantStatus,
        capabilities: input.capabilities,
        cad_link_dry_run_probe: input.cadLinkDryRunProbe,
        text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
        required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
        missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
        require_write_grant: input.requireWriteGrant === true ? true : undefined,
        local_port_owner: input.localPortOwner,
        host_evidence: input.hostEvidence,
        ok: false,
        diagnosis: "host_crash",
        message: "The Revit bridge is unreachable and recent local evidence shows Revit crashed before the bridge became ready.",
        next_steps: [
          "Do not run live benchmarks or promote redline rows until Revit starts with the Operator add-in loaded.",
          "Inspect the latest Windows Application events and Revit journal for the reported faulting module and exit code.",
          "After fixing the startup crash, rerun preflight-revit and then rerun the known passing Snowdon smoke tasks before testing new workflows."
        ]
      };
    }
    const modal = firstBlockingModal(input.hostEvidence);
    if (modal) {
      return {
        bridge_url: input.bridgeUrl,
        checked_bridge_urls: input.checkedBridgeUrls,
        ping: input.ping,
        context: input.context,
        write_grant_status: input.writeGrantStatus,
        capabilities: input.capabilities,
        cad_link_dry_run_probe: input.cadLinkDryRunProbe,
        text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
        required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
        missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
        require_write_grant: input.requireWriteGrant === true ? true : undefined,
        local_port_owner: input.localPortOwner,
        host_evidence: input.hostEvidence,
        ok: false,
        diagnosis: "host_modal_blocker",
        message: `The Revit bridge is unreachable and Revit appears blocked by a modal window: ${modal.title}.`,
        next_steps: [
          "Resolve the Revit modal dialog without applying unintended model changes.",
          "Confirm Revit remains open with the target model active and the Operator add-in loaded.",
          "Rerun preflight-revit before any live benchmark execution."
        ]
      };
    }
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
      missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "unreachable",
      message: "The configured Revit bridge URL is not reachable.",
      next_steps: [
        "Start Revit with the Operator add-in loaded and open the demo model.",
        "Confirm REVIT_BRIDGE_URL points at the add-in bridge, usually http://localhost:5000.",
        "If another port is configured in the add-in, set REVIT_BRIDGE_URL to that exact URL."
      ]
    };
  }

  if (looksLikeGeneric404(input.ping) && looksLikeGeneric404(input.context)) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
      missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "wrong_service",
      message: "Something is listening at the configured URL, but it does not expose the Operator Revit bridge endpoints.",
      next_steps: [
        "Check which process owns the port and stop or move the non-bridge service if needed.",
        "Start Revit with the Operator add-in loaded so /revit/ping and /revit/context are served by the bridge.",
        "Set REVIT_BRIDGE_URL to the actual bridge URL before running discovery or live benchmarks."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && !requiredCapabilitiesOk) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths,
      missing_required_paths: missingRequiredPaths,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_capability",
      message: "The Revit bridge is reachable, but it does not report all endpoints required by the selected live benchmark tasks.",
      next_steps: [
        "Close Revit, install the current Revit Operator add-in bundle, and reopen the target model.",
        "Run npm run benchmark -- preflight-revit again and confirm the required paths are reported.",
        "Do not run the live CAD/documentation benchmark against this bridge until the missing endpoints are present."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && input.requireWriteGrant === true && blockingModal) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
      missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
      require_write_grant: true,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "host_modal_blocker",
      message: `The Revit bridge is reachable, but Revit appears blocked by a modal window before a mutating live benchmark: ${blockingModal.title}.`,
      next_steps: [
        "Resolve the Revit modal dialog without applying unintended model changes.",
        "Confirm Revit remains open with the target model active and the Operator write grant still active.",
        "Rerun preflight-revit before any mutating live benchmark execution."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && input.requireWriteGrant === true && !hasActiveWriteGrant(input.writeGrantStatus)) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
      missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
      require_write_grant: true,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_write_grant",
      message: "The Revit bridge is reachable, but the selected live benchmark tasks require an active Operator write grant.",
      next_steps: [
        "In the Operator pane, set Writes to 'Allow this session' or 'YOLO' and confirm the Grant badge is active.",
        "Run npm run benchmark -- preflight-revit --task <task_id> again and confirm write_grant_status.active is true.",
        "Do not run mutating live Revit benchmark tasks until the write grant is active."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && cadLinkDryRunWriteGated) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths,
      missing_required_paths: missingRequiredPaths,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_capability",
      message: "The Revit bridge is reachable, but CAD link dry-run preview is still write-gated, which indicates a stale add-in for CAD sheet placement workflows.",
      next_steps: [
        "Close Revit, install the current Revit Operator add-in bundle, and reopen the target model.",
        "Re-run preflight and confirm /revit/link-cad dry-run no longer requires X-Operator-Write-Grant.",
        "Do not run the live M104-to-M107 CAD placement benchmark against this bridge."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && textNoteReplaceDryRunWriteGated) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths,
      missing_required_paths: missingRequiredPaths,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_capability",
      message: "The Revit bridge is reachable, but TextNote replacement dry-run preview is still write-gated, which indicates a stale add-in for active-project text-note edits.",
      next_steps: [
        "Close Revit, install the current Revit Operator add-in bundle, and reopen the target model.",
        "Re-run preflight and confirm /revit/replace-text-note dryRun no longer requires X-Operator-Write-Grant.",
        "Do not run the live TextNote replacement benchmark against this bridge."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && textNoteReplaceDocIdContractMissing) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths,
      missing_required_paths: missingRequiredPaths,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_capability",
      message: "The Revit bridge is reachable, but active-project TextNote replacement still requires the old docId contract, which indicates the running add-in DLL is stale.",
      next_steps: [
        "Close Revit, install or reload the current Revit Operator add-in DLL, and reopen Snowdon.",
        "Re-run preflight and confirm /revit/replace-text-note accepts elementId/newText dry-run requests against the active project.",
        "Do not run the live TextNote replacement benchmark against this bridge."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && textNoteReplaceProbeMissing) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths,
      missing_required_paths: missingRequiredPaths,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_capability",
      message: "The Revit bridge is reachable, but TextNote replacement dry-run preview did not return a usable dry-run shape.",
      next_steps: [
        "Close Revit, install the current Revit Operator add-in bundle, and reopen the target model.",
        "Re-run preflight and confirm /revit/replace-text-note returns dryRun=true or Dry Run status.",
        "Do not run the live TextNote replacement benchmark against this bridge."
      ]
    };
  }

  if (input.ping.ok && input.context.ok && cadLinkPreflightShapeMissing) {
    return {
      bridge_url: input.bridgeUrl,
      checked_bridge_urls: input.checkedBridgeUrls,
      ping: input.ping,
      context: input.context,
      write_grant_status: input.writeGrantStatus,
      capabilities: input.capabilities,
      cad_link_dry_run_probe: input.cadLinkDryRunProbe,
      text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
      required_paths: requiredPaths,
      missing_required_paths: missingRequiredPaths,
      require_write_grant: input.requireWriteGrant === true ? true : undefined,
      local_port_owner: input.localPortOwner,
      host_evidence: input.hostEvidence,
      ok: false,
      diagnosis: "missing_capability",
      message: "The Revit bridge is reachable, but CAD link dry-run preview does not report the owner-view sheet-placement capability shape required for live CAD documentation workflows.",
      next_steps: [
        "Close Revit, install the current Revit Operator add-in bundle, and reopen the target model.",
        "Re-run preflight and confirm /revit/link-cad dryRun/preflightOnly reports targetMode=view_then_sheet.",
        "Do not run the live M104-to-M107 CAD placement benchmark against this bridge."
      ]
    };
  }

  return {
    bridge_url: input.bridgeUrl,
    checked_bridge_urls: input.checkedBridgeUrls,
    ping: input.ping,
    context: input.context,
    write_grant_status: input.writeGrantStatus,
    capabilities: input.capabilities,
    cad_link_dry_run_probe: input.cadLinkDryRunProbe,
    text_note_replace_dry_run_probe: input.textNoteReplaceDryRunProbe,
    required_paths: requiredPaths.length > 0 ? requiredPaths : undefined,
    missing_required_paths: requiredPaths.length > 0 ? missingRequiredPaths : undefined,
    require_write_grant: input.requireWriteGrant === true ? true : undefined,
    local_port_owner: input.localPortOwner,
    host_evidence: input.hostEvidence,
    ok: false,
    diagnosis: "auth_or_endpoint_failure",
    message: "The bridge URL responded, but required Operator Revit endpoints did not both pass.",
    next_steps: [
      "Verify the add-in and backend share the same Operator token.",
      "Inspect the ping/context status codes and response bodies for auth or route errors.",
      "Fix the bridge response before running live discovery or live benchmark batches."
    ]
  };
}
