import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRevitStartupDiagnostics, renderRevitStartupDiagnosticsMarkdown } from "../src/benchmark/revit_startup_diagnostics.js";

test("Revit startup diagnostics classifies clr startup crash evidence", () => {
  const report = buildRevitStartupDiagnostics({
    revitYear: "2024",
    checkedAt: "2026-07-07T20:30:00.000Z",
    hostEvidence: {
      platform: "win32",
      checked_at: "2026-07-07T20:30:00.000Z",
      revit_processes: [],
      modal_windows: [],
      recent_crash_events: [
        {
          time_created: "2026-07-07T16:21:45.6915275-04:00",
          provider_name: "Application Error",
          id: 1000,
          message: "Faulting application name: Revit.exe\nFaulting module name: clr.dll\nException code: 0xc0000005",
          faulting_module: "clr.dll",
          exception_code: "0xc0000005"
        },
        {
          time_created: "2026-07-07T16:21:45.2531917-04:00",
          provider_name: ".NET Runtime",
          id: 1023,
          message: "Application: Revit.exe\nDescription: The process was terminated due to an internal error with exit code 80131506.",
          exit_code: "80131506"
        }
      ]
    }
  });

  assert.equal(report.diagnosis, "revit_clr_startup_crash");
  assert.equal(report.revit_year, "2024");
  assert.equal(report.latest_revit_crash?.faulting_module, "clr.dll");
  assert.equal(report.latest_revit_crash?.exception_code, "0xc0000005");
  assert.match(report.message, /Revit crashed in clr\.dll/);
  assert.match(report.next_steps.join("\n"), /known passing Snowdon smoke tasks/);
});

test("Revit startup diagnostics identifies crash evidence when RevitBridge manifest is disabled", () => {
  const addinRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-addins-disabled-"));
  const disabledManifestPath = path.join(addinRoot, "RevitBridge.addin.disabled-redline-crashdiag-20260708");
  const dllPath = path.join(addinRoot, "RevitOperator", "RevitBridge.dll");
  fs.mkdirSync(path.dirname(dllPath), { recursive: true });
  fs.writeFileSync(dllPath, "fake dll bytes", "utf8");
  fs.writeFileSync(disabledManifestPath, [
    "<RevitAddIns>",
    "  <AddIn Type=\"Application\">",
    `    <Assembly>${dllPath}</Assembly>`,
    "  </AddIn>",
    "</RevitAddIns>"
  ].join("\n"), "utf8");

  const report = buildRevitStartupDiagnostics({
    revitYear: "2024",
    checkedAt: "2026-07-08T14:15:00.000Z",
    addinRoots: [addinRoot],
    hostEvidence: {
      platform: "win32",
      checked_at: "2026-07-08T14:15:00.000Z",
      revit_processes: [],
      modal_windows: [],
      recent_crash_events: [
        {
          time_created: "2026-07-08T10:10:53.0000000-04:00",
          provider_name: "Application Error",
          id: 1000,
          message: "Faulting application name: Revit.exe\nFaulting module name: clr.dll\nException code: 0xc0000005",
          faulting_module: "clr.dll",
          exception_code: "0xc0000005"
        }
      ]
    }
  });

  assert.equal(report.diagnosis, "revit_clr_startup_crash");
  assert.equal(report.active_manifest_count, 0);
  assert.equal(report.revit_bridge_manifest_active, false);
  assert.equal(report.inactive_revit_bridge_manifest_count, 1);
  assert.equal(report.crash_without_active_revit_bridge_manifest, true);
  assert.match(report.message, /no active RevitBridge\.addin manifest/);
});

test("Revit startup diagnostics markdown includes hashes, manifests, and next steps", () => {
  const markdown = renderRevitStartupDiagnosticsMarkdown({
    schema_version: 1,
    checked_at: "2026-07-07T20:30:00.000Z",
    platform: "win32",
    revit_year: "2024",
    diagnosis: "revit_clr_startup_crash",
    message: "Recent Windows Application evidence shows Revit crashed in clr.dll before the bridge became ready.",
    addin_roots: ["C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024"],
    addin_root_diagnostics: [
      {
        path: "C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024",
        exists: true,
        directory_write_access: true,
        program_data_root: false,
        active_addin_count: 1,
        active_addin_names: ["RevitBridge.addin"],
        revit_bridge_manifest_exists: true
      },
      {
        path: "C:\\ProgramData\\Autodesk\\Revit\\Addins\\2024",
        exists: true,
        directory_write_access: true,
        program_data_root: true,
        active_addin_count: 1,
        active_addin_names: ["ClashPilot_Dev.2024.addin"],
        revit_bridge_manifest_exists: false,
        isolation_note: "ProgramData add-in isolation may require an elevated shell even when directory write access appears available."
      }
    ],
    manifests: [
      {
        path: "C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024\\RevitBridge.addin",
        active: true,
        exists: true,
        assembly_path: "C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024\\RevitOperator\\RevitBridge.dll",
        assembly_exists: true,
        assembly_sha256: "A278B6ACC10A58BD687291353CEB61E6DC4ABAB4D9A8FD65C27EEC055DD17903"
      }
    ],
    all_active_addin_manifests: [
      {
        path: "C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024\\RevitBridge.addin",
        active: true,
        exists: true,
        assembly_path: "C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024\\RevitOperator\\RevitBridge.dll",
        assembly_exists: true,
        assembly_sha256: "A278B6ACC10A58BD687291353CEB61E6DC4ABAB4D9A8FD65C27EEC055DD17903"
      },
      {
        path: "C:\\ProgramData\\Autodesk\\Revit\\Addins\\2024\\ClashPilot_Dev.2024.addin",
        active: true,
        exists: true,
        assembly_path: "C:\\Program Files\\ClashPilot\\ClashPilot.dll",
        assembly_exists: false
      }
    ],
    active_manifest_count: 1,
    revit_bridge_manifest_active: true,
    inactive_revit_bridge_manifest_count: 0,
    all_active_addin_count: 2,
    deployed_assembly_path: "C:\\Users\\User\\AppData\\Roaming\\Autodesk\\Revit\\Addins\\2024\\RevitOperator\\RevitBridge.dll",
    deployed_assembly_sha256: "A278B6ACC10A58BD687291353CEB61E6DC4ABAB4D9A8FD65C27EEC055DD17903",
    latest_revit_crash: {
      time_created: "2026-07-07T16:21:45.6915275-04:00",
      provider_name: "Application Error",
      id: 1000,
      message: "Faulting application name: Revit.exe",
      faulting_module: "clr.dll",
      exception_code: "0xc0000005"
    },
    latest_revit_journals: [
      {
        path: "C:\\Users\\User\\AppData\\Local\\Autodesk\\Revit\\Autodesk Revit 2024\\Journals\\journal.0915.txt",
        last_write_time: "2026-07-07T20:35:18.000Z",
        size_bytes: 187179,
        interesting_lines: [
          "' 0:< API_ERROR { : Assembly version conflict in some references in ClashPilot_Dev2024.dll assembly",
          "' 0:< API_SUCCESS { Starting External Application: ClashPilot_Dev, Class: ClashPilot.App }",
          "  Jrn.Command \"Internal\"  , \"Open an existing project , ID_REVIT_FILE_OPEN\""
        ]
      }
    ],
    next_steps: ["Inspect the latest Windows Application and .NET Runtime events."]
  });

  assert.match(markdown, /# Revit Startup Diagnostics/);
  assert.match(markdown, /Diagnosis: revit_clr_startup_crash/);
  assert.match(markdown, /RevitBridge manifest active: yes/);
  assert.match(markdown, /Crash without active RevitBridge manifest: no/);
  assert.match(markdown, /A278B6ACC10A58BD687291353CEB61E6DC4ABAB4D9A8FD65C27EEC055DD17903/);
  assert.match(markdown, /## Manifests/);
  assert.match(markdown, /## Add-in Roots/);
  assert.match(markdown, /ProgramData\\Autodesk\\Revit\\Addins\\2024/);
  assert.match(markdown, /may require an elevated shell/);
  assert.match(markdown, /## Latest Revit Journals/);
  assert.match(markdown, /Assembly version conflict/);
  assert.match(markdown, /## All Active Add-ins/);
  assert.match(markdown, /ClashPilot_Dev\.2024\.addin/);
  assert.match(markdown, /Inspect the latest Windows Application/);
});

test("Revit startup diagnostics captures bounded latest journal evidence", () => {
  const journalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revit-journals-"));
  const olderPath = path.join(journalRoot, "journal.0001.txt");
  const latestPath = path.join(journalRoot, "journal.0002.txt");
  fs.writeFileSync(olderPath, "older journal\n", "utf8");
  fs.writeFileSync(latestPath, [
    "plain startup line",
    "' 0:< API_ERROR { : Assembly version conflict in some references in ClashPilot_Dev2024.dll assembly",
    "' 0:< API_SUCCESS { Starting External Application: RevitBridge, Class: RevitBridge.App }",
    "  Jrn.Command \"Internal\"  , \"Open an existing project , ID_REVIT_FILE_OPEN\""
  ].join("\n"), "utf8");
  fs.utimesSync(olderPath, new Date("2026-07-07T20:00:00.000Z"), new Date("2026-07-07T20:00:00.000Z"));
  fs.utimesSync(latestPath, new Date("2026-07-07T20:10:00.000Z"), new Date("2026-07-07T20:10:00.000Z"));

  const report = buildRevitStartupDiagnostics({
    revitYear: "2024",
    checkedAt: "2026-07-07T20:30:00.000Z",
    journalRoot,
    hostEvidence: {
      platform: "win32",
      checked_at: "2026-07-07T20:30:00.000Z",
      revit_processes: [],
      modal_windows: [],
      recent_crash_events: []
    }
  });

  assert.equal(report.latest_revit_journals?.[0]?.path, latestPath);
  assert.deepEqual(report.latest_revit_journals?.[0]?.interesting_lines, [
    "' 0:< API_ERROR { : Assembly version conflict in some references in ClashPilot_Dev2024.dll assembly",
    "' 0:< API_SUCCESS { Starting External Application: RevitBridge, Class: RevitBridge.App }",
    "  Jrn.Command \"Internal\"  , \"Open an existing project , ID_REVIT_FILE_OPEN\""
  ]);
});
