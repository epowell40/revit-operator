using System;
using System.Collections.Generic;

namespace RevitBridge.Operator
{
    internal static class OperatorActionAllowlist
    {
        internal readonly struct AllowlistEntry
        {
            public AllowlistEntry(string method, string path)
            {
                Method = method;
                Path = path;
            }

            public string Method { get; }
            public string Path { get; }
        }

        private static readonly Dictionary<string, HashSet<string>> Allowed = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase)
        {
            { "GET", new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "/revit/ping", "/revit/context", "/revit/views", "/revit/capabilities", "/revit/native-capabilities", "/revit/tool-registry", "/revit/write-grant-status", "/revit/native-api-policy" } },
            { "POST", new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    "/ui/open",
                    "/ui/close",
                    "/revit/batch-job",
                    "/revit/batch-control",

                    // Introspection / diagnostics
                    "/revit/tool-search",
                    "/revit/tool-doc",
                    "/revit/tool-examples",
                    "/revit/native-api-policy",
                    "/revit/native-api-catalog",
                    "/revit/native-api-search",
                    "/revit/native-api-call",
                    "/revit/native-api-ops",
                    "/revit/self-test",
                    "/revit/state-snapshot",
                    "/revit/views",
                    "/revit/regenerate",
                    "/revit/computer-use-observe",
                    "/revit/computer-use-act",
                    "/revit/computer-use-guard",
                    "/revit/open-model",
                    "/revit/save-as",
                    "/revit/sync",
                    "/revit/worksets",
                    "/revit/project-parameters",
                    "/revit/purge-unused",
                    "/revit/transfer-view-templates",

                    "/revit/rooms",
                    "/revit/linked-room-boundaries",
                    "/revit/renumber-rooms",
                    "/revit/room-contents",
                    "/revit/spatial-context",
                    "/revit/find-elements",
                    "/revit/update-parameter-by-query",
                    "/revit/update-panel-parameter",
                    "/revit/locate-elements",
                    "/revit/get-placement-context",
                    "/revit/resolve-room-wall",
                    "/revit/rank-similar-devices-on-wall",
                    "/revit/pick-candidate-cluster",
    "/revit/project-point-to-host-frame",
    "/revit/audit-hosted-instance-placement",
    "/revit/resolve-redline-target",
    "/revit/propose-fix",
                    "/revit/find-duplicate-marks",
                    "/revit/airflow-qa",
                    "/revit/mep-workflows",
                    "/revit/resolve-mep-routing-context",
                    "/revit/create-mep-route",
                    "/revit/connect-mep-branch",
                    "/revit/connect-existing-mep-branch",
                    "/revit/connect-mep-elements",
                    "/revit/create-pipe-between-connectors",
                    "/revit/existing-conditions-mep-draft-workflow",
                    "/revit/copy-mep-pattern",
                    "/revit/mep-route-workflow",
                    "/revit/mep-branch-network-workflow",
                    "/revit/edit-mep-route-elements",
                    "/revit/reroute-mep-route-segment",
                    "/revit/arch-workflows",
                    "/revit/trace-connected-network",
                    "/revit/room_mep_intersect",
                    "/revit/ducts-by-spatial-scope",
                    "/revit/find-elements-by-parameter",
                    "/revit/align-room-tops-to-ceilings",
                    "/revit/get-connectors",
                    "/revit/export-image",
                    "/revit/capture-screenshare",
                    "/revit/export-pdf",
                    "/revit/print",
                    "/revit/export-images",
                    "/revit/export-dwg",
                    "/revit/export-ifc",
                    "/revit/export-view-frame",
                    "/revit/export-view-region",
                    "/revit/export-visible-elements",
                    "/revit/pick-at-pixel",
                    "/revit/highlight-and-export",
                    "/revit/activate-view",
                    "/revit/query",
                    "/revit/resolve",
                    "/revit/get-element-summary",
                    "/revit/get-parameters",
                    "/revit/quantify",
                    "/revit/quantify-visualize",
                    "/revit/sheets",
                    "/revit/schedules",
                    "/revit/configure-schedule",
                    "/revit/export-schedule-csv",
                    "/revit/export-warnings-report",
                    "/revit/warnings",
                    "/revit/model-health",
                    "/revit/qa-checks",
                    "/revit/print-sets",
                    "/revit/create-print-set",
                    "/revit/revisions",
                    "/revit/create-revision",
                    "/revit/apply-revision-to-sheets",
                    "/revit/get-titleblock-info",
                    "/revit/titleblock-label-map",
                    "/revit/capture-sheet-region",
                    "/revit/verify-parameter-on-sheet",
                    "/revit/titleblock-family-update-text",
                    "/revit/titleblock-date-candidates",
                    "/revit/titleblock-set-date-smart",
                    "/revit/get-family-file-path",
                    "/revit/open-family-doc",
                    "/revit/find-text-notes",
                    "/revit/replace-text-note",
                    "/revit/save-family-doc",
                    "/revit/load-family-doc",
                    "/revit/close-doc",
                    "/revit/edit-family-from-instance",
                    "/revit/find-family-text-notes",
                    "/revit/set-text-note-text",
                    "/revit/reload-family-edit-session",
                    "/revit/plan-family-evolution",
                    "/revit/apply-family-evolution",
                    "/revit/read-family-evolution",
                    "/revit/measure-gap",
                    "/revit/transaction-plan",
                    "/revit/transaction-validate",
                    "/revit/transaction-apply",

                    // Drafting / documentation
                    "/revit/visibility",
                    "/revit/datums",
                    "/revit/create-text",
                    "/revit/import-drawing-spec",
                    "/revit/import-excel-table",
                    "/revit/export-elements-xlsx",
                    "/revit/import-elements-xlsx-updates",
                    "/revit/create-drafting-view",
                    "/revit/create-view",
                    "/revit/draw-detail-curves",
                    "/revit/annotation-symbol-leaders",
                    "/revit/create-filled-region",
                    "/revit/create-revision-cloud",
                    "/revit/keynotes",
                    "/revit/tag-elements",
                    "/revit/create-dimension",
                    "/revit/create-sheet",
                    "/revit/create-sheets",
                    "/revit/place-view",
                    "/revit/place-views",
                    "/revit/align-viewports",
                    "/revit/renumber-sheets",
                    "/revit/sync-sheet-names",
                    "/revit/link-cad",
                    "/revit/link-revit",
                    "/revit/place-image",
                    "/revit/place-pdf-underlay",
                    "/revit/import-zippybim-geometry",
                    "/revit/create-schedule",

                    // Model manipulation (high risk; approval-gated)
                    "/revit/delete",
                    "/revit/set-parameter",
                    "/revit/update-schedule-cell",
                    "/revit/replace-schedule-values",
                    "/revit/sync-connected-sizes",
                    "/revit/resize-duct-run",
                    "/revit/resize-ducts-by-scope",
                    "/revit/resize-ducts-in-room",
                    "/revit/resize-ductwork-by-scope",
                    "/revit/repair-duct-continuity-by-scope",
                    "/revit/repair-mep-connectors",
                    "/revit/create-duct",
                    "/revit/create-pipe",
                    "/revit/create-family-instance",
                    "/revit/place-families",
                    "/revit/place-family-instance-on-host",
                    "/revit/create-similar-from-instance",
                    "/revit/adjust-hosted-instance-on-host",
                    "/revit/assign-electrical-circuit",
                    "/revit/assign-electrical-distribution-system",
                    "/revit/load-family",
                    "/revit/create-family-from-template",
                    "/revit/duplicate-view",
                    "/revit/change-element-type",
                    "/revit/replace-door",
                    "/revit/move-elements",
                    "/revit/rotate-elements",
                    "/revit/align-elements",
                    "/revit/room-align-wall-to-nearest-column",

                    // Analytics / workflows
                    "/revit/get-lighting-data",
                    "/revit/analyze-dimensions",
                    "/revit/export-dimensioning-v2",
                    "/revit/spatial-analysis",
                    "/revit/fire-damper-audit",
                    "/revit/lighting-audit",

                    // Fire alarm
                    "/revit/fire-alarm-layout",
                    "/revit/low-voltage-layout",
                    "/revit/fire-alarm-visualizer",

                    // Zones/spaces
                    "/revit/ensure-spaces",
                    "/revit/create-zones",
                    "/revit/create-zone-visuals",
                    "/revit/query-zone-data",

                    // Selection utils
                    "/revit/set-selection",
                    "/revit/resolve-room-plan-view",
                    "/revit/plan-dwelling-receptacles",
                    "/revit/audit-electrical-circuit-loading",
                    "/revit/audit-plumbing-fixture-services",
                    "/revit/plan-room-receptacles-from-analog",
                    "/revit/apply-room-receptacles-from-analog",

                    // Type utilities
                    "/revit/list-element-types",
                    "/revit/resolve-element-type",
                    "/revit/duplicate-element-type",
                    "/revit/set-type-parameters",
                    "/revit/duplicate-type-and-swap-instance"
                } }
        };

        public static bool IsAllowed(string method, string path) =>
            Allowed.TryGetValue(method ?? "", out var paths) && paths.Contains(path ?? "");

        public static IEnumerable<AllowlistEntry> EnumerateAllowed()
        {
            foreach (var kv in Allowed)
            {
                var method = kv.Key;
                foreach (var p in kv.Value) yield return new AllowlistEntry(method, p);
            }
        }
    }
}
