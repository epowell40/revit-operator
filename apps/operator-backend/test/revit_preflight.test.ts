import test from "node:test";
import assert from "node:assert/strict";
import { buildRevitBridgePreflightReport, summarizeRevitBridgePreflightReport } from "../src/benchmark/revit_preflight.js";

test("Revit bridge preflight reports ok when ping and context pass", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    checkedBridgeUrls: ["http://localhost:5000", "http://localhost:5010"],
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } }
  });

  assert.equal(report.ok, true);
  assert.equal(report.diagnosis, "ok");
  assert.deepEqual(report.checked_bridge_urls, ["http://localhost:5000", "http://localhost:5010"]);
  assert.match(report.next_steps.join("\n"), /discover-revit-demo/);
});

test("Revit bridge preflight identifies a non-bridge service on the configured port", () => {
  const generic404 = "<!doctype html><html lang=en><title>404 Not Found</title><p>The requested URL was not found on the server.</p>";
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: false, status: 404, body: generic404 },
    context: { ok: false, status: 404, body: generic404 }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "wrong_service");
  assert.match(report.message, /does not expose the Operator Revit bridge endpoints/);
});

test("Revit bridge preflight identifies unreachable bridge URL", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: false, error: "fetch failed" },
    context: { ok: false, error: "fetch failed" }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "unreachable");
  assert.match(report.next_steps.join("\n"), /Start Revit/);
});

test("Revit bridge preflight identifies local Revit host crash evidence", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: false, error: "No connection could be made because the target machine actively refused it." },
    context: { ok: false, error: "No connection could be made because the target machine actively refused it." },
    hostEvidence: {
      platform: "win32",
      checked_at: "2026-07-07T12:49:30.0000000-04:00",
      revit_processes: [],
      recent_crash_events: [
        {
          time_created: "2026-07-07T12:49:18.0000000-04:00",
          provider_name: "Windows Error Reporting",
          id: 1001,
          message: "Fault bucket for Revit.exe"
        },
        {
          time_created: "2026-07-07T12:49:17.0000000-04:00",
          provider_name: "Application Error",
          id: 1000,
          message: "Faulting application name: Revit.exe\nFaulting module name: clr.dll\nException code: 0xc0000005",
          faulting_module: "clr.dll",
          exception_code: "0xc0000005"
        },
        {
          time_created: "2026-07-07T12:49:16.0000000-04:00",
          provider_name: ".NET Runtime",
          id: 1023,
          message: "Application: Revit.exe\nDescription: The process was terminated due to an internal error with exit code 80131506.",
          exit_code: "80131506"
        }
      ]
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "host_crash");
  assert.match(report.message, /Revit crashed/);
  assert.equal(report.host_evidence?.recent_crash_events?.[1]?.faulting_module, "clr.dll");

  const summary = summarizeRevitBridgePreflightReport(report);
  assert.equal(summary.diagnosis, "host_crash");
  assert.equal(summary.recent_revit_crash_count, 3);
  assert.equal(summary.latest_revit_crash?.faulting_module, "clr.dll");
  assert.equal(summary.latest_revit_crash?.exception_code, "0xc0000005");
});

test("Revit bridge preflight identifies modal blocker before generic unreachable diagnosis", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: false, error: "fetch failed" },
    context: { ok: false, error: "fetch failed" },
    hostEvidence: {
      platform: "win32",
      checked_at: "2026-07-07T12:50:00.0000000-04:00",
      revit_processes: [
        {
          id: 78160,
          path: "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
          main_window_title: "",
          responding: true
        }
      ],
      modal_windows: [
        { process_id: 78160, title: "Security - Unsigned Add-In" }
      ],
      recent_crash_events: []
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "host_modal_blocker");
  assert.match(report.message, /Security - Unsigned Add-In/);

  const summary = summarizeRevitBridgePreflightReport(report);
  assert.equal(summary.host_revit_process_count, 1);
  assert.deepEqual(summary.host_modal_windows, ["Security - Unsigned Add-In"]);
});

test("Revit bridge preflight fails when required capabilities are missing", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        tools: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" }
        ]
      }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_capability");
  assert.deepEqual(report.missing_required_paths, ["/revit/link-cad", "/revit/visibility"]);
  assert.match(report.next_steps.join("\n"), /install the current Revit Operator add-in bundle/);
});

test("Revit bridge preflight passes when required capabilities are present", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/link-cad" },
          { method: "POST", path: "/revit/visibility" }
        ]
      }
    },
    cadLinkDryRunProbe: {
      ok: true,
      status: 200,
      body: {
        status: "Dry Run",
        dryRun: true,
        preflightOnly: true,
        targetMode: "view_then_sheet",
        supportsOwnerViewSheetPlacement: true,
        supportsCadCategories: true,
        requiredApplyEvidence: [
          "elementId",
          "ownerViewId",
          "sheetViewId",
          "viewportId",
          "viewportBox",
          "elementBoundingBoxInOwnerView",
          "cadCategories"
        ]
      }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  });

  assert.equal(report.ok, true);
  assert.equal(report.diagnosis, "ok");
  assert.deepEqual(report.missing_required_paths, []);
});

test("Revit bridge preflight fails selected mutating tasks when write grant is inactive", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    writeGrantStatus: {
      ok: true,
      status: 200,
      body: {
        active: false,
        mode: "yolo",
        error: "Write grant expired."
      }
    },
    requireWriteGrant: true
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_write_grant");
  assert.equal(report.require_write_grant, true);
  assert.equal((report.write_grant_status?.body as { active?: boolean }).active, false);
  assert.match(report.message, /require an active Operator write grant/);
  assert.match(report.next_steps.join("\n"), /Writes to 'Allow this session' or 'YOLO'/);
});

test("Revit bridge preflight summary keeps live blocker output compact", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    checkedBridgeUrls: ["http://localhost:5000", "http://localhost:5010"],
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: {
      ok: true,
      status: 200,
      body: {
        readiness: {
          active_document_name: "Snowdon Towers Sample HVAC",
          active_document_path: "C:\\Sample\\Snowdon Towers Sample HVAC.rvt",
          active_view_name: "Cover Sheet",
          active_view_type: "DrawingSheet"
        }
      }
    },
    writeGrantStatus: {
      ok: true,
      status: 200,
      body: {
        active: false,
        mode: "none",
        error: "Write grant expired."
      }
    },
    capabilities: { ok: true, status: 200, body: { tools: [{ path: "/revit/context" }] } },
    requiredPaths: ["/revit/context"],
    requireWriteGrant: true
  });
  const summary = summarizeRevitBridgePreflightReport(report);

  assert.equal(summary.ok, false);
  assert.equal(summary.diagnosis, "missing_write_grant");
  assert.equal(summary.require_write_grant, true);
  assert.equal(summary.write_grant_active, false);
  assert.equal(summary.write_grant_mode, "none");
  assert.equal(summary.write_grant_error, "Write grant expired.");
  assert.equal(summary.active_document_name, "Snowdon Towers Sample HVAC");
  assert.equal(summary.active_view_name, "Cover Sheet");
  assert.deepEqual(summary.required_paths, ["/revit/context"]);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, "capabilities"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, "context"), false);
});

test("Revit bridge preflight passes selected mutating tasks when write grant is active", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    writeGrantStatus: {
      ok: true,
      status: 200,
      body: {
        active: true,
        mode: "session"
      }
    },
    requireWriteGrant: true
  });

  assert.equal(report.ok, true);
  assert.equal(report.diagnosis, "ok");
  assert.equal(report.require_write_grant, true);
  assert.equal((report.write_grant_status?.body as { active?: boolean }).active, true);
});

test("Revit bridge preflight fails reachable mutating tasks when a host modal is present", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Snowdon Towers Sample HVAC" } },
    writeGrantStatus: {
      ok: true,
      status: 200,
      body: {
        active: true,
        mode: "yolo"
      }
    },
    requireWriteGrant: true,
    hostEvidence: {
      platform: "win32",
      checked_at: "2026-07-07T15:54:03.9004114-04:00",
      revit_processes: [
        {
          id: 33592,
          path: "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
          main_window_title: "Autodesk Revit 2024.3 - [Snowdon Towers Sample HVAC.rvt - Sheet: M000 - Cover Sheet]",
          responding: true
        }
      ],
      modal_windows: [
        { process_id: 33592, title: "Project Not Saved Recently" }
      ],
      recent_crash_events: []
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "host_modal_blocker");
  assert.match(report.message, /Project Not Saved Recently/);
  assert.match(report.next_steps.join("\n"), /Rerun preflight-revit/);

  const summary = summarizeRevitBridgePreflightReport(report);
  assert.equal(summary.write_grant_active, true);
  assert.deepEqual(summary.host_modal_windows, ["Project Not Saved Recently"]);
});

test("Revit bridge preflight fails when CAD dry-run preview is write-gated", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/link-cad" },
          { method: "POST", path: "/revit/visibility" }
        ]
      }
    },
    cadLinkDryRunProbe: {
      ok: false,
      status: 403,
      body: {
        error: "Write requires approval (missing/invalid X-Operator-Write-Grant).",
        details: "Missing X-Operator-Write-Grant."
      }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_capability");
  assert.match(report.message, /dry-run preview is still write-gated/);
  assert.match(report.next_steps.join("\n"), /Close Revit/);
});

test("Revit bridge preflight fails stale active-project TextNote replacement docId contract", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Snowdon Towers Sample HVAC" } },
    writeGrantStatus: {
      ok: true,
      status: 200,
      body: {
        active: true,
        mode: "yolo"
      }
    },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/find-text-notes" },
          { method: "POST", path: "/revit/replace-text-note" }
        ]
      }
    },
    textNoteReplaceDryRunProbe: {
      ok: false,
      status: 500,
      body: { error: "replace-text-note.docId is required." }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/find-text-notes", "/revit/replace-text-note"],
    requireWriteGrant: true
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_capability");
  assert.match(report.message, /old docId contract/);
  assert.match(report.message, /running add-in DLL is stale/);
  assert.match(report.next_steps.join("\n"), /replace-text-note accepts elementId\/newText/);
});

test("Revit bridge preflight passes active-project TextNote replacement dry-run shape", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Snowdon Towers Sample HVAC" } },
    writeGrantStatus: {
      ok: true,
      status: 200,
      body: {
        active: true,
        mode: "yolo"
      }
    },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/find-text-notes" },
          { method: "POST", path: "/revit/replace-text-note" }
        ]
      }
    },
    textNoteReplaceDryRunProbe: {
      ok: true,
      status: 200,
      body: { status: "Dry Run", dryRun: true, textNoteId: 1422186, before: "Electrical Transformer Pad", after: "Electrical Transformer Pad - VERIFIED" }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/find-text-notes", "/revit/replace-text-note"],
    requireWriteGrant: true
  });

  assert.equal(report.ok, true);
  assert.equal(report.diagnosis, "ok");
  assert.equal((report.text_note_replace_dry_run_probe?.body as { dryRun?: boolean }).dryRun, true);
});

test("Revit bridge preflight fails when CAD dry-run lacks owner-view sheet capability shape", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/link-cad" },
          { method: "POST", path: "/revit/visibility" }
        ]
      }
    },
    cadLinkDryRunProbe: {
      ok: false,
      status: 500,
      body: { error: "link-cad requires sheetViewId or sheetNumber." }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_capability");
  assert.match(report.message, /does not report the owner-view sheet-placement capability shape/);
});

test("Revit bridge preflight fails when CAD dry-run omits strong apply evidence", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/link-cad" },
          { method: "POST", path: "/revit/visibility" }
        ]
      }
    },
    cadLinkDryRunProbe: {
      ok: true,
      status: 200,
      body: {
        status: "Dry Run",
        dryRun: true,
        preflightOnly: true,
        targetMode: "view_then_sheet"
      }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_capability");
  assert.match(report.message, /does not report the owner-view sheet-placement capability shape/);
});

test("Revit bridge preflight fails when CAD dry-run only advertises id evidence", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } },
    capabilities: {
      ok: true,
      status: 200,
      body: {
        allowlist: [
          { method: "GET", path: "/revit/context" },
          { method: "POST", path: "/revit/export-image" },
          { method: "POST", path: "/revit/link-cad" },
          { method: "POST", path: "/revit/visibility" }
        ]
      }
    },
    cadLinkDryRunProbe: {
      ok: true,
      status: 200,
      body: {
        status: "Dry Run",
        dryRun: true,
        preflightOnly: true,
        targetMode: "view_then_sheet",
        supportsOwnerViewSheetPlacement: true,
        supportsCadCategories: true,
        requiredApplyEvidence: ["elementId", "ownerViewId", "sheetViewId", "viewportId", "cadCategories"]
      }
    },
    requiredPaths: ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "missing_capability");
  assert.match(report.message, /does not report the owner-view sheet-placement capability shape/);
});
